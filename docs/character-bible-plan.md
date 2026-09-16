# 角色圣经 (Character Bible) + RAG 动态维护 + Galgame 立绘演出 — 方案设计

> **状态**：方案制定中（待评估执行）
> **日期**：2026-09-15
> **背景**：Phase 12 视觉审计发现图像 prompt 断层（性别翻转、成语直译、风格错配、跨表情漂移）；用户要求先收集 DDLC 真机 + Gemini 行业调研 + 当前管线证据，再制定详细方案
> **分支**：`feature/character-bible`
> **联网搜索**：Exa API key 失效（401），本次方案基于 DDLC 真机解包 + 三份行业文档 + 真实项目数据三方证据制定，未引入外部网页信息

---

## 一、证据汇总（已收集）

### 1.1 Gemini 行业调研（三份文档，一致收敛）

| 来源 | 关键规格 |
|------|---------|
| `docs/Galgame行业制作规范与舞台演出设计指南.md` | 立绘 32-bit RGBA PNG/WebP，高度 1200–1800px，3:4/9:16；5 级景别；5 大类 15+ 表情；5 锚点 15/30/50/70/85%；说话者 +2% / 听者 −15% dim；0.4s 滑入；Ren'Py ATL 标准库；Web CSS 映射 |
| `docs/标杆级Galgame制作方案与演出设计深度调研.md` | 同上数值 + 2.0x 恐怖特写、300% 透视推镜、21:9 宽幅、4 层视差、16 标签表情矩阵、Q 版 0.1s 切换 |
| `docs/标杆级Galgame单体作品深度调研与拆解分析.md` | waist-up 基准 ~50%、2160px 母版下采样、眼/口/手臂独立分层、视差比 1.8/1.0/0.4/0.1、DDLC cps/w 对话标签 |

**三份文档共同缺失**：角色设计表（design sheet）字段定义、角色特征提取 schema、文件命名规范、跨章节 ID 一致性算法。

### 1.2 DDLC 真机解剖（`samplegame/Doki Doki Literature Club`，已解包验证）

> 解包方式：`python -m unrpa` 解 `images.rpa`（489 文件：476 PNG + 13 JPG）与 `scripts.rpa`（35 `.rpy`）。`game/` 无散装资源，全部在归档内。

**立绘资产结构**（`images/{sayori,natsuki,yuri,monika}/`，与脚本演出 agent 的 Composite 结论交叉验证）：

- **分层部件制**：每张立绘 = 身体部件（`1l.png` 左半身 + `1r.png` 右半身）+ 脸部表情（`a.png/b.png/...`）经 `im.Composite((960, 960))` 拼合（`definitions.rpy:211` 起）。部件均为 **960×960 RGBA**，身体 bbox 约 `(195,392)-(827,960)`（腰上半身构图），脸部 bbox 约 `(333,106)-(663,392)`——**表情差分只换脸部层，身体层复用**。
- **差分规模**：sayori 210 / natsuki 317 / yuri 188 / monika 81 个 `image` 组合定义（`definitions.rpy` 共 798 行 `image <char>` 声明）。编码为 `<pose数字><expr字母>`（如 `sayori 4p` = 4 号姿势 + p 表情），natsuki 姿势前缀 1/2/3/4/5（73/54/54/73/54 种），另有 `g/m/s/v` 特殊pose 与 `stab_*/glitch` 剧情特写。
- **背景**：1280×720（`club.png`/`class.png` 实测），`bg/` 共 41 文件、`cg/` 49 文件。
- **对本项目的启示**：
  1. **差分粒度**：商业 Galgame 表情差分是"换脸不换身"——当前项目每表情整图重绘是**成本与一致性双输**（每表情一次生图调用 + 跨表情漂移）。但分层需要 LayeredImage 级资产， diffusion 直出做不到**部件级复用**；折中见 3.7。
  2. **姿势编码**：DDLC 用数字姿势 × 字母表情的二维矩阵管理差分——Bible 的 `history`/`baseline` 可借鉴"姿势版本 + 表情版本"二维思路，但一期不引入姿势差分（固定 waist-up 单姿势）。
  3. **退场/转场**：`thide`（easein .25 缩小+下沉+淡出）两步退场、`wipeleft_scene`（52 次最常用）、`focus`（zoom z*1.05）——Phase 12 的 ATL 模板已覆盖同等语义，无需改动。

