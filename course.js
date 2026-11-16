// course.js — 날씨 맞춤 AI 데이트 코스 (the AI 플래너 tab). Replaced the old free-text chat in v415.
//
// Flow: pick a date, an area, a time window, vibes and a budget → find the area's coordinates (Kakao
// keyword search, then Kakao address search, then Open-Meteo's geocoder) → read that day's forecast
// and fine dust from Open-Meteo (free, no key, CORS-enabled; forecast reaches 16 days ahead, air
// quality about 5) → ask Gemini for a timed course that fits the weather, our wishlist, places we've
// already been, festivals on that day and both partners' food notes from 서로 사용 설명서 → check every
// place against Kakao Places near the area and take the real address and coordinates from there.
//
// Loaded as a plain script after app.js and shares its globals (callGeminiRaw, cleanAndParseJSON,
// geminiApiKey, db, escapeHtml, jsArg, showToast, formatCurrency, waitForKakaoSdk, searchKakaoGeocoder,
// festivalItems, aiCoursePlacesStore, viewCoursePlaceOnMap, openCourseSaveDateModal,
// openSinglePlaceSaveDateModal …). Map pins and saving to the wishlist reuse app.js's course helpers,
// which already handle both the Naver and the Leaflet map.

const COURSE_VIBES = [
    ["walk", "🚶 산책"], ["food", "🍽️ 맛집"], ["cafe", "☕ 카페"], ["culture", "🎨 전시·문화"],
    ["activity", "🎳 액티비티"], ["night", "🌃 야경"], ["shopping", "🛍️ 쇼핑"], ["nature", "🌿 자연"]
];
const COURSE_TIMES = {
    day: { label: "☀️ 낮", from: 11, to: 18 },
    evening: { label: "🌙 저녁", from: 17, to: 22 },
    all: { label: "🌈 하루 종일", from: 11, to: 22 }
};
const COURSE_BUDGETS = [["30000", "~3만 원"], ["50000", "~5만 원"], ["100000", "~10만 원"], ["", "상관없음"]];
const COURSE_CATEGORY_KO = {
    Cafe: "카페", Restaurant: "맛집", Bar: "술집", Park: "산책·공원", Museum: "전시·문화",
    Activity: "액티비티", Shopping: "쇼핑", Other: "기타"
};
const COURSE_FORECAST_DAYS = 15;   // Open-Meteo forecasts today + 15 days
const COURSE_AIR_DAYS = 4;         // air quality forecast reach
const COURSE_NEAR_KM = 12;         // wishlist / visited places this close to the area are offered to the AI
const COURSE_VERIFY_KM = 25;       // a Kakao match farther than this from the area is not the same place
const COURSE_KEEP_RESULTS = 3;

const coursePlan = {
    prefs: null,      // { region, time, vibes[], budget, useWish, useManual, extra }
    date: "",         // YYYY-MM-DD
    busy: false,
    results: []       // newest first: { id, date, region, time, center, weather, course }
};

function coursePrefsKey() { return "aura_course_prefs"; }
function courseResultsKey() { return `aura_course_last_${syncRoomId}`; }

function courseYmd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function courseParseYmd(s) { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); }
function courseDaysAhead(ymd) {
    const t = new Date();
    return Math.round((courseParseYmd(ymd) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
}
function courseDateLabel(ymd) {
    const d = courseParseYmd(ymd);
    return `${d.getMonth() + 1}월 ${d.getDate()}일 (${"일월화수목금토"[d.getDay()]})`;
}
function courseDistKm(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

function courseLoadPrefs() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(coursePrefsKey()) || "null"); } catch (_) { }
    coursePlan.prefs = Object.assign({ region: "", time: "day", vibes: [], budget: "", useWish: true, useManual: true, extra: "" }, p || {});
    if (!COURSE_TIMES[coursePlan.prefs.time]) coursePlan.prefs.time = "day";
}
function courseSavePrefs() {
    const { region, time, vibes, budget, useWish, useManual } = coursePlan.prefs;
    try { localStorage.setItem(coursePrefsKey(), JSON.stringify({ region, time, vibes, budget, useWish, useManual })); } catch (_) { }
}
function courseLoadResults() {
    try { coursePlan.results = JSON.parse(localStorage.getItem(courseResultsKey()) || "[]") || []; } catch (_) { coursePlan.results = []; }
}
function courseStoreResults() {
    try { localStorage.setItem(courseResultsKey(), JSON.stringify(coursePlan.results.slice(0, COURSE_KEEP_RESULTS))); } catch (_) { }
}

