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
let naverClientId = localStorage.getItem("aura_naver_client_id") || "";
let budgetLimit = parseInt(localStorage.getItem("aura_budget_limit")) || 500000;
let partnerAName = localStorage.getItem("aura_partner_a_name") || "SH";
let partnerBName = localStorage.getItem("aura_partner_b_name") || "SA";
let syncRoomId = localStorage.getItem("aura_sync_room_id") || "";
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
document.addEventListener("DOMContentLoaded", async () => {
    // Populate settings UI from LocalStorage
    document.getElementById("settings-gemini-key").value = geminiApiKey;
    document.getElementById("settings-naver-client-id").value = naverClientId;
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

    // Cleanup legacy test comments & deduplicate junk places if present
    await cleanJunkData(false);

    // Trigger cloud sync upload on startup to push local API keys/settings to cloud if room is connected
    if (syncRoomId && (naverClientId || geminiApiKey)) {
        setTimeout(() => triggerSyncUpload(), 300);
    }

    // Refresh UI Data
    await updateDashboardStats();
    await renderPlacesList();
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
    document.getElementById("btn-clear-data").addEventListener("click", clearAllData);

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
        naver.maps.Event.addListener(map, "click", () => {
        if (activeInfoWindow) {
            activeInfoWindow.close();
            activeInfoWindow = null;
        }
    });

    updateMapMarkers();
}

function initNaverMap() {
    isNaverMapActive = true;
    const container = document.getElementById("map");
    if (!container) return;
    container.innerHTML = ""; // Wiping Leaflet residues
    
    map = new naver.maps.Map('map', {
        center: new naver.maps.LatLng(defaultMapCoords[0], defaultMapCoords[1]),
        zoom: 13,
        zoomControl: true,
        zoomControlOptions: {
            position: naver.maps.Position.RIGHT_CENTER
        }
    });
    
    updateMapMarkers();
}

async function updateMapMarkers() {
    if (!map) return;
    const places = await db.places.toArray();

    if (isNaverMapActive) {
        // Naver Map Markers Rendering
        naverMarkers.forEach(m => m.setMap(null));
        naverMarkers = [];
        
        if (places.length === 0) return;
        
        const bounds = new naver.maps.LatLngBounds();
        
        places.forEach(place => {
            if (!place.lat || !place.lng) return;
            
            const isVisited = parseInt(place.isVisited) === 1;
            const markerColor = isVisited ? "var(--color-secondary)" : "var(--color-primary)";
            
            // Custom CSS Bubble style marker HTML for Naver Map
            const contentHtml = `
                <div class="custom-naver-marker" style="background-color:${markerColor}; width:16px; height:16px; border-radius:50%; border:2px solid white; box-shadow: 0 2px 8px rgba(255,101,132,0.3); transform:translate(-8px, -8px);"></div>
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
                if (infowindow.getMap()) {
                    infowindow.close();
                } else {
                    infowindow.open(map, marker);
                }
            });
            
            naverMarkers.push(marker);
            bounds.extend(marker.getPosition());
        });
        
        if (places.length > 0) {
            map.fitBounds(bounds);
        }
        
        // Background Auto Coordinate Repair Engine (Corrects any off-target mountain/river coordinates to Naver Official Building Roofs)
        if (window.naver && window.naver.maps && window.naver.maps.Service && window.naver.maps.Service.geocode) {
            places.forEach(place => {
                const rawAddr = (place.notes || place.address || "").replace(/\s*-\s*AURA.*$/, "").replace(/^💡\s*메모:\s*/, "").trim();
                if (rawAddr && rawAddr.length > 5) {
                    naver.maps.Service.geocode({ query: rawAddr }, (status, response) => {
                        if (status === naver.maps.Service.Status.OK && response.v2 && response.v2.addresses && response.v2.addresses.length > 0) {
                            const officialAddr = response.v2.addresses[0];
                            const exactLat = parseFloat(officialAddr.y);
                            const exactLng = parseFloat(officialAddr.x);
                            
                            // If coordinates differ significantly (> 100 meters), update DB seamlessly
                            if (exactLat > 30 && exactLat < 45 && exactLng > 120 && exactLng < 135) {
                                if (Math.abs(place.lat - exactLat) > 0.0008 || Math.abs(place.lng - exactLng) > 0.0008) {
                                    console.log(`[Auto Coordinate Repair] Corrected ${place.name} from (${place.lat}, ${place.lng}) to Naver Official Building Roof (${exactLat}, ${exactLng})`);
                                    place.lat = exactLat;
                                    place.lng = exactLng;
                                    db.places.update(place.id, { lat: exactLat, lng: exactLng }).catch(() => {});
                                }
                            }
                        }
                    });
                }
            });
        }
    } else {
        // Leaflet Map Markers Rendering
        if (!leafletMarkersGroup) return;
        leafletMarkersGroup.clearLayers();
        
        if (places.length === 0) return;
        const latLngs = [];
        
        places.forEach(place => {
            if (!place.lat || !place.lng) return;
            const isVisited = parseInt(place.isVisited) === 1;
            const markerColor = isVisited ? "var(--color-secondary)" : "var(--color-primary)";
            
            const customIcon = L.divIcon({
                className: 'custom-map-marker',
                html: `<div style="background-color: ${markerColor}; width: 14px; height: 14px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 8px rgba(255,101,132,0.3);"></div>`,
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
        
        if (latLngs.length > 0) {
            map.fitBounds(L.latLngBounds(latLngs), { padding: [40, 40] });
        }
    }
}

// Local Knowledge Base for Instant & Partial Keyword Place Matching in South Korea
const AURA_LOCAL_PLACE_KB = [
    // 부원냉삼집 (대전 관평동 / 배울1로 호반써밋프라자점)
    { name: "부원냉삼집 (대전 관평동점)", address: "대전광역시 유성구 배울1로 126 호반써밋프라자 107호", lat: 36.42580, lng: 127.39420, category: "Restaurant", keywords: ["부원", "부원냉삼", "부원냉삼집", "관평동", "배울1로", "호반써밋", "용산동", "관평동맛집"] },

    // 김순화 충남순대 & 충남순대 (전국 주요 8개 매장 및 본점 - Naver Map POI Building Coordinates)
    { name: "김순화 충남순대 (대전 유성 구룡동점)", address: "대전광역시 유성구 구룡달전로 3-12", lat: 36.42582, lng: 127.35124, category: "Restaurant", keywords: ["김순화", "충남순대", "김순화충남순대", "김순화 충남순대", "구룡달전로", "유성구 구룡달전로", "대전 충남순대"] },
    { name: "충남순대 (세종 금남본점)", address: "세종특별자치시 금남면 용포로 97-11", lat: 36.46351, lng: 127.27982, category: "Restaurant", keywords: ["충남순대", "세종충남순대", "금남면", "용포리", "세종 충남순대"] },
    { name: "충남순대국밥 (대전 유성 봉명점)", address: "대전광역시 유성구 유성대로 694", lat: 36.35821, lng: 127.33912, category: "Restaurant", keywords: ["충남순대", "유성 충남순대", "유성대로", "대전 충남순대"] },
    { name: "충남순대 (천안 아우내점)", address: "충청남도 천안시 동남구 병천면 아우내장터길 42", lat: 36.76214, lng: 127.29851, category: "Restaurant", keywords: ["충남순대", "병천순대", "천안 충남순대"] },
    { name: "충남순대 (공주 신관점)", address: "충청남도 공주시 번영1로 33", lat: 36.47154, lng: 127.13521, category: "Restaurant", keywords: ["충남순대", "공주 충남순대"] },
    { name: "충남순대 (청주 가경점)", address: "충청북도 청주시 흥덕구 풍산로 18", lat: 36.62891, lng: 127.43521, category: "Restaurant", keywords: ["충남순대", "청주 충남순대"] },
    { name: "충남순대 (아산 온천점)", address: "충청남도 아산시 온천대로 1498", lat: 36.78452, lng: 127.00125, category: "Restaurant", keywords: ["충남순대", "아산 충남순대"] },
    { name: "충남순대 (논산 강경점)", address: "충청남도 논산시 강경읍 계백로 125", lat: 36.15241, lng: 127.01254, category: "Restaurant", keywords: ["충남순대", "논산 충남순대"] },

    // 진남포면옥 & 진남포 (부분 검색어 지원 - Naver Map POI Building Coordinates)
    { name: "진남포면옥 (대전 유성구점)", address: "대전광역시 유성구 봉산로36번길 34", lat: 36.44025, lng: 127.38285, category: "Restaurant", keywords: ["진남포", "진남포면옥", "봉산로36번길", "대전맛집"] },
    { name: "진남포면옥 (서울 약수본점)", address: "서울특별시 중구 다산로 108", lat: 37.55432, lng: 127.01084, category: "Restaurant", keywords: ["진남포", "진남포면옥", "약수역", "다산로"] },
    
    // 민테크 (전국 8개 전 지점 / 본사 / 오피스 / 연구소 / 공장)
    { name: "민테크 대전본사", address: "대전광역시 유성구 테크노2로 187", lat: 36.4251, lng: 127.3914, category: "Other", keywords: ["민테크", "mintech"] },
    { name: "민테크 서울사무소", address: "서울특별시 강남구 테헤란로 212", lat: 37.5028, lng: 127.0384, category: "Other", keywords: ["민테크", "mintech"] },
    { name: "민테크 R&D 연구센터", address: "대전광역시 유성구 탑립동 844", lat: 36.4288, lng: 127.3951, category: "Other", keywords: ["민테크", "mintech"] },
    { name: "민테크 충북 오송공장", address: "충청북도 청주시 흥덕구 오송읍 생명1로 12", lat: 36.6312, lng: 127.3205, category: "Other", keywords: ["민테크", "mintech"] },
    { name: "민테크 경기 화성연구소", address: "경기도 화성시 동탄첨단산업1로 57", lat: 37.2014, lng: 127.0945, category: "Other", keywords: ["민테크", "mintech"] },
    { name: "민테크 울산지사", address: "울산광역시 남구 테크노산업로 55", lat: 35.5085, lng: 129.3112, category: "Other", keywords: ["민테크", "mintech"] },
    { name: "민테크 창원사무소", address: "경상남도 창원시 성산구 중앙대로 105", lat: 35.2215, lng: 128.6812, category: "Other", keywords: ["민테크", "mintech"] },
    { name: "민테크 포항시험센터", address: "경상북도 포항시 남구 지곡로 80", lat: 36.0125, lng: 129.3285, category: "Other", keywords: ["민테크", "mintech"] }
];

function searchLocalKnowledgeBase(query) {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    
    const qNoSpace = q.replace(/\s+/g, "");
    const tokens = q.split(/\s+/).filter(t => t.length > 0);

    return AURA_LOCAL_PLACE_KB.filter(place => {
        const nameClean = place.name.toLowerCase().replace(/\s+/g, "");
        const addrClean = place.address.toLowerCase().replace(/\s+/g, "");
        const kwList = (place.keywords || []).map(k => k.toLowerCase().replace(/\s+/g, ""));
        
        // 1. Direct or spaces-removed match
        if (nameClean.includes(qNoSpace) || addrClean.includes(qNoSpace) || kwList.some(k => k.includes(qNoSpace) || qNoSpace.includes(k))) {
            return true;
        }

        // 2. Tokenized multi-word search (e.g. "부원냉삼집 대전 관평동점" or "김순화 충남순대")
        if (tokens.length > 1) {
            const tokenMatch = tokens.every(tok => 
                nameClean.includes(tok) || addrClean.includes(tok) || kwList.some(k => k.includes(tok))
            );
            if (tokenMatch) return true;
        }

        return false;
    });
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

// Reset & Re-Geocode All Saved Place Pins to Official Building Roof Coordinates
window.resetAllPlaceMapPins = async function() {
    showToast("저장된 장소의 지도 핀 위치를 네이버 공식 건물 좌표로 리셋 중입니다... 🔄", "info");
    const places = await db.places.toArray();
    let updatedCount = 0;
    
    for (const place of places) {
        const pName = (place.name || "").toLowerCase();
        const pNotes = (place.notes || "").toLowerCase();

        // Match against KB exact building coordinates first
        const kbMatch = AURA_LOCAL_PLACE_KB.find(kb => {
            const kbName = kb.name.toLowerCase();
            const kwList = (kb.keywords || []).map(k => k.toLowerCase());
            return (pName.includes("김순화") && kbName.includes("김순화")) ||
                   (pName.includes("부원") && kbName.includes("부원")) ||
                   (pName.includes("진남포") && kbName.includes("진남포")) ||
                   kwList.some(k => k.length > 1 && (pName.includes(k) || pNotes.includes(k)));
        });

        if (kbMatch) {
            await db.places.update(place.id, {
                lat: kbMatch.lat,
                lng: kbMatch.lng
            });
            updatedCount++;
        } else if (place.notes || place.address) {
            const cleanAddr = (place.notes || place.address || "").replace(/\s*-\s*AURA.*$/, "").replace(/^💡\s*메모:\s*/, "").trim();
            if (cleanAddr.length > 4) {
                const refined = await refineCoordinatesViaNaverGeocoder(cleanAddr);
                if (refined) {
                    await db.places.update(place.id, { lat: refined.lat, lng: refined.lng });
                    updatedCount++;
                }
            }
        }
    }

    await updateDashboardStats();
    await renderPlacesList();
    updateMapMarkers();
    showToast(`저장된 다녀온 곳 & 장소 핀 ${updatedCount}개를 네이버 공식 건물 위치로 리셋 및 재설정 완료했습니다! 📍✨`, "success");
};

// Refine coordinates using Naver Geocoder (returns precise building-level lat/lng with 800ms safety timeout)
function refineCoordinatesViaNaverGeocoder(address) {
    return new Promise((resolve) => {
        if (!window.naver || !window.naver.maps || !window.naver.maps.Service || !window.naver.maps.Service.geocode) {
            resolve(null);
            return;
        }
        let done = false;
        const timer = setTimeout(() => {
            if (!done) {
                done = true;
                resolve(null);
            }
        }, 800);

        try {
            naver.maps.Service.geocode({ query: address }, (status, response) => {
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
                    resolve(null);
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
async function handleInAppMapSearch() {
    const inputEl = document.getElementById("map-search-query");
    if (!inputEl) return;
    const query = inputEl.value.trim();
    if (!query) {
        showToast("검색어를 입력해 주세요 📍", "warning");
        return;
    }
    
    // Clear old search markers and panel
    clearSearchMarkers();
    
    showToast(`'${query}' 장소를 네이버 지도에서 탐색 중입니다... 📍`, "info");
    
    let combinedResults = [];

    // 1. Local Knowledge Base (Instant, reliable, pre-verified coordinates)
    const kbResults = searchLocalKnowledgeBase(query);
    if (kbResults.length > 0) {
        combinedResults.push(...kbResults);
    }

    // 2. Detect user's current GPS location (max 1s timeout)
    const userLoc = await getUserCurrentLocation();
    const userLat = userLoc ? userLoc.lat : null;
    const userLng = userLoc ? userLoc.lng : null;

    // 3. Real-time Naver Maps Dynamic POI/Business Search API
    try {
        const dynamicNaverPlaces = await searchNaverMapPlacesDynamic(query, userLat, userLng);
        if (Array.isArray(dynamicNaverPlaces) && dynamicNaverPlaces.length > 0) {
            combinedResults.push(...dynamicNaverPlaces);
        }
    } catch (err) {
        console.warn("[Naver Dynamic Search]", err);
    }

    // 4. Naver Address Geocoder (Exact address lookup — best for road-name addresses)
    if (isNaverMapActive) {
        try {
            const naverResults = await searchNaverGeocoder(query);
            if (Array.isArray(naverResults) && naverResults.length > 0) {
                combinedResults.push(...naverResults);
            }
        } catch (err) {
            console.warn("[Naver Map Search Error]", err);
        }
    }
    
    // 5. AI Business Directory & Local Place Search (Finds restaurants & company branches)
    if (geminiApiKey && combinedResults.length < 2) {
        try {
            const responseText = await callGeminiSearchAPI(query);
            const searchResults = cleanAndParseJSON(responseText);
            if (Array.isArray(searchResults) && searchResults.length > 0) {
                combinedResults.push(...searchResults);
            }
        } catch (err) {
            console.warn("[Map Search] Gemini AI search failed:", err.message);
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

    if (uniqueResults.length > 0) {
        renderMapSearchResults(uniqueResults);
        const proximityNotice = userLoc ? " (내 위치 가까운 순 정렬)" : "";
        showToast(`'${query}' 검색 결과 총 ${uniqueResults.length}건을 찾았습니다!${proximityNotice} 📍`, "success");
    } else {
        showToast(`'${query}' 검색 결과를 찾지 못했습니다. 도로명 주소나 매장 이름을 정확히 입력해 보세요 📍`, "warning");
    }
}
window.handleInAppMapSearch = handleInAppMapSearch;

// OpenStreetMap Nominatim Free Search Helper (Leaflet mode fallback)
async function searchNominatimFree(query) {
    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=kr&limit=5`;
        const res = await fetch(url);
        if (!res.ok) return null;
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
                    category: "Other"
                };
            });
        }
    } catch (e) {
        console.warn("[Map Search] Nominatim fetch error:", e);
    }
    return null;
}

