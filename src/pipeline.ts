import { randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { config } from './config.ts';
import { storage } from './storage.ts';
import { sha256, slugify } from './lib.ts';
import { saveAsset, assembleEpisode, probeAudio } from './media.ts';
import { transcribeAudio, transcribeWords, prepareEnglishScript, translateSubtitleCues, synthesizeSpeech, coverBriefing, generateCoverBackground, episodeVoice, type ScriptSegment } from './ai/openai.ts';
import { planShots, renderBases, subtitleFrame, encodeVideo, encodeComposite, splitParts, shotsWithin, sliceAudio, stillClip, type Part } from './video.ts';
import { lipsync, lipsyncMock, estimateLipsyncUsd } from './lipsync.ts';
import { PROVIDERS, runProvider, signedAssetUrl } from './talking.ts';
import { readQuestion, generateFictionalPortrait } from './ai/openai.ts';
import { cuesFromWords, fixOverlaps, checkCues, type Cue } from './subtitles.ts';
import { composeCover } from './cover.ts';
import { PermanentError, type Handler } from './jobs.ts';
import { renderVeoVideo } from './veo-episode.ts';

const usage = (db: Db, interviewId: string, kind: string, quantity: number, cost: number) =>
  db.query('INSERT INTO usage_ledger(interview_id, kind, quantity, cost_usd, estimated) VALUES ($1,$2,$3,$4,true)', [interviewId, kind, quantity, cost]);

export const latestTranscript = (db: Db, kind: string, sourceId: string) =>
  db.one('SELECT * FROM transcripts WHERE source_kind=$1 AND source_id=$2 ORDER BY revision DESC LIMIT 1', [kind, sourceId]);

async function transcribeAsset(db: Db, interview: any, assetId: string, sourceKind: string, sourceId: string) {
  if (await latestTranscript(db, sourceKind, sourceId)) return;
  const a = await db.one('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL', [assetId]);
  if (!a) throw new PermanentError('Ativo em falta');
  const ext = a.storage_key.split('.').pop()!;
  const r = await transcribeAudio(await storage.get(a.storage_key), ext, interview.answer_lang);
  await db.query(`INSERT INTO transcripts(interview_id, source_kind, source_id, revision, text, language) VALUES ($1,$2,$3,1,$4,$5) ON CONFLICT DO NOTHING`, [interview.id, sourceKind, sourceId, r.text, r.language]);
  const mins = (a.duration_ms ?? 0) / 60000;
  await usage(db, interview.id, 'transcription_min', mins, mins * config.prices.transcribePerMin);
}

export async function prepareScript(db: Db, interviewId: string) {
  const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [interviewId]);
  const qs = await db.query(`SELECT q.*, a.status, a.selected_take_id FROM questions q LEFT JOIN answers a ON a.question_id=q.id WHERE q.interview_id=$1 ORDER BY q.position`, [interviewId]);
  const items: any[] = [];
  for (const q of qs) {
    const qt = q.text || (await latestTranscript(db, 'question', q.id))?.text || '';
    const at = q.status === 'answered' && q.selected_take_id ? (await latestTranscript(db, 'answer_take', q.selected_take_id))?.text ?? '' : '';
    items.push({ questionId: q.id, question: qt, status: q.status === 'answered' ? 'answered' : 'refused', answer: at });
  }
  const r = await prepareEnglishScript({ title: iv.title, objective: iv.objective_text, items });
  // Garante a apresentação (onde o vídeo mostra os dois) e o agradecimento final do entrevistador — textos editoriais do anfitrião.
  if (!r.segments.some(x => x.transformationType === 'editorial_intro')) {
    r.segments.unshift({ id: 'intro', speakerRole: 'host', textEnglish: `Welcome. Today${iv.guest_name ? ` ${iv.guest_name} joins us` : ' we have a guest with us'} to talk about ${r.titleEnglish}.`, sourceQuestionId: null, transformationType: 'editorial_intro' });
  }
  if (!r.segments.some(x => x.transformationType === 'editorial_outro')) {
    const who = iv.guest_name ? `, ${iv.guest_name},` : '';
    r.segments.push({ id: 'outro', speakerRole: 'host', textEnglish: `Thank you${who} for sharing your time and experience with us. And thank you all for listening.`, sourceQuestionId: null, transformationType: 'editorial_outro' });
  }
  const rev = Number((await db.one('SELECT COALESCE(max(revision),0)+1 AS n FROM scripts WHERE interview_id=$1', [interviewId])).n);
  await db.query(`UPDATE scripts SET status='superseded' WHERE interview_id=$1 AND status IN ('draft','approved','stale')`, [interviewId]);
  const chars = JSON.stringify(items).length;
  await usage(db, interviewId, 'text_tokens', chars / 3, (chars / 3 / 1000) * config.prices.textPer1kTokens);
  const row = await db.one(
    `INSERT INTO scripts(interview_id, revision, title_en, segments, review_flags, blocking_issues, status, prompt_version, model) VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8) RETURNING id`,
    [interviewId, rev, r.titleEnglish, JSON.stringify(r.segments), JSON.stringify(r.reviewFlags), JSON.stringify(r.blockingIssues), r.promptVersion, r.model]);
  await db.query(`UPDATE interviews SET production_status='editorial_review' WHERE id=$1`, [interviewId]);
  return row.id as string;
}

