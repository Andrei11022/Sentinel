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

**Vercel Hobby plan caps Serverless Functions at 12** — every `.js` file
anywhere under `api/` (including subdirectories) counts as one function,
whether or not it's referenced by a route, unless it's excluded from the
functions build. This capped out once already (see changelog) after adding
enough AI-backed endpoints; fixed by consolidating related endpoints into
one routed-by-`type` file (`api/intelligence.js`) and moving the shared Groq
client to a repo-root `lib/` folder (outside `api/`) so it's plain shared
code, not a function. **If you add a new endpoint, count `find api -name
"*.js" | wc -l` first** — stay well under 12, and put any new shared helper
in `lib/`, never `api/lib/`.

### Endpoints
| Route | Purpose | Key live sources |
|---|---|---|
| `/api/news` | Multi-source world/mideast news | Guardian, GDELT, BBC/Al Jazeera/NPR/France24 RSS |
| `/api/threats` | Threat markers | derived from `/api/news` (internal self-fetch) |
| `/api/country` | Country intel panel | World Bank (facts+population), Wikidata SPARQL (leader/head of govt/currency/language), Groq fills elections/leaning/govt-type/allies/rivals gaps |
| `/api/intelligence?type=risk_matrix` | Country risk matrix | static base model (was `/api/forecast`) |
| `/api/intelligence` POST `{type:'scenarios'}` | AI conflict scenarios | static fallback + optional Groq (was `/api/forecast`) |
| `/api/intelligence?type=acled` | Conflict event list | static, hand-maintained (was `/api/acled`) |
| `/api/intelligence` POST `{type:'entities'}` | Entity + relationship extraction | Groq or local pattern DB (was `/api/entities`) |
| `/api/intelligence` POST `{type:'brief'\|'correlations'\|'warnings'\|'actors'}` | Brief/correlations/actors | Groq or local fallback (was `/api/analyze`) |
| `/api/intelligence` POST `{type:'predictions'}` | AI-assessed probability cards per live situation (PREDICTIONS panel) | Groq, grounded in live articles grouped by situation |
| `/api/intelligence` POST `{type:'simulate', mode:'conflict'}` | Two-country AI war-game briefing (SIMULATE tab) | Groq, grounded in both countries' real `/api/country` profiles (self-fetch) |
| `/api/intelligence` POST `{type:'simulate', mode:'whatif'}` | Hypothetical-scenario cascade breakdown (SIMULATE tab) | Groq |
| `/api/intelligence` POST `{type:'forecast'}` | Global "next 30-90 days" outlook (top 3-5 escalation risks) | Groq, grounded in live articles |
| `/api/search` | Intel Search tab | GDELT + Guardian + Wikipedia + optional Groq synthesis |
| `/api/aircraft` | Live aircraft layer | OpenSky `states/all`, falls back to `adsb.lol/v2/mil` |
| `/api/analyst` | AI Analyst chat | `/api/news`+`/api/threats` (self-fetch) + Groq, grounded-only |
| `/api/naval` | Naval ship tracker | `/api/news` (self-fetch) for positions + live Wikipedia for detail cards |
| `/api/tts` | Brief Me voice | ElevenLabs TTS (voice "Adam"), falls back to browser speechSynthesis client-side |

9 files under `api/` total (news, threats, country, intelligence, search,
aircraft, analyst, naval, tts) — 3 under the Hobby cap of 12.

**Caching**: a shared persistent cache, `lib/cache.js` at the repo root
(`getCache(key)`/`setCache(key, value, ttlSeconds)`/`hashKey(str)`), backs
onto Upstash Redis's REST API (`UPSTASH_REDIS_REST_URL` +
`UPSTASH_REDIS_REST_TOKEN`) so repeat requests across different serverless
invocations — not just within one warm instance — skip live/AI calls
entirely. Every endpoint that uses it checks Redis first, falls back to its
own pre-existing in-memory cache if Redis misses/is unconfigured/throws,
and only does the real work (fetch/AI) as a last resort — see the gotcha
below for the full tiered-TTL table and the fallback guarantee.

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
- `GROQ_API_KEY` gates all AI-backed features (migrated off Anthropic
  entirely 2026-07-04, see changelog — Anthropic account ran out of
  credits); every one still has a defined no-key fallback (static/local
  output, or a clear "needs configuration" message) rather than erroring.
  All AI-backed code (`analyst.js`, `search.js`, and the merged
  `intelligence.js` — see below) shares one client, **`lib/ai.js` at the
  repo root** (`askAI({system, messages, maxTokens, timeoutMs})`), instead
  of each hand-rolling its own fetch — if you add a new AI-backed endpoint,
  use this helper rather than calling Groq directly, and `require` it via a
  relative path (`../lib/ai` from a file directly under `api/`). **Do not
  put shared helpers under `api/lib/`** — Vercel's Hobby plan counts every
  `.js` file anywhere under `api/` as its own Serverless Function
  (subdirectories included), so a helper living there silently eats one of
  the 12 available slots without being a real endpoint; that's exactly what
  caused the "No more than 12 Serverless Functions" build failure (see
  changelog) once `api/lib/ai.js` pushed the true count to 13. It calls
  Groq's OpenAI-compatible `chat/completions` endpoint
  (`https://api.groq.com/openai/v1/chat/completions`,
  `Authorization: Bearer <GROQ_API_KEY>`), primary model
  `llama-3.3-70b-versatile` with one automatic retry against
  `llama-3.1-8b-instant` if the primary call fails for any reason (model
  decommissioned, rate-limited, down) — callers still get to catch a final
  failure and use their own non-AI fallback if both attempts fail.
  **Important shape difference from the old Anthropic code**: Groq is
  OpenAI-style, so `system` is a `{role:'system', content:...}` message
  prepended to the array, not a top-level param like Anthropic's `system`
  field — `askAI` handles this internally, callers just pass `system` as a
  plain string (or omit it, as most of `intelligence.js`'s prompts do, since
  they never used a system prompt to begin with). Response text is at
  `data.choices[0].message.content`, not Anthropic's
  `content[].find(block => block.type==='text')` shape — also handled
  inside the helper, so callers just get back a plain string. No `thinking`
  param exists on Groq's API — none of the old `thinking:{type:'disabled'}`
  workarounds are needed anymore.
