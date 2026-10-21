// Mede o tempo e a memória da montagem do vídeo de um episódio de teste (sem IA, como em AI_MOCK): o mesmo código do
// trabalho (photoTimeline + buildAudioTrack + encodeComposite), com cartões, rodapés e capítulos.
// Uso: node scripts/medir-video.ts [minutos=10] [perguntas=10] [fotos|animado|ambos]
//   fotos   — episódio só com fotografias (planos fixos com legendas, como o plano Start/Pro);
//   animado — todas as falas como partes animadas de até 8 s (como um vídeo do Veo com tudo animado; clipes simulados).
// Mostra, para cada caso, o tempo, o pico de memória do Node e o pico de um processo FFmpeg (o servidor tem 512 MB),
// e o mesmo vídeo sem o grafismo, para comparar. A memória do FFmpeg lê-se de /proc (Linux) ou do Get-Process (Windows).
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as V from '../src/video.ts';
import * as G from '../src/graphics.ts';
import { composeCover } from '../src/cover.ts';

const [minArg, qArg, modeArg] = process.argv.slice(2);
const minutes = Number(minArg ?? 10), nQ = Number(qArg ?? 10), mode = modeArg ?? 'ambos';
const ffmpeg = process.env.FFMPEG_PATH || (await import('@ffmpeg-installer/ffmpeg')).default.path;
const { default: sharp } = await import('sharp');

