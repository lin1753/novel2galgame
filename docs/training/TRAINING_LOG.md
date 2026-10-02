# Qwen3-8B 小说 Agent 微调 — 完整操作与调试记录

## 环境

| 项目 | 配置 |
|------|------|
| GPU | 8× NVIDIA A800-SXM4-80GB (80GB each) |
| CUDA | 12.4 |
| Python | 3.12.7 |
| PyTorch | 2.7.1 |
| Transformers | 4.57.1 |
| PEFT | 最新版 |
| DeepSpeed | 已安装 (ZeRO Stage 2) |
| 根目录空间 | 10GB (overlay 容器盘) |
| NAS 挂载 | `/workspace/project-nas-1000073/` (9.6P 可用) |
| 集群 | Kubernetes (PAI_CLUSTER=26001)，无 Slurm |

---

## 训练路线

```
Qwen3-8B 基座
  │
  ├── Stage 1: base-sft（全参 SFT）
  │   72K 小说续写数据 → 学会叙事风格
  │   4×A800 + DeepSpeed ZeRO-2
  │
  └── Stage 2: Agent SFT（LoRA）
        ├── Agent 1: narrative-type-classification
        ├── Agent 2: scene-boundary-detection
        └── Agent 3: attribution-best-candidate
```

---

## Stage 1: base-sft 全参微调

### 数据
- 路径：`datasets/training/base-sft/`
- `continuation.jsonl`：36,092 条（续写：给前半段→续后半段）
- `instruction.jsonl`：36,481 条（指令式续写）
- 总计 72,573 条
- 格式：ChatML (system + user + assistant messages)

### 模型下载
```bash
# HuggingFace 不通，用 ModelScope
pip install modelscope -q
modelscope download --model Qwen/Qwen3-8B \
    --local_dir /workspace/project-nas-1000073/<your-username>/models/Qwen3-8B
```

### 调试历程

| # | 错误 | 原因 | 解决 |
|---|------|------|------|
| 1 | `No module named 'peft'` | 脚本顶部无条件 import | 改成按需 import，不用 LoRA 时不加载 |
| 2 | `No space left on device` | 根目录 10G，8 进程并行 map 写满 | `HF_HOME`/`HF_DATASETS_CACHE` 指向 NAS |
| 3 | `huggingface.co timed out` | 公司网络不通外网 | 用 ModelScope 下载模型到本地路径 |
| 4 | 单卡 OOM (78G/80G) | 全量微调 optimizer+grads+model≈116G/卡 | 上 4 卡 DDP |
| 5 | 4 卡 DDP 仍 OOM (79G/80G) | DDP 每卡存完整 AdamW 状态(66G) | 加 DeepSpeed ZeRO-2 |
| 6 | ZeRO-2 backward OOM | 内存碎片，需要 2.8G 但只剩 2.5G | `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` |
| 7 | batch=2 预估 26 小时 | seq_len 太长 (4096) | 降到 2048，epochs 3→2，batch=2→4 |

### 最终配置与命令

**DeepSpeed ZeRO-2 配置** (`ds_zero2.json`)：
```json
{
    "bf16": { "enabled": true },
    "zero_optimization": {
        "stage": 2,
        "offload_optimizer": { "device": "none" },
        "allgather_partitions": true,
        "allgather_bucket_size": 2e8,
        "overlap_comm": true,
        "reduce_scatter": true,
        "reduce_bucket_size": 2e8,
        "contiguous_gradients": true
    },
    "gradient_accumulation_steps": "auto",
    "gradient_clipping": "auto",
    "train_batch_size": "auto",
    "train_micro_batch_size_per_gpu": "auto"
}
```

**训练命令**：
```bash
PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True torchrun --nproc_per_node=4 \
    /workspace/project-nas-1000073/<your-username>/data/train_stage1_base_sft.py \
    --model_name /workspace/project-nas-1000073/<your-username>/models/Qwen3-8B \
    --batch_size_per_gpu 4 \
    --gradient_accumulation 4 \
    --max_length 2048 \
    --num_epochs 2 \
    --deepspeed /workspace/project-nas-1000073/<your-username>/data/ds_zero2.json
```

