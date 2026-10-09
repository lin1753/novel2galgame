# 三 Agent 模型卡

基座: Qwen3-8B-Novel-Base-SFT | 方法: LoRA r=64 α=128 | 硬件: A800 80GB

---
language: zh
license: apache-2.0
library_name: transformers
pipeline_tag: text-generation
tags:
- qwen3
- chinese-novels
- creative-writing
- peft
base_model: Qwen/Qwen3-8B-Instruct
---

# Qwen3-8B Novel Base SFT

基于 Qwen3-8B-Instruct 全参微调，用 669 本中文网络小说训练（约 7200 万字符）。

覆盖类型：言情、耽美、都市言情、玄幻、网游。

## 用途

这是 **All Novel Can Be Galgame** 工作台的基座模型。
用于学习中文小说的叙事风格，配合下游 LoRA adapter 执行三类 Agent 任务：

- `mikuhhn1239/qwen3-8b-narrative-parsing-lora` — 叙事单元切分
- `mikuhhn1239/qwen3-8b-scene-segmentation-lora` — 场景边界识别
- `mikuhhn1239/qwen3-8b-attribution-assist-lora` — 角色归因

## 加载

```python
from transformers import AutoModelForCausalLM, AutoTokenizer

model = AutoModelForCausalLM.from_pretrained(
    "mikuhhn1239/qwen3-8b-novel-base-sft",
    torch_dtype="auto",
    device_map="auto",
)
tokenizer = AutoTokenizer.from_pretrained(
    "mikuhhn1239/qwen3-8b-novel-base-sft"
)
```

4-bit 量化（适用于 8GB 显存）：

```python
from transformers import BitsAndBytesConfig

bnb_config = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_compute_dtype="float16",
    bnb_4bit_quant_type="nf4",
)
model = AutoModelForCausalLM.from_pretrained(
    "mikuhhn1239/qwen3-8b-novel-base-sft",
    quantization_config=bnb_config,
    device_map="auto",
)
```

## 训练

- 微调方式：全参数 SFT
- 训练数据：72,573 条（continuation 36,092 + instruction 36,481）
- 最大序列长度：4096
- 学习率：5e-6，cosine scheduler
- 硬件：8×A800 80GB
- 框架：LLaMA-Factory

## 限制

- 仅支持中文输入
- 训练数据以网络小说为主，非通用指令模型
- 无安全对齐，不适用于敏感内容生成
---

## Agent 1: Narrative Type Classification ⭐

叙事单元类型分类 — 输入已切分的叙事单元，为每个 unit_id 标注类型。

### 任务
- 输入: 编号叙事单元 `[1] "..." [2] "..." ...`
- 输出: `{"labels": [{"unit_id": "N", "type": "dialogue|narration|thought|action|scene_description"}]}`
- 测试集: 39 条

### 五种类型
| 类型 | 含义 |
|------|------|
| `dialogue` | 对话 |
| `narration` | 叙述 |
| `thought` | 心理 |
| `action` | 动作 |
| `scene_description` | 场景描写 |

### 示例
```
输入:
  [1] "你怎么来了？"
  [2] 她愣了一下。
  [3] 其实我也不知道自己为什么会来。

输出:
  {"labels": [
    {"unit_id": "1", "type": "dialogue"},
    {"unit_id": "2", "type": "action"},
    {"unit_id": "3", "type": "thought"}
  ]}
```

### 加载
```python
from transformers import AutoModelForCausalLM
from peft import PeftModel

base = AutoModelForCausalLM.from_pretrained(
    "mikuhhn1239/qwen3-8b-novel-base-sft",
    torch_dtype="auto", device_map="auto",
)
model = PeftModel.from_pretrained(
    base, "mikuhhn1239/qwen3-8b-narrative-type-lora"
)
```

### 训练
```
基座: Qwen3-8B-Novel-Base-SFT (Stage1 全参 SFT, 72K 小说续写数据)
方法: LoRA (r=64, α=128, dropout=0.05)
数据: 616 条 (577 train / 39 val / 39 test)
框架: transformers Trainer + PEFT
优化器: AdamW (adamw_torch_fused), cosine schedule, warmup=5%
epoch: 5 | LR: 1e-4 | batch: 1×16(accum) | bf16 | max_length: 4096
```

