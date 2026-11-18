"""Cut single-pose images (Qwen-Image-Edit output of E:\\AI\\work\\gen_poses.py) into sprites that line up
with the stage sprites made by cut.py.

    python cut_pose.py <out-dir> <motion> <stage> <pose0.png> <pose1.png> ...
    e.g. python cut_pose.py ../../images/character wave 4 a.png b.png c.png d.png

Run it from this folder. gen_poses.py draws every input at the same scale (INPUT_H px tall) standing on
the same baseline, so:
- size: every pose is scaled by stage-height / INPUT_H (one scale for the set; a crouch stays shorter,
  raised arms stay taller);
- position: centred, standing on the stage sprite's baseline; a pose that ends higher than the others
  (a jump) keeps that lift;
- colour: same clean-up as cut_dance.py (body greens pulled to the stage sprite, stray mint scarf on the
  young stages and beige feet repainted).
Writes <motion>-<stage>-<i>.webp at cut.CANVAS size, and keeps a small copy of each source in
poses/<motion>-<stage>-<i>.webp.
"""
import os
import sys

import numpy as np
from PIL import Image

import cut
from cut_dance import body_hsv, fix_colors

INPUT_H = 640   # gen_poses.py


def cut_set(out_dir, motion, stage, sources):
    stage_img = np.array(Image.open(f"{out_dir}/stage-{stage}.webp").convert("RGBA"))
    sy, _ = np.nonzero(stage_img[..., 3] > 0)
    stage_h, stage_base = sy.max() - sy.min() + 1, sy.max()
    target = body_hsv(stage_img)
    pieces = []
    for src in sources:
        a = np.asarray(Image.open(src).convert("RGB")).astype(np.int16)
        rgba = cut.keep_main(cut.to_rgba(a, cut.background_mask(a)), False)
        ys, xs = np.nonzero(rgba[..., 3] > 0)
        pieces.append((rgba[ys.min():ys.max() + 1, xs.min():xs.max() + 1], ys.max()))
    scale = stage_h / INPUT_H
    ground = max(b for _, b in pieces)
    os.makedirs("poses", exist_ok=True)
    names = []
    for i, ((p, bottom), src) in enumerate(zip(pieces, sources)):
        p = fix_colors(p, stage, target)
        img = Image.fromarray(p, "RGBA")
        img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
        if img.width > cut.CANVAS or img.height > cut.CANVAS:
            img.thumbnail((cut.CANVAS, cut.CANVAS), Image.LANCZOS)
        lift = round((ground - bottom) * scale)
        canvas = Image.new("RGBA", (cut.CANVAS, cut.CANVAS), (0, 0, 0, 0))
        y = max(0, stage_base + 1 - img.height - lift)
        canvas.paste(img, ((cut.CANVAS - img.width) // 2, y), img)
        fn = f"{motion}-{stage}-{i}.webp"
        canvas.save(f"{out_dir}/{fn}", "WEBP", quality=88, method=6)
        Image.open(src).convert("RGB").resize((512, 512), Image.LANCZOS).save(f"poses/{fn}", "WEBP", quality=85)
        names.append(fn)
    return names


if __name__ == "__main__":
    out, motion, stage = sys.argv[1], sys.argv[2], int(sys.argv[3])
    names = cut_set(out, motion, stage, sys.argv[4:])
    kb = sum(os.path.getsize(f"{out}/{n}") for n in names) // 1024
    print(f"{motion} stage {stage}: {', '.join(names)} ({kb} KB)")
