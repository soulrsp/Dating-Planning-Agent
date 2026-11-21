// meals.js — 🍳 서나네 식탁: home-cooked meals, a dashboard tile that opens a month-grouped feed.
//
// Loaded as a plain script after together.js and shares its globals: couple (who "me" is, the pet's
// birth time, couple.versions), coupleUrl, coupleName, coupleYmd, coupleRender, coupleAfterPoints, plus
// app.js's escapeHtml, jsArg, showToast, showConfirmModal, compressBase64Image, openCommentSheet and the
// emoji helpers. couple.js calls in behind typeof guards (mealsStart, mealsAfterPoll, mealsPoints).
// Both partners post meals; who cooked is deliberately not shown (it's 서나's table).
//
// Cloud layout (under aura-rooms/{room}/):
//   meals/{id}        = { name, time, date, at, n, recipe, notes:{A,B}, hearts:{A,B}, again:{A,B} }
//                       text only, so the whole list stays small; one node per meal. Shared fields are
//                       PATCHed; notes/hearts/again are leaves each partner writes only for themself.
//   mealThumbs/{id}   = [data URL …]  the first two photos at ~360px, fetched as cards scroll into view.
//   mealPhotos/{id}   = [data URL …]  every photo at 1600px, fetched only when one is opened or edited.
//   couple/versions/meals = ms  bumped on every change (couple.js reads couple/ on each poll).
// A meal dated on or after the character's birthday is worth MEAL_POINTS (derived, never stored).

const MEAL_TIMES = [["breakfast", "🌅", "아침"], ["lunch", "☀️", "점심"], ["dinner", "🌙", "저녁"], ["night", "🌃", "야식"]];
const MEAL_MAX_PHOTOS = 4;
const MEAL_POINTS = 2;

const meals = {
    room: null,
    items: {},            // id → meal
    loaded: 0,            // the couple/versions/meals value we last fetched
    ready: false,
    thumbs: new Map(),    // id → [data URL] (this session)
    observer: null,
    ui: { filter: "all", q: "", recipeOpen: new Set(), menuId: null },
    draft: null           // editor state: { id, photos:[{full, thumb}], photosChanged, time, busy }
};

async function mealsFetch(sub, method = "GET", value) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 20000);
    try {
        const opts = { method, signal: controller.signal };
        if (value !== undefined) { opts.headers = { "Content-Type": "application/json" }; opts.body = JSON.stringify(value); }
        const res = await fetch(coupleUrl(sub) + (method === "GET" ? "" : "?print=silent"), opts);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return method === "GET" ? await res.json() : null;
    } finally { clearTimeout(t); }
}

async function mealsBump() {
    const now = Date.now();
    meals.loaded = now;
    if (couple.versions) couple.versions.meals = now;
    await mealsFetch("couple/versions/meals", "PUT", now);
}

async function mealsLoad() {
    const data = await mealsFetch("meals");
    meals.items = data && typeof data === "object" ? data : {};
    meals.ready = true;
}

// couple.js: once at start-up.
window.mealsStart = async function() {
    if (meals.room !== syncRoomId) {
        meals.room = syncRoomId;
        meals.items = {}; meals.loaded = 0; meals.ready = false; meals.thumbs.clear();
    }
    const v = (couple.versions || {}).meals || 0;
    try { await mealsLoad(); meals.loaded = v; } catch (e) { console.warn("[Meals] load failed", e); }
    mealsRefresh();
};

// couple.js: after every poll of couple/. Refetch when the other phone changed something.
window.mealsAfterPoll = async function() {
    const v = (couple.versions || {}).meals || 0;
    if (v <= meals.loaded) return;
    const before = typeof couplePoints === "function" ? couplePoints() : 0;
    try { await mealsLoad(); meals.loaded = v; } catch (e) { console.warn("[Meals] refresh failed", e); return; }
    meals.thumbs.clear();   // photos may have been replaced
    mealsRefresh();
    if (typeof couplePoints === "function" && couplePoints() !== before && typeof coupleRender === "function") coupleRender();
};

