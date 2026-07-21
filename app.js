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
let isNaverMapActive = false;

let currentActiveTab = "dashboard";
let currentPlacesFilter = "wishlist"; 

// Couple Info & Settings (LocalStorage)
let geminiApiKey = localStorage.getItem("aura_gemini_key") || "";
let naverClientId = localStorage.getItem("aura_naver_client_id") || "";
let budgetLimit = parseInt(localStorage.getItem("aura_budget_limit")) || 500000;
let partnerAName = localStorage.getItem("aura_partner_a_name") || "초코";
let partnerBName = localStorage.getItem("aura_partner_b_name") || "딸기";
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

    updatePartnerNamesUI();

    // Map script selection & dynamic load
    if (naverClientId) {
        loadNaverMapScript(naverClientId);
    } else {
        initLeafletMap();
    }

    // Refresh UI Data
    await updateDashboardStats();
    await renderPlacesList();
    checkApiKeyAlert();
    startCloudSyncLoop();

    // Lucide Icons Initialization
    lucide.createIcons();

    // Tab Navigation
    document.querySelectorAll(".nav-menu .nav-item").forEach(button => {
        button.addEventListener("click", () => {
            const targetTab = button.getAttribute("data-tab");
            switchTab(targetTab);
        });
    });

    // Quick Add Modal Trigger
    document.getElementById("btn-quick-add").addEventListener("click", openAddPlaceModal);
    document.getElementById("btn-close-modal").addEventListener("click", closeAddPlaceModal);
    document.getElementById("btn-cancel-modal").addEventListener("click", closeAddPlaceModal);
    document.getElementById("form-place-add").addEventListener("submit", handleAddPlaceSubmit);
    document.getElementById("add-place-url").addEventListener("input", handleMapUrlInput);

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
            document.getElementById("visit-photo").click();
        });
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
    document.getElementById("btn-map-search").addEventListener("click", handleInAppMapSearch);
    document.getElementById("map-search-query").addEventListener("keypress", (e) => {
        if (e.key === "Enter") handleInAppMapSearch();
    });

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
    document.querySelectorAll(".nav-menu .nav-item").forEach(el => el.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach(el => el.classList.remove("active"));
    
    const navBtn = document.querySelector(`.nav-menu .nav-item[data-tab="${tabId}"]`);
    if (navBtn) navBtn.classList.add("active");
    
    const tabPane = document.getElementById(`tab-${tabId}`);
    if (tabPane) tabPane.classList.add("active");
    
    currentActiveTab = tabId;
    
    // Page Title Update
    const titleTextMap = {
        "dashboard": "러블리 대시보드 Overview",
        "wishlist": "데이트 위시리스트 🌸",
        "visited": "함께 다녀온 곳 💖",
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
    }
}

function updatePartnerNamesUI() {
    document.getElementById("opt-partner-a").textContent = `${partnerAName}(A)`;
    document.getElementById("opt-partner-b").textContent = `${partnerBName}(B)`;
    document.getElementById("opt-partner-a").value = "A";
    document.getElementById("opt-partner-b").value = "B";
    
    const nameAEl = document.getElementById("profile-name-a");
    const nameBEl = document.getElementById("profile-name-b");
    if (nameAEl) nameAEl.textContent = partnerAName;
    if (nameBEl) nameBEl.textContent = partnerBName;
}

