import { config } from './config.ts';
import type { Db } from './db.ts';
import { esc } from './lib.ts';
import { sellerS, stripeScopedValue, inEntity, ownsAny, SELLER_CORE_KEYS, SELLER_CONSUMER_KEYS } from './settings.ts';
import { sellerVatProblems, normVatNumber, isEuCountry, countryName, regionalRate, ptRegion, withVat, eurPt, fmtRate, EU_STANDARD_RATES, type VatSeller } from './vat.ts';

/** Versão dos termos de venda (guardada na Stripe, na auditoria e na lista «por faturar»). */
export const TERMS_VERSION = '2026-10-21';
/** Prazo da livre resolução dos consumidores (DL 24/2014, art. 10.º). */
export const WITHDRAWAL_DAYS = 14;
/**
 * Entidade gestora da plataforma (não vende ao cliente final). Os mesmos dados que o rodapé mostra a partir de config.owner
 * (ramo do rodapé); quando os ramos se juntarem, passa a ler-se daí.
 */
export const PLATFORM_MANAGER = { name: 'Certif Int Association OÜ', country: 'Estónia', url: 'https://www.certifinternational.com', email: 'certifinternational@gmail.com' };

const LABELS: Record<string, string> = {
  SELLER_NAME: 'denominação social completa', SELLER_NIF: 'NIF', SELLER_ADDRESS: 'morada da sede',
  SELLER_EMAIL: 'email de contacto', SELLER_COMPLAINTS_URL: 'ligação do Livro de Reclamações Eletrónico',
};

export interface Seller {
  tradeName: string; name: string; nif: string; country: string; address: string; email: string; complaintsUrl: string; adr: string;
  regime: string; ossActive: boolean; vat: VatSeller;
  /** Falta algum destes: não se vende a ninguém (denominação, NIF, morada e regime de IVA). */
  missingCore: string[];
  /** Falta algum destes: não se vende a consumidores (contacto e Livro de Reclamações). */
  missingConsumer: string[];
  canSell: boolean; canSellConsumer: boolean;
}

/** Empresa que vende na conta Stripe em contexto (Definições «Empresa vendedora»; nada é inventado). */
export function seller(): Seller {
  const v = (k: string) => sellerS(k).trim();
  const country = v('SELLER_COUNTRY'), regime = v('SELLER_VAT_REGIME'), nif = v('SELLER_NIF');
  const vat: VatSeller = { country, regime, vatNumber: regime === 'registered' && isEuCountry(country) ? normVatNumber(country, nif) : null, ossActive: v('OSS_ACTIVE') === '1' };
  const missingCore = SELLER_CORE_KEYS.filter(k => !v(k)).map(k => LABELS[k]);
  // O NIF em falta já está na lista; não se repete como problema de IVA.
  for (const p of sellerVatProblems(vat)) if (nif || !p.startsWith('NIF')) missingCore.push(p);
  const missingConsumer = SELLER_CONSUMER_KEYS.filter(k => !v(k)).map(k => LABELS[k]);
  return {
    tradeName: v('SELLER_TRADE_NAME'), name: v('SELLER_NAME'), nif, country, address: v('SELLER_ADDRESS'), email: v('SELLER_EMAIL'),
    complaintsUrl: v('SELLER_COMPLAINTS_URL'), adr: v('SELLER_ADR'), regime, ossActive: vat.ossActive!, vat,
    missingCore, missingConsumer, canSell: !missingCore.length, canSellConsumer: !missingCore.length && !missingConsumer.length,
  };
}

/** Contacto mostrado nas recusas («contacte-nos»). */
export const contactEmail = (s: Seller = seller()) => s.email || config.supportEmail;

/** Motivo para recusar um pagamento em linha (subscrição ou carregamento) a quem não é administrador; null = pode pagar. */
export function checkoutBlock(s: Seller, consumer: boolean): { pt: string; en: string } | null {
  const c = contactEmail(s);
  if (!s.canSell) return { pt: `Os pagamentos em linha estão suspensos enquanto faltarem dados da empresa vendedora. Contacte-nos: ${c}.`, en: `Online payments are paused until the seller’s details are complete. Please contact us at ${c}.` };
  if (consumer && !s.canSellConsumer) return { pt: `A subscrição em linha para consumidores ainda não está disponível. Contacte-nos: ${c}.`, en: `Online subscriptions for consumers are not open yet. Please contact us at ${c}.` };
  return null;
}