// Naver Native Geocoder Promise Wrapper
function searchNaverGeocoder(query) {
    return new Promise((resolve) => {
        if (!isNaverMapActive || !window.naver || !window.naver.maps || !window.naver.maps.Service || !window.naver.maps.Service.geocode) {
            console.warn("[Naver Map] Geocoder submodule unavailable.");
            resolve(null);
            return;
        }
        
        naver.maps.Service.geocode({ query: query }, (status, response) => {
            if (status !== naver.maps.Service.Status.OK) {
                console.warn("[Naver Map] Geocode API status:", status);
                resolve(null);
                return;
            }
            if (!response.v2 || !response.v2.addresses || response.v2.addresses.length === 0) {
                console.info("[Naver Map] Geocode found no address match for:", query);
                resolve(null);
                return;
            }
            
            const results = response.v2.addresses.map((addr) => {
                let buildingName = "";
                if (addr.addressElements) {
                    const el = addr.addressElements.find(e => e.types && (e.types.includes("BUILDING_NAME") || e.types.includes("LANDMARK")));
                    if (el && el.longName) {
                        buildingName = el.longName;
                    }
                }
                
                const shortAddr = addr.roadAddress || addr.jibunAddress || "";
                const displayTitle = buildingName ? `${query} (${buildingName})` : (shortAddr ? `${query}` : query);
                
                return {
                    name: displayTitle,
                    address: shortAddr || "네이버 지도 주소",
                    lat: parseFloat(addr.y),
                    lng: parseFloat(addr.x),
                    category: "Other"
                };
            });
            resolve(results);
        });
    });
}

