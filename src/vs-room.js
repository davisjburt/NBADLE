// src/vs-room.js
// One Durable Object per Versus room. The target player lives only here and is
// never sent to clients until the round has a winner.

import { DurableObject } from "cloudflare:workers";
import { compareGuess } from "../public/js/compare.js";

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;

const ok = (body) => ({ status: 200, body });
const err = (status, error) => ({ status, body: { error } });

export class VsRoom extends DurableObject {
  async #load() {
    return (await this.ctx.storage.get("room")) || null;
  }

  async #save(room) {
    await this.ctx.storage.put("room", room);
  }

  #roleOf(room, playerId) {
    if (!playerId) return null;
    if (playerId === room.host_id) return "host";
    if (playerId === room.challenger_id) return "challenger";
    return null;
  }

  // Everything a client may see. The target is only revealed once someone has won.
  #publicState(room) {
    return {
      pin: room.pin,
      mode: room.mode,
      starters_only: room.starters_only,
      started: room.started,
      round: room.round,
      winner: room.winner,
      forfeited_by: room.forfeited_by,
      host_guess_count: room.host_guess_count,
      challenger_guess_count: room.challenger_guess_count,
      target_player: room.winner ? room.target : null,
    };
  }

  // Returns null if a room already exists under this PIN, so the caller can retry.
  async create({ pin, mode, startersOnly, hostId, target }) {
    if (await this.#load()) return null;
    const room = {
      pin,
      mode: mode === "stats" ? "stats" : "classic",
      starters_only: !!startersOnly,
      target,
      host_id: hostId,
      challenger_id: null,
      host_guess_count: 0,
      challenger_guess_count: 0,
      winner: null,
      forfeited_by: null,
      started: false,
      round: 1,
    };
    await this.#save(room);
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    return this.#publicState(room);
  }

  async join(playerId) {
    const room = await this.#load();
    if (!room) return err(404, "Room not found");
    if (!playerId) return err(400, "Missing player id");

    let role = this.#roleOf(room, playerId);
    if (!role) {
      // Block a third player once a different challenger has taken the slot
      if (room.challenger_id) return err(409, "Room is full");
      room.challenger_id = playerId;
      room.started = true;
      role = "challenger";
      await this.#save(room);
    }
    return ok({ ...this.#publicState(room), role });
  }

  async status() {
    const room = await this.#load();
    if (!room) return err(404, "Room not found");
    return ok(this.#publicState(room));
  }

  async guess(playerId, guessPlayer) {
    const room = await this.#load();
    if (!room) return err(404, "Room not found");
    const role = this.#roleOf(room, playerId);
    if (!role) return err(403, "Not in this room");
    if (!room.started) return err(409, "Game has not started");

    const row = compareGuess(guessPlayer, room.target, room.mode);
    // Guesses made after the round is decided are still scored, but don't count
    if (!room.winner) {
      room[`${role}_guess_count`] += 1;
      if (row.correct) room.winner = role;
      await this.#save(room);
    }
    return ok({ row, ...this.#publicState(room) });
  }

  async hintTarget(playerId) {
    const room = await this.#load();
    if (!room) return err(404, "Room not found");
    if (!this.#roleOf(room, playerId)) return err(403, "Not in this room");
    return ok({ id: room.target.id, team: room.target.team, mode: room.mode });
  }

  async rematch(playerId, target) {
    const room = await this.#load();
    if (!room) return err(404, "Room not found");
    if (playerId !== room.host_id) return err(403, "Only the host can start a rematch");

    Object.assign(room, {
      target,
      host_guess_count: 0,
      challenger_guess_count: 0,
      winner: null,
      forfeited_by: null,
      round: room.round + 1,
    });
    await this.#save(room);
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    return ok(this.#publicState(room));
  }

  async forfeit(playerId) {
    const room = await this.#load();
    if (!room) return err(404, "Room not found");
    const role = this.#roleOf(room, playerId);
    if (!role) return err(403, "Not in this room");

    if (!room.winner) {
      room.winner = role === "host" ? "challenger" : "host";
      room.forfeited_by = role;
      await this.#save(room);
    }
    return ok(this.#publicState(room));
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
