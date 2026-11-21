"""Tiny ComfyUI API driver: build workflows for the installed models, queue them, wait, time them and
record peak VRAM. Run with ComfyUI's venv python (has requests)."""
import json, os, subprocess, threading, time, uuid
import requests

API = "http://127.0.0.1:8188"
OUT = r"E:\AI\outputs"
CID = str(uuid.uuid4())
WAN_NEG = ("色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，"
           "多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走")
QWEN_NEG = "低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲"


def upload(path):
    # Unique per source path: generated files share basenames (f01_00001_.png) across folders.
    parent = os.path.basename(os.path.dirname(path))
    name = f"{parent}__{os.path.basename(path)}"
    with open(path, "rb") as f:
        r = requests.post(f"{API}/upload/image", files={"image": (name, f, "image/png")}, data={"overwrite": "true"})
    r.raise_for_status()
    return r.json()["name"]


class VramWatch:
    def __init__(self): self.peak = 0; self._stop = False
    def _run(self):
        while not self._stop:
            try:
                out = subprocess.check_output(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], text=True)
                self.peak = max(self.peak, int(out.strip().splitlines()[0]))
            except Exception:
                pass
            time.sleep(1)
    def __enter__(self): self.t = threading.Thread(target=self._run, daemon=True); self.t.start(); return self
    def __exit__(self, *a): self._stop = True; self.t.join(2)


def run(graph, label, log):
    t0 = time.time()
    with VramWatch() as vw:
        r = requests.post(f"{API}/prompt", json={"prompt": graph, "client_id": CID})
        if r.status_code != 200:
            raise RuntimeError(f"{label}: {r.status_code} {r.text[:800]}")
        pid = r.json()["prompt_id"]
        while True:
            h = requests.get(f"{API}/history/{pid}").json()
            if pid in h:
                st = h[pid].get("status", {})
                if st.get("status_str") == "error":
                    raise RuntimeError(f"{label}: {json.dumps(st)[:1500]}")
                if st.get("completed"):
                    break
            time.sleep(1)
    files = []
    for node_out in h[pid]["outputs"].values():
        for key in ("images", "gifs", "videos", "animated"):
            for im in node_out.get(key, []) if isinstance(node_out.get(key), list) else []:
                if isinstance(im, dict) and im.get("filename"):
                    files.append(os.path.join(OUT, im.get("subfolder", ""), im["filename"]))
    rec = {"label": label, "sec": round(time.time() - t0, 1), "vram_peak_mb": vw.peak, "files": files}
    log.append(rec)
    print(json.dumps(rec, ensure_ascii=False), flush=True)
    return rec