export const handlers: Record<string, Handler> = {
  async transcribe_asset(job, { db }) {
    const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [job.interview_id]);
    const { assetId, sourceKind, sourceId, fillQuestion } = job.input;
    await transcribeAsset(db, iv, assetId, sourceKind, sourceId);
    if (fillQuestion) {
      const t = await latestTranscript(db, sourceKind, sourceId);
      await db.query(`UPDATE questions SET text=$2 WHERE id=$1 AND text=''`, [sourceId, t?.text ?? '']);
    }
  },

  async process_submission(job, { db, progress }) {
    const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [job.interview_id]);
    if (!iv) throw new PermanentError('Entrevista inexistente');
    const processingOk = (await db.one(`SELECT granted FROM consents WHERE interview_id=$1 AND purpose='processing' ORDER BY created_at DESC LIMIT 1`, [iv.id]))?.granted;
    if (!processingOk) throw new PermanentError('Sem autorização de processamento por IA');
    await db.query(`UPDATE interviews SET production_status='transcribing' WHERE id=$1`, [iv.id]);
    const qs = await db.query(`SELECT q.*, a.status, t.asset_id, a.selected_take_id FROM questions q LEFT JOIN answers a ON a.question_id=q.id LEFT JOIN answer_takes t ON t.id=a.selected_take_id WHERE q.interview_id=$1 ORDER BY q.position`, [iv.id]);
    // Pesos: transcrever uma resposta ~3, uma pergunta gravada ~1, preparar o guião ~6.
    const W = { q: 1, a: 3, script: 6 };
    let done = 0; const total = qs.length * (W.q + W.a) + W.script;
    await progress(0, total, 'A preparar');
    for (const q of qs) {
      if (q.audio_asset_id && !q.text) { await progress(done, total, `A transcrever a pergunta ${q.position} de ${qs.length}`); await transcribeAsset(db, iv, q.audio_asset_id, 'question', q.id); }
      done += W.q;
      if (q.status === 'answered' && q.asset_id) { await progress(done, total, `A transcrever a resposta ${q.position} de ${qs.length}`); await transcribeAsset(db, iv, q.asset_id, 'answer_take', q.selected_take_id); }
      done += W.a;
      await progress(done, total);
    }
    await progress(done, total, 'A preparar o guião em inglês');
    await prepareScript(db, iv.id);
    await progress(total, total, 'Concluído');
    return { ok: true };
  },

  async prepare_script(job, { db }) {
    await prepareScript(db, job.interview_id);
  },

  async generate_episode(job, { db, progress }) {
    const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [job.interview_id]);
    const script = await db.one('SELECT * FROM scripts WHERE id=$1 AND interview_id=$2', [job.input.scriptId, iv.id]);
    if (!script) throw new PermanentError('Guião inexistente');
    // Um trabalho antigo nunca publica por cima de uma versão nova.
    if (script.status !== 'approved') throw new PermanentError('O guião já não está aprovado (foi alterado ou substituído)');
    const consent = async (p: string) => !!(await db.one(`SELECT granted FROM consents WHERE interview_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`, [iv.id, p]))?.granted;
    if (!(await consent('processing'))) throw new PermanentError('Autorização de processamento retirada');
    await db.query(`UPDATE interviews SET production_status='generating' WHERE id=$1`, [iv.id]);

    const segments: ScriptSegment[] = script.segments;
    const opts = job.input as { subtitleLangs?: string[]; coverPhotoIds?: string[] };
    const subLangs: string[] = opts.subtitleLangs?.length ? opts.subtitleLangs : iv.subtitle_langs;

    // 1. Áudio por segmento (com cache por texto+papel+voz+modelo), incluindo o aviso inicial.
    const all: { id: string; role: 'host' | 'guest'; text: string; editorial: boolean }[] = [
      { id: 'disclosure', role: 'host', text: config.aiDisclosure, editorial: true },
      ...segments.map(s => ({ id: s.id, role: s.speakerRole, text: s.textEnglish, editorial: s.transformationType.startsWith('editorial_') })),
    ];
    // Pesos por etapa (aproximam o tempo real: voz ~2, montagem ~4, tempos das legendas ~1, tradução ~4, capa ~12, verificação ~1).
    const W = { tts: 2, asm: 4, words: 1, tr: 4, cover: 12, qc: 1 };
    const nTr = subLangs.filter(l => l !== 'en').length;
    const total = all.length * (W.tts + W.words) + W.asm + nTr * W.tr + W.cover + W.qc;
    let step = 0;
    await progress(0, total, 'A preparar');
    const voiceOf = { host: episodeVoice('host', iv.question_voice), guest: episodeVoice('guest', iv.guest_voice) };
    const kinds = new Map<string, string>([['disclosure', 'disclosure'], ...segments.map(x => [x.id, x.transformationType] as [string, string])]);
    const parts: { data: Buffer; ext: string; pauseAfterMs: number }[] = [];
    const timing: { id: string; role: 'host' | 'guest'; text: string; startMs: number; durationMs: number; data: Buffer; ext: string }[] = [];
    let cursor = 0, ttsChars = 0;
    for (let i = 0; i < all.length; i++) {
      const s = all[i];
      await progress(step, total, `A gerar a voz: segmento ${i + 1} de ${all.length}`);
      const key = sha256(`${s.role}|${s.text}|${voiceOf[s.role]}|${config.openai.models.speech}|${config.openai.mock}`);
      let asset = await db.one(`SELECT * FROM assets WHERE interview_id=$1 AND kind='tts_segment' AND meta->>'ttsKey'=$2 AND deleted_at IS NULL LIMIT 1`, [iv.id, key]);
      let data: Buffer, ext: string, dur: number;
      if (asset) { data = await storage.get(asset.storage_key); ext = asset.storage_key.split('.').pop()!; dur = asset.duration_ms; }
      else {
        const sp = await synthesizeSpeech(s.text, s.role, voiceOf[s.role]);
        const pr = await probeAudio(sp.data, sp.ext);
        if (!pr.ok) throw new Error(`Áudio sintético inválido no segmento ${s.id}`);
        data = sp.data; ext = sp.ext; dur = pr.durationMs;
        await saveAsset(db, { interviewId: iv.id, kind: 'tts_segment', mime: sp.mime, ext: sp.ext, data, durationMs: dur, meta: { ttsKey: key, segmentId: s.id } });
        ttsChars += s.text.length;
      }
      const pause = i === 0 ? 800 : (s.role !== (all[i + 1]?.role ?? s.role) ? 450 : 250);
      parts.push({ data, ext, pauseAfterMs: pause });
      timing.push({ id: s.id, role: s.role, text: s.text, startMs: cursor, durationMs: dur, data, ext });
      cursor += dur + pause;
      step += W.tts;
    }
    if (ttsChars) await usage(db, iv.id, 'tts_chars', ttsChars, (ttsChars / 1000) * config.prices.ttsPer1kChars);

    // 2. Montagem (derivados; as gravações originais não são tocadas).
    await progress(step, total, 'A montar e normalizar o áudio do episódio');
    const asm = await assembleEpisode(parts);
    step += W.asm;
    const audioId = await saveAsset(db, { interviewId: iv.id, kind: 'episode_audio', mime: 'audio/mpeg', ext: 'mp3', data: asm.mp3, durationMs: asm.durationMs, meta: { maxVolumeDb: asm.maxVolumeDb, clipping: asm.clipping } });

    // 3. Legendas: tempos MEDIDOS no áudio sintético final de cada segmento (não por divisão de duração por palavras).
    let en: Cue[] = [];
    for (let i = 0; i < timing.length; i++) {
      const seg = timing[i];
      await progress(step, total, `A sincronizar as legendas: segmento ${i + 1} de ${timing.length}`);
      const words = await transcribeWords(seg.data, seg.ext).catch(() => []);
      step += W.words;
      en.push(...cuesFromWords(words, seg, 'en'));
    }
    en = fixOverlaps(en).map((c, i) => ({ ...c, id: `c${i}` }));
    const subtitles: Record<string, Cue[]> = { en };
    for (const lang of subLangs.filter(l => l !== 'en')) {
      await progress(step, total, `A traduzir as legendas (${lang})`);
      const tr = await translateSubtitleCues(en.map(c => ({ id: c.id, text: c.text })), lang);
      const map = new Map(tr.map(x => [x.sourceCueId, x.translatedText]));
      subtitles[lang] = en.map(c => ({ ...c, language: lang, text: map.get(c.id) || c.text })); // ligação 1:1 aos cues de origem
      step += W.tr;
    }
    if (!subLangs.includes('en')) delete subtitles.en;
    const cueIssues = Object.entries(subtitles).flatMap(([l, c]) => checkCues(c, asm.durationMs).map(m => `${l}: ${m}`));

    // 4. Capa: fundo por IA (ou determinístico) + texto e retratos compostos por nós.
    await progress(step, total, 'A criar a capa');
    const brief = await coverBriefing(script.title_en, iv.objective_text).catch(() => null);
    const bg = brief ? await generateCoverBackground(brief).catch(() => null) : null;
    if (bg) await usage(db, iv.id, 'image', 1, config.prices.imageEach);
    const coverOk = await consent('cover_use');
    const photoRows = coverOk && opts.coverPhotoIds?.length
      ? await db.query(`SELECT a.* FROM photos p JOIN assets a ON a.id=p.asset_id WHERE p.interview_id=$1 AND p.id = ANY($2::uuid[]) LIMIT 2`, [iv.id, opts.coverPhotoIds]) : [];
    const photoBufs = await Promise.all(photoRows.map((a: any) => storage.get(a.storage_key)));
    const { cover, thumb } = await composeCover({ title: script.title_en, subtitle: iv.guest_name ? `with ${iv.guest_name}` : '', brand: config.brand, background: bg, photos: photoBufs, palette: brief?.palette });
    const coverId = await saveAsset(db, { interviewId: iv.id, kind: 'episode_cover', mime: 'image/jpeg', ext: 'jpg', data: cover });
    const thumbId = await saveAsset(db, { interviewId: iv.id, kind: 'episode_cover', mime: 'image/jpeg', ext: 'jpg', data: thumb, meta: { thumb: true } });
    step += W.cover;
    await progress(step, total, 'Controlo de qualidade');

    // 5. Capítulos e controlo de qualidade.
    const chapters: { startMs: number; title: string }[] = [];
    const seen = new Set<string>();
    for (const s of segments) {
      if (s.sourceQuestionId && s.transformationType === 'translated_question' && !seen.has(s.sourceQuestionId)) {
        seen.add(s.sourceQuestionId);
        chapters.push({ startMs: timing.find(t => t.id === s.id)!.startMs, title: s.textEnglish.slice(0, 90) });
      }
    }
    const issues = [...cueIssues];
    if (asm.clipping) issues.push('Áudio com clipping');
    if (asm.durationMs < 1000) issues.push('Duração demasiado curta');

    const prev = await db.query(`UPDATE episodes SET status='superseded', stale=true WHERE interview_id=$1 AND status IN ('preview','ready') RETURNING id`, [iv.id]);
    const ep = await db.one(
      `INSERT INTO episodes(interview_id, script_id, slug, title, description, audio_asset_id, cover_asset_id, cover_thumb_asset_id, duration_ms, subtitles, chapters, technical, status, visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'preview','private') RETURNING id`,
      [iv.id, script.id, `${slugify(script.title_en)}-${randomBytes(3).toString('hex')}`, script.title_en, iv.objective_shared ? iv.objective_text.slice(0, 500) : '', audioId, coverId, thumbId, asm.durationMs,
        JSON.stringify(subtitles), JSON.stringify(chapters), JSON.stringify({ maxVolumeDb: asm.maxVolumeDb, clipping: asm.clipping, qcIssues: issues, supersedes: prev.map((p: any) => p.id), mock: config.openai.mock, voices: voiceOf, models: config.openai.models, coverPhotoIds: opts.coverPhotoIds ?? [], timing: timing.map(t => ({ id: t.id, role: t.role, kind: kinds.get(t.id) ?? '', startMs: t.startMs, durationMs: t.durationMs })) })]);
    await db.query(`UPDATE interviews SET production_status=$2, publication_status='awaiting_approval' WHERE id=$1`, [iv.id, issues.length ? 'qc' : 'ready']);
    await progress(total, total, 'Concluído');
    return { episodeId: ep.id, qcIssues: issues };
  },

  async render_video(job, { db, progress }) {
    if (job.input.engine === 'veo') return renderVeoVideo(job, { db, progress });
    const ep = await db.one('SELECT * FROM episodes WHERE id=$1 AND interview_id=$2', [job.input.episodeId, job.interview_id]);
    if (!ep || ep.stale || ep.status === 'superseded') throw new PermanentError('Episódio inexistente ou desatualizado');
    const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [ep.interview_id]);
    const timing = ep.technical?.timing as any[] | undefined;
    if (!timing?.length) throw new PermanentError('Este episódio foi gerado antes do vídeo existir: gere o episódio de novo');
    const consent = async (p: string) => !!(await db.one(`SELECT granted FROM consents WHERE interview_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`, [iv.id, p]))?.granted;
    await progress(0, 100, 'A preparar as imagens');
    const asset = async (id: string | null) => { if (!id) return null; const a = await db.one('SELECT storage_key FROM assets WHERE id=$1 AND deleted_at IS NULL', [id]); return a ? storage.get(a.storage_key) : null; };
    // Só fotografias autorizadas: a do entrevistador com direitos declarados; a do convidado com autorização de publicação.
    const hostPhoto = iv.host_photo_rights ? await asset(iv.host_photo_asset_id) : null;
    let guestPhoto: Buffer | null = null;
    if (await consent('publish_photo')) {
      const pid = job.input.photoId ?? ep.technical?.coverPhotoIds?.[0] ?? null;
      const ph = pid ? await db.one('SELECT asset_id FROM photos WHERE id=$1 AND interview_id=$2', [pid, iv.id]) : await db.one('SELECT asset_id FROM photos WHERE interview_id=$1 ORDER BY created_at LIMIT 1', [iv.id]);
      guestPhoto = ph ? await asset(ph.asset_id) : null;
    }
    const cover = await asset(ep.cover_asset_id);
    const audio = await asset(ep.audio_asset_id);
    if (!cover || !audio) throw new PermanentError('Capa ou áudio do episódio em falta');
    const lang: string | null = job.input.lang && ep.subtitles?.[job.input.lang] ? job.input.lang : null;
    const shots = planShots(timing, ep.duration_ms, lang ? ep.subtitles[lang] : null);
    const bases = await renderBases({ cover, title: ep.title, brand: config.brand, host: { name: iv.host_name || 'Host', photo: hostPhoto }, guest: { name: iv.guest_name || 'Guest', photo: guestPhoto } });
    const { default: ff } = await import('@ffmpeg-installer/ffmpeg');
    const ffmpeg = process.env.FFMPEG_PATH || ff.path;
    const frameFor = (sh: any) => subtitleFrame((bases as any)[sh.scene], sh.text);

    // Animação por fala: só com autorização específica de cada pessoa e fotografia autorizada.
    const animHost = !!job.input.animate && iv.host_animate && !!hostPhoto;
    const animGuest = !!job.input.animate && !!guestPhoto && (await consent('animate_portrait'));
    const segs = timing.map((t: any, i: number) => ({ ...t, endMs: i + 1 < timing.length ? timing[i + 1].startMs : ep.duration_ms }))
      .filter((t: any) => !['disclosure', 'editorial_intro', 'editorial_outro'].includes(t.kind) && ((t.role === 'host' && animHost) || (t.role === 'guest' && animGuest)) && t.durationMs >= 800);
    let mp4: Buffer, animated = 0, failed = 0, gpuUsd = 0;
    if (segs.length) {
      const clips: (Buffer | null)[] = new Array(segs.length).fill(null);
      let doneN = 0, next = 0;
      await progress(5, 100, `A animar os retratos (0 de ${segs.length} falas)`);
      // Até 3 animações em paralelo; uma falha cai para a imagem fixa (o vídeo nunca fica incompleto).
      const worker = async () => {
        while (next < segs.length) {
          const k = next++, sg = segs[k];
          try {
            const photo = sg.role === 'host' ? hostPhoto! : guestPhoto!;
            // Clipes já animados (mesma fotografia, mesma fala) são reaproveitados: uma nova tentativa não volta a pagar.
            const clipKey = sha256(`${sha256(photo)}|${ep.audio_asset_id}|${sg.startMs}|${sg.durationMs}|${lipsyncMock() ? 'mock' : 'replicate'}`);
            const cached = await db.one(`SELECT storage_key FROM assets WHERE interview_id=$1 AND kind='anim_clip' AND meta->>'clipKey'=$2 AND deleted_at IS NULL LIMIT 1`, [iv.id, clipKey]);
            if (cached) clips[k] = await storage.get(cached.storage_key);
            else {
              if (lipsyncMock()) clips[k] = await stillClip(ffmpeg, photo, sg.durationMs);
              else {
                const speech = await sliceAudio(ffmpeg, audio, sg.startMs, sg.startMs + sg.durationMs);
                const r = await lipsync({ data: photo, mime: 'image/jpeg' }, { data: speech, mime: 'audio/mpeg' });
                clips[k] = r.video; gpuUsd += r.estCostUsd ?? 0;
              }
              await saveAsset(db, { interviewId: iv.id, kind: 'anim_clip', mime: 'video/mp4', ext: 'mp4', data: clips[k]!, durationMs: sg.durationMs, meta: { clipKey, segmentId: sg.id, role: sg.role } });
            }
          } catch (e: any) { failed++; console.error(`[video] animação da fala ${sg.id} falhou: ${String(e?.message ?? e).slice(0, 200)}`); }
          doneN++;
          await progress(5 + Math.round((doneN / segs.length) * 65), 100, `A animar os retratos (${doneN} de ${segs.length} falas)`);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      const ok = segs.map((sg: any, k: number) => ({ sg, clip: clips[k] })).filter((x: any) => x.clip);
      animated = ok.length;
      const layout = splitParts(ok.map((x: any) => ({ startMs: x.sg.startMs, endMs: x.sg.endMs })), ep.duration_ms);
      const cues = lang ? ep.subtitles[lang] as any[] : [];
      const parts: Part[] = layout.map(l => {
        if (l.kind === 'still') return { kind: 'still', startMs: l.startMs, endMs: l.endMs, shots: shotsWithin(shots, l.startMs, l.endMs) };
        const x = ok[l.animIndex!];
        return { kind: 'anim', startMs: l.startMs, endMs: l.endMs, base: x.sg.role === 'host' ? bases.animHost : bases.animGuest, clip: x.clip, who: x.sg.role === 'host' ? { name: iv.host_name || 'Host', role: 'Host' } : { name: iv.guest_name || 'Guest', role: 'Guest' },
          cues: cues.filter(c => c.endMs > l.startMs && c.startMs < l.endMs).map(c => ({ startMs: c.startMs - l.startMs, endMs: Math.min(c.endMs, l.endMs) - l.startMs, text: c.text })) };
      });
      await progress(72, 100, 'A montar o vídeo');
      mp4 = await encodeComposite(ffmpeg, parts, frameFor, audio, async (i, n) => progress(72 + Math.round((i / n) * 18), 100, `A montar o vídeo (${i} de ${n} partes)`));
      if (gpuUsd) await usage(db, iv.id, 'lipsync_usd', gpuUsd, gpuUsd);
    } else {
      await progress(10, 100, 'A desenhar os fotogramas com legendas');
      mp4 = await encodeVideo(ffmpeg, shots, frameFor, audio,
        async (i, n) => progress(10 + Math.round((i / n) * 60), 100, `A desenhar os fotogramas (${i} de ${n})`));
    }
    await progress(92, 100, 'A guardar o vídeo');
    const id = await saveAsset(db, { interviewId: iv.id, kind: 'episode_video', mime: 'video/mp4', ext: 'mp4', data: mp4, durationMs: ep.duration_ms,
      meta: { lang, shots: shots.length, guestPhoto: !!guestPhoto, hostPhoto: !!hostPhoto, animatedSegments: animated, failedAnimations: failed, guestAnimated: animGuest && animated > 0, hostAnimated: animHost && animated > 0, lipsyncUsd: gpuUsd } });
    await db.query('UPDATE episodes SET video_asset_id=$2, video_lang=$3 WHERE id=$1', [ep.id, id, lang]);
    await progress(100, 100, 'Concluído');
    return { videoAssetId: id, shots: shots.length, animated, failed, lipsyncUsd: gpuUsd };
  },

  async talking_compare(job, { db, progress }) {
    // Retrato e voz uma única vez (reaproveitados numa nova tentativa), depois cada modelo à vez.
    const prevP = await db.one(`SELECT id, storage_key FROM assets WHERE kind='lab_portrait' AND meta->>'jobId'=$1 LIMIT 1`, [job.id]);
    let portrait: Buffer, portraitId: string;
    if (prevP) { portrait = await storage.get(prevP.storage_key); portraitId = prevP.id; }
    else {
      await progress(2, 100, 'A gerar um retrato fictício');
      portrait = await generateFictionalPortrait();
      portraitId = await saveAsset(db, { interviewId: null, kind: 'lab_portrait', mime: 'image/jpeg', ext: 'jpg', data: portrait, meta: { fictional: true, jobId: job.id } });
    }
    const prevA = await db.one(`SELECT id, storage_key, duration_ms FROM assets WHERE kind='lab_audio' AND meta->>'jobId'=$1 LIMIT 1`, [job.id]);
    let audioId: string, audioMs: number;
    if (prevA) { audioId = prevA.id; audioMs = prevA.duration_ms; }
    else {
      await progress(6, 100, 'A gerar a voz');
      const sp = await readQuestion(String(job.input.text), 'male', 'en');
      const pr = await probeAudio(sp.data, sp.ext);
      audioMs = pr.durationMs;
      audioId = await saveAsset(db, { interviewId: null, kind: 'lab_audio', mime: sp.mime, ext: sp.ext, data: sp.data, durationMs: audioMs, meta: { jobId: job.id } });
    }
    const imageUrl = signedAssetUrl(portraitId), audioUrl = signedAssetUrl(audioId);
    const chosen = PROVIDERS.filter(p => (job.input.providers as string[]).includes(p.id));
    const results: any[] = [];
    const { default: ff } = await import('@ffmpeg-installer/ffmpeg');
    for (let i = 0; i < chosen.length; i++) {
      const p = chosen[i];
      // Já feito numa tentativa anterior? Não se paga outra vez.
      const done = await db.one(`SELECT id, meta FROM assets WHERE kind='lab_video' AND meta->>'jobId'=$1 AND meta->>'provider'=$2 LIMIT 1`, [job.id, p.id]);
      if (done) { results.push({ ...done.meta, videoAssetId: done.id }); continue; }
      const base = 10 + Math.round((i / chosen.length) * 88);
      await progress(base, 100, `${p.label}: a enviar`);
      const t0 = Date.now();
      try {
        const r = lipsyncMock()
          ? { video: await stillClip(process.env.FFMPEG_PATH || ff.path, portrait, audioMs), billedSec: null }
          : await runProvider(p, { imageUrl, audioUrl, image: portrait, text: String(job.input.text), audioSec: audioMs / 1000, direction: job.input.direction }, s => progress(base, 100, `${p.label}: ${s}`));
        const secs = p.id === 'veo' ? 8 : (r.billedSec ?? audioMs / 1000);
        const meta = { jobId: job.id, provider: p.id, label: p.label, partner: p.partner, ownAudio: p.ownAudio, wallSec: Math.round((Date.now() - t0) / 1000), billedSec: r.billedSec, estUsd: p.pricePerSec != null ? secs * p.pricePerSec : null };
        const vid = await saveAsset(db, { interviewId: null, kind: 'lab_video', mime: 'video/mp4', ext: 'mp4', data: r.video, meta });
        results.push({ ...meta, videoAssetId: vid });
      } catch (e: any) {
        console.error(`[lab] ${p.label} falhou: ${String(e?.message ?? e).slice(0, 300)}`);
        results.push({ provider: p.id, label: p.label, ownAudio: p.ownAudio, error: String(e?.message ?? e).slice(0, 300), wallSec: Math.round((Date.now() - t0) / 1000) });
      }
    }
    await progress(100, 100, 'Concluído');
    return { results, portraitAssetId: portraitId, audioAssetId: audioId, audioSec: Math.round(audioMs / 100) / 10 };
  },

  async lipsync_experiment(job, { db, progress }) {
    const t0 = Date.now();
    // Numa nova tentativa reaproveita o retrato já gerado (não volta a pagar a imagem).
    const prev = await db.one(`SELECT id, storage_key FROM assets WHERE kind='lab_portrait' AND meta->>'jobId'=$1 LIMIT 1`, [job.id]);
    let portrait: Buffer, portraitId: string;
    if (prev) { portrait = await storage.get(prev.storage_key); portraitId = prev.id; }
    else {
      await progress(5, 100, 'A gerar um retrato fictício');
      portrait = await generateFictionalPortrait();
      portraitId = await saveAsset(db, { interviewId: null, kind: 'lab_portrait', mime: 'image/jpeg', ext: 'jpg', data: portrait, meta: { fictional: true, jobId: job.id } });
    }
    await progress(20, 100, 'A gerar a voz');
    const sp = await readQuestion(String(job.input.text ?? 'Hello.'), 'male', 'en');
    const pr = await probeAudio(sp.data, sp.ext);
    await progress(30, 100, 'A enviar para a Replicate');
    let video: Buffer, meta: any;
    if (lipsyncMock()) {
      const { default: ff } = await import('@ffmpeg-installer/ffmpeg');
      video = await encodeVideo(process.env.FFMPEG_PATH || ff.path, [{ startMs: 0, endMs: pr.durationMs, scene: 'cover', text: '' }], async () => portrait, sp.data);
      meta = { predictSec: 0, estCostUsd: 0, model: 'mock', version: 'mock', predictionId: 'mock' };
    } else {
      const r = await lipsync({ data: portrait, mime: 'image/jpeg' }, { data: sp.data, mime: sp.mime }, s => progress(50, 100, s));
      video = r.video; meta = { predictSec: r.predictSec, estCostUsd: r.estCostUsd, model: r.model, version: r.version, predictionId: r.predictionId };
    }
    const videoId = await saveAsset(db, { interviewId: null, kind: 'lab_video', mime: 'video/mp4', ext: 'mp4', data: video, meta });
    await progress(100, 100, 'Concluído');
    return { videoAssetId: videoId, portraitAssetId: portraitId, audioSec: Math.round(pr.durationMs / 100) / 10, wallSec: Math.round((Date.now() - t0) / 1000), ...meta };
  },

  async __onFail(job, { db }) {
    if (job.interview_id && ['process_submission', 'prepare_script', 'generate_episode'].includes(job.kind))
      await db.query(`UPDATE interviews SET production_status='failed' WHERE id=$1`, [job.interview_id]);
  },
};

