import { randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { config } from './config.ts';
import { storage } from './storage.ts';
import { sha256, slugify } from './lib.ts';
import { saveAsset, assembleEpisode, probeAudio } from './media.ts';
import { transcribeAudio, transcribeWords, prepareEnglishScript, translateSubtitleCues, synthesizeSpeech, coverBriefing, generateCoverBackground, type ScriptSegment } from './ai/openai.ts';
import { cuesFromWords, fixOverlaps, checkCues, type Cue } from './subtitles.ts';
import { composeCover } from './cover.ts';
import { PermanentError, type Handler } from './jobs.ts';

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
    let done = 0; const total = qs.length * 2 + 1;
    await progress(0, total);
    for (const q of qs) {
      if (q.audio_asset_id && !q.text) await transcribeAsset(db, iv, q.audio_asset_id, 'question', q.id);
      await progress(++done);
      if (q.status === 'answered' && q.asset_id) await transcribeAsset(db, iv, q.asset_id, 'answer_take', q.selected_take_id);
      await progress(++done);
    }
    await prepareScript(db, iv.id);
    await progress(total, total);
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
    const total = segments.length + subLangs.length + 3;
    let step = 0;
    await progress(0, total);

    // 1. Áudio por segmento (com cache por texto+papel+voz+modelo), incluindo o aviso inicial.
    const all: { id: string; role: 'host' | 'guest'; text: string; editorial: boolean }[] = [
      { id: 'disclosure', role: 'host', text: config.aiDisclosure, editorial: true },
      ...segments.map(s => ({ id: s.id, role: s.speakerRole, text: s.textEnglish, editorial: s.transformationType.startsWith('editorial_') })),
    ];
    const parts: { data: Buffer; ext: string; pauseAfterMs: number }[] = [];
    const timing: { id: string; role: 'host' | 'guest'; text: string; startMs: number; durationMs: number; data: Buffer; ext: string }[] = [];
    let cursor = 0, ttsChars = 0;
    for (let i = 0; i < all.length; i++) {
      const s = all[i];
      const key = sha256(`${s.role}|${s.text}|${config.openai.voices[s.role]}|${config.openai.models.speech}|${config.openai.mock}`);
      let asset = await db.one(`SELECT * FROM assets WHERE interview_id=$1 AND kind='tts_segment' AND meta->>'ttsKey'=$2 AND deleted_at IS NULL LIMIT 1`, [iv.id, key]);
      let data: Buffer, ext: string, dur: number;
      if (asset) { data = await storage.get(asset.storage_key); ext = asset.storage_key.split('.').pop()!; dur = asset.duration_ms; }
      else {
        const sp = await synthesizeSpeech(s.text, s.role);
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
      await progress(++step);
    }
    if (ttsChars) await usage(db, iv.id, 'tts_chars', ttsChars, (ttsChars / 1000) * config.prices.ttsPer1kChars);

    // 2. Montagem (derivados; as gravações originais não são tocadas).
    const asm = await assembleEpisode(parts);
    await progress(++step);
    const audioId = await saveAsset(db, { interviewId: iv.id, kind: 'episode_audio', mime: 'audio/mpeg', ext: 'mp3', data: asm.mp3, durationMs: asm.durationMs, meta: { maxVolumeDb: asm.maxVolumeDb, clipping: asm.clipping } });

    // 3. Legendas: tempos MEDIDOS no áudio sintético final de cada segmento (não por divisão de duração por palavras).
    let en: Cue[] = [];
    for (const seg of timing) {
      const words = await transcribeWords(seg.data, seg.ext).catch(() => []);
      en.push(...cuesFromWords(words, seg, 'en'));
    }
    en = fixOverlaps(en).map((c, i) => ({ ...c, id: `c${i}` }));
    const subtitles: Record<string, Cue[]> = { en };
    for (const lang of subLangs.filter(l => l !== 'en')) {
      const tr = await translateSubtitleCues(en.map(c => ({ id: c.id, text: c.text })), lang);
      const map = new Map(tr.map(x => [x.sourceCueId, x.translatedText]));
      subtitles[lang] = en.map(c => ({ ...c, language: lang, text: map.get(c.id) || c.text })); // ligação 1:1 aos cues de origem
      await progress(++step);
    }
    if (!subLangs.includes('en')) delete subtitles.en;
    const cueIssues = Object.entries(subtitles).flatMap(([l, c]) => checkCues(c, asm.durationMs).map(m => `${l}: ${m}`));

    // 4. Capa: fundo por IA (ou determinístico) + texto e retratos compostos por nós.
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
    await progress(++step);

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
        JSON.stringify(subtitles), JSON.stringify(chapters), JSON.stringify({ maxVolumeDb: asm.maxVolumeDb, clipping: asm.clipping, qcIssues: issues, supersedes: prev.map((p: any) => p.id), mock: config.openai.mock, voices: config.openai.voices, models: config.openai.models })]);
    await db.query(`UPDATE interviews SET production_status=$2, publication_status='awaiting_approval' WHERE id=$1`, [iv.id, issues.length ? 'qc' : 'ready']);
    await progress(total, total);
    return { episodeId: ep.id, qcIssues: issues };
  },

  async __onFail(job, { db }) {
    if (job.interview_id && ['process_submission', 'prepare_script', 'generate_episode'].includes(job.kind))
      await db.query(`UPDATE interviews SET production_status='failed' WHERE id=$1`, [job.interview_id]);
  },
};

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
