// together.js — 🪣 우리의 버킷리스트 and 📖 서로 사용 설명서 (the two tiles under the dashboard stats).
//
// Loaded as a plain script after couple.js and shares its globals: couple (who "me" is, the pet's
// birth time, couple.versions), coupleUrl, coupleName, coupleOther, coupleChooseMe, coupleRender,
// coupleAfterPoints, couplePoints, plus app.js's escapeHtml, jsArg, showToast, showConfirmModal,
// compressBase64Image, coupleDates / birthdayDatesInYear / coupleEventsOnDate. couple.js calls in
// behind typeof guards (togetherStart, togetherAfterPoll, togetherBucketPoints, togetherBadgeStats),
// and course.js reads both partners' food notes through togetherManualFoodNotes().
//
// Cloud layout (under aura-rooms/{room}/):
//   bucket/{id}          = { t, e, by, at, done, doneBy, memo, thumb, photo }
//                          one node per item, so adding or ticking one never rewrites the others;
//                          edits PATCH only the fields they change. Either partner may edit any item.
//   bucketPhotos/{id}    = data URL of the "we did it" photo, fetched only when someone opens it
//                          (the list itself carries a ~160px thumb).
//   manual/{A|B}         = { foodLove, foodNo, …, at }   each person writes only their own.
//   couple/versions/{bucket|manual} = ms   bumped on every change. couple.js already reads couple/
//                          whole on each poll, so the other phone notices without an extra request.
// A bucket item ticked after the character was born is worth 3 points (derived, like everything
// else in couple.js — never stored).

const BUCKET_CATS = [["✈️", "여행"], ["🍽️", "맛집"], ["🎢", "체험"], ["🎁", "기념일"], ["🏠", "일상"], ["💫", "언젠가"]];
const BUCKET_POINTS = 3;
const BUCKET_IDEAS = [
    ["✈️", "제주도 한 달 살기"], ["✈️", "같이 해외여행 가기"], ["✈️", "기차 타고 즉흥 여행"], ["✈️", "바다에서 해돋이 보기"],
    ["✈️", "벚꽃 명소로 여행 가기"], ["✈️", "캠핑카 여행"], ["🍽️", "오마카세 데이트"], ["🍽️", "서로에게 요리해 주기"],
    ["🍽️", "전국 빵지순례"], ["🍽️", "미슐랭 식당 가보기"], ["🍽️", "포장마차에서 우동 먹기"], ["🎢", "놀이공원 교복 데이트"],
    ["🎢", "커플 사진관에서 사진 찍기"], ["🎢", "반지 만들기 원데이 클래스"], ["🎢", "도자기 공방 체험"], ["🎢", "패러글라이딩"],
    ["🎢", "스키·보드 타러 가기"], ["🎢", "쏟아지는 별 보러 가기"], ["🎢", "같이 10km 마라톤 완주"], ["🎢", "방탈출 카페 탈출 성공"],
    ["🎁", "서로에게 손편지 쓰기"], ["🎁", "커플링 맞추기"], ["🎁", "1주년 여행"], ["🎁", "몰래 서프라이즈 해주기"],
    ["🎁", "타임캡슐 묻고 1년 뒤 열기"], ["🏠", "드라마 시리즈 하나 정주행"], ["🏠", "집에서 홈파티"], ["🏠", "반려식물 같이 키우기"],
    ["🏠", "하루 종일 휴대폰 없이 데이트"], ["🏠", "같은 책 읽고 얘기하기"], ["💫", "오로라 보러 가기"], ["💫", "서로의 가족과 함께 여행"],
    ["💫", "둘만의 노래 만들기"], ["💫", "같이 사는 집 꾸미기"]
];

