import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { esc, fmtDate, hashPassword, isEmail } from '../lib.ts';
import { page, flash, pill } from '../views.ts';
import { audit } from '../app.ts';
import { quotaFor, noSubscriptionNeeded, ACTIVE_STATUSES, stripe, savedTaxRates, STRIPE_EVENTS, refundTopup, sendRefund } from '../billing.ts';
import { findWallet, ledgerCheck, RefundError, cr, REFUND_WINDOW_DAYS } from '../wallet.ts';
import { SETTING_DEFS, S, maskSetting, saveSetting, saveStripeScoped, fromDb, secretFingerprint, settingsFormError, isSupportEmail, SELLER_GROUP, type SettingDef } from '../settings.ts';
import { seller, sellerWarnings, sameCompany, savedStripeAccount } from '../legal.ts';
import { REGIME_LABEL, regionalRate, countryName, eurPt, fmtRate } from '../vat.ts';
import { queueEmail, emailShell, flushOutbox, retryFailedEmails } from '../mail.ts';
import { allRates, recommendedCentsPerMin, QUOTE_STATUS } from '../quotes.ts';
import { helpNav } from '../support.ts';
import { freeInterviewFor, FREE_REASON_PT } from '../free-interview.ts';
import { lastVerificationAt } from '../email-verify.ts';

/** Campo de uma definição: segredo (nunca devolvido), lista de opções ou texto. `blank` é a opção sem valor guardado. */
export function settingInput(d: SettingDef, value: string, blank: string, blankLabel?: string) {
  // Conta de serviço: caixa de várias linhas (o ficheiro tem várias; um campo de palavra-passe atrai o gestor de
  // palavras-passe do browser) com o texto mascarado, e um botão que lê o ficheiro .json no browser, sem a área de transferência.
  if (d.key === 'VERTEX_SA_JSON') return `<textarea id="f_${d.key}" name="${d.key}" rows="3" autocomplete="off" data-lpignore="true" spellcheck="false" style="font:.85rem ui-monospace,monospace;-webkit-text-security:disc" placeholder="${esc(maskSetting(d.key, value) || (d.hint ?? ''))}"></textarea>
<p class="hint sans" style="margin:4px 0 12px"><button type="button" class="ghost" data-json-pick="f_${d.key}">Escolher o ficheiro .json</button><input type="file" accept=".json,application/json" data-json-into="f_${d.key}" hidden> <span id="f_${d.key}_st" role="status"></span></p>
<script>(()=>{const f=document.querySelector('[data-json-into="f_${d.key}"]'),b=document.querySelector('[data-json-pick="f_${d.key}"]'),t=document.getElementById('f_${d.key}'),s=document.getElementById('f_${d.key}_st');
const say=()=>{const v=t.value.trim();s.textContent=!v?'':(v.match(/"type"\\s*:/g)||[]).length>1?'Atenção: o texto parece colado mais do que uma vez ('+v.length+' caracteres).':v[0]!=='{'?'Atenção: isto não parece o ficheiro .json da conta de serviço ('+v.length+' caracteres).':v.length+' caracteres prontos: carregue em «Guardar e testar».';};
b.addEventListener('click',()=>f.click());t.addEventListener('input',say);
f.addEventListener('change',async()=>{const x=f.files&&f.files[0];if(!x)return;try{t.value=await x.text();say();}catch(e){s.textContent='Não foi possível ler o ficheiro: escolha-o de novo.';}f.value='';});})();</script>`;
  if (d.options) return `<select id="f_${d.key}" name="${d.key}">${blankLabel !== undefined ? `<option value="" ${value ? '' : 'selected'}>${esc(blankLabel)}</option>` : ''}${d.options.map(([v, l]) => `<option value="${esc(v)}" ${(value || blank) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return `<input id="f_${d.key}" name="${d.key}" type="${d.secret ? 'password' : 'text'}" autocomplete="${d.secret ? 'new-password' : 'off'}" data-lpignore="true" spellcheck="false" placeholder="${esc(d.secret ? maskSetting(d.key, value) || (d.hint ?? '') : (d.hint ?? ''))}" value="${d.secret ? '' : esc(value)}">`;
}
export const SELLER_HINT = 'Quem vende ao cliente final (a Telecert Consultoria Lda): a dona da conta Stripe configurada acima e do Moloni em que se emitem as faturas. A Certif Int Association OÜ é a entidade gestora da plataforma e não vende (é ela que aparece no rodapé). Por omissão, os dados da Telecert Consultoria Lda (denominação, NIF, morada e Livro de Reclamações) e, enquanto não for indicado o email da vendedora, o da entidade gestora; apagar um campo volta ao valor por omissão. Aparecem nas páginas de compra, nos termos e nos orçamentos. Os dados legais nunca se inventam: enquanto faltarem a denominação, o NIF e a morada, os pagamentos em linha ficam suspensos para quem não é administrador; sem o email e a ligação do Livro de Reclamações Eletrónico, fica bloqueada a venda a consumidores. O OSS só se liga quando as vendas a consumidores de outros países da UE (de todas as atividades da empresa) passarem 10 000 €/ano (art. 6.º-A do CIVA).';
export const VERTEX_HINT = 'O Google Veo usa o Vertex AI quando há conta de serviço (Veo 3.1 Fast: veo-3.1-fast-generate-001; Lite: veo-3.1-lite-generate-001, em pré-visualização). Sem conta de serviço usa a Gemini API, que a Google desliga para estes modelos a partir de 22/10/2026. A chave JSON nunca volta a ser mostrada: aparece só o email da conta e o projeto.';

/** Uso do período na lista de utilizadores: sem limite mensal para o administrador e o gestor de entidade. */
const usage = (u: any, qt: { used: number; limit: number }) => (u.role === 'admin' ? '∞' : u.role === 'entity_admin' ? `${qt.used} este mês (sem limite)` : `${qt.used}/${qt.limit}`);

const STATUSES: [string, string][] = [['active', 'Ativa'], ['comped', 'Oferta (sem cobrança)'], ['trialing', 'Em teste'], ['past_due', 'Pagamento em atraso'], ['canceled', 'Cancelada'], ['inactive', 'Inativa']];
const eur = (c: number) => `€${(c / 100).toFixed(2)}`;

/** Prazo da fatura: 5.º dia útil depois do pagamento (CIVA, art. 36.º, n.º 1, al. a); só fins de semana, sem feriados). */
export function invoiceDeadline(paid: Date | string) {
  const d = new Date(paid);
  let n = 0;
  while (n < 5) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) n++; }
  return d;
}

/** Avisos de uma linha «por faturar»: provas do país contraditórias, taxa diferente da do código postal, pagamento sem IVA decidido. */
export function invoiceFlags(r: any): string[] {
  const out: string[] = [];
  const ev = r.evidence ?? {}, cc = r.customer_country;
  if (r.total_cents < 0) out.push('valor negativo: emitir nota de crédito');
  if (!r.vat_regime) out.push('subscrição anterior a esta versão (IVA não decidido no portal): confirmar o IVA com o contabilista');
  if (ev.billingCountry && cc && ev.billingCountry !== cc) out.push(`morada de faturação na Stripe (${ev.billingCountry}) ≠ país declarado (${cc})`);
  else if (ev.billingCountry === 'PT' && r.vat_regime === 'domestic' && r.vat_country === 'PT' && ev.billingPostal && regionalRate('PT', ev.billingPostal) !== Number(r.vat_rate))
    out.push(`o código postal da Stripe (${ev.billingPostal}) dá IVA de ${regionalRate('PT', ev.billingPostal)}%, foi cobrado ${fmtRate(Number(r.vat_rate))}%`);
  if (ev.cardCountry && cc && ev.cardCountry !== cc) out.push(`cartão emitido em ${ev.cardCountry} (país declarado ${cc}): confirmar o país do cliente`);
  if (r.vat_regime === 'reverse_charge' && ev.vatStatus !== 'verified') out.push('número de IVA sem verificação no VIES');
  if (!r.seller?.nif) out.push('empresa vendedora sem NIF no momento do pagamento');
  return out;
}

