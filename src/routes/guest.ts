import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eraseGuestAiVideo } from '../veo-episode.ts';
import { config } from '../config.ts';
import { esc, sha256, newToken, rateLimit, fmtDate } from '../lib.ts';
import { page, flash, pill } from '../views.ts';
import { setSessionCookie, audit, sendAsset } from '../app.ts';
import { t, normLang, consentText, consentLongFor, CONSENT_VERSION, type Lang, type ConsentPurpose } from '../i18n.ts';
import { guestReview, guestDecides, reviewCopy } from '../approval.ts';
import { hasVideo, promoVideo } from '../landing.ts';
import { sniff, stripJpegMetadata, saveAsset, probeAudio } from '../media.ts';
import { photoDecodes } from '../cover.ts';
import { queueEmail, emailShell } from '../mail.ts';
import { createInvitation } from '../invites.ts';
import { aiAvailable, readQuestion, READING_VOICES } from '../ai/openai.ts';
import { storage } from '../storage.ts';
import { inEntity, entityOfInterview } from '../settings.ts';
import { answeredMs, secondsLeft, mmss, LIMIT_SLACK_MS, wordsToMs, msToWords, maxAnswerWords, writtenMaxChars } from '../limits.ts';
import { extractAnswerText, DocError, DOC_MAX_BYTES } from '../docx.ts';
import { guestHelpNav } from '../support.ts';
import { takeAiUse, giveBackAiUse, freeSendBlock, FREE_READINGS_PER_QUESTION } from '../free-interview.ts';
import { uploadRoom, reserveUploadRoom, uploadRefusalText, discardReplacedTake, discardAsset, type UploadRefusal } from '../uploads.ts';
import type { Db } from '../db.ts';

const H = { 'Content-Type': 'text/html; charset=utf-8' };
const DOC_MAX_MB = DOC_MAX_BYTES / 1024 / 1024;

