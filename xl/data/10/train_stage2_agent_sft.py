#!/usr/bin/env python3
"""
Stage 2: Agent SFT — 从同一个 base-sft 基座分叉训练三个独立 Agent 模型

  Agent 1: narrative-parsing   → 叙事单元切分 + 类型标注
  Agent 2: scene-segmentation  → 场景边界识别
  Agent 3: attribution-assist  → 角色归因

每个 Agent 只用自己任务的数据，不混入其他任务。

用法：
  # 只训练某一个 Agent
  python train_stage2_agent_sft.py narrative-parsing
  python train_stage2_agent_sft.py scene-segmentation
  python train_stage2_agent_sft.py attribution-assist

  # 或一次性训练全部三个
  python train_stage2_agent_sft.py all
"""

import os
import sys
import json
import torch
from datasets import Dataset
from transformers import (
    AutoTokenizer,
    AutoModelForCausalLM,
    TrainingArguments,
    Trainer,
    DataCollatorForLanguageModeling,
)


# ============================================================
# 配置
# ============================================================
# Stage 1 产出的基座模型（三个 Agent 从这个基座分叉）
BASE_MODEL_DIR = "/workspace/project-nas-1000073/<your-username>/data/checkpoints/stage1-base-sft/final"

# 如果 Stage 1 还没跑，可以临时从原始模型开始测试
# BASE_MODEL_DIR = "Qwen/Qwen2.5-7B-Instruct"

DATA_DIR = "/workspace/project-nas-1000073/<your-username>/data/datasets/training_opt"
OUTPUT_BASE_DIR = "/workspace/project-nas-1000073/<your-username>/data/checkpoints/stage2"

# 训练参数（数据量很小：50-80 条/任务）
NUM_EPOCHS = 10
BATCH_SIZE = 2
GRADIENT_ACCUMULATION = 1
LEARNING_RATE = 1e-5          # 小学习率，防止遗忘 base-sft 学到的风格
MAX_LENGTH = 4096  # 可通过 --max_length 覆盖
WARMUP_RATIO = 0.1
LOGGING_STEPS = 5
SAVE_STEPS = 50
EVAL_STEPS = 50
VAL_SPLIT = 0.15

# 三个 Agent 任务的配置
AGENT_CONFIGS = {
    "narrative-parsing": {
        "name": "Narrative Parsing Agent",
        "description": "叙事单元切分 + 类型标注",
    },
    "scene-segmentation": {
        "name": "Scene Segmentation Agent",
        "description": "场景边界识别",
    },
    "attribution-assist": {
        "name": "Attribution Assist Agent",
        "description": "角色归因",
    },
}


