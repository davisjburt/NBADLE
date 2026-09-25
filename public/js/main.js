// public/js/main.js

import { MAX_GUESSES, COLUMNS, canBeTarget, compareGuess, teamLogoUrl } from "./compare.js";
import { getStats, recordGame, winRate } from "./stats.js";
import { shareResult, shareText } from "./share.js";

let allPlayers = [];
let players = [];
let playersLoaded = null; // Promise for the one-time /players.json load
let targetPlayer = null;  // In versus this stays null until the server reveals it
let targetImages = null;
let currentMode = "classic";
let startersOnly = false;
let guessCount = 0;
let gameOver = false;
let guessRows = [];          // comparison rows for this round, oldest first
let guessedIds = new Set();  // players already guessed this round
let soloOutcome = null;      // 'won' | 'lost' | 'gaveup'

// VS state
let vsMode = false;
let vsPin = null;
let vsPlayerId = null;
let vsRole = null;         // 'host' | 'challenger'
let vsWinner = null;       // 'host' | 'challenger' | null
let vsGameStarted = false;
let vsSocket = null;           // live updates from the room
let vsSocketRetries = 0;
let vsReconnectTimer = null;
let vsPingTimer = null;
let vsPollingInterval = null;  // fallback while the socket is down
let vsUpdateChain = Promise.resolve();
let vsOpponentGuessCount = 0;
let vsRound = 1;
let vsForfeitedBy = null;  // role that gave up this round, if any
let vsStartersOnly = false;

// Touch detection
const IS_TOUCH = navigator.maxTouchPoints > 0 || "ontouchstart" in window;
// A touch-capable *desktop* (touchscreen laptop, Surface, Chromebook) has a real
// keyboard too, so the custom on-screen keyboard should only take over on a
// phone-sized, coarse-pointer viewport — not just because touch is present.
const SHOW_OSK = IS_TOUCH && matchMedia("(max-width: 768px) and (pointer: coarse)").matches;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

// All screen IDs — only one shown at a time
const SCREENS = [
  "landing-screen",
  "start-screen",
  "versus-lobby-screen",
  "versus-create-screen",
  "versus-join-screen",
  "game-screen",
];

const CELL_LABELS = {
  team: "Team",
  conf: "Conf",
  div: "Div",
  pos: "Pos",
  height: "Ht",
  age: "Age",
  number: "#",
  pts: "PTS",
  reb: "REB",
  ast: "AST",
  stl: "STL",
  blk: "BLK",
  fg3m: "3PM",
};

const STATUS_TEXT = { match: "correct", partial: "close", nomatch: "no match" };

const $ = (id) => document.getElementById(id);

// ── Screen manager ─────────────────────────────────────────────
function showScreen(id) {
  SCREENS.forEach((s) => {
    const el = $(s);
    if (el) el.style.display = s === id ? "" : "none";
  });
  window.scrollTo(0, 0);
}

// ── Player ID (persisted across visits) ───────────────────────
function getOrCreatePlayerId() {
  let id = null;
  try {
    id = localStorage.getItem("nbadle_player_id");
  } catch {
    // Storage unavailable; a per-page id still works for this session
  }
  if (!id) {
    id =
      "p_" +
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2);
    try {
      localStorage.setItem("nbadle_player_id", id);
    } catch {
      // Not persisted
    }
  }
  return id;
}

// ── Toast / modals ─────────────────────────────────────────────
let toastTimer = null;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), 1800);
}

// Moving focus into the dialog on open is what makes screen readers announce its
// aria-labelledby text (e.g. "You got it!"); without it, role="dialog" is inert.
let modalLastFocused = null;
function openModal(el) {
  modalLastFocused = document.activeElement;
  el.style.display = "flex";
  const target = el.querySelector("h2") || el;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}

function closeModal(el) {
  el.style.display = "none";
  if (modalLastFocused && document.body.contains(modalLastFocused) && !modalLastFocused.disabled) {
    modalLastFocused.focus({ preventScroll: true });
  }
  modalLastFocused = null;
}

