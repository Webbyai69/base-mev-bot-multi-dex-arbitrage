/* Network page of the Qortal app: bridge connection, the Base node registry on
   QDN, and public status snapshots. Everything from QDN or the bridge is
   treated as untrusted and rendered with textContent only. */
import { NODES_IDENTIFIER, QDN_SERVICE, KINDS, buildRegistry, checkNode, checkRegistry, mergeRegistries } from "./lib/registry.mjs";
import { STATUS_IDENTIFIER, checkStatus } from "./lib/status.mjs";

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, kids = []) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") e.textContent = v;
    else if (k === "cls") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids) e.append(c);
  return e;
};
const say = (box, kind, text) => {
  box.hidden = false;
  box.className = "result " + kind;
  box.textContent = text;
};
const errText = (e) => String((e && (e.message || e.error)) || e).slice(0, 220);

/* ---------------- Qortal access ---------------- */
/* qortalRequest is a bare global in Qortal apps, not a window property. */
const Q = typeof qortalRequest === "function" ? qortalRequest : null; // eslint-disable-line no-undef
const onQortal = !!Q;
$("#qstate").textContent = onQortal ? "in Qortal" : "outside Qortal: reading and publishing need Qortal Hub";
if (onQortal) $("#qstate").classList.add("on");

const b64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

async function qSearch(identifier) {
  if (Q) return Q({ action: "SEARCH_QDN_RESOURCES", service: QDN_SERVICE, identifier, mode: "ALL", limit: 50, reverse: true });
  const r = await fetch(`/arbitrary/resources/search?service=${QDN_SERVICE}&identifier=${encodeURIComponent(identifier)}&prefix=false&mode=ALL&limit=50&reverse=true`);
  if (!r.ok) throw new Error("Open this app in Qortal Hub to read lists from Qortal");
  return r.json();
}

async function qFetch(name, identifier) {
  if (Q) {
    const d = await Q({ action: "FETCH_QDN_RESOURCE", service: QDN_SERVICE, name, identifier });
    return typeof d === "string" ? d : JSON.stringify(d);
  }
  const r = await fetch(`/arbitrary/${QDN_SERVICE}/${encodeURIComponent(name)}/${encodeURIComponent(identifier)}`);
  if (!r.ok) throw new Error(`no ${identifier} published by ${name}`);
  return r.text();
}

let myName;
async function qMyName() {
  if (myName !== undefined) return myName;
  if (!Q) throw new Error("Open this app in Qortal Hub to publish");
  const acct = await Q({ action: "GET_USER_ACCOUNT" });
  const names = await Q({ action: "GET_ACCOUNT_NAMES", address: acct && acct.address });
  const list = (Array.isArray(names) ? names : []).map((n) => (typeof n === "string" ? n : n && n.name)).filter(Boolean);
  myName = list[0] || null;
  return myName;
}

async function qPublish(identifier, doc, title, description) {
  const name = await qMyName();
  if (!name) throw new Error("Publishing on Qortal needs a registered name on this account. Register one in Qortal Hub first.");
  await Q({ action: "PUBLISH_QDN_RESOURCE", name, service: QDN_SERVICE, identifier, data64: b64(JSON.stringify(doc, null, 2)), filename: `${identifier}.json`, title, description });
  return name;
}

/* ---------------- bridge ---------------- */
const BRIDGE_KEY = "baq.bridge";
const DEFAULT_BRIDGE = "http://127.0.0.1:8790";
const bridgeInput = $("#bridgeUrl");
try {
  bridgeInput.value = localStorage.getItem(BRIDGE_KEY) || DEFAULT_BRIDGE;
} catch {
  /* storage blocked */
}
const bridgeUrl = () => bridgeInput.value.trim().replace(/\/+$/, "");
const loopback = (u) => {
  try {
    const h = new URL(u).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
  } catch {
    return false;
  }
};

