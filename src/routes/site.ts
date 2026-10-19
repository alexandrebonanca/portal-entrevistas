import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { esc, hashPassword, verifyPassword, isEmail, rateLimit, sha256, newToken } from '../lib.ts';
import { page, flash } from '../views.ts';
import { setSessionCookie, audit } from '../app.ts';

function landing() {
  const b = esc(config.brand);
  return page({
    lang: 'en', title: 'Expert voices for professional learners',
    desc: 'An asynchronous interview studio: invite an expert, let them answer on their phone, and publish an English-language podcast episode with subtitles — reviewed and approved by humans.',
    nav: `<a href="#how">How it works</a><a href="#principles">Principles</a><a class="btn accent" href="/entrar">Interviewer sign in</a>`,
    body: `
<section class="hero"><div class="wrap">
  <p class="sans" style="letter-spacing:.14em;text-transform:uppercase;font-size:.8rem;color:var(--accent);font-weight:700">${b} · interview studio</p>
  <h1>Bring the people who shape your field into your learners’ ears.</h1>
  <p class="lead">${b} lets a trainer invite an expert to answer a short list of questions on their phone, whenever it suits them — and turns the recordings into a carefully reviewed English-language podcast episode, with subtitles the listener chooses.</p>
  <p class="row"><a class="btn accent" href="/entrar">Start an interview</a><a class="btn ghost" href="#how">See how it works</a></p>
</div></section>

<section class="wrap" aria-labelledby="why"><h2 id="why">Why this exists</h2>
  <p style="max-width:62ch">Professional training is richer when learners hear from practitioners, regulators, founders and researchers. But the people worth hearing are busy, scattered across time zones, and rarely free for a live recording. ${b} removes the scheduling problem: the expert answers asynchronously, in their own time, in their own language — and the trainer receives a production-ready episode to review, not a pile of audio files.</p>
</section>

<section class="wrap" id="how" aria-labelledby="howh" style="margin-top:48px"><h2 id="howh">How it works</h2>
  <div class="grid3 steps">
    <div class="card step"><h3>Prepare</h3><p>Write or record the purpose and the questions, add your photo, and invite the guest by email.</p></div>
    <div class="card step"><h3>Answer on a phone</h3><p>The guest opens a private link, reads or hears each question, records an answer, listens back and confirms. No app, no account. They may add up to three selfies — only if they choose.</p></div>
    <div class="card step"><h3>Get notified</h3><p>When the interview is complete you receive an email. Nothing paid happens until you review the originals and press “process”.</p></div>
    <div class="card step"><h3>Transcribe &amp; translate</h3><p>Answers are transcribed and rendered faithfully into English. You and, where required, the guest review every segment against its source.</p></div>
    <div class="card step"><h3>Narrate &amp; subtitle</h3><p>Two distinct synthetic voices read the approved script. Subtitles (English, Portuguese and more) are timed against the final audio.</p></div>
    <div class="card step"><h3>Approve &amp; publish</h3><p>A cover is composed, the guest previews the result, and you publish — privately, unlisted, or publicly. Nothing goes live on its own.</p></div>
  </div></section>

<section class="wrap" id="principles" aria-labelledby="ph" style="margin-top:48px"><h2 id="ph">Principles we build on</h2>
  <div class="grid3">
    <div class="card"><h3>Faithful, never invented</h3><p>Every line of the script points to the answer it came from. Hosts’ introductions are labelled as editorial. Doubtful names and numbers are flagged for a human.</p></div>
    <div class="card"><h3>Consent you can read</h3><p>Recording, AI processing, photo use and publication are separate, unticked choices — each stored with the exact text shown. Declining a photo never costs an answer.</p></div>
    <div class="card"><h3>Synthetic means disclosed</h3><p>No voice cloning. Episodes open with an audible notice that translation and narration are AI-generated, and say so on the episode page.</p></div>
    <div class="card"><h3>Originals stay private</h3><p>Raw recordings and unselected photos are never published. Withdrawing an episode is one click.</p></div>
    <div class="card"><h3>Human in the loop</h3><p>The assistant can flag possible fidelity problems; it never approves anything. Publishing requires explicit approvals that are voided if the content changes.</p></div>
    <div class="card"><h3>Cost-aware</h3><p>You see an estimate before processing and the observed usage afterwards — clearly labelled as estimates until your provider confirms.</p></div>
  </div></section>

<section class="wrap" style="margin-top:48px"><div class="card" style="text-align:center;padding:36px 20px">
  <h2 style="margin-top:0">Built for training programmes</h2>
  <p style="max-width:56ch;margin:0 auto 20px">${b} is a companion tool for professional training portals: the voices of practitioners, one honest conversation at a time.</p>
  <a class="btn accent" href="/entrar">Interviewer sign in</a>
  <p class="hint" style="margin-top:14px">Invited as a guest? Use the personal link in your email — there is nothing to sign up for.</p>
</div></section>`,
  });
}