**脚本演出惯用语**（`script-ch0.rpy` 等 35 个反编译脚本）：

- **演出惯用语**：`show <char> <pose+expr> zorder <1|2|3> at <slot>`，slot 为 `t11/t21-22/t31-33/t41-44`（xcenter 预设），前缀变体 `f`（focus 放大说话者）/`i`（instant）/`s`（sink）/`h`（hop）/`d`（dip）/`l`（左侧入场）
- **说话者焦点**：说话者在 `zorder 3 + f-slot`（zoom x1.05），听者在 `zorder 2 + t-slot`
- **表情切换**：对话行内联切换（`s 4p`，靠 `DynamicCharacter(image=...)` 绑定）或 re-show 新 attribute
- **退场**：两步式 `show X zorder 1 at thide` + `hide X`
- **背景**：`scene bg <name>`（清空立绘）+ `with wipeleft_scene`（最常用，52 次）/`dissolve_cg`/`fade`
- **多人场景**：增量构建 solo → pair → trio，按说话者轮转 f-slot
- **文字演出**：`{cps=*2}...{/cps}` 加速、`{nw}` 不等待点击、`menu:` 分支选项——当前 IR 无对应语义（v1.0 冻结，记为 IR v1.1 候选，不在本期做）

### 1.3 当前管线实测（真实项目数据）

**角色档案现状**（`data/projects/*/character_profiles.json`）：

| 项目 | 档案数 | 结构 | 质量问题 |
|------|--------|------|---------|
| `project_2c31ae5ebc56` | 13 | `{characterId, canonicalName, basePrompt, evidence, updatedAt}`（旧扁平结构，无 gender/age/baseline） | 4/13 无性别词；`char_sangchencao` 与 `char_sangchenc��o`（mojibake）重复；evidence 含乱码 quote |
| `project_83e4a1117dff` | 15 | 同上旧结构 | `char_yaolu` 与 `char_qaolu`（同名姚露）重复；evidence 大量动作/对话误标为 appearance（如"迎面就碰上了火急火燎的姚露"）；但性别词覆盖好（young woman / tall lean man） |
| `project_67636322d213` | `{}`（空） | 文件为 **UTF-16 LE** 编码（BOM `FF FE`） | 已定位：`writeProjectJson`（`project-fs.ts:251`）与其他写入一致用 utf-8，**管线不可能写出 UTF-16**，系外部污染（手动编辑/其他工具写入）。且内容为空对象，属死档。处理：M6 直接删除该文件，profile 由管线重建；不修写入路径（无 bug） |

**链路断点确认**（代码核查）：

1. **P0-1 性别翻转**：`CharacterRef`（`packages/core/src/domain/attribution.ts`）无 gender 字段 → `CharacterChunk`/`CharacterRecord` 无 gender → visual-prompt 输出 `gender` 字段但**无人消费**（builder 只读 `finalPrompt`/`appearancePrompt`，profiles 只存 `basePrompt`）→ producer fallback 硬编码 `1girl`（`openai-image-producer.ts:94`）。basePrompt 本身多含性别词（"young woman"/"tall lean man"）所以多数情况碰巧正确，**裸 fallback 时必错**。
2. **成语直译**：`CHINESE_IDIOM_PROMPT_MAP`（10 词）存在但**只被 export，未在任何 prompt 组装路径中引用**（grep 确认零消费）。`data/prompts/visual-prompt.md`（外置，覆盖代码默认）无 idiom 条款。实测 `project_83e4a1117dff` 中傅修宁的 evidence 含"桃花眼"原文，basePrompt 是否正确转译待抽查。
3. **风格错配**：`STYLE_TEMPLATES` 有 8 模板（含 urban-romance/modern-workplace/ancient-xianxia），但 `createDefaultConfig()` 默认 `school-romance-anime`，且**无题材自动选择逻辑**（genreHint 字段存在但无人填写/消费）。实测两项目 basePrompt 全是 Kyoto Animation 风格——古风项目（桑尘草）碰巧对，现代职场（苏遇）则违和。
4. **跨表情漂移**：全局 profiles 首次写入锁定（`if (!existing || !basePrompt)`），机制存在但**旧扁平结构无 baseline/version/history**；`MasterCharacterProfile`（`canonical-entity-resolver.ts`，含 baseline/history/gender/age）已定义但**只有迁移脚本引用，管线零消费**；`migrate-legacy-profiles.ts` 是否对现有项目执行过未知。
5. **ID 重复**：`CanonicalEntityResolver`（拼音归一 + Levenshtein + 共现互斥）已实现但**管线零消费**；实测重复率 ~15%（姚露×2、桑尘草×2 mojibake、众豪杰群像×4）。

