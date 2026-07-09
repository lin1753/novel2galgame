# Qwen3-8B 三 Agent 小说分析 — 完整项目记录

## 项目目标

将 Qwen3-8B（8.3B 参数）微调为三个中文小说分析 Agent，每个 Agent 在 Stage 1 全参 SFT 基座上用 LoRA 独立训练。

| Agent | 任务 | 输入 → 输出 |
|-------|------|-------------|
| Narrative Type Classification | 叙事单元分类 | 已切分 unit 序列 → 每个 unit 的类型 |
| Scene Boundary Detection | 场景边界检测 | 编号段落序列 → 场景切换位置列表 |
| Attribution Best Candidate | 对话归因 | 候选角色 + 上下文 + 目标对话 → 最可能说话人 |

---

## 第一章：基础设施建设（2026-06-10 ~ 06-14）

### 1.1 环境搭建

**硬件**：8× NVIDIA A800-SXM4-80GB（80GB 显存/卡），Kubernetes Pod，NAS 挂载 `/workspace/project-nas-1000073/`

**约束**：
- 容器根目录仅 10GB → 所有缓存必须指向 NAS
- 公司网络阻断 huggingface.co → ModelScope 下载模型
- 其他用户共享 GPU → 需检查空闲卡

**模型下载**：
```bash
modelscope download --model Qwen/Qwen3-8B \
    --local_dir /workspace/project-nas-1000073/<your-username>/models/Qwen3-8B
```

### 1.2 Stage 1：全参 SFT（学习小说叙事风格）

**数据**：72,573 条小说续写数据（`continuation.jsonl` 36,092 + `instruction.jsonl` 36,481）

**格式**：ChatML（`<|im_start|>system/user/assistant`）

**调试历程**（7 次失败 → 最终成功）：

| # | 错误 | 原因 | 解决 |
|---|------|------|------|
| 1 | `No module named 'peft'` | 脚本无条件 import peft | 按需 import |
| 2 | `No space left on device` | 8 进程并行 map 写满 10G 根目录 | `HF_HOME` 指向 NAS |
| 3 | `huggingface.co timeout` | 公司网络不通外网 | ModelScope 下载 |
| 4 | **单卡 OOM (78G/80G)** | 全量微调需 ~116GB/卡 | 上 4 卡 |
| 5 | **4 卡 DDP 仍 OOM (79G/80G)** | DDP 每卡存完整 AdamW 状态 | DeepSpeed ZeRO-2 |
| 6 | **ZeRO-2 backward OOM** | 内存碎片，需 2.8G 但仅 2.5G | `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` |
| 7 | **预估 26 小时** | seq_len 4096 太慢 | 降到 2048，epochs 3→2，batch 2→4 |

**最终配置**：
```
4×A800 + DeepSpeed ZeRO-2
seq_len=2048, batch=4/卡, grad_accum=4 → effective_batch=64
epochs=2, lr=2e-5, AdamW fused, bf16, warmup=3%
总步数 2268, 耗时 ~9h, loss 3.36→2.47
```

**产物**：`checkpoints/stage1-base-sft/final/`（16GB，4 个 safetensors 分片）

**关键教训**：
- Qwen3-8B 15 万词表，seq_len=4096 时 logits 矩阵 ~5GB/样本 — 是主要显存消耗
- DeepSpeed ZeRO-2 将单卡显存从 ~116GB 降到 ~66GB
- 所有缓存必须指向 NAS，根目录只有 10G

---

## 第二章：三个 Agent 的原始训练（2026-06-12 ~ 06-17）

### 2.1 第一个关键 Bug：格式对齐

**现象**：Stage 2 训练后模型全输出 0%，JSON 解析率 0%

**根因**：训练脚本的 `format_qwen3()` 在消息末尾加了 `<|im_start|>assistant\n`，导致模型以为 assistant 已经开始说话。推理时 Trainer 又自动补了一次，格式错位。

**修复**：去掉训练时的尾随 `<|im_start|>assistant\n`。这是整个项目**最关键的 bug**。

### 2.2 第二个关键 Bug：数据格式

**现象**：narrative-type JSON 解析率仅 2.6%

**根因**：model.generate 中 `max_new_tokens=256` 过小，narrative 输出 30-50 unit × ~20 token/unit ≈ 600-1000 token

**修复**：max_new_tokens → 1024。修复后 JSON 解析率从 2.6%→100%，类型准确率从"看似 2.6%"变成真实的 63.6%，最终扩标后到 69.5%。

### 2.3 数据版本演进

