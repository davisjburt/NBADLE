// static/js/main.js

const MAX_GUESSES = 8;

let players = Array.isArray(fallbackPlayers) ? [...fallbackPlayers] : [];
let targetPlayer =
  players.length > 0
    ? players[Math.floor(Math.random() * players.length)]
    : null;
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
async function fetchPlayers(skipTargetSelect = false) {
  const loader = document.getElementById("loading-indicator");
  loader.style.display = "block";
  try {
    const q = startersOnly ? "?starters_only=true" : "";
    const res = await fetch("/api/players" + q);
    if (!res.ok) throw new Error("Server error");
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      players = data;
      if (!skipTargetSelect) {
        targetPlayer = players[Math.floor(Math.random() * players.length)];
        targetImages = null;
        await loadTargetImages();
      }
    }
  } catch (err) {
    console.warn("Backend unavailable. Using fallback.", err);
    players = startersOnly
      ? fallbackPlayers.filter((p) => p.is_starter)
      : [...fallbackPlayers];
    if (!skipTargetSelect && players.length > 0)
      targetPlayer = players[Math.floor(Math.random() * players.length)];
  }
  if (!skipTargetSelect && targetPlayer && !targetImages) await loadTargetImages();
  loader.style.display = "none";
  if (!skipTargetSelect) document.getElementById("player-input").focus();
}

async function loadTargetImages() {
  if (!targetPlayer) return;
  try {
    const res = await fetch("/api/player_image/" + targetPlayer.id);
    const json = await res.json();
    if (!json.headshot) throw new Error("no headshot");
    targetImages = json;
  } catch {
    targetImages = null;
  }
}

// ── Comparison helpers ─────────────────────────────────────────
function parseHeight(h) {
  if (!h) return 0;
  const p = h.split("'");
  return p.length < 2
    ? 0
    : parseInt(p[0]) * 12 + parseInt(p[1].replace('"', ""));
}

function checkMatch(g, t) {
  return g === t ? "match" : "nomatch";
}
function checkPos(gp, tp) {
  if (gp === tp) return "match";
  if (gp.includes(tp) || tp.includes(gp)) return "partial";
  return "nomatch";
}

function checkNum(g, t, thresh) {
  const gv = Number(g ?? 0),
    tv = Number(t ?? 0);
  if (!isFinite(gv) || !isFinite(tv)) return { status: "nomatch", arrow: "" };
  const diff = Math.abs(gv - tv);
  let status = gv === tv ? "match" : diff <= thresh ? "partial" : "nomatch";
  let arrow = gv < tv ? " ▲" : gv > tv ? " ▼" : "";
  return { status, arrow };
}

// ── Guess processing ───────────────────────────────────────────
function processGuess(guessName) {
  if (gameOver) return;
  const guess = players.find((p) => p.name === guessName);
  if (!guess || !targetPlayer) return;

  guessCount++;
  updateGuessCounter();

  let stats, cols;

  if (currentMode === "classic") {
    stats = {
      name: guess.name,
      team: {
        val: guess.team,
        status: checkMatch(guess.team, targetPlayer.team),
      },
      conf: {
        val: guess.conf,
        status: checkMatch(guess.conf, targetPlayer.conf),
      },
      div: { val: guess.div, status: checkMatch(guess.div, targetPlayer.div) },
      pos: { val: guess.pos, status: checkPos(guess.pos, targetPlayer.pos) },
      height: {
        val: guess.height,
        ...checkNum(
          parseHeight(guess.height),
          parseHeight(targetPlayer.height),
          2,
        ),
      },
      age: { val: guess.age, ...checkNum(guess.age, targetPlayer.age, 2) },
      number: {
        val: guess.number,
        ...checkNum(guess.number, targetPlayer.number, 2),
      },
    };
    cols = ["name", "team", "conf", "div", "pos", "height", "age", "number"];
  } else {
    const gPts = Number(guess.pts ?? 0),
      gReb = Number(guess.reb ?? 0),
      gAst = Number(guess.ast ?? 0);
    const gStl = Number(guess.stl ?? 0),
      gBlk = Number(guess.blk ?? 0),
      g3m = Number(guess.fg3m ?? 0);
    const tPts = Number(targetPlayer.pts ?? 0),
      tReb = Number(targetPlayer.reb ?? 0),
      tAst = Number(targetPlayer.ast ?? 0);
    const tStl = Number(targetPlayer.stl ?? 0),
      tBlk = Number(targetPlayer.blk ?? 0),
      t3m = Number(targetPlayer.fg3m ?? 0);
    stats = {
      name: guess.name,
      team: {
        val: guess.team,
        status: checkMatch(guess.team, targetPlayer.team),
      },
      pts: {
        val: isFinite(gPts) ? gPts.toFixed(1) : "0.0",
        ...checkNum(gPts, tPts, 1.0),
      },
      reb: {
        val: isFinite(gReb) ? gReb.toFixed(1) : "0.0",
        ...checkNum(gReb, tReb, 1.0),
      },
      ast: {
        val: isFinite(gAst) ? gAst.toFixed(1) : "0.0",
        ...checkNum(gAst, tAst, 1.0),
      },
      stl: {
        val: isFinite(gStl) ? gStl.toFixed(1) : "0.0",
        ...checkNum(gStl, tStl, 0.5),
      },
      blk: {
        val: isFinite(gBlk) ? gBlk.toFixed(1) : "0.0",
        ...checkNum(gBlk, tBlk, 0.5),
      },
      fg3m: {
        val: isFinite(g3m) ? g3m.toFixed(1) : "0.0",
        ...checkNum(g3m, t3m, 0.5),
      },
    };
    cols = ["name", "team", "pts", "reb", "ast", "stl", "blk", "fg3m"];
  }

  renderRow(stats, cols);
}

