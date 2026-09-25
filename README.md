# NBADLE

Guess the NBA player. Runs on Cloudflare Workers.

- `public/`: the static site (HTML, CSS, JS) plus `players.json`, served by Workers Static Assets
- `src/index.js`: the `/api/*` routes (headshot proxy, Versus endpoints)
- `src/vs-room.js`: the `VsRoom` Durable Object, one per Versus PIN. It holds the target player, scores guesses server-side, and pushes every state change to both players over a WebSocket (`/api/vs/ws/:pin`). Clients fall back to polling while reconnecting. Rooms expire after 2 hours.
- `public/js/compare.js`: guess-comparison logic, shared by the browser (solo) and the Worker (Versus)

## Develop

```bash
npm install
npm run dev        # http://localhost:8787
```

## Deploy

```bash
npx wrangler login
npm run deploy
```

To redeploy automatically on every push, connect the repo to the Worker in the Cloudflare dashboard (Workers Builds). The data refresh below relies on this.

## Player data

`public/players.json` comes from `scripts/refresh_players.py`. The GitHub Action in `.github/workflows/refresh-players.yml` runs it daily and commits any changes.

- **Rosters** (team, jersey, position, height) come from www.nba.com/players, and **ages** from player pages. Both embed their data as JSON.
- **Per-game averages** come from stats.nba.com when it responds. It usually blocks automated requests, so otherwise each player keeps the averages already in `players.json`, matched by id. Players without averages (e.g. rookies) are never chosen as a Stats-mode target.
- If the roster data comes back incomplete, the script leaves the existing file untouched.

Run it locally with:

```bash
pip install -r scripts/requirements.txt
python scripts/refresh_players.py
```