function setupModals() {
  // Result and confirm modals only close through their own buttons
  ["help-modal", "stats-modal"].forEach((id) => {
    const modal = $(id);
    modal.addEventListener("click", (e) => {
      if (e.target === modal || e.target.closest("[data-close]")) closeModal(modal);
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    ["help-modal", "stats-modal"].forEach((id) => closeModal($(id)));
    if ($("confirm-modal").style.display === "flex") $("confirm-cancel").click();
  });
}

function confirmAction({ title, text, ok }) {
  const modal = $("confirm-modal");
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-ok").textContent = ok;
  openModal(modal);
  $("confirm-cancel").focus();
  return new Promise((resolve) => {
    const done = (answer) => {
      closeModal(modal);
      $("confirm-ok").removeEventListener("click", yes);
      $("confirm-cancel").removeEventListener("click", no);
      resolve(answer);
    };
    const yes = () => done(true);
    const no = () => done(false);
    $("confirm-ok").addEventListener("click", yes);
    $("confirm-cancel").addEventListener("click", no);
  });
}

// ── Round bookkeeping ──────────────────────────────────────────
function resetRound() {
  guessCount = 0;
  gameOver = false;
  soloOutcome = null;
  guessRows = [];
  guessedIds = new Set();
  $("guesses-container").innerHTML = "";
  $("player-input").disabled = false;
  $("player-input").value = "";
  clearSuggestions();
  renderProgress();
}

function renderProgress() {
  const pips = $("guess-pips");
  const text = $("guess-count-text");
  pips.innerHTML = "";
  if (vsMode) {
    text.textContent = gameOver ? "" : "Unlimited guesses";
    return;
  }
  for (let i = 0; i < MAX_GUESSES; i++) {
    const pip = document.createElement("span");
    pip.className = "pip";
    if (i < guessCount) pip.classList.add("is-used");
    if (soloOutcome === "won" && i === guessCount - 1) pip.classList.add("is-won");
    pips.appendChild(pip);
  }
  pips.setAttribute("aria-label", `${guessCount} of ${MAX_GUESSES} guesses used`);
  const left = MAX_GUESSES - guessCount;
  text.textContent = gameOver ? "" : `${left} ${left === 1 ? "guess" : "guesses"} left`;
  renderGhosts();
}

// Dim placeholder rows for the guesses still available (solo only)
function renderGhosts() {
  const container = $("guesses-container");
  container.querySelectorAll(".is-ghost").forEach((el) => el.remove());
  if (vsMode || gameOver) return;
  const cols = COLUMNS[currentMode].filter((c) => c !== "name");
  for (let n = guessCount + 1; n <= MAX_GUESSES; n++) {
    const row = document.createElement("div");
    row.className = "guess-row is-ghost";
    row.setAttribute("aria-hidden", "true");
    const name = document.createElement("div");
    name.className = "guess-name";
    name.textContent = `Guess ${n}`;
    row.appendChild(name);
    cols.forEach(() => {
      const tile = document.createElement("div");
      tile.className = "tile";
      row.appendChild(tile);
    });
    container.appendChild(row);
  }
}

// How long the tile reveal (and win bounce) takes before showing the result
function revealDelay(won) {
  if (REDUCED_MOTION.matches) return 350;
  return won ? 1650 : 1100;
}

// ── Player fetching ────────────────────────────────────────────
function loadAllPlayers() {
  if (!playersLoaded) {
    playersLoaded = fetch("/players.json")
      .then((res) => {
        if (!res.ok) throw new Error("players.json " + res.status);
        return res.json();
      })
      .then((data) => {
        allPlayers = Array.isArray(data) ? data : [];
      })
      .catch((err) => {
        playersLoaded = null; // allow a retry on the next call
        throw err;
      });
  }
  return playersLoaded;
}

function pickRandom(list) {
  return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

function pickSoloTarget() {
  return pickRandom(players.filter((p) => canBeTarget(p, currentMode)));
}

async function fetchPlayers(skipTargetSelect = false) {
  const loader = $("loading-indicator");
  loader.textContent = "Loading roster…";
  loader.style.display = "block";
  try {
    await loadAllPlayers();
  } catch (err) {
    console.error("Could not load players", err);
    loader.textContent = "Couldn't load the roster. Check your connection and reload.";
    return;
  }
  const starters = allPlayers.filter((p) => p.is_starter);
  players = startersOnly && starters.length ? starters : [...allPlayers];
  if (!skipTargetSelect) {
    targetPlayer = pickSoloTarget();
    await loadTargetImages();
  }
  loader.style.display = "none";
  if (!skipTargetSelect && !SHOW_OSK) $("player-input").focus();
}

// Headshots are proxied through our own origin: cdn.nba.com sends no CORS
// headers, which would otherwise block drawing them on the silhouette canvas.
// In versus the server hands out the hint without revealing who the target is.
async function loadTargetImages() {
  targetImages = null;
  if (vsMode && !targetPlayer) {
    if (!vsPin) return;
    try {
      const res = await fetch("/api/vs/hint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: vsPin, player_id: vsPlayerId }),
      });
      if (res.ok) targetImages = await res.json();
    } catch {
      targetImages = null;
    }
    return;
  }
  if (targetPlayer) {
    targetImages = {
      headshot: "/api/headshot/" + targetPlayer.id,
      logo: teamLogoUrl(targetPlayer.team),
    };
  }
}

// ── Guess processing ───────────────────────────────────────────
async function processGuess(guess) {
  if (gameOver || !guess) return;
  if (guessedIds.has(guess.id)) {
    toast("Already guessed");
    return;
  }

  if (vsMode) {
    await processVsGuess(guess);
    return;
  }
  if (!targetPlayer) return;

  guessedIds.add(guess.id);
  guessCount++;
  const row = compareGuess(guess, targetPlayer, currentMode);
  guessRows.push(row);
  const rowEl = renderRow(row, guessCount);

  if (row.correct || guessCount >= MAX_GUESSES) {
    gameOver = true;
    soloOutcome = row.correct ? "won" : "lost";
    if (row.correct) rowEl.classList.add("is-win");
    $("player-input").disabled = true;
    recordGame(currentMode, row.correct, guessCount);
    setTimeout(showResult, revealDelay(row.correct));
  }
  renderProgress();
}

// Versus guesses are scored by the server, which alone knows the target.
let vsGuessInFlight = false;
async function processVsGuess(guess) {
  if (vsGuessInFlight || !vsPin) return;
  vsGuessInFlight = true;
  try {
    const res = await fetch("/api/vs/guess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: vsPin, player_id: vsPlayerId, guess_id: guess.id }),
    });
    if (!res.ok) throw new Error("guess failed: " + res.status);
    const data = await res.json();
    if (gameOver) return; // round ended while the request was in flight

    guessedIds.add(guess.id);
    guessRows.push(data.row);
    const rowEl = renderRow(data.row, guessRows.length);
    if (data.row.correct) rowEl.classList.add("is-win");
    await queueVsUpdate(data);
  } catch (err) {
    console.warn("Failed to submit VS guess", err);
    toast("Couldn't send that guess. Try again.");
  } finally {
    vsGuessInFlight = false;
  }
}

// ── Render ─────────────────────────────────────────────────────
function renderRow(row, number) {
  const container = $("guesses-container");
  const rowEl = document.createElement("div");
  rowEl.className = "guess-row";

  const name = document.createElement("div");
  name.className = "guess-name";
  const num = document.createElement("span");
  num.className = "guess-num";
  num.textContent = String(number);
  const text = document.createElement("span");
  text.textContent = row.name;
  name.append(num, text);
  rowEl.appendChild(name);

  COLUMNS[currentMode]
    .filter((c) => c !== "name")
    .forEach((c, i) => rowEl.appendChild(renderTile(c, row.cells[c], i)));

  if (vsMode) {
    container.insertBefore(rowEl, container.firstChild); // unlimited guesses: newest first
  } else {
    const firstGhost = container.querySelector(".is-ghost");
    container.insertBefore(rowEl, firstGhost);
  }
  return rowEl;
}

function renderTile(col, cell, index) {
  const status = cell?.status || "nomatch";
  const tile = document.createElement("div");
  tile.className = `tile ${status}` + (col === "team" ? " tile--team" : "");
  tile.style.setProperty("--i", index);

  const arrow = (cell?.arrow || "").trim();
  const label = CELL_LABELS[col] || col;
  const direction = arrow === "▲" ? ", answer is higher" : arrow === "▼" ? ", answer is lower" : "";
  tile.setAttribute("aria-label", `${label} ${cell?.val ?? "—"}, ${STATUS_TEXT[status]}${direction}`);

  const labelEl = document.createElement("span");
  labelEl.className = "tile-label";
  labelEl.textContent = label;
  labelEl.setAttribute("aria-hidden", "true");

  const value = document.createElement("span");
  value.className = "tile-value";
  value.setAttribute("aria-hidden", "true");
  if (col === "team") {
    const logo = teamLogoUrl(cell?.val);
    if (logo) {
      const img = document.createElement("img");
      img.className = "tile-logo";
      img.alt = "";
      img.onerror = () => img.remove();
      img.src = logo;
      value.appendChild(img);
    }
  }
  value.append(String(cell?.val ?? "—"));
  if (arrow) {
    const arrowEl = document.createElement("span");
    arrowEl.className = "tile-arrow";
    arrowEl.textContent = arrow;
    value.appendChild(arrowEl);
  }

  tile.append(labelEl, value);
  return tile;
}

// ── Result modal ───────────────────────────────────────────────
function showResult() {
  const title = $("win-title");
  const kicker = $("win-kicker");
  const sub = $("win-subtitle");
  const shareBtn = $("share-btn");
  const playAgainBtn = $("play-again-btn");
  const rematchBtn = $("vs-rematch-btn");
  let won = false;

  if (vsMode) {
    kicker.textContent = `Versus · Round ${vsRound}`;
    if (vsForfeitedBy === vsRole) {
      title.textContent = "You gave up";
      sub.textContent = "Your opponent wins this round.";
    } else if (vsForfeitedBy) {
      won = true;
      title.textContent = "Opponent gave up";
      sub.textContent = "You win this round.";
    } else {
      won = vsWinner === vsRole;
      title.textContent = won ? "You won!" : "Opponent got it";
      sub.textContent = won
        ? `Solved in ${guessCount} ${guessCount === 1 ? "guess" : "guesses"}.`
        : `They beat you to it. You'd made ${guessCount} ${guessCount === 1 ? "guess" : "guesses"}.`;
    }
    // Host starts the rematch; the challenger's game restarts automatically
    rematchBtn.style.display = vsRole === "host" ? "" : "none";
    rematchBtn.disabled = false;
    rematchBtn.textContent = "Play Again";
    playAgainBtn.textContent = "Leave";
    playAgainBtn.className = "btn btn--ghost";
    if (vsRole !== "host") sub.textContent += " A new round starts when the host taps Play Again.";
    shareBtn.style.display = "none";
    $("result-stats").innerHTML = "";
  } else {
    won = soloOutcome === "won";
    kicker.textContent =
      soloOutcome === "won"
        ? `Solved in ${guessCount}/${MAX_GUESSES}`
        : soloOutcome === "gaveup"
          ? "You gave up"
          : "Out of guesses";
    title.textContent = won ? "You got it!" : "The player was";
    sub.textContent = "";
    rematchBtn.style.display = "none";
    playAgainBtn.textContent = "New Game";
    playAgainBtn.className = "btn btn--primary";
    shareBtn.style.display = guessRows.length ? "" : "none";
    renderStatRow($("result-stats"), getStats(currentMode));
  }
  title.className = "result-title " + (won ? "is-win" : "is-loss");

  const p = targetPlayer;
  $("win-name").textContent = p ? p.name : "";
  $("win-meta").textContent = p
    ? [p.team, p.pos, p.number != null ? `#${p.number}` : null].filter(Boolean).join(" · ")
    : "";
  const headshot = $("headshot-img");
  const logo = $("result-team-logo");
  if (p) {
    headshot.src = "/api/headshot/" + p.id;
    headshot.style.display = "";
    const logoUrl = teamLogoUrl(p.team);
    logo.onerror = () => (logo.style.display = "none");
    logo.style.display = logoUrl ? "" : "none";
    if (logoUrl) logo.src = logoUrl;
  } else {
    headshot.style.display = "none";
    logo.style.display = "none";
  }

  renderResultGrid();
  openModal($("win-modal"));
}

function renderResultGrid() {
  const grid = $("result-grid");
  grid.innerHTML = "";
  const cols = COLUMNS[currentMode].filter((c) => c !== "name");
  guessRows.forEach((row) => {
    const line = document.createElement("div");
    line.className = "result-grid-row";
    cols.forEach((c) => {
      const cell = document.createElement("span");
      cell.className = "result-grid-cell " + (row.cells[c]?.status || "nomatch");
      line.appendChild(cell);
    });
    grid.appendChild(line);
  });
}

function renderStatRow(el, s) {
  el.innerHTML = "";
  [
    [s.played, "Played"],
    [winRate(s), "Win %"],
    [s.streak, "Streak"],
    [s.best, "Best"],
  ].forEach(([value, label]) => {
    const stat = document.createElement("div");
    stat.className = "stat";
    const v = document.createElement("span");
    v.className = "stat-value";
    v.textContent = String(value);
    const l = document.createElement("span");
    l.className = "stat-label";
    l.textContent = label;
    stat.append(v, l);
    el.appendChild(stat);
  });
}

function setupShare() {
  $("share-btn").addEventListener("click", async () => {
    const text = shareText({
      mode: currentMode,
      rows: guessRows,
      cols: COLUMNS[currentMode],
      won: soloOutcome === "won",
      guesses: guessCount,
      max: MAX_GUESSES,
      url: location.origin,
    });
    const result = await shareResult(text);
    if (result === "copied") toast("Result copied");
    else if (result === "failed") toast("Couldn't copy. Try again.");
  });
}

// ── Stats modal ────────────────────────────────────────────────
function renderStatsModal(mode) {
  document.querySelectorAll("[data-stats-mode]").forEach((b) => {
    const active = b.dataset.statsMode === mode;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", String(active));
  });
  const s = getStats(mode);
  renderStatRow($("stats-summary"), s);

  const dist = $("stats-dist");
  dist.innerHTML = "";
  const max = Math.max(1, ...s.dist);
  const highlight =
    !vsMode && soloOutcome === "won" && mode === currentMode ? guessCount - 1 : -1;
  s.dist.forEach((count, i) => {
    const row = document.createElement("div");
    row.className = "dist-row";
    const n = document.createElement("span");
    n.textContent = String(i + 1);
    const bar = document.createElement("span");
    bar.className = "dist-bar" + (i === highlight ? " is-highlight" : "");
    bar.style.width = `${Math.max(8, (count / max) * 100)}%`;
    bar.textContent = String(count);
    row.append(n, bar);
    dist.appendChild(row);
  });
}

function setupStatsModal() {
  $("stats-button").addEventListener("click", () => {
    renderStatsModal(currentMode);
    openModal($("stats-modal"));
  });
  document.querySelectorAll("[data-stats-mode]").forEach((b) => {
    b.addEventListener("click", () => renderStatsModal(b.dataset.statsMode));
  });
}

// ── Help modal ─────────────────────────────────────────────────
function setupHelpButton() {
  const open = () => openModal($("help-modal"));
  $("help-button").addEventListener("click", open);
  $("landing-help-btn").addEventListener("click", open);
}

// ── Autocomplete ───────────────────────────────────────────────
// Case- and accent-insensitive key, so "jokic" finds "Jokić" (the on-screen
// keyboard has no accented letters). Stripping combining marks keeps the
// character count of Latin names, so indexes line up for highlighting.
function fold(str) {
  return str.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function findPlayerByName(text) {
  const key = fold(text.trim());
  return players.find((p) => fold(p.name) === key);
}

const MAX_SUGGESTIONS = 8;
let suggestions = [];  // players currently listed
let activeIndex = -1;

function clearSuggestions() {
  suggestions = [];
  activeIndex = -1;
  $("autocomplete-list").innerHTML = "";
  $("player-input").setAttribute("aria-expanded", "false");
  $("player-input").removeAttribute("aria-activedescendant");
}

function setActive(index) {
  const items = $("autocomplete-list").children;
  if (activeIndex >= 0 && items[activeIndex]) items[activeIndex].classList.remove("is-active");
  activeIndex = index;
  const input = $("player-input");
  if (index >= 0 && items[index]) {
    items[index].classList.add("is-active");
    items[index].scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", items[index].id);
  } else {
    input.removeAttribute("aria-activedescendant");
  }
}

function renderSuggestions() {
  const input = $("player-input");
  const list = $("autocomplete-list");
  const val = fold(input.value.trim());
  list.innerHTML = "";
  suggestions = [];
  activeIndex = -1;
  if (!val) {
    clearSuggestions();
    return;
  }

  // Names where a word starts with the query come first
  const scored = [];
  for (const p of players) {
    const name = fold(p.name);
    const at = name.indexOf(val);
    if (at < 0) continue;
    const wordStart = at === 0 || name[at - 1] === " ";
    scored.push({ p, at, rank: at === 0 ? 0 : wordStart ? 1 : 2 });
  }
  scored.sort((a, b) => a.rank - b.rank || a.p.name.localeCompare(b.p.name));

  scored.slice(0, MAX_SUGGESTIONS).forEach(({ p, at }, i) => {
    const item = document.createElement("div");
    item.className = "ac-item";
    item.id = `ac-${p.id}`;
    item.setAttribute("role", "option");
    const guessed = guessedIds.has(p.id);
    if (guessed) {
      item.classList.add("is-guessed");
      item.setAttribute("aria-disabled", "true");
    }

    const logo = document.createElement("img");
    logo.className = "ac-logo";
    logo.alt = "";
    logo.loading = "lazy";
    logo.onerror = () => (logo.style.visibility = "hidden");
    logo.src = teamLogoUrl(p.team);

    // Highlight the typed text with DOM nodes (no regex/innerHTML from user input)
    const name = document.createElement("span");
    name.className = "ac-name";
    const strong = document.createElement("strong");
    strong.textContent = p.name.slice(at, at + val.length);
    name.append(p.name.slice(0, at), strong, p.name.slice(at + val.length));

    const team = document.createElement("span");
    team.className = "ac-team";
    team.textContent = p.team;

    item.append(logo, name, team);
    // mousedown keeps focus in the input (click would blur it first)
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      choosePlayer(p);
    });
    list.appendChild(item);
    suggestions.push(p);
    if (activeIndex < 0 && !guessed) activeIndex = i;
  });

  input.setAttribute("aria-expanded", suggestions.length ? "true" : "false");
  setActive(activeIndex);
}

