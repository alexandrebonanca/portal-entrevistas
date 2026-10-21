import { config } from './config.ts';
import { storage } from './storage.ts';
import { saveAsset } from './media.ts';
import { mockTalkingClip } from './video.ts';
import { aiAvailable, type Word } from './ai/openai.ts';
import { veoSubmit, veoAwait, veoIntroPrompt, veoModel, veoPriceOfModel, veoConfigured, veoScopeId, isKeyRejected, opOfCurrentCreds, VeoQuotaError, VeoCancelled, VeoBusy, VeoFiltered, VeoOpError, VeoCredsMissing, type VeoTier } from './talking.ts';
import { startImage, transcribeVeoClip, wordDiff, veoDuration, normWords, veoMock, veoCostPerSec, QUOTA_PAUSE_MS, VEO_NO_CREDENTIALS } from './veo-episode.ts';
import { introPhrase, introBlock, INTRO_MAX_ATTEMPTS } from './intro.ts';
import { PermanentError, JobPaused, type Handler } from './jobs.ts';
import type { Db } from './db.ts';

/**
 * Geração da introdução animada do entrevistador (oferecida): um clipe do Veo a partir da fotografia autorizada, com a
 * frase genérica escolhida e a voz dele, no motor de sempre (Vertex AI ou Gemini API, com as credenciais em vigor) e com
 * a verificação palavra a palavra. No máximo 2 tentativas pagas; sem clipe aprovado, não há introdução (os vídeos seguem
 * sem ela) e o motivo fica no pedido. O custo é interno: operações em veo_ops e «veo_usd_intro» no usage_ledger, sem
 * orçamento nem créditos.
 */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const nextDuration = (d: number): 4 | 6 | 8 => (d <= 4 ? 6 : 8);
type Clip = { assetId: string; words: Word[]; heard: string; checked: boolean; edits: number | null; hard: number | null; dur: number; model: string | null };
const passes = (c: Clip) => c.checked && c.words.length > 0 && c.hard === 0;

export const INTRO_PHOTO_CHANGED = 'A fotografia do entrevistador mudou desde o pedido: nada foi enviado à Google. Peça a introdução de novo.';
export const INTRO_BUSY = 'O Google Veo está com procura elevada: a introdução volta a tentar-se mais tarde (as operações que falharam normalmente não são cobradas).';
const INTRO_QUOTA = 'A aguardar quota da Google: a introdução volta a tentar-se mais tarde.';

/** Pedido falhado de vez: o motivo fica à vista do entrevistador (só os pedidos ainda em curso). */
export const failIntro = (db: Db, id: string, reason: string) =>
  db.query(`UPDATE host_intros SET status='failed', error=$2, updated_at=now() WHERE id=$1 AND status IN ('queued','running')`, [id, reason.slice(0, 800)]);

export async function renderHostIntro(job: any, { db, progress }: Parameters<Handler>[1]) {
  const id = job.input?.introId;
  const row = typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? await db.one('SELECT * FROM host_intros WHERE id=$1 AND interview_id=$2', [id, job.interview_id]) : null;
  if (!row) throw new PermanentError('Pedido de introdução inexistente');
  // Retoma depois de concluída (o processo caiu entre o fim e o registo do trabalho): o resultado é o mesmo.
  if (row.status === 'ready') return { introId: row.id, assetId: row.asset_id, resumed: true };
  if (row.status === 'failed') throw new PermanentError(row.error || 'O pedido da introdução já tinha falhado.');
  try { return await generate(db, job, row, progress); }
  catch (e: any) {
    if (e instanceof PermanentError) await failIntro(db, row.id, String(e.message));
    throw e;
  }
}

