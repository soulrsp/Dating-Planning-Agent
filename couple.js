// couple.js — "오늘의 우리": today's mood, the daily question, the shared character (명똑똑 by
// default — renamable), presence and hearts. Badges come in a later stage.
//
// Loaded as a plain script after app.js and studio.js and shares their globals (syncRoomId,
// getFirebaseDbUrl, partnerAName/partnerBName, escapeHtml, jsArg, showToast, db, parseAnyDate,
// coupleEventsOnDate …). app.js starts it from startCloudSyncLoop() behind a typeof guard, so the app
// keeps working if this file fails to load.
//
// Who is who: the two partners are "A" (partnerAName) and "B" (partnerBName). Each device remembers
// which one it is (aura_me_{room}); the room also keeps couple/members = { A: email, B: email }, so a
// new device or the home-screen app (which has its own storage on iPhone) recognises the signed-in
// Google account without asking again.
//
// Cloud layout (everything under aura-rooms/{room}/):
//   daily/{YYYY-MM-DD}/mood/{A|B}   = { e, t, at }   today's mood
//   daily/{YYYY-MM-DD}/answer/{A|B} = { t, at }      answer to the day's question
//   daily/{YYYY-MM-DD}/qi           = number         set only when someone swapped the question
//   daily/{YYYY-MM-DD}/heart/{A|B}  = ms             first heart sent that day (worth 1 point)
//   couple/members                  = { A: email, B: email }
//   couple/pet                      = { name, bornAt }
//   couple/presence/{A|B}           = ms timestamp, refreshed every minute while the app is open
//   couple/hearts/{A|B}             = { n, at }      hearts sent so far (the other side reacts)
// Each person only ever writes their own leaves, so two phones saving at once can't overwrite each
// other. Character points, stage and streak are never stored: they are recomputed from the history,
// so both phones always agree. Dates are the device's local calendar day.

const COUPLE_MOODS = [
    { e: "😊", n: "좋아" }, { e: "🥰", n: "설레" }, { e: "🤩", n: "신나" }, { e: "😌", n: "평온" },
    { e: "😴", n: "피곤" }, { e: "😢", n: "슬퍼" }, { e: "😤", n: "화나" }, { e: "🤒", n: "아파" }
];
const COUPLE_POLL_MS = 20000;
const COUPLE_PRESENCE_MS = 60000;
const COUPLE_ONLINE_WINDOW_MS = 150000;   // "접속 중" if the partner's heartbeat is newer than this
const COUPLE_SLEEPY_AFTER_MS = 2 * 86400000;
const COUPLE_HISTORY_DAYS = 400;
const COUPLE_DEFAULT_PET_NAME = "명똑똑";
const COUPLE_CHAR_BASE = "images/character/";

// Points → stage. Earned from the day's question (both +3, one +1), moods (both +1), each person's
// first heart of the day (+1 each), places visited after the character was born (+2) and 꾸민 사진
// saved after it (+1). Hearts beyond the first of the day still animate but add nothing.
const COUPLE_STAGES = [
    { min: 0, name: "알" }, { min: 5, name: "아기" }, { min: 20, name: "어린이" },
    { min: 50, name: "청소년" }, { min: 100, name: "어른" }, { min: 200, name: "전설" }
];

