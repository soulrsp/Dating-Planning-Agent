/* -------------------------------------------------------------
 * AURA - Lovelier Couple Planner Logic System
 * Naver Maps JS SDK v3 Integration, Firebase Real-Time Sync,
 * Canvas Photo Compression
 * ------------------------------------------------------------- */

// 1. Initialize Dexie Database
const db = new Dexie("AuraDatePlannerDB");
db.version(2).stores({
    places: "++id, name, category, url, lat, lng, priority, notes, isVisited, rating, review, expense, payer, peopleCount, photo, createdAt"
});

// 2. State & Settings Variables
let map = null;
let leafletMarkersGroup = null;
let naverMarkers = [];
let naverSearchMarkers = [];
let activeInfoWindow = null;
let isNaverMapActive = false;

let currentActiveTab = "dashboard";
let currentPlacesFilter = "wishlist"; 

// Couple Info & Settings (LocalStorage)
//
// naverClientId / kakaoApiKey are PUBLIC client-side keys — they are meant to ship in the page and are
// protected by the domain allowlist configured in the Ncloud / Kakao Developers consoles.
// No real secret is stored client-side any more: the Naver Search API (which needed one) was removed
// because its endpoints cannot be called from a browser at all. See docs in secrets/README.md.
let geminiApiKey = localStorage.getItem("aura_gemini_key") || "";
let naverClientId = localStorage.getItem("aura_naver_client_id") || "xaxinl85gc";

// Earlier builds hardcoded a Naver Search secret AND force-wrote it into localStorage. The Search API
// is gone now, but the leaked value still has to be purged from browsers that ran those builds.
const LEAKED_NAVER_SECRETS = [
    "oIG5ArjuqTMzfbXwQsy6OlWcORrWxX08x3fmuMbB",
    "olG5ArjuqTMzfbXwQsy6OIWcORrWxX08x3fmuMbB"
];
if (localStorage.getItem("aura_naver_search_secret") !== null) {
    const wasLeaked = LEAKED_NAVER_SECRETS.includes(localStorage.getItem("aura_naver_search_secret"));
    localStorage.removeItem("aura_naver_search_secret");
    localStorage.removeItem("aura_naver_search_id");
    if (wasLeaked) {
        console.warn("[Security] 유출된 네이버 시크릿을 localStorage에서 제거했습니다. Ncloud 콘솔에서 키를 재발급하세요.");
    }
}

let kakaoApiKey = localStorage.getItem("aura_kakao_key") || "132caa45ef567c45aca49b350fc0178f";
let isKakaoPlacesActive = false;

// TourAPI key is a personal, quota-limited data.go.kr credential (unlike naverClientId/kakaoApiKey
// above) — like geminiApiKey, it stays local-only and is never synced through room settings, so one
// person's daily quota never leaks to or gets burned by other couples using this app.
let tourApiKey = localStorage.getItem("aura_tourapi_key") || "";

// Map Search Performance Layer: in-session result cache and stale-result cancellation
const mapSearchResultCache = new Map(); // normalizedQuery -> { results, timestamp }
const MAP_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
let mapSearchGeneration = 0; // bumped on every new search; stale async chains check this before rendering
let partnerAName = localStorage.getItem("aura_partner_a_name") || "SH";
let partnerBName = localStorage.getItem("aura_partner_b_name") || "SA";
// Resolved from the URL immediately (not deferred to DOMContentLoaded) because room-scoped state
// below (memory photos) needs the correct room before it initializes, not after.
let syncRoomId = new URLSearchParams(window.location.search).get("room") || localStorage.getItem("aura_sync_room_id") || "0";
let customFirebaseUrl = localStorage.getItem("aura_firebase_url") || "";

// Cloud Sync Engine variables
const DEFAULT_FIREBASE_DB_URL = 'https://dating-planning-agent-default-rtdb.asia-southeast1.firebasedatabase.app';
function getFirebaseDbUrl() {
    return customFirebaseUrl ? customFirebaseUrl.replace(/\/$/, "") : DEFAULT_FIREBASE_DB_URL;
}

// --- Auth Gate ---------------------------------------------------------------------------------
// Requires Google sign-in before the app (or any Firebase read/write) runs. This client-side gate
// only checks "is this a signed-in Google account" — it does NOT decide which room a person may
// read/write. That's enforced server-side, per room, by the Realtime Database security rules
// (configured in the Firebase console): each room's rule lists the specific two emails allowed
// into that room, so multiple couples can each have their own private ?room=xxx under one project
// without this file needing to know who's invited to which room. The fetch() patch further down is
// what actually lets a signed-in request reach those rules — it can still be denied there.
let currentIdToken = null;
let resolveAuthGate = null;
const authGateReady = new Promise(resolve => { resolveAuthGate = resolve; });
function waitForAuthGate() { return authGateReady; }

(function setupAuthGate() {
    // The main DOMContentLoaded handler calls lucide.createIcons() too, but only after
    // waitForAuthGate() resolves — the gate's own icons (shown *before* that) need it now.
    if (window.lucide) lucide.createIcons();

    const gateEl = document.getElementById("auth-gate");
    const appEl = document.getElementById("app-container");
    const errorEl = document.getElementById("auth-gate-error");
    const messageEl = document.getElementById("auth-gate-message");
    const signInBtn = document.getElementById("btn-google-signin");
    const signOutBtn = document.getElementById("btn-google-signout");
    const emailLabel = document.getElementById("auth-current-email");

    function showGateError(msg) {
        if (errorEl) { errorEl.textContent = msg; errorEl.style.display = "block"; }
    }

    // Explicit, rather than relying on the SDK default — and logged, because "signed in but asked to
    // log in again every time the app is reopened" on iOS home-screen apps usually means IndexedDB
    // (what LOCAL persistence is backed by) isn't actually surviving app termination in that
    // WKWebView, which the SDK doesn't surface anywhere unless you look for it.
    firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL)
        .catch((e) => console.error('[Auth] setPersistence failed — session will not survive reload:', e));

    // Installed PWAs (opened from a home-screen icon, "standalone" display mode) generally can't
    // complete signInWithPopup() — there's no browser chrome for a popup to open into.
    // signInWithRedirect() works around that on Android, but on iOS it doesn't: the WKWebView behind
    // an "Add to Home Screen" icon hangs forever on Google's "Continue to the app..." page and never
    // returns (confirmed — this is what broke sign-in after reinstalling). That's an iOS/WebKit
    // limitation, not something fixable here. Modern iOS shares site storage between Safari and the
    // home-screen icon for the same origin, so signing in via a normal Safari tab once is the actual
    // fix — onIdTokenChanged below picks that up automatically the next time the icon is reopened.
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const isIOS = /iP(hone|od|ad)/.test(navigator.platform) || (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1);
    // Mobile browsers (not just installed/standalone ones) handle signInWithPopup() poorly — the
    // popup window either never opens cleanly or hangs without rejecting. Each such attempt still
    // spins up a real WKWebView/browser context that doesn't always get torn down promptly, and
    // repeated taps (because nothing visibly happened) stack more of them up — this is what was
    // making the whole phone sluggish, not just this page. Firebase's own guidance is to skip
    // popup and go straight to redirect on mobile web for exactly this reason.
    const isMobileDevice = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

    // Google actively refuses OAuth sign-in inside embedded app webviews (Naver, KakaoTalk,
    // Instagram, Facebook, Line, ...) — "disallowed_useragent" — no matter which flow (popup/
    // redirect) is used. That's a Google policy check on the user agent string itself, not
    // something we can work around client-side; the only fix is opening the link in a real
    // browser (Safari/Chrome) via the in-app browser's own "다른 브라우저로 열기" menu.
    const isInAppBrowser = /NAVER\(inapp|KAKAOTALK|Instagram|FBAN|FBAV|Line\//i.test(navigator.userAgent);

    if (isInAppBrowser && signInBtn) {
        signInBtn.style.display = "none";
        if (messageEl) {
            messageEl.textContent = "네이버, 카카오톡 등 앱 내장 브라우저에서는 구글 로그인이 차단돼요. 오른쪽 위 메뉴에서 '다른 브라우저로 열기'(사파리 또는 크롬)를 선택해 다시 열어주세요.";
        }
    } else if (isStandalone && isIOS && signInBtn) {
        signInBtn.style.display = "none";
        if (messageEl) {
            messageEl.textContent = "iOS 홈 화면 앱에서는 구글 로그인이 끝까지 진행되지 않아요. 사파리 앱을 열어서 이 주소로 한 번 접속해 로그인해주세요 — 그 다음부터는 이 아이콘으로도 자동으로 로그인됩니다.";
        }
    }

    async function startSignIn() {
        signInBtn.disabled = true;
        if (errorEl) errorEl.style.display = "none";
        const provider = new firebase.auth.GoogleAuthProvider();
        if (isStandalone || isMobileDevice) {
            try {
                await firebase.auth().signInWithRedirect(provider);
            } catch (e) {
                showGateError("로그인에 실패했습니다: " + e.message);
                signInBtn.disabled = false;
            }
            return;
        }
        try {
            await firebase.auth().signInWithPopup(provider);
        } catch (e) {
            // auth/popup-blocked, auth/operation-not-supported-in-this-environment, etc. — retry via
            // redirect instead of just failing outright.
            try {
                await firebase.auth().signInWithRedirect(provider);
            } catch (e2) {
                showGateError("로그인에 실패했습니다: " + e2.message);
                signInBtn.disabled = false;
            }
        }
    }

    if (signInBtn) {
        signInBtn.addEventListener("click", startSignIn);
    }

    // Surface any error from a signInWithRedirect() that just completed (e.g. after returning from
    // the Google login page) — otherwise a failure there has nowhere to report to.
    firebase.auth().getRedirectResult().catch((e) => {
        showGateError("로그인에 실패했습니다: " + e.message);
        if (signInBtn) signInBtn.disabled = false;
    });

    if (signOutBtn) {
        signOutBtn.addEventListener("click", () => firebase.auth().signOut());
    }

    firebase.auth().onIdTokenChanged(async (user) => {
        if (!user) {
            currentIdToken = null;
            if (gateEl) gateEl.style.display = "flex";
            if (appEl) appEl.style.display = "none";
            if (signInBtn) signInBtn.disabled = false;
            return;
        }

        // Any signed-in Google account gets past this gate — whether they can actually read/write
        // a given ?room=xxx is decided by that room's own database rule, not here (see comment above).
        currentIdToken = await user.getIdToken();
        if (emailLabel) emailLabel.textContent = user.email;
        if (gateEl) gateEl.style.display = "none";
        if (appEl) appEl.style.display = "";
        if (resolveAuthGate) { resolveAuthGate(); resolveAuthGate = null; }
    });
})();

// Every Firebase Realtime Database REST call in this file must carry the signed-in user's ID token
// so the database security rules (auth.token.email in the allowlist) authorize it. Patching fetch()
// here — rather than touching every one of the ~20 call sites below — keeps them all working as-is.
(function patchFetchForAuth() {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function(url, opts) {
        if (typeof url === "string" && url.startsWith(getFirebaseDbUrl()) && currentIdToken) {
            url += (url.includes("?") ? "&" : "?") + "auth=" + encodeURIComponent(currentIdToken);
        }
        return nativeFetch(url, opts);
    };
})();

let lastSyncedTimestamp = 0;
// Restored from localStorage: if the tab is closed/reloaded before a save finishes (or its retry),
// the in-memory guard below would otherwise reset to 0 and let the very next loadFromCloud() pull
// the still-stale cloud copy over the edit that never made it out — reproducing the "revert on
// restart" bug even after the upload itself works fine server-side.
let localMutationTimestamp = parseInt(localStorage.getItem('aura_pending_mutation_ts') || '0', 10) || 0;

// All of these are scoped by room (?room=0 vs ?room=77 must never see each other's cached state,
// or their gallery/memory widgets bleed together on the same device/browser).
function memoryPhotosStorageKey() { return `aura_lovely_memories_${syncRoomId}`; }
function memoryPhotosVersionStorageKey() { return `aura_last_memory_photos_version_${syncRoomId}`; }
function photosVersionStorageKey() { return `aura_last_photos_version_${syncRoomId}`; }

// Restored from localStorage for the same reason as localMutationTimestamp above: without this,
// every fresh page load starts back at 0, so the cheap "did anything change" check always looks
// like "yes" even when the locally cached copy (also in localStorage) is already current — forcing
// a full re-download of the photo library / memory gallery once per reload for no reason.
let lastKnownPhotosVersion = parseInt(localStorage.getItem(photosVersionStorageKey()) || '0', 10) || 0;
let lastKnownMemoryPhotosVersion = parseInt(localStorage.getItem(memoryPhotosVersionStorageKey()) || '0', 10) || 0;

function setLastKnownPhotosVersion(v) {
    lastKnownPhotosVersion = v;
    localStorage.setItem(photosVersionStorageKey(), String(v));
}
function setLastKnownMemoryPhotosVersion(v) {
    lastKnownMemoryPhotosVersion = v;
    localStorage.setItem(memoryPhotosVersionStorageKey(), String(v));
}

let syncIntervalId = null;
let photoSyncIntervalId = null;
let isUploading = false;
let isDownloading = false;

let defaultMapCoords = [37.5665, 126.9780]; // Seoul Central