const MANUAL_LOVE_LANGS = ["인정하는 말", "함께하는 시간", "선물", "도와주는 행동", "스킨십"];
const MANUAL_SECTIONS = [
    { title: "🍽️ 먹는 것", fields: [
        ["foodLove", "제일 좋아하는 음식", "예: 마라탕, 연어초밥"],
        ["foodNo", "못 먹거나 싫어하는 음식", "예: 오이, 고수"],
        ["allergy", "알레르기", "예: 갑각류, 복숭아"],
        ["coffee", "카페 단골 주문", "예: 아이스 바닐라라떼 샷 추가"],
        ["drink", "술 취향", "예: 하이볼, 소주는 반 병까지"]
    ] },
    { title: "🎁 선물 힌트", fields: [
        ["giftWant", "요즘 갖고 싶은 것", "예: 무선 이어폰, 향수"],
        ["flower", "좋아하는 꽃", "예: 튤립"],
        ["color", "좋아하는 색", "예: 연보라"],
        ["brand", "좋아하는 브랜드", "예: 무인양품"]
    ] },
    { title: "📏 사이즈", fields: [
        ["top", "상의", "예: M (95)"],
        ["bottom", "하의", "예: 28"],
        ["shoe", "신발", "예: 240"],
        ["ring", "반지 (호수)", "예: 9호"]
    ] },
    { title: "💗 마음 사용법", fields: [
        ["loveLang", "이럴 때 제일 사랑받는다고 느껴요", "", MANUAL_LOVE_LANGS],
        ["cheerUp", "기분이 안 좋을 때 이렇게 해주세요", "예: 말없이 안아주기, 떡볶이"],
        ["upsetSign", "서운할 때 나오는 신호", "예: 답장이 짧아져요"],
        ["happy", "이러면 무조건 행복해요", "예: 갑자기 꽃 사 오기"]
    ] },
    { title: "📝 그 밖에", fields: [["memo", "자유롭게", "알아두면 좋은 것들"]] }
];
const MANUAL_FIELDS = MANUAL_SECTIONS.flatMap(s => s.fields.map(f => f[0]));
const MANUAL_MASTER_FILLED = 10;

const together = {
    room: null,
    bucket: {},          // id → item
    manual: {},          // { A: {...}, B: {...} }
    loaded: { bucket: 0, manual: 0 },   // the couple/versions value we last fetched
    bucketLoaded: false,
    manualLoaded: false,
    ui: { tab: "todo", cat: "💫", ideas: false, doneId: null, doneDraft: null, menuId: null, manualTab: null, editing: false }
};

function togetherCacheKey() { return `aura_together_${syncRoomId}`; }
function togetherSaveCache() {
    try { localStorage.setItem(togetherCacheKey(), JSON.stringify({ bucket: together.bucket, manual: together.manual })); } catch (_) { }
}
function togetherLoadCache() {
    try {
        const c = JSON.parse(localStorage.getItem(togetherCacheKey()) || "null") || {};
        together.bucket = c.bucket || {};
        together.manual = c.manual || {};
    } catch (_) { together.bucket = {}; together.manual = {}; }
}

async function togetherFetch(sub, method = "GET", value) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    try {
        const opts = { method, signal: controller.signal };
        if (value !== undefined) { opts.headers = { "Content-Type": "application/json" }; opts.body = JSON.stringify(value); }
        const res = await fetch(coupleUrl(sub) + (method === "GET" ? "" : "?print=silent"), opts);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return method === "GET" ? await res.json() : null;
    } finally { clearTimeout(t); }
}

async function togetherBump(kind) {
    const now = Date.now();
    together.loaded[kind] = now;
    if (couple.versions) couple.versions[kind] = now;
    await togetherFetch(`couple/versions/${kind}`, "PUT", now);
}

async function togetherLoadBucket() {
    const data = await togetherFetch("bucket");
    together.bucket = data && typeof data === "object" ? data : {};
    together.bucketLoaded = true;
}
async function togetherLoadManual() {
    const data = await togetherFetch("manual");
    together.manual = data && typeof data === "object" ? data : {};
    together.manualLoaded = true;
}

// couple.js: once at start-up (after couple/ is read, before points are first counted).
window.togetherStart = async function() {
    if (together.room !== syncRoomId) {
        together.room = syncRoomId;
        together.bucketLoaded = together.manualLoaded = false;
        together.loaded = { bucket: 0, manual: 0 };
        togetherLoadCache();
    }
    togetherRenderTiles();
    const v = couple.versions || {};
    await Promise.all([
        togetherLoadBucket().then(() => { together.loaded.bucket = v.bucket || 0; }).catch(e => console.warn("[Together] bucket load failed", e)),
        togetherLoadManual().then(() => { together.loaded.manual = v.manual || 0; }).catch(e => console.warn("[Together] manual load failed", e))
    ]);
    togetherSaveCache();
    togetherRefresh();
};