- Prior to the Groq migration, every AI-backed endpoint was hardcoded to
  `claude-sonnet-4-20250514` on Anthropic (deprecated, retired 2026-06-15) —
  this was the actual cause of a previously-fixed "Anthropic API 400". That
  whole code path (the model ID, `thinking:{type:'disabled'}`, the
  `content?.find(b=>b.type==='text')` extraction, and the
  `askClaude`/`runAnthropic`/`extractEntitiesAI`/etc per-file fetch calls)
  is gone now, replaced by `lib/ai.js` above. If you ever see Anthropic
  fetch code reappear in one of these files, it's a regression, not a
  restoration.
- **Persistent shared caching via Upstash Redis** (`lib/cache.js`, repo
  root — outside `api/` for the same reason `lib/ai.js` is: it must never
  count as a Serverless Function). Same silent-fallback contract as every
  other optional dependency in this codebase: `getCache`/`setCache` never
  throw — a missing `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`, a
  non-2xx response, or a network error all just resolve to `null`/`false`,
  and every caller falls through to its own pre-existing in-memory cache and
  then a live call, exactly as if Redis didn't exist. Redis is checked
  *first*, not instead of the in-memory cache, because Redis is shared
  across different serverless instances/cold starts while in-memory caches
  are scoped to one warm instance — the in-memory layer alone already
  worked fine within a single instance's lifetime; Redis is what makes a
  cache hit possible across instances too. Exact tiered TTLs (seconds),
  matched to how often each kind of data actually changes:
  | Data | TTL | Key |
  |---|---|---|
  | Country static facts (capital, population, currency, language, region) | 604800 (7d) | `country:static:{CODE}` |
  | Country leadership (leader, head of govt, elections) | 43200 (12h) | `country:leadership:{CODE}` |
  | Country AI-assessed fields (leaning, govt type, allies, rivals) | 86400 (24h) | `country:ai:{CODE}` |
  | Main news/briefing feed | 300 (5min) | `news:{type}` |
  | Threats | 1800 (30min) | `threats:world` |
  | Forecast risk matrix / scenarios | 1800 (30min) | `forecast:risk_matrix`, `forecast:scenarios` |
  | Entities | 1800 (30min) | `entities:latest` |
  | Brief Me generated text | 3600 (1h) | `brief:daily` |
  | AI analyst answers | 900 (15min) | `analyst:{hash}` |
  | Aircraft | 30 | `aircraft:live` |
  | Naval fleet list | 600 (10min) | `naval:fleet` |
  | Predictions (PREDICTIONS panel) | 1800 (30min) | `predictions:latest` |
  | Global forecast outlook | 3600 (1h) | `global:forecast` |
  | Simulator (conflict/what-if) | 3600 (1h) | `simulate:conflict:{sortedCodes}`, `simulate:whatif:{hash}` |
  Deliberately **not** cached: `intelligence.js`'s `acled` type (pure static
  data, no live/AI call — caching it would save nothing) and its
  `correlations`/`warnings`/`actors` types (confirmed via grep, before this
  feature existed, to be unreachable from the frontend — see the
  intelligence.js gotcha below; not worth the complexity for dead code).
  `api/naval.js`'s per-ship Wikipedia detail-card lookup is also uncached —
  only its fleet list (the expensive, self-fetch-heavy part) is.
  Three things worth knowing if you touch this again: (1) **`api/country.js`
  caches static/leadership/AI facts in 3 fully independent Redis keys with
  independent TTLs** (not one combined blob) specifically so a 12h-old
  leader's data can refresh while 7-day-old population data stays put —
  verified live-ish (mocked): forcing only the leadership key to expire
  re-triggers exactly one fresh Wikidata call while World Bank and Groq are
  untouched. Wikidata's single SPARQL query answers both the static bucket
  (currency/language) and the leadership bucket (head of state/government),
  so it's only called when *either* bucket needs refreshing, never
  redundantly for both. (2) **`api/country.js` makes exactly ONE Groq call
  per request even though two different buckets can each independently want
  an AI fill** (leadership wants `elections`, the AI bucket wants the other
  4 fields) — this was a real bug caught during testing: a naive
  per-bucket-decides-independently design made 2 Groq calls for any country
  outside both hardcoded tables (e.g. Romania) on its first lookup. Fixed
  by computing both buckets' *need* first, then making one shared
  `fillGapsWithAI()` call if either needs it, and distributing the one
  response across whichever bucket(s) actually needed it. (3) **The AI
  analyst's cache key hashes `question + sanitized history` together, not
  just the question** — the task that added this caching only asked for
  "keyed by normalized question hash," but hashing the question alone would
  let two unrelated conversations that both happen to ask a generic
  follow-up like "tell me more about that" collide and serve each other's
  (contextually wrong) cached answer. Folding in history closes that hole
  while still caching the common case (two different users asking the same
  fresh question, e.g. "Summarize last 24h", with no prior history) — a
  deliberate, documented deviation from the literal task wording, not an
  oversight. Verified end-to-end through the real `vercel.json` routing
  (not just unit-called handlers) with mocked Redis + mocked
  Groq/WorldBank/Wikidata/Guardian/GDELT/RSS/OpenSky: every cached endpoint
  hit zero new live/AI calls on a second identical request, and every
  endpoint still returned 200 with a simulated total Redis outage (every
  Redis call throwing).
