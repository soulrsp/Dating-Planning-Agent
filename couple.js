// couple.js — "오늘의 우리": today's mood (and, in later stages, the daily question, the shared
// character and badges).
//
// Loaded as a plain script after app.js and studio.js and shares their globals (syncRoomId,
// getFirebaseDbUrl, partnerAName/partnerBName, escapeHtml, jsArg, showToast …). app.js starts it from
// startCloudSyncLoop() behind a typeof guard, so the app keeps working if this file fails to load.
//
// Who is who: the two partners are "A" (partnerAName) and "B" (partnerBName). Each device remembers
// which one it is (aura_me_{room}); the room also keeps couple/members = { A: email, B: email }, so a
// new device or the home-screen app (which has its own storage on iPhone) recognises the signed-in
// Google account without asking again.
//
// Storage: aura-rooms/{room}/daily/{YYYY-MM-DD}/mood/{A|B} = { e, t, at }. Each person only ever
// writes their own leaf, so two phones saving at once can't overwrite each other. Dates are the
// device's local calendar day. The history is cached per room in localStorage; the poll only re-reads
// today and yesterday (a few hundred bytes), and a full re-read happens once per app start.

const COUPLE_MOODS = [
    { e: "😊", n: "좋아" }, { e: "🥰", n: "설레" }, { e: "🤩", n: "신나" }, { e: "😌", n: "평온" },
    { e: "😴", n: "피곤" }, { e: "😢", n: "슬퍼" }, { e: "😤", n: "화나" }, { e: "🤒", n: "아파" }
];
const COUPLE_POLL_MS = 20000;
const COUPLE_HISTORY_DAYS = 400;

const couple = {
    me: null,            // "A" | "B" | null (unknown yet)
    members: {},         // { A: email, B: email }
    daily: {},           // { "2026-11-16": { mood: { A: {...}, B: {...} } } }
    pickerOpen: false,
    draftMood: null,
    loadedRoom: null,
    pollId: null,
    saving: false
};

function coupleYmd(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function coupleAddDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function coupleUrl(sub) { return `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/${sub}.json`; }
function coupleName(who) { return who === "A" ? partnerAName : partnerBName; }
function coupleOther(who) { return who === "A" ? "B" : "A"; }
function coupleEmail() { try { return ((firebase.auth().currentUser || {}).email || "").toLowerCase(); } catch (_) { return ""; } }
function coupleMeKey() { return `aura_me_${syncRoomId}`; }
function coupleCacheKey() { return `aura_daily_${syncRoomId}`; }
function coupleSeenKey() { return `aura_daily_seen_${syncRoomId}`; }

function coupleSaveCache() {
    try { localStorage.setItem(coupleCacheKey(), JSON.stringify(couple.daily)); } catch (_) { }
}
function coupleLoadCache() {
    try { couple.daily = JSON.parse(localStorage.getItem(coupleCacheKey()) || "{}") || {}; } catch (_) { couple.daily = {}; }
}

async function coupleGetJson(sub, query = "") {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await fetch(coupleUrl(sub) + query, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally { clearTimeout(t); }
}
async function couplePutJson(sub, value) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await fetch(coupleUrl(sub) + "?print=silent", {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(value), signal: controller.signal
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } finally { clearTimeout(t); }
}

// ── Who am I ────────────────────────────────────────────────────────────────────────────────────
async function coupleResolveMe() {
    const stored = localStorage.getItem(coupleMeKey());
    if (stored === "A" || stored === "B") couple.me = stored;
    try { couple.members = (await coupleGetJson("couple/members")) || {}; } catch (_) { }
    const email = coupleEmail();
    if (email) {
        const match = ["A", "B"].find(k => String(couple.members[k] || "").toLowerCase() === email);
        if (match) {
            couple.me = match;
            try { localStorage.setItem(coupleMeKey(), match); } catch (_) { }
        } else if (couple.me && !couple.members[couple.me]) {
            // Known on this device but never recorded in the room: record it so other devices learn it.
            couplePutJson(`couple/members/${couple.me}`, email).catch(() => { });
            couple.members[couple.me] = email;
        }
    }
}

window.coupleChooseMe = async function(who) {
    if (who !== "A" && who !== "B") return;
    const email = coupleEmail();
    const taken = couple.members[who];
    if (taken && email && String(taken).toLowerCase() !== email) {
        if (!confirm(`${coupleName(who)} 자리는 다른 구글 계정(${taken})으로 등록돼 있어요.\n이 계정으로 바꿀까요?`)) return;
    }
    couple.me = who;
    try { localStorage.setItem(coupleMeKey(), who); } catch (_) { }
    if (email) {
        couple.members[who] = email;
        couplePutJson(`couple/members/${who}`, email).catch(e => console.warn("[Couple] members save failed", e));
    }
    coupleRender();
};

window.coupleForgetMe = function() {
    if (!confirm("이 폰이 누구인지 다시 고를까요?")) return;
    couple.me = null;
    try { localStorage.removeItem(coupleMeKey()); } catch (_) { }
    coupleRender();
};

// ── Sync ─────────────────────────────────────────────────────────────────────────────────────────
async function coupleLoadHistory() {
    const from = coupleYmd(coupleAddDays(new Date(), -COUPLE_HISTORY_DAYS));
    const q = `?orderBy=${encodeURIComponent('"$key"')}&startAt=${encodeURIComponent(JSON.stringify(from))}`;
    const data = await coupleGetJson("daily", q);
    couple.daily = data && typeof data === "object" ? data : {};
    coupleSaveCache();
}

async function couplePollRecent() {
    const days = [coupleYmd(), coupleYmd(coupleAddDays(new Date(), -1))];
    const before = JSON.stringify(days.map(d => couple.daily[d] || null));
    const nodes = await Promise.all(days.map(d => coupleGetJson(`daily/${d}`).catch(() => undefined)));
    nodes.forEach((n, i) => {
        if (n === undefined) return; // network error: keep what we have
        if (n) couple.daily[days[i]] = n; else delete couple.daily[days[i]];
    });
    if (JSON.stringify(days.map(d => couple.daily[d] || null)) !== before) {
        coupleSaveCache();
        coupleNotifyPartnerNews();
        coupleRender();
    }
}

// Called by app.js (startCloudSyncLoop) once signed in, and again after a room switch.
window.coupleStartSync = async function() {
    if (couple.pollId) clearInterval(couple.pollId);
    if (!syncRoomId) return;
    if (couple.loadedRoom !== syncRoomId) {
        couple.loadedRoom = syncRoomId;
        couple.me = null;
        couple.members = {};
        coupleLoadCache();
    }
    coupleRender();
    try {
        await coupleResolveMe();
        await coupleLoadHistory();
    } catch (e) {
        console.warn("[Couple] initial load failed (using cache):", e);
    }
    coupleNotifyPartnerNews(true);
    coupleRender();
    couple.pollId = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        couplePollRecent().catch(e => console.warn("[Couple] poll failed:", e));
    }, COUPLE_POLL_MS);
};

