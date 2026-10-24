import type { Db } from './db.ts';
import { config } from './config.ts';
import { esc, sha256, fmtDate, normMailbox } from './lib.ts';
import { ACTIVE_STATUSES, quotaFor } from './billing.ts';
import { enqueue, type EnqueueOpts } from './jobs.ts';
import { inviteLimits, mmss, FREE_PRODUCTION_JOBS, FREE_JOBS_FOR_SCRIPT } from './limits.ts';
import { lastVerificationAt, verifySent, VERIFY_TOTAL, VERIFY_PER_DAY, VERIFY_HOURS } from './email-verify.ts';
import { flash } from './views.ts';

/**
 * 1.ª entrevista grátis: oferta do quietinterview a quem se regista, para experimentar o produto sem pagar. Só para o
 * entrevistador sem entidade (as entidades têm faturação própria), sem subscrição ativa nem anterior (qualquer linha em
 * `subscriptions`: paga, oferta do administrador ou criada à mão), que nunca a usou e com o email da conta confirmado. Uma por
 * caixa de correio: o email da conta normalizado (como o do convidado) fica em `users.free_owner_hash` no envio, e outra conta
 * com o mesmo email normalizado (eve+1@gmail.com, e.v.e@gmail.com) já não a tem.
 * Tetos globais por dia e por mês (UTC), contados na base (`interviews.free_at`); 0 desliga a oferta. Cada convidado
 * (email normalizado) recebe no máximo uma em todo o portal, seja quem for que o convide (índice único na impressão).
 * Limites da entrevista: os do plano Start (tabela `plans`); regenerações incluídas como num plano, dentro do total de
 * trabalhos de produção (FREE_PRODUCTION_JOBS, escrito nos termos 2-C); a animação por IA continua por orçamento e com
 * créditos, e a introdução animada não é oferecida por ela (ver routes/intro.ts). A entrevista grátis não conta para a
 * quota de um plano subscrito depois (quotaFor exclui-a, como as extra).
 */
export type FreeReason = 'role' | 'entity' | 'subscribed' | 'used' | 'had_subscription' | 'off' | 'unverified' | 'cap_day' | 'cap_month' | 'guest_used';
export interface FreeState { eligible: boolean; reason: FreeReason | null; usedAt: Date | null; interviewId: string | null; verified: boolean }

/** Bloqueio consultivo das entrevistas grátis: serializa todos os pedidos (tetos globais, uma por caixa de correio e um convidado em todo o portal). */
const FREE_LOCK = 7710361;

/** A oferta está ligada (os dois tetos acima de 0). */
export const freeOfferOn = () => config.limits.freePerDay > 0 && config.limits.freePerMonth > 0;

/**
 * Email normalizado para as regras «uma por convidado» e «uma por caixa de correio» (o email da conta): a caixa de correio
 * de `normMailbox` (lib.ts), a mesma do total dos emails de confirmação por caixa (email-verify.ts).
 */
export const normGuestEmail = normMailbox;
/** Impressão guardada na entrevista grátis (o email em claro já está na entrevista; a impressão serve o índice único). */
export const guestHash = (email: string) => sha256(`free-guest:${normGuestEmail(email)}`);
/** Impressão do email da conta normalizado, guardada no envio (`users.free_owner_hash`): uma entrevista grátis por caixa de correio. */
export const ownerHash = (email: string) => sha256(`free-owner:${normGuestEmail(email)}`);

/** Limites da entrevista grátis: os do plano Start (mesmo inativo); sem ele, os gerais (como um convite sem plano). */
export async function freeLimits(db: Db) {
  const plan = await db.one(`SELECT max_questions, max_answer_total_sec FROM plans WHERE id='start'`);
  return inviteLimits({ exempt: false, plan: plan ?? null });
}

/** Entrevistas grátis enviadas hoje e neste mês (dias e meses em UTC), todas as contas juntas. */
export async function freeCounts(db: Db): Promise<{ day: number; month: number }> {
  const r = await db.one(`SELECT count(*) FILTER (WHERE free_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS day, count(*)::int AS month
    FROM interviews WHERE free_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`);
  return { day: Number(r?.day ?? 0), month: Number(r?.month ?? 0) };
}

/**
 * Elegibilidade (uma só função, pela ordem das razões): perfil, entidade, subscrição ativa, oferta já usada, subscrição
 * anterior, oferta desligada, email por confirmar, oferta já usada por outra conta com o mesmo email normalizado (`used`; só
 * depois do email confirmado, para nada se dizer sobre uma caixa de correio a quem ainda não provou que é dela), teto do
 * dia, teto do mês e, com `guestEmail`, o convidado que já recebeu uma entrevista grátis. Com `t` numa transação que tem o
 * bloqueio (claimFree), a contagem dos tetos é a definitiva.
 */