window.mealsPoints = function() {
    const born = Number(couple.pet && couple.pet.bornAt) || Infinity;
    if (!isFinite(born)) return 0;
    const bornDay = coupleYmd(new Date(born));
    return MEAL_POINTS * mealsList().filter(m => (m.date || "") >= bornDay).length;
};

function mealsList() {
    return Object.entries(meals.items).filter(([, m]) => m && m.name)
        .map(([id, m]) => Object.assign({ id }, m))
        .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.at || 0) - (a.at || 0));
}

function mealsRefresh() {
    const tile = document.getElementById("tile-meals-count");
    if (tile) { const n = mealsList().length; tile.textContent = n ? `${n}끼` : "차리기"; }
    if (document.getElementById("modal-meals")?.classList.contains("active")) mealsRender();
}

function mealsMe() {
    if (couple.me) return couple.me;
    showToast("오늘의 우리 카드에서 내가 누구인지 먼저 골라 주세요", "info");
    return null;
}

function mealsTimeLook(time) { return MEAL_TIMES.find(t => t[0] === time) || ["", "🍽️", ""]; }

function mealsDefaultTime() {
    const h = new Date().getHours();
    return h < 10 ? "breakfast" : h < 15 ? "lunch" : h < 21 ? "dinner" : "night";
}

function mealsShortDate(ymd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || "")) return "";
    const [y, m, d] = ymd.split("-").map(Number);
    return `${m}.${d} ${"일월화수목금토"[new Date(y, m - 1, d).getDay()]}`;
}

// ── Feed ─────────────────────────────────────────────────────────────────────────────────────────
window.mealsOpen = function() {
    meals.ui.menuId = null;
    mealsRender();
    document.getElementById("modal-meals")?.classList.add("active");
    if (window.lucide) lucide.createIcons();
    if (!meals.ready) mealsLoad().then(mealsRefresh).catch(() => { });
};
window.mealsClose = function() {
    document.getElementById("modal-meals")?.classList.remove("active");
    if (meals.observer) { meals.observer.disconnect(); meals.observer = null; }
};

function mealsSummaryHtml(list) {
    const ym = coupleYmd().slice(0, 7);
    const month = list.filter(m => (m.date || "").startsWith(ym)).length;
    const count = new Map();
    list.forEach(m => { const k = placeSearchName(m.name); count.set(k, (count.get(k) || 0) + 1); });
    const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    const hearts = list.flatMap(m => Object.values(m.hearts || {}).map(Number).filter(n => n > 0));
    const avg = hearts.length ? (hearts.reduce((a, b) => a + b, 0) / hearts.length).toFixed(1) : "";
    const topMeal = top && top[1] >= 2 ? list.find(m => placeSearchName(m.name) === top[0]) : null;
    return `<div class="meals-hero">
        <small>서나네 식탁</small>
        <b>${list.length ? `${list.length}번째 집밥 🍚` : "첫 집밥을 올려 주세요 🍚"}</b>
        <div class="meals-hero-chips">
            <span>이번 달 ${month}끼</span>
            ${topMeal ? `<span>최애 ${escapeHtml(topMeal.name)} ×${top[1]}</span>` : ""}
            ${avg ? `<span>평균 ♥ ${avg}</span>` : ""}
        </div></div>`;
}

function mealsAgainHtml(list) {
    const seen = new Set();
    const wants = list.filter(m => m.again && Object.keys(m.again).length)
        .sort((a, b) => Math.max(...Object.values(b.again)) - Math.max(...Object.values(a.again)))
        .filter(m => { const k = placeSearchName(m.name); if (seen.has(k)) return false; seen.add(k); return true; });
    if (!wants.length) return "";
    return `<div class="meals-sec-title">🙏 또 먹고 싶은 메뉴</div>
        <div class="meals-again">${wants.map(m => `<button type="button" onclick="mealsSearchFor(${jsArg(placeSearchName(m.name))})">${escapeHtml(m.name)}</button>`).join("")}</div>`;
}