### 版本历史
| 版本 | JSON解析率 | 类型准确率 | 数据量(train) | 说明 |
|------|:---:|:---:|:---:|------|
| v1 | 57.1% | 25.0% | 56 | 端到端（切分+分类） |
| v2 | 2.6% | 63.6% | 310 | 只分类，3ep, LR=2e-4 |
| v3 / v3.1 | 2.6% | 63.6% | 310 | 5ep, LR=1e-4，max_new_tokens=256 截断 JSON |
| v3.2 | 100% | 69.5% | 577 | 修复引号 `""`→`「」` + max_new_tokens→1024 + 扩标 |
| **v4** ⭐ | **100%** | **72.8%** | 577 | 8 卡 DDP 重训，+3.3pp，各类型全面提升 |

### v4 各类型准确率
| 类型 | v3.2 | v4 | 变化 |
|------|:---:|:---:|:---:|
| narration | — | **82%** | 最强 |
| dialogue | — | 70% | |
| thought | — | 62% | |
| action | — | 58% | |
| scene_description | — | 54% | 最弱 |
| **总体** | **69.5%** | **72.8%** | **+3.3pp** |

---

## Agent 2: Scene Boundary Detection

场景边界检测 — 判断段落序列中哪些位置应切换 scene。

### 任务
- 输入: 编号段落 `[P1]...[P2]...`
- 输出: `{"boundaries": [N]}` — N 为切分位置（在段落 N 之后切）
- 测试集: 35 条

### 示例
```
输入:
  [P1] 下课铃响，教室里热闹起来。
  [P2] 她低头收拾书包。
  [P3] 我犹豫了一下，还是叫住了她。
  [P4] 十分钟后，我们并肩走在校门外的街道上。

输出:
  {"boundaries": [3]}   ← P3后切scene（教室→校门外）
```

### 加载
```python
from transformers import AutoModelForCausalLM
from peft import PeftModel

base = AutoModelForCausalLM.from_pretrained(
    "mikuhhn1239/qwen3-8b-novel-base-sft",
    torch_dtype="auto", device_map="auto",
)
model = PeftModel.from_pretrained(
    base, "mikuhhn1239/qwen3-8b-scene-boundary-lora"
)
```

### 训练
```
基座: Qwen3-8B-Novel-Base-SFT (Stage1 全参 SFT, 72K 小说续写数据)
方法: LoRA (r=64, α=128, dropout=0.05)
数据: 419 条 (384 train / 35 val / 35 test)
框架: transformers Trainer + PEFT
优化器: AdamW (adamw_torch_fused), cosine schedule, warmup=5%
epoch: 5 | LR: 1e-4 | batch: 1×16(accum) | bf16 | max_length: 4096
```

### 版本历史
| 版本 | JSON解析率 | Precision | Recall | F1 | 说明 |
|------|:---:|:---:|:---:|:---:|------|
| v1 | 66.7% | 33.3% | 33.3% | 33.3% | 端到端（边界+原因），82条 |
| v2 | 88.9% | 57.1% | 50.0% | 53.3% | 只检测边界，扩标数据 |
| v3 | 97.1% | — | — | 19.6% | 350条清洁数据，3ep, LR=2e-4 |
| **v3.1** ⭐ | **100%** | 27.7% | 29.5% | **28.6%** | 5ep, LR=1e-4 |
| v3.2 | 100% | — | — | 20.0% | 恢复 reasons + 扩标 384，反而退步 |
| v3.3 | 100% | 23.8% | 11.4% | **15.4%** | 二元决策格式（每对都判断），退化：全 false+1 true |
| v3.4 | 100% | 50.0% | 6.8% | **12.0%** | 滑动窗口 pairwise，退化：全 false |
| v3.5 | 100% | 20.0% | 23.1% | **21.4%** | Best-of-N 迭代训练（简化 GRPO），20%→21.4% 微涨 |
| **v3.6** ⭐ | **94%** | 28.2% | 28.2% | **28.2%** | v2 短 prompt + v3.2 数据，追平 v3.1 最佳 |
| v4.1-1804 | 100% | — | — | 29.9% | 三倍数据，eval_loss 创新低但 F1 未提升 |
| v4.1-582 | 100% | 29.0% | 31.6% | 30.2% | 精炼过滤，高密度泛化差 |
| **v4-590** ⭐⭐ | **100%** | 27.8% | 33.8% | **30.5%** | DeepSeek 重标注，最稳健，跨密度泛化最好 |

> ⚠️ 场景边界是三 Agent 中最难的任务。
>
> **版本演进路线**：
> - v1（句子级端到端，65 train）：33.3%，粒度不同不可比
> - v2（人类标注，280 train）：**53.3%** — 标注标准不同
> - v3 系列（人类 Clean 标注）：天花板 ≈ 28.6%
> - v4 系列（DeepSeek 重标注）：突破 30%，v4-590 最佳
>
> **最终结论**：
> 1. DeepSeek 重标注是唯一有效突破 — 从 28.6%→30.5%
> 2. 数据量（1804 条）+ 精炼过滤（582 条）均未进一步提升
> 3. **FP 是最终瓶颈** — SFT 下模型始终预测太多边界，精度卡在 27-29%
> 4. **8B + SFT 天花板 ≈ 30% F1** — 继续突破需 GRPO/DPO 或更大基座

