# nba_data.py

import os
import time
import json
from config import (
    CACHE_FILE,
    CACHE_EXPIRATION,
    TEAM_INFO,
    PYTHON_FALLBACK_ROSTER,
    SEASON_FOR_BIO,
    SEASON_FOR_STATS,
)


def load_from_cache():
    if not os.path.exists(CACHE_FILE):
        print("No cache file found.")
        return None
    try:
        with open(CACHE_FILE, "r") as f:
            data = json.load(f)
    except json.JSONDecodeError:
        print("Cache file is corrupted.")
        return None

    if isinstance(data, dict) and "players" in data and "_timestamp" in data:
        print(f"Cache found with {len(data['players'])} players.")
        return data["players"]

    if isinstance(data, list):
        print(f"Cache found (legacy format) with {len(data)} players.")
        return data

    return None


def save_to_cache(players):
    payload = {"_timestamp": time.time(), "players": players}
    with open(CACHE_FILE, "w") as f:
        json.dump(payload, f)


def is_starter(player):
    pts  = player.get('pts', 0)
    reb  = player.get('reb', 0)
    ast  = player.get('ast', 0)
    stl  = player.get('stl', 0)
    blk  = player.get('blk', 0)
    fg3m = player.get('fg3m', 0)

    if pts  >= 12:  return True
    if reb  >= 7:   return True
    if ast  >= 5:   return True
    if stl  >= 1.5: return True
    if blk  >= 1.5: return True
    if fg3m >= 2.5: return True

    impact_score = pts + (reb * 1.2) + (ast * 1.5) + (stl * 3) + (blk * 3) + (fg3m * 2)
    return impact_score >= 18