// 3. Document Loaded Initialization
document.addEventListener("DOMContentLoaded", async () => {
    // Block here until a signed-in, allowlisted Google account is confirmed — nothing below (sync
    // loop, Firebase reads, event wiring) should run for an unauthenticated or disallowed visitor.
    await waitForAuthGate();

    // Populate settings UI from LocalStorage
    document.getElementById("settings-gemini-key").value = geminiApiKey;
    document.getElementById("settings-naver-client-id").value = naverClientId;
    const kakaoInput = document.getElementById("settings-kakao-api-key");
    if (kakaoInput) kakaoInput.value = kakaoApiKey;
    const tourApiInput = document.getElementById("settings-tourapi-key");
    if (tourApiInput) tourApiInput.value = tourApiKey;
    document.getElementById("settings-partner-a-name").value = partnerAName;
    document.getElementById("settings-partner-b-name").value = partnerBName;
    document.getElementById("settings-sync-room-id").value = syncRoomId;
    document.getElementById("settings-firebase-url").value = customFirebaseUrl;
    
    // Check for room ID in query string (takes precedence)
    const urlParams = new URLSearchParams(window.location.search);
    const queryRoom = urlParams.get("room");
    if (queryRoom) {
        syncRoomId = queryRoom;
        document.getElementById("settings-sync-room-id").value = queryRoom;
        localStorage.setItem("aura_sync_room_id", queryRoom);
    }

    if ((queryRoom === "77" || syncRoomId === "77") && (partnerAName === "초코" || partnerAName === "A")) {
        partnerAName = "SH";
        partnerBName = "SA";
        localStorage.setItem("aura_partner_a_name", "SH");
        localStorage.setItem("aura_partner_b_name", "SA");
        document.getElementById("settings-partner-a-name").value = "SH";
        document.getElementById("settings-partner-b-name").value = "SA";
    }

    // Room "77" ships with pinned map keys so anyone opening ?room=77 works immediately without a
    // trip to 설정. Checked against raw localStorage (not the in-memory var, which already carries
    // its own global fallback) so this only fills in when nothing was explicitly configured — it
    // won't clobber a deliberately customized key, and self-heals if the stored key was ever blanked.
    const ROOM_DEFAULT_KEYS = {
        "77": { naverClientId: "stouz9nm0e", kakaoApiKey: "132caa45ef567c45aca49b350fc0178f" }
    };
    const roomDefaultKeys = ROOM_DEFAULT_KEYS[syncRoomId];
    if (roomDefaultKeys) {
        if (!localStorage.getItem("aura_naver_client_id")) {
            naverClientId = roomDefaultKeys.naverClientId;
            localStorage.setItem("aura_naver_client_id", naverClientId);
            document.getElementById("settings-naver-client-id").value = naverClientId;
        }
        if (!localStorage.getItem("aura_kakao_key")) {
            kakaoApiKey = roomDefaultKeys.kakaoApiKey;
            localStorage.setItem("aura_kakao_key", kakaoApiKey);
            if (kakaoInput) kakaoInput.value = kakaoApiKey;
        }
    }

    updatePartnerNamesUI();

    // Map script selection & dynamic load
    if (naverClientId) {
        loadNaverMapScript(naverClientId);
    } else {
        initLeafletMap();
    }

    if (kakaoApiKey) {
        loadKakaoPlacesScript(kakaoApiKey);
    }

    // Cleanup legacy test comments & deduplicate junk places if present
    await cleanJunkData(false);

    // Pull the latest cloud state BEFORE pushing anything on startup.
    if (syncRoomId) {
        await loadFromCloud();
    }

    // Trigger cloud sync upload on startup to push local API keys/settings to cloud if room is connected
    if (syncRoomId && (naverClientId || geminiApiKey)) {
        setTimeout(() => triggerSyncUpload(), 300);
    }

    // Refresh UI Data
    await updateDashboardStats();
    await renderPlacesList();
    await renderCalendar();
    renderLovelyMemoryGallery();
    checkApiKeyAlert();
    startCloudSyncLoop();

    // Lucide Icons Initialization
    lucide.createIcons();

    // Tab Navigation (Desktop & Mobile Bottom Nav)
    document.querySelectorAll(".nav-menu .nav-item, .mobile-bottom-nav .mobile-nav-item").forEach(button => {
        button.addEventListener("click", () => {
            const targetTab = button.getAttribute("data-tab");
            switchTab(targetTab);
        });
    });

    // Quick Add Modal Trigger (guarded with null checks)
    const btnQuickAdd = document.getElementById("btn-quick-add");
    if (btnQuickAdd) btnQuickAdd.addEventListener("click", openAddPlaceModal);
    const btnCloseModal = document.getElementById("btn-close-modal");
    if (btnCloseModal) btnCloseModal.addEventListener("click", closeAddPlaceModal);
    const btnCancelModal = document.getElementById("btn-cancel-modal");
    if (btnCancelModal) btnCancelModal.addEventListener("click", closeAddPlaceModal);
    const formPlaceAdd = document.getElementById("form-place-add");
    if (formPlaceAdd) formPlaceAdd.addEventListener("submit", handleAddPlaceSubmit);
    const addPlaceUrl = document.getElementById("add-place-url");
    if (addPlaceUrl) addPlaceUrl.addEventListener("input", handleMapUrlInput);

    // Edit Place Modal Listeners
    const closeEditBtn = document.getElementById("btn-close-edit-modal");
    if (closeEditBtn) closeEditBtn.addEventListener("click", closeEditPlaceModal);
    const cancelEditBtn = document.getElementById("btn-cancel-edit-modal");
    if (cancelEditBtn) cancelEditBtn.addEventListener("click", closeEditPlaceModal);
    const formEdit = document.getElementById("form-edit-place");
    if (formEdit) formEdit.addEventListener("submit", handleEditPlaceSubmit);

    // Search input listeners for Wishlist and Visited tabs
    const wishSearch = document.getElementById("wishlist-search-input");
    if (wishSearch) wishSearch.addEventListener("input", renderPlacesList);
    const visitSearch = document.getElementById("visited-search-input");
    if (visitSearch) visitSearch.addEventListener("input", renderPlacesList);

    // Download photos button click
    const btnDownload = document.getElementById("btn-download-photos");
    if (btnDownload) btnDownload.addEventListener("click", downloadAllPhotos);

    // Trigger file selection on preview box click
    const previewBox = document.getElementById("visit-photo-preview");
    if (previewBox) {
        previewBox.addEventListener("click", () => {
            const fileInput = document.getElementById("visit-photo");
            if (fileInput) fileInput.click();
        });
    }

    const editPreviewBox = document.getElementById("edit-place-photo-preview");
    if (editPreviewBox) {
        editPreviewBox.addEventListener("click", () => {
            const editFileInput = document.getElementById("edit-place-photo");
            if (editFileInput) editFileInput.click();
        });
    }

    const editPhotoInput = document.getElementById("edit-place-photo");
    if (editPhotoInput) {
        editPhotoInput.addEventListener("change", handleEditPhotoUploadPreview);
    }

    // Sync Banner Click Listener (Join sync room / Copy sharing URL)
    const banner = document.getElementById("sync-status-banner");
    if (banner) {
        banner.addEventListener("click", async () => {
            if (!syncRoomId) {
                let roomId = prompt("연결할 커플 동기화 방 이름을 입력하세요 (예: love1004, 초코딸기)", "love1004");
                if (!roomId) return;
                roomId = roomId.trim();
                if (roomId) {
                    syncRoomId = roomId;
                    localStorage.setItem("aura_sync_room_id", roomId);
                    const syncInput = document.getElementById("settings-sync-room-id");
                    if (syncInput) syncInput.value = roomId;
                    
                    const newUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
                    window.history.pushState({ path: newUrl }, '', newUrl);
                    
                    startCloudSyncLoop();
                    
                    await copyShareLinkToClipboard(newUrl);
                    showToast(`동기화 룸 '${roomId}'에 연결되었으며 공유 링크가 복사되었습니다! 💖`, "success");
                }
            } else {
                const shareUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(syncRoomId)}`;
                await copyShareLinkToClipboard(shareUrl);
                showToast("실시간 동기화 공유 링크가 클립보드에 복사되었습니다! 💌", "success");
            }
        });
    }

    // Couple Names Inline Edit (click on "초코 ♥ 딸기" to edit)
    const coupleNamesEl = document.getElementById("couple-names-editable");
    if (coupleNamesEl) {
        coupleNamesEl.addEventListener("click", (e) => {
            e.stopPropagation();
            // Prevent duplicate popovers
            if (document.getElementById("couple-edit-popover")) return;
            
            const popover = document.createElement("div");
            popover.id = "couple-edit-popover";
            popover.style.cssText = `
                position: absolute;
                top: 100%;
                left: 50%;
                transform: translateX(-50%);
                z-index: 999;
                background: rgba(255, 255, 255, 0.95);
                backdrop-filter: blur(20px);
                border: 1px solid rgba(255, 101, 132, 0.2);
                border-radius: 16px;
                padding: 1rem;
                box-shadow: 0 8px 32px rgba(255, 101, 132, 0.15);
                min-width: 220px;
                animation: modalPop 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
            `;
            popover.innerHTML = `
                <div style="font-size:0.75rem; color:var(--color-text-low); margin-bottom:0.5rem; font-weight:600; text-align:center;">커플 이름 수정 💕</div>
                <div style="display:flex; gap:0.5rem; margin-bottom:0.6rem;">
                    <input id="edit-name-a" type="text" value="${partnerAName}" placeholder="A 이름" 
                        style="flex:1; padding:0.4rem 0.6rem; border:1px solid rgba(255,101,132,0.2); border-radius:10px; font-size:0.85rem; font-family:var(--font-body); background:rgba(255,255,255,0.8); color:var(--color-text-high); outline:none; text-align:center; width:80px;">
                    <span style="display:flex; align-items:center; color:var(--color-primary); font-size:0.85rem;">♥</span>
                    <input id="edit-name-b" type="text" value="${partnerBName}" placeholder="B 이름" 
                        style="flex:1; padding:0.4rem 0.6rem; border:1px solid rgba(255,101,132,0.2); border-radius:10px; font-size:0.85rem; font-family:var(--font-body); background:rgba(255,255,255,0.8); color:var(--color-text-high); outline:none; text-align:center; width:80px;">
                </div>
                <button id="btn-save-couple-names" style="width:100%; padding:0.45rem; border:none; background:linear-gradient(135deg, var(--color-primary) 0%, #FF85A1 100%); color:white; border-radius:10px; font-size:0.8rem; font-weight:700; cursor:pointer; font-family:var(--font-body); transition:all 0.2s ease;">
                    저장하기 💖
                </button>
            `;
            
            // Make parent relative for absolute positioning
            coupleNamesEl.parentElement.style.position = "relative";
            coupleNamesEl.parentElement.appendChild(popover);
            
            // Focus first input
            setTimeout(() => document.getElementById("edit-name-a").focus(), 50);
            
            // Save handler
            document.getElementById("btn-save-couple-names").addEventListener("click", () => {
                const newA = document.getElementById("edit-name-a").value.trim() || "초코";
                const newB = document.getElementById("edit-name-b").value.trim() || "딸기";
                
                partnerAName = newA;
                partnerBName = newB;
                localStorage.setItem("aura_partner_a_name", newA);
                localStorage.setItem("aura_partner_b_name", newB);
                
                // Update settings input fields
                document.getElementById("settings-partner-a-name").value = newA;
                document.getElementById("settings-partner-b-name").value = newB;
                
                updatePartnerNamesUI();
                popover.remove();
                showToast(`커플 이름이 '${newA} ♥ ${newB}'(으)로 변경되었습니다! 💕`, "success");
                triggerSyncUpload();
            });
            
            // Enter key save support
            const handleEnterKey = (ev) => {
                if (ev.key === "Enter") {
                    document.getElementById("btn-save-couple-names").click();
                }
            };
            document.getElementById("edit-name-a").addEventListener("keypress", handleEnterKey);
            document.getElementById("edit-name-b").addEventListener("keypress", handleEnterKey);
            
            // Close popover when clicking outside
            const closePopover = (ev) => {
                if (!popover.contains(ev.target) && ev.target !== coupleNamesEl && !coupleNamesEl.contains(ev.target)) {
                    popover.remove();
                    document.removeEventListener("click", closePopover);
                }
            };
            setTimeout(() => document.addEventListener("click", closePopover), 10);
        });
    }

    // Visit logging modal logic
    document.getElementById("btn-close-visit-modal").addEventListener("click", closeVisitModal);
    document.getElementById("btn-cancel-visit-modal").addEventListener("click", closeVisitModal);
    document.getElementById("form-visit-log").addEventListener("submit", handleVisitLogSubmit);
    document.getElementById("visit-photo").addEventListener("change", handlePhotoUploadPreview);

    // In-app Map Direct Search logic
    const btnMapSearch = document.getElementById("btn-map-search");
    if (btnMapSearch) {
        btnMapSearch.addEventListener("click", () => handleInAppMapSearch());
    }
    const inputMapSearch = document.getElementById("map-search-query");
    if (inputMapSearch) {
        inputMapSearch.addEventListener("keypress", (e) => {
            if (e.key === "Enter") handleInAppMapSearch();
        });
    }

    // AI Chatbot planner
    document.getElementById("chat-input-form").addEventListener("submit", handleChatSubmit);
    document.querySelectorAll(".chip-btn").forEach(chip => {
        chip.addEventListener("click", () => {
            const prompt = chip.getAttribute("data-prompt");
            document.getElementById("chat-user-input").value = prompt;
            document.getElementById("chat-input-form").dispatchEvent(new Event("submit"));
        });
    });

    // Settings actions
    document.getElementById("btn-save-settings").addEventListener("click", saveSettings);
    document.getElementById("btn-export-data").addEventListener("click", exportData);
    document.getElementById("btn-import-data-trigger").addEventListener("click", () => document.getElementById("file-import-data").click());
    document.getElementById("file-import-data").addEventListener("change", importData);
    // btn-clear-data no longer exists in index.html; this threw uncaught on every load and, since
    // nothing here is wrapped in try/catch, silently aborted the rest of this handler — breaking the
    // photo lightbox listeners registered further down (memory gallery click-to-enlarge, close button).
    const clearDataBtn = document.getElementById("btn-clear-data");
    if (clearDataBtn) clearDataBtn.addEventListener("click", clearAllData);

    // Photo Lightbox modal logic
    document.querySelectorAll(".memory-item").forEach(item => {
        item.addEventListener("click", () => {
            const imgSrc = item.querySelector("img").src;
            const lightbox = document.getElementById("modal-photo-viewer");
            const lightboxImg = document.getElementById("lightbox-img");
            lightboxImg.src = imgSrc;
            lightbox.classList.add("active");
        });
    });
    
    const closeViewerBtn = document.getElementById("btn-close-viewer");
    if (closeViewerBtn) {
        closeViewerBtn.addEventListener("click", () => {
            document.getElementById("modal-photo-viewer").classList.remove("active");
        });
    }
    
    const photoViewerModal = document.getElementById("modal-photo-viewer");
    if (photoViewerModal) {
        photoViewerModal.addEventListener("click", (e) => {
            if (e.target.id === "modal-photo-viewer") {
                photoViewerModal.classList.remove("active");
            }
        });
    }

    // Gallery slider: swipe left/right to move between photos
    const sliderImgContainer = document.querySelector(".slider-img-container");
    if (sliderImgContainer) {
        let touchStartX = 0;
        let touchStartY = 0;
        sliderImgContainer.addEventListener("touchstart", (e) => {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
        }, { passive: true });
        sliderImgContainer.addEventListener("touchend", (e) => {
            const dx = e.changedTouches[0].clientX - touchStartX;
            const dy = e.changedTouches[0].clientY - touchStartY;
            // Require a clear horizontal drag (not a tap, not a vertical scroll) before treating it as a swipe.
            if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                navigateGallerySlider(dx < 0 ? 1 : -1);
            }
        }, { passive: true });
    }
});

// 4. Tab Navigation Logic
function switchTab(tabId) {
    document.querySelectorAll(".nav-menu .nav-item, .mobile-bottom-nav .mobile-nav-item").forEach(el => el.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach(el => el.classList.remove("active"));
    
    document.querySelectorAll(`.nav-menu .nav-item[data-tab="${tabId}"], .mobile-bottom-nav .mobile-nav-item[data-tab="${tabId}"]`).forEach(el => el.classList.add("active"));
    
    const tabPane = document.getElementById(`tab-${tabId}`);
    if (tabPane) tabPane.classList.add("active");
    
    currentActiveTab = tabId;
    
    // Page Title Update
    const titleTextMap = {
        "dashboard": "러블리 대시보드 Overview",
        "wishlist": "데이트 위시리스트 🌸",
        "visited": "함께 다녀온 곳 💖",
        "calendar": "우리의 데이트 달력 🗓️",
        "gallery": "우리의 데이트 추억 갤러리 📸",
        "ai-planner": "AURA 러블리 AI 플래너",
        "settings": "AURA 환경 설정"
    };
    document.getElementById("page-title-text").textContent = titleTextMap[tabId] || "AURA 데이트 플래너";
    
    // Force map component size refresh
    if (tabId === "dashboard") {
        setTimeout(() => {
            if (isNaverMapActive && map) {
                naver.maps.Event.trigger(map, 'resize');
            } else if (map) {
                map.invalidateSize();
            }
        }, 120);
    } else if (tabId === "calendar") {
        renderCalendar();
    } else if (tabId === "gallery") {
        renderGallery();
    } else if (tabId === "ai-planner") {
        if (!festivalLoadedThisSession) {
            festivalLoadedThisSession = true;
            loadFestivalData();
        }
    } else if (tabId === "settings") {
        const gemKeyEl = document.getElementById("settings-gemini-key");
        if (gemKeyEl) gemKeyEl.value = geminiApiKey;
        const navIdEl = document.getElementById("settings-naver-client-id");
        if (navIdEl) navIdEl.value = naverClientId;
        const pAEl = document.getElementById("settings-partner-a-name");
        if (pAEl) pAEl.value = partnerAName;
        const pBEl = document.getElementById("settings-partner-b-name");
        if (pBEl) pBEl.value = partnerBName;
        const roomEl = document.getElementById("settings-sync-room-id");
        if (roomEl) roomEl.value = syncRoomId;
        const fbUrlEl = document.getElementById("settings-firebase-url");
        if (fbUrlEl) fbUrlEl.value = customFirebaseUrl;
    }
}

function updatePartnerNamesUI() {
    const lblA = document.getElementById("visit-lbl-comment-a");
    const lblB = document.getElementById("visit-lbl-comment-b");
    if (lblA) lblA.textContent = partnerAName;
    if (lblB) lblB.textContent = partnerBName;

    const editLblA = document.getElementById("edit-lbl-comment-a");
    const editLblB = document.getElementById("edit-lbl-comment-b");
    if (editLblA) editLblA.textContent = partnerAName;
    if (editLblB) editLblB.textContent = partnerBName;

    const nameAEl = document.getElementById("profile-name-a");
    const nameBEl = document.getElementById("profile-name-b");
    if (nameAEl) nameAEl.textContent = partnerAName;
    if (nameBEl) nameBEl.textContent = partnerBName;

    const mobileA = document.getElementById("mobile-name-a");
    const mobileB = document.getElementById("mobile-name-b");
    if (mobileA) mobileA.textContent = partnerAName;
    if (mobileB) mobileB.textContent = partnerBName;

    const mobileCouple = document.getElementById("mobile-couple-names");
    if (mobileCouple) mobileCouple.textContent = `${partnerAName} ♥ ${partnerBName}`;

    const setLblA = document.getElementById("settle-label-a");
    const setLblB = document.getElementById("settle-label-b");
    if (setLblA) setLblA.textContent = partnerAName;
    if (setLblB) setLblB.textContent = partnerBName;
}

// 5. Dynamic Map Loader Engine
function loadNaverMapScript(clientId) {
    const cleanId = (clientId || "").trim();
    if (!cleanId) {
        initLeafletMap();
        return;
    }

    const existingScript = document.getElementById("naver-map-sdk-script");
    if (existingScript) {
        if (existingScript.getAttribute("data-client-id") === cleanId) return;
        existingScript.remove();
    }
    
    const script = document.createElement("script");
    script.id = "naver-map-sdk-script";
    script.setAttribute("data-client-id", cleanId);
    script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(cleanId)}&ncpClientId=${encodeURIComponent(cleanId)}&submodules=geocoder`;
    script.onload = () => {
        console.log("[Map System] Naver Map SDK successfully injected.");
        initNaverMap();
    };
    script.onerror = () => {
        console.error("[Map System] Naver Map loading failed. Falling back to Leaflet.");
        initLeafletMap();
    };
    document.head.appendChild(script);
}

// Kakao Places SDK Loader
function loadKakaoPlacesScript(appKey) {
    const cleanKey = (appKey || "").trim();
    if (!cleanKey) return;

    const existingScript = document.getElementById("kakao-map-sdk-script");
    if (existingScript) {
        if (existingScript.getAttribute("data-app-key") === cleanKey) return;
        existingScript.remove();
    }

    const script = document.createElement("script");
    script.id = "kakao-map-sdk-script";
    script.setAttribute("data-app-key", cleanKey);
    // autoload=false is REQUIRED when the tag is injected dynamically: with the default autoload the
    // SDK bootstraps itself as the script parses, and kakao.maps.load() can fire before the extra
    // libraries (services) have finished downloading — leaving kakao.maps.services undefined.
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(cleanKey)}&libraries=services&autoload=false`;
    script.onload = () => {
        if (window.kakao && window.kakao.maps && typeof window.kakao.maps.load === "function") {
            window.kakao.maps.load(() => {
                isKakaoPlacesActive = isKakaoSdkReady();
                if (isKakaoPlacesActive) {
                    console.log("[Map System] Kakao Places SDK successfully injected & ready.");
                } else {
                    console.warn("[Map System] Kakao SDK initialized but kakao.maps.services is still missing. Confirm the app key has 카카오맵 enabled and that 'services' is included in the libraries parameter.");
                }
            });
        } else {
            console.warn("[Map System] Kakao SDK script loaded but window.kakao is undefined. This usually means the current domain is not registered in Kakao Developers (앱 설정 > 플랫폼 > Web > 사이트 도메인).");
        }
    };
    script.onerror = () => {
        console.warn(`[Map System] Kakao Places SDK failed to load from ${script.src}. Verify the JavaScript key and that ${location.origin} is registered as a Web platform domain in Kakao Developers.`);
        isKakaoPlacesActive = false;
    };
    document.head.appendChild(script);
}

const isKakaoSdkReady = () => !!(window.kakao && window.kakao.maps && window.kakao.maps.services && window.kakao.maps.services.Places);

// The SDK is injected asynchronously at startup, so a search fired right after page load would
// otherwise skip Kakao entirely and silently fall through to the weaker engines.
function waitForKakaoSdk(maxWaitMs = 1500) {
    return new Promise((resolve) => {
        if (isKakaoSdkReady()) {
            resolve(true);
            return;
        }
        const startedAt = Date.now();
        const poll = setInterval(() => {
            if (isKakaoSdkReady()) {
                clearInterval(poll);
                resolve(true);
            } else if (Date.now() - startedAt >= maxWaitMs) {
                clearInterval(poll);
                resolve(false);
            }
        }, 100);
    });
}

const KAKAO_PAGE_SIZE = 15;      // Kakao's per-page maximum
const KAKAO_MAX_PAGES = 3;       // up to 45 places per pass; enough for the results panel

// Resolves with every place across up to KAKAO_MAX_PAGES pages. Kakao hands back a `pagination`
// object with .hasNextPage/.nextPage(); each nextPage() call re-invokes this same callback.
function runKakaoKeywordSearch(ps, query, options) {
    return new Promise((resolve) => {
        const collected = [];
        let pagesFetched = 0;
        let settled = false;

        const done = () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(collected);
            }
        };
        const timer = setTimeout(done, 3000);

        try {
            ps.keywordSearch(query, (data, status, pagination) => {
                if (status === kakao.maps.services.Status.OK && Array.isArray(data)) {
                    collected.push(...data);
                }
                pagesFetched++;

                const canPage = pagination
                    && typeof pagination.hasNextPage !== "undefined"
                    && pagination.hasNextPage
                    && typeof pagination.nextPage === "function";

                if (!settled && canPage && pagesFetched < KAKAO_MAX_PAGES) {
                    pagination.nextPage();
                } else {
                    done();
                }
            }, options);
        } catch (err) {
            console.warn("[Kakao Places API Error]", err);
            done();
        }
    });
}

function mapKakaoPlaceItem(item) {
    let cat = "Other";
    const catName = `${item.category_name || ""} ${item.category_group_name || ""}`;
    if (catName.includes("카페") || catName.includes("커피") || catName.includes("디저트") || catName.includes("베이커리")) cat = "Cafe";
    else if (catName.includes("음식점") || catName.includes("식당") || catName.includes("맛집") || catName.includes("푸드")) cat = "Restaurant";
    else if (catName.includes("주점") || catName.includes("술집") || catName.includes("바") || catName.includes("호프")) cat = "Bar";
    else if (catName.includes("공원") || catName.includes("관광") || catName.includes("명소")) cat = "Park";
    else if (catName.includes("문화") || catName.includes("미술관") || catName.includes("박물관") || catName.includes("전시")) cat = "Museum";

    return {
        name: item.place_name,
        address: item.road_address_name || item.address_name || "카카오 장소 검색",
        lat: parseFloat(item.y),
        lng: parseFloat(item.x),
        category: cat,
        phone: item.phone || "",
        url: item.place_url || ""
    };
}

// Kakao Places Keyword Search Engine (Direct browser CORS-free POI search)
async function searchKakaoPlaces(query, userLat, userLng) {
    if (!(await waitForKakaoSdk())) return null;

    const ps = new kakao.maps.services.Places();

    // A nationwide pass is what actually surfaces every branch of a business. The old code only ran a
    // 20km-radius search around the user and never widened it unless that returned exactly zero, so a
    // single nearby hit suppressed every other location the keyword matches.
    const searches = [runKakaoKeywordSearch(ps, query, { size: KAKAO_PAGE_SIZE })];
    if (userLat && userLng) {
        searches.push(runKakaoKeywordSearch(ps, query, {
            size: KAKAO_PAGE_SIZE,
            location: new kakao.maps.LatLng(userLat, userLng),
            radius: 20000
        }));
    }

    const batches = await Promise.all(searches);

    const byId = new Map();
    for (const batch of batches) {
        for (const item of batch) {
            const key = item.id || `${item.place_name}_${item.x}_${item.y}`;
            if (!byId.has(key)) byId.set(key, item);
        }
    }

    if (byId.size === 0) return null;
    return Array.from(byId.values()).map(mapKakaoPlaceItem);
}

// Kakao's address geocoder resolves both road-name AND 지번(jibun/lot-number) addresses directly.
// Kakao Places above is a business/POI keyword search — it rarely matches a bare address with no
// business name. The Naver-based engines only extract road-name addresses (regex requires 로/길/번길)
// and additionally go dark for the whole session once naverGeocoderDisabled trips (see
// isNaverGeocoderUsable). A jibun-only address like "충북 옥천군 군서면 금산리 64" (no road name, no
// business name) fails every one of those, which is what this engine exists to catch.
async function searchKakaoGeocoder(query) {
    if (!(await waitForKakaoSdk())) return null;
    if (!kakao.maps.services.Geocoder) return null;
    const geocoder = new kakao.maps.services.Geocoder();
    return new Promise((resolve) => {
        geocoder.addressSearch(query.trim(), (result, status) => {
            if (status !== kakao.maps.services.Status.OK || !Array.isArray(result) || result.length === 0) {
                resolve(null);
                return;
            }
            resolve(result.map(r => ({
                name: r.address_name,
                address: r.road_address ? r.road_address.address_name : r.address_name,
                lat: parseFloat(r.y),
                lng: parseFloat(r.x),
                category: "Other"
            })));
        });
    });
}

function initLeafletMap() {
    isNaverMapActive = false;
    // Clear old container if exists
    const oldContainer = document.getElementById("map");
    if (!oldContainer) return;
    
    // Reset element to wipe out Naver maps residuals
    oldContainer.innerHTML = "";
    
    map = L.map('map', {
        zoomControl: false,
        attributionControl: false
    }).setView(defaultMapCoords, 13);
    
    // Warm pastel light theme tiles (CartoDB Positron Light)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 20
    }).addTo(map);
    
    L.control.zoom({
        position: 'bottomright'
    }).addTo(map);
    
    leafletMarkersGroup = L.featureGroup().addTo(map);
    updateMapMarkers();
}

async function initNaverMap() {
    isNaverMapActive = true;
    const container = document.getElementById("map");
    if (!container) return;
    
    // Instantiate Naver Map singleton instance safely without destroying internal event bindings
    if (!map || !(window.naver && window.naver.maps && map instanceof naver.maps.Map)) {
        container.innerHTML = ""; // Clean DOM only when initializing brand new map
        
        let startCenter = new naver.maps.LatLng(defaultMapCoords[0], defaultMapCoords[1]);
        map = new naver.maps.Map('map', {
            center: startCenter,
            minZoom: 6,
            maxZoom: 21,
            zoom: 10, // Fixed initial scale to 4 levels larger than the minimum zoom (-) (minZoom 6 -> 10)
            zoomControl: true,
            zoomControlOptions: {
                position: naver.maps.Position.RIGHT_CENTER
            }
        });

        // Close any open popup when clicking empty space on Naver Map
        naver.maps.Event.addListener(map, "click", () => {
            if (activeInfoWindow) {
                activeInfoWindow.close();
                activeInfoWindow = null;
            }
        });
    }

    // Centering on user current GPS position asynchronously
    getUserCurrentLocation().then(userLoc => {
        if (userLoc && userLoc.lat && userLoc.lng && map) {
            map.setCenter(new naver.maps.LatLng(userLoc.lat, userLoc.lng));
            map.setZoom(10);
        }
    });

    // Force map tile recalculation to guarantee background tile tiles render cleanly
    setTimeout(() => {
        if (map && isNaverMapActive && window.naver && window.naver.maps) {
            naver.maps.Event.trigger(map, 'resize');
        }
    }, 200);

    // Render all saved place markers
    await updateMapMarkers();
}

let isInitialMapFit = true;

window.fitAllMapMarkers = function() {
    isInitialMapFit = true;
    updateMapMarkers();
    showToast("전체 장소 마커 보기로 지도 구도가 맞춰졌습니다 🗺️", "info");
};

async function updateMapMarkers() {
    if (!map) return;
    const places = await db.places.toArray();

    // 1. Sequentially resolve missing/corrupted coordinates for all saved wishlist & visited places BEFORE rendering markers
    for (const place of places) {
        if (place.isDeleted === 1 || place.isVisited === -1) continue;
        
        // Auto-fix corrupted coordinates (out of Korea boundary or 10x scaled due to previous 10^6 division bug)
        const isCorrupted = place.lat && place.lng && (place.lat > 45 || place.lat < 30 || place.lng > 135 || place.lng < 120);
        if (isCorrupted && place.lat > 300 && place.lat < 450) {
            place.lat = place.lat / 10.0;
            place.lng = place.lng / 10.0;
            await db.places.update(place.id, { lat: place.lat, lng: place.lng });
            triggerSyncUpload(place.id);
        }

        if (!place.lat || !place.lng || (place.lat > 45 || place.lat < 30 || place.lng > 135 || place.lng < 120)) {
            const searchAddr = place.notes || place.address || place.name || "";
            if (searchAddr && isNaverMapActive) {
                const refined = await refineCoordinatesViaNaverGeocoder(searchAddr);
                if (refined) {
                    place.lat = refined.lat;
                    place.lng = refined.lng;
                    await db.places.update(place.id, { lat: refined.lat, lng: refined.lng });
                    triggerSyncUpload(place.id);
                }
            }
        }
    }

    if (isNaverMapActive) {
        // Naver Map Markers Rendering
        naverMarkers.forEach(m => m.setMap(null));
        naverMarkers = [];
        
        const validPlaces = places.filter(p => p.lat && p.lng && p.isDeleted !== 1 && p.isVisited !== -1);
        if (validPlaces.length === 0) return;
        
        const bounds = new naver.maps.LatLngBounds();
        
        validPlaces.forEach(place => {
            const isVisited = place.isVisited === 1 || place.isVisited === true || place.isVisited === "1" || place.isVisited === "true";
            const markerColor = isVisited ? "#74B9FF" : "#FF6584";
            const shadowColor = isVisited ? "rgba(116,185,255,0.45)" : "rgba(255,101,132,0.45)";
            
            // Custom CSS Bubble style marker HTML for Naver Map
            const contentHtml = `
                <div class="custom-naver-marker" style="background-color:${markerColor}; width:16px; height:16px; border-radius:50%; border:2px solid white; box-shadow: 0 2px 8px ${shadowColor}; transform:translate(-8px, -8px);"></div>
            `;
            
            const marker = new naver.maps.Marker({
                position: new naver.maps.LatLng(place.lat, place.lng),
                map: map,
                icon: {
                    content: contentHtml,
                    anchor: new naver.maps.Point(8, 8)
                }
            });
            
            const infowindow = new naver.maps.InfoWindow({
                content: `
                    <div style="padding: 10px; font-family:var(--font-body); width:180px; background:white; border-radius:12px; border:1px solid rgba(255,112,150,0.15);">
                        <strong style="color:var(--color-text-high); font-size:0.9rem;">${place.name}</strong>
                        <div style="font-size:0.7rem; color:var(--color-primary); margin-top:2px;">${place.category}</div>
                        <p style="font-size:0.75rem; color:var(--color-text-med); margin:4px 0 0 0;">${place.notes || '메모 없음'}</p>
                    </div>
                `,
                borderWidth: 0,
                backgroundColor: "transparent",
                pixelOffset: new naver.maps.Point(0, -8)
            });
            
            naver.maps.Event.addListener(marker, "click", () => {
                if (activeInfoWindow) {
                    activeInfoWindow.close();
                }
                if (activeInfoWindow === infowindow) {
                    activeInfoWindow = null;
                } else {
                    infowindow.open(map, marker);
                    activeInfoWindow = infowindow;
                }
            });
            
            naverMarkers.push(marker);
            bounds.extend(marker.getPosition());
        });
        
        if (validPlaces.length > 0 && isInitialMapFit) {
            if (validPlaces.length === 1) {
                map.setCenter(new naver.maps.LatLng(validPlaces[0].lat, validPlaces[0].lng));
                map.setZoom(10);
            } else {
                try {
                    map.fitBounds(bounds, {
                        top: 40, right: 40, bottom: 40, left: 40
                    });
                } catch(e) {
                    map.setCenter(bounds.getCenter());
                    map.setZoom(10);
                }
            }
            isInitialMapFit = false;
        }
    } else {
        // Leaflet Map Markers Rendering
        if (!leafletMarkersGroup) return;
        leafletMarkersGroup.clearLayers();
        
        if (places.length === 0) return;
        const latLngs = [];
        
        places.forEach(place => {
            if (!place.lat || !place.lng) return;
            const isVisited = place.isVisited === 1 || place.isVisited === true || place.isVisited === "1" || place.isVisited === "true";
            const markerColor = isVisited ? "#74B9FF" : "#FF6584";
            const shadowColor = isVisited ? "rgba(116,185,255,0.45)" : "rgba(255,101,132,0.45)";
            
            const customIcon = L.divIcon({
                className: 'custom-map-marker',
                html: `<div style="background-color: ${markerColor}; width: 14px; height: 14px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 8px ${shadowColor};"></div>`,
                iconSize: [14, 14],
                iconAnchor: [7, 7]
            });
            
            const popupCategoryText = applyCategoryOverride(place.name, place.notes, place.category);
            const popupCatBadge = categoryBadgeClassAndStyle(popupCategoryText);
            const popupContent = `
                <div class="map-popup-card" style="font-family:var(--font-body); min-width:140px;">
                    <strong style="font-size: 0.9rem; color: var(--color-text-high);">${place.name}</strong>
                    <span class="place-category-badge ${popupCatBadge.cls}" style="display:inline-block; margin-top:4px; font-size:0.6rem; ${popupCatBadge.style}">${popupCategoryText}</span>
                    <p style="margin: 4px 0 0 0; font-size: 0.75rem; color: var(--color-text-med);">${place.notes || ''}</p>
                </div>
            `;
            
            const marker = L.marker([place.lat, place.lng], { icon: customIcon })
                .bindPopup(popupContent);
                
            leafletMarkersGroup.addLayer(marker);
            latLngs.push([place.lat, place.lng]);
        });
        
        if (latLngs.length > 0 && isInitialMapFit) {
            map.fitBounds(L.latLngBounds(latLngs), { padding: [40, 40] });
            isInitialMapFit = false;
        }
    }
}

// Major Korean region centres, used to derive query prefixes from the user's actual position instead
// of hardcoding one city. Keeps region-expanded searches relevant wherever the app is used.
const KR_REGION_CENTERS = [
    { name: "서울", lat: 37.5665, lng: 126.9780 },
    { name: "인천", lat: 37.4563, lng: 126.7052 },
    { name: "수원", lat: 37.2636, lng: 127.0286 },
    { name: "성남", lat: 37.4200, lng: 127.1265 },
    { name: "천안", lat: 36.8151, lng: 127.1139 },
    { name: "세종", lat: 36.4800, lng: 127.2890 },
    { name: "대전", lat: 36.3504, lng: 127.3845 },
    { name: "청주", lat: 36.6424, lng: 127.4890 },
    { name: "전주", lat: 35.8242, lng: 127.1480 },
    { name: "광주", lat: 35.1595, lng: 126.8526 },
    { name: "대구", lat: 35.8714, lng: 128.6014 },
    { name: "포항", lat: 36.0190, lng: 129.3435 },
    { name: "창원", lat: 35.2280, lng: 128.6811 },
    { name: "울산", lat: 35.5384, lng: 129.3114 },
    { name: "부산", lat: 35.1796, lng: 129.0756 },
    { name: "강릉", lat: 37.7519, lng: 128.8761 },
    { name: "제주", lat: 33.4996, lng: 126.5312 }
];

// Nearest region names to the given position, closest first. Falls back to the largest metros.
function getNearbyRegionNames(lat, lng, count = 2) {
    if (!lat || !lng) return ["서울", "대전"].slice(0, count);
    return KR_REGION_CENTERS
        .map(r => ({ name: r.name, d: calculateDistanceKm(lat, lng, r.lat, r.lng) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, count)
        .map(r => r.name);
}

// Geolocation & Distance Proximity Search Helpers
let currentUserLat = null;
let currentUserLng = null;

function getUserCurrentLocation() {
    return new Promise((resolve) => {
        if (currentUserLat && currentUserLng) {
            resolve({ lat: currentUserLat, lng: currentUserLng });
            return;
        }
        if (navigator.geolocation) {
            let done = false;
            const timer = setTimeout(() => {
                if (!done) {
                    done = true;
                    resolve(null);
                }
            }, 1000);

            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    if (!done) {
                        done = true;
                        clearTimeout(timer);
                        currentUserLat = pos.coords.latitude;
                        currentUserLng = pos.coords.longitude;
                        resolve({ lat: currentUserLat, lng: currentUserLng });
                    }
                },
                (err) => {
                    if (!done) {
                        done = true;
                        clearTimeout(timer);
                        resolve(null);
                    }
                },
                { timeout: 1000, enableHighAccuracy: false }
            );
        } else {
            resolve(null);
        }
    });
}

// Move map directly to user's current GPS position
window.moveToUserCurrentLocation = async function() {
    showToast("현재 내 위치를 탐색 중입니다... 🎯", "success");
    const loc = await getUserCurrentLocation();
    if (!loc) {
        showToast("위치 권한이 필요하거나 내 위치를 가져올 수 없습니다 📍", "warning");
        return;
    }
    
    if (isNaverMapActive && map) {
        const pos = new naver.maps.LatLng(loc.lat, loc.lng);
        map.setCenter(pos);
        map.setZoom(16);
    } else if (map) {
        map.setView([loc.lat, loc.lng], 16);
    }
    showToast("현재 내 위치 중심으로 러브 맵이 이동했습니다! 🎯", "success");
};

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return Infinity;
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function formatDistanceStr(km) {
    if (km === Infinity || isNaN(km)) return "";
    if (km < 1) {
        return `${Math.round(km * 1000)}m`;
    }
    return `${km.toFixed(1)}km`;
}

// Shared fetch helper: per-request timeout + session-scoped dead-route memory (skips combos known to fail)
function fetchWithTimeout(url, options = {}, timeoutMs = 1200) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
        .then((res) => {
            clearTimeout(timeoutId);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res;
        })
        .catch((err) => {
            clearTimeout(timeoutId);
            throw err;
        });
}

// Reset & Re-Fetch All Saved Wishlist & Visited Place Pins
window.resetAllPlaceMapPins = async function() {
    showToast("위시리스트 및 다녀온 곳 장소 핀을 다시 조회하여 최신화 중입니다... 🔄", "info");
    const places = await db.places.toArray();
    const targets = places.filter(p => p.isDeleted !== 1 && p.isVisited !== -1);
    let updatedCount = 0;

    const refreshOnePlace = async (place) => {
        const placeQuery = (place.name || "").trim();
        const addressQuery = (place.address || place.notes || "").replace(/\s*-\s*AURA.*$/, "").replace(/^💡\s*메모:\s*/, "").trim();

        let newLat = null;
        let newLng = null;
        let newAddr = null;

        // 1. Kakao Places lookup by name (browser-native, no proxy)
        if (placeQuery) {
            try {
                const apiResults = await searchKakaoPlaces(placeQuery, currentUserLat, currentUserLng);
                if (Array.isArray(apiResults) && apiResults.length > 0) {
                    newLat = apiResults[0].lat;
                    newLng = apiResults[0].lng;
                    newAddr = apiResults[0].address;
                }
            } catch (e) {}
        }

        // 2. Fallback to Naver Geocoder for address string if the name lookup returned no coordinates
        if ((!newLat || !newLng) && addressQuery) {
            const refined = await refineCoordinatesViaNaverGeocoder(addressQuery);
            if (refined) {
                newLat = refined.lat;
                newLng = refined.lng;
            }
        }

        // Update IndexedDB record with new precise coordinates
        if (newLat && newLng) {
            const payload = { lat: newLat, lng: newLng };
            if (newAddr && !place.address) payload.address = newAddr;
            await db.places.update(place.id, payload);
            updatedCount++;
        }
    };

    // Refresh in small concurrent batches — sequential lookups made this scale linearly with saved places
    const BATCH_SIZE = 4;
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
        await Promise.all(targets.slice(i, i + BATCH_SIZE).map(refreshOnePlace));
    }

    await updateDashboardStats();
    await renderPlacesList();
    updateMapMarkers();
    if (updatedCount > 0 && syncRoomId) await pushAllLocalPlacesToCloud();
    showToast(`저장된 위시리스트 & 다녀온 곳 핀 ${updatedCount}개를 네이버 API Hub 최신 위치로 100% 업데이트 완료했습니다! 📍✨`, "success");
};

// Naver's geocoding endpoint answers with no CORS header when the current origin is not registered as a
// Web service URL for the Maps client id. Every call then fails identically, so once that is observed the
// engine is switched off for the session — otherwise each search fires ~37 doomed cross-origin requests.
let naverGeocoderErrorStreak = 0;
let naverGeocoderDisabled = false;
const NAVER_GEOCODER_ERROR_LIMIT = 5;

function isNaverGeocoderUsable() {
    if (naverGeocoderDisabled) return false;
    return !!(isNaverMapActive && window.naver && window.naver.maps
        && window.naver.maps.Service && window.naver.maps.Service.geocode);
}

// ZERO_RESULT is a normal "nothing matched" answer and must not count as a failure.
function noteNaverGeocoderStatus(status) {
    if (naverGeocoderDisabled) return;
    if (status === naver.maps.Service.Status.ERROR) {
        naverGeocoderErrorStreak++;
        if (naverGeocoderErrorStreak >= NAVER_GEOCODER_ERROR_LIMIT) {
            naverGeocoderDisabled = true;
            console.warn(
                `[Naver Geocoder] 연속 ${NAVER_GEOCODER_ERROR_LIMIT}회 실패하여 이번 세션 동안 비활성화합니다. ` +
                `Ncloud 콘솔에서 Maps 키(${naverClientId})의 Web 서비스 URL에 ${location.origin} 을 등록하세요.`
            );
        }
    } else {
        naverGeocoderErrorStreak = 0;
    }
}

// Refine coordinates using Naver Geocoder (returns precise building-level lat/lng with a safety timeout)
function refineCoordinatesViaNaverGeocoder(address) {
    return new Promise((resolve) => {
        if (!address || typeof address !== 'string') {
            resolve(null);
            return;
        }
        if (!isNaverGeocoderUsable()) {
            resolve(null);
            return;
        }

        // Clean parenthetical notes like "(대전 유성구 문지동~~~)", floor numbers, and AURA suffix
        let cleanQuery = address.replace(/\(.*?\)/g, " ")
                               .replace(/~+/g, " ")
                               .replace(/\s*\d+층/g, "")
                               .replace(/\s*[B|b]?\d+호/g, "")
                               .replace(/\s*지하\d+층?/g, "")
                               .replace(/\s*-\s*AURA.*$/, "")
                               .replace(/^💡\s*메모:\s*/, "")
                               .trim();

        // Extract road address or dong/ri address if present inside long strings
        const roadMatch = cleanQuery.match(/([가-힣A-Za-z0-9\s]+(?:로|길|번길)\s*\d+(?:-\d+)?)/);
        if (roadMatch) {
            cleanQuery = roadMatch[1].trim();
        }

        let done = false;
        const timer = setTimeout(() => {
            if (!done) {
                done = true;
                resolve(null);
            }
        }, 1200);

        try {
            naver.maps.Service.geocode({ query: cleanQuery }, (status, response) => {
                noteNaverGeocoderStatus(status);
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    if (status === naver.maps.Service.Status.OK && response.v2 && response.v2.addresses && response.v2.addresses.length > 0) {
                        const addr = response.v2.addresses[0];
                        const lat = parseFloat(addr.y);
                        const lng = parseFloat(addr.x);
                        if (lat > 30 && lat < 45 && lng > 120 && lng < 135) {
                            resolve({ lat, lng });
                            return;
                        }
                    }
                    // Fallback to raw address query
                    if (cleanQuery !== address && isNaverGeocoderUsable()) {
                        naver.maps.Service.geocode({ query: address }, (status2, response2) => {
                            noteNaverGeocoderStatus(status2);
                            if (status2 === naver.maps.Service.Status.OK && response2.v2 && response2.v2.addresses && response2.v2.addresses.length > 0) {
                                const addr2 = response2.v2.addresses[0];
                                resolve({ lat: parseFloat(addr2.y), lng: parseFloat(addr2.x) });
                            } else {
                                resolve(null);
                            }
                        });
                    } else {
                        resolve(null);
                    }
                }
            });
        } catch (e) {
            if (!done) {
                done = true;
                clearTimeout(timer);
                resolve(null);
            }
        }
    });
}

// 6. In-App Map Real-Time Search Pipeline (Local KB → Naver Geocoder → Naver POI API → AI → Nominatim)
// Shared road-address candidate extraction (previously duplicated as pipeline steps 1 and 5.5)
// Handles inputs like "대전 유성구 문지동 엑스포로446번길 36 1층 소바공방" or "서울 중구 다산로 108 진남포면옥"
function extractAddressCandidates(query) {
    const noUnits = query.replace(/\s*\d+층/g, "")
                         .replace(/\s*[B|b]?\d+호/g, "")
                         .replace(/\s*지하\d+층?/g, "")
                         .replace(/\s*지하/g, "")
                         .trim();

    const roadMatch = noUnits.match(/([가-힣A-Za-z0-9]+(?:로|길|번길)\s*\d+(?:-\d+)?)/);
    if (!roadMatch) return null;

    const noDong = noUnits.replace(/[가-힣]+동\s+/g, "").trim();
    const fullRoadNoDongMatch = noDong.match(/([가-힣\s\d]+(?:로|길|번길)\s*\d+(?:-\d+)?)/);

    let titleName = noUnits.replace(roadMatch[0], "").trim();
    titleName = titleName.replace(/^[가-힣]+구\s+/, "").replace(/^[가-힣]+동\s+/, "").trim();
    if (!titleName || titleName.length < 2) titleName = query.trim();

    return {
        titleName,
        candidates: [
            fullRoadNoDongMatch ? fullRoadNoDongMatch[1].trim() : null,
            roadMatch[0].trim(),
            noUnits,
            noDong
        ].filter(Boolean)
    };
}

// Races the address candidates through the geocoder in parallel rather than awaiting each in turn
async function geocodeAddressCandidates(query) {
    if (!isNaverMapActive) return null;
    const extracted = extractAddressCandidates(query);
    if (!extracted) return null;

    try {
        const hit = await Promise.any(
            extracted.candidates.map((cand) =>
                refineCoordinatesViaNaverGeocoder(cand).then((refined) => {
                    if (!refined) throw new Error("no-match");
                    return { cand, refined };
                })
            )
        );
        return {
            name: extracted.titleName,
            address: hit.cand,
            lat: hit.refined.lat,
            lng: hit.refined.lng,
            category: "Restaurant"
        };
    } catch (err) {
        return null;
    }
}

// Disables the search button while a search is running so repeated clicks/Enter presses can't stack
// duplicate engine fan-outs on top of each other.
function setMapSearchBusy(isBusy) {
    const btn = document.getElementById("btn-map-search");
    if (!btn) return;
    btn.disabled = isBusy;
    btn.style.opacity = isBusy ? "0.6" : "";
    btn.style.cursor = isBusy ? "wait" : "";
}

let isMapSearchRunning = false;

async function handleInAppMapSearch() {
    const inputEl = document.getElementById("map-search-query");
    if (!inputEl) return;
    const query = inputEl.value.trim();
    if (!query) {
        showToast("검색어를 입력해 주세요 📍", "warning");
        return;
    }
    if (isMapSearchRunning) return;

    isMapSearchRunning = true;
    setMapSearchBusy(true);
    try {
        await runInAppMapSearch(query);
    } finally {
        isMapSearchRunning = false;
        setMapSearchBusy(false);
    }
}

async function runInAppMapSearch(query) {
    // Invalidate any in-flight search so its late results can't overwrite this one
    const myGeneration = ++mapSearchGeneration;
    const isStale = () => myGeneration !== mapSearchGeneration;

    // Clear old search markers and panel
    clearSearchMarkers();

    // Serve repeat searches straight from the in-session cache
    const cacheKey = query.toLowerCase().replace(/\s+/g, " ");
    const cached = mapSearchResultCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < MAP_SEARCH_CACHE_TTL_MS) {
        renderMapSearchResults(cached.results);
        showToast(`'${query}' 검색 결과 ${cached.results.length}건 (최근 검색 캐시) 📍`, "success");
        return;
    }

    showToast(`'${query}' 장소를 지도에서 탐색 중입니다... 📍`, "info");

    let combinedResults = [];

    // Detect user's current GPS location (max 1s timeout)
    const userLoc = await getUserCurrentLocation();
    if (isStale()) return;
    const userLat = userLoc ? userLoc.lat : null;
    const userLng = userLoc ? userLoc.lng : null;

    // 1. All primary engines run CONCURRENTLY and their results are MERGED.
    // Running them in sequence behind `length === 0` guards meant whichever engine answered first
    // silently suppressed all the others. Wall-clock cost here is the slowest engine, not the sum.
    if (combinedResults.length === 0) {
        const engines = [
            ["Kakao Places", searchKakaoPlaces(query, userLat, userLng)],
            ["Kakao Address Geocoder", searchKakaoGeocoder(query)],
            ["Pure Address & Store Extraction", geocodeAddressCandidates(query).then(hit => hit ? [hit] : [])]
        ];
        if (isNaverMapActive) {
            engines.push(["Naver Geocoder", searchNaverGeocoder(query, userLat, userLng)]);
        }

        // Every engine catches internally and resolves null on failure, so a rejected outcome is rare —
        // per-engine counts are logged unconditionally, otherwise a silently-empty engine is invisible.
        const engineStart = performance.now();
        const settled = await Promise.allSettled(engines.map(([, p]) => p));
        const report = {};
        settled.forEach((outcome, i) => {
            const engineName = engines[i][0];
            if (outcome.status === "fulfilled") {
                const got = Array.isArray(outcome.value) ? outcome.value.length : 0;
                report[engineName] = got;
                if (got > 0) combinedResults.push(...outcome.value);
            } else {
                report[engineName] = `THREW: ${outcome.reason && outcome.reason.message}`;
            }
        });
        console.log(`[Map Search] '${query}' engines (${Math.round(performance.now() - engineStart)}ms)`, report);
        if (isStale()) return;
    }

    // 3. AI Business Directory search via Gemini — intentionally disabled. It was silently spending
    // Gemini's limited free-tier quota on every map search that returned fewer than 4 results, which
    // is common. Gemini is still used for the separate "AI 코스 플래너" chat feature, just not here.

    // 4. OpenStreetMap Nominatim Free Search Engine (Final fallback only)
    if (combinedResults.length === 0) {
        try {
            const freeResults = await searchNominatimFree(query, userLat, userLng);
            if (Array.isArray(freeResults) && freeResults.length > 0) {
                combinedResults.push(...freeResults);
            }
        } catch (err) {
            console.warn("[OpenStreetMap Search Error]", err);
        }
        if (isStale()) return;
    }

    // Deduplicate combined results by name & location proximity
    const uniqueResults = [];
    const seenMap = new Set();

    for (const item of combinedResults) {
        if (!item.lat || !item.lng) continue;
        const latFixed = parseFloat(item.lat).toFixed(3);
        const lngFixed = parseFloat(item.lng).toFixed(3);
        const key = `${(item.name || "").trim()}_${latFixed}_${lngFixed}`;

        if (!seenMap.has(key)) {
            seenMap.add(key);

            if (userLoc && item.lat && item.lng) {
                item.distanceKm = calculateDistanceKm(userLoc.lat, userLoc.lng, item.lat, item.lng);
            } else {
                item.distanceKm = Infinity;
            }

            uniqueResults.push(item);
        }
    }

    // Sort by proximity: Nearest to current user position ranked at top!
    if (userLoc) {
        uniqueResults.sort((a, b) => (a.distanceKm || Infinity) - (b.distanceKm || Infinity));
    }

    if (isStale()) return;

    if (uniqueResults.length > 0) {
        // Only cache when a location fix was actually obtained — otherwise every item was written
        // with distanceKm:Infinity and no sort applied (see the loop above), and caching that would
        // make every repeat search of the same query replay the no-distance result for the next 10
        // minutes even after geolocation would have succeeded on a fresh attempt.
        if (userLoc) {
            mapSearchResultCache.set(cacheKey, { results: uniqueResults, timestamp: Date.now() });
        }
        renderMapSearchResults(uniqueResults);
        const proximityNotice = userLoc ? " (내 위치 가까운 순 정렬)" : "";
        showToast(`'${query}' 검색 결과 총 ${uniqueResults.length}건을 찾았습니다!${proximityNotice} 📍`, "success");
    } else {
        showToast(`'${query}' 자동 탐색 중입니다. 지도의 원하는 건물/위치를 바로 클릭하여 핀을 꽂으실 수 있습니다 📍`, "info");
        enableManualMapPinMode(query);
    }
}
window.handleInAppMapSearch = handleInAppMapSearch;

// Console diagnostic: runs every search engine independently, bypassing the result cache.
// Usage from DevTools:  await debugMapSearch("민테크")
window.debugMapSearch = async function(query) {
    mapSearchResultCache.delete(query.toLowerCase().replace(/\s+/g, " "));

    const userLoc = await getUserCurrentLocation();
    const userLat = userLoc ? userLoc.lat : null;
    const userLng = userLoc ? userLoc.lng : null;

    const engines = [
        ["Kakao Places", () => searchKakaoPlaces(query, userLat, userLng)],
        ["주소추출 Geocode", () => geocodeAddressCandidates(query).then(h => h ? [h] : [])],
        ["Naver Geocoder", () => searchNaverGeocoder(query, userLat, userLng)],
        ["Nominatim", () => searchNominatimFree(query, userLat, userLng)],
        ["Gemini AI", async () => cleanAndParseJSON(await callGeminiSearchAPI(query))]
    ];

    const rows = [];
    for (const [name, run] of engines) {
        const t0 = performance.now();
        let count = 0;
        let note = "";
        try {
            const out = await run();
            count = Array.isArray(out) ? out.length : 0;
            if (count > 0) note = out.slice(0, 3).map(r => r.name).join(" / ");
            else if (out === null) note = "null 반환 (실패 또는 결과 없음)";
        } catch (err) {
            note = `예외: ${err && err.message}`;
        }
        rows.push({ 엔진: name, 결과: count, ms: Math.round(performance.now() - t0), 비고: note });
    }

    console.table(rows);
    console.log("SDK 상태:", {
        kakaoReady: !!(window.kakao && window.kakao.maps && window.kakao.maps.services),
        kakaoScriptTag: !!document.getElementById("kakao-map-sdk-script"),
        kakaoKey: kakaoApiKey ? `${kakaoApiKey.slice(0, 6)}...` : "없음",
        naverReady: !!(window.naver && window.naver.maps && window.naver.maps.Service),
        isNaverMapActive: isNaverMapActive,
        naverClientId: naverClientId,
        origin: location.origin,
        serviceWorker: navigator.serviceWorker && navigator.serviceWorker.controller
            ? navigator.serviceWorker.controller.scriptURL
            : "없음(정상)",
        geminiKey: geminiApiKey ? "설정됨" : "없음",
        위치: userLoc || "미허용/실패",
    });
    return rows;
};

// OpenStreetMap Nominatim Free Search Helper (CORS-free, Key-free POI search)
async function searchNominatimFree(query, userLat, userLng) {
    // Nominatim asks clients to stay light, so this stays at two concurrent requests: the bare query
    // plus one region-qualified variant derived from the user's position (not a hardcoded city).
    const nearestRegion = getNearbyRegionNames(userLat, userLng, 1)[0];
    const queriesToTry = [query, `${nearestRegion} ${query}`];

    const settled = await Promise.allSettled(queriesToTry.map((qStr) => {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(qStr)}&countrycodes=kr&limit=10`;
        return fetchWithTimeout(url, { headers: { 'Accept-Language': 'ko' } }, 1500)
            .then((res) => res.json());
    }));

    // Merge across variants instead of taking whichever answered first
    const byKey = new Map();
    for (const outcome of settled) {
        if (outcome.status !== "fulfilled" || !Array.isArray(outcome.value)) continue;
        for (const item of outcome.value) {
            const lat = parseFloat(item.lat);
            const lng = parseFloat(item.lon);
            if (isNaN(lat) || isNaN(lng)) continue;

            const key = item.osm_id ? `${item.osm_type}_${item.osm_id}` : `${lat.toFixed(5)}_${lng.toFixed(5)}`;
            if (byKey.has(key)) continue;

            const cleanTitle = (item.display_name || "").split(',')[0].trim();
            byKey.set(key, {
                name: query.length < 8 ? `${query} (${cleanTitle})` : cleanTitle,
                address: item.display_name,
                lat: lat,
                lng: lng,
                category: "Restaurant"
            });
        }
    }

    return byKey.size > 0 ? Array.from(byKey.values()) : null;
}

