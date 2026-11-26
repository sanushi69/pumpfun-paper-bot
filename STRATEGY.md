# Strategy

## The game

The replay hands the bot 10 SOL of paper money and 24 hours of pump.fun
bonding-curve events (CreateEvent / TradeEvent / CompleteEvent). The bot
answers every batch with up to 16 orders; orders decided on slot `s` fill at
slot `s + 2`. A buy pays 95 bps protocol + 30 bps creator fees on the curve
plus a base + priority transaction fee; a sell pays the same on the way out.
A round trip therefore costs about 2.5% of the stake in curve fees plus two
tx fees, so a trade needs a real move to pay — small stakes and few trades
are the whole game. Ranking is by Net PnL in lamports; a paid place needs
Net PnL above 0, at least 20 distinct coins with round trips of 0.01 SOL or
more, and max drawdown at most 50%.

## Entry: late breakouts only, and only the strong ones

Most pump.fun coins are dumped within minutes of launch. The bot never buys
a fresh curve: a coin must be at least 60 slots old, hold 1–10 SOL of real
reserves, and show, over the last 40 slots:

- net SOL inflow of at least 0.2 SOL (buys minus sells),
- at least 4 buy trades from at least 4 distinct wallets,
- price up at least 5% over the window and within 3% of the window high,
- no single wallet behind more than 45% of the window's buy SOL,
- no single sell of 2 SOL or more in the window,
- the creator has never sold.

Tuning on the dev window showed the entry filter is the whole edge: looser
tests (0.1 SOL inflow, 3% rise, 20-slot age) bought ~90 coins and bled fees
on churn, while this stricter test buys ~69 coins with a better win rate and
a third less in fees. Tightening further (0.3 SOL inflow, 8% rise, 100-slot
age) did not improve the score — it only concentrated the PnL in fewer
coins — so the filter sits at the flat spot, not on a peak.

## Sizing: one small buy, no adds

One buy of 0.10 SOL per coin, never added to. Adding into strength was tried
and removed: the adds bought into tops that then dumped, and every extra fill
paid the 2.5% round-trip fee again. Every buy is capped at 1% of the coin's
real SOL reserve (the harness cap) and by free cash. At most 5 positions open,
at most 8 SOL at cost in total. A coin is bought at most 3 times per run,
with a 120-slot cooldown after an exit.

## Exits: fast and mechanical

A position is re-priced every batch off the latest reserve marks (what a
full sell would actually return, fees deducted) and sold whole on the first
of:

- **take-profit** +150% over cost,
- **stop-loss** −6% under cost,
- **trailing stop**: once up 25%, a 15% fall from the peak value,
- **creator sell** while held,
- **time limit**: 3,600 slots held.

Two exits were tried and removed. A flow-reversal exit (sell on negative net
flow) realised losses early on noise and added churn without improving the
score. A wider stop (−12%) with a wider target (+35%) also scored worse:
losers bled more before the stop caught them. Tight exits win on this data.

The take-profit was tuned last and matters most: on the dev window the bot
scored −0.19 SOL at +20%, −0.04 at +50%, +0.02 at +75%, +0.04 at +100%,
+0.10 at +150% and +0.08 at +200%. The profit comes from the few coins that
run 2–3x; a small target sells them before they pay for the losers. +150%
sits on a flat top with +175% (+0.10), not on a peak. The trailing stop
still protects the +25%-and-up winners, and moving its arm to +50% or
removing it scored worse. Caveat: a 20-copy stress test of the +150% bot
has median −0.18 SOL with 17 of 20 copies losing money, so the dev score
leans on this window's particular runners — the final window is a fresh
draw, and this is the best-scoring variant measured, not a forecast.

## Guardrail pacing

If finished round trips lag the prorated target of 30 coins, the entry test
softens one notch (0.3 SOL net inflow, 5% rise, 100-slot age, 3 buyers) so
the run still clears the 20-coin guardrail instead of starving on
selectivity. The softer test keeps the same shape — broad buying, creator
holding, no whale dump — so it buys the same kind of coin, just earlier.

## Why it should beat the baselines

- **Equal-weight** buys every coin early and never sells: it holds rugs to
  zero, and with only 5 open slots it stops trading after its first 5 coins.
  This bot skips the launch phase entirely and cuts losers at −6%.
- **Hold-cash** scores exactly 0. Any positive Net PnL beats it.
- The house **momentum** pilot loses ~9.5 SOL on the dev window (95% max
  drawdown, tens of thousands of rejected orders); the **reversion** pilot
  loses ~4.0 SOL on 2,335 fills of fee churn; the **sniper** pilot loses
  ~0.47 SOL on 833 fills. This bot makes +0.10 SOL on the same window with
  154 fills and a 2.3% max drawdown — the least-bad of every bot measured —
  because it trades the least, cuts losers the fastest, and lets the few
  runners pay for the rest.
- The edge is discipline, not prediction: small stakes, few coins, winners
  ridden to +150% or trailed, losers cut quickly, and no position left to rot
  on a dead curve.

## Determinism

No clock, no randomness, no I/O, no environment reads. The bot is a pure
function of the batches it is fed (iteration only over insertion-ordered
maps fed by the batch stream), so the two grading runs produce byte-identical
action logs.
