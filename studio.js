// studio.js — 사진 꾸미기 (Photo Studio), split out of app.js.
//
// Loaded as a plain script right AFTER app.js (see index.html) and shares its globals: db, syncRoomId,
// showToast, escapeHtml, jsArg, switchTab, callGeminiRaw, getFirebaseDbUrl, coupleDayNumber,
// partnerAName/partnerBName, etc. Nothing here runs app logic at load time — app.js only calls in
// (syncCreations, renderCreationsSection) after startup, behind typeof guards, so the rest of the app
// keeps working if this file fails to load. The Dexie "creations" table is declared in app.js
// (section 1) because a Dexie schema must be declared in one place.

// ==========================================
// 16. Photo Studio — collages, filters & the "꾸민 사진" album
// ==========================================
// One editor for both features: pick 1 photo → filter/frame it; pick 2-9 → lay them out as a collage
// (then the same filter/frame step applies to every cell). The result is a single JPEG.
//
// Storage: each result is its OWN cloud node, aura-rooms/{room}/creations/{id} = { img, kind,
// createdAt, sources, caption }, plus a creationsVersion number other devices poll. Unlike place
// photos (one list per place, replaced whole), adding or deleting one creation never rewrites the
// others, so two phones saving at the same time can't overwrite each other. Locally they live in the
// Dexie "creations" table, tagged with their room; uploaded:false marks one still waiting to go out.

const STUDIO_EXPORT_LONG_SIDE = 2048;
const STUDIO_PREVIEW_LONG_SIDE = 720;
const STUDIO_MAX_PHOTOS = 9;

// Cell rects are fractions of the photo area; aspect = width / height of that area.
const STUDIO_LAYOUTS = [
    { id: "single", name: "원본", count: 1, aspect: null, cells: [[0, 0, 1, 1]] },
    { id: "2-side", name: "나란히", count: 2, aspect: 1, cells: [[0, 0, .5, 1], [.5, 0, .5, 1]] },
    { id: "2-stack", name: "위아래", count: 2, aspect: 0.8, cells: [[0, 0, 1, .5], [0, .5, 1, .5]] },
    { id: "3-hero", name: "큰 사진 + 2", count: 3, aspect: 0.8, cells: [[0, 0, 1, .6], [0, .6, .5, .4], [.5, .6, .5, .4]] },
    { id: "3-side", name: "왼쪽 크게", count: 3, aspect: 1, cells: [[0, 0, .5, 1], [.5, 0, .5, .5], [.5, .5, .5, .5]] },
    { id: "4-grid", name: "2×2", count: 4, aspect: 1, cells: [[0, 0, .5, .5], [.5, 0, .5, .5], [0, .5, .5, .5], [.5, .5, .5, .5]] },
    { id: "4-strip", name: "네컷", count: 4, aspect: 1 / 3, cells: [[0, 0, 1, .25], [0, .25, 1, .25], [0, .5, 1, .25], [0, .75, 1, .25]] },
    { id: "6-grid", name: "2×3", count: 6, aspect: 2 / 3, cells: [0, 1, 2].flatMap(r => [[0, r / 3, .5, 1 / 3], [.5, r / 3, .5, 1 / 3]]) },
    { id: "9-grid", name: "3×3", count: 9, aspect: 1, cells: [0, 1, 2].flatMap(r => [0, 1, 2].map(c => [c / 3, r / 3, 1 / 3, 1 / 3])) }
];

// Fitting layouts for n photos: exact fits first; 5 → 2×3 and 7-8 → 3×3 leave soft empty cells.
function studioLayoutsFor(n) {
    const exact = STUDIO_LAYOUTS.filter(l => l.count === n);
    if (exact.length) return exact;
    return STUDIO_LAYOUTS.filter(l => l.count > n && l.count <= n + 2).slice(0, 1);
}

const STUDIO_FILTERS = [
    { id: "none", name: "원본", p: {} },
    { id: "film", name: "필름", p: { contrast: -8, saturation: -15, warmth: 6, fade: 0.25, grain: 10, vignette: 0.25 } },
    { id: "warm", name: "따뜻하게", p: { warmth: 18, saturation: 8, brightness: 4 } },
    { id: "cool", name: "시원하게", p: { warmth: -16, saturation: -4, brightness: 3 } },
    { id: "pink", name: "핑크빛", p: { pink: 16, brightness: 6, saturation: -6, fade: 0.15 } },
    { id: "mono", name: "흑백", p: { grayscale: 1, contrast: 12 } },
    { id: "vintage", name: "빈티지", p: { sepia: 0.45, fade: 0.3, contrast: -10, vignette: 0.35, grain: 8 } },
    { id: "vivid", name: "선명하게", p: { contrast: 16, saturation: 22 } }
];

// `pattern` backgrounds are drawn on the canvas (studioDrawPattern), sized relative to the output width
// so the preview and the 2048px export look the same.
const STUDIO_BACKGROUNDS = [
    { id: "white", label: "흰색", color: "#FFFFFF", text: "#4A2834" },
    { id: "pink", label: "핑크", color: "#FFE4EC", text: "#B5179E" },
    { id: "cream", label: "크림", color: "#FFF6E5", text: "#7A5230" },
    { id: "black", label: "검정", color: "#1E1B1F", text: "#FFFFFF", dark: true },
    { id: "check", label: "핑크 체크", color: "#FFF1F4", text: "#C2185B", pattern: "check", ink: "rgba(255,101,132,0.22)" },
    { id: "hearts", label: "하트", color: "#FFE9F0", text: "#C2185B", pattern: "hearts", ink: "#FF9EB8" },
    { id: "dots", label: "도트", color: "#FFF6E5", text: "#7A5230", pattern: "dots", ink: "rgba(232,160,80,0.42)" },
    { id: "lilac", label: "라벤더 체크", color: "#F3EEFF", text: "#6A3FB5", pattern: "check", ink: "rgba(150,110,230,0.20)" },
    { id: "stars", label: "밤하늘", color: "#1F2547", text: "#FFE9A8", pattern: "stars", ink: "#FFD86B", dark: true }
];

const studio = {
    photos: [],          // [{ src, placeId, placeName, dateMs }]
    layoutId: "single",
    filterId: "none",
    adjust: { brightness: 0, contrast: 0, saturation: 0 },
    gap: 12,             // in export pixels (scaled down for the preview)
    rounded: false,
    bg: "white",
    frame: "none",       // none | polaroid | stamp
    caption: "",
    art: "none",         // painting effect, see STUDIO_ARTS
    smooth: 0,           // 뽀샤시 strength 0-100
    reshape: { jaw: 0, eye: 0 }, // 얼굴 보정 (베타), 0-100 each
    bgSwap: { mode: "none", fill: "pink", outline: false }, // 배경 바꾸기
    logo: false,         // "AURA · date" line in the bottom band (on by default for 네컷)
    items: [],           // stickers / text laid over everything — see studioDrawItems
    selectedId: null,
    renderQueued: false,
    baseDirty: true,
    busy: false
};

// ── Image loading ────────────────────────────────────────────────────────────────────────────────
const studioImageCache = new Map();
function studioLoadImage(src) {
    if (studioImageCache.has(src)) return studioImageCache.get(src);
    const p = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("사진을 불러오지 못했어요"));
        img.src = src;
    });
    studioImageCache.set(src, p);
    p.catch(() => studioImageCache.delete(src));
    return p;
}

// ── Pixel filter (no ctx.filter — Safari on older iPhones doesn't support it) ────────────────────
function studioFilterParams() {
    const preset = (STUDIO_FILTERS.find(f => f.id === studio.filterId) || STUDIO_FILTERS[0]).p;
    return {
        brightness: (preset.brightness || 0) + studio.adjust.brightness,
        contrast: (preset.contrast || 0) + studio.adjust.contrast,
        saturation: (preset.saturation || 0) + studio.adjust.saturation,
        warmth: preset.warmth || 0,
        pink: preset.pink || 0,
        sepia: preset.sepia || 0,
        grayscale: preset.grayscale || 0,
        fade: preset.fade || 0,
        grain: preset.grain || 0,
        vignette: preset.vignette || 0,
        art: studio.art || "none",
        smooth: studio.smooth || 0
    };
}

function studioIsNeutral(p) {
    return !p.brightness && !p.contrast && !p.saturation && !p.warmth && !p.pink && !p.sepia && !p.grayscale && !p.fade && !p.grain;
}

function studioApplyPixels(ctx, w, h, p) {
    if (studioIsNeutral(p)) return;
    const data = ctx.getImageData(0, 0, w, h);
    const d = data.data;
    const br = p.brightness * 1.5;
    const C = Math.max(-200, Math.min(200, p.contrast * 1.8));
    const k = (259 * (C + 255)) / (255 * (259 - C));
    const sat = 1 + p.saturation / 100;
    const warm = p.warmth * 0.8, pink = p.pink;
    const fadeMix = p.fade * 0.3, fadeTo = 170 * fadeMix;
    for (let i = 0; i < d.length; i += 4) {
        let r = d[i] + br, g = d[i + 1] + br, b = d[i + 2] + br;
        r = (r - 128) * k + 128; g = (g - 128) * k + 128; b = (b - 128) * k + 128;
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        r = gray + (r - gray) * sat; g = gray + (g - gray) * sat; b = gray + (b - gray) * sat;
        if (warm) { r += warm; b -= warm; }
        if (pink) { r += pink * 0.7; g -= pink * 0.25; b += pink * 0.35; }
        if (p.sepia) {
            const sr = 0.393 * r + 0.769 * g + 0.189 * b, sg = 0.349 * r + 0.686 * g + 0.168 * b, sb = 0.272 * r + 0.534 * g + 0.131 * b;
            r += (sr - r) * p.sepia; g += (sg - g) * p.sepia; b += (sb - b) * p.sepia;
        }
        if (p.grayscale) {
            const y = 0.299 * r + 0.587 * g + 0.114 * b;
            r += (y - r) * p.grayscale; g += (y - g) * p.grayscale; b += (y - b) * p.grayscale;
        }
        if (fadeMix) { r = r * (1 - fadeMix) + fadeTo; g = g * (1 - fadeMix) + fadeTo; b = b * (1 - fadeMix) + fadeTo; }
        if (p.grain) { const n = (Math.random() - 0.5) * p.grain * 2; r += n; g += n; b += n; }
        d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
        d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
    ctx.putImageData(data, 0, 0);
}

function studioRoundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// One cell: cover-crop the photo into w×h, filter it, add the vignette.
function studioRenderCell(img, w, h, p) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    const ctx = c.getContext("2d");
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height; // img may be a reshaped canvas
    const scale = Math.max(c.width / iw, c.height / ih);
    const sw = c.width / scale, sh = c.height / scale;
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, c.width, c.height);
    if (p.smooth > 0) studioApplySmooth(c, p.smooth);
    if (p.art && p.art !== "none") studioApplyArt(c, p.art);
    studioApplyPixels(ctx, c.width, c.height, p);
    if (p.vignette) {
        const g = ctx.createRadialGradient(c.width / 2, c.height / 2, Math.min(c.width, c.height) * 0.35,
            c.width / 2, c.height / 2, Math.hypot(c.width, c.height) / 2);
        g.addColorStop(0, "rgba(0,0,0,0)");
        g.addColorStop(1, `rgba(0,0,0,${p.vignette * 0.6})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, c.width, c.height);
    }
    return c;
}

const STUDIO_FONT = `"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif`;

// Draws the photos, background, frame and caption (everything except stickers/text) onto `canvas`
// with its long side = longSide px.
async function studioRenderBase(canvas, longSide) {
    const layout = STUDIO_LAYOUTS.find(l => l.id === studio.layoutId) || STUDIO_LAYOUTS[0];
    const images = await studioSourceImages();
    const bg = STUDIO_BACKGROUNDS.find(b => b.id === studio.bg) || STUDIO_BACKGROUNDS[0];
    const caption = studio.caption.trim();

    let areaAspect = layout.aspect;
    if (!areaAspect) {
        const im = images[0];
        areaAspect = Math.max(0.5, Math.min(2, (im.naturalWidth || im.width) / (im.naturalHeight || im.height)));
    }
    // Frame margins, as fractions of the photo area's width.
    const polaroid = studio.frame === "polaroid";
    const isStrip = layout.id === "4-strip";
    const side = polaroid ? 0.06 : 0;
    const top = polaroid ? 0.06 : 0;
    let bottom = polaroid ? 0.24 : 0;
    if (!polaroid && (caption || isStrip || studio.logo)) bottom = isStrip ? 0.32 : (caption && studio.logo ? 0.16 : 0.12);

    const totalW = 1 + side * 2;
    const totalH = 1 / areaAspect + top + bottom;
    const scale = longSide / Math.max(totalW, totalH);
    const W = Math.round(totalW * scale), H = Math.round(totalH * scale);
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, W, H);
    if (bg.pattern) studioDrawPattern(ctx, bg, W, H);

    const unit = W / totalW;                 // px per photo-area width
    const ax = side * unit, ay = top * unit, aw = unit, ah = unit / areaAspect;
    const px = (studio.gap / STUDIO_EXPORT_LONG_SIDE) * longSide; // gap scales with output size
    const multi = layout.cells.length > 1;
    const p = studioFilterParams();

    layout.cells.forEach((cell, i) => {
        // Outer edges get a full gap (only when there's a border to show), inner edges half each side.
        const outer = multi || polaroid ? px : 0;
        const left = cell[0] <= 0.001 ? outer : px / 2;
        const topGap = cell[1] <= 0.001 ? (top > 0 ? 0 : outer) : px / 2;
        const right = cell[0] + cell[2] >= 0.999 ? outer : px / 2;
        const bottomGap = cell[1] + cell[3] >= 0.999 ? (bottom > 0 ? px / 2 : outer) : px / 2;
        const x = ax + cell[0] * aw + left;
        const y = ay + cell[1] * ah + topGap;
        const w = cell[2] * aw - left - right;
        const h = cell[3] * ah - topGap - bottomGap;
        if (w <= 0 || h <= 0) return;
        const radius = studio.rounded ? Math.min(w, h) * 0.06 : 0;
        ctx.save();
        if (radius) { studioRoundRectPath(ctx, x, y, w, h, radius); ctx.clip(); }
        if (images[i]) {
            ctx.drawImage(studioRenderCell(images[i], w, h, p), x, y, w, h);
        } else {
            ctx.fillStyle = bg.dark ? "rgba(255,255,255,0.08)" : "rgba(255,101,132,0.10)";
            ctx.fillRect(x, y, w, h);
        }
        ctx.restore();
    });

    // Date stamp: orange film-camera date in the bottom-right of the photo area.
    if (studio.frame === "stamp") {
        const d = studioDisplayDate();
        const text = `'${String(d.getFullYear()).slice(2)} ${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getDate()).padStart(2, "0")}`;
        const size = Math.round(aw * 0.045);
        ctx.save();
        ctx.font = `bold ${size}px "Courier New", monospace`;
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.shadowColor = "rgba(255,120,30,0.9)";
        ctx.shadowBlur = size * 0.5;
        ctx.fillStyle = "#FF9A3C";
        ctx.fillText(text, ax + aw - size * 1.2, ay + ah - size * 0.9);
        ctx.restore();
    }

    if (bottom > 0) {
        const bandTop = ay + ah, bandH = H - bandTop;
        // With the logo on, the date moves into the logo line, so 네컷 doesn't print it twice.
        const text = caption || (isStrip && !studio.logo ? studioDefaultCaption() : "");
        const logoText = studio.logo ? `AURA  ·  ${studioDefaultCaption()}` : "";
        const fit = (t, maxW) => {
            if (ctx.measureText(t).width <= maxW) return t;
            while (ctx.measureText(t + "…").width > maxW && t.length > 1) t = t.slice(0, -1);
            return t + "…";
        };
        ctx.save();
        ctx.fillStyle = bg.text;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const size = Math.round(Math.min(bandH * 0.32, aw * (isStrip ? 0.085 : polaroid ? 0.068 : 0.055)));
        const logoSize = Math.round(size * (text ? 0.48 : 0.62));
        const gapY = text && logoText ? size * 0.42 : 0;
        const blockH = (text ? size : 0) + (logoText ? logoSize : 0) + gapY;
        let y = bandTop + bandH / 2 - blockH / 2;
        if (text) {
            ctx.font = `700 ${size}px ${STUDIO_FONT}`;
            ctx.fillText(fit(text, aw * 0.9), ax + aw / 2, y + size / 2);
            y += size + gapY;
        }
        if (logoText) {
            ctx.globalAlpha = 0.8;
            ctx.font = `700 ${logoSize}px "Outfit", ${STUDIO_FONT}`;
            ctx.fillText(fit(logoText, aw * 0.9), ax + aw / 2, y + logoSize / 2);
        }
        ctx.restore();
    }
}

// ── Pattern backgrounds ──────────────────────────────────────────────────────────────────────────
function studioHeartPath(ctx, x, y, s) {
    // Heart centred on (x, y), roughly s wide.
    const h = s * 0.5;
    ctx.beginPath();
    ctx.moveTo(x, y + h * 0.75);
    ctx.bezierCurveTo(x - s * 0.62, y + h * 0.05, x - s * 0.42, y - h * 1.05, x, y - h * 0.38);
    ctx.bezierCurveTo(x + s * 0.42, y - h * 1.05, x + s * 0.62, y + h * 0.05, x, y + h * 0.75);
    ctx.closePath();
}

function studioStarPath(ctx, x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
        const rad = i % 2 ? r * 0.45 : r;
        const a = -Math.PI / 2 + i * Math.PI / 5;
        ctx[i ? "lineTo" : "moveTo"](x + Math.cos(a) * rad, y + Math.sin(a) * rad);
    }
    ctx.closePath();
}

