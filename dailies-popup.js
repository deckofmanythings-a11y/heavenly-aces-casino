/* ============================================================
   dailies-popup.js
   Shared "Task/Quest complete" announcement, used by every game page.
   Each roll-* Edge Function echoes back { dailies, dailiesEvents,
   free_play_balance } (see supabase/functions/_shared/dailies.ts). Call
   DailiesPopup.handle(response) right after a successful roll/deal/resolve
   fetch -- it queues one popup per newly-completed event, and dismissing a
   popup (tap anywhere) fires WinnerModal.show() for that event's amount,
   per spec: "clicking off that pop up will fire the Winner modal with the
   value given to you." Requires winner-modal.js to be loaded first.

   INTEGRATION:
     const data = await res.json();
     DailiesPopup.handle(data); // no-op if data.dailiesEvents is empty/absent
   ============================================================ */
(function (global) {
  'use strict';

  let overlayEl, titleEl, labelEl, amtEl;
  let queue = [];
  let showing = false;

  function build() {
    const style = document.createElement('style');
    style.textContent = [
      '#dp-overlay{position:fixed;inset:0;z-index:250;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);cursor:pointer}',
      '#dp-overlay.hidden{display:none}',
      '.dp-box{background:linear-gradient(160deg,#1c1c1c,#111);border:1px solid rgba(255,215,0,.5);border-radius:16px;padding:28px 40px;text-align:center;box-shadow:0 0 40px rgba(255,215,0,.25);animation:dpPop .3s cubic-bezier(.34,1.56,.64,1);max-width:90vw}',
      '@keyframes dpPop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}',
      '.dp-title{font-size:15px;font-weight:800;letter-spacing:.08em;color:#ffd700;text-transform:uppercase;margin-bottom:10px}',
      '.dp-label{font-size:20px;font-weight:700;color:#fff;margin-bottom:8px}',
      '.dp-amt{font-size:34px;font-weight:900;color:#4dff88}',
      '.dp-hint{margin-top:14px;font-size:12px;color:rgba(255,255,255,.4)}',
    ].join('');
    document.head.appendChild(style);

    overlayEl = document.createElement('div');
    overlayEl.id = 'dp-overlay'; overlayEl.className = 'hidden';
    overlayEl.innerHTML =
      '<div class="dp-box">' +
        '<div class="dp-title" id="dp-title"></div>' +
        '<div class="dp-label" id="dp-label"></div>' +
        '<div class="dp-amt" id="dp-amt"></div>' +
        '<div class="dp-hint">Tap anywhere to collect</div>' +
      '</div>';
    document.body.appendChild(overlayEl);
    titleEl = document.getElementById('dp-title');
    labelEl = document.getElementById('dp-label');
    amtEl = document.getElementById('dp-amt');
    overlayEl.addEventListener('click', advance);
  }

  const TITLE = { task: 'Daily Task Complete', bonus: 'All Dailies Complete!', quest: 'Quest Complete!' };

  function advance() {
    overlayEl.classList.add('hidden');
    const done = queue.shift();
    if (done && done.amount > 0 && global.WinnerModal) {
      global.WinnerModal.show(done.amount);
    }
    if (queue.length) {
      setTimeout(showNext, global.WinnerModal ? 50 : 0);
    } else {
      showing = false;
    }
  }

  function showNext() {
    if (!queue.length) { showing = false; return; }
    if (!overlayEl) build();
    const ev = queue[0];
    titleEl.textContent = TITLE[ev.type] || 'Complete!';
    labelEl.textContent = ev.label || '';
    amtEl.textContent = '+$' + ev.amount.toFixed(2) + ' Free Play';
    overlayEl.classList.remove('hidden');
    showing = true;
  }

  const DailiesPopup = {
    // Pass the parsed JSON body of any roll-*/deal/resolve response. Silently does
    // nothing if there are no dailiesEvents (older cached client, or nothing new).
    handle(response) {
      if (!response || !Array.isArray(response.dailiesEvents) || !response.dailiesEvents.length) return;
      queue.push(...response.dailiesEvents);
      if (!showing) showNext();
    },
  };

  global.DailiesPopup = DailiesPopup;

  // Auto-hook: every game page here calls fetch(FUNCTIONS_URL + '/roll-<game>', ...) or
  // '/dailies-action' from a handful of call sites each, and every one of those Edge
  // Functions now echoes dailiesEvents on success. Rather than editing every call site
  // in every game file (and re-editing them again the next time a call site is added),
  // wrap fetch once here: peek at matching responses via a clone (so the caller's own
  // .json() still works untouched) and feed any events straight into the popup queue.
  const origFetch = global.fetch.bind(global);
  global.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isDailiesSource = /\/(roll-[a-z]+|dailies-action)(\?|$)/.test(url);
    const p = origFetch(input, init);
    if (!isDailiesSource) return p;
    return p.then(res => {
      res.clone().json().then(json => {
        DailiesPopup.handle(json);
        FreePlayBadge.handle(json);
      }).catch(() => {});
      return res;
    });
  };

  // ---------- persistent FP$ balance badge, shown on every game screen ----------
  // A small always-visible pill (like a second bankroll readout) so a player never
  // has to open the Dailies page just to check whether they still have Free Play to
  // spend. Every roll-*/dailies-action response already carries free_play_balance
  // (see the fetch hook above), so the badge just mirrors whatever the server last
  // said -- never computed client-side. Also flashes "-$X used" for a couple seconds
  // whenever a response reports free_play_used > 0, so a player can see which of
  // their bets actually drew from it.
  let fpBadgeEl, fpAmtEl, fpUsedEl, fpUsedTimer;

  function buildFpBadge() {
    const style = document.createElement('style');
    style.textContent = [
      '#fp-badge{position:fixed;top:8px;right:8px;z-index:120;background:rgba(10,10,10,.85);border:1px solid rgba(255,215,0,.45);border-radius:20px;padding:5px 12px;font:700 12px system-ui,sans-serif;color:#ffd700;display:flex;align-items:center;gap:6px;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.4)}',
      '#fp-badge.hidden{display:none}',
      '#fp-used{color:#4dff88;font-weight:800;opacity:0;transition:opacity .2s}',
      '#fp-used.show{opacity:1}',
    ].join('');
    document.head.appendChild(style);
    fpBadgeEl = document.createElement('div');
    fpBadgeEl.id = 'fp-badge'; fpBadgeEl.className = 'hidden';
    fpBadgeEl.innerHTML = '<span>FP$</span><span id="fp-amt">0.00</span><span id="fp-used"></span>';
    document.body.appendChild(fpBadgeEl);
    fpAmtEl = document.getElementById('fp-amt');
    fpUsedEl = document.getElementById('fp-used');
  }

  let fpBalance = 0;
  const FreePlayBadge = {
    setBalance(balance) {
      if (!fpBadgeEl) buildFpBadge();
      const b = parseFloat(balance) || 0;
      fpBalance = b;
      fpAmtEl.textContent = b.toFixed(2);
      fpBadgeEl.classList.toggle('hidden', b <= 0 && !fpUsedEl.classList.contains('show'));
    },
    // Last known balance, for games that want to label a chip stack "FP$" the instant
    // it's placed (an optimistic client-side estimate of what the server will draw
    // from on resolve) rather than waiting for a round-trip to confirm it.
    getBalance() { return fpBalance; },
    flashUsed(amount) {
      if (!fpBadgeEl) buildFpBadge();
      if (!(amount > 0)) return;
      fpBadgeEl.classList.remove('hidden');
      fpUsedEl.textContent = '-$' + amount.toFixed(2) + ' used';
      fpUsedEl.classList.add('show');
      clearTimeout(fpUsedTimer);
      fpUsedTimer = setTimeout(() => { fpUsedEl.classList.remove('show'); fpUsedEl.textContent = ''; }, 3000);
    },
    handle(response) {
      if (!response) return;
      if (typeof response.free_play_balance === 'number') this.setBalance(response.free_play_balance);
      if (typeof response.free_play_used === 'number' && response.free_play_used > 0) this.flashUsed(response.free_play_used);
    },
  };
  global.FreePlayBadge = FreePlayBadge;

  // Initial paint on page load: a player who hasn't rolled/dealt/fired anything yet
  // this visit still deserves to see their balance, so fetch it once via the same
  // read-only dailies-action('state') the lobby badge and dailies.html use.
  //
  // FUNCTIONS_URL/SUPABASE_ANON_KEY are declared `const` at the top of each game's own
  // inline <script>, which does NOT attach them to `window` the way a top-level `var`
  // or bare assignment would -- `typeof global.FUNCTIONS_URL` was therefore always
  // 'undefined' here regardless of whether the page actually defines it, silently
  // skipping this fetch on every page, every time. They're still reachable as bare
  // identifiers though, since plain (non-module) <script> tags on the same page share
  // one global lexical scope -- read them that way instead, inside a try/catch for the
  // rare page that genuinely doesn't define them.
  function primeFpBadge() {
    const token = global.localStorage && global.localStorage.getItem('craps_session');
    if (!token) return;
    let fnUrl, anonKey;
    try { fnUrl = FUNCTIONS_URL; anonKey = SUPABASE_ANON_KEY; } catch (e) { return; }
    if (!fnUrl || !anonKey) return;
    origFetch(fnUrl + '/dailies-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + anonKey, 'apikey': anonKey },
      body: JSON.stringify({ session_token: token, action: 'state' }),
    }).then(res => res.json()).then(data => { if (data && data.ok) FreePlayBadge.setBalance(data.free_play_balance); }).catch(() => {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', primeFpBadge);
  else primeFpBadge();
})(window);
