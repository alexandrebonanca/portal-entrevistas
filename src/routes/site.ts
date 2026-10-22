import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { esc, hashPassword, verifyPassword, isEmail, rateLimit, sha256, newToken } from '../lib.ts';
import { page, flash } from '../views.ts';
import { setSessionCookie, audit } from '../app.ts';
import { landing } from '../landing.ts';
import { S } from '../settings.ts';
import { ASSISTANT_LOG_DAYS } from '../assistant.ts';
import { tagsFrom, ownHosts, trackVisit, campaignQuery, campaignInputs, fromOwnSite, type Tags } from '../metrics.ts';

export async function siteRoutes(app: FastifyInstance) {
  const db = app.db;

  // Landing: conta a visita (agregada, sem cookies nem IP) e passa as etiquetas da campanha aos links para o registo.
  // Quem volta à landing a partir do próprio site (logótipo, sair da conta, /podcasts, /entrar) já foi contado ao chegar: não
  // conta outra vez, e as etiquetas vêm do URL da página de onde veio, quando as tiver.
  app.get('/', async (req, reply) => {
    const own = ownHosts(req.headers.host);
    const tags = tagsFrom(req.query, req.headers.referer, own);
    if (!fromOwnSite(req.headers.referer, own)) await trackVisit(req, db, '/', tags);
    return reply.type('text/html; charset=utf-8').send(landing(await db.query('SELECT * FROM plans WHERE active ORDER BY sort'), campaignQuery(tags)));
  });
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain').send('User-agent: *\nAllow: /$\nAllow: /privacy\nAllow: /e/\nAllow: /podcasts\nDisallow: /i/\nDisallow: /entrevista\nDisallow: /painel\nDisallow: /entrevistas\nDisallow: /admin\nDisallow: /account\n'));

  app.get('/privacy', async (_req, reply) => reply.type('text/html; charset=utf-8').send(page({
    lang: 'en', title: 'Privacy',
    body: `<div class="narrow" style="padding-top:40px"><h1>Privacy</h1>
<p>${esc(config.brand)} processes interview recordings and optional photos on behalf of the interviewer who invited you. This page summarises how; the invitation and the consent screen you see before recording are the authoritative statements for your interview.</p>
<h2>What we store</h2><ul><li>Your name and email (to send the invitation).</li><li>Your recorded answers and any photos you choose to add.</li><li>Your consent choices, with the exact text shown and the time.</li></ul>
<h2>External services</h2><p>If you allow it, audio is sent to an AI provider for transcription, translation and synthetic narration. Photos are never sent to AI services by default. Subscription payments are handled by Stripe; we never see card numbers.</p>
<h2>Publication</h2><p>Nothing is published without the interviewer’s decision and, by default, your approval of the final version. Originals and unselected photos stay private.</p>
<h2>Help assistant and support</h2><p>Questions typed into the help assistant are stored for ${ASSISTANT_LOG_DAYS} days without any link to the person who asked (emails, links and long numbers are masked), to improve the answers. Guests’ questions are answered only from the portal’s frequently asked questions and are never sent to AI services. For interviewers with an active subscription and for entity managers, the text of the question alone may be sent to an AI provider (OpenAI) to draft a short answer from those entries. Messages to support stay inside the portal (no email is sent) and are deleted together with the interview or the account.</p>
<h2>Composition assistant</h2><p>When an interviewer with access to it asks the composition assistant on the interview edit page for suggestions, the saved title, goal, roles and question texts of that draft, and the optional request typed in the panel, are sent to OpenAI to draft suggestions (emails, website addresses and phone numbers in the usual formats are masked first); the name and email fields and the personal message are not sent. The portal keeps only a daily count of requests per account, not the texts or the suggestions.</p>
<h2>Campaign links</h2><p>Visits to the home page and the sign-up page are counted in aggregate per day, by page and by the campaign tags in the link (or the website you came from), without cookies, IP addresses or anything else that identifies you. When you sign up after following a campaign link, the campaign tags (or the website you came from) are kept with your account to measure campaign results.</p>
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
    const own = ownHosts(req.headers.host);
    const tags = tagsFrom(q, req.headers.referer, own);
    // Só conta quem chega de fora (link de campanha, outro site ou direto): vindo da landing, a visita já foi contada lá.
    if (!fromOwnSite(req.headers.referer, own)) await trackVisit(req, db, '/registar', tags);
    const first = (await userCount()) === 0;
    const ent = q.entidade ? await db.one('SELECT slug, name FROM entities WHERE slug=$1 AND active', [String(q.entidade)]) : null;
    return reply.type('text/html; charset=utf-8').send(authPage(first ? 'Create the administrator account' : 'Create your account', `${flash(q.e, 'bad')}
<form method="post" action="/registar" class="card">${campaignInputs(tags)}${ent ? `<input type="hidden" name="entidade" value="${esc(ent.slug)}"><p class="hint sans">Registering with <strong>${esc(ent.name)}</strong></p>` : ''}<label for="n">Name</label><input id="n" name="name" type="text" required>
<label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="username">
<label for="p">Password (at least 12 characters)</label><input id="p" name="password" type="password" minlength="12" required autocomplete="new-password">
<label class="check"><input type="checkbox" name="terms" value="1" required> <span>I will only invite people for consent-based interviews, and I accept the <a href="/privacy">privacy notice</a>.</span></label>
<p><button class="accent">Create account</button></p></form>`));
  });

  app.post('/registar', async (req, reply) => {
    if (!(await canSignup())) return reply.code(404).send('Sign-ups are closed');
    if (!rateLimit(`signup:${req.ip}`, 10, 3600_000)) return reply.redirect('/registar?e=' + encodeURIComponent('Too many sign-ups from this address. Try later.'));
    const b = req.body as any;
    // Etiquetas da campanha vindas do formulário: normalizadas de novo (nunca se confia no formulário).
    const tags = tagsFrom(b, undefined, ownHosts(req.headers.host));
    const cq = campaignQuery(tags);
    const again = (msg: string) => reply.redirect('/registar?e=' + encodeURIComponent(msg) + (cq ? `&${cq}` : '') + (b?.entidade ? `&entidade=${encodeURIComponent(String(b.entidade))}` : ''));
    const name = String(b?.name ?? '').trim().slice(0, 100), email = String(b?.email ?? '').trim().toLowerCase(), pw = String(b?.password ?? '');
    if (!name || !isEmail(email) || pw.length < 12 || !b?.terms) return again('Please complete all fields (password with at least 12 characters).');
    if (await db.one('SELECT 1 FROM users WHERE email=$1', [email])) return again('That email is already registered.');
    const first = (await userCount()) === 0;
    const ent = !first && b.entidade ? await db.one('SELECT id FROM entities WHERE slug=$1 AND active', [String(b.entidade)]) : null;
    const u = await db.one(`INSERT INTO users(email, name, password_hash, role, entity_id, self_signup, utm_source, utm_medium, utm_campaign, utm_content, utm_term, signup_referrer_host)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [email, name, await hashPassword(pw), first ? 'admin' : 'interviewer', ent?.id ?? null, !first, ...signupTags(tags)]);
    await audit(db, email, 'signup', null, { role: first ? 'admin' : 'interviewer' });
    await startSession(reply, u.id);
    return reply.redirect(first ? '/admin/definicoes' : '/account');
  });
}

/** Colunas da conta com as etiquetas do registo (NULL quando não há). */
const signupTags = (t: Tags) => [t.source || null, t.source ? t.medium || null : null, t.source ? t.campaign || null : null, t.source ? t.content || null : null, t.source ? t.term || null : null, t.source ? null : t.ref || null];
