import { config } from './config.ts';
import { storage } from './storage.ts';
import { sha256 } from './lib.ts';
import { saveAsset } from './media.ts';
import { transcribeWords, translateSubtitleCues, type Word } from './ai/openai.ts';
import { renderBases, subtitleFrame, encodeComposite, buildAudioTrack, mockTalkingClip, type Part, type Shot, type Scene, type AudioPiece } from './video.ts';
import { cuesFromWords } from './subtitles.ts';
import { veoGenerate, veoEpisodePrompt, VEO_MODEL, VEO_PRICE_PER_SEC } from './talking.ts';
import { S } from './settings.ts';
import { PermanentError, type Handler } from './jobs.ts';

/**
 * Vídeo do episódio inteiramente com o Google Veo: cada fala autorizada é dividida em pedaços que cabem num clipe
 * (até 8 s), o Veo gera imagem E voz a partir da fotografia autorizada e do texto aprovado, e os clipes são colados.
 * O som do vídeo é o dos clipes (não o áudio sintético do episódio). Cada clipe é transcrito para verificar, palavra a
 * palavra, se o Veo disse o texto aprovado; se não disse, é gerado de novo (no máximo `veoRetries` vezes).
 * As legendas seguem o que foi efetivamente dito.
 */

export const VEO_MAX_WORDS = 15; // ~6 s de fala a 2,5 palavras/s: cabe num clipe de 8 s com folga
export const VEO_NOTICE = 'AI-generated video · AI voice';

const wc = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const snap = (ms: number) => Math.round(ms / 40) * 40; // 25 fps: cortes em fotogramas inteiros, sem desvio entre som e imagem

