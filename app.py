# app.py

import random
import string
import time

from flask import Flask, jsonify, render_template, request
from config import TEAM_LOGO_IDS, PYTHON_FALLBACK_ROSTER, add_starter_status_to_fallback
from nba_data import load_from_cache, fetch_players_from_nba

app = Flask(__name__)
app.config["DEBUG"] = True

# Initialize starter status for fallback roster
add_starter_status_to_fallback()

# ── VS room state ──────────────────────────────────────────────
vs_rooms = {}

_PIN_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no ambiguous O/0/I/1


def _generate_pin():
    return "".join(random.choices(_PIN_CHARS, k=6))


def _pick_random_player(starters_only=False):
    players = load_from_cache() or PYTHON_FALLBACK_ROSTER
    if starters_only:
        starters = [p for p in players if p.get("is_starter", False)]
        players = starters if starters else players
    return random.choice(players)


def _cleanup_old_rooms():
    now = time.time()
    expired = [pin for pin, room in list(vs_rooms.items()) if now - room["created_at"] > 7200]
    for pin in expired:
        del vs_rooms[pin]


# ── Solo routes ────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html", fallback_players=PYTHON_FALLBACK_ROSTER)


@app.route("/favicon.ico")
def favicon():
    return "", 204


@app.route("/api/players")
def get_players():
    starters_only = request.args.get('starters_only', 'false').lower() == 'true'

    cached = load_from_cache()
    if cached:
        print("\nLoaded player data from cache.")
        players = cached
    else:
        try:
            players = fetch_players_from_nba()
        except Exception as e:
            print(f"Critical backend error: {e}. Using fallback roster.")
            players = PYTHON_FALLBACK_ROSTER

    if starters_only:
        players = [p for p in players if p.get('is_starter', False)]
        print(f"Filtered to {len(players)} starters.")

    return jsonify(players)


@app.route("/api/player_image/<player_id>")
def player_image(player_id):
    try:
        int(player_id)
        headshot_url = f"https://cdn.nba.com/headshots/nba/latest/260x190/{player_id}.png"
    except Exception:
        headshot_url = ""
    return jsonify({"headshot": headshot_url})


@app.route("/api/team_logo/<team_abbr>")
def team_logo(team_abbr):
    team_abbr = team_abbr.upper()
    team_id = TEAM_LOGO_IDS.get(team_abbr)
    if not team_id:
        return jsonify({"logo": ""})
    logo_url = f"https://cdn.nba.com/logos/nba/{team_id}/global/L/logo.svg"
    return jsonify({"logo": logo_url})


# ── VS routes ──────────────────────────────────────────────────

@app.route("/api/vs/create", methods=["POST"])
def vs_create():
    data = request.get_json() or {}
    mode = data.get("mode", "classic")
    starters_only = bool(data.get("starters_only", False))
    host_id = data.get("player_id", "")

    _cleanup_old_rooms()

    pin = _generate_pin()
    while pin in vs_rooms:
        pin = _generate_pin()

    target = _pick_random_player(starters_only)

    vs_rooms[pin] = {
        "pin": pin,
        "mode": mode,
        "starters_only": starters_only,
        "target_player": target,
        "host_id": host_id,
        "host_guess_count": 0,
        "host_won": False,
        "challenger_id": None,
        "challenger_guess_count": 0,
        "challenger_won": False,
        "winner": None,
        "started": False,
        "round": 1,
        "created_at": time.time(),
    }

    return jsonify({"pin": pin, "mode": mode, "starters_only": starters_only, "target_player": target})