# ── workflow builders (settings follow ComfyUI's official templates) ─────────────────────────────
def qwen_edit(images, prompt, seed, prefix, mp=1.0, steps=4, cfg=1.0):
    g = {
        "unet": {"class_type": "UNETLoader", "inputs": {"unet_name": "qwen_image_edit_2511_fp8mixed.safetensors", "weight_dtype": "default"}},
        "lora": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["unet", 0], "lora_name": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", "strength_model": 1.0}},
        "ms": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["lora", 0], "shift": 3.1}},
        "cfgn": {"class_type": "CFGNorm", "inputs": {"model": ["ms", 0], "strength": 1.0}},
        "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image", "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
    }
    enc_imgs = {}
    for i, name in enumerate(images, 1):
        g[f"img{i}"] = {"class_type": "LoadImage", "inputs": {"image": name}}
        g[f"sc{i}"] = {"class_type": "ImageScaleToTotalPixels", "inputs": {"image": [f"img{i}", 0], "upscale_method": "lanczos", "megapixels": mp, "resolution_steps": 1}}
        enc_imgs[f"image{i}"] = [f"sc{i}", 0]
    g["pos"] = {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["clip", 0], "prompt": prompt, "vae": ["vae", 0], **enc_imgs}}
    g["neg"] = {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["clip", 0], "prompt": "", "vae": ["vae", 0], **enc_imgs}}
    g["posm"] = {"class_type": "FluxKontextMultiReferenceLatentMethod", "inputs": {"conditioning": ["pos", 0], "reference_latents_method": "index_timestep_zero"}}
    g["negm"] = {"class_type": "FluxKontextMultiReferenceLatentMethod", "inputs": {"conditioning": ["neg", 0], "reference_latents_method": "index_timestep_zero"}}
    g["lat"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["sc1", 0], "vae": ["vae", 0]}}
    g["ks"] = {"class_type": "KSampler", "inputs": {"model": ["cfgn", 0], "seed": seed, "steps": steps, "cfg": cfg, "sampler_name": "euler", "scheduler": "simple",
                                                    "positive": ["posm", 0], "negative": ["negm", 0], "latent_image": ["lat", 0], "denoise": 1.0}}
    g["dec"] = {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vae", 0]}}
    g["save"] = {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": prefix}}
    return g


def flux_kontext(image, prompt, seed, prefix, steps=20, guidance=2.5):
    return {
        "unet": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev-kontext_fp8_scaled.safetensors", "weight_dtype": "default"}},
        "clip": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": "clip_l.safetensors", "clip_name2": "t5xxl_fp8_e4m3fn_scaled.safetensors", "type": "flux", "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
        "img": {"class_type": "LoadImage", "inputs": {"image": image}},
        "sc": {"class_type": "FluxKontextImageScale", "inputs": {"image": ["img", 0]}},
        "lat": {"class_type": "VAEEncode", "inputs": {"pixels": ["sc", 0], "vae": ["vae", 0]}},
        "txt": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": prompt}},
        "ref": {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["txt", 0], "latent": ["lat", 0]}},
        "fg": {"class_type": "FluxGuidance", "inputs": {"conditioning": ["ref", 0], "guidance": guidance}},
        "neg": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["txt", 0]}},
        "ks": {"class_type": "KSampler", "inputs": {"model": ["unet", 0], "seed": seed, "steps": steps, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple",
                                                   "positive": ["fg", 0], "negative": ["neg", 0], "latent_image": ["lat", 0], "denoise": 1.0}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vae", 0]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": prefix}},
    }


def wan_video(prompt, seed, prefix, start_image=None, width=704, height=704, length=49, steps=20, cfg=5.0, fps=24):
    g = {
        "unet": {"class_type": "UNETLoader", "inputs": {"unet_name": "wan2.2_ti2v_5B_fp16.safetensors", "weight_dtype": "default"}},
        "ms": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["unet", 0], "shift": 8.0}},
        "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan", "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "wan2.2_vae.safetensors"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": prompt}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": WAN_NEG}},
        "lat": {"class_type": "Wan22ImageToVideoLatent", "inputs": {"vae": ["vae", 0], "width": width, "height": height, "length": length, "batch_size": 1}},
        "ks": {"class_type": "KSampler", "inputs": {"model": ["ms", 0], "seed": seed, "steps": steps, "cfg": cfg, "sampler_name": "uni_pc", "scheduler": "simple",
                                                   "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["lat", 0], "denoise": 1.0}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vae", 0]}},
        "frames": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": prefix + "/frame"}},
        "vid": {"class_type": "CreateVideo", "inputs": {"images": ["dec", 0], "fps": float(fps)}},
        "savev": {"class_type": "SaveVideo", "inputs": {"video": ["vid", 0], "filename_prefix": prefix + "/clip", "format": "auto", "codec": "auto"}},
    }
    if start_image:
        g["img"] = {"class_type": "LoadImage", "inputs": {"image": start_image}}
        g["lat"]["inputs"]["start_image"] = ["img", 0]
    return g


def qwen_t2i(prompt, seed, prefix, width=1328, height=1328, steps=40, cfg=4.0, neg=QWEN_NEG):
    return {
        "unet": {"class_type": "UNETLoader", "inputs": {"unet_name": "qwen_image_2512_fp8_e4m3fn.safetensors", "weight_dtype": "default"}},
        "ms": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["unet", 0], "shift": 3.1}},
        "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image", "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": prompt}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": neg}},
        "lat": {"class_type": "EmptySD3LatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "ks": {"class_type": "KSampler", "inputs": {"model": ["ms", 0], "seed": seed, "steps": steps, "cfg": cfg, "sampler_name": "euler", "scheduler": "simple",
                                                   "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["lat", 0], "denoise": 1.0}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vae", 0]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": prefix}},
    }


def save_log(log, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(log, f, ensure_ascii=False, indent=1)