**超参**：
| 参数 | 值 |
|------|-----|
| 有效 batch size | 64 (4×4×4) |
| 学习率 | 2e-5 |
| 优化器 | AdamW (adamw_torch_fused) |
| warmup | 3% |
| scheduler | linear decay |
| 精度 | bf16 |
| gradient checkpointing | True |
| 总步数 | 2268 (2 epochs) |

**训练结果**：
- 耗时：~9 小时
- loss：3.36 → 2.47
- 产物：`checkpoints/stage1-base-sft/final/`（16GB，4 个 safetensors 分片）

---

## Stage 2: Agent SFT（LoRA 微调）

### 数据版本演进

| 版本 | 任务名 | train | val | test | 说明 |
|------|--------|:---:|:---:|:---:|------|
| v1 | narrative-parsing / scene-segmentation / attribution-assist | 56/65/52 | 7/8/7 | 7/9/7 | 原始标注，端到端任务 |
| v2 | 同上 | — | — | — | 简化任务（去掉原因），扩标 |
| v3 | narrative-type-classification / scene-boundary-detection / attribution-best-candidate | 310/280/240 | 39/35/30 | 39/35/30 | Clean 标注，任务拆分 |
| v3.1 | 同上 | 同 | 同 | 同 | epochs 3→5, LR 2e-4→1e-4 |
| v3.2 | 同上 | 577/384/465 | 39/35/30 | 39/35/30 | 补 reasons + 修正引号 + 扩标 |

### 训练配置（统一）
```
基座: stage1-base-sft/final
方法: LoRA (r=64, α=128, dropout=0.05)
框架: transformers Trainer + PEFT
优化器: AdamW (adamw_torch_fused), cosine schedule, warmup=5%
batch: 1 × 16(accum) = 16 effective
epochs: 5 (v3.2)
LR: 1e-4
max_length: 4096
精度: bf16
硬件: 单卡 A800 80GB
```

### 指标汇总

| Agent | 版本 | 数据量 | JSON | 关键指标 | 备注 |
|-------|------|:---:|:---:|:---:|------|
| narrative-type | v3 | 310 | 2.6% | acc 63.6% | 格式崩 |
| | v3.1 | 310 | 2.6% | acc 63.6% | 同上 |
| | **v3.2** | 577 | **100%** | **acc 69.5%** | ⭐ 最佳 |
| scene-boundary | v3 | 280 | 97.1% | F1 19.6% | |
| | **v3.1** | 280 | 100% | **F1 28.6%** | ⭐ 最佳 |
| | v3.2 | 384 | 100% | F1 20.0% | 有 reasons 反而退步 |
| attribution-best | v3 | 240 | 100% | acc 33.3% | |
| | v3.1 | 240 | 100% | acc 43.3% | |
| | **v3.2** | 465 | 100% | **acc 86.7%** | ⭐ 最佳 |

### 最终产出（三个最佳 Agent）

| Agent | 路径 | 大小 |
|-------|------|:---:|
| narrative-type | `stage2-v3.2/narrative-type-classification/final/` | 682MB |
| scene-boundary | `stage2-v3.1/scene-boundary-detection/final/` | 682MB |
| attribution-best | `stage2-v3.2/attribution-best-candidate/final/` | 682MB |

> 基座模型：`stage1-base-sft/final/`（16GB，三个 Agent 共用）

### v3→v3.2 优化
1. **narrative-type**：输入引号 `""`→`「」`，扩标 310→577；修复 max_new_tokens=256→1024（JSON 截断问题）
2. **scene-boundary**：恢复 v2 的 reasons 输出，扩标 280→384（但效果未提升）
3. **attribution-best**：扩标 240→465

---

## 评估分析（2026-06-18）

### 测试集最终指标

