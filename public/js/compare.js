// public/js/compare.js
// Guess-vs-target comparison. Shared by the browser (solo) and the Worker (versus).

export const MAX_GUESSES = 8;

export const TEAM_LOGO_IDS = {
  ATL: 1610612737, BOS: 1610612738, BKN: 1610612751, CHA: 1610612766,
  CHI: 1610612741, CLE: 1610612739, DAL: 1610612742, DEN: 1610612743,
  DET: 1610612765, GSW: 1610612744, HOU: 1610612745, IND: 1610612754,
  LAC: 1610612746, LAL: 1610612747, MEM: 1610612763, MIA: 1610612748,
  MIL: 1610612749, MIN: 1610612750, NOP: 1610612740, NYK: 1610612752,
  OKC: 1610612760, ORL: 1610612753, PHI: 1610612755, PHX: 1610612756,
  POR: 1610612757, SAC: 1610612758, SAS: 1610612759, TOR: 1610612761,
  UTA: 1610612762, WAS: 1610612764,
};

export function teamLogoUrl(team) {
  const id = TEAM_LOGO_IDS[String(team || "").toUpperCase()];
  return id ? `https://cdn.nba.com/logos/nba/${id}/global/L/logo.svg` : "";
}

export function parseHeight(h) {
  if (!h) return 0;
  const p = h.split("'");
  return p.length < 2
    ? 0
    : parseInt(p[0]) * 12 + parseInt(p[1].replace('"', ""));
}

export function checkMatch(g, t) {
  return g === t ? "match" : "nomatch";
}

export function checkPos(gp, tp) {
  if (gp === tp) return "match";
  if (gp.includes(tp) || tp.includes(gp)) return "partial";
  return "nomatch";
}

// Missing values (null/undefined, e.g. an unknown jersey number) never match
// and get no arrow, so the board doesn't give misleading hints.
export function checkNum(g, t, thresh) {
  if (g == null || t == null) return { status: "nomatch", arrow: "" };
  const gv = Number(g),
    tv = Number(t);
  if (!isFinite(gv) || !isFinite(tv)) return { status: "nomatch", arrow: "" };
  const diff = Math.abs(gv - tv);
  const status = gv === tv ? "match" : diff <= thresh ? "partial" : "nomatch";
  const arrow = gv < tv ? " ▲" : gv > tv ? " ▼" : "";
  return { status, arrow };
}

function statCell(g, t, thresh) {
  const gv = Number(g ?? 0),
    tv = Number(t ?? 0);
  return {
    val: isFinite(gv) ? gv.toFixed(1) : "0.0",
    ...checkNum(gv, tv, thresh),
  };
}

export const COLUMNS = {
  classic: ["name", "team", "conf", "div", "pos", "height", "age", "number"],
  stats: ["name", "team", "pts", "reb", "ast", "stl", "blk", "fg3m"],
};

// Returns { name, correct, cells: { col: { val, status, arrow } } }
export function compareGuess(guess, target, mode) {
  const team = { val: guess.team, status: checkMatch(guess.team, target.team) };
  let cells;

  if (mode === "stats") {
    cells = {
      team,
      pts: statCell(guess.pts, target.pts, 1.0),
      reb: statCell(guess.reb, target.reb, 1.0),
      ast: statCell(guess.ast, target.ast, 1.0),
      stl: statCell(guess.stl, target.stl, 0.5),
      blk: statCell(guess.blk, target.blk, 0.5),
      fg3m: statCell(guess.fg3m, target.fg3m, 0.5),
    };
  } else {
    cells = {
      team,
      conf: { val: guess.conf, status: checkMatch(guess.conf, target.conf) },
      div: { val: guess.div, status: checkMatch(guess.div, target.div) },
      pos: { val: guess.pos, status: checkPos(guess.pos, target.pos) },
      height: {
        val: guess.height,
        ...checkNum(parseHeight(guess.height), parseHeight(target.height), 2),
      },
      age: { val: guess.age, ...checkNum(guess.age, target.age, 2) },
      number: {
        val: guess.number ?? "—",
        ...checkNum(guess.number, target.number, 2),
      },
    };
  }

  return { name: guess.name, correct: guess.id === target.id, cells };
}
