// public/js/main.js

import { MAX_GUESSES, COLUMNS, canBeTarget, compareGuess, teamLogoUrl } from "./compare.js";

let allPlayers = [];
let players = [];
let playersLoaded = null; // Promise for the one-time /players.json load
let targetPlayer = null;  // In versus this stays null until the server reveals it
let targetImages = null;
let currentMode = "classic";
let startersOnly = false;
let guessCount = 0;
let gameOver = false;

// VS state
let vsMode = false;
let vsPin = null;
let vsPlayerId = null;
let vsRole = null;         // 'host' | 'challenger'
let vsWinner = null;       // 'host' | 'challenger' | null
let vsGameStarted = false;
let vsPollingInterval = null;
let vsOpponentGuessCount = 0;
let vsRound = 1;
let vsForfeitedBy = null;  // role that gave up this round, if any
let vsStartersOnly = false;

// Touch detection
const IS_TOUCH = navigator.maxTouchPoints > 0 || "ontouchstart" in window;

// All screen IDs — only one shown at a time
const SCREENS = [
  "landing-screen",
  "start-screen",
  "versus-lobby-screen",
  "versus-create-screen",
  "versus-join-screen",
  "game-screen",
];

// ── Screen manager ─────────────────────────────────────────────
function showScreen(id) {
  SCREENS.forEach((s) => {
    const el = document.getElementById(s);
    if (el) el.style.display = s === id ? "" : "none";
  });
}

// ── Player ID (persisted across visits) ───────────────────────
function getOrCreatePlayerId() {
  let id = localStorage.getItem("nbadle_player_id");
  if (!id) {
    id =
      "p_" +
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2);
    localStorage.setItem("nbadle_player_id", id);
  }
  return id;
}

// ── Guess counter ──────────────────────────────────────────────
function updateGuessCounter() {
  const el = document.getElementById("guess-count");
  if (el) el.textContent = guessCount;
}

function resetGuessCounter() {
  guessCount = 0;
  gameOver = false;
  updateGuessCounter();
  const input = document.getElementById("player-input");
  if (input) input.disabled = false;
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
  const loader = document.getElementById("loading-indicator");
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
  if (!skipTargetSelect) document.getElementById("player-input").focus();
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
async function processGuess(guessName) {
  if (gameOver) return;
  const guess = players.find((p) => p.name === guessName);
  if (!guess) return;

  if (vsMode) {
    await processVsGuess(guess);
    return;
  }
  if (!targetPlayer) return;

  guessCount++;
  updateGuessCounter();
  const row = compareGuess(guess, targetPlayer, currentMode);
  renderRow(row, COLUMNS[currentMode]);

  if (row.correct || guessCount >= MAX_GUESSES) {
    gameOver = true;
    document.getElementById("player-input").disabled = true;
    setTimeout(() => showWinModal(!row.correct), 500);
  }
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

    renderRow(data.row, COLUMNS[currentMode]);
    await applyVsState(data);
  } catch (err) {
    console.warn("Failed to submit VS guess", err);
  } finally {
    vsGuessInFlight = false;
  }
}

