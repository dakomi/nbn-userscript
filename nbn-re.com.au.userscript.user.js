// ==UserScript==
// @name         NBN quick badges (LukePrior repo) — realestate.com.au
// @namespace    https://github.com/dakomi/nbn-userscript
// @version      0.2
// @description  Inject NBN connection-type badges into realestate.com.au search results using per-suburb GeoJSON files from LukePrior/nbn-upgrade-map (cached in IndexedDB). Focused on suburb->address-level data supplied in the repo. Adaptable to other sites later.
// @author       dakomi
// @match        https://www.realestate.com.au/*
// @grant        GM_addStyle
// @connect      raw.githubusercontent.com
// ==/UserScript==

/*
What this script does (high level)
- For each listing card on realestate.com.au search results, extract the displayed suburb/state from the listing DOM (not the page URL).
- Fetch the corresponding suburb GeoJSON from LukePrior/nbn-upgrade-map (raw.githubusercontent.com) and cache it in IndexedDB.
- Summarise address-level connection types in that suburb and insert a concise colored badge into the listing.
- Clicking the badge shows a small popup with counts per type and links to view the raw suburb file or refresh cache.
- Concurrency, caching and filename normalization are implemented for robustness.

Notes:
- Suburb filenames in the repo are lowercase, hyphenated (e.g. "acacia-ridge.geojson"). The script attempts multiple slug forms.
- The script uses the repo snapshot (not live NBN API). This is Approach 2 as requested.
- You may need to tweak DOM selectors if realestate.com.au changes markup.
*/

