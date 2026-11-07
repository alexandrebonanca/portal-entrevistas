import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { withTemp } from './media.ts';
import { escXml } from './lib.ts';
import { run } from './video.ts';
import { MARK_PATHS } from './brand.ts';
import type { People } from './graphics.ts';
import type { Db } from './db.ts';
import { answerKeyPoints, newMeter, meterUsd } from './ai/openai.ts';
import { chapterTitles } from './graphics.ts';
import { firstChars } from './lib.ts';

/**
 * Vídeo editorial (o formato do ensaio «QuietInterview × Hotel Training Academy», 06/11/2026): fundo claro da marca,
 * marca do portal no canto, cartão de abertura (título, «X in conversation with Y», promotor), cartão «A real interview,
 * conducted remotely» sobre o aviso inicial, cada pessoa em altura total ao centro (clipe animado ou fotografia),
 * identificação na primeira fala de cada um, tema da pergunta («01 / 10» e título) na margem, três cartões de ideias-chave
 * em cada resposta longa e o cartão final com o promotor, o apoio do portal, a divulgação e quietinterview.com.
 * O som é sempre o do episódio (as falas animadas usam a mesma voz). Cada parte codifica-se à parte e junta-se no fim
 * (pouca memória); as legendas entregam-se em ficheiros (SRT/VTT), não gravadas na imagem.
 */
export const EDITORIAL = { bg: '#f6f2ea', stage: '#f3f5f9', ink: '#1c1a17', accent: '#b4691f', muted: '#6b655c', line: '#ddd5c6' };
export const OPEN_MS = 3000, CLOSE_MS = 6000, NOTE_MS = 2800, LOWER_EDITORIAL_MS = 6500;
const SERIF = "Georgia, 'DejaVu Serif', 'Times New Roman', serif", SANS = "'Segoe UI', 'DejaVu Sans', Arial, sans-serif";

export interface EditorialSeg { id: string; role: 'host' | 'guest'; kind: string; startMs: number; endMs: number }
export interface EditorialInput {
  ffmpeg: string; size: { w: number; h: number }; audio: Buffer; durationMs: number; segs: EditorialSeg[];
  clip: (id: string) => (() => Promise<Buffer>) | null; photos: { host: Buffer | null; guest: Buffer | null };
  people: People; promoter: string; title: string; chapters: Map<string, string>; keyPoints: Map<string, string[]>;
  writtenAnswers: boolean; animated: boolean; onProgress?: (i: number, n: number) => Promise<void>;
  /** Legendas gravadas na imagem (tempos do episódio), numa língua; sem elas, só os ficheiros SRT/VTT. */
  cues?: { startMs: number; endMs: number; text: string }[];
}

/** Nome da entidade do dono da entrevista (o promotor por omissão), ou vazio. */
export async function ownerEntityName(db: Db, ownerId: string): Promise<string> {
  const r = await db.one('SELECT e.name FROM users u JOIN entities e ON e.id=u.entity_id WHERE u.id=$1 AND e.active', [ownerId]);
  return String(r?.name ?? '').trim();
}
/** Promotor que aparece no vídeo: o escrito na entrevista ou o nome da entidade do entrevistador. */
export const promoterOf = async (db: Db, iv: any) => String(iv.promoter_name ?? '').trim() || (await ownerEntityName(db, iv.owner_id));

/** Tema curto de uma pergunta (margem do vídeo), quando a IA não deu um: o início da pergunta, cortado numa palavra. */
export function shortTopic(text: string, max = 44): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[?.!:;,]+$/, '');
  if (t.length <= max) return t;
  const cut = firstChars(t, max);
  return (cut.slice(0, cut.lastIndexOf(' ') > 12 ? cut.lastIndexOf(' ') : cut.length)).replace(/[,;:]$/, '') + '…';
}

