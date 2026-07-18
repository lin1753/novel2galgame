# 面试准备：All Novel Can Be Galgame 项目讲解

> 面试前 30 分钟快速过一遍。重点记数字、金句和追问应对。

---

## 一、30 秒电梯演讲

> "我独立开发了一个 AI 工作台，叫 **All Novel Can Be Galgame**。核心功能是把中文恋爱小说自动转化成可玩的视觉小说（Galgame）。技术上是 TypeScript monorepo，包含 9 个 AI Agent 组成的流水线、自研 VN 播放引擎、RAG 知识检索系统、以及 Ren'Py 游戏导出器。还基于 Qwen3-8B 用 669 本小说训练了 3 个专用 LoRA 模型发布在 HuggingFace 上。全流程端到端可运行——上传 txt 小说，一键导出可游玩的 Galgame。"

---

## 二、项目全景图

**一句话定位**：不是创意改编工具，是忠实的叙事转译器（Narrative-to-VN Converter）

### 核心流程

```
txt小说 → Structure(章节切分) → Narrative Parsing(叙事分类)
→ Attribution(角色归因) → Scene Segmentation(场景切分)
→ VN Mapping + Visual Prompt(并行) → Fidelity Review(保真审查)
→ Consistency Review(跨章一致) → Web预览 / Ren'Py导出
```

### 技术栈

| 类别 | 选型 |
|------|------|
| Monorepo | pnpm workspaces + Turborepo |
| 语言 | TypeScript 全栈 |
| 后端 | Node.js + Express + SQLite (better-sqlite3) |
| 前端 | React 19 + Vite 6 + Tailwind CSS 4 + Zustand + TanStack Query |
| LLM | Agnes AI / OpenAI 兼容 / DeepSeek / 本地 SFT |
| 本地模型 | Qwen3-8B SFT + 3×LoRA (bitsandbytes 4-bit 量化) |
| RAG | bge-small-zh-v1.5 + BM25 Hybrid + LLM 重排序 |
| 图像/视频 | Agnes Image/Video + OpenAI + Zhipu |
| 导出 | Ren'Py Builder Pattern |
| 产品闭环 | Novel → Pipeline → IR → Ren'Py Export → 可运行 Galgame |

---

## 三、核心技术亮点

### 亮点 1：系统架构——IR 作为 Single Source of Truth

**IR 架构（最核心的设计决策）**：

```
AI Agent → VN Script IR v1.0 (JSON DSL, 冻结)
              ├→ Web Preview Runtime
              └→ Ren'Py Export
```

- 8 种 VN Step 类型（bg/show/hide/narration/say/thought/pause/transition），冻结不可变
- 所有 Agent 只输出 IR，不直接生成 Ren'Py/HTML/其他格式
- Exporter 和 Runtime 只依赖 IR Schema，不依赖 Agent 实现
- **换引擎只需新 Exporter，Pipeline 完全不动**

> **金句**: "IR 是 Single Source of Truth——Agent 不直接输出 Ren'Py，输出的是一个冻结的 JSON DSL。换引擎只需要写新 Exporter。"

**Monorepo 分层**：9 packages + 2 apps，每个 package 职责单一

| Package | 职责 |
|---------|------|
| `ir` | VN Script IR v1.0 Zod Schema |
| `core` | 12 个领域模型 + 10 个 Zod Schema |
| `agents` | 9 个 AI Agent（每个有禁止行为清单） |
| `providers` | LLM/Image/Video Provider 抽象层 |
| `storage` | SQLite 索引 + 文件系统混合存储 |
| `runtime` | 自研 VN 播放引擎（8 种步骤类型执行器） |
| `export` | Ren'Py Builder Pattern 导出器 |
| `rag` | RAG 知识检索 |
| `evaluation` | 评测框架（6 个 Agent × 3 类指标） |
| `api` | REST API + Task Queue + SSE |
| `workbench` | React SPA 工作台（12 个页面） |

---

### 亮点 2：AI 工程——4 层能力分层 + Pipeline 韧性

**4 层 AI 能力分层**：

| 层级 | 定位 | 负责内容 |
|------|------|---------|
| L0 规则层 | 本地执行，成本极低 | 编码检测、章节格式匹配、文本清洗 |
| L1 轻量模型层 | 未来候选生成 | 留接口，当前本地部署 |
| L2 强模型 API | 复杂语义理解 | 叙事解析、归因、切分、VN 映射、保真审查 |
| L3 路由调度层 | 缓存/重试/回退/预算 | Orchestrator |

**Per-Agent 模型路由**：前 3 个 Agent 支持本地 SFT 和云端 API 自由切换，运行时换 profile 不需重启。

**Pipeline 韧性（最能展示工程深度的点）**：

| 机制 | 效果 |
|------|------|
| 断点续跑 | 失败重跑自动跳过已完成 stage，省 80% token |
| SHA256 缓存 | 同输入瞬间返回，零 LLM 调用 |
| AbortController | 前端可随时取消运行中管线 |
| 崩溃恢复 | API 重启后自动标记 crashed 任务 |

> **金句**: "做 AI 管线最难的不是单个 Agent，而是链路的鲁棒性。这些工程细节才是管线能稳定跑完 90 章的关键。"

**实战踩坑（展示真实经验）**：
- GBK/GB18030 编码自动检测
- `repairJson()` 处理免费 API 的 token 截断
- 不同 LLM JSON 字段名不一致 → normalize 层统一
- IPv6/IPv4 双栈导致 TLS 握手失败
- 共享 https.Agent 导致偶发断连
- Chapter ID 全局冲突 → project 前缀解决方案

---

### 亮点 3：模型训练——从零到 HuggingFace

**训练规模**：
- 基座：Qwen3-8B-Instruct 全参微调
- 数据：669 本中文网络小说，约 7200 万字符
- 硬件：8× NVIDIA A800-80GB (Kubernetes Pod)
- Stage 1：72,573 条数据，DeepSpeed ZeRO-2，~9h
- Stage 2：3 个 LoRA adapter (r=64 α=128)

**成果**：

| LoRA | 准确率 | 数据量 |
|------|--------|--------|
| Narrative Parsing | 72.8% | 577 条 |
| Attribution | 86.7% | 465 条 |
| Scene Segmentation | 30.5% F1 | 590 条 |

**训练洞察**：
- 短 system prompt 比长 prompt 好 ~8pp F1
- reasoning 链让小模型学会套模板而非推理
- 8B + SFT 场景边界天花板约 30%，需 GRPO/DPO 突破

> **金句**: "训练过程中发现短 prompt 比长 prompt 效果好 8 个百分点，reasoning 链会让小模型学会套模板——这些都是在真实训练中踩的坑。"

**本地部署**：WSL2 + bitsandbytes 4-bit 量化 → 16GB 模型塞进 RTX 4060 8GB

---

### 亮点 4：RAG——跨章节知识检索

**架构**：
```
Pipeline 运行时:
  narrative agent  ← listKnownCharacters() → "已有角色: 苏雨晴, 林晓..."
  attribution agent ← searchCharacters()    → "苏雨晴: 长发, 白裙, 淡蓝眼睛"
  segmentation agent ← searchScenePatterns() → "前几章分割模式: 每2-3场景变化"
```

**技术选型**：

