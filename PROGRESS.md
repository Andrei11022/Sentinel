# SENTINEL — Progress Log

## Session: 2026-07-02 (4) — Fix: Intel Search returning HTML instead of JSON

### Bug
Intel Search threw `Unexpected token '<'` — the frontend tries to
`JSON.parse` the response from `/api/search`, and got HTML back instead.

### Root cause
`vercel.json` uses an **explicit routes array**, not Vercel's default
filesystem-based routing — every other endpoint (`/api/news`, `/api/country`,
etc.) has its own `{ "src": ..., "dest": ... }` entry, and the last entry is
a catch-all (`{ "src": "/(.*)", "dest": "/index.html" }`). `api/search.js`
was added in the previous session but its route was never added to this
list. Any request to `/api/search` therefore matched the catch-all instead
and got served `index.html` — hence the leading `<` that broke `JSON.parse`.

Checked the other two things the task suspected and both were already
correct, so this was the only fix needed:
- `api/search.js` already uses `module.exports = async function handler(req, res)`,
  same as every working endpoint — not an `export default` mismatch.
- The frontend already calls `apiGet('/search?q='+encodeURIComponent(q))`,
  a GET request with a query string, which matches `search.js` reading
  `req.query.q` — not a GET/POST mismatch, and no `/api/api/` double-prefix.

### Fix
One line added to `vercel.json`:
```json
{ "src": "/api/search", "dest": "/api/search.js" }
```

### Testing performed
Reproduced the exact bug before fixing it, rather than assuming the
diagnosis: built a small local server that parses `vercel.json`'s `routes`
array and dispatches exactly like Vercel does (first matching `src` wins,
`.js` dests under `/api/` invoke that module's handler, everything else
serves the static file). Ran it against the **pre-fix** `vercel.json`
(via `git show HEAD:vercel.json`) — confirmed `/api/search?q=ukraine`
returned raw `<!DOCTYPE html>...`, reproducing the reported bug exactly.
Ran the same request against the **post-fix** config — got real JSON back,
including 15 live Guardian articles about Ukraine (Guardian's API, which was
unreachable from this sandbox for most of the previous session, is reachable
again this session — confirms last session's read that it was a transient
sandbox network condition, not anything wrong with the endpoint or key).
Then ran a full Playwright pass through a real browser hitting this same
routing-accurate server: opened the Intel Search tab, searched "Ukraine",
confirmed no `Unexpected token` text anywhere in the rendered output, and
confirmed the Wikipedia context card (1) and all 15 article items rendered
correctly, with zero console/page errors. (One test-only wrinkle: the first
couple of Playwright attempts appeared to hang because the wait budget was
too short — clicking through to the request firing took ~15s and GDELT's own
9s internal timeout added more on top, so the full round trip needs a
generous wait in this environment; confirmed via request/response timing
logs that this was purely a test-timeout issue, not an app bug, before
re-running with a longer wait.)

## Session: 2026-07-02 (3) — Population/currency/language, Forecast names, live OSINT search

Three tasks this session.

### TASK 1 — Country panel: population, currency, language

These were blank because they'd only ever come from REST Countries, which is
dead (see the (2) entry below). Replaced with two working live sources,
tested against the real APIs before writing code:

- **Population** — `api.worldbank.org/v2/country/{code}/indicator/SP.POP.TOTL`.
  Used `mrv=1` ("most recent value") instead of the hardcoded `date=2023` the
  task suggested — same endpoint, but it can't go stale as years pass. Not
  covered for Taiwan/Vatican-type entities that aren't World Bank members
  (verified live), same known gap as the rest of `api/country.js`.