function choosePlayer(p) {
  if (!p || gameOver) return;
  if (guessedIds.has(p.id)) {
    toast("Already guessed");
    return;
  }
  $("player-input").value = "";
  clearSuggestions();
  processGuess(p);
}

// Enter (keyboard or on-screen): the highlighted suggestion, else an exact name
function submitCurrent() {
  const input = $("player-input");
  const p = activeIndex >= 0 ? suggestions[activeIndex] : findPlayerByName(input.value);
  if (p) {
    choosePlayer(p);
  } else if (input.value.trim()) {
    toast("No player matches that name");
  }
}

function setupAutocomplete() {
  const input = $("player-input");

  input.addEventListener("input", renderSuggestions);

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!suggestions.length) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      submitCurrent();
    } else if (e.key === "Escape") {
      clearSuggestions();
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".input-container")) clearSuggestions();
  });
}

// ── Hint button ────────────────────────────────────────────────
function setHintLabel(text) {
  $("hint-button").querySelector("span").textContent = text;
}

function setupHintButton() {
  const btn = $("hint-button");
  const panel = document.querySelector(".hint-panel");
  const placeholder = $("silhouette-placeholder");
  const silhouetteImg = $("silhouette-img");
  const teamLogoImg = $("team-logo-img");

  btn.addEventListener("click", async () => {
    if (!targetPlayer && !vsMode) return;
    if (!targetImages) await loadTargetImages();
    if (currentMode === "stats") {
      if (!targetImages?.logo) return;
      teamLogoImg.src = targetImages.logo;
      teamLogoImg.style.display = "block";
      silhouetteImg.style.display = "none";
    } else if (targetImages?.headshot && (await generateSilhouette(targetImages.headshot))) {
      silhouetteImg.style.display = "block";
      teamLogoImg.style.display = "none";
    } else {
      return; // leave the button enabled so the hint can be retried
    }
    placeholder.style.display = "none";
    panel.classList.add("is-revealed");
    btn.disabled = true;
    setHintLabel("Hint shown");
  });
}