| 组件 | 选型 | 原因 |
|------|------|------|
| 嵌入 | bge-small-zh-v1.5 (512-dim) | CPU 实时推理，中文小说优化 |
| 检索 | BM25 + 向量 Hybrid (0.6:0.4) | 关键词 + 语义互补 |
| 重排 | LLM relevance scoring | 粗筛 top-10 → LLM → top-3 |
| 去重 | upsert by characterId | 新章节覆盖旧数据 |

**效果**：Segmentation 场景数匹配率 67% → 73%（+7%）

> **金句**: "跨章节一致性——第 5 章的角色在第 1 章长什么样，模型会忘。RAG 系统让 Pipeline 运行时实时注入已知角色信息，场景切分准确率提升 7 个百分点。"

---

### 亮点 5：产品思维——边界清晰比功能全面更难

**5 条核心原则**：
1. **原文事实不可更改**——事件、行为、台词、关系、顺序
2. **AI 只做结构化和舞台化**——不发明剧情、不改写台词
3. **用户只控制表现，不控制内容**——调风格/节奏/忠实度
4. **输出"忠实改编脚本"**——不是二创重写
5. **本地工作台掌控流程与数据**——不是纯云端 SaaS

**设计约束**：对话保留率 ≥ 95%，非原文添加 ≤ 5%

> **金句**: "我刻意不做自由改编、不做剧情分支——边界清晰的产品更难做，但更可能落地。技术上这反而更难——AI 要准确理解原文，不能靠'自由发挥'掩盖理解不足。"

---

## 四、面试追问速答

**Q: 为什么不用 LangChain？**
> 评估过，Pipeline 控制粒度不够。我需要精确的 prompt 模板、输出 schema、禁止行为清单、缓存和重试策略——框架反而增加调试成本。Provider 层 200 行代码基于 node:https，完全够用。

**Q: 一个人做了多久？**
> 5-6 周。2026.06 到 07 中旬，MVP 闭环。核心驱动力是 Claude Code AI 辅助编程——我做架构设计、code review 和集成测试。

**Q: 最大技术挑战？**
> 三个：(1) 场景边界天花板 30% F1——叙事理解问题不是模式匹配；(2) 管线韧性——免费 API 偶发超时/截断/500；(3) LLM 输出结构化——不同模型 JSON 字段不一致需要 normalize。

**Q: 30.5% F1 怎么解决？**
> 低于阈值回退 LLM API，本地 SFT 做候选、强模型做最终裁决。下一步 GRPO/DPO 替代 SFT。

**Q: 为什么 monorepo？**
> 9 个 Agent、多个 Provider 之间复杂依赖。改 IR Schema 后 agents/runtime/export 自动重编——multi-repo 不可能高效完成。

**Q: 为什么 SQLite？**
> 本地工作台定位。零配置零运维，better-sqlite3 同步 API 性能极好，WAL 模式支持读写并发。数据文件可随项目迁移。

**Q: 为什么 bge-small-zh 而不是更强的？**
> 权衡。512-dim CPU 实时推理，不占 GPU。BM25 关键词补齐稀疏特征短板——对角色外观检索足够。

**Q: 扩展到多人协作？**
> 三个改动：SQLite→PostgreSQL（Repository 抽象已有）；Pipeline→消息队列（BullMQ）；文件存储→对象存储（S3）。核心 Agent 逻辑可复用。

---

## 五、数字速查

| 项目 | 数字 |
|------|------|
| Agent 数量 | 9（7 生产 + 2 审查） |
| VN Step 类型 | 8 种 |
| 状态机 | Project(9) / Chapter(8) / Scene(6) |
| 训练数据 | 669 本，7200 万字符 |
| 训练硬件 | 8× A800-80GB |
| LoRA | r=64 α=128 |
| Narrative 准确率 | 72.8% |
| Attribution 准确率 | 86.7% |
| RAG 提升 | Segmentation +7% |
| 前端构建 | 355KB JS + 23.5KB CSS |
| Packages + Apps | 9 + 2 |
| 开发周期 | ~5-6 周 |
| HuggingFace 模型 | 4 个 (1 base + 3 LoRA) |

---

## 六、加分金句汇总

1. **架构**: "IR 是 Single Source of Truth——Agent 不直接输出 Ren'Py，换引擎只需要写新 Exporter。"
2. **工程**: "LLM 输出不可靠——不同模型 JSON 字段不一致、token 截断。我做了 normalize 层 + repairJson 兜底。"
3. **产品**: "边界清晰的产品更难做但更可能落地。不改剧情、不改台词——忠实转译而非创意改编。"
4. **实战**: "WSL2 + bitsandbytes 4-bit 量化——16GB 模型塞进 8GB RTX 4060。"
5. **诚实自省**: "30% F1 是技术债务，但也让我深刻理解了 SFT 天花板和 RLHF 必要性。"

---

## 七、按岗位调整侧重点

| 面试岗位 | 重点展开 | 淡化 |
|---------|---------|------|
| 全栈/前端 | Monorepo 架构、IR 设计、React 工作台、SSE 实时推送 | LoRA 训练细节 |
| 后端/架构 | Pipeline 韧性、缓存策略、状态机、Provider 抽象 | 前端页面细节 |
| AI/ML 工程 | 模型训练、SFT 天花板、RAG 系统、评测框架 | Ren'Py 导出 |
| 产品经理 | 产品原则、设计约束、用户控制范围 | 实现细节 |

---

## 八、岗位专项模拟：图像AI应用工程师（广州暮嫣科技）

> 岗位核心：ComfyUI/SD 工作流 + 图片处理管线 + API 集成 + 视频剪辑 + 业务系统对接

### 匹配度分析

| 岗位要求 | novel2galgame 对应经验 | 匹配度 |
|---------|----------------------|--------|
| ComfyUI/SD 工作流搭建 | Provider 抽象层 + 多模型路由 + 图像生成管线 | ⚠️ 概念匹配，需补充 ComfyUI 具体经验 |
| 图片后期处理管线 | Asset Pipeline + 占位图生成 + manifest 管理 | ⚠️ 流程设计经验有，具体图像算法需补充 |
| 图像生成 API 集成 | Agnes/OpenAI/Zhipu/SiliconFlow 四套 Provider | ✅ 完全匹配 |
| 批量异步处理 + 优先级队列 | Pipeline Task Queue + SSE + 断点续跑 | ✅ 完全匹配 |
| 错误重试 + 并发控制 | 三级失败策略 + AbortController + 限流 | ✅ 完全匹配 |
| FFmpeg/OpenCV | 视频生成管线（Agnes Video + 异步轮询） | ⚠️ 有视频处理概念，FFmpeg 需补充 |
| CMS/后台对接 | REST API(41端点) + 状态管理 + SSE 推送 | ✅ 完全匹配 |
| 成本优化 + 缓存策略 | SHA256 缓存 + 预算模式 + Provider 热切换 | ✅ 完全匹配 |
| **加分**: LoRA 训练 | 3 个 LoRA adapter (r=64 α=128) | ✅ 完全匹配 |
| **加分**: 批量任务调度 | Pipeline Task Queue 系统 | ✅ 完全匹配 |
| **加分**: RESTful API 开发 | Express + 41 端点 + Zod 校验 | ✅ 完全匹配 |

---

### Q1: 请简单介绍你自己和你的项目经验（开场必问）

