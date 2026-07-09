#!/usr/bin/env python3
"""Scene Boundary 最终可视化：v4-590 vs v4.1-refined"""
import json, re, torch, numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import PeftModel

BASE = '/workspace/project-nas-1000073/<your-username>/data/checkpoints/stage1-base-sft/final'
V2_SYS = "你是一个中文小说 scene 边界检测助手。判断输入段落中哪些边界应切换 scene。只有在明显边界变化时才切。不要因情绪变化就切。只输出 boundaries，不输出原因。输出 JSON。"

MODELS = {
    "v4-590": '/workspace/project-nas-1000073/<your-username>/data/checkpoints/stage2-v4/scene-boundary-detection/checkpoint-148',
    "v4.1-refined": '/workspace/project-nas-1000073/<your-username>/data/checkpoints/stage2-v4.1/scene-segmentation/checkpoint-74',
}
TESTS = {
    "v4-590": '/workspace/project-nas-1000073/<your-username>/data/datasets/training/v4/test.jsonl',
    "v4.1-refined": '/workspace/project-nas-1000073/<your-username>/data/datasets/training/v4.1/test.jsonl',
}

tok = AutoTokenizer.from_pretrained(BASE, trust_remote_code=True)
if tok.pad_token is None: tok.pad_token = tok.eos_token

def extract_json(text):
    text = text.strip()
    try: return json.loads(text)
    except: pass
    m = re.search(r'\{.*\}', text, re.DOTALL)
    if m:
        raw = m.group()
        for i in range(len(raw), 0, -1):
            for suffix in ['}]}', ']}]}']:
                try:
                    r = json.loads(raw[:i] + suffix)
                    if isinstance(r, dict) and r: return r
                except: pass
    return None

all_results = {}
for name, lora_path in MODELS.items():
    print(f"Evaluating {name}...", flush=True)
    m = PeftModel.from_pretrained(
        AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.bfloat16, device_map='auto', trust_remote_code=True),
        lora_path).eval()

    test_path = TESTS[name]
    samples = [json.loads(l) for l in open(test_path, encoding='utf-8') if l.strip()]
    per_sample = []

    fp_positions = {}  # track which positions get falsely predicted

    for i, s in enumerate(samples):
        msgs = s['messages']
        text = f"<|im_start|>system\n{V2_SYS}<|im_end|>\n"
        text += f"<|im_start|>user\n{msgs[1]['content']}<|im_end|>\n"
        text += '<|im_start|>assistant\n'
        inputs = tok(text, return_tensors='pt').to(m.device)
        with torch.no_grad():
            out = m.generate(**inputs, max_new_tokens=128, do_sample=False,
                             pad_token_id=tok.pad_token_id, eos_token_id=tok.eos_token_id)
        resp = tok.decode(out[0][len(inputs.input_ids[0]):], skip_special_tokens=True)
        pred = extract_json(resp)
        gold = json.loads(msgs[2]['content'])

        g_set = set(gold['boundaries'])
        p_set = set(pred.get('boundaries', [])) if pred and isinstance(pred, dict) else set()

        tp = len(g_set & p_set)
        fp = len(p_set - g_set)
        fn = len(g_set - p_set)

        # Track FP positions
        for pos in (p_set - g_set):
            fp_positions[pos] = fp_positions.get(pos, 0) + 1

        per_sample.append({
            "id": i, "gold": sorted(g_set), "pred": sorted(p_set),
            "tp": tp, "fp": fp, "fn": fn,
            "prec": tp/(tp+fp) if (tp+fp) else 0,
            "rec": tp/(tp+fn) if (tp+fn) else 0,
            "f1": 2*tp/(2*tp+fp+fn) if (2*tp+fp+fn) else 0,
            "paras": len(re.findall(r'\[P\d+\]', msgs[1]['content'])),
        })
        if i % 20 == 0:
            print(f"  [{i}/{len(samples)}]", flush=True)

    all_results[name] = {"per_sample": per_sample, "fp_positions": fp_positions}
    del m; torch.cuda.empty_cache()

