# Novel2Galgame 深度质量审计 & 修复执行手册

> **审计日期**: 2026-08-16  
> **审计方法**: 直接读取 7 部小说磁盘真实数据文件 + 源码逐行验证  
> **审计范围**: 7 部小说 / 298 章 / 372 场景 / 13,952 VN 步骤  
> **项目根目录**: `D:\Project\novel2glagame` (代码仓库 worktree)

---

## 目录

1. [审计总览与问题清单](#1-审计总览与问题清单)
2. [BUG-1：RAG 角色外貌提取逻辑致命缺陷](#2-bug-1rag-角色外貌提取逻辑致命缺陷)
3. [BUG-2：Visual Prompt Agent 输出未落盘](#3-bug-2visual-prompt-agent-输出未落盘)
4. [BUG-3：Fidelity Review 检出问题但无修复闭环](#4-bug-3fidelity-review-检出问题但无修复闭环)
5. [BUG-4：Attribution Agent canonicalName 存代码 ID 而非中文名](#5-bug-4attribution-agent-canonicalname-存代码-id-而非中文名)
6. [磁盘数据证据附录](#6-磁盘数据证据附录)
7. [修复完成后的验证清单](#7-修复完成后的验证清单)

---

## 1. 审计总览与问题清单

| 编号 | 严重度 | 问题摘要 | 影响范围 | 涉及文件 |
| :---: | :---: | :--- | :--- | :--- |
| **BUG-1** | 🔴 P0 Critical | RAG 角色知识库全部为空壳（appearance/personality/relationships 全为空数组） | 全部 7 项目 660 角色 | `packages/rag/src/chunking/character-chunker.ts` |
| **BUG-2** | 🔴 P0 Critical | Visual Prompt 在 372 个场景中 0 个生成了 `visual_prompt.json` | 全部 372 场景 | `packages/pipeline/src/nodes/visual-prompt-node.ts` |
| **BUG-3** | 🟠 P1 Major | Fidelity Review 检出 226 个 critical 级内容遗漏但流水线无修复动作 | 85.8% 场景未通过自审 | `packages/pipeline/src/routes/index.ts` + `fidelity-review-node.ts` |
| **BUG-4** | 🟡 P2 Medium | Attribution Agent 的 characters.canonicalName 存代码 ID（如 `char_peiyan`）而非中文名（如 `裴砚`），aliases 全为空 | 全部角色档案 | `packages/agents/src/attribution/attribution-agent.ts` |

---

## 2. BUG-1：RAG 角色外貌提取逻辑致命缺陷

### 2.1 问题诊断

**文件**: `packages/rag/src/chunking/character-chunker.ts` (157 行)  
**行号**: 第 43-54 行

**当前缺陷代码**:
```typescript
// 第43-54行: 只收集角色自己作为 speaker 的对话文本
const attributedTexts: string[] = [];
for (const unit of units) {
  const speaker = (unit as any).speaker ?? (unit as any).characterId ?? (unit as any).attribution?.speakerId;
  if (!speaker) continue;

  const matchedCharId = speakerIdToCharId?.[speaker] ?? speaker;
  if (matchedCharId === char.characterId || speaker === char.characterId) {
    const text = (unit as any).originalText ?? (unit as any).text ?? "";
    if (text) attributedTexts.push(text);
  }
}
```

**根因**: 该逻辑只把 `unit.attribution.speakerId === char.characterId` 的文本（即角色自己说的话）纳入外貌扫描池。但小说中角色的外貌描写几乎全部出现在 **旁白叙述（narration）** 中（如 "裴砚撑着下巴发呆"、"霍骁头上绑着绷带"），角色不会在对话里描述自己的外貌。因此 `attributedTexts` 中不包含任何外貌描写，后续的正则匹配 `appearanceHints` 永远为空。

**实际数据证据**: RAG API `GET /projects/project_3821745a1908/rag/characters` 返回的主角裴砚数据：
```json
{
  "canonicalName": "char_peiyan",
  "appearances": [],
  "personalities": [],
  "relationships": [],
  "chunks": [
    { "text": "角色: char_peiyan | " },
    { "text": "角色: char_peiyan | " }
  ]
}
```
660 个角色全部是同样的空壳模式。

**链式影响**:
- `rag-query-node.ts` 运行时查到的 `characterKnowledge` 始终是空字符串 `""`
- Visual Prompt Agent 收到的角色历史外观信息为零
- 所谓 "跨章节人设一致性" 无从实现

### 2.2 修复方案

**修改文件**: `packages/rag/src/chunking/character-chunker.ts`

**替换第 41-70 行**，修复后完整代码:

```diff
- // Collect text attributed to this character
- // Use speakerIdToCharId mapping to match units when speakerId differs from characterId
- const attributedTexts: string[] = [];
- for (const unit of units) {
-   const speaker = (unit as any).speaker ?? (unit as any).characterId ?? (unit as any).attribution?.speakerId;
-   if (!speaker) continue;
-
-   // Try direct match first, then mapping lookup
-   const matchedCharId = speakerIdToCharId?.[speaker] ?? speaker;
-   if (matchedCharId === char.characterId || speaker === char.characterId) {
-     const text = (unit as any).originalText ?? (unit as any).text ?? "";
-     if (text) attributedTexts.push(text);
-   }
- }
-
- const appearanceHints: string[] = [];
- const relationHints: string[] = [];
- const personalityHints: string[] = [];
-
- for (const text of attributedTexts) {
-   if (/穿|裙|发|眼|脸|身|服|装|戴|帽|鞋|裤|镜/.test(text)) {
-     appearanceHints.push(text.slice(0, 120));
-   }
-   if (/同学|友|关系|认识|兄弟|姐妹|父母|师傅|徒弟/.test(text)) {
-     relationHints.push(text.slice(0, 120));
-   }
-   if (/性[格情]|温[柔和]|冷[漠酷]|开[朗]|生[气]|笑|怒|哭|害[羞怕]|骄[傲]|善[良]/.test(text)) {
-     personalityHints.push(text.slice(0, 120));
-   }
- }
+ // Collect text attributed to this character (direct speech)
+ const attributedTexts: string[] = [];
+ // [FIX] Also collect narration/thought text that MENTIONS this character
+ const mentionTexts: string[] = [];
+
+ for (const unit of units) {
+   const text = (unit as any).originalText ?? (unit as any).text ?? "";
+   if (!text) continue;
+
+   const speaker = (unit as any).speaker ?? (unit as any).characterId ?? (unit as any).attribution?.speakerId;
+   const matchedCharId = speaker ? (speakerIdToCharId?.[speaker] ?? speaker) : null;
+
+   // Direct speech by this character
+   if (matchedCharId === char.characterId || speaker === char.characterId) {
+     attributedTexts.push(text);
+   }
+
+   // [FIX] Narration/thought/action that mentions this character by name or participantIds
+   const unitType = (unit as any).type;
+   if (unitType === "narration" || unitType === "thought" || unitType === "action") {
+     const participantIds: string[] = (unit as any).attribution?.participantIds ?? [];
+     const mentionsChar =
+       participantIds.includes(char.characterId) ||
+       text.includes(name) ||
+       (char.aliases ?? []).some((alias: string) => text.includes(alias));
+     if (mentionsChar) {
+       mentionTexts.push(text);
+     }
+   }
+ }
+
+ // [FIX] Merge both sources for trait extraction
+ const allRelevantTexts = [...attributedTexts, ...mentionTexts];
+
+ const appearanceHints: string[] = [];
+ const relationHints: string[] = [];
+ const personalityHints: string[] = [];
+
+ for (const text of allRelevantTexts) {
+   // [FIX] 扩充外貌关键词覆盖度
+   if (/穿|裙|发|眼|脸|身|服|装|戴|帽|鞋|裤|镜|长相|容貌|皮肤|唇|眉|鼻|肤|高|瘦|胖|帅|漂亮|美|秀|俊|挺拔|绑|绷带|伤|疤|纹|白皙|卷|短发|长发|西装|制服|校服|围巾|外套/.test(text)) {
+     appearanceHints.push(text.slice(0, 150));
+   }
+   if (/同学|友|关系|认识|兄弟|姐妹|父母|师傅|徒弟|老公|老婆|丈夫|妻子|男友|女友|前任|上司|下属|同事|老师|学生/.test(text)) {
+     relationHints.push(text.slice(0, 150));
+   }
+   if (/性[格情]|温[柔和]|冷[漠酷]|开[朗]|生[气]|笑|怒|哭|害[羞怕]|骄[傲]|善[良]|沉默|内向|外向|活泼|腼腆|强势|霸道|温柔|体贴|冷淡/.test(text)) {
+     personalityHints.push(text.slice(0, 150));
+   }
+ }
```

---

## 3. BUG-2：Visual Prompt Agent 输出未落盘

### 3.1 问题诊断

**文件**: `packages/pipeline/src/nodes/visual-prompt-node.ts` (81 行)

**关键发现**: 372 个场景目录中 **0 个** 含有 `visual_prompt.json`。

**可能原因分析（按概率排序）**:

**原因 A（最可能）: 内部 try-catch 吞掉了所有 LLM 错误（第 68-70 行）**:
```typescript
// 第68-70行 — 当前代码
} catch {
  state.onProgress?.("visual_prompt", `Visual prompt failed for ${scene.sceneId}, skipping`);
}
```
catch 没有 `(err)` 参数，所有异常（LLM 超时、JSON 解析失败、API key 错误等）都被**静默吞掉**，没有任何日志输出。这极可能是 LLM 调用每次都失败但被静默跳过。

**原因 B: `autoRunVisualPrompt` 被调用方设为 false（第 24-27 行）**:
```typescript
if (!state.autoRunVisualPrompt) {
  state.onProgress?.("visual_prompt", "Skipped (autoRunVisualPrompt disabled)");
  return { currentStage: "extract_assets", stageTimings: { visual_prompt: 0 } };
}
```

**排查命令**:
```bash
grep -rn "autoRunVisualPrompt" packages/ apps/
```
检查是否有地方将其设为 `false`。

**原因 C: `writeVisualPromptResult` 函数写入路径不对**

**排查命令**:
```bash
grep -rn "writeVisualPromptResult" packages/storage/
```

### 3.2 修复方案

**修改文件**: `packages/pipeline/src/nodes/visual-prompt-node.ts`

**步骤 1 — 修复第 68-70 行的静默吞错**:

```diff
-     } catch {
-       state.onProgress?.("visual_prompt", `Visual prompt failed for ${scene.sceneId}, skipping`);
-     }
+     } catch (vpErr) {
+       const errMsg = vpErr instanceof Error ? vpErr.message : String(vpErr);
+       console.error(`[visualPromptNode] FAILED for ${scene.sceneId}: ${errMsg}`);
+       state.onProgress?.("visual_prompt", `Visual prompt ERROR for ${scene.sceneId}: ${errMsg.slice(0, 120)}`);
+     }
```

**步骤 2 — 确认 `autoRunVisualPrompt` 没有被关闭**

在整个项目中搜索 `autoRunVisualPrompt`，如果发现被设为 `false` 的地方（如 API 路由或调度器），改为 `true`。

**步骤 3 — 修复后重跑一章观察日志**

修复后重跑单章，观察是否有 `[visualPromptNode] FAILED` 的错误日志输出。根据具体错误信息做进一步修复（可能是 LLM 模型配置问题、API key 问题等）。

---

## 4. BUG-3：Fidelity Review 检出问题但无修复闭环

### 4.1 问题诊断

**文件**: `packages/pipeline/src/routes/index.ts` (44 行)  
**行号**: 第 27-33 行

**当前缺陷代码**:
```typescript
export function afterFidelityReview(state: typeof ChapterPipelineState.State): string {
  if (state.error) return "handle_error";
  const seg = state.segmentationResult;
  if (!seg) return "handle_error";
  const allReviewed = state.sceneResults.length >= seg.scenes.length;
  return allReviewed ? "rag_query" : "vn_mapping";
}
```

**根因**: `afterFidelityReview` 只检查 "是否所有场景都已审核"，**完全不检查审核是否通过**。不管 `fidelityReport.passed` 是 `true` 还是 `false`，也不管 severity 是 `critical` 还是 `warning`，都直接往下走到 `rag_query`。

**实际数据**: Fidelity Review 自己检出了 226 个 critical 级内容遗漏，但流水线全部忽略了：

| 小说 | 场景数 | 通过 | Critical | 通过率 |
| :--- | :---: | :---: | :---: | :---: |
| 狗血替身文 | 17 | 3 | 7 | 18% |
| 从离婚开始 | 46 | 4 | 27 | 9% |
| 以身相许 | 33 | 1 | 25 | 3% |
| 四年避孕药 | 44 | 5 | 31 | 11% |
| 上下为难 | 119 | 33 | 53 | 28% |
| 钟医生 | 60 | 3 | 44 | 5% |
| 你比冬天先到 | 53 | 4 | 39 | 8% |
| **总计** | **372** | **53** | **226** | **14.2%** |

### 4.2 修复方案

这是一个架构级修复，需要分两步实现：

**步骤 1 — 修改路由判定逻辑**

**修改文件**: `packages/pipeline/src/routes/index.ts`  
**替换第 27-33 行**:

```diff
 export function afterFidelityReview(state: typeof ChapterPipelineState.State): string {
   if (state.error) return "handle_error";
   const seg = state.segmentationResult;
   if (!seg) return "handle_error";
   const allReviewed = state.sceneResults.length >= seg.scenes.length;
-  return allReviewed ? "rag_query" : "vn_mapping";
+
+  if (!allReviewed) return "vn_mapping";
+
+  // [FIX] 检查是否有 critical 级别未通过的场景需要重新 VN Mapping
+  const MAX_REPAIR_ATTEMPTS = 2;
+  const hasCriticalUnrepaired = state.sceneResults.some(
+    (r) =>
+      r.fidelityReport &&
+      !r.fidelityReport.passed &&
+      r.fidelityReport.severity === "critical" &&
+      ((r as any)._repairCount ?? 0) < MAX_REPAIR_ATTEMPTS
+  );
+
+  if (hasCriticalUnrepaired) {
+    console.log("[afterFidelityReview] Critical fidelity failures detected, routing back to vn_mapping for repair");
+    return "vn_mapping";
+  }
+
+  return "rag_query";
 }
```

**步骤 2 — 在 VN Mapping Node 中实现修复逻辑**

修改 `packages/pipeline/src/nodes/vn-mapping-node.ts`，当检测到场景有 `fidelityReport.passed === false` 时，将 fidelity issues 作为额外 context 传给 LLM，指导其补全遗漏内容：

```typescript
// 在 vnMappingNode 函数中，构建 LLM 输入时加入修复指引
const sceneResult = state.sceneResults[sceneIdx];
if (sceneResult?.fidelityReport && !sceneResult.fidelityReport.passed) {
  const issues = sceneResult.fidelityReport.issues.map(
    (iss) => `[${iss.severity}] ${iss.message}`
  ).join("\n");
  // 将 issues 追加到 user prompt 中
  repairContext = `\n\n[REPAIR MODE] 上一次生成的 VN 脚本有以下问题，请务必修复:\n${issues}`;
  (sceneResult as any)._repairCount = ((sceneResult as any)._repairCount ?? 0) + 1;
}
```

---

## 5. BUG-4：Attribution Agent canonicalName 存代码 ID 而非中文名

### 5.1 问题诊断

**文件**: `packages/agents/src/attribution/attribution-agent.ts` (175 行)

LLM System Prompt 中明确要求输出中文 canonicalName：
```
"characters": [{"characterId": "char_001", "canonicalName": "名字", "aliases": ["别名"]}]
```

LLM 实际返回的数据中确实包含中文名。但磁盘上 `attributed_units.json` 中存储的是：
```json
{ "characterId": "char_peiyan", "canonicalName": "char_peiyan", "aliases": [] }
```

**排查方向**: 问题不在 attribution-agent.ts 本身（第 97 行 `const characters = result?.characters ?? [];` 直接使用 LLM 输出），而可能在以下位置：

1. `packages/pipeline/src/nodes/attribution-node.ts` 中是否有额外的 normalize/transform 逻辑覆写了 canonicalName
2. `packages/storage` 中的 `writeAttributionResult` 是否做了字段映射
3. `packages/core` 中的 `extractCharactersFromUnits` 函数是否用 characterId 覆盖了 canonicalName

**排查命令**:
```bash
grep -rn "canonicalName" packages/pipeline/src/nodes/attribution-node.ts
grep -rn "canonicalName.*=.*characterId\|canonicalName.*char_" packages/
grep -rn "extractCharactersFromUnits" packages/core/
```

### 5.2 修复方案

找到覆盖 canonicalName 的代码位置后：

1. 如果是 `extractCharactersFromUnits` 中的 fallback 逻辑导致的，修改为仅在 canonicalName 为空时才 fallback 到 characterId
2. 如果是 attribution-node.ts 的 normalize 逻辑导致的，移除不当的字段覆写
3. 修复后验证：重跑单章并检查 `attributed_units.json` 中的 canonicalName 是否为中文名

---

## 6. 磁盘数据证据附录

### 6.1 7 部小说的项目 ID 对照表

| 项目 ID | 小说名称 | 章节数 | 场景数 |
| :--- | :--- | :---: | :---: |
| `project_99d7b2b5d298` | 《一篇狗血替身文》 | 17 | 17 |
| `project_3821745a1908` | 《从离婚开始的恋爱生活》 | 46 | 46 |
| `project_b2f2d079a69d` | 《以身相许》 | 33 | 33 |
| `project_99a3dc188f24` | 《一查，他给我吃了四年避孕药》 | 44 | 44 |
| `project_62b0ebb41575` | 《上下为难[GB]》 | 119 | 119 |
| `project_43c90491f392` | 《下班别跟钟医生回家》 | 60 | 60 |
| `project_6ebb16329f1c` | 《你比冬天先到》 | 53 | 53 |

### 6.2 项目目录结构（每个 project 通用）

```
D:\Project\novel2glagame\data\projects\<projectId>\
├── raw\novel.txt                    # 原始小说文本
├── chapters\<chapterId>\
│   ├── source.txt                   # 章节原文
│   ├── narrative_units.json         # Narrative Agent 输出
│   ├── attributed_units.json        # Attribution Agent 输出
│   └── segmentation.json            # Segmentation Agent 输出
├── scenes\<sceneId>\
│   ├── vn_script.json               # ✅ 存在
│   ├── fidelity_report.json         # ✅ 存在
│   └── visual_prompt.json           # ❌ 不存在 (BUG-2)
├── export\<gameName>\game\          # ✅ Ren'Py 导出存在
└── (无 rag 子目录)
```

### 6.3 RAG 全局数据位置

```
D:\Project\novel2glagame\data\rag-v2\
├── characters.json     # 13.1 MB, ~830 条记录（全部为空壳 BUG-1）
├── scenes.json         # 5.6 MB, ~350 条记录（场景模式数据，正常）
├── prompts.json        # {"records": []} 空
└── narratives.json     # {"records": []} 空
```

### 6.4 Pipeline 流程图与缺陷标注

```
__start__
  → narrative_parsing
    → attribution  ─────────────────── 🟡 BUG-4: canonicalName 被覆写为代码 ID
      → rag_ingest_chars  ──────────── 🔴 BUG-1: 写入空壳记录
        → segmentation
          → rag_ingest_scenes
            → vn_mapping
              → fidelity_review  ───── 🟠 BUG-3: 检出 critical 但不修复
                → (loop scenes...)
                  → rag_query  ─────── 查到的 characterKnowledge 始终为空
                    → visual_prompt ── 🔴 BUG-2: 错误被吞掉，0 个文件落盘
                      → consistency_review
                        → extract_assets
                          → END
```

### 6.5 关键源文件索引

| 文件 | 行数 | 用途 |
| :--- | :---: | :--- |
| `packages/rag/src/chunking/character-chunker.ts` | 157 | RAG 角色知识切片（**BUG-1 所在**） |
| `packages/pipeline/src/nodes/visual-prompt-node.ts` | 81 | 视觉提示词生成节点（**BUG-2 所在**） |
| `packages/pipeline/src/routes/index.ts` | 44 | 流水线路由条件判定（**BUG-3 所在**） |
| `packages/pipeline/src/nodes/fidelity-review-node.ts` | 270 | Fidelity 审核节点 |
| `packages/agents/src/attribution/attribution-agent.ts` | 175 | 角色归属 Agent（**BUG-4 相关**） |
| `packages/pipeline/src/graph.ts` | 82 | LangGraph 流水线拓扑定义 |
| `packages/pipeline/src/state.ts` | 66 | 流水线状态 Schema |
| `packages/pipeline/src/nodes/rag-query-node.ts` | 78 | RAG 查询节点 |
| `packages/pipeline/src/nodes/rag-ingest-chars-node.ts` | 40 | RAG 角色写入节点 |
| `packages/agents/src/visual-prompt/visual-prompt-agent.ts` | ~200 | Visual Prompt Agent 实现 |

---

## 7. 修复完成后的验证清单

### 7.1 BUG-1 验证（RAG 外貌提取）

修复 `character-chunker.ts` 后，清空 `D:\Project\novel2glagame\data\rag-v2\characters.json` 中该项目的记录，重新跑单章：

```bash
# 重新跑一章后检查
node -e "
const http=require('http');
http.get('http://localhost:3002/projects/project_3821745a1908/rag/characters', res=>{
  let d=''; res.on('data',c=>d+=c); res.on('end',()=>{
    const j=JSON.parse(d);
    const withAppearance = j.characters.filter(c => c.appearances.length > 0);
    console.log('有外貌数据的角色数:', withAppearance.length, '/', j.totalCharacters);
    withAppearance.slice(0,3).forEach(c => console.log(c.canonicalName, JSON.stringify(c.appearances)));
  })
})"
```

**通过标准**: `appearances` 数组非空，包含从旁白中提取的外貌描写片段。

### 7.2 BUG-2 验证（Visual Prompt 落盘）

```bash
node -e "
const fs=require('fs');
const dir='D:\\\\Project\\\\novel2glagame\\\\data\\\\projects\\\\project_3821745a1908\\\\scenes';
const scenes=fs.readdirSync(dir);
let count=0;
scenes.forEach(s => {
  if(fs.existsSync(dir+'\\\\'+s+'\\\\visual_prompt.json')) count++;
});
console.log('含 visual_prompt.json:', count, '/', scenes.length);
if(count>0){
  const first=scenes.find(s=>fs.existsSync(dir+'\\\\'+s+'\\\\visual_prompt.json'));
  const vp=JSON.parse(fs.readFileSync(dir+'\\\\'+first+'\\\\visual_prompt.json','utf-8'));
  console.log('characterPrompts 数量:', vp.characterPrompts?.length);
  console.log('backgroundPrompt:', !!vp.backgroundPrompt);
  if(vp.characterPrompts?.[0]) console.log('示例 finalPrompt:', vp.characterPrompts[0].finalPrompt?.slice(0,100));
}"
```

**通过标准**: count > 0，且 visual_prompt.json 含有非空的 `characterPrompts` 和 `backgroundPrompt`。

### 7.3 BUG-3 验证（Fidelity 修复闭环）

```bash
node -e "
const fs=require('fs');
const dir='D:\\\\Project\\\\novel2glagame\\\\data\\\\projects\\\\project_3821745a1908\\\\scenes';
const scenes=fs.readdirSync(dir);
let passed=0, total=0;
scenes.forEach(s => {
  const fp=dir+'\\\\'+s+'\\\\fidelity_report.json';
  if(fs.existsSync(fp)){
    total++;
    const d=JSON.parse(fs.readFileSync(fp,'utf-8'));
    if(d.passed) passed++;
  }
});
console.log('Fidelity 通过率:', passed, '/', total, '=', Math.round(passed/total*100)+'%');
"
```

**通过标准**: 通过率 > 50%（之前为 14.2%）。

### 7.4 BUG-4 验证（中文 canonicalName）

```bash
node -e "
const fs=require('fs');
const f='D:\\\\Project\\\\novel2glagame\\\\data\\\\projects\\\\project_3821745a1908\\\\chapters\\\\project_3821745a1908_chapter_0001\\\\attributed_units.json';
const d=JSON.parse(fs.readFileSync(f,'utf-8'));
d.characters.forEach(c => {
  const isChinese = /[\u4e00-\u9fff]/.test(c.canonicalName);
  console.log(c.characterId, '->', c.canonicalName, isChinese ? '✅中文' : '❌非中文', '| aliases:', JSON.stringify(c.aliases));
});"
```

**通过标准**: canonicalName 为中文名（如 `裴砚`），而非代码 ID（如 `char_peiyan`）。