---

## Agent 3: Attribution Best Candidate ⭐

角色归因辅助 — 从候选角色中为目标对话选出最可能的说话人。

### 任务
- 输入: 候选角色列表 + 上下文（含目标对话）
- 输出: `{"best_candidate": "角色名", "uncertain": true/false}`
- 测试集: 30 条

### 示例
```
输入:
  候选: 林秋、苏晚、陈遥
  上下文:
    [1] "你今天又迟到了。"苏晚把笔放下。
    [2] 我把书包丢到桌上，没接话。
    [3] 陈遥坐在后排憋笑。
    [4] "路上堵车。" 【目标对话】

输出:
  {"best_candidate": "林秋", "uncertain": true}
  ← 第2句"我把书包丢到桌上"暗示"我"说了[4]，陈遥在憋笑排除，苏晚说了[1]；证据不足，不确定
```

### 加载
```python
from transformers import AutoModelForCausalLM
from peft import PeftModel

base = AutoModelForCausalLM.from_pretrained(
    "mikuhhn1239/qwen3-8b-novel-base-sft",
    torch_dtype="auto", device_map="auto",
)
model = PeftModel.from_pretrained(
    base, "mikuhhn1239/qwen3-8b-attribution-best-lora"
)
```

### 训练
```
基座: Qwen3-8B-Novel-Base-SFT (Stage1 全参 SFT, 72K 小说续写数据)
方法: LoRA (r=64, α=128, dropout=0.05)
数据: 495 条 (465 train / 30 val / 30 test)
框架: transformers Trainer + PEFT
优化器: AdamW (adamw_torch_fused), cosine schedule, warmup=5%
epoch: 5 | LR: 1e-4 | batch: 1×16(accum) | bf16 | max_length: 4096
```

### 版本历史
| 版本 | JSON解析率 | 最佳候选准确率 | 数据量(train) | 说明 |
|------|:---:|:---:|:---:|------|
| v1 | 100% | 14.3% | 66 | 3ep |
| v2 | 100% | 33.3% | 240 | 3ep, LR=2e-4 |
| v3.1 | 100% | 43.3% | 240 | 5ep, LR=1e-4 |
| v3.2 ⭐ | 100% | 86.7% | 465 | 扩标 + 5ep |
| v4 | 100% | 80.0% | 465 | 推理链，跌 7pp |

> 扩标效果显著：240→465 条后准确率从 43.3% 跃升至 86.7%（+43.4pp），说明该任务对数据量敏感。

---

## 汇总

### 测试集指标（最佳版本）

| Agent | 最佳版本 | 数据量(train) | JSON解析 | 关键指标 | 值 |
|-------|:---:|:---:|:---:|---------|:---:|
| narrative-type | v4 | 577 | 100% | 类型准确率 | **72.8%** |
| scene-boundary | v4-590 | 590 | 100% | F1 | **30.5%** |
| attribution-best | v3.2 | 465 | 100% | 候选准确率 | **86.7%** |

### 版本演进总览

| Agent | v1 | v2 | v3/v3.1 | v3.2 | 趋势 |
|-------|:---:|:---:|:---:|:---:|------|
| narrative-type (acc) | 25.0% | 63.6% | 63.6% | **72.8%** ⭐ | ↗ 持续提升 |
| scene-boundary (F1) | 33.3% | 53.3% | 28.6% | **30.5%** ⭐⭐ | 标注质量定上限 |
| attribution-best (acc) | 14.3% | 33.3% | 43.3% | **86.7%** ⭐ | ↗ 大幅跃升 |

### 产物路径

| 产物 | 路径 | 大小 |
|------|------|:---:|
| Stage 1 基座 | `checkpoints/stage1-base-sft/final/` | 16GB |
| narrative-type LoRA | `checkpoints/stage2-v4/narrative-type-classification/final/` | 682MB |
| scene-boundary LoRA | `checkpoints/stage2-v4/v4_best_adapter/` | 682MB |
| attribution-best LoRA | `checkpoints/stage2-v3.2/attribution-best-candidate/final/` | 682MB |

> 三个 LoRA 共用同一个 Stage1 基座。推理时加载基座 + 对应 LoRA adapter 即可。
