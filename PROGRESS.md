### Current session — Data-driven globe implementation

**✅ Intelligence globe rebuild (June 30, 2026):**
- Rewrote [index.html](index.html) completely as one clean HTML file with one script block and one Three.js import.
- Upgraded globe base texture to cloudless, country-visible map:
  - `https://raw.githubusercontent.com/turban/webgl-earth/master/images/2_no_clouds_4k.jpg`
- Implemented live GeoJSON country border rendering on the globe:
  - Fetches Natural Earth country polygons from datasets/geo-countries.
  - Draws border lines using `ll2v3(lat, lon, GR + 0.001)` and `THREE.LineBasicMaterial`.
- Added rotating country click zones (attached to `globeMesh`), preserving country intel interactions.

**✅ Live threat visualization pipeline (no hardcoded coordinates):**
- `loadThreats()` now fetches only `/api/threats` data.
- For each threat with numeric lat/lon:
  - Adds glowing sphere marker.
  - Adds pulsing ring marker (animated each frame in `animate()`).
- Added `heatZones` top-level array and conflict heat overlays for `HIGH` / `CRITICAL` threats.
- Marker hover raycast now shows tooltip with:
  - title
  - severity badge
  - country
  - risk score
  - description

**✅ Weather tab added:**
- New sidebar tab: `🌤 WEATHER`.
- Search workflow implemented with free Open-Meteo APIs:
  - geocoding endpoint to resolve city -> lat/lon
  - forecast endpoint for current + 7-day daily forecast
- Displays:
  - city and country
  - current temperature
  - feels like
  - humidity
  - wind speed
  - weather condition text mapped from `weather_code`
  - 7-day cards with weekday, emoji condition icon, min/max temps
- On successful city lookup, globe flies to that location via `flyTo(lat, lon)`.

**✅ Stability and path checks:**
- No duplicate script blocks remain.
- No `data-duplicate-block="disabled"` block remains.
- No `/api/api/*` path usage remains.
- Diagnostics check for [index.html](index.html): no errors.
- Live endpoint sanity check on shared browser page:
  - `/api/news?type=world` -> `200`, articles returned
  - `/api/threats` -> `200`, threats returned

**✅ Latest stabilization pass (June 30, 2026):**
- Rewrote [index.html](index.html) as a single clean document to eliminate persistent mixed-state corruption from duplicated blocks.
- Fixed runtime crash `TypeError: Cannot read properties of null (reading 'addEventListener')` by using null-safe event binding helper:
  - `const el = document.getElementById('...'); if (el) el.addEventListener(...)`
  - Applied to toolbar button bindings (`briefbtn`, `alertbtn`) and preserved existing tab/layer behavior.
- Removed duplicate-script condition entirely:
  - Exactly one Three.js CDN import remains.
  - Removed disabled duplicate script pattern (`data-duplicate-block="disabled"`) by replacing file with a clean single-script implementation.
- Verified API paths are correct:
  - Uses `const API = '/api'`
  - Calls `/news?type=world` and `/threats` via `apiGet(API + path)`
  - No `/api/api/*` paths remain.
- Result:
  - No diagnostics errors in [index.html](index.html).
  - Globe initialization and Earth texture loader are restored in the rewritten script.
  - Stats widgets are wired to live API payloads from `/api/news` and `/api/threats`.