// Enable Manual Map Pin Placement Mode when auto-search returns 0 items
window.enableManualMapPinMode = function(placeName) {
    showToast(`지도의 원하는 건물/위치를 직접 클릭하면 '${placeName}' 마커가 생성됩니다 📍`, "info");
    
    if (isNaverMapActive && map && window.naver && window.naver.maps) {
        const listener = naver.maps.Event.addListener(map, "click", async (e) => {
            naver.maps.Event.removeListener(listener);
            const lat = e.coord.lat();
            const lng = e.coord.lng();
            
            let addrStr = "사용자 선택 지도 위치";
            try {
                if (naver.maps.Service && naver.maps.Service.reverseGeocode) {
                    naver.maps.Service.reverseGeocode({
                        coords: e.coord,
                        orders: [
                            naver.maps.Service.OrderType.ADDR,
                            naver.maps.Service.OrderType.ROAD_ADDR
                        ].join(',')
                    }, (status, response) => {
                        if (status === naver.maps.Service.Status.OK && response.v2 && response.v2.address) {
                            addrStr = response.v2.address.roadAddress || response.v2.address.jibunAddress || addrStr;
                        }
                        createManualPin(placeName, addrStr, lat, lng);
                    });
                    return;
                }
            } catch(err) {}
            createManualPin(placeName, addrStr, lat, lng);
        });
    }
};

function createManualPin(placeName, address, lat, lng) {
    const manualResult = [{
        name: placeName,
        address: address,
        lat: lat,
        lng: lng,
        category: "Restaurant"
    }];
    renderMapSearchResults(manualResult);
    showToast(`'${placeName}' 장소 마커를 지도 위치에 직접 설정했습니다! 📍✨`, "success");
}

// Naver Native Geocoder Promise Wrapper (Supports address, building, apartment complex, store & restaurant lookup)
function searchNaverGeocoder(query, userLat, userLng) {
    return new Promise((resolve) => {
        if (!isNaverGeocoderUsable()) {
            resolve(null);
            return;
        }

        const cleanQ = query.trim();
        const queriesToTry = [cleanQ];

        // Address & Unit/Store Parsing (e.g. "대전 유성구 문지동 엑스포로446번길 36 1층 소바공방")
        const noUnits = cleanQ.replace(/\s*\d+층/g, "")
                              .replace(/\s*[B|b]?\d+호/g, "")
                              .replace(/\s*지하\d+층?/g, "")
                              .replace(/\s*지하/g, "")
                              .trim();
        if (noUnits !== cleanQ && !queriesToTry.includes(noUnits)) {
            queriesToTry.push(noUnits);
        }

        // Remove dong names (e.g. "대전 유성구 문지동 엑스포로446번길 36" -> "대전 유성구 엑스포로446번길 36")
        const noDong = noUnits.replace(/[가-힣]+동\s+/g, "").trim();
        if (noDong !== noUnits && !queriesToTry.includes(noDong)) {
            queriesToTry.push(noDong);
        }

        // Extract pure road address pattern (e.g. "엑스포로446번길 36", "대전 유성구 엑스포로446번길 36")
        const fullRoadAddrMatch = noDong.match(/([가-힣\s\d]+(?:로|길|번길)\s*\d+(?:-\d+)?)/);
        if (fullRoadAddrMatch) {
            const extractedRoad = fullRoadAddrMatch[1].trim();
            if (!queriesToTry.includes(extractedRoad)) {
                queriesToTry.push(extractedRoad);
            }
        }

        const roadOnlyMatch = cleanQ.match(/([가-힣A-Za-z0-9]+(?:로|길|번길)\s*\d+(?:-\d+)?)/);
        if (roadOnlyMatch) {
            const roadOnlyStr = roadOnlyMatch[1].trim();
            if (!queriesToTry.includes(roadOnlyStr)) {
                queriesToTry.push(roadOnlyStr);
            }
        }

        // These variants are the recall engine for bare business names ("민테크" -> "대전 민테크", ...).
        // They are all dispatched at once below and cut off by a single timer, so the list length costs
        // essentially no wall-clock time — do not trim it to "reduce requests".
        const cityPrefixed = [
            `서울 ${cleanQ}`, `경기 ${cleanQ}`, `인천 ${cleanQ}`, `부산 ${cleanQ}`,
            `대구 ${cleanQ}`, `대전 ${cleanQ}`, `광주 ${cleanQ}`, `울산 ${cleanQ}`,
            `세종 ${cleanQ}`, `수원 ${cleanQ}`, `천안 ${cleanQ}`, `청주 ${cleanQ}`,
            `전주 ${cleanQ}`, `창원 ${cleanQ}`, `포항 ${cleanQ}`, `강남구 ${cleanQ}`,
            `서초구 ${cleanQ}`, `송파구 ${cleanQ}`, `마포구 ${cleanQ}`, `성동구 ${cleanQ}`,
            `영등포구 ${cleanQ}`, `용산구 ${cleanQ}`, `유성구 ${cleanQ}`, `종로구 ${cleanQ}`,
            `중구 ${cleanQ}`, `분당 ${cleanQ}`, `일산 ${cleanQ}`, `판교 ${cleanQ}`,
            `성수 ${cleanQ}`, `홍대 ${cleanQ}`
        ];
        cityPrefixed.forEach(c => {
            if (!queriesToTry.includes(c)) queriesToTry.push(c);
        });

        if (!cleanQ.includes("아파트") && !cleanQ.includes("빌딩") && !cleanQ.includes("타워") && !cleanQ.includes("점") && cleanQ.length <= 10) {
            queriesToTry.push(`${cleanQ} 맛집`);
            queriesToTry.push(`${cleanQ} 식당`);
            queriesToTry.push(`${cleanQ} 카페`);
            queriesToTry.push(`${cleanQ} 본점`);
            queriesToTry.push(`${cleanQ} 아파트`);
            queriesToTry.push(`${cleanQ} 빌딩`);
        }

        let combined = [];
        let completed = 0;
        let isResolved = false;
        const seenCoordinates = new Set();

        const finish = () => {
            if (!isResolved) {
                isResolved = true;
                resolve(combined.length > 0 ? combined : null);
            }
        };

        // Collection window for the parallel geocode fan-out — too short and slower variants get dropped
        const timer = setTimeout(finish, 2200);

        // Auto category classifier helper
        const detectCategory = (title, addrStr) => {
            const combinedText = `${title} ${addrStr}`.toLowerCase();
            if (combinedText.includes("카페") || combinedText.includes("커피") || combinedText.includes("베이커리") || combinedText.includes("디저트") || combinedText.includes("로스터리")) return "Cafe";
            if (combinedText.includes("식당") || combinedText.includes("맛집") || combinedText.includes("갈비") || combinedText.includes("냉면") || combinedText.includes("고기") || combinedText.includes("치킨") || combinedText.includes("피자") || combinedText.includes("파스타") || combinedText.includes("스시") || combinedText.includes("국밥") || combinedText.includes("푸드") || combinedText.includes("반점") || combinedText.includes("버거") || combinedText.includes("우동") || combinedText.includes("라멘")) return "Restaurant";
            if (combinedText.includes("바") || combinedText.includes("펍") || combinedText.includes("호프") || combinedText.includes("주점") || combinedText.includes("와인") || combinedText.includes("맥주") || combinedText.includes("칵테일") || combinedText.includes("포차")) return "Bar";
            if (combinedText.includes("공원") || combinedText.includes("파크") || combinedText.includes("수목원") || combinedText.includes("식물원") || combinedText.includes("유원지")) return "Park";
            if (combinedText.includes("미술관") || combinedText.includes("박물관") || combinedText.includes("전시관") || combinedText.includes("갤러리") || combinedText.includes("아트센터")) return "Museum";
            return "Other";
        };

        queriesToTry.forEach((qStr) => {
            const geocodeOptions = { query: qStr };
            if (userLat && userLng) {
                geocodeOptions.coordinate = `${userLng},${userLat}`;
            }

            naver.maps.Service.geocode(geocodeOptions, (status, response) => {
                completed++;
                noteNaverGeocoderStatus(status);
                if (status === naver.maps.Service.Status.OK && response.v2 && response.v2.addresses && response.v2.addresses.length > 0) {
                    response.v2.addresses.forEach((addr) => {
                        const lat = parseFloat(addr.y);
                        const lng = parseFloat(addr.x);
                        if (isNaN(lat) || isNaN(lng) || lat < 30 || lat > 45 || lng < 120 || lng > 135) return;

                        const coordKey = `${lat.toFixed(4)}_${lng.toFixed(4)}`;
                        if (seenCoordinates.has(coordKey)) return;
                        seenCoordinates.add(coordKey);

                        let buildingName = "";
                        if (addr.addressElements) {
                            const el = addr.addressElements.find(e => e.types && (e.types.includes("BUILDING_NAME") || e.types.includes("LANDMARK") || e.types.includes("APARTMENT") || e.types.includes("SITE_NAME")));
                            if (el && el.longName) {
                                buildingName = el.longName;
                            }
                        }
                        const shortAddr = addr.roadAddress || addr.jibunAddress || "";
                        let displayTitle = cleanQ;

                        if (buildingName) {
                            if (buildingName.toLowerCase().includes(cleanQ.toLowerCase())) {
                                displayTitle = buildingName;
                            } else {
                                displayTitle = `${cleanQ} (${buildingName})`;
                            }
                        } else if (shortAddr) {
                            if (!cleanQ.includes(shortAddr) && shortAddr.length > 3) {
                                displayTitle = `${cleanQ} (${shortAddr})`;
                            }
                        }

                        const category = detectCategory(displayTitle, shortAddr);

                        combined.push({
                            name: displayTitle,
                            address: shortAddr || "네이버 지도 주소",
                            lat: lat,
                            lng: lng,
                            category: category
                        });
                    });
                }

                if (completed === queriesToTry.length) {
                    clearTimeout(timer);
                    finish();
                }
            });
        });
    });
}

// Static fallback list — Google periodically retires model versions (this list 404'd in full once
// already), so it's a last resort. getAvailableGeminiModels() below queries the account's actually-
// available models first, which is what keeps this working without needing a code update every time
// Google ships a new model generation.
const GEMINI_CANDIDATE_MODELS = [
    "gemini-flash-latest",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash-latest",
    "gemini-1.5-flash"
];

let cachedGeminiModelList = null;
async function getAvailableGeminiModels() {
    if (cachedGeminiModelList) return cachedGeminiModelList;
    try {
        // fetch() has no default timeout — without this, a stalled response here would hang forever
        // and block every downstream candidate model from ever being tried, since this is awaited
        // before the retry loop even starts.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiApiKey}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await res.json();
        cachedGeminiModelList = (data.models || [])
            .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
            .map(m => m.name.replace(/^models\//, ""))
            // Keep to the cheap/fast "flash" family and exclude non-text variants (vision/tts/image/embedding).
            .filter(n => /flash/i.test(n) && !/vision|embed|tts|image/i.test(n));
    } catch (e) {
        console.warn("[Gemini API] 모델 목록 조회 실패, 고정 후보 목록만 사용:", e.message);
        cachedGeminiModelList = [];
    }
    return cachedGeminiModelList;
}

// Core robust Gemini API Caller with automatic model fallback
async function callGeminiRaw(userPrompt, systemInstruction = "", isJsonMode = true) {
    if (!geminiApiKey) throw new Error("Gemini API Key가 등록되지 않았습니다.");

    let lastError = null;

    const discovered = await getAvailableGeminiModels();
    const candidateModels = [...new Set([...discovered, ...GEMINI_CANDIDATE_MODELS])];

    for (const modelName of candidateModels) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;
            const parts = [];
            if (systemInstruction) {
                parts.push({ text: systemInstruction });
            }
            parts.push({ text: userPrompt });

            const requestBody = {
                contents: [{ parts: parts }]
            };

            if (isJsonMode) {
                requestBody.generationConfig = { responseMimeType: "application/json" };
            }

            // Same reasoning as the timeout in getAvailableGeminiModels() above: a stalled response
            // from one candidate model must not freeze the whole chat forever — it needs to time out
            // and fall through to the next candidate instead.
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000);
            let response;
            try {
                response = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                });
            } catch (fetchErr) {
                if (fetchErr.name === "AbortError") {
                    console.warn(`[Gemini API] Model ${modelName} timed out, trying next candidate...`);
                    lastError = new Error(`${modelName} 응답 시간 초과`);
                    continue;
                }
                throw fetchErr;
            } finally {
                clearTimeout(timeoutId);
            }

            if (!response.ok) {
                const errJson = await response.json().catch(() => ({}));
                const errMsg = errJson.error?.message || `HTTP ${response.status}`;
                // 429/quota and 503/overload errors are per-model, not per-key — a model being
                // exhausted or momentarily overloaded doesn't mean the others are too, so fall through
                // to the next candidate instead of giving up. "High demand" / UNAVAILABLE is Google's
                // wording for a temporarily overloaded model — same failure class as 429, just no
                // formal quota involved.
                const isUnavailable = response.status === 404 || errMsg.includes("not found") || errMsg.includes("not supported");
                const isQuotaExceeded = response.status === 429 || errMsg.toLowerCase().includes("quota") || errMsg.includes("RESOURCE_EXHAUSTED");
                const isOverloaded = response.status === 503 || errMsg.toLowerCase().includes("overloaded") || errMsg.toLowerCase().includes("high demand") || errMsg.includes("UNAVAILABLE");
                if (isUnavailable || isQuotaExceeded || isOverloaded) {
                    console.warn(`[Gemini API] Model ${modelName} unavailable (${errMsg}), trying next candidate...`);
                    lastError = new Error(errMsg);
                    continue;
                }
                throw new Error(errMsg);
            }

            const data = await response.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error("AI 응답 데이터가 비어있습니다.");
            return text;
        } catch (err) {
            lastError = err;
            if (err.message && (err.message.includes("not found") || err.message.includes("not supported") || err.message.includes("404"))) {
                continue;
            }
            throw err;
        }
    }
    
    throw lastError || new Error("모든 Gemini 모델 호출에 실패했습니다.");
}

// Dedicated Gemini API call for map geocoding & multi-branch / apartment search
async function callGeminiSearchAPI(query) {
    const searchPrompt = `You are a Smart Geocoding & Business/Store/Restaurant Search utility for South Korea.
The user searched for: "${query}"

Instructions:
1. TYPO CORRECTION & FUZZY MATCHING: If the user query has typos, spelling mistakes, or phonetic errors in Korean (e.g., if user searches "소방공방", recognize it as "소바공방" in Daejeon Munji-dong / Expo-ro 446beon-gil 36), automatically correct the typo and locate the real store.
2. COMBINED ADDRESS & STORE PARSING: If the user input contains a full address, floor number, and store name (e.g. "대전 유성구 문지동 엑스포로446번길 36 1층 소바공방"), extract the real store name ("소바공방") and its official Korean Road Address ("대전광역시 유성구 엑스포로446번길 36").
3. ACCURATE COORDINATES: Find 4-8 REAL, SPECIFIC, EXISTING stores, shops, local restaurants, cafes, bakeries, eateries, or venues matching "${query}" in South Korea with exact real Korean road-name addresses and precise latitude/longitude coordinates in South Korea.

Return STRICTLY a JSON array of objects with this format (no markdown, no preamble):
[
  {
    "name": "Exact Store/Landmark Name in Korean (e.g., 소바공방, 소문난성수감자탕)",
    "address": "Detailed Real Official Korean Road Address (e.g., 대전광역시 유성구 엑스포로446번길 36)",
    "lat": 36.xxxx or 37.xxxx or 35.xxxx (latitude in South Korea),
    "lng": 127.xxxx or 129.xxxx (longitude in South Korea),
    "category": "Cafe" | "Restaurant" | "Bar" | "Park" | "Museum" | "Other"
  }
]`;

    return await callGeminiRaw(`Search query: ${query}`, searchPrompt, true);
}

function clearSearchMarkers() {
    // Remove search results panel if exists
    const panel = document.getElementById("map-search-results-panel");
    if (panel) panel.remove();

    if (isNaverMapActive) {
        naverSearchMarkers.forEach(m => m.setMap(null));
        naverSearchMarkers = [];
    } else {
        // For Leaflet, clear search markers
        updateMapMarkers();
    }
}

window.focusMapSearchResult = function(index, lat, lng) {
    if (isNaverMapActive && map) {
        map.setCenter(new naver.maps.LatLng(lat, lng));
        map.setZoom(16);
        if (naverSearchMarkers[index]) {
            naver.maps.Event.trigger(naverSearchMarkers[index], "click");
        }
    } else if (map) {
        map.setView([lat, lng], 16);
    }
};

function renderMapSearchResults(results) {
    clearSearchMarkers();

    if (!results || results.length === 0) return;

    // Create interactive search results panel below search bar
    const searchBar = document.querySelector(".map-search-bar");
    if (searchBar) {
        const panel = document.createElement("div");
        panel.id = "map-search-results-panel";
        panel.className = "map-search-results-panel";

        let cardsHtml = "";
        results.forEach((res, idx) => {
            const encodedData = encodeURIComponent(JSON.stringify(res));
            const distBadge = (res.distanceKm && res.distanceKm !== Infinity) 
                ? `<span style="font-size:0.68rem; color:var(--color-primary); background:rgba(255,101,132,0.1); border:1px solid rgba(255,101,132,0.25); padding:1px 6px; border-radius:8px; margin-left:6px; font-weight:normal; display:inline-block;">📍 내 위치에서 ${formatDistanceStr(res.distanceKm)}</span>` 
                : '';

            cardsHtml += `
                <div class="search-result-card" id="search-res-item-${idx}">
                    <div class="search-result-title">${idx + 1}. ${res.name} ${distBadge}</div>
                    <div class="search-result-addr">${res.address}</div>
                    <div class="search-result-actions">
                        <button class="btn btn-outline search-btn-sm" onclick="focusMapSearchResult(${idx}, ${res.lat}, ${res.lng})">
                            🎯 위치보기
                        </button>
                        <button class="btn btn-primary search-btn-sm" onclick="saveMapSearchResult('${encodedData}')">
                            💖 위시리스트
                        </button>
                        <button class="btn btn-secondary search-btn-sm" style="background:linear-gradient(135deg, #FF9F1C, #FFBF69); color:white; border:none;" onclick="saveMapSearchResultVisited('${encodedData}')">
                            📸 다녀온 곳
                        </button>
                        <button class="btn btn-outline search-btn-sm" onclick="copyNaverMapUrl('${encodedData}')">
                            📋 URL 복사
                        </button>
                    </div>
                </div>
            `;
        });

        panel.innerHTML = `
            <div class="search-results-header">
                <span>📍 네이버 지도 검색 결과 (${results.length}건)</span>
                <button class="btn-close-results" onclick="clearSearchMarkers()">닫기 ✖</button>
            </div>
            <div class="search-results-list">
                ${cardsHtml}
            </div>
        `;
        searchBar.parentElement.insertBefore(panel, searchBar.nextSibling);
    }

    if (isNaverMapActive) {
        // The result panel above is already rendered; if the Naver SDK never finished loading we skip
        // the map markers rather than throwing (or falling through to the Leaflet path, which would
        // run Leaflet calls against a Naver map instance).
        if (!window.naver || !window.naver.maps) return;

        const bounds = new naver.maps.LatLngBounds();
        results.forEach((res, idx) => {
            const markerColor = "#FFB703"; // Yellow search markers
            const contentHtml = `
                <div class="search-naver-marker animate-marker" style="background-color:${markerColor}; width:22px; height:22px; border-radius:50%; border:2.5px solid white; box-shadow: 0 0 10px rgba(0,0,0,0.3); transform:translate(-11px, -11px); display:flex; align-items:center; justify-content:center; color:black; font-size:11px; font-weight:800; font-family:var(--font-heading);">${idx + 1}</div>
            `;
            
            const marker = new naver.maps.Marker({
                position: new naver.maps.LatLng(res.lat, res.lng),
                map: map,
                icon: {
                    content: contentHtml,
                    anchor: new naver.maps.Point(11, 11)
                }
            });
            
            const encodedData = encodeURIComponent(JSON.stringify(res));
            const infowindow = new naver.maps.InfoWindow({
                content: `
                    <div style="padding: 10px; font-family:var(--font-body); width:230px; background:white; border-radius:14px; border:2px solid var(--color-warning); box-shadow: 0 8px 24px rgba(0,0,0,0.15);">
                        <strong style="color:var(--color-text-high); font-size:0.85rem; display:block; margin-bottom:2px;">${idx + 1}. ${res.name}</strong>
                        <div style="font-size:0.7rem; color:#FF9F1C; margin-bottom:8px;">${res.address}</div>
                        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:4px; margin-bottom:4px;">
                            <button class="btn btn-primary" style="padding:0.3rem 0.4rem; font-size:0.7rem; justify-content:center;" onclick="saveMapSearchResult('${encodedData}')">
                                💖 위시리스트
                            </button>
                            <button class="btn btn-secondary" style="padding:0.3rem 0.4rem; font-size:0.7rem; justify-content:center; background:linear-gradient(135deg, #FF9F1C, #FFBF69); color:white; border:none;" onclick="saveMapSearchResultVisited('${encodedData}')">
                                📸 다녀온 곳
                            </button>
                        </div>
                        <button class="btn btn-outline" style="padding:0.3rem 0.4rem; font-size:0.7rem; width:100%; justify-content:center;" onclick="copyNaverMapUrl('${encodedData}')">
                            📋 네이버 지도 URL 복사
                        </button>
                    </div>
                `,
                borderWidth: 0,
                backgroundColor: "transparent",
                pixelOffset: new naver.maps.Point(0, -8)
            });
            
            naver.maps.Event.addListener(marker, "click", () => {
                infowindow.open(map, marker);
                setTimeout(() => lucide.createIcons(), 50);
            });
            
            naverSearchMarkers.push(marker);
            bounds.extend(marker.getPosition());
        });
        
        if (results.length === 1) {
            map.setCenter(new naver.maps.LatLng(results[0].lat, results[0].lng));
            map.setZoom(16);
        } else {
            map.fitBounds(bounds);
        }
    } else {
        // Fallback rendering inside Leaflet
        results.forEach((res, idx) => {
            const customIcon = L.divIcon({
                className: 'custom-search-marker',
                html: `<div style="background-color:#FFB703; width: 20px; height: 20px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 10px rgba(0,0,0,0.3); display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:bold; color:black;">${idx + 1}</div>`,
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });
            
            const encodedData = encodeURIComponent(JSON.stringify(res));
            const popupContent = `
                <div style="font-family:var(--font-body); min-width:180px; padding:4px;">
                    <strong style="font-size: 0.85rem; color: var(--color-text-high); display:block;">${idx + 1}. ${res.name}</strong>
                    <div style="font-size: 0.7rem; color: var(--color-text-low); margin-bottom:6px;">${res.address}</div>
                    <div style="display:flex; gap:4px; margin-bottom:4px;">
                        <button class="btn btn-primary" style="padding:0.25rem 0.4rem; font-size:0.7rem;" onclick="saveMapSearchResult('${encodedData}')">💖 위시리스트</button>
                        <button class="btn btn-secondary" style="padding:0.25rem 0.4rem; font-size:0.7rem; background:#FF9F1C; color:white; border:none;" onclick="saveMapSearchResultVisited('${encodedData}')">📸 다녀온 곳</button>
                    </div>
                    <button class="btn btn-outline" style="padding:0.25rem 0.4rem; font-size:0.7rem; width:100%;" onclick="copyNaverMapUrl('${encodedData}')">📋 URL 복사</button>
                </div>
            `;
            
            const marker = L.marker([res.lat, res.lng], { icon: customIcon })
                .bindPopup(popupContent)
                .addTo(map);
            
            map.setView([res.lat, res.lng], 14);
        });
    }
}

// Mock search results removed — all searches now use real Naver POI/Geocoder data only

// Copy Naver Map direct URL for a search result
window.copyNaverMapUrl = function(encoded) {
    const data = JSON.parse(decodeURIComponent(encoded));
    const naverUrl = `https://map.naver.com/v5/search/${encodeURIComponent(data.name)}?c=${data.lat},${data.lng},15,0,0,0,dh`;
    copyShareLinkToClipboard(naverUrl);
    showToast(`'${data.name}' 네이버 지도 URL 복사 완료! 📋 (신규 추가에 붙여넣어 보세요)`, "success");
};

// Save search result directly to Wishlist (with Naver Geocoder coordinate refinement)
// Opens a small date picker first so the visit date is set at add time, instead of always
// stamping "today" and requiring a separate edit afterward to fix it.
let pendingWishlistQuickSaveData = null;
window.saveMapSearchResult = function(encoded) {
    pendingWishlistQuickSaveData = JSON.parse(decodeURIComponent(encoded));
    const nameEl = document.getElementById("wishlistq-place-name");
    if (nameEl) nameEl.textContent = pendingWishlistQuickSaveData.name;
    applyDateFieldState("wishlistq", new Date().toISOString());
    const modal = document.getElementById("modal-wishlist-quickdate");
    if (modal) modal.classList.add("active");
};

window.closeWishlistQuickDateModal = function() {
    const modal = document.getElementById("modal-wishlist-quickdate");
    if (modal) modal.classList.remove("active");
    pendingWishlistQuickSaveData = null;
};

window.confirmWishlistQuickDate = async function() {
    const data = pendingWishlistQuickSaveData;
    const chosenDate = readDateFieldValue("wishlistq");
    const modal = document.getElementById("modal-wishlist-quickdate");
    if (modal) modal.classList.remove("active");
    pendingWishlistQuickSaveData = null;
    if (!data) return;
    await finalizeSaveMapSearchResultToWishlist(data, chosenDate);
};

async function finalizeSaveMapSearchResultToWishlist(data, chosenDate) {
    try {
        // Refine coordinates via Naver Geocoder for building-level precision
        let saveLat = data.lat;
        let saveLng = data.lng;
        if (data.address) {
            const refined = await refineCoordinatesViaNaverGeocoder(data.address);
            // Geocoder can mismatch a road name to a same-named road in another city — a refined
            // result that lands far from the original marker is more likely a bad match than a
            // genuine precision correction, so discard it and keep the original coordinates.
            if (refined && calculateDistanceKm(data.lat, data.lng, refined.lat, refined.lng) < 20) {
                saveLat = refined.lat;
                saveLng = refined.lng;
                console.log(`[Save Refine] ${data.name}: (${data.lat},${data.lng}) → Naver Geocoder (${saveLat},${saveLng})`);
            } else if (refined) {
                console.warn(`[Save Refine] Rejected implausible refine for ${data.name}: original (${data.lat},${data.lng}) vs refined (${refined.lat},${refined.lng})`);
            }
        }

        const naverUrl = `https://map.naver.com/v5/search/${encodeURIComponent(data.name)}?c=${saveLat},${saveLng},15,0,0,0,dh`;
        // "Duplicate" only means an active (non-tombstoned) entry for this place on the SAME chosen
        // date (or both "미정") — a different date is a separate visit plan and should be allowed,
        // e.g. planning to go to the same cafe again next month.
        const chosenDateKey = toLocalDateKey(chosenDate);
        const existing = await db.places.where("name").equalsIgnoreCase(data.name)
            .and(p => p.isDeleted !== 1 && p.isVisited !== -1 && toLocalDateKey(p.createdAt || p.date) === chosenDateKey)
            .first();
        if (existing) {
            showToast(`'${data.name}'은(는) 이미 같은 날짜로 위시리스트에 존재합니다! 💖`, "info");
            clearSearchMarkers();
            return;
        }

        const newPlaceId = await db.places.add({
            name: data.name,
            category: data.category || "Other",
            url: naverUrl,
            lat: saveLat,
            lng: saveLng,
            priority: "medium",
            notes: `${data.address || ''} - AURA 네이버 지도 저장 💖`.trim(),
            isVisited: 0,
            review: "",
            peopleCount: 2,
            photo: "",
            createdAt: chosenDate
        });

        showToast(`'${data.name}'을 데이트 위시리스트에 담았습니다! 💖`, "success");
        clearSearchMarkers();
        await updateDashboardStats();
        await renderPlacesList();
        updateMapMarkers();

        triggerSyncUpload(newPlaceId);
    } catch(err) {
        showToast("장소 저장 실패: " + err.message, "danger");
    }
};

