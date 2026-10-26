import { randomBytes } from 'node:crypto';
import { videoGuestPhoto, usablePhotoSql } from './guest-photos.ts';
import type { Db } from './db.ts';
import { config } from './config.ts';
import { storage } from './storage.ts';
import { sha256, slugify, firstChars } from './lib.ts';
import { saveAsset, assembleEpisode, probeAudio } from './media.ts';
import { transcribeAudio, transcribeWords, prepareEnglishScript, translateSubtitleCues, synthesizeSpeech, coverBriefing, generateCoverBackground, episodeVoice, newMeter, meterUsd, AiCutError, UNTRANSLATED, type ScriptSegment, type TokenMeter } from './ai/openai.ts';
import { planShots, renderBases, subtitleFrame, encodeVideo, encodeComposite, splitParts, shotsWithin, sliceAudio, stillClip, buildAudioTrack, type Part } from './video.ts';
import { photoTimeline, peopleOf } from './graphics.ts';
import { lipsync, lipsyncMock, estimateLipsyncUsd } from './lipsync.ts';
import { PROVIDERS, runProvider, signedAssetUrl, heygenAvatarIV } from './talking.ts';
import { readQuestion, generateFictionalPortrait } from './ai/openai.ts';
import { cuesFromWords, fixOverlaps, checkCues, splitByWeights, type Cue } from './subtitles.ts';
import { composeCover } from './cover.ts';
import { PermanentError, type Handler } from './jobs.ts';
import { renderVeoVideo, releaseQuoteOfJob, VIDEO_ONLY_PREVIEW } from './veo-episode.ts';
import { renderHostIntro, failIntro } from './veo-intro.ts';
import { reverseDebit } from './wallet.ts';
import { isUuid } from './support.ts';
import { purgeUnpublishedPhotoVideos } from './uploads.ts';
import { notifyJob } from './notify.ts';
import { veoContinuity } from './lab-continuity.ts';
import { veoFilterProbe } from './lab-filter.ts';
import { SCRIPT_SEGMENT_MAX, SUBTITLE_LANGS } from './limits.ts';

const usage = (db: Db, interviewId: string, kind: string, quantity: number, cost: number) =>
  db.query('INSERT INTO usage_ledger(interview_id, kind, quantity, cost_usd, estimated) VALUES ($1,$2,$3,$4,true)', [interviewId, kind, quantity, cost]);
/**
 * Tokens de texto medidos numa chamada (ou num bloco de chamadas) à IA, no usage_ledger: o guião ('text_tokens'), as
 * traduções das legendas ('subtitle_tokens'), o resumo da capa ('cover_tokens') e a verificação do guião ('review_tokens').
 * Grava-se também quando a resposta falhou depois de chegar (foi paga). Antes, só o guião ficava registado, e por estimativa.
 */
export const recordTextUsage = async (db: Db, interviewId: string, kind: string, m: TokenMeter) => {
  if (m.input + m.output > 0) await usage(db, interviewId, kind, m.input + m.output, meterUsd(m));
};

export const latestTranscript = (db: Db, kind: string, sourceId: string) =>
  db.one('SELECT * FROM transcripts WHERE source_kind=$1 AND source_id=$2 ORDER BY revision DESC LIMIT 1', [kind, sourceId]);

async function transcribeAsset(db: Db, interview: any, assetId: string, sourceKind: string, sourceId: string) {
  if (await latestTranscript(db, sourceKind, sourceId)) return;
  const a = await db.one('SELECT * FROM assets WHERE id=$1', [assetId]);
  if (!a) throw new PermanentError('Ativo em falta');
  // Gravação substituída (ou pergunta eliminada) antes de a transcrição correr: já saiu do disco e não serve (uploads.ts).
  if (a.deleted_at) { if (a.meta?.erased === 'replaced') return; throw new PermanentError('Ativo em falta'); }
  // Resposta escrita (o texto entra como transcrição ao carregar): se faltar, sai do próprio texto, sem transcrição paga.
  if (a.kind === 'answer_text') {
    const text = (await storage.get(a.storage_key)).toString('utf8');
    await db.query(`INSERT INTO transcripts(interview_id, source_kind, source_id, revision, text, language, origin) VALUES ($1,$2,$3,1,$4,$5,'document') ON CONFLICT DO NOTHING`,
      [interview.id, sourceKind, sourceId, text, interview.answer_lang && interview.answer_lang !== 'auto' ? interview.answer_lang : null]);
    return;
  }
  const ext = a.storage_key.split('.').pop()!;
  const r = await transcribeAudio(await storage.get(a.storage_key), ext, interview.answer_lang);
  await db.query(`INSERT INTO transcripts(interview_id, source_kind, source_id, revision, text, language) VALUES ($1,$2,$3,1,$4,$5) ON CONFLICT DO NOTHING`, [interview.id, sourceKind, sourceId, r.text, r.language]);
  const mins = (a.duration_ms ?? 0) / 60000;
  await usage(db, interview.id, 'transcription_min', mins, mins * config.prices.transcribePerMin);
}