// ── Render ─────────────────────────────────────────────────────
function renderRow(stats, cols) {
  const container = document.getElementById("guesses-container");
  const row = document.createElement("div");
  row.className = "guess-row";

  cols.forEach((c) => {
    const div = document.createElement("div");
    div.className = (
      "cell " +
      (c === "name" ? "name-cell" : "") +
      " " +
      (c !== "name" ? stats[c].status || "" : "")
    ).trim();
    if (c === "name") {
      div.textContent = stats[c];
    } else {
      const inner = document.createElement("div");
      inner.className = "inner";
      inner.textContent = stats[c].val + (stats[c].arrow || "");
      div.appendChild(inner);
    }
    row.appendChild(div);
  });

  container.insertBefore(row, container.firstChild);

  const won = stats.name === targetPlayer.name;

  if (vsMode) {
    // Report every guess to server; check win condition locally
    reportVsGuess(won);
    if (won) {
      vsWinner = vsRole;
      stopVsPolling();
      gameOver = true;
      document.getElementById("player-input").disabled = true;
      setTimeout(() => showWinModal(false), 500);
    }
    // No max-guess limit in VS — game continues until someone wins
  } else {
    if (won || guessCount >= MAX_GUESSES) {
      gameOver = true;
      document.getElementById("player-input").disabled = true;
      setTimeout(() => showWinModal(!won), 500);
    }
  }
}