// Resolves true once the silhouette is drawn. On failure it never falls back to
// the raw headshot, which would give the answer away.
async function generateSilhouette(url) {
  const img = new Image();
  img.src = url;
  const sil = $("silhouette-img");
  const canvas = $("silhouette-canvas");
  const ctx = canvas.getContext("2d");
  return new Promise((res) => {
    img.onload = () => {
      canvas.width = 200;
      canvas.height = 190;
      ctx.drawImage(img, 0, 0, 200, 190);
      const d = ctx.getImageData(0, 0, 200, 190),
        px = d.data;
      for (let i = 0; i < px.length; i += 4)
        if (px[i + 3] > 0) {
          px[i] = px[i + 1] = px[i + 2] = 0;
          px[i + 3] = 255;
        }
      ctx.putImageData(d, 0, 0);
      sil.src = canvas.toDataURL("image/png");
      res(true);
    };
    img.onerror = () => res(false);
  });
}

// ── Reset helpers ──────────────────────────────────────────────
function resetHintVisuals() {
  const sil = $("silhouette-img");
  const logo = $("team-logo-img");
  sil.style.display = "none";
  sil.removeAttribute("src");
  logo.style.display = "none";
  logo.removeAttribute("src");
  $("silhouette-placeholder").style.display = "flex";
  document.querySelector(".hint-panel").classList.remove("is-revealed");
  $("hint-button").disabled = false;
  setHintLabel("Show hint");
}

