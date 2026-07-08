# SENTINEL — Progress Log

## Architecture

**Frontend**: single-file `index.html` — MapLibre GL JS 2D tactical map
(CARTO dark-matter basemap) + a 10-tab sidebar (horizontally-scrollable row
with edge fade hints, not paginated). No build step, vanilla JS in one
`<script>` block. Breakpoint at `max-width:768px`: sidebar becomes a bottom
sheet (`#sb.open`, toggled by header ☰ or floating `#sb-fab`), layer panel
collapses to a single icon button, `html{font-size}` bumps so all rem-sized
text scales up.

**Backend**: Vercel serverless functions in `api/*.js`,
`module.exports = async function handler(req, res)`. `vercel.json` uses an
**explicit `routes` array** — every new `api/*.js` file needs its own
`{ "src": "/api/x", "dest": "/api/x.js" }` entry or requests fall through to
the HTML catch-all (`Unexpected token '<'` on the frontend). Add the route
in the same commit as the new file.

**Vercel Hobby plan caps Serverless Functions at 12** — every `.js` file
anywhere under `api/` counts, subdirectories included. Shared helpers
(`lib/ai.js`, `lib/cache.js`) live in a repo-root `lib/`, never `api/lib/`,
so they don't eat a function slot. Before adding an endpoint: `find api
-name "*.js" | wc -l` — currently 9, stay well under 12.

### Endpoints
| Route | Purpose | Key live sources |
|---|---|---|
| `/api/news` | Multi-source world/mideast news | Guardian, GDELT, BBC/Al Jazeera/NPR/France24 RSS |
| `/api/threats` | Threat markers | derived from `/api/news` |
| `/api/country` | Country intel panel | World Bank + Wikidata, Groq fills 5 analytical gap fields |
| `/api/intelligence` | Merged: risk_matrix, scenarios, acled, entities, brief/correlations/warnings/actors, predictions, simulate (conflict/whatif), forecast | static + Groq |
| `/api/search` | Intel Search tab | GDELT + Guardian + Wikipedia + optional Groq |
| `/api/aircraft` | Live aircraft layer | OpenSky, falls back to adsb.lol |
| `/api/analyst` | AI Analyst chat | self-fetches news+threats, Groq, grounded-only |
| `/api/naval` | Naval ship tracker | self-fetches news for position + live Wikipedia detail cards |
| `/api/tts` | Brief Me voice | ElevenLabs, falls back to browser speechSynthesis |

**Caching**: `lib/cache.js` (repo root) backs onto Upstash Redis REST API
(`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`). Every AI/live-backed
endpoint checks Redis first, falls back to in-memory cache, then does the
real work. `getCache`/`setCache` never throw — missing config or a Redis
error just resolves to a miss, same as if Redis didn't exist. TTLs range
30s (aircraft) to 7d (country static facts); AI-heavy endpoints are
30min-1h. See `lib/cache.js` call sites for exact keys/TTLs if you need them.

`GROQ_API_KEY` gates all AI features via the shared `lib/ai.js` client
(`askAI({system, messages, maxTokens, timeoutMs})` — OpenAI-compatible
`chat/completions`, `llama-3.3-70b-versatile` primary with one automatic
retry against `llama-3.1-8b-instant`). Every AI-backed feature has a
defined no-key fallback (static/local output or a clear message), never a
hard error.

### Known gotchas
- REST Countries API is fully deprecated — not used anywhere here.
- World Bank doesn't cover Taiwan/Vatican City — falls back to Wikidata-only.
- GDELT rate-limits ~1 req/5s and returns plain text (not JSON) on 429.
- OpenSky's anon quota is ~100 calls/day — `/api/aircraft` caches 30s.
  Its two sources report different units at the wire level (OpenSky:
  meters/m-s; adsb.lol: feet/knots/ft-min) — backend normalizes to
  OpenSky's units before returning.
- Wikidata's SPARQL endpoint 403s with no `User-Agent` header (Node's
  default fetch sends none) — `api/country.js`/naval Wikipedia calls set one.
- `maplibregl.Marker` owns the `transform` CSS property of its element —
  never set `transform` directly on a marker's outer element; rotate an
  inner child instead (`createAircraftMarkerEl`).
- **A `position:fixed`/`absolute` element's z-index only competes within
  its own stacking context.** Any ancestor with `backdrop-filter`,
  `opacity<1`, `transform`, or its own z-index creates a new context —
  a child's high z-index can still lose to an unrelated sibling subtree.
  Bit us once with the header dropdown vs. the mobile bottom sheet; fix
  was raising the *ancestor's* z-index, not the child's. Invisible to
  `getComputedStyle`/`getBoundingClientRect` checks — only shows in an
  actual rendered screenshot.
- **Scroll/resize-driven UI logic (e.g. `updateTabFades()`) that runs at
  script-load time reads `clientWidth`/`scrollWidth` as 0 if its element
  is still inside `display:none` ancestor** (the boot loader hides `#app`
  for ~2.8-3.3s). Re-run any such check inside the callback that actually
  makes the element visible, not just once at script bottom.
