# Claude → Gemini 技术交接：Auto-Export 管线两大幽灵 Bug 修复方案

> **交接方**：Claude (Anthropic)
> **接收方**：Antigravity (Google DeepMind)
> **交接日期**：2026-08-31
> **关联文档**：[`docs/handover_to_claude.md`](file:///D:/Project/novel2glagame/docs/handover_to_claude.md)

---

## 〇、紧急矫正：150 字切分过度矫枉（P0 最高优先）

> [!CAUTION]
> **`splitText` 的 `MAX_CHARS` 从 800 字降到了 150 字，这是灾难性的过度矫枉！**

### 问题分析

- **文件**：[`packages/agents/src/narrative-parsing/narrative-parsing-agent.ts:55`](file:///D:/Project/novel2glagame/packages/agents/src/narrative-parsing/narrative-parsing-agent.ts#L55)
- **当前代码**：`const MAX_CHARS = 150;`
- **后果**：
  - 一个 3000 字的章节被拆成 **20+ 个 chunk**，每个 chunk 单独调 LLM
  - **API 成本暴涨 20 倍**（本应 1 次请求变成 20+ 次）
  - **上下文碎片化**：150 字大约只有 2-3 句话，LLM 根本无法准确判断叙事类型
  - **耗时倍增**：串行 20 次请求，每次 3-5 秒，单章仅叙事解析就要 60-100 秒
  - **LLM 判断退化**：没有足够上下文，dialogue/narration/thought 分类准确率下降

### 为什么当初会降到 150？

注释说"强制斩断推理模型的长篇大论"——真实原因是推理模型（agnes-2.5-flash 等）在 `<think>` 标签中的思考过程太长，占用了大量输出 token，导致 JSON 被 `max_tokens` 截断。但正确的解法不是疯狂缩小输入，而是：
1. 增大 `maxTokens` 上限
2. 在提示词中限制思考长度（**当前提示词 L70 已经做了**：`【强制指令】你的思考过程必须限制在100字以内！`）
3. 合理的分块阈值

### 修复方案

```diff
- // 章节过长时分段处理 (150字每段，强制斩断推理模型的长篇大论)
- const MAX_CHARS = 150;
+ // Split into semantic chunks for LLM processing.
+ // 800 chars (~400 Chinese chars) balances context richness vs. output token limit.
+ // Combined with the "limit thinking to 100 chars" system prompt instruction,
+ // this keeps total output well within max_tokens=8192.
+ const MAX_CHARS = 800;
```

> [!IMPORTANT]
> 同时检查 `maxTokens: 8192` (L81) 是否足够。800 字中文输入 → LLM 输出约 2000-3000 tokens 的 JSON → 8192 绰绰有余。如果仍然偶发截断，可以提升到 `maxTokens: 16384`（大多数模型都支持）。

---

## 一、问题一修复：前端模型配置"幽灵"未生效

### 根因链路（Claude 已完整定位）

```
用户在前端改模型 → 只更新了 profile.defaultModel = "agnes-2.5-flash"
                 ↓ 但没有联动更新
         modelAssignments.text.model 仍然是 "agnes-2.0-flash"
                 ↓
    resolveModelConfig("text") 优先读 assignment?.model
                 ↓
    返回 "agnes-2.0-flash" ← 幽灵值！
                 ↓
    auto-export.ts L54: req.body.model(undefined) ?? project.config?.defaultTextModel(??) ?? resolvedTextModel("agnes-2.0-flash")
                 ↓
    后端一直用 agnes-2.0-flash
```

### 问题出在三个层面

**层面 1**：`model-profiles.json` 中 `modelAssignments.text.model` 没有跟 `profiles[0].defaultModel` 联动

**层面 2**：前端按钮根本没传 `model` 参数
- 文件：[`apps/workbench/src/pages/ProjectOverviewPage.tsx:117`](file:///D:/Project/novel2glagame/apps/workbench/src/pages/ProjectOverviewPage.tsx#L117)
- `startAutoExport({ maxChapters: Infinity })` — 没传 model

**层面 3**：`resolveModelConfig` 优先级链中，`assignment?.model` 永远优先于 `active?.defaultModel`，一旦 `modelAssignments` 被写入旧值就永远被卡住

### 修复方案

#### 修复 A: 数据层 — 立即修复当前配置文件

**文件**: [`data/config/model-profiles.json`](file:///D:/Project/novel2glagame/data/config/model-profiles.json)

```diff
   "modelAssignments": {
     "text": {
       "profile": "agnes-cloud",
-      "model": "agnes-2.0-flash"
+      "model": "agnes-2.5-flash"
     },
```

#### 修复 B: 代码层 — 前端设置页写 profile 时联动更新 assignments

需要排查前端"全局设置"页面保存 profile 配置时，调用后端的哪个 API。找到那个 API handler，在保存 profile 的 `defaultModel` 时自动同步 `modelAssignments.text.model`：

```typescript
// 在保存 profile 的 handler 中追加联动逻辑:
if (updatedProfile.defaultModel) {
  const cfg = readProfilesConfig();
  if (!cfg.modelAssignments) cfg.modelAssignments = {};
  if (!cfg.modelAssignments.text || cfg.modelAssignments.text.profile === updatedProfile.name) {
    cfg.modelAssignments.text = {
      profile: updatedProfile.name,
      model: updatedProfile.defaultModel,
    };
  }
  writeProfilesConfig(cfg);
}
```

#### 修复 C: 代码层 — resolveModelConfig 移除 hardcoded fallback

**文件**: [`apps/api/src/config/index.ts:96`](file:///D:/Project/novel2glagame/apps/api/src/config/index.ts#L96)

```diff
   if (type === "text") {
     return {
       profile: assignment?.profile ?? c.activeProfile,
-      model: assignment?.model ?? active?.defaultModel ?? "agnes-2.0-flash",
+      model: assignment?.model ?? active?.defaultModel ?? "agnes-2.5-flash",
     };
   }
```

> [!WARNING]
> 修复 C 只是更新了硬编码兜底值。**真正的 fix 是修复 B**（联动机制），否则每次用户在前端改了 profile 的 defaultModel，还是会被 assignments 中的旧值覆盖。

---

## 二、问题二修复：LLM JSON 双引号未转义

### 问题本质

LLM（尤其是推理型模型）在输出包含中文小说原文对话的 JSON 时，会产生：
```json
{"originalText": "他说："你好""}
```

当原文本身包含英文半角双引号 `"` 时更致命：
```json
{"originalText": "他说："你好""}
```

### 现有防线评估

1. **提示词层**（L27）已经有警告 ✅ 但仅靠提示词不够
2. **repairJson**（L278-342）只处理截断修复（补全括号/引号），**不处理字段值内部的裸引号** ❌
3. **jsonMode: true** 让模型倾向输出合法 JSON，但不能完全保证 ❌

### 修复方案：三层防线

#### 防线 1: 提示词强化 — 添加 Good/Bad Case

在外置提示词文件 `data/prompts/narrative-parsing.md` 中追加以下内容：

```markdown
## JSON 格式化铁律 (Good/Bad Cases)

### ❌ BAD — 导致 JSON 崩溃：
{"originalText": "他说："你知道吗？"她没回答。"}
上面的英文双引号会破坏 JSON 结构！

### ✅ GOOD — 正确处理方式：
方式1 - 使用中文引号（推荐）：
{"originalText": "他说：\u201c你知道吗？\u201d她没回答。"}

方式2 - 转义英文双引号：
{"originalText": "他说：\\\"你知道吗？\\\"她没回答。"}

### 规则总结
- originalText 中的所有英文半角双引号 " 必须替换为中文引号 \u201c \u201d 或 \\" 转义
- 任何情况下不得出现裸 " 在字符串值内部
```

#### 防线 2: repairJson 增强 — 预处理内嵌裸引号

**文件**: [`packages/providers/src/llm/fetch/fetch-provider.ts`](file:///D:/Project/novel2glagame/packages/providers/src/llm/fetch/fetch-provider.ts)

在 L262 `JSON.parse(content)` 之前，增加预处理：

```diff
+     // Pre-repair: fix unescaped quotes inside JSON string values
+     content = fixInlineQuotes(content);
+
      try {
        return JSON.parse(content) as T;
```

新增函数：

```typescript
/**
 * Fix unescaped quotes inside JSON string values.
 * LLMs often produce: "key": "text with "nested quotes" here"
 * This replaces Chinese dialogue quote patterns to prevent JSON parse failures.
 */
function fixInlineQuotes(text: string): string {
  let result = text;
  // Replace patterns like ："xxx" inside JSON string values with ：\u201cxxx\u201d
  // Only match when preceded by Chinese punctuation (indicating dialogue context)
  result = result.replace(/(?<=[：:])"/g, '\u201c');
  result = result.replace(/"(?=[，。！？；、\n\r}])/g, '\u201d');
  return result;
}
```

#### 防线 3: 用户文本预处理 — 发送给 LLM 前替换英文引号

**文件**: [`packages/agents/src/narrative-parsing/narrative-parsing-agent.ts`](file:///D:/Project/novel2glagame/packages/agents/src/narrative-parsing/narrative-parsing-agent.ts)

在构造 `userPrompt` 时，将原文中的英文引号预先替换为中文引号：

```diff
 文本内容:
-${chunk}
+${chunk.replace(/"/g, '\u201c').replace(/"/g, '\u201d')}
```

> [!IMPORTANT]
> 这是最简单也最有效的方案。中文小说的英文双引号几乎全是对话标记，替换成中文引号不影响语义，但彻底杜绝了 JSON 崩溃的可能。

---

## 三、修改清单与优先级

| 优先级 | 文件 | 改动 |
|:---:|---|---|
| **P0** | `narrative-parsing-agent.ts:55` | `MAX_CHARS` 150 → 800 |
| **P0** | `data/config/model-profiles.json:26` | `modelAssignments.text.model` → `agnes-2.5-flash` |
| **P1** | `apps/api/src/config/index.ts:96` | 硬编码兜底 → `agnes-2.5-flash` |
| **P1** | `narrative-parsing-agent.ts` userPrompt | 原文英文引号预替换为中文引号 |
| **P1** | `fetch-provider.ts` chatJson | 增加 `fixInlineQuotes` 预处理 |
| **P2** | 前端设置保存 API | profile.defaultModel 联动 modelAssignments |
| **P2** | `data/prompts/narrative-parsing.md` | 追加 Good/Bad Case 示例 |

## 四、验证步骤

修改完成后执行：

```bash
# 1. 编译
cd D:\Project\novel2glagame
pnpm build

# 2. 验证模型配置生效
# 启动 API 后触发一键导出，观察终端日志：
# 期望看到: [FetchLLM] Requesting model: agnes-2.5-flash
# 而不是:   [FetchLLM] Requesting model: agnes-2.0-flash

# 3. 验证叙事解析
# 选一个 3000 字章节一键运行，观察：
# - chunk 数量应该在 4-6 个左右（而不是 20+）
# - 总耗时应 < 60 秒（而不是 100+ 秒）
# - JSON 解析无报错
```

---

*祝 Gemini 执行顺利！如有疑问直接在文档里标注，下次交接时我来审查。— Claude*