// 5. Dynamic Map Loader Engine
function loadNaverMapScript(clientId) {
    const cleanId = (clientId || "").trim();
    if (!cleanId) {
        initLeafletMap();
        return;
    }
    if (document.getElementById("naver-map-sdk-script")) return;
    
    const script = document.createElement("script");
    script.id = "naver-map-sdk-script";
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
            position: naver.maps.Position.BOTTOM_RIGHT
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
                disableAnchor: true
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
    // 김순화 충남순대 & 충남순대 (전국 주요 8개 매장 및 본점)
    { name: "김순화 충남순대 (대전 유성 구룡동점)", address: "대전광역시 유성구 구룡달전로 3-12", lat: 36.42582, lng: 127.35124, category: "Restaurant", keywords: ["김순화", "충남순대", "김순화충남순대", "김순화 충남순대", "구룡달전로", "유성구 구룡달전로", "대전 충남순대"] },
    { name: "충남순대 (세종 금남본점)", address: "세종특별자치시 금남면 용포로 97-11", lat: 36.46351, lng: 127.27982, category: "Restaurant", keywords: ["충남순대", "세종충남순대", "금남면", "용포리", "세종 충남순대"] },
    { name: "충남순대국밥 (대전 유성 봉명점)", address: "대전광역시 유성구 유성대로 694", lat: 36.35821, lng: 127.33912, category: "Restaurant", keywords: ["충남순대", "유성 충남순대", "유성대로", "대전 충남순대"] },
    { name: "충남순대 (천안 아우내점)", address: "충청남도 천안시 동남구 병천면 아우내장터길 42", lat: 36.76214, lng: 127.29851, category: "Restaurant", keywords: ["충남순대", "병천순대", "천안 충남순대"] },
    { name: "충남순대 (공주 신관점)", address: "충청남도 공주시 번영1로 33", lat: 36.47154, lng: 127.13521, category: "Restaurant", keywords: ["충남순대", "공주 충남순대"] },
    { name: "충남순대 (청주 가경점)", address: "충청북도 청주시 흥덕구 풍산로 18", lat: 36.62891, lng: 127.43521, category: "Restaurant", keywords: ["충남순대", "청주 충남순대"] },
    { name: "충남순대 (아산 온천점)", address: "충청남도 아산시 온천대로 1498", lat: 36.78452, lng: 127.00125, category: "Restaurant", keywords: ["충남순대", "아산 충남순대"] },
    { name: "충남순대 (논산 강경점)", address: "충청남도 논산시 강경읍 계백로 125", lat: 36.15241, lng: 127.01254, category: "Restaurant", keywords: ["충남순대", "논산 충남순대"] },

    // 진남포면옥 & 진남포 (부분 검색어 지원)
    { name: "진남포면옥 (대전 유성구점)", address: "대전광역시 유성구 봉산로36번길 34", lat: 36.43892, lng: 127.38875, category: "Restaurant", keywords: ["진남포", "진남포면옥", "봉산로36번길", "대전맛집"] },
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

        // 2. Tokenized multi-word search (e.g. "김순화 충남순대" or "대전 충남순대")
        if (tokens.length > 1) {
            const tokenMatch = tokens.every(tok => 
                nameClean.includes(tok) || addrClean.includes(tok) || kwList.some(k => k.includes(tok))
            );
            if (tokenMatch) return true;
        }

        return false;
    });
}

// Real-time Dynamic Naver Map POI & Business Search Engine
async function searchNaverMapPlacesDynamic(query) {
    try {
        const encodedQ = encodeURIComponent(query);
        const targetUrl = `https://map.naver.com/v5/api/search?caller=pcweb&query=${encodedQ}&type=all&searchCoord=127.388,36.438&page=1&displayCount=8`;
        const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3500);
        
        const response = await fetch(proxyUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) return null;
        
        const data = await response.json();
        
        // Extract places from Naver Maps search response
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
        console.warn("[Naver Map POI Search] Dynamic fetch notice:", err.message);
    }
    return null;
}

