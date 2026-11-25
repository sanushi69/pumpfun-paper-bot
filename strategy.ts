// Pump.fun Replay Sprint — entry 1.
//
// A late-breakout paper bot for agent-fun/replay/v2. The idea: most pump.fun
// coins die within minutes of launch, so the bot never touches a fresh curve.
// It waits until a coin has survived its launch phase, then buys only when the
// recent tape shows broad, accelerating buying (many distinct wallets, net SOL
// flowing in, price pushing to a new high) with the creator still holding. It
// sizes in small, adds only into strength, and exits fast: a fixed take-profit,
// a tight stop, a trailing stop once a position is up, a flow-reversal exit,
// an exit the moment the creator sells, and a hard time limit. No clock, no
// randomness, no I/O: a pure function of the batches the harness sends, so the
// two grading runs produce identical action logs.
//
// How the wire works (from the kit protocol): the harness opens with a hello
// line (capital, caps, fees, latency in slots), then sends one batch per slot
// with that slot's events, reserve marks, fills and the account, and the bot
// answers each batch with one reply echoing its seq. Orders decided on the
// batch for slot s fill at slot s + latency (2 slots), so every decision is
// made on reserves that are already two slots old. A buy spends quote
// lamports and pays 95 bps protocol + 30 bps creator fees on the curve plus
// one base + priority tx fee; a sell returns tokens * vq / (vt + t) quote
// before the same fees. A round trip therefore costs roughly 2.5% of the
// stake in curve fees plus two tx fees, which is why the first buy is sized
// at 0.06 SOL (the tx fees are then a small share of the stake) and why the
// take-profit sits far above the stop: losers are cut at -12% while winners
// are ridden to +35% or trailed.

import {
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // 95 bps protocol + 30 bps creator, charged per side.
const BPS = 10_000;

/** Tunable knobs, chosen on the dev window and kept in flat regions, not peaks. */
export interface Params {
  /** Slots of tape looked at for an entry decision. */
  lookback: number;
  /** Slots a curve must have lived before it may be bought. */
  minAge: number;
  /** Net SOL (buys minus sells) over the lookback that an entry needs. */
  minNetSol: number;
  /** Buy trades in the lookback. */
  minBuys: number;
  /** Distinct buying wallets in the lookback. */
  minBuyers: number;
  /** Price now over price at the lookback start, minus 1. */
  minRise: number;
  /** Price now must be at least this share of the lookback high. */
  nearHigh: number;
  /** Largest single wallet's share of the lookback's buy SOL, at most. */
  maxTopBuyer: number;
  /** Real SOL reserve window at entry. */
  minRealSol: number;
  maxRealSol: number;
  /** A single recorded sell this big in the lookback vetoes the entry. */
  maxSingleSellSol: number;
  /** First buy per coin (SOL). */
  firstBuySol: number;
  /** Each add-on buy (SOL). */
  addBuySol: number;
  /** Most SOL put into one coin in total. */
  maxPerCoinSol: number;
  /** Slots to wait between two buys on the same coin. */
  addGap: number;
  /** An add needs the price this far above the previous buy's price. */
  addStep: number;
  /** Slippage allowed on buys (bps); sells go out wide open. */
  buySlipBps: number;
  /** Sell everything once the position is worth this much over cost. */
  takeProfit: number;
  /** Sell everything once the position is worth this much under cost. */
  stopLoss: number;
  /** Trailing stop arms once the position is up this much over cost. */
  trailArm: number;
  /** Once armed, sell on a fall of this much from the position's peak value. */
  trailGiveback: number;
  /** Sell when net SOL over this many slots falls below -flowExitSol. */
  flowWindow: number;
  flowExitSol: number;
  /** Sell after holding this many slots (unless already deep in profit). */
  maxHold: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the whole run. */
  maxEntriesPerCoin: number;
  /** Most positions open at once (the harness cap is 5). */
  maxPositions: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Pacing: distinct coins with a finished round trip the run aims for. */
  targetCoins: number;
  /** Block-time seconds the pacing target is spread over. */
  paceSeconds: number;
}

export const DEFAULT_PARAMS: Params = {
  lookback: 24,
  minAge: 200,
  minNetSol: 0.5,
  minBuys: 4,
  minBuyers: 4,
  minRise: 0.08,
  nearHigh: 0.97,
  maxTopBuyer: 0.45,
  minRealSol: 1,
  maxRealSol: 40,
  maxSingleSellSol: 2,
  firstBuySol: 0.06,
  addBuySol: 0.06,
  maxPerCoinSol: 0.3,
  addGap: 4,
  addStep: 0.05,
  buySlipBps: 1000,
  takeProfit: 0.35,
  stopLoss: 0.12,
  trailArm: 0.15,
  trailGiveback: 0.12,
  flowWindow: 12,
  flowExitSol: 0.4,
  maxHold: 900,
  cooldown: 120,
  maxEntriesPerCoin: 3,
  maxPositions: 5,
  maxExposureSol: 8,
  targetCoins: 30,
  paceSeconds: 14_400,
};

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  creatorSold: boolean;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peak: number; // Best close value seen, SOL.
  invested: number; // SOL sent in buys for this position (fees included).
  lastAddSlot: number;
  lastAddPrice: number;
  exiting: boolean;
}

