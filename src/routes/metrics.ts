import type { FastifyInstance } from 'fastify';
import { esc, fmtDate } from '../lib.ts';
import { page, flash } from '../views.ts';
import { audit } from '../app.ts';
import { adminNav } from './admin.ts';
import { eurPt } from '../vat.ts';
import {
  campaignMetrics, parsePeriod, periodQuery, ratios, totalRatios, rowLabel, metricsCsv, buildLink, normTag, daysBetween, validDay,
  LINK_SOURCES, LINK_MEDIUMS, KNOWN_SOURCES, PAID_PREFIX, MAX_PERIOD_DAYS, MAX_TABLE_ROWS, MAX_VISIT_ROWS_PER_DAY, OTHER, type Metrics, type Period, type Row,
} from '../metrics.ts';

const STYLES = `
.mt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;margin:16px 0}
.mt-tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
.mt-tile .l{color:var(--mute);font-size:.8rem;margin:0}.mt-tile .v{font-size:1.45rem;font-weight:650;margin:2px 0 0;font-variant-numeric:tabular-nums}.mt-tile .s{color:var(--mute);font-size:.78rem;margin:2px 0 0}
.mt-table td.n,.mt-table th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.mt-table td{font-size:.9rem}.mt-table tfoot td{font-weight:650;border-top:2px solid var(--line)}
.mt-chart{width:100%;height:auto;display:block;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
.mt-key{display:inline-flex;gap:16px;flex-wrap:wrap;font:.85rem system-ui;color:var(--mute)}.mt-key i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.mt-form .row>div{min-width:150px}
.mt-link{font:.9rem ui-monospace,monospace}
`;

const int = (n: number) => n.toLocaleString('pt-PT');
const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1).replace('.', ',')} %`);
const money = (c: number | null) => (c === null ? '—' : eurPt(Math.round(c)));
const roas = (x: number | null) => (x === null ? '—' : `${x.toFixed(2).replace('.', ',')}×`);
const dayPt = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/** Gráfico diário (SVG em linha, sem bibliotecas): visitas e registos em dois painéis com o mesmo eixo dos dias. */
export function dailyChart(daily: Metrics['daily'], since: string | null = null): string {
  const W = 1000, H = 120, GAP = 48, L = 48, R = 8, T = 30, n = Math.max(1, daily.length);
  const bw = (W - L - R) / n;
  const panel = (y0: number, key: 'visits' | 'signups', color: string, label: string) => {
    const max = Math.max(1, ...daily.map(d => d[key]));
    const bars = daily.map((d, i) => {
      const h = (d[key] / max) * H;
      return d[key] ? `<rect x="${(L + i * bw + bw * 0.12).toFixed(1)}" y="${(y0 + H - h).toFixed(1)}" width="${Math.max(0.6, bw * 0.76).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" style="fill:var(${color})"><title>${dayPt(d.day)}: ${d[key]} ${label.toLowerCase()}</title></rect>` : '';
    }).join('');
    return `<text x="0" y="${y0 - 14}" style="fill:var(--ink);font-size:15px;font-weight:600">${label}</text>
<text x="${L - 8}" y="${y0 + 5}" text-anchor="end" style="fill:var(--mute);font-size:13px">${max}</text><text x="${L - 8}" y="${y0 + H}" text-anchor="end" style="fill:var(--mute);font-size:13px">0</text>
<line x1="${L}" x2="${W - R}" y1="${y0}" y2="${y0}" style="stroke:var(--line);stroke-dasharray:4 4"/><line x1="${L}" x2="${W - R}" y1="${y0 + H}" y2="${y0 + H}" style="stroke:var(--line)"/>${bars}`;
  };
  const y2 = T + H + GAP;
  const first = daily[0]?.day ?? '', last = daily[daily.length - 1]?.day ?? '';
  const tv = daily.reduce((s, d) => s + d.visits, 0), ts = daily.reduce((s, d) => s + d.signups, 0);
  // Início da contagem das visitas dentro do período: linha tracejada (antes dela, só há registos).
  const si = since && since > first ? daily.findIndex(d => d.day === since) : -1;
  const mark = si > 0 ? `<line x1="${(L + si * bw).toFixed(1)}" x2="${(L + si * bw).toFixed(1)}" y1="${T - 6}" y2="${y2 + H}" style="stroke:var(--mute);stroke-dasharray:3 4"><title>Início da contagem das visitas: ${dayPt(since!)}</title></line><text x="${(L + si * bw + 4).toFixed(1)}" y="${T - 10}" style="fill:var(--mute);font-size:13px">início da contagem</text>` : '';
  return `<svg class="mt-chart" viewBox="0 0 ${W} ${y2 + H + 26}" role="img" aria-label="Visitas e registos por dia, de ${dayPt(first)} a ${dayPt(last)}: ${tv} visitas e ${ts} registos">