---

## 二、设计目标

1. **零性别翻转**：从 attribution 到生图的每个 hop 都有显式 gender，后备链路也有性别正确的默认。
2. **成语不直译**：中文外貌修辞必须经词典映射后才进入英文 prompt；未覆盖的修辞可检出告警。
3. **风格与题材匹配**：项目题材（现代/古风/玄幻）决定 style template，不再全员京阿尼。
4. **跨章节/跨表情一致**：同一角色所有立绘共享不可变母版，表情只做增量。
5. **档案可维护**：profiles 结构统一（新 Master 结构），旧数据可迁移，RAG 与 profiles 双向同步不打架。
6. **演出符合 Galgame 惯例**：立绘规格（waist-up 白底、表情差分命名）与 DDLC/行业规范对齐，Ren'Py/Web 双端消费一致。

**非目标**：重训模型；改 IR 版本（v1.0 冻结）；新 Agent（管线冻结）；高清重绘已生成的图。

---

## 三、方案：角色圣经（Character Bible）

### 3.1 核心概念

**Character Bible = 每个角色一份不可变母版 + 版本化演变记录**，是 RAG 角色库的"写后锁定层"：

```
小说原文 (attribution units)
    │  每章提取 appearance/personality/relationship chunks（现有 character-chunker）
    ▼
RAG 角色库（动态、追加式、跨章节累积）← 现有 KnowledgeStore
    │  首见角色 / 新证据
    ▼
Visual Prompt Agent ──组装──▶ Character Bible（锁定母版）
    │  gender/age/hair/face/build/attire/basePrompt/style/evidence
    ▼
Asset Manifest（每表情 prompt = 母版 + 表情增量）
    ▼
Image Producer（显式 gender token + 风格模板 + 负面约束）
```

关键不变量：
- **母版首次写入锁定**：`baseline.version=1` 后永不覆写；后续章节只追加 `history`（服装演变）与 `evidence`，不改母版。
- **性别显式化**：Bible 必有 `gender: female|male`；任何下游 prompt 组装必须包含性别 token，缺失则报错而非静默 fallback。
- **成语过滤点唯一**：所有中文→英文外貌翻译经过 `CHINESE_IDIOM_PROMPT_MAP` + 兜底规则（见 3.4），LLM 输出后再经正则复检。

### 3.2 数据结构

复用已有的 `MasterCharacterProfile`（`packages/core/src/domain/canonical-entity-resolver.ts:28-39`），无需新类型：

```typescript
{
  characterId, canonicalName, aliasSet[],
  gender?: "female" | "male" | "unknown",   // ← 必填化：unknown 触发补问/默认流程
  age?: string,
  personality?: string,
  baseline: {
    version: 1,
    hair?, face?, build?, defaultAttire?,    // ← 结构化外貌字段（新增消费）
    basePrompt: string,                       // 纯外貌英文母版（含性别词）
    firstSeenChapter, lockedAt,
  },
  baselineHistory?: [...],                    // 母版修订记录（人工修正时用）
  history: [{ chapterId, outfit?, action? }], // 服装/状态演变
  evidence: [...],                            // appearance 类原文证据
  updatedAt,
}
```

迁移：对现有旧扁平 profiles 运行 `migrate-legacy-profiles.ts --apply`（先 dry-run 审计），`baseline = { basePrompt: 旧basePrompt, ... }`，gender/age 从 basePrompt 文本回填（规则见 3.3）+ 人工复核 unknown。

### 3.3 性别链路（P0-1 修复）

> **DDLC 交叉验证**：DDLC 立绘本身不编码性别——性别由角色设计（发型/服装/脸部部件）承载，`definitions.rpy` 无 gender 字段。这印证：**性别必须在 prompt 组装层显式锚定，不能依赖模型从名字/表情推断**。本方案在 Bible 层做 DDLC 缺失的显式化（DDLC 是人工立绘，不需要；AI 生图必需）。

