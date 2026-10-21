import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as G from '../src/graphics.ts';
import * as V from '../src/video.ts';

const W = 1280, H = 720;

test('grafismo: rodapé na 1.ª fala de cada um no seu plano, sem passar a fala; capítulo por pergunta', () => {
  const spans: G.GfxSpan[] = [
    { id: 'disclosure', role: 'host', kind: 'disclosure', startMs: 0, endMs: 5000, personShot: false },
    { id: 'intro', role: 'host', kind: 'editorial_intro', startMs: 9000, endMs: 13000, personShot: false }, // estúdio: já mostra os nomes
    { id: 'q1', role: 'host', kind: 'translated_question', startMs: 13000, endMs: 17010, personShot: true },
    { id: 'a1', role: 'guest', kind: 'translated_answer', startMs: 17010, endMs: 18200, personShot: true }, // curta demais para o rodapé
    { id: 'q2', role: 'host', kind: 'translated_question', startMs: 18200, endMs: 21000, personShot: true },
    { id: 'a2', role: 'guest', kind: 'translated_answer', startMs: 21000, endMs: 40000, personShot: true },
    { id: 'outro', role: 'host', kind: 'editorial_outro', startMs: 40000, endMs: 43000, personShot: false },
  ];
  const q = new Map([['q1', 'What changed most in your first ten years at the company, and what stayed exactly the same?'], ['q2', 'Why?']]);
  const p = G.planGraphics(spans, id => q.get(id), 43000);
  const host = p.lowers.find(l => l.role === 'host')!, guest = p.lowers.find(l => l.role === 'guest')!;
  assert.deepEqual([host.startMs, host.endMs], [13400, 16880], 'entrevistador: na 1.ª pergunta, até ao fim da fala (não no aviso nem no estúdio)');
  assert.deepEqual([guest.startMs, guest.endMs], [21400, 26400], 'convidado: a 1.ª resposta é curta demais; entra na seguinte, 5 s');
  for (const l of p.lowers) for (const s of spans) if (l.startMs < s.endMs && l.endMs > s.startMs) assert.equal(s.role, l.role, 'o rodapé nunca fica por cima de outra pessoa');
  for (const l of [host, guest]) assert.ok(l.startMs % 40 === 0 && l.endMs % 40 === 0, 'em fotogramas inteiros');
  assert.deepEqual(p.chapters.map(c => [c.n, c.startMs, c.endMs]), [[1, 13200, 18000], [2, 18400, 23200]], 'até 200 ms antes do capítulo seguinte');
  assert.match(p.chapters[0].text, /…$/); assert.ok(p.chapters[0].text.length <= 64); assert.equal(p.chapters[1].text, 'Why?');
  assert.equal(G.shortText('Uma pergunta muito comprida sobre muitas coisas diferentes', 30), 'Uma pergunta muito comprida…');
});

test('grafismo: o rodapé fica acima da zona das legendas gravadas; o capítulo não toca no aviso de IA', async () => {
  const sharp = (await import('sharp')).default;
  assert.ok(G.lowerY(true) + G.LOWER_H <= V.SUBS_TOP - 8, 'acima da caixa de legendas de 3 linhas');
  assert.equal(V.SUBS_TOP, H - (3 * 46 + 30) - 36, 'a mesma geometria das legendas gravadas');
  assert.ok(G.lowerY(false) + G.LOWER_H <= H - 40, 'sem legendas: junto ao fundo, dentro da imagem');
  const lt = await sharp(await G.lowerThirdPng('Maria Antónia Figueiredo de Albuquerque e Castro', 'Chief engineer and head of the Lisbon regional office')).metadata();
  assert.equal(lt.height, G.LOWER_H); assert.ok(lt.width! <= 760);
  const ch = await sharp(await G.chapterPng(12, G.shortText('What changed most in your first ten years at the company, and what stayed exactly the same over all that time?', 64))).metadata();
  const notice = Math.max(336, Math.round('AI-generated video · AI voice'.length * 11.5) + 48);
  assert.ok(G.GFX_X + ch.width! < W - 36 - notice, 'o título de capítulo acaba antes do aviso «AI-generated video»');
  assert.ok(G.CHAPTER_Y + ch.height! < G.lowerY(true), 'capítulo e rodapé não se tocam');
  assert.deepEqual(G.peopleOf({ host_name: 'Rui', host_title: '', guest_name: 'Ana', guest_title: 'Chef, Lisboa' }), { host: { name: 'Rui', role: 'Host' }, guest: { name: 'Ana', role: 'Chef, Lisboa' } });
});

