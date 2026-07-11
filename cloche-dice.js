/* ============================================================
   cloche-dice.js
   Shared 3D physics dice overlay for the bubble machine tables.

   Requires (load before this file):
     three.js r128   https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js
     cannon.js 0.6.2 https://cdnjs.cloudflare.com/ajax/libs/cannon.js/0.6.2/cannon.min.js

   SERVER-AUTHORITATIVE DESIGN
   The module never decides the roll. The host page calls:

     const result = await ClocheDice.roll(serverPromise);

   where serverPromise resolves to an array of die values from the
   Edge Function, e.g. [3, 4] for craps or [2, 5, 5] for sic-bo.
   The overlay appears, the dice agitate for at least minAgitateMs
   and for as long as the server takes, then a final launch is made
   whose outcome is guaranteed to display the server values.

   HOW THE FORCED LANDING WORKS
   1. Snapshot the physics state at the moment of the final launch.
   2. Silently pre-simulate the launch and settle with a seeded RNG
      and fixed 1/120 timestep to learn which face of each die lands
      up naturally.
   3. Restore the snapshot, relabel each die's face textures so the
      natural landing face shows the server value (opposite faces
      still sum to 7), then replay the identical simulation live.
   4. Safety net: when the live dice settle, the natural face is
      verified. If floating point ever diverges from the pre-sim,
      faces are relabeled at rest before reveal. Either way the
      displayed values are exactly the server values.

   INTEGRATION (craps, 2 dice at 2.0):
     ClocheDice.init({ diceCount: 2, dieSize: 2.0 });
     ...
     const data = await ClocheDice.roll(callRollEdgeFunction());
     // data = { values: [3, 4], total: 7, forced: true }
     // overlay has closed; update the inline static dice with data.values

   INTEGRATION (sic-bo, 3 dice at 1.8):
     ClocheDice.init({ diceCount: 3, dieSize: 1.8 });

   roll() also accepts a plain array for local testing:
     ClocheDice.roll([6, 1]);
   ============================================================ */
