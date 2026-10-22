import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import { config, assertProductionConfig } from './config.ts';
import type { Db } from './db.ts';
import { sha256, newToken } from './lib.ts';
import { storage } from './storage.ts';
import { siteRoutes } from './routes/site.ts';
import { interviewerRoutes } from './routes/interviewer.ts';
import { productionRoutes } from './routes/production.ts';
import { guestRoutes } from './routes/guest.ts';
import { episodeRoutes } from './routes/episode.ts';
import { billingRoutes } from './routes/billing.ts';
import { creditRoutes } from './routes/credits.ts';
import { adminRoutes } from './routes/admin.ts';
import { entityRoutes } from './routes/entities.ts';
import { labRoutes } from './routes/lab.ts';
import { quoteRoutes } from './routes/quotes.ts';
import { introRoutes } from './routes/intro.ts';
import { supportRoutes } from './routes/support.ts';
import { assistantAdminRoutes } from './routes/assistant.ts';
import { seedAssistant } from './assistant-faq.ts';
import { loadSettings } from './settings.ts';

declare module 'fastify' {
  interface FastifyInstance { db: Db }
  interface FastifyRequest {
    // support_unread: respostas do suporte por ler; support_inbox: pedidos por ler na caixa do administrador.
    user?: { id: string; email: string; name: string; role: string; entity_id: string | null; support_unread?: number; support_inbox?: number };
    guest?: { interviewId: string; invitationId: string; supportUnread?: number };
    // Sessão de convidado cujo convite deixou de valer (cancelado, recusado ou substituído): só lê os pedidos ao suporte.
    guestHelp?: { interviewId: string; supportUnread?: number };
  }
}

export async function buildApp(db: Db): Promise<FastifyInstance> {
  assertProductionConfig();
  const app = Fastify({ logger: config.production ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] } : false, bodyLimit: config.limits.maxUploadMb * 1024 * 1024, trustProxy: config.trustProxy as any });
  app.decorate('db', db);
  await loadSettings(db);
  // Semente do assistente: entradas novas e o texto atual nas que o administrador não alterou (as alterações dele ficam).
  const seeded = await seedAssistant(db);
  if (seeded.inserted || seeded.updated) app.log.info(seeded, 'base do assistente: semente aplicada');
  await app.register(cookie);
  await app.register(formbody);
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  for (const type of ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-m4a', 'audio/aac', 'video/webm', 'video/mp4', 'image/jpeg', 'image/png', 'application/octet-stream']) {
    app.addContentTypeParser(type, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  }
  // O Content-Type pode trazer parâmetros (codecs=opus): normalizar para o prefixo.
  app.addHook('onRequest', async (req) => {
    const ct = req.headers['content-type'];
    if (ct && /^(audio|video|image)\//.test(ct)) req.headers['content-type'] = ct.split(';')[0].trim();
  });

  // Em produção, sem TRUST_PROXY definido: regista uma vez quantos endereços traz o X-Forwarded-For (sem os mostrar),
  // para acertar o número de saltos dos proxies.
  let xffLogged = false;
  app.addHook('onRequest', async (req) => {
    if (xffLogged || !config.production || config.trustProxy !== true || !req.headers['x-forwarded-for']) return;
    xffLogged = true;
    req.log.info({ xffEntries: String(req.headers['x-forwarded-for']).split(',').length }, 'X-Forwarded-For: número de endereços (defina TRUST_PROXY)');
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'microphone=(self), camera=(self), geolocation=()');
    return payload;
  });

  // CSRF: pedidos com efeitos têm de vir da própria origem.
  app.addHook('onRequest', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const site = req.headers['sec-fetch-site'];
    const origin = req.headers.origin;
    if (site && !['same-origin', 'none'].includes(String(site))) return reply.code(403).send('Pedido entre origens recusado');
    // Origin "null" (ex.: política de referrer restritiva) só é aceite se o próprio browser declarar mesma origem.
    if (origin === 'null') { if (String(site) !== 'same-origin') return reply.code(403).send('Origem inválida'); }
    else if (origin) {
      // Atrás de proxy (Render) o Host pode variar: aceita o Host, o X-Forwarded-Host e o host de BASE_URL.
      const allowed = new Set<string>();
      for (const h of [req.headers.host, req.headers['x-forwarded-host'], new URL(config.baseUrl).host]) {
        for (const v of String(h ?? '').split(',')) if (v.trim()) allowed.add(v.trim().toLowerCase());
      }
      try { if (!allowed.has(new URL(origin).host.toLowerCase())) { req.log.warn({ origin, allowed: [...allowed] }, 'origem recusada'); return reply.code(403).send('Origem inválida'); } }
      catch { return reply.code(403).send('Origem inválida'); }
    }
  });

  app.addHook('preHandler', async (req) => {
    const sid = req.cookies?.sid;
    if (sid) {
      // Contadores do suporte interno para a navegação (índices parciais: só as linhas por ler).
      const u = await db.one(`SELECT u.id,u.email,u.name,u.role,u.entity_id,
          (SELECT count(*)::int FROM support_threads t WHERE t.user_id=u.id AND t.unread_user) AS support_unread,
          CASE WHEN u.role='admin' THEN (SELECT count(*)::int FROM support_threads t WHERE t.unread_admin) ELSE 0 END AS support_inbox
        FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>now() AND u.active`, [sha256(sid)]);
      if (u) req.user = u;
    }
    const gs = req.cookies?.gs;
    if (gs) {
      const g = await db.one(`SELECT gs.interview_id, gs.invitation_id, (i.revoked_at IS NULL AND i.declined_at IS NULL AND i.expires_at>now()) AS active,
          (SELECT count(*)::int FROM support_threads t WHERE t.interview_id=gs.interview_id AND t.unread_user) AS support_unread
        FROM guest_sessions gs JOIN invitations i ON i.id=gs.invitation_id
        WHERE gs.id=$1 AND gs.expires_at>now()`, [sha256(gs)]);
      if (g?.active) req.guest = { interviewId: g.interview_id, invitationId: g.invitation_id, supportUnread: g.support_unread };
      // Convite cancelado, recusado ou substituído: a sessão (até ao prazo dela) só serve para ler as respostas do suporte.
      else if (g) req.guestHelp = { interviewId: g.interview_id, supportUnread: g.support_unread };
    }
  });

  await siteRoutes(app);
  await interviewerRoutes(app);
  await productionRoutes(app);
  await guestRoutes(app);
  await episodeRoutes(app);
  await billingRoutes(app);
  await creditRoutes(app);
  await adminRoutes(app);
  await entityRoutes(app);
  await labRoutes(app);
  await quoteRoutes(app);
  await introRoutes(app);
  await supportRoutes(app);
  await assistantAdminRoutes(app);

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).type('text/html').send('<!doctype html><meta charset=utf-8><title>404</title><p style="font:18px system-ui;padding:40px">404 — página não encontrada. <a href="/">Início</a>');
  });
  app.setErrorHandler((err: any, req, reply) => {
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send(err.message);
    req.log.error({ err: err.message }, 'erro'); if (!config.production) console.error(err);
    reply.code(500).type('text/plain').send('Erro interno');
  });
  return app;
}