/** Marca, no guião, as falas do convidado que vêm de uma resposta escrita. */
export const WRITTEN_FLAG = 'Resposta escrita: o convidado carregou um ficheiro (Word ou texto) em vez de gravar; o texto é lido pela voz sintética.';

export async function prepareScript(db: Db, interviewId: string) {
  const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [interviewId]);
  const qs = await db.query(`SELECT q.*, a.status, a.selected_take_id, t.uploaded_via FROM questions q LEFT JOIN answers a ON a.question_id=q.id LEFT JOIN answer_takes t ON t.id=a.selected_take_id WHERE q.interview_id=$1 ORDER BY q.position`, [interviewId]);
  const items: any[] = [];
  for (const q of qs) {
    const qt = q.text || (await latestTranscript(db, 'question', q.id))?.text || '';
    const at = q.status === 'answered' && q.selected_take_id ? (await latestTranscript(db, 'answer_take', q.selected_take_id))?.text ?? '' : '';
    items.push({ questionId: q.id, question: qt, status: q.status === 'answered' ? 'answered' : 'refused', answer: at });
  }
  // Uma resposta cortada pelo teto (proporcional à entrevista) voltaria a cortar-se com a mesma entrada: erro permanente,
  // uma tentativa e não três. Os tokens ficam registados também quando falha (a resposta foi paga).
  const meter = newMeter();
  const r = await prepareEnglishScript({ title: iv.title, objective: iv.objective_text, items }, meter)
    .catch((e: any) => { throw e instanceof AiCutError || e instanceof SyntaxError ? new PermanentError(`O guião da IA não pôde ser lido: ${String(e?.message ?? e).slice(0, 120)}`) : e; })
    .finally(() => recordTextUsage(db, interviewId, 'text_tokens', meter));
  // Respostas escritas (ficheiro Word ou texto): o editor vê no guião que a fala do convidado não veio de uma gravação.
  const written = new Set(qs.filter((q: any) => q.status === 'answered' && q.uploaded_via === 'document').map((q: any) => q.id));
  for (const s of r.segments) if (s.transformationType === 'translated_answer' && s.sourceQuestionId && written.has(s.sourceQuestionId))
    r.reviewFlags.push({ segmentId: s.id, reason: WRITTEN_FLAG });
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
  const row = await db.one(
    `INSERT INTO scripts(interview_id, revision, title_en, segments, review_flags, blocking_issues, status, prompt_version, model) VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8) RETURNING id`,
    [interviewId, rev, r.titleEnglish, JSON.stringify(r.segments), JSON.stringify(r.reviewFlags), JSON.stringify(r.blockingIssues), r.promptVersion, r.model]);
  await db.query(`UPDATE interviews SET production_status='editorial_review' WHERE id=$1`, [interviewId]);
  return row.id as string;
}