function setBoardMode() {
  $("game-mode-label").textContent = currentMode === "classic" ? "Classic" : "Stats";
  $("classic-header").style.display = currentMode === "classic" ? "" : "none";
  $("stats-header").style.display = currentMode === "stats" ? "" : "none";
}

// ── VS UI helpers ──────────────────────────────────────────────
function enterVsGameUi() {
  $("vs-status-bar").style.display = "";
  document.querySelector(".starter-filter").style.display = "none";
  $("stats-button").style.display = "none";
  $("give-up-button").querySelector("span").textContent = "Forfeit";
  // Counts and PIN are read from the live state variables at call time
  $("vs-your-guesses").textContent = guessCount;
  $("vs-opponent-guesses").textContent = vsOpponentGuessCount;
  $("vs-game-pin").textContent = vsPin || "------";
}

function exitVsGameUi() {
  $("vs-status-bar").style.display = "none";
  document.querySelector(".starter-filter").style.display = "";
  $("stats-button").style.display = "";
  $("give-up-button").querySelector("span").textContent = "Give up";
}

// ── OSK helpers ────────────────────────────────────────────────
function showOsk() {
  if (!SHOW_OSK) return;
  $("onscreen-keyboard").classList.add("osk--visible");
  document.body.classList.add("osk-open");
}

function hideOsk() {
  $("onscreen-keyboard").classList.remove("osk--visible");
  document.body.classList.remove("osk-open");
}