// ── Form ─────────────────────────────────────────────────────────────────────────────────────────
function courseDateChips() {
    const today = new Date();
    const chips = [{ label: "오늘", d: today }, { label: "내일", d: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1) }];
    for (const [dow, name] of [[6, "토"], [0, "일"]]) {
        const add = (dow - today.getDay() + 7) % 7;
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + add);
        chips.push({ label: `${name} ${d.getMonth() + 1}/${d.getDate()}`, d });
    }
    const seen = new Set();
    return chips.filter(c => { const k = courseYmd(c.d); if (seen.has(k)) return false; seen.add(k); return true; })
        .map(c => ({ label: c.label, ymd: courseYmd(c.d) }));
}

function courseRenderForm() {
    const box = document.getElementById("course-builder");
    if (!box) return;
    if (!coursePlan.prefs) courseLoadPrefs();
    if (!coursePlan.date || courseDaysAhead(coursePlan.date) < 0) coursePlan.date = courseYmd(new Date());
    const p = coursePlan.prefs;
    const chip = (active, onclick, label) => `<button type="button" class="studio-chip small${active ? " active" : ""}" onclick="${onclick}">${label}</button>`;
    const dateChips = courseDateChips();
    box.innerHTML = `
        <div class="course-form-head">
            <div class="bot-avatar"><i data-lucide="cloud-sun"></i></div>
            <div>
                <div class="bot-name">날씨 맞춤 AI 데이트 코스</div>
                <div class="bot-status">그날 날씨·미세먼지를 보고, 우리 위시리스트와 취향까지 챙겨서 짜드려요</div>
            </div>
        </div>
        <div class="course-field">
            <label>📅 언제</label>
            <div class="studio-chips">
                ${dateChips.map(c => chip(c.ymd === coursePlan.date, `courseSetDate('${c.ymd}')`, c.label)).join("")}
                <input type="date" class="course-date-input" value="${coursePlan.date}" min="${courseYmd(new Date())}" onchange="courseSetDate(this.value)">
            </div>
            <div class="studio-chips">
                ${Object.entries(COURSE_TIMES).map(([k, t]) => chip(p.time === k, `courseSetPref('time', '${k}')`, t.label)).join("")}
            </div>
        </div>
        <div class="course-field">
            <label for="course-region">📍 어디서</label>
            <input type="text" id="course-region" class="course-input" maxlength="40" placeholder="예: 대전 둔산동, 성수동, 전주 한옥마을" value="${escapeHtml(p.region)}" oninput="coursePlan.prefs.region = this.value">
        </div>
        <div class="course-field">
            <label>💗 이런 데이트 (여러 개 골라도 돼요)</label>
            <div class="studio-chips">
                ${COURSE_VIBES.map(([k, l]) => chip(p.vibes.includes(k), `courseToggleVibe('${k}')`, l)).join("")}
            </div>
        </div>
        <div class="course-field">
            <label>💰 예산 (둘이 합쳐)</label>
            <div class="studio-chips">
                ${COURSE_BUDGETS.map(([k, l]) => chip(p.budget === k, `courseSetPref('budget', '${k}')`, l)).join("")}
            </div>
        </div>
        <div class="course-field">
            <label for="course-extra">✍️ 더 바라는 점 (선택)</label>
            <input type="text" id="course-extra" class="course-input" maxlength="120" placeholder="예: 조용한 곳 위주로, 마지막은 분위기 좋은 바" value="${escapeHtml(p.extra || "")}" oninput="coursePlan.prefs.extra = this.value">
        </div>
        <div class="course-checks">
            <label><input type="checkbox" ${p.useWish ? "checked" : ""} onchange="coursePlan.prefs.useWish = this.checked; courseSavePrefs()"> 💖 위시리스트 장소 넣어주기</label>
            <label><input type="checkbox" ${p.useManual ? "checked" : ""} onchange="coursePlan.prefs.useManual = this.checked; courseSavePrefs()"> 📖 서로 사용 설명서의 음식 취향 반영</label>
        </div>
        <button type="button" id="course-go-btn" class="btn btn-primary course-go" onclick="courseGenerate()" ${coursePlan.busy ? "disabled" : ""}>
            ${coursePlan.busy ? `<span class="course-spin"></span> <span id="course-progress">코스 짜는 중…</span>` : "✨ 날씨 보고 코스 짜기"}
        </button>`;
    if (window.lucide) lucide.createIcons();
}