/**
 * O que o vídeo editorial precisa além do episódio: o promotor, o tema de cada pergunta e as três ideias-chave de cada
 * resposta (da IA, a partir do guião em inglês aprovado: só resumem o que foi dito, nada se inventa) e se as respostas
 * foram escritas. Os tokens ficam registados no consumo da entrevista.
 */
export async function editorialPlan(db: Db, iv: any, ep: any, segs: EditorialSeg[]) {
  const script = ep.script_id ? await db.one('SELECT segments FROM scripts WHERE id=$1', [ep.script_id]) : null;
  const text = new Map<string, string>(((script?.segments ?? []) as any[]).map(x => [String(x.id), String(x.textEnglish ?? '')]));
  const items: { id: string; question: string; answer: string }[] = [];
  const answerOf = new Map<string, string>(); // pergunta → primeira resposta a seguir
  let lastQ: EditorialSeg | null = null;
  for (const s of segs) {
    if (s.kind === 'translated_question') lastQ = s;
    else if (s.kind === 'translated_answer' && text.get(s.id)) {
      items.push({ id: s.id, question: lastQ ? text.get(lastQ.id) ?? '' : '', answer: text.get(s.id)! });
      if (lastQ && !answerOf.has(lastQ.id)) answerOf.set(lastQ.id, s.id);
    }
  }
  const meter = newMeter();
  let kp = new Map<string, { topic: string; points: string[] }>();
  try { kp = await answerKeyPoints(items, meter); }
  catch (e: any) { console.error(`[video] ideias-chave indisponíveis: ${String(e?.message ?? e).slice(0, 200)}`); } // o vídeo sai sem elas
  finally {
    if (meter.input + meter.output > 0) await db.query('INSERT INTO usage_ledger(interview_id, kind, quantity, cost_usd, estimated) VALUES ($1,$2,$3,$4,true)', [iv.id, 'video_text_tokens', meter.input + meter.output, meterUsd(meter)]);
  }
  const fromEp = chapterTitles(segs, ep.chapters);
  const chapters = new Map<string, string>();
  for (const s of segs) if (s.kind === 'translated_question') {
    const a = answerOf.get(s.id);
    chapters.set(s.id, (a && kp.get(a)?.topic) || shortTopic(fromEp.get(s.id) ?? text.get(s.id) ?? ''));
  }
  const keyPoints = new Map<string, string[]>([...kp].map(([id, v]) => [id, v.points]));
  const qs = await db.query(`SELECT t.uploaded_via FROM questions q JOIN answers a ON a.question_id=q.id AND a.status='answered' JOIN answer_takes t ON t.id=a.selected_take_id WHERE q.interview_id=$1`, [iv.id]);
  const writtenAnswers = qs.length > 0 && qs.every((r: any) => r.uploaded_via === 'document');
  return { promoter: await promoterOf(db, iv), chapters, keyPoints, writtenAnswers };
}

/** Linhas de um texto para caber numa largura (aproximação pelo número médio de caracteres). */
function wrap(text: string, maxChars: number, maxLines = 3): string[] {
  const out: string[] = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      if ((line + ' ' + w).trim().length > maxChars && line) { out.push(line); line = w; } else line = (line + ' ' + w).trim();
    }
    out.push(line);
  }
  return out.slice(0, maxLines);
}

/** Marca do portal (símbolo e «quietinterview»), em coordenadas do vídeo. */
const logo = (x: number, y: number, s: number) => `<g transform="translate(${x} ${y}) scale(${s})">${MARK_PATHS(EDITORIAL.accent, EDITORIAL.bg)}</g>
<text x="${x + 94 * s}" y="${y + 44 * s}" font-family="${SANS}" font-size="${42 * s}" fill="${EDITORIAL.accent}">quiet<tspan fill="${EDITORIAL.ink}" font-weight="700">interview</tspan></text>`;

