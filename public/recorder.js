/* Núcleo de gravação: MediaRecorder com deteção de formato, sem presumir WebM (Safari/iOS usa MP4/AAC). */
(function () {
  const PE = (window.PE = window.PE || {});
  PE.pickMime = function () {
    if (!window.MediaRecorder) return '';
    const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    return c.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  };
  PE.fmt = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

  // Uma só voz de cada vez: começar um som (<audio>/<video> com som da página, leitura do servidor, síntese do navegador)
  // cala os outros. solo.n muda a cada som novo ou paragem: uma leitura pedida que chegue depois disso já não toca.
  const solo = (PE.solo = { el: null, n: 0 });
  const quiet = (keep) => {
    document.querySelectorAll('audio, video').forEach((m) => { if (m !== keep && !m.muted && !m.paused) m.pause(); });
    if (solo.el && solo.el !== keep) solo.el.pause();
    if (window.speechSynthesis) speechSynthesis.cancel();
  };
  // 'play' não sobe na árvore: apanha-se na fase de captura (inclui o play nativo dos controlos).
  document.addEventListener('play', (e) => { if (e.target.muted) return; solo.n++; quiet(e.target); }, true);
  solo.stop = () => { quiet(null); return ++solo.n; };
  solo.play = (m) => { quiet(m); if (!m.isConnected) solo.el = m; return Promise.resolve(m.play()).catch(() => {}); };
  solo.speak = (text, lang) => {
    if (!('speechSynthesis' in window)) return;
    quiet(null);
    const u = new SpeechSynthesisUtterance(text); u.lang = lang; speechSynthesis.speak(u);
  };

  // Aviso do navegador antes de sair da página a meio de uma gravação ou de um envio (por exemplo, pela ligação «Ajuda»).
  let busy = 0;
  window.addEventListener('beforeunload', (e) => { if (busy > 0) { e.preventDefault(); e.returnValue = ''; } });

  /** Pede o microfone SÓ quando chamado a partir de um gesto do utilizador. Ao chegar a maxSec pára e avisa (onLimit). */
  PE.startRecording = async function (onTick, maxSec, onLimit) {
    if (!navigator.mediaDevices || !window.MediaRecorder) throw Object.assign(new Error('unsupported'), { code: 'none' });
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      throw Object.assign(e, { code: e.name === 'NotFoundError' ? 'none' : 'denied' });
    }
    const mime = PE.pickMime();
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    const t0 = Date.now();
    let timer = null, stopped, interrupted = false;
    const done = new Promise((res) => (stopped = res));
    mr.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      busy = Math.max(0, busy - 1);
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop()); // liberta o microfone
      document.removeEventListener('visibilitychange', onVis);
      stopped(new Blob(chunks, { type: (mr.mimeType || mime || 'audio/webm').split(';')[0] }));
    };
    const onVis = () => { if (document.hidden) interrupted = true; };
    document.addEventListener('visibilitychange', onVis);
    stream.getAudioTracks().forEach((t) => (t.onended = () => { if (mr.state !== 'inactive') mr.stop(); })); // chamada/bloqueio
    mr.start(1000); // timeslice: os chunks só fazem sentido juntos no contentor
    busy++;
    timer = setInterval(() => {
      const s = (Date.now() - t0) / 1000;
      onTick && onTick(s);
      if (maxSec && s >= maxSec && mr.state !== 'inactive') { mr.stop(); if (onLimit) setTimeout(onLimit, 0); }
    }, 250);
    return { stop: () => { if (mr.state !== 'inactive') mr.stop(); return done; }, wasInterrupted: () => interrupted, seconds: () => (Date.now() - t0) / 1000 };
  };

  /** Envio com repetição e chave de idempotência; só "guardado" quando o servidor confirma. */
  PE.upload = async function (url, blob, extra) {
    busy++;
    try { return await send(url, blob, extra); } finally { busy = Math.max(0, busy - 1); }
  };
  async function send(url, blob, extra) {
    const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random();
    let last;
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: Object.assign({ 'Content-Type': (blob.type || 'application/octet-stream').split(';')[0], 'X-Upload-Id': id }, extra || {}), body: blob });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok) return j;
        if (r.status >= 400 && r.status < 500 && r.status !== 429) throw Object.assign(new Error(j.error || 'rejected'), { permanent: true, code: j.error, remainingSec: j.remainingSec, serverMessage: j.message });
        last = new Error('http ' + r.status);
      } catch (e) { if (e.permanent) throw e; last = e; }
      await new Promise((res) => setTimeout(res, 800 * 2 ** i));
    }
    throw last;
  }
})();