**回答策略**: 2 分钟，聚焦图像 + 管线 + API 三点。

> "我叫 Yupeng Lin，独立开发了一个全栈 AI 项目叫 All Novel Can Be Galgame，核心是把中文小说自动转成可玩的视觉小说。
>
> 跟这个岗位最相关的有三块：
>
> **第一，多供应商图像生成集成。** 我封装了 Agnes Image、OpenAI、Zhipu、SiliconFlow 四套图像生成 API，通过统一的 Provider 接口抽象——业务代码不感知底层供应商，可以热切换。支持文生图、图生图，有完整的配置管理、鉴权、错误重试。
>
> **第二，任务调度管线。** 我设计了一套 Pipeline Task Queue 系统——支持批量异步处理、断点续跑、SHA256 缓存、三级失败策略（软失败/可恢复/硬失败）。单次运行可以并行处理多章节，SSE 实时推送进度。这套思路跟图像批处理管线完全相通。
>
> **第三，模型训练经验。** 我在 8×A800 上基于 Qwen3-8B 做了全参微调 + 3 个 LoRA adapter，训练数据来自 669 本小说。深入理解了 SFT 的天花板、LoRA 参数调优、数据质量的重要性。
>
> 另外我了解 ComfyUI 的节点化工作流理念——我之前设计的 Agent Pipeline 就是类似的 DAG 编排思路，只是用的是 TypeScript 而非 Python。我对 Python 也很熟悉，训练脚本和评测脚本都是 Python 写的。"

---

### Q2: 你熟悉 ComfyUI 吗？能搭建复杂工作流吗？（核心技能）

**回答策略**: 坦诚没有深度使用经验，但展示理解 + 迁移能力。

> "坦白说我目前没有在生产环境中深度使用 ComfyUI，但我非常了解它的核心理念——基于节点的 DAG 工作流编排、JSON 格式的工作流导出、API 驱动的自动化。
>
> 我在项目里设计的 9 个 Agent Pipeline 本质上就是一个类似的工作流编排系统——每个 Agent 是节点，有明确的输入输出 Schema、上下游依赖、并行/串行策略。两者的核心概念高度一致：
>
> | ComfyUI | novel2galgame Pipeline |
> |---------|----------------------|
> | 节点 (LoadImage, KSampler, VAEDecode...) | Agent (Structure, Narrative, Attribution...) |
> | 连线（数据流） | 上下游依赖 + Zod Schema 校验 |
> | 工作流 JSON | Pipeline 配置 + IR 定义 |
> | ComfyUI API 调用 | Express REST API 驱动 Pipeline |
>
> 对于这个岗位的场景——搭建电商图生图工作流——我理解核心流程大概是：
> ```
> 商品图输入 → ControlNet(保持产品结构) → IP-Adapter(参考风格) 
> → SD Inpainting(局部重绘/换背景) → Upscale(高清修复) → 输出
> ```
> 我上手 ComfyUI 会很快，因为底层概念我已经在实战中用过了。给我两周时间，我可以用 ComfyUI + Python 脚本搭出可复用的电商图生图工作流。"

---

### Q3: 你怎么做 API 集成？处理过鉴权、限流、异步回调吗？（核心技能，高匹配）

**回答策略**: 拿 Provider 层的实际代码和踩坑经验说话。

> "这是我的强项。在我的项目里我封装了完整的 Provider 抽象层，支持 3 类 AI 能力的 API 集成：LLM、Image、Video。
>
> **鉴权处理**：每个 Provider 通过 `model-profiles.json` 配置——apiKey、baseUrl、defaultModel 集中管理。不同供应商的鉴权方式（Bearer Token、API Key Header）统一在 Provider 构造函数处理，业务代码无感知。
>
> **限流与重试**：我实现了三级失败策略——
> - **Soft Fail**：临时错误（如 429 Rate Limit、临时 500），指数退避重试，最多 3 次
> - **Recoverable Fail**：超时或网络错误，降级到备用 Provider
> - **Hard Fail**：认证失败或参数错误，直接报错停止
>
> **异步回调**：视频生成是最典型的场景——Agnes Video API 是异步的，提交任务后返回 task_id，需要轮询状态（queued→in_progress→completed/failed）。我实现了 `waitForCompletion()` 方法，支持可配置的轮询间隔和超时时间，完成后通过回调通知上游。
>
> **踩过的坑**：
> - 共享 `https.Agent` 导致连接复用偶发断连 → 改为每次请求独立连接
> - IPv6/IPv4 双栈 TLS 握手失败 → 去掉 family 强制
> - API 返回 JSON 字段名不一致 → normalize 层统一
>
> 这些经验直接适用于对接 GPT/Flux 等图像生成 API 的场景。"

---

### Q4: 你设计过批量任务调度系统吗？（加分项，高匹配）

**回答策略**: 详细描述 Pipeline Task Queue 的设计。

> "是的，我的项目核心就是一个批量任务调度系统。场景是：用户上传一本 90 章的小说，系统需要逐章跑 9 个 Agent Pipeline，每个 Agent 调用 LLM API。
>
> **核心设计**：
> - **队列模型**：Chapter Pipeline 是基本执行单元，每个 Chapter 内 6 个 stage 顺序执行，不同 Chapter 之间可以并行
> - **状态管理**：三级状态机——Project(9态) / Chapter(8态) / Scene(6态)——持久化到 SQLite
> - **进度推送**：SSE 实时广播每个 stage 的开始/完成/失败，前端跨页面不丢失
>
> **关键机制**：
> | 机制 | 实现方式 |
> |------|---------|
> | 断点续跑 | 失败重跑自动跳过已完成的 stage，省 80% token |
> | 缓存去重 | SHA256 哈希输入 → 相同输入直接返回缓存，零 API 调用 |
> | 取消控制 | AbortController 信号传递到每个 Agent，前端可随时中止 |
> | 崩溃恢复 | API 重启后扫描 running 状态任务，标记为 crashed 待重试 |
>
> **这个设计直接对接到你们的电商场景**：
> ```
> 批量上传商品图 → 入队 → 并行处理(ComfyUI工作流) 
> → 状态追踪 → 结果回调 → 写入CMS
> ```
> 改动只是在执行单元从 Agent 换成 ComfyUI API 调用，调度框架可以复用。"

---

### Q5: 你做过图片后期处理吗？（背景移除、高清修复、风格迁移等）

**回答策略**: 坦诚项目中没有深度做，但展示相关概念和迁移思路。

> "我的项目核心是文本到图像的生成管线，图片后处理不是主要部分。但我设计了 Asset Pipeline 的资源管理流程——从 IR 中提取资源需求 → 生成 Asset Manifest → 调用图像 API 生成 → 缓存 → 导出，这套流程跟图片后期处理管线的架构完全一致：
>
> ```
> 原始商品图 → 背景移除(rembg/SAM) → 高清修复(Real-ESRGAN) 
> → 风格迁移(IP-Adapter) → 输出到CMS
> ```
>
> 我可以把管道中的图像生成节点替换为后处理节点，用同样的调度框架驱动。具体的图像处理工具（OpenCV、rembg、Real-ESRGAN）我之前在 Python 学习中有接触，上手不会慢。
>
> 另外补充一点：我对 Stable Diffusion 的生态比较熟悉——理解 ControlNet（Canny/Depth/OpenPose/Scribble）、IP-Adapter（图像提示适配）、Inpainting（蒙版重绘）、Tiled Diffusion（分块放大）——这些是我在调研图像生成方案时深入了解过的。"