export async function freeInterviewFor(db: Db, user: { id: string }, opts: { guestEmail?: string } = {}): Promise<FreeState> {
  const u = await db.one(`SELECT u.email, u.role, u.entity_id, u.email_verified_at, u.free_interview_at, u.free_interview_id, s.status AS sub_status, (s.id IS NOT NULL) AS had_sub
    FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id WHERE u.id=$1`, [user.id]);
  const base = { usedAt: u?.free_interview_at ? new Date(u.free_interview_at) : null, interviewId: u?.free_interview_id ?? null, verified: !!u?.email_verified_at };
  const no = (reason: FreeReason): FreeState => ({ eligible: false, reason, ...base });
  if (!u || u.role !== 'interviewer') return no('role');
  if (u.entity_id) return no('entity');
  if (u.sub_status && ACTIVE_STATUSES.includes(u.sub_status)) return no('subscribed');
  if (u.free_interview_at) return no('used');
  if (u.had_sub) return no('had_subscription');
  if (!freeOfferOn()) return no('off');
  if (!u.email_verified_at) return no('unverified');
  if (await db.one('SELECT 1 FROM users WHERE free_owner_hash=$1 AND id<>$2', [ownerHash(u.email), user.id])) return no('used');
  const c = await freeCounts(db);
  if (c.day >= config.limits.freePerDay) return no('cap_day');
  if (c.month >= config.limits.freePerMonth) return no('cap_month');
  if (opts.guestEmail !== undefined && await db.one('SELECT 1 FROM interviews WHERE free_guest_hash=$1', [guestHash(opts.guestEmail)])) return no('guest_used');
  return { eligible: true, reason: null, ...base };
}

/**
 * Marca o envio grátis dentro da transação `t`: com o bloqueio das entrevistas grátis, o titular e a entrevista bloqueados,
 * a elegibilidade (tetos e convidado incluídos) volta a contar-se e a entrevista passa a convidada, grátis e com os limites
 * do Start, e a conta fica com a oferta usada e a impressão da caixa de correio, tudo de uma vez. Dois pedidos em simultâneo
 * (dois separadores, duas contas a convidar a mesma pessoa, a última vaga do teto) nunca passam os dois. Devolve a entrevista
 * como ficou gravada, lida com o bloqueio: o convite (email) envia-se depois, fora desta transação, a partir dela e nunca de
 * uma leitura anterior (um «Guardar» pelo meio mudaria o convidado: o email sairia para um e a marca ficaria com outro);
 * depois de convidada, o «Guardar» já não muda o convidado. Se o envio falhar, releaseFree desfaz.
 */
export async function claimFree(t: Db, userId: string, interviewId: string): Promise<{ ok: true; limits: ReturnType<typeof inviteLimits>; interview: any } | { ok: false; reason: FreeReason | 'done' }> {
  await t.query('SELECT pg_advisory_xact_lock($1)', [FREE_LOCK]);
  const owner = await t.one('SELECT email FROM users WHERE id=$1 FOR UPDATE', [userId]);
  const cur = await t.one('SELECT collection_status, guest_email FROM interviews WHERE id=$1 FOR UPDATE', [interviewId]);
  if (!owner || cur?.collection_status !== 'draft') return { ok: false, reason: 'done' };
  const f = await freeInterviewFor(t, { id: userId }, { guestEmail: cur.guest_email });
  if (!f.eligible) return { ok: false, reason: f.reason! };
  const limits = await freeLimits(t);
  const interview = await t.one(`UPDATE interviews SET collection_status='invited', invited_at=now(), answer_limit_sec=$2, question_limit=$3, free_at=now(), free_guest_hash=$4 WHERE id=$1 RETURNING *`,
    [interviewId, limits.answerLimitSec, limits.questionLimit, guestHash(cur.guest_email)]);
  await t.query('UPDATE users SET free_interview_at=now(), free_interview_id=$2, free_owner_hash=$3 WHERE id=$1', [userId, interviewId, ownerHash(owner.email)]);
  return { ok: true, limits, interview };
}

/** O convite não saiu: a entrevista volta a rascunho (sem a marca nem os limites), o link criado é revogado e a oferta fica por usar (também para a caixa de correio). */
export async function releaseFree(db: Db, userId: string, interviewId: string) {
  await db.tx(async t => {
    await t.query(`UPDATE interviews SET collection_status='draft', invited_at=NULL, answer_limit_sec=NULL, question_limit=NULL, free_at=NULL, free_guest_hash=NULL
      WHERE id=$1 AND collection_status='invited' AND free_at IS NOT NULL`, [interviewId]);
    await t.query('UPDATE invitations SET revoked_at=now() WHERE interview_id=$1 AND revoked_at IS NULL', [interviewId]);
    await t.query('UPDATE users SET free_interview_at=NULL, free_interview_id=NULL, free_owner_hash=NULL WHERE id=$1 AND free_interview_id=$2', [userId, interviewId]);
  });
}

/** «Reenviar convite» numa entrevista grátis: no máximo este número de links novos depois do primeiro convite. */
export const FREE_RESENDS = 3;

