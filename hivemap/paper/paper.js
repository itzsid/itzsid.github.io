// Paper page behaviour: KaTeX, active contents entry, citation popovers,
// copy-BibTeX button and a figure lightbox.
(function () {
  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }

  ready(function () {
    // math
    if (window.renderMathInElement) {
      try { renderMathInElement(document.body, { delimiters: [{ left: '$', right: '$', display: false }], throwOnError: false }); } catch (e) { /* leave raw TeX */ }
    }

    // contents: highlight the section in view
    var links = Array.prototype.slice.call(document.querySelectorAll('#toc-list a'));
    var targets = links.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); });
    function onScroll() {
      var y = window.scrollY + window.innerHeight * 0.25, cur = 0;
      targets.forEach(function (t, i) { if (t && t.offsetTop <= y) cur = i; });
      links.forEach(function (a, i) { a.classList.toggle('active', i === cur); });
    }
    window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

    // citation popovers
    var pop = document.getElementById('hover-popover');
    document.querySelectorAll('a.cite-link').forEach(function (a) {
      a.addEventListener('mouseenter', function () {
        var li = document.getElementById('bib-' + a.dataset.bib); if (!li) return;
        pop.innerHTML = li.innerHTML;
        var r = a.getBoundingClientRect(), w = Math.min(380, window.innerWidth - 24);
        pop.style.left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12)) + 'px';
        pop.style.top = (r.bottom + 8 + 160 > window.innerHeight ? r.top - 8 - pop.offsetHeight : r.bottom + 8) + 'px';
        pop.classList.add('show');
      });
      a.addEventListener('mouseleave', function () { pop.classList.remove('show'); });
    });

    // copy bibtex
    var btn = document.getElementById('copy-bibtex-btn');
    if (btn) btn.addEventListener('click', function (e) {
      e.preventDefault();
      var text = btn.dataset.bibtex;
      var done = function () { btn.classList.add('is-copied'); setTimeout(function () { btn.classList.remove('is-copied'); }, 1400); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () { location.hash = 'bibtex'; });
      else location.hash = 'bibtex';
    });

    // lightbox
    var box = document.getElementById('lightbox'), img = box.querySelector('img');
    document.querySelectorAll('a.fig-zoom').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); img.src = a.getAttribute('href'); img.alt = a.querySelector('img').alt; box.hidden = false; });
    });
    box.addEventListener('click', function () { box.hidden = true; });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') box.hidden = true; });
  });
})();
