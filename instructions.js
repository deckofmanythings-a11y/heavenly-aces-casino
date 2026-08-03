/* Shared "how to play" instructions modal -- one script, reused by index.html (lobby tile
   circle-i buttons) and every game's in-game HOME-area circle-i button. Content lives in
   INSTRUCTIONS_DATA below so both call sites stay in sync automatically; games never define
   their own copy. Follows the same self-contained "own DOM/CSS from one script include"
   pattern as winner-modal.js -- open with GameInstructions.open('<gameId>', ['optional','tags']). */
(function(){

var INSTRUCTIONS_DATA = {
  'craps-standard': { title: '🎲 Craps — Standard', pages: [
    { body:
      '<h3>The Core Loop</h3>'
      +'<p>Every round starts with a <b>come-out roll</b>. With no point set, a roll of <b>7 or 11 wins</b> the Pass Line outright; a roll of <b>2, 3, or 12 ("craps") loses</b> it. Any other total (4, 5, 6, 8, 9, or 10) becomes <b>the Point</b> — watch the puck flip from <b>OFF</b> to <b>ON</b>.</p>'
      +'<p>Once a point is set, the shooter keeps rolling: hit that same number again and the Pass Line wins and the round resets; roll a 7 first ("seven-out") and the Pass Line loses, clearing Come/Place/Buy bets along with it. Any other number just keeps the round going.</p>'
      +'<p>Bet <span class="bet-name">Don\'t Pass</span> to play against the shooter instead — it wins on come-out 2 or 3 (12 pushes), loses on come-out 7/11, and then wins on a seven-out instead of a point.</p>'
    },
    { heading:'Line Bets & Odds', body:
      '<h3><span class="bet-name">Pass Line</span> / <span class="bet-name">Come</span></h3>'
      +'<p>Pays even money. Come works exactly like the Pass Line but placed after a point is already set — it gets its own point on the next roll, then wins if that number repeats before a 7.</p>'
      +'<h3><span class="bet-name">Don\'t Pass</span> / <span class="bet-name">Don\'t Come</span></h3>'
      +'<p>The "wrong side" of the line bets above — wins and loses on the opposite rolls. Not locked in once a point is set; you can remove it anytime.</p>'
      +'<h3>Odds bets</h3>'
      +'<p>Once you have a point, back your Pass/Come bet with true-odds Odds (no house edge): <span class="odds">2:1</span> on 4/10, <span class="odds">3:2</span> on 5/9, <span class="odds">6:5</span> on 6/8. Backing a Don\'t bet with Lay Odds pays the reverse: <span class="odds">1:2</span> on 4/10, <span class="odds">2:3</span> on 5/9, <span class="odds">5:6</span> on 6/8.</p>'
    },
    { heading:'Place, Buy & Lay', body:
      '<h3><span class="bet-name">Place</span></h3>'
      +'<p>Bet a number wins before a 7, working anytime (not just after a point). Pays <span class="odds">9:5</span> on 4/10, <span class="odds">7:5</span> on 5/9, <span class="odds">7:6</span> on 6/8.</p>'
      +'<h3><span class="bet-name">Buy</span></h3>'
      +'<p>Same idea as Place, but you pay a 5% commission for true odds instead: <span class="odds">2:1</span> on 4/10, <span class="odds">3:2</span> on 5/9, <span class="odds">6:5</span> on 6/8, net of vig.</p>'
      +'<h3><span class="bet-name">Lay</span></h3>'
      +'<p>The opposite of Buy — betting a 7 comes before the number, minus 5% commission: <span class="odds">1:2</span> on 4/10, <span class="odds">2:3</span> on 5/9, <span class="odds">5:6</span> on 6/8.</p>'
      +'<p>Use the <b>Bets Off</b> toggle to pull your Place/Buy bets out of action for a roll without removing them.</p>'
    },
    { heading:'Hardways & One-Roll Bets', body:
      '<h3><span class="bet-name">Hardways</span></h3>'
      +'<p>Bet a number rolls as a matching pair (e.g. 4-4) before it rolls "easy" or a 7 shows. Hard 6/Hard 8 pay <span class="odds">9:1</span>; Hard 4/Hard 10 pay <span class="odds">7:1</span>.</p>'
      +'<h3>One-roll bets (settle on the very next roll)</h3>'
      +'<ul>'
      +'<li><span class="bet-name">Field</span> — wins on 2,3,4,9,10,11,12; pays <span class="odds">1:1</span>, except 2 and 12 pay <span class="odds">2:1</span>.</li>'
      +'<li><span class="bet-name">Any Craps</span> (2,3,12) — <span class="odds">7:1</span>. <span class="bet-name">Any Seven</span> — <span class="odds">4:1</span>.</li>'
      +'<li><span class="bet-name">Horn</span> (split across 2,3,11,12) — 2/12 portions pay <span class="odds">30:1</span>, 3/11 portions pay <span class="odds">15:1</span>. <span class="bet-name">C&amp;E</span> — craps side pays <span class="odds">7:1</span>, eleven side pays <span class="odds">15:1</span>.</li>'
      +'<li><span class="bet-name">Aces</span> (2) &amp; <span class="bet-name">Midnight</span> (12) — <span class="odds">30:1</span>. <span class="bet-name">Ace-Deuce</span> (3) &amp; <span class="bet-name">Eleven/Yo</span> — <span class="odds">15:1</span>.</li>'
      +'<li><span class="bet-name">Hop bets</span> (exact dice combo) — pairs pay <span class="odds">30:1</span>, non-pairs pay <span class="odds">15:1</span>.</li>'
      +'</ul>'
    },
    { heading:'The Light', body:
      '<h3><span class="bet-name">The Light</span> (progressive jackpot)</h3>'
      +'<p>Flat $5 bet, active for the whole time you\'re the shooter. Pays out based on how many points you make in a row without seven-ing out: 12 in a row wins the whole pool, 9 wins 10% of the pool, 6 pays $15, 4 pays $5.</p>'
    }
  ] },
  'craps-crapless': { title: '🎲 Crapless Craps', pages: [
    { body:
      '<h3>The Core Loop</h3>'
      +'<p>Crapless plays like regular Craps with one big change: <b>there are no naturals</b>. On the come-out roll, only a <b>7 wins</b> the Pass Line outright — every other total (2, 3, 4, 5, 6, 8, 9, 10, 11, or 12) becomes <b>the Point</b>. Watch the puck flip from <b>OFF</b> to <b>ON</b> once a point is set.</p>'
      +'<p>Once a point is set, keep rolling: hit that same number again and the Pass Line wins and the round resets; roll a 7 first ("seven-out") and the Pass Line loses, clearing Come/Place/Buy bets with it. Any other number just keeps the round going.</p>'
      +'<p>Because there\'s no craps-out and no natural 11, every one of the ten non-7 totals can become a point — including 2, 3, 11, and 12, which don\'t exist as points in standard Craps.</p>'
    },
    { heading:'Line Bets & Odds', body:
      '<h3><span class="bet-name">Pass Line</span> / <span class="bet-name">Come</span></h3>'
      +'<p>Pays even money. Come works exactly like the Pass Line but placed after a point is already set — it gets its own point on the next roll, then wins if that number repeats before a 7.</p>'
      +'<h3>Odds bets</h3>'
      +'<p>Once you have a point, back your Pass/Come bet with true-odds Odds — wider than standard Craps since 2/3/11/12 are playable points here too: <span class="odds">6:1</span> on 2/12, <span class="odds">3:1</span> on 3/11, <span class="odds">2:1</span> on 4/10, <span class="odds">3:2</span> on 5/9, <span class="odds">6:5</span> on 6/8.</p>'
      +'<p>Note: there\'s no Don\'t Pass, Don\'t Come, or Lay betting in Crapless mode.</p>'
    },
    { heading:'Place & Buy', body:
      '<h3><span class="bet-name">Place</span></h3>'
      +'<p>Bet a number wins before a 7, working anytime. Pays <span class="odds">9:5</span> on 4/10, <span class="odds">7:5</span> on 5/9, <span class="odds">7:6</span> on 6/8.</p>'
      +'<h3><span class="bet-name">Buy</span></h3>'
      +'<p>Pay a 5% commission for true odds instead: <span class="odds">119:20</span> on 2/12, <span class="odds">59:20</span> on 3/11, <span class="odds">2:1</span> on 4/10, <span class="odds">3:2</span> on 5/9, <span class="odds">6:5</span> on 6/8, net of vig.</p>'
      +'<p>The Line Mode selector switches how the number line behaves — Full Buy/Place, Limited Buy/Place, or Easy Craps (every number is a Place bet, no Buy needed). Use the <b>Bets Off</b> toggle to pull Place/Buy bets out of action for a roll without removing them.</p>'
    },
    { heading:'Hardways & One-Roll Bets', body:
      '<h3><span class="bet-name">Hardways</span></h3>'
      +'<p>Bet a number rolls as a matching pair (e.g. 4-4) before it rolls "easy" or a 7 shows. Hard 6/Hard 8 pay <span class="odds">9:1</span>; Hard 4/Hard 10 pay <span class="odds">7:1</span>.</p>'
      +'<h3>One-roll bets (settle on the very next roll)</h3>'
      +'<ul>'
      +'<li><span class="bet-name">Field</span> — wins on 2,3,4,9,10,11,12; pays <span class="odds">1:1</span>, except 2 and 12 pay <span class="odds">2:1</span>.</li>'
      +'<li><span class="bet-name">Any Craps</span> (2,3,12) — <span class="odds">7:1</span>. <span class="bet-name">Any Seven</span> — <span class="odds">4:1</span>.</li>'
      +'<li><span class="bet-name">Horn</span> (split across 2,3,11,12) — 2/12 portions pay <span class="odds">30:1</span>, 3/11 portions pay <span class="odds">15:1</span>. <span class="bet-name">C&amp;E</span> — craps side pays <span class="odds">7:1</span>, eleven side pays <span class="odds">15:1</span>.</li>'
      +'<li><span class="bet-name">Aces</span> (2) &amp; <span class="bet-name">Midnight</span> (12) — <span class="odds">30:1</span>. <span class="bet-name">Ace-Deuce</span> (3) &amp; <span class="bet-name">Eleven/Yo</span> — <span class="odds">15:1</span>.</li>'
      +'<li><span class="bet-name">Hop bets</span> (exact dice combo) — pairs pay <span class="odds">30:1</span>, non-pairs pay <span class="odds">15:1</span>.</li>'
      +'</ul>'
    },
    { heading:'The Light', body:
      '<h3><span class="bet-name">The Light</span> (progressive jackpot)</h3>'
      +'<p>Flat $5 bet, active for the whole time you\'re the shooter. Since Crapless points are individually tougher to make, it takes fewer in a row to cash in: 10 in a row wins the whole pool, 8 wins 10% of the pool, 5 pays $15, 4 pays $5.</p>'
    }
  ] },
  sicbo: { title: '🎰 Sic-Bo', pages: [
    { body:
      '<h3>The Core Loop</h3>'
      +'<p>Pick a chip, tap bet cells on the board to stake on the roll, then press <b>ROLL</b>. Three dice tumble and land on the same numbers everyone is betting on — all your bets resolve against that one roll, winners get paid, losers lose their stake, and the board clears for the next round.</p>'
      +'<p>Right-click (or drag off) a bet cell to remove a wager before rolling. Table limit is $1–$300 per spot.</p>'
    },
    { heading:'Big / Small & Any Triple', body:
      '<h3><span class="bet-name">Small</span> / <span class="bet-name">Big</span></h3>'
      +'<p>Small wins if the three dice add up to 4–10; Big wins if they add up to 11–17. Either way, <b>a triple (three matching dice) makes both lose</b>, no matter the total. Pays <span class="odds">1:1</span>.</p>'
      +'<h3><span class="bet-name">Any Triple</span></h3>'
      +'<p>Wins if all three dice match each other (any value). Pays <span class="odds">1:30</span>.</p>'
      +'<h3><span class="bet-name">Specific Triple</span></h3>'
      +'<p>Wins only on the exact triple you picked (e.g. 3-3-3). Pays <span class="odds">1:190</span>.</p>'
    },
    { heading:'Doubles, Combinations & Numbers', body:
      '<h3><span class="bet-name">Double</span></h3>'
      +'<p>Wins if the value you picked shows up on at least two of the three dice. Pays <span class="odds">1:12</span>.</p>'
      +'<h3><span class="bet-name">Combination</span></h3>'
      +'<p>Pick two different values (e.g. 2 &amp; 5) — wins if both appear somewhere among the three dice. Pays <span class="odds">1:6</span>.</p>'
      +'<h3><span class="bet-name">Any Number</span></h3>'
      +'<p>Pick one face value — you\'re paid based on how many dice show it: <span class="odds">1:1</span> on one die, <span class="odds">1:2</span> on two dice, <span class="odds">1:12</span> on all three.</p>'
    },
    { heading:'Total', body:
      '<h3><span class="bet-name">Total</span></h3>'
      +'<p>Bet on the exact sum of all three dice (4 through 17). Payout scales with how unlikely that sum is:</p>'
      +'<ul>'
      +'<li>4 or 17 — <span class="odds">62:1</span></li>'
      +'<li>5 or 16 — <span class="odds">31:1</span></li>'
      +'<li>6 or 15 — <span class="odds">18:1</span></li>'
      +'<li>7 or 14 — <span class="odds">12:1</span></li>'
      +'<li>8 or 13 — <span class="odds">8:1</span></li>'
      +'<li>9 or 12 — <span class="odds">7:1</span></li>'
      +'<li>10 or 11 — <span class="odds">6:1</span></li>'
      +'</ul>'
    }
  ] },
  roulette: { title: '🎡 Roulette', pages: [
    { body:
      '<h3>The Core Loop</h3>'
      +'<p>Pick a chip denomination, place bets anywhere on the felt (numbers, colors, or number groups), then press <b>SPIN</b>. The wheel spins, the ball lands on one pocket (0, 00, or 1–36), and every bet resolves against that single pocket. Right-click a bet to remove it, or use the on-cell <b>−</b> button on touch.</p>'
      +'<p>Table limit is $1–$300 per spot. <b>Clear</b> wipes all staged bets; <b>Repeat</b> re-stakes your last spin\'s layout.</p>'
    },
    { heading:'Inside Bets', body:
      '<h3><span class="bet-name">Straight-Up</span></h3>'
      +'<p>Bet on a single number (including 0 or 00). Pays <span class="odds">35:1</span>.</p>'
      +'<h3><span class="bet-name">Split</span></h3>'
      +'<p>Bet on the line between two adjacent numbers — wins if either hits. Pays <span class="odds">17:1</span>.</p>'
      +'<h3><span class="bet-name">Corner</span></h3>'
      +'<p>Bet on the point where four numbers meet — wins if any of the four hits. Pays <span class="odds">8:1</span>.</p>'
    },
    { heading:'Outside Bets', body:
      '<h3><span class="bet-name">Column</span> (2:1 strip)</h3>'
      +'<p>Bet on one of the three 12-number columns. Pays <span class="odds">2:1</span>.</p>'
      +'<h3><span class="bet-name">Dozen</span></h3>'
      +'<p>Bet on 1–12, 13–24, or 25–36. Pays <span class="odds">2:1</span>.</p>'
      +'<h3>Even-money bets</h3>'
      +'<p><span class="bet-name">Red/Black</span>, <span class="bet-name">Odd/Even</span>, and <span class="bet-name">1–18 / 19–36</span> (low/high) all pay <span class="odds">1:1</span>. 0 and 00 are green and lose all of these.</p>'
    }
  ] },
  destroyer: { title: '🚢 Destroyer: Naval Strike', pages: [
    { body:
      '<h3>The Core Loop</h3>'
      +'<p>Four ships — a 2-cell Destroyer, two 3-cell Battleships, and a 4-cell Carrier — are auto-placed on a hidden 6×6 grid. Don\'t like the layout? Tap <b>New Ship Positions</b> to reroll it as many times as you like. Set your wager, then <b>Begin Game</b>.</p>'
      +'<p>You start with <b>4 missiles</b>. Each <b>Fire Missile</b> targets a random cell on the grid for you — you\'re not aiming, the shot is rolled — and comes back a <b>Hit</b> or a <b>Miss</b>. A miss uses up one of your missiles; a hit that doesn\'t sink a ship is free and doesn\'t cost you one. Sink all 4 ships, or run out of missiles (with an option to buy more), to end the round and collect your payout.</p>'
    },
    { heading:'Payouts', body:
      '<h3>Per-ship payouts (multiplier × your bet)</h3>'
      +'<ul>'
      +'<li><span class="bet-name">Destroyer</span> (2 cells) — sink it for <span class="odds">3×</span>.</li>'
      +'<li><span class="bet-name">Battleship</span> (3 cells, ×2 on the board) — 2 hits pay <span class="odds">3×</span>, sinking it pays <span class="odds">10×</span>.</li>'
      +'<li><span class="bet-name">Carrier</span> (4 cells) — 2 hits pay <span class="odds">3×</span>, 3 hits pay <span class="odds">4×</span>, sinking it pays <span class="odds">40×</span>.</li>'
      +'</ul>'
      +'<h3>Extra Wins jackpot (stacks on top)</h3>'
      +'<p>Paid based on how many ships you\'ve sunk total this round: 2nd ship sunk adds <span class="odds">51×</span>, 3rd adds <span class="odds">251×</span>, and sinking all 4 adds <span class="odds">501×</span> your bet.</p>'
      +'<h3>Buy Missile</h3>'
      +'<p>Run out of missiles with ships still afloat? You can buy one more shot at a fair price before the round ends — you\'ll have 10 seconds to decide.</p>'
    }
  ] },
  uth: { title: '🃏 Ultimate Texas Hold\'em', pages: [
    { body:
      '<h3>The Core Loop</h3>'
      +'<p>Place an <span class="bet-name">Ante</span> — a matching <span class="bet-name">Blind</span> bet locks in automatically alongside it. You get 2 hole cards and play against the dealer\'s hand using 5 shared community cards, just like Texas Hold\'em, except you\'re playing against the house instead of other players.</p>'
      +'<ul>'
      +'<li><b>Pre-flop</b> (before any community cards): Check, or Raise 3x or 4x your Ante.</li>'
      +'<li><b>Flop</b> (after 3 community cards): if you checked pre-flop, Check again, or Raise 2x your Ante.</li>'
      +'<li><b>River</b> (after the last 2 community cards): if you still haven\'t raised, you must Raise exactly 1x your Ante or Fold.</li>'
      +'</ul>'
      +'<p>Folding forfeits your Ante, Blind, and Trips — no Play bet is made. Otherwise, the dealer needs a <b>pair or better to qualify</b>. Your Ante pushes if the dealer doesn\'t qualify; your Play bet always pays or loses 1:1 against the dealer\'s hand.</p>'
    },
    { heading:'Blind Payout', body:
      '<h3><span class="bet-name">Blind</span></h3>'
      +'<p>Only pays out when you win — and only pushes (returns your stake) if you win with less than a Straight. The better your final hand, the bigger the multiplier:</p>'
      +'<ul>'
      +'<li>Royal Flush — <span class="odds">500:1</span></li>'
      +'<li>Straight Flush — <span class="odds">50:1</span></li>'
      +'<li>Four of a Kind — <span class="odds">10:1</span></li>'
      +'<li>Full House — <span class="odds">3:1</span></li>'
      +'<li>Flush — <span class="odds">3:2</span></li>'
      +'<li>Straight — <span class="odds">1:1</span></li>'
      +'<li>Anything else (win) — Push</li>'
      +'</ul>'
    },
    { heading:'Trips & The Light', body:
      '<h3><span class="bet-name">Trips</span> (optional side bet)</h3>'
      +'<p>Pays on your best 7-card hand regardless of how the main hand plays out — win, lose, or fold. Needs three of a kind or better:</p>'
      +'<ul>'
      +'<li>Royal Flush — <span class="odds">50:1</span></li>'
      +'<li>Straight Flush — <span class="odds">40:1</span></li>'
      +'<li>Four of a Kind — <span class="odds">30:1</span></li>'
      +'<li>Full House — <span class="odds">8:1</span></li>'
      +'<li>Flush — <span class="odds">6:1</span></li>'
      +'<li>Straight — <span class="odds">5:1</span></li>'
      +'<li>Three of a Kind — <span class="odds">3:1</span></li>'
      +'</ul>'
      +'<h3><span class="bet-name">The Light</span> (progressive jackpot)</h3>'
      +'<p>Flat $5 side bet on your final hand. Royal Flush wins the whole pool, Straight Flush wins 10% of the pool, Four of a Kind pays $75, Full House pays $10.</p>'
    }
  ] },
  iluvsuits: { title: '♠️ I ❤️ Suits', pages: [
    { body:
      '<h3>The Core Loop</h3>'
      +'<p>Place your Ante and deal — you and the dealer each get <b>7 cards</b>, no shared community cards. <b>Best Flush Wins</b>: your hand strength is simply whichever suit you hold the most of, tie-broken by the highest ranks in that suit.</p>'
      +'<p>After seeing your cards, either <b>Fold</b> (lose your Ante) or <b>Play</b>, raising a multiple of your Ante based on how strong your flush is: <span class="odds">1×</span> for a 3–4 card flush, <span class="odds">2×</span> for a 5-card flush, <span class="odds">3×</span> for a 6–7 card flush. A bare 2-card flush ("Rainbow, No Flush") is the worst possible hand and can only be folded.</p>'
      +'<p>The dealer needs a 3-card flush headed by a 9 or better (or any 4+ card flush) to qualify. If the dealer doesn\'t qualify, your Ante wins/pushes accordingly; either way your Play bet compares your flush against the dealer\'s.</p>'
    },
    { heading:'Flush Rush & Super Flush Rush', body:
      '<h3><span class="bet-name">Flush Rush</span> (optional side bet)</h3>'
      +'<p>Pays on your own final flush strength, independent of how the hand plays out against the dealer. Paytable is posted right on the felt around the bet spot.</p>'
      +'<h3><span class="bet-name">Super Flush Rush</span> (optional side bet)</h3>'
      +'<p>Pays on the best straight flush (consecutive ranks, same suit) hiding anywhere in your 7 cards. Can pay up to <span class="odds">8000:1</span> on the very best hands. Paytable posted on the felt.</p>'
    },
    { heading:'The Light', body:
      '<h3><span class="bet-name">The Light</span> (progressive jackpot)</h3>'
      +'<p>Flat $5 side bet on the best straight flush in your own 7 cards. 7-Card Straight Flush wins the whole pool, 6-Card wins 10% of the pool, 5-Card pays $75, 4-Card pays $10.</p>'
    }
  ] },
  breakout: { title: '🃏 Breakout Blackjack', pages: [
    { body:
      '<h3>The Core Loop</h3>'
      +'<p>Two different ways to bet each hand: the <b>blue Player Bet</b> spot plays a normal hand of blackjack for you — Hit, Stand, Double, Split, and (Tier 2+) Surrender are all available on your first decision. The <b>red Breakout Bet</b> spot instead wagers on the <i>dealer\'s</i> outcome — the hand plays out automatically with no decisions from you.</p>'
      +'<p>Standard blackjack rules apply on the Player side: beat the dealer\'s total without busting over 21, or let the dealer bust instead. Double is only available as your very first move; Split needs a matching pair and is capped at 3 splits. Insurance is offered whenever the dealer shows an Ace.</p>'
    },
    { heading:'Breakout Side Bets', body:
      '<h3><span class="bet-name">Super Tie</span> (Breakout Bet only, $5 min)</h3>'
      +'<p>Wins if the player and dealer hands tie: Blackjack tie <span class="odds">25:1</span>, 21 tie <span class="odds">15:1</span>, 20 tie <span class="odds">8:1</span>, 17–19 tie <span class="odds">3:1</span>, both hands bust <span class="odds">1:1</span>.</p>'
      +'<h3><span class="bet-name">Breakout Bonus</span> (Breakout Bet only)</h3>'
      +'<p>Wins only when <i>both</i> the player and dealer bust in the same hand — payout scales with how many total cards it took: 12+ cards <span class="odds">250:1</span>, 11 cards <span class="odds">150:1</span>, 10 cards <span class="odds">100:1</span>, 9 cards <span class="odds">30:1</span>, 8 cards <span class="odds">15:1</span>, 6–7 cards <span class="odds">5:1</span>.</p>'
    },
    { heading:'Other Side Bets', body:
      '<h3><span class="bet-name">Sweet 17</span></h3>'
      +'<p>Wins if the dealer finishes with exactly 17. Pays <span class="odds">6:1</span>.</p>'
      +'<h3><span class="bet-name">Pair Up</span></h3>'
      +'<p>Bet on your own opening two cards: any pair pays <span class="odds">3:1</span>, a suited pair pays <span class="odds">5:1</span>, and both hands (yours and the dealer\'s) pairing pays <span class="odds">50:1</span>.</p>'
      +'<h3><span class="bet-name">The Light</span> (progressive jackpot)</h3>'
      +'<p>Flat $5 shared jackpot bet — available in either game mode, paytable shown in its own popup.</p>'
    }
  ] },
  paigow: { title: '🀄 Face Up Pai Gow', pages: [
    { body:
      '<h3>The Core Loop</h3>'
      +'<p>Place an Ante and deal — you and the dealer each get 7 cards, all dealt face up. You split your 7 cards into a <b>5-card High hand</b> and a <b>2-card Low hand</b> by clicking any 2 cards to form your Low hand (the rest become your High hand). Your Low hand must not outrank your High hand, or it\'s an illegal ("foul") set. Not sure how to set it? Tap <b>Set House Way</b> to have the house arrange it for you.</p>'
      +'<p>The dealer\'s hand is always split by a fixed house-way formula — no dealer judgment involved. Whoever wins both the High and Low comparisons wins the Ante at even money; split it one-and-one and it\'s a push; lose both and you lose the Ante. <b>Ties on either hand go to the dealer.</b> If the dealer\'s High hand is no better than Ace-high, your Ante automatically pushes.</p>'
      +'<p>There\'s no commission — but in exchange, if your own 7 cards make a natural Seven Card Straight Flush, that win pushes instead of paying. A single Joker acts as a bug: it fills in as the highest possible card for a straight or flush, or counts as an Ace otherwise.</p>'
    },
    { heading:'Fortune & The Light', body:
      '<h3><span class="bet-name">Fortune</span> (optional side bet)</h3>'
      +'<p>Pays on your own best 7-card hand, independent of how the Ante plays out. Needs three of a kind or better:</p>'
      +'<ul>'
      +'<li>Seven Card Straight Flush — <span class="odds">8000:1</span></li>'
      +'<li>Five Aces (four Aces + Joker) — <span class="odds">400:1</span></li>'
      +'<li>Royal Flush — <span class="odds">150:1</span></li>'
      +'<li>Straight Flush — <span class="odds">50:1</span></li>'
      +'<li>Four of a Kind — <span class="odds">25:1</span></li>'
      +'<li>Full House — <span class="odds">5:1</span></li>'
      +'<li>Flush — <span class="odds">4:1</span></li>'
      +'<li>Three of a Kind — <span class="odds">3:1</span></li>'
      +'<li>Straight — <span class="odds">2:1</span></li>'
      +'</ul>'
      +'<h3><span class="bet-name">The Light</span> (progressive jackpot)</h3>'
      +'<p>Flat $5 side bet on your own hand. Royal Flush wins the whole pool, Straight Flush wins 10% of the pool, Four of a Kind pays $75, Full House pays $10.</p>'
    }
  ] }
};

var CSS = ''
+'.instr-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:200;display:flex;align-items:center;justify-content:center;padding:12px}'
+'.instr-overlay.hidden{display:none}'
+'.instr-box{background:#1a1a1a;border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:18px 18px 14px;width:100%;max-width:420px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.6)}'
+'.instr-header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:2px}'
+'.instr-title{font-size:19px;font-weight:800;color:#ffd700}'
+'.instr-close{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.25);border-radius:6px;color:#fff;font-size:14px;width:28px;height:28px;cursor:pointer;flex-shrink:0}'
+'.instr-close:hover{background:rgba(255,255,255,.2)}'
+'.instr-pagehead{font-size:14px;font-weight:700;color:rgba(255,255,255,.5);text-transform:uppercase;letter-spacing:.04em;margin:10px 0 8px}'
+'.instr-body{overflow-y:auto;font-size:14.5px;line-height:1.5;color:rgba(255,255,255,.88);flex:1;min-height:0}'
+'.instr-body h3{font-size:15.5px;color:#ffe066;margin:12px 0 4px}'
+'.instr-body h3:first-child{margin-top:0}'
+'.instr-body p{margin:0 0 8px}'
+'.instr-body ul{margin:0 0 10px;padding-left:19px}'
+'.instr-body li{margin-bottom:6px}'
+'.instr-body .odds{color:#7ee87e;font-weight:700;white-space:nowrap}'
+'.instr-body .bet-name{color:#7ab4ff;font-weight:700}'
+'.instr-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.1)}'
+'.instr-nav-btn{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.25);border-radius:6px;color:#fff;font-size:14px;padding:8px 14px;cursor:pointer}'
+'.instr-nav-btn:hover:not(:disabled){background:rgba(255,255,255,.2)}'
+'.instr-nav-btn:disabled{opacity:.3;cursor:default}'
+'.instr-dots{display:flex;gap:6px}'
+'.instr-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.25)}'
+'.instr-dot.active{background:#ffd700}'
+'.info-circle-btn{background:rgba(15,15,15,.82);border:1.5px solid rgba(255,215,0,.7);color:#ffd700;border-radius:50%;width:26px;height:26px;min-width:26px;font-size:14px;font-weight:800;font-style:italic;font-family:Georgia,serif;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;line-height:1;box-shadow:0 1px 4px rgba(0,0,0,.5)}'
+'.info-circle-btn:hover{background:rgba(40,30,0,.9);border-color:#fff0a0;color:#fff0a0}'
+'.lobby-tile .info-circle-btn{position:absolute;top:8px;left:8px;z-index:2}';

var styleEl = document.createElement('style');
styleEl.textContent = CSS;
document.head.appendChild(styleEl);

var overlay, titleEl, pageheadEl, bodyEl, dotsEl, prevBtn, nextBtn;
var state = { gameId: null, page: 0 };

function build(){
  overlay = document.createElement('div');
  overlay.className = 'instr-overlay hidden';
  overlay.id = 'instr-overlay';
  overlay.onclick = function(e){ if(e.target === overlay) close(); };
  overlay.innerHTML =
    '<div class="instr-box">'
      +'<div class="instr-header"><div class="instr-title" id="instr-title"></div><button class="instr-close" id="instr-close" title="Close">✕</button></div>'
      +'<div class="instr-pagehead" id="instr-pagehead"></div>'
      +'<div class="instr-body" id="instr-body"></div>'
      +'<div class="instr-footer">'
        +'<button class="instr-nav-btn" id="instr-prev">‹ Prev</button>'
        +'<div class="instr-dots" id="instr-dots"></div>'
        +'<button class="instr-nav-btn" id="instr-next">Next ›</button>'
      +'</div>'
    +'</div>';
  document.body.appendChild(overlay);
  titleEl = document.getElementById('instr-title');
  pageheadEl = document.getElementById('instr-pagehead');
  bodyEl = document.getElementById('instr-body');
  dotsEl = document.getElementById('instr-dots');
  prevBtn = document.getElementById('instr-prev');
  nextBtn = document.getElementById('instr-next');
  document.getElementById('instr-close').onclick = close;
  prevBtn.onclick = function(){ render(state.page - 1); };
  nextBtn.onclick = function(){ render(state.page + 1); };
}

function render(pageIdx){
  var game = INSTRUCTIONS_DATA[state.gameId];
  if(!game) return;
  var pages = game.pages;
  pageIdx = Math.max(0, Math.min(pageIdx, pages.length - 1));
  state.page = pageIdx;
  titleEl.textContent = game.title;
  var page = pages[pageIdx];
  pageheadEl.textContent = pages.length > 1 ? (pageIdx === 0 ? 'Core Rules' : page.heading) : '';
  bodyEl.innerHTML = page.body;
  bodyEl.scrollTop = 0;
  prevBtn.disabled = pageIdx === 0;
  nextBtn.disabled = pageIdx === pages.length - 1;
  dotsEl.innerHTML = '';
  for(var i=0;i<pages.length;i++){
    var d = document.createElement('span');
    d.className = 'instr-dot' + (i === pageIdx ? ' active' : '');
    dotsEl.appendChild(d);
  }
}

function open(gameId){
  if(!overlay) build();
  var game = INSTRUCTIONS_DATA[gameId];
  if(!game || !game.pages.length){ console.warn('No instructions for', gameId); return; }
  state.gameId = gameId;
  render(0);
  overlay.classList.remove('hidden');
}

function close(){
  if(overlay) overlay.classList.add('hidden');
}

window.GameInstructions = { open: open, close: close, DATA: INSTRUCTIONS_DATA };

})();
