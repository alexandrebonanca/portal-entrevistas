import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AI_MOCK = '1';
process.env.PGLITE_MEMORY = '1';
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'pe-test-'));
process.env.BASE_URL = 'http://test.local';
// Email de apoio com a forma de um email pessoal: o dono não o quer na página de privacidade.
process.env.SUPPORT_EMAIL = 'pessoal.dono@exemplo.pt';

const { openDb, migrate } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { config } = await import('../src/config.ts');
const { PRIVACY_UPDATED } = await import('../src/privacy.ts');

let db: any, app: any, body = '';
before(async () => {
  db = await openDb(); await migrate(db); app = await buildApp(db);
  const r = await app.inject({ method: 'GET', url: '/privacy' });
  assert.equal(r.statusCode, 200);
  body = r.body;
});
after(async () => { await app.close(); await db.close(); });

/** Texto de uma secção (do <h2> até ao <h2> seguinte ou ao fim). */
const section = (title: string) => {
  const i = body.indexOf(`<h2>${title}</h2>`);
  assert.ok(i >= 0, `secção «${title}»`);
  const j = body.indexOf('<h2>', i + 4);
  return body.slice(i, j < 0 ? undefined : j);
};

test('privacidade: completa, sem o aviso «por completar» e sem o email pessoal', () => {
  assert.doesNotMatch(body, /must be completed/); assert.doesNotMatch(body, /before production use/);
  assert.equal(config.supportEmail, 'pessoal.dono@exemplo.pt');
  assert.ok(!body.includes(config.supportEmail), 'o SUPPORT_EMAIL nunca aparece');
  assert.ok(body.includes(`Last updated: ${PRIVACY_UPDATED}`)); assert.equal(PRIVACY_UPDATED, '22 October 2026');
  // Quem somos: a entidade proprietária e gestora, com país, morada, IVA e contacto.
  const who = section('Who we are');
  for (const v of [config.owner.name, 'Estonia', config.owner.address, `VAT ${config.owner.vat}`, `mailto:${config.owner.email}`]) assert.ok(who.includes(v), v);
  assert.match(who, /we process the interview on their behalf/i);
  assert.ok(who.includes(config.seller.name), 'a vendedora das Definições (por omissão a Telecert)');
  assert.match(who, /href="\/privacidade-pagamentos"/); assert.match(who, /href="\/termos"/);
  // Os direitos: contacto da Certif e a autoridade de controlo; nunca um encarregado de proteção de dados inventado.
  const rights = section('Your rights');
  assert.ok(rights.includes(`<a href="mailto:${config.owner.email}">${config.owner.email}</a>`));
  for (const r of ['access', 'correction', 'deletion', 'restriction', 'portable', 'object', 'withdraw it at any time', 'Andmekaitse Inspektsioon', 'may not be recoverable']) assert.ok(rights.includes(r), r);
  assert.doesNotMatch(body, /data protection officer/i);
});

test('privacidade: lista os terceiros integrados, as transferências e as bases legais', () => {
  const rec = section('Who receives data');
  for (const p of ['Render', 'OpenAI', 'Google', 'Replicate', 'MailerSend', 'Stripe', 'Moloni']) assert.ok(rec.includes(`<strong>${p}</strong>`), `${p} na lista`);
  assert.match(rec, /Veo, through Vertex AI or the Gemini API/); assert.match(rec, /us-central1/); assert.match(rec, /We do not sell personal data/);
  // Os fornecedores do laboratório só recebem retratos fictícios: não aparecem como destinatários.
  assert.doesNotMatch(body, /fal\.ai|WaveSpeed/);
  const tr = section('International transfers');
  assert.match(tr, /United States/); assert.match(tr, /standard contractual clauses/); assert.match(tr, /Chapter V of the GDPR/);
  assert.doesNotMatch(tr, /Data Privacy Framework|certified/i, 'nenhuma certificação que o código não prove');
  const what = section('What we collect and why');
  for (const b of ['performance of the contract', 'your consent', 'legitimate interest', 'legal obligations']) assert.ok(what.includes(b), b);
  assert.match(what, /nothing pre-ticked/);
});

test('privacidade: aprovação «por omissão», IA, prazos e cookies conforme o código', () => {
  const pub = section('Publication');
  assert.match(pub, /Nothing is published without the interviewer’s decision and, by default, your approval of the final version, and always with your approval when you appear animated by AI/);
  assert.doesNotMatch(body, /Nothing is published without your approval/);
  const ai = section('AI processing');
  assert.match(ai, /no voice is cloned/); assert.match(ai, /audible notice/); assert.match(ai, /AI-animated portrait/); assert.match(ai, /AI-generated video · AI voice/);
  assert.match(ai, /not used to take decisions about anyone that have legal or similarly significant effects/);
  const keep = section('How long we keep data');
  for (const v of ['14 days', '180 days', '62 days', '90 days', '10 years', 'no automatic deletion period', 'kept privately until deletion is requested']) assert.ok(keep.includes(v), v);
  // Os pedidos ao suporte não são apagados com a entrevista ou a conta (não há forma de as apagar no portal).
  assert.doesNotMatch(body, /deleted together with the interview or the account/);
  const ck = section('Cookies and browser storage');
  assert.match(ck, /<code>sid<\/code>/); assert.match(ck, /<code>gs<\/code>/); assert.match(ck, /no advertising, analytics or third-party cookies/);
});

test('privacidade: parágrafos já testados mantêm-se iguais', () => {
  assert.ok(body.includes('<h2>Campaign links</h2><p>Visits to the home page and the sign-up page, and to the gallery and episode pages when the link carries campaign tags, are counted as daily totals by page and by the campaign tags in the link (or the website you came from). These counters use no cookies and hold no IP address or anything else that identifies you; like any request, the visit also appears in the server’s technical logs, which record the IP address and the page address. When you create an account, the campaign tags you arrived with, or otherwise the website you came from, are kept with your account to measure campaign results.</p>'));
  assert.ok(body.includes('<h2>Composition assistant</h2><p>When an interviewer with access to it asks the composition assistant on the interview edit page for suggestions, the saved title, goal, roles and question texts of that draft, and the optional request typed in the panel, are sent to OpenAI to draft suggestions (emails, website addresses and phone numbers in the usual formats are masked first); the name and email fields and the personal message are not sent. The portal keeps only a daily count of requests per account, not the texts or the suggestions.</p>'));
  assert.match(section('Help assistant and support'), /never sent to AI services[^<]*stored for|stored for 180 days[^<]*never sent to AI services/);
});
