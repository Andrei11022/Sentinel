# SENTINEL — Progress Log

## Architecture

**Frontend**: single-file `index.html` — MapLibre GL JS 2D tactical map
(CARTO dark-matter basemap). No build step, vanilla JS in one `<script>`
block. **Desktop and mobile (`<=768px`) are two separate layout
structures**: desktop uses `#tb` header + `#sb` sidebar (two-row, 5-per-row
tab grid); mobile uses its own `#m-*` elements (compact header,
breaking-alert bar, search+quick-stat chips, floating map stat strip, fixed
5-icon bottom nav) and repurposes `#sb` as a full-screen section panel
opened by the bottom nav/MORE sheet. `#m-*` elements are `display:none`
outside the `<=768px` query; desktop-only chrome (`#tb`, `#ticker`,
`#layer-panel`, `#ghud`, `.tabs-wrap`) is switched off inside it. Layer
toggles (threats/conflict/military/risk/aircraft/naval) share one
`data-layer="..."` attribute across desktop checkboxes, the mobile
bottom-sheet, and the quick-stat chips — `setLayer()` is the single place
that updates state, keeping every control in sync across both layouts.

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
- 2026-07-08: Rebuilt mobile (`<=768px`) as a fully separate layout modeled
  on Conflictly's mobile app — compact header, breaking-alert bar,
  search+quick-stat chips, floating map stat strip with a live sparkline,
  fixed 5-icon bottom nav (BRIEFING/FEED/ANALYST/FORECAST/MORE) opening
  sections as full-screen panels, MORE sheet for the remaining 6 sections,
  map-layers FAB + bottom sheet. Desktop's tab bar is now two fixed rows of
  5 (was single-row scroll). Same day: fixed sidebar-tab/layer-panel/ghud
  regressions + header 1366px wrap from the prior redesign. Found/fixed 5
  real bugs via Playwright (see gotchas): panel z-index vs fixed siblings,
  a CSS Grid min-width overflow, a FAB/stat-strip overlap, touch-target/
  label-size shortfalls. Verified at 1920/1366/390/360px across 3+
  render-inspect-fix cycles: zero overflow, layer controls sync across
  both layouts, every nav item and MORE row opens its panel.
- 2026-07-05: Header stat redesign, contrast audit (superseded above).
- 2026-07-04: Migrated AI features to Groq; added Redis caching,
  Predictions + Scenario Simulator; made ALERT MODE functional.
- 2026-07-03 and earlier: see git log.