function mealsHeartsHtml(m) {
    const me = couple.me;
    const mine = me ? Number((m.hearts || {})[me]) || 0 : 0;
    const other = me ? Number((m.hearts || {})[me === "A" ? "B" : "A"]) || 0 : 0;
    const btns = [1, 2, 3, 4, 5].map(n => `<button type="button" class="${n <= mine ? "on" : ""}" onclick="mealsSetHeart(${jsArg(m.id)}, ${n})" aria-label="${n}점">${n <= mine ? "❤️" : "🤍"}</button>`).join("");
    return `<span class="meal-hearts">${btns}${other ? `<small>${escapeHtml(coupleName(me === "A" ? "B" : "A"))} ♥${other}</small>` : ""}</span>`;
}

function mealCardHtml(m) {
    const n = Number(m.n) || 0;
    const [, icon, timeLabel] = mealsTimeLook(m.time);
    const shown = Math.min(n, 2);
    const photos = shown ? `<div class="meal-photos-view is-${shown}">${Array.from({ length: shown }, (_, k) =>
        `<button type="button" onclick="mealsOpenPhoto(${jsArg(m.id)}, ${k})"><img src="${LAZY_PIXEL}" data-meal="${escapeHtml(m.id)}" data-k="${k}" alt="">${k === 1 && n > 2 ? `<span class="meal-more">+${n - 2}</span>` : ""}</button>`).join("")}</div>` : "";
    const notes = m.notes || {};
    const bubble = who => {
        const text = String(notes[who] || "").trim();
        const mine = who === couple.me;
        if (!text && !mine) return "";
        return `<button type="button" class="meal-bubble${who === "B" ? " is-b" : ""}${text ? "" : " is-empty"}" ${mine ? `onclick="mealsEditNote(${jsArg(m.id)})"` : "disabled"}>${text ? `${escapeHtml(coupleName(who))} · ${escapeHtml(text)}` : `＋ ${escapeHtml(coupleName(who))} 한마디`}</button>`;
    };
    const iWant = couple.me && m.again && m.again[couple.me];
    const recipeOpen = meals.ui.recipeOpen.has(m.id);
    const menu = meals.ui.menuId === m.id;
    return `<div class="meal-card" id="meal-${escapeHtml(m.id)}">
        ${photos}
        <div class="meal-head"><b>${escapeHtml(m.name)}</b></div>
        <div class="meal-meta"><span>${escapeHtml(mealsShortDate(m.date))} · ${icon} ${timeLabel}${n > 2 ? ` · 사진 ${n}장` : ""}</span>${mealsHeartsHtml(m)}</div>
        <div class="meal-bubbles">${bubble("A")}${bubble("B")}</div>
        ${recipeOpen && m.recipe ? `<div class="meal-recipe">${escapeHtml(m.recipe).replace(/\n/g, "<br>")}</div>` : ""}
        <div class="meal-actions">
            <button type="button" class="${iWant ? "is-on" : ""}" onclick="mealsToggleAgain(${jsArg(m.id)})">${iWant ? "🙏 또 해줘 (요청함)" : "🙏 또 해줘"}</button>
            ${m.recipe ? `<button type="button" onclick="mealsToggleRecipeView(${jsArg(m.id)})">📝 레시피${recipeOpen ? " 접기" : ""}</button>` : ""}
            <button type="button" class="meal-more-btn" onclick="mealsToggleMenu(${jsArg(m.id)})" aria-label="더 보기">⋯</button>
        </div>
        ${menu ? `<div class="meal-menu"><button type="button" onclick="mealsOpenEditor(${jsArg(m.id)})">✏️ 고치기</button><button type="button" class="is-danger" onclick="mealsDelete(${jsArg(m.id)})">🗑 지우기</button></div>` : ""}
    </div>`;
}