- **`api/intelligence.js` merges four formerly-separate endpoints**
  (`analyze.js`, `entities.js`, `forecast.js`, `acled.js`) behind one flat
  `type` value — done to get under Vercel Hobby's 12-function cap (see
  changelog). Routing: `?type=risk_matrix` and `?type=acled` are GET with
  query params (both were already query-param-driven); `scenarios`,
  `brief`, `correlations`, `warnings`, `actors`, and `entities` are POST
  with `{type, articles}` in the body. **`type:'entities'` maps to the real
  `entities.js` implementation** (ENTITY_DB-based, with relationships) —
  `analyze.js` used to have its own, different, ACTOR_DB-based `'entities'`
  behavior with the same type name, but it was never actually called from
  the frontend (confirmed by grep before merging), so it was dropped rather
  than given a colliding/renamed type value. `correlations`/`warnings`/
  `actors` are preserved verbatim even though they're also currently
  unreachable from the frontend UI — no code was deleted for those, only
  for the one confirmed-dead, name-colliding branch.
- **Predictions + Scenario Simulator + Global Forecast** (`api/intelligence.js`
  `type=predictions`/`simulate`/`forecast`, plus a "⚔ SIMULATE" tab and a
  rebuilt Forecast tab in `index.html`) — positioned to beat a
  community-voting predictions competitor by grounding every probability in
  live reporting + real country data with cited sources, instead of guesses.
  - **`predictions`**: groups live articles into "situations" using the
    same `LOCATION_DB` keyword-matcher this file already used for
    warnings/correlations/brief (`groupArticlesBySituation()`) — the
    situations that make the top-5 list vary with whatever the CURRENT feed
    actually contains, not a fixed list; `LOCATION_DB` only recognizes
    location names in text, it doesn't decide which situations are "active."
    One Groq call returns a question/probability/trend/reasoning/
    keyIndicators object per situation (same "one call for N items" pattern
    already used for correlations/warnings/entities); `sources` are the
    REAL grouped articles attached in code, not something Groq has to get
    right, since a big multi-item JSON array is a worse place to trust
    citation accuracy than analyst.js's single-answer `[A#]` extraction.
    Frontend renders a Conflictly-style split probability bar, trend arrow,
    an expand/collapse reasoning toggle, and real clickable source links,
    with an honest footnote distinguishing "AI-assessed from live
    reporting" from the static heuristic fallback (average threatScore,
    clearly labeled, when Groq is unavailable).
  - **`simulate` mode `conflict`**: self-fetches `${baseUrl}/api/country?code=X`
    for both chosen countries (same self-fetch pattern `analyst.js`/
    `threats.js`/`naval.js` already use) to ground the prompt in REAL
    population/income-level/government-type/leader/allies/rivals data —
    Groq only supplies the higher-level military-comparison/outcome
    narrative itself, clearly labeled a simulation, never presented as
    verified military capability (there's no live military-strength API
    integrated; Groq reasons from the real profile data using its own
    knowledge, the same pattern already established for `api/country.js`'s
    AI-assessed fields). **Checks `isConfigured()` before the self-fetch**,
    not after — a bug caught during testing where the self-fetch ran
    unconditionally even with no Groq key configured, wasting a network
    round-trip on data that would go unused. Cache key sorts the two country
    codes (`simulate:conflict:{sortedCodes}`) so US-CN and CN-US share one
    cache entry — verified live (mocked): querying both orders produced
    exactly one Groq call.
  - **`simulate` mode `whatif`**: no live grounding beyond the user's own
    scenario text — Groq assesses cascade effects directly. Cache key hashes
    the normalized scenario text (`simulate:whatif:{hash}`).
  - **`forecast`**: one Groq call over up to 20 live headlines (labeled
    `[A#]`) asking for the top 3-5 escalating situations plus a short
    global outlook summary; cited article numbers are mapped back to real
    articles the same way `analyst.js`'s `[A#]` extraction works, so
    `sources` are always real, never invented.
  - The Forecast tab's `loadForecast()` was split into four independent
    `render*(el)` functions (predictions, global forecast, risk matrix, AI
    scenarios), each with its own try/catch, instead of one function
    wrapped in a single try/catch — a failure in any one section (e.g. a
    Groq hiccup on predictions) no longer blanks out the other three,
    which the original single-catch design would have done.
  - All three new types are cached the same way as the rest of this file's
    Redis-backed types (Redis first, in-memory fallback, then the real
    work) — verified end-to-end through the real `vercel.json` routing with
    mocked Redis/Groq/World Bank/Wikidata: a cold pass made every expected
    Groq call exactly once (including the self-fetch to the REAL
    `api/country.js` handler for the conflict simulator, round-tripped
    through an actual local HTTP server rather than just unit-invoking the
    handler function), and an identical repeat pass produced zero new Groq
    calls across all three types.
