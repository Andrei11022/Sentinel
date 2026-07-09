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
an **explicit `routes` array** — every new file needs its own route entry.
**Hobby plan caps Serverless Functions at 12** (every `.js` under `api/`
counts) — shared helpers live in repo-root `lib/`, never `api/lib/`.
Currently 9 files.

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
- CSS Grid's `1fr` track won't shrink below the largest MIN-CONTENT width
  of any item in it (default `min-width:auto`) — a bare `<input>` in a
  mobile grid row can blow the whole layout out past the viewport with
  zero scrollbar. Fix: `min-width:0` on the grid item and any flex
  descendant that also defaults to `min-width:auto`.
- A `position:fixed` element's z-index only competes within its own
  stacking context — a full-screen overlay/sheet must explicitly out-rank
  any fixed sibling (or FAB) it's meant to cover or sit above, or that
  sibling paints on top and intercepts clicks/becomes unclickable itself.
  An ID-based `display:none` base rule also beats a same-viewport, later
  class-based show rule regardless of media-query nesting.
- Don't trust a touch-target/font-size floor, or that a `setInterval`
  callback can still play `AudioContext` sound, without checking live —
  both looked fine by eye/code-review and weren't.
- A synchronous inline `<script>` that queries the DOM for elements
  defined LATER in the same HTML file silently wires nothing — defer to
  `load`.
- REST Countries deprecated. World Bank has no Taiwan/Vatican City
  (Wikidata fallback). GDELT rate-limits ~1 req/5s. OpenSky anon quota
  ~100/day. Wikidata 403s with no `User-Agent`. `maplibregl.Marker` owns
  its element's `transform` — rotate an inner child instead. MapLibre's
  attribution defaults to `<details open>` on narrow maps. Guardian search
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
- 2026-07-09: Four bug fixes. (1) Mobile layers sheet couldn't be
  dismissed — added a ✕ button, tap-outside-close, close-on-nav-open, and
  fixed its z-index covering the FAB once open. (2) "Markers drift on
  zoom" — not reproducible after exhaustive live testing (zoom/pan/resize,
  clustered + static, desktop + mobile): all already sub-pixel accurate.
  Added defensive `map.resize()` on window resize as hardening only.
  (3) Feed never auto-refreshed — added a 3min poll under the server's
  5min cache that prepends only new articles with a glow, updates the
  ticker and a "Updated Xs ago" indicator. (4) ALERT MODE was already
  built (07-04) and working, but its beep's `AudioContext` was created
  inside the automatic poll callback with no user gesture attached, so
  browsers silently block it from ever playing — fixed by priming it in
  the button's click handler. Added the spec'd optional `speechSynthesis`
  announcement (was missing); aligned the HIGH trigger to
  `threatScore>=70` (was 75). All 4 verified live via Playwright.
- 2026-07-08 and earlier: see git log.