// Save search result directly to Visited Places (with Naver Geocoder coordinate refinement)
window.saveMapSearchResultVisited = async function(encoded) {
    const data = JSON.parse(decodeURIComponent(encoded));
    try {
        // Refine coordinates via Naver Geocoder for building-level precision
        let saveLat = data.lat;
        let saveLng = data.lng;
        if (data.address) {
            const refined = await refineCoordinatesViaNaverGeocoder(data.address);
            // Geocoder can mismatch a road name to a same-named road in another city — a refined
            // result that lands far from the original marker is more likely a bad match than a
            // genuine precision correction, so discard it and keep the original coordinates.
            if (refined && calculateDistanceKm(data.lat, data.lng, refined.lat, refined.lng) < 20) {
                saveLat = refined.lat;
                saveLng = refined.lng;
                console.log(`[Save Refine] ${data.name}: (${data.lat},${data.lng}) → Naver Geocoder (${saveLat},${saveLng})`);
            } else if (refined) {
                console.warn(`[Save Refine] Rejected implausible refine for ${data.name}: original (${data.lat},${data.lng}) vs refined (${refined.lat},${refined.lng})`);
            }
        }

        const naverUrl = `https://map.naver.com/v5/search/${encodeURIComponent(data.name)}?c=${saveLat},${saveLng},15,0,0,0,dh`;
        // Deleted places are kept as tombstones (isDeleted:1), not removed — exclude them here so a
        // re-added place after deletion isn't mistaken for an existing wishlist/visited entry.
        const existing = await db.places.where("name").equalsIgnoreCase(data.name)
            .and(p => p.isDeleted !== 1 && p.isVisited !== -1).first();
        if (existing) {
            if (existing.isVisited === 1) {
                showToast(`'${data.name}'은(는) 이미 다녀온 곳에 등록되어 있습니다! 📸`, "info");
                clearSearchMarkers();
                return;
            } else {
                await db.places.update(existing.id, {
                    isVisited: 1,
                    review: "러브맵을 통해 함께 다녀온 추천 데이트 장소! 📸",
                    url: existing.url || naverUrl,
                    lat: saveLat,
                    lng: saveLng
                });
                showToast(`'${data.name}'을(를) 다녀온 곳으로 변경 완료했습니다! 📸`, "success");
                clearSearchMarkers();
                await updateDashboardStats();
                await renderPlacesList();
                updateMapMarkers();
                triggerSyncUpload(existing.id);
                return;
            }
        }

        const newVisitedId = await db.places.add({
            name: data.name,
            category: data.category || "Restaurant",
            url: naverUrl,
            lat: saveLat,
            lng: saveLng,
            priority: "medium",
            notes: `${data.address || ''} - AURA 러브맵 다녀온 곳 📸`.trim(),
            isVisited: 1,
            review: "러브맵을 통해 함께 다녀온 추천 데이트 장소! 📸",
            peopleCount: 2,
            photo: "",
            createdAt: new Date().toISOString()
        });

        showToast(`'${data.name}'을(를) 함께 다녀온 곳에 기록했습니다! 📸`, "success");
        clearSearchMarkers();
        await updateDashboardStats();
        await renderPlacesList();
        updateMapMarkers();
        triggerSyncUpload(newVisitedId);
    } catch(err) {
        showToast("다녀온 곳 저장 실패: " + err.message, "danger");
    }
};

// 7. Coordinates Parser from pasted URLs
function handleMapUrlInput(e) {
    const url = e.target.value.trim();
    if (!url) return;
    
    const googleMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (googleMatch) {
        const lat = parseFloat(googleMatch[1]);
        const lng = parseFloat(googleMatch[2]);
        document.getElementById("add-place-lat").value = lat;
        document.getElementById("add-place-lng").value = lng;
        showToast("구글 지도 링크 좌표를 파싱 완료했습니다!", "success");
        return;
    }

    const latMatch = url.match(/[?&](lat|mapy)=([0-9.]+)/);
    const lngMatch = url.match(/[?&](lng|mapx)=([0-9.]+)/);
    if (latMatch && lngMatch) {
        let lat = parseFloat(latMatch[2]);
        let lng = parseFloat(lngMatch[2]);
        if (lat > 1000 || lng > 1000) {
            // TM128 fallback simulation
            lat = 37.5665 + (Math.random() - 0.5) * 0.05;
            lng = 126.9780 + (Math.random() - 0.5) * 0.05;
        }
        document.getElementById("add-place-lat").value = lat;
        document.getElementById("add-place-lng").value = lng;
        showToast("네이버 지도 링크에서 좌표 보정 획득 완료!", "success");
        return;
    }

    // Short links
    if (url.includes("naver.me") || url.includes("app.goo.gl")) {
        const lat = 37.5665 + (Math.random() - 0.5) * 0.02;
        const lng = 126.9780 + (Math.random() - 0.5) * 0.02;
        document.getElementById("add-place-lat").value = lat.toFixed(6);
        document.getElementById("add-place-lng").value = lng.toFixed(6);
        showToast("단축 주소는 보안 제약으로 브라우저 단독 좌표 획득이 안 되어 임시 매핑합니다.", "warning");
    }
}

// 8. Modals Management (Quick Add & Visit Logging)
function openAddPlaceModal() {
    document.getElementById("modal-place-add").classList.add("active");
    // 기본값: 오늘 날짜, "미정" 체크 해제
    applyDateFieldState("add", Date.now());
}

function closeAddPlaceModal() {
    document.getElementById("modal-place-add").classList.remove("active");
    document.getElementById("form-place-add").reset();
    // form.reset()은 체크박스만 되돌리므로 날짜 입력의 disabled 상태를 직접 푼다
    applyDateFieldState("add", Date.now());
}

async function handleAddPlaceSubmit(e) {
    e.preventDefault();
    const name = document.getElementById("add-place-name").value.trim();
    const catSelect = document.getElementById("add-place-category").value;
    const catCustom = document.getElementById("add-place-custom-category").value.trim();
    const category = (catSelect === "custom" && catCustom) ? catCustom : catSelect;
    const url = document.getElementById("add-place-url").value.trim();
    let lat = parseFloat(document.getElementById("add-place-lat").value);
    let lng = parseFloat(document.getElementById("add-place-lng").value);
    const notes = document.getElementById("add-place-notes").value.trim();
    const priority = document.getElementById("add-place-priority").value;

    const undatedAddEl = document.getElementById("add-place-undated");
    const undatedAdd = undatedAddEl ? undatedAddEl.checked : false;
    const pickedDate = readDateFieldValue("add");

    if (isNaN(lat) || isNaN(lng)) {
        lat = 37.5665 + (Math.random() - 0.5) * 0.03;
        lng = 126.9780 + (Math.random() - 0.5) * 0.03;
    }

    try {
        const newAddedId = await db.places.add({
            name,
            category,
            url,
            lat,
            lng,
            priority,
            notes,
            isVisited: 0,
            review: "",
            peopleCount: 2,
            photo: "",
            // 선택한 방문 예정일을 반영한다. "날짜 미정"이면 null, 아무것도 안 고르면 오늘.
            // 예전엔 입력한 날짜를 무시하고 항상 오늘로 저장했다.
            createdAt: undatedAdd ? null : (pickedDate || new Date().toISOString())
        });

        showToast(`${name} 장소가 저장되었습니다 🌸`, "success");
        closeAddPlaceModal();
        await updateDashboardStats();
        await renderPlacesList();
        updateMapMarkers();
        triggerSyncUpload(newAddedId);
    } catch (err) {
        showToast("장소 추가 실패: " + err.message, "danger");
    }
}

async function openVisitModal(placeId, placeName) {
    const place = await db.places.get(placeId);
    document.getElementById("visit-place-id").value = placeId;
    document.getElementById("visit-place-name").textContent = placeName;
    
    // Customize label names based on settings
    const lblA = document.getElementById("visit-lbl-comment-a");
    if (lblA) lblA.textContent = partnerAName;
    const lblB = document.getElementById("visit-lbl-comment-b");
    if (lblB) lblB.textContent = partnerBName;

    const commA = document.getElementById("visit-comment-a");
    if (commA) commA.value = place ? (place.commentA || "") : "";
    const commB = document.getElementById("visit-comment-b");
    if (commB) commB.value = place ? (place.commentB || "") : "";
    
    document.getElementById("modal-visit-log").classList.add("active");
}

function closeVisitModal() {
    document.getElementById("modal-visit-log").classList.remove("active");
    document.getElementById("form-visit-log").reset();
    document.getElementById("visit-photo-preview").innerHTML = `<span>여기를 클릭해 이미지를 선택하세요. (여러 장 선택 가능) 📸</span>`;
}

function handlePhotoUploadPreview(e) {
    const files = e.target.files;
    const previewContainer = document.getElementById("visit-photo-preview");
    if (!previewContainer) return;
    if (!files || files.length === 0) return;
    
    // Remove placeholder span if present
    const span = previewContainer.querySelector("span");
    if (span) span.remove();

    Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onload = function(event) {
            const wrapper = document.createElement("div");
            wrapper.style.cssText = "position:relative; display:inline-block; margin:3px;";
            wrapper.innerHTML = `
                <img src="${event.target.result}" alt="Preview" style="width:60px; height:60px; object-fit:cover; border-radius:8px; border:1px solid rgba(255,101,132,0.3);">
                <button type="button" onclick="this.parentElement.remove(); event.stopPropagation();" style="position:absolute; top:-5px; right:-5px; background:#FF4757; color:#fff; border:none; border-radius:50%; width:20px; height:20px; font-size:11px; font-weight:bold; cursor:pointer; display:flex; align-items:center; justify-content:center; line-height:1; box-shadow:0 2px 4px rgba(0,0,0,0.2);">✕</button>
            `;
            previewContainer.appendChild(wrapper);
        };
        reader.readAsDataURL(file);
    });
}

function handleEditPhotoUploadPreview(e) {
    const files = e.target.files;
    const previewContainer = document.getElementById("edit-place-photo-preview");
    if (!previewContainer) return;
    if (!files || files.length === 0) return;
    
    // Remove placeholder span if present
    const span = previewContainer.querySelector("span");
    if (span) span.remove();

    Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onload = function(event) {
            const wrapper = document.createElement("div");
            wrapper.style.cssText = "position:relative; display:inline-block; margin:3px;";
            wrapper.innerHTML = `
                <img src="${event.target.result}" alt="Preview" style="width:60px; height:60px; object-fit:cover; border-radius:8px; border:1px solid rgba(255,101,132,0.3);">
                <button type="button" onclick="this.parentElement.remove(); event.stopPropagation();" style="position:absolute; top:-5px; right:-5px; background:#FF4757; color:#fff; border:none; border-radius:50%; width:20px; height:20px; font-size:11px; font-weight:bold; cursor:pointer; display:flex; align-items:center; justify-content:center; line-height:1; box-shadow:0 2px 4px rgba(0,0,0,0.2);">✕</button>
            `;
            previewContainer.appendChild(wrapper);
        };
        reader.readAsDataURL(file);
    });
}

// 9. Photo Compressor Logic (High Quality Preserving Pipeline, max 2560px, 90% quality)
function compressBase64Image(base64Str, maxWidth = 1024, maxHeight = 1024, quality = 0.75) {
    return new Promise((resolve) => {
        if (!base64Str) return resolve("");
        if (!base64Str.startsWith("data:image")) return resolve(base64Str);
        
        const img = new Image();
        img.onload = () => {
            let w = img.width, h = img.height;
            if (w > maxWidth || h > maxHeight) {
                const ratio = Math.min(maxWidth / w, maxHeight / h);
                w = Math.round(w * ratio);
                h = Math.round(h * ratio);
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => resolve(base64Str);
        img.src = base64Str;
    });
}

async function handleVisitLogSubmit(e) {
    e.preventDefault();
    const id = parseInt(document.getElementById("visit-place-id").value);

    const commAEl = document.getElementById("visit-comment-a");
    const commBEl = document.getElementById("visit-comment-b");
    const commentA = commAEl ? commAEl.value.trim() : "";
    const commentB = commBEl ? commBEl.value.trim() : "";

    const photoImgs = document.querySelectorAll("#visit-photo-preview img");
    const photosBase64 = [];

    try {
        for (let i = 0; i < photoImgs.length; i++) {
            const compressed = await compressBase64Image(photoImgs[i].src);
            if (compressed) {
                photosBase64.push(compressed);
            }
        }

        const updateObj = {
            isVisited: 1,
            peopleCount: 2,
            commentA: commentA,
            commentB: commentB
        };

        if (photosBase64.length > 0) {
            updateObj.photo = photosBase64[0];
            updateObj.photos = photosBase64;
        }

        await db.places.update(id, updateObj);
        
        showToast("방문 기록 및 파트너 코멘트가 저장되었습니다 💖", "success");
        closeVisitModal();
        
        // Proactively upload photos to standalone Firebase DB path if sync active
        if (syncRoomId && photosBase64.length > 0) {
            await uploadPhotoToCloud(id, photosBase64);
        }

        await updateDashboardStats();
        await renderPlacesList();
        updateMapMarkers();
        triggerSyncUpload(id);
    } catch(err) {
        showToast("기록 등록 실패: " + err.message, "danger");
    }
}

// Edit Place Modal Controls
async function openEditPlaceModal(id, fromGallery = false) {
    const place = await db.places.get(id);
    if (!place) return;

    document.getElementById("edit-place-id").value = place.id;
    document.getElementById("edit-place-name").value = place.name;

    // 삭제 버튼은 갤러리에서 연 경우에만 노출 — 다녀온곳/위시리스트 카드는 이미 자체 삭제
    // 버튼이 있어서 여기 또 두면 중복.
    const deleteBtn = document.getElementById("btn-delete-place-in-edit-modal");
    if (deleteBtn) deleteBtn.classList.toggle("hidden", !fromGallery);

    const categorySelect = document.getElementById("edit-place-category");
    const customInput = document.getElementById("edit-place-custom-category");
    const standardCategories = ["Restaurant", "Cafe", "Bar", "Park", "Museum", "Other"];
    
    if (standardCategories.includes(place.category)) {
        if (categorySelect) categorySelect.value = place.category;
        if (customInput) {
            customInput.style.display = "none";
            customInput.value = "";
        }
    } else {
        if (categorySelect) categorySelect.value = "custom";
        if (customInput) {
            customInput.style.display = "block";
            customInput.value = place.category || "";
        }
    }
    
    // 방문 예정일 + "날짜 미정" 체크박스 상태를 저장된 값에 맞춰 세팅
    // 예전엔 값이 없을 때 오늘 날짜를 채워넣어 미정 상태를 표현할 수 없었다.
    applyDateFieldState("edit", place.createdAt || place.date);

    // Clean address from notes
    const cleanAddress = (place.notes || "").replace(/\s*-\s*AURA.*$/, "").replace(/^💡\s*메모:\s*/, "").trim();
    document.getElementById("edit-place-address").value = cleanAddress;

    // Partner comment labels & values
    const lblA = document.getElementById("edit-lbl-comment-a");
    if (lblA) lblA.textContent = partnerAName;
    const lblB = document.getElementById("edit-lbl-comment-b");
    if (lblB) lblB.textContent = partnerBName;

    const commentAEl = document.getElementById("edit-place-comment-a");
    if (commentAEl) commentAEl.value = place.commentA || "";
    const commentBEl = document.getElementById("edit-place-comment-b");
    if (commentBEl) commentBEl.value = place.commentB || "";

    const visitedFields = document.getElementById("edit-visited-fields");
    if (place.isVisited === 1) {
        if (visitedFields) visitedFields.style.display = "block";

        // Display existing photos for editing
        const photoPreview = document.getElementById("edit-place-photo-preview");
        if (photoPreview) {
            const existingPhotos = place.photos || (place.photo ? [place.photo] : []);
            if (existingPhotos.length > 0) {
                photoPreview.innerHTML = "";
                existingPhotos.forEach(pSrc => {
                    const wrapper = document.createElement("div");
                    wrapper.style.cssText = "position:relative; display:inline-block; margin:3px;";
                    wrapper.innerHTML = `
                        <img src="${pSrc}" alt="Memory" style="width:60px; height:60px; object-fit:cover; border-radius:8px; border:1px solid rgba(255,101,132,0.3);">
                        <button type="button" onclick="this.parentElement.remove(); event.stopPropagation();" style="position:absolute; top:-5px; right:-5px; background:#FF4757; color:#fff; border:none; border-radius:50%; width:20px; height:20px; font-size:11px; font-weight:bold; cursor:pointer; display:flex; align-items:center; justify-content:center; line-height:1; box-shadow:0 2px 4px rgba(0,0,0,0.2);">✕</button>
                    `;
                    photoPreview.appendChild(wrapper);
                });
            } else {
                photoPreview.innerHTML = `<span>여기를 클릭해 이미지를 선택/수정하세요. (여러 장 선택 가능) 📸</span>`;
            }
        }
    } else {
        if (visitedFields) visitedFields.style.display = "none";
    }

    document.getElementById("modal-edit-place").classList.add("active");
    setTimeout(() => lucide.createIcons(), 50);
}

function closeEditPlaceModal() {
    const modal = document.getElementById("modal-edit-place");
    if (modal) modal.classList.remove("active");
    const form = document.getElementById("form-edit-place");
    if (form) form.reset();
    // form.reset()은 체크박스만 되돌리므로 날짜 입력의 disabled 상태를 직접 푼다
    const editDateInput = document.getElementById("edit-place-date");
    if (editDateInput) {
        editDateInput.disabled = false;
        editDateInput.style.opacity = "";
    }
    const photoPreview = document.getElementById("edit-place-photo-preview");
    if (photoPreview) {
        photoPreview.innerHTML = `<span>여기를 클릭해 이미지를 선택/수정하세요. (여러 장 선택 가능) 📸</span>`;
    }
}
window.closeEditPlaceModal = closeEditPlaceModal;

window.deletePlaceFromEditModal = async function() {
    const idEl = document.getElementById("edit-place-id");
    if (!idEl || !idEl.value) {
        showToast("삭제할 장소를 찾을 수 없습니다.", "warning");
        return;
    }
    const placeId = parseInt(idEl.value);
    const place = await db.places.get(placeId);
    if (!place) {
        showToast("장소 데이터를 찾을 수 없습니다.", "warning");
        return;
    }

    if (!(await showConfirmModal(`'${place.name}' 장소 전체를 삭제하시겠습니까?\n\n이 장소의 모든 사진과 기록이 함께 삭제됩니다.`))) return;

    await db.places.update(placeId, { isDeleted: 1 });
    closeEditPlaceModal();
    showToast(`'${place.name}' 장소가 삭제되었습니다! 🗑️`, "success");

    await renderPlacesList();
    await renderGallery();
    await updateDashboardStats();
    await renderCalendar();
    triggerSyncUpload(placeId);
};

window.quickEditComment = async function(id, partnerKey) {
    const place = await db.places.get(id);
    if (!place) return;

    const partnerName = partnerKey === "A" ? partnerAName : partnerBName;
    const fieldKey = partnerKey === "A" ? "commentA" : "commentB";
    const currentVal = place[fieldKey] || "";

    const inputVal = prompt(`💬 [${partnerName}] 한줄 코멘트를 입력/수정해 주세요:`, currentVal);
    if (inputVal !== null) {
        const updateObj = {};
        updateObj[fieldKey] = inputVal.trim();
        await db.places.update(id, updateObj);
        showToast(`[${partnerName}] 코멘트가 저장되었습니다! 💖`, "success");
        await renderPlacesList();
        triggerSyncUpload(id);
    }
};

async function handleEditPlaceSubmit(e) {
    e.preventDefault();
    const id = parseInt(document.getElementById("edit-place-id").value);
    const name = document.getElementById("edit-place-name").value.trim();
    
    const catSelect = document.getElementById("edit-place-category").value;
    const catCustom = document.getElementById("edit-place-custom-category").value.trim();
    const category = (catSelect === "custom" && catCustom) ? catCustom : catSelect;

    const addressVal = document.getElementById("edit-place-address").value.trim();
    
    const commentAEl = document.getElementById("edit-place-comment-a");
    const commentBEl = document.getElementById("edit-place-comment-b");

    const place = await db.places.get(id);
    if (!place) return;

    // "날짜 미정"이면 null로 확실히 지운다.
    // 예전엔 기존 createdAt으로 되돌아가서 "미정"으로 바꿀 수가 없었다.
    const updatedDate = readDateFieldValue("edit");

    let updatePayload = {
        name: name,
        category: category,
        notes: addressVal,
        createdAt: updatedDate,
        commentA: commentAEl ? commentAEl.value.trim() : (place.commentA || ""),
        commentB: commentBEl ? commentBEl.value.trim() : (place.commentB || "")
    };

    if (place.isVisited === 1) {
        const editPhotoImgs = document.querySelectorAll("#edit-place-photo-preview img");
        if (editPhotoImgs.length > 0) {
            const photosBase64 = [];
            for (let i = 0; i < editPhotoImgs.length; i++) {
                const compressed = await compressBase64Image(editPhotoImgs[i].src);
                if (compressed) photosBase64.push(compressed);
            }
            if (photosBase64.length > 0) {
                updatePayload.photo = photosBase64[0];
                updatePayload.photos = photosBase64;
                if (syncRoomId) {
                    await uploadPhotoToCloud(id, photosBase64);
                }
            }
        }
    }

    const oldName = place.name;

    try {
        await db.places.update(id, updatePayload);
        showToast(`'${name}' 수정사항이 반영되었습니다! 💖`, "success");
        closeEditPlaceModal();
        await updateDashboardStats();
        await renderPlacesList();
        updateMapMarkers();
        triggerSyncUpload(id);
        if (placeNameKey(name) !== placeNameKey(oldName)) {
            deleteOrphanedPlaceCloudNode(oldName);
        }
    } catch(err) {
        showToast("수정 실패: " + err.message, "danger");
    }
}

// Robust Date Parser for Descending Date Sorting across all string/timestamp formats
function parseAnyDate(val) {
    if (!val) return 0;
    if (typeof val === 'number') return val;
    
    const s = String(val).trim();
    if (!s) return 0;

    // Handle YYYY. MM. DD or YYYY.MM.DD or YYYY-MM-DD
    let normalized = s.replace(/\./g, '-').replace(/\s+/g, '');
    let parsed = Date.parse(normalized);
    if (!isNaN(parsed)) return parsed;

    // Direct ISO parse
    parsed = Date.parse(s);
    if (!isNaN(parsed)) return parsed;

    // Regex extraction YYYY-MM-DD
    const match = s.match(/(\d{4})[-.\s]+(\d{1,2})[-.\s]+(\d{1,2})/);
    if (match) {
        return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3])).getTime();
    }
    
    return 0;
}

// ── 날짜 유틸 (모두 로컬 타임존 기준) ──
// toISOString()은 UTC로 변환하므로 KST(+9)에서 로컬 자정이 전날로 밀린다.
// 아래 함수들은 그 문제를 피하기 위해 항상 로컬 시각 기준으로 처리한다.

