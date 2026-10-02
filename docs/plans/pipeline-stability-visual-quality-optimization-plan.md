# 管线稳定性与视觉质量综合优化方案

> **文档性质**：综合 Gemini 诊断报告 + Claude 独立深度审计  
> **审计对象**：项目 `project_67636322d213`（最新运行数据）  
> **日期**：2026-09-02  
> **状态**：✅ 全部执行完毕 (100% Completed)
> **执行方**：Gemini（代码修改） | **审查方**：Claude（方案设计与补充）

---

## 一、问题总览

经过 Gemini 的日志排查和 Claude 的独立代码+数据审计，共发现 **11 个根因级问题**，分为 3 个领域：

| 领域 | 问题数 | 严重程度 |
|------|--------|---------|
| A. JSON 解析与重试机制 | 4 个 | 🔴 致命（导致管线中断） |
| B. 视觉生成管线 | 5 个 | 🔴 致命（立绘/背景质量不可用） |
| C. 角色 ID 去重 | 2 个 | 🟡 严重（资源浪费+一致性破坏） |

> ⚠️ **执行顺序至关重要**：必须先修 A 类（否则管线跑不通），再修 B 类（否则生成的图是废图），最后修 C 类（否则同一角色生成多套立绘）。

---

## 二、A 类：JSON 解析与重试机制（4 个问题）

### A-1. 🔴 Agent Prompt 输入未清洗导致 LLM 输出病态 JSON

**现象**：多个 Agent（Fidelity、VN Mapping、Narrative Parsing）频繁报错 `Expected ',' or '}' after property value in JSON`，4 次重试全部失败。

**根因**：小说原文包含 ASCII 双引号 `"`，部分 Agent 将原文**未经清洗**直接拼入 Prompt。LLM 在输出 JSON 时将引号原样复制，导致 `JSON.parse` 崩溃。

**Gemini 发现**：`attribution-agent.ts` 做了 `.replace(/"/g, "\u201c")`，但 `vn-mapping-agent.ts`、`fidelity-review-agent.ts`、`narrative-parsing-agent.ts` 均未清洗。

**Claude 补充**：
1. 即便是"已保护"的 `attribution-agent.ts`，Line 97 的 `${input.characterKnowledge}` 来自 RAG 模块，也**完全未清洗**，导致 Attribution 同样崩溃。
2. `fidelity-review-agent.ts` 的 Line 58-63 对 `vnScript.steps` 中的 `text` 字段也未清洗（VN 脚本内的对话文本同样可能含引号）。
3. `visual-prompt-agent.ts` 的 Line 114 `${u.originalText}` 也未清洗。

**涉及代码**：

| 文件 | 行号 | 问题 |
|------|------|------|
| `packages/agents/src/vn-mapping/vn-mapping-agent.ts` | L110 | `u.originalText` 未清洗 |
| `packages/agents/src/fidelity-review/fidelity-review-agent.ts` | L60, L67 | `s.text` 和 `u.originalText` 均未清洗 |
| `packages/agents/src/narrative-parsing/narrative-parsing-agent.ts` | L66 | `${chunk}` 原文直接注入 |
| `packages/agents/src/attribution/attribution-agent.ts` | L97 | `${input.characterKnowledge}` 未清洗 |
| `packages/agents/src/visual-prompt/visual-prompt-agent.ts` | L114 | `${u.originalText}` 未清洗 |

**修复方案**：

在 `packages/agents/src/shared/normalize.ts` 中新增全局清洗函数：

```typescript
/**
 * 清洗动态文本，防止 LLM 在输出 JSON 时引入未转义的双引号或控制字符。
 * 注意：仅用于 Prompt 注入的动态内容，不要用于 system prompt 本身。
 */
export function sanitizeForPrompt(text: string): string {
  if (!text) return "";
  return text
    .replace(/"/g, "\u201c")   // ASCII 双引号 → 中文左引号（不会破坏 JSON）
    .replace(/'/g, "\u2018")   // ASCII 单引号 → 中文左单引号（防御性）
    .replace(/\\/g, "\\\\")    // 反斜杠转义
    .replace(/\r?\n/g, " ")   // 换行符 → 空格
    .replace(/\t/g, " ");     // Tab → 空格
}
```

