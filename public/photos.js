(function () {
  const root = document.getElementById('cam');
  if (!root) return;
  const msg = JSON.parse(root.dataset.msg);
  const vid = document.getElementById('vid'), cv = document.getElementById('cv'), st = document.getElementById('pst');
  const camBtn = document.getElementById('camBtn'), shot = document.getElementById('shotBtn');
  const prev = document.getElementById('prev'), prevImg = document.getElementById('prevImg');
  const keep = document.getElementById('keepBtn'), drop = document.getElementById('dropBtn'), fileIn = document.getElementById('photoIn');
  let stream = null, pendingBlob = null;

  const stopCam = () => { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } vid.hidden = true; shot.hidden = true; };
  window.addEventListener('pagehide', stopCam);

  camBtn.onclick = async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      vid.srcObject = stream; vid.hidden = false; shot.hidden = false; st.textContent = '';
    } catch (e) { st.textContent = msg.camDenied; }
  };
  shot.onclick = () => { // uma fotografia por toque — nunca em rajada
    cv.width = vid.videoWidth; cv.height = vid.videoHeight;
    cv.getContext('2d').drawImage(vid, 0, 0); // ficheiro NÃO espelhado (a pré-visualização em vídeo é só um espelho visual)
    cv.toBlob((b) => { pendingBlob = b; prevImg.src = URL.createObjectURL(b); prev.hidden = false; stopCam(); }, 'image/jpeg', 0.9);
  };
  drop.onclick = () => { pendingBlob = null; prev.hidden = true; camBtn.click(); }; // descartada: nada é enviado
  keep.onclick = async () => {
    st.textContent = msg.stUp;
    try { await PE.upload('/api/g/fotos', pendingBlob); location.reload(); }
    catch (e) { st.textContent = e.code === 'max' ? msg.max3 : e.code === 'storage' && e.serverMessage ? e.serverMessage : msg.stFail; }
  };
  if (fileIn) fileIn.onchange = async () => {
    const f = fileIn.files[0]; if (!f) return;
    // Reencoda por canvas: remove EXIF/geolocalização e normaliza a orientação.
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
      const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      cv.toBlob((b) => { pendingBlob = b; prevImg.src = URL.createObjectURL(b); prev.hidden = false; }, 'image/jpeg', 0.9);
    } catch (e) { st.textContent = msg.stFail; }
  };
})();
