"""Cut the ChatGPT character sheets into transparent, consistently-scaled WebP sprites.

out/stage-0..5.webp, out/face-idle|happy|sleepy|sad.webp, out/sticker-0..7.webp,
plus blink frames (*-blink.webp) for each stage and the adult idle face.
"""
import os, sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

SRC, OUT = "src", sys.argv[1] if len(sys.argv) > 1 else "out"
os.makedirs(OUT, exist_ok=True)
CANVAS = 480          # output square size
MARGIN = 0.06         # empty border around the largest sprite of a sheet


def load(name):
    return np.asarray(Image.open(f"{SRC}/{name}.webp").convert("RGB")).astype(np.int16)


def background_mask(a):
    """Near-white/light-grey pixels reachable from the image border (the outline stops the flood)."""
    light = a.min(axis=2) > 200
    lab, _ = ndimage.label(light)
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    return np.isin(lab, list(border))


def to_rgba(a, bg):
    """Alpha from the background mask, with a 1px soft edge un-mixed from white."""
    h, w, _ = a.shape
    alpha = np.where(bg, 0.0, 1.0)
    edge = ndimage.binary_dilation(bg, iterations=1) & ~bg  # fg pixels touching the background
    lum = a.min(axis=2).astype(float)
    soft = np.clip((255 - lum) / 120.0, 0.25, 1.0)
    alpha = np.where(edge, soft, alpha)
    rgb = a.astype(float)
    with np.errstate(divide="ignore", invalid="ignore"):
        un = (rgb - 255 * (1 - alpha[..., None])) / np.maximum(alpha[..., None], 1e-3)
    rgb = np.where(edge[..., None], np.clip(un, 0, 255), rgb)
    out = np.dstack([rgb, alpha * 255]).astype(np.uint8)
    return out


def keep_main(rgba, keep_decor):
    """Drop decorations (sparkles, zz, motion lines) not attached to the character, unless asked to keep them."""
    solid = rgba[..., 3] > 0
    lab, n = ndimage.label(solid)
    if n <= 1:
        return rgba
    sizes = ndimage.sum(solid, lab, range(1, n + 1))
    main = 1 + int(np.argmax(sizes))
    if keep_decor:
        # keep this cell's own decorations, but drop pieces of the neighbours' that the cell split
        # cut through (anything touching the left/right edge of the cell)
        edge = set(np.unique(lab[:, 0])) | set(np.unique(lab[:, -1]))
        keep = (lab > 0) & ~np.isin(lab, [l for l in edge if l not in (0, main)])
    else:
        keep = lab == main
    out = rgba.copy()
    out[~keep] = 0
    return out


def split_cells(a, bounds):
    return [a[:, x0:x1] for x0, x1 in bounds]


def runs_of(a, min_gap=1):
    fg = ~background_mask(a)
    cols = fg.sum(axis=0) > 2
    runs, start = [], None
    for x, v in enumerate(cols):
        if v and start is None:
            start = x
        if not v and start is not None:
            runs.append((start, x)); start = None
    if start is not None:
        runs.append((start, len(cols)))
    return runs


