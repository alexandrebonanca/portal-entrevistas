import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Validação do convidado e publicação (reparos das revisões); IA em modo simulado, sem rede.
process.env.AI_MOCK = '1';
process.env.PGLITE_MEMORY = '1';
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'pe-test-'));
process.env.BASE_URL = 'http://test.local';

const { openDb, migrate } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { runOne } = await import('../src/jobs.ts');
const { handlers } = await import('../src/pipeline.ts');
const { flushOutbox } = await import('../src/mail.ts');
const { makeToneWav } = await import('../src/media.ts');
const { config } = await import('../src/config.ts');
const { sha256 } = await import('../src/lib.ts');
const { createInvitation } = await import('../src/invites.ts');

let db: any, app: any;
before(async () => { db = await openDb(); await migrate(db); app = await buildApp(db); });
after(async () => { await app.close(); await db.close(); });

const cookies = (r: any) => Object.fromEntries((r.cookies as any[]).map(c => [c.name, c.value]));
const form = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, String(v)]]))).toString();
const post = (url: string, body: any = {}, cookie = '') => app.inject({ method: 'POST', url, payload: form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie } });
const get = (url: string, cookie = '') => app.inject({ method: 'GET', url, headers: { cookie } });
const msgOf = (r: any) => decodeURIComponent(String(r.headers.location ?? ''));
const drain = async () => { while (await runOne(db, handlers)) { /* */ } await flushOutbox(db); };
const tokenOf = (text: string) => /\/i\/([A-Za-z0-9_-]{40,})/.exec(text)![1];
const inviteMails = (id: string) => db.query(`SELECT subject, text_body, html FROM emails WHERE interview_id=$1 AND dedupe_key LIKE 'invite:%' ORDER BY created_at DESC`, [id]);
const guestOf = async (token: string) => `gs=${cookies(await post(`/i/${token}/abrir`)).gs}`;
const PW = 'uma-palavra-passe-longa';
let admin = '';

/** Entrevista convidada, respondida, submetida e com o episódio gerado (em pré-visualização). */
const ready = async (title: string, policy: 'guest_preview' | 'host_only', lang: 'pt-PT' | 'en', beforeSubmit?: (guest: string, id: string) => Promise<void>) => {
  const c = await post('/entrevistas', { title }, admin);
  const id = /entrevistas\/([0-9a-f-]{36})/.exec(c.headers.location as string)![1];
  await post(`/entrevistas/${id}/perguntas`, { text: 'Qual foi o maior desafio?' }, admin);
  await post(`/entrevistas/${id}/guardar`, { title, objective_text: 'Objetivo', host_name: 'Ana', guest_name: 'Rui', guest_email: 'rui@example.com', interaction_lang: lang, review_policy: policy, subtitle_langs: 'en' }, admin);
  assert.match(msgOf(await post(`/entrevistas/${id}/convidar`, {}, admin)), /ok=/);
  await flushOutbox(db);
  const guest = await guestOf(tokenOf((await inviteMails(id))[0].text_body));
  await post('/entrevista/consentimentos', { participation: '1', adult: '1', processing: '1', publish: '1' }, guest);
  const q = await db.one('SELECT id FROM questions WHERE interview_id=$1', [id]);
  const up = await app.inject({ method: 'POST', url: `/api/g/respostas/${q.id}`, payload: makeToneWav(2), headers: { 'content-type': 'audio/wav', cookie: guest } });
  assert.equal(up.statusCode, 200, up.body);
  if (beforeSubmit) await beforeSubmit(guest, id);
  await post('/entrevista/submeter', {}, guest);
  await post(`/entrevistas/${id}/processar`, {}, admin); await drain();
  await post(`/entrevistas/${id}/guiao/aprovar`, { reviewed: '1' }, admin);
  await post(`/entrevistas/${id}/gerar`, { subtitle_langs: 'en' }, admin); await drain();
  const ep = await db.one(`SELECT * FROM episodes WHERE interview_id=$1 AND status='preview' AND NOT stale`, [id]);
  assert.ok(ep, 'episódio gerado');
  return { id, ep };
};