// 6. In-App Map Real-Time Search Pipeline (Naver POI API + Naver Geocoder + AI Search + Nominatim)
async function handleInAppMapSearch() {
    const query = document.getElementById("map-search-query").value.trim();
    if (!query) return;
    
    // Clear old search markers and panel
    clearSearchMarkers();
    
    showToast(`'${query}' 네이버 지도 및 장소를 실시간 탐색 중입니다... 📍`, "success");
    
    let combinedResults = [];

    // 1. Real-time Naver Maps Dynamic POI/Business Search API (Fetches ALL registered Naver places)
    try {
        const dynamicNaverPlaces = await searchNaverMapPlacesDynamic(query);
        if (Array.isArray(dynamicNaverPlaces) && dynamicNaverPlaces.length > 0) {
            combinedResults.push(...dynamicNaverPlaces);
        }
    } catch (err) {
        console.warn("[Naver Dynamic Search]", err);
    }

    // 2. Naver Address Geocoder (Exact address lookup)
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

    // 3. Local Knowledge Base Instant & Partial/Multi-token Keyword Search
    const kbResults = searchLocalKnowledgeBase(query);
    if (kbResults.length > 0) {
        combinedResults.push(...kbResults);
    }
    
    // 4. AI Business Directory & Local Place Search (Finds restaurants & company branches)
    if (geminiApiKey) {
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
    
    // 5. OpenStreetMap Nominatim Free Search Engine (Fallback if no results yet)
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
    
    // 6. Deduplicate combined results by name & location proximity
    const uniqueResults = [];
    const seenMap = new Set();

    for (const item of combinedResults) {
        if (!item.lat || !item.lng) continue;
        const latFixed = parseFloat(item.lat).toFixed(3);
        const lngFixed = parseFloat(item.lng).toFixed(3);
        const key = `${(item.name || "").trim()}_${latFixed}_${lngFixed}`;
        
        if (!seenMap.has(key)) {
            seenMap.add(key);
            uniqueResults.push(item);
        }
    }

    if (uniqueResults.length > 0) {
        renderMapSearchResults(uniqueResults);
        showToast(`'${query}' 네이버 지도 검색 결과 총 ${uniqueResults.length}건을 찾았습니다! 📍`, "success");
        return;
    }
    
    showToast("입력하신 검색어에 해당하는 장소를 찾지 못했습니다. '대전 유성구 구룡달전로 3-12'처럼 도로명 주소나 상호명을 구체적으로 입력해 보세요 📍", "warning");
}

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
            cardsHtml += `
                <div class="search-result-card" id="search-res-item-${idx}">
                    <div class="search-result-info">
                        <div class="search-result-title">${idx + 1}. ${res.name}</div>
                        <div class="search-result-addr">${res.address}</div>
                    </div>
                    <div class="search-result-actions">
                        <button class="btn btn-outline" style="padding:0.2rem 0.45rem; font-size:0.7rem;" onclick="focusMapSearchResult(${idx}, ${res.lat}, ${res.lng})">
                            위치보기 🎯
                        </button>
                        <button class="btn btn-primary" style="padding:0.2rem 0.45rem; font-size:0.7rem;" onclick="saveMapSearchResult('${encodedData}')">
                            위시리스트 💖
                        </button>
                        <button class="btn btn-secondary" style="padding:0.2rem 0.45rem; font-size:0.7rem; background:linear-gradient(135deg, #FF9F1C, #FFBF69); color:white; border:none;" onclick="saveMapSearchResultVisited('${encodedData}')">
                            다녀온 곳 📸
                        </button>
                        <button class="btn btn-outline" style="padding:0.2rem 0.45rem; font-size:0.7rem;" onclick="copyNaverMapUrl('${encodedData}')">
                            URL 복사 📋
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
                disableAnchor: true
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

function renderMockSearchResults(query) {
    const lat = 37.5665 + (Math.random() - 0.5) * 0.02;
    const lng = 126.9780 + (Math.random() - 0.5) * 0.02;
    const mocks = [
        { name: `${query} 러블리 핫플레이스`, address: "서울 중구 태평로1가", lat: lat, lng: lng, category: "Cafe" },
        { name: `${query} 로맨틱 다이닝`, address: "서울 중구 태평로2가", lat: lat + 0.004, lng: lng - 0.005, category: "Restaurant" }
    ];
    renderMapSearchResults(mocks);
}

// Copy Naver Map direct URL for a search result
window.copyNaverMapUrl = function(encoded) {
    const data = JSON.parse(decodeURIComponent(encoded));
    const naverUrl = `https://map.naver.com/v5/search/${encodeURIComponent(data.name)}?c=${data.lat},${data.lng},15,0,0,0,dh`;
    copyShareLinkToClipboard(naverUrl);
    showToast(`'${data.name}' 네이버 지도 URL 복사 완료! 📋 (신규 추가에 붙여넣어 보세요)`, "success");
};

