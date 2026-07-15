# Business Maverick — Market Moves (self-hosted on GitHub, no server, no dev)

A standalone page that shows **two market snapshots a day** — one frozen at
**05:30 SAST** and one at **17:00 SAST**. Once a slot is captured for the day it
**doesn't change**: a reader who opens the page at 09:00 still sees the exact
05:30 numbers.

There is **no continuous polling and no separate server.** GitHub itself runs a
tiny scheduled job twice a day, grabs the numbers, and saves them next to the
page. No API key or token is needed — all the feeds are public.

Markets shown: JSE All Share, S&P 500, USD/EUR/GBP → ZAR, Brent Crude, Gold,
Bitcoin.

---

## How it works

```
  GitHub Action (05:30 & 17:00 SAST)            GitHub Pages
  ── runs on GitHub's servers                   ── serves index.html
  ── fetches Yahoo / ECB / CoinGecko    ───►     ── serves data/markets.json
  ── writes that slot into markets.json         the page reads that JSON (same
                                                origin → no CORS problem)
```

The **GitHub Action is the "server."** It runs on GitHub, where calling the
market feeds is allowed. The page just reads a static JSON file sitting next to
it, so nothing has to be fetched from the reader's browser (which the feeds
block). Each run writes only its own slot (`am` or `pm`) and leaves the other
untouched.

---

## What's in this folder

```
index.html                    the page (loads the scripts + styles below)
mm-app.js                     the widget: reads data/markets.json, freezes each card
mm-core.js                    shared formatting + fallback fetchers + PNG export
markets.css, dm-tokens.css    styles + Daily Maverick design tokens
fonts-embed.js, fonts/        Geist / DM Custom / Charis SIL (for the page + PNG export)
assets/                       Daily Maverick masthead
data/markets.json             the snapshot file (a seed; the Action overwrites it)
scripts/build-snapshot.mjs    the capture script (fetches markets server-side)
.github/workflows/update-markets.yml   the twice-a-day schedule
```

---

## Set it up — about 5 minutes, all on the GitHub website

### 1. Create a repository
GitHub → **New repository** (e.g. `dm-market-moves`). **Public** is fine and
gives you free Actions + Pages. Nothing sensitive is stored — there is no token.

### 2. Upload these files
On the repo page: **Add file → Upload files**, then drag in **everything in this
folder** (keep the folder structure). The `.github` folder can be hidden by your
operating system — if it didn't upload, create it by hand: **Add file → Create
new file**, name it exactly `.github/workflows/update-markets.yml`, and paste in
the contents from this folder.

### 3. Turn on GitHub Pages
Repo **Settings → Pages → Source:** *Deploy from a branch* → Branch **main** →
Folder **/ (root)** → **Save**. After a minute you get a URL like
`https://<your-username>.github.io/dm-market-moves/`.

### 4. Run the capture once (don't wait for the timer)
Repo **Actions** tab → enable workflows if prompted → **Update market
snapshot** → **Run workflow**. (You can optionally type `am` or `pm` in the
slot box; leave it blank to auto-pick by the current time.) When it finishes and
Pages redeploys (~1 min), open your Pages URL — the cards fill with real
numbers.

That's it. From now on the numbers refresh **on their own at 05:30 and 17:00
SAST** every day.

---

## Good to know

- **The two times are set in the workflow.** GitHub cron runs in UTC, so
  `.github/workflows/update-markets.yml` uses `30 3 * * *` (05:30 SAST) and
  `0 15 * * *` (17:00 SAST). SAST has no daylight saving, so these never drift.
  To change the times, edit those two cron lines (convert SAST → UTC by
  subtracting 2 hours).
- **GitHub may run scheduled jobs a few minutes late** under load. If you need
  the capture pinned to the exact minute, trigger it manually or run the same
  `build-snapshot.mjs` from your own scheduler.
- **It never shows a broken page.** If a feed is down, that market shows a dash
  (—) instead of a number; if every feed fails, the previous `data/markets.json`
  is kept. And if the file is missing entirely, the page captures the values in
  the browser once as a fallback so it still renders.
- **Stopping it** (e.g. after a change of plan): Actions tab → Update market
  snapshot → **⋯ → Disable workflow**. Re-enable any time.
- **Yahoo occasionally rate-limits datacenter IPs.** It usually resolves by the
  next run thanks to the schedule; the script sends a browser User-Agent to
  reduce this. If a Yahoo-sourced tile (JSE, S&P 500, Brent, Gold) is
  persistently blank, re-run the workflow, or move those four to a paid
  market-data API in `build-snapshot.mjs`.

---

## Embedding it on the Daily Maverick site later

This build is a **standalone page**. If you instead want it inside the DM CMS
custom-page (HTML/CSS/JS tabs), the same `mm-app.js` / `mm-core.js` work there —
point the fetch in `mm-app.js` at the `data/markets.json` URL on your Pages
site (or host the JSON anywhere first-party). Ask and I'll generate the three
CMS tabs from these files.