function mealsRender() {
    const body = document.getElementById("meals-body");
    if (!body) return;
    const all = mealsList();
    const q = placeSearchName(meals.ui.q).toLowerCase();
    const list = all.filter(m => (meals.ui.filter === "all" || m.time === meals.ui.filter) &&
        (!q || placeSearchName(m.name).toLowerCase().includes(q) || String(m.recipe || "").toLowerCase().includes(q)));
    const groups = new Map();
    list.forEach(m => { const k = (m.date || "").slice(0, 7); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); });
    const filters = [["all", "전체"], ...MEAL_TIMES.map(t => [t[0], `${t[1]} ${t[2]}`])];
    const searchFocused = document.activeElement && document.activeElement.id === "meals-search";
    body.innerHTML = `${mealsSummaryHtml(all)}
        ${mealsAgainHtml(all)}
        <div class="meals-tools">
            <input type="search" id="meals-search" class="add-input" placeholder="🔍 메뉴 찾기" value="${escapeHtml(meals.ui.q)}" oninput="mealsSearch(this.value)">
        </div>
        <div class="meals-filters">${filters.map(([k, label]) => `<button type="button" class="${meals.ui.filter === k ? "on" : ""}" onclick="mealsSetFilter(${jsArg(k)})">${label}</button>`).join("")}</div>
        ${!all.length ? `<div class="meals-empty">아직 올린 집밥이 없어요.<br>오른쪽 위 ＋를 눌러 첫 식탁을 올려 보세요 🍳</div>`
            : !list.length ? `<div class="meals-empty">찾는 메뉴가 없어요</div>`
            : [...groups.entries()].map(([ym, ms]) => `<div class="meals-month">${ym ? `${ym.slice(0, 4)}년 ${Number(ym.slice(5, 7))}월` : "날짜 없음"} <span>· ${ms.length}끼</span></div>${ms.map(mealCardHtml).join("")}`).join("")}`;
    if (searchFocused) {
        const s = document.getElementById("meals-search");
        if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }
    mealsWatchThumbs(body);
}

function mealsWatchThumbs(root) {
    if (meals.observer) meals.observer.disconnect();
    const load = img => mealsThumb(img.dataset.meal).then(list => { if (list && list[+img.dataset.k]) img.src = list[+img.dataset.k]; });
    meals.observer = "IntersectionObserver" in window ? new IntersectionObserver(entries => {
        entries.forEach(en => { if (!en.isIntersecting) return; meals.observer.unobserve(en.target); load(en.target); });
    }, { root, rootMargin: "400px" }) : null;
    root.querySelectorAll("img[data-meal]").forEach(img => meals.observer ? meals.observer.observe(img) : load(img));
}

function mealsThumb(id) {
    if (!meals.thumbs.has(id)) {
        meals.thumbs.set(id, mealsFetch(`mealThumbs/${id}`).then(v => Array.isArray(v) ? v : []).catch(() => { meals.thumbs.delete(id); return []; }));
    }
    return meals.thumbs.get(id);
}

let mealsSearchTimer = null;
window.mealsSearch = function(v) {
    meals.ui.q = v;
    clearTimeout(mealsSearchTimer);
    mealsSearchTimer = setTimeout(mealsRender, 200);
};
window.mealsSearchFor = function(name) { meals.ui.q = name; meals.ui.filter = "all"; mealsRender(); };
window.mealsSetFilter = function(k) { meals.ui.filter = k; mealsRender(); };
window.mealsToggleMenu = function(id) { meals.ui.menuId = meals.ui.menuId === id ? null : id; mealsRender(); };
window.mealsToggleRecipeView = function(id) {
    if (meals.ui.recipeOpen.has(id)) meals.ui.recipeOpen.delete(id); else meals.ui.recipeOpen.add(id);
    mealsRender();
};

window.mealsOpenPhoto = async function(id, k) {
    const lightbox = document.getElementById("modal-photo-viewer"), img = document.getElementById("lightbox-img");
    if (!lightbox || !img) return;
    const thumbs = await mealsThumb(id);
    img.src = thumbs[k] || "";
    lightbox.classList.add("active");
    try {
        const full = await mealsFetch(`mealPhotos/${id}`);
        if (Array.isArray(full) && full[k] && lightbox.classList.contains("active")) img.src = full[k];
    } catch (_) { }
};

