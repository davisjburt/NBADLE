#!/usr/bin/env python3
# Rebuilds public/players.json.
# Run from anywhere: python scripts/refresh_players.py
#
# Rosters and bio (team, jersey, position, height) come from www.nba.com/players and
# ages from player pages; both embed their data as JSON. Per-game averages come from
# stats.nba.com when it responds; it often blocks cloud and residential IPs, so
# otherwise each player keeps the averages already in players.json (matched by id).
# Exits 1 without touching the file if the roster data looks incomplete.

import json
import os
import re
import sys
import time
from datetime import date

import requests

OUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "players.json")
MIN_PLAYERS = 400
STAT_KEYS = ["pts", "reb", "ast", "stl", "blk", "fg3m"]

TEAM_INFO = {
    "BOS": ("East", "Atlantic"), "BKN": ("East", "Atlantic"), "NYK": ("East", "Atlantic"),
    "PHI": ("East", "Atlantic"), "TOR": ("East", "Atlantic"),
    "CHI": ("East", "Central"), "CLE": ("East", "Central"), "DET": ("East", "Central"),
    "IND": ("East", "Central"), "MIL": ("East", "Central"),
    "ATL": ("East", "Southeast"), "CHA": ("East", "Southeast"), "MIA": ("East", "Southeast"),
    "ORL": ("East", "Southeast"), "WAS": ("East", "Southeast"),
    "DEN": ("West", "NW"), "MIN": ("West", "NW"), "OKC": ("West", "NW"),
    "POR": ("West", "NW"), "UTA": ("West", "NW"),
    "GSW": ("West", "Pacific"), "LAC": ("West", "Pacific"), "LAL": ("West", "Pacific"),
    "PHX": ("West", "Pacific"), "SAC": ("West", "Pacific"),
    "DAL": ("West", "SW"), "HOU": ("West", "SW"), "MEM": ("West", "SW"),
    "NOP": ("West", "SW"), "SAS": ("West", "SW"),
}

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
)
STATS_HEADERS = {
    "Host": "stats.nba.com",
    "Accept": "application/json, text/plain, */*",
    "x-nba-stats-token": "true",
    "x-nba-stats-origin": "stats",
    "User-Agent": USER_AGENT,
    "Referer": "https://www.nba.com/",
    "Origin": "https://www.nba.com",
    "Accept-Language": "en-US,en;q=0.9",
}
NEXT_DATA_RE = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)

session = requests.Session()
session.headers["User-Agent"] = USER_AGENT


# ── www.nba.com rosters ───────────────────────────────────────────────────────

def page_props(path, attempts=3):
    url = f"https://www.nba.com/{path}"
    for i in range(attempts):
        try:
            res = session.get(url, timeout=30)
            res.raise_for_status()
            match = NEXT_DATA_RE.search(res.text)
            if not match:
                raise ValueError("no __NEXT_DATA__ on page")
            return json.loads(match.group(1))["props"]["pageProps"]
        except Exception as e:
            print(f"  {url} attempt {i + 1} failed: {e}")
            time.sleep(2 * (i + 1))
    return None


def to_int(val):
    try:
        return int(str(val).strip())
    except (TypeError, ValueError):
        return None


def format_height(h):
    # "6-8" -> 6'8"
    feet, _, inches = str(h or "").partition("-")
    if not feet.isdigit() or not inches.isdigit():
        return None
    return f"{feet}'{inches}\""


def age_from_birthdate(iso, today=None):
    # "1999-09-19T00:00:00" -> age in whole years
    try:
        born = date.fromisoformat(str(iso)[:10])
    except ValueError:
        return None
    today = today or date.today()
    return today.year - born.year - ((today.month, today.day) < (born.month, born.day))


def fetch_ages(listing):
    # Each player page embeds that player's full current team roster with ages,
    # so one page per team covers nearly everyone.
    ages = {}
    by_team = {}
    for p in listing:
        by_team.setdefault(p["TEAM_ABBREVIATION"], []).append(p["PERSON_ID"])

    for abbr, ids in sorted(by_team.items()):
        props = page_props(f"player/{ids[0]}")
        roster = ((props or {}).get("player") or {}).get("roster") or []
        for r in roster:
            if r.get("PLAYER_ID") is not None:
                ages[r["PLAYER_ID"]] = to_int(r.get("AGE"))
        print(f"  {abbr}: ages for {sum(1 for i in ids if i in ages)}/{len(ids)} players")
        time.sleep(0.3)

    # Anyone not on their team's roster block yet (e.g. just signed): use their own page
    for p in listing:
        pid = p["PERSON_ID"]
        if ages.get(pid) is None:
            info = ((page_props(f"player/{pid}") or {}).get("player") or {}).get("info") or {}
            ages[pid] = age_from_birthdate(info.get("BIRTHDATE"))
            time.sleep(0.3)
    return ages