- `/api/news`'s main list is pure `publishedAt`-descending — top of the feed
  is genuinely newest. It used to sort by threatScore first (date only
  broke close ties), which silently overrode publish order; that was
  reported and fixed as a regression (see changelog). `/api/threats.js`
  still needs a severity-first pick for "worst threat per country" — it
  does that with its own local sort on a copy of the articles array now,
  rather than relying on `/api/news`'s exposed order, so it doesn't drift
  again if that order changes for an unrelated reason in the future.
- Guardian's search API (`/api/search`) matches loosely across its whole
  corpus on multi-word queries — `order-by=newest` was returning barely-related
  "whatever's newest that matched anything" results (confirmed live: a
  2-word geopolitical query returned Chris Froome's retirement announcement).
  Fixed with `order-by=relevance` plus a post-fetch relevance filter
  requiring query keywords to actually appear in title/description. The
  first version of that filter required ALL keywords for 2-word queries,
  which overcorrected into rejecting real results ("Pakistan election"
  found nothing because Guardian's genuinely-relevant Pakistan articles
  didn't also say "election") — also reported and fixed as a regression.
  Current rule: 2-word queries need just 1 of the 2 keywords to actually
  appear (still zero tolerance for 0-keyword junk, which is what the
  original bug was); 3+-word queries need a majority (`keywordsRequired()`
  in `api/search.js`). Known remaining gap: multi-word proper nouns
  ("North Korea") count as two separate keyword hits, so a query like
  "North Korea missile" can still let through an article that's only about
  North Korea with no missile content — fixing that needs real entity
  detection, not just keyword counting.
- `/api/naval` never hand-types a ship's position. Only identity (name,
  class, type, nationality, homeport text, expected operating region) is
  hardcoded — that never changes. Position is computed fresh every cache
  cycle: (1) scan `/api/news` articles for the ship's name or region
  keywords, gated by a required naval-context word (`navy`/`carrier`/
  `warship`/etc — without this gate, "USS America" false-matched a July 4th
  anniversary article with zero naval content, confirmed live); (2) extract
  a place from that article's text against a maritime gazetteer (seas/
  straits/major ports — same "keyword → stable coordinate" pattern
  `api/threats.js` uses for country hotspots); (3) if nothing matched this
  cycle, geocode the ship's home port LIVE via Open-Meteo (never a
  hand-typed coordinate); (4) if even that live geocode fails, fall back to
  the gazetteer entry for the ship's own first region keyword, clearly
  tagged `positionBasis:'region-fallback'` rather than silently mislabeled
  as a homeport position. Open-Meteo's geocoding API was confirmed flaky in
  this dev sandbox (timed out on 3/3 direct curl attempts during testing),
  which is exactly the scenario tier (4) exists for.
- Wikipedia enrichment for naval ships needs a descriptive `User-Agent`
  (same Wikimedia policy `api/country.js` already works around for
  Wikidata) or it starts 429ing under any real testing volume. Also,
  Wikipedia's `type:'disambiguation'` field doesn't reliably flag set-index
  list pages ("USS America" comes back `type:'standard'` despite its
  extract literally starting "USS America may refer to:") — checked the
  extract wording instead. A plain opensearch can also confidently resolve
  to the wrong specific (non-disambiguation) article entirely — "Dokdo" (an
  amphibious assault ship) opensearches straight to "Liancourt Rocks", the
  disputed islets it's named after — so the resolved summary is also
  checked for actual ship-related wording (navy/carrier/warship/vessel/...)
  before being accepted; if either check fails, it retries once via
  Wikipedia's full-text search API (real relevance ranking, not prefix
  matching) with the ship's type appended.
- `api/naval.js` self-fetches `/api/news`, which can legitimately take
  close to 9s to aggregate all its sources — give the self-fetch a longer
  timeout (15s) than `/api/news`'s own per-source timeout, or the outer
  fetch aborts before the inner one ever has a chance to finish (this
  shipped once during development: every request silently returned zero
  articles because the two timeouts were racing at the same 9s value).
- Brief Me's voice is ElevenLabs (`api/tts.js`, voice "Adam",
  `eleven_turbo_v2_5`) via `ELEVENLABS_API_KEY`; with no key or on any
  ElevenLabs failure it falls back to the browser's built-in
  speechSynthesis client-side (see `speakBrief()`/`speakBriefFallback()` in
  `index.html`) rather than going silent. That fallback path had two real
  bugs, both caught live in testing and fixed:
  (1) `sp.voice = pref` throws if the matched voice object is ever
  malformed — was uncaught, which left the BRIEF ME button stuck on
  "VOICING..." forever with no way to retry; now wrapped in try/catch.
  (2) when `getVoices()` returns empty (voice list not loaded yet — common
  right after page load), the retry is armed via *both* `onvoiceschanged`
  *and* a `setTimeout(600ms)`, and if the browser's real voice list loads
  within that window both can fire, starting two overlapping utterances
  that fight over playback state — confirmed live as the STOP button
  silently "not working" (it did stop the first utterance, then a second,
  already-armed one started up right after). Fixed with a playback
  generation token (`briefPlaybackToken`, incremented on every stop/new
  request) that every in-flight attempt checks before actually starting to
  speak, so STOP genuinely invalidates anything still pending, not just
  whatever's already playing.
