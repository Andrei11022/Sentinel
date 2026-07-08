# SENTINEL — Progress Log

## Architecture

**Frontend**: single-file `index.html` — MapLibre GL JS 2D tactical map
(CARTO dark-matter basemap). No build step, vanilla JS in one `<script>`
block. **Desktop and mobile (`<=767px`) are two separate layout
structures**: desktop uses `#tb` header + `#sb` sidebar (two-row, 5-per-row
tab grid). Mobile reuses the compact `#tb` header (font/height overridden,
not a separate header element) plus its own `#m-nav` bottom nav (5 icons:
Briefing/Forecast/Analyst-center/Search/More), `#m-panel` full-screen
overlay, and `#m-layers-fab` + `#m-layers-sheet`. Mobile panels don't
re-render content — `mOpenPanel()` physically **moves the real desktop
`#tab-*` DOM node** into `#m-panel-body` and moves it back to `#sb` on
close, so all existing live-data JS keeps working unchanged against the
same nodes. `#m-nav`/`#m-panel`/`#m-layers-fab`/`#m-layers-sheet` are
`display:none` outside the `<=767px` query; desktop-only chrome (`#sb`,
`#layer-panel`, `#ghud`) is switched off inside it. Layer toggles
(threats/conflict/military/risk/aircraft/naval) share one
`data-layer="..."` attribute on desktop checkboxes — `setLayer()` is the
one place that updates state; the mobile layers sheet just `.click()`s the
matching real desktop checkbox, so both stay in sync without duplicating
state.

**Backend**: Vercel serverless functions in `api/*.js`. `vercel.json` uses
an **explicit `routes` array** — every new `api/*.js` file needs its own
route entry or requests fall through to the HTML catch-all. **Hobby plan
caps Serverless Functions at 12** (every `.js` under `api/` counts,
subdirectories included) — shared helpers live in repo-root `lib/`, never
`api/lib/`. Currently 9 files, well under the cap.

### Endpoints
| Route | Purpose | Key live sources |
|---|---|---|
| `/api/news` | Multi-source world/mideast news | Guardian, GDELT, BBC/Al Jazeera/NPR/France24 RSS |
| `/api/threats` | Threat markers | derived from `/api/news` |
| `/api/country` | Country intel panel | World Bank + Wikidata, Groq fills 5 analytical gap fields |
| `/api/intelligence` | Merged: risk_matrix/scenarios/acled/entities/predictions/simulate/forecast | static + Groq |
| `/api/search` | Intel Search tab | GDELT + Guardian + Wikipedia + optional Groq |
| `/api/aircraft` | Live aircraft layer | OpenSky, falls back to adsb.lol |
| `/api/analyst` | AI Analyst chat | self-fetches news+threats, Groq, grounded-only |
| `/api/naval` | Naval ship tracker | self-fetches news for position + live Wikipedia detail cards |
| `/api/tts` | Brief Me voice | ElevenLabs, falls back to browser speechSynthesis |

**Caching**: `lib/cache.js` backs onto Upstash Redis REST API, checked
first, falls back to in-memory then live; never throws (missing config is
just a cache miss). TTLs 30s (aircraft) to 7d (country static facts).
`GROQ_API_KEY` gates all AI features via shared `lib/ai.js`
(`llama-3.3-70b-versatile` primary, one retry on `llama-3.1-8b-instant`);
every AI feature has a defined no-key fallback, never a hard error.

### Known gotchas
- **CSS Grid's `1fr` track won't shrink below the largest MIN-CONTENT width
  of any item in it** (default `min-width:auto` on grid items) — a plain
  `<input>` in a mobile grid row blew the whole single-column grid out past
  the viewport with zero scrollbar (`body{overflow:hidden}` clipped instead
  of scrolling), dragging every other row out to match. Fix: `min-width:0`
  on the grid item and any flex descendant (input, marquee track) that also
  defaults to `min-width:auto`. `document.documentElement.scrollWidth`
  reading 0-overflow does NOT rule this out — check individual elements.