| 版本 | train | 说明 |
|------|:---:|------|
| v1 | 56/65/52 | 端到端（切分+分类+原因），每任务 ~60 条 |
| v2 | 280/280/240 | 简化任务（去掉切分和原因），扩标 |
| v3 | 310/280/240 | Clean 标注，进一步拆分任务 |
| v3.1 | 310/280/240 | epochs 3→5, LR 2e-4→1e-4 |
| v3.2 | 577/384/465 | 补 reasons + 修正引号 + 扩标 |

### 2.4 初始三 Agent 结果（v3.1/v3.2）

| Agent | 版本 | 指标 |
|-------|:---:|:---:|
| narrative-type | v3.2 | acc **69.5%** |
| scene-boundary | v3.1 | F1 **28.6%** |
| attribution-best | v3.2 | acc **86.7%** |

narrative 和 attribution 基本达标。**scene-boundary 28.6% 成为接下来整个项目的焦点。**

---

## 第三章：Scene Boundary 攻坚战（2026-06-17 ~ 06-20）

### 3.1 为什么 Scene Boundary 这么难？

对比三个 Agent 的任务本质：

| | narrative-type | attribution-best | scene-boundary |
|------|:---:|:---:|:---:|
| 判断粒度 | 逐句局部 | 逐句局部 | **全局篇章** |
| 输出长度 | 30-50 unit JSON | 1 行 JSON | 0-4 个数字 |
| 正负样本比 | 均衡（5 类） | 均衡 | **极度失衡（1:9）** |
| 需要能力 | 语义分类 | 角色推理 | **叙事结构理解** |

前两个 Agent 是**局部任务**：看完当前 unit/句子就能判断。Scene boundary 是**全局任务**：需要通读 10-20 段才知在哪切。8B 模型的全局注意力容量可能不够。

### 3.2 格式改进三连败（v3.2 → v3.4）

**v3.2**：在 v3.1 基础上加 reasons 输出，扩标 280→384
- 结果：F1 从 28.6% **跌到 20.0%**
- 根因：735 字长 system prompt + reasons 输出，增加模型负担
- 教训：**简单 = 好**

**v3.3**：二元决策格式 — 强制为每个相邻对输出 change:true/false
- 思路：消除"只列正样本"的退化策略
- 结果：F1 **15.4%**。模型学到"全 false + 恰 1 个 true"
- 教训：**SFT loss 和 F1 不对齐** — 91% 负样本，"全 false"即最低 loss

**v3.4**：滑动窗口 pairwise — 每个相邻对独立成样本
- 思路：全局任务降维成局部判断
- 结果：F1 **12.0%**。eval_loss 从 1.47→1.91 反涨
- 教训：**模型仍然学会"全 false"**

### 3.3 训练方法改进（v3.5）

**v3.5**：Best-of-N 迭代训练（简化 GRPO）
- 思路：每轮生成 3 个候选，F1 评分，选最佳重新 SFT
- 结果：F1 20.0%→21.4%，微涨 1.4pp
- 教训：**奖励信号太弱**，F1 和 LM loss 不对齐

### 3.4 揭穿 v2=53.3% 的真相（v3.6）

**关键发现**：v2 和 v3 用的是**同一批 35 条测试 passage**，但标注不同！

- v2 gold labels: 44 个边界
- v3.2 gold labels: 39 个边界
- 两个 sample 标注完全不同（一个 6 boundary vs 1 boundary）

**v3.6**：v2 的 95 字短 prompt + v3.2 的 384 条数据
- 结果：F1 **28.2%**，追平 v3.1 最佳
- 证实：短 prompt 是必要条件（vs 735 字长 prompt 差 ~8pp）
- 推测：v2=53.3% 和 v3=28.6% 的差距主要来自**标注标准不同**

### 3.5 DeepSeek 重标注（v4 系列）

**思路**：v2=53.3% 证明瓶颈是标注不是模型。用 DeepSeek API 按简单标准从头重标注。

**v4-296**：第一批 DeepSeek 标注，296 train
- 结果：F1=26.7%，但 eval_loss **首次下降**（之前所有版本 eval_loss 反涨）

**v4-590** ⭐：扩标到 590 train + v2 短 prompt
- eval_loss 持续下降：1.92→1.74→1.57→1.51
- F1=**30.5%**，首次突破 30%
- **FP 仍是主要问题**：27 TP vs 70 FP

**v4.1-1804**：三倍数据量（1804 train）
- eval_loss 创新低：1.74→1.32
- F1=29.9%，**不升反降**
- 教训：大量快速标注牺牲了一致性

**v4.1-582 精炼版**：筛选 ≥2 边界样本，边界密度 15.6%
- 在自己高密度测试集上 F1=30.2%，低密度测试集仅 25.9%
- 教训：模型过度依赖训练集边界密度，泛化差

### 3.6 可视化终评