| Hop | 现状 | 改动 |
|-----|------|------|
| Attribution 输出 `CharacterRef` | 无 gender | attribution prompt 要求输出性别（他/她/名字+语境推断）；`CharacterRef` 加 `gender?: "female"\|"male"\|"unknown"`（core 类型扩展，IR v1.0 不动——CharacterRef 非 IR） |
| RAG chunk/metadata | 无 gender | `baseMeta` 加 gender；identity chunk 文本含性别（`角色: 苏遇 \| 性别: 女`）；appearance 检索时返回 gender |
| Visual Prompt Agent 输出 | 有 gender 字段但下游不用 | 组装 `finalPrompt` 时**首句强制性别锚点**：`A young woman ...` / `A tall man ...`；`characterKnowledge` 注入性别；LLM 输出后校验：无性别词 → 用 Bible/attribution 性别补首句 |
| `character_profiles.json` | 扁平旧结构 | 写 Master 结构（含 gender/baseline）；profile 更新时 gender 只从 unknown→已知单向补全 |
| RenPyBuilder manifest | 只透传 basePrompt | 透传 gender；无 basePrompt 时 fallback 用 `characterId→Bible→gender token + canonicalName`，**删除硬编码 `1girl`**（`renpy-builder.ts:199`、`openai-image-producer.ts:94`） |
| Producer `buildPrompt` | fallback `1girl` | fallback 改为 gender 感知：female→`1girl`，male→`1man`，unknown→`1person` + 日志告警 |

性别判定优先级：Bible.gender > attribution gender > 代词统计（他/她计数）> LLM 回填 > unknown（告警+人工）。

### 3.4 成语词典（P0-2 修复，验证+接线）

1. **词典扩充**（`CHINESE_IDIOM_PROMPT_MAP`）：现有 10 词 → 覆盖审计 + 实测高频：加 `柳叶眉`、`凤眼`、`杏核眼`、`剑眉`、`卧蚕`、`高鼻梁`、`樱桃小嘴`、`薄唇`、`瓜子脸`（已有）、`鹅蛋脸`、`身材高挑`、`肤白` 等。目标 25–30 词。
2. **接线**：在 `runVisualPromptAgent` 组装 `finalPrompt` 前，对 `baseAppearance`+`currentOutfit` 做词典替换（中最长匹配），替换后文本进 LLM 输入的"已翻译术语"白名单，system prompt 加条款"白名单术语严禁改写/直译"。
3. **复检**：输出后正则扫描：残留 `peach-blossom|peach blossom|phoenix eye(字面)|willow-leaf eyebrow(字面)` 等 → 命中则用词典重写该句（规则替换，不调 LLM）。
4. **外置 prompt 同步**：`data/prompts/visual-prompt.md` 追加 idiom 条款（当前外置文件覆盖代码默认，不改则零生效）。
5. **未覆盖检出**：`APPEARANCE_REGEX` 命中的中文外貌词若不在词典中 → `console.warn` + 记入 `evidence`，供后续扩词典（不阻塞）。

### 3.5 题材风格（P1-3 修复）

- **题材判定**：structure agent 输出或项目创建时确定 `genreHint: "modern" | "ancient" | "xianxia" | "school" | ...`（`ProjectConfig.genreHint` 已存在）。判定源：书名/简介关键词（总裁/银行/职场→modern；江湖/宗门/修仙→xianxia；王爷/后宫→ancient）+ 首章采样 LLM 一次判定（缓存进 project.json）。
- **模板映射**：modern→`modern-workplace`/`urban-romance`；ancient→新增 `ancient-modern`（非玄幻古装：细腻写实、汉服常服、自然黑发，禁奇幻发色）；xianxia→`ancient-xianxia`；school→`school-romance-anime`。默认 `school-romance-anime` 改为按题材选择，无题材时 `urban-romance`（当前用户群 600+ 现代言情为主）。
- **配置页暴露**：`VisualPromptPage` 已有单场景 `styleTemplate` 下拉（默认 `school-romance-anime`），但**项目级默认模板无处可设**（`ProjectConfig` 无 styleTemplate 字段，`visualStyleTemplate` 固定 `school-romance-anime`）。M3 需加项目级字段 + 项目设置页入口。