test('cartões: título a seguir ao aviso (a parte fixa divide-se), o resto desliza, cartão final no fim', () => {
  const card = { bg: Buffer.alloc(0), glow: Buffer.alloc(0), layers: [] };
  const parts: any[] = [
    { kind: 'still', startMs: 0, endMs: 9000, shots: [{ startMs: 0, endMs: 5000, scene: 'cover', text: '' }, { startMs: 5000, endMs: 9000, scene: 'studio', text: 'x' }] },
    { kind: 'anim', startMs: 9000, endMs: 12000, cues: [{ startMs: 0, endMs: 1000, text: 'a' }] },
    { kind: 'still', startMs: 12000, endMs: 15000, shots: [{ startMs: 12000, endMs: 15000, scene: 'guest', text: '' }] },
  ];
  const r = G.insertCards(parts, 5000, card, card);
  assert.equal(r.at, 5000);
  assert.deepEqual(r.parts.map(p => [p.kind, p.startMs, p.endMs]), [['still', 0, 5000], ['card', 5000, 9000], ['still', 9000, 13000], ['anim', 13000, 16000], ['still', 16000, 19000], ['card', 19000, 23000]]);
  assert.deepEqual((r.parts[2] as any).shots.map((s: any) => [s.scene, s.startMs, s.endMs]), [['studio', 9000, 13000]]);
  assert.deepEqual((r.parts[3] as any).cues, [{ startMs: 0, endMs: 1000, text: 'a' }], 'legendas da parte animada são relativas a ela');
  assert.equal(G.insertCards(parts, 10000, card, card).at, 9000, 'nunca dentro de uma parte animada: antes dela');
});

/** Fotograma em tons de cinzento (luma) no instante t. */
function gray(ffmpeg: string, f: string, t: number): Buffer {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-ss', t.toFixed(3), '-i', f, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { maxBuffer: 1e8 });
  assert.equal(r.stdout.length, W * H, `fotograma em ${t}`);
  return r.stdout;
}
const region = (img: Buffer, x0: number, y0: number, x1: number, y1: number) => {
  let bright = 0, sum = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = img[y * W + x]; if (v > 200) bright++; sum += v; n++; }
  return { bright, mean: sum / n };
};
const meanDiff = (a: Buffer, b: Buffer, x0: number, y0: number, x1: number, y1: number) => {
  let d = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { d += Math.abs(a[y * W + x] - b[y * W + x]); n++; }
  return d / n;
};