function studioDrawPattern(ctx, bg, W, H, cell = Math.sqrt(W * H) * 0.06) {
    ctx.save();
    ctx.fillStyle = bg.ink;
    if (bg.pattern === "check") {
        // Gingham: translucent bands both ways; where they cross they darken.
        for (let x = 0; x < W; x += cell) ctx.fillRect(x, 0, cell / 2, H);
        for (let y = 0; y < H; y += cell) ctx.fillRect(0, y, W, cell / 2);
    } else if (bg.pattern === "dots") {
        for (let row = 0, y = cell / 2; y < H + cell; y += cell * 0.8, row++) {
            for (let x = (row % 2) * cell / 2; x < W + cell; x += cell) {
                ctx.beginPath(); ctx.arc(x, y, cell * 0.13, 0, Math.PI * 2); ctx.fill();
            }
        }
    } else if (bg.pattern === "hearts") {
        const step = cell * 1.3;
        for (let row = 0, y = step / 2; y < H + step; y += step * 0.8, row++) {
            for (let col = 0, x = (row % 2) * step / 2; x < W + step; x += step, col++) {
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate(((row + col) % 2 ? 1 : -1) * 0.25);
                studioHeartPath(ctx, 0, 0, cell * 0.42);
                ctx.fill();
                ctx.restore();
            }
        }
    } else if (bg.pattern === "stars") {
        // Fixed-seed scatter so the preview and the export put every star in the same place.
        let seed = 7;
        const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        const count = Math.round((W * H) / (cell * cell) * 0.9);
        for (let i = 0; i < count; i++) {
            const x = rnd() * W, y = rnd() * H, r = rnd();
            ctx.globalAlpha = 0.45 + rnd() * 0.55;
            if (r > 0.78) { studioStarPath(ctx, x, y, cell * (0.12 + r * 0.12)); ctx.fill(); }
            else { ctx.beginPath(); ctx.arc(x, y, cell * (0.02 + r * 0.04), 0, Math.PI * 2); ctx.fill(); }
        }
    }
    ctx.restore();
}

// Small swatch images for the pattern backgrounds (made once, from the same drawing code).
const studioSwatchCache = new Map();
function studioSwatchImage(bg) {
    if (!bg.pattern) return "";
    if (!studioSwatchCache.has(bg.id)) {
        const c = document.createElement("canvas");
        c.width = c.height = 120;
        const ctx = c.getContext("2d");
        ctx.fillStyle = bg.color;
        ctx.fillRect(0, 0, 120, 120);
        studioDrawPattern(ctx, bg, 120, 120, 26);
        studioSwatchCache.set(bg.id, c.toDataURL("image/png"));
    }
    return studioSwatchCache.get(bg.id);
}

function studioDisplayDate() {
    const ms = studio.photos.map(p => p.dateMs).find(v => v > 0);
    return ms ? new Date(ms) : new Date();
}

function studioDefaultCaption() {
    const d = studioDisplayDate();
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

// Suggested captions: date, place name(s), D+N (when 사귄 날 is set).
function studioCaptionSuggestions() {
    if (studio.photos.length === 0) return [];
    const ai = studioAiResult && studioAiResult.key === studioAiKey() ? studioAiResult.captions : [];
    const out = [...ai, studioDefaultCaption()];
    const names = [...new Set(studio.photos.map(p => p.placeName).filter(Boolean))];
    if (names.length) out.push(names.slice(0, 2).join(" · ") + (names.length > 2 ? " 외" : ""));
    const n = coupleDayNumber(startOfLocalDay(studioDisplayDate()));
    if (n > 0) out.push(`${partnerAName} ♥ ${partnerBName} D+${n}`);
    if (names.length) out.push(`${studioDefaultCaption()} · ${names[0]}`);
    return [...new Set(out)];
}

// ── Editor UI ────────────────────────────────────────────────────────────────────────────────────
// The preview keeps the photos/filter/frame part in an offscreen canvas and only redraws it when
// something underneath changed (baseChanged), so dragging a sticker just recomposes the overlays
// instead of re-running the pixel filter on every frame.
// Renders run one at a time: a slider dragged live asks for many, and a slow base render finishing
// after a newer one would otherwise paint stale settings. A request that arrives mid-render just
// marks "again", and one more pass runs when the current one ends (baseDirty carries what changed).
let studioBaseCanvas = null;
let studioRendering = false, studioRenderAgain = false;
function studioQueueRender(baseChanged = true) {
    if (baseChanged) studio.baseDirty = true;
    if (studio.renderQueued) return;
    if (studioRendering) { studioRenderAgain = true; return; }
    studio.renderQueued = true;
    requestAnimationFrame(async () => {
        studio.renderQueued = false;
        const canvas = document.getElementById("studio-preview");
        if (!canvas || studio.photos.length === 0) return;
        studioRendering = true;
        try {
            if (studio.baseDirty || !studioBaseCanvas) {
                studio.baseDirty = false;
                const base = document.createElement("canvas");
                await studioRenderBase(base, STUDIO_PREVIEW_LONG_SIDE);
                studioBaseCanvas = base;
            }
            if (canvas.width !== studioBaseCanvas.width || canvas.height !== studioBaseCanvas.height) {
                canvas.width = studioBaseCanvas.width;
                canvas.height = studioBaseCanvas.height;
            }
            const ctx = canvas.getContext("2d");
            ctx.drawImage(studioBaseCanvas, 0, 0);
            const rect = canvas.getBoundingClientRect();
            studioDrawItems(ctx, canvas.width, canvas.height, {
                selectedId: studio.selectedId,
                uiScale: rect.width ? canvas.width / rect.width : 1
            });
        } catch (e) { console.error("[Studio] preview failed:", e); }
        finally {
            studioRendering = false;
            if (studioRenderAgain) { studioRenderAgain = false; studioQueueRender(false); }
        }
    });
}

// The preview stays pinned at the top of the editor (CSS position: sticky) so sliders further down
// show their effect live; once scrolled, it shrinks so the controls still have room.
let studioStickyAttached = false;
function studioAttachStickyPreview() {
    const body = document.querySelector("#modal-photo-studio .studio-body");
    const wrap = document.getElementById("studio-preview-wrap");
    if (!body || !wrap) return;
    body.scrollTop = 0;
    wrap.classList.remove("is-compact");
    if (studioStickyAttached) return;
    studioStickyAttached = true;
    body.addEventListener("scroll", () => {
        wrap.classList.toggle("is-compact", body.scrollTop > 60);
    }, { passive: true });
}

function studioRenderControls() {
    const strip = document.getElementById("studio-selected");
    if (strip) {
        strip.innerHTML = studio.photos.map((ph, i) => `
            <div class="studio-thumb">
                <img src="${ph.src}" alt="">
                <span class="studio-thumb-no">${i + 1}</span>
                <button type="button" class="studio-thumb-remove" onclick="studioRemovePhoto(${i})" title="빼기">×</button>
            </div>`).join("") +
            (studio.photos.length < STUDIO_MAX_PHOTOS
                ? `<button type="button" class="studio-add-btn" onclick="openStudioPicker()">＋<span>사진 고르기</span></button>` : "");
    }
    const layouts = studioLayoutsFor(studio.photos.length);
    if (!layouts.some(l => l.id === studio.layoutId)) studio.layoutId = layouts[0] ? layouts[0].id : "single";
    const layoutEl = document.getElementById("studio-layouts");
    if (layoutEl) {
        layoutEl.innerHTML = layouts.map(l => `<button type="button" class="studio-chip${l.id === studio.layoutId ? " active" : ""}" onclick="studioSet('layoutId', ${jsArg(l.id)})">${escapeHtml(l.name)}</button>`).join("");
    }
    const filterEl = document.getElementById("studio-filters");
    if (filterEl) {
        filterEl.innerHTML = STUDIO_FILTERS.map(f => `<button type="button" class="studio-chip${f.id === studio.filterId ? " active" : ""}" onclick="studioSet('filterId', ${jsArg(f.id)})">${escapeHtml(f.name)}</button>`).join("");
    }
    const bgEl = document.getElementById("studio-backgrounds");
    if (bgEl) {
        bgEl.innerHTML = STUDIO_BACKGROUNDS.map(b => {
            const img = studioSwatchImage(b);
            const style = `background-color:${b.color};${img ? `background-image:url(${img});background-size:cover;` : ""}`;
            return `<button type="button" class="studio-swatch${b.id === studio.bg ? " active" : ""}" style="${style}" onclick="studioSet('bg', ${jsArg(b.id)})" title="${b.label}" aria-label="배경 ${b.label}"></button>`;
        }).join("");
    }
    document.querySelectorAll("#studio-frames .studio-chip").forEach(btn => btn.classList.toggle("active", btn.dataset.frame === studio.frame));
    document.getElementById("studio-logo-chip")?.classList.toggle("active", studio.logo);
    studioRenderStickerTray();
    studioRenderAiThemes();
    studioRenderBgControls();
    const videoHint = document.getElementById("studio-video-hint");
    if (videoHint) videoHint.textContent = studio.photos.length >= 2
        ? `사진 ${studio.photos.length}장이 차례로 넘어가고 완성된 사진으로 끝나요 (보통 약 ${Math.round(studioVideoSeconds(studio.photos.length))}초 · 카톡 프사용은 6초, 배경용은 15초 이내)`
        : "사진을 2장 이상 고르면 만들 수 있어요";
    studioRenderItemPanel();
    const sugEl = document.getElementById("studio-caption-suggestions");
    if (sugEl) {
        sugEl.innerHTML = studioCaptionSuggestions().map(s => `<button type="button" class="studio-chip small" onclick="studioUseCaption(${jsArg(s)})">${escapeHtml(s)}</button>`).join("");
    }
    const cap = document.getElementById("studio-caption");
    if (cap && cap.value !== studio.caption) cap.value = studio.caption;
    ["brightness", "contrast", "saturation"].forEach(k => {
        const el = document.getElementById(`studio-adj-${k}`);
        if (el) el.value = studio.adjust[k];
    });
    const artEl = document.getElementById("studio-arts");
    if (artEl) artEl.innerHTML = STUDIO_ARTS.map(a => `<button type="button" class="studio-chip${a.id === studio.art ? " active" : ""}" onclick="studioSetArt(${jsArg(a.id)})">${escapeHtml(a.name)}</button>`).join("");
    const smoothEl = document.getElementById("studio-smooth");
    if (smoothEl) smoothEl.value = studio.smooth;
    ["jaw", "eye"].forEach(k => { const el = document.getElementById(`studio-reshape-${k}`); if (el) el.value = studio.reshape[k]; });
    const gapEl = document.getElementById("studio-gap");
    if (gapEl) gapEl.value = studio.gap;
    const roundEl = document.getElementById("studio-rounded");
    if (roundEl) roundEl.checked = studio.rounded;
    const empty = studio.photos.length === 0;
    document.getElementById("studio-preview-wrap")?.classList.toggle("hidden", empty);
    document.getElementById("studio-empty")?.classList.toggle("hidden", !empty);
    document.querySelectorAll(".studio-needs-photo").forEach(el => { el.disabled = empty || studio.busy; });
    studioQueueRender();
}

window.studioSet = function(key, value) {
    // 네컷 looks most like a photo-booth strip with the logo line, so turning it on switches the logo on.
    if (key === "layoutId" && value === "4-strip" && studio.layoutId !== "4-strip") studio.logo = true;
    studio[key] = value;
    studioRenderControls();
};
window.studioToggleLogo = function() { studio.logo = !studio.logo; studioRenderControls(); };
window.studioSetAdjust = function(key, value) {
    studio.adjust[key] = Number(value) || 0;
    studioQueueRender();
};
window.studioSetGap = function(value) { studio.gap = Number(value) || 0; studioQueueRender(); };
window.studioSetRounded = function(checked) { studio.rounded = !!checked; studioQueueRender(); };
window.studioSetCaption = function(value) { studio.caption = String(value || "").slice(0, 60); studioQueueRender(); };
window.studioUseCaption = function(text) { studio.caption = text; studioRenderControls(); };
window.studioRemovePhoto = function(i) { studio.photos.splice(i, 1); studioRenderControls(); };
window.studioResetAdjust = function() { studio.adjust = { brightness: 0, contrast: 0, saturation: 0 }; studioRenderControls(); };

// Opens the editor; `photos` preselects ({ src, placeId, placeName, dateMs }).
window.openPhotoStudio = function(photos = []) {
    Object.assign(studio, {
        photos: photos.slice(0, STUDIO_MAX_PHOTOS), layoutId: "single", filterId: "none",
        adjust: { brightness: 0, contrast: 0, saturation: 0 }, gap: 12, rounded: false,
        bg: "white", frame: "none", caption: "", logo: false, art: "none", smooth: 0, reshape: { jaw: 0, eye: 0 }, bgSwap: { mode: "none", fill: "pink", outline: false }, items: [], selectedId: null, busy: false
    });
    studioBaseCanvas = null;
    studioAiSetStatus("");
    studioBgStatus("");
    studioLoadTextFonts();
    studioAttachGestures();
    studioAttachStickyPreview();
    document.getElementById("modal-photo-studio")?.classList.add("active");
    studioRenderControls();
    setTimeout(() => lucide.createIcons(), 50);
    if (studio.photos.length === 0) openStudioPicker();
};

window.closePhotoStudio = function() {
    document.getElementById("modal-photo-studio")?.classList.remove("active");
    studioImageCache.clear();
    studioReshapeCache.clear();
};

// From the gallery lightbox: start with the photo being viewed.
window.openStudioFromSlider = async function() {
    const src = activeGalleryPhotos[activePhotoIndex];
    if (!src) return;
    const place = typeof activePlaceInfo.id === "number" ? await db.places.get(activePlaceInfo.id) : null;
    closeGallerySliderModal();
    openPhotoStudio([{ src, placeId: activePlaceInfo.id, placeName: activePlaceInfo.name, dateMs: place ? parseAnyDate(place.createdAt || place.date) : 0 }]);
};

async function studioExportCanvas() {
    const canvas = document.createElement("canvas");
    await studioRenderBase(canvas, STUDIO_EXPORT_LONG_SIDE);
    await studioWaitForItemFonts();
    studioDrawItems(canvas.getContext("2d"), canvas.width, canvas.height, null);
    return canvas;
}

function studioCanvasToBlob(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("이미지 변환 실패")), "image/jpeg", 0.88));
}