window.courseSetDate = function(ymd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || "")) return;
    if (courseDaysAhead(ymd) < 0) { showToast("지난 날짜는 고를 수 없어요", "warning"); ymd = courseYmd(new Date()); }
    coursePlan.date = ymd;
    courseRenderForm();
};
window.courseSetPref = function(key, value) {
    coursePlan.prefs[key] = value;
    courseSavePrefs();
    courseRenderForm();
};
window.courseToggleVibe = function(k) {
    const v = coursePlan.prefs.vibes;
    coursePlan.prefs.vibes = v.includes(k) ? v.filter(x => x !== k) : v.concat(k);
    courseSavePrefs();
    courseRenderForm();
};

function courseProgress(text) {
    const el = document.getElementById("course-progress");
    if (el) el.textContent = text;
}

// ── Location & weather ───────────────────────────────────────────────────────────────────────────
async function courseFetchJson(url, ms = 8000) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally { clearTimeout(t); }
}

function courseKakaoKeyword(query, opts) {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve([]), 4000);
        try {
            new window.kakao.maps.services.Places().keywordSearch(query, (data, status) => {
                clearTimeout(t);
                resolve(status === window.kakao.maps.services.Status.OK && Array.isArray(data) ? data : []);
            }, opts);
        } catch (_) { clearTimeout(t); resolve([]); }
    });
}

async function courseKakaoReady() {
    try { return typeof waitForKakaoSdk === "function" && await waitForKakaoSdk(2500) && !!(window.kakao && window.kakao.maps && window.kakao.maps.services); }
    catch (_) { return false; }
}