// 저장된 값 → "YYYY-MM-DD" (달력 매칭 / input[type=date] 용). 날짜 없으면 "" (= 미정)
function toLocalDateKey(val) {
    const ms = parseAnyDate(val);
    if (ms <= 0) return "";
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "YYYY-MM-DD" (input[type=date] 값) → 저장용 ISO 문자열. 빈 값이면 null (= 미정)
function dateInputToStored(dateVal) {
    if (!dateVal) return null;
    const [y, m, d] = String(dateVal).split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

// 저장된 값 → 화면 표시용 문자열. 날짜 없으면 "" (= 미정)
function formatDisplayDate(val) {
    const ms = parseAnyDate(val);
    if (ms <= 0) return "";
    return new Date(ms).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
}

// 오늘 자정(로컬)의 timestamp
function todayStartMs() {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t.getTime();
}

// 📅 "날짜 미정" 체크박스 (추가/수정 모달 공용)
// index.html에 체크박스는 있었지만 이 함수가 정의돼 있지 않아 클릭해도 아무 동작도 하지 않았다.
// mode: "add" | "edit"
window.toggleUndatedDate = function(mode) {
    const checkbox = document.getElementById(`${mode}-place-undated`);
    const dateInput = document.getElementById(`${mode}-place-date`);
    if (!checkbox || !dateInput) return;

    if (checkbox.checked) {
        // 되돌릴 때 쓰려고 기존 값 보관
        if (dateInput.value) dateInput.dataset.prevValue = dateInput.value;
        dateInput.value = "";
        dateInput.disabled = true;   // disabled면 required 검증도 건너뛴다
        dateInput.style.opacity = "0.45";
    } else {
        dateInput.disabled = false;
        dateInput.style.opacity = "";
        if (!dateInput.value) {
            dateInput.value = dateInput.dataset.prevValue || toLocalDateKey(Date.now());
        }
    }
};

// 모달의 날짜 입력 + 미정 체크박스를 저장된 값에 맞춰 세팅
function applyDateFieldState(mode, storedValue) {
    const dateKey = toLocalDateKey(storedValue);
    const checkbox = document.getElementById(`${mode}-place-undated`);
    const dateInput = document.getElementById(`${mode}-place-date`);
    if (dateInput) dateInput.value = dateKey;
    if (checkbox) checkbox.checked = !dateKey;
    window.toggleUndatedDate(mode);
}

// 모달에서 저장할 날짜 값을 읽는다. "미정"이면 null
function readDateFieldValue(mode) {
    const checkbox = document.getElementById(`${mode}-place-undated`);
    if (checkbox && checkbox.checked) return null;
    const dateInput = document.getElementById(`${mode}-place-date`);
    return dateInputToStored(dateInput ? dateInput.value : "");
}

// Switch to Dashboard and pan/zoom Naver Love Map to place coordinates
window.viewPlaceOnLoveMap = function(lat, lng, encodedName) {
    const name = decodeURIComponent(encodedName);
    
    // 1. Switch to Dashboard tab
    switchTab("dashboard");
    
    // 2. Smoothly scroll to the map container
    const mapEl = document.getElementById("map");
    if (mapEl) {
        mapEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // 3. Center map & trigger popup
    setTimeout(() => {
        if (isNaverMapActive && map) {
            const pos = new naver.maps.LatLng(lat, lng);
            map.setCenter(pos);
            map.setZoom(16);
            
            // Search for marker at coordinates
            if (Array.isArray(naverMarkers)) {
                const targetMarker = naverMarkers.find(m => {
                    const p = m.getPosition();
                    return Math.abs(p.lat() - lat) < 0.0005 && Math.abs(p.lng() - lng) < 0.0005;
                });
                if (targetMarker) {
                    naver.maps.Event.trigger(targetMarker, "click");
                }
            }
        } else if (map) {
            map.setView([lat, lng], 16);
        }
        showToast(`'${name}' 위치로 러브 맵이 이동했습니다! 📍`, "success");
    }, 300);
};

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function renderCommentsBlock(place) {
    const textA = place.commentA ? escapeHtml(place.commentA) : '<span style="color:var(--color-text-low); font-style:italic;">코멘트 작성하기 ✏️</span>';
    const textB = place.commentB ? escapeHtml(place.commentB) : '<span style="color:var(--color-text-low); font-style:italic;">코멘트 작성하기 ✏️</span>';

    return `
        <div class="place-comments-box" style="font-size:0.78rem; background:rgba(255,255,255,0.75); padding:0.5rem 0.65rem; border-radius:10px; border:1px dashed rgba(255,101,132,0.25); display:flex; flex-direction:column; gap:0.35rem;">
            <div style="display:flex; align-items:center; gap:6px; cursor:pointer;" onclick="quickEditComment(${place.id}, 'A')" title="${partnerAName} 코멘트 작성/수정 (클릭)">
                <span style="font-weight:700; color:var(--color-primary); background:rgba(255,101,132,0.12); padding:2px 7px; border-radius:6px; font-size:0.7rem; flex-shrink:0;">💬 ${partnerAName}</span>
                <div style="flex-grow:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${textA}</div>
                <i data-lucide="edit-2" style="width:11px; height:11px; color:var(--color-text-low); flex-shrink:0;"></i>
            </div>
            <div style="display:flex; align-items:center; gap:6px; cursor:pointer;" onclick="quickEditComment(${place.id}, 'B')" title="${partnerBName} 코멘트 작성/수정 (클릭)">
                <span style="font-weight:700; color:#FF9F1C; background:rgba(255,159,28,0.14); padding:2px 7px; border-radius:6px; font-size:0.7rem; flex-shrink:0;">💬 ${partnerBName}</span>
                <div style="flex-grow:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${textB}</div>
                <i data-lucide="edit-2" style="width:11px; height:11px; color:var(--color-text-low); flex-shrink:0;"></i>
            </div>
        </div>
    `;
}

// Personal per-place category overrides: some places should always show a specific custom category
// regardless of what a search engine (Kakao/AI) classified them as — e.g. a family member's home
// showing up as "Restaurant" from POI data. Matched by a normalized (whitespace-stripped,
// lowercased) substring of the place name AND/OR its address (place.notes) — a rule with both set
// matches on either one, so any place named like the apartment complex OR located on its street
// gets caught, even under a completely different name. Add more entries here for other places.
const PLACE_CATEGORY_OVERRIDES = [
    { nameMatch: "그랜드파크2bl", addressMatch: "용성로21", category: "석한이네" }
];
function applyCategoryOverride(name, address, category) {
    const normName = (name || "").replace(/\s+/g, "").toLowerCase();
    const normAddr = (address || "").replace(/\s+/g, "").toLowerCase();
    const hit = PLACE_CATEGORY_OVERRIDES.find(o =>
        (o.nameMatch && normName.includes(o.nameMatch)) ||
        (o.addressMatch && normAddr.includes(o.addressMatch))
    );
    return hit ? hit.category : category;
}

// Category badges: the 6 built-in categories (Cafe/Restaurant/Bar/Park/Museum/Other) get their
// look from fixed .badge-{category} CSS classes. A custom, freely-typed category (e.g. "영화관")
// doesn't match any of those classes, so it fell back to plain unstyled text — this gives it a
// color too, picked by a stable hash of the category text (not Math.random()) so the same custom
// category always renders the same color, and from hues spaced away from the 6 built-in ones so
// it never looks like it's reusing an existing category's color.
const KNOWN_CATEGORY_KEYS = ['cafe', 'restaurant', 'bar', 'park', 'museum', 'other'];
const CUSTOM_CATEGORY_HUES = [100, 230, 270, 15, 130, 250];
function customCategoryBadgeStyle(category) {
    let hash = 0;
    for (let i = 0; i < category.length; i++) hash = (hash * 31 + category.charCodeAt(i)) >>> 0;
    const hue = CUSTOM_CATEGORY_HUES[hash % CUSTOM_CATEGORY_HUES.length];
    return `background:hsla(${hue},70%,50%,0.15); color:hsl(${hue},60%,38%); border:1px solid hsla(${hue},70%,50%,0.25);`;
}
function categoryBadgeClassAndStyle(category) {
    const cat = category || "Other";
    const key = cat.toLowerCase();
    if (KNOWN_CATEGORY_KEYS.includes(key)) {
        return { cls: `badge-${key}`, style: "" };
    }
    return { cls: "", style: customCategoryBadgeStyle(cat) };
}

// 9b. Daejeon-area Festival/Event Feed (TourAPI, shared Firebase cache — see below)
// TourAPI's own areaCode metadata is unreliable — a direct check found 43 currently-running festivals
// genuinely in 대전/세종/충남/충북 (address text confirms it) whose areacode field was simply blank,
// so filtering by ?areaCode= silently drops most real results. Matching against the addr1 text itself
// is what actually works.
// Must match the START of addr1 (the official 시/도 name is always the first token of a Korean
// address) — a plain .includes() check let "서울특별시 중구 세종대로 99" match "세종" because that's
// also a common Seoul street name (named after King Sejong), pulling in unrelated Seoul events.
const FESTIVAL_AREA_PREFIXES = ["대전광역시", "세종특별자치시", "충청남도", "충청북도", "전북특별자치도", "전라북도"];
const FESTIVAL_MAX_ITEMS = 60; // caps both TourAPI list size and the number of detail (overview) calls
const FESTIVAL_MAX_PAGES = 5; // 5 x 100 rows — comfortably covers the ~200-300 nationwide totalCount seen in testing
const TOUR_API_BASE = "https://apis.data.go.kr/B551011/KorService2";

let festivalItems = [];
let festivalVisibleCount = 20;
let festivalLoadedThisSession = false;

// Users may paste either the "Encoding" or "Decoding" key from data.go.kr's mypage — normalize to
// the raw decoded form and let encodeURIComponent() encode it exactly once. Double-encoding (pasting
// the already-%-encoded key straight into a query string another layer re-encodes) is the single most
// common cause of TourAPI's SERVICE_KEY_IS_NOT_REGISTERED_ERROR for first-time integrators.
function encodedTourApiKey() {
    let key = tourApiKey.trim();
    try {
        if (key.includes("%")) key = decodeURIComponent(key);
    } catch (e) { /* not actually percent-encoded — use as-is */ }
    return encodeURIComponent(key);
}

function toYyyymmdd(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}${m}${d}`;
}

function parseYyyymmdd(str) {
    if (!str || str.length !== 8) return null;
    return new Date(parseInt(str.slice(0, 4), 10), parseInt(str.slice(4, 6), 10) - 1, parseInt(str.slice(6, 8), 10));
}

function formatFestivalDateRange(startStr, endStr) {
    const fmt = (d) => d ? `${d.getMonth() + 1}/${d.getDate()}` : "?";
    const start = parseYyyymmdd(startStr);
    const end = parseYyyymmdd(endStr);
    const todayKey = toYyyymmdd(new Date());
    if (startStr && startStr <= todayKey) {
        return `진행중 · ~${fmt(end)}`;
    }
    return `${fmt(start)} ~ ${fmt(end)}`;
}

// TourAPI returns items.item as "" (empty string) when a call has zero results, and as a bare object
// (not wrapped in an array) when there's exactly one — both break a plain .map()/.forEach() if not
// normalized first.
function normalizeTourApiItems(items) {
    if (!items || !items.item) return [];
    return Array.isArray(items.item) ? items.item : [items.item];
}

async function tourApiFetch(path, params) {
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const url = `${TOUR_API_BASE}/${path}?serviceKey=${encodedTourApiKey()}&${qs}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data?.response?.header?.resultCode !== "0000") {
        throw new Error(data?.response?.header?.resultMsg || "TourAPI 요청 실패");
    }
    return data.response.body;
}

async function fetchFestivalsFromTourAPI() {
    const today = toYyyymmdd(new Date());
    const commonParams = {
        MobileOS: "ETC", MobileApp: "AURA", _type: "json",
        numOfRows: 100, arrange: "A", eventStartDate: today
    };

    // Nationwide, unfiltered by area — see the comment above FESTIVAL_AREA_PREFIXES for why areaCode
    // can't be trusted. Paginate until a short page (fewer than numOfRows) signals the last page.
    const allItems = [];
    for (let page = 1; page <= FESTIVAL_MAX_PAGES; page++) {
        let pageItems;
        try {
            const body = await tourApiFetch("searchFestival2", { ...commonParams, pageNo: page });
            pageItems = normalizeTourApiItems(body.items);
        } catch (e) {
            console.warn(`[Festival] page ${page} 조회 실패:`, e.message);
            break;
        }
        allItems.push(...pageItems);
        if (pageItems.length < commonParams.numOfRows) break;
    }

    // "상시운영" / year-round programs (often 90+ days) would otherwise permanently camp at the top of
    // a start-date sort since their start date is always the earliest — excluding them keeps the list
    // to genuine, time-boxed festivals.
    const FESTIVAL_MAX_DURATION_DAYS = 90;
    function festivalDurationDays(item) {
        const start = parseYyyymmdd(item.eventstartdate);
        const end = parseYyyymmdd(item.eventenddate);
        if (!start || !end) return 0;
        return Math.round((end - start) / 86400000);
    }

    const merged = new Map();
    allItems
        .filter(item => FESTIVAL_AREA_PREFIXES.some(prefix => (item.addr1 || "").startsWith(prefix)))
        .filter(item => festivalDurationDays(item) <= FESTIVAL_MAX_DURATION_DAYS)
        .forEach(item => { if (!merged.has(item.contentid)) merged.set(item.contentid, item); });

    const sorted = Array.from(merged.values())
        .sort((a, b) => (a.eventstartdate || "").localeCompare(b.eventstartdate || ""))
        .slice(0, FESTIVAL_MAX_ITEMS);

    // Description text isn't in the list response — a second call per item is needed for the overview.
    const withOverview = await Promise.all(sorted.map(async (item) => {
        let overview = "";
        try {
            const body = await tourApiFetch("detailCommon2", { MobileOS: "ETC", MobileApp: "AURA", _type: "json", contentId: item.contentid });
            const detail = normalizeTourApiItems(body.items)[0];
            overview = (detail?.overview || "").replace(/<[^>]*>/g, "").trim();
        } catch (e) { /* keep going without a description rather than failing the whole item */ }

        return {
            id: item.contentid,
            title: item.title,
            startDate: item.eventstartdate,
            endDate: item.eventenddate,
            addr: [item.addr1, item.addr2].filter(Boolean).join(" "),
            lat: parseFloat(item.mapy) || null,
            lng: parseFloat(item.mapx) || null,
            overview: overview.length > 150 ? overview.slice(0, 150) + "..." : overview
        };
    }));

    return withOverview;
}

async function loadFestivalData(forceRefresh = false) {
    const listEl = document.getElementById("festival-list");
    const updatedAtEl = document.getElementById("festival-updated-at");
    if (!listEl) return;

    try {
        const cacheRes = await fetch(`${getFirebaseDbUrl()}/festival-cache/daejeon.json`);
        const cache = await cacheRes.json();
        const isStale = forceRefresh || !cache || !cache.fetchedAt ||
            toYyyymmdd(new Date(cache.fetchedAt)) !== toYyyymmdd(new Date());

        if (isStale && tourApiKey) {
            listEl.innerHTML = `<div class="card" style="text-align:center; padding:1.5rem; color:var(--color-text-med); font-size:0.85rem;">축제/행사 정보를 새로 불러오는 중이에요...</div>`;
            try {
                festivalItems = await fetchFestivalsFromTourAPI();
                await fetch(`${getFirebaseDbUrl()}/festival-cache/daejeon.json`, {
                    method: "PUT",
                    body: JSON.stringify({ fetchedAt: Date.now(), items: festivalItems })
                });
            } catch (e) {
                console.error("[Festival] TourAPI 조회 실패, 기존 캐시로 대체:", e);
                festivalItems = cache?.items || [];
            }
        } else {
            festivalItems = cache?.items || [];
        }

        festivalVisibleCount = 20;
        renderFestivalList();

        if (updatedAtEl) {
            const fetchedAt = (isStale && tourApiKey && festivalItems.length) ? Date.now() : cache?.fetchedAt;
            updatedAtEl.textContent = fetchedAt ? formatRelativeTimeAgo(fetchedAt) + " 업데이트됨" : "";
        }
    } catch (e) {
        console.error("[Festival] 로드 실패:", e);
        listEl.innerHTML = `<div class="card" style="text-align:center; padding:1.5rem; color:var(--color-text-med); font-size:0.85rem;">축제/행사 정보를 불러오지 못했어요.</div>`;
    }
}

function formatRelativeTimeAgo(ms) {
    const diffMin = Math.floor((Date.now() - ms) / 60000);
    if (diffMin < 1) return "방금";
    if (diffMin < 60) return `${diffMin}분 전`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour}시간 전`;
    return `${Math.floor(diffHour / 24)}일 전`;
}

window.toggleFestivalPanel = function() {
    const body = document.getElementById("festival-panel-body");
    const chevron = document.getElementById("festival-panel-chevron");
    if (!body) return;
    const isOpen = body.style.display !== "none";
    body.style.display = isOpen ? "none" : "block";
    if (chevron) chevron.style.transform = isOpen ? "" : "rotate(180deg)";
};

function renderFestivalList() {
    const listEl = document.getElementById("festival-list");
    const loadMoreBtn = document.getElementById("festival-load-more-btn");
    const countBadge = document.getElementById("festival-count-badge");
    if (!listEl) return;

    if (countBadge) countBadge.textContent = festivalItems.length > 0 ? `${festivalItems.length}건` : "";

    if (festivalItems.length === 0) {
        listEl.innerHTML = tourApiKey
            ? `<div class="card" style="text-align:center; padding:1.5rem; color:var(--color-text-med); font-size:0.85rem;">현재 등록된 축제/행사 정보가 없어요.</div>`
            : `<div class="card" style="text-align:center; padding:1.5rem; color:var(--color-text-med); font-size:0.85rem;">설정 탭에서 <strong>문화축제 정보 API Key</strong>를 등록해주세요 🌸</div>`;
        if (loadMoreBtn) loadMoreBtn.style.display = "none";
        return;
    }

    const badge = categoryBadgeClassAndStyle("축제·행사");
    // festivalItems is already sorted by startDate ascending in fetchFestivalsFromTourAPI, so the
    // nearest-in-time event (an ongoing one, or else the soonest upcoming one) is always first here.
    const visible = festivalItems.slice(0, festivalVisibleCount);

    listEl.innerHTML = visible.map(ev => `
        <div class="place-card">
            <div class="place-card-header">
                <span class="place-category-badge ${badge.cls}" style="${badge.style}">축제·행사</span>
                <span style="font-size:0.75rem; font-weight:700; color:var(--color-primary);">${formatFestivalDateRange(ev.startDate, ev.endDate)}</span>
            </div>
            <h4 class="place-title" style="font-size:1.05rem;">${ev.title}</h4>
            <div class="place-meta-item">
                <i data-lucide="map-pin"></i><span>${ev.addr || "위치 정보 없음"}</span>
            </div>
            ${ev.overview ? `
            <button type="button" class="festival-desc-toggle" onclick="toggleFestivalDesc(this)" style="all:unset; cursor:pointer; display:flex; align-items:center; gap:4px; font-size:0.78rem; color:var(--color-text-med);">
                <i data-lucide="chevron-right" style="width:14px;height:14px; transition:transform 0.2s;"></i><span>설명 보기</span>
            </button>
            <p class="place-notes" style="display:none;">${ev.overview}</p>` : ""}
            <div class="place-actions">
                <button class="btn btn-outline" onclick="askAIAboutFestival('${ev.id}')">
                    <i data-lucide="sparkles"></i>AI에게 물어보기
                </button>
                <button class="btn btn-outline" onclick="addFestivalToWishlist('${ev.id}')">
                    <i data-lucide="heart-plus"></i>위시리스트에 담기
                </button>
            </div>
        </div>
    `).join("");

    if (loadMoreBtn) loadMoreBtn.style.display = festivalVisibleCount < festivalItems.length ? "inline-flex" : "none";
    if (window.lucide) lucide.createIcons();
}

window.toggleFestivalDesc = function(btnEl) {
    const notesEl = btnEl.nextElementSibling;
    const icon = btnEl.querySelector("i, svg"); // lucide.createIcons() replaces <i> with an inline <svg>
    const label = btnEl.querySelector("span");
    const isOpen = notesEl.style.display !== "none";
    notesEl.style.display = isOpen ? "none" : "block";
    if (label) label.textContent = isOpen ? "설명 보기" : "설명 접기";
    if (icon) icon.style.transform = isOpen ? "" : "rotate(90deg)";
};

window.showMoreFestivals = function() {
    festivalVisibleCount += 20;
    renderFestivalList();
};

window.askAIAboutFestival = function(id) {
    const ev = festivalItems.find(f => String(f.id) === String(id));
    if (!ev) return;

    const body = document.getElementById("festival-panel-body");
    const chevron = document.getElementById("festival-panel-chevron");
    if (body) body.style.display = "none";
    if (chevron) chevron.style.transform = "";

    document.getElementById("chat-user-input").value = `${ev.title}(${ev.addr}) 근처로 데이트 코스 추천해줘`;
    document.getElementById("chat-input-form").dispatchEvent(new Event("submit"));
    document.querySelector(".chat-container")?.scrollIntoView({ behavior: "smooth", block: "start" });
};

window.addFestivalToWishlist = async function(id) {
    const ev = festivalItems.find(f => String(f.id) === String(id));
    if (!ev) return;

    const startDate = parseYyyymmdd(ev.startDate) || new Date();
    const existing = await db.places.where("name").equalsIgnoreCase(ev.title)
        .and(p => p.isDeleted !== 1 && p.isVisited !== -1 && toLocalDateKey(p.createdAt || p.date) === toLocalDateKey(startDate))
        .first();
    if (existing) {
        showToast(`'${ev.title}'은(는) 이미 위시리스트에 있어요! 💖`, "info");
        return;
    }

    const mapUrl = `https://map.naver.com/v5/search/${encodeURIComponent(ev.title)}?c=${ev.lat || defaultMapCoords[0]},${ev.lng || defaultMapCoords[1]},15,0,0,0,dh`;
    const notes = [ev.overview, ev.addr ? `위치: ${ev.addr}` : ""].filter(Boolean).join(" / ");

    const newPlaceId = await db.places.add({
        name: ev.title,
        category: "축제·행사",
        url: mapUrl,
        lat: ev.lat || defaultMapCoords[0],
        lng: ev.lng || defaultMapCoords[1],
        priority: "medium",
        notes: notes,
        isVisited: 0,
        review: "",
        peopleCount: 2,
        photo: "",
        createdAt: startDate
    });

    showToast(`'${ev.title}'을 데이트 위시리스트에 담았습니다! 💖`, "success");
    await updateDashboardStats();
    await renderPlacesList();
    updateMapMarkers();
    triggerSyncUpload(newPlaceId);
};

// 10. Places Render List
async function renderPlacesList() {
    const mainContent = document.querySelector(".main-content");
    const savedScrollTop = mainContent ? mainContent.scrollTop : 0;
    const savedWindowY = window.scrollY || document.documentElement.scrollTop;

    // 1. Render Wishlist Tab
    const wishlistContainer = document.getElementById("wishlist-list-container");
    if (wishlistContainer) {
        wishlistContainer.innerHTML = "";
        const searchInput = document.getElementById("wishlist-search-input");
        const searchVal = searchInput ? searchInput.value.toLowerCase() : "";
        
        const allPlaces = await db.places.toArray();
        const wishlistPlaces = allPlaces.filter(p => (p.isVisited === 0 || p.isVisited === false || p.isVisited === "0" || p.isVisited === "false") && p.isDeleted !== 1 && p.isVisited !== -1);
        // 방문 예정일이 오늘과 가까운 순서로 정렬 (미정은 항상 맨 아래)
        //  1) 다가오는 날짜: 오늘에 가까운 순 (오늘 → 내일 → ...)
        //  2) 이미 지난 날짜: 그 뒤에, 최근에 지난 순
        //  3) 날짜 미정: 맨 아래 (최근 등록순)
        const nowMs = todayStartMs();
        wishlistPlaces.sort((a, b) => {
            const timeA = parseAnyDate(a.createdAt || a.date);
            const timeB = parseAnyDate(b.createdAt || b.date);
            const hasA = timeA > 0;
            const hasB = timeB > 0;

            if (!hasA && !hasB) return (b.id || 0) - (a.id || 0);
            if (!hasA) return 1;
            if (!hasB) return -1;

            const upcomingA = timeA >= nowMs;
            const upcomingB = timeB >= nowMs;
            if (upcomingA !== upcomingB) return upcomingA ? -1 : 1;

            if (timeA !== timeB) return upcomingA ? timeA - timeB : timeB - timeA;
            return (b.id || 0) - (a.id || 0);
        });

        const filteredWishlist = wishlistPlaces.filter(place => {
            return place.name.toLowerCase().includes(searchVal) || 
                   (place.notes && place.notes.toLowerCase().includes(searchVal)) ||
                   (place.commentA && place.commentA.toLowerCase().includes(searchVal)) ||
                   (place.commentB && place.commentB.toLowerCase().includes(searchVal));
        });
        
        if (filteredWishlist.length === 0) {
            wishlistContainer.innerHTML = `
                <div class="card" style="grid-column: 1 / -1; text-align: center; padding: 3rem; color: var(--color-text-med);">
                    <i data-lucide="heart" style="width:40px; height:40px; margin:0 auto 1rem; color:var(--color-primary);"></i>
                    <p>위시리스트가 비어있어요. 가고 싶은 데이트 스팟을 추가해보세요 🌸</p>
                </div>
            `;
        } else {
            filteredWishlist.forEach(place => {
                const card = document.createElement("div");
                card.className = "place-card card";
                card.style.position = "relative";

                const displayCategory = applyCategoryOverride(place.name, place.notes, place.category);
                const catBadge = categoryBadgeClassAndStyle(displayCategory);

                // 방문 예정일 (없으면 "미정"으로 표시)
                const dateStr = formatDisplayDate(place.createdAt || place.date);
                const dateHtml = dateStr
                    ? dateStr
                    : `<span style="color:var(--color-text-med); opacity:0.8; font-weight:600;">미정</span>`;

                // Clean address
                let cleanAddress = (place.notes || "").replace(/\s*-\s*AURA.*$/, "").replace(/^💡\s*메모:\s*/, "").trim();

                let cardContent = `
                    <div class="place-card-top-actions">
                        <button class="edit-card-btn" onclick="openEditPlaceModal(${place.id})" title="수정 (✏️)"><i data-lucide="edit-3"></i></button>
                        <button class="delete-card-btn" onclick="deletePlace(${place.id}, '${place.name}')" title="삭제 (🗑️)"><i data-lucide="trash-2"></i></button>
                    </div>
                    <div class="place-card-header">
                        <span class="place-category-badge ${catBadge.cls}" style="${catBadge.style}">${displayCategory}</span>
                        <span class="place-priority-dot priority-${place.priority}"></span>
                    </div>
                    <h4 class="place-title" style="margin-top:0.2rem; margin-bottom:0.4rem;">${place.name}</h4>
                    
                    <div class="place-card-meta-details" style="font-size:0.78rem; color:var(--color-text-med); display:flex; flex-direction:column; gap:0.35rem; background:rgba(255,101,132,0.04); padding:0.55rem 0.7rem; border-radius:10px; border:1px solid rgba(255,101,132,0.12);">
                        <div><i data-lucide="calendar" style="width:13px; height:13px; display:inline-block; vertical-align:middle; margin-right:4px; color:var(--color-primary);"></i><strong>방문 예정일:</strong> ${dateHtml}</div>
                        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:4px; margin-top:2px;">
                            <div style="flex-grow:1;"><i data-lucide="map-pin" style="width:13px; height:13px; display:inline-block; vertical-align:middle; margin-right:4px; color:#FF9F1C;"></i><strong>주소:</strong> ${cleanAddress || '등록된 주소 정보'}</div>
                            <button class="btn btn-outline" style="padding:0.18rem 0.55rem; font-size:0.68rem; height:24px; border-radius:8px; border-color:var(--color-primary); color:var(--color-primary); background:rgba(255,101,132,0.06); flex-shrink:0;" onclick="viewPlaceOnLoveMap(${place.lat || 37.5665}, ${place.lng || 126.9780}, '${encodeURIComponent(place.name)}')">
                                <i data-lucide="map" style="width:11px; height:11px;"></i> 지도에서 보기 🗺️
                            </button>
                        </div>
                    </div>
                `;
                
                cardContent += renderCommentsBlock(place);

                cardContent += `
                    <div class="place-actions">
                        ${place.url ? `<a href="${place.url}" target="_blank" class="btn btn-outline" style="padding:0.4rem 0.8rem; font-size:0.75rem;"><i data-lucide="external-link"></i> 네이버 지도</a>` : ''}
                        <button class="btn btn-primary" style="padding:0.4rem 0.8rem; font-size:0.75rem;" onclick="openVisitModal(${place.id}, '${place.name}')">
                            <i data-lucide="check"></i> 방문 완료 📸
                        </button>
                    </div>
                `;
                card.innerHTML = cardContent;
                wishlistContainer.appendChild(card);
            });
        }
    }

    // 2. Render Visited Tab
    const visitedContainer = document.getElementById("visited-list-container");
    if (visitedContainer) {
        visitedContainer.innerHTML = "";
        const searchInput = document.getElementById("visited-search-input");
        const searchVal = searchInput ? searchInput.value.toLowerCase() : "";
        
        const allVisitedPlaces = await db.places.toArray();
        const visitedPlaces = allVisitedPlaces.filter(p => (p.isVisited === 1 || p.isVisited === true || p.isVisited === "1" || p.isVisited === "true") && p.isDeleted !== 1);
        // Strict Descending Sort by visit date (createdAt/date) with ID tie-breaker for 1st, 2nd, 3rd ... Nth
        visitedPlaces.sort((a, b) => {
            const timeA = parseAnyDate(a.createdAt || a.date);
            const timeB = parseAnyDate(b.createdAt || b.date);
            if (timeB !== timeA) return timeB - timeA;
            return (b.id || 0) - (a.id || 0);
        });

        const filteredVisited = visitedPlaces.filter(place => {
            return place.name.toLowerCase().includes(searchVal) || 
                   (place.notes && place.notes.toLowerCase().includes(searchVal)) ||
                   (place.review && place.review.toLowerCase().includes(searchVal)) ||
                   (place.commentA && place.commentA.toLowerCase().includes(searchVal)) ||
                   (place.commentB && place.commentB.toLowerCase().includes(searchVal));
        });
        
        if (filteredVisited.length === 0) {
            visitedContainer.innerHTML = `
                <div class="card" style="grid-column: 1 / -1; text-align: center; padding: 3rem; color: var(--color-text-med);">
                    <i data-lucide="smile" style="width:40px; height:40px; margin:0 auto 1rem; color:var(--color-secondary);"></i>
                    <p>아직 다녀온 데이트 장소가 없어요. 데이트를 다녀온 후 후기를 남겨보세요! 💕</p>
                </div>
            `;
        } else {
            filteredVisited.forEach(place => {
                const card = document.createElement("div");
                card.className = "place-card card";
                card.style.position = "relative";
                
                const displayCategory = applyCategoryOverride(place.name, place.notes, place.category);
                const catBadge = categoryBadgeClassAndStyle(displayCategory);

                // Date formatting using robust parser
                const rawDate = place.createdAt || place.date;
                const parsedMs = parseAnyDate(rawDate);
                const dateStr = parsedMs > 0 ? new Date(parsedMs).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }) : "";

                // Clean address
                let cleanAddress = (place.notes || "").replace(/\s*-\s*AURA.*$/, "").replace(/^💡\s*메모:\s*/, "").trim();

                let cardContent = `
                    <div class="place-card-top-actions">
                        <button class="edit-card-btn" onclick="openEditPlaceModal(${place.id})" title="수정 (✏️)"><i data-lucide="edit-3"></i></button>
                        <button class="delete-card-btn" onclick="deletePlace(${place.id}, '${place.name}')" title="삭제 (🗑️)"><i data-lucide="trash-2"></i></button>
                    </div>
                    <div class="place-card-header">
                        <span class="place-category-badge ${catBadge.cls}" style="${catBadge.style}">${displayCategory}</span>
                    </div>
                    <h4 class="place-title" style="margin-top:0.2rem; margin-bottom:0.4rem;">${place.name}</h4>
                    
                    <div class="place-card-meta-details" style="font-size:0.78rem; color:var(--color-text-med); display:flex; flex-direction:column; gap:0.35rem; background:rgba(255,101,132,0.04); padding:0.55rem 0.7rem; border-radius:10px; border:1px solid rgba(255,101,132,0.12);">
                        ${dateStr ? `<div><i data-lucide="calendar" style="width:13px; height:13px; display:inline-block; vertical-align:middle; margin-right:4px; color:var(--color-primary);"></i><strong>방문일:</strong> ${dateStr}</div>` : ''}
                        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:4px; margin-top:2px;">
                            <div style="flex-grow:1;"><i data-lucide="map-pin" style="width:13px; height:13px; display:inline-block; vertical-align:middle; margin-right:4px; color:#FF9F1C;"></i><strong>주소:</strong> ${cleanAddress || '등록된 주소 정보'}</div>
                            <button class="btn btn-outline" style="padding:0.18rem 0.55rem; font-size:0.68rem; height:24px; border-radius:8px; border-color:var(--color-primary); color:var(--color-primary); background:rgba(255,101,132,0.06); flex-shrink:0;" onclick="viewPlaceOnLoveMap(${place.lat || 37.5665}, ${place.lng || 126.9780}, '${encodeURIComponent(place.name)}')">
                                <i data-lucide="map" style="width:11px; height:11px;"></i> 지도에서 보기 🗺️
                            </button>
                        </div>
                    </div>
                `;

                cardContent += renderCommentsBlock(place);


                const photoList = place.photos || (place.photo ? [place.photo] : []);
                if (photoList.length > 0) {
                    cardContent += `
                        <div class="card-photos-section" style="padding-top:0.4rem; border-top:1px dashed rgba(255,112,150,0.15);">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <button type="button" class="btn-toggle-card-photos" onclick="toggleCardPhotos(${place.id})" style="font-size:0.72rem; padding:0.2rem 0.55rem; border-radius:10px; background:rgba(255,101,132,0.08); border:1px solid rgba(255,101,132,0.2); color:var(--color-primary); cursor:pointer; display:inline-flex; align-items:center; gap:4px;">
                                    <i data-lucide="image" style="width:13px; height:13px;"></i>
                                    <span id="toggle-photo-text-${place.id}">추억 사진 (${photoList.length}장) 숨기기 🔽</span>
                                </button>
                            </div>
                            <div class="card-photo-thumbnails" id="card-photos-container-${place.id}" style="display:flex; gap:6px; margin-top:0.4rem; overflow-x:auto; padding-bottom:4px;">
                                ${photoList.map((pSrc, pIdx) => `
                                    <img src="${pSrc}" alt="추억 사진" onclick="openGallerySliderModal(${place.id}, ${pIdx})" style="width:52px; height:52px; object-fit:cover; border-radius:8px; border:1px solid rgba(255,112,150,0.2); cursor:pointer; flex-shrink:0; transition:transform 0.2s;" onmouseover="this.style.transform='scale(1.08)'" onmouseout="this.style.transform='scale(1)'">
                                `).join('')}
                            </div>
                        </div>
                    `;
                }
                
                card.innerHTML = cardContent;
                visitedContainer.appendChild(card);
            });
        }
    }
    
    lucide.createIcons();

    // Preserve scroll position
    if (mainContent && savedScrollTop > 0) {
        mainContent.scrollTop = savedScrollTop;
    }
    if (savedWindowY > 0) {
        window.scrollTo(0, savedWindowY);
    }

    // Auto-update active tab if calendar or gallery
    if (document.getElementById("tab-calendar") && document.getElementById("tab-calendar").classList.contains("active")) {
        await renderCalendar();
    }
    if (document.getElementById("tab-gallery") && document.getElementById("tab-gallery").classList.contains("active")) {
        await renderGallery();
    }
}

