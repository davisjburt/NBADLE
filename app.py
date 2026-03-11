# app.py

from flask import Flask, jsonify, render_template, request
from config import TEAM_LOGO_IDS, PYTHON_FALLBACK_ROSTER, add_starter_status_to_fallback
from nba_data import load_from_cache, fetch_players_from_nba

app = Flask(__name__)
app.config["DEBUG"] = True

# Initialize starter status for fallback roster
add_starter_status_to_fallback()


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
    
    # Filter by starters if requested
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


if __name__ == "__main__":
    app.run(port=5001)