在上述每个文件的对应行应用 `sanitizeForPrompt()`。

---

### A-2. 🔴 "JSON truncated" 日志误导 + 无效重试死循环

**现象**：日志反复出现 `[FetchLLM] JSON truncated (1664 chars), retrying request...`，但实际并非截断。

**根因**：`packages/providers/src/llm/fetch/fetch-provider.ts` Line 203-213 的逻辑是：
```typescript
// 当前代码 (Line 203-213)
try {
  return JSON.parse(content) as T;          // ① 因中间引号失败
} catch (e) {
  lastError = e;
  try {
    return JSON.parse(repairJson(content));  // ② repairJson 只能修截断，也失败
  } catch {
    // ③ 走到这里就打印 "JSON truncated"——但实际不是截断！
    console.log(`[FetchLLM] JSON truncated (${content.length} chars), retrying request...`);
  }
}
```

**修复方案**：

```typescript
} catch (repairErr) {
  // 区分真正的截断 vs 中间引号破坏
  const isLikelyMidStringCorruption = lastError?.message?.includes("position")
    && !response.finishReason?.includes("length");
  if (isLikelyMidStringCorruption) {
    console.log(`[FetchLLM] JSON corrupted at ${lastError?.message} (${content.length} chars), retrying...`);
  } else {
    console.log(`[FetchLLM] JSON truncated (${content.length} chars), retrying request...`);
  }
}
```

此外，当连续 3 次重试的错误位置（position）完全相同时，说明是确定性错误（prompt 导致），此时重试无意义，应当立即退出并返回错误而非继续浪费 API 调用。

---

### A-3. 🟡 AbortError 被错误重试

**现象**：用户在前端点击"取消"后，后台仍重试 2 次才真正停止。

**根因**：`packages/providers/src/llm/fetch/fetch-provider.ts` Line 177-180 无差别捕获了所有异常并 `continue` 重试。

```typescript
// 当前代码 (Line 177-180)
} catch (err: any) {
  lastError = err instanceof Error ? err : new Error(String(err));
  console.log(`[FetchLLM] Network/API error during chat: ${lastError.message}`);
  continue; // ← AbortError 也被 continue 了！
}
```

**修复方案**：

```typescript
} catch (err: any) {
  // AbortError 不应重试——这是用户主动取消
  if (err?.name === "AbortError"
    || err?.message?.includes("aborted")
    || err?.message?.includes("Aborted")
    || err?.message?.includes("This operation was aborted")) {
    throw err;
  }
  lastError = err instanceof Error ? err : new Error(String(err));
  console.log(`[FetchLLM] Network/API error during chat: ${lastError.message}`);
  continue;
}
```

---

### A-4. 🟡 agnes-ai 禁用 json_mode 加剧解析失败

**现象**：使用 agnes-ai API 时，JSON 输出格式不稳定。

**根因**：`packages/providers/src/llm/fetch/fetch-provider.ts` Line 133 硬编码禁用了 agnes-ai 的 `response_format`：

```typescript
// 当前代码 (Line 133)
if (options.jsonMode && !this.baseUrl.includes("agnes-ai")) {
  body.response_format = { type: "json_object" };
}
```

注释说是因为 "DeepSeek-R1 gets stuck in infinite reasoning loops"，但当前使用的模型可能已不是 R1。

**修复方案**：
- 将禁用条件从 URL 判断改为**模型名称**判断，仅对已知有问题的模型（如 `deepseek-r1`、`agnes-2.5-flash`）禁用：

```typescript
const DISABLE_JSON_MODE_MODELS = ["deepseek-r1", "agnes-2.5-flash"];
const modelName = (options.model || this.defaultModel).toLowerCase();
if (options.jsonMode && !DISABLE_JSON_MODE_MODELS.some(m => modelName.includes(m))) {
  body.response_format = { type: "json_object" };
}
```

---

