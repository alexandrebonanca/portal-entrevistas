import type { FastifyRequest } from 'fastify';
import type { Db } from './db.ts';
import { config } from './config.ts';

/**
 * Métricas das campanhas (LinkedIn, Instagram/Facebook, Google e publicações orgânicas que levam a quietinterview.com com
 * etiquetas UTM), só com dados próprios: sem cookies, sem píxeis nem scripts de terceiros, sem IP nem dados pessoais das visitas.
 * - Visitas: um contador por dia (UTC), página e etiquetas (`campaign_visits`).
 * - Registo: as etiquetas seguem nos links da landing para /registar e vão no formulário (campos escondidos); ficam na conta.
 */

export interface Tags { source: string; medium: string; campaign: string; content: string; term: string; ref: string }
export const NO_TAGS: Tags = { source: '', medium: '', campaign: '', content: '', term: '', ref: '' };
const UTM: [keyof Tags, string][] = [['source', 'utm_source'], ['medium', 'utm_medium'], ['campaign', 'utm_campaign'], ['content', 'utm_content'], ['term', 'utm_term']];

/**
 * Valor de uma etiqueta: minúsculas, sem espaços nas pontas, acentos tirados e espaços por «-», só [a-z0-9._-], até 100
 * caracteres; vazio se não for texto. Um parâmetro repetido conta pelo primeiro valor.
 */
export function normTag(v: unknown): string {
  const s = typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
  return s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').slice(0, 100);
}

/** Domínios do próprio portal: uma visita que vem deles não é uma referência de outro site. */
export function ownHosts(reqHost?: string): Set<string> {
  const out = new Set(['quietinterview.com', 'portal-entrevistas.onrender.com']);
  try { out.add(new URL(config.baseUrl).hostname.toLowerCase().replace(/^www\./, '')); } catch { /* BASE_URL inválido: só os fixos */ }
  const h = String(reqHost ?? '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
  if (h) out.add(h);
  return out;
}

/**
 * Domínio de quem enviou a visita (cabeçalho Referer, um URL http/https, ou o campo `ref` já com um domínio), sem «www.»,
 * só [a-z0-9.-], até 100 caracteres; vazio para os domínios do próprio portal ou um valor que não é um domínio.
 */
export function refHost(v: unknown, own: Set<string>): string {
  let s = (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '').trim().toLowerCase();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:/.test(s)) {
    try { const u = new URL(s); if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''; s = u.hostname; } catch { return ''; }
  }
  s = s.replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '').slice(0, 100);
  if (!/[a-z0-9]\.[a-z]/.test(s) || own.has(s)) return '';
  return s;
}

/** O Referer é uma página do próprio portal (navegação interna, por exemplo da landing para o registo)? */
export function fromOwnSite(referer: unknown, own: Set<string>): boolean {
  try { return own.has(new URL(String(referer ?? '')).hostname.toLowerCase().replace(/^www\./, '')); } catch { return false; }
}

/**
 * Etiquetas de um pedido: as UTM quando há utm_source (sem ela, as outras não contam: um link sem origem não é de uma campanha);
 * senão, o site de onde veio (`ref` carregado da landing, ou o Referer quando é de outro site).
 */
export function tagsFrom(query: any, referer: unknown, own: Set<string>): Tags {
  const q = query ?? {};
  const t: Tags = { ...NO_TAGS };
  for (const [k, p] of UTM) t[k] = normTag(q[p]);
  if (!t.source) return { ...NO_TAGS, ref: refHost(q.ref, own) || refHost(referer, own) };
  return t;
}

/** Parâmetros a acrescentar aos links para /registar ('' sem etiquetas), já normalizados. */
export function campaignQuery(t: Tags): string {
  const p = new URLSearchParams();
  if (t.source) { for (const [k, name] of UTM) if (t[k]) p.set(name, t[k]); }
  else if (t.ref) p.set('ref', t.ref);
  return p.toString();
}

/** Campos escondidos do formulário de registo (valores normalizados; escapados por segurança). */
export function campaignInputs(t: Tags): string {
  const e = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const out: string[] = [];
  if (t.source) { for (const [k, name] of UTM) if (t[k]) out.push(`<input type="hidden" name="${name}" value="${e(t[k])}">`); }
  else if (t.ref) out.push(`<input type="hidden" name="ref" value="${e(t.ref)}">`);
  return out.join('');
}

