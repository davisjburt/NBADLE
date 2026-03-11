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

// ── Guess counter ──────────────────────────────────────────
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

// ── Player fetching ────────────────────────────────────────
async function fetchPlayers() {
  const loader = document.getElementById("loading-indicator");
  loader.style.display = "block";
  try {
    const startersParam = startersOnly ? "?starters_only=true" : "";
    const response = await fetch("/api/players" + startersParam);
    if (!response.ok) throw new Error("Server error");
    const data = await response.json();
    if (Array.isArray(data) && data.length > 0) {
      players = data;
      targetPlayer = players[Math.floor(Math.random() * players.length)];
      targetImages = null;
      await loadTargetImages();
      console.log("Live data loaded: " + players.length + " players.");
    }
  } catch (err) {
    console.warn("Backend unavailable. Using fallback data.", err);
    if (startersOnly) {
      players = fallbackPlayers.filter((p) => p.is_starter);
    } else {
      players = fallbackPlayers;
    }
    if (players.length > 0) {
      targetPlayer = players[Math.floor(Math.random() * players.length)];
    }
  }
  if (targetPlayer && !targetImages) {
    await loadTargetImages();
  }
  loader.style.display = "none";
  document.getElementById("player-input").focus();
}

async function loadTargetImages() {
  if (!targetPlayer) return;
  try {
    const res = await fetch("/api/player_image/" + targetPlayer.id);
    if (!res.ok) throw new Error("image error");
    const json = await res.json();
    if (!json.headshot) throw new Error("no headshot");
    targetImages = json;
  } catch (e) {
    targetImages = null;
  }
}

// ── Comparison helpers ─────────────────────────────────────
function parseHeight(hStr) {
  if (!hStr) return 0;
  const parts = hStr.split("'");
  if (parts.length < 2) return 0;
  return parseInt(parts[0]) * 12 + parseInt(parts[1].replace('"', ""));
}

function checkMatch(guessVal, targetVal) {
  return guessVal === targetVal ? "match" : "nomatch";
}

function checkPos(guessPos, targetPos) {
  if (guessPos === targetPos) return "match";
  if (guessPos.includes(targetPos) || targetPos.includes(guessPos))
    return "partial";
  return "nomatch";
}

function checkNumberVal(guessVal, targetVal, threshold) {
  const g = Number(guessVal ?? 0);
  const t = Number(targetVal ?? 0);
  if (!Number.isFinite(g) || !Number.isFinite(t)) {
    return { status: "nomatch", arrow: "" };
  }
  const diff = Math.abs(g - t);
  let status = "nomatch";
  if (g === t) status = "match";
  else if (diff <= threshold) status = "partial";
  let arrow = "";
  if (g < t) arrow = " ▲";
  if (g > t) arrow = " ▼";
  return { status, arrow };
}

// ── Guess processing ───────────────────────────────────────
function processGuess(guessName) {
  if (gameOver) return;
  const guess = players.find((p) => p.name === guessName);
  if (!guess || !targetPlayer) return;

  guessCount++;
  updateGuessCounter();

  if (currentMode === "classic") {
    const stats = {
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
        ...checkNumberVal(
          parseHeight(guess.height),
          parseHeight(targetPlayer.height),
          2,
        ),
      },
      age: {
        val: guess.age,
        ...checkNumberVal(guess.age, targetPlayer.age, 2),
      },
      number: {
        val: guess.number,
        ...checkNumberVal(guess.number, targetPlayer.number, 2),
      },
    };
    renderRow(stats, [
      "name",
      "team",
      "conf",
      "div",
      "pos",
      "height",
      "age",
      "number",
    ]);
  } else {
    const gPts = Number(guess.pts ?? 0);
    const gReb = Number(guess.reb ?? 0);
    const gAst = Number(guess.ast ?? 0);
    const gStl = Number(guess.stl ?? 0);
    const gBlk = Number(guess.blk ?? 0);
    const g3m = Number(guess.fg3m ?? 0);
    const tPts = Number(targetPlayer.pts ?? 0);
    const tReb = Number(targetPlayer.reb ?? 0);
    const tAst = Number(targetPlayer.ast ?? 0);
    const tStl = Number(targetPlayer.stl ?? 0);
    const tBlk = Number(targetPlayer.blk ?? 0);
    const t3m = Number(targetPlayer.fg3m ?? 0);

    const stats = {
      name: guess.name,
      team: {
        val: guess.team,
        status: checkMatch(guess.team, targetPlayer.team),
      },
      pts: {
        val: Number.isFinite(gPts) ? gPts.toFixed(1) : "0.0",
        ...checkNumberVal(gPts, tPts, 1.0),
      },
      reb: {
        val: Number.isFinite(gReb) ? gReb.toFixed(1) : "0.0",
        ...checkNumberVal(gReb, tReb, 1.0),
      },
      ast: {
        val: Number.isFinite(gAst) ? gAst.toFixed(1) : "0.0",
        ...checkNumberVal(gAst, tAst, 1.0),
      },
      stl: {
        val: Number.isFinite(gStl) ? gStl.toFixed(1) : "0.0",
        ...checkNumberVal(gStl, tStl, 0.5),
      },
      blk: {
        val: Number.isFinite(gBlk) ? gBlk.toFixed(1) : "0.0",
        ...checkNumberVal(gBlk, tBlk, 0.5),
      },
      fg3m: {
        val: Number.isFinite(g3m) ? g3m.toFixed(1) : "0.0",
        ...checkNumberVal(g3m, t3m, 0.5),
      },
    };
    renderRow(stats, [
      "name",
      "team",
      "pts",
      "reb",
      "ast",
      "stl",
      "blk",
      "fg3m",
    ]);
  }
}