// A gentle "new from your partner" nudge (no push notifications without a server): a toast the first
// time this device sees a mood the partner left since we last looked.
function coupleNotifyPartnerNews(quiet = false) {
    if (!couple.me) return;
    const other = coupleOther(couple.me);
    const today = couple.daily[coupleYmd()] || {};
    const m = today.mood && today.mood[other];
    if (!m || !m.at) return;
    let seen = 0;
    try { seen = Number(localStorage.getItem(coupleSeenKey()) || 0); } catch (_) { }
    if (m.at <= seen) return;
    try { localStorage.setItem(coupleSeenKey(), String(m.at)); } catch (_) { }
    if (!quiet) showToast(`${coupleName(other)}가 오늘의 기분을 남겼어요 ${m.e || "💌"}`, "info");
}

// ── Mood ─────────────────────────────────────────────────────────────────────────────────────────
window.coupleOpenMoodPicker = function() {
    const mine = coupleTodayMood(couple.me);
    couple.pickerOpen = true;
    couple.draftMood = mine ? mine.e : null;
    coupleRender();
    setTimeout(() => document.getElementById("couple-mood-text")?.focus({ preventScroll: true }), 50);
};
window.coupleCloseMoodPicker = function() { couple.pickerOpen = false; coupleRender(); };
window.coupleDraftMood = function(e) {
    couple.draftMood = e;
    document.querySelectorAll(".couple-mood-opt").forEach(b => b.classList.toggle("active", b.dataset.e === e));
};

function coupleTodayMood(who) {
    const today = couple.daily[coupleYmd()];
    return today && today.mood ? today.mood[who] || null : null;
}

window.coupleSaveMood = async function() {
    if (!couple.me || couple.saving) return;
    if (!couple.draftMood) { showToast("기분 이모지를 하나 골라주세요", "warning"); return; }
    const text = String(document.getElementById("couple-mood-text")?.value || "").trim().slice(0, 30);
    const value = { e: couple.draftMood, t: text, at: Date.now() };
    const day = coupleYmd();
    couple.saving = true;
    try {
        await couplePutJson(`daily/${day}/mood/${couple.me}`, value);
        couple.daily[day] = couple.daily[day] || {};
        couple.daily[day].mood = Object.assign({}, couple.daily[day].mood, { [couple.me]: value });
        coupleSaveCache();
        couple.pickerOpen = false;
        showToast("오늘의 기분을 남겼어요 " + value.e, "success");
    } catch (e) {
        console.error("[Couple] mood save failed", e);
        showToast("저장하지 못했어요. 인터넷 연결을 확인해 주세요.", "danger");
    } finally {
        couple.saving = false;
        coupleRender();
    }
};

