"""
Download Qwen3-8B SFT models from HuggingFace.

Usage:
    pip install huggingface_hub
    python scripts/download-models.py

Models are saved to D:\Project\model\ (configurable via MODEL_DIR env var).
"""

import os
from huggingface_hub import snapshot_download

MODEL_DIR = os.environ.get("MODEL_DIR", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "model"))

MODELS = [
    {
        "repo_id": "mikuhhn1239/qwen3-8b-novel-base-sft",
        "local_dir": os.path.join(MODEL_DIR, "qwen3-8b-novel-base-sft"),
        "desc": "Stage 1 base SFT (16GB)",
    },
    {
        "repo_id": "mikuhhn1239/qwen3-8b-narrative-type-lora",
        "local_dir": os.path.join(MODEL_DIR, "qwen3-8b-narrative-type-lora"),
        "desc": "Agent 1: narrative type classification LoRA (682MB)",
    },
    {
        "repo_id": "mikuhhn1239/qwen3-8b-scene-boundary-lora",
        "local_dir": os.path.join(MODEL_DIR, "qwen3-8b-scene-boundary-lora"),
        "desc": "Agent 2: scene boundary detection LoRA (682MB)",
    },
    {
        "repo_id": "mikuhhn1239/qwen3-8b-attribution-best-lora",
        "local_dir": os.path.join(MODEL_DIR, "qwen3-8b-attribution-best-lora"),
        "desc": "Agent 3: attribution best candidate LoRA (682MB)",
    },
]


def download_all():
    os.makedirs(MODEL_DIR, exist_ok=True)
    for m in MODELS:
        print(f"\n{'='*60}")
        print(f"Downloading: {m['desc']}")
        print(f"  repo:  {m['repo_id']}")
        print(f"  dest:  {m['local_dir']}")
        print(f"{'='*60}")
        snapshot_download(
            repo_id=m["repo_id"],
            local_dir=m["local_dir"],
            resume_download=True,
        )
        print(f"  Done: {m['local_dir']}")

    print(f"\nAll models downloaded to {MODEL_DIR}")
    print("\nvLLM serve command:")
    print(f'  vllm serve "{MODEL_DIR}\\qwen3-8b-novel-base-sft" --port 8000 --served-model-name qwen3-8b-sft')


if __name__ == "__main__":
    download_all()
