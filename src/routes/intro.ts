import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.ts';
import { config } from '../config.ts';
import { esc } from '../lib.ts';
import { pill } from '../views.ts';
import { requireUser, ownedInterview, audit } from '../app.ts';
import { storage } from '../storage.ts';
import { enqueue } from '../jobs.ts';
import { quotaFor } from '../billing.ts';
import { aiAvailable } from '../ai/openai.ts';
import { inEntity, entityOfInterview } from '../settings.ts';
import { veoConfigured, veoTier, veoLabel } from '../talking.ts';
import { startImage, veoCostPerSec, VEO_NOTICE, VEO_NO_CREDENTIALS } from '../veo-episode.ts';
import { INTRO_PHRASES, introPhrase, introKeyOf, introBlock, introState, introsThisMonth, readyIntro } from '../intro.ts';

/**
 * Introdução animada do entrevistador (oferecida): escolha da frase e «Gerar introdução» em «Editar», estado, pré-
 * visualização do clipe e custo interno (só o administrador o vê). Não usa créditos nem entra no orçamento; no máximo
 * INTRO_PER_MONTH gerações por entrevistador e por mês (o administrador não tem limite e as dele não contam).
 */

export const INTRO_NOT_ENTITLED = 'A introdução animada é oferecida a quem produz vídeos: com uma subscrição ativa, numa entrevista já enviada ou como gestor de entidade. Veja os planos em Conta.';
const INTRO_NOT_FREE = 'A introdução animada (gerada pelo Google Veo) não está incluída na 1.ª entrevista grátis: é oferecida a quem tem uma subscrição ativa. Veja os planos em Conta.';
const INTRO_OPENAI = 'Falta a chave da OpenAI (transcrição para verificar a introdução) em Definições.';

/**
 * Quem tem direito à oferta: o administrador e os gestores de entidade, uma subscrição ativa ou uma entrevista já enviada
 * (paga: a 1.ª entrevista grátis não dá direito a ela, porque o Veo é um custo do portal e a oferta não inclui animação).
 */
async function introEntitled(db: Db, owner: { id: string; role: string }, iv: any) {
  if (owner.role === 'admin' || owner.role === 'entity_admin' || (iv.collection_status !== 'draft' && !iv.free_at)) return true;
  const q = await quotaFor(db, owner);
  return q.allowed || q.reason === 'quota';
}

/** Porque é que o botão «Gerar introdução» fica desativado (null = pode gerar). */
async function generateBlock(db: Db, iv: any, owner: any, user: any, ent: string | null | undefined) {
  const why = introBlock(iv);
  if (why) return `Para gerar a introdução, ${why}.`;
  if (user.role !== 'admin' && !(await introEntitled(db, owner, iv))) return iv.free_at ? INTRO_NOT_FREE : INTRO_NOT_ENTITLED;
  if (!config.openai.mock && !inEntity(ent, () => veoConfigured())) return VEO_NO_CREDENTIALS;
  if (!config.openai.mock && !inEntity(ent, () => aiAvailable())) return INTRO_OPENAI;
  return null;
}