// couple.js: after every poll of couple/. Refetch whatever the other phone changed.
window.togetherAfterPoll = async function() {
    const v = couple.versions || {};
    const jobs = [];
    if ((v.bucket || 0) > together.loaded.bucket) {
        const ver = v.bucket;
        jobs.push(togetherLoadBucket().then(() => { together.loaded.bucket = ver; }));
    }
    if ((v.manual || 0) > together.loaded.manual) {
        const ver = v.manual;
        jobs.push(togetherLoadManual().then(() => { together.loaded.manual = ver; }));
    }
    if (!jobs.length) return;
    const before = typeof couplePoints === "function" ? couplePoints() : 0;
    try { await Promise.all(jobs); } catch (e) { console.warn("[Together] refresh failed", e); return; }
    togetherSaveCache();
    togetherRefresh();
    if (typeof couplePoints === "function" && couplePoints() !== before && typeof coupleRender === "function") coupleRender();
};

window.togetherBucketPoints = function() {
    const born = Number(couple.pet && couple.pet.bornAt) || Infinity;
    return BUCKET_POINTS * Object.values(together.bucket).filter(it => it && it.done && it.done >= born).length;
};

function togetherFilledCount(who) {
    const m = together.manual[who] || {};
    return MANUAL_FIELDS.filter(k => String(m[k] || "").trim()).length;
}

window.togetherBadgeStats = function() {
    const items = Object.values(together.bucket).filter(Boolean);
    return {
        bucketDone: items.filter(it => it.done).length,
        bucketAll: items.length,
        manualBoth: togetherFilledCount("A") >= MANUAL_MASTER_FILLED && togetherFilledCount("B") >= MANUAL_MASTER_FILLED ? 1 : 0
    };
};

// course.js: both partners' food notes for the AI planner (only what's about eating and drinking).
window.togetherManualFoodNotes = function() {
    const labels = { foodLove: "loves", foodNo: "won't eat", allergy: "ALLERGIC TO", drink: "drinks", coffee: "usual coffee order" };
    return ["A", "B"].map(who => {
        const m = together.manual[who] || {};
        const bits = Object.keys(labels).filter(k => String(m[k] || "").trim()).map(k => `${labels[k]}: ${String(m[k]).trim()}`);
        return bits.length ? `- ${coupleName(who)}: ${bits.join("; ")}` : "";
    }).filter(Boolean).join("\n");
};

function togetherRefresh() {
    togetherRenderTiles();
    if (document.getElementById("modal-together-bucket")?.classList.contains("active")) togetherRenderBucket();
    if (document.getElementById("modal-together-manual")?.classList.contains("active") && !together.ui.editing) togetherRenderManual();
}

// ── Dashboard tiles ──────────────────────────────────────────────────────────────────────────────
function togetherUpcoming(days = 30) {
    const out = [];
    try {
        const today = new Date();
        for (let i = 0; i <= days; i++) {
            const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
            for (const e of coupleEventsOnDate(d)) {
                if (e.kind === "anniv" && i > 14) continue;
                out.push(Object.assign({ dday: i }, e));
            }
        }
    } catch (_) { }
    return out;
}

function togetherRenderTiles() {
    const items = Object.values(together.bucket).filter(Boolean);
    const done = items.filter(it => it.done).length;
    const b = document.getElementById("tile-bucket-count");
    if (b) b.textContent = items.length ? `${done}/${items.length}` : "담기";
    const m = document.getElementById("tile-manual-note");
    if (!m) return;
    const next = togetherUpcoming(14)[0];
    if (next) m.textContent = `${next.icon} ${next.dday === 0 ? "오늘!" : `D-${next.dday}`}`;
    else if (couple.me && !togetherFilledCount(couple.me)) m.textContent = "✍️ 쓰기";
    else m.textContent = "보기";
}

// ── Bucket list ──────────────────────────────────────────────────────────────────────────────────
window.togetherOpenBucket = function() {
    together.ui.doneId = together.ui.menuId = null;
    togetherRenderBucket();
    document.getElementById("modal-together-bucket")?.classList.add("active");
};
window.togetherCloseBucket = function() { document.getElementById("modal-together-bucket")?.classList.remove("active"); };

