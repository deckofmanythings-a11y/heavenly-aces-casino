// chip-input.js — makes chip-denomination selection forgiving of mouse movement.
//
// The tray chips are plain <div class="chip" data-val="N" onclick="selectChip(N)">. A
// `click` event only fires when the pointer PRESSES and RELEASES on the same element, so
// a player who nudges the mouse mid-click (a "micro-drag") loses the selection entirely
// and keeps betting at the previous denomination — the exact complaint this fixes.
// Selecting on `pointerdown` instead registers the choice the instant the button goes
// down over the chip, no matter how much the mouse moves before release.
//
// Implemented as ONE document-level delegated listener so it's load-order independent and
// needs no per-page wiring beyond including this script. It only calls the page's global
// selectChip(v); it doesn't assume what that does (craps/roulette/etc. set G.chip and
// toggle the .sel highlight; slots set G.bet), so the same file works for all games. The
// inline onclick handlers are left in place as a harmless, idempotent fallback — on a
// clean click selectChip simply runs once from pointerdown and again from click with the
// same value, which is a no-op the second time.
//
// Scope is deliberately limited to `.chip[data-val]` (the denomination tray only). Bet
// SPOTS are intentionally NOT handled here: their handlers are additive (each click
// stacks another chip), so firing on both pointerdown AND click would place two chips per
// press. Making bet placement equally forgiving would mean replacing their click handlers,
// not layering pointerdown on top — a separate change.
(function () {
  if (window.__chipInputForgiving) return; // guard against an accidental double-include
  window.__chipInputForgiving = true;

  document.addEventListener('pointerdown', function (e) {
    // Primary button only — never hijack right-click (chip tray has no context action,
    // but bet spots do) or middle-click.
    if (e.button != null && e.button !== 0) return;
    if (e.isPrimary === false) return; // ignore secondary touches in a multi-touch

    const chip = e.target && e.target.closest && e.target.closest('.chip[data-val]');
    if (!chip) return;

    const val = Number(chip.dataset.val);
    if (!Number.isFinite(val)) return;

    if (typeof window.selectChip === 'function') window.selectChip(val);
  }, { passive: true });
})();