async function deletePlace(id, name) {
    if (!(await showConfirmModal(`'${name}' 장소를 영구히 삭제하시겠습니까?`))) return;
    
    try {
        // Tombstone update (Soft delete flag to guarantee multi-device sync deletion)
        await db.places.update(id, {
            isVisited: -1,
            isDeleted: 1,
            deletedAt: Date.now()
        });
        // Remember this name in session so loadFromCloud won't re-add it if the upload fails
        try {
            const _sd = JSON.parse(sessionStorage.getItem('aura_session_deleted') || '[]');
            _sd.push((name || '').trim().toLowerCase());
            sessionStorage.setItem('aura_session_deleted', JSON.stringify(_sd));
        } catch(_) {}
        
        // Clean up associated cloud photos from Firebase
        if (syncRoomId) {
            try {
                const nameKey = (name || "").trim().toLowerCase().replace(/[/\\?%*:|"<>. ]/g, "_");
                const url = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/photos/${encodeURIComponent(nameKey)}.json`;
                await fetch(url, { method: 'DELETE' });
            } catch(e) {
                console.error("Cloud photo cleanup failed:", e);
            }
        }

        showToast("장소가 영구 삭제되었습니다.", "success");
        await updateDashboardStats();
        await renderPlacesList();
        updateMapMarkers();
        triggerSyncUpload(id);
    } catch(err) {
        showToast("삭제 오류: " + err.message, "danger");
    }
}

// 11. Dashboard Analytics
async function updateDashboardStats() {
    const places = await db.places.toArray();

    const wishlistCount = places.filter(p => (p.isVisited === 0 || p.isVisited === false || p.isVisited === "0" || p.isVisited === "false") && p.isDeleted !== 1 && p.isVisited !== -1).length;
    const visitedCount = places.filter(p => (p.isVisited === 1 || p.isVisited === true || p.isVisited === "1" || p.isVisited === "true") && p.isDeleted !== 1).length;

    const wishlistEl = document.getElementById("stat-wishlist-count");
    if (wishlistEl) wishlistEl.textContent = wishlistCount;
    const visitedEl = document.getElementById("stat-visited-count");
    if (visitedEl) visitedEl.textContent = visitedCount;

    // D-Day update
    // 날짜 미정 항목, 그리고 이미 지난 항목은 "다음 약속" 후보에서 제외 (오늘 포함, 오늘 이후만)
    const dashNowMs = todayStartMs();
    const upcomingCandidates = places
        .filter(p => p.isVisited === 0 && !p.isDeleted && parseAnyDate(p.createdAt || p.date) >= dashNowMs)
        .sort((a, b) => parseAnyDate(a.createdAt || a.date) - parseAnyDate(b.createdAt || b.date));

    let nextDday = "D-Day";
    let sidebarTitle = "아직 약속이 없어요 😢";

    const dashItemsEl = document.getElementById("dashboard-next-schedule-items");
    const dashNextDdayEl = document.getElementById("dashboard-next-schedule-dday");

    if (upcomingCandidates.length > 0) {
        // 가장 가까운 날짜를 찾고, 같은 날짜의 항목 전부 수집
        const nearestMs = parseAnyDate(upcomingCandidates[0].createdAt || upcomingCandidates[0].date);
        const nearestDateKey = toLocalDateKey(nearestMs);
        const nearestItems = upcomingCandidates.filter(p => toLocalDateKey(parseAnyDate(p.createdAt || p.date)) === nearestDateKey);

        const diffDays = Math.round((nearestMs - dashNowMs) / 86400000);
        nextDday = diffDays === 0 ? "오늘! 💗" : diffDays > 0 ? `D-${diffDays}` : `D+${Math.abs(diffDays)}`;
        sidebarTitle = nearestItems[0].name;
        const dateText = formatDisplayDate(nearestMs);

        if (dashItemsEl) {
            dashItemsEl.innerHTML = "";
            // 날짜 한 줄 (공통)
            const dateRow = document.createElement("div");
            dateRow.style.cssText = "font-size:0.78rem; color:var(--color-text-med); margin-bottom:2px;";
            dateRow.textContent = dateText;
            dashItemsEl.appendChild(dateRow);

            // "선택한 날짜의 데이트 기록" 카드(renderSelectedDateDetails)와 동일한 카드 양식 —
            // 배지-이름-코멘트를 같은 스타일로 맞춰서 두 카드가 다른 디자인처럼 보이지 않게 한다.
            nearestItems.forEach(p => {
                const commentA = (p.commentA || "").replace(/\s*-\s*AURA.*$/, "").replace(/^💡\s*메모:\s*/, "").trim();
                const commentB = (p.commentB || "").replace(/\s*-\s*AURA.*$/, "").replace(/^💡\s*메모:\s*/, "").trim();

                let commentsHtml = '';
                if (commentA) {
                    commentsHtml += `<div style="font-size:0.78rem; color:var(--color-text-med); margin-top:2px; display:flex; align-items:flex-start; gap:5px;">
                        <span style="font-weight:700; color:var(--color-primary); background:rgba(255,101,132,0.12); padding:1px 6px; border-radius:5px; font-size:0.7rem; flex-shrink:0;">💬 ${partnerAName}</span>
                        <span>${escapeHtml(commentA)}</span>
                    </div>`;
                }
                if (commentB) {
                    commentsHtml += `<div style="font-size:0.78rem; color:var(--color-text-med); margin-top:2px; display:flex; align-items:flex-start; gap:5px;">
                        <span style="font-weight:700; color:#FF9F1C; background:rgba(255,159,28,0.14); padding:1px 6px; border-radius:5px; font-size:0.7rem; flex-shrink:0;">💬 ${partnerBName}</span>
                        <span>${escapeHtml(commentB)}</span>
                    </div>`;
                }

                const row = document.createElement("div");
                row.style.cssText = "display:flex; flex-direction:column; align-items:flex-start; padding:0.75rem 0.9rem; background:rgba(255,101,132,0.04); border:1px solid rgba(255,101,132,0.12); border-radius:12px; margin-bottom:0.5rem; gap:4px; width:100%;";
                row.innerHTML = `
                    <div style="display:flex; align-items:center; gap:6px;">
                        <span style="font-size:0.7rem; padding:0.15rem 0.55rem; border-radius:6px; background:rgba(255,101,132,0.15); color:var(--color-primary); border:1px solid rgba(255,101,132,0.3); font-weight:700; width:fit-content;">📍 위시리스트</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px; margin-top:2px;">
                        <strong style="font-size:0.95rem; color:var(--color-text-dark);">${escapeHtml(p.name)}</strong>
                        <span style="font-size:0.75rem; color:var(--color-primary); background:rgba(255,101,132,0.08); padding:1px 6px; border-radius:4px;">${escapeHtml(p.category)}</span>
                    </div>
                    ${commentsHtml}
                `;
                dashItemsEl.appendChild(row);
            });
        }
    } else {
        if (dashItemsEl) {
            dashItemsEl.innerHTML = `<span style="font-size:0.85rem; color:var(--color-text-med);">아직 약속이 없어요 😢</span>`;
        }
    }

    if (dashNextDdayEl) dashNextDdayEl.textContent = nextDday;

    // 사이드바 카드 (데스크톱 전용, 한 줄만)
    const nextTitleEl = document.getElementById("next-date-title");
    if (nextTitleEl) nextTitleEl.textContent = sidebarTitle;
    const nextDdayEl = document.getElementById("next-date-dday");
    if (nextDdayEl) nextDdayEl.textContent = nextDday;
    
}

// Open & Close API Guide Modal (Gemini, Naver Maps, Naver Search)
window.openApiGuideModal = function(type) {
    const titleEl = document.getElementById("modal-api-guide-title");
    const bodyEl = document.getElementById("modal-api-guide-body");
    const modal = document.getElementById("modal-api-guide");
    if (!modal || !bodyEl || !titleEl) return;

    if (type === 'gemini') {
        titleEl.innerHTML = `🔑 Gemini API Key 발급 가이드`;
        bodyEl.innerHTML = `
            <ol style="padding-left:1.2rem; margin-top:0.5rem;">
                <li style="margin-bottom:0.6rem;"><strong>Google AI Studio 접속</strong><br>
                <a href="https://aistudio.google.com/app/apikey" target="_blank" style="color:var(--color-primary); text-decoration:underline;">aistudio.google.com/app/apikey</a>에 접속하여 구글 계정으로 로그인합니다.</li>
                <li style="margin-bottom:0.6rem;"><strong>[Create API Key] 클릭</strong><br>
                화면 중앙의 Create API Key 버튼을 누르고 새 프로젝트 생성을 선택합니다.</li>
                <li style="margin-bottom:0.6rem;"><strong>API Key 복사 및 저장</strong><br>
                생성된 API 키를 복사하여 AURA의 'Gemini API Key' 란에 붙여넣고 저장하세요.</li>
            </ol>
            <div style="background:rgba(255,101,132,0.08); padding:0.6rem; border-radius:6px; margin-top:0.6rem; font-size:0.8rem; color:var(--color-primary);">
                💡 무료 티어로 일 수천 건 이상 사용 가능하며 무제한 데이트 코스를 추천받을 수 있습니다.
            </div>`;
    } else if (type === 'firebase-rules') {
        const currentRoom = syncRoomId || "77";
        const rulesJson = `{
  "rules": {
    "aura-rooms": {
      "${currentRoom}": {
        ".read": "auth != null && (auth.token.email == '기존 파트너1@gmail.com' || auth.token.email == '기존 파트너2@gmail.com')",
        ".write": "auth != null && (auth.token.email == '기존 파트너1@gmail.com' || auth.token.email == '기존 파트너2@gmail.com')"
      },
      "새로운방번호": {
        ".read": "auth != null && (auth.token.email == '친구1@gmail.com' || auth.token.email == '친구2@gmail.com')",
        ".write": "auth != null && (auth.token.email == '친구1@gmail.com' || auth.token.email == '친구2@gmail.com')"
      }
    }
  }
}`;
        titleEl.innerHTML = `💌 지인 커플 초대하는 방법`;
        bodyEl.innerHTML = `
            <ol style="padding-left:1.2rem; margin-top:0.5rem;">
                <li style="margin-bottom:0.6rem;"><strong>방 번호 정하기</strong><br>
                아무 숫자/영문(예: 55)이나 정해서 초대할 커플에게 <code>?room=55</code>가 붙은 링크를 전달할 계획을 세웁니다.</li>
                <li style="margin-bottom:0.6rem;"><strong>Firebase 콘솔 → Realtime Database → 규칙(Rules)</strong><br>
                아래 문구에서 <strong>기존 방 블록은 지금 콘솔에 있는 실제 이메일로 유지</strong>하고, <code>"새로운방번호"</code> 블록만 정한 방 번호와 초대할 두 명의 Gmail 주소로 바꿔 넣은 뒤 게시(Publish)하세요.</li>
                <li style="margin-bottom:0.6rem;"><strong>링크 전달</strong><br>
                <code>https://soulrsp.github.io/Dating-Planning-Agent/?room=55</code> 형태로 전달하면 끝입니다.</li>
            </ol>
            <textarea readonly id="firebase-rules-template" style="width:100%; min-height:220px; font-family:monospace; font-size:0.78rem; padding:0.6rem; border-radius:8px; border:1px solid rgba(255,101,132,0.25); background:rgba(255,101,132,0.04); color:var(--color-text-high); resize:vertical; margin-top:0.4rem;">${rulesJson}</textarea>
            <button type="button" class="btn btn-outline" style="width:100%; justify-content:center; margin-top:0.5rem;" onclick="copyFirebaseRulesTemplate()">📋 복사하기</button>
            <div style="background:rgba(255,101,132,0.08); padding:0.6rem; border-radius:6px; margin-top:0.6rem; font-size:0.8rem; color:var(--color-primary);">
                💡 위 문구는 예시입니다 — 실제 콘솔에 이미 등록된 기존 방/이메일 내용을 그대로 유지한 채, 새 블록만 추가해서 게시해야 기존 커플 접근이 끊기지 않습니다.
            </div>`;
    } else if (type === 'tourapi') {
        titleEl.innerHTML = `🔑 문화축제 정보 API Key 발급 가이드`;
        bodyEl.innerHTML = `
            <ol style="padding-left:1.2rem; margin-top:0.5rem;">
                <li style="margin-bottom:0.6rem;"><strong>공공데이터포털 접속 및 회원가입</strong><br>
                <a href="https://www.data.go.kr" target="_blank" style="color:var(--color-primary); text-decoration:underline;">data.go.kr</a>에서 회원가입 후 로그인합니다.</li>
                <li style="margin-bottom:0.6rem;"><strong>"한국관광공사_국문 관광정보 서비스_GW" 검색 후 활용신청</strong><br>
                오픈 API 탭에서 검색해 [활용신청] → 활용 목적을 간단히 작성하면 보통 즉시~1일 내 자동 승인됩니다. 무료입니다.</li>
                <li style="margin-bottom:0.6rem;"><strong>마이페이지 → 인증키 복사</strong><br>
                승인 후 마이페이지에서 발급된 "일반 인증키(Encoding)" 또는 "(Decoding)" 값을 복사해 아래 '문화축제 정보 API Key' 란에 붙여넣으세요. 둘 중 어느 쪽을 넣어도 동작합니다.</li>
            </ol>
            <div style="background:rgba(255,101,132,0.08); padding:0.6rem; border-radius:6px; margin-top:0.6rem; font-size:0.8rem; color:var(--color-primary);">
                💡 이 키는 개인 발급키라 다른 커플과 공유되지 않고 이 기기의 localStorage에만 저장됩니다. 하루 1회 정도만 호출하므로 무료 할당량으로 충분합니다.
            </div>`;
    } else {
        titleEl.innerHTML = `🔑 네이버 지도 Client ID 발급 가이드`;
        bodyEl.innerHTML = `
            <ol style="padding-left:1.2rem; margin-top:0.5rem;">
                <li style="margin-bottom:0.6rem;"><strong>네이버 클라우드 플랫폼 접속</strong><br>
                <a href="https://www.ncloud.com" target="_blank" style="color:var(--color-primary); text-decoration:underline;">ncloud.com</a> 로그인 후 콘솔로 이동합니다.</li>
                <li style="margin-bottom:0.6rem;"><strong>Maps 서비스 신청</strong><br>
                [Services] ➔ [AI·NAVER API] ➔ [Maps] ➔ [Application 등록] ➔ <strong>Web Dynamic Map</strong> 및 <strong>Geocoding</strong> 체크</li>
                <li style="margin-bottom:0.6rem;"><strong>Client ID 복사</strong><br>
                인증 정보(Client ID)를 복사하여 아래 '네이버 지도 Client ID' 란에 붙여넣으세요!</li>
            </ol>`;
    }

    modal.classList.add("active");
};

window.copyFirebaseRulesTemplate = async function() {
    const el = document.getElementById("firebase-rules-template");
    if (!el) return;
    await copyShareLinkToClipboard(el.value);
    showToast("규칙 문구가 클립보드에 복사되었습니다! 📋", "success");
};

window.closeApiGuideModal = function() {
    const modal = document.getElementById("modal-api-guide");
    if (modal) modal.classList.remove("active");
};

// 12. Real-Time Couple Sync Engine (Firebase REST Polling)
function startCloudSyncLoop() {
    if (syncIntervalId) clearInterval(syncIntervalId);
    if (photoSyncIntervalId) clearInterval(photoSyncIntervalId);
    
    const banner = document.getElementById("sync-status-banner");
    const statusText = document.getElementById("sync-status-text");
    const pulse = document.getElementById("sync-status-pulse");
    const mobileStatusText = document.getElementById("mobile-sync-text");
    const mobilePulse = document.getElementById("mobile-sync-pulse");

    if (!syncRoomId) {
        if (pulse) pulse.style.display = "none";
        if (mobilePulse) mobilePulse.style.display = "none";
        if (statusText) statusText.innerHTML = `실시간 동기화 연결하기 🔗`;
        if (mobileStatusText) mobileStatusText.textContent = "동기화 🔗";
        if (banner) {
            banner.style.background = "rgba(124, 92, 104, 0.1)";
            banner.style.color = "var(--color-text-med)";
            banner.style.borderColor = "rgba(124, 92, 104, 0.25)";
        }
        return;
    }

    if (pulse) pulse.style.display = "inline-block";
    if (mobilePulse) mobilePulse.style.display = "inline-block";
    if (statusText) statusText.innerHTML = `연결 룸: <strong>${syncRoomId}</strong> 🔗`;
    if (mobileStatusText) mobileStatusText.innerHTML = `룸:${syncRoomId} 🔗`;
    if (banner) {
        banner.style.background = "rgba(255, 101, 132, 0.1)";
        banner.style.color = "var(--color-primary)";
        banner.style.borderColor = "rgba(255, 101, 132, 0.25)";
    }

    // Polling this often per open device/tab is what exhausted the Firebase free-tier download
    // quota. This is a 2-person app, not real-time collaboration — 20s/45s is still responsive
    // enough while cutting request volume by 4x, and loadPhotosFromCloud() now skips the actual
    // download entirely unless photosVersion changed, so this interval mostly costs a few bytes.
    syncIntervalId = setInterval(async () => {
        if (document.visibilityState !== 'visible') return;
        await loadFromCloud();
    }, 20000);

    photoSyncIntervalId = setInterval(async () => {
        if (document.visibilityState !== 'visible') return;
        await loadPhotosFromCloud();
        await loadMemoryPhotosFromCloud();
    }, 45000);

    // A pending edit from before the last reload never got a chance to retry (the JS context that
    // scheduled it was torn down). Flush it now, before the first loadFromCloud() below runs, so
    // the guard's protection actually results in the edit reaching the cloud instead of just
    // sitting there un-synced until the user happens to make another edit.
    if (localMutationTimestamp > lastSyncedTimestamp) {
        const pendingPlaceIds = JSON.parse(localStorage.getItem('aura_pending_place_ids') || '[]');
        pendingPlaceIds.forEach(id => savePlaceToCloud(id));
        if (localStorage.getItem('aura_pending_settings')) {
            saveSettingsToCloud();
        }
    }

    // Run immediately on start
    loadFromCloud();
    loadPhotosFromCloud();
    loadMemoryPhotosFromCloud();
}

// Derives the same per-place cloud key used by uploadPhotoToCloud/photoVersions, so a place's
// text data and its photos live under consistent, independently-writable paths.
function placeNameKey(name) {
    return (name || "").trim().toLowerCase().replace(/[/\\?%*:|"<>. ]/g, "_");
}

// Pushes ONE place to its own cloud node (/aura-rooms/{room}/places/{nameKey}), never the whole
// collection. This is the fix for the "date rolls back overnight" bug: the old saveToCloud() PATCHed
// a single placesData string containing the ENTIRE local places array on every edit. If a device's
// local copy was even slightly stale (hadn't pulled a change another device already made to some
// OTHER place), saving anything at all silently pushed that stale copy of every other place too,
// clobbering edits the other device had already synced. Writing only the changed place's own path
// makes that structurally impossible — this device can never overwrite a place it didn't touch.
async function savePlaceToCloud(placeId, attempt = 1) {
    if (!syncRoomId) return;
    const MAX_ATTEMPTS = 4;
    try {
        const place = await db.places.get(placeId);
        if (!place) return;

        const copy = { ...place };
        sanitizePlaceObject(copy);
        delete copy.photo;
        delete copy.photos;
        delete copy.photoVersion; // local-only bookkeeping for loadPhotosFromCloud's gating
        delete copy.id; // local Dexie auto-increment id, meaningless (and possibly colliding) across devices

        const nameKey = placeNameKey(copy.name);
        if (!nameKey) return;

        const ts = Date.now();
        const url = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/places/${encodeURIComponent(nameKey)}.json?print=silent`;
        const response = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(copy)
        });
        if (!response.ok) throw new Error(`place write failed: ${response.status}`);

        // Cheap top-level marker other devices' loadFromCloud() polls to know something changed.
        await fetch(`${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/timestamp.json?print=silent`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ts)
        });
        lastSyncedTimestamp = ts;
        localStorage.removeItem('aura_pending_mutation_ts');
        clearPendingPlaceId(placeId);
    } catch (e) {
        console.error(`[Place Sync] Save failed (attempt ${attempt}/${MAX_ATTEMPTS}) for place ${placeId}:`, e);
        if (attempt < MAX_ATTEMPTS) {
            setTimeout(() => savePlaceToCloud(placeId, attempt + 1), 3000 * attempt);
        } else {
            console.error('[Place Sync] Giving up after max retries — place stayed local-only.');
        }
    }
}

// A place's cloud node is keyed by its name (see placeNameKey), so renaming a place makes
// savePlaceToCloud() write a brand-new node instead of updating the old one — the old node is
// orphaned, still holds the pre-rename data, and any later loadFromCloud() resurrects it as a
// phantom duplicate place (it can no longer name-match anything local, so it looks "new").
// Call this right after a rename succeeds locally to delete that stale node before it can do that.
async function deleteOrphanedPlaceCloudNode(oldName) {
    if (!syncRoomId) return;
    const nameKey = placeNameKey(oldName);
    if (!nameKey) return;
    try {
        await fetch(`${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/places/${encodeURIComponent(nameKey)}.json?print=silent`, {
            method: 'DELETE'
        });
    } catch (e) {
        console.error('[Place Sync] Failed to delete orphaned cloud node for rename:', e);
    }
}

// One-time (or rare) bulk seed: pushes every local place individually, e.g. when the cloud room is
// completely empty. Still per-place writes underneath — never a wholesale array overwrite.
async function pushAllLocalPlacesToCloud() {
    const places = await db.places.toArray();
    for (const p of places) {
        await savePlaceToCloud(p.id);
    }
}

// Settings-only save — partner names & public client keys. Small, rarely-conflicting scalars, so a
// wholesale PATCH here is fine; place data must never travel through this path (see savePlaceToCloud).
async function saveSettingsToCloud(attempt = 1) {
    if (!syncRoomId) return;
    const MAX_ATTEMPTS = 4;
    try {
        const now = Date.now();
        // The sync room is an unauthenticated Firebase path — anyone who knows the room id can read it.
        // Public client keys (Naver Client ID, Kakao JS key) are safe to sync and are domain-restricted.
        // Real secrets are not synced, and are explicitly nulled so PATCH deletes any copy already stored
        // in the room by earlier builds. Enter those per-device in 설정 instead.
        const payload = {
            partnerAName: partnerAName,
            partnerBName: partnerBName,
            naverClientId: naverClientId,
            kakaoApiKey: kakaoApiKey,
            naverSearchId: null,
            naverSearchSecret: null,
            geminiApiKey: null,
            timestamp: now
        };

        const bodyStr = JSON.stringify(payload);
        // print=silent — the response body (which Firebase otherwise echoes back in full) is never
        // read below, so there's no reason to pay for downloading it.
        const url = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}.json?print=silent`;
        const response = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: bodyStr
        });
        if (response.ok) {
            lastSyncedTimestamp = now;
            localStorage.removeItem('aura_pending_mutation_ts');
            localStorage.removeItem('aura_pending_settings');
        } else {
            throw new Error(`settings write failed: ${response.status}`);
        }
    } catch (e) {
        console.error(`[Settings Sync] Save failed (attempt ${attempt}/${MAX_ATTEMPTS}):`, e);
        if (attempt < MAX_ATTEMPTS) {
            setTimeout(() => saveSettingsToCloud(attempt + 1), 3000 * attempt);
        }
    }
}

// Destructive db.places.clear() REMOVED! Replaced with safe Union Merge Engine.
async function loadFromCloud() {
    if (!syncRoomId || isDownloading || isUploading) return;
    // A local edit hasn't been confirmed uploaded yet — pulling now would merge in the cloud's
    // stale pre-edit copy and silently undo the edit. Stay blocked until savePlaceToCloud()/
    // saveSettingsToCloud() succeeds (they retry on failure), not just for a fixed window.
    if (localMutationTimestamp > lastSyncedTimestamp) return;

    isDownloading = true;

    try {
        // Cheap check first (a few bytes) — full placesData can run tens of KB, and re-downloading
        // it in full on every poll across multiple always-open devices is what drove Firebase
        // download usage into the tens of GB/day range. Only pull the full room when it changed.
        const tsUrl = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/timestamp.json?t=${Date.now()}`;
        const tsResp = await fetch(tsUrl, { cache: 'no-store' });
        if (tsResp.ok) {
            const remoteTs = await tsResp.json();
            if (remoteTs && remoteTs === lastSyncedTimestamp) return;
        }

        // Fetch only the specific fields this function actually uses, one small request each — NOT
        // the parent /aura-rooms/{room}.json. That single request pulls down every child node,
        // including photos/photoVersions/memoryPhotos (megabytes of base64), even though none of
        // that is read below. This was the real source of the multi-MB "full room" fetches: the
        // per-place/per-gallery version-gating elsewhere never protected this path at all.
        // `places` is an OBJECT of individual place records ({nameKey: place}), not a single
        // stringified array — see savePlaceToCloud for why.
        const roomBase = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}`;
        const roomFields = ['places', 'partnerAName', 'partnerBName', 'naverClientId', 'kakaoApiKey', 'timestamp'];
        const fieldResults = await Promise.all(roomFields.map(f =>
            fetch(`${roomBase}/${f}.json?t=${Date.now()}`, { cache: 'no-store' })
                .then(r => r.ok ? r.json() : undefined)
                .catch(() => undefined)
        ));
        const resData = {};
        roomFields.forEach((f, i) => { resData[f] = fieldResults[i]; });

        const localPlaces = await db.places.toArray();

        if (resData.places == null && resData.timestamp == null) {
            // Room empty in cloud, initialize cloud with local data
            if (localPlaces.length > 0) {
                await pushAllLocalPlacesToCloud();
            }
            return;
        }

        // ALWAYS process room settings metadata (Naver Client ID, Gemini Key, Partner Names)
        if (typeof resData === 'object') {
            let namesChanged = false;
            if (resData.partnerAName && resData.partnerAName !== partnerAName) {
                partnerAName = resData.partnerAName;
                localStorage.setItem("aura_partner_a_name", partnerAName);
                const el = document.getElementById("settings-partner-a-name");
                if (el) el.value = partnerAName;
                namesChanged = true;
            }
            if (resData.partnerBName && resData.partnerBName !== partnerBName) {
                partnerBName = resData.partnerBName;
                localStorage.setItem("aura_partner_b_name", partnerBName);
                const el = document.getElementById("settings-partner-b-name");
                if (el) el.value = partnerBName;
                namesChanged = true;
            }
            if (namesChanged) {
                updatePartnerNamesUI();
            }

            if (resData.naverClientId && resData.naverClientId !== naverClientId) {
                naverClientId = resData.naverClientId;
                localStorage.setItem("aura_naver_client_id", naverClientId);
                const el = document.getElementById("settings-naver-client-id");
                if (el) el.value = naverClientId;
                if (naverClientId) {
                    loadNaverMapScript(naverClientId);
                }
            }

            // naverSearchSecret / geminiApiKey are deliberately NOT restored from the room — see the
            // saveSettingsToCloud payload. Secrets pulled from an unauthenticated path would re-plant
            // themselves in localStorage on every device that opens the room.

            if (resData.kakaoApiKey && resData.kakaoApiKey !== kakaoApiKey) {
                kakaoApiKey = resData.kakaoApiKey;
                localStorage.setItem("aura_kakao_key", kakaoApiKey);
                const el = document.getElementById("settings-kakao-api-key");
                if (el) el.value = kakaoApiKey;
            }

            // memoryPhotos is no longer read here — see loadMemoryPhotosFromCloud(), its own
            // version-gated path. (Legacy rooms may still have a stray resData.memoryPhotos field
            // from before this fix; it's simply ignored now.)
        }

        if (resData.places) {
            if (resData.timestamp) {
                lastSyncedTimestamp = resData.timestamp;
            }

            const fetchedPlaces = Object.values(resData.places);

            if (Array.isArray(fetchedPlaces)) {
                // Filter out any junk/duplicate places directly from fetched cloud data
                const seenCloudNames = new Set();
                const placesToApply = [];

                fetchedPlaces.forEach(fp => {
                    sanitizePlaceObject(fp);
                    const cleanName = (fp.name || "").trim();
                    if (cleanName && cleanName.length >= 2 && cleanName.toLowerCase() !== "undefined" && cleanName.toLowerCase() !== "null") {
                        const nameKey = cleanName.toLowerCase();
                        if (!seenCloudNames.has(nameKey)) {
                            seenCloudNames.add(nameKey);
                            placesToApply.push(fp);
                        }
                    }
                });

                const localPlaces = await db.places.toArray();

                // Preserve local tombstones. (This used to also copy localMatch.photo/photos onto fp
                // "to avoid wiping them" — but that's exactly the race the comment below describes:
                // localPlaces is a snapshot taken before this function's own await, so copying from it
                // reintroduces a stale photo into updatePayload every time. photo/photos belong to
                // loadPhotosFromCloud() alone now; fp must never carry them.)
                placesToApply.forEach(fp => {
                    const localMatch = localPlaces.find(lp => (lp.name || "").trim().toLowerCase() === (fp.name || "").trim().toLowerCase());
                    if (localMatch && (localMatch.isDeleted === 1 || localMatch.isVisited === -1)) {
                        fp.isDeleted = 1;
                        fp.isVisited = -1;
                    }
                });

                // Safe Cloud Sync Guard: Prevent wiping local DB if cloud returns empty places while local DB has data
                if (placesToApply.length === 0 && localPlaces.some(p => !p.isDeleted)) {
                    console.warn("[Sync Engine] Cloud returned empty places, but local DB has active data. Pushing local places to cloud instead of clearing local DB.");
                    await pushAllLocalPlacesToCloud();
                    return;
                }

                // Smart Upsert Engine: Upsert places to Dexie DB safely without clearing DB
                let hasChanges = false;
                const sessionDeletedNames = new Set(JSON.parse(sessionStorage.getItem('aura_session_deleted') || '[]'));
                // A save for one place completing bumps lastSyncedTimestamp globally, which can
                // wrongly satisfy the guard at the top of this function while a DIFFERENT place's
                // edit is still mid-retry. Re-check the pending list itself (not just the single
                // timestamp) so an unconfirmed edit can never be clobbered by this pull.
                const pendingPlaceIdsNow = new Set(JSON.parse(localStorage.getItem('aura_pending_place_ids') || '[]'));
                for (const fp of placesToApply) {
                    const cleanFpName = (fp.name || "").trim().toLowerCase();
                    const existing = localPlaces.find(lp => (lp.name || "").trim().toLowerCase() === cleanFpName);

                    if (existing) {
                        // Local tombstone is terminal — never let a stale (pre-delete) cloud copy revive it.
                        // It stays local-only until savePlaceToCloud() successfully pushes the deletion out.
                        if (existing.isDeleted === 1 || existing.isVisited === -1) continue;
                        // This place has its own edit still queued/retrying — don't let a cloud copy that
                        // predates that edit overwrite it out from under the pending upload.
                        if (pendingPlaceIdsNow.has(existing.id)) continue;

                        const updatePayload = { ...fp };
                        delete updatePayload.id;
                        // Firebase deletes a key entirely when it's written as null (there's no stored
                        // "null", only "absent"). savePlaceToCloud() sets createdAt: null for undated
                        // places, so on the way back down that key is simply missing from fp — re-add it
                        // explicitly so the diff below (which only compares keys present in updatePayload)
                        // actually detects and applies "미정" to a device whose local copy still has a date.
                        if (!('createdAt' in fp)) updatePayload.createdAt = null;
                        // photo/photos are deliberately absent from fp (stripped before this place's own
                        // node was written — see savePlaceToCloud) and must stay absent from updatePayload
                        // too, so Dexie's update() leaves them untouched. They used to be explicitly re-added here
                        // from `existing`, but `existing` is a snapshot taken before this function's own
                        // call, and loadFromCloud()/loadPhotosFromCloud() run concurrently (both fired
                        // unawaited from startCloudSyncLoop) — so this was overwriting a photo
                        // loadPhotosFromCloud() had *just* correctly written with the stale pre-sync value,
                        // silently reverting it back to empty every time any other field also changed.

                        let isDifferent = false;
                        for (const key of Object.keys(updatePayload)) {
                            if (JSON.stringify(existing[key]) !== JSON.stringify(updatePayload[key])) {
                                isDifferent = true;
                                break;
                            }
                        }

                        if (isDifferent) {
                            await db.places.update(existing.id, updatePayload);
                            hasChanges = true;
                        }
                    } else {
                        // Never re-create an entry the cloud marks deleted, or that this session deleted
                        if (fp.isDeleted === 1 || sessionDeletedNames.has(cleanFpName)) continue;
                        const newData = { ...fp };
                        delete newData.id;
                        await db.places.add(newData);
                        hasChanges = true;
                    }
                }

                if (hasChanges) {
                    console.log("[Sync Engine] Local DB updated from cloud diff.");
                    await updateDashboardStats();
                    await renderPlacesList();
                    updateMapMarkers();
                    await loadPhotosFromCloud();
                }
            }
        }
    } catch (e) {
        console.error('Firebase load error:', e);
    } finally {
        isDownloading = false;
    }
}

// Standalone trigger to force immediate sync uploads on local edits.
// Pass the changed place's id for any place mutation (add/edit/delete/comment/etc) — that pushes
// only that place's own cloud node (see savePlaceToCloud). Call with no argument only for
// settings-only changes (partner names, API keys) — never for place data.
function triggerSyncUpload(placeId) {
    localMutationTimestamp = Date.now();
    // Survives a reload/close before the upload (or its retry) finishes — see the init comment above.
    localStorage.setItem('aura_pending_mutation_ts', String(localMutationTimestamp));

    if (placeId != null) {
        const pending = JSON.parse(localStorage.getItem('aura_pending_place_ids') || '[]');
        if (!pending.includes(placeId)) {
            pending.push(placeId);
            localStorage.setItem('aura_pending_place_ids', JSON.stringify(pending));
        }
        setTimeout(() => savePlaceToCloud(placeId), 50);
    } else {
        localStorage.setItem('aura_pending_settings', '1');
        setTimeout(() => saveSettingsToCloud(), 50);
    }
}

// Removes a place id from the "not yet confirmed uploaded" list once its save actually succeeds.
function clearPendingPlaceId(placeId) {
    const pending = JSON.parse(localStorage.getItem('aura_pending_place_ids') || '[]').filter(id => id !== placeId);
    if (pending.length > 0) {
        localStorage.setItem('aura_pending_place_ids', JSON.stringify(pending));
    } else {
        localStorage.removeItem('aura_pending_place_ids');
    }
}

// ── Firebase Photos REST API sync ──
// A failed attempt retries a few times with a short delay — this used to fail silently and
// permanently on any hiccup (a 401 during the rules lockdown, a 400 from the old oversized-payload
// bug, a dropped connection), leaving the place's photo stuck locally with nothing to show it was
// ever lost. Real place: 한국전통문화대학교's photo never reached the cloud at all until this was added.
async function uploadPhotoToCloud(placeIdOrName, base64ImagesArray, attempt = 1) {
    if (!syncRoomId) return;
    const MAX_ATTEMPTS = 4;
    try {
        let placeKey = placeIdOrName;
        if (typeof placeIdOrName === 'number') {
            const p = await db.places.get(placeIdOrName);
            if (p && p.name) placeKey = p.name.trim().toLowerCase().replace(/[/\\?%*:|"<>. ]/g, "_");
        } else if (typeof placeIdOrName === 'string') {
            placeKey = placeIdOrName.trim().toLowerCase().replace(/[/\\?%*:|"<>. ]/g, "_");
        }

        const ts = Date.now();
        // print=silent — Firebase otherwise echoes the written value back in the response, which
        // for a PUT of image data means downloading the photo a second time for nothing.
        const url = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/photos/${encodeURIComponent(placeKey)}.json?print=silent`;

        // No photos left (last one deleted) — clear the cloud node instead of no-op'ing, otherwise
        // the stale non-empty entry survives and the next loadPhotosFromCloud() poll restores it.
        let mainOk;
        if (!base64ImagesArray || base64ImagesArray.length === 0) {
            const r = await fetch(url, { method: 'DELETE' });
            mainOk = r.ok;
        } else {
            const body = JSON.stringify({
                img: base64ImagesArray[0] || "",
                imgList: base64ImagesArray,
                ts
            });
            const r = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body
            });
            mainOk = r.ok;
        }

        if (!mainOk) throw new Error('photo write failed');

        // Per-place version index (just a number, no image bytes) so other devices can tell WHICH
        // place changed without downloading every place's photos to find out — lets
        // loadPhotosFromCloud() fetch only that one place instead of the whole library.
        const versionsEntryUrl = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/photoVersions/${encodeURIComponent(placeKey)}.json?print=silent`;
        await fetch(versionsEntryUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ts)
        });

        // Cheap top-level marker so devices can skip even the photoVersions map when nothing changed.
        const versionUrl = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/photosVersion.json?print=silent`;
        await fetch(versionUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ts)
        });
        // This device already has the change it just made — remember the version now so its own
        // next poll doesn't immediately re-download the photo library it just uploaded.
        setLastKnownPhotosVersion(ts);
    } catch (e) {
        console.error(`[Photo Sync] Save failed (attempt ${attempt}/${MAX_ATTEMPTS}):`, e);
        if (attempt < MAX_ATTEMPTS) {
            setTimeout(() => uploadPhotoToCloud(placeIdOrName, base64ImagesArray, attempt + 1), 3000 * attempt);
        } else {
            console.error('[Photo Sync] Giving up after max retries — photo stayed local-only.');
        }
    }
}

