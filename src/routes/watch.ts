import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { esc, fmtDate, isEmail, newToken, rateLimit, sha256 } from '../lib.ts';
import { page, flash } from '../views.ts';
import { requireUser, sendAsset, audit } from '../app.ts';
import { queueEmail, emailShell } from '../mail.ts';
import { coverWithdrawnSql } from '../approval.ts';
import { toVtt, toSrt } from '../subtitles.ts';
import { playerHtml } from './episode.ts';
import { helpNav } from '../support.ts';

/**
 * Convites para assistir: o entrevistador escolhe um episódio publicado (com vídeo, de preferência) e envia um link pessoal
 * por email (pelo portal) ou abre o WhatsApp com a mensagem pronta (enviada por ele, do telemóvel dele). O link vale também
 * para episódios privados, pode ser revogado e conta as visualizações. Só o hash do código fica guardado.
 */
export const WATCH_EMAILS_PER_DAY = 50;
const VISIBILITY: Record<string, string> = { private: 'privado', unlisted: 'não listado', public: 'público' };

export async function watchRoutes(app: FastifyInstance) {
  const db = app.db;
  const send = (reply: any, html: string) => reply.type('text/html; charset=utf-8').send(html);
  const back = (reply: any, ok?: string, e?: string, extra = '') => reply.redirect(`/assistir/convites${ok ? `?ok=${encodeURIComponent(ok)}` : e ? `?e=${encodeURIComponent(e)}` : ''}${extra}`);
  // Episódios publicados do utilizador (o administrador vê os seus, como qualquer titular).
  const myEpisodes = (userId: string) => db.query(`SELECT e.id, e.title, e.slug, e.visibility, e.published_at, e.video_asset_id, e.duration_ms, i.id AS iid, i.host_name
    FROM episodes e JOIN interviews i ON i.id=e.interview_id WHERE i.owner_id=$1 AND e.status='published' AND e.withdrawn_at IS NULL ORDER BY e.published_at DESC LIMIT 100`, [userId]);
  const linkOf = (token: string) => `${config.baseUrl}/ver/${token}`;
  const messageOf = (ep: any, who: string, note: string, url: string) =>
    `${who ? `${who} convida-o a assistir` : 'Convite para assistir'} à entrevista «${ep.title}»${note ? `\n\n${note}` : ''}\n\n${url}`;

  // Página da lista (GET) e resposta da criação de um link para o WhatsApp (POST: o código vai só nesta resposta, nunca no URL).
  const listPage = async (req: any, reply: any, q: any) => {
    const eps = await myEpisodes(req.user!.id);
    const sel = eps.find((e: any) => e.id === q.ep) ?? eps.find((e: any) => e.video_asset_id) ?? eps[0];
    const invites = sel ? await db.query(`SELECT * FROM watch_invites WHERE episode_id=$1 ORDER BY created_at DESC LIMIT 50`, [sel.id]) : [];
    // Link acabado de criar para o WhatsApp: mostra o botão que abre o WhatsApp com a mensagem pronta (o código não fica guardado).
    const wa = typeof q.wa === 'string' && /^[A-Za-z0-9_-]{30,60}$/.test(q.wa) && sel ? q.wa : null;
    const waText = wa ? messageOf(sel, req.user!.name ?? '', String(q.note ?? '').slice(0, 500), linkOf(wa)) : '';
    const body = `<div class="narrow" style="padding-top:32px"><h1>Convidar para assistir</h1>${flash(q.ok)}${flash(q.e, 'bad')}
<p class="hint">Escolha o episódio e envie um link pessoal por email ou pelo WhatsApp. O link abre o episódio (vídeo, áudio, legendas e transcrição), mesmo que seja privado, e pode ser revogado a qualquer momento.</p>
${!eps.length ? '<div class="card"><p>Ainda não tem episódios publicados. Publique um episódio (pode ser como privado) na página da produção e volte aqui.</p></div>' : `
${wa ? `<div class="card" style="border:2px solid var(--ok)"><p class="sans" style="margin-top:0"><strong>Link criado.</strong> Abra o WhatsApp para escolher o contacto e enviar a mensagem:</p>
<p><a class="btn accent" href="https://wa.me/?text=${encodeURIComponent(waText)}" target="_blank" rel="noopener">Abrir no WhatsApp</a></p>
<label for="lnk">Ou copie o link</label><input id="lnk" type="text" readonly value="${esc(linkOf(wa))}" onclick="this.select()"></div>` : ''}
<form method="get" action="/assistir/convites" class="card"><label for="ep">Episódio</label><select id="ep" name="ep" onchange="this.form.submit()">${eps.map((e: any) => `<option value="${esc(e.id)}" ${e.id === sel?.id ? 'selected' : ''}>${esc(e.title)} · ${e.video_asset_id ? 'vídeo' : 'só áudio'} · ${esc(VISIBILITY[e.visibility] ?? e.visibility)} · ${fmtDate(e.published_at)}</option>`).join('')}</select>
<noscript><button class="ghost">Escolher</button></noscript></form>
<form method="post" action="/assistir/convites" class="card"><input type="hidden" name="episode" value="${esc(sel.id)}">
<label for="nm">Nome de quem convida (opcional)</label><input id="nm" name="name" type="text" maxlength="100" placeholder="Ex.: Ana Silva">
<label for="em">Email (para enviar pelo portal)</label><input id="em" name="email" type="email" maxlength="254" placeholder="nome@exemplo.pt">
<label for="nt">Mensagem pessoal (opcional)</label><textarea id="nt" name="note" maxlength="500" placeholder="Ex.: Gostava que visse esta conversa sobre a transição energética."></textarea>
<p class="row"><button class="accent" name="channel" value="email">Enviar por email</button><button class="ghost" name="channel" value="whatsapp">Criar link para o WhatsApp</button></p>
<p class="hint">Pelo WhatsApp, o portal só cria o link: é o seu WhatsApp que envia a mensagem ao contacto que escolher. Quem recebe o link pode reencaminhá-lo; para um episódio privado, revogue o link quando deixar de fazer sentido.</p></form>
<div class="card"><h2 style="margin-top:0">Convites deste episódio</h2>${invites.length ? `<table class="sans"><thead><tr><th>Para</th><th>Enviado</th><th>Visualizações</th><th></th></tr></thead><tbody>${invites.map((v: any) => `<tr><td>${esc(v.recipient_name || v.recipient_email || '—')}${v.recipient_email && v.recipient_name ? `<br><span class="hint">${esc(v.recipient_email)}</span>` : ''}<br><span class="hint">${v.channel === 'email' ? 'email' : 'WhatsApp'}</span></td><td>${fmtDate(v.created_at)}</td><td>${v.views}${v.last_viewed_at ? `<br><span class="hint">última: ${fmtDate(v.last_viewed_at)}</span>` : ''}</td><td>${v.revoked_at ? 'revogado' : `<form method="post" action="/assistir/convites/${esc(v.id)}/revogar" onsubmit="return confirm('Revogar este link?')"><button class="ghost">Revogar</button></form>`}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">Ainda não há convites para este episódio.</p>'}</div>`}</div>`;
    return send(reply, page({ title: 'Convidar para assistir', body, noindex: true, nav: `<a href="/painel">Painel</a>${helpNav(req.user)}` }));
  };
  app.get('/assistir/convites', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const q = { ...(req.query as any) }; delete q.wa;
    return listPage(req, reply, q);
  });

  app.post('/assistir/convites', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const b = (req.body ?? {}) as any;
    const ep = typeof b.episode === 'string' && /^[0-9a-f-]{36}$/i.test(b.episode) ? (await myEpisodes(req.user!.id)).find((e: any) => e.id === b.episode) : null;
    if (!ep) return back(reply, undefined, 'Escolha um dos seus episódios publicados.');
    const channel = b.channel === 'whatsapp' ? 'whatsapp' : 'email';
    const name = String(b.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const note = String(b.note ?? '').trim().slice(0, 500);
    const email = String(b.email ?? '').trim().toLowerCase();
    if (channel === 'email' && !isEmail(email)) return back(reply, undefined, 'Indique um email válido (ou crie o link para o WhatsApp).', `&ep=${ep.id}`);
    if (channel === 'email' && !rateLimit(`watch-mail:${req.user!.id}`, WATCH_EMAILS_PER_DAY, 86400_000)) return back(reply, undefined, `Limite de ${WATCH_EMAILS_PER_DAY} convites por email por dia atingido. Use o WhatsApp ou tente amanhã.`, `&ep=${ep.id}`);
    const token = newToken();
    const id = (await db.one(`INSERT INTO watch_invites(episode_id, interview_id, created_by, token_hash, channel, recipient_name, recipient_email) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ep.id, ep.iid, req.user!.id, sha256(token), channel, name, channel === 'email' ? email : null])).id;
    await audit(db, req.user!.email, 'watch.invite_created', ep.iid, { invite: id, episode: ep.id, channel });
    if (channel === 'whatsapp') return listPage(req, reply, { ep: ep.id, wa: token, note });
    const who = req.user!.name || ep.host_name || config.brand;
    const url = linkOf(token);
    const text = `${messageOf(ep, who, note, url)}\n\n(English) ${who} invites you to watch the interview “${ep.title}”: ${url}\n\nEste link é pessoal: abre o episódio sem conta. / This link is personal: it opens the episode without an account.`;
    await queueEmail(db, { key: `watch:${id}`, interviewId: ep.iid, to: email, subject: `${who} convida-o a assistir: ${ep.title}`, text,
      html: emailShell(`Convite para assistir: ${ep.title}`, `<p>${esc(who)} convida-o a assistir à entrevista «${esc(ep.title)}».</p>${note ? `<p style="white-space:pre-wrap;border-left:3px solid #ccc;padding-left:10px">${esc(note)}</p>` : ''}<p lang="en">${esc(who)} invites you to watch the interview “${esc(ep.title)}”.</p>`, { label: 'Assistir à entrevista · Watch', url }) });
    return back(reply, `Convite enviado para ${email}.`, undefined, `&ep=${ep.id}`);
  });

  app.post('/assistir/convites/:id/revogar', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const id = (req.params as any).id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send();
    const v = await db.one(`UPDATE watch_invites w SET revoked_at=now() FROM interviews i WHERE w.id=$1 AND i.id=w.interview_id AND (i.owner_id=$2 OR $3='admin') AND w.revoked_at IS NULL RETURNING w.episode_id, w.interview_id`, [id, req.user!.id, req.user!.role]);
    if (!v) return back(reply, undefined, 'Convite inexistente ou já revogado.');
    await audit(db, req.user!.email, 'watch.invite_revoked', v.interview_id, { invite: id });
    return back(reply, 'Link revogado: deixa de abrir o episódio.', undefined, `&ep=${v.episode_id}`);
  });

  // ---- página de quem recebe o convite (sem conta) ----
  const invited = async (token: string) => /^[A-Za-z0-9_-]{30,60}$/.test(token) ? db.one(
    `SELECT w.id AS wid, e.*, i.host_name, i.guest_name, ${coverWithdrawnSql('e')} AS cover_withdrawn FROM watch_invites w JOIN episodes e ON e.id=w.episode_id JOIN interviews i ON i.id=e.interview_id
     WHERE w.token_hash=$1 AND w.revoked_at IS NULL AND e.status='published' AND e.withdrawn_at IS NULL`, [sha256(token)]) : null;
  app.get('/ver/:token', async (req, reply) => {
    const t = (req.params as any).token;
    const ep = await invited(t);
    if (!ep) return reply.code(404).type('text/html; charset=utf-8').send(page({ lang: 'en', title: 'Link not available', noindex: true, body: '<div class="narrow" style="padding-top:48px"><h1>Link not available</h1><p>This invitation link was revoked or the episode is no longer published. · Este link foi revogado ou o episódio deixou de estar publicado.</p></div>' }));
    await db.query('UPDATE watch_invites SET views=views+1, last_viewed_at=now() WHERE id=$1', [ep.wid]);
    const base = `/ver/${t}`, showCover = !ep.cover_withdrawn;
    reply.header('Referrer-Policy', 'no-referrer');
    return send(reply, page({
      lang: 'en', title: ep.title, noindex: true,
      body: `<div class="wrap" style="padding-top:28px">${ep.video_asset_id && showCover ? `<video controls preload="metadata" poster="${base}/cover" src="${base}/video" style="width:100%;border-radius:12px;background:#000;margin-bottom:18px"></video>` : ''}${playerHtml(ep, { audio: `${base}/audio`, cover: showCover ? `${base}/cover` : '', subs: (l, x) => `${base}/subs/${l}.${x}` }, { host: ep.host_name, guest: ep.guest_name })}
<p class="hint sans" style="margin-top:28px">Personal link: please do not share it. · Link pessoal: por favor não o partilhe.</p></div>`,
      script: '/static/player.js', nav: '',
    }));
  });
  const asset = async (req: any, reply: any, which: 'audio' | 'cover' | 'video') => {
    const ep = await invited(req.params.token);
    if (!ep || (which !== 'audio' && ep.cover_withdrawn)) return reply.code(404).send();
    const a = await db.one('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL', [{ audio: ep.audio_asset_id, cover: ep.cover_asset_id, video: ep.video_asset_id }[which]]);
    if (!a) return reply.code(404).send();
    return sendAsset(req, reply, a, { cache: 'private, max-age=300' });
  };
  app.get('/ver/:token/audio', (req, reply) => asset(req, reply, 'audio'));
  app.get('/ver/:token/cover', (req, reply) => asset(req, reply, 'cover'));
  app.get('/ver/:token/video', (req, reply) => asset(req, reply, 'video'));
  app.get('/ver/:token/subs/:file', async (req, reply) => {
    const ep = await invited((req.params as any).token);
    const m = /^([A-Za-z-]{2,8})\.(vtt|srt)$/.exec((req.params as any).file);
    const cues = ep && m ? ep.subtitles?.[m[1]] : undefined;
    if (!cues) return reply.code(404).send();
    return m![2] === 'srt' ? reply.type('application/x-subrip; charset=utf-8').send(toSrt(cues)) : reply.type('text/vtt; charset=utf-8').send(toVtt(cues));
  });
}
