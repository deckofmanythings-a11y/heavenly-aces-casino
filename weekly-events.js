// Client-side mirror of craps-functions/supabase/functions/_shared/weeklyEvents.ts --
// display/UI-gating ONLY. Every payout these events describe is decided server-side;
// this file never affects money, it just decides whether to show a banner or a betting
// spot. Keep the day table in sync with the server copy if it ever changes.
const WeeklyEvents = (function () {
  const MIN_TIER = 1; // Nephilim

  const EVENTS = [
    { day: 0, key: 'ats-sunday', label: 'ATS Sunday', game: 'Craps',
      desc: "High Rolls and Low Rolls pay 62 for 1. Roll'em All pays 312 for 1." },
    { day: 1, key: 'full-moon-monday', label: 'Full Moon Monday', game: "Ultimate Texas Hold'em",
      desc: 'Trips bet pays double (16 for 1) on a Full House.' },
    { day: 2, key: 'true-odds-tuesday', label: 'True-Odds Tuesday', game: 'Sic-Bo & Craps',
      desc: 'Sic-Bo Specific Triples pay 217 for 1. Craps Buy bets pay no commission.' },
    { day: 3, key: 'wheel-wednesday', label: 'Wheel Wednesday', game: 'Roulette',
      desc: '0 and 00 pay 40 to 1.' },
    { day: 4, key: 'trilux-thursday', label: 'Trilux Thursday', game: 'Breakout Blackjack',
      desc: 'The Trilux side bet is on the felt: Straight Flush $180, Trips $170, Straight $55, Flush $30.' },
    { day: 5, key: 'super-flush-friday', label: 'Super Flush Friday', game: 'I ❤ Suits',
      desc: 'Super Flush Rush pays double.' },
    { day: 6, key: 'sinkem-saturday', label: "Sink'em Saturday", game: 'Destroyer',
      desc: 'Max-hit payouts are doubled on every ship.' },
  ];

  // Pacific calendar day, matching Dailies' own midnight-Pacific rollover -- not the
  // browser's local timezone. Same en-CA-stamp trick as the server's todayPacific().
  function todayDay() {
    const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
    return new Date(stamp + 'T00:00:00Z').getUTCDay();
  }
  function active(tier) {
    if ((tier || 0) < MIN_TIER) return null;
    return EVENTS.find(e => e.day === todayDay()) || null;
  }
  function isDay(day, tier) { return (tier || 0) >= MIN_TIER && todayDay() === day; }

  return { EVENTS, MIN_TIER, todayDay, active, isDay };
})();