// 150 questions. The day's question comes from a fixed shuffle (seeded by the room), so both phones
// show the same one and none repeats for 150 days.
const COUPLE_QUESTIONS = [
    // 추억
    "우리가 처음 만난 날, 나의 첫인상은 어땠어?", "나를 좋아한다고 처음 느낀 순간은 언제야?", "지금까지 우리 데이트 중 가장 기억에 남는 날은?",
    "처음 손잡았던 날 기억나? 그때 기분이 어땠어?", "우리 사진 중에 제일 좋아하는 한 장은?", "처음 '사랑해'라고 말했을 때 기억나?",
    "나랑 처음 먹었던 음식 기억해?", "우리가 함께 웃음이 터졌던 가장 웃긴 순간은?", "나 때문에 감동받았던 순간이 있어?",
    "우리가 같이 간 곳 중 다시 가고 싶은 곳은?", "사귀기 전에 나에 대해 어떻게 생각했어?", "우리 연애에서 가장 설렜던 순간은?",
    "처음 우리 집 근처에 왔던 날 기억나?", "나랑 했던 대화 중 기억에 남는 말이 있어?", "우리가 처음 싸웠던 날 기억나? 지금 생각하면 어때?",
    "나에게 받은 선물 중 제일 좋았던 건?", "우리의 첫 여행(또는 첫 나들이)은 어땠어?", "내가 제일 귀여웠던 순간은?",
    "우리만 아는 웃긴 에피소드 하나만 꼽는다면?", "올해 우리에게 일어난 가장 좋은 일은?",
    // 취향
    "요즘 제일 자주 듣는 노래는?", "인생 영화 하나만 꼽는다면?", "평생 한 가지 음식만 먹어야 한다면?",
    "가장 좋아하는 계절과 그 이유는?", "비 오는 날 하고 싶은 것은?", "주말 아침에 가장 하고 싶은 것은?",
    "요즘 꽂힌 간식은?", "카페에 가면 늘 시키는 메뉴는?", "제일 좋아하는 색깔은?", "가장 좋아하는 동물은?",
    "하루 중 제일 좋아하는 시간대는?", "스트레스 받을 때 꼭 하는 일은?", "요즘 갖고 싶은 물건 하나는?",
    "어릴 때 제일 좋아했던 만화는?", "여행 가면 꼭 하는 나만의 루틴이 있어?", "가장 좋아하는 냄새는?",
    "최애 편의점 조합은?", "한 번쯤 배워보고 싶은 취미는?", "자기 전에 꼭 하는 일은?", "요즘 나의 최애 유튜브(또는 프로그램)는?",
    // 서로에 대해
    "내가 가장 사랑스러워 보일 때는?", "나에게 고마웠던 일 한 가지를 꼽는다면?", "내 말버릇 중에 귀여운 건?",
    "나랑 있을 때 가장 편한 순간은?", "내가 해주는 것 중 제일 좋아하는 건?", "내 장점 세 가지를 말해줘!",
    "나를 동물에 비유하면?", "나를 한 단어로 표현하면?", "내가 몰래 해줬으면 하는 서프라이즈는?",
    "내가 했던 말 중에 힘이 됐던 말은?", "나에게 배우고 싶은 점이 있다면?", "내가 제일 멋있어(예뻐) 보였던 날은?",
    "나에 대해 아직 모르는 것 같은 게 있어?", "내 웃음소리 어때?", "나랑 닮았다고 생각하는 점은?",
    "나랑 다르다고 느끼는 점은?", "내가 아플 때 해주고 싶은 것은?", "나에게 하고 싶었는데 못 한 말이 있어?",
    "내 사진 중에 제일 좋아하는 건?", "나랑 연락할 때 제일 좋은 순간은?",
    // 미래
    "10년 후 우리는 어떤 모습일까?", "같이 꼭 가보고 싶은 해외 여행지는?", "언젠가 함께 살고 싶은 동네는?",
    "우리 집에 꼭 있었으면 하는 것은?", "같이 도전해보고 싶은 것 하나는?", "다음 기념일에 하고 싶은 데이트는?",
    "올해가 가기 전에 함께 하고 싶은 일은?", "같이 배워보고 싶은 것이 있어?", "우리만의 전통을 만든다면?",
    "같이 키우고 싶은 반려동물이 있어?", "나이 들어서 우리 둘이 하고 싶은 것은?", "꿈에 그리는 이상적인 하루는?",
    "같이 가고 싶은 콘서트나 공연이 있어?", "1년 뒤 오늘, 우리는 뭘 하고 있을까?", "버킷리스트 중 하나를 같이 한다면?",
    "둘이 함께 이루고 싶은 목표가 있다면?", "언젠가 우리 둘만의 가게를 연다면 무슨 가게?", "꼭 같이 해보고 싶은 계절 데이트는?",
    "같이 가보고 싶은 국내 여행지는?", "미래의 우리에게 한마디 한다면?",
    // 밸런스
    "바다 vs 산, 같이 간다면?", "평생 여름 vs 평생 겨울?", "집 데이트 vs 밖 데이트?", "아침형 vs 저녁형, 우리는?",
    "짜장면 vs 짬뽕?", "탕수육 부먹 vs 찍먹?", "민트초코 호 vs 불호?", "영화관 vs 넷플릭스?",
    "계획 여행 vs 즉흥 여행?", "카톡 길게 vs 전화 짧게?", "강아지 vs 고양이?", "놀이공원 vs 박물관?",
    "치킨 vs 피자?", "선물 받기 vs 선물 주기?", "매일 연락 vs 가끔 연락?", "단 음식 vs 짠 음식?",
    "사진 많이 찍기 vs 눈에 담기?", "기념일 크게 vs 소소하게?", "비 오는 날 vs 맑은 날?", "새벽 감성 vs 아침 감성?",
    // 귀여운 질문
    "오늘 나를 생각한 순간이 있었어? 언제?", "지금 나한테 보내고 싶은 이모티콘은?", "오늘 하루를 날씨로 표현하면?",
    "나를 위한 노래 한 곡을 추천한다면?", "나한테 별명을 하나 더 지어준다면?", "지금 당장 같이 먹고 싶은 음식은?",
    "오늘 가장 잘한 일은?", "지금 기분을 색깔로 표현하면?", "나랑 바꿔서 하루를 산다면 뭐 할 거야?",
    "우리 캐릭터에게 하고 싶은 말은?", "오늘 나에게 주고 싶은 상장 이름은?", "지금 나한테 듣고 싶은 말은?",
    "우리 둘 사진에 제목을 붙인다면?", "오늘의 나를 칭찬해줘!", "나를 과일에 비유하면?",
    "지금 나를 안아줄 수 있다면 몇 초 동안?", "우리 사랑을 음식으로 표현하면?", "오늘 하루 중 가장 행복했던 순간은?",
    "나에게 보내는 짧은 응원 한마디!", "내일 나에게 해주고 싶은 것은?",
    // 깊은 대화
    "요즘 가장 고민되는 것은?", "최근에 나를 성장시킨 경험이 있어?", "힘들 때 내가 어떻게 해주면 좋겠어?",
    "사랑받고 있다고 느낄 때는 언제야?", "서운할 때 어떻게 말해주면 좋겠어?", "나에게 가장 의지가 됐던 순간은?",
    "요즘 스스로에게 해주고 싶은 말은?", "우리가 더 잘 지내기 위해 바꾸고 싶은 한 가지는?", "가장 행복했던 어린 시절 기억은?",
    "인생에서 가장 소중한 가치는 뭐야?", "내가 너에게 어떤 사람이었으면 좋겠어?", "요즘 가장 감사한 일은?",
    "다시 태어나도 해보고 싶은 일은?", "나랑 있으면서 달라진 점이 있어?", "우리 관계에서 가장 자랑스러운 점은?",
    "앞으로 우리가 꼭 지켰으면 하는 약속은?", "혼자 있고 싶을 때 나는 어떻게 하면 좋을까?", "요즘 나에게 미안했던 순간이 있어?",
    "우리에게 '좋은 연애'란 어떤 걸까?", "지금 이 순간 나에게 가장 하고 싶은 말은?",
    // 더 알아가기
    "어릴 때 꿈은 뭐였어?", "학창 시절 별명은 뭐였어?", "나만 아는 너의 작은 습관 하나는?",
    "요즘 가장 많이 웃은 일은?", "하루가 25시간이면 남는 1시간에 뭐 할래?", "복권 1등 되면 제일 먼저 할 일은?",
    "우리 캐릭터 이름을 다시 짓는다면?", "가장 자신 있는 요리는?", "내가 몰랐을 것 같은 너의 매력은?",
    "오늘 저녁 메뉴를 하나 정해준다면?"
];