${panel(T, 'visits', '--accent', 'Visitas')}${panel(y2, 'signups', '--ok', 'Registos')}${mark}
<text x="${L}" y="${y2 + H + 20}" style="fill:var(--mute);font-size:13px">${dayPt(first)}</text><text x="${W - R}" y="${y2 + H + 20}" text-anchor="end" style="fill:var(--mute);font-size:13px">${dayPt(last)}</text></svg>`;
}

const tile = (label: string, value: string, sub = '') => `<div class="mt-tile"><p class="l">${esc(label)}</p><p class="v">${esc(value)}</p>${sub ? `<p class="s">${esc(sub)}</p>` : ''}</div>`;

function rowCells(r: Row, x = ratios(r)) {
  return `<td class="n">${int(r.visits)}</td><td class="n">${int(r.signups)}</td><td class="n">${pct(x.conversion)}</td><td class="n">${int(r.activated)}</td><td class="n">${int(r.invited)}</td><td class="n">${int(r.paying)}</td>
<td class="n">${money(r.revenueCents)}</td><td class="n">${r.spendCents ? money(r.spendCents) : '—'}</td><td class="n">${money(x.cpa)}</td><td class="n">${money(x.cpp)}</td><td class="n">${roas(x.roas)}</td>`;
}

/** Valor de um campo do formulário dos custos devolvido depois de um erro (texto curto, escapado ao mostrar). */
const sv = (q: any, k: string) => esc(String(q?.[k] ?? '').slice(0, 200));

/** Campos escondidos com o período (para os formulários voltarem ao mesmo período). */
const periodInputs = (p: Period) => `<input type="hidden" name="p" value="${esc(p.preset)}">${p.preset === 'custom' ? `<input type="hidden" name="from" value="${esc(p.from)}"><input type="hidden" name="to" value="${esc(p.to)}">` : ''}`;

export function metricsPage(m: Metrics, o: { ok?: string; e?: string; periodError?: string; link: ReturnType<typeof buildLink>; q: any; user: any }) {
  const p = m.period, t = m.totals, x = totalRatios(m), q = o.q ?? {};
  const pq = periodQuery(p);
  const sel = (v: string) => (p.preset === v ? 'selected' : '');
  const lk = o.link && 'url' in o.link ? o.link.url : '';
  const opt = (list: string[], cur: string, labels: Record<string, string> = {}) => list.map(v => `<option value="${v}" ${cur === v ? 'selected' : ''}>${esc(labels[v] ?? v)}</option>`).join('');
  const before = m.trackingSince && p.from < m.trackingSince ? m.trackingSince : null;
  const body = `<h1>Métricas das campanhas</h1>${flash(o.periodError, 'bad')}
<form method="get" action="/admin/metricas" class="card mt-form"><div class="row" style="align-items:flex-end">
<div><label for="mp">Período</label><select id="mp" name="p"><option value="7" ${sel('7')}>Últimos 7 dias</option><option value="30" ${sel('30')}>Últimos 30 dias</option><option value="90" ${sel('90')}>Últimos 90 dias</option><option value="custom" ${sel('custom')}>Personalizado (de / até)</option></select></div>
<div><label for="mf">De</label><input id="mf" name="from" type="date" value="${esc(p.from)}"></div><div><label for="mt">Até</label><input id="mt" name="to" type="date" value="${esc(p.to)}"></div>
<div><button class="accent">Ver</button></div><div class="right"><a class="btn ghost" href="/admin/metricas.csv?${esc(pq)}">Exportar CSV</a></div></div>
<p class="hint">De ${dayPt(p.from)} a ${dayPt(p.to)} (${p.days} ${p.days === 1 ? 'dia' : 'dias'}), datas em UTC. Para usar as datas «De» e «Até», escolha «Personalizado».</p>
${before ? `<p class="hint"><strong>As visitas só se contam desde ${dayPt(before)}.</strong> Os registos anteriores aparecem em «Registos», mas não entram na conversão (não há visitas contadas para eles).</p>` : ''}</form>

