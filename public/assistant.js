// Assistente virtual da página de ajuda: com JavaScript responde sem recarregar a página;
// sem ele (ou se o pedido falhar) os formulários funcionam por si.
(function () {
  var box = document.getElementById('assistente');
  var out = document.getElementById('as-out');
  if (!box || !out || !window.fetch || !window.URLSearchParams) return;

  // Depois de «Isto ajudou?», o foco vai para o agradecimento (não volta a ler a resposta inteira).
  function focusResult(afterFeedback) {
    var r = (afterFeedback && out.querySelector('#as-resposta [role=status]')) || document.getElementById('as-resposta') || out.querySelector('.flash');
    if (r) { if (!r.hasAttribute('tabindex')) r.setAttribute('tabindex', '-1'); r.focus(); }
  }

  // Ir para outro endereço; se for a própria página (só muda o fragmento), recarrega para mostrar o estado novo.
  function go(url) {
    var to = new URL(url, location.href);
    if (to.pathname + to.search !== location.pathname + location.search) { location.href = to.href; return; }
    if (history.replaceState) history.replaceState(null, '', to.pathname + to.search + to.hash);
    location.reload();
  }

  box.addEventListener('submit', function (ev) {
    var f = ev.target;
    if (!f || !f.hasAttribute || !f.hasAttribute('data-as')) return;
    ev.preventDefault();
    var body = new URLSearchParams(new FormData(f));
    var b = ev.submitter;
    if (b && b.name) body.set(b.name, b.value);
    var feedback = !!f.querySelector('button[name=v]');
    var buttons = f.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    f.setAttribute('aria-busy', 'true');
    fetch(f.action, { method: 'POST', body: body, credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.redirect) { go(j.redirect); return; }
        if (typeof j.html !== 'string') throw new Error('resposta inesperada');
        out.innerHTML = j.html; // HTML já escapado no servidor
        if (j.url && history.replaceState) history.replaceState(null, '', j.url + '#as-resposta');
        if (!j.error && f.querySelector('textarea')) f.querySelector('textarea').value = '';
        for (var k = 0; k < buttons.length; k++) buttons[k].disabled = false;
        f.removeAttribute('aria-busy');
        focusResult(feedback && !j.error);
      })
      .catch(function () {
        // Sem resposta legível: envia o formulário de forma normal (com o botão escolhido, se houver).
        if (b && b.name) { var h = document.createElement('input'); h.type = 'hidden'; h.name = b.name; h.value = b.value; f.appendChild(h); }
        f.removeAttribute('data-as'); f.submit();
      });
  });
})();