async function testBridge() {
  const box = $("#bridgeRes");
  const u = bridgeUrl();
  if (!loopback(u)) return say(box, "err", "The bridge runs on this machine: use an address on 127.0.0.1 or localhost."), false;
  try {
    const h = await (await fetch(u + "/bridge/health", { cache: "no-store", signal: AbortSignal.timeout(4000) })).json();
    if (!h || !h.ok) throw new Error("not a bridge");
    if (!h.bot || !h.bot.reachable) return say(box, "warn", "The bridge answers, but it can't reach the bot. Is the bot running?"), false;
    say(box, "ok", `Connected. The bot is ${h.bot.running ? "running" : "not running"} in ${h.bot.mode || "an unknown"} mode${h.bot.version ? ", version " + h.bot.version : ""}. Read-only.`);
    return true;
  } catch (e) {
    say(box, "err", `No bridge at ${u}. Start it on the bot's machine with npm run qortal:bridge. (${errText(e)})`);
    return false;
  }
}
$("#bridgeTest").addEventListener("click", testBridge);
$("#bridgeSave").addEventListener("click", async () => {
  if (!(await testBridge())) return;
  try {
    localStorage.setItem(BRIDGE_KEY, bridgeUrl());
  } catch {
    /* storage blocked: the default address still works */
  }
  location.href = "index.html";
});

/* ---------------- node registry ---------------- */
let rows = []; // merged nodes with timing
function renderNodes() {
  const body = $("#nodesBody");
  body.replaceChildren();
  if (!rows.length) {
    body.append(el("tr", {}, [el("td", { colspan: "8", cls: "empty", text: "No usable nodes in the lists loaded." })]));
    return;
  }
  const sorted = rows.slice().sort((a, b) => (a.t && a.t.p50 != null ? a.t.p50 : 1e9) - (b.t && b.t.p50 != null ? b.t.p50 : 1e9));
  for (const n of sorted) {
    const status = !n.t ? el("span", { cls: "muted", text: "not timed" }) : n.t.error ? el("span", { cls: "bad", text: n.t.error }) : n.t.skipped ? el("span", { cls: "muted", text: n.t.skipped }) : el("span", { cls: "ok", text: "answering" });
    body.append(
      el("tr", {}, [
        el("td", {}, [el("span", { text: n.label }), el("span", { cls: "host", text: n.host })]),
        el("td", { text: n.region }),
        el("td", { text: n.kind }),
        el("td", { text: (n.publishers || []).join(", ") || "file" }),
        el("td", { cls: "num", text: n.measured ? String(n.measured.p50Ms) + (n.measured.from ? ` (${n.measured.from})` : "") : "–" }),
        el("td", { cls: "num", text: n.t && n.t.p50 != null ? String(n.t.p50) : "–" }),
        el("td", { cls: "num", text: n.t && n.t.p90 != null ? String(n.t.p90) : "–" }),
        el("td", {}, [status]),
      ]),
    );
  }
}

function useRegistries(results, sourceText) {
  rows = mergeRegistries(results);
  const refused = results.flatMap((r) => (r.ok ? r.rejected.map((x) => `${r.publisher || "file"}: ${x.label || "entry"} (${x.reason})`) : [`${r.publisher || "file"}: ${r.reason}`]));
  say($("#nodesRes"), rows.length ? (refused.length ? "warn" : "ok") : "err", `${rows.length} node(s) from ${sourceText}.${refused.length ? " Refused: " + refused.slice(0, 6).join("; ") + (refused.length > 6 ? "; …" : "") : ""}`);
  $("#nodesTime").disabled = !rows.length;
  renderNodes();
}

$("#nodesLoad").addEventListener("click", async () => {
  const btn = $("#nodesLoad");
  btn.disabled = true;
  try {
    const found = await qSearch(NODES_IDENTIFIER);
    const pubs = (Array.isArray(found) ? found : []).filter((r) => r && r.identifier === NODES_IDENTIFIER && typeof r.name === "string").slice(0, 50);
    if (!pubs.length) {
      rows = [];
      renderNodes();
      return say($("#nodesRes"), "warn", "Nobody has published a list yet. Be the first: share your nodes below.");
    }
    const results = [];
    for (const p of pubs) {
      try {
        results.push(checkRegistry(await qFetch(p.name, NODES_IDENTIFIER), p.name));
      } catch (e) {
        results.push({ ok: false, publisher: p.name, reason: errText(e) });
      }
    }
    useRegistries(results, `${pubs.length} publisher(s) on Qortal`);
  } catch (e) {
    say($("#nodesRes"), "err", errText(e));
  } finally {
    btn.disabled = false;
  }
});