/** Robôs, pré-visualizações de links (LinkedIn, Facebook, WhatsApp…), monitores e clientes de linha de comandos. */
const BOT_UA = /bot\b|bot[/;)]|crawl|spider|slurp|facebookexternalhit|facebot|linkedinbot|twitterbot|whatsapp|telegram|discord|slack|skypeuripreview|embedly|preview|pinterest|vkshare|w3c_validator|headless|phantomjs|lighthouse|pagespeed|gtmetrix|uptime|monitor|pingdom|statuscake|python|curl|wget|httpie|go-http-client|okhttp|axios|node-fetch|undici|java\/|libwww|scrapy|httpclient|feedfetcher|mediapartners|apis-google|ahrefs|semrush|mj12|bytespider|chatgpt|claude-user|perplexity/i;
export const isBot = (ua: unknown) => { const s = String(ua ?? ''); return !s || s.length > 1000 || BOT_UA.test(s); };

/**
 * Conta-se a visita? Só GET (HEAD e pré-carregamentos não), sem robôs, e nunca de quem tem sessão iniciada
 * (o próprio administrador ou clientes que já têm conta não são visitas de campanha).
 */
export function countable(req: FastifyRequest): boolean {
  if (req.method !== 'GET' || req.user) return false;
  const h = req.headers;
  if (/prefetch|prerender/i.test(String(h['sec-purpose'] ?? h['purpose'] ?? h['x-moz'] ?? ''))) return false;
  return !isBot(h['user-agent']);
}

/** Dia de hoje em UTC (AAAA-MM-DD). */
export const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

/** Soma um ao contador do dia (um só INSERT … ON CONFLICT). */
export async function countVisit(db: Db, path: string, t: Tags, day = utcDay()) {
  await db.query(
    `INSERT INTO campaign_visits(day, path, source, medium, campaign, content, term, referrer_host, n) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1)
     ON CONFLICT (day, path, source, medium, campaign, content, term, referrer_host) DO UPDATE SET n = campaign_visits.n + 1`,
    [day, path, t.source, t.medium, t.campaign, t.content, t.term, t.source ? '' : t.ref]);
}

/**
 * Regista a visita sem nunca estragar nem atrasar a página: um erro na base fica só no registo (um INSERT barato e esperado,
 * para que os testes e a contagem sejam deterministas).
 */
export async function trackVisit(req: FastifyRequest, db: Db, path: string, t: Tags) {
  if (!countable(req)) return;
  try { await countVisit(db, path, t); } catch (e: any) { req.log.error({ err: String(e?.message ?? e) }, 'métricas: visita não contada'); }
}

// ---------- página do administrador ----------
export interface Period { from: string; to: string; days: number; preset: '7' | '30' | '90' | 'custom' }
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (s: string) => DAY_RE.test(s) && utcDay(Date.parse(`${s}T00:00:00Z`)) === s;
export const addDaysUtc = (day: string, n: number) => utcDay(Date.parse(`${day}T00:00:00Z`) + n * 86400_000);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000) + 1;
export const MAX_PERIOD_DAYS = 1100;

/** Período escolhido: 7, 30 ou 90 dias até hoje (UTC), ou de/até. Uma escolha inválida volta aos 30 dias, com o motivo. */
export function parsePeriod(q: any, today = utcDay()): { period: Period; error?: string } {
  const last = (n: 7 | 30 | 90): Period => ({ from: addDaysUtc(today, -(n - 1)), to: today, days: n, preset: String(n) as '7' });
  const from = String(q?.from ?? '').trim(), to = String(q?.to ?? '').trim();
  if (q?.p === 'custom' || ((from || to) && !['7', '30', '90'].includes(q?.p))) {
    if (!validDay(from) || !validDay(to)) return { period: last(30), error: 'Indique as duas datas do período (de e até).' };
    if (from > to) return { period: last(30), error: 'A data inicial é depois da data final.' };
    const days = daysBetween(from, to);
    if (days > MAX_PERIOD_DAYS) return { period: last(30), error: `O período tem mais de ${MAX_PERIOD_DAYS} dias.` };
    return { period: { from, to, days, preset: 'custom' } };
  }
  return { period: last(q?.p === '7' ? 7 : q?.p === '90' ? 90 : 30) };
}
/** Parâmetros do período para links e formulários. */
export const periodQuery = (p: Period) => (p.preset === 'custom' ? `p=custom&from=${p.from}&to=${p.to}` : `p=${p.preset}`);

