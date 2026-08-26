// slot-reels.js — realistic scrolling-reel spin animation, shared by every slot machine.
//
// The slot HTML keeps its own 3-cell-per-reel resting layer (cellEl / paintSymbol) that
// the win + bonus code paints directly. This module only owns the SPIN: it drops a tall
// vertical strip over each reel, scrolls it downward (symbols travel top→bottom) with a
// fast blurred phase, then decelerates and lands on the server's final symbols reel-by-reel
// (left to right) with a small bounce — then hands the resting cells back to the page.
//
// Usage (replaces the old in-place flicker):
//   const anim = SlotReels.spin(document.getElementById('reels'), {
//     REELS, ROWS, REEL_SYMS, paint: paintSymbol, onReelStop: () => sfx('stop')
//   });
//   await anim.settle(grid);   // grid = row-major SymId[] from the server
//   anim.stop();               // on error / abort
//
// `paint(el, sym)` is the game's own paintSymbol, so the scrolling tiles use the exact same
// art as the resting cells — no per-machine changes needed here.

(function () {
  // Injected once: strip/tile layout + the gap-0 override so the scrolling strip lines up
  // pixel-perfect with the 3 resting cells (which are otherwise separated by a grid gap).
  const CSS = `
  #reels .reel{gap:0 !important;position:relative}
  #reels .reel .reel-strip{position:absolute;left:0;width:100%;top:0;will-change:transform;z-index:4;
    backface-visibility:hidden}
  #reels .reel .reel-strip.spinning{filter:blur(0.9px)}
  #reels .reel .reel-tile{width:100%;box-sizing:border-box}
  `;
  function injectCSS() {
    if (document.getElementById('slot-reels-css')) return;
    const s = document.createElement('style');
    s.id = 'slot-reels-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const randSym = (syms) => syms[(Math.random() * syms.length) | 0];

  function makeTile(paint, sym, cellH) {
    const t = document.createElement('div');
    paint(t, sym);                 // paint() sets className='cell …' + the symbol art
    t.classList.add('reel-tile');
    t.style.height = cellH + 'px';
    return t;
  }

  function spin(reelsEl, opts) {
    injectCSS();
    const { REELS, ROWS, REEL_SYMS, paint, onReelStop } = opts;
    const reelEls = Array.prototype.slice.call(reelsEl.querySelectorAll('.reel'));

    const state = reelEls.map((reelEl) => {
      const cellH = (reelEl.clientHeight / ROWS) || 1;
      const strip = document.createElement('div');
      strip.className = 'reel-strip spinning';
      // Conveyor: ROWS visible + 1 buffer tile above the window.
      const T = ROWS + 1;
      strip.style.top = (-cellH) + 'px';
      for (let i = 0; i < T; i++) strip.appendChild(makeTile(paint, randSym(REEL_SYMS), cellH));
      reelEl.appendChild(strip);
      return { reelEl, strip, cellH, ty: 0, raf: 0, running: true };
    });

    // Fast downward conveyor while we wait for the server. Each frame the strip slides down;
    // once it has moved a full cell, the bottom tile recycles to the top as a fresh random,
    // so the scroll is endless and seamless.
    state.forEach((st) => {
      const perFrame = Math.max(7, st.cellH * 0.55);
      const step = () => {
        if (!st.running) return;
        st.ty += perFrame;
        while (st.ty >= st.cellH) {
          st.ty -= st.cellH;
          st.strip.removeChild(st.strip.lastChild);
          st.strip.insertBefore(makeTile(paint, randSym(REEL_SYMS), st.cellH), st.strip.firstChild);
        }
        st.strip.style.transform = 'translateY(' + st.ty + 'px)';
        st.raf = requestAnimationFrame(step);
      };
      st.raf = requestAnimationFrame(step);
    });

    function removeStrip(st) {
      st.running = false;
      cancelAnimationFrame(st.raf);
      if (st.strip && st.strip.parentNode) st.strip.parentNode.removeChild(st.strip);
    }
    function stop() { state.forEach(removeStrip); }

    // Land one reel on its 3 final symbols with a decelerating downward scroll + tiny bounce.
    // Strip is rebuilt as [f0,f1,f2, K randoms]; starting translated up by K cells (window on
    // the randoms) and eased to 0 (window on the finals) makes symbols scroll top→bottom and
    // settle exactly on the resting-cell positions.
    function landReel(st, finals) {
      return new Promise((resolve) => {
        st.running = false;
        cancelAnimationFrame(st.raf);
        const cellH = st.cellH;
        const K = 12; // randoms scrolled through while decelerating
        const strip = st.strip;
        strip.className = 'reel-strip';        // drop the blur for the crisp landing
        strip.style.top = '0px';
        strip.innerHTML = '';
        finals.forEach((s) => strip.appendChild(makeTile(paint, s, cellH)));
        for (let i = 0; i < K; i++) strip.appendChild(makeTile(paint, randSym(REEL_SYMS), cellH));
        strip.style.transition = 'none';
        strip.style.transform = 'translateY(' + (-K * cellH) + 'px)';
        void strip.offsetHeight;               // force reflow so the start position sticks
        strip.style.transition = 'transform 460ms cubic-bezier(.16,.74,.2,1.02)'; // slight overshoot
        let done = false;
        const finish = () => { if (done) return; done = true; strip.removeEventListener('transitionend', finish); resolve(); };
        strip.addEventListener('transitionend', finish);
        requestAnimationFrame(() => { strip.style.transform = 'translateY(0px)'; });
        setTimeout(finish, 620);               // safety in case transitionend is missed
      });
    }

    async function settle(grid) {
      for (let reel = 0; reel < REELS; reel++) {
        await wait(reel === 0 ? 180 : 140);    // left-to-right stagger
        await landReel(state[reel], [grid[reel], grid[REELS + reel], grid[2 * REELS + reel]]);
        // Hand the result to the page's resting cells, then drop the strip.
        const cells = state[reel].reelEl.querySelectorAll('.cell:not(.reel-tile)');
        for (let row = 0; row < ROWS; row++) if (cells[row]) paint(cells[row], grid[row * REELS + reel]);
        removeStrip(state[reel]);
        if (onReelStop) onReelStop();
      }
    }

    return { stop, settle };
  }

  window.SlotReels = { spin };
})();