**✅ Bug Fixes:**
- Fixed syntax error in [index.html](index.html#L740): Removed duplicate unquoted `N.KOREA` property in actorCode object literal
  - Was: `...,TAIWAN:'TW','N.KOREA':'KP',N.KOREA:'KP',SAUDI:'SA'...`
  - Fixed: `...,TAIWAN:'TW','N.KOREA':'KP',SAUDI:'SA'...`
  - Issue: Unquoted property name with dot separator caused "missing : after property id" error
- **Fixed "Cannot redeclare block-scoped variable" errors** (38 errors total):
  - Root cause: Complete HTML/CSS/JavaScript block duplication in index.html (entire file was present twice)
  - First complete version: lines 1-1342 (correct, functional code)
  - Duplicate copy: lines 1343+ (identical duplicate causing variable redeclaration)
  - Solution: Removed entire duplicate block, truncated file to 1342 lines
  - **Verification after fix:**
    - `const API`: 1 match ✓
    - `let scene,camera,renderer`: 1 match ✓
    - `function initGlobe()`: 1 match ✓
    - `function animate()`: 1 match ✓
    - `</html>`: 1 match ✓
  - All 38 redeclaration errors resolved

**✅ Completed:**
- **api/threats.js full rewrite**: Replaces old hardcoded coordinates with live country extraction from news headlines using comprehensive pattern matching (30+ countries, 200+ keywords). Every threat marker on the globe originates from an actual news article.
  - Country coordinate database: UA→49.0°N/32.0°E, RU→56.0°N/38.0°E, PS→31.45°N/34.4°E, etc.
  - Pattern matching: ['ukraine','kyiv','kharkiv'] → UA, ['gaza','palestine'] → PS, ['russia','moscow'] → RU, etc.
  - Built threat object includes: title, lat, lon, country code, severity, riskScore, type, description, timestamp
  
- **Frontend threat rendering**: index.html already correctly implements the data flow:
  - `loadThreats()` calls `/api/threats` 
  - Populates `liveThreats[]` array with live-extracted threats
  - `redrawThreatVisuals()` clusters events within 300km and places markers
  - Heat zones only appear for HIGH severity threats
  - All markers have real lat/lon from live articles (no hardcoding)

- **GeoJSON borders**: Already working in index.html:
  - Loads from `https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson`
  - Draws as THREE.Line objects with country codes
  - Risk-based coloring: red for threat>70, orange for 45-70, blue default
  - Falls back to grid lines if GeoJSON fetch fails

- **No hardcoded coordinates remaining**: 
  - Threats: all extracted from news + country database
  - Conflicts: driven by liveConflicts array from ACLED API
  - Heat zones: only placed where HIGH severity threats exist

**Data flow (now fully live-driven):**
```
Live headlines → news.js (multi-source) 
  ↓
/api/news returns articles with title+summary+threatScore
  ↓
/api/threats extracts country codes using pattern matching
  ↓
Looks up country coords in COUNTRY_COORDS database
  ↓
Returns threat events with real lat/lon
  ↓
Frontend places markers + heat zones on globe at those coordinates
  ↓
GeoJSON borders render on top (already working)
```

**Testing ready:**
- Deploy latest commit
- Visit https://project-j217o.vercel.app/
- Threats tab should show live markers at real coordinates
- Click on warnings to fly to live locations
- Cluster markers show count and expand on click
- Heat zones pulse at HIGH severity locations only
- Country borders color by risk level

---

### Last session (prior)
- Ran full production tab test on https://project-j217o.vercel.app/ and documented exact broken states.
- Captured concrete runtime failures in deployed build:
	- Console/network: `Failed to load resource: the server responded with a status of 405 ()`
	- Request failure: `POST request to https://project-j217o.vercel.app/api/api/entities failed: net::ERR_ABORTED`
	- Conflicts tab: `Conflict data unavailable: Unexpected token '<', "`
	- Forecast tab: `Forecast unavailable: Unexpected token '<', "`
- Root cause identified: frontend was requesting wrong endpoint paths (`/api/api/*`), causing HTML responses to be parsed as JSON.
- Rewrote `api/analyze.js` fully to remove static hardcoded fallback blocks and generate dynamic outputs from live headlines when AI key is missing:
	- dynamic brief generation
	- dynamic correlation patterns
	- dynamic warning extraction with coordinates
	- dynamic actor graph + links
	- dynamic entity extraction
- Rewrote `api/threats.js` fully so warnings/markers are generated from live `/api/news` headlines, not static baseline events.
- Kept and verified `api/news.js` multi-source design with ME filtering logic for Middle East feed relevance.

- What works now
- Analytics no longer depends on static fallback text when AI key is missing; it derives patterns from current headline content.
- Threats endpoint now emits live-news-derived warning markers with inferred geolocation/risk.
- Brief generation path can produce a headline-driven brief without static template fallback.
- Intel map data generation is now driven from detected live actor mentions when AI is unavailable.
- Middle East feed logic uses live news with topic filter rather than unfiltered world stream.

- What broke / known issues
- Live production site currently still shows old behavior until the new code is deployed.
- Workspace is mounted as virtual GitHub filesystem; no local git repo was detected for direct commit from this environment.
- No automated browser smoke test exists yet to catch `/api/api/*` regressions before deploy.

### Current state
- Features working ✅
- Dynamic analysis engine from live headlines (`brief`, `correlations`, `warnings`, `actors`, `entities`).
- Dynamic threats endpoint based on current news feed.
- Multi-source news ingestion with dedupe and threat scoring.
- Correct endpoint usage in local `index.html` for conflicts/forecast/entities paths.

- Features broken ❌
- Deployed production URL still serving previous commit/build (shows `/api/api/*` behavior) until redeployed.

- Features missing 🔲
- CI/browser smoke tests that open each tab and verify non-error content.
- Deployment health gate that fails release when any tab shows parse/network errors.
- Structured logging for per-endpoint response shape (JSON vs HTML) checks.

### June 30, 2026 — Interaction and visibility hardening pass

**Completed full [index.html](index.html) rewrite (single script/import, clean file) for 7 requested fixes:**

- Globe click vs drag behavior fixed:
  - Added `mouseDownPos` tracking and drag threshold logic.
  - Click actions now run only when pointer movement is `<= 5px`.
  - Dragging no longer triggers marker/country click actions.

- Marker click fly-to smoothing:
  - Added `beginFlyTo(lat, lon)` with smooth lerp progression through `flyState`.
  - `autoRot = false` while flying.
  - Marker clicks and warning-row clicks both use smooth fly-to.

- Country borders made clearly visible:
  - Border color changed to `#2a6aaa` (`0x2a6aaa`), opacity `1.0`.
  - Border rendering changed from `THREE.Line` to `THREE.LineSegments`.

- Conflict heat zones made obvious:
  - `CRITICAL`: radius `0.22`, opacity `0.25`, color `#ff0022`.
  - `HIGH`: radius `0.16`, opacity `0.18`, color `#ff6600`.
  - Additive blending and animated pulse retained for visibility.

- Marker size increased:
  - `CRITICAL`: `0.05`
  - `HIGH`: `0.04`
  - `MEDIUM`: `0.03`
  - Pulse rings scaled to roughly 2x marker size.

- Briefing tab content upgraded:
  - Uses live `/api/news?type=world` data.
  - Each article row now shows severity tag, headline, source, and time ago.
  - `CRITICAL`/`HIGH` rows get red left border and bolder headline styling.
  - `BREAKING` badge added when `threatScore > 85`.

- Warnings tab now renders all live threats from `/api/threats`:
  - Each row shows flag, country, severity badge, title, and risk bar.
  - Clicking warning row smoothly flies globe to threat coordinates.

### Next session priorities
- Priority 1
- Deploy latest commit and re-run full live tab audit on production; verify no tab shows `Unexpected token '<'` or request failures.

- Priority 2
- Add automated tab smoke tests (Briefing, Warnings, Analytics, Intel Map, Conflicts, Forecast, Leaders, Mideast) in CI.

- Priority 3
- Add endpoint contract checks to ensure API routes always return JSON and detect HTML fallback/routing regressions immediately.