function studioFileName() {
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `AURA_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
}

// Share sheet when the browser can share files (iPhone/Android → 사진 앱에 저장, 카톡 등), else download.
// iPhone only opens the share sheet right after a tap, so call this straight from a button handler
// (the slideshow video waits for its own "폰에 저장" tap for that reason).
async function studioShareOrDownload(blob, fileName) {
    try {
        const file = new File([blob], fileName, { type: blob.type || "image/jpeg" });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file] });
            return;
        }
    } catch (e) {
        if (e && e.name === "AbortError") return; // the person closed the share sheet
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function studioWithBusy(label, fn) {
    if (studio.busy) return;
    studio.busy = true;
    studioRenderControls();
    showToast(label, "info");
    try { await fn(); }
    catch (e) { console.error("[Studio]", e); showToast("사진을 만들지 못했어요: " + (e && e.message ? e.message : e), "danger"); }
    finally { studio.busy = false; studioRenderControls(); }
}

window.studioSaveToPhone = function() {
    if (!studio.photos.length) return;
    studioWithBusy("사진을 만드는 중이에요... ✨", async () => {
        const blob = await studioCanvasToBlob(await studioExportCanvas());
        await studioShareOrDownload(blob, studioFileName());
    });
};

window.studioSaveToAlbum = function() {
    if (!studio.photos.length) return;
    studioWithBusy("꾸민 사진에 저장하는 중... ☁️", async () => {
        const canvas = await studioExportCanvas();
        const row = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            room: syncRoomId,
            img: canvas.toDataURL("image/jpeg", 0.88),
            kind: studio.photos.length > 1 ? "collage" : "filter",
            createdAt: Date.now(),
            caption: studio.caption.trim(),
            sources: studio.photos.map(p => ({ placeName: p.placeName || "", dateMs: p.dateMs || 0 })),
            uploaded: false
        };
        await db.creations.put(row);
        const ok = await uploadCreation(row);
        await renderCreationsSection();
        showToast(ok ? "꾸민 사진에 저장했어요! 두 사람 모두 갤러리에서 볼 수 있어요 💖"
                     : "이 기기에 저장했어요. 인터넷이 연결되면 자동으로 올라가요 ☁️", ok ? "success" : "warning");
        closePhotoStudio();
        if (currentActiveTab !== "gallery") switchTab("gallery");
    });
};

// ── Stickers & text laid over the picture ────────────────────────────────────────────────────────
// Each item: { id, type: "sticker" | "text", x, y (centre, as fractions of the canvas W / H), s (size,
// as a fraction of studioRefSize — √(W·H), so a tall 네컷 strip doesn't shrink stickers to its narrow width), rot (radians), emoji | text, font, color, style }.
// Fractions keep the 720px preview and the 2048px export identical, and items stay put when the
// layout or frame changes the canvas size. They're baked into the saved JPEG; nothing about them is
// stored separately.
const STUDIO_MAX_ITEMS = 30;
function studioRefSize(W, H) { return Math.sqrt(W * H); }
const STUDIO_EMOJI_FONT = `"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;

const STUDIO_STICKER_SETS = [
    { id: "love", name: "💖 하트", items: ["❤️", "🩷", "💕", "💖", "💗", "💘", "💝", "💞", "💓", "💌", "😍", "🥰", "😘", "💋", "🫶", "💑"] },
    { id: "sparkle", name: "✨ 반짝", items: ["✨", "⭐", "🌟", "💫", "🎀", "🌸", "🌷", "🌹", "🌼", "🦋", "🍀", "🌈", "☁️", "🌙", "☀️", "❄️"] },
    { id: "face", name: "😆 표정", items: ["😆", "🤭", "😎", "🥳", "🤪", "😳", "🥺", "😚", "😋", "🙈", "😴", "🤩", "😇", "🫠", "😤", "👍"] },
    { id: "animal", name: "🐰 동물", items: ["🐶", "🐱", "🐰", "🐻", "🐼", "🐥", "🦊", "🐹", "🐨", "🐯", "🐧", "🐳", "🦄", "🐾", "🐣", "🐸"] },
    { id: "date", name: "🍰 데이트", items: ["img:soju", "🍻", "🍺", "🍷", "🥂", "🍶", "🍰", "🎂", "🍓", "🍒", "🧋", "☕", "🍿", "🍦", "🍕", "🍣",
        "🎡", "🎈", "🎁", "📸", "🎵", "🎬", "🎤", "🚗"] },
    { id: "bubble", name: "💬 말풍선", bubbles: true }
];

// Drawn stickers for things Unicode has no emoji for (v453: soju — made with Qwen-Image, see
// design/stickers/). An item's `emoji` is "img:<key>"; the picture is drawn in the emoji's square box.
const STUDIO_IMAGE_STICKERS = { soju: "images/stickers/soju.webp" };
const studioStickerImages = new Map();
function studioStickerImage(key) {
    if (!studioStickerImages.has(key)) {
        const img = new Image();
        img.onload = () => studioQueueRender(false);
        img.src = STUDIO_IMAGE_STICKERS[key] || "";
        studioStickerImages.set(key, img);
    }
    return studioStickerImages.get(key);
}
function studioStickerLabel(em) {
    if (!String(em).startsWith("img:")) return em;
    const key = em.slice(4);
    return `<img src="${escapeHtml(STUDIO_IMAGE_STICKERS[key] || "")}" alt="${escapeHtml(key)}" draggable="false">`;
}

const STUDIO_BUBBLES = [
    { text: "사랑해 ♥", style: "bubble", color: "#FF6584" },
    { text: "LOVE", style: "tag", color: "#E11D48" },
    { text: "최고야!", style: "bubble", color: "#FFC93C" },
    { text: "행복해", style: "tag", color: "#8B5CF6" },
    { text: "보고싶어", style: "bubble", color: "#FFFFFF" },
    { text: "오늘도 ♥", style: "tag", color: "#FFFFFF" },
    { text: "귀여워", style: "bubble", color: "#34C3A0" },
    { text: "맛있다!", style: "bubble", color: "#FF8A3D" },
    { text: "HAPPY DAY", style: "outline", color: "#FF6584" },
    { text: "♥ ♥ ♥", style: "outline", color: "#E11D48" },
    { dday: true, style: "tag", color: "#FF6584" }
];

// Web fonts for text items. The stylesheet is only added when the studio opens, so people who never
// use it don't download Korean font files. `scale` evens out fonts that draw small at the same px size.
const STUDIO_TEXT_FONTS = [
    { id: "basic", name: "기본", family: STUDIO_FONT, weight: 800 },
    { id: "gaegu", name: "손글씨", family: `"Gaegu"`, weight: 700, scale: 1.1 },
    { id: "pen", name: "펜글씨", family: `"Nanum Pen Script"`, weight: 400, scale: 1.3 },
    { id: "jua", name: "동글동글", family: `"Jua"`, weight: 400 },
    { id: "dohyeon", name: "굵게", family: `"Do Hyeon"`, weight: 400 },
    { id: "gowun", name: "단정하게", family: `"Gowun Dodum"`, weight: 400 }
];
const STUDIO_TEXT_FONTS_CSS = "https://fonts.googleapis.com/css2?family=Gaegu:wght@700&family=Nanum+Pen+Script&family=Jua&family=Do+Hyeon&family=Gowun+Dodum&display=swap";
const STUDIO_TEXT_COLORS = ["#FFFFFF", "#1E1B1F", "#FF6584", "#E11D48", "#FFC93C", "#FF8A3D", "#8B5CF6", "#34C3A0", "#4A90E2"];
const STUDIO_TEXT_STYLES = [
    { id: "plain", name: "기본" },
    { id: "outline", name: "테두리" },
    { id: "tag", name: "배경" },
    { id: "bubble", name: "말풍선" }
];

let studioStickerSet = "love";
let studioItemSeq = 0;

function studioTextFont(id) { return STUDIO_TEXT_FONTS.find(f => f.id === id) || STUDIO_TEXT_FONTS[0]; }
function studioSelectedItem() { return studio.items.find(it => it.id === studio.selectedId) || null; }
function studioIsLight(hex) {
    const n = parseInt(String(hex).slice(1), 16);
    if (!Number.isFinite(n)) return true;
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.62;
}
const studioClamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// Normalise to (-π, π] and snap to straight within ~4°, so a sticker is easy to put back level.
function studioSnapAngle(r) {
    const n = ((r + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    return Math.abs(n) < 0.07 ? 0 : n;
}

// ── Fonts ──
let studioFontsCssPromise = null;
function studioLoadTextFonts() {
    if (studioFontsCssPromise) return studioFontsCssPromise;
    studioFontsCssPromise = new Promise(resolve => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = STUDIO_TEXT_FONTS_CSS;
        link.onload = () => resolve(true);
        link.onerror = () => { studioFontsCssPromise = null; resolve(false); };
        document.head.appendChild(link);
        setTimeout(() => resolve(false), 8000);
    });
    return studioFontsCssPromise;
}

// Canvas text only uses a web font once it's loaded, and Google serves Korean fonts in slices per
// character range, so load what THIS text needs, then redraw.
const studioFontLoads = new Map();
function studioEnsureItemFont(it) {
    const f = studioTextFont(it.font);
    if (f.id === "basic" || !document.fonts || !document.fonts.load) return null;
    const key = `${f.id}|${it.text}`;
    if (!studioFontLoads.has(key)) {
        if (studioFontLoads.size > 200) studioFontLoads.clear();
        studioFontLoads.set(key, studioLoadTextFonts()
            .then(ok => ok ? document.fonts.load(`${f.weight} 48px ${f.family}`, it.text || "가") : null)
            .catch(() => null)
            .then(() => studioQueueRender(false)));
    }
    return studioFontLoads.get(key);
}

async function studioWaitForItemFonts() {
    const loads = studio.items.filter(it => it.type === "text").map(studioEnsureItemFont).filter(Boolean);
    // Picture stickers too, so an export right after adding one never leaves it out.
    studio.items.filter(it => it.type === "sticker" && String(it.emoji).startsWith("img:")).forEach(it => {
        const img = studioStickerImage(it.emoji.slice(4));
        if (!img.complete) loads.push(new Promise(r => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); }));
    });
    if (!loads.length) return;
    await Promise.race([Promise.all(loads), new Promise(r => setTimeout(r, 5000))]);
}

// ── Drawing ──
function studioItemBox(ctx, it, M) {
    const size = it.s * M;
    if (it.type === "sticker") return { w: size * 1.15, h: size * 1.15, size };
    const f = studioTextFont(it.font);
    const fs = size * (f.scale || 1);
    const font = `${f.weight} ${fs}px ${f.family}, ${STUDIO_FONT}`;
    ctx.font = font;
    const lines = String(it.text || " ").split("\n");
    const lw = Math.max(...lines.map(l => ctx.measureText(l || " ").width));
    const lh = fs * 1.22;
    const boxed = it.style === "bubble" || it.style === "tag";
    const padX = boxed ? fs * 0.6 : fs * 0.2;
    const padY = boxed ? fs * 0.36 : fs * 0.12;
    return { w: lw + padX * 2, h: lines.length * lh + padY * 2, size: fs, lines, lh, font };
}