- **Currency (P38) + language (P37)** — added to the existing Wikidata SPARQL
  query (the one already resolving countries by ISO code via P297, from the
  previous session). Naively adding these as more `OPTIONAL` triples in the
  same flat `SELECT` broke immediately: P37 (official language) is
  multi-valued for most countries (Switzerland has 4, Taiwan recognizes 25+
  indigenous languages), and combining multiple multi-valued `OPTIONAL`s in
  one row produces a row per combination — confirmed live, US came back as 2
  duplicate rows (Spanish, then Hawaiian) instead of one. Fixed by
  restructuring the whole query around `GROUP_CONCAT(DISTINCT ... ; separator="|")`
  for all four optional fields (head of state, head of government, currency,
  language) with a single `GROUP BY`, then splitting/deduping the `|`-joined
  strings server-side. Needed one more fix after that: Wikidata sometimes
  tags the identical label string as both `"en"` and `"mul"`, which SPARQL's
  `DISTINCT` treats as different terms (different language tags = different
  RDF terms) even though the text is identical — confirmed live, Vatican
  City's currency came back `"euro|euro"`. Fixed by deduping the split
  string values themselves in JS, not relying on SPARQL `DISTINCT` alone.
  Verified correct end-to-end for US, Switzerland, Taiwan, Bhutan, Vatican
  City.
- Dropped `fetchRestCountries` entirely rather than leaving it as a
  never-succeeding fallback — once population/currency/language move to
  working sources, it contributed nothing (capital/region already came from
  World Bank first; flag already had an algorithmic fallback). Simplified
  `subregion` away too since it was the one field only REST Countries ever
  supplied.

### TASK 2 — Forecast tab "undefined" names

Root cause: `api/forecast.js`'s `calculateEscalationProbability` returned the
country name under the key `country`, but `index.html`'s `loadForecast()`
read `c.name` — a field-name mismatch, not missing data (`base.name` already
had real names like "Ukraine", "Sudan" for all 16 entries). Fixed the actual
bug (renamed the field to `name` server-side) and, per the task's explicit
instruction, also added a small client-side `CODE_NAMES` code→{flag,name}
map as a defensive fallback in case the API ever omits a name for some code
— consolidates what used to be a flags-only `FLAG_MAP`. Verified live: all
16 rows now show real names (Sudan, Myanmar, Gaza/Palestine, Haiti, Ukraine,
Yemen, Mali, Somalia, Iran, Lebanon, N.Korea, Pakistan, Ethiopia, Iraq,
Syria, China), zero "undefined".

### TASK 3 — Intel Map → live OSINT search

Deleted the static actor-network SVG graph tab (`renderIntelMap`,
`loadActors`, `#imwrap`/`#imsvg`/`.anode`/`.ileg`, and the `#tab-intel`
markup) and replaced it with an "🔍 INTEL SEARCH" tab.

New `api/search.js` combines three free sources per query, all in parallel,
each independently best-effort so one failing doesn't break the others:
- **GDELT** doc search (`api.gdeltproject.org/api/v2/doc/doc`) — confirmed
  live and working early in the session, but GDELT actively rate-limits
  (their own error response, verified live: *"Please limit requests to one
  every 5 seconds"*) and returns that as **plain text, not JSON** on a 429 —
  code explicitly try/catches the `JSON.parse` rather than letting a
  rate-limit response crash the request.
- **Guardian** search (`content.guardianapis.com/search`) — same key/pattern
  `api/news.js` already uses successfully.
- **Wikipedia** — resolved via `action=opensearch` first (finds the best
  matching canonical title) before fetching `page/summary`, so lowercase or
  imprecise queries ("gaza", "ukraine war") still land on the right article
  instead of 404ing on an exact-match REST call. Skips disambiguation pages
  (no single answer to show). Verified live for "Ukraine", "gaza" (lowercase),
  "ukraine war" (multi-word), and a nonsense query (correctly returns null).
- Articles from GDELT + Guardian are merged, deduped by URL, sorted newest
  first, capped at 15.
- If `ANTHROPIC_API_KEY` is set, a 2-sentence synthesis is generated from the
  combined headlines; the API returns the raw synthesis text and the
  frontend adds the "Here's what's happening with {query}" framing as a
  card header (same pattern `briefMe()` already uses for the brief text).
- Added a short (3min) in-memory cache, both to speed up repeat searches and
  to be a better citizen of GDELT's rate limit.
- "Fly to it if it matches a country/city": reused the same free Open-Meteo
  geocoding endpoint the Weather tab already calls client-side (no new
  dependency) — fired in parallel with the search request itself, not
  awaited afterward, so the map starts moving immediately instead of waiting
  on the news search to finish. Verified live in a real browser: searching
  "Ukraine" flew the map to `[32, 49]` zoom 5, using the real Open-Meteo
  geocoding API, not a mock.

**Known limitation hit during this session, not a code bug**: GDELT and
Guardian's API host were both consistently unreachable (connection timeout,
not an HTTP error — confirmed via IPv4-forced curl, confirmed DNS resolves
fine, confirmed `theguardian.com` itself loads while `content.guardianapis.com`
specifically times out) from this sandbox for the remainder of the session
after the GDELT rate-limit was hit early on. World Bank, Wikidata, Wikipedia,
and Open-Meteo were reachable throughout. Given `api/news.js` already uses
these exact same two hosts successfully in production, this reads as a
transient sandbox-specific network condition rather than a problem with the
endpoint URLs or request shape. Verified what could be verified: the
combine/dedupe/sort/cache logic against realistic mocked GDELT+Guardian
responses (confirmed correct — deduping a URL that appeared in both mock
sources kept exactly one copy, sorted newest-first), and confirmed the real
endpoint degrades gracefully (200 with real Wikipedia data, empty
`articles`, `null` synthesis) rather than crashing when GDELT/Guardian are
genuinely unreachable, end to end through a real browser hitting the real
`/api/search` handler.