// ── Landing screen ─────────────────────────────────────────────
function setupLanding() {
  $("solo-btn").addEventListener("click", () => showScreen("start-screen"));
  $("versus-btn").addEventListener("click", () => showScreen("versus-lobby-screen"));
}

// ── Solo mode select ───────────────────────────────────────────
function setupSoloModeSelect() {
  $("solo-back-btn").addEventListener("click", () => showScreen("landing-screen"));

  document.querySelectorAll("#start-screen .mode-card[data-mode]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      currentMode = btn.dataset.mode;
      await startSoloGame();
    });
  });
}

async function startSoloGame() {
  vsMode = false;
  exitVsGameUi();
  setBoardMode();
  resetHintVisuals();
  resetRound();

  showScreen("game-screen");
  await fetchPlayers();
  showOsk();
}

// ── Versus lobby ───────────────────────────────────────────────
function setupVersusLobby() {
  $("versus-back-btn").addEventListener("click", () => showScreen("landing-screen"));

  $("create-game-btn").addEventListener("click", () => {
    $("vs-mode-select-step").style.display = "";
    $("vs-waiting-step").style.display = "none";
    showScreen("versus-create-screen");
  });

  $("join-game-btn").addEventListener("click", () => {
    $("pin-input").value = "";
    $("join-error").style.display = "none";
    $("join-game-submit-btn").disabled = false;
    $("join-game-submit-btn").textContent = "Join Game";
    showScreen("versus-join-screen");
    if (!SHOW_OSK) $("pin-input").focus();
  });
}

// ── Versus create ──────────────────────────────────────────────
function setCopyLabel(text) {
  $("copy-pin-btn").querySelector("span").textContent = text;
}

function setupVersusCreate() {
  $("vs-create-back-btn").addEventListener("click", () => showScreen("versus-lobby-screen"));

  $("cancel-vs-btn").addEventListener("click", () => {
    stopVsSync();
    vsPin = null;
    showScreen("versus-lobby-screen");
  });

  $("copy-pin-btn").addEventListener("click", () => {
    const pin = $("vs-pin-display").textContent;
    navigator.clipboard.writeText(pin).catch(() => {});
    setCopyLabel("Copied!");
    setTimeout(() => setCopyLabel("Copy PIN"), 2000);
  });

  $("vs-starter-toggle").addEventListener("change", (e) => {
    vsStartersOnly = e.target.checked;
  });

  document.querySelectorAll(".mode-card[data-vs-mode]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await createVsGame(btn.dataset.vsMode);
    });
  });
}

async function postVs(action, payload) {
  const res = await fetch("/api/vs/" + action, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: vsPin, player_id: vsPlayerId, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Request failed"), { data });
  return data;
}

function showWaitingStep(status) {
  $("vs-mode-select-step").style.display = "none";
  $("vs-waiting-step").style.display = "";
  $("vs-pin-display").textContent = vsPin || "------";
  $("vs-waiting-status").textContent = status;
  setCopyLabel("Copy PIN");
}

async function createVsGame(mode) {
  currentMode = mode;
  vsPin = null;
  showWaitingStep("Creating game…");

  try {
    const data = await postVs("create", { mode, starters_only: vsStartersOnly });

    vsPin = data.pin;
    vsRole = "host";
    vsRound = data.round;
    vsGameStarted = false;
    targetPlayer = null;
    targetImages = null;

    showWaitingStep("Waiting for opponent…");
    // Live updates tell us when the challenger joins
    startVsSync();
  } catch (err) {
    console.error("Failed to create VS game", err);
    $("vs-waiting-status").textContent = "Error creating game. Tap × and try again.";
  }
}

// ── Versus join ────────────────────────────────────────────────
function setupVersusJoin() {
  $("vs-join-back-btn").addEventListener("click", () => showScreen("versus-lobby-screen"));
  $("join-game-submit-btn").addEventListener("click", joinVsGame);
  $("pin-input").addEventListener("keydown", async (e) => {
    if (e.key === "Enter") await joinVsGame();
  });
}

async function joinVsGame() {
  const pin = $("pin-input").value.trim().toUpperCase();
  const errEl = $("join-error");
  const submitBtn = $("join-game-submit-btn");

  if (pin.length !== 6) {
    errEl.textContent = "Please enter a valid PIN.";
    errEl.style.display = "";
    return;
  }

  errEl.style.display = "none";
  submitBtn.disabled = true;
  submitBtn.textContent = "Joining…";

  let data;
  try {
    vsPin = pin;
    data = await postVs("join");
  } catch (err) {
    vsPin = null;
    errEl.textContent = err.data?.error || "Connection error. Try again.";
    errEl.style.display = "";
    submitBtn.disabled = false;
    submitBtn.textContent = "Join Game";
    return;
  }

  vsRole = data.role; // 'host' | 'challenger'
  vsRound = data.round;
  currentMode = data.mode;
  targetPlayer = data.target_player; // only present once the round is decided
  targetImages = null;

  // Host reconnecting before challenger arrived — back to waiting screen
  if (data.role === "host" && !data.started) {
    vsGameStarted = false;
    showWaitingStep("Waiting for opponent…");
    showScreen("versus-create-screen");
    startVsSync();
    return;
  }

  // Host reconnecting mid-game, or challenger (new or returning)
  vsGameStarted = true;
  await startVsGame(data);
  startVsSync();
}

// ── VS game launch ─────────────────────────────────────────────
// `state` is the server's room state, so reconnecting players restore accurate counts.
async function startVsGame(state) {
  vsMode = true;
  vsWinner = null;
  vsForfeitedBy = null;
  vsOpponentGuessCount = 0;
  targetPlayer = null;
  targetImages = null;

  setBoardMode();
  resetHintVisuals();
  resetRound();
  closeModal($("win-modal"));

  showScreen("game-screen");
  enterVsGameUi();
  showOsk();

  // Any player can be guessed in versus, regardless of the solo starters toggle
  try {
    await loadAllPlayers();
    players = [...allPlayers];
  } catch (err) {
    console.error("Could not load players", err);
  }

  await applyVsState(state);
}

// Syncs counts/winner from any server response and ends the round when decided.
async function applyVsState(state) {
  if (!state) return;
  const mine = vsRole === "host" ? state.host_guess_count : state.challenger_guess_count;
  const theirs = vsRole === "host" ? state.challenger_guess_count : state.host_guess_count;
  // Counts only rise within a round (startVsGame resets them), and snapshots can
  // arrive out of order, so never let an older one move either count backwards.
  guessCount = Math.max(guessCount, mine || 0);
  vsOpponentGuessCount = Math.max(vsOpponentGuessCount, theirs || 0);
  $("vs-your-guesses").textContent = guessCount;
  $("vs-opponent-guesses").textContent = vsOpponentGuessCount;

  if (state.winner && !gameOver) {
    gameOver = true;
    vsWinner = state.winner;
    vsForfeitedBy = state.forfeited_by || null;
    if (state.target_player) {
      targetPlayer = state.target_player;
      targetImages = { headshot: "/api/headshot/" + targetPlayer.id };
    }
    $("player-input").disabled = true;
    clearSuggestions();
    // Let our own winning row finish revealing before the result appears
    setTimeout(showResult, state.row?.correct ? revealDelay(true) : 300);
  }
}

// ── VS live updates ────────────────────────────────────────────
// The room pushes its state over a WebSocket whenever anything changes. If the
// socket drops, we reconnect with backoff and poll every 3s in the meantime.
function startVsSync() {
  stopVsSync();
  connectVsSocket();
}

function stopVsSync() {
  clearTimeout(vsReconnectTimer);
  vsReconnectTimer = null;
  clearInterval(vsPingTimer);
  vsPingTimer = null;
  stopVsPolling();
  if (vsSocket) {
    const ws = vsSocket;
    vsSocket = null; // mark as intentional so onclose doesn't reconnect
    ws.close(1000);
  }
}

function connectVsSocket() {
  if (!vsPin) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(
    `${proto}//${location.host}/api/vs/ws/${vsPin}?player_id=${encodeURIComponent(vsPlayerId)}`,
  );
  vsSocket = ws;

  ws.addEventListener("open", () => {
    vsSocketRetries = 0;
    stopVsPolling();
    clearInterval(vsPingTimer);
    vsPingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 25000);
  });

  ws.addEventListener("message", (e) => {
    if (e.data === "pong") return;
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    if (data.type === "state") queueVsUpdate(data);
  });

  ws.addEventListener("close", (e) => {
    if (vsSocket !== ws) return; // replaced or closed on purpose
    vsSocket = null;
    clearInterval(vsPingTimer);
    if (!vsPin || e.code === 4404) return; // room expired
    startVsPolling();
    const delay = Math.min(30000, 1000 * 2 ** vsSocketRetries++);
    vsReconnectTimer = setTimeout(connectVsSocket, delay);
  });
}

