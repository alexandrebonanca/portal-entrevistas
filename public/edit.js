(function () {
  const root = document.querySelector('[data-interview]');
  const ivId = root ? root.dataset.interview : '';

  // Recarregar a página e voltar ao mesmo sítio (a pergunta onde se gravou, por exemplo), sem os avisos da ação anterior.
  const reloadAt = (anchor) => {
    if (history.replaceState) history.replaceState(null, '', location.pathname + (anchor ? '#' + anchor : ''));
    location.reload();
  };

  // Gravadores genéricos do entrevistador (objetivo e perguntas por áudio).
  document.querySelectorAll('[data-rec]').forEach((box) => {
    const target = box.dataset.target, maxSec = Number(box.dataset.max) || 300; // duração máxima indicada pelo servidor
    box.innerHTML = '<button type="button" class="ghost" data-a="rec">🎙 Gravar</button> <span class="timer" style="font-size:1rem">0:00</span> <audio controls hidden></audio> <button type="button" class="accent" data-a="save" hidden>Guardar gravação</button> <span class="hint" data-a="st"></span>';
    const [bRec, timer, au, bSave, st] = [box.querySelector('[data-a=rec]'), box.querySelector('.timer'), box.querySelector('audio'), box.querySelector('[data-a=save]'), box.querySelector('[data-a=st]')];
    let ctl = null, blob = null;
    bRec.onclick = async () => {
      if (ctl) { const c = ctl; ctl = null; bRec.textContent = '🎙 Regravar'; blob = await c.stop(); au.src = URL.createObjectURL(blob); au.hidden = false; bSave.hidden = false; return; }
      try { ctl = await PE.startRecording((s) => (timer.textContent = PE.fmt(s)), maxSec, () => { if (ctl) bRec.click(); }); bRec.textContent = '■ Parar'; st.textContent = ''; }
      catch (e) { ctl = null; st.textContent = e.code === 'none' ? 'Microfone não encontrado.' : 'Acesso ao microfone recusado.'; }
    };
    bSave.onclick = async () => {
      st.textContent = 'A enviar…'; bSave.disabled = true;
      const card = box.closest('.card[id]'); // a pergunta ou o objetivo por áudio
      try { await PE.upload(target, blob); st.textContent = 'Guardado no servidor.'; setTimeout(() => reloadAt(card ? card.id : ''), 600); }
      catch (e) { st.textContent = e.permanent && e.message ? e.message : 'Falhou o envio.'; bSave.disabled = false; }
    };
  });

  const pb = document.getElementById('photoBtn');
  if (pb) pb.onclick = async () => {
    const f = document.getElementById('photo').files[0]; const st = document.getElementById('photoSt');
    if (!f) return;
    st.textContent = 'A enviar…';
    try { await PE.upload('/api/entrevistas/' + ivId + '/foto', f); reloadAt('fotografia'); } catch (e) { st.textContent = 'Formato não suportado (use JPEG ou PNG).'; }
  };

  // Depois de adicionar uma pergunta, a página volta à caixa da nova pergunta (#nq), pronta a escrever a seguinte:
  // o browser põe lá o cursor ao seguir a âncora; se não o fizer, faz-se aqui depois de carregar.
  const nq = document.getElementById('nq');
  let anchored = null;
  try { anchored = location.hash.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null; } catch (e) { /* âncora malformada */ }
  // (sem tirar o cursor de outro campo onde já se esteja a escrever)
  const idle = () => !document.activeElement || document.activeElement === document.body;
  if (anchored && anchored.tagName === 'TEXTAREA') addEventListener('load', () => setTimeout(() => { if (idle()) anchored.focus({ preventScroll: true }); }, 0));

  // Formulários com alterações por guardar (para avisar antes de o assistente recarregar a página).
  const dirty = new Set();
  let submittedHere = false;
  // Valores que o browser repõe (ao recarregar ou ao voltar atrás) também são alterações por guardar. Confere-se no
  // 'pageshow', que chega depois de o browser repor os formulários.
  const restored = () => root && root.querySelectorAll('form').forEach((f) => {
    for (const e of f.elements) {
      if ((e.type === 'checkbox' || e.type === 'radio') ? e.checked !== e.defaultChecked
        // (sem nenhuma opção marcada no HTML, a escolhida por omissão é a primeira)
        : e.tagName === 'SELECT' ? e.selectedIndex !== Math.max(0, [...e.options].findIndex((o) => o.defaultSelected))
        : 'defaultValue' in e && e.type !== 'hidden' && e.type !== 'file' && e.value !== e.defaultValue) { dirty.add(f); break; }
    }
  });
  if (root) {
    root.addEventListener('input', (ev) => { const f = ev.target.form; if (f) dirty.add(f); });
    root.addEventListener('change', (ev) => { const f = ev.target.form; if (f) dirty.add(f); });
    // ao voltar atrás para esta página depois de enviar um formulário, a versão guardada pelo browser é a de antes do envio
    root.addEventListener('submit', (ev) => { dirty.delete(ev.target); submittedHere = true; });
    addEventListener('pageshow', restored);
  }

  // ---------------- assistente de composição ----------------
  const panel = document.getElementById('compor'), fab = document.getElementById('comporBtn');
  if (!panel || !fab || !root) return;
  const tips = panel.querySelector('[data-c=tips]'), out = panel.querySelector('[data-c=out]');
  const maxQ = Number(panel.dataset.maxQuestions) || 15, limit = Number(panel.dataset.answerLimit) || 0;
  const mmss = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const KEY = 'compor:' + ivId, REOPEN = 'compor:reabrir:' + ivId, CLOSED = 'compor:fechado';
  const wide = () => window.matchMedia('(min-width:1180px)').matches;
  const store = {
    get(area, k) { try { return JSON.parse(window[area].getItem(k) || 'null'); } catch (e) { return null; } },
    set(area, k, v) { try { if (v == null) window[area].removeItem(k); else window[area].setItem(k, JSON.stringify(v)); } catch (e) { /* sem armazenamento */ } },
  };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const button = (label, cls, fn) => { const b = el('button', cls, label); b.type = 'button'; b.onclick = fn; return b; };

  // Aberto ao lado da edição nos ecrãs largos, a não ser que se tenha fechado. Nos estreitos tapa a página: fica só o
  // botão, e o painel só volta aberto depois de uma ação feita nele (Adicionar, Substituir); fecha-se ao ir para a página.
  const setOpen = (open, byUser) => {
    panel.hidden = !open; fab.hidden = open;
    fab.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('compose-open', open);
    if (byUser && wide()) store.set('localStorage', CLOSED, open ? null : 1);
  };
  const toPage = () => { if (!wide()) setOpen(false, false); };
  const title = panel.querySelector('h2');
  title.setAttribute('tabindex', '-1');
  fab.onclick = () => { setOpen(true, true); title.focus(); };
  panel.querySelector('[data-c=close]').onclick = () => { setOpen(false, true); fab.focus(); };
  panel.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { setOpen(false, true); fab.focus(); } });
  const reopen = store.get('sessionStorage', REOPEN);
  store.set('sessionStorage', REOPEN, null);
  setOpen(wide() ? !store.get('localStorage', CLOSED) : !!reopen, false);

  // Dicas calculadas na página (sem custo): acompanham o que se escreve, mesmo antes de guardar.
  const cards = () => [...document.querySelectorAll('#perguntas [id^="q-"]')];
  const textOf = (card) => { const t = card.querySelector('textarea'); return t ? t.value : ''; };
  // Começos que pedem «sim» ou «não», na língua do entrevistado (a escolhida no formulário).
  const CLOSED_Q = {
    'pt-PT': /^(é|há(?!\s+quant)|tem|teve|concorda|acha que|gosta|já|existe|costuma|considera que|sente que)\s/i,
    en: /^(do|does|did|is|are|was|were|have|has|will)\s/i,
  };
  const updateTips = () => {
    const obj = document.getElementById('obj'), il = document.getElementById('il');
    const en = !!il && il.value === 'en', closedQ = CLOSED_Q[en ? 'en' : 'pt-PT'];
    const openWords = en ? '«How», «Why» ou «What»' : '«Como», «Porquê» ou «O que»';
    const qs = cards().map((c) => ({ text: textOf(c).trim(), audio: c.dataset.audio === '1' })), n = qs.length, list = [];
    if (obj && !obj.value.trim()) list.push('Escreva o objetivo: orienta o entrevistado e as sugestões do assistente.');
    list.push(`Perguntas: ${n} de ${maxQ}.` + (limit && n ? ` O entrevistado tem ${mmss(limit)} de resposta no total, cerca de ${mmss(limit / n)} por pergunta.` : ''));
    if (!n) list.push('Comece por uma pergunta de abertura fácil (o percurso, o contexto).');
    else if (n < 4) list.push('Uma entrevista costuma ter 5 a 10 perguntas.');
    if (n >= maxQ) list.push('Atingiu o máximo de perguntas desta entrevista.');
    const perQ = [];
    qs.forEach((q, i) => {
      const k = i + 1, t = q.text;
      if (!t) { if (!q.audio) perQ.push(`A pergunta ${k} está vazia: escreva o texto ou grave-a em áudio.`); }
      else if (t.length > 300) perQ.push(`A pergunta ${k} é longa: encurte-a para se perceber bem ao ouvir.`);
      else if ((t.match(/\?/g) || []).length > 1) perQ.push(`A pergunta ${k} parece ter mais de uma pergunta: separe-as.`);
      else if (closedQ.test(t)) perQ.push(`A pergunta ${k} pode ter resposta «sim» ou «não»: experimente começar por ${openWords}.`);
    });
    list.push(...perQ.slice(0, 4));
    if (perQ.length === 5) list.push('Há mais 1 pergunta a rever.');
    else if (perQ.length > 5) list.push(`Há mais ${perQ.length - 4} perguntas a rever.`);
    tips.replaceChildren(...list.map((t) => el('li', '', t)));
  };
  let tipTimer = 0;
  const later = () => { clearTimeout(tipTimer); tipTimer = setTimeout(updateTips, 300); };
  root.addEventListener('input', later);
  root.addEventListener('change', later);
  updateTips();
  if (!out) return; // sem as sugestões por IA (sem plano): ficam só as dicas

  // Enviar um formulário normal (a página recarrega no sítio certo), avisando se há alterações por guardar; os botões
  // ficam desativados (um duplo clique não acrescenta a pergunta duas vezes).
  const postForm = (action, fields) => {
    if (dirty.size && !confirm('Há alterações por guardar nesta página que se perdem ao continuar. Continuar?')) return;
    const keep = appliedForm;
    appliedForm = null; // já se confirmou: o browser não volta a perguntar ao sair
    panel.querySelectorAll('button').forEach((x) => (x.disabled = true));
    if (!panel.hidden) store.set('sessionStorage', REOPEN, 1);
    sentFromHere = true; // ao voltar atrás para esta página, recarrega-se (ver 'pageshow')
    const f = el('form'); f.method = 'post'; f.action = action; f.hidden = true;
    for (const [k, v] of Object.entries(fields)) { const t = el('textarea'); t.name = k; t.value = v; f.appendChild(t); }
    document.body.appendChild(f); f.submit();
    // Se a saída for cancelada (por exemplo, pelo aviso de uma gravação por guardar), a página continua utilizável.
    setTimeout(() => {
      if (leaving) return;
      appliedForm = keep; sentFromHere = false; store.set('sessionStorage', REOPEN, null); f.remove();
      panel.querySelectorAll('button').forEach((x) => (x.disabled = false));
      render(last); // volta a desativar «Adicionar» se não houver vagas
    }, 20000);
  };
  let leaving = false, sentFromHere = false;
  addEventListener('pagehide', () => { leaving = true; });
  addEventListener('pageshow', () => { leaving = false; });

  // O estado de cada sugestão vem da própria página (a pergunta existe? o texto já é o proposto?), não de marcas
  // guardadas: se o servidor recusar (limite, sessão), a sugestão continua por usar. O último resultado fica também
  // em memória, para quando o browser não guarda nada.
  let last = store.get('sessionStorage', KEY);
  const save = (st) => { last = st; store.set('sessionStorage', KEY, st); };
  out.setAttribute('tabindex', '-1');
  const render = (st) => {
    if (!st || !st.result) { out.replaceChildren(); return; }
    const r = st.result, items = [];
    const head = el('div', 'row'); head.style.justifyContent = 'space-between'; head.style.marginTop = '12px';
    head.append(el('strong', '', r.acao === 'sugerir' ? 'Perguntas sugeridas' : r.acao === 'rever' ? 'Revisão das perguntas' : 'Título e objetivo'),
      button('Limpar', 'ghost', () => { save(null); render(null); title.focus(); }));
    items.push(head);
    if (r.note) items.push(el('p', 'hint', r.note));
    const now = cards();
    if (r.acao === 'sugerir') {
      if (!r.questions.length) items.push(el('p', 'hint', 'Sem sugestões novas.'));
      const texts = new Set(now.map((c) => norm(textOf(c)))), room = maxQ - now.length;
      r.questions.forEach((q) => {
        const added = texts.has(norm(q.text));
        const box = el('div', 'compose-item' + (added ? ' used' : ''));
        box.append(el('p', '', q.text), el('p', 'hint', q.why));
        const acts = el('div', 'row');
        if (added) acts.append(el('span', 'hint', 'Já está na entrevista.'));
        else {
          const add = button('Adicionar', 'accent', () => postForm('/entrevistas/' + ivId + '/perguntas', { text: q.text, origem: 'assistente' }));
          if (room <= 0) add.disabled = true;
          acts.append(add, button('Editar antes', 'ghost', () => {
            if (!nq) return;
            if (nq.value.trim() && norm(nq.value) !== norm(q.text) && !confirm('Substituir o que escreveu em «Nova pergunta» por esta sugestão?')) return;
            toPage(); nq.value = q.text; nq.focus(); nq.scrollIntoView({ block: 'center' });
          }));
        }
        box.append(acts); items.push(box);
      });
    } else if (r.acao === 'rever') {
      if (!r.items.length) items.push(el('p', 'hint', 'Nada a assinalar nas perguntas.'));
      r.items.forEach((x) => {
        const card = document.getElementById('q-' + x.qid), pos = now.indexOf(card) + 1;
        const cur = card ? textOf(card) : '', done = !!card && norm(cur) === norm(x.rewrite);
        const box = el('div', 'compose-item' + (done ? ' used' : ''));
        box.append(el('p', '', `Pergunta ${pos || x.n}: ${x.issue}`), el('p', 'hint', 'Proposta: ' + x.rewrite));
        const acts = el('div', 'row');
        const audio = !!card && card.dataset.audio === '1';
        if (!card) acts.append(el('span', 'hint', 'Esta pergunta já não existe.'));
        else if (done) {
          acts.append(el('span', 'hint', 'Substituída.'));
          if (audio) box.append(el('p', 'hint', 'Se o áudio gravado ainda tiver o texto antigo, grave a pergunta de novo.'));
        } else {
          if (norm(cur) !== norm(x.original)) box.append(el('p', 'hint', 'Esta pergunta mudou desde a revisão. Agora: ' + (cur.trim() || '(sem texto)')));
          if (audio) box.append(el('p', 'hint', 'Tem áudio gravado: o áudio não muda com o texto novo; grave-a de novo depois de substituir.'));
          acts.append(
            button('Substituir', 'accent', () => postForm('/entrevistas/' + ivId + '/perguntas/' + x.qid, { text: x.rewrite })),
            button('Ver a pergunta', 'ghost', () => { toPage(); card.scrollIntoView({ block: 'center' }); const t = card.querySelector('textarea'); if (t) t.focus({ preventScroll: true }); }));
        }
        box.append(acts); items.push(box);
      });
    } else {
      const t = document.getElementById('title'), obj = document.getElementById('obj');
      const box = el('div', 'compose-item');
      if (!r.title && !r.objective) box.append(el('p', 'hint', 'Sem proposta de título nem de objetivo.'));
      else {
        // aplicado = os campos já têm o que foi proposto (uma parte vazia da proposta não conta)
        const applied = !!t && !!obj && (!r.title || t.value === r.title) && (!r.objective || obj.value === r.objective);
        if (applied) box.classList.add('used');
        if (r.title) box.append(el('p', '', r.title));
        if (r.objective) box.append(el('p', 'hint', r.objective));
        if (applied) box.append(el('p', 'hint', t.form && dirty.has(t.form) ? 'Aplicado ao formulário: falta clicar em «Guardar dados».' : 'São o título e o objetivo atuais.'));
        else box.append(button('Aplicar ao formulário', 'accent', () => {
          if (t && t.form && dirty.has(t.form) && !confirm('Substituir o título e o objetivo que escreveu e ainda não guardou?')) return;
          if (t && r.title) t.value = r.title;
          if (obj && r.objective) obj.value = r.objective;
          if (t) { dirty.add(t.form); appliedForm = t.form; toPage(); t.scrollIntoView({ block: 'center' }); t.focus({ preventScroll: true }); }
          render(st); updateTips();
        }));
      }
      items.push(box);
    }
    out.replaceChildren(...items);
  };

  // Título e objetivo aplicados pelo assistente e ainda por guardar: o browser avisa antes de sair ou recarregar.
  let appliedForm = null;
  addEventListener('beforeunload', (ev) => { if (appliedForm && dirty.has(appliedForm)) { ev.preventDefault(); ev.returnValue = ''; } });

  const acts = [...panel.querySelectorAll('[data-act]')], req = document.getElementById('cp');
  // O pedido escrito em «O que pretende?» mantém-se entre as recargas da página.
  const REQ = 'compor:pedido:' + ivId;
  if (req) { const v = store.get('sessionStorage', REQ); if (typeof v === 'string') req.value = v; req.addEventListener('input', () => store.set('sessionStorage', REQ, req.value || null)); }
  // Um pedido falhado mostra o erro por cima das sugestões anteriores, que continuam válidas.
  const fail = (msg) => { render(last); out.prepend(el('div', 'flash bad', msg)); out.focus(); };
  acts.forEach((b) => (b.onclick = async () => {
    // o assistente lê o rascunho guardado, não o que está por guardar no ecrã
    if (dirty.size && !confirm('O assistente usa o que está guardado e há alterações por guardar nesta página. Pedir na mesma?')) return;
    acts.forEach((x) => (x.disabled = true));
    out.replaceChildren(el('p', 'hint', 'A preparar as sugestões… (até 30 s)'));
    try {
      const body = new URLSearchParams({ acao: b.dataset.act, pedido: req ? req.value : '' });
      const r = await fetch('/api/entrevistas/' + ivId + '/assistente', { method: 'POST', body, credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const j = await r.json().catch(() => null);
      if (!j || !j.ok) { fail((j && j.error) || (r.status === 413 ? 'O pedido é demasiado longo.' : 'O assistente não respondeu. Tente de novo.')); return; }
      const st = { result: j.result };
      save(st); render(st); out.focus(); // o foco fica no painel (o Escape continua a fechá-lo)
    } catch (e) {
      fail('Sem ligação ao servidor. Tente de novo.');
    } finally { acts.forEach((x) => (x.disabled = false)); }
  }));
  render(last);
  // Reaberto no telemóvel depois de uma ação dele: mostra logo as sugestões, não o topo do painel.
  if (reopen && !wide() && last) panel.scrollTop = out.offsetTop - 12;
  // Voltar atrás para esta página depois de uma ação do assistente ou de um formulário enviado nela: a página guardada
  // pelo browser (com o estado do script) é a de antes do envio (deixava acrescentar a mesma sugestão duas vezes e
  // dava por guardar o que já se guardou), por isso recarrega-se.
  // Sem essa ação, fica como está (as alterações por guardar não se perdem) e só se atualizam as dicas e o painel.
  addEventListener('pageshow', (ev) => {
    if (ev.persisted && (sentFromHere || submittedHere)) { location.reload(); return; }
    render(last); updateTips();
  });
})();