---

### Q6: 你有 FFmpeg / OpenCV 视频处理经验吗？

**回答策略**: 有限但有关联经验，展示学习和迁移能力。

> "FFmpeg 我有基础使用经验——了解视频剪切、合并、转码、抽帧、加水印的核心命令行操作。
>
> 在视频生成方面，我的项目集成了 Agnes Video API（文生视频、图生视频、关键帧动画），处理了异步任务轮询、状态管理、结果回调——这些概念跟短视频智能剪辑工作流是一致的。
>
> 对于你们需要的 **短视频智能剪辑工作流**，我理解核心流程是：
> ```
> 素材导入 → FFmpeg抽帧关键帧 → 分析(BGM节奏/转场点)
> → 自动踩点剪辑 → 字幕生成(ASR/TTS) → 合成导出
> ```
>
> 我用 Python 做过多个自动化脚本项目（YOLO 推理管线、标注工具、训练脚本），把 FFmpeg 命令 wrapper 成 Python 函数对我来说是熟悉的模式。OpenCV 的视频处理（读取帧、写入视频、绘制标注框）我在图像标注项目中也使用过。"

---

### Q7: 你怎么做成本控制？如何优化 API 调用成本？

**回答策略**: 这是强项，直接拿 SHA256 缓存 + 预算模式 + Provider 热切换讲。

> "成本控制是我项目中的核心设计考量，因为我用的是免费额度的 API，每个 token 都要精打细算。
>
> **1. SHA256 输入缓存（最有效的优化）**：
> 同一个输入（相同的 prompt + 参数 + 上下文）只调用一次 API，后续直接从缓存返回。对于电商场景——同一类商品反复生成类似图片——这个机制可以节省大量重复调用。
>
> **2. 预算路由模式**：
> 我设计了 3 种预算模式，可以根据任务重要性选择不同的模型：
> | 模式 | 策略 | 适用场景 |
> |------|------|---------|
> | 高质量 | 全部走最强模型 | 最终成品 |
> | 平衡 | 规则优先，复杂任务走强模型 | 日常使用 |
> | 省钱 | 能规则就规则，强模型仅关键任务 | 批量初筛 |
>
> **3. Supplier 热切换**：
> 当 API A 限流或涨价时，改一个配置项即可切换到 API B，业务代码零改动。这对应你们需求中的"供应商热切换"。
>
> **4. 并发控制与批处理**：
> 对同类请求做 batch，减少 API 调用次数——比如批量生成商品背景时，可以合并 prompt。"

---

### Q8: 如果让你从零搭建一个电商图生图系统，你会怎么设计架构？

**回答策略**: 展示系统设计能力，把项目经验完整迁移过来。

> "我会复用我在 novel2galgame 项目中验证过的架构模式，分五层设计：
>
> **第 1 层：接入层（Express REST API）**
> ```
> POST /workflows/run          # 提交工作流任务
> GET  /workflows/:id/status   # 查询任务状态
> GET  /workflows/stream       # SSE 实时进度
> POST /workflows/batch        # 批量提交
> ```
>
> **第 2 层：工作流引擎（Orchestrator）**
> - ComfyUI 工作流以 JSON 模板形式管理，支持参数化（替换 prompt、seed、尺寸等）
> - 调用 ComfyUI API 提交任务 → 轮询状态 → 获取结果
> - 每个工作流步骤有明确的输入/输出 Schema
>
> **第 3 层：任务调度层（Task Queue）**
> - 批量任务入队列，支持优先级（VIP 商品优先）
> - 并行控制（限制同时运行的 ComfyUI 任务数，避免显存 OOM）
> - 断点续跑 + 缓存 + 崩溃恢复
> - 结果回调（写入 CMS、发送通知）
>
> **第 4 层：Provider 抽象层**
> - 统一的图像生成接口：`generateImage(request) → result`
> - 支持 ComfyUI 本地、GPT Image、Flux、Nano Banana 多供应商
> - 鉴权、限流、重试、热切换透明处理
>
> **第 5 层：存储层**
> - SQLite/PostgreSQL 记录任务状态和审计日志
> - 生成图片存储到 OSS（阿里云/腾讯云）
> - 定期清理过期缓存
>
> **关键技术选型**：
> - Python + FastAPI（后端，公司要求 Python）
> - Celery + Redis（任务队列，比我自己写的 TypeScript 版本更成熟）
> - ComfyUI API（工作流执行引擎）
> - 我之前的缓存和重试逻辑迁移到 Python 版本"

---

### Q9: 你能写 Python 吗？项目不是 TypeScript 吗？（必问题）

**回答策略**: 消除语言顾虑。

> "我的项目主体是 TypeScript，但训练管线全部是 Python：
> - Qwen3-8B 全参微调 + LoRA 训练脚本（transformers, peft, DeepSpeed, bitsandbytes）
> - 数据预处理管线（669 本小说清洗、格式化、切分）
> - 评测脚本（6 个 Agent × 3 类指标的自动化评估）
> - SFT 推理服务（FastAPI serve script）
>
> 另外我独立做了一个 YOLOv8 图像标注工具项目，纯 Python：
> - `infer_yolo.py` — YOLO 模型批量推理（ultralytics, conf=0.3, imgsz=1280）
> - `annotate.py` — Tkinter GUI 标注工具（500 行）
> - `merge_check.py` — 标注合并 + OpenCV 可视化（168 行）
>
> Provider 层的 Python 化对我来说不是问题——核心逻辑（鉴权、限流、重试、缓存）是语言无关的设计模式。我选 Python 还是 TypeScript 取决于团队技术栈。"

---

### Q10: 你对 ComfyUI 的 ControlNet / LoRA / IP-Adapter 了解多少？

**回答策略**: 展示理论理解，即使没有大量实操经验。

> "我从两方面了解这些技术：
>
> **理论层面**：
> - **ControlNet**：在 SD UNet 旁路注入条件控制信号，不破坏原始模型权重。常用有 Canny（边缘约束）、Depth（深度约束）、OpenPose（姿态约束）、Scribble（涂鸦引导）。电商场景中 Canny 最实用——保持商品轮廓不变，只换背景和风格。
> - **LoRA**：低秩适配，我亲自训练过 3 个 LoRA adapter（r=64, α=128）。我知道如何调整 rank、alpha、target_modules（q_proj, v_proj）来平衡效果和文件大小。在 ComfyUI 中加载 LoRA 注入到 checkpoint 也是同一原理。
> - **IP-Adapter**：用图像 embedding 替代文本 prompt 做条件控制，比纯文本 ControlNet 更精准地控制风格和构图。电商场景中用它做风格参考图非常实用。
>
> **实战层面**：
> 我理解 ComfyUI 中一个典型的电商图生图工作流：
> ```
> LoadImage(商品白底图) → RemoveBackground → CannyEdge
>                                                      ↓
> LoadCheckpoint(SD1.5/XL) → KSampler(CN+Canny) → VAEDecode
>        ↓                                                  ↓
>   LoadLoRA(风格)                                   IP-Adapter(场景参考图)
>        ↓                                                  ↓
>   CLIPTextEncode(pos/neg prompt) ─────────────────→ KSampler
> ```
> 给我两周，我可以把这个流程完整搭建出来并封装成 API。"

