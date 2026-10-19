(function () {
  const data = document.getElementById('pdata');
  const aud = document.getElementById('aud');
  if (!data || !aud) return;
  const { subtitles, chapters } = JSON.parse(data.textContent);
  const cueEl = document.getElementById('cue'), sel = document.getElementById('lang'), spd = document.getElementById('spd');
  const chap = document.getElementById('chap'), tr = document.getElementById('tr');
  const fmt = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let cues = [], idx = -1;

  function load(lang) {
    cues = (lang && subtitles[lang]) || [];
    idx = -1; cueEl.textContent = '';
    tr.innerHTML = cues.length ? cues.map((c, i) => `<p class="sans" style="margin:.3em 0"><a href="#" data-i="${i}" style="text-decoration:none;color:inherit"><span class="hint">${fmt(c.startMs)}</span> ${c.speakerRole === 'host' ? '' : '<strong>›</strong> '}${esc(c.text)}</a></p>`).join('') : '<p class="hint">Subtitles are off or not available in this language.</p>';
  }
  tr.addEventListener('click', (e) => { const a = e.target.closest('a[data-i]'); if (!a) return; e.preventDefault(); aud.currentTime = cues[+a.dataset.i].startMs / 1000; aud.play(); });
  chap.innerHTML = chapters.map((c, i) => `<li><a href="#" data-t="${c.startMs}">${esc(c.title)}</a> <span class="hint">${fmt(c.startMs)}</span></li>`).join('') || '<li class="hint">—</li>';
  chap.addEventListener('click', (e) => { const a = e.target.closest('a[data-t]'); if (!a) return; e.preventDefault(); aud.currentTime = +a.dataset.t / 1000; aud.play(); });

  // Sincronização sempre derivada de currentTime: correta após seek e mudança de velocidade.
  function sync() {
    const ms = aud.currentTime * 1000;
    let i = cues.findIndex((c) => ms >= c.startMs && ms < c.endMs);
    if (i !== idx) {
      idx = i; cueEl.textContent = i >= 0 ? cues[i].text : '';
      tr.querySelectorAll('a.on').forEach((a) => { a.classList.remove('on'); a.style.background = ''; });
      if (i >= 0) { const a = tr.querySelector(`a[data-i="${i}"]`); if (a) { a.classList.add('on'); a.style.background = 'rgba(180,105,31,.18)'; } }
    }
  }
  let raf = 0;
  const loop = () => { sync(); raf = requestAnimationFrame(loop); };
  aud.addEventListener('play', () => { cancelAnimationFrame(raf); loop(); });
  aud.addEventListener('pause', () => { cancelAnimationFrame(raf); sync(); });
  aud.addEventListener('seeked', sync); aud.addEventListener('timeupdate', sync);
  spd.addEventListener('change', () => { aud.playbackRate = parseFloat(spd.value); });
  sel.addEventListener('change', () => { load(sel.value); sync(); });
  load(sel.value);
})();