export interface Row {
  key: string; source: string; medium: string; campaign: string; ref: string;
  visits: number; signups: number; activated: number; invited: number; paying: number; revenueCents: number; spendCents: number;
}
export interface SpendEntry { id: string; period_from: string; period_to: string; source: string; campaign: string; amount_cents: number; note: string; created_at: any; created_by: string | null; inPeriodCents: number }
export interface Metrics { period: Period; rows: Row[]; totals: Row; allRevenueCents: number; daily: { day: string; visits: number; signups: number }[]; spend: SpendEntry[] }

/** Chave da linha: origem / meio / campanha; sem origem, «(referência) site» ou «(direto)». */
export function keyOf(source: string, medium: string, campaign: string, ref: string) {
  if (source) return { key: `s:${source}\u0000${medium}\u0000${campaign}`, source, medium, campaign, ref: '' };
  if (ref) return { key: `r:${ref}`, source: '', medium: '', campaign: '', ref };
  return { key: 'direct', source: '', medium: '', campaign: '', ref: '' };
}
export const rowLabel = (r: Pick<Row, 'source' | 'medium' | 'campaign' | 'ref'>) =>
  r.source ? `${r.source} / ${r.medium || '—'} / ${r.campaign || '—'}` : r.ref ? `(referência) ${r.ref}` : '(direto)';

const emptyRow = (k: ReturnType<typeof keyOf>): Row => ({ ...k, visits: 0, signups: 0, activated: 0, invited: 0, paying: 0, revenueCents: 0, spendCents: 0 });
const day = (v: any) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/**
 * Custo de uma entrada imputado ao período: rateado pelos dias (o valor × dias em comum ÷ dias da entrada, datas inclusivas).
 * Ex.: 300 € de 1 a 30 de setembro e período de 21 a 30 de setembro → 100 €.
 */
export function prorate(e: { period_from: string; period_to: string; amount_cents: number }, p: Period) {
  const a = e.period_from > p.from ? e.period_from : p.from, b = e.period_to < p.to ? e.period_to : p.to;
  if (a > b) return 0;
  return (e.amount_cents * daysBetween(a, b)) / daysBetween(e.period_from, e.period_to);
}

/**
 * Métricas do período, por chave da campanha.
 *
 * Coorte: as contas criadas pela própria pessoa em /registar (`self_signup`) dentro do período; cada uma conta na chave das
 * etiquetas com que se registou (as anteriores a esta versão e as que vieram sem etiquetas ficam em «(direto)»). Ativação,
 * convites, pagantes e receita contam o que essas contas fizeram até ao fim do período (as contas criadas pelo administrador
 * não entram).
 *
 * Receita (dinheiro efetivamente recebido, sem IVA, em euros): a lista «por faturar» (`invoice_queue`), que tem uma linha por
 * pagamento confirmado pela Stripe — faturas pagas das subscrições (`invoice.paid`, incluindo os acertos negativos da mudança
 * de plano) e carregamentos de créditos pagos — e as notas de crédito dos reembolsos dos carregamentos (valores negativos,
 * na data do reembolso, e a linha corretiva quando um reembolso falha depois de concluído). Soma-se `net_cents` pela data do
 * pagamento (`paid_at`). Cada pagamento e cada reembolso aparece lá uma só vez (`stripe_ref` único), por isso não há dupla
 * contagem; `payment_events` (eventos em bruto), `subscriptions` (estado atual), `credit_topups` e `wallet_entries`
 * (créditos, que são a mesma receita vista pela carteira) não se somam. As disputas não passam pela lista: só uma disputa
 * perdida tira receita, o líquido debitado na carteira (`wallet_entries` 'dispute', fechada por 'dispute_lost'), na data em que
 * foi perdida; uma disputa aberta ou ganha não tira nada. Não entram: reembolsos de subscrições feitos no painel da Stripe (a
 * aplicação ainda não os regista) e pagamentos noutra moeda que não o euro.
 *
 * Custos: as entradas manuais que tocam o período, rateadas pelos dias (`prorate`) e imputadas às linhas da mesma origem e
 * campanha (qualquer meio); havendo várias, repartidas pelas visitas de cada uma (em partes iguais sem visitas). Sem nenhuma
 * linha dessa origem e campanha, a entrada aparece numa linha própria, só com o custo.
 */
