"""Cut the ChatGPT dance sheets (dance-<stage>.webp, 4 poses each) into sprites that line up with
the stage sprites made by cut.py.

    python cut_dance.py <out-dir> [stage ...]      # e.g. python cut_dance.py ../../images/character 1 2 4

Run it from this folder. For each stage:
- size: the sheet is scaled so the crouch pose (pose 2, the least stretched) is as tall as
  stage-<n>.webp, and all four share that scale;
- position: centred, standing on the stage sprite's baseline; a pose drawn higher on the sheet (the
  jump) keeps that lift;
- colour: ChatGPT draws these a little paler, so the body greens are pulled to the stage sprite's
  saturation/brightness. Stray mint (a scarf the young stages shouldn't have) is repainted in body
  green, and so is a beige foot in the lower half (never the crown/flower up top).
Output: dance-<n>-0..3.webp at cut.CANVAS size.
"""
import colorsys
import os
import sys

import numpy as np
from PIL import Image

import cut

cut.SRC = "."
SCARF_STAGES = {1, 2, 3}       # stages drawn without the mint scarf


def hsv_arrays(rgb):
    f = rgb.astype(float) / 255.0
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    mx, mn = f.max(-1), f.min(-1)
    d = mx - mn
    h = np.zeros_like(mx)
    m = d > 1e-6
    rr, gg, bb = (mx == r) & m, (mx == g) & m & ~(mx == r), m & ~(mx == r) & ~(mx == g)
    h[rr] = ((g - b)[rr] / d[rr]) % 6
    h[gg] = (b - r)[gg] / d[gg] + 2
    h[bb] = (r - g)[bb] / d[bb] + 4
    h *= 60
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    return h, s, mx


def hsv_to_rgb(h, s, v):
    h = (h % 360) / 60.0
    i = np.floor(h).astype(int) % 6
    f = h - np.floor(h)
    p, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
    out = np.zeros(h.shape + (3,))
    for k, (a, b, c) in enumerate([(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)]):
        sel = i == k
        out[sel] = np.stack([a[sel], b[sel], c[sel]], -1)
    return np.clip(out * 255, 0, 255)


def body_hsv(rgba):
    """Median HSV of the body green (light, clearly green, opaque)."""
    h, s, v = hsv_arrays(rgba[..., :3])
    sel = (rgba[..., 3] > 250) & (h > 60) & (h < 95) & (s > 0.18) & (v > 0.8)
    return float(np.median(h[sel])), float(np.median(s[sel])), float(np.median(v[sel]))


def fix_colors(rgba, stage, target):
    rgb = rgba[..., :3].astype(float)
    a = rgba[..., 3]
    h, s, v = hsv_arrays(rgb)
    opaque = a > 0
    th, ts, tv = target
    _, ds, dv = body_hsv(rgba)
    ys = np.nonzero(opaque)[0]
    top, bottom = ys.min(), ys.max()
    rows = np.arange(rgba.shape[0])[:, None]
    nh, ns, nv = h.copy(), s.copy(), v.copy()
    # 1. stray mint scarf on a stage without one → body green (outline → body outline brown-ish)
    if stage in SCARF_STAGES:
        # the scarf sits below the leaves, so only look under the top 30% (leaves are a similar green)
        mint = opaque & (rows > top + (bottom - top) * 0.3) & (h > 100) & (h < 200) & (s > 0.06)
        light = mint & (v > 0.55)
        nh[light], ns[light], nv[light] = th, ts, tv
        dark = mint & ~light
        nh[dark], ns[dark] = 30, 0.45
    # 2. beige foot in the lower half → body green
    low = rows > top + (bottom - top) * 0.55
    beige = opaque & low & (h > 18) & (h < 55) & (s > 0.12) & (s < 0.6) & (v > 0.7)
    nh[beige], ns[beige], nv[beige] = th, ts, tv
    # 3. pull the body greens to the stage sprite's saturation / brightness
    green = opaque & (nh > 55) & (nh < 110) & ~beige
    if ds > 0:
        ns[green] = np.clip(ns[green] * (ts / ds), 0, 1)
        nv[green] = np.clip(nv[green] * (tv / dv), 0, 1)
    out = rgba.copy()
    changed = opaque & ((nh != h) | (ns != s) | (nv != v))
    out[..., :3][changed] = hsv_to_rgb(nh, ns, nv)[changed].astype(np.uint8)
    return out


def dance(stage, out_dir):
    stage_img = np.array(Image.open(f"{out_dir}/stage-{stage}.webp").convert("RGBA"))
    sy, sx = np.nonzero(stage_img[..., 3] > 0)
    stage_h, stage_base = sy.max() - sy.min() + 1, sy.max()
    target = body_hsv(stage_img)

    a = cut.load(f"dance-{stage}")
    runs = cut.runs_of(a)
    if len(runs) != 4:
        raise SystemExit(f"dance-{stage}: expected 4 poses, found {len(runs)} {runs}")
    pieces = []
    for x0, x1 in runs:
        cell = a[:, x0:x1]
        rgba = cut.keep_main(cut.to_rgba(cell, cut.background_mask(cell)), False)
        ys, xs = np.nonzero(rgba[..., 3] > 0)
        pieces.append((rgba[ys.min():ys.max() + 1, xs.min():xs.max() + 1], ys.max()))
    scale = stage_h / pieces[1][0].shape[0]
    sheet_base = max(b for _, b in pieces)
    names = []
    for i, (p, bottom) in enumerate(pieces):
        p = fix_colors(p, stage, target)
        img = Image.fromarray(p, "RGBA")
        img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
        lift = round((sheet_base - bottom) * scale)
        canvas = Image.new("RGBA", (cut.CANVAS, cut.CANVAS), (0, 0, 0, 0))
        y = max(0, stage_base + 1 - img.height - lift)
        canvas.paste(img, ((cut.CANVAS - img.width) // 2, y), img)
        fn = f"dance-{stage}-{i}.webp"
        canvas.save(f"{out_dir}/{fn}", "WEBP", quality=88, method=6)
        names.append(fn)
    return names


if __name__ == "__main__":
    out = sys.argv[1]
    stages = [int(x) for x in sys.argv[2:]] or [1, 2, 3, 4, 5]
    for st in stages:
        names = dance(st, out)
        kb = sum(os.path.getsize(f"{out}/{n}") for n in names) // 1024
        print(f"stage {st}: {', '.join(names)} ({kb} KB)")
