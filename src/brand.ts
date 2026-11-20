import { config } from './config.ts';
import { esc } from './lib.ts';

/**
 * Marca quietinterview (rebranding 2027): um «q» desenhado como microfone, com o ponto coral da luz de gravação.
 * O quadrado usa a cor de marca da página (verde-salva); o nome é texto, para acompanhar o modo escuro e ser legível.
 */
export const RECORD_DOT = '#E0603C';
export const MARK_PATHS = (tile: string, glyph: string) =>
  `<rect width="64" height="64" rx="16" fill="${tile}"/><circle cx="28" cy="31" r="11" fill="none" stroke="${glyph}" stroke-width="6"/>` +
  `<path d="M39 31v19" stroke="${glyph}" stroke-width="6" stroke-linecap="round"/><circle cx="48" cy="16" r="4.5" fill="${RECORD_DOT}"/>`;

/** Símbolo para a página (cor de marca do tema; o «q» na cor do fundo). */
export const markSvg = (size = 30) =>
  `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">${MARK_PATHS('var(--accent)', 'var(--bg)')}</svg>`;

/** Símbolo autónomo (ficheiro SVG, favicon, PNG dos emails): cores fixas. */
export const markSvgFile = (tile = '#3F5E52', glyph = '#F7F4EE') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${MARK_PATHS(tile, glyph)}</svg>`;

/** Favicon: o símbolo. */
export const faviconHref = () =>
  `data:image/svg+xml,${encodeURIComponent(markSvgFile())}`;

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
    ? `<span style="color:#3F5E52;font-weight:400">quiet</span><span style="color:#1B1F24">interview</span>`
    : `<span style="color:#1B1F24">${esc(b)}</span>`;
  return `<p style="margin:0 0 4px;font:600 18px Arial,sans-serif;letter-spacing:-.01em"><img src="${esc(config.baseUrl)}/static/img/mark-email.png" width="24" height="24" alt="" style="vertical-align:-5px;margin-right:8px;border:0">${name}</p>`;
};