/** Taxa de IVA de um consumidor no país (e, em Portugal, no continente) do vendedor; null se ainda não se souber. */
export function homeConsumerRate(s: Seller): number | null {
  if (s.regime === 'not_registered') return 0;
  if (s.regime !== 'registered' || !isEuCountry(s.country)) return null;
  return s.country === 'PT' ? ptRegion('1000-001').rate : EU_STANDARD_RATES[s.country];
}

/** O nome da conta Stripe corresponde à empresa vendedora? (sem acentos, pontuação nem a forma jurídica) */
export function sameCompany(stripeName: string, names: string[]) {
  const norm = (v: string) => ` ${v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `
    .replace(/ (lda|limitada|unipessoal|sa|s a|sociedade|anonima|ltd|oü|ou|gmbh|sl|srl|bv) /g, ' ').replace(/\s+/g, ' ').trim();
  const a = norm(stripeName);
  return !!a && names.map(norm).filter(Boolean).some(b => a.includes(b) || b.includes(a));
}

/** Conta Stripe lida em «Guardar e testar» (nome e identificador), guardada na conta Stripe em contexto. */
export function savedStripeAccount(): { id?: string; name?: string; checkedAt?: string } {
  try { return JSON.parse(stripeScopedValue('STRIPE_ACCOUNT') || '{}'); } catch { return {}; }
}

/** Avisos para o administrador: a conta Stripe global e as das entidades com Stripe própria. */
export async function sellerWarnings(db: Db): Promise<string[]> {
  const out: string[] = [];
  const check = (who: string) => {
    const s = seller();
    if (s.missingCore.length) out.push(`${who}: pagamentos em linha suspensos para quem não é administrador — falta ${s.missingCore.join(', ')}.`);
    else if (s.missingConsumer.length) out.push(`${who}: venda a consumidores bloqueada — falta ${s.missingConsumer.join(', ')}.`);
    const acct = savedStripeAccount();
    if (acct.name && (s.name || s.tradeName) && !sameCompany(acct.name, [s.name, s.tradeName]))
      out.push(`${who}: a conta Stripe chama-se «${acct.name}», que não coincide com a empresa vendedora «${s.name || s.tradeName}». Confirme que as chaves são as da conta Stripe da empresa vendedora.`);
  };
  inEntity(null, () => check('Empresa vendedora (definições globais)'));
  for (const e of await db.query('SELECT id, name FROM entities WHERE active ORDER BY name')) {
    if (ownsAny(e.id, ['STRIPE_SECRET_KEY'])) inEntity(e.id, () => check(`Entidade ${e.name} (Stripe própria)`));
  }
  return out;
}

const MISSING = '<em>(por preencher pelo administrador)</em>';
const val = (v: string) => (v ? esc(v) : MISSING);
const mail = (m: string) => (m ? `<a href="mailto:${esc(m)}">${esc(m)}</a>` : MISSING);
export const complaintsLink = (s: Seller) => (s.complaintsUrl ? `<a href="${esc(s.complaintsUrl)}" rel="noopener" target="_blank">Livro de Reclamações Eletrónico</a>` : `Livro de Reclamações Eletrónico ${MISSING}`);

/** Identificação da empresa vendedora (termos, privacidade dos pagamentos, emails). */
export function sellerBlock(s: Seller) {
  return `<p>${val(s.name)}${s.tradeName ? ` (${esc(s.tradeName)})` : ''}<br>NIF ${val(s.nif)} · Sede: ${val(s.address)}${s.country ? `, ${esc(countryName(s.country))}` : ''}<br>
Contacto: ${mail(s.email)} · ${complaintsLink(s)}</p>`;
}
const managerBlock = () => `<p>A plataforma ${esc(config.brand)} é gerida pela ${esc(PLATFORM_MANAGER.name)} (${esc(PLATFORM_MANAGER.country)}; <a href="${esc(PLATFORM_MANAGER.url)}" rel="noopener">${esc(PLATFORM_MANAGER.url.replace(/^https?:\/\//, ''))}</a>; ${mail(PLATFORM_MANAGER.email)}), entidade gestora, que não vende ao cliente final: o contrato de venda é celebrado com a empresa vendedora identificada acima.</p>`;