<div class="mt-grid">
${tile('Visitas', int(t.visits), 'landing e registo')}${tile('Registos', int(t.signups), 'contas criadas no site')}${tile('Conversão', pct(x.conversion), before ? `visita → registo, desde ${dayPt(before)}` : 'visita → registo')}
${tile('Ativados', int(t.activated), 'criaram ≥ 1 entrevista')}${tile('Com convite', int(t.invited), 'enviaram ≥ 1 convite')}${tile('Pagantes', int(t.paying), 'pagaram no período')}
${tile('Receita das contas novas', money(t.revenueCents), 'sem IVA')}${tile('Custo', money(t.spendCents), 'registado à mão')}${tile('Custo por registo', money(x.cpa), 'só campanhas com custo')}
${tile('Custo por pagante', money(x.cpp), 'só campanhas com custo')}${tile('ROAS', roas(x.roas), 'receita ÷ custo, só campanhas com custo')}${tile('Receita de todas as contas', money(m.allRevenueCents), 'sem IVA, no período')}
</div>

<div class="card"><div class="row"><h2 style="margin:0" class="grow">Por dia</h2><span class="mt-key"><span><i style="background:var(--accent)"></i>Visitas</span><span><i style="background:var(--ok)"></i>Registos</span></span></div>
${dailyChart(m.daily, m.trackingSince)}</div>

<div class="card" style="overflow-x:auto"><h2 style="margin-top:0">Por campanha</h2>
${m.rows.length ? `<table class="mt-table"><thead><tr><th>Origem / meio / campanha</th><th class="n">Visitas</th><th class="n">Registos</th><th class="n">Conversão</th><th class="n">Ativados</th><th class="n">Com convite</th><th class="n">Pagantes</th><th class="n">Receita</th><th class="n">Custo</th><th class="n">Custo / registo</th><th class="n">Custo / pagante</th><th class="n">ROAS</th></tr></thead>
<tbody>${m.rows.map(r => `<tr><td>${esc(rowLabel(r))}</td>${rowCells(r)}</tr>`).join('')}</tbody>
<tfoot><tr><td>Total</td>${rowCells(t, x)}</tr></tfoot></table>` : '<p class="hint">Sem visitas, registos nem custos neste período.</p>'}
<p class="hint">«(direto)»: sem etiquetas UTM nem site de origem (links escritos à mão, favoritos, apps que não dizem de onde vêm, e as contas criadas antes desta versão); inclui os registos de quem chegou por uma campanha mas saiu do caminho que leva as etiquetas (por exemplo, voltou mais tarde escrevendo o endereço) — ver «Como se calcula». «(referência) site»: veio de outro site sem etiquetas UTM. «${OTHER}»: o que passa dos ${MAX_TABLE_ROWS} primeiros da tabela ou do teto diário de combinações da contagem. No total, o custo por registo, o custo por pagante e o ROAS contam só as linhas com custo.</p></div>

