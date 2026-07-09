#!/usr/bin/env python3
"""快速评估 +Stage2 v3，10 分钟内完成"""
import json, torch, re, time
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import PeftModel

BASE = '/workspace/project-nas-1000073/<your-username>/data/checkpoints/stage1-base-sft/final'
LORA = '/workspace/project-nas-1000073/<your-username>/data/checkpoints/stage2-v3'
DATA = '/workspace/project-nas-1000073/<your-username>/data/datasets/training/v3'

def extract_json(text):
    text = text.strip()
    try: return json.loads(text)
    except: pass
    for pat in [r'\[.*\]', r'\{.*\}']:
        m = re.search(pat, text, re.DOTALL)
        if m:
            try: return json.loads(m.group())
            except: pass
    return None

for agent in ['attribution-best-candidate','scene-boundary-detection','narrative-type-classification']:
    print(f'\n=== {agent} ===')
    tok = AutoTokenizer.from_pretrained(BASE, trust_remote_code=True)
    if tok.pad_token is None: tok.pad_token = tok.eos_token
    m = PeftModel.from_pretrained(
        AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.bfloat16, device_map='auto', trust_remote_code=True),
        f'{LORA}/{agent}/final')
    m.eval()

    samples = [json.loads(l) for l in open(f'{DATA}/{agent}/test.jsonl')]
    parsed, total, correct = 0, 0, 0
    t0 = time.time()
    for i, s in enumerate(samples):
        msgs = s['messages']
        text = ''.join(f"<|im_start|>{m['role']}\n{m['content']}<|im_end|>\n" for m in msgs[:-1])
        text += '<|im_start|>assistant\n'
        inputs = tok(text, return_tensors='pt').to(m.device)
        with torch.no_grad():
            out = m.generate(**inputs, max_new_tokens=128, do_sample=False,
                           pad_token_id=tok.pad_token_id, eos_token_id=tok.eos_token_id)
        resp = tok.decode(out[0][len(inputs.input_ids[0]):], skip_special_tokens=True)
        pred = extract_json(resp)
        gold = json.loads(msgs[2]['content'])

        if not isinstance(pred, dict): pred = {}
        ok = bool(pred and gold)
        if ok: parsed += 1

        if agent == 'narrative-type-classification' and ok:
            gl = {u['unit_id']: u['type'] for u in gold.get('labels', [])}
            pl = {u.get('unit_id', ''): u.get('type', '') for u in pred.get('labels', [])}
            total += len(gl)
            correct += sum(1 for uid in gl if pl.get(uid) == gl[uid])
        elif agent == 'scene-boundary-detection' and ok:
            gs = set(gold.get('boundaries', []))
            ps = set(pred.get('boundaries', []))
            tp = len(gs & ps); fp = len(ps - gs); fn = len(gs - ps)
        elif agent == 'attribution-best-candidate' and ok:
            correct += 1 if pred.get('best_candidate') == gold.get('best_candidate') else 0

        if i < 2:
            print(f'  [{i}] {resp[:120]}')

    if agent == 'narrative-type-classification':
        acc = correct/total if total else 0
        print(f'  JSON={parsed}/{len(samples)}  准确率={acc:.1%}')
    elif agent == 'scene-boundary-detection':
        prec = tp/(tp+fp) if tp+fp else 0
        rec = tp/(tp+fn) if tp+fn else 0
        f1 = 2*prec*rec/(prec+rec) if prec+rec else 0
        print(f'  JSON={parsed}/{len(samples)}  P={prec:.1%} R={rec:.1%} F1={f1:.1%}')
    else:
        acc = correct/parsed if parsed else 0
        print(f'  JSON={parsed}/{len(samples)}  准确率={acc:.1%}')
    print(f'  耗时={time.time()-t0:.0f}s')
    del m; torch.cuda.empty_cache()

print('\nDone')
