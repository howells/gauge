/**
 * The dashboard page served at `/`.
 *
 * A single self-contained document: no framework, no external assets, no
 * bundler. On a desktop-sized viewport the whole page is an app shell that
 * fits one viewport - header, account board, timeline band - and smaller
 * viewports fall back to natural document flow. The script deliberately
 * avoids template literals and closing-script sequences so it survives
 * embedding in this template string.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gauge</title>
<style>
  :root {
    --bg: #f6f3ed;
    --surface: #fdfcf9;
    --surface-2: #ece7db;
    --border: #ddd5c4;
    --border-soft: #e7e1d3;
    --text: #262019;
    --dim: #5f5747;
    --faint: #7d7461;
    --ok: #55813d;
    --lean: #a06f12;
    --crit: #b04a32;
    --accent: #ad5128;
    --accent-dim: #8a421f;
    --p-claude: #c15f3c;
    --p-codex: #3e7d74;
    --p-cursor: #7361b0;
    --p-zai: #97731a;
    --p-grok: #55688f;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      Helvetica, Arial, sans-serif;
    font-feature-settings: "tnum" 1;
    -webkit-font-smoothing: antialiased;
    min-height: 100dvh;
  }
  @media (min-width: 760px) and (min-height: 660px) {
    body {
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      height: 100dvh;
      overflow: hidden;
    }
  }
  header {
    align-items: baseline;
    display: flex;
    gap: 18px;
    padding: 14px 24px 10px;
  }
  .brand {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.05em;
  }
  .brand span { color: var(--accent); }
  .head-spacer { flex: 1; }
  .head-meta { align-items: center; color: var(--faint); display: flex; font-size: 11.5px; gap: 12px; }
  .seg {
    border: 1px solid var(--border);
    border-radius: 7px;
    display: flex;
    overflow: hidden;
  }
  .seg button {
    background: transparent;
    border: 0;
    border-radius: 0;
    color: var(--faint);
    padding: 3px 11px;
  }
  .seg button + button { border-left: 1px solid var(--border); }
  .seg button:hover { color: var(--text); }
  .seg button[aria-pressed="true"] {
    background: var(--surface-2);
    color: var(--text);
    font-weight: 600;
  }
  button {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 7px;
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: 11.5px;
    padding: 3px 11px;
  }
  button:hover { border-color: var(--accent-dim); }
  @media (pointer: coarse) {
    button { padding: 10px 16px; }
  }
  main {
    display: grid;
    gap: 10px;
    grid-auto-rows: 1fr;
    grid-template-columns: repeat(auto-fill, minmax(235px, 1fr));
    min-height: 0;
    overflow-y: auto;
    padding: 0 24px;
  }
  .rec {
    align-items: center;
    background: color-mix(in srgb, var(--ok) 6%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--ok) 28%, var(--border-soft));
    border-radius: 8px;
    color: var(--dim);
    display: flex;
    font-size: 12px;
    gap: 8px;
    margin: 0 24px 10px;
    padding: 7px 13px;
  }
  .rec b { color: var(--text); font-weight: 650; }
  .rec .pulse {
    background: var(--ok);
    border-radius: 50%;
    flex: none;
    height: 6px;
    width: 6px;
  }
  .errbar {
    background: color-mix(in srgb, var(--crit) 6%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--crit) 30%, var(--border-soft));
    border-radius: 8px;
    color: var(--dim);
    font-size: 12px;
    margin: 0 24px 10px;
    padding: 6px 13px;
  }
  .errbar b { color: var(--crit); font-weight: 600; }
  .card {
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: 9px;
    box-shadow: 0 1px 2px rgba(64, 52, 34, 0.04);
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    padding: 10px 12px;
  }
  .card-top {
    align-items: center;
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
    min-width: 0;
  }
  .p-dot {
    border-radius: 2px;
    flex: none;
    height: 7px;
    width: 7px;
  }
  .p-claude { background: var(--p-claude); }
  .p-codex { background: var(--p-codex); }
  .p-cursor { background: var(--p-cursor); }
  .p-zai { background: var(--p-zai); }
  .p-grok { background: var(--p-grok); }
  .p-name { color: var(--faint); flex: none; font-size: 10.5px; }
  .name {
    flex: 1;
    font-size: 13px;
    font-weight: 650;
    letter-spacing: -0.01em;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .plan {
    color: var(--dim);
    flex: none;
    font-size: 10.5px;
    white-space: nowrap;
  }
  .card.dead { border-color: var(--border-soft); opacity: 0.55; }
  .score { align-items: center; display: flex; gap: 7px; margin: 1px 0 5px; }
  .score-bar { flex: 1; }
  .score-num { color: var(--dim); flex: none; font-size: 10.5px; text-align: right; white-space: nowrap; }
  .win { align-items: center; display: flex; gap: 8px; height: 17px; min-width: 0; }
  .win-label { color: var(--faint); flex: none; font-size: 10.5px; width: 54px; white-space: nowrap; }
  .bar {
    background: var(--surface-2);
    border-radius: 3px;
    flex: 1;
    height: 4px;
    min-width: 30px;
    overflow: hidden;
  }
  .bar i { border-radius: 3px; display: block; height: 100%; }
  .lv-ok { background: var(--ok); }
  .lv-lean { background: var(--lean); }
  .lv-crit { background: var(--crit); }
  .win-pct { flex: none; font-size: 11px; text-align: right; width: 52px; }
  .win-reset { color: var(--faint); flex: none; font-size: 10px; text-align: right; width: 58px; }
  .card-foot {
    border-top: 1px solid var(--border-soft);
    color: var(--faint);
    font-size: 10.5px;
    margin-top: auto;
    padding-top: 6px;
  }
  .card-foot:empty { display: none; }
  .card-foot .soon { color: var(--accent); font-weight: 600; }
  .error-chip {
    background: color-mix(in srgb, var(--crit) 9%, transparent);
    border: 1px solid color-mix(in srgb, var(--crit) 32%, transparent);
    border-radius: 5px;
    color: var(--crit);
    display: inline-block;
    font-size: 10.5px;
    margin: 2px 0 4px;
    padding: 1px 7px;
  }
  .empty { color: var(--faint); font-size: 11px; }
  .board-empty {
    color: var(--faint);
    grid-column: 1 / -1;
    padding: 32px 0;
    text-align: center;
  }
  .board-empty code {
    background: var(--surface-2);
    border-radius: 4px;
    padding: 1px 6px;
  }
  .timeline {
    border-top: 1px solid var(--border-soft);
    margin-top: 12px;
    overflow-x: auto;
    padding: 9px 24px 12px;
  }
  .tl-head {
    color: var(--faint);
    display: flex;
    font-size: 10.5px;
    gap: 14px;
    margin-bottom: 6px;
  }
  .tl-head b { color: var(--dim); font-weight: 600; }
  .tl-legend { align-items: center; display: flex; gap: 5px; margin-left: auto; }
  .tl-key {
    border-radius: 2px;
    display: inline-block;
    height: 9px;
    width: 3px;
  }
  .tl-key.renew { border-radius: 50%; height: 7px; width: 7px; }
  .tl-row { align-items: center; display: flex; gap: 10px; height: 16px; }
  .tl-name {
    color: var(--dim);
    flex: none;
    font-size: 10.5px;
    overflow: hidden;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 170px;
  }
  .tl-track {
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    flex: 1;
    height: 11px;
    min-width: 520px;
    position: relative;
  }
  .tl-day {
    border-left: 1px solid var(--border-soft);
    height: 100%;
    position: absolute;
    top: 0;
  }
  .tl-day.we { border-left-color: var(--border); }
  .tl-marker {
    border-radius: 2px;
    height: 10px;
    position: absolute;
    top: 0;
    transform: translateX(-1px);
    width: 3px;
  }
  .tl-marker.renew {
    border-radius: 50%;
    height: 8px;
    top: 0.5px;
    transform: translateX(-4px);
    width: 8px;
  }
  .tl-axis { color: var(--faint); display: flex; font-size: 9.5px; margin: 3px 0 0 180px; }
  .tl-axis span { flex: 1; min-width: 37px; }
  .hidden { display: none; }
  .loading { color: var(--faint); padding: 32px 0; text-align: center; }
  @media (max-width: 759px), (max-height: 659px) {
    header { flex-wrap: wrap; padding: 12px 16px 6px; }
    main { padding: 0 16px; }
    .rec, .errbar { margin: 0 16px 8px; }
    .timeline { padding: 8px 16px 10px; }
    .tl-name { width: 110px; }
    .tl-axis { margin-left: 120px; }
  }
</style>
</head>
<body>
<header>
  <div class="brand">gau<span>g</span>e</div>
  <div class="head-spacer"></div>
  <div class="seg" role="group" aria-label="Sort accounts">
    <button id="sort-grouped" type="button">Grouped</button>
    <button id="sort-usable" type="button">Usable first</button>
  </div>
  <div class="head-meta">
    <span id="updated">loading</span>
    <button id="refresh" type="button">Refresh</button>
  </div>
</header>
<div class="loading" id="loading">Collecting usage…</div>
<div id="context">
  <div class="rec hidden" id="rec"></div>
  <div class="errbar hidden" id="errbar"></div>
</div>
<main id="board" aria-label="Accounts"></main>
<section class="timeline hidden" id="timeline"></section>
<script>
(function () {
  "use strict";

  var REFRESH_MS = 30000;
  var HORIZON_MS = 14 * 86400000;
  var PROVIDERS = { claude: "Claude", codex: "Codex", cursor: "Cursor", zai: "Z.AI", grok: "Grok" };
  var WINDOWS = { session: "Session", weekly: "Week", monthly: "Month", included: "Included", on_demand: "On-demand" };
  var WIN_ORDER = { session: 0, weekly: 1, monthly: 2, included: 3, on_demand: 4 };
  var state = null;
  var sortMode = "grouped";
  try {
    if (localStorage.getItem("gauge-sort") === "usable") sortMode = "usable";
  } catch (e) { /* storage unavailable; grouped stays */ }
  var renderedAt = 0;

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function level(remaining) {
    if (remaining >= 50) return "ok";
    if (remaining >= 20) return "lean";
    return "crit";
  }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

  function winLabel(w) { return w.label || WINDOWS[w.kind] || cap(w.kind); }

  function rel(iso) {
    var delta = new Date(iso).getTime() - Date.now();
    var future = delta >= 0;
    var abs = Math.abs(delta);
    var days = Math.floor(abs / 86400000);
    var hours = Math.floor((abs % 86400000) / 3600000);
    var mins = Math.floor((abs % 3600000) / 60000);
    var parts = [];
    if (days) parts.push(days + "d");
    if (hours) parts.push(hours + "h");
    if (!days && (mins || !hours)) parts.push(mins + "m");
    return (future ? "in " : "since ") + parts.join(" ");
  }

  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function fmtDayTime(iso) {
    var d = new Date(iso);
    return DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()] +
      ", " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function render(body) {
    renderedAt = Date.now();
    var data = body.data || {};
    var accounts = data.accounts || [];
    $("loading").classList.add("hidden");

    var rec = data.recommendation;
    var recEl = $("rec");
    if (rec && rec.account) {
      recEl.classList.remove("hidden");
      recEl.innerHTML = "";
      recEl.appendChild(el("span", "pulse"));
      recEl.appendChild(el("span", null, "Recommended:"));
      recEl.appendChild(el("b", null, rec.account.name + " (" + rec.account.provider + ")"));
      if (rec.availableAt) {
        recEl.appendChild(el("span", null, "· available " + rel(rec.availableAt)));
      } else if (rec.status === "use_now") {
        recEl.appendChild(el("span", null, "· use now"));
      }
    } else {
      recEl.classList.add("hidden");
    }

    var failed = accounts.filter(function (a) { return a.error; });
    var errEl = $("errbar");
    if (failed.length) {
      errEl.classList.remove("hidden");
      errEl.innerHTML = "";
      errEl.appendChild(el("b", null, failed.length + " failed"));
      errEl.appendChild(el("span", null, " · " + failed.map(function (a) {
        return a.name;
      }).join(", ")));
    } else {
      errEl.classList.add("hidden");
    }

    var board = $("board");
    board.innerHTML = "";
    var order = ["claude", "codex", "cursor", "zai", "grok"];
    var seen = {};
    accounts.forEach(function (a, i) {
      a.__i = i;
      if (!seen[a.provider]) {
        seen[a.provider] = true;
        if (order.indexOf(a.provider) < 0) order.push(a.provider);
      }
    });
    var ranked = accounts.slice();
    if (sortMode === "usable") {
      ranked.sort(function (l, r) {
        var ls = scoreOf(l), rs = scoreOf(r);
        if (ls === null && rs !== null) return 1;
        if (rs === null && ls !== null) return -1;
        if (ls !== null && rs !== null && ls !== rs) return rs - ls;
        var lo = order.indexOf(l.provider), ro = order.indexOf(r.provider);
        if (lo !== ro) return lo - ro;
        return l.__i - r.__i;
      });
    } else {
      ranked.sort(function (l, r) {
        var lo = order.indexOf(l.provider), ro = order.indexOf(r.provider);
        if (lo !== ro) return lo - ro;
        return l.__i - r.__i;
      });
    }
    ranked.forEach(function (a) { board.appendChild(renderCard(a)); });
    if (!accounts.length) {
      board.appendChild(el("div", "board-empty",
        "No accounts yet. Add one with gauge add <name>, then refresh."));
    }

    renderTimeline(accounts);
    updateMeta(body);
  }

  /**
   * The tightest window, as a percentage of usage still available.
   *
   * An account is as usable as its most exhausted pool - session, week, and
   * any model pool like Fable all count. Null when the provider reports no
   * windows at all: nothing known, not nothing left.
   */
  function scoreOf(a) {
    if (a.error || !a.usage) return null;
    var windows = a.usage.windows || [];
    if (!windows.length) return null;
    var score = 100;
    for (var i = 0; i < windows.length; i += 1) {
      var remaining = 100 - (windows[i].usedPercent || 0);
      if (remaining < score) score = remaining;
    }
    return Math.round(score * 10) / 10;
  }

  function bindingWindow(a) {
    if (a.error || !a.usage) return null;
    var windows = a.usage.windows || [];
    var worst = null;
    for (var i = 0; i < windows.length; i += 1) {
      if (!worst || (100 - (windows[i].usedPercent || 0)) <
        (100 - (worst.usedPercent || 0))) {
        worst = windows[i];
      }
    }
    return worst;
  }

  function renderCard(a) {
    var score = scoreOf(a);
    var dead = score !== null && score <= 0;
    var card = el("div", "card" + (dead || a.error ? " dead" : ""));
    var top = el("div", "card-top");
    top.appendChild(el("span", "p-dot p-" + a.provider));
    top.appendChild(el("span", "p-name", PROVIDERS[a.provider] || cap(a.provider)));
    top.appendChild(el("span", "name", a.name));
    if (a.usage && a.usage.plan) top.appendChild(el("span", "plan", a.usage.plan));
    card.appendChild(top);

    if (!a.error) {
      var scoreRow = el("div", "score");
      var scoreBar = el("div", "bar score-bar");
      if (score !== null) {
        var fill = el("i", "lv-" + level(score));
        fill.style.width = Math.max(0, Math.min(100, score)) + "%";
        if (score <= 0) fill.style.minWidth = "3px";
        scoreBar.appendChild(fill);
        scoreRow.appendChild(scoreBar);
        var scoreNum = el("span", "score-num", Math.round(score) + "% usable");
        var binding = bindingWindow(a);
        if (binding) {
          scoreNum.title = "Tightest window: " + winLabel(binding) +
            " (" + Math.round(100 - (binding.usedPercent || 0)) + "% left)";
        }
        scoreRow.appendChild(scoreNum);
      } else {
        scoreRow.appendChild(scoreBar);
        scoreRow.appendChild(el("span", "score-num", "no data"));
      }
      card.appendChild(scoreRow);
    }

    if (a.error) {
      card.appendChild(el("div", "error-chip", a.error.code || "error"));
      var msg = a.error.message ? el("div", "empty", a.error.message) : null;
      if (msg) card.appendChild(msg);
      card.appendChild(el("div", "card-foot"));
      return card;
    }

    var usage = a.usage;
    if (!usage) {
      card.appendChild(el("div", "empty", "No usage reported."));
      card.appendChild(el("div", "card-foot"));
      return card;
    }

    var windows = (usage.windows || []).slice().sort(function (l, r) {
      var lo = WIN_ORDER[l.kind] !== undefined ? WIN_ORDER[l.kind] : 99;
      var ro = WIN_ORDER[r.kind] !== undefined ? WIN_ORDER[r.kind] : 99;
      return lo - ro;
    });

    if (!windows.length) {
      card.appendChild(el("div", "empty", "No usage windows reported."));
    }

    windows.forEach(function (w) {
      var remaining = Math.round((100 - (w.usedPercent || 0)) * 10) / 10;
      var idle = !w.resetsAt && remaining >= 100;
      var row = el("div", "win");
      row.appendChild(el("span", "win-label", winLabel(w)));
      var bar = el("div", "bar");
      var fill = el("i", "lv-" + level(remaining));
      fill.style.width = Math.max(0, Math.min(100, remaining)) + "%";
      if (remaining <= 0) fill.style.minWidth = "3px";
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(el("span", "win-pct", Math.round(remaining) + "% left"));
      var reset = idle ? "idle" : (w.resetsAt ? rel(w.resetsAt) : "—");
      var resetEl = el("span", "win-reset", reset);
      if (w.resetsAt) resetEl.title = winLabel(w) + " resets · " + fmtDayTime(w.resetsAt);
      row.appendChild(resetEl);
      card.appendChild(row);
    });

    var foot = el("div", "card-foot");
    if (usage.renewsAt) {
      var soon = new Date(usage.renewsAt).getTime() - Date.now() < HORIZON_MS;
      foot.appendChild(el("span", soon ? "soon" : null,
        "Renews " + fmtDayTime(usage.renewsAt) + " (" + rel(usage.renewsAt) + ")"));
    }
    card.appendChild(foot);
    return card;
  }

  function renderTimeline(accounts) {
    var marks = [];
    accounts.forEach(function (a) {
      var u = a.usage;
      if (!u) return;
      (u.windows || []).forEach(function (w) {
        if (w.resetsAt && new Date(w.resetsAt).getTime() - renderedAt <= HORIZON_MS) {
          marks.push({ account: a, iso: w.resetsAt, label: winLabel(w) + " resets" });
        }
      });
      if (u.renewsAt && new Date(u.renewsAt).getTime() - renderedAt <= HORIZON_MS) {
        marks.push({ account: a, iso: u.renewsAt, label: "Renews", renew: true });
      }
    });

    var wrap = $("timeline");
    if (!marks.length) { wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");
    wrap.innerHTML = "";

    var head = el("div", "tl-head");
    head.appendChild(el("span", null, "Next 14 days"));
    var legend = el("span", "tl-legend");
    legend.appendChild(el("i", "tl-key lv-ok"));
    legend.appendChild(el("span", null, "reset"));
    legend.appendChild(el("i", "tl-key renew"));
    legend.appendChild(el("span", null, "renewal"));
    legend.style.marginLeft = "auto";
    head.appendChild(legend);
    wrap.appendChild(head);

    var tracked = accounts.filter(function (a) {
      return marks.some(function (m) { return m.account === a; });
    });

    tracked.forEach(function (a) {
      var row = el("div", "tl-row");
      row.appendChild(el("span", "tl-name",
        (PROVIDERS[a.provider] || cap(a.provider)) + " · " + a.name));
      var track = el("div", "tl-track");
      for (var day = 1; day <= 14; day += 1) {
        var grid = el("div", "tl-day" + (new Date(renderedAt + day * 86400000).getDay() % 6 === 0 ? " we" : ""));
        grid.style.left = (day / 14 * 100) + "%";
        track.appendChild(grid);
      }
      marks.filter(function (m) { return m.account === a; }).forEach(function (m) {
        var frac = (new Date(m.iso).getTime() - renderedAt) / HORIZON_MS;
        if (frac < 0 || frac > 1) return;
        var marker = el("div", m.renew ? "tl-marker renew" : "tl-marker lv-ok", null);
        marker.style.left = (frac * 100) + "%";
        marker.title = m.label + " · " + fmtDayTime(m.iso) + " (" + rel(m.iso) + ")";
        track.appendChild(marker);
      });
      row.appendChild(track);
      wrap.appendChild(row);
    });

    var axis = el("div", "tl-axis");
    for (var day = 0; day < 14; day += 1) {
      var d = new Date(renderedAt + day * 86400000);
      axis.appendChild(el("span", null, day === 0 ? "now" : DAYS[d.getDay()] + " " + d.getDate()));
    }
    wrap.appendChild(axis);
  }

  function updateMeta(body) {
    var generated = body.data && body.data.generatedAt
      ? new Date(body.data.generatedAt).getTime()
      : renderedAt;
    var age = Date.now() - generated;
    var ageText = age < 60000 ? "just now"
      : Math.round(age / 60000) + "m ago";
    $("updated").textContent = "collected " + ageText;
  }

  function tick() {
    if (state) updateMeta(state);
  }

  async function load() {
    try {
      var res = await fetch("/api/status", { cache: "no-store" });
      var body = await res.json();
      if (body && body.ok) {
        state = body;
        render(body);
      } else {
        $("updated").textContent = body && body.error ? body.error.code || "error" : "error";
      }
    } catch (err) {
      $("updated").textContent = "unreachable";
    }
  }

  $("refresh").addEventListener("click", function () { load(); });

  function paintSort() {
    $("sort-grouped").setAttribute("aria-pressed", sortMode === "grouped" ? "true" : "false");
    $("sort-usable").setAttribute("aria-pressed", sortMode === "usable" ? "true" : "false");
  }
  function setSort(mode) {
    if (sortMode === mode) return;
    sortMode = mode;
    try { localStorage.setItem("gauge-sort", mode); } catch (e) { /* ignore */ }
    paintSort();
    if (state) render(state);
  }
  $("sort-grouped").addEventListener("click", function () { setSort("grouped"); });
  $("sort-usable").addEventListener("click", function () { setSort("usable"); });
  paintSort();

  setInterval(load, REFRESH_MS);
  setInterval(tick, 15000);
  load();
})();
</script>
</body>
</html>
`;