- ElevenLabs' API key was pasted in plaintext mid-conversation once ("I
  will add it, just use process.env.ELEVENLABS_API_KEY" — and the raw
  key). It was never written to any file (`api/tts.js` only ever reads
  `process.env.ELEVENLABS_API_KEY`, no hardcoded fallback like some other
  keys in this repo have). A live end-to-end test using the real key was
  attempted once and was blocked by an agent-safety guardrail against
  embedding raw secrets in shell commands — that's expected/correct
  behavior, not a bug to work around. The no-key fallback path was fully
  verified instead; the ElevenLabs path itself is standard, well-documented
  REST usage and should work once the key is set in Vercel, but has not
  been exercised against the real API in this repo yet.
- `/api/country`'s Wikidata calls occasionally hit a genuine transient
  latency spike well past what's reasonable to make a user wait on —
  confirmed live: a US lookup timed out at the old 9s limit, then the
  *exact same query* came back in ~200-700ms on every other attempt
  (moments later, and consistently since). It's not a per-country
  complexity issue — plenty of "busy" Wikidata entities returned instantly.
  Fixed with a longer timeout (12s), one automatic retry on `/api/country`'s
  Wikidata call specifically, and — since a single blip is expected to be
  transient — a much shorter cache TTL (5min vs the normal 1hr) for any
  result where a source came back partial, so a one-off failure self-heals
  on the next click instead of showing missing fields for an hour.
- `/api/country` fills 5 "analytical" fields Groq covers that World
  Bank/Wikidata never will — `elections`, `politicalLeaning`,
  `governmentType`, `keyAllies`, `primaryRivals` — with exactly one Groq
  call per country, only for whichever of those are still `null` after the
  small hardcoded `ELECTIONS`/`POLITICAL_LEANING` tables and live sources
  are checked (`governmentType`/`keyAllies`/`primaryRivals` have no
  hardcoded source at all, so they're AI-filled for every country; the
  other two only for the ~20 not in the hardcoded tables). **Live/hardcoded
  data always wins** — the merge step explicitly skips any field that's
  already non-null before considering the AI's value, so a real value can
  never be clobbered by a guess (verified live: US's hardcoded `elections`/
  `politicalLeaning` survived unchanged while a mocked AI response tried to
  overwrite them). Fields the AI actually supplied are listed in the
  response's `aiFields` array so `index.html`'s `row()` helper can label
  them with a trailing `*` and muted color instead of presenting them as
  live fact, plus a one-line "* AI-assessed" footnote when the panel has
  any. The whole AI-filled result is cached inside the same per-country
  cache entry as everything else (no separate cache), so a country is only
  ever sent to Groq once per cache TTL, not once per click (verified: 3
  requests for the same country produced exactly 1 Groq call). If Groq has
  no key or fails (including after the shared helper's own primary→fallback
  model retry), the 5 fields simply stay `null` and render as `—`, same as
  before this feature existed — no error surfaces to the panel.

### Testing approach
No Vercel account access has been available in any session — nothing has
been verified against a real deployment. Instead: `node --check` for
syntax, a local Node shim that parses `vercel.json`'s `routes` array and
dispatches exactly like Vercel would (most accurate), plus Playwright
against that shim for real browser behavior. Real live external APIs are
hit directly wherever possible rather than mocked.

## Active issues
None currently known/reported as broken. (Intel Search's multi-word-proper-noun
gap is a documented known limitation, not an active bug — see gotchas above.)

**Unverified**: real Vercel deployment behavior — the `x-forwarded-proto`
self-fetch header pattern, `functions.maxDuration` config, and Vercel's
exact `routes` matching semantics are all inferred from docs/local
emulation, never confirmed against a live deployment.

## Next priorities
None queued — each session has worked from its own task list rather than a
standing backlog.

