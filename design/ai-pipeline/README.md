# AURA 이미지 생성 파이프라인 (로컬 AI)

AURA의 명똑똑 포즈(춤·손 흔들기)와 사진 꾸미기 스티커(소주병)를 만든 방법을 정리한 문서예요.
다른 PC에 같은 환경을 다시 만들 때 이 순서대로 하면 돼요.

모든 생성은 **집 PC의 ComfyUI**에서 돌고, 사진이나 그림은 외부 서버로 나가지 않아요. 비용은 전기 말고 없어요.

---

## 1. 기준 PC 사양 (2026-11 기준)

| 항목 | 값 |
|---|---|
| OS | Windows 10 Pro |
| 그래픽카드 | NVIDIA GeForce RTX 4080 (그래픽 메모리 16GB) |
| ComfyUI | git 커밋 `5071348` (2026-11-17), 프론트엔드 패키지 1.59.4 |
| Python | 3.12.10 (ComfyUI 전용 venv) |
| PyTorch | 2.14.1 + CUDA 12.6 (`cu126`) |
| 사용자 정의 노드 | 없음 (ComfyUI 기본 노드만 사용) |

- ComfyUI가 시작할 때 "PyTorch CUDA 13.0 미만이라 성능이 나쁠 수 있다"는 경고를 띄워요. 새 PC에서는 **CUDA 13.0 이상 빌드(`cu130`)** 의 PyTorch를 설치하는 게 좋아요. 그래픽 드라이버도 그에 맞게 최신으로 올려요.
- 그래픽 메모리가 16GB보다 작으면 Qwen 모델(약 20GB)이 더 많이 나뉘어 돌아서 느려져요. 12GB 이하라면 GGUF 같은 더 작은 양자화 모델을 찾아야 해요.

## 2. 폴더 구조

```
E:\AI\
├─ ComfyUI\                 ComfyUI 본체 (git clone) + venv\
│   └─ extra_model_paths.yaml   모델 폴더를 E:\AI\models 로 연결
├─ models\                  모델 파일 (아래 3번)
│   ├─ diffusion_models\
│   ├─ text_encoders\
│   ├─ vae\
│   └─ loras\
├─ work\                    생성 스크립트 (이 폴더의 comfy.py, gen_poses.py 등을 복사)
└─ outputs\                 생성 결과 (ComfyUI --output-directory)
```

모델을 ComfyUI 폴더 밖(`E:\AI\models`)에 두면 ComfyUI를 새로 설치하거나 업데이트해도 모델을 다시 받을 필요가 없어요.
이 폴더의 [`extra_model_paths.yaml`](extra_model_paths.yaml)을 ComfyUI 폴더에 넣으면 연결돼요. 드라이브가 다르면 `base_path`만 고쳐요.

## 3. 모델 파일

모두 ComfyUI용으로 다시 포장된 파일이에요. Hugging Face에서 **파일 이름으로 검색**하면 받을 수 있어요(대부분 `Comfy-Org` 계정의 `*_ComfyUI` 저장소).

| 폴더 | 파일 | 크기 | 쓰는 곳 |
|---|---|---|---|
| diffusion_models | `qwen_image_2512_fp8_e4m3fn.safetensors` | 20.4GB | **Qwen-Image**: 글로 새 그림 그리기 (소주 스티커) |
| diffusion_models | `qwen_image_edit_2511_fp8mixed.safetensors` | 20.5GB | **Qwen-Image-Edit**: 기존 그림을 고쳐 그리기 (명똑똑 포즈) |
| loras | `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | 0.85GB | Edit을 4단계 만에 끝내는 가속 LoRA (lightx2v 배포) |
| text_encoders | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | 9.4GB | Qwen-Image / Edit 공용 글 이해 모델 |
| vae | `qwen_image_vae.safetensors` | 0.25GB | Qwen-Image / Edit 공용 |
| diffusion_models | `flux1-dev-kontext_fp8_scaled.safetensors` | 11.9GB | FLUX.1 Kontext (비교 시험용) |
| text_encoders | `clip_l.safetensors`, `t5xxl_fp8_e4m3fn_scaled.safetensors` | 0.25GB, 5.2GB | FLUX용 |
| vae | `ae.safetensors` | 0.34GB | FLUX용 |
| diffusion_models | `wan2.2_ti2v_5B_fp16.safetensors` | 10.0GB | Wan 2.2: 그림 → 짧은 영상 (시험용) |
| text_encoders | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | 6.7GB | Wan용 |
| vae | `wan2.2_vae.safetensors` | 1.4GB | Wan용 |

- **최소 구성**(AURA에 실제로 쓴 것만): Qwen-Image, Qwen-Image-Edit, Lightning LoRA, Qwen 글 이해 모델, Qwen VAE. 합쳐서 약 51GB예요.
- **라이선스**: Qwen-Image 계열과 Wan 2.2는 Apache 2.0이에요. **FLUX.1 Kontext [dev]는 비상업 라이선스**라 앱에 들어가는 그림에는 쓰지 않았어요.

## 4. ComfyUI 설치와 실행

```bash
git clone https://github.com/comfyanonymous/ComfyUI E:/AI/ComfyUI
cd E:/AI/ComfyUI
python -m venv venv
./venv/Scripts/python.exe -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130
./venv/Scripts/python.exe -m pip install -r requirements.txt
./venv/Scripts/python.exe -m pip install requests numpy pillow scipy
```

- PyTorch 주소의 `cu130`은 설치할 때 [pytorch.org](https://pytorch.org/get-started/locally/)에서 지금 맞는 버전을 확인해요.
- 마지막 줄은 생성·후처리 스크립트가 쓰는 패키지예요.

실행 (AURA 스크립트는 이 주소와 출력 폴더를 기준으로 짜여 있어요):

```bash
cd E:/AI/ComfyUI && ./venv/Scripts/python.exe main.py --listen 127.0.0.1 --port 8188 --output-directory "E:/AI/outputs" --disable-auto-launch
```

- `127.0.0.1`로만 열어서 같은 PC 밖에서는 접속할 수 없어요.
- 켜 두는 동안 그래픽 메모리를 14~15GB 차지해요. 다 쓰면 꺼요.
- 확인: 브라우저에서 `http://127.0.0.1:8188` 이 열리면 정상이에요.

