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
  const docIn = document.getElementById('docIn');
  const textReview = document.getElementById('textReview');
  const textOut = document.getElementById('textOut');
  const listen = document.getElementById('listen');
  const left = document.getElementById('left'); // «Tempo restante» (só quando a entrevista tem tempo total)
  let ctl = null, pending = null, objUrl = null, hitLimit = false;
  let saved = msg.saved || 0; // segundos da resposta desta pergunta guardada no servidor

  const say = (t) => { if (st) st.textContent = t; };
  // msg.base: segundos que esta resposta pode usar (uma nova gravação substitui a guardada); null = sem tempo total.
  const showLeft = (sec) => { if (left && msg.base != null) left.querySelector('strong').textContent = PE.fmt(Math.max(0, sec)); };
  const enableNext = () => { if (next) { next.style.pointerEvents = ''; next.style.opacity = ''; next.setAttribute('aria-disabled', 'false'); } };
  const disableNext = () => { if (next) { next.style.pointerEvents = 'none'; next.style.opacity = '.5'; next.setAttribute('aria-disabled', 'true'); } };

  // Leitura da pergunta: o áudio gravado pelo entrevistador, se existir (e então nunca voz sintética); senão a leitura do
  // servidor (pedida uma vez); em último caso a síntese do navegador. Uma só voz de cada vez (PE.solo); repetir recomeça.
  const qAudio = document.getElementById('qaudio');
  let tts = null, loading = false;
  if (listen) listen.addEventListener('click', async () => {
    if (ctl || loading) return; // não reproduzir enquanto grava nem pedir a leitura duas vezes
    const ready = qAudio || tts;
    if (ready) { ready.currentTime = 0; PE.solo.play(ready); return; }
    const n = PE.solo.stop();
    loading = true;
    try {
      const r = await fetch('/api/g/leitura/' + listen.dataset.q, { credentials: 'same-origin' });
      if (!r.ok) throw new Error('no tts');
      tts = new Audio(URL.createObjectURL(await r.blob()));
      if (n === PE.solo.n && !ctl) PE.solo.play(tts); // entretanto tocou outro som ou começou a gravação: não se sobrepõe
    } catch (_) {
      if (n === PE.solo.n && !ctl) PE.solo.speak(listen.dataset.text, listen.dataset.lang);
    } finally { loading = false; }
  });

  // via 'document': ficheiro Word/texto, enviado à rota própria; o servidor devolve o texto lido para o convidado o confirmar.
  async function send(blob, via) {
    pending = { blob, via };
    say(msg.stUp);
    const doc = via === 'document';
    try {
      const j = await PE.upload(doc ? docIn.dataset.upload : rec.dataset.upload, blob, { 'X-Upload-Via': via });
      say(msg.stSaved + (hitLimit ? ' — ' + msg.limitReached : '') + (j.silent ? ' — ' + msg.silent : ''));
      if (doc) showText(j.text || '');
      pending = null; enableNext();
      if (redo) redo.hidden = false;
      saved = (j.durationMs || 0) / 1000;
      showLeft(j.remainingSec != null ? j.remainingSec : msg.base - saved);
    } catch (e) {
      if (!doc) disableNext(); // um ficheiro recusado não mexe na resposta já guardada (que continua à vista)
      if (doc) say(e.serverMessage || (e.code === 'empty' ? msg.docEmpty : e.code === 'format' ? msg.docFormat : e.code === 'tooBig' || e.code === 'Payload Too Large' ? msg.docTooBig : msg.stFail));
      else say(e.code === 'empty' ? msg.empty : e.code === 'tooLong' ? msg.tooLong
        : e.code === 'storage' && e.serverMessage ? e.serverMessage
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
    if (textReview) textReview.hidden = true;
  }
  function showText(text) {
    if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = null; }
    player.removeAttribute('src'); review.hidden = true;
    textOut.textContent = text; textReview.hidden = false;
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
    PE.solo.stop(); // nenhuma voz a tocar (nem a leitura sintética) para o microfone não a apanhar
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

  if (redo) redo.addEventListener('click', () => { review.hidden = true; player.removeAttribute('src'); if (textReview) textReview.hidden = true; redo.hidden = true; timer.textContent = '0:00'; say(''); disableNext(); showLeft(msg.base); });

  if (fileIn) fileIn.addEventListener('change', () => {
    const f = fileIn.files[0]; if (!f) return;
    show(f); say(msg.stLocal); send(f, 'upload');
  });

  if (docIn) docIn.addEventListener('change', () => {
    const f = docIn.files[0]; if (!f) return;
    docIn.value = ''; // o mesmo ficheiro, corrigido, pode voltar a ser escolhido
    if (f.size > msg.docMaxBytes) { say(msg.docTooBig); return; }
    document.querySelectorAll('audio').forEach((a) => a.pause());
    send(new Blob([f], { type: 'application/octet-stream' }), 'document');
  });
})();