function startVsPolling() {
  if (vsPollingInterval) return;
  vsPollingInterval = setInterval(pollVsStatus, 3000);
}

function stopVsPolling() {
  if (vsPollingInterval) {
    clearInterval(vsPollingInterval);
    vsPollingInterval = null;
  }
}

async function pollVsStatus() {
  if (!vsPin) return;
  try {
    const res = await fetch(`/api/vs/status/${vsPin}`);
    if (res.status === 404) {
      stopVsSync(); // room is gone; stop reconnecting
      return;
    }
    if (!res.ok) return;
    queueVsUpdate(await res.json());
  } catch (_) {
    // Ignore network errors; the next poll or reconnect will catch up
  }
}

// Updates can arrive from the socket, a poll, or our own requests; apply them
// one at a time so a slow startVsGame can't interleave with the next update.
function queueVsUpdate(data) {
  vsUpdateChain = vsUpdateChain.then(() => handleVsUpdate(data)).catch(() => {});
  return vsUpdateChain;
}

async function handleVsUpdate(data) {
  if (!vsPin || data.pin !== vsPin) return;

  // Phase 1 — host waiting for challenger to join
  if (vsRole === "host" && !vsGameStarted) {
    if (data.started) {
      vsGameStarted = true;
      vsRound = data.round;
      await startVsGame(data);
    }
    return;
  }

  // Phase 3 — rematch: server round advanced (challenger detects host's Play Again)
  if (data.round > vsRound) {
    vsRound = data.round;
    await startVsGame(data);
    return;
  }

  // Phase 2 — in-game: sync counts and detect the opponent winning or forfeiting
  if (data.round === vsRound) await applyVsState(data);
}

// ── VS rematch (host only) ─────────────────────────────────────
function setupVsRematch() {
  $("vs-rematch-btn").addEventListener("click", async () => {
    const btn = $("vs-rematch-btn");
    btn.disabled = true;
    btn.textContent = "Starting…";

    try {
      // The same state also arrives over the socket; the queue applies it once
      await queueVsUpdate(await postVs("rematch"));
    } catch (_) {
      btn.disabled = false;
      btn.textContent = "Play Again";
    }
  });
}

// ── VS state reset ─────────────────────────────────────────────
function resetVsState() {
  stopVsSync();
  vsMode = false;
  vsPin = null;
  vsRole = null;
  vsWinner = null;
  vsGameStarted = false;
  vsOpponentGuessCount = 0;
  vsRound = 1;
  vsForfeitedBy = null;
  targetPlayer = null;
  targetImages = null;
}

