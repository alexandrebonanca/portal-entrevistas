import { storeZip } from './zip.ts';
import { toSrt, toVtt, shiftCues } from './subtitles.ts';
import { fmtDuration } from './lib.ts';

const LANG_NAME: Record<string, string> = { en: 'English', 'pt-PT': 'Português (Portugal)', pt: 'Português', es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano', 'zh-CN': 'Chinês (mandarim, simplificado)' };
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Pacote de entrega de um vídeo: MP4, legendas no tempo do vídeo (SRT e VTT por idioma; o vídeo editorial não as tem na
 * imagem), capítulos (JSON) e um LEIA-ME com a ficha técnica e a divulgação de IA.
 */
export async function deliveryPackage(iv: any, ep: any, asset: any, mp4: Buffer) {
  const meta = asset.meta ?? {};
  const off = Number(meta.subsOffsetMs) || 0;
  const base = String(ep.slug || 'episodio').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80);
  const files: { name: string; data: Buffer }[] = [{ name: `${base}.mp4`, data: mp4 }];
  const langs = Object.keys(ep.subtitles ?? {}).filter(l => /^[A-Za-z-]{2,8}$/.test(l));
  for (const l of langs) {
    const cues = shiftCues(ep.subtitles[l] as any[], off);
    files.push({ name: `legendas/${base}.${l}.srt`, data: Buffer.from(toSrt(cues), 'utf8') }, { name: `legendas/${base}.${l}.vtt`, data: Buffer.from(toVtt(cues), 'utf8') });
  }
  const chapters: { title: string; time: number }[] = Array.isArray(meta.chapters) ? meta.chapters
    : ((ep.chapters ?? []) as any[]).map(c => ({ title: c.title, time: Math.round((c.startMs + off) / 10) / 100 }));
  files.push({ name: 'chapters.json', data: Buffer.from(JSON.stringify(chapters, null, 2), 'utf8') });
  const readme = [
    `${ep.title}`,
    `${iv.host_name || 'Entrevistador'} em conversa com ${iv.guest_name || 'convidado'}${meta.promoter ? ` · ${meta.promoter}` : ''}`,
    '',
    `Vídeo: ${base}.mp4 · ${fmtDuration(asset.duration_ms ?? ep.duration_ms)}${meta.graphics?.size ? ` · ${meta.graphics.size}` : ''} · H.264/AAC`,
    meta.style === 'editorial' ? `Estilo editorial: cartão de abertura e final, temas das perguntas, ideias-chave${meta.graphics?.keyPointCards ? ` (${meta.graphics.keyPointCards} cartões)` : ''} e identificação de cada pessoa.` : 'Estilo clássico (estúdio).',
    meta.animatedSegments ? `Vídeo premium: ${meta.animatedSegments} falas com retrato animado por IA (assinaladas na imagem).` : 'Fotografias fixas com as vozes do episódio.',
    '',
    langs.length ? `Legendas (pasta legendas/, já no tempo do vídeo): ${langs.map(l => LANG_NAME[l] ?? l).join(', ')}. SRT para redes sociais e editores; VTT para a web.` : 'Sem legendas.',
    '',
    'Capítulos (chapters.json; tempos em segundos):',
    ...chapters.map(c => `  ${mmss(c.time)}  ${c.title}`),
    '',
    'Divulgação obrigatória ao publicar: entrevista real, feita à distância; tradução e narração com vozes geradas por IA' + (meta.animatedSegments ? '; retratos animados por IA.' : '.'),
    'A publicação continua sujeita às aprovações registadas no portal. Produzido com o QuietInterview · quietinterview.com',
  ].join('\r\n');
  files.push({ name: 'LEIA-ME.txt', data: Buffer.from(readme, 'utf8') });
  // Descrição pronta para o YouTube: os capítulos só aparecem se o primeiro for 00:00 e houver pelo menos três.
  const yt = [ep.title, '', `${iv.host_name || 'Host'} in conversation with ${iv.guest_name || 'our guest'}${meta.promoter ? ` · ${meta.promoter}` : ''}.`, '',
    ...(chapters.length >= 2 ? ['00:00 Introduction', ...chapters.filter(c => c.time >= 10).map(c => `${mmss(c.time)} ${c.title}`), ''] : []),
    'A real interview, conducted remotely. Translation and narration with AI-generated voices' + (meta.animatedSegments ? '; AI-animated portraits.' : '.'),
    'Produced with QuietInterview · https://quietinterview.com'].join('\r\n');
  files.push({ name: 'youtube-descricao.txt', data: Buffer.from(yt, 'utf8') });
  return { name: `${base}_entrega.zip`, chunks: storeZip(files) };
}