export function createBot(p: Params = DEFAULT_PARAMS) {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Coins with a finished round trip (a buy filled and the position fully sold). */
  const finishedCoins = new Set<Pubkey>();
  /** Coins with at least one filled buy. */
  const boughtCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, creatorSold: false, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net SOL (buys minus sells) on a tape over the last `w` slots. */
  const netFlow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** The entry test. `loose` is the pacing fallback: same shape, softer numbers. */
  const entryOk = (t: Tape, now: number, realSol: number, loose: boolean): boolean => {
    if (t.created === null || now - t.created < (loose ? 100 : p.minAge)) return false;
    if (t.creatorSold) return false;
    if (realSol < p.minRealSol || realSol > p.maxRealSol) return false;
    const from = now - p.lookback;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    let bigSell = false;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
        if (tr.sol >= p.maxSingleSellSol) bigSell = true;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (bigSell) return false;
    if (buys < (loose ? 3 : p.minBuys) || byUser.size < (loose ? 3 : p.minBuyers)) return false;
    if (buySol - sellSol < (loose ? 0.3 : p.minNetSol)) return false;
    if (startPrice <= 0 || last <= 0) return false;
    if (last / startPrice - 1 < (loose ? 0.05 : p.minRise)) return false;
    if (last < high * p.nearHigh) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (buySol > 0 && top > p.maxTopBuyer * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;
      const cap = state.hello.caps.max_orders_per_batch;
      const traded = new Set<Pubkey>();
      const creatorSoldNow = new Set<Pubkey>();

      // Fold the batch's fills and events into the tapes.
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) boughtCoins.add(f.mint);
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && t.creator !== null && e.user === t.creator) {
            t.creatorSold = true;
            creatorSoldNow.add(e.mint);
          }
        }
      }
      // Prune old tape entries, only for coins that traded this batch.
      const keepFrom = now - Math.max(p.lookback, p.flowWindow) - 5;
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= keepFrom) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingSell = new Set<Pubkey>();
      const pendingBuy = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
        else pendingBuy.add(po.order.mint);
      }

      const orders: OrderInput[] = [];

      // ---- Exits first: every held position is re-priced off the latest marks.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          // Position gone (sold, completed or flattened): record the round trip.
          if (!pendingBuy.has(mint) && !pendingSell.has(mint)) {
            held.delete(mint);
            if (boughtCoins.has(mint)) finishedCoins.add(mint);
            tapeOf(mint).lastExit = now;
          }
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = Number(mk ? mk.virtual_quote_reserves : curve.virtual_quote_reserves);
        const vt = Number(mk ? mk.virtual_token_reserves : curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        // What a sell of the whole position would return, curve fee and tx fee deducted.
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - txSol;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peak) h.peak = value;
        let exit = false;
        if (value >= cost * (1 + p.takeProfit)) exit = true;
        else if (value <= cost * (1 - p.stopLoss)) exit = true;
        else if (h.peak >= cost * (1 + p.trailArm) && value <= h.peak * (1 - p.trailGiveback)) exit = true;
        else if (creatorSoldNow.has(mint)) exit = true;
        else if (netFlow(tapeOf(mint), now, p.flowWindow) < -p.flowExitSol) exit = true;
        else if (now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        if (pendingSell.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS });
        h.exiting = true;
      }

      // ---- Entries and adds, in the order the batch's coins traded.
      // Pacing: if finished round trips lag the prorated target, soften the entry test
      // so the run still clears the 20-coin guardrail instead of starving on selectivity.
      let loose = false;
      if (firstBlockTime !== null && lastBlockTime !== null) {
        const pace = Math.min(1, (lastBlockTime - firstBlockTime) / p.paceSeconds);
        if (finishedCoins.size < Math.ceil(p.targetCoins * pace) && pace > 0.05) loose = true;
      }
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        exposure += Math.max(h.invested, Number(pos?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (pendingBuy.has(mint) || pendingSell.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tapes.get(mint)!;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const h = held.get(mint);
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0) continue;
          if (t.entries >= p.maxEntriesPerCoin || now - t.lastExit < p.cooldown) continue;
          if (!entryOk(t, now, realSol, loose)) continue;
          want = p.firstBuySol;
        } else {
          // Add only into strength: price stepped up since the last buy, the position
          // is not exiting, and fresh net flow is still positive.
          if (h.exiting || h.invested >= p.maxPerCoinSol - 0.001) continue;
          if (now - h.lastAddSlot < p.addGap) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (netFlow(t, now, p.lookback) <= 0) continue;
          if (realSol > p.maxRealSol) continue;
          want = Math.min(p.addBuySol, p.maxPerCoinSol - h.invested);
        }
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - txSol) amount = free - txSol;
        if (amount < 0.01) continue; // A round trip under 0.01 SOL does not count.
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + txSol;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            peak: 0,
            invested: amount,
            lastAddSlot: now,
            lastAddPrice: price,
            exiting: false,
          });
          t.entries++;
          slotsLeft--;
        } else {
          h.invested += amount;
          h.lastAddSlot = now;
          h.lastAddPrice = price;
        }
      }
      return orders;
    },
  };
}

export async function main(): Promise<void> {
  await runBot(createBot(DEFAULT_PARAMS));
}
