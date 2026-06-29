### Last session
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

### Next session priorities
- Priority 1
- Deploy latest commit and re-run full live tab audit on production; verify no tab shows `Unexpected token '<'` or request failures.

- Priority 2
- Add automated tab smoke tests (Briefing, Warnings, Analytics, Intel Map, Conflicts, Forecast, Leaders, Mideast) in CI.

- Priority 3
- Add endpoint contract checks to ensure API routes always return JSON and detect HTML fallback/routing regressions immediately.
