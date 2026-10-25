import type { Handler } from './jobs.ts';
import { config } from './config.ts';
import { storage } from './storage.ts';
import { saveAsset } from './media.ts';
import { veoSubmit, veoAwait, veoEpisodePrompt } from './talking.ts';
import { chunkText, startImage } from './veo-episode.ts';
import { mockTalkingClip } from './video.ts';

/**
 * Laboratório — diagnóstico do filtro da Google numa fotografia real do entrevistado (só administradores; o entrevistado
 * autorizou o vídeo por IA nessa entrevista). A mesma frase curta (4 s) com variações do pedido, para saber o que faz a
 * Google recusar a fotografia (código 15236754, «semelhança com uma pessoa conhecida»). Os clipes bloqueados não são
 * cobrados; cada clipe que passa custa ~0,40 $ (Fast) ou ~1,60 $ (modelo normal).
 */
export const veoFilterProbe: Handler = async (job, { db, progress }) => {
  const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [job.input.interviewId]);
  if (!iv) throw new Error('Entrevista inexistente');
  const consent = async (p: string) => !!(await db.one(`SELECT granted FROM consents WHERE interview_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`, [iv.id, p]))?.granted;
  if (!(await consent('ai_video'))) throw new Error('O entrevistado desta entrevista não autorizou o vídeo por IA.');
  const photos = await db.query(`SELECT p.id, a.storage_key FROM photos p JOIN assets a ON a.id=p.asset_id WHERE p.interview_id=$1 AND a.deleted_at IS NULL ORDER BY (p.id = $2) DESC, p.created_at`, [iv.id, iv.guest_photo_id ?? null]);
  if (!photos.length) throw new Error('A entrevista não tem fotografias do entrevistado.');
  const script = await db.one(`SELECT segments FROM scripts WHERE interview_id=$1 AND status<>'superseded' ORDER BY revision DESC LIMIT 1`, [iv.id]);
  const seg = (script?.segments ?? []).find((s: any) => s.speakerRole === 'guest' && String(s.textEnglish ?? '').trim());
  const text = (seg ? chunkText(String(seg.textEnglish))[0] : '') || 'Thank you for having me. It is a pleasure to be here.';
  const voice = iv.guest_voice === 'female' ? 'female' : 'male';
  const sharp = (await import('sharp')).default;
  const main = await storage.get(photos[0].storage_key);
  const plain = `A ${voice === 'male' ? 'man' : 'woman'} speaks calmly to the camera in a bright office and says, in English, exactly: "${text.replace(/"/g, "'")}" Natural ${voice} voice, steady pace. No text on screen, no music.`;
  // Plano aberto: a fotografia mais pequena sobre uma versão desfocada e ampliada dela (a cara ocupa menos do quadro).
  const wide = async (img: Buffer) => {
    const bg = await sharp(img).resize(1280, 720, { fit: 'cover' }).blur(30).jpeg().toBuffer();
    const fg = await sharp(img).resize({ height: 520 }).jpeg().toBuffer();
    const m = await sharp(fg).metadata();
    return sharp(bg).composite([{ input: fg, left: Math.round((1280 - (m.width ?? 520)) / 2), top: 150 }]).jpeg({ quality: 90 }).toBuffer();
  };
  const current = veoEpisodePrompt({ role: 'guest', text, voice });
  const variants: { id: string; label: string; image: () => Promise<Buffer>; prompt: string; lab?: any; usd: number }[] = [
    { id: 'atual', label: 'Como na produção (pedido e recorte atuais)', image: async () => (await startImage(main)).image, prompt: current, usd: 0.4 },
    { id: 'simples', label: 'Pedido simples (sem «podcast», «entrevista» nem «convidado»)', image: async () => (await startImage(main)).image, prompt: plain, usd: 0.4 },
    { id: 'aberto', label: 'Plano mais aberto (cara mais pequena no quadro)', image: () => wide(main), prompt: current, usd: 0.4 },
    { id: 'standard', label: 'Modelo Veo 3.1 normal (não o Fast)', image: async () => (await startImage(main)).image, prompt: current, lab: { model: 'veo-3.1-generate-001' }, usd: 1.6 },
    { id: 'allow_all', label: 'Geração de pessoas «allow_all»', image: async () => (await startImage(main)).image, prompt: current, lab: { personGeneration: 'allow_all' }, usd: 0.4 },
    { id: 'referencia', label: 'Fotografia como referência (sem imagem inicial), modelo normal', image: async () => (await startImage(main)).image, prompt: plain.replace(/^A (man|woman)/, 'The $1 from the reference image'), lab: { model: 'veo-3.1-generate-001', reference: true }, usd: 1.6 },
    ...photos.slice(1).map((p: any, k: number) => ({ id: `foto${k + 2}`, label: `Outra fotografia do entrevistado (${k + 2}.ª)`, image: async () => (await startImage(await storage.get(p.storage_key))).image, prompt: current, usd: 0.4 })),
  ];
  const results: any[] = job.result?.results ?? [];
  for (const [k, v] of variants.entries()) {
    if (results.some(r => r.id === v.id)) continue;
    await progress(5 + Math.round((k / variants.length) * 90), 100, `${v.label}: a pedir à Google`);
    const t0 = Date.now();
    try {
      const image = await v.image();
      let video: Buffer;
      if (config.openai.mock) video = await mockTalkingClip(process.env.FFMPEG_PATH || (await import('@ffmpeg-installer/ffmpeg')).default.path, image, 4000);
      else { const s = await veoSubmit({ image, prompt: v.prompt, durationSeconds: 4, tier: 'fast', lab: v.lab }); video = (await veoAwait(s.opName, s.dur, undefined, undefined, undefined, s.scope)).video; }
      const id = await saveAsset(db, { interviewId: null, kind: 'lab_video', mime: 'video/mp4', ext: 'mp4', data: video, meta: { jobId: job.id, variant: v.id, label: v.label } });
      results.push({ id: v.id, label: v.label, ok: true, videoAssetId: id, usd: config.openai.mock ? 0 : v.usd, sec: Math.round((Date.now() - t0) / 1000) });
    } catch (e: any) {
      const m = String(e?.message ?? e);
      results.push({ id: v.id, label: v.label, ok: false, error: m.slice(0, 400), filtered: /filtr|15236754|celebr/i.test(m), sec: Math.round((Date.now() - t0) / 1000) });
    }
    await db.query('UPDATE jobs SET result=$2 WHERE id=$1', [job.id, JSON.stringify({ results, text })]);
  }
  await progress(100, 100, 'Concluído');
  return { results, text, interviewId: iv.id, usd: results.reduce((n, r) => n + (r.usd ?? 0), 0) };
};