// ── Reactions (each partner writes only their own leaf) ─────────────────────────────────────────
async function mealsWriteLeaf(id, path, value) {
    const m = meals.items[id];
    if (!m) return false;
    try {
        await mealsFetch(`meals/${id}/${path}`, value == null ? "DELETE" : "PUT", value == null ? undefined : value);
        mealsBump().catch(() => { });
        return true;
    } catch (e) { showToast("저장하지 못했어요. 인터넷 연결을 확인해 주세요", "danger"); return false; }
}

window.mealsSetHeart = async function(id, n) {
    const me = mealsMe(), m = meals.items[id];
    if (!me || !m) return;
    const cur = Number((m.hearts || {})[me]) || 0;
    const next = cur === n ? null : n;   // tapping your current score clears it
    if (!(await mealsWriteLeaf(id, `hearts/${me}`, next))) return;
    m.hearts = Object.assign({}, m.hearts);
    if (next == null) delete m.hearts[me]; else m.hearts[me] = next;
    mealsRender();
};

window.mealsToggleAgain = async function(id) {
    const me = mealsMe(), m = meals.items[id];
    if (!me || !m) return;
    const next = m.again && m.again[me] ? null : Date.now();
    if (!(await mealsWriteLeaf(id, `again/${me}`, next))) return;
    m.again = Object.assign({}, m.again);
    if (next == null) delete m.again[me]; else m.again[me] = next;
    mealsRender();
    if (next) showToast(`🙏 '${m.name}' 또 먹고 싶은 메뉴에 담았어요`, "success");
};

window.mealsEditNote = async function(id) {
    const me = mealsMe(), m = meals.items[id];
    if (!me || !m) return;
    const thumbs = await mealsThumb(id);
    openCommentSheet({
        title: m.name,
        meta: `${mealsShortDate(m.date)} · ${mealsTimeLook(m.time)[2]}`,
        label: `💬 ${coupleName(me)} 한마디`,
        thumb: thumbs[0] || "", icon: "🍳", tint: "#FFE9DC",
        value: (m.notes || {})[me] || "",
        front: ["😋", "🤤", "💯", "🥰"],
        onSave: async val => {
            if (!(await mealsWriteLeaf(id, `notes/${me}`, val || null))) return;
            m.notes = Object.assign({}, m.notes);
            if (val) m.notes[me] = val; else delete m.notes[me];
            mealsRender();
        }
    });
};

// ── Editor (new meal or edit) ────────────────────────────────────────────────────────────────────
window.mealsOpenEditor = async function(id) {
    const m = id ? meals.items[id] : null;
    if (id && !m) return;
    meals.ui.menuId = null;
    meals.draft = { id: id || null, photos: [], photosChanged: false, time: m ? m.time : mealsDefaultTime(), busy: false, loadingPhotos: !!(m && m.n) };
    document.getElementById("meal-edit-title").textContent = m ? "✏️ 집밥 고치기" : "🍳 오늘의 집밥 올리기";
    document.getElementById("meal-save-btn").textContent = m ? "저장" : "🍳 올리기";
    document.getElementById("meal-name").value = m ? m.name : "";
    document.getElementById("meal-date").value = m ? m.date : coupleYmd();
    document.getElementById("meal-note").value = m && couple.me ? ((m.notes || {})[couple.me] || "") : "";
    const recipe = document.getElementById("meal-recipe");
    recipe.value = m ? (m.recipe || "") : "";
    recipe.classList.toggle("hidden", !recipe.value);
    document.getElementById("meal-recipe-toggle").classList.toggle("hidden", !!recipe.value);
    if (typeof emojiFieldReset === "function") { emojiFieldReset("meal-name"); emojiFieldReset("meal-note"); }
    mealsRenderEditor();
    document.getElementById("modal-meal-edit")?.classList.add("active");
    if (window.lucide) lucide.createIcons();
    if (m && m.n) {
        // Editing keeps the stored photos unless the person adds or removes one.
        try {
            const [full, thumbs] = await Promise.all([mealsFetch(`mealPhotos/${id}`), mealsThumb(id)]);
            if (meals.draft && meals.draft.id === id) {
                meals.draft.photos = (Array.isArray(full) ? full : []).map((f, i) => ({ full: f, thumb: (thumbs || [])[i] || f }));
                meals.draft.loadingPhotos = false;
                mealsRenderEditor();
            }
        } catch (_) {
            if (meals.draft) { meals.draft.loadingPhotos = false; meals.draft.photosFailed = true; mealsRenderEditor(); }
        }
    }
};
window.mealsCloseEditor = function() {
    document.getElementById("modal-meal-edit")?.classList.remove("active");
    document.getElementById("meal-name")?.blur();
    meals.draft = null;
};
window.mealsToggleRecipe = function() {
    document.getElementById("meal-recipe")?.classList.remove("hidden");
    document.getElementById("meal-recipe-toggle")?.classList.add("hidden");
    document.getElementById("meal-recipe")?.focus();
};