// ── Render ─────────────────────────────────────────────────
function renderRow(stats, cells) {
  const container = document.getElementById("guesses-container");
  const row = document.createElement("div");
  row.className = "guess-row";

  cells.forEach((c) => {
    const div = document.createElement("div");
    const baseClass = c === "name" ? "name-cell" : "";
    const statusClass = c === "name" ? "" : stats[c].status || "";
    div.className = ("cell " + baseClass + " " + statusClass).trim();
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
  const outOfGuesses = guessCount >= MAX_GUESSES;

  if (won) {
    gameOver = true;
    document.getElementById("player-input").disabled = true;
    setTimeout(() => showWinModal(false), 500);
  } else if (outOfGuesses) {
    gameOver = true;
    document.getElementById("player-input").disabled = true;
    setTimeout(() => showWinModal(true), 500);
  }
}

// ── Modals ─────────────────────────────────────────────────
function showWinModal(gaveUp) {
  document.getElementById("win-name").textContent = targetPlayer.name;
  const titleEl = document.getElementById("win-title");
  const imgEl = document.getElementById("headshot-img");

  titleEl.textContent = gaveUp ? "The Player Was" : "You Got It!";
  titleEl.style.color = gaveUp ? "#c0392b" : "#27ae60";

  if (targetImages && targetImages.headshot) {
    imgEl.src = targetImages.headshot;
    imgEl.style.display = "block";
  } else {
    imgEl.style.display = "none";
  }

  document.getElementById("win-modal").style.display = "flex";
}

function setupHelpButton() {
  const helpBtn = document.getElementById("help-button");
  const helpModal = document.getElementById("help-modal");
  const closeBtn = document.getElementById("help-close-btn");

  helpBtn.addEventListener("click", () => {
    helpModal.style.display = "flex";
  });
  closeBtn.addEventListener("click", () => {
    helpModal.style.display = "none";
  });
  helpModal.addEventListener("click", (e) => {
    if (e.target === helpModal) helpModal.style.display = "none";
  });
}

// ── Autocomplete ───────────────────────────────────────────
function setupAutocomplete() {
  const input = document.getElementById("player-input");
  const list = document.getElementById("autocomplete-list");

  input.addEventListener("input", function () {
    list.innerHTML = "";
    if (!this.value) return;
    const val = this.value.toLowerCase();
    const matches = players.filter((p) => p.name.toLowerCase().includes(val));
    matches.forEach((match) => {
      const div = document.createElement("div");
      const regex = new RegExp("(" + val + ")", "gi");
      div.innerHTML = match.name.replace(regex, "<strong>$1</strong>");
      div.addEventListener("click", function () {
        input.value = "";
        list.innerHTML = "";
        processGuess(match.name);
      });
      list.appendChild(div);
    });
  });

  document.addEventListener("click", function (e) {
    if (e.target !== input) list.innerHTML = "";
  });

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      const guessName = this.value.trim();
      if (guessName) {
        const exactMatch = players.find(
          (p) => p.name.toLowerCase() === guessName.toLowerCase(),
        );
        if (exactMatch) {
          processGuess(exactMatch.name);
          this.value = "";
          list.innerHTML = "";
        }
      }
    }
  });
}

// ── Hint button ────────────────────────────────────────────
function setupHintButton() {
  const btn = document.getElementById("hint-button");
  const placeholder = document.getElementById("silhouette-placeholder");
  const silhouetteImg = document.getElementById("silhouette-img");
  const teamLogoImg = document.getElementById("team-logo-img");

  btn.addEventListener("click", async () => {
    if (!targetPlayer) return;

    if (currentMode === "stats") {
      try {
        const resp = await fetch("/api/team_logo/" + targetPlayer.team);
        const data = await resp.json();
        if (data.logo) {
          teamLogoImg.src = data.logo;
          teamLogoImg.style.display = "block";
          placeholder.style.display = "none";
          silhouetteImg.style.display = "none";
        }
      } catch (e) {
        console.warn("Team logo fetch failed", e);
      }
      btn.disabled = true;
      btn.textContent = "Hint Shown";
      return;
    }

    if (!targetImages) await loadTargetImages();
    if (targetImages && targetImages.headshot) {
      await generateSilhouetteFromHeadshot(targetImages.headshot);
      silhouetteImg.style.display = "block";
      teamLogoImg.style.display = "none";
      placeholder.style.display = "none";
      btn.disabled = true;
      btn.textContent = "Hint Shown";
    }
  });
}

