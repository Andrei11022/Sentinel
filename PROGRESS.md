# SENTINEL — Progress Log

## Architecture

**Frontend**: single-file `index.html` — MapLibre GL JS 2D tactical map
(CARTO dark-matter basemap, free/no-key) + a 9-tab sidebar. No build step,
no framework, vanilla JS in one `<script>` block. One responsive breakpoint
at `max-width:768px`: sidebar becomes a full-screen slide-up sheet (opened
via the header's "☰ INTEL" button, `#sb.open`), and `html{font-size}` is
bumped so all rem-sized text scales up — nearly every font-size in this
file is in `rem`/`em`, so that one rule is what keeps mobile readable.

**Backend**: Vercel serverless functions in `api/*.js`, all
`module.exports = async function handler(req, res)`. `vercel.json` uses an
**explicit `routes` array**, not filesystem-based routing — every new
`api/*.js` file needs its own `{ "src": "/api/x", "dest": "/api/x.js" }`
entry added by hand, or requests fall through to the HTML catch-all and the
frontend gets `Unexpected token '<'` trying to `JSON.parse` a webpage. This
exact bug has shipped more than once from forgetting this step — always add
the route in the same commit as the new file.

### Endpoints
| Route | Purpose | Key live sources |
|---|---|---|
| `/api/news` | Multi-source world/mideast news | Guardian, GDELT, BBC/Al Jazeera/NPR/France24 RSS |
| `/api/threats` | Threat markers | derived from `/api/news` (internal self-fetch) |
| `/api/country` | Country intel panel | World Bank (facts+population), Wikidata SPARQL (leader/head of govt/currency/language) |
| `/api/forecast` | Risk matrix + scenarios | static base model + optional Claude scenarios |
| `/api/acled` | Conflict list | static, hand-maintained |
| `/api/entities` | Entity extraction | Claude or local pattern DB |
| `/api/analyze` | Brief/correlations/actors | Claude or local fallback |
| `/api/search` | Intel Search tab | GDELT + Guardian + Wikipedia + optional Claude synthesis |
| `/api/aircraft` | Live aircraft layer | OpenSky `states/all`, falls back to `adsb.lol/v2/mil` |
| `/api/analyst` | AI Analyst chat | `/api/news`+`/api/threats` (self-fetch) + Claude, grounded-only |

### Known quirks / gotchas
- REST Countries' free API is fully deprecated (`success:false` on every
  call) — not used anywhere in this codebase anymore.
- World Bank doesn't cover Taiwan/Vatican City (not member states) —
  `/api/country` falls back to Wikidata-only for those.
- GDELT rate-limits aggressively (~1 req/5s) and returns plain text (not
  JSON) on 429 — `/api/search` handles this explicitly.
- OpenSky's anonymous quota is ~100 `states/all` calls/day — `/api/aircraft`
  caches 30s server-side to stay under it.
- `/api/aircraft`'s two sources report different units at the wire level
  (OpenSky: meters, m/s; adsb.lol: feet, knots, ft/min) — the backend
  normalizes everything to OpenSky's units (meters, m/s) before returning,
  so the frontend can convert to display units from one canonical shape
  regardless of which source served the response.
