import type { FastifyInstance } from 'fastify';
import { usablePhotoSql } from '../guest-photos.ts';
import { esc, fmtDate } from '../lib.ts';
import { page, flash, pill } from '../views.ts';
import { requireUser, ownedInterview, audit } from '../app.ts';
import { enqueue, videoQueue } from '../jobs.ts';
import type { Db } from '../db.ts';
import { inEntity } from '../settings.ts';
import { seller, complaintsLink, TERMS_VERSION, WITHDRAWAL_DAYS } from '../legal.ts';
import { findWallet, spendBlock, cr } from '../wallet.ts';
import { VEO_NOTICE, veoWithoutQuote } from '../veo-episode.ts';
import { VIDEO_PREMIUM } from '../video-offer.ts';
import { quoteTier, createQuote, acceptQuote, cancelQuote, quoteProblem, quoteBlock, rateForTier, candidateFalas, consumerVatRate, vatRegimeOf, isConsumerOwner,
  priceLabel, perMinuteLabel, acceptLabel, roleLabel, reasonLabel, GUARANTEES, QUOTE_STATUS, QuoteError, START_DEADLINE_HOURS, ENTITY_VEO_NO_QUOTE } from '../quotes.ts';
import { helpNav } from '../support.ts';

const excerpt = (t: string, n = 90) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
/** Posição na via dos vídeos, para o prazo do orçamento (por aceitar: o que está na fila agora; aceite: o que está à frente). */
export const queueLabel = (f: { ahead: number; minutes: number; running: boolean }, draft: boolean) =>
  f.running ? 'a produção já começou'
  : !f.ahead ? (draft ? 'a fila de vídeos está livre: começa logo a seguir à aceitação' : 'é o próximo vídeo da fila')
  : `${draft ? 'se aceitar agora, fica' : 'está'} na fila com ${f.ahead} vídeo(s) à frente (~${f.minutes} min de espera)`;
const consent = async (db: Db, id: string, p: string) => !!(await db.one(`SELECT granted FROM consents WHERE interview_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`, [id, p]))?.granted;

/**
 * Secção «Animação por orçamento» da página de produção: para o titular que não é administrador (ou para o administrador,
 * que só prepara o rascunho do cliente). Lista os orçamentos do episódio e o formulário das falas a animar.
 */
/**
 * Tabela de referência: créditos máximos do vídeo premium pela duração do vídeo (fala ≈ toda a duração, menos ~8 s de
 * cartões; cada fala conta pelo menos 4 s). É o máximo: paga-se só o que sai animado e verificado.
 */
export const VIDEO_MINUTES = [1, 3, 5, 10, 15]; // os episódios têm no máximo ~15 min de respostas
export const creditsForVideoMin = (min: number, centsPerMin: number) => Math.ceil((min * centsPerMin) / 100);
export const creditTable = (centsPerMin: number) => `<details><summary class="sans">Tabela de créditos por duração do vídeo</summary><table class="sans" style="max-width:360px"><thead><tr><th>Vídeo</th><th>Até</th></tr></thead><tbody>${VIDEO_MINUTES.map(m => `<tr><td>${m} min</td><td>${creditsForVideoMin(m, centsPerMin)} créditos</td></tr>`).join('')}</tbody></table><p class="hint">1 crédito = 1 € sem IVA. Valores máximos: paga só as falas animadas e verificadas.</p></details>`;