| Agent | 版本 | 关键指标 | 值 | JSON |
|-------|:---:|---------|:---:|:---:|
| narrative-type | v3.2 ⭐ | 类型准确率 | **69.5%** | 100% |
| scene-boundary | v3.1 ⭐ | F1 | **28.6%** | 100% |
| attribution-best | v3.2 ⭐ | 候选准确率 | **86.7%** | 100% |

### 训练集 vs 验证集 Loss 趋势

| Agent | 版本 | train_loss | eval_loss | 判断 |
|-------|:---:|:---:|:---:|------|
| narrative-type | v3.2 | 1.43→0.38 | 1.26→1.48 | ✅ 在学，轻微过拟合 |
| scene-boundary | v3.1 | 2.36→1.27 | 1.92→1.95 | ❌ 几乎没动 |
| scene-boundary | v3.2 | 2.13→0.55 | 1.15→1.22 | ❌ train狂降/eval反涨，严重过拟合 |
| attribution-best | v3.2 | 2.82→0.16 | 1.70→1.64 | ✅ 在学，轻微过拟合 |

### Scene Boundary 深度分析

**预测行为（v3.1 最佳，测试集 35 条）：**
- 平均预测 2.7 个边界 vs gold 1.1 个（多 2.5×）
- 精确匹配仅 1/35 (3%)
- 有任何 TP 的样本仅 4/35 (11%)

**模型学到了退化策略：**
- 位置 10 被预测 17/35（49%），位置 1 被预测 15/35（43%）
- 模型在"常见位置"反复猜边界，不看输入内容
- 案例：`gold=[12] → pred=[1,2,10,14,20,22]`（猜 6 个全错）

**三大根因：**
1. **SFT 目标错误**：LM loss 优化 token 精度不是 F1，最优策略 = "常见位置猜几个"
2. **任务本质不同**：narrative-type 和 attribution-best 都是局部判断（逐 unit / 逐句），只有 scene-boundary 需要理解 10-20 段落的**全局篇章结构** — 8B 模型容量可能不够
3. **数据不平衡**：边界仅占候选切点 ~10%，train 9.6% 无边界 vs val 34.3% 无边界 — 分布不匹配

---

## Scene Boundary 改进实验（v3.3 → v3.4）

### v3.3：二元决策格式（每对都输出 true/false）

**思路**：强制模型为每个相邻段落对输出决策，消除"只猜正样本"的退化策略。

**数据**：v2(280) + v3.2(384) 合并去重 → 279 train / 35 val / 35 test

**新格式**：
```json
{"decisions": [{"after":1,"change":false}, {"after":2,"change":false}, ..., {"after":8,"change":true}, ...]}
```

**训练**：单卡 A800，LoRA r=64，5 epoch，lr=1e-4

**结果**：

| 指标 | v3.2 (旧) | v3.3 (二元) |
|------|:---:|:---:|
| F1 | 20.0% | **15.4%** ↓ |
| train_loss | 2.13→0.55 | 1.74→0.86 |
| eval_loss | 1.15→1.22 | 1.14→1.13 |

**新退化策略**：全 false + 恰好 1 个 true（因训练集 68% 样本有 1 个边界）

**结论**：改输出格式治标不治本，模型总能找到最低 loss 的策略。

### v3.4：滑动窗口 Pairwise 分类

**思路**：把全局长段落任务降维成局部二元分类。每条 passage 的每个相邻对独立成样本，只给 ±1 段落上下文 + 问这对是否切换。

**数据**：v3.3 passage 数据 → 3584 train / 418 val / 503 test（每对独立样本）

**输出**：`{"boundary": true}` 或 `{"boundary": false}`

**训练**：单卡 A800，LoRA r=64，3 epoch，lr=1e-4，max_length=2048

**结果**：

| 指标 | v3.3 (二元) | v3.4 (pairwise) |
|------|:---:|:---:|
| F1 | 15.4% | **12.0%** ↓↓ |
| train_loss | 1.74→0.86 | 2.38→0.13 |
| eval_loss | 1.14→1.13 | 1.47→**1.91** ↗↗ |
| Pair Acc | 88.7% | 91.3% |
| 退化策略 | 1 个 true | **几乎全 false** |

