(function () {
  const rec = document.getElementById('guestrec');
  const msg = rec ? JSON.parse(rec.dataset.msg) : {};
  const st = document.getElementById('st');
  const timer = document.getElementById('timer');
  const btn = document.getElementById('recBtn');
  const review = document.getElementById('review');
  const player = document.getElementById('player');
  const redo = document.getElementById('redoBtn');
  const next = document.getElementById('next');
  const fileIn = document.getElementById('fileIn');
  const listen = document.getElementById('listen');
  const left = document.getElementById('left'); // «Tempo restante» (só quando a entrevista tem tempo total)
  let ctl = null, pending = null, objUrl = null, hitLimit = false;
  let saved = msg.saved || 0; // segundos da resposta desta pergunta guardada no servidor

  const say = (t) => { if (st) st.textContent = t; };
  // msg.base: segundos que esta resposta pode usar (uma nova gravação substitui a guardada); null = sem tempo total.
  const showLeft = (sec) => { if (left && msg.base != null) left.querySelector('strong').textContent = PE.fmt(Math.max(0, sec)); };
  const enableNext = () => { if (next) { next.style.pointerEvents = ''; next.style.opacity = ''; next.setAttribute('aria-disabled', 'false'); } };
  const disableNext = () => { if (next) { next.style.pointerEvents = 'none'; next.style.opacity = '.5'; next.setAttribute('aria-disabled', 'true'); } };

  // Leitura da pergunta: áudio original se existir; senão leitura sintética do servidor; em último caso, síntese do navegador (alternativa de acessibilidade).
  if (listen) listen.addEventListener('click', async () => {
    if (ctl) return; // não reproduzir enquanto grava
    const a = document.querySelector('audio[src^="/api/g/media"]');
    if (a && a !== player && !a.closest('#review')) { a.currentTime = 0; a.play(); return; }
    try {
      const r = await fetch('/api/g/leitura/' + listen.dataset.q, { credentials: 'same-origin' });
      if (!r.ok) throw new Error('no tts');
      const b = await r.blob();
      const au = new Audio(URL.createObjectURL(b)); au.play();
    } catch (_) {
      if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(listen.dataset.text); u.lang = listen.dataset.lang; speechSynthesis.cancel(); speechSynthesis.speak(u); }
    }
  });

  async function send(blob, via) {
    pending = { blob, via };
    say(msg.stUp);
    try {
      const j = await PE.upload(rec.dataset.upload, blob, { 'X-Upload-Via': via });
      say(msg.stSaved + (hitLimit ? ' — ' + msg.limitReached : '') + (j.silent ? ' — ' + msg.silent : ''));
      pending = null; enableNext();
      if (redo) redo.hidden = false;
      saved = (j.durationMs || 0) / 1000;
      showLeft(j.remainingSec != null ? j.remainingSec : msg.base - saved);
    } catch (e) {
      disableNext();
      say(e.code === 'empty' ? msg.empty : e.code === 'tooLong' ? msg.tooLong
        : e.code === 'overTotal' ? (e.serverMessage || msg.overTotal.replace('{t}', PE.fmt(e.remainingSec || 0))) : msg.stFail);
      showLeft(msg.base - saved); // a resposta guardada antes continua a valer
      if (!e.permanent) addRetry();
    }
    hitLimit = false;
  }
  function addRetry() {
    if (document.getElementById('retry')) return;
    const b = document.createElement('button'); b.id = 'retry'; b.type = 'button'; b.className = 'ghost'; b.textContent = msg.retry;
    b.onclick = () => { b.remove(); send(pending.blob, pending.via); };
    st.after(b);
  }

  function show(blob) {
    if (objUrl) URL.revokeObjectURL(objUrl);
    objUrl = URL.createObjectURL(blob);
    player.src = objUrl; review.hidden = false;
  }

  if (btn) btn.addEventListener('click', async () => {
    if (ctl) { // parar
      const c = ctl; ctl = null;
      btn.classList.remove('on'); btn.textContent = msg.record;
      const blob = await c.stop();
      if (!blob.size || c.seconds() < 0.5) { say(msg.empty); return; }
      show(blob); say(msg.stLocal);
      send(blob, 'recording');
      return;
    }
    document.querySelectorAll('audio').forEach((a) => a.pause());
    if (window.speechSynthesis) speechSynthesis.cancel();
    disableNext();
    try {
      hitLimit = false;
      // Pára sozinho no limite (5 min por resposta, ou o tempo que resta da entrevista) e envia.
      ctl = await PE.startRecording((s) => { timer.textContent = PE.fmt(s); showLeft(msg.base - s); }, msg.maxSec, () => { if (ctl) { hitLimit = true; btn.click(); } });
      btn.classList.add('on'); btn.textContent = msg.stop; say('●');
    } catch (e) {
      ctl = null; say(e.code === 'none' ? msg.micNone : msg.micDenied);
    }
  });

  if (redo) redo.addEventListener('click', () => { review.hidden = true; player.removeAttribute('src'); redo.hidden = true; timer.textContent = '0:00'; say(''); disableNext(); showLeft(msg.base); });

  if (fileIn) fileIn.addEventListener('change', () => {
    const f = fileIn.files[0]; if (!f) return;
    show(f); say(msg.stLocal); send(f, 'upload');
  });
})();