const couple = {
    me: null,            // "A" | "B" | null (unknown yet)
    members: {},         // { A: email, B: email }
    daily: {},           // { "2026-11-16": { mood: {...}, answer: {...}, qi } }
    pet: {},             // { name, bornAt }
    presence: {},        // { A: ms, B: ms }
    hearts: {},          // { A: {n, at}, B: {n, at} }
    pickerOpen: false,
    answerOpen: false,
    draftMood: null,
    loadedRoom: null,
    pollId: null,
    presenceId: null,
    saving: false,
    extraPoints: 0,      // visits + creations since the character was born (recomputed on refresh)
    partnerWasOnline: false
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
function coupleSeenKey(kind) { return `aura_couple_seen_${kind}_${syncRoomId}`; }
function couplePetName() { return (couple.pet && couple.pet.name) || COUPLE_DEFAULT_PET_NAME; }

function coupleGetSeen(kind) { try { return Number(localStorage.getItem(coupleSeenKey(kind)) || 0); } catch (_) { return 0; } }
function coupleSetSeen(kind, v) { try { localStorage.setItem(coupleSeenKey(kind), String(v)); } catch (_) { } }

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
    couplePresenceBeat();
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

// couple/ is tiny (members, pet, presence, hearts): read it whole.
async function coupleLoadMeta() {
    const meta = (await coupleGetJson("couple")) || {};
    couple.members = meta.members || {};
    couple.pet = meta.pet || {};
    couple.presence = meta.presence || {};
    couple.hearts = meta.hearts || {};
    return meta;
}

async function couplePoll() {
    const days = [coupleYmd(), coupleYmd(coupleAddDays(new Date(), -1))];
    const before = JSON.stringify([days.map(d => couple.daily[d] || null), couple.pet, couple.hearts]);
    const [nodes] = await Promise.all([
        Promise.all(days.map(d => coupleGetJson(`daily/${d}`).catch(() => undefined))),
        coupleLoadMeta().catch(() => null)
    ]);
    nodes.forEach((n, i) => {
        if (n === undefined) return; // network error: keep what we have
        if (n) couple.daily[days[i]] = n; else delete couple.daily[days[i]];
    });
    coupleCheckPartnerPresence();
    if (JSON.stringify([days.map(d => couple.daily[d] || null), couple.pet, couple.hearts]) !== before) {
        coupleSaveCache();
        coupleNotifyPartnerNews();
        coupleRender();
    } else {
        coupleRenderPresence();
    }
}

function couplePresenceBeat() {
    if (!couple.me || document.visibilityState !== "visible") return;
    const now = Date.now();
    couple.presence[couple.me] = now;
    couplePutJson(`couple/presence/${couple.me}`, now).catch(() => { });
}

// Called by app.js (startCloudSyncLoop) once signed in, and again after a room switch.
window.coupleStartSync = async function() {
    if (couple.pollId) clearInterval(couple.pollId);
    if (couple.presenceId) clearInterval(couple.presenceId);
    if (!syncRoomId) return;
    if (couple.loadedRoom !== syncRoomId) {
        couple.loadedRoom = syncRoomId;
        Object.assign(couple, { me: null, members: {}, pet: {}, presence: {}, hearts: {}, partnerWasOnline: false });
        coupleLoadCache();
    }
    coupleRender();
    try {
        await coupleLoadMeta();
        await coupleResolveMe();
        await coupleLoadHistory();
        await coupleEnsurePet();
    } catch (e) {
        console.warn("[Couple] initial load failed (using cache):", e);
    }
    await coupleRefreshExtraPoints();
    // Remember the stage we start at, so only growth that happens from now on gets celebrated.
    try {
        const k = `aura_couple_stage_${syncRoomId}`;
        if (localStorage.getItem(k) === null) localStorage.setItem(k, String(coupleStageFor(couplePoints())));
    } catch (_) { }
    coupleNotifyPartnerNews(true);
    couple.partnerWasOnline = coupleIsOnline(couple.me ? coupleOther(couple.me) : null);
    couplePresenceBeat();
    coupleRender();
    if (couple.partnerWasOnline) coupleAnimate("jump");
    couple.pollId = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        couplePoll().catch(e => console.warn("[Couple] poll failed:", e));
    }, COUPLE_POLL_MS);
    couple.presenceId = setInterval(couplePresenceBeat, COUPLE_PRESENCE_MS);
};

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && couple.pollId) {
        couplePresenceBeat();
        couplePoll().catch(() => { });
    }
});