// ── Win / result modal ─────────────────────────────────────────
function showWinModal(gaveUp) {
  const titleEl = document.getElementById("win-title");
  const subtitleEl = document.getElementById("win-subtitle");
  const playAgainBtn = document.getElementById("play-again-btn");

  if (vsMode) {
    const weWon = vsWinner === vsRole;
    titleEl.textContent = weWon ? "You Won!" : "Opponent Got It!";
    titleEl.style.color = weWon ? "#27ae60" : "#c0392b";
    if (subtitleEl) {
      subtitleEl.textContent = weWon
        ? `You guessed it in ${guessCount} ${guessCount === 1 ? "guess" : "guesses"}!`
        : "Better luck next time.";
      subtitleEl.style.display = "";
    }
    playAgainBtn.textContent = "Back to Lobby";
  } else {
    titleEl.textContent = gaveUp ? "The Player Was" : "You Got It!";
    titleEl.style.color = gaveUp ? "#c0392b" : "#27ae60";
    if (subtitleEl) subtitleEl.style.display = "none";
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
function setupAutocomplete() {
  const input = document.getElementById("player-input");
  const list = document.getElementById("autocomplete-list");

  input.addEventListener("input", function () {
    list.innerHTML = "";
    if (!this.value) return;
    const val = this.value.toLowerCase();
    players
      .filter((p) => p.name.toLowerCase().includes(val))
      .forEach((match) => {
        const div = document.createElement("div");
        div.innerHTML = match.name.replace(
          new RegExp("(" + val + ")", "gi"),
          "<strong>$1</strong>",
        );
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
      const match = players.find(
        (p) => p.name.toLowerCase() === this.value.trim().toLowerCase(),
      );
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
    if (!targetPlayer) return;
    if (currentMode === "stats") {
      try {
        const data = await (
          await fetch("/api/team_logo/" + targetPlayer.team)
        ).json();
        if (data.logo) {
          teamLogoImg.src = data.logo;
          teamLogoImg.style.display = "block";
          placeholder.style.display = "none";
          silhouetteImg.style.display = "none";
        }
      } catch (e) {
        console.warn("Logo fetch failed", e);
      }
    } else {
      if (!targetImages) await loadTargetImages();
      if (targetImages?.headshot) {
        await generateSilhouette(targetImages.headshot);
        silhouetteImg.style.display = "block";
        teamLogoImg.style.display = "none";
        placeholder.style.display = "none";
      }
    }
    btn.disabled = true;
    btn.textContent = "Hint Shown";
  });
}

async function generateSilhouette(url) {
  const img = new Image();
  img.crossOrigin = "anonymous";
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
      res();
    };
    img.onerror = () => {
      sil.src = url;
      res();
    };
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
  document.getElementById("give-up-button").style.display = "none";
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
  document.getElementById("game-title").textContent =
    currentMode === "classic" ? "NBADLE – Classic" : "NBADLE – Stats";
  classicHeader.style.display = currentMode === "classic" ? "flex" : "none";
  statsHeader.style.display = currentMode === "stats" ? "flex" : "none";

  resetHintVisuals();
  resetGuessCounter();
  document.getElementById("guesses-container").innerHTML = "";

  if (players.length > 0)
    targetPlayer = players[Math.floor(Math.random() * players.length)];
  targetImages = null;
  await loadTargetImages();

  showScreen("game-screen");
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
    startersOnly = e.target.checked;
  });

  document.querySelectorAll(".mode-btn[data-vs-mode]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await createVsGame(btn.dataset.vsMode);
    });
  });
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
    const res = await fetch("/api/vs/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        starters_only: startersOnly,
        player_id: vsPlayerId,
      }),
    });
    const data = await res.json();

    vsPin = data.pin;
    vsRole = "host";
    vsGameStarted = false;
    targetPlayer = data.target_player;
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

  if (pin.length < 4) {
    errEl.textContent = "Please enter a valid PIN.";
    errEl.style.display = "";
    return;
  }

  errEl.style.display = "none";
  submitBtn.disabled = true;
  submitBtn.textContent = "Joining…";

  try {
    const res = await fetch("/api/vs/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, player_id: vsPlayerId }),
    });

    if (!res.ok) {
      const data = await res.json();
      errEl.textContent = data.error || "Could not join. Check the PIN.";
      errEl.style.display = "";
      submitBtn.disabled = false;
      submitBtn.textContent = "Join Game";
      return;
    }

    const data = await res.json();
    vsPin = data.pin;
    vsRole = data.role;           // 'host' | 'challenger'
    currentMode = data.mode;
    targetPlayer = data.target_player;
    targetImages = null;

    const yourCount = data.your_guess_count || 0;
    const oppCount  = data.opponent_guess_count || 0;

    // Game already over — show result
    if (data.winner) {
      vsWinner = data.winner;
      vsGameStarted = true;
      await startVsGame(yourCount, oppCount);
      setTimeout(() => showWinModal(false), 300);
      return;
    }

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

    // Host reconnecting mid-game OR challenger (new or returning)
    vsGameStarted = true;
    await startVsGame(yourCount, oppCount);
    startVsPolling();
  } catch (err) {
    errEl.textContent = "Connection error. Try again.";
    errEl.style.display = "";
    submitBtn.disabled = false;
    submitBtn.textContent = "Join Game";
  }
}

