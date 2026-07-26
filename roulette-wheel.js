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
  let pocketsPhotoImg; // real-photo pocket ring, drawn (and rotated for relabeling) onto wheelCanvas -- see drawWheelTexture
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
  // wheel-pockets-photo.jpg is a real photo of the pocket ring, cropped square (center on the
  // wheel, radius out to just past the last pocket, no gold trim/rim in frame) with pocket '0'
  // centered at the top -- i.e. it already matches this file's own labelOffset=0 layout exactly,
  // since WHEEL_ORDER is the real American wheel sequence the photo itself was shot in.
  function buildWheelTexture() {
    const size = 1536; // higher-res than an earlier 1024 -- the wheel renders large enough on
                        // screen (see #wheel-wrap in roulette.html) that labels need more source
                        // pixels to stay crisp instead of blurry.
    wheelCanvas = document.createElement('canvas');
    wheelCanvas.width = size; wheelCanvas.height = size;
    wheelCtx = wheelCanvas.getContext('2d');
    wheelTexture = new THREE_.CanvasTexture(wheelCanvas);
    pocketsPhotoImg = new Image();
    pocketsPhotoImg.onload = drawWheelTexture; // first draw is likely still loading synchronously here
    pocketsPhotoImg.src = 'wheel-pockets-photo.jpg';
    drawWheelTexture();
  }
  // Relabeling used to redraw each pocket's color+number individually (the "which number is
  // physically where" trick); with a real photo standing in for the whole ring at once, the same
  // trick becomes ONE rigid rotation of that single image -- every pocket needs the identical
  // angular shift (labelOffset slots), since the photo's native layout already matches
  // WHEEL_ORDER's slot 0..37 positions one-for-one. Verified algebraically: the old per-slot rule
  // "slot s shows WHEEL_ORDER[(s-labelOffset)%N]" means a pocket native to slot i is drawn at slot
  // i+labelOffset for every i -- a uniform rotation, not a per-slot remap.
  function drawWheelTexture() {
    const ctx = wheelCtx, size = wheelCanvas.width, cx = size / 2, cy = size / 2;
    ctx.clearRect(0, 0, size, size);
    if (pocketsPhotoImg && pocketsPhotoImg.complete && pocketsPhotoImg.naturalWidth) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(labelOffset * SLOT_ANGLE);
      ctx.drawImage(pocketsPhotoImg, -cx, -cy, size, size);
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
    // Real-photo wood, used whole rather than a small tiled swatch (a small repeating crop looked
    // cheap and, worse, wasn't actually usable at all on these curved surfaces -- a top-down photo
    // doesn't wrap onto a CylinderGeometry side via its default (angle, height) UV without visible
    // distortion, since that UV expects an "unrolled around the surface" image, not a plan view).
    // wheel-cone-unwrap.jpg / wheel-rim-unwrap.jpg are real POLAR unwraps of the photo (each
    // destination pixel (angle, radius) sampled straight from the source photo around the wheel's
    // true center) -- confirmed seamless left-to-right by inspection before use. wheel-rim-full.jpg
    // is the plain square crop (same "circle inscribed in a square" convention as the numbered
    // face below) for the flat rim-top ring, whose UV is a square projection, not angle/height.
    // All three carry the photo's own baked directional lighting, which is exactly why every mesh
    // wearing one is attached directly to the scene, never to the spinning wheelMesh group.
    const woodLoader = new THREE_.TextureLoader();
    const rimFullTex = woodLoader.load('wheel-rim-full.jpg');
    const rimUnwrapTex = woodLoader.load('wheel-rim-unwrap.jpg');
    rimUnwrapTex.wrapS = THREE_.RepeatWrapping; // seamless around the full circumference
    const coneUnwrapTex = woodLoader.load('wheel-cone-unwrap.jpg');
    coneUnwrapTex.wrapS = THREE_.RepeatWrapping;

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

    // Center hub: real wheels rise into a cone from inside the numbered band up to a small brass
    // turret -- the flat CircleGeometry face alone read as far cheaper/flatter than a real wheel.
    // CylinderGeometry with a small (not zero) top radius gives a flat plateau instead of a
    // single-vertex apex, which shades badly and doesn't match the real turret's flat top anyway.
    // Base radius is kept well inside the label radius (r*0.8 in drawWheelTexture) so the cone
    // never covers any numbers, only the plain colored wedges near the center.
    // Added directly to the SCENE, not wheelMesh -- unlike the numbered ring, the cone wears the
    // photographed wood texture above, so (per the same reasoning as the outer bowl) it must stay
    // static rather than spin with the wheelhead.
    const CONE_BASE_R = CFG.wheelRadius * 0.62, CONE_TOP_R = CFG.wheelRadius * 0.05, CONE_H = CFG.wheelRadius * 0.34;
    const coneGeo = new THREE_.CylinderGeometry(CONE_TOP_R, CONE_BASE_R, CONE_H, 48);
    const coneMesh = new THREE_.Mesh(coneGeo, new THREE_.MeshStandardMaterial({ map: coneUnwrapTex, roughness: 0.35 }));
    coneMesh.position.y = faceMesh.position.y + CONE_H / 2 + 0.001;
    scene.add(coneMesh);
    // Small brass turret cap on the cone's flat top -- stays with the (now static) cone.
    const capGeo = new THREE_.SphereGeometry(CONE_TOP_R * 1.6, 16, 16);
    const capMesh = new THREE_.Mesh(capGeo, new THREE_.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.7, roughness: 0.3 }));
    capMesh.position.y = coneMesh.position.y + CONE_H / 2 + CONE_TOP_R * 0.5;
    scene.add(capMesh);

    // Higher segment count than the old 20/20 -- a chrome ball's tight specular highlight shows
    // faceting on a coarse sphere much more readily than the old matte-ish look did.
    const ballGeo = new THREE_.SphereGeometry(CFG.ballRadius, 32, 32);
    const ballMat = new THREE_.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.05 });
    ballMesh = new THREE_.Mesh(ballGeo, ballMat);
    scene.add(ballMesh);

    // Visible outer bowl: a static (NON-spinning -- on a real table only the wheelhead rotates,
    // the surrounding bowl doesn't, and the physics wall is static too, so visual and physics
    // agree) wooden ring past the wheel's edge. Inner face sits exactly at the physics wall's
    // inner radius (WALL_INNER_R) so the ball visibly bounces off actual wood instead of thin
    // air at the disc's edge, which is how it looked before this existed.
    const bowlWallMat = new THREE_.MeshStandardMaterial({ map: rimUnwrapTex, roughness: 0.7, side: THREE_.DoubleSide });
    const bowlTopMat = new THREE_.MeshStandardMaterial({ map: rimFullTex, roughness: 0.6, side: THREE_.DoubleSide });
    const wallFaceGeo = new THREE_.CylinderGeometry(WALL_INNER_R, WALL_INNER_R, BOWL_VIS_TOP_Y, 64, 1, true);
    const wallFace = new THREE_.Mesh(wallFaceGeo, bowlWallMat);
    wallFace.position.y = BOWL_VIS_TOP_Y / 2;
    scene.add(wallFace);
    const bowlRingGeo = new THREE_.RingGeometry(WALL_INNER_R, BOWL_OUTER_R, 64);
    const bowlRing = new THREE_.Mesh(bowlRingGeo, bowlTopMat);
    bowlRing.rotation.x = -Math.PI / 2;
    bowlRing.position.y = BOWL_VIS_TOP_Y;
    scene.add(bowlRing);
    const bowlSkirtGeo = new THREE_.CylinderGeometry(BOWL_OUTER_R, BOWL_OUTER_R, BOWL_VIS_TOP_Y + 0.06, 64, 1, true);
    const bowlSkirt = new THREE_.Mesh(bowlSkirtGeo, bowlWallMat);
    bowlSkirt.position.y = (BOWL_VIS_TOP_Y + 0.06) / 2 - 0.06;
    scene.add(bowlSkirt);

    // Marker floats above the bowl rim (raised so the bowl ring doesn't swallow it).
    const ptrGeo = new THREE_.ConeGeometry(0.05, 0.16, 12);
    pointerMesh = new THREE_.Mesh(ptrGeo, new THREE_.MeshStandardMaterial({ color: 0xffd700 }));
    pointerMesh.position.set(0, BOWL_VIS_TOP_Y + 0.14, -(WALL_INNER_R + BOWL_OUTER_R) / 2);
    pointerMesh.rotation.x = Math.PI;
    scene.add(pointerMesh);

    buildPhysicsWorld();
    buildOverlay();

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
    // Frame out to the visible bowl's outer edge (WALL_INNER_R + 0.22 ~= 1.81) plus margin --
    // was wheelRadius*1.15 when the disc edge was the outermost visible thing.
    const extentX = CFG.wheelRadius * 1.19;
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
  // Settle camera-zoom: a second, gentler punch-in for the END of the spin -- once the ball has
  // dropped into the pocket ring, the camera tightens on the whole wheel (centered, no pan) so
  // the final fret-bounces read close-up, and holds there through the reveal before easing back
  // out in idle. SETTLE_SCALE is the tightest framing that still keeps the entire pocket ring
  // (POCKET_R ~1.39 + ball) in frame no matter where around the ring the ball is -- tighter than
  // this and the ball itself can leave the frame on the far side, which defeats the point.
  const SETTLE_SCALE = 0.7;
  let settleZoom = 0; // smoothed 0..1, eased every frame toward its target (see loop)
  // Spielberg dolly: a continuous, barely-perceptible push-in across the whole spin (1.0 down
  // to 0.86 over the first ~12s) -- the audience shouldn't consciously notice the frame
  // tightening, just feel the tension build. Composed under the two explicit zooms below.
  const DOLLY_END_SCALE = 0.86, DOLLY_STEPS = 1440;
  function dollyScaleAt(step) {
    return 1 - Math.min(step / DOLLY_STEPS, 1) * (1 - DOLLY_END_SCALE);
  }
  function applyCameraZoom(t, ballX, ballZ, step) {
    // t: 0 = normal framing, 1 = fully punched in on the ball. Same ease both directions so the
    // move reads as one continuous camera motion, not a hard cut in either direction.
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    // The two zooms never meaningfully overlap in time (relabel is early in the orbit phase,
    // settle only starts once the ball is down among the frets), but compose them anyway:
    // whichever wants the tighter frame wins the scale, and only the relabel zoom pans. The slow
    // dolly rides underneath both as the resting frame.
    const relabelScale = 1 - eased * (1 - ZOOM_SCALE);
    const settleScale = 1 - settleZoom * (1 - SETTLE_SCALE);
    const scale = Math.min(step === undefined ? 1 : dollyScaleAt(step), relabelScale, settleScale);
    const extentY = baseExtentY * scale;
    const aspect = lastAspect;
    if (aspect >= 1) { camera.top = extentY; camera.bottom = -extentY; camera.left = -extentY * aspect; camera.right = extentY * aspect; }
    else { camera.left = -extentY; camera.right = extentY; camera.top = extentY / aspect; camera.bottom = -extentY / aspect; }
    const panX = ballX * eased, panZ = ballZ * eased;
    camera.position.set(panX, 8, panZ + 6);
    camera.lookAt(panX, 0, panZ);
    camera.updateProjectionMatrix();
  }
  // Ease settleZoom toward `target` (0 or 1) with a per-frame exponential glide -- dt-scaled so
  // the ease speed doesn't depend on display refresh rate. Push-in closes most of the gap in
  // ~1.5s (deliberate, not a snap); pull-back is slower still (~3s) so the camera lingers on the
  // settled ball through the reveal (the reveal phase itself is only 350ms -- the lingering
  // comes from this slow ease, not from holding a phase open, so payouts aren't delayed).
  function easeSettleZoom(target, dt) {
    const rate = target > settleZoom ? 2.2 : 1.1;
    settleZoom += (target - settleZoom) * Math.min(1, dt * rate);
    if (Math.abs(settleZoom - target) < 0.002) settleZoom = target;
  }
  function onResize() {
    if (!renderer) return;
    let w, h;
    if (overlayOpen) {
      w = window.innerWidth || 800; h = window.innerHeight || 600;
    } else {
      const container = typeof CFG.container === 'string' ? document.getElementById(CFG.container) : CFG.container;
      if (!container) return;
      w = container.clientWidth || 200; h = container.clientHeight || 200;
    }
    renderer.setSize(w, h);
    if (showcaseOpen) fitShowcaseFrustum(w, h); else fitCameraFrustum(w, h);
  }
  // Straight top-down framing for the "show wheel" showcase (see openShowcase below) -- no
  // TILT_COS compensation needed since there's no tilt to correct for, unlike fitCameraFrustum.
  function fitShowcaseFrustum(w, h) {
    const extentX = CFG.wheelRadius * 1.19; // same margin as the normal tilted framing
    const aspect = w / h;
    if (aspect >= 1) { camera.top = extentX; camera.bottom = -extentX; camera.left = -extentX * aspect; camera.right = extentX * aspect; }
    else { camera.left = -extentX; camera.right = extentX; camera.top = extentX / aspect; camera.bottom = -extentX / aspect; }
    // z=0.001, not 0: looking perfectly straight down with up=(0,1,0) is a degenerate lookAt
    // (the camera's right-vector cross product collapses to zero) -- confirmed the same fix
    // was needed for the same reason elsewhere in this file's camera code.
    camera.position.set(0, 10, 0.001);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }

  // ---------- fullscreen spin overlay ----------
  // During a spin the wheel takes over the whole viewport, exactly like the dice cloche does for
  // a roll -- the rest of the table doesn't matter mid-spin, and a fullscreen wheel gives the
  // camera choreography (dolly + relabel punch-in + settle close-up) room to actually play as
  // drama instead of shuffling inside a 200px corner box. The SAME canvas/renderer is reparented
  // into the overlay and back out (the family's "reuse by reparenting" convention) -- never a
  // second renderer. z-index 150: above the table, below the winner modal (200), so the coin
  // waterfall plays over the tight final wheel shot, and below the cashout voucher (300).
  let overlayEl = null, overlayOpen = false, overlayCloseTimer = null;
  // Manual "show wheel" showcase: a full-screen, straight-down, frozen (no spin, no ball) look at
  // the layout, entirely separate from the spin overlay's own state machine -- it reuses the same
  // fullscreen div/canvas-reparent plumbing but never runs while a real spin is in progress.
  let showcaseOpen = false, showcaseCloseBtn = null;
  function buildOverlay() {
    overlayEl = document.createElement('div');
    overlayEl.id = 'rw-spin-overlay';
    overlayEl.style.cssText = 'position:fixed;inset:0;z-index:150;background:rgba(3,10,7,.94);' +
      'display:none;opacity:0;transition:opacity .3s ease;';
    document.body.appendChild(overlayEl);

    // Only the showcase gets a close control -- closing mid-spin makes no sense (it closes
    // itself on resolve), but the showcase has no other exit since it isn't tied to any game event.
    showcaseCloseBtn = document.createElement('button');
    showcaseCloseBtn.textContent = '✕ Close';
    showcaseCloseBtn.style.cssText = 'position:absolute;top:16px;right:16px;z-index:151;' +
      'background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.3);border-radius:6px;' +
      'color:#fff;font-size:16px;padding:8px 14px;cursor:pointer;display:none';
    showcaseCloseBtn.onclick = () => RouletteWheel.hideWheel();
    overlayEl.appendChild(showcaseCloseBtn);
  }
  function openOverlay() {
    clearTimeout(overlayCloseTimer);
    if (overlayOpen) {
      // Re-opened mid-close (next spin started during the linger/fade): cancel the pending
      // close and restore full visibility -- without this the overlay stays faded-out but
      // display:block, an invisible wheel for the whole next spin.
      overlayEl.style.display = 'block';
      overlayEl.style.opacity = '1';
      return;
    }
    overlayOpen = true;
    overlayEl.style.display = 'block';
    overlayEl.appendChild(canvasEl);
    onResize();
    // Next frame so the display:none -> block transition actually animates the fade.
    requestAnimationFrame(() => { overlayEl.style.opacity = '1'; });
  }
  function closeOverlay() {
    if (!overlayOpen) return;
    overlayEl.style.opacity = '0';
    overlayCloseTimer = setTimeout(() => {
      overlayOpen = false;
      overlayEl.style.display = 'none';
      const container = typeof CFG.container === 'string' ? document.getElementById(CFG.container) : CFG.container;
      if (container) container.appendChild(canvasEl);
      // Snap the settle zoom off during the reparent -- nobody can perceive a camera cut across
      // a DOM move, and it beats the corner wheel visibly un-zooming for 3 seconds.
      settleZoom = 0;
      onResize();
    }, 320);
  }
  function openShowcase() {
    if (phase !== 'idle' || showcaseOpen) return;
    showcaseOpen = true; // must be set before openOverlay() so its onResize() picks the top-down framing
    ballMesh.visible = false;
    showcaseCloseBtn.style.display = 'block';
    openOverlay();
  }
  function closeShowcase() {
    if (!showcaseOpen) return;
    showcaseOpen = false;
    ballMesh.visible = true;
    showcaseCloseBtn.style.display = 'none';
    closeOverlay();
  }

  // ---------- real rigid-body physics world (cannon.js) ----------
  // POCKET_R must sit OUTSIDE the label radius (r*0.8 in drawWheelTexture, i.e. ~0.8*wheelRadius
  // in world units) so the ball settles past the numbers toward the rim, matching a real wheel
  // (the pocket ring is the outermost moving part -- the ball never rests hub-side of the digits).
  const ORBIT_R = CFG.wheelRadius * 0.92, POCKET_R = CFG.wheelRadius * 0.87;
  const ORBIT_Y = 0.16, POCKET_Y = 0.09;
  // Shared by the physics wall (buildPhysicsWorld) and the visible bowl meshes (buildScene) so
  // the ball always bounces exactly where the wood appears to be -- one constant, no drift.
  const WALL_INNER_R = ORBIT_R + 0.12;
  const BOWL_OUTER_R = WALL_INNER_R + 0.22; // visible bowl ring's outer edge
  const BOWL_VIS_TOP_Y = 0.42; // visible bowl rim height -- covers everything the ball visibly does
  // The wheel never stops or resets between spins -- like a real casino table, it just cruises
  // at one constant, readable speed forever (continuous across idle/preroll/resolving/reveal,
  // see idleWheelAngle and loop()). ~1 revolution every 3.9s.
  const WHEEL_SPEED = 1.6;
  const PREROLL_BALL_SPEED = -15; // rad/s the ball is thrown at against the wheel's own rotation

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
    world.addContactMaterial(new CANNON_.ContactMaterial(matBall, matBowl, { friction: 0.015, restitution: 0.2 }));
    world.addContactMaterial(new CANNON_.ContactMaterial(matBall, matWall, { friction: 0.004, restitution: 0.5 }));
    world.addContactMaterial(new CANNON_.ContactMaterial(matBall, matFret, { friction: 0.25, restitution: 0.25 }));
    world.addContactMaterial(new CANNON_.ContactMaterial(matBall, matFloor, { friction: 0.4, restitution: 0.05 }));

    // Bowl slope: a RING OF FLAT PLANKS (proven to actually slide a resting sphere -- see the
    // file-header note on why a single CANNON.Cylinder does not, in this cannon.js build).
    // The planks extend OUTWARD past ORBIT_R to beyond the wall's inner face (SLOPE_EXT_R,
    // continuing the same incline) so the bowl surface runs continuously under the wall with no
    // gap at the seam. When the thick wall's inner face moved outward, the old planks (ending
    // exactly at ORBIT_R) left a 0.12 radial gap at the corner -- wider than the ball's 0.09
    // radius -- and the ball wedged into that V-groove and rode it forever, never dropping
    // (the same corner-trap class of bug hit once before at this exact seam).
    const SEGS = 48;
    const SLOPE_EXT_R = ORBIT_R + 0.25; // safely past the wall's inner face (ORBIT_R + 0.12)
    const slopeAngle = Math.atan2(ORBIT_Y - POCKET_Y, ORBIT_R - POCKET_R);
    const SLOPE_EXT_Y = POCKET_Y + (SLOPE_EXT_R - POCKET_R) * Math.tan(slopeAngle); // same incline, extended
    const midR = (SLOPE_EXT_R + POCKET_R) / 2, midY = (SLOPE_EXT_Y + POCKET_Y) / 2;
    const slopeLen = Math.hypot(SLOPE_EXT_R - POCKET_R, SLOPE_EXT_Y - POCKET_Y);
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
    const WALL_R = WALL_INNER_R; // shared with the visible bowl meshes -- see its definition
    const wallSegs = 32;
    for (let i = 0; i < wallSegs; i++) {
      const a = (i / wallSegs) * Math.PI * 2;
      const body = new CANNON_.Body({ mass: 0, material: matWall });
      const segLen = (2 * Math.PI * WALL_R / wallSegs) * 1.3;
      // Tall AND thick wall. Tall (half-height 0.6, top ~1.1): a fast throw presses the ball
      // hard into the wall and it can ride UP the face -- with a 0.4-high wall the ball escaped
      // clean over the top (measured: radius grew to 64). Thick (half-thickness 0.35): at the
      // real throw speed (~22 m/s) the ball travels ~0.18 units per 1/120s step, MORE than a
      // thin wall's total thickness, so it could tunnel straight through between steps
      // (measured: escaped within 1s of the throw at r=5+). Box center is pushed outward by
      // the half-thickness so the INNER face stays at WALL_R regardless of thickness.
      body.addShape(new CANNON_.Box(new CANNON_.Vec3(segLen / 2, 0.6, 0.35)));
      body.position.set(Math.sin(a) * (WALL_R + 0.35), ORBIT_Y + 0.5, Math.cos(a) * (WALL_R + 0.35));
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
    // Damping is the master pacing dial, and it is NONLINEAR -- lowering it does not simply
    // lengthen the spin. Measured on this exact geometry: 0.012/0.05 -> ~14s total;
    // 0.008/0.028 -> ~20-23s; 0.007/0.024 -> ~17-20s (SHORTER -- retained ball spin changes how
    // it rolls through the descent); 0.009/0.035 with a geometry bug -> stuck forever. Re-measure
    // across several spins after ANY change here; do not extrapolate from one sample.
    ballBody.linearDamping = 0.008;
    ballBody.angularDamping = 0.028;
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
  // HARD_STEP_CAP: measured spins run ~19.5-23.4s (2340-2810 steps) with natural variance, so
  // 45s gives comfortable headroom for outlier throws without ever risking an unbounded spin.
  const SETTLE_EPS = 0.7, SETTLE_HOLD = 60, HARD_STEP_CAP = 5400;
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
  // Window sits inside the ~11s outer-track orbit with room for the full camera beat: earliest
  // window start is RELABEL_STEP_MIN - ZOOM_RAMP = 150 steps (must stay >= 0 or the spin begins
  // mid-zoom, a visible pop), and the latest window end is RELABEL_STEP_MAX + ZOOM_HOLD +
  // ZOOM_RAMP = ~1140 steps (~9.5s), still comfortably before the ball leaves the track.
  const RELABEL_STEP_MIN = 300, RELABEL_STEP_MAX = 850;
  let relabelStep = 0, relabeled = false;
  // Camera-zoom window bracketing the relabel step (see applyCameraZoom above): ramp in, hold
  // through the swap, ramp back out. Ball orbits fast here (well before dropStart), so "look at
  // the ball" is itself a natural, unremarkable camera move at this point in the spin, not a
  // jarring cut -- the swap is the thing hiding inside a normal-looking camera beat, not the
  // other way around. Paced as a deliberate, dramatic push (~1.25s in, ~1.2s held, ~1.25s out --
  // a ~3.7s beat total): the first cut of this ran the whole beat in ~0.6s and read as a glitch,
  // not a camera move.
  const ZOOM_RAMP = 150, ZOOM_HOLD = 140; // steps (~1.25s / ~1.17s at 120Hz)
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
    // The fullscreen overlay lingers well past the promise resolution (which stays at 350ms so
    // payouts/log/winner-modal aren't delayed) -- the player gets a beat to read the winning
    // number off the tight final shot before the wheel fades back to its corner. The winner
    // modal (z 200) plays OVER the lingering wheel shot (z 150), which is exactly the drama.
    overlayCloseTimer = setTimeout(closeOverlay, 2600);
  }

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    const dt = Math.min((now - lastTime) / 1000, 1 / 20);
    lastTime = now;
    if (!inited) return;

    if (showcaseOpen) {
      // Full-screen static presentation: wheel frozen at whatever angle it was at, ball hidden,
      // camera locked top-down -- entirely bypasses the idle/preroll/resolving/reveal state
      // machine below rather than trying to make that machine understand a "frozen" phase.
      renderer.render(scene, camera);
      return;
    }

    if (phase === 'resolving') {
      const debt = Math.min(dt / STEP, 6);
      for (let i = 0; i < debt; i++) {
        resolveStep(livCtx);
        if (!relabeled && livCtx.step >= relabelStep) { relabeled = true; drawWheelTexture(); }
        if (livCtx.done) { finishResolve(); break; }
      }
      wheelMesh.rotation.y = livCtx.baseline.wheelAngle + WHEEL_SPEED * STEP * livCtx.step;
      ballWorldPos();
      // Settle zoom pushes in once the ball has genuinely dropped into the pocket ring (real
      // measured radius, not a scripted time) so the final fret-bounces read close-up. The
      // relabel zoom window is long over by then, so the two never fight.
      const ballR = Math.hypot(ballBody.position.x, ballBody.position.z);
      easeSettleZoom(ballR < POCKET_R + 0.08 ? 1 : 0, dt);
      // Relabel-zoom progress is a pure function of step, so it's automatically back to 0
      // (normal framing) once its window passes -- no separate "reset" needed, calling this
      // every frame is enough. `step` drives the slow underlying dolly push-in.
      applyCameraZoom(zoomProgressAt(livCtx.step), ballBody.position.x, ballBody.position.z, livCtx.step);
    } else {
      // idle / preroll / reveal: the wheel never stops -- it keeps cruising at the same
      // constant, readable WHEEL_SPEED a real casino wheel coasts at between throws, driven by
      // the same fixed-step clock (not raw wall-clock dt) as the resolve simulation so there's
      // no seam when a spin picks the wheel angle back up as its baseline.
      // Camera: hold the tight settle framing for as long as the fullscreen overlay is up (the
      // player is reading the winning number off the close-up through the reveal+linger); once
      // the overlay is gone the settle zoom is snapped off during the reparent (see
      // closeOverlay), so no visible un-zoom ever plays in the corner box.
      easeSettleZoom(phase === 'reveal' || (overlayOpen && phase === 'idle') ? 1 : 0, dt);
      applyCameraZoom(0, 0, 0);
      const debt = Math.min(dt / STEP, 6);
      for (let i = 0; i < debt; i++) idleWheelAngle += WHEEL_SPEED * STEP;
      wheelMesh.rotation.y = idleWheelAngle;
      if (phase === 'preroll') {
        // The ball gets picked up and thrown fast against the steadily-turning wheel -- only the
        // ball's preroll agitation is wall-clock driven (its duration is however long the
        // network takes, unlike the wheel's fixed cruise); it isn't real physics yet, that only
        // starts the instant beginResolve() throws it for real.
        prerollAngle += PREROLL_BALL_SPEED * dt;
        // ORBIT_Y/POCKET_Y below are TRACK SURFACE heights (same convention as the real physics
        // floor, see buildPhysicsWorld's `floor.position.set(0, POCKET_Y, 0)`) -- the ball's
        // CENTER when resting on a surface is surface height + its own radius, exactly like
        // ballWorldPos() gets for free from real physics during the resolving phase. This
        // placeholder path is hand-set (no physics running in preroll/idle), so it has to add
        // that radius itself or the ball renders sunk into the surface by one full radius.
        ballMesh.position.set(Math.sin(prerollAngle) * ORBIT_R, ORBIT_Y + CFG.ballRadius, Math.cos(prerollAngle) * ORBIT_R);
        ballMesh.quaternion.set(0, 0, 0, 1);
      } else {
        // idle / reveal: the ball rests in its pocket, riding along with the wheel rather than
        // floating still while the wheel turns underneath it.
        const a = idleWheelAngle + restBallOffset;
        ballMesh.position.set(Math.sin(a) * POCKET_R, POCKET_Y + CFG.ballRadius, Math.cos(a) * POCKET_R);
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
      if (showcaseOpen) closeShowcase(); // a player who left the showcase open shouldn't block spinning
      if (phase !== 'idle') return Promise.reject(new Error('spin in progress'));
      return new Promise((resolve, reject) => {
        activeResolve = resolve; activeReject = reject; serverPocket = null;
        phase = 'preroll';
        openOverlay(); // wheel takes over the screen for the whole spin, like the dice cloche
        Promise.resolve(pocketOrPromise).then(p => {
          const pocket = String(p);
          if (WHEEL_ORDER.indexOf(pocket) === -1) throw new Error('unknown pocket: ' + p);
          serverPocket = pocket;
          beginResolve();
        }).catch(err => {
          phase = 'idle';
          closeOverlay(); // failed spin (network error etc) -- give the table back immediately
          const rej = activeReject; activeResolve = null; activeReject = null;
          if (rej) rej(err);
        });
      });
    },
    isSpinning: () => phase !== 'idle',
    // Full-screen, straight-down, frozen (no ball, no spin) look at the wheel's layout -- purely
    // presentational, no-ops while a real spin is in progress. showWheel() is a no-op if already
    // open; hideWheel() also runs from the in-canvas close button.
    showWheel: () => openShowcase(),
    hideWheel: () => closeShowcase(),
    WHEEL_ORDER,
    colorOf,
  };

  global.RouletteWheel = RouletteWheel;
})(window);