function studioDrawItem(ctx, it, W, H) {
    const M = studioRefSize(W, H);
    const box = studioItemBox(ctx, it, M);
    it._w = box.w / M;
    it._h = box.h / M;
    ctx.save();
    ctx.translate(it.x * W, it.y * H);
    ctx.rotate(it.rot || 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (it.type === "sticker") {
        if (String(it.emoji).startsWith("img:")) {
            const img = studioStickerImage(it.emoji.slice(4));
            if (img.complete && img.naturalWidth) {
                const k = box.size * 1.1 / Math.max(img.naturalWidth, img.naturalHeight);
                const w = img.naturalWidth * k, h = img.naturalHeight * k;
                ctx.drawImage(img, -w / 2, -h / 2, w, h);
            }
        } else {
            ctx.font = `${box.size}px ${STUDIO_EMOJI_FONT}`;
            ctx.fillText(it.emoji, 0, box.size * 0.06);
        }
        ctx.restore();
        return;
    }
    const fs = box.size;
    const light = studioIsLight(it.color);
    let textColor = it.color;
    if (it.style === "tag" || it.style === "bubble") {
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.18)";
        ctx.shadowBlur = fs * 0.3;
        ctx.shadowOffsetY = fs * 0.08;
        ctx.fillStyle = it.color;
        studioRoundRectPath(ctx, -box.w / 2, -box.h / 2, box.w, box.h, it.style === "tag" ? Math.min(box.h / 2, fs * 0.9) : fs * 0.55);
        ctx.fill();
        if (it.style === "bubble") {
            ctx.beginPath();
            ctx.moveTo(-box.w * 0.22, box.h / 2 - 1);
            ctx.lineTo(-box.w * 0.3, box.h / 2 + fs * 0.6);
            ctx.lineTo(-box.w * 0.04, box.h / 2 - 1);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
        textColor = light ? "#3A2230" : "#FFFFFF";
    }
    ctx.font = box.font;
    const y0 = -((box.lines.length - 1) * box.lh) / 2;
    if (it.style === "outline") {
        ctx.lineJoin = "round";
        ctx.lineWidth = fs * 0.18;
        ctx.strokeStyle = light ? "#3A2230" : "#FFFFFF";
        box.lines.forEach((l, i) => ctx.strokeText(l, 0, y0 + i * box.lh));
    } else if (it.style === "plain") {
        ctx.shadowColor = "rgba(0,0,0,0.35)";
        ctx.shadowBlur = fs * 0.18;
        ctx.shadowOffsetY = fs * 0.04;
    }
    ctx.fillStyle = textColor;
    box.lines.forEach((l, i) => ctx.fillText(l, 0, y0 + i * box.lh));
    ctx.restore();
}

// Where the selected item's two corner buttons sit, in canvas px (k = canvas px per CSS px).
function studioHandlePoints(it, W, H, k) {
    const M = studioRefSize(W, H);
    const pad = 6 * k;
    const hw = (it._w || 0.1) * M / 2 + pad, hh = (it._h || 0.1) * M / 2 + pad;
    const cx = it.x * W, cy = it.y * H;
    const cos = Math.cos(it.rot || 0), sin = Math.sin(it.rot || 0);
    const at = (lx, ly) => ({ x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos });
    return { cx, cy, hw, hh, r: 13 * k, del: at(hw, -hh), rs: at(hw, hh) };
}

// opts null = export (no selection UI); otherwise { selectedId, uiScale }.
function studioDrawItems(ctx, W, H, opts) {
    for (const it of studio.items) {
        if (it.type === "text" && opts) studioEnsureItemFont(it);
        studioDrawItem(ctx, it, W, H);
    }
    const sel = opts && studio.items.find(it => it.id === opts.selectedId);
    if (!sel) return;
    const k = opts.uiScale || 1;
    const hp = studioHandlePoints(sel, W, H, k);
    ctx.save();
    ctx.translate(hp.cx, hp.cy);
    ctx.rotate(sel.rot || 0);
    ctx.lineWidth = 2 * k;
    ctx.setLineDash([6 * k, 4 * k]);
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.strokeRect(-hp.hw, -hp.hh, hp.hw * 2, hp.hh * 2);
    ctx.lineDashOffset = 5 * k;
    ctx.strokeStyle = "#FF6584";
    ctx.strokeRect(-hp.hw, -hp.hh, hp.hw * 2, hp.hh * 2);
    ctx.restore();
    const button = (pt, color, glyph) => {
        ctx.save();
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, hp.r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.shadowColor = "rgba(0,0,0,0.25)";
        ctx.shadowBlur = 4 * k;
        ctx.fill();
        ctx.shadowColor = "transparent";
        ctx.fillStyle = "#fff";
        ctx.font = `700 ${Math.round(hp.r * 1.25)}px ${STUDIO_FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(glyph, pt.x, pt.y + k);
        ctx.restore();
    };
    button(hp.del, "#E11D48", "×");
    button(hp.rs, "#FF6584", "⤡");
}

// ── Touch / mouse editing on the preview ──
function studioCanvasPoint(canvas, e) {
    const r = canvas.getBoundingClientRect();
    const k = canvas.width / (r.width || 1);
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * (canvas.height / (r.height || 1)), k };
}

function studioHitItem(p, W, H) {
    const M = studioRefSize(W, H);
    for (let i = studio.items.length - 1; i >= 0; i--) {
        const it = studio.items[i];
        const dx = p.x - it.x * W, dy = p.y - it.y * H;
        const cos = Math.cos(-(it.rot || 0)), sin = Math.sin(-(it.rot || 0));
        const lx = dx * cos - dy * sin, ly = dx * sin + dy * cos;
        const tol = 8 * p.k;
        if (Math.abs(lx) <= (it._w || 0) * M / 2 + tol && Math.abs(ly) <= (it._h || 0) * M / 2 + tol) return it;
    }
    return null;
}

const studioPointers = new Map();
let studioGesture = null;
let studioGesturesAttached = false;

function studioSizeLimits(it) { return it.type === "sticker" ? [0.04, 1] : [0.02, 0.4]; }

function studioStartPinch(sel) {
    const [a, b] = [...studioPointers.values()];
    studioGesture = {
        mode: "pinch", sel,
        d0: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), a0: Math.atan2(b.y - a.y, b.x - a.x),
        m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, s0: sel.s, rot0: sel.rot || 0, x0: sel.x, y0: sel.y
    };
}

function studioAttachGestures() {
    const canvas = document.getElementById("studio-preview");
    if (!canvas || studioGesturesAttached) return;
    studioGesturesAttached = true;

    canvas.addEventListener("pointerdown", e => {
        if (!studio.items.length) return; // nothing to grab: leave the touch to page scrolling
        e.preventDefault();
        try { canvas.setPointerCapture(e.pointerId); } catch (_) { }
        const p = studioCanvasPoint(canvas, e);
        studioPointers.set(e.pointerId, p);
        const W = canvas.width, H = canvas.height;
        const sel = studioSelectedItem();
        if (studioPointers.size === 2) {
            if (sel) studioStartPinch(sel);
            return;
        }
        if (studioPointers.size > 2) return;
        if (sel) {
            const hp = studioHandlePoints(sel, W, H, p.k);
            if (Math.hypot(p.x - hp.del.x, p.y - hp.del.y) <= hp.r * 1.5) {
                studioGesture = null;
                studioDeleteItem(sel.id);
                return;
            }
            if (Math.hypot(p.x - hp.rs.x, p.y - hp.rs.y) <= hp.r * 1.5) {
                studioGesture = {
                    mode: "handle", sel, cx: hp.cx, cy: hp.cy,
                    d0: Math.max(1, Math.hypot(p.x - hp.cx, p.y - hp.cy)), a0: Math.atan2(p.y - hp.cy, p.x - hp.cx),
                    s0: sel.s, rot0: sel.rot || 0
                };
                return;
            }
        }
        const hit = studioHitItem(p, W, H);
        if (hit) {
            const changed = studio.selectedId !== hit.id;
            studio.selectedId = hit.id;
            studio.items.splice(studio.items.indexOf(hit), 1);
            studio.items.push(hit); // touching an item brings it to the front
            studioGesture = { mode: "drag", sel: hit, dx: hit.x * W - p.x, dy: hit.y * H - p.y };
            if (changed) studioRenderItemPanel();
        } else {
            studioGesture = null;
            if (studio.selectedId) { studio.selectedId = null; studioRenderItemPanel(); }
        }
        studioQueueRender(false);
    });

    canvas.addEventListener("pointermove", e => {
        if (!studioPointers.has(e.pointerId)) return;
        e.preventDefault();
        const p = studioCanvasPoint(canvas, e);
        studioPointers.set(e.pointerId, p);
        const g = studioGesture;
        if (!g || !studio.items.includes(g.sel)) return;
        const W = canvas.width, H = canvas.height, it = g.sel;
        const [lo, hi] = studioSizeLimits(it);
        if (g.mode === "drag") {
            it.x = studioClamp((p.x + g.dx) / W, 0, 1);
            it.y = studioClamp((p.y + g.dy) / H, 0, 1);
        } else if (g.mode === "handle") {
            const d = Math.hypot(p.x - g.cx, p.y - g.cy);
            it.s = studioClamp(g.s0 * d / g.d0, lo, hi);
            it.rot = studioSnapAngle(g.rot0 + Math.atan2(p.y - g.cy, p.x - g.cx) - g.a0);
        } else if (g.mode === "pinch" && studioPointers.size >= 2) {
            const [a, b] = [...studioPointers.values()];
            it.s = studioClamp(g.s0 * Math.hypot(b.x - a.x, b.y - a.y) / g.d0, lo, hi);
            it.rot = studioSnapAngle(g.rot0 + Math.atan2(b.y - a.y, b.x - a.x) - g.a0);
            it.x = studioClamp(g.x0 + ((a.x + b.x) / 2 - g.m0.x) / W, 0, 1);
            it.y = studioClamp(g.y0 + ((a.y + b.y) / 2 - g.m0.y) / H, 0, 1);
        }
        studioQueueRender(false);
    });

    const end = e => {
        if (!studioPointers.delete(e.pointerId)) return;
        if (studioPointers.size === 0) { studioGesture = null; return; }
        // Lifting one finger of a pinch carries on as a drag with the finger still down.
        const g = studioGesture;
        if (g && g.mode === "pinch" && studio.items.includes(g.sel)) {
            const p = [...studioPointers.values()][0];
            studioGesture = { mode: "drag", sel: g.sel, dx: g.sel.x * canvas.width - p.x, dy: g.sel.y * canvas.height - p.y };
        }
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
}

// ── Adding / editing items ──
function studioAddItem(item) {
    if (studio.items.length >= STUDIO_MAX_ITEMS) {
        showToast(`스티커·글씨는 ${STUDIO_MAX_ITEMS}개까지 넣을 수 있어요`, "warning");
        return null;
    }
    // Fan new items out a little so several taps don't stack exactly on top of each other.
    const n = studio.items.length % 6;
    const it = Object.assign({
        id: `it${++studioItemSeq}`, x: 0.5 + ((n % 3) - 1) * 0.12, y: 0.42 + Math.floor(n / 3) * 0.14, rot: 0
    }, item);
    studio.items.push(it);
    studio.selectedId = it.id;
    studioRenderItemPanel();
    studioQueueRender(false);
    return it;
}

window.studioAddSticker = function(emoji) {
    studioAddItem({ type: "sticker", emoji, s: 0.15 });
};

window.studioAddBubble = function(i) {
    const b = STUDIO_BUBBLES[i];
    if (!b) return;
    let text = b.text;
    if (b.dday) {
        const n = coupleDayNumber(startOfLocalDay(studioDisplayDate()));
        text = n > 0 ? `D+${n} ♥` : "♥ 우리 ♥";
    }
    studioAddItem({ type: "text", text, font: "jua", color: b.color, style: b.style, s: 0.05 });
};

window.studioAddText = function() {
    const it = studioAddItem({ type: "text", text: "우리의 하루", font: "gaegu", color: "#FFFFFF", style: "outline", s: 0.06 });
    if (!it) return;
    setTimeout(() => {
        const el = document.getElementById("studio-item-text");
        if (el) { el.focus(); el.select(); }
    }, 30);
};

function studioDeleteItem(id) {
    studio.items = studio.items.filter(it => it.id !== id);
    if (studio.selectedId === id) studio.selectedId = null;
    studioRenderItemPanel();
    studioQueueRender(false);
}
window.studioDeleteSelected = function() { if (studio.selectedId) studioDeleteItem(studio.selectedId); };
window.studioDeselect = function() { studio.selectedId = null; studioRenderItemPanel(); studioQueueRender(false); };
window.studioDuplicateSelected = function() {
    const sel = studioSelectedItem();
    if (!sel) return;
    const { _w, _h, id, ...rest } = sel;
    studioAddItem(Object.assign(rest, { x: studioClamp(sel.x + 0.06, 0, 1), y: studioClamp(sel.y + 0.06, 0, 1) }));
};
window.studioSetItemProp = function(key, value) {
    const sel = studioSelectedItem();
    if (!sel) return;
    sel[key] = value;
    studioRenderItemPanel();
    studioQueueRender(false);
};
window.studioSetItemText = function(value) {
    const sel = studioSelectedItem();
    if (!sel) return;
    sel.text = String(value || "").split("\n").slice(0, 4).join("\n").slice(0, 60);
    studioQueueRender(false);
};
window.studioSetStickerSet = function(id) { studioStickerSet = id; studioRenderStickerTray(); };

function studioRenderStickerTray() {
    const tabs = document.getElementById("studio-sticker-tabs");
    const grid = document.getElementById("studio-sticker-grid");
    if (!tabs || !grid) return;
    tabs.innerHTML = STUDIO_STICKER_SETS.map(s => `<button type="button" class="studio-chip small${s.id === studioStickerSet ? " active" : ""}" onclick="studioSetStickerSet(${jsArg(s.id)})">${escapeHtml(s.name)}</button>`).join("");
    const set = STUDIO_STICKER_SETS.find(s => s.id === studioStickerSet) || STUDIO_STICKER_SETS[0];
    if (set.bubbles) {
        grid.className = "studio-bubble-grid";
        grid.innerHTML = STUDIO_BUBBLES.map((b, i) => {
            const label = b.dday ? "D+N ♥" : b.text;
            const boxed = b.style === "tag" || b.style === "bubble";
            const fg = boxed ? (studioIsLight(b.color) ? "#3A2230" : "#FFFFFF") : b.color;
            const style = boxed ? `background:${b.color};color:${fg};` : `color:${fg};`;
            return `<button type="button" class="studio-bubble-btn is-${b.style}" style="${style}" onclick="studioAddBubble(${i})">${escapeHtml(label)}</button>`;
        }).join("");
    } else {
        grid.className = "studio-sticker-grid";
        grid.innerHTML = set.items.map(em => `<button type="button" class="studio-sticker-btn" onclick="studioAddSticker(${jsArg(em)})">${studioStickerLabel(em)}</button>`).join("");
    }
}

function studioRenderItemPanel() {
    const canvas = document.getElementById("studio-preview");
    if (canvas) canvas.style.touchAction = studio.items.length ? "none" : "";
    const panel = document.getElementById("studio-item-panel");
    if (!panel) return;
    const sel = studioSelectedItem();
    if (!sel) { panel.classList.add("hidden"); panel.innerHTML = ""; return; }
    panel.classList.remove("hidden");
    const head = `
        <div class="studio-item-head">
            <strong>${sel.type === "text" ? "✏️ 글씨" : `${sel.emoji} 스티커`}</strong>
            <div class="studio-item-actions">
                <button type="button" class="studio-chip small" onclick="studioDuplicateSelected()">복제</button>
                <button type="button" class="studio-chip small studio-danger" onclick="studioDeleteSelected()">삭제</button>
                <button type="button" class="studio-chip small active" onclick="studioDeselect()">완료</button>
            </div>
        </div>
        <div class="studio-item-hint">사진 위에서 끌어서 옮기고, ⤡ 버튼이나 두 손가락으로 크기·회전을 바꿔요</div>`;
    if (sel.type !== "text") { panel.innerHTML = head; return; }
    panel.innerHTML = head + `
        <textarea id="studio-item-text" rows="2" maxlength="60" oninput="studioSetItemText(this.value)">${escapeHtml(sel.text)}</textarea>
        <div class="studio-chips">${STUDIO_TEXT_FONTS.map(f => `<button type="button" class="studio-chip small${f.id === sel.font ? " active" : ""}" style="font-family:${escapeHtml(f.family)}, sans-serif" onclick="studioSetItemProp('font', ${jsArg(f.id)})">${escapeHtml(f.name)}</button>`).join("")}</div>
        <div class="studio-swatches studio-swatches-sm">${STUDIO_TEXT_COLORS.map(c => `<button type="button" class="studio-swatch${c === sel.color ? " active" : ""}" style="background:${c}" onclick="studioSetItemProp('color', ${jsArg(c)})" aria-label="글씨 색 ${c}"></button>`).join("")}</div>
        <div class="studio-chips">${STUDIO_TEXT_STYLES.map(s => `<button type="button" class="studio-chip small${s.id === sel.style ? " active" : ""}" onclick="studioSetItemProp('style', ${jsArg(s.id)})">${escapeHtml(s.name)}</button>`).join("")}</div>`;
}

// ── AI 꾸미기: Gemini finds the faces → themed stickers placed on each one, plus caption ideas ──────
// One Gemini call per composition sends the picture (photos + frame, no stickers) at 1024px and gets
// back face boxes ([ymin, xmin, ymax, xmax] on a 0-1000 scale over the whole picture) and a few short
// captions. The answer is cached against the layout geometry, so trying themes one after another
// reuses it. The picture leaves the device (to Google, on the person's own key), so the first use
// asks once (aura_ai_photo_ok).
const STUDIO_AI_THEMES = [
    { id: "crown", name: "👑 왕관" },
    { id: "flower", name: "🌸 꽃 화관" },
    { id: "ribbon", name: "🎀 리본" },
    { id: "glasses", name: "🕶️ 선글라스" },
    { id: "blush", name: "💗 볼하트" },
    { id: "sparkle", name: "✨ 반짝" }
];
let studioAiResult = null;   // { key, faces: [{ x0, y0, x1, y1 } as 0-1 fractions], captions: [] }
let studioAiBusy = false;

function studioAiKey() {
    return JSON.stringify([studio.layoutId, studio.frame, studio.gap, !!studio.caption.trim(), studio.logo,
        studio.photos.map(p => `${p.src.length}:${p.src.slice(-24)}`)]);
}

function studioAiSetStatus(text) {
    const el = document.getElementById("studio-ai-status");
    if (el) el.textContent = text || "";
}

function studioParseJsonLoose(text) {
    const t = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    try { return JSON.parse(t); } catch (_) { }
    const m = t.match(/[\[{][\s\S]*[\]}]/);
    return m ? JSON.parse(m[0]) : null;
}

async function studioAiAnalyze() {
    const key = studioAiKey();
    if (studioAiResult && studioAiResult.key === key) return studioAiResult;
    if (!geminiApiKey) throw new Error("설정 탭에서 Gemini API 키를 먼저 등록해 주세요");
    if (localStorage.getItem("aura_ai_photo_ok") !== "1") {
        if (!confirm("AI 꾸미기는 이 사진을 Google Gemini로 보내서 얼굴 위치를 찾아요.\n(등록한 내 Gemini 키로 보내고, 앱 서버에는 저장되지 않아요)\n\n계속할까요?")) {
            throw Object.assign(new Error("cancelled"), { cancelled: true });
        }
        try { localStorage.setItem("aura_ai_photo_ok", "1"); } catch (_) { }
    }
    const canvas = document.createElement("canvas");
    await studioRenderBase(canvas, 1024);
    const data = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
    const names = [...new Set(studio.photos.map(p => p.placeName).filter(Boolean))].slice(0, 3).join(", ");
    const prompt = `이 사진은 커플(${partnerAName}, ${partnerBName})의 데이트 사진이에요${names ? ` (장소: ${names})` : ""}.
두 가지를 JSON으로 답해 주세요.
1. "faces": 사진 속 모든 사람 얼굴(최대 8개)의 위치. 각 항목은 {"box_2d": [ymin, xmin, ymax, xmax]} 이고, 좌표는 사진 전체를 0~1000으로 본 정수예요. 상자는 이마 위쪽부터 턱 끝까지, 양쪽 볼 바깥까지 얼굴만 감싸게 해 주세요(머리카락·목 제외). 얼굴이 없으면 빈 배열.
2. "captions": 사진 분위기에 어울리는 한국어 짧은 문구 4개(각 14자 이내, 귀엽고 다정한 말투, 이모지 0~1개).
예: {"faces":[{"box_2d":[120,300,420,520]}],"captions":["오늘도 너랑 ♥"]}`;
    const text = await callGeminiRaw(prompt, "", true, [{ inlineData: { mimeType: "image/jpeg", data } }]);
    const json = studioParseJsonLoose(text) || {};
    const faces = (Array.isArray(json.faces) ? json.faces : [])
        .map(f => Array.isArray(f) ? f : f && f.box_2d)
        .filter(b => Array.isArray(b) && b.length === 4 && b.every(v => Number.isFinite(Number(v))))
        .map(b => {
            const [y0, x0, y1, x1] = b.map(v => studioClamp(Number(v) / 1000, 0, 1));
            return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
        })
        .filter(f => f.x1 - f.x0 > 0.01 && f.y1 - f.y0 > 0.01)
        .slice(0, 8);
    const captions = (Array.isArray(json.captions) ? json.captions : [])
        .map(c => String(c || "").trim().slice(0, 24)).filter(Boolean).slice(0, 4);
    studioAiResult = { key, faces, captions };
    return studioAiResult;
}

// Stickers for one face. Sizes and offsets are in face-box units; all come back as canvas fractions.
function studioAiStickersFor(theme, face, W, H) {
    const R = studioRefSize(W, H);
    const fw = (face.x1 - face.x0) * W, fh = (face.y1 - face.y0) * H;
    const cx = (face.x0 + face.x1) / 2 * W, top = face.y0 * H;
    const st = (emoji, x, y, size, rot = 0) => ({
        type: "sticker", emoji, ai: true, rot,
        x: studioClamp(x / W, 0, 1), y: studioClamp(y / H, 0, 1), s: studioClamp(size / R, 0.03, 1)
    });
    switch (theme) {
        case "crown": return [st("👑", cx, top - fh * 0.3, fw * 0.75)];
        case "flower": return [-2, -1, 0, 1, 2].map(i => {
            const t = i / 4;
            return st(["🌸", "🌷", "🌼", "🌷", "🌸"][i + 2], cx + t * fw * 0.95, top - fh * 0.06 + t * t * fh * 0.55, fw * 0.27, t * 0.7);
        });
        case "ribbon": return [st("🎀", cx + fw * 0.36, top - fh * 0.04, fw * 0.45, 0.3)];
        case "glasses": return [st("🕶️", cx, top + fh * 0.42, fw * 0.95)];
        case "blush": return [st("💗", cx - fw * 0.29, top + fh * 0.68, fw * 0.2, -0.2), st("💗", cx + fw * 0.29, top + fh * 0.68, fw * 0.2, 0.2)];
        case "sparkle": return [
            st("✨", cx - fw * 0.65, top + fh * 0.12, fw * 0.32),
            st("✨", cx + fw * 0.62, top + fh * 0.38, fw * 0.25),
            st("✨", cx - fw * 0.52, top + fh * 0.88, fw * 0.2)
        ];
    }
    return [];
}

window.studioAiApplyTheme = async function(theme) {
    if (studioAiBusy || !studio.photos.length) return;
    studioAiBusy = true;
    document.querySelectorAll(".studio-ai-btn").forEach(b => { b.disabled = true; });
    studioAiSetStatus("AI가 얼굴을 찾는 중이에요... 🔍");
    try {
        const res = await studioAiAnalyze();
        studioRenderControls(); // shows any new caption ideas
        if (!res.faces.length) {
            studioAiSetStatus("얼굴을 찾지 못했어요. 얼굴이 크게 나온 사진으로 해보세요 🥲");
            return;
        }
        const canvas = document.getElementById("studio-preview");
        const W = canvas.width, H = canvas.height;
        // Swap the previous AI theme instead of piling a second one on top; hand-placed items stay.
        const kept = studio.items.filter(it => !it.ai);
        const added = res.faces.flatMap(f => studioAiStickersFor(theme, f, W, H)).slice(0, Math.max(0, STUDIO_MAX_ITEMS - kept.length));
        studio.items = kept.concat(added.map(it => Object.assign(it, { id: `it${++studioItemSeq}` })));
        studio.selectedId = null;
        studioRenderItemPanel();
        studioQueueRender(false);
        studioAiSetStatus(`얼굴 ${res.faces.length}개에 붙였어요! 위치는 손으로 고칠 수 있어요 ✨`);
    } catch (e) {
        if (e && e.cancelled) { studioAiSetStatus(""); return; }
        console.error("[Studio AI]", e);
        studioAiSetStatus("AI 꾸미기 실패: " + (e && e.message ? e.message : e));
    } finally {
        studioAiBusy = false;
        document.querySelectorAll(".studio-ai-btn").forEach(b => { b.disabled = false; });
    }
};

window.studioAiRemove = function() {
    studio.items = studio.items.filter(it => !it.ai);
    if (studio.selectedId && !studioSelectedItem()) studio.selectedId = null;
    studioRenderItemPanel();
    studioQueueRender(false);
    studioAiSetStatus("");
};

window.studioAiCaptions = async function() {
    if (studioAiBusy || !studio.photos.length) return;
    studioAiBusy = true;
    document.querySelectorAll(".studio-ai-btn").forEach(b => { b.disabled = true; });
    studioAiSetStatus("AI가 문구를 고르는 중이에요... ✍️");
    try {
        const res = await studioAiAnalyze();
        studioRenderControls();
        studioAiSetStatus(res.captions.length ? "아래 '프레임 · 문구'에 ✨ 추천 문구를 넣어뒀어요" : "추천 문구를 받지 못했어요");
        if (res.captions.length) document.getElementById("studio-caption-suggestions")?.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (e) {
        if (e && e.cancelled) { studioAiSetStatus(""); return; }
        console.error("[Studio AI]", e);
        studioAiSetStatus("AI 문구 추천 실패: " + (e && e.message ? e.message : e));
    } finally {
        studioAiBusy = false;
        document.querySelectorAll(".studio-ai-btn").forEach(b => { b.disabled = false; });
    }
};

function studioRenderAiThemes() {
    const el = document.getElementById("studio-ai-themes");
    if (!el || el.childElementCount) return;
    el.innerHTML = STUDIO_AI_THEMES.map(t => `<button type="button" class="studio-chip small studio-ai-btn" onclick="studioAiApplyTheme(${jsArg(t.id)})">${escapeHtml(t.name)}</button>`).join("") +
        `<button type="button" class="studio-chip small" onclick="studioAiRemove()">AI 스티커 지우기</button>`;
}

// ── 움직이는 사진: a short slideshow video of the chosen photos, ending on the finished collage ─────
// Drawn frame by frame on a visible canvas and recorded with MediaRecorder (iPhone Safari 14.5+ records
// MP4; Chrome/Android WebM or MP4). Safari has had bugs where a canvas stream records blank, so the
// canvas stays on screen while recording and a suspiciously small result is reported as unsupported
// instead of saved. Videos are only offered to the phone (share sheet / download), never uploaded —
// a few MB each would eat the free-tier database quota.
// Modes: normal 4:5 clip; KakaoTalk profile video (square, KakaoTalk allows up to 6s); KakaoTalk
// background video (9:16, up to 15s). Lengths stay a little under those limits because recording
// runs slightly long; photos get less screen time when the length is capped.
const STUDIO_VIDEO_MODES = {
    normal: { w: 720, h: 900, maxTotal: 0, end: 2.4, name: "움직이는 사진" },
    profile: { w: 720, h: 720, maxTotal: 5.7, end: 1.6, name: "카톡 프사 영상" },
    background: { w: 720, h: 1280, maxTotal: 14.5, end: 2.4, name: "카톡 배경 영상" }
};
function studioVideoTiming(mode, n) {
    const m = STUDIO_VIDEO_MODES[mode] || STUDIO_VIDEO_MODES.normal;
    const show = m.maxTotal ? Math.min(1.7, (m.maxTotal - m.end) / n) : 1.7;
    return { ...m, show, fade: Math.min(0.45, show * 0.35), total: n * show + m.end };
}

function studioVideoMime() {
    if (typeof MediaRecorder === "undefined" || !HTMLCanvasElement.prototype.captureStream) return null;
    const types = ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    return types.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch (_) { return false; } }) || null;
}

function studioVideoSeconds(n, mode = "normal") { return studioVideoTiming(mode, n).total; }

let studioVideoState = null; // { blob, url, ext }

function studioVideoOverlay() {
    let ov = document.getElementById("studio-video-overlay");
    if (!ov) {
        ov = document.createElement("div");
        ov.id = "studio-video-overlay";
        ov.className = "studio-video-overlay";
        document.body.appendChild(ov);
    }
    return ov;
}

window.closeStudioVideo = function() {
    const ov = document.getElementById("studio-video-overlay");
    if (ov) ov.remove();
    if (studioVideoState) URL.revokeObjectURL(studioVideoState.url);
    studioVideoState = null;
};

window.studioSaveVideo = function() {
    if (!studioVideoState) return;
    studioShareOrDownload(studioVideoState.blob, studioFileName().replace(/\.jpg$/, "." + studioVideoState.ext));
};

window.studioMakeVideo = async function(mode = "normal") {
    if (studio.busy) return;
    if (studio.photos.length < 2) { showToast("움직이는 사진은 사진 2장 이상부터 만들 수 있어요", "warning"); return; }
    const mime = studioVideoMime();
    if (!mime) { showToast("이 브라우저에서는 영상 만들기를 지원하지 않아요 🥲", "warning"); return; }
    const cfg = studioVideoTiming(mode, studio.photos.length);
    studio.busy = true;
    studioRenderControls();
    const ov = studioVideoOverlay();
    ov.innerHTML = `<div class="studio-video-card"><div class="studio-video-title">🎬 ${cfg.name} 만드는 중...</div>
        <canvas id="studio-video-canvas" width="${cfg.w}" height="${cfg.h}"></canvas>
        <div class="studio-video-sub" id="studio-video-sub">준비하는 중이에요</div></div>`;
    let stream = null;
    try {
        const canvas = document.getElementById("studio-video-canvas");
        const ctx = canvas.getContext("2d");
        const W = cfg.w, H = cfg.h;
        const p = studioFilterParams();
        const images = await studioSourceImages();
        const frames = images.map(img => studioRenderCell(img, W * 1.08, H * 1.08, p));
        const finale = await studioExportCanvas();
        const bg = STUDIO_BACKGROUNDS.find(b => b.id === studio.bg) || STUDIO_BACKGROUNDS[0];
        const n = frames.length, total = cfg.total;

        // Scene k (0..n-1 = photos, n = finished collage); each photo slowly zooms, alternating in/out.
        const drawScene = (k, prog, alpha) => {
            ctx.save();
            ctx.globalAlpha = alpha;
            if (k < n) {
                const e = k % 2 ? prog : 1 - prog;
                const d = 1 + 0.07 * e;
                ctx.drawImage(frames[k], (W - W * d) / 2, (H - H * d) / 2, W * d, H * d);
            } else {
                ctx.fillStyle = bg.color;
                ctx.fillRect(0, 0, W, H);
                const fit = Math.min(W / finale.width, H / finale.height) * (0.94 + 0.04 * Math.min(1, prog));
                const fw = finale.width * fit, fh = finale.height * fit;
                ctx.drawImage(finale, (W - fw) / 2, (H - fh) / 2, fw, fh);
            }
            ctx.restore();
        };
        const draw = t => {
            const k = Math.min(n, Math.floor(t / cfg.show));
            const local = t - k * cfg.show;
            const span = k < n ? cfg.show + cfg.fade : cfg.end;
            drawScene(k, local / span, 1);
            if (k < n && local > cfg.show - cfg.fade) {
                drawScene(k + 1, 0, (local - (cfg.show - cfg.fade)) / cfg.fade);
            }
        };

        draw(0);
        stream = canvas.captureStream(30);
        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5000000 });
        const chunks = [];
        rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        const stopped = new Promise((resolve, reject) => { rec.onstop = resolve; rec.onerror = e => reject(e.error || new Error("녹화 오류")); });
        rec.start(500);
        const sub = document.getElementById("studio-video-sub");
        const t0 = performance.now();
        await new Promise(resolve => {
            const tick = () => {
                const t = (performance.now() - t0) / 1000;
                draw(Math.min(t, total));
                if (sub) sub.textContent = `${Math.min(total, t).toFixed(0)}초 / ${total.toFixed(0)}초 · 화면을 켜 둔 채로 기다려 주세요`;
                if (t >= total) resolve(); else setTimeout(tick, 1000 / 30);
            };
            tick();
        });
        await new Promise(r => setTimeout(r, 150));
        rec.stop();
        await stopped;
        const blob = new Blob(chunks, { type: mime.split(";")[0] });
        // A real recording of ~10s at this size is hundreds of KB at least; a near-empty file means the
        // browser recorded blank frames (the old Safari canvas-capture bug).
        if (blob.size < 30 * 1024) throw new Error("이 기기에서는 영상이 제대로 만들어지지 않았어요");
        const url = URL.createObjectURL(blob);
        studioVideoState = { blob, url, ext: mime.includes("mp4") ? "mp4" : "webm" };
        if (studioVideoState.ext !== "mp4" && mode !== "normal") showToast("이 브라우저는 webm으로 저장돼요. 카톡에서 안 열리면 아이폰 사파리에서 만들어 주세요", "warning");
        ov.innerHTML = `<div class="studio-video-card"><div class="studio-video-title">🎬 ${cfg.name} 완성! (${total.toFixed(1)}초)</div>
            <video src="${url}" autoplay loop muted playsinline></video>
            <div class="studio-video-sub">${(blob.size / 1024 / 1024).toFixed(1)}MB · 폰에만 저장돼요 (꾸민 사진 앨범에는 올라가지 않아요)</div>
            <div class="studio-video-actions">
                <button type="button" class="btn btn-outline" onclick="closeStudioVideo()">닫기</button>
                <button type="button" class="btn btn-primary" onclick="studioSaveVideo()"><i data-lucide="download"></i> 폰에 저장</button>
            </div></div>`;
        if (window.lucide) lucide.createIcons();
    } catch (e) {
        console.error("[Studio video]", e);
        closeStudioVideo();
        showToast("영상을 만들지 못했어요: " + (e && e.message ? e.message : e), "danger");
    } finally {
        if (stream) stream.getTracks().forEach(t => t.stop());
        studio.busy = false;
        studioRenderControls();
    }
};

// ── 카톡 프사 만들기: square profile, couple "반반" split, 9:16 background ─────────────────────────
// Works from the finished picture (studioExportCanvas — stickers included). For the profile and the
// couple split the person drags a crop frame over it (zoom slider for size); the couple frame is 2:1
// and becomes two squares, the left half for one person's profile and the right half for the other's,
// so side by side they make the whole picture. The background version keeps the whole picture and
// fills the tall 9:16 screen with a blurred copy of it. KakaoTalk publishes no pixel spec for personal
// profiles, so this uses 1080px squares and 1080×1920, which it shows well.
// NOTE: never name a global `kakao` here — that is the Kakao Maps SDK's global (window.kakao), and a
// top-level const of the same name shadows it for every script, which broke app.js's Kakao place search.
const KAKAO_MODES = {
    profile: { aspect: 1, hint: "카톡 프사는 정사각형으로 보이고, 친구 목록에서는 동그랗게 잘려요. 얼굴을 가운데 원 안에 맞춰주세요." },
    couple: { aspect: 2, hint: "왼쪽 반은 SH_NAME 프사, 오른쪽 반은 SA_NAME 프사가 돼요. 둘이 나란히 놓이면 한 장의 사진이 돼요 💑" },
    background: { aspect: 0, hint: "카톡 배경(세로 화면)용이에요. 사진 전체가 보이고, 빈 곳은 같은 사진을 흐리게 깔아요." }
};
const kakaoMaker = { mode: "profile", src: null, backdrop: null, cx: 0.5, cy: 0.5, zoom: 0, drag: null };

window.openKakaoMaker = async function() {
    if (!studio.photos.length || studio.busy) return;
    await studioWithBusy("카톡용 사진을 준비하는 중... 💛", async () => {
        kakaoMaker.src = await studioExportCanvas();
        // The blurred backdrop comes from the first photo itself: blurring the finished picture would
        // mostly blur its white frame.
        kakaoMaker.backdrop = await studioLoadImage(studio.photos[0].src).catch(() => kakaoMaker.src);
        kakaoMaker.mode = "profile";
        kakaoAutoFrame();
        document.getElementById("modal-kakao")?.classList.add("active");
        kakaoAttachGestures();
        kakaoRender();
        setTimeout(() => lucide.createIcons(), 30);
    });
};

window.closeKakaoMaker = function() {
    document.getElementById("modal-kakao")?.classList.remove("active");
    kakaoMaker.src = null;
    kakaoMaker.backdrop = null;
};

window.kakaoSetMode = function(mode) {
    kakaoMaker.mode = mode;
    kakaoAutoFrame();
    kakaoRender();
};

window.kakaoSetZoom = function(v) {
    kakaoMaker.zoom = studioClamp(Number(v) / 100, 0, 1);
    kakaoClampCenter();
    kakaoRender();
};

// Largest crop of the mode's aspect that fits, shrunk by the zoom slider (down to 30%).
function kakaoCropRect() {
    const src = kakaoMaker.src, a = KAKAO_MODES[kakaoMaker.mode].aspect;
    let mw, mh;
    if (src.width / src.height > a) { mh = src.height; mw = mh * a; } else { mw = src.width; mh = mw / a; }
    const k = 1 - kakaoMaker.zoom * 0.7;
    const w = mw * k, h = mh * k;
    return { x: kakaoMaker.cx * src.width - w / 2, y: kakaoMaker.cy * src.height - h / 2, w, h };
}

function kakaoClampCenter() {
    if (!kakaoMaker.src || !KAKAO_MODES[kakaoMaker.mode].aspect) return;
    const r = kakaoCropRect(), W = kakaoMaker.src.width, H = kakaoMaker.src.height;
    kakaoMaker.cx = studioClamp(kakaoMaker.cx, r.w / 2 / W, 1 - r.w / 2 / W);
    kakaoMaker.cy = studioClamp(kakaoMaker.cy, r.h / 2 / H, 1 - r.h / 2 / H);
}

// Start framed on the faces when AI 꾸미기 already found them for this picture; else the centre.
function kakaoAutoFrame() {
    kakaoMaker.cx = 0.5; kakaoMaker.cy = 0.5; kakaoMaker.zoom = 0;
    const a = KAKAO_MODES[kakaoMaker.mode].aspect;
    const faces = studioAiResult && studioAiResult.key === studioAiKey() ? studioAiResult.faces : [];
    if (a && faces.length && kakaoMaker.src) {
        const W = kakaoMaker.src.width, H = kakaoMaker.src.height;
        const x0 = Math.min(...faces.map(f => f.x0)) * W, x1 = Math.max(...faces.map(f => f.x1)) * W;
        const y0 = Math.min(...faces.map(f => f.y0)) * H, y1 = Math.max(...faces.map(f => f.y1)) * H;
        kakaoMaker.cx = (x0 + x1) / 2 / W;
        kakaoMaker.cy = (y0 + y1) / 2 / H;
        // Aim for the faces filling ~55% of the frame's width (and fitting its height).
        const fullW = kakaoCropRectAtZoom(0).w;
        const wantW = Math.max((x1 - x0) / 0.55, (y1 - y0) * a / 0.6);
        kakaoMaker.zoom = studioClamp((1 - wantW / fullW) / 0.7, 0, 1);
    }
    kakaoClampCenter();
    const z = document.getElementById("kakao-zoom");
    if (z) z.value = Math.round(kakaoMaker.zoom * 100);
}
function kakaoCropRectAtZoom(zoom) { const keep = kakaoMaker.zoom; kakaoMaker.zoom = zoom; const r = kakaoCropRect(); kakaoMaker.zoom = keep; return r; }

function kakaoBackgroundCanvas(W, H) {
    const src = kakaoMaker.src, back = kakaoMaker.backdrop || src;
    const bw = back.naturalWidth || back.width, bh = back.naturalHeight || back.height;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    // Blur without ctx.filter (older iPhone Safari): a real box blur on a small copy, scaled back up.
    const tiny = document.createElement("canvas");
    const cover = Math.max(W / bw, H / bh);
    tiny.width = 120; tiny.height = Math.max(1, Math.round(120 * H / W));
    const tctx = tiny.getContext("2d");
    tctx.drawImage(back, (bw - W / cover) / 2, (bh - H / cover) / 2, W / cover, H / cover, 0, 0, tiny.width, tiny.height);
    const td = tctx.getImageData(0, 0, tiny.width, tiny.height);
    const ch = studioSplit(td);
    const blurred = [ch.R, ch.G, ch.B].map(c => studioBoxBlur(studioBoxBlur(c, tiny.width, tiny.height, 5), tiny.width, tiny.height, 5));
    for (let i = 0, j = 0; i < ch.R.length; i++, j += 4) { td.data[j] = blurred[0][i]; td.data[j + 1] = blurred[1][i]; td.data[j + 2] = blurred[2][i]; }
    tctx.putImageData(td, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(tiny, 0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(0, 0, W, H);
    const fit = Math.min(W * 0.9 / src.width, H * 0.8 / src.height);
    const fw = src.width * fit, fh = src.height * fit;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.3)";
    ctx.shadowBlur = W * 0.03;
    ctx.shadowOffsetY = W * 0.01;
    ctx.drawImage(src, (W - fw) / 2, (H - fh) / 2, fw, fh);
    ctx.restore();
    return c;
}

function kakaoRender() {
    const canvas = document.getElementById("kakao-preview");
    if (!canvas || !kakaoMaker.src) return;
    const mode = KAKAO_MODES[kakaoMaker.mode];
    document.querySelectorAll("#kakao-tabs .studio-chip").forEach(b => b.classList.toggle("active", b.dataset.mode === kakaoMaker.mode));
    document.getElementById("kakao-zoom-row")?.classList.toggle("hidden", !mode.aspect);
    const hint = document.getElementById("kakao-hint");
    if (hint) hint.textContent = mode.hint.replace("SH_NAME", partnerAName).replace("SA_NAME", partnerBName);
    const ctx = canvas.getContext("2d");
    if (!mode.aspect) {
        canvas.width = 405; canvas.height = 720;
        ctx.drawImage(kakaoBackgroundCanvas(405, 720), 0, 0);
        canvas.style.touchAction = "";
        return;
    }
    canvas.style.touchAction = "none";
    const src = kakaoMaker.src;
    const scale = 640 / Math.max(src.width, src.height);
    canvas.width = Math.round(src.width * scale);
    canvas.height = Math.round(src.height * scale);
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    const r = kakaoCropRect();
    const x = r.x * scale, y = r.y * scale, w = r.w * scale, h = r.h * scale;
    // Dim everything outside the frame.
    ctx.save();
    ctx.fillStyle = "rgba(20,12,18,0.55)";
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.rect(x, y, w, h);
    ctx.fill("evenodd");
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    const circle = (cx, cy, rad) => { ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke(); };
    if (kakaoMaker.mode === "profile") {
        circle(x + w / 2, y + h / 2, w / 2);
    } else {
        ctx.beginPath(); ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + h); ctx.stroke();
        circle(x + w / 4, y + h / 2, h / 2);
        circle(x + w * 3 / 4, y + h / 2, h / 2);
        ctx.setLineDash([]);
        ctx.font = `800 ${Math.max(12, Math.round(h * 0.09))}px ${STUDIO_FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        ctx.fillStyle = "#fff";
        [[partnerAName, x + w / 4], [partnerBName, x + w * 3 / 4]].forEach(([t, tx]) => { ctx.strokeText(t, tx, y + 6); ctx.fillText(t, tx, y + 6); });
    }
    ctx.restore();
}

let kakaoGesturesAttached = false;
function kakaoAttachGestures() {
    const canvas = document.getElementById("kakao-preview");
    if (!canvas || kakaoGesturesAttached) return;
    kakaoGesturesAttached = true;
    canvas.addEventListener("pointerdown", e => {
        if (!KAKAO_MODES[kakaoMaker.mode].aspect || !kakaoMaker.src) return;
        e.preventDefault();
        try { canvas.setPointerCapture(e.pointerId); } catch (_) { }
        kakaoMaker.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: kakaoMaker.cx, cy: kakaoMaker.cy };
    });
    canvas.addEventListener("pointermove", e => {
        const d = kakaoMaker.drag;
        if (!d || d.id !== e.pointerId) return;
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        kakaoMaker.cx = d.cx + (e.clientX - d.x) / rect.width;
        kakaoMaker.cy = d.cy + (e.clientY - d.y) / rect.height;
        kakaoClampCenter();
        kakaoRender();
    });
    const end = e => { if (kakaoMaker.drag && kakaoMaker.drag.id === e.pointerId) kakaoMaker.drag = null; };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
}

function kakaoOutputCanvases() {
    const src = kakaoMaker.src;
    const square = (sx, sy, sw, sh) => {
        const c = document.createElement("canvas");
        c.width = c.height = 1080;
        const ctx = c.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(src, sx, sy, sw, sh, 0, 0, 1080, 1080);
        return c;
    };
    if (kakaoMaker.mode === "background") return [{ canvas: kakaoBackgroundCanvas(1080, 1920), suffix: "kakao_bg" }];
    const r = kakaoCropRect();
    if (kakaoMaker.mode === "profile") return [{ canvas: square(r.x, r.y, r.w, r.h), suffix: "kakao_profile" }];
    return [
        { canvas: square(r.x, r.y, r.w / 2, r.h), suffix: `couple_${partnerAName}` },
        { canvas: square(r.x + r.w / 2, r.y, r.w / 2, r.h), suffix: `couple_${partnerBName}` }
    ];
}

// Called straight from the button so iPhone still treats it as a tap and opens the share sheet.
window.kakaoSave = async function() {
    if (!kakaoMaker.src) return;
    try {
        const outs = kakaoOutputCanvases();
        const base = studioFileName().replace(/\.jpg$/, "");
        const safe = s => String(s).replace(/[\\/:*?"<>|\s]+/g, "_");
        const files = await Promise.all(outs.map(async o => new File([await studioCanvasToBlob(o.canvas)], `${base}_${safe(o.suffix)}.jpg`, { type: "image/jpeg" })));
        if (navigator.canShare && navigator.canShare({ files })) {
            try { await navigator.share({ files }); return; }
            catch (e) { if (e && e.name === "AbortError") return; }
        }
        for (const f of files) {
            await studioShareOrDownload(f, f.name);
            await new Promise(r => setTimeout(r, 300));
        }
    } catch (e) {
        console.error("[Kakao]", e);
        showToast("저장하지 못했어요: " + (e && e.message ? e.message : e), "danger");
    }
};

// ── 그림 효과 (유화 · 수채화 · 연필 스케치 · 만화) and 뽀샤시, all on the device ─────────────────
// They run per cell inside studioRenderCell, before the colour filter. The heavy work happens on a
// copy capped at STUDIO_ART_WORK_MAX px and is scaled back up: painterly looks don't need full
// resolution, and it keeps a 2048px export to a few hundred ms and tens of MB on an iPhone.
// Everything is O(pixels): box blurs are sliding sums, Kuwahara uses summed-area tables.
const STUDIO_ARTS = [
    { id: "none", name: "없음" },
    { id: "oil", name: "🎨 유화" },
    { id: "watercolor", name: "💧 수채화" },
    { id: "sketch", name: "✏️ 연필 스케치" },
    { id: "cartoon", name: "💥 만화" }
];
const STUDIO_ART_WORK_MAX = 1024;

function studioHash01(x, y) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
// Smooth value noise, cell = grid size in px; 0..1.
function studioValueNoise(x, y, cell) {
    const gx = x / cell, gy = y / cell, x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = studioHash01(x0, y0), b = studioHash01(x0 + 1, y0), c = studioHash01(x0, y0 + 1), d = studioHash01(x0 + 1, y0 + 1);
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
}

function studioBoxBlur(src, w, h, r) {
    if (r < 1) return Float32Array.from(src);
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h), d = 2 * r + 1;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
        for (let x = 0; x < w; x++) {
            tmp[row + x] = acc / d;
            acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
        }
    }
    for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
        for (let y = 0; y < h; y++) {
            out[y * w + x] = acc / d;
            acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
        }
    }
    return out;
}