async function courseGeocode(region) {
    if (await courseKakaoReady()) {
        const hits = await courseKakaoKeyword(region, { size: 1 });
        if (hits[0]) return { lat: parseFloat(hits[0].y), lng: parseFloat(hits[0].x) };
        try {
            const geo = typeof searchKakaoGeocoder === "function" ? await searchKakaoGeocoder(region) : null;
            if (geo && geo[0]) return { lat: geo[0].lat, lng: geo[0].lng };
        } catch (_) { }
    }
    try {
        const name = region.trim().split(/\s+/).pop();
        const data = await courseFetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=ko&countryCode=KR`);
        const r = data && data.results && data.results[0];
        if (r) return { lat: r.latitude, lng: r.longitude };
    } catch (_) { }
    return null;
}

// WMO weather codes → Korean label + emoji.
function courseWeatherLabel(code) {
    const c = Number(code);
    if (c === 0) return ["☀️", "맑음"];
    if (c === 1) return ["🌤️", "대체로 맑음"];
    if (c === 2) return ["⛅", "구름 조금"];
    if (c === 3) return ["☁️", "흐림"];
    if (c === 45 || c === 48) return ["🌫️", "안개"];
    if (c >= 51 && c <= 57) return ["🌦️", "이슬비"];
    if (c >= 61 && c <= 67) return ["🌧️", "비"];
    if (c >= 71 && c <= 77) return ["🌨️", "눈"];
    if (c >= 80 && c <= 82) return ["🌦️", "소나기"];
    if (c === 85 || c === 86) return ["🌨️", "눈 소나기"];
    if (c >= 95) return ["⛈️", "뇌우"];
    return ["🌡️", "날씨"];
}

// Korean 환경부 grades: PM10 30/80/150, PM2.5 15/35/75.
function courseDustGrade(pm10, pm25) {
    const g = (v, cuts) => v == null ? -1 : v <= cuts[0] ? 0 : v <= cuts[1] ? 1 : v <= cuts[2] ? 2 : 3;
    const grade = Math.max(g(pm10, [30, 80, 150]), g(pm25, [15, 35, 75]));
    return grade < 0 ? null : ["좋음", "보통", "나쁨", "매우 나쁨"][grade];
}

async function courseWeather(center, ymd, time) {
    const ahead = courseDaysAhead(ymd);
    if (ahead > COURSE_FORECAST_DAYS) return { none: true };
    const win = COURSE_TIMES[time] || COURSE_TIMES.day;
    const lat = center.lat.toFixed(3), lng = center.lng.toFixed(3);
    const wUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunset,wind_speed_10m_max` +
        `&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code` +
        `&wind_speed_unit=ms&timezone=Asia%2FSeoul&start_date=${ymd}&end_date=${ymd}`;
    const aUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}` +
        `&hourly=pm10,pm2_5&timezone=Asia%2FSeoul&start_date=${ymd}&end_date=${ymd}`;
    const [w, a] = await Promise.all([
        courseFetchJson(wUrl),
        ahead <= COURSE_AIR_DAYS ? courseFetchJson(aUrl).catch(() => null) : Promise.resolve(null)
    ]);
    const d = w.daily || {}, h = w.hourly || {};
    const hours = [];
    (h.time || []).forEach((t, i) => {
        const hr = Number(String(t).slice(11, 13));
        if (hr < win.from || hr > win.to) return;
        hours.push({ h: hr, t: h.temperature_2m[i], feel: h.apparent_temperature[i], pop: h.precipitation_probability[i], rain: h.precipitation[i], code: h.weather_code[i] });
    });
    let pm10 = null, pm25 = null;
    if (a && a.hourly) {
        const pick = (arr) => {
            const vals = (a.hourly.time || []).map((t, i) => [Number(String(t).slice(11, 13)), arr[i]])
                .filter(([hr, v]) => hr >= win.from && hr <= win.to && v != null).map(([, v]) => v);
            return vals.length ? Math.round(Math.max(...vals)) : null;
        };
        pm10 = pick(a.hourly.pm10 || []);
        pm25 = pick(a.hourly.pm2_5 || []);
    }
    const popMax = hours.length ? Math.max(...hours.map(x => x.pop || 0)) : (d.precipitation_probability_max || [0])[0];
    const rainSum = hours.reduce((s, x) => s + (x.rain || 0), 0);
    const feels = hours.map(x => x.feel).filter(v => v != null);
    // The day's code can say "rain" for a shower at 5am; inside the window, use the worst hour.
    const worst = hours.length ? hours.reduce((m, x) => (x.code > m ? x.code : m), 0) : (d.weather_code || [0])[0];
    return {
        none: false,
        code: worst,
        tmin: Math.round((d.temperature_2m_min || [0])[0]),
        tmax: Math.round((d.temperature_2m_max || [0])[0]),
        feelMin: feels.length ? Math.round(Math.min(...feels)) : null,
        feelMax: feels.length ? Math.round(Math.max(...feels)) : null,
        pop: popMax,
        rain: Math.round(rainSum * 10) / 10,
        wind: Math.round(((d.wind_speed_10m_max || [0])[0]) * 10) / 10,
        sunset: String((d.sunset || [""])[0]).slice(11, 16),
        pm10, pm25, dust: courseDustGrade(pm10, pm25),
        hours
    };
}

function courseWeatherForPrompt(w, time) {
    if (!w || w.none) return "No forecast yet (more than two weeks away). Plan for typical weather of that season in Korea and keep a rainy-day alternative in mind.";
    const win = COURSE_TIMES[time] || COURSE_TIMES.day;
    const lines = [
        `Overall ${win.from}:00–${win.to}:00: ${courseWeatherLabel(w.code)[1]}, ${w.tmin}–${w.tmax}°C (feels ${w.feelMin}–${w.feelMax}°C), max precipitation probability ${w.pop}%, expected rain ${w.rain}mm, max wind ${w.wind} m/s, sunset ${w.sunset}.`,
        w.dust ? `Fine dust: ${w.dust} (PM10 ${w.pm10}, PM2.5 ${w.pm25} µg/m³, Korean standard).` : "Fine dust: unknown.",
        "Hourly: " + w.hours.filter((_, i) => i % 2 === 0).map(x => `${x.h}h ${courseWeatherLabel(x.code)[1]} ${Math.round(x.t)}°C rain ${x.pop}%`).join("; ")
    ];
    return lines.join("\n");
}

// ── Personal context: wishlist, visited, festivals, food notes ──────────────────────────────────
async function courseNearbyPlaces(center) {
    const out = { wish: [], visited: [] };
    try {
        const rows = (await db.places.toArray()).filter(p => p.isDeleted !== 1 && typeof p.lat === "number" && typeof p.lng === "number");
        for (const p of rows) {
            if (courseDistKm(center, p) > COURSE_NEAR_KM) continue;
            const visited = p.isVisited === 1 || p.isVisited === true || p.isVisited === "1";
            (visited ? out.visited : out.wish).push(`${p.name}${p.category ? ` (${p.category})` : ""}`);
        }
    } catch (_) { }
    out.wish = out.wish.slice(0, 15);
    out.visited = out.visited.slice(0, 30);
    return out;
}

function courseFestivalsOn(center, ymd) {
    try {
        const day = ymd.replace(/-/g, "");
        return (typeof festivalItems !== "undefined" ? festivalItems : [])
            .filter(f => f && f.startDate <= day && (f.endDate || f.startDate) >= day)
            .filter(f => typeof f.lat === "number" && typeof f.lng === "number" && courseDistKm(center, f) <= COURSE_NEAR_KM * 2)
            .slice(0, 3)
            .map(f => `${f.title} — ${f.addr}`);
    } catch (_) { return []; }
}

const COURSE_SYSTEM = `You are AURA's date-course planner for a Korean couple. Plan a realistic date course in South Korea for the given date, area and time window, adapted to the weather forecast.
Rules:
- 5 to 7 stops in a sensible visiting order, each with a start time (HH:MM, 24h) inside the time window. Keep consecutive stops within a short walk or a short taxi ride, and say how to get to the next stop.
- Fit the weather: when rain or snow is likely (precipitation probability 50% or more, or rain expected) or fine dust is 나쁨/매우 나쁨, keep almost every stop indoors. When it feels cold (≤ 3°C) or hot (≥ 30°C), keep outdoor time short. Put walks and views in the driest, most comfortable hours, and night views after sunset.
- Only real places that are operating now and that you are confident exist in that area. Use the exact name shown on Naver/Kakao maps. Never invent places.
- Strictly respect both partners' food dislikes and allergies when given.
- If our wishlist places are listed and fit, include one or two of them and set "fromWishlist": true.
- Avoid places from the "already visited" list unless the request asks for them.
- If festivals are listed and fit the request, you may include one.
- Stay within the budget if one is given.
- Write every text field in natural, friendly Korean (해요체).
Return only this JSON:
{
  "title": "short course title",
  "summary": "1–2 sentences about the course",
  "weatherTip": "1–2 sentences on how the course fits the weather (e.g. what to bring or wear)",
  "places": [
    {
      "time": "13:00",
      "name": "exact place name",
      "category": "Cafe" | "Restaurant" | "Bar" | "Park" | "Museum" | "Activity" | "Shopping" | "Other",
      "indoor": true,
      "address": "real Korean street address only",
      "lat": 36.35,
      "lng": 127.38,
      "why": "what to eat/do there and why it fits (1–2 sentences)",
      "move": "how to get to the next stop, e.g. 도보 5분 (empty for the last stop)",
      "estimatedCost": 20000,
      "fromWishlist": false
    }
  ],
  "totalCost": 60000
}`;

async function courseBuildPrompt(ctx) {
    const p = ctx.prefs;
    const win = COURSE_TIMES[p.time] || COURSE_TIMES.day;
    const vibes = p.vibes.map(k => (COURSE_VIBES.find(v => v[0] === k) || [k, k])[1].replace(/^\S+\s/, ""));
    const lines = [
        `Date: ${ctx.date} (${courseDateLabel(ctx.date)})`,
        `Area: ${p.region}`,
        `Time window: ${win.from}:00–${win.to}:00`,
        `Wanted: ${vibes.length ? vibes.join(", ") : "anything that suits the weather"}`,
        `Budget for two: ${p.budget ? `up to ${Number(p.budget).toLocaleString()} KRW` : "no limit"}`,
        "",
        "Weather forecast:",
        courseWeatherForPrompt(ctx.weather, p.time)
    ];
    if (p.useManual && typeof togetherManualFoodNotes === "function") {
        const food = togetherManualFoodNotes();
        if (food) lines.push("", "Food notes (from each partner's own profile):", food);
    }
    if (p.useWish && ctx.near.wish.length) lines.push("", "Our wishlist places near the area:", ctx.near.wish.join("; "));
    if (ctx.near.visited.length) lines.push("", "Already visited near the area:", ctx.near.visited.join("; "));
    if (ctx.festivals.length) lines.push("", "Festivals/events on that date nearby:", ctx.festivals.join("; "));
    if (p.extra) lines.push("", `Extra request: ${p.extra}`);
    if (ctx.previous) {
        lines.push("", "Previous course (JSON):", JSON.stringify(ctx.previous), "", `Change it as follows and return the whole updated course: ${ctx.change}`);
    }
    return lines.join("\n");
}

// Look every stop up in Kakao Places near the area: take the real address/coordinates when found,
// otherwise flag it so the card can say the location is unconfirmed.
async function courseVerifyPlaces(places, center) {
    if (!(await courseKakaoReady())) return places;
    const LatLng = window.kakao.maps.LatLng;
    return Promise.all(places.map(async (pl) => {
        const anchor = (typeof pl.lat === "number" && typeof pl.lng === "number" && courseDistKm(center, pl) < COURSE_VERIFY_KM) ? pl : center;
        const hits = await courseKakaoKeyword(pl.name, { size: 5, location: new LatLng(anchor.lat, anchor.lng), radius: 20000 });
        const norm = s => String(s || "").replace(/\s+/g, "").toLowerCase();
        const want = norm(pl.name);
        const hit = hits.find(h => {
            const n = norm(h.place_name);
            return (n.includes(want) || want.includes(n)) && courseDistKm(center, { lat: +h.y, lng: +h.x }) <= COURSE_VERIFY_KM;
        });
        if (!hit) return Object.assign({}, pl, { verified: false });
        return Object.assign({}, pl, {
            verified: true,
            name: hit.place_name,
            address: hit.road_address_name || hit.address_name || pl.address,
            lat: parseFloat(hit.y), lng: parseFloat(hit.x),
            kakaoUrl: hit.place_url || ""
        });
    }));
}

function courseNormalize(raw) {
    const c = raw && typeof raw === "object" ? raw : {};
    const places = (Array.isArray(c.places) ? c.places : []).filter(p => p && p.name).map(p => ({
        time: String(p.time || "").slice(0, 5),
        name: String(p.name),
        category: COURSE_CATEGORY_KO[p.category] ? p.category : "Other",
        indoor: p.indoor === true,
        address: String(p.address || ""),
        lat: Number.isFinite(+p.lat) ? +p.lat : null,
        lng: Number.isFinite(+p.lng) ? +p.lng : null,
        why: String(p.why || p.notes || ""),
        move: String(p.move || ""),
        estimatedCost: Math.max(0, Math.round(Number(p.estimatedCost) || 0)),
        fromWishlist: p.fromWishlist === true
    }));
    if (!places.length) throw new Error("코스에 장소가 없어요");
    return {
        title: String(c.title || c.itinerary_title || "우리의 데이트 코스"),
        summary: String(c.summary || c.description || ""),
        weatherTip: String(c.weatherTip || ""),
        places,
        totalCost: Math.round(Number(c.totalCost) || places.reduce((s, p) => s + p.estimatedCost, 0))
    };
}

// ── Generate / refine ────────────────────────────────────────────────────────────────────────────
window.courseGenerate = async function(refineId) {
    if (coursePlan.busy) return;
    if (!geminiApiKey) {
        showToast("설정 탭에서 Gemini API Key를 먼저 저장해 주세요 🔑", "warning");
        return;
    }
    const base = refineId ? coursePlan.results.find(r => r.id === refineId) : null;
    let change = "";
    if (base) {
        change = (document.getElementById(`course-refine-${refineId}`)?.value || "").trim();
        if (!change) { showToast("바꾸고 싶은 점을 적어 주세요", "info"); return; }
    }
    const prefs = base ? Object.assign({}, base.prefs) : Object.assign({}, coursePlan.prefs, { vibes: coursePlan.prefs.vibes.slice() });
    prefs.region = String(prefs.region || "").trim();
    if (!prefs.region) { showToast("어디서 데이트할지 적어 주세요 📍", "info"); document.getElementById("course-region")?.focus(); return; }
    const date = base ? base.date : coursePlan.date;
    if (courseDaysAhead(date) < 0) { showToast("지난 날짜예요. 날짜를 다시 골라 주세요", "warning"); return; }
    if (!base) courseSavePrefs();

    coursePlan.busy = true;
    courseRenderForm();
    if (base) courseRenderResults();
    try {
        let center = base ? base.center : null;
        if (!center) {
            courseProgress("📍 위치 찾는 중…");
            center = await courseGeocode(prefs.region);
            if (!center) throw new Error(`'${prefs.region}' 위치를 못 찾았어요. 동네나 역 이름으로 다시 적어 주세요`);
        }
        let weather = base ? base.weather : null;
        if (!base) {
            courseProgress("☁️ 날씨 확인하는 중…");
            try { weather = await courseWeather(center, date, prefs.time); }
            catch (e) { console.warn("[Course] weather failed", e); weather = { none: true, failed: true }; }
        }
        courseProgress("✨ 코스 짜는 중…");
        const near = await courseNearbyPlaces(center);
        const prompt = await courseBuildPrompt({
            prefs, date, weather, near, festivals: courseFestivalsOn(center, date),
            previous: base ? base.course : null, change
        });
        const text = await callGeminiRaw(prompt, COURSE_SYSTEM, true);
        let course = courseNormalize(cleanAndParseJSON(text));
        courseProgress("🔎 장소 확인하는 중…");
        course.places = await courseVerifyPlaces(course.places, center);
        const result = { id: `course-${Date.now()}`, date, center, weather, prefs, course, refinedFrom: base ? base.id : null };
        coursePlan.results = [result].concat(coursePlan.results).slice(0, COURSE_KEEP_RESULTS);
        courseStoreResults();
        coursePlan.busy = false;
        courseRenderForm();
        courseRenderResults();
        document.getElementById(result.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
        coursePlan.busy = false;
        courseRenderForm();
        courseRenderResults();
        const msg = String(err && err.message || err);
        const quota = /quota|exceeded|429|resource_exhausted/i.test(msg);
        showToast(quota ? "Gemini 무료 사용량을 다 썼어요. 잠시 후 다시 해 주세요 🙏" : `코스를 못 짰어요: ${msg}`, quota ? "warning" : "danger");
        console.warn("[Course] failed", err);
    }
};

window.courseRemoveResult = function(id) {
    coursePlan.results = coursePlan.results.filter(r => r.id !== id);
    courseStoreResults();
    courseRenderResults();
};

// ── Results ──────────────────────────────────────────────────────────────────────────────────────
function courseWeatherHtml(r) {
    const head = `${courseDateLabel(r.date)} · ${escapeHtml(r.prefs.region)} · ${(COURSE_TIMES[r.prefs.time] || COURSE_TIMES.day).label}`;
    const w = r.weather;
    if (!w || w.none) {
        return `<div class="course-weather is-none"><div class="course-weather-head">${head}</div>
            <div class="course-weather-main">${w && w.failed ? "🌡️ 날씨를 불러오지 못해서 계절에 맞춰 짰어요" : "🗓️ 아직 예보가 없는 날이라 계절에 맞춰 짰어요 (보름 안쪽부터 예보가 나와요)"}</div></div>`;
    }
    const [icon, label] = courseWeatherLabel(w.code);
    const bits = [`${w.tmin}° / ${w.tmax}°`, `비 ${w.pop}%`];
    if (w.feelMin != null) bits.push(`체감 ${w.feelMin}~${w.feelMax}°`);
    if (w.dust) bits.push(`미세먼지 ${w.dust}`);
    if (w.wind >= 9) bits.push(`바람 강함 ${w.wind}m/s`);
    if (w.sunset) bits.push(`일몰 ${w.sunset}`);
    const hours = w.hours.filter((_, i) => i % 2 === 0).map(x =>
        `<span class="course-hour"><small>${x.h}시</small>${courseWeatherLabel(x.code)[0]}<b>${Math.round(x.t)}°</b><small class="${x.pop >= 50 ? "is-wet" : ""}">${x.pop}%</small></span>`).join("");
    return `<div class="course-weather">
        <div class="course-weather-head">${head}</div>
        <div class="course-weather-main"><span class="course-weather-icon">${icon}</span><div><b>${label}</b><div class="course-weather-bits">${bits.map(b => `<span>${escapeHtml(b)}</span>`).join("")}</div></div></div>
        <div class="course-hours">${hours}</div>
    </div>`;
}

function courseResultHtml(r) {
    const c = r.course;
    // app.js's map/save helpers read places from aiCoursePlacesStore by id.
    aiCoursePlacesStore[r.id] = c.places.map(p => ({
        name: p.name, category: ["Activity", "Shopping"].includes(p.category) ? "Other" : p.category,
        lat: p.lat, lng: p.lng, address: p.address
    }));
    const steps = c.places.map((p, i) => {
        const hasCoords = typeof p.lat === "number" && typeof p.lng === "number";
        const loc = p.verified === false
            ? `<span class="course-unverified">⚠️ 지도에서 못 찾았어요. 가기 전에 확인해 주세요</span>`
            : `📍 ${escapeHtml(p.address || "주소 정보 없음")}${p.verified ? ` <span class="course-ok">✓</span>` : ""}`;
        const kakao = p.kakaoUrl && typeof safeUrl === "function" && safeUrl(p.kakaoUrl);
        return `<li class="course-step">
            <div class="course-time">${escapeHtml(p.time || `${i + 1}`)}</div>
            <div class="course-step-body">
                <div class="course-step-head"><b>${escapeHtml(p.name)}</b>
                    <span class="course-tag">${COURSE_CATEGORY_KO[p.category] || "기타"}</span>
                    <span class="course-tag ${p.indoor ? "is-in" : "is-out"}">${p.indoor ? "실내" : "야외"}</span>
                    ${p.fromWishlist ? `<span class="course-tag is-wish">💖 위시</span>` : ""}
                </div>
                ${p.why ? `<div class="course-why">${escapeHtml(p.why)}</div>` : ""}
                <div class="course-meta">${loc}${p.estimatedCost ? ` · 💰 ${formatCurrency(p.estimatedCost)}` : ""}</div>
                <div class="course-actions">
                    ${hasCoords ? `<button type="button" class="couple-link" onclick="viewCoursePlaceOnMap('${r.id}', ${i})">🗺️ 지도</button>` : ""}
                    <button type="button" class="couple-link" onclick="courseSavePlaces('${r.id}', ${i})">💖 위시리스트</button>
                    ${kakao ? `<a class="couple-link" href="${escapeHtml(kakao)}" target="_blank" rel="noopener">카카오맵 ↗</a>` : ""}
                </div>
                ${p.move && i < c.places.length - 1 ? `<div class="course-move">↓ ${escapeHtml(p.move)}</div>` : ""}
            </div>
        </li>`;
    }).join("");
    return `<div class="card course-result" id="${r.id}">
        <button type="button" class="course-remove" title="지우기" onclick="courseRemoveResult('${r.id}')">✕</button>
        ${courseWeatherHtml(r)}
        <div class="course-title">💗 ${escapeHtml(c.title)}</div>
        ${c.summary ? `<div class="course-summary">${escapeHtml(c.summary)}</div>` : ""}
        ${c.weatherTip ? `<div class="course-tip">☂️ ${escapeHtml(c.weatherTip)}</div>` : ""}
        <ol class="course-steps">${steps}</ol>
        <div class="course-total">예상 비용 (둘이) <b>${formatCurrency(c.totalCost)}</b></div>
        <button type="button" class="btn btn-primary course-save-all" onclick="courseSavePlaces('${r.id}')">💖 코스 전체 위시리스트에 담기</button>
        <div class="course-refine">
            <input type="text" id="course-refine-${r.id}" class="course-input" maxlength="100" placeholder="바꾸고 싶은 점 (예: 카페 빼고 보드게임 카페 넣어줘)" onkeydown="if(event.key==='Enter'){event.preventDefault();courseGenerate('${r.id}')}">
            <button type="button" class="btn btn-outline" onclick="courseGenerate('${r.id}')" ${coursePlan.busy ? "disabled" : ""}>다시 짜기</button>
        </div>
    </div>`;
}

function courseRenderResults() {
    const box = document.getElementById("course-results");
    if (!box) return;
    box.innerHTML = coursePlan.results.length
        ? coursePlan.results.map(courseResultHtml).join("")
        : `<div class="course-empty">위에서 날짜와 동네를 고르고 <b>✨ 날씨 보고 코스 짜기</b>를 눌러 보세요.<br>비 오는 날엔 실내 위주로, 맑은 날엔 산책과 야경까지 챙겨 드려요 🌦️</div>`;
}

// Save to the wishlist through app.js's date modal, defaulting the date to the course's date.
window.courseSavePlaces = function(id, idx) {
    const r = coursePlan.results.find(x => x.id === id);
    if (!r) return;
    if (idx === undefined) openCourseSaveDateModal(id); else openSinglePlaceSaveDateModal(id, idx);
    const input = document.getElementById("course-save-date-input");
    if (input) input.value = r.date;
};

// The festival panel's "AI 코스" button: fill the form from the festival and plan right away.
window.coursePlanFromFestival = function(ev) {
    if (!coursePlan.prefs) courseLoadPrefs();
    const today = courseYmd(new Date());
    const start = /^\d{8}$/.test(ev.startDate || "") ? `${ev.startDate.slice(0, 4)}-${ev.startDate.slice(4, 6)}-${ev.startDate.slice(6, 8)}` : today;
    coursePlan.date = start < today ? today : start;
    coursePlan.prefs.region = String(ev.addr || "").split(/\s+/).slice(0, 3).join(" ") || coursePlan.prefs.region;
    coursePlan.prefs.extra = `'${ev.title}' 축제를 코스에 꼭 넣어 주세요`;
    courseRenderForm();
    document.getElementById("course-builder")?.scrollIntoView({ behavior: "smooth", block: "start" });
    courseGenerate();
};

// Called once by app.js after start-up (and again after a room switch, to show that room's courses).
window.courseInit = function() {
    courseLoadPrefs();
    courseLoadResults();
    courseRenderForm();
    courseRenderResults();
};