/** Como o IVA é tratado, em palavras. */
export function vatExplanation(s: Seller) {
  if (s.regime === 'not_registered') return 'Não é cobrado IVA: a empresa vendedora não está registada para efeitos de IVA.';
  const home = homeConsumerRate(s);
  const pt = s.country === 'PT';
  return `${pt ? 'Clientes com morada de faturação em Portugal: IVA de 23% no continente, 22% na Madeira e 16% nos Açores (pela morada da sede, no caso das empresas).' : `Clientes em ${esc(countryName(s.country))}: IVA de ${home === null ? '—' : fmtRate(home)}%.`}
Empresas de outros países da UE com número de IVA válido, verificado no VIES: sem IVA, por autoliquidação. Consumidores (e empresas sem número de IVA válido) de outros países da UE: ${s.ossActive ? 'a taxa normal de IVA do país do consumidor, declarada pelo balcão único (OSS)' : `IVA ${pt ? 'português' : `de ${esc(countryName(s.country))}`}${home === null ? '' : ` de ${fmtRate(home)}%`}`}. O preço com IVA aparece sempre antes de pagar.`;
}

/** Tarifas ativas da animação (para os termos): rótulo, cêntimos de crédito por minuto de fala e resolução. */
export type TermsRate = { label: string; cents_per_min: number; resolution: string };

