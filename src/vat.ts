/**
 * IVA das vendas (funções puras: sem rede nem base de dados).
 * Vendedor: país e regime de IVA configuráveis (aqui a Telecert, em Portugal, registada para IVA).
 * Cliente: país, empresa ou consumidor, número de IVA verificado (Stripe/VIES) e código postal (regiões de Portugal).
 * Fora da UE, ou num território fora do território de IVA da UE, recusa-se com «contacte-nos».
 */

/**
 * Taxas normais de IVA dos 27 Estados-Membros (portal Your Europe da Comissão Europeia,
 * https://europa.eu/youreurope/business/taxation/vat/vat-rules-rates/index_en.htm, «Last checked: 13/07/2026»,
 * conferido a 21/10/2026). As taxas regionais de Portugal (Madeira e Açores) estão em ptRegion.
 */
export const EU_STANDARD_RATES: Record<string, number> = {
  AT: 20, BE: 21, BG: 20, CY: 19, CZ: 21, DE: 19, DK: 25, EE: 24, GR: 24, ES: 21, FI: 25.5, FR: 20, HR: 25, HU: 27,
  IE: 23, IT: 22, LT: 21, LU: 17, LV: 21, MT: 18, NL: 21, PL: 23, PT: 23, RO: 21, SE: 25, SI: 22, SK: 23,
};
export const VAT_RATES_CHECKED = '2026-07-13';

export const COUNTRY_NAMES: Record<string, { pt: string; en: string }> = {
  AT: { pt: 'Áustria', en: 'Austria' }, BE: { pt: 'Bélgica', en: 'Belgium' }, BG: { pt: 'Bulgária', en: 'Bulgaria' },
  CY: { pt: 'Chipre', en: 'Cyprus' }, CZ: { pt: 'Chéquia', en: 'Czechia' }, DE: { pt: 'Alemanha', en: 'Germany' },
  DK: { pt: 'Dinamarca', en: 'Denmark' }, EE: { pt: 'Estónia', en: 'Estonia' }, GR: { pt: 'Grécia', en: 'Greece' },
  ES: { pt: 'Espanha', en: 'Spain' }, FI: { pt: 'Finlândia', en: 'Finland' }, FR: { pt: 'França', en: 'France' },
  HR: { pt: 'Croácia', en: 'Croatia' }, HU: { pt: 'Hungria', en: 'Hungary' }, IE: { pt: 'Irlanda', en: 'Ireland' },
  IT: { pt: 'Itália', en: 'Italy' }, LT: { pt: 'Lituânia', en: 'Lithuania' }, LU: { pt: 'Luxemburgo', en: 'Luxembourg' },
  LV: { pt: 'Letónia', en: 'Latvia' }, MT: { pt: 'Malta', en: 'Malta' }, NL: { pt: 'Países Baixos', en: 'Netherlands' },
  PL: { pt: 'Polónia', en: 'Poland' }, PT: { pt: 'Portugal', en: 'Portugal' }, RO: { pt: 'Roménia', en: 'Romania' },
  SE: { pt: 'Suécia', en: 'Sweden' }, SI: { pt: 'Eslovénia', en: 'Slovenia' }, SK: { pt: 'Eslováquia', en: 'Slovakia' },
};
/** Países da UE por ordem do nome em português (para as listas de escolha). */
export const EU_COUNTRIES = Object.keys(EU_STANDARD_RATES).sort((a, b) => COUNTRY_NAMES[a].pt.localeCompare(COUNTRY_NAMES[b].pt, 'pt'));
export const isEuCountry = (c: unknown): c is string => typeof c === 'string' && c in EU_STANDARD_RATES;
export const countryName = (c: string, lang: 'pt' | 'en' = 'pt') => COUNTRY_NAMES[c]?.[lang] ?? c;
/** Prefixo do número de IVA (a Grécia usa EL, não GR). */
export const vatPrefix = (country: string) => (country === 'GR' ? 'EL' : country);