// "New from your partner" nudges (no push notifications without a server): a toast the first time this
// device sees something the partner did since we last looked.
function coupleNotifyPartnerNews(quiet = false) {
    if (!couple.me) return;
    const other = coupleOther(couple.me), name = coupleName(other);
    const today = couple.daily[coupleYmd()] || {};
    const checks = [
        ["mood", today.mood && today.mood[other], m => `${name}가 오늘의 기분을 남겼어요 ${m.e || "💌"}`],
        ["answer", today.answer && today.answer[other], () => coupleMyAnswer() ? `${name}가 오늘의 질문에 답했어요! 💬` : `${name}가 오늘의 질문에 답했어요. 나도 답하면 볼 수 있어요 🔒`],
        ["heart", couple.hearts[other], () => `${name}가 하트를 보냈어요 💗`]
    ];
    for (const [kind, item, msg] of checks) {
        if (!item || !item.at || item.at <= coupleGetSeen(kind)) continue;
        coupleSetSeen(kind, item.at);
        if (quiet) continue;
        showToast(msg(item), "info");
        if (kind === "heart") coupleAnimate("love");
    }
}

function coupleIsOnline(who) {
    return !!who && Date.now() - (couple.presence[who] || 0) < COUPLE_ONLINE_WINDOW_MS;
}

function coupleCheckPartnerPresence() {
    if (!couple.me) return;
    const other = coupleOther(couple.me);
    const online = coupleIsOnline(other);
    if (online && !couple.partnerWasOnline) {
        showToast(`${coupleName(other)}가 들어왔어요 👋`, "info");
        coupleAnimate("jump");
    }
    couple.partnerWasOnline = online;
}

// ── Character: points, stage, state ──────────────────────────────────────────────────────────────
async function coupleEnsurePet() {
    if (couple.pet && couple.pet.bornAt) return;
    const pet = { name: (couple.pet && couple.pet.name) || COUPLE_DEFAULT_PET_NAME, bornAt: Date.now() };
    couple.pet = pet;
    await couplePutJson("couple/pet", pet);
}

async function coupleRefreshExtraPoints() {
    const born = Number(couple.pet && couple.pet.bornAt) || Date.now();
    let pts = 0;
    try {
        const places = await db.places.toArray();
        pts += 2 * places.filter(p => (p.isVisited === 1 || p.isVisited === true || p.isVisited === "1") && p.isDeleted !== 1
            && parseAnyDate(p.createdAt) >= born).length;
    } catch (_) { }
    try {
        const rows = await db.creations.where("room").equals(syncRoomId).toArray();
        pts += rows.filter(r => (r.createdAt || 0) >= born).length;
    } catch (_) { }
    couple.extraPoints = pts;
}

function coupleDayStats(day) {
    const n = couple.daily[day] || {};
    const ans = n.answer || {}, mood = n.mood || {}, heart = n.heart || {};
    return { both: !!(ans.A && ans.B), one: !!(ans.A || ans.B), moods: !!(mood.A && mood.B), hearts: (heart.A ? 1 : 0) + (heart.B ? 1 : 0) };
}

function couplePoints() {
    let pts = couple.extraPoints;
    for (const day of Object.keys(couple.daily)) {
        const s = coupleDayStats(day);
        pts += s.both ? 3 : s.one ? 1 : 0;
        if (s.moods) pts += 1;
        pts += s.hearts;
    }
    return pts;
}

function coupleStageFor(points) {
    let i = 0;
    COUPLE_STAGES.forEach((s, k) => { if (points >= s.min) i = k; });
    return i;
}

// Days in a row (ending today, or yesterday if today isn't done yet) on which both answered.
function coupleStreak() {
    let d = new Date();
    if (!coupleDayStats(coupleYmd(d)).both) d = coupleAddDays(d, -1);
    let n = 0;
    while (coupleDayStats(coupleYmd(d)).both) { n++; d = coupleAddDays(d, -1); }
    return n;
}

function coupleLastActivityAt() {
    let last = 0;
    for (const n of Object.values(couple.daily)) {
        for (const group of [n.mood, n.answer]) {
            if (!group) continue;
            for (const v of Object.values(group)) last = Math.max(last, (v && v.at) || 0);
        }
    }
    const other = couple.me ? coupleOther(couple.me) : null;
    if (other) last = Math.max(last, couple.presence[other] || 0);
    return last;
}

// Base mood of the character right now: anniversary > sleepy > happy > idle.
function couplePetState() {
    try { if (coupleEventsOnDate(startOfLocalDay(new Date())).length) return "bloom"; } catch (_) { }
    const last = coupleLastActivityAt();
    const h = new Date().getHours();
    if ((last && Date.now() - last > COUPLE_SLEEPY_AFTER_MS) || h < 6) return "sleepy";
    if (coupleDayStats(coupleYmd()).both) return "happy";
    return "idle";
}

// Sprite for a stage + state. Facial expressions exist only for the adult (stage 4); every stage
// from baby up has an eyes-closed frame, used for blinking and for sleeping.
function coupleSprite(stage, state, blink) {
    if (stage === 0) return `${COUPLE_CHAR_BASE}stage-0.webp`;
    if (stage === 4) {
        if (state === "sleepy") return `${COUPLE_CHAR_BASE}face-sleepy.webp`;
        if (state === "happy" || state === "love" || state === "bloom") return `${COUPLE_CHAR_BASE}face-happy.webp`;
        if (state === "sad") return `${COUPLE_CHAR_BASE}face-sad.webp`;
        return `${COUPLE_CHAR_BASE}${blink ? "face-idle-blink" : "face-idle"}.webp`;
    }
    return `${COUPLE_CHAR_BASE}stage-${stage}${blink || state === "sleepy" ? "-blink" : ""}.webp`;
}