export async function siteRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(landing()));
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain').send('User-agent: *\nAllow: /$\nAllow: /privacy\nAllow: /e/\nDisallow: /i/\nDisallow: /entrevista\nDisallow: /painel\nDisallow: /entrevistas\n'));

  app.get('/privacy', async (_req, reply) => reply.type('text/html; charset=utf-8').send(page({
    lang: 'en', title: 'Privacy',
    body: `<div class="narrow" style="padding-top:40px"><h1>Privacy</h1>
<p>${esc(config.brand)} processes interview recordings and optional photos on behalf of the interviewer who invited you. This page summarises how; the invitation and the consent screen you see before recording are the authoritative statements for your interview.</p>
<h2>What we store</h2><ul><li>Your name and email (to send the invitation).</li><li>Your recorded answers and any photos you choose to add.</li><li>Your consent choices, with the exact text shown and the time.</li></ul>
<h2>External services</h2><p>If you allow it, audio is sent to an AI provider for transcription, translation and synthetic narration. Photos are never sent to AI services by default.</p>
<h2>Publication</h2><p>Nothing is published without the interviewer’s decision and, by default, your approval of the final version. Originals and unselected photos stay private.</p>
<h2>Your rights</h2><p>Ask for access, correction, withdrawal of consent or deletion at <a href="mailto:${esc(config.supportEmail)}">${esc(config.supportEmail)}</a>. Copies already downloaded or distributed elsewhere may not be recoverable.</p>
<p class="hint">The processor list, retention periods and legal bases are maintained in the operator’s documentation and must be completed before production use.</p></div>`,
  })));

  // ---- Autenticação do entrevistador ----
  const authPage = (title: string, body: string) => page({ title, noindex: true, body: `<div class="narrow" style="padding-top:48px"><h1>${title}</h1>${body}</div>` });

  app.get('/entrar', async (req, reply) => {
    if (req.user) return reply.redirect('/painel');
    const q = req.query as any;
    return reply.type('text/html; charset=utf-8').send(authPage('Entrar', `${flash(q.e, 'bad')}
<form method="post" action="/entrar" class="card"><label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="username">
<label for="p">Palavra-passe</label><input id="p" name="password" type="password" required autocomplete="current-password">
<p><button class="accent">Entrar</button></p></form>${config.allowSignup ? '<p><a href="/registar">Criar conta</a></p>' : ''}`));
  });

  app.post('/entrar', async (req, reply) => {
    const b = req.body as any;
    if (!rateLimit(`login:${req.ip}`, 10, 10 * 60_000)) return reply.redirect('/entrar?e=' + encodeURIComponent('Demasiadas tentativas. Aguarde alguns minutos.'));
    const email = String(b?.email ?? '').trim().toLowerCase();
    const u = await db.one('SELECT * FROM users WHERE email=$1', [email]);
    // Verifica sempre, para não revelar por tempo de resposta se o email existe.
    const ok = await verifyPassword(String(b?.password ?? ''), u?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    if (!u || !ok) return reply.redirect('/entrar?e=' + encodeURIComponent('Credenciais inválidas.'));
    const token = newToken();
    await db.query(`INSERT INTO sessions(id, user_id, expires_at) VALUES ($1,$2, now() + interval '14 days')`, [sha256(token), u.id]);
    await setSessionCookie(reply, 'sid', token, 14 * 86400);
    await audit(db, u.email, 'login', null);
    return reply.redirect('/painel');
  });

  app.post('/sair', async (req, reply) => {
    if (req.cookies?.sid) await db.query('DELETE FROM sessions WHERE id=$1', [sha256(req.cookies.sid)]);
    reply.clearCookie('sid', { path: '/' });
    return reply.redirect('/');
  });

  const canSignup = async () => config.allowSignup || Number((await db.one('SELECT count(*)::int AS n FROM users'))?.n) === 0;

  app.get('/registar', async (req, reply) => {
    if (!(await canSignup())) return reply.code(404).send('Registo fechado');
    const q = req.query as any;
    return reply.type('text/html; charset=utf-8').send(authPage('Criar conta', `${flash(q.e, 'bad')}
<form method="post" action="/registar" class="card"><label for="n">Nome</label><input id="n" name="name" type="text" required>
<label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="username">
<label for="p">Palavra-passe (mín. 12 caracteres)</label><input id="p" name="password" type="password" minlength="12" required autocomplete="new-password">
<p class="hint">A primeira conta criada torna-se administradora.</p><p><button class="accent">Criar conta</button></p></form>`));
  });

  app.post('/registar', async (req, reply) => {
    if (!(await canSignup())) return reply.code(404).send('Registo fechado');
    const b = req.body as any;
    const name = String(b?.name ?? '').trim(), email = String(b?.email ?? '').trim().toLowerCase(), pw = String(b?.password ?? '');
    if (!name || !isEmail(email) || pw.length < 12) return reply.redirect('/registar?e=' + encodeURIComponent('Dados inválidos (palavra-passe com pelo menos 12 caracteres).'));
    if (await db.one('SELECT 1 FROM users WHERE email=$1', [email])) return reply.redirect('/registar?e=' + encodeURIComponent('Email já registado.'));
    const first = Number((await db.one('SELECT count(*)::int AS n FROM users'))?.n) === 0;
    const u = await db.one(`INSERT INTO users(email, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id`, [email, name, await hashPassword(pw), first ? 'admin' : 'interviewer']);
    await audit(db, email, 'signup', null, { role: first ? 'admin' : 'interviewer' });
    const token = newToken();
    await db.query(`INSERT INTO sessions(id, user_id, expires_at) VALUES ($1,$2, now() + interval '14 days')`, [sha256(token), u.id]);
    await setSessionCookie(reply, 'sid', token, 14 * 86400);
    return reply.redirect('/painel');
  });
}
