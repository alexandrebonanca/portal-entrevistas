import { config } from './config.ts';
import { esc } from './lib.ts';
import { markSvg, faviconHref, wordmark } from './brand.ts';

export const CSS = `
:root{--bg:#f6f2ea;--ink:#1c1a17;--mute:#6b655c;--line:#ddd5c6;--card:#fffdf8;--accent:#b4691f;--accent-ink:#fff;--ok:#2f6b3f;--bad:#a1322b;--warn:#8a6a14}
@media (prefers-color-scheme:dark){:root{--bg:#161412;--ink:#f1ebe0;--mute:#a79f92;--line:#3a352e;--card:#1e1b18;--accent:#e0954a;--accent-ink:#161412;--ok:#7bc08a;--bad:#e5877f;--warn:#e0bd62}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 Georgia,'Iowan Old Style',serif}
a{color:var(--accent)}h1,h2,h3{line-height:1.2;font-weight:600}h1{font-size:clamp(2rem,6vw,3.4rem);letter-spacing:-.01em}h2{font-size:1.5rem}
.sans,button,input,select,textarea,label,.btn,nav,table,.pill{font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}.narrow{max-width:640px;margin:0 auto;padding:0 20px}
header.top{border-bottom:1px solid var(--line)}header.top .wrap{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;gap:12px;flex-wrap:wrap}
.brand{display:inline-flex;align-items:center;gap:9px;font:600 1.18rem system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:-.01em;color:var(--ink);text-decoration:none}
.brand .mark{flex:none}.brand .wq{color:var(--accent);font-weight:400}.brand .wi{color:var(--ink)}
header.top nav{display:flex;flex-wrap:wrap;align-items:center;gap:6px 18px}header.top nav form button{margin-left:0!important}
nav a{font-size:.95rem;text-decoration:none;color:var(--ink)}nav a:hover{color:var(--accent)}
@media (max-width:560px){header.top nav{gap:6px 14px}nav a{font-size:.9rem}nav a.btn{padding:8px 14px;min-height:36px}}
[hidden]{display:none!important}
.btn,button{display:inline-block;background:var(--ink);color:var(--bg);border:0;border-radius:8px;padding:12px 20px;font-size:1rem;font-weight:600;cursor:pointer;text-decoration:none;min-height:44px}
.btn.accent,button.accent{background:var(--accent);color:var(--accent-ink)}.btn.ghost,button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
button.danger{background:var(--bad);color:#fff}button:disabled{opacity:.5;cursor:not-allowed}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:16px 0}
label{display:block;font-weight:600;font-size:.92rem;margin:14px 0 6px}
input[type=text],input[type=email],input[type=password],input[type=date],input[type=url],select,textarea{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font-size:1rem}
textarea{min-height:90px;resize:vertical}.hint{color:var(--mute);font-size:.88rem;font-family:system-ui}
.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:.78rem;font-weight:600;border:1px solid var(--line);color:var(--mute)}
.pill.ok{color:var(--ok);border-color:var(--ok)}.pill.bad{color:var(--bad);border-color:var(--bad)}.pill.warn{color:var(--warn);border-color:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:.95rem}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mute);font-weight:600;font-size:.82rem;text-transform:uppercase;letter-spacing:.06em}
.flash{padding:12px 16px;border-radius:8px;margin:16px 0;font-family:system-ui;font-size:.95rem;border:1px solid var(--line);background:var(--card)}.flash.bad{border-color:var(--bad);color:var(--bad)}.flash.ok{border-color:var(--ok);color:var(--ok)}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.grow{flex:1}.right{margin-left:auto}
.check{display:flex;gap:10px;align-items:flex-start;margin:10px 0;font-weight:400}.check input{margin-top:5px;width:20px;height:20px;flex:none}
footer{border-top:1px solid var(--line);margin-top:64px;padding:28px 0;color:var(--mute);font:.88rem system-ui}footer p{margin:0 0 6px}
.hero{padding:72px 0 48px}.hero p.lead{font-size:1.25rem;max-width:40ch;color:var(--mute)}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px}
.step{counter-increment:s}.step h3::before{content:counter(s,decimal-leading-zero);display:block;font:700 .8rem system-ui;color:var(--accent);letter-spacing:.14em;margin-bottom:6px}
.steps{counter-reset:s}
.rec{display:flex;flex-direction:column;align-items:center;gap:14px;padding:8px 0}
.recbtn{width:92px;height:92px;border-radius:50%;background:var(--bad);color:#fff;font-size:.9rem;border:6px solid var(--card);box-shadow:0 0 0 2px var(--bad)}
.recbtn.on{animation:pulse 1.2s infinite}@keyframes pulse{50%{box-shadow:0 0 0 10px rgba(161,50,43,.25)}}
.timer{font:600 2rem ui-monospace,monospace}.status{font:.92rem system-ui;color:var(--mute);min-height:1.4em}
.qnum{font:600 .85rem system-ui;letter-spacing:.1em;color:var(--accent);text-transform:uppercase}
video.cam{width:100%;max-height:60vh;border-radius:12px;background:#000;transform:scaleX(-1)}
.thumbs{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.thumbs img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px}
.written{white-space:pre-wrap;margin:6px 0;padding:8px 12px;border-left:3px solid var(--line);max-height:22em;overflow:auto;font-size:.95rem}
.cue{font:1.1rem/1.5 system-ui;min-height:3.2em;text-align:center;padding:12px;background:var(--card);border:1px solid var(--line);border-radius:10px}
.seg{border-left:3px solid var(--line);padding:6px 12px;margin:10px 0}.seg.host{border-color:var(--accent)}.seg.flag{background:rgba(180,105,31,.08)}
.skip{position:absolute;left:-999px}.skip:focus{left:8px;top:8px;background:var(--card);padding:8px;z-index:9}
.pbar{height:14px;border-radius:99px;background:var(--line);overflow:hidden}.pfill{height:100%;width:0;background:var(--accent);border-radius:99px;transition:width .6s ease}
@media (prefers-reduced-motion:reduce){.pfill{transition:none}}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.compose{position:fixed;right:16px;bottom:16px;width:min(380px,calc(100vw - 32px));max-height:min(60vh,760px);overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;box-shadow:0 12px 32px rgba(0,0,0,.22);z-index:30;font-family:system-ui}
.compose textarea{min-height:56px}.compose .row{gap:8px;flex-wrap:wrap}.compose button{font-size:.9rem;padding:9px 14px;min-height:40px}.compose h2{font-size:1.05rem;margin:0}
.compose-tips{margin:10px 0;padding-left:18px;font-size:.9rem;color:var(--mute)}.compose-tips li{margin:4px 0}.compose-item{border-top:1px solid var(--line);padding:10px 0;font-size:.95rem}.compose-item p{margin:4px 0}.compose-item.used{border-left:3px solid var(--ok);padding-left:10px}
#nq,#fq{scroll-margin-top:40vh}.compose-fab{position:fixed;right:16px;bottom:16px;z-index:29;box-shadow:0 6px 18px rgba(0,0,0,.22)}
@media (min-width:1180px){.compose{top:88px;max-height:none}body.compose-open .editor{margin-left:max(0px,calc((100vw - 1440px)/2));max-width:min(1040px,calc(100vw - 420px))}}
.badge{display:inline-block;min-width:1.5em;padding:0 .45em;border-radius:99px;background:var(--accent);color:var(--accent-ink);font:700 .75rem/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;text-align:center;vertical-align:1px}
.vh{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
`;

