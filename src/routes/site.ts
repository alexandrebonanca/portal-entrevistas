import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { esc, hashPassword, verifyPassword, isEmail, rateLimit, sha256, newToken } from '../lib.ts';
import { page, flash } from '../views.ts';
import { setSessionCookie, audit } from '../app.ts';
import { landing } from '../landing.ts';
import { S } from '../settings.ts';
import { ASSISTANT_LOG_DAYS } from '../assistant.ts';

export async function siteRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(landing(await db.query('SELECT * FROM plans WHERE active ORDER BY sort'))));
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain').send('User-agent: *\nAllow: /$\nAllow: /privacy\nAllow: /e/\nAllow: /podcasts\nDisallow: /i/\nDisallow: /entrevista\nDisallow: /painel\nDisallow: /entrevistas\nDisallow: /admin\nDisallow: /account\n'));

  app.get('/privacy', async (_req, reply) => reply.type('text/html; charset=utf-8').send(page({
    lang: 'en', title: 'Privacy',
    body: `<div class="narrow" style="padding-top:40px"><h1>Privacy</h1>
<p>${esc(config.brand)} processes interview recordings and optional photos on behalf of the interviewer who invited you. This page summarises how; the invitation and the consent screen you see before recording are the authoritative statements for your interview.</p>
<h2>What we store</h2><ul><li>Your name and email (to send the invitation).</li><li>Your recorded answers and any photos you choose to add.</li><li>Your consent choices, with the exact text shown and the time.</li></ul>
<h2>External services</h2><p>If you allow it, audio is sent to an AI provider for transcription, translation and synthetic narration. Photos are never sent to AI services by default. Subscription payments are handled by Stripe; we never see card numbers.</p>
<h2>Publication</h2><p>Nothing is published without the interviewer’s decision and, by default, your approval of the final version. Originals and unselected photos stay private.</p>
<h2>Help assistant and support</h2><p>Questions typed into the help assistant are stored for ${ASSISTANT_LOG_DAYS} days without any link to the person who asked (emails, links and long numbers are masked), to improve the answers. Guests’ questions are answered only from the portal’s frequently asked questions and are never sent to AI services. For interviewers with an active subscription, the text of the question alone may be sent to an AI provider (OpenAI) to draft a short answer from those entries. Messages to support stay inside the portal (no email is sent) and are deleted together with the interview or the account.</p>
<h2>Your rights</h2><p>Ask for access, correction, withdrawal of consent or deletion at <a href="mailto:${esc(config.supportEmail)}">${esc(config.supportEmail)}</a>. Copies already downloaded or distributed elsewhere may not be recoverable.</p>
<p class="hint">The processor list, retention periods and legal bases are maintained in the operator’s documentation and must be completed before production use.</p></div>`,
  })));

  // ---- Autenticação ----
  const authPage = (title: string, body: string) => page({ lang: 'en', title, noindex: true, nav: '<a href="/">Home</a>', body: `<div class="narrow" style="padding-top:48px"><h1>${title}</h1>${body}</div>` });
  const startSession = async (reply: any, userId: string) => {
    const token = newToken();
    await db.query(`INSERT INTO sessions(id, user_id, expires_at) VALUES ($1,$2, now() + interval '14 days')`, [sha256(token), userId]);
    await setSessionCookie(reply, 'sid', token, 14 * 86400);
  };
  const userCount = async () => Number((await db.one('SELECT count(*)::int AS n FROM users'))?.n);
  const canSignup = async () => (await userCount()) === 0 || S('SIGNUPS_OPEN') !== '0';

  app.get('/entrar', async (req, reply) => {
    if (req.user) return reply.redirect('/painel');
    const q = req.query as any;
    return reply.type('text/html; charset=utf-8').send(authPage('Sign in', `${flash(q.e, 'bad')}
<form method="post" action="/entrar" class="card"><label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="username">
<label for="p">Password</label><input id="p" name="password" type="password" required autocomplete="current-password">
<p><button class="accent">Sign in</button></p></form>${(await canSignup()) ? '<p>New here? <a href="/registar">Create an account</a></p>' : ''}`));
  });

  app.post('/entrar', async (req, reply) => {
    const b = req.body as any;
    if (!rateLimit(`login:${req.ip}`, 10, 10 * 60_000)) return reply.redirect('/entrar?e=' + encodeURIComponent('Too many attempts. Please wait a few minutes.'));
    const email = String(b?.email ?? '').trim().toLowerCase();
    const u = await db.one('SELECT * FROM users WHERE email=$1', [email]);
    // Verifica sempre, para não revelar por tempo de resposta se o email existe.
    const ok = await verifyPassword(String(b?.password ?? ''), u?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    if (!u || !ok) return reply.redirect('/entrar?e=' + encodeURIComponent('Invalid email or password.'));
    if (!u.active) return reply.redirect('/entrar?e=' + encodeURIComponent('This account is deactivated. Please contact support.'));
    await startSession(reply, u.id);
    await audit(db, u.email, 'login', null);
    return reply.redirect(u.role === 'admin' ? '/painel' : '/account');
  });

  app.post('/sair', async (req, reply) => {
    if (req.cookies?.sid) await db.query('DELETE FROM sessions WHERE id=$1', [sha256(req.cookies.sid)]);
    reply.clearCookie('sid', { path: '/' });
    return reply.redirect('/');
  });

  app.get('/registar', async (req, reply) => {
    if (!(await canSignup())) return reply.code(404).send('Sign-ups are closed');
    const q = req.query as any;
    const first = (await userCount()) === 0;
    const ent = q.entidade ? await db.one('SELECT slug, name FROM entities WHERE slug=$1 AND active', [String(q.entidade)]) : null;
    return reply.type('text/html; charset=utf-8').send(authPage(first ? 'Create the administrator account' : 'Create your account', `${flash(q.e, 'bad')}
<form method="post" action="/registar" class="card">${ent ? `<input type="hidden" name="entidade" value="${esc(ent.slug)}"><p class="hint sans">Registering with <strong>${esc(ent.name)}</strong></p>` : ''}<label for="n">Name</label><input id="n" name="name" type="text" required>
<label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="username">
<label for="p">Password (at least 12 characters)</label><input id="p" name="password" type="password" minlength="12" required autocomplete="new-password">
<label class="check"><input type="checkbox" name="terms" value="1" required> <span>I will only invite people for consent-based interviews, and I accept the <a href="/privacy">privacy notice</a>.</span></label>
<p><button class="accent">Create account</button></p></form>`));
  });

  app.post('/registar', async (req, reply) => {
    if (!(await canSignup())) return reply.code(404).send('Sign-ups are closed');
    if (!rateLimit(`signup:${req.ip}`, 10, 3600_000)) return reply.redirect('/registar?e=' + encodeURIComponent('Too many sign-ups from this address. Try later.'));
    const b = req.body as any;
    const name = String(b?.name ?? '').trim().slice(0, 100), email = String(b?.email ?? '').trim().toLowerCase(), pw = String(b?.password ?? '');
    if (!name || !isEmail(email) || pw.length < 12 || !b?.terms) return reply.redirect('/registar?e=' + encodeURIComponent('Please complete all fields (password with at least 12 characters).'));
    if (await db.one('SELECT 1 FROM users WHERE email=$1', [email])) return reply.redirect('/registar?e=' + encodeURIComponent('That email is already registered.'));
    const first = (await userCount()) === 0;
    const ent = !first && b.entidade ? await db.one('SELECT id FROM entities WHERE slug=$1 AND active', [String(b.entidade)]) : null;
    const u = await db.one(`INSERT INTO users(email, name, password_hash, role, entity_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [email, name, await hashPassword(pw), first ? 'admin' : 'interviewer', ent?.id ?? null]);
    await audit(db, email, 'signup', null, { role: first ? 'admin' : 'interviewer' });
    await startSession(reply, u.id);
    return reply.redirect(first ? '/admin/definicoes' : '/account');
  });
}