- **A `position:fixed` element's z-index only competes within its own
  stacking context** — a full-screen mobile panel must explicitly out-rank
  any fixed sibling it's meant to cover, or that sibling paints on top and
  intercepts clicks. Also: an ID-based `display:none` base rule beats a
  same-viewport, later class-based show rule regardless of media-query
  nesting — a toggleable sheet's hide/show rules need matching selector
  types or the show rule silently never wins.
- Don't trust a touch-target/font-size floor without measuring it —
  `getBoundingClientRect()`/`getComputedStyle()` caught a 44px-vs-48px and
  an 11.9px-vs-13px shortfall this session that looked fine by eye.
- **A synchronous inline `<script>` that queries the DOM for elements
  defined LATER in the same HTML file (e.g. `document.querySelectorAll()`
  at top level, not inside a `load`/`DOMContentLoaded` handler) silently
  wires nothing** — the parser hasn't reached those elements yet, so the
  query returns an empty NodeList with no error. Only bit us because a
  provided mobile-nav markup block was placed after the main `<script>`
  tag per its own integration instructions; fixed by deferring just that
  one wiring call to `load`, matching the pattern the rest of the file
  already used for its own init function.
- REST Countries deprecated (unused). World Bank has no Taiwan/Vatican City
  (Wikidata fallback). GDELT rate-limits ~1 req/5s. OpenSky anon quota
  ~100/day (`/api/aircraft` caches 30s, normalizes adsb.lol's units).
  Wikidata 403s with no `User-Agent`. `maplibregl.Marker` owns its
  element's `transform` — rotate an inner child instead. MapLibre's
  attribution defaults to `<details open>` on narrow maps. `/api/naval.js`
  needs a longer self-fetch timeout than `/api/news`'s own. Guardian search
  needs `order-by=relevance` + a keyword filter. `/api/news` sorts by
  `publishedAt`, not severity.

**Testing**: no Vercel account access — nothing verified against a real
deployment. `node --check`/`new Function()` for syntax, a local Node shim
replicating `vercel.json` routing, Playwright for real browser/layout
behavior (a plain static server suffices for layout-only checks).

## Active issues
None known. Intel Search's multi-word-proper-noun gap ("North Korea" =
2 keyword hits) is a documented limitation, not a bug.

**Unverified**: real Vercel deployment behavior; real Groq/Upstash/
ElevenLabs success paths (no live keys in any dev session, only their
no-key/failure fallback behavior has been exercised).

## Recent changes
- 2026-07-08 (b): Replaced that morning's custom mobile build (below) with
  a provided reference implementation (`mobile-layout` in repo root, node-
  relocation technique — see Architecture), integrated verbatim per
  instructions — only fixed real ID/selector mismatches (`#layers`→
  `#layer-panel`, `conflicts`→`conflict`), added `#ghud` to the "kill
  desktop chrome" list (real chrome not in the provided list, overlapped
  the new stat strip), and fixed a genuine script-execution-order bug (see
  gotchas) that would have left the bottom nav unclickable. `M_TABS`/`#sb`/
  `#gl`/`#tb`/header-stat IDs were already correct, no change needed.
  Verified at 390px (bottom nav, FEED/ANALYST/MORE panels, layers sheet
  with synced checkboxes, close-via-X, 16/17/13px text floors) and 1920px
  (desktop pixel-identical, zero mobile elements, zero console errors).
- 2026-07-08 (a): Custom-built mobile (`<=768px`) as its own layout —
  Conflictly-style compact header, breaking-alert bar, search+chips,
  floating stat strip, 5-icon bottom nav, MORE sheet, layers FAB. Desktop
  tab bar became two fixed rows of 5. Superseded same day by (b) above;
  full detail in git log if ever needed.
- 2026-07-05: Header stat redesign, contrast audit (superseded above).
- 2026-07-04: Migrated AI features to Groq; added Redis caching,
  Predictions + Scenario Simulator; made ALERT MODE functional.
- 2026-07-03 and earlier: see git log.
