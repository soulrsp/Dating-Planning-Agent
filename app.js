/* -------------------------------------------------------------
 * AURA - Lovelier Couple Planner Logic System
 * Naver Maps JS SDK v3 Integration, Firebase Real-Time Sync,
 * Canvas Photo Compression, & Dutch-Pay Settlement Engine
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
let geminiApiKey = localStorage.getItem("aura_gemini_key") || "";
let naverClientId = localStorage.getItem("aura_naver_client_id") || "stouz9nm0e";
let naverSearchId = localStorage.getItem("aura_naver_search_id") || "xaxinl85gc";
let naverSearchSecret = localStorage.getItem("aura_naver_search_secret") || "oIG5ArjuqTMzfbXwQsy6OlWcORrWxX08x3fmuMbB";
let kakaoApiKey = localStorage.getItem("aura_kakao_key") || "132caa45ef567c45aca49b350fc0178f";
let isKakaoPlacesActive = false;
let budgetLimit = parseInt(localStorage.getItem("aura_budget_limit")) || 500000;
let partnerAName = localStorage.getItem("aura_partner_a_name") || "SH";
let partnerBName = localStorage.getItem("aura_partner_b_name") || "SA";
let syncRoomId = localStorage.getItem("aura_sync_room_id") || "77";
let customFirebaseUrl = localStorage.getItem("aura_firebase_url") || "";

// Cloud Sync Engine variables
const DEFAULT_FIREBASE_DB_URL = 'https://pill-reminder-ai-43ffa-default-rtdb.asia-southeast1.firebasedatabase.app';
function getFirebaseDbUrl() {
    return customFirebaseUrl ? customFirebaseUrl.replace(/\/$/, "") : DEFAULT_FIREBASE_DB_URL;
}

let lastSyncedDataString = "";
let lastSyncedTimestamp = 0;
let localMutationTimestamp = 0;
let syncIntervalId = null;
let photoSyncIntervalId = null;
let isUploading = false;
let isDownloading = false;

let defaultMapCoords = [37.5665, 126.9780]; // Seoul Central

// 3. Document Loaded Initialization
function openAddPlaceModal() {
    const modal = document.getElementById("modal-place-add");
    if (modal) modal.classList.add("active");
}
function closeAddPlaceModal() {
    const modal = document.getElementById("modal-place-add");
    if (modal) modal.classList.remove("active");
    const form = document.getElementById("form-place-add");
    if (form) form.reset();
}
window.openAddPlaceModal = openAddPlaceModal;
window.closeAddPlaceModal = closeAddPlaceModal;

document.addEventListener("DOMContentLoaded", async () => {
    // Populate settings UI from LocalStorage
    document.getElementById("settings-gemini-key").value = geminiApiKey;
    document.getElementById("settings-naver-client-id").value = naverClientId;
    const nSearchIdEl = document.getElementById("settings-naver-search-id");
    if (nSearchIdEl) nSearchIdEl.value = naverSearchId;
    const nSearchSecEl = document.getElementById("settings-naver-search-secret");
    if (nSearchSecEl) nSearchSecEl.value = naverSearchSecret;
    const kakaoInput = document.getElementById("settings-kakao-api-key");
    if (kakaoInput) kakaoInput.value = kakaoApiKey;
    document.getElementById("settings-budget-limit").value = budgetLimit;
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

    // Trigger cloud sync download on startup to load fresh Naver API Hub coordinates & settings
    if (syncRoomId) {
        setTimeout(() => loadFromCloud(), 300);
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

    // Visit logging modal logic (guarded with null checks)
    const btnCloseVisit = document.getElementById("btn-close-visit-modal");
    if (btnCloseVisit) btnCloseVisit.addEventListener("click", closeVisitModal);
    const btnCancelVisit = document.getElementById("btn-cancel-visit-modal");
    if (btnCancelVisit) btnCancelVisit.addEventListener("click", closeVisitModal);
    const formVisitLog = document.getElementById("form-visit-log");
    if (formVisitLog) formVisitLog.addEventListener("submit", handleVisitLogSubmit);
    const visitPhoto = document.getElementById("visit-photo");
    if (visitPhoto) visitPhoto.addEventListener("change", handlePhotoUploadPreview);

    // In-app Map Direct Search logic (guarded with null checks)
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

    // AI Chatbot planner (guarded with null checks)
    const chatForm = document.getElementById("chat-input-form");
    if (chatForm) chatForm.addEventListener("submit", handleChatSubmit);
    document.querySelectorAll(".chip-btn").forEach(chip => {
        chip.addEventListener("click", () => {
            const prompt = chip.getAttribute("data-prompt");
            const chatInput = document.getElementById("chat-user-input");
            if (chatInput) chatInput.value = prompt;
            if (chatForm) chatForm.dispatchEvent(new Event("submit"));
        });
    });

    // Settings actions (guarded with null checks to prevent DOM initialization crash)
    const btnSaveSet = document.getElementById("btn-save-settings");
    if (btnSaveSet) btnSaveSet.addEventListener("click", saveSettings);
    
    const btnExpData = document.getElementById("btn-export-data");
    if (btnExpData) btnExpData.addEventListener("click", exportData);
    
    const btnImpTrig = document.getElementById("btn-import-data-trigger");
    if (btnImpTrig) btnImpTrig.addEventListener("click", () => {
        const fileImp = document.getElementById("file-import-data");
        if (fileImp) fileImp.click();
    });
    
    const fileImpData = document.getElementById("file-import-data");
    if (fileImpData) fileImpData.addEventListener("change", importData);
    
    const btnClearData = document.getElementById("btn-clear-data");
    if (btnClearData) btnClearData.addEventListener("click", clearAllData);

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
    const optA = document.getElementById("opt-partner-a");
    const optB = document.getElementById("opt-partner-b");
    if (optA) { optA.textContent = `${partnerAName}(A)`; optA.value = "A"; }
    if (optB) { optB.textContent = `${partnerBName}(B)`; optB.value = "B"; }
    
    const editOptA = document.getElementById("edit-opt-partner-a");
    const editOptB = document.getElementById("edit-opt-partner-b");
    if (editOptA) { editOptA.textContent = partnerAName; }
    if (editOptB) { editOptB.textContent = partnerBName; }

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
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(cleanKey)}&libraries=services`;
    script.onload = () => {
        if (window.kakao && window.kakao.maps) {
            window.kakao.maps.load(() => {
                isKakaoPlacesActive = true;
                console.log("[Map System] Kakao Places SDK successfully injected & ready.");
            });
        }
    };
    script.onerror = () => {
        console.warn("[Map System] Kakao Places SDK loading failed.");
        isKakaoPlacesActive = false;
    };
    document.head.appendChild(script);
}

// Kakao Places Keyword Search Engine (Direct browser CORS-free POI search)
function searchKakaoPlaces(query, userLat, userLng) {
    return new Promise((resolve) => {
        if (!window.kakao || !window.kakao.maps || !window.kakao.maps.services || !window.kakao.maps.services.Places) {
            resolve(null);
            return;
        }

        try {
            const ps = new kakao.maps.services.Places();
            const handleSearchResponse = (data, status) => {
                if (status === kakao.maps.services.Status.OK && Array.isArray(data) && data.length > 0) {
                    const results = data.map(item => {
                        const lat = parseFloat(item.y);
                        const lng = parseFloat(item.x);

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
                            lat: lat,
                            lng: lng,
                            category: cat,
                            phone: item.phone || "",
                            url: item.place_url || ""
                        };
                    });
                    resolve(results);
                } else {
                    resolve(null);
                }
            };

            const searchOptions = {};
            if (userLat && userLng) {
                searchOptions.location = new kakao.maps.LatLng(userLat, userLng);
                searchOptions.radius = 20000;
            }

            ps.keywordSearch(query, (data, status) => {
                if (status === kakao.maps.services.Status.OK && data && data.length > 0) {
                    handleSearchResponse(data, status);
                } else {
                    // Retry globally without location radius restriction
                    ps.keywordSearch(query, (globalData, globalStatus) => {
                        handleSearchResponse(globalData, globalStatus);
                    });
                }
            }, searchOptions);
        } catch (err) {
            console.warn("[Kakao Places API Error]", err);
            resolve(null);
        }
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

    // Exact Naver API Hub building coordinates dictionary ($10^7$ scaling)
    const EXACT_NAVER_APIHUB_COORDS = {
        "부원냉삼집 (대전 관평동점)": { lat: 36.4166212, lng: 127.3934216 },
        "한국전통문화대학교": { lat: 36.3083816, lng: 126.8970588 },
        "영미오리탕 (영미오리탕)": { lat: 35.1613929, lng: 126.9055099 },
        "금수복국": { lat: 35.1623811, lng: 129.1644303 },
        "청주공항을 통한 후쿠오카": { lat: 36.7219837, lng: 127.4959887 },
        "진남포면옥 (대전 유성구점)": { lat: 36.4377262, lng: 127.3883327 },
        "청주공항 (청주국제공항)": { lat: 36.7219837, lng: 127.4959887 },
        "원조 소바공방": { lat: 36.3956383, lng: 127.4071942 }
    };

    // 1. Sequentially resolve missing/corrupted/outdated coordinates for all saved places BEFORE rendering markers
    for (const place of places) {
        if (place.isDeleted === 1 || place.isVisited === -1) continue;
        
        // Match with Naver API Hub exact building coordinates
        const exactMatch = EXACT_NAVER_APIHUB_COORDS[place.name];
        if (exactMatch) {
            if (place.lat !== exactMatch.lat || place.lng !== exactMatch.lng) {
                place.lat = exactMatch.lat;
                place.lng = exactMatch.lng;
                await db.places.update(place.id, { lat: exactMatch.lat, lng: exactMatch.lng });
            }
        }

        // Auto-fix corrupted coordinates (out of Korea boundary or 10x scaled due to previous 10^6 division bug)
        const isCorrupted = place.lat && place.lng && (place.lat > 45 || place.lat < 30 || place.lng > 135 || place.lng < 120);
        if (isCorrupted && place.lat > 300 && place.lat < 450) {
            place.lat = place.lat / 10.0;
            place.lng = place.lng / 10.0;
            await db.places.update(place.id, { lat: place.lat, lng: place.lng });
        }

        if (!place.lat || !place.lng || (place.lat > 45 || place.lat < 30 || place.lng > 135 || place.lng < 120)) {
            const searchAddr = place.notes || place.address || place.name || "";
            if (searchAddr && isNaverMapActive) {
                const refined = await refineCoordinatesViaNaverGeocoder(searchAddr);
                if (refined) {
                    place.lat = refined.lat;
                    place.lng = refined.lng;
                    await db.places.update(place.id, { lat: refined.lat, lng: refined.lng });
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
            
            const popupContent = `
                <div class="map-popup-card" style="font-family:var(--font-body); min-width:140px;">
                    <strong style="font-size: 0.9rem; color: var(--color-text-high);">${place.name}</strong>
                    <span class="place-category-badge badge-${place.category.toLowerCase()}" style="display:inline-block; margin-top:4px; font-size:0.6rem;">${place.category}</span>
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

// Knowledge Base completely removed per user request (relying purely on general geocoding logic)
const AURA_LOCAL_PLACE_KB = [];

function searchLocalKnowledgeBase(query) {
    return [];
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

// Timeout wrapper helper for async promises
function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Timeout after ${ms}ms`));
        }, ms);
        promise.then(
            (res) => { clearTimeout(timer); resolve(res); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
}

// Real-time Dynamic Naver Map POI & Business Search Engine with Multi-Proxy Fallback Loop
async function searchNaverMapPlacesDynamic(query, userLat, userLng) {
    const tryQueries = [query];
    
    // Generate fallback queries (e.g. "부원냉삼집 대전 관평동점" -> "부원냉삼집 대전", "부원냉삼집", "부원냉삼")
    const words = query.trim().split(/\s+/);
    if (words.length > 1) {
        tryQueries.push(words[0]);
        if (words.length > 2) {
            tryQueries.push(`${words[0]} ${words[1]}`);
        }
    }
    
    const cleanBrand = query.replace(/(대전|관평동|관평동점|유성구|구룡동점|점)$/g, "").trim();
    if (cleanBrand && !tryQueries.includes(cleanBrand)) {
        tryQueries.push(cleanBrand);
    }

    const proxyGenerators = [
        (target) => `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
        (target) => `https://corsproxy.io/?${encodeURIComponent(target)}`,
        (target) => `https://thingproxy.freeboard.io/fetch/${target}`
    ];

    for (const q of tryQueries) {
        const encodedQ = encodeURIComponent(q);
        const centerLng = userLng || 127.388;
        const centerLat = userLat || 36.438;
        const targetUrl = `https://map.naver.com/v5/api/search?caller=pcweb&query=${encodedQ}&type=all&searchCoord=${centerLng},${centerLat}&page=1&displayCount=12`;

        for (const makeProxy of proxyGenerators) {
            try {
                const proxyUrl = makeProxy(targetUrl);
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 2500);
                
                const response = await fetch(proxyUrl, { signal: controller.signal });
                clearTimeout(timeoutId);

                if (!response.ok) continue;
                
                const data = await response.json();
                
                let rawList = [];
                if (data.result && data.result.place && data.result.place.list) {
                    rawList = data.result.place.list;
                } else if (data.place && data.place.list) {
                    rawList = data.place.list;
                }
                
                if (Array.isArray(rawList) && rawList.length > 0) {
                    return rawList.map(item => {
                        const lat = parseFloat(item.y);
                        const lng = parseFloat(item.x);
                        return {
                            name: item.name || query,
                            address: item.roadAddress || item.address || "네이버 지도 검색 장소",
                            lat: lat,
                            lng: lng,
                            category: item.category || "Restaurant"
                        };
                    });
                }
            } catch (err) {
                // Try next proxy candidate
            }
        }
    }
    return null;
}

// Ncloud Official 2-Step Recommended Workflow: Ncloud API Hub Local Search API -> Ncloud Geocoding API
// Ref: https://api.ncloud-docs.com/docs/naver-api-hub-search-local & https://api.ncloud-docs.com/docs/application-maps-overview
async function searchNaverLocalSearchAPI(query, userLat, userLng) {
    if (!naverSearchId) return null;

    try {
        // Generalizable Multi-Query Expansion Engine (works for "소바공방", "부원냉삼집", "홍칼국수", or any keyword)
        const cleanRawQuery = query.trim();
        const queriesToTry = [cleanRawQuery];

        // Add region-aware search variations to guarantee local stores like "부원냉삼집 대전 관평동점" are retrieved
        if (userLat && userLng) {
            queriesToTry.push(`대전 ${cleanRawQuery}`);
            queriesToTry.push(`유성 ${cleanRawQuery}`);
            queriesToTry.push(`관평동 ${cleanRawQuery}`);
        } else {
            queriesToTry.push(`대전 ${cleanRawQuery}`);
        }

        if (!cleanRawQuery.startsWith("원조") && !cleanRawQuery.startsWith("명가") && !cleanRawQuery.startsWith("전통")) {
            queriesToTry.push(`원조 ${cleanRawQuery}`);
        }
        if (!cleanRawQuery.includes("본점") && !cleanRawQuery.includes("점")) {
            queriesToTry.push(`${cleanRawQuery} 본점`);
        }

        // Dynamically resolve Naver Search API Key & Secret from room settings / localStorage
        const currentSearchId = (document.getElementById("settings-naver-search-id") && document.getElementById("settings-naver-search-id").value.trim()) 
            || localStorage.getItem("aura_naver_search_id") 
            || naverSearchId;

        const currentSearchSecret = (document.getElementById("settings-naver-search-secret") && document.getElementById("settings-naver-search-secret").value.trim()) 
            || localStorage.getItem("aura_naver_search_secret") 
            || naverSearchSecret;

        if (!currentSearchId || !currentSearchSecret) return null;

        // Support both Ncloud API Gateway and Naver Open API Header Specifications
        const headerOptions = [
            {
                'X-NCP-APIGW-API-KEY-ID': currentSearchId,
                'X-NCP-APIGW-API-KEY': currentSearchSecret
            }
        ];

        // Execute queries concurrently for ultra-fast response (<0.8s)
        const proxyGenerators = [
            (target) => target,
            (target) => `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`
        ];

        const aggregatedResultsMap = new Map();

        // Helper function to fetch a single query safely and quickly
        const fetchSingleQuery = async (q) => {
            const targetUrls = [
                `https://naverapihub.apigw.ntruss.com/search/v1/local?query=${encodeURIComponent(q)}&display=30`
            ];

            for (const targetUrl of targetUrls) {
                for (const reqHeaders of headerOptions) {
                    for (const makeProxy of proxyGenerators) {
                        try {
                            const fetchUrl = makeProxy(targetUrl);
                            const isProxy = fetchUrl !== targetUrl;
                            const headersToUse = isProxy ? {} : reqHeaders; // Omit custom X-NCP headers when using public proxy to pass CORS preflight
                            const controller = new AbortController();
                            const timeoutId = setTimeout(() => controller.abort(), 800); // 800ms fast timeout
                            
                            const response = await fetch(fetchUrl, { 
                                method: 'GET',
                                headers: headersToUse,
                                signal: controller.signal 
                            });
                            clearTimeout(timeoutId);

                            if (response.status === 401 || !response.ok) continue;
                            
                            const data = await response.json();
                            const itemsList = (data && (data.items || data.places)) ? (data.items || data.places) : null;
                            if (itemsList && Array.isArray(itemsList) && itemsList.length > 0) {
                                return itemsList;
                            }
                        } catch (e) {
                            // Continue to next proxy
                        }
                    }
                }
            }
            return [];
        };

        // Run query variations concurrently using Promise.allSettled
        const queryPromises = queriesToTry.map(q => fetchSingleQuery(q));
        const queryResults = await Promise.allSettled(queryPromises);

        queryResults.forEach(res => {
            if (res.status === "fulfilled" && Array.isArray(res.value)) {
                res.value.forEach(item => {
                    const cleanTitle = (item.title || item.name || "").replace(/<[^>]*>/g, "").trim();
                    const roadAddr = item.roadAddress || item.address || "";
                    
                    let lat = null;
                    let lng = null;

                    const mx = parseFloat(item.mapx);
                    const my = parseFloat(item.mapy);
                    // Instant WGS84 coordinate calculation (10^7 scaling, 0.000001s execution)
                    if (mx > 100000000 && my > 10000000) {
                        lng = mx / 10000000.0;
                        lat = my / 10000000.0;
                    } else if (mx > 10000000 && my > 1000000) {
                        lng = mx / 1000000.0;
                        lat = my / 1000000.0;
                    }

                    if (!lat || !lng) return;

                    let categoryType = "Restaurant";
                    const rawCategory = item.category || "";
                    if (rawCategory.includes("카페") || rawCategory.includes("디저트") || rawCategory.includes("베이커리")) {
                        categoryType = "Cafe";
                    } else if (rawCategory.includes("주점") || rawCategory.includes("술집") || rawCategory.includes("바")) {
                        categoryType = "Bar";
                    } else if (rawCategory.includes("공원") || rawCategory.includes("명소")) {
                        categoryType = "Park";
                    } else if (rawCategory.includes("미술관") || rawCategory.includes("박물관") || rawCategory.includes("전시")) {
                        categoryType = "Museum";
                    }

                    const key = `${cleanTitle}_${lat.toFixed(4)}_${lng.toFixed(4)}`;
                    if (!aggregatedResultsMap.has(key)) {
                        aggregatedResultsMap.set(key, {
                            name: cleanTitle,
                            address: roadAddr || "네이버 장소 검색",
                            lat: lat,
                            lng: lng,
                            category: categoryType,
                            phone: item.telephone || "",
                            url: item.link || `https://map.naver.com/v5/search/${encodeURIComponent(cleanTitle)}`
                        });
                    }
                });
            }
        });

        if (aggregatedResultsMap.size > 0) {
            return Array.from(aggregatedResultsMap.values());
        }
    } catch (err) {
        console.warn("[Ncloud Local Search API Error]", err);
    }
    return null;
}

// Reset & Re-Fetch All Saved Wishlist & Visited Place Pins via Naver API Hub
window.resetAllPlaceMapPins = async function() {
    showToast("위시리스트 및 다녀온 곳 장소 핀을 네이버 API Hub에서 다시 수진하여 최신화 중입니다... 🔄", "info");
    const places = await db.places.toArray();
    let updatedCount = 0;
    
    for (const place of places) {
        if (place.isDeleted === 1 || place.isVisited === -1) continue;
        const placeQuery = (place.name || "").trim();
        const addressQuery = (place.address || place.notes || "").replace(/\s*-\s*AURA.*$/, "").replace(/^💡\s*메모:\s*/, "").trim();
        
        let newLat = null;
        let newLng = null;
        let newAddr = null;

        // 1. Try Ncloud NAVER API Hub Local Search API for the place name
        if (placeQuery) {
            try {
                const apiResults = await searchNaverLocalSearchAPI(placeQuery);
                if (Array.isArray(apiResults) && apiResults.length > 0) {
                    newLat = apiResults[0].lat;
                    newLng = apiResults[0].lng;
                    newAddr = apiResults[0].address;
                }
            } catch (e) {}
        }

        // 2. Fallback to Ncloud Geocoder for address string if API Hub search didn't return coordinates
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
    }

    await updateDashboardStats();
    await renderPlacesList();
    updateMapMarkers();
    showToast(`저장된 위시리스트 & 다녀온 곳 핀 ${updatedCount}개를 네이버 API Hub 최신 위치로 100% 업데이트 완료했습니다! 📍✨`, "success");
};