def load_agent_data(task_name, data_dir):
    """加载单个 Agent 任务的全部数据（train + val + test）"""
    task_dir = os.path.join(data_dir, task_name)
    samples = []

    for split_file in ["train.jsonl", "val.jsonl", "test.jsonl"]:
        filepath = os.path.join(task_dir, split_file)
        if not os.path.exists(filepath):
            continue
        with open(filepath, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                sample = json.loads(line)
                sample["_split"] = split_file.replace(".jsonl", "")
                samples.append(sample)

    print(f"  {task_name}: {len(samples)} total samples")
    for split_name in ["train", "val", "test"]:
        count = sum(1 for s in samples if s["_split"] == split_name)
        if count > 0:
            print(f"    {split_name}: {count}")
    return samples


def format_chatml(sample):
    """ChatML messages → 训练文本"""
    messages = sample["messages"]
    text = ""
    for msg in messages:
        text += f"<|im_start|>{msg['role']}\n{msg['content']}<|im_end|>\n"
    return {"text": text}


def tokenize_function(examples, tokenizer):
    result = tokenizer(
        examples["text"],
        truncation=True,
        max_length=MAX_LENGTH,
        padding=False,
    )
    return result


def train_agent(task_name, base_model_dir, output_base_dir, use_lora=False, deepspeed=""):
    """训练单个 Agent 模型"""
    config = AGENT_CONFIGS[task_name]
    output_dir = os.path.join(output_base_dir, task_name)

    print(f"\n{'='*60}")
    print(f"  Training: {config['name']} ({task_name})")
    print(f"  Task: {config['description']}")
    print(f"  Output: {output_dir}")
    print(f"{'='*60}\n")

    # ----------------------------------------------------------
    # 1. 加载单个任务的数据
    # ----------------------------------------------------------
    samples = load_agent_data(task_name, DATA_DIR)
    dataset = Dataset.from_list(samples)

    # 格式化为 ChatML
    dataset = dataset.map(format_chatml)

    # 划分 train/val
    dataset = dataset.train_test_split(test_size=VAL_SPLIT, seed=42)
    train_dataset = dataset["train"]
    val_dataset = dataset["test"]
    print(f"  Train: {len(train_dataset)}, Val: {len(val_dataset)}")

    # 打印 system prompt 确认数据正确
    sys_prompt = samples[0]["messages"][0]["content"][:150]
    print(f"  System prompt: {sys_prompt}...\n")

    # ----------------------------------------------------------
    # 2. 加载基座模型（每个 Agent 都从同一个 base-sft 模型开始）
    # ----------------------------------------------------------
    print(f"  Loading base model from: {base_model_dir}")
    tokenizer = AutoTokenizer.from_pretrained(
        base_model_dir,
        trust_remote_code=True,
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        base_model_dir,
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
    )
    if not deepspeed:
        model = model.cuda()  # 单卡模式

    # LoRA 微调（单卡推荐）
    if use_lora:
        from peft import LoraConfig, get_peft_model, TaskType
        print("  Applying LoRA...")
        peft_config = LoraConfig(
            task_type=TaskType.CAUSAL_LM,
            r=64,
            lora_alpha=128,
            lora_dropout=0.05,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                           "gate_proj", "up_proj", "down_proj"],
        )
        model = get_peft_model(model, peft_config)
        model.print_trainable_parameters()

    # ----------------------------------------------------------
    # 3. Tokenize
    # ----------------------------------------------------------
    train_tokenized = train_dataset.map(
        lambda x: tokenize_function(x, tokenizer),
        batched=True,
        remove_columns=train_dataset.column_names,
    )
    val_tokenized = val_dataset.map(
        lambda x: tokenize_function(x, tokenizer),
        batched=True,
        remove_columns=val_dataset.column_names,
    )

    # ----------------------------------------------------------
    # 4. 训练
    # ----------------------------------------------------------
    training_args = TrainingArguments(
        output_dir=output_dir,
        num_train_epochs=NUM_EPOCHS,
        per_device_train_batch_size=BATCH_SIZE,
        gradient_accumulation_steps=GRADIENT_ACCUMULATION,
        per_device_eval_batch_size=2,
        learning_rate=LEARNING_RATE,
        warmup_ratio=WARMUP_RATIO,
        logging_steps=LOGGING_STEPS,
        save_steps=SAVE_STEPS,
        eval_strategy="steps",
        eval_steps=EVAL_STEPS,
        save_total_limit=3,
        bf16=True,
        gradient_checkpointing=not use_lora,
        optim="adamw_torch_fused",
        report_to="tensorboard",
        load_best_model_at_end=True,
        metric_for_best_model="eval_loss",
        greater_is_better=False,
        ddp_find_unused_parameters=False,
        remove_unused_columns=False,
        deepspeed=deepspeed if deepspeed else None,
    )

    data_collator = DataCollatorForLanguageModeling(
        tokenizer=tokenizer,
        mlm=False,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_tokenized,
        eval_dataset=val_tokenized,
        data_collator=data_collator,
    )

    trainer.train()

    # ----------------------------------------------------------
    # 5. 保存
    # ----------------------------------------------------------
    final_dir = os.path.join(output_dir, "final")
    trainer.save_model(final_dir)
    tokenizer.save_pretrained(final_dir)
    print(f"  Model saved to {final_dir}")

    # 释放显存
    del model, tokenizer, trainer
    torch.cuda.empty_cache()


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Stage 2: Agent SFT")
    parser.add_argument("task", nargs="?", default="all",
                        help="task name or 'all'")
    parser.add_argument("--use_lora", action="store_true", default=False,
                        help="使用 LoRA 微调（单卡推荐）")
    parser.add_argument("--deepspeed", type=str, default="",
                        help="DeepSpeed 配置文件路径")
    parser.add_argument("--batch_size", type=int, default=2,
                        help="每卡 batch size")
    parser.add_argument("--max_length", type=int, default=6144,
                        help="最大序列长度")
    args = parser.parse_args()

    task_arg = args.task

    if task_arg == "all":
        tasks = ["narrative-parsing", "scene-segmentation", "attribution-assist"]
    elif task_arg in AGENT_CONFIGS:
        tasks = [task_arg]
    else:
        print(f"Unknown task: {task_arg}")
        print(f"Available: {list(AGENT_CONFIGS.keys())} | all")
        sys.exit(1)

    global BATCH_SIZE, MAX_LENGTH
    BATCH_SIZE = args.batch_size
    MAX_LENGTH = args.max_length

    for task in tasks:
        train_agent(task, BASE_MODEL_DIR, OUTPUT_BASE_DIR, use_lora=args.use_lora, deepspeed=args.deepspeed)

    print("\n" + "="*60)
    print("  All agents trained!")
    print("="*60)
    print("\nOutput models:")
    for task in tasks:
        final_path = os.path.join(OUTPUT_BASE_DIR, task, "final")
        exists = "✓" if os.path.exists(final_path) else "✗ (not created)"
        print(f"  {task:25s} → {final_path}  {exists}")


if __name__ == "__main__":
    main()