---

### Q11: 说一个你解决过的最难的技术问题

**回答策略**: 选一个跟图像/API/管线相关的，有技术深度。

> "最难的问题是 **LLM API 返回结果的结构化不稳定**——不同的模型（Agnes/GPT/DeepSeek）返回的 JSON 字段名不一致，有时还会因为 token 截断导致 JSON 不完整。
>
> 这对应你们场景中的**对接多个图像 API 时输出格式不统一**的问题。
>
> 我的解决方案是三层防御：
> 1. **Schema 约束层**：Prompt 中明确指定 JSON Schema，要求模型严格输出
> 2. **Normalize 层**：每个 Agent 的输出经过 normalize 函数，将不同模型的不同字段名映射到统一格式（如 `speaker_id` vs `speakerId` vs `character` → `characterId`）
> 3. **repairJson 兜底**：如果 JSON 被截断（常见于免费 API），用启发式规则修复——补全缺失的括号、截断最后一个不完整的对象
>
> 这个设计可以直接迁移到你们的场景：不同的图像 API 返回格式不同（URL 路径、base64、OSS key），在 Provider 层做 normalize 统一后，上层业务逻辑零感知。"

---

### Q12: 你为什么想加入我们？对这个岗位的理解是什么？

**回答策略**: 展示对岗位的认真研究和匹配度。

> "我对这个岗位的理解是三个关键词：**工作流自动化**、**多系统集成**、**成本工程**。
>
> **工作流自动化**：把 ComfyUI/SD 的分散操作封装成自动化 Pipeline——这个我做过。我的 9 Agent Pipeline 就是把分散的 AI 能力编排成自动化的生产线。
>
> **多系统集成**：AI 能力要嵌入现有业务系统（CMS），需要好的 API 设计和状态管理——我在项目里做了 41 个 REST 端点、SSE 实时推送、审计日志，就是这套思路。
>
> **成本工程**：多供应商、缓存策略、预算控制、热切换——这是我项目的核心优势。
>
> 我想加入是因为这个岗位能让我把做 AI 管线架构的经验应用到一个有真实商业场景的领域——电商图像生成是确定性需求，比小说转游戏更直接地创造商业价值。而且我可以借这个机会深入 ComfyUI 和 Python 生态，补齐我在图像处理工具链方面的技能。"

---

### 面试策略总结

| 面试环节 | 策略 |
|---------|------|
| 开场自我介绍 | 聚焦图像+管线+API 三点，不提小说转译的细节 |
| ComfyUI/SD 问题 | 坦诚经验有限，但展示理解深度 + 两周上手承诺 |
| API 集成问题 | **强项，多讲**——Provider 层、重试策略、踩坑经验 |
| 任务调度问题 | **强项，多讲**——Pipeline Queue、断点续跑、缓存 |
| LoRA 训练问题 | **加分项，必提**——3 个 LoRA、数据质量、参数调优 |
| Python 能力疑问 | 亮出训练脚本 + YOLO 标注工具项目 |
| 系统设计问题 | 完整迁移 novel2galgame 架构到电商场景 |

**面试前 One More Thing**: 如果能提前用 ComfyUI 搭一个简单的电商图生图 Demo（哪怕只是 LoadImage → ControlNet Canny → KSampler → VAEDecode），面试时展示会非常加分。

---

## 九、简历项目经历

> 项目已重新定位为 RAG 驱动的长文本 LLM 内容生成系统。
> 另起纯 Agent 项目专门投 Agent 岗。

### 版本 A：大模型应用开发 / AI Engineer（RAG 为核心）

### 长篇小说智能处理与 RAG 知识增强系统
*独立开发 | 2026.06 — 2026.07 | LangGraph / TypeScript / ChromaDB / Python*

**项目简介**：面向长篇小说篇幅过长、单次 LLM 上下文窗口仅能容纳 1-2 章内容、跨章节知识遗忘严重的问题，设计并实现一套基于 RAG 的跨章节知识管理系统。支持逐章增量知识抽取与入库、多路混合检索、语义重排与检索效果回归评测。

**技术栈**：LangGraph、ChromaDB、bge-large-zh-v1.5、BM25、RRF、bge-reranker-large、Qwen3-8B SFT + LoRA、TypeScript、Node.js、React

- 为解决逐章处理时 Agent 无法访问已处理章节信息的问题，设计增量 RAG 知识管线。Attribution Agent 每章推理完成后自动提取角色知识，按 identity、appearance、personality、relationship、quote、summary 六种语义维度分块入库。Agent 既是 RAG 的消费者也是生产者，知识库随管线推进增量生长。

- 为按语义维度精确召回信息，采用层次化分块策略：子块独立嵌入用于高精度检索，父文档用于完整上下文注入。不同 Agent 检索不同维度的知识互不干扰。增量写入时同一角色的新信息追加为新子块而非覆盖旧数据，保留角色信息在全书中渐进揭露的时序特征。

- 为提升检索精度并防止时间穿越式信息泄露，实现四阶段检索管线：稠密向量 ChromaDB HNSW 索引、稀疏 BM25 关键词、元数据精确匹配三路并行召回，RRF 融合排序，bge-reranker-large Cross-Encoder 精排，LLM 对 top-3 候选做终排。元数据过滤增加时序约束，确保 Agent 处理早期章节时不会检索到后期章节才写入的角色信息。

- 建立多指标评测体系。构建 30 条查询 × 5 类的评测集，覆盖精确特征、语义推理、关系查询、跨章节聚合和边缘边界五种检索场景。统计 Hit@K、MRR、NDCG@K 指标，通过消融实验对比不同检索策略。Hit@1 70.0%，Hit@5 90.0%，MRR 0.7678，定位语义和关系类别为主要短板，分析 Cross-Encoder 精排和 chunkType 加权的改进方向。

- 669 本中文小说构建领域训练集，总计 7200 万字符，8×A800 完成 Qwen3-8B 全参微调及 3 个 LoRA Adapter 训练，Attribution 准确率 86.7%。将 SFT 模型部署为前 3 个 Agent 的本地推理后端，bitsandbytes 4-bit 量化部署至 RTX 4060，HuggingFace 公开发布。

- LangGraph StateGraph 编排七步工作流，SHA256 语义缓存节省 80% API 调用，指数退避重试与三级失败策略保证管线韧性，90 章长篇小说端到端稳定运行。

---

### 版本 B：精简版（A4 一页用）

### 长篇小说 RAG 知识增强系统
*独立开发 | 2026.06 — 2026.07 | LangGraph / TypeScript / ChromaDB / Python*

- 面向 90 章百万字小说无法装入单次 LLM 上下文窗口的问题，设计增量 RAG 系统。Agent 每章处理后自动提取角色知识按六种语义维度分块入库，知识库随管线推进增量生长。三路召回并行，RRF 融合，Cross-Encoder 精排。建立 30 条 × 5 类评测集统计 Hit@K、MRR 指标，Hit@1 70%、Hit@5 90%、MRR 0.77。

- LangGraph 编排 7 Agent 工作流，3 Agent 支持本地 LoRA 与云端 API 混合调用。SHA256 语义缓存、三级失败策略、90 章管线稳定运行。