## 三、B 类：视觉生成管线（5 个问题）

### B-1. 🔴 `cameraAndAction` 字段与"单人白底立绘"规则自相矛盾

**现象**：角色立绘出现多人构图、复杂场景交互、包含背景。

**根因**：`packages/agents/src/visual-prompt/visual-prompt-agent.ts` 的 System Prompt (Line 66-107) 同时存在两条互相矛盾的指令：
- ✅ Rule 3: "Output a SOLO character portrait... NEVER describe background scenery..."
- ❌ JSON Schema 要求填写 `cameraAndAction`: "A complete sentence describing... body pose/action"

LLM 在填写 `cameraAndAction` 时，必然会参考小说剧情生成场景交互描述。

**实际数据样本**（来自 `character_profiles.json`）：
- 苏妄今: `"crouching down in front of the seated Lu Shinan"`（拉入另一个角色）
- 许乘愿: `"observing the interaction between Lu Shinan and Su Wangjin"`（三人构图）
- 鹿时南: `"partially visible inside a burlap sack on Su Wangjin's shoulder"`（复杂场景道具）

**然后在** `visual-prompt-agent.ts` Line 171-179 被**无条件拼接**进最终 prompt：

```typescript
const pose = cp.cameraAndAction || "The character is looking at the viewer.";
const assembled = [styleDesc, baseApp, outfit, pose, expr].filter(Boolean).join(" ");
```

**修复方案**：
1. 从 JSON Schema 中**彻底移除** `cameraAndAction` 和 `transientAction` 字段
2. 将 Line 171 的 `pose` 变量替换为**固定的 Galgame 标准立绘姿势**：

```typescript
// 固定立绘姿势——不依赖 LLM 输出
const pose = "solo, 1person, waist-up portrait, standing straight, looking directly at viewer, simple solid white background";
```

3. 在 System Prompt 中追加强化指令：
```
- DO NOT describe what the character is currently doing in the story scene.
- DO NOT mention any other character by name in the description.
- ONLY output their permanent visual design: face, hair, eyes, clothing.
```

---

### B-2. 🔴 `character_profiles.json` 已被全面污染

**现象**：`character_profiles.json` 中几乎 **100% 的 `basePrompt`** 都包含了场景动作描写和其他角色名字。

**根因**：`basePrompt` 是由 Visual Prompt Agent 每个场景累积更新的，每次更新都带入了当前场景的 `cameraAndAction`。由于 B-1 的缺陷，这些脏数据被永久写入了角色档案。

**修复方案**：
1. 修复 B-1 后，必须**清空现有的 `character_profiles.json`** 或编写迁移脚本，对每个角色的 `basePrompt` 进行以下清洗：
   - 删除所有 `Shot from...` 开头的镜头描写句子
   - 删除所有包含其他角色名的句子
   - 只保留纯外貌描写（hair, eyes, skin, clothing）

---

### B-3. 🔴 角色立绘 `solo` 后备约束从未生效（死代码）

**现象**：即使 `openai-image-producer.ts` 有后备的 solo 约束代码，生成的立绘仍然出现多人构图。

**根因**：`packages/asset/src/openai-image-producer.ts` Line 94-101 的后备逻辑被 `styleTemplate` 中的 `masterpiece` 关键词屏蔽：

```typescript
// 当前代码 (Line 94-101)
if (entry.prompt && entry.prompt.trim().length > 10) {
  p = entry.prompt;
  // ...
  if (!p.includes("masterpiece")) {  // ← styleTemplate 始终包含 "masterpiece"
    // 这段后备 solo 约束永远不会执行！
    p = `masterpiece, best quality, highres, absurdres, anime visual novel sprite, 2D illustration, 
         cel shading, solo character, waist-up portrait, looking at viewer, simple white background, ${p}`;
  }
}
```

由于 `STYLE_TEMPLATES` 中每个模板都包含 `masterpiece`（如 `"Hyper-detailed Kyoto Animation style, masterpiece, best quality..."`），这个 `if` 条件**永远为 false**，后备约束形同虚设。

**修复方案**：

