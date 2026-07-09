#!/usr/bin/env python3
"""只训练 narrative-type-classification"""
import os, json, torch
from datasets import Dataset
from transformers import AutoTokenizer, AutoModelForCausalLM, TrainingArguments, Trainer, DataCollatorForLanguageModeling
from peft import LoraConfig, get_peft_model, TaskType

BASE = '/workspace/project-nas-1000073/<your-username>/data/checkpoints/stage1-base-sft/final'
DATA = '/workspace/project-nas-1000073/<your-username>/data/datasets/training/v3/narrative-type-classification'
OUT = '/workspace/project-nas-1000073/<your-username>/data/checkpoints/stage2-v3/narrative-type-classification'

def load_jsonl(p):
    with open(p) as f: return [json.loads(l) for l in f]

def fmt(msgs):
    return ''.join(f"<|im_start|>{m['role']}\n{m['content']}<|im_end|>\n" for m in msgs)

td = Dataset.from_list([{'messages': d['messages']} for d in load_jsonl(f'{DATA}/train.jsonl')])
vd = Dataset.from_list([{'messages': d['messages']} for d in load_jsonl(f'{DATA}/val.jsonl')])
print(f'train={len(td)} val={len(vd)}')

tok = AutoTokenizer.from_pretrained(BASE, trust_remote_code=True)
if tok.pad_token is None: tok.pad_token = tok.eos_token

m = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.bfloat16, device_map='auto', trust_remote_code=True)
m = get_peft_model(m, LoraConfig(task_type=TaskType.CAUSAL_LM, r=64, lora_alpha=128, lora_dropout=0.05,
    target_modules=['q_proj','k_proj','v_proj','o_proj','gate_proj','up_proj','down_proj']))
m.print_trainable_parameters()

td = td.map(lambda x: {'text': fmt(x['messages'])}, remove_columns=['messages'])
vd = vd.map(lambda x: {'text': fmt(x['messages'])}, remove_columns=['messages'])
td = td.map(lambda x: tok(x['text'], truncation=True, max_length=4096), batched=True, remove_columns=['text'])
vd = vd.map(lambda x: tok(x['text'], truncation=True, max_length=4096), batched=True, remove_columns=['text'])

args = TrainingArguments(output_dir=OUT, per_device_train_batch_size=2, gradient_accumulation_steps=8,
    num_train_epochs=3, learning_rate=2e-4, lr_scheduler_type='cosine', warmup_ratio=0.05, weight_decay=0.01,
    bf16=True, logging_steps=5, save_strategy='epoch', eval_strategy='epoch', save_total_limit=2,
    remove_unused_columns=True, report_to='none')
trainer = Trainer(model=m, args=args, train_dataset=td, eval_dataset=vd,
    data_collator=DataCollatorForLanguageModeling(tokenizer=tok, mlm=False))
trainer.train()
m.save_pretrained(f'{OUT}/final'); tok.save_pretrained(f'{OUT}/final')
print(f'Saved to {OUT}/final')