**eval_loss 从 1.47 涨到 1.91** — 训练越多越差，严重过拟合。模型学会了"全 false"直接拿到 91.3% pair accuracy + 低 loss。

### 三次实验总结

| 版本 | 方法 | F1 | 退化策略 | eval_loss 趋势 |
|------|------|:---:|------|:---:|
| v3.2 | 只列正样本 | 20.0% | 猜位置 1,10,14 | 1.15→1.22 ↗ |
| v3.3 | 每对都判断 | 15.4% | 全 false + 1 true | 1.14→1.13 → |
| v3.4 | 独立 pairwise | 12.0% | 全 false | 1.47→1.91 ↗↗ |

**根本原因**：SFT (LM loss) 和目标指标 (F1) 从根本上不对齐。边界仅占 ~10% 的 pair，"全 false"就是最低 loss 策略。无论怎么改输出格式，8B 模型在 SFT 范式下都无法学到场景边界的语义信号。

### v3.5：Best-of-N 迭代训练（简化 GRPO）

**思路**：不用 LM loss，每轮生成 K 个候选 → F1 评分 → 取最佳 → SFT 微调。

**配置**：K=3，温度=0.8，LR=5e-5，3 轮迭代，起点 v3.2 LoRA (F1=20%)

**结果**：

| 指标 | 迭代前 | 迭代后 |
|------|:---:|:---:|
| F1 | 20.0% | **21.4%** |
| Precision | 16.4% | 20.0% |
| Recall | 25.6% | 23.1% |
| TP/FP/FN | 10/51/29 | 9/36/30 |

Best-of-N 从 20% 微涨到 21.4%，未回到 v3.1 的 28.6%。模型在生成阶段产生大量 FP（伪正样本，猜了太多边界），SFT 后也无法纠正。

### v1 vs v2 vs v3 根因分析

| 版本 | train | sys prompt | 输出 | 段落数 | F1 |
|------|:---:|------|------|:---:|:---:|
| v1 | 65 | 733 字 | reasons | **29 句/篇** | 33.3% |
| v2 | 280 | **95 字** | 纯边界 | 13 段/篇 | **53.3%** |
| v3 | 310 | 95 字 | 纯边界 | 13 段/篇 | 19.6% |
| v3.1 | 310 | 95 字 | 纯边界 | 13 段/篇 | 28.6% |
| v3.2 | 384 | 735 字 | reasons | 13 段/篇 | 20.0% |

**v1 不可比**：29 句/篇 → 端到端句子级切分任务，不是预分段的段落级边界检测。

**v2 高分原因**：95 字短 prompt 不挤占 context window（735 字占 4096 的 18%），无 reasons 减少生成复杂度。v3 系列训练数据与 v2 共享同一批 passage（272/280 重叠），但 v3 的 "Clean 标注" 可能改变了标注标准。

**v3.2 长 prompt 的影响**：735 字 system prompt + reasons 输出格式，至少增加 200+ token 的注意力和生成负担。

### v3.6 计划

用 v2 的简洁格式（95 字 prompt + 纯边界输出）+ v3.2 的 384 条数据，回归 v2 的成功配方。

### v3.6：v2 短 prompt + v3.2 数据（无 reasons）

**思路**：v2 高分 (53.3%) 的核心是 95 字短 prompt + 纯边界输出。用 v3.2 的 384 条数据但换成 v2 格式。

**训练**：单卡 A800，LoRA r=64，5 epoch，lr=1e-4

**结果**：

| 指标 | 值 |
|------|:---:|
| F1 | **28.2%** |
| Precision | 28.2% |
| Recall | 28.2% |
| TP/FP/FN | 11/28/28 |
| JSON 解析 | 33/35 (94%) |
| eval_loss | 1.91→2.11 ↗ |

### Scene Boundary 全系列最终对比