def fetch_rosters():
    props = page_props("players")
    listing = [
        p for p in (props or {}).get("players", [])
        if p.get("ROSTER_STATUS") == 1 and p.get("TEAM_ABBREVIATION") in TEAM_INFO
    ]
    teams = {p["TEAM_ABBREVIATION"] for p in listing}
    if len(teams) < len(TEAM_INFO):
        print(f"  Player listing covers only {len(teams)} teams")
        return None
    print(f"  {len(listing)} rostered players across {len(teams)} teams")

    ages = fetch_ages(listing)
    players = []
    for p in listing:
        abbr = p["TEAM_ABBREVIATION"]
        conf, div = TEAM_INFO[abbr]
        players.append({
            "id": p["PERSON_ID"],
            "name": f"{p['PLAYER_FIRST_NAME']} {p['PLAYER_LAST_NAME']}".strip(),
            "team": abbr,
            "conf": conf,
            "div": div,
            "pos": p.get("POSITION") or "G",
            "height": format_height(p.get("HEIGHT")),
            "age": ages.get(p["PERSON_ID"]),
            # Unknown jersey stays null rather than pretending to be #0
            "number": to_int(p.get("JERSEY_NUMBER")),
        })
    return players


# ── Season averages ──────────────────────────────────────────────────────────

def season_string(start_year):
    return f"{start_year}-{str(start_year + 1)[-2:]}"


def candidate_seasons(today=None):
    # A season starts in October; before then the latest season is last year's.
    today = today or date.today()
    start = today.year if today.month >= 10 else today.year - 1
    return [season_string(start), season_string(start - 1)]


def fetch_live_stats():
    for season in candidate_seasons():
        try:
            res = session.get(
                "https://stats.nba.com/stats/leaguedashplayerstats",
                headers=STATS_HEADERS,
                timeout=20,
                params={
                    "Season": season, "SeasonType": "Regular Season",
                    "PerMode": "PerGame", "MeasureType": "Base", "LeagueID": "00",
                    "LastNGames": 0, "Month": 0, "OpponentTeamID": 0,
                    "PaceAdjust": "N", "Period": 0, "PlusMinus": "N", "Rank": "N",
                },
            )
            res.raise_for_status()
            result = res.json()["resultSets"][0]
            cols = result["headers"]
            rows = [dict(zip(cols, row)) for row in result["rowSet"]]
            if rows:
                print(f"  Got {season} averages for {len(rows)} players from stats.nba.com")
                return {
                    r["PLAYER_ID"]: {k: float(r[k.upper()] or 0) for k in STAT_KEYS}
                    for r in rows
                }
            print(f"  stats.nba.com returned no rows for {season}")
        except Exception as e:
            print(f"  stats.nba.com unavailable for {season}: {e}")
    return None


def previous_stats():
    try:
        with open(OUT_FILE) as f:
            return {p["id"]: {k: p.get(k, 0.0) for k in STAT_KEYS} for p in json.load(f)}
    except (OSError, ValueError):
        return {}


def is_starter(s):
    if (s["pts"] >= 12 or s["reb"] >= 7 or s["ast"] >= 5
            or s["stl"] >= 1.5 or s["blk"] >= 1.5 or s["fg3m"] >= 2.5):
        return True
    impact = s["pts"] + s["reb"] * 1.2 + s["ast"] * 1.5 + s["stl"] * 3 + s["blk"] * 3 + s["fg3m"] * 2
    return impact >= 18


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    print("Fetching rosters from www.nba.com...")
    players = fetch_rosters()
    if not players or len(players) < MIN_PLAYERS:
        print("Roster data incomplete; keeping the existing players.json.")
        sys.exit(1)

    print("Fetching season averages...")
    stats = fetch_live_stats()
    source = "stats.nba.com"
    if stats is None:
        stats = previous_stats()
        source = "previous players.json"
        print("  Falling back to the averages already in players.json")

    zero = {k: 0.0 for k in STAT_KEYS}
    for p in players:
        s = stats.get(p["id"], zero)
        p.update({k: round(float(s[k]), 1) for k in STAT_KEYS})
        # A player with no recorded averages at all (a new draftee, most often)
        # would never clear the stat-based bar below and would quietly vanish
        # from Starters Only. Count them as a starter until real numbers come in.
        p["is_starter"] = True if not any(p[k] for k in STAT_KEYS) else is_starter(p)
    no_stats = sum(1 for p in players if not any(p[k] for k in STAT_KEYS))

    players.sort(key=lambda p: p["name"])
    with open(OUT_FILE, "w") as f:
        json.dump(players, f, separators=(",", ":"), ensure_ascii=False)
        f.write("\n")

    print(
        f"Wrote {len(players)} players to {os.path.normpath(OUT_FILE)}\n"
        f"  averages from {source}; {no_stats} players without averages (e.g. rookies)\n"
        f"  {sum(p['is_starter'] for p in players)} starters, "
        f"{sum(p['number'] is None for p in players)} without a jersey number"
    )


if __name__ == "__main__":
    main()
