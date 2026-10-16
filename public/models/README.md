# GeoAgent — ONNX Model Files

This directory holds open-weight ONNX model files for the `local-onnx` provider —
the durable path: no key, no rate limit, no bill.

The `.onnx` files are **gitignored**. Without them, `run_cv_detector` returns a
clear "model file not found" message and no fabricated detections.

---

> ## ⚠️ The three models documented below are GONE upstream (2026-08-10)
>
> All three `keremberke/*` repos now return **HTTP 404 at the HuggingFace repo
> API** — not gated, deleted. The account still exists but retains only
> game/sports/medical YOLOv5 models, none with ONNX exports. The download URLs
> below cannot work and are kept only as a record of what was used.
>
> Replacement weights are held by the project owner on another machine and are
> queued to be installed.
>
> **You do not need this directory to add a model any more.** Register one in
> Settings → Perception Models, or in `GEOAGENT_MODELS`:
>
> ```json
> [{ "id": "my_detector",
>    "provider": "local-onnx",
>    "ref": "/absolute/path/to/best.onnx",
>    "task": "detect",
>    "classes": ["car"],
>    "input_size": 640,
>    "profile": "tiny" }]
> ```
>
> `ref` takes either an absolute local path (no download at all) or an https URL,
> which is fetched once and cached here. Supported heads: Ultralytics YOLOv8/v11
> (`[1, 4+classes, anchors]`) and end-to-end YOLOv10 / RT-DETR (`[1, N, 6]`).
> Anything else is refused by name rather than decoded into invented detections.
>
> A download is validated before it is written: too small, or starting with `<`
> or `{`, is treated as an error page and discarded. A 2-byte `{}` saved as
> `informal_struct.onnx` used to poison every later run with
> "Protobuf parsing failed", and because the download was skipped whenever the
> file existed, it never self-healed.

---

## Models

### `solar_panel.onnx` — Solar panel detection
| Field | Value |
|---|---|
| **Architecture** | YOLOv8n (Ultralytics) |
| **Training data** | Aerial/satellite solar-panel imagery |
| **Classes** | `solar-panel` |
| **Input size** | 640×640 |
| **License** | AGPL-3.0 |
| **Source** | <https://huggingface.co/keremberke/yolov8n-solar-panel-detection> |
| **Download URL** | `https://huggingface.co/keremberke/yolov8n-solar-panel-detection/resolve/main/best.onnx` |
| **Approx size** | ~6 MB |

---

### `informal_struct.onnx` — Informal / unmapped building detection
| Field | Value |
|---|---|
| **Architecture** | YOLOv8n (Ultralytics) |
| **Training data** | Aerial building-footprint imagery |
| **Classes** | `building` |
| **Input size** | 640×640 |
| **License** | AGPL-3.0 |
| **Source** | <https://huggingface.co/keremberke/yolov8n-building-detection> |
| **Download URL** | `https://huggingface.co/keremberke/yolov8n-building-detection/resolve/main/best.onnx` |
| **Approx size** | ~6 MB |

---

### `road_damage.onnx` — Road damage / pothole detection
| Field | Value |
|---|---|
| **Architecture** | YOLOv8n (Ultralytics) |
| **Training data** | Road Damage Detection Challenge 2022 (RDDC2022) aerial imagery |
| **Classes** | `D00` (longitudinal crack), `D10` (transverse crack), `D20` (alligator crack), `D40` (pothole) |
| **Input size** | 640×640 |
| **License** | AGPL-3.0 |
| **Source** | <https://huggingface.co/keremberke/yolov8n-road-damage-detection> |
| **Download URL** | `https://huggingface.co/keremberke/yolov8n-road-damage-detection/resolve/main/best.onnx` |
| **Approx size** | ~6 MB |

---

## Downloading the models

### Option A — Automatic (lazy download, recommended)

The GeoAgent server downloads model files **automatically on the first inference
call** that needs them. Files are saved here and reused on subsequent requests.

> **Note (2026-06-02):** The keremberke HuggingFace repos are now **gated** and return
> HTTP 401 without authentication. You must:
> 1. Create a free HuggingFace account at <https://huggingface.co>
> 2. Go to **Settings → Access Tokens → New token** — choose **Read** scope
> 3. Add `HF_API_TOKEN=hf_...` to your `.env` file
> 4. Visit each model page below and click **"Agree and access repository"**:
>    - <https://huggingface.co/keremberke/yolov8n-solar-panel-detection>
>    - <https://huggingface.co/keremberke/yolov8n-building-detection>
>    - <https://huggingface.co/keremberke/yolov8n-road-damage-detection>
>
> Once that's done, the auto-download on first use will work normally.

If the automatic download still fails, fall back to Option B below.

### Option B — Manual download (with HuggingFace token)

```bash
# Replace hf_YOUR_TOKEN with your actual HuggingFace read token.
# From the GeoAgent project root:

curl -L -H "Authorization: Bearer hf_YOUR_TOKEN" \
     "https://huggingface.co/keremberke/yolov8n-solar-panel-detection/resolve/main/best.onnx" \
     -o public/models/solar_panel.onnx

curl -L -H "Authorization: Bearer hf_YOUR_TOKEN" \
     "https://huggingface.co/keremberke/yolov8n-building-detection/resolve/main/best.onnx" \
     -o public/models/informal_struct.onnx

curl -L -H "Authorization: Bearer hf_YOUR_TOKEN" \
     "https://huggingface.co/keremberke/yolov8n-road-damage-detection/resolve/main/best.onnx" \
     -o public/models/road_damage.onnx
```

### Option C — Bring your own model

The model registry is in `src/app/api/agent/lib/cv-onnx.ts` (`ONNX_MODEL_REGISTRY`).
Each entry maps a slug to a download URL, license, class list, and input size.
To substitute a different ONNX YOLO model:

1. Export your model to ONNX format (Ultralytics: `yolo export model=best.pt format=onnx`).
2. Place the `.onnx` file here as `<slug>.onnx`.
3. Update the `ONNX_MODEL_REGISTRY` entry for that slug with the correct class names and license.

---

## License notes

All bundled models use AGPL-3.0 (Ultralytics YOLOv8). This is a copyleft license —
if you distribute a modified version of GeoAgent that bundles these weights, you
must release your source under AGPL-3.0 or a compatible license. For internal /
private use, the license imposes no restrictions.

If you require a more permissive license, substitute models trained under Apache-2.0,
MIT, or CC-BY-4.0 and update the registry entries accordingly.

---

## Performance notes

- These models are trained on aerial/satellite imagery and perform well at zoom
  levels 17–18 (≈0.6–1.2 m/px). Performance degrades at lower zoom levels.
- `road_damage` was trained on street-level imagery in some benchmark splits;
  performance on pure overhead satellite tiles varies — verify on a known
  damaged corridor before relying on counts.
- The models are YOLOv8**n** (nano) — optimized for CPU inference at the cost
  of some accuracy vs. larger variants. Substitute a `yolov8s` or `yolov8m`
  export for higher accuracy if latency is acceptable.