/**
 * Razão para a entrevista grátis não mandar mais nada ao convidado por ação do entrevistador (null = pode), em português:
 * o convidado recusou um convite dela («Reenviar convite» e perguntas adicionais deixam de sair), ou, com `resend`, o
 * convite já teve FREE_RESENDS reenvios. Contado na tabela `invitations` (sem os links de validação do episódio): reenvios
 * são os links novos com a mesma versão das perguntas que um anterior (o primeiro convite e o de cada pergunta adicional
 * trazem uma versão nova); contam também os que o próprio convidado pede com «novo link», que têm o mesmo total (guard do
 * POST /i/:token/novo-link; antes, o «novo link» contava só contra o entrevistador e não verificava o total). Sem isto, uma
 * conta grátis, sem pagamento, mandava ao mesmo convidado um email a cada RESEND_COOLDOWN_SEC, mesmo depois de ele recusar.
 * As entrevistas pagas continuam como antes (só o intervalo entre reenvios).
 */
export async function freeSendBlock(q: Db, interviewId: string, o: { resend?: boolean } = {}): Promise<string | null> {
  const r = await q.one(`SELECT count(*) FILTER (WHERE declined_at IS NOT NULL)::int AS declined, (count(*) - count(DISTINCT question_version))::int AS resent
    FROM invitations WHERE interview_id=$1 AND purpose<>'preview'`, [interviewId]);
  if (Number(r?.declined ?? 0) > 0) return 'O entrevistado recusou o convite: a 1.ª entrevista grátis não lhe envia mais nada (nem reenvios, nem perguntas adicionais).';
  if (o.resend && Number(r?.resent ?? 0) >= FREE_RESENDS) return `Este convite já foi reenviado ${FREE_RESENDS} vezes (contam também os links novos pedidos pelo entrevistado): a 1.ª entrevista grátis não permite mais reenvios.`;
  return null;
}

/**
 * Ações de IA opcionais e sem custo para o utilizador numa entrevista grátis: total por entrevista, contado na base (tabela
 * `ai_uses`). Antes, a verificação do guião (gpt-4.1 a cada clique) só tinha o limite por hora em memória, e uma conta sem
 * pagamento repetia-a sem fim; e a leitura sintética das perguntas ao convidado refazia-se a cada mudança da voz das
 * perguntas, que o entrevistador pode alternar depois do convite. As outras ações de IA da produção (processar, regenerar
 * o guião, verificá-lo e gerar o episódio) só correm depois da submissão do convidado e com a autorização de processamento
 * dele (routes/production.ts; antes, regenerar e verificar o guião aceitavam um rascunho nunca enviado, de qualquer conta,
 * também sem pagamento, sem total por conta: a 3.ª revisão dizia ter procurado todas as rotas e não o viu); processar (o
 * primeiro está incluído), regenerar o guião e gerar o episódio contam como regenerações (3 incluídas, depois 1 crédito
 * cada) e, na entrevista grátis, para o total FREE_PRODUCTION_JOBS (uma regeneração que falha deixa de contar como
 * regeneração, mas conta para esse total); a animação pelo Google Veo paga-se por orçamento; a introdução animada não é
 * oferecida à entrevista grátis; os retratos animados são só do administrador; as sugestões do assistente de composição e
 * a resposta redigida pela IA na ajuda exigem uma subscrição. A vez gasta só volta quando a OpenAI não respondeu
 * (aiNotAnswered, em ai/openai.ts). As entrevistas pagas ficam como estavam (decisão: quem paga está identificado pelo
 * pagamento, tem a quota do plano e os limites por hora; o total serve a oferta sem pagamento). O administrador não conta
 * nem fica bloqueado (como nas regenerações). A entrevista grátis mantém estes totais mesmo que a conta subscreva depois
 * (como os limites do Start, ficam com ela).
 */
export const FREE_SCRIPT_REVIEWS = 6;
/** Leituras sintéticas das perguntas ao convidado, por pergunta (uma para cada voz); a leitura guardada reaproveita-se sem contar. */
export const FREE_READINGS_PER_QUESTION = 2;
export type AiAction = 'script_review' | 'question_reading';
export const FREE_REVIEWS_USED = `A 1.ª entrevista grátis inclui ${FREE_SCRIPT_REVIEWS} verificações de fidelidade por IA e já as usou todas: pode continuar a rever o guião à mão e aprová-lo. Com uma subscrição (Conta), as próximas entrevistas não têm este limite.`;