/** Divide o texto por frases, depois por vírgulas e, em último caso, por palavras, sem alterar o texto. */
export function chunkText(text: string, maxWords = VEO_MAX_WORDS): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const units: string[] = [];
  const byWords = (s: string) => {
    const w = s.split(' '), size = Math.ceil(w.length / Math.ceil(w.length / maxWords));
    for (let i = 0; i < w.length; i += size) units.push(w.slice(i, i + size).join(' '));
  };
  for (const s of clean.split(/(?<=[.!?]["'”’)\]]*)\s+/)) {
    if (wc(s) <= maxWords) { units.push(s); continue; }
    let buf = '';
    for (const p of s.split(/(?<=[,;:])\s+/)) {
      if (wc(p) > maxWords) { if (buf) { units.push(buf); buf = ''; } byWords(p); continue; }
      if (buf && wc(buf) + wc(p) > maxWords) { units.push(buf); buf = p; } else buf = buf ? `${buf} ${p}` : p;
    }
    if (buf) units.push(buf);
  }
  const out: string[] = [];
  let cur = '';
  for (const u of units) { if (cur && wc(cur) + wc(u) > maxWords) { out.push(cur); cur = u; } else cur = cur ? `${cur} ${u}` : u; }
  if (cur) out.push(cur);
  return out;
}

/** Duração a pedir (o Veo cobra a duração pedida): fala estimada a 2,5 palavras/s mais ~1,2 s de entrada e saída. */
export function veoDuration(text: string): 4 | 6 | 8 {
  const sec = wc(text) / 2.5 + 1.2;
  return sec <= 4 ? 4 : sec <= 6 ? 6 : 8;
}

export function normWords(s: string): string[] {
  return s.toLowerCase().replace(/[’‘`]/g, "'").replace(/[^\p{L}\p{N}']+/gu, ' ').split(' ').map(w => w.replace(/^'+|'+$/g, '')).filter(Boolean);
}

/** Diferença palavra a palavra (distância de edição) entre o texto pedido e o que se ouviu. */
export function wordDiff(expected: string, heard: string) {
  const a = normWords(expected), b = normWords(heard);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  const edits = prev[b.length];
  return { edits, n: a.length, wer: a.length ? edits / a.length : (b.length ? 1 : 0) };
}
/** Tolera uma palavra diferente (ou até 15%): a transcrição automática também erra nomes próprios e números. */
export const fidelityOk = (d: { edits: number; wer: number }) => d.edits <= 1 || d.wer <= 0.15;

/** Clipes e custo previstos (sem e com uma nova tentativa por clipe). */
export function veoEstimate(timing: any[], segments: any[], hostOk: boolean, guestOk: boolean) {
  const textOf = new Map<string, string>(segments.map((s: any) => [s.id, s.textEnglish]));
  let clips = 0, sec = 0;
  for (const t of timing) {
    if (t.kind === 'disclosure' || !(t.role === 'host' ? hostOk : guestOk)) continue;
    for (const c of chunkText(textOf.get(t.id) ?? '')) { clips++; sec += veoDuration(c); }
  }
  return { clips, sec, usd: sec * VEO_PRICE_PER_SEC, usdMax: sec * VEO_PRICE_PER_SEC * 2, minutes: Math.ceil(clips / 2) * 1.5 + 2 };
}

type Seg = { id: string; role: 'host' | 'guest'; kind: string; startMs: number; durationMs: number; endMs: number; text: string };
type Chunk = { seg: Seg; k: number; text: string; dur: 4 | 6 | 8 };
type Attempt = { assetId: string; storageKey: string; words: Word[]; heard: string; checked: boolean; edits: number | null; wer: number | null; billedSec: number };

const passes = (a: Attempt) => !a.checked || (a.words.length > 0 && fidelityOk({ edits: a.edits ?? 99, wer: a.wer ?? 1 }));

export async function renderVeoVideo(job: any, { db, progress }: Parameters<Handler>[1]) {
  const ep = await db.one('SELECT * FROM episodes WHERE id=$1 AND interview_id=$2', [job.input.episodeId, job.interview_id]);
  if (!ep || ep.stale || ep.status === 'superseded') throw new PermanentError('Episódio inexistente ou desatualizado');
  const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [ep.interview_id]);
  const timing = ep.technical?.timing as any[] | undefined;
  if (!timing?.length) throw new PermanentError('Este episódio foi gerado antes do vídeo existir: gere o episódio de novo');
  const mock = config.openai.mock;
  if (!mock && !S('GEMINI_API_KEY')) throw new PermanentError('Falta a chave da Google (Gemini API) em Definições');
  const script = await db.one('SELECT segments FROM scripts WHERE id=$1', [ep.script_id]);
  const textOf = new Map<string, string>((script?.segments ?? []).map((s: any) => [s.id, s.textEnglish]));
  const consent = async (p: string) => !!(await db.one(`SELECT granted FROM consents WHERE interview_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`, [iv.id, p]))?.granted;
  await progress(0, 100, 'A preparar as imagens');
  const asset = async (id: string | null) => { if (!id) return null; const a = await db.one('SELECT storage_key FROM assets WHERE id=$1 AND deleted_at IS NULL', [id]); return a ? storage.get(a.storage_key) : null; };

  // Só fotografias autorizadas; o Veo exige ainda a autorização específica de cada pessoa.
  const hostPhoto = iv.host_photo_rights ? await asset(iv.host_photo_asset_id) : null;
  let guestPhoto: Buffer | null = null;
  if (await consent('publish_photo')) {
    const pid = job.input.photoId ?? ep.technical?.coverPhotoIds?.[0] ?? null;
    const ph = pid ? await db.one('SELECT asset_id FROM photos WHERE id=$1 AND interview_id=$2', [pid, iv.id]) : await db.one('SELECT asset_id FROM photos WHERE interview_id=$1 ORDER BY created_at LIMIT 1', [iv.id]);
    guestPhoto = ph ? await asset(ph.asset_id) : null;
  }
  const hostVeo = !!hostPhoto && !!iv.host_ai_video;
  const guestVeo = !!guestPhoto && (await consent('ai_video'));
  if (!hostVeo && !guestVeo) throw new PermanentError('Ninguém autorizou o vídeo gerado pelo Google Veo (entrevistador: em Editar; convidado: em «Autorizações das fotografias»)');
  const cover = await asset(ep.cover_asset_id);
  const audio = await asset(ep.audio_asset_id);
  if (!cover || !audio) throw new PermanentError('Capa ou áudio do episódio em falta');
  const lang: string | null = job.input.lang && ep.subtitles?.[job.input.lang] ? job.input.lang : null;
  const names = { host: iv.host_name || 'Host', guest: iv.guest_name || 'Guest' };
  const bases = await renderBases({ cover, title: ep.title, brand: config.brand, host: { name: names.host, photo: hostPhoto }, guest: { name: names.guest, photo: guestPhoto } });
  const { default: ff } = await import('@ffmpeg-installer/ffmpeg');
  const ffmpeg = process.env.FFMPEG_PATH || ff.path;
  const { default: sharp } = await import('sharp');

  // Imagem inicial: a fotografia recortada a 16:9 (ou 9:16 se for vertical, mostrada ao centro como os grandes planos).
  const startImage = async (photo: Buffer) => {
    const upright = await sharp(photo).rotate().toBuffer();
    const m = await sharp(upright).metadata();
    const vertical = (m.height ?? 0) > (m.width ?? 0) * 1.05;
    const image = await sharp(upright).resize(vertical ? 720 : 1280, vertical ? 1280 : 720, { fit: 'cover', position: 'attention' }).jpeg({ quality: 90 }).toBuffer();
    return { image, vertical, hash: sha256(image) };
  };
  const start = { host: hostVeo ? await startImage(hostPhoto!) : null, guest: guestVeo ? await startImage(guestPhoto!) : null };
  const voice = { host: iv.question_voice === 'male' ? 'male' : 'female', guest: iv.guest_voice === 'male' ? 'male' : 'female' } as const;

  const segs: Seg[] = timing.map((t: any, i: number) => ({ ...t, endMs: i + 1 < timing.length ? timing[i + 1].startMs : ep.duration_ms, text: t.kind === 'disclosure' ? config.aiDisclosure : textOf.get(t.id) ?? '' }));
  const chunks: Chunk[] = [];
  for (const s of segs) if (s.kind !== 'disclosure' && start[s.role]) chunkText(s.text).forEach((text, k) => chunks.push({ seg: s, k, text, dur: veoDuration(text) }));

  // 1. Clipes: reaproveita tentativas já pagas (mesma imagem, texto, voz e duração); gera só o que falta.
  const maxAttempts = 1 + Math.max(0, Math.min(2, Number(job.input.veoRetries ?? 1)));
  const chosen: (Attempt | null)[] = new Array(chunks.length).fill(null);
  const attemptsOf: Attempt[][] = chunks.map(() => []);
  let spentUsd = 0, generated = 0, doneN = 0, next = 0;
  let abort: Error | null = null; // chave recusada: os dois trabalhadores param (não se continua a pagar)
  await progress(5, 100, `Google Veo: 0 de ${chunks.length} clipes`);
  const worker = async () => {
    while (next < chunks.length && !abort) {
      const i = next++, c = chunks[i], st = start[c.seg.role]!;
      const prompt = veoEpisodePrompt({ role: c.seg.role, text: c.text, voice: voice[c.seg.role] });
      const chunkKey = sha256(`${st.hash}|${prompt}|${st.vertical ? '9:16' : '16:9'}|${c.dur}|${VEO_MODEL}|${mock}`);
      const prev = await db.query(`SELECT id, storage_key, meta FROM assets WHERE interview_id=$1 AND kind='veo_clip' AND meta->>'chunkKey'=$2 AND deleted_at IS NULL ORDER BY created_at`, [iv.id, chunkKey]);
      const atts: Attempt[] = prev.map((a: any) => ({ assetId: a.id, storageKey: a.storage_key, words: a.meta.words ?? [], heard: a.meta.heard ?? '', checked: !!a.meta.checked, edits: a.meta.edits ?? null, wer: a.meta.wer ?? null, billedSec: Number(a.meta.billedSec ?? 0) }));
      let failures = 0;
      while (!abort && !atts.some(passes) && atts.length + failures < maxAttempts) {
        const label = `Google Veo: clipe ${doneN + 1} de ${chunks.length}${atts.length + failures ? ` (nova tentativa: o texto dito não coincidia)` : ''}`;
        await progress(5 + Math.round((doneN / chunks.length) * 70), 100, label);
        try {
          const r = mock
            ? { video: await mockTalkingClip(ffmpeg, st.image, c.dur * 1000, st.vertical), billedSec: c.dur }
            : await veoGenerate({ image: st.image, prompt, aspectRatio: st.vertical ? '9:16' : '16:9', durationSeconds: c.dur, onStatus: s => progress(5 + Math.round((doneN / chunks.length) * 70), 100, `${label} — ${s}`) });
          const usd = mock ? 0 : r.billedSec * VEO_PRICE_PER_SEC;
          spentUsd += usd; generated++;
          if (usd) await db.query('INSERT INTO usage_ledger(interview_id, kind, quantity, cost_usd, estimated) VALUES ($1,$2,$3,$4,true)', [iv.id, 'veo_usd', r.billedSec, usd]);
          let words: Word[] = [], checked = false;
          if (!mock) {
            try { words = await transcribeWords(r.video, 'mp4'); checked = true; } catch (e: any) { console.error(`[veo] transcrição do clipe falhou (fica por verificar): ${String(e?.message ?? e).slice(0, 200)}`); }
          }
          const heard = words.map(w => w.word.trim()).join(' ').replace(/\s+([,.;:!?])/g, '$1');
          const d = checked ? wordDiff(c.text, heard) : null;
          const meta = { chunkKey, segmentId: c.seg.id, role: c.seg.role, text: c.text, attempt: atts.length + 1, heard, words, checked, edits: d?.edits ?? null, wer: d?.wer ?? null, billedSec: r.billedSec, model: VEO_MODEL, mock };
          const assetId = await saveAsset(db, { interviewId: iv.id, kind: 'veo_clip', mime: 'video/mp4', ext: 'mp4', data: r.video, durationMs: r.billedSec * 1000, meta });
          const a = await db.one('SELECT storage_key FROM assets WHERE id=$1', [assetId]);
          atts.push({ assetId, storageKey: a.storage_key, words, heard, checked, edits: meta.edits, wer: meta.wer, billedSec: r.billedSec });
        } catch (e: any) {
          const m = String(e?.message ?? e);
          if (/^Veo 40[13]/.test(m)) { abort = new PermanentError(`A Google recusou a chave: ${m.slice(0, 200)}`); break; }
          failures++;
          console.error(`[veo] clipe ${i + 1} (${c.seg.id}) falhou: ${m.slice(0, 300)}`);
        }
      }
      attemptsOf[i] = atts;
      // A melhor tentativa: a que passa; senão, a que tem fala e menos diferenças; sem fala nenhuma, fica a imagem fixa.
      chosen[i] = atts.find(passes) ?? [...atts].filter(a => a.words.length > 0).sort((x, y) => (x.edits ?? 99) - (y.edits ?? 99))[0] ?? null;
      doneN++;
      await progress(5 + Math.round((doneN / chunks.length) * 70), 100, `Google Veo: ${doneN} de ${chunks.length} clipes`);
    }
  };
  await Promise.all([worker(), worker()]);
  if (abort) throw abort;

  // 2. Linha temporal: aviso inicial (capa + voz do episódio), falas do Veo, reserva em imagem fixa, cartão final.
  const parts: Part[] = [], audioPieces: AudioPiece[] = [];
  const sceneOf = new Map<Part, Scene>();
  type C = { id: string; startMs: number; endMs: number; text: string };
  const veoCues: C[] = [], fixedCues: C[] = [];
  const epCues: any[] = lang ? ep.subtitles[lang] : [];
  const stillScene = (s: Seg): Scene => (s.kind === 'disclosure' || s.kind === 'editorial_outro' ? 'cover' : s.kind === 'editorial_intro' ? 'studio' : s.role);
  const veoSegs = new Set<string>(), fallbackSegs: string[] = [];
  let t = 0;
  for (const s of segs) {
    const mine = chunks.map((c, i) => ({ c, ch: chosen[i] })).filter(x => x.c.seg === s);
    if (!mine.length || mine.some(x => !x.ch)) {
      if (mine.length) fallbackSegs.push(s.id);
      const from = s === segs[0] ? 0 : s.startMs, dur = snap(s.endMs - from);
      if (dur < 40) continue;
      for (const c of epCues) if (c.endMs > from && c.startMs < from + dur) fixedCues.push({ id: c.id, startMs: Math.max(t, t + c.startMs - from), endMs: Math.min(t + dur, t + c.endMs - from), text: c.text });
      const still: Part = { kind: 'still', startMs: t, endMs: t + dur, shots: [] };
      parts.push(still); sceneOf.set(still, stillScene(s));
      audioPieces.push({ durMs: dur, src: audio, ext: 'mp3', offsetMs: from });
      t += dur;
      continue;
    }
    veoSegs.add(s.id);
    for (const { c, ch } of mine) {
      const a0 = ch!, clipMs = a0.billedSec * 1000, w = a0.words;
      const a = w.length ? Math.max(0, Math.floor((w[0].start * 1000 - 200) / 40) * 40) : 0;
      const b = w.length ? Math.min(clipMs, Math.ceil((w[w.length - 1].end * 1000 + 350) / 40) * 40) : clipMs;
      const dur = Math.max(400, b - a);
      const cues = w.length
        ? cuesFromWords(w, { id: `${s.id}-${c.k}`, role: s.role, text: a0.heard, startMs: t - a, durationMs: clipMs }, 'en')
        : [{ id: `${s.id}-${c.k}-0`, startMs: t, endMs: t + dur, text: c.text }];
      for (const q of cues) if (q.endMs > t && q.startMs < t + dur) veoCues.push({ id: q.id, startMs: Math.max(t, q.startMs), endMs: Math.min(t + dur, q.endMs), text: q.text });
      const load = () => storage.get(a0.storageKey);
      parts.push({ kind: 'anim', startMs: t, endMs: t + dur, base: s.role === 'host' ? bases.animHost : bases.animGuest, clip: load, clipOffsetMs: a, notice: VEO_NOTICE, who: { name: names[s.role], role: s.role === 'host' ? 'Host' : 'Guest' }, cues: [] });
      audioPieces.push({ durMs: dur, src: load, ext: 'mp4', offsetMs: a });
      t += dur;
    }
  }
  if (parts[parts.length - 1]?.kind === 'anim') { // fecho na capa
    const end: Part = { kind: 'still', startMs: t, endMs: t + 1600, shots: [] };
    parts.push(end); sceneOf.set(end, 'cover');
    audioPieces.push({ durMs: 1600 }); t += 1600;
  }

  // 3. Legendas na língua escolhida: as do Veo seguem o que foi dito (traduzidas se preciso); as fixas vêm do episódio.
  if (lang && lang !== 'en' && veoCues.length) {
    await progress(77, 100, `A traduzir as legendas (${lang})`);
    const tr = await translateSubtitleCues(veoCues.map(c => ({ id: c.id, text: c.text })), lang);
    const map = new Map(tr.map(x => [x.sourceCueId, x.translatedText]));
    for (const c of veoCues) c.text = map.get(c.id) || c.text;
  }
  const allCues = lang ? [...veoCues, ...fixedCues] : [];
  for (const p of parts) {
    const inside = allCues.filter(c => c.endMs > p.startMs && c.startMs < p.endMs).map(c => ({ startMs: snap(Math.max(c.startMs, p.startMs)) - p.startMs, endMs: snap(Math.min(c.endMs, p.endMs)) - p.startMs, text: c.text })).filter(c => c.endMs > c.startMs);
    if (p.kind === 'anim') p.cues = inside;
    else p.shots = stillShots(sceneOf.get(p) ?? 'cover', p.startMs, p.endMs, inside.map(c => ({ ...c, startMs: c.startMs + p.startMs, endMs: c.endMs + p.startMs })));
  }

  // 4. Som (dos clipes) e montagem.
  await progress(78, 100, 'A juntar o som dos clipes');
  const track = await buildAudioTrack(ffmpeg, audioPieces);
  await progress(80, 100, 'A montar o vídeo');
  const frameFor = (sh: Shot) => subtitleFrame((bases as any)[sh.scene], sh.text);
  const mp4 = await encodeComposite(ffmpeg, parts, frameFor, track, async (i, n) => progress(80 + Math.round((i / n) * 12), 100, `A montar o vídeo (${i} de ${n} partes)`), 'wav');

  const fidelity = chunks.map((c, i) => {
    const ch = chosen[i];
    return { segmentId: c.seg.id, role: c.seg.role, expected: c.text, heard: ch?.heard ?? '', checked: !!ch?.checked, edits: ch?.edits ?? null, ok: !!ch && passes(ch), attempts: attemptsOf[i].length, used: veoSegs.has(c.seg.id) };
  });
  const costUsd = mock ? 0 : attemptsOf.flat().reduce((x, a) => x + a.billedSec * VEO_PRICE_PER_SEC, 0);
  await progress(94, 100, 'A guardar o vídeo');
  const usedRoles = new Set(segs.filter(s => veoSegs.has(s.id)).map(s => s.role));
  const meta = { engine: 'veo', model: VEO_MODEL, lang, guestPhoto: !!guestPhoto, hostPhoto: !!hostPhoto, guestAiVideo: usedRoles.has('guest'), hostAiVideo: usedRoles.has('host'),
    veoClips: chunks.length, veoSegments: veoSegs.size, fallbackSegments: fallbackSegs, generatedClips: generated, spentUsd, veoUsd: costUsd,
    fidelityIssues: fidelity.filter(f => f.used && (!f.ok || !f.checked)).length, fidelity, mock };
  const id = await saveAsset(db, { interviewId: iv.id, kind: 'episode_video', mime: 'video/mp4', ext: 'mp4', data: mp4, durationMs: t, meta });
  await db.query('UPDATE episodes SET video_asset_id=$2, video_lang=$3 WHERE id=$1', [ep.id, id, lang]);
  await progress(100, 100, 'Concluído');
  return { videoAssetId: id, veoClips: chunks.length, generatedClips: generated, spentUsd, veoUsd: costUsd, fallbackSegments: fallbackSegs, fidelityIssues: meta.fidelityIssues };
}

/** Planos fixos de um intervalo, cortados nas legendas (pontos já alinhados a fotogramas). */
export function stillShots(scene: Scene, a: number, b: number, cues: { startMs: number; endMs: number; text: string }[]): Shot[] {
  const cuts = new Set<number>([a, b]);
  for (const c of cues) { if (c.startMs > a && c.startMs < b) cuts.add(c.startMs); if (c.endMs > a && c.endMs < b) cuts.add(c.endMs); }
  const pts = [...cuts].sort((x, y) => x - y);
  const shots: Shot[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const mid = (pts[i] + pts[i + 1]) / 2;
    shots.push({ startMs: pts[i], endMs: pts[i + 1], scene, text: cues.find(c => mid >= c.startMs && mid < c.endMs)?.text ?? '' });
  }
  return shots;
}

