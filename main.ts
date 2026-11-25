// Pump.fun Replay Sprint — Paper Bot, Real Ranking.
// Entry 1. The grader runs `node /bot/main.ts`; the strategy lives in
// strategy.ts and the wire shim is the kit's sdk/ts/makefun-bot.ts, vendored
// byte for byte under vendor/.

import { main } from './strategy.ts';

await main();
