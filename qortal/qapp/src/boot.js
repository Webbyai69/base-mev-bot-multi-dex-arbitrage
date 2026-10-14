/* Qortal app bootstrap for the terminal.
   Finds your bot's read-only bridge (qortal/bridge) and starts the terminal on
   live data through it; otherwise the terminal runs its labelled demo.
   - Served by the bridge (Qortal Hub's Dev Mode, or a browser at the bridge's
     own address): the bridge is this page's origin, so it is asked first.
   - Published or previewed on Qortal: Qortal Hub lets a published app talk only
     to Qortal itself, so the bridge can't be reached and the demo runs.
   - Anywhere else: the bridge address saved under Network -> Connect.
   The app never holds a bot token: the bridge does, on the bot's machine. */
(function () {
  var KEY = "baq.bridge", DEF = "http://127.0.0.1:8790";
  var ctx = typeof window._qdnContext === "string" ? window._qdnContext : ""; // "render" when published/previewed, "proxy" in Dev Mode
  var saved = DEF;
  try { saved = localStorage.getItem(KEY) || DEF; } catch (e) { /* storage blocked: use the default */ }
  saved = saved.replace(/\/+$/, "");
  var started = false, boot = null, bridgeUp = false;

  function health(base) {
    return fetch(base + "/bridge/health", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (h) { if (!h || h.bridge !== "base-arb-qortal-bridge") throw new Error("not the bridge"); return h; });
  }

  function badge() {
    var live = !!(boot && boot.token);
    var label = live ? "Live, read-only, through your bridge"
      : bridgeUp ? "Bridge is up, your bot isn't answering"
      : ctx === "render" ? "Demo data, not your bot · see it live"
      : "Demo data, not your bot · connect it";
    var b = document.createElement("a");
    b.href = "network.html#connect";
    b.className = "qortal-badge" + (live ? " live" : "");
    b.innerHTML = '<span class="dot"></span><span></span><span class="go">Network</span>';
    b.children[1].textContent = label;
    var s = document.createElement("style");
    s.textContent =
      ".qortal-badge{position:fixed;left:14px;bottom:14px;z-index:9999;display:flex;align-items:center;gap:9px;padding:8px 12px;" +
      "border-radius:999px;background:var(--surface-2,#121b2e);border:1px solid var(--line-2,#293a5c);color:var(--ink,#eaf1fc);" +
      "font:500 12px/1 var(--body,system-ui,sans-serif);text-decoration:none;box-shadow:0 10px 30px -16px rgba(0,0,0,.6)}" +
      ".qortal-badge .dot{width:8px;height:8px;border-radius:50%;background:var(--warn,#f5b23d)}" +
      ".qortal-badge.live .dot{background:var(--good,#2bd98b)}" +
      ".qortal-badge .go{color:var(--accent-2,#38d6ff);font-weight:600}" +
      ".qortal-badge:focus-visible{outline:2px solid var(--accent-2,#38d6ff);outline-offset:2px}";
    document.head.appendChild(s);
    document.body.appendChild(b);
    if (!live) {
      var fn = document.querySelector(".foot-note");
      if (fn) fn.textContent = bridgeUp
        ? "The bridge is running but your bot isn't answering it. Start the bot, then reload this page."
        : ctx === "render"
          ? "Demo data, not your bot. Qortal Hub keeps published apps away from other programs on your computer, so your bot shows up here through Dev Mode: see Network, Connect your bot."
          : "Demo data, not your bot. Run the bridge on the bot's machine and connect it under Network to see your bot's live numbers.";
    }
  }

  function start() {
    if (started) return;
    started = true;
    window.__BOT__ = boot || { token: null, qortal: !!ctx, context: ctx };
    var s = document.createElement("script");
    s.src = "terminal.js";
    s.onload = badge;
    document.body.appendChild(s);
  }

  var timer = setTimeout(start, 2500);
  health("")
    .then(function (h) {
      // This page came from the bridge itself. Through Qortal's Dev Mode proxy the
      // port differs: that proxy passes reads only and holds each answer until it
      // ends, so the terminal polls instead of streaming.
      bridgeUp = true;
      var proxied = String(location.port || "80") !== String(h.port || "");
      if (h.bot && h.bot.reachable) boot = { token: "bridge", base: "", readOnly: true, qortal: !!ctx, context: ctx, viaProxy: proxied, noStream: proxied };
    })
    .catch(function () {
      if (ctx) return; // on Qortal: other addresses are blocked, so don't try
      return health(saved).then(function (h) {
        bridgeUp = true;
        if (h.bot && h.bot.reachable) boot = { token: "bridge", base: saved, readOnly: true, qortal: false, context: "" };
      });
    })
    .catch(function () { /* no bridge: demo */ })
    .then(function () { clearTimeout(timer); start(); });
})();