## 5. 스크립트

| 파일 | 하는 일 |
|---|---|
| [`comfy.py`](comfy.py) | ComfyUI API 드라이버. 워크플로를 코드로 만들고(`qwen_t2i`, `qwen_edit`, `flux_kontext`, `wan_video`), 큐에 넣고, 끝날 때까지 기다리고, 걸린 시간과 그래픽 메모리 최고치를 기록해요 |
| [`gen_poses.py`](gen_poses.py) | 명똑똑 단계 그림을 넣어 포즈 후보를 만들어요 (Qwen-Image-Edit) |
| [`postprocess.py`](postprocess.py) | 후보의 배경을 따고 움직이는 미리보기와 비교 페이지를 만들어요 |
| [`../stickers/gen_soju.py`](../stickers/gen_soju.py) | 소주 스티커 후보 6장 (Qwen-Image, 글 → 그림) |
| [`../character-src/cut.py`](../character-src/cut.py) | 흰 배경 따기(`background_mask`, `to_rgba`, `keep_main`). 모든 후처리가 이걸 써요 |
| [`../character-src/cut_pose.py`](../character-src/cut_pose.py) | 포즈 후보를 앱 스프라이트 크기·바닥선·색에 맞춰 잘라 `images/character/`에 저장 |

**다른 PC에서 고칠 곳**: 스크립트 안의 경로가 이 PC 기준으로 박혀 있어요. 아래를 새 PC 경로로 바꿔요.
- `comfy.py`: `OUT = r"E:\AI\outputs"`
- `gen_poses.py`: `REPO = r"C:\Users\...\Dating-Planning-Agent"`, `E:\AI\work\poses_in`, `E:\AI\outputs\poses`
- `postprocess.py`: `sys.path`의 저장소 경로
- 각 스크립트의 `sys.path.insert(0, r"E:\AI\work")`

스크립트는 ComfyUI venv의 Python으로 실행해요: `E:/AI/ComfyUI/venv/Scripts/python.exe -u gen_soju.py`

## 6. 방법론

### 6-1. 글로 새 그림 그리기: Qwen-Image (`qwen_t2i`)

소주 스티커처럼 **참고 그림 없이 새로 그릴 때** 써요.

- 설정: 1024×1024, 30단계, cfg 4.0, euler/simple, `ModelSamplingAuraFlow` shift 3.1, 부정 문구는 `comfy.py`의 `QWEN_NEG`
- 속도: 장당 약 80~155초 (첫 장은 모델을 올리느라 가장 느려요)
- 문구 요령:
  - 그림체를 먼저 정해요 ("Apple emoji style", "kawaii sticker illustration, bold rounded outlines, flat pastel colors")
  - **"isolated on a plain pure white background"** 를 꼭 넣어요. 흰 배경이어야 6-3의 배경 따기가 깔끔해요
  - **"no text, no letters, no logo, no brand"** 로 글자와 상표를 막아요 (실제 상표가 그려지지 않게)
  - 같은 문구에 시드만 바꿔 3개씩 뽑고, 문구 방향을 2가지로 나눠 비교해요 (소주: 사실적 a안 / 귀여운 b안)