- Wikidata's SPARQL endpoint 403s requests with no descriptive `User-Agent`
  (Node's default fetch sends none; browsers do automatically) —
  `api/country.js` sets one explicitly.
- `maplibregl.Marker` owns the `transform` CSS property of whatever element
  you hand it (for positioning) — never set `transform` directly on a
  marker's outer element (e.g. for rotation); rotate an inner child instead.
  See `createAircraftMarkerEl` in `index.html`.
- `ANTHROPIC_API_KEY` gates all Claude-backed features; every one has a
  defined no-key fallback (static/local output, or a clear "needs
  configuration" message) rather than erroring.
- `/api/news`'s main list sorts by threatScore first (date only breaks close
  ties) — that's deliberate for the severity-ranked Briefing feed, but it
  means "top of the feed" is NOT "newest." Anything that needs recency
  (Brief Me, Middle East tab) does its own fresh `/api/news` fetch and its
  own `publishedAt`-descending sort rather than reusing the cached
  `liveArticles` global or feed order.
- Guardian's search API (`/api/search`) matches loosely across its whole
  corpus on multi-word queries — `order-by=newest` was returning barely-related
  "whatever's newest that matched anything" results (confirmed live: a
  2-word geopolitical query returned Chris Froome's retirement announcement).
  Fixed with `order-by=relevance` plus a real post-fetch relevance filter
  requiring the query's keywords actually appear in title/description.
  Known remaining gap: multi-word proper nouns ("North Korea") count as two
  separate keyword hits, so a query like "North Korea missile" can still let
  through an article that's only about North Korea with no missile content —
  fixing that needs real entity detection, not just keyword counting.

### Testing approach
No Vercel account access has been available in any session — nothing has
been verified against a real deployment. Instead: `node --check` for
syntax, a local Node shim that parses `vercel.json`'s `routes` array and
dispatches exactly like Vercel would (most accurate), plus Playwright
against that shim for real browser behavior. Real live external APIs are
hit directly wherever possible rather than mocked.

## Active issues
None currently known/reported as broken.

**Known limitation** (not a bug, documented above): Intel Search's
relevance filter can still admit an article that only covers one half of a
multi-word proper-noun query (e.g. "North Korea missile" matching a North
Korea article with no missile content) since it counts keywords, not
entities.

**Unverified**: real Vercel deployment behavior — the `x-forwarded-proto`
self-fetch header pattern, `functions.maxDuration` config, and Vercel's
exact `routes` matching semantics are all inferred from docs/local
emulation, never confirmed against a live deployment.

## Next priorities
None queued — each session has worked from its own task list rather than a
standing backlog.

## Changelog
- 2026-07-03 (10): Fixed two live bugs. (a) Brief Me was citing ~1-day-old
  articles because it reused the boot-time `liveArticles` cache, which
  mirrors `/api/news`'s severity-first sort — confirmed live that the top
  of that sort was 25.8h old while true newest articles were minutes old.
  `briefMe()` now does its own fresh `/api/news` fetch and sorts by
  `publishedAt` descending (same pattern the Middle East tab already used),
  and `api/analyze.js`'s `buildBrief()` + Claude prompt now sort/label by
  recency instead of re-sorting by threatScore. (b) Intel Search returned
  largely unrelated articles for multi-word queries — root-caused live to
  Guardian's `order-by=newest` search discarding its own relevance ranking
  (a 2-word query returned Chris Froome's retirement announcement and
  Taylor Swift gossip). Fixed with `order-by=relevance` plus a real
  post-fetch filter requiring query keywords to actually appear in the
  title/description, ranked title-matches-first, empty result falls
  through to the existing "No results found" UI state instead of showing
  unrelated items.
- 2026-07-03 (9): Rebuilt aircraft popups — `/api/aircraft` now returns every
  field OpenSky/adsb.lol actually provide (category/type, vertical rate,
  on-ground, squawk, registration) and a human-readable `militaryReason` for
  every flagged aircraft instead of a bare boolean; also fixed a real unit
  bug where the adsb.lol fallback path passed raw feet/knots through as if
  they were meters/m-s (see gotcha above). Frontend popup only renders rows
  with real values (no more dash-filled cards), titles unidentified military
  contacts "Military Aircraft (unidentified)" instead of "Unknown callsign",
  shows altitude/speed in both units, heading with compass point, origin
  country+flag (derived from a name→ISO2 table, not hardcoded flags), and is
  restyled to match the country intel panel (Rajdhani title, Share Tech Mono
  grid, red border/glow for military vs cyan for civilian).
- 2026-07-03 (8): Mobile responsive pass — sidebar converts to a full-screen
  slide-up sheet below 768px (opened/closed via a header "☰ INTEL" button),
  root font-size bumps on mobile so all rem-sized text stays readable
  without pinch-zoom, stat bar goes 2x2, header hides SOURCES/clock/STATUS
  (keeps THREATS/RISK), brief/alert buttons go icon-only. Also fixed a
  desktop regression from session 7: layer panel was too cramped to read —
  widened to 206px with 11-12px fonts and real row padding, collapsed state
  is now a clean 32px icon button, and `.maplibregl-popup` got an explicit
  z-index so marker popups always render above the layer panel/ticker.
  Desktop layout otherwise unchanged (verified via Playwright at 1500px).
- 2026-07-02 (7): Layer panel UI fix (collapsible, 180px width cap, smaller
  font, more transparent, mobile-collapsed/desktop-expanded default); this
  file trimmed from 660 lines of session narrative to architecture facts.
- 2026-07-02 (6): Added AI Analyst chat (`api/analyst.js`), grounded only in
  live `/api/news`+`/api/threats`, replacing the static correlations tab.
- 2026-07-02 (5): Re-verified `/api/search` fix; added live aircraft
  tracking (`api/aircraft.js`, OpenSky + adsb.lol fallback).
- 2026-07-02 (4): Fixed `/api/search` 404 (missing `vercel.json` route).
- 2026-07-02 (3): Live population/currency/language in `/api/country`
  (World Bank + Wikidata); fixed Forecast tab `undefined` names; added
  `api/search.js` (OSINT search) replacing the static actor-graph tab.
- 2026-07-02 (2): Rewrote `api/country.js` to cover every country live
  (World Bank + Wikidata), not just a ~24-country hardcoded list.
- 2026-07-02 (1): Full rewrite — replaced the 3D Three.js globe with a 2D
  MapLibre tactical map; added threat markers/clustering, military assets,
  conflict zones, news ticker, weather tab.