function mealsRenderEditor() {
    const d = meals.draft;
    if (!d) return;
    const box = document.getElementById("meal-photos");
    if (box) {
        box.innerHTML = d.loadingPhotos ? `<div class="meal-photo-note">사진 불러오는 중…</div>`
            : d.photos.map((p, i) => `<div class="meal-photo"><img src="${escapeHtml(p.thumb)}" alt=""><button type="button" onclick="mealsRemovePhoto(${i})" aria-label="사진 빼기">✕</button></div>`).join("")
            + (d.photos.length < MEAL_MAX_PHOTOS && !d.photosFailed ? `<button type="button" class="meal-photo-add" onclick="document.getElementById('meal-photo-input').click()"><span>📷</span>사진 추가</button>` : "")
            + (d.photosFailed ? `<div class="meal-photo-note">사진을 불러오지 못했어요. 사진은 그대로 두고 나머지만 저장돼요</div>` : "");
    }
    const chips = document.getElementById("meal-time-chips");
    if (chips) chips.innerHTML = MEAL_TIMES.map(([k, icon, label]) => `<button type="button" class="${d.time === k ? "is-on" : ""}" onclick="mealsSetTime(${jsArg(k)})">${icon} ${label}</button>`).join("");
    const btn = document.getElementById("meal-save-btn");
    if (btn) btn.disabled = !!(d.busy || d.loadingPhotos);
}

window.mealsSetTime = function(k) { if (meals.draft) { meals.draft.time = k; mealsRenderEditor(); } };
window.mealsRemovePhoto = function(i) {
    const d = meals.draft;
    if (!d) return;
    d.photos.splice(i, 1);
    d.photosChanged = true;
    mealsRenderEditor();
};
window.mealsPickPhotos = async function(input) {
    const d = meals.draft;
    const files = Array.from(input.files || []).slice(0, MEAL_MAX_PHOTOS - (d ? d.photos.length : 0));
    input.value = "";
    if (!d || !files.length) return;
    d.busy = true;
    mealsRenderEditor();
    for (const file of files) {
        const src = await new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result || "")); r.onerror = () => res(""); r.readAsDataURL(file); });
        const full = src ? await compressBase64Image(src, 1600, 1600, 0.82) : "";
        const thumb = src ? await compressBase64Image(src, 360, 360, 0.72) : "";
        if (!full || !full.startsWith("data:image")) { showToast("읽을 수 없는 사진은 건너뛰었어요", "warning"); continue; }
        if (meals.draft !== d) return;   // the editor was closed meanwhile
        d.photos.push({ full, thumb });
        d.photosChanged = true;
    }
    d.busy = false;
    mealsRenderEditor();
};

