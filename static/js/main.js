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

// Touch detection — most reliable cross-browser method
const IS_TOUCH = navigator.maxTouchPoints > 0 || "ontouchstart" in window;

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
    const q = startersOnly ? "?starters_only=true" : "";
    const res = await fetch("/api/players" + q);
    if (!res.ok) throw new Error("Server error");
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      players = data;
      targetPlayer = players[Math.floor(Math.random() * players.length)];
      targetImages = null;
      await loadTargetImages();
    }
  } catch (err) {
    console.warn("Backend unavailable. Using fallback.", err);
    players = startersOnly
      ? fallbackPlayers.filter((p) => p.is_starter)
      : [...fallbackPlayers];
    if (players.length > 0)
      targetPlayer = players[Math.floor(Math.random() * players.length)];
  }
  if (targetPlayer && !targetImages) await loadTargetImages();
  loader.style.display = "none";
  document.getElementById("player-input").focus();
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

// ── Comparison helpers ─────────────────────────────────────
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

// ── Guess processing ───────────────────────────────────────
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

// ── Render ─────────────────────────────────────────────────
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
  if (won || guessCount >= MAX_GUESSES) {
    gameOver = true;
    document.getElementById("player-input").disabled = true;
    setTimeout(() => showWinModal(!won), 500);
  }
}

// ── Win modal ──────────────────────────────────────────────
function showWinModal(gaveUp) {
  document.getElementById("win-name").textContent = targetPlayer.name;
  const titleEl = document.getElementById("win-title");
  titleEl.textContent = gaveUp ? "The Player Was" : "You Got It!";
  titleEl.style.color = gaveUp ? "#c0392b" : "#27ae60";

  const imgEl = document.getElementById("headshot-img");
  if (targetImages?.headshot) {
    imgEl.src = targetImages.headshot;
    imgEl.style.display = "block";
  } else imgEl.style.display = "none";

  document.getElementById("win-modal").style.display = "flex";
}

// ── Help modal ─────────────────────────────────────────────
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

// ── Autocomplete ───────────────────────────────────────────
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

// ── Reset helpers ──────────────────────────────────────────
function resetHintVisuals() {
  const sil = document.getElementById("silhouette-img");
  const logo = document.getElementById("team-logo-img");
  const ph = document.getElementById("silhouette-placeholder");
  const btn = document.getElementById("hint-button");
  if (sil) {
    sil.style.display = "none";
    sil.src = "";
  }
  if (logo) {
    logo.style.display = "none";
    logo.src = "";
  }
  if (ph) ph.style.display = "flex";
  if (btn) {
    btn.disabled = false;
    btn.textContent = "Show Hint";
  }
}

// ── OSK helpers ────────────────────────────────────────────
function showOsk() {
  if (!IS_TOUCH) return;
  document.getElementById("onscreen-keyboard").classList.add("osk--visible");
  document.body.classList.add("osk-open");
}

function hideOsk() {
  document.getElementById("onscreen-keyboard").classList.remove("osk--visible");
  document.body.classList.remove("osk-open");
}

// ── Mode selection ─────────────────────────────────────────
function setupModeSelection() {
  const startScreen = document.getElementById("start-screen");
  const gameScreen = document.getElementById("game-screen");
  const title = document.getElementById("game-title");
  const classicHeader = document.getElementById("classic-header");
  const statsHeader = document.getElementById("stats-header");

  document.querySelectorAll(".mode-btn[data-mode]").forEach((btn) => {
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

      if (players.length > 0)
        targetPlayer = players[Math.floor(Math.random() * players.length)];
      targetImages = null;
      await loadTargetImages();
      showOsk();
    });
  });
}

// ── Back button ────────────────────────────────────────────
function setupBackButton() {
  document.getElementById("back-button").addEventListener("click", () => {
    document.getElementById("guesses-container").innerHTML = "";
    resetHintVisuals();
    resetGuessCounter();
    hideOsk();
    document.getElementById("game-screen").style.display = "none";
    document.getElementById("start-screen").style.display = "block";
    if (players.length > 0) {
      targetPlayer = players[Math.floor(Math.random() * players.length)];
      targetImages = null;
    }
  });
}

// ── Play again ─────────────────────────────────────────────
function setupPlayAgain() {
  document
    .getElementById("play-again-btn")
    .addEventListener("click", async () => {
      document.getElementById("win-modal").style.display = "none";
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

// ── Give up ────────────────────────────────────────────────
function setupGiveUp() {
  document.getElementById("give-up-button").addEventListener("click", () => {
    if (!targetPlayer) return;
    gameOver = true;
    showWinModal(true);
  });
}

// ── Starter toggle ─────────────────────────────────────────
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

// ── On-screen keyboard ─────────────────────────────────────
function setupOnscreenKeyboard() {
  if (!IS_TOUCH) return;

  const keyboard = document.getElementById("onscreen-keyboard");
  const input = document.getElementById("player-input");
  const backspace = document.getElementById("osk-backspace");
  const enterBtn = document.getElementById("osk-enter");

  // Allow the native blinking caret, but prevent the native keyboard
  input.removeAttribute("readonly");
  input.setAttribute("inputmode", "none");

  // Show keyboard and focus input to display the caret
  input.addEventListener(
    "touchstart",
    (e) => {
      // No preventDefault() here so the input can actually receive focus natively
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

  // All letter/char keys
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

  // Backspace with hold-to-repeat
  let bsTimer = null,
    bsInterval = null;

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

  // Enter Button
  enterBtn.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      flash(enterBtn);
      if (gameOver) return;

      const val = input.value.trim().toLowerCase();

      // Check for an exact typed match first
      let match = players.find((p) => p.name.toLowerCase() === val);

      // If no exact match, grab the first available suggestion in the autocomplete list
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
  setupOnscreenKeyboard();
  fetchPlayers();
}

init();