@app.route("/api/vs/join", methods=["POST"])
def vs_join():
    data = request.get_json() or {}
    pin = data.get("pin", "").upper().strip()
    player_id = data.get("player_id", "")

    if pin not in vs_rooms:
        return jsonify({"error": "Room not found"}), 404

    room = vs_rooms[pin]

    # Host reconnecting — let them back in without touching challenger slot
    if player_id == room["host_id"]:
        return jsonify({
            "pin": pin,
            "role": "host",
            "mode": room["mode"],
            "starters_only": room["starters_only"],
            "target_player": room["target_player"],
            "your_guess_count": room["host_guess_count"],
            "opponent_guess_count": room["challenger_guess_count"],
            "winner": room["winner"],
            "started": room["started"],
        })

    # Block a third player — room already has a different challenger
    if room["challenger_id"] and room["challenger_id"] != player_id:
        return jsonify({"error": "Room is full"}), 409

    # New challenger or same challenger rejoining
    room["challenger_id"] = player_id
    room["started"] = True

    return jsonify({
        "pin": pin,
        "role": "challenger",
        "mode": room["mode"],
        "starters_only": room["starters_only"],
        "target_player": room["target_player"],
        "your_guess_count": room["challenger_guess_count"],
        "opponent_guess_count": room["host_guess_count"],
        "winner": room["winner"],
        "started": True,
    })


@app.route("/api/vs/guess", methods=["POST"])
def vs_guess():
    data = request.get_json() or {}
    pin = data.get("pin", "").upper()
    player_id = data.get("player_id", "")
    correct = bool(data.get("correct", False))

    if pin not in vs_rooms:
        return jsonify({"error": "Room not found"}), 404

    room = vs_rooms[pin]

    if player_id == room["host_id"]:
        room["host_guess_count"] += 1
        if correct and not room["winner"]:
            room["host_won"] = True
            room["winner"] = "host"
    elif player_id == room["challenger_id"]:
        room["challenger_guess_count"] += 1
        if correct and not room["winner"]:
            room["challenger_won"] = True
            room["winner"] = "challenger"
    else:
        return jsonify({"error": "Not in this room"}), 403

    return jsonify({
        "winner": room["winner"],
        "host_guess_count": room["host_guess_count"],
        "challenger_guess_count": room["challenger_guess_count"],
        "target_player": room["target_player"] if room["winner"] else None,
    })


@app.route("/api/vs/status/<pin>")
def vs_status(pin):
    pin = pin.upper()
    if pin not in vs_rooms:
        return jsonify({"error": "Room not found"}), 404

    room = vs_rooms[pin]
    return jsonify({
        "started": room["started"],
        "winner": room["winner"],
        "host_guess_count": room["host_guess_count"],
        "challenger_guess_count": room["challenger_guess_count"],
        "target_player": room["target_player"],
        "mode": room["mode"],
        "round": room.get("round", 1),
    })


@app.route("/api/vs/rematch", methods=["POST"])
def vs_rematch():
    data = request.get_json() or {}
    pin = data.get("pin", "").upper()
    player_id = data.get("player_id", "")

    if pin not in vs_rooms:
        return jsonify({"error": "Room not found"}), 404

    room = vs_rooms[pin]

    if player_id != room["host_id"]:
        return jsonify({"error": "Only the host can start a rematch"}), 403

    new_target = _pick_random_player(room["starters_only"])

    room["target_player"] = new_target
    room["host_guess_count"] = 0
    room["host_won"] = False
    room["challenger_guess_count"] = 0
    room["challenger_won"] = False
    room["winner"] = None
    room["round"] = room.get("round", 1) + 1

    return jsonify({
        "target_player": new_target,
        "mode": room["mode"],
        "round": room["round"],
    })


@app.route("/api/vs/forfeit", methods=["POST"])
def vs_forfeit():
    data = request.get_json() or {}
    pin = data.get("pin", "").upper()
    player_id = data.get("player_id", "")

    if pin not in vs_rooms:
        return jsonify({"error": "Room not found"}), 404

    room = vs_rooms[pin]
    if room["winner"]:
        return jsonify({"winner": room["winner"]})

    if player_id == room["host_id"]:
        room["winner"] = "challenger"
    elif player_id == room["challenger_id"]:
        room["winner"] = "host"
    else:
        return jsonify({"error": "Not in this room"}), 403

    return jsonify({"winner": room["winner"]})


if __name__ == "__main__":
    app.run(port=5001)