/** Código postal: Portugal no formato NNNN-NNN; noutros países, letras e algarismos sem espaços a mais. null se não servir. */
export function normPostal(country: string, raw: unknown): string | null {
  const v = String(raw ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (country === 'PT') {
    const m = /^(\d{4})\s*-?\s*(\d{3})$/.exec(v);
    return m && Number(m[1]) >= 1000 ? `${m[1]}-${m[2]}` : null;
  }
  return /^[0-9A-Z][0-9A-Z -]{1,10}$/.test(v) ? v : null;
}

/**
 * Regiões autónomas pelo código postal (CTT): 9000–9499 Madeira (Funchal 9000, Machico 9200, Câmara de Lobos 9300,
 * Porto Santo 9400) com 22%; 9500–9999 Açores (Ponta Delgada 9500, Vila do Porto 9580, Angra do Heroísmo 9700,
 * Horta 9900, Corvo 9980) com 16%; o resto é o continente, com 23%.
 */
export function ptRegion(postal: unknown): { rate: number; pt: string; en: string } {
  const cp = normPostal('PT', postal);
  const n = cp ? Number(cp.slice(0, 4)) : 0;
  if (n >= 9500) return { rate: 16, pt: 'Açores', en: 'Azores' };
  if (n >= 9000) return { rate: 22, pt: 'Madeira', en: 'Madeira' };
  return { rate: 23, pt: 'Portugal continental', en: 'mainland Portugal' };
}

/** Taxa normal do lugar do cliente: em Portugal a da região do código postal; nos outros países a taxa normal. */
export const regionalRate = (country: string, postal?: unknown) => (country === 'PT' ? ptRegion(postal).rate : EU_STANDARD_RATES[country]);
const placeName = (country: string, postal: unknown, lang: 'pt' | 'en') => (country === 'PT' ? ptRegion(postal)[lang] : countryName(country, lang));

/**
 * Territórios de Estados-Membros fora do território de IVA da UE (art. 6.º da Diretiva 2006/112/CE), pelo código postal:
 * Canárias, Ceuta e Melilha; departamentos e coletividades franceses do ultramar; Ilhas Åland; Heligoland e Büsingen;
 * Livigno e Campione d'Italia; Monte Atos. Devolve o nome do território, ou null.
 */
export function outsideVatTerritory(country: string, postal: unknown): string | null {
  const p = String(postal ?? '').replace(/\s+/g, '').toUpperCase();
  if (country === 'ES') {
    if (/^(35|38)\d{3}$/.test(p)) return 'Canárias';
    if (/^51\d{3}$/.test(p)) return 'Ceuta';
    if (/^52\d{3}$/.test(p)) return 'Melilha';
  }
  if (country === 'FR' && /^(97\d{3}|98[4-9]\d{2})$/.test(p)) return 'território francês do ultramar';
  if (country === 'FI' && /^(AX-?)?22\d{3}$/.test(p)) return 'Ilhas Åland';
  if (country === 'DE' && /^(27498|78266)$/.test(p)) return p === '27498' ? 'Heligoland' : 'Büsingen am Hochrhein';
  if (country === 'IT' && /^(23041|22061)$/.test(p)) return p === '23041' ? 'Livigno' : "Campione d'Italia";
  if (country === 'GR' && /^6308[67]$/.test(p)) return 'Monte Atos';
  return null;
}

/** NIF português: 9 algarismos com dígito de controlo (módulo 11). Aceita o prefixo «PT» e espaços; devolve só os algarismos. */
export function normNif(raw: unknown): string | null {
  const v = String(raw ?? '').replace(/[\s.-]/g, '').replace(/^PT/i, '');
  if (!/^\d{9}$/.test(v) || v[0] === '0' || (v[0] === '4' && v[1] !== '5')) return null;
  const sum = [...v.slice(0, 8)].reduce((s, d, i) => s + Number(d) * (9 - i), 0);
  const check = sum % 11 < 2 ? 0 : 11 - (sum % 11);
  return check === Number(v[8]) ? v : null;
}

/** Número de IVA da UE normalizado (prefixo do país + 2 a 12 letras/algarismos); aceita sem o prefixo. null se não servir. */
export function normVatNumber(country: string, raw: unknown): string | null {
  if (!isEuCountry(country)) return null;
  const pre = vatPrefix(country);
  let v = String(raw ?? '').toUpperCase().replace(/[\s.\-/]/g, '');
  if (!v) return null;
  // Duas letras no início são o prefixo do país (tem de ser o do cliente); sem elas, acrescenta-se.
  if (/^[A-Z]{2}/.test(v)) { if (v.slice(0, 2) !== pre) return null; } else v = pre + v;
  if (country === 'PT') return normNif(v) ? v : null;
  return /^[A-Z]{2}[0-9A-Z]{2,12}$/.test(v) && /\d/.test(v.slice(2)) ? v : null;
}

export type SellerRegime = 'registered' | 'not_registered';
export interface VatSeller { country: string; regime: SellerRegime | '' | string; vatNumber?: string | null; ossActive?: boolean }
export interface VatCustomer { country: string; kind: 'business' | 'consumer'; vatNumber?: string | null; vatVerified?: boolean; postalCode?: string | null }
/**
 * domestic: cliente no país do vendedor (em Portugal, a taxa da região da morada: 23%, 22% Madeira, 16% Açores).
 * reverse_charge: empresa de outro país da UE com número de IVA verificado (0%, autoliquidação).
 * eu_b2c_origin: consumidor (ou empresa sem número de IVA verificado) de outro país da UE com o OSS desligado:
 *   taxa normal do país do vendedor, abaixo do limiar de 10 000 €/ano.
 * oss: o mesmo com o OSS ligado: taxa normal do país do consumidor.
 * not_registered: vendedor não registado para IVA (0%).
 */
export type VatRegime = 'domestic' | 'reverse_charge' | 'eu_b2c_origin' | 'oss' | 'not_registered';
export interface VatOk { ok: true; regime: VatRegime; rate: number; country: string; asConsumer: boolean; note: { pt: string; en: string } }
export interface VatRefused { ok: false; reason: 'seller_regime' | 'outside_eu'; message: { pt: string; en: string } }
export type VatDecision = VatOk | VatRefused;

export const SELLER_NOT_READY = { pt: 'Os pagamentos em linha estão suspensos enquanto o administrador não completar os dados fiscais da empresa vendedora.', en: 'Online payments are paused until the administrator completes the seller’s tax details.' };
export const OUTSIDE_EU = { pt: 'De momento só vendemos a clientes com morada de faturação na União Europeia. Contacte-nos.', en: 'For now we only sell to customers with a billing address in the European Union. Please contact us.' };

/** Problemas do regime de IVA do vendedor (vazio = pronto a vender). */
export function sellerVatProblems(s: VatSeller): string[] {
  const out: string[] = [];
  if (!isEuCountry(s.country)) out.push('país da empresa vendedora em falta ou inválido');
  if (s.regime !== 'registered' && s.regime !== 'not_registered') out.push('regime de IVA da empresa vendedora por escolher');
  else if (s.regime === 'registered' && isEuCountry(s.country) && !normVatNumber(s.country, s.vatNumber)) out.push('NIF da empresa vendedora em falta ou inválido');
  return out;
}

/** Decide o IVA de uma venda. */
export function vatFor(seller: VatSeller, customer: VatCustomer): VatDecision {
  if (sellerVatProblems(seller).length) return { ok: false, reason: 'seller_regime', message: SELLER_NOT_READY };
  const c = customer.country;
  const territory = isEuCountry(c) ? outsideVatTerritory(c, customer.postalCode) : null;
  if (!isEuCountry(c) || territory) return { ok: false, reason: 'outside_eu', message: territory ? { pt: `${OUTSIDE_EU.pt} (${territory} fica fora do território de IVA da UE.)`, en: `${OUTSIDE_EU.en} (${territory} is outside the EU VAT area.)` } : OUTSIDE_EU };
  if (seller.regime === 'not_registered')
    return { ok: true, regime: 'not_registered', rate: 0, country: '', asConsumer: customer.kind === 'consumer', note: { pt: 'IVA não liquidado: o fornecedor não está registado para efeitos de IVA.', en: 'VAT not charged: the supplier is not registered for VAT.' } };
  const pt = seller.country === 'PT';
  if (c === seller.country) {
    // Empresas: a sede (a morada de faturação); consumidores: a morada.
    const rate = regionalRate(c, customer.postalCode);
    return { ok: true, regime: 'domestic', rate, country: c, asConsumer: customer.kind === 'consumer', note: { pt: `IVA ${fmtRate(rate)}% (${placeName(c, customer.postalCode, 'pt')}).`, en: `VAT ${fmtRate(rate)}% (${placeName(c, customer.postalCode, 'en')}).` } };
  }
  if (customer.kind === 'business' && customer.vatVerified && normVatNumber(c, customer.vatNumber))
    return { ok: true, regime: 'reverse_charge', rate: 0, country: c, asConsumer: false, note: pt
      ? { pt: 'IVA – autoliquidação (art. 6.º, n.º 6, al. a) do CIVA e art. 196.º da Diretiva 2006/112/CE).', en: 'VAT – reverse charge (Article 6(6)(a) of the Portuguese VAT Code and Article 196 of Directive 2006/112/EC).' }
      : { pt: 'IVA – autoliquidação (art. 196.º da Diretiva 2006/112/CE).', en: 'VAT – reverse charge (Article 196 of Directive 2006/112/EC).' } };
  // Consumidor, ou empresa sem número de IVA verificado (tratada como consumidor).
  if (!seller.ossActive) {
    const rate = EU_STANDARD_RATES[seller.country], where = { pt: countryName(seller.country, 'pt'), en: countryName(seller.country, 'en') };
    return { ok: true, regime: 'eu_b2c_origin', rate, country: seller.country, asConsumer: true, note: pt
      ? { pt: `IVA ${fmtRate(rate)}% de ${where.pt}: serviços a consumidores de outros países da UE abaixo do limiar de 10 000 €/ano (art. 6.º-A do CIVA).`, en: `VAT ${fmtRate(rate)}% of ${where.en}: services to consumers in other EU countries below the €10,000/year threshold (Article 6-A of the Portuguese VAT Code).` }
      : { pt: `IVA ${fmtRate(rate)}% de ${where.pt}: serviços a consumidores de outros países da UE abaixo do limiar de 10 000 €/ano (art. 59.º-C da Diretiva 2006/112/CE).`, en: `VAT ${fmtRate(rate)}% of ${where.en}: services to consumers in other EU countries below the €10,000/year threshold (Article 59c of Directive 2006/112/EC).` } };
  }
  const rate = EU_STANDARD_RATES[c];
  return { ok: true, regime: 'oss', rate, country: c, asConsumer: true, note: { pt: `IVA ${fmtRate(rate)}% do país do consumidor (${countryName(c, 'pt')}), declarado pelo balcão único (OSS).`, en: `VAT ${fmtRate(rate)}% of the consumer’s country (${countryName(c, 'en')}), declared through the One-Stop Shop (OSS).` } };
}

export const fmtRate = (r: number) => String(r).replace('.', ',');
/** IVA de um valor sem IVA (arredondado ao cêntimo, como a Stripe faz com uma taxa exclusiva). */
export const vatOf = (netCents: number, rate: number) => Math.round((netCents * rate) / 100);
export const withVat = (netCents: number, rate: number) => netCents + vatOf(netCents, rate);
/** Valores em euros: «€19» / «€23.37» (inglês) e «19,00 €» (português). */
export const eurEn = (c: number) => `${c < 0 ? '−' : ''}€${(Math.abs(c) / 100).toFixed(Math.abs(c) % 100 ? 2 : 0)}`;
export const eurPt = (c: number) => `${c < 0 ? '−' : ''}${(Math.abs(c) / 100).toFixed(2).replace('.', ',')} €`;
export const REGIME_LABEL: Record<VatRegime, string> = {
  domestic: 'nacional', reverse_charge: 'autoliquidação (0%)', eu_b2c_origin: 'consumidor UE, IVA português (OSS desligado)',
  oss: 'consumidor UE, OSS', not_registered: 'vendedor não registado (0%)',
};
