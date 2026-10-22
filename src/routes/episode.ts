import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { esc, fmtDuration, fmtDate } from '../lib.ts';
import { page, flash } from '../views.ts';
import { sendAsset, audit } from '../app.ts';
import { toVtt, toSrt, type Cue } from '../subtitles.ts';
import { t, normLang } from '../i18n.ts';
import { approvalScope, videoMeta, guestDecides, reviewCopy } from '../approval.ts';
import { guestHelpNav } from '../support.ts';
import { carriedTags, campaignQuery, ownHosts, withCampaign, fromOwnSite, trackVisit } from '../metrics.ts';

export interface PlayerUrls { audio: string; cover: string; subs: (lang: string, ext: 'vtt' | 'srt') => string }

const LANG_NAME: Record<string, string> = { en: 'English', 'pt-PT': 'Português (PT)', es: 'Español', fr: 'Français', de: 'Deutsch' };

export function playerHtml(ep: any, urls: PlayerUrls, opts: { host?: string; guest?: string } = {}) {
  const langs = Object.keys(ep.subtitles ?? {});
  const json = JSON.stringify({ subtitles: ep.subtitles ?? {}, chapters: ep.chapters ?? [] }).replace(/</g, '\\u003c');
  return `<article class="player" aria-label="${esc(ep.title)}">
<div class="row" style="align-items:flex-start"><img src="${esc(urls.cover)}" alt="Cover of ${esc(ep.title)}" width="220" height="220" style="width:min(220px,40vw);height:auto;border-radius:12px;aspect-ratio:1;object-fit:cover">
<div class="grow" style="min-width:220px"><h1 style="margin:.2em 0">${esc(ep.title)}</h1>
<p class="sans hint">${opts.host ? `Host: ${esc(opts.host)}` : ''}${opts.guest ? ` · Guest: ${esc(opts.guest)}` : ''} · ${fmtDuration(ep.duration_ms)}</p>
<p class="sans hint" style="border-left:3px solid var(--accent);padding-left:10px">${esc(config.aiDisclosure)}</p></div></div>
<audio id="aud" controls preload="metadata" src="${esc(urls.audio)}" style="width:100%;margin-top:14px"></audio>
<div class="row sans" style="margin:10px 0"><label for="spd" style="margin:0">Speed</label><select id="spd" style="width:auto"><option>0.75</option><option selected>1</option><option>1.25</option><option>1.5</option><option>2</option></select>
<label for="lang" style="margin:0 0 0 12px">Subtitles</label><select id="lang" style="width:auto"><option value="">Off</option>${langs.map(l => `<option value="${esc(l)}" ${l === 'en' ? 'selected' : ''}>${esc(LANG_NAME[l] ?? l)}</option>`).join('')}${['en', 'pt-PT'].filter(l => !langs.includes(l)).map(l => `<option disabled>${esc(LANG_NAME[l])} — not available</option>`).join('')}</select>
${langs.map(l => `<a class="hint" href="${esc(urls.subs(l, 'vtt'))}" download>${esc(l)}.vtt</a> <a class="hint" href="${esc(urls.subs(l, 'srt'))}" download>.srt</a>`).join(' · ')}</div>
<div class="cue" id="cue" aria-live="off" aria-label="Subtitles"></div>
<h2>Chapters</h2><ol id="chap" class="sans"></ol>
<h2>Transcript</h2><div id="tr"></div>
<script type="application/json" id="pdata">${json}</script></article>`;
}