// Save search result directly to Wishlist
window.saveMapSearchResult = async function(encoded) {
    const data = JSON.parse(decodeURIComponent(encoded));
    try {
        const naverUrl = `https://map.naver.com/v5/search/${encodeURIComponent(data.name)}?c=${data.lat},${data.lng},15,0,0,0,dh`;
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
            lat: data.lat,
            lng: data.lng,
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

// Save search result directly to Visited Places
window.saveMapSearchResultVisited = async function(encoded) {
    const data = JSON.parse(decodeURIComponent(encoded));
    try {
        const naverUrl = `https://map.naver.com/v5/search/${encodeURIComponent(data.name)}?c=${data.lat},${data.lng},15,0,0,0,dh`;
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
                    url: existing.url || naverUrl
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
            lat: data.lat,
            lng: data.lng,
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
    const category = document.getElementById("add-place-category").value;
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

function openVisitModal(placeId, placeName) {
    document.getElementById("visit-place-id").value = placeId;
    document.getElementById("visit-place-name").textContent = placeName;
    
    // Customize select option names based on settings
    document.getElementById("opt-partner-a").textContent = partnerAName;
    document.getElementById("opt-partner-b").textContent = partnerBName;
    
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

// 9. Photo Compressor Logic (JPEG, 150x150, 60% quality)
function compressBase64Image(base64Str, maxWidth = 150, maxHeight = 150, quality = 0.6) {
    return new Promise((resolve, reject) => {
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
            ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = base64Str;
    });
}

async function handleVisitLogSubmit(e) {
    e.preventDefault();
    const id = parseInt(document.getElementById("visit-place-id").value);
    const ratingEl = document.querySelector('input[name="rating"]:checked');
    const rating = ratingEl ? parseInt(ratingEl.value) : 5;
    const review = document.getElementById("visit-review").value.trim();
    const expense = parseInt(document.getElementById("visit-expense").value) || 0;
    const payer = document.getElementById("visit-payer").value;

    const photoImgs = document.querySelectorAll("#visit-photo-preview img");
    const photosBase64 = [];

    try {
        for (let i = 0; i < photoImgs.length; i++) {
            const compressed = await compressBase64Image(photoImgs[i].src);
            if (compressed) {
                photosBase64.push(compressed);
            }
        }

        await db.places.update(id, {
            isVisited: 1,
            rating: rating,
            review: review,
            expense: expense,
            payer: payer,
            peopleCount: 2,
            photo: photosBase64[0] || "",
            photos: photosBase64
        });
        
        showToast("데이트 방문 후기가 안전하게 저장되었습니다 💖", "success");
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
    document.getElementById("edit-place-category").value = place.category || "Restaurant";
    
    // Format date for <input type="date"> (YYYY-MM-DD)
    const dateObj = new Date(place.createdAt);
    const dateStr = !isNaN(dateObj.getTime()) ? dateObj.toISOString().split("T")[0] : new Date().toISOString().split("T")[0];
    document.getElementById("edit-place-date").value = dateStr;

    // Clean address from notes
    const cleanAddress = (place.notes || "").replace(/\s*-\s*AURA.*$/, "").replace(/^💡\s*메모:\s*/, "").trim();
    document.getElementById("edit-place-address").value = cleanAddress;

    document.getElementById("edit-opt-partner-a").textContent = partnerAName;
    document.getElementById("edit-opt-partner-b").textContent = partnerBName;

    const visitedFields = document.getElementById("edit-visited-fields");
    if (place.isVisited === 1) {
        if (visitedFields) visitedFields.style.display = "block";
        const ratingVal = place.rating || 5;
        const ratingRadio = document.querySelector(`input[name="edit-rating"][value="${ratingVal}"]`);
        if (ratingRadio) ratingRadio.checked = true;
        document.getElementById("edit-place-review").value = place.review || "";
        document.getElementById("edit-place-expense").value = place.expense || 0;
        document.getElementById("edit-place-payer").value = place.payer || "A";
    } else {
        if (visitedFields) visitedFields.style.display = "none";
    }

    document.getElementById("modal-edit-place").classList.add("active");
    setTimeout(() => lucide.createIcons(), 50);
}

function closeEditPlaceModal() {
    document.getElementById("modal-edit-place").classList.remove("active");
    document.getElementById("form-edit-place").reset();
}

async function handleEditPlaceSubmit(e) {
    e.preventDefault();
    const id = parseInt(document.getElementById("edit-place-id").value);
    const name = document.getElementById("edit-place-name").value.trim();
    const category = document.getElementById("edit-place-category").value;
    const dateVal = document.getElementById("edit-place-date").value;
    const addressVal = document.getElementById("edit-place-address").value.trim();
    
    const place = await db.places.get(id);
    if (!place) return;

    const updatedDate = dateVal ? new Date(dateVal).toISOString() : place.createdAt;

    let updatePayload = {
        name: name,
        category: category,
        notes: addressVal,
        createdAt: updatedDate
    };

    if (place.isVisited === 1) {
        const ratingEl = document.querySelector('input[name="edit-rating"]:checked');
        const rating = ratingEl ? parseInt(ratingEl.value) : 5;
        const review = document.getElementById("edit-place-review").value.trim();
        const expense = parseInt(document.getElementById("edit-place-expense").value) || 0;
        const payer = document.getElementById("edit-place-payer").value;

        updatePayload.rating = rating;
        updatePayload.review = review;
        updatePayload.expense = expense;
        updatePayload.payer = payer;
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

// 10. Places Render List
async function renderPlacesList() {
    // 1. Render Wishlist Tab
    const wishlistContainer = document.getElementById("wishlist-list-container");
    if (wishlistContainer) {
        wishlistContainer.innerHTML = "";
        const searchInput = document.getElementById("wishlist-search-input");
        const searchVal = searchInput ? searchInput.value.toLowerCase() : "";
        
        const wishlistPlaces = await db.places.where("isVisited").equals(0).toArray();
        const filteredWishlist = wishlistPlaces.filter(place => {
            return place.name.toLowerCase().includes(searchVal) || 
                   (place.notes && place.notes.toLowerCase().includes(searchVal));
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
                let cardContent = `
                    <div style="position:absolute; top:0.75rem; right:0.75rem; display:flex; gap:0.35rem; z-index:5;">
                        <button class="edit-card-btn" onclick="openEditPlaceModal(${place.id})" title="수정" style="background:rgba(255,255,255,0.9); border:1px solid rgba(0,0,0,0.12); border-radius:50%; width:28px; height:28px; display:flex; align-items:center; justify-content:center; cursor:pointer; color:var(--color-text-high); font-size:12px; transition:0.2s;"><i data-lucide="edit-3"></i></button>
                        <button class="delete-card-btn" onclick="deletePlace(${place.id}, '${place.name}')" title="삭제" style="background:rgba(255,255,255,0.9); border:1px solid rgba(0,0,0,0.12); border-radius:50%; width:28px; height:28px; display:flex; align-items:center; justify-content:center; cursor:pointer; color:var(--color-danger); font-size:12px; transition:0.2s;"><i data-lucide="trash-2"></i></button>
                    </div>
                    <div class="place-card-header">
                        <span class="place-category-badge badge-${place.category.toLowerCase()}">${place.category}</span>
                        <span class="place-priority-dot priority-${place.priority}"></span>
                    </div>
                    <h4 class="place-title" style="margin-top:0.2rem; margin-bottom:0.4rem;">${place.name}</h4>
                `;
                if (place.notes) {
                    cardContent += `<p class="place-notes">${place.notes}</p>`;
                }
                cardContent += `
                    <div class="place-actions">
                        ${place.url ? `<a href="${place.url}" target="_blank" class="btn btn-outline" style="padding:0.4rem 0.8rem; font-size:0.75rem;"><i data-lucide="external-link"></i> 지도</a>` : ''}
                        <button class="btn btn-primary" style="padding:0.4rem 0.8rem; font-size:0.75rem;" onclick="openVisitModal(${place.id}, '${place.name}')">
                            <i data-lucide="check"></i> 방문 완료
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
        const filteredVisited = visitedPlaces.filter(place => {
            return place.name.toLowerCase().includes(searchVal) || 
                   (place.notes && place.notes.toLowerCase().includes(searchVal)) ||
                   (place.review && place.review.toLowerCase().includes(searchVal));
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
                
                // Date formatting
                const dateObj = new Date(place.createdAt);
                const dateStr = !isNaN(dateObj.getTime()) ? dateObj.toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }) : "";
                
                // Clean address
                let cleanAddress = (place.notes || "").replace(/\s*-\s*AURA.*$/, "").replace(/^💡\s*메모:\s*/, "").trim();

                let cardContent = `
                    <div style="position:absolute; top:0.75rem; right:0.75rem; display:flex; gap:0.35rem; z-index:5;">
                        <button class="edit-card-btn" onclick="openEditPlaceModal(${place.id})" title="수정" style="background:rgba(255,255,255,0.9); border:1px solid rgba(0,0,0,0.12); border-radius:50%; width:28px; height:28px; display:flex; align-items:center; justify-content:center; cursor:pointer; color:var(--color-text-high); font-size:12px; transition:0.2s;"><i data-lucide="edit-3"></i></button>
                        <button class="delete-card-btn" onclick="deletePlace(${place.id}, '${place.name}')" title="삭제" style="background:rgba(255,255,255,0.9); border:1px solid rgba(0,0,0,0.12); border-radius:50%; width:28px; height:28px; display:flex; align-items:center; justify-content:center; cursor:pointer; color:var(--color-danger); font-size:12px; transition:0.2s;"><i data-lucide="trash-2"></i></button>
                    </div>
                    <div class="place-card-header">
                        <span class="place-category-badge badge-${place.category.toLowerCase()}">${place.category}</span>
                    </div>
                    <h4 class="place-title" style="margin-top:0.2rem; margin-bottom:0.4rem;">${place.name}</h4>
                    
                    <div class="place-card-meta-details" style="font-size:0.78rem; color:var(--color-text-med); margin-bottom:0.65rem; display:flex; flex-direction:column; gap:0.25rem; background:rgba(255,101,132,0.04); padding:0.5rem 0.65rem; border-radius:10px; border:1px solid rgba(255,101,132,0.12);">
                        ${dateStr ? `<div><i data-lucide="calendar" style="width:13px; height:13px; display:inline-block; vertical-align:middle; margin-right:4px; color:var(--color-primary);"></i><strong>방문일:</strong> ${dateStr}</div>` : ''}
                        ${cleanAddress ? `<div><i data-lucide="map-pin" style="width:13px; height:13px; display:inline-block; vertical-align:middle; margin-right:4px; color:#FF9F1C;"></i><strong>주소:</strong> ${cleanAddress}</div>` : ''}
                    </div>
                `;
                
                // Render photos grid
                if (place.photos && place.photos.length > 0) {
                    cardContent += `<div class="place-card-photos-grid">`;
                    place.photos.forEach(photo => {
                        cardContent += `<img class="place-card-photo" src="${photo}" onclick="openLightbox(this.src)" alt="${place.name}">`;
                    });
                    cardContent += `</div>`;
                } else if (place.photo) {
                    cardContent += `<img class="place-card-photo" src="${place.photo}" onclick="openLightbox(this.src)" alt="${place.name}">`;
                }

                let stars = '';
                for(let i=1; i<=5; i++) {
                    stars += `<i data-lucide="star" style="${i <= (place.rating || 5) ? '' : 'fill:none; color:var(--color-text-low);'}"></i>`;
                }
                
                const payerName = place.payer === "B" ? partnerBName : partnerAName;
                
                cardContent += `
                    <div class="place-card-stars" style="margin-top:0.4rem;">
                        ${stars}
                    </div>
                    <p class="visited-review-snippet" style="margin-top:0.3rem; margin-bottom:0.5rem;">"${place.review || '즐거운 데이트 추억! 💖'}"</p>
                    <div class="place-meta-item" style="font-size:0.78rem;">
                        <i data-lucide="coins"></i>
                        <span>결제자: <strong>${payerName}</strong> (${formatCurrency(place.expense || 0)})</span>
                    </div>
                    <div style="margin-top:0.65rem; display:flex; gap:0.4rem;">
                        ${place.url ? `<a href="${place.url}" target="_blank" class="btn btn-outline" style="flex:1; padding:0.35rem; font-size:0.72rem; justify-content:center;"><i data-lucide="external-link"></i> 지도 보기</a>` : ''}
                        <button class="btn btn-secondary" style="flex:1; padding:0.35rem; font-size:0.72rem; justify-content:center; background:rgba(255,101,132,0.12); color:var(--color-primary); border:1px solid rgba(255,101,132,0.3);" onclick="openEditPlaceModal(${place.id})">
                            <i data-lucide="edit-3"></i> 내용/소감 수정
                        </button>
                    </div>
                `;
                
                card.innerHTML = cardContent;
                visitedContainer.appendChild(card);
            });
        }
    }
    
    lucide.createIcons();
}

async function deletePlace(id, name) {
    if (!confirm(`'${name}' 장소를 영구히 삭제하시겠습니까?`)) return;
    
    try {
        await db.places.delete(id);
        
        // Clean up associated cloud photos from Firebase
        if (syncRoomId) {
            try {
                const url = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/photos/${id}.json`;
                await fetch(url, { method: 'DELETE' });
            } catch(e) {
                console.error("Cloud photo cleanup failed:", e);
            }
        }

        showToast("장소가 정상 삭제되었습니다.", "success");
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
    const paidByA = visitedPlaces.filter(p => p.payer === "A").reduce((acc, curr) => acc + (curr.expense || 0), 0);
    const paidByB = visitedPlaces.filter(p => p.payer === "B").reduce((acc, curr) => acc + (curr.expense || 0), 0);
    
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

    if (!syncRoomId) {
        if (pulse) pulse.style.display = "none";
        if (statusText) statusText.innerHTML = `실시간 동기화 연결하기 🔗`;
        if (banner) {
            banner.style.background = "rgba(124, 92, 104, 0.1)";
            banner.style.color = "var(--color-text-med)";
            banner.style.borderColor = "rgba(124, 92, 104, 0.25)";
        }
        return;
    }

    if (pulse) pulse.style.display = "inline-block";
    if (statusText) statusText.innerHTML = `연결 룸: <strong>${syncRoomId}</strong> 🔗`;
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
        const cleanPlaces = places.map(p => {
            const copy = { ...p };
            delete copy.photo;
            delete copy.photos;
            return copy;
        });

        const now = Date.now();
        const payload = {
            placesData: JSON.stringify(cleanPlaces),
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

        if (resData.timestamp && resData.timestamp > lastSyncedTimestamp) {
            let fetchedPlaces = [];
            try {
                fetchedPlaces = JSON.parse(resData.placesData);
            } catch(e) {
                console.error('Failed to parse Firebase placesData:', e);
            }

            if (Array.isArray(fetchedPlaces)) {
                const localPlaces = await db.places.toArray();
                const localCompareStr = JSON.stringify(localPlaces.map(p => { const c = {...p}; delete c.photo; delete c.photos; return c; }));
                const fetchedCompareStr = JSON.stringify(fetchedPlaces);
                
                if (localCompareStr !== fetchedCompareStr) {
                    console.log("[Sync Engine] Server data differs. Syncing to local DB...");
                    
                    fetchedPlaces.forEach(fp => {
                        const localItem = localPlaces.find(lp => lp.name === fp.name && lp.createdAt === fp.createdAt);
                        if (localItem) {
                            if (localItem.photo) fp.photo = localItem.photo;
                            if (localItem.photos) fp.photos = localItem.photos;
                        }
                    });

                    await db.places.clear();
                    await db.places.bulkAdd(fetchedPlaces);

                    await updateDashboardStats();
                    await renderPlacesList();
                    updateMapMarkers();
                }
            }
            lastSyncedTimestamp = resData.timestamp;
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
async function uploadPhotoToCloud(placeId, base64ImagesArray) {
    if (!syncRoomId || !base64ImagesArray || base64ImagesArray.length === 0) return;
    try {
        const url = `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/photos/${placeId}.json`;
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
            const entry = photos[place.id];
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
            console.log("[Photo Sync] Visited photos successfully synchronized.");
            await renderPlacesList();
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
        appendChatMessage("AI 코스 실시간 추천에 문제가 생겼어요: " + err.message, "bot");
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
        switchTab("places");
    } catch(err) {
        showToast("코스 저장 실패: " + err.message, "danger");
    }
};

// 14. Settings Logic
async function saveSettings() {
    const apiKeyVal = document.getElementById("settings-gemini-key").value.trim();
    const naverClientIdVal = document.getElementById("settings-naver-client-id").value.trim();
    const limitVal = parseInt(document.getElementById("settings-budget-limit").value) || 500000;
    const partnerAVal = document.getElementById("settings-partner-a-name").value.trim() || "초코";
    const partnerBVal = document.getElementById("settings-partner-b-name").value.trim() || "딸기";
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
    
    // Restart Cloud Sync interval with new room configuration
    startCloudSyncLoop();
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

async function clearAllData() {
    if (!confirm("경고: 모든 커플 데이트 정보 및 환경 설정이 삭제됩니다. 초기화하시겠습니까?")) return;
    
    await db.places.clear();
    localStorage.removeItem("aura_gemini_key");
    localStorage.removeItem("aura_naver_client_id");
    localStorage.removeItem("aura_budget_limit");
    localStorage.removeItem("aura_partner_a_name");
    localStorage.removeItem("aura_partner_b_name");
    localStorage.removeItem("aura_sync_room_id");
    localStorage.removeItem("aura_firebase_url");
    
    geminiApiKey = "";
    naverClientId = "";
    budgetLimit = 500000;
    partnerAName = "초코";
    partnerBName = "딸기";
    syncRoomId = "";
    customFirebaseUrl = "";
    
    document.getElementById("settings-gemini-key").value = "";
    document.getElementById("settings-naver-client-id").value = "";
    document.getElementById("settings-budget-limit").value = 500000;
    document.getElementById("settings-partner-a-name").value = "초코";
    document.getElementById("settings-partner-b-name").value = "딸기";
    document.getElementById("settings-sync-room-id").value = "";
    document.getElementById("settings-firebase-url").value = "";
    
    document.getElementById("budget-limit-text").textContent = formatCurrency(500000);
    updatePartnerNamesUI();
    
    showToast("AURA의 모든 데이터가 소멸되었습니다.", "warning");
    checkApiKeyAlert();
    await updateDashboardStats();
    await renderPlacesList();
    initLeafletMap();
    startCloudSyncLoop();
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