# ─── 可视化 ───
fig = plt.figure(figsize=(20, 12))

# 1. F1 per sample — both models
ax = fig.add_subplot(2, 3, 1)
for idx, (name, color) in enumerate([("v4-590", "#2ecc71"), ("v4.1-refined", "#3498db")]):
    data = all_results[name]["per_sample"]
    f1s = [d["f1"]*100 for d in data]
    ax.plot(range(len(f1s)), f1s, color=color, alpha=0.7, linewidth=1.5, label=name)
    mean_f1 = np.mean(f1s)
    ax.axhline(y=mean_f1, color=color, linestyle='--', alpha=0.5, linewidth=1)
    ax.text(len(f1s)+0.5, mean_f1, f'{mean_f1:.1f}%', color=color, fontsize=9, va='center')
ax.set_xlabel('Sample ID'); ax.set_ylabel('F1 (%)')
ax.set_title('Per-Sample F1 Score', fontsize=12, fontweight='bold')
ax.legend(fontsize=8); ax.set_ylim(-5, 105)
ax.grid(axis='y', alpha=0.3)

# 2. Precision vs Recall scatter
ax = fig.add_subplot(2, 3, 2)
for name, color, marker in [("v4-590", "#2ecc71", "o"), ("v4.1-refined", "#3498db", "s")]:
    data = all_results[name]["per_sample"]
    precs = [d["prec"]*100 for d in data]
    recs = [d["rec"]*100 for d in data]
    ax.scatter(recs, precs, c=color, alpha=0.6, s=30, marker=marker, label=name)
    # F1 contours
    for f1_val in [0.2, 0.4, 0.6, 0.8]:
        r = np.linspace(0.01, 1, 100)
        p = f1_val * r / (2*r - f1_val)
        valid = p > 0
        ax.plot(r[valid]*100, p[valid]*100, 'gray', alpha=0.15, linewidth=0.5)
ax.set_xlabel('Recall (%)'); ax.set_ylabel('Precision (%)')
ax.set_title('Precision vs Recall', fontsize=12, fontweight='bold')
ax.legend(fontsize=8); ax.set_xlim(-5, 105); ax.set_ylim(-5, 105)
ax.grid(alpha=0.3)

# 3. FP position heatmap
ax = fig.add_subplot(2, 3, 3)
all_positions = set()
for name in MODELS:
    all_positions.update(all_results[name]["fp_positions"].keys())
max_pos = max(all_positions) if all_positions else 20

for idx, (name, color) in enumerate([("v4.1-refined", "#3498db"), ("v4-590", "#2ecc71")]):
    fp_data = all_results[name]["fp_positions"]
    positions = range(1, min(max_pos+1, 25))
    counts = [fp_data.get(p, 0) for p in positions]
    ax.bar([p + idx*0.3 - 0.15 for p in positions], counts, width=0.3,
           color=color, alpha=0.8, label=name)

ax.set_xlabel('Paragraph Position'); ax.set_ylabel('FP Count')
ax.set_title('False Positive by Position', fontsize=12, fontweight='bold')
ax.legend(fontsize=8); ax.grid(axis='y', alpha=0.3)

# 4. TP/FP/FN stacked per sample — v4-590 (first 30)
ax = fig.add_subplot(2, 3, 4)
data = all_results["v4-590"]["per_sample"][:30]
x = range(len(data))
ax.bar(x, [d["tp"] for d in data], color='#2ecc71', label='TP', width=0.8)
ax.bar(x, [d["fp"] for d in data], bottom=[d["tp"] for d in data], color='#e74c3c', label='FP', width=0.8)
ax.bar(x, [d["fn"] for d in data], bottom=[d["tp"]+d["fp"] for d in data], color='#f39c12', label='FN', width=0.8)
ax.set_xlabel('Sample ID'); ax.set_ylabel('Count')
ax.set_title('v4-590: TP/FP/FN per Sample (first 30)', fontsize=11, fontweight='bold')
ax.legend(fontsize=7, loc='upper right')