export const handlers: Record<string, Handler> = {
  // Laboratório: continuidade entre clipes do Veo (lab-continuity.ts).
  veo_continuity: veoContinuity,
  veo_filter_probe: veoFilterProbe,
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
    const qs = await db.query(`SELECT q.*, a.status, t.asset_id, t.uploaded_via, a.selected_take_id FROM questions q LEFT JOIN answers a ON a.question_id=q.id LEFT JOIN answer_takes t ON t.id=a.selected_take_id WHERE q.interview_id=$1 ORDER BY q.position`, [iv.id]);
    // Pesos: transcrever uma resposta ~3, uma pergunta gravada ~1, preparar o guião ~6.
    const W = { q: 1, a: 3, script: 6 };
    let done = 0; const total = qs.length * (W.q + W.a) + W.script;
    await progress(0, total, 'A preparar');
    for (const q of qs) {
      if (q.audio_asset_id && !q.text) { await progress(done, total, `A transcrever a pergunta ${q.position} de ${qs.length}`); await transcribeAsset(db, iv, q.audio_asset_id, 'question', q.id); }
      done += W.q;
      if (q.status === 'answered' && q.asset_id) { await progress(done, total, q.uploaded_via === 'document' ? `Resposta ${q.position} de ${qs.length}: escrita, sem transcrição` : `A transcrever a resposta ${q.position} de ${qs.length}`); await transcribeAsset(db, iv, q.asset_id, 'answer_take', q.selected_take_id); }
      done += W.a;
      await progress(done, total);
    }
    await progress(done, total, 'A preparar o guião em inglês');
    await prepareScript(db, iv.id);
    await progress(total, total, 'Concluído');
    return { ok: true };
  },

  async prepare_script(job, { db }) {
    // Como no processamento: sem a autorização do convidado (retirada depois do pedido), nada vai à IA.
    const processingOk = (await db.one(`SELECT granted FROM consents WHERE interview_id=$1 AND purpose='processing' ORDER BY created_at DESC LIMIT 1`, [job.interview_id]))?.granted;
    if (!processingOk) throw new PermanentError('Sem autorização de processamento por IA');
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
    const segments: ScriptSegment[] = script.segments;
    const opts = job.input as { subtitleLangs?: string[]; coverPhotoIds?: string[] };
    // Entradas verificadas antes da primeira chamada paga, com erro permanente (não se repete): antes, uma fotografia de
    // capa forjada ('-' × 36 passava o filtro da rota) só falhava na consulta da capa, depois de pagas a voz, os tempos das
    // legendas, as traduções e a capa, e o erro (não permanente) repetia tudo três vezes.
    if (opts.coverPhotoIds !== undefined && (!Array.isArray(opts.coverPhotoIds) || opts.coverPhotoIds.length > 2 || !opts.coverPhotoIds.every(isUuid)))
      throw new PermanentError('Fotografias da capa inválidas');
    // Línguas das legendas (as do pedido ou, sem elas, as da entrevista): só as oferecidas, e cada uma traduz-se uma vez.
    // Antes, só se verificava o formato: ['en', 'de' × 3000] dava 3000 traduções das legendas (gpt-4.1) numa geração.
    const askedLangs: unknown = opts.subtitleLangs?.length ? opts.subtitleLangs : iv.subtitle_langs;
    if ((opts.subtitleLangs !== undefined && !Array.isArray(opts.subtitleLangs)) || !Array.isArray(askedLangs) || !askedLangs.every(l => SUBTITLE_LANGS.some(s => s[0] === l)))
      throw new PermanentError('Línguas das legendas inválidas');
    const subLangs: string[] = [...new Set(askedLangs as string[])];
    const long = (Array.isArray(segments) ? segments : []).find(s => typeof s?.textEnglish !== 'string' || s.textEnglish.length > SCRIPT_SEGMENT_MAX);
    if (!Array.isArray(segments) || !segments.length || long) throw new PermanentError(`Guião inválido${long ? `: o segmento ${String(long.id)} passa o limite da síntese de voz (${SCRIPT_SEGMENT_MAX} caracteres)` : ''}`);
    await db.query(`UPDATE interviews SET production_status='generating' WHERE id=$1`, [iv.id]);

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
    // Cada tentativa paga outra vez os tempos (sem cache): os minutos enviados ficam no usage_ledger ('timestamps_min').
    let en: Cue[] = [];
    let wordsMs = 0;
    for (let i = 0; i < timing.length; i++) {
      const seg = timing[i];
      await progress(step, total, `A sincronizar as legendas: segmento ${i + 1} de ${timing.length}`);
      const words = await transcribeWords(seg.data, seg.ext).catch(() => []);
      wordsMs += seg.durationMs;
      step += W.words;
      en.push(...cuesFromWords(words, seg, 'en'));
    }
    if (wordsMs) await usage(db, iv.id, 'timestamps_min', wordsMs / 60000, (wordsMs / 60000) * config.prices.transcribePerMin);
    // Fala de cada legenda (o id de cuesFromWords é «fala-k»), guardada antes de os ids passarem a c0, c1…
    en = fixOverlaps(en);
    const falaOf = en.map(c => c.id.slice(0, c.id.lastIndexOf('-')));
    en = en.map((c, i) => ({ ...c, id: `c${i}` }));
    const subtitles: Record<string, Cue[]> = { en };
    // Legendas de cada fala (pela ordem) e o texto aprovado dela, para a tradução fala a fala.
    const groups = () => { const g = new Map<string, number[]>(); falaOf.forEach((f, i) => { const l = g.get(f) ?? []; l.push(i); g.set(f, l); }); return g; };
    const falaItems = () => [...groups()].map(([fala, idx]) => ({ id: fala, text: timing.find(t => t.id === fala)?.text?.trim() || idx.map(i => en[i].text).join(' ') }));
    const trIssues: string[] = [];
    for (const lang of subLangs.filter(l => l !== 'en')) {
      await progress(step, total, `A traduzir as legendas (${lang})`);
      // Teto de tokens por bloco e, numa resposta cortada ou inválida, o inglês desse bloco (o trabalho não se repete).
      const meter = newMeter();
      // Tradução fala a fala (o texto aprovado, com frases completas) e divisão pelas legendas inglesas dessa fala, na
      // proporção do tamanho de cada uma: traduzir legenda a legenda fazia a IA passar texto de umas para as outras (e
      // entre o entrevistador e o convidado), e as legendas traduzidas ficavam fora de tempo face à voz.
      const tr = await translateSubtitleCues(falaItems(), lang, meter).finally(() => recordTextUsage(db, iv.id, 'subtitle_tokens', meter));
      const map = new Map(tr.filter(x => !x.reviewFlags.includes(UNTRANSLATED) && x.translatedText.trim()).map(x => [x.sourceCueId, x.translatedText]));
      const out: Cue[] = [];
      let untranslated = 0;
      for (const [fala, idx] of groups()) {
        const t = map.get(fala);
        const parts = t ? splitByWeights(t, idx.map(i => en[i].text.length)) : null;
        if (!t) untranslated += idx.length;
        idx.forEach((i, k) => out.push({ ...en[i], language: lang, text: (parts?.[k] || '') || en[i].text }));
      }
      if (untranslated) trIssues.push(`${lang}: ${untranslated} legendas ficaram em inglês (a resposta da IA veio cortada ou inválida)`);
      subtitles[lang] = out.sort((x, y) => x.startMs - y.startMs);
      step += W.tr;
    }
    if (!subLangs.includes('en')) delete subtitles.en;
    const cueIssues = [...trIssues, ...Object.entries(subtitles).flatMap(([l, c]) => checkCues(c, asm.durationMs).map(m => `${l}: ${m}`))];

    // 4. Capa: fundo por IA (ou determinístico) + texto e retratos compostos por nós.
    await progress(step, total, 'A criar a capa');
    const coverMeter = newMeter();
    const brief = await coverBriefing(script.title_en, iv.objective_text, coverMeter).catch(() => null);
    await recordTextUsage(db, iv.id, 'cover_tokens', coverMeter);
    const bg = brief ? await generateCoverBackground(brief).catch(() => null) : null;
    if (bg) await usage(db, iv.id, 'image', 1, config.prices.imageEach);
    const coverOk = await consent('cover_use');
    const photoRows = coverOk && opts.coverPhotoIds?.length
      ? await db.query(`SELECT a.*, p.id AS photo_id FROM photos p JOIN assets a ON a.id=p.asset_id WHERE p.interview_id=$1 AND p.id = ANY($2::uuid[]) AND ${usablePhotoSql('p')} LIMIT 2`, [iv.id, opts.coverPhotoIds]) : [];
    const photoBufs = await Promise.all(photoRows.map((a: any) => storage.get(a.storage_key)));
    // A capa não falha pelas entradas (composeCover: texto sem os caracteres que o XML não admite, fotografia ou fundo que não
    // se descodificam ficam de fora); uma falha que ainda assim aconteça repetir-se-ia igual em cada tentativa, depois das
    // etapas pagas, e por isso é permanente.
    const { cover, thumb, photos: inCover } = await composeCover({ title: script.title_en, subtitle: iv.guest_name ? `with ${iv.guest_name}` : '', brand: config.brand, background: bg, photos: photoBufs, palette: brief?.palette })
      .catch((e: any) => { throw new PermanentError(`Não foi possível compor a capa: ${String(e?.message ?? e).slice(0, 200)}`); });
    const coverId = await saveAsset(db, { interviewId: iv.id, kind: 'episode_cover', mime: 'image/jpeg', ext: 'jpg', data: cover });
    const thumbId = await saveAsset(db, { interviewId: iv.id, kind: 'episode_cover', mime: 'image/jpeg', ext: 'jpg', data: thumb, meta: { thumb: true } });
    step += W.cover;
    await progress(step, total, 'Controlo de qualidade');

    // 5. Capítulos e controlo de qualidade. O título corta-se por pontos de código (firstChars): antes, o slice(0, 90) partia
    // um emoji a começar na posição 89 (pergunta do convidado ou guião editado à mão) e a gravação do episódio falhava.
    const chapters: { startMs: number; title: string }[] = [];
    const seen = new Set<string>();
    for (const s of segments) {
      if (s.sourceQuestionId && s.transformationType === 'translated_question' && !seen.has(s.sourceQuestionId)) {
        seen.add(s.sourceQuestionId);
        chapters.push({ startMs: timing.find(t => t.id === s.id)!.startMs, title: firstChars(s.textEnglish, 90) });
      }
    }
    const issues = [...cueIssues];
    if (asm.clipping) issues.push('Áudio com clipping');
    if (asm.durationMs < 1000) issues.push('Duração demasiado curta');

    // Gravação final numa só transação: se falhar, as versões anteriores ficam como estavam. Um erro dos dados (SQLSTATE da
    // classe 22, um valor que a base não aceita, ou 23, uma restrição) repetir-se-ia igual em cada tentativa, depois de
    // pagas as etapas anteriores, e por isso é permanente; uma falha da ligação continua a repetir-se.
    const ep = await db.tx(async tx => {
      const prev = await tx.query(`UPDATE episodes SET status='superseded', stale=true WHERE interview_id=$1 AND status IN ('preview','ready') RETURNING id`, [iv.id]);
      // coverPhotoIds: a escolha do entrevistador (também escolhe a fotografia do vídeo); coverPhotos: as que entraram de
      // facto na capa, para a capa deixar de se publicar e de ser servida se o convidado retirar a autorização (approval.ts).
      const row = await tx.one(
        `INSERT INTO episodes(interview_id, script_id, slug, title, description, audio_asset_id, cover_asset_id, cover_thumb_asset_id, duration_ms, subtitles, chapters, technical, status, visibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'preview','private') RETURNING id`,
        [iv.id, script.id, `${slugify(script.title_en)}-${randomBytes(3).toString('hex')}`, script.title_en, iv.objective_shared ? firstChars(iv.objective_text, 500) : '', audioId, coverId, thumbId, asm.durationMs,
          JSON.stringify(subtitles), JSON.stringify(chapters), JSON.stringify({ maxVolumeDb: asm.maxVolumeDb, clipping: asm.clipping, qcIssues: issues, supersedes: prev.map((p: any) => p.id), mock: config.openai.mock, voices: voiceOf, models: config.openai.models, coverPhotoIds: opts.coverPhotoIds ?? [], coverPhotos: inCover.map(i => photoRows[i].photo_id), timing: timing.map(t => ({ id: t.id, role: t.role, kind: kinds.get(t.id) ?? '', startMs: t.startMs, durationMs: t.durationMs })) })]);
      await tx.query(`UPDATE interviews SET production_status=$2, publication_status='awaiting_approval' WHERE id=$1`, [iv.id, issues.length ? 'qc' : 'ready']);
      return row;
    }).catch((e: any) => {
      if (/^2[23][0-9A-Z]{3}$/.test(String(e?.code ?? ''))) throw new PermanentError(`Não foi possível gravar o episódio: ${String(e?.message ?? e).slice(0, 200)}`);
      throw e;
    });
    // Os vídeos com fotografias das versões substituídas, que nunca foram para o ar, saem do disco (uploads.ts).
    await purgeUnpublishedPhotoVideos(db, iv.id);
    await notifyJob(db, job, 'episode_ready');
    await progress(total, total, 'Concluído');
    return { episodeId: ep.id, qcIssues: issues };
  },

  async render_video(job, { db, progress }) {
    // Segunda barreira (a primeira é a rota): o Veo exige orçamento aceite ou o administrador (veo-episode.ts);
    // os retratos animados (Replicate) são só do administrador.
    if (job.input.engine === 'veo') return renderVeoVideo(job, { db, progress });
    if (job.input.animate && !(await requestedByAdmin(db, job.input.requestedBy))) throw new PermanentError('Os retratos animados por IA só se geram a pedido do administrador: o vídeo não foi gerado.');
    const ep = await db.one('SELECT * FROM episodes WHERE id=$1 AND interview_id=$2', [job.input.episodeId, job.interview_id]);
    if (!ep || ep.stale || ep.status === 'superseded') throw new PermanentError('Episódio inexistente ou desatualizado');
    // Num episódio publicado o vídeo novo iria logo para o ar sem ser visto e aprovado (e num retirado não serve).
    if (ep.status !== 'preview') throw new PermanentError(VIDEO_ONLY_PREVIEW);
    const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [ep.interview_id]);
    const timing = ep.technical?.timing as any[] | undefined;
    if (!timing?.length) throw new PermanentError('Este episódio foi gerado antes do vídeo existir: gere o episódio de novo');
    const consent = async (p: string) => !!(await db.one(`SELECT granted FROM consents WHERE interview_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`, [iv.id, p]))?.granted;
    await progress(0, 100, 'A preparar as imagens');
    const asset = async (id: string | null) => { if (!id) return null; const a = await db.one('SELECT storage_key FROM assets WHERE id=$1 AND deleted_at IS NULL', [id]); return a ? storage.get(a.storage_key) : null; };
    // Só fotografias autorizadas: a do entrevistador com direitos declarados; a do convidado com autorização de publicação.
    const hostPhoto = iv.host_photo_rights ? await asset(iv.host_photo_asset_id) : null;
    let guestPhoto: Buffer | null = null, guestByHost = false;
    if (await consent('publish_photo')) {
      const ph = await videoGuestPhoto(db, iv, { pid: job.input.photoId, coverIds: ep.technical?.coverPhotoIds });
      guestPhoto = ph ? await asset(ph.asset_id) : null;
      guestByHost = !!guestPhoto && ph!.added_by === 'host';
    }
    const cover = await asset(ep.cover_asset_id);
    const audio = await asset(ep.audio_asset_id);
    if (!cover || !audio) throw new PermanentError('Capa ou áudio do episódio em falta');
    const lang: string | null = job.input.lang && ep.subtitles?.[job.input.lang] ? job.input.lang : null;
    const shots = planShots(timing, ep.duration_ms, lang ? ep.subtitles[lang] : null);
    const people = peopleOf(iv);
    const bases = await renderBases({ cover, title: ep.title, brand: config.brand, host: { name: people.host.name || 'Host', role: people.host.role, photo: hostPhoto }, guest: { name: people.guest.name || 'Guest', role: people.guest.role, photo: guestPhoto } });
    const { default: ff } = await import('@ffmpeg-installer/ffmpeg');
    const ffmpeg = process.env.FFMPEG_PATH || ff.path;
    const frameFor = (sh: any) => subtitleFrame((bases as any)[sh.scene], sh.text);

    // Animação por fala: só com autorização específica de cada pessoa e fotografia autorizada.
    // O convidado só é animado num episódio em pré-visualização: tem de ver e aprovar o vídeo antes de ir para o ar.
    // HeyGen Avatar IV (teste do administrador): a fotografia e o áudio do episódio de cada fala, num só take, com a voz do
    // episódio; vale a autorização do vídeo por IA ou a da animação do retrato.
    const heygen = job.input.animEngine === 'heygen';
    const animHost = !!job.input.animate && (heygen ? !!(iv.host_ai_video || iv.host_animate) : iv.host_animate) && !!hostPhoto;
    const animGuest = !!job.input.animate && !!guestPhoto && ep.status === 'preview' && (heygen ? (await consent('ai_video')) || (await consent('animate_portrait')) : await consent('animate_portrait'));
    const segs = timing.map((t: any, i: number) => ({ ...t, endMs: i + 1 < timing.length ? timing[i + 1].startMs : ep.duration_ms }))
      .filter((t: any) => !['disclosure', 'editorial_intro', 'editorial_outro'].includes(t.kind) && ((t.role === 'host' && animHost) || (t.role === 'guest' && animGuest)) && t.durationMs >= 800);
    let animated = 0, failed = 0, gpuUsd = 0, guestAnimN = 0;
    let ok: { sg: any; clip: () => Promise<Buffer> }[] = [];
    if (segs.length) {
      // Só a chave de cada clipe fica em memória (lido do armazenamento na montagem): com dezenas de clipes HeyGen em
      // memória o servidor passava os 512 MB e era reiniciado a meio (OOM), sem nunca acabar o vídeo.
      const clips: (string | null)[] = new Array(segs.length).fill(null);
      let doneN = 0, next = 0;
      await progress(5, 100, `A animar os retratos (0 de ${segs.length} falas)`);
      // Até 3 animações em paralelo; uma falha cai para a imagem fixa (o vídeo nunca fica incompleto).
      const worker = async () => {
        while (next < segs.length) {
          const k = next++, sg = segs[k];
          try {
            const photo = sg.role === 'host' ? hostPhoto! : guestPhoto!;
            // Clipes já animados (mesma fotografia, mesma fala) são reaproveitados: uma nova tentativa não volta a pagar.
            const clipKey = sha256(`${sha256(photo)}|${ep.audio_asset_id}|${sg.startMs}|${sg.durationMs}|${lipsyncMock() ? 'mock' : heygen ? 'heygen' : 'replicate'}`);
            const cached = await db.one(`SELECT storage_key FROM assets WHERE interview_id=$1 AND kind='anim_clip' AND meta->>'clipKey'=$2 AND deleted_at IS NULL LIMIT 1`, [iv.id, clipKey]);
            if (cached) clips[k] = cached.storage_key;
            else {
              let clip: Buffer;
              if (lipsyncMock()) clip = await stillClip(ffmpeg, photo, sg.durationMs);
              else if (heygen) {
                // A HeyGen descarrega a fotografia e o áudio por URL assinado (1 h), guardados à parte (sem a entrevista).
                const speech = await sliceAudio(ffmpeg, audio, sg.startMs, sg.startMs + sg.durationMs);
                // (sempre em JPEG: a HeyGen recusa uma fotografia PNG servida como image/jpeg)
                const jpg = await (await import('sharp')).default(photo).rotate().jpeg({ quality: 92 }).toBuffer();
                const pId = await saveAsset(db, { interviewId: null, kind: 'lab_portrait', mime: 'image/jpeg', ext: 'jpg', data: jpg, meta: { interviewId: iv.id, heygen: true } });
                const aId = await saveAsset(db, { interviewId: null, kind: 'lab_audio', mime: 'audio/mpeg', ext: 'mp3', data: speech, durationMs: sg.durationMs, meta: { interviewId: iv.id, heygen: true } });
                // A HeyGen às vezes não consegue descarregar (servidor a arrancar): esse 400 não é cobrado; tenta de novo.
                let r: Awaited<ReturnType<typeof heygenAvatarIV>> | undefined;
                for (let t = 0; !r; t++) {
                  try { r = await heygenAvatarIV(signedAssetUrl(pId), signedAssetUrl(aId)); }
                  catch (e: any) { if (t >= 2 || !/could not download|invalid url/i.test(String(e?.message ?? e))) throw e; await new Promise(res => setTimeout(res, 20_000 * (t + 1))); }
                }
                clip = r.video; gpuUsd += (r.billedSec ?? sg.durationMs / 1000) * 0.0385;
              } else {
                const speech = await sliceAudio(ffmpeg, audio, sg.startMs, sg.startMs + sg.durationMs);
                const r = await lipsync({ data: photo, mime: 'image/jpeg' }, { data: speech, mime: 'audio/mpeg' });
                clip = r.video; gpuUsd += r.estCostUsd ?? 0;
              }
              const cid = await saveAsset(db, { interviewId: iv.id, kind: 'anim_clip', mime: 'video/mp4', ext: 'mp4', data: clip, durationMs: sg.durationMs, meta: { clipKey, segmentId: sg.id, role: sg.role } });
              clips[k] = (await db.one('SELECT storage_key FROM assets WHERE id=$1', [cid])).storage_key;
            }
          } catch (e: any) { failed++; console.error(`[video] animação da fala ${sg.id} falhou: ${String(e?.message ?? e).slice(0, 200)}`); }
          doneN++;
          await progress(5 + Math.round((doneN / segs.length) * 65), 100, `A animar os retratos (${doneN} de ${segs.length} falas)`);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      ok = segs.map((sg: any, k: number) => ({ sg, key: clips[k] })).filter((x: any) => x.key).map((x: any) => ({ sg: x.sg, clip: () => storage.get(x.key) }));
      animated = ok.length; guestAnimN = ok.filter((x: any) => x.sg.role === 'guest').length;
      if (gpuUsd) await usage(db, iv.id, heygen ? 'heygen_usd' : 'lipsync_usd', gpuUsd, gpuUsd);
    }
    // Partes no tempo do episódio (fixas e, com retratos animados, as falas animadas); depois os cartões (título a seguir
    // ao aviso inicial e final), o som do episódio com silêncio nos cartões e o grafismo (rodapés e capítulos).
    // HeyGen: proporção de cada fotografia (os clipes pedidos em 16:9 traziam margens brancas; o recorte tira-as).
    const aspectOf: Record<'host' | 'guest', number | undefined> = { host: undefined, guest: undefined };
    if (heygen) for (const [r, ph] of [['host', hostPhoto], ['guest', guestPhoto]] as const) if (ph) { const m = await (await import('sharp')).default(ph).rotate().metadata(); if (m.width && m.height) aspectOf[r] = m.width / m.height; }
    const layout = splitParts(ok.map(x => ({ startMs: x.sg.startMs, endMs: x.sg.endMs })), ep.duration_ms);
    const cues = lang ? ep.subtitles[lang] as any[] : [];
    const epParts: Part[] = layout.map(l => {
      if (l.kind === 'still') return { kind: 'still', startMs: l.startMs, endMs: l.endMs, shots: shotsWithin(shots, l.startMs, l.endMs) };
      const x = ok[l.animIndex!];
      return { kind: 'anim', startMs: l.startMs, endMs: l.endMs, base: x.sg.role === 'host' ? bases.animHost : bases.animGuest, clip: x.clip, ...(heygen ? { cropAspect: aspectOf[x.sg.role as 'host' | 'guest'] } : {}),
        cues: cues.filter(c => c.endMs > l.startMs && c.startMs < l.endMs).map(c => ({ startMs: c.startMs - l.startMs, endMs: Math.min(c.endMs, l.endMs) - l.startMs, text: c.text })) };
    });
    await progress(segs.length ? 72 : 10, 100, 'A preparar os cartões e o grafismo');
    const tl = await photoTimeline({ parts: epParts, timing, durationMs: ep.duration_ms, audio, cover, title: ep.title, people, chapters: ep.chapters, animated: new Set(ok.map(x => x.sg.id)), subtitles: !!lang });
    const track = await buildAudioTrack(ffmpeg, tl.audio);
    const p0 = segs.length ? 74 : 14, span = segs.length ? 16 : 76;
    const mp4 = await encodeComposite(ffmpeg, tl.parts, frameFor, track, async (i, n) => progress(p0 + Math.round((i / n) * span), 100, `A montar o vídeo (${i} de ${n} partes)`), 'm4a', tl.overlays);
    await progress(92, 100, 'A guardar o vídeo');
    // Por papel: quem tem de aprovar depende de quem aparece de facto animado.
    const guestAnimated = guestAnimN > 0, hostAnimated = animated - guestAnimN > 0;
    const id = await saveAsset(db, { interviewId: iv.id, kind: 'episode_video', mime: 'video/mp4', ext: 'mp4', data: mp4, durationMs: tl.totalMs,
      meta: { lang, shots: shots.length, ...(heygen ? { engine: 'heygen' } : {}), guestPhoto: !!guestPhoto, guestPhotoByHost: guestByHost, hostPhoto: !!hostPhoto, animatedSegments: animated, failedAnimations: failed, guestAnimated, hostAnimated, lipsyncUsd: gpuUsd, graphics: tl.meta } });
    // Ligação com as autorizações lidas no próprio momento: uma retirada durante a geração não volta a pôr o vídeo no ar,
    // e o vídeo só se liga a um episódio ainda em pré-visualização: publicado a meio da geração, o vídeo novo não entra
    // no ar sem nova aprovação (as aprovações ficam presas ao vídeo que foi visto).
    // O vídeo que estava no episódio (ainda por publicar): lido antes de ligar o novo, para sair do disco se for só com
    // fotografias (uploads.ts). Um trabalho de cada vez por entrevista, por isso não muda entre a leitura e a ligação.
    const before = (await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [ep.id]))?.video_asset_id ?? null;
    const linked = await db.one(
      `UPDATE episodes e SET video_asset_id=$2, video_lang=$3 FROM interviews i
       WHERE e.id=$1 AND i.id=e.interview_id AND NOT e.stale AND e.status='preview'
         AND (NOT $4::boolean OR i.host_photo_rights) AND (NOT $5::boolean OR ((i.host_animate OR ($9::boolean AND i.host_ai_video)) AND i.host_photo_rights))
         AND (NOT $6::boolean OR COALESCE((SELECT c.granted FROM consents c WHERE c.interview_id=i.id AND c.purpose='publish_photo' ORDER BY c.created_at DESC LIMIT 1), false))
         AND (NOT $7::boolean OR (e.status='preview' AND (COALESCE((SELECT c.granted FROM consents c WHERE c.interview_id=i.id AND c.purpose='animate_portrait' ORDER BY c.created_at DESC LIMIT 1), false)
              OR ($9::boolean AND COALESCE((SELECT c.granted FROM consents c WHERE c.interview_id=i.id AND c.purpose='ai_video' ORDER BY c.created_at DESC LIMIT 1), false)))))
         AND (NOT $8::boolean OR (COALESCE((SELECT c.granted FROM consents c WHERE c.interview_id=i.id AND c.purpose='host_edit' ORDER BY c.created_at DESC LIMIT 1), false)))
       RETURNING e.id`,
      [ep.id, id, lang, !!hostPhoto, hostAnimated, !!guestPhoto, guestAnimated, guestByHost, heygen]);
    if (!linked) throw new PermanentError('Uma autorização foi retirada ou o episódio mudou durante a geração (publicado, retirado ou substituído): o vídeo não foi ligado ao episódio e fica privado. Um vídeo novo só entra num episódio em pré-visualização, para ser visto e aprovado antes de ir para o ar.');
    if (before && before !== id) await purgeUnpublishedPhotoVideos(db, iv.id, before);
    await notifyJob(db, job, 'video_ready');
    await progress(100, 100, 'Concluído');
    return { videoAssetId: id, shots: shots.length, animated, failed, lipsyncUsd: gpuUsd };
  },

  // Introdução animada do entrevistador (oferecida, custo interno; veo-intro.ts).
  render_intro: renderHostIntro,

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
        const secs = !p.ownAudio ? 8 : (r.billedSec ?? audioMs / 1000); // o Veo (Fast ou Lite) cobra o clipe de 8 s
        const meta = { jobId: job.id, provider: p.id, label: p.label, partner: p.partner, ownAudio: p.ownAudio, wallSec: Math.round((Date.now() - t0) / 1000), billedSec: r.billedSec, estUsd: p.pricePerSec != null ? secs * p.pricePerSec : null, model: 'model' in r ? r.model : null, usdPerSec: p.pricePerSec };
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
    // Regeneração paga que falhou: o crédito volta (uma regeneração falhada também não conta para as incluídas).
    if (job.input?.paidCents) await db.tx(t => reverseDebit(t, `regen:${job.id}`, 'a regeneração falhou: crédito devolvido'));
    // Vídeo de um orçamento que falhou de vez: os créditos cativos voltam todos ao saldo.
    if (job.kind === 'render_video' && job.input?.quoteId) await releaseQuoteOfJob(db, job);
    // Quem pediu o vídeo pode ter fechado a página (diz-se que recebe um email): o motivo vai por email.
    if (job.kind === 'render_video') await notifyJob(db, job, 'video_failed', String((await db.one('SELECT error FROM jobs WHERE id=$1', [job.id]))?.error ?? ''));
    // Introdução que falhou de vez (passageiros esgotados ou interrupções): o motivo fica à vista do entrevistador.
    if (job.kind === 'render_intro' && typeof job.input?.introId === 'string') {
      const err = (await db.one('SELECT error FROM jobs WHERE id=$1', [job.id]))?.error;
      await failIntro(db, job.input.introId, `A introdução não ficou pronta: ${String(err || 'a geração foi interrompida').slice(0, 600)} Os vídeos seguem sem introdução animada.`);
    }
  },
};

