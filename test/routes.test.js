/**
 * Multi-hop routing: cycle search, exact evaluation across mixed pool types,
 * and the size optimiser against brute force.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRoute, optimizeRoute, findCycles, logRate } from "../dist/routes.js";
import { getSqrtRatioAtTick, clMaxInput } from "../dist/clmath.js";

const A = "0x000000000000000000000000000000000000000a";
const B = "0x000000000000000000000000000000000000000b";
const C = "0x000000000000000000000000000000000000000c";
const E18 = 10n ** 18n;

function v2(address, t0, t1, r0, r1, feePpm = 3000) {
  return { address, dex: "test-v2", token0: t0, token1: t1, reserve0: r0, reserve1: r1, feePpm, feeModel: "ppm" };
}

// A->B at 1:2, B->C at 1:3, C->A at 1:0.18 => product 1.08 before fees (~7% edge after 3 x 0.3%)
const pAB = v2("0xab", A, B, 1000n * E18, 2000n * E18);
const pBC = v2("0xbc", B, C, 1000n * E18, 3000n * E18);
const pCA = v2("0xca", A, C, 900n * E18, 5000n * E18);

test("findCycles finds the profitable triangle in the right direction only", () => {
  const cycles = findCycles([pAB, pBC, pCA], { startTokens: [A], maxHops: 3 });
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].tokens, [A, B, C, A]);
  assert.ok(cycles[0].logEdge > 0);
});

test("optimizeRoute matches a brute-force search and is exact", () => {
  const [route] = findCycles([pAB, pBC, pCA], { startTokens: [A], maxHops: 3 });
  const q = optimizeRoute(route);
  assert.ok(q && q.profit > 0n);
  // brute force on a coarse grid then fine grid around the best
  let best = 0n;
  let bestX = 0n;
  for (let x = E18; x <= 200n * E18; x += E18 / 4n) {
    const r = evaluateRoute(route, x);
    if (r && r.profit > best) {
      best = r.profit;
      bestX = x;
    }
  }
  assert.ok(q.profit >= best, `optimiser ${q.profit} < brute ${best} @ ${bestX}`);
  // exactness: re-evaluate at the chosen size gives the same numbers
  const again = evaluateRoute(route, q.amounts[0]);
  assert.deepEqual(again.amounts, q.amounts);
});

test("no cycles when prices are aligned", () => {
  const fair = v2("0xca", A, C, 1000n * E18, 6000n * E18); // 2 * 3 = 6: no edge
  assert.equal(findCycles([pAB, pBC, fair], { startTokens: [A], maxHops: 3 }).length, 0);
});

test("exclude predicate drops two-pool V2 routes", () => {
  const pAB2 = v2("0xab2", A, B, 1000n * E18, 2100n * E18);
  const all = findCycles([pAB, pAB2], { startTokens: [A], maxHops: 2 });
  assert.equal(all.length, 1);
  const none = findCycles([pAB, pAB2], { startTokens: [A], maxHops: 2, exclude: (ps) => ps.every((p) => !p.cl) });
  assert.equal(none.length, 0);
});

test("routes through a concentrated-liquidity pool respect its tick range", () => {
  // CL pool A/B priced at ~2.2 B per A (cheaper B than pAB): buy B on CL, sell on V2.
  const tick = Math.round(Math.log(2.2) / Math.log(1.0001));
  const cl = {
    sqrtPriceX96: getSqrtRatioAtTick(tick),
    tick,
    liquidity: 3n * 10n ** 20n,
    tickSpacing: 10,
    feePips: 500,
    words: new Map(),
  };
  // an initialized tick just below and above keeps the range narrow
  const c = Math.floor(tick / 10);
  const word = c >> 8;
  const bitBelow = (((c - 3) % 256) + 256) % 256;
  const bitAbove = (((c + 4) % 256) + 256) % 256;
  cl.words.set(word, (1n << BigInt(bitBelow)) | (1n << BigInt(bitAbove)));
  cl.words.set(word - 1, 0n);
  cl.words.set(word + 1, 0n);
  const r0 = 10n ** 20n;
  const pool = { address: "0xc1", dex: "test-cl", token0: A, token1: B, reserve0: r0, reserve1: (r0 * 22n) / 10n, feePpm: 500, feeModel: "ppm", cl };
  assert.ok(logRate(pool, A) > logRate(pAB, A));
  const [route] = findCycles([pool, pAB], { startTokens: [A], maxHops: 2 });
  assert.deepEqual(route.tokens, [A, B, A]);
  const q = optimizeRoute(route);
  assert.ok(q && q.profit > 0n);
  assert.ok(q.amounts[0] <= clMaxInput(cl, true), "first hop must stay inside the CL range");
  // A bigger trade than the range allows is infeasible, not silently mispriced.
  assert.equal(evaluateRoute(route, clMaxInput(cl, true) * 2n), null);
});