### 附录 A：表情规范化映射表（16 标签，基于实测 353 名词频制定）

> 规则：命中→映射为标准标签；未命中→透传原名 + `console.warn`（供后续补映射）；中文表情→先查词典，无词典则透传+告警。manifest 文件名与 `expression` 字段写映射后标签，`label` 保留原名备查。

| 标准标签 | 映射来源（实测高频，括号内为出现次数） |
|----------|--------------------------------------|
| `neutral` | neutral(1163)、normal(8)、casual(68)、calm(365)、composed、relaxes、relieved(19)、indifferent(14)、nonchalant |
| `smile` | smile(29)、smiling、gentle(51)、warm(11)、friendly(13)、kind |
| `happy` | happy(44)、cheerful(17)、excited(18)、joyful、delighted、laughing |
| `smug` | smug(22)、smirk(49)、sneer(10)、teasing(12)、playful、mischievous |
| `blushing` | blushing、shy、embarrassed(13)、bashful |
| `sad` | sad、sorrowful、downcast、melancholy(8)、dejected |
| `crying` | crying、tearful、sobbing、weeping |
| `troubled` | troubled、worried(13)、concerned(39)、anxious(13)、nervous(15)、uneasy |
| `angry` | angry(34)、annoyed(52)、furious、irritated、exasperated(14)、indignant(7) |
| `serious` | serious(82)、stern、solemn、grave |
| `cold` | cold(45)、icy、frosty、distant |
| `thinking` | thinking(30)、thoughtful(43)、contemplative(11)、pensive(10)、pensive |
| `surprised` | surprised(145)、amazed(11)、astonished、startled |
| `shocked` | shocked(74)、stunned、dazed(9)、speechless(39)、dumbfounded |
| `determined` | determined(68)、resolute、focused(34)、firm |
| `fearful` | fearful、afraid、scared、panicked(10)、terrified、alarmed |

长尾低频（tired/sleepy/skeptical/sly 等）暂透传， quarterly review 时按新词频补映射。

### 3.6 RAG 双向维护（动态维护机制）

现状是单向：RAG → visual-prompt（knowledge）→ profiles（锁定）。缺两环：

1. **profiles → RAG 回写**：Bible 锁定后，将母版（basePrompt + gender + attire）以 `type: "bible"` chunk 写入角色库（最高检索权重），后续章节的 `characterKnowledge` 优先命中母版而非零散 chunks，保证跨章节一致。
2. **冲突处理**：新章节 evidence 与母版矛盾（如换服装）→ 记 `history`，不改母版；性别矛盾 → 告警（可能是 ID 重复/指代错），进人工复核队列。
3. **去重接线**：`CanonicalEntityResolver` 接入 attribution 后处理（C-1 方案）：已知角色强制复用 ID；新 ID 与已知 ID 相似度超阈值 → `pending_confirmation`（不自动合并，避免误杀）。mojibake ID（`char_sangchenc��o`）在归一化层拦截（非 ASCII/非中文字符 ID 告警）。
4. **群像角色**：`众豪杰`类群像（无性别/多性别）标记 `isGroup: true`，走背景/CG 路径而非单人立绘（当前为其生成单人立绘是浪费+错误）。

### 3.7 Galgame 演出对齐（立绘规格）

对照 DDLC + 行业规范，当前已达标 vs 待补：