## Changelog
- 2026-07-04 (19): Added a Predictions + Scenario Simulator system,
  positioned to beat a community-voting predictions competitor (Conflictly)
  by grounding every probability in live reporting + real country data with
  cited sources instead of crowd guesses. Three new `api/intelligence.js`
  types, kept under the 12-function cap by staying in the same merged
  endpoint: `predictions` (AI-assessed probability cards per live situation,
  derived from whatever the current feed actually contains — not a fixed
  list — via the same `LOCATION_DB` grouping already used for warnings/
  correlations, one Groq call per batch, real articles attached as sources
  in code rather than trusting Groq's citation accuracy in a multi-item
  array), `simulate` (two modes: `conflict` self-fetches both countries'
  real `/api/country` profiles to ground an AI war-game briefing, `whatif`
  runs a free-text hypothetical through Groq for a cascade-effect
  breakdown), and `forecast` (a global "next 30-90 days" outlook, top 3-5
  escalating situations with `[A#]`-cited real sources). All three cached
  via the existing Redis layer with their own TTLs (predictions 30min,
  forecast/simulator 1h) — `simulate`'s cache key is per-request (sorted
  country-code pair, or a hash of the "what if" text) since unlike the
  flat-key types, different simulator inputs are genuinely different
  results. Frontend: rebuilt the Forecast tab's `loadForecast()` into four
  independently-failing sections (predictions, global outlook, risk matrix,
  AI scenarios — previously one function under a single try/catch, so one
  Groq hiccup used to blank out all of it) with Conflictly-style split
  probability bars, trend arrows, and expandable reasoning; added a new
  "⚔ SIMULATE" tab (country-vs-country dropdown + free-text "what if" input,
  never auto-run at boot — only on click, per the task's "on-demand" spec).
  Every AI-generated result is explicitly labeled ("* AI-assessed from live
  reporting", "AI simulation for analysis — not a prediction of real
  events") rather than presented with fake statistical precision. Caught
  and fixed one real bug during testing: the conflict simulator was
  self-fetching both countries' `/api/country` data unconditionally, even
  when Groq wasn't configured and the data would go unused — moved the
  `isConfigured()` check before the self-fetch. Verified end-to-end through
  the real `vercel.json` HTTP routing (not just unit-invoking handlers)
  with mocked Redis/Groq/World Bank/Wikidata: a cold pass made every
  expected Groq call exactly once, including a genuine round-trip
  self-fetch from `intelligence.js` through an actual local HTTP server to
  the real `api/country.js` handler (not mocked at that boundary); an
  identical repeat pass produced zero new Groq calls across all three new
  types, and reversing the two countries in a conflict simulation (CN-US
  vs US-CN) correctly hit the same cache entry. No live `GROQ_API_KEY` or
  Upstash account was available in this sandbox, so all of the above was
  verified against mocked responses — the real Groq output quality (are
  the probabilities/reasoning actually good) is unverified here.
- 2026-07-04 (18): Added persistent shared caching via Upstash Redis
  (`lib/cache.js`, repo root — outside `api/` so it never counts as a
  Serverless Function, same reasoning as `lib/ai.js`). Every endpoint that
  makes a live/AI call now checks Redis first, with tiered TTLs matched to
  how often each kind of data actually changes (7d for country static
  facts, 12h for country leadership, 24h for AI-assessed country fields,
  30s-30min for the various news/threats/forecast/entities/aircraft/naval
  feeds, 1h for Brief Me, 15min for AI analyst answers — full table in the
  gotchas section). `getCache`/`setCache` never throw: a missing Upstash
  config, a non-2xx, or a network error all resolve to `null`/`false`, so
  every endpoint falls through to its own pre-existing in-memory cache and
  then a live call exactly as before this feature existed — verified by
  simulating a total Redis outage (every Redis call throwing) and
  confirming all 8 touched endpoints still returned 200 through the real
  `vercel.json` routing. `api/country.js` got the most substantial rework:
  its single combined 1hr/5min in-memory cache became 3 fully independent
  Redis-backed buckets (static/leadership/AI-assessed) so a 12h-old leader
  can refresh without waiting on 7-day-cached population data — caught and
  fixed a real bug while building this, where the split-bucket design
  naively made 2 separate Groq calls (one per bucket) for any country
  needing both an AI-filled election date and AI-filled
  leaning/allies/rivals; fixed to make exactly one shared Groq call and
  split its response across both buckets. Also made one deliberate,
  documented deviation from the task's literal instructions: the AI
  analyst's cache key hashes `question + sanitized history` together
  rather than the question alone, because hashing only the question would
  let two unrelated conversations' generic follow-ups ("tell me more about
  that") collide and serve each other's wrong cached answer. Verified
  end-to-end through the real `vercel.json` HTTP routing shim with mocked
  Redis (a real in-memory Map simulating Upstash's actual GET/SET/EX
  semantics) and mocked Groq/World Bank/Wikidata/Guardian/GDELT/RSS/
  OpenSky: a cold first pass correctly populated all 12 expected Redis keys
  and made every expected live/AI call exactly once; an identical second
  pass produced *zero* new live/AI calls across every cached endpoint.
  No live Upstash account was available in this sandbox, so the real
  Upstash REST API's exact request/response shape is unverified here —
  `lib/cache.js` was built from the task's explicit description of that
  shape, and every failure mode (network error, non-2xx, malformed value)
  is swallowed identically regardless of what the real API actually
  returns, so a shape mismatch would show up as "cache never hits, always
  falls through to live calls" rather than a crash.
- 2026-07-04 (17): Country intel panel used to show "—" for `Next Elections`
  and `Political Leaning` for most countries (only ~20 hardcoded), and had
  no `Government Type`/`Key Allies`/`Primary Rivals` fields at all. Added
  one Groq call per country in `api/country.js` (`fillGapsWithAI()`, shared
  `askAI` helper) that fills whichever of those 5 fields are still `null`
  after live sources + the existing hardcoded tables — never overwriting a
  real value (checked field-by-field before accepting the AI's answer).
  Response now includes `aiFields: string[]` naming which fields came from
  Groq; `index.html`'s country panel labels those with a trailing `*` +
  muted color and a "* AI-assessed" footnote, so AI-derived fields are never
  presented as live fact. The AI result rides along in the same per-country
  cache entry `api/country.js` already had (1hr full / 5min partial TTL),
  so it's one Groq call per country per cache period, not per click.
  Added `api/country.js` to `vercel.json`'s `maxDuration:30` list since it
  now makes one more sequential network call after an already-borderline
  Wikidata-retry chain. Verified: US/Romania/Nigeria/Vietnam all populate
  the 5 fields correctly against real live World Bank/Wikidata data with a
  mocked Groq response (US's hardcoded `elections`/`politicalLeaning`
  provably survived a mocked AI response that tried to overwrite them —
  only `governmentType`/`keyAllies`/`primaryRivals` came from AI for US, all
  5 did for the other three); cache-hit test confirmed exactly 1 Groq call
  across 3 requests for the same country; no-key and Groq-failure paths
  both confirmed to degrade to `null`/`—` with no error surfaced, matching
  pre-existing behavior. No live `GROQ_API_KEY` was available in this
  sandbox, so all Groq responses above were mocked — the real Groq success
  path (a genuine model-generated answer) is unverified here.
- 2026-07-04 (16): Fixed a Vercel Hobby-plan build failure ("No more than 12
  Serverless Functions can be added on the Hobby plan"). Root cause: every
  `.js` file under `api/` counts as one function regardless of subdirectory,
  and the prior session's `api/lib/ai.js` (a shared, non-endpoint helper)
  pushed the real count to 13. Fixed two ways: (1) moved the shared Groq
  client to a repo-root `lib/ai.js` (outside `api/` entirely, so Vercel
  never sees it as a function) and updated `analyst.js`/`search.js`'s
  `require` paths to `../lib/ai`; (2) consolidated `analyze.js`,
  `entities.js`, `forecast.js`, and `acled.js` — four separate functions —
  into one new `api/intelligence.js`, routed by a flat `type` value
  (`risk_matrix`/`acled` as GET+query, `scenarios`/`brief`/`correlations`/
  `warnings`/`actors`/`entities` as POST+body). `api/` now has 9 files
  (news, threats, country, intelligence, search, aircraft, analyst, naval,
  tts), well under the 12-function cap with headroom for future endpoints.
  No feature was lost: every prompt, fallback path, and response shape from
  the four merged files is preserved verbatim in `intelligence.js` (verified
  by testing all 8 `type` values — including AI-backed ones against a
  mocked Groq response — through both the real handler directly and the
  real HTTP routing shim that parses `vercel.json` exactly like Vercel
  would). The one intentional exception: `analyze.js` had a second, dead,
  ACTOR_DB-based `'entities'` behavior that collided by name with the real,
  used `entities.js` implementation — confirmed via grep that the frontend
  never called it, so it was dropped rather than kept under a colliding
  type value (see gotchas). Updated all 5 frontend call sites in
  `index.html` to the new `/api/intelligence?type=...` routes, and fixed two
  stale user-facing strings still mentioning `ANTHROPIC_API_KEY` (missed by
  the prior session's case-sensitive grep since they were all-caps) to say
  `GROQ_API_KEY` instead. Updated `vercel.json`'s routes array accordingly;
  no `functions.maxDuration` entries were needed for `intelligence.js` since
  none of its paths approach the default timeout.
- 2026-07-04 (15): Migrated every AI-backed endpoint off Anthropic and onto
  Groq's free tier (Anthropic account ran out of credits). Added
  `api/lib/ai.js`, a shared `askAI({system, messages, maxTokens, timeoutMs})`
  client for Groq's OpenAI-compatible `chat/completions` endpoint
  (`llama-3.3-70b-versatile` primary, automatic one-shot retry against
  `llama-3.1-8b-instant` on any failure), and rewired `analyst.js`,
  `analyze.js`, `entities.js`, `forecast.js`, and `search.js` to call it
  instead of each hand-rolling its own Anthropic fetch. Preserved every
  existing prompt and all surrounding logic unchanged — only the API-call
  layer was swapped, per the task's explicit instruction — including
  `analyst.js`'s `[A#]` citation-extraction logic (verified below) and the
  history-sanitization pass (still needed: Groq's chat/completions is just
  as strict about user/assistant alternation as Anthropic was). Handled the
  one real shape difference: Groq's `system` is an OpenAI-style
  `{role:'system',...}` message, not Anthropic's top-level `system` param
  — `askAI` builds that message internally so callers just pass a plain
  `system` string (or omit it, since `analyze.js`/`forecast.js`/`search.js`
  never used a system prompt). No live `GROQ_API_KEY` is available in this
  sandbox, so the real Groq success path is unverified here — instead
  verified: (1) the `askAI` helper itself against a mocked Groq response,
  covering the with-system/without-system message shape, the primary-model-
  fails-falls-back-to-secondary-model path, and the no-key-configured throw;
  (2) `analyze.js`/`entities.js`/`forecast.js`'s no-key fallback path
  through their real handlers; (3) `analyst.js`'s full flow end-to-end
  through the real handler with mocked Groq + mocked `/api/news`+`/api/threats`
  self-fetches, confirming the `[A1]`-style citation extraction still
  correctly maps back to the real article's title/url/source after the
  swap. No `vercel.json` changes needed — `api/lib/ai.js` is a shared
  module, not a routable endpoint.
- 2026-07-04 (14): Fixed the AI Analyst's "Anthropic API 400" error — root
  cause was `claude-sonnet-4-20250514`, deprecated and retired 2026-06-15,
  hardcoded across all five Claude-backed endpoints (confirmed via the
  current model catalog: `claude-sonnet-5` is the live replacement).
  `askClaude()` also used to throw only the HTTP status with no body,
  making this genuinely undiagnosable from the surfaced error alone — now
  reads and logs the real Anthropic error JSON (verified live against the
  real API with a deliberately-invalid key: the fix correctly surfaces
  Anthropic's actual `{type:"authentication_error",...}` body instead of a
  bare "Anthropic API 401"). Migrating models also surfaced a latent bug
  every one of these five files shared: they all extracted the answer via
  `content?.[0]?.text`, which breaks the moment adaptive thinking is on
  (Sonnet 5's default when `thinking` is omitted) because the first block
  becomes an empty `thinking` block, not the answer — fixed by explicitly
  setting `thinking:{type:'disabled'}` (these are short grounded-citation
  tasks with no need for deep reasoning) and finding the text block by
  type instead of assuming index 0. Also hardened `analyst.js`'s history
  sanitization to drop empty-content turns, collapse any accidental
  same-role-twice run, and never let history itself end on 'user' before
  the new turn is appended — belt-and-suspenders against the "roles must
  alternate" 400 even though the frontend was already building history
  correctly. `entities.js` and `forecast.js` had a related silent bug
  (parsed `.content` without checking `r.ok`, so a failed request quietly
  returned an empty "successful" result instead of falling back) — fixed
  alongside the model swap since it's the same call site. No live
  ANTHROPIC_API_KEY has been available in any session, so the success path
  (a real question getting a real grounded answer) is unverified — the
  no-key fallback path and the full frontend request/response plumbing
  were verified end-to-end via Playwright instead.
- 2026-07-04 (13): Fixed three reported regressions, all confirmed live
  before and after. (1) Intel Search's relevance filter (added session 10)
  had overcorrected: requiring ALL keywords for 2-word queries rejected
  real results ("Pakistan election" found nothing because Guardian's
  genuinely-relevant Pakistan articles didn't also say "election").
  Loosened to require just 1 of 2 keywords for 2-word queries (3+-word
  queries still need a majority); nonsense queries still correctly return
  zero results. (2) `/api/news`'s Briefing feed sorted by threatScore
  first, so "top of feed" wasn't "newest" — now pure `publishedAt`-
  descending. `/api/threats.js` depended on that exposed order to pick the
  worst threat per country, so it got its own local severity sort on a
  copy of the articles first, decoupling it from the feed's now-different
  order. (3) `/api/country` was showing blank fields for some countries —
  root-caused live to Wikidata occasionally timing out at the old 9s limit
  on a purely transient basis (the exact same query came back in
  ~200-700ms on every other attempt) and then caching that partial result
  for a full hour. Fixed with a longer timeout (12s), one automatic retry
  on the Wikidata call, and a much shorter cache TTL (5min) for any partial
  result so a one-off failure self-heals quickly instead of showing
  missing fields for an hour. US/France/Nigeria/Kazakhstan/Vietnam all
  verified showing complete data.
- 2026-07-03 (12): Replaced Brief Me's robotic browser speechSynthesis
  with real TTS — `api/tts.js` proxies ElevenLabs (voice "Adam",
  `eleven_turbo_v2_5`) via `ELEVENLABS_API_KEY`, returning raw `audio/mpeg`
  that the frontend plays through a hidden `<audio>` element, with a new
  STOP button and a generating/voicing/speaking state machine on the BRIEF
  ME button itself. No key or any ElevenLabs failure falls back to browser
  speechSynthesis (never silent) — and that fallback path had two real,
  previously-latent bugs surfaced by testing the new stateful UI against
  it: an uncaught exception on a malformed voice object could strand the
  button on "VOICING..." forever, and a double-arm race
  (`onvoiceschanged` + `setTimeout`) could start a second utterance right
  after STOP had already stopped the first. Both fixed (try/catch +
  a playback generation token that invalidates anything still in flight
  when STOP or a new brief request supersedes it). `ELEVENLABS_API_KEY` is
  read from env only, never hardcoded, per this repo's existing key
  convention.
- 2026-07-03 (11): Added a naval ship tracker (`api/naval.js` + "🚢 NAVAL"
  layer). ~41 major warships/carrier groups by identity only (name/class/
  type/nationality/homeport text — reference data that never changes).
  Position is never hand-typed: computed every cache cycle from a live
  `/api/news` self-fetch (name or region-keyword mention, gated by a
  required naval-context word after "USS America" false-matched a July 4th
  article in testing), a maritime gazetteer for extracting place names from
  the matched article's own text, live Open-Meteo geocoding of the ship's
  home port when nothing matched, and a labeled last-resort gazetteer
  fallback if even that geocode fails. Click a ship for a detail card
  (styled like the country intel panel) with a live Wikipedia photo +
  description, resolved through a disambiguation-busting retry (opensearch
  first, then Wikipedia's full-text search + a ship-context check) after
  plain opensearch confidently resolved "Dokdo" to the disputed islets
  instead of the ship. All verified live end-to-end via Playwright,
  including with Open-Meteo genuinely unreachable mid-session (confirmed
  via direct curl) to exercise the fallback chain for real.
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