def fetch_players_from_nba():
    # Always check cache first — avoids loading heavy libraries entirely
    cached = load_from_cache()
    if cached:
        print(f"Using cached players ({len(cached)})")
        return cached

    print("No cache available. Attempting NBA API fetch (loading heavy deps)...")

    # Only import heavy libraries if cache miss — saves memory on Render
    try:
        import random
        import pandas as pd
        from nba_api.stats.endpoints import (
            leaguedashplayerbiostats,
            playerindex,
            leaguedashplayerstats,
        )
    except ImportError as e:
        print(f"Failed to import dependencies: {e}. Using fallback roster.")
        return PYTHON_FALLBACK_ROSTER

    custom_headers = {
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

    try:
        print("Fetching player bio stats from NBA API...")
        df_bio = None
        for i in range(2):
            try:
                bio_stats = leaguedashplayerbiostats.LeagueDashPlayerBioStats(
                    season=SEASON_FOR_BIO,
                    headers=custom_headers,
                    timeout=3,
                )
                df_temp = bio_stats.get_data_frames()[0]
                if not df_temp.empty:
                    df_bio = df_temp
                    break
            except Exception as e:
                print(f"BioStats attempt {i+1} failed: {e}")
            time.sleep(1)

        if df_bio is None or df_bio.empty:
            print("NBA API unavailable. Using fallback roster.")
            return PYTHON_FALLBACK_ROSTER

        print("Fetching player index...")
        df_idx = None
        for i in range(2):
            try:
                time.sleep(0.5)
                idx = playerindex.PlayerIndex(
                    season=SEASON_FOR_BIO,
                    headers=custom_headers,
                    timeout=3,
                )
                df_temp = idx.get_data_frames()[0]
                if not df_temp.empty:
                    df_idx = df_temp
                    break
            except Exception as e:
                print(f"PlayerIndex attempt {i+1} failed: {e}")
            time.sleep(1)

        if df_idx is None or df_idx.empty:
            df_bio["POSITION"] = "G"
            df_bio["JERSEY_NUMBER"] = "0"
            df = df_bio
        else:
            df_idx = df_idx[["PERSON_ID", "POSITION", "JERSEY_NUMBER"]]
            df = pd.merge(
                df_bio,
                df_idx,
                left_on="PLAYER_ID",
                right_on="PERSON_ID",
                how="left",
            )

        df = df[df["TEAM_ABBREVIATION"].isin(TEAM_INFO.keys())].copy()

        print("Fetching season averages...")
        df_stats = None
        for i in range(2):
            try:
                time.sleep(0.5)
                stats_ep = leaguedashplayerstats.LeagueDashPlayerStats(
                    season=SEASON_FOR_STATS,
                    per_mode_detailed="PerGame",
                    measure_type_detailed_defense="Base",
                    headers=custom_headers,
                    timeout=3,
                )
                df_temp = stats_ep.get_data_frames()[0]
                if not df_temp.empty:
                    df_stats = df_temp
                    break
            except Exception as e:
                print(f"Season Stats attempt {i+1} failed: {e}")
            time.sleep(1)

        stat_cols = ["PTS", "REB", "AST", "STL", "BLK", "FG3M"]

        if df_stats is not None and not df_stats.empty:
            df_stats = df_stats[["PLAYER_ID"] + stat_cols]
            df = pd.merge(df, df_stats, on="PLAYER_ID", how="left", suffixes=("", "_STAT"))
            for col in stat_cols:
                stat_col = f"{col}_STAT"
                if stat_col in df.columns:
                    df[col] = df[stat_col].fillna(df.get(col, 0.0))
                    df.drop(columns=[stat_col], inplace=True)

        players = []
        for _, row in df.iterrows():

            def get_safe_int(col, default=0):
                val = row.get(col, default)
                if pd.isna(val) or val == "": return default
                try: return int(float(val))
                except: return default

            def get_safe_str(col, default="Unknown"):
                val = row.get(col, default)
                if pd.isna(val): return default
                return str(val).strip()

            def get_safe_float(col, default=0.0):
                val = row.get(col, default)
                if pd.isna(val) or val == "": return default
                try: return float(val)
                except: return default

            h_inches = get_safe_int("PLAYER_HEIGHT_INCHES", 78)
            feet, inches = h_inches // 12, h_inches % 12
            team_abbr = get_safe_str("TEAM_ABBREVIATION", "Unknown")
            team_data = TEAM_INFO.get(team_abbr, {"conf": "Unknown", "div": "Unknown"})
            pos = get_safe_str("POSITION", "G")
            if not pos or pos == "Unknown": pos = "G"

            pts  = get_safe_float("PTS")
            reb  = get_safe_float("REB")
            ast  = get_safe_float("AST")
            stl  = get_safe_float("STL")
            blk  = get_safe_float("BLK")
            fg3m = get_safe_float("FG3M")

            if pts > 60 or reb > 40 or ast > 40 or stl > 20 or blk > 20 or fg3m > 20:
                pts = reb = ast = stl = blk = fg3m = 0.0

            players.append({
                "id":         get_safe_int("PLAYER_ID"),
                "name":       get_safe_str("PLAYER_NAME"),
                "team":       team_abbr,
                "conf":       team_data["conf"],
                "div":        team_data["div"],
                "pos":        pos,
                "height":     f"{feet}'{inches}\"",
                "age":        get_safe_int("AGE", 25),
                "number":     get_safe_int("JERSEY_NUMBER"),
                "pts":        pts,
                "reb":        reb,
                "ast":        ast,
                "stl":        stl,
                "blk":        blk,
                "fg3m":       fg3m,
                "is_starter": is_starter({"pts": pts, "reb": reb, "ast": ast,
                                          "stl": stl, "blk": blk, "fg3m": fg3m})
            })

        if players:
            save_to_cache(players)
            print(f"Successfully fetched and cached {len(players)} players.")
            return players

        return PYTHON_FALLBACK_ROSTER

    except Exception as e:
        print(f"Critical fetch error: {e}. Using fallback roster.")
        return PYTHON_FALLBACK_ROSTER