// Preload so swapping sprites (blink, expressions) never flashes.
(function couplePreloadSprites() {
    const files = ["stage-0", "face-idle", "face-idle-blink", "face-happy", "face-sleepy", "face-sad"];
    for (let i = 1; i <= 5; i++) files.push(`stage-${i}`, `stage-${i}-blink`);
    for (let i = 0; i < 8; i++) files.push(`sticker-${i}`);
    window.addEventListener("load", () => files.forEach(f => { const im = new Image(); im.src = `${COUPLE_CHAR_BASE}${f}.webp`; }));
})();

// ── Character animation ──────────────────────────────────────────────────────────────────────────
let coupleBlinkTimer = null;
let coupleOneShotUntil = 0;

function couplePetEls() {
    return { wrap: document.getElementById("couple-pet"), img: document.getElementById("couple-pet-img"), fx: document.getElementById("couple-pet-fx") };
}

function coupleScheduleBlink() {
    clearTimeout(coupleBlinkTimer);
    coupleBlinkTimer = setTimeout(() => {
        const { img, wrap } = couplePetEls();
        const stage = Number(wrap && wrap.dataset.stage);
        const state = wrap && wrap.dataset.state;
        if (img && stage > 0 && (state === "idle" || (stage !== 4 && state !== "sleepy")) && Date.now() > coupleOneShotUntil) {
            img.src = coupleSprite(stage, state, true);
            setTimeout(() => { if (img.isConnected) img.src = coupleSprite(stage, state, false); }, 160);
        }
        coupleScheduleBlink();
    }, 2600 + Math.random() * 3200);
}

function coupleSpawn(fx, chars, count, cls) {
    if (!fx) return;
    for (let i = 0; i < count; i++) {
        const s = document.createElement("span");
        s.className = `couple-fx ${cls}`;
        s.textContent = chars[i % chars.length];
        s.style.left = `${15 + Math.random() * 70}%`;
        s.style.animationDelay = `${i * 0.12}s`;
        s.style.fontSize = `${0.9 + Math.random() * 0.7}rem`;
        fx.appendChild(s);
        setTimeout(() => s.remove(), 2600 + i * 120);
    }
}

// One-shot reactions on top of the base state: jump (partner arrived), love (heart received / tap),
// bloom (anniversary / level-up), squish (tap).
function coupleAnimate(kind) {
    const { wrap, img, fx } = couplePetEls();
    if (!wrap || !img) return;
    const stage = Number(wrap.dataset.stage);
    wrap.classList.remove("pet-jump", "pet-love", "pet-bloom-burst", "pet-squish");
    void wrap.offsetWidth; // restart the CSS animation
    coupleOneShotUntil = Date.now() + 1600;
    if (kind === "jump") {
        wrap.classList.add("pet-jump");
        coupleSpawn(fx, ["✨", "💚"], 4, "fx-pop");
    } else if (kind === "love") {
        wrap.classList.add("pet-love");
        if (stage === 4) img.src = coupleSprite(4, "love");
        coupleSpawn(fx, ["💗", "💕", "💖"], 7, "fx-float");
    } else if (kind === "bloom") {
        wrap.classList.add("pet-bloom-burst");
        coupleSpawn(fx, ["✨", "🌸", "⭐", "✨"], 8, "fx-sparkle");
    } else if (kind === "squish") {
        wrap.classList.add("pet-squish");
        coupleSpawn(fx, ["💚"], 1, "fx-float");
    }
    setTimeout(() => {
        wrap.classList.remove("pet-jump", "pet-love", "pet-bloom-burst", "pet-squish");
        if (img.isConnected) img.src = coupleSprite(stage, wrap.dataset.state, false);
    }, 1600);
}

window.couplePetTap = function() {
    const { wrap, img } = couplePetEls();
    if (!wrap) return;
    const stage = Number(wrap.dataset.stage);
    if (stage === 4 && img) {
        // The adult reacts with one of its sticker poses.
        img.src = `${COUPLE_CHAR_BASE}sticker-${Math.floor(Math.random() * 8)}.webp`;
    }
    coupleAnimate(stage === 0 ? "squish" : (Math.random() < 0.5 ? "squish" : "love"));
};

window.coupleSendHeart = async function() {
    if (!couple.me) return;
    const mine = couple.hearts[couple.me] || { n: 0 };
    const value = { n: (mine.n || 0) + 1, at: Date.now() };
    couple.hearts[couple.me] = value;
    coupleAnimate("love");
    const day = coupleYmd();
    const firstToday = !((couple.daily[day] || {}).heart || {})[couple.me];
    const before = couplePoints();
    try {
        await couplePutJson(`couple/hearts/${couple.me}`, value);
        if (firstToday) {
            await couplePutJson(`daily/${day}/heart/${couple.me}`, value.at);
            couple.daily[day] = couple.daily[day] || {};
            couple.daily[day].heart = Object.assign({}, couple.daily[day].heart, { [couple.me]: value.at });
            coupleSaveCache();
            coupleAfterPoints(before);
        } else {
            showToast("하트를 보냈어요 💗 (점수는 하루 첫 하트만 올라가요)", "info");
        }
    } catch (e) { showToast("하트를 보내지 못했어요. 인터넷 연결을 확인해 주세요.", "danger"); }
    coupleRenderPresence();
};

