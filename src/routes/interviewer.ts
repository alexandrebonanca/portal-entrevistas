import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { esc, isEmail, fmtDate, fmtDuration, rateLimit } from '../lib.ts';
import { page, flash, pill, STATUS_LABEL } from '../views.ts';
import { requireUser, ownedInterview, audit, sendAsset } from '../app.ts';
import { sniff, stripJpegMetadata, saveAsset, probeAudio } from '../media.ts';
import { createInvitation } from '../invites.ts';
import { enqueue } from '../jobs.ts';
import { aiAvailable } from '../ai/openai.ts';
import { quotaFor } from '../billing.ts';

const H = { 'Content-Type': 'text/html; charset=utf-8' };
const nav = (u: any) => `<a href="/painel">Painel</a><a href="/entrevistas/nova">Nova entrevista</a><a href="/account">Conta</a>${u.role === 'admin' ? '<a href="/admin/entidades">Entidades</a><a href="/admin/utilizadores">Utilizadores</a><a href="/admin/definicoes">Definições</a>' : u.role === 'entity_admin' ? '<a href="/entidade">Entidade</a>' : ''}<form method="post" action="/sair" style="display:inline"><button class="ghost" style="padding:6px 12px;min-height:0;margin-left:16px">Sair (${esc(u.name)})</button></form>`;
const LANGS: [string, string][] = [['pt-PT', 'Português (PT)'], ['en', 'English']];
const SUBS = [['en', 'English'], ['pt-PT', 'Português (PT)'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch']];
const statusPill = (s: string) => pill(STATUS_LABEL[s] ?? s, ['submitted', 'ready', 'published', 'approved'].includes(s) ? 'ok' : ['failed', 'expired', 'cancelled', 'stale', 'withdrawn'].includes(s) ? 'bad' : '');

export async function interviewerRoutes(app: FastifyInstance) {
  const db = app.db;
  const view = (req: any, reply: any, title: string, body: string, script?: string) =>
    reply.headers(H).send(page({ title, body, nav: nav(req.user), noindex: true, script }));

  app.get('/painel', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const rows = await db.query(
      `SELECT i.*, (SELECT count(*)::int FROM questions q WHERE q.interview_id=i.id) AS nq,
         (SELECT count(*)::int FROM answers a WHERE a.interview_id=i.id) AS na FROM interviews i
       WHERE i.owner_id=$1 OR $2='admin' ORDER BY i.created_at DESC`, [req.user!.id, req.user!.role]);
    const body = `<div class="wrap" style="padding-top:32px"><div class="row"><h1 class="grow" style="margin:0">Entrevistas</h1><a class="btn accent" href="/entrevistas/nova">Nova entrevista</a></div>
${rows.length ? `<div class="card" style="overflow-x:auto"><table><thead><tr><th>Título</th><th>Convidado</th><th>Recolha</th><th>Produção</th><th>Publicação</th><th>Respostas</th></tr></thead><tbody>
${rows.map((r: any) => `<tr><td><a href="/entrevistas/${r.id}">${esc(r.title)}</a></td><td>${esc(r.guest_name || '—')}</td><td>${statusPill(r.collection_status)}</td><td>${statusPill(r.production_status)}</td><td>${statusPill(r.publication_status)}</td><td>${r.na}/${r.nq}</td></tr>`).join('')}
</tbody></table></div>` : '<div class="card"><p>Ainda não tem entrevistas. Crie a primeira.</p></div>'}</div>`;
    return view(req, reply, 'Painel', body);
  });

  app.get('/entrevistas/nova', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return view(req, reply, 'Nova entrevista', `<div class="narrow" style="padding-top:32px"><h1>Nova entrevista</h1>
<form method="post" action="/entrevistas" class="card"><label for="t">Título</label><input id="t" name="title" type="text" required maxlength="140" placeholder="Ex.: O futuro da fibra ótica em Portugal">
<p class="hint">Depois poderá definir objetivo, perguntas, fotografia e convidado.</p><p><button class="accent">Criar rascunho</button></p></form></div>`);
  });

  app.post('/entrevistas', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const title = String((req.body as any)?.title ?? '').trim().slice(0, 140);
    if (!title) return reply.redirect('/entrevistas/nova');
    const r = await db.one(`INSERT INTO interviews(owner_id, title, host_name) VALUES ($1,$2,$3) RETURNING id`, [req.user!.id, title, req.user!.name]);
    await audit(db, req.user!.email, 'interview.create', r.id);
    return reply.redirect(`/entrevistas/${r.id}/editar`);
  });

  // ---------- edição ----------
  app.get('/entrevistas/:id/editar', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const iv = await ownedInterview(app, req, (req.params as any).id);
    if (!iv) return reply.code(404).send('Não encontrada');
    const q = req.query as any;
    const locked = iv.collection_status !== 'draft';
    const qs = await db.query('SELECT * FROM questions WHERE interview_id=$1 ORDER BY position', [iv.id]);
    const objT = iv.objective_asset_id ? await db.one(`SELECT text FROM transcripts WHERE source_kind='objective' AND source_id=$1 ORDER BY revision DESC LIMIT 1`, [iv.id]) : null;
    const sel = (cur: string, opts: [string, string][]) => opts.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');
    const body = `<div class="wrap" style="padding-top:32px" data-interview="${iv.id}"><h1>${esc(iv.title)} ${statusPill(iv.collection_status)}</h1>${flash(q.ok)}${flash(q.e, 'bad')}
${locked ? '<div class="flash">Esta entrevista já foi enviada. Perguntas e objetivo estão bloqueados para não alterar o que o convidado vê; use “Pedido adicional” para acrescentar perguntas.</div>' : ''}
<form method="post" action="/entrevistas/${iv.id}/guardar" class="card"><h2 style="margin-top:0">Dados gerais</h2>
<label for="title">Título</label><input id="title" name="title" type="text" required value="${esc(iv.title)}" ${locked ? 'readonly' : ''}>
<label for="obj">Objetivo da entrevista (texto)</label><textarea id="obj" name="objective_text" ${locked ? 'readonly' : ''}>${esc(iv.objective_text)}</textarea>
${objT && !iv.objective_text ? `<p class="hint">Transcrição do objetivo gravado (copie para o texto se estiver correta): <em>${esc(objT.text)}</em></p>` : ''}
<label class="check"><input type="checkbox" name="objective_shared" value="1" ${iv.objective_shared ? 'checked' : ''}> Mostrar o objetivo ao entrevistado (caso contrário é interno)</label>
<div class="row"><div class="grow"><label for="hn">Nome público do entrevistador</label><input id="hn" name="host_name" type="text" value="${esc(iv.host_name)}"></div>
<div class="grow"><label for="gn">Nome do entrevistado</label><input id="gn" name="guest_name" type="text" value="${esc(iv.guest_name)}"></div></div>
<label for="ge">Email do entrevistado</label><input id="ge" name="guest_email" type="email" value="${esc(iv.guest_email)}" ${locked ? 'readonly' : ''}>
<div class="row"><div class="grow"><label for="il">Idioma da interação do entrevistado</label><select id="il" name="interaction_lang">${sel(iv.interaction_lang, LANGS)}</select></div>
<div class="grow"><label for="al">Idioma esperado das respostas</label><select id="al" name="answer_lang"><option value="auto">Detetar automaticamente</option>${sel(iv.answer_lang, [['pt', 'Português'], ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch']])}</select></div></div>
<div class="row"><div class="grow"><label for="dl">Prazo (opcional)</label><input id="dl" name="deadline" type="date" value="${iv.deadline ? new Date(iv.deadline).toISOString().slice(0, 10) : ''}"></div>
<div class="grow"><label for="pv">Visibilidade prevista do episódio</label><select id="pv" name="planned_visibility">${sel(iv.planned_visibility, [['private', 'Privado'], ['unlisted', 'Não listado (quem tem o link)'], ['public', 'Público']])}</select></div></div>
<label for="qv">Voz do entrevistador (leitura das perguntas e episódio)</label><select id="qv" name="question_voice"><option value="female" ${iv.question_voice !== 'male' ? 'selected' : ''}>Feminina</option><option value="male" ${iv.question_voice === 'male' ? 'selected' : ''}>Masculina</option></select>
<label for="gv">Voz do entrevistado no episódio</label><select id="gv" name="guest_voice"><option value="female" ${iv.guest_voice !== 'male' ? 'selected' : ''}>Feminina</option><option value="male" ${iv.guest_voice === 'male' ? 'selected' : ''}>Masculina</option></select>
<p class="hint">Vozes naturais geradas por IA (identificadas como tal), sempre diferentes para cada um. Para o convidado ouvir as perguntas na sua própria voz, grave-as em áudio.</p>
<label for="pm">Mensagem pessoal no convite</label><textarea id="pm" name="personal_message">${esc(iv.personal_message)}</textarea>
<fieldset style="border:1px solid var(--line);border-radius:8px;margin-top:14px"><legend class="sans">Legendas previstas</legend>${SUBS.map(([v, l]) => `<label class="check"><input type="checkbox" name="subtitle_langs" value="${v}" ${(iv.subtitle_langs ?? []).includes(v) ? 'checked' : ''}> ${l}</label>`).join('')}</fieldset>
<label for="rp">Política de revisão e publicação (comunicada no convite)</label><select id="rp" name="review_policy">${sel(iv.review_policy, [['guest_preview', 'O entrevistado vê e aprova a versão final antes de publicar'], ['host_only', 'Só o entrevistador aprova (não recomendado)']])}</select>
<label class="check"><input type="checkbox" name="host_photo_rights" value="1" ${iv.host_photo_rights ? 'checked' : ''}> Tenho direito a usar a minha fotografia neste projeto</label>
<label class="check"><input type="checkbox" name="host_animate" value="1" ${iv.host_animate ? 'checked' : ''}> Autorizo que a minha fotografia seja animada por IA no vídeo (boca sincronizada com a voz sintética), com o aviso visível «Retrato animado por IA»</label>
<p><button class="accent">Guardar dados</button></p></form>

<div class="card"><h2 style="margin-top:0">A minha fotografia</h2>
${iv.host_photo_asset_id ? `<p><img alt="Fotografia do entrevistador" src="/media/${iv.host_photo_asset_id}" style="width:120px;height:120px;object-fit:cover;border-radius:12px"></p>` : '<p class="hint">Sem fotografia.</p>'}
<input type="file" id="photo" accept="image/jpeg,image/png"> <button type="button" id="photoBtn" class="ghost">Carregar</button> <span id="photoSt" class="hint"></span></div>

<div class="card"><h2 style="margin-top:0">Objetivo por áudio (opcional)</h2>
${iv.objective_asset_id ? `<audio controls preload="none" src="/media/${iv.objective_asset_id}"></audio>` : ''}
<div class="rec" data-rec data-target="/api/entrevistas/${iv.id}/objetivo-audio"></div>
<p class="hint">O áudio é mantido como original e transcrito para edição. ${aiAvailable() ? '' : 'Transcrição indisponível: configure OPENAI_API_KEY.'} Não é acrescentado ao podcast automaticamente.</p></div>

<div class="card"><h2 style="margin-top:0">Perguntas</h2>
${qs.map((x: any, i: number) => `<div class="card" style="margin:12px 0"><div class="row"><strong>${i + 1}.</strong>${x.followup ? pill('Adicional') : ''}
<form method="post" action="/entrevistas/${iv.id}/perguntas/${x.id}" class="grow"><textarea name="text" aria-label="Pergunta ${i + 1}" ${locked ? 'readonly' : ''}>${esc(x.text)}</textarea>${locked ? '' : '<button class="ghost">Guardar texto</button>'}</form></div>
${x.audio_asset_id ? `<audio controls preload="none" src="/media/${x.audio_asset_id}"></audio>` : ''}
${locked ? '' : `<div class="rec" data-rec data-target="/api/entrevistas/${iv.id}/perguntas/${x.id}/audio"></div>
<div class="row"><form method="post" action="/entrevistas/${iv.id}/perguntas/${x.id}/mover?d=-1"><button class="ghost">↑</button></form><form method="post" action="/entrevistas/${iv.id}/perguntas/${x.id}/mover?d=1"><button class="ghost">↓</button></form>
<form method="post" action="/entrevistas/${iv.id}/perguntas/${x.id}/duplicar"><button class="ghost">Duplicar</button></form><form method="post" action="/entrevistas/${iv.id}/perguntas/${x.id}/eliminar"><button class="danger">Eliminar</button></form></div>`}</div>`).join('') || '<p class="hint">Sem perguntas.</p>'}
${locked ? `<form method="post" action="/entrevistas/${iv.id}/adicional"><label for="fq">Pedido adicional (nova pergunta identificada como adicional)</label><textarea id="fq" name="text" required></textarea><button class="accent">Acrescentar e reenviar convite</button></form>`
  : `<form method="post" action="/entrevistas/${iv.id}/perguntas"><label for="nq">Nova pergunta</label><textarea id="nq" name="text"></textarea><button class="accent">Adicionar pergunta</button></form>`}</div>
<p><a class="btn" href="/entrevistas/${iv.id}${locked ? '' : '/convidar'}">${locked ? 'Ver entrevista' : 'Rever e convidar →'}</a></p></div>`;
    return view(req, reply, 'Editar entrevista', body, '/static/edit.js');
  });

  app.post('/entrevistas/:id/guardar', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const iv = await ownedInterview(app, req, (req.params as any).id);
    if (!iv) return reply.code(404).send('Não encontrada');
    const b = req.body as any;
    const locked = iv.collection_status !== 'draft';
    const subs = ([] as string[]).concat(b.subtitle_langs ?? []).filter(l => SUBS.some(s => s[0] === l));
    const email = String(b.guest_email ?? '').trim().toLowerCase();
    if (email && !isEmail(email)) return reply.redirect(`/entrevistas/${iv.id}/editar?e=` + encodeURIComponent('Email do entrevistado inválido.'));
    await db.query(
      `UPDATE interviews SET title=$2, objective_text=$3, objective_shared=$4, host_name=$5, guest_name=$6, guest_email=$7, interaction_lang=$8, answer_lang=$9,
        deadline=$10, planned_visibility=$11, personal_message=$12, subtitle_langs=$13, review_policy=$14, host_photo_rights=$15, question_voice=$16, guest_voice=$17, host_animate=$18 WHERE id=$1`,
      [iv.id, locked ? iv.title : String(b.title ?? '').trim().slice(0, 140) || iv.title, locked ? iv.objective_text : String(b.objective_text ?? '').slice(0, 4000), !!b.objective_shared,
        String(b.host_name ?? '').slice(0, 100), String(b.guest_name ?? '').slice(0, 100), locked ? iv.guest_email : email, b.interaction_lang === 'en' ? 'en' : 'pt-PT',
        ['auto', 'pt', 'en', 'es', 'fr', 'de'].includes(b.answer_lang) ? b.answer_lang : 'auto', b.deadline || null,
        ['private', 'unlisted', 'public'].includes(b.planned_visibility) ? b.planned_visibility : 'private', String(b.personal_message ?? '').slice(0, 1500),
        subs.length ? subs : ['en'], b.review_policy === 'host_only' ? 'host_only' : 'guest_preview', !!b.host_photo_rights, b.question_voice === 'male' ? 'male' : 'female', b.guest_voice === 'male' ? 'male' : 'female', !!b.host_animate && !!b.host_photo_rights]);
    return reply.redirect(`/entrevistas/${iv.id}/editar?ok=` + encodeURIComponent('Guardado.'));
  });

  // ---- perguntas ----
  const qGuard = async (req: any, reply: any) => {
    if (!requireUser(req, reply)) return null;
    const iv = await ownedInterview(app, req, req.params.id);
    if (!iv) { reply.code(404).send('Não encontrada'); return null; }
    if (iv.collection_status !== 'draft') { reply.redirect(`/entrevistas/${iv.id}/editar?e=` + encodeURIComponent('Perguntas bloqueadas depois do convite.')); return null; }
    return iv;
  };
  const renumber = async (id: string) => {
    await db.query(`UPDATE questions q SET position=r.n FROM (SELECT id, row_number() OVER (ORDER BY position, id) AS n FROM questions WHERE interview_id=$1) r WHERE q.id=r.id`, [id]);
  };

  app.post('/entrevistas/:id/perguntas', async (req, reply) => {
    const iv = await qGuard(req, reply); if (!iv) return;
    const n = Number((await db.one('SELECT count(*)::int AS n FROM questions WHERE interview_id=$1', [iv.id]))?.n);
    if (n >= config.limits.maxQuestions) return reply.redirect(`/entrevistas/${iv.id}/editar?e=` + encodeURIComponent('Limite de perguntas atingido.'));
    await db.query('INSERT INTO questions(interview_id, position, text) VALUES ($1,$2,$3)', [iv.id, n + 1, String((req.body as any)?.text ?? '').slice(0, 1000)]);
    return reply.redirect(`/entrevistas/${iv.id}/editar#perguntas`);
  });
  app.post('/entrevistas/:id/perguntas/:qid', async (req, reply) => {
    const iv = await qGuard(req, reply); if (!iv) return;
    await db.query('UPDATE questions SET text=$3 WHERE id=$2 AND interview_id=$1', [iv.id, (req.params as any).qid, String((req.body as any)?.text ?? '').slice(0, 1000)]);
    return reply.redirect(`/entrevistas/${iv.id}/editar`);
  });
  app.post('/entrevistas/:id/perguntas/:qid/eliminar', async (req, reply) => {
    const iv = await qGuard(req, reply); if (!iv) return;
    await db.query('DELETE FROM questions WHERE id=$2 AND interview_id=$1', [iv.id, (req.params as any).qid]);
    await renumber(iv.id);
    return reply.redirect(`/entrevistas/${iv.id}/editar`);
  });
  app.post('/entrevistas/:id/perguntas/:qid/duplicar', async (req, reply) => {
    const iv = await qGuard(req, reply); if (!iv) return;
    const q = await db.one('SELECT * FROM questions WHERE id=$2 AND interview_id=$1', [iv.id, (req.params as any).qid]);
    if (q) {
      await db.query('UPDATE questions SET position=position+1 WHERE interview_id=$1 AND position>$2', [iv.id, q.position]);
      await db.query('INSERT INTO questions(interview_id, position, text, audio_asset_id) VALUES ($1,$2,$3,$4)', [iv.id, q.position + 1, q.text, q.audio_asset_id]);
    }
    return reply.redirect(`/entrevistas/${iv.id}/editar`);
  });
  app.post('/entrevistas/:id/perguntas/:qid/mover', async (req, reply) => {
    const iv = await qGuard(req, reply); if (!iv) return;
    const d = Number((req.query as any).d) < 0 ? -1 : 1;
    const q = await db.one('SELECT * FROM questions WHERE id=$2 AND interview_id=$1', [iv.id, (req.params as any).qid]);
    const other = q && await db.one('SELECT * FROM questions WHERE interview_id=$1 AND position=$2', [iv.id, q.position + d]);
    if (q && other) {
      await db.query('UPDATE questions SET position=$2 WHERE id=$1', [q.id, other.position]);
      await db.query('UPDATE questions SET position=$2 WHERE id=$1', [other.id, q.position]);
    }
    return reply.redirect(`/entrevistas/${iv.id}/editar`);
  });

  // ---- uploads do entrevistador (corpo bruto; tipo validado pelo conteúdo) ----
  const rawUpload = async (req: any, reply: any, want: 'audio' | 'image') => {
    if (!req.user) { reply.code(401).send({ error: 'Sessão expirada' }); return null; }
    const iv = await ownedInterview(app, req, req.params.id);
    if (!iv) { reply.code(404).send({ error: 'Não encontrada' }); return null; }
    if (!rateLimit(`up:${req.user.id}`, 60, 60_000)) { reply.code(429).send({ error: 'Demasiados pedidos' }); return null; }
    const data = req.body as Buffer;
    const kind = Buffer.isBuffer(data) ? sniff(data) : null;
    if (!kind || kind.kind !== want) { reply.code(415).send({ error: 'Formato de ficheiro não suportado' }); return null; }
    return { iv, data, kind };
  };

  app.post('/api/entrevistas/:id/foto', async (req, reply) => {
    const r = await rawUpload(req, reply, 'image'); if (!r) return;
    const data = r.kind.mime === 'image/jpeg' ? stripJpegMetadata(r.data) : r.data;
    const id = await saveAsset(db, { interviewId: r.iv.id, kind: 'host_photo', mime: r.kind.mime, ext: r.kind.ext, data });
    await db.query('UPDATE interviews SET host_photo_asset_id=$2 WHERE id=$1', [r.iv.id, id]);
    return { ok: true, assetId: id };
  });

  app.post('/api/entrevistas/:id/objetivo-audio', async (req, reply) => {
    const r = await rawUpload(req, reply, 'audio'); if (!r) return;
    if (r.iv.collection_status !== 'draft') return reply.code(409).send({ error: 'Bloqueado' });
    const p = await probeAudio(r.data, r.kind.ext);
    if (!p.ok || p.durationMs < 500) return reply.code(422).send({ error: 'Gravação inválida ou vazia' });
    const id = await saveAsset(db, { interviewId: r.iv.id, kind: 'objective_audio', mime: r.kind.mime, ext: r.kind.ext, data: r.data, durationMs: p.durationMs });
    await db.query('UPDATE interviews SET objective_asset_id=$2 WHERE id=$1', [r.iv.id, id]);
    if (aiAvailable()) await enqueue(db, { kind: 'transcribe_asset', interviewId: r.iv.id, input: { assetId: id, sourceKind: 'objective', sourceId: r.iv.id }, dedupe: `objective:${id}` });
    return { ok: true, assetId: id };
  });

  app.post('/api/entrevistas/:id/perguntas/:qid/audio', async (req, reply) => {
    const r = await rawUpload(req, reply, 'audio'); if (!r) return;
    if (r.iv.collection_status !== 'draft') return reply.code(409).send({ error: 'Bloqueado' });
    const q = await db.one('SELECT * FROM questions WHERE id=$2 AND interview_id=$1', [r.iv.id, (req.params as any).qid]);
    if (!q) return reply.code(404).send({ error: 'Pergunta não encontrada' });
    const p = await probeAudio(r.data, r.kind.ext);
    if (!p.ok || p.durationMs < 500) return reply.code(422).send({ error: 'Gravação inválida ou vazia' });
    const id = await saveAsset(db, { interviewId: r.iv.id, kind: 'question_audio', mime: r.kind.mime, ext: r.kind.ext, data: r.data, durationMs: p.durationMs });
    await db.query('UPDATE questions SET audio_asset_id=$2 WHERE id=$1', [q.id, id]);
    if (!q.text && aiAvailable()) await enqueue(db, { kind: 'transcribe_asset', interviewId: r.iv.id, input: { assetId: id, sourceKind: 'question', sourceId: q.id, fillQuestion: true }, dedupe: `qaudio:${id}` });
    return { ok: true, assetId: id };
  });

  // ---- ficheiros privados (com autorização no servidor) ----
  app.get('/media/:assetId', async (req, reply) => {
    if (!req.user) return reply.code(401).send('Não autenticado');
    const id = (req.params as any).assetId;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send();
    const a = await db.one(`SELECT a.*, i.owner_id FROM assets a LEFT JOIN interviews i ON i.id=a.interview_id WHERE a.id=$1 AND a.deleted_at IS NULL`, [id]);
    if (!a || !(a.owner_id === req.user.id || req.user.role === 'admin')) return reply.code(404).send();
    return sendAsset(req, reply, a);
  });

  // ---------- convite ----------
  const readiness = async (iv: any) => {
    const qs = await db.query('SELECT * FROM questions WHERE interview_id=$1 ORDER BY position', [iv.id]);
    const problems: string[] = [];
    if (!iv.title) problems.push('Falta o título.');
    if (!iv.objective_text && !iv.objective_asset_id) problems.push('Falta o objetivo (texto ou áudio).');
    if (!qs.length) problems.push('Falta pelo menos uma pergunta.');
    if (qs.some((x: any) => !x.text && !x.audio_asset_id)) problems.push('Há perguntas sem texto nem áudio.');
    if (!iv.guest_name) problems.push('Falta o nome do entrevistado.');
    if (!isEmail(iv.guest_email)) problems.push('Falta um email válido do entrevistado.');
    if (iv.host_photo_asset_id && !iv.host_photo_rights) problems.push('Confirme que tem direito a usar a sua fotografia, ou remova-a.');
    return { qs, problems };
  };

  app.get('/entrevistas/:id/convidar', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const iv = await ownedInterview(app, req, (req.params as any).id);
    if (!iv) return reply.code(404).send('Não encontrada');
    const { qs, problems } = await readiness(iv);
    const quota = await quotaFor(db, req.user!);
    if (!quota.allowed) problems.push(quota.reason === 'quota' ? `Atingiu o limite de ${quota.limit} entrevistas deste período (${quota.used}/${quota.limit}). Mude de plano em Conta.` : 'Precisa de uma subscrição ativa para enviar convites (Conta).');
    const body = `<div class="narrow" style="padding-top:32px"><h1>Rever e convidar</h1>${flash((req.query as any).e, 'bad')}${quota.unlimited ? '' : `<p class="hint sans">Uso neste período: ${quota.used}/${quota.limit}</p>`}
${problems.length ? `<div class="flash bad"><strong>Antes de enviar:</strong><ul>${problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
<div class="card"><p class="sans"><strong>Para:</strong> ${esc(iv.guest_name)} &lt;${esc(iv.guest_email)}&gt;<br><strong>Título:</strong> ${esc(iv.title)}<br><strong>Perguntas:</strong> ${qs.length}<br>
<strong>Objetivo visível ao entrevistado:</strong> ${iv.objective_shared ? 'Sim' : 'Não (interno)'}<br><strong>Política de revisão:</strong> ${iv.review_policy === 'guest_preview' ? 'o entrevistado aprova a versão final' : 'só o entrevistador aprova'}</p>
<ol>${qs.map((x: any) => `<li>${esc(x.text) || '<em>(pergunta em áudio)</em>'}</li>`).join('')}</ol>
${iv.objective_shared && iv.objective_text ? `<p class="hint">O entrevistado vê: <em>${esc(iv.objective_text)}</em></p>` : ''}</div>
<p class="hint">Ao enviar, a versão ${iv.version} das perguntas fica fixa. O convite chega por email e o link permanece válido até ${config.limits.inviteDays} dias (ou ao prazo definido).</p>
<form method="post" action="/entrevistas/${iv.id}/convidar" onsubmit="return confirm('Enviar o convite agora?')"><button class="accent" ${problems.length ? 'disabled' : ''}>Enviar convite</button> <a class="btn ghost" href="/entrevistas/${iv.id}/editar">Voltar</a></form></div>`;
    return view(req, reply, 'Convidar', body);
  });

  app.post('/entrevistas/:id/convidar', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const iv = await ownedInterview(app, req, (req.params as any).id);
    if (!iv) return reply.code(404).send('Não encontrada');
    if (iv.collection_status !== 'draft') return reply.redirect(`/entrevistas/${iv.id}`); // duplo clique / reenvio de formulário
    const { problems } = await readiness(iv);
    if (problems.length) return reply.redirect(`/entrevistas/${iv.id}/convidar`);
    const quota = await quotaFor(db, req.user!);
    if (!quota.allowed) return reply.redirect(`/entrevistas/${iv.id}/convidar?e=` + encodeURIComponent(quota.reason === 'quota' ? `Atingiu o limite de ${quota.limit} entrevistas deste período. Mude de plano em Conta.` : 'Precisa de uma subscrição ativa para enviar convites (Conta).'));
    await createInvitation(db, iv, { name: req.user!.name });
    await db.query(`UPDATE interviews SET collection_status='invited', invited_at=now() WHERE id=$1`, [iv.id]);
    await audit(db, req.user!.email, 'invitation.sent', iv.id);
    return reply.redirect(`/entrevistas/${iv.id}?ok=` + encodeURIComponent('Convite enviado.'));
  });

  app.post('/entrevistas/:id/reenviar', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const iv = await ownedInterview(app, req, (req.params as any).id);
    if (!iv || !['invited', 'started', 'reopened', 'expired'].includes(iv.collection_status)) return reply.code(404).send('Indisponível');
    if (!rateLimit(`resend:${iv.id}`, 1, config.limits.resendCooldownSec * 1000)) return reply.redirect(`/entrevistas/${iv.id}?e=` + encodeURIComponent('Aguarde antes de reenviar.'));
    await createInvitation(db, iv, { name: req.user!.name });
    if (iv.collection_status === 'expired') await db.query(`UPDATE interviews SET collection_status='reopened' WHERE id=$1`, [iv.id]);
    await audit(db, req.user!.email, 'invitation.resent', iv.id);
    return reply.redirect(`/entrevistas/${iv.id}?ok=` + encodeURIComponent('Novo convite enviado; o link anterior foi revogado.'));
  });

  app.post('/entrevistas/:id/cancelar', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const iv = await ownedInterview(app, req, (req.params as any).id);
    if (!iv) return reply.code(404).send('Não encontrada');
    await db.query(`UPDATE invitations SET revoked_at=now() WHERE interview_id=$1 AND revoked_at IS NULL`, [iv.id]);
    await db.query(`UPDATE interviews SET collection_status='cancelled' WHERE id=$1`, [iv.id]);
    await audit(db, req.user!.email, 'interview.cancel', iv.id);
    return reply.redirect(`/entrevistas/${iv.id}`);
  });

  app.post('/entrevistas/:id/adicional', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const iv = await ownedInterview(app, req, (req.params as any).id);
    if (!iv || iv.collection_status === 'draft') return reply.code(404).send('Indisponível');
    const text = String((req.body as any)?.text ?? '').trim().slice(0, 1000);
    if (!text) return reply.redirect(`/entrevistas/${iv.id}/editar`);
    const n = Number((await db.one('SELECT count(*)::int AS n FROM questions WHERE interview_id=$1', [iv.id]))?.n);
    await db.query('INSERT INTO questions(interview_id, position, text, followup, version) VALUES ($1,$2,$3,true,$4)', [iv.id, n + 1, text, iv.version + 1]);
    const fresh = await db.one(`UPDATE interviews SET version=version+1, collection_status=CASE WHEN collection_status='submitted' THEN 'reopened' ELSE collection_status END WHERE id=$1 RETURNING *`, [iv.id]);
    await createInvitation(db, fresh, { name: req.user!.name }, { followup: true });
    await audit(db, req.user!.email, 'question.followup', iv.id);
    return reply.redirect(`/entrevistas/${iv.id}?ok=` + encodeURIComponent('Pergunta adicional enviada ao entrevistado.'));
  });

  // ---------- detalhe ----------
  app.get('/entrevistas/:id', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const iv = await ownedInterview(app, req, (req.params as any).id);
    if (!iv) return reply.code(404).send('Não encontrada');
    const q = req.query as any;
    const rows = await db.query(
      `SELECT q.*, a.status AS ans_status, t.asset_id AS take_asset FROM questions q LEFT JOIN answers a ON a.question_id=q.id
       LEFT JOIN answer_takes t ON t.id=a.selected_take_id WHERE q.interview_id=$1 ORDER BY q.position`, [iv.id]);
    const photos = await db.query('SELECT p.*, a.id AS aid FROM photos p JOIN assets a ON a.id=p.asset_id WHERE p.interview_id=$1 ORDER BY p.created_at', [iv.id]);
    const consents = await db.query(`SELECT DISTINCT ON (purpose) purpose, granted, text_version, created_at FROM consents WHERE interview_id=$1 ORDER BY purpose, created_at DESC`, [iv.id]);
    const inv = await db.one(`SELECT * FROM invitations WHERE interview_id=$1 ORDER BY created_at DESC LIMIT 1`, [iv.id]);
    const emails = await db.query(`SELECT subject, state, created_at, error, attempts FROM emails WHERE interview_id=$1 ORDER BY created_at DESC LIMIT 6`, [iv.id]);
    const sub = iv.collection_status === 'submitted';
    const ep = await db.one('SELECT * FROM episodes WHERE interview_id=$1 ORDER BY created_at DESC LIMIT 1', [iv.id]);
    const body = `<div class="wrap" style="padding-top:32px"><div class="row"><h1 class="grow" style="margin:0">${esc(iv.title)}</h1>${statusPill(iv.collection_status)}${statusPill(iv.production_status)}${statusPill(iv.publication_status)}</div>
${flash(q.ok)}${flash(q.e, 'bad')}
<div class="card"><p class="sans"><strong>Convidado:</strong> ${esc(iv.guest_name)} &lt;${esc(iv.guest_email)}&gt; · <strong>Versão das perguntas:</strong> ${iv.version}
${inv ? `<br><strong>Convite:</strong> ${inv.revoked_at ? 'revogado' : inv.declined_at ? 'recusado pelo convidado' : new Date(inv.expires_at) < new Date() ? 'expirado' : 'válido até ' + fmtDate(inv.expires_at)}${inv.first_opened_at ? ' · aberto em ' + fmtDate(inv.first_opened_at) : ''}` : ''}</p>
<div class="row">${iv.collection_status === 'draft' ? `<a class="btn accent" href="/entrevistas/${iv.id}/convidar">Convidar</a>` : ''}
<a class="btn ghost" href="/entrevistas/${iv.id}/editar">Editar</a>
${['invited', 'started', 'reopened', 'expired'].includes(iv.collection_status) ? `<form method="post" action="/entrevistas/${iv.id}/reenviar"><button class="ghost">Reenviar convite (revoga o anterior)</button></form><form method="post" action="/entrevistas/${iv.id}/cancelar" onsubmit="return confirm('Cancelar a entrevista?')"><button class="danger">Cancelar</button></form>` : ''}
${sub || iv.production_status !== 'not_requested' ? `<a class="btn accent" href="/entrevistas/${iv.id}/producao">Produção do podcast →</a>` : ''}</div></div>
<div class="card"><h2 style="margin-top:0">Respostas</h2><table><thead><tr><th>#</th><th>Pergunta</th><th>Estado</th><th>Áudio</th></tr></thead><tbody>
${rows.map((r: any) => `<tr><td>${r.position}</td><td>${esc(r.text) || '(áudio)'}${r.followup ? ' ' + pill('adicional') : ''}</td><td>${r.ans_status === 'answered' ? pill('Respondida', 'ok') : r.ans_status === 'refused' ? pill('Recusada', 'warn') : pill('Pendente')}</td>
<td>${r.take_asset ? `<audio controls preload="none" src="/media/${r.take_asset}"></audio>` : ''}</td></tr>`).join('')}</tbody></table></div>
<div class="card"><h2 style="margin-top:0">Fotografias do convidado</h2>${photos.length ? `<div class="thumbs">${photos.map((p: any) => `<img alt="Selfie" src="/media/${p.aid}">`).join('')}</div>` : '<p class="hint">Sem fotografias.</p>'}</div>
<div class="card"><h2 style="margin-top:0">Autorizações</h2>${consents.length ? `<table><tbody>${consents.map((c: any) => `<tr><td>${esc(c.purpose)}</td><td>${c.granted ? pill('Autorizado', 'ok') : pill('Recusado', 'bad')}</td><td>${esc(c.text_version)}</td><td>${fmtDate(c.created_at)}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">Ainda sem registos.</p>'}</div>
<div class="card"><h2 style="margin-top:0">Emails</h2><table><tbody>${emails.map((e: any) => `<tr><td>${esc(e.subject)}</td><td>${pill(e.state === 'pending' ? 'por enviar' : e.state, e.state === 'sent' ? 'ok' : e.state === 'failed' ? 'bad' : 'warn')}</td><td>${fmtDate(e.created_at)}</td><td class="hint">${e.state === 'pending' ? 'Ainda não enviado: confirme que o MailerSend está configurado em Definições.' : esc(e.error ?? '')}</td></tr>`).join('') || '<tr><td class="hint">Sem emails.</td></tr>'}</tbody></table></div>
${ep ? `<p><a href="/entrevistas/${iv.id}/producao">Episódio: ${esc(ep.title)} (${fmtDuration(ep.duration_ms)})</a></p>` : ''}</div>`;
    return view(req, reply, iv.title, body);
  });
}
