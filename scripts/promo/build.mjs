// Monta o vídeo promocional a partir dos clipes do Flow e de um plano com cortes e legendas (plan.json).
// Uso (na raiz do repositório): node scripts/promo/build.mjs scripts/promo/plan.json <pasta-dos-clipes> <pasta-de-saída>
// Depois: copiar promo.mp4, promo.jpg e promo.en.vtt para public/video/ (a landing mostra a secção quando promo.mp4 existe).
// Saída: promo.mp4 (landing, legendas à parte), promo-subtitled.mp4 (legendas gravadas, para partilhar),
//        promo.en.vtt, promo.jpg (cartaz), report.json
// Os tempos das legendas (plan.json) foram medidos no envelope de energia da voz (banda 1,8–4 kHz) de cada clipe.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const PORTAL = process.cwd(); // correr na raiz do repositório
const FF = join(PORTAL, 'node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe');
const FP = join(PORTAL, 'node_modules/@ffprobe-installer/win32-x64/ffprobe.exe');
const W = 1280, H = 720, FPS = 24, SR = 48000;
// Segmentos intermédios sem desvios de sincronia (H.264 de alta qualidade + PCM em .mov); uma só codificação final para cada versão.
const ENC = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-bf', '0', '-g', String(FPS * 2), '-pix_fmt', 'yuv420p'];
const PCM = ['-c:a', 'pcm_s16le', '-ar', String(SR), '-ac', '2'];
const WEB = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '25', '-maxrate', '1100k', '-bufsize', '2200k', '-g', String(FPS * 2), '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0'];
const SHARE = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-maxrate', '2500k', '-bufsize', '5000k', '-g', String(FPS * 2), '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0'];
const AENC = ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aformat=sample_rates=48000:channel_layouts=stereo', '-c:a', 'aac', '-b:a', '128k', '-ar', String(SR), '-ac', '2'];

const fail = (m) => { console.error(m); process.exit(1); };
const [planArg, clipsArg, outArg] = process.argv.slice(2);
if (!planArg || !clipsArg || !outArg) fail('uso: node scripts/promo/build.mjs <plan.json> <pasta-dos-clipes> <pasta-de-saída>');
for (const bin of [FF, FP]) if (!existsSync(bin)) fail(`Não encontrei ${bin}: corra na raiz do repositório, depois de npm install.`);
const plan = JSON.parse(readFileSync(planArg, 'utf8'));
for (const c of plan.clips) if (!existsSync(join(clipsArg, c.file))) fail(`Clipe em falta: ${join(clipsArg, c.file)}`);
const sharp = createRequire(join(PORTAL, 'package.json'))('sharp');
const out = resolve(outArg), tmp = join(out, 'tmp');
mkdirSync(tmp, { recursive: true });