// After something that may have earned points: re-render, float "+N점" by the bar, celebrate a new stage.
function coupleAfterPoints(before) {
    const after = couplePoints();
    const stageBefore = coupleStageFor(before);
    coupleRender();
    if (after > before) {
        const info = document.querySelector(".couple-pet-info");
        if (info) {
            const pop = document.createElement("span");
            pop.className = "couple-pts-pop";
            pop.textContent = `+${after - before}점`;
            info.appendChild(pop);
            setTimeout(() => pop.remove(), 1800);
        }
    }
    coupleCheckLevelUp(stageBefore);
}

window.coupleRenamePet = async function() {
    const name = prompt("우리 캐릭터 이름을 지어주세요 (12자까지)", couplePetName());
    if (name === null) return;
    const clean = name.trim().slice(0, 12);
    if (!clean) return;
    couple.pet = Object.assign({}, couple.pet, { name: clean });
    try { await couplePutJson("couple/pet/name", clean); showToast(`이름을 '${clean}'(으)로 바꿨어요 💚`, "success"); }
    catch (e) { showToast("이름을 저장하지 못했어요.", "danger"); }
    coupleRender();
};

// ── Daily question ───────────────────────────────────────────────────────────────────────────────
function coupleQuestionOrder() {
    // Fisher–Yates with a tiny seeded PRNG, so the order is the same on both phones.
    let seed = 0;
    for (const ch of String(syncRoomId)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    seed = seed || 1;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    const order = COUPLE_QUESTIONS.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    return order;
}
let coupleQOrderCache = null;
function coupleQuestionIndex(day) {
    const n = couple.daily[day];
    if (n && Number.isInteger(n.qi) && COUPLE_QUESTIONS[n.qi]) return n.qi;
    if (!coupleQOrderCache || coupleQOrderCache.room !== syncRoomId) coupleQOrderCache = { room: syncRoomId, order: coupleQuestionOrder() };
    const days = Math.floor(Date.UTC(...day.split("-").map((v, i) => i === 1 ? v - 1 : +v)) / 86400000);
    if (!Number.isFinite(days)) return coupleQOrderCache.order[0]; // not a date key
    return coupleQOrderCache.order[((days % COUPLE_QUESTIONS.length) + COUPLE_QUESTIONS.length) % COUPLE_QUESTIONS.length];
}
// "바다 vs 산, 같이 간다면?" → ["바다", "산"]; null for an open question.
function coupleBalanceOptions(q) {
    const m = String(q || "").match(/^(.+?)\s+vs\s+(.+?)(?:,\s*[^,]*)?\?$/);
    return m ? [m[1].trim(), m[2].trim()] : null;
}

function coupleMyAnswer(day = coupleYmd()) {
    const n = couple.daily[day];
    return couple.me && n && n.answer ? n.answer[couple.me] || null : null;
}

window.coupleOpenAnswer = function() {
    couple.answerOpen = true;
    coupleRender();
    setTimeout(() => document.getElementById("couple-answer-text")?.focus({ preventScroll: true }), 50);
};
window.coupleCloseAnswer = function() { couple.answerOpen = false; coupleRender(); };

window.coupleSaveAnswer = async function(choice) {
    if (!couple.me || couple.saving) return;
    const day = coupleYmd();
    const opts = coupleBalanceOptions(COUPLE_QUESTIONS[coupleQuestionIndex(day)]);
    let value;
    if (opts && (choice === 0 || choice === 1)) {
        value = { t: opts[choice], c: choice, at: Date.now() };
    } else {
        const text = String(document.getElementById("couple-answer-text")?.value || "").trim().slice(0, 300);
        if (!text) { showToast("답을 적어주세요", "warning"); return; }
        value = { t: text, at: Date.now() };
    }
    const before = couplePoints();
    couple.saving = true;
    try {
        await couplePutJson(`daily/${day}/answer/${couple.me}`, value);
        couple.daily[day] = couple.daily[day] || {};
        couple.daily[day].answer = Object.assign({}, couple.daily[day].answer, { [couple.me]: value });
        coupleSaveCache();
        couple.answerOpen = false;
        const bothNow = coupleDayStats(day).both;
        showToast(bothNow ? "둘 다 답했어요! 서로의 답을 확인해 보세요 💬" : "답을 남겼어요. 상대가 답하면 공개돼요 🔒", "success");
        coupleAfterPoints(before);
        coupleAnimate(bothNow ? "love" : "squish");
    } catch (e) {
        console.error("[Couple] answer save failed", e);
        showToast("저장하지 못했어요. 인터넷 연결을 확인해 주세요.", "danger");
    } finally {
        couple.saving = false;
    }
};

// Swap today's question (only before anyone has answered it).
window.coupleSwapQuestion = async function() {
    const day = coupleYmd();
    const n = couple.daily[day] || {};
    if (n.answer && (n.answer.A || n.answer.B)) { showToast("이미 답이 있는 질문은 바꿀 수 없어요", "warning"); return; }
    const cur = coupleQuestionIndex(day);
    let next = cur;
    while (next === cur) next = Math.floor(Math.random() * COUPLE_QUESTIONS.length);
    try {
        await couplePutJson(`daily/${day}/qi`, next);
        couple.daily[day] = Object.assign({}, n, { qi: next });
        coupleSaveCache();
        coupleRender();
    } catch (e) { showToast("질문을 바꾸지 못했어요.", "danger"); }
};

function coupleQuestionHtml() {
    const day = coupleYmd();
    const q = COUPLE_QUESTIONS[coupleQuestionIndex(day)];
    const n = couple.daily[day] || {};
    const ans = n.answer || {};
    const mine = ans[couple.me], theirs = ans[coupleOther(couple.me)];
    const other = coupleName(coupleOther(couple.me));
    const opts = coupleBalanceOptions(q);
    let body;
    if (opts) {
        // Balance game: one tap answers (tap the other side to change your mind).
        const pick = mine ? (mine.c ?? opts.indexOf(mine.t)) : -1;
        const theirPick = theirs ? (theirs.c ?? opts.indexOf(theirs.t)) : -1;
        const showTheirs = mine && theirs;
        body = `<div class="couple-bal">${opts.map((o, i) => `
            <button type="button" class="couple-bal-btn${pick === i ? " is-mine" : ""}${showTheirs && theirPick === i ? " is-theirs" : ""}" onclick="coupleSaveAnswer(${i})">
                <span class="couple-bal-text">${escapeHtml(o)}</span>
                <span class="couple-bal-who">${pick === i ? "나" : ""}${showTheirs && theirPick === i ? `${pick === i ? " · " : ""}${escapeHtml(other)}` : ""}</span>
            </button>`).join("")}</div>`;
        if (showTheirs) {
            body += `<div class="couple-bal-result">${pick === theirPick ? "💚 같은 선택이에요! 역시 우리" : "😆 서로 달라요! 오늘은 누구 취향대로?"}</div>`;
        } else if (theirs) {
            body += `<div class="couple-ans is-locked"><b>${escapeHtml(other)}</b><span>🔒 골랐어요! 나도 고르면 볼 수 있어요</span></div>`;
        } else {
            body += `<div class="couple-ans is-wait"><b>${escapeHtml(other)}</b><span>${mine ? "아직 고르지 않았어요" : "하나를 눌러서 골라주세요"}</span></div>`;
        }
    } else if (couple.answerOpen) {
        body = `<textarea id="couple-answer-text" rows="3" maxlength="300" placeholder="나의 답을 적어주세요">${escapeHtml(mine ? mine.t : "")}</textarea>
            <div class="couple-mood-actions">
                <button type="button" class="btn btn-outline" onclick="coupleCloseAnswer()">취소</button>
                <button type="button" class="btn btn-primary" onclick="coupleSaveAnswer()">답하기</button>
            </div>`;
    } else {
        const myLine = mine
            ? `<div class="couple-ans is-me"><b>나</b><span>${escapeHtml(mine.t)}</span><button type="button" class="couple-link" onclick="coupleOpenAnswer()">고치기</button></div>`
            : `<button type="button" class="btn btn-primary couple-answer-btn" onclick="coupleOpenAnswer()">✍️ 내 답 남기기</button>`;
        const theirLine = theirs
            ? (mine ? `<div class="couple-ans"><b>${escapeHtml(other)}</b><span>${escapeHtml(theirs.t)}</span></div>`
                    : `<div class="couple-ans is-locked"><b>${escapeHtml(other)}</b><span>🔒 답했어요! 나도 답하면 볼 수 있어요</span></div>`)
            : `<div class="couple-ans is-wait"><b>${escapeHtml(other)}</b><span>아직 답하지 않았어요</span></div>`;
        body = myLine + theirLine;
    }
    const canSwap = !(ans.A || ans.B);
    return `<div class="couple-q">
        <div class="couple-q-head"><span class="couple-q-label">💬 오늘의 질문</span>
            ${canSwap ? `<button type="button" class="couple-link" onclick="coupleSwapQuestion()">다른 질문</button>` : ""}</div>
        <div class="couple-q-text">${escapeHtml(q)}</div>
        ${body}
    </div>`;
}

// Past questions (newest first). The partner's answer shows only where I answered too.
window.coupleOpenArchive = function() {
    const days = Object.keys(couple.daily).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && couple.daily[d].answer).sort().reverse();
    const other = coupleOther(couple.me);
    const items = days.map(d => {
        const a = couple.daily[d].answer || {};
        const mine = a[couple.me], theirs = a[other];
        return `<div class="couple-arch-item">
            <div class="couple-arch-date">${d.replace(/-/g, ".")}</div>
            <div class="couple-q-text">${escapeHtml(COUPLE_QUESTIONS[coupleQuestionIndex(d)])}</div>
            <div class="couple-ans is-me"><b>나</b><span>${mine ? escapeHtml(mine.t) : "<i>답하지 않았어요</i>"}</span></div>
            <div class="couple-ans"><b>${escapeHtml(coupleName(other))}</b><span>${theirs ? (mine ? escapeHtml(theirs.t) : "🔒 내가 답한 날만 볼 수 있어요") : "<i>답하지 않았어요</i>"}</span></div>
        </div>`;
    }).join("") || `<div class="couple-who-hint">아직 답한 질문이 없어요. 오늘의 질문부터 시작해 보세요!</div>`;
    const body = document.getElementById("couple-archive-body");
    if (body) body.innerHTML = items;
    document.getElementById("modal-couple-archive")?.classList.add("active");
};
window.coupleCloseArchive = function() { document.getElementById("modal-couple-archive")?.classList.remove("active"); };