const COUNTRY: Record<string, [string, string]> = { EE: ['Estónia', 'Estonia'], PT: ['Portugal', 'Portugal'] };

/** Entidade proprietária e gestora do portal (português nas páginas em português, inglês nas outras). */
export function ownerLine(lang = 'pt-PT') {
  const o = config.owner, pt = /^pt/i.test(lang);
  const country = COUNTRY[o.country]?.[pt ? 0 : 1] ?? o.country;
  const site = o.site.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
  return `${pt ? `O ${esc(config.brand)} é propriedade da` : `${esc(config.brand)} is owned and operated by`} ${esc(o.name)}${country ? ` (${esc(country)})` : ''}${pt ? ', que o gere' : ''} · <a href="${esc(o.site)}" rel="noopener">${esc(site)}</a> · <a href="mailto:${esc(o.email)}">${esc(o.email)}</a>`;
}

export interface PageOpts { title: string; body: string; lang?: string; nav?: string; noindex?: boolean; desc?: string; script?: string; wide?: boolean; head?: string; styles?: string }

export function page(o: PageOpts) {
  return `<!doctype html><html lang="${o.lang ?? 'pt-PT'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)} · ${esc(config.brand)}</title>${o.desc ? `<meta name="description" content="${esc(o.desc)}">` : ''}
${o.noindex ? '<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="same-origin">' : ''}
<link rel="icon" href="${faviconHref()}">${o.head ?? ''}
<style>${CSS}${o.styles ?? ''}</style></head><body><a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="wrap"><a class="brand" href="/" aria-label="${esc(config.brand)}">${markSvg(28)}${wordmark()}</a><nav>${o.nav ?? ''}</nav></div></header>
<main id="main">${o.body}</main>
<footer><div class="wrap"><p>${esc(config.brand)} · <a href="/privacy">Privacy</a> · <a href="/contact">Contact</a></p><p>${ownerLine(o.lang)}</p></div></footer>
${o.script ? `<script src="/static/recorder.js" defer></script><script src="${o.script}" defer></script>` : ''}</body></html>`;
}

export const flash = (msg?: string, kind: 'ok' | 'bad' = 'ok') => (msg ? `<div class="flash ${kind}" role="status">${esc(msg)}</div>` : '');

export const pill = (label: string, kind: '' | 'ok' | 'bad' | 'warn' = '') => `<span class="pill ${kind}">${esc(label)}</span>`;
/** Resposta escrita do convidado (ficheiro Word ou texto), nas páginas do entrevistador: assinalada e com o texto original. */
export const writtenAnswer = (text: string | null) => `${pill('resposta escrita (ficheiro)', 'warn')}<blockquote class="written">${esc(text ?? '')}</blockquote>`;

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Rascunho', invited: 'Convidada', started: 'Iniciada', submitted: 'Submetida', expired: 'Expirada', cancelled: 'Cancelada', reopened: 'Reaberta',
  not_requested: 'Produção não pedida', queued: 'Em fila', transcribing: 'Transcrição', editorial_review: 'Revisão editorial', generating: 'Geração', qc: 'Controlo de qualidade', ready: 'Pronta', failed: 'Falhou', stale: 'Desatualizada',
  private: 'Privada', awaiting_approval: 'Aguarda aprovação', approved: 'Aprovada', published: 'Publicada', withdrawn: 'Retirada',
};