function togetherFmtDate(ms) { const d = new Date(ms); return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`; }

function togetherItemHtml(id, it) {
    const ui = together.ui;
    const by = it.by ? `${escapeHtml(coupleName(it.by))}가 담음` : "";
    let html;
    if (it.done) {
        html = `<li class="tg-item is-done">
            ${it.thumb ? `<button type="button" class="tg-thumb" onclick="togetherOpenPhoto(${jsArg(id)})"><img src="${escapeHtml(it.thumb)}" alt=""></button>` : `<span class="tg-check is-on">✓</span>`}
            <div class="tg-item-body">
                <div class="tg-item-text">${escapeHtml(it.e || "💫")} ${escapeHtml(it.t)}</div>
                <div class="tg-item-sub">🎉 ${togetherFmtDate(it.done)} 이뤘어요${it.doneBy ? ` · ${escapeHtml(coupleName(it.doneBy))}` : ""}</div>
                ${it.memo ? `<div class="tg-item-memo">“${escapeHtml(it.memo)}”</div>` : ""}
            </div>
            <button type="button" class="tg-more" onclick="togetherToggleMenu(${jsArg(id)})" aria-label="더보기">⋯</button>
        </li>`;
    } else {
        html = `<li class="tg-item">
            <button type="button" class="tg-check" onclick="togetherStartDone(${jsArg(id)})" title="이뤘어요"></button>
            <div class="tg-item-body">
                <div class="tg-item-text">${escapeHtml(it.e || "💫")} ${escapeHtml(it.t)}</div>
                <div class="tg-item-sub">${by}${by ? " · " : ""}${togetherFmtDate(it.at || Date.now())}</div>
            </div>
            <button type="button" class="tg-more" onclick="togetherToggleMenu(${jsArg(id)})" aria-label="더보기">⋯</button>
        </li>`;
    }
    if (ui.doneId === id) {
        const dr = ui.doneDraft || {};
        html += `<li class="tg-panel">
            <div class="tg-panel-title">🎉 '${escapeHtml(it.t)}' 이뤘어요!</div>
            <label class="tg-panel-row">언제 <input type="date" id="tg-done-date" value="${escapeHtml(dr.date || "")}" max="${coupleYmd()}"></label>
            <input type="text" id="tg-done-memo" class="course-input" maxlength="80" placeholder="한 줄 소감 (선택)" value="${escapeHtml(dr.memo || "")}">
            <div class="tg-panel-row">
                <label class="btn btn-outline tg-photo-btn">📷 인증 사진 ${dr.thumb ? "바꾸기" : "붙이기"}<input type="file" accept="image/*" hidden onchange="togetherPickPhoto(this)"></label>
                ${dr.thumb ? `<img class="tg-draft-thumb" src="${escapeHtml(dr.thumb)}" alt="">` : ""}
            </div>
            <div class="tg-panel-actions">
                <button type="button" class="btn btn-outline" onclick="togetherCancelDone()">취소</button>
                <button type="button" class="btn btn-primary" onclick="togetherSaveDone()" ${dr.busy ? "disabled" : ""}>${dr.busy ? "저장 중…" : "이뤘어요 🎉"}</button>
            </div>
        </li>`;
    }
    if (ui.menuId === id) {
        html += `<li class="tg-panel">
            <div class="tg-panel-row">
                <input type="text" id="tg-edit-text" class="course-input" maxlength="60" value="${escapeHtml(it.t)}">
                <button type="button" class="btn btn-outline" onclick="togetherSaveEdit(${jsArg(id)})">저장</button>
            </div>
            <div class="tg-panel-actions">
                ${it.done ? `<button type="button" class="couple-link" onclick="togetherUndoDone(${jsArg(id)})">↩ 아직 못 한 걸로 되돌리기</button>` : ""}
                <button type="button" class="couple-link tg-danger" onclick="togetherDeleteItem(${jsArg(id)})">🗑 지우기</button>
            </div>
        </li>`;
    }
    return html;
}

function togetherRenderBucket() {
    const body = document.getElementById("together-bucket-body");
    if (!body) return;
    const ui = together.ui;
    const entries = Object.entries(together.bucket).filter(([, it]) => it && it.t);
    const todo = entries.filter(([, it]) => !it.done).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    const done = entries.filter(([, it]) => it.done).sort((a, b) => (b[1].done || 0) - (a[1].done || 0));
    const pct = entries.length ? Math.round(done.length / entries.length * 100) : 0;
    const have = new Set(entries.map(([, it]) => it.t));
    const ideas = BUCKET_IDEAS.filter(([, t]) => !have.has(t));
    const list = ui.tab === "done" ? done : todo;
    body.innerHTML = `
        <div class="tg-sum">${entries.length ? `<b>${done.length}</b> / ${entries.length}개 이뤘어요` : "같이 해보고 싶은 걸 하나씩 담아 봐요"}
            <div class="tg-prog"><span style="width:${pct}%"></span></div>
            <div class="tg-sum-hint">하나 이룰 때마다 ${escapeHtml(couplePetName())}에게 +${BUCKET_POINTS}점 🌱</div>
        </div>
        <div class="tg-add">
            <div class="studio-chips">${BUCKET_CATS.map(([e, n]) => `<button type="button" class="studio-chip small${ui.cat === e ? " active" : ""}" onclick="togetherSetCat(${jsArg(e)})">${e} ${n}</button>`).join("")}</div>
            <div class="tg-add-row">
                <input type="text" id="tg-bucket-input" class="course-input" maxlength="60" placeholder="같이 해보고 싶은 것" onkeydown="if(event.key==='Enter'){event.preventDefault();togetherAddItem()}">
                <button type="button" class="btn btn-primary" onclick="togetherAddItem()">담기</button>
            </div>
            <button type="button" class="couple-link" onclick="togetherToggleIdeas()">💡 아이디어 ${ui.ideas ? "접기" : "보기"}</button>
            ${ui.ideas ? `<div class="studio-chips tg-ideas">${ideas.map(([e, t]) => `<button type="button" class="studio-chip small" onclick="togetherAddItem(${jsArg(t)}, ${jsArg(e)})">${e} ${escapeHtml(t)}</button>`).join("") || "<span class='tg-empty'>아이디어를 다 담았어요! 👏</span>"}</div>` : ""}
        </div>
        <div class="tg-tabs">
            <button type="button" class="${ui.tab === "todo" ? "active" : ""}" onclick="togetherSetTab('todo')">해볼 것 ${todo.length}</button>
            <button type="button" class="${ui.tab === "done" ? "active" : ""}" onclick="togetherSetTab('done')">이룬 것 ${done.length}</button>
        </div>
        <ul class="tg-list">${list.map(([id, it]) => togetherItemHtml(id, it)).join("") ||
            `<li class="tg-empty">${ui.tab === "done" ? "아직 이룬 게 없어요. 하나씩 해봐요! 💪" : "해볼 게 비었어요. 새로 담아 볼까요?"}</li>`}</ul>`;
}

window.togetherSetCat = function(e) { together.ui.cat = e; togetherRenderBucket(); document.getElementById("tg-bucket-input")?.focus(); };
window.togetherSetTab = function(t) { together.ui.tab = t; together.ui.doneId = together.ui.menuId = null; togetherRenderBucket(); };
window.togetherToggleIdeas = function() { together.ui.ideas = !together.ui.ideas; togetherRenderBucket(); };
window.togetherToggleMenu = function(id) {
    together.ui.menuId = together.ui.menuId === id ? null : id;
    together.ui.doneId = null;
    togetherRenderBucket();
};

window.togetherAddItem = async function(text, emoji) {
    const input = document.getElementById("tg-bucket-input");
    const t = String(text || (input && input.value) || "").trim().slice(0, 60);
    if (!t) { input?.focus(); return; }
    if (Object.values(together.bucket).some(it => it && it.t === t)) { showToast("이미 담겨 있어요 😊", "info"); return; }
    const id = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const item = { t, e: emoji || together.ui.cat || "💫", by: couple.me || null, at: Date.now() };
    together.bucket[id] = item;
    together.ui.tab = "todo";
    togetherSaveCache();
    togetherRefresh();
    try {
        await togetherFetch(`bucket/${id}`, "PUT", item);
        await togetherBump("bucket");
        showToast(`🪣 '${t}' 담았어요`, "success");
    } catch (e) {
        delete together.bucket[id];
        togetherSaveCache();
        togetherRefresh();
        showToast("담지 못했어요. 인터넷 연결을 확인해 주세요", "danger");
    }
    if (typeof coupleRender === "function") coupleRender();
};

window.togetherStartDone = function(id) {
    together.ui.doneId = id;
    together.ui.menuId = null;
    together.ui.doneDraft = { date: coupleYmd(), memo: "", thumb: "", photo: "" };
    togetherRenderBucket();
};
window.togetherCancelDone = function() { together.ui.doneId = null; together.ui.doneDraft = null; togetherRenderBucket(); };

function togetherKeepDraftInputs() {
    const dr = together.ui.doneDraft;
    if (!dr) return;
    const d = document.getElementById("tg-done-date"), m = document.getElementById("tg-done-memo");
    if (d) dr.date = d.value;
    if (m) dr.memo = m.value;
}

window.togetherPickPhoto = function(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    togetherKeepDraftInputs();
    const reader = new FileReader();
    reader.onload = async () => {
        const dr = together.ui.doneDraft;
        if (!dr) return;
        const src = String(reader.result || "");
        dr.photo = await compressBase64Image(src, 1280, 1280, 0.82);
        dr.thumb = await compressBase64Image(src, 160, 160, 0.7);
        if (!dr.photo || !dr.photo.startsWith("data:image")) { dr.photo = dr.thumb = ""; showToast("이 사진은 읽을 수 없어요", "warning"); }
        togetherRenderBucket();
    };
    reader.readAsDataURL(file);
};

window.togetherSaveDone = async function() {
    const id = together.ui.doneId, it = together.bucket[id], dr = together.ui.doneDraft;
    if (!it || !dr || dr.busy) return;
    togetherKeepDraftInputs();
    // A past date keeps its day; today keeps the actual time (it decides whether the item counts for
    // the character, which was born at a moment, not a day).
    let doneAt = Date.now();
    if (/^\d{4}-\d{2}-\d{2}$/.test(dr.date || "") && dr.date !== coupleYmd()) {
        const [y, m, d] = dr.date.split("-").map(Number);
        doneAt = new Date(y, m - 1, d, 12).getTime();
    }
    const patch = { done: doneAt, doneBy: couple.me || null, memo: String(dr.memo || "").trim().slice(0, 80) || null, thumb: dr.thumb || null, photo: !!dr.photo };
    dr.busy = true;
    togetherRenderBucket();
    const before = typeof couplePoints === "function" ? couplePoints() : 0;
    try {
        if (dr.photo) await togetherFetch(`bucketPhotos/${id}`, "PUT", dr.photo);
        await togetherFetch(`bucket/${id}`, "PATCH", patch);
        Object.assign(it, patch);
        await togetherBump("bucket").catch(() => { });
    } catch (e) {
        dr.busy = false;
        togetherRenderBucket();
        showToast("저장하지 못했어요. 인터넷 연결을 확인해 주세요", "danger");
        return;
    }
    together.ui.doneId = null;
    together.ui.doneDraft = null;
    together.ui.tab = "done";
    togetherSaveCache();
    togetherRefresh();
    showToast(`🎉 '${it.t}' 이뤘어요!`, "success");
    if (typeof coupleAfterPoints === "function") coupleAfterPoints(before);
    if (typeof coupleAnimate === "function") setTimeout(() => coupleAnimate("bloom"), 300);
};

window.togetherUndoDone = async function(id) {
    const it = together.bucket[id];
    if (!it) return;
    if (!(await showConfirmModal(`'${it.t}'을(를) 아직 못 한 걸로 되돌릴까요?\n인증 사진과 소감도 지워져요.`))) return;
    const patch = { done: null, doneBy: null, memo: null, thumb: null, photo: null };
    try {
        await togetherFetch(`bucket/${id}`, "PATCH", patch);
        togetherFetch(`bucketPhotos/${id}`, "DELETE").catch(() => { });
        ["done", "doneBy", "memo", "thumb", "photo"].forEach(k => delete it[k]);
        await togetherBump("bucket").catch(() => { });
    } catch (e) { showToast("되돌리지 못했어요", "danger"); return; }
    together.ui.menuId = null;
    togetherSaveCache();
    togetherRefresh();
    if (typeof coupleRender === "function") coupleRender();
};

window.togetherSaveEdit = async function(id) {
    const it = together.bucket[id];
    const t = String(document.getElementById("tg-edit-text")?.value || "").trim().slice(0, 60);
    if (!it || !t) return;
    if (t === it.t) { together.ui.menuId = null; togetherRenderBucket(); return; }
    try {
        await togetherFetch(`bucket/${id}`, "PATCH", { t });
        it.t = t;
        await togetherBump("bucket").catch(() => { });
    } catch (e) { showToast("고치지 못했어요", "danger"); return; }
    together.ui.menuId = null;
    togetherSaveCache();
    togetherRefresh();
};

window.togetherDeleteItem = async function(id) {
    const it = together.bucket[id];
    if (!it) return;
    if (!(await showConfirmModal(`'${it.t}'을(를) 버킷리스트에서 지울까요?`))) return;
    try {
        await togetherFetch(`bucket/${id}`, "DELETE");
        togetherFetch(`bucketPhotos/${id}`, "DELETE").catch(() => { });
        delete together.bucket[id];
        await togetherBump("bucket").catch(() => { });
    } catch (e) { showToast("지우지 못했어요", "danger"); return; }
    together.ui.menuId = null;
    togetherSaveCache();
    togetherRefresh();
    if (typeof coupleRender === "function") coupleRender();
};

window.togetherOpenPhoto = async function(id) {
    const it = together.bucket[id];
    if (!it) return;
    const lightbox = document.getElementById("modal-photo-viewer"), img = document.getElementById("lightbox-img");
    if (!lightbox || !img) return;
    img.src = it.thumb || "";
    lightbox.classList.add("active");
    if (!it.photo) return;
    try {
        const full = await togetherFetch(`bucketPhotos/${id}`);
        if (typeof full === "string" && full.startsWith("data:image") && lightbox.classList.contains("active")) img.src = full;
    } catch (_) { }
};

// ── 서로 사용 설명서 ───────────────────────────────────────────────────────────────────────────────
window.togetherOpenManual = function() {
    const ui = together.ui;
    ui.editing = false;
    if (couple.me) {
        const other = coupleOther(couple.me);
        ui.manualTab = togetherFilledCount(other) ? other : couple.me;
    } else ui.manualTab = "A";
    togetherRenderManual();
    document.getElementById("modal-together-manual")?.classList.add("active");
};
window.togetherCloseManual = function() {
    together.ui.editing = false;
    document.getElementById("modal-together-manual")?.classList.remove("active");
};
window.togetherManualTab = function(who) { together.ui.manualTab = who; together.ui.editing = false; togetherRenderManual(); };
window.togetherEditManual = function() { together.ui.editing = true; togetherRenderManual(); };
window.togetherCancelManual = function() { together.ui.editing = false; togetherRenderManual(); };
window.togetherPickLoveLang = function(btn, v) {
    const input = document.getElementById("tg-m-loveLang");
    if (!input) return;
    input.value = input.value === v ? "" : v;
    btn.parentElement.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.v === input.value));
};

window.togetherChooseMe = async function(who) {
    if (typeof coupleChooseMe === "function") await coupleChooseMe(who);
    togetherOpenManual();
};

function togetherEventsBanner() {
    const evs = togetherUpcoming(30).filter(e => e.kind === "bday" || e.dday <= 14);
    if (!evs.length) return "";
    return evs.slice(0, 3).map(e => {
        let hint = "";
        if (e.kind === "bday") {
            const who = e.label.startsWith(partnerAName) ? "A" : e.label.startsWith(partnerBName) ? "B" : null;
            const m = who ? together.manual[who] || {} : {};
            const bits = [["giftWant", "갖고 싶은 것"], ["flower", "꽃"], ["color", "색"], ["brand", "브랜드"]]
                .filter(([k]) => String(m[k] || "").trim()).map(([k, l]) => `${l}: ${escapeHtml(m[k])}`);
            if (who && who !== couple.me && bits.length) hint = `<div class="tg-event-hint">🎁 ${bits.join(" · ")}</div>`;
        }
        return `<div class="tg-event">${e.icon} <b>${escapeHtml(e.label)}</b> ${e.dday === 0 ? "오늘이에요!" : `D-${e.dday}`}${hint}</div>`;
    }).join("");
}

function togetherRenderManual() {
    const body = document.getElementById("together-manual-body");
    if (!body) return;
    const ui = together.ui;
    if (!couple.me) {
        body.innerHTML = `<div class="couple-who"><div class="couple-who-q">이 폰을 쓰는 사람은 누구예요? 🙋</div>
            <div class="couple-who-btns">
                <button type="button" class="btn btn-outline" onclick="togetherChooseMe('A')">${escapeHtml(partnerAName)}</button>
                <button type="button" class="btn btn-outline" onclick="togetherChooseMe('B')">${escapeHtml(partnerBName)}</button>
            </div></div>`;
        return;
    }
    const who = ui.manualTab === "A" || ui.manualTab === "B" ? ui.manualTab : couple.me;
    const mine = who === couple.me;
    const m = together.manual[who] || {};
    const tabs = `<div class="tg-tabs">${["A", "B"].map(k => `<button type="button" class="${k === who ? "active" : ""}" onclick="togetherManualTab('${k}')">${escapeHtml(coupleName(k))}${k === couple.me ? " (나)" : ""} 설명서</button>`).join("")}</div>`;
    let content;
    if (mine && ui.editing) {
        content = MANUAL_SECTIONS.map(sec => `<div class="tg-sec"><div class="tg-sec-title">${sec.title}</div>${sec.fields.map(([k, label, ph, choices]) => choices
            ? `<div class="tg-field"><span>${label}</span><input type="hidden" id="tg-m-${k}" value="${escapeHtml(m[k] || "")}">
                <div class="studio-chips">${choices.map(c => `<button type="button" class="studio-chip small${m[k] === c ? " active" : ""}" data-v="${escapeHtml(c)}" onclick="togetherPickLoveLang(this, ${jsArg(c)})">${escapeHtml(c)}</button>`).join("")}</div></div>`
            : `<label class="tg-field"><span>${label}</span>${k === "memo"
                ? `<textarea id="tg-m-${k}" class="course-input" maxlength="300" rows="3" placeholder="${escapeHtml(ph)}">${escapeHtml(m[k] || "")}</textarea>`
                : `<input type="text" id="tg-m-${k}" class="course-input" maxlength="80" placeholder="${escapeHtml(ph)}" value="${escapeHtml(m[k] || "")}">`}</label>`).join("")}</div>`).join("") +
            `<div class="tg-panel-actions tg-sticky"><button type="button" class="btn btn-outline" onclick="togetherCancelManual()">취소</button><button type="button" class="btn btn-primary" onclick="togetherSaveManual()">저장</button></div>`;
    } else {
        const filled = togetherFilledCount(who);
        const secs = MANUAL_SECTIONS.map(sec => {
            const rows = sec.fields.filter(([k]) => String(m[k] || "").trim())
                .map(([k, label]) => `<div class="tg-row"><span>${label}</span><b>${escapeHtml(m[k]).replace(/\n/g, "<br>")}</b></div>`).join("");
            return rows ? `<div class="tg-sec"><div class="tg-sec-title">${sec.title}</div>${rows}</div>` : "";
        }).join("");
        content = filled
            ? `${secs}<div class="tg-updated">${m.at ? `${togetherFmtDate(m.at)} 업데이트 · ` : ""}${filled}/${MANUAL_FIELDS.length}칸</div>`
            : `<div class="tg-empty">${mine ? "아직 내 설명서가 비어 있어요.<br>좋아하는 음식, 사이즈, 기분 풀리는 방법을 적어 두면 상대가 챙겨 주기 쉬워요 💌" : `${escapeHtml(coupleName(who))}가 아직 설명서를 안 썼어요.<br>써 달라고 말해 볼까요? ✍️`}</div>`;
        if (mine) content += `<button type="button" class="btn btn-primary tg-edit-btn" onclick="togetherEditManual()">✏️ ${filled ? "내 설명서 고치기" : "내 설명서 쓰기"}</button>`;
        if (mine && filled) content += `<div class="tg-note">🍽️ 음식 칸은 AI 플래너가 코스를 짤 때 참고해요.</div>`;
    }
    body.innerHTML = `${togetherEventsBanner()}${tabs}${content}`;
}

window.togetherSaveManual = async function() {
    if (!couple.me) return;
    const value = {};
    for (const k of MANUAL_FIELDS) {
        const v = String(document.getElementById(`tg-m-${k}`)?.value || "").trim();
        if (v) value[k] = v.slice(0, k === "memo" ? 300 : 80);
    }
    value.at = Date.now();
    try {
        await togetherFetch(`manual/${couple.me}`, "PUT", value);
        together.manual[couple.me] = value;
        await togetherBump("manual").catch(() => { });
    } catch (e) { showToast("저장하지 못했어요. 인터넷 연결을 확인해 주세요", "danger"); return; }
    together.ui.editing = false;
    togetherSaveCache();
    togetherRefresh();
    togetherRenderManual();
    showToast("📖 내 설명서를 저장했어요", "success");
    if (typeof coupleRender === "function") coupleRender();
};

// Birthdays/anniversaries move into the 14-day window at midnight; the tile text follows.
setInterval(togetherRenderTiles, 3600000);