// ── Card ─────────────────────────────────────────────────────────────────────────────────────────
function coupleTimeLabel(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    return `${d.getHours() < 12 ? "오전" : "오후"} ${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function coupleMoodSide(who) {
    const m = coupleTodayMood(who);
    const isMe = who === couple.me;
    const name = escapeHtml(coupleName(who)) + (isMe ? " <span class=\"couple-me-tag\">나</span>" : "");
    if (!m) {
        return `<div class="couple-mood-side${isMe ? " is-me" : ""}">
            <div class="couple-mood-name">${name}</div>
            ${isMe
                ? `<button type="button" class="couple-mood-empty" onclick="coupleOpenMoodPicker()">＋<span>오늘 기분 남기기</span></button>`
                : `<div class="couple-mood-empty is-wait">🫧<span>아직이에요</span></div>`}
        </div>`;
    }
    return `<div class="couple-mood-side${isMe ? " is-me" : ""}">
        <div class="couple-mood-name">${name}</div>
        <button type="button" class="couple-mood-filled" ${isMe ? `onclick="coupleOpenMoodPicker()"` : "disabled"}>
            <span class="couple-mood-emoji">${escapeHtml(m.e)}</span>
            ${m.t ? `<span class="couple-mood-text">${escapeHtml(m.t)}</span>` : ""}
            <span class="couple-mood-time">${coupleTimeLabel(m.at)}</span>
        </button>
    </div>`;
}

function coupleWeekStrip() {
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(coupleAddDays(new Date(), -i));
    const row = who => days.map(d => {
        const n = couple.daily[coupleYmd(d)];
        const m = n && n.mood && n.mood[who];
        return `<span class="couple-week-cell" title="${coupleYmd(d)}">${m ? escapeHtml(m.e) : "·"}</span>`;
    }).join("");
    const head = days.map(d => `<span class="couple-week-cell is-day">${["일", "월", "화", "수", "목", "금", "토"][d.getDay()]}</span>`).join("");
    return `<div class="couple-week">
        <div class="couple-week-row"><span class="couple-week-label"></span>${head}</div>
        <div class="couple-week-row"><span class="couple-week-label">${escapeHtml(partnerAName)}</span>${row("A")}</div>
        <div class="couple-week-row"><span class="couple-week-label">${escapeHtml(partnerBName)}</span>${row("B")}</div>
    </div>`;
}

function coupleRender() {
    const card = document.getElementById("couple-card");
    if (!card) return;
    if (!syncRoomId) { card.classList.add("hidden"); return; }
    card.classList.remove("hidden");
    const now = new Date();
    const title = `<div class="couple-head"><span class="couple-title">🌤️ 오늘의 우리</span>
        <span class="couple-date">${now.getMonth() + 1}월 ${now.getDate()}일 ${["일", "월", "화", "수", "목", "금", "토"][now.getDay()]}요일</span></div>`;

    if (!couple.me) {
        card.innerHTML = `${title}
            <div class="couple-who">
                <div class="couple-who-q">이 폰을 쓰는 사람은 누구예요? 🙋</div>
                <div class="couple-who-btns">
                    <button type="button" class="btn btn-outline" onclick="coupleChooseMe('A')">${escapeHtml(partnerAName)}</button>
                    <button type="button" class="btn btn-outline" onclick="coupleChooseMe('B')">${escapeHtml(partnerBName)}</button>
                </div>
                <div class="couple-who-hint">한 번만 고르면 돼요. 같은 구글 계정이면 다른 기기에서도 자동으로 알아봐요.</div>
            </div>`;
        return;
    }

    let picker = "";
    if (couple.pickerOpen) {
        const mine = coupleTodayMood(couple.me);
        picker = `<div class="couple-mood-picker">
            <div class="couple-mood-opts">${COUPLE_MOODS.map(m => `<button type="button" class="couple-mood-opt${couple.draftMood === m.e ? " active" : ""}" data-e="${m.e}" onclick="coupleDraftMood(${jsArg(m.e)})"><span>${m.e}</span><small>${m.n}</small></button>`).join("")}</div>
            <input type="text" id="couple-mood-text" maxlength="30" placeholder="한마디 남기기 (선택, 30자)" value="${escapeHtml(mine && mine.t || "")}">
            <div class="couple-mood-actions">
                <button type="button" class="btn btn-outline" onclick="coupleCloseMoodPicker()">취소</button>
                <button type="button" class="btn btn-primary" onclick="coupleSaveMood()">남기기</button>
            </div>
        </div>`;
    }

    card.innerHTML = `${title}
        <div class="couple-moods">${coupleMoodSide(couple.me)}${coupleMoodSide(coupleOther(couple.me))}</div>
        ${picker}
        ${coupleWeekStrip()}
        <div class="couple-foot"><button type="button" class="couple-link" onclick="coupleForgetMe()">이 폰: ${escapeHtml(coupleName(couple.me))} · 바꾸기</button></div>`;
}

// The date rolls over at midnight while the app may stay open: re-render when the day changes.
let coupleRenderedDay = coupleYmd();
setInterval(() => {
    if (coupleYmd() !== coupleRenderedDay) { coupleRenderedDay = coupleYmd(); coupleRender(); }
}, 60000);