export async function quoteSection(db: Db, iv: any, ep: any): Promise<string> {
  const owner = await db.one('SELECT id, role, entity_id FROM users WHERE id=$1', [iv.owner_id]);
  if (!owner || owner.role === 'admin') return '';
  if (veoWithoutQuote(owner, owner.entity_id)) return `<h3 id="orcamento">${VIDEO_PREMIUM}</h3><p class="hint">${esc(ENTITY_VEO_NO_QUOTE)}</p>`;
  const quotes = await db.query(`SELECT * FROM animation_quotes WHERE episode_id=$1 ORDER BY created_at DESC LIMIT 5`, [ep.id]);
  return inEntity(owner.entity_id, async () => {
    const tier = quoteTier(), rate = await rateForTier(db, tier);
    const vatRate = await consumerVatRate(db, owner.id, seller()), regime = await vatRegimeOf(db, owner.id, seller());
    const block = rate ? await quoteBlock(db, iv, ep) : 'O vídeo premium não está disponível de momento.';
    const open = quotes.find((q: any) => ['accepted', 'running'].includes(q.status));
    // Quem autorizou (sem carregar as fotografias; o orçamento confirma tudo).
    const allowed = {
      host: !!(iv.host_ai_video && iv.host_photo_rights && iv.host_photo_asset_id),
      guest: (await consent(db, iv.id, 'ai_video')) && (await consent(db, iv.id, 'publish_photo')) && !!(await db.one(`SELECT 1 FROM photos p WHERE p.interview_id=$1 AND ${usablePhotoSql('p')} LIMIT 1`, [iv.id])),
    };
    const script = await db.one('SELECT segments FROM scripts WHERE id=$1', [ep.script_id]);
    const falas = rate ? candidateFalas(ep, script?.segments ?? [], allowed, rate) : [];
    // O cliente vê só o essencial: quantos créditos o vídeo premium deste episódio pode custar, o saldo e se tem de comprar.
    const total = falas.reduce((n, f) => n + f.cents, 0), speech = falas.reduce((n, f) => n + f.sec, 0);
    const w = await findWallet(db, owner.id, owner.entity_id), avail = w?.available_cents ?? 0, missing = Math.max(0, total - avail);
    let html = `<h3 id="orcamento">${VIDEO_PREMIUM}, por orçamento</h3>
<p class="sans">${rate ? `${esc(perMinuteLabel(rate.cents_per_min, vatRate, regime))}. ` : ''}Paga só as falas que saírem animadas e verificadas; o resto volta ao saldo.</p>
${rate ? creditTable(rate.cents_per_min) : ''}`;
    if (quotes.length) html += `<ul class="sans">${quotes.map((q: any) => { const [l, k] = QUOTE_STATUS[q.status] ?? [q.status, '']; return `<li><a href="/entrevistas/${iv.id}/orcamentos/${q.id}">Orçamento de ${fmtDate(q.created_at)}</a> · ${pill(l, k)} · ${esc(priceLabel(q.price_cents, vatRate, regime))}${q.status === 'settled' ? ` · cobrados ${cr(q.charged_cents ?? 0)}, libertados ${cr(q.released_cents ?? 0)}` : ''}</li>`; }).join('')}</ul>`;
    if (block) return `${html}<p class="hint"><strong>${esc(block)}</strong></p>`;
    if (open) {
      const fila = open.status === 'accepted' ? await videoQueue(db, open.job_id) : null;
      return `${html}<p class="hint">Há um orçamento aceite em curso para este episódio: aguarde que a produção termine.${fila && !fila.running ? ` ${esc(queueLabel(fila, false))}.` : ''}</p>`;
    }
    if (!falas.length) return `${html}<p class="hint">Sem falas autorizadas para animar: o entrevistador autoriza o vídeo por IA em Editar; o convidado em «Autorizações das fotografias», e só com a política «o entrevistado aprova».</p>`;
    return `${html}<div class="card" style="margin:12px 0"><p class="sans" style="margin:0">Este episódio: <strong>${Math.round(speech / 6) / 10} min</strong> de fala animada → <strong>até ${cr(total)} créditos</strong>. Saldo: <strong>${cr(avail)} créditos</strong>.</p>
${missing ? `<p class="sans" style="margin:8px 0 0;color:var(--bad)">Faltam <strong>${cr(missing)} créditos</strong> para garantir a produção até ao fim. <a class="btn ghost" href="/conta/creditos">Comprar créditos</a></p>` : '<p class="sans" style="margin:8px 0 0;color:var(--ok)">O saldo chega para a produção até ao fim.</p>'}</div>
<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/orcamento">
<details><summary class="sans">Escolher as falas a animar (opcional; por omissão, todas)</summary><div style="overflow-x:auto"><table class="sans"><thead><tr><th>Animar</th><th>Fala</th><th>Segundos</th><th>Créditos</th></tr></thead><tbody>
${falas.map(f => `<tr><td><input type="checkbox" name="fala" value="${esc(f.id)}" checked aria-label="Animar a fala ${esc(f.id)}"></td><td>${esc(roleLabel(f.role))} · ${esc(excerpt(f.text))}</td><td>${f.sec} s</td><td>${cr(f.cents)}</td></tr>`).join('')}</tbody></table></div>
<p class="hint">As falas já pagas passam a 0 créditos no orçamento. As que tirar ficam em fotografia com a voz do episódio.</p></details>
<label for="qlang">Legendas no vídeo</label><select id="qlang" name="lang" style="width:auto">${Object.keys(ep.subtitles ?? {}).map(l => `<option value="${esc(l)}" ${l === (ep.video_lang ?? 'pt-PT') ? 'selected' : ''}>${esc(l)}</option>`).join('')}<option value="">Sem legendas</option></select>
<p><button class="accent">Calcular orçamento (grátis, não cativa nada)</button></p></form>`;
  });
}

