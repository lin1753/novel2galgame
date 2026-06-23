"""
Download Qwen3-8B SFT models from ModelScope (faster in China) or HuggingFace.

Usage:
    pip install modelscope huggingface_hub
    python scripts/download-models.py

Models are saved to <project>/model/ (configurable via MODEL_DIR env var).
"""

import os
import sys

MODEL_DIR = os.environ.get("MODEL_DIR", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "model"))

MODELS = [
    {
        "modelscope_id": "mikuhhn1239/qwen3-8b-novel-base-sft",
        "huggingface_id": "mikuhhn1239/qwen3-8b-novel-base-sft",
        "local_name": "qwen3-8b-novel-base-sft",
        "desc": "Stage 1 base SFT (16GB)",
    },
    {
        "modelscope_id": "mikuhhn1239/qwen3-8b-narrative-type-lora",
        "huggingface_id": "mikuhhn1239/qwen3-8b-narrative-type-lora",
        "local_name": "qwen3-8b-narrative-type-lora",
        "desc": "Agent 1: narrative type classification LoRA (682MB)",
    },
    {
        "modelscope_id": "mikuhhn1239/qwen3-8b-scene-boundary-lora",
        "huggingface_id": "mikuhhn1239/qwen3-8b-scene-boundary-lora",
        "local_name": "qwen3-8b-scene-boundary-lora",
        "desc": "Agent 2: scene boundary detection LoRA (682MB)",
    },
    {
        "modelscope_id": "mikuhhn1239/qwen3-8b-attribution-best-lora",
        "huggingface_id": "mikuhhn1239/qwen3-8b-attribution-best-lora",
        "local_name": "qwen3-8b-attribution-best-lora",
        "desc": "Agent 3: attribution best candidate LoRA (682MB)",
    },
]


def download_with_modelscope(m):
    from modelscope import snapshot_download
    local_dir = os.path.join(MODEL_DIR, m["local_name"])
    print(f"  Using ModelScope: {m['modelscope_id']}")
    snapshot_download(m["modelscope_id"], cache_dir=MODEL_DIR, local_dir=local_dir)
    return local_dir


def download_with_huggingface(m):
    from huggingface_hub import snapshot_download
    local_dir = os.path.join(MODEL_DIR, m["local_name"])
    print(f"  Using HuggingFace: {m['huggingface_id']}")
    snapshot_download(repo_id=m["huggingface_id"], local_dir=local_dir)
    return local_dir


def download_all():
    os.makedirs(MODEL_DIR, exist_ok=True)

    # Try ModelScope first (faster in China), fall back to HuggingFace
    try:
        import modelscope
        downloader = download_with_modelscope
        print("Using ModelScope (China mirror)")
    except ImportError:
        downloader = download_with_huggingface
        print("Using HuggingFace (modelscope not installed)")

    for m in MODELS:
        print(f"\n{'='*60}")
        print(f"Downloading: {m['desc']}")
        print(f"{'='*60}")
        local_dir = downloader(m)
        print(f"  Done: {local_dir}")

    print(f"\nAll models downloaded to {MODEL_DIR}")
    print("\nNext steps:")
    print(f"  1. Import to ollama:  ollama create qwen3-8b-sft -f scripts/Modelfile.qwen3-sft")
    print(f"  2. Start model:       ollama run qwen3-8b-sft")
    print(f"  3. Switch pipeline:   curl -X POST http://localhost:3002/config/profiles/qwen3-8b-local/activate")


if __name__ == "__main__":
    download_all()