const svg = (w: number, h: number, body: string, bg?: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ''}${body}</svg>`);
const lines = (ls: string[], x: number, y: number, size: number, o: { family?: string; fill?: string; weight?: string; anchor?: string; gap?: number } = {}) =>
  ls.map((l, i) => `<text x="${x}" y="${y + i * size * (o.gap ?? 1.3)}" text-anchor="${o.anchor ?? 'middle'}" font-family="${o.family ?? SANS}" font-size="${size}" font-weight="${o.weight ?? 'normal'}" fill="${o.fill ?? EDITORIAL.ink}">${escXml(l)}</text>`).join('');

/** Cartão a toda a página (abertura, «conducted remotely», ideias-chave, final). */
export async function editorialCard(size: { w: number; h: number }, c: { title: string; sub?: string; footer?: string; footerAccent?: boolean; kicker?: string; dots?: { n: number; k: number } }): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const { w, h } = size, k = w / 1920;
  const t = wrap(c.title, 38, 3), sub = c.sub ? wrap(c.sub, 72, 5) : [];
  const ty = h * 0.36;
  const body = `${logo(90 * k, 65 * k, k)}
${c.kicker ? `<text x="${100 * k}" y="${285 * k}" font-family="${SANS}" font-size="${30 * k}" font-weight="700" fill="${EDITORIAL.muted}" letter-spacing="${2 * k}">${escXml(c.kicker.toUpperCase())}</text>` : ''}
${lines(t, w / 2, ty, (c.dots ? 88 : 72) * k, { family: SERIF })}
${lines(sub, w / 2, ty + t.length * 72 * k * 1.3 + 40 * k, 36 * k, { fill: EDITORIAL.muted, gap: 1.45 })}
${c.dots ? Array.from({ length: c.dots.n }, (_, n) => `<rect x="${w / 2 - (c.dots!.n * 100 * k) / 2 + n * 100 * k}" y="${h * 0.7}" width="${68 * k}" height="${8 * k}" rx="${4 * k}" fill="${n === c.dots!.k ? EDITORIAL.accent : EDITORIAL.line}"/>`).join('') : ''}
${c.footer ? `<text x="${w / 2}" y="${h * 0.86}" text-anchor="middle" font-family="${SANS}" font-size="${(c.footerAccent ? 40 : 26) * k}" font-weight="700" fill="${c.footerAccent ? EDITORIAL.accent : EDITORIAL.muted}" letter-spacing="${c.footerAccent ? 0 : 2 * k}">${escXml(c.footer)}</text>` : ''}`;
  return sharp(svg(w, h, body, EDITORIAL.bg)).png().toBuffer();
}

/** Camada transparente por cima do plano de quem fala: marca, identificação, tema da pergunta e o aviso de IA. */
async function overlayPng(size: { w: number; h: number }, o: { lower?: { name: string; role: string }; topic?: { n: number; total: number; title: string }; aiNotice?: boolean; raise?: boolean }) {
  const { default: sharp } = await import('sharp');
  const { w, h } = size, k = w / 1920, dy = o.raise ? 190 : 0; // com legendas na imagem, o rodapé sobe
  const body = `<rect x="${45 * k}" y="${35 * k}" width="${445 * k}" height="${98 * k}" rx="${10 * k}" fill="${EDITORIAL.bg}" fill-opacity=".9"/>${logo(62 * k, 53 * k, 0.83 * k)}