### 6-2. 기존 그림을 고쳐 그리기: Qwen-Image-Edit + Lightning LoRA (`qwen_edit`)

명똑똑처럼 **같은 캐릭터를 유지한 채 동작만 바꿀 때** 써요. 시험한 방법 중 캐릭터가 가장 잘 유지됐어요.

- 설정: 4단계, cfg 1.0, Lightning LoRA 강도 1.0, `CFGNorm`, 입력 그림 약 1메가픽셀, `TextEncodeQwenImageEditPlus` + `FluxKontextMultiReferenceLatentMethod (index_timestep_zero)`
- 속도: 장당 약 20~55초
- 입력 준비 (`gen_poses.py`의 `prep`): 단계 스프라이트를 잘라 **640px 높이**로 맞추고, 흰 1024² 캔버스의 **같은 바닥선(880px)** 에 세워요. 모든 포즈가 같은 크기·같은 바닥에서 나와야 나중에 프레임을 이어 붙였을 때 흔들리지 않아요.
- 문구 = 동작 설명 + 고정 문구 `KEEP`:
  - 동작: "Make this cute character wave hello: its right arm raised high…"처럼 한 동작씩
  - `KEEP`: 같은 얼굴·색·체형·머리 장식 유지, 새 장식 추가 금지, 같은 그림체, 전신, 흰 배경, 그림자·글자 없음
- 동작마다 프레임 4장 × 시드 2개를 뽑고 좋은 것을 골라요.

### 6-3. 배경 따기와 앱용 후처리

- `cut.background_mask`: 그림 테두리에서 이어진 밝은 픽셀(모든 채널 > 200)만 배경으로 봐요. 캐릭터 외곽선이 경계 역할을 해서 안쪽의 흰색(눈 하이라이트 등)은 지워지지 않아요.
- `cut.to_rgba`: 경계 1px을 흰색에서 풀어내 부드러운 가장자리를 만들어요.
- `cut.keep_main`: 떨어져 있는 조각(반짝이 등)을 지워요. 스티커처럼 장식을 살릴 때는 쓰지 않아요.
- 스티커: 투명 부분을 잘라내고 6% 여백을 둔 정사각형으로 맞춰 **256px WebP(품질 92)** 로 저장해요 (소주병 약 20KB).
- 포즈: `cut_pose.py`가 단계 그림과 같은 키·바닥선으로 맞추고, 단계 색으로 초록을 보정해서 `images/character/<동작>-<단계>-<번호>.webp`로 저장해요.
- **비교 시트로 고르기**: 후보를 흰색·분홍(#FBEAF0)·어두운 바탕(#282026) 위에 나란히 놓고 봐요. 흰 그림자나 흰 테두리가 남은 후보는 어두운 바탕에서 바로 드러나요.

### 6-4. 시험만 해 본 것

- **FLUX.1 Kontext**: 캐릭터 유지가 Qwen-Edit보다 약했고, 비상업 라이선스라 앱에는 쓰지 않았어요.
- **Wan 2.2 (5B)**: 그림 한 장에서 짧은 영상을 만들어요. 704², 49프레임에 몇 분이 걸려요. 진화 연출 같은 특별한 순간에만 쓸 후보예요.

## 7. 그래픽 메모리와 속도 메모

- Qwen 모델 파일은 약 20GB라 16GB 카드에 한 번에 다 올라가지 않아요. ComfyUI가 필요한 부분만 그래픽 메모리에 올리고 나머지는 일반 메모리와 번갈아 옮겨요(로그의 "dynamic VRAM loading"). 그래서 최고 사용량이 약 15GB였어요.
- 일반 메모리(RAM)도 넉넉해야 해요. 32GB 이상을 권해요.
- 첫 생성은 모델을 올리느라 느리고, 같은 모델을 이어서 쓰면 빨라져요. Qwen-Image와 Qwen-Image-Edit을 번갈아 쓰면 매번 다시 올려서 느려지니, 한 종류씩 몰아서 돌려요.

## 8. 새 PC 점검 순서

1. 4번대로 ComfyUI를 설치하고, 3번의 최소 구성 모델을 `models\` 아래에 넣어요.
2. `extra_model_paths.yaml`을 ComfyUI 폴더에 넣고 `base_path`를 확인해요.
3. ComfyUI를 켜고 `http://127.0.0.1:8188` 이 열리는지 봐요.
4. 이 폴더의 스크립트를 `work\`로 복사하고 5번의 경로를 고쳐요.
5. `gen_soju.py`를 돌려 `outputs\soju\`에 6장이 나오면 Qwen-Image가 정상이에요.
6. `gen_poses.py wave 4 1`을 돌려 `outputs\poses\wave\stage4\`에 4장이 나오면 Qwen-Image-Edit이 정상이에요.