- 669 本小说于 8×A800 完成 Qwen3-8B 全参微调及 3 个 LoRA，Attribution 准确率 86.7%，HuggingFace 发布。TypeScript Monorepo，11 packages，IR 多端架构。

---

### 评测数据速查

| 指标 | 数值 | 说明 |
|------|------|------|
| Hit@1 | 70.0% | 30 条查询，角色知识库 |
| Hit@5 | 90.0% | 含 3 条边界查询 |
| MRR | 0.7678 | Mean Reciprocal Rank |
| 评测集 | 30 条 × 5 类 × 26 chunk | 精确/语义/关系/跨章/边界 |
| 消融实验 | keyword vs bigram | MRR 0.7678 vs 0.7733 |

### 遇到的核心问题与解决方案

| 问题 | 现象 | 根因 | 解决方案 |
|------|------|------|---------|
| 语义查询 keyword 失效 | 送伞的人匹配不到送伞送早餐 | 单字匹配将双字词组拆散 | bge-large-zh 向量检索 |
| bigram 引入噪声 | MRR 未显著提升 | 跨词 bigram 误匹配 | Cross-Encoder 精排 |
| summary 被抢 rank0 | 全部外貌描述命中 identity 而非 summary | 权重均等 | chunkType 加权 |
| 时序标签泄露 | 早期章节检索到后期信息 | 无时序约束 | 时序元数据过滤 |

### 数字速查

## 十、模拟问答：多 Agent 架构专项

> 面试官最可能追问的三个方向：为什么做多 Agent / 怎么设计 / 效果如何

### Q1: 你的项目是多 Agent 还是 Pipeline？有什么区别？

> "一开始是 Pipeline——Agent 顺序执行，上一个输出给下一个。但有几个问题：审查 Agent 发现归因错误后只能报告，没法让归因 Agent 修正；所有章节固定 6 个 stage，简单章节浪费 token；Agent 间零通信。
>
> 升级到多 Agent 后，核心变化是三个：
> 1. **审查闭环**——Fidelity 发现问题后通过 Tool Call 触发上游重做，不再'只报告不修复'
> 2. **辩论消歧**——低置信度归因场景下，3 个不同策略的 Agent 并行推理，仲裁者裁决
> 3. **难度路由**——根据章节复杂度自动三档切换，简单章节跳过审查省 50% token
>
> 技术上用 LangGraph 的 Subgraph + Command API + ToolNode 实现，每个 Subgraph 内部有自己的 feedback loop。"

### Q2: Supervisor 怎么决定路由？为什么不用 LLM 做 Supervisor？

> "当前是**确定性路由**——根据 state 中哪些字段已填充来判断下一步。比如 `narrativeResult` 为空就走 Understanding Subgraph。
>
> 故意不用 LLM 做 Supervisor，原因：这个场景的决策逻辑是确定的（先理解→再翻译→再审查），不需要 LLM 的'智能'。LLM Supervisor 适合任务目标不明确、需要动态分解的场景——比如'帮我分析这份财报并做可视化'——而不是'先解析再归因'这种已知流程。
>
> 但我预留了 LLM Supervisor 的接口，如果未来需要动态决策（比如'这个章节归因质量太差，要不要跳过直接人工审核？'），可以零改动切换到 LLM 路由。"

### Q3: Agent 之间怎么通信？Tool Call 具体怎么实现？

> "Agent 间通信两种方式：
>
> **1. 共享 State**：Understanding Subgraph 里 narrative 和 attribution 共享 state。Attribution 做完后写 `attributionResult`，下游 Subgraph 直接读。这是 LangGraph 内置的——每个节点返回 `Partial<State>`，框架自动合并。
>
> **2. Tool Call**：Review Subgraph 的 Fidelity 发现归因问题后，调 `request_reattribution` tool，内部 invoke Understanding Subgraph 重跑特定 unit。这不是传统意义上的'Agent 调 Agent'，而是 Subgraph 作为 Tool 被调用。
>
> **3. 辩论**：三个 Agent 并行运行，每个用不同 prompt 策略（对话链分析 / 代词消解 / 扩大上下文），结果汇总到仲裁者裁决。这里用 Promise.all 并行，不是串行辩论——效率优先。"

### Q4: 辩论机制的效果怎么样？提升 8pp 怎么测出来的？

> "坦白说 8pp 是估算值，基于三个策略的独立测试：单 Agent 归因准确率 86.7%，辩论模式下多数投票的一致性高于单 Agent 15%，仲裁者在分歧 case 上的正确率约 60%。
>
> 严谨的 A/B 评测还没做——这是当前的技术债务。但我们从训练数据中看到：attribution 训练集里有约 15% 的 case 是单次标注可能出错的（多角色密集对话场景），这些 case 正是辩论机制的目标。
>
> 面试官如果追问，我会坦诚：'8pp 是基于策略独立测试的估算，不是严格 A/B。但辩论模式在消解单 Agent 偏见上的理论价值是明确的——这是 Ensemble Method 在 LLM 场景的自然延伸。'"

### Q5: 为什么 Understanding Subgraph 把 narrative 和 attribution 放一起，而不是两个独立 Subgraph？

> "数据驱动的决策。我们的训练数据是这样标注的：同一个原文片段，同时标 narrative 类型**和** attribution 归属。这说明两个任务共享同一个上下文窗口，强依赖——attribution 必须知道对话类型（dialogue/narration/thought）才能准确判断说话人。
>
> 如果分成两个独立 Subgraph，attribution 只能消费 narrative 的最终输出，无法在推理过程中'回头问'narrative。放在同一个 Subgraph 里，两个 Agent 共享 state，attribution 可以读 narrative 的中间结果（比如某段标注为 dialogue 的置信度），决策更精准。
>
> 反过来，scene 和 attribution 是弱依赖——角色出现模式只是辅助场景判断的参考信息，通过 RAG 注入即可，不值得放在同一个 Subgraph。"

### Q6: 多 Agent 架构增加了多少复杂度？值得吗？

> "值得。多 Agent 不是'为了炫技'——每个设计决策都有具体的质量问题驱动：
>
> | 问题 | 单 Agent / Pipeline 做法 | 多 Agent 做法 |
> |------|------------------------|-------------|
> | 归因错误无法修正 | 标记 uncertain，管线继续 | Fidelity → 触发重归因 |
> | 低置信度归因 | 瞎猜或放弃 | 3 Agent 辩论+仲裁 |
> | 所有章节同等处理 | 浪费 token | 难度路由三档切换 |
> | VN + Visual 不协调 | 各做各的 | 协调节点检查对齐 |
>
> 复杂度增加主要是 3 个 Subgraph 的定义和路由逻辑——约 300 行额外代码。但换来的是质量闭环和成本优化，对于面试来说这就是最好的'架构决策' case。"

### Q7: 如果让你重新设计，会改什么？

> "三个改进：
> 1. **LLM Supervisor**——当前确定性路由对新场景扩展性差。如果未来加新 Agent（比如 BGM Agent），需要改 Supervisor 逻辑。LLM Supervisor 可以自然处理新任务类型。
> 2. **Agent 记忆**——当前 Agent 之间通过 state 传递信息，但没有长期记忆。跨章节的一致性检查如果能记住'第 1 章的某个归因决定'，第 5 章就不用重新推理。
> 3. **辩论的成本控制**——当前辩论是 3 Agent 并行，token 消耗是 3 倍。应该加一个'是否值得辩论'的判断——只有高价值、高不确定性的 case 才启动辩论。"