const CELL_LABELS = {
  name: "Name",
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

// ── Render ─────────────────────────────────────────────────────
function renderRow(row, cols) {
  const container = document.getElementById("guesses-container");
  const rowEl = document.createElement("div");
  rowEl.className = "guess-row";

  cols.forEach((c) => {
    const cell = c === "name" ? null : row.cells[c];
    const div = document.createElement("div");
    div.className = ("cell " + (c === "name" ? "name-cell" : cell.status || "")).trim();
    if (c !== "name") div.dataset.label = CELL_LABELS[c] || c;
    const inner = document.createElement("div");
    inner.className = "inner";
    inner.textContent = c === "name" ? row.name : cell.val + (cell.arrow || "");
    div.appendChild(inner);
    rowEl.appendChild(div);
  });

  container.insertBefore(rowEl, container.firstChild);
}

// ── Win / result modal ─────────────────────────────────────────
function showWinModal(gaveUp) {
  const titleEl = document.getElementById("win-title");
  const subtitleEl = document.getElementById("win-subtitle");
  const playAgainBtn = document.getElementById("play-again-btn");
  const rematchBtn = document.getElementById("vs-rematch-btn");

  if (vsMode) {
    if (vsForfeitedBy === vsRole) {
      titleEl.textContent = "You Gave Up!";
      titleEl.style.color = "#c0392b";
      if (subtitleEl) {
        subtitleEl.textContent = "Your opponent wins this round.";
        subtitleEl.style.display = "";
      }
    } else if (vsForfeitedBy) {
      titleEl.textContent = "Opponent Gave Up!";
      titleEl.style.color = "#27ae60";
      if (subtitleEl) {
        subtitleEl.textContent = "You win this round.";
        subtitleEl.style.display = "";
      }
    } else {
      const weWon = vsWinner === vsRole;
      titleEl.textContent = weWon ? "You Won!" : "Opponent Got It!";
      titleEl.style.color = weWon ? "#27ae60" : "#c0392b";
      if (subtitleEl) {
        subtitleEl.textContent = weWon
          ? `You guessed it in ${guessCount} ${guessCount === 1 ? "guess" : "guesses"}!`
          : "Better luck next time.";
        subtitleEl.style.display = "";
      }
    }
    // Host gets "Play Again"; challenger sees lobby button only
    // (challenger's game will auto-start when host triggers rematch)
    rematchBtn.style.display = vsRole === "host" ? "" : "none";
    rematchBtn.disabled = false;
    rematchBtn.textContent = "Play Again";
    playAgainBtn.textContent = "Back to Lobby";
  } else {
    titleEl.textContent = gaveUp ? "The Player Was" : "You Got It!";
    titleEl.style.color = gaveUp ? "#c0392b" : "#27ae60";
    if (subtitleEl) subtitleEl.style.display = "none";
    rematchBtn.style.display = "none";
    playAgainBtn.textContent = "New Game";
  }

  document.getElementById("win-name").textContent = targetPlayer
    ? targetPlayer.name
    : "";

  const imgEl = document.getElementById("headshot-img");
  if (targetImages?.headshot) {
    imgEl.src = targetImages.headshot;
    imgEl.style.display = "block";
  } else {
    imgEl.style.display = "none";
  }

  document.getElementById("win-modal").style.display = "flex";
}

// ── Help modal ─────────────────────────────────────────────────
function setupHelpButton() {
  const helpBtn = document.getElementById("help-button");
  const helpModal = document.getElementById("help-modal");
  const closeBtn = document.getElementById("help-close-btn");
  helpBtn.addEventListener("click", () => (helpModal.style.display = "flex"));
  closeBtn.addEventListener("click", () => (helpModal.style.display = "none"));
  helpModal.addEventListener("click", (e) => {
    if (e.target === helpModal) helpModal.style.display = "none";
  });
}

// ── Autocomplete ───────────────────────────────────────────────
// Case- and accent-insensitive key, so "jokic" finds "Jokić" (the on-screen
// keyboard has no accented letters). Stripping combining marks keeps the
// character count of Latin names, so indexes line up for highlighting.
function fold(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function findPlayerByName(text) {
  const key = fold(text.trim());
  return players.find((p) => fold(p.name) === key);
}

function setupAutocomplete() {
  const input = document.getElementById("player-input");
  const list = document.getElementById("autocomplete-list");

  input.addEventListener("input", function () {
    list.innerHTML = "";
    if (!this.value) return;
    const val = fold(this.value);
    players
      .filter((p) => fold(p.name).includes(val))
      .forEach((match) => {
        // Highlight the typed text with DOM nodes (no regex/innerHTML from user input)
        const div = document.createElement("div");
        const at = fold(match.name).indexOf(val);
        const strong = document.createElement("strong");
        strong.textContent = match.name.slice(at, at + val.length);
        div.append(match.name.slice(0, at), strong, match.name.slice(at + val.length));
        div.addEventListener("click", () => {
          input.value = "";
          list.innerHTML = "";
          processGuess(match.name);
        });
        list.appendChild(div);
      });
  });

  document.addEventListener("click", (e) => {
    if (e.target !== input) list.innerHTML = "";
  });

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      const match = findPlayerByName(this.value);
      if (match) {
        processGuess(match.name);
        this.value = "";
        list.innerHTML = "";
      }
    }
  });
}

// ── Hint button ────────────────────────────────────────────────
function setupHintButton() {
  const btn = document.getElementById("hint-button");
  const placeholder = document.getElementById("silhouette-placeholder");
  const silhouetteImg = document.getElementById("silhouette-img");
  const teamLogoImg = document.getElementById("team-logo-img");

  btn.addEventListener("click", async () => {
    if (!targetPlayer && !vsMode) return;
    if (!targetImages) await loadTargetImages();
    if (currentMode === "stats") {
      if (targetImages?.logo) {
        teamLogoImg.src = targetImages.logo;
        teamLogoImg.style.display = "block";
        placeholder.style.display = "none";
        silhouetteImg.style.display = "none";
      }
    } else if (targetImages?.headshot && (await generateSilhouette(targetImages.headshot))) {
      silhouetteImg.style.display = "block";
      teamLogoImg.style.display = "none";
      placeholder.style.display = "none";
    } else {
      return; // leave the button enabled so the hint can be retried
    }
    btn.disabled = true;
    btn.textContent = "Hint Shown";
  });
}