(function () {
  'use strict';

  // Config
  const REPO_RAW_BASE = 'https://raw.githubusercontent.com/LukePrior/nbn-upgrade-map/main/results';
  const CACHE_DB = 'nbnRepoCache_v1';
  const CACHE_STORE = 'suburbs';
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const MAX_CONCURRENT_FETCHES = 4;

  // Legend mapping: connection type token -> { color, label, description }
  // These are modelled after the map legend in the repo README; adjust as needed.
  const LEGEND = {
    'FTTP': { color: '#1f7a1f', label: 'FTTP', desc: 'Address already has FTTP technology, or has been upgraded to FTTP' }, // dark green
    'FTTN': { color: '#f97316', label: 'FTTN', desc: 'Fibre to the node (copper last mile)' }, // orange
    'FTTC': { color: '#f59e0b', label: 'FTTC', desc: 'Fibre to the curb (short copper lead-in)' }, // amber
    'HFC': { color: '#7c3aed', label: 'HFC', desc: 'Hybrid Fibre Coaxial (cable)' }, // purple
    'FTTB': { color: '#0ea5a0', label: 'FTTB', desc: 'Fibre to the building' }, // teal
    'Fixed Wireless': { color: '#2563eb', label: 'Fixed Wireless', desc: 'Fixed wireless service' }, // blue
    'Satellite': { color: '#374151', label: 'Satellite', desc: 'Satellite service' }, // gray
    'Non-NBN': { color: '#6b7280', label: 'Non-NBN/Unknown', desc: 'No NBN service or unknown technology' } // neutral
  };

  // Listing selector heuristics for realestate.com.au (covers typical card structures)
  const LISTING_SELECTORS = [
    '[data-testid="result-card"]',
    '.tier-card',
    '.residential-card',
    '.residential-card__content',
    '.listingCard',
    '.residential-card__body',
    '.residentialCard_wrapper'
  ];

  // Candidate elements within a card that often have suburb/state text
  const SUBURB_CANDIDATES = [
    '.listingCardDetails',
    '.listingCard__details',
    '.propertyCardDetails',
    '.residential-card__location',
    '.property-location',
    'address',
    '.property-info',
    '.property-card__info',
    '.card__info'
  ];

  // Utility: promisify IDB open/get/put
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CACHE_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(CACHE_STORE)) {
          db.createObjectStore(CACHE_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, 'readonly');
      const store = tx.objectStore(CACHE_STORE);
      const req = store.get(key);
      req.onsuccess = () => { resolve(req.result); db.close(); };
      req.onerror = () => { reject(req.error); db.close(); };
    });
  }
  async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, 'readwrite');
      const store = tx.objectStore(CACHE_STORE);
      const req = store.put(value, key);
      req.onsuccess = () => { resolve(req.result); db.close(); };
      req.onerror = () => { reject(req.error); db.close(); };
    });
  }

  // Concurrency queue for fetches
  let active = 0;
  const queue = [];
  function enqueue(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      processQueue();
    });
  }
  function processQueue() {
    if (active >= MAX_CONCURRENT_FETCHES) return;
    const item = queue.shift();
    if (!item) return;
    active++;
    item.fn().then(item.resolve).catch(item.reject).finally(() => {
      active--;
      processQueue();
    });
  }

  // Normalize suburb to likely repo filename: lowercase, spaces -> '-', strip punctuation, simple diacritics removal
  function toRepoSlug(name) {
    if (!name) return '';
    // Remove newline and surrounding whitespace
    name = name.trim().toLowerCase();
    // Replace & with 'and'
    name = name.replace(/&/g, 'and');
    // normalize diacritics
    name = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    // remove anything that's not letter, number, space or dash
    name = name.replace(/[^a-z0-9\s-]/g, '');
    // collapse spaces
    name = name.replace(/\s+/g, '-');
    // collapse multiple dashes
    name = name.replace(/-+/g, '-');
    return name;
  }

  // Try likely candidate filenames for a suburb
  function candidateFilenames(suburb, state) {
    const s = suburb || '';
    const slug = toRepoSlug(s);
    // repo uses uppercase state folder names: QLD, NSW etc.
    const st = (state || '').toUpperCase();
    const names = [
      `${st}/${slug}.geojson`,
      `${st}/${encodeURIComponent(s)}.geojson`,
      `${st}/${slug.replace(/-/g, '_')}.geojson`,
      `${st}/${s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g,'')}.geojson`
    ];
    // uniq
    return Array.from(new Set(names));
  }

  // Fetch suburb GeoJSON (with cache & TTL). Returns parsed JSON or throws.
  async function fetchSuburbGeoJSON(suburb, state, force = false) {
    const key = `${state}|${toRepoSlug(suburb)}`;
    try {
      const cached = await idbGet(key);
      if (cached && !force) {
        const age = Date.now() - (cached.fetchedAt || 0);
        // If repo file contains generated date inside cached.data.generated we can rely on that too.
        if (age < CACHE_TTL_MS) return cached.data;
      }
    } catch (e) {
      console.warn('NBN cache read error', e);
    }

    const candidates = candidateFilenames(suburb, state).map(p => `${REPO_RAW_BASE}/${p}`);
    // try each candidate until success
    const tryFetch = async () => {
      let lastErr = null;
      for (const url of candidates) {
        try {
          const res = await fetch(url);
          if (!res.ok) {
            lastErr = new Error(`HTTP ${res.status} for ${url}`);
            continue;
          }
          const text = await res.text();
          const data = JSON.parse(text);
          // store cache
          const cachedObj = { fetchedAt: Date.now(), generatedAt: data.generated || data.generated_at || null, source: url, data };
          try { await idbSet(key, cachedObj); } catch (e) { console.warn('NBN cache set error', e); }
          return data;
        } catch (err) {
          lastErr = err;
          continue;
        }
      }
      throw lastErr || new Error('No candidate returned');
    };

    return enqueue(tryFetch);
  }

  // Heuristic: parse suburb and state from a listing element (search results card) using multiple strategies.
  function parseSuburbStateFromListing(cardEl) {
    // Try candidate nodes first (explicit location elements)
    for (const sel of SUBURB_CANDIDATES) {
      const node = cardEl.querySelector(sel);
      if (node && node.textContent && node.textContent.trim()) {
        const parsed = extractSuburbStateFromText(node.textContent);
        if (parsed) return parsed;
      }
    }
    // Fallback: search whole card text for patterns like "Chermside QLD 4032" or "Chermside, QLD"
    const text = cardEl.textContent || '';
    return extractSuburbStateFromText(text);
  }

  // Extract suburb/state from arbitrary text using regex patterns
  function extractSuburbStateFromText(text) {
    if (!text) return null;
    // Normalize whitespace
    const t = text.replace(/\s+/g, ' ').trim();
    // Pattern: "Suburb, QLD" or "Suburb QLD"
    const stateAbbr = '(NSW|VIC|QLD|SA|WA|TAS|ACT|NT)';
    const p1 = new RegExp('([A-Za-z\\-\\&\\\'\\.\\s]{2,60})[,\\s]+(' + stateAbbr + ')(?:\\s|$)', 'i');
    const m1 = t.match(p1);
    if (m1) {
      const suburb = m1[1].trim().replace(/[,|.]+$/,'');
      const state = m1[2].toUpperCase();
      return { suburb, state };
    }
    // Pattern with postcode: "Suburb 4032" (postcode is 4 digits). We'll treat suburb as preceding capitalized token
    const p2 = /([A-Za-z\-\&\'\s]{2,60})\s+(\d{4})/;
    const m2 = t.match(p2);
    if (m2) {
      const suburb = m2[1].trim();
      // For some pages we can derive state from search or leave state as '' to try all states
      return { suburb, state: '' };
    }
    return null;
  }

  // Summarize geojson features into counts per known type, and derive top types and sample addresses
  function summarizeGeoJSON(geojson) {
    const counts = {};
    const examples = {};
    if (!geojson || !Array.isArray(geojson.features)) return { counts, examples, total: 0 };
    for (const f of geojson.features) {
      const props = f.properties || {};
      // Candidate keys for technology/type/status
      const candidates = [
        props.nbn_technology,
        props.technology,
        props.connection_type,
        props.type,
        props.nbn_type,
        props.status,
        props.service_type,
        props.network
      ];
      let type = null;
      for (const c of candidates) {
        if (!c) continue;
        if (Array.isArray(c)) type = c.join(', ');
        else type = String(c);
        break;
      }
      // fallback: sometimes technology is encoded in a 'colour' or 'label' property
      if (!type) {
        if (props.preset) type = props.preset;
        else if (props.label) type = props.label;
        else type = 'Non-NBN';
      }
      // normalize common names
      type = normalizeTypeString(type);

      counts[type] = (counts[type] || 0) + 1;
      if (!examples[type]) {
        // attempt to get address text
        const address = props.full_address || props.address || props.premise_address || props.ADDRESS || props.addr || props.street_address || '';
        examples[type] = address || (f.geometry ? JSON.stringify(f.geometry) : '');
      }
    }
    const total = Object.values(counts).reduce((s, v) => s + v, 0);
    return { counts, examples, total };
  }

  // Normalize type strings into keys that match LEGEND when possible
  function normalizeTypeString(s) {
    if (!s) return 'Non-NBN';
    const t = String(s).toLowerCase();
    if (t.includes('fttp') || t.includes('fibre to the premises')) return 'FTTP';
    if (t.includes('fttn') || t.includes('fibre to the node')) return 'FTTN';
    if (t.includes('fttc') || t.includes('fibre to the curb')) return 'FTTC';
    if (t.includes('hfc') || t.includes('hybrid')) return 'HFC';
    if (t.includes('fttb') || t.includes('fibre to the building')) return 'FTTB';
    if (t.includes('fixed wireless') || t.includes('fixedwireless') || t.includes('fixed-wireless')) return 'Fixed Wireless';
    if (t.includes('satellite') || t.includes('sat')) return 'Satellite';
    if (t.includes('non') || t.includes('unknown') || t.includes('not') || t.includes('no nbn')) return 'Non-NBN';
    // fallback: capitalize first letters and use raw
    return s;
  }

  // UI helpers: style injection
  GM_addStyle(`
    .nbn-badge {
      display:inline-block;
      padding:3px 8px;
      border-radius:12px;
      color:#fff;
      font-weight:600;
      font-size:12px;
      margin-left:6px;
      cursor:pointer;
    }
    .nbn-popup {
      position: absolute;
      z-index: 9999999;
      background: #fff;
      color: #111;
      border: 1px solid #ddd;
      box-shadow: 0 8px 24px rgba(0,0,0,0.15);
      border-radius: 6px;
      padding: 8px 10px;
      min-width:220px;
      font-size:13px;
    }
    .nbn-popup .row { margin:4px 0; display:flex; justify-content:space-between; align-items:center; }
    .nbn-popup .type-dot { width:10px; height:10px; border-radius:50%; display:inline-block; margin-right:8px; vertical-align:middle; }
    .nbn-popup .small-link { color: #2563eb; text-decoration: underline; cursor:pointer; margin-left:8px; font-size:12px; }
    .nbn-legend {
      position: fixed;
      right: 12px;
      bottom: 12px;
      z-index: 9999999;
      background: rgba(255,255,255,0.95);
      padding:8px 10px;
      border-radius:8px;
      border:1px solid #e5e7eb;
      font-size:12px;
      color:#111;
      max-width:260px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.12);
    }
    .nbn-legend .legend-row { display:flex; gap:8px; align-items:center; margin:6px 0; }
    .nbn-legend .dot { width:12px; height:12px; border-radius:3px; display:inline-block; }
  `);

  // Create or reuse a small persistent legend in the corner
  function ensureLegend() {
    if (document.querySelector('.nbn-legend')) return;
    const box = document.createElement('div');
    box.className = 'nbn-legend';
    const title = document.createElement('div');
    title.style.fontWeight = '700';
    title.style.marginBottom = '6px';
    title.textContent = 'NBN badge legend';
    box.appendChild(title);
    for (const [k, v] of Object.entries(LEGEND)) {
      const row = document.createElement('div');
      row.className = 'legend-row';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = v.color;
      const label = document.createElement('div');
      label.style.flex = '1';
      label.textContent = `${v.label} — ${v.desc}`;
      row.appendChild(dot);
      row.appendChild(label);
      box.appendChild(row);
    }
    document.body.appendChild(box);
  }

  // Create badge DOM element for a listing given summary (counts)
  function makeBadgeElement(summary, suburb, state, sourceUrl) {
    const primaryType = selectPrimaryType(summary.counts);
    const legendEntry = LEGEND[primaryType] || { color: '#6b7280', label: primaryType || 'Unknown', desc: '' };
    const badge = document.createElement('span');
    badge.className = 'nbn-badge';
    badge.style.background = legendEntry.color;
    const total = summary.total || Object.values(summary.counts || {}).reduce((s,v)=>s+v,0);
    const labelText = legendEntry.label + (total ? ` (${total})` : '');
    badge.textContent = labelText;
    // attach metadata
    badge.dataset.suburb = suburb;
    badge.dataset.state = state;
    badge.dataset.source = sourceUrl || '';
    badge.title = `${legendEntry.label}: ${legendEntry.desc}`;
    // click -> show popup
    badge.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // remove any existing popups
      document.querySelectorAll('.nbn-popup').forEach(n=>n.remove());
      const popup = document.createElement('div');
      popup.className = 'nbn-popup';
      // position near badge
      const rect = badge.getBoundingClientRect();
      popup.style.top = `${window.scrollY + rect.bottom + 6}px`;
      popup.style.left = `${Math.min(window.scrollX + rect.left, window.innerWidth - 300)}px`;

      const title = document.createElement('div');
      title.style.fontWeight = '700';
      title.style.marginBottom = '6px';
      title.textContent = `${suburb || 'Unknown'} ${state || ''} — NBN summary`;
      popup.appendChild(title);

      if (summary.total === 0) {
        const n = document.createElement('div');
        n.textContent = 'No address data in suburb file.';
        popup.appendChild(n);
      } else {
        // show counts sorted desc
        const entries = Object.entries(summary.counts).sort((a,b)=>b[1]-a[1]);
        for (const [type, cnt] of entries) {
          const row = document.createElement('div');
          row.className = 'row';
          const left = document.createElement('div');
          const dot = document.createElement('span');
          dot.className = 'type-dot';
          dot.style.background = (LEGEND[type] && LEGEND[type].color) || '#6b7280';
          left.appendChild(dot);
          const txt = document.createElement('span');
          txt.textContent = ` ${type}`;
          left.appendChild(txt);
          const cntEl = document.createElement('div');
          cntEl.textContent = String(cnt);
          row.appendChild(left);
          row.appendChild(cntEl);
          popup.appendChild(row);
        }
        // sample addresses (first 3)
        const sampleTitle = document.createElement('div');
        sampleTitle.style.marginTop = '6px';
        sampleTitle.style.fontWeight = '700';
        sampleTitle.textContent = 'Example addresses';
        popup.appendChild(sampleTitle);
        const sampleList = document.createElement('div');
        let shown = 0;
        for (const [type, addr] of Object.entries(summary.examples || {})) {
          if (!addr) continue;
          const p = document.createElement('div');
          p.style.marginTop = '4px';
          p.textContent = `${type}: ${String(addr).slice(0,120)}`;
          sampleList.appendChild(p);
          shown++;
          if (shown >= 3) break;
        }
        if (shown === 0) {
          const p = document.createElement('div');
          p.textContent = 'No address text available.';
          sampleList.appendChild(p);
        }
        popup.appendChild(sampleList);
      }

      // actions: view raw, refresh
      const actions = document.createElement('div');
      actions.style.marginTop = '8px';
      actions.style.display = 'flex';
      actions.style.gap = '10px';
      const rawLink = document.createElement('a');
      rawLink.href = summary.source || badge.dataset.source || '';
      rawLink.target = '_blank';
      rawLink.className = 'small-link';
      rawLink.textContent = 'View source file';
      actions.appendChild(rawLink);

      const refresh = document.createElement('span');
      refresh.className = 'small-link';
      refresh.textContent = 'Refresh cache';
      refresh.style.cursor = 'pointer';
      refresh.addEventListener('click', async () => {
        refresh.textContent = 'Refreshing...';
        try {
          // force fetch and update badge/popup content (caller should manage updating UI)
          const dd = await fetchSuburbGeoJSON(badge.dataset.suburb, badge.dataset.state, true);
          const newSummary = summarizeGeoJSON(dd);
          // close popup and trigger a re-render by emitting an event
          popup.remove();
          const ev = new CustomEvent('nbn_suburb_refreshed', { detail: { suburb: badge.dataset.suburb, state: badge.dataset.state, summary: newSummary, source: dd } });
          window.dispatchEvent(ev);
        } catch (e) {
          refresh.textContent = 'Refresh failed';
          setTimeout(()=>refresh.textContent = 'Refresh cache', 1500);
        }
      });
      actions.appendChild(refresh);

      popup.appendChild(actions);

      document.body.appendChild(popup);

      // click outside to close
      const closer = (ev) => {
        if (!popup.contains(ev.target) && ev.target !== badge) {
          popup.remove();
          document.removeEventListener('click', closer, true);
        }
      };
      document.addEventListener('click', closer, true);
    });
    return badge;
  }

  function selectPrimaryType(counts) {
    if (!counts || Object.keys(counts).length === 0) return 'Non-NBN';
    const entries = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
    return entries[0][0];
  }

  // Process a single listing card element: get suburb/state, fetch geojson, summarise and inject badge
  const processed = new WeakSet();
  async function processCard(card) {
    if (processed.has(card)) return;
    processed.add(card);

    const parsed = parseSuburbStateFromListing(card);
    if (!parsed || !parsed.suburb) return;
    const suburb = parsed.suburb;
    const state = (parsed.state || '').toUpperCase();

    // attempt to append badge into the typical title/metadata area
    // choose an insertion target that visually fits: prefer first element with price or header, else card root
    const insertionCandidates = [
      '.listingCard__price', '.property-price', '.residential-card__header', '.detail-card__head', '.card__header', '.card__info', '.residential-card__content'
    ];
    let insertTarget = null;
    for (const sel of insertionCandidates) {
      const el = card.querySelector(sel);
      if (el) { insertTarget = el; break; }
    }
    if (!insertTarget) insertTarget = card;

    // fetch and summarise
    try {
      const geojson = await fetchSuburbGeoJSON(suburb, state);
      const summary = summarizeGeoJSON(geojson);
      // attach source url if available from cached object (we stored source when caching)
      const key = `${state}|${toRepoSlug(suburb)}`;
      let sourceUrl = '';
      try {
        const cached = await idbGet(key);
        if (cached && cached.source) sourceUrl = cached.source;
      } catch (e) { /* ignore */ }

      const badge = makeBadgeElement(summary, suburb, state, sourceUrl);
      // avoid multiple badges
      // place before the first link so it doesn't break layout
      insertTarget.appendChild(badge);

      // when refreshed externally, update badge text
      const onRefreshed = (ev) => {
        const d = ev.detail || {};
        if (d.suburb === suburb && d.state === state) {
          try {
            const newSummary = d.summary;
            badge.remove();
            const newBadge = makeBadgeElement(newSummary, suburb, state, d.source || sourceUrl);
            insertTarget.appendChild(newBadge);
          } catch (e) { /* ignore */ }
        }
      };
      window.addEventListener('nbn_suburb_refreshed', onRefreshed, { once: true });

    } catch (err) {
      // no suburb file or fetch failed: optionally add small gray badge 'NBN: unknown'
      const unknownBadge = document.createElement('span');
      unknownBadge.className = 'nbn-badge';
      unknownBadge.style.background = '#6b7280';
      unknownBadge.textContent = 'NBN: unknown';
      insertTarget.appendChild(unknownBadge);
    }
  }

  // Initial scan + MutationObserver to catch dynamically loaded results
  function initialScan() {
    ensureLegend();
    const cards = new Set();
    for (const sel of LISTING_SELECTORS) {
      document.querySelectorAll(sel).forEach(el => cards.add(el));
    }
    cards.forEach(card => processCard(card));
  }

  // Observe the results container and body for additions
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        // if the added node matches a listing selector or contains listings, process them
        for (const sel of LISTING_SELECTORS) {
          if (n.matches && n.matches(sel)) processCard(n);
          n.querySelectorAll && n.querySelectorAll(sel).forEach(el => processCard(el));
        }
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // run initial scan after small delay to allow page scripts to render
  setTimeout(initialScan, 1200);

  // Expose a small debug API on window for manual inspection
  window.__nbn_repo_userscript = {
    fetchSuburbGeoJSON,
    summarizeGeoJSON,
    toRepoSlug,
    candidateFilenames
  };

})();