/** Gasta uma vez da ação na entrevista, se ainda houver (atómico: dois pedidos em simultâneo na última vez não passam os dois). */
export async function takeAiUse(db: Db, interviewId: string, action: AiAction, max: number): Promise<boolean> {
  if (!(max >= 1)) return false;
  return !!(await db.one(`INSERT INTO ai_uses(interview_id, action, used) VALUES ($1,$2,1)
    ON CONFLICT (interview_id, action) DO UPDATE SET used = ai_uses.used + 1 WHERE ai_uses.used < $3 RETURNING used`, [interviewId, action, max]));
}
/** A ação falhou sem resposta do fornecedor de IA (nada foi feito nem pago; ver aiNotAnswered): a vez volta. */
export const giveBackAiUse = (db: Db, interviewId: string, action: AiAction) =>
  db.query('UPDATE ai_uses SET used = used - 1 WHERE interview_id=$1 AND action=$2 AND used > 0', [interviewId, action]);
/** Vezes que a ação já foi usada na entrevista. */
export async function aiUsed(db: Db, interviewId: string, action: AiAction): Promise<number> {
  return Number((await db.one('SELECT used FROM ai_uses WHERE interview_id=$1 AND action=$2', [interviewId, action]))?.used ?? 0);
}

/**
 * 1.ª entrevista grátis: trabalhos de produção por entrevista (processar, regenerar o guião e gerar o episódio, também cada
 * «Tentar de novo»), contados quando entram na fila e sem devolução quando falham. Antes, só contavam as regenerações que
 * não falharam, «Tentar de novo» depois de uma geração falhada não contava enquanto não houvesse episódio e o crédito de
 * uma regeneração paga voltava: uma falha tardia (depois de pagas a voz, os tempos das legendas, as traduções e a capa, ou
 * o guião do gpt-4.1), provocada de propósito, repetia o trabalho pago sem fim e sem contar (no teste do revisor, com uma
 * fotografia de capa forjada, 7 gerações do episódio e 21 tentativas, 0 regenerações e 0 créditos). Com este total, a
 * próxima falha tardia por descobrir também pára. As regenerações pagas com 1 crédito só contam se falharem (o crédito
 * volta); as que terminam foram pagas. Os trabalhos do administrador não contam e ele não fica bloqueado. Uso normal: 1
 * processamento, 1 episódio e as 3 regenerações incluídas (5); ficam 3 para tentar de novo depois de falhas. Acima, nada
 * entra na fila, pago ou não, e a recusa vem antes de qualquer pagamento (não convida a carregar créditos). Um guião novo
 * (processar ou regenerar o guião) precisa de FREE_JOBS_FOR_SCRIPT por usar — o dele e o do episódio —, também pago (se
 * falhar, conta): com menos, processar, «Regenerar guião», «Recomeçar», «Guardar nova revisão» de uma transcrição e, quando
 * já há um guião ou um episódio, «Pedido adicional» (a nova revisão e a resposta do entrevistado à pergunta adicional
 * desatualizam o guião e o episódio) ficam recusados, para um episódio pronto não deixar de se poder publicar. Antes da 7.ª
 * revisão, o «Pedido adicional» não olhava para o total: a 7 de 8, a resposta do entrevistado punha o episódio pronto como
 * desatualizado, e nada o refazia. Fica um caso: um pedido adicional enviado com 2 ou mais por usar e respondido depois de o
 * entrevistador gastar outros (ver docs/estado.md). Saída para quem esgota o total de boa-fé (por exemplo, com falhas do
 * fornecedor): a Ajuda, onde a equipa responde; o administrador produz na entrevista sem contar nem ficar bloqueado.
 * Custo (pelos preços da configuração, PRICE_*, que são estimativas): cada trabalho tem até 3 tentativas e, numa falha
 * tardia, cada tentativa paga outra vez os tempos das legendas (whisper por segmento), as traduções e a capa (resumo e
 * imagem); só a voz fica em cache (por texto). Com o guião no máximo (SCRIPT_TOTAL_MAX, 60 000 caracteres), uma geração
 * custa ~0,9 USD de voz e ~1,1 USD por tentativa (whisper ~0,4, 4 traduções ~0,65, capa ~0,04): ~4,1 USD com 3 tentativas.
 * No pior caso (1 processamento e 7 gerações, cada uma com um guião diferente e as 3 tentativas a falhar no fim), cerca de
 * 30 USD por entrevista grátis, ~1 800 USD por mês no teto de 60. Uso normal (5 trabalhos sem falhas, ~36 000 caracteres):
 * ~5 USD. Número escolhido sem dados de uso.
 */
/** FREE_JOBS_FOR_SCRIPT: trabalhos de produção por usar de que um guião novo precisa (o dele e o da geração do episódio); os dois números ficam em limits.ts, para os termos e a FAQ. */
export { FREE_PRODUCTION_JOBS, FREE_JOBS_FOR_SCRIPT };
const HELP_HTML = '<a href="/ajuda">Ajuda</a>', ACCOUNT_HTML = '<a href="/account">Conta</a>';
const JOBS_WHAT = `${FREE_PRODUCTION_JOBS} trabalhos de produção (processar, regenerar o guião e gerar o episódio, contando os que falharam e cada «Tentar de novo»)`;
/**
 * Recusa pelo total esgotado e aviso vermelho da página da produção quando não há episódio que se possa aprovar e publicar
 * (com um, o aviso é neutro: freeJobsDoneHtml).
 */