// Resolves true once the silhouette is drawn. On failure it never falls back to
// the raw headshot, which would give the answer away.
async function generateSilhouette(url) {
  const img = new Image();
  img.src = url;
  const sil = document.getElementById("silhouette-img");
  const canvas = document.getElementById("silhouette-canvas");
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
  const sil = document.getElementById("silhouette-img");
  const logo = document.getElementById("team-logo-img");
  const ph = document.getElementById("silhouette-placeholder");
  const btn = document.getElementById("hint-button");
  if (sil) { sil.style.display = "none"; sil.src = ""; }
  if (logo) { logo.style.display = "none"; logo.src = ""; }
  if (ph) ph.style.display = "flex";
  if (btn) { btn.disabled = false; btn.textContent = "Show Hint"; }
}

// ── VS UI helpers ──────────────────────────────────────────────
function enterVsGameUi() {
  document.getElementById("vs-status-bar").style.display = "";
  document.getElementById("guess-max-part").style.display = "none";
  document.querySelector(".starter-filter").style.display = "none";
  // Counts and PIN are read from the live state variables at call time
  document.getElementById("vs-your-guesses").textContent = guessCount;
  document.getElementById("vs-opponent-guesses").textContent = vsOpponentGuessCount;
  document.getElementById("vs-game-pin").textContent = vsPin || "------";
}

function exitVsGameUi() {
  document.getElementById("vs-status-bar").style.display = "none";
  document.getElementById("give-up-button").style.display = "";
  document.getElementById("guess-max-part").style.display = "";
  document.querySelector(".starter-filter").style.display = "";
}

// ── OSK helpers ────────────────────────────────────────────────
function showOsk() {
  if (!IS_TOUCH) return;
  document.getElementById("onscreen-keyboard").classList.add("osk--visible");
  document.body.classList.add("osk-open");
}

function hideOsk() {
  document.getElementById("onscreen-keyboard").classList.remove("osk--visible");
  document.body.classList.remove("osk-open");
}

// ── Landing screen ─────────────────────────────────────────────
function setupLanding() {
  document.getElementById("solo-btn").addEventListener("click", () => {
    showScreen("start-screen");
  });
  document.getElementById("versus-btn").addEventListener("click", () => {
    showScreen("versus-lobby-screen");
  });
}

// ── Solo mode select ───────────────────────────────────────────
function setupSoloModeSelect() {
  document.getElementById("solo-back-btn").addEventListener("click", () => {
    showScreen("landing-screen");
  });

  document.querySelectorAll("#start-screen .mode-btn[data-mode]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      currentMode = btn.dataset.mode;
      await startSoloGame();
    });
  });
}

async function startSoloGame() {
  vsMode = false;
  exitVsGameUi();

  const classicHeader = document.getElementById("classic-header");
  const statsHeader = document.getElementById("stats-header");
  document.getElementById("game-mode-label").textContent =
    currentMode === "classic" ? "Classic" : "Stats";
  classicHeader.style.display = currentMode === "classic" ? "flex" : "none";
  statsHeader.style.display = currentMode === "stats" ? "flex" : "none";

  resetHintVisuals();
  resetGuessCounter();
  document.getElementById("guesses-container").innerHTML = "";

  showScreen("game-screen");
  await fetchPlayers();
  showOsk();
}

// ── Versus lobby ───────────────────────────────────────────────
function setupVersusLobby() {
  document.getElementById("versus-back-btn").addEventListener("click", () => {
    showScreen("landing-screen");
  });

  document.getElementById("create-game-btn").addEventListener("click", () => {
    document.getElementById("vs-mode-select-step").style.display = "";
    document.getElementById("vs-waiting-step").style.display = "none";
    showScreen("versus-create-screen");
  });

  document.getElementById("join-game-btn").addEventListener("click", () => {
    document.getElementById("pin-input").value = "";
    document.getElementById("join-error").style.display = "none";
    document.getElementById("join-game-submit-btn").disabled = false;
    document.getElementById("join-game-submit-btn").textContent = "Join Game";
    showScreen("versus-join-screen");
  });
}

