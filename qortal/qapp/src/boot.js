/* Qortal app bootstrap for the terminal.
   Looks for the local read-only bridge (qortal/bridge) and, when it answers and
   can reach the bot, starts the terminal on live data through it. Otherwise the
   terminal runs its labelled demo. The app never holds a bot token: the bridge
   does, on the bot's machine. */
(function () {
  var KEY = "baq.bridge", DEF = "http://127.0.0.1:8790", bridge = DEF;
  try { bridge = localStorage.getItem(KEY) || DEF; } catch (e) { /* storage blocked: use the default */ }
  bridge = bridge.replace(/\/+$/, "");
  var started = false, live = false;

  function badge() {
    var b = document.createElement("a");
    b.href = "network.html#connect";
    b.className = "qortal-badge" + (live ? " live" : "");
    b.innerHTML = '<span class="dot"></span><span>' + (live ? "Live through your bridge · read-only" : "Demo data · connect your bot") + '</span><span class="go">Network</span>';
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
      if (fn) fn.textContent = "Demo data. Run the bridge on the bot's machine and connect it under Network to see your bot's live numbers.";
    }
  }

  function start() {
    if (started) return;
    started = true;
    if (live) window.__BOT__ = { token: "bridge", base: bridge, readOnly: true, qortal: true };
    var s = document.createElement("script");
    s.src = "terminal.js";
    s.onload = badge;
    document.body.appendChild(s);
  }

  var timer = setTimeout(start, 1800);
  try {
    fetch(bridge + "/bridge/health", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (h) { live = !!(h && h.ok && h.bot && h.bot.reachable); clearTimeout(timer); start(); })
      .catch(function () { clearTimeout(timer); start(); });
  } catch (e) {
    clearTimeout(timer);
    start();
  }
})();