// ── Back button ────────────────────────────────────────────────
function setupBackButton() {
  $("back-button").addEventListener("click", async () => {
    // Only ask when there's an active, unfinished run to lose
    if (!gameOver && guessedIds.size > 0) {
      const ok = await confirmAction({
        title: "Leave this game?",
        text: vsMode
          ? "You'll leave the match. Your opponent can keep playing without you."
          : "Your progress on this player won't be saved.",
        ok: "Leave",
      });
      if (!ok) return;
    }

    closeModal($("win-modal"));
    resetHintVisuals();
    hideOsk();

    if (vsMode) {
      resetVsState();
      exitVsGameUi();
      resetRound();
      showScreen("landing-screen");
    } else {
      exitVsGameUi();
      resetRound();
      showScreen("start-screen");
      targetPlayer = null;
      targetImages = null;
    }
  });
}

// ── Play again ─────────────────────────────────────────────────
function setupPlayAgain() {
  $("play-again-btn").addEventListener("click", async () => {
    closeModal($("win-modal"));

    if (vsMode) {
      resetVsState();
      exitVsGameUi();
      resetRound();
      hideOsk();
      showScreen("landing-screen");
      return;
    }

    resetHintVisuals();
    resetRound();
    targetPlayer = pickSoloTarget();
    await loadTargetImages();
    if (!SHOW_OSK) $("player-input").focus();
    showOsk();
  });
}

// ── Give up ────────────────────────────────────────────────────
function setupGiveUp() {
  $("give-up-button").addEventListener("click", async () => {
    if (gameOver) return;

    if (vsMode) {
      const ok = await confirmAction({
        title: "Forfeit?",
        text: "Your opponent wins this round and the player is revealed.",
        ok: "Forfeit",
      });
      if (!ok || gameOver) return;
      // The server reveals the target once the round is decided
      try {
        const state = await postVs("forfeit");
        await queueVsUpdate(state);
      } catch (err) {
        console.warn("Failed to report VS forfeit", err);
        toast("Couldn't reach the game. Try again.");
      }
      return;
    }

    if (!targetPlayer) return;
    const ok = await confirmAction({
      title: "Give up?",
      text: "The player will be revealed and this counts as a loss.",
      ok: "Give up",
    });
    if (!ok || gameOver) return;
    gameOver = true;
    soloOutcome = "gaveup";
    $("player-input").disabled = true;
    clearSuggestions();
    recordGame(currentMode, false, guessCount);
    renderProgress();
    showResult();
  });
}

// ── Starter toggle ─────────────────────────────────────────────
function setupStarterToggle() {
  $("starter-toggle").addEventListener("change", async (e) => {
    startersOnly = e.target.checked;
    resetHintVisuals();
    resetRound();
    await fetchPlayers();
    toast(startersOnly ? "Starters only: new player picked" : "All players: new player picked");
    if (SHOW_OSK) showOsk();
  });
}

// ── On-screen keyboard ─────────────────────────────────────────
function setupOnscreenKeyboard() {
  if (!SHOW_OSK) return;

  const keyboard = $("onscreen-keyboard");
  const input = $("player-input");
  const backspace = $("osk-backspace");
  const enterBtn = $("osk-enter");

  input.removeAttribute("readonly");
  input.setAttribute("inputmode", "none");

  input.addEventListener(
    "touchstart",
    () => {
      showOsk();
      setTimeout(() => input.focus({ preventScroll: true }), 50);
    },
    { passive: true },
  );

  function flash(el) {
    if (!el) return;
    el.classList.add("osk-key--pressed");
    setTimeout(() => el.classList.remove("osk-key--pressed"), 100);
  }

  function pressKey(char) {
    if (gameOver) return;
    input.value += char;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flash(keyboard.querySelector(`[data-char="${char}"]`));
    input.focus({ preventScroll: true });
  }

  keyboard.querySelectorAll(".osk-key[data-char]").forEach((key) => {
    key.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        pressKey(key.dataset.char);
      },
      { passive: false },
    );
  });

  let bsTimer = null, bsInterval = null;

  function doBackspace() {
    if (gameOver) return;
    input.value = input.value.slice(0, -1);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flash(backspace);
    input.focus({ preventScroll: true });
  }

  backspace.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      doBackspace();
      bsTimer = setTimeout(() => {
        bsInterval = setInterval(doBackspace, 80);
      }, 400);
    },
    { passive: false },
  );

  const stopBs = () => {
    clearTimeout(bsTimer);
    clearInterval(bsInterval);
  };
  backspace.addEventListener("touchend", stopBs);
  backspace.addEventListener("touchcancel", stopBs);

  enterBtn.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      flash(enterBtn);
      if (gameOver) return;
      submitCurrent();
      input.focus({ preventScroll: true });
    },
    { passive: false },
  );
}

// ── Init ───────────────────────────────────────────────────────
function init() {
  if (typeof lucide !== "undefined") lucide.createIcons();
  vsPlayerId = getOrCreatePlayerId();
  setupModals();
  setupLanding();
  setupSoloModeSelect();
  setupVersusLobby();
  setupVersusCreate();
  setupVersusJoin();
  setupVsRematch();
  setupBackButton();
  setupPlayAgain();
  setupGiveUp();
  setupAutocomplete();
  setupHintButton();
  setupStarterToggle();
  setupHelpButton();
  setupStatsModal();
  setupShare();
  setupOnscreenKeyboard();
  // Prefetch players in background so autocomplete is ready
  fetchPlayers(true);
}

init();