/** Fala que seria animada num episódio (segundos) e custo estimado da animação. */
export function animationEstimate(ep: any, iv: any, guestConsent: boolean, hasHostPhoto: boolean, hasGuestPhoto: boolean) {
  const timing = (ep.technical?.timing ?? []) as any[];
  const sec = timing.filter(t => !['disclosure', 'editorial_intro', 'editorial_outro'].includes(t.kind)
    && ((t.role === 'host' && iv.host_animate && hasHostPhoto) || (t.role === 'guest' && guestConsent && hasGuestPhoto))).reduce((a, t) => a + t.durationMs / 1000, 0);
  return { sec, usd: estimateLipsyncUsd(sec), minutes: Math.ceil((sec * 8.6) / 3 / 60) + 2 };
}

/** Estimativa (não custo final): preços configuráveis; a utilização observada fica no usage_ledger. */
export async function estimateCost(db: Db, interviewId: string, subtitleLangs: string[]) {
  const a = await db.one(`SELECT COALESCE(sum(ast.duration_ms),0)::bigint AS ms FROM answers an JOIN answer_takes t ON t.id=an.selected_take_id JOIN assets ast ON ast.id=t.asset_id WHERE an.interview_id=$1`, [interviewId]);
  const mins = Number(a.ms) / 60000;
  const spokenChars = mins * 900; // ~150 palavras/min × 6 caracteres
  const tr = mins * config.prices.transcribePerMin;
  const tts = ((spokenChars * 1.2 + 300) / 1000) * config.prices.ttsPer1kChars;
  const text = ((spokenChars * 2) / 3 / 1000) * config.prices.textPer1kTokens * (1 + subtitleLangs.filter(l => l !== 'en').length);
  const img = config.prices.imageEach;
  return { minutes: mins, usd: tr + tts + text + img, parts: { transcription: tr, speech: tts, text, cover: img }, estimatedAudioMin: (spokenChars * 1.2) / 900 };
}
