# SENTINEL — Progress Log

## Session: 2026-07-02 — Conflictly-class rebuild (3D globe → 2D tactical map)

Full rewrite of `index.html`. Removed all Three.js code and replaced the 3D
globe with a MapLibre GL JS 2D tactical map (dark-matter/CARTO style, no API
key). Everything below was built, then verified in a real headless browser —
first against mocked `/api/*` responses to test UI mechanics in isolation,
then against a local shim that mounts the actual `api/*.js` handlers (bypassing
the need for a Vercel account) to confirm the whole live pipeline — real
Guardian/GDELT/RSS news → real threat extraction → real map rendering — works
end to end with zero console/page errors. Screenshot review confirmed correct
visual output (country risk fill, clustered markers, ticker, layer panel, stat
bar all rendering live data correctly).

### PART 1 — Map engine
- MapLibre GL JS 4.7.1 (`unpkg.com/maplibre-gl@4.7.1`), CARTO `dark-matter-gl-style`
  basemap, both free/no-key. Centered `[20,30]` zoom 2.2, `dragRotate:false`,
  touch rotation disabled. `NavigationControl` (zoom only, no compass) bottom-right
  so it doesn't collide with the country panel (top-right) or layer panel (top-left).

### PART 2 — Country borders + risk highlighting
- Loads `datasets/geo-countries` GeoJSON (258 features, ~14.6MB) once, as a
  `fill` + `line` layer with `generateId:true` for feature-state hover.
- **Found two real data-quality issues in this free dataset** and patched them
  client-side so the rest of the app's country-code conventions stay consistent:
  France's `ISO3166-1-Alpha-2` is literally the string `"-99"` (a Natural-Earth
  "no data" sentinel — 22 features have this, most are disputed territories
  that don't matter here, but France is a named leader/alliance country in this
  app) and Taiwan is coded `CN-TW` instead of `TW` (which is what `api/threats.js`,
  `api/analyze.js`, and `api/entities.js` already use everywhere else). Fixed via
  a small `GEOJSON_CODE_FIXES` name→code map applied right after fetch.
- Fill color is a live `['match', ['get','ISO_A2'], ...]` expression rebuilt
  every time `/api/threats` returns: worst severity per country →
  CRITICAL `rgba(255,0,34,.20)` / HIGH `rgba(255,102,0,.15)` / MEDIUM
  `rgba(255,204,0,.08)`, transparent otherwise. (Live data currently only ever
  produces HIGH/MEDIUM/LOW — CRITICAL styling is wired but unused until the
  backend ever emits it.)
