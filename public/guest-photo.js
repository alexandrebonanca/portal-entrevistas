// Produção: o entrevistador acrescenta uma fotografia do entrevistado (com a autorização de edição dada no convite).
(function () {
  const btn = document.getElementById('gphotoBtn');
  if (!btn || !window.PE) return;
  const file = document.getElementById('gphoto'), rights = document.getElementById('gphotoRights'), st = document.getElementById('gphotoSt');
  btn.onclick = async () => {
    const f = file.files[0];
    if (!f) { st.textContent = 'Escolha uma fotografia.'; return; }
    if (!rights.checked) { st.textContent = 'Confirme que é uma fotografia real do entrevistado e que tem o direito de a usar.'; return; }
    st.textContent = 'A enviar…'; btn.disabled = true;
    try {
      await PE.upload(btn.dataset.url, f, { 'X-Photo-Rights': '1' });
      location.href = location.pathname + '?ok=' + encodeURIComponent('Fotografia acrescentada: entra no próximo vídeo gerado.') + '#foto-convidado';
    } catch (e) {
      st.textContent = e.permanent && e.message && e.message !== 'rejected' ? e.message : 'Não foi possível enviar (use JPEG ou PNG).';
      btn.disabled = false;
    }
  };
})();
