import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { esc, hashPassword, verifyPassword, isEmail, rateLimit, sha256, newToken, SESSION_DAYS } from '../lib.ts';
import { page, flash } from '../views.ts';
import { setSessionCookie, audit } from '../app.ts';
import { landing } from '../landing.ts';
import { S } from '../settings.ts';
import { privacyBody } from '../privacy.ts';
import { tagsFrom, ownHosts, trackVisit, campaignQuery, campaignInputs, fromOwnSite, carriedTags, withCampaign, type Tags } from '../metrics.ts';

export async function siteRoutes(app: FastifyInstance) {
  const db = app.db;

  // Landing: conta a visita (agregada, sem cookies nem IP) e passa as etiquetas da campanha aos links para o registo.
  // Quem vem de outra página do próprio site (logótipo, sair da conta, /podcasts, /e/…, /entrar) não conta: ou já foi contado
  // à chegada (landing, registo, galeria ou episódio com etiquetas), ou chegou por uma página que não conta (galeria ou episódio
  // sem etiquetas, privacidade). As etiquetas vêm do URL (a galeria e a entrada levam-nas nos links) ou do URL da página de onde veio.
  app.get('/', async (req, reply) => {
    const own = ownHosts(req.headers.host);
    const tags = tagsFrom(req.query, req.headers.referer, own);
    if (!fromOwnSite(req.headers.referer, own)) await trackVisit(req, db, '/', tags);
    return reply.type('text/html; charset=utf-8').send(landing(await db.query('SELECT * FROM plans WHERE active ORDER BY sort'), campaignQuery(tags)));
  });
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain').send('User-agent: *\nAllow: /$\nAllow: /privacy\nAllow: /e/\nAllow: /podcasts\nDisallow: /i/\nDisallow: /entrevista\nDisallow: /painel\nDisallow: /entrevistas\nDisallow: /admin\nDisallow: /account\n'));

  // Privacidade (RGPD, art. 13.º e 14.º): o texto está em src/privacy.ts.
  app.get('/privacy', async (_req, reply) => reply.type('text/html; charset=utf-8').send(page({
    lang: 'en', title: 'Privacy', desc: `How ${config.brand} handles personal data.`, body: privacyBody(),
  })));

  // ---- Autenticação ----
  const authPage = (title: string, body: string) => page({ lang: 'en', title, noindex: true, nav: '<a href="/">Home</a>', body: `<div class="narrow" style="padding-top:48px"><h1>${title}</h1>${body}</div>` });
  const startSession = async (reply: any, userId: string) => {
    const token = newToken();
    await db.query(`INSERT INTO sessions(id, user_id, expires_at) VALUES ($1,$2, now() + interval '${SESSION_DAYS} days')`, [sha256(token), userId]);
    await setSessionCookie(reply, 'sid', token, SESSION_DAYS * 86400);
  };
  const userCount = async () => Number((await db.one('SELECT count(*)::int AS n FROM users'))?.n);
  const canSignup = async () => (await userCount()) === 0 || S('SIGNUPS_OPEN') !== '0';

  // Entrada: as etiquetas da campanha que vêm da landing seguem no link «Create an account» (e no formulário, para não se
  // perderem depois de uma tentativa falhada), para que o registo feito por aqui fique na campanha que trouxe a visita.
  app.get('/entrar', async (req, reply) => {
    if (req.user) return reply.redirect('/painel');
    const q = req.query as any;
    const tags = carriedTags(q, ownHosts(req.headers.host));
    return reply.type('text/html; charset=utf-8').send(authPage('Sign in', `${flash(q.e, 'bad')}
<form method="post" action="/entrar" class="card">${campaignInputs(tags)}<label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="username">
<label for="p">Password</label><input id="p" name="password" type="password" required autocomplete="current-password">
<p><button class="accent">Sign in</button></p></form>${(await canSignup()) ? `<p>New here? <a href="${esc(withCampaign('/registar', campaignQuery(tags)))}">Create an account</a></p>` : ''}`));
  });

  app.post('/entrar', async (req, reply) => {
    const b = req.body as any;
    const cq = campaignQuery(carriedTags(b, ownHosts(req.headers.host)));
    const fail = (msg: string) => reply.redirect(withCampaign('/entrar?e=' + encodeURIComponent(msg), cq));
    if (!rateLimit(`login:${req.ip}`, 10, 10 * 60_000)) return fail('Too many attempts. Please wait a few minutes.');
    const email = String(b?.email ?? '').trim().toLowerCase();
    const u = await db.one('SELECT * FROM users WHERE email=$1', [email]);
    // Verifica sempre, para não revelar por tempo de resposta se o email existe.
    const ok = await verifyPassword(String(b?.password ?? ''), u?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    if (!u || !ok) return fail('Invalid email or password.');
    if (!u.active) return fail('This account is deactivated. Please contact support.');
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
    const ent = entitySlug(q.entidade) ? await db.one('SELECT slug, name FROM entities WHERE slug=$1 AND active', [entitySlug(q.entidade)]) : null;
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
    // A entidade volta no endereço só se tiver a forma de um slug (nada de valores enormes ou estranhos no cabeçalho Location).
    const slug = entitySlug(b?.entidade);
    const again = (msg: string) => reply.redirect('/registar?e=' + encodeURIComponent(msg) + (cq ? `&${cq}` : '') + (slug ? `&entidade=${slug}` : ''));
    const name = String(b?.name ?? '').trim().slice(0, 100), email = String(b?.email ?? '').trim().toLowerCase(), pw = String(b?.password ?? '');
    if (!name || !isEmail(email) || pw.length < 12 || !b?.terms) return again('Please complete all fields (password with at least 12 characters).');
    if (await db.one('SELECT 1 FROM users WHERE email=$1', [email])) return again('That email is already registered.');
    const first = (await userCount()) === 0;
    const ent = !first && slug ? await db.one('SELECT id FROM entities WHERE slug=$1 AND active', [slug]) : null;
    const u = await db.one(`INSERT INTO users(email, name, password_hash, role, entity_id, self_signup, utm_source, utm_medium, utm_campaign, utm_content, utm_term, signup_referrer_host)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [email, name, await hashPassword(pw), first ? 'admin' : 'interviewer', ent?.id ?? null, !first, ...signupTags(tags)]);
    await audit(db, email, 'signup', null, { role: first ? 'admin' : 'interviewer' });
    await startSession(reply, u.id);
    return reply.redirect(first ? '/admin/definicoes' : '/account');
  });
}

/** Slug de uma entidade recebido no pedido (a forma de `slugify`: minúsculas, algarismos e «-», até 100 caracteres), ou ''. */
const entitySlug = (v: unknown) => (typeof v === 'string' && /^[a-z0-9-]{1,100}$/.test(v) ? v : '');

/** Colunas da conta com as etiquetas do registo (NULL quando não há). */
const signupTags = (t: Tags) => [t.source || null, t.source ? t.medium || null : null, t.source ? t.campaign || null : null, t.source ? t.content || null : null, t.source ? t.term || null : null, t.source ? null : t.ref || null];