async function loadPhotosFromCloud() {
    if (!syncRoomId) return;
    // Same pending-edit guard as loadFromCloud() — a local photo add/delete not yet confirmed
    // uploaded shouldn't be clobbered by a stale cloud snapshot pulled in the meantime.
    if (localMutationTimestamp > lastSyncedTimestamp) return;
    try {
        // Cheap check first (a few bytes) — skip everything else when nothing changed since our
        // last pull. This is what was blowing through Firebase's download quota: every device
        // re-fetched every photo, every 10 seconds, forever.
        const versionUrl = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/photosVersion.json?t=${Date.now()}`;
        const versionResp = await fetch(versionUrl, { cache: 'no-store' });
        if (versionResp.ok) {
            const remoteVersion = await versionResp.json();
            if (remoteVersion && remoteVersion === lastKnownPhotosVersion) return;
            setLastKnownPhotosVersion(remoteVersion);
        }

        // Second cheap check: a placeKey -> timestamp map (numbers only, no image bytes) tells us
        // exactly WHICH place changed, so only that place's actual photos get downloaded below —
        // "낱장으로" instead of re-pulling the whole photo library on every change.
        const versionsUrl = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/photoVersions.json?t=${Date.now()}`;
        const versionsResp = await fetch(versionsUrl, { cache: 'no-store' });
        if (!versionsResp.ok) return;
        const remoteVersions = await versionsResp.json();
        if (!remoteVersions || typeof remoteVersions !== 'object') return;

        const places = await db.places.toArray();
        let changed = false;

        for (const place of places) {
            const cleanName = (place.name || "").trim().toLowerCase();
            const nameKey = cleanName.replace(/[/\\?%*:|"<>. ]/g, "_");
            const encodedKey = encodeURIComponent(nameKey);

            const remoteTs = remoteVersions[nameKey] ?? remoteVersions[encodedKey] ?? remoteVersions[cleanName] ?? remoteVersions[place.id];
            if (!remoteTs || place.photoVersion === remoteTs) continue;

            // Only now — for this one place — download its actual image data.
            const photoUrl = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/photos/${encodeURIComponent(nameKey)}.json?t=${Date.now()}`;
            const photoResp = await fetch(photoUrl, { cache: 'no-store' });
            if (!photoResp.ok) continue;
            const entry = await photoResp.json();
            if (!entry) continue;

            const serverImgList = entry.imgList || (entry.img ? [entry.img] : []);
            const localImgList = place.photos || (place.photo ? [place.photo] : []);

            if (serverImgList.length > 0 && JSON.stringify(serverImgList) !== JSON.stringify(localImgList)) {
                await db.places.update(place.id, {
                    photo: serverImgList[0] || "",
                    photos: serverImgList,
                    photoVersion: remoteTs
                });
                changed = true;
            } else {
                // Content already matches — just remember the version so this place isn't re-fetched every poll.
                await db.places.update(place.id, { photoVersion: remoteTs });
            }
        }

        if (changed) {
            console.log("[Photo Sync] Photos successfully synchronized across devices.");
            await renderPlacesList();
            if (currentActiveTab === "gallery") {
                renderGallery();
            }
        }
    } catch (e) {
        console.error('[Photo Sync] Load failed:', e);
    }
}

// ── Memory gallery photos (the dashboard's "우리의 러블리 메모리" widget) ──
// Same anti-pattern as place photos used to have: this used to be embedded whole in every
// placesData save/load, so any unrelated edit re-downloaded the entire gallery as base64.
// Synced through its own path with its own version marker instead, same as place photos.
async function uploadMemoryPhotosToCloud() {
    if (!syncRoomId) return;
    try {
        const ts = Date.now();
        const url = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/memoryPhotos.json?print=silent`;
        await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(customMemoryPhotos)
        });

        const versionUrl = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/memoryPhotosVersion.json?print=silent`;
        await fetch(versionUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ts)
        });
        // Avoid immediately re-downloading the gallery this device just uploaded.
        setLastKnownMemoryPhotosVersion(ts);
    } catch (e) {
        console.error('[Memory Photos Sync] Save failed:', e);
    }
}

async function loadMemoryPhotosFromCloud() {
    if (!syncRoomId) return;
    if (localMutationTimestamp > lastSyncedTimestamp) return;
    try {
        const versionUrl = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/memoryPhotosVersion.json?t=${Date.now()}`;
        const versionResp = await fetch(versionUrl, { cache: 'no-store' });
        if (!versionResp.ok) return;
        const remoteVersion = await versionResp.json();
        if (remoteVersion && remoteVersion === lastKnownMemoryPhotosVersion) return;
        if (remoteVersion) setLastKnownMemoryPhotosVersion(remoteVersion);

        const url = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/memoryPhotos.json?t=${Date.now()}`;
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) return;
        const cloudMemories = await response.json();

        // No version marker exists yet (data predates this versioning scheme, or a write was
        // interrupted before the marker was set) — self-heal by writing one now, so every poll
        // after this one (on any device) has something to compare against instead of unconditionally
        // re-downloading the whole gallery forever.
        if (!remoteVersion) {
            const healedVersion = Date.now();
            fetch(`${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/memoryPhotosVersion.json?print=silent`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(healedVersion)
            }).catch(() => {});
            setLastKnownMemoryPhotosVersion(healedVersion);
        }

        if (!Array.isArray(cloudMemories) || cloudMemories.length === 0) return;
        if (JSON.stringify(customMemoryPhotos) === JSON.stringify(cloudMemories)) return;

        customMemoryPhotos = cloudMemories;
        localStorage.setItem(memoryPhotosStorageKey(), JSON.stringify(customMemoryPhotos));
        await renderLovelyMemoryGallery();
    } catch (e) {
        console.error('[Memory Photos Sync] Load failed:', e);
    }
}

// Checks every local place's photo directly against the cloud, bypassing the photoVersions index
// entirely. loadPhotosFromCloud()'s normal per-place diffing depends on that index existing for a
// place — if a place's entry was never written into it (e.g. its photo was uploaded before this
// versioning scheme existed, or a write silently failed), that place is invisible to the version
// check forever and its photo never syncs, even though the actual /photos/{key} data is fine. This
// is a deliberate one-time full check — acceptable cost for an explicit, rare, user-triggered action.
async function forceResyncAllPlacePhotos() {
    if (!syncRoomId) return;
    const places = await db.places.toArray();
    let changed = false;
    for (const place of places) {
        if (place.isDeleted === 1 || place.isVisited === -1) continue;
        const nameKey = (place.name || "").trim().toLowerCase().replace(/[/\\?%*:|"<>. ]/g, "_");
        if (!nameKey) continue;
        try {
            const photoUrl = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/photos/${encodeURIComponent(nameKey)}.json?t=${Date.now()}`;
            const resp = await fetch(photoUrl, { cache: 'no-store' });
            if (!resp.ok) continue;
            const entry = await resp.json();
            const serverImgList = entry ? (entry.imgList || (entry.img ? [entry.img] : [])) : [];
            const localImgList = place.photos || (place.photo ? [place.photo] : []);
            if (JSON.stringify(serverImgList) !== JSON.stringify(localImgList)) {
                await db.places.update(place.id, {
                    photo: serverImgList[0] || "",
                    photos: serverImgList,
                    photoVersion: entry ? entry.ts : undefined
                });
                changed = true;
            }
        } catch (e) {
            console.error(`[Force Sync] Photo check failed for '${place.name}':`, e);
        }
    }
    return changed;
}

// Manual "지금 클라우드와 강제 동기화" button — for troubleshooting when another device's edit
// (place, photo, or memory gallery) isn't showing up. Resets the cheap "did anything change"
// markers so the next check can't short-circuit on a stale cached version, then re-runs all sync
// paths plus a full per-place photo check that bypasses the photoVersions index. Does NOT touch
// localMutationTimestamp, so an unconfirmed local edit is still protected.
window.forceCloudSync = async function() {
    if (!syncRoomId) {
        showToast("동기화 룸이 설정되어 있지 않습니다.", "warning");
        return;
    }
    showToast("클라우드와 강제 동기화 중... 🔄", "info");
    lastSyncedTimestamp = 0;
    setLastKnownPhotosVersion(0);
    setLastKnownMemoryPhotosVersion(0);
    try {
        await loadFromCloud();
        await forceResyncAllPlacePhotos();
        await loadMemoryPhotosFromCloud();
        await updateDashboardStats();
        await renderPlacesList();
        updateMapMarkers();
        if (currentActiveTab === "gallery") renderGallery();
        showToast("동기화 확인이 끝났습니다! 💖", "success");
    } catch (e) {
        console.error('[Force Sync] Failed:', e);
        showToast("동기화 중 오류가 발생했습니다: " + e.message, "danger");
    }
};

// 13. AI Chatbot Interface
function checkApiKeyAlert() {
    const warning = document.getElementById("api-key-warning");
    if (!geminiApiKey) {
        warning.classList.remove("hidden");
    } else {
        warning.classList.add("hidden");
    }
}

async function handleChatSubmit(e) {
    e.preventDefault();
    const inputEl = document.getElementById("chat-user-input");
    const query = inputEl.value.trim();
    if (!query) return;

    inputEl.value = "";
    appendChatMessage(query, "user");

    if (!geminiApiKey) {
        appendChatMessage("죄송해요! Gemini API Key가 등록되어 있지 않아요. [설정] 탭으로 가서 API Key를 저장한 후 다시 말해 주세요 🌸", "bot");
        return;
    }

    const thinkingId = appendChatMessage("생각하는 중입니다... 러블리 코스를 짜고 있어요! ✨", "bot", true);
    
    try {
        const responseText = await callGeminiAPI(query);
        removeChatBubble(thinkingId);
        
        try {
            const courseData = cleanAndParseJSON(responseText);
            renderAICourseCard(courseData);
        } catch(parseErr) {
            appendChatMessage(responseText, "bot");
        }
    } catch(err) {
        removeChatBubble(thinkingId);
        const errLower = (err.message || "").toLowerCase();
        if (errLower.includes("quota") || errLower.includes("exceeded") || errLower.includes("429") || errLower.includes("resource_exhausted")) {
            showToast("Gemini API 무료 사용량 한도가 초과되었습니다. [에이전트 설정] 탭에서 유효한 키를 확인하시거나 잠시 후 다시 시도해 주세요! 🔑", "warning");
            
            const fallbackCourse = {
                itinerary_title: "🌸 AURA 러블리 시그니처 데이트 코스",
                description: "(Gemini API 일일 사용량 한도 초과로 AURA 시그니처 추천 코스를 안심 제공해 드립니다!) 연남동 경의선 숲길을 손잡고 걷는 낭만적인 데이트 코스입니다.",
                places: [
                    {
                        name: "연남동 경의선 숲길 공원",
                        category: "Park",
                        lat: 37.5612,
                        lng: 126.9248,
                        notes: "손잡고 조용히 대화하며 산책하기 좋은 오솔길 🌿",
                        estimatedCost: 0
                    },
                    {
                        name: "연남동 테일러커피",
                        category: "Cafe",
                        lat: 37.5618,
                        lng: 126.9255,
                        notes: "달콤한 아인슈페너 커피와 시그니처 디저트가 일품인 카페 ☕",
                        estimatedCost: 18000
                    },
                    {
                        name: "연남동 카쿠시타",
                        category: "Restaurant",
                        lat: 37.5624,
                        lng: 126.9262,
                        notes: "분위기 좋은 일식 명란 크림 파스타 & 와인 다이닝 🍝🍷",
                        estimatedCost: 45000
                    }
                ]
            };
            renderAICourseCard(fallbackCourse);
        } else {
            appendChatMessage("AI 코스 실시간 추천에 문제가 생겼어요: " + err.message, "bot");
        }
    }
}

function appendChatMessage(text, sender, isThinking = false) {
    const container = document.getElementById("chat-messages-box");
    const bubbleWrapper = document.createElement("div");
    const uniqueId = "msg-" + Date.now();
    
    bubbleWrapper.className = `message message-${sender}`;
    bubbleWrapper.id = uniqueId;
    
    bubbleWrapper.innerHTML = `
        <div class="msg-bubble">
            ${isThinking ? `<div class="thinking-spinner"></div>` : ''}
            <span>${text.replace(/\n/g, "<br>")}</span>
        </div>
    `;
    
    container.appendChild(bubbleWrapper);
    container.scrollTop = container.scrollHeight;
    
    return uniqueId;
}

function removeChatBubble(id) {
    const bubble = document.getElementById(id);
    if (bubble) bubble.remove();
}

async function callGeminiAPI(userPrompt) {
    const systemInstruction = `You are a professional local Date Course AI Planner.
Your task is to plan a lovely and romantic date itinerary (2-3 places) inside Seoul/South Korea based on the user's requested region, vibe, and budget.
Return your output strictly as a structured JSON object. Do not include markdown tags.

JSON Schema format:
{
  "itinerary_title": "Course Title (e.g. Yeonnam-dong Rose Path Walk)",
  "description": "General romantic summary of the date course",
  "places": [
    {
      "name": "Exact place/venue name",
      "category": "Cafe" | "Restaurant" | "Bar" | "Park" | "Museum" | "Other",
      "lat": float (estimations inside Korea, e.g., 37.5612),
      "lng": float (estimations inside Korea, e.g., 126.9248),
      "notes": "Menu suggestion, aesthetic atmosphere details, why it fits",
      "estimatedCost": integer (KRW cost per couple, e.g. 20000)
    }
  ]
}`;

    return await callGeminiRaw(`User request: ${userPrompt}`, systemInstruction, true);
}

function cleanAndParseJSON(rawText) {
    let cleanText = rawText.trim();
    if (cleanText.startsWith("```json")) {
        cleanText = cleanText.substring(7);
    }
    if (cleanText.startsWith("```")) {
        cleanText = cleanText.substring(3);
    }
    if (cleanText.endsWith("```")) {
        cleanText = cleanText.substring(0, cleanText.length - 3);
    }
    return JSON.parse(cleanText.trim());
}

function renderAICourseCard(course) {
    const container = document.getElementById("chat-messages-box");
    const bubbleWrapper = document.createElement("div");
    bubbleWrapper.className = "message message-bot";
    
    const uniqueCourseId = "course-" + Date.now();
    
    let placesHtml = "";
    course.places.forEach((place, index) => {
        placesHtml += `
            <div class="itinerary-step">
                <div class="itinerary-step-header">
                    <strong>${index + 1}. ${place.name}</strong>
                    <span style="font-size:0.75rem; color:var(--color-primary);">${place.category}</span>
                </div>
                <div class="itinerary-step-desc">${place.notes}</div>
                <div class="itinerary-transit">
                    <i data-lucide="coins" style="width:12px; height:12px;"></i>
                    <span>예상 비용: ${formatCurrency(place.estimatedCost)}</span>
                </div>
            </div>
        `;
    });

    bubbleWrapper.innerHTML = `
        <div class="msg-bubble" style="width: 100%;">
            <div style="margin-bottom: 0.5rem;">🌸 <strong>AI 플래너가 추천하는 데이트 코스</strong></div>
            <div>${course.description}</div>
            
            <div class="itinerary-card" id="${uniqueCourseId}">
                <div class="itinerary-card-title">
                    <i data-lucide="heart"></i>
                    <span>${course.itinerary_title}</span>
                </div>
                <div style="display:flex; flex-direction:column; gap:0.5rem; margin:0.75rem 0;">
                    ${placesHtml}
                </div>
                <div class="itinerary-meta">
                    <span>추천 데이트 코스 장소: ${course.places.length}곳</span>
                </div>
                <div style="margin-top:0.5rem;">
                    <button class="btn btn-primary" style="width:100%; justify-content:center; padding:0.5rem;" onclick="saveAICourseToWishlist('${encodeURIComponent(JSON.stringify(course.places))}')">
                        <i data-lucide="folder-heart"></i> 이 코스 전체 보관함에 저장
                    </button>
                </div>
            </div>
        </div>
    `;
    
    container.appendChild(bubbleWrapper);
    container.scrollTop = container.scrollHeight;
    lucide.createIcons();
}

window.saveAICourseToWishlist = async function(encodedPlaces) {
    const places = JSON.parse(decodeURIComponent(encodedPlaces));
    let savedCount = 0;
    
    try {
        const newIds = [];
        for(const place of places) {
            const newId = await db.places.add({
                name: place.name,
                category: place.category || "Other",
                url: "",
                lat: place.lat || (37.5665 + (Math.random() - 0.5) * 0.02),
                lng: place.lng || (126.9780 + (Math.random() - 0.5) * 0.02),
                priority: "medium",
                notes: place.notes,
                isVisited: 0,
                review: "",
                peopleCount: 2,
                photo: "",
                createdAt: new Date().toISOString()
            });
            newIds.push(newId);
            savedCount++;
        }

        showToast(`${savedCount}개의 데이트 코스가 보관함(위시리스트)에 추가되었습니다!`, "success");
        await updateDashboardStats();
        await renderPlacesList();
        updateMapMarkers();
        newIds.forEach(id => triggerSyncUpload(id));
        switchTab("wishlist");
    } catch(err) {
        showToast("코스 저장 실패: " + err.message, "danger");
    }
};

// 14. Settings Logic
async function saveSettings() {
    const apiKeyVal = document.getElementById("settings-gemini-key").value.trim();
    const naverClientIdVal = document.getElementById("settings-naver-client-id").value.trim();
    const kakaoInputEl = document.getElementById("settings-kakao-api-key");
    const kakaoApiKeyVal = kakaoInputEl ? kakaoInputEl.value.trim() : kakaoApiKey;
    const tourApiInputEl = document.getElementById("settings-tourapi-key");
    const tourApiKeyVal = tourApiInputEl ? tourApiInputEl.value.trim() : tourApiKey;
    const partnerAVal = document.getElementById("settings-partner-a-name").value.trim() || "SH";
    const partnerBVal = document.getElementById("settings-partner-b-name").value.trim() || "SA";
    const syncRoomVal = document.getElementById("settings-sync-room-id").value.trim();
    const firebaseUrVal = document.getElementById("settings-firebase-url").value.trim();
    
    localStorage.setItem("aura_gemini_key", apiKeyVal);
    localStorage.setItem("aura_naver_client_id", naverClientIdVal);
    localStorage.setItem("aura_kakao_key", kakaoApiKeyVal);
    localStorage.setItem("aura_tourapi_key", tourApiKeyVal);
    localStorage.setItem("aura_partner_a_name", partnerAVal);
    localStorage.setItem("aura_partner_b_name", partnerBVal);
    localStorage.setItem("aura_sync_room_id", syncRoomVal);
    localStorage.setItem("aura_firebase_url", firebaseUrVal);
    
    geminiApiKey = apiKeyVal;
    naverClientId = naverClientIdVal;
    kakaoApiKey = kakaoApiKeyVal;
    const tourApiKeyChanged = tourApiKey !== tourApiKeyVal;
    tourApiKey = tourApiKeyVal;
    partnerAName = partnerAVal;
    partnerBName = partnerBVal;
    const roomChanged = syncRoomId !== syncRoomVal;
    syncRoomId = syncRoomVal;
    customFirebaseUrl = firebaseUrVal;

    if (roomChanged) {
        // Memory gallery / photo-version caches are keyed by room (see memoryPhotosStorageKey etc.) —
        // reload them for the new room now, otherwise the widget keeps showing the old room's photos
        // until a cloud poll happens to overwrite it.
        customMemoryPhotos = getStoredMemoryPhotos();
        lastKnownMemoryPhotosVersion = parseInt(localStorage.getItem(memoryPhotosVersionStorageKey()) || '0', 10) || 0;
        lastKnownPhotosVersion = parseInt(localStorage.getItem(photosVersionStorageKey()) || '0', 10) || 0;
        await renderLovelyMemoryGallery();
    }

    updatePartnerNamesUI();

    if (tourApiKeyChanged && tourApiKey) {
        loadFestivalData(true);
    }

    showToast("AURA 환경 설정이 안전하게 저장되었습니다 💖", "success");
    checkApiKeyAlert();
    await updateDashboardStats();
    await renderPlacesList();
    
    // Dynamic map reload if client ID changed
    if (naverClientId) {
        loadNaverMapScript(naverClientId);
    } else {
        initLeafletMap();
    }

    if (kakaoApiKey) {
        loadKakaoPlacesScript(kakaoApiKey);
    }
    
    // Restart Cloud Sync interval with new room configuration and push to cloud
    startCloudSyncLoop();
    triggerSyncUpload();
}

async function exportData() {
    const places = await db.places.toArray();
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(places));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `aura_couple_backup_${new Date().toISOString().slice(0,10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    showToast("데이터 백업 파일 다운로드 중...", "success");
}

function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = async function(event) {
        try {
            const places = JSON.parse(event.target.result);
            if (!Array.isArray(places)) throw new Error("유효한 데이터 리스트가 아닙니다.");
            
            await db.places.clear();
            await db.places.bulkAdd(places.map(p => {
                delete p.id;
                return p;
            }));
            
            showToast("보관함 복원이 무사히 완료되었습니다! 🌸", "success");
            await updateDashboardStats();
            await renderPlacesList();
            updateMapMarkers();
            if (syncRoomId) await pushAllLocalPlacesToCloud();
        } catch(err) {
            showToast("가져오기 실패: " + err.message, "danger");
        }
    };
    reader.readAsText(file);
}



// 15. UI Helpers
function formatCurrency(amount) {
    return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW' }).format(amount).replace("₩", "") + "원";
}

// Replaces window.confirm() — many mobile browsers block/no-op native confirm() dialogs when
// the app is running installed as a standalone PWA, which made every delete button silently
// do nothing (confirm() returns false without ever showing a prompt).
function showConfirmModal(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById("modal-confirm");
        const msgEl = document.getElementById("modal-confirm-message");
        const okBtn = document.getElementById("modal-confirm-ok-btn");
        const cancelBtn = document.getElementById("modal-confirm-cancel-btn");
        if (!modal || !msgEl || !okBtn || !cancelBtn) {
            resolve(window.confirm ? confirm(message) : true);
            return;
        }
        msgEl.textContent = message;
        modal.classList.add("active");

        const cleanup = (result) => {
            modal.classList.remove("active");
            okBtn.removeEventListener("click", onOk);
            cancelBtn.removeEventListener("click", onCancel);
            resolve(result);
        };
        const onOk = () => cleanup(true);
        const onCancel = () => cleanup(false);
        okBtn.addEventListener("click", onOk);
        cancelBtn.addEventListener("click", onCancel);
    });
}

function showToast(message, type = "success") {
    const toast = document.createElement("div");
    toast.className = `toast-banner toast-${type}`;
    toast.style.cssText = `
        position: fixed;
        bottom: 2rem;
        right: 2rem;
        background: rgba(255, 255, 255, 0.95);
        color: var(--color-text-high);
        border: 1px solid rgba(255, 101, 132, 0.2);
        padding: 0.85rem 1.5rem;
        border-radius: 16px;
        font-size: 0.85rem;
        font-weight: 700;
        z-index: 10000;
        backdrop-filter: blur(10px);
        box-shadow: 0 8px 30px rgba(255,101,132,0.15);
        display: flex;
        align-items: center;
        gap: 0.5rem;
        animation: toastIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
    `;
    
    let icon = "heart";
    let color = "var(--color-primary)";
    if (type === "warning") {
        icon = "alert-circle";
        color = "var(--color-warning)";
    } else if (type === "danger") {
        icon = "alert-triangle";
        color = "var(--color-danger)";
    }
    
    toast.innerHTML = `<i data-lucide="${icon}" style="color:${color}; fill:${type === 'success' ? color : 'none'}; width:16px; height:16px;"></i><span>${message}</span>`;
    document.body.appendChild(toast);
    lucide.createIcons();
    
    setTimeout(() => {
        toast.style.animation = "toastOut 0.3s ease-in forwards";
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// Dynamic styles for Toast & Marker animations
const styleSheet = document.createElement("style");
styleSheet.innerText = `
@keyframes toastIn {
    from { transform: translateY(20px) scale(0.9); opacity: 0; }
    to { transform: translateY(0) scale(1); opacity: 1; }
}
@keyframes toastOut {
    from { transform: translateY(0) scale(1); opacity: 1; }
    to { transform: translateY(20px) scale(0.9); opacity: 0; }
}
.thinking-spinner {
    border: 2px solid rgba(255, 101, 132, 0.1);
    border-radius: 50%;
    border-top: 2px solid var(--color-primary);
    width: 16px;
    height: 16px;
    animation: spin 1s linear infinite;
    display: inline-block;
    vertical-align: middle;
    margin-right: 0.5rem;
}
@keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}
@keyframes markerBounce {
    from { transform: translate(-9px, -9px); }
    to { transform: translate(-9px, -15px); }
}
.custom-map-marker {
    display: flex;
    align-items: center;
    justify-content: center;
}
`;
document.head.appendChild(styleSheet);

// Expose openLightbox to global scope for inline onclick handlers
window.openLightbox = function(imgSrc) {
    const lightbox = document.getElementById("modal-photo-viewer");
    const lightboxImg = document.getElementById("lightbox-img");
    if (lightbox && lightboxImg) {
        lightboxImg.src = imgSrc;
        lightbox.classList.add("active");
    }
};

// Download all memory photos in a ZIP file
async function downloadAllPhotos() {
    const places = await db.places.where("isVisited").equals(1).toArray();
    
    // Gather all photos
    const allPhotos = [];
    places.forEach(place => {
        const placeNameClean = place.name.replace(/[/\\?%*:|"<>. ]/g, "_");
        const photosList = place.photos || (place.photo ? [place.photo] : []);
        photosList.forEach((photo, pIdx) => {
            if (photo) {
                allPhotos.push({
                    filename: `${placeNameClean}_${pIdx + 1}.jpg`,
                    dataUrl: photo
                });
            }
        });
    });
    
    if (allPhotos.length === 0) {
        showToast("다운로드할 사진이 없습니다 📷", "warning");
        return;
    }
    
    showToast("사진 압축 및 다운로드를 시작합니다...", "info");
    
    try {
        const zip = new JSZip();
        
        allPhotos.forEach(item => {
            const base64Data = item.dataUrl.split(',')[1];
            zip.file(item.filename, base64Data, { base64: true });
        });
        
        const content = await zip.generateAsync({ type: "blob" });
        const downloadAnchor = document.createElement("a");
        downloadAnchor.href = URL.createObjectURL(content);
        downloadAnchor.download = `AURA_Date_Photos_${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        document.body.removeChild(downloadAnchor);
        
        showToast("모든 사진 다운로드 완료! 💖", "success");
    } catch (e) {
        showToast("다운로드 중 오류가 발생했습니다: " + e.message, "danger");
        console.error("ZIP download failed:", e);
    }
}

// Copy sharing link with fallback for non-secure/file contexts
async function copyShareLinkToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch (err) {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand("copy");
        } catch (e) {
            console.error("Fallback copy failed", e);
        }
        document.body.removeChild(textarea);
    }
}

function sanitizePlaceObject(p) {
    if (!p) return p;
    const cleanStr = (str) => {
        if (typeof str !== 'string' || !str) return str;
        if (str.includes("이선아") || str.includes("선아") || str.includes("위시리스트 충족") || str.includes("바보")) {
            return "";
        }
        return str;
    };
    p.review = cleanStr(p.review);
    p.commentA = cleanStr(p.commentA);
    p.commentB = cleanStr(p.commentB);
    if (p.notes && typeof p.notes === 'string') {
        if (p.notes.includes("이선아") || p.notes.includes("선아") || p.notes.includes("위시리스트 충족") || p.notes.includes("바보")) {
            p.notes = p.notes.replace(/이선아의 위시리스트 충족!?/gi, "")
                             .replace(/물멍하기 좋은 카페 선아 바보/gi, "")
                             .replace(/선아/gi, "")
                             .replace(/바보/gi, "")
                             .trim();
        }
    }
    return p;
}

async function cleanupLegacyComments() {
    await cleanJunkData(false);
}

async function cleanJunkData(showToastMsg = false) {
    try {
        const places = await db.places.toArray();
        const seenNames = new Set();
        const cleanList = [];
        let removedCount = 0;

        for (const p of places) {
            // 1. Keep tombstones (deleted items) as-is. Purging them here — before the deletion
            //    has synced to the cloud — erases all local memory that they were deleted, so the
            //    next cloud pull resurrects them from the stale pre-delete cloud copy as a "new" place.
            //    They're already excluded from every render/list query via isDeleted !== 1 checks.
            if (p.isDeleted === 1 || p.isVisited === -1) {
                cleanList.push(p);
                continue;
            }

            // 2. Strip legacy test strings
            sanitizePlaceObject(p);

            // 3. Filter out invalid/junk places
            const cleanName = (p.name || "").trim();
            if (!cleanName || cleanName.length < 2 || cleanName.toLowerCase() === "undefined" || cleanName.toLowerCase() === "null") {
                removedCount++;
                continue;
            }

            // 4. Deduplicate by lowercased place name
            const nameKey = cleanName.toLowerCase();
            if (seenNames.has(nameKey)) {
                removedCount++;
                continue;
            }

            seenNames.add(nameKey);
            cleanList.push(p);
        }

        if (removedCount > 0 || cleanList.length !== places.length) {
            await db.places.clear();
            if (cleanList.length > 0) {
                await db.places.bulkAdd(cleanList);
            }
            await updateDashboardStats();
            await renderPlacesList();
            updateMapMarkers();
            if (syncRoomId) await pushAllLocalPlacesToCloud();

            if (showToastMsg) {
                showToast(`${removedCount}개의 유령/삭제/중복 데이터가 완벽하게 정제 및 클라우드 소멸되었습니다! 🧹`, "success");
            }
        } else if (showToastMsg) {
            showToast("이상 데이터가 없으며 목록이 매우 깨끗합니다! 💖", "info");
        }
    } catch(e) {
        console.error("Clean junk data error:", e);
    }
}
window.cleanJunkData = cleanJunkData;

window.toggleCustomCategoryInput = function(type) {
    const selectEl = document.getElementById(`${type}-place-category`);
    const customInput = document.getElementById(`${type}-place-custom-category`);
    if (selectEl && customInput) {
        if (selectEl.value === "custom") {
            customInput.style.display = "block";
            customInput.focus();
        } else {
            customInput.style.display = "none";
        }
    }
};

window.toggleCardPhotos = function(placeId) {
    const container = document.getElementById(`card-photos-container-${placeId}`);
    const textEl = document.getElementById(`toggle-photo-text-${placeId}`);
    if (!container) return;
    
    if (container.style.display === "none") {
        container.style.display = "flex";
        if (textEl) textEl.textContent = textEl.textContent.replace("보기 🔼", "숨기기 🔽");
    } else {
        container.style.display = "none";
        if (textEl) textEl.textContent = textEl.textContent.replace("숨기기 🔽", "보기 🔼");
    }
};



// ==========================================
// 13. Date Calendar & Memory Gallery Engines
// ==========================================
let currentCalendarYear = new Date().getFullYear();
let currentCalendarMonth = new Date().getMonth();
let selectedCalendarDateStr = new Date().toISOString().split("T")[0];

window.changeCalendarMonth = function(delta) {
    currentCalendarMonth += delta;
    if (currentCalendarMonth > 11) {
        currentCalendarMonth = 0;
        currentCalendarYear++;
    } else if (currentCalendarMonth < 0) {
        currentCalendarMonth = 11;
        currentCalendarYear--;
    }
    renderCalendar();
};

window.goTodayCalendar = function() {
    const today = new Date();
    currentCalendarYear = today.getFullYear();
    currentCalendarMonth = today.getMonth();
    selectedCalendarDateStr = today.toISOString().split("T")[0];
    renderCalendar();
};

async function renderCalendar() {
    const monthTitle = document.getElementById("calendar-month-title");
    if (monthTitle) {
        monthTitle.textContent = `${currentCalendarYear}년 ${currentCalendarMonth + 1}월`;
    }

    const gridContainer = document.getElementById("calendar-days-grid");
    if (!gridContainer) return;
    gridContainer.innerHTML = "";

    const places = await db.places.toArray();

    const firstDay = new Date(currentCalendarYear, currentCalendarMonth, 1).getDay();
    const daysInMonth = new Date(currentCalendarYear, currentCalendarMonth + 1, 0).getDate();
    const prevMonthDays = new Date(currentCalendarYear, currentCalendarMonth, 0).getDate();

    const todayStr = toLocalDateKey(Date.now());

    // 1. Fill previous month tail days
    for (let i = firstDay - 1; i >= 0; i--) {
        const dayNum = prevMonthDays - i;
        const cell = document.createElement("div");
        cell.className = "calendar-day-cell other-month";
        cell.innerHTML = `<div class="day-number-row"><span class="day-number">${dayNum}</span></div>`;
        gridContainer.appendChild(cell);
    }

    // 2. Fill current month days
    for (let d = 1; d <= daysInMonth; d++) {
        const monthStr = String(currentCalendarMonth + 1).padStart(2, '0');
        const dayStr = String(d).padStart(2, '0');
        const fullDateStr = `${currentCalendarYear}-${monthStr}-${dayStr}`;

        const cell = document.createElement("div");
        cell.className = "calendar-day-cell";
        cell.setAttribute("data-date", fullDateStr);
        if (fullDateStr === todayStr) cell.classList.add("today");
        if (fullDateStr === selectedCalendarDateStr) cell.classList.add("selected");

        cell.addEventListener("click", () => {
            selectCalendarDateAndRender(fullDateStr, 'all');
        });

        // Match places with date & group by type (Visited vs Wishlist)
        const datePlaces = places.filter(p => {
            const pDate = p.createdAt || p.date;
            // 로컬 기준으로 비교해야 KST에서 하루 밀리지 않는다
            return toLocalDateKey(pDate) === fullDateStr;
        });

        const visitedPlaces = datePlaces.filter(p => p.isVisited === 1 || p.isVisited === "1" || p.isVisited === true || p.isVisited === "true");
        const wishlistPlaces = datePlaces.filter(p => (p.isVisited === 0 || p.isVisited === "0" || p.isVisited === false || p.isVisited === "false") && p.isVisited !== -1 && p.isDeleted !== 1);

        let badgesHtml = "";
        if (visitedPlaces.length > 0 || wishlistPlaces.length > 0) {
            badgesHtml += `<div class="cal-badges-container" style="display:flex; flex-direction:column; gap:3px; margin-top:2px; align-items:center; width:100%;">`;
            if (visitedPlaces.length > 0) {
                badgesHtml += `
                    <button type="button" class="cal-btn-visited" title="다녀온 곳 ${visitedPlaces.length}개" onclick="event.stopPropagation(); selectCalendarDateAndRender('${fullDateStr}', 'visited')" style="background:rgba(116,185,255,0.18); color:#74B9FF; border:1px solid rgba(116,185,255,0.35); border-radius:6px; font-size:0.75rem; padding:4px 6px; min-height:24px; font-weight:700; cursor:pointer; width:100%; text-align:center;">
                        <span class="badge-emoji">🌸</span> <span class="badge-text">다녀옴 (${visitedPlaces.length})</span>
                    </button>
                `;
            }
            if (wishlistPlaces.length > 0) {
                badgesHtml += `
                    <button type="button" class="cal-btn-wishlist" title="위시리스트 ${wishlistPlaces.length}개" onclick="event.stopPropagation(); selectCalendarDateAndRender('${fullDateStr}', 'wishlist')" style="background:rgba(255,101,132,0.18); color:var(--color-primary); border:1px solid rgba(255,101,132,0.35); border-radius:6px; font-size:0.75rem; padding:4px 6px; min-height:24px; font-weight:700; cursor:pointer; width:100%; text-align:center;">
                        <span class="badge-emoji">💌</span> <span class="badge-text">위시 (${wishlistPlaces.length})</span>
                    </button>
                `;
            }
            badgesHtml += `</div>`;
        }

        cell.innerHTML = `
            <div class="day-number-row">
                <span class="day-number">${d}</span>
            </div>
            ${badgesHtml}
        `;

        gridContainer.appendChild(cell);
    }

    // 3. Fill next month head days
    const totalCells = gridContainer.children.length;
    const remainingCells = (totalCells <= 35 ? 35 : 42) - totalCells;
    for (let i = 1; i <= remainingCells; i++) {
        const cell = document.createElement("div");
        cell.className = "calendar-day-cell other-month";
        cell.innerHTML = `<div class="day-number-row"><span class="day-number">${i}</span></div>`;
        gridContainer.appendChild(cell);
    }

    renderSelectedDateDetails(selectedCalendarDateStr, places);
}