test('alcance none: email, página do link e pré-visualização dizem «ver o episódio», nunca «Confirme e valide»; novo link com resposta clara', async () => {
  admin = `sid=${cookies(await post('/registar', { name: 'Ana', email: 'ana@example.com', password: PW, terms: '1' })).sid}`;
  config.limits.resendCooldownSec = 0; // vários pedidos de novo link seguidos
  const { id, ep } = await ready('Só o entrevistador', 'host_only', 'pt-PT');
  // a publicação não depende do convidado (não aparece animado): o entrevistador não lhe pede a validação...
  assert.match(msgOf(await post(`/entrevistas/${id}/episodio/${ep.id}/enviar-previa`, {}, admin)), /só valida um vídeo em que apareça animado/);
  // ...mas um link de validação anterior (de um vídeo em que aparecia animado, entretanto tirado) leva ao episódio para ver
  await createInvitation(db, await db.one('SELECT * FROM interviews WHERE id=$1', [id]), { name: 'Ana' }, { preview: true });
  await flushOutbox(db);
  let m = (await inviteMails(id))[0];
  assert.equal(m.subject, 'O episódio da sua entrevista — Só o entrevistador');
  assert.match(m.text_body, /^O episódio da sua entrevista\n/);
  assert.match(m.text_body, /Pode ver e ouvir o episódio\. A publicação é decidida pelo entrevistador\./);
  assert.match(m.text_body, /Ver o episódio: http:\/\/test\.local\/i\//);
  assert.doesNotMatch(m.subject + m.text_body + m.html, /Confirme e valide|validar/);
  const tk = tokenOf(m.text_body);
  const landing = await get(`/i/${tk}`);
  assert.match(landing.body, /<h1>O episódio da sua entrevista<\/h1>/); assert.match(landing.body, />Ver o episódio<\/button>/);
  assert.doesNotMatch(landing.body, /Confirme e valide|Ver e validar/);
  const view = await get('/entrevista/episodio', await guestOf(tk));
  assert.match(view.body, /<strong>O episódio da sua entrevista<\/strong>/);
  assert.doesNotMatch(view.body, /Confirme e valide|action="\/entrevista\/episodio\/decisao"/);

  // link expirado: o convidado pede outro e recebe o link para ver (antes não recebia nada, com a resposta «enviámos»)
  await db.query(`UPDATE invitations SET expires_at=now() - interval '1 hour' WHERE token_hash=$1`, [sha256(tk)]);
  const n0 = (await inviteMails(id)).length;
  const wrong = await post(`/i/${tk}/novo-link`, { email: 'outra@example.com' });
  assert.equal(wrong.headers.location, `/i/${tk}?sent=1`, 'email que não confere: resposta genérica');
  const r = await post(`/i/${tk}/novo-link`, { email: 'RUI@example.com' });
  assert.equal(r.headers.location, `/i/${tk}?sent=1`);
  await flushOutbox(db);
  const mails = await inviteMails(id);
  assert.equal(mails.length, n0 + 1, 'um só link novo');
  m = mails[0];
  assert.equal(m.subject, 'O episódio da sua entrevista — Só o entrevistador');
  // sem episódio para ver (versão desatualizada): não se envia um link vazio e quem pediu fica a saber porquê
  await db.query(`UPDATE episodes SET stale=true WHERE id=$1`, [ep.id]);
  const tk2 = tokenOf(m.text_body);
  await db.query(`UPDATE invitations SET expires_at=now() - interval '1 hour' WHERE token_hash=$1`, [sha256(tk2)]);
  const r2 = await post(`/i/${tk2}/novo-link`, { email: 'rui@example.com' });
  assert.equal(r2.headers.location, `/i/${tk2}?sent=nada`);
  await flushOutbox(db);
  assert.equal((await inviteMails(id)).length, n0 + 1, 'nada enviado');
  const pg = await get(`/i/${tk2}?sent=nada`);
  assert.match(pg.body, /Neste momento não há nenhum episódio para ver: quem o convidou envia-lhe um novo link quando houver uma versão nova\./);
  assert.doesNotMatch(pg.body, /Se o email corresponder a um convite, enviámos um novo link/);
  await db.query(`UPDATE episodes SET stale=false WHERE id=$1`, [ep.id]);
});

let pubId = '', pubEp: any = null, pubGuest = '';
test('«Rever e submeter» mostra o texto das autorizações tal como foi aceite (v1), não o atual', async () => {
  const r = await ready('O convidado aprova', 'guest_preview', 'en', async (guest, id) => {
    // autorização dada antes da versão atual do texto (v1): o retrato guardado é o que o convidado aceitou
    await db.query(`INSERT INTO consents(interview_id, purpose, granted, text_version, text_snapshot, created_at) VALUES ($1,'publish',true,'v1-2026-09',$2, now() + interval '1 second')`,
      [id, 'Publication of the resulting episode (v1 wording).\nOld background information']);
    const page = await get('/entrevista/rever', guest);
    assert.match(page.body, /✔ Publication of the resulting episode \(v1 wording\)\./);
    assert.doesNotMatch(page.body, /after I have seen and approved it/, 'o texto atual (v2) não substitui o aceite');
    assert.doesNotMatch(page.body, /Old background information/);
    // participação: só a frase da caixa (o retrato guarda também a informação de base)
    assert.match(page.body, /✔ Taking part and recording my answers \(needed to answer\)\./);
    assert.doesNotMatch(page.body, /Organiser: the interviewer/);
  });
  pubId = r.id; pubEp = r.ep;
  const snap = (await db.one('SELECT snapshot FROM submissions WHERE interview_id=$1', [pubId])).snapshot;
  assert.ok(snap.consents.every((x: any) => Object.keys(x).sort().join() === 'granted,purpose'), 'o comprovativo da submissão mantém o formato');
});

test('episódio já publicado: o convidado vê e ouve, sem formulário de aprovação; a decisão não se regista', async () => {
  await post(`/entrevistas/${pubId}/episodio/${pubEp.id}/aprovar`, { video: '' }, admin);
  await post(`/entrevistas/${pubId}/episodio/${pubEp.id}/enviar-previa`, {}, admin);
  await flushOutbox(db);
  const m = (await inviteMails(pubId))[0];
  assert.equal(m.subject, 'Please review and validate your interview — O convidado aprova', 'com a aprovação do convidado, o texto continua a pedir a validação');
  pubGuest = await guestOf(tokenOf(m.text_body));
  let view = await get('/entrevista/episodio', pubGuest);
  assert.match(view.body, /Please confirm and validate your interview/); assert.match(view.body, /action="\/entrevista\/episodio\/decisao"/);
  await post('/entrevista/episodio/decisao', { decision: 'approved', video: '', episode: pubEp.id, audio: pubEp.audio_asset_id }, pubGuest);
  assert.match(msgOf(await post(`/entrevistas/${pubId}/episodio/${pubEp.id}/publicar`, { visibility: 'unlisted' }, admin)), /Publicado/);

  view = await get('/entrevista/episodio', pubGuest);
  assert.match(view.body, /<strong>Your interview episode<\/strong>/);
  assert.match(view.body, /The episode has already been published: you can watch and listen to it\./);
  // correções e retirada pelo formulário de contacto, com o episódio indicado (nunca o SUPPORT_EMAIL)
  assert.match(view.body, /Published on \d{1,2} \w+ \d{4}\. <a href="\/contact\?topic=episode&amp;episode=[a-z0-9-]+">Ask for a correction or the withdrawal of the episode<\/a>/);
  assert.ok(view.body.includes(`episode=${pubEp.slug}"`), 'com a referência do episódio');
  assert.doesNotMatch(view.body, /support@example\.com/);
  assert.doesNotMatch(view.body, /Please confirm and validate|action="\/entrevista\/episodio\/decisao"|Silence is never treated as approval/);
  const n = (await db.one(`SELECT count(*)::int n FROM approvals WHERE episode_id=$1 AND actor='guest'`, [pubEp.id])).n;
  await post('/entrevista/episodio/decisao', { decision: 'changes', note: 'Mudem isto', video: '' }, pubGuest);
  assert.equal((await db.one(`SELECT count(*)::int n FROM approvals WHERE episode_id=$1 AND actor='guest'`, [pubEp.id])).n, n, 'episódio publicado: nada a decidir');
  assert.doesNotMatch((await get('/entrevista/obrigado', pubGuest)).body, /href="\/entrevista\/episodio"/);
  // o link de validação, pedido de novo, já não pede a validação de um episódio publicado
  const tk = tokenOf(m.text_body);
  await db.query(`UPDATE invitations SET expires_at=now() - interval '1 hour' WHERE token_hash=$1`, [sha256(tk)]);
  await post(`/i/${tk}/novo-link`, { email: 'rui@example.com' });
  await flushOutbox(db);
  const again = (await inviteMails(pubId))[0];
  assert.equal(again.subject, 'Your interview episode — O convidado aprova');
  assert.match(again.text_body, /already been published/);
  assert.match((await get(`/i/${tokenOf(again.text_body)}`)).body, /<h1>Your interview episode<\/h1>/);
});

test('vídeo explicativo no convite: só com «o entrevistado aprova», sem preços nem reprodução automática, legendas PT e EN', async () => {
  const { readFileSync } = await import('node:fs');
  const invite = async (title: string, policy: string, lang: string) => {
    const c = await post('/entrevistas', { title }, admin);
    const id = /entrevistas\/([0-9a-f-]{36})/.exec(c.headers.location as string)![1];
    await post(`/entrevistas/${id}/perguntas`, { text: 'Primeira?' }, admin);
    await post(`/entrevistas/${id}/guardar`, { title, objective_text: 'Objetivo', host_name: 'Ana', guest_name: 'Rui', guest_email: 'rui@example.com', interaction_lang: lang, review_policy: policy, subtitle_langs: 'en' }, admin);
    assert.match(msgOf(await post(`/entrevistas/${id}/convidar`, {}, admin)), /ok=/);
    await flushOutbox(db);
    return { id, tk: tokenOf((await inviteMails(id))[0].text_body) };
  };
  const pt = await invite('Convite com vídeo', 'guest_preview', 'pt-PT');
  let page = (await get(`/i/${pt.tk}`)).body;
  assert.match(page, /<strong>Como funciona, em 1 minuto<\/strong>/);
  assert.match(page, /<video controls playsinline preload="none" poster="\/static\/video\/promo\.jpg"/);
  assert.doesNotMatch(page, /autoplay/i, 'sem reprodução automática');
  assert.match(page, /<track kind="captions" srclang="pt-PT" label="Português" src="\/static\/video\/promo\.pt\.vtt" default>/, 'legendas em português ligadas para um convite em português');
  assert.match(page, /<track kind="captions" srclang="en" label="English" src="\/static\/video\/promo\.en\.vtt">/);
  assert.match(page, /Vídeo e vozes gerados por IA \(Google Veo\), com legendas em português e em inglês\. Todas as pessoas mostradas são fictícias\./);
  assert.doesNotMatch(page, /€|\$|\bVAT\b|\bIVA\b|preço|price|crédito|credit/i, 'sem preços');
  const en = await invite('Invitation with video', 'guest_preview', 'en');
  page = (await get(`/i/${en.tk}`)).body;
  assert.match(page, /<track kind="captions" srclang="en" label="English" src="\/static\/video\/promo\.en\.vtt" default>/);
  assert.match(page, /<track kind="captions" srclang="pt-PT" label="Português" src="\/static\/video\/promo\.pt\.vtt">/);
  assert.match(page, /How it works, in 1 minute/);
  // «só o entrevistador aprova»: o vídeo promete a aprovação do convidado, por isso não aparece
  const host = await invite('Sem vídeo', 'host_only', 'pt-PT');
  assert.doesNotMatch((await get(`/i/${host.tk}`)).body, /<video/);
  // perguntas adicionais e validação do episódio: o convidado já conhece o portal
  await createInvitation(db, await db.one('SELECT * FROM interviews WHERE id=$1', [pt.id]), { name: 'Ana' }, { followup: true });
  await flushOutbox(db);
  assert.doesNotMatch((await get(`/i/${tokenOf((await inviteMails(pt.id))[0].text_body)}`)).body, /<video/);

  // legendas em português: as 16 do inglês, com os mesmos tempos e texto traduzido
  const cues = (f: string) => readFileSync(join(process.cwd(), 'public', 'video', f), 'utf8').replace(/\r/g, '').trim().split(/\n\n+/).slice(1).map(b => b.split('\n'));
  const [ptCues, enCues] = [cues('promo.pt.vtt'), cues('promo.en.vtt')];
  assert.equal(readFileSync(join(process.cwd(), 'public', 'video', 'promo.pt.vtt'), 'utf8').split(/\r?\n/)[0], 'WEBVTT');
  assert.equal(ptCues.length, 16); assert.equal(enCues.length, 16);
  ptCues.forEach((c, i) => {
    assert.deepEqual(c.slice(0, 2), enCues[i].slice(0, 2), `número e tempos da legenda ${i + 1}`);
    assert.ok(c[2]?.trim(), `texto da legenda ${i + 1}`);
  });
  assert.equal(ptCues[6][2], 'Nada é publicado sem a minha aprovação.');
  assert.equal(ptCues.filter((c, i) => c[2] !== enCues[i][2]).length, 15, 'traduzidas (só a marca fica igual)');
});