```typescript
if (entry.prompt && entry.prompt.trim().length > 10) {
  p = entry.prompt;
  if (entry.expression && entry.expression !== "default" && !p.includes(`expression: ${entry.expression}`)) {
    p = `${p}, expression: ${entry.expression}`;
  }
  // 无条件追加 solo 约束——不再依赖 masterpiece 关键词判断
  if (!p.toLowerCase().includes("solo")) {
    p = `solo, 1person, waist-up portrait, looking at viewer, simple white background, ${p}`;
  }
}
```

---

### B-4. 🟡 `buildNegativePrompt` 是死代码——从未被 API 调用

**现象**：背景图片中充满人物。

**根因**：`packages/asset/src/openai-image-producer.ts` 中定义了完善的 `buildNegativePrompt` 函数 (Line 65-73)，但在 `callApi` (Line 122-133) 的实际 API 调用中**从未调用**：

```typescript
// callApi 的 payload (Line 128-133)
const body = JSON.stringify({
  model: this.model,
  prompt,        // ← 只有 prompt
  size,
  response_format: "url",
  // ❌ 没有 negative_prompt！
});
```

**修复方案**：
- 如果当前使用的 API（agnes-image-2.1-flash）支持 `negative_prompt` 参数，则在 payload 中加入：
```typescript
const neg = this.buildNegativePrompt(entry);
const body = JSON.stringify({
  model: this.model,
  prompt,
  negative_prompt: neg,  // ← 新增
  size,
  response_format: "url",
});
```
- 如果 API 不支持 `negative_prompt`（如 DALL-E 3 原生不支持），则必须将关键的负面词汇**编织进正向 prompt**（例如 `"empty scenery, no people, no crowds, abandoned"`），而非简单追加 `no humans`。

---

### B-5. 🟡 `cleanseVisualPrompt` 清洗能力严重不足

**现象**：即使有清洗函数，LLM 生成的动作描写仍然大量残留。

**根因**：`packages/agents/src/visual-prompt/visual-prompt-agent.ts` 的 `cleanseVisualPrompt` (Line 49-57) 只匹配了极少数硬编码短语：

```typescript
// 当前代码 (Line 49-57)
function cleanseVisualPrompt(prompt: string): string {
  let clean = prompt;
  clean = clean.replace(/holding (?:a )?(?:(?:plastic|takeout|paper)\s*)+bag.../gi, "");
  clean = clean.replace(/writing on (?:homework|paper|desk)/gi, "");
  clean = clean.replace(/sitting (?:at|on) (?:a )?(?:desk|table|chair|sofa)/gi, "");
  // ... 就这三条规则
  return clean.trim();
}
```

面对 LLM 生成的千变万化的动作描述（`crouching down`、`observing the interaction`、`partially visible inside a burlap sack`），这三条规则根本无法覆盖。

**修复方案**：
如果 B-1 的修复到位（彻底移除 cameraAndAction，使用固定 pose），则 `cleanseVisualPrompt` 的压力会大幅降低。但仍建议增加以下通用清洗规则：

```typescript
function cleanseVisualPrompt(prompt: string): string {
  if (!prompt) return "";
  let clean = prompt;
  // 1. 删除所有 "Shot from..." 开头的摄影指示句
  clean = clean.replace(/Shot from [^.]+\./gi, "");
  // 2. 删除提及其他角色名的句子（匹配 "beside/with/in front of [Name]"）
  clean = clean.replace(/(?:beside|with|in front of|behind|near|next to|across from) (?:the |a )?[A-Z][a-z]+ ?[A-Z]?[a-z]*/g, "");
  // 3. 删除交互性动作描写
  clean = clean.replace(/(?:crouching|kneeling|leaning|sitting|lying|running|walking|speaking to|offering|carrying|holding onto)[^,.]*/gi, "");
  // 4. 清理连续逗号
  clean = clean.replace(/,\s*,+/g, ",").replace(/^\s*,|,\s*$/g, "");
  return clean.trim();
}
```

---

## 四、C 类：角色 ID 去重（2 个问题）