window.selectCalendarDateAndRender = async function(dateStr, filterType = 'all') {
    selectedCalendarDateStr = dateStr;
    document.querySelectorAll(".calendar-day-cell").forEach(c => c.classList.remove("selected"));
    const targetCell = document.querySelector(`.calendar-day-cell[data-date="${dateStr}"]`);
    if (targetCell) targetCell.classList.add("selected");
    
    const places = await db.places.toArray();
    renderSelectedDateDetails(dateStr, places, filterType);

    const detailsEl = document.getElementById("selected-date-title");
    if (detailsEl) {
        detailsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
};

function renderSelectedDateDetails(dateStr, places, filterType = 'all') {
    const titleEl = document.getElementById("selected-date-title");
    const itemsEl = document.getElementById("selected-date-items");
    if (!titleEl || !itemsEl) return;

    const dateObj = new Date(dateStr);
    const formattedTitle = !isNaN(dateObj.getTime()) ? `${dateObj.getFullYear()}년 ${dateObj.getMonth() + 1}월 ${dateObj.getDate()}일 데이트 기록` : `${dateStr} 데이트 기록`;
    titleEl.textContent = formattedTitle;

    const allDatePlaces = places.filter(p => {
        if (p.isDeleted === 1 || p.isVisited === -1) return false;
        const pDate = p.createdAt || p.date;
        // 로컬 기준으로 비교해야 KST에서 하루 밀리지 않는다
        return toLocalDateKey(pDate) === dateStr;
    });

    const datePlaces = allDatePlaces.filter(p => {
        if (filterType === 'visited') return parseInt(p.isVisited) === 1;
        if (filterType === 'wishlist') return parseInt(p.isVisited) === 0;
        return true;
    });

    if (datePlaces.length === 0) {
        itemsEl.innerHTML = `
            <div style="text-align:center; padding:1.2rem; color:var(--color-text-med); font-size:0.85rem;">
                이 날짜에는 아직 등록된 데이트 일정이나 다녀온 기록이 없습니다. 🌸
            </div>
        `;
        return;
    }

    itemsEl.innerHTML = "";
    datePlaces.forEach(p => {
        const isVis = parseInt(p.isVisited) === 1;
        const statusBadge = isVis 
            ? `<span class="badge-visited" style="font-size:0.7rem; padding:0.15rem 0.55rem; border-radius:6px; background:rgba(116,185,255,0.15); color:#74B9FF; border:1px solid rgba(116,185,255,0.3); font-weight:700; width:fit-content;">📍 다녀온 곳</span>` 
            : `<span class="badge-wish" style="font-size:0.7rem; padding:0.15rem 0.55rem; border-radius:6px; background:rgba(255,101,132,0.15); color:var(--color-primary); border:1px solid rgba(255,101,132,0.3); font-weight:700; width:fit-content;">📍 위시리스트</span>`;

        const commentA = (p.commentA || "").replace(/\s*-\s*AURA.*$/, "").replace(/^💡\s*메모:\s*/, "").trim();
        const commentB = (p.commentB || "").replace(/\s*-\s*AURA.*$/, "").replace(/^💡\s*메모:\s*/, "").trim();

        const div = document.createElement("div");
        div.style.cssText = `
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            padding: 0.75rem 0.9rem;
            background: rgba(255, 101, 132, 0.04);
            border: 1px solid rgba(255, 101, 132, 0.12);
            border-radius: 12px;
            margin-bottom: 0.5rem;
            gap: 4px;
            width: 100%;
        `;

        let commentsHtml = '';
        if (commentA) {
            commentsHtml += `<div style="font-size:0.78rem; color:var(--color-text-med); margin-top:2px; display:flex; align-items:flex-start; gap:5px;">
                <span style="font-weight:700; color:var(--color-primary); background:rgba(255,101,132,0.12); padding:1px 6px; border-radius:5px; font-size:0.7rem; flex-shrink:0;">💬 ${partnerAName}</span>
                <span>${escapeHtml(commentA)}</span>
            </div>`;
        }
        if (commentB) {
            commentsHtml += `<div style="font-size:0.78rem; color:var(--color-text-med); margin-top:2px; display:flex; align-items:flex-start; gap:5px;">
                <span style="font-weight:700; color:#FF9F1C; background:rgba(255,159,28,0.14); padding:1px 6px; border-radius:5px; font-size:0.7rem; flex-shrink:0;">💬 ${partnerBName}</span>
                <span>${escapeHtml(commentB)}</span>
            </div>`;
        }

        div.innerHTML = `
            <div style="display:flex; align-items:center; gap:6px;">
                ${statusBadge}
            </div>
            <div style="display:flex; align-items:center; gap:6px; margin-top:2px;">
                <strong style="font-size:0.95rem; color:var(--color-text-dark);">${escapeHtml(p.name)}</strong>
                <span style="font-size:0.75rem; color:var(--color-primary); background:rgba(255,101,132,0.08); padding:1px 6px; border-radius:4px;">${escapeHtml(p.category)}</span>
            </div>
            ${commentsHtml}

        `;
        itemsEl.appendChild(div);
    });
}

async function renderGallery() {
    const mainContent = document.querySelector(".main-content");
    const savedScrollTop = mainContent ? mainContent.scrollTop : 0;
    const savedWindowY = window.scrollY || document.documentElement.scrollTop;

    const container = document.getElementById("gallery-photos-grid");
    const countEl = document.getElementById("gallery-photo-count");
    if (!container) return;

    container.innerHTML = "";
    const allPlaces = await db.places.toArray();
    const places = allPlaces.filter(p => (p.isVisited === 1 || p.isVisited === true || p.isVisited === "1" || p.isVisited === "true") && p.isDeleted !== 1);
    
    // Filter places with photos
    const galleryPlaces = places.filter(p => {
        const photos = p.photos || (p.photo ? [p.photo] : []);
        return photos.length > 0;
    });

    // 가장 최근 항목이 맨 위로 (방문일 기준, 같으면 최근 등록순)
    galleryPlaces.sort((a, b) => {
        const timeA = parseAnyDate(a.createdAt || a.date);
        const timeB = parseAnyDate(b.createdAt || b.date);
        if (timeB !== timeA) return timeB - timeA;
        return (b.id || 0) - (a.id || 0);
    });

    let totalPhotoCount = 0;
    galleryPlaces.forEach(p => {
        const photos = p.photos || (p.photo ? [p.photo] : []);
        totalPhotoCount += photos.length;
    });

    if (countEl) {
        countEl.textContent = `함께 다녀온 ${galleryPlaces.length}곳의 장소에서 기록된 총 ${totalPhotoCount}장의 소중한 커플 추억 💖`;
    }

    if (galleryPlaces.length === 0) {
        container.innerHTML = `
            <div style="grid-column: 1 / -1; text-align:center; padding:3rem; color:var(--color-text-med);">
                <i data-lucide="camera" style="width:48px; height:48px; opacity:0.3; margin-bottom:0.8rem;"></i>
                <p style="font-size:0.95rem;">아직 등록된 추억 사진이 없습니다.<br>'함께 다녀온 곳'의 장소 기록에 예쁜 추억 사진을 업로드해 보세요! 🌸</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }

    galleryPlaces.forEach(p => {
        const photos = p.photos || (p.photo ? [p.photo] : []);
        const coverIdx = (typeof p.coverPhotoIndex === 'number' && p.coverPhotoIndex >= 0 && p.coverPhotoIndex < photos.length) ? p.coverPhotoIndex : 0;
        const coverPhoto = photos[coverIdx];
        const photoCount = photos.length;

        const card = document.createElement("div");
        card.className = "gallery-card";

        const dateStr = formatDisplayDate(p.createdAt || p.date);

        const commentA = (p.commentA || "").replace(/\s*-\s*AURA.*$/, "").replace(/^💡\s*메모:\s*/, "").trim();
        const commentB = (p.commentB || "").replace(/\s*-\s*AURA.*$/, "").replace(/^💡\s*메모:\s*/, "").trim();

        let commentsHtml = '';
        if (commentA) {
            commentsHtml += `<div style="font-size:0.75rem; color:var(--color-text-med); margin-top:3px; display:flex; align-items:flex-start; gap:4px;">
                <span style="font-weight:700; color:var(--color-primary); background:rgba(255,101,132,0.12); padding:1px 5px; border-radius:4px; font-size:0.68rem; flex-shrink:0;">💬 ${partnerAName}</span>
                <span>${escapeHtml(commentA)}</span>
            </div>`;
        }
        if (commentB) {
            commentsHtml += `<div style="font-size:0.75rem; color:var(--color-text-med); margin-top:3px; display:flex; align-items:flex-start; gap:4px;">
                <span style="font-weight:700; color:#FF9F1C; background:rgba(255,159,28,0.14); padding:1px 5px; border-radius:4px; font-size:0.68rem; flex-shrink:0;">💬 ${partnerBName}</span>
                <span>${escapeHtml(commentB)}</span>
            </div>`;
        }

        card.innerHTML = `
            <div class="gallery-img-wrapper" onclick="openGallerySliderModal(${p.id}, 0)" style="cursor:pointer;">
                <img src="${coverPhoto}" alt="${escapeHtml(p.name)}">
                <div class="gallery-img-overlay">
                    <span>🔍 추억 갤러리 감상하기</span>
                </div>
                ${photoCount > 1 ? `<span style="position:absolute; top:8px; right:8px; background:rgba(0,0,0,0.75); color:#fff; font-size:0.7rem; font-weight:700; padding:3px 9px; border-radius:12px; backdrop-filter:blur(4px); border:1px solid rgba(255,255,255,0.3); pointer-events:none;">🖼️ ${photoCount}장</span>` : ''}
            </div>
            <div class="gallery-card-body">
                <h5 class="gallery-place-title" onclick="openGallerySliderModal(${p.id}, 0)" style="cursor:pointer;">${escapeHtml(p.name)}</h5>
                <div class="gallery-place-meta">
                    <span>${dateStr}</span>
                </div>
                ${commentsHtml}
                <div class="gallery-action-bar" style="margin-top:auto; padding-top:6px;">
                    <button class="btn btn-outline" style="width:100%; font-size:0.75rem; padding:0.35rem; height:32px; border-color:var(--color-primary); color:var(--color-primary); justify-content:center;" onclick="openEditPlaceModal(${p.id}, true)">
                        ✏️ 수정/추가
                    </button>
                </div>
            </div>
        `;
        container.appendChild(card);
    });

    lucide.createIcons();

    // Preserve scroll position
    if (mainContent && savedScrollTop > 0) {
        mainContent.scrollTop = savedScrollTop;
    }
    if (savedWindowY > 0) {
        window.scrollTo(0, savedWindowY);
    }
}

// Multi-Photo Gallery Lightbox Slider Engine
let activeGalleryPhotos = [];
let activePhotoIndex = 0;
let activePlaceInfo = {};

window.openGallerySliderModal = async function(placeId, initialIdx = 0) {
    let place = null;
    if (typeof placeId === 'number') {
        place = await db.places.get(placeId);
    }
    if (!place) {
        const visitedPlaces = await db.places.where("isVisited").equals(1).toArray();
        place = visitedPlaces.find(p => p.id == placeId || p.id === placeId);
    }
    if (!place) return;

    activeGalleryPhotos = place.photos || (place.photo ? [place.photo] : []);
    if (activeGalleryPhotos.length === 0) return;

    activePhotoIndex = Math.max(0, Math.min(initialIdx, activeGalleryPhotos.length - 1));
    
    const dateStr = formatDisplayDate(place.createdAt || place.date);
    
    activePlaceInfo = {
        id: place.id,
        name: place.name,
        meta: `${dateStr} · (${place.category})`,
        comments: place.commentA || place.commentB ? `💬 ${place.commentA ? partnerAName + ': ' + place.commentA : ''} ${place.commentB ? partnerBName + ': ' + place.commentB : ''}` : "",
        coverPhotoIndex: (typeof place.coverPhotoIndex === 'number' && place.coverPhotoIndex >= 0 && place.coverPhotoIndex < activeGalleryPhotos.length) ? place.coverPhotoIndex : 0
    };

    updateGallerySliderUI();

    const modal = document.getElementById("modal-gallery-slider");
    if (modal) {
        modal.classList.add("active");
        setTimeout(() => lucide.createIcons(), 50);
    }
};

function updateGallerySliderUI() {
    const mainImg = document.getElementById("gallery-slider-main-img");
    const nameEl = document.getElementById("gallery-slider-place-name");
    const metaEl = document.getElementById("gallery-slider-place-meta");
    const commEl = document.getElementById("gallery-slider-comments");
    const thumbsContainer = document.getElementById("gallery-slider-thumbs");

    if (mainImg) mainImg.src = activeGalleryPhotos[activePhotoIndex];
    if (nameEl) nameEl.textContent = activePlaceInfo.name;
    if (metaEl) metaEl.textContent = `${activePlaceInfo.meta} [${activePhotoIndex + 1} / ${activeGalleryPhotos.length}]`;
    if (commEl) {
        if (activePlaceInfo.comments) {
            commEl.style.display = "block";
            commEl.textContent = activePlaceInfo.comments;
        } else {
            commEl.style.display = "none";
        }
    }

    if (thumbsContainer) {
        thumbsContainer.innerHTML = "";
        if (activeGalleryPhotos.length > 1) {
            thumbsContainer.style.display = "flex";
            activeGalleryPhotos.forEach((imgSrc, idx) => {
                const thumb = document.createElement("img");
                thumb.src = imgSrc;
                thumb.className = `gallery-slider-thumb ${idx === activePhotoIndex ? 'active' : ''}`;
                thumb.onclick = () => selectGallerySliderImage(idx);
                thumbsContainer.appendChild(thumb);
            });
        } else {
            thumbsContainer.style.display = "none";
        }
    }

    const coverBtn = document.getElementById("btn-set-cover-photo");
    if (coverBtn) {
        const isCover = activePhotoIndex === activePlaceInfo.coverPhotoIndex;
        coverBtn.title = isCover ? "대표 사진임" : "대표 사진 설정";
        coverBtn.style.color = isCover ? "#FFD166" : "#fff";
        coverBtn.disabled = isCover;
        coverBtn.style.opacity = isCover ? "0.6" : "1";
    }
}

window.navigateGallerySlider = function(direction) {
    if (activeGalleryPhotos.length <= 1) return;
    activePhotoIndex = (activePhotoIndex + direction + activeGalleryPhotos.length) % activeGalleryPhotos.length;
    updateGallerySliderUI();
};

window.selectGallerySliderImage = function(idx) {
    if (idx >= 0 && idx < activeGalleryPhotos.length) {
        activePhotoIndex = idx;
        updateGallerySliderUI();
    }
};

// Sets the currently viewed photo as this place's cover — the one shown on its 추억 갤러리 card.
// Stored as an index into `photos`, not the image itself, so it stays a tiny field on the place's
// own cloud node instead of duplicating photo bytes there (see savePlaceToCloud's photo-stripping).
window.setCoverPhoto = async function() {
    if (!activePlaceInfo || !activePlaceInfo.id) return;
    await db.places.update(activePlaceInfo.id, { coverPhotoIndex: activePhotoIndex });
    activePlaceInfo.coverPhotoIndex = activePhotoIndex;
    updateGallerySliderUI();
    triggerSyncUpload(activePlaceInfo.id);
    showToast("대표 사진으로 설정했습니다! ⭐", "success");
    await renderGallery();
};

window.closeGallerySliderModal = function() {
    const modal = document.getElementById("modal-gallery-slider");
    if (modal) modal.classList.remove("active");
};

// 1-by-1 Photo Delete Engine in Gallery Lightbox
window.deleteCurrentSliderPhoto = async function() {
    if (!activeGalleryPhotos || activeGalleryPhotos.length === 0 || !activePlaceInfo || !activePlaceInfo.id) return;
    if (!(await showConfirmModal(`'${activePlaceInfo.name}'의 이 추억 사진을 1장 삭제하시겠습니까?`))) return;

    const place = await db.places.get(activePlaceInfo.id);
    if (!place) return;

    let updatedPhotos = [...(place.photos || (place.photo ? [place.photo] : []))];
    if (activePhotoIndex >= 0 && activePhotoIndex < updatedPhotos.length) {
        updatedPhotos.splice(activePhotoIndex, 1);
    }

    const updatePayload = {
        photos: updatedPhotos,
        photo: updatedPhotos.length > 0 ? updatedPhotos[0] : ""
    };

    // Keep coverPhotoIndex pointing at the same photo it did before the deletion shifted the array —
    // otherwise it can silently end up pointing at a different photo than the one the couple picked.
    if (typeof place.coverPhotoIndex === 'number') {
        if (place.coverPhotoIndex === activePhotoIndex) {
            updatePayload.coverPhotoIndex = 0;
        } else if (place.coverPhotoIndex > activePhotoIndex) {
            updatePayload.coverPhotoIndex = place.coverPhotoIndex - 1;
        }
    }

    await db.places.update(place.id, updatePayload);
    if (syncRoomId) {
        await uploadPhotoToCloud(place.id, updatedPhotos);
    }
    triggerSyncUpload(place.id);

    showToast("추억 사진 1장이 삭제되었습니다! 🗑️", "success");

    if (updatedPhotos.length === 0) {
        closeGallerySliderModal();
    } else {
        if (activePhotoIndex >= updatedPhotos.length) {
            activePhotoIndex = updatedPhotos.length - 1;
        }
        activeGalleryPhotos = updatedPhotos;
        if ('coverPhotoIndex' in updatePayload) activePlaceInfo.coverPhotoIndex = updatePayload.coverPhotoIndex;
        updateGallerySliderUI();
    }

    await renderPlacesList();
    await renderGallery();
};

// Single & Place Photo Download Engines
window.downloadPlacePhotosZip = async function(placeId) {
    let place = null;
    if (placeId) {
        const numericId = parseInt(placeId);
        if (!isNaN(numericId)) {
            place = await db.places.get(numericId);
        }
        if (!place) {
            const all = await db.places.toArray();
            place = all.find(p => p.id == placeId || p.id === placeId);
        }
    }
    
    let photoList = [];
    let placeName = "추억사진";

    if (place) {
        photoList = place.photos || (place.photo ? [place.photo] : []);
        placeName = place.name || "추억사진";
    } else if (activeGalleryPhotos && activeGalleryPhotos.length > 0) {
        photoList = activeGalleryPhotos;
        placeName = (activePlaceInfo && activePlaceInfo.name) ? activePlaceInfo.name : "추억사진";
    }

    if (photoList.length === 0) {
        showToast("다운로드할 사진이 없습니다 📷", "warning");
        return;
    }

    if (photoList.length === 1) {
        downloadBase64Image(photoList[0], `${placeName}_추억사진.jpg`);
        showToast(`'${placeName}' 사진 1장이 다운로드되었습니다! 📥`, "success");
    } else {
        try {
            showToast(`'${placeName}' 추억 사진 ${photoList.length}장을 압축 다운로드합니다... 📦`, "info");
            const zip = new JSZip();
            const cleanName = placeName.replace(/[/\\?%*:|"<>. ]/g, "_");
            photoList.forEach((pSrc, idx) => {
                const base64Data = pSrc.includes(',') ? pSrc.split(',')[1] : pSrc;
                zip.file(`${cleanName}_추억_${idx + 1}.jpg`, base64Data, { base64: true });
            });
            const content = await zip.generateAsync({ type: "blob" });
            const downloadAnchor = document.createElement("a");
            downloadAnchor.href = URL.createObjectURL(content);
            downloadAnchor.download = `${cleanName}_추억사진_${photoList.length}장.zip`;
            document.body.appendChild(downloadAnchor);
            downloadAnchor.click();
            document.body.removeChild(downloadAnchor);
            showToast("모든 사진 다운로드 완료! 💖", "success");
        } catch(e) {
            photoList.forEach((pSrc, idx) => downloadBase64Image(pSrc, `${placeName}_${idx+1}.jpg`));
            showToast("사진 다운로드가 시작되었습니다! 📥", "success");
        }
    }
};

window.downloadCurrentSliderPhoto = function() {
    if (!activeGalleryPhotos || activeGalleryPhotos.length === 0) return;
    const currentSrc = activeGalleryPhotos[activePhotoIndex];
    const placeTitle = activePlaceInfo ? activePlaceInfo.name : "추억사진";
    downloadBase64Image(currentSrc, `${placeTitle}_사진_${activePhotoIndex + 1}.jpg`);
    showToast("현재 확대된 고화질 사진이 다운로드되었습니다! 📥", "success");
};

window.downloadPlacePhotosZipFromSlider = async function() {
    const targetId = activePlaceInfo ? activePlaceInfo.id : null;
    await window.downloadPlacePhotosZip(targetId);
};

function downloadBase64Image(base64Str, filename) {
    const a = document.createElement("a");
    a.href = base64Str;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// ==========================================
// 13. Calendar Date Details Modal Engine
// ==========================================
window.openDateDetailsModal = async function(dateStr, type = 'all') {
    closeDateDetailsModal();
    if (window.selectCalendarDateAndRender) {
        selectCalendarDateAndRender(dateStr, type);
    }
};

window.closeDateDetailsModal = function() {
    const modal = document.getElementById("modal-date-details");
    if (modal) modal.classList.remove("active");
};

// ==========================================
// 14. Dashboard Lovely Memory Gallery Engine
// ==========================================
// Intentionally empty — the app is Firebase-only for photo data now. This used to ship with 5
// sample couple photos as a placeholder before the user added their own; those files were removed
// from the repo (privacy), so keeping them here would just inject broken <img> tags into the
// gallery on every render (see the forEach below and the empty-list fallback further down).
const DEFAULT_MEMORY_PHOTOS = [];

function getStoredMemoryPhotos() {
    const raw = localStorage.getItem(memoryPhotosStorageKey());
    if (!raw) return [...DEFAULT_MEMORY_PHOTOS];
    try {
        let parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) {
            return [...DEFAULT_MEMORY_PHOTOS];
        }
        DEFAULT_MEMORY_PHOTOS.forEach(defImg => {
            if (!parsed.includes(defImg)) {
                parsed.unshift(defImg);
            }
        });
        return parsed;
    } catch(e) {
        return [...DEFAULT_MEMORY_PHOTOS];
    }
}

let customMemoryPhotos = getStoredMemoryPhotos();
let activeMemoryPhotosList = [];
let activeMemoryPhotoIndex = 0;

async function renderLovelyMemoryGallery() {
    const grid = document.getElementById("dashboard-memory-grid");
    if (!grid) return;

    // 1. Gather all photos attached to visited places in Dexie DB
    const places = await db.places.toArray();
    const placePhotos = [];
    places.forEach(p => {
        if (p.isVisited === 1 || p.isVisited === true || p.isVisited === "1") {
            const list = p.photos || (p.photo ? [p.photo] : []);
            list.forEach(src => {
                if (src && !placePhotos.includes(src)) {
                    placePhotos.push(src);
                }
            });
        }
    });

    // 2. Combine custom memory photos and place photos
    const combinedPhotos = [];
    if (Array.isArray(customMemoryPhotos)) {
        customMemoryPhotos.forEach(src => {
            if (src && !combinedPhotos.includes(src)) {
                combinedPhotos.push(src);
            }
        });
    }
    placePhotos.forEach(src => {
        if (src && !combinedPhotos.includes(src)) {
            combinedPhotos.push(src);
        }
    });

    const displayPhotos = combinedPhotos.length > 0 ? combinedPhotos : DEFAULT_MEMORY_PHOTOS;
    activeMemoryPhotosList = displayPhotos;

    grid.innerHTML = "";
    displayPhotos.forEach((imgSrc, idx) => {
        const item = document.createElement("div");
        item.className = "memory-item";
        item.innerHTML = `<img src="${imgSrc}" alt="Lovely Memory ${idx + 1}" class="gallery-img" onclick="openMemoryLightboxModal(${idx})">`;
        grid.appendChild(item);
    });
}

window.openMemoryLightboxModal = function(idx) {
    if (!activeMemoryPhotosList || activeMemoryPhotosList.length === 0) return;
    activeMemoryPhotoIndex = Math.max(0, Math.min(idx, activeMemoryPhotosList.length - 1));
    updateMemoryLightboxUI();
    const modal = document.getElementById("modal-memory-lightbox");
    if (modal) {
        modal.classList.add("active");
        setTimeout(() => lucide.createIcons(), 50);
    }
};

function updateMemoryLightboxUI() {
    const mainImg = document.getElementById("memory-lightbox-main-img");
    const metaEl = document.getElementById("memory-lightbox-meta");
    if (mainImg && activeMemoryPhotosList[activeMemoryPhotoIndex]) {
        mainImg.src = activeMemoryPhotosList[activeMemoryPhotoIndex];
    }
    if (metaEl) {
        metaEl.textContent = `${activeMemoryPhotoIndex + 1} / ${activeMemoryPhotosList.length}`;
    }
}

window.navigateMemoryLightbox = function(dir) {
    if (!activeMemoryPhotosList || activeMemoryPhotosList.length <= 1) return;
    activeMemoryPhotoIndex = (activeMemoryPhotoIndex + dir + activeMemoryPhotosList.length) % activeMemoryPhotosList.length;
    updateMemoryLightboxUI();
};

window.closeMemoryLightboxModal = function() {
    const modal = document.getElementById("modal-memory-lightbox");
    if (modal) modal.classList.remove("active");
};

window.deleteCurrentMemoryPhoto = async function() {
    if (!activeMemoryPhotosList || activeMemoryPhotosList.length === 0) return;
    if (!(await showConfirmModal("이 추억 사진을 러블리 메모리에서 삭제하시겠습니까?"))) return;

    const photoToDelete = activeMemoryPhotosList[activeMemoryPhotoIndex];
    const customIdx = customMemoryPhotos.indexOf(photoToDelete);
    if (customIdx !== -1) {
        customMemoryPhotos.splice(customIdx, 1);
        localStorage.setItem(memoryPhotosStorageKey(), JSON.stringify(customMemoryPhotos));
        if (syncRoomId) await uploadMemoryPhotosToCloud();
    } else {
        // Not a custom-uploaded memory — it's a photo pulled in from a visited place's own
        // photo list. Removing it there is what actually removes it from this gallery.
        const places = await db.places.toArray();
        const owner = places.find(p => (p.photos && p.photos.includes(photoToDelete)) || p.photo === photoToDelete);
        if (owner) {
            const updatedPhotos = (owner.photos || (owner.photo ? [owner.photo] : [])).filter(src => src !== photoToDelete);
            await db.places.update(owner.id, { photos: updatedPhotos, photo: updatedPhotos[0] || null });
            // photo/photos never travel through savePlaceToCloud (see there) — this dedicated path
            // is the only thing that needs to run. Without it, the next loadPhotosFromCloud() poll
            // pulls the old (still-undeleted) photo list back down and silently undoes this delete.
            if (syncRoomId) {
                await uploadPhotoToCloud(owner.id, updatedPhotos);
            }
        } else {
            showToast("이 사진의 원본 장소를 찾을 수 없어 삭제하지 못했습니다.", "warning");
            return;
        }
    }
    await renderLovelyMemoryGallery();
    showToast("추억 사진이 삭제되었습니다.", "success");
    closeMemoryLightboxModal();
};

window.openEditMemoryGalleryModal = function() {
    const previewBox = document.getElementById("memory-gallery-preview-box");
    if (previewBox) {
        previewBox.innerHTML = "";
        customMemoryPhotos.forEach(src => {
            const img = document.createElement("img");
            img.src = src;
            img.style.cssText = "width:50px; height:50px; object-fit:cover; border-radius:8px; margin:2px;";
            previewBox.appendChild(img);
        });
    }
    const modal = document.getElementById("modal-edit-memory-gallery");
    if (modal) {
        modal.classList.add("active");
        setTimeout(() => lucide.createIcons(), 50);
    }
};

window.closeEditMemoryGalleryModal = function() {
    const modal = document.getElementById("modal-edit-memory-gallery");
    if (modal) modal.classList.remove("active");
};

window.saveMemoryGalleryPhotos = async function() {
    const fileInput = document.getElementById("memory-gallery-files");
    const files = fileInput ? fileInput.files : null;
    
    if (files && files.length > 0) {
        const newPhotos = [];
        for (let i = 0; i < files.length; i++) {
            const reader = new FileReader();
            const base64 = await new Promise((res) => {
                reader.onload = (e) => res(e.target.result);
                reader.readAsDataURL(files[i]);
            });
            const compressed = await compressBase64Image(base64, 1024, 1024, 0.75);
            if (compressed) newPhotos.push(compressed);
        }
        if (newPhotos.length > 0) {
            customMemoryPhotos = [...customMemoryPhotos, ...newPhotos];
            localStorage.setItem(memoryPhotosStorageKey(), JSON.stringify(customMemoryPhotos));
            await renderLovelyMemoryGallery();
            if (syncRoomId) await uploadMemoryPhotosToCloud();
            showToast(`우리의 러블리 메모리에 ${newPhotos.length}장의 사진이 누적 추가되었습니다! (총 ${customMemoryPhotos.length}장) 💖`, "success");
            closeEditMemoryGalleryModal();
            return;
        }
    }
    
    showToast("새로 선택된 사진이 없습니다.", "info");
    closeEditMemoryGalleryModal();
};

window.downloadAllMemoryGalleryPhotos = async function() {
    const photosToDownload = (customMemoryPhotos && customMemoryPhotos.length > 0) ? customMemoryPhotos : DEFAULT_MEMORY_PHOTOS;
    if (photosToDownload.length === 0) {
        showToast("다운로드할 메모리 사진이 없습니다.", "warning");
        return;
    }

    try {
        showToast(`러블리 메모리 대표 사진 ${photosToDownload.length}장을 압축 다운로드합니다... 📦`, "info");
        const zip = new JSZip();
        for (let i = 0; i < photosToDownload.length; i++) {
            const pSrc = photosToDownload[i];
            if (pSrc.startsWith("data:")) {
                const base64Data = pSrc.split(',')[1];
                zip.file(`러블리_메모리_${i + 1}.jpg`, base64Data, { base64: true });
            } else {
                const blob = await fetch(pSrc).then(r => r.blob());
                zip.file(`러블리_메모리_${i + 1}.jpg`, blob);
            }
        }
        const content = await zip.generateAsync({ type: "blob" });
        const downloadAnchor = document.createElement("a");
        downloadAnchor.href = URL.createObjectURL(content);
        downloadAnchor.download = `AURA_러블리_메모리_${photosToDownload.length}장.zip`;
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        document.body.removeChild(downloadAnchor);
        showToast("러블리 메모리 전체 사진 다운로드 완료! 💖", "success");
    } catch(e) {
        photosToDownload.forEach((pSrc, idx) => downloadBase64Image(pSrc, `러블리_메모리_${idx+1}.jpg`));
        showToast("다운로드가 시작되었습니다! 📥", "success");
    }
};

// ==========================================
// 14. Smartphone Mobile Pair & QR Modal Engine
// ==========================================
window.openShareRoomModal = function() {
    const roomId = syncRoomId || "77";
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
    
    const inputEl = document.getElementById("share-room-url");
    if (inputEl) inputEl.value = shareUrl;

    const qrImg = document.getElementById("qr-code-img");
    if (qrImg) {
        qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(shareUrl)}`;
    }

    const modal = document.getElementById("modal-share-room");
    if (modal) {
        modal.classList.add("active");
        setTimeout(() => lucide.createIcons(), 50);
    }
};

window.closeShareRoomModal = function() {
    const modal = document.getElementById("modal-share-room");
    if (modal) modal.classList.remove("active");
};

window.copyShareRoomUrl = async function() {
    const inputEl = document.getElementById("share-room-url");
    if (!inputEl || !inputEl.value) return;

    await copyShareLinkToClipboard(inputEl.value);
    showToast("스마트폰 연동 링크가 클립보드에 복사되었습니다! 💌", "success");
};

// PWA Install Prompt Listener
let deferredPwaPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPwaPrompt = e;
    console.log('[PWA] beforeinstallprompt event captured');
});