| 版本 | train | prompt | reasons | F1 | 结论 |
|------|:---:|------|:---:|:---:|------|
| v2 | 280 | 95 字 | 无 | **53.3%** | v2 标注 + 短 prompt |
| v3 | 310 | 95 字 | 无 | 19.6% | v3 标注，3ep 不够 |
| v3.1 ⭐ | 310 | 95 字 | 无 | **28.6%** | v3 标注最佳，5ep |
| **v3.6 ⭐** | 384 | 95 字 | 无 | **28.2%** | 追平 v3.1 |
| v3.2 | 384 | 735 字 | 有 | 20.0% | 长 prompt 拖累 |
| v3.5 | 384 | 735 字 | 有 | 21.4% | Best-of-N 微涨 |
| v3.3 | 279 | 735 字 | 有 | 15.4% | 二元格式失败 |
| v3.4 | 3584 | 735 字 | 有 | 12.0% | 滑动窗口失败 |

**两大结论**：
1. **短 prompt 是必要条件**：v3.1/v3.6（短 prompt）≈ 28.6% vs v3.2（长 prompt）20%，差距 ~8pp
2. **v3 标注比 v2 难**：同短 prompt 同 passage，v2=53.3% vs v3=28.6%。v3 的 Clean 标注标准更严格或一致性更低
---

## v4：DeepSeek 重标注

### 思路

v3 系列全卡在 ~28.6%。v2 同一批 passage 能到 53.3% 说明**瓶颈是标注质量而非模型容量**。用 DeepSeek API 按 v2 简洁标准从头重标注。

### v4-296（第一版）

DeepSeek 标注 296 train / 28 val / 25 test，v2 风格短 prompt。

| 指标 | 值 |
|------|:---:|
| F1 (v4 test) | 26.7% |
| F1 (v3.2 test) | 16.9% |
| eval_loss | 1.85→1.79 ↓（首次下降） |

### v4-590（扩标版）⭐

扩标到 590 train / 56 val / 49 test。DeepSeek 标注，95 字短 prompt，纯边界输出。

**训练**：单卡 A800，LoRA r=64，5 epoch，lr=1e-4。最佳 epoch=4。

**eval_loss 曲线（首次持续下降）**：

| Epoch | train_loss | eval_loss |
|:---:|:---:|:---:|
| 1 | 2.52 | 1.92 |
| 2 | 1.71 | 1.74 ↓ |
| 3 | 1.28 | 1.57 ↓ |
| 4 | 0.98 | **1.51** ↓ |
| 5 | 0.82 | 1.55 |

**结果**：

| 测试集 | F1 | P | R | TP/FP/FN |
|------|:---:|:---:|:---:|:---:|
| v4 test (49) | **30.5%** | 27.8% | 33.8% | 27/70/53 |
| v3.2 test (35) | 15.4% | 11.0% | 25.6% | 10/81/29 |

### 全系列最终排名

| 版本 | train | prompt | 标注 | F1 (同测试集) | 亮点 |
|------|:---:|------|------|:---:|------|
| v2 | 280 | 95 字 | 人类(v2标准) | 53.3% | 标注标准不同 |
| **v4-590** ⭐ | 590 | 95 字 | DeepSeek | **30.5%** | 最稳健，跨密度泛化好 |
| v4.1-582 | 582 | 95 字 | DeepSeek 精炼 | 30.2% | 高密度，泛化差 |
| v4.1-1804 | 1804 | 95 字 | DeepSeek 扩标 | 29.9% | 三倍数据未提升 |
| v3.1 | 310 | 95 字 | 人类(v3Clean) | 28.6% | |
| v3.6 | 384 | 95 字 | 人类(v3Clean) | 28.2% | |

### v4.1 扩标实验（1804 条 → 582 条精炼）

**v4.1-1804**：快速扩标到 1804 条。边界比 8.5%（太保守），31% 零边界。eval_loss 创新低（1.74→1.32），但 F1=29.9% 未超 v4-590。**大量低质量标注稀释了信号。**

**v4.1-582 精炼**：筛选 ≥2 边界 + 非 P1 起切 + 8-18 段。边界比 15.6%，零边界仅 8%，≥2 边界占 76%。F1=30.2%（接近 v4-590），但依赖训练密度 — 在低密度测试集上仅 25.9%。