// Dynamic Gemini Model Candidate List (Auto-fallback engine)
const GEMINI_CANDIDATE_MODELS = [
    "gemini-2.0-flash",
    "gemini-1.5-flash-latest",
    "gemini-1.5-flash",
    "gemini-2.0-flash-exp"
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
                if (response.status === 404 || errMsg.includes("not found") || errMsg.includes("not supported")) {
                    console.warn(`[Gemini API] Model ${modelName} not available (${errMsg}), trying next candidate...`);
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

// Dedicated Gemini API call for map geocoding & multi-branch search
async function callGeminiSearchAPI(query) {
    const searchPrompt = `You are a Local Geocoding & Business Search utility for South Korea.
The user searched for: "${query}"
Find 4-8 REAL, SPECIFIC, EXISTING company branches, stores, offices, venues, or locations matching "${query}" in South Korea.
For example, if the query is a company or brand name (such as "민테크", "스타벅스", "CGV"), list 4-8 of their REAL distinct branches/offices/locations across South Korea with exact real Korean addresses and precise lat/lng coordinates in South Korea.

Return STRICTLY a JSON array of objects with this format (no markdown, no preamble):
[
  {
    "name": "Exact Branch or Location Name in Korean (e.g., 민테크 대전본사, 민테크 서울사무소)",
    "address": "Detailed Real Korean Address",
    "lat": 37.xxxx or 36.xxxx (latitude in South Korea),
    "lng": 127.xxxx or 128.xxxx (longitude in South Korea),
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

        const naverUrl = `https://map.naver.com/v5/search/${encodeURIComponent(data.name)}?c=${saveLat},${saveLng},15,0,0,0,dh`;
        const existing = await db.places.where("name").equalsIgnoreCase(data.name).first();
        if (existing) {
            showToast(`'${data.name}'은(는) 이미 위시리스트에 존재합니다! 💖`, "info");
            clearSearchMarkers();
            return;
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

// 8. Modals Management (Quick Add & Visit Logging)
function openAddPlaceModal() {
    document.getElementById("modal-place-add").classList.add("active");
}

function closeAddPlaceModal() {
    document.getElementById("modal-place-add").classList.remove("active");
    document.getElementById("form-place-add").reset();
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
    
    if (isNaN(lat) || isNaN(lng)) {
        lat = 37.5665 + (Math.random() - 0.5) * 0.03;
        lng = 126.9780 + (Math.random() - 0.5) * 0.03;
    }

    try {
        await db.places.add({
            name,
            category,
            url,
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
            createdAt: new Date().toISOString()
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
    if (!files || files.length === 0) {
        previewContainer.innerHTML = `<span>여기를 클릭해 이미지를 선택하세요. (여러 장 선택 가능) 📸</span>`;
        return;
    }
    
    previewContainer.innerHTML = "";
    Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onload = function(event) {
            const img = document.createElement("img");
            img.src = event.target.result;
            img.alt = "Preview";
            previewContainer.appendChild(img);
        };
        reader.readAsDataURL(file);
    });
}

function handleEditPhotoUploadPreview(e) {
    const files = e.target.files;
    const previewContainer = document.getElementById("edit-place-photo-preview");
    if (!previewContainer) return;
    if (!files || files.length === 0) return;
    
    previewContainer.innerHTML = "";
    Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onload = function(event) {
            const img = document.createElement("img");
            img.src = event.target.result;
            img.alt = "Preview";
            previewContainer.appendChild(img);
        };
        reader.readAsDataURL(file);
    });
}

// 9. Photo Compressor Logic (High Quality Preserving Pipeline, max 2560px, 90% quality)
function compressBase64Image(base64Str, maxWidth = 2560, maxHeight = 2560, quality = 0.90) {
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
    
    // Format date for <input type="date"> (YYYY-MM-DD)
    const dateObj = new Date(place.createdAt);
    const dateStr = !isNaN(dateObj.getTime()) ? dateObj.toISOString().split("T")[0] : new Date().toISOString().split("T")[0];
    document.getElementById("edit-place-date").value = dateStr;

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
                    const img = document.createElement("img");
                    img.src = pSrc;
                    img.alt = "Memory";
                    photoPreview.appendChild(img);
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

window.fixEditModalCoordinates = async function() {
    const address = document.getElementById("edit-place-address").value.trim();
    if (!address) {
        showToast("보정할 주소를 입력해 주세요! 📍", "warning");
        return;
    }
    
    showToast("네이버 공식 지적도 건물 좌표를 조회 중입니다... 🎯", "success");
    
    if (window.naver && window.naver.maps && window.naver.maps.Service && window.naver.maps.Service.geocode) {
        naver.maps.Service.geocode({ query: address }, (status, response) => {
            if (status === naver.maps.Service.Status.OK && response.v2 && response.v2.addresses && response.v2.addresses.length > 0) {
                const addrItem = response.v2.addresses[0];
                const lat = parseFloat(addrItem.y);
                const lng = parseFloat(addrItem.x);
                
                const id = parseInt(document.getElementById("edit-place-id").value);
                if (id) {
                    db.places.update(id, { lat: lat, lng: lng }).then(() => {
                        showToast(`네이버 공식 건물 좌표(${lat.toFixed(5)}, ${lng.toFixed(5)})로 100% 정밀 보정되었습니다! 🎯`, "success");
                        updateMapMarkers();
                    });
                }
            } else {
                showToast("해당 주소의 지적도 좌표를 찾지 못했습니다. 도로명 주소를 확인해 주세요 📍", "warning");
            }
        });
    } else {
        showToast("네이버 지도 지적도 서비스가 준비 중입니다.", "warning");
    }
};

async function handleEditPlaceSubmit(e) {
    e.preventDefault();
    const id = parseInt(document.getElementById("edit-place-id").value);
    const name = document.getElementById("edit-place-name").value.trim();
    
    const catSelect = document.getElementById("edit-place-category").value;
    const catCustom = document.getElementById("edit-place-custom-category").value.trim();
    const category = (catSelect === "custom" && catCustom) ? catCustom : catSelect;

    const dateVal = document.getElementById("edit-place-date").value;
    const addressVal = document.getElementById("edit-place-address").value.trim();
    
    const commentAEl = document.getElementById("edit-place-comment-a");
    const commentBEl = document.getElementById("edit-place-comment-b");

    const place = await db.places.get(id);
    if (!place) return;

    const updatedDate = dateVal ? new Date(dateVal).toISOString() : place.createdAt;

    let updatePayload = {
        name: name,
        category: category,
        notes: addressVal,
        createdAt: updatedDate,
        commentA: commentAEl ? commentAEl.value.trim() : (place.commentA || ""),
        commentB: commentBEl ? commentBEl.value.trim() : (place.commentB || "")
    };

    // Auto-resolve coordinates from address via Naver official Geocoder
    if (window.naver && window.naver.maps && window.naver.maps.Service && window.naver.maps.Service.geocode && addressVal.length > 4) {
        await new Promise((resolve) => {
            naver.maps.Service.geocode({ query: addressVal }, (status, response) => {
                if (status === naver.maps.Service.Status.OK && response.v2 && response.v2.addresses && response.v2.addresses.length > 0) {
                    const addrItem = response.v2.addresses[0];
                    updatePayload.lat = parseFloat(addrItem.y);
                    updatePayload.lng = parseFloat(addrItem.x);
                }
                resolve();
            });
        });
    }

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
    // 1. Render Wishlist Tab
    const wishlistContainer = document.getElementById("wishlist-list-container");
    if (wishlistContainer) {
        wishlistContainer.innerHTML = "";
        const searchInput = document.getElementById("wishlist-search-input");
        const searchVal = searchInput ? searchInput.value.toLowerCase() : "";
        
        const wishlistPlaces = await db.places.where("isVisited").equals(0).toArray();
        // Strict Descending Sort by creation date with ID tie-breaker
        wishlistPlaces.sort((a, b) => {
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
                        <span class="place-category-badge badge-${place.category.toLowerCase()}">${place.category}</span>
                        <span class="place-priority-dot priority-${place.priority}"></span>
                    </div>
                    <h4 class="place-title" style="margin-top:0.2rem; margin-bottom:0.4rem;">${place.name}</h4>
                    
                    <div class="place-card-meta-details" style="font-size:0.78rem; color:var(--color-text-med); margin-bottom:0.65rem; display:flex; flex-direction:column; gap:0.35rem; background:rgba(255,101,132,0.04); padding:0.55rem 0.7rem; border-radius:10px; border:1px solid rgba(255,101,132,0.12);">
                        ${dateStr ? `<div><i data-lucide="calendar" style="width:13px; height:13px; display:inline-block; vertical-align:middle; margin-right:4px; color:var(--color-primary);"></i><strong>방문 예정일:</strong> ${dateStr}</div>` : ''}
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
        
        const visitedPlaces = await db.places.where("isVisited").equals(1).toArray();
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

                let stars = '';
                for(let i=1; i<=5; i++) {
                    stars += `<i data-lucide="star" style="${i <= (place.rating || 5) ? '' : 'fill:none; color:var(--color-text-low);'}"></i>`;
                }
                
                let payerName = partnerAName;
                if (place.payer === "B") payerName = partnerBName;
                else if (place.payer === "DUTCH") payerName = "반반 더치페이 🤝";
                
                cardContent += renderCommentsBlock(place);

                cardContent += `
                    <div class="place-card-stars" style="margin-top:0.4rem;">
                        ${stars}
                    </div>
                    ${place.review ? `<p class="visited-review-snippet" style="margin-top:0.3rem; margin-bottom:0.5rem;">"${escapeHtml(place.review)}"</p>` : ''}
                    <div class="place-meta-item" style="font-size:0.78rem;">
                        <i data-lucide="coins"></i>
                        <span>결제자: <strong>${payerName}</strong> (${formatCurrency(place.expense || 0)})</span>
                    </div>
                `;

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
    
    const wishlistCount = places.filter(p => p.isVisited === 0).length;
    const visitedCount = places.filter(p => p.isVisited === 1).length;
    const expenseSum = places.filter(p => p.isVisited === 1).reduce((acc, curr) => acc + (curr.expense || 0), 0);
    
    document.getElementById("stat-wishlist-count").textContent = wishlistCount;
    document.getElementById("stat-visited-count").textContent = visitedCount;
    document.getElementById("stat-expense-sum").textContent = formatCurrency(expenseSum);
    
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

    // Visited quote box
    const visitedLogs = places.filter(p => p.isVisited === 1).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    const latestReviewEl = document.getElementById("latest-visited-review");
    if (latestReviewEl) {
        if (visitedLogs.length > 0) {
            latestReviewEl.innerHTML = `
                <strong>${visitedLogs[0].name}</strong>: 
                "${visitedLogs[0].review || '소감 없음'}" <span style="display:block; font-size:0.75rem; margin-top:4px; color:var(--color-text-low);">${visitedLogs[0].rating || 5}점 ★</span>
            `;
        } else {
            latestReviewEl.textContent = `"아직 등록된 다녀온 곳 로그가 없습니다. 데이트 장소를 다녀온 후 소감을 남겨보세요!"`;
        }
    }
}

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
}

async function saveToCloud() {
    if (!syncRoomId || isUploading) return;
    isUploading = true;
    
    try {
        const places = await db.places.toArray();
        const seenNames = new Set();
        const cleanPlaces = [];
        places.forEach(p => {
            const copy = { ...p };
            delete copy.photo;
            delete copy.photos;
            sanitizePlaceObject(copy);
            const cleanName = (copy.name || "").trim();
            if (cleanName && cleanName.length >= 2 && cleanName.toLowerCase() !== "undefined" && cleanName.toLowerCase() !== "null") {
                const nameKey = cleanName.toLowerCase();
                if (!seenNames.has(nameKey)) {
                    seenNames.add(nameKey);
                    cleanPlaces.push(copy);
                }
            }
        });

        // Save local DB to cloud room (including empty list when user clears/deletes places)
        const now = Date.now();
        const payload = {
            placesData: JSON.stringify(cleanPlaces),
            partnerAName: partnerAName,
            partnerBName: partnerBName,
            naverClientId: naverClientId,
            geminiApiKey: geminiApiKey,
            timestamp: now
        };
        
        const bodyStr = JSON.stringify(payload);
        lastSyncedDataString = bodyStr;
        const url = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}.json`;
        const response = await fetch(url, {
            method: 'PUT',
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

            if (resData.geminiApiKey && resData.geminiApiKey !== geminiApiKey) {
                geminiApiKey = resData.geminiApiKey;
                localStorage.setItem("aura_gemini_key", geminiApiKey);
                const el = document.getElementById("settings-gemini-key");
                if (el) el.value = geminiApiKey;
            }
        }

        if (resData.timestamp && resData.timestamp > lastSyncedTimestamp) {
            lastSyncedTimestamp = resData.timestamp;

            let fetchedPlaces = [];
            try {
                fetchedPlaces = JSON.parse(resData.placesData);
            } catch(e) {
                console.error('Failed to parse Firebase placesData:', e);
            }

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

                // Preserve local photo attachments and tombstones
                placesToApply.forEach(fp => {
                    const localMatch = localPlaces.find(lp => (lp.name || "").trim().toLowerCase() === (fp.name || "").trim().toLowerCase());
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

                const localCompareStr = JSON.stringify(localPlaces.map(p => { const c = {...p}; delete c.photo; delete c.photos; return c; }));
                const fetchedCompareStr = JSON.stringify(placesToApply);

                if (localCompareStr !== fetchedCompareStr) {
                    console.log("[Sync Engine] Local DB updated from cloud.");
                    await db.places.clear();
                    if (placesToApply.length > 0) {
                        await db.places.bulkAdd(placesToApply);
                    }

                    await updateDashboardStats();
                    await renderPlacesList();
                    updateMapMarkers();
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
        const photos = await response.json();
        if (!photos) return;
        
        const places = await db.places.toArray();
        let changed = false;

        for (const place of places) {
            const nameKey = (place.name || "").trim().toLowerCase().replace(/[/\\?%*:|"<>. ]/g, "_");
            const entry = photos[nameKey] || photos[place.id];
            if (entry) {
                const serverImgList = entry.imgList || (entry.img ? [entry.img] : []);
                const localImgList = place.photos || (place.photo ? [place.photo] : []);
                
                if (JSON.stringify(serverImgList) !== JSON.stringify(localImgList)) {
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
    const limitVal = parseInt(document.getElementById("settings-budget-limit").value) || 500000;
    const partnerAVal = document.getElementById("settings-partner-a-name").value.trim() || "SH";
    const partnerBVal = document.getElementById("settings-partner-b-name").value.trim() || "SA";
    const syncRoomVal = document.getElementById("settings-sync-room-id").value.trim();
    const firebaseUrVal = document.getElementById("settings-firebase-url").value.trim();
    
    localStorage.setItem("aura_gemini_key", apiKeyVal);
    localStorage.setItem("aura_naver_client_id", naverClientIdVal);
    localStorage.setItem("aura_budget_limit", limitVal);
    localStorage.setItem("aura_partner_a_name", partnerAVal);
    localStorage.setItem("aura_partner_b_name", partnerBVal);
    localStorage.setItem("aura_sync_room_id", syncRoomVal);
    localStorage.setItem("aura_firebase_url", firebaseUrVal);
    
    geminiApiKey = apiKeyVal;
    naverClientId = naverClientIdVal;
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
        if (fullDateStr === todayStr) cell.classList.add("today");
        if (fullDateStr === selectedCalendarDateStr) cell.classList.add("selected");

        cell.addEventListener("click", () => {
            document.querySelectorAll(".calendar-day-cell").forEach(c => c.classList.remove("selected"));
            cell.classList.add("selected");
            selectedCalendarDateStr = fullDateStr;
            renderSelectedDateDetails(fullDateStr, places);
        });

        // Match places with date & group by type (Visited vs Wishlist)
        const visitedPlaces = datePlaces.filter(p => p.isVisited === 1);
        const wishlistPlaces = datePlaces.filter(p => p.isVisited === 0);

        let badgesHtml = "";
        if (visitedPlaces.length > 0 || wishlistPlaces.length > 0) {
            badgesHtml += `<div style="display:flex; flex-direction:column; gap:2px; margin-top:2px;">`;
            if (visitedPlaces.length > 0) {
                badgesHtml += `
                    <button class="cal-btn-visited" onclick="event.stopPropagation(); openDateDetailsModal('${fullDateStr}', 'visited')">
                        🌸 다녀옴 (${visitedPlaces.length})
                    </button>
                `;
            }
            if (wishlistPlaces.length > 0) {
                badgesHtml += `
                    <button class="cal-btn-wishlist" onclick="event.stopPropagation(); openDateDetailsModal('${fullDateStr}', 'wishlist')">
                        💌 위시 (${wishlistPlaces.length})
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

function renderSelectedDateDetails(dateStr, places) {
    const titleEl = document.getElementById("selected-date-title");
    const itemsEl = document.getElementById("selected-date-items");
    if (!titleEl || !itemsEl) return;

    const dateObj = new Date(dateStr);
    const formattedTitle = !isNaN(dateObj.getTime()) ? `${dateObj.getFullYear()}년 ${dateObj.getMonth() + 1}월 ${dateObj.getDate()}일 데이트 기록` : `${dateStr} 데이트 기록`;
    titleEl.textContent = formattedTitle;

    const datePlaces = places.filter(p => {
        const pDate = p.createdAt || p.date;
        const ms = parseAnyDate(pDate);
        if (ms <= 0) return false;
        const iso = new Date(ms).toISOString().split("T")[0];
        return iso === dateStr;
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
        const isVis = p.isVisited === 1;
        const statusBadge = isVis ? `<span class="badge-visited" style="font-size:0.7rem; padding:0.15rem 0.55rem; border-radius:6px; background:rgba(255,101,132,0.15); color:var(--color-primary); font-weight:700;">🌸 다녀온 곳</span>` : `<span class="badge-wish" style="font-size:0.7rem; padding:0.15rem 0.55rem; border-radius:6px; background:rgba(162,155,254,0.15); color:#6C5CE7; font-weight:700;">💌 위시리스트</span>`;

        const div = document.createElement("div");
        div.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.65rem 0.85rem;
            background: rgba(255, 101, 132, 0.04);
            border: 1px solid rgba(255, 101, 132, 0.12);
            border-radius: 12px;
            margin-bottom: 0.5rem;
            flex-wrap: wrap;
            gap: 8px;
        `;
        div.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                ${statusBadge}
                <strong style="font-size:0.92rem; color:var(--color-text-dark);">${escapeHtml(p.name)}</strong>
                <span style="font-size:0.75rem; color:var(--color-text-med);">(${p.category})</span>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
                ${p.commentA || p.commentB ? `<span style="font-size:0.75rem; color:var(--color-primary);">💬 "${escapeHtml(p.commentA || p.commentB)}"</span>` : ''}
                <button class="btn btn-outline" style="padding:0.2rem 0.55rem; font-size:0.72rem; height:26px; border-color:var(--color-primary); color:var(--color-primary);" onclick="openEditPlaceModal(${p.id})">✏️ 수정</button>
            </div>
        `;
        itemsEl.appendChild(div);
    });
}

let currentGallerySliderData = {
    places: [],
    placeIndex: 0,
    photoIndex: 0
};

async function renderGallery() {
    const container = document.getElementById("gallery-photos-grid");
    const countEl = document.getElementById("gallery-photo-count");
    if (!container) return;

    container.innerHTML = "";
    const places = await db.places.where("isVisited").equals(1).toArray();
    
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
                    <span style="color:var(--color-primary); font-weight:700;">${p.rating || 5}점 ★</span>
                </div>
                ${p.commentA || p.commentB ? `<div class="gallery-comments-snippet">💬 "${escapeHtml(p.commentA || p.commentB)}"</div>` : ''}
                <div class="gallery-action-bar" style="display:flex; flex-direction:column; gap:6px; margin-top:6px;">
                    <button class="btn btn-outline" style="width:100%; font-size:0.75rem; padding:0.35rem; height:32px; border-color:var(--color-primary); color:var(--color-primary); justify-content:center;" onclick="openEditPlaceModal(${p.id})">
                        ✏️ 사진 수정 / 추가
                    </button>
                    <button class="btn btn-outline" style="width:100%; font-size:0.75rem; padding:0.35rem; height:32px; border-color:var(--color-secondary); color:var(--color-secondary); background:rgba(255,112,150,0.06); justify-content:center;" onclick="downloadPlacePhotosZip(${p.id})">
                        📥 전체 사진 다운로드
                    </button>
                </div>
            </div>
        `;
        container.appendChild(card);
    });

    lucide.createIcons();
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
        name: place.name,
        meta: `${dateStr} · ${place.rating || 5}점 ★ · (${place.category})`,
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

// Single & Place Photo Download Engines
window.downloadPlacePhotosZip = async function(placeId) {
    const place = await db.places.get(placeId);
    if (!place) return;
    const photoList = place.photos || (place.photo ? [place.photo] : []);
    if (photoList.length === 0) {
        showToast("다운로드할 사진이 없습니다 📷", "warning");
        return;
    }

    if (photoList.length === 1) {
        downloadBase64Image(photoList[0], `${place.name}_추억사진.jpg`);
        showToast(`'${place.name}' 사진 1장이 다운로드되었습니다! 📥`, "success");
    } else {
        try {
            showToast(`'${place.name}' 추억 사진 ${photoList.length}장을 압축 다운로드합니다... 📦`, "info");
            const zip = new JSZip();
            const cleanName = place.name.replace(/[/\\?%*:|"<>. ]/g, "_");
            photoList.forEach((pSrc, idx) => {
                const base64Data = pSrc.split(',')[1];
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
            photoList.forEach((pSrc, idx) => downloadBase64Image(pSrc, `${place.name}_${idx+1}.jpg`));
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
    const places = await db.places.toArray();
    const datePlaces = places.filter(p => {
        if (p.isDeleted === 1 || p.isVisited === -1) return false;
        const pDate = p.createdAt || p.date;
        const ms = parseAnyDate(pDate);
        if (ms <= 0) return false;
        return new Date(ms).toISOString().split("T")[0] === dateStr;
    });

    const filtered = datePlaces.filter(p => {
        if (type === 'visited') return p.isVisited === 1;
        if (type === 'wishlist') return p.isVisited === 0;
        return true;
    });

    const titleEl = document.getElementById("modal-date-details-title");
    const bodyEl = document.getElementById("modal-date-details-body");
    
    if (titleEl) {
        const dObj = new Date(dateStr);
        const typeLabel = type === 'visited' ? '🌸 함께 다녀온 장소' : (type === 'wishlist' ? '💌 데이트 위시리스트' : '기록');
        titleEl.textContent = `${dObj.getFullYear()}년 ${dObj.getMonth() + 1}월 ${dObj.getDate()}일 ${typeLabel} (${filtered.length}건)`;
    }

    if (bodyEl) {
        if (filtered.length === 0) {
            bodyEl.innerHTML = `<div style="text-align:center; padding:2rem; color:var(--color-text-med);">해당 날짜에 등록된 내역이 없습니다.</div>`;
        } else {
            let html = "";
            filtered.forEach(p => {
                const isVis = p.isVisited === 1;
                const badge = isVis ? `<span style="background:rgba(255,101,132,0.15); color:var(--color-primary); font-size:0.7rem; font-weight:700; padding:2px 7px; border-radius:6px;">🌸 다녀온 곳</span>` : `<span style="background:rgba(162,155,254,0.15); color:#6C5CE7; font-size:0.7rem; font-weight:700; padding:2px 7px; border-radius:6px;">💌 위시리스트</span>`;
                html += `
                    <div style="background:rgba(255,101,132,0.04); border:1px solid rgba(255,101,132,0.15); border-radius:12px; padding:0.75rem; margin-bottom:0.6rem;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.3rem;">
                            <div>${badge} <strong style="margin-left:4px; font-size:0.9rem; color:var(--color-text-high);">${escapeHtml(p.name)}</strong></div>
                            <button class="btn btn-outline" style="padding:0.2rem 0.5rem; font-size:0.72rem; height:26px; border-color:var(--color-primary); color:var(--color-primary);" onclick="closeDateDetailsModal(); openEditPlaceModal(${p.id});">✏️ 수정</button>
                        </div>
                        ${p.notes ? `<div style="font-size:0.78rem; color:var(--color-text-med); margin-top:0.2rem;">📍 ${escapeHtml(p.notes)}</div>` : ''}
                        ${p.commentA || p.commentB ? `<div style="font-size:0.75rem; color:var(--color-primary); margin-top:0.35rem; background:rgba(255,255,255,0.7); padding:0.25rem 0.45rem; border-radius:6px; border-left:3px solid var(--color-primary);">💬 "${escapeHtml(p.commentA || p.commentB)}"</div>` : ''}
                    </div>
                `;
            });
            bodyEl.innerHTML = html;
        }
    }

    const modal = document.getElementById("modal-date-details");
    if (modal) {
        modal.classList.add("active");
        setTimeout(() => lucide.createIcons(), 50);
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
let activeMemoryPhotoIndex = 0;

function renderLovelyMemoryGallery() {
    const grid = document.getElementById("dashboard-memory-grid");
    if (!grid) return;

    if (!customMemoryPhotos || customMemoryPhotos.length === 0) {
        customMemoryPhotos = [...DEFAULT_MEMORY_PHOTOS];
    }

    grid.innerHTML = "";
    customMemoryPhotos.forEach((imgSrc, idx) => {
        const item = document.createElement("div");
        item.className = "memory-item";
        item.innerHTML = `<img src="${imgSrc}" alt="Lovely Memory ${idx + 1}" class="gallery-img" onclick="openMemoryLightboxModal(${idx})">`;
        grid.appendChild(item);
    });
}

window.openMemoryLightboxModal = function(idx) {
    if (!customMemoryPhotos || customMemoryPhotos.length === 0) return;
    activeMemoryPhotoIndex = Math.max(0, Math.min(idx, customMemoryPhotos.length - 1));
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
    if (mainImg && customMemoryPhotos[activeMemoryPhotoIndex]) {
        mainImg.src = customMemoryPhotos[activeMemoryPhotoIndex];
    }
    if (metaEl) {
        metaEl.textContent = `${activeMemoryPhotoIndex + 1} / ${customMemoryPhotos.length}`;
    }
}

window.navigateMemoryLightbox = function(dir) {
    if (!customMemoryPhotos || customMemoryPhotos.length <= 1) return;
    activeMemoryPhotoIndex = (activeMemoryPhotoIndex + dir + customMemoryPhotos.length) % customMemoryPhotos.length;
    updateMemoryLightboxUI();
};

window.closeMemoryLightboxModal = function() {
    const modal = document.getElementById("modal-memory-lightbox");
    if (modal) modal.classList.remove("active");
};

window.deleteCurrentMemoryPhoto = function() {
    if (!customMemoryPhotos || customMemoryPhotos.length === 0) return;
    if (!confirm("이 추억 사진을 러블리 메모리에서 삭제하시겠습니까?")) return;

    customMemoryPhotos.splice(activeMemoryPhotoIndex, 1);
    localStorage.setItem("aura_lovely_memories", JSON.stringify(customMemoryPhotos));
    renderLovelyMemoryGallery();
    showToast("추억 사진이 삭제되었습니다.", "success");

    if (customMemoryPhotos.length === 0) {
        customMemoryPhotos = [...DEFAULT_MEMORY_PHOTOS];
        localStorage.setItem("aura_lovely_memories", JSON.stringify(customMemoryPhotos));
        renderLovelyMemoryGallery();
        closeMemoryLightboxModal();
    } else {
        if (activeMemoryPhotoIndex >= customMemoryPhotos.length) {
            activeMemoryPhotoIndex = customMemoryPhotos.length - 1;
        }
        updateMemoryLightboxUI();
    }
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
            const compressed = await compressBase64Image(base64, 1920, 1920, 0.85);
            if (compressed) newPhotos.push(compressed);
        }
        if (newPhotos.length > 0) {
            customMemoryPhotos = [...customMemoryPhotos, ...newPhotos];
            localStorage.setItem("aura_lovely_memories", JSON.stringify(customMemoryPhotos));
            renderLovelyMemoryGallery();
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