window.mealsSave = async function() {
    const d = meals.draft;
    if (!d || d.busy || d.loadingPhotos) return;
    const me = mealsMe();
    if (!me) return;
    const name = document.getElementById("meal-name").value.replace(/\s+/g, " ").trim();
    if (!name) { showToast("메뉴 이름을 적어 주세요", "info"); document.getElementById("meal-name").focus(); return; }
    const date = document.getElementById("meal-date").value || coupleYmd();
    const note = document.getElementById("meal-note").value.replace(/\s+/g, " ").trim();
    const recipe = document.getElementById("meal-recipe").value.trim();
    const old = d.id ? meals.items[d.id] : null;
    const id = d.id || `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    d.busy = true;
    mealsRenderEditor();
    const before = typeof couplePoints === "function" ? couplePoints() : 0;
    try {
        if (d.photosChanged) {
            if (d.photos.length) {
                await mealsFetch(`mealPhotos/${id}`, "PUT", d.photos.map(p => p.full));
                await mealsFetch(`mealThumbs/${id}`, "PUT", d.photos.slice(0, 2).map(p => p.thumb));
            } else if (old) {
                await mealsFetch(`mealPhotos/${id}`, "DELETE");
                await mealsFetch(`mealThumbs/${id}`, "DELETE");
            }
            meals.thumbs.set(id, Promise.resolve(d.photos.slice(0, 2).map(p => p.thumb)));
        }
        const fields = { name, time: d.time, date, recipe: recipe || null };
        if (d.photosChanged) fields.n = d.photos.length;
        if (!old) {
            const rec = Object.assign({ at: Date.now(), n: d.photos.length }, fields);
            if (note) rec.notes = { [me]: note };
            await mealsFetch(`meals/${id}`, "PUT", rec);
            meals.items[id] = rec;
        } else {
            // Only what changed, so the partner's reactions and anything they edited meanwhile stay.
            const patch = {};
            Object.keys(fields).forEach(k => { if ((old[k] ?? null) !== fields[k]) patch[k] = fields[k]; });
            if (Object.keys(patch).length) await mealsFetch(`meals/${id}`, "PATCH", patch);
            const oldNote = (old.notes || {})[me] || "";
            if (note !== oldNote) await mealsFetch(`meals/${id}/notes/${me}`, note ? "PUT" : "DELETE", note || undefined);
            Object.assign(old, patch);
            old.notes = Object.assign({}, old.notes);
            if (note) old.notes[me] = note; else delete old.notes[me];
        }
        await mealsBump().catch(() => { });
    } catch (e) {
        console.warn("[Meals] save failed", e);
        if (meals.draft === d) { d.busy = false; mealsRenderEditor(); }
        showToast("저장하지 못했어요. 인터넷 연결을 확인해 주세요", "danger");
        return;
    }
    mealsCloseEditor();
    mealsRefresh();
    showToast(old ? "고쳤어요 ✏️" : `🍳 '${name}' 식탁에 올렸어요!`, "success");
    if (!old) {
        if (typeof coupleAfterPoints === "function") coupleAfterPoints(before);
        if (typeof coupleAnimate === "function") setTimeout(() => coupleAnimate("love"), 300);
    }
};

window.mealsDelete = async function(id) {
    const m = meals.items[id];
    if (!m) return;
    if (!(await showConfirmModal(`'${m.name}'을(를) 식탁에서 지울까요?\n사진과 한마디도 함께 지워져요.`))) return;
    try {
        await mealsFetch(`meals/${id}`, "DELETE");
        mealsFetch(`mealPhotos/${id}`, "DELETE").catch(() => { });
        mealsFetch(`mealThumbs/${id}`, "DELETE").catch(() => { });
        delete meals.items[id];
        meals.thumbs.delete(id);
        await mealsBump().catch(() => { });
    } catch (e) { showToast("지우지 못했어요", "danger"); return; }
    meals.ui.menuId = null;
    mealsRefresh();
    if (typeof coupleRender === "function") coupleRender();
};