/** Cartão da introdução na página «Editar» da entrevista. */
export async function introCard(db: Db, iv: any, user: any): Promise<string> {
  const owner = await db.one('SELECT id, role, entity_id, intro_phrase FROM users WHERE id=$1', [iv.owner_id]);
  if (!owner) return '';
  const ent = await entityOfInterview(db, iv.id);
  const tier = inEntity(ent, () => veoTier());
  const s = await introState(db, iv, owner, tier);
  const max = config.limits.introPerMonth, isAdmin = user.role === 'admin';
  const block = await generateBlock(db, iv, owner, user, ent);
  const full = !isAdmin && s.used >= max;
  const shown = s.ready ?? s.open ?? s.last;
  const status = !s.phrase ? pill('sem introdução')
    : s.ready ? `${pill('pronta', 'ok')} ${introBlock(iv) ? `Nesta entrevista não entra: ${esc(introBlock(iv)!)}.` : 'Entra nos vídeos com animação do Google Veo desta entrevista.'}`
    : s.open ? `${pill(s.open.status === 'running' ? 'a ser gerada' : 'em fila')} Pode demorar alguns minutos: recarregue a página.`
    : s.last?.status === 'failed' ? `${pill('falhou', 'bad')} ${esc(s.last.error ?? '')}`
    : pill('por gerar');
  let cost = '';
  if (isAdmin) {
    const m = await db.one(`SELECT COALESCE(sum(cost_usd),0)::float AS usd, COALESCE(sum(failed_usd),0)::float AS failed, COALESCE(sum(billed_sec),0)::int AS sec, count(*)::int AS n FROM host_intros WHERE user_id=$1 AND created_at >= date_trunc('month', now())`, [owner.id]);
    cost = `<p class="hint">Custo interno (só o administrador o vê; estimativa a ~$${(await veoCostPerSec(db, tier)).toFixed(2)}/s da duração faturada, o custo da tarifa)${shown ? `: esta introdução ~$${Number(shown.cost_usd).toFixed(2)} (${shown.billed_sec} s faturados, ${shown.sent} envio(s) à Google${Number(shown.failed_usd) ? `, ~$${Number(shown.failed_usd).toFixed(2)} em operações falhadas na Google` : ''})` : ''}; este mês, ${m.n} pedido(s) deste entrevistador, ~$${m.usd.toFixed(2)} (${m.sec} s)${m.failed ? ` e ~$${m.failed.toFixed(2)} falhados` : ''}. Registado no usage_ledger como «veo_usd_intro».</p>`;
  }
  return `<div class="card" id="introducao"><h2 style="margin-top:0">Introdução animada (Google Veo), oferecida</h2>
<p class="hint">Nos vídeos com animação do Google Veo, logo a seguir ao aviso inicial de IA e antes do cartão de título, aparece a sua fotografia animada a dizer uma frase de boas-vindas, com o aviso visível «${esc(VEO_NOTICE)}». É gerada uma vez e reaproveitada em todas as suas entrevistas, enquanto a fotografia, a frase, a voz, o nível do Veo (${esc(veoLabel(tier))}) e o formato não mudarem. Não usa créditos nem entra no orçamento. A frase é genérica, em inglês e sem nomes (o Google Veo recusa nomes de pessoas reais): o seu nome aparece em texto, no rodapé. Exige a sua fotografia, o direito a usá-la e a autorização para o Google Veo (em «Dados gerais»).</p>
<form method="post" action="/entrevistas/${iv.id}/introducao"><fieldset style="border:1px solid var(--line);border-radius:8px"><legend class="sans">Frase (a mesma em todas as suas entrevistas)</legend>
<label class="check"><input type="radio" name="intro_phrase" value="" ${s.phrase ? '' : 'checked'}> Sem introdução animada</label>
${INTRO_PHRASES.map(p => `<label class="check"><input type="radio" name="intro_phrase" value="${p.id}" ${s.phrase?.id === p.id ? 'checked' : ''}> «${esc(p.text)}»</label>`).join('')}</fieldset>
<p class="sans">Estado: ${status}</p>
${s.ready ? `<video controls preload="metadata" src="/media/${s.ready.asset_id}" style="width:100%;max-width:480px;border-radius:10px;background:#000"></video>` : ''}
<div class="row"><button class="ghost" name="acao" value="guardar">Guardar a frase</button><button class="accent" name="acao" value="gerar" ${block || full || s.open ? 'disabled' : ''}>Gerar introdução</button></div>
<p class="hint">${block ? `<strong>${esc(block)}</strong> ` : ''}${isAdmin ? 'Pedida pelo administrador: sem limite e não conta para o limite do entrevistador.' : `Gerações este mês: ${s.used} de ${max}${full ? ' (limite atingido: volta no próximo mês)' : ''}.`} Cada geração tem no máximo 2 tentativas, verificadas palavra a palavra; se não ficar pronta, os vídeos seguem sem introdução e o motivo aparece aqui.</p>
${cost}</form></div>`;
}

/** Linha da introdução na página da produção (perto do vídeo). */
export async function introProductionHint(db: Db, iv: any): Promise<string> {
  const owner = await db.one('SELECT id, intro_phrase FROM users WHERE id=$1', [iv.owner_id]);
  if (!owner) return '';
  const tier = inEntity(await entityOfInterview(db, iv.id), () => veoTier());
  const s = await introState(db, iv, owner, tier);
  const where = `<a href="/entrevistas/${iv.id}/editar#introducao">Editar</a>`;
  const why = introBlock(iv);
  const text = !s.phrase ? `não escolhida (escolha a frase e gere-a em ${where})`
    : s.ready ? (why ? `pronta, mas não entra nesta entrevista: ${esc(why)}` : 'pronta: entra nos vídeos com animação do Google Veo, logo a seguir ao aviso inicial, sem créditos')
    : s.open ? `a ser gerada (${where})`
    : s.last?.status === 'failed' ? `falhou (${esc(s.last.error ?? '')}); os vídeos seguem sem ela (${where})`
    : `por gerar (em ${where})`;
  return `<p class="hint">Introdução animada do entrevistador (oferecida): ${text}.</p>`;
}