export const isHtml = (reply: FastifyReply) => reply.type('text/html; charset=utf-8');

/** Cria sessão e define cookie HttpOnly. */
export async function setSessionCookie(reply: FastifyReply, name: 'sid' | 'gs', token: string, maxAgeSec: number) {
  reply.setCookie(name, token, { httpOnly: true, secure: config.production, sameSite: 'lax', path: '/', maxAge: maxAgeSec });
}
export const makeToken = newToken;

export function requireUser(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) { reply.redirect('/entrar'); return false; }
  return true;
}

export async function ownedInterview(app: FastifyInstance, req: FastifyRequest, id: string) {
  if (!req.user || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined; // um id malformado dava erro 500 no Postgres
  return app.db.one(`SELECT * FROM interviews WHERE id=$1 AND (owner_id=$2 OR $3='admin')`, [id, req.user.id, req.user.role]);
}

export async function audit(db: Db, actor: string, action: string, interviewId: string | null, meta: object = {}) {
  await db.query(`INSERT INTO audit_events(actor, action, interview_id, meta) VALUES ($1,$2,$3,$4)`, [actor, action, interviewId, JSON.stringify(meta)]);
}

/** Serve um ativo com suporte a Range (necessário para áudio em Safari). A autorização é feita antes de chamar. */
export async function sendAsset(req: FastifyRequest, reply: FastifyReply, asset: { storage_key: string; mime: string; size: number | string }, opts: { cache?: string; download?: string } = {}) {
  const size = Number(asset.size);
  reply.header('Accept-Ranges', 'bytes').header('Content-Type', asset.mime).header('Cache-Control', opts.cache ?? 'private, no-store');
  if (opts.download) reply.header('Content-Disposition', `attachment; filename="${opts.download}"`);
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (m && size) {
    let start = m[1] ? parseInt(m[1]) : size - parseInt(m[2] || '0');
    let end = m[1] && m[2] ? Math.min(parseInt(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1);
    return reply.send(await storage.stream(asset.storage_key, { start, end }));
  }
  reply.header('Content-Length', size);
  return reply.send(await storage.stream(asset.storage_key));
}
