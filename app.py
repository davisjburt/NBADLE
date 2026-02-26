# app.py

from flask import Flask, jsonify, render_template
from config import TEAM_LOGO_IDS, PYTHON_FALLBACK_ROSTER
from nba_data import load_from_cache, fetch_players_from_nba

app = Flask(__name__)
app.config["DEBUG"] = True


@app.route("/")
def index():
    return render_template("index.html", fallback_players=PYTHON_FALLBACK_ROSTER)


@app.route("/favicon.ico")
def favicon():
    return "", 204


@app.route("/api/players")
def get_players():
    cached = load_from_cache()
    if cached:
        print("\nLoaded player data from cache.")
        return jsonify(cached)

    try:
        players = fetch_players_from_nba()
        return jsonify(players)
    except Exception as e:
        print(f"Critical backend error: {e}. Using fallback roster.")
        return jsonify(PYTHON_FALLBACK_ROSTER)


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


if __name__ == "__main__":
    app.run(debug=True, use_reloader=True, port=5001)