function studioSplit(img) {
    const n = img.width * img.height, d = img.data;
    const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), L = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
        R[i] = d[j]; G[i] = d[j + 1]; B[i] = d[j + 2];
        L[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    }
    return { R, G, B, L };
}

// Kuwahara: each pixel takes the mean colour of whichever of its four neighbouring quadrants is the
// most uniform — flattens texture into brush-like patches while keeping edges.
function studioKuwahara(ch, w, h, r) {
    const W1 = w + 1, n = W1 * (h + 1);
    const iR = new Float64Array(n), iG = new Float64Array(n), iB = new Float64Array(n), iL = new Float64Array(n), iL2 = new Float64Array(n);
    for (let y = 0; y < h; y++) {
        let sR = 0, sG = 0, sB = 0, sL = 0, sL2 = 0;
        for (let x = 0; x < w; x++) {
            const p = y * w + x, l = ch.L[p];
            sR += ch.R[p]; sG += ch.G[p]; sB += ch.B[p]; sL += l; sL2 += l * l;
            const q = (y + 1) * W1 + x + 1, up = y * W1 + x + 1;
            iR[q] = iR[up] + sR; iG[q] = iG[up] + sG; iB[q] = iB[up] + sB; iL[q] = iL[up] + sL; iL2[q] = iL2[up] + sL2;
        }
    }
    const R = new Float32Array(w * h), G = new Float32Array(w * h), B = new Float32Array(w * h);
    const sum = (I, x0, y0, x1, y1) => I[(y1 + 1) * W1 + x1 + 1] - I[y0 * W1 + x1 + 1] - I[(y1 + 1) * W1 + x0] + I[y0 * W1 + x0];
    for (let y = 0; y < h; y++) {
        const ya = Math.max(0, y - r), yb = Math.min(h - 1, y + r);
        for (let x = 0; x < w; x++) {
            const xa = Math.max(0, x - r), xb = Math.min(w - 1, x + r);
            let best = Infinity, bx0 = 0, by0 = 0, bx1 = 0, by1 = 0, bc = 1;
            for (let q = 0; q < 4; q++) {
                const x0 = q & 1 ? x : xa, x1 = q & 1 ? xb : x, y0 = q & 2 ? y : ya, y1 = q & 2 ? yb : y;
                const c = (x1 - x0 + 1) * (y1 - y0 + 1);
                const m = sum(iL, x0, y0, x1, y1) / c;
                const v = sum(iL2, x0, y0, x1, y1) / c - m * m;
                if (v < best) { best = v; bx0 = x0; by0 = y0; bx1 = x1; by1 = y1; bc = c; }
            }
            const p = y * w + x;
            R[p] = sum(iR, bx0, by0, bx1, by1) / bc;
            G[p] = sum(iG, bx0, by0, bx1, by1) / bc;
            B[p] = sum(iB, bx0, by0, bx1, by1) / bc;
        }
    }
    const L = new Float32Array(w * h);
    for (let i = 0; i < L.length; i++) L[i] = 0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i];
    return { R, G, B, L };
}

