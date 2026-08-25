# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AURA — a Korean couple's date-planner PWA. Static site, no backend, no build step, no bundler.
Three files carry almost the entire app: [`app.js`](app.js) (~6300 lines), [`index.html`](index.html)
(~960 lines), [`style.css`](style.css) (~2600 lines), plus a tiny [`sw.js`](sw.js) service worker.
Deployed (not via CI) to GitHub Pages at `https://soulrsp.github.io/Dating-Planning-Agent/`. This
directory is a git repository tracking `origin/main` at `github.com/soulrsp/Dating-Planning-Agent` —
Claude Code can commit and push directly here (with the user's confirmation per its normal push-safety
rules); a push to `main` deploys to GitHub Pages. **Never commit `API 모음.txt`** (real Naver/Gemini/
Supabase secrets in plaintext) — it's already in `.gitignore`, but double-check before any `git add`
that touches the repo root.

Persistence is entirely Firebase Realtime Database (REST polling, not the SDK's live listeners) plus
Dexie.js (IndexedDB) as the local cache. There is no server-side code anywhere.

## Running locally

```bash
python -m http.server 8123
```

This matches `.claude/launch.json` (`aura-static`, port 8123) so `preview_start` picks it up
automatically. There is no test suite, linter, or build command — the only mechanical check available
is `node --check app.js` for syntax validation before calling a change done.

## Critical workflow rule: cache-busting version bump

`index.html` loads `style.css?v=<version>` and `app.js?v=<version>`, and `sw.js` has its own
`CACHE_NAME` containing the same version string. **Every one of the three must be bumped together on
every change that touches `app.js`, `index.html`, or `style.css`**, or returning users get a stale
cached copy. Grep the current version (`grep -n "v=[0-9]" index.html`) and bump all three references by
one in lockstep — there's no script for this, it's manual.

## Auth & multi-tenant "room" model

- The whole app is gated behind Firebase Auth (Google Sign-In) via a `setupAuthGate()` IIFE at the top
  of `app.js`. Any signed-in Google account passes this client-side gate — **actual authorization is
  enforced by Firebase Realtime Database security rules** (an email allowlist keyed by room, checked
  server-side against `auth.token.email`), not by any check in the JS. Don't try to add
  client-side email allowlisting; the rules are the source of truth and live in the Firebase console,
  not in this repo.
- Multiple couples share one deployment via a `?room=<id>` query param (`syncRoomId`, default `"0"`).
  All cloud data is namespaced under `aura-rooms/{roomId}/...` (`places`, `photos`, `timestamp`), and
  all `localStorage` cache keys that must not bleed between rooms are suffixed with the room id (see
  `memoryPhotosStorageKey()`, `photosVersionStorageKey()` etc. near the top of `app.js`).
- Every Firebase REST call must carry the signed-in user's ID token as `?auth=`. This is done once via
  a `window.fetch` monkey-patch (`patchFetchForAuth()`, right after the auth gate) rather than at each
  of the ~20 call sites — don't hand-add `auth=` params to new fetch calls, the patch already does it
  for any URL starting with `getFirebaseDbUrl()`.
- Sync is a polling loop (`startCloudSyncLoop()`, section 12), not Firebase's realtime `on()` listeners
  — deliberately, to stay inside the free-tier download quota for a 2-person app. Keep new sync-related
  work on this poll-and-diff model rather than switching to live listeners.

## API keys: public vs. secret

- Naver Maps Client ID and the Kakao JS key are public, domain-restricted keys — safe to ship in
  client code (the Ncloud/Kakao console domain allowlist is the actual defense).
- Gemini API key and the TourAPI (data.go.kr) key are real secrets. They are **never hardcoded** —
  each user pastes their own into the Settings tab, which stores it in `localStorage` only
  (`aura_gemini_key`, `aura_tourapi_key`) and it is never synced through the room's cloud settings.
  Follow this pattern for any new external API key: local-only, entered via Settings, never committed.
- `secrets/` (gitignored) holds the maintainer's own keys/notes for reference — don't read from it to
  wire up features, and never echo its contents into code or commit history.

## Dual map system

The app supports both Naver Maps JS SDK and Leaflet as a fallback, switched on at runtime by whether a
Naver Client ID is configured (`isNaverMapActive` flag, set in the "Dynamic Map Loader Engine", section
5). Most map-touching code (markers, popups, centering) has **parallel branches for both**, e.g.:

```js
if (isNaverMapActive && map) { /* naver.maps.Marker / InfoWindow */ }
else if (map) { /* Leaflet L.marker / bindPopup */ }
```

When adding anything that touches the map, implement both branches — shipping only the Naver path is a
common mistake here since Naver is the default in testing but Leaflet is the real fallback for anyone
without a Naver key configured.

## `app.js` layout

The file is organized as sequentially numbered sections via `// N. Section Name` comments (numbering
has some historical drift/dupes — trust the comment text over the number):

1. Dexie DB init (single `places` table, schema in `db.version(2).stores(...)`)
2. State & settings variables (all the `localStorage`-backed globals)
3. `DOMContentLoaded` init — blocks on the auth gate before anything else runs
4. Tab navigation (`switchTab()` — tabs are shown/hidden via CSS class, **never torn down**, so
   per-tab state like AI chat history survives switching away and back)
5. Dynamic map loader (Naver SDK / Leaflet fallback, Kakao Places SDK loader)
6. In-app map search pipeline — cascades through Local KB → Naver Geocoder → Naver POI API → AI →
   Nominatim
7. Coordinate parsing from pasted map URLs
8. Modal management (quick-add / visit-logging)
9. Photo compression pipeline (canvas-based, max 2560px / 90% quality)
9b. Festival/event feed — TourAPI-backed, cached in Firebase and shared across **all** rooms/couples
    (not room-scoped, unlike everything else)
10. Places render list (wishlist/visited cards)
11. Dashboard analytics
12. Real-time couple sync engine (Firebase REST polling — see above)
13. AI chatbot interface (Gemini-backed date-course planner)
14. Settings logic
15. UI helpers, calendar/memory gallery engines, mobile pairing/QR modal

## Gemini integration notes

`callGeminiRaw()` does **not** hardcode a single model name — Google periodically retires model
versions, which has broken this app before. It first calls `GET .../v1beta/models` to discover
currently-available `flash`-family models for the user's own key, then falls back to a static
`GEMINI_CANDIDATE_MODELS` list, trying candidates in order until one works. Both the discovery call and
each `generateContent` call are wrapped in `AbortController` timeouts (5s / 20s) — an earlier bug
(unguarded discovery fetch hanging forever) taught that every Gemini network call here must have an
explicit timeout, since `fetch()` has none by default. Retryable failures (404 "not found", 429/quota,
503/"overloaded"/"high demand") fall through to the next candidate rather than failing the whole
request; treat any new Gemini error class the same way unless it's clearly non-retryable.

## The `notes` field convention

`db.places` has a single free-text `notes` field, and it is rendered as the **address** ("주소:") on
every place card across the app (wishlist, visited, festival items, AI-course saves — see
`cleanAddress` regex-strip usage in the render functions). There is no separate description/memo
field. When building a feature that saves a `db.places` row from an external data source (TourAPI
festival, AI-planner course, etc.), put the actual address string in `notes` — never a description or
other text — or it will display as a garbled "address" everywhere that place is shown.

## TourAPI festival feed gotchas

- The public `areaCode` filter on TourAPI's `searchFestival2` is unreliable — many real, current
  festivals have an empty `areacode` field even when `addr1` clearly shows the right region. The feed
  fetches nationwide (paginated) and filters client-side on `addr1`.
- Region matching must use `.startsWith()` against full 시/도 names (`FESTIVAL_AREA_PREFIXES`), not
  `.includes()` — a substring check on "세종" false-matches "서울특별시 중구 세종대로" (a Seoul street
  name unrelated to Sejong City).
- Long-running "always on" listings are excluded via a max-duration filter
  (`FESTIVAL_MAX_DURATION_DAYS`) so they don't permanently camp at the top of the date-ascending sort.
- The feed is cached once per calendar day in Firebase (shared across all rooms) — a code fix deployed
  later the same day won't self-trigger a re-fetch; there's a manual refresh button in the UI for that.

## Search noise

`backup/` and `archive/` hold full historical snapshots of `app.js`/`index.html` and are excluded from
this repo's default search via `.ignore` and `.gitignore` — searches here return the live files only,
not every past version. Search `backup/`/`archive/` explicitly by path if you actually need old
revisions.
