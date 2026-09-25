// public/js/stats.js
// Per-device solo stats, kept separately for each mode. Storage can be missing
// or throw (private browsing, blocked site data), so every access is guarded and
// the game works the same without it.

import { MAX_GUESSES } from "./compare.js";

const KEY = "nbadle_stats_v1";

function empty() {
  return { played: 0, wins: 0, streak: 0, best: 0, dist: Array(MAX_GUESSES).fill(0) };
}

function readAll() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function writeAll(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Not persisted; stats just won't survive a reload
  }
}

function normalize(saved) {
  const s = { ...empty(), ...(saved || {}) };
  const dist = Array.isArray(s.dist) ? s.dist : [];
  s.dist = Array.from({ length: MAX_GUESSES }, (_, i) => Number(dist[i]) || 0);
  return s;
}

export function getStats(mode) {
  return normalize(readAll()[mode]);
}

// `guesses` is only used for wins (1..MAX_GUESSES).
export function recordGame(mode, won, guesses) {
  const all = readAll();
  const s = normalize(all[mode]);
  s.played += 1;
  if (won) {
    s.wins += 1;
    s.streak += 1;
    s.best = Math.max(s.best, s.streak);
    const i = Math.min(Math.max(guesses, 1), MAX_GUESSES) - 1;
    s.dist[i] += 1;
  } else {
    s.streak = 0;
  }
  all[mode] = s;
  writeAll(all);
  return s;
}

export function winRate(s) {
  return s.played ? Math.round((s.wins / s.played) * 100) : 0;
}
