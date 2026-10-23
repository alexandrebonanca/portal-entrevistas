import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { esc, hashPassword, verifyPassword, isEmail, rateLimit, sha256, newToken, SESSION_DAYS } from '../lib.ts';
import { page, flash } from '../views.ts';
import { setSessionCookie, audit } from '../app.ts';
import { landing } from '../landing.ts';
import { S } from '../settings.ts';
import { privacyBody } from '../privacy.ts';
import { tagsFrom, ownHosts, trackVisit, campaignQuery, campaignInputs, fromOwnSite, carriedTags, withCampaign, type Tags } from '../metrics.ts';
import { freeOfferOn, freeLimits } from '../free-interview.ts';
import { sendVerification, verificationState, confirmEmail, VERIFY_HOURS, VERIFY_RESEND_PER_HOUR, VERIFY_PER_DAY, VERIFY_TOTAL } from '../email-verify.ts';

/** Páginas para onde «Reenviar» (email de confirmação) pode voltar; outra qualquer volta ao painel. */
const resendBack = (v: unknown) => (typeof v === 'string' && (v === '/painel' || v === '/account' || /^\/entrevistas\/[0-9a-f-]{36}\/convidar$/.test(v)) ? v : '/painel');

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
    // A 1.ª entrevista grátis só se anuncia com a oferta ligada (com os limites do plano Start, lidos da tabela).
    const free = freeOfferOn() ? await freeLimits(db) : null;
    return reply.type('text/html; charset=utf-8').send(landing(await db.query('SELECT * FROM plans WHERE active ORDER BY sort'), campaignQuery(tags), free));
  });
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain').send('User-agent: *\nAllow: /$\nAllow: /privacy\nAllow: /e/\nAllow: /podcasts\nDisallow: /i/\nDisallow: /entrevista\nDisallow: /painel\nDisallow: /entrevistas\nDisallow: /admin\nDisallow: /account\nDisallow: /confirmar-email\n'));

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
    // A oferta é do registo público sem entidade (as entidades têm faturação própria), com o email confirmado.
    // Há um número limitado de entrevistas grátis por dia e por mês (tetos): «while available».
    const free = !first && !ent && freeOfferOn() ? `<p class="hint sans">Your first interview is free: after you sign up, we email you a link to confirm your email address (valid for ${VERIFY_HOURS} hours). Once it is confirmed, you can send your first invitation with no payment and no card details, while available.</p>` : '';
    return reply.type('text/html; charset=utf-8').send(authPage(first ? 'Create the administrator account' : 'Create your account', `${flash(q.e, 'bad')}${free}
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
    // Email confirmado à partida: a primeira conta (administradora) e as de uma entidade (pelo link de registo da entidade,
    // que não têm a 1.ª entrevista grátis); o registo público recebe o email «Confirm your email».
    const verified = first || !!ent;
    const u = await db.one(`INSERT INTO users(email, name, password_hash, role, entity_id, self_signup, utm_source, utm_medium, utm_campaign, utm_content, utm_term, signup_referrer_host, email_verified_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $13::boolean THEN now() END) RETURNING id`, [email, name, await hashPassword(pw), first ? 'admin' : 'interviewer', ent?.id ?? null, !first, ...signupTags(tags), verified]);
    // Uma falha a pôr o email na fila não desfaz o registo: a conta fica por confirmar e o painel deixa pedir outro. Com a
    // oferta desligada (um teto a 0) não há email: ele só serve a 1.ª entrevista grátis, e prometê-la-ia (a conta fica por
    // confirmar; se a oferta voltar, o painel pede o link com «Reenviar»).
    const sent = verified ? null : !freeOfferOn() ? 'off' as const : await sendVerification(db, u.id).catch(e => { req.log.error({ err: String(e?.message ?? e) }, 'registo: email de confirmação não posto na fila'); return 'error' as const; });
    await audit(db, email, 'signup', null, { role: first ? 'admin' : 'interviewer', ...(sent ? { emailVerification: sent } : {}) });
    await startSession(reply, u.id);
    return reply.redirect(first ? '/admin/definicoes' : '/account');
  });

  // ---- Confirmação do email da conta (link do email «Confirm your email») ----
  // O GET só mostra o estado e o botão (um leitor de links do correio não confirma nada); o POST confirma. Sem sessão:
  // o link pode ser aberto noutro aparelho. A página não guarda cache nem passa o endereço (com o token) a outros sites.
  const verifyPage = (reply: any, body: string, code = 200) => reply.code(code).header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(authPage('Confirm your email', body));
  // (genéricas: com a oferta desligada, o painel não mostra «Reenviar», e a confirmação deixa de fazer falta)
  const VERIFY_MSG = {
    used: (verified: boolean) => `This link has already been used.${verified ? ' Your email is confirmed.' : ''}`,
    expired: 'This link has expired. A confirmed email is needed only for the free first interview: while it is offered, you can sign in and ask for a new link on your dashboard.',
    invalid: 'This link is not valid. Check that you opened the whole address. A confirmed email is needed only for the free first interview: while it is offered, you can sign in and ask for a new link on your dashboard.',
  };
  // Link gasto: 200 (a página explica); expirado: 410; desconhecido: 404.
  const verifyCode = (s: string) => (s === 'expired' ? 410 : s === 'invalid' ? 404 : 200);
  const signIn = (req: any) => (req.user ? '<p><a class="btn accent" href="/painel">Go to your dashboard</a></p>' : '<p><a class="btn accent" href="/entrar">Sign in</a></p>');

  app.get('/confirmar-email/:token', async (req, reply) => {
    const token = (req.params as any).token;
    const st = await verificationState(db, token);
    if (st.state === 'valid' && !st.verified) return verifyPage(reply, `<p>Press the button to confirm the email address of your ${esc(config.brand)} account.</p>
<form method="post" action="/confirmar-email" class="card"><input type="hidden" name="token" value="${esc(token)}"><button class="accent">Confirm my email</button></form>`);
    if (st.state === 'valid') return verifyPage(reply, `<p>Your email is already confirmed.</p>${signIn(req)}`);
    return verifyPage(reply, `<p>${st.state === 'used' ? VERIFY_MSG.used(st.verified) : VERIFY_MSG[st.state]}</p>${signIn(req)}`, verifyCode(st.state));
  });

  app.post('/confirmar-email', async (req, reply) => {
    if (!rateLimit(`verify:${req.ip}`, 30, 10 * 60_000)) return verifyPage(reply, '<p>Too many attempts. Please wait a few minutes.</p>', 429);
    const r = await confirmEmail(db, (req.body as any)?.token);
    if (r.result === 'ok' || r.result === 'already') {
      const u = await db.one('SELECT email FROM users WHERE id=$1', [r.userId]);
      if (r.result === 'ok' && u) await audit(db, u.email, 'email.verified', null);
      if (req.user?.id === r.userId) return reply.redirect('/painel?ok=' + encodeURIComponent('Email confirmado.') + '#gratis');
      return verifyPage(reply, `<p>Your email is confirmed.</p>${signIn(req)}`);
    }
    return verifyPage(reply, `<p>${r.result === 'used' ? VERIFY_MSG.used(!!r.verified) : VERIFY_MSG[r.result]}</p>${signIn(req)}`, verifyCode(r.result));
  });

  // «Reenviar» (painel, página do convite ou Conta): um link novo, dentro do total da conta (VERIFY_PER_DAY em 24 horas e
  // VERIFY_TOTAL ao todo, o do registo incluído, contados na base) e do teto global dos emails de confirmação; em memória,
  // no máximo VERIFY_RESEND_PER_HOUR pedidos por conta e por hora. Com a oferta desligada, nenhum (o email fala da
  // entrevista grátis).
  app.post('/confirmar-email/reenviar', async (req, reply) => {
    if (!req.user) return reply.redirect('/entrar');
    const back = resendBack((req.body as any)?.voltar), en = back === '/account';
    const go = (kind: 'ok' | 'e', pt: string, enMsg: string) => reply.redirect(`${back}?${kind}=${encodeURIComponent(en ? enMsg : pt)}#gratis`);
    if (!freeOfferOn()) return go('e', 'A 1.ª entrevista grátis não está disponível neste momento: não é preciso confirmar o email.', 'The free first interview is not offered at the moment, so there is no need to confirm your email.');
    if (!rateLimit(`verify-resend:${req.user.id}`, VERIFY_RESEND_PER_HOUR, 3600_000))
      return go('e', 'Já pediu vários emails de confirmação nesta hora. Tente mais tarde.', 'You have asked for several confirmation emails this hour. Please try again later.');
    const r = await sendVerification(db, req.user.id);
    if (r === 'verified') return go('ok', 'O seu email já está confirmado.', 'Your email is already confirmed.');
    if (r === 'total_limit') return go('e', `Já enviámos a esta conta o número máximo de emails de confirmação (${VERIFY_TOTAL}): não é possível pedir outro. Procure-os na sua caixa de correio (também no spam).`,
      `We have already sent this account the maximum number of confirmation emails (${VERIFY_TOTAL}), so no more can be requested. Look for them in your inbox (and spam folder).`);
    if (r === 'day_limit') return go('e', `Já enviámos ${VERIFY_PER_DAY} emails de confirmação a esta conta nas últimas 24 horas. Procure-os na sua caixa de correio (também no spam) ou peça outro mais tarde.`,
      `We have sent ${VERIFY_PER_DAY} confirmation emails to this account in the last 24 hours. Look for them in your inbox (and spam folder) or ask for another one later.`);
    if (r !== 'sent') return go('e', 'Não foi possível enviar o email agora. Tente mais tarde.', 'We could not send the email right now. Please try again later.');
    await audit(db, req.user.email, 'email.verification_sent', null);
    return go('ok', `Enviámos uma ligação nova para ${req.user.email}.`, `We sent a new link to ${req.user.email}.`);
  });
}

/** Slug de uma entidade recebido no pedido (a forma de `slugify`: minúsculas, algarismos e «-», até 100 caracteres), ou ''. */
const entitySlug = (v: unknown) => (typeof v === 'string' && /^[a-z0-9-]{1,100}$/.test(v) ? v : '');

/** Colunas da conta com as etiquetas do registo (NULL quando não há). */
const signupTags = (t: Tags) => [t.source || null, t.source ? t.medium || null : null, t.source ? t.campaign || null : null, t.source ? t.content || null : null, t.source ? t.term || null : null, t.source ? null : t.ref || null];