test('vídeo com cartões e grafismo (FFmpeg real): duração, texto no cartão, fundo em movimento, rodapé e capítulo; tempo e memória', async () => {
  const sharp = (await import('sharp')).default;
  const { composeCover } = await import('../src/cover.ts');
  const ffmpeg = (await import('@ffmpeg-installer/ffmpeg')).default.path, ffprobe = (await import('@ffprobe-installer/ffprobe')).default.path;
  const { cover } = await composeCover({ title: 'Building bridges between generations', subtitle: 'with Ana Costa', brand: 'quietinterview', background: null, photos: [] });
  const face = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#7a6a5a' } }).jpeg().toBuffer();
  const people = { host: { name: 'Rui Matos', role: 'Editor' }, guest: { name: 'Ana Costa', role: 'Chief engineer' } };
  const bases = await V.renderBases({ cover, title: 'Building bridges', brand: 'quietinterview', host: { ...people.host, photo: face }, guest: { ...people.guest, photo: null } });
  const timing = [
    { id: 'disclosure', role: 'host', kind: 'disclosure', startMs: 0, durationMs: 2000 },
    { id: 'intro', role: 'host', kind: 'editorial_intro', startMs: 2800, durationMs: 2000 },
    { id: 'q1', role: 'host', kind: 'translated_question', startMs: 5050, durationMs: 2600 },
    { id: 'a1', role: 'guest', kind: 'translated_answer', startMs: 8100, durationMs: 4000 },
    { id: 'outro', role: 'host', kind: 'editorial_outro', startMs: 12550, durationMs: 1500 },
  ] as const;
  const dur = 14300;
  const cues = [{ startMs: 5050, endMs: 7600, text: 'What changed most in your first ten years?' }, { startMs: 8100, endMs: 12100, text: 'Mostly the way we listen to each other.' }];
  const shots = V.planShots(timing as any, dur, cues as any);
  const audio = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${dur / 1000}`, '-f', 'mp3', 'pipe:1'], { maxBuffer: 1e8 }).stdout;
  const clip = await V.mockTalkingClip(ffmpeg, face, 4500, false);
  // a resposta do convidado é uma parte animada (como nos episódios animados); o resto são fotografias
  const parts: V.Part[] = V.splitParts([{ startMs: 8100, endMs: 12550 }], dur).map(l => l.kind === 'still'
    ? { kind: 'still', startMs: l.startMs, endMs: l.endMs, shots: V.shotsWithin(shots, l.startMs, l.endMs) }
    : { kind: 'anim', startMs: l.startMs, endMs: l.endMs, base: bases.animGuest, clip, notice: 'AI-generated video · AI voice', cues: cues.filter(c => c.endMs > l.startMs && c.startMs < l.endMs).map(c => ({ startMs: c.startMs - l.startMs, endMs: Math.min(c.endMs, l.endMs) - l.startMs, text: c.text })) });
  const rss0 = process.memoryUsage().rss, t0 = Date.now();
  const tl = await G.photoTimeline({ parts, timing: timing as any, durationMs: dur, audio, cover, title: 'Building bridges between generations', people, chapters: [{ startMs: 5050, title: 'What changed most in your first ten years at the company?' }], animated: new Set(['a1']), subtitles: true });
  const track = await V.buildAudioTrack(ffmpeg, tl.audio);
  const mp4 = await V.encodeComposite(ffmpeg, tl.parts, s => V.subtitleFrame((bases as any)[s.scene], s.text), track, undefined, 'm4a', tl.overlays);
  const ms = Date.now() - t0, rssMb = (process.memoryUsage().rss - rss0) / 1e6;
  console.log(`[grafismo] ${(tl.totalMs / 1000).toFixed(1)} s de vídeo em ${ms} ms; memória do processo +${rssMb.toFixed(0)} MB`);
  assert.ok(ms < 120_000, `tempo de renderização ${ms} ms`);
  assert.ok(rssMb < 250, `memória do processo +${rssMb} MB`);
  assert.deepEqual(tl.meta, { titleCard: true, endCard: true, lowerThirds: 2, chapters: 1 });

  const dir = mkdtempSync(join(tmpdir(), 'pe-gfx-'));
  try {
    const f = join(dir, 'v.mp4'); writeFileSync(f, mp4);
    // duração: episódio + cartão de título + cartão final, imagem e som iguais, fotogramas inteiros
    assert.equal(tl.totalMs, 14320 + G.TITLE_CARD_MS + G.END_CARD_MS);
    const probe = (sel: string, what: string) => spawnSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', sel, '-show_entries', `stream=${what}`, '-of', 'csv=p=0', f]).stdout.toString().trim();
    assert.equal(Number(probe('v:0', 'nb_read_frames')), tl.totalMs / 40);
    assert.ok(Math.abs(parseFloat(probe('a:0', 'duration')) - tl.totalMs / 1000) < 0.08, 'som com a duração da imagem');

    // cartão de título (de 2,8 s a 6,8 s): o fundo sozinho (0,45 s, antes de o título entrar) não tem texto; aos 2,5 s tem
    const card = tl.parts.find(p => p.kind === 'card')!;
    assert.equal(card.startMs, 2800, 'logo a seguir ao aviso inicial');
    const bgOnly = gray(ffmpeg, f, (card.startMs + 450) / 1000), withText = gray(ffmpeg, f, (card.startMs + 2500) / 1000);
    const band = (img: Buffer) => region(img, 200, 230, 1080, 400);
    assert.ok(band(bgOnly).bright < 50, `fundo sem texto: ${band(bgOnly).bright} píxeis claros`);
    assert.ok(band(withText).bright > 3000, `título no cartão: ${band(withText).bright} píxeis claros`);
    // o fundo mexe: dois instantes do cartão, nas margens (sem texto)
    const later = gray(ffmpeg, f, (card.startMs + 3400) / 1000);
    const early = gray(ffmpeg, f, (card.startMs + 1000) / 1000);
    const moved = (meanDiff(early, later, 0, 0, 240, H) + meanDiff(early, later, W - 240, 0, W, H)) / 2; // margens sem texto
    assert.ok(moved > 1.5, `o fundo do cartão mexe entre dois instantes (diferença média ${moved.toFixed(2)})`);

    // cartão final com texto
    const end = tl.parts[tl.parts.length - 1];
    assert.equal(end.kind, 'card'); assert.equal(end.endMs, tl.parts[tl.parts.length - 1].startMs + G.END_CARD_MS);
    assert.ok(region(gray(ffmpeg, f, (end.startMs + 2600) / 1000), 300, 200, 980, 420).bright > 2000, 'agradecimento e marca no cartão final');

    // rodapé do entrevistador (1.ª pergunta) e título de capítulo: aparecem e desaparecem; nunca na zona das legendas
    const lower = tl.overlays.find(o => o.y === G.lowerY(true) && o.startMs < 12000)!, chap = tl.overlays.find(o => o.y === G.CHAPTER_Y)!;
    const lBox = (img: Buffer) => region(img, G.GFX_X + 20, G.lowerY(true) + 20, G.GFX_X + 220, G.lowerY(true) + 60).bright;
    const before = gray(ffmpeg, f, (lower.startMs - 200) / 1000), during = gray(ffmpeg, f, (lower.startMs + 1500) / 1000);
    assert.ok(lBox(before) < 30 && lBox(during) > 300, `rodapé com o nome: ${lBox(before)} → ${lBox(during)}`);
    const cBox = (img: Buffer) => region(img, G.GFX_X + 20, G.CHAPTER_Y + 50, G.GFX_X + 420, G.CHAPTER_Y + 110).bright;
    assert.ok(cBox(gray(ffmpeg, f, (chap.startMs + 1500) / 1000)) > 300, 'título de capítulo');
    assert.ok(cBox(gray(ffmpeg, f, (chap.endMs + 600) / 1000)) < 30, 'o capítulo sai');
    // a legenda continua por baixo do rodapé, intacta: a zona das legendas é igual à do vídeo sem grafismo
    const plain = await V.encodeComposite(ffmpeg, tl.parts, s => V.subtitleFrame((bases as any)[s.scene], s.text), track, undefined, 'm4a');
    const g2 = join(dir, 'p.mp4'); writeFileSync(g2, plain);
    const tSub = (lower.startMs + 1500) / 1000;
    const subDiff = meanDiff(during, gray(ffmpeg, g2, tSub), 0, V.SUBS_TOP, W, H);
    console.log(`[grafismo] fundo do cartão: diferença média ${moved.toFixed(2)}; zona das legendas com e sem grafismo: ${subDiff.toFixed(2)}`);
    assert.ok(subDiff < 1.5, `nada do grafismo na zona das legendas (diferença média ${subDiff.toFixed(2)})`);
    assert.ok(region(during, 100, V.SUBS_TOP + 60, 1180, H - 40).bright > 500, 'a legenda está lá');

    // parte animada do convidado: rodapé dele por cima do clipe, com o aviso de IA
    const gl = tl.overlays.find(o => o.y === G.lowerY(true) && o !== lower)!;
    assert.ok(gl.startMs >= 8100 + G.TITLE_CARD_MS, 'na resposta do convidado');
    assert.ok(lBox(gray(ffmpeg, f, (gl.startMs + 1500) / 1000)) > 300, 'rodapé do convidado sobre a parte animada');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** Fotograma RGB no instante t (os testes da gama de cor e do grafismo por fotograma). */
function rgb(ffmpeg: string, f: string, t: number): Buffer {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-ss', t.toFixed(3), '-i', f, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1e8 });
  assert.equal(r.stdout.length, W * H * 3, `fotograma em ${t}`);
  return r.stdout;
}
const meanRgb = (img: Buffer, x0: number, y0: number, x1: number, y1: number) => {
  const s = [0, 0, 0]; let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { for (let c = 0; c < 3; c++) s[c] += img[(y * W + x) * 3 + c]; n++; }
  return s.map(v => v / n);
};

test('composição de estúdio: o nome e a função ficam por cima do microfone e leem-se', async () => {
  const sharp = (await import('sharp')).default;
  const S = V.STUDIO;
  assert.ok(S.nameY - 28 * 0.8 > S.top + S.P, 'o nome começa abaixo das fotografias');
  assert.ok(S.roleY + S.roleSize * 0.3 < S.micTop, 'a função acaba antes do microfone');
  const cover = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#2a3a4a' } }).jpeg().toBuffer();
  const bases = await V.renderBases({ cover, title: 'Estúdio', brand: 'quietinterview', host: { name: 'Rui Matos', role: 'Editor-in-chief, Lisbon Radio', photo: null }, guest: { name: 'Ana Costa', role: '', photo: null } });
  const { data } = await sharp(bases.studio).raw().toBuffer({ resolveWithObject: true });
  const left = (W - (S.P * 2 + S.gap)) / 2;
  for (const cx of [left + S.P / 2, left + S.P + S.gap + S.P / 2]) {
    // na faixa da função, ao centro (onde estava o microfone claro), há texto claro e nenhum píxel cor de microfone
    let mic = 0, light = 0;
    for (let y = S.roleY - 14; y < S.roleY + 4; y++) for (let x = Math.round(cx) - 12; x < Math.round(cx) + 12; x++) {
      const i = (y * W + x) * 3, [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (Math.abs(r - 232) < 16 && Math.abs(g - 224) < 16 && Math.abs(b - 212) < 16 && r - b >= 10) mic++;
      if (r > 150 && g > 150 && b > 150) light++;
    }
    assert.ok(mic < 5, `sem microfone por baixo da função (${mic} píxeis)`);
    assert.ok(light > 10, `a função lê-se ao centro (${light} píxeis claros)`);
  }
});

test('grafismo sobre partes fixas: branco 255 e preto 0 (gama de cor certa) e sem falhar um fotograma num corte fora da grelha', async () => {
  const sharp = (await import('sharp')).default;
  const ffmpeg = (await import('@ffmpeg-installer/ffmpeg')).default.path;
  const gray = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 128, g: 128, b: 128 } } }).jpeg({ quality: 95 }).toBuffer();
  // grafismo opaco: metade branca, metade preta, e uma faixa vermelha
  const png = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><rect width="150" height="100" fill="#fff"/><rect x="150" width="150" height="100" fill="#000"/><rect y="100" width="300" height="50" fill="#f00"/></svg>`)).png().toBuffer();
  const overlays: V.Overlay[] = [{ startMs: 400, endMs: 2400, x: 100, y: 100, png }];
  const shots = (a: number, b: number): V.Shot[] => [{ startMs: a, endMs: b, scene: 'cover', text: '' }];
  // duas partes fixas cortadas fora da grelha de 40 ms (como os cortes por legenda dos retratos animados)
  const parts: V.Part[] = [{ kind: 'still', startMs: 0, endMs: 1010, shots: shots(0, 1010) }, { kind: 'still', startMs: 1010, endMs: 3000, shots: shots(1010, 3000) }];
  const audio = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '3', '-f', 'mp3', 'pipe:1'], { maxBuffer: 1e8 }).stdout;
  const mp4 = await V.encodeComposite(ffmpeg, parts, async () => gray, audio, undefined, 'mp3', overlays);
  const dir = mkdtempSync(join(tmpdir(), 'pe-gfx2-'));
  try {
    const f = join(dir, 'v.mp4'); writeFileSync(f, mp4);
    const img = rgb(ffmpeg, f, 1.5);
    const white = meanRgb(img, 120, 130, 230, 190), black = meanRgb(img, 280, 130, 390, 190), bg = meanRgb(img, 700, 400, 900, 600);
    assert.ok(white.every(v => v >= 248), `branco do grafismo: ${white.map(Math.round)}`);
    assert.ok(black.every(v => v <= 8), `preto do grafismo: ${black.map(Math.round)}`);
    assert.ok(bg.every(v => Math.abs(v - 128) <= 4), `fundo: ${bg.map(Math.round)}`);
    // o 1.º fotograma da 2.ª parte (fotograma 25, 1,00 s) tem o grafismo, como o anterior e o seguinte
    for (const t of [0.98, 1.02, 1.06]) {
      const red = meanRgb(rgb(ffmpeg, f, t), 120, 210, 380, 240);
      assert.ok(red[0] > 200 && red[1] < 60, `grafismo presente em ${t} s: ${red.map(Math.round)}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rodapé e capítulo: a caixa mede o texto desenhado (maiúsculas e siglas não ficam cortadas na margem direita)', async () => {
  const sharp = (await import('sharp')).default;
  /** Coluna mais à direita com texto claro (o fundo da caixa é escuro); -1 se não houver. */
  const lastTextCol = async (png: Buffer, y0: number) => {
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let last = -1;
    for (let y = y0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      if (data[i] > 170 && data[i + 1] > 140 && data[i + 3] > 200) last = Math.max(last, x);
    }
    return { last, width: info.width };
  };
  for (const text of ['WHAT CHANGED MOST IN YOUR WORK AND', 'How did the new EU CSRD and ESG rules change your job?']) {
    const png = await G.chapterPng(3, text);
    const { last, width } = await lastTextCol(png, 52);
    assert.ok(last > 0 && last <= width - 20, `«${text}»: texto até ${last} numa caixa de ${width} px`);
  }
  for (const [name, role] of [['MARGARIDA MONTEIRO WAGNER', 'CEO, EDP RENOVÁVEIS'], ['Ana', 'Host']]) {
    const png = await G.lowerThirdPng(name, role);
    const { last, width } = await lastTextCol(png, 10);
    assert.ok(last > 0 && last <= width - 20, `«${name}»: texto até ${last} numa caixa de ${width} px`);
    assert.ok(width <= 760);
  }
  // texto que não cabe na largura máxima: cortado com reticências, nunca a meio de uma letra
  const long = await G.lowerThirdPng('WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW', 'Role');
  const m = await lastTextCol(long, 10);
  assert.ok(m.width <= 760 && m.last <= m.width - 20, `nome muito largo: texto até ${m.last} em ${m.width} px`);
});
