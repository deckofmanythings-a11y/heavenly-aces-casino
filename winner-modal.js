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

  let overlayEl, amtEl, raysEl, coinsEl, bigtagEl;
  let winnerTimer = null, _winnerAmount = 0, _winnerAnimating = false, _onClose = null;

  // ---------- DOM ----------
  function buildOverlay() {
    const style = document.createElement('style');
    style.textContent = [
      '#wm-modal-winner{position:fixed;inset:0;z-index:200;display:flex;align-items:flex-start;justify-content:center;padding-top:8vh}',
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
      '.wm-winner-rays{',
      '  position:absolute;top:50%;left:50%;width:440px;height:180px;z-index:1;',
      '  transform:translate(-50%,-50%);border-radius:50%;overflow:hidden;pointer-events:none;',
      '  animation:wmGodRayOpacityPulse 4.5s ease-in-out infinite,wmGodRayOvalBreathe 6.5s ease-in-out infinite;',
      '}',
      '.wm-winner-rays-spin{',
      '  position:absolute;top:50%;left:50%;width:640px;height:640px;',
      '  transform:translate(-50%,-50%);pointer-events:none;',
      '  background:repeating-conic-gradient(from 0deg,rgba(255,224,130,.78) 0deg 34deg,rgba(255,224,130,0) 34deg 60deg);',
      '  animation:wmGodRaySpinPulse 18s ease-in-out infinite;',
      '}',
      '.wm-winner-coins{position:absolute;top:50%;left:50%;width:0;height:0;z-index:1;pointer-events:none;}',
      '@keyframes wmGodRaySpinPulse{',
      '  0%{transform:translate(-50%,-50%) rotate(0deg) scale(1)}',
      '  50%{transform:translate(-50%,-50%) rotate(180deg) scale(1.22)}',
      '  100%{transform:translate(-50%,-50%) rotate(360deg) scale(1)}',
      '}',
      '@keyframes wmGodRayOpacityPulse{0%,100%{opacity:.55}50%{opacity:1}}',
      '@keyframes wmGodRayOvalBreathe{',
      '  0%{transform:translate(-50%,-50%) scale(1)}',
      '  18%{transform:translate(-50%,-50%) scale(1.14)}',
      '  34%{transform:translate(-50%,-50%) scale(0.92)}',
      '  55%{transform:translate(-50%,-50%) scale(1.22)}',
      '  71%{transform:translate(-50%,-50%) scale(0.96)}',
      '  88%{transform:translate(-50%,-50%) scale(1.08)}',
      '  100%{transform:translate(-50%,-50%) scale(1)}',
      '}',
      '.wm-winner-tap{position:relative;z-index:2;font-size:18px;color:rgba(255,255,255,.75);margin-top:14px;letter-spacing:.05em;text-shadow:0 1px 3px rgba(0,0,0,.6)}',
      '#wm-modal-winner.big .wm-winner-box{animation:wmWinnerPop .35s cubic-bezier(.34,1.56,.64,1),wmBigWinPulse 1.1s ease-in-out infinite .35s}',
      '@keyframes wmBigWinPulse{0%,100%{filter:brightness(1)}50%{filter:brightness(1.25)}}',
      '#wm-modal-winner.big .wm-winner-title{font-size:48px}',
      '#wm-modal-winner.big .wm-winner-amount{font-size:160px}',
      '.wm-winner-bigtag{display:none;position:relative;z-index:2;font-size:24px;font-weight:900;letter-spacing:.15em;color:#ffe680;text-shadow:0 2px 6px rgba(0,0,0,.7);margin-bottom:2px}',
      '#wm-modal-winner.big .wm-winner-bigtag{display:block}',
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
          '<div class="wm-winner-rays"><div class="wm-winner-rays-spin"></div></div>' +
          '<div class="wm-winner-coins"></div>' +
          '<div class="wm-winner-amount">$0.00</div>' +
        '</div>' +
        '<div class="wm-winner-tap">tap to dismiss</div>' +
      '</div>';
    document.body.appendChild(overlayEl);
    amtEl = overlayEl.querySelector('.wm-winner-amount');
    raysEl = overlayEl.querySelector('.wm-winner-rays');
    coinsEl = overlayEl.querySelector('.wm-winner-coins');
    bigtagEl = overlayEl.querySelector('.wm-winner-bigtag');
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
      wrap.animate([
        { transform: 'translate(0px,0px)', opacity: 0 },
        { transform: 'translate(' + p1x.toFixed(1) + 'px,' + p1y.toFixed(1) + 'px)', opacity: 1, offset: 0.12 },
        { transform: 'translate(' + p2x.toFixed(1) + 'px,' + p2y.toFixed(1) + 'px)', opacity: 1, offset: 0.7 },
        { transform: 'translate(' + p3x.toFixed(1) + 'px,' + p3y.toFixed(1) + 'px)', opacity: 0 }
      ], { duration: dur, delay, easing: 'cubic-bezier(.25,.46,.45,.94)', fill: 'forwards' });
      const spinX = (Math.random() < 0.5 ? -1 : 1) * (720 + Math.random() * 720);
      const spinY = (Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 720);
      inner.animate([
        { transform: 'rotateX(90deg)' },
        { transform: 'rotateY(' + spinY + 'deg) rotateX(' + spinX + 'deg) rotateX(90deg)' }
      ], { duration: dur, delay, easing: 'linear', fill: 'forwards' });
      setTimeout(() => wrap.remove(), delay + dur + 150);
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

  // The god-ray oval is sized to the actual rendered payout text (not a hardcoded guess) by
  // measuring an offscreen clone with the final amount string -- the visible amount still
  // starts at $0.00 and ticks up, so measuring the live element directly would size the oval
  // far too small. Padded a bit larger than the raw text box so the rays bloom out around the
  // digits rather than hugging them tightly.
  function sizeWinnerRays(amount, fmt) {
    if (!amtEl || !raysEl) return;
    const clone = amtEl.cloneNode(false);
    clone.textContent = fmt(amount);
    clone.style.cssText += ';position:absolute;visibility:hidden;left:-9999px;top:-9999px;white-space:nowrap';
    document.body.appendChild(clone);
    const r = clone.getBoundingClientRect();
    clone.remove();
    raysEl.style.width = Math.max(220, r.width * 1.15) + 'px';
    raysEl.style.height = Math.max(120, r.height * 1.55) + 'px';
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
      overlayEl.classList.remove('hidden'); overlayEl.onclick = () => WinnerModal._tap(fmt);
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
    // exposed so a host page's own onclick wiring (if it needs the current fmt) can call it;
    // show() above already wires overlayEl.onclick to this automatically.
    _tap(fmt) {
      if (winnerTimer) clearTimeout(winnerTimer);
      if (_winnerAnimating) { _winnerAnimating = false; amtEl.textContent = (fmt || defaultFmt)(_winnerAmount); winnerTimer = setTimeout(() => WinnerModal.close(), 200); }
      else WinnerModal.close();
    },
    close() {
      if (!overlayEl) return;
      overlayEl.classList.add('hidden');
      overlayEl.classList.remove('big');
      overlayEl.onclick = null;
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
      overlayEl.classList.remove('big');
      overlayEl.onclick = null;
      if (winnerTimer) { clearTimeout(winnerTimer); winnerTimer = null; }
      _winnerAnimating = false;
      _onClose = null;
    },
    isOpen: () => !!overlayEl && !overlayEl.classList.contains('hidden')
  };

  global.WinnerModal = WinnerModal;
})(window);