/** Pico de memória dos processos FFmpeg enquanto `fn` corre (MB). */
async function ffmpegPeak<T>(fn: () => Promise<T>): Promise<{ r: T; peakMb: number }> {
  let peak = 0;
  if (process.platform === 'linux') {
    const t = setInterval(() => {
      for (const pid of readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
        try {
          const st = readFileSync(`/proc/${pid}/status`, 'utf8');
          if (!/^Name:\s*ffmpeg/m.test(st)) continue;
          const kb = Number(/VmHWM:\s*(\d+)/.exec(st)?.[1] ?? 0);
          peak = Math.max(peak, kb / 1024);
        } catch { /* o processo acabou entretanto */ }
      }
    }, 50);
    try { return { r: await fn(), peakMb: peak }; } finally { clearInterval(t); }
  }
  // Windows: um único PowerShell a vigiar (arrancar um por leitura seria lento demais).
  const stop = join(tmpdir(), `medir-${process.pid}.stop`);
  const ps = spawn('powershell', ['-NoProfile', '-Command', `$m=0; while(-not (Test-Path '${stop}')) { Get-Process ffmpeg -ErrorAction SilentlyContinue | ForEach-Object { if ($_.PeakWorkingSet64 -gt $m) { $m = $_.PeakWorkingSet64 } }; Start-Sleep -Milliseconds 50 }; Write-Output $m`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let out = '';
  ps.stdout.on('data', d => (out += d));
  const done = new Promise(r => ps.on('close', r));
  await new Promise(r => setTimeout(r, 1500)); // o PowerShell demora a arrancar
  let r: T;
  try { r = await fn(); } finally { writeFileSync(stop, ''); await done; rmSync(stop, { force: true }); }
  return { r, peakMb: Number(out.trim()) / 1024 / 1024 };
}

// ---- episódio sintético: aviso, apresentação, perguntas e respostas, agradecimento ----
const total = minutes * 60_000;
const timing: { id: string; role: 'host' | 'guest'; kind: string; startMs: number; durationMs: number }[] = [];
const pause = 450;
let t = 0;
const push = (id: string, role: 'host' | 'guest', kind: string, ms: number) => { timing.push({ id, role, kind, startMs: t, durationMs: ms }); t += ms + pause; };
push('disclosure', 'host', 'disclosure', 6500);
push('intro', 'host', 'editorial_intro', 7000);
const qMs = 7000, aMs = Math.max(4000, Math.round((total - t - 7000 - nQ * (qMs + 2 * pause)) / nQ));
for (let i = 1; i <= nQ; i++) { push(`q${i}`, 'host', 'translated_question', qMs); push(`a${i}`, 'guest', 'translated_answer', aMs); }
push('outro', 'host', 'editorial_outro', 7000);
const dur = t;
const words = 'we learned to listen to each other and to the people who use what we build every single day'.split(' ');
const cues = timing.flatMap(s => {
  const out: { id: string; startMs: number; endMs: number; text: string }[] = [];
  for (let a = s.startMs, k = 0; a < s.startMs + s.durationMs; a += 3000, k++) out.push({ id: `${s.id}-${k}`, startMs: a, endMs: Math.min(a + 2900, s.startMs + s.durationMs), text: words.slice(k % 6, (k % 6) + 9).join(' ') });
  return out;
});
const chapters = timing.filter(s => s.kind === 'translated_question').map((s, i) => ({ startMs: s.startMs, title: `Question number ${i + 1}: what changed most in your work over the last ten years, and why?` }));
const { cover } = await composeCover({ title: 'Building bridges between generations of engineers', subtitle: 'with Ana Costa', brand: 'quietinterview', background: null, photos: [] });
const face = await sharp({ create: { width: 900, height: 900, channels: 3, background: '#8a6f5c' } }).jpeg().toBuffer();
const people = { host: { name: 'Rui Matos', role: 'Editor' }, guest: { name: 'Ana Costa', role: 'Chief engineer, Lisbon' } };
const bases = await V.renderBases({ cover, title: 'Building bridges', brand: 'quietinterview', host: { ...people.host, photo: face }, guest: { ...people.guest, photo: face } });
const audio = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${(dur / 1000).toFixed(3)}`, '-b:a', '128k', '-f', 'mp3', 'pipe:1'], { maxBuffer: 1e9 }).stdout;
const shots = V.planShots(timing, dur, cues as any);
const frameFor = (s: V.Shot) => V.subtitleFrame((bases as any)[s.scene], s.text);
const clip = await V.mockTalkingClip(ffmpeg, face, 8000, false);
console.log(`Memória do Node antes de montar: ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
console.log(`Episódio de teste: ${(dur / 60000).toFixed(1)} min, ${nQ} perguntas, ${cues.length} legendas; FFmpeg ${ffmpeg}`);

async function caso(nome: string, animado: boolean) {
  // Partes no tempo do episódio: fixas, ou cada fala (menos o aviso) em partes animadas de até 8 s.
  const anims = animado ? timing.filter(s => s.kind !== 'disclosure').flatMap(s => {
    const out: { startMs: number; endMs: number }[] = [];
    const end = s.startMs + s.durationMs + pause;
    for (let a = s.startMs; a < end; a += 8000) out.push({ startMs: a, endMs: Math.min(a + 8000, end) });
    return out;
  }) : [];
  const layout = V.splitParts(anims, dur);
  const parts: V.Part[] = layout.map(l => l.kind === 'still'
    ? { kind: 'still', startMs: l.startMs, endMs: l.endMs, shots: V.shotsWithin(shots, l.startMs, l.endMs) }
    : { kind: 'anim', startMs: l.startMs, endMs: l.endMs, base: bases.animGuest, clip, notice: 'AI-generated video · AI voice', cues: cues.filter(c => c.endMs > l.startMs && c.startMs < l.endMs).map(c => ({ startMs: Math.max(c.startMs, l.startMs) - l.startMs, endMs: Math.min(c.endMs, l.endMs) - l.startMs, text: c.text })) });
  const t0 = Date.now();
  const sem = await ffmpegPeak(() => V.encodeComposite(ffmpeg, parts, frameFor, audio));
  const semMs = Date.now() - t0, semPeak = sem.peakMb, semNode = process.resourceUsage().maxRSS / 1024;
  const t1 = Date.now();
  const com = await ffmpegPeak(async () => {
    const tl = await G.photoTimeline({ parts, timing, durationMs: dur, audio, cover, title: 'Building bridges between generations of engineers', people, chapters, animated: new Set(animado ? timing.map(s => s.id) : []), subtitles: true });
    const track = await V.buildAudioTrack(ffmpeg, tl.audio);
    return { mp4: await V.encodeComposite(ffmpeg, tl.parts, frameFor, track, undefined, 'm4a', tl.overlays), tl };
  });
  const comMs = Date.now() - t1, comPeak = com.peakMb, comNode = process.resourceUsage().maxRSS / 1024;
  const f = join(tmpdir(), `medir-${process.pid}.mp4`);
  writeFileSync(f, com.r.mp4);
  const ffprobe = process.env.FFPROBE_PATH || (await import('@ffprobe-installer/ffprobe')).default.path;
  const vdur = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout.toString().trim();
  if (existsSync(f)) rmSync(f);
  console.log(`\n${nome}: ${parts.length} partes, grafismo ${JSON.stringify(com.r.tl.meta)}, vídeo de ${Number(vdur).toFixed(1)} s (${(com.r.mp4.length / 1e6).toFixed(1)} MB)`);
  console.log(`  sem grafismo: ${(semMs / 1000).toFixed(1)} s; pico de um FFmpeg ${semPeak.toFixed(0)} MB; pico do Node até aqui ${semNode.toFixed(0)} MB`);
  console.log(`  com cartões, rodapés e capítulos: ${(comMs / 1000).toFixed(1)} s; pico de um FFmpeg ${comPeak.toFixed(0)} MB; pico do Node até aqui ${comNode.toFixed(0)} MB`);
}
if (mode === 'fotos' || mode === 'ambos') await caso('Só fotografias', false);
if (mode === 'animado' || mode === 'ambos') await caso('Animado (todas as falas)', true);
const ru = process.resourceUsage();
console.log(`\nNode: pico de memória ${(ru.maxRSS / 1024).toFixed(0)} MB; CPU do Node ${((ru.userCPUTime + ru.systemCPUTime) / 1e6).toFixed(1)} s`);