const run = (args) => {
  const r = spawnSync(FF, ['-hide_banner', '-y', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${String(r.error ?? '')}${String(r.stderr ?? '').slice(-2500)}`);
  return r;
};
const probe = (f, entries) => JSON.parse(spawnSync(FP, ['-v', 'error', ...entries, '-of', 'json', f], { encoding: 'utf8' }).stdout || '{}');
const dur = (f) => +(probe(f, ['-show_entries', 'format=duration']).format?.duration ?? NaN);
const t3 = (s) => { const ms = Math.round(s * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; };
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 1. Segmentos cortados ao fotograma, com o som exatamente do mesmo comprimento (as junções não acumulam desvios).
const cues = [], report = [];
let frames = 0;
plan.clips.forEach((c, i) => {
  const f = join(clipsArg, c.file), total = dur(f);
  if (!Number.isFinite(total)) fail(`Não consegui ler a duração de ${f}`);
  const f0 = Math.round(Math.max(0, c.start) * FPS), f1 = Math.round(Math.min(total, c.end) * FPS), n = f1 - f0;
  const start = f0 / FPS, len = n / FPS, at = frames / FPS;
  const vf = `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},fps=${FPS}${i === 0 ? ',fade=t=in:st=0:d=0.4' : ''}`;
  const af = `aresample=${SR},apad,atrim=end_sample=${Math.round(len * SR)},afade=t=in:st=0:d=0.05,afade=t=out:st=${(len - 0.15).toFixed(3)}:d=0.15`;
  run(['-ss', start.toFixed(4), '-i', f, '-frames:v', String(n), '-vf', vf, '-af', af, ...ENC, ...PCM, join(tmp, `seg${i + 1}.mov`)]);
  for (const [a, b, text] of c.cues) cues.push([at + Math.max(0, a - start), at + Math.min(len, b - start), text]);
  report.push({ clip: c.file, from: start, to: start + len, frames: n, at: +at.toFixed(3) });
  frames += n;
});
const cardAt = frames / FPS;

// 2. Cartão final: símbolo e nome, endereço e aviso de vídeo gerado por IA.
const MARK = `<rect x="2" y="2" width="76" height="56" rx="18" fill="#b4691f"/><path d="M18 56 L10 74 L34 56 Z" fill="#b4691f"/>` +
  `<rect x="21" y="25" width="5" height="12" rx="2.5" fill="#fffdf8"/><rect x="31" y="18" width="5" height="26" rx="2.5" fill="#fffdf8"/>` +
  `<rect x="41" y="22" width="5" height="18" rx="2.5" fill="#fffdf8"/><rect x="51" y="27" width="5" height="8" rx="2.5" fill="#fffdf8"/>`;
const card = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#f6f2ea"/>
<g transform="translate(347 226) scale(1.25)">${MARK}</g>
<text x="461" y="308" font-family="Segoe UI, Arial, sans-serif" font-size="74" font-weight="600" letter-spacing="-1"><tspan fill="#b4691f">quiet</tspan><tspan fill="#1c1a17">interview</tspan></text>
<text x="640" y="410" text-anchor="middle" font-family="Georgia, serif" font-size="34" fill="#1c1a17">Great interviews, recorded in your own time.</text>
<text x="640" y="468" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="30" font-weight="600" fill="#b4691f">${xml(plan.cardUrl ?? 'quietinterview.com')}</text>
<text x="640" y="650" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="26" fill="#4a453e">AI-generated video and voices. All people shown are fictional.</text></svg>`;
await sharp(Buffer.from(card)).png().toFile(join(tmp, 'card.png'));
const nSeg = plan.clips.length + 1, cardFrames = Math.round(plan.card * FPS);
run(['-loop', '1', '-framerate', String(FPS), '-i', join(tmp, 'card.png'), '-f', 'lavfi', '-i', `anullsrc=r=${SR}:cl=stereo`, '-frames:v', String(cardFrames),
  '-vf', 'format=yuv420p,fade=t=in:st=0:d=0.5', '-af', `atrim=end_sample=${Math.round((cardFrames / FPS) * SR)}`, ...ENC, '-tune', 'stillimage', ...PCM, join(tmp, `seg${nSeg}.mov`)]);
report.push({ clip: 'card', frames: cardFrames, at: +cardAt.toFixed(3) });
frames += cardFrames;
const total = frames / FPS;

// 3. Junta sem recodificar.
writeFileSync(join(tmp, 'list.txt'), Array.from({ length: nSeg }, (_, i) => `file '${join(tmp, `seg${i + 1}.mov`).replace(/\\/g, '/')}'`).join('\n'));
const joined = join(tmp, 'joined.mov');
run(['-f', 'concat', '-safe', '0', '-i', join(tmp, 'list.txt'), '-c', 'copy', joined]);

// 4. Aviso de IA gravado na imagem durante todos os clipes (como no produto: canto superior direito); legendas à parte e gravadas.
const notice = plan.notice ?? 'AI-generated video · AI voice';
const nw = Math.round(notice.length * 13.2) + 52;
await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="${W - 32 - nw}" y="30" width="${nw}" height="46" rx="23" fill="#000" fill-opacity="0.6"/>` +
  `<text x="${W - 32 - nw / 2}" y="61" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="24" fill="#fff">${xml(notice)}</text></svg>`)).png().toFile(join(tmp, 'notice.png'));
const withNotice = (outLabel) => `[0:v][1:v]overlay=0:0:enable='lt(t,${cardAt.toFixed(3)})'[${outLabel}]`;
run(['-i', joined, '-i', join(tmp, 'notice.png'), '-filter_complex', withNotice('v'), '-map', '[v]', '-map', '0:a', ...WEB, ...AENC, '-movflags', '+faststart', join(out, 'promo.mp4')]);

writeFileSync(join(out, 'promo.en.vtt'), 'WEBVTT\n\n' + cues.map(([a, b, s], i) => `${i + 1}\n${t3(a)} --> ${t3(b)}\n${s}\n`).join('\n'));
const wrap = (s, max = 46) => s.split(' ').reduce((ls, w) => { const l = ls[ls.length - 1]; if (l && (l + ' ' + w).length <= max) ls[ls.length - 1] = l + ' ' + w; else ls.push(w); return ls; }, []);
const subInputs = ['-i', join(tmp, 'notice.png')], chain = [withNotice('n')];
for (const [i, [a, b, s]] of cues.entries()) {
  const lines = wrap(s), lh = 46, boxH = lines.length * lh + 26, y0 = H - 56 - boxH;
  const boxW = Math.min(W - 80, Math.max(...lines.map(l => l.length)) * 17 + 64);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="${(W - boxW) / 2}" y="${y0}" width="${boxW}" height="${boxH}" rx="12" fill="#000" fill-opacity="0.58"/>` +
    lines.map((l, k) => `<text x="${W / 2}" y="${y0 + 13 + lh * (k + 1) - 12}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="34" font-weight="600" fill="#fff">${xml(l)}</text>`).join('') + '</svg>';
  const png = join(tmp, `cue${i + 1}.png`);
  await sharp(Buffer.from(svg)).png().toFile(png);
  subInputs.push('-i', png);
  chain.push(`[${i === 0 ? 'n' : `v${i}`}][${i + 2}:v]overlay=0:0:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'[v${i + 1}]`);
}
run(['-i', joined, ...subInputs, '-filter_complex', chain.join(';'), '-map', `[v${cues.length}]`, '-map', '0:a', ...SHARE, ...AENC, '-movflags', '+faststart', join(out, 'promo-subtitled.mp4')]);

// 5. Cartaz (fotograma do primeiro clipe, já com o aviso) e relatório, com verificação do número de fotogramas.
run(['-ss', '1.0', '-i', join(out, 'promo.mp4'), '-frames:v', '1', '-q:v', '3', join(out, 'promo.jpg')]);
const size = (f) => +(statSync(join(out, f)).size / 1048576).toFixed(2);
const vframes = (f) => +(probe(f, ['-select_streams', 'v', '-count_packets', '-show_entries', 'stream=nb_read_packets']).streams?.[0]?.nb_read_packets ?? NaN);
const rep = { total: +total.toFixed(3), frames, duration: +dur(join(out, 'promo.mp4')).toFixed(3), framesWeb: vframes(join(out, 'promo.mp4')), framesShare: vframes(join(out, 'promo-subtitled.mp4')),
  mb: { promo: size('promo.mp4'), subtitled: size('promo-subtitled.mp4'), poster: size('promo.jpg') }, cues: cues.length, clips: report };
writeFileSync(join(out, 'report.json'), JSON.stringify(rep, null, 2));
rmSync(tmp, { recursive: true, force: true });
console.log(JSON.stringify(rep, null, 2));
if (rep.framesWeb !== frames || rep.framesShare !== frames) fail(`Número de fotogramas diferente do previsto: ${rep.framesWeb}/${rep.framesShare} em vez de ${frames}`);
