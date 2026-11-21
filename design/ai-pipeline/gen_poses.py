"""Generate 명똑똑 pose candidates with Qwen-Image-Edit from the app's stage sprites.

    python gen_poses.py <motion> <stages e.g. 1,2,3> [seeds e.g. 1,2]

Each stage sprite is cropped, scaled to INPUT_H px tall and placed on a white 1024² canvas standing on
BASELINE, so every pose of a set comes out at the same scale/ground and cut_pose.py can line them up.
Output: E:\\AI\\outputs\\poses\\<motion>\\stage<N>\\p<i>_s<seed>_00001_.png
"""
import os, sys
import numpy as np
from PIL import Image
sys.path.insert(0, r"E:\AI\work")
from comfy import *

REPO = r"C:\Users\soulr\Desktop\Claude\Dating-Planning-Agent"
INPUT_H, BASELINE, SIZE = 640, 880, 1024

KEEP = ("Keep exactly the same character: the same face, eyes, blush, colors, fluffy round body and proportions, the same "
        "leaves or flower on its head and the same accessories it already has (add nothing new). Same flat pastel art style with "
        "thin brown outlines. Full body, plain pure white background, no shadow, no text.")

MOTIONS = {
    "dance": [
        "Make this cute character dance: leaning to the left, both little arms raised up to the left, one foot lifted, happy face",
        "Make this cute character dance: crouching down with knees bent, little arms bent at its sides, cheerful face",
        "Make this cute character dance: leaning to the right, both little arms raised up to the right, one foot lifted, happy face",
        "Make this cute character jump high in the air while dancing, both little arms up, feet off the ground, very happy face",
    ],
    "wave": [
        "Make this cute character wave hello: its right arm raised high with the hand tilted outward, happy smiling face",
        "Make this cute character wave hello: its right arm raised high with the hand tilted inward, happy smiling face",
        "Make this cute character greet cheerfully with both little arms raised up high, big happy smile",
        "Make this cute character wave hello with its right arm raised, eyes closed in a happy smile, body tilted slightly",
    ],
}


def prep(stage):
    im = Image.open(os.path.join(REPO, "images", "character", f"stage-{stage}.webp")).convert("RGBA")
    a = np.array(im); ys, xs = np.nonzero(a[..., 3] > 0)
    im = im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    im = im.resize((round(im.width * INPUT_H / im.height), INPUT_H), Image.LANCZOS)
    cv = Image.new("RGBA", (SIZE, SIZE), (255, 255, 255, 255))
    cv.alpha_composite(im, ((SIZE - im.width) // 2, BASELINE - im.height))
    p = rf"E:\AI\work\poses_in\stage{stage}.png"
    os.makedirs(os.path.dirname(p), exist_ok=True)
    cv.convert("RGB").save(p)
    return upload(p)


if __name__ == "__main__":
    motion = sys.argv[1]
    stages = [int(s) for s in sys.argv[2].split(",")]
    seeds = [int(s) for s in (sys.argv[3] if len(sys.argv) > 3 else "1,2").split(",")]
    log = []
    for st in stages:
        src = prep(st)
        for seed in seeds:
            for i, p in enumerate(MOTIONS[motion]):
                run(qwen_edit([src], f"{p}. {KEEP}", 5000 + 100 * st + seed * 10 + i,
                              f"poses/{motion}/stage{st}/p{i}_s{seed}"), f"{motion} st{st} s{seed} p{i}", log)
        save_log(log, rf"E:\AI\outputs\poses\log_{motion}.json")
    print("POSES DONE", flush=True)
