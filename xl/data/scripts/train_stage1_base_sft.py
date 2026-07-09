#!/usr/bin/env python3
"""
Stage 1: base-sft — 在 72K 小说续写数据上微调 Qwen3-8B
目标：让模型学会言情小说叙事风格和续写能力

数据：
  - continuation.jsonl (36,092 条): 给前半段，续写后半段
  - instruction.jsonl (36,481 条): 指令式续写
  总计 72,573 条

用法：
  torchrun --nproc_per_node=4 train_stage1_base_sft.py
"""

import os
import argparse
import torch
from datasets import load_dataset
from transformers import (
    AutoTokenizer,
    AutoModelForCausalLM,
    TrainingArguments,
    Trainer,
    DataCollatorForLanguageModeling,
)


def format_chatml(example):
    """
    将 ChatML messages 转为训练文本
    格式：<|im_start|>role\ncontent<|im_end|>
    """
    messages = example["messages"]
    text = ""
    for msg in messages:
        role = msg["role"]
        content = msg["content"]
        text += f"<|im_start|>{role}\n{content}<|im_end|>\n"
    return {"text": text}


def main(
    model_name: str,
    data_dir: str,
    output_dir: str,
    cache_dir: str,
    num_epochs: int,
    batch_size_per_gpu: int,
    gradient_accumulation: int,
    learning_rate: float,
    max_length: int,
    warmup_ratio: float,
    logging_steps: int,
    save_steps: int,
    use_lora: bool,
    deepspeed: str,
):
    # ----------------------------------------------------------
    # 1. 加载数据
    # ----------------------------------------------------------
    print(f"Loading datasets from: {data_dir}")
    dataset = load_dataset("json", data_dir=data_dir, split="train", cache_dir=cache_dir)
    print(f"Total samples: {len(dataset)}")

    # 格式化为 ChatML 文本
    dataset = dataset.map(format_chatml, cache_file_name=os.path.join(cache_dir, "chatml_cache.arrow"))
    print(f"Sample text (first 200 chars):\n{dataset[0]['text'][:200]}...")

    # ----------------------------------------------------------
    # 2. 加载模型和 tokenizer
    # ----------------------------------------------------------
    print(f"Loading model: {model_name}")
    tokenizer = AutoTokenizer.from_pretrained(
        model_name,
        trust_remote_code=True,
        padding_side="right",
        cache_dir=cache_dir,
    )

    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # DDP 训练不要 device_map="auto"，Trainer 会自动处理分布式
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
        cache_dir=cache_dir,
    )

    # 可选：使用 LoRA 节省显存
    if use_lora:
        from peft import LoraConfig, get_peft_model, TaskType
        print("Applying LoRA...")
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
    # 3. Tokenize 数据
    # ----------------------------------------------------------
    print("Tokenizing...")
    def tokenize_function(examples):
        return tokenizer(
            examples["text"],
            truncation=True,
            max_length=max_length,
            padding=False,
        )

    tokenized_dataset = dataset.map(
        tokenize_function,
        batched=True,
        remove_columns=dataset.column_names,
    )

    # ----------------------------------------------------------
    # 4. 训练
    # ----------------------------------------------------------
    training_args = TrainingArguments(
        output_dir=output_dir,
        num_train_epochs=num_epochs,
        per_device_train_batch_size=batch_size_per_gpu,
        gradient_accumulation_steps=gradient_accumulation,
        learning_rate=learning_rate,
        warmup_ratio=warmup_ratio,
        logging_steps=logging_steps,
        save_steps=save_steps,
        save_total_limit=5,
        bf16=True,
        gradient_checkpointing=not use_lora,  # LoRA + gradient ckpt 有兼容问题
        optim="adamw_torch_fused",
        report_to="tensorboard",
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
        train_dataset=tokenized_dataset,
        data_collator=data_collator,
    )

    world_size = int(os.environ.get("WORLD_SIZE", 1))
    effective_batch = batch_size_per_gpu * gradient_accumulation * world_size
    print(f"Starting training... (effective batch size: {effective_batch})")
    trainer.train()

    # ----------------------------------------------------------
    # 5. 保存
    # ----------------------------------------------------------
    print("Saving model...")
    final_dir = os.path.join(output_dir, "final")
    trainer.save_model(final_dir)
    tokenizer.save_pretrained(final_dir)
    print(f"Model saved to {final_dir}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Stage 1: base-sft 训练")

    # 路径参数
    parser.add_argument("--model_name", type=str,
                        default="Qwen/Qwen3-8B",
                        help="基座模型名称或路径")
    parser.add_argument("--data_dir", type=str,
                        default="/workspace/project-nas-1000073/<your-username>/data/datasets/training/base-sft",
                        help="训练数据目录")
    parser.add_argument("--output_dir", type=str,
                        default="/workspace/project-nas-1000073/<your-username>/data/checkpoints/stage1-base-sft",
                        help="checkpoint 输出目录")
    parser.add_argument("--cache_dir", type=str,
                        default="/workspace/project-nas-1000073/<your-username>/cache",
                        help="HuggingFace 缓存目录")

    # 训练超参数
    parser.add_argument("--num_epochs", type=int, default=3,
                        help="训练轮数")
    parser.add_argument("--batch_size_per_gpu", type=int, default=4,
                        help="每卡 batch size")
    parser.add_argument("--gradient_accumulation", type=int, default=4,
                        help="梯度累积步数")
    parser.add_argument("--learning_rate", type=float, default=2e-5,
                        help="学习率")
    parser.add_argument("--max_length", type=int, default=4096,
                        help="最大序列长度")
    parser.add_argument("--warmup_ratio", type=float, default=0.03,
                        help="warmup 比例")
    parser.add_argument("--logging_steps", type=int, default=10,
                        help="日志间隔")
    parser.add_argument("--save_steps", type=int, default=500,
                        help="保存间隔")

    # LoRA
    parser.add_argument("--use_lora", action="store_true", default=False,
                        help="使用 LoRA 微调（默认全量微调）")
    parser.add_argument("--deepspeed", type=str, default="",
                        help="DeepSpeed 配置文件路径（多卡全量微调推荐使用）")

    args = parser.parse_args()

    # 确保缓存目录存在
    os.makedirs(args.cache_dir, exist_ok=True)

    main(
        model_name=args.model_name,
        data_dir=args.data_dir,
        output_dir=args.output_dir,
        cache_dir=args.cache_dir,
        num_epochs=args.num_epochs,
        batch_size_per_gpu=args.batch_size_per_gpu,
        gradient_accumulation=args.gradient_accumulation,
        learning_rate=args.learning_rate,
        max_length=args.max_length,
        warmup_ratio=args.warmup_ratio,
        logging_steps=args.logging_steps,
        save_steps=args.save_steps,
        use_lora=args.use_lora,
        deepspeed=args.deepspeed,
    )
