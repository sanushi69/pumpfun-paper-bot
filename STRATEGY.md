# Strategy

## The game

The replay hands the bot 10 SOL of paper money and 24 hours of pump.fun
bonding-curve events (CreateEvent / TradeEvent / CompleteEvent). The bot
answers every batch with up to 16 orders; orders decided on slot `s` fill at
slot `s + 2`. A buy pays 95 bps protocol + 30 bps creator fees on the curve
plus a base + priority transaction fee; a sell pays the same on the way out.
A round trip therefore costs about 2.5% of the stake in curve fees plus two
tx fees, so a trade needs a real move to pay — small stakes and tight exits
are the whole game. Ranking is by Net PnL in lamports; a paid place needs
Net PnL above 0, at least 20 distinct coins with round trips of 0.01 SOL or
more, and max drawdown at most 50%.

## Entry: late breakouts only

Most pump.fun coins are dumped within minutes of launch. The bot never buys
a fresh curve: a coin must be at least 200 slots old, hold 1–40 SOL of real
reserves, and show, over the last 24 slots:

- net SOL inflow of at least 0.5 SOL (buys minus sells),
- at least 4 buy trades from at least 4 distinct wallets,
- price up at least 8% over the window and within 3% of the window high,
- no single wallet behind more than 45% of the window's buy SOL,
- no single sell of 2 SOL or more in the window,
- the creator has never sold.

A coin is bought at most 3 times per run, with a 120-slot cooldown after an
exit.

## Sizing: small first, add into strength

First buy 0.06 SOL — big enough that the two tx fees are a small share of
the stake, small enough that a loser costs little. While the price keeps
stepping up (≥5% above the last buy's price, at least 4 slots later) and net
flow stays positive, the bot adds 0.06 SOL at a time up to 0.30 SOL per coin.
Every buy is capped at 1% of the coin's real SOL reserve (the harness cap)
and by free cash. At most 5 positions open, at most 8 SOL at cost in total.

## Exits: fast and mechanical

A position is re-priced every batch off the latest reserve marks (what a
full sell would actually return, fees deducted) and sold whole on the first
of:

- **take-profit** +35% over cost,
- **stop-loss** −12% under cost,
- **trailing stop**: once up 15%, a 12% fall from the peak value,
- **flow reversal**: net SOL over the last 12 slots below −0.4 SOL,
- **creator sell** while held,
- **time limit**: 900 slots held.

## Guardrail pacing

If finished round trips lag the prorated target of 30 coins, the entry test
softens one notch (0.3 SOL net inflow, 5% rise, 100-slot age, 3 buyers) so
the run still clears the 20-coin guardrail instead of starving on
selectivity. The softer test keeps the same shape — broad buying, creator
holding, no whale dump — so it buys the same kind of coin, just earlier.

## Why it should beat the baselines

- **Equal-weight** buys every coin early and never sells: it holds rugs to
  zero. This bot skips the launch phase entirely and cuts losers at −12%.
- **Hold-cash** scores exactly 0. Any positive Net PnL beats it.
- The edge is discipline, not prediction: small stakes, many coins, winners
  ridden to +35% or trailed, losers cut quickly, and no position left to rot
  on a dead curve.

## Determinism

No clock, no randomness, no I/O, no environment reads. The bot is a pure
function of the batches it is fed (iteration only over insertion-ordered
maps fed by the batch stream), so the two grading runs produce byte-identical
action logs.