const jobsUsed = (help: string, account: string) => `A 1.ª entrevista grátis inclui ${JOBS_WHAT} e já os usou todos: nesta entrevista não há mais regenerações, nem pagas com créditos, nem pedidos adicionais (a resposta do entrevistado desatualiza o guião e o episódio). Para a concluir, peça ajuda à equipa do portal em ${help}: a equipa pode terminar a produção desta entrevista. Com uma subscrição (${account}), as próximas entrevistas não têm este limite.`;
export const FREE_JOBS_USED = jobsUsed('«Ajuda»', 'Conta');
/** O mesmo, com as ligações (aviso da página da produção e recusa do «Pedido adicional» na edição). */
export const FREE_JOBS_USED_HTML = jobsUsed(HELP_HTML, ACCOUNT_HTML);
/**
 * Total esgotado com um episódio que se aprova e publica como sempre (atual, sem alertas da qualidade nem a capa retirada),
 * já publicado ou a ser gerado pelo último trabalho: aviso neutro. Antes, a página dizia a vermelho que era preciso a equipa
 * para concluir a entrevista, também quando o 8.º trabalho gerava o episódio e depois de o administrador concluir a produção
 * (a saída prometida), com «Aprovar», «Enviar pré-visualização» e «Publicar» ativos: pedidos de ajuda sem razão.
 */
export const freeJobsDoneHtml = (ep: 'running' | 'preview' | 'published') => `A 1.ª entrevista grátis inclui ${JOBS_WHAT} e já os usou todos. ${ep === 'published' ? 'O episódio continua publicado.'
  : `${ep === 'running' ? 'O último está em curso: quando o episódio ficar pronto,' : 'O episódio atual não muda:'} pode aprová-lo, enviar a pré-visualização ao entrevistado (quando ele aprova a versão final) e publicá-lo, como sempre.`} Nesta entrevista não há mais regenerações, nem pagas com créditos, nem pedidos adicionais: para alterar o guião ou o episódio, peça ajuda à equipa do portal em ${HELP_HTML}. Com uma subscrição (${ACCOUNT_HTML}), as próximas entrevistas não têm este limite.`;
/** Recusa com 1 trabalho por usar e aviso neutro da página da produção quando há um guião aprovado (ou por aprovar) para gerar o episódio. */
const jobsLow = (help: string) => `Na 1.ª entrevista grátis resta 1 dos ${FREE_PRODUCTION_JOBS} trabalhos de produção: chega para gerar o episódio de um guião aprovado, mas não para fazer um guião novo e depois o episódio. Por isso, processar de novo, «Regenerar guião», «Recomeçar», «Guardar nova revisão» das transcrições e «Pedido adicional» (a nova revisão e a resposta do entrevistado obrigam a refazer o guião e o episódio) não estão disponíveis. Se precisar, peça ajuda à equipa do portal em ${help}: a equipa pode terminar a produção desta entrevista.`;
export const FREE_JOBS_LOW = jobsLow('«Ajuda»');
export const FREE_JOBS_LOW_HTML = jobsLow(HELP_HTML);
/**
 * 1 trabalho por usar sem um guião aprovado (nem por aprovar) para gerar o episódio — por exemplo, com 7 processamentos
 * falhados ou o guião desatualizado: aviso vermelho. Antes, a página dizia sempre que o trabalho que restava chegava para
 * gerar o episódio de um guião aprovado, também sem nenhum guião, e com o estilo neutro.
 */
export const FREE_JOBS_LOW_NO_SCRIPT_HTML = `Na 1.ª entrevista grátis resta 1 dos ${FREE_PRODUCTION_JOBS} trabalhos de produção e esta entrevista não tem um guião aprovado: fazer um guião novo e depois o episódio precisa de ${FREE_JOBS_FOR_SCRIPT}, e o trabalho que resta só serve para gerar o episódio de um guião aprovado. Por isso, processar de novo, «Regenerar guião», «Recomeçar», «Guardar nova revisão» das transcrições e «Pedido adicional» não estão disponíveis. Para a concluir, peça ajuda à equipa do portal em ${HELP_HTML}: a equipa pode terminar a produção desta entrevista.`;
/**
 * O total de trabalhos de produção, com a ligação ao ponto 2-C dos termos, onde a entrevista grátis se pede (caixas da
 * oferta no painel, na página do convite e na Conta, e a linha «Limites da entrevista» do convite grátis). Antes, só os
 * termos e a FAQ o diziam: a condição não aparecia antes do envio.
 */