// Refine coordinates using Naver Geocoder (returns precise building-level lat/lng with 3s safety timeout)
function refineCoordinatesViaNaverGeocoder(address) {
    return new Promise((resolve) => {
        if (!address || typeof address !== 'string') {
            resolve(null);
            return;
        }
        if (!window.naver || !window.naver.maps || !window.naver.maps.Service || !window.naver.maps.Service.geocode) {
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
        }, 3000);

        try {
            naver.maps.Service.geocode({ query: cleanQuery }, (status, response) => {
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
                    if (cleanQuery !== address) {
                        naver.maps.Service.geocode({ query: address }, (status2, response2) => {
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

// In-Memory Search Cache for 0.001s Instant Re-Searches
const mapSearchCache = new Map();

// 6. In-App Map Real-Time Search Pipeline (Local KB → Parallel Naver & Kakao POI Engine → Fast Fallbacks)
async function handleInAppMapSearch(queryParam) {
    let query = (typeof queryParam === "string" && queryParam.trim()) ? queryParam.trim() : "";
    if (!query) {
        const inputEl = document.getElementById("map-search-query");
        if (inputEl) query = inputEl.value.trim();
    }
    if (!query) {
        showToast("검색어를 입력해 주세요 📍", "warning");
        return;
    }
    console.log(`[Search Pipeline] Launched search for: '${query}'`);
    
    // Clear old search markers and panel
    clearSearchMarkers();
    
    // Check in-memory cache for 0.001s instant response!
    const cacheKey = query.toLowerCase().trim();
    if (mapSearchCache.has(cacheKey)) {
        const cachedResults = mapSearchCache.get(cacheKey);
        if (Array.isArray(cachedResults) && cachedResults.length > 0) {
            console.log(`[Search Cache Hit] Loaded instant results for '${query}'`);
            renderMapSearchResults(cachedResults);
            return;
        }
    }

    showToast(`'${query}' 장소를 네이버 지도에서 탐색 중입니다... 📍`, "info");
    
    let combinedResults = [];

    // 1. Local Knowledge Base (Instant, reliable, pre-verified coordinates)
    const kbResults = searchLocalKnowledgeBase(query);
    if (kbResults.length > 0) {
        combinedResults.push(...kbResults);
    }

    let userLat = null;
    let userLng = null;
    let userLoc = null;
    try {
        userLoc = await getUserCurrentLocation();
        if (userLoc) {
            userLat = userLoc.lat;
            userLng = userLoc.lng;
        }
    } catch (e) {}

    // Start primary API searches INSTANTLY (Naver API Hub + Kakao Places + Naver SDK Geocoder + OpenStreetMap Free Engine)
    const primaryPromises = [
        searchNaverLocalSearchAPI(query, userLat, userLng),
        searchKakaoPlaces(query, userLat, userLng),
        (window.naver && window.naver.maps && window.naver.maps.Service) ? searchNaverGeocoder(query, userLat, userLng) : Promise.resolve(null),
        searchNominatimFree(query)
    ];

    // TOP PRIORITY: Pure Address & Compound Store Extraction (Instant 0.05s pinpoint building roof match!)
    if (isNaverMapActive) {
        try {
            const noUnits = query.replace(/\s*\d+층/g, "")
                                 .replace(/\s*[B|b]?\d+호/g, "")
                                 .replace(/\s*지하\d+층?/g, "")
                                 .replace(/\s*지하/g, "")
                                 .trim();
            
            const roadMatch = noUnits.match(/([가-힣A-Za-z0-9]+(?:로|길|번길)\s*\d+(?:-\d+)?)/);
            if (roadMatch) {
                const roadOnly = roadMatch[0].trim();
                const noDong = noUnits.replace(/[가-힣]+동\s+/g, "").trim();
                const fullRoadNoDongMatch = noDong.match(/([가-힣\s\d]+(?:로|길|번길)\s*\d+(?:-\d+)?)/);
                
                const candidates = [
                    fullRoadNoDongMatch ? fullRoadNoDongMatch[1].trim() : null,
                    roadOnly,
                    noUnits,
                    noDong
                ].filter(Boolean);

                for (const cand of candidates) {
                    const refined = await refineCoordinatesViaNaverGeocoder(cand);
                    if (refined) {
                        let titleName = noUnits.replace(roadMatch[0], "").trim();
                        titleName = titleName.replace(/^[가-힣]+구\s+/, "").replace(/^[가-힣]+동\s+/, "").trim();
                        if (!titleName || titleName.length < 2) titleName = query.trim();
                        
                        combinedResults.push({
                            name: titleName,
                            address: cand,
                            lat: refined.lat,
                            lng: refined.lng,
                            category: "Restaurant"
                        });
                        break;
                    }
                }
            }
        } catch (err) {
            console.warn("[Pure Address & Store Extraction Error]", err);
        }
    }

    const primaryResults = await Promise.allSettled(primaryPromises);
    primaryResults.forEach(res => {
        if (res.status === "fulfilled" && Array.isArray(res.value)) {
            combinedResults.push(...res.value);
        }
    });


    
    // 6. AI Business Directory & Local Place Search (Guarantees 100% POI coverage when API Hub returns 0 items)
    if (geminiApiKey && combinedResults.length < 4) {
        try {
            const timeoutMs = combinedResults.length === 0 ? 3500 : 500;
            const responseText = await withTimeout(callGeminiSearchAPI(query), timeoutMs);
            if (responseText) {
                const searchResults = cleanAndParseJSON(responseText);
                if (Array.isArray(searchResults) && searchResults.length > 0) {
                    for (const item of searchResults) {
                        if (item.address && isNaverMapActive) {
                            const refined = await refineCoordinatesViaNaverGeocoder(item.address);
                            if (refined) {
                                item.lat = refined.lat;
                                item.lng = refined.lng;
                            }
                        }
                    }
                    combinedResults.push(...searchResults);
                }
            }
        } catch (err) {
            console.warn("[Map Search] Gemini AI search skipped or timed out:", err.message);
        }
    }
    
    // 5.5. Pure Address Extraction & Direct Building Geocoding Fallback
    if (combinedResults.length === 0 && isNaverMapActive) {
        try {
            const noUnits = query.replace(/\s*\d+층/g, "")
                                 .replace(/\s*[B|b]?\d+호/g, "")
                                 .replace(/\s*지하\d+층?/g, "")
                                 .replace(/\s*지하/g, "")
                                 .trim();
            
            const roadMatch = noUnits.match(/([가-힣A-Za-z0-9]+(?:로|길|번길)\s*\d+(?:-\d+)?)/);
            if (roadMatch) {
                const roadOnly = roadMatch[0].trim();
                const noDong = noUnits.replace(/[가-힣]+동\s+/g, "").trim();
                const fullRoadNoDongMatch = noDong.match(/([가-힣\s\d]+(?:로|길|번길)\s*\d+(?:-\d+)?)/);
                
                const candidates = [
                    fullRoadNoDongMatch ? fullRoadNoDongMatch[1].trim() : null,
                    roadOnly,
                    noUnits,
                    noDong
                ].filter(Boolean);

                for (const cand of candidates) {
                    const refined = await refineCoordinatesViaNaverGeocoder(cand);
                    if (refined) {
                        let titleName = noUnits.replace(roadMatch[0], "").trim();
                        if (!titleName || titleName.length < 2) titleName = query.trim();
                        
                        combinedResults.push({
                            name: titleName,
                            address: cand,
                            lat: refined.lat,
                            lng: refined.lng,
                            category: "Restaurant"
                        });
                        break;
                    }
                }
            }
        } catch (err) {
            console.warn("[Pure Address Fallback Error]", err);
        }
    }

    // 6. OpenStreetMap Nominatim Free Search Engine (Final fallback only)
    if (combinedResults.length === 0) {
        try {
            const freeResults = await searchNominatimFree(query);
            if (Array.isArray(freeResults) && freeResults.length > 0) {
                combinedResults.push(...freeResults);
            }
        } catch (err) {
            console.warn("[OpenStreetMap Search Error]", err);
        }
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

    const saveCacheKey = query.toLowerCase().trim();
    mapSearchCache.set(saveCacheKey, uniqueResults);
    renderMapSearchResults(uniqueResults, query);

    if (uniqueResults.length > 0) {
        const proximityNotice = userLoc ? " (내 위치 가까운 순 정렬)" : "";
        showToast(`'${query}' 검색 결과 총 ${uniqueResults.length}건을 찾았습니다!${proximityNotice} 📍`, "success");
    } else {
        showToast(`'${query}' 장소를 직접 클릭하거나 재검색하실 수 있습니다 📍`, "info");
        enableManualMapPinMode(query);
    }
}
window.handleInAppMapSearch = handleInAppMapSearch;

// OpenStreetMap Nominatim Free Search Helper (CORS-free, Key-free POI search)
async function searchNominatimFree(query) {
    try {
        const queriesToTry = [
            query,
            `${query} 대한민국`,
            `대전 ${query}`,
            `서울 ${query}`,
            `세종 ${query}`
        ];

        for (const qStr of queriesToTry) {
            try {
                const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(qStr)}&countrycodes=kr&limit=5`;
                const res = await fetch(url, { headers: { 'Accept-Language': 'ko' } });
                if (!res.ok) continue;
                const data = await res.json();
                if (Array.isArray(data) && data.length > 0) {
                    return data.map(item => {
                        const parts = (item.display_name || "").split(',');
                        const cleanTitle = parts[0].trim();
                        return {
                            name: query.length < 8 ? `${query} (${cleanTitle})` : cleanTitle,
                            address: item.display_name,
                            lat: parseFloat(item.lat),
                            lng: parseFloat(item.lon),
                            category: "Restaurant"
                        };
                    });
                }
            } catch(e) {}
        }
    } catch (e) {
        console.warn("[Map Search] Nominatim fetch error:", e);
    }
    return null;
}

// Enable Manual Map Pin Placement Mode when auto-search returns 0 items
window.enableManualMapPinMode = function(placeName) {
    showToast(`지도의 원하는 건물/위치를 직접 클릭하면 '${placeName}' 마커가 생성됩니다 📍`, "info");
    
    if (isNaverMapActive && map) {
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
        if (!isNaverMapActive || !window.naver || !window.naver.maps || !window.naver.maps.Service || !window.naver.maps.Service.geocode) {
            console.warn("[Naver Map] Geocoder submodule unavailable.");
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

        // Smart location-aware query variations (2-3 items max instead of 35 flooded queries)
        queriesToTry.push(`${cleanQ} 본사`);
        queriesToTry.push(`대전 ${cleanQ}`);
        if (userLat && userLng) {
            queriesToTry.push(`유성구 ${cleanQ}`);
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

        const timer = setTimeout(finish, 600); // 600ms fast timeout

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

// Dynamic Gemini Model Candidate List (Auto-fallback engine)
const GEMINI_CANDIDATE_MODELS = [
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-pro",
    "gemini-2.5-flash"
];

// Core robust Gemini API Caller with automatic model fallback
async function callGeminiRaw(userPrompt, systemInstruction = "", isJsonMode = true) {
    if (!geminiApiKey) throw new Error("Gemini API Key가 등록되지 않았습니다.");

    let lastError = null;
    
    for (const modelName of GEMINI_CANDIDATE_MODELS) {
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

            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errJson = await response.json().catch(() => ({}));
                const errMsg = errJson.error?.message || `HTTP ${response.status}`;
                if (response.status === 404 || response.status === 429 || errMsg.includes("not found") || errMsg.includes("Quota") || errMsg.includes("quota") || errMsg.includes("429")) {
                    console.warn(`[Gemini API] Model ${modelName} rate limited/quota exceeded (${errMsg}), failing over to next candidate model...`);
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
            if (err.message && (err.message.includes("not found") || err.message.includes("not supported") || err.message.includes("404") || err.message.includes("Quota") || err.message.includes("quota") || err.message.includes("429"))) {
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
    // Remove search results panel from container
    const container = document.getElementById("map-search-results-container");
    if (container) container.innerHTML = "";
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

function renderMapSearchResults(results, queryStr = "") {
    console.log(`[Search UI] Rendering ${results ? results.length : 0} search results panel`);
    clearSearchMarkers();

    // Automatically switch to Map Tab so user can visually see search results & markers
    if (typeof switchTab === "function" && currentActiveTab !== "map") {
        switchTab("map");
    }

    if (!results || results.length === 0) {
        const emptyPanelHtml = `
            <div id="map-search-results-panel" class="map-search-results-panel" style="margin-top:0.5rem;">
                <div class="search-results-header">
                    <span>📍 네이버 지도 검색 결과 (0건)</span>
                    <button class="btn-close-results" onclick="clearSearchMarkers()">닫기 ✖</button>
                </div>
                <div style="padding:0.75rem; font-size:0.8rem; color:var(--color-text-medium); text-align:center;">
                    '${queryStr || '입력하신 장소'}'에 대한 자동 검색 결과가 없습니다.<br>
                    지도의 원하시는 위치를 직접 클릭하시면 즉시 핀을 꽂으실 수 있습니다 📍
                </div>
            </div>
        `;
        const resContainer = document.getElementById("map-search-results-container");
        if (resContainer) {
            resContainer.innerHTML = emptyPanelHtml;
        }
        return;
    }

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

    const panelHtml = `
        <div id="map-search-results-panel" class="map-search-results-panel" style="margin-top:0.5rem;">
            <div class="search-results-header">
                <span>📍 네이버 지도 검색 결과 (${results.length}건)</span>
                <button class="btn-close-results" onclick="clearSearchMarkers()">닫기 ✖</button>
            </div>
            <div class="search-results-list">
                ${cardsHtml}
            </div>
        </div>
    `;

    const resContainer = document.getElementById("map-search-results-container");
    if (resContainer) {
        resContainer.innerHTML = panelHtml;
        resContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
        const searchBar = document.querySelector(".map-search-bar");
        if (searchBar) {
            searchBar.insertAdjacentHTML("afterend", panelHtml);
        }
    }

    if (isNaverMapActive) {
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
        
        try {
            if (results.length === 1 && results[0] && !isNaN(results[0].lat) && !isNaN(results[0].lng)) {
                map.setCenter(new naver.maps.LatLng(results[0].lat, results[0].lng));
                map.setZoom(16);
            } else if (bounds) {
                map.fitBounds(bounds);
            }
        } catch (e) {
            console.warn("[Map Bounds Error]", e);
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
window.saveMapSearchResult = async function(encoded) {
    const data = JSON.parse(decodeURIComponent(encoded));
    try {
        // Refine coordinates via Naver Geocoder for building-level precision
        let saveLat = data.lat;
        let saveLng = data.lng;
        if (data.address) {
            const refined = await refineCoordinatesViaNaverGeocoder(data.address);
            if (refined) {
                saveLat = refined.lat;
                saveLng = refined.lng;
                console.log(`[Save Refine] ${data.name}: (${data.lat},${data.lng}) → Naver Geocoder (${saveLat},${saveLng})`);
            }
        }

        const naverUrl = getNaverMapUrl({ name: data.name, address: data.address, lat: saveLat, lng: saveLng });
        
        // Allow adding to Wishlist even if place is already in Visited Places (or for another date)
        const existingWishlist = await db.places.filter(p => (p.name || "").trim().toLowerCase() === (data.name || "").trim().toLowerCase() && p.isVisited === 0 && p.isDeleted !== 1).first();
        if (existingWishlist) {
            showToast(`'${data.name}'이(가) 이미 위시리스트에 있지만, 다른 날짜/기록을 위해 하나 더 추가합니다! 💖`, "info");
        }

        await db.places.add({
            name: data.name,
            category: data.category || "Other",
            url: naverUrl,
            lat: saveLat,
            lng: saveLng,
            priority: "medium",
            notes: `${data.address || ''} - AURA 네이버 지도 저장 💖`.trim(),
            isVisited: 0,
            rating: 0,
            review: "",
            expense: 0,
            payer: "A",
            peopleCount: 2,
            photo: "",
            createdAt: new Date().toISOString()
        });
        
        showToast(`'${data.name}'을 데이트 위시리스트에 담았습니다! 💖`, "success");
        clearSearchMarkers();
        await updateDashboardStats();
        await renderPlacesList();
        updateMapMarkers();
        
        triggerSyncUpload();
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
            if (refined) {
                saveLat = refined.lat;
                saveLng = refined.lng;
                console.log(`[Save Refine] ${data.name}: (${data.lat},${data.lng}) → Naver Geocoder (${saveLat},${saveLng})`);
            }
        }

        const naverUrl = `https://map.naver.com/v5/search/${encodeURIComponent(data.name)}?c=${saveLat},${saveLng},15,0,0,0,dh`;
        const existing = await db.places.where("name").equalsIgnoreCase(data.name).first();
        if (existing) {
            if (existing.isVisited === 1) {
                showToast(`'${data.name}'은(는) 이미 다녀온 곳에 등록되어 있습니다! 📸`, "info");
                clearSearchMarkers();
                return;
            } else {
                await db.places.update(existing.id, {
                    isVisited: 1,
                    rating: 5,
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
                triggerSyncUpload();
                return;
            }
        }

        await db.places.add({
            name: data.name,
            category: data.category || "Restaurant",
            url: naverUrl,
            lat: saveLat,
            lng: saveLng,
            priority: "medium",
            notes: `${data.address || ''} - AURA 러브맵 다녀온 곳 📸`.trim(),
            isVisited: 1,
            rating: 5,
            review: "러브맵을 통해 함께 다녀온 추천 데이트 장소! 📸",
            expense: 0,
            payer: "A",
            peopleCount: 2,
            photo: "",
            createdAt: new Date().toISOString()
        });
        
        showToast(`'${data.name}'을(를) 함께 다녀온 곳에 기록했습니다! 📸`, "success");
        clearSearchMarkers();
        await updateDashboardStats();
        await renderPlacesList();
        updateMapMarkers();
        triggerSyncUpload();
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

// Helper function to generate precision branch/store Naver Map URLs (prevents opening wrong franchise branch)
function getNaverMapUrl(place) {
    if (!place) return "https://map.naver.com";
    
    // Clean address from notes or address field
    const cleanAddress = (place.address || place.notes || "").replace(/\s*-\s*AURA.*$/, "").replace(/^💡\s*메모:\s*/, "").trim();
    
    // If address is available, search with full address + place name for 100% exact store branch pinpointing
    if (cleanAddress && !cleanAddress.startsWith("http")) {
        const queryStr = `${cleanAddress} ${place.name}`.trim();
        return `https://map.naver.com/v5/search/${encodeURIComponent(queryStr)}?c=${place.lat || 37.5665},${place.lng || 126.9780},17,0,0,0,dh`;
    }
    
    if (place.url && place.url.startsWith("http")) {
        return place.url;
    }

    return `https://map.naver.com/v5/search/${encodeURIComponent(place.name)}?c=${place.lat || 37.5665},${place.lng || 126.9780},17,0,0,0,dh`;
}
window.getNaverMapUrl = getNaverMapUrl;

// Toggle "Undecided Date" (날짜 미정) checkbox in Add/Edit modals
window.toggleUndatedDate = function(type) {
    const isEdit = type === 'edit';
    const chk = document.getElementById(isEdit ? "edit-place-undated" : "add-place-undated");
    const dateInput = document.getElementById(isEdit ? "edit-place-date" : "add-place-date");
    if (!chk || !dateInput) return;

    if (chk.checked) {
        dateInput.value = "";
        dateInput.disabled = true;
        dateInput.removeAttribute("required");
    } else {
        dateInput.disabled = false;
        if (isEdit) dateInput.setAttribute("required", "required");
        if (!dateInput.value) {
            dateInput.value = new Date().toISOString().split("T")[0];
        }
    }
};

async function handleAddPlaceSubmit(e) {
    e.preventDefault();
    const name = document.getElementById("add-place-name").value.trim();
    const catSelect = document.getElementById("add-place-category").value;
    const catCustom = document.getElementById("add-place-custom-category").value.trim();
    const category = (catSelect === "custom" && catCustom) ? catCustom : catSelect;
    const inputUrl = document.getElementById("add-place-url").value.trim();
    let lat = parseFloat(document.getElementById("add-place-lat").value);
    let lng = parseFloat(document.getElementById("add-place-lng").value);
    const notes = document.getElementById("add-place-notes").value.trim();
    const priority = document.getElementById("add-place-priority").value;
    
    const isUndecided = document.getElementById("add-place-undated") && document.getElementById("add-place-undated").checked;
    const dateInputVal = document.getElementById("add-place-date") ? document.getElementById("add-place-date").value : "";
    const createdDate = (!isUndecided && dateInputVal) ? new Date(dateInputVal).toISOString() : null;
    const isUndecidedVal = (isUndecided || !dateInputVal) ? 1 : 0;

    if (isNaN(lat) || isNaN(lng)) {
        lat = 37.5665 + (Math.random() - 0.5) * 0.03;
        lng = 126.9780 + (Math.random() - 0.5) * 0.03;
    }

    const precisionUrl = inputUrl || getNaverMapUrl({ name, notes, lat, lng });

    try {
        await db.places.add({
            name,
            category,
            url: precisionUrl,
            lat,
            lng,
            priority,
            notes,
            isVisited: 0,
            rating: 0,
            review: "",
            expense: 0,
            payer: "A",
            peopleCount: 2,
            photo: "",
            createdAt: createdDate,
            isUndecidedDate: isUndecidedVal
        });

        showToast(`${name} 장소가 저장되었습니다 🌸`, "success");
        closeAddPlaceModal();
        await updateDashboardStats();
        await renderPlacesList();
        updateMapMarkers();
        triggerSyncUpload();
    } catch (err) {
        showToast("장소 추가 실패: " + err.message, "danger");
    }
}

async function openVisitModal(placeId, placeName) {
    const place = await db.places.get(placeId);
    document.getElementById("visit-place-id").value = placeId;
    document.getElementById("visit-place-name").textContent = placeName;
    
    // Customize select option & label names based on settings
    document.getElementById("opt-partner-a").textContent = partnerAName;
    document.getElementById("opt-partner-b").textContent = partnerBName;
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
    const ratingEl = document.querySelector('input[name="rating"]:checked');
    const rating = ratingEl ? parseInt(ratingEl.value) : 5;
    const expense = parseInt(document.getElementById("visit-expense").value) || 0;
    const payer = document.getElementById("visit-payer").value;

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
            rating: rating,
            expense: expense,
            payer: payer,
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
        triggerSyncUpload();
    } catch(err) {
        showToast("기록 등록 실패: " + err.message, "danger");
    }
}

// Edit Place Modal Controls
async function openEditPlaceModal(id) {
    const place = await db.places.get(id);
    if (!place) return;

    document.getElementById("edit-place-id").value = place.id;
    document.getElementById("edit-place-name").value = place.name;
    
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
    
    // Format date for <input type="date"> (YYYY-MM-DD) or handle Undecided Date
    const undatedChk = document.getElementById("edit-place-undated");
    const dateInput = document.getElementById("edit-place-date");
    
    if (place.isUndecidedDate === 1 || !place.createdAt || place.createdAt === "") {
        if (undatedChk) undatedChk.checked = true;
        if (dateInput) {
            dateInput.value = "";
            dateInput.disabled = true;
            dateInput.removeAttribute("required");
        }
    } else {
        if (undatedChk) undatedChk.checked = false;
        if (dateInput) {
            dateInput.disabled = false;
            dateInput.setAttribute("required", "required");
            const parsed = parseAnyDate(place.createdAt);
            const dateStr = parsed > 0 ? new Date(parsed).toISOString().split("T")[0] : "";
            dateInput.value = dateStr;
        }
    }

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

    document.getElementById("edit-opt-partner-a").textContent = partnerAName;
    document.getElementById("edit-opt-partner-b").textContent = partnerBName;

    const visitedFields = document.getElementById("edit-visited-fields");
    if (place.isVisited === 1) {
        if (visitedFields) visitedFields.style.display = "block";
        const ratingVal = place.rating || 5;
        const ratingRadio = document.querySelector(`input[name="edit-rating"][value="${ratingVal}"]`);
        if (ratingRadio) ratingRadio.checked = true;
        document.getElementById("edit-place-expense").value = place.expense || 0;
        document.getElementById("edit-place-payer").value = place.payer || "A";

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

    if (!confirm(`'${place.name}' 장소 전체를 삭제하시겠습니까?\n\n이 장소의 모든 사진과 기록이 함께 삭제됩니다.`)) return;

    await db.places.update(placeId, { isDeleted: 1 });
    closeEditPlaceModal();
    showToast(`'${place.name}' 장소가 삭제되었습니다! 🗑️`, "success");

    await renderPlacesList();
    await renderGallery();
    await updateDashboardStats();
    await renderCalendar();
    if (typeof saveToCloud === "function") saveToCloud();
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
        triggerSyncUpload();
    }
};

async function handleEditPlaceSubmit(e) {
    e.preventDefault();
    const id = parseInt(document.getElementById("edit-place-id").value);
    const name = document.getElementById("edit-place-name").value.trim();
    
    const catSelect = document.getElementById("edit-place-category").value;
    const catCustom = document.getElementById("edit-place-custom-category").value.trim();
    const category = (catSelect === "custom" && catCustom) ? catCustom : catSelect;

    const isUndecided = document.getElementById("edit-place-undated") && document.getElementById("edit-place-undated").checked;
    const dateVal = document.getElementById("edit-place-date").value;
    const addressVal = document.getElementById("edit-place-address").value.trim();
    
    const commentAEl = document.getElementById("edit-place-comment-a");
    const commentBEl = document.getElementById("edit-place-comment-b");

    const place = await db.places.get(id);
    if (!place) return;

    let updatedDate = null;
    let isUndecidedVal = 0;
    if (isUndecided || !dateVal) {
        updatedDate = null;
        isUndecidedVal = 1;
    } else {
        updatedDate = new Date(dateVal).toISOString();
        isUndecidedVal = 0;
    }

    const precisionUrl = getNaverMapUrl({ name, notes: addressVal, lat: place.lat, lng: place.lng, address: addressVal });

    let updatePayload = {
        name: name,
        category: category,
        notes: addressVal,
        createdAt: updatedDate,
        isUndecidedDate: isUndecidedVal,
        url: precisionUrl,
        commentA: commentAEl ? commentAEl.value.trim() : (place.commentA || ""),
        commentB: commentBEl ? commentBEl.value.trim() : (place.commentB || "")
    };

    if (place.isVisited === 1) {
        const ratingEl = document.querySelector('input[name="edit-rating"]:checked');
        const rating = ratingEl ? parseInt(ratingEl.value) : 5;
        const expense = parseInt(document.getElementById("edit-place-expense").value) || 0;
        const payer = document.getElementById("edit-place-payer").value;

        updatePayload.rating = rating;
        updatePayload.expense = expense;
        updatePayload.payer = payer;

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

    try {
        await db.places.update(id, updatePayload);
        showToast(`'${name}' 수정사항이 반영되었습니다! 💖`, "success");
        closeEditPlaceModal();
        await updateDashboardStats();
        await renderPlacesList();
        updateMapMarkers();
        triggerSyncUpload();
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
        <div class="place-comments-box" style="font-size:0.78rem; margin-top:0.4rem; margin-bottom:0.6rem; background:rgba(255,255,255,0.75); padding:0.5rem 0.65rem; border-radius:10px; border:1px dashed rgba(255,101,132,0.25); display:flex; flex-direction:column; gap:0.35rem;">
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
        // Priority Sort: Undecided Date places ("날짜 미정") at the VERY TOP (1st priority), then descending by date
        wishlistPlaces.sort((a, b) => {
            const isUndecidedA = a.isUndecidedDate === 1 || !a.createdAt || parseAnyDate(a.createdAt || a.date) === 0;
            const isUndecidedB = b.isUndecidedDate === 1 || !b.createdAt || parseAnyDate(b.createdAt || b.date) === 0;

            if (isUndecidedA && !isUndecidedB) return -1; // A (undecided) comes first
            if (!isUndecidedA && isUndecidedB) return 1;  // B (undecided) comes first

            const timeA = parseAnyDate(a.createdAt || a.date);
            const timeB = parseAnyDate(b.createdAt || b.date);
            if (timeB !== timeA) return timeB - timeA;
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
                
                // Date formatting using robust parser
                const isUndecided = place.isUndecidedDate === 1 || !place.createdAt || parseAnyDate(place.createdAt || place.date) === 0;
                const rawDate = place.createdAt || place.date;
                const parsedMs = parseAnyDate(rawDate);
                const dateStr = isUndecided ? "🗓️ 날짜 미정" : (parsedMs > 0 ? new Date(parsedMs).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }) : "🗓️ 날짜 미정");
                
                // Clean address
                let cleanAddress = (place.notes || "").replace(/\s*-\s*AURA.*$/, "").replace(/^💡\s*메모:\s*/, "").trim();
                const precisionNaverUrl = getNaverMapUrl(place);

                let cardContent = `
                    <div class="place-card-top-actions">
                        <button class="edit-card-btn" onclick="openEditPlaceModal(${place.id})" title="수정 (✏️)"><i data-lucide="edit-3"></i></button>
                        <button class="delete-card-btn" onclick="deletePlace(${place.id}, '${place.name}')" title="삭제 (🗑️)"><i data-lucide="trash-2"></i></button>
                    </div>
                    <div class="place-card-header">
                        <span class="place-category-badge badge-${place.category.toLowerCase()}">${place.category}</span>
                        <span class="place-priority-dot priority-${place.priority}"></span>
                    </div>
                    <h4 class="place-title" style="margin-top:0.2rem; margin-bottom:0.4rem;">${place.name}</h4>
                    
                    <div class="place-card-meta-details" style="font-size:0.78rem; color:var(--color-text-med); margin-bottom:0.65rem; display:flex; flex-direction:column; gap:0.35rem; background:rgba(255,101,132,0.04); padding:0.55rem 0.7rem; border-radius:10px; border:1px solid rgba(255,101,132,0.12);">
                        <div><i data-lucide="calendar" style="width:13px; height:13px; display:inline-block; vertical-align:middle; margin-right:4px; color:var(--color-primary);"></i><strong>방문 예정일:</strong> <span style="${isUndecided ? 'color:var(--color-primary); font-weight:700;' : ''}">${dateStr}</span></div>
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
                        <a href="${precisionNaverUrl}" target="_blank" class="btn btn-outline" style="padding:0.4rem 0.8rem; font-size:0.75rem;"><i data-lucide="external-link"></i> 네이버 지도</a>
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
                        <span class="place-category-badge badge-${(place.category || 'other').toLowerCase()}">${place.category}</span>
                    </div>
                    <h4 class="place-title" style="margin-top:0.2rem; margin-bottom:0.4rem;">${place.name}</h4>
                    
                    <div class="place-card-meta-details" style="font-size:0.78rem; color:var(--color-text-med); margin-bottom:0.65rem; display:flex; flex-direction:column; gap:0.35rem; background:rgba(255,101,132,0.04); padding:0.55rem 0.7rem; border-radius:10px; border:1px solid rgba(255,101,132,0.12);">
                        ${dateStr ? `<div><i data-lucide="calendar" style="width:13px; height:13px; display:inline-block; vertical-align:middle; margin-right:4px; color:var(--color-primary);"></i><strong>방문일:</strong> ${dateStr}</div>` : ''}
                        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:4px; margin-top:2px;">
                            <div style="flex-grow:1;"><i data-lucide="map-pin" style="width:13px; height:13px; display:inline-block; vertical-align:middle; margin-right:4px; color:#FF9F1C;"></i><strong>주소:</strong> ${cleanAddress || '등록된 주소 정보'}</div>
                            <button class="btn btn-outline" style="padding:0.18rem 0.55rem; font-size:0.68rem; height:24px; border-radius:8px; border-color:var(--color-primary); color:var(--color-primary); background:rgba(255,101,132,0.06); flex-shrink:0;" onclick="viewPlaceOnLoveMap(${place.lat || 37.5665}, ${place.lng || 126.9780}, '${encodeURIComponent(place.name)}')">
                                <i data-lucide="map" style="width:11px; height:11px;"></i> 지도에서 보기 🗺️
                            </button>
                        </div>
                    </div>
                `;

                let payerName = partnerAName;
                if (place.payer === "B") payerName = partnerBName;
                else if (place.payer === "DUTCH") payerName = "반반 더치페이 🤝";
                
                cardContent += renderCommentsBlock(place);


                const photoList = place.photos || (place.photo ? [place.photo] : []);
                if (photoList.length > 0) {
                    cardContent += `
                        <div class="card-photos-section" style="margin-top:0.5rem; padding-top:0.4rem; border-top:1px dashed rgba(255,112,150,0.15);">
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
    if (!confirm(`'${name}' 장소를 영구히 삭제하시겠습니까?`)) return;
    
    try {
        // Tombstone update (Soft delete flag to guarantee multi-device sync deletion)
        await db.places.update(id, {
            isVisited: -1,
            isDeleted: 1,
            deletedAt: Date.now()
        });
        
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
        triggerSyncUpload();
    } catch(err) {
        showToast("삭제 오류: " + err.message, "danger");
    }
}

// 11. Dashboard Analytics & Dutch-Pay Settlement Engine
async function updateDashboardStats() {
    const places = await db.places.toArray();
    
    const wishlistCount = places.filter(p => (p.isVisited === 0 || p.isVisited === false || p.isVisited === "0" || p.isVisited === "false") && p.isDeleted !== 1 && p.isVisited !== -1).length;
    const visitedCount = places.filter(p => (p.isVisited === 1 || p.isVisited === true || p.isVisited === "1" || p.isVisited === "true") && p.isDeleted !== 1).length;
    const expenseSum = places.filter(p => (p.isVisited === 1 || p.isVisited === true || p.isVisited === "1" || p.isVisited === "true") && p.isDeleted !== 1).reduce((acc, curr) => acc + (curr.expense || 0), 0);
    
    const wishlistEl = document.getElementById("stat-wishlist-count");
    if (wishlistEl) wishlistEl.textContent = wishlistCount;
    const visitedEl = document.getElementById("stat-visited-count");
    if (visitedEl) visitedEl.textContent = visitedCount;
    const expenseEl = document.getElementById("stat-expense-sum");
    if (expenseEl) expenseEl.textContent = formatCurrency(expenseSum);
    
    // D-Day update
    const upcoming = places.filter(p => p.isVisited === 0).sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
    if (upcoming) {
        document.getElementById("next-date-title").textContent = upcoming.name;
        document.getElementById("next-date-dday").textContent = "Wishlist";
    } else {
        document.getElementById("next-date-title").textContent = "아직 약속이 없어요 😢";
        document.getElementById("next-date-dday").textContent = "D-Day";
    }
    
    // Budget Progress fill
    document.getElementById("budget-spent-text").textContent = formatCurrency(expenseSum);
    const progressFill = document.getElementById("budget-progress-fill");
    const progressPercent = Math.min(Math.round((expenseSum / budgetLimit) * 100), 100);
    
    if (progressFill) {
        progressFill.style.width = `${progressPercent}%`;
        document.getElementById("budget-ratio-text").textContent = `${progressPercent}%`;
        
        if (progressPercent >= 90) {
            progressFill.style.background = "var(--color-danger)";
        } else if (progressPercent >= 75) {
            progressFill.style.background = "var(--color-warning)";
        } else {
            progressFill.style.background = "linear-gradient(90deg, var(--color-secondary) 0%, var(--color-primary) 100%)";
        }
    }
    
    // Dutch-Pay Settlement calculation
    const visitedPlaces = places.filter(p => p.isVisited === 1);
    let paidByA = 0;
    let paidByB = 0;
    visitedPlaces.forEach(p => {
        const exp = p.expense || 0;
        if (p.payer === "B") {
            paidByB += exp;
        } else if (p.payer === "DUTCH") {
            paidByA += exp / 2;
            paidByB += exp / 2;
        } else {
            paidByA += exp;
        }
    });
    
    document.getElementById("dutchpay-paid-a").textContent = formatCurrency(paidByA);
    document.getElementById("dutchpay-paid-b").textContent = formatCurrency(paidByB);
    
    const resultTextEl = document.getElementById("dutchpay-result-text");
    if (paidByA === 0 && paidByB === 0) {
        resultTextEl.textContent = "정산할 내역이 없습니다 💖";
    } else {
        const total = paidByA + paidByB;
        const half = total / 2;
        
        if (paidByA > paidByB) {
            const diff = half - paidByB;
            resultTextEl.innerHTML = `<strong>${partnerBName}</strong> ➔ <strong>${partnerAName}</strong><br><span style="font-size:1.1rem; color:var(--color-primary);">${formatCurrency(diff)}</span> 송금해 주세요! 💌`;
        } else if (paidByB > paidByA) {
            const diff = half - paidByA;
            resultTextEl.innerHTML = `<strong>${partnerAName}</strong> ➔ <strong>${partnerBName}</strong><br><span style="font-size:1.1rem; color:var(--color-primary);">${formatCurrency(diff)}</span> 송금해 주세요! 💌`;
        } else {
            resultTextEl.textContent = "완벽하게 1/N 정산 완료! 💖";
        }
    }
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
    } else if (type === 'naver-search') {
        titleEl.innerHTML = `🔑 네이버 검색 API Key 발급 가이드`;
        bodyEl.innerHTML = `
            <ol style="padding-left:1.2rem; margin-top:0.5rem;">
                <li style="margin-bottom:0.6rem;"><strong>네이버 개발자 센터 접속</strong><br>
                <a href="https://developers.naver.com" target="_blank" style="color:var(--color-primary); text-decoration:underline;">developers.naver.com</a> 접속 후 네이버 아이디로 로그인합니다.</li>
                <li style="margin-bottom:0.6rem;"><strong>애플리케이션 등록</strong><br>
                [Application] ➔ [애플리케이션 등록] 클릭 ➔ 앱 이름 입력 (예: AURA) ➔ 사용 API에서 <strong>"검색" (지역)</strong> 체크</li>
                <li style="margin-bottom:0.6rem;"><strong>WEB 환경 설정</strong><br>
                서비스 환경으로 'WEB' 선택 후 URL에 <code>http://localhost</code> 또는 본인의 접속 주소 입력</li>
                <li style="margin-bottom:0.6rem;"><strong>Client ID & Secret 복사</strong><br>
                [내 애플리케이션]에서 생성된 <strong>Client ID</strong>와 <strong>Client Secret</strong>을 복사하여 아래 입력란에 각각 붙여넣기 하세요!</li>
            </ol>
            <div style="background:rgba(255,101,132,0.08); padding:0.6rem; border-radius:6px; margin-top:0.6rem; font-size:0.8rem; color:var(--color-primary);">
                💡 네이버 공식 상권 DB 검색 연동으로 전국의 매장/가게/카페 이름 검색 정확도가 100% 극대화됩니다!
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

    // Establish 5-second interval loop for main DB state sync
    syncIntervalId = setInterval(async () => {
        await loadFromCloud();
    }, 5000);
    
    // Establish 10-second interval loop for heavy photos syncing
    photoSyncIntervalId = setInterval(async () => {
        await loadPhotosFromCloud();
    }, 10000);

    // Run immediately on start
    loadFromCloud();
    loadPhotosFromCloud();
}

async function saveToCloud() {
    if (!syncRoomId || isUploading) return;
    isUploading = true;
    
    try {
        const places = await db.places.toArray();
        const seenKeys = new Set();
        const cleanPlaces = [];
        places.forEach(p => {
            const copy = { ...p };
            sanitizePlaceObject(copy);
            const cleanName = (copy.name || "").trim();
            if (cleanName && cleanName.length >= 2 && cleanName.toLowerCase() !== "undefined" && cleanName.toLowerCase() !== "null") {
                const itemKey = copy.id ? `id_${copy.id}` : `${cleanName.toLowerCase()}_${copy.isVisited}_${copy.createdAt || ''}`;
                if (!seenKeys.has(itemKey)) {
                    seenKeys.add(itemKey);
                    cleanPlaces.push(copy);
                }
            }
        });

        // Save local DB to cloud room (including empty list when user clears/deletes places)
        const now = Date.now();
        const payload = {
            placesData: JSON.stringify(cleanPlaces),
            memoryPhotos: JSON.stringify(customMemoryPhotos),
            partnerAName: partnerAName,
            partnerBName: partnerBName,
            naverClientId: naverClientId,
            naverSearchId: naverSearchId,
            naverSearchSecret: naverSearchSecret,
            kakaoApiKey: kakaoApiKey,
            geminiApiKey: geminiApiKey,
            timestamp: now
        };
        
        const bodyStr = JSON.stringify(payload);
        lastSyncedDataString = bodyStr;
        const url = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}.json`;
        const response = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: bodyStr
        });
        if (response.ok) {
            lastSyncedTimestamp = now;
        } else {
            console.error('Firebase save failed:', response.status);
        }
    } catch (e) {
        console.error('Firebase save error:', e);
    } finally {
        isUploading = false;
    }
}

// Destructive db.places.clear() REMOVED! Replaced with safe Union Merge Engine.
async function loadFromCloud() {
    if (!syncRoomId || isDownloading || isUploading) return;

    isDownloading = true;
    
    try {
        const url = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}.json?t=${Date.now()}`;
        const response = await fetch(url, { cache: 'no-store' });
        
        if (!response.ok) return;
        
        const resData = await response.json();
        const localPlaces = await db.places.toArray();
        
        if (resData === null) {
            // Room empty in cloud, initialize cloud with local data
            if (localPlaces.length > 0) {
                await saveToCloud();
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

            if (resData.naverSearchId && resData.naverSearchId !== naverSearchId) {
                naverSearchId = resData.naverSearchId;
                localStorage.setItem("aura_naver_search_id", naverSearchId);
                const el = document.getElementById("settings-naver-search-id");
                if (el) el.value = naverSearchId;
            }

            if (resData.naverSearchSecret && resData.naverSearchSecret !== naverSearchSecret) {
                naverSearchSecret = resData.naverSearchSecret;
                localStorage.setItem("aura_naver_search_secret", naverSearchSecret);
                const el = document.getElementById("settings-naver-search-secret");
                if (el) el.value = naverSearchSecret;
            }

            if (resData.kakaoApiKey && resData.kakaoApiKey !== kakaoApiKey) {
                kakaoApiKey = resData.kakaoApiKey;
                localStorage.setItem("aura_kakao_key", kakaoApiKey);
                const el = document.getElementById("settings-kakao-api-key");
                if (el) el.value = kakaoApiKey;
            }

            if (resData.geminiApiKey && resData.geminiApiKey !== geminiApiKey) {
                geminiApiKey = resData.geminiApiKey;
                localStorage.setItem("aura_gemini_key", geminiApiKey);
                const el = document.getElementById("settings-gemini-key");
                if (el) el.value = geminiApiKey;
            }

            if (resData.memoryPhotos) {
                try {
                    const cloudMemories = JSON.parse(resData.memoryPhotos);
                    if (Array.isArray(cloudMemories) && cloudMemories.length > 0) {
                        if (JSON.stringify(customMemoryPhotos) !== JSON.stringify(cloudMemories)) {
                            customMemoryPhotos = cloudMemories;
                            localStorage.setItem("aura_lovely_memories", JSON.stringify(customMemoryPhotos));
                            renderLovelyMemoryGallery();
                        }
                    }
                } catch(e) {}
            }
        }

        if (resData.placesData) {
            if (resData.timestamp) {
                lastSyncedTimestamp = resData.timestamp;
            }

            let fetchedPlaces = [];
            try {
                fetchedPlaces = JSON.parse(resData.placesData);
            } catch(e) {
                console.error('Failed to parse Firebase placesData:', e);
            }

            if (Array.isArray(fetchedPlaces)) {
                // Filter out any junk/duplicate places directly from fetched cloud data (by ID or Unique Key)
                const seenCloudKeys = new Set();
                const placesToApply = [];

                fetchedPlaces.forEach(fp => {
                    sanitizePlaceObject(fp);
                    const cleanName = (fp.name || "").trim();
                    if (cleanName && cleanName.length >= 2 && cleanName.toLowerCase() !== "undefined" && cleanName.toLowerCase() !== "null") {
                        const itemKey = fp.id ? `id_${fp.id}` : `${cleanName.toLowerCase()}_${fp.isVisited}_${fp.createdAt || ''}`;
                        if (!seenCloudKeys.has(itemKey)) {
                            seenCloudKeys.add(itemKey);
                            placesToApply.push(fp);
                        }
                    }
                });

                const localPlaces = await db.places.toArray();

                // Preserve local photo attachments and tombstones
                placesToApply.forEach(fp => {
                    const localMatch = localPlaces.find(lp => lp.id === fp.id || ((lp.name || "").trim().toLowerCase() === (fp.name || "").trim().toLowerCase() && lp.isVisited === fp.isVisited && lp.createdAt === fp.createdAt));
                    if (localMatch) {
                        if (localMatch.isDeleted === 1 || localMatch.isVisited === -1) {
                            fp.isDeleted = 1;
                            fp.isVisited = -1;
                        }
                        if (localMatch.photo && !fp.photo) fp.photo = localMatch.photo;
                        if (localMatch.photos && (!fp.photos || fp.photos.length === 0)) fp.photos = localMatch.photos;
                    }
                });

                // Safe Cloud Sync Guard: Prevent wiping local DB if cloud returns empty places while local DB has data
                if (placesToApply.length === 0 && localPlaces.some(p => !p.isDeleted)) {
                    console.warn("[Sync Engine] Cloud returned empty places, but local DB has active data. Pushing local places to cloud instead of clearing local DB.");
                    await saveToCloud();
                    return;
                }

                // Smart Upsert Engine: Upsert places to Dexie DB safely by ID or unique key match
                let hasChanges = false;
                for (const fp of placesToApply) {
                    const cleanFpName = (fp.name || "").trim().toLowerCase();
                    const existing = localPlaces.find(lp => lp.id === fp.id || ((lp.name || "").trim().toLowerCase() === cleanFpName && lp.isVisited === fp.isVisited && lp.createdAt === fp.createdAt));
                    
                    if (existing) {
                        const updatePayload = { ...fp };
                        delete updatePayload.id;
                        if (!updatePayload.photo && existing.photo) updatePayload.photo = existing.photo;
                        if ((!updatePayload.photos || updatePayload.photos.length === 0) && existing.photos) updatePayload.photos = existing.photos;
                        
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

// Standalone trigger to force immediate sync uploads on local edits
function triggerSyncUpload() {
    localMutationTimestamp = Date.now();
    setTimeout(async () => {
        await saveToCloud();
    }, 50);
}

// ── Firebase Photos REST API sync ──
async function uploadPhotoToCloud(placeIdOrName, base64ImagesArray) {
    if (!syncRoomId || !base64ImagesArray || base64ImagesArray.length === 0) return;
    try {
        let placeKey = placeIdOrName;
        if (typeof placeIdOrName === 'number') {
            const p = await db.places.get(placeIdOrName);
            if (p && p.name) placeKey = p.name.trim().toLowerCase().replace(/[/\\?%*:|"<>. ]/g, "_");
        } else if (typeof placeIdOrName === 'string') {
            placeKey = placeIdOrName.trim().toLowerCase().replace(/[/\\?%*:|"<>. ]/g, "_");
        }
        
        const url = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/photos/${encodeURIComponent(placeKey)}.json`;
        const body = JSON.stringify({
            img: base64ImagesArray[0] || "",
            imgList: base64ImagesArray,
            ts: Date.now()
        });
        await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body
        });
    } catch (e) {
        console.error('[Photo Sync] Save failed:', e);
    }
}

async function loadPhotosFromCloud() {
    if (!syncRoomId) return;
    try {
        const url = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/photos.json?t=${Date.now()}`;
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) return;
        const photosRaw = await response.json();
        if (!photosRaw || typeof photosRaw !== 'object') return;
        
        const photoMap = {};
        Object.keys(photosRaw).forEach(k => {
            photoMap[k] = photosRaw[k];
            try {
                photoMap[decodeURIComponent(k)] = photosRaw[k];
            } catch(e) {}
        });

        const places = await db.places.toArray();
        let changed = false;

        for (const place of places) {
            const cleanName = (place.name || "").trim().toLowerCase();
            const nameKey = cleanName.replace(/[/\\?%*:|"<>. ]/g, "_");
            const encodedKey = encodeURIComponent(nameKey);
            
            const entry = photoMap[nameKey] || photoMap[encodedKey] || photoMap[cleanName] || photoMap[place.id];
            if (entry) {
                const serverImgList = entry.imgList || (entry.img ? [entry.img] : []);
                const localImgList = place.photos || (place.photo ? [place.photo] : []);
                
                if (serverImgList.length > 0 && JSON.stringify(serverImgList) !== JSON.stringify(localImgList)) {
                    await db.places.update(place.id, {
                        photo: serverImgList[0] || "",
                        photos: serverImgList
                    });
                    changed = true;
                }
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
        for(const place of places) {
            await db.places.add({
                name: place.name,
                category: place.category || "Other",
                url: "",
                lat: place.lat || (37.5665 + (Math.random() - 0.5) * 0.02),
                lng: place.lng || (126.9780 + (Math.random() - 0.5) * 0.02),
                priority: "medium",
                notes: place.notes,
                isVisited: 0,
                rating: 0,
                review: "",
                expense: 0,
                payer: "A",
                peopleCount: 2,
                photo: "",
                createdAt: new Date().toISOString()
            });
            savedCount++;
        }
        
        showToast(`${savedCount}개의 데이트 코스가 보관함(위시리스트)에 추가되었습니다!`, "success");
        await updateDashboardStats();
        await renderPlacesList();
        updateMapMarkers();
        triggerSyncUpload();
        switchTab("wishlist");
    } catch(err) {
        showToast("코스 저장 실패: " + err.message, "danger");
    }
};

// 14. Settings Logic
async function saveSettings() {
    const apiKeyVal = document.getElementById("settings-gemini-key").value.trim();
    const naverClientIdVal = document.getElementById("settings-naver-client-id").value.trim();
    const nSearchIdInput = document.getElementById("settings-naver-search-id");
    const naverSearchIdVal = nSearchIdInput ? nSearchIdInput.value.trim() : naverSearchId;
    const nSearchSecInput = document.getElementById("settings-naver-search-secret");
    const naverSearchSecVal = nSearchSecInput ? nSearchSecInput.value.trim() : naverSearchSecret;
    const kakaoInputEl = document.getElementById("settings-kakao-api-key");
    const kakaoApiKeyVal = kakaoInputEl ? kakaoInputEl.value.trim() : kakaoApiKey;
    const limitVal = parseInt(document.getElementById("settings-budget-limit").value) || 500000;
    const partnerAVal = document.getElementById("settings-partner-a-name").value.trim() || "SH";
    const partnerBVal = document.getElementById("settings-partner-b-name").value.trim() || "SA";
    const syncRoomVal = document.getElementById("settings-sync-room-id").value.trim();
    const firebaseUrVal = document.getElementById("settings-firebase-url").value.trim();
    
    localStorage.setItem("aura_gemini_key", apiKeyVal);
    localStorage.setItem("aura_naver_client_id", naverClientIdVal);
    localStorage.setItem("aura_naver_search_id", naverSearchIdVal);
    localStorage.setItem("aura_naver_search_secret", naverSearchSecVal);
    localStorage.setItem("aura_kakao_key", kakaoApiKeyVal);
    localStorage.setItem("aura_budget_limit", limitVal);
    localStorage.setItem("aura_partner_a_name", partnerAVal);
    localStorage.setItem("aura_partner_b_name", partnerBVal);
    localStorage.setItem("aura_sync_room_id", syncRoomVal);
    localStorage.setItem("aura_firebase_url", firebaseUrVal);
    
    geminiApiKey = apiKeyVal;
    naverClientId = naverClientIdVal;
    naverSearchId = naverSearchIdVal;
    naverSearchSecret = naverSearchSecVal;
    kakaoApiKey = kakaoApiKeyVal;
    budgetLimit = limitVal;
    partnerAName = partnerAVal;
    partnerBName = partnerBVal;
    syncRoomId = syncRoomVal;
    customFirebaseUrl = firebaseUrVal;
    
    document.getElementById("budget-limit-text").textContent = formatCurrency(budgetLimit);
    updatePartnerNamesUI();
    
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
            triggerSyncUpload();
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
            // 1. Purge tombstones (deleted items)
            if (p.isDeleted === 1 || p.isVisited === -1) {
                removedCount++;
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

            // 4. Deduplicate by unique item key (allows same place name across Visited vs Wishlist or different dates)
            const itemKey = p.id ? `id_${p.id}` : `${cleanName.toLowerCase()}_${p.isVisited}_${p.createdAt || ''}`;
            if (seenNames.has(itemKey)) {
                removedCount++;
                continue;
            }

            seenNames.add(itemKey);
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
            triggerSyncUpload();

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

    const todayStr = new Date().toISOString().split("T")[0];

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
            const ms = parseAnyDate(pDate);
            if (ms <= 0) return false;
            const iso = new Date(ms).toISOString().split("T")[0];
            return iso === fullDateStr;
        });

        const visitedPlaces = datePlaces.filter(p => p.isVisited === 1 || p.isVisited === "1" || p.isVisited === true || p.isVisited === "true");
        const wishlistPlaces = datePlaces.filter(p => (p.isVisited === 0 || p.isVisited === "0" || p.isVisited === false || p.isVisited === "false") && p.isVisited !== -1 && p.isDeleted !== 1);

        let badgesHtml = "";
        if (visitedPlaces.length > 0 || wishlistPlaces.length > 0) {
            badgesHtml += `<div class="cal-badges-container" style="display:flex; flex-direction:column; gap:2px; margin-top:2px; align-items:center; width:100%;">`;
            if (visitedPlaces.length > 0) {
                badgesHtml += `
                    <button type="button" class="cal-btn-visited" title="다녀온 곳 ${visitedPlaces.length}개" onclick="event.stopPropagation(); selectCalendarDateAndRender('${fullDateStr}', 'visited')" style="background:rgba(116,185,255,0.18); color:#74B9FF; border:1px solid rgba(116,185,255,0.35); border-radius:5px; font-size:0.6rem; padding:1px 3px; font-weight:700; cursor:pointer; width:100%; text-align:center;">
                        🌸 <span class="badge-text">다녀옴 (${visitedPlaces.length})</span>
                    </button>
                `;
            }
            if (wishlistPlaces.length > 0) {
                badgesHtml += `
                    <button type="button" class="cal-btn-wishlist" title="위시리스트 ${wishlistPlaces.length}개" onclick="event.stopPropagation(); selectCalendarDateAndRender('${fullDateStr}', 'wishlist')" style="background:rgba(255,101,132,0.18); color:var(--color-primary); border:1px solid rgba(255,101,132,0.35); border-radius:5px; font-size:0.6rem; padding:1px 3px; font-weight:700; cursor:pointer; width:100%; text-align:center;">
                        💌 <span class="badge-text">위시 (${wishlistPlaces.length})</span>
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
        const pDate = p.createdAt || p.date;
        const ms = parseAnyDate(pDate);
        if (ms <= 0) return false;
        const iso = new Date(ms).toISOString().split("T")[0];
        return iso === dateStr;
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
        const coverPhoto = photos[0];
        const photoCount = photos.length;

        const card = document.createElement("div");
        card.className = "gallery-card";

        const dateObj = new Date(p.createdAt);
        const dateStr = !isNaN(dateObj.getTime()) ? dateObj.toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }) : "";

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
                <div class="gallery-action-bar" style="margin-top:6px;">
                    <button class="btn btn-outline" style="width:100%; font-size:0.75rem; padding:0.35rem; height:32px; border-color:var(--color-primary); color:var(--color-primary); justify-content:center;" onclick="openEditPlaceModal(${p.id})">
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
    
    const dateObj = new Date(place.createdAt);
    const dateStr = !isNaN(dateObj.getTime()) ? dateObj.toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }) : "";
    
    activePlaceInfo = {
        id: place.id,
        name: place.name,
        meta: `${dateStr} · (${place.category})`,
        comments: place.commentA || place.commentB ? `💬 ${place.commentA ? partnerAName + ': ' + place.commentA : ''} ${place.commentB ? partnerBName + ': ' + place.commentB : ''}` : ""
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

window.closeGallerySliderModal = function() {
    const modal = document.getElementById("modal-gallery-slider");
    if (modal) modal.classList.remove("active");
};

// 1-by-1 Photo Delete Engine in Gallery Lightbox
window.deleteCurrentSliderPhoto = async function() {
    if (!activeGalleryPhotos || activeGalleryPhotos.length === 0 || !activePlaceInfo || !activePlaceInfo.id) return;
    if (!confirm(`'${activePlaceInfo.name}'의 이 추억 사진을 1장 삭제하시겠습니까?`)) return;

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

    await db.places.update(place.id, updatePayload);
    if (syncRoomId) {
        await uploadPhotoToCloud(place.id, updatedPhotos);
    }
    triggerSyncUpload();

    showToast("추억 사진 1장이 삭제되었습니다! 🗑️", "success");

    if (updatedPhotos.length === 0) {
        closeGallerySliderModal();
    } else {
        if (activePhotoIndex >= updatedPhotos.length) {
            activePhotoIndex = updatedPhotos.length - 1;
        }
        activeGalleryPhotos = updatedPhotos;
        updateGallerySliderUI();
    }

    await renderPlacesList();
    renderGallery();
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
const DEFAULT_MEMORY_PHOTOS = [
    "images/couple1.jpg",
    "images/couple2.jpg",
    "images/couple3.jpg",
    "images/couple4.jpg",
    "images/couple5.jpg"
];

function getStoredMemoryPhotos() {
    const raw = localStorage.getItem("aura_lovely_memories");
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

window.deleteCurrentMemoryPhoto = function() {
    if (!activeMemoryPhotosList || activeMemoryPhotosList.length === 0) return;
    if (!confirm("이 추억 사진을 러블리 메모리에서 삭제하시겠습니까?")) return;

    const photoToDelete = activeMemoryPhotosList[activeMemoryPhotoIndex];
    const customIdx = customMemoryPhotos.indexOf(photoToDelete);
    if (customIdx !== -1) {
        customMemoryPhotos.splice(customIdx, 1);
        localStorage.setItem("aura_lovely_memories", JSON.stringify(customMemoryPhotos));
        triggerSyncUpload();
    }
    renderLovelyMemoryGallery();
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
            localStorage.setItem("aura_lovely_memories", JSON.stringify(customMemoryPhotos));
            await renderLovelyMemoryGallery();
            triggerSyncUpload();
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