export async function introRoutes(app: FastifyInstance) {
  const db = app.db;
  app.post('/entrevistas/:id/introducao', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const iv = await ownedInterview(app, req, (req.params as any).id);
    if (!iv) return reply.code(404).send('Não encontrada');
    const b = (req.body ?? {}) as any;
    const back = (ok?: string, e?: string) => reply.redirect(`/entrevistas/${iv.id}/editar?${ok ? `ok=${encodeURIComponent(ok)}` : `e=${encodeURIComponent(e ?? '')}`}#introducao`);
    const phrase = introPhrase(b.intro_phrase);
    if (b.intro_phrase && !phrase) return back(undefined, 'Frase desconhecida: escolha uma das frases da lista.');
    // A frase é do entrevistador (dono da entrevista): vale para todas as entrevistas dele.
    await db.query('UPDATE users SET intro_phrase=$2 WHERE id=$1', [iv.owner_id, phrase?.id ?? null]);
    if (b.acao !== 'gerar') {
      await audit(db, req.user!.email, 'intro.phrase', iv.id, { phrase: phrase?.id ?? null });
      return back(phrase ? 'Frase da introdução guardada.' : 'Sem introdução animada nos seus vídeos.');
    }
    if (!phrase) return back(undefined, 'Escolha uma das frases antes de gerar a introdução.');
    const owner = await db.one('SELECT id, role, entity_id FROM users WHERE id=$1', [iv.owner_id]);
    const ent = await entityOfInterview(db, iv.id);
    const block = await generateBlock(db, iv, owner, req.user, ent);
    if (block) return back(undefined, block);
    const photo = await db.one('SELECT storage_key, sha256 FROM assets WHERE id=$1 AND deleted_at IS NULL', [iv.host_photo_asset_id]);
    if (!photo) return back(undefined, 'Para gerar a introdução, falta a fotografia do entrevistador (em «A minha fotografia»).');
    // A chave como no vídeo: fotografia original, frase, voz, nível do Veo (o da entidade, se tiver credenciais próprias) e formato.
    const st = await startImage(await storage.get(photo.storage_key));
    const tier = inEntity(ent, () => veoTier()), voice = iv.question_voice === 'male' ? 'male' : 'female';
    const key = introKeyOf({ photoSha: photo.sha256, phrase: phrase.text, voice, tier, vertical: st.vertical });
    const isAdmin = req.user!.role === 'admin', max = config.limits.introPerMonth;
    const r = await db.tx(async (tx): Promise<{ id?: string; e?: string }> => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner.id]); // o limite conta-se com o entrevistador bloqueado
      if (await readyIntro(tx, owner.id, key)) return { e: 'A introdução com esta frase já está pronta para esta fotografia, voz e nível do Veo: só se gera de novo se um destes mudar.' };
      if (await tx.one(`SELECT 1 FROM host_intros WHERE user_id=$1 AND intro_key=$2 AND status IN ('queued','running')`, [owner.id, key])) return { e: 'Esta introdução já está a ser gerada: aguarde que termine.' };
      if (!isAdmin && (await introsThisMonth(tx, owner.id)) >= max) return { e: `Atingiu o limite de ${max} gerações da introdução este mês: volta no próximo mês.` };
      const row = await tx.one(`INSERT INTO host_intros(user_id, interview_id, intro_key, phrase, photo_sha, voice, tier, vertical, counts, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [owner.id, iv.id, key, phrase.id, photo.sha256, voice, tier, st.vertical, !isAdmin, req.user!.id]);
      const jobId = await enqueue(tx, { kind: 'render_intro', interviewId: iv.id, input: { introId: row.id, requestedBy: req.user!.id }, dedupe: `intro:${row.id}` });
      await tx.query('UPDATE host_intros SET job_id=$2 WHERE id=$1', [row.id, jobId ?? null]);
      return { id: row.id };
    });
    if (r.e) return back(undefined, r.e);
    await audit(db, req.user!.email, 'intro.requested', iv.id, { introId: r.id, phrase: phrase.id, tier, admin: isAdmin });
    return back('Introdução pedida: fica pronta dentro de alguns minutos (sem créditos).');
  });
}