export async function campaignMetrics(db: Db, period: Period): Promise<Metrics> {
  const start = `${period.from}T00:00:00Z`, end = `${addDaysUtc(period.to, 1)}T00:00:00Z`;
  const rows = new Map<string, Row>();
  const rowFor = (k: ReturnType<typeof keyOf>) => { let r = rows.get(k.key); if (!r) rows.set(k.key, (r = emptyRow(k))); return r; };
  const daily = new Map<string, { day: string; visits: number; signups: number }>();
  for (let d = period.from; d <= period.to; d = addDaysUtc(d, 1)) daily.set(d, { day: d, visits: 0, signups: 0 });

  const visits = await db.query(`SELECT day::text AS day, source, medium, campaign, referrer_host, sum(n)::int AS n FROM campaign_visits
    WHERE day BETWEEN $1::date AND $2::date GROUP BY 1,2,3,4,5`, [period.from, period.to]);
  for (const v of visits) {
    rowFor(keyOf(v.source, v.medium, v.campaign, v.referrer_host)).visits += v.n;
    const d = daily.get(day(v.day)); if (d) d.visits += v.n;
  }

  // Disputas perdidas: o líquido debitado na abertura (disponível tirado + dívida criada), na data em que foi perdida.
  const lostSql = `SELECT w.user_id, (d.debt_delta - d.available_delta) AS net FROM wallet_entries l
      JOIN wallet_entries d ON d.kind='dispute' AND d.stripe_ref=l.stripe_ref JOIN wallets w ON w.id=d.wallet_id
     WHERE l.kind='dispute_lost' AND l.created_at >= $1::timestamptz AND l.created_at < $2::timestamptz`;
  const users = await db.query(`SELECT u.id, (u.created_at AT TIME ZONE 'UTC')::date::text AS day,
      COALESCE(u.utm_source,'') AS source, COALESCE(u.utm_medium,'') AS medium, COALESCE(u.utm_campaign,'') AS campaign, COALESCE(u.signup_referrer_host,'') AS ref,
      EXISTS (SELECT 1 FROM interviews i WHERE i.owner_id=u.id AND i.created_at < $2::timestamptz) AS activated,
      EXISTS (SELECT 1 FROM invitations v JOIN interviews i ON i.id=v.interview_id WHERE i.owner_id=u.id AND v.purpose='invite' AND v.created_at < $2::timestamptz) AS invited,
      COALESCE((SELECT sum(q.net_cents) FROM invoice_queue q WHERE q.user_id=u.id AND q.currency='eur' AND q.paid_at >= $1::timestamptz AND q.paid_at < $2::timestamptz), 0)::int
        - COALESCE((SELECT sum(x.net) FROM (${lostSql}) x WHERE x.user_id=u.id), 0)::int AS revenue
    FROM users u WHERE u.self_signup AND u.created_at >= $1::timestamptz AND u.created_at < $2::timestamptz`, [start, end]);
  for (const u of users) {
    const r = rowFor(keyOf(u.source, u.medium, u.campaign, u.ref));
    r.signups++; if (u.activated) r.activated++; if (u.invited) r.invited++;
    r.revenueCents += Number(u.revenue); if (Number(u.revenue) > 0) r.paying++;
    const d = daily.get(day(u.day)); if (d) d.signups++;
  }

  // Receita do período de todas as contas (para comparar com a das contas novas).
  const all = await db.one(`SELECT COALESCE((SELECT sum(net_cents) FROM invoice_queue WHERE currency='eur' AND paid_at >= $1::timestamptz AND paid_at < $2::timestamptz), 0)::int
      - COALESCE((SELECT sum(x.net) FROM (${lostSql}) x), 0)::int AS n`, [start, end]);

  const spendRows = await db.query(`SELECT id, period_from::text AS period_from, period_to::text AS period_to, source, campaign, amount_cents, note, created_at, created_by
    FROM campaign_spend WHERE period_to >= $1::date AND period_from <= $2::date ORDER BY period_from DESC, created_at DESC`, [period.from, period.to]);
  const spend: SpendEntry[] = spendRows.map((e: any) => ({ ...e, period_from: day(e.period_from), period_to: day(e.period_to), inPeriodCents: 0 }));
  for (const e of spend) {
    e.inPeriodCents = prorate(e, period);
    if (!e.inPeriodCents) continue;
    let targets = [...rows.values()].filter(r => r.source === e.source && r.campaign === e.campaign);
    if (!targets.length) targets = [rowFor(keyOf(e.source, '', e.campaign, ''))];
    const tv = targets.reduce((s, r) => s + r.visits, 0);
    for (const r of targets) r.spendCents += tv ? (e.inPeriodCents * r.visits) / tv : e.inPeriodCents / targets.length;
  }

  const list = [...rows.values()].sort((a, b) => b.visits - a.visits || b.signups - a.signups || b.spendCents - a.spendCents || rowLabel(a).localeCompare(rowLabel(b)));
  const totals = emptyRow({ key: 'total', source: '', medium: '', campaign: '', ref: '' });
  for (const r of list) for (const k of ['visits', 'signups', 'activated', 'invited', 'paying', 'revenueCents', 'spendCents'] as const) totals[k] += r[k];
  return { period, rows: list, totals, allRevenueCents: Number(all?.n ?? 0), daily: [...daily.values()], spend };
}