// ── Level-up / hatch celebration ─────────────────────────────────────────────────────────────────
function coupleCheckLevelUp(stageBefore) {
    const stage = coupleStageFor(couplePoints());
    const key = `aura_couple_stage_${syncRoomId}`;
    let seen = stageBefore;
    try { seen = Math.max(stageBefore ?? 0, Number(localStorage.getItem(key) || 0)); } catch (_) { }
    try { localStorage.setItem(key, String(stage)); } catch (_) { }
    if (stage > seen) {
        const msg = stage === 1 ? `🐣 ${couplePetName()}가 알에서 깨어났어요!` : `🌱 ${couplePetName()}가 '${COUPLE_STAGES[stage].name}'(으)로 자랐어요!`;
        showToast(msg, "success");
        setTimeout(() => coupleAnimate("bloom"), 300);
    }
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
    const before = couplePoints();
    couple.saving = true;
    try {
        await couplePutJson(`daily/${day}/mood/${couple.me}`, value);
        couple.daily[day] = couple.daily[day] || {};
        couple.daily[day].mood = Object.assign({}, couple.daily[day].mood, { [couple.me]: value });
        coupleSaveCache();
        couple.pickerOpen = false;
        showToast("오늘의 기분을 남겼어요 " + value.e, "success");
        couple.saving = false;
        coupleAfterPoints(before);
        return;
    } catch (e) {
        console.error("[Couple] mood save failed", e);
        showToast("저장하지 못했어요. 인터넷 연결을 확인해 주세요.", "danger");
    } finally {
        couple.saving = false;
    }
    coupleRender();
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
                : `<div class="couple-mood-empty is-wait">💭<span>아직이에요</span></div>`}
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