export async function quoteRoutes(app: FastifyInstance) {
  const db = app.db;
  const send = (reply: any, title: string, body: string) => reply.type('text/html; charset=utf-8').send(page({ title, body, noindex: true, nav: `<a href="/painel">Painel</a><a href="/conta/creditos">Créditos</a>${helpNav(reply.request.user)}` }));
  const toProd = (reply: any, id: string, ok?: string, e?: string) => reply.redirect(`/entrevistas/${id}/producao${ok ? '?ok=' + encodeURIComponent(ok) : e ? '?e=' + encodeURIComponent(e) : ''}`);
  const toQuote = (reply: any, id: string, qid: string, ok?: string, e?: string) => reply.redirect(`/entrevistas/${id}/orcamentos/${qid}${ok ? '?ok=' + encodeURIComponent(ok) : e ? '?e=' + encodeURIComponent(e) : ''}`);
  const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
  const guard = async (req: any, reply: any) => {
    if (!requireUser(req, reply)) return null;
    const iv = await ownedInterview(app, req, req.params.id);
    if (!iv) { reply.code(404).send('Não encontrada'); return null; }
    return iv;
  };
  const qGuard = async (req: any, reply: any) => {
    const iv = await guard(req, reply); if (!iv) return null;
    const q = uuid(req.params.qid) ? await db.one('SELECT * FROM animation_quotes WHERE id=$1 AND interview_id=$2', [req.params.qid, iv.id]) : null;
    if (!q) { reply.code(404).send('Orçamento inexistente'); return null; }
    return { iv, q };
  };

  // Rascunho (o titular ou o administrador): grátis, não cativa nada.
  app.post('/entrevistas/:id/episodio/:eid/orcamento', async (req, reply) => {
    const iv = await guard(req, reply); if (!iv) return;
    const ep = uuid((req.params as any).eid) ? await db.one('SELECT * FROM episodes WHERE id=$1 AND interview_id=$2', [(req.params as any).eid, iv.id]) : null;
    if (!ep) return reply.code(404).send();
    const b = (req.body ?? {}) as any;
    const ids = ([] as string[]).concat(b.fala ?? []).map(String).slice(0, 500);
    try {
      const q = await createQuote(db, { iv, ep, actor: req.user!, segmentIds: ids, lang: typeof b.lang === 'string' && b.lang ? b.lang : null });
      await audit(db, req.user!.email, 'animation.quote_created', iv.id, { quote: q.id, price: q.price_cents, segments: ids.length });
      return toQuote(reply, iv.id, q.id, 'Orçamento calculado: reveja-o antes de aceitar.');
    } catch (e: any) {
      if (e instanceof QuoteError) return toProd(reply, iv.id, undefined, e.message);
      throw e;
    }
  });

  // Orçamento: tudo o que o cliente precisa de ver imediatamente antes de aceitar (DL 24/2014, art. 4.º, n.º 1, e art. 5.º, n.º 2).
  app.get('/entrevistas/:id/orcamentos/:qid', async (req, reply) => {
    const c = await qGuard(req, reply); if (!c) return;
    const { iv, q } = c, qs = req.query as any;
    const owner = await db.one('SELECT id, email, name, entity_id FROM users WHERE id=$1', [q.owner_id]);
    const isOwner = req.user!.id === q.owner_id && req.user!.role !== 'admin';
    return inEntity(owner.entity_id, async () => {
      const s = seller(), consumer = await isConsumerOwner(db, owner.id);
      const vatRate = consumer ? await consumerVatRate(db, owner.id, s) : null, regime = await vatRegimeOf(db, owner.id, s);
      const w = await findWallet(db, owner.id, owner.entity_id);
      const avail = w?.available_cents ?? 0, wblock = spendBlock(w);
      const problem = q.status === 'draft' ? await quoteProblem(db, q) : null;
      const ep = await db.one('SELECT id, status, stale FROM episodes WHERE id=$1', [q.episode_id]);
      const job = q.job_id ? await db.one('SELECT state, progress_label, error, run_after FROM jobs WHERE id=$1', [q.job_id]) : null;
      const fila = ['draft', 'accepted', 'running'].includes(q.status) ? await videoQueue(db, q.status === 'draft' ? null : q.job_id) : null;
      const [label, kind] = QUOTE_STATUS[q.status] ?? [q.status, ''];
      const settlement = new Map<string, any>(((q.settlement?.segments ?? []) as any[]).map(x => [x.segmentId, x]));
      const settled = q.status === 'settled';
      const note = (x: any) => [x.reused ? '<strong>reaproveitado: 0 cr</strong> (fala já paga)' : '', x.dup ? 'igual a outra fala deste orçamento: incluída' : '',
        x.realNames?.length ? `<span style="color:var(--warn)">nomes de pessoas reais (${esc(x.realNames.join(', '))}): risco de recusa pelo filtro do fornecedor de IA; se recusar, fica em fotografia e não paga</span>` : ''].filter(Boolean).join('<br>');
      const result = (x: any) => { const r = settlement.get(x.segmentId); if (!r) return ''; return r.status === 'charged' ? pill(`animada: ${cr(r.cents)} cr`, 'ok') : r.status === 'reused' ? pill('animada: reaproveitada, 0 cr', 'ok') : r.status === 'included' ? pill('animada: incluída', 'ok') : `${pill('fotografia: 0 cr', 'warn')} <span class="hint">${esc(reasonLabel(r.reason))}</span>`; };
      const rows = (q.selection as any[]).map(x => `<tr><td>${esc(x.segmentId)} · ${esc(roleLabel(x.role))}<br><span class="hint">${esc(excerpt(x.text ?? '', 140))}</span></td><td>${x.sec} s</td><td>${x.reused || x.dup ? '0' : cr(x.cents)}</td><td>${note(x)}</td>${settled ? `<td>${result(x)}</td>` : ''}</tr>`).join('');
      const after = avail - q.price_cents;
      const canPay = !wblock && after >= 0;
      const second = consumer ? 'Reconheço que perco o direito de livre resolução quando a produção estiver concluída.' : 'Aceito este orçamento e as condições acima (o valor fica cativo e só se cobram as falas animadas e verificadas).';
      const back = `/entrevistas/${iv.id}/orcamentos/${q.id}`;
      let form = '';
      if (q.status === 'draft') {
        if (problem) form = `<div class="flash bad">${esc(problem)} <a href="/entrevistas/${iv.id}/producao#orcamento">Pedir um orçamento novo</a></div>`;
        else if (!isOwner) form = `<p class="hint">Só o titular da entrevista (${esc(owner.email)}) pode aceitar este orçamento. O administrador prepara o rascunho, mas nunca o aceita em nome do cliente.</p>`;
        else form = `<form method="post" action="${back}/aceitar" class="card">
${wblock ? flash(wblock.pt, 'bad') : !canPay ? `<div class="flash bad">Saldo insuficiente: faltam ${cr(q.price_cents - avail)} créditos. <a href="/conta/creditos/carregar?falta=${q.price_cents - avail}&amp;voltar=${encodeURIComponent(back)}">Carregar o que falta</a></div>` : ''}
<label class="check"><input type="checkbox" name="start_now" value="1" required> <span>Peço que a produção comece já.</span></label>
<label class="check"><input type="checkbox" name="waiver" value="1" required> <span>${esc(second)}</span></label>
<button class="accent" ${canPay ? '' : 'disabled'}>${esc(acceptLabel(q.price_cents, vatRate))}</button></form>`;
      }
      const cancellable = q.status === 'draft' || (q.status === 'accepted' && job?.state === 'queued');
      const hostCharged = settled && !!(await db.one(`SELECT 1 FROM animation_charges WHERE interview_id=$1 AND role='host' LIMIT 1`, [iv.id]));
      const body = `<div class="narrow" style="padding-top:32px"><p><a href="/entrevistas/${iv.id}/producao#orcamento">← Produção de ${esc(iv.title)}</a></p>
<h1>Orçamento da animação ${pill(label, kind)}</h1>${flash(qs.ok)}${flash(qs.e, 'bad')}
${q.status === 'void' || q.status === 'cancelled' ? flash(`${q.status === 'void' ? 'Anulado' : 'Cancelado'}: ${q.void_reason ?? ''}${q.released_cents ? ` Os ${cr(q.released_cents)} créditos cativos voltaram ao saldo.` : ''}`, 'bad') : ''}
${q.status === 'running' && q.status_note ? flash(q.status_note) : ''}${['accepted', 'running'].includes(q.status) ? `<p class="sans">${pill(job?.state === 'queued' ? 'na fila' : 'a gerar', 'ok')} ${esc(job?.progress_label ?? '')} · <a href="/entrevistas/${iv.id}/producao">ver o progresso</a> · ${cr(q.price_cents)} créditos cativos</p>` : ''}
${settled ? `<div class="flash ok">Produção concluída: cobrados <strong>${cr(q.charged_cents ?? 0)}</strong> créditos (só as falas animadas e verificadas); libertados e de volta ao saldo <strong>${cr(q.released_cents ?? 0)}</strong> créditos.</div>` : ''}
<div class="card" style="overflow-x:auto"><table class="sans"><thead><tr><th>Fala</th><th>Segundos</th><th>Créditos</th><th>Notas</th>${settled ? '<th>Resultado</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>
<div class="card sans"><table><tbody>
<tr><th>Total</th><td><strong id="total">${esc(priceLabel(q.price_cents, vatRate, regime))}</strong><br><span class="hint">É o máximo que paga. ${q.speech_sec} s de fala no total.</span></td></tr>
<tr><th>Tarifa</th><td>${esc(perMinuteLabel(q.rate.cents_per_min, vatRate, regime))}</td></tr>
${q.status === 'draft' ? `<tr><th>Saldo</th><td id="saldo">${cr(avail)} créditos → ${cr(Math.max(0, after))} créditos depois de aceitar${after < 0 ? ' (insuficiente)' : ''} <span class="hint">(o valor fica cativo até ao fim da produção)</span></td></tr>` : ''}
<tr><th>Vídeo</th><td>${VIDEO_PREMIUM}, ${esc(q.rate.resolution)}, com imagem e voz geradas por IA a partir da fotografia e do texto aprovado</td></tr>
<tr><th>Validade</th><td>Até ${fmtDate(q.valid_until)}, com o preço fixo</td></tr>
<tr><th>Prazo estimado</th><td id="prazo">~${q.est_minutes ?? 2} min de geração depois de começar${fila ? `; ${esc(queueLabel(fila, q.status === 'draft'))}` : ''}<br><span class="hint">O prazo de ${START_DEADLINE_HOURS} h para começar conta a partir do momento em que a produção pode arrancar: a espera pelos vídeos à frente na fila não conta.</span></td></tr>
</tbody></table></div>
<div class="card"><h2 style="margin-top:0">Garantias</h2><ul>${GUARANTEES.map(g => `<li>${esc(g)}</li>`).join('')}</ul>
${consumer ? `<p><strong>Livre resolução.</strong> Tem ${WITHDRAWAL_DAYS} dias para pedir o reembolso do saldo não usado de cada carregamento. Ao pedir que a produção comece já, perde o direito de livre resolução sobre esta produção quando ela estiver concluída (DL 24/2014, art. 17.º, n.º 1, als. a) e l)).</p>` : ''}
<p>O vídeo leva o aviso visível «${esc(VEO_NOTICE)}» (Regulamento da IA, art. 50.º).</p>
<p class="hint">Vendedor: ${esc(s.name || s.tradeName || '—')}${s.nif ? `, NIF ${esc(s.nif)}` : ''}${s.address ? `, ${esc(s.address)}` : ''} · ${complaintsLink(s)} · <a href="/termos">Termos e condições</a> (versão ${esc(TERMS_VERSION)})</p></div>
${form}
${cancellable ? `<form method="post" action="${back}/cancelar" onsubmit="return confirm('Cancelar este orçamento?')"><button class="ghost">${q.status === 'draft' ? 'Desistir deste orçamento' : 'Cancelar antes de começar (o cativo volta ao saldo)'}</button></form>` : ''}
${hostCharged && ep?.status === 'preview' && !ep.stale ? `<form method="post" action="${back}/reconstruir" onsubmit="return confirm('Montar de novo o vídeo só com as falas já pagas do entrevistador?')" class="card"><p class="hint">Se o convidado retirou a autorização, o vídeo pode ser reconstruído só com o entrevistador, com os clipes já pagos: 0 créditos e nada é enviado à Google.</p><button class="ghost">Reconstruir só com o entrevistador (0 créditos)</button></form>` : ''}</div>`;
      return send(reply, 'Orçamento da animação', body);
    });
  });

  app.post('/entrevistas/:id/orcamentos/:qid/aceitar', async (req, reply) => {
    const c = await qGuard(req, reply); if (!c) return;
    const r = await acceptQuote(db, req.user!, c.q.id, req.body ?? {}, req.ip);
    if ('error' in r) return toQuote(reply, c.iv.id, c.q.id, undefined, r.error);
    await audit(db, req.user!.email, 'animation.quote_accepted', c.iv.id, { quote: c.q.id, priceCents: r.quote.price_cents, consumer: r.consumer, startNow: true, waiver: true, ip: req.ip, terms: TERMS_VERSION, rateVersion: r.quote.rate?.version ?? null, job: r.jobId });
    return toProd(reply, c.iv.id, `Orçamento aceite: ${cr(r.quote.price_cents)} créditos cativos. Enviámos o orçamento e as condições por email; a produção começa a seguir.`);
  });

  app.post('/entrevistas/:id/orcamentos/:qid/cancelar', async (req, reply) => {
    const c = await qGuard(req, reply); if (!c) return;
    const why = await cancelQuote(db, c.q.id, req.user!.email);
    if (why) return toQuote(reply, c.iv.id, c.q.id, undefined, why);
    await audit(db, req.user!.email, 'animation.quote_cancelled', c.iv.id, { quote: c.q.id });
    return toQuote(reply, c.iv.id, c.q.id, 'Orçamento cancelado: nada foi cobrado.');
  });

  // Reconstrução a 0 créditos só com o entrevistador (ex.: o convidado retirou a autorização): clipes já pagos, nada vai à Google.
  app.post('/entrevistas/:id/orcamentos/:qid/reconstruir', async (req, reply) => {
    const c = await qGuard(req, reply); if (!c) return;
    const { iv, q } = c;
    if (q.status !== 'settled') return toQuote(reply, iv.id, q.id, undefined, 'Só se reconstrói a partir de um orçamento liquidado.');
    const ep = await db.one('SELECT id, status, stale FROM episodes WHERE id=$1', [q.episode_id]);
    if (!ep || ep.stale || ep.status !== 'preview') return toQuote(reply, iv.id, q.id, undefined, 'O vídeo só se reconstrói num episódio em pré-visualização (antes da publicação), para ser visto e aprovado.');
    if (await db.one(`SELECT 1 FROM jobs WHERE interview_id=$1 AND kind='render_video' AND state IN ('queued','running')`, [iv.id])) return toQuote(reply, iv.id, q.id, undefined, 'Já há um vídeo a ser gerado; aguarde que termine.');
    const n = Number((await db.one(`SELECT count(*)::int AS n FROM jobs WHERE interview_id=$1 AND kind='render_video'`, [iv.id])).n);
    await enqueue(db, { kind: 'render_video', interviewId: iv.id, input: { episodeId: ep.id, lang: q.lang, engine: 'veo', rebuild: q.id, requestedBy: req.user!.id }, dedupe: `video:rebuild:${q.id}:${n}` });
    await audit(db, req.user!.email, 'animation.rebuild_host_only', iv.id, { quote: q.id });
    return toProd(reply, iv.id, 'Reconstrução do vídeo só com o entrevistador iniciada (0 créditos).');
  });
}