# 5. TP/FP/FN stacked — v4.1-refined (first 30)
ax = fig.add_subplot(2, 3, 5)
data = all_results["v4.1-refined"]["per_sample"][:30]
ax.bar(x, [d["tp"] for d in data], color='#2ecc71', label='TP', width=0.8)
ax.bar(x, [d["fp"] for d in data], bottom=[d["tp"] for d in data], color='#e74c3c', label='FP', width=0.8)
ax.bar(x, [d["fn"] for d in data], bottom=[d["tp"]+d["fp"] for d in data], color='#f39c12', label='FN', width=0.8)
ax.set_xlabel('Sample ID'); ax.set_ylabel('Count')
ax.set_title('v4.1-refined: TP/FP/FN per Sample (first 30)', fontsize=11, fontweight='bold')
ax.legend(fontsize=7, loc='upper right')

# 6. Summary table
ax = fig.add_subplot(2, 3, 6)
ax.axis('off')
summary = []
for name in ["v4-590", "v4.1-refined"]:
    data = all_results[name]["per_sample"]
    total_tp = sum(d["tp"] for d in data)
    total_fp = sum(d["fp"] for d in data)
    total_fn = sum(d["fn"] for d in data)
    prec = total_tp/(total_tp+total_fp)*100 if (total_tp+total_fp) else 0
    rec = total_tp/(total_tp+total_fn)*100 if (total_tp+total_fn) else 0
    f1 = 2*prec*rec/(prec+rec) if (prec+rec) else 0
    mean_f1 = np.mean([d["f1"] for d in data])*100

    avg_gold = np.mean([len(d["gold"]) for d in data])
    avg_pred = np.mean([len(d["pred"]) for d in data])

    summary.append([name, f'{f1:.1f}%', f'{prec:.1f}%', f'{rec:.1f}%',
                    str(total_tp), str(total_fp), str(total_fn),
                    f'{avg_gold:.1f}', f'{avg_pred:.1f}', f'{mean_f1:.1f}%'])

table = ax.table(cellText=summary,
    colLabels=['Model', 'F1', 'P', 'R', 'TP', 'FP', 'FN', 'Gold/P', 'Pred/P', 'Mean F1'],
    cellLoc='center', loc='center')
table.auto_set_font_size(False)
table.set_fontsize(9)
table.scale(1, 1.8)
for key, cell in table.get_celld().items():
    if key[0] == 0:
        cell.set_facecolor('#34495e')
        cell.set_text_props(color='white', fontweight='bold')
    elif key[1] == 1:
        cell.set_facecolor('#d5f5e3')
    elif key[1] == 2:
        cell.set_facecolor('#d6eaf8')
ax.set_title('Final Summary', fontsize=12, fontweight='bold', y=0.75)

plt.suptitle('Scene Boundary Detection — Final Evaluation\nv4-590 (DeepSeek 590) vs v4.1-refined (582 Refined)',
             fontsize=14, fontweight='bold', y=0.98)
plt.tight_layout(rect=[0, 0, 1, 0.94])
plt.savefig('/workspace/project-nas-1000073/<your-username>/data/outputs/scene_boundary_final_viz.png', dpi=150, bbox_inches='tight')
print(f"\n✅ Saved to outputs/scene_boundary_final_viz.png", flush=True)

# Save raw data
with open('/workspace/project-nas-1000073/<your-username>/data/outputs/scene_boundary_final_data.json', 'w') as f:
    json.dump({name: {"per_sample": data["per_sample"]} for name, data in all_results.items()},
              f, ensure_ascii=False, indent=2)
print(f"✅ Saved to outputs/scene_boundary_final_data.json", flush=True)