/** Termos e condições de venda (em português: informação obrigatória aos consumidores). */
export function termsBody(plans: any[], s: Seller, rates: TermsRate[] = []) {
  const p0 = plans[0];
  const pt = s.country === 'PT' && s.regime === 'registered';
  const regions: [string, string][] = [['1000-001', 'continente'], ['9000-001', 'Madeira'], ['9500-001', 'Açores']];
  const head = pt ? regions.map(([cp, l]) => `<th>Com IVA ${regionalRate('PT', cp)}% (${l})</th>`).join('') : '';
  const row = (p: any) => `<tr><td>${esc(p.name)}</td><td>${p.interviews_per_month}</td><td>${eurPt(p.price_cents)}/mês + IVA</td>${pt ? regions.map(([cp]) => `<td>${eurPt(withVat(p.price_cents, regionalRate('PT', cp)))}/mês</td>`).join('') : ''}</tr>`;
  return `<div class="narrow" style="padding-top:40px"><h1>Termos e condições de venda</h1><p class="hint">Versão ${TERMS_VERSION}</p>
<h2>1. Quem vende</h2>${sellerBlock(s)}${managerBlock()}
<h2>2. O serviço</h2><p>${esc(config.brand)} é um serviço em linha para fazer entrevistas assíncronas e produzir, a partir das respostas, um episódio em áudio e um vídeo com fotografias e legendas.</p>
<p>As subscrições incluem só imagens: fotografias, voz sintética, transcrição, tradução para inglês, guião, legendas em cinco línguas e o vídeo com fotografias.${p0 ? ` Cada entrevista tem até ${p0.max_questions} perguntas (incluindo as adicionais) e até ${Math.round(p0.max_answer_total_sec / 60)} minutos de respostas no total, com 3 regenerações do guião ou do episódio incluídas.` : ''} As entrevistas não usadas não passam para o mês seguinte.</p>
<p><strong>A animação por IA não está incluída em nenhum plano.</strong> Cada produção animada tem um orçamento próprio, aceite antes de gerar, e é paga com créditos pré-pagos.</p>
<h2>2-A. Créditos pré-pagos</h2><ul>
<li>1 crédito = 1 € sem IVA, sempre. Os créditos compram-se por carregamento (de 25 a 1000 créditos, só por cartão) e pagam apenas serviços de ${esc(config.brand)} prestados pela empresa vendedora: animação por IA (orçamentada e aceite antes de gerar), entrevistas para além da quota do plano (6 créditos cada) e regenerações do guião ou do episódio para além das 3 incluídas em cada entrevista (1 crédito cada).</li>
${pt ? `<li>Preço com IVA: ${[2500, 10000].map(c => `${c / 100} créditos custam ${regions.map(([cp, l]) => `${eurPt(withVat(c, regionalRate('PT', cp)))} (${l}, ${regionalRate('PT', cp)}%)`).join(', ')}`).join('; ')}.</li>` : ''}
<li>São um vale de finalidade única: o IVA é cobrado no carregamento, à taxa que se aplica ao cliente nesse momento, e a fatura-recibo é emitida pelo carregamento; o uso dos créditos não tem IVA nem fatura (mostra-se um extrato de créditos, que não é fatura nem recibo).</li>
<li>Cada carregamento é válido durante 24 meses a contar do pagamento; avisamos por email 30 dias antes. Os créditos gastam-se pela ordem de validade (os mais antigos primeiro). Os créditos são nominativos e intransmissíveis, e pertencem à conta e à entidade em que foram pagos.</li>
<li>Reembolso: o saldo ainda disponível de cada carregamento é reembolsado por inteiro, a pedido, nos 14 dias seguintes a esse carregamento, pelo mesmo meio de pagamento e sem descontar comissões; os créditos cativos de um orçamento aceite não se reembolsam enquanto o orçamento estiver em curso. Se o serviço encerrar, devolvemos todo o saldo disponível. Pedidos por email para ${mail(contactEmail(s))}.</li>
<li>Se um pagamento for anulado junto do banco (disputa) ou reembolsado fora do portal, os créditos correspondentes são retirados da carteira; se já tiverem sido usados, ficam em dívida e o carregamento seguinte paga-os primeiro.</li>
<li>Se é consumidor e usa créditos num serviço que começa logo (entrevista extra, regeneração, animação), pede expressamente esse início e reconhece que perde o direito de livre resolução quando o serviço estiver integralmente prestado e o resultado lhe for disponibilizado.</li></ul>
<h2>2-B. Animação por orçamento</h2><ul>
<li>A animação por IA (vídeo e voz gerados por um modelo a partir da fotografia autorizada e do texto aprovado) tem sempre um orçamento próprio, calculado por fala, em segundos de fala medidos no áudio do episódio (cada fala conta pelo menos 4 segundos) e arredondado ao cêntimo de crédito.${rates.length ? ` Tarifas em vigor: ${rates.map(r => `${esc(r.label)} (${esc(r.resolution)}), ${String(r.cents_per_min / 100).replace('.', ',')} créditos por minuto de fala${pt ? ` (${eurPt(withVat(r.cents_per_min, regionalRate('PT', '1000-001')))} com IVA de 23%)` : ''}`).join('; ')}.` : ''} Uma mudança de tarifa só vale para orçamentos novos.</li>
<li>O orçamento é grátis e não cativa nada; só o titular da conta o aceita, com as duas caixas assinaladas e o botão com o valor. Na aceitação o valor fica cativo na carteira e recebe por email o orçamento, os consentimentos e estas condições antes de a produção começar. O orçamento vale 7 dias (menos, se o modelo for desativado antes) e fica sem efeito se mudarem o guião, as fotografias, as vozes, o motor ou as autorizações.</li>
<li>O orçamento aceite é o máximo que paga. No fim cobram-se só as falas animadas e verificadas palavra a palavra; as que ficarem em fotografia (texto que não coincidiu, filtro da Google, Google indisponível, teto ou disjuntor, autorização retirada) voltam ao saldo, com o motivo no relatório. Uma produção falhada, anulada, que não arranque em 24 horas ou cujo vídeo não fique ligado ao episódio custa 0 créditos. As falas já pagas reaproveitam-se a 0 créditos.</li>
<li>Se uma autorização for retirada depois da entrega, o que foi entregue continua cobrado; o vídeo pode ser reconstruído só com o entrevistador, a 0 créditos, e os clipes com a imagem do convidado são apagados.</li>
<li>O vídeo leva o aviso visível «AI-generated video · AI voice».</li></ul>
<h2>3. Planos e preços</h2><div style="overflow-x:auto"><table><thead><tr><th>Plano</th><th>Entrevistas por mês</th><th>Preço</th>${head}</tr></thead><tbody>${plans.map(row).join('')}</tbody></table></div>
<p>${vatExplanation(s)}</p>
<h2>4. Quem pode comprar</h2><p>Empresas e consumidores com morada de faturação num país da União Europeia (exceto os territórios fora do território de IVA da UE, como as Canárias). Para outros países, contacte-nos: ${mail(contactEmail(s))}.</p>
<h2>5. Pagamento, renovação e cancelamento</h2><p>Pagamento só por cartão, processado pela Stripe. A subscrição renova-se todos os meses até ser cancelada na conta («Manage card, Stripe receipts &amp; cancellation»); o cancelamento produz efeito no fim do período já pago. Ao mudar de plano, a diferença é cobrada ou creditada de imediato, na proporção do tempo que falta.</p>
<h2>6. Faturas</h2><p>Por cada pagamento, a empresa vendedora emite uma fatura-recibo num programa de faturação certificado, com os dados de faturação indicados, e envia-a por email. O recibo da Stripe é só um comprovativo de pagamento.</p>
<h2>7. Direito de livre resolução (consumidores)</h2><p>Se é consumidor, pode desistir do contrato nos ${WITHDRAWAL_DAYS} dias seguintes à subscrição, sem indicar o motivo, pelo botão «Desistir do contrato aqui» na sua conta ou por email para ${mail(contactEmail(s))}. Como pede que o serviço comece logo, paga a parte do serviço já prestada até à desistência (DL 24/2014, art. 15.º); o resto é devolvido no prazo de 14 dias, pelo mesmo meio de pagamento. Perde o direito de livre resolução quando o serviço estiver integralmente prestado e, quanto a cada episódio ou vídeo já disponibilizado com o seu consentimento prévio e expresso, a partir desse momento (art. 17.º, n.º 1, als. a) e l)).</p>
<h2>8. Reclamações e litígios</h2><p>Pode reclamar no ${complaintsLink(s)} ou por email para ${mail(contactEmail(s))}. ${s.adr ? `Em caso de litígio de consumo, pode recorrer a ${esc(s.adr)}.` : 'Em caso de litígio de consumo, pode recorrer a uma entidade de resolução alternativa de litígios de consumo (lista no Portal do Consumidor, <a href="https://www.consumidor.gov.pt" rel="noopener">www.consumidor.gov.pt</a>).'} Mantém sempre o direito de recorrer aos tribunais.</p>
<p class="hint">Ver também a <a href="/privacidade-pagamentos">privacidade nos pagamentos</a> e a <a href="/privacy">privacidade das entrevistas</a>.</p></div>`;
}