def sheet(name, bounds, prefix, keep_decor=False):
    a = load(name)
    pieces = []
    for i, (x0, x1) in enumerate(bounds):
        cell = a[:, x0:x1]
        rgba = keep_main(to_rgba(cell, background_mask(cell)), keep_decor)
        ys, xs = np.nonzero(rgba[..., 3] > 0)
        crop = rgba[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        pieces.append(crop)
    # one scale for the whole sheet so relative sizes (growth!) are preserved; bottom-centred
    big = max(max(p.shape[0], p.shape[1]) for p in pieces)
    scale = CANVAS * (1 - 2 * MARGIN) / big
    names = []
    for i, p in enumerate(pieces):
        img = Image.fromarray(p, "RGBA")
        img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
        canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        canvas.paste(img, ((CANVAS - img.width) // 2, CANVAS - round(CANVAS * MARGIN) - img.height), img)
        fn = f"{prefix}-{i}.webp" if isinstance(prefix, str) else f"{prefix[i]}.webp"
        canvas.save(f"{OUT}/{fn}", "WEBP", quality=90, method=6)
        names.append(fn)
    return names


def find_eyes(rgba):
    """The two largest dark, roundish blobs in the upper-middle of the body = the eyes."""
    rgb = rgba[..., :3].astype(int)
    a = rgba[..., 3]
    dark = (rgb.max(axis=2) < 120) & (a > 200)
    h, w = dark.shape
    ys, xs = np.nonzero(a > 0)
    top, bottom = ys.min(), ys.max()
    lab, n = ndimage.label(dark)
    cands = []
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        hh, ww = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        area = (lab[sl] == i).sum()
        cy = (sl[0].start + sl[0].stop) / 2
        # eyes: compact, roughly as tall as wide, in the 30%-80% height band of the sprite
        if hh < (bottom - top) * 0.25 and 0.6 < hh / max(ww, 1) < 1.7 and area > 30 and top + (bottom - top) * 0.3 < cy < top + (bottom - top) * 0.8:
            fill = area / (hh * ww)
            if fill > 0.5:
                cands.append((area, sl))
    cands.sort(key=lambda c: -c[0])
    return [c[1] for c in cands[:2]]


def blink(path_in, path_out):
    img = Image.open(path_in).convert("RGBA")
    rgba = np.array(img)
    eyes = find_eyes(rgba)
    if len(eyes) != 2:
        print("  !! eyes not found in", path_in, len(eyes)); return False
    d = ImageDraw.Draw(img)
    for sl in eyes:
        y0, y1, x0, x1 = sl[0].start, sl[0].stop, sl[1].start, sl[1].stop
        hh, ww = y1 - y0, x1 - x0
        # body colour from just outside the eye
        ring = rgba[max(0, y0 - hh // 2):y1 + hh // 2, max(0, x0 - ww):x1 + ww, :3].reshape(-1, 3)
        ring = ring[(ring.max(axis=1) > 150)]
        col = tuple(int(v) for v in np.median(ring, axis=0)) if len(ring) else (190, 220, 140)
        pad = max(2, hh // 6)
        d.ellipse([x0 - pad, y0 - pad, x1 + pad, y1 + pad], fill=col + (255,))
        # closed eye: a gentle downward arc
        lw = max(3, round(hh * 0.22))
        cy = y0 + hh * 0.55
        d.arc([x0 - pad / 2, cy - hh * 0.35, x1 + pad / 2, cy + hh * 0.35], start=20, end=160, fill=(70, 45, 40, 255), width=lw)
    img.save(path_out, "WEBP", quality=90, method=6)
    return True


if __name__ == "__main__":
    s1 = runs_of(load("1"))
    s2 = runs_of(load("2"))
    print("sheet1", s1, "\nsheet2", s2)
    stages = sheet("1", s1, "stage")
    faces = sheet("2", s2, ["face-idle", "face-happy", "face-sleepy", "face-sad"])
    w = load("3").shape[1]
    # 8 stickers: split where the fewest pixels are, near each 1/8 mark (decorations overlap the marks)
    a3 = load("3")
    colsum = (~background_mask(a3)).sum(axis=0)
    cuts = [0] + [min(range(round(i * w / 8) - 45, round(i * w / 8) + 45), key=lambda x: colsum[x]) for i in range(1, 8)] + [w]
    b3 = [(cuts[i], cuts[i + 1]) for i in range(8)]
    print("sticker cuts", cuts)
    stickers = sheet("3", b3, "sticker", keep_decor=True)
    for fn in stages[1:] + ["face-idle.webp"]:
        ok = blink(f"{OUT}/{fn}", f"{OUT}/{fn.replace('.webp', '-blink.webp')}")
        print("blink", fn, ok)
    total = sum(os.path.getsize(f"{OUT}/{f}") for f in os.listdir(OUT))
    print("files", len(os.listdir(OUT)), "total KB", total // 1024)
