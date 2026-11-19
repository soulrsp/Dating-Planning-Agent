# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Language: always answer the user and ask questions in Korean (한국어)** — progress notes, reports,
plans and questions included. Code, code comments and commit messages stay in English.

## What this is

AURA — a Korean couple's date-planner PWA. Static site, no backend, no build step, no bundler.
Four files carry almost the entire app: [`app.js`](app.js) (~8000 lines), [`studio.js`](studio.js)
(~2400 lines, the 사진 꾸미기 photo studio — see its section below), [`index.html`](index.html) (~1250 lines),
[`style.css`](style.css) (~3300 lines), plus a tiny [`sw.js`](sw.js) service worker. Smaller feature files
load after them as plain scripts: [`couple.js`](couple.js) (오늘의 우리), [`together.js`](together.js)
(버킷리스트 + 서로 사용 설명서) and [`course.js`](course.js) (the AI 플래너 tab) — see their sections below.
Served from two places (neither via CI): **Firebase Hosting** at `https://dating-planning-agent.firebaseapp.com/`
(the primary one — it shares an origin with the Firebase Auth helper, which is what makes Google sign-in
work on iOS Safari) and GitHub Pages at `https://soulrsp.github.io/Dating-Planning-Agent/` (legacy; sign-in
fails on iOS Safari there because the sign-in state lives on a different origin). This directory is a git
repository tracking `origin/main` at `github.com/soulrsp/Dating-Planning-Agent` — Claude Code can commit
and push directly here (with the user's confirmation per its normal push-safety rules); a push to `main`
deploys to GitHub Pages only. Updating Firebase Hosting is a separate step: `node deploy-hosting.js`, which
copies an explicit whitelist of files (not the whole directory — it also holds `secrets/` and
`API 모음.txt`) into `.hosting-dist/` and runs `firebase deploy --only hosting`. **A new top-level file must be
added to `FILES` in `deploy-hosting.js`** or Hosting will 404 it (`node deploy-hosting.js --no-deploy` shows
the list). It uses the user's own `firebase login`; the user has allowed Claude to run it after a push they
approved, as a standalone command, exactly `node deploy-hosting.js` (the allow rule doesn't match it
chained with `&&`). Afterwards, confirm the live `app.js?v=` changed. `localStorage`/IndexedDB are per-origin,
so each URL has its own Gemini/TourAPI keys and local cache; open the new URL with `?room=<id>` once. **Never commit `API 모음.txt`** (real Naver/Gemini/
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
is `node --check app.js && node --check studio.js && node --check couple.js && node --check together.js && node --check course.js`
for syntax validation before calling a change done.

## Critical workflow rule: cache-busting version bump

`index.html` loads `style.css?v=<version>` and every script (`app.js`, `studio.js`, `couple.js`, `together.js`,
`course.js`) with `?v=<version>`, and registers `sw.js?v=<version>`; `sw.js` has its own `CACHE_NAME` containing the
same version string. **All of them must be bumped together on every change that touches any of those files**,
or returning users get a stale cached copy. Simplest is to replace the version string everywhere at once
(`sed -i "s/<old>/<new>/g" index.html sw.js`) and grep it back (`grep -n "v=[0-9]" index.html`).
There's no script for this; it's manual.

## Auth & multi-tenant "room" model

- The whole app is gated behind Firebase Auth (Google Sign-In) via a `setupAuthGate()` IIFE at the top
  of `app.js`. Any signed-in Google account passes this client-side gate — **actual authorization is
  enforced by Firebase Realtime Database security rules** (an email allowlist keyed by room, checked
  server-side against `auth.token.email`), not by any check in the JS. Don't try to add
  client-side email allowlisting; the rules are the source of truth and live in the Firebase console,
  not in this repo.
- Email + password sign-in exists for where Google sign-in can't run (Naver/KakaoTalk webviews block
  Google OAuth; the iOS home-screen icon hangs on redirect). There is no sign-up: a person signed in with
  Google sets a password in Settings (`auraSetPassword`), which `linkWithCredential`s it to the same
  Firebase user, so the token's email — and the room rule — stay the same.
- Multiple couples share one deployment via a `?room=<id>` query param (`syncRoomId`, default `"0"`).
  All cloud data is namespaced under `aura-rooms/{roomId}/...` (`places`, `photos`, `timestamp`), and
  all `localStorage` cache keys that must not bleed between rooms are suffixed with the room id (see
  `memoryPhotosStorageKey()`, `photosVersionStorageKey()` etc. near the top of `app.js`).
- The local Dexie `places` table is **not** room-scoped — rows have no room id, and there is one DB per
  browser origin. `ensureLocalDbMatchesRoom()` records which room it holds (`aura_local_db_room`) and
  empties it when a different room is opened (startup and the Settings room switch), so one room's
  places/photos never show up in, or get pushed to, another. Anything new that reads `db.places` can
  rely on that; don't add a second per-room mechanism alongside it.
- **Room settings go up only on [설정 저장]** (`saveSettingsToCloud`). Until v426 every start-up pushed this
  phone's names/dates/map keys, so a phone that had opened an empty room wiped the couple's dates and
  swapped the map key for both. Room 77's map keys are pinned in code (`PINNED_MAP_KEYS`), and a blank
  cloud `dates` never overwrites a phone that still has them (it re-uploads its copy instead).
- **Place text is written field by field.** `triggerSyncUpload(id, fields)` takes the keys an edit actually
  changed and `savePlaceToCloud` PATCHes just those (when the node already exists); `triggerSyncUpload(id)`
  with no list writes the whole record (new place, rename, delete). The pending field list survives in
  `aura_pending_place_fields` so a retry after a reload writes the same thing. Never submit a whole form
  over a cloud node: a blank or stale local copy of a field the person didn't touch would erase it for
  both people. `handleEditPlaceSubmit` diffs against the stored row and skips saving when nothing changed.
- **Photos are replaced as a whole list.** A place's photos live in one cloud node (`photos/{nameKey}`),
  and any photo add/remove uploads this device's whole list over it, last write wins. Before replacing it,
  call `photoBaselineProblem(place)` (it checks the device's last-synced `photoVersion` against the cloud's
  and refuses while a download is running); if it returns a message, show it, call `kickPhotoResync()` and
  write nothing. `handleEditPlaceSubmit` only touches photos when they changed or the place is renamed.
- **A photo's string is not its identity.** Before v391 the edit screen re-compressed every existing photo
  on each save, so the same picture exists as different base64 strings on different devices; comparing
  photos with `===` makes a merge add every one of them again (that doubled a 65-photo album to 138). To
  ask "does the other list already have this picture?" use `photoThumb` + `samePhoto`
  (`SAME_PHOTO_MAX_DIFF`, calibrated in its comment), and only ever compare ACROSS two lists — an album can
  legitimately hold two near-identical shots, so never dedupe within one list by looks.
- **Recovery mode (`?room=<id>&recover=1`)** replaces the app with `runRecoveryMode()`: no cloud pulls, no
  cleanup, no wipe, so a device that still holds a lost copy can be opened without destroying it. It lists
  this device's places and pushes text (`savePlaceToCloud`) and photos (`uploadPhotoToCloud`) back up
  separately, refusing a photo push that would shrink the cloud's list. Local rows are append-only
  relative to the cloud (a place deleted *without* a tombstone survives on other devices), which is what
  makes this recovery possible.
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
- Gemini API key and the TourAPI (data.go.kr) key are real secrets. They are **never hardcoded or
  committed**. Since v425 they are entered once in 설정 → 고급 → [키 저장] and shared per room at
  `aura-rooms/{room}/keys` {gemini, tourapi, updatedAt} (`loadRoomKeys` / `auraSaveRoomKeys` in app.js);
  the room rule's email allowlist means only that couple can read them. `localStorage`
  (`aura_gemini_key`, `aura_tourapi_key`) is just a cache, and a phone that has a key the room lacks
  uploads it. The fields never show a stored key back. Keep them out of `saveSettingsToCloud`'s
  room-level PATCH. A new external API key follows the same pattern: `keys/`, entered via Settings.
  The Naver map / Kakao keys are public and no longer have Settings fields (defaults in app.js, room
  overrides via the synced `naverClientId` / `kakaoApiKey`).
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

## Tab layouts (v438+)

Every tab opens with a gradient hero card (`.tab-hero`, filled by its renderer) and a tools row (`.tab-search` +
`.tab-round-btn`). 위시리스트 = one-line rows grouped 다가오는 약속 / 언젠가 / 지난 날짜 that open in place
(`wishRowHtml`, open state in `wishOpenRows`). 다녀온 곳 = full-width photo cards grouped by month (two photos side by side, both comments; v446)
(`visitedCardHtml`). 갤러리 = [추억 앨범 | 꾸민 사진] segments (`setGallerySeg`, per device) with photos grouped by
place. AI 플래너 = four tiles that open one field each (`coursePlan.openField`). Place photos open as a bottom
sheet (`#modal-gallery-slider`, still driven by `openGallerySliderModal` / `updateGallerySliderUI`). Shared helpers:
`placeCategoryLook` (emoji, tint, Korean label), `shortPlaceDate`, `placeRegion`.

## `app.js` layout

The file is organized as sequentially numbered sections via `// N. Section Name` comments (numbering
has some historical drift/dupes — trust the comment text over the number):

1. Dexie DB init (`places` table, plus `creations` for the photo studio since `db.version(3)`)
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
13. AI 플래너 leftovers: the API-key banner, `cleanAndParseJSON`, and the course map-pin / save-to-wishlist
    helpers (`aiCoursePlacesStore`, `viewCoursePlaceOnMap`, `openCourseSaveDateModal`) that `course.js` calls.
    The old free-text chat is gone (v415).
14. Settings logic
15. UI helpers, calendar/memory gallery engines, mobile pairing/QR modal
16. (moved out) Photo Studio, now [`studio.js`](studio.js)

## Photo Studio (`studio.js`)

사진 꾸미기 lives in its own file, loaded right after `app.js` as a plain script; the two share one
global scope. `app.js` only calls into it (`syncCreations`, `renderCreationsSection`) behind
`typeof … === "function"` guards, so the rest of the app survives if it fails to load. The Dexie
`creations` table is still declared in `app.js` section 1 (one schema, one place). Inside, the parts are
headed `// ── …` comments: layouts/filters/patterns → base render → stickers & text overlays → AI 꾸미기
→ 움직이는 사진 (video) → 카톡 프사 maker → painting effects & 뽀샤시 → 얼굴 보정 → photo picker →
꾸민 사진 cloud album.

- **Shared global scope bites.** A top-level `const`/`let`/`function` in either file shadows a
  `window` property of the same name for every script. A `const kakao` in the studio once hid the
  Kakao Maps SDK's `window.kakao` and silently broke the Kakao place search in `app.js`. Never use
  SDK global names (`kakao`, `naver`, `L`, `firebase`, `lucide`, `Dexie`, `JSZip`) for your own
  globals; `app.js` now reads `window.kakao.maps` explicitly.
- **Storage.** Each saved creation is its own cloud node, `aura-rooms/{room}/creations/{id}`
  (`{img, kind, createdAt, caption, sources}`), plus a `creationsVersion` number other devices poll.
  Adding or deleting one never rewrites the others, so it isn't subject to the photo-list
  last-write-wins rules above. Local rows carry `room` and are cleaned by `ensureLocalDbMatchesRoom()`;
  `uploaded:false` marks one still waiting to go out. Videos are **never** uploaded (several MB each
  would eat the free-tier quota). They are offered to the phone only.
- **Preview = export.** Everything is drawn from proportions: overlay items are fractions of the canvas,
  sized against `studioRefSize` (√(W·H)), and patterns scale with the output. That way the 720px
  preview and the 2048px export match. The preview caches the photo/frame layer (`studioBaseCanvas`)
  and only recomposes overlays while dragging. Call `studioQueueRender(false)` for overlay-only
  changes and `studioQueueRender()` when anything underneath changed.
- **No `ctx.filter`.** Older iPhone Safari lacks it. Filters, painting effects, 뽀샤시 and blurs are
  pixel loops (box blur = sliding sums, Kuwahara = summed-area tables). Heavy effects run on a copy
  capped at `STUDIO_ART_WORK_MAX` and are scaled back up.
- **Share sheet needs a fresh tap.** iPhone opens `navigator.share` only right after a user gesture,
  so call it straight from the button handler. That's why the slideshow video shows a preview with
  its own "폰에 저장" button instead of sharing once recording ends.
- **Photos to Gemini.** AI 꾸미기 sends the composed picture through `callGeminiRaw(…, extraParts)`
  (an `inlineData` part). The first use asks consent once (`aura_ai_photo_ok`). Answers are cached
  per layout geometry (`studioAiKey`). Image *generation* (Gemini style transfer) was deliberately not
  built: no image model has a free tier, about $0.034/image.
- **얼굴 보정 (MediaPipe).** `@mediapipe/tasks-vision` is pinned (`STUDIO_MP_VERSION`) and
  dynamic-`import()`ed from jsDelivr; the model comes from `storage.googleapis.com`. It loads lazily
  on first use (about 7MB) with the CPU delegate and runs on-device only. Reshaping works on each
  original photo (`studioSourceImages`) before layout. Jaw pushes must be *averaged*, not summed:
  summing overlapping pushes folded the image into ripples.
- **배경 바꾸기.** It shares the same MediaPipe library/WASM (`studioLoadVision`) and adds only
  the ≈250KB `selfie_segmenter` model (pinned `/1/`; the 16MB multiclass model is too heavy for
  phones). It applies after 얼굴 보정 in `studioSourceImages`, and the result is cached per photo +
  settings in `studioReshapeCache`. When the segmenter returns two confidence masks, the last one
  is the person.
- **Picture stickers (v453).** A sticker item whose `emoji` is `"img:<key>"` draws `STUDIO_IMAGE_STICKERS[key]`
  (transparent WebP in `images/stickers/`) instead of text; export waits for it like fonts. The soju bottle was
  made with local Qwen-Image (`design/stickers/gen_soju.py`, source PNG alongside) and cut with `cut.py`'s
  `background_mask`/`to_rgba`. Use this only for things Unicode has no emoji for.
- KakaoTalk publishes no pixel spec for personal profiles. The maker uses 1080² (profile and the
  two couple halves) and 1080×1920 (background). Profile videos stay under KakaoTalk's 6s limit
  and background videos under 15s.


## 오늘의 우리 (`couple.js`)

The dashboard card under the D-day card: today's mood, the daily question, the shared character
(default name 명똑똑, renamable in-app) and presence/hearts. Same loading model as `studio.js`
(started from `startCloudSyncLoop()` behind a `typeof` guard). Its header comment documents the cloud
layout; the rules that matter:

- **Each partner writes only their own leaves** (`daily/{date}/mood|answer/{A|B}`,
  `couple/presence/{A|B}`, `couple/hearts/{A|B}`), so the two phones never overwrite each other. Which
  partner a device is comes from `couple/members` (Google email → A/B), cached in `aura_me_{room}`.
- **Points, stage and streak are derived, never stored**, from the `daily` history plus visits and
  꾸민 사진 dated after `couple/pet.bornAt`. Don't add a stored counter: both phones must compute the
  same value.
- The day's question index comes from a seeded shuffle of `COUPLE_QUESTIONS` (same on both phones);
  `daily/{date}/qi` overrides it only when someone swapped the question before anyone answered.
  Every question is answered by tapping a choice (`"질문|보기1|보기2…"`, or `"A vs B?"` for a balance
  game); answers save `{t, c, q, at}`. **Only append to `COUPLE_QUESTIONS`, never reorder or edit the
  first 150**: days before `COUPLE_Q_V2_FROM` still index the old 150-day cycle. If the bank grows again,
  add another cut-over date the same way rather than changing the existing cycles.
- The card is collapsed by default behind the "키우기" button that `coupleApplyOpen()` draws into
  `#couple-toggle-slot`, which since v430 sits in the dashboard's 명똑똑 row (`coupleRenderMini`: sprite, stage, points,
  progress, today's question). Open state is per device (`aura_couple_open_{room}`). The dashboard top is the D-day hero
  (`renderDdayCard`) → 4 quick tiles → 명똑똑 row → love map; on phones `auraFitMap()` sizes the map so all of that fits
  the first screen above the bottom nav (min 220px).
- Badges (`COUPLE_BADGES`) are "stat ≥ goal" over existing data, recomputed on every render; only the
  first-earned time is stored (`couple/badges/{id}`). `coupleCheckBadges()` runs inside `coupleRender()`,
  so when testing with faked in-memory answers, stub it first or it writes real badges.
- Motions are CSS animations on the existing sprites, fired by `coupleAnimate(kind)` (jump, love, bloom,
  squish, dance). Dancing (v416) has no extra art: `coupleScheduleDance()` runs one timer (3–5 min, 2–3 on a
  happy day or with the partner online) that renders never reset, skips while sleepy or the card is closed,
  plus a once-a-day party dance on a happy day (`aura_couple_dance_{room}`) and three quick taps.
  From baby up the dance flips through drawn poses (v417): `images/character/dance-<stage>-0..3.webp`
  (lean left, crouch, lean right, jump), cut from the ChatGPT sheets `design/character-src/dance-<stage>.webp`
  by `cut_dance.py`, which scales them to the stage sprite, keeps the jump's lift, pulls the paler greens to
  the stage colour and repaints stray mint scarf (young stages) / a beige foot. The egg keeps the CSS moves.
  Since v422 drawn motions share one player: `COUPLE_MOTIONS` (frames, `seq`, ms, which stages have art) +
  `couplePlayFrames`. New poses come from the local Qwen-Image-Edit pipeline (`E:\AI\work\gen_poses.py`, off-repo)
  and are cut by `design/character-src/cut_pose.py` (sources kept in `design/character-src/poses/`). The
  wave hello (v423) plays when the partner comes online and once a day when the card opens (`coupleMaybeGreet`).
- Character art is ChatGPT-generated (an original design, deliberately not a copy of any game
  character), cut into transparent WebP sprites in `images/character/` by
  `design/character-src/cut.py` (sources alongside). Only the adult stage has expression variants;
  every stage from baby up has a `-blink` frame used for blinking and sleeping.
- Testing against room 77: write test answers/moods under a non-date key (e.g. `daily/test-…`) and
  delete them afterwards — real dates are what the partner sees.

## 버킷리스트 · 서로 사용 설명서 (`together.js`)

Two tiles under the dashboard stats open two modals. Loaded after `couple.js` and reads its state (`couple.me`,
`couple.pet.bornAt`, `couple.versions`); couple.js calls in behind `typeof` guards (`togetherStart` once at
start-up, `togetherAfterPoll` after each poll, `togetherBucketPoints` inside `couplePoints`, `togetherBadgeStats`
inside `coupleBadgeStats`). Cloud layout is in its header comment; the rules that matter:

- Bucket items are one node each (`bucket/{id}`) and either partner may edit any of them, so edits PATCH only
  the changed fields. The "we did it" photo lives apart (`bucketPhotos/{id}`) and is fetched only when opened;
  the list carries a ~160px `thumb`.
- `manual/{A|B}` is written only by its owner (whole node, PUT).
- Every change also writes `couple/versions/{bucket|manual}` = now. couple.js already reads `couple/` whole on
  every poll, so the other phone sees the change without an extra request and refetches only what moved.
- A ticked bucket item dated after the character was born is +3 points — derived, like the rest.
- When testing, stub `togetherFetch` for non-GET calls (and `coupleCheckBadges`, `couplePutJson`): ticking an
  item adds points (can trigger the level-up/stage key in localStorage) and badges.

## AI 플래너 — 날씨 맞춤 코스 (`course.js`)

A form (date, area, time window, vibes, budget, extra request) replaces the old chat. Flow: area → coordinates
(Kakao keyword search, then Kakao address search, then Open-Meteo geocoding) → that day's forecast and fine dust
from **Open-Meteo** (free, no key, CORS-open; forecast reaches ~16 days, air quality ~5) → Gemini with the
weather, nearby wishlist/visited places from `db.places`, festivals on that day (`festivalItems`) and both
partners' food notes (`togetherManualFoodNotes()`) → every returned place is looked up in Kakao Places near the
area; a hit replaces the AI's address/coordinates, a miss is shown as "지도에서 못 찾았어요". The last 3
courses are kept per device (`aura_course_last_{room}`); form choices in `aura_course_prefs`. The festival
panel's AI button calls `coursePlanFromFestival(ev)`.

"카카오톡으로 보내기" (v418) copies the course to `aura-rooms/{room}/courses/{shareId}` and sends a Kakao feed card
linking to `?room=…&course=<shareId>`; `courseOpenShared()` (run from `courseInit`) fetches it into the partner's
planner and strips the param. It loads the Kakao **JavaScript SDK** (global `Kakao`, capital K — a different
global from the maps SDK's `kakao`) with the same JS key, and calls `Kakao.Share.sendDefault` synchronously from
the tap (upload runs in parallel); fallbacks are `navigator.share`, then the clipboard.

## Gemini integration notes

`callGeminiRaw()` does **not** hardcode a single model name — Google periodically retires model
versions, which has broken this app before. It first calls `GET .../v1beta/models` to discover
currently-available `flash`-family models for the user's own key, then falls back to a static
`GEMINI_CANDIDATE_MODELS` list, trying candidates in order until one works. Both the discovery call and
each `generateContent` call are wrapped in `AbortController` timeouts (5s / 20s) — an earlier bug
(unguarded discovery fetch hanging forever) taught that every Gemini network call here must have an
explicit timeout, since `fetch()` has none by default. Retryable failures (404 "not found", 429/quota,
503/"overloaded"/"high demand") fall through to the next candidate rather than failing the whole
request; treat any new Gemini error class the same way unless it's clearly non-retryable. Its optional
4th argument `extraParts` (e.g. `[{ inlineData: { mimeType, data } }]`) sends images with the prompt.
The flash models accept image input on the free tier.

## The `notes` field convention

`db.places` has a single free-text `notes` field, and it is rendered as the **address** ("주소:") on
every place card across the app (wishlist, visited, festival items, AI-course saves — see
`cleanAddress` regex-strip usage in the render functions). There is no separate description/memo
field. When building a feature that saves a `db.places` row from an external data source (TourAPI
festival, AI-planner course, etc.), put the actual address string in `notes` — never a description or
other text — or it will display as a garbled "address" everywhere that place is shown.

## Emoji in names and comments (v452)

Name fields (add sheet, quick-add from the love map, edit) and comment fields get an emoji row plus a one-line
suggestion (`emojiAttach` in app.js; hints are local regex tables, no AI). A suggestion for a name looks first
at words the person added to the searched name, then the Kakao `category_name` (`kakaoCategory` on Kakao
hits), then the searched name itself. Comment edits use the `#modal-comment-sheet` bottom sheet, not
`prompt()`. Rules: only offer emoji from Unicode 12 or older (newer ones are empty boxes on Windows 10), and
strip emoji with `placeSearchName()` before using a place name as a map search query.

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
