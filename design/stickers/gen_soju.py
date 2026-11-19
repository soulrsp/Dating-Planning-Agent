"""Soju-bottle sticker candidates for AURA's photo studio (Qwen-Image text-to-image)."""
import sys, time, requests
sys.path.insert(0, r"E:\AI\work")
from comfy import qwen_t2i, run, save_log, API

PROMPTS = {
    "a": ("A single cute emoji icon in Apple emoji style: a green glass Korean soju bottle with a blank white label "
          "and a small clear shot glass filled with soju beside it, glossy highlights, soft shading, centered, "
          "isolated on a plain pure white background, no text, no letters, no logo."),
    "b": ("Kawaii sticker illustration: a small green soju bottle and a tiny shot glass clinking together, little "
          "sparkles, bold rounded outlines, flat pastel colors, emoji style, centered on a plain pure white background, "
          "no text, no letters, no logo, no brand."),
}
SEEDS = [11, 42, 77]

for _ in range(120):
    try:
        requests.get(f"{API}/system_stats", timeout=2); break
    except Exception:
        time.sleep(2)

log = []
for key, prompt in PROMPTS.items():
    for seed in SEEDS:
        run(qwen_t2i(prompt, seed, f"soju/{key}_{seed}", width=1024, height=1024, steps=30), f"soju {key} {seed}", log)
save_log(log, r"E:\AI\work\soju.log")
