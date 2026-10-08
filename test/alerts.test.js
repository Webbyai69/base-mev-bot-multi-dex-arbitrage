/**
 * Telegram alerts (src/alerts.ts): secrets are scrubbed, messages are
 * rate-limited, and only verified opportunities above the threshold alert.
 * Uses a fake fetch, so nothing is sent anywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Alerts, scrubUrls, telegramSetup } from "../dist/alerts.js";
import { Store } from "../dist/store.js";

const TOKEN = "123456789:AAEexampleexampleexampleexampleexample";
const KEY = "0x" + "cd".repeat(32);

function fakeFetch(reply = { ok: true }) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return { ok: reply.ok, status: reply.ok ? 200 : 400, text: async () => "", json: async () => reply.json ?? { ok: true } };
  };
  return { fn, calls };
}

test("RPC URLs lose their keys, and exact secrets never leave", () => {
  assert.equal(scrubUrls("failed: https://base-mainnet.g.alchemy.com/v2/AbC123 timeout"), "failed: https://base-mainnet.g.alchemy.com/… timeout");
  assert.equal(scrubUrls("x https://lb.drpc.org/ogrpc?network=base&dkey=SECRET y"), "x https://lb.drpc.org/ogrpc?network=base&dkey=… y");
  const a = new Alerts({ token: TOKEN, chatId: "1", mode: "paper", minOppUsd: 5, minLiqUsd: 25, secrets: [KEY, "https://my.node/abc"] });
  const out = a.scrub(`key ${KEY} bare ${KEY.slice(2)} token ${TOKEN} node https://my.node/abc`);
  assert.ok(!out.includes("cd".repeat(32)));
  assert.ok(!out.includes(TOKEN));
  assert.ok(!out.includes("my.node/abc"));
});

test("disabled without both a token and a chat id", async () => {
  const f = fakeFetch();
  const a = new Alerts({ token: TOKEN, mode: "paper", minOppUsd: 5, minLiqUsd: 25, fetchImpl: f.fn });
  assert.equal(a.enabled, false);
  assert.equal(await a.send("hi"), false);
  assert.equal(f.calls.length, 0);
});

test("at most N messages an hour, and per-kind cooldowns", async () => {
  const f = fakeFetch();
  const a = new Alerts({ token: TOKEN, chatId: "42", mode: "paper", minOppUsd: 5, minLiqUsd: 25, maxPerHour: 5, fetchImpl: f.fn });
  for (let i = 0; i < 8; i++) await a.send(`m${i}`);
  assert.equal(f.calls.length, 5);
  assert.equal(a.stats.suppressed, 3);
  const b = new Alerts({ token: TOKEN, chatId: "42", mode: "paper", minOppUsd: 5, minLiqUsd: 25, fetchImpl: f.fn });
  assert.equal(await b.send("x", "k", 60_000), true);
  assert.equal(await b.send("y", "k", 60_000), false);
  const last = f.calls.at(-1);
  assert.match(last.url, /\/bot123456789:[^/]+\/sendMessage$/);
  assert.equal(last.body.chat_id, "42");
  assert.equal(last.body.parse_mode, "HTML");
});

test("only verified opportunities over the threshold alert, with names escaped", async () => {
  const f = fakeFetch();
  const store = new Store(mkdtempSync(join(tmpdir(), "alerts-")));
  const a = new Alerts({ token: TOKEN, chatId: "42", mode: "paper", minOppUsd: 5, minLiqUsd: 25, fetchImpl: f.fn });
  a.watch(store);
  const opp = (over) => ({ kind: "opportunity", id: Math.random().toString(16), block: 9, pairSymbols: "WETH/<b>EVIL</b>", buyPool: "0xa", sellPool: "0xb", buyDex: "aerodrome", sellDex: "uniswap-v2", profitUsd: 12, gasUsd: 0.1, ...over });
  store.append("opportunities.jsonl", opp({ netUsd: 50, sim: "local" })); // not verified
  store.append("opportunities.jsonl", opp({ netUsd: 2, sim: "executor-ok" })); // below threshold
  store.append("opportunities.jsonl", opp({ netUsd: 11.9, sim: "executor-ok" }));
  await a.flush();
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].body.text.includes("WETH/&lt;b&gt;EVIL&lt;/b&gt;"));
  assert.ok(f.calls[0].body.text.includes("$11.90"));
  store.append("liquidations.jsonl", { kind: "liq-opportunity", user: "0xu", estProfitUsd: 30, repayUsd: 900, debtSymbol: "USDC", collateralSymbol: "WETH", bonusPct: 5, healthFactor: 0.98 });
  store.append("liquidations.jsonl", { kind: "liq-opportunity", user: "0xv", estProfitUsd: 3, repayUsd: 90, debtSymbol: "USDC", collateralSymbol: "WETH", bonusPct: 5, healthFactor: 0.98 });
  await a.flush();
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].body.text, /Liquidatable Aave position/);
});

test("a stalled block feed alerts once, and its recovery once", async () => {
  const f = fakeFetch();
  const a = new Alerts({ token: TOKEN, chatId: "42", mode: "paper", minOppUsd: 5, minLiqUsd: 25, fetchImpl: f.fn });
  const lastAt = Date.now() - 200_000;
  a.watchdog(100, lastAt);
  a.watchdog(100, lastAt);
  await a.flush();
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].body.text, /No new blocks/);
  a.blockProcessed(101);
  a.blockProcessed(102);
  await a.flush();
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].body.text, /flowing again/);
});

test("telegram setup finds the chat id from the bot's messages", async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...x) => logs.push(x.join(" "));
  try {
    assert.equal(await telegramSetup(undefined, undefined), 1);
    const f = fakeFetch({ ok: true, json: { ok: true, result: [{ message: { chat: { id: 5551234, type: "private", username: "josh" } } }] } });
    assert.equal(await telegramSetup(TOKEN, undefined, f.fn), 0);
    assert.ok(logs.some((l) => l.includes("TELEGRAM_CHAT_ID=5551234")));
    assert.ok(!logs.some((l) => l.includes(TOKEN)), "the token is never printed");
  } finally {
    console.log = orig;
  }
});
