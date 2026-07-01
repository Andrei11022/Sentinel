# SENTINEL — Progress Log

## Session: 2026-07-01

Scope for this session: 3 priority fixes to `index.html` (globe click/drag, country
labels, live country intel panel). No PROGRESS.md existed yet — this is the first entry.

### FIX 1 — Globe spin-on-click

Replaced the old `mousedown`/`mousemove`/`mouseup`/`click` handlers (which rotated the
globe on every click, including non-drags) with drag-distance detection: `mousedown`
records the start point, `mousemove` only rotates once the pointer has moved >3px
(`_dragged=true`), and `click` is a no-op if a drag just happened. Wheel zoom now sets a
`targetZoom` that's eased toward in `animate()` (`camera.position.z += (targetZoom -
camera.position.z) * 0.06`) instead of snapping instantly. `flyTo(lat, lon)` now takes
coordinates directly (previously took a warning object) and is used by threat markers,
conflict list items, and entity location tags.

Verified with Playwright against a live-rendered page: a plain click no longer perturbs
`targetRotX/Y`; a drag does; wheel updates `targetZoom`; marker clicks still open the
threat tooltip and fly the camera in.

### FIX 2 — Country name labels

Added a `#globe-labels` absolutely-positioned overlay div (pointer-events:none) with one
child `<div>` per entry in `LABEL_COUNTRIES` (26 countries). Each frame, `animate()`
projects each country's globe-surface position through the current rotation and camera,
hides labels on the far side of the globe, and positions the rest with `left`/`top` in
pixels. `initLabels()` must run and populate `labelEls` **before** the first `animate()`
frame executes — see bug note below.

### FIX 3 — Country click → live intel panel

Added `#country-panel` (fixed position, top-right) and `showCountryIntel(code)`, wired
into `handleGlobeClick()`: raycast markers first, then country zones, then clear both
panels if neither hit. Leader is fetched live from Wikidata via SPARQL; country facts
were originally meant to come from `restcountries.com/v3.1` directly, with a fallback —
see below, this had to change from the original plan.

### Bugs found and fixed during verification (not pre-existing knowledge — found by
### actually running the page in a browser and clicking things)

1. **Boot-order crash**: `initGlobe()` calls `animate()` synchronously at the end of its
   body, and `animate()`'s first pass runs before the next line of the boot sequence
   executes. Original boot order called `initGlobe()` then `initLabels()`, so the very
   first `animate()` frame ran the label-projection loop against an empty `labelEls`,
   throwing `Cannot read properties of undefined (reading 'style')` on every frame.
   Fixed by calling `initLabels()` before `initGlobe()`.

2. **Country zones never actually rotated with the globe (pre-existing, not introduced
   this session)**. The click-detection spheres for `COUNTRY_CENTERS` were added
   directly to `scene` with a fixed world position, and each frame the old code did
   `cs.rotation.x = rotX; cs.rotation.y = rotY` — which spins a symmetric sphere in
   place around its own center and does nothing to its position. The zones stayed frozen
   at their initial (unrotated) spot forever, so clicking a country after the globe had
   rotated even slightly (which happens within ~1s of load, since auto-rotate is on by
   default) would raycast against empty space. Fixed by parenting the zones to
   `globeMesh` (`globeMesh.add(cs)` instead of `scene.add(cs)`), same pattern threat
   markers already used correctly, and removed the now-redundant per-frame `.rotation`
   sync. Verified with Playwright: projected a zone's live world position to screen
   after an arbitrary rotation and confirmed a click there resolves to the correct
   country code.

3. **Wikidata leader query missing a language fallback.** The SPARQL query only
   requested `wikibase:language "en"`. Some Wikidata entities (verified live: Q22686,
   Donald Trump's item) currently have no English label — only ~120 other languages plus
   a `mul` (multilingual) label — so the label service silently fell back to returning
   the raw QID string instead of a name. Fixed by requesting `"en,mul"`.

4. **`restcountries.com`'s free API is fully deprecated as of now.** Every request to
   `/v1`–`/v4` (including the `/v3.1/alpha/{code}` endpoint the original plan specified)
   returns `{success:false, errors:[...]}` with no data — confirmed live via curl and in
   a real browser. Their replacement `/v5` requires a free account and an API key sent
   via `Authorization: Bearer`. There is currently no way to fetch country facts from
   them without a key.

   Flagged this to the user mid-session; decision was to keep attempting the live
   REST Countries fetch first (so this self-heals if they ever restore free access), and
   on failure fall back to the repo's own `/api/country` endpoint, which already had a
   static, richer geopolitical dataset (leader/ideology/religion/currency/GDP/
   military/alliances/rivals) sitting unused. `showCountryIntel` now tries REST
   Countries, and on any failure (network error, CORS, or a `success:false` body) calls
   `apiGet('/country?code=...')` and renders that data set instead, with "No data
   available" as the final fallback if both fail. Head-of-state stays sourced from the
   live Wikidata lookup in both paths where available.

### Known issue found but left out of scope

`loadConflicts()`, `loadForecast()`, and `loadEntities()` all call `apiGet('/api/...')`
(e.g. `apiGet('/api/acled')`), but `apiGet()` already prepends `API` (`'/api'`) to its
argument — so these requests actually hit `/api/api/acled`, `/api/api/forecast`, and
`/api/api/entities`, none of which are routed in `vercel.json`. This looks like a
pre-existing bug unrelated to this session's 3 fixes (the correctly-working calls like
`apiGet('/threats')` and `apiGet('/news?type=world')` don't have the doubled prefix).
Not fixed this session per the "3 things only" scope — flagging for a future session.

### Rule compliance notes

- Threat markers on the globe now come exclusively from `/api/threats` (removed the
  `addMarker(...)` call inside `loadConflicts()`, which had been plotting ACLED conflict
  data as globe markers too).
- Election dates remain the only hardcoded data, per the rule — `COUNTRY_ELECTIONS`.
- `index.html` is still one file, one `<script>` block, one Three.js import (r128 via
  cdnjs).
