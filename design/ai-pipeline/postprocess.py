"""Build E:\\AI\\outputs\\report: transparent cut-outs, animated previews (4/8/12 frames) and an HTML comparison page."""
import glob, json, os, shutil, sys
import numpy as np
from PIL import Image

sys.path.insert(0, r"C:\Users\soulr\Desktop\Claude\Dating-Planning-Agent\design\character-src")
import cut  # background_mask / to_rgba / keep_main

O = r"E:\AI\outputs"
R = os.path.join(O, "report")
os.makedirs(R, exist_ok=True)
PREVIEW = 236       # 2x the app's 118px pet box
FRAME_MS = 230      # same pace as the app's drawn dance poses


def cutout(path):
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.int16)
    rgba = cut.keep_main(cut.to_rgba(a, cut.background_mask(a)), False)
    ys, xs = np.nonzero(rgba[..., 3] > 0)
    return rgba, (ys.min(), ys.max(), xs.min(), xs.max())


def normalize(paths):
    """One scale for the whole set (largest piece fits), bottom-centred like cut.py."""
    pieces = [cutout(p) for p in paths]
    crops = [r[y0:y1 + 1, x0:x1 + 1] for r, (y0, y1, x0, x1) in pieces]
    big = max(max(c.shape[:2]) for c in crops)
    scale = PREVIEW * 0.88 / big
    out = []
    for c in crops:
        im = Image.fromarray(c, "RGBA")
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
        cv = Image.new("RGBA", (PREVIEW, PREVIEW), (0, 0, 0, 0))
        cv.paste(im, ((PREVIEW - im.width) // 2, PREVIEW - round(PREVIEW * 0.05) - im.height), im)
        out.append(cv)
    return out


def anim(frames, name, ms):
    bg = []
    for f in frames:  # pink app-like backdrop so it reads like the dashboard card
        b = Image.new("RGBA", f.size, (255, 244, 247, 255)); b.alpha_composite(f); bg.append(b.convert("RGB"))
    p = os.path.join(R, name)
    bg[0].save(p, save_all=True, append_images=bg[1:], duration=ms, loop=0, quality=90, method=4)
    return name


def pick(n, total):
    return [round(i * (total - 1) / max(1, n - 1)) for i in range(n)] if n > 1 else [0]


rows = []
# ① ② drawn poses
for combo, label in (("1_qwen", "① Qwen-Image-Edit"), ("2_flux", "② FLUX Kontext")):
    for motion in ("wave", "dance"):
        paths = sorted(glob.glob(os.path.join(O, "character", f"{combo}_{motion}", "*.png")))
        frames = normalize(paths)
        strip = Image.new("RGBA", (PREVIEW * len(frames), PREVIEW), (255, 244, 247, 255))
        for i, f in enumerate(frames): strip.alpha_composite(f, (PREVIEW * i, 0))
        strip.convert("RGB").save(os.path.join(R, f"{combo}_{motion}_strip.jpg"), quality=88)
        previews = {}
        for n in (4, 8, 12):
            if n > len(frames): continue
            sel = [frames[i] for i in pick(n, len(frames))]
            # same loop length for every count, so 4 vs 8 vs 12 compares smoothness, not speed
            previews[n] = anim(sel, f"{combo}_{motion}_{n}.webp", round(FRAME_MS * len(frames) / n))
        rows.append({"combo": label, "motion": motion, "strip": f"{combo}_{motion}_strip.jpg", "previews": previews, "kind": "poses"})

# ③ ④ ⑤ Wan videos
for combo, label in (("3_wan", "③ Wan 단독"), ("4_qwen_wan", "④ Qwen → Wan"), ("5_flux_wan", "⑤ FLUX → Wan")):
    for motion in ("wave", "dance"):
        folder = os.path.join(O, "character", f"{combo}_{motion}")
        paths = sorted(glob.glob(os.path.join(folder, "frame*.png")))
        if not paths: continue
        clip_ms = len(paths) * 1000 / 24
        previews = {}
        for n in (4, 8, 12, len(paths)):
            sel_paths = [paths[i] for i in pick(n, len(paths))]
            frames = normalize(sel_paths)
            key = n if n != len(paths) else "full"
            previews[key] = anim(frames, f"{combo}_{motion}_{key}.webp", max(40, round(clip_ms / n)))
        mp4 = sorted(glob.glob(os.path.join(folder, "*.mp4")))
        if mp4:
            shutil.copy(mp4[0], os.path.join(R, f"{combo}_{motion}.mp4"))
        rows.append({"combo": label, "motion": motion, "previews": previews, "kind": "video",
                     "mp4": f"{combo}_{motion}.mp4" if mp4 else None})

# timings
logs = []
for p in glob.glob(os.path.join(O, "character", "log_batch1*.json")) + glob.glob(os.path.join(O, "icons", "log_batch2*.json")):
    logs += json.load(open(p, encoding="utf-8"))
json.dump({"rows": rows, "logs": logs}, open(os.path.join(R, "data.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("rows", len(rows), "logs", len(logs))
