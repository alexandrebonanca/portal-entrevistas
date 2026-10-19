import { config } from './config.ts';
import { esc } from './lib.ts';
import { page } from './views.ts';

const eur = (c: number) => `€${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

export function landing(plans: any[]) {
  const b = esc(config.brand);
  const guests = [['g1', 'Imaginary guest — founder'], ['g2', 'Imaginary guest — author'], ['g3', 'Imaginary guest — scientist'], ['g4', 'Imaginary guest — chef']];
  const covers = [['c1', 'The Long Table'], ['c2', 'Backstage'], ['c3', 'Open Mic']];
  const cheapest = plans[0] ? eur(plans[0].price_cents) : '€10';
  return page({
    lang: 'en', title: 'Interview the people you admire — without chasing them',
    desc: `Invite a public figure to answer your questions on their own time, on their phone. We turn the recordings into a reviewed, subtitled English podcast episode. From ${cheapest}/month.`,
    nav: `<a href="#how">How it works</a><a href="/podcasts">Gallery</a><a href="#pricing">Pricing</a><a href="/entrar">Sign in</a><a class="btn accent" style="margin-left:16px" href="/registar">Get started</a>`,
    body: `
<section class="hero"><div class="wrap"><div class="row" style="gap:40px;align-items:center">
  <div class="grow" style="flex-basis:380px">
    <p class="sans" style="letter-spacing:.14em;text-transform:uppercase;font-size:.8rem;color:var(--accent);font-weight:700">${b} · asynchronous interviews</p>
    <h1>Interview the people you admire — without chasing them.</h1>
    <p class="lead">Send a respectful invitation. Your guest answers your questions on their phone, whenever it suits them. ${b} turns the recordings into a carefully reviewed English podcast episode with subtitles your listeners choose.</p>
    <p class="row"><a class="btn accent" href="/registar">Start from ${cheapest} / month</a><a class="btn ghost" href="#how">See how it works</a></p>
  </div>
  <div style="flex-basis:380px;flex-grow:1"><img src="/static/img/studio.svg" alt="Illustration of a podcast microphone and sound waves" width="640" height="480" style="width:100%;height:auto;border-radius:20px"></div>
</div></div></section>

<section class="wrap" aria-labelledby="who"><h2 id="who">Made for conversations that would never fit a calendar</h2>
  <p style="max-width:64ch">Authors, athletes, scientists, chefs, founders — the people worth hearing are rarely free for a live recording. ${b} removes the scheduling problem and the pressure: one polite invitation, a short list of questions, answers recorded in the guest’s own time. No ambush, no follow-up chasing, no hidden recording.</p>
  <div class="grid3" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-top:20px">${guests.map(([f, c]) => `<figure style="margin:0"><img src="/static/img/${f}.svg" alt="${esc(c)} (illustration)" width="240" height="300" loading="lazy" style="width:100%;height:auto;border-radius:14px"><figcaption class="hint">${esc(c)}</figcaption></figure>`).join('')}</div>
  <p class="hint">All portraits on this page are fictional illustrations. They do not depict, and are not endorsed by, any real person.</p>
</section>

<section class="wrap" id="how" aria-labelledby="howh" style="margin-top:56px"><h2 id="howh">How it works</h2>
  <div class="grid3 steps">
    <div class="card step"><h3>Write your questions</h3><p>Type or record your goal and questions, add your photo, enter your guest’s email and send one invitation.</p></div>
    <div class="card step"><h3>They answer on a phone</h3><p>A private link. They read or hear each question, record, listen back, confirm. No app, no account. Up to three selfies — only if they choose.</p></div>
    <div class="card step"><h3>You review and process</h3><p>You get an email when it is complete. Nothing paid runs until you review the originals and press “process”.</p></div>
    <div class="card step"><h3>Faithful English script</h3><p>Answers are transcribed and rendered into English, each line linked to its source. Doubtful names and numbers are flagged for you.</p></div>
    <div class="card step"><h3>Narration &amp; subtitles</h3><p>Two distinct synthetic voices read the approved script; subtitles are timed against the final audio, in the languages you choose.</p></div>
    <div class="card step"><h3>Approve &amp; publish</h3><p>A cover is composed, your guest previews the result, and you publish — privately, unlisted or publicly. Nothing goes live on its own.</p></div>
  </div></section>

<section class="wrap" style="margin-top:56px" aria-labelledby="covh"><h2 id="covh">Every episode gets a cover and a player</h2>
  <div class="grid3" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">${covers.map(([f, c]) => `<img src="/static/img/${f}.svg" alt="Sample podcast cover: ${esc(c)}" width="400" height="400" loading="lazy" style="width:100%;height:auto;border-radius:14px">`).join('')}</div>
  <p class="hint">Sample covers are illustrations. Real covers are composed from your title, an AI-generated background and, only with consent, your guest’s chosen photo.</p>
</section>

<section class="wrap" id="principles" aria-labelledby="ph" style="margin-top:56px"><h2 id="ph">Respectful by design</h2>
  <div class="grid3">
    <div class="card"><h3>Consent first</h3><p>Recording, AI processing, photo use and publication are separate, unticked choices, stored with the exact text shown.</p></div>
    <div class="card"><h3>Never invented</h3><p>Every line points to what was actually said. Introductions are labelled as editorial. No cloned voices — ever.</p></div>
    <div class="card"><h3>Synthetic means disclosed</h3><p>Episodes open with an audible notice that translation and narration are AI-generated.</p></div>
    <div class="card"><h3>Guest approves</h3><p>By default your guest previews and approves the final version. Silence is never approval.</p></div>
    <div class="card"><h3>Originals stay private</h3><p>Raw recordings and unused photos are never published. Withdrawing an episode takes one click.</p></div>
    <div class="card"><h3>You stay in control</h3><p>The assistant can flag possible fidelity problems; it never approves anything.</p></div>
  </div></section>

<section class="wrap" id="pricing" aria-labelledby="prh" style="margin-top:56px"><h2 id="prh">Simple monthly pricing</h2>
  <div class="grid3" style="max-width:760px">${plans.map(p => `<div class="card"><h3 style="margin-top:0">${esc(p.name)}</h3><p style="font-size:2.2rem;margin:.1em 0">${eur(p.price_cents)}<span class="hint"> / month</span></p>
    <p>Up to <strong>${p.interviews_per_month} interviews</strong> per month.</p><ul class="sans" style="padding-left:18px"><li>Invitations, recording &amp; selfies</li><li>Transcription, English script, narration</li><li>Subtitles, cover and player</li><li>Cancel any time</li></ul>
    <a class="btn accent" href="/registar?plan=${esc(p.id)}">Choose ${esc(p.name)}</a></div>`).join('')}</div>
  <p class="hint">Billing is monthly through Stripe. Plans and limits may change for new subscribers.</p>
</section>

<section class="wrap" style="margin-top:56px"><div class="card" style="text-align:center;padding:36px 20px"><h2 style="margin-top:0">Your next great guest is one polite invitation away.</h2>
  <a class="btn accent" href="/registar">Create your account</a><p class="hint" style="margin-top:14px">Invited as a guest? Use the personal link in your email — there is nothing to sign up for.</p></div></section>`,
  });
}