(function (global) {
  'use strict';

  // The tables declare a top-level `let THREE` that is only assigned inside
  // initDice() after login. That lexical global shadows window.THREE for
  // bare references in every script on the page, so bind explicitly to the
  // real libraries here. Same treatment for CANNON as cheap insurance.
  const THREE = global.THREE;
  const CANNON = global.CANNON;
  if (!THREE || !CANNON) {
    console.error('cloche-dice.js: three.js and cannon.js must be loaded first');
    return;
  }

  // ---------- config ----------
  const CFG = {
    diceCount: 2,
    dieSize: 2.0,
    clocheRadius: 3.8,
    clocheHeight: 7.5,
    gravity: -34,
    minAgitateMs: 1400,     // agitate at least this long even on fast servers
    buzzMs: 750,            // vibration-only lead-in before launches
    settleSpeed: 0.18,
    flatThreshold: 0.99,
    holdSteps: 48,          // 0.4s at 120hz of flat+still before reading
    maxResolveSteps: 120 * 25,
    presimAttempts: 5,
    revealHoldMs: 1000,     // overlay lingers on the settled dice
    faceImages: null,       // optional {1: dataURL, ... 6: dataURL} custom faces
    wallSegments: 14,
    zIndex: 9999
  };

  const PLATFORM_Y = 0.35;
  const STEP = 1 / 120;

  // face pairs in BoxGeometry material order [+x,-x,+y,-y,+z,-z]
  // opposite face of index i is (i ^ 1)
  const DEFAULT_FACE_VALUES = [1, 6, 2, 5, 3, 4];
  const FACE_NORMALS = [
    new CANNON.Vec3(1, 0, 0), new CANNON.Vec3(-1, 0, 0),
    new CANNON.Vec3(0, 1, 0), new CANNON.Vec3(0, -1, 0),
    new CANNON.Vec3(0, 0, 1), new CANNON.Vec3(0, 0, -1)
  ];

  // ---------- module state ----------
  let inited = false;
  let overlayEl, stageEl, labelEl;
  let scene, camera, renderer, world, platformMesh;
  let matDie, matSurface, matGlass;
  let dice = [];
  let rafId = null;
  let lastTime = 0;

  // phase: idle | preroll | resolving | reveal
  let phase = 'idle';
  let prerollT0 = 0, prerollNextThump = 0;
  let serverValues = null;
  let resolveCtx = null;      // deterministic replay context
  let stepDebt = 0;
  let activeResolve = null, activeReject = null;
  let rollT0 = 0;
  let resultCallbacks = [];

  // ---------- jovial random-note bell chime (dice tumble + coin waterfall both use this) ----------
  // Synthesized rather than sampled -- the real thing to match here (InterBlock/Easy
  // Craps/Crapless Craps electronic tables' cloche sound) is proprietary casino equipment
  // audio, not something legally available to source or reuse. A tiny Web Audio synth gets the
  // same "random notes while the dice tumble" character with zero licensing concerns, and syncs
  // exactly to however long a given roll's preroll+resolving phases actually last.
  let _actx = null, _noteTimer = null, _reverbSend = null, _echoSend = null;
  // C major pentatonic across two octaves -- no "wrong" notes in this scale, so hitting random
  // ones back to back still sounds jovial rather than dissonant.
  const NOTE_SCALE = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25, 783.99, 880.00];
  // Real bells ring with several INHARMONIC partials (not clean integer multiples of the
  // fundamental, unlike a plucked string or the earlier fundamental+octave version this
  // replaces), and the higher partials decay noticeably faster than the fundamental -- that's
  // what gives a bell its characteristic bright "strike" that quickly settles into a longer,
  // duller hum. Ratios here are loosely modeled on classic bell FM-synthesis partial sets.
  const BELL_PARTIALS = [
    { mult: 1.00, vol: 1.00, decay: 0.85 },
    { mult: 2.76, vol: 0.50, decay: 0.45 },
    { mult: 5.40, vol: 0.24, decay: 0.28 },
    { mult: 8.93, vol: 0.12, decay: 0.16 }
  ];
  // Builds a synthetic impulse response for ConvolverNode -- decaying filtered noise, the
  // standard way to get a smooth algorithmic reverb tail without needing to source/license an
  // actual recorded impulse response file.
  function _makeImpulseResponse(ctx, duration, decayPower) {
    const rate = ctx.sampleRate, length = Math.floor(rate * duration);
    const impulse = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decayPower);
    }
    return impulse;
  }
  // One shared reverb (smooth wash) + echo (discrete repeats) bus that every note's dry signal
  // gets sent into, rather than building a convolver/delay chain per note -- notes fire every
  // 30-180ms, so overlapping tails from a shared bus is exactly what makes it sound like one
  // continuous chime-y space instead of each note being cut off dry.
  function _buildEffects(ctx) {
    const convolver = ctx.createConvolver();
    convolver.buffer = _makeImpulseResponse(ctx, 2.0, 2.3);
    const reverbOut = ctx.createGain(); reverbOut.gain.value = 0.6;
    convolver.connect(reverbOut); reverbOut.connect(ctx.destination);
    _reverbSend = ctx.createGain(); _reverbSend.gain.value = 1;
    _reverbSend.connect(convolver);

    const delay = ctx.createDelay(1.0); delay.delayTime.value = 0.22;
    const feedback = ctx.createGain(); feedback.gain.value = 0.4;
    const echoOut = ctx.createGain(); echoOut.gain.value = 0.5;
    delay.connect(feedback); feedback.connect(delay); // feedback loop -> repeating echoes
    delay.connect(echoOut); echoOut.connect(ctx.destination);
    _echoSend = ctx.createGain(); _echoSend.gain.value = 1;
    _echoSend.connect(delay);
  }
  function _ensureAudio() {
    if (!_actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      _actx = new AC();
      _buildEffects(_actx);
    }
    if (_actx.state === 'suspended') _actx.resume().catch(() => {});
    return _actx;
  }
  // volume scales the overall level -- used by the coin waterfall to read as louder/more
  // excited than the dice tumble without actually being a different instrument.
  function playChimeNote(volume) {
    const ctx = _ensureAudio(); if (!ctx) return;
    volume = volume == null ? 1 : volume;
    const freq = NOTE_SCALE[Math.floor(Math.random() * NOTE_SCALE.length)];
    const t = ctx.currentTime;
    const master = ctx.createGain();
    // Trimmed slightly vs. the pre-reverb version (was 0.2) to leave headroom now that the
    // reverb/echo sends add their own audible energy on top of the dry signal.
    master.gain.value = 0.16 * volume;
    master.connect(ctx.destination); // dry
    master.connect(_reverbSend);     // smooth chime-y tail
    master.connect(_echoSend);       // discrete repeats
    BELL_PARTIALS.forEach(p => {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(p.vol, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + p.decay);
      osc.type = 'sine';
      osc.frequency.value = freq * p.mult;
      osc.connect(g); g.connect(master);
      osc.start(t); osc.stop(t + p.decay + 0.02);
    });
  }
  function startTumbleNotes() {
    stopTumbleNotes();
    (function tick() {
      playChimeNote();
      _noteTimer = setTimeout(tick, 80 + Math.random() * 100);
    })();
  }
  function stopTumbleNotes() {
    if (_noteTimer) { clearTimeout(_noteTimer); _noteTimer = null; }
  }

  // ---------- seeded RNG (mulberry32) ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- textures ----------
  const TEX_CACHE = {};
  function faceTexture(value) {
    if (TEX_CACHE[value]) return TEX_CACHE[value];
    // custom face art (e.g. the tables' DIE_B64 PNGs) takes priority
    if (CFG.faceImages && CFG.faceImages[value]) {
      const tex = new THREE.TextureLoader().load(CFG.faceImages[value]);
      tex.anisotropy = 4;
      TEX_CACHE[value] = tex;
      return tex;
    }
    const S = 256, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const bg = g.createRadialGradient(S / 2, S / 2, S * 0.2, S / 2, S / 2, S * 0.75);
    bg.addColorStop(0, '#faf6ea');
    bg.addColorStop(1, '#d9d2bd');
    g.fillStyle = bg;
    g.fillRect(0, 0, S, S);
    const pos = {
      1: [[.5, .5]],
      2: [[.28, .28], [.72, .72]],
      3: [[.25, .25], [.5, .5], [.75, .75]],
      4: [[.28, .28], [.72, .28], [.28, .72], [.72, .72]],
      5: [[.25, .25], [.75, .25], [.5, .5], [.25, .75], [.75, .75]],
      6: [[.28, .22], [.72, .22], [.28, .5], [.72, .5], [.28, .78], [.72, .78]]
    }[value];
    for (const [x, y] of pos) {
      const px = x * S, py = y * S, r = S * 0.085;
      const pg = g.createRadialGradient(px - r * 0.3, py - r * 0.3, r * 0.1, px, py, r);
      pg.addColorStop(0, '#3a3a3a');
      pg.addColorStop(1, '#0e0e0e');
      g.fillStyle = pg;
      g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    TEX_CACHE[value] = tex;
    return tex;
  }

  // ---------- geometry ----------
  function roundedBoxGeometry(size, radius, seg) {
    const geo = new THREE.BoxGeometry(size, size, size, seg, seg, seg);
    const posA = geo.attributes.position;
    const half = size / 2 - radius;
    const v = new THREE.Vector3();
    for (let i = 0; i < posA.count; i++) {
      v.fromBufferAttribute(posA, i);
      const cx = Math.max(-half, Math.min(half, v.x));
      const cy = Math.max(-half, Math.min(half, v.y));
      const cz = Math.max(-half, Math.min(half, v.z));
      let dx = v.x - cx, dy = v.y - cy, dz = v.z - cz;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len > 0) { const k = radius / len; dx *= k; dy *= k; dz *= k; }
      posA.setXYZ(i, cx + dx, cy + dy, cz + dz);
    }
    geo.computeVertexNormals();
    return geo;
  }

  // ---------- overlay DOM ----------
  function buildOverlay() {
    const style = document.createElement('style');
    style.textContent = [
      '.cdx-overlay{position:fixed;inset:0;display:none;align-items:center;',
      'justify-content:center;flex-direction:column;background:rgba(5,10,8,0.82);',
      'z-index:' + CFG.zIndex + ';opacity:0;transition:opacity 240ms ease;}',
      '.cdx-overlay.cdx-open{display:flex;}',
      '.cdx-overlay.cdx-visible{opacity:1;}',
      '.cdx-stage{width:min(640px,92vw);height:min(520px,70vh);}',
      '.cdx-label{color:#c9a24b;font-family:Georgia,serif;font-size:15px;',
      'letter-spacing:0.2em;text-transform:uppercase;margin-top:6px;',
      'min-height:20px;text-align:center;}'
    ].join('');
    document.head.appendChild(style);

    overlayEl = document.createElement('div');
    overlayEl.className = 'cdx-overlay';
    stageEl = document.createElement('div');
    stageEl.className = 'cdx-stage';
    labelEl = document.createElement('div');
    labelEl.className = 'cdx-label';
    overlayEl.appendChild(stageEl);
    overlayEl.appendChild(labelEl);
    document.body.appendChild(overlayEl);
  }

  function showOverlay() {
    overlayEl.classList.add('cdx-open');
    renderer.setSize(stageEl.clientWidth, stageEl.clientHeight);
    camera.aspect = stageEl.clientWidth / stageEl.clientHeight;
    camera.updateProjectionMatrix();
    requestAnimationFrame(() => overlayEl.classList.add('cdx-visible'));
  }

  function hideOverlay() {
    overlayEl.classList.remove('cdx-visible');
    setTimeout(() => overlayEl.classList.remove('cdx-open'), 260);
  }

  // ---------- scene ----------
  function buildScene() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    stageEl.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0f0d, 24, 40);

    camera = new THREE.PerspectiveCamera(42, 1.2, 0.1, 100);
    camera.position.set(0, 8.5, 12.5);
    camera.lookAt(0, 2.6, 0);

    scene.add(new THREE.AmbientLight(0x8a94a0, 0.45));
    const key = new THREE.DirectionalLight(0xfff2d9, 1.1);
    key.position.set(6, 14, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -7; key.shadow.camera.right = 7;
    key.shadow.camera.top = 7; key.shadow.camera.bottom = -7;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x6fa8ff, 0.5);
    rim.position.set(-8, 6, -6);
    scene.add(rim);

    world = new CANNON.World();
    world.gravity.set(0, CFG.gravity, 0);
    world.broadphase = new CANNON.NaiveBroadphase();
    world.solver.iterations = 14;

    matDie = new CANNON.Material('die');
    matSurface = new CANNON.Material('surface'); // felt floor only -- unchanged, dice still settle normally here
    matGlass = new CANNON.Material('glass'); // cloche walls + ceiling -- lower friction so dice don't stick to the glass
    world.addContactMaterial(new CANNON.ContactMaterial(matDie, matSurface, {
      friction: 0.22, restitution: 0.42
    }));
    world.addContactMaterial(new CANNON.ContactMaterial(matDie, matGlass, {
      friction: 0.04, restitution: 0.45
    }));
    world.addContactMaterial(new CANNON.ContactMaterial(matDie, matDie, {
      friction: 0.01, restitution: 0.48
    }));
    world.defaultContactMaterial.friction = 0.2;
    world.defaultContactMaterial.restitution = 0.4;

    const R = CFG.clocheRadius, H = CFG.clocheHeight;

    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(R + 1.1, R + 1.5, 1.2, 48),
      new THREE.MeshStandardMaterial({ color: 0x2b1d10, roughness: 0.6, metalness: 0.15 }));
    pedestal.position.y = -0.65;
    pedestal.receiveShadow = true;
    scene.add(pedestal);

    // static plane floor: cannot be tunneled
    const floor = new CANNON.Body({ mass: 0, material: matSurface });
    floor.addShape(new CANNON.Plane());
    floor.position.set(0, PLATFORM_Y, 0);
    floor.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    world.addBody(floor);

    platformMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(R + 0.15, R + 0.15, 0.7, 48),
      new THREE.MeshStandardMaterial({ color: 0x0d3b2e, roughness: 0.95 }));
    platformMesh.receiveShadow = true;
    scene.add(platformMesh);

    const segs = CFG.wallSegments;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const wall = new CANNON.Body({ mass: 0, material: matGlass });
      const halfW = (Math.PI * R / segs) * 1.25;
      wall.addShape(new CANNON.Box(new CANNON.Vec3(halfW, H / 2 + 2, 0.35)));
      wall.position.set(Math.sin(a) * (R + 0.33), H / 2, Math.cos(a) * (R + 0.33));
      wall.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), a);
      world.addBody(wall);
    }
    const ceiling = new CANNON.Body({ mass: 0, material: matGlass });
    ceiling.addShape(new CANNON.Plane());
    ceiling.position.set(0, H + 1.2, 0);
    ceiling.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), Math.PI / 2);
    world.addBody(ceiling);

    const clocheGroup = new THREE.Group();
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0xcfe8ef, transparent: true, opacity: 0.13,
      roughness: 0.05, metalness: 0, side: THREE.DoubleSide,
      clearcoat: 1, clearcoatRoughness: 0.1, depthWrite: false
    });
    const tube = new THREE.Mesh(
      new THREE.CylinderGeometry(R + 0.45, R + 0.45, H, 64, 1, true), glass);
    tube.position.y = H / 2 + 0.35;
    clocheGroup.add(tube);
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(R + 0.45, 64, 24, 0, Math.PI * 2, 0, Math.PI / 2), glass);
    dome.position.y = H + 0.35;
    clocheGroup.add(dome);
    const knob = new THREE.Mesh(
      new THREE.SphereGeometry(0.38, 24, 16),
      new THREE.MeshStandardMaterial({ color: 0xc9a24b, roughness: 0.3, metalness: 0.9 }));
    knob.position.y = H + R + 0.72;
    clocheGroup.add(knob);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(R + 0.45, 0.09, 12, 64),
      new THREE.MeshStandardMaterial({ color: 0xc9a24b, roughness: 0.35, metalness: 0.85 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.42;
    clocheGroup.add(ring);
    scene.add(clocheGroup);
  }

  function buildDice(n) {
    for (const d of dice) { scene.remove(d.mesh); world.remove(d.body); }
    dice = [];
    const s = CFG.dieSize;
    const edgeR = s * 0.12;

    for (let i = 0; i < n; i++) {
      const faceValues = DEFAULT_FACE_VALUES.slice();
      const mats = faceValues.map(v => new THREE.MeshStandardMaterial({
        map: faceTexture(v), roughness: 0.4, metalness: 0.05
      }));
      const mesh = new THREE.Mesh(roundedBoxGeometry(s, edgeR, 4), mats);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);

      const body = new CANNON.Body({ mass: 1, material: matDie });
      const h = s / 2 * 0.95;
      body.addShape(new CANNON.Box(new CANNON.Vec3(h, h, h)));
      body.linearDamping = 0.12;
      body.angularDamping = 0.12;
      body.allowSleep = false;
      world.addBody(body);

      dice.push({ mesh, body, faceValues, nextPopStep: 0 });
    }
    resetDicePositions();
  }

  function resetDicePositions() {
    const s = CFG.dieSize, n = dice.length;
    for (let i = 0; i < n; i++) {
      const d = dice[i];
      const a = (i / n) * Math.PI * 2;
      const r = Math.min(1.3, CFG.clocheRadius - s);
      d.body.position.set(Math.sin(a) * r, PLATFORM_Y + s / 2 + 0.02 + i * 0.01, Math.cos(a) * r);
      d.body.velocity.set(0, 0, 0);
      d.body.angularVelocity.set(0, 0, 0);
      d.body.quaternion.setFromEuler(
        Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    }
  }

  // ---------- face reading and relabeling ----------
  function naturalUpFace(d) {
    const up = new CANNON.Vec3(0, 1, 0);
    let best = -2, idx = 0;
    for (let i = 0; i < 6; i++) {
      const worldN = d.body.quaternion.vmult(FACE_NORMALS[i]);
      const dot = worldN.dot(up);
      if (dot > best) { best = dot; idx = i; }
    }
    return { idx, confidence: best };
  }

  function relabelDie(d, upFaceIdx, targetValue) {
    const values = new Array(6);
    values[upFaceIdx] = targetValue;
    values[upFaceIdx ^ 1] = 7 - targetValue;
    const used = new Set([targetValue, 7 - targetValue]);
    // low halves of the two unused value pairs
    const lows = [1, 2, 3].filter(v => !used.has(v) && !used.has(7 - v));
    // the two face pairs not containing the up face
    const pairIdx = [[0, 1], [2, 3], [4, 5]]
      .filter(p => p[0] !== upFaceIdx && p[1] !== upFaceIdx);
    for (let k = 0; k < pairIdx.length; k++) {
      values[pairIdx[k][0]] = lows[k];
      values[pairIdx[k][1]] = 7 - lows[k];
    }
    d.faceValues = values;
    for (let i = 0; i < 6; i++) {
      d.mesh.material[i].map = faceTexture(values[i]);
      d.mesh.material[i].needsUpdate = true;
    }
  }

  // ---------- physics state snapshot ----------
  function snapshot() {
    return dice.map(d => ({
      p: d.body.position.clone(),
      q: d.body.quaternion.clone(),
      v: d.body.velocity.clone(),
      w: d.body.angularVelocity.clone()
    }));
  }

  function restore(snap) {
    for (let i = 0; i < dice.length; i++) {
      const d = dice[i], s = snap[i];
      d.body.position.copy(s.p);
      d.body.quaternion.copy(s.q);
      d.body.velocity.copy(s.v);
      d.body.angularVelocity.copy(s.w);
      d.body.force.set(0, 0, 0);
      d.body.torque.set(0, 0, 0);
    }
  }

  function clampDice() {
    const s = CFG.dieSize, R = CFG.clocheRadius;
    for (const d of dice) {
      const p = d.body.position;
      if (p.y < PLATFORM_Y + s * 0.25) {
        p.y = PLATFORM_Y + s * 0.5;
        if (d.body.velocity.y < 0) d.body.velocity.y = 0;
      }
      const horiz = Math.sqrt(p.x * p.x + p.z * p.z);
      const maxR = R - s * 0.4;
      if (horiz > maxR) { const k = maxR / horiz; p.x *= k; p.z *= k; }
    }
  }

  // ---------- deterministic resolve plan ----------
  // one function drives both the silent pre-simulation and the live
  // replay. all randomness comes from ctx.rng and all timing from
  // ctx.step, so the two runs are identical on the same machine.
  function makeResolveCtx(rng) {
    return { rng, step: 0, hold: 0, done: false, correcting: false,
             popSteps: dice.map(() => 0) };
  }

  function resolveStep(ctx) {
    const rng = ctx.rng;
    if (ctx.step === 0) {
      for (const d of dice) {
        d.body.velocity.set(
          (rng() - 0.5) * 5,
          9 + rng() * 5,
          (rng() - 0.5) * 5);
        d.body.angularVelocity.set(
          (rng() - 0.5) * 20, (rng() - 0.5) * 20, (rng() - 0.5) * 20);
      }
    }

    world.step(STEP);
    clampDice();
    ctx.step++;

    let allStill = true, allFlat = true;
    for (const d of dice) {
      if (d.body.velocity.norm() > CFG.settleSpeed ||
          d.body.angularVelocity.norm() > CFG.settleSpeed) allStill = false;
      if (naturalUpFace(d).confidence < CFG.flatThreshold) allFlat = false;
    }

    if (allStill && allFlat) {
      ctx.correcting = false;
      ctx.hold++;
      if (ctx.hold >= CFG.holdSteps) ctx.done = true;
      return;
    }
    ctx.hold = 0;

    if (allStill && !allFlat) {
      ctx.correcting = true;
      for (let i = 0; i < dice.length; i++) {
        const d = dice[i];
        if (naturalUpFace(d).confidence >= CFG.flatThreshold) continue;
        if (d.body.position.y >= PLATFORM_Y + CFG.dieSize * 1.5) continue;
        d.body.velocity.x += (rng() - 0.5) * 1.2;
        d.body.velocity.z += (rng() - 0.5) * 1.2;
        d.body.velocity.y += rng() * 0.9;
        d.body.angularVelocity.x += (rng() - 0.5) * 5;
        d.body.angularVelocity.z += (rng() - 0.5) * 5;
        if (ctx.step >= ctx.popSteps[i]) {
          ctx.popSteps[i] = ctx.step + 84 + Math.floor(rng() * 60);
          d.body.velocity.y = 4.5;
          d.body.angularVelocity.set(
            (rng() - 0.5) * 9, (rng() - 0.5) * 9, (rng() - 0.5) * 9);
        }
      }
    } else {
      ctx.correcting = false;
    }
  }

  // silent pre-simulation: returns natural up-face indices or null
  function presimulate(seed) {
    const ctx = makeResolveCtx(mulberry32(seed));
    while (!ctx.done && ctx.step < CFG.maxResolveSteps) resolveStep(ctx);
    if (!ctx.done) return null;
    return dice.map(d => naturalUpFace(d).idx);
  }

  // ---------- roll orchestration ----------
  function beginResolve() {
    const snap = snapshot();
    let chosenSeed = null, upFaces = null;

    const baseSeed = (Math.random() * 0xFFFFFFFF) >>> 0;
    for (let attempt = 0; attempt < CFG.presimAttempts; attempt++) {
      const seed = (baseSeed + attempt * 7919) >>> 0;
      restore(snap);
      const faces = presimulate(seed);
      if (faces) { chosenSeed = seed; upFaces = faces; break; }
    }

    restore(snap);

    if (chosenSeed !== null) {
      // relabel so the natural landing face shows the server value
      for (let i = 0; i < dice.length; i++) {
        relabelDie(dice[i], upFaces[i], serverValues[i]);
      }
      resolveCtx = makeResolveCtx(mulberry32(chosenSeed));
      resolveCtx.expectedFaces = upFaces;
      resolveCtx.fallback = false;
    } else {
      // pre-sim never settled within the cap: run live and relabel at rest
      resolveCtx = makeResolveCtx(mulberry32((Math.random() * 0xFFFFFFFF) >>> 0));
      resolveCtx.fallback = true;
    }
    stepDebt = 0;
    phase = 'resolving';
    labelEl.textContent = '';
  }

  function finishResolve(now) {
    // verify, and repair if the live run diverged from the pre-sim
    for (let i = 0; i < dice.length; i++) {
      const face = naturalUpFace(dice[i]).idx;
      if (dice[i].faceValues[face] !== serverValues[i]) {
        relabelDie(dice[i], face, serverValues[i]);
      }
    }
    const values = serverValues.slice();
    const payload = {
      values,
      total: values.reduce((a, b) => a + b, 0),
      forced: true,
      timeMs: Math.round(now - rollT0)
    };
    phase = 'reveal';
    stopTumbleNotes();
    setTimeout(() => {
      hideOverlay();
      phase = 'idle';
      serverValues = null;
      const done = activeResolve; activeResolve = null; activeReject = null;
      for (const fn of resultCallbacks) { try { fn(payload); } catch (e) { console.error(e); } }
      document.dispatchEvent(new CustomEvent('dice-result', { detail: payload }));
      if (done) done(payload);
    }, CFG.revealHoldMs);
  }

  // ---------- main loop ----------
  function loop(now) {
    rafId = requestAnimationFrame(loop);
    const dt = Math.min((now - lastTime) / 1000, 1 / 20);
    lastTime = now;
    if (dt <= 0 || phase === 'idle') { renderIfOpen(); return; }

    if (phase === 'preroll') {
      // free-running agitation, wall clock driven, outcome irrelevant
      const t = (now - prerollT0) / 1000;
      const inBuzz = (now - prerollT0) < CFG.buzzMs;
      platformMesh.position.y =
        Math.sin(t * 55) * 0.04 + Math.sin(t * 23 + 1.3) * 0.025;

      for (const d of dice) {
        if (d.body.position.y < PLATFORM_Y + CFG.dieSize * 1.5) {
          d.body.velocity.x += (Math.random() - 0.5) * 1.6;
          d.body.velocity.z += (Math.random() - 0.5) * 1.6;
          d.body.velocity.y += Math.random() * 1.2;
          d.body.angularVelocity.x += (Math.random() - 0.5) * 6;
          d.body.angularVelocity.y += (Math.random() - 0.5) * 6;
          d.body.angularVelocity.z += (Math.random() - 0.5) * 6;
        }
      }
      if (!inBuzz && now >= prerollNextThump) {
        prerollNextThump = now + 300 + Math.random() * 500;
        for (const d of dice) {
          if (d.body.position.y < PLATFORM_Y + CFG.dieSize * 1.5) {
            d.body.velocity.y = Math.max(d.body.velocity.y, 8 + Math.random() * 6);
            d.body.velocity.x += (Math.random() - 0.5) * 4;
            d.body.velocity.z += (Math.random() - 0.5) * 4;
            d.body.angularVelocity.set(
              (Math.random() - 0.5) * 20,
              (Math.random() - 0.5) * 20,
              (Math.random() - 0.5) * 20);
          }
        }
      }
      world.step(STEP, dt, 6);
      clampDice();

      const minDone = now - prerollT0 >= CFG.minAgitateMs;
      if (minDone && serverValues) beginResolve();

    } else if (phase === 'resolving') {
      // fixed-step deterministic replay of the pre-simulated plan
      stepDebt += dt;
      let guard = 10;
      while (stepDebt >= STEP && !resolveCtx.done && guard-- > 0) {
        resolveStep(resolveCtx);
        stepDebt -= STEP;
      }
      platformMesh.position.y = resolveCtx.correcting
        ? Math.sin(now / 1000 * 48) * 0.025 + Math.sin(now / 1000 * 19 + 0.7) * 0.015
        : platformMesh.position.y * 0.85;

      if (resolveCtx.done || resolveCtx.step >= CFG.maxResolveSteps * 2) {
        finishResolve(now);
      }
    } else {
      platformMesh.position.y *= 0.85;
    }

    renderIfOpen();
  }

  function renderIfOpen() {
    if (!overlayEl.classList.contains('cdx-open')) return;
    for (const d of dice) {
      d.mesh.position.copy(d.body.position);
      d.mesh.quaternion.copy(d.body.quaternion);
    }
    renderer.render(scene, camera);
  }

  // ---------- public API ----------
  const ClocheDice = {
    init(options = {}) {
      if (inited) { this.configure(options); return; }
      Object.assign(CFG, options);
      buildOverlay();
      buildScene();
      buildDice(CFG.diceCount);
      inited = true;
      lastTime = performance.now();
      rafId = requestAnimationFrame(loop);
    },

    configure(options = {}) {
      const prevCount = CFG.diceCount, prevSize = CFG.dieSize;
      Object.assign(CFG, options);
      if (inited && (CFG.diceCount !== prevCount || CFG.dieSize !== prevSize)) {
        if (phase === 'idle') buildDice(CFG.diceCount);
      }
    },

    // valuesOrPromise: number[] or Promise<number[]>
    roll(valuesOrPromise) {
      if (!inited) return Promise.reject(new Error('ClocheDice.init() first'));
      if (phase !== 'idle') return Promise.reject(new Error('roll in progress'));

      return new Promise((resolve, reject) => {
        activeResolve = resolve;
        activeReject = reject;
        serverValues = null;
        rollT0 = performance.now();
        prerollT0 = rollT0;
        prerollNextThump = rollT0 + CFG.buzzMs;
        resetDicePositions();
        phase = 'preroll';
        labelEl.textContent = 'rolling';
        showOverlay();
        startTumbleNotes();

        Promise.resolve(valuesOrPromise).then(values => {
          if (!Array.isArray(values) || values.length !== dice.length ||
              values.some(v => !Number.isInteger(v) || v < 1 || v > 6)) {
            throw new Error('server values must be ' + dice.length + ' integers 1-6');
          }
          serverValues = values;
        }).catch(err => {
          phase = 'idle';
          hideOverlay();
          stopTumbleNotes();
          const rej = activeReject; activeResolve = null; activeReject = null;
          if (rej) rej(err);
        });
      });
    },

    isRolling: () => phase !== 'idle',
    onResult: (fn) => resultCallbacks.push(fn),
    // Exposed so other UI (the winner-modal coin waterfall) can reuse the exact same bell-chime
    // instrument as the dice tumble instead of duplicating the synth or using a different sound.
    playChimeNote: (volume) => playChimeNote(volume)
  };

  global.ClocheDice = ClocheDice;
})(window);
