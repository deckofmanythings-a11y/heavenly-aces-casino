/* ============================================================
   winner-modal.js
   Shared "you win $X" overlay for the bubble machine tables: metallic
   gold payout text, pulsing god-ray sunburst sized to the actual text,
   a 3D flipping gold-coin firework waterfall, and a "big win"
   pulse/enlarge state. Builds its own DOM (like cloche-dice.js) so a
   host page just needs one script include and one function call.

   Requires (load before this file):
     cloche-dice.js -- optional; if window.ClocheDice.playChimeNote
     exists, the coin waterfall reuses its bell-chime instrument for an
     "excited" coin-shower sound. Works without it, just silently.

   INTEGRATION:
     WinnerModal.show(amount);
     WinnerModal.show(amount, { big: true });
     WinnerModal.show(amount, { big: bestFor1>=7, onClose: playAgain });

   amount<=0 is a no-op (matches every host page's existing behavior:
   no modal for a zero payout, caller just moves on).
   ============================================================ */
(function (global) {
  'use strict';

  let overlayEl, amtEl, raysEl, coinsEl, bigtagEl, titleEl;
  let winnerTimer = null, _winnerAmount = 0, _winnerAnimating = false, _onClose = null;

  // ---------- DOM ----------
  // Six rays, each rolled its own pulse speed/distance within the same margin (duration
  // 1.5-2.5s -- 3x the original 4.5-7.5s pace per Deck -- shrinking to .35-.55x and stretching
  // out to 1.5-2x its base reach) so they lengthen and retract out of sync with each other.
  // Negative delays start each beam mid-cycle instead of all at frame 0, so they don't read as
  // synced for the first couple seconds after the modal opens.
  function buildRaysHTML() {
    let html = '<div class="wm-winner-rays-wobble">';
    for (let i = 0; i < 6; i++) {
      const dur = (1.5 + Math.random()).toFixed(2);
      const delay = (Math.random() * 0.83).toFixed(2);
      const scaleMin = (0.35 + Math.random() * 0.2).toFixed(3);
      const scaleMax = (1.5 + Math.random() * 0.5).toFixed(3);
      html += '<div class="wm-winner-ray" data-ray="' + i + '">' +
        '<div class="wm-winner-ray-beam" style="animation-duration:' + dur + 's;animation-delay:-' + delay + 's;--wm-ray-scale-min:' + scaleMin + ';--wm-ray-scale-max:' + scaleMax + '"></div>' +
      '</div>';
    }
    html += '</div>';
    return html;
  }

  function buildOverlay() {
    const style = document.createElement('style');
    style.textContent = [
      // pointer-events:none -- this used to be tap-to-dismiss, which meant it had to capture
      // clicks over the whole viewport. Deck: let it just play out on its own timer instead and
      // never block anything underneath it, including Roll/Fire -- show() below already just
      // restarts cleanly (clears the old timer, resets the amount/animation) if it's called
      // again while still open.
      '#wm-modal-winner{position:fixed;inset:0;z-index:200;display:flex;align-items:flex-start;justify-content:center;padding-top:8vh;pointer-events:none}',
      '#wm-modal-winner.hidden{display:none}',
      '.wm-winner-box{position:relative;background:transparent;border:none;padding:20px 36px;text-align:center;box-shadow:none;animation:wmWinnerPop .3s cubic-bezier(.34,1.56,.64,1)}',
      '@keyframes wmWinnerPop{from{transform:scale(.5);opacity:0}to{transform:scale(1);opacity:1}}',
      '.wm-winner-title{position:relative;z-index:2;font-size:38px;font-weight:900;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.6);letter-spacing:.05em;line-height:1;margin-bottom:6px}',
      '.wm-winner-amount-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center;margin-top:5px}',
      '.wm-winner-amount{position:relative;z-index:2;font-size:124px;font-weight:900;isolation:isolate;',
      '  display:inline-flex;align-items:center;justify-content:center;line-height:1;',
      '  background:linear-gradient(180deg,#fff6cf 0%,#ffd700 20%,#a8720a 48%,#ffe680 55%,#c8930a 75%,#7a5000 100%);',
      '  -webkit-background-clip:text;background-clip:text;color:transparent;',
      '  -webkit-text-stroke:1.5px #5c3d00;',
      '  filter:drop-shadow(0 3px 2px rgba(0,0,0,.5)) drop-shadow(0 0 24px rgba(255,215,0,.8));',
      '  letter-spacing:.02em}',
      // wm-winner-rays is just the shared anchor point: centered on the text, scaled as a whole
      // by --wm-ray-span (set by sizeWinnerRays() below) so the cluster grows for bigger payout
      // text. No mask, no oval, no rotation of its own -- that all lives on its children now.
      '.wm-winner-rays{',
      '  position:absolute;top:50%;left:50%;z-index:1;pointer-events:none;',
      '  transform:translate(-50%,-50%) scale(var(--wm-ray-span,1));',
      '}',
      // wm-winner-rays-wobble gives all 6 rays one shared, gentle back-and-forth rotation (+/-2.5deg,
      // ~5deg total swing) -- same rate for every ray since it's a single animation on their
      // common parent, not six independent ones.
      '.wm-winner-rays-wobble{',
      '  position:absolute;top:0;left:0;width:1px;height:1px;',
      '  animation:wmGodRayWobble 7s ease-in-out infinite;',
      '}',
      '@keyframes wmGodRayWobble{',
      '  0%,100%{transform:rotate(-2.5deg)}',
      '  50%{transform:rotate(2.5deg)}',
      '}',
      // Each ray is its own fixed 640x640 square (undistorted rotation/gradient math) pinned at a
      // static 60deg-apart starting angle, same as before. The old oval's aspect ratio (440x180,
      // i.e. semi-axes 220x90) now informs a static per-angle reach scale instead of a clip mask:
      // r(theta) = a*b / sqrt((b*cos(theta))^2 + (a*sin(theta))^2), normalized to r(0)=1, gives
      // 1.0 at the 0/180 (left-right) rays and ~0.46 at the 60/120/240/300 (top/bottom-leaning)
      // rays -- so the horizontal rays reach about twice as far as the vertical-leaning ones,
      // matching how far that oval used to extend in each direction.
      // Whole set rotated -30deg (CCW) from the raw 0/60/120/180/240/300 layout per Deck, to
      // bring the long (scale 1) rays closer to horizontal -- reach scale per ray is unchanged,
      // just carried along with its own ray to the new angle.
      '.wm-winner-ray{',
      '  position:absolute;top:50%;left:50%;width:640px;height:640px;pointer-events:none;',
      '  transform:translate(-50%,-50%) rotate(-30deg) scale(1);',
      '}',
      '.wm-winner-ray[data-ray="1"]{transform:translate(-50%,-50%) rotate(30deg) scale(.46)}',
      '.wm-winner-ray[data-ray="2"]{transform:translate(-50%,-50%) rotate(90deg) scale(.46)}',
      '.wm-winner-ray[data-ray="3"]{transform:translate(-50%,-50%) rotate(150deg) scale(1)}',
      '.wm-winner-ray[data-ray="4"]{transform:translate(-50%,-50%) rotate(210deg) scale(.46)}',
      '.wm-winner-ray[data-ray="5"]{transform:translate(-50%,-50%) rotate(270deg) scale(.46)}',
      // The beam is the growing/shrinking part: a single conic-gradient wedge, radially masked so
      // it fades to transparent well before its tip (smooth taper, no hard cutoff line), pulsing
      // length via animated scale -- per-instance randomized speed/distance rolled in
      // buildRaysHTML() so the 6 rays breathe out of sync with each other.
      '.wm-winner-ray-beam{',
      '  position:absolute;inset:0;transform-origin:center;',
      '  background:conic-gradient(from 0deg,rgba(255,224,130,.85) 0deg 34deg,rgba(255,224,130,0) 34deg 360deg);',
      '  -webkit-mask-image:radial-gradient(circle at center,#000 0%,#000 45%,transparent 100%);',
      '  mask-image:radial-gradient(circle at center,#000 0%,#000 45%,transparent 100%);',
      '  animation-name:wmRayPulse;animation-timing-function:ease-in-out;animation-iteration-count:infinite;',
      '}',
      '@keyframes wmRayPulse{',
      '  0%,100%{transform:scale(var(--wm-ray-scale-min,.45))}',
      '  50%{transform:scale(var(--wm-ray-scale-max,1.7))}',
      '}',
      '.wm-winner-coins{position:absolute;top:50%;left:50%;width:0;height:0;z-index:1;pointer-events:none;}',
      '#wm-modal-winner.big .wm-winner-box{animation:wmWinnerPop .35s cubic-bezier(.34,1.56,.64,1),wmBigWinPulse 1.1s ease-in-out infinite .35s}',
      '@keyframes wmBigWinPulse{0%,100%{filter:brightness(1)}50%{filter:brightness(1.25)}}',
      '#wm-modal-winner.big .wm-winner-title{font-size:48px}',
      '#wm-modal-winner.big .wm-winner-amount{font-size:160px}',
      '.wm-winner-bigtag{display:none;position:relative;z-index:2;font-size:24px;font-weight:900;letter-spacing:.15em;color:#ffe680;text-shadow:0 2px 6px rgba(0,0,0,.7);margin-bottom:2px}',
      '#wm-modal-winner.big .wm-winner-bigtag{display:block}',
      // ---------- PUSH state: calmer sibling of the win celebration (no coin shower, no
      // god rays, silver/platinum text instead of gold) -- see showPush() below.
      '#wm-modal-winner.push .wm-winner-rays{display:none}',
      '#wm-modal-winner.push .wm-winner-amount{',
      '  background:linear-gradient(180deg,#f4f6f8 0%,#d8dee3 20%,#8b959c 48%,#eef1f3 55%,#aab2b8 75%,#5a6268 100%);',
      '  -webkit-background-clip:text;background-clip:text;color:transparent;',
      '  -webkit-text-stroke:1.5px #3a4045;',
      '  filter:drop-shadow(0 3px 2px rgba(0,0,0,.5)) drop-shadow(0 0 18px rgba(200,210,220,.6))}',
      '.wm-coin3d-wrap{position:absolute;top:0;left:0;pointer-events:none;transform-style:preserve-3d;}',
      '.wm-coin3d-inner{position:relative;width:100%;height:100%;transform-style:preserve-3d;}',
      '.wm-coin3d-face{position:absolute;inset:0;border-radius:50%;backface-visibility:hidden;overflow:hidden;box-shadow:inset 0 0 4px rgba(0,0,0,.45);}',
      '.wm-coin3d-face.wm-coin3d-front{transform:rotateX(90deg) translateZ(var(--wm-coin-half-t,3px));}',
      '.wm-coin3d-face.wm-coin3d-back{transform:rotateX(-90deg) translateZ(var(--wm-coin-half-t,3px));}',
      '.wm-coin3d-face-img{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
      '  background:radial-gradient(circle at 35% 28%,#fff8d6,#ffd700 42%,#c8930a 78%,#7a5000 100%);',
      '  color:#7a5000;font-weight:900;text-shadow:0 1px 0 rgba(255,255,255,.5);}',
      '.wm-coin3d-front .wm-coin3d-face-img{transform:scale(-1,-1);}',
      '.wm-coin3d-edge-seg{position:absolute;left:50%;top:50%;background:linear-gradient(90deg,#8a6c1a,#ffe680 50%,#8a6c1a);backface-visibility:hidden;}'
    ].join('');
    document.head.appendChild(style);

    overlayEl = document.createElement('div');
    overlayEl.id = 'wm-modal-winner';
    overlayEl.className = 'hidden';
    overlayEl.innerHTML =
      '<div class="wm-winner-box">' +
        '<div class="wm-winner-bigtag">BIG WIN</div>' +
        '<div class="wm-winner-title">🎉 Congratulations, you win 🎉</div>' +
        '<div class="wm-winner-amount-wrap">' +
          '<div class="wm-winner-rays">' + buildRaysHTML() + '</div>' +
          '<div class="wm-winner-coins"></div>' +
          '<div class="wm-winner-amount">$0.00</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlayEl);
    amtEl = overlayEl.querySelector('.wm-winner-amount');
    raysEl = overlayEl.querySelector('.wm-winner-rays');
    coinsEl = overlayEl.querySelector('.wm-winner-coins');
    bigtagEl = overlayEl.querySelector('.wm-winner-bigtag');
    titleEl = overlayEl.querySelector('.wm-winner-title');
  }

  // ---------- coins ----------
  // One reusable 3D coin builder (front/back faces + a ring of rim segments -- same technique
  // as the craps puck's extrusion) so the winner-amount coin waterfall gets real flipping discs
  // instead of flat spinning emoji.
  function createCoin3D(size) {
    const half = Math.max(2, size * 0.11);
    const wrap = document.createElement('div'); wrap.className = 'wm-coin3d-wrap';
    wrap.style.width = size + 'px'; wrap.style.height = size + 'px';
    wrap.style.setProperty('--wm-coin-half-t', half + 'px');
    const inner = document.createElement('div'); inner.className = 'wm-coin3d-inner';
    const front = document.createElement('div'); front.className = 'wm-coin3d-face wm-coin3d-front';
    const frontImg = document.createElement('div'); frontImg.className = 'wm-coin3d-face-img'; frontImg.textContent = '$'; frontImg.style.fontSize = (size * 0.52) + 'px'; front.appendChild(frontImg);
    const back = document.createElement('div'); back.className = 'wm-coin3d-face wm-coin3d-back';
    const backImg = document.createElement('div'); backImg.className = 'wm-coin3d-face-img'; backImg.textContent = '$'; backImg.style.fontSize = (size * 0.52) + 'px'; back.appendChild(backImg);
    inner.appendChild(front); inner.appendChild(back);
    const R = size / 2, SEGS = 20;
    const segW = 2 * R * Math.sin(Math.PI / SEGS) * 1.05;
    for (let i = 0; i < SEGS; i++) {
      const seg = document.createElement('div'); seg.className = 'wm-coin3d-edge-seg';
      const angle = (360 / SEGS) * i;
      seg.style.cssText = 'width:' + segW.toFixed(2) + 'px;height:' + (half * 2).toFixed(2) + 'px;margin-left:-' + (segW / 2).toFixed(2) + 'px;margin-top:-' + half.toFixed(2) + 'px;transform:rotateY(' + angle + 'deg) translateZ(' + R + 'px)';
      inner.appendChild(seg);
    }
    wrap.appendChild(inner);
    return { wrap, inner };
  }

  // Real firework physics: every coin launches from the exact same point (the shared center
  // anchor, which is also the god rays' center) and bursts outward within a 135deg cone facing
  // straight down -- i.e. angles from 22.5deg to 157.5deg in standard screen-angle terms
  // (0deg=right, 90deg=straight down, 180deg=left), never sideways-up or backwards-up. Each
  // coin travels outward along its own angle for the "explosion" phase, then gravity takes
  // over and pulls it further straight down for the "falling to earth" phase.
  function spawnCoinWaterfall(n) {
    if (!coinsEl) return;
    for (let i = 0; i < n; i++) {
      const size = (16 + Math.random() * 26) * 2;
      const { wrap, inner } = createCoin3D(size);
      wrap.style.marginLeft = (-size / 2) + 'px'; wrap.style.marginTop = (-size / 2) + 'px';
      coinsEl.appendChild(wrap);
      const angleDeg = 90 + (Math.random() - 0.5) * 135;
      const angleRad = angleDeg * Math.PI / 180;
      const dx = Math.cos(angleRad), dy = Math.sin(angleRad);
      const burst = 130 + Math.random() * 260;
      const gravityFall = 280 + Math.random() * 320;
      const dur = 1100 + Math.random() * 900;
      const delay = Math.random() * 1800;
      const p1x = dx * burst * 0.45, p1y = dy * burst * 0.45;
      const p2x = dx * burst, p2y = dy * burst + gravityFall * 0.4;
      const p3x = dx * burst * 1.1, p3y = dy * burst + gravityFall;
      // Both Animation objects are kept (rather than left to the return-value-discarded default)
      // and explicitly .cancel()'d alongside wrap.remove() below -- fill:'forwards' keeps a
      // finished animation "current" on the document's timeline indefinitely, and on WebKit/
      // Safari that keeps the Animation (and the coin element it targets) alive even after the
      // element is detached from the DOM, since detaching the target isn't what releases it --
      // only cancel() (or the animation never having fill:forwards) does. With a coin waterfall
      // spawning up to 56 coins x2 animations on every single win, every hand played on iOS was
      // leaking dozens of these permanently -- this is what actually accumulated into the
      // reported slowdown (confirmed to reproduce in real mobile Safari, not just Discord's
      // WebView, and NOT reproducible in Chromium, which releases finished fill:forwards
      // animations on element removal without needing an explicit cancel()).
      const anim1=wrap.animate([
        { transform: 'translate(0px,0px)', opacity: 0 },
        { transform: 'translate(' + p1x.toFixed(1) + 'px,' + p1y.toFixed(1) + 'px)', opacity: 1, offset: 0.12 },
        { transform: 'translate(' + p2x.toFixed(1) + 'px,' + p2y.toFixed(1) + 'px)', opacity: 1, offset: 0.7 },
        { transform: 'translate(' + p3x.toFixed(1) + 'px,' + p3y.toFixed(1) + 'px)', opacity: 0 }
      ], { duration: dur, delay, easing: 'cubic-bezier(.25,.46,.45,.94)', fill: 'forwards' });
      const spinX = (Math.random() < 0.5 ? -1 : 1) * (720 + Math.random() * 720);
      const spinY = (Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 720);
      const anim2=inner.animate([
        { transform: 'rotateX(90deg)' },
        { transform: 'rotateY(' + spinY + 'deg) rotateX(' + spinX + 'deg) rotateX(90deg)' }
      ], { duration: dur, delay, easing: 'linear', fill: 'forwards' });
      setTimeout(() => { anim1.cancel(); anim2.cancel(); wrap.remove(); }, delay + dur + 150);
    }
    // Reuses the exact same bell-chime instrument as the dice tumble (cloche-dice.js), just an
    // "excited" version of it: faster note cadence and louder, rather than a separate coin-clink
    // sample set. Duration scales with coin count so a bigger win rings a bit longer.
    playCoinChimeShower(Math.min(3200, 900 + n * 35));
  }

  function playCoinChimeShower(durationMs) {
    if (!global.ClocheDice || !global.ClocheDice.playChimeNote) return;
    const start = performance.now();
    (function tick() {
      if (performance.now() - start >= durationMs) return;
      global.ClocheDice.playChimeNote(1.3);
      setTimeout(tick, 30 + Math.random() * 45);
    })();
  }

  // The god-ray cluster is scaled to the actual rendered payout text (not a hardcoded guess) by
  // measuring an offscreen clone with the final amount string -- the visible amount still
  // starts at $0.00 and ticks up, so measuring the live element directly would size the rays
  // far too small. --wm-ray-span is a multiplier on the whole cluster (1 = the reference 440px-
  // wide oval the per-ray reach scales in .wm-winner-ray were tuned against), so wider payout
  // text blooms the rays out further without changing their relative reach per direction.
  function sizeWinnerRays(amount, fmt) {
    if (!amtEl || !raysEl) return;
    const clone = amtEl.cloneNode(false);
    clone.textContent = fmt(amount);
    clone.style.cssText += ';position:absolute;visibility:hidden;left:-9999px;top:-9999px;white-space:nowrap';
    document.body.appendChild(clone);
    const r = clone.getBoundingClientRect();
    clone.remove();
    raysEl.style.setProperty('--wm-ray-span', (Math.max(220, r.width * 1.15) / 440).toFixed(3));
  }

  function defaultFmt(n) {
    return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ---------- public API ----------
  const WinnerModal = {
    // amount<=0 is a no-op -- every host page's existing behavior is to just skip the modal
    // entirely for a zero payout, not show a "$0.00" version of it.
    show(amount, options) {
      if (!overlayEl) buildOverlay();
      if (!(amount > 0)) return;
      options = options || {};
      const fmt = options.fmt || defaultFmt;
      if (winnerTimer) clearTimeout(winnerTimer);
      _winnerAmount = amount; _winnerAnimating = true; _onClose = options.onClose || null;
      overlayEl.classList.toggle('big', !!options.big);
      overlayEl.classList.remove('push');
      overlayEl.classList.remove('hidden');
      titleEl.textContent = options.title || '🎉 Congratulations, you win 🎉';
      amtEl.textContent = '$0.00';
      sizeWinnerRays(amount, fmt);
      spawnCoinWaterfall(options.big ? 56 : 34);
      const start = performance.now();
      function tick(now) {
        if (!_winnerAnimating) return;
        const t = Math.min((now - start) / 2000, 1);
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        amtEl.textContent = fmt(Math.round(e * amount * 100) / 100);
        if (t < 1) requestAnimationFrame(tick);
        // held long enough for the longer coin shower to finish
        else { _winnerAnimating = false; amtEl.textContent = fmt(amount); winnerTimer = setTimeout(() => WinnerModal.close(), 3000); }
      }
      requestAnimationFrame(tick);
    },
    // A push: bets returned, nothing actually won. Calmer sibling of show() -- no coin
    // waterfall, no god rays, silver/platinum text instead of gold, shorter hold. Still
    // ticks the amount up (it's the stake being returned, a real number worth seeing).
    showPush(amount, options) {
      if (!overlayEl) buildOverlay();
      if (!(amount > 0)) return;
      options = options || {};
      const fmt = options.fmt || defaultFmt;
      if (winnerTimer) clearTimeout(winnerTimer);
      _winnerAmount = amount; _winnerAnimating = true; _onClose = options.onClose || null;
      overlayEl.classList.remove('big');
      overlayEl.classList.add('push');
      overlayEl.classList.remove('hidden');
      titleEl.textContent = options.title || 'Push! Bets returned!';
      amtEl.textContent = '$0.00';
      const start = performance.now();
      function tick(now) {
        if (!_winnerAnimating) return;
        const t = Math.min((now - start) / 1200, 1);
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        amtEl.textContent = fmt(Math.round(e * amount * 100) / 100);
        if (t < 1) requestAnimationFrame(tick);
        else { _winnerAnimating = false; amtEl.textContent = fmt(amount); winnerTimer = setTimeout(() => WinnerModal.close(), 2000); }
      }
      requestAnimationFrame(tick);
    },
    close() {
      if (!overlayEl) return;
      overlayEl.classList.add('hidden');
      overlayEl.classList.remove('big', 'push');
      if (winnerTimer) { clearTimeout(winnerTimer); winnerTimer = null; }
      const cb = _onClose; _onClose = null;
      if (cb) cb();
    },
    // Same as close(), but discards the pending onClose callback instead of firing it --
    // for a host page that wants to abandon the whole presentation chain and take over
    // itself (e.g. a Repeat click skipping straight past a multi-modal payout sequence
    // like Super Flush Rush -> main payout), rather than letting one more scripted step
    // run first.
    forceClose() {
      if (!overlayEl) return;
      overlayEl.classList.add('hidden');
      overlayEl.classList.remove('big', 'push');
      if (winnerTimer) { clearTimeout(winnerTimer); winnerTimer = null; }
      _winnerAnimating = false;
      _onClose = null;
    },
    isOpen: () => !!overlayEl && !overlayEl.classList.contains('hidden')
  };

  global.WinnerModal = WinnerModal;
})(window);
