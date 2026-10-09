/**
 * Block-time single source of truth (src/blocktime.ts): wall-clock thresholds
 * expressed as block counts, so they survive Base's Denim hardfork (200ms blocks)
 * by changing one env var. These tests pin the current 2s-block values (a
 * regression guard that today's behaviour is unchanged) and prove the rescale.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockTimeMs, blocksFor, PRECONF_TAG } from "../dist/blocktime.js";

function withBlockTime(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, "BLOCK_TIME_MS");
  const prev = process.env.BLOCK_TIME_MS;
  if (value === undefined) delete process.env.BLOCK_TIME_MS;
  else process.env.BLOCK_TIME_MS = value;
  try {
    fn();
  } finally {
    if (had) process.env.BLOCK_TIME_MS = prev;
    else delete process.env.BLOCK_TIME_MS;
  }
}

test("default block time is 2s (Base today)", () => {
  withBlockTime(undefined, () => {
    assert.equal(blockTimeMs(), 2000);
  });
});

test("current thresholds are unchanged at 2s blocks (regression guard)", () => {
  withBlockTime(undefined, () => {
    assert.equal(blocksFor(20 * 60_000), 600); // Scanner.failureMuteBlocks (20 min)
    assert.equal(blocksFor(20_000), 10); //       GasEstimator.l1RefreshBlocks (20 s)
    assert.equal(blocksFor(60_000), 30); //       FlashblockWatcher memory window (60 s)
  });
});

test("thresholds rescale 10x at Denim's 200ms blocks", () => {
  withBlockTime("200", () => {
    assert.equal(blockTimeMs(), 200);
    assert.equal(blocksFor(20 * 60_000), 6000); // same 20 min
    assert.equal(blocksFor(20_000), 100); //       same 20 s
    assert.equal(blocksFor(60_000), 300); //       same 60 s
  });
});

test("blocksFor never returns less than one block", () => {
  withBlockTime(undefined, () => {
    assert.equal(blocksFor(10), 1); // 10ms rounds to 0 blocks -> floored to 1
    assert.equal(blocksFor(0), 1);
  });
});

test("invalid or non-positive BLOCK_TIME_MS falls back to 2s", () => {
  for (const bad of ["abc", "0", "-200", ""]) {
    withBlockTime(bad, () => assert.equal(blockTimeMs(), 2000));
  }
});

test("PRECONF_TAG is the pending tag today", () => {
  assert.equal(PRECONF_TAG, "pending");
});