// ── Versus create ──────────────────────────────────────────────
function setupVersusCreate() {
  document.getElementById("vs-create-back-btn").addEventListener("click", () => {
    showScreen("versus-lobby-screen");
  });

  document.getElementById("cancel-vs-btn").addEventListener("click", () => {
    stopVsPolling();
    vsPin = null;
    showScreen("versus-lobby-screen");
  });

  document.getElementById("copy-pin-btn").addEventListener("click", () => {
    const pin = document.getElementById("vs-pin-display").textContent;
    navigator.clipboard.writeText(pin).catch(() => {});
    const btn = document.getElementById("copy-pin-btn");
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = "Copy PIN"), 2000);
  });

  document.getElementById("vs-starter-toggle").addEventListener("change", (e) => {
    vsStartersOnly = e.target.checked;
  });

  document.querySelectorAll(".mode-btn[data-vs-mode]").forEach((btn) => {
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

async function createVsGame(mode) {
  currentMode = mode;

  // Switch to waiting step
  document.getElementById("vs-mode-select-step").style.display = "none";
  document.getElementById("vs-waiting-step").style.display = "";
  document.getElementById("vs-pin-display").textContent = "------";
  document.getElementById("vs-waiting-status").textContent = "Creating game…";
  document.getElementById("copy-pin-btn").textContent = "Copy PIN";

  try {
    const data = await postVs("create", { mode, starters_only: vsStartersOnly });

    vsPin = data.pin;
    vsRole = "host";
    vsRound = data.round;
    vsGameStarted = false;
    targetPlayer = null;
    targetImages = null;

    document.getElementById("vs-pin-display").textContent = data.pin;
    document.getElementById("vs-waiting-status").textContent =
      "Waiting for opponent…";

    // Poll until challenger joins, then launch game
    startVsPolling();
  } catch (err) {
    console.error("Failed to create VS game", err);
    document.getElementById("vs-waiting-status").textContent =
      "Error creating game. Tap Cancel and try again.";
  }
}

// ── Versus join ────────────────────────────────────────────────
function setupVersusJoin() {
  document.getElementById("vs-join-back-btn").addEventListener("click", () => {
    showScreen("versus-lobby-screen");
  });

  document
    .getElementById("join-game-submit-btn")
    .addEventListener("click", async () => {
      await joinVsGame();
    });

  document
    .getElementById("pin-input")
    .addEventListener("keydown", async (e) => {
      if (e.key === "Enter") await joinVsGame();
    });
}

async function joinVsGame() {
  const pin = document.getElementById("pin-input").value.trim().toUpperCase();
  const errEl = document.getElementById("join-error");
  const submitBtn = document.getElementById("join-game-submit-btn");

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
    document.getElementById("vs-pin-display").textContent = vsPin;
    document.getElementById("vs-waiting-status").textContent = "Waiting for opponent…";
    document.getElementById("copy-pin-btn").textContent = "Copy PIN";
    document.getElementById("vs-mode-select-step").style.display = "none";
    document.getElementById("vs-waiting-step").style.display = "";
    showScreen("versus-create-screen");
    startVsPolling();
    return;
  }

  // Host reconnecting mid-game, or challenger (new or returning)
  vsGameStarted = true;
  await startVsGame(data);
  startVsPolling();
}

// ── VS game launch ─────────────────────────────────────────────
// `state` is the server's room state, so reconnecting players restore accurate counts.
async function startVsGame(state) {
  vsMode = true;
  vsWinner = null;
  vsForfeitedBy = null;
  gameOver = false;
  guessCount = 0;
  vsOpponentGuessCount = 0;
  targetPlayer = null;
  targetImages = null;

  const classicHeader = document.getElementById("classic-header");
  const statsHeader = document.getElementById("stats-header");
  document.getElementById("game-mode-label").textContent =
    currentMode === "classic" ? "Classic" : "Stats";
  classicHeader.style.display = currentMode === "classic" ? "flex" : "none";
  statsHeader.style.display = currentMode === "stats" ? "flex" : "none";

  resetHintVisuals();
  document.getElementById("player-input").disabled = false;
  document.getElementById("guesses-container").innerHTML = "";
  document.getElementById("win-modal").style.display = "none";

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
  guessCount = Math.max(guessCount, mine || 0);
  vsOpponentGuessCount = theirs || 0;
  updateGuessCounter();
  document.getElementById("vs-your-guesses").textContent = guessCount;
  document.getElementById("vs-opponent-guesses").textContent = vsOpponentGuessCount;

  if (state.winner && !gameOver) {
    gameOver = true;
    vsWinner = state.winner;
    vsForfeitedBy = state.forfeited_by || null;
    if (state.target_player) {
      targetPlayer = state.target_player;
      targetImages = { headshot: "/api/headshot/" + targetPlayer.id };
    }
    document.getElementById("player-input").disabled = true;
    setTimeout(() => showWinModal(false), 300);
  }
}

// ── VS polling ─────────────────────────────────────────────────
function startVsPolling() {
  stopVsPolling();
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
    if (!res.ok) return;
    const data = await res.json();

    // Phase 1 — host waiting for challenger to join
    if (vsRole === "host" && !vsGameStarted) {
      if (data.started) {
        vsGameStarted = true;
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
    await applyVsState(data);
  } catch (_) {
    // Ignore network errors during polling
  }
}

// ── VS rematch (host only) ─────────────────────────────────────
function setupVsRematch() {
  document.getElementById("vs-rematch-btn").addEventListener("click", async () => {
    const btn = document.getElementById("vs-rematch-btn");
    btn.disabled = true;
    btn.textContent = "Starting…";

    try {
      const data = await postVs("rematch");
      vsRound = data.round;
      await startVsGame(data);
      // Polling already running — challenger will detect the new round automatically
    } catch (_) {
      btn.disabled = false;
      btn.textContent = "Play Again";
    }
  });
}

// ── VS state reset ─────────────────────────────────────────────
function resetVsState() {
  stopVsPolling();
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
  document.getElementById("back-button").addEventListener("click", () => {
    document.getElementById("guesses-container").innerHTML = "";
    document.getElementById("win-modal").style.display = "none";
    resetHintVisuals();
    resetGuessCounter();
    hideOsk();

    if (vsMode) {
      resetVsState();
      exitVsGameUi();
      showScreen("landing-screen");
    } else {
      exitVsGameUi();
      showScreen("start-screen");
      targetPlayer = pickSoloTarget();
      targetImages = null;
    }
  });
}

// ── Play again ─────────────────────────────────────────────────
function setupPlayAgain() {
  document.getElementById("play-again-btn").addEventListener("click", async () => {
    document.getElementById("win-modal").style.display = "none";

    if (vsMode) {
      resetVsState();
      exitVsGameUi();
      showScreen("landing-screen");
      return;
    }

    document.getElementById("guesses-container").innerHTML = "";
    resetHintVisuals();
    resetGuessCounter();
    targetPlayer = pickSoloTarget();
    await loadTargetImages();
    showOsk();
  });
}

// ── Give up ────────────────────────────────────────────────────
function setupGiveUp() {
  document.getElementById("give-up-button").addEventListener("click", async () => {
    if (gameOver) return;

    if (vsMode) {
      // The server reveals the target once the round is decided
      try {
        const state = await postVs("forfeit");
        await applyVsState(state);
      } catch (err) {
        console.warn("Failed to report VS forfeit", err);
      }
      return;
    }

    if (!targetPlayer) return;
    gameOver = true;
    document.getElementById("player-input").disabled = true;
    showWinModal(true);
  });
}

// ── Starter toggle ─────────────────────────────────────────────
function setupStarterToggle() {
  document
    .getElementById("starter-toggle")
    .addEventListener("change", async (e) => {
      startersOnly = e.target.checked;
      document.getElementById("guesses-container").innerHTML = "";
      resetHintVisuals();
      resetGuessCounter();
      await fetchPlayers();
      if (IS_TOUCH) showOsk();
    });
}

// ── On-screen keyboard ─────────────────────────────────────────
function setupOnscreenKeyboard() {
  if (!IS_TOUCH) return;

  const keyboard = document.getElementById("onscreen-keyboard");
  const input = document.getElementById("player-input");
  const backspace = document.getElementById("osk-backspace");
  const enterBtn = document.getElementById("osk-enter");

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

      let match = findPlayerByName(input.value);

      if (!match) {
        const list = document.getElementById("autocomplete-list");
        if (list.firstChild) {
          const firstSuggestion = list.firstChild.textContent;
          match = players.find((p) => p.name === firstSuggestion);
        }
      }

      if (match) {
        processGuess(match.name);
        input.value = "";
        document.getElementById("autocomplete-list").innerHTML = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }

      input.focus({ preventScroll: true });
    },
    { passive: false },
  );
}

// ── Init ───────────────────────────────────────────────────────
function init() {
  if (typeof lucide !== "undefined") lucide.createIcons();
  vsPlayerId = getOrCreatePlayerId();
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
  setupOnscreenKeyboard();
  // Prefetch players in background so autocomplete is ready
  fetchPlayers(true);
}

init();