export const FREE_JOBS_PT = `até ${FREE_PRODUCTION_JOBS} trabalhos de produção (contam os que falham e cada «Tentar de novo»; ver os <a href="/termos#entrevista-gratis">termos</a>)`;
/** Recusa por falta de trabalhos de produção na entrevista grátis (null = pode), para uma ação que precisa de `need` por usar. */
export const freeJobsBlock = (used: number | null, need: number): string | null =>
  used == null ? null : used >= FREE_PRODUCTION_JOBS ? FREE_JOBS_USED : FREE_PRODUCTION_JOBS - used < need ? FREE_JOBS_LOW : null;
/** Uma recusa (de freeJobsBlock ou outra, em texto) para desenhar numa página: as de freeJobsBlock com as ligações. */
export const freeJobsBlockHtml = (msg: string) => msg === FREE_JOBS_USED ? FREE_JOBS_USED_HTML : msg === FREE_JOBS_LOW ? FREE_JOBS_LOW_HTML : esc(msg);
/** Trabalhos de produção que contam para FREE_PRODUCTION_JOBS na entrevista (ver acima). */
export async function freeProductionJobs(q: Db, interviewId: string): Promise<number> {
  return Number((await q.one(`SELECT count(*)::int AS n FROM jobs WHERE interview_id=$1 AND kind IN ('process_submission','prepare_script','generate_episode')
    AND input->>'admin' IS NULL AND (input->>'paidCents' IS NULL OR state='failed')`, [interviewId]))?.n ?? 0);
}

/**
 * Contas sem pagamento (entrevistador sem entidade e sem subscrição em vigor: as da 1.ª entrevista grátis e as de quem deixou
 * de pagar): transcrições automáticas das gravações do entrevistador no rascunho (objetivo, e perguntas sem texto) nas
 * últimas 24 horas, contadas na fila de trabalhos com a conta bloqueada. Antes, só o limite de envios por minuto em memória:
 * uma conta sem pagamento podia criar rascunhos e perguntas sem fim e mandar transcrever cada gravação (até 2 min por
 * pergunta e 5 min no objetivo). Acima do total, a gravação é recusada com a explicação (com texto, uma pergunta gravada não
 * é transcrita). As contas pagas, de entidade, os gestores e o administrador não mudam.
 */
export const UNPAID_TRANSCRIPTIONS_PER_DAY = 40;
export async function unpaidAccount(db: Db, user: { id: string; role: string; entity_id?: string | null }): Promise<boolean> {
  if (user.role !== 'interviewer' || user.entity_id) return false;
  const q = await quotaFor(db, user);
  return q.reason === 'no_subscription' || q.reason === 'expired';
}
async function hostTranscriptions(db: Db, userId: string): Promise<number> {
  return Number((await db.one(`SELECT count(*)::int AS n FROM jobs j JOIN interviews i ON i.id=j.interview_id
    WHERE i.owner_id=$1 AND j.kind='transcribe_asset' AND j.created_at > now() - interval '1 day'`, [userId]))?.n ?? 0);
}
/** Ainda há transcrições automáticas para a conta nas últimas 24 horas (sem as gastar; a contagem definitiva é a de enqueueHostTranscription). */
export async function transcriptionRoom(db: Db, user: { id: string; role: string; entity_id?: string | null }): Promise<boolean> {
  return !(await unpaidAccount(db, user)) || (await hostTranscriptions(db, user.id)) < UNPAID_TRANSCRIPTIONS_PER_DAY;
}
/** Põe na fila a transcrição de uma gravação do entrevistador; numa conta sem pagamento, só dentro do total (false: nada na fila). */
export async function enqueueHostTranscription(db: Db, user: { id: string; role: string; entity_id?: string | null }, job: EnqueueOpts): Promise<boolean> {
  if (!(await unpaidAccount(db, user))) { await enqueue(db, job); return true; }
  return db.tx(async t => {
    await t.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    if ((await hostTranscriptions(t, user.id)) >= UNPAID_TRANSCRIPTIONS_PER_DAY) return false;
    await enqueue(t, job);
    return true;
  });
}
export const transcriptionsUsed = (what: 'question' | 'objective') => `Atingiu o limite de ${UNPAID_TRANSCRIPTIONS_PER_DAY} transcrições automáticas em 24 horas das contas sem subscrição. ${what === 'question' ? 'Escreva o texto da pergunta antes de a gravar (com texto, a gravação não é transcrita) ou grave-a mais tarde' : 'Grave o objetivo mais tarde ou escreva-o no campo «Objetivo»'}; com uma subscrição (Conta), não há este limite.`;

/** Estado da oferta numa conta, para o administrador. */
export const FREE_REASON_PT: Record<FreeReason, string> = {
  role: 'não se aplica (perfil)', entity: 'não se aplica (conta de uma entidade)', subscribed: 'não se aplica (subscrição ativa)', used: 'já usada por outra conta com o mesmo email (normalizado)',
  had_subscription: 'não se aplica (já teve subscrição)', off: 'oferta desligada (teto a 0)', unverified: 'à espera da confirmação do email',
  cap_day: 'teto do dia atingido', cap_month: 'teto do mês atingido', guest_used: 'convidado com entrevista grátis',
};

