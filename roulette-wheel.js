// roulette-wheel.js — shared 3D physics roulette wheel + ball, same family as cloche-dice.js.
//
// Core design (identical principle to ClocheDice, see references/dice-engine.md): this module
// NEVER decides the outcome. It takes a promise that resolves to the server-decided pocket
// and forces the ball to land there while still looking like a real, unpredictable spin:
//   1. Snapshots the ball/wheel physics state at the moment the true spin begins.
//   2. Silently pre-simulates the spin with a seeded RNG and fixed timestep to learn which
//      physical pocket slot the ball naturally comes to rest over.
//   3. Restores the snapshot, relabels the wheel's number ring (rotates which drawn slot shows
//      which number) so the server's target pocket sits at that natural resting slot, then
//      replays the identical seeded simulation live.
//   4. Verifies at rest that the displayed pocket matches; relabels again if it ever drifts.
//
// Physics model: real velocity/friction/gravity-driven integration (angle, radius, height —
// polar, since the ball's whole world is a bowl) rather than full rigid-body collision meshes
// for 38 separate frets. This is the same fidelity tradeoff cloche-dice.js already makes
// elsewhere (resolveStep hand-kicks velocities every step rather than solving pure unconstrained
// contact physics) — a lightweight deterministic model, not a canned CSS rotation.
//
// Requires (load before it): three.min.js
//
// Usage:
//   RouletteWheel.init({ container: 'wheel-wrap' });
//   let feed, fail;
//   const spinPromise = RouletteWheel.spin(new Promise((res, rej) => { feed = res; fail = rej; }));
//   const data = await fetch(...);          // server roll
//   feed(data.roll.pocket);                 // e.g. '17', '0', '00'
//   const result = await spinPromise;        // { pocket, color, forced: true }