// Sobel edge strength of a luminance plane, 0..~1.
function studioEdges(L, w, h) {
    const E = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const p = y * w + x;
            const gx = L[p - w + 1] + 2 * L[p + 1] + L[p + w + 1] - L[p - w - 1] - 2 * L[p - 1] - L[p + w - 1];
            const gy = L[p + w - 1] + 2 * L[p + w] + L[p + w + 1] - L[p - w - 1] - 2 * L[p - w] - L[p - w + 1];
            E[p] = Math.sqrt(gx * gx + gy * gy) / 255;
        }
    }
    return E;
}

// Runs fn(imageData) on a copy of `canvas` no larger than maxSide, then scales the result back.
// When `blend` is set, the result's alpha channel is used to mix it over the original.
function studioOnWorkCopy(canvas, maxSide, fn) {
    const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    const w = Math.max(1, Math.round(canvas.width * scale)), h = Math.max(1, Math.round(canvas.height * scale));
    const work = document.createElement("canvas");
    work.width = w; work.height = h;
    const wctx = work.getContext("2d");
    wctx.drawImage(canvas, 0, 0, w, h);
    const img = wctx.getImageData(0, 0, w, h);
    const overlay = fn(img, w, h);
    wctx.putImageData(img, 0, 0);
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (!overlay) ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(work, 0, 0, canvas.width, canvas.height);
    ctx.restore();
}

function studioApplyArt(canvas, art) {
    studioOnWorkCopy(canvas, STUDIO_ART_WORK_MAX, (img, w, h) => {
        const d = img.data, n = w * h, long = Math.max(w, h);
        const src = studioSplit(img);
        const put = (i, r, g, b) => {
            const j = i * 4;
            d[j] = r < 0 ? 0 : r > 255 ? 255 : r;
            d[j + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
            d[j + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
            d[j + 3] = 255;
        };
        if (art === "oil") {
            // Two passes: the second merges the first pass's patches into bigger, smoother strokes.
            const rad = Math.max(2, Math.round(long / 120));
            const k = studioKuwahara(studioKuwahara(src, w, h, rad), w, h, Math.max(2, Math.round(rad * 0.7)));
            const cell = Math.max(2, long / 300);
            for (let i = 0; i < n; i++) {
                const x = i % w, y = (i / w) | 0;
                // Canvas weave + a little directional "stroke" noise, then a richer, slightly punchier palette.
                const tex = 1 + 0.05 * (studioValueNoise(x, y * 0.35, cell) - 0.5) + 0.03 * (studioHash01(x >> 1, y >> 1) - 0.5);
                const gray = k.L[i];
                const r = gray + (k.R[i] - gray) * 1.25, g = gray + (k.G[i] - gray) * 1.25, b = gray + (k.B[i] - gray) * 1.25;
                put(i, ((r - 128) * 1.06 + 128) * tex, ((g - 128) * 1.06 + 128) * tex, ((b - 128) * 1.06 + 128) * tex);
            }
        } else if (art === "watercolor") {
            const rad = Math.max(2, Math.round(long / 110));
            let k = studioKuwahara(studioKuwahara(src, w, h, rad), w, h, Math.max(2, Math.round(rad * 0.6)));
            // Soft bleed of the colour patches.
            const r1 = Math.max(1, Math.round(long / 300));
            k = { R: studioBoxBlur(k.R, w, h, r1), G: studioBoxBlur(k.G, w, h, r1), B: studioBoxBlur(k.B, w, h, r1), L: k.L };
            const E = studioEdges(studioBoxBlur(k.L, w, h, 1), w, h);
            const blotch = Math.max(8, long / 9), grain = Math.max(1, long / 700);
            for (let i = 0; i < n; i++) {
                const x = i % w, y = (i / w) | 0;
                const e = Math.min(1, E[i] * 1.6);
                let r = k.R[i], g = k.G[i], b = k.B[i];
                const gray = 0.299 * r + 0.587 * g + 0.114 * b;
                r = gray + (r - gray) * 0.9; g = gray + (g - gray) * 0.9; b = gray + (b - gray) * 0.9;
                // Wash toward the paper, darker pigment pooled at the edges, uneven blotches, paper grain.
                const wash = 0.1 + 0.14 * studioValueNoise(x, y, blotch);
                r = r * (1 - wash) + 252 * wash; g = g * (1 - wash) + 249 * wash; b = b * (1 - wash) + 243 * wash;
                const pool = 1 - 0.45 * e;
                const paper = 1 + 0.07 * (studioValueNoise(x, y, grain * 3) - 0.5) + 0.04 * (studioHash01(x, y) - 0.5);
                put(i, r * pool * paper, g * pool * paper, b * pool * paper);
            }
        } else if (art === "sketch") {
            // Colour dodge of the grey image with its blurred negative = pencil lines on paper.
            const inv = new Float32Array(n);
            for (let i = 0; i < n; i++) inv[i] = 255 - src.L[i];
            const rb = Math.max(2, Math.round(long / 110));
            const blur = studioBoxBlur(studioBoxBlur(inv, w, h, rb), w, h, rb);
            for (let i = 0; i < n; i++) {
                const x = i % w, y = (i / w) | 0;
                let s = blur[i] >= 254 ? 255 : Math.min(255, src.L[i] * 255 / (255 - blur[i]));
                s = 255 * Math.pow(s / 255, 2.4);
                const hatch = 1 - 0.05 * studioHash01(x + y, (x - y) >> 1); // faint diagonal pencil texture
                const v = s * hatch;
                put(i, v * 0.99, v * 0.975, v * 0.95);
            }
        } else if (art === "cartoon") {
            const k = studioKuwahara(src, w, h, Math.max(2, Math.round(long / 260)));
            const E = studioEdges(studioBoxBlur(src.L, w, h, Math.max(1, Math.round(long / 600))), w, h);
            const lv = 6, q = v => Math.round(v / 255 * lv) / lv * 255;
            for (let i = 0; i < n; i++) {
                let r = k.R[i], g = k.G[i], b = k.B[i];
                const gray = 0.299 * r + 0.587 * g + 0.114 * b;
                r = gray + (r - gray) * 1.12; g = gray + (g - gray) * 1.12; b = gray + (b - gray) * 1.12;
                r = r * 0.55 + q(r) * 0.45; g = g * 0.55 + q(g) * 0.45; b = b * 0.55 + q(b) * 0.45;
                const ink = Math.min(1, Math.max(0, (E[i] - 0.28) * 3.5));
                const t = 1 - ink * 0.9;
                put(i, r * t + 25 * (1 - t), g * t + 20 * (1 - t), b * t + 30 * (1 - t));
            }
        }
        return false;
    });
}

// 뽀샤시: edge-preserving smoothing (self-guided filter) applied through a skin-colour mask, so skin
// gets soft while eyes, hair and background keep their detail. strength 0..100.
function studioApplySmooth(canvas, strength) {
    studioOnWorkCopy(canvas, STUDIO_ART_WORK_MAX, (img, w, h) => {
        const d = img.data, n = w * h, long = Math.max(w, h);
        const r = Math.max(2, Math.round(long / 120));
        const eps = Math.pow(255 * (0.04 + 0.08 * strength / 100), 2);
        const ch = studioSplit(img);
        const out = [ch.R, ch.G, ch.B].map(I => {
            const II = new Float32Array(n);
            for (let i = 0; i < n; i++) II[i] = I[i] * I[i];
            const mI = studioBoxBlur(I, w, h, r), mII = studioBoxBlur(II, w, h, r);
            const a = new Float32Array(n), b = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const v = mII[i] - mI[i] * mI[i];
                a[i] = v / (v + eps);
                b[i] = mI[i] - a[i] * mI[i];
            }
            const ma = studioBoxBlur(a, w, h, r), mb = studioBoxBlur(b, w, h, r);
            const q = new Float32Array(n);
            for (let i = 0; i < n; i++) q[i] = ma[i] * I[i] + mb[i];
            return q;
        });
        // Skin mask from YCbCr (a classic, lighting-tolerant range), softened so it has no hard border.
        const mask = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const R = ch.R[i], G = ch.G[i], B = ch.B[i];
            const cb = 128 - 0.168736 * R - 0.331264 * G + 0.5 * B;
            const cr = 128 + 0.5 * R - 0.418688 * G - 0.081312 * B;
            mask[i] = cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173 ? 1 : 0;
        }
        const soft = studioBoxBlur(mask, w, h, Math.max(2, Math.round(long / 250)));
        const amt = Math.min(1, strength / 70);
        const lift = strength * 0.12;
        for (let i = 0, j = 0; i < n; i++, j += 4) {
            const m = soft[i] * amt;
            // Glow: smoothed skin is also lifted a touch and warmed toward pink.
            d[j] = Math.min(255, out[0][i] + lift * 1.05);
            d[j + 1] = Math.min(255, out[1][i] + lift * 0.9);
            d[j + 2] = Math.min(255, out[2][i] + lift * 0.95);
            d[j + 3] = Math.round(m * 255);
        }
        return true; // mix over the original through the mask in alpha
    });
}

