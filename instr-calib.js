/* Circle-i button calibration tool -- dev-only. instructions.js loads this on demand when a
   page is opened with ?icalib=1; the flag then sticks in sessionStorage so it survives
   navigating between games, since calibrating all of them means walking the whole lobby.

   Same shape as sbCalibExport() in sicbo.html and fpCalibExport() in destroyer.html: drag the
   thing, positions are kept as % of a named container so they hold across screen sizes, and
   the tool writes to localStorage as it goes so a half-finished pass survives a reload. Hit
   Export when done and paste the block into INSTR_POS at the top of instructions.js.

   Every draggable button carries data-icalib="<key>" (what gets stored) and
   data-icalib-box="<selector>" (the container the % is measured against). Buttons sharing a
   key -- the nine lobby tiles -- move together, since they're one CSS rule in practice. */
(function(){

var LS_KEY = 'instrPosOverride';
var active = false, selected = null, layer = null, bar = null;

/* ---- shared position math (kept in sync with applyPos() in instructions.js) ---- */

function boxOf(btn){
  var sel = btn.getAttribute('data-icalib-box');
  if(sel) return btn.closest(sel) || document.querySelector(sel) || document.documentElement;
  return btn.offsetParent || document.documentElement;
}

/* px or pct. The header buttons are a fixed pixel size; the felt paytable buttons are sized
   as a % of the module they sit on so they scale with the baked art, and that has to survive
   a calibration pass. data-icalib-unit sets the starting unit; the toolbar can flip it. */
function unitOf(btn, cur){
  if(cur && cur.unit) return cur.unit;
  return btn.getAttribute('data-icalib-unit') === 'pct' ? 'pct' : 'px';
}

/* The container's PADDING box, in viewport coords. This is what left/top/right/bottom
   percentages actually resolve against -- getBoundingClientRect() is the border box, so
   using it directly puts every drop off by the container's border width (a real 1px skew
   on the lobby tiles, which have a 1px border). */
function boxRect(btn){
  var el = boxOf(btn), r = el.getBoundingClientRect(), cs = getComputedStyle(el);
  return {
    left:   r.left + (parseFloat(cs.borderLeftWidth) || 0),
    top:    r.top  + (parseFloat(cs.borderTopWidth)  || 0),
    width:  el.clientWidth  || r.width,
    height: el.clientHeight || r.height
  };
}

function load(){
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch(e){ return {}; }
}
function save(all){
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch(e){}
}

/* Current on-screen geometry of a button as {anchor,x,y,size}, read back from the live DOM.
   Used to seed a button that has never been calibrated, so dragging starts from where it
   actually sits today rather than snapping to a corner. */
function readGeom(btn, anchor, unit){
  var br = boxRect(btn), r = btn.getBoundingClientRect();
  var u = unit || unitOf(btn);
  var a = anchor || 'tl';
  if(!br.width || !br.height){
    var fb = u === 'pct' ? 8 : (Math.round(r.width) || 26);
    return { anchor:a, x:0, y:0, unit:u, w:fb, h:fb };
  }
  var x = a.charAt(1) === 'l' ? (r.left - br.left) : (br.left + br.width  - r.right);
  var y = a.charAt(0) === 't' ? (r.top  - br.top)  : (br.top  + br.height - r.bottom);
  var g = {
    anchor: a,
    x: +( x / br.width  * 100 ).toFixed(3),
    y: +( y / br.height * 100 ).toFixed(3),
    unit: u, w: 0, h: 0
  };
  if(u === 'pct'){
    g.w = +( r.width  / br.width  * 100 ).toFixed(3);
    g.h = +( r.height / br.height * 100 ).toFixed(3);
  } else {
    g.w = g.h = Math.round(r.width) || 26;
  }
  return g;
}

/* Everything below works in on-screen pixels and converts at the edges, so a button's
   drawn size stays circular whichever unit it's stored in. */
function pxSize(btn){
  var r = btn.getBoundingClientRect();
  return { w: r.width, h: r.height };
}

function buttons(){
  return Array.prototype.slice.call(document.querySelectorAll('[data-icalib]'));
}
function visible(){
  return buttons().filter(function(b){
    var r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}
/* One representative button per key -- the lobby's nine tiles all answer to 'index:tile'. */
function targets(){
  var seen = {}, out = [];
  visible().forEach(function(b){
    var k = b.getAttribute('data-icalib');
    if(seen[k]) return;
    seen[k] = 1; out.push(b);
  });
  return out;
}

/* ---- styling ---- */

var CSS = ''
+'#icalib-bar{position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:100000;background:rgba(0,0,0,.92);border:1px solid rgba(0,255,255,.5);border-radius:8px;padding:8px 10px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;color:#fff;font-family:system-ui,sans-serif;max-width:96vw;box-shadow:0 4px 20px rgba(0,0,0,.7)}'
+'#icalib-bar b{color:#0ff;font-size:12px}'
+'#icalib-bar button{background:rgba(0,255,255,.12);border:1px solid rgba(0,255,255,.45);border-radius:5px;color:#0ff;font-size:12px;padding:4px 8px;cursor:pointer;font-family:inherit}'
+'#icalib-bar button:hover{background:rgba(0,255,255,.25)}'
+'#icalib-bar button.on{background:#0ff;color:#003;font-weight:700}'
+'#icalib-bar .icalib-sep{width:1px;height:20px;background:rgba(255,255,255,.2)}'
+'#icalib-readout{min-width:190px;color:rgba(255,255,255,.75);font-family:ui-monospace,monospace;font-size:11px}'
+'#icalib-note{flex-basis:100%;color:rgba(255,255,255,.45);font-size:10.5px;line-height:1.35}'
+'#icalib-layer{position:fixed;inset:0;z-index:99990;pointer-events:none}'
+'.icalib-halo{position:fixed;border:2px dashed #0ff;border-radius:50%;pointer-events:auto;cursor:move;box-sizing:border-box;background:rgba(0,255,255,.18)}'
+'.icalib-halo.sel{border-color:#f0f;border-style:solid;background:rgba(255,0,255,.25);box-shadow:0 0 0 3px rgba(255,0,255,.25)}'
+'.icalib-tag{position:absolute;left:50%;top:-16px;transform:translateX(-50%);font-size:9.5px;color:#0ff;background:rgba(0,0,0,.8);padding:0 4px;border-radius:2px;white-space:nowrap;pointer-events:none;font-family:ui-monospace,monospace}'
+'.icalib-halo.sel .icalib-tag{color:#f0f}'
+'#icalib-export{position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:16px}'
+'#icalib-export .ie-box{background:#111;border:1px solid rgba(0,255,255,.4);border-radius:10px;padding:14px;width:100%;max-width:620px}'
+'#icalib-export textarea{width:100%;height:46vh;background:#000;color:#0f0;border:1px solid rgba(255,255,255,.2);border-radius:6px;padding:8px;font-family:ui-monospace,monospace;font-size:11.5px;margin:8px 0}'
+'#icalib-export .ie-row{display:flex;gap:8px;justify-content:flex-end}';

function injectCSS(){
  if(document.getElementById('icalib-css')) return;
  var s = document.createElement('style');
  s.id = 'icalib-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ---- halos: a draggable ring drawn over each button, so we never fight the page's own
   pointer handlers (tapping a lobby tile would otherwise navigate away mid-drag) ---- */

function syncHalos(){
  if(!active) return;
  var list = targets(), have = {};
  list.forEach(function(btn){
    var key = btn.getAttribute('data-icalib');
    have[key] = 1;
    var h = layer.querySelector('.icalib-halo[data-k="'+CSS_ESC(key)+'"]');
    if(!h){
      h = document.createElement('div');
      h.className = 'icalib-halo';
      h.setAttribute('data-k', key);
      h.innerHTML = '<span class="icalib-tag"></span>';
      h.addEventListener('pointerdown', onGrab);
      layer.appendChild(h);
    }
    h._btn = btn;
    var r = btn.getBoundingClientRect();
    h.style.left = (r.left - 4) + 'px';
    h.style.top = (r.top - 4) + 'px';
    h.style.width = (r.width + 8) + 'px';
    h.style.height = (r.height + 8) + 'px';
    h.classList.toggle('sel', selected === key);
    h.querySelector('.icalib-tag').textContent = key;
  });
  // drop halos for buttons that are no longer on screen (destroyer swaps whole screens)
  Array.prototype.slice.call(layer.children).forEach(function(h){
    if(!have[h.getAttribute('data-k')]) h.remove();
  });
  updateNote();
}

function CSS_ESC(s){ return String(s).replace(/["\\]/g, '\\$&'); }

/* ---- drag ---- */

var drag = null;

function onGrab(e){
  var h = e.currentTarget, btn = h._btn;
  if(!btn) return;
  e.preventDefault(); e.stopPropagation();
  selected = btn.getAttribute('data-icalib');
  var all = load();
  var cur = all[selected] || readGeom(btn);
  var br = boxRect(btn);
  var r = btn.getBoundingClientRect();
  drag = {
    key: selected, btn: btn, br: br,
    pxW: r.width, pxH: r.height,          // clamp/anchor math is all in on-screen pixels
    unit: cur.unit, w: cur.w, h: cur.h,   // size rides along untouched; dragging only moves
    anchor: cur.anchor || 'tl',
    // grab offset within the button, so it doesn't jump to the cursor on pickup
    dx: e.clientX - r.left, dy: e.clientY - r.top
  };
  h.setPointerCapture(e.pointerId);
  h.addEventListener('pointermove', onMove);
  h.addEventListener('pointerup', onDrop);
  h.addEventListener('pointercancel', onDrop);
  refresh();
}

function onMove(e){
  if(!drag) return;
  e.preventDefault();
  var br = drag.br;
  if(!br.width || !br.height) return;
  /* Clamp to the viewport, NOT to the container. Several of these are meant to hang off the
     edge of a small container -- paigow's sit at top:-4px;right:-4px on the rim of a bet
     spot -- so a container clamp would pin them to a corner and make those undraggable.
     Negative percentages are legitimate here; going off-screen never is. */
  var vl = Math.max(0, Math.min(e.clientX - drag.dx, (window.innerWidth  || 0) - drag.pxW));
  var vt = Math.max(0, Math.min(e.clientY - drag.dy, (window.innerHeight || 0) - drag.pxH));
  var left = vl - br.left, top = vt - br.top;
  var a = drag.anchor;
  var x = a.charAt(1) === 'l' ? left : (br.width  - left - drag.pxW);
  var y = a.charAt(0) === 't' ? top  : (br.height - top  - drag.pxH);
  commit(drag.key, {
    anchor: a,
    x: +( x / br.width  * 100 ).toFixed(3),
    y: +( y / br.height * 100 ).toFixed(3),
    unit: drag.unit, w: drag.w, h: drag.h
  });
}

function onDrop(e){
  if(!drag) return;
  var h = e.currentTarget;
  try { h.releasePointerCapture(e.pointerId); } catch(err){}
  h.removeEventListener('pointermove', onMove);
  h.removeEventListener('pointerup', onDrop);
  h.removeEventListener('pointercancel', onDrop);
  drag = null;
}

/* ---- mutate + re-apply ---- */

function commit(key, pos){
  var all = load();
  all[key] = pos;
  save(all);
  if(window.GameInstructions && window.GameInstructions.applyPositions) window.GameInstructions.applyPositions();
  refresh();
}

function nudge(ddx, ddy){
  if(!selected) return;
  var btn = sel();
  if(!btn) return;
  var all = load(), cur = all[selected] || readGeom(btn);
  var br = boxRect(btn);
  if(!br.width || !br.height) return;
  // arrows are screen-direction; flip them for right/bottom anchors so up is always up
  var sx = cur.anchor.charAt(1) === 'l' ? 1 : -1;
  var sy = cur.anchor.charAt(0) === 't' ? 1 : -1;
  commit(selected, {
    anchor: cur.anchor,
    x: +( cur.x + ddx * sx / br.width  * 100 ).toFixed(3),
    y: +( cur.y + ddy * sy / br.height * 100 ).toFixed(3),
    unit: cur.unit, w: cur.w, h: cur.h
  });
}

function sel(){
  return targets().filter(function(b){ return b.getAttribute('data-icalib') === selected; })[0];
}

function resize(delta){
  if(!selected) return;
  var btn = sel();
  if(!btn) return;
  var all = load(), cur = all[selected] || readGeom(btn);
  var br = boxRect(btn), now = pxSize(btn);
  // grow/shrink by on-screen pixels, then push it back into whichever unit this button uses
  var px = Math.max(14, Math.min(96, now.w + delta));
  if(cur.unit === 'pct'){
    if(!br.width || !br.height) return;
    cur.w = +( px / br.width  * 100 ).toFixed(3);
    cur.h = +( px / br.height * 100 ).toFixed(3);
  } else {
    cur.w = cur.h = px;
  }
  commit(selected, cur);
}

function setAnchor(a){
  if(!selected) return;
  var btn = sel();
  if(!btn) return;
  // re-measure against the new corner so the button doesn't move, only its reference does
  var all = load(), cur = all[selected];
  commit(selected, readGeom(btn, a, cur && cur.unit));
}

/* Flipping the unit re-reads the button where it currently sits, so it stays exactly put and
   only the way its size is expressed changes. */
function toggleUnit(){
  if(!selected) return;
  var btn = sel();
  if(!btn) return;
  var all = load(), cur = all[selected] || readGeom(btn);
  commit(selected, readGeom(btn, cur.anchor, cur.unit === 'pct' ? 'px' : 'pct'));
}

function resetOne(){
  if(!selected) return;
  var all = load();
  delete all[selected];
  save(all);
  location.reload(); // simplest honest way to restore the original in-flow layout
}

function resetAll(){
  if(!confirm('Clear every calibrated circle-i position and reload?')) return;
  save({});
  location.reload();
}

/* ---- toolbar ---- */

function buildBar(){
  bar = document.createElement('div');
  bar.id = 'icalib-bar';
  bar.innerHTML =
     '<b>circle-i calibrate</b>'
    +'<span class="icalib-sep"></span>'
    +'<span id="icalib-readout">tap a button to select</span>'
    +'<span class="icalib-sep"></span>'
    +'<button data-n="-1,0">←</button><button data-n="1,0">→</button>'
    +'<button data-n="0,-1">↑</button><button data-n="0,1">↓</button>'
    +'<span class="icalib-sep"></span>'
    +'<button data-s="-2">size −</button><button data-s="2">size +</button>'
    +'<button id="icalib-unit" title="fixed px, or % of the module so it scales with the felt art">px/%</button>'
    +'<span class="icalib-sep"></span>'
    +'<button data-a="tl" title="anchor top-left">TL</button>'
    +'<button data-a="tr" title="anchor top-right">TR</button>'
    +'<button data-a="bl" title="anchor bottom-left">BL</button>'
    +'<button data-a="br" title="anchor bottom-right">BR</button>'
    +'<span class="icalib-sep"></span>'
    +'<button id="icalib-reset">reset this</button>'
    +'<button id="icalib-resetall">reset all</button>'
    +'<button id="icalib-export-btn">Export</button>'
    +'<button id="icalib-exit">Exit</button>'
    +'<div id="icalib-note"></div>';
  document.body.appendChild(bar);

  bar.addEventListener('click', function(e){
    var t = e.target.closest('button');
    if(!t) return;
    if(t.dataset.n){ var p = t.dataset.n.split(','); nudge(+p[0], +p[1]); }
    else if(t.dataset.s){ resize(+t.dataset.s); }
    else if(t.dataset.a){ setAnchor(t.dataset.a); }
    else if(t.id === 'icalib-unit') toggleUnit();
    else if(t.id === 'icalib-reset') resetOne();
    else if(t.id === 'icalib-resetall') resetAll();
    else if(t.id === 'icalib-export-btn') showExport();
    else if(t.id === 'icalib-exit') exit();
  });

  document.addEventListener('keydown', onKey, true);
}

function onKey(e){
  if(!active || !selected) return;
  if(e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  var step = e.shiftKey ? 10 : 1, hit = true;
  if(e.key === 'ArrowLeft') nudge(-step, 0);
  else if(e.key === 'ArrowRight') nudge(step, 0);
  else if(e.key === 'ArrowUp') nudge(0, -step);
  else if(e.key === 'ArrowDown') nudge(0, step);
  else hit = false;
  if(hit){ e.preventDefault(); e.stopPropagation(); }
}

function refresh(){
  syncHalos();
  if(!bar) return;
  var out = document.getElementById('icalib-readout');
  var all = load();
  if(selected && all[selected]){
    var p = all[selected];
    var sz = p.unit === 'pct' ? (p.w + '%×' + p.h + '%') : (p.w + 'px');
    /* Percentages are relative to a button's own container, and some of those are tiny (a
       paigow bet spot is ~43px). Dragged far enough out the numbers get big and brittle --
       a small change to the container then throws the button a long way -- so say so. */
    var far = Math.abs(p.x) > 150 || Math.abs(p.y) > 150;
    out.textContent = selected + '  ' + p.anchor + ' x:' + p.x + '% y:' + p.y + '%  ' + sz
      + (far ? '  ⚠ far outside its container' : '');
    out.style.color = far ? '#ffb454' : 'rgba(255,255,255,.75)';
  } else if(selected){
    out.textContent = selected + '  (uncalibrated)';
  } else {
    out.textContent = 'tap a button to select';
  }
  Array.prototype.slice.call(bar.querySelectorAll('button[data-a]')).forEach(function(b){
    b.classList.toggle('on', !!(selected && all[selected] && all[selected].anchor === b.dataset.a));
  });
}

function updateNote(){
  var note = document.getElementById('icalib-note');
  if(!note) return;
  var all = load(), n = Object.keys(all).length;
  var here = targets().map(function(b){ return b.getAttribute('data-icalib'); });
  note.textContent = 'on this screen: ' + (here.join(', ') || 'none') +
    '  •  ' + n + ' saved total (all pages)  •  drag or use arrows (shift = 10px). ' +
    'Calibrate mode follows you between games until you Exit.';
}

/* ---- export ---- */

function showExport(){
  var all = load();
  var keys = Object.keys(all).sort();
  var lines = keys.map(function(k){
    var p = all[k];
    var sz = p.unit === 'pct'
      ? "unit:'pct', w:" + p.w + ", h:" + p.h
      : "unit:'px', w:" + p.w;
    return "  '" + k + "': { anchor:'" + p.anchor + "', x:" + p.x + ", y:" + p.y + ", " + sz + " }";
  });
  var text = 'var INSTR_POS = {\n' + lines.join(',\n') + (lines.length ? '\n' : '') + '};';

  var ov = document.createElement('div');
  ov.id = 'icalib-export';
  ov.innerHTML =
     '<div class="ie-box">'
    +'<div style="color:#0ff;font-weight:700;margin-bottom:2px">Paste this over INSTR_POS in instructions.js</div>'
    +'<textarea readonly></textarea>'
    +'<div class="ie-row"><button id="ie-copy">Copy</button><button id="ie-close">Close</button></div>'
    +'</div>';
  document.body.appendChild(ov);
  var ta = ov.querySelector('textarea');
  ta.value = text;
  ta.focus(); ta.select();
  ov.querySelector('#ie-copy').onclick = function(){
    ta.select();
    try { document.execCommand('copy'); this.textContent = 'Copied'; } catch(e){ this.textContent = 'Select + copy'; }
  };
  ov.querySelector('#ie-close').onclick = function(){ ov.remove(); };
  // match the toolbar's button styling inside the overlay
  Array.prototype.slice.call(ov.querySelectorAll('button')).forEach(function(b){
    b.style.cssText = 'background:rgba(0,255,255,.12);border:1px solid rgba(0,255,255,.45);border-radius:5px;color:#0ff;font-size:13px;padding:6px 12px;cursor:pointer';
  });
}

/* ---- lifecycle ---- */

function enter(){
  if(active) return;
  active = true;
  try { sessionStorage.setItem('icalib', '1'); } catch(e){}
  injectCSS();
  layer = document.createElement('div');
  layer.id = 'icalib-layer';
  document.body.appendChild(layer);
  buildBar();
  refresh();
  // halos are fixed-position overlays, so they have to chase the page as it moves
  window.addEventListener('resize', syncHalos);
  window.addEventListener('scroll', syncHalos, true);
  setInterval(syncHalos, 400); // cheap catch-all for screen swaps and async layout
}

function exit(){
  active = false;
  try { sessionStorage.removeItem('icalib'); } catch(e){}
  // strip ?icalib=1 so a refresh doesn't drop straight back in
  try {
    var u = new URL(location.href);
    if(u.searchParams.has('icalib')){ u.searchParams.delete('icalib'); history.replaceState(null, '', u); }
  } catch(e){}
  location.reload();
}

window.InstrCalib = { enter: enter, exit: exit, refresh: refresh };

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enter);
else enter();

})();
