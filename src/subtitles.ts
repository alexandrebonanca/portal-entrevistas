export interface Cue { id: string; startMs: number; endMs: number; speakerRole: 'host' | 'guest'; text: string; language: string; revision: number }

const MAX_CHARS = 84, MAX_MS = 6500;

/**
 * Agrupa palavras com carimbos de tempo MEDIDOS (sobre o áudio sintético final) em cues legíveis.
 * Se não houver palavras, devolve uma única cue com o intervalo exato do segmento (não se estima por palavras/duração).
 */
export function cuesFromWords(words: { word: string; start: number; end: number }[], seg: { id: string; role: 'host' | 'guest'; text: string; startMs: number; durationMs: number }, language: string): Cue[] {
  if (!words.length) return [{ id: `${seg.id}-0`, startMs: seg.startMs, endMs: seg.startMs + seg.durationMs, speakerRole: seg.role, text: seg.text, language, revision: 1 }];
  const out: Cue[] = [];
  let buf: typeof words = [];
  const flush = () => {
    if (!buf.length) return;
    const text = buf.map(w => w.word.trim()).join(' ').replace(/\s+([,.;:!?])/g, '$1');
    out.push({ id: `${seg.id}-${out.length}`, startMs: seg.startMs + Math.round(buf[0].start * 1000), endMs: seg.startMs + Math.round(buf[buf.length - 1].end * 1000), speakerRole: seg.role, text, language, revision: 1 });
    buf = [];
  };
  for (const w of words) {
    const cur = buf.map(x => x.word.trim()).join(' ');
    if (buf.length && (cur.length + w.word.length + 1 > MAX_CHARS || (w.end - buf[0].start) * 1000 > MAX_MS)) flush();
    buf.push(w);
    if (/[.!?]$/.test(w.word.trim()) && cur.length > 24) flush();
  }
  flush();
  // Dentro do segmento: sem sobreposições e cobrindo até ao fim do segmento.
  for (let i = 0; i < out.length; i++) {
    if (i + 1 < out.length) out[i].endMs = Math.min(out[i].endMs, out[i + 1].startMs);
    out[i].endMs = Math.max(out[i].endMs, out[i].startMs + 300);
  }
  out[0].startMs = Math.max(seg.startMs, Math.min(out[0].startMs, seg.startMs + 400));
  return out;
}

export function fixOverlaps(cues: Cue[]): Cue[] {
  const s = [...cues].sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < s.length - 1; i++) if (s[i].endMs > s[i + 1].startMs) s[i].endMs = s[i + 1].startMs;
  return s.filter(c => c.endMs > c.startMs);
}

const ts = (ms: number, sep: string) => {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
};
const clean = (t: string) => t.replace(/-->/g, '→').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function toVtt(cues: Cue[]) {
  return 'WEBVTT\n\n' + cues.map((c, i) => `${i + 1}\n${ts(c.startMs, '.')} --> ${ts(c.endMs, '.')}\n${c.speakerRole === 'host' ? '' : ''}${clean(c.text)}\n`).join('\n');
}
export function toSrt(cues: Cue[]) {
  return cues.map((c, i) => `${i + 1}\n${ts(c.startMs, ',')} --> ${ts(c.endMs, ',')}\n${c.text.replace(/-->/g, '→')}\n`).join('\n');
}

/** Verificações de qualidade sobre uma linha temporal. */
export function checkCues(cues: Cue[], durationMs: number): string[] {
  const issues: string[] = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (c.endMs <= c.startMs) issues.push(`Cue ${c.id}: duração não positiva`);
    if (c.endMs > durationMs + 1500) issues.push(`Cue ${c.id}: fora do áudio`);
    if (i > 0 && c.startMs < cues[i - 1].endMs) issues.push(`Cue ${c.id}: sobreposição`);
  }
  return issues;
}

/**
 * Divide o texto traduzido de uma fala em `weights.length` partes (uma por legenda inglesa da fala), proporcionais ao
 * tamanho de cada legenda de origem, cortando entre palavras e, perto do ponto ideal, de preferência depois de pontuação.
 * Assim a tradução é feita à fala inteira (frases completas, sem texto a passar de uma legenda para a vizinha) e os
 * tempos continuam a ser os medidos no áudio. Nenhuma parte fica vazia enquanto houver palavras para todas.
 */
export function splitByWeights(text: string, weights: number[]): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const n = weights.length;
  if (n <= 1 || !words.length) return n ? [words.join(' '), ...Array(n - 1).fill('')].slice(0, n) : [];
  if (words.length <= n) return Array.from({ length: n }, (_, k) => words[k] ?? ''); // poucas palavras: uma por legenda, pela ordem
  const total = weights.reduce((a, b) => a + Math.max(1, b), 0);
  const len = words.reduce((a, w) => a + w.length + 1, 0);
  const ends: number[] = []; // índice (exclusivo) da última palavra de cada parte
  let acc = 0, start = 0;
  for (let k = 0; k < n - 1; k++) {
    acc += Math.max(1, weights[k]);
    const target = (acc / total) * len;
    let best = -1, bestScore = Infinity, pos = 0;
    const minEnd = start + 1, maxEnd = words.length - (n - 1 - k); // deixa pelo menos uma palavra a cada parte seguinte
    for (let j = 0; j < words.length; j++) {
      pos += words[j].length + 1;
      const end = j + 1;
      if (end < minEnd || end > maxEnd) continue;
      const punct = /[.,;:!?…)»"]$/.test(words[j]) ? 0.6 : 1; // um corte depois de pontuação vale mais
      const score = Math.abs(pos - target) * punct;
      if (score < bestScore) { bestScore = score; best = end; }
    }
    if (best < 0) best = Math.min(maxEnd, Math.max(minEnd, start + 1));
    ends.push(best); start = best;
  }
  ends.push(words.length);
  let from = 0;
  return ends.map(e => { const part = words.slice(from, e).join(' '); from = e; return part; });
}