生成 `scene_boundary_final_viz.png`：6 面板对比 v4-590 vs v4.1，确认 FP 位置集中在 1-3，所有样本 FP 主导。

### 3.7 Scene Boundary 全版本汇总

```
v1(33%) → v2(53%) → v3(20%) → v3.1(29%) → v3.2(20%) → v3.3(15%)
→ v3.4(12%) → v3.5(21%) → v3.6(28%) → v4-296(27%) → v4-590(31%)⭐
→ v4.1-1804(30%) → v4.1-582(30%)
```

**最终结论**：8B + SFT 在 v4 标注上天花板 ≈ 30% F1。FP 是最终瓶颈，继续突破需 GRPO/DPO 或换更大基座。

---

## 第四章：收尾优化（2026-06-21）

### 4.1 Attribution 推理链实验失败

**思路**：在 attribution 输出加 `reasoning` 字段强制推理

**结果**：准确率 86.7%→**80.0%**（跌 7pp）。模型学会套模板（"上下文信息不足"）不看内容。与 scene-boundary 加 reasons 失败规律一致。

### 4.2 Narrative 重训成功

**思路**：8 卡 DDP 重训，同 v3.2 数据 + LoRA 配置

**结果**：准确率 69.5%→**72.8%**（+3.3pp），1526 个 unit，每类型均有提升：

| 类型 | 准确率 |
|------|:---:|
| narration | 82% |
| dialogue | 70% |
| thought | 62% |
| action | 58% |
| scene_description | 54% |

---

## 第五章：最终成果

| Agent | 最佳版本 | 指标 | 训练数据 | 模型 |
|-------|:---:|:---:|:---:|------|
| narrative-type | v4 | acc **72.8%** | 577 Clean | `narrative-type-v4.tar.gz` |
| attribution-best | v3.2 | acc **86.7%** | 465 Clean | `agents_best.tar.gz` |
| scene-boundary | v4-590 | F1 **30.5%** | 590 DeepSeek | `scene-boundary-v4-590-best.tar.gz` |

> 三个 Agent 共用 Stage 1 基座 `stage1-base-sft/final/`（16GB），每个 Agent 独立 682MB LoRA adapter。

---

## 第六章：十条核心经验

### 1. 短 system prompt 是硬要求
95 字 vs 735 字 → ~8pp F1 差距。长 prompt 挤占 4096 context window 的 18%，8B 模型注意力被稀释。

### 2. 不要加 reasons/推理链
scene-boundary 和 attribution 两个 Agent 都验证了：加 reasons 只会让模型学会套模板。简单输出 = 好。

### 3. ChatML 格式必须精确匹配
训练和推理的 `<|im_start|>assistant\n` 位置不一致 → 全 0%。整个项目最关键的 bug。

### 4. SFT 的 LM loss 和业务指标不对齐
scene-boundary 的全部格式改进都失败在这个点上。LM loss 优化的最优策略 = "全 false"（91% 准确率），但 F1=0%。

### 5. 标注质量 > 数据量 > 训练技巧
DeepSeek 重标注是唯一有效突破。三倍数据量（1804 条）未提升。

### 6. 局部任务好于全局任务
narrative-type（逐 unit 分类）和 attribution（逐句判断）好于 scene-boundary（全局结构理解）。

### 7. 评估指标的欺骗性
eval_loss 持续下降不代表 F1 上升（v4.1-1804 eval_loss=1.32 但 F1=29.9%）。在极端不平衡任务上，loss 和业务指标脱钩。

### 8. 数据边界密度影响模型泛化
模型学会训练集的边界密度，换密度不同的测试集时 F1 崩盘。

### 9. GPU 显存管理的三个关键
- Qwen3-8B 全参需 DeepSpeed ZeRO-2
- LoRA 不能和 gradient_checkpointing 并存
- LoRA 推理仅需 ~19GB 显存

### 10. 增量实验的价值
12 次 scene-boundary 实验每次只改一个变量，才能精确归因。如果一次改多个（比如同时改 prompt + 格式 + 数据），永远不知道哪个有效。

---

## 环境配置速查

```
GPU:   8× NVIDIA A800-SXM4-80GB
CUDA:  12.4
Python: 3.12.7
PyTorch: 2.7.1
Transformers: 4.57.1
PEFT:  最新版
DeepSpeed: 已安装 (ZeRO Stage 2)
NAS:   /workspace/project-nas-1000073/ (9.6P)
```

**单卡训练**：
```bash
CUDA_VISIBLE_DEVICES=4 python3 scripts/train_xxx.py
```

**8 卡 DDP 训练**：
```bash
torchrun --nproc_per_node=8 scripts/train_xxx_8gpu.py
```