// ── VS game launch ─────────────────────────────────────────────
// yourCount / oppCount let reconnecting players restore accurate counts.
async function startVsGame(yourCount = 0, oppCount = 0) {
  vsMode = true;
  guessCount = yourCount;
  vsOpponentGuessCount = oppCount;
  gameOver = false;

  const classicHeader = document.getElementById("classic-header");
  const statsHeader = document.getElementById("stats-header");
  document.getElementById("game-title").textContent =
    currentMode === "classic" ? "NBADLE – Classic" : "NBADLE – Stats";
  classicHeader.style.display = currentMode === "classic" ? "flex" : "none";
  statsHeader.style.display = currentMode === "stats" ? "flex" : "none";

  enterVsGameUi();   // sets status bar counts + PIN from current state
  resetHintVisuals();
  updateGuessCounter();
  document.getElementById("player-input").disabled = false;
  document.getElementById("guesses-container").innerHTML = "";

  await loadTargetImages();

  showScreen("game-screen");
  showOsk();
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
    const res = await fetch(
      `/api/vs/status/${vsPin}?player_id=${vsPlayerId}`
    );
    if (!res.ok) return;
    const data = await res.json();

    // Host waiting for challenger to join
    if (vsRole === "host" && !vsGameStarted) {
      if (data.started) {
        vsGameStarted = true;
        // Pass challenger's current count so host sees accurate opponent tally
        await startVsGame(0, data.challenger_guess_count || 0);
        startVsPolling(); // restart polling now that game is live
      }
      return;
    }

    // In-game: sync both counts from server truth
    vsOpponentGuessCount =
      vsRole === "host" ? data.challenger_guess_count : data.host_guess_count;
    const serverYours =
      vsRole === "host" ? data.host_guess_count : data.challenger_guess_count;

    const oppEl = document.getElementById("vs-opponent-guesses");
    if (oppEl) oppEl.textContent = vsOpponentGuessCount;

    // Reconcile our count with server (catches reconnection drift)
    if (serverYours > guessCount) {
      guessCount = serverYours;
      updateGuessCounter();
      const yourEl = document.getElementById("vs-your-guesses");
      if (yourEl) yourEl.textContent = guessCount;
    }

    // Detect opponent win (we haven't won yet ourselves)
    if (data.winner && !vsWinner && !gameOver) {
      vsWinner = data.winner;
      const weWon =
        (vsRole === "host" && data.winner === "host") ||
        (vsRole === "challenger" && data.winner === "challenger");

      if (!weWon) {
        stopVsPolling();
        gameOver = true;
        if (data.target_player) targetPlayer = data.target_player;
        if (targetPlayer) {
          try {
            const imgRes = await fetch("/api/player_image/" + targetPlayer.id);
            const imgJson = await imgRes.json();
            if (imgJson.headshot) targetImages = imgJson;
          } catch (_) {}
        }
        document.getElementById("player-input").disabled = true;
        setTimeout(() => showWinModal(false), 300);
      }
    }
  } catch (_) {
    // Ignore network errors during polling
  }
}

// ── Report guess to server ─────────────────────────────────────
async function reportVsGuess(correct) {
  const yourEl = document.getElementById("vs-your-guesses");
  if (yourEl) yourEl.textContent = guessCount;

  if (!vsPin || !vsPlayerId) return;
  try {
    await fetch("/api/vs/guess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pin: vsPin,
        player_id: vsPlayerId,
        correct,
      }),
    });
  } catch (err) {
    console.warn("Failed to report VS guess", err);
  }
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
      if (players.length > 0) {
        targetPlayer = players[Math.floor(Math.random() * players.length)];
        targetImages = null;
      }
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
    if (players.length > 0)
      targetPlayer = players[Math.floor(Math.random() * players.length)];
    targetImages = null;
    await loadTargetImages();
    showOsk();
  });
}

// ── Give up ────────────────────────────────────────────────────
function setupGiveUp() {
  document.getElementById("give-up-button").addEventListener("click", () => {
    if (!targetPlayer || vsMode) return;
    gameOver = true;
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

      const val = input.value.trim().toLowerCase();
      let match = players.find((p) => p.name.toLowerCase() === val);

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
  vsPlayerId = getOrCreatePlayerId();
  setupLanding();
  setupSoloModeSelect();
  setupVersusLobby();
  setupVersusCreate();
  setupVersusJoin();
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
