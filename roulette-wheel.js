// roulette-wheel.js — shared 3D physics roulette wheel + ball, same family as cloche-dice.js.
//
// Core design (identical principle to ClocheDice, see references/dice-engine.md): this module
// NEVER decides the outcome. It takes a promise that resolves to the server-decided pocket
// and forces the ball to land there while still looking like a real, unpredictable spin:
//   1. Snapshots the ball's real physics state (position/velocity/quaternion) at the moment the
//      true spin begins.
//   2. Silently pre-simulates the spin (real cannon.js rigid-body physics, fixed timestep, no
//      per-step randomness at all) to learn which physical pocket slot the ball naturally comes
//      to rest over. cannon.js stepping is bit-for-bit deterministic given identical initial
//      conditions and timestep sequence (verified empirically before relying on it) -- unlike the
//      dice, which do inject seeded per-step randomness and therefore need a seed to replay
//      identically, this sim needs none: the SAME baseline always produces the SAME outcome.
//   3. Restores the snapshot, relabels the wheel's number ring (rotates which drawn slot shows
//      which number) so the server's target pocket sits at that natural resting slot, then
//      replays the identical simulation live.
//   4. Verifies at rest that the displayed pocket matches; relabels again if it ever drifts.
//
// Physics model: this is REAL rigid-body physics (cannon.js integrating actual forces and
// collisions), the same foundation cloche-dice.js is built on -- not a hand-tuned formula
// dressed up to look physics-ish (an earlier version of this file was exactly that, and it
// showed: no amount of tuning radius/height lerp curves made it feel real, because it wasn't).
//   - Ball: a real CANNON.Sphere body, real gravity, real damping.
//   - Bowl slope: a RING OF FLAT BOX "PLANKS" tilted to the slope angle, not a single curved
//     CANNON.Cylinder shape -- confirmed empirically that this cannon.js build's Cylinder
//     contact resolution does not let a resting sphere slide down even a shallow slope (a
//     genuine library limitation, not a tuning problem: a plain tilted Box does slide a sphere
//     correctly with the same friction coefficient). A ring of small flat planks is the exact
//     technique cloche-dice.js already uses for its walls, just tilted instead of vertical, and
//     it produces a real, emergent spiral-down-as-speed-decays descent -- confirmed by direct
//     simulation, not assumed.
//   - Outer wall: a ring of flat CANNON.Box segments, the same proven pattern as the dice
//     cloche's glass walls.
//   - Frets (pocket dividers): a single KINEMATIC compound body (N box shapes), rotated by
//     directly setting its quaternion from the deterministic wheel angle each step -- real
//     contact-resolution bounces off a really-moving body, not a scripted "kick" formula.
//   - "Settled" = the ball's actual angular velocity has converged to the wheel's (it's genuinely
//     riding along, sustained for a hold window), not a fixed step count and not "speed near
//     zero" -- a ball riding a spinning wheel has real nonzero linear speed, that's correct.
//
// Requires (load before it): three.min.js, cannon.min.js
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
    maxResolveSteps: 9000, // safety cap (~75s at 120Hz) on the whole resolve, in case the ball
                           // somehow never converges on a given throw -- practically unreachable.
  };
  const STEP = 1 / 120;
  const Y_AXIS_LOCAL = { x: 0, y: 1, z: 0 }; // plain object; turned into CANNON.Vec3 lazily below

  const WHEEL_ORDER = ['0', 28, 9, 26, 30, 11, 7, 20, 32, 17, 5, 22, 34, 15, 3, 24, 36, 13, 1,
    '00', 27, 10, 25, 29, 12, 8, 19, 31, 18, 6, 21, 33, 16, 4, 23, 35, 14, 2].map(String);
  const N = WHEEL_ORDER.length; // 38
  const SLOT_ANGLE = (Math.PI * 2) / N;
  const RED = new Set(['1','3','5','7','9','12','14','16','18','19','21','23','25','27','30','32','34','36']);
  function colorOf(pocket) { return (pocket === '0' || pocket === '00') ? 'green' : (RED.has(pocket) ? 'red' : 'black'); }

  let THREE_ = null, CANNON_ = null;
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

  // ---------- wheel number-ring texture (the "relabel" surface) ----------
  function buildWheelTexture() {
    const size = 1536; // higher-res than an earlier 1024 -- the wheel renders large enough on
                        // screen (see #wheel-wrap in roulette.html) that labels need more source
                        // pixels to stay crisp instead of blurry.
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
    THREE_ = global.THREE; CANNON_ = global.CANNON;
    const container = typeof CFG.container === 'string' ? document.getElementById(CFG.container) : CFG.container;
    const w = container.clientWidth || 200, h = container.clientHeight || 200;

    scene = new THREE_.Scene();
    // Orthographic camera, sized to the wheel's actual radius (see fitCameraFrustum) rather than
    // a perspective camera at a hand-picked distance/FOV -- a perspective camera close enough to
    // read the wheel's small on-screen size cropped the view into a square window that only
    // showed the hub, with the whole numbered rim (and the wheel's roundness) entirely outside
    // the frame. Orthographic + exact-fit framing sidesteps that class of bug.
    // Tilted rather than pure top-down -- a straight-down view looks along the Y axis, so
    // vertical bounce/height motion is geometrically invisible no matter how large it is. The
    // 8:6 ratio gives a clean 36.87 degrees off vertical (cos = 0.8), which fitCameraFrustum
    // compensates for explicitly.
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
    // The numbered face is a flat CircleGeometry rather than a CylinderGeometry top cap -- a
    // cylinder cap's UV layout doesn't match the simple "circle inscribed in a square" mapping
    // the canvas texture is drawn with (confirmed: it rendered as a radial sunburst, the classic
    // symptom of a texture read with the wrong UV parameterization). CircleGeometry's UV mapping
    // is the standard, well-defined one that actually matches.
    wheelMesh = new THREE_.Group();
    const rimGeo = new THREE_.CylinderGeometry(CFG.wheelRadius, CFG.wheelRadius, 0.12, 64);
    const rimMesh = new THREE_.Mesh(rimGeo, new THREE_.MeshStandardMaterial({ color: 0x2a1a08 }));
    wheelMesh.add(rimMesh);
    const faceGeo = new THREE_.CircleGeometry(CFG.wheelRadius, 64);
    const faceMesh = new THREE_.Mesh(faceGeo, new THREE_.MeshStandardMaterial({ map: wheelTexture }));
    faceMesh.rotation.x = -Math.PI / 2; // lie flat, facing up
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

    buildPhysicsWorld();

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
  let baseExtentY = 1, lastAspect = 1; // cached normal (non-zoomed) framing, reused by the relabel camera-zoom below
  function fitCameraFrustum(w, h) {
    const extentX = CFG.wheelRadius * 1.15;
    const extentY = extentX / TILT_COS; // compensate for the tilt-foreshortened vertical axis
    const aspect = w / h;
    baseExtentY = extentY; lastAspect = aspect;
    // #wheel-wrap is CSS-enforced square (aspect-ratio:1 in roulette.html) so aspect===1 is the
    // only case that actually runs in this app; both branches stay generous (extentY, the larger
    // of the two, wins the shared axis) rather than tightly fitting extentX, trading a bit of
    // unused horizontal margin for zero risk of re-cropping if the container ratio ever changes.
    if (aspect >= 1) { camera.top = extentY; camera.bottom = -extentY; camera.left = -extentY * aspect; camera.right = extentY * aspect; }
    else { camera.left = -extentY; camera.right = extentY; camera.top = extentY / aspect; camera.bottom = -extentY / aspect; }
    camera.position.set(0, 8, 6);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }
  // Relabel camera-zoom: the relabel (rewriting which number is drawn at which slot, see
  // relabelStep below) is a visible tell if it happens in full view of the whole wheel -- a
  // player watching could catch every number on the ring shift at once. This punches in tight on
  // the ball itself for a moment (pulling the label ring, and everything on the far side of the
  // wheel, out of frame) exactly when the swap happens, then eases back out -- "look at the ball,
  // not the numbers" as an actual camera move, not a hope. ZOOM_SCALE is how tight the punch-in
  // gets (fraction of normal framing); the ball orbits at ORBIT_R while labels sit at
  // wheelRadius*0.8 (a real gap, ~0.19 units) so a tight-enough zoom keeps the label ring mostly
  // or entirely outside the frame while the ball itself stays framed.
  const ZOOM_SCALE = 0.16;
  function applyCameraZoom(t, ballX, ballZ) {
    // t: 0 = normal framing, 1 = fully punched in on the ball. Same ease both directions so the
    // move reads as one continuous camera motion, not a hard cut in either direction.
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const scale = 1 - eased * (1 - ZOOM_SCALE);
    const extentY = baseExtentY * scale;
    const aspect = lastAspect;
    if (aspect >= 1) { camera.top = extentY; camera.bottom = -extentY; camera.left = -extentY * aspect; camera.right = extentY * aspect; }
    else { camera.left = -extentY; camera.right = extentY; camera.top = extentY / aspect; camera.bottom = -extentY / aspect; }
    const panX = ballX * eased, panZ = ballZ * eased;
    camera.position.set(panX, 8, panZ + 6);
    camera.lookAt(panX, 0, panZ);
    camera.updateProjectionMatrix();
  }
  function onResize() {
    const container = typeof CFG.container === 'string' ? document.getElementById(CFG.container) : CFG.container;
    if (!container || !renderer) return;
    const w = container.clientWidth || 200, h = container.clientHeight || 200;
    renderer.setSize(w, h);
    fitCameraFrustum(w, h);
  }

  // ---------- real rigid-body physics world (cannon.js) ----------
  // POCKET_R must sit OUTSIDE the label radius (r*0.8 in drawWheelTexture, i.e. ~0.8*wheelRadius
  // in world units) so the ball settles past the numbers toward the rim, matching a real wheel
  // (the pocket ring is the outermost moving part -- the ball never rests hub-side of the digits).
  const ORBIT_R = CFG.wheelRadius * 0.92, POCKET_R = CFG.wheelRadius * 0.87;
  const ORBIT_Y = 0.16, POCKET_Y = 0.09;
  // The wheel never stops or resets between spins -- like a real casino table, it just cruises
  // at one constant, readable speed forever (continuous across idle/preroll/resolving/reveal,
  // see idleWheelAngle and loop()). ~1 revolution every 3.9s.
  const WHEEL_SPEED = 1.6;
  const PREROLL_BALL_SPEED = -9.5; // rad/s the ball is thrown at against the wheel's own rotation

  let world, ballBody, fretBody;
  let matBall, matBowl, matWall, matFret, matFloor;

  function buildPhysicsWorld() {
    world = new CANNON_.World();
    world.gravity.set(0, -9.82, 0);
    world.broadphase = new CANNON_.NaiveBroadphase();
    world.solver.iterations = 24;

    matBall = new CANNON_.Material('ball');
    matBowl = new CANNON_.Material('bowl');
    matWall = new CANNON_.Material('wall');
    matFret = new CANNON_.Material('fret');
    matFloor = new CANNON_.Material('floor');
    world.addContactMaterial(new CANNON_.ContactMaterial(matBall, matBowl, { friction: 0.06, restitution: 0.2 }));
    world.addContactMaterial(new CANNON_.ContactMaterial(matBall, matWall, { friction: 0.02, restitution: 0.5 }));
    world.addContactMaterial(new CANNON_.ContactMaterial(matBall, matFret, { friction: 0.3, restitution: 0.1 }));
    world.addContactMaterial(new CANNON_.ContactMaterial(matBall, matFloor, { friction: 0.4, restitution: 0.05 }));

    // Bowl slope: a RING OF FLAT PLANKS (proven to actually slide a resting sphere -- see the
    // file-header note on why a single CANNON.Cylinder does not, in this cannon.js build).
    const SEGS = 48;
    const slopeAngle = Math.atan2(ORBIT_Y - POCKET_Y, ORBIT_R - POCKET_R);
    const midR = (ORBIT_R + POCKET_R) / 2, midY = (ORBIT_Y + POCKET_Y) / 2;
    const slopeLen = Math.hypot(ORBIT_R - POCKET_R, ORBIT_Y - POCKET_Y);
    const arcLen = (2 * Math.PI * midR / SEGS) * 1.4; // slight overlap so there are no gaps
    for (let i = 0; i < SEGS; i++) {
      const a = i * (2 * Math.PI / SEGS);
      const body = new CANNON_.Body({ mass: 0, material: matBowl });
      body.addShape(new CANNON_.Box(new CANNON_.Vec3(arcLen / 2, 0.02, slopeLen / 2)));
      body.position.set(Math.sin(a) * midR, midY, Math.cos(a) * midR);
      const qYaw = new CANNON_.Quaternion(); qYaw.setFromAxisAngle(new CANNON_.Vec3(0, 1, 0), a);
      const qTilt = new CANNON_.Quaternion(); qTilt.setFromAxisAngle(new CANNON_.Vec3(1, 0, 0), -slopeAngle);
      body.quaternion = qYaw.mult(qTilt);
      world.addBody(body);
    }

    // Outer wall: ring of flat boxes, the exact same proven pattern as cloche-dice.js's glass
    // walls -- pulled back from the bowl's rim (not flush) so the ball isn't wedged in a
    // mechanical corner between wall and slope regardless of speed (an earlier attempt had
    // exactly that bug: the ball got stuck at the rim permanently, at ANY speed, because the
    // wall and slope geometries overlapped there).
    const WALL_R = ORBIT_R + 0.12;
    const wallSegs = 32;
    for (let i = 0; i < wallSegs; i++) {
      const a = (i / wallSegs) * Math.PI * 2;
      const body = new CANNON_.Body({ mass: 0, material: matWall });
      const segLen = (2 * Math.PI * WALL_R / wallSegs) * 1.3;
      body.addShape(new CANNON_.Box(new CANNON_.Vec3(segLen / 2, 0.2, 0.05)));
      body.position.set(Math.sin(a) * WALL_R, ORBIT_Y + 0.1, Math.cos(a) * WALL_R);
      body.quaternion.setFromAxisAngle(new CANNON_.Vec3(0, 1, 0), a);
      world.addBody(body);
    }

    // Inner curb: a ring of flat boxes well inside the frets' inner edge (frets sit at POCKET_R
    // with radial half-depth POCKET_R*0.11, so their inner edge is ~POCKET_R*0.89). Without this,
    // a ball that takes a bad-angle bounce off a fret can occasionally get kicked radially inward
    // past the fret ring entirely, into the open center hub where NOTHING touches it anymore --
    // it just glides to a dead, motionless stop, disconnected from the wheel forever (confirmed:
    // every spin ended at the identical resting radius with zero angular velocity once this was
    // missing). Real wheels have a raised center cone for exactly this reason.
    const CURB_R = POCKET_R * 0.75;
    const curbSegs = 24;
    for (let i = 0; i < curbSegs; i++) {
      const a = (i / curbSegs) * Math.PI * 2;
      const body = new CANNON_.Body({ mass: 0, material: matWall });
      const segLen = (2 * Math.PI * CURB_R / curbSegs) * 1.3;
      body.addShape(new CANNON_.Box(new CANNON_.Vec3(segLen / 2, 0.2, 0.05)));
      body.position.set(Math.sin(a) * CURB_R, POCKET_Y + 0.1, Math.cos(a) * CURB_R);
      body.quaternion.setFromAxisAngle(new CANNON_.Vec3(0, 1, 0), a);
      world.addBody(body);
    }

    // Flat pocket floor beneath the fret ring.
    const floor = new CANNON_.Body({ mass: 0, material: matFloor });
    floor.addShape(new CANNON_.Plane());
    floor.quaternion.setFromAxisAngle(new CANNON_.Vec3(1, 0, 0), -Math.PI / 2);
    floor.position.set(0, POCKET_Y, 0);
    world.addBody(floor);

    // Fret ring: one KINEMATIC compound body (N box dividers). Kinematic bodies aren't moved by
    // forces -- we set its quaternion directly from the deterministic wheel angle every step
    // (see resolveStep/tickIdleWheel) and also set angularVelocity so contact impulse response
    // against the dynamic ball uses the correct relative velocity.
    fretBody = new CANNON_.Body({ mass: 0, type: CANNON_.Body.KINEMATIC, material: matFret });
    for (let i = 0; i < N; i++) {
      const a = i * SLOT_ANGLE;
      const shape = new CANNON_.Box(new CANNON_.Vec3(0.006, 0.05, POCKET_R * 0.11));
      const offset = new CANNON_.Vec3(Math.sin(a) * POCKET_R, 0.05, Math.cos(a) * POCKET_R);
      const q = new CANNON_.Quaternion(); q.setFromAxisAngle(new CANNON_.Vec3(0, 1, 0), a);
      fretBody.addShape(shape, offset, q);
    }
    world.addBody(fretBody);

    ballBody = new CANNON_.Body({ mass: 0.02, material: matBall });
    ballBody.addShape(new CANNON_.Sphere(CFG.ballRadius));
    ballBody.linearDamping = 0.08;
    ballBody.angularDamping = 0.3;
    world.addBody(ballBody);
  }

  function ballWorldPos() {
    ballMesh.position.copy(ballBody.position);
    ballMesh.quaternion.copy(ballBody.quaternion);
  }
  function setFretAngle(angle) {
    fretBody.quaternion.setFromAxisAngle(new CANNON_.Vec3(0, 1, 0), angle);
    fretBody.angularVelocity.set(0, WHEEL_SPEED, 0);
  }
  // The ball's actual instantaneous angular velocity around the wheel's own axis, computed from
  // its real position+velocity (not by differencing angle samples, which is fragile across the
  // +/-pi wraparound) -- tangential direction at angle a=atan2(x,z) is (cos a, -sin a) given this
  // module's x=sin(a)*r, z=cos(a)*r convention.
  function ballAngularVelocity() {
    const x = ballBody.position.x, z = ballBody.position.z;
    const r = Math.hypot(x, z);
    if (r < 0.05) return WHEEL_SPEED;
    const a = Math.atan2(x, z);
    const tangential = ballBody.velocity.x * Math.cos(a) - ballBody.velocity.z * Math.sin(a);
    return tangential / r;
  }

  // ---------- deterministic resolve ----------
  // Runs the ball's ENTIRE real-physics throw from `baseline` (position/velocity at the exact
  // moment the true spin begins) forward, one fixed STEP at a time. cannon.js stepping is
  // bit-for-bit deterministic given identical initial body state and timestep sequence (verified
  // empirically: two independent runs from the same baseline produce the same final position to
  // 6 decimal places) -- so unlike the dice (which inject seeded per-step randomness and need a
  // seed to replay identically), this needs no seed at all: presimulate() runs once, and the live
  // replay from the same baseline reproduces it exactly.
  function resetToBaseline(baseline) {
    ballBody.position.set(Math.sin(baseline.ballAngle) * ORBIT_R, ORBIT_Y + 0.2, Math.cos(baseline.ballAngle) * ORBIT_R);
    // baseline.ballAngVel is an ANGULAR velocity (rad/s); linear speed for circular motion at
    // radius ORBIT_R is angVel*ORBIT_R, not angVel itself -- an earlier version of this line
    // dropped that radius factor, understating the throw's actual linear speed by ~1.47x.
    const linSpeed = baseline.ballAngVel * ORBIT_R;
    ballBody.velocity.set(Math.cos(baseline.ballAngle) * linSpeed, 0, -Math.sin(baseline.ballAngle) * linSpeed);
    ballBody.angularVelocity.set(0, 0, 0);
    ballBody.quaternion.set(0, 0, 0, 1);
    setFretAngle(baseline.wheelAngle);
  }
  // Periodic fret disturbances can occasionally kick relative speed back up even once the ball
  // is basically riding along, resetting a long hold streak before it ever completes -- SETTLE_EPS
  // is loose enough, and SETTLE_HOLD short enough, that a genuinely-riding ball reliably finds a
  // qualifying window without waiting for a suspiciously perfect calm stretch. HARD_STEP_CAP is a
  // backstop: if the ball is unlucky enough to never satisfy the hold in reasonable time, force a
  // stop rather than risk an unbounded spin (the same lesson learned earlier building this
  // module's predecessor: an asymptotic settle condition with no cap can occasionally run for a
  // very long, unpredictable tail).
  const SETTLE_EPS = 0.7, SETTLE_HOLD = 60, HARD_STEP_CAP = 3600; // ~30s hard ceiling
  function makeResolveCtx(baseline) { return { baseline, step: 0, done: false, hold: 0, lastTickSlot: null }; }
  function resolveStep(ctx) {
    const wheelAngle = ctx.baseline.wheelAngle + WHEEL_SPEED * STEP * ctx.step;
    setFretAngle(wheelAngle);
    world.step(STEP);
    ctx.step++;
    if (ctx.step >= HARD_STEP_CAP) { ctx.done = true; return; }

    // Tick sound on every fret crossing (purely cosmetic; uses the ball's real position, not a
    // scripted timer).
    const r = Math.hypot(ballBody.position.x, ballBody.position.z);
    if (r < POCKET_R + 0.05) {
      const relAngle = Math.atan2(ballBody.position.x, ballBody.position.z) - wheelAngle;
      const slotNow = Math.floor(((relAngle % (Math.PI * 2)) + Math.PI * 2 * 4) / SLOT_ANGLE) % N;
      if (slotNow !== ctx.lastTickSlot) {
        ctx.lastTickSlot = slotNow;
        const relSpeed = Math.abs(ballAngularVelocity() - WHEEL_SPEED);
        if (ctx.onTick) ctx.onTick(Math.min(1, relSpeed / 3));
      }
    }

    const settled = r < POCKET_R + 0.05 && Math.abs(ballAngularVelocity() - WHEEL_SPEED) < SETTLE_EPS;
    if (settled) { ctx.hold++; if (ctx.hold >= SETTLE_HOLD) ctx.done = true; }
    else ctx.hold = 0;

    // SETTLE_EPS is loose enough that "done" can fire while the ball still has real residual
    // motion relative to the wheel -- left alone, it would keep drifting across pockets for a
    // while after this instant, meaning the slot restingSlot() measures right now would NOT be
    // where it actually ends up moments later. Hard-lock it to the wheel's exact velocity the
    // instant we call it done (same idea as the predecessor formula-based version's "snap to
    // WHEEL_SPEED"), so whatever position it's at becomes truly final, not just "close enough
    // for now".
    if (ctx.done) {
      const bx = ballBody.position.x, bz = ballBody.position.z;
      const a = Math.atan2(bx, bz);
      ballBody.velocity.set(Math.cos(a) * WHEEL_SPEED * r, 0, -Math.sin(a) * WHEEL_SPEED * r);
      ballBody.angularVelocity.set(0, WHEEL_SPEED, 0);
    }
  }
  // Which drawn slot (see drawWheelTexture's `slot` loop variable) the ball is actually sitting
  // over in WORLD space. This is NOT simply floor((ballAngle-wheelAngle)/SLOT_ANGLE) -- that was
  // an original (wrong) assumption, carried over unverified from an even earlier flat-2D canvas
  // wheel. The real rendering pipeline (a canvas angle baked into a CircleGeometry's UVs,
  // flattened via faceMesh.rotation.x=-pi/2, then spun via wheelMesh.rotation.y) produces a
  // REFLECTED and phase-shifted relationship instead, verified by walking THREE's actual
  // CircleGeometry UV attribute values and its real rotation matrices (not assumed from memory):
  // a label drawn at canvas angle theta ends up, after those two rotations, at world
  // (x,z) = R*(sin(theta-beta), -cos(theta-beta)) where beta=wheelAngle -- solving that against
  // (sin(A), cos(A)) gives slot i's ball-angle as A_i = pi + beta - i*SLOT_ANGLE, i.e. slot index
  // = (pi + wheelAngle - ballAngle) / SLOT_ANGLE, not (ballAngle - wheelAngle) / SLOT_ANGLE. Also
  // uses round(), not floor(): a slot's valid window is centered on its label (+/- half a slot),
  // not [i, i+1).
  function restingSlot(wheelAngle) {
    const ballAngle = Math.atan2(ballBody.position.x, ballBody.position.z);
    const rel = ((Math.PI + wheelAngle - ballAngle) % (Math.PI * 2) + Math.PI * 2 * 4) % (Math.PI * 2);
    return Math.round(rel / SLOT_ANGLE) % N;
  }
  function presimulate(baseline) {
    resetToBaseline(baseline);
    const ctx = makeResolveCtx(baseline);
    while (!ctx.done && ctx.step < CFG.maxResolveSteps) resolveStep(ctx);
    if (!ctx.done) return null;
    return restingSlot(baseline.wheelAngle + WHEEL_SPEED * STEP * ctx.step);
  }

  // ---------- orchestration ----------
  let phase = 'idle'; // idle | preroll | resolving | reveal
  let activeResolve = null, activeReject = null, serverPocket = null;
  let livCtx = null, prerollAngle = 0;
  // The wheel's persistent rotation -- advances forever via the same fixed-step clock as the
  // ball's own physics, continuous across every phase (idle/preroll/resolving/reveal). Never
  // reset per spin: a real casino wheel is never stopped between rounds, it just keeps cruising
  // at WHEEL_SPEED. restBallOffset is the settled ball's angle relative to the wheel, so it can
  // keep riding along in its pocket (rather than floating motionless) while the wheel turns
  // under it between spins.
  let idleWheelAngle = 0, restBallOffset = 0;

  // The relabel (rewriting which number is drawn at which slot) must never happen at a moment a
  // player could tie to "the server just told the wheel what to do" -- doing it at the exact
  // instant beginResolve() runs (right as the network response lands) would be a visible tell:
  // the numbers would visibly jump on the wheel face at a moment correlated with a real event
  // the player can perceive (their spin committing). Instead the offset is computed immediately
  // (cheap, silent, touches no pixels) but the actual texture redraw is deferred to a RANDOM
  // step well inside the fast outer-track orbit -- comfortably before the ball can plausibly have
  // reached the pocket ring -- while the wheel and ball are both still spinning fast with no
  // player-visible event anywhere near it to anchor the moment to.
  const RELABEL_STEP_MIN = 90, RELABEL_STEP_MAX = 380;
  let relabelStep = 0, relabeled = false;
  // Camera-zoom window bracketing the relabel step (see applyCameraZoom above): ramp in, hold
  // through the swap, ramp back out. Ball orbits fast here (well before dropStart), so "look at
  // the ball" is itself a natural, unremarkable camera move at this point in the spin, not a
  // jarring cut -- the swap is the thing hiding inside a normal-looking camera beat, not the
  // other way around.
  const ZOOM_RAMP = 24, ZOOM_HOLD = 20; // steps (~0.2s / ~0.17s at 120Hz)
  let zoomWindowStart = 0;

  function beginResolve() {
    const baseline = { wheelAngle: idleWheelAngle, ballAngle: prerollAngle, ballAngVel: PREROLL_BALL_SPEED };
    const slot = presimulate(baseline);
    labelOffset = offsetForSlot(serverPocket, slot === null ? 0 : slot); // slot===null is practically unreachable

    relabelStep = RELABEL_STEP_MIN + Math.floor(Math.random() * (RELABEL_STEP_MAX - RELABEL_STEP_MIN));
    relabeled = false;
    zoomWindowStart = relabelStep - ZOOM_RAMP; // peak zoom (t=1) covers relabelStep itself

    resetToBaseline(baseline);
    livCtx = makeResolveCtx(baseline);
    livCtx.onTick = (strength) => playTick(strength);
    phase = 'resolving';
  }
  // Returns the zoom-in progress (0-1) for the current step: ramps in, holds through the swap,
  // ramps back out. Returns 0 outside the window entirely (normal framing).
  function zoomProgressAt(step) {
    const t = step - zoomWindowStart;
    const total = ZOOM_RAMP + ZOOM_HOLD + ZOOM_RAMP;
    if (t < 0 || t > total) return 0;
    if (t < ZOOM_RAMP) return t / ZOOM_RAMP;
    if (t < ZOOM_RAMP + ZOOM_HOLD) return 1;
    return 1 - (t - ZOOM_RAMP - ZOOM_HOLD) / ZOOM_RAMP;
  }

  function finishResolve() {
    const wheelAngle = livCtx.baseline.wheelAngle + WHEEL_SPEED * STEP * livCtx.step;
    const finalSlot = restingSlot(wheelAngle);
    const displayedPocket = WHEEL_ORDER[(finalSlot - labelOffset + N * 4) % N];
    if (!relabeled || displayedPocket !== serverPocket) {
      // Either the deferred relabel above somehow never fired (shouldn't happen --
      // RELABEL_STEP_MAX is always well before the ball can reach the pocket ring) or the live
      // replay drifted from the pre-sim; repair by relabeling now, exactly like
      // ClocheDice.finishResolve()'s verify-and-repair step. This late relabel IS visible if it
      // ever triggers, but the confirmed-deterministic replay means it provably never should.
      labelOffset = offsetForSlot(serverPocket, finalSlot);
      drawWheelTexture();
    }
    // Hand off the wheel's rotation to the persistent idle tracker exactly where the resolve
    // left it -- and remember the ball's settled offset from it -- so the wheel keeps turning
    // seamlessly (no jump) and the ball visibly rides along in its pocket until the next spin
    // picks it back up, instead of floating motionless while the wheel turns under it.
    idleWheelAngle = wheelAngle;
    const ballAngle = Math.atan2(ballBody.position.x, ballBody.position.z);
    restBallOffset = ballAngle - wheelAngle;

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
      wheelMesh.rotation.y = livCtx.baseline.wheelAngle + WHEEL_SPEED * STEP * livCtx.step;
      ballWorldPos();
      // Zoom progress is a pure function of step, so it's automatically back to 0 (normal
      // framing) once the window passes -- no separate "reset" needed, calling this every frame
      // is enough.
      applyCameraZoom(zoomProgressAt(livCtx.step), ballBody.position.x, ballBody.position.z);
    } else {
      // idle / preroll / reveal: the wheel never stops -- it keeps cruising at the same
      // constant, readable WHEEL_SPEED a real casino wheel coasts at between throws, driven by
      // the same fixed-step clock (not raw wall-clock dt) as the resolve simulation so there's
      // no seam when a spin picks the wheel angle back up as its baseline.
      applyCameraZoom(0, 0, 0); // always normal framing outside the resolving phase's zoom window
      const debt = Math.min(dt / STEP, 6);
      for (let i = 0; i < debt; i++) idleWheelAngle += WHEEL_SPEED * STEP;
      wheelMesh.rotation.y = idleWheelAngle;
      if (phase === 'preroll') {
        // The ball gets picked up and thrown fast against the steadily-turning wheel -- only the
        // ball's preroll agitation is wall-clock driven (its duration is however long the
        // network takes, unlike the wheel's fixed cruise); it isn't real physics yet, that only
        // starts the instant beginResolve() throws it for real.
        prerollAngle += PREROLL_BALL_SPEED * dt;
        ballMesh.position.set(Math.sin(prerollAngle) * ORBIT_R, ORBIT_Y, Math.cos(prerollAngle) * ORBIT_R);
        ballMesh.quaternion.set(0, 0, 0, 1);
      } else {
        // idle / reveal: the ball rests in its pocket, riding along with the wheel rather than
        // floating still while the wheel turns underneath it.
        const a = idleWheelAngle + restBallOffset;
        ballMesh.position.set(Math.sin(a) * POCKET_R, POCKET_Y, Math.cos(a) * POCKET_R);
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