| 项 | 行业/DDLC 标准 | 当前 | 动作 |
|----|---------------|------|------|
| 立绘基线 | waist-up 白底、直视镜头 | ✅（pose 已固定） | 无 |
| 表情差分 | 5 大类 15+（DDLC 为 pose+expr 编码 `1a/4p`，单角色 81–317 组合，换脸不换身） | ⚠️ **353 个自由表情名**（neutral 1163 次断层第一，calm 365、surprised 145…长尾含中文表情 7 个） | **表情名规范化到 16 标签矩阵**（映射表见附录 A，旧名兼容+未知名透传+告警）；manifest 文件名 `char/<id>/<expr>.png` 已符合惯例；**部件级复用（LayeredImage）一期不做**（diffusion 直出做不到，成本/复杂度不合算） |
| 母版分辨率 | 1200–1800px 高（DDLC 部件 960×960，背景 1280×720） | ❓ 当前请求 `1024x1024`（立绘）/`1024x576`（背景） | 确认 Agnes 是否支持竖构图尺寸（如 768×1024/832×1216），支持则立绘改竖构图；否则方形出图后按 bbox 裁剪 |
| 多人站位 | 5 锚点 + focus/dim（已实现 Phase 12） | ✅（与 DDLC `f-slot zoom 1.05` 语义一致） | 无 |
| 表情切换演出 | DDLC 内联切换（同立绘换表情，不断演出流） | ⚠️ 每个表情独立 PNG，切换=换图 | 短期可接受（Ren'Py `show` 同 position 换图即等效）；长期评估 LayeredImage |
| 入场/退场 | DDLC `tcommon`（easein .25 上浮+淡入）/`thide`（缩小+下沉+淡出）两步退场 | ⚠️ 入场有 `enter_fade_in/slide_left/slide_right`（0.4–0.5s，与 DDLC 语义一致），**退场无对应两步式 hide 变换** | M5 补 `exit_fade_out/slide_out`（thide 等效：easein .25 zoom×0.95 + yoffset −20 + alpha→0），`script-generator.ts` 的 hide 语句挂 `with` 变换 |
| 群像/CG | 特殊构图 CG（DDLC `cg/` 49 文件） | ❌ 无 | 群像标 `isGroup` 后走 CG/背景路径（一期只做标记+跳过立绘） |

---

## 四、工作量评估

| 模块 | 内容 | 规模 |
|------|------|------|
| M1 性别链路 | core 类型 + attribution prompt + RAG meta + agent 组装校验 + profiles 写读 + builder/producer fallback | 中（~6 文件，后端为主） |
| M2 词典接线 | 扩词典 25–30 + 组装前替换 + 输出复检 + 外置 prompt 同步 + 未覆盖告警 | 小（~3 文件） |
| M3 题材风格 | genre 判定（规则+缓存）+ 模板映射 + 默认变更 + 配置页暴露（待查） | 小–中 |
| M4 RAG 双向 | bible chunk 回写 + 冲突规则 + resolver 接入 + mojibake 拦截 + 群像标记 | 中（~4 文件） |
| M5 演出对齐 | 表情规范化映射 + Agnes 尺寸确认 + templates 入退场核查 | 小（核查为主） |
| M6 数据迁移 | migrate dry-run 审计 → apply → 删除 67636322d213 的 UTF-16 空档（外部污染，非写入 bug，不修路径） | 运维动作，按项目执行 |
| M7 验证 | tsc + 单章管线重跑 + 抽查 manifest prompt 含性别/无直译 + 生图目视 | 测试动作 |

**建议执行顺序**：M1 → M2 → M5（核查）→ M3 → M4 → M6 → M7。M1/M2 可独立先行；M4 依赖 M1 的 gender/Bible 结构。

---

## 五、待确认事项（评估执行前）

1. ✅ ~~DDLC 立绘解剖~~——已完成（unrpa 解包 + PIL 实测 + definitions.rpy 交叉验证）。结论：分层部件制（身体复用+换脸差分）对 diffusion 直出不可复制，一期不做部件级复用；差分规模（单角色 81–317 组合）证实"表情矩阵"方向正确。
2. ✅ ~~UTF-16 空档~~——已定位：外部污染（管线只写 utf-8），M6 删除重建，不修路径。
3. `migrate-legacy-profiles.ts` 在实测数据中零 `baseline` 痕迹——`fc9a9e5` 只迁了 `data/rag`，profiles 迁移**未执行过**。M6 需全量执行（dry-run 先审）。
4. Agnes 画像尺寸：当前代码请求 `1024x1024`（立绘）/`1024x576`（背景）；DDLC 立绘部件 960×960、背景 1280×720。Agnes 是否支持竖构图（如 768×1024）待实测确认——M5 第一动作就是打一张竖构图探针。
5. ✅ ~~表情映射表~~——已基于实测 353 名词频制定（附录 A），策略"映射+透传+告警"无需再审。
6. IR v1.1 候选（本次不做，仅记录）：DDLC `{cps}/{w}/{nw}/menu` 文字演出标签在 IR v1.0 无对应语义；`thought` 的半透明独立文本框 + 背景虚化在 Web Preview 是否已实现待核查。

---

*方案初稿，待用户评估后拆解执行。*
