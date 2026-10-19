(function () {
  const box = document.getElementById('progress');
  if (!box) return;
  const fill = box.querySelector('.pfill'), bar = box.querySelector('.pbar');
  const pct = box.querySelector('.ppct'), step = box.querySelector('.pstep');
  const elapsed = box.querySelector('.pelapsed'), eta = box.querySelector('.peta');
  const fmt = (s) => {
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s / 60), r = s % 60;
    return m ? `${m} min ${String(r).padStart(2, '0')} s` : `${r} s`;
  };
  let localEta = null, lastAt = 0, failures = 0;

  async function poll() {
    try {
      const r = await fetch(box.dataset.url, { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      failures = 0;
      if (!j.active) { location.reload(); return; } // terminou (ou falhou): a página mostra o resultado
      fill.style.width = j.percent + '%';
      bar.setAttribute('aria-valuenow', j.percent);
      pct.textContent = j.percent + '%';
      step.textContent = j.label || '';
      elapsed.textContent = j.elapsedSec ? 'Decorrido: ' + fmt(j.elapsedSec) + '.' : '';
      localEta = j.etaSec; lastAt = Date.now();
      render();
    } catch (e) {
      if (++failures > 3) step.textContent = 'Sem ligação ao servidor; a tentar de novo…';
    }
    setTimeout(poll, 2500);
  }
  function render() {
    if (localEta == null) { eta.textContent = 'A calcular o tempo restante…'; return; }
    const left = localEta - (Date.now() - lastAt) / 1000;
    eta.textContent = left > 5 ? 'Faltam cerca de ' + fmt(left) + '.' : 'Quase concluído…';
  }
  setInterval(render, 1000); // contagem decrescente suave entre atualizações
  poll();
})();
