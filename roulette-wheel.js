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
    const size = 1536; // higher-res than the old 1024 -- the wheel now renders meaningfully
                        // larger on screen (see #wheel-wrap in roulette.html), so the texture
                        // needs more source pixels per label to stay crisp instead of blurry.
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
      ctx.strokeStyle = 'rgba(255,215,0,.25)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(start + SLOT_ANGLE / 2);
      ctx.translate(r * 0.8, 0);
      ctx.rotate(Math.PI / 2);
      // Bold outline behind the fill so white text stays legible against both the dark
      // slots and the (similarly light) gold slot-boundary lines at small render sizes.
      const fontPx = Math.round(size * (pocket.length > 1 ? 0.058 : 0.072));
      ctx.font = 'bold ' + fontPx + 'px system-ui,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round'; ctx.miterLimit = 2;
      ctx.strokeStyle = 'rgba(0,0,0,.9)'; ctx.lineWidth = fontPx * 0.22;
      ctx.strokeText(pocket, 0, 0);
      ctx.fillStyle = '#fff';
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
    // Orthographic camera, sized to the wheel's actual radius (see fitCameraFrustum) rather than
    // a perspective camera at a hand-picked distance/FOV -- a perspective camera close enough to
    // read the wheel's small on-screen size cropped the view into a square window that only
    // showed the hub, with the whole numbered rim (and the wheel's roundness) entirely outside
    // the frame. Orthographic + exact-fit framing sidesteps that class of bug.
    // Tilted rather than pure top-down (was position (0,10,0.01)) -- a straight-down view looks
    // along the Y axis, so vertical bounce/height motion is geometrically invisible no matter how
    // large it is (this bit a bounce feature before the tilt existed). The 8:6 ratio gives a clean
    // 36.87 degrees off vertical (cos = 0.8), which fitCameraFrustum compensates for explicitly.
    camera = new THREE_.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    camera.position.set(0, 8, 6);
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
    // wheelMesh is a Group so both pieces spin together via wheelMesh.rotation.y each frame.
    // The numbered face is a flat CircleGeometry rather than a CylinderGeometry top cap --
    // a cylinder cap's UV layout doesn't match the simple "circle inscribed in a square"
    // mapping the canvas texture is drawn with (confirmed: it rendered as a radial sunburst,
    // the classic symptom of a texture being read with the wrong UV parameterization).
    // CircleGeometry's UV mapping is the standard, well-defined one that actually matches.
    wheelMesh = new THREE_.Group();
    const rimGeo = new THREE_.CylinderGeometry(CFG.wheelRadius, CFG.wheelRadius, 0.12, 64);
    const rimMesh = new THREE_.Mesh(rimGeo, new THREE_.MeshStandardMaterial({ color: 0x2a1a08 }));
    wheelMesh.add(rimMesh);
    const faceGeo = new THREE_.CircleGeometry(CFG.wheelRadius, 64);
    const faceMesh = new THREE_.Mesh(faceGeo, new THREE_.MeshStandardMaterial({ map: wheelTexture }));
    faceMesh.rotation.x = -Math.PI / 2; // lie flat, facing up toward the top-down camera
    faceMesh.position.y = 0.061; // just above the rim's top surface (rim height 0.12) to avoid z-fighting
    wheelMesh.add(faceMesh);
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
  // Fits the orthographic frustum to the wheel's actual radius plus the pointer mesh poking out
  // above it, with a small margin -- recomputed on resize so a non-square container (or one
  // resized after init) never re-introduces the cropping bug the perspective camera had.
  //
  // The camera is tilted (see buildScene), so the flat disc projects as an ELLIPSE, not a
  // circle: screen-horizontal (world X) shows the full radius, but screen-vertical is
  // foreshortened by cos(tilt) since that axis is the tilted view of the disc's other diameter.
  // TILT_COS must match the camera position's actual tilt ratio (8,6 -> adjacent/hypotenuse =
  // 8/10 = 0.8) -- this is exact geometry, not a fudge factor, so it has to stay in lockstep if
  // the camera position above ever changes.
  const TILT_COS = 0.8;
  function fitCameraFrustum(w, h) {
    const extentX = CFG.wheelRadius * 1.15;
    const extentY = extentX / TILT_COS; // compensate for the tilt-foreshortened vertical axis
    const aspect = w / h;
    // #wheel-wrap is CSS-enforced square (aspect-ratio:1 in roulette.html) so aspect===1 is the
    // only case that actually runs in this app; both branches stay generous (extentY, the larger
    // of the two, wins the shared axis) rather than tightly fitting extentX, trading a bit of
    // unused horizontal margin for zero risk of re-cropping if the container ratio ever changes.
    if (aspect >= 1) { camera.top = extentY; camera.bottom = -extentY; camera.left = -extentY * aspect; camera.right = extentY * aspect; }
    else { camera.left = -extentY; camera.right = extentY; camera.top = extentY / aspect; camera.bottom = -extentY / aspect; }
    camera.updateProjectionMatrix();
  }
  function onResize() {
    const container = typeof CFG.container === 'string' ? document.getElementById(CFG.container) : CFG.container;
    if (!container || !renderer) return;
    const w = container.clientWidth || 200, h = container.clientHeight || 200;
    renderer.setSize(w, h);
    fitCameraFrustum(w, h);
  }
  function ballWorldPos(angle, radius, height, bounceVisual) {
    ballMesh.position.set(Math.sin(angle) * radius, height, Math.cos(angle) * radius);
    // Squash/stretch scale pulse standing in for the height bounce the top-down camera can't
    // show (see the comment above BOUNCE_HEIGHT) -- bigger when "up" reads as a hop even
    // though there's no actual vertical parallax to see it with.
    const scale = 1 + (bounceVisual || 0) * 0.8;
    ballMesh.scale.setScalar(scale);
  }

  // ---------- physics state ----------
  // POCKET_R must sit OUTSIDE the label radius (r*0.8 in drawWheelTexture, i.e. ~0.8*wheelRadius
  // in world units) so the ball settles past the numbers toward the rim, matching a real wheel
  // (the pocket ring is the outermost moving part -- the ball never rests hub-side of the digits).
  const ORBIT_R = CFG.wheelRadius * 0.92, POCKET_R = CFG.wheelRadius * 0.87;
  const ORBIT_Y = 0.16, POCKET_Y = 0.09;
  let state = null; // live physics state -- {wheelAngle,ballAngle,ballAngVel,radius,height,dropStart,bounceVisual}

  const DROP_SPEED = 3.2;      // rad/s (relative) below which the ball can no longer hold the outer track
  const DESCENT_STEPS = 120;   // ~1s spiral fall to the pocket ring
  const POCKET_STEPS = 260;    // ~2.2s among the frets before the ball is snapped to rest
  const POCKET_FRICTION = 0.965; // per-step decay (of velocity RELATIVE to the wheel) once among the frets
  const ORBIT_FRICTION = 0.996;
  // The wheel never stops or resets between spins -- like a real casino table, it just cruises
  // at one constant, readable speed forever (continuous across idle/preroll/resolving/reveal,
  // see idleWheelAngle below and loop()). No more per-spin wheel friction/decay: the wheel's
  // speed is simply this constant everywhere it's used. ~1 revolution every 3.9s.
  const WHEEL_SPEED = 1.6;

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
  function makeResolveCtx(rng) { return { rng, step: 0, done: false, lastTickSlot: null, bounce: 0 }; }

  // World-unit scale of the visible bounce. The camera is now tilted (see buildScene) so height
  // motion IS visible, but BOUNCE_RADIUS still carries most of the read since it's the axis
  // closer to the camera's view direction; the scale pulse (ballMesh.scale, driven by
  // state.bounceVisual, set below) adds extra punch on top of the real height parallax.
  const BOUNCE_HEIGHT = 0.09, BOUNCE_RADIUS = 0.15;
  // Safety clamp: ORBIT_R (0.92x wheelRadius) leaves only ~8% headroom before the ball would
  // render past the wheel's own edge -- worth an explicit ceiling (computed live off
  // CFG.wheelRadius, not cached, in case init() is ever called with a non-default radius)
  // rather than trusting BOUNCE_RADIUS tuning alone to never combine with peak envelope/rng
  // values badly.
  function maxBallRadius() { return CFG.wheelRadius * 0.97; }
  // Per-step multiplicative decay of an active bounce impulse between fret hits -- high enough
  // that each hit reads as a distinct hop rather than a smear, but the ball still visibly settles
  // (not a dead stop) between hits.
  const BOUNCE_DECAY = 0.82;

  function resolveStep(ctx) {
    const s = state, rng = ctx.rng;
    s.wheelAngle += WHEEL_SPEED * STEP;

    const relSpeed = Math.abs(s.ballAngVel - WHEEL_SPEED);

    if (s.dropStart === null && relSpeed < DROP_SPEED) s.dropStart = ctx.step;

    if (s.dropStart === null) {
      // outer-track orbit: fast, low friction, ball comfortably holds the rim
      s.ballAngle += s.ballAngVel * STEP;
      s.ballAngVel *= ORBIT_FRICTION;
      s.radius = ORBIT_R; s.height = ORBIT_Y; s.bounceVisual = 0;
    } else {
      const dstep = ctx.step - s.dropStart;
      if (dstep < DESCENT_STEPS) {
        // Spiral fall toward the pocket ring, with a little seeded turbulence so it never
        // looks like a mechanical lerp, PLUS a few decaying hops off the outer wall layered on
        // top of the smooth fall -- a real ball clatters against the bowl track several times
        // before it commits to dropping, it doesn't glide down in one smooth arc.
        const f = dstep / DESCENT_STEPS;
        const fallRadius = ORBIT_R + (POCKET_R - ORBIT_R) * (f * f * (3 - 2 * f)); // smoothstep
        const fallHeight = ORBIT_Y + (POCKET_Y - ORBIT_Y) * f;
        // 3 hops of decreasing height: sin^2 gives clean zero-crossings between hops (no dip
        // below the fall path), (1-f) fades the whole pattern out exactly by pocket entry.
        const hop = Math.pow(Math.sin(f * Math.PI * 3), 2) * (1 - f);
        s.radius = Math.min(fallRadius + hop * BOUNCE_RADIUS, maxBallRadius());
        s.height = fallHeight + hop * BOUNCE_HEIGHT;
        s.bounceVisual = hop;
        s.ballAngle += s.ballAngVel * STEP;
        s.ballAngVel *= ORBIT_FRICTION;
        s.ballAngVel += (rng() - 0.5) * 0.25 * STEP * 60;
      } else {
        // among the frets: fixed-duration budget (see comment above makeResolveCtx). Decay the
        // ball's velocity RELATIVE to the wheel, not its absolute velocity -- a settled ball
        // travels along with the still-spinning wheel, it doesn't stop in the world frame.
        s.ballAngle += s.ballAngVel * STEP;
        const pstep = dstep - DESCENT_STEPS;
        if (pstep >= POCKET_STEPS) {
          s.ballAngVel = WHEEL_SPEED; // rigidly locked to the wheel now -- spin is over
          s.radius = POCKET_R; s.height = POCKET_Y; s.bounceVisual = 0; ctx.bounce = 0;
          ctx.done = true;
        } else {
          s.ballAngVel = WHEEL_SPEED + (s.ballAngVel - WHEEL_SPEED) * POCKET_FRICTION;
          // Bounce kicks off the fret separators phase out over the first ~60% of the pocket
          // budget so the last stretch is a clean, predictable glide down to the snap above.
          const kickEnvelope = Math.max(0, 1 - pstep / (POCKET_STEPS * 0.6));
          const slotNow = Math.floor((((s.ballAngle - s.wheelAngle) % (Math.PI * 2)) + Math.PI * 2 * 4) / SLOT_ANGLE) % N;
          if (slotNow !== ctx.lastTickSlot) {
            ctx.lastTickSlot = slotNow;
            if (kickEnvelope > 0 && Math.abs(s.ballAngVel - WHEEL_SPEED) > 0.4) {
              s.ballAngVel += (rng() - 0.5) * Math.min(1.4, Math.abs(s.ballAngVel - WHEEL_SPEED) * 0.6) * kickEnvelope;
              // Each fret hit pops the ball up and slightly outward, decaying between hits --
              // this is the actual "bounciness": without it the ball just glides to a stop.
              ctx.bounce = Math.max(ctx.bounce, kickEnvelope * (0.5 + rng() * 0.5));
            }
            if (ctx.onTick) ctx.onTick(Math.min(1, Math.abs(s.ballAngVel - WHEEL_SPEED) / 3));
          }
          ctx.bounce *= BOUNCE_DECAY;
          s.radius = Math.min(POCKET_R + ctx.bounce * BOUNCE_RADIUS, maxBallRadius());
          s.height = POCKET_Y + ctx.bounce * BOUNCE_HEIGHT;
          s.bounceVisual = ctx.bounce;
        }
      }
    }

    ctx.step++;
  }

  // Which drawn slot (see drawWheelTexture's `slot` loop variable) the ball is actually
  // sitting over in WORLD space, given the current ballAngle/wheelAngle. This is NOT simply
  // floor((ballAngle-wheelAngle)/SLOT_ANGLE) -- that was the original (wrong) assumption,
  // carried over unverified from the old flat-2D canvas wheel. The real rendering pipeline
  // (a canvas angle baked into a CircleGeometry's UVs, flattened via faceMesh.rotation.x=-π/2,
  // then spun via wheelMesh.rotation.y) produces a REFLECTED and phase-shifted relationship
  // instead, verified by walking THREE's actual CircleGeometry UV attribute values and its
  // real rotation matrices (not assumed from memory): a label drawn at canvas angle θ ends up,
  // after those two rotations, at world (x,z) = R*(sin(θ-β), -cos(θ-β)) where β=wheelAngle --
  // solving that against ballWorldPos's (sin(A), cos(A)) convention gives slot i's ball-angle
  // as A_i = π + β - i*SLOT_ANGLE, i.e. slot index = (π + wheelAngle - ballAngle) / SLOT_ANGLE,
  // not (ballAngle - wheelAngle) / SLOT_ANGLE.
  function restingSlot() {
    const rel = ((Math.PI + state.wheelAngle - state.ballAngle) % (Math.PI * 2) + Math.PI * 2 * 4) % (Math.PI * 2);
    // Slot i's label sits at rel === i*SLOT_ANGLE exactly (its center); the valid window for
    // slot i is symmetric around that center (+/- half a slot), which means the nearest integer
    // to rel/SLOT_ANGLE, not its floor. floor()'s valid window is [i, i+1) -- shifted a half-slot
    // off from the true center-aligned window -- so it was right roughly half the time and off
    // by exactly one slot the other half, depending purely on where in the slot the ball landed.
    return Math.round(rel / SLOT_ANGLE) % N;
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
      ballAngVel: baseline.ballAngVel,
      radius: ORBIT_R, height: ORBIT_Y, dropStart: null };
    const ctx = makeResolveCtx(mulberry32(seed));
    while (!ctx.done && ctx.step < CFG.maxResolveSteps) resolveStep(ctx);
    if (!ctx.done) return null;
    return restingSlot();
  }

  // ---------- orchestration ----------
  let phase = 'idle'; // idle | preroll | resolving | reveal
  let activeResolve = null, activeReject = null, serverPocket = null;
  let livCtx = null, prerollAngle = 0;
  const PREROLL_BALL_SPEED = -9.5;
  // The wheel's persistent rotation -- advances forever via the same fixed-step clock as the
  // ball's own physics, continuous across every phase (idle/preroll/resolving/reveal). Never
  // reset per spin: a real casino wheel is never stopped between rounds, it just keeps cruising
  // at WHEEL_SPEED. restBallOffset is the settled ball's angle relative to the wheel, so it can
  // keep riding along in its pocket (rather than floating motionless) while the wheel turns
  // under it between spins.
  let idleWheelAngle = 0, restBallOffset = 0;

  // The relabel (rewriting which number is drawn at which slot) must never happen at a moment
  // a player could tie to "the server just told the wheel what to do" -- doing it at the exact
  // instant beginResolve() runs (right as the network response lands) would be a visible tell:
  // the numbers would visibly jump on the wheel face at a moment correlated with a real event
  // the player can perceive (their spin committing). Instead the offset is computed immediately
  // (cheap, silent, touches no pixels) but the actual texture redraw is deferred to a RANDOM
  // step well inside the fast outer-track orbit phase -- comfortably before DROP_SPEED is ever
  // reached (dropStart lands around step ~445 given ORBIT_FRICTION/WHEEL_SPEED; see resolveStep),
  // while the wheel and ball are both still spinning fast with no player-visible event anywhere
  // near it to anchor the moment to. Unlike the dice (which hide a face relabel inside chaotic 3D
  // tumbling), the wheel only rotates on one predictable axis, so timing is the only available
  // cover here -- pick an unpredictable moment, not a chaotic orientation.
  const RELABEL_STEP_MIN = 90, RELABEL_STEP_MAX = 380;
  let relabelStep = 0, relabeled = false;

  function beginResolve() {
    // The wheel's baseline is wherever its persistent, never-reset rotation currently is -- the
    // ball gets a fresh fast throw each spin, but the wheel itself was already turning before
    // this spin started and keeps going exactly as it was.
    const baseline = { wheelAngle: idleWheelAngle, ballAngle: prerollAngle, ballAngVel: PREROLL_BALL_SPEED };
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
      ballAngVel: baseline.ballAngVel,
      radius: ORBIT_R, height: ORBIT_Y, dropStart: null };

    // Decide the offset now (silent, no rendering) but don't draw it yet -- see the comment
    // above relabelStep for why the draw itself is deferred to a random later moment.
    labelOffset = offsetForSlot(serverPocket, slot);
    relabelStep = RELABEL_STEP_MIN + Math.floor(Math.random() * (RELABEL_STEP_MAX - RELABEL_STEP_MIN));
    relabeled = false;

    livCtx = makeResolveCtx(mulberry32(chosenSeed));
    livCtx.onTick = (strength) => playTick(strength);
    phase = 'resolving';
  }

  function finishResolve() {
    const finalSlot = restingSlot();
    const displayedPocket = WHEEL_ORDER[(finalSlot - labelOffset + N * 4) % N];
    if (!relabeled || displayedPocket !== serverPocket) {
      // Either the deferred relabel above somehow never fired (shouldn't happen --
      // RELABEL_STEP_MAX is always well before this point) or the live replay drifted from
      // the pre-sim by a step or two; repair by relabeling now, exactly like
      // ClocheDice.finishResolve()'s verify-and-repair step. This late relabel IS visible if
      // it ever triggers, but the deterministic replay (identical seed/baseline/step count for
      // both presimulate and the live run) means it provably never should.
      labelOffset = offsetForSlot(serverPocket, finalSlot);
      drawWheelTexture();
    }
    // Hand off the wheel's rotation to the persistent idle tracker exactly where the resolve
    // left it -- and remember the ball's settled offset from it -- so the wheel keeps turning
    // seamlessly (no jump) and the ball visibly rides along in its pocket until the next spin
    // picks it back up, instead of floating motionless while the wheel turns under it.
    idleWheelAngle = state.wheelAngle;
    restBallOffset = state.ballAngle - state.wheelAngle;

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

    if (phase === 'resolving') {
      const debt = Math.min(dt / STEP, 6);
      for (let i = 0; i < debt; i++) {
        resolveStep(livCtx);
        if (!relabeled && livCtx.step >= relabelStep) { relabeled = true; drawWheelTexture(); }
        if (livCtx.done) { finishResolve(); break; }
      }
      wheelMesh.rotation.y = state.wheelAngle;
      ballWorldPos(state.ballAngle, state.radius, state.height, state.bounceVisual);
    } else {
      // idle / preroll / reveal: the wheel never stops -- it keeps cruising at the same
      // constant, readable WHEEL_SPEED a real casino wheel coasts at between throws, driven by
      // the same fixed-step clock (not raw wall-clock dt) as the resolve simulation so there's
      // no seam when a spin picks the wheel angle back up as its baseline.
      const debt = Math.min(dt / STEP, 6);
      for (let i = 0; i < debt; i++) idleWheelAngle += WHEEL_SPEED * STEP;
      wheelMesh.rotation.y = idleWheelAngle;
      if (phase === 'preroll') {
        // The ball gets picked up and thrown fast against the steadily-turning wheel -- only
        // the ball's preroll agitation is wall-clock driven (its duration is however long the
        // network takes, unlike the wheel's fixed cruise), matching the earlier preroll feel.
        prerollAngle += PREROLL_BALL_SPEED * dt;
        ballWorldPos(prerollAngle, ORBIT_R, ORBIT_Y, 0);
      } else {
        // idle / reveal: the ball rests in its pocket, riding along with the wheel rather than
        // floating still while the wheel turns underneath it.
        ballWorldPos(idleWheelAngle + restBallOffset, POCKET_R, POCKET_Y, 0);
      }
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