async function generate(db: Db, job: any, row: any, progress: (done: number, total?: number, label?: string) => Promise<void>) {
  const mock = config.openai.mock;
  const phrase = introPhrase(row.phrase);
  if (!phrase) throw new PermanentError('Frase da introdução desconhecida: escolha uma das frases da lista.');
  const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [job.interview_id]);
  if (!iv) throw new PermanentError('Entrevista inexistente');
  // As autorizações do Veo do entrevistador nesta entrevista e a mesma fotografia do pedido (lidas de novo antes de cada envio).
  const stillAllowed = async (): Promise<string | null> => {
    const cur = await db.one('SELECT host_photo_asset_id, host_photo_rights, host_ai_video FROM interviews WHERE id=$1', [iv.id]);
    const why = cur ? introBlock(cur) : 'a entrevista já não existe';
    if (why) return `A introdução não foi gerada: ${why}. Nada mais foi enviado à Google.`;
    const ph = await db.one('SELECT sha256 FROM assets WHERE id=$1 AND deleted_at IS NULL', [cur!.host_photo_asset_id]);
    return ph?.sha256 === row.photo_sha ? null : INTRO_PHOTO_CHANGED;
  };
  const why0 = await stillAllowed();
  if (why0) throw new PermanentError(why0);
  if (!mock && !veoConfigured()) throw new PermanentError(VEO_NO_CREDENTIALS);
  // Sem transcrição não há verificação: não se paga um clipe que depois não se possa verificar.
  if (!mock && !aiAvailable()) throw new PermanentError('Falta a chave da OpenAI (transcrição para verificar a introdução) em Definições.');
  const photo = await db.one('SELECT storage_key FROM assets WHERE id=$1', [iv.host_photo_asset_id]);
  const st = await startImage(await storage.get(photo.storage_key));
  // O nível, a voz e o formato são os do pedido (fazem parte da chave).
  const tier: VeoTier = row.tier === 'lite' ? 'lite' : 'fast', voice = row.voice === 'male' ? 'male' : 'female';
  const { default: ff } = await import('@ffmpeg-installer/ffmpeg');
  const ffmpeg = process.env.FFMPEG_PATH || ff.path;
  await db.query(`UPDATE host_intros SET status='running', job_id=$2, updated_at=now() WHERE id=$1 AND status IN ('queued','running')`, [row.id, job.id]);

  const key = `intro:${row.id}`; // operações desta geração (veo_ops.chunk_key)
  // Intenções de uma execução que caiu sem saber se a Google as aceitou: contam como gastas e como tentativa.
  await db.query(`UPDATE veo_ops SET state='unknown' WHERE interview_id=$1 AND chunk_key=$2 AND state='reserved'`, [iv.id, key]);
  if (!mock) await db.query(`UPDATE veo_ops SET state='expired' WHERE interview_id=$1 AND chunk_key=$2 AND state='pending' AND created_at < now() - interval '36 hours'`, [iv.id, key]);
  const judge = (words: Word[], checked: boolean, fullText?: string) => {
    const heard = (fullText?.trim() || words.map(w => w.word.trim()).join(' ')).replace(/\s+([,.;:!?])/g, '$1');
    const d = checked ? wordDiff(phrase.text, heard) : null; // frase genérica: sem nomes, nenhuma diferença se tolera
    return { heard, edits: d?.edits ?? null, hard: d?.hard ?? null, diffs: d?.diffs ?? [] };
  };
  // Clipes de execuções anteriores desta geração (a transcrição que falhou repete-se, sem pagar o Veo de novo).
  const clips: Clip[] = [];
  for (const a of await db.query(`SELECT id, storage_key, meta FROM assets WHERE interview_id=$1 AND kind='veo_intro' AND meta->>'introId'=$2 AND deleted_at IS NULL ORDER BY created_at`, [iv.id, row.id])) {
    let m = a.meta;
    if (!m.checked) {
      const tr = await transcribeVeoClip(await storage.get(a.storage_key), phrase.text, Number(m.dur ?? 8));
      m = { ...m, words: tr.words, checked: tr.checked, ...judge(tr.words, tr.checked, tr.text) };
      await db.query('UPDATE assets SET meta=$2 WHERE id=$1', [a.id, JSON.stringify(m)]);
    }
    clips.push({ assetId: a.id, words: m.words ?? [], heard: m.heard ?? '', checked: !!m.checked, edits: m.edits ?? null, hard: m.hard ?? null, dur: Number(m.dur ?? 8), model: m.model ?? null });
  }
  const failedOps = async () => Number((await db.one(`SELECT count(*)::int AS n FROM veo_ops WHERE interview_id=$1 AND chunk_key=$2 AND state IN ('failed','expired','unknown')`, [iv.id, key])).n);
  let problem: 'mismatch' | 'filtered' | 'google' | null = clips.length ? 'mismatch' : null, busy = 0;

  // Operação que acabou sem vídeo: a estimativa passa de «pago» para «falhado na Google (normalmente não cobrado)».
  const moveToFailed = async (opId: string, dur: number, state: 'busy' | 'failed', error: string) => {
    await db.tx(async t => {
      const r = await t.one(`UPDATE veo_ops SET state=$2, error=$3 WHERE id=$1 AND state='pending' RETURNING model, usd_per_sec`, [opId, state, error.slice(0, 300)]);
      if (!r) return;
      const usd = dur * (r.usd_per_sec != null ? Number(r.usd_per_sec) : veoPriceOfModel(r.model));
      await t.query(`INSERT INTO usage_ledger(interview_id, kind, quantity, cost_usd, estimated) VALUES ($1,'veo_usd_intro',$2,$3,true)`, [iv.id, -dur, -usd]);
      await t.query(`INSERT INTO usage_ledger(interview_id, kind, quantity, cost_usd, estimated) VALUES ($1,'veo_usd_intro_failed',$2,$3,true)`, [iv.id, dur, usd]);
      await t.query(`UPDATE host_intros SET cost_usd=cost_usd-$2, failed_usd=failed_usd+$2, updated_at=now() WHERE id=$1`, [row.id, usd]);
    });
  };
  /** A Google aceitou (e cobra): custo interno registado na operação, no usage_ledger e no pedido, numa só transação. */
  const registerOp = async (opId: string, s: { opName: string; dur: number; model: string; price: number; scope: string; project: string | null }) => {
    const usd = s.dur * s.price;
    for (let k = 0; ; k++) {
      try {
        await db.tx(async t => {
          await t.query(`UPDATE veo_ops SET op_name=$2, duration_sec=$3, model=$4, usd_per_sec=$5, cost_usd=$6, cred_scope=$7, project=$8, state='pending' WHERE id=$1`, [opId, s.opName, s.dur, s.model, s.price, usd, s.scope, s.project]);
          await t.query(`INSERT INTO usage_ledger(interview_id, kind, quantity, cost_usd, estimated) VALUES ($1,'veo_usd_intro',$2,$3,true)`, [iv.id, s.dur, usd]);
          await t.query(`UPDATE host_intros SET sent=sent+1, billed_sec=billed_sec+$2, cost_usd=cost_usd+$3, model=$4, updated_at=now() WHERE id=$1`, [row.id, s.dur, usd, s.model]);
        });
        return;
      } catch (e: any) {
        // Sem registo, a intenção fica 'reserved' (conta como gasta): o trabalho pára em vez de voltar a submeter.
        if (k >= 2) throw new PermanentError(`Falha a registar uma operação já paga à Google: a introdução parou para não pagar outra vez (${String(e?.message ?? e).slice(0, 160)}).`);
        await sleep(2000 * (k + 1));
      }
    }
  };

  for (;;) {
    const ok = clips.find(passes);
    if (ok) {
      const fidelity = clips.map((c, i) => ({ attempt: i + 1, heard: c.heard, edits: c.edits, ok: passes(c) }));
      await db.query(`UPDATE host_intros SET status='ready', asset_id=$2, fidelity=$3, model=COALESCE($4, model), error=NULL, updated_at=now() WHERE id=$1`, [row.id, ok.assetId, JSON.stringify(fidelity), ok.model]);
      await progress(100, 100, 'Introdução pronta');
      return { introId: row.id, assetId: ok.assetId, attempts: clips.length };
    }
    const last = clips[clips.length - 1];
    // Transcrição por fazer (OpenAI ou ffprobe em falha): não se paga outro clipe; o trabalho volta a tentar mais tarde.
    if (last && !last.checked) throw new Error('A verificação da introdução (transcrição) falhou: volta a tentar-se mais tarde, sem pagar outro clipe.');
    const tried = clips.length + (await failedOps());
    if (tried >= INTRO_MAX_ATTEMPTS) {
      await db.query(`UPDATE host_intros SET fidelity=$2 WHERE id=$1`, [row.id, JSON.stringify(clips.map((c, i) => ({ attempt: i + 1, heard: c.heard, edits: c.edits, ok: false })))]);
      const why = problem === 'filtered' ? 'a Google bloqueou o clipe nos filtros de segurança'
        : problem === 'mismatch' ? 'a voz gerada não disse a frase exatamente, palavra a palavra'
        : 'a Google não devolveu o clipe';
      throw new PermanentError(`A introdução não ficou pronta ao fim de ${INTRO_MAX_ATTEMPTS} tentativas: ${why}. Os vídeos seguem sem introdução animada; pode pedir outra geração (conta para o limite mensal).`);
    }
    // Duração: a prevista; se a tentativa anterior saiu cortada (fala até ao fim do clipe ou incompleta), a seguinte.
    let dur: 4 | 6 | 8 = veoDuration(phrase.text);
    if (last) {
      const lastEnd = last.words.length ? last.words[last.words.length - 1].end : 0;
      const short = normWords(last.heard).length < normWords(phrase.text).length * 0.85;
      dur = lastEnd > last.dur - 0.6 || short ? nextDuration(last.dur) : (last.dur as 4 | 6 | 8);
    }
    const label = `Google Veo: introdução animada (tentativa ${tried + 1} de ${INTRO_MAX_ATTEMPTS})`;
    await progress(10 + tried * 40, 100, label);
    let stopWhy: string | null = null;
    const canSend = async () => { stopWhy = await stillAllowed(); return !stopWhy; };
    const pending = await db.one(`SELECT id, op_name, duration_sec, model, usd_per_sec, cred_scope, project FROM veo_ops WHERE interview_id=$1 AND chunk_key=$2 AND state='pending' ORDER BY created_at LIMIT 1`, [iv.id, key]);
    let opId: string, opName: string, opModel: string, opPrice: number, opScope: string | null, opProject: string | null;
    let outcome: 'ok' | 'mismatch' | 'filtered' | 'quota' = 'ok';
    if (pending) {
      // Já paga e por concluir (trabalho interrompido, erro de rede): retoma-se, não se submete de novo.
      opId = pending.id; opName = pending.op_name; dur = Number(pending.duration_sec) as 4 | 6 | 8;
      opModel = pending.model ?? veoModel(tier); opPrice = pending.usd_per_sec != null ? Number(pending.usd_per_sec) : veoPriceOfModel(pending.model);
      opScope = pending.cred_scope ?? null; opProject = pending.project ?? null;
    } else {
      if (!(await canSend())) throw new PermanentError(stopWhy!);
      // Intenção gravada antes do envio, com a duração máxima: se o processo cair a meio, conta como gasta.
      const price = await veoCostPerSec(db, tier); // o custo da tarifa (Definições → Tarifas), o mesmo das falas
      const reserved = await db.one(`INSERT INTO veo_ops(interview_id, chunk_key, op_name, duration_sec, state, model, usd_per_sec, cost_usd) VALUES ($1,$2,NULL,8,'reserved',$3,$4,$5) RETURNING id`,
        [iv.id, key, veoModel(tier), price, 8 * price]);
      try {
        if (mock) {
          outcome = veoMock.outcome?.({ segmentId: 'intro', role: 'host', text: phrase.text, attempt: tried + 1 }) ?? 'ok';
          if (outcome === 'quota') throw new VeoQuotaError('Limite de pedidos (quota) da Google esgotado (simulado).');
          opName = `mock/${reserved.id}`; opModel = veoModel(tier); opPrice = price; opScope = veoScopeId(); opProject = null;
        } else {
          const s = await veoSubmit({ image: st.image, prompt: veoIntroPrompt({ text: phrase.text, voice }), aspectRatio: st.vertical ? '9:16' : '16:9', durationSeconds: dur, canSend, tier,
            onStatus: async m => progress(10 + tried * 40, 100, `${label} — ${m}`) });
          opName = s.opName; dur = s.dur; opModel = s.model; opPrice = price; opScope = s.scope; opProject = s.project;
        }
      } catch (e: any) {
        // Recusado antes de a Google aceitar (400, 429, procura elevada, envio cancelado): a intenção não custa nada.
        await db.query(`UPDATE veo_ops SET state='void', cost_usd=0 WHERE id=$1 AND state='reserved'`, [reserved.id]);
        if (e instanceof VeoCancelled) throw new PermanentError(stopWhy ?? String(e.message));
        if (e instanceof VeoQuotaError) throw new JobPaused(INTRO_QUOTA, QUOTA_PAUSE_MS);
        if (e instanceof VeoBusy) { if (++busy > 2) throw new Error(INTRO_BUSY); await sleep(45_000 * busy); continue; }
        if (isKeyRejected(String(e?.message ?? e))) throw new PermanentError(`A Google recusou as credenciais do Veo (em Definições → Google): ${String(e.message).slice(0, 200)}`);
        throw e; // modelo indisponível (VeoUnsupported) e outros erros permanentes param aqui; os passageiros repetem o trabalho
      }
      opId = reserved.id;
      await registerOp(opId, { opName, dur, model: opModel, price: opPrice, scope: opScope!, project: opProject });
    }
    let video: Buffer;
    try {
      if (mock) {
        if (outcome === 'filtered') throw new VeoFiltered('Veo: clipe bloqueado pelos filtros da Google (simulado)');
        await veoMock.poll?.({ opName, scope: opScope, project: opProject });
        video = await mockTalkingClip(ffmpeg, st.image, dur * 1000, st.vertical);
      } else video = (await veoAwait(opName, dur, async m => progress(10 + tried * 40, 100, `${label} — ${m}`), undefined, undefined, opScope)).video;
    } catch (e: any) {
      const m = String(e?.message ?? e);
      // Credencial que a criou retirada, ou as em vigor recusadas: a operação fica pendente (retoma-se) e nada se paga de novo.
      if (e instanceof VeoCredsMissing) throw new PermanentError(m);
      if (isKeyRejected(m) && opOfCurrentCreds(opName, opScope, opProject)) throw new PermanentError(`A Google recusou as credenciais do Veo (em Definições → Google): ${m.slice(0, 200)}`);
      // Recusa às credenciais de outra operação: dá-a como perdida (custo mantido como pago) e segue para nova tentativa.
      if (isKeyRejected(m)) { await db.query(`UPDATE veo_ops SET state='failed', error=$2 WHERE id=$1 AND state='pending'`, [opId, `consulta recusada às credenciais que criaram a operação, não às em vigor: ${m}`.slice(0, 300)]); problem = 'google'; continue; }
      if (e instanceof VeoBusy) { await moveToFailed(opId, dur, 'busy', m); if (++busy > 2) throw new Error(INTRO_BUSY); await sleep(45_000 * busy); continue; }
      if (e instanceof VeoOpError) { await moveToFailed(opId, dur, 'failed', m); problem = e instanceof VeoFiltered ? 'filtered' : 'google'; continue; }
      if (e instanceof PermanentError) { await db.query(`UPDATE veo_ops SET state='failed', error=$2 WHERE id=$1 AND state='pending'`, [opId, m.slice(0, 300)]); problem = 'google'; continue; }
      throw e; // tempo excedido ou rede: a operação fica pendente e retoma-se na próxima tentativa do trabalho
    }
    const tr = await transcribeVeoClip(video, outcome === 'mismatch' ? `${phrase.text} (texto diferente)` : phrase.text, dur);
    const j = judge(tr.words, tr.checked, tr.text);
    const meta = { introId: row.id, introKey: row.intro_key, phrase: phrase.id, text: phrase.text, role: 'host', attempt: tried + 1, dur, billedSec: dur, words: tr.words, checked: tr.checked, ...j, model: opModel, usdPerSec: opPrice, mock };
    const assetId = await saveAsset(db, { interviewId: iv.id, kind: 'veo_intro', mime: 'video/mp4', ext: 'mp4', data: video, durationMs: dur * 1000, meta });
    await db.query(`UPDATE veo_ops SET state='done' WHERE id=$1`, [opId]);
    clips.push({ assetId, words: tr.words, heard: j.heard, checked: tr.checked, edits: j.edits, hard: j.hard, dur, model: opModel });
    problem = 'mismatch';
  }
}
