/* =====================================================================
   Daily Maverick — Market Moves V4 · shared core
   Plain React (UMD) — uses React.createElement directly, no JSX/Babel.

   Exposes window.MMV4 with:
     • formatting + fetch primitives (proxy race, last-good cache)
     • live fetchers: fetchYahoo / fetchFx / fetchCrypto / fetchUsdZar
     • asset (masthead + flag) prefetch → data URLs for crisp PNG export
     • shared components: Arrow, DayChip, Sparkline, Flag, Glyph, Badge,
       PanelHead, PanelCap, BlockBar
     • usePngExport(ref, filenameBase, showToast) — per-panel PNG capture

   PREVIEW ONLY — production must route feeds through a cached proxy.
   ===================================================================== */
(function () {
  const { useState, useEffect, useCallback } = React;

  const REFRESH_MS = 15 * 60 * 1000;

  /* ---------------- number / time formatting ---------------- */
  function fmtVal(v, cfg) {
    cfg = cfg || {};
    if (v == null || isNaN(v)) return '—';
    const dp = cfg.decimals == null ? 2 : cfg.decimals;
    const n = Number(v).toLocaleString('en-US', {
      minimumFractionDigits: dp, maximumFractionDigits: dp,
    }).replace(/,/g, ' ');
    return (cfg.prefix || '') + n;
  }
  /* Adaptive crypto price: more decimals for sub-dollar coins. */
  function cryptoDecimals(v) {
    if (v == null || isNaN(v)) return 2;
    const a = Math.abs(v);
    if (a >= 1000) return 0;
    if (a >= 100) return 1;
    if (a >= 1) return 2;
    if (a >= 0.01) return 4;
    return 6;
  }
  function fmtPct(p) {
    if (p == null || isNaN(p)) return '—';
    return (p >= 0 ? '+' : '−') + Math.abs(p).toFixed(2) + '%';
  }
  function pctDir(p) { return (p == null || isNaN(p)) ? 'flat' : (p >= 0 ? 'up' : 'down'); }
  function fmtAgo(date) {
    if (!date) return '';
    const s = Math.max(0, (Date.now() - date.getTime()) / 1000);
    if (s < 50) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm ago';
  }
  function timeStrOf(d) {
    return d ? d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
  }
  function dateStrOf(d) {
    return d ? d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'long', year: 'numeric' }) : '';
  }

  /* ---------------- shared fetch + proxy race ---------------- */
  async function fetchJson(url, timeout) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeout || 8000);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) { return null; } finally { clearTimeout(to); }
  }
  function firstValid(promises) {
    return new Promise((resolve) => {
      let pending = promises.length;
      if (!pending) return resolve(null);
      promises.forEach((p) => Promise.resolve(p).then(
        (v) => { if (v) resolve(v); if (--pending === 0) resolve(null); },
        () => { if (--pending === 0) resolve(null); }
      ));
    });
  }
  /* ---------------- cache-proxy configuration ----------------
     The market feeds (Yahoo especially) are NOT reachable from the browser
     directly (CORS), and the free public CORS proxies are unreliable —
     corsproxy.io is now paywalled (returns 403). In production we route every
     upstream through our OWN server-side cache-proxy (see market-moves-proxy/).
     Point the widget at it by setting ONE of, in priority order:
       1.  ?proxy=<url>  in the page URL            (quick testing)
       2.  window.MM_PROXY_BASE = '<url>'           (CMS embed — set in JS tab)
       3.  localStorage 'mm_proxy_base' = '<url>'   (persistent dev override)
     With none set, the widget falls back to the (flaky) public proxies. */
  function resolveProxyBase() {
    try {
      const q = new URLSearchParams(location.search).get('proxy');
      let ls = null; try { ls = localStorage.getItem('mm_proxy_base'); } catch (e) { /* ignore */ }
      return String(q || (typeof window !== 'undefined' && window.MM_PROXY_BASE) || ls || '')
        .trim().replace(/[/?#\s]+$/, '');
    } catch (e) { return ''; }
  }
  const PROXY_BASE = resolveProxyBase();
  /* Wrap an upstream URL so it is fetched through our cache-proxy. */
  function viaProxy(target) {
    if (!PROXY_BASE) return target;
    return PROXY_BASE + (PROXY_BASE.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(target);
  }
  /* Legacy public CORS proxies — used only when no cache-proxy is configured.
     corsproxy.io removed (paywalled); the rest are slow/unreliable. */
  const LEGACY_PROXIES = [
    (u) => u,
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  ];
  /* Race a JSON GET, first parseable result wins. With a cache-proxy set we go
     through it exclusively (reliable + edge-cached); otherwise fall back. */
  function raceJson(target, parse, timeout) {
    const wraps = PROXY_BASE ? [viaProxy] : LEGACY_PROXIES;
    return firstValid(wraps.map((wrap) =>
      fetchJson(wrap(target), timeout || 9000).then((j) => (j ? parse(j) : null))));
  }

  /* ---------------- series maths (indices / fx / btc) ---------------- */
  function thin(series, n) {
    if (series.length <= n) return series;
    const step = (series.length - 1) / (n - 1);
    const out = [];
    for (let i = 0; i < n; i++) out.push(series[Math.round(i * step)]);
    return out;
  }
  function statsFromSeries(series, opts) {
    opts = opts || {};
    if (!series || series.length < 2) return null;
    const price = opts.price != null ? opts.price : series[series.length - 1].c;
    const prevClose = opts.prevClose != null ? opts.prevClose : series[series.length - 2].c;
    const now = Date.now();
    const pf = (b) => (b ? ((price - b) / b) * 100 : null);
    const d1 = pf(prevClose);
    const monthAgo = now - 31 * 864e5;
    let mRef = series[0].c;
    for (const p of series) { if (p.t <= monthAgo) mRef = p.c; else break; }
    const m1 = pf(mRef);
    const yr = new Date().getFullYear();
    let yRef = series[0].c;
    for (const p of series) { if (new Date(p.t).getFullYear() < yr) yRef = p.c; else { yRef = p.c; break; } }
    const ytd = pf(yRef);
    let out = series;
    if (price != null && !isNaN(price) && out.length && out[out.length - 1].c !== price) {
      out = out.concat([{ t: now, c: price }]);
    }
    return { price, d1, m1, ytd, series: thin(out, 260), live: true, cached: false };
  }

  /* ---- Yahoo (indices + commodities) ---- */
  function chartUrl(symbol) {
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  }
  function parseYahoo(json) {
    const r = json && json.chart && json.chart.result && json.chart.result[0];
    if (!r || !r.meta) return null;
    const ts = r.timestamp || [];
    const closes = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
    const series = [];
    for (let i = 0; i < ts.length; i++) { if (closes[i] != null) series.push({ t: ts[i] * 1000, c: closes[i] }); }
    return statsFromSeries(series, { price: r.meta.regularMarketPrice, prevClose: r.meta.chartPreviousClose });
  }
  function fetchYahoo(symbol) { return raceJson(chartUrl(symbol), parseYahoo, 8000); }

  /* ---- FX via Frankfurter (ECB reference rates, CORS-native) ---- */
  async function fetchFx(from) {
    const yr = new Date().getFullYear();
    const url = `https://api.frankfurter.dev/v1/${yr - 1}-12-15..?base=${from}&symbols=ZAR`;
    const json = await fetchJson(viaProxy(url), 8000);
    if (!json || !json.rates) return null;
    const series = Object.keys(json.rates).sort()
      .map((d) => ({ t: new Date(d).getTime(), c: json.rates[d].ZAR }))
      .filter((p) => p.c != null);
    return statsFromSeries(series);
  }
  /* Single latest USD→ZAR rate (used to derive the crypto ZAR column). */
  async function fetchUsdZar() {
    const json = await fetchJson(viaProxy('https://api.frankfurter.dev/v1/latest?base=USD&symbols=ZAR'), 8000);
    const r = json && json.rates && json.rates.ZAR;
    return (r != null && !isNaN(r)) ? r : null;
  }

  /* ---- Crypto via CoinGecko (CORS-native) ---- */
  async function fetchCrypto(id) {
    const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=365`;
    const json = await fetchJson(viaProxy(url), 8000);
    if (!json || !Array.isArray(json.prices) || json.prices.length < 2) return null;
    const series = json.prices.map((p) => ({ t: p[0], c: p[1] }));
    return statsFromSeries(series);
  }

  function noData() {
    return { price: null, d1: null, m1: null, ytd: null, series: null, live: false, cached: false, nodata: true };
  }

  /* ---------------- last-good cache ---------------- */
  function makeCache(key) {
    return {
      read() {
        try {
          const raw = localStorage.getItem(key);
          if (!raw) return null;
          const parsed = JSON.parse(raw);
          if (!parsed || !parsed.data || !parsed.ts) return null;
          return parsed;
        } catch (e) { return null; }
      },
      write(payload, ts) {
        try {
          if (payload && Object.keys(payload).length) {
            localStorage.setItem(key, JSON.stringify({ ts, data: payload }));
          }
        } catch (e) { /* quota — ignore */ }
      },
    };
  }

  /* ---------------- asset prefetch → data URLs ---------------- */
  const CRYPTO_CDN = 'https://cdn.jsdelivr.net/gh/vadimmalykhin/binance-icons/crypto/';
  const ASSET_URLS = {
    za: 'https://flagcdn.com/w80/za.png',
    us: 'https://flagcdn.com/w80/us.png',
    eu: 'data:image/png;base64,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',
    gb: 'https://flagcdn.com/w80/gb.png',
    btc: CRYPTO_CDN + 'btc.svg',
    eth: CRYPTO_CDN + 'eth.svg',
    xrp: CRYPTO_CDN + 'xrp.svg',
    sol: CRYPTO_CDN + 'sol.svg',
    bnb: CRYPTO_CDN + 'bnb.svg',
    masthead: 'assets/DM_Masthead_Official.svg',
  };
  const assetCache = {};
  function toDataUrl(blob) {
    return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
  }
  function useAssets() {
    const [, setVer] = useState(0);
    useEffect(() => {
      let alive = true;
      Promise.all(Object.keys(ASSET_URLS).map(async (k) => {
        if (assetCache[k]) return;
        try { const r = await fetch(ASSET_URLS[k], { cache: 'force-cache' }); assetCache[k] = await toDataUrl(await r.blob()); } catch (e) { /* leave unset */ }
      })).then(() => { if (alive) setVer((v) => v + 1); });
      return () => { alive = false; };
    }, []);
  }

  /* ---------------- shared small components ---------------- */
  function Flag({ code }) {
    const src = assetCache[code];
    if (!src) return React.createElement('span', { className: 'mm-flag mm-flag-ph' });
    return React.createElement('img', { className: 'mm-flag', src, alt: code.toUpperCase() });
  }
  function Glyph({ type }) {
    if (type === 'barrel') {
      /* 3D oil drum, three-quarter view from above, with an oil drop */
      return React.createElement('svg', { className: 'mm-glyph mm-glyph-barrel', viewBox: '0 0 24 24' },
        /* body */
        React.createElement('path', { d: 'M5.7 7.2 L5.7 17.2 A6.3 2.5 0 0 0 18.3 17.2 L18.3 7.2 Z', fill: '#eaeff5' }),
        /* right-side shading for volume */
        React.createElement('path', { d: 'M18.3 7.2 L18.3 17.2 A6.3 2.5 0 0 1 13.4 19.55 L13.4 6.6 Z', fill: '#cdd7e1' }),
        /* hoops */
        React.createElement('path', { d: 'M5.9 10.5 A6.3 2.5 0 0 0 18.1 10.5', fill: 'none', stroke: '#98a5b5', strokeWidth: 1 }),
        React.createElement('path', { d: 'M5.9 14.1 A6.3 2.5 0 0 0 18.1 14.1', fill: 'none', stroke: '#98a5b5', strokeWidth: 1 }),
        /* top lid seen from above */
        React.createElement('ellipse', { cx: 12, cy: 7.2, rx: 6.3, ry: 2.5, fill: '#dbe2ea', stroke: '#aeb9c5', strokeWidth: 0.8 }),
        React.createElement('ellipse', { cx: 12, cy: 7.2, rx: 3.5, ry: 1.35, fill: '#c3cdd8' }),
        /* oil drop */
        React.createElement('path', { d: 'M12 10.2 C13.7 12.3 14.6 13.4 14.6 14.7 A2.6 2.6 0 1 1 9.4 14.7 C9.4 13.4 10.3 12.3 12 10.2 Z', fill: '#16233f' }),
        React.createElement('ellipse', { cx: 11, cy: 14.6, rx: 0.65, ry: 0.95, fill: 'rgba(255,255,255,0.55)' }));
    }
    if (type === 'goldbars') {
      /* three stacked gold ingots with isometric depth */
      const bar = function (x0, x1, y0, y1) {
        var sx = 2, sy = 1.5;
        return React.createElement('g', { stroke: '#a9781f', strokeWidth: 0.5, strokeLinejoin: 'round' },
          React.createElement('polygon', { points: x0 + ',' + y0 + ' ' + (x0 + sx) + ',' + (y0 - sy) + ' ' + (x1 + sx) + ',' + (y0 - sy) + ' ' + x1 + ',' + y0, fill: '#ffe4a0' }),
          React.createElement('polygon', { points: x0 + ',' + y0 + ' ' + x1 + ',' + y0 + ' ' + x1 + ',' + y1 + ' ' + x0 + ',' + y1, fill: '#f2be4d' }),
          React.createElement('polygon', { points: x1 + ',' + y0 + ' ' + (x1 + sx) + ',' + (y0 - sy) + ' ' + (x1 + sx) + ',' + (y1 - sy) + ' ' + x1 + ',' + y1, fill: '#cd962e' }));
      };
      return React.createElement('svg', { className: 'mm-glyph mm-glyph-gold', viewBox: '0 0 24 24' },
        bar(2, 9.3, 16.5, 20.3),
        bar(9.5, 16.8, 16.5, 20.3),
        bar(5.75, 13.05, 11.4, 15.6));
    }
    /* fallback: trending-up line */
    return React.createElement('svg', { className: 'mm-glyph', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2.2', strokeLinecap: 'round', strokeLinejoin: 'round' },
      React.createElement('path', { d: 'M3 17l6-6 4 4 7-7' }),
      React.createElement('path', { d: 'M17 8h4v4' }));
  }
  function MarketChartGlyph() {
    /* rising line over a bar chart — reads as a stock exchange */
    return React.createElement('svg', { className: 'mm-glyph mm-glyph-market', viewBox: '0 0 24 24' },
      React.createElement('g', { fill: 'rgba(255,255,255,0.42)' },
        React.createElement('rect', { x: 3, y: 13, width: 3.4, height: 8, rx: 0.6 }),
        React.createElement('rect', { x: 8, y: 10, width: 3.4, height: 11, rx: 0.6 }),
        React.createElement('rect', { x: 13, y: 12, width: 3.4, height: 9, rx: 0.6 }),
        React.createElement('rect', { x: 18, y: 6.5, width: 3.4, height: 14.5, rx: 0.6 })),
      React.createElement('path', { d: 'M3.5 15.5 L9.5 11 L14.5 13 L20.6 6.6', fill: 'none', stroke: '#fff', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      React.createElement('path', { d: 'M16.9 6.6 H20.9 V10.5', fill: 'none', stroke: '#fff', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }));
  }
  function TrendMark() {
    return React.createElement('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '3', strokeLinecap: 'round', strokeLinejoin: 'round' },
      React.createElement('path', { d: 'M4 16l5-5 4 4 7-8' }),
      React.createElement('path', { d: 'M16 7h5v5' }));
  }
  function assetImg(key, className, alt) {
    const src = assetCache[key];
    if (!src) return React.createElement('span', { className: className + ' mm-asset-ph' });
    return React.createElement('img', { className, src, alt: alt ? alt.toUpperCase() : '', draggable: false });
  }
  function CryptoLogo({ logo, color, fallback }) {
    const src = assetCache[logo];
    if (src) return React.createElement('img', { className: 'mm-coin-logo', src, alt: (logo || '').toUpperCase(), draggable: false });
    return React.createElement('span', { className: 'mm-coin-fallback', style: { background: color || 'var(--dm-ink-3)' } }, fallback || '');
  }
  function Badge({ inst }) {
    const kind = inst.badge
      || (inst.flags && inst.flags.length === 2 ? 'fx'
        : inst.flags && inst.flags.length ? 'index' : 'commodity');
    if (kind === 'index') {
      return React.createElement('span', { className: 'mm-badge mm-badge-index mm-badge-market' },
        React.createElement(MarketChartGlyph, null),
        React.createElement('span', { className: 'mm-badge-flagchip' },
          assetImg(inst.flags[0], 'mm-flagchip-img', inst.flags[0])));
    }
    if (kind === 'fx') {
      if (!inst.flags || inst.flags.length < 2) {
        return React.createElement('span', { className: 'mm-badge mm-badge-fx mm-badge-fx-solo' },
          assetImg(inst.flags[0], 'mm-coin mm-coin-solo', inst.flags[0]));
      }
      return React.createElement('span', { className: 'mm-badge mm-badge-fx' },
        assetImg(inst.flags[0], 'mm-coin mm-coin-back', inst.flags[0]),
        assetImg(inst.flags[1], 'mm-coin mm-coin-front', inst.flags[1]));
    }
    if (kind === 'crypto') {
      return React.createElement('span', { className: 'mm-badge mm-badge-crypto' },
        React.createElement(CryptoLogo, { logo: inst.logo, color: inst.color, fallback: inst.ticker || '' }));
    }
    return React.createElement('span', { className: 'mm-badge mm-badge-commodity ' + (inst.glyph || '') },
      React.createElement(Glyph, { type: inst.glyph }));
  }
  function Arrow({ dir }) {
    if (dir === 'flat') return null;
    return React.createElement('svg', { className: 'mm-arrow', viewBox: '0 0 10 10', 'aria-hidden': 'true' },
      dir === 'up' ? React.createElement('path', { d: 'M5 1l4 6H1z' }) : React.createElement('path', { d: 'M5 9L1 3h8z' }));
  }
  function DayChip({ pct }) {
    const dir = pctDir(pct);
    return React.createElement('span', { className: 'mm-daychip ' + dir },
      React.createElement(Arrow, { dir }), fmtPct(pct));
  }
  function Sparkline({ series, pct }) {
    if (!series || series.length < 2) return null;
    const cut = Date.now() - 31 * 864e5;
    let pts0 = series.filter((p) => p.t >= cut);
    if (pts0.length < 2) pts0 = series;
    const data = thin(pts0, 64).map((p) => p.c);
    const up = pct != null && !isNaN(pct) ? pct >= 0 : data[data.length - 1] >= data[0];
    const w = 120, h = 30, pad = 2;
    const min = Math.min(...data), max = Math.max(...data);
    const span = max - min || 1;
    const step = (w - pad * 2) / (data.length - 1);
    const pts = data.map((d, i) => [pad + i * step, pad + (h - pad * 2) * (1 - (d - min) / span)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area = line + ` L ${pts[pts.length - 1][0].toFixed(1)} ${h} L ${pts[0][0].toFixed(1)} ${h} Z`;
    const stroke = up ? 'var(--dm-green)' : 'var(--dm-red)';
    const gid = 'sg-' + (up ? 'u' : 'd');
    return (
      React.createElement('svg', { className: 'mm-spark', viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
        React.createElement('defs', null,
          React.createElement('linearGradient', { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' },
            React.createElement('stop', { offset: '0%', stopColor: stroke, stopOpacity: '0.20' }),
            React.createElement('stop', { offset: '100%', stopColor: stroke, stopOpacity: '0' })
          )
        ),
        React.createElement('path', { d: area, fill: `url(#${gid})`, stroke: 'none' }),
        React.createElement('path', { d: line, fill: 'none', stroke, strokeWidth: '1.7', strokeLinejoin: 'round', strokeLinecap: 'round' })
      )
    );
  }

  /* ---------------- panel header + cap (captured into the PNG) ---------------- */
  function PanelHead({ title, capState, capLabel, updated }) {
    return React.createElement('div', { className: 'mm-panel-head' },
      assetCache.masthead
        ? React.createElement('img', { className: 'mm-mast-sm', src: assetCache.masthead, alt: 'Daily Maverick' })
        : null,
      React.createElement('h1', { className: 'mm-panel-title' }, title),
      React.createElement('div', { className: 'mm-panel-cap' },
        React.createElement('span', { className: 'mm-cap-live ' + capState },
          React.createElement('span', { className: 'd' }), capLabel),
        React.createElement('span', { className: 'mm-cap-sep' }, '|'),
        React.createElement('span', null, updated ? `${timeStrOf(updated)} · ${dateStrOf(updated)}` : 'Fetching…')));
  }

  /* ---------------- on-screen block toolbar (NOT captured) ---------------- */
  function BlockBar({ eyebrow, state, pillLabel, onCopy, onExport, exporting }) {
    return React.createElement('div', { className: 'mm-blockbar' },
      React.createElement('div', { className: 'mm-blockbar-left' },
        React.createElement('span', { className: 'mm-block-eyebrow' }, eyebrow),
        React.createElement('span', { className: 'mm-pill ' + state },
          React.createElement('span', { className: 'dot' }), pillLabel)),
      React.createElement('div', { className: 'mm-blockbar-right' },
        React.createElement('button', { className: 'mm-btn mm-btn-ghost', type: 'button', onClick: onCopy, disabled: exporting },
          React.createElement('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2.2', strokeLinecap: 'round', strokeLinejoin: 'round' },
            React.createElement('rect', { x: '9', y: '9', width: '12', height: '12', rx: '2' }),
            React.createElement('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' })),
          'Copy PNG'),
        React.createElement('button', { className: 'mm-btn mm-btn-primary', type: 'button', onClick: onExport, disabled: exporting },
          React.createElement('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2.4', strokeLinecap: 'round', strokeLinejoin: 'round' },
            React.createElement('path', { d: 'M12 3v12' }),
            React.createElement('path', { d: 'M7 10l5 5 5-5' }),
            React.createElement('path', { d: 'M5 21h14' })),
          exporting ? 'Exporting…' : 'Export PNG')));
  }

  /* ---------------- per-panel PNG capture ---------------- */
  function usePngExport(ref, filenameBase, showToast) {
    const [exporting, setExporting] = useState(false);
    const capture = useCallback(async (asBlob) => {
      const node = ref.current;
      if (!node || !window.htmlToImage) return null;
      node.classList.add('capturing');
      try {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await Promise.all(Array.from(node.querySelectorAll('img')).map((img) =>
          img.complete ? Promise.resolve() : new Promise((r) => { img.onload = img.onerror = r; })));
        const opts = { pixelRatio: 2, backgroundColor: '#ffffff', cacheBust: true };
        if (window.__FONT_EMBED_CSS) opts.fontEmbedCSS = window.__FONT_EMBED_CSS;
        return asBlob ? await window.htmlToImage.toBlob(node, opts) : await window.htmlToImage.toPng(node, opts);
      } finally { node.classList.remove('capturing'); }
    }, [ref]);

    const exportPng = useCallback(async () => {
      setExporting(true);
      try {
        const url = await capture(false);
        if (url) {
          const a = document.createElement('a');
          a.download = `${filenameBase}-${new Date().toISOString().slice(0, 10)}.png`;
          a.href = url; a.click();
          showToast('PNG saved to downloads');
        }
      } catch (e) { console.error('PNG export failed', e); showToast('Export failed — try again'); }
      setExporting(false);
    }, [capture, filenameBase, showToast]);

    const copyPng = useCallback(async () => {
      setExporting(true);
      try {
        if (!navigator.clipboard || !window.ClipboardItem) throw new Error('clipboard unsupported');
        const blob = await capture(true);
        if (!blob) throw new Error('capture failed');
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        showToast('Panel copied — paste it anywhere');
      } catch (e) {
        console.warn('Copy failed, falling back to download', e);
        setExporting(false);
        return exportPng();
      }
      setExporting(false);
    }, [capture, exportPng, showToast]);

    return { exporting, exportPng, copyPng };
  }

  window.MMV4 = {
    REFRESH_MS, PROXY_BASE, viaProxy,
    fmtVal, cryptoDecimals, fmtPct, pctDir, fmtAgo, timeStrOf, dateStrOf,
    fetchJson, firstValid, raceJson, thin, statsFromSeries,
    fetchYahoo, fetchFx, fetchUsdZar, fetchCrypto, noData, makeCache,
    assetCache, useAssets,
    Flag, Glyph, Badge, CryptoLogo, Arrow, DayChip, Sparkline,
    PanelHead, BlockBar, usePngExport,
  };
})();