export async function guestRoutes(app: FastifyInstance) {
  const db = app.db;

  const gpage = (reply: FastifyReply, lang: Lang, title: string, body: string, script?: string) =>
    reply.headers({ ...H, 'Cache-Control': 'no-store' }).send(page({ lang, title, body: `<div class="narrow" style="padding:28px 20px 0">${body}</div>`, noindex: true, script, nav: guestHelpNav(reply.request.guest, lang) }));

  const loadInvitation = async (token: string) =>
    db.one(`SELECT inv.*, i.title, COALESCE(NULLIF(i.host_name,''), u.name) AS host_name, i.interaction_lang, i.guest_email, i.guest_name, i.id AS iid, i.collection_status, i.review_policy
            FROM invitations inv JOIN interviews i ON i.id=inv.interview_id LEFT JOIN users u ON u.id=i.owner_id WHERE inv.token_hash=$1`, [sha256(token)]);

  // ---- convite: GET só mostra; nada é consumido ----
  app.get('/i/:token', async (req, reply) => {
    const inv = await loadInvitation((req.params as any).token);
    if (!inv) return gpage(reply, 'en', 'Link', `<h1>Link not valid</h1><p>This link is not valid. Please check the email you received.</p>`);
    const lang = normLang(inv.interaction_lang), d = t(lang);
    if (inv.declined_at) return gpage(reply, lang, d.inviteTitle, `<p>${esc(d.declined)}</p>`);
    if (inv.revoked_at || new Date(inv.expires_at) < new Date()) {
      const q = req.query as any;
      return gpage(reply, lang, d.expired, `<h1>${esc(d.expired)}</h1><p>${esc(d.expiredHelp)}</p>${q.sent === 'nada' ? flash(d.nothingToView) : q.sent ? flash(d.resendDone) : ''}
<form method="post" action="/i/${esc((req.params as any).token)}/novo-link" class="card"><label for="em">${esc(d.yourEmail)}</label><input id="em" name="email" type="email" required autocomplete="email"><p><button class="accent">${esc(d.resendBtn)}</button></p></form>`);
    }
    if (inv.purpose === 'preview') { // validação do episódio: sem número de perguntas e sem «Não pretendo participar»
      // «Confirme e valide» só quando a aprovação do convidado conta; senão, só ver (ou nada para ver, sem episódio).
      const review = await guestReview(db, { id: inv.iid, review_policy: inv.review_policy });
      const c = reviewCopy(lang, review);
      return gpage(reply, lang, c.title, `<h1>${esc(c.title)}</h1><p>${esc(d.reviewIntro(inv.host_name))}</p><p><strong>${esc(inv.title)}</strong></p><p class="hint">${esc(c.steps)}</p>
<form method="post" action="/i/${esc((req.params as any).token)}/abrir"><p><button class="accent" style="width:100%">${esc(review ? c.open : d.open)}</button></p></form>`);
    }
    const nQ = Number((await db.one('SELECT count(*)::int AS n FROM questions WHERE interview_id=$1', [inv.iid]))?.n);
    // Vídeo explicativo (sem preços nem reprodução automática) no primeiro convite: só com «o entrevistado aprova», porque
    // promete que nada é publicado sem a aprovação dele. Legendas em português e em inglês, a da língua do convite ligada.
    const promo = inv.purpose === 'invite' && inv.review_policy === 'guest_preview' && hasVideo()
      ? `<figure style="margin:24px 0 0"><p class="sans" style="margin:0 0 8px"><strong>${esc(d.promoTitle)}</strong></p>${promoVideo(lang, d.promoFallback, 'width:100%;height:auto;aspect-ratio:16/9;border-radius:12px;background:#000;display:block')}
<figcaption class="hint" style="margin-top:8px">${esc(d.promoCaption)}</figcaption></figure>` : '';
    return gpage(reply, lang, d.inviteTitle, `<h1>${esc(inv.title)}</h1><p>${esc(d.invitedBy(inv.host_name))}</p><p class="hint">${esc(d.qCount(nQ))}</p><p class="hint">${esc(inv.review_policy === 'host_only' ? d.inviteEditHost : d.inviteEdit)}</p>
<form method="post" action="/i/${esc((req.params as any).token)}/abrir"><p><button class="accent" style="width:100%">${esc(d.open)}</button></p></form>
<form method="post" action="/i/${esc((req.params as any).token)}/recusar" onsubmit="return confirm('${esc(d.decline)}?')"><p><button class="ghost" style="width:100%">${esc(d.decline)}</button></p></form>${promo}`);
  });

  app.post('/i/:token/abrir', async (req, reply) => {
    const inv = await loadInvitation((req.params as any).token);
    if (!inv || inv.revoked_at || inv.declined_at || new Date(inv.expires_at) < new Date()) return reply.redirect(`/i/${(req.params as any).token}`);
    if (!rateLimit(`open:${req.ip}`, 30, 10 * 60_000)) return reply.code(429).send('Too many requests');
    await db.query('UPDATE invitations SET first_opened_at=COALESCE(first_opened_at, now()) WHERE id=$1', [inv.id]);
    if (['invited', 'reopened'].includes(inv.collection_status)) await db.query(`UPDATE interviews SET collection_status='started' WHERE id=$1`, [inv.iid]);
    const token = newToken();
    await db.query(`INSERT INTO guest_sessions(id, interview_id, invitation_id, expires_at) VALUES ($1,$2,$3,$4)`, [sha256(token), inv.iid, inv.id, inv.expires_at]);
    await setSessionCookie(reply, 'gs', token, Math.max(60, Math.floor((new Date(inv.expires_at).getTime() - Date.now()) / 1000)));
    await audit(db, 'guest', 'invitation.opened', inv.iid);
    // Validação: vai diretamente para o episódio a validar. O token deixa de aparecer no URL.
    return reply.redirect(inv.collection_status !== 'submitted' ? '/entrevista' : inv.purpose === 'preview' ? '/entrevista/episodio' : '/entrevista/obrigado');
  });

  app.post('/i/:token/recusar', async (req, reply) => {
    const inv = await loadInvitation((req.params as any).token);
    if (inv && !inv.declined_at && !inv.revoked_at && inv.purpose !== 'preview') { // um link de validação não serve para recusar
      await db.query('UPDATE invitations SET declined_at=now() WHERE id=$1', [inv.id]);
      const owner = await db.one('SELECT u.email FROM users u JOIN interviews i ON i.owner_id=u.id WHERE i.id=$1', [inv.iid]);
      await audit(db, 'guest', 'invitation.declined', inv.iid);
      if (owner) await queueEmail(db, { key: `declined:${inv.id}`, interviewId: inv.iid, to: owner.email, subject: `Convite recusado — ${inv.title}`,
        html: emailShell('Convite recusado', `<p>${esc(inv.guest_name)} indicou que não pretende participar na entrevista “${esc(inv.title)}”.</p>`), text: `${inv.guest_name} não pretende participar em "${inv.title}".` });
    }
    return reply.redirect(`/i/${(req.params as any).token}`);
  });

  // Novo link por email original (resposta genérica; limite e cooldown). Um rascunho (convite que não saiu) não tem link a renovar.
  app.post('/i/:token/novo-link', async (req, reply) => {
    const tk = (req.params as any).token;
    const inv = await loadInvitation(tk);
    const email = String((req.body as any)?.email ?? '').trim().toLowerCase();
    let sent = '1';
    if (inv && !inv.declined_at && !['cancelled', 'draft'].includes(inv.collection_status) && email === String(inv.guest_email).toLowerCase()
        && rateLimit(`newlink:${inv.iid}`, 1, config.limits.resendCooldownSec * 1000) && rateLimit(`newlink-ip:${req.ip}`, 10, 3600_000)) {
      const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [inv.iid]);
      const owner = await db.one('SELECT name FROM users WHERE id=$1', [iv.owner_id]);
      const latest = (await db.one('SELECT purpose FROM invitations WHERE interview_id=$1 ORDER BY created_at DESC LIMIT 1', [inv.iid]))?.purpose ?? inv.purpose;
      // 1.ª entrevista grátis: o «novo link» é um reenvio como o «Reenviar convite» do entrevistador, com o mesmo total
      // (FREE_RESENDS) e nada depois da recusa (freeSendBlock), verificados com a entrevista bloqueada na transação que cria o
      // link; e só quando nenhum link da entrevista está em vigor (o do pedido, ainda válido, ou um mais recente, que já
      // está na mesma caixa de correio: o token revogado por um reenvio não pede outro). Antes, o «novo link» não verificava
      // o total: um por RESEND_COOLDOWN_SEC e 10 por hora por IP, ~720 emails por dia por entrevista grátis, que depois
      // contavam contra o «Reenviar» do entrevistador. A resposta continua genérica. As entrevistas pagas ficam como antes.
      const guard = iv.free_at ? async (tx: Db) => {
        await tx.query('SELECT id FROM interviews WHERE id=$1 FOR UPDATE', [iv.id]);
        if (await tx.one('SELECT 1 FROM invitations WHERE interview_id=$1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1', [iv.id])) return 'Há um link em vigor.';
        return freeSendBlock(tx, iv.id, { resend: latest !== 'preview' });
      } : undefined;
      // Validação: o link novo segue o episódio atual (validar, ou só ver quando a publicação é do entrevistador ou já
      // saiu). Sem episódio para ver não se envia um link vazio: quem pediu (com o email certo) fica a saber porquê.
      if (latest === 'preview' && !(await guestReview(db, iv))) sent = 'nada';
      else {
        const r = await createInvitation(db, iv, { name: owner?.name ?? '' }, { ...(latest === 'preview' ? { preview: true } : latest === 'followup' ? { followup: true } : {}), guard }); // mantém a finalidade do convite em vigor
        if (!r.refused) await audit(db, 'guest', 'invitation.renewed', inv.iid);
      }
    }
    return reply.redirect(`/i/${tk}?sent=${sent}`);
  });

  // ---- tudo abaixo exige sessão de convidado ----
  const need = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.guest) { reply.redirect('/'); return null; }
    const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [req.guest.interviewId]);
    return iv ? { iv, lang: normLang(iv.interaction_lang) } : null;
  };
  const needApi = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.guest) { reply.code(401).send({ error: 'session' }); return null; }
    const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [req.guest.interviewId]);
    if (!iv || ['cancelled'].includes(iv.collection_status)) { reply.code(403).send({ error: 'closed' }); return null; }
    return iv;
  };
  const needOpen = async (req: FastifyRequest, reply: FastifyReply) => {
    const iv = await needApi(req, reply);
    if (iv && iv.collection_status === 'submitted') { reply.code(409).send({ error: 'submitted' }); return null; }
    return iv;
  };
  const granted = async (interviewId: string, purpose: string) =>
    !!(await db.one(`SELECT granted FROM consents WHERE interview_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`, [interviewId, purpose]))?.granted;
  const recordConsent = async (iv: any, lang: Lang, purpose: ConsentPurpose, ok: boolean) => {
    const prev = await db.one(`SELECT granted, text_version FROM consents WHERE interview_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`, [iv.id, purpose]);
    if (prev && prev.granted === ok && prev.text_version === CONSENT_VERSION) return;
    await db.query(`INSERT INTO consents(interview_id, purpose, granted, text_version, text_snapshot) VALUES ($1,$2,$3,$4,$5)`,
      [iv.id, purpose, ok, CONSENT_VERSION, consentText(lang, purpose, iv.review_policy) + (purpose === 'participation' ? '\n' + consentLongFor(lang, iv.review_policy) : '')]);
  };
  const cb = (name: string, label: string, checked: boolean, req = false) => `<label class="check"><input type="checkbox" name="${name}" value="1" ${checked ? 'checked' : ''} ${req ? 'required' : ''}> <span>${esc(label)}</span></label>`;

  app.get('/entrevista', async (req, reply) => {
    const c = await need(req, reply); if (!c) return;
    const { iv, lang } = c, d = t(lang);
    if (!(await granted(iv.id, 'participation'))) {
      const processing = await granted(iv.id, 'processing'), publish = await granted(iv.id, 'publish');
      return gpage(reply, lang, iv.title, `<h1>${esc(iv.title)}</h1>
${iv.objective_shared && iv.objective_text ? `<h2>${esc(d.objective)}</h2><p>${esc(iv.objective_text)}</p>` : ''}
<h2>${esc(d.beforeStart)}</h2><p>${esc(consentLongFor(lang, iv.review_policy))}</p><p class="hint">${esc(d.consentIntro)}</p>
<form method="post" action="/entrevista/consentimentos" class="card">${cb('participation', d.c_participation, false, true)}${cb('processing', d.c_processing, processing)}${cb('publish', consentText(lang, 'publish', iv.review_policy), publish)}${cb('host_edit', consentText(lang, 'host_edit', iv.review_policy), false, true)}${cb('adult', d.adults, false, true)}
<p><button class="accent" style="width:100%">${esc(d.start)}</button></p></form>
<p class="hint">${esc(d.helpLine)} <a href="/entrevista/ajuda">${esc(d.supportTitle)}</a></p>`);
    }
    const qs = await db.query(`SELECT q.*, a.status FROM questions q LEFT JOIN answers a ON a.question_id=q.id WHERE q.interview_id=$1 ORDER BY q.position`, [iv.id]);
    const next = qs.find((q: any) => !q.status) ?? qs[0];
    const left = iv.answer_limit_sec == null ? null : secondsLeft(iv.answer_limit_sec, await answeredMs(db, iv.id));
    return gpage(reply, lang, iv.title, `<h1>${esc(iv.title)}</h1>
${iv.objective_shared && iv.objective_text ? `<p>${esc(iv.objective_text)}</p>` : ''}
${left != null ? `<p class="hint sans">${esc(d.answerTime(mmss(iv.answer_limit_sec), mmss(left)))}</p>` : ''}
<ol class="sans" style="padding-left:20px">${qs.map((q: any) => `<li style="margin:8px 0"><a href="/entrevista/p/${q.position}">${esc(q.text) || '…'}</a> ${q.status === 'answered' ? pill(d.answered, 'ok') : q.status === 'refused' ? pill('—', 'warn') : ''}</li>`).join('')}</ol>
<p><a class="btn accent" style="width:100%;text-align:center" href="/entrevista/p/${next.position}">${esc(d.continue)}</a></p>
<p><a href="/entrevista/fotos">${esc(d.photos)}</a> · <a href="/entrevista/rever">${esc(d.review)}</a></p>`);
  });

  app.post('/entrevista/consentimentos', async (req, reply) => {
    const c = await need(req, reply); if (!c) return;
    const b = req.body as any;
    // Aceitar inclui a autorização de edição anunciada no convite (necessária, como a participação).
    if (!b.participation || !b.adult || !b.host_edit) return reply.redirect('/entrevista');
    await recordConsent(c.iv, c.lang, 'participation', true);
    await recordConsent(c.iv, c.lang, 'host_edit', true);
    await recordConsent(c.iv, c.lang, 'processing', !!b.processing);
    await recordConsent(c.iv, c.lang, 'publish', !!b.publish);
    await audit(db, 'guest', 'consent.recorded', c.iv.id);
    return reply.redirect('/entrevista');
  });

  app.get('/entrevista/p/:n', async (req, reply) => {
    const c = await need(req, reply); if (!c) return;
    const { iv, lang } = c, d = t(lang);
    if (!(await granted(iv.id, 'participation'))) return reply.redirect('/entrevista');
    const total = Number((await db.one('SELECT count(*)::int AS n FROM questions WHERE interview_id=$1', [iv.id]))?.n);
    const n = Math.max(1, Math.min(total, parseInt((req.params as any).n) || 1));
    const q = await db.one('SELECT * FROM questions WHERE interview_id=$1 AND position=$2', [iv.id, n]);
    if (!q) return reply.redirect('/entrevista');
    const ans = await db.one(`SELECT a.*, t.asset_id, t.uploaded_via, ast.duration_ms AS take_ms FROM answers a LEFT JOIN answer_takes t ON t.id=a.selected_take_id LEFT JOIN assets ast ON ast.id=t.asset_id WHERE a.question_id=$1`, [q.id]);
    const written = ans?.asset_id && ans.uploaded_via === 'document' ? await docText(ans.selected_take_id) : null;
    const nextHref = n < total ? `/entrevista/p/${n + 1}` : '/entrevista/fotos';
    // Tempo total da entrevista: «base» é o que esta resposta pode usar (uma nova gravação substitui a atual); null = sem limite.
    const others = iv.answer_limit_sec == null ? 0 : await answeredMs(db, iv.id, q.id);
    const base = secondsLeft(iv.answer_limit_sec, others);
    const savedMs = ans?.asset_id ? Number(ans.take_ms ?? 0) : 0;
    const left = secondsLeft(iv.answer_limit_sec, others + savedMs);
    const noTime = base != null && base < 1;
    const msg = JSON.stringify({ micDenied: d.micDenied, micNone: d.micNone, empty: d.empty, silent: d.silent, tooLong: d.tooLong, stLocal: d.stLocal, stUp: d.stUp, stSaved: d.stSaved, stFail: d.stFail, retry: d.retry, record: d.record, stop: d.stop, redo: d.redo,
      overTotal: d.overTotal, noTimeLeft: d.noTimeLeft, limitReached: d.limitReached, docFormat: d.docFormat, docEmpty: d.docEmpty, docTooBig: d.docTooBig(DOC_MAX_MB), docMaxBytes: DOC_MAX_BYTES, maxSec: base == null ? config.limits.maxAnswerSeconds : Math.min(config.limits.maxAnswerSeconds, base), base, saved: Math.round(savedMs / 1000) });
    return gpage(reply, lang, `${d.question} ${n}`, `<p class="qnum">${esc(d.question)} ${n} ${esc(d.of)} ${total}${q.followup ? ' · +' : ''}</p>
<h1 style="font-size:1.6rem">${esc(q.text) || ''}</h1>
${q.audio_asset_id ? `<p><audio id="qaudio" controls preload="none" src="/api/g/media/${q.audio_asset_id}"></audio></p>` : ''}
<p><button type="button" class="ghost" id="listen" data-q="${q.id}" data-text="${esc(q.text)}" data-lang="${lang}">🔊 ${esc(d.listen)}</button>${q.audio_asset_id ? '' : `<br><span class="hint">${esc(d.listenSynth)}</span>`}</p>
<div class="card"><div class="rec" id="guestrec" data-upload="/api/g/respostas/${q.id}" data-msg='${esc(msg)}'>
<div class="timer" id="timer" aria-live="off">0:00</div>${left != null ? `<p class="sans" id="left" style="margin:0">${esc(d.timeLeft)} <strong>${mmss(left)}</strong> <span class="hint">${esc(d.timeLeftNote)}</span></p>` : ''}<button type="button" id="recBtn" class="recbtn" aria-label="${esc(d.record)}" ${noTime ? 'disabled' : ''}>${esc(d.record)}</button>
<div id="review" ${ans?.asset_id && written == null ? '' : 'hidden'} style="width:100%"><audio controls id="player" preload="none" style="width:100%" ${ans?.asset_id && written == null ? `src="/api/g/media/${ans.asset_id}"` : ''}></audio></div>
<div id="textReview"${written != null ? '' : ' hidden'} style="width:100%"><p class="hint" style="margin:0 0 6px">${esc(d.docReview)}</p><blockquote id="textOut" class="written">${esc(written ?? '')}</blockquote></div>
<div class="status" id="st" role="status" aria-live="polite">${noTime ? esc(d.noTimeLeft) : ans?.asset_id ? esc(d.stSaved) : ans?.status === 'refused' ? esc(d.refused) : ''}</div>
<div class="row"><button type="button" class="ghost" id="redoBtn" ${ans?.asset_id && !noTime ? '' : 'hidden'}>${esc(d.redo)}</button></div>
<details><summary class="sans">${esc(d.uploadOwn)}</summary><input type="file" id="fileIn" accept="audio/*" ${noTime ? 'disabled' : ''}></details>
<details><summary class="sans">${esc(d.uploadDoc)}</summary><p class="hint">${esc(d.docHint(DOC_MAX_MB, base == null ? maxAnswerWords() : Math.min(maxAnswerWords(), msToWords(base * 1000))))}</p><input type="file" id="docIn" data-upload="/api/g/respostas/${q.id}/documento" accept=".docx,.txt,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" ${noTime ? 'disabled' : ''}></details></div></div>
<p class="hint">${esc(d.otherAudio)}</p>
<p><a id="next" class="btn accent" style="width:100%;text-align:center;${ans ? '' : 'pointer-events:none;opacity:.5'}" href="${nextHref}" aria-disabled="${ans ? 'false' : 'true'}">${esc(d.confirm)}</a></p>
<form method="post" action="/api/g/respostas/${q.id}/recusar-form"><p><button class="ghost" style="width:100%">${esc(d.refuse)}</button></p></form>
<p style="text-align:center"><a href="/entrevista">${esc(d.saveExit)}</a></p>`, '/static/guest.js');
  });

  // ---- API de respostas ----
  // Espaço dos ficheiros enviados (uploads.ts): a resposta atual da pergunta não conta, porque a nova a substitui.
  const prevTake = (q: Db, questionId: string) => q.one(`SELECT t.id AS take_id, t.asset_id FROM answers an JOIN answer_takes t ON t.id=an.selected_take_id WHERE an.question_id=$1`, [questionId]);
  const currentAnswerAsset = async (questionId: string) => (await prevTake(db, questionId))?.asset_id as string | undefined;
  const noRoom = (reply: FastifyReply, iv: any, r: UploadRefusal) =>
    reply.code(413).send({ error: 'storage', message: uploadRefusalText(r, normLang(iv.interaction_lang) === 'en' ? 'guest-en' : 'guest-pt') });
  app.post('/api/g/respostas/:qid', async (req, reply) => {
    const iv = await needOpen(req, reply); if (!iv) return;
    if (!(await granted(iv.id, 'participation'))) return reply.code(403).send({ error: 'consent' });
    if (!rateLimit(`ans:${iv.id}`, 60, 60_000)) return reply.code(429).send({ error: 'rate' });
    const q = await db.one('SELECT * FROM questions WHERE id=$2 AND interview_id=$1', [iv.id, (req.params as any).qid]);
    if (!q) return reply.code(404).send({ error: 'question' });
    const upId = String(req.headers['x-upload-id'] ?? '').slice(0, 64);
    if (upId) {
      const dup = await db.one(`SELECT t.id, a.duration_ms FROM answer_takes t JOIN assets a ON a.id=t.asset_id JOIN answers an ON an.id=t.answer_id WHERE an.question_id=$1 AND a.meta->>'uploadId'=$2`, [q.id, upId]);
      if (dup) return { ok: true, takeId: dup.id, durationMs: dup.duration_ms, duplicate: true, remainingSec: iv.answer_limit_sec == null ? null : secondsLeft(iv.answer_limit_sec, await answeredMs(db, iv.id)) };
    }
    const data = req.body as Buffer;
    const kind = Buffer.isBuffer(data) ? sniff(data) : null;
    if (!kind || kind.kind !== 'audio') return reply.code(415).send({ error: 'format' });
    const p = await probeAudio(data, kind.ext).catch((e: any) => { req.log.error({ err: String(e?.message ?? e) }, 'probe de áudio falhou'); return { ok: false, durationMs: 0, silent: true }; });
    if (!p.ok || p.durationMs < 400) { req.log.warn({ bytes: data.length, mime: kind.mime, ok: p.ok, durationMs: p.durationMs }, 'resposta recusada: áudio vazio ou ilegível'); return reply.code(422).send({ error: 'empty' }); }
    if (p.durationMs > config.limits.maxAnswerSeconds * 1000 + LIMIT_SLACK_MS) return reply.code(422).send({ error: 'tooLong' });
    // Tempo total das respostas (fixado no convite): a nova gravação substitui a resposta atual desta pergunta.
    const over = (limitSec: number | null, othersMs: number) => limitSec != null && othersMs + p.durationMs > limitSec * 1000 + LIMIT_SLACK_MS;
    const overTotal = (limitSec: number, othersMs: number) => {
      const remainingSec = secondsLeft(limitSec, othersMs)!;
      return reply.code(422).send({ error: 'overTotal', remainingSec, message: t(normLang(iv.interaction_lang)).overTotal.replace('{t}', mmss(remainingSec)) });
    };
    if (iv.answer_limit_sec != null) { // verificação prévia, para não guardar um ficheiro que seria recusado
      const othersMs = await answeredMs(db, iv.id, q.id);
      if (over(iv.answer_limit_sec, othersMs)) return overTotal(iv.answer_limit_sec, othersMs);
    }
    const room = await uploadRoom(db, iv.id, data.length, { except: [await currentAnswerAsset(q.id)] });
    if (room) return noRoom(reply, iv, room);
    const assetId = await saveAsset(db, { interviewId: iv.id, kind: 'answer_audio', mime: kind.mime, ext: kind.ext, data, durationMs: p.durationMs, meta: { uploadId: upId || null, via: String(req.headers['x-upload-via'] ?? 'recording') } });
    const r = await db.tx(async tx => {
      // Soma de todas as respostas com a entrevista bloqueada: gravações em paralelo (ou uma pergunta adicional) não passam o limite.
      const cur = await tx.one('SELECT answer_limit_sec FROM interviews WHERE id=$1 FOR UPDATE', [iv.id]);
      const othersMs = cur.answer_limit_sec == null ? 0 : await answeredMs(tx, iv.id, q.id);
      if (over(cur.answer_limit_sec, othersMs)) return { refused: { limitSec: cur.answer_limit_sec as number, othersMs } };
      const prev = await prevTake(tx, q.id);
      const noSpace = await reserveUploadRoom(tx, iv.id, { except: [prev?.asset_id] });
      if (noSpace) return { noSpace };
      const ans = await tx.one(`INSERT INTO answers(interview_id, question_id, status) VALUES ($1,$2,'answered') ON CONFLICT (question_id) DO UPDATE SET status='answered', updated_at=now() RETURNING id`, [iv.id, q.id]);
      const tk = await tx.one(`INSERT INTO answer_takes(answer_id, asset_id, uploaded_via) VALUES ($1,$2,$3) RETURNING id`, [ans.id, assetId, String(req.headers['x-upload-via'] ?? 'recording') === 'upload' ? 'upload' : 'recording']);
      await tx.query('UPDATE answers SET selected_take_id=$2 WHERE id=$1', [ans.id, tk.id]);
      return { take: tk, prevTakeId: prev?.take_id as string | undefined, remainingSec: secondsLeft(cur.answer_limit_sec, othersMs + p.durationMs) };
    });
    if (r.refused || r.noSpace) { // o ficheiro não chega a ser usado: sai do armazenamento
      await discardAsset(db, assetId, 'refused');
      return r.noSpace ? noRoom(reply, iv, r.noSpace) : overTotal(r.refused!.limitSec, r.refused!.othersMs);
    }
    // A resposta anterior desta pergunta (nunca submetida) sai do disco: só a escolhida é usada.
    await discardReplacedTake(db, iv.id, r.prevTakeId);
    // Resposta alterada depois de guião/episódio aprovado: invalida derivados (sem apagar versões).
    await invalidateDerived(db, iv.id);
    return { ok: true, takeId: r.take.id, assetId, durationMs: p.durationMs, silent: p.silent, remainingSec: r.remainingSec };
  });

  // Resposta escrita: ficheiro Word (.docx) ou texto (.txt). Guarda-se só o texto extraído (sem o ficheiro, que pode
  // trazer autor, comentários e revisões) e a transcrição sai já dele, marcada como «document»: não há transcrição paga.
  app.post('/api/g/respostas/:qid/documento', { bodyLimit: DOC_MAX_BYTES + 1024 }, async (req, reply) => {
    const iv = await needOpen(req, reply); if (!iv) return;
    if (!(await granted(iv.id, 'participation'))) return reply.code(403).send({ error: 'consent' });
    if (!rateLimit(`ans:${iv.id}`, 60, 60_000)) return reply.code(429).send({ error: 'rate' });
    const q = await db.one('SELECT * FROM questions WHERE id=$2 AND interview_id=$1', [iv.id, (req.params as any).qid]);
    if (!q) return reply.code(404).send({ error: 'question' });
    const d = t(normLang(iv.interaction_lang));
    const upId = String(req.headers['x-upload-id'] ?? '').slice(0, 64);
    if (upId) {
      const dup = await db.one(`SELECT t.id, a.duration_ms, a.meta FROM answer_takes t JOIN assets a ON a.id=t.asset_id JOIN answers an ON an.id=t.answer_id WHERE an.question_id=$1 AND a.meta->>'uploadId'=$2`, [q.id, upId]);
      if (dup) return { ok: true, takeId: dup.id, durationMs: dup.duration_ms, duplicate: true, text: await docText(dup.id), words: dup.meta?.words ?? null, remainingSec: iv.answer_limit_sec == null ? null : secondsLeft(iv.answer_limit_sec, await answeredMs(db, iv.id)) };
    }
    const body = req.body as unknown;
    const data = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body, 'utf8') : null;
    if (!data) return reply.code(415).send({ error: 'format', message: d.docFormat });
    let doc;
    try { doc = extractAnswerText(data); }
    catch (e: any) {
      if (!(e instanceof DocError)) throw e;
      req.log.warn({ bytes: data.length, reason: e.message }, 'resposta escrita recusada');
      return e.code === 'empty' ? reply.code(422).send({ error: 'empty', message: d.docEmpty })
        : e.code === 'tooBig' ? reply.code(413).send({ error: 'tooBig', message: d.docTooBig(DOC_MAX_MB) })
        : reply.code(415).send({ error: 'format', message: d.docFormat });
    }
    if (doc.words > maxAnswerWords()) return reply.code(422).send({ error: 'tooLong', message: d.docTooLong(doc.words, maxAnswerWords()) });
    const durationMs = wordsToMs(doc.words);
    const maxChars = writtenMaxChars(durationMs);
    if (doc.text.length > maxChars) return reply.code(422).send({ error: 'tooLong', message: d.docTooManyChars(doc.text.length, maxChars) });
    const over = (limitSec: number | null, othersMs: number) => limitSec != null && othersMs + durationMs > limitSec * 1000 + LIMIT_SLACK_MS;
    const overTotal = (limitSec: number, othersMs: number) => {
      const remainingSec = secondsLeft(limitSec, othersMs)!;
      return reply.code(422).send({ error: 'overTotal', remainingSec, message: d.docOverTotal(msToWords(remainingSec * 1000)) });
    };
    if (iv.answer_limit_sec != null) {
      const othersMs = await answeredMs(db, iv.id, q.id);
      if (over(iv.answer_limit_sec, othersMs)) return overTotal(iv.answer_limit_sec, othersMs);
    }
    const textBytes = Buffer.byteLength(doc.text, 'utf8');
    const room = await uploadRoom(db, iv.id, textBytes, { except: [await currentAnswerAsset(q.id)] });
    if (room) return noRoom(reply, iv, room);
    const assetId = await saveAsset(db, { interviewId: iv.id, kind: 'answer_text', mime: 'text/plain; charset=utf-8', ext: 'txt', data: Buffer.from(doc.text, 'utf8'), durationMs, meta: { uploadId: upId || null, via: 'document', format: doc.format, words: doc.words, estimated: true } });
    const r = await db.tx(async tx => {
      const cur = await tx.one('SELECT answer_limit_sec FROM interviews WHERE id=$1 FOR UPDATE', [iv.id]);
      const othersMs = cur.answer_limit_sec == null ? 0 : await answeredMs(tx, iv.id, q.id);
      if (over(cur.answer_limit_sec, othersMs)) return { refused: { limitSec: cur.answer_limit_sec as number, othersMs } };
      const prev = await prevTake(tx, q.id);
      const noSpace = await reserveUploadRoom(tx, iv.id, { except: [prev?.asset_id] });
      if (noSpace) return { noSpace };
      const ans = await tx.one(`INSERT INTO answers(interview_id, question_id, status) VALUES ($1,$2,'answered') ON CONFLICT (question_id) DO UPDATE SET status='answered', updated_at=now() RETURNING id`, [iv.id, q.id]);
      const tk = await tx.one(`INSERT INTO answer_takes(answer_id, asset_id, uploaded_via) VALUES ($1,$2,'document') RETURNING id`, [ans.id, assetId]);
      await tx.query('UPDATE answers SET selected_take_id=$2 WHERE id=$1', [ans.id, tk.id]);
      // O texto do convidado é a transcrição (revisão 1, origem «document»); o editor pode revê-la como as outras.
      await tx.query(`INSERT INTO transcripts(interview_id, source_kind, source_id, revision, text, language, origin) VALUES ($1,'answer_take',$2,1,$3,$4,'document')`,
        [iv.id, tk.id, doc.text, iv.answer_lang && iv.answer_lang !== 'auto' ? iv.answer_lang : null]);
      return { take: tk, prevTakeId: prev?.take_id as string | undefined, remainingSec: secondsLeft(cur.answer_limit_sec, othersMs + durationMs) };
    });
    if (r.refused || r.noSpace) {
      await discardAsset(db, assetId, 'refused');
      return r.noSpace ? noRoom(reply, iv, r.noSpace) : overTotal(r.refused!.limitSec, r.refused!.othersMs);
    }
    await discardReplacedTake(db, iv.id, r.prevTakeId);
    await invalidateDerived(db, iv.id);
    return { ok: true, takeId: r.take.id, assetId, durationMs, words: doc.words, text: doc.text, remainingSec: r.remainingSec };
  });

  /** Texto original de uma resposta escrita (a revisão 1, a do convidado). */
  const docText = async (takeId: string | null) => takeId
    ? ((await db.one(`SELECT text FROM transcripts WHERE source_kind='answer_take' AND source_id=$1 AND origin='document' ORDER BY revision LIMIT 1`, [takeId]))?.text ?? '') : '';

  const refuse = async (iv: any, qid: string) => {
    const q = await db.one('SELECT id FROM questions WHERE id=$2 AND interview_id=$1', [iv.id, qid]);
    if (!q) return false;
    const prev = await prevTake(db, q.id);
    await db.query(`INSERT INTO answers(interview_id, question_id, status, selected_take_id) VALUES ($1,$2,'refused',NULL) ON CONFLICT (question_id) DO UPDATE SET status='refused', selected_take_id=NULL, updated_at=now()`, [iv.id, q.id]);
    await discardReplacedTake(db, iv.id, prev?.take_id);
    await invalidateDerived(db, iv.id);
    return true;
  };
  app.post('/api/g/respostas/:qid/recusar-form', async (req, reply) => {
    const iv = await needOpen(req, reply); if (!iv) return;
    const qid = (req.params as any).qid;
    if (!(await refuse(iv, qid))) return reply.code(404).send();
    const q = await db.one('SELECT position FROM questions WHERE id=$1', [qid]);
    const total = Number((await db.one('SELECT count(*)::int AS n FROM questions WHERE interview_id=$1', [iv.id]))?.n);
    return reply.redirect(q.position < total ? `/entrevista/p/${q.position + 1}` : '/entrevista/fotos');
  });

  app.get('/api/g/media/:assetId', async (req, reply) => {
    const iv = await needApi(req, reply); if (!iv) return;
    const id = (req.params as any).assetId;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send();
    // Só ativos desta entrevista e de tipos que o convidado pode ouvir/ver.
    const a = await db.one(`SELECT * FROM assets WHERE id=$1 AND interview_id=$2 AND deleted_at IS NULL AND kind IN ('question_audio','question_tts','answer_audio','guest_photo','episode_audio','episode_cover','episode_video')`, [id, iv.id]);
    if (!a) return reply.code(404).send();
    // Um vídeo desligado (autorização retirada, versão antiga) deixa de ser servido.
    if (a.kind === 'episode_video' && !(await db.one('SELECT 1 FROM episodes WHERE interview_id=$1 AND video_asset_id=$2', [iv.id, id]))) return reply.code(404).send();
    return sendAsset(req, reply, a);
  });

  app.get('/api/g/leitura/:qid', async (req, reply) => {
    const iv = await needApi(req, reply); if (!iv) return;
    const q = await db.one('SELECT * FROM questions WHERE id=$2 AND interview_id=$1', [iv.id, (req.params as any).qid]);
    const ent = await entityOfInterview(db, iv.id);
    // Pergunta gravada pelo entrevistador: ouve-se a gravação, nunca uma leitura sintética por cima ou em vez dela.
    if (!q || !q.text || q.audio_asset_id || !inEntity(ent, () => aiAvailable())) return reply.code(404).send();
    const gender = iv.question_voice === 'male' ? 'male' : 'female';
    let asset = q.tts_asset_id && await db.one('SELECT * FROM assets WHERE id=$1', [q.tts_asset_id]);
    // A leitura guardada só serve se foi feita com a voz atual e para o texto atual.
    if (asset && (asset.meta?.voice !== READING_VOICES[gender] || asset.meta?.text !== q.text)) asset = null;
    if (!asset) {
      if (!rateLimit(`tts:${iv.id}`, 30, 3600_000)) return reply.code(429).send();
      // 1.ª entrevista grátis: leituras novas com total por entrevista, contado na base (a voz das perguntas pode mudar depois
      // do convite, e cada mudança refaz as leituras); acima dele, 404 e a página usa a leitura do navegador.
      const free = !!iv.free_at;
      const nq = free ? Number((await db.one('SELECT count(*)::int AS n FROM questions WHERE interview_id=$1', [iv.id]))?.n ?? 0) : 0;
      if (free && !(await takeAiUse(db, iv.id, 'question_reading', FREE_READINGS_PER_QUESTION * nq))) return reply.code(404).send();
      const s = await inEntity(ent, () => readQuestion(q.text, gender, iv.interaction_lang)).catch((e: any) => { req.log.error({ err: String(e?.message ?? e) }, 'leitura da pergunta falhou'); return null; });
      if (!s) { if (free) await giveBackAiUse(db, iv.id, 'question_reading'); return reply.code(404).send(); }
      const id = await saveAsset(db, { interviewId: iv.id, kind: 'question_tts', mime: s.mime, ext: s.ext, data: s.data, meta: { voice: s.voice, text: q.text } });
      await db.query('UPDATE questions SET tts_asset_id=$2 WHERE id=$1', [q.id, id]);
      asset = await db.one('SELECT * FROM assets WHERE id=$1', [id]);
    }
    return sendAsset(req, reply, asset);
  });

  // ---- fotografias ----
  app.get('/entrevista/fotos', async (req, reply) => {
    const c = await need(req, reply); if (!c) return;
    const { iv, lang } = c, d = t(lang);
    if (!(await granted(iv.id, 'participation'))) return reply.redirect('/entrevista');
    const [pc, cu, pp, an, av, he] = await Promise.all([granted(iv.id, 'photo_capture'), granted(iv.id, 'cover_use'), granted(iv.id, 'publish_photo'), granted(iv.id, 'animate_portrait'), granted(iv.id, 'ai_video'), granted(iv.id, 'host_edit')]);
    const done = iv.collection_status === 'submitted';
    // As fotografias que o entrevistador acrescentou (com a autorização de edição) aparecem aqui também: o convidado vê-as e
    // pode retirá-las; só as dele contam para as três.
    const photos = await db.query('SELECT * FROM photos WHERE interview_id=$1 ORDER BY created_at', [iv.id]);
    const own = photos.filter((p: any) => p.added_by !== 'host').length;
    const msg = JSON.stringify({ camDenied: d.camDenied, max3: d.max3, stUp: d.stUp, stFail: d.stFail });
    return gpage(reply, lang, d.photos, `<h1>${esc(d.photos)}</h1><p>${esc(d.photosIntro)}</p>
<form method="post" action="/entrevista/fotos/autorizacoes" class="card">${cb('photo_capture', d.c_photo, pc)}${cb('cover_use', d.c_cover, cu)}${cb('publish_photo', d.c_pubphoto, pp)}${cb('animate_portrait', d.c_animate, an)}${cb('ai_video', d.c_aivideo, av)}${cb('host_edit', consentText(lang, 'host_edit', iv.review_policy), he)}<button class="ghost">${esc(d.save)}</button></form>
${pc && !done ? `<div class="card" id="cam" data-max="3" data-msg='${esc(msg)}'>
<div class="thumbs" id="thumbs">${photos.map((p: any) => `<div><img alt="" src="/api/g/media/${p.asset_id}">${p.added_by === 'host' ? `<span class="hint">${esc(d.photoByHost)}</span>` : ''}<form method="post" action="/api/g/fotos/${p.id}/eliminar-form"><button class="ghost" style="width:100%">${esc(d.discard)}</button></form></div>`).join('')}</div>
<video id="vid" class="cam" autoplay playsinline muted hidden></video><canvas id="cv" hidden></canvas><div class="status" id="pst" role="status"></div>
<div class="row"><button type="button" id="camBtn" class="ghost" ${own >= 3 ? 'disabled' : ''}>${esc(d.openCamera)}</button><button type="button" id="shotBtn" class="accent" hidden>${esc(d.take)}</button></div>
<div id="prev" hidden><img id="prevImg" alt="" style="width:100%;border-radius:12px"><div class="row"><button type="button" id="keepBtn" class="accent">${esc(d.keep)}</button><button type="button" id="dropBtn" class="ghost">${esc(d.discard)}</button></div></div>
<details><summary class="sans">${esc(d.photoUpload)}</summary><input type="file" id="photoIn" accept="image/*" ${own >= 3 ? 'disabled' : ''}></details></div>` : ''}
${done && photos.some((p: any) => p.added_by === 'host') ? `<div class="card"><p class="sans" style="margin-top:0"><strong>${esc(d.photoByHost)}</strong></p><div class="thumbs">${photos.filter((p: any) => p.added_by === 'host').map((p: any) => `<div><img alt="" src="/api/g/media/${p.asset_id}"><form method="post" action="/api/g/fotos/${p.id}/eliminar-form"><button class="ghost" style="width:100%">${esc(d.discard)}</button></form></div>`).join('')}</div></div>` : ''}
<p><a class="btn accent" style="width:100%;text-align:center" href="${done ? '/entrevista/obrigado' : '/entrevista/rever'}">${esc(done ? d.continue : photos.length ? d.photosDone : d.skipPhotos)}</a></p>`, '/static/photos.js');
  });

  app.post('/entrevista/fotos/autorizacoes', async (req, reply) => {
    const c = await need(req, reply); if (!c) return;
    const b = req.body as any;
    await recordConsent(c.iv, c.lang, 'photo_capture', !!b.photo_capture);
    await recordConsent(c.iv, c.lang, 'cover_use', !!b.photo_capture && !!b.cover_use);
    await recordConsent(c.iv, c.lang, 'publish_photo', !!b.photo_capture && !!b.publish_photo);
    await recordConsent(c.iv, c.lang, 'animate_portrait', !!b.photo_capture && !!b.publish_photo && !!b.animate_portrait);
    await recordConsent(c.iv, c.lang, 'ai_video', !!b.photo_capture && !!b.publish_photo && !!b.ai_video);
    await recordConsent(c.iv, c.lang, 'host_edit', !!b.host_edit);
    // Autorização retirada: o vídeo que usava a fotografia (ou a animação) deixa de ser servido; o ficheiro fica privado.
    const noPhoto = !(b.photo_capture && b.publish_photo), noAnim = noPhoto || !b.animate_portrait, noVeo = noPhoto || !b.ai_video, noHostPhoto = noPhoto || !b.host_edit;
    for (const e of await db.query(`SELECT e.id, a.meta FROM episodes e JOIN assets a ON a.id=e.video_asset_id WHERE e.interview_id=$1`, [c.iv.id])) {
      if ((noPhoto && e.meta?.guestPhoto) || (noAnim && e.meta?.guestAnimated) || (noVeo && e.meta?.guestAiVideo) || (noHostPhoto && e.meta?.guestPhotoByHost)) await db.query('UPDATE episodes SET video_asset_id=NULL WHERE id=$1', [e.id]);
    }
    // RGPD (art. 7.º, n.º 3, e art. 17.º): sem a autorização, os clipes e os vídeos com a imagem animada do convidado são
    // apagados; o que foi entregue continua cobrado e o vídeo pode ser reconstruído só com o entrevistador, a 0 créditos.
    if (noVeo || noAnim) {
      const erased = await eraseGuestAiVideo(db, c.iv.id, { veo: noVeo, animated: noAnim });
      if (erased) await audit(db, 'guest', 'consent.guest_ai_video_erased', c.iv.id, { files: erased });
    }
    if (!b.photo_capture && c.iv.collection_status !== 'submitted') await removeAllPhotos(c.iv.id);
    await audit(db, 'guest', 'consent.photos_updated', c.iv.id);
    return reply.redirect('/entrevista/fotos');
  });

  const removeAllPhotos = async (interviewId: string) => {
    const ps = await db.query(`SELECT p.id, a.id AS aid, a.storage_key FROM photos p JOIN assets a ON a.id=p.asset_id WHERE p.interview_id=$1`, [interviewId]);
    for (const p of ps) { await db.query('DELETE FROM photos WHERE id=$1', [p.id]); await db.query('UPDATE assets SET deleted_at=now() WHERE id=$1', [p.aid]); await storage.remove(p.storage_key); }
  };

  app.post('/api/g/fotos', async (req, reply) => {
    const iv = await needOpen(req, reply); if (!iv) return;
    if (!(await granted(iv.id, 'photo_capture'))) return reply.code(403).send({ error: 'consent' });
    const n = Number((await db.one(`SELECT count(*)::int AS n FROM photos WHERE interview_id=$1 AND added_by='guest'`, [iv.id]))?.n);
    if (n >= 3) return reply.code(409).send({ error: 'max' });
    const data = req.body as Buffer;
    const kind = Buffer.isBuffer(data) ? sniff(data) : null;
    if (!kind || kind.kind !== 'image') return reply.code(415).send({ error: 'format' });
    const clean = kind.mime === 'image/jpeg' ? stripJpegMetadata(data) : data;
    // Cada envio descodifica a fotografia (e uma recusada não conta para as 3): um limite por entrevista contra pedidos em série.
    if (!rateLimit(`foto:${iv.id}`, 10, 60_000)) return reply.code(429).send({ error: 'rate' });
    // A assinatura não chega: antes, uma fotografia com a assinatura JPEG e o conteúdo corrompido era guardada e só falhava
    // no sharp, na capa do episódio, depois de pagas a voz, os tempos das legendas e as traduções, em cada tentativa.
    if (!(await photoDecodes(clean))) return reply.code(415).send({ error: 'format' });
    const room = await uploadRoom(db, iv.id, clean.length);
    if (room) return noRoom(reply, iv, room);
    const assetId = await saveAsset(db, { interviewId: iv.id, kind: 'guest_photo', mime: kind.mime, ext: kind.ext, data: clean });
    const ph = await db.tx(async tx => {
      await tx.one('SELECT 1 FROM interviews WHERE id=$1 FOR UPDATE', [iv.id]);
      const noSpace = await reserveUploadRoom(tx, iv.id);
      return noSpace ? { noSpace } : tx.one('INSERT INTO photos(interview_id, asset_id) VALUES ($1,$2) RETURNING id', [iv.id, assetId]);
    });
    if (ph.noSpace) { await discardAsset(db, assetId, 'refused'); return noRoom(reply, iv, ph.noSpace); }
    return { ok: true, id: ph.id, assetId };
  });
  app.post('/api/g/fotos/:id/eliminar-form', async (req, reply) => {
    const iv = await needApi(req, reply); if (!iv) return;
    // Depois de submeter, o convidado só retira as fotografias que o entrevistador acrescentou (as dele ficam na submissão).
    const p = await db.one(`SELECT p.id, a.id AS aid, a.storage_key FROM photos p JOIN assets a ON a.id=p.asset_id WHERE p.id=$2 AND p.interview_id=$1 AND ($3::boolean OR p.added_by='host')`, [iv.id, (req.params as any).id, iv.collection_status !== 'submitted']);
    if (p) { await db.query('DELETE FROM photos WHERE id=$1', [p.id]); await db.query('UPDATE assets SET deleted_at=now() WHERE id=$1', [p.aid]); await storage.remove(p.storage_key); }
    return reply.redirect('/entrevista/fotos');
  });

  // ---- revisão e submissão ----
  /**
   * Texto de uma autorização tal como foi aceite (o retrato guardado com a versão de então), não o texto atual: quem
   * autorizou na v1 vê o que autorizou. Na participação, só a frase da caixa (o retrato leva também a informação de base).
   */
  const consentShown = (x: any, lang: Lang, policy?: string) =>
    String(x.text_snapshot ?? '').split('\n')[0].trim() || consentText(lang, x.purpose as ConsentPurpose, policy);
  const summary = async (iv: any) => {
    const qs = await db.query(`SELECT q.*, a.status, a.selected_take_id, t.asset_id, t.uploaded_via, ast.duration_ms FROM questions q LEFT JOIN answers a ON a.question_id=q.id
      LEFT JOIN answer_takes t ON t.id=a.selected_take_id LEFT JOIN assets ast ON ast.id=t.asset_id WHERE q.interview_id=$1 ORDER BY q.position`, [iv.id]);
    for (const q of qs) if (q.status === 'answered' && q.uploaded_via === 'document') q.written = await docText(q.selected_take_id);
    const photos = await db.query('SELECT * FROM photos WHERE interview_id=$1 ORDER BY created_at', [iv.id]);
    const consents = await db.query(`SELECT DISTINCT ON (purpose) purpose, granted, text_snapshot FROM consents WHERE interview_id=$1 ORDER BY purpose, created_at DESC`, [iv.id]);
    return { qs, photos, consents, complete: qs.length > 0 && qs.every((q: any) => q.status === 'answered' || q.status === 'refused') };
  };

  app.get('/entrevista/rever', async (req, reply) => {
    const c = await need(req, reply); if (!c) return;
    const { iv, lang } = c, d = t(lang);
    if (iv.collection_status === 'submitted') return reply.redirect('/entrevista/obrigado');
    const s = await summary(iv);
    return gpage(reply, lang, d.review, `<h1>${esc(d.review)}</h1><h2>${esc(d.yourAnswers)}</h2>
<ol class="sans" style="padding-left:20px">${s.qs.map((q: any) => `<li style="margin:10px 0">${esc(q.text)}<br>${q.status === 'answered' && q.written != null ? `<span class="hint">${esc(d.textAnswer)}</span><blockquote class="written">${esc(q.written)}</blockquote>` : q.status === 'answered' ? `<audio controls preload="none" src="/api/g/media/${q.asset_id}" style="width:100%"></audio>` : q.status === 'refused' ? pill(d.refused, 'warn') : pill('⚠', 'bad')}</li>`).join('')}</ol>
<h2>${esc(d.photos)}</h2>${s.photos.length ? `<div class="thumbs">${s.photos.map((p: any) => `<img alt="" src="/api/g/media/${p.asset_id}">`).join('')}</div>` : `<p class="hint">${esc(d.noPhotos)}</p>`}
<ul class="sans">${s.consents.map((x: any) => `<li>${x.granted ? '✔' : '✘'} ${esc(consentShown(x, lang, iv.review_policy))}</li>`).join('')}</ul>
${s.complete ? `<form method="post" action="/entrevista/submeter" onsubmit="return confirm('${esc(d.submitConfirm)}')"><p><button class="accent" style="width:100%">${esc(d.submit)}</button></p></form>` : `<div class="flash bad">${esc(d.pendingUploads)}</div><p><a class="btn" href="/entrevista">${esc(d.continue)}</a></p>`}`);
  });

  app.post('/entrevista/submeter', async (req, reply) => {
    const c = await need(req, reply); if (!c) return;
    const { iv } = c;
    if (iv.collection_status === 'submitted') return reply.redirect('/entrevista/obrigado'); // clique duplo
    const s = await summary(iv);
    if (!s.complete) return reply.redirect('/entrevista/rever');
    const snapshot = {
      interviewId: iv.id, questionVersion: iv.version, submittedAt: new Date().toISOString(),
      answers: s.qs.map((q: any) => ({ questionId: q.id, status: q.status, assetId: q.asset_id ?? null, ...(q.uploaded_via === 'document' ? { via: 'document' } : {}) })),
      photos: s.photos.map((p: any) => p.asset_id), consents: s.consents.map((x: any) => ({ purpose: x.purpose, granted: x.granted })),
    };
    const sub = await db.tx(async tx => {
      const locked = await tx.one(`UPDATE interviews SET collection_status='submitted', submitted_at=now() WHERE id=$1 AND collection_status<>'submitted' RETURNING id`, [iv.id]);
      if (!locked) return null;
      return tx.one('INSERT INTO submissions(interview_id, snapshot) VALUES ($1,$2) RETURNING id', [iv.id, JSON.stringify(snapshot)]);
    });
    if (!sub) return reply.redirect('/entrevista/obrigado');
    const refused = s.qs.filter((q: any) => q.status === 'refused').length;
    const owner = await db.one('SELECT u.email, u.name FROM users u WHERE u.id=$1', [iv.owner_id]);
    const url = `${config.baseUrl}/entrevistas/${iv.id}/producao`;
    await queueEmail(db, {
      key: `submitted:${sub.id}`, interviewId: iv.id, to: owner.email, subject: `Entrevista concluída — ${iv.title}`,
      html: emailShell('Entrevista concluída', `<p><strong>${esc(iv.guest_name)}</strong> concluiu a entrevista “${esc(iv.title)}”.</p>
<p>Submetida em ${esc(fmtDate(new Date()))}<br>Respostas: ${s.qs.length - refused} de ${s.qs.length}<br>Fotografias: ${s.photos.length}<br>Perguntas recusadas: ${refused}</p>
<p>Quer processar o podcast? Reveja primeiro os originais e as autorizações; nada é processado até confirmar.</p>`, { label: 'Rever e processar podcast', url }),
      text: `${iv.guest_name} concluiu a entrevista "${iv.title}". Respostas: ${s.qs.length - refused}/${s.qs.length}; fotografias: ${s.photos.length}; recusas: ${refused}.\nRever e processar podcast: ${url}`,
    });
    await audit(db, 'guest', 'interview.submitted', iv.id, { submissionId: sub.id });
    return reply.redirect('/entrevista/obrigado');
  });

  app.get('/entrevista/obrigado', async (req, reply) => {
    const c = await need(req, reply); if (!c) return;
    const { iv, lang } = c, d = t(lang);
    const sub = await db.one('SELECT * FROM submissions WHERE interview_id=$1 ORDER BY created_at DESC LIMIT 1', [iv.id]);
    const ep = guestDecides(await guestReview(db, iv)); // há um episódio por publicar que o convidado valida
    return gpage(reply, lang, d.thanks, `<h1>${esc(d.thanks)}</h1><p>${esc(d.thanksText)}</p>
<div class="card sans"><strong>${esc(d.receipt)}</strong><br>${esc(iv.title)}<br>${esc(fmtDate(sub?.created_at))}<br><code>${esc(sub?.id ?? '')}</code></div>
<p class="hint">${esc(d.helpLine)} <a href="/entrevista/ajuda">${esc(d.supportTitle)}</a></p><p><a href="/entrevista/fotos">${esc(d.photoAuth)}</a></p>${ep ? `<p><a class="btn accent" href="/entrevista/episodio">${esc(d.episodePreview)}</a></p>` : ''}`);
  });
}

/** Alteração a respostas invalida aprovações e marca derivados como desatualizados — sem apagar versões anteriores. */
export async function invalidateDerived(db: any, interviewId: string) {
  await db.query(`UPDATE scripts SET status='stale' WHERE interview_id=$1 AND status IN ('draft','approved')`, [interviewId]);
  await db.query(`UPDATE approvals SET valid=false WHERE interview_id=$1 AND valid`, [interviewId]);
  await db.query(`UPDATE episodes SET stale=true WHERE interview_id=$1`, [interviewId]);
  await db.query(`UPDATE interviews SET production_status=CASE WHEN production_status IN ('not_requested','queued','failed') THEN production_status ELSE 'stale' END WHERE id=$1`, [interviewId]);
}
