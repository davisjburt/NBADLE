#!/usr/bin/env python3
# Rebuilds public/players.json from the NBA stats API.
# Run from the repo root: python scripts/refresh_players.py
# Leaves the existing file untouched (exit code 1) if the API returns no usable data.

import json
import os
import sys
import time
from datetime import date

import pandas as pd
from nba_api.stats.endpoints import (
    leaguedashplayerbiostats,
    leaguedashplayerstats,
    playerindex,
)

OUT_FILE = os.path.join(os.path.dirname(__file__), "..", "public", "players.json")
MIN_PLAYERS = 100

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

HEADERS = {
    "Host": "stats.nba.com",
    "Connection": "keep-alive",
    "Accept": "application/json, text/plain, */*",
    "x-nba-stats-token": "true",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/133.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.nba.com/stats/players/bio",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.nba.com",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
}


def season_string(start_year):
    return f"{start_year}-{str(start_year + 1)[-2:]}"


def candidate_seasons(today=None):
    # A season starts in October; before then the latest season is last year's.
    today = today or date.today()
    start = today.year if today.month >= 10 else today.year - 1
    return [season_string(start), season_string(start - 1)]


def is_starter(pts, reb, ast, stl, blk, fg3m):
    if pts >= 12 or reb >= 7 or ast >= 5 or stl >= 1.5 or blk >= 1.5 or fg3m >= 2.5:
        return True
    impact = pts + reb * 1.2 + ast * 1.5 + stl * 3 + blk * 3 + fg3m * 2
    return impact >= 18


def fetch_frame(label, make_endpoint, attempts=3):
    for i in range(attempts):
        try:
            df = make_endpoint().get_data_frames()[0]
            if not df.empty:
                return df
            print(f"  {label}: empty response")
            return None
        except Exception as e:
            print(f"  {label} attempt {i + 1} failed: {e}")
            time.sleep(2 * (i + 1))
    return None


def fetch_season(season):
    print(f"Fetching season {season}...")
    df_bio = fetch_frame("BioStats", lambda: leaguedashplayerbiostats.LeagueDashPlayerBioStats(
        season=season, headers=HEADERS, timeout=30))
    if df_bio is None:
        return None

    df_idx = fetch_frame("PlayerIndex", lambda: playerindex.PlayerIndex(
        season=season, headers=HEADERS, timeout=30))
    if df_idx is not None:
        df_idx = df_idx[["PERSON_ID", "POSITION", "JERSEY_NUMBER"]]
        df = pd.merge(df_bio, df_idx, left_on="PLAYER_ID", right_on="PERSON_ID", how="left")
    else:
        df = df_bio.assign(POSITION=None, JERSEY_NUMBER=None)

    df = df[df["TEAM_ABBREVIATION"].isin(TEAM_INFO.keys())].copy()

    stat_cols = ["PTS", "REB", "AST", "STL", "BLK", "FG3M"]
    df_stats = fetch_frame("SeasonStats", lambda: leaguedashplayerstats.LeagueDashPlayerStats(
        season=season, per_mode_detailed="PerGame",
        measure_type_detailed_defense="Base", headers=HEADERS, timeout=30))
    if df_stats is not None:
        df = pd.merge(df, df_stats[["PLAYER_ID"] + stat_cols], on="PLAYER_ID",
                      how="left", suffixes=("", "_STAT"))
        for col in stat_cols:
            if f"{col}_STAT" in df.columns:
                df[col] = df[f"{col}_STAT"].fillna(df.get(col, 0.0))
                df.drop(columns=[f"{col}_STAT"], inplace=True)

    players = []
    for _, row in df.iterrows():
        def num(col, default=None, cast=float):
            val = row.get(col)
            if val is None or pd.isna(val) or str(val).strip() == "":
                return default
            try:
                return cast(float(val))
            except (TypeError, ValueError):
                return default

        stats = {c.lower(): num(c, 0.0) for c in stat_cols}
        if stats["pts"] > 60 or any(stats[k] > 40 for k in ("reb", "ast")) \
                or any(stats[k] > 20 for k in ("stl", "blk", "fg3m")):
            stats = {k: 0.0 for k in stats}

        inches = num("PLAYER_HEIGHT_INCHES", 78, int)
        team = str(row["TEAM_ABBREVIATION"]).strip()
        conf, div = TEAM_INFO[team]
        pos = row.get("POSITION")
        pos = str(pos).strip() if isinstance(pos, str) and pos.strip() else "G"

        players.append({
            "id": num("PLAYER_ID", 0, int),
            "name": str(row["PLAYER_NAME"]).strip(),
            "team": team,
            "conf": conf,
            "div": div,
            "pos": pos,
            "height": f"{inches // 12}'{inches % 12}\"",
            "age": num("AGE", None, int),
            # Unknown jersey stays null rather than pretending to be #0
            "number": num("JERSEY_NUMBER", None, int),
            **stats,
            "is_starter": is_starter(stats["pts"], stats["reb"], stats["ast"],
                                     stats["stl"], stats["blk"], stats["fg3m"]),
        })
    return players


def main():
    for season in candidate_seasons():
        players = fetch_season(season)
        if players and len(players) >= MIN_PLAYERS:
            break
        print(f"  Season {season} gave no usable data.")
    else:
        print("NBA API returned no usable data; keeping the existing players.json.")
        sys.exit(1)

    players.sort(key=lambda p: p["name"])
    with open(OUT_FILE, "w") as f:
        json.dump(players, f, separators=(",", ":"))
        f.write("\n")

    print(f"Wrote {len(players)} players ({sum(p['is_starter'] for p in players)} starters, "
          f"{sum(p['number'] is None for p in players)} without a jersey number) to {OUT_FILE}")


if __name__ == "__main__":
    main()
