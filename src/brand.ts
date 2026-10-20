import { config } from './config.ts';
import { esc } from './lib.ts';

/**
 * Marca quietinterview (logótipo A: balão de fala com onda sonora).
 * O símbolo usa a cor de destaque da página (cobre); o nome é texto, para acompanhar o modo escuro e ser legível.
 */
const MARK_PATHS = (bubble: string, bars: string) =>
  `<rect x="2" y="2" width="76" height="56" rx="18" fill="${bubble}"/><path d="M18 56 L10 74 L34 56 Z" fill="${bubble}"/>` +
  `<rect x="21" y="25" width="5" height="12" rx="2.5" fill="${bars}"/><rect x="31" y="18" width="5" height="26" rx="2.5" fill="${bars}"/>` +
  `<rect x="41" y="22" width="5" height="18" rx="2.5" fill="${bars}"/><rect x="51" y="27" width="5" height="8" rx="2.5" fill="${bars}"/>`;

/** Símbolo para a página (cor de destaque do tema; barras na cor do fundo). */
export const markSvg = (size = 30) =>
  `<svg class="mark" width="${Math.round(size * 80 / 76)}" height="${size}" viewBox="0 0 80 76" aria-hidden="true" focusable="false">${MARK_PATHS('var(--accent)', 'var(--bg)')}</svg>`;

/** Símbolo autónomo (ficheiro SVG, favicon, PNG dos emails): cores fixas. */
export const markSvgFile = (bubble = '#b4691f', bars = '#fffdf8') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="76" viewBox="0 0 80 76">${MARK_PATHS(bubble, bars)}</svg>`;

/** Favicon: o símbolo centrado num quadrado. */
export const faviconHref = () =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><g transform="translate(0 2)">${MARK_PATHS('#b4691f', '#fffdf8')}</g></svg>`)}`;

/** Nome com «quiet» na cor de destaque. Para um nome de marca diferente (BRAND_NAME), mostra-o tal como está. */
export const wordmark = () => {
  const b = config.brand;
  // um só bloco (sem o espaço do flex entre as duas partes); translate="no": o tradutor do browser não traduz o nome
  return /^quietinterview$/i.test(b) ? `<span class="wm" translate="no"><span class="wq">quiet</span><span class="wi">interview</span></span>` : `<span class="wi" translate="no">${esc(b)}</span>`;
};

/** Cabeçalho dos emails: símbolo em PNG (os clientes de email não mostram SVG) e o nome em texto. */
export const emailBrand = () => {
  const b = config.brand;
  const name = /^quietinterview$/i.test(b)
    ? `<span style="color:#b4691f">quiet</span><span style="color:#1c1a17">interview</span>`
    : `<span style="color:#1c1a17">${esc(b)}</span>`;
  return `<p style="margin:0 0 4px;font:600 18px Arial,sans-serif;letter-spacing:-.01em"><img src="${esc(config.baseUrl)}/static/img/mark-email.png" width="25" height="24" alt="" style="vertical-align:-5px;margin-right:8px;border:0">${name}</p>`;
};
