(function () {
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
      try { await PE.upload(target, blob); st.textContent = 'Guardado no servidor.'; setTimeout(() => location.reload(), 600); }
      catch (e) { st.textContent = e.permanent && e.message ? e.message : 'Falhou o envio.'; bSave.disabled = false; }
    };
  });

  const pb = document.getElementById('photoBtn');
  if (pb) pb.onclick = async () => {
    const f = document.getElementById('photo').files[0]; const st = document.getElementById('photoSt');
    if (!f) return;
    const id = document.querySelector('[data-interview]').dataset.interview;
    st.textContent = 'A enviar…';
    try { await PE.upload('/api/entrevistas/' + id + '/foto', f); location.reload(); } catch (e) { st.textContent = 'Formato não suportado (use JPEG ou PNG).'; }
  };
})();
