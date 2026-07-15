/* =====================================================================
   Daily Maverick — Market Moves · twice-daily frozen snapshots
   Standalone GitHub Pages build.

   Two stacked "Market moves" cards, each a snapshot FROZEN at a fixed
   time of day (SAST): 05:30 in the morning and 17:00 in the afternoon.

   WHERE THE NUMBERS COME FROM
   ---------------------------
   A scheduled GitHub Action (.github/workflows/update-markets.yml) runs
   at 05:30 and 17:00 SAST, fetches every market SERVER-SIDE, and commits
   the result to data/markets.json. This page reads that file (same
   origin, so no CORS) and freezes each card to its slot. Because the
   capture happens on GitHub's servers at the exact slot time, the freeze
   is accurate to the minute and identical for every reader — a late riser
   still sees the exact 05:30 numbers.

   FALLBACK: if data/markets.json is missing (e.g. opening the file
   locally before the Action has ever run), the page captures the values
   in the browser once and freezes those instead, so it never shows demo
   data. Where a source is unavailable the cell shows an em dash.

   Requires mm-core.js.
   ===================================================================== */
(function () {
  const { useState, useEffect, useRef, useCallback } = React;
  const M = window.MMV4;

  /* ---- the eight markets shown in every snapshot ---- */
  const INSTRUMENTS = [
    { key: 'jse',    title: 'JSE All Share', source: 'yahoo',  ysym: '^J203.JO', decimals: 0, prefix: '',  badge: 'index',     flags: ['za'] },
    { key: 'sp500',  title: 'S&P 500',       source: 'yahoo',  ysym: '^GSPC',    decimals: 0, prefix: '',  badge: 'index',     flags: ['us'] },
    { key: 'usdzar', title: 'USD / ZAR',     source: 'fx',     from: 'USD',      decimals: 2, prefix: 'R', badge: 'fx',        flags: ['us'], groupStart: true },
    { key: 'eurzar', title: 'EUR / ZAR',     source: 'fx',     from: 'EUR',      decimals: 2, prefix: 'R', badge: 'fx',        flags: ['eu'] },
    { key: 'gbpzar', title: 'GBP / ZAR',     source: 'fx',     from: 'GBP',      decimals: 2, prefix: 'R', badge: 'fx',        flags: ['gb'] },
    { key: 'brent',  title: 'Brent Crude',   source: 'yahoo',  ysym: 'BZ=F',     decimals: 2, prefix: '$', badge: 'commodity', glyph: 'barrel', groupStart: true },
    { key: 'gold',   title: 'Gold',          source: 'yahoo',  ysym: 'GC=F',     decimals: 0, prefix: '$', badge: 'commodity', glyph: 'goldbars' },
    { key: 'btc',    title: 'Bitcoin',       source: 'crypto', cg: 'bitcoin',    decimals: 0, prefix: '$', badge: 'crypto',    logo: 'btc', ticker: 'BTC', color: '#F7931A', groupStart: true },
  ];

  /* ---- the two daily freeze slots (SAST wall-clock) ---- */
  const SLOTS = [
    { id: 'am', minutes: 5 * 60 + 30, timeLabel: '5:30 AM',  headLabel: '5:30 AM',  period: 'Morning snapshot' },
    { id: 'pm', minutes: 17 * 60,     timeLabel: '5:00 PM',  headLabel: '5:00 PM',  period: 'Afternoon snapshot' },
  ];

  /* ---- SAST (UTC+2, no DST) time helpers via Intl ---- */
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function sastParts(d) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const o = {};
    for (const p of fmt.formatToParts(d || new Date())) o[p.type] = p.value;
    return o;
  }
  function sastDateKey(d) { const p = sastParts(d); return p.year + '-' + p.month + '-' + p.day; }
  function sastMinutes(d) { const p = sastParts(d); return Number(p.hour) * 60 + Number(p.minute); }
  function prevKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 1);
    return dt.toISOString().slice(0, 10);
  }
  /* most-recent PAST occurrence of this slot (today if it has passed, else yesterday) */
  function targetKeyForSlot(slot) {
    const today = sastDateKey();
    return sastMinutes() >= slot.minutes ? today : prevKey(today);
  }
  function fmtDateKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return DOW[dt.getUTCDay()] + ' ' + d + ' ' + MONTHS[m - 1] + ' ' + y;
  }

  /* ---- server-frozen snapshot file (data/markets.json), loaded once ---- */
  let serverPromise = null;
  function loadServer() {
    if (!serverPromise) {
      serverPromise = fetch('data/markets.json', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    }
    return serverPromise;
  }

  /* ---- localStorage snapshot store (keeps a card frozen across reloads) ---- */
  const STORE_PREFIX = 'dm-mm-site-snap:';
  function storeKey(slot, dateKey) { return STORE_PREFIX + slot.id + ':' + dateKey; }
  function readSnap(slot, dateKey) {
    try {
      const raw = localStorage.getItem(storeKey(slot, dateKey));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.data) return null;
      return parsed;
    } catch (e) { return null; }
  }
  function writeSnap(slot, dateKey, data, ts) {
    try { localStorage.setItem(storeKey(slot, dateKey), JSON.stringify({ ts, data })); } catch (e) { /* quota */ }
  }

  /* ---- browser fallback fetch (only used when the server file is absent) ---- */
  function fetchInstrument(inst) {
    if (inst.source === 'fx') return M.fetchFx(inst.from);
    if (inst.source === 'crypto') return M.fetchCrypto(inst.cg);
    return M.fetchYahoo(inst.ysym);
  }
  function fetchAll() {
    return Promise.all(INSTRUMENTS.map((inst) =>
      Promise.resolve(fetchInstrument(inst)).catch(() => null).then((res) => {
        if (!res || res.price == null || isNaN(res.price)) return [inst.key, null];
        return [inst.key, { price: res.price, d1: res.d1, m1: res.m1, ytd: res.ytd }];
      }))).then((pairs) => {
        const out = {};
        let hits = 0;
        for (const [k, v] of pairs) { out[k] = v; if (v) hits++; }
        return { data: out, hits };
      });
  }

  /* ---- one market row ---- */
  function MarketRow({ inst, d }) {
    const { Badge, DayChip, Arrow, fmtVal, fmtPct, pctDir } = M;
    const cls = 'mm-tr' + (inst.groupStart ? ' mm-tr-group' : '');

    if (d === undefined) {
      return React.createElement('div', { className: cls, 'data-screen-label': inst.title + ' row' },
        React.createElement('div', { className: 'mm-c mm-c-market' },
          React.createElement(Badge, { inst }),
          React.createElement('div', { className: 'mm-idtext' },
            React.createElement('span', { className: 'mm-name' }, inst.title))),
        React.createElement('div', { className: 'mm-c mm-c-price' }, React.createElement('div', { className: 'mm-skel-block mm-skel-val' })),
        React.createElement('div', { className: 'mm-c mm-c-24h' }, React.createElement('div', { className: 'mm-skel-block mm-skel-chip' })),
        React.createElement('div', { className: 'mm-c mm-c-1m' }, React.createElement('div', { className: 'mm-skel-block mm-skel-chip' })),
        React.createElement('div', { className: 'mm-c mm-c-ytd' }, React.createElement('div', { className: 'mm-skel-block mm-skel-chip' })));
    }

    const price = d ? d.price : null;
    const d1 = d ? d.d1 : null;
    const m1 = d ? d.m1 : null;
    const ytd = d ? d.ytd : null;
    const priceStr = fmtVal(price, inst);
    const m1dir = pctDir(m1);
    const ytdDir = pctDir(ytd);

    return React.createElement('div', { className: cls, 'data-screen-label': inst.title + ' row' },
      React.createElement('div', { className: 'mm-c mm-c-market' },
        React.createElement(Badge, { inst }),
        React.createElement('div', { className: 'mm-idtext' },
          React.createElement('span', { className: 'mm-name' }, inst.title))),
      React.createElement('div', { className: 'mm-c mm-c-price' },
        React.createElement('span', { className: 'mm-c-label' }, 'Price'),
        React.createElement('div', { className: 'mm-value' + (priceStr.length > 7 ? ' long' : '') + (price == null ? ' dash' : '') }, priceStr)),
      React.createElement('div', { className: 'mm-c mm-c-24h' },
        React.createElement('span', { className: 'mm-c-label' }, '24h'),
        React.createElement(DayChip, { pct: d1 })),
      React.createElement('div', { className: 'mm-c mm-c-1m ' + m1dir },
        React.createElement('span', { className: 'mm-c-label' }, '1 Month'),
        React.createElement('span', { className: 'mm-pctval ' + m1dir }, React.createElement(Arrow, { dir: m1dir }), fmtPct(m1))),
      React.createElement('div', { className: 'mm-c mm-c-ytd ' + ytdDir },
        React.createElement('span', { className: 'mm-c-label' }, 'Year to date'),
        React.createElement('span', { className: 'mm-ytd-val ' + ytdDir }, React.createElement(Arrow, { dir: ytdDir }), fmtPct(ytd))));
  }

  function TableHead({ slot }) {
    return React.createElement('div', { className: 'mm-thead' },
      React.createElement('div', { className: 'mm-th' }, 'Market moves at ' + slot.headLabel),
      React.createElement('div', { className: 'mm-th r' }, 'Price'),
      React.createElement('div', { className: 'mm-th' }, '24h'),
      React.createElement('div', { className: 'mm-th c mm-th-1m' }, '1 Month'),
      React.createElement('div', { className: 'mm-th c mm-th-ytd' }, 'Year to date'));
  }

  /* ---- one snapshot card ---- */
  function SnapshotCard({ slot, showToast }) {
    const { usePngExport } = M;
    const panelRef = useRef(null);
    const busyRef = useRef(false);

    const initialKey = targetKeyForSlot(slot);
    const seed = readSnap(slot, initialKey);
    const [dateKey, setDateKey] = useState(initialKey);
    const [snap, setSnap] = useState(() =>
      seed ? { status: 'frozen', data: seed.data } : { status: 'loading', data: null });

    const { exporting, exportPng } = usePngExport(panelRef, 'dm-market-moves-' + slot.id, showToast);

    /* Ensure the snapshot for `key` exists.
       Priority: server file (authoritative) → stored copy → browser fallback. */
    const ensure = useCallback((key) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setDateKey(key);

      const stored = readSnap(slot, key);
      if (stored) setSnap({ status: 'frozen', data: stored.data });
      else setSnap((s) => (s.data ? s : { status: 'loading', data: null }));

      loadServer().then((srv) => {
        const slotSrv = srv && srv[slot.id];
        if (slotSrv && slotSrv.date === key && slotSrv.data) {
          busyRef.current = false;
          const ts = Date.parse(slotSrv.capturedAt) || Date.now();
          writeSnap(slot, key, slotSrv.data, ts);
          setSnap({ status: 'frozen', data: slotSrv.data });
          return;
        }
        if (stored) { busyRef.current = false; return; }
        /* No server value for this exact slot/date yet → capture in-browser once. */
        fetchAll().then(({ data, hits }) => {
          busyRef.current = false;
          if (hits > 0) {
            writeSnap(slot, key, data, Date.now());
            setSnap({ status: 'frozen', data });
          } else {
            setSnap({ status: 'nodata', data: null });
          }
        });
      });
    }, [slot]);

    useEffect(() => {
      ensure(targetKeyForSlot(slot));
      /* re-check every minute so a page left open rolls to the next slot */
      const id = setInterval(() => {
        const k = targetKeyForSlot(slot);
        if (k !== dateKey) { serverPromise = null; ensure(k); }
      }, 60 * 1000);
      return () => clearInterval(id);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slot, dateKey, ensure]);

    const pill = snap.status === 'frozen'
      ? { cls: 'cached', label: 'Frozen · won\u2019t change' }
      : snap.status === 'nodata'
        ? { cls: 'nodata', label: 'No data available' }
        : { cls: 'partial', label: 'Capturing\u2026' };

    return React.createElement('div', { className: 'mm-block', 'data-screen-label': slot.period + ' — Market Moves' },
      React.createElement('div', { className: 'mm-blockbar' },
        React.createElement('div', { className: 'mm-blockbar-left mm-snaphead' },
          React.createElement('span', { className: 'mm-block-eyebrow' }, slot.period),
          React.createElement('div', { className: 'mm-snapmeta' },
            React.createElement('span', { className: 'mm-snaptime' }, 'Updated ' + slot.timeLabel),
            React.createElement('span', { className: 'mm-snapdot' }, '\u00B7'),
            React.createElement('span', { className: 'mm-snapdate' }, fmtDateKey(dateKey)),
            React.createElement('span', { className: 'mm-snaptz' }, 'SAST')),
          React.createElement('span', { className: 'mm-pill ' + pill.cls },
            React.createElement('span', { className: 'dot' }), pill.label)),
        React.createElement('div', { className: 'mm-blockbar-right' },
          React.createElement('button', { className: 'mm-btn mm-btn-primary', type: 'button', onClick: exportPng, disabled: exporting },
            React.createElement('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2.4', strokeLinecap: 'round', strokeLinejoin: 'round' },
              React.createElement('path', { d: 'M12 3v12' }),
              React.createElement('path', { d: 'M7 10l5 5 5-5' }),
              React.createElement('path', { d: 'M5 21h14' })),
            exporting ? 'Exporting\u2026' : 'Export PNG'))),
      React.createElement('div', { className: 'mm-panel mm-panel-bare', ref: panelRef },
        React.createElement('div', { className: 'mm-table' },
          React.createElement(TableHead, { slot }),
          INSTRUMENTS.map((inst) => React.createElement(MarketRow, {
            key: inst.key, inst,
            d: snap.status === 'loading' ? undefined : (snap.data ? snap.data[inst.key] : null),
          })))));
  }

  function App() {
    const { useAssets } = M;
    useAssets();

    const [toast, setToast] = useState(null);
    const toastTimer = useRef(null);
    const showToast = useCallback((msg) => {
      setToast(msg);
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 2600);
    }, []);

    return React.createElement('div', { className: 'mm' },
      React.createElement('div', { className: 'mm-bar' },
        React.createElement('div', { className: 'mm-kicker' }, 'Business Maverick \u00B7 Markets'),
        React.createElement('p', { className: 'mm-lede' },
          'Two market snapshots a day, frozen the moment they are taken \u2014 ',
          React.createElement('b', null, '05:30'), ' and ', React.createElement('b', null, '17:00'), ' SAST. ',
          'Prices don\u2019t move once captured, so a late riser still sees the exact morning numbers.')),

      SLOTS.map((slot) => React.createElement(SnapshotCard, { key: slot.id, slot, showToast })),

      React.createElement('footer', { className: 'mm-foot' },
        React.createElement('p', null,
          'Each card is a fixed snapshot of the market at its time slot; values are captured on a schedule at 05:30 and 17:00 SAST and held until the next capture. Where a source is unavailable the figure is shown as a dash rather than an estimate.'),
        React.createElement('p', { className: 'mm-foot-meta' }, 'Daily Maverick \u00A9 All rights reserved')),

      toast && React.createElement('div', { className: 'mm-toast', role: 'status' }, toast));
  }

  ReactDOM.createRoot(document.getElementById('mm-root')).render(React.createElement(App));
})();