/** Privacidade dos dados de pagamento e faturação (em português). */
export function paymentsPrivacyBody(s: Seller) {
  return `<div class="narrow" style="padding-top:40px"><h1>Privacidade nos pagamentos</h1>
<h2>Responsável pelo tratamento</h2>${sellerBlock(s)}${managerBlock()}
<h2>Que dados tratamos</h2><ul><li>Nome ou firma, NIF ou número de IVA (e o resultado da verificação no VIES), morada e país de faturação, email e se compra como empresa ou como consumidor.</li>
<li>Plano, datas, montantes, IVA aplicado e referências dos pagamentos na Stripe, o país do cartão e o endereço IP no momento da compra (provas do país do cliente que as regras do IVA exigem).</li></ul>
<p>Não vemos nem guardamos os dados do cartão: são recolhidos e tratados pela Stripe.</p>
<h2>Para quê</h2><ul><li>Cobrar a subscrição e gerir a conta (execução do contrato).</li><li>Emitir e conservar as faturas e as provas do IVA pelo prazo que a lei fiscal exige, que para os documentos de faturação é de 10 anos (obrigação legal).</li></ul>
<h2>Com quem partilhamos</h2><p>Com a Stripe (pagamentos), com o programa de faturação certificado em que a empresa vendedora emite as faturas e, quando a lei o exige, com a Autoridade Tributária. Não vendemos dados.</p>
<h2>Os seus direitos</h2><p>Pode pedir acesso, retificação, apagamento (quando não houver obrigação legal de conservar), limitação ou portabilidade por email para ${mail(contactEmail(s))}, e reclamar à Comissão Nacional de Proteção de Dados (CNPD).</p>
<p class="hint"><a href="/termos">Termos e condições de venda</a></p></div>`;
}
