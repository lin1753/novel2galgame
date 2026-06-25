"""
OpenAI-compatible API server with LoRA hot-swapping.
Uses transformers + bitsandbytes 4-bit for WSL2 compatibility.

Supports model names:
  - qwen3-8b-sft: base SFT model (no LoRA)
  - narrative: base + narrative-type LoRA (叙事单元分类)
  - attribution: base + attribution-best LoRA (角色归因)
  - scene: base + scene-boundary LoRA (场景边界)

Usage:
    pip install transformers flask bitsandbytes accelerate torch peft
    python3 serve-sft.py
"""

import os, json, time, uuid, threading
import torch
from flask import Flask, request, jsonify

MODEL_DIR = os.environ.get("MODEL_DIR", "/mnt/d/Project/novel2glagame/model")
BASE_MODEL_PATH = os.path.join(MODEL_DIR, "qwen3-8b-novel-base-sft")
PORT = int(os.environ.get("PORT", "8000"))

# LoRA adapter paths
LORA_ADAPTERS = {
    "narrative": os.path.join(MODEL_DIR, "narrative-type-lora"),
    "attribution": os.path.join(MODEL_DIR, "attribution-best-lora"),
    "scene": os.path.join(MODEL_DIR, "scene-boundary-lora"),
}

print(f"Base model: {BASE_MODEL_PATH}")
print(f"LoRA adapters: {list(LORA_ADAPTERS.keys())}")
print(f"Using 4-bit NF4 quantization")

from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from peft import PeftModel

print(f"GPU: {torch.cuda.get_device_name(0)}")
print(f"Free memory: {torch.cuda.mem_get_info(0)[0] / 1024**3:.1f} GB")

# Load base model with 4-bit quantization
bnb_config = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_compute_dtype=torch.float16,
    bnb_4bit_quant_type="nf4",
)

tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL_PATH, trust_remote_code=True)
base_model = AutoModelForCausalLM.from_pretrained(
    BASE_MODEL_PATH,
    quantization_config=bnb_config,
    device_map={"": 0},
    trust_remote_code=True,
    torch_dtype=torch.float16,
)
print(f"Base model loaded. GPU memory: {torch.cuda.memory_allocated(0) / 1024**3:.1f} GB")

# Load all LoRA adapters into a single PeftModel
adapter_names = list(LORA_ADAPTERS.keys())
model = PeftModel.from_pretrained(base_model, list(LORA_ADAPTERS.values())[0], adapter_name=adapter_names[0])
for name, path in list(LORA_ADAPTERS.items())[1:]:
    model.load_adapter(path, adapter_name=name)
    print(f"  LoRA '{name}' loaded")

# Start with first adapter active
model.set_adapter(adapter_names[0])
current_adapter = adapter_names[0]
print(f"Active adapter: {current_adapter}")

print(f"All LoRAs loaded. GPU memory: {torch.cuda.memory_allocated(0) / 1024**3:.1f} GB")

model_lock = threading.Lock()


def get_model_for_request(model_name: str):
    """Switch to the appropriate LoRA adapter based on model name."""
    global current_adapter

    # Map model name to adapter
    adapter = None
    if model_name in LORA_ADAPTERS:
        adapter = model_name
    elif "narrative" in model_name:
        adapter = "narrative"
    elif "attribution" in model_name:
        adapter = "attribution"
    elif "scene" in model_name:
        adapter = "scene"
    else:
        # Default: use narrative adapter for base model requests
        adapter = adapter_names[0]

    with model_lock:
        if current_adapter != adapter:
            model.set_adapter(adapter)
            current_adapter = adapter

    return model


app = Flask(__name__)


@app.route("/v1/chat/completions", methods=["POST"])
def chat_completions():
    data = request.json
    messages = data.get("messages", [])
    model_name = data.get("model", "qwen3-8b-sft")
    max_tokens = data.get("max_tokens", 512)
    temperature = data.get("temperature", 0.3)

    active_model = get_model_for_request(model_name)

    # Apply chat template
    text = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True, enable_thinking=False
    )
    inputs = tokenizer(text, return_tensors="pt").to(active_model.device)

    try:
        with torch.no_grad():
            outputs = active_model.generate(
                **inputs,
                max_new_tokens=max_tokens,
                temperature=temperature if temperature > 0 else None,
                do_sample=temperature > 0,
                top_p=data.get("top_p", 0.95),
            )
    except Exception as e:
        return jsonify({"error": f"Generation failed: {str(e)}"}), 500

    generated = outputs[0][inputs["input_ids"].shape[-1]:]
    content = tokenizer.decode(generated, skip_special_tokens=True).strip()

    return jsonify({
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_name,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens": inputs["input_ids"].shape[-1],
            "completion_tokens": len(generated),
            "total_tokens": inputs["input_ids"].shape[-1] + len(generated),
        },
    })


@app.route("/v1/models", methods=["GET"])
def list_models():
    models = [{"id": "qwen3-8b-sft", "object": "model"}]
    for name in LORA_ADAPTERS:
        models.append({"id": name, "object": "model"})
    return jsonify({"data": models})


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "gpu_memory_gb": round(torch.cuda.memory_allocated(0) / 1024**3, 1),
        "active_adapter": current_adapter,
        "available_adapters": list(LORA_ADAPTERS.keys()),
    })


print(f"\nStarting server on port {PORT}...")
print(f"Available models: qwen3-8b-sft, {', '.join(LORA_ADAPTERS.keys())}")
app.run(host="0.0.0.0", port=PORT, threaded=True)
