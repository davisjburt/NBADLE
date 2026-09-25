// src/index.js
// Static files in public/ are served by Workers Static Assets; only /api/* runs here.

import { canBeTarget, teamLogoUrl } from "../public/js/compare.js";

export { VsRoom } from "./vs-room.js";

const PIN_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous O/0/I/1
const PIN_RE = /^[A-HJ-NP-Z2-9]{6}$/;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const fromRoom = ({ status, body }) => json(body, status);

function generatePin() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => PIN_CHARS[b % PIN_CHARS.length]).join("");
}

// players.json is a static asset; cache the parsed list per isolate.
let playersPromise = null;
function loadPlayers(env, url) {
  if (!playersPromise) {
    playersPromise = env.ASSETS.fetch(new URL("/players.json", url))
      .then((r) => {
        if (!r.ok) throw new Error(`players.json: ${r.status}`);
        return r.json();
      })
      .catch((e) => {
        playersPromise = null;
        throw e;
      });
  }
  return playersPromise;
}

async function pickTarget(env, url, startersOnly, mode) {
  const players = (await loadPlayers(env, url)).filter((p) => canBeTarget(p, mode));
  const starters = startersOnly ? players.filter((p) => p.is_starter) : [];
  const pool = starters.length ? starters : players;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function proxyHeadshot(playerId) {
  const upstream = await fetch(
    `https://cdn.nba.com/headshots/nba/latest/260x190/${playerId}.png`,
    { cf: { cacheTtl: 86400, cacheEverything: true } },
  );
  if (!upstream.ok) return new Response("Not found", { status: 404 });
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

async function readBody(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

function roomStub(env, pin) {
  return env.VS_ROOM.get(env.VS_ROOM.idFromName(pin));
}

async function handleVs(request, env, url, parts) {
  const [action, pathPin] = parts;

  if (action === "create" && request.method === "POST") {
    const body = await readBody(request);
    const target = await pickTarget(env, url, !!body.starters_only, body.mode);
    for (let i = 0; i < 5; i++) {
      const pin = generatePin();
      const state = await roomStub(env, pin).create({
        pin,
        mode: body.mode,
        startersOnly: body.starters_only,
        hostId: String(body.player_id || ""),
        target,
      });
      if (state) return json({ ...state, role: "host" });
    }
    return json({ error: "Could not allocate a room" }, 503);
  }

  // Every other VS route addresses an existing room by PIN
  const isGet = request.method === "GET";
  const body = isGet ? {} : await readBody(request);
  const pin = String((isGet ? pathPin : body.pin) || "").trim().toUpperCase();
  const playerId = String(
    (isGet ? url.searchParams.get("player_id") : body.player_id) || "",
  );
  if (!PIN_RE.test(pin)) return json({ error: "Room not found" }, 404);
  const room = roomStub(env, pin);

  if (isGet && action === "status") return fromRoom(await room.status());

  if (isGet && action === "headshot") {
    const res = await room.hintTarget(playerId);
    if (res.status !== 200) return fromRoom(res);
    return proxyHeadshot(res.body.id);
  }

  if (request.method !== "POST") return json({ error: "Not found" }, 404);

  switch (action) {
    case "join":
      return fromRoom(await room.join(playerId));

    case "guess": {
      const players = await loadPlayers(env, url);
      const guess = players.find((p) => p.id === Number(body.guess_id));
      if (!guess) return json({ error: "Unknown player" }, 400);
      return fromRoom(await room.guess(playerId, guess));
    }

    case "hint": {
      const res = await room.hintTarget(playerId);
      if (res.status !== 200) return fromRoom(res);
      return res.body.mode === "stats"
        ? json({ logo: teamLogoUrl(res.body.team) })
        : json({
            headshot: `/api/vs/headshot/${pin}?player_id=${encodeURIComponent(playerId)}`,
          });
    }

    case "rematch": {
      const status = await room.status();
      if (status.status !== 200) return fromRoom(status);
      const target = await pickTarget(env, url, status.body.starters_only, status.body.mode);
      return fromRoom(await room.rematch(playerId, target));
    }

    case "forfeit":
      return fromRoom(await room.forfeit(playerId));
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

    try {
      if (parts[1] === "headshot" && request.method === "GET") {
        return /^\d+$/.test(parts[2] || "")
          ? proxyHeadshot(parts[2])
          : json({ error: "Bad player id" }, 400);
      }
      if (parts[1] === "vs") return await handleVs(request, env, url, parts.slice(2));
    } catch (e) {
      console.error("API error", e);
      return json({ error: "Server error" }, 500);
    }

    return json({ error: "Not found" }, 404);
  },
};
