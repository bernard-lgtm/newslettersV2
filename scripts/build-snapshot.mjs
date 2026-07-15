// ============================================================================
// Market Moves snapshot builder — runs inside GitHub Actions (Node 20+)
// ----------------------------------------------------------------------------
// Runs at 05:30 and 17:00 SAST (see .github/workflows/update-markets.yml).
// Fetches every market SERVER-SIDE (no browser CORS limits, no token needed —
// all feeds are public), computes { price, d1, m1, ytd } per instrument, and
// writes the values into ONE slot ("am" or "pm") of data/markets.json. The
// other slot is preserved. The page (index.html) reads that file and freezes
// each card to its slot.
//
// Slot selection: the current SAST hour decides it — before midday → "am",
// otherwise → "pm". Override with the SLOT env var ("am" | "pm") if needed.
// ============================================================================

import { readFile, writeFile, mkdir } from "node:fs/promises";

const INSTRUMENTS = [
  { key: "jse",    source: "yahoo",  ysym: "^J203.JO" },
  { key: "sp500",  source: "yahoo",  ysym: "^GSPC" },
  { key: "usdzar", source: "fx",     from: "USD" },
  { key: "eurzar", source: "fx",     from: "EUR" },
  { key: "gbpzar", source: "fx",     from: "GBP" },
  { key: "brent",  source: "yahoo",  ysym: "BZ=F" },
  { key: "gold",   source: "yahoo",  ysym: "GC=F" },
  { key: "btc",    source: "crypto", cg: "bitcoin" },
];

const UA = "Mozilla/5.0 (compatible; DM-MarketMoves/1.0; +https://www.dailymaverick.co.za)";

// --- SAST helpers (UTC+2, no DST) ---
function sastParts(d) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const o = {};
  for (const p of fmt.formatToParts(d)) o[p.type] = p.value;
  return o;
}
const now = new Date();
const p = sastParts(now);
const dateKey = `${p.year}-${p.month}-${p.day}`;
const slot = (process.env.SLOT || (Number(p.hour) < 12 ? "am" : "pm")).toLowerCase();
if (slot !== "am" && slot !== "pm") {
  console.error(`Bad SLOT "${slot}" — expected am or pm.`);
  process.exit(1);
}

// --- number crunching (ported from the widget's mm-core.js) ---
function statsFromSeries(series, opts = {}) {
  if (!series || series.length < 2) return null;
  const price = opts.price != null ? opts.price : series[series.length - 1].c;
  const prevClose = opts.prevClose != null ? opts.prevClose : series[series.length - 2].c;
  const t = Date.now();
  const pf = (b) => (b ? ((price - b) / b) * 100 : null);
  const d1 = pf(prevClose);
  const monthAgo = t - 31 * 864e5;
  let mRef = series[0].c;
  for (const pt of series) { if (pt.t <= monthAgo) mRef = pt.c; else break; }
  const m1 = pf(mRef);
  const yr = new Date().getFullYear();
  let yRef = series[0].c;
  for (const pt of series) { if (new Date(pt.t).getFullYear() < yr) yRef = pt.c; else { yRef = pt.c; break; } }
  const ytd = pf(yRef);
  return { price, d1, m1, ytd };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const json = await getJson(url);
  const r = json?.chart?.result?.[0];
  if (!r?.meta) return null;
  const ts = r.timestamp || [];
  const closes = r.indicators?.quote?.[0]?.close || [];
  const series = [];
  for (let i = 0; i < ts.length; i++) if (closes[i] != null) series.push({ t: ts[i] * 1000, c: closes[i] });
  return statsFromSeries(series, { price: r.meta.regularMarketPrice, prevClose: r.meta.chartPreviousClose });
}

async function fetchFx(from) {
  const yr = new Date().getFullYear();
  const url = `https://api.frankfurter.dev/v1/${yr - 1}-12-15..?base=${from}&symbols=ZAR`;
  const json = await getJson(url);
  if (!json?.rates) return null;
  const series = Object.keys(json.rates).sort()
    .map((d) => ({ t: new Date(d).getTime(), c: json.rates[d].ZAR }))
    .filter((x) => x.c != null);
  return statsFromSeries(series);
}

async function fetchCrypto(id) {
  const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=365`;
  const json = await getJson(url);
  if (!Array.isArray(json?.prices) || json.prices.length < 2) return null;
  const series = json.prices.map((x) => ({ t: x[0], c: x[1] }));
  return statsFromSeries(series);
}

function fetchInstrument(inst) {
  if (inst.source === "fx") return fetchFx(inst.from);
  if (inst.source === "crypto") return fetchCrypto(inst.cg);
  return fetchYahoo(inst.ysym);
}

// --- build the slot ---
const data = {};
let hits = 0;
for (const inst of INSTRUMENTS) {
  try {
    const r = await fetchInstrument(inst);
    if (r && r.price != null && !Number.isNaN(r.price)) {
      data[inst.key] = { price: r.price, d1: r.d1, m1: r.m1, ytd: r.ytd };
      hits++;
    } else {
      data[inst.key] = null;
      console.warn(`No value for ${inst.key}.`);
    }
  } catch (e) {
    data[inst.key] = null;
    console.warn(`Fetch failed for ${inst.key}: ${e.message}`);
  }
}

if (hits === 0) {
  // Total failure — do NOT overwrite the last good file. Exit non-zero.
  console.error("Every feed failed — leaving data/markets.json untouched.");
  process.exit(1);
}

// --- merge into data/markets.json, preserving the other slot ---
let existing = {};
try { existing = JSON.parse(await readFile("data/markets.json", "utf8")) || {}; } catch { /* first run */ }

existing[slot] = { date: dateKey, capturedAt: now.toISOString(), data };
existing.meta = { updated_slot: slot, updated_at: now.toISOString() };

await mkdir("data", { recursive: true });
await writeFile("data/markets.json", JSON.stringify(existing, null, 2));
console.log(`Wrote slot "${slot}" for ${dateKey} — ${hits}/${INSTRUMENTS.length} markets.`);