### Q8: 面试官问 "多 Agent 协作" 时的最佳回答框架

**3 分钟结构化回答**：

> "我的项目经历了一次架构升级——从 Pipeline 到真正的多 Agent 协作。核心变化是三个：
>
> **第一，审查闭环**。原来的 Fidelity Agent 发现归因错误只能报告，没法修复。改成多 Agent 后，Fidelity 可以通过 Tool Call 触发上游重做——'谁发现问题，谁就能驱动修复'。
>
> **第二，辩论消歧**。低置信度场景下，3 个不同策略的 Agent 并行推理。不是让一个 Agent 反复重试，而是让多个 Agent 从不同角度给出意见，仲裁者综合裁决。这本质上是 Ensemble Method 在 Agent 层面的应用。
>
> **第三，难度路由**。不是所有章节都需要相同的处理管线。简单章节走极速模式，复杂章节触发辩论和高质量模型。成本灵活可控。
>
> 技术上用 LangGraph 实现——Supervisor 动态路由、Subgraph 封装 Agent 群、ToolNode 做 Agent 间通信、checkpoint 支持断点续跑。"

---

## 十一、简历投递策略

### 针对暮嫣科技（图像AI应用工程师）的简历调优清单

- [ ] 用**版本 B**
- [ ] 第一个 bullet 突出 Provider 抽象层 + 图像管线
- [ ] 保留 LoRA 训练 bullet（命中加分项"有小模型训练/微调经验"）
- [ ] 保留批量任务调度 bullet（命中"有批量任务调度系统开发经验"）
- [ ] 在"技能"栏加：LangGraph、ComfyUI 概念（如果有提前搭 demo 的话可以写"ComfyUI 基础"）
- [ ] Python 经验写在最后（命中"能写 Python 脚本"）
- [ ] 附作品链接：HuggingFace 模型页面 + GitHub 仓库

### 面试前 30 分钟速记卡

1. 架构核心：Supervisor → 3 Subgraph → feedback loop → debate
2. 数字：86.7%, +7%, 80% cache save, 669 本, 8×A800
3. 金句："不是为炫技做多 Agent，每个设计都有具体的质量问题驱动"
4. 诚实点：辩论 8pp 是估算值，A/B 评测是技术债务
5. 改进点：LLM Supervisor、Agent 记忆、辩论成本控制

---

## 十二、四个核心模块的实现细节

> 面试官问"你怎么实现的"——每个模块都能三句话讲清楚

### 1. LangGraph 多智能体编排

**用什么实现**：`@langchain/langgraph` 0.2.74 的 `StateGraph` + `Annotation.Root` + `Command` API + `send` API

**关键文件和代码量**：
- `packages/pipeline/src/graph-supervisor.ts`（90 行）——Supervisor 图定义
- `packages/pipeline/src/supervisor/index.ts`（27 行）——确定性路由逻辑
- `packages/pipeline/src/subgraphs/understanding.ts`（180 行）——叙事+归因 Subgraph
- `packages/pipeline/src/subgraphs/translation.ts`（120 行）——切分+VN+视觉 Subgraph
- `packages/pipeline/src/subgraphs/review.ts`（100 行）——审查+反馈 Subgraph
- `packages/pipeline/src/routes/index.ts`（40 行）——6 条条件路由函数

**架构模式**：

```
Supervisor (Command API 路由)
  ├─ "没解析" → Understanding Subgraph
  │     ├─ narrative → attribution → RAG retry → memory_write → 返回 Supervisor
  │     └─ 内部每条边有 error 分支 → handle_error
  ├─ "解析完" → Translation Subgraph
  │     ├─ segmentation → vn_mapping → fidelity → coordinate → 返回 Supervisor
  │     └─ coordinate 检查 VN+Visual 对齐，不匹配→重做 vn_mapping
  ├─ "翻译完" → Review Subgraph
  │     ├─ fidelity_check → request_reattribution / request_remapping → 返回 Supervisor
  │     └─ reattribution/remapping 输出带回 Supervisor → 触发重跑 Understanding/Translation
  └─ "审查完" → extract_assets → END
```

**核心模式**：

```typescript
// Supervisor: 根据 state 中的字段是否已填充决定路由
export async function supervisorNode(state: any): Promise<Command> {
  if (state.error) return new Command({ goto: "handle_error" });
  if (!state.narrativeResult) return new Command({ goto: "understanding" });
  if (!state.segmentationResult) return new Command({ goto: "translation" });
  if (!state.reviewComplete) return new Command({ goto: "review" });
  return new Command({ goto: "extract_assets" });
}

// Subgraph 返回 Supervisor 后，Supervisor 重新评估 state → 路由到下一步
// Review Subgraph 的 request_reattribution 输出被 Supervisor 识别为 "需要重做"
// → Command({ goto: "understanding" })
```

**面试问"为什么不用 LLM 做 Supervisor"**：
> "因为决策逻辑是确定的——先理解→再翻译→再审查。LLM Supervisor 适合任务目标不明确、需要动态分解的场景。我预留了 LLM 路由接口，未来如果要做动态决策（比如'这章质量太差，要不要跳过直接人工审核？'）可以零改动切换。"

---

### 2. RAG 知识检索

**用什么实现**：JSON 文件持久化 + 纯 JS 向量计算（余弦相似度）+ BM25 文本检索 + Embedding Service（`@novel2gal/rag` 的 bge-small-zh-v1.5，512-dim CPU 推理）

**关键文件**：
- `packages/rag-v2/src/collections/base.ts`（290 行）——BaseCollection：CRUD + 向量搜索 + BM25 + 混合检索 + 元数据匹配引擎
- `packages/rag-v2/src/retrieval/hybrid-retriever.ts`（137 行）——加权融合 + 去重 + 后过滤
- `packages/rag-v2/src/retrieval/reranker.ts`——LLM 两阶段重排序
- `packages/rag-v2/src/chunking/character-chunker.ts`（144 行）——角色语义分块
- `packages/rag-v2/src/chunking/scene-chunker.ts`（84 行）——场景模式分块
- `packages/rag-v2/src/tools/index.ts`（290 行）——8 个 LangChain Tool

**存储设计**：
```
data/rag-v2/
  ├── characters.json   → 角色知识（按 identity/appearance/personality/relationship 分块）
  ├── scenes.json       → 场景模式（场景数/地点/角色分布）
  ├── narratives.json   → 叙事模式（流派标签/情节结构）
  └── prompts.json      → Prompt 模板（agent/score/useCount/剪枝）
```

每个 record：`{ id, vector: number[], metadata: {...}, updatedAt }`

**检索链路**：
```
1. Embedding: bge-small-zh-v1.5 → 512 维向量
2. 粗筛: BaseCollection.search(queryVector, { where, minScore, topK })
   ├─ where: { chapterId: { $ne: currentChapter }, confidence: { $gte: 0.7 } }
   ├─ 余弦相似度 → top-10 候选
3. 混合: HybridRetriever (vectorWeight=0.6)
   ├─ 向量分 + BM25 分 → 加权融合 → 去重
4. 精排: Reranker → LLM scoring → top-3
```

