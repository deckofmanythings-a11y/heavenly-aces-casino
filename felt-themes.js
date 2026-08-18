/* ============================================================================
   felt-themes.js -- shared board-colour picker, companion to felt-themes.css.

   One call wires a game up:

     FeltThemes.init({
       root:      '#table-panel',     // element that carries data-felt
       key:       'paigow_felt',      // localStorage key, per game
       defaultId: 'classic',          // that game's OWN current look
       mount:     '#some-flex-row',   // where the trigger button goes
       preview:   'ANTE',             // word shown on the preview swatches
     });

   The palette list is DISCOVERED from the stylesheets, never hand-maintained
   here. A JS array of themes duplicating what the CSS already declares is a
   second source of truth: add a palette block, forget the array entry, and the
   theme exists but is unreachable with nothing failing loudly to say why. Each
   palette announces its own display name via --theme-label, so adding a seventh
   really is one CSS block and nothing else.
   ========================================================================== */
(function (global) {
  'use strict';

  function unquote(s) {
    s = (s || '').trim();
    return s.replace(/^["']|["']$/g, '');
  }

  // Walks every stylesheet for [data-felt="x"] blocks, in source order.
  function discover() {
    const seen = new Set(), found = [];
    const scan = (rules) => {
      for (const r of rules || []) {
        // Style rule FIRST. Recursing on `r.cssRules` being truthy looks right and
        // silently breaks everything: in Chrome a plain CSSStyleRule also exposes a
        // cssRules property (an empty list, which is truthy), so every ordinary rule
        // gets mistaken for a grouping rule, descended into and skipped -- the scan
        // visits zero style rules and finds no themes, throwing nothing to say why.
        if (r.selectorText && r.style) {
          const m = /\[data-felt=["']?([\w-]+)["']?\]/.exec(r.selectorText);
          if (m && !seen.has(m[1])) {
            seen.add(m[1]);
            found.push({
              id: m[1],
              name: unquote(r.style.getPropertyValue('--theme-label')) || m[1],
              scheme: unquote(r.style.getPropertyValue('--theme-scheme')) || 'light',
            });
          }
        } else if (r.cssRules) {
          scan(r.cssRules); // @media / @supports wrappers
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try { scan(sheet.cssRules); } catch (e) { /* cross-origin sheets throw */ }
    }
    return found;
  }

  function make(cfg) {
    const themes = discover();
    // The game's own look leads the list; everything else keeps CSS source order.
    const idx = themes.findIndex(t => t.id === cfg.defaultId);
    if (idx > 0) themes.unshift(themes.splice(idx, 1)[0]);

    const known = id => themes.some(t => t.id === id);
    const fallback = () => (known(cfg.defaultId) ? cfg.defaultId : (themes[0] && themes[0].id));

    function current() {
      let v = null;
      try { v = localStorage.getItem(cfg.key); } catch (e) { /* storage throws in embedded contexts */ }
      // Anything unrecognised (a renamed or deleted palette left in storage) falls
      // back rather than leaving the board with no palette at all.
      return known(v) ? v : fallback();
    }

    function apply(id, persist) {
      const theme = known(id) ? id : fallback();
      document.querySelectorAll(cfg.root).forEach(el => el.setAttribute('data-felt', theme));
      if (persist) { try { localStorage.setItem(cfg.key, theme); } catch (e) {} }
      const grid = document.getElementById('felt-grid');
      if (grid) [...grid.children].forEach(c => {
        const on = c.dataset.felt === theme;
        c.classList.toggle('on', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    function buildModal() {
      if (document.getElementById('modal-felt')) return;
      const wrap = document.createElement('div');
      wrap.className = 'modal-overlay hidden';
      wrap.id = 'modal-felt';
      wrap.innerHTML =
        '<div class="modal-box" style="max-height:80vh;display:flex;flex-direction:column">' +
          '<div class="modal-title" style="margin-bottom:2px">Board Colour</div>' +
          '<div class="modal-sub" style="margin-bottom:10px;font-size:13px;color:rgba(255,255,255,.55)">' +
            'Applies to this board only, and is remembered.</div>' +
          '<div class="felt-grid" id="felt-grid" role="group" aria-label="Board colour"></div>' +
          '<button class="modal-btn cancel" id="felt-close" style="margin-top:10px">Close</button>' +
        '</div>';
      document.body.appendChild(wrap);
      wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
      document.getElementById('felt-close').addEventListener('click', close);

      const grid = document.getElementById('felt-grid');
      themes.forEach(t => {
        // Each card carries the palette as a .felt-<id> class, so it is painted by the
        // exact declarations the board itself uses -- a palette cannot look one way in
        // the picker and another on the felt, and a new theme needs no preview artwork.
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'felt-card felt-' + t.id;
        card.dataset.felt = t.id;
        card.innerHTML = '<span class="felt-prev"><span></span></span><span class="felt-name"></span>';
        card.querySelector('.felt-prev span').textContent = cfg.preview || 'BET';
        card.querySelector('.felt-name').textContent = t.name;
        card.addEventListener('click', () => apply(t.id, true));
        grid.appendChild(card);
      });
    }

    function open() { buildModal(); apply(current(), false); document.getElementById('modal-felt').classList.remove('hidden'); }
    function close() { const m = document.getElementById('modal-felt'); if (m) m.classList.add('hidden'); }

    function mountButton() {
      const host = document.querySelector(cfg.mount);
      if (!host || host.querySelector('.felt-btn')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'felt-btn';
      btn.title = 'Board colour';
      btn.setAttribute('aria-label', 'Board colour');
      btn.addEventListener('click', open);
      host.appendChild(btn);
    }

    // Applied before the board is first painted, so there is no flash of the default
    // palette on every load. The button can wait for DOM ready; the attribute cannot.
    apply(current(), false);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { apply(current(), false); mountButton(); });
    } else {
      mountButton();
    }

    return { open, close, apply, current, themes };
  }

  global.FeltThemes = { init: make, discover };
})(window);