window.studioSetArt = function(id) { studio.art = id; studioRenderControls(); };
window.studioSetSmooth = function(v) { studio.smooth = Number(v) || 0; studioQueueRender(); };

// ── 얼굴 보정 (베타): 턱선 갸름하게 · 눈 크게 ─────────────────────────────────────────────────────
// MediaPipe Face Landmarker finds 478 points per face on the device (nothing is uploaded). It is
// loaded only when someone first moves one of these sliders: ~3MB of WASM from jsDelivr plus a ~3.7MB
// model from Google's storage, both cached by the browser afterwards. CPU delegate on purpose — the
// GPU path is the part least proven on iPhone Safari. The status line shows load and detect times,
// since this is still a trial on real phones.
//
// The reshape works on each ORIGINAL photo (before layout, crop and filters), so landmarks stay
// valid whatever the collage does with it; the reshaped copy is cached per photo + strengths.
// Warping is one backward-mapped pass over each face's region: jaw points are pushed toward the
// face's midline (blended so overlapping pushes never add up) and each eye gets a soft bulge.
const STUDIO_MP_VERSION = "0.10.35";
const STUDIO_MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${STUDIO_MP_VERSION}`;
const STUDIO_FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
// Lower jaw on each side, from the cheek down to near the chin, with how strongly each point moves.
const STUDIO_JAW_POINTS = [
    [132, 0.45], [58, 0.75], [172, 1], [136, 1], [150, 0.85], [149, 0.65], [176, 0.4], [148, 0.2],
    [361, 0.45], [288, 0.75], [397, 1], [365, 1], [379, 0.85], [378, 0.65], [400, 0.4], [377, 0.2]
];

// The MediaPipe library + WASM, shared by 얼굴 보정 and 배경 바꾸기 (downloaded once).
let studioVisionPromise = null;
function studioLoadVision() {
    if (!studioVisionPromise) {
        studioVisionPromise = (async () => {
            const vision = await import(`${STUDIO_MP_BASE}/vision_bundle.mjs`);
            const fileset = await vision.FilesetResolver.forVisionTasks(`${STUDIO_MP_BASE}/wasm`);
            return { vision, fileset };
        })();
        studioVisionPromise.catch(() => { studioVisionPromise = null; });
    }
    return studioVisionPromise;
}

let studioFaceLandmarker = null;
let studioFaceLoading = null;
const studioFaceCache = new Map();     // photo src → [[{x,y} × 478] per face] (normalised 0-1)
const studioReshapeCache = new Map();  // `${photoKey}|jaw|eye` → canvas

function studioPhotoKey(src) { return `${src.length}:${src.slice(-32)}`; }
function studioFaceStatus(text) {
    const el = document.getElementById("studio-face-status");
    if (el) el.textContent = text || "";
}

function studioLoadFaceLandmarker() {
    if (studioFaceLandmarker) return Promise.resolve(studioFaceLandmarker);
    if (studioFaceLoading) return studioFaceLoading;
    studioFaceLoading = (async () => {
        const t0 = performance.now();
        studioFaceStatus("얼굴 인식 모델을 받는 중이에요... (처음 한 번 약 7MB)");
        const { vision, fileset } = await studioLoadVision();
        studioFaceLandmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: STUDIO_FACE_MODEL, delegate: "CPU" },
            runningMode: "IMAGE",
            numFaces: 6
        });
        studioFaceStatus(`얼굴 인식 준비 완료 (${((performance.now() - t0) / 1000).toFixed(1)}초)`);
        return studioFaceLandmarker;
    })();
    studioFaceLoading.catch(() => { studioFaceLoading = null; });
    return studioFaceLoading;
}

async function studioDetectFaces(src) {
    if (studioFaceCache.has(src)) return studioFaceCache.get(src);
    const lm = await studioLoadFaceLandmarker();
    const img = await studioLoadImage(src);
    const res = lm.detect(img);
    const faces = (res && res.faceLandmarks || []).map(f => f.map(p => ({ x: p.x, y: p.y })));
    studioFaceCache.set(src, faces);
    return faces;
}

// Warps `img` per the landmarks. jaw/eye are 0-100.
function studioWarpFaces(img, faces, jaw, eye) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    for (const face of faces) {
        const P = i => ({ x: face[i].x * w, y: face[i].y * h });
        const xs = face.map(p => p.x * w), ys = face.map(p => p.y * h);
        const fx0 = Math.min(...xs), fx1 = Math.max(...xs), fy0 = Math.min(...ys), fy1 = Math.max(...ys);
        // Cheek-to-cheek width (234↔454) rather than the bounding box, so a tilted face isn't overrated.
        const faceW = Math.hypot(P(234).x - P(454).x, P(234).y - P(454).y) || (fx1 - fx0);
        if (faceW < 24) continue; // too small to reshape sensibly
        const moves = [], bulges = [];
        if (jaw > 0) {
            // Midline from between the eyes (168) to the chin (152); each jaw point moves toward its
            // nearest point on it, so a tilted head is slimmed along its own axis.
            const a = P(168), b = P(152);
            const ab = { x: b.x - a.x, y: b.y - a.y }, abLen2 = ab.x * ab.x + ab.y * ab.y || 1;
            const mag = jaw / 100 * 0.05 * faceW;
            for (const [i, wgt] of STUDIO_JAW_POINTS) {
                if (!face[i]) continue;
                const p = P(i);
                const t = studioClamp(((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / abLen2, 0, 1);
                const q = { x: a.x + ab.x * t, y: a.y + ab.y * t };
                const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1;
                const m = Math.min(mag * wgt, len * 0.4);
                moves.push({ cx: p.x, cy: p.y, mx: dx / len * m, my: dy / len * m, r: faceW * 0.28 });
            }
        }
        if (eye > 0) {
            const eyes = face.length >= 478
                ? [[P(468), P(33), P(133)], [P(473), P(362), P(263)]]
                : [[{ x: (P(33).x + P(133).x) / 2, y: (P(33).y + P(133).y) / 2 }, P(33), P(133)],
                   [{ x: (P(362).x + P(263).x) / 2, y: (P(362).y + P(263).y) / 2 }, P(362), P(263)]];
            for (const [center, c1, c2] of eyes) {
                bulges.push({ cx: center.x, cy: center.y, r: Math.hypot(c1.x - c2.x, c1.y - c2.y) * 1.05, a: eye / 100 * 0.2 });
            }
        }
        if (!moves.length && !bulges.length) continue;
        const pad = faceW * 0.3;
        const x0 = Math.max(0, Math.floor(fx0 - pad)), y0 = Math.max(0, Math.floor(fy0 - pad));
        const x1 = Math.min(w, Math.ceil(fx1 + pad)), y1 = Math.min(h, Math.ceil(fy1 + pad));
        const rw = x1 - x0, rh = y1 - y0;
        if (rw < 2 || rh < 2) continue;
        const srcData = ctx.getImageData(x0, y0, rw, rh);
        const out = ctx.createImageData(rw, rh);
        const S = srcData.data, O = out.data;
        for (let yy = 0; yy < rh; yy++) {
            for (let xx = 0; xx < rw; xx++) {
                const X = xx + x0, Y = yy + y0;
                let sx = X, sy = Y;
                // Jaw: a weighted AVERAGE of the nearby pushes (never their sum), so where the jaw
                // points' circles overlap the shift stays at most one push — summing them made the
                // image fold over itself into ripples. Smooth (1-d²/r²)² falloff to zero at the rim.
                let vx = 0, vy = 0, wsum = 0;
                for (const mv of moves) {
                    const ddx = X - mv.cx, ddy = Y - mv.cy, d2 = ddx * ddx + ddy * ddy, r2 = mv.r * mv.r;
                    if (d2 >= r2) continue;
                    const t = 1 - d2 / r2, wgt = t * t;
                    vx += wgt * mv.mx; vy += wgt * mv.my; wsum += wgt;
                }
                if (wsum > 0) {
                    const norm = 1 / Math.max(1, wsum);
                    sx -= vx * norm; sy -= vy * norm;
                }
                for (const bg of bulges) {
                    const ddx = X - bg.cx, ddy = Y - bg.cy, d = Math.sqrt(ddx * ddx + ddy * ddy);
                    if (d >= bg.r) continue;
                    const k = bg.a * (1 - (d / bg.r) * (d / bg.r));
                    sx -= ddx * k; sy -= ddy * k;
                }
                // Bilinear sample from the untouched region copy.
                const lx = studioClamp(sx - x0, 0, rw - 1.001), ly = studioClamp(sy - y0, 0, rh - 1.001);
                const ix = lx | 0, iy = ly | 0, fx = lx - ix, fy = ly - iy;
                const i00 = (iy * rw + ix) * 4, i10 = i00 + 4, i01 = i00 + rw * 4, i11 = i01 + 4;
                const o = (yy * rw + xx) * 4;
                for (let ch = 0; ch < 3; ch++) {
                    const top = S[i00 + ch] + (S[i10 + ch] - S[i00 + ch]) * fx;
                    const bot = S[i01 + ch] + (S[i11 + ch] - S[i01 + ch]) * fx;
                    O[o + ch] = top + (bot - top) * fy;
                }
                O[o + 3] = 255;
            }
        }
        ctx.putImageData(out, x0, y0);
    }
    return c;
}

// What the collage/video should draw for each photo: the reshaped copy when 얼굴 보정 is on and the
// faces are known, otherwise the original image.
// 얼굴 보정 first, then 배경 바꾸기 on top of the reshaped photo (the mask comes from the original —
// the warp only nudges the jaw/eyes, well inside the person outline). Both results are cached.
async function studioSourceImages() {
    const imgs = await Promise.all(studio.photos.map(ph => studioLoadImage(ph.src)));
    const { jaw, eye } = studio.reshape;
    const bg = studio.bgSwap;
    const swap = studioBgSwapActive();
    if (!jaw && !eye && !swap) return imgs;
    const cached = (key, make) => {
        if (!studioReshapeCache.has(key)) {
            if (studioReshapeCache.size > 24) studioReshapeCache.clear();
            studioReshapeCache.set(key, make());
        }
        return studioReshapeCache.get(key);
    };
    return imgs.map((img, i) => {
        const src = studio.photos[i].src, pk = studioPhotoKey(src);
        let out = img;
        const faces = studioFaceCache.get(src);
        if ((jaw || eye) && faces && faces.length) out = cached(`${pk}|${jaw}|${eye}`, () => studioWarpFaces(img, faces, jaw, eye));
        const mask = studioMaskCache.get(src);
        if (swap && mask && mask.coverage > 0.01) {
            const base = out;
            out = cached(`${pk}|${jaw}|${eye}|bg:${bg.mode}:${bg.fill}:${bg.outline ? 1 : 0}`, () => studioSwapBackground(base, mask, bg));
        }
        return out;
    });
}

let studioFaceDetecting = null;
window.studioSetReshape = async function(key, value) {
    studio.reshape[key] = Number(value) || 0;
    if (!studio.reshape.jaw && !studio.reshape.eye) { studioQueueRender(); return; }
    // The slider is live (oninput): calls that arrive while detection runs just wait for it.
    if (studioFaceDetecting) { await studioFaceDetecting; studioQueueRender(); return; }
    const missing = studio.photos.filter(p => !studioFaceCache.has(p.src));
    if (!missing.length) { studioQueueRender(); return; }
    let done;
    studioFaceDetecting = new Promise(res => { done = res; });
    try {
        await studioLoadFaceLandmarker();
        const t0 = performance.now();
        studioFaceStatus("얼굴을 찾는 중이에요... 🔍");
        let found = 0;
        for (const p of studio.photos) found += (await studioDetectFaces(p.src)).length;
        studioFaceStatus(found
            ? `얼굴 ${found}개를 찾았어요 (${((performance.now() - t0) / 1000).toFixed(1)}초) · 사진 밖으로 보내지 않아요`
            : "얼굴을 찾지 못했어요. 얼굴이 크게 나온 사진에서 써보세요 🥲");
    } catch (e) {
        console.error("[Studio face]", e);
        studioFaceStatus("얼굴 보정을 불러오지 못했어요: " + (e && e.message ? e.message : e));
    }
    studioFaceDetecting = null;
    done();
    studioQueueRender();
};

// ── 배경 바꾸기: keep the people, change what's behind them ───────────────────────────────────────
// MediaPipe's selfie segmenter (≈250KB model, on-device, same library/WASM as 얼굴 보정) gives a
// person-confidence mask per photo. The background is replaced on each ORIGINAL photo (after 얼굴 보정,
// before layout/filters/painting effects), so everything downstream treats it as a normal photo.
// Modes: blur (portrait-mode look), mono (colour pop: background grey, people in colour), fill (any
// studio background colour or pattern). The outline option draws a white sticker-style border around
// the people. The model is tuned for people near the camera; small far-away figures may be missed.
const STUDIO_SEG_MODEL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite";
const STUDIO_BG_MODES = [
    { id: "none", name: "원본" },
    { id: "blur", name: "🌫️ 흐리게" },
    { id: "mono", name: "🖤 흑백 배경" },
    { id: "fill", name: "🎨 배경색·무늬" }
];

let studioSegmenter = null;
let studioSegLoading = null;
const studioMaskCache = new Map(); // photo src → { canvas (alpha mask), data, w, h, coverage }

function studioBgStatus(text) {
    const el = document.getElementById("studio-bg-status");
    if (el) el.textContent = text || "";
}

function studioLoadSegmenter() {
    if (studioSegmenter) return Promise.resolve(studioSegmenter);
    if (studioSegLoading) return studioSegLoading;
    studioSegLoading = (async () => {
        const t0 = performance.now();
        studioBgStatus(studioVisionPromise ? "배경 인식 모델을 받는 중이에요..." : "배경 인식 모델을 받는 중이에요... (처음 한 번 약 3MB)");
        const { vision, fileset } = await studioLoadVision();
        studioSegmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: STUDIO_SEG_MODEL, delegate: "CPU" },
            runningMode: "IMAGE",
            outputCategoryMask: false,
            outputConfidenceMasks: true
        });
        studioBgStatus(`배경 인식 준비 완료 (${((performance.now() - t0) / 1000).toFixed(1)}초)`);
        return studioSegmenter;
    })();
    studioSegLoading.catch(() => { studioSegLoading = null; });
    return studioSegLoading;
}

async function studioPersonMask(src) {
    if (studioMaskCache.has(src)) return studioMaskCache.get(src);
    const seg = await studioLoadSegmenter();
    const img = await studioLoadImage(src);
    const res = seg.segment(img);
    const masks = (res && res.confidenceMasks) || [];
    // Two masks = [background, person]; a single one is the person confidence.
    const m = masks.length > 1 ? masks[masks.length - 1] : masks[0];
    if (!m) { if (res && res.close) res.close(); throw new Error("배경 인식 결과가 비어 있어요"); }
    const w = m.width, h = m.height;
    const data = Float32Array.from(m.getAsFloat32Array());
    if (res && res.close) res.close();
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(w, h);
    let on = 0;
    for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (v > 0.5) on++;
        // Sharpen the soft confidence edge a little (smoothstep 0.3→0.7) but keep it feathered.
        const t = studioClamp((v - 0.3) / 0.4, 0, 1);
        id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = 255;
        id.data[i * 4 + 3] = Math.round(t * t * (3 - 2 * t) * 255);
    }
    ctx.putImageData(id, 0, 0);
    const mask = { canvas: c, data, w, h, coverage: on / data.length };
    studioMaskCache.set(src, mask);
    return mask;
}

// White border around the people: the mask grown outward (blurred binary mask, low threshold).
function studioOutlineMask(mask) {
    const { data, w, h } = mask;
    const bin = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) bin[i] = data[i] > 0.5 ? 1 : 0;
    const r = Math.max(2, Math.round(Math.max(w, h) / 70));
    const grown = studioBoxBlur(studioBoxBlur(bin, w, h, r), w, h, r);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(w, h);
    for (let i = 0; i < grown.length; i++) {
        const t = studioClamp((grown[i] - 0.03) / 0.12, 0, 1);
        id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = 255;
        id.data[i * 4 + 3] = Math.round(t * 255);
    }
    ctx.putImageData(id, 0, 0);
    return c;
}

function studioSwapBackground(img, mask, opt) {
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const ctx = out.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // 1. Background layer.
    if (opt.mode === "blur") {
        const sw = Math.max(64, Math.round(W / 8)), sh = Math.max(64, Math.round(H / 8));
        const small = document.createElement("canvas");
        small.width = sw; small.height = sh;
        const sctx = small.getContext("2d");
        sctx.drawImage(img, 0, 0, sw, sh);
        const id = sctx.getImageData(0, 0, sw, sh);
        const ch = studioSplit(id);
        const rr = Math.max(2, Math.round(Math.max(sw, sh) / 45));
        const b = [ch.R, ch.G, ch.B].map(p => studioBoxBlur(studioBoxBlur(p, sw, sh, rr), sw, sh, rr));
        for (let i = 0, j = 0; i < ch.R.length; i++, j += 4) { id.data[j] = b[0][i]; id.data[j + 1] = b[1][i]; id.data[j + 2] = b[2][i]; }
        sctx.putImageData(id, 0, 0);
        ctx.drawImage(small, 0, 0, W, H);
    } else if (opt.mode === "mono") {
        ctx.drawImage(img, 0, 0);
        const id = ctx.getImageData(0, 0, W, H), d = id.data;
        for (let j = 0; j < d.length; j += 4) {
            const y = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) * 0.92;
            d[j] = d[j + 1] = d[j + 2] = y;
        }
        ctx.putImageData(id, 0, 0);
    } else if (opt.mode === "fill") {
        const bg = STUDIO_BACKGROUNDS.find(b => b.id === opt.fill) || STUDIO_BACKGROUNDS[1];
        ctx.fillStyle = bg.color;
        ctx.fillRect(0, 0, W, H);
        if (bg.pattern) studioDrawPattern(ctx, bg, W, H);
    } else {
        ctx.drawImage(img, 0, 0);
    }

    // 2. People, cut out with the (feathered) mask.
    const person = document.createElement("canvas");
    person.width = W; person.height = H;
    const pctx = person.getContext("2d");
    pctx.imageSmoothingEnabled = true;
    pctx.imageSmoothingQuality = "high";
    pctx.drawImage(img, 0, 0);
    pctx.globalCompositeOperation = "destination-in";
    pctx.drawImage(mask.canvas, 0, 0, W, H);

    // 3. Optional white sticker outline under the people.
    if (opt.outline) {
        const ol = document.createElement("canvas");
        ol.width = W; ol.height = H;
        const octx = ol.getContext("2d");
        octx.imageSmoothingEnabled = true;
        octx.fillStyle = "#FFFFFF";
        octx.fillRect(0, 0, W, H);
        octx.globalCompositeOperation = "destination-in";
        octx.drawImage(studioOutlineMask(mask), 0, 0, W, H);
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.22)";
        ctx.shadowBlur = Math.max(W, H) * 0.012;
        ctx.drawImage(ol, 0, 0);
        ctx.restore();
    }
    ctx.drawImage(person, 0, 0);
    return out;
}

function studioBgSwapActive() {
    return studio.bgSwap.mode !== "none" || studio.bgSwap.outline;
}

window.studioSetBgSwap = async function(key, value) {
    studio.bgSwap[key] = value;
    studioRenderControls();
    if (!studioBgSwapActive()) { studioBgStatus(""); studioQueueRender(); return; }
    const missing = studio.photos.filter(p => !studioMaskCache.has(p.src));
    if (missing.length) {
        try {
            await studioLoadSegmenter();
            const t0 = performance.now();
            studioBgStatus("사람을 찾는 중이에요... 🔍");
            const masks = [];
            for (const p of studio.photos) masks.push(await studioPersonMask(p.src));
            const withPeople = masks.filter(m => m.coverage > 0.01).length;
            studioBgStatus(withPeople
                ? `사진 ${withPeople}장에서 사람을 찾았어요 (${((performance.now() - t0) / 1000).toFixed(1)}초) · 사진 밖으로 보내지 않아요`
                : "사람을 찾지 못했어요. 사람이 크게 나온 사진에서 써보세요 🥲");
        } catch (e) {
            console.error("[Studio bg]", e);
            studioBgStatus("배경 바꾸기를 불러오지 못했어요: " + (e && e.message ? e.message : e));
        }
    }
    studioQueueRender();
};

function studioRenderBgControls() {
    const modes = document.getElementById("studio-bg-modes");
    if (modes) modes.innerHTML = STUDIO_BG_MODES.map(m => `<button type="button" class="studio-chip small${m.id === studio.bgSwap.mode ? " active" : ""}" onclick="studioSetBgSwap('mode', ${jsArg(m.id)})">${escapeHtml(m.name)}</button>`).join("");
    const fills = document.getElementById("studio-bg-fills");
    if (fills) {
        fills.classList.toggle("hidden", studio.bgSwap.mode !== "fill");
        fills.innerHTML = STUDIO_BACKGROUNDS.map(b => {
            const img = studioSwatchImage(b);
            const style = `background-color:${b.color};${img ? `background-image:url(${img});background-size:cover;` : ""}`;
            return `<button type="button" class="studio-swatch${b.id === studio.bgSwap.fill ? " active" : ""}" style="${style}" onclick="studioSetBgSwap('fill', ${jsArg(b.id)})" title="${b.label}" aria-label="사람 뒤 배경 ${b.label}"></button>`;
        }).join("");
    }
    const ol = document.getElementById("studio-bg-outline");
    if (ol) ol.checked = !!studio.bgSwap.outline;
}

// ── Photo picker (photos of every place, newest date first) ──────────────────────────────────────
let studioPickerSelection = [];
let studioPickerPlaces = [];
let studioPickerObserver = null;

window.openStudioPicker = async function() {
    studioPickerSelection = studio.photos.map(p => p.src);
    const listEl = document.getElementById("studio-picker-list");
    if (!listEl) return;
    studioPickerPlaces = (await getPlaces())
        .filter(p => p.isDeleted !== 1 && p.isVisited !== -1)
        .map(p => ({ p, photos: p.photos || (p.photo ? [p.photo] : []) }))
        .filter(x => x.photos.length > 0)
        .sort((a, b) => parseAnyDate(b.p.createdAt || b.p.date) - parseAnyDate(a.p.createdAt || a.p.date));
    listEl.innerHTML = studioPickerPlaces.length === 0
        ? `<div class="studio-picker-empty">아직 사진이 있는 장소가 없어요. 다녀온 곳에 사진을 먼저 올려주세요 📸</div>`
        : studioPickerPlaces.map((x, pi) => `
            <div class="studio-picker-group">
                <div class="studio-picker-title">${escapeHtml(x.p.name)} <span>${escapeHtml(formatDisplayDateRange(x.p.createdAt || x.p.date, x.p.endDate) || "")} · ${x.photos.length}장</span></div>
                <div class="studio-picker-grid">
                    ${x.photos.map((_, i) => `<button type="button" class="studio-pick" data-pi="${pi}" data-i="${i}" onclick="studioTogglePick(${pi}, ${i})"><img src="${LAZY_PIXEL}" data-pi="${pi}" data-i="${i}" alt=""><span class="studio-pick-no"></span></button>`).join("")}
                </div>
            </div>`).join("");
    if (studioPickerObserver) studioPickerObserver.disconnect();
    studioPickerObserver = "IntersectionObserver" in window ? new IntersectionObserver(entries => {
        entries.forEach(en => {
            if (!en.isIntersecting) return;
            const img = en.target;
            const x = studioPickerPlaces[+img.dataset.pi];
            if (x) img.src = x.photos[+img.dataset.i];
            studioPickerObserver.unobserve(img);
        });
    }, { root: listEl, rootMargin: "300px" }) : null;
    listEl.querySelectorAll("img[data-pi]").forEach(img => {
        if (studioPickerObserver) studioPickerObserver.observe(img);
        else img.src = studioPickerPlaces[+img.dataset.pi].photos[+img.dataset.i];
    });
    studioUpdatePickerMarks();
    document.getElementById("modal-studio-picker")?.classList.add("active");
    listEl.scrollTop = 0;
};

function studioUpdatePickerMarks() {
    document.querySelectorAll("#studio-picker-list .studio-pick").forEach(btn => {
        const x = studioPickerPlaces[+btn.dataset.pi];
        const src = x && x.photos[+btn.dataset.i];
        const n = studioPickerSelection.indexOf(src);
        btn.classList.toggle("selected", n >= 0);
        btn.querySelector(".studio-pick-no").textContent = n >= 0 ? String(n + 1) : "";
    });
    const doneBtn = document.getElementById("studio-picker-done");
    if (doneBtn) doneBtn.textContent = `완료 (${studioPickerSelection.length}/${STUDIO_MAX_PHOTOS})`;
}

window.studioTogglePick = function(pi, i) {
    const x = studioPickerPlaces[pi];
    const src = x && x.photos[i];
    if (!src) return;
    const at = studioPickerSelection.indexOf(src);
    if (at >= 0) studioPickerSelection.splice(at, 1);
    else if (studioPickerSelection.length >= STUDIO_MAX_PHOTOS) { showToast(`한 번에 ${STUDIO_MAX_PHOTOS}장까지 고를 수 있어요.`, "info"); return; }
    else studioPickerSelection.push(src);
    studioUpdatePickerMarks();
};

window.closeStudioPicker = function(apply) {
    if (apply) {
        const known = new Map(studio.photos.map(p => [p.src, p]));
        studio.photos = studioPickerSelection.map(src => {
            if (known.has(src)) return known.get(src);
            const x = studioPickerPlaces.find(x => x.photos.includes(src));
            return { src, placeId: x ? x.p.id : null, placeName: x ? x.p.name : "", dateMs: x ? parseAnyDate(x.p.createdAt || x.p.date) : 0 };
        });
        studioRenderControls();
    }
    document.getElementById("modal-studio-picker")?.classList.remove("active");
    if (studioPickerObserver) { studioPickerObserver.disconnect(); studioPickerObserver = null; }
    const listEl = document.getElementById("studio-picker-list");
    if (listEl) listEl.innerHTML = ""; // release the decoded thumbnails
    if (studio.photos.length === 0) closePhotoStudio();
};

// ── Cloud sync for 꾸민 사진 ─────────────────────────────────────────────────────────────────────
function creationsVersionStorageKey() { return `aura_creations_version_${syncRoomId}`; }
function creationsRoomBase() { return `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}`; }

async function bumpCreationsVersion() {
    const ts = Date.now();
    const r = await fetch(`${creationsRoomBase()}/creationsVersion.json?print=silent`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ts)
    });
    if (r.ok) localStorage.setItem(creationsVersionStorageKey(), String(ts));
    return r.ok;
}

// Uploads one creation and confirms it landed (reads back its createdAt). Returns true on success.
async function uploadCreation(row) {
    if (!syncRoomId || row.room !== syncRoomId) return false;
    try {
        const { id, img, kind, createdAt, caption, sources } = row;
        const nodeUrl = `${creationsRoomBase()}/creations/${encodeURIComponent(id)}`;
        const r = await fetch(`${nodeUrl}.json?print=silent`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ img, kind, createdAt, caption, sources })
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const check = await fetchJsonWithTimeout(`${nodeUrl}/createdAt.json?t=${Date.now()}`, 15000);
        if (check !== createdAt) throw new Error("verify mismatch");
        await db.creations.update(id, { uploaded: true });
        await bumpCreationsVersion();
        return true;
    } catch (e) {
        console.error("[Creations] upload failed:", e);
        return false;
    }
}

let creationsSyncInFlight = false;
// Pushes this device's not-yet-uploaded creations, then pulls what changed (only when the room's
// creationsVersion moved, or `force`). New ones download one per request; ones deleted elsewhere
// (gone from the cloud listing) are removed here — but never a local one that hasn't gone out yet.
async function syncCreations(force = false) {
    if (!syncRoomId || creationsSyncInFlight) return;
    creationsSyncInFlight = true;
    let changed = false;
    try {
        const pending = await db.creations.where("room").equals(syncRoomId).filter(c => !c.uploaded).toArray();
        for (const row of pending) { if (await uploadCreation(row)) changed = true; }

        const remoteVersion = await fetchJsonWithTimeout(`${creationsRoomBase()}/creationsVersion.json?t=${Date.now()}`, 15000);
        const known = parseInt(localStorage.getItem(creationsVersionStorageKey()) || "0", 10) || 0;
        if (!force && (!remoteVersion || remoteVersion === known)) return;

        const listing = await fetchJsonWithTimeout(`${creationsRoomBase()}/creations.json?shallow=true&t=${Date.now()}`, 15000) || {};
        const cloudIds = new Set(Object.keys(listing));
        const local = await db.creations.where("room").equals(syncRoomId).toArray();
        const localIds = new Set(local.map(c => c.id));

        for (const c of local) {
            if (c.uploaded && !cloudIds.has(c.id)) { await db.creations.delete(c.id); changed = true; }
        }
        let allOk = true;
        for (const id of cloudIds) {
            if (localIds.has(id)) continue;
            try {
                const node = await fetchJsonWithTimeout(`${creationsRoomBase()}/creations/${encodeURIComponent(id)}.json?t=${Date.now()}`, 60000);
                if (node && typeof node.img === "string" && node.img.startsWith("data:image/")) {
                    await db.creations.put({
                        id, room: syncRoomId, img: node.img, kind: node.kind === "collage" ? "collage" : "filter",
                        createdAt: Number(node.createdAt) || 0, caption: String(node.caption || "").slice(0, 60),
                        sources: Array.isArray(node.sources) ? node.sources.slice(0, STUDIO_MAX_PHOTOS) : [],
                        uploaded: true
                    });
                    changed = true;
                }
            } catch (e) {
                allOk = false;
                console.error("[Creations] download failed for", id, e);
            }
        }
        if (allOk && remoteVersion) localStorage.setItem(creationsVersionStorageKey(), String(remoteVersion));
    } catch (e) {
        console.error("[Creations] sync failed:", e);
    } finally {
        creationsSyncInFlight = false;
        if (changed) renderCreationsSection();
    }
}

// ── 꾸민 사진 section in the gallery tab + its viewer ───────────────────────────────────────────
let creationsShown = [];
async function renderCreationsSection() {
    const wrap = document.getElementById("creations-section");
    const grid = document.getElementById("creations-grid");
    if (!wrap || !grid) return;
    let rows = [];
    try { rows = await db.creations.where("room").equals(syncRoomId).toArray(); } catch (e) {}
    rows.sort((a, b) => b.createdAt - a.createdAt);
    creationsShown = rows;
    wrap.classList.toggle("hidden", rows.length === 0);
    const countEl = document.getElementById("creations-count");
    if (countEl) countEl.textContent = `${rows.length}장`;
    grid.innerHTML = rows.map((c, i) => `
        <button type="button" class="creation-tile" onclick="openCreationViewer(${i})">
            <img src="${c.img}" alt="꾸민 사진" loading="lazy">
            ${c.uploaded ? "" : `<span class="creation-pending" title="아직 클라우드에 올라가지 않았어요">업로드 대기</span>`}
        </button>`).join("");
}

let activeCreationIndex = 0;
window.openCreationViewer = function(i) {
    const c = creationsShown[i];
    if (!c) return;
    activeCreationIndex = i;
    const img = document.getElementById("creation-viewer-img");
    if (img) img.src = c.img;
    const meta = document.getElementById("creation-viewer-meta");
    if (meta) {
        const d = new Date(c.createdAt);
        const names = [...new Set((c.sources || []).map(s => s.placeName).filter(Boolean))];
        meta.textContent = `${c.kind === "collage" ? "콜라주" : "필터"} · ${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} 만듦` +
            (names.length ? ` · ${names.join(", ")}` : "") + (c.uploaded ? "" : " · 아직 업로드 전");
    }
    document.getElementById("modal-creation-viewer")?.classList.add("active");
    setTimeout(() => lucide.createIcons(), 50);
};
window.closeCreationViewer = function() {
    document.getElementById("modal-creation-viewer")?.classList.remove("active");
};

window.saveCreationToPhone = async function() {
    const c = creationsShown[activeCreationIndex];
    if (!c) return;
    const blob = await (await fetch(c.img)).blob();
    await studioShareOrDownload(blob, `AURA_꾸민사진_${c.id}.jpg`);
};

window.deleteActiveCreation = async function() {
    const c = creationsShown[activeCreationIndex];
    if (!c) return;
    if (!(await showConfirmModal("이 꾸민 사진을 삭제할까요?\n\n두 사람 기기 모두에서 사라지고 되돌릴 수 없어요."))) return;
    try {
        if (c.uploaded && syncRoomId) {
            const r = await fetch(`${creationsRoomBase()}/creations/${encodeURIComponent(c.id)}.json`, { method: "DELETE" });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            await bumpCreationsVersion();
        }
        await db.creations.delete(c.id);
        closeCreationViewer();
        await renderCreationsSection();
        showToast("꾸민 사진을 삭제했어요.", "success");
    } catch (e) {
        showToast("삭제하지 못했어요. 인터넷 연결을 확인해 주세요.", "danger");
    }
};