$("#nodesFile").addEventListener("change", async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  if (f.size > 64 * 1024) return say($("#nodesRes"), "err", "That file is over 64 KB: not a node list.");
  useRegistries([checkRegistry(await f.text(), null)], f.name);
  ev.target.value = "";
});

async function timeNode(url, samples = 3) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });
  const ms = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await r.json();
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  return { p50: Math.round(ms[Math.floor((ms.length - 1) / 2)]), p90: Math.round(ms[ms.length - 1]) };
}

$("#nodesTime").addEventListener("click", async () => {
  const btn = $("#nodesTime");
  btn.disabled = true;
  btn.textContent = "Timing…";
  let blocked = 0;
  for (const n of rows) {
    if (n.kind === "ws") {
      n.t = { skipped: "wss not timed here" };
      continue;
    }
    try {
      n.t = await timeNode(n.url);
    } catch (e) {
      n.t = { error: /Failed to fetch|NetworkError|Content Security|blocked/i.test(errText(e)) ? "blocked or unreachable from here" : errText(e).slice(0, 60) };
      if (/blocked/.test(n.t.error)) blocked++;
    }
    renderNodes();
  }
  if (blocked === rows.length) say($("#nodesRes"), "warn", "This window can't reach the nodes directly. Time them on the bot's machine with npm run qortal:nodes.");
  btn.disabled = false;
  btn.textContent = "Time from here";
});

/* ---------------- share your nodes ---------------- */
const editor = $("#editor");
function addRow(v = {}) {
  const row = el("div", { cls: "erow" });
  const mk = (cls, label, input) => {
    const f = el("div", { cls: "field " + cls });
    const id = "f" + Math.random().toString(36).slice(2, 9);
    input.id = id;
    f.append(el("label", { for: id, text: label }), input);
    return f;
  };
  const kind = el("select");
  for (const k of KINDS) kind.append(el("option", { value: k, text: k }));
  kind.value = v.kind || "rpc";
  row.append(
    mk("label", "Label", el("input", { value: v.label || "", maxlength: "40", placeholder: "My Ashburn node" })),
    mk("url", "Public URL", el("input", { value: v.url || "", spellcheck: "false", placeholder: "https://…" })),
    mk("kind", "Kind", kind),
    mk("region", "Region", el("input", { value: v.region || "", maxlength: "24", placeholder: "us-east" })),
    mk("notes", "Notes", el("input", { value: v.notes || "", maxlength: "140", placeholder: "optional" })),
  );
  const rm = el("button", { cls: "btn sm", type: "button", text: "Remove", "aria-label": "Remove this node" });
  rm.addEventListener("click", () => row.remove());
  const rmWrap = el("div", { cls: "field" }, [el("label", { text: " " }), rm]);
  row.append(rmWrap, el("div", { cls: "why", hidden: "" }));
  editor.append(row);
}
addRow();
$("#rowAdd").addEventListener("click", () => addRow());

function readEditor() {
  const entries = [];
  let bad = 0;
  for (const row of editor.querySelectorAll(".erow")) {
    const [label, url, kind, region, notes] = [...row.querySelectorAll("input,select")].map((x) => x.value);
    const why = row.querySelector(".why");
    if (!url.trim()) {
      why.hidden = true;
      continue;
    }
    const e = { label, url, kind, region, notes };
    const r = checkNode(e);
    why.hidden = r.ok;
    why.textContent = r.ok ? "" : r.reason;
    if (r.ok) entries.push(e);
    else bad++;
  }
  return { entries, bad };
}

$("#shareCheck").addEventListener("click", () => {
  const { entries, bad } = readEditor();
  if (bad) return say($("#shareRes"), "err", `${bad} node(s) need fixing (see the red notes).`);
  if (!entries.length) return say($("#shareRes"), "warn", "Add at least one node.");
  say($("#shareRes"), "ok", `${entries.length} node(s) ready to publish.`);
});