(function (global) {
  'use strict';

  const CFG = {
    container: null,      // element id or DOM node to mount the canvas into
    wheelRadius: 1.6,
    ballRadius: 0.09,
    maxResolveSteps: 2400, // safety cap on the orbit phase only (~20s at 120Hz) -- everything
                           // after dropStart is a fixed step budget, see DESCENT_STEPS/POCKET_STEPS
  };
  const STEP = 1 / 120;

  const WHEEL_ORDER = ['0', 28, 9, 26, 30, 11, 7, 20, 32, 17, 5, 22, 34, 15, 3, 24, 36, 13, 1,
    '00', 27, 10, 25, 29, 12, 8, 19, 31, 18, 6, 21, 33, 16, 4, 23, 35, 14, 2].map(String);
  const N = WHEEL_ORDER.length; // 38
  const SLOT_ANGLE = (Math.PI * 2) / N;
  const RED = new Set(['1','3','5','7','9','12','14','16','18','19','21','23','25','27','30','32','34','36']);
  function colorOf(pocket) { return (pocket === '0' || pocket === '00') ? 'green' : (RED.has(pocket) ? 'red' : 'black'); }

  let THREE_ = null;
  let inited = false;
  let scene, camera, renderer, canvasEl, rafId, lastTime = 0;
  let wheelMesh, wheelCanvas, wheelCtx, wheelTexture, ballMesh, pointerMesh;
  let labelOffset = 0; // which WHEEL_ORDER index is drawn at texture-slot 0 (the relabel knob)

  // ---------- audio (ticks only; reuses site-wide AudioSettings like every other module) ----------
  let audioCtx = null;
  function ensureAudio() {
    if (audioCtx) return audioCtx;
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audioCtx = null; }
    return audioCtx;
  }
  function playTick(strength) {
    const ctx = ensureAudio(); if (!ctx) return;
    const vol = (window.AudioSettings ? AudioSettings.effectiveVolume() : 1) * Math.min(1, 0.3 + strength * 0.5);
    if (vol <= 0) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'square'; osc.frequency.setValueAtTime(1200 + strength * 400, t0);
    gain.gain.setValueAtTime(vol * 0.18, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.045);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + 0.05);
  }

  // ---------- deterministic RNG (identical algorithm to ClocheDice's, kept independent) ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- wheel number-ring texture (the "relabel" surface) ----------
  function buildWheelTexture() {
    const size = 1024;
    wheelCanvas = document.createElement('canvas');
    wheelCanvas.width = size; wheelCanvas.height = size;
    wheelCtx = wheelCanvas.getContext('2d');
    wheelTexture = new THREE_.CanvasTexture(wheelCanvas);
    drawWheelTexture();
  }
  function drawWheelTexture() {
    const ctx = wheelCtx, size = wheelCanvas.width, cx = size / 2, cy = size / 2, r = size / 2 - 4;
    ctx.clearRect(0, 0, size, size);
    for (let slot = 0; slot < N; slot++) {
      const pocket = WHEEL_ORDER[(slot - labelOffset + N * 4) % N];
      const start = slot * SLOT_ANGLE - Math.PI / 2 - SLOT_ANGLE / 2;
      const end = start + SLOT_ANGLE;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, start, end); ctx.closePath();
      const c = colorOf(pocket);
      ctx.fillStyle = c === 'red' ? '#a01818' : c === 'black' ? '#181818' : '#0a6b30';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,215,0,.35)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(start + SLOT_ANGLE / 2);
      ctx.translate(r * 0.82, 0);
      ctx.rotate(Math.PI / 2);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold ' + Math.round(size * 0.032) + 'px system-ui,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(pocket, 0, 0);
      ctx.restore();
    }
    if (wheelTexture) wheelTexture.needsUpdate = true;
  }
  // pocket -> its fixed index in WHEEL_ORDER (physical fret position, never changes)
  function fretIndexOf(pocket) { return WHEEL_ORDER.indexOf(String(pocket)); }
  // given a physical fret index and the wanted texture-slot to draw it at (0-based, at wheelAngle=0
  // that slot faces the fixed pointer), returns the labelOffset needed.
  function offsetForSlot(pocket, drawnSlot) {
    return (drawnSlot - fretIndexOf(pocket) + N * 4) % N;
  }

  // ---------- scene ----------
  function buildScene() {
    THREE_ = global.THREE;
    const container = typeof CFG.container === 'string' ? document.getElementById(CFG.container) : CFG.container;
    const w = container.clientWidth || 200, h = container.clientHeight || 200;

    scene = new THREE_.Scene();
    camera = new THREE_.PerspectiveCamera(35, w / h, 0.1, 100);
    camera.position.set(0, 3.1, 0.01);
    camera.lookAt(0, 0, 0);

    renderer = new THREE_.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    canvasEl = renderer.domElement;
    canvasEl.style.cssText = 'width:100%;height:100%;display:block';
    container.appendChild(canvasEl);

    scene.add(new THREE_.AmbientLight(0xffffff, 0.75));
    const dl = new THREE_.DirectionalLight(0xffffff, 0.8); dl.position.set(1, 3, 1); scene.add(dl);

    buildWheelTexture();
    const wheelGeo = new THREE_.CylinderGeometry(CFG.wheelRadius, CFG.wheelRadius, 0.12, 64);
    const wheelMat = [
      new THREE_.MeshStandardMaterial({ color: 0x2a1a08 }),
      new THREE_.MeshStandardMaterial({ map: wheelTexture }),
      new THREE_.MeshStandardMaterial({ color: 0x1a0f04 }),
    ];
    wheelMesh = new THREE_.Mesh(wheelGeo, wheelMat);
    scene.add(wheelMesh);

    const ballGeo = new THREE_.SphereGeometry(CFG.ballRadius, 20, 20);
    const ballMat = new THREE_.MeshStandardMaterial({ color: 0xf5f5f5, metalness: 0.3, roughness: 0.25 });
    ballMesh = new THREE_.Mesh(ballGeo, ballMat);
    scene.add(ballMesh);

    const ptrGeo = new THREE_.ConeGeometry(0.05, 0.16, 12);
    pointerMesh = new THREE_.Mesh(ptrGeo, new THREE_.MeshStandardMaterial({ color: 0xffd700 }));
    pointerMesh.position.set(0, 0.2, -CFG.wheelRadius - 0.08);
    pointerMesh.rotation.x = Math.PI;
    scene.add(pointerMesh);

    onResize();
    window.addEventListener('resize', onResize);
  }
  function onResize() {
    const container = typeof CFG.container === 'string' ? document.getElementById(CFG.container) : CFG.container;
    if (!container || !renderer) return;
    const w = container.clientWidth || 200, h = container.clientHeight || 200;
    renderer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  function ballWorldPos(angle, radius, height) {
    ballMesh.position.set(Math.sin(angle) * radius, height, Math.cos(angle) * radius);
  }

  // ---------- physics state ----------
  const ORBIT_R = CFG.wheelRadius * 0.92, POCKET_R = CFG.wheelRadius * 0.62;
  const ORBIT_Y = 0.16, POCKET_Y = 0.09;
  let state = null; // live physics state -- {wheelAngle,wheelAngVel,ballAngle,ballAngVel,radius,height,dropStart}

  const DROP_SPEED = 3.2;      // rad/s (relative) below which the ball can no longer hold the outer track
  const DESCENT_STEPS = 120;   // ~1s spiral fall to the pocket ring
  const POCKET_STEPS = 260;    // ~2.2s among the frets before the ball is snapped to rest
  const POCKET_FRICTION = 0.965; // per-step decay (of velocity RELATIVE to the wheel) once among the frets
  const ORBIT_FRICTION = 0.99;
  const WHEEL_FRICTION = 0.9994; // deliberately much slower than POCKET_FRICTION -- a real wheel keeps
                                  // coasting long after a ball has settled into its pocket

  // One function drives both the silent pre-simulation and the live replay -- all randomness
  // comes from ctx.rng and all timing from ctx.step, so the two runs are bit-identical. Total
  // duration is a FIXED step count (dropStart is itself deterministic, since no randomness is
  // drawn before it): don't gate completion on an asymptotic speed threshold. An earlier version
  // tried "done when |ballAngVel-wheelAngVel| < settleEps", decaying that gap toward the CURRENT
  // wheel speed each step -- but because the wheel is itself still slowly decelerating, the gap
  // chases a moving target and asymptotes to a small nonzero equilibrium (~wheel's own per-step
  // deceleration, amplified by 1/(1-POCKET_FRICTION)) rather than truly reaching zero, so on some
  // seeds it could take a very long, unpredictable tail to clear the threshold (confirmed by
  // isolated simulation: one seed needed ~40s of pocket-phase steps before crossing 0.03 rad/s).
  // A fixed pocket-phase budget that snaps the ball onto the wheel's velocity at the end sidesteps
  // that tail entirely and keeps every spin's total duration identical and predictable.
  function makeResolveCtx(rng) { return { rng, step: 0, done: false, lastTickSlot: null }; }

  function resolveStep(ctx) {
    const s = state, rng = ctx.rng;
    s.wheelAngle += s.wheelAngVel * STEP;
    s.wheelAngVel *= WHEEL_FRICTION;

    const relSpeed = Math.abs(s.ballAngVel - s.wheelAngVel);

    if (s.dropStart === null && relSpeed < DROP_SPEED) s.dropStart = ctx.step;

    if (s.dropStart === null) {
      // outer-track orbit: fast, low friction, ball comfortably holds the rim
      s.ballAngle += s.ballAngVel * STEP;
      s.ballAngVel *= ORBIT_FRICTION;
      s.radius = ORBIT_R; s.height = ORBIT_Y;
    } else {
      const dstep = ctx.step - s.dropStart;
      if (dstep < DESCENT_STEPS) {
        // spiral fall toward the pocket ring, with a little seeded turbulence so it never
        // looks like a mechanical lerp
        const f = dstep / DESCENT_STEPS;
        s.radius = ORBIT_R + (POCKET_R - ORBIT_R) * (f * f * (3 - 2 * f)); // smoothstep
        s.height = ORBIT_Y + (POCKET_Y - ORBIT_Y) * f;
        s.ballAngle += s.ballAngVel * STEP;
        s.ballAngVel *= ORBIT_FRICTION;
        s.ballAngVel += (rng() - 0.5) * 0.25 * STEP * 60;
      } else {
        // among the frets: fixed-duration budget (see comment above makeResolveCtx). Decay the
        // ball's velocity RELATIVE to the wheel, not its absolute velocity -- a settled ball
        // travels along with the still-spinning wheel, it doesn't stop in the world frame.
        s.radius = POCKET_R; s.height = POCKET_Y;
        s.ballAngle += s.ballAngVel * STEP;
        const pstep = dstep - DESCENT_STEPS;
        if (pstep >= POCKET_STEPS) {
          s.ballAngVel = s.wheelAngVel; // rigidly locked to the wheel now -- spin is over
          ctx.done = true;
        } else {
          s.ballAngVel = s.wheelAngVel + (s.ballAngVel - s.wheelAngVel) * POCKET_FRICTION;
          // Bounce kicks off the fret separators phase out over the first ~60% of the pocket
          // budget so the last stretch is a clean, predictable glide down to the snap above.
          const kickEnvelope = Math.max(0, 1 - pstep / (POCKET_STEPS * 0.6));
          const slotNow = Math.floor((((s.ballAngle - s.wheelAngle) % (Math.PI * 2)) + Math.PI * 2 * 4) / SLOT_ANGLE) % N;
          if (slotNow !== ctx.lastTickSlot) {
            ctx.lastTickSlot = slotNow;
            if (kickEnvelope > 0 && Math.abs(s.ballAngVel - s.wheelAngVel) > 0.4) {
              s.ballAngVel += (rng() - 0.5) * Math.min(1.4, Math.abs(s.ballAngVel - s.wheelAngVel) * 0.6) * kickEnvelope;
            }
            if (ctx.onTick) ctx.onTick(Math.min(1, Math.abs(s.ballAngVel - s.wheelAngVel) / 3));
          }
        }
      }
    }

    ctx.step++;
  }

  function restingSlot() {
    const rel = ((state.ballAngle - state.wheelAngle) % (Math.PI * 2) + Math.PI * 2 * 4) % (Math.PI * 2);
    return Math.floor(rel / SLOT_ANGLE) % N;
  }

  // Runs one full resolve from `baseline` (the real angles/speeds live at the moment the
  // server value arrived) through to rest, using ctx.rng for every random draw. Presimulate
  // and the live replay both call this with an identical baseline + seed, so their rng
  // consumption sequences -- and therefore their tick timing and final resting slot -- are
  // bit-identical. (An earlier version reset presimulate to a 0,0 baseline and shifted the
  // result afterward; that let tick timing diverge from the live run's real-baseline angles,
  // since a fret-crossing is a function of absolute relative angle, not just elapsed time.)
  function presimulate(seed, baseline) {
    state = { wheelAngle: baseline.wheelAngle, ballAngle: baseline.ballAngle,
      wheelAngVel: baseline.wheelAngVel, ballAngVel: baseline.ballAngVel,
      radius: ORBIT_R, height: ORBIT_Y, dropStart: null };
    const ctx = makeResolveCtx(mulberry32(seed));
    while (!ctx.done && ctx.step < CFG.maxResolveSteps) resolveStep(ctx);
    if (!ctx.done) return null;
    return restingSlot();
  }

  // ---------- orchestration ----------
  let phase = 'idle'; // idle | preroll | resolving | reveal
  let activeResolve = null, activeReject = null, serverPocket = null;
  let livCtx = null, prerollAngle = 0, prerollWheelAngle = 0;
  const PREROLL_BALL_SPEED = -9.5, PREROLL_WHEEL_SPEED = 4.2;

  function beginResolve() {
    const baseline = { wheelAngle: prerollWheelAngle, ballAngle: prerollAngle,
      wheelAngVel: PREROLL_WHEEL_SPEED, ballAngVel: PREROLL_BALL_SPEED };
    const baseSeed = (Math.random() * 0xFFFFFFFF) >>> 0;
    let chosenSeed = null, slot = null;
    for (let attempt = 0; attempt < 24; attempt++) {
      const seed = (baseSeed + attempt * 7919) >>> 0;
      const finalSlot = presimulate(seed, baseline);
      if (finalSlot !== null) { chosenSeed = seed; slot = finalSlot; break; }
    }
    if (chosenSeed === null) { chosenSeed = baseSeed; slot = 0; } // pathological fallback, practically unreachable

    // Reset to the exact same baseline for the live replay the player actually watches.
    state = { wheelAngle: baseline.wheelAngle, ballAngle: baseline.ballAngle,
      wheelAngVel: baseline.wheelAngVel, ballAngVel: baseline.ballAngVel,
      radius: ORBIT_R, height: ORBIT_Y, dropStart: null };

    labelOffset = offsetForSlot(serverPocket, slot);
    drawWheelTexture();

    livCtx = makeResolveCtx(mulberry32(chosenSeed));
    livCtx.onTick = (strength) => playTick(strength);
    phase = 'resolving';
  }

  function finishResolve() {
    const finalSlot = restingSlot();
    const displayedPocket = WHEEL_ORDER[(finalSlot - labelOffset + N * 4) % N];
    if (displayedPocket !== serverPocket) {
      // live replay drifted from the pre-sim by a step or two -- repair by relabeling again,
      // exactly like ClocheDice.finishResolve()'s verify-and-repair step.
      labelOffset = offsetForSlot(serverPocket, finalSlot);
      drawWheelTexture();
    }
    const payload = { pocket: serverPocket, color: colorOf(serverPocket), forced: true };
    phase = 'reveal';
    setTimeout(() => {
      phase = 'idle';
      const done = activeResolve; activeResolve = null; activeReject = null; serverPocket = null;
      if (done) done(payload);
    }, 350);
  }

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    const dt = Math.min((now - lastTime) / 1000, 1 / 20);
    lastTime = now;
    if (!inited) return;

    if (phase === 'preroll') {
      prerollWheelAngle += PREROLL_WHEEL_SPEED * dt;
      prerollAngle += PREROLL_BALL_SPEED * dt;
      wheelMesh.rotation.y = prerollWheelAngle;
      ballWorldPos(prerollAngle, ORBIT_R, ORBIT_Y);
    } else if (phase === 'resolving') {
      const debt = Math.min(dt / STEP, 6);
      for (let i = 0; i < debt; i++) {
        resolveStep(livCtx);
        if (livCtx.done) { finishResolve(); break; }
      }
      wheelMesh.rotation.y = state.wheelAngle;
      ballWorldPos(state.ballAngle, state.radius, state.height);
    }
    renderer.render(scene, camera);
  }

  const RouletteWheel = {
    init(options = {}) {
      if (inited) return;
      Object.assign(CFG, options);
      buildScene();
      inited = true;
      lastTime = performance.now();
      rafId = requestAnimationFrame(loop);
    },
    // pocketOrPromise: '17' / '0' / '00' (string or number) or a Promise resolving to one
    spin(pocketOrPromise) {
      if (!inited) return Promise.reject(new Error('RouletteWheel.init() first'));
      if (phase !== 'idle') return Promise.reject(new Error('spin in progress'));
      return new Promise((resolve, reject) => {
        activeResolve = resolve; activeReject = reject; serverPocket = null;
        phase = 'preroll';
        Promise.resolve(pocketOrPromise).then(p => {
          const pocket = String(p);
          if (WHEEL_ORDER.indexOf(pocket) === -1) throw new Error('unknown pocket: ' + p);
          serverPocket = pocket;
          beginResolve();
        }).catch(err => {
          phase = 'idle';
          const rej = activeReject; activeResolve = null; activeReject = null;
          if (rej) rej(err);
        });
      });
    },
    isSpinning: () => phase !== 'idle',
    WHEEL_ORDER,
    colorOf,
  };

  global.RouletteWheel = RouletteWheel;
})(window);
