import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { esc } from './lib.ts';
import { page } from './views.ts';
import { markSvg } from './brand.ts';
import { seller, complaintsLink } from './legal.ts';
import { FREE_PRODUCTION_JOBS, FREE_VIDEO_RENDERS } from './limits.ts';

const eur = (c: number) => `€${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

/**
 * Fotografias da página (public/img/photos/<nome>.jpg, preparadas com scripts/photos.ts a partir das fotos licenciadas).
 * Enquanto não existirem, usa as ilustrações que já existiam, com o alt do que a ilustração mostra (e sem cortes).
 */
const PHOTO_DIR = join(process.cwd(), 'public', 'img', 'photos');
const FALLBACK: Record<string, { src: string; alt: string }> = {
  hero: { src: 'studio.svg', alt: 'Illustration of a podcast microphone and sound waves' },
  interviewer: { src: 'g2.svg', alt: 'Fictional interviewer portrait (illustration)' },
  guest: { src: 'g1.svg', alt: 'Fictional guest portrait (illustration)' },
  studio: { src: 'c2.svg', alt: 'Sample podcast cover: Backstage' },
  listen: { src: 'c1.svg', alt: 'Sample podcast cover: The Long Table' },
};
const COVERS: [string, string][] = [['c1', 'The Long Table'], ['c2', 'Backstage'], ['c3', 'Open Mic']];
const hasPhoto = (name: string) => existsSync(join(PHOTO_DIR, `${name}.jpg`));
// Vídeo de apresentação (public/video/promo.mp4, com cartaz e legendas em inglês e em português): só aparece se existir.
export const hasVideo = () => existsSync(join(process.cwd(), 'public', 'video', 'promo.mp4'));
/**
 * Leitor do vídeo de apresentação, sem reprodução automática (preload="none"): legendas em inglês e em português, com a da
 * língua de quem vê ligada por omissão. Usado na landing e na página do convite ao convidado.
 */
export const promoVideo = (lang: 'en' | 'pt-PT', fallback: string, style = '') => `<video controls playsinline preload="none" poster="/static/video/promo.jpg" width="1280" height="720"${style ? ` style="${style}"` : ''}>
    <source src="/static/video/promo.mp4" type="video/mp4"><track kind="captions" srclang="en" label="English" src="/static/video/promo.en.vtt"${lang === 'en' ? ' default' : ''}><track kind="captions" srclang="pt-PT" label="Português" src="/static/video/promo.pt.vtt"${lang === 'pt-PT' ? ' default' : ''}>
    <a href="/static/video/promo.mp4">${esc(fallback)}</a></video>`;
const credits = () => { try { return readFileSync(join(PHOTO_DIR, 'credits.txt'), 'utf8').trim(); } catch { return ''; } };

const STYLES = `
.lp-hero{padding:52px 0 36px}.lp-grid{display:grid;grid-template-columns:1.05fr 1fr;gap:44px;align-items:center}
.lp-eyebrow{font:600 .8rem system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin:0 0 10px}
.lp-hero h1{margin:.1em 0 .35em}.lp-lead{font-size:1.2rem;color:var(--mute);max-width:42ch}
.lp-trust{display:flex;gap:8px 18px;flex-wrap:wrap;font:.9rem system-ui,sans-serif;color:var(--mute);margin-top:18px;padding:0;list-style:none}
.lp-trust li::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent);margin-right:8px;vertical-align:2px}
.lp-photo{position:relative;border-radius:18px;overflow:hidden;background:var(--line);aspect-ratio:4/3;margin:0}
.lp-photo img{width:100%;height:100%;object-fit:cover;display:block}.lp-photo img.ill{object-fit:contain;background:var(--card)}
.lp-chip{position:absolute;left:14px;bottom:14px;right:auto;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:12px;padding:10px 14px;font:.86rem/1.35 system-ui,sans-serif;display:flex;gap:10px;align-items:center;max-width:calc(100% - 28px)}
.lp-chip strong{display:block;font-weight:600}.lp-chip span{color:var(--mute)}
.lp-section{margin-top:64px}.lp-section>h2{margin-bottom:.3em}.lp-intro{max-width:62ch;color:var(--mute);margin-top:0}
.lp-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:26px;margin-top:22px}
.lp-step .lp-photo{margin-bottom:14px}.lp-num{font:700 .78rem system-ui,sans-serif;color:var(--accent);letter-spacing:.14em}
.lp-step h3{margin:.25em 0 .3em}.lp-step p{margin:0}
.lp-split{display:grid;grid-template-columns:1fr 1fr;gap:44px;align-items:center}
.lp-formats{list-style:none;padding:0;margin:0}.lp-formats li{padding:14px 0;border-bottom:1px solid var(--line)}.lp-formats li:last-child{border-bottom:0}
.lp-formats strong{display:block;font:600 1.02rem system-ui,sans-serif}.lp-formats span{color:var(--mute)}
.lp-covers{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:20px}.lp-covers img{width:100%;height:auto;border-radius:12px;display:block}
.lp-cta{text-align:center;padding:40px 20px}
.lp-video{margin:22px auto 0;max-width:880px}.lp-video video{width:100%;height:auto;aspect-ratio:16/9;border-radius:16px;background:#000;display:block}
.lp-video figcaption{margin-top:8px}
@media (max-width:820px){.lp-grid,.lp-split{grid-template-columns:1fr;gap:28px}.lp-hero{padding-top:32px}.lp-covers{grid-template-columns:repeat(3,1fr);gap:8px}}
`;

/**
 * Landing. `cq` são as etiquetas da campanha já normalizadas (utm_*, ou `ref` com o site de onde veio): seguem em todos os
 * links para o registo, para a conta ficar com a campanha que a trouxe (sem cookies), e também nos links para a galeria e para
 * a entrada, que as passam ao registo. `free`: os limites da 1.ª entrevista grátis (os do plano Start) quando a oferta está
 * ligada; null não a anuncia.
 */
export function landing(plans: any[], cq = '', free: { questionLimit: number | null; answerLimitSec: number | null } | null = null) {
  const b = esc(config.brand);
  const signup = (extra = '') => esc(`/registar${extra || cq ? '?' : ''}${extra}${extra && cq ? '&' : ''}${cq}`);
  const withTags = (path: string) => esc(cq ? `${path}?${cq}` : path);
  // Preços sem menção ao IVA: a taxa depende do país de quem compra e o preço final, com IVA, aparece antes de pagar.
  const cheapest = plans[0] ? eur(plans[0].price_cents) : '';
  const s = seller();
  const img = (name: string, alt: string, eager = false) => {
    const lazy = eager ? 'fetchpriority="high"' : 'loading="lazy"';
    if (hasPhoto(name)) return `<img src="/static/img/photos/${name}.jpg" alt="${esc(alt)}" width="1200" height="900" ${lazy} decoding="async">`;
    const f = FALLBACK[name];
    return `<img class="ill" src="/static/img/${f.src}" alt="${esc(f.alt)}" width="1200" height="900" ${lazy} decoding="async">`;
  };
  // Capas de exemplo: só com a fotografia de quem ouve (sem ela, a figura grande já é uma capa), sem repetir as usadas como recurso.
  const usedFallback = new Set(Object.keys(FALLBACK).filter(n => !hasPhoto(n)).map(n => FALLBACK[n].src));
  const covers = hasPhoto('listen') && COVERS.every(([f]) => !usedFallback.has(`${f}.svg`)) ? COVERS : [];
  const illustrated = usedFallback.size > 0;
  const cr = credits();
  const ogImage = hasPhoto('hero') ? `${config.baseUrl}/static/img/photos/hero.jpg` : '';
  const video = hasVideo();
  return page({
    lang: 'en', title: 'Great interviews, recorded in your guest’s own time',
    desc: `Invite people to share their professional culture and life experience, answering on their phone in their own time and language. ${config.brand} turns the answers into a reviewed English podcast and video with subtitles in five languages.${cheapest ? ` From ${cheapest}/month.` : ''}`,
    head: `<meta property="og:type" content="website"><meta property="og:site_name" content="${b}"><meta property="og:title" content="Great interviews, recorded in your guest’s own time">
<meta property="og:description" content="Asynchronous interviews that share professional cultures and life experience across countries and languages."><meta property="og:url" content="${esc(config.baseUrl)}/">${ogImage ? `<meta property="og:image" content="${esc(ogImage)}"><meta name="twitter:card" content="summary_large_image">` : ''}`,
    styles: STYLES,
    nav: `<a href="#how">How it works</a><a href="${withTags('/podcasts')}">Gallery</a><a href="#pricing">Pricing</a><a href="${withTags('/entrar')}">Sign in</a><a class="btn accent" href="${signup()}">Get started</a>`,
    body: `
<section class="lp-hero"><div class="wrap lp-grid">
  <div>
    <p class="lp-eyebrow">Asynchronous interviews · podcast, video and subtitles</p>
    <h1>Great interviews, recorded in your guest’s own time.</h1>
    <p class="lp-lead">Invite people whose professional culture and life experience are worth sharing. They answer on their phone, in their own time and language. ${b} turns their answers into a reviewed English podcast and video, with subtitles in English, Portuguese, Spanish, French and German, so their stories travel across countries and generations.</p>
    <p class="row"><a class="btn accent" href="${signup()}">${cheapest ? `Start from ${cheapest} / month` : 'Get started'}</a>${video ? '<a class="btn ghost" href="#tour">Watch the 1-minute video</a>' : '<a class="btn ghost" href="#how">See how it works</a>'}</p>${free ? `
    <p class="hint"><strong>Your first interview is free</strong>: no card needed. <a href="#free">How the free interview works</a></p>` : ''}
    <ul class="lp-trust"><li>No app for your guest</li><li>Consent at every step</li><li>Nothing published without approval</li></ul>
  </div>
  <figure class="lp-photo">${img('hero', 'A guest recording an interview answer', true)}
    <figcaption class="lp-chip">${markSvg(24)}<div><strong>Episode ready to review</strong><span>12 min · English · PT and ES subtitles</span></div></figcaption></figure>
</div></section>
${video ? `
<section class="wrap lp-section" id="tour" aria-labelledby="tourh"><h2 id="tourh"><span translate="no">${b}</span> in one minute</h2>
  <p class="lp-intro">Professional cultures and life lessons, shared across countries and generations: your guests answer in their own time, by default review before anything is published, and reach listeners in other languages.</p>
  <figure class="lp-video">${promoVideo('en', 'Watch the video (MP4)')}
    <figcaption class="hint">AI-generated video and voices (Google Veo), with English and Portuguese captions. All people shown are fictional.</figcaption></figure>
</section>
` : ''}
<section class="wrap lp-section" id="how" aria-labelledby="howh"><h2 id="howh">How it works</h2>
  <p class="lp-intro">The people worth hearing are rarely free for a live recording. ${b} removes the scheduling and the pressure: no ambush, no chasing, no hidden recording.</p>
  <div class="lp-steps">
    <article class="lp-step"><figure class="lp-photo">${img('interviewer', 'An interviewer preparing questions')}</figure><span class="lp-num">01</span><h3>You send the questions</h3><p>Write or record your goal and questions, add your photo and send one invitation by email.</p></article>
    <article class="lp-step"><figure class="lp-photo">${img('guest', 'A microphone and laptop ready to record an answer')}</figure><span class="lp-num">02</span><h3>They answer in their own time</h3><p>A private link on their phone or laptop, no app, no account. They hear each question, take time to reflect, answer in their own language and can record again before submitting.</p></article>
    <article class="lp-step"><figure class="lp-photo">${img('studio', 'A podcast microphone in a studio')}</figure><span class="lp-num">03</span><h3>We produce the episode</h3><p>A faithful English script you review, natural narration, subtitles in five languages and a cover. By default, your interviewee validates before anything goes live.</p></article>
  </div>
</section>

<section class="wrap lp-section" aria-labelledby="fmh"><div class="lp-split">
  <figure class="lp-photo">${img('listen', 'White headphones beside a lightbox that reads PODCAST')}</figure>
  <div><h2 id="fmh">One interview, three ways to share it</h2>
    <ul class="lp-formats">
      <li><strong>Audio podcast</strong><span>A clear English episode with chapters, transcript and an audible AI disclosure.</span></li>
      <li><strong>Video with photos and subtitles</strong><span>Authorized photos, close-ups of whoever is speaking and subtitles in English, Portuguese, Spanish, French or German.</span></li>
      <li><strong>AI video (optional, quoted separately)</strong><span>Presenters animated from authorized photos, with a visible “AI-generated video” notice, only with each person’s specific consent. Not included in any plan: each animated production is quoted before anything is generated and paid with prepaid credits.</span></li>
    </ul>
    ${covers.length ? `<div class="lp-covers">${covers.map(([f, c]) => `<img src="/static/img/${f}.svg" alt="Sample podcast cover: ${esc(c)}" width="400" height="400" loading="lazy">`).join('')}</div>` : ''}
  </div>
</div></section>

<section class="wrap lp-section" id="principles" aria-labelledby="ph"><h2 id="ph">Respectful by design</h2>
  <div class="grid3">
    <div class="card"><h3>Consent first</h3><p>Recording, AI processing, photo use, AI video and publication are separate, unticked choices, stored with the exact text shown.</p></div>
    <div class="card"><h3>Never invented</h3><p>Every line points to what was actually said. AI video clips are checked word by word against the approved script.</p></div>
    <div class="card"><h3>Synthetic means disclosed</h3><p>Episodes open with an audible notice, and animated portraits carry a visible label. No cloned voices.</p></div>
    <div class="card"><h3>Interviewee approves</h3><p>By default, your interviewee sees and validates the final version, and always does when they appear in an AI video. Silence is never approval.</p></div>
    <div class="card"><h3>Originals stay private</h3><p>Raw recordings and unused photos are never published. Withdrawing an episode takes one click.</p></div>
    <div class="card"><h3>You stay in control</h3><p>Nothing paid runs until you press “process”, and you review every script before it is narrated.</p></div>
  </div>
</section>

<section class="wrap lp-section" id="pricing" aria-labelledby="prh"><h2 id="prh">Simple monthly pricing</h2>
  <div class="grid3" style="max-width:760px">${plans.map(p => `<div class="card"><h3 style="margin-top:0">${esc(p.name)}</h3><p style="font-size:2.2rem;margin:.1em 0">${eur(p.price_cents)}<span class="hint"> / month</span></p>
    <p>Up to <strong>${p.interviews_per_month} interviews</strong> per month.</p><ul class="sans" style="padding-left:18px"><li>Invitations, recording and photos</li><li>Transcription, English script, narration</li><li>Subtitles, cover, player and video with photos</li><li>Cancel any time</li></ul>
    <a class="btn accent" href="${signup(`plan=${encodeURIComponent(p.id)}`)}">Choose ${esc(p.name)}</a></div>`).join('')}</div>
${free ? `  <div class="card" id="free" style="max-width:760px"><h3 style="margin-top:0">Your first interview is free</h3>
    <p>Create an account, confirm your email address and send your first invitation free of charge: no payment and no card details. The free interview has the Start plan limits (up to ${free.questionLimit} questions and ${Math.round(Number(free.answerLimitSec) / 60)} minutes of answers) and the same production as the plans (transcription, English script, narration, subtitles, cover and the video with photos), within a total of ${FREE_PRODUCTION_JOBS} production jobs: processing, regenerating the script and generating the episode, counting failed jobs and each «Try again», and up to ${FREE_VIDEO_RENDERS} generations of the video with photos. One per person and organisation, and each guest can receive only one free interview. A limited number of free interviews is available each day and each month; when they run out, the offer is temporarily unavailable. The offer can be withdrawn at any time (see the <a href="/termos#entrevista-gratis">terms</a>).</p>
    <a class="btn accent" href="${signup()}">Send your first interview free</a></div>
` : ''}  <p class="hint">Plans include photos only. AI animation is never part of a plan: each animated production is quoted before anything is generated and paid with prepaid credits. · <span lang="pt-PT">A animação por IA é orçamentada à parte e paga com créditos.</span></p>
  <p class="hint">Billing is monthly through Stripe, card only. VAT, where it applies, depends on your country; the final price is always shown before you pay.${s.tradeName || s.name ? ` Sold by ${esc(s.name || s.tradeName)}.` : ''} <a href="/termos">Terms of sale · Termos e condições</a> · ${complaintsLink(s)}. Plans and limits may change for new subscribers.</p>
</section>

<section class="wrap lp-section"><div class="card lp-cta"><h2 style="margin-top:0">Your next great guest is one polite invitation away.</h2>
  <a class="btn accent" href="${signup()}">Create your account</a><p class="hint" style="margin-top:14px">Invited as a guest? Use the personal link in your email. There is nothing to sign up for.</p>
  <p class="hint">Questions about plans or a project of your own? <a href="/contact?topic=sales">Write to us</a>.</p></div>
  ${cr ? `<p class="hint">Photos: ${esc(cr)}</p>` : ''}${illustrated ? '<p class="hint">Illustrations on this page are fictional and do not depict any real person.</p>' : ''}
</section>`,
  });
}