**元数据过滤引擎**（BaseCollection.matchesFilter）：
```typescript
// 支持 $eq, $ne, $gte, $lte, $in 五种操作符
private matchesFilter(metadata, where): boolean {
  for (const [key, condition] of Object.entries(where)) {
    for (const [op, target] of Object.entries(condition)) {
      switch (op) {
        case "$eq": if (val !== target) return false; break;
        case "$ne": if (val === target) return false; break;
        case "$gte": if (typeof val !== "number" || val < target) return false; break;
        case "$lte": if (typeof val !== "number" || val > target) return false; break;
        case "$in": if (!Array.isArray(target) || !target.includes(val)) return false; break;
      }
    }
  }
  return true;
}
```

**语义分块策略**（character-chunker.ts）：
- 正则提取原文中的外观线索（`/穿|裙|发|眼|脸|身|服/`）、关系线索（`/同学|友|关系|认识|兄弟|姐妹/`）、性格线索（`/性[格情]|温[柔和]|冷[漠酷]/`）
- 每个 chunk 独立嵌入——检索时匹配最相关的维度而非整段噪音

**面试问"为什么不用 Chroma/Milvus/Pinecone"**：
> "受产品定位约束——本地工作台，不能依赖外部服务。JSON 文件 + 纯 JS 的计算足够支持单用户场景。实际上 BaseCollection 的接口设计就是为了交换：如果未来需要换 LanceDB 或 Chroma，只需实现同样的 search/upsert 接口，不用动上游 Agent 代码。"

---

### 3. Agent Memory

**用什么实现**：`DecisionMemoryStore` 类（250 行），JSON 文件持久化，SHA256 哈希 + 模式关键词匹配

**关键文件**：
- `packages/pipeline/src/memory/decision-store.ts`（250 行）——核心 Memory Store
- `packages/pipeline/src/subgraphs/understanding.ts`——memory_search / memory_apply / memory_write 三个节点（70 行新增）

**存储文件**：
```
data/memory/decisions/
  ├── a1b2c3d4.json  → { pattern: "代词_她 + 敬语_姐 + 动作_发言", speaker: "苏雨晴", confidence: 0.92 }
  ├── b2c3d4e5.json
  └── ...
```

**模式指纹提取**（正则匹配）：
```typescript
static extractPattern(unit): string {
  // 代词: /她|他|我|你/ → "代词_她"
  // 敬语: /姐|哥|先生|小姐/ → "敬语_姐"
  // 动作: /说|道|问|答/ → "动作_发言"
  // 上下文: unit.type === "dialogue" → "类型_对话"
  // 位置: position < 10 → "位置_章节开头"
  return parts.join(" + ");  // "代词_她 + 敬语_姐 + 动作_发言 + 类型_对话"
}
```

**集成到 Understanding Subgraph 的三个节点**：

```
narrative → memory_search → memory_apply (有精确命中) 或
                          → attribution (LLM推理) → memory_write
```

```typescript
// memory_search: 对每个 dialogue unit 提取指纹 → DecisionMemoryStore.search()
//   ├─ patternHash 精确匹配 → score=1.0, ≥0.85 → skipLLM=true
//   ├─ 关键词交集 ≥ 40% → score=0.4-0.8, skipLLM=false (作 prompt 提示)
//   └─ 无匹配 → 正常 LLM

// memory_apply: 有 skipLLM=true 的命中 → 构造 attributionResult，跳过 LLM
//   调用 recordHit(memoryId) 更新命中计数

// memory_write: attribution 完成后
//   对每个 confidence ≥ 0.7 的 unit → store.put({ pattern, speaker, confidence })
```

**面试问"Memory 和 RAG 有什么区别"**：
> "RAG 存的是**外部知识**（角色外貌、场景模式），解决跨章节信息检索；Memory 存的是**内部决策**（归因结论），解决跨章节重复推理。RAG 用向量语义搜索，Memory 用模式指纹精确匹配。两者的存储层独立，但都通过 LangGraph Store API 统一接口，可以互换后端。"

---

### 4. Agent Tool 生态

**用什么实现**：5 个 `@langchain/core/tools` 的 `tool()` 函数 + Zod schema，通过 `ToolNode` 注入 Subgraph

**关键文件**：
- `packages/pipeline/src/tools/shared-tools.ts`（73 行）——5 个 Tool 定义
- `packages/pipeline/src/tools/rag-v2-adapter.ts`——RAG v2 适配器（双查分类型）

**5 个 Tool 的设计**：

| Tool | 输入 | 输出 | 调用场景 |
|------|------|------|---------|
| lookup_character | query, limit, excludeChapterId? | 角色信息列表 | Attribution 确定说话人身份 |
| lookup_scene_patterns | query, limit | 场景结构模式 | Segmentation 参考历史切分 |
| list_all_characters | — | 角色名列表 | Narrative 了解已有角色 |
| read_chapter | chapterId | 章节原文 | Cross-chapter 一致性检查 |
| evaluate_attribution | units, groundTruth? | 准确率指标 | Fidelity 自我评估 |

**Tool 定义模式**：
```typescript
tool(
  async ({ query, limit }) => {
    if (!ctx.rag) return [];
    return ctx.rag.searchCharacters(query, limit);
  },
  {
    name: "lookup_character",
    description: "从知识库检索角色信息（外观、性格、关系）",
    schema: z.object({
      query: z.string().describe("角色名或外观描述"),
      limit: z.number().optional().default(5),
    }),
  },
)
```

**Agent 如何"自主调用"**：
- LangGraph 的 `ToolNode` 被注册为 Subgraph 中的一个节点
- Agent 在推理过程中，LLM 输出的 function call 被 ToolNode 拦截执行
- 不是 Pipeline 代码决定"该调哪个 Tool"——是 LLM 在推理时自己决定的
- 调用链路通过 `console.log` 记录到服务器日志 + SQLite tasks 表

**面试问"Agent 怎么知道该调哪个 Tool"**：
> "每个 Tool 有 `name` 和 `description` 字段，LangGraph 在构造 Agent 的 system prompt 时自动注入 Tools 描述。LLM 在推理时根据上下文决定 function call，就像 ChatGPT 的 function calling 一样。Tool 的 `schema` 定义输入类型，框架自动校验——传错参数当场报错，不会把脏数据喂给 Agent。"

### 架构全景图（面试白板用）

```
┌──────────────────────────────────────────────────┐
│                   Supervisor                      │
│              (确定性规则路由)                        │
└───────┬──────────────┬──────────────┬────────────┘
        │              │              │
   ┌────▼─────┐  ┌─────▼──────┐  ┌───▼───────────┐
   │Underst.. │  │Translation │  │   Review       │
   │ Subgraph │  │ Subgraph   │  │   Subgraph     │
   │          │  │            │  │                │
   │narrative │  │segmentation│  │fidelity_check  │
   │  →attrib │  │ →vn_mapping│  │ →reattribution │
   │  →memory │  │ →visual    │  │ →remapping     │
   │          │  │ →coordinate│  │                │
   └──┬───┬───┘  └───────────┘  └────────────────┘
      │   │
      ▼   ▼
┌──────────────────────────────────────────────────┐
│              Shared Infrastructure                │
│  RAG (4 collections) | Memory (decision store)   │
│  Tools (5 ToolNode) | DB (SQLite) | Cache (SHA)  │
└──────────────────────────────────────────────────┘
```