### C-1. 🟡 同一角色被分配大量重复 ID

**现象**：`character_profiles.json` 中存在大量重复角色。

**实际数据**（来自 `project_67636322d213`）：

| 角色名 | 重复 ID 数量 | 示例 ID |
|--------|-------------|---------|
| 默默无闻 | 10 | `char_dakuaitou`, `char_mowuwen`, `char_moweiqianming`... |
| 鹿时南 | 7 | `char_lushinan`, `char_lushinann`, `char_lu_shinan`, `char_鹿时南`... |
| 江舟渡 | 6 | `char_jiangzhoudu`, `char_jiangzhodu`, `char_jiangzhou`... |
| 叶秋渊 | 6 | `char_yeqiuyuan`, `char_yeqiuyuán`... |
| 苏妄今 | 4 | `char_suwangjin`, `char_su_wangjin`... |
| 医生 | 3 | `char_minor_doctor`, `char_minor_doctor_001`, `char_yisheng` |

**根因**：`Attribution Agent` 的去重机制不够强健。当 LLM 在不同章节的不同 chunk 中为同一角色生成了不同的拼音 ID（如 `lushinan` vs `lushinann` vs `lu_shinan`），系统无法将它们合并。

**修复方案**：
1. 在 `attribution-agent.ts` 的 System Prompt 中追加**绝对红线规则**：已知角色列表中出现的名字，必须复用其 `characterId`，绝不允许创建新 ID。
2. 考虑在管线后处理阶段引入 `CanonicalEntityResolver`（`packages/core/src/domain/canonical-entity-resolver.ts`，已存在但未使用），基于 Levenshtein 距离和拼音相似度自动合并。

---

### C-2. 🟡 evidence 引用质量极差

**现象**：`character_profiles.json` 中的 `evidence` 字段的 `category: "appearance"` 引用大多与外貌毫无关系。

**示例**：
- 苏妄今的外貌证据引用："在鹿时南砸出一堆药的情况下，苏妄今还是耗费了不少功夫才将BOSS击杀"（动作描写，非外貌）
- 鹿时南的外貌证据引用："不错，我早就想试试了"（对话，非外貌）

**根因**：Visual Prompt Agent 在提取外貌证据时，过于依赖上下文关联，将角色出现的任何场景文本都标记为 `appearance` 类型。

**修复方案**：
在 Visual Prompt Agent 的 System Prompt 中增加对 evidence 的严格要求：
```
- evidence.category="appearance" MUST ONLY quote text that directly describes physical traits 
  (hair color, eye shape, clothing, body type, height, skin tone).
- DO NOT quote dialogue, actions, or plot events as "appearance" evidence.
```

---

## 五、执行顺序

> ⚠️ 严格按以下顺序执行，跳步会导致问题叠加。

```
A-1 (sanitizeForPrompt)
  → A-2 (修复日志误导)
    → A-3 (AbortError 免疫)
      → A-4 (json_mode 修复)
        → B-1 (移除 cameraAndAction)
          → B-5 (增强 cleanseVisualPrompt)
            → B-3 (修复 solo 死代码)
              → B-4 (接入 negative_prompt)
                → B-2 (清洗 character_profiles)
                  → C-1 (强化去重规则)
                    → C-2 (收紧 evidence)
                      → pnpm build 编译验证
                        → 删除旧数据，重新运行管线测试
```

---

## 六、验证计划

### 编译验证
```bash
pnpm build
```
全部 13 个 package 必须 0 Error 通过。

### 功能验证
1. 删除 `data/projects/project_67636322d213/character_profiles.json` 和 `scenes/` 目录下所有 `visual_prompt.json`
2. 重新运行 2-3 个章节的管线
3. 检查日志中不应再出现 `Expected ',' or '}'` 或 `JSON truncated` 报错
4. 检查新生成的 `character_profiles.json` 中的 `basePrompt` 不应包含 `Shot from`、其他角色名等污染词汇
5. 随机生成 3-5 张角色立绘和背景，目视检查：
   - 立绘：必须为单人白底半身像
   - 背景：必须为无人空场景