export async function episodeRoutes(app: FastifyInstance) {
  const db = app.db;
  const send = (reply: any, html: string) => reply.type('text/html; charset=utf-8').send(html);

  // ---- público ----
  const live = (slug: string) => db.one(
    `SELECT e.*, i.host_name, i.guest_name, i.id AS iid FROM episodes e JOIN interviews i ON i.id=e.interview_id
     WHERE e.slug=$1 AND e.status='published' AND e.visibility IN ('unlisted','public') AND e.withdrawn_at IS NULL`, [slug]);

  /**
   * Visita da galeria ou de um episódio: conta só quem chega de fora com etiquetas da campanha no link (UTM ou `ref`), porque
   * são essas que seguem até ao registo (nos links da galeria, ou pelo Referer interno quando o episódio leva à landing), que
   * depois não conta de novo. Sem etiquetas não conta (é sobretudo quem ouve um episódio partilhado); a navegação interna também não.
   */
  const trackTagged = async (req: any, path: string) => {
    const own = ownHosts(req.headers.host);
    const tags = carriedTags(req.query, own);
    if (campaignQuery(tags) && !fromOwnSite(req.headers.referer, own)) await trackVisit(req, db, path, tags);
  };

  app.get('/e/:slug', async (req, reply) => {
    const ep = await live((req.params as any).slug);
    if (!ep) return reply.code(404).send('Episódio não disponível');
    await trackTagged(req, '/e');
    const s = ep.slug;
    return send(reply, page({
      lang: 'en', title: ep.title, noindex: ep.visibility !== 'public', desc: ep.description || undefined,
      body: `<div class="wrap" style="padding-top:28px">${ep.video_asset_id ? `<video controls preload="metadata" poster="/e/${s}/cover" src="/e/${s}/video" style="width:100%;border-radius:12px;background:#000;margin-bottom:18px"></video>` : ''}${playerHtml(ep, { audio: `/e/${s}/audio`, cover: `/e/${s}/cover`, subs: (l, x) => `/e/${s}/subs/${l}.${x}` }, { host: ep.host_name, guest: ep.guest_name })}</div>`,
      script: '/static/player.js', nav: '',
    }));
  });
  const pubAsset = async (req: any, reply: any, which: 'audio' | 'cover' | 'thumb' | 'video') => {
    const ep = await live(req.params.slug);
    if (!ep) return reply.code(404).send();
    const id = { audio: ep.audio_asset_id, cover: ep.cover_asset_id, thumb: ep.cover_thumb_asset_id, video: ep.video_asset_id }[which];
    const a = await db.one('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (!a) return reply.code(404).send();
    return sendAsset(req, reply, a, { cache: 'public, max-age=300' });
  };
  app.get('/e/:slug/audio', (req, reply) => pubAsset(req, reply, 'audio'));
  app.get('/e/:slug/cover', (req, reply) => pubAsset(req, reply, 'cover'));
  app.get('/e/:slug/thumb', (req, reply) => pubAsset(req, reply, 'thumb'));
  app.get('/e/:slug/video', (req, reply) => pubAsset(req, reply, 'video'));

  // Galeria pública «Podcasts gerados»: só episódios publicados como públicos e autorizados pelo entrevistador, por tema.
  // As etiquetas da campanha que vêm da landing seguem em todos os links (início, temas, episódios, entrada), para que um
  // registo feito depois de ver a galeria fique na campanha que trouxe a visita (sem cookies).
  app.get('/podcasts', async (req, reply) => {
    await trackTagged(req, '/podcasts');
    const cq = campaignQuery(carriedTags(req.query, ownHosts(req.headers.host)));
    const L = (path: string) => esc(withCampaign(path, cq));
    const rows = await db.query(`SELECT e.slug, e.title, e.theme, e.duration_ms, e.published_at, e.video_asset_id, i.host_name, i.guest_name FROM episodes e JOIN interviews i ON i.id=e.interview_id
      WHERE e.gallery AND e.status='published' AND e.visibility='public' AND e.withdrawn_at IS NULL ORDER BY e.theme, e.published_at DESC`);
    const q = String((req.query as any).theme ?? '');
    const groups = new Map<string, any[]>();
    for (const r of rows) { const t = r.theme || 'Other'; if (q && t !== q) continue; if (!groups.has(t)) groups.set(t, []); groups.get(t)!.push(r); }
    const themes = [...new Set(rows.map((r: any) => r.theme || 'Other'))];
    return send(reply, page({
      lang: 'en', title: 'Podcast gallery', desc: 'Published interview episodes, organised by theme.',
      nav: `<a href="${L('/')}">Home</a><a href="${L('/podcasts')}">Gallery</a><a href="${L('/entrar')}">Sign in</a>`,
      body: `<div class="wrap" style="padding-top:32px"><h1>Podcast gallery</h1><p class="hint sans">Episodes published by their interviewers for public listening. Translation and narration are AI-generated.</p>
${themes.length > 1 ? `<p class="row sans"><a class="btn ${q ? 'ghost' : 'accent'}" href="${L('/podcasts')}">All</a>${themes.map(t => `<a class="btn ${q === t ? 'accent' : 'ghost'}" href="${L(`/podcasts?theme=${encodeURIComponent(t)}`)}">${esc(t)}</a>`).join('')}</p>` : ''}
${groups.size ? [...groups].map(([t, eps]) => `<section style="margin-top:28px"><h2>${esc(t)}</h2><div class="grid3">${eps.map((e: any) => `<a class="card" href="${L(`/e/${encodeURIComponent(e.slug)}`)}" style="text-decoration:none;color:inherit;margin:0"><img src="/e/${esc(e.slug)}/thumb" alt="" width="300" height="300" loading="lazy" style="width:100%;height:auto;border-radius:8px"><h3 style="margin:.5em 0 .2em">${esc(e.title)}</h3><p class="hint sans" style="margin:0">${esc(e.host_name)} · ${esc(e.guest_name)} · ${fmtDuration(e.duration_ms)}${e.video_asset_id ? ' · video' : ''}</p></a>`).join('')}</div></section>`).join('') : '<div class="card"><p>No episodes yet.</p></div>'}</div>`,
    }));
  });
  const subsReply = (cues: Cue[] | undefined, fmt: string, reply: any) => {
    if (!cues) return reply.code(404).send();
    return fmt === 'srt' ? reply.type('application/x-subrip; charset=utf-8').send(toSrt(cues)) : reply.type('text/vtt; charset=utf-8').send(toVtt(cues));
  };
  app.get('/e/:slug/subs/:file', async (req, reply) => {
    const ep = await live((req.params as any).slug);
    const m = /^([A-Za-z-]{2,8})\.(vtt|srt)$/.exec((req.params as any).file);
    if (!ep || !m) return reply.code(404).send();
    return subsReply(ep.subtitles?.[m[1]], m[2], reply);
  });

  // ---- pré-visualização do entrevistador ----
  app.get('/entrevistas/:id/subs/:file', async (req, reply) => {
    if (!req.user) return reply.code(401).send();
    const ep = await db.one(`SELECT e.subtitles FROM episodes e JOIN interviews i ON i.id=e.interview_id WHERE i.id=$1 AND (i.owner_id=$2 OR $3='admin') AND e.status<>'superseded' ORDER BY e.created_at DESC LIMIT 1`, [(req.params as any).id, req.user.id, req.user.role]);
    const m = /^([A-Za-z-]{2,8})\.(vtt|srt)$/.exec((req.params as any).file);
    if (!ep || !m) return reply.code(404).send();
    return subsReply(ep.subtitles?.[m[1]], m[2], reply);
  });

  // ---- pré-visualização do entrevistado ----
  const guestEpisode = async (req: any) => {
    if (!req.guest) return null;
    return db.one(`SELECT e.*, i.host_name, COALESCE(NULLIF(i.host_name,''), u.name) AS host_label, i.guest_name, i.review_policy, i.interaction_lang FROM episodes e JOIN interviews i ON i.id=e.interview_id LEFT JOIN users u ON u.id=i.owner_id
      WHERE e.interview_id=$1 AND e.status IN ('preview','published') AND e.stale=false ORDER BY e.created_at DESC LIMIT 1`, [req.guest.interviewId]);
  };
  app.get('/entrevista/subs/:file', async (req, reply) => {
    const ep = await guestEpisode(req);
    const m = /^([A-Za-z-]{2,8})\.(vtt|srt)$/.exec((req.params as any).file);
    if (!ep || !m) return reply.code(404).send();
    return subsReply(ep.subtitles?.[m[1]], m[2], reply);
  });
  app.get('/entrevista/episodio', async (req, reply) => {
    const ep = await guestEpisode(req);
    if (!ep) return reply.redirect('/entrevista/obrigado');
    const lang = normLang(ep.interaction_lang), d = t(lang);
    const dec = await db.one(`SELECT * FROM approvals WHERE episode_id=$1 AND actor='guest' AND valid ORDER BY created_at DESC LIMIT 1`, [ep.id]);
    // Texto e formulário seguem o alcance da aprovação do convidado (a mesma regra da publicação). Num episódio já
    // publicado não há nada a decidir: aprovar ou pedir alterações já não muda o que está no ar.
    const review = { scope: approvalScope(ep, await videoMeta(db, ep.video_asset_id)), published: ep.status === 'published' };
    const decides = guestDecides(review), c = reviewCopy(lang, review);
    const pubDay = ep.published_at ? new Date(ep.published_at).toLocaleDateString(lang === 'en' ? 'en-GB' : 'pt-PT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Lisbon' }) : '';
    const q = req.query as any;
    return send(reply, page({
      lang, title: d.episodePreview, noindex: true, nav: guestHelpNav(req.guest, lang), script: '/static/player.js',
      body: `<div class="wrap" style="padding-top:28px">${flash(q.ok)}${q.changed ? `<div class="flash bad">${esc(d.versionChanged)}</div>` : ''}<h1>${esc(d.episodePreview)}</h1>
<p class="sans"><strong>${esc(c.title)}</strong></p><p>${esc(d.reviewIntro(ep.host_label ?? ''))} ${esc(c.steps)}</p>
${review.published ? `<p class="hint">${pubDay ? `${esc(d.publishedOn(pubDay))} ` : ''}${esc(d.contact)} ${esc(config.supportEmail)}</p>` : ''}
${ep.video_asset_id ? `<video controls preload="metadata" poster="/api/g/media/${ep.cover_asset_id}" src="/api/g/media/${ep.video_asset_id}" style="width:100%;border-radius:12px;background:#000;margin-bottom:18px"></video>` : ''}
${playerHtml(ep, { audio: `/api/g/media/${ep.audio_asset_id}`, cover: `/api/g/media/${ep.cover_asset_id}`, subs: (l, x) => `/entrevista/subs/${l}.${x}` }, { host: ep.host_name, guest: ep.guest_name })}
${decides && dec ? `<div class="flash">${esc(dec.decision === 'approved' ? d.approve : d.requestChanges)} — ${esc(fmtDate(dec.created_at))}${dec.decision === 'approved' && String(dec.video_asset_id ?? '') !== String(ep.video_asset_id ?? '') ? ` (${esc(d.versionChanged)})` : ''}</div>` : ''}
${!decides ? '' : `<form method="post" action="/entrevista/episodio/decisao" class="card"><input type="hidden" name="video" value="${esc(ep.video_asset_id ?? '')}"><input type="hidden" name="episode" value="${esc(ep.id)}"><input type="hidden" name="audio" value="${esc(ep.audio_asset_id ?? '')}"><label for="nt">${esc(d.notePlaceholder)}</label><textarea id="nt" name="note"></textarea>
<div class="row"><button name="decision" value="approved" class="accent">${esc(d.approve)}</button><button name="decision" value="changes" class="ghost">${esc(d.requestChanges)}</button></div>
<p class="hint">${esc(d.silence)}</p></form>`}
<p class="sans"><a href="/entrevista/fotos">${esc(d.reviewAuth)}</a></p></div>`,
    }));
  });
  app.post('/entrevista/episodio/decisao', async (req, reply) => {
    const ep = await guestEpisode(req);
    if (!ep) return reply.redirect('/entrevista/obrigado');
    const b = req.body as any;
    // A publicação não depende do convidado, ou o episódio já foi publicado: não há decisão a registar.
    if (!guestDecides({ scope: approvalScope(ep, await videoMeta(db, ep.video_asset_id)), published: ep.status === 'published' })) return reply.redirect('/entrevista/episodio');
    const decision = b.decision === 'approved' ? 'approved' : 'changes';
    // Uma aprovação só vale para o vídeo que estava na página; um pedido de alterações vale sempre.
    if (decision === 'approved' && (String(b.video ?? '') !== String(ep.video_asset_id ?? '') || (b.episode && String(b.episode) !== String(ep.id)) || (b.audio && String(b.audio) !== String(ep.audio_asset_id ?? '')))) return reply.redirect('/entrevista/episodio?changed=1');
    await db.query(`UPDATE approvals SET valid=false WHERE episode_id=$1 AND actor='guest'`, [ep.id]);
    await db.query(`INSERT INTO approvals(interview_id, kind, actor, episode_id, script_id, decision, note, video_asset_id) VALUES ($1,'episode','guest',$2,$3,$4,$5,$6)`, [ep.interview_id, ep.id, ep.script_id, decision, String(b.note ?? '').slice(0, 2000), ep.video_asset_id ?? null]);
    await audit(db, 'guest', `episode.${decision}`, ep.interview_id);
    return reply.redirect('/entrevista/episodio?ok=1');
  });
}
