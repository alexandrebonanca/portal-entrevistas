import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { esc, sha256, newToken, rateLimit, fmtDate } from '../lib.ts';
import { page, flash, pill } from '../views.ts';
import { setSessionCookie, audit, sendAsset } from '../app.ts';
import { t, normLang, consentText, CONSENT_VERSION, type Lang, type ConsentPurpose } from '../i18n.ts';
import { sniff, stripJpegMetadata, saveAsset, probeAudio } from '../media.ts';
import { queueEmail, emailShell } from '../mail.ts';
import { createInvitation } from '../invites.ts';
import { aiAvailable, synthesizeSpeech } from '../ai/openai.ts';
import { storage } from '../storage.ts';
import { inEntity, entityOfInterview } from '../settings.ts';

const H = { 'Content-Type': 'text/html; charset=utf-8' };

export async function guestRoutes(app: FastifyInstance) {
  const db = app.db;

  const gpage = (reply: FastifyReply, lang: Lang, title: string, body: string, script?: string) =>
    reply.headers({ ...H, 'Cache-Control': 'no-store' }).send(page({ lang, title, body: `<div class="narrow" style="padding:28px 20px 0">${body}</div>`, noindex: true, script, nav: '' }));

  const loadInvitation = async (token: string) =>
    db.one(`SELECT inv.*, i.title, i.host_name, i.interaction_lang, i.guest_email, i.guest_name, i.id AS iid, i.collection_status
            FROM invitations inv JOIN interviews i ON i.id=inv.interview_id WHERE inv.token_hash=$1`, [sha256(token)]);

  // ---- convite: GET só mostra; nada é consumido ----
  app.get('/i/:token', async (req, reply) => {
    const inv = await loadInvitation((req.params as any).token);
    if (!inv) return gpage(reply, 'en', 'Link', `<h1>Link not valid</h1><p>This link is not valid. Please check the email you received.</p>`);
    const lang = normLang(inv.interaction_lang), d = t(lang);
    if (inv.declined_at) return gpage(reply, lang, d.inviteTitle, `<p>${esc(d.declined)}</p>`);
    if (inv.revoked_at || new Date(inv.expires_at) < new Date()) {
      const q = req.query as any;
      return gpage(reply, lang, d.expired, `<h1>${esc(d.expired)}</h1><p>${esc(d.expiredHelp)}</p>${q.sent ? flash(d.resendDone) : ''}
<form method="post" action="/i/${esc((req.params as any).token)}/novo-link" class="card"><label for="em">${esc(d.yourEmail)}</label><input id="em" name="email" type="email" required autocomplete="email"><p><button class="accent">${esc(d.resendBtn)}</button></p></form>`);
    }
    const nQ = Number((await db.one('SELECT count(*)::int AS n FROM questions WHERE interview_id=$1', [inv.iid]))?.n);
    return gpage(reply, lang, d.inviteTitle, `<h1>${esc(inv.title)}</h1><p>${esc(d.invitedBy(inv.host_name))}</p><p class="hint">${esc(d.qCount(nQ))}</p>
<form method="post" action="/i/${esc((req.params as any).token)}/abrir"><p><button class="accent" style="width:100%">${esc(d.open)}</button></p></form>
<form method="post" action="/i/${esc((req.params as any).token)}/recusar" onsubmit="return confirm('${esc(d.decline)}?')"><p><button class="ghost" style="width:100%">${esc(d.decline)}</button></p></form>`);
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
    return reply.redirect(inv.collection_status === 'submitted' ? '/entrevista/obrigado' : '/entrevista'); // o token deixa de aparecer no URL
  });

  app.post('/i/:token/recusar', async (req, reply) => {
    const inv = await loadInvitation((req.params as any).token);
    if (inv && !inv.declined_at && !inv.revoked_at) {
      await db.query('UPDATE invitations SET declined_at=now() WHERE id=$1', [inv.id]);
      const owner = await db.one('SELECT u.email FROM users u JOIN interviews i ON i.owner_id=u.id WHERE i.id=$1', [inv.iid]);
      await audit(db, 'guest', 'invitation.declined', inv.iid);
      if (owner) await queueEmail(db, { key: `declined:${inv.id}`, interviewId: inv.iid, to: owner.email, subject: `Convite recusado — ${inv.title}`,
        html: emailShell('Convite recusado', `<p>${esc(inv.guest_name)} indicou que não pretende participar na entrevista “${esc(inv.title)}”.</p>`), text: `${inv.guest_name} não pretende participar em "${inv.title}".` });
    }
    return reply.redirect(`/i/${(req.params as any).token}`);
  });

  // Novo link por email original (resposta genérica; limite e cooldown).
  app.post('/i/:token/novo-link', async (req, reply) => {
    const tk = (req.params as any).token;
    const inv = await loadInvitation(tk);
    const email = String((req.body as any)?.email ?? '').trim().toLowerCase();
    if (inv && !inv.declined_at && inv.collection_status !== 'cancelled' && email === String(inv.guest_email).toLowerCase()
        && rateLimit(`newlink:${inv.iid}`, 1, config.limits.resendCooldownSec * 1000) && rateLimit(`newlink-ip:${req.ip}`, 10, 3600_000)) {
      const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [inv.iid]);
      const owner = await db.one('SELECT name FROM users WHERE id=$1', [iv.owner_id]);
      await createInvitation(db, iv, { name: owner?.name ?? '' });
      await audit(db, 'guest', 'invitation.renewed', inv.iid);
    }
    return reply.redirect(`/i/${tk}?sent=1`);
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
      [iv.id, purpose, ok, CONSENT_VERSION, consentText(lang, purpose) + (purpose === 'participation' ? '\n' + t(lang).consentLong : '')]);
  };
  const cb = (name: string, label: string, checked: boolean, req = false) => `<label class="check"><input type="checkbox" name="${name}" value="1" ${checked ? 'checked' : ''} ${req ? 'required' : ''}> <span>${esc(label)}</span></label>`;

  app.get('/entrevista', async (req, reply) => {
    const c = await need(req, reply); if (!c) return;
    const { iv, lang } = c, d = t(lang);
    if (!(await granted(iv.id, 'participation'))) {
      const processing = await granted(iv.id, 'processing'), publish = await granted(iv.id, 'publish');
      return gpage(reply, lang, iv.title, `<h1>${esc(iv.title)}</h1>
${iv.objective_shared && iv.objective_text ? `<h2>${esc(d.objective)}</h2><p>${esc(iv.objective_text)}</p>` : ''}
<h2>${esc(d.beforeStart)}</h2><p>${esc(d.consentLong)}</p><p class="hint">${esc(d.consentIntro)}</p>
<form method="post" action="/entrevista/consentimentos" class="card">${cb('participation', d.c_participation, false, true)}${cb('processing', d.c_processing, processing)}${cb('publish', d.c_publish, publish)}${cb('adult', d.adults, false, true)}
<p><button class="accent" style="width:100%">${esc(d.start)}</button></p></form>
<p class="hint">${esc(d.contact)} ${esc(config.supportEmail)}</p>`);
    }
    const qs = await db.query(`SELECT q.*, a.status FROM questions q LEFT JOIN answers a ON a.question_id=q.id WHERE q.interview_id=$1 ORDER BY q.position`, [iv.id]);
    const next = qs.find((q: any) => !q.status) ?? qs[0];
    return gpage(reply, lang, iv.title, `<h1>${esc(iv.title)}</h1>
${iv.objective_shared && iv.objective_text ? `<p>${esc(iv.objective_text)}</p>` : ''}
<ol class="sans" style="padding-left:20px">${qs.map((q: any) => `<li style="margin:8px 0"><a href="/entrevista/p/${q.position}">${esc(q.text) || '…'}</a> ${q.status === 'answered' ? pill(d.answered, 'ok') : q.status === 'refused' ? pill('—', 'warn') : ''}</li>`).join('')}</ol>
<p><a class="btn accent" style="width:100%;text-align:center" href="/entrevista/p/${next.position}">${esc(d.continue)}</a></p>
<p><a href="/entrevista/fotos">${esc(d.photos)}</a> · <a href="/entrevista/rever">${esc(d.review)}</a></p>`);
  });

  app.post('/entrevista/consentimentos', async (req, reply) => {
    const c = await need(req, reply); if (!c) return;
    const b = req.body as any;
    if (!b.participation || !b.adult) return reply.redirect('/entrevista');
    await recordConsent(c.iv, c.lang, 'participation', true);
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
    const ans = await db.one(`SELECT a.*, t.asset_id FROM answers a LEFT JOIN answer_takes t ON t.id=a.selected_take_id WHERE a.question_id=$1`, [q.id]);
    const nextHref = n < total ? `/entrevista/p/${n + 1}` : '/entrevista/fotos';
    const msg = JSON.stringify({ micDenied: d.micDenied, micNone: d.micNone, empty: d.empty, silent: d.silent, tooLong: d.tooLong, stLocal: d.stLocal, stUp: d.stUp, stSaved: d.stSaved, stFail: d.stFail, retry: d.retry, record: d.record, stop: d.stop, redo: d.redo, maxSec: config.limits.maxAnswerSeconds });
    return gpage(reply, lang, `${d.question} ${n}`, `<p class="qnum">${esc(d.question)} ${n} ${esc(d.of)} ${total}${q.followup ? ' · +' : ''}</p>
<h1 style="font-size:1.6rem">${esc(q.text) || ''}</h1>
${q.audio_asset_id ? `<p><audio controls preload="none" src="/api/g/media/${q.audio_asset_id}"></audio></p>` : ''}
<p><button type="button" class="ghost" id="listen" data-q="${q.id}" data-text="${esc(q.text)}" data-lang="${lang}">🔊 ${esc(q.audio_asset_id ? d.listen : d.listenSynth)}</button></p>
<div class="card"><div class="rec" id="guestrec" data-upload="/api/g/respostas/${q.id}" data-msg='${esc(msg)}'>
<div class="timer" id="timer" aria-live="off">0:00</div><button type="button" id="recBtn" class="recbtn" aria-label="${esc(d.record)}">${esc(d.record)}</button>
<div id="review" ${ans?.asset_id ? '' : 'hidden'} style="width:100%"><audio controls id="player" preload="none" style="width:100%" ${ans?.asset_id ? `src="/api/g/media/${ans.asset_id}"` : ''}></audio></div>
<div class="status" id="st" role="status" aria-live="polite">${ans?.asset_id ? esc(d.stSaved) : ans?.status === 'refused' ? esc(d.refused) : ''}</div>
<div class="row"><button type="button" class="ghost" id="redoBtn" ${ans?.asset_id ? '' : 'hidden'}>${esc(d.redo)}</button></div>
<details><summary class="sans">${esc(d.uploadOwn)}</summary><input type="file" id="fileIn" accept="audio/*"></details></div></div>
<p class="hint">${esc(d.otherAudio)}</p>
<p><a id="next" class="btn accent" style="width:100%;text-align:center;${ans ? '' : 'pointer-events:none;opacity:.5'}" href="${nextHref}" aria-disabled="${ans ? 'false' : 'true'}">${esc(d.confirm)}</a></p>
<form method="post" action="/api/g/respostas/${q.id}/recusar-form"><p><button class="ghost" style="width:100%">${esc(d.refuse)}</button></p></form>
<p style="text-align:center"><a href="/entrevista">${esc(d.saveExit)}</a></p>`, '/static/guest.js');
  });

  // ---- API de respostas ----
  app.post('/api/g/respostas/:qid', async (req, reply) => {
    const iv = await needOpen(req, reply); if (!iv) return;
    if (!(await granted(iv.id, 'participation'))) return reply.code(403).send({ error: 'consent' });
    if (!rateLimit(`ans:${iv.id}`, 60, 60_000)) return reply.code(429).send({ error: 'rate' });
    const q = await db.one('SELECT * FROM questions WHERE id=$2 AND interview_id=$1', [iv.id, (req.params as any).qid]);
    if (!q) return reply.code(404).send({ error: 'question' });
    const upId = String(req.headers['x-upload-id'] ?? '').slice(0, 64);
    if (upId) {
      const dup = await db.one(`SELECT t.id, a.duration_ms FROM answer_takes t JOIN assets a ON a.id=t.asset_id JOIN answers an ON an.id=t.answer_id WHERE an.question_id=$1 AND a.meta->>'uploadId'=$2`, [q.id, upId]);
      if (dup) return { ok: true, takeId: dup.id, durationMs: dup.duration_ms, duplicate: true };
    }
    const data = req.body as Buffer;
    const kind = Buffer.isBuffer(data) ? sniff(data) : null;
    if (!kind || kind.kind !== 'audio') return reply.code(415).send({ error: 'format' });
    const p = await probeAudio(data, kind.ext).catch(() => ({ ok: false, durationMs: 0, silent: true }));
    if (!p.ok || p.durationMs < 400) return reply.code(422).send({ error: 'empty' });
    if (p.durationMs > config.limits.maxAnswerSeconds * 1000 + 2000) return reply.code(422).send({ error: 'tooLong' });
    const assetId = await saveAsset(db, { interviewId: iv.id, kind: 'answer_audio', mime: kind.mime, ext: kind.ext, data, durationMs: p.durationMs, meta: { uploadId: upId || null, via: String(req.headers['x-upload-via'] ?? 'recording') } });
    const take = await db.tx(async tx => {
      const ans = await tx.one(`INSERT INTO answers(interview_id, question_id, status) VALUES ($1,$2,'answered') ON CONFLICT (question_id) DO UPDATE SET status='answered', updated_at=now() RETURNING id`, [iv.id, q.id]);
      const tk = await tx.one(`INSERT INTO answer_takes(answer_id, asset_id, uploaded_via) VALUES ($1,$2,$3) RETURNING id`, [ans.id, assetId, String(req.headers['x-upload-via'] ?? 'recording') === 'upload' ? 'upload' : 'recording']);
      await tx.query('UPDATE answers SET selected_take_id=$2 WHERE id=$1', [ans.id, tk.id]);
      return tk;
    });
    // Resposta alterada depois de guião/episódio aprovado: invalida derivados (sem apagar versões).
    await invalidateDerived(db, iv.id);
    return { ok: true, takeId: take.id, assetId, durationMs: p.durationMs, silent: p.silent };
  });

  const refuse = async (iv: any, qid: string) => {
    const q = await db.one('SELECT id FROM questions WHERE id=$2 AND interview_id=$1', [iv.id, qid]);
    if (!q) return false;
    await db.query(`INSERT INTO answers(interview_id, question_id, status, selected_take_id) VALUES ($1,$2,'refused',NULL) ON CONFLICT (question_id) DO UPDATE SET status='refused', selected_take_id=NULL, updated_at=now()`, [iv.id, q.id]);
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
    const a = await db.one(`SELECT * FROM assets WHERE id=$1 AND interview_id=$2 AND deleted_at IS NULL AND kind IN ('question_audio','question_tts','answer_audio','guest_photo','episode_audio','episode_cover')`, [id, iv.id]);
    if (!a) return reply.code(404).send();
    return sendAsset(req, reply, a);
  });

  app.get('/api/g/leitura/:qid', async (req, reply) => {
    const iv = await needApi(req, reply); if (!iv) return;
    const q = await db.one('SELECT * FROM questions WHERE id=$2 AND interview_id=$1', [iv.id, (req.params as any).qid]);
    const ent = await entityOfInterview(db, iv.id);
    if (!q || !q.text || !inEntity(ent, () => aiAvailable())) return reply.code(404).send();
    if (!rateLimit(`tts:${iv.id}`, 20, 3600_000)) return reply.code(429).send();
    let asset = q.tts_asset_id && await db.one('SELECT * FROM assets WHERE id=$1', [q.tts_asset_id]);
    if (!asset) {
      const s = await inEntity(ent, () => synthesizeSpeech(q.text, 'host')).catch(() => null);
      if (!s) return reply.code(404).send();
      const id = await saveAsset(db, { interviewId: iv.id, kind: 'question_tts', mime: s.mime, ext: s.ext, data: s.data });
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
    const [pc, cu, pp] = await Promise.all([granted(iv.id, 'photo_capture'), granted(iv.id, 'cover_use'), granted(iv.id, 'publish_photo')]);
    const photos = await db.query('SELECT * FROM photos WHERE interview_id=$1 ORDER BY created_at', [iv.id]);
    const msg = JSON.stringify({ camDenied: d.camDenied, max3: d.max3, stUp: d.stUp, stFail: d.stFail });
    return gpage(reply, lang, d.photos, `<h1>${esc(d.photos)}</h1><p>${esc(d.photosIntro)}</p>
<form method="post" action="/entrevista/fotos/autorizacoes" class="card">${cb('photo_capture', d.c_photo, pc)}${cb('cover_use', d.c_cover, cu)}${cb('publish_photo', d.c_pubphoto, pp)}<button class="ghost">${esc(d.save)}</button></form>
${pc ? `<div class="card" id="cam" data-max="3" data-msg='${esc(msg)}'>
<div class="thumbs" id="thumbs">${photos.map((p: any) => `<div><img alt="" src="/api/g/media/${p.asset_id}"><form method="post" action="/api/g/fotos/${p.id}/eliminar-form"><button class="ghost" style="width:100%">${esc(d.discard)}</button></form></div>`).join('')}</div>
<video id="vid" class="cam" autoplay playsinline muted hidden></video><canvas id="cv" hidden></canvas><div class="status" id="pst" role="status"></div>
<div class="row"><button type="button" id="camBtn" class="ghost" ${photos.length >= 3 ? 'disabled' : ''}>${esc(d.openCamera)}</button><button type="button" id="shotBtn" class="accent" hidden>${esc(d.take)}</button></div>
<div id="prev" hidden><img id="prevImg" alt="" style="width:100%;border-radius:12px"><div class="row"><button type="button" id="keepBtn" class="accent">${esc(d.keep)}</button><button type="button" id="dropBtn" class="ghost">${esc(d.discard)}</button></div></div>
<details><summary class="sans">${esc(d.photoUpload)}</summary><input type="file" id="photoIn" accept="image/*" ${photos.length >= 3 ? 'disabled' : ''}></details></div>` : ''}
<p><a class="btn accent" style="width:100%;text-align:center" href="/entrevista/rever">${esc(photos.length ? d.photosDone : d.skipPhotos)}</a></p>`, '/static/photos.js');
  });

  app.post('/entrevista/fotos/autorizacoes', async (req, reply) => {
    const c = await need(req, reply); if (!c) return;
    const b = req.body as any;
    await recordConsent(c.iv, c.lang, 'photo_capture', !!b.photo_capture);
    await recordConsent(c.iv, c.lang, 'cover_use', !!b.photo_capture && !!b.cover_use);
    await recordConsent(c.iv, c.lang, 'publish_photo', !!b.photo_capture && !!b.publish_photo);
    if (!b.photo_capture) await removeAllPhotos(c.iv.id);
    return reply.redirect('/entrevista/fotos');
  });

  const removeAllPhotos = async (interviewId: string) => {
    const ps = await db.query(`SELECT p.id, a.id AS aid, a.storage_key FROM photos p JOIN assets a ON a.id=p.asset_id WHERE p.interview_id=$1`, [interviewId]);
    for (const p of ps) { await db.query('DELETE FROM photos WHERE id=$1', [p.id]); await db.query('UPDATE assets SET deleted_at=now() WHERE id=$1', [p.aid]); await storage.remove(p.storage_key); }
  };

  app.post('/api/g/fotos', async (req, reply) => {
    const iv = await needOpen(req, reply); if (!iv) return;
    if (!(await granted(iv.id, 'photo_capture'))) return reply.code(403).send({ error: 'consent' });
    const n = Number((await db.one('SELECT count(*)::int AS n FROM photos WHERE interview_id=$1', [iv.id]))?.n);
    if (n >= 3) return reply.code(409).send({ error: 'max' });
    const data = req.body as Buffer;
    const kind = Buffer.isBuffer(data) ? sniff(data) : null;
    if (!kind || kind.kind !== 'image') return reply.code(415).send({ error: 'format' });
    const clean = kind.mime === 'image/jpeg' ? stripJpegMetadata(data) : data;
    const assetId = await saveAsset(db, { interviewId: iv.id, kind: 'guest_photo', mime: kind.mime, ext: kind.ext, data: clean });
    const ph = await db.one('INSERT INTO photos(interview_id, asset_id) VALUES ($1,$2) RETURNING id', [iv.id, assetId]);
    return { ok: true, id: ph.id, assetId };
  });
  app.post('/api/g/fotos/:id/eliminar-form', async (req, reply) => {
    const iv = await needOpen(req, reply); if (!iv) return;
    const p = await db.one(`SELECT p.id, a.id AS aid, a.storage_key FROM photos p JOIN assets a ON a.id=p.asset_id WHERE p.id=$2 AND p.interview_id=$1`, [iv.id, (req.params as any).id]);
    if (p) { await db.query('DELETE FROM photos WHERE id=$1', [p.id]); await db.query('UPDATE assets SET deleted_at=now() WHERE id=$1', [p.aid]); await storage.remove(p.storage_key); }
    return reply.redirect('/entrevista/fotos');
  });

  // ---- revisão e submissão ----
  const summary = async (iv: any) => {
    const qs = await db.query(`SELECT q.*, a.status, t.asset_id, ast.duration_ms FROM questions q LEFT JOIN answers a ON a.question_id=q.id
      LEFT JOIN answer_takes t ON t.id=a.selected_take_id LEFT JOIN assets ast ON ast.id=t.asset_id WHERE q.interview_id=$1 ORDER BY q.position`, [iv.id]);
    const photos = await db.query('SELECT * FROM photos WHERE interview_id=$1 ORDER BY created_at', [iv.id]);
    const consents = await db.query(`SELECT DISTINCT ON (purpose) purpose, granted FROM consents WHERE interview_id=$1 ORDER BY purpose, created_at DESC`, [iv.id]);
    return { qs, photos, consents, complete: qs.length > 0 && qs.every((q: any) => q.status === 'answered' || q.status === 'refused') };
  };

  app.get('/entrevista/rever', async (req, reply) => {
    const c = await need(req, reply); if (!c) return;
    const { iv, lang } = c, d = t(lang);
    if (iv.collection_status === 'submitted') return reply.redirect('/entrevista/obrigado');
    const s = await summary(iv);
    return gpage(reply, lang, d.review, `<h1>${esc(d.review)}</h1><h2>${esc(d.yourAnswers)}</h2>
<ol class="sans" style="padding-left:20px">${s.qs.map((q: any) => `<li style="margin:10px 0">${esc(q.text)}<br>${q.status === 'answered' ? `<audio controls preload="none" src="/api/g/media/${q.asset_id}" style="width:100%"></audio>` : q.status === 'refused' ? pill(d.refused, 'warn') : pill('⚠', 'bad')}</li>`).join('')}</ol>
<h2>${esc(d.photos)}</h2>${s.photos.length ? `<div class="thumbs">${s.photos.map((p: any) => `<img alt="" src="/api/g/media/${p.asset_id}">`).join('')}</div>` : `<p class="hint">${esc(d.noPhotos)}</p>`}
<ul class="sans">${s.consents.map((x: any) => `<li>${x.granted ? '✔' : '✘'} ${esc(consentText(lang, x.purpose as ConsentPurpose))}</li>`).join('')}</ul>
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
      answers: s.qs.map((q: any) => ({ questionId: q.id, status: q.status, assetId: q.asset_id ?? null })),
      photos: s.photos.map((p: any) => p.asset_id), consents: s.consents,
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
    const ep = await db.one(`SELECT id FROM episodes WHERE interview_id=$1 AND status='preview' LIMIT 1`, [iv.id]);
    return gpage(reply, lang, d.thanks, `<h1>${esc(d.thanks)}</h1><p>${esc(d.thanksText)}</p>
<div class="card sans"><strong>${esc(d.receipt)}</strong><br>${esc(iv.title)}<br>${esc(fmtDate(sub?.created_at))}<br><code>${esc(sub?.id ?? '')}</code></div>
<p class="hint">${esc(d.contact)} ${esc(config.supportEmail)}</p>${ep ? `<p><a class="btn accent" href="/entrevista/episodio">${esc(d.episodePreview)}</a></p>` : ''}`);
  });
}

/** Alteração a respostas invalida aprovações e marca derivados como desatualizados — sem apagar versões anteriores. */
export async function invalidateDerived(db: any, interviewId: string) {
  await db.query(`UPDATE scripts SET status='stale' WHERE interview_id=$1 AND status IN ('draft','approved')`, [interviewId]);
  await db.query(`UPDATE approvals SET valid=false WHERE interview_id=$1 AND valid`, [interviewId]);
  await db.query(`UPDATE episodes SET stale=true WHERE interview_id=$1`, [interviewId]);
  await db.query(`UPDATE interviews SET production_status=CASE WHEN production_status IN ('not_requested','queued','failed') THEN production_status ELSE 'stale' END WHERE id=$1`, [interviewId]);
}