<details class="card"><summary><strong>Como se calcula</strong></summary><div class="sans" style="font-size:.92rem">
<p><strong>Visitas</strong>: pedidos da landing (/) e da página de registo (/registar) contados por dia (UTC), página e etiquetas da campanha, sem cookies, sem IP e sem nada que identifique quem visitou. Não contam: robôs e pré-visualizações de links (LinkedIn, Facebook, WhatsApp…), pedidos HEAD e de pré-carregamento, quem tem sessão iniciada e a navegação dentro do próprio site (da landing para o registo, voltar à landing pelo logótipo, depois de sair da conta ou de outra página do portal), já contada à chegada. A mesma pessoa que volta mais tarde, de fora, conta outra vez. Cada dia guarda no máximo ${MAX_VISIT_ROWS_PER_DAY} combinações diferentes em cada um de quatro grupos: campanhas com custo registado abaixo; origens ${KNOWN_SOURCES.join(', ')} com campanha começada por «${PAID_PREFIX}»; outras campanhas dessas origens; e o resto (outras origens, sites de referência, direto). As novas de um grupo cheio contam em «${OTHER}»; assim, pedidos inventados com origens ou sites desconhecidos não escondem as campanhas verdadeiras.</p>
<p><strong>Campanha</strong>: as etiquetas <code>utm_source</code>, <code>utm_medium</code>, <code>utm_campaign</code> (e <code>utm_content</code>, <code>utm_term</code>, guardadas mas não mostradas na tabela), em minúsculas e só com letras, algarismos, «.», «_» e «-». Sem <code>utm_source</code>, conta o site de onde veio a visita (sem «www.»; os domínios do próprio portal não contam). As etiquetas seguem nos links da landing para o registo, para a galeria (/podcasts, e daí para os episódios e de volta à landing) e para a entrada (/entrar, e daí para o registo), e ficam guardadas na conta criada. <strong>Perdem-se</strong> (o registo conta em «(direto)», e a campanha fica com a visita mas sem o registo) quando a pessoa sai desse caminho — por exemplo, abre a privacidade ou os termos e volta pelo logótipo, fecha a página e volta mais tarde escrevendo o endereço, ou abre o link noutro navegador. Por isso, o custo por registo e o ROAS das campanhas são uma estimativa por baixo dos registos que trouxeram.</p>
<p><strong>Registos</strong>: contas criadas pela própria pessoa em /registar dentro do período (as criadas pelo administrador não contam). <strong>Conversão</strong> = registos ÷ visitas, só com os registos desde o início da contagem das visitas${m.trackingSince ? ` (${dayPt(m.trackingSince)})` : ''}. <strong>Ativados</strong>, <strong>com convite</strong> (convite enviado a um convidado), <strong>pagantes</strong> e <strong>receita</strong> referem-se a essas contas e ao que fizeram até ao fim do período. Para ver o que uma campanha rendeu mais tarde, alargue o fim do período.</p>
<p><strong>Receita</strong> (sem IVA, em euros): o dinheiro efetivamente recebido, pela lista «por faturar» de Faturação, que tem uma linha por pagamento confirmado pela Stripe (faturas pagas das subscrições, incluindo os acertos da mudança de plano, e carregamentos de créditos pagos) e as notas de crédito dos reembolsos dos carregamentos (a abater, na data do reembolso). Uma disputa perdida de um carregamento de créditos abate o valor debitado, na data em que foi perdida; aberta ou ganha não abate. As disputas de subscrições não são abatidas (a aplicação não as liga à receita). Cada pagamento e cada reembolso entra uma só vez. Não entram reembolsos de subscrições feitos no painel da Stripe nem pagamentos noutra moeda. <strong>Pagantes</strong>: contas com receita positiva no período.</p>
<p><strong>Custo</strong>: as entradas registadas abaixo, rateadas pelos dias (valor × dias em comum com o período ÷ dias da entrada) e imputadas às linhas da mesma origem e campanha (qualquer meio; com vários meios, repartidas pelas visitas de cada um). <strong>Custo por registo</strong> = custo ÷ registos; <strong>custo por pagante</strong> = custo ÷ pagantes; <strong>ROAS</strong> = receita ÷ custo. Nos cartões e na linha do total, estes três contam só as linhas com custo (as campanhas pagas): os registos e a receita de «(direto)» e «(referência)» não entram.</p></div></details>