function couplePetHtml() {
    const points = couplePoints();
    const stage = coupleStageFor(points);
    const state = couplePetState();
    const next = COUPLE_STAGES[stage + 1];
    const pct = next ? Math.round((points - COUPLE_STAGES[stage].min) / (next.min - COUPLE_STAGES[stage].min) * 100) : 100;
    const streak = coupleStreak();
    const other = coupleOther(couple.me);
    return `<div class="couple-pet-row">
        <div id="couple-pet" class="couple-pet pet-${state}${stage === 0 ? " pet-egg" : ""}" data-stage="${stage}" data-state="${state}" onclick="couplePetTap()" role="button" aria-label="${escapeHtml(couplePetName())}">
            <div id="couple-pet-fx" class="couple-pet-fx"></div>
            ${state === "sleepy" ? `<div class="couple-zz"><span>z</span><span>z</span><span>z</span></div>` : ""}
            <img id="couple-pet-img" src="${coupleSprite(stage, state, false)}" alt="" draggable="false">
        </div>
        <div class="couple-pet-info">
            <button type="button" class="couple-pet-name" onclick="coupleRenamePet()" title="이름 바꾸기">${escapeHtml(couplePetName())} <span>✏️</span></button>
            <div class="couple-pet-stage">${COUPLE_STAGES[stage].name}${next ? ` · 다음 '${next.name}'까지 ${next.min - points}점` : " · 최고 단계!"}</div>
            <div class="couple-pet-bar"><span style="width:${pct}%"></span></div>
            <div class="couple-pet-meta">${streak > 0 ? `<span>🔥 ${streak}일 연속</span>` : ""}<span id="couple-presence">${coupleIsOnline(other) ? `🟢 ${escapeHtml(coupleName(other))} 접속 중` : ""}</span></div>
            <button type="button" class="couple-heart-btn" onclick="coupleSendHeart()">💗 하트 보내기</button>
        </div>
    </div>`;
}

function coupleRenderPresence() {
    const el = document.getElementById("couple-presence");
    if (!el || !couple.me) return;
    const other = coupleOther(couple.me);
    el.textContent = coupleIsOnline(other) ? `🟢 ${coupleName(other)} 접속 중` : "";
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
        ${couplePetHtml()}
        ${coupleQuestionHtml()}
        <div class="couple-moods">${coupleMoodSide(couple.me)}${coupleMoodSide(coupleOther(couple.me))}</div>
        ${picker}
        ${coupleWeekStrip()}
        <div class="couple-foot">
            <button type="button" class="couple-link" onclick="coupleOpenArchive()">📖 지난 질문 모아보기</button>
            <button type="button" class="couple-link" onclick="coupleForgetMe()">이 폰: ${escapeHtml(coupleName(couple.me))} · 바꾸기</button>
        </div>`;
    coupleScheduleBlink();
    const state = couplePetState();
    const key = `aura_couple_bloom_${syncRoomId}`;
    if (state === "bloom" && (() => { try { return localStorage.getItem(key) !== coupleYmd(); } catch (_) { return true; } })()) {
        // Anniversary: bloom once per day when the card is first shown.
        try { localStorage.setItem(key, coupleYmd()); } catch (_) { }
        setTimeout(() => coupleAnimate("bloom"), 400);
    }
}

// Visits / 꾸민 사진 change the points: refresh them now and then (cheap, local DB only).
setInterval(() => {
    if (!couple.pollId || document.visibilityState !== "visible") return;
    const before = couple.extraPoints;
    coupleRefreshExtraPoints().then(() => { if (couple.extraPoints !== before) coupleRender(); });
}, 60000);

// The date rolls over at midnight while the app may stay open: re-render when the day changes.
let coupleRenderedDay = coupleYmd();
setInterval(() => {
    if (coupleYmd() !== coupleRenderedDay) { coupleRenderedDay = coupleYmd(); coupleRender(); }
}, 60000);
