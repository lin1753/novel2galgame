# 社交媒体引流帖

---

## 小红书（图文长帖，干货风 + 二次元）

**标题：** 用AI把你的小说变成可玩的Galgame🎮 | 全开源免费

**正文：**

作为一个代码和二次元双修的死宅，我一直有个想法——能不能把自己写的（或者喜欢的）小说一键变成能玩的视觉小说？

于是肝了三个月，做出了这个👇

🎮 **All Novel Can Be Galgame**
上传txt小说 → AI自动分析 → 生成可玩的Galgame

✨ 能做什么：
- 📖 上传你的恋爱小说（txt就行）
- 🤖 AI自动切章节、识别角色、分场景
- 🎨 自动生成背景图和角色立绘
- 🎬 可选生成视频动画（Agnes AI免费额度）
- 🕹️ 导出Ren'Py项目，打包成exe/APK真能玩
- 🌐 Web端实时预览，边调边看

🧠 技术宅关心的部分：
- 基座模型：Qwen3-8B，用669本中文小说微调（HF已开源）
- 3个LoRA adapter做专项任务（叙事/归因/场景）
- 7 Agent云端管线 + RAG知识检索
- 纯手写编排（不用LangChain），500行搞定
- 全栈TypeScript monorepo，12个包

💰 完全免费：
- 云端模型用Agnes AI免费额度
- 本地模型用4-bit量化，8G显存就能跑
- HuggingFace模型全开源

🔗 GitHub: github.com/lin1753/novel2galgame
🤗 HF: huggingface.co/mikuhhn1239

#AI #Galgame #开源项目 #AI绘画 #二次元 #独立游戏 #GitHub #AIGC #视觉小说 #Qwen

---

## 抖音/TikTok（短文案 + 视频脚本）

**口播脚本（30秒版）：**

```
[画面：小说txt → 游戏画面切换]
"你有没有想过，把自己写的小说变成能玩的Galgame？"

[画面：UI操作流程加速播放]
"上传txt，AI自动分析角色、切章节、生成立绘——"
"全程不需要写一行代码。"

[画面：最终游戏预览]
"最后导出成APK，手机上就能玩。"

[画面：GitHub star + HF模型卡片]
"全开源，免费，我连模型都给你训练好了。"
"链接在评论区。"
```

**发布文案：**
用AI把你的小说变成Galgame🎮 全开源，模型已训练好 #AI #开源 #GalGame

---

## 小黑盒（游戏社区，轻松调侃风）

**标题：** 三个月肝了个AI，把自己写的小说变成Galgame了🎮

**正文：**

事情是这样的，作为一个二次元，我一直有个梦想——让自己喜欢的角色动起来。

于是趁着实习摸鱼（不是），写了这个项目：

📦 All Novel Can Be Galgame
→ 上传txt小说
→ AI自动分析角色、切场景、生成立绘
→ 导出成能玩的Galgame

技术栈大概是这样的：
- 🤖 基座：Qwen3-8B，喂了669本中文网文微调
- 🎯 3个LoRA adapter处理不同Agent任务
- 🔍 自己写了个RAG知识库（bge-small-zh + Hybrid检索）
- ⚛️ 前端React，后端Node.js，全栈monorepo

重点是：**免费，开源，模型在HuggingFace上。**

GitHub搜 novel2galgame 就能找到。
HF搜 mikuhhn1239 有全部模型。

感兴趣的盒友可以star一下，有问题评论区随便问👇

#开源项目 #AI #二次元 #Galgame #GitHub推荐

---

## 通用技术社区帖（掘金/思否/V2EX）

**标题：** 从零构建AI小说→Galgame管线：7 Agent编排 + RAG + Qwen3-8B微调

**正文：**

做了一个AI工作台项目，把中文小说自动转化为可玩的视觉小说。

🏗️ 架构：
- 7 Agent管线（结构解析→叙事分类→角色归因→场景分割→VN映射→忠实度审查→视觉提示）
- IR v1.0中间表示（Zod schema），Ren'Py + Web双Runtime
- RAG知识检索（bge-small-zh + BM25 Hybrid + LLM rerank）

🧠 模型：
- Qwen3-8B全参微调（669本小说）
- 3×LoRA adapter（叙事/场景/归因），HF已开源
- 4-bit量化 + LoRA热切换（Flask serve）

💡 技术决策：
- 评估后不用LangChain/LangGraph，自研500行编排
- 异步管线 + 断点续跑 + SHA256 LLM缓存
- SQLite指标体系追踪每次Agent调用

GitHub: [链接]
技术细节见README和PROGRESS.md

---

## 发布策略

1. **小红书先发**（图文为主，标签多打，参考 tag 列表）
2. **小黑盒+X推同发**（文案改一下语气）
3. **掘金/思否** 可以后续补（流量小但留存高）
4. 评论区放 **GitHub + HF 链接**

**Tag 优先级：**
#AI #Galgame #开源项目 #二次元 #视觉小说 #AI绘画 #GitHub #AIGC #独立游戏 #Qwen

---

## ⚠️ 注意

- 小红书发帖至少配 4 张图（GitHub截图 + 游戏预览 + 模型卡 + 架构图）
- 抖音需要录一个 15-30s 的流程视频
- 小黑盒可以多放梗图和表情包
- 所有平台**21:00-22:00**发布流量最大