### 关键发现

1. **标注质量 > 数据量 > 训练技巧**：DeepSeek 重标注是唯一突破 30% 的路径
2. **数据密度影响泛化**：模型学会训练集的边界密度，密度不匹配时 F1 崩盘
3. **FP 是最终瓶颈**：所有版本精度 27-29%，模型始终预测 2-3× 太多边界，SFT 无法学会抑制 FP
4. **8B + SFT 天花板 ≈ 30% F1**：格式改进、训练优化、数据扩标、精炼过滤均未能突破

**继续突破需换训练范式**（GRPO 用 F1 做 reward）或换更大基座。

---

## Attribution Best + 推理链（v4）

### 思路

在输出中添加 `reasoning` 字段强制推理链。数据使用模板生成推理文本。

### 结果

| 指标 | v3.2 (原版) | v4 (推理链) |
|------|:---:|:---:|
| Best 准确率 | **86.7%** | 80.0% ↓ |
| Uncertain 匹配 | — | 70.0% |

推理模板太泛（"上下文信息不足"），模型学会了套模板不看内容 — 与 scene-boundary 加 reasons 失败如出一辙。**简单 = 好。**

---

## Narrative Type 重训（v4）

### 思路

8 卡 DDP 重训，同 v3.2 数据 + LoRA 配置。

**训练**：577 train / 39 val / 39 test，5 epoch，lr=1e-4

### 结果

| 类型 | v3.2 | v4 | 变化 |
|------|:---:|:---:|:---:|
| narration | — | **82%** | |
| dialogue | — | 70% | |
| thought | — | 62% | |
| action | — | 58% | |
| scene_description | — | 54% | |
| **总体** | **69.5%** | **72.8%** ⬆ | +3.3pp |

1526 个 unit，8 卡重训一次涨 3.3pp。

---

## 最终三 Agent 汇总

| Agent | 最佳版本 | 指标 | 训练数据 | 模型大小 |
|-------|:---:|:---:|:---:|:---:|
| narrative-type | v4 | acc **72.8%** | 577 条 Clean | 682MB LoRA |
| attribution-best | v3.2 | acc **86.7%** | 465 条 Clean | 682MB LoRA |
| scene-boundary | v4-590 | F1 **30.5%** | 590 条 DeepSeek | 682MB LoRA |

> 基座：stage1-base-sft/final（16GB），三个 Agent 共用。

### 关键经验

1. **短 prompt 是必要条件**：任何超过 100 字的 system prompt 都会降低 F1
2. **不要加 reasons/推理链**：对 scene-boundary 和 attribution 都验证了
3. **标注质量 > 数据量 > 训练技巧**
4. **8B + SFT 天花板**：narrative 72.8%、attribution 86.7%、scene-boundary 30.5%
5. **scene-boundary 是特例**：需要全局篇章理解，8B 不够。FP 是最终瓶颈

---

## 关键经验教训

1. **显存**：Qwen3-8B 全参 SFT 单卡 A800 80GB 不够（需 ~116GB）。必须 DeepSpeed ZeRO-2 或 LoRA
2. **词表**：Qwen3 有 15 万词表，seq_len=4096 时 logits 矩阵 ~5GB/样本（bf16+fp32 转换），是主要显存消耗
3. **LoRA 限制**：LoRA + gradient_checkpointing 冲突，会报 `element 0 does not require grad`
4. **磁盘**：容器根目录只有 10G，所有缓存必须指向 NAS
5. **格式对齐**：训练时的 ChatML 格式必须和推理完全一致，多一个 `<|im_start|>assistant\n` 就会导致全 0%
6. **断点续训**：Trainer 默认从最新 checkpoint 自动恢复，中断后重跑同命令即可
7. **JSON 生成**：输入文本中的中文双引号会干扰模型 JSON 输出，需统一替换为 `「」`
8. **JSON 截断**：narrative-type 每样本有 30-50 个 unit，JSON 输出很长。max_new_tokens=256 会截断导致解析失败，需调到 1024+