<div class="card" id="custos"><h2 style="margin-top:0">Custos das campanhas</h2>
<p class="hint">O valor pago à rede (LinkedIn, Meta, Google…) por uma campanha num período, sem IVA. A origem e a campanha têm de ser as mesmas do link (ex.: <code>linkedin</code> e <code>qi-lancamento</code>).</p>
${flash(o.ok)}${flash(o.e, 'bad')}
<form method="post" action="/admin/metricas/custos" class="mt-form">${periodInputs(p)}
<div class="row"><div class="grow"><label for="sf">De</label><input id="sf" name="period_from" type="date" required value="${sv(q, 's_from')}"></div><div class="grow"><label for="st">Até</label><input id="st" name="period_to" type="date" required value="${sv(q, 's_to')}"></div>
<div class="grow"><label for="ss">Origem</label><input id="ss" name="source" type="text" list="mt-sources" required maxlength="100" autocomplete="off" value="${sv(q, 's_source')}"><datalist id="mt-sources">${LINK_SOURCES.filter(s => s !== 'other').map(s => `<option value="${s}">`).join('')}</datalist></div></div>
<div class="row"><div class="grow"><label for="sc">Campanha</label><input id="sc" name="campaign" type="text" maxlength="100" autocomplete="off" placeholder="qi-…" value="${sv(q, 's_campaign')}"></div><div class="grow"><label for="sa">Valor (€, sem IVA)</label><input id="sa" name="amount" type="text" inputmode="decimal" required placeholder="250,00" value="${sv(q, 's_amount')}"></div>
<div class="grow"><label for="sn">Nota (opcional)</label><input id="sn" name="note" type="text" maxlength="200" value="${sv(q, 's_note')}"></div></div>
<p><button class="accent">Registar custo</button></p></form>
${m.spend.length ? `<div style="overflow-x:auto"><table class="mt-table"><thead><tr><th>Período</th><th>Origem / campanha</th><th class="n">Valor</th><th class="n">Neste período</th><th>Nota</th><th></th></tr></thead><tbody>${m.spend.map(e => `<tr><td>${dayPt(e.period_from)} – ${dayPt(e.period_to)}</td><td>${esc(e.source)} / ${esc(e.campaign || '—')}</td><td class="n">${eurPt(e.amount_cents)}</td><td class="n">${money(e.inPeriodCents)}</td><td>${esc(e.note)}<br><span class="hint">${esc(e.created_by ?? '')} · ${fmtDate(e.created_at)}</span></td>
<td><form method="post" action="/admin/metricas/custos/${esc(e.id)}/apagar">${periodInputs(p)}<button class="danger" style="padding:6px 12px;min-height:0">Apagar</button></form></td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">Nenhum custo registado que toque este período.</p>'}</div>

<div class="card" id="link"><h2 style="margin-top:0">Construtor de links</h2>
<form method="get" action="/admin/metricas#link" class="mt-form">${periodInputs(p)}
<div class="row"><div class="grow"><label for="ls">Origem</label><select id="ls" name="l_source">${opt(LINK_SOURCES, String(q.l_source ?? 'linkedin'), { other: 'outra (escrever)' })}</select></div>
<div class="grow"><label for="lo">Outra origem</label><input id="lo" name="l_other" type="text" maxlength="100" value="${esc(q.l_source === 'other' ? normTag(q.l_other) : '')}"></div>
<div class="grow"><label for="lm">Meio</label><select id="lm" name="l_medium">${opt(LINK_MEDIUMS, String(q.l_medium ?? 'paid_social'))}</select></div></div>
<div class="row"><div class="grow"><label for="lc">Campanha</label><input id="lc" name="l_campaign" type="text" maxlength="100" required value="${esc(normTag(q.l_campaign))}" placeholder="qi-lancamento-outubro"></div>
<div class="grow"><label for="lt">Conteúdo (opcional)</label><input id="lt" name="l_content" type="text" maxlength="100" value="${esc(normTag(q.l_content))}" placeholder="video-1"></div></div>
<p class="hint">As campanhas pagas começam por «qi-». Os nomes ficam em minúsculas, sem acentos e com «-» em vez de espaços.</p>
<p><button class="accent" name="link" value="1">Criar link</button></p></form>
${o.link && 'error' in o.link ? flash(o.link.error, 'bad') : ''}
${lk ? `<label for="lk">Link da campanha</label><div class="row"><input id="lk" class="grow mt-link" type="text" readonly value="${esc(lk)}" style="flex:1;width:auto"><button type="button" class="ghost" id="lk-copy">Copiar</button></div><p class="hint" id="lk-st" role="status"></p>
<script>(()=>{const i=document.getElementById('lk'),b=document.getElementById('lk-copy'),s=document.getElementById('lk-st');i.addEventListener('focus',()=>i.select());
b.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(i.value);s.textContent='Link copiado.';}catch(e){i.focus();i.select();s.textContent='Selecionado: copie com Ctrl+C.';}});})();</script>` : ''}</div>`;
  return page({ title: 'Métricas', body: `<div class="wrap" style="padding-top:32px">${body}</div>`, nav: adminNav(o.user), noindex: true, styles: STYLES });
}

export async function metricsRoutes(app: FastifyInstance) {
  const db = app.db;
  const guard = (req: any, reply: any) => {
    if (!req.user) { reply.redirect('/entrar'); return false; }
    if (req.user.role !== 'admin') { reply.code(403).send('Acesso reservado a administradores'); return false; }
    return true;
  };
  /**
   * Volta à página (ao formulário dos custos, onde fica a mensagem) no período em que se estava (lido do formulário; um período
   * inválido volta aos 30 dias), ou noutro (`period`, para mostrar um custo registado fora do período em vista). Depois de um
   * erro, os valores escritos voltam ao formulário.
   */
  const back = (reply: any, body: any, msg: { ok?: string; e?: string }, o: { keep?: boolean; period?: Period } = {}) => {
    const period = o.period ?? parsePeriod(body).period;
    const m = msg.ok ? `&ok=${encodeURIComponent(msg.ok)}` : msg.e ? `&e=${encodeURIComponent(msg.e)}` : '';
    const keep = o.keep ? new URLSearchParams(([['s_from', 'period_from'], ['s_to', 'period_to'], ['s_source', 'source'], ['s_campaign', 'campaign'], ['s_amount', 'amount'], ['s_note', 'note']] as const)
      .map(([k, f]) => [k, String(body?.[f] ?? '').slice(0, 200)] as [string, string]).filter(([, v]) => v)).toString() : '';
    return reply.redirect(`/admin/metricas?${periodQuery(period)}${m}${keep ? `&${keep}` : ''}#custos`);
  };

  app.get('/admin/metricas', async (req, reply) => {
    if (!guard(req, reply)) return;
    const q = req.query as any;
    const { period, error } = parsePeriod(q);
    const m = await campaignMetrics(db, period);
    return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store')
      .send(metricsPage(m, { ok: q.ok, e: q.e, periodError: error, link: buildLink(q), q, user: req.user }));
  });

  app.get('/admin/metricas.csv', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { period } = parsePeriod(req.query);
    const m = await campaignMetrics(db, period);
    return reply.type('text/csv; charset=utf-8').header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="metricas-${period.from}-${period.to}.csv"`).send(metricsCsv(m));
  });

  app.post('/admin/metricas/custos', async (req, reply) => {
    if (!guard(req, reply)) return;
    const b = (req.body ?? {}) as any;
    const from = String(b.period_from ?? '').trim(), to = String(b.period_to ?? '').trim();
    const fail = (e: string) => back(reply, b, { e }, { keep: true });
    if (!validDay(from) || !validDay(to)) return fail('Indique as datas de início e de fim do custo (entre 2000 e 2100).');
    if (from > to) return fail('A data de início do custo é depois da data de fim.');
    if (daysBetween(from, to) > MAX_PERIOD_DAYS) return fail(`O período do custo tem mais de ${MAX_PERIOD_DAYS} dias.`);
    const source = normTag(b.source), campaign = normTag(b.campaign);
    if (!source) return fail('Indique a origem (ex.: linkedin).');
    const am = /^\s*(\d{1,7})(?:[.,](\d{1,2}))?\s*(?:€)?\s*$/.exec(String(b.amount ?? '').slice(0, 100));
    const cents = am ? Number(am[1]) * 100 + Number((am[2] ?? '0').padEnd(2, '0')) : 0;
    if (!am || cents <= 0) return fail('Valor inválido: escreva um valor maior do que zero, em euros (ex.: 250 ou 250,50).');
    const note = String(b.note ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
    const e = await db.one(`INSERT INTO campaign_spend(period_from, period_to, source, campaign, amount_cents, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [from, to, source, campaign, cents, note, req.user!.email]);
    await audit(db, req.user!.email, 'admin.campaign_spend_added', null, { id: e.id, source, campaign, amountCents: cents, from, to });
    const ok = `Custo de ${eurPt(cents)} registado (${source} / ${campaign || '—'}, de ${dayPt(from)} a ${dayPt(to)}).`;
    // Fora do período em vista, mostra-se o período do próprio custo (para se ver que ficou registado e não se repetir).
    const { period } = parsePeriod(b);
    if (to < period.from || from > period.to) {
      return back(reply, b, { ok: `${ok} Fica fora do período que estava a ver: mostra-se agora o período do custo.` }, { period: { from, to, days: daysBetween(from, to), preset: 'custom' } });
    }
    return back(reply, b, { ok });
  });

  app.post('/admin/metricas/custos/:id/apagar', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = String((req.params as any).id);
    const b = (req.body ?? {}) as any;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return back(reply, b, { e: 'Custo inexistente.' });
    const e = await db.one('DELETE FROM campaign_spend WHERE id=$1 RETURNING source, campaign, amount_cents, period_from::text AS period_from, period_to::text AS period_to', [id]);
    if (!e) return back(reply, b, { e: 'Custo inexistente (já apagado?).' });
    await audit(db, req.user!.email, 'admin.campaign_spend_deleted', null, { id, source: e.source, campaign: e.campaign, amountCents: e.amount_cents, from: e.period_from, to: e.period_to });
    return back(reply, b, { ok: 'Custo apagado.' });
  });
}