/** Recusa do envio grátis (POST do convite), em português; null quando a razão não é da oferta (fica a mensagem da subscrição). */
export function freeRefusal(reason: FreeReason | 'done' | null): string | null {
  switch (reason) {
    case 'unverified': return 'Para enviar a 1.ª entrevista grátis, confirme primeiro o email da sua conta (use «Reenviar» se não recebeu a ligação). Também pode enviar o convite com uma subscrição ativa (Conta).';
    case 'used': return 'Já usou a sua entrevista grátis. Para enviar mais convites, precisa de uma subscrição ativa (Conta).';
    case 'cap_day': case 'cap_month': return 'A oferta da 1.ª entrevista grátis está temporariamente indisponível. Pode tentar mais tarde ou enviar o convite com uma subscrição ativa (Conta).';
    case 'guest_used': return 'A entrevista grátis não está disponível para este entrevistado. Pode enviar o convite com uma subscrição ativa (Conta).';
    case 'subscribed': return 'A sua conta tem agora uma subscrição ativa: carregue de novo em «Enviar convite».';
    default: return null;
  }
}

/**
 * Confirmação do email por fazer: a última ligação enviada a esta conta (`sent`), se a caixa de correio ainda pode receber
 * emails de confirmação (`more`: VERIFY_TOTAL, na conta ou na caixa), se só daqui a umas horas (`later`: VERIFY_PER_DAY em 24
 * horas) e se ainda é possível confirmar (`canConfirm`: há mais emails ou a última ligação ainda vale).
 */
interface UnverifiedState { sent: Date | null; more: boolean; later: boolean; canConfirm: boolean }

const T = {
  pt: {
    limits: (l: ReturnType<typeof inviteLimits>) => `com os limites do plano Start (até ${l.questionLimit} perguntas, incluindo as adicionais, e até ${mmss(l.answerLimitSec!)} min de respostas do entrevistado) e ${FREE_JOBS_PT}`,
    eligible: (l: ReturnType<typeof inviteLimits>, where: 'painel' | 'convite') => `<strong>A sua 1.ª entrevista é grátis.</strong> ${where === 'convite' ? 'Este convite segue' : 'Envie o primeiro convite'} sem pagamento nem dados de cartão, ${T.pt.limits(l)}. É uma por pessoa e por organização${where === 'painel' ? ': crie a entrevista e, em «Rever e convidar», carregue em «Enviar convite grátis»' : ''}.`,
    unverified: (email: string, s: UnverifiedState) => `${s.canConfirm ? '<strong>A sua 1.ª entrevista é grátis</strong>, depois de confirmar o email da sua conta.' : '<strong>A 1.ª entrevista grátis exige o email da conta confirmado.</strong>'} ${s.sent ? `Enviámos uma ligação para ${esc(email)} em ${esc(fmtDate(s.sent))} (válida 48 horas).`
      : !s.more ? 'Não é possível enviar mais emails de confirmação para o email desta conta.' : s.later ? `Ainda não foi possível enviar a ligação para ${esc(email)}. Pode pedir uma ligação mais tarde.` : `Ainda não foi possível enviar a ligação para ${esc(email)}: carregue em «Reenviar».`}`,
    resend: 'Reenviar',
    noMore: `Já enviámos para o email desta conta o número máximo de ligações de confirmação (${VERIFY_TOTAL}): não é possível pedir outra.`,
    plans: 'Para enviar convites, escolha um plano em <a href="/account">Conta</a>.',
    used: (at: Date | null) => `Já usou a sua entrevista grátis${at ? ` (enviada em ${esc(fmtDate(at))})` : ''}. Para enviar mais convites, escolha um plano em <a href="/account">Conta</a>.`,
    cap: 'A oferta da 1.ª entrevista grátis está temporariamente indisponível. Pode tentar mais tarde ou escolher um plano em <a href="/account">Conta</a>.',
  },
  en: {
    limits: (l: ReturnType<typeof inviteLimits>) => `with the Start plan limits (up to ${l.questionLimit} questions, additional ones included, and ${mmss(l.answerLimitSec!)} min of answers) and up to ${FREE_PRODUCTION_JOBS} production jobs (failed ones and each «Tentar de novo», Try again, count; see the <a href="/termos#entrevista-gratis">terms</a>)`,
    eligible: (l: ReturnType<typeof inviteLimits>) => `<strong>Your first interview is free.</strong> Send your first invitation with no payment and no card details, ${T.en.limits(l)}: create it on the dashboard (Painel) and press «Enviar convite grátis» (Send free invitation). One per person and organisation.`,
    unverified: (email: string, s: UnverifiedState) => `${s.canConfirm ? '<strong>Your first interview is free</strong> once you confirm your account’s email.' : '<strong>The free first interview needs a confirmed account email.</strong>'} ${s.sent ? `We sent a link to ${esc(email)} on ${esc(fmtDate(s.sent))} (valid for 48 hours).`
      : !s.more ? 'No more confirmation emails can be sent to this account’s email address.' : s.later ? `We could not send the link to ${esc(email)} yet. You can ask for a link later.` : `We could not send the link to ${esc(email)} yet: press «Resend».`}`,
    resend: 'Resend',
    noMore: `We have already sent the maximum number of confirmation links (${VERIFY_TOTAL}) to this account’s email address, so no more can be requested.`,
    plans: 'To send invitations, choose a plan below.',
    used: (at: Date | null) => `You have used your free interview${at ? ` (sent on ${esc(fmtDate(at))})` : ''}. To send more invitations, choose a plan below.`,
    cap: 'The free first interview offer is temporarily unavailable. You can try again later or choose a plan below.',
  },
};