${o.lower ? `<rect x="${60 * k}" y="${(820 - dy) * k}" width="${1090 * k}" height="${150 * k}" fill="${EDITORIAL.bg}" fill-opacity=".95"/><rect x="${60 * k}" y="${(820 - dy) * k}" width="${9 * k}" height="${150 * k}" fill="${EDITORIAL.accent}"/>
<text x="${100 * k}" y="${(884 - dy) * k}" font-family="${SANS}" font-size="${48 * k}" font-weight="700" fill="${EDITORIAL.ink}">${escXml(o.lower.name)}</text>
<text x="${100 * k}" y="${(940 - dy) * k}" font-family="${SANS}" font-size="${30 * k}" fill="${EDITORIAL.muted}">${escXml(o.lower.role.slice(0, 70))}</text>` : ''}
${o.topic ? `<text x="${68 * k}" y="${340 * k}" font-family="${SANS}" font-size="${32 * k}" font-weight="700" fill="${EDITORIAL.accent}">${String(o.topic.n).padStart(2, '0')} / ${o.topic.total}</text>
${lines(wrap(o.topic.title, 16, 4), 68 * k, 420 * k, 54 * k, { family: SERIF, anchor: 'start', gap: 1.2 })}` : ''}
${o.aiNotice ? `<rect x="${w - 470 * k}" y="${o.raise ? 45 * k : h - 64 * k}" width="${440 * k}" height="${40 * k}" rx="${8 * k}" fill="${EDITORIAL.ink}" fill-opacity=".72"/><text x="${w - 250 * k}" y="${o.raise ? 73 * k : h - 36 * k}" text-anchor="middle" font-family="${SANS}" font-size="${22 * k}" fill="#fff">AI-generated video · AI voice</text>` : ''}`;
  return sharp(svg(w, h, body)).png().toBuffer();
}

/** Uma legenda (imagem transparente do tamanho do vídeo): faixa escura ao fundo, ao centro, até duas linhas. */
async function subtitlePng(size: { w: number; h: number }, text: string) {
  const { default: sharp } = await import('sharp');
  const { w, h } = size, k = w / 1920, fs = 46 * k;
  const ls = wrap(text, 50, 3);
  const bw = Math.min(w - 80 * k, Math.max(...ls.map(l => l.length)) * fs * 0.56 + 90 * k), bh = ls.length * fs * 1.3 + 34 * k;
  const y0 = h - 40 * k - bh;
  const body = `<rect x="${(w - bw) / 2}" y="${y0}" width="${bw}" height="${bh}" rx="${10 * k}" fill="#111" fill-opacity=".78"/>${ls.map((l, i) => `<text x="${w / 2}" y="${y0 + 17 * k + fs * (1 + i * 1.3) - fs * 0.22}" text-anchor="middle" font-family="${SANS}" font-size="${fs}" fill="#fff">${escXml(l)}</text>`).join('')}`;
  return sharp(svg(w, h, body)).png().toBuffer();
}

/** Plano de fundo de quem fala: fundo claro e a fotografia em altura total ao centro (ou as iniciais, sem fotografia). */
async function stageStill(size: { w: number; h: number }, photo: Buffer | null, name: string): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const { w, h } = size;
  if (!photo) {
    const ini = name.split(/\s+/).map(s => s[0] ?? '').join('').slice(0, 2).toUpperCase() || '·';
    return sharp(svg(w, h, `<circle cx="${w / 2}" cy="${h / 2}" r="${h * 0.22}" fill="${EDITORIAL.accent}"/><text x="${w / 2}" y="${h / 2 + h * 0.07}" text-anchor="middle" font-family="${SANS}" font-size="${h * 0.18}" font-weight="700" fill="#fff">${escXml(ini)}</text>`, EDITORIAL.stage)).jpeg({ quality: 90 }).toBuffer();
  }
  const img = await sharp(photo).rotate().resize({ height: h, width: w, fit: 'inside' }).toBuffer();
  const m = await sharp(img).metadata();
  return sharp(svg(w, h, '', EDITORIAL.stage)).composite([{ input: img, left: Math.round((w - (m.width ?? 0)) / 2), top: Math.round((h - (m.height ?? 0)) / 2) }]).jpeg({ quality: 90 }).toBuffer();
}

/** Som curto e discreto para os cartões sem fala (abertura e final), feito pelo FFmpeg (sem ficheiros de música). */
const chime = (ms: number) => `aevalsrc='0.05*(sin(2*PI*220*t)*exp(-1.6*t)+sin(2*PI*277.18*(t-0.75))*exp(-1.6*(t-0.75))*gte(t,0.75)+sin(2*PI*329.63*(t-1.5))*exp(-1.6*(t-1.5))*gte(t,1.5))':s=44100:d=${(ms / 1000).toFixed(3)}`;

/**
 * Monta o vídeo editorial. Devolve o MP4, a duração total, os capítulos no tempo do vídeo e o resumo do grafismo.
 * As partes: abertura (3 s, som discreto) → episódio, fala a fala (aviso inicial com o cartão «conducted remotely») → final.
 */
export async function editorialVideo(o: EditorialInput): Promise<{ mp4: Buffer; totalMs: number; chapters: { title: string; time: number }[]; meta: any }> {
  const { ffmpeg, size } = o, { w, h } = size;
  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-bf', '0', '-pix_fmt', 'yuv420p', '-r', '25', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2'];
  const host = o.people.host.name || 'the host', guest = o.people.guest.name || 'our guest';
  const questions = o.segs.filter(s => s.kind === 'translated_question');
  const total = questions.length;
  const seen = new Set<string>();
  const chapters: { title: string; time: number }[] = [];
  const meta = { style: 'editorial', size: `${w}x${h}`, lowerThirds: 0, topics: 0, keyPointCards: 0, animatedParts: 0, stillParts: 0, subtitles: 0 };
  const raise = !!o.cues?.length;
  // Legendas de um troço do episódio [a, b], em tempos locais (segundos), cortadas ao troço.
  const cuesIn = (a: number, b: number) => (o.cues ?? []).filter(c => c.endMs > a && c.startMs < b && c.text.trim())
    .map(c => ({ from: Math.max(0, c.startMs - a) / 1000, to: (Math.min(b, c.endMs) - a) / 1000, text: c.text }));
  return withTemp(async dir => {
    const audioIn = join(dir, 'ep.mp3');
    await writeFile(audioIn, o.audio);
    const files: string[] = [];
    let t = 0, n = 0;
    let curQ: EditorialSeg | null = null;
    const steps = o.segs.length + 2;
    // Parte de cartão (imagem fixa) com som do episódio [a, b] ou com o som discreto.
    const cardPart = async (png: Buffer, ms: number, epAudio?: [number, number]) => {
      const img = join(dir, `c${n}.png`), out = join(dir, `p${String(n).padStart(3, '0')}.mp4`);
      await writeFile(img, png);
      const d = (ms / 1000).toFixed(3);
      // Legendas por cima (só nos cartões com o som do episódio: o aviso inicial).
      const subIn: string[] = [];
      let vf = `[0:v]fade=t=in:d=0.25,fade=t=out:st=${Math.max(0, ms / 1000 - 0.3).toFixed(3)}:d=0.3[c0]`, cl = 'c0';
      if (epAudio) for (const [q, c] of cuesIn(epAudio[0], epAudio[1]).entries()) {
        const f = join(dir, `cs${n}_${q}.png`);
        await writeFile(f, await subtitlePng(size, c.text));
        subIn.push('-i', f); // uma só imagem: o overlay repete-a (sem descodificar fotograma a fotograma)
        vf += `;[${cl}][${q + 1}:v]overlay=0:0:eof_action=repeat:enable='between(t,${c.from.toFixed(3)},${c.to.toFixed(3)})'[cs${q}]`; cl = `cs${q}`; meta.subtitles++;
      }
      vf += `;[${cl}]format=yuv420p[v]`;
      const aIdx = 1 + subIn.length / 2;
      const aIn = epAudio ? ['-ss', (epAudio[0] / 1000).toFixed(3), '-t', d, '-i', audioIn] : ['-f', 'lavfi', '-i', chime(ms)];
      const r = await run(ffmpeg, ['-y', '-v', 'error', '-loop', '1', '-t', d, '-i', img, ...subIn, ...aIn, '-filter_complex', `${vf};[${aIdx}:a]apad,atrim=0:${d}[a]`, '-map', '[v]', '-map', '[a]', '-t', d, ...enc, out], 300_000);
      if (r.code !== 0) throw new Error('Falha num cartão do vídeo: ' + r.stderr.slice(-300));
      files.push(out); n++; t += ms;
    };
    await o.onProgress?.(0, steps);
    await cardPart(await editorialCard(size, { title: o.title, sub: `${host} in conversation with ${guest}`, footer: (o.promoter || 'QuietInterview').toUpperCase() }), OPEN_MS);
    for (const [i, s] of o.segs.entries()) {
      await o.onProgress?.(i + 1, steps);
      const ms = Math.max(40, s.endMs - s.startMs);
      if (s.kind === 'disclosure') {
        await cardPart(await editorialCard(size, { title: 'A real interview, conducted remotely.', sub: `${guest} received an invitation and answered the questions in their own time, ${o.writtenAnswers ? 'in writing' : 'through audio recordings'}.\nTranslated and narrated with AI-generated voices.` }), ms, [s.startMs, s.endMs]);
        continue;
      }
      const person = o.people[s.role];
      const lower = !seen.has(s.role) && !!person.name;
      seen.add(s.role);
      // O tema fica na margem durante a pergunta e as respostas a seguir (até à pergunta seguinte ou ao fim editorial).
      if (s.kind === 'translated_question') curQ = s;
      else if (s.kind !== 'translated_answer') curQ = null;
      const qn = curQ ? questions.indexOf(curQ) + 1 : 0;
      const topicTitle = curQ ? o.chapters.get(curQ.id) ?? '' : '';
      if (s.kind === 'translated_question') chapters.push({ title: topicTitle || `Question ${qn}`, time: Math.round(t / 10) / 100 });
      const clip = o.clip(s.id);
      const still = join(dir, `s${i}.jpg`), ov = join(dir, `o${i}.png`), out = join(dir, `p${String(n).padStart(3, '0')}.mp4`);
      await writeFile(still, await stageStill(size, o.photos[s.role], person.name));
      await writeFile(ov, await overlayPng(size, { lower: lower ? { name: person.name, role: person.role } : undefined, topic: qn && topicTitle ? { n: qn, total, title: topicTitle } : undefined, aiNotice: !!clip, raise }));
      if (lower) meta.lowerThirds++; if (s.kind === 'translated_question' && topicTitle) meta.topics++;
      const d = (ms / 1000).toFixed(3);
      const inputs = ['-loop', '1', '-t', d, '-i', still];
      let v = '[0:v]setsar=1,fps=25[base]';
      if (clip) {
        const cf = join(dir, `k${i}.mp4`);
        await writeFile(cf, await clip());
        inputs.push('-t', d, '-i', cf);
        // O clipe animado em altura total ao centro, sobre o fundo claro (a fotografia fixa fica por baixo, se for mais curto).
        v += `;[1:v]scale=-2:${h},setsar=1,fps=25[an];[base][an]overlay=(W-w)/2:0:eof_action=pass[base2]`;
        meta.animatedParts++;
      } else { v += ';[base]null[base2]'; meta.stillParts++; }
      const ovIdx = clip ? 2 : 1;
      inputs.push('-loop', '1', '-t', d, '-i', ov);
      const lowerEnd = Math.min(LOWER_EDITORIAL_MS, ms - 250) / 1000;
      // Identificação só nos primeiros segundos da primeira fala; o resto da camada (marca, tema, aviso) fica a fala toda.
      if (lower) {
        const ov2 = join(dir, `o${i}b.png`);
        await writeFile(ov2, await overlayPng(size, { topic: qn && topicTitle ? { n: qn, total, title: topicTitle } : undefined, aiNotice: !!clip, raise }));
        inputs.push('-loop', '1', '-t', d, '-i', ov2);
        v += `;[base2][${ovIdx}:v]overlay=0:0:enable='lt(t,${lowerEnd.toFixed(3)})'[l1];[l1][${ovIdx + 1}:v]overlay=0:0:enable='gte(t,${lowerEnd.toFixed(3)})'[l2]`;
      } else v += `;[base2][${ovIdx}:v]overlay=0:0[l2]`;
      let last = 'l2', idx = ovIdx + (lower ? 2 : 1);
      // Ideias-chave: três cartões seguidos a partir de ~35% de uma resposta longa (o som continua).
      const pts = s.kind === 'translated_answer' ? o.keyPoints.get(s.id) : undefined;
      const chapterOfAnswer = s.kind === 'translated_answer' ? [...o.segs].slice(0, i).reverse().find(x => x.kind === 'translated_question') : undefined;
      if (pts?.length === 3 && ms >= 20_000) {
        const qi = chapterOfAnswer ? questions.indexOf(chapterOfAnswer) + 1 : 0;
        const at = ms * 0.35 / 1000;
        for (const [k, p] of pts.entries()) {
          const nf = join(dir, `n${i}_${k}.png`);
          await writeFile(nf, await editorialCard(size, { title: p, kicker: qi ? `${String(qi).padStart(2, '0')}  /  ${chapterOfAnswer ? o.chapters.get(chapterOfAnswer.id) ?? '' : ''}` : undefined, dots: { n: 3, k } }));
          inputs.push('-loop', '1', '-t', d, '-i', nf);
          const a = at + k * NOTE_MS / 1000, b = a + NOTE_MS / 1000;
          v += `;[${last}][${idx}:v]overlay=0:0:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'[k${k}]`;
          last = `k${k}`; idx++;
        }
        meta.keyPointCards += 3;
      }
      // Legendas por último: ficam por cima de tudo (também dos cartões de ideias-chave).
      for (const [q, c] of cuesIn(s.startMs, s.endMs).entries()) {
        const f = join(dir, `sb${i}_${q}.png`);
        await writeFile(f, await subtitlePng(size, c.text));
        inputs.push('-i', f); // uma só imagem: o overlay repete-a
        v += `;[${last}][${idx}:v]overlay=0:0:eof_action=repeat:enable='between(t,${c.from.toFixed(3)},${c.to.toFixed(3)})'[sb${q}]`;
        last = `sb${q}`; idx++; meta.subtitles++;
      }
      v += `;[${last}]format=yuv420p[v]`;
      const r = await run(ffmpeg, ['-y', '-v', 'error', ...inputs, '-ss', (s.startMs / 1000).toFixed(3), '-t', d, '-i', audioIn,
        '-filter_complex', `${v};[${idx}:a]apad,atrim=0:${d}[a]`, '-map', '[v]', '-map', '[a]', '-t', d, ...enc, out], 600_000);
      if (r.code !== 0) throw new Error('Falha numa parte do vídeo: ' + r.stderr.slice(-300));
      files.push(out); n++; t += ms;
    }
    await o.onProgress?.(steps - 1, steps);
    await cardPart(await editorialCard(size, { title: `Produced by ${o.promoter || 'QuietInterview'}`, sub: `${o.promoter ? 'With the support of QuietInterview\n\n' : ''}Interview presented with ${o.animated ? 'animated portraits' : 'photos'} and synthetic English voices.`, footer: 'quietinterview.com', footerAccent: true }), CLOSE_MS);
    const list = join(dir, 'list.txt'), mp4 = join(dir, 'out.mp4');
    await writeFile(list, files.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
    const r = await run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', mp4], 600_000);
    if (r.code !== 0) throw new Error('Falha a juntar o vídeo: ' + r.stderr.slice(-300));
    return { mp4: await readFile(mp4), totalMs: t, chapters, meta };
  });
}