/** Indicadores derivados (null quando não há base para os calcular). */
export function ratios(r: Row) {
  return {
    conversion: r.visits ? r.signups / r.visits : null,
    cpa: r.spendCents && r.signups ? r.spendCents / r.signups : null,
    cpp: r.spendCents && r.paying ? r.spendCents / r.paying : null,
    roas: r.spendCents ? r.revenueCents / r.spendCents : null,
  };
}

// ---------- CSV ----------
/**
 * Célula de CSV (separador «;», como o Excel em português espera): texto que começa por = + - @ (ou tabulação/CR) leva um
 * apóstrofo à frente, para não ser lido como fórmula; aspas, «;» e mudanças de linha vão entre aspas, com as aspas dobradas.
 */
export function csvCell(v: string | number | null, text = typeof v === 'string'): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(v) : v;
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const num = (v: number | null, d = 2) => (v === null ? null : v.toFixed(d).replace('.', ','));

export function metricsCsv(m: Metrics): string {
  const head = ['Origem', 'Meio', 'Campanha', 'Site de referência', 'Visitas', 'Registos', 'Conversão (%)', 'Ativados', 'Com convite', 'Pagantes', 'Receita sem IVA (EUR)', 'Custo (EUR)', 'Custo por registo (EUR)', 'Custo por pagante (EUR)', 'ROAS'];
  const line = (r: Row, label?: string) => {
    const x = ratios(r);
    const origin = label ?? (r.source || (r.ref ? '(referência)' : '(direto)'));
    return [csvCell(origin, true), csvCell(r.medium, true), csvCell(r.campaign, true), csvCell(r.ref, true), csvCell(r.visits), csvCell(r.signups),
      csvCell(num(x.conversion === null ? null : x.conversion * 100, 1), false), csvCell(r.activated), csvCell(r.invited), csvCell(r.paying),
      csvCell(num(r.revenueCents / 100), false), csvCell(num(r.spendCents / 100), false), csvCell(num(x.cpa === null ? null : x.cpa / 100), false),
      csvCell(num(x.cpp === null ? null : x.cpp / 100), false), csvCell(num(x.roas), false)].join(';');
  };
  return '﻿' + [head.map(h => csvCell(h, true)).join(';'), ...m.rows.map(r => line(r)), line(m.totals, 'Total')].join('\r\n') + '\r\n';
}

// ---------- construtor de links ----------
export const LINK_SOURCES = ['linkedin', 'instagram', 'facebook', 'google', 'newsletter', 'other'];
export const LINK_MEDIUMS = ['paid_social', 'social', 'cpc', 'email', 'referral'];

/** Link da campanha para a landing (BASE_URL); null com o motivo quando falta a origem, o meio ou a campanha. */
export function buildLink(q: any): { url: string } | { error: string } | null {
  if (!q || q.link === undefined) return null;
  const src = q.l_source === 'other' ? normTag(q.l_other) : LINK_SOURCES.includes(q.l_source) ? q.l_source : '';
  const med = LINK_MEDIUMS.includes(q.l_medium) ? q.l_medium : '';
  const camp = normTag(q.l_campaign), content = normTag(q.l_content);
  if (!src) return { error: q.l_source === 'other' ? 'Escreva o nome da outra origem.' : 'Escolha a origem.' };
  if (!med) return { error: 'Escolha o meio.' };
  if (!camp) return { error: 'Escreva o nome da campanha (letras, algarismos, «.», «_» ou «-»).' };
  const p = new URLSearchParams({ utm_source: src, utm_medium: med, utm_campaign: camp });
  if (content) p.set('utm_content', content);
  return { url: `${config.baseUrl}/?${p.toString()}` };
}