export async function serviceTest(db: any, g: string, userEmail: string): Promise<string> {
  let msg = '';
  if (g === 'OpenAI') {
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${S('OPENAI_API_KEY')}` } });
    if (!r.ok) throw new Error(`OpenAI respondeu ${r.status}`);
    msg = 'OpenAI: chave válida.';
  } else if (g === 'Stripe') {
    const bal = await stripe('balance', undefined, 'GET');
    // Nome da conta (pedido sem custo): as chaves têm de ser as da empresa vendedora. Uma chave restrita pode não o dar.
    let acct: any = null;
    try { acct = await stripe('account', undefined, 'GET'); } catch { /* sem o nome da conta */ }
    const name = String(acct?.settings?.dashboard?.display_name || acct?.business_profile?.name || acct?.company?.name || '').slice(0, 200);
    if (acct) await saveStripeScoped(db, 'STRIPE_ACCOUNT', JSON.stringify({ id: acct.id ?? null, name, checkedAt: new Date().toISOString() }));
    const s = seller(), who = s.name || s.tradeName;
    const same = !name || !who ? '' : sameCompany(name, [s.name, s.tradeName]) ? ` Conta «${name}», a da empresa vendedora.`
      : ` Atenção: a conta Stripe chama-se «${name}» e a empresa vendedora é «${who}»: confirme que as chaves são as da conta Stripe da empresa vendedora.`;
    msg = `Stripe: ligação OK (${bal.livemode ? 'modo real' : 'modo de teste'}).${same}${S('STRIPE_WEBHOOK_SECRET') ? '' : ' Falta o webhook signing secret.'}`;
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
    if (!S('WAVESPEED_API_KEY')) throw new Error('falta a chave da WaveSpeed (a chave da API da HeyGen vai no grupo «HeyGen», mais abaixo)');
    const r = await fetch('https://api.wavespeed.ai/api/v3/predictions/00000000/result', { headers: { Authorization: `Bearer ${S('WAVESPEED_API_KEY')}` } });
    if (r.status === 401 || r.status === 403) throw new Error(`WaveSpeed recusou a chave (${r.status})`);
    msg = 'WaveSpeed: chave aceite.';
  } else if (g === 'HeyGen') {
    // Conta e saldo da API (GET /v3/users/me): sem custo.
    const key = S('HEYGEN_API_KEY');
    if (!key) throw new Error('falta a chave da API da HeyGen (platform.heygen.com → Chaves de API)');
    const r = await fetch('https://api.heygen.com/v3/users/me', { headers: { 'x-api-key': key } });
    const j: any = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) throw new Error(`a HeyGen recusou a chave (${r.status}): confirme a chave em platform.heygen.com → Chaves de API`);
    if (!r.ok) throw new Error(`HeyGen respondeu ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
    const d = j?.data ?? j;
    const bal = d?.balance ?? d?.wallet?.balance ?? d?.remaining_balance;
    msg = `HeyGen: chave válida${d?.email ? ` (${d.email})` : ''}${bal != null ? `; saldo da API: ${bal}` : ''}.`;
  } else if (g === 'Google') {
    // Vertex AI (conta de serviço) se houver; senão a Gemini API. Nunca gera vídeo.
    const { veoCheck } = await import('../talking.ts');
    msg = await veoCheck();
  } else if (g === 'Moloni ON') {
    const r = await fetch('https://api.moloni.pt/v1/grant/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: S('MOLONI_CLIENT_ID'), client_secret: S('MOLONI_CLIENT_SECRET'), username: S('MOLONI_USERNAME'), password: S('MOLONI_PASSWORD') }).toString() });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`Moloni: ${j.error_description ?? j.error ?? r.status}`);
    msg = 'Moloni ON: autenticação OK. (A emissão automática de faturas ainda não está ligada: as faturas emitem-se à mão a partir da lista «por faturar», em Faturação.)';
  }
  return msg;
}

/** Navegação do administrador, com «Suporte» e o número de pedidos por ler, a base do assistente virtual e as métricas das campanhas. */
export const adminNav = (u?: any) => `<a href="/painel">Painel</a><a href="/admin/utilizadores">Utilizadores</a><a href="/admin/definicoes">Definições</a><a href="/admin/faturacao">Faturação</a><a href="/admin/creditos">Créditos</a><a href="/admin/laboratorio">Laboratório</a>${helpNav(u)}<a href="/admin/assistente">Assistente</a><a href="/admin/metricas">Métricas</a><form method="post" action="/sair" style="display:inline"><button class="ghost" style="padding:6px 12px;min-height:0;margin-left:16px">Sair</button></form>`;

export async function adminRoutes(app: FastifyInstance) {
  const db = app.db;
  const view = (reply: any, title: string, body: string) => reply.type('text/html; charset=utf-8').send(page({ title, body: `<div class="wrap" style="padding-top:32px">${body}</div>`, nav: adminNav(reply.request.user), noindex: true }));
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
<div class="card" style="overflow-x:auto"><table><thead><tr><th>Nome</th><th>Email</th><th>Perfil</th><th>Entidade</th><th>Conta</th><th>Subscrição</th><th>Uso</th><th>1.ª grátis</th><th></th></tr></thead><tbody>
${rows.map(({ u, qt }) => `<tr><td><a href="/admin/utilizadores/${u.id}">${esc(u.name)}</a></td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${esc(u.entity_name ?? '—')}</td>
<td>${u.active ? pill('ativa', 'ok') : pill('desativada', 'bad')}</td>
<td>${u.role === 'admin' ? '—' : `${noSubscriptionNeeded(u.role) ? `${pill('sem subscrição necessária', 'ok')} ` : ''}${u.sub_status ? `${esc(u.plan_name ?? '—')} ${pill(u.sub_status, ACTIVE_STATUSES.includes(u.sub_status) ? 'ok' : 'warn')} <span class="hint">${esc(u.source)}</span>` : noSubscriptionNeeded(u.role) ? '' : pill('nenhuma')}`}</td>
<td>${usage(u, qt)}</td>
<td>${u.free_interview_at ? `usada em ${esc(fmtDate(u.free_interview_at))}` : '—'}<br><span class="hint">${u.email_verified_at ? 'email confirmado' : 'email por confirmar'}</span></td>
<td><form method="post" action="/admin/utilizadores/${u.id}/estado"><input type="hidden" name="active" value="${u.active ? '0' : '1'}"><button class="${u.active ? 'danger' : 'accent'}" style="padding:6px 12px;min-height:0">${u.active ? 'Desativar' : 'Ativar'}</button></form></td></tr>`).join('')}</tbody></table></div>
<div class="card"><h2 style="margin-top:0">Criar utilizador</h2><form method="post" action="/admin/utilizadores">
<div class="row"><div class="grow"><label for="n">Nome</label><input id="n" name="name" type="text" required></div><div class="grow"><label for="e">Email</label><input id="e" name="email" type="email" required></div></div>
<div class="row"><div class="grow"><label for="p">Palavra-passe inicial (mín. 12)</label><input id="p" name="password" type="password" minlength="12" required autocomplete="new-password"></div>
<div class="grow"><label for="r">Perfil</label><select id="r" name="role"><option value="interviewer">Entrevistador</option><option value="entity_admin">Gestor de entidade (chaves; sem subscrição)</option><option value="admin">Administrador</option></select></div>
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
    // Conta criada pelo administrador: email confirmado à partida (é ele quem a cria e comunica a palavra-passe).
    const u = await db.one('INSERT INTO users(email, name, password_hash, role, entity_id, email_verified_at) VALUES ($1,$2,$3,$4,$5, now()) RETURNING id', [email, name, await hashPassword(pw), role, ent?.id ?? null]);
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
    const bp = await db.one('SELECT * FROM billing_profiles WHERE user_id=$1', [u.id]);
    const iv = await db.query('SELECT id, title, collection_status, invited_at FROM interviews WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 10', [u.id]);
    const wallets = await db.query('SELECT w.*, en.name AS entity_name FROM wallets w LEFT JOIN entities en ON en.id=w.entity_id WHERE w.user_id=$1 ORDER BY w.created_at', [u.id]);
    const date = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : '');
    // Email confirmado (exigido só para a 1.ª entrevista grátis) e o estado da oferta nesta conta.
    const free = await freeInterviewFor(db, u), sentAt = u.email_verified_at ? null : await lastVerificationAt(db, u.id);
    const freeLine = `Email ${u.email_verified_at ? `confirmado em ${fmtDate(u.email_verified_at)}` : `por confirmar (${sentAt ? `último link enviado em ${fmtDate(sentAt)}` : 'nenhum link enviado'})`}
 · 1.ª entrevista grátis: ${u.free_interview_at ? `usada em ${fmtDate(u.free_interview_at)}${u.free_interview_id ? ` (<a href="/entrevistas/${esc(u.free_interview_id)}">ver a entrevista</a>)` : ''}` : free.eligible ? 'disponível' : `por usar — ${esc(FREE_REASON_PT[free.reason!])}`}`;
    return view(reply, u.name, `<p><a href="/admin/utilizadores">← Utilizadores</a></p><h1>${esc(u.name)} ${u.active ? pill('ativa', 'ok') : pill('desativada', 'bad')}</h1>${flash(q.ok)}${flash(q.e, 'bad')}
<div class="card"><h2 style="margin-top:0">Conta</h2><p class="sans">${esc(u.email)} · criada em ${fmtDate(u.created_at)}${u.stripe_customer_id ? ' · Stripe: ' + esc(u.stripe_customer_id) : ''}</p>
<p class="sans">${freeLine}</p>
<form method="post" action="/admin/utilizadores/${u.id}/perfil" class="row"><select name="role" aria-label="Perfil" style="width:auto"><option value="interviewer" ${u.role === 'interviewer' ? 'selected' : ''}>Entrevistador</option><option value="entity_admin" ${u.role === 'entity_admin' ? 'selected' : ''}>Gestor de entidade (chaves; sem subscrição)</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrador</option></select>
<select name="entity_id" aria-label="Entidade" style="width:auto"><option value="">Sem entidade</option>${entities.map((e: any) => `<option value="${e.id}" ${u.entity_id === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select><button class="ghost">Guardar perfil</button></form>
<form method="post" action="/admin/utilizadores/${u.id}/palavra-passe"><label for="np">Redefinir palavra-passe (mín. 12; termina as sessões)</label><div class="row"><input id="np" name="password" type="password" minlength="12" autocomplete="new-password" style="max-width:320px"><button class="ghost">Redefinir</button></div></form></div>
<div class="card"><h2 style="margin-top:0">Subscrição</h2>
<p class="sans">Dados de faturação: ${bp ? `${bp.kind === 'consumer' ? 'consumidor' : 'empresa'} · ${esc(bp.name)}${bp.nif ? ` · NIF ${esc(bp.nif)}` : ''}${bp.vat_number ? ` · IVA ${esc(bp.vat_number)} (${esc(bp.vat_status ?? 'por verificar')})` : ''} · ${esc(bp.address)}, ${esc(bp.postal_code)} ${esc(bp.city)}, ${esc(countryName(bp.country))}` : '<span class="hint">por preencher</span>'}${sub?.vat?.regime ? ` · IVA da compra: ${esc(REGIME_LABEL[sub.vat.regime as 'domestic'] ?? sub.vat.regime)} ${fmtRate(Number(sub.vat.rate))}%` : ''}</p>
${u.role === 'entity_admin' ? '<p class="sans">Gestor de entidade: sem subscrição necessária e sem limite mensal de entrevistas; mantém os limites de cada entrevista e paga com créditos a animação (sem créditos só com credenciais Google próprias da entidade) e as regenerações para além das incluídas.</p>' : ''}
<p class="sans">Uso neste período: <strong>${usage(u, qt)}</strong>${sub?.stripe_subscription_id ? ` · Stripe: ${esc(sub.stripe_subscription_id)}` : ''}${sub?.current_period_end ? ` · período até ${fmtDate(sub.current_period_end)}` : ''}</p>
<form method="post" action="/admin/utilizadores/${u.id}/subscricao">
<div class="row"><div class="grow"><label for="pl">Plano</label><select id="pl" name="plan_id"><option value="">Nenhum</option>${plans.map((p: any) => `<option value="${esc(p.id)}" ${sub?.plan_id === p.id ? 'selected' : ''}>${esc(p.name)} — ${eur(p.price_cents)} · ${p.interviews_per_month}/mês</option>`).join('')}</select></div>
<div class="grow"><label for="st">Estado</label><select id="st" name="status">${STATUSES.map(([v, l]) => `<option value="${v}" ${sub?.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
<div class="row"><div class="grow"><label for="pe">Fim do período</label><input id="pe" name="period_end" type="date" value="${date(sub?.current_period_end)}"></div>
<div class="grow"><label for="ov">Limite mensal personalizado (vazio = o do plano)</label><input id="ov" name="override" type="number" min="0" value="${sub?.interviews_override ?? ''}"></div></div>
<p class="hint">Alterações manuais não alteram a cobrança no Stripe: para cancelar ou reembolsar uma subscrição paga, use o painel do Stripe.</p><button class="accent">Guardar subscrição</button></form></div>
<div class="card"><h2 style="margin-top:0">Créditos</h2>${wallets.length ? `<table><tbody>${wallets.map((w: any) => `<tr><td>${esc(w.entity_name ?? 'sem entidade')}</td><td>${cr(w.available_cents)} disponíveis · ${cr(w.reserved_cents)} cativos${w.debt_cents ? ` · <strong>${cr(w.debt_cents)} em dívida</strong>` : ''}${w.frozen ? ` ${pill('congelada', 'bad')}` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">Sem carteira de créditos.</p>'}<p><a href="/admin/creditos?u=${u.id}">Carregamentos e reembolsos</a></p></div>
<div class="card"><h2 style="margin-top:0">Entrevistas recentes</h2>${iv.length ? `<table><tbody>${iv.map((i: any) => `<tr><td><a href="/entrevistas/${i.id}">${esc(i.title)}</a></td><td>${esc(i.collection_status)}</td><td>${fmtDate(i.invited_at)}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">Sem entrevistas.</p>'}</div>`);
  });

  app.post('/admin/utilizadores/:id/perfil', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = (req.params as any).id, rb = req.body as any, role = ['admin', 'entity_admin'].includes(rb.role) ? rb.role : 'interviewer';
    if (id === req.user!.id && role !== 'admin') return back(reply, `/admin/utilizadores/${id}`, undefined, 'Não pode retirar o seu próprio perfil de administrador.');
    const ent = rb.entity_id && /^[0-9a-f-]{36}$/i.test(rb.entity_id) ? await db.one('SELECT id FROM entities WHERE id=$1', [rb.entity_id]) : null;
    if (role === 'entity_admin' && !ent) return back(reply, `/admin/utilizadores/${id}`, undefined, 'Um gestor de entidade precisa de uma entidade.');
    // Os créditos pertencem à entidade em que foram pagos: com saldo, cativo, dívida ou um carregamento em curso, a entidade não muda.
    const cur = await db.one('SELECT entity_id FROM users WHERE id=$1', [id]);
    if (cur && (cur.entity_id ?? null) !== (ent?.id ?? null)) {
      const w = await findWallet(db, id, cur.entity_id);
      if (w && (w.available_cents || w.reserved_cents || w.debt_cents))
        return back(reply, `/admin/utilizadores/${id}`, undefined, `Não é possível mudar a entidade: o utilizador tem ${cr(w.available_cents)} créditos disponíveis, ${cr(w.reserved_cents)} cativos e ${cr(w.debt_cents)} em dívida na entidade atual. Reembolse ou acerte primeiro (Créditos).`);
      if (await db.one(`SELECT 1 FROM credit_topups WHERE user_id=$1 AND entity_id IS NOT DISTINCT FROM $2 AND status='pending' AND created_at > now() - interval '1 day' LIMIT 1`, [id, cur.entity_id]))
        return back(reply, `/admin/utilizadores/${id}`, undefined, 'Não é possível mudar a entidade: o utilizador tem um carregamento de créditos por concluir na entidade atual.');
    }
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
    const rates = await allRates(db);
    const signups = S('SIGNUPS_OPEN') !== '0';
    const warn = await sellerWarnings(db);
    const taxRates = savedTaxRates().rates, acct = savedStripeAccount(), who = seller().name || seller().tradeName;
    const status = (d: SettingDef) => (S(d.key) ? (fromDb(d.key) ? '· definido' : '· definido por variável de ambiente') : d.default ? '· valor por omissão' : '· por definir');
    // O email da vendedora guardado igual ao SUPPORT_EMAIL (a omissão antiga) não volta ao formulário: no lugar dele, a omissão atual.
    const shown = (d: SettingDef) => (d.key === 'SELLER_EMAIL' && isSupportEmail(S(d.key)) ? (d.default ?? '') : S(d.key) || (d.default ?? ''));
    return view(reply, 'Definições', `<h1>Definições</h1>${flash(q.ok)}${flash(q.e, 'bad')}${warn.map(w => flash(w, 'bad')).join('')}
<p class="hint sans">As chaves são guardadas cifradas e nunca voltam a ser mostradas por inteiro. Deixe um campo em branco para manter o valor atual; escreva <code>-</code> para o apagar. Uma variável de ambiente com o mesmo nome serve de valor de reserva.</p>
<form method="post" action="/admin/definicoes">
${groups.map(g => `<div class="card"><div class="row"><h2 style="margin:0" class="grow">${esc(g)}</h2>${['OpenAI', 'Stripe', 'MailerSend', 'Moloni ON', 'Replicate', 'fal.ai', 'WaveSpeed', 'HeyGen', 'Google'].includes(g) ? `<button type="submit" formaction="/admin/definicoes/testar/${encodeURIComponent(g)}" class="ghost" name="testar" value="1">Guardar e testar</button>` : ''}</div>
${g === 'Stripe' ? `<p class="hint sans">As chaves têm de ser as da conta Stripe da empresa vendedora${who ? ` (${esc(who)})` : ''}${acct.name ? `; no último «Guardar e testar» a conta chamava-se «${esc(acct.name)}»` : ''}. Endpoint do webhook a registar no Stripe: <code>${esc(config.baseUrl)}/webhooks/stripe</code> — eventos: ${esc(STRIPE_EVENTS)}. Taxas de IVA (manuais, sem IVA incluído): ${Object.keys(taxRates).length ? Object.entries(taxRates).map(([k, id]) => `${esc(k.replace(':', ' '))}% (${esc(id)})`).join(', ') : 'criadas na Stripe na primeira venda'}.</p>` : ''}
${g === SELLER_GROUP ? `<p class="hint sans">${esc(SELLER_HINT)}</p>` : ''}
${g === 'Google' ? `<p class="hint sans">${esc(VERTEX_HINT)}</p>` : ''}
${SETTING_DEFS.filter(d => d.group === g).map(d => `<label for="f_${d.key}">${esc(d.label)} <span class="hint">${status(d)}</span></label>
${settingInput(d, shown(d), d.default ?? d.options?.[0]?.[0] ?? '')}`).join('')}</div>`).join('')}
<div class="card"><h2 style="margin-top:0">Registo de utilizadores</h2><label class="check"><input type="checkbox" name="signups_open" value="1" ${signups ? 'checked' : ''}> Permitir que novos utilizadores se registem (e subscrevam um plano)</label>
<p class="hint sans">Vídeo IA: os entrevistadores pedem a animação com o Google Veo por orçamento, aceite por eles e pago com créditos; os retratos animados (Replicate) e o Veo sem orçamento ficam só para o administrador (custo interno). O gestor de uma entidade com credenciais Google próprias gera o Veo sem orçamento nem créditos (paga a entidade, no projeto Google dela); sem elas, por orçamento, como os outros.</p></div>
<p><button class="accent">Guardar definições</button></p></form>
<div class="card"><h2 style="margin-top:0">Planos</h2><p class="hint sans">Preços sem IVA (o IVA é acrescentado conforme a morada de faturação). Planos inativos deixam de ser vendidos, mas quem já os tem continua com eles até mudar de plano. Alterar o preço afeta apenas novas subscrições e mudanças de plano; as existentes mantêm o preço contratado no Stripe. Os limites por entrevista (perguntas, incluindo as adicionais, e minutos de respostas do entrevistado) ficam fixos em cada entrevista no convite.</p>
${plans.map((p: any) => `<form method="post" action="/admin/planos/${esc(p.id)}" class="row" style="margin:8px 0"><strong style="min-width:90px">${esc(p.id)}</strong><input name="name" value="${esc(p.name)}" aria-label="Nome" style="width:140px"><input name="price" type="number" step="0.01" min="0" value="${(p.price_cents / 100).toFixed(2)}" aria-label="Preço mensal sem IVA (EUR)" style="width:110px">€/mês + IVA<input name="limit" type="number" min="0" value="${p.interviews_per_month}" aria-label="Entrevistas por mês" style="width:90px">entrevistas/mês<input name="max_questions" type="number" min="1" value="${p.max_questions}" aria-label="Perguntas por entrevista" style="width:80px">perguntas<input name="answer_min" type="number" min="1" step="1" value="${Math.round(p.max_answer_total_sec / 60)}" aria-label="Minutos de respostas por entrevista" style="width:80px">min de respostas<label class="check" style="margin:0"><input type="checkbox" name="active" value="1" ${p.active ? 'checked' : ''}> ativo</label><button class="ghost">Guardar</button></form>`).join('')}</div>
${ratesCard(rates)}`);
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

  // ---------- tarifas da animação (orçamentos): editáveis, só valem para orçamentos novos ----------
  /** Porque é que um motor não se pode ativar (o Lite não se vende; os outros esperam pelo Laboratório). */
  const UNAVAILABLE_WHY = (r: any) => (r.engine === 'veo' && r.tier === 'lite' ? 'não se oferece (o Laboratório apanhou-o a pôr texto inventado no ecrã)' : 'por integrar e medir no Laboratório');
  const ratesCard = (rates: any[]) => `<div class="card" id="tarifas"><h2 style="margin-top:0">Tarifas da animação (orçamentos)</h2><p class="hint sans">1 crédito = 1 € sem IVA. O cliente paga créditos por minuto de fala (cada fala conta pelo menos 4 s); o custo é o que a Google fatura por segundo de clipe. O câmbio deve ser conservador (€ por 1 $): o teto interno de cada orçamento é 81,5% do valor ÷ câmbio. O nível do Google Veo escolhido em Definições → Google decide a tarifa. Uma alteração muda a versão: os rascunhos deixam de poder ser aceites e os orçamentos já aceites mantêm o preço. Confirme o preço do SKU na faturação Cloud do projeto (0,10 ou 0,15 $/s no Fast).</p>
${rates.map((r: any) => `<form method="post" action="/admin/tarifas/${esc(r.id)}" class="row sans" style="margin:8px 0"><strong style="min-width:170px">${esc(r.label)}</strong><input name="cr_min" type="number" step="0.5" min="0.5" value="${r.cents_per_min / 100}" aria-label="Créditos por minuto de fala" style="width:90px">cr/min<input name="cost" type="number" step="0.001" min="0.001" value="${Number(r.cost_usd_per_sec)}" aria-label="Custo faturado (USD por segundo)" style="width:90px">$/s<input name="usd_eur" type="number" step="0.0001" min="0.5" max="2" value="${Number(r.usd_eur)}" aria-label="Câmbio (€ por 1 $)" style="width:90px">€/$<input name="max_clip" type="number" min="1" max="60" value="${r.max_clip_sec}" aria-label="Duração máxima de um clipe (s)" style="width:70px">s/clipe<input name="valid_until" type="date" value="${r.valid_until ? new Date(r.valid_until).toISOString().slice(0, 10) : ''}" aria-label="Desativação do modelo" style="width:auto"><label class="check" style="margin:0"><input type="checkbox" name="active" value="1" ${r.active ? 'checked' : ''} ${r.available ? '' : 'disabled'}> ativo</label><button class="ghost">Guardar</button>
<span class="hint" style="flex-basis:100%">versão ${r.version}${r.available ? ` · tarifa mínima recomendada para ~55% de margem típica: ${cr(recommendedCentsPerMin(r))} cr/min` : ` · ${esc(UNAVAILABLE_WHY(r))}: não se pode ativar`}</span></form>`).join('')}</div>`;

  app.post('/admin/tarifas/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = String((req.params as any).id), b = (req.body ?? {}) as any;
    const r = await db.one('SELECT * FROM animation_rates WHERE id=$1', [id]);
    if (!r) return reply.code(404).send();
    const num = (v: unknown) => Number(String(v ?? '').replace(',', '.'));
    const cents = Math.round(num(b.cr_min) * 100), cost = num(b.cost), usdEur = num(b.usd_eur), maxClip = parseInt(String(b.max_clip ?? ''));
    const until = b.valid_until ? new Date(`${b.valid_until}T23:59:59Z`) : null;
    if (!(cents > 0) || !(cost > 0) || !(usdEur >= 0.5 && usdEur <= 2) || !(maxClip >= 1 && maxClip <= 60) || (until && Number.isNaN(until.getTime()))) return back(reply, '/admin/definicoes', undefined, 'Valores da tarifa inválidos.');
    if (b.active && !r.available) return back(reply, '/admin/definicoes', undefined, `${r.label}: ${UNAVAILABLE_WHY(r)}; não se pode ativar.`);
    const active = !!b.active;
    const changed = cents !== r.cents_per_min || cost !== Number(r.cost_usd_per_sec) || usdEur !== Number(r.usd_eur) || maxClip !== r.max_clip_sec || active !== r.active
      || (until?.getTime() ?? null) !== (r.valid_until ? new Date(r.valid_until).getTime() : null);
    if (!changed) return back(reply, '/admin/definicoes', 'Tarifa sem alterações.');
    await db.query(`UPDATE animation_rates SET cents_per_min=$2, cost_usd_per_sec=$3, usd_eur=$4, max_clip_sec=$5, valid_until=$6, active=$7, version=version+1, updated_by=$8, updated_at=now() WHERE id=$1`,
      [id, cents, cost, usdEur, maxClip, until, active, req.user!.email]);
    await audit(db, req.user!.email, 'admin.animation_rate_updated', null, { rate: id, centsPerMin: cents, costUsdPerSec: cost, usdEur, maxClip, active, validUntil: until });
    return back(reply, '/admin/definicoes', `Tarifa ${r.label} guardada (versão ${r.version + 1}): vale para os orçamentos novos.`);
  });

  app.post('/admin/planos/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const b = req.body as any;
    const cents = Math.round(parseFloat(String(b.price).replace(',', '.')) * 100), lim = parseInt(b.limit);
    // Limites por entrevista: em branco (ou ausentes) mantêm-se os atuais.
    const maxQ = b.max_questions === undefined || b.max_questions === '' ? null : parseInt(b.max_questions);
    const ansMin = b.answer_min === undefined || b.answer_min === '' ? null : parseInt(b.answer_min);
    if (!Number.isFinite(cents) || cents < 0 || !Number.isFinite(lim) || lim < 0 || (maxQ !== null && !(maxQ >= 1)) || (ansMin !== null && !(ansMin >= 1))) return back(reply, '/admin/definicoes', undefined, 'Valores do plano inválidos.');
    await db.query('UPDATE plans SET name=$2, price_cents=$3, interviews_per_month=$4, active=$5, max_questions=COALESCE($6, max_questions), max_answer_total_sec=COALESCE($7, max_answer_total_sec) WHERE id=$1',
      [(req.params as any).id, String(b.name ?? '').slice(0, 60) || 'Plano', cents, lim, !!b.active, maxQ, ansMin === null ? null : ansMin * 60]);
    await audit(db, req.user!.email, 'admin.plan_updated', null, { plan: (req.params as any).id });
    return back(reply, '/admin/definicoes', 'Plano guardado.');
  });

  // ---------- faturação: lista «por faturar» (fatura-recibo emitida à mão no Moloni) e livre resolução ----------
  const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  const day = (d: any) => new Date(d).toLocaleDateString('pt-PT');
  const customerCell = (r: any) => {
    const p = r.evidence?.profile ?? {}, c = r.customer ?? {};
    const tax = r.evidence?.nif ? `NIF ${r.evidence.nif}` : r.evidence?.vatNumber ? `IVA ${r.evidence.vatNumber}${r.evidence.vatStatus ? ` (${r.evidence.vatStatus})` : ''}` : 'sem NIF';
    return `${esc(c.name ?? p.name ?? '—')} <span class="hint">${r.customer_kind === 'consumer' ? 'consumidor' : r.customer_kind === 'business' ? 'empresa' : ''}</span><br>${esc(tax)}<br><span class="hint">${esc([p.address, [p.postal_code, p.city].filter(Boolean).join(' '), p.country ? countryName(p.country) : ''].filter(Boolean).join(', '))}${r.email ? ` · ${esc(r.email)}` : ''}</span>`;
  };
  const vatCell = (r: any) => `${r.vat_regime ? esc(REGIME_LABEL[r.vat_regime as 'domestic'] ?? r.vat_regime) : '—'}${r.vat_rate !== null && r.vat_rate !== undefined ? ` · ${fmtRate(Number(r.vat_rate))}%` : ''}${r.vat_country ? ` (${esc(r.vat_country)})` : ''}${r.vat_note ? `<br><strong>Menção: ${esc(r.vat_note)}</strong>` : ''}`;
  const amounts = (r: any) => `${eurPt(r.net_cents)} + IVA ${eurPt(r.vat_cents)}<br><strong>${eurPt(r.total_cents)}</strong>`;
  const KIND_LABEL: Record<string, string> = { subscription: 'subscrição', topup: 'carregamento de créditos', topup_refund: 'nota de crédito (reembolso de créditos)', topup_refund_reversal: 'anular nota de crédito (reembolso que falhou)' };

  app.get('/admin/faturacao', async (req, reply) => {
    if (!guard(req, reply)) return;
    const q = req.query as any;
    const warn = await sellerWarnings(db);
    const pending = await db.query(`SELECT iq.*, u.email FROM invoice_queue iq LEFT JOIN users u ON u.id=iq.user_id WHERE iq.status='pending' ORDER BY iq.paid_at`);
    const issued = await db.query(`SELECT iq.*, u.email FROM invoice_queue iq LEFT JOIN users u ON u.id=iq.user_id WHERE iq.status='issued' ORDER BY iq.issued_at DESC LIMIT 50`);
    const wd = await db.query(`SELECT w.*, u.email, u.name FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY (w.status='requested') DESC, w.requested_at DESC LIMIT 50`);
    const now = Date.now();
    return view(reply, 'Faturação', `<h1>Faturação</h1>${flash(q.ok)}${flash(q.e, 'bad')}${warn.map(w => flash(w, 'bad')).join('')}
<p class="hint sans">Cada pagamento recebido pela Stripe (subscrições e carregamentos de créditos) espera uma fatura-recibo emitida à mão no Moloni da empresa vendedora indicada, com os dados do cliente, a taxa de IVA e a menção mostradas; cada reembolso de créditos espera a nota de crédito (valores negativos), que referencia a fatura-recibo do carregamento. Os créditos são vale de finalidade única: o IVA e a fatura são do carregamento, e o consumo dos créditos não se fatura. Depois de emitir o documento, escreva aqui o número. Prazo: 5.º dia útil depois do pagamento (CIVA, art. 36.º, n.º 1, al. a); a contagem não desconta feriados). O recibo da Stripe não é fatura.</p>
<div class="card" style="overflow-x:auto"><h2 style="margin-top:0">Por faturar (${pending.length})</h2>${pending.length ? `<table><thead><tr><th>Pago</th><th>Cliente</th><th>Descrição</th><th>Valores</th><th>IVA</th><th>Vendedora</th><th>Fatura Moloni</th></tr></thead><tbody>
${pending.map((r: any) => { const dl = invoiceDeadline(r.paid_at); const flags = invoiceFlags(r); return `<tr id="f-${r.id}"><td>${day(r.paid_at)}<br><span class="hint">até ${day(dl)}</span>${dl.getTime() < now ? ` ${pill('fora de prazo', 'bad')}` : ''}<br><span class="hint">${esc(r.stripe_number ?? r.stripe_ref)}</span></td>
<td>${customerCell(r)}</td><td>${KIND_LABEL[r.kind] ? `${pill(KIND_LABEL[r.kind])}<br>` : ''}${esc(r.description)}${r.period_start ? `<br><span class="hint">${day(r.period_start)} a ${r.period_end ? day(r.period_end) : '—'}</span>` : ''}</td><td>${amounts(r)}</td><td>${vatCell(r)}</td>
<td>${esc(r.seller?.name || r.seller?.tradeName || '—')}${r.seller?.nif ? `<br><span class="hint">NIF ${esc(r.seller.nif)}</span>` : ''}</td>
<td><form method="post" action="/admin/faturacao/${r.id}/faturada"><label for="m-${r.id}" style="margin-top:0">Fatura Moloni n.º</label><input id="m-${r.id}" name="moloni_doc" type="text" maxlength="60" required placeholder="FR …" style="min-width:120px"><button class="accent" style="margin-top:6px">Marcar faturada</button></form></td></tr>
${flags.length ? `<tr><td colspan="7" class="hint" style="color:var(--bad)">${flags.map(esc).join(' · ')}</td></tr>` : ''}`; }).join('')}</tbody></table>` : '<p class="hint">Nada por faturar.</p>'}</div>
<div class="card" style="overflow-x:auto"><h2 style="margin-top:0">Faturadas (últimas 50)</h2>${issued.length ? `<table><thead><tr><th>Pago</th><th>Cliente</th><th>Valores</th><th>IVA</th><th>Fatura Moloni</th><th></th></tr></thead><tbody>
${issued.map((r: any) => `<tr><td>${day(r.paid_at)}</td><td>${customerCell(r)}</td><td>${amounts(r)}</td><td>${vatCell(r)}</td><td>faturado no Moloni n.º <strong>${esc(r.moloni_doc)}</strong><br><span class="hint">${fmtDate(r.issued_at)} · ${esc(r.issued_by ?? '')}</span></td>
<td><form method="post" action="/admin/faturacao/${r.id}/pendente"><button class="ghost" style="padding:6px 12px;min-height:0">Corrigir</button></form></td></tr>`).join('')}</tbody></table>` : '<p class="hint">Ainda nenhuma.</p>'}</div>
<div class="card" style="overflow-x:auto"><h2 style="margin-top:0">Livre resolução (consumidores)</h2><p class="hint sans">Pedidos feitos pelo botão «Desistir do contrato aqui». Devolver o valor pago, descontada a parte do serviço já prestada, no prazo de 14 dias e pelo mesmo meio (reembolso no painel da Stripe), e emitir a nota de crédito no Moloni.</p>
${wd.length ? `<table><thead><tr><th>Pedido</th><th>Cliente</th><th>Contrato</th><th>Estado</th></tr></thead><tbody>
${wd.map((w: any) => `<tr><td>${fmtDate(w.requested_at)}<br><span class="hint">reembolso até ${day(new Date(new Date(w.requested_at).getTime() + 14 * 86400_000))}</span></td><td>${esc(w.name)}<br><span class="hint">${esc(w.email)}</span></td>
<td>${w.kind === 'topup' ? `carregamento de créditos pago em ${w.contract_started_at ? day(w.contract_started_at) : '—'}<br><span class="hint"><a href="/admin/creditos#l-${esc(String(w.stripe_ref ?? '').replace(/^topup:/, ''))}">reembolsar o saldo disponível em Créditos</a> (a nota de crédito entra sozinha na lista)</span>` : `${esc(w.plan_id ?? '')} desde ${w.contract_started_at ? day(w.contract_started_at) : '—'}<br><span class="hint">${esc(w.stripe_ref ?? '')} · ${w.stripe_cancelled ? 'cancelada na Stripe' : 'CANCELAR no painel da Stripe'}</span>`}</td>
<td>${w.status === 'processed' ? `${pill('tratado', 'ok')} <span class="hint">${fmtDate(w.processed_at)} · ${esc(w.note ?? '')}</span>` : `<form method="post" action="/admin/faturacao/livre-resolucao/${w.id}"><input name="note" type="text" maxlength="200" placeholder="reembolso feito, nota de crédito n.º …" aria-label="Nota"><button class="accent" style="margin-top:6px">Marcar tratado</button></form>`}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">Sem pedidos.</p>'}</div>`);
  });

  app.post('/admin/faturacao/:id/faturada', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = (req.params as any).id;
    if (!isUuid(id)) return reply.code(404).send();
    const doc = String((req.body as any)?.moloni_doc ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!doc) return back(reply, '/admin/faturacao', undefined, 'Indique o número da fatura emitida no Moloni.');
    const r = await db.one(`UPDATE invoice_queue SET status='issued', moloni_doc=$2, issued_at=now(), issued_by=$3 WHERE id=$1 AND status='pending' RETURNING id, kind, topup_id`, [id, doc, req.user!.email]);
    if (!r) return back(reply, '/admin/faturacao', undefined, 'Este pagamento já estava marcado como faturado (ou não existe).');
    // O número da fatura-recibo fica também no lote de créditos (extrato do cliente e notas de crédito).
    if (r.kind === 'topup' && r.topup_id) await db.query('UPDATE credit_topups SET moloni_doc=$2, updated_at=now() WHERE id=$1', [r.topup_id, doc]);
    await audit(db, req.user!.email, 'admin.invoice_issued', null, { queue: id, moloni: doc });
    return back(reply, '/admin/faturacao', `Marcado como faturado no Moloni n.º ${doc}.`);
  });

  app.post('/admin/faturacao/:id/pendente', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = (req.params as any).id;
    if (!isUuid(id)) return reply.code(404).send();
    const r = await db.one(`UPDATE invoice_queue SET status='pending', moloni_doc=NULL, issued_at=NULL, issued_by=NULL WHERE id=$1 AND status='issued' RETURNING id, kind, topup_id`, [id]);
    if (r?.kind === 'topup' && r.topup_id) await db.query('UPDATE credit_topups SET moloni_doc=NULL, updated_at=now() WHERE id=$1', [r.topup_id]);
    if (r) await audit(db, req.user!.email, 'admin.invoice_reopened', null, { queue: id });
    return back(reply, '/admin/faturacao', r ? 'Voltou à lista «por faturar».' : undefined);
  });

  app.post('/admin/faturacao/livre-resolucao/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = (req.params as any).id;
    if (!isUuid(id)) return reply.code(404).send();
    const note = String((req.body as any)?.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const r = await db.one(`UPDATE withdrawals SET status='processed', processed_at=now(), processed_by=$2, note=$3 WHERE id=$1 AND status='requested' RETURNING id`, [id, req.user!.email, note || null]);
    if (r) await audit(db, req.user!.email, 'admin.withdrawal_processed', null, { withdrawal: id });
    return back(reply, '/admin/faturacao', r ? 'Pedido de livre resolução marcado como tratado.' : undefined);
  });
  // ---------- créditos: carteiras, carregamentos, reembolsos e conferência do livro-razão ----------
  const LOT_STATUS: Record<string, [string, '' | 'ok' | 'bad' | 'warn']> = { pending: ['por pagar', 'warn'], paid: ['pago', 'ok'], failed: ['não pago', ''], expired: ['expirado (Stripe)', ''], refunded: ['reembolsado', ''], partially_refunded: ['reembolsado em parte', ''], disputed: ['em disputa', 'bad'] };
  app.get('/admin/creditos', async (req, reply) => {
    if (!guard(req, reply)) return;
    const q = req.query as any;
    const only = typeof q.u === 'string' && isUuid(q.u) ? q.u : null;
    const problems = await ledgerCheck(db);
    const wallets = await db.query(`SELECT w.*, u.email, u.name, en.name AS entity_name FROM wallets w JOIN users u ON u.id=w.user_id LEFT JOIN entities en ON en.id=w.entity_id
      WHERE ($1::uuid IS NULL OR w.user_id=$1::uuid) AND (w.available_cents>0 OR w.reserved_cents>0 OR w.debt_cents>0 OR w.frozen OR $1::uuid IS NOT NULL) ORDER BY w.frozen DESC, w.debt_cents DESC, w.updated_at DESC LIMIT 200`, [only]);
    const lots = await db.query(`SELECT tp.*, u.email, u.name, (SELECT COALESCE(sum(gross_cents),0)::int FROM credit_refunds r WHERE r.topup_id=tp.id AND r.status<>'failed') AS refunded_gross
      FROM credit_topups tp JOIN users u ON u.id=tp.user_id WHERE ($1::uuid IS NULL OR tp.user_id=$1::uuid) AND (tp.status<>'failed' OR tp.alert IS NOT NULL) ORDER BY (tp.alert IS NOT NULL) DESC, tp.created_at DESC LIMIT 100`, [only]);
    const quotes = await db.query(`SELECT q.*, u.email, i.title FROM animation_quotes q JOIN users u ON u.id=q.owner_id JOIN interviews i ON i.id=q.interview_id WHERE ($1::uuid IS NULL OR q.owner_id=$1::uuid) AND q.status<>'draft' ORDER BY q.created_at DESC LIMIT 50`, [only]);
    const refunds = await db.query(`SELECT cr.*, u.email FROM credit_refunds cr JOIN credit_topups tp ON tp.id=cr.topup_id JOIN users u ON u.id=tp.user_id WHERE ($1::uuid IS NULL OR tp.user_id=$1::uuid) ORDER BY cr.created_at DESC LIMIT 50`, [only]);
    const now = Date.now();
    const lotRow = (l: any) => {
      const [label, kind] = LOT_STATUS[l.status] ?? [l.status, ''];
      const within = l.paid_at && now - new Date(l.paid_at).getTime() <= REFUND_WINDOW_DAYS * 86400_000;
      // O mesmo cálculo de refundGross: o último reembolso do lote acerta o arredondamento do IVA.
      const est = !l.remaining_cents ? 0 : l.refunded_cents + l.remaining_cents >= l.net_cents ? l.gross_cents - l.refunded_gross : l.remaining_cents + Math.round((l.remaining_cents * l.vat_cents) / l.net_cents);
      const action = ['paid', 'partially_refunded'].includes(l.status) && l.remaining_cents > 0
        ? `<form method="post" action="/admin/creditos/${l.id}/reembolsar" onsubmit="return confirm('Reembolsar ${cr(l.remaining_cents)} créditos (${eurPt(est)}) pela Stripe?')">${within ? '' : `<label class="check" style="margin:0"><input type="checkbox" name="encerramento" value="1" required> Encerramento do serviço (passaram os ${REFUND_WINDOW_DAYS} dias)</label>`}<button class="${within ? 'accent' : 'danger'}" style="padding:6px 12px;min-height:0">Reembolsar saldo disponível (${cr(l.remaining_cents)} cr = ${eurPt(est)})</button></form>${within ? `<span class="hint">até ${day(new Date(new Date(l.paid_at).getTime() + REFUND_WINDOW_DAYS * 86400_000))}</span>` : ''}` : '';
      return `<tr id="l-${l.id}"><td>${fmtDate(l.created_at)}<br><span class="hint">${esc(l.stripe_payment_intent ?? l.stripe_session_id ?? '')}</span></td><td>${esc(l.name)}<br><span class="hint">${esc(l.email)}</span></td>
<td>${cr(l.net_cents)} cr<br><span class="hint">${eurPt(l.net_cents)} + IVA ${fmtRate(Number(l.vat_rate))}% = ${eurPt(l.gross_cents)}</span></td>
<td>resta ${cr(l.remaining_cents)}<br><span class="hint">usado ${cr(l.used_cents)} · reemb. ${cr(l.refunded_cents)} · caduc. ${cr(l.expired_cents)}${l.disputed_cents ? ` · disputa ${cr(l.disputed_cents)}` : ''}</span></td>
<td>${pill(label, kind)}<br><span class="hint">${l.expires_at ? `válido até ${day(l.expires_at)}` : ''}</span></td><td>${l.moloni_doc ? esc(l.moloni_doc) : l.paid_at ? '<span class="hint">por emitir</span>' : ''}</td><td>${action}</td></tr>
${l.alert ? `<tr><td colspan="7" class="hint" style="color:var(--bad)">${esc(l.alert)}</td></tr>` : ''}`;
    };
    return view(reply, 'Créditos', `<h1>Créditos</h1>${flash(q.ok)}${flash(q.e, 'bad')}
${problems.length ? `<div class="flash bad"><strong>O livro-razão não confere:</strong><ul>${problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>` : '<p class="hint sans">Livro-razão conferido: a soma dos movimentos é igual aos saldos de todas as carteiras e o disponível é igual ao que resta nos carregamentos.</p>'}
<p class="hint sans">1 crédito = 1 € sem IVA. O reembolso devolve só o saldo disponível do carregamento (nunca o cativo), pelo mesmo cartão e sem descontar a comissão da Stripe: nos ${REFUND_WINDOW_DAYS} dias seguintes ao carregamento, ou depois disso só por encerramento do serviço. A nota de crédito entra na lista «por faturar». Reembolsos feitos no painel da Stripe e disputas são detetados pelo pagamento e debitam a carteira (o que faltar fica em dívida e a carteira é congelada).${only ? ' <a href="/admin/creditos">Ver todos</a>' : ''}</p>
<div class="card" style="overflow-x:auto"><h2 style="margin-top:0">Carteiras</h2>${wallets.length ? `<table><thead><tr><th>Cliente</th><th>Entidade</th><th>Disponível</th><th>Cativo</th><th>Dívida</th><th></th></tr></thead><tbody>
${wallets.map((w: any) => `<tr><td><a href="/admin/utilizadores/${w.user_id}">${esc(w.name)}</a><br><span class="hint">${esc(w.email)}</span></td><td>${esc(w.entity_name ?? '—')}</td><td>${cr(w.available_cents)}</td><td>${cr(w.reserved_cents)}</td><td>${w.debt_cents ? `<strong>${cr(w.debt_cents)}</strong>` : '0'}</td><td>${w.frozen ? pill('congelada (disputa)', 'bad') : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">Sem carteiras com saldo.</p>'}</div>
<div class="card" style="overflow-x:auto"><h2 style="margin-top:0">Carregamentos</h2>${lots.length ? `<table><thead><tr><th>Data</th><th>Cliente</th><th>Valor</th><th>Saldo do lote</th><th>Estado</th><th>FR</th><th></th></tr></thead><tbody>${lots.map(lotRow).join('')}</tbody></table>` : '<p class="hint">Sem carregamentos.</p>'}</div>
<div class="card" style="overflow-x:auto"><h2 style="margin-top:0">Orçamentos da animação</h2>${quotes.length ? `<table><thead><tr><th>Aceite</th><th>Cliente</th><th>Orçamento</th><th>Cobrado / libertado</th><th>Gasto na Google (estimado) / teto</th><th>Estado</th></tr></thead><tbody>
${quotes.map((q: any) => { const [l, k] = QUOTE_STATUS[q.status] ?? [q.status, '']; return `<tr><td>${fmtDate(q.accepted_at ?? q.created_at)}</td><td>${esc(q.email)}<br><a class="hint" href="/entrevistas/${q.interview_id}/orcamentos/${q.id}">${esc(q.title)}</a></td><td>${cr(q.price_cents)} cr<br><span class="hint">${esc(q.rate?.label ?? '')} · ${cr(q.rate?.cents_per_min ?? 0)} cr/min · v${q.rate?.version ?? '?'}</span></td><td>${q.charged_cents != null ? `${cr(q.charged_cents)} / ${cr(q.released_cents ?? 0)}` : '—'}</td><td>${q.spent_usd != null ? `${Number(q.spent_usd).toFixed(2)}` : '—'} / ${Number(q.cap_usd).toFixed(2)}${q.settlement?.factor ? `<br><span class="hint">fator medido ${q.settlement.factor}</span>` : ''}</td><td>${pill(l, k)}${q.void_reason ? `<br><span class="hint">${esc(q.void_reason)}</span>` : ''}${q.status_note ? `<br><span class="hint">${esc(q.status_note)}</span>` : ''}</td></tr>`; }).join('')}</tbody></table>` : '<p class="hint">Sem orçamentos aceites.</p>'}<p class="hint sans">O gasto inclui as operações recusadas pelo filtro ou falhadas na Google, até à reconciliação com a fatura da Google.</p></div>
<div class="card" style="overflow-x:auto"><h2 style="margin-top:0">Reembolsos</h2>${refunds.length ? `<table><thead><tr><th>Pedido</th><th>Cliente</th><th>Valor</th><th>Origem</th><th>Estado</th></tr></thead><tbody>
${refunds.map((r: any) => `<tr><td>${fmtDate(r.created_at)}<br><span class="hint">${esc(r.requested_by ?? '')}</span></td><td>${esc(r.email)}</td><td>${cr(r.net_cents)} cr = ${eurPt(r.gross_cents)}</td><td>${r.source === 'app' ? (r.reason === 'closure' ? 'aplicação (encerramento)' : 'aplicação (14 dias)') : 'painel da Stripe'}<br><span class="hint">${esc(r.stripe_refund_id ?? '')}</span></td>
<td>${pill(r.status === 'succeeded' ? 'feito' : r.status === 'failed' ? 'falhou' : 'pendente', r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'bad' : 'warn')}${r.error ? `<br><span class="hint">${esc(r.error)}</span>` : ''}${r.status === 'pending' && r.source === 'app' && !r.stripe_refund_id ? `<form method="post" action="/admin/creditos/reembolsos/${r.id}/repetir"><button class="ghost" style="padding:6px 12px;min-height:0">Repetir o pedido à Stripe</button></form>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">Sem reembolsos.</p>'}</div>`);
  });

  app.post('/admin/creditos/:id/reembolsar', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = (req.params as any).id;
    if (!isUuid(id)) return reply.code(404).send();
    const tp = await db.one('SELECT paid_at FROM credit_topups WHERE id=$1', [id]);
    if (!tp) return reply.code(404).send();
    const within = tp.paid_at && Date.now() - new Date(tp.paid_at).getTime() <= REFUND_WINDOW_DAYS * 86400_000;
    if (!within && (req.body as any)?.encerramento !== '1') return back(reply, '/admin/creditos', undefined, `Passaram mais de ${REFUND_WINDOW_DAYS} dias desde o carregamento: só se reembolsa por encerramento do serviço (assinale a caixa).`);
    try {
      const r = await refundTopup(db, id, { reason: within ? 'withdrawal' : 'closure', actor: req.user!.email });
      await audit(db, req.user!.email, 'admin.credits_refund', null, { topup: id, status: r.status, reason: within ? 'withdrawal' : 'closure' });
      return back(reply, '/admin/creditos', r.status === 'failed' || r.status === 'unknown' ? undefined : r.message, r.status === 'failed' || r.status === 'unknown' ? r.message : undefined);
    } catch (e: any) {
      if (e instanceof RefundError) return back(reply, '/admin/creditos', undefined, e.message);
      throw e;
    }
  });

  app.post('/admin/creditos/reembolsos/:id/repetir', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = (req.params as any).id;
    if (!isUuid(id)) return reply.code(404).send();
    const r = await sendRefund(db, id);
    await audit(db, req.user!.email, 'admin.credits_refund_retry', null, { refund: id, status: r.status });
    return back(reply, '/admin/creditos', r.status === 'succeeded' || r.status === 'pending' ? r.message : undefined, r.status === 'succeeded' || r.status === 'pending' ? undefined : r.message);
  });
}