- Hover brightens border to `#00c8f0` via `feature-state`, shows a name tooltip.
- Click calls the existing `showCountryIntel(code)` (kept from the prior
  session, still does live Wikidata leader lookup + REST-Countries-then-
  `/api/country`-fallback — see last session's PROGRESS entry for why REST
  Countries' free tier is dead).

### PART 3 — Threat markers (from live `/api/threats` only)
- Custom HTML markers (`maplibregl.Marker`) — colored/sized dot by severity
  with a CSS `@keyframes` pulsing ring (no per-frame JS needed, unlike the old
  Three.js ring animation), icon by type (⚔ conflict, ☢ nuclear, 💻 cyber,
  ✈ military, 🌊 maritime, 🔥 disaster — `maritime` and `disaster` are wired
  but `api/threats.js`'s `inferType()` doesn't currently emit them; harmless,
  just unused icon slots).
- Click → `maplibregl.Popup` with title/severity/country/description/risk
  score/source link, `map.flyTo(zoom:4.5)`.
- **Clustering implemented from scratch** (no Supercluster/extra dependency,
  per the "MapLibre GL JS only" rule) — groups markers by rounding their
  projected screen position to a 55px grid cell, re-run on every `moveend`.
  Verified live: 4 close-together Levant threats collapsed into one cluster
  badge at world zoom (2.2), then fully separated into 5 individual markers
  after zooming to 7 centered on the same area.

### PART 4 — Military assets (semi-static — rule explicitly allows this)
- 24 real, publicly-documented positions: naval fleets/carrier presences,
  major air bases, declared nuclear/missile sites, NATO Eastern-Europe forward
  positions, plus a couple of Chinese/Russian counterparts for balance.
  Color-coded by affiliation (NATO/US blue, Russia red, China orange, other
  grey). Hidden by default (`☐ Military Assets`), toggled via the layer panel.

### PART 5 — Conflict frontlines + tension zones (approximated, per rules)
- One GeoJSON source, `line`-filtered for the Ukraine frontline (Kharkiv →
  Donetsk → Zaporizhzhia → Kherson, red dashed) and `fill`-filtered for Gaza,
  Red Sea shipping corridor, and Taiwan Strait tension polygons. Opacity
  pulses via a `setInterval` driving `setPaintProperty` (MapLibre has no
  built-in paint-property animation, this is the standard workaround).

### PART 6 — Top ticker
- Scrolling headline bar fed from `liveArticles` (from `/api/news`), doubled
  in the DOM for a seamless CSS `translateX` loop, pauses on hover.
  `threatScore >= 80` → red/bold "critical" styling (no explicit CRITICAL tag
  exists on articles, so this threshold is the closest live signal, consistent
  with thresholds already used elsewhere in this file, e.g. the old `>85`
  BREAKING-badge logic and the `>70` "hi" news-score class).
  Click → tries to infer a location from the headline text via a small
  client-side pattern table (`TICKER_LOC_PATTERNS`) and flies there; falls
  back to opening the article URL if no location matches. Verified live: a
  Kharkiv/Ukraine headline correctly flew the map to `[32,49]` zoom ~4.5.

### PART 7 — Sidebar (kept, ported to the new map)
- All 8 original tabs (Briefing, Warnings, Analytics, Intel Map, Conflicts,
  Forecast, Leaders, Mideast) kept with identical rendering logic — only the
  `flyTo(lat,lon)` implementation changed (now `map.flyTo` instead of
  Three.js rotation math), and the `apiGet('/api/...')` /
  `apiPost('/api/...')` double-prefix bug flagged in the previous session's
  PROGRESS entry (`/api` + `/api/acled` = `/api/api/acled`, a real 404 in
  production) is now fixed for `acled`, `forecast`, and `entities` since this
  was a full rewrite touching every call site anyway.
- **Added a Weather tab** (Open-Meteo geocoding + forecast, free/no-key):
  this tab was extensively documented in the PROGRESS.md this session
  inherited from a merge (a prior remote session had built it) but was not
  actually present in the `index.html` this session started from (that
  session's `index.html` changes were superseded during an earlier merge that
  kept the local globe-fix version). Since this session's instructions
  explicitly listed Weather as an "existing" tab to preserve, it's been
  (re)implemented per that spec: city search → current conditions + 7-day
  forecast cards with WMO weather-code icons, flies the map to the searched
  city on success. Verified live against the real Open-Meteo API (Tokyo
  search returned real current + 7-day data).
- Tab bar grid changed from `repeat(4,1fr)` (8 tabs, 2 rows) to `repeat(3,1fr)`
  (9 tabs, exactly 3 rows) to fit the new Weather tab.

### PART 8 — UI polish
- Global risk index (`#sri`) gets a red `pulse-critical` CSS animation when
  `globalRiskIndex > 70` (verified live: real current risk index of 74
  triggered the pulse class).
- Left-side floating `#layer-panel` (checkboxes: Threats/Conflict
  Zones/Military Assets/Country Risk) rather than a literal new grid column —
  kept the existing single-sidebar grid layout intact (lower regression risk,
  and functionally equivalent to "left sidebar" as an overlay on the map's
  left edge, matching how the old `#layers` panel already worked on the right).
- Popups, tooltips, and MapLibre's own controls (attribution, zoom buttons)
  re-themed to match the existing dark/cyan/red palette via scoped CSS
  overrides on `.maplibregl-*` classes.

### Testing performed
- Static: `node --check` on the extracted script block (valid syntax).
- Playwright against mocked `/api/*`: page-load with zero console/page errors;
  marker click → popup + flyTo zoom 4.5; country hover → tooltip + border
  highlight (confirmed on a fresh, non-chained page load after an earlier
  chained-test run gave a false negative from a leftover popup DOM
  intercepting the synthetic mouse hover — a test-harness artifact, not an
  app bug); country click → intel panel populates via the REST-Countries→
  `/api/country` fallback chain; all 4 layer-panel toggles verified to
  actually hide/show their respective map layers; all 9 tabs cycle without
  error; clustering verified to merge/split correctly across a zoom change;
  ticker renders, critical-highlights, and click-flies correctly.
- Playwright against a local Node shim that mounts the real `api/*.js`
  handlers directly (no Vercel account available in this environment) with
  zero mocking: confirmed the real Guardian/GDELT/RSS pipeline, real threat
  extraction/geolocation, real country-risk coloring, and real Wikidata/
  Open-Meteo calls all work together end-to-end. Screenshot-reviewed the
  result — correct rendering of everything above with live current headlines
  (Ukraine/Kyiv strikes, Pakistan, Yemen/Red Sea, etc.).
- Not tested: an actual Vercel deployment (no account access in this
  environment) — the local shim's only deviation from production is that
  `api/threats.js`'s internal self-fetch defaults to `https://` and needed an
  `x-forwarded-proto: http` header forced in to work against plain-HTTP
  localhost; this does not apply to the real Vercel deployment, which always
  terminates TLS and sets that header correctly itself.

### Known issue found but left out of scope
Still true from last session and unrelated to this rewrite: none currently
outstanding — the `/api/api/*` double-prefix bug flagged previously is now
fixed as part of this full rewrite (see Part 7 above).
