import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { esc, slugify } from '../lib.ts';
import { page, flash, pill } from '../views.ts';
import { audit } from '../app.ts';
import { SETTING_DEFS, S, saveEntitySetting, entityHas, entityValue, inEntity, settingsFormError } from '../settings.ts';
import { serviceTest, settingInput, VERTEX_HINT } from './admin.ts';
import { retryFailedEmails } from '../mail.ts';

const GROUPS = ['OpenAI', 'Stripe', 'MailerSend', 'Moloni ON', 'Replicate', 'fal.ai', 'WaveSpeed', 'Google'];

export async function entityRoutes(app: FastifyInstance) {
  const db = app.db;
  const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
  const nav = (u: any) => `<a href="/painel">Painel</a><a href="/account">Conta</a>${u.role === 'admin' ? '<a href="/admin/entidades">Entidades</a><a href="/admin/utilizadores">Utilizadores</a><a href="/admin/definicoes">Definições</a>' : '<a href="/entidade">Entidade</a>'}<form method="post" action="/sair" style="display:inline"><button class="ghost" style="padding:6px 12px;min-height:0;margin-left:16px">Sair</button></form>`;
  const view = (req: any, reply: any, title: string, body: string) => reply.type('text/html; charset=utf-8').send(page({ title, body: `<div class="wrap" style="padding-top:32px">${body}</div>`, nav: nav(req.user), noindex: true }));
  const back = (reply: any, url: string, ok?: string, e?: string) => reply.redirect(url + (ok ? `?ok=${encodeURIComponent(ok)}` : e ? `?e=${encodeURIComponent(e)}` : ''));

  /** Administrador global: qualquer entidade. Gestor de entidade (entity_admin): apenas a sua. */
  const canManage = (req: any, entityId: string) => req.user && (req.user.role === 'admin' || (req.user.role === 'entity_admin' && req.user.entity_id === entityId));

  // ---- lista e criação (só administrador global) ----
  app.get('/admin/entidades', async (req, reply) => {
    if (!req.user) return reply.redirect('/entrar');
    if (req.user.role !== 'admin') return reply.code(403).send('Acesso reservado a administradores');
    const q = req.query as any;
    const rows = await db.query(`SELECT e.*, (SELECT count(*)::int FROM users u WHERE u.entity_id=e.id) AS n_users FROM entities e ORDER BY e.created_at`);
    return view(req, reply, 'Entidades', `<h1>Entidades gestoras</h1>${flash(q.ok)}${flash(q.e, 'bad')}
<p class="hint sans">Cada entidade tem as suas próprias chaves (OpenAI, Stripe, MailerSend, Moloni ON), que têm prioridade sobre as chaves globais. Sem chaves próprias, usa as globais.</p>
<div class="card" style="overflow-x:auto"><table><thead><tr><th>Entidade</th><th>Site</th><th>Utilizadores</th><th>Estado</th><th>Ligações</th></tr></thead><tbody>
${rows.map((e: any) => `<tr><td><a href="/entidades/${e.id}/chaves">${esc(e.name)}</a><br><span class="hint">${esc(e.slug)}</span></td><td>${e.url ? `<a href="${esc(e.url)}" rel="noopener">${esc(e.url)}</a>` : '—'}</td><td>${e.n_users}</td><td>${e.active ? pill('ativa', 'ok') : pill('inativa', 'bad')}</td>
<td class="hint sans">Registo: <code>${esc(config.baseUrl)}/registar?entidade=${esc(e.slug)}</code><br>Webhook Stripe: <code>${esc(config.baseUrl)}/webhooks/stripe/${esc(e.slug)}</code></td></tr>`).join('')}</tbody></table></div>
<div class="card"><h2 style="margin-top:0">Nova entidade</h2><form method="post" action="/admin/entidades"><div class="row"><div class="grow"><label for="n">Nome</label><input id="n" name="name" type="text" required></div><div class="grow"><label for="u">URL do site</label><input id="u" name="url" type="url" placeholder="https://www.exemplo.pt"></div></div><p><button class="accent">Criar entidade</button></p></form></div>`);
  });

  app.post('/admin/entidades', async (req, reply) => {
    if (!req.user || req.user.role !== 'admin') return reply.code(403).send('Acesso reservado a administradores');
    const b = req.body as any;
    const name = String(b.name ?? '').trim().slice(0, 100);
    let url = String(b.url ?? '').trim();
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) return back(reply, '/admin/entidades', undefined, 'URL inválido (deve começar por http:// ou https://).');
    if (!name) return back(reply, '/admin/entidades', undefined, 'Indique o nome.');
    const slug = slugify(name);
    if (await db.one('SELECT 1 FROM entities WHERE slug=$1', [slug])) return back(reply, '/admin/entidades', undefined, 'Já existe uma entidade com esse nome.');
    const e = await db.one('INSERT INTO entities(slug, name, url) VALUES ($1,$2,$3) RETURNING id', [slug, name, url]);
    await audit(db, req.user.email, 'entity.created', null, { entityId: e.id });
    return back(reply, `/entidades/${e.id}/chaves`, 'Entidade criada.');
  });

  app.get('/entidade', async (req, reply) => {
    if (!req.user) return reply.redirect('/entrar');
    if (!req.user.entity_id) return reply.redirect(req.user.role === 'admin' ? '/admin/entidades' : '/account');
    return reply.redirect(`/entidades/${req.user.entity_id}/chaves`);
  });

  // ---- perfil da entidade: dados + chaves ----
  app.get('/entidades/:id/chaves', async (req, reply) => {
    const id = (req.params as any).id;
    if (!req.user) return reply.redirect('/entrar');
    if (!isUuid(id) || !canManage(req, id)) return reply.code(404).send('Não encontrada');
    const e = await db.one('SELECT * FROM entities WHERE id=$1', [id]);
    if (!e) return reply.code(404).send('Não encontrada');
    const q = req.query as any;
    const src = (k: string) => (entityHas(id, k) ? 'da entidade' : inEntity(null, () => (S(k) ? 'global (reserva)' : 'por definir')));
    return view(req, reply, e.name, `<h1>${esc(e.name)} ${e.active ? pill('ativa', 'ok') : pill('inativa', 'bad')}</h1>${flash(q.ok)}${flash(q.e, 'bad')}
${req.user.role === 'admin' ? `<form method="post" action="/entidades/${e.id}" class="card"><h2 style="margin-top:0">Dados</h2><div class="row"><div class="grow"><label for="n">Nome</label><input id="n" name="name" type="text" value="${esc(e.name)}" required></div><div class="grow"><label for="u">URL do site</label><input id="u" name="url" type="url" value="${esc(e.url)}"></div></div>
<label class="check"><input type="checkbox" name="active" value="1" ${e.active ? 'checked' : ''}> Entidade ativa</label><button class="ghost">Guardar dados</button></form>` : `<p class="sans">${e.url ? `<a href="${esc(e.url)}" rel="noopener">${esc(e.url)}</a>` : ''}</p>`}
<p class="hint sans">As chaves são guardadas cifradas e nunca voltam por inteiro ao ecrã. Em branco = manter; <code>-</code> = apagar (passa a usar a chave global, se existir).</p>
<form method="post" action="/entidades/${e.id}/chaves">
${GROUPS.map(g => `<div class="card"><div class="row"><h2 style="margin:0" class="grow">${esc(g)}</h2><button type="submit" formaction="/entidades/${e.id}/testar/${encodeURIComponent(g)}" class="ghost">Guardar e testar</button></div>
${g === 'Stripe' ? `<p class="hint sans">Endpoint do webhook desta entidade, a registar no Stripe: <code>${esc(config.baseUrl)}/webhooks/stripe/${esc(e.slug)}</code> — eventos: checkout.session.completed, customer.subscription.created/updated/deleted.</p>` : ''}
${g === 'Google' ? `<p class="hint sans">${esc(VERTEX_HINT)}</p>` : ''}
${SETTING_DEFS.filter(d => d.group === g).map(d => `<label for="f_${d.key}">${esc(d.label)} <span class="hint">· ${src(d.key)}</span></label>
${settingInput(d, entityValue(id, d.key), '', d.options ? `Como na definição global (${d.options.find(o => o[0] === inEntity(null, () => S(d.key)))?.[1] ?? d.options[0][1]})` : undefined)}`).join('')}</div>`).join('')}
<p><button class="accent">Guardar chaves</button></p></form>`);
  });

  const saveFromBody = async (id: string, b: any, group?: string) => {
    for (const d of SETTING_DEFS.filter(d => !group || d.group === group)) {
      const v = typeof b[d.key] === 'string' ? b[d.key].trim() : '';
      if (d.secret) { if (v === '-') await saveEntitySetting(db, id, d.key, ''); else if (v) await saveEntitySetting(db, id, d.key, v); }
      else if (b[d.key] !== undefined) await saveEntitySetting(db, id, d.key, v === '-' ? '' : v);
    }
  };

  app.post('/entidades/:id/chaves', async (req, reply) => {
    const id = (req.params as any).id;
    if (!req.user) return reply.redirect('/entrar');
    if (!isUuid(id) || !canManage(req, id)) return reply.code(404).send('Não encontrada');
    const bad = settingsFormError(req.body as any);
    if (bad) return back(reply, `/entidades/${id}/chaves`, undefined, `Nada foi guardado: ${bad}`);
    await saveFromBody(id, req.body as any);
    if (['MAILERSEND_API_KEY', 'MAIL_FROM', 'MAIL_FROM_NAME'].some(k => typeof (req.body as any)[k] === 'string' && (req.body as any)[k].trim())) await retryFailedEmails(db);
    await audit(db, req.user.email, 'entity.keys_saved', null, { entityId: id, keys: SETTING_DEFS.filter(d => typeof (req.body as any)[d.key] === 'string' && (req.body as any)[d.key].trim()).map(d => d.key) });
    return back(reply, `/entidades/${id}/chaves`, 'Chaves guardadas.');
  });

  app.post('/entidades/:id/testar/:group', async (req, reply) => {
    const id = (req.params as any).id, g = decodeURIComponent((req.params as any).group);
    if (!req.user) return reply.redirect('/entrar');
    if (!isUuid(id) || !canManage(req, id) || !GROUPS.includes(g)) return reply.code(404).send('Não encontrada');
    const bad = settingsFormError(req.body as any, SETTING_DEFS.filter(d => d.group === g));
    if (bad) return back(reply, `/entidades/${id}/chaves`, undefined, `Nada foi guardado: ${bad}`);
    await saveFromBody(id, req.body as any, g);
    if (g === 'MailerSend') await retryFailedEmails(db);
    try { const msg = await inEntity(id, () => serviceTest(db, g, req.user!.email)); return back(reply, `/entidades/${id}/chaves`, msg); }
    catch (err: any) { return back(reply, `/entidades/${id}/chaves`, undefined, `Teste falhou: ${String(err.message).slice(0, 400)}`); }
  });

  app.post('/entidades/:id', async (req, reply) => {
    const id = (req.params as any).id;
    if (!req.user || req.user.role !== 'admin') return reply.code(403).send('Acesso reservado a administradores');
    if (!isUuid(id)) return reply.code(404).send();
    const b = req.body as any;
    const url = String(b.url ?? '').trim();
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) return back(reply, `/entidades/${id}/chaves`, undefined, 'URL inválido.');
    await db.query('UPDATE entities SET name=$2, url=$3, active=$4 WHERE id=$1', [id, String(b.name ?? '').trim().slice(0, 100) || 'Entidade', url, !!b.active]);
    await audit(db, req.user.email, 'entity.updated', null, { entityId: id });
    return back(reply, `/entidades/${id}/chaves`, 'Dados guardados.');
  });
}
