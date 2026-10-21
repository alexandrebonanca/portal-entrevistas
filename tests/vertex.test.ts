import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';

// Sem rede: todos os pedidos à Google passam por um fetch falso; a conta de serviço é gerada aqui (chave falsa).
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const SA = { type: 'service_account', project_id: 'projeto-teste-123', private_key_id: 'kid0123456789', private_key: privateKey, client_email: 'veo-teste@projeto-teste-123.iam.gserviceaccount.com', client_id: '1234', token_uri: 'https://oauth2.googleapis.com/token' };
const SA_JSON = JSON.stringify(SA, null, 2);

const t = await import('../src/talking.ts');
const { parseServiceAccount, prepareSetting, maskSetting, settingsFormError, SettingError } = await import('../src/settings.ts');
const { PermanentError } = await import('../src/jobs.ts');

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
let calls: Call[] = [];
const realFetch = globalThis.fetch;
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** fetch falso: regista cada pedido e responde com `route` (o token responde sempre, salvo indicação). */
const fake = (route: (c: Call) => Response | Promise<Response>, token: (c: Call) => Response = () => json({ access_token: 'ya29.teste', expires_in: 3600, token_type: 'Bearer' })) => {
  globalThis.fetch = (async (u: any, init: any = {}) => {
    const c: Call = { url: String(u), method: init.method ?? 'GET', headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])), body: String(init.body ?? '') };
    calls.push(c);
    return c.url === 'https://oauth2.googleapis.com/token' ? token(c) : route(c);
  }) as any;
};
const OP = 'projects/projeto-teste-123/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001/operations/1234-abcd';

beforeEach(() => {
  calls = []; t.clearVertexTokens();
  process.env.VERTEX_SA_JSON = SA_JSON; delete process.env.VERTEX_LOCATION; delete process.env.VEO_TIER; delete process.env.GEMINI_API_KEY;
});
afterEach(() => { globalThis.fetch = realFetch; });

