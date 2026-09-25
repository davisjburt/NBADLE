# NBADLE

Guess the NBA player. Runs on Cloudflare Workers.

- `public/`: the static site (HTML, CSS, JS) plus `players.json`, served by Workers Static Assets
- `src/index.js`: the `/api/*` routes (headshot proxy, Versus endpoints)
- `src/vs-room.js`: the `VsRoom` Durable Object, one per Versus PIN. It holds the target player and scores guesses server-side. Rooms expire after 2 hours.
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

`public/players.json` comes from `scripts/refresh_players.py`, which uses nba_api. The GitHub Action in `.github/workflows/refresh-players.yml` runs it daily and commits any changes. If stats.nba.com can't be reached, the script leaves the existing file untouched.

Run it locally with:

```bash
pip install -r scripts/requirements.txt
python scripts/refresh_players.py
```