/** Resposta do «Reenviar» e da confirmação do email: parâmetros próprios do endereço (`gok`, `ge`), desenhados junto da caixa da oferta. */
export interface FreeMsg { ok?: string; e?: string }
export const freeMsg = (q: any): FreeMsg => ({ ok: typeof q?.gok === 'string' ? q.gok : undefined, e: typeof q?.ge === 'string' ? q.ge : undefined });
/** Endereço de volta com a resposta para junto da caixa da oferta (#gratis). */
export const freeMsgUrl = (back: string, kind: 'ok' | 'e', msg: string) => `${back}?g${kind}=${encodeURIComponent(msg)}#gratis`;

/**
 * Aviso do estado da oferta (painel e página do convite em português; Conta em inglês): disponível, falta confirmar o email
 * (com «Reenviar»), usada ou indisponível por teto (texto neutro). Vazio quando a oferta não se aplica à conta (ou `f` null).
 * `back`: a página para onde «Reenviar» volta. `msg`: a resposta do «Reenviar» e da confirmação do email (freeMsg), logo
 * acima da caixa e dentro da âncora `#gratis`, para onde as duas voltam: antes, a página saltava para a caixa e a resposta,
 * desenhada com os outros avisos no topo, ficava acima do ecrã. Sem caixa, a resposta fica sozinha no lugar dela. Os outros
 * avisos da página (`ok`, `e`) não mudam.
 */
export async function freeNotice(db: Db, f: FreeState | null, user: { id: string; email: string }, o: { lang: 'pt' | 'en'; where?: 'painel' | 'convite'; back: string; msg?: FreeMsg }): Promise<string> {
  const m = `${flash(o.msg?.ok)}${flash(o.msg?.e, 'bad')}`;
  const inner = f ? await freeBox(db, f, user, o) : '';
  return m || inner ? `<div id="gratis">${m}${inner}</div>` : '';
}

async function freeBox(db: Db, f: FreeState, user: { id: string; email: string }, o: { lang: 'pt' | 'en'; where?: 'painel' | 'convite'; back: string }): Promise<string> {
  const d = T[o.lang];
  const box = (inner: string, kind = '') => `<div class="flash${kind ? ` ${kind}` : ''}">${inner}</div>`;
  if (f.eligible) return box(o.lang === 'pt' ? T.pt.eligible(await freeLimits(db), o.where ?? 'painel') : T.en.eligible(await freeLimits(db)), 'ok');
  switch (f.reason) {
    // Sem «Reenviar» quando já não há mais emails de confirmação para esta conta (VERIFY_TOTAL, na conta ou na caixa de correio).
    // A conta que nunca recebeu uma ligação, com a caixa de correio sem mais emails (gastos por outras contas com o mesmo email
    // normalizado) ou no limite de 24 horas, não lê «carregue em Reenviar» sem o botão, nem um botão que recusa até ao dia
    // seguinte; e nada se diz sobre outras contas. Sem maneira de confirmar, o título já não promete a entrevista grátis.
    case 'unverified': {
      const sent = await lastVerificationAt(db, user.id), n = await verifySent(db, user);
      const more = n.total < VERIFY_TOTAL, later = more && n.day >= VERIFY_PER_DAY;
      const live = !!sent && Date.now() - sent.getTime() < VERIFY_HOURS * 3600_000;
      const s: UnverifiedState = { sent, more, later, canConfirm: more || live };
      const action = !more ? `${sent ? `<p style="margin:8px 0 0">${d.noMore}</p>` : ''}${live ? '' : `<p style="margin:8px 0 0">${d.plans}</p>`}`
        : later && !sent ? '' : `<form method="post" action="/confirmar-email/reenviar" style="margin-top:8px"><input type="hidden" name="voltar" value="${esc(o.back)}"><button class="ghost" style="padding:6px 14px;min-height:0">${d.resend}</button></form>`;
      return box(`${d.unverified(user.email, s)}
${action}`);
    }
    case 'used': return box(d.used(f.usedAt));
    case 'cap_day': case 'cap_month': return box(d.cap);
    default: return '';
  }
}