test('Vertex: asserção JWT RS256 da conta de serviço (cabeçalho, campos, validade e assinatura)', () => {
  const sa = parseServiceAccount(SA_JSON);
  const jwt = t.serviceAccountJwt(sa, 1_800_000_000);
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT', kid: 'kid0123456789' });
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url').toString()), { iss: SA.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: 1_800_000_000, exp: 1_800_003_600 });
  assert.ok(verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url')), 'assinada com a chave da conta de serviço');
});

test('Vertex: token pedido uma vez e guardado até 60 s antes de expirar', async () => {
  let n = 0;
  fake(() => json({}), c => {
    n++;
    const p = new URLSearchParams(c.body);
    assert.equal(c.method, 'POST'); assert.equal(c.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(p.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.equal(p.get('assertion')!.split('.').length, 3);
    return json({ access_token: `ya29.t${n}`, expires_in: n === 1 ? 3600 : 60 });
  });
  assert.equal((await t.vertexToken()).token, 'ya29.t1');
  assert.equal((await t.vertexToken()).token, 'ya29.t1', 'segundo pedido usa o token guardado');
  assert.equal(n, 1);
  t.clearVertexTokens();
  assert.equal((await t.vertexToken()).token, 'ya29.t2');
  assert.equal((await t.vertexToken()).token, 'ya29.t3', 'um token com 60 s ou menos de validade não é reutilizado');
  assert.equal(n, 3);
});

test('Vertex: recusa do token reconhecida como credenciais recusadas, sem mostrar a chave', async () => {
  fake(() => json({}), () => json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400));
  await assert.rejects(t.vertexToken(), (e: any) => e instanceof PermanentError && t.isKeyRejected(e.message) && /invalid_grant/.test(e.message) && !/PRIVATE KEY|eyJ/.test(e.message));
  await assert.rejects(t.veoSubmit({ image: Buffer.from('x'), prompt: 'p', durationSeconds: 4 }), (e: any) => t.isKeyRejected(e.message), 'o envio pára sem tentar o Veo');
  assert.ok(calls.every(c => c.url === 'https://oauth2.googleapis.com/token'), 'nada foi enviado ao Veo');
  // indisponibilidade do serviço de autenticação: passageira (não conta para o limite)
  calls = []; t.clearVertexTokens();
  fake(() => json({}), () => json({ error: 'backend_error' }, 503));
  await assert.rejects(t.veoSubmit({ image: Buffer.from('x'), prompt: 'p', durationSeconds: 4 }), (e: any) => e instanceof t.VeoBusy);
  // conta de serviço inválida em Definições (variável de ambiente): recusada antes de qualquer pedido
  calls = []; process.env.VERTEX_SA_JSON = '{"type":"service_account"}';
  await assert.rejects(t.vertexToken(), (e: any) => t.isKeyRejected(e.message));
  assert.equal(calls.length, 0);
});

test('Vertex: pedido do clipe (Fast) com imagem em base64, 720p, áudio e negativePrompt', async () => {
  fake(c => json({ name: OP }));
  const img = Buffer.from('imagem-jpeg');
  const s = await t.veoSubmit({ image: img, prompt: 'Diz olá', aspectRatio: '9:16', durationSeconds: 6 });
  const c = calls.find(x => x.url.includes(':predictLongRunning'))!;
  assert.equal(c.url, 'https://us-central1-aiplatform.googleapis.com/v1/projects/projeto-teste-123/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001:predictLongRunning');
  assert.equal(c.method, 'POST'); assert.equal(c.headers.authorization, 'Bearer ya29.teste');
  const b = JSON.parse(c.body);
  assert.deepEqual(b.instances, [{ prompt: 'Diz olá', image: { bytesBase64Encoded: img.toString('base64'), mimeType: 'image/jpeg' } }]);
  assert.deepEqual(b.parameters, { aspectRatio: '9:16', durationSeconds: 6, personGeneration: 'allow_adult', negativePrompt: t.VEO_NEGATIVE_PROMPT, generateAudio: true, sampleCount: 1, resolution: '720p' });
  assert.match(t.VEO_NEGATIVE_PROMPT, /on-screen text/);
  assert.deepEqual(s, { opName: OP, dur: 6, model: 'veo-3.1-fast-generate-001', tier: 'fast', usdPerSec: 0.10, backend: 'vertex', scope: 'global', project: 'projeto-teste-123' });
  // região própria
  calls = []; process.env.VERTEX_LOCATION = 'europe-west4';
  await t.veoSubmit({ image: img, prompt: 'p', durationSeconds: 4 });
  assert.match(calls.at(-1)!.url, /^https:\/\/europe-west4-aiplatform\.googleapis\.com\/v1\/projects\/projeto-teste-123\/locations\/europe-west4\//);
  // credenciais recusadas pelo Vertex (sem a função Vertex AI User / API desativada)
  fake(() => json({ error: { code: 403, message: "Permission 'aiplatform.endpoints.predict' denied", status: 'PERMISSION_DENIED' } }, 403));
  await assert.rejects(t.veoSubmit({ image: img, prompt: 'p', durationSeconds: 4 }), (e: any) => t.isKeyRejected(e.message));
});

test('Vertex: escolha Fast/Lite (modelo e preço) e estimativa do episódio', async () => {
  const { veoEstimate } = await import('../src/veo-episode.ts');
  assert.equal(t.veoTier(), 'fast', 'por omissão o Fast');
  assert.equal(t.veoModel(), 'veo-3.1-fast-generate-001'); assert.equal(t.veoPricePerSec(), 0.10);
  process.env.VEO_TIER = 'lite';
  assert.equal(t.veoTier(), 'lite'); assert.equal(t.veoModel(), 'veo-3.1-lite-generate-001'); assert.equal(t.veoPricePerSec(), 0.05);
  assert.equal(t.veoLabel(), 'Google Veo 3.1 Lite');
  delete process.env.VERTEX_SA_JSON; process.env.GEMINI_API_KEY = 'AIza-falsa';
  assert.equal(t.veoBackend(), 'gemini'); assert.equal(t.veoModel(), 'veo-3.1-lite-generate-preview', 'sem conta de serviço: Gemini API');
  assert.equal(t.veoConfigured(), true);
  delete process.env.GEMINI_API_KEY;
  assert.equal(t.veoConfigured(), false);
  assert.equal(t.veoKeyModel('fast'), t.VEO_MODEL, 'a chave dos clipes do Fast é a de sempre (clipes pagos reaproveitados)');
  assert.equal(t.veoPriceOfModel('veo-3.1-lite-generate-001'), 0.05); assert.equal(t.veoPriceOfModel(undefined), 0.10, 'registos antigos: Fast');
  const timing = [{ id: 's1', role: 'host', kind: 'question', startMs: 0, durationMs: 3000 }];
  const segs = [{ id: 's1', textEnglish: 'Hello and welcome to the show.' }];
  const fast = veoEstimate(timing, segs, true, true, 'fast'), lite = veoEstimate(timing, segs, true, true, 'lite');
  assert.equal(fast.clips, 1); assert.equal(lite.sec, fast.sec);
  assert.equal(fast.usdPerSec, 0.10); assert.equal(lite.usdPerSec, 0.05);
  assert.ok(Math.abs(lite.usd * 2 - fast.usd) < 1e-9); assert.ok(Math.abs(lite.usdMax * 2 - fast.usdMax) < 1e-9);
  // Lite no Vertex
  process.env.VERTEX_SA_JSON = SA_JSON;
  fake(() => json({ name: OP.replace('fast', 'lite') }));
  const s = await t.veoSubmit({ image: Buffer.from('x'), prompt: 'p', durationSeconds: 8 });
  assert.match(calls.at(-1)!.url, /models\/veo-3\.1-lite-generate-001:predictLongRunning$/);
  assert.equal(s.usdPerSec, 0.05); assert.equal(s.tier, 'lite');
});

test('Vertex: o Lite que recuse a imagem inicial pára com uma mensagem clara', async () => {
  process.env.VEO_TIER = 'lite';
  fake(() => json({ error: { code: 400, message: 'Image input is not supported for this model.', status: 'INVALID_ARGUMENT' } }, 400));
  await assert.rejects(t.veoSubmit({ image: Buffer.from('x'), prompt: 'p', durationSeconds: 8 }),
    (e: any) => e instanceof t.VeoUnsupported && /Veo 3\.1 Lite/.test(e.message) && /Veo 3\.1 Fast em Definições/.test(e.message) && !t.isKeyRejected(e.message));
  assert.equal(calls.filter(c => c.url.includes(':predictLongRunning')).length, 1, 'não repete o pedido');
});

test('Veo: modelo inexistente ou desligado no envio (404) pára com uma indicação clara, sem repetir nem cobrar', async () => {
  // Gemini API depois de 22/10/2026: o modelo deixa de existir
  delete process.env.VERTEX_SA_JSON; process.env.GEMINI_API_KEY = 'AIza-falsa';
  fake(() => json({ error: { code: 404, message: 'models/veo-3.1-fast-generate-preview is not found for API version v1beta, or is not supported for predictLongRunning.', status: 'NOT_FOUND' } }, 404));
  await assert.rejects(t.veoSubmit({ image: Buffer.from('x'), prompt: 'p', durationSeconds: 8 }),
    (e: any) => e instanceof t.VeoUnsupported && /já não está disponível na Gemini API \(nada foi cobrado\): configure a conta de serviço do Vertex AI em Definições → Google\./.test(e.message) && /is not found/.test(e.message) && !t.isKeyRejected(e.message));
  assert.equal(calls.length, 1, 'não repete o pedido');
  // Vertex AI: modelo que não existe na região escolhida
  process.env.VERTEX_SA_JSON = SA_JSON; process.env.VERTEX_LOCATION = 'europe-west4'; calls = [];
  fake(c => (c.url.includes(':predictLongRunning') ? json({ error: { code: 404, message: 'Publisher Model `veo-3.1-fast-generate-001` was not found.', status: 'NOT_FOUND' } }, 404) : json({})));
  await assert.rejects(t.veoSubmit({ image: Buffer.from('x'), prompt: 'p', durationSeconds: 8 }),
    (e: any) => e instanceof t.VeoUnsupported && /não está disponível no Vertex AI em europe-west4 \(nada foi cobrado\): confirme a região e o modelo/.test(e.message));
  assert.equal(calls.filter(c => c.url.includes(':predictLongRunning')).length, 1);
});

test('Vertex: resposta da operação (vídeo em base64, pendente, filtrado, erro) consultada pelo nome', async () => {
  const mp4 = Buffer.from('....ftypmp42 vídeo falso');
  let polls = 0;
  fake(c => {
    assert.equal(c.url, 'https://us-central1-aiplatform.googleapis.com/v1/projects/projeto-teste-123/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001:fetchPredictOperation');
    assert.equal(c.method, 'POST'); assert.deepEqual(JSON.parse(c.body), { operationName: OP }); assert.equal(c.headers.authorization, 'Bearer ya29.teste');
    return ++polls < 2 ? json({ name: OP }) : json({ name: OP, done: true, response: { '@type': 'type.googleapis.com/cloud.ai.large_models.vision.GenerateVideoResponse', raiMediaFilteredCount: 0, videos: [{ bytesBase64Encoded: mp4.toString('base64'), mimeType: 'video/mp4' }] } });
  });
  const r = await t.veoAwait(OP, 8, undefined, 60_000, 1);
  assert.ok(r.video.equals(mp4)); assert.equal(r.billedSec, 8); assert.equal(polls, 2, 'pendente, depois concluída');
  // filtros da Google
  fake(() => json({ name: OP, done: true, response: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['Unable to generate videos because of a person in the image.'] } }));
  await assert.rejects(t.veoAwait(OP, 8, undefined, 60_000, 1), (e: any) => e instanceof t.VeoFiltered && /person/.test(e.message));
  // a operação falhou na Google; procura elevada é passageira
  fake(() => json({ name: OP, done: true, error: { code: 3, message: 'Invalid argument' } }));
  await assert.rejects(t.veoAwait(OP, 8, undefined, 60_000, 1), (e: any) => e instanceof t.VeoOpError && !(e instanceof t.VeoFiltered));
  fake(() => json({ name: OP, done: true, error: { code: 8, message: 'Resource exhausted' } }));
  await assert.rejects(t.veoAwait(OP, 8, undefined, 60_000, 1), (e: any) => e instanceof t.VeoBusy);
  // consulta recusada: credenciais (fica pendente) ou operação desconhecida
  fake(() => json({ error: { code: 401, message: 'Request had invalid authentication credentials.' } }, 401));
  await assert.rejects(t.veoAwait(OP, 8, undefined, 60_000, 1), (e: any) => e instanceof t.VeoPollError && t.isKeyRejected(e.message));
  fake(() => json({ error: { code: 404, message: 'Operation not found' } }, 404));
  await assert.rejects(t.veoAwait(OP, 8, undefined, 60_000, 1), (e: any) => e instanceof t.VeoPollError && !t.isKeyRejected(e.message));
  // conclusão sem vídeo nem filtro
  fake(() => json({ name: OP, done: true, response: { raiMediaFilteredCount: 0, videos: [] } }));
  await assert.rejects(t.veoAwait(OP, 8, undefined, 60_000, 1), (e: any) => e instanceof t.VeoOpError && /não devolveu vídeo/.test(e.message));
});

test('Veo: operação pendente retomada no serviço que a criou', async () => {
  process.env.GEMINI_API_KEY = 'AIza-falsa';
  const gemOp = 'models/veo-3.1-fast-generate-preview/operations/xyz';
  fake(c => (c.url.startsWith('https://generativelanguage.googleapis.com/') && !c.url.includes('/files/')
    ? json({ name: gemOp, done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/v1:download' } }] } } })
    : new Response(Buffer.from('mp4-gemini'))));
  const r = await t.veoAwait(gemOp, 4, undefined, 60_000, 1);
  assert.equal(r.video.toString(), 'mp4-gemini');
  assert.equal(calls[0].url, `https://generativelanguage.googleapis.com/v1beta/${gemOp}`, 'Gemini API, mesmo com conta de serviço');
  assert.equal(calls[0].headers['x-goog-api-key'], 'AIza-falsa');
  assert.ok(!calls.some(c => c.url.includes('aiplatform') || c.url.includes('oauth2')));
  // a operação do Vertex vai ao Vertex, na região e no modelo do nome (não nos de agora)
  calls = []; process.env.VEO_TIER = 'lite'; process.env.VERTEX_LOCATION = 'europe-west4';
  fake(() => json({ name: OP, done: true, response: { videos: [{ bytesBase64Encoded: Buffer.from('mp4-vertex').toString('base64'), mimeType: 'video/mp4' }] } }));
  assert.equal((await t.veoAwait(OP, 8, undefined, 60_000, 1)).video.toString(), 'mp4-vertex');
  assert.match(calls.at(-1)!.url, /^https:\/\/us-central1-aiplatform\.googleapis\.com\/.+\/models\/veo-3\.1-fast-generate-001:fetchPredictOperation$/);
  // credenciais desse serviço retiradas: não se consegue consultar (não é uma recusa de credenciais); a operação fica pendente
  delete process.env.GEMINI_API_KEY; calls = [];
  await assert.rejects(t.veoAwait(gemOp, 4, undefined, 60_000, 1), (e: any) => e instanceof t.VeoCredsMissing && /chave Gemini com que foi criada foi retirada/.test(e.message) && /nada é pago de novo/.test(e.message) && !t.isKeyRejected(e.message));
  delete process.env.VERTEX_SA_JSON;
  await assert.rejects(t.veoAwait(OP, 4, undefined, 60_000, 1), (e: any) => e instanceof t.VeoCredsMissing && /conta de serviço com que foi criada foi retirada/.test(e.message));
  assert.equal(calls.length, 0);
  await assert.rejects(t.veoAwait('projects/x/locations/us-central1/publishers/google/models/m/operations/1?x=y', 4, undefined, 60_000, 1), (e: any) => e instanceof t.VeoPollError);
});

test('Veo: a operação consulta-se com as credenciais do âmbito que a criou; uma recusa só acusa as credenciais em vigor', async () => {
  // operação criada com as credenciais globais (âmbito 'global'): consulta-se com a conta de serviço global
  fake(() => json({ name: OP, done: true, response: { videos: [{ bytesBase64Encoded: Buffer.from('mp4').toString('base64') }] } }));
  assert.equal((await t.veoAwait(OP, 8, undefined, 60_000, 1, 'global')).video.toString(), 'mp4');
  assert.equal(JSON.parse(Buffer.from(new URLSearchParams(calls[0].body).get('assertion')!.split('.')[1], 'base64url').toString()).iss, SA.client_email);
  // criada com as credenciais de uma entidade que já não as tem: fica pendente, sem nenhum pedido (nada se paga de novo)
  calls = [];
  const ent = '00000000-0000-0000-0000-0000000000e1';
  await assert.rejects(t.veoAwait(OP, 8, undefined, 60_000, 1, ent), (e: any) => e instanceof t.VeoCredsMissing && /\(credenciais da entidade\)/.test(e.message) && !t.isKeyRejected(e.message));
  await assert.rejects(t.veoAwait('models/veo-3.1-fast-generate-preview/operations/z', 8, undefined, 60_000, 1, 'global'), (e: any) => e instanceof t.VeoCredsMissing && /chave Gemini com que foi criada \(credenciais globais do portal\)/.test(e.message));
  assert.equal(calls.length, 0);
  // de quem é a operação: mesmo âmbito, mesmo serviço e, no Vertex, o mesmo projeto da conta de serviço em vigor
  assert.equal(t.veoScopeId(), 'global');
  assert.equal(t.opOfCurrentCreds(OP, 'global', 'projeto-teste-123'), true);
  assert.equal(t.opOfCurrentCreds(OP.replace('projeto-teste-123', '123456789012'), 'global', 'projeto-teste-123'), true, 'o nome pode trazer o número do projeto');
  assert.equal(t.opOfCurrentCreds(OP, 'global', 'outro-projeto'), false, 'conta de serviço de outro projeto');
  assert.equal(t.opOfCurrentCreds(OP, ent, 'projeto-teste-123'), false, 'criada com as credenciais de uma entidade');
  assert.equal(t.opOfCurrentCreds('models/veo-3.1-fast-generate-preview/operations/z', 'global', null), false, 'da Gemini API com o Vertex em vigor');
  assert.equal(t.opOfCurrentCreds(OP, null, null), true, 'operação antiga (sem âmbito): as credenciais em vigor');
  delete process.env.VERTEX_SA_JSON; process.env.GEMINI_API_KEY = 'AIza-falsa';
  assert.equal(t.opOfCurrentCreds('models/veo-3.1-fast-generate-preview/operations/z', 'global', null), true);
  assert.equal(t.opOfCurrentCreds(OP, 'global', 'projeto-teste-123'), false, 'do Vertex com a Gemini API em vigor');
});

test('Gemini API (reserva): negativePrompt enviado e retirado se for recusado', async () => {
  delete process.env.VERTEX_SA_JSON; process.env.GEMINI_API_KEY = 'AIza-falsa';
  const sent: any[] = [];
  fake(c => { const b = JSON.parse(c.body); sent.push(b.parameters); return 'negativePrompt' in b.parameters ? json({ error: { code: 400, message: 'Invalid JSON payload received. Unknown name "negativePrompt" at \'parameters\'' } }, 400) : json({ name: 'models/veo-3.1-fast-generate-preview/operations/a' }); });
  const s = await t.veoSubmit({ image: Buffer.from('x'), prompt: 'p', durationSeconds: 4 });
  assert.equal(s.backend, 'gemini'); assert.equal(s.model, 'veo-3.1-fast-generate-preview');
  assert.equal(sent.length, 2); assert.equal(sent[0].negativePrompt, t.VEO_NEGATIVE_PROMPT); assert.ok(!('negativePrompt' in sent[1]));
  assert.ok(!('generateAudio' in sent[0]), 'a Gemini API recebe os parâmetros de sempre');
  await t.veoSubmit({ image: Buffer.from('x'), prompt: 'p', durationSeconds: 4 });
  assert.equal(sent.length, 3, 'depois de uma recusa deixa de o enviar');
});

test('conta de serviço: validação do JSON sem nunca mostrar a chave', () => {
  const secret = privateKey.split('\n')[2];
  const err = (raw: string) => { try { parseServiceAccount(raw); return ''; } catch (e: any) { assert.ok(e instanceof SettingError); return String(e.message); } };
  const bad = err(SA_JSON.slice(0, -3));
  assert.match(bad, /não é um JSON válido/); assert.ok(!bad.includes(secret.slice(0, 20)) && !bad.includes('PRIVATE'), 'a mensagem não cita o texto colado');
  assert.match(err(JSON.stringify({ ...SA, client_email: undefined })), /Faltam campos.*client_email/);
  assert.match(err(JSON.stringify({ ...SA, private_key: undefined, project_id: '' })), /private_key, project_id/);
  assert.match(err(JSON.stringify({ ...SA, type: 'authorized_user' })), /não é a chave de uma conta de serviço \(type «authorized_user»\)/);
  assert.match(err(JSON.stringify({ ...SA, project_id: 'x/../../evil' })), /project_id/);
  assert.match(err(JSON.stringify({ ...SA, private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' })), /não é uma chave RSA válida/);
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  assert.match(err(JSON.stringify({ ...SA, private_key: ec })), /RSA/);
  // válida: guarda só os campos necessários
  const saved = JSON.parse(prepareSetting('VERTEX_SA_JSON', SA_JSON));
  assert.deepEqual(Object.keys(saved).sort(), ['client_email', 'private_key', 'private_key_id', 'project_id', 'type']);
  assert.equal(saved.private_key, privateKey);
  const shown = maskSetting('VERTEX_SA_JSON', JSON.stringify(saved));
  assert.equal(shown, `guardada: ${SA.client_email} · projeto ${SA.project_id}`);
  assert.ok(!shown.includes(secret.slice(0, 10)));
  // região e nível
  assert.equal(prepareSetting('VERTEX_LOCATION', ' US-Central1 '), 'us-central1');
  assert.throws(() => prepareSetting('VERTEX_LOCATION', 'us-central1.evil.com/x'), SettingError);
  assert.equal(prepareSetting('VEO_TIER', 'lite'), 'lite');
  assert.throws(() => prepareSetting('VEO_TIER', 'pro'), SettingError);
  assert.match(settingsFormError({ VEO_TIER: 'fast', VERTEX_SA_JSON: '{"a":1' })!, /JSON válido/);
  assert.equal(settingsFormError({ VEO_TIER: 'lite', VERTEX_SA_JSON: '', VERTEX_LOCATION: '-' }), null, 'em branco mantém e «-» apaga');
});

test('conta de serviço: colagens estragadas explicadas sem mostrar a chave; BOM e aspas tipográficas aceites', () => {
  const secret = privateKey.split('\n')[2];
  const err = (raw: string) => { try { parseServiceAccount(raw); return ''; } catch (e: any) { return String(e.message); } };
  const noLeak = (m: string) => { assert.ok(!m.includes(secret.slice(0, 12)) && !m.includes('PRIVATE') && !m.includes(SA.client_email) && !m.includes(SA.project_id), 'a mensagem não cita o texto'); return m; };
  // colado duas vezes
  assert.match(noLeak(err(SA_JSON + SA_JSON)), /recebidos \d+ caracteres; começa por «\{»: sim; termina em «\}»: sim.*colado mais do que uma vez/);
  // só a chave privada
  assert.match(noLeak(err(privateKey)), /só a chave privada/);
  // preenchido pelo gestor de palavras-passe, ou uma chave de API em vez do ficheiro
  assert.match(noLeak(err('Xk9#mQ2!vR7pL4')), /recebidos 14 caracteres.*curto demais.*chave de API, uma palavra-passe preenchida pelo browser ou só uma parte.*Adicionar chave → Criar nova chave → JSON/);
  const aiza = 'AIzaSyD' + 'x'.repeat(32), aq = 'AQ.Ab8RN6' + 'y'.repeat(33);
  const mAiza = err(aiza), mAq = err(aq);
  assert.match(mAiza, /chave de API da Google \(começa por «AIza»\).*campo «Gemini API key».*JSON/); assert.ok(!mAiza.includes(aiza.slice(4, 14)));
  assert.match(mAq, /modo express \(começa por «AQ\.»\), que não serve aqui/); assert.ok(!mAq.includes(aq.slice(3, 15)));
  assert.match(noLeak(err('a ' + SA_JSON)), /não é um JSON válido/);
  assert.equal(parseServiceAccount(SA_JSON.replace(/\n {2}/g, '\n  ')).client_email, SA.client_email, 'espaços não separáveis na indentação');
  // cortado no fim
  assert.match(noLeak(err(SA_JSON.slice(0, 1500))), /termina em «\}»: não.*Falta o início ou o fim/);
  // o ficheiro como o browser o envia a partir da caixa (com quebras de linha), com BOM e com aspas tipográficas
  assert.equal(parseServiceAccount('﻿' + SA_JSON + '\r\n').client_email, SA.client_email);
  const curly = SA_JSON.replace(/"(type|project_id|client_email)": "([^"]*)"/g, '“$1”: “$2”');
  assert.notEqual(curly, SA_JSON);
  assert.equal(parseServiceAccount(curly).project_id, SA.project_id);
});

test('Definições: a conta de serviço numa caixa mascarada com «Escolher o ficheiro .json»', async () => {
  const { settingInput } = await import('../src/routes/admin.ts');
  const { SETTING_DEFS } = await import('../src/settings.ts');
  const html = settingInput(SETTING_DEFS.find(d => d.key === 'VERTEX_SA_JSON')!, JSON.stringify(SA), '');
  assert.match(html, /<textarea id="f_VERTEX_SA_JSON" name="VERTEX_SA_JSON"[^>]*autocomplete="off"[^>]*-webkit-text-security:disc[^>]*placeholder="guardada: veo-teste@projeto-teste-123\.iam\.gserviceaccount\.com · projeto projeto-teste-123"><\/textarea>/);
  assert.match(html, /<button type="button" class="ghost" data-json-pick="f_VERTEX_SA_JSON">Escolher o ficheiro \.json<\/button><input type="file" accept="\.json,application\/json" data-json-into="f_VERTEX_SA_JSON" hidden>/, 'botão alcançável pelo teclado');
  assert.match(html, /try\{t\.value=await x\.text\(\);say\(\);\}catch/, 'erro de leitura tratado');
  assert.doesNotMatch(html, /type="password"|PRIVATE|private_key/, 'nada da chave na página');
});

test('«Guardar e testar» do Google: Vertex sem gerar vídeo; Gemini API sem conta de serviço', async () => {
  fake(c => {
    assert.match(c.url, /veo-3\.1-fast-generate-001:fetchPredictOperation$/, 'só consulta; nunca predictLongRunning');
    assert.match(JSON.parse(c.body).operationName, /\/operations\/00000000-0000-0000-0000-000000000000$/);
    return json({ error: { code: 404, message: 'Operation not found.', status: 'NOT_FOUND' } }, 404);
  });
  const ok = await t.veoCheck();
  assert.match(ok, /Vertex AI.*veo-teste@projeto-teste-123\.iam\.gserviceaccount\.com.*projeto-teste-123.*us-central1.*Google Veo 3\.1 Fast \(veo-3\.1-fast-generate-001\) confirmado, sem gerar vídeo/);
  assert.ok(!calls.some(c => c.url.includes(':predictLongRunning')));
  fake(() => json({ error: { code: 403, message: 'Vertex AI API has not been used in project 123 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } }, 403));
  await assert.rejects(t.veoCheck(), /Vertex AI API não está ativa no projeto projeto-teste-123/);
  fake(() => json({ error: { code: 403, message: "Permission 'aiplatform.endpoints.predict' denied", status: 'PERMISSION_DENIED' } }, 403));
  await assert.rejects(t.veoCheck(), /Vertex AI User/);
  process.env.VEO_TIER = 'lite';
  fake(() => json({ error: { code: 404, message: 'Publisher Model `projects/projeto-teste-123/locations/us-central1/publishers/google/models/veo-3.1-lite-generate-001` not found.' } }, 404));
  await assert.rejects(t.veoCheck(), /modelo veo-3\.1-lite-generate-001 não está disponível/);
  t.clearVertexTokens();
  fake(() => json({}), () => json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400));
  await assert.rejects(t.veoCheck(), (e: any) => /recusou a conta de serviço/.test(e.message) && !/^Veo/.test(e.message));
  // sem conta de serviço: Gemini API como antes, com o modelo do nível escolhido
  delete process.env.VERTEX_SA_JSON; delete process.env.VEO_TIER; process.env.GEMINI_API_KEY = 'AIza-falsa';
  fake(c => { assert.equal(c.url, 'https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview'); return json({ name: 'models/veo-3.1-fast-generate-preview' }); });
  assert.match(await t.veoCheck(), /Gemini API.*22\/10\/2026/);
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(t.veoCheck(), /falta a conta de serviço/);
});

test('«Guardar e testar» do Google: 404 e 400 da operação inexistente provam o acesso; outra resposta mostra-se tal como veio', async () => {
  const ok = /conta de serviço aceite \(veo-teste@projeto-teste-123\.iam\.gserviceaccount\.com, projeto projeto-teste-123, us-central1\) e acesso ao Google Veo 3\.1 Fast \(veo-3\.1-fast-generate-001\) confirmado/;
  fake(() => json({ error: { code: 400, message: 'Invalid operation name.', status: 'INVALID_ARGUMENT' } }, 400));
  assert.match(await t.veoCheck(), ok);
  fake(() => json({ name: 'x', done: true }));
  assert.match(await t.veoCheck(), ok, 'uma resposta 2xx também prova o acesso');
  // 500 (por exemplo, se o Vertex real responder assim a uma operação que não existe): o token foi aceite; diz-se o que veio
  fake(() => json({ error: { code: 500, message: 'Internal error encountered.', status: 'INTERNAL' } }, 500));
  await assert.rejects(t.veoCheck(), (e: any) => /foi aceite \(token obtido\), mas o teste do acesso ao Google Veo 3\.1 Fast \(veo-3\.1-fast-generate-001, us-central1\) teve uma resposta inesperada da Google: HTTP 500 INTERNAL — Internal error encountered\.\. Nada foi gerado nem cobrado; pode ser passageira/.test(e.message));
  fake(() => json({ error: { code: 409, message: 'Aborted.', status: 'ABORTED' } }, 409));
  await assert.rejects(t.veoCheck(), /HTTP 409 ABORTED — Aborted\.\. Nada foi gerado nem cobrado; confirme o acesso ao modelo na consola da Google Cloud/);
  fake(() => new Response('<html>Bad gateway</html>', { status: 502 }));
  await assert.rejects(t.veoCheck(), /HTTP 502 — <html>Bad gateway<\/html>/);
  assert.ok(!calls.some(c => c.url.includes(':predictLongRunning')), 'nunca gera vídeo');
});

test('Laboratório: só o Veo vem marcado; os outros motores continuam disponíveis', () => {
  const veo = t.PROVIDERS.filter(p => p.preselected).map(p => p.id);
  assert.deepEqual(veo, ['veo', 'veo-lite']);
  assert.deepEqual(t.PROVIDERS.filter(p => !p.preselected).map(p => p.id), ['omnihuman', 'fabric', 'infinitalk', 'heygen']);
  assert.deepEqual(t.PROVIDERS.filter(t.isVeoProvider).map(p => [p.label, p.pricePerSec]), [['Google Veo 3.1 Fast', 0.10], ['Google Veo 3.1 Lite', 0.05]]);
  assert.ok(t.PROVIDERS.every(p => !/Flow/.test(p.label)));
  const fast = t.PROVIDERS.find(p => p.id === 'veo')!;
  assert.equal(t.providerReady(fast), true, 'conta de serviço basta');
  delete process.env.VERTEX_SA_JSON;
  assert.equal(t.providerReady(fast), false);
  process.env.GEMINI_API_KEY = 'AIza-falsa';
  assert.equal(t.providerReady(fast), true, 'ou a chave da Gemini API');
});