async function generateSilhouetteFromHeadshot(headshotUrl) {
  const imgEl = new Image();
  imgEl.crossOrigin = "anonymous";
  imgEl.src = headshotUrl;
  const silhouetteImg = document.getElementById("silhouette-img");
  const canvas = document.getElementById("silhouette-canvas");
  const ctx = canvas.getContext("2d");
  return new Promise((resolve) => {
    imgEl.onload = () => {
      const w = 200,
        h = 190;
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(imgEl, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 0) {
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
          data[i + 3] = 255;
        }
      }
      ctx.putImageData(imageData, 0, 0);
      silhouetteImg.src = canvas.toDataURL("image/png");
      resolve();
    };
    imgEl.onerror = () => {
      silhouetteImg.src = headshotUrl;
      resolve();
    };
  });
}

// ── Reset helpers ──────────────────────────────────────────
function resetHintVisuals() {
  const silhouetteImgEl = document.getElementById("silhouette-img");
  const teamLogoImgEl = document.getElementById("team-logo-img");
  const placeholderEl = document.getElementById("silhouette-placeholder");
  const hintBtn = document.getElementById("hint-button");

  if (silhouetteImgEl) {
    silhouetteImgEl.style.display = "none";
    silhouetteImgEl.src = "";
  }
  if (teamLogoImgEl) {
    teamLogoImgEl.style.display = "none";
    teamLogoImgEl.src = "";
  }
  if (placeholderEl) placeholderEl.style.display = "flex";
  if (hintBtn) {
    hintBtn.disabled = false;
    hintBtn.textContent = "Show Hint";
  }
}

// ── Mode selection ─────────────────────────────────────────
function setupModeSelection() {
  const startScreen = document.getElementById("start-screen");
  const gameScreen = document.getElementById("game-screen");
  const title = document.getElementById("game-title");
  const classicHeader = document.getElementById("classic-header");
  const statsHeader = document.getElementById("stats-header");

  document.querySelectorAll(".mode-btn").forEach((btn) => {
    if (!btn.dataset.mode) return;
    btn.addEventListener("click", async () => {
      currentMode = btn.dataset.mode;
      title.textContent =
        currentMode === "classic" ? "NBADLE – Classic" : "NBADLE – Stats";
      classicHeader.style.display = currentMode === "classic" ? "flex" : "none";
      statsHeader.style.display = currentMode === "stats" ? "flex" : "none";

      resetHintVisuals();
      resetGuessCounter();

      startScreen.style.display = "none";
      gameScreen.style.display = "block";
      document.getElementById("guesses-container").innerHTML = "";

      if (players.length > 0) {
        targetPlayer = players[Math.floor(Math.random() * players.length)];
      }
      targetImages = null;
      await loadTargetImages();
      document.getElementById("player-input").focus();
    });
  });
}

// ── Back button ────────────────────────────────────────────
function setupBackButton() {
  const backBtn = document.getElementById("back-button");
  const startScreen = document.getElementById("start-screen");
  const gameScreen = document.getElementById("game-screen");
  const guesses = document.getElementById("guesses-container");

  backBtn.addEventListener("click", () => {
    guesses.innerHTML = "";
    resetHintVisuals();
    resetGuessCounter();
    gameScreen.style.display = "none";
    startScreen.style.display = "block";
    if (players.length > 0) {
      targetPlayer = players[Math.floor(Math.random() * players.length)];
      targetImages = null;
    }
  });
}

// ── Play again ─────────────────────────────────────────────
function setupPlayAgain() {
  const btn = document.getElementById("play-again-btn");
  const modal = document.getElementById("win-modal");
  const guesses = document.getElementById("guesses-container");

  btn.addEventListener("click", async () => {
    modal.style.display = "none";
    guesses.innerHTML = "";
    resetHintVisuals();
    resetGuessCounter();
    if (players.length > 0) {
      targetPlayer = players[Math.floor(Math.random() * players.length)];
    }
    targetImages = null;
    await loadTargetImages();
    document.getElementById("player-input").focus();
  });
}

// ── Give up ────────────────────────────────────────────────
function setupGiveUp() {
  const btn = document.getElementById("give-up-button");

  btn.addEventListener("click", () => {
    if (!targetPlayer) return;
    gameOver = true;
    showWinModal(true);
  });
}

// ── Starters toggle ────────────────────────────────────────
function setupStarterToggle() {
  const toggle = document.getElementById("starter-toggle");
  toggle.addEventListener("change", async () => {
    startersOnly = toggle.checked;
    document.getElementById("guesses-container").innerHTML = "";
    resetHintVisuals();
    resetGuessCounter();
    await fetchPlayers();
  });
}

// ── Init ───────────────────────────────────────────────────
function init() {
  setupModeSelection();
  setupBackButton();
  setupPlayAgain();
  setupGiveUp();
  setupAutocomplete();
  setupHintButton();
  setupStarterToggle();
  setupHelpButton();
  fetchPlayers();
}

init();