/** Quem pediu o trabalho é (ainda) administrador? */
const requestedByAdmin = async (db: Db, userId: unknown) => typeof userId === 'string' && /^[0-9a-f-]{36}$/i.test(userId) && (await db.one('SELECT role FROM users WHERE id=$1', [userId]))?.role === 'admin';

/** Fala que seria animada num episódio (segundos) e custo estimado da animação. */
export function animationEstimate(ep: any, iv: any, guestConsent: boolean, hasHostPhoto: boolean, hasGuestPhoto: boolean) {
  const timing = (ep.technical?.timing ?? []) as any[];
  const sec = timing.filter(t => !['disclosure', 'editorial_intro', 'editorial_outro'].includes(t.kind)
    && ((t.role === 'host' && iv.host_animate && hasHostPhoto) || (t.role === 'guest' && guestConsent && hasGuestPhoto && ep.status === 'preview'))).reduce((a, t) => a + t.durationMs / 1000, 0);
  return { sec, usd: estimateLipsyncUsd(sec), minutes: Math.ceil((sec * 8.6) / 3 / 60) + 2 };
}

/** Estimativa (não custo final): preços configuráveis; a utilização observada fica no usage_ledger. */
export async function estimateCost(db: Db, interviewId: string, subtitleLangs: string[]) {
  // Respostas escritas: duração estimada da leitura (contam para a voz e o texto), sem transcrição.
  const a = await db.one(`SELECT COALESCE(sum(ast.duration_ms),0)::bigint AS ms, COALESCE(sum(ast.duration_ms) FILTER (WHERE ast.kind<>'answer_text'),0)::bigint AS audio_ms
    FROM answers an JOIN answer_takes t ON t.id=an.selected_take_id JOIN assets ast ON ast.id=t.asset_id WHERE an.interview_id=$1 AND an.status='answered'`, [interviewId]);
  const mins = Number(a.ms) / 60000;
  const spokenChars = mins * 900; // ~150 palavras/min × 6 caracteres
  const tr = (Number(a.audio_ms) / 60000) * config.prices.transcribePerMin;
  const tts = ((spokenChars * 1.2 + 300) / 1000) * config.prices.ttsPer1kChars;
  const text = ((spokenChars * 2) / 3 / 1000) * config.prices.textPer1kTokens * (1 + subtitleLangs.filter(l => l !== 'en').length);
  const img = config.prices.imageEach;
  return { minutes: mins, usd: tr + tts + text + img, parts: { transcription: tr, speech: tts, text, cover: img }, estimatedAudioMin: (spokenChars * 1.2) / 900 };
}