$("#sharePub").addEventListener("click", async () => {
  const { entries, bad } = readEditor();
  if (bad || !entries.length) return say($("#shareRes"), "err", bad ? `${bad} node(s) need fixing first.` : "Add at least one node.");
  const btn = $("#sharePub");
  btn.disabled = true;
  try {
    const doc = buildRegistry(entries);
    const name = await qPublish(NODES_IDENTIFIER, doc, "Base nodes", `${doc.nodes.length} public Base RPC node(s) for the arb terminal network`);
    say($("#shareRes"), "ok", `Published ${doc.nodes.length} node(s) as ${name}. Qortal nodes pick it up within a few minutes.`);
  } catch (e) {
    say($("#shareRes"), "err", errText(e));
  } finally {
    btn.disabled = false;
  }
});

if (onQortal)
  qMyName()
    .then((n) => ($("#shareAs").textContent = n ? `publishing as ${n}` : "this account has no registered name"))
    .catch(() => {});

/* ---------------- public status ---------------- */
const fmt = (v, unit = "") => (v == null ? "–" : `${v}${unit}`);
const money = (v) => (v == null ? "–" : `$${Number(v).toFixed(2)}`);

$("#watchLoad").addEventListener("click", async () => {
  const name = $("#watchName").value.trim();
  const box = $("#watchRes");
  const stats = $("#watchStats");
  stats.hidden = true;
  if (!/^[A-Za-z0-9 ._@-]{1,40}$/.test(name)) return say(box, "err", "Enter a Qortal name.");
  try {
    const r = checkStatus(await qFetch(name, STATUS_IDENTIFIER));
    if (!r.ok) return say(box, "err", `${name}'s snapshot was refused: ${r.reason}`);
    const s = r.status;
    const age = Math.round((Date.now() - Date.parse(s.publishedAt)) / 60000);
    say(box, age > 180 ? "warn" : "ok", `${name}'s bot, published ${age < 90 ? age + " min" : Math.round(age / 60) + " h"} ago.`);
    const cards = [
      ["Mode", s.mode || "–"],
      ["Running", s.running ? (s.paused ? "yes, sending paused" : "yes") : "no"],
      ["Health", s.health.overall || "–"],
      ["Open issues", fmt(s.health.issues)],
      ["Seen at p50", fmt(s.latency.detectP50Ms, " ms")],
      ["Lands after", fmt(s.latency.landBlocksP50, " blocks")],
      ["Captured, 6 h", money(s.results6h.captured.usd)],
      ["Lost the race, 6 h", fmt(s.results6h.lostRace.n)],
      ["Fleet bots running", String(s.fleet.filter((f) => f.state === "running").length)],
    ];
    stats.replaceChildren(...cards.map(([k, v]) => el("div", { cls: "stat" }, [el("div", { cls: "k", text: k }), el("div", { cls: "v", text: String(v) })])));
    stats.hidden = false;
  } catch (e) {
    say(box, "err", errText(e));
  }
});

let snap = null;
$("#snapGet").addEventListener("click", async () => {
  const box = $("#snapRes");
  snap = null;
  $("#snapPub").disabled = true;
  try {
    const r = await fetch(bridgeUrl() + "/bridge/snapshot", { cache: "no-store", signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    const c = checkStatus(j);
    if (!c.ok) throw new Error(c.reason);
    snap = c.status;
    const pre = $("#snapPre");
    pre.hidden = false;
    pre.textContent = JSON.stringify(snap, null, 2);
    say(box, "ok", "This is everything that will be published. Check it, then publish.");
    $("#snapPub").disabled = !onQortal;
    if (!onQortal) say(box, "warn", "Preview only: open this app in Qortal Hub to publish.");
  } catch (e) {
    say(box, "err", `Couldn't get a snapshot from the bridge: ${errText(e)}. Test the bridge under Connect your bot.`);
  }
});

$("#snapPub").addEventListener("click", async () => {
  if (!snap) return;
  const btn = $("#snapPub");
  btn.disabled = true;
  try {
    const name = await qPublish(STATUS_IDENTIFIER, snap, "Arb bot status", "Aggregate health and results of an arb bot: counts and timings only");
    say($("#snapRes"), "ok", `Published as ${name}. Anyone can now watch it under Public status with that name.`);
  } catch (e) {
    say($("#snapRes"), "err", errText(e));
    btn.disabled = false;
  }
});