- MapLibre's attribution control renders as a native `<details open>` on
  narrow maps (expanded, not collapsed, by default) — remove the `open`
  attribute right after `new maplibregl.Map(...)` if it visually crowds
  UI below it; the control's DOM exists synchronously at construction.
- Never add inline `style="position:..."` to an element that already gets
  its position from a CSS class rule without checking what that rule
  says — it silently overrides the class and can drop the element out of
  its intended stacking/positioning entirely.
- `api/naval.js` self-fetches `/api/news`, which can take ~9s to
  aggregate — give the self-fetch a longer timeout than `/api/news`'s own
  per-source timeout or the outer fetch aborts first.
- Guardian's search (`/api/search`) needs `order-by=relevance` (not
  `newest`) plus a post-fetch keyword filter, or multi-word queries return
  loosely-related junk. 2-word queries need 1 of 2 keywords present,
  3+-word need a majority. Known gap: multi-word proper nouns ("North
  Korea") count as 2 separate keyword hits, so real entity detection would
  still improve precision further.
- `/api/news`'s main list is pure `publishedAt`-descending, not
  severity-sorted — `/api/threats.js` does its own local severity sort on
  a copy of the array rather than relying on `/api/news`'s order.

### Testing approach
No Vercel account access has been available — nothing verified against a
real deployment. Instead: `node --check` for syntax, a local Node shim that
parses `vercel.json`'s `routes` array and dispatches like Vercel would, plus
Playwright against that shim (or a plain static server for layout-only
checks) for real browser behavior.

## Active issues
None currently known/reported as broken. Intel Search's multi-word-proper-
noun gap (above) is a documented limitation, not a bug.

**Unverified**: real Vercel deployment behavior (`x-forwarded-proto`
self-fetch header, `functions.maxDuration`, exact `routes` matching) — all
inferred from docs/local emulation, never confirmed live. No live
`GROQ_API_KEY`/Upstash/ElevenLabs account has been available in any dev
session, so those success paths are unverified beyond their no-key/failure
fallback behavior.

## Next priorities
None queued — each session works from its own task list, not a standing
backlog.

## Recent changes
- 2026-07-08: Fixed real breakage from the prior session's header/stat
  redesign, found via live Playwright rendering (not code review): 7 of 10
  sidebar tabs were silently clipped with no scroll indication (added
  `.tabs-wrap` edge-fade hints); map layers panel note text was cut off
  mid-sentence (shortened text, raised `.lp-body` max-height, added
  scroll fallback); the bottom-left `#ghud` info box was 4 stacked lines
  including permanent click/drag/zoom instructions (collapsed to one
  compact row + a "?" popover); header logo wrapped to 2 lines at 1366px
  (added `nowrap`/`flex-shrink:0` + a `max-width:1500px` tier hiding the
  subtitle); fixed a redundant "SOURCES: 6 SOURCES" copy bug; polished
  sidebar entity-chip hover/tap affordance. Verified at 1920/1366/390px:
  no horizontal overflow, no console errors, all 10 tabs open their panel.
- 2026-07-05: Full UI/layout pass — moved High/Medium stats into the
  header, removed the bottom stat panel so the map reclaims that space,
  contrast audit (`--muted`/`--dim` raised off illegible dark-blue),
  sidebar tab bar switched to a single scrollable row, mobile bottom-sheet
  sidebar + floating toggle.
- 2026-07-04: Migrated all AI features from Anthropic to Groq (account ran
  out of credits); merged 4 endpoints into `api/intelligence.js` to stay
  under Vercel's 12-function cap; added Upstash Redis caching
  (`lib/cache.js`) across every AI/live-backed endpoint; added Predictions
  + Scenario Simulator + auto-generated Scenarios (grounded in live
  articles + real country data, not guesses); added AI-filled country
  fields (elections/leaning/govt type/allies/rivals); fixed SIMULATE tab's
  country pickers to the full ~197-country ISO list; made ALERT MODE
  actually poll/beep/notify instead of being a UI stub.
- 2026-07-03: Added naval ship tracker (`api/naval.js`); replaced Brief
  Me's robotic TTS with ElevenLabs; fixed stale-article and irrelevant-
  search-result bugs.
- 2026-07-02: Full rewrite — replaced the 3D Three.js globe with the
  current 2D MapLibre tactical map; added threat markers, live country
  data (World Bank + Wikidata), OSINT search, live aircraft tracking.

Older history is in git log, not duplicated here.
