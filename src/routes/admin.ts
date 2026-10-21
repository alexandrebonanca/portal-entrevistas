import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { esc, fmtDate, hashPassword, isEmail } from '../lib.ts';
import { page, flash, pill } from '../views.ts';
import { audit } from '../app.ts';
import { quotaFor, ACTIVE_STATUSES, stripe } from '../billing.ts';
import { SETTING_DEFS, S, maskSetting, saveSetting, fromDb, secretFingerprint, settingsFormError, type SettingDef } from '../settings.ts';
import { queueEmail, emailShell, flushOutbox, retryFailedEmails } from '../mail.ts';

/** Campo de uma definição: segredo (nunca devolvido), lista de opções ou texto. `blank` é a opção sem valor guardado. */
export function settingInput(d: SettingDef, value: string, blank: string, blankLabel?: string) {
  if (d.options) return `<select id="f_${d.key}" name="${d.key}">${blankLabel !== undefined ? `<option value="" ${value ? '' : 'selected'}>${esc(blankLabel)}</option>` : ''}${d.options.map(([v, l]) => `<option value="${esc(v)}" ${(value || blank) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return `<input id="f_${d.key}" name="${d.key}" type="${d.secret ? 'password' : 'text'}" autocomplete="${d.secret ? 'new-password' : 'off'}" data-lpignore="true" spellcheck="false" placeholder="${esc(d.secret ? maskSetting(d.key, value) || (d.hint ?? '') : (d.hint ?? ''))}" value="${d.secret ? '' : esc(value)}">`;
}
export const VERTEX_HINT = 'O Google Veo usa o Vertex AI quando há conta de serviço (Veo 3.1 Fast: veo-3.1-fast-generate-001; Lite: veo-3.1-lite-generate-001, em pré-visualização). Sem conta de serviço usa a Gemini API, que a Google desliga para estes modelos a partir de 22/10/2026. A chave JSON nunca volta a ser mostrada: aparece só o email da conta e o projeto.';

const STATUSES: [string, string][] = [['active', 'Ativa'], ['comped', 'Oferta (sem cobrança)'], ['trialing', 'Em teste'], ['past_due', 'Pagamento em atraso'], ['canceled', 'Cancelada'], ['inactive', 'Inativa']];
const eur = (c: number) => `€${(c / 100).toFixed(2)}`;

export async function serviceTest(db: any, g: string, userEmail: string): Promise<string> {
  let msg = '';
  if (g === 'OpenAI') {
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${S('OPENAI_API_KEY')}` } });
    if (!r.ok) throw new Error(`OpenAI respondeu ${r.status}`);
    msg = 'OpenAI: chave válida.';
  } else if (g === 'Stripe') {
    const bal = await stripe('balance', undefined, 'GET');
    msg = `Stripe: ligação OK (${bal.livemode ? 'modo real' : 'modo de teste'}).${S('STRIPE_WEBHOOK_SECRET') ? '' : ' Falta o webhook signing secret.'}`;
  } else if (g === 'MailerSend') {
    const key = `test:${Date.now()}`;
    await queueEmail(db, { key, to: userEmail, subject: 'Teste de email', html: emailShell('Teste de email', '<p>Se recebeu esta mensagem, o MailerSend está configurado.</p>'), text: 'Teste de email: MailerSend configurado.' });
    await flushOutbox(db);
    const last = await db.one(`SELECT state, error FROM emails WHERE dedupe_key=$1`, [key]);
    if (last.state !== 'sent') throw new Error(last.error ?? 'envio falhou');
    msg = `MailerSend: mensagem de teste aceite para ${userEmail}.`;
  } else if (g === 'Replicate') {
    const { replicateAccount } = await import('../lipsync.ts');
    const acc = await replicateAccount();
    msg = `Replicate: token válido (conta ${acc.username ?? acc.name ?? 'OK'}).`;
  } else if (g === 'fal.ai') {
    // Pedido real mas sem campos obrigatórios: chave errada → 401/403; chave certa → 422 (validação), sem custo.
    // Igual ao cliente oficial: «Authorization: Key <FAL_KEY>», com a chave tal como o painel a dá (fal_sk_… ou id:segredo).
    const key = S('FAL_KEY');
    const fp = secretFingerprint(key);
    if (!key) throw new Error('falta a chave da fal.ai');
    if (/[^!-~]/.test(key)) throw new Error(`a chave guardada não é uma chave completa (${fp}). No painel da fal.ai a lista mostra a chave abreviada com «…»; a chave completa só aparece ao criá-la.`);
    const r = await fetch('https://queue.fal.run/fal-ai/infinitalk', { method: 'POST', headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }, body: '{}' });
    const body = (await r.text()).slice(0, 160);
    if (r.status === 401 || r.status === 403) throw new Error(`fal.ai recusou a chave guardada (${fp}). Compare com a chave no painel da fal.ai. Resposta: ${body}`);
    if (r.status !== 422 && r.status !== 400) throw new Error(`fal.ai respondeu ${r.status} (${fp}): ${body}`);
    msg = `fal.ai: chave válida (${fp}); verificação sem custo.`;
  } else if (g === 'WaveSpeed') {
    const r = await fetch('https://api.wavespeed.ai/api/v3/predictions/00000000/result', { headers: { Authorization: `Bearer ${S('WAVESPEED_API_KEY')}` } });
    if (r.status === 401 || r.status === 403) throw new Error(`WaveSpeed recusou a chave (${r.status})`);
    msg = 'WaveSpeed: chave aceite.';
  } else if (g === 'Google') {
    // Vertex AI (conta de serviço) se houver; senão a Gemini API. Nunca gera vídeo.
    const { veoCheck } = await import('../talking.ts');
    msg = await veoCheck();
  } else if (g === 'Moloni ON') {
    const r = await fetch('https://api.moloni.pt/v1/grant/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: S('MOLONI_CLIENT_ID'), client_secret: S('MOLONI_CLIENT_SECRET'), username: S('MOLONI_USERNAME'), password: S('MOLONI_PASSWORD') }).toString() });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`Moloni: ${j.error_description ?? j.error ?? r.status}`);
    msg = 'Moloni ON: autenticação OK. (A emissão automática de faturas ainda não está ligada.)';
  }
  return msg;
}

export async function adminRoutes(app: FastifyInstance) {
  const db = app.db;
  const adminNav = `<a href="/painel">Painel</a><a href="/admin/utilizadores">Utilizadores</a><a href="/admin/definicoes">Definições</a><a href="/admin/laboratorio">Laboratório</a><form method="post" action="/sair" style="display:inline"><button class="ghost" style="padding:6px 12px;min-height:0;margin-left:16px">Sair</button></form>`;
  const view = (reply: any, title: string, body: string) => reply.type('text/html; charset=utf-8').send(page({ title, body: `<div class="wrap" style="padding-top:32px">${body}</div>`, nav: adminNav, noindex: true }));
  const guard = (req: any, reply: any) => {
    if (!req.user) { reply.redirect('/entrar'); return false; }
    if (req.user.role !== 'admin') { reply.code(403).send('Acesso reservado a administradores'); return false; }
    return true;
  };
  const back = (reply: any, url: string, ok?: string, e?: string) => reply.redirect(url + (ok ? `?ok=${encodeURIComponent(ok)}` : e ? `?e=${encodeURIComponent(e)}` : ''));

  app.get('/admin', async (req, reply) => { if (!guard(req, reply)) return; return reply.redirect('/admin/utilizadores'); });

  // ---------- utilizadores ----------
  app.get('/admin/utilizadores', async (req, reply) => {
    if (!guard(req, reply)) return;
    const q = req.query as any;
    const users = await db.query(`SELECT u.*, en.name AS entity_name, s.status AS sub_status, s.source, p.name AS plan_name FROM users u LEFT JOIN entities en ON en.id=u.entity_id LEFT JOIN subscriptions s ON s.user_id=u.id LEFT JOIN plans p ON p.id=s.plan_id ORDER BY u.created_at DESC`);
    const plans = await db.query('SELECT * FROM plans ORDER BY sort');
    const entities = await db.query('SELECT id, name FROM entities WHERE active ORDER BY name');
    const rows = [];
    for (const u of users) { const qt = await quotaFor(db, u); rows.push({ u, qt }); }
    return view(reply, 'Utilizadores', `<h1>Utilizadores</h1>${flash(q.ok)}${flash(q.e, 'bad')}
<div class="card" style="overflow-x:auto"><table><thead><tr><th>Nome</th><th>Email</th><th>Perfil</th><th>Entidade</th><th>Conta</th><th>Subscrição</th><th>Uso</th><th></th></tr></thead><tbody>
${rows.map(({ u, qt }) => `<tr><td><a href="/admin/utilizadores/${u.id}">${esc(u.name)}</a></td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${esc(u.entity_name ?? '—')}</td>
<td>${u.active ? pill('ativa', 'ok') : pill('desativada', 'bad')}</td>
<td>${u.role === 'admin' ? '—' : u.sub_status ? `${esc(u.plan_name ?? '—')} ${pill(u.sub_status, ACTIVE_STATUSES.includes(u.sub_status) ? 'ok' : 'warn')} <span class="hint">${esc(u.source)}</span>` : pill('nenhuma')}</td>
<td>${u.role === 'admin' ? '∞' : `${qt.used}/${qt.limit}`}</td>
<td><form method="post" action="/admin/utilizadores/${u.id}/estado"><input type="hidden" name="active" value="${u.active ? '0' : '1'}"><button class="${u.active ? 'danger' : 'accent'}" style="padding:6px 12px;min-height:0">${u.active ? 'Desativar' : 'Ativar'}</button></form></td></tr>`).join('')}</tbody></table></div>
<div class="card"><h2 style="margin-top:0">Criar utilizador</h2><form method="post" action="/admin/utilizadores">
<div class="row"><div class="grow"><label for="n">Nome</label><input id="n" name="name" type="text" required></div><div class="grow"><label for="e">Email</label><input id="e" name="email" type="email" required></div></div>
<div class="row"><div class="grow"><label for="p">Palavra-passe inicial (mín. 12)</label><input id="p" name="password" type="password" minlength="12" required autocomplete="new-password"></div>
<div class="grow"><label for="r">Perfil</label><select id="r" name="role"><option value="interviewer">Entrevistador</option><option value="entity_admin">Gestor de entidade (chaves)</option><option value="admin">Administrador</option></select></div>
<div class="grow"><label for="en">Entidade</label><select id="en" name="entity_id"><option value="">Nenhuma</option>${entities.map((e: any) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select></div>
<div class="grow"><label for="pl">Plano (sem cobrança, atribuído manualmente)</label><select id="pl" name="plan_id"><option value="">Nenhum</option>${plans.map((p: any) => `<option value="${esc(p.id)}">${esc(p.name)} — ${p.interviews_per_month}/mês</option>`).join('')}</select></div></div>
<p class="hint">Comunique a palavra-passe ao utilizador por um canal seguro; ele pode alterá-la pedindo uma redefinição ao administrador.</p><button class="accent">Criar utilizador</button></form></div>`);
  });

  app.post('/admin/utilizadores', async (req, reply) => {
    if (!guard(req, reply)) return;
    const b = req.body as any;
    const email = String(b.email ?? '').trim().toLowerCase(), name = String(b.name ?? '').trim(), pw = String(b.password ?? '');
    if (!name || !isEmail(email) || pw.length < 12) return back(reply, '/admin/utilizadores', undefined, 'Dados inválidos (palavra-passe com pelo menos 12 caracteres).');
    if (await db.one('SELECT 1 FROM users WHERE email=$1', [email])) return back(reply, '/admin/utilizadores', undefined, 'Já existe um utilizador com esse email.');
    const role = ['admin', 'entity_admin'].includes(b.role) ? b.role : 'interviewer';
    const ent = b.entity_id && /^[0-9a-f-]{36}$/i.test(b.entity_id) ? await db.one('SELECT id FROM entities WHERE id=$1', [b.entity_id]) : null;
    if (role === 'entity_admin' && !ent) return back(reply, '/admin/utilizadores', undefined, 'Um gestor de entidade precisa de uma entidade.');
    const u = await db.one('INSERT INTO users(email, name, password_hash, role, entity_id) VALUES ($1,$2,$3,$4,$5) RETURNING id', [email, name, await hashPassword(pw), role, ent?.id ?? null]);
    const plan = b.plan_id && (await db.one('SELECT id FROM plans WHERE id=$1', [b.plan_id]));
    if (plan && role !== 'admin') await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source) VALUES ($1,$2,'comped','manual')`, [u.id, plan.id]);
    await audit(db, req.user!.email, 'admin.user_created', null, { userId: u.id, role });
    return back(reply, '/admin/utilizadores', 'Utilizador criado.');
  });

  app.post('/admin/utilizadores/:id/estado', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = (req.params as any).id, active = (req.body as any).active === '1';
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send();
    if (!active) {
      if (id === req.user!.id) return back(reply, '/admin/utilizadores', undefined, 'Não pode desativar a sua própria conta.');
      const target = await db.one('SELECT role FROM users WHERE id=$1', [id]);
      if (target?.role === 'admin' && Number((await db.one(`SELECT count(*)::int n FROM users WHERE role='admin' AND active`)).n) <= 1) return back(reply, '/admin/utilizadores', undefined, 'Tem de existir pelo menos um administrador ativo.');
    }
    await db.query('UPDATE users SET active=$2 WHERE id=$1', [id, active]);
    if (!active) await db.query('DELETE FROM sessions WHERE user_id=$1', [id]); // termina as sessões abertas
    await audit(db, req.user!.email, active ? 'admin.user_activated' : 'admin.user_deactivated', null, { userId: id });
    return back(reply, '/admin/utilizadores', active ? 'Conta ativada.' : 'Conta desativada e sessões terminadas.');
  });

  app.get('/admin/utilizadores/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const u = await db.one('SELECT * FROM users WHERE id=$1', [(req.params as any).id.match(/^[0-9a-f-]{36}$/i)?.[0] ?? '00000000-0000-0000-0000-000000000000']);
    if (!u) return reply.code(404).send('Não encontrado');
    const q = req.query as any;
    const sub = await db.one('SELECT * FROM subscriptions WHERE user_id=$1', [u.id]);
    const plans = await db.query('SELECT * FROM plans ORDER BY sort');
    const entities = await db.query('SELECT id, name FROM entities ORDER BY name');
    const qt = await quotaFor(db, u);
    const iv = await db.query('SELECT id, title, collection_status, invited_at FROM interviews WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 10', [u.id]);
    const date = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : '');
    return view(reply, u.name, `<p><a href="/admin/utilizadores">← Utilizadores</a></p><h1>${esc(u.name)} ${u.active ? pill('ativa', 'ok') : pill('desativada', 'bad')}</h1>${flash(q.ok)}${flash(q.e, 'bad')}
<div class="card"><h2 style="margin-top:0">Conta</h2><p class="sans">${esc(u.email)} · criada em ${fmtDate(u.created_at)}${u.stripe_customer_id ? ' · Stripe: ' + esc(u.stripe_customer_id) : ''}</p>
<form method="post" action="/admin/utilizadores/${u.id}/perfil" class="row"><select name="role" aria-label="Perfil" style="width:auto"><option value="interviewer" ${u.role === 'interviewer' ? 'selected' : ''}>Entrevistador</option><option value="entity_admin" ${u.role === 'entity_admin' ? 'selected' : ''}>Gestor de entidade (chaves)</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrador</option></select>
<select name="entity_id" aria-label="Entidade" style="width:auto"><option value="">Sem entidade</option>${entities.map((e: any) => `<option value="${e.id}" ${u.entity_id === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select><button class="ghost">Guardar perfil</button></form>
<form method="post" action="/admin/utilizadores/${u.id}/palavra-passe"><label for="np">Redefinir palavra-passe (mín. 12; termina as sessões)</label><div class="row"><input id="np" name="password" type="password" minlength="12" autocomplete="new-password" style="max-width:320px"><button class="ghost">Redefinir</button></div></form></div>
<div class="card"><h2 style="margin-top:0">Subscrição</h2>
<p class="sans">Uso neste período: <strong>${u.role === 'admin' ? '∞' : `${qt.used}/${qt.limit}`}</strong>${sub?.stripe_subscription_id ? ` · Stripe: ${esc(sub.stripe_subscription_id)}` : ''}${sub?.current_period_end ? ` · período até ${fmtDate(sub.current_period_end)}` : ''}</p>
<form method="post" action="/admin/utilizadores/${u.id}/subscricao">
<div class="row"><div class="grow"><label for="pl">Plano</label><select id="pl" name="plan_id"><option value="">Nenhum</option>${plans.map((p: any) => `<option value="${esc(p.id)}" ${sub?.plan_id === p.id ? 'selected' : ''}>${esc(p.name)} — ${eur(p.price_cents)} · ${p.interviews_per_month}/mês</option>`).join('')}</select></div>
<div class="grow"><label for="st">Estado</label><select id="st" name="status">${STATUSES.map(([v, l]) => `<option value="${v}" ${sub?.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
<div class="row"><div class="grow"><label for="pe">Fim do período</label><input id="pe" name="period_end" type="date" value="${date(sub?.current_period_end)}"></div>
<div class="grow"><label for="ov">Limite mensal personalizado (vazio = o do plano)</label><input id="ov" name="override" type="number" min="0" value="${sub?.interviews_override ?? ''}"></div></div>
<p class="hint">Alterações manuais não alteram a cobrança no Stripe: para cancelar ou reembolsar uma subscrição paga, use o painel do Stripe.</p><button class="accent">Guardar subscrição</button></form></div>
<div class="card"><h2 style="margin-top:0">Entrevistas recentes</h2>${iv.length ? `<table><tbody>${iv.map((i: any) => `<tr><td><a href="/entrevistas/${i.id}">${esc(i.title)}</a></td><td>${esc(i.collection_status)}</td><td>${fmtDate(i.invited_at)}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">Sem entrevistas.</p>'}</div>`);
  });

  app.post('/admin/utilizadores/:id/perfil', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = (req.params as any).id, rb = req.body as any, role = ['admin', 'entity_admin'].includes(rb.role) ? rb.role : 'interviewer';
    if (id === req.user!.id && role !== 'admin') return back(reply, `/admin/utilizadores/${id}`, undefined, 'Não pode retirar o seu próprio perfil de administrador.');
    const ent = rb.entity_id && /^[0-9a-f-]{36}$/i.test(rb.entity_id) ? await db.one('SELECT id FROM entities WHERE id=$1', [rb.entity_id]) : null;
    if (role === 'entity_admin' && !ent) return back(reply, `/admin/utilizadores/${id}`, undefined, 'Um gestor de entidade precisa de uma entidade.');
    await db.query('UPDATE users SET role=$2, entity_id=$3 WHERE id=$1', [id, role, ent?.id ?? null]);
    await audit(db, req.user!.email, 'admin.role_changed', null, { userId: id, role });
    return back(reply, `/admin/utilizadores/${id}`, 'Perfil guardado.');
  });

  app.post('/admin/utilizadores/:id/palavra-passe', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = (req.params as any).id, pw = String((req.body as any).password ?? '');
    if (pw.length < 12) return back(reply, `/admin/utilizadores/${id}`, undefined, 'A palavra-passe precisa de pelo menos 12 caracteres.');
    await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [id, await hashPassword(pw)]);
    await db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    await audit(db, req.user!.email, 'admin.password_reset', null, { userId: id });
    return back(reply, `/admin/utilizadores/${id}`, 'Palavra-passe redefinida; sessões terminadas.');
  });

  app.post('/admin/utilizadores/:id/subscricao', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = (req.params as any).id, b = req.body as any;
    const plan = b.plan_id ? await db.one('SELECT id FROM plans WHERE id=$1', [b.plan_id]) : null;
    const status = STATUSES.some(s => s[0] === b.status) ? b.status : 'inactive';
    const end = b.period_end ? new Date(b.period_end) : null;
    const override = b.override === '' || b.override === undefined ? null : Math.max(0, parseInt(b.override) || 0);
    await db.query(
      `INSERT INTO subscriptions(user_id, plan_id, status, source, current_period_end, interviews_override) VALUES ($1,$2,$3,'manual',$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET plan_id=$2, status=$3, current_period_end=$4, interviews_override=$5, updated_at=now()`, [id, plan?.id ?? null, status, end, override]);
    await audit(db, req.user!.email, 'admin.subscription_set', null, { userId: id, plan: plan?.id, status });
    return back(reply, `/admin/utilizadores/${id}`, 'Subscrição guardada.');
  });

  // ---------- definições (chaves) e planos ----------
  app.get('/admin/definicoes', async (req, reply) => {
    if (!guard(req, reply)) return;
    const q = req.query as any;
    const groups = [...new Set(SETTING_DEFS.map(d => d.group))];
    const plans = await db.query('SELECT * FROM plans ORDER BY sort');
    const signups = S('SIGNUPS_OPEN') !== '0';
    return view(reply, 'Definições', `<h1>Definições</h1>${flash(q.ok)}${flash(q.e, 'bad')}
<p class="hint sans">As chaves são guardadas cifradas e nunca voltam a ser mostradas por inteiro. Deixe um campo em branco para manter o valor atual; escreva <code>-</code> para o apagar. Uma variável de ambiente com o mesmo nome serve de valor de reserva.</p>
<form method="post" action="/admin/definicoes">
${groups.map(g => `<div class="card"><div class="row"><h2 style="margin:0" class="grow">${esc(g)}</h2>${['OpenAI', 'Stripe', 'MailerSend', 'Moloni ON', 'Replicate', 'fal.ai', 'WaveSpeed', 'Google'].includes(g) ? `<button type="submit" formaction="/admin/definicoes/testar/${encodeURIComponent(g)}" class="ghost" name="testar" value="1">Guardar e testar</button>` : ''}</div>
${g === 'Stripe' ? `<p class="hint sans">Endpoint do webhook a registar no Stripe: <code>${esc(config.baseUrl)}/webhooks/stripe</code> — eventos: checkout.session.completed, customer.subscription.created/updated/deleted.</p>` : ''}
${g === 'Google' ? `<p class="hint sans">${esc(VERTEX_HINT)}</p>` : ''}
${SETTING_DEFS.filter(d => d.group === g).map(d => `<label for="f_${d.key}">${esc(d.label)} <span class="hint">${S(d.key) ? (fromDb(d.key) ? '· definido' : '· definido por variável de ambiente') : '· por definir'}</span></label>
${settingInput(d, S(d.key), d.options?.[0]?.[0] ?? '')}`).join('')}</div>`).join('')}
<div class="card"><h2 style="margin-top:0">Registo de utilizadores</h2><label class="check"><input type="checkbox" name="signups_open" value="1" ${signups ? 'checked' : ''}> Permitir que novos utilizadores se registem (e subscrevam um plano)</label>
<label class="check"><input type="checkbox" name="ai_video_open" value="1" ${S('AI_VIDEO_OPEN') === '1' ? 'checked' : ''}> Permitir vídeo IA (Google Veo e retratos animados) a todos os entrevistadores, sem orçamento — pago pelas chaves do portal ou da entidade. Desligado: só o administrador o pede.</label></div>
<p><button class="accent">Guardar definições</button></p></form>
<div class="card"><h2 style="margin-top:0">Planos</h2><p class="hint sans">Alterar o preço afeta apenas novas subscrições; as existentes mantêm o preço contratado no Stripe.</p>
${plans.map((p: any) => `<form method="post" action="/admin/planos/${esc(p.id)}" class="row" style="margin:8px 0"><strong style="min-width:90px">${esc(p.id)}</strong><input name="name" value="${esc(p.name)}" aria-label="Nome" style="width:140px"><input name="price" type="number" step="0.01" min="0" value="${(p.price_cents / 100).toFixed(2)}" aria-label="Preço mensal (EUR)" style="width:110px">€/mês<input name="limit" type="number" min="0" value="${p.interviews_per_month}" aria-label="Entrevistas por mês" style="width:90px">entrevistas/mês<label class="check" style="margin:0"><input type="checkbox" name="active" value="1" ${p.active ? 'checked' : ''}> ativo</label><button class="ghost">Guardar</button></form>`).join('')}</div>`);
  });

  app.post('/admin/definicoes', async (req, reply) => {
    if (!guard(req, reply)) return;
    const b = req.body as any;
    const bad = settingsFormError(b);
    if (bad) return back(reply, '/admin/definicoes', undefined, `Nada foi guardado: ${bad}`);
    for (const d of SETTING_DEFS) {
      const v = typeof b[d.key] === 'string' ? b[d.key].trim() : '';
      if (d.secret) { if (v === '-') await saveSetting(db, d.key, ''); else if (v) await saveSetting(db, d.key, v); }
      else if (b[d.key] !== undefined) await saveSetting(db, d.key, v === '-' ? '' : v);
    }
    await saveSetting(db, 'SIGNUPS_OPEN', b.signups_open ? '1' : '0');
    await saveSetting(db, 'AI_VIDEO_OPEN', b.ai_video_open ? '1' : '');
    if (['MAILERSEND_API_KEY', 'MAIL_FROM', 'MAIL_FROM_NAME'].some(k => typeof b[k] === 'string' && b[k].trim())) await retryFailedEmails(db);
    await audit(db, req.user!.email, 'admin.settings_saved', null, { keys: SETTING_DEFS.filter(d => typeof b[d.key] === 'string' && b[d.key].trim()).map(d => d.key) });
    return back(reply, '/admin/definicoes', 'Definições guardadas.');
  });

  app.post('/admin/definicoes/testar/:group', async (req, reply) => {
    if (!guard(req, reply)) return;
    const g = decodeURIComponent((req.params as any).group), b = req.body as any;
    const bad = settingsFormError(b, SETTING_DEFS.filter(d => d.group === g));
    if (bad) return back(reply, '/admin/definicoes', undefined, `Nada foi guardado: ${bad}`);
    for (const d of SETTING_DEFS.filter(d => d.group === g)) {
      const v = typeof b[d.key] === 'string' ? b[d.key].trim() : '';
      if (v && v !== '-') await saveSetting(db, d.key, v);
    }
    if (g === 'MailerSend') await retryFailedEmails(db);
    try {
      const msg = await serviceTest(db, g, req.user!.email);
      return back(reply, '/admin/definicoes', msg);
    } catch (e: any) { return back(reply, '/admin/definicoes', undefined, `Teste falhou: ${String(e.message).slice(0, 400)}`); }
  });

  app.post('/admin/planos/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const b = req.body as any;
    const cents = Math.round(parseFloat(String(b.price).replace(',', '.')) * 100), lim = parseInt(b.limit);
    if (!Number.isFinite(cents) || cents < 0 || !Number.isFinite(lim) || lim < 0) return back(reply, '/admin/definicoes', undefined, 'Valores do plano inválidos.');
    await db.query('UPDATE plans SET name=$2, price_cents=$3, interviews_per_month=$4, active=$5 WHERE id=$1', [(req.params as any).id, String(b.name ?? '').slice(0, 60) || 'Plano', cents, lim, !!b.active]);
    await audit(db, req.user!.email, 'admin.plan_updated', null, { plan: (req.params as any).id });
    return back(reply, '/admin/definicoes', 'Plano guardado.');
  });
}