### Testing performed
- `node --check` on all three changed/new API files and the extracted
  `<script>` block.
- Direct `curl`/Node verification of the World Bank population endpoint and
  the restructured Wikidata query (multiple countries) before writing the
  final code, matching the same "verify the real API shape first" approach
  from the previous session.
- Local Node shim mounting the real `api/country.js` and `api/forecast.js`
  directly: confirmed population/currency/language populate for US,
  Switzerland, Taiwan, Bhutan; confirmed `risk_matrix` now returns `name`
  correctly.
- Full Playwright run against the real `index.html` + all real `api/*.js`
  handlers (only `/api/search` mocked at the browser level, to isolate
  frontend rendering from the sandbox's GDELT/Guardian connectivity issue):
  zero console/page errors. Verified the Forecast tab shows all 16 real
  country names, the US country panel shows every field populated, the old
  Intel Map tab is gone (`0` count) and Intel Search is present, the
  Wikipedia card / AI synthesis card / article list all render from the
  mocked response, clicking an article opens its URL in a new tab, and the
  map flies to Ukraine's real coordinates via the live (unmocked) Open-Meteo
  geocoding call triggered by the search.

## Session: 2026-07-02 (2) — Country intel now live for every country

### Problem
`api/country.js` only had rich data for the ~24 countries hand-written into a
`COUNTRY_INTEL` object. Every other country fell through to a REST Countries
call that's been dead since the previous session (their free tier returns
`{success:false}` for everything now) and 404'd, so the country panel showed
nothing for the other ~230 countries on the map.

### Fix — full rewrite of `api/country.js`
Aggregates three free, no-key, server-side sources per request (server-side
so the browser never sees the CORS failures the old client-side Wikidata/
RestCountries calls used to hit):

- **World Bank country API** (`api.worldbank.org/v2/country/{code}`) — name,
  capital, region, income level, lat/lon. Covers ~215 economies. Doesn't
  cover Taiwan or Vatican City (not World Bank members) — verified live.
- **REST Countries v3.1** — population, currency, language, subregion.
  Attempted for real (so it self-heals if the operator ever restores the free
  tier) but currently always fails; code explicitly detects the
  `{success:false}` deprecation body (not just network errors) and treats it
  as unavailable rather than trying to render a broken shape.
- **Wikidata SPARQL, resolved by ISO code** — this is the actual fix for "every
  country," not just the previous session's ~45-entry hardcoded QID map.
  Queries `?country wdt:P297 "{code}"` (ISO 3166-1 alpha-2 code property) to
  find the Wikidata entity for *any* country/territory, then reads `wdt:P35`
  (head of state) and `wdt:P6`, newly added, (head of government) as
  "truthy" values — Wikidata's rank-resolution shortcut that already picks
  the current/preferred-rank statement. An earlier attempt at this used
  explicit statement-node filtering (`FILTER NOT EXISTS { ?stmt pq:P582 ?end }`)
  to try to isolate the *current* office-holder, but that produced duplicate/
  wrong rows for countries with messy end-date qualifiers (Taiwan initially
  returned "Lien Chan," a Premier from the 1990s, as a false "head of
  government"); switching to the `wdt:` truthy shortcut fixed it and is
  simpler. Verified correct for US, Taiwan, North Korea, UK, Vatican City,
  Palestine, Monaco, Kazakhstan.
  - **Found a real bug during testing, not just an external-API quirk**: every
    Wikidata call from Node's `fetch` came back `403` even though the exact
    same query worked fine via `curl` and had worked fine from the browser in
    the previous session. Root cause: Wikimedia's User-Agent policy blocks
    requests without a descriptive UA, and Node's default fetch doesn't send
    one (browsers do, automatically, which is why the old client-side calls
    worked without needing this). Fixed by setting an explicit `User-Agent`
    header on the Wikidata request.
- **In-memory `Map` cache**, 1hr TTL, keyed by uppercased code — repeat
  requests to the same warm serverless instance return instantly (confirmed:
  ~250ms cold, ~50ms cached).
- Elections timing and political leaning stay hardcoded per the task's
  explicit instruction (no good live API, changes rarely) — political leaning
  reuses the previous session's curated `ideology` values under a new field
  name; the old `ideology`/`religion`/`gdp`/`military`/`alliance`/`rivals`/
  `riskLevel` fields are dropped entirely (not requested to be kept, and there's
  no live source for them — keeping them would mean two different data
  shapes depending on which fallback path fired, which is exactly what this
  rewrite is trying to eliminate).
- A country code only 404s if **none** of the three sources have ever heard
  of it (e.g. `ZZ`, `QQ`) — verified live. Every real code tested (including
  ones with almost no coverage, like Vatican City and Taiwan) returns at
  least a name, flag, and — via Wikidata — real head of state/government.
- Flag emoji is computed algorithmically from the ISO code (regional indicator
  Unicode offset) as a fallback when REST Countries doesn't provide one —
  works for 100% of valid codes with zero API calls.

### Frontend (`index.html`)
`showCountryIntel()` simplified from a three-tier client-side fallback chain
(direct REST Countries fetch → direct Wikidata fetch → `/api/country`) down
to a single call to `/api/country?code=X`, since the backend now does all
three lookups itself. Removed the now-redundant `COUNTRY_QIDS`,
`COUNTRY_ELECTIONS`, and `fetchLiveLeader`. The panel now renders one
consistent field set for every country (Head of State, Head of Government,
Capital, Population, Region, Income Level, Currency, Language, Next
Elections, Political Leaning) using the existing `row()` helper, which
already rendered `—` for any falsy value — so "show `—` for missing fields"
required no new code, just feeding it the new field names. "No data
available" now only appears when `apiGet` throws (`api/country.js` itself
returned non-2xx, i.e., a code no source recognizes), not per-field.

### Testing performed
- `node --check` on `api/country.js` and on the extracted `<script>` block.
- Direct `curl` verification of all three upstream APIs' actual response
  shapes (World Bank for US/Bhutan/Taiwan/Palestine/Kosovo/invalid-code;
  REST Countries confirmed still dead; Wikidata SPARQL for US/Bhutan/France/
  Taiwan/North Korea/Vatican/Palestine/Monaco) before writing any code against
  assumed shapes.
- A local Node shim mounting `api/country.js` directly (no Vercel account in
  this environment): confirmed real end-to-end responses for US (full
  coverage), Bhutan/Kosovo (World Bank + Wikidata), Taiwan/Vatican
  (Wikidata-only), and `ZZ`/`QQ` (correctly 404). Confirmed cache hit timing.
- Full Playwright run against the real `index.html` + all real `api/*.js`
  handlers (zero mocking): clicked the US (full data), Taiwan (Wikidata-only,
  proving the "never show no-data for a real country" requirement), and
  Kazakhstan (a country that was never in the old hardcoded list at all —
  now shows real head of state/government/capital/region/income level).
  Also clicked open ocean to confirm no panel/errors when there's no country
  feature under the cursor. Zero console/page errors throughout.

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
