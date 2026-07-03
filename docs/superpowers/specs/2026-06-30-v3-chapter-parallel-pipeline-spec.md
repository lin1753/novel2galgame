# V3 章节并行管线 + 全链路贯通方案

> 日期: 2026-06-30 | 分支: v3-export | 状态: 设计稿

---

## 1. 问题分析

### 1.1 当前不足

| # | 问题 | 影响 |
|---|------|------|
| 1 | Auto-export 串行处理章节，用户需等待全部完成 | 长小说(90章)等待 >30min |
| 2 | SSE 进度只有 stage 级别，无章节/场景粒度 | 用户无法知道具体进度 |
| 3 | ScenesPage 内容面板显示占位符，API 路由已存在但前端未调 | 场景工作区不可用 |
| 4 | ScenesPage 操作按钮无绑定 | 无法从 UI 触发 VN 映射/审核 |
| 5 | Editor 保存后预览不刷新 | 编辑→预览体验割裂 |
| 6 | 导出成功后无路径展示/打开链接 | 用户不知道去哪玩 |
| 7 | Preview 页面使用占位色块，已生成的图片不展示 | 预览体验差 |

### 1.2 用户目标

```
上传 → 解析 → 创作 → 预览 → 微调 → 导出 VN Script IR → 导出 Ren'Py → 可游玩
```

关键：章节间并行处理，用户边等边看已完成章节。

---

## 2. 架构设计

### 2.1 异步任务队列系统

新增 `apps/api/src/task-queue/task-queue.ts`:

```typescript
class PipelineTaskQueue {
  maxConcurrency: number;        // 默认 3 章并行
  activeChapters: Map<chapterId, AbortController>;
  completedChapters: Map<chapterId, ChapterResult>;
  failedChapters: Map<chapterId, {error: string}>;

  async enqueue(projectId, chapters[], provider, model): Promise<string>;  // 返回 taskId
  cancel(chapterId): void;
  getStatus(): TaskStatus;
}
```

**并发策略：**
- 默认同时处理 `min(3, cpu_cores)` 章
- 每章内部 scene-level 并行保持现有 `parallelLimit(3)`
- 总 LLM 并发 = chapters_concurrent × scenes_concurrent (3×3=9 最大)

**取消机制：** 使用 `AbortController`，用户可取消指定章节或整个任务。

### 2.2 SSE 进度事件格式增强

```typescript
type ProgressEvent = {
  taskId: string;
  projectId: string;
  chapterId?: string;       // 新增 — 标识哪一章
  sceneId?: string;         // 新增 — 标识哪个场景
  stage: string;            // "structure" / "narrative" / "attribution" / "segmentation" / "vn_mapping" / "fidelity_review" / "visual_prompt" / "export" / "assets" / "complete"
  status: "started" | "progress" | "completed" | "failed" | "cancelled";
  message?: string;
  data?: {
    current?: number;       // 当前进度
    total?: number;         // 总数
    chapterIndex?: number;  // 章节索引
    sceneIndex?: number;    // 场景索引
  };
};
```

前端按 `chapterId` 分组展示进度，每章一个进度条区域。

### 2.3 前端 SSE 进度展示

`ProjectOverviewPage` 增加章节级进度面板：

```
┌─ 一键处理进度 ──────────────────┐
│ [===================] 整体 60%   │
│                                 │
│ ■ 第1章: 场景1 VN映射 ✅        │
│ ■ 第2章: 归因分析 ✅            │
│ ■ 第3章: 叙事解析 ◌ 处理中...   │
│ ■ 第4章: ⏳ 排队中               │
└─────────────────────────────────┘
```

每章可点 → 跳转到对应章节的场景预览。

### 2.4 ScenesPage 内容连线

当前 `ScenesPage.tsx` 第 101-106 行显示占位符，需要：

| Tab | 应调用的 API | 已有？ |
|-----|-------------|--------|
| 原文 | `GET /projects/:id/scenes/:sceneId/script` → `vn_script.json` | ✅ |
| 解析 | `GET /projects/:id/chapters/:chapterId/narrative` → `narrative-units.json` | ✅ |
| 归因 | `GET /projects/:id/chapters/:chapterId/attribution` → `attributed-units.json` | ✅ |

操作按钮：

| 按钮 | 应调用的 API | 已有？ |
|------|-------------|--------|
| 运行 VN 映射 | `POST /projects/:id/chapters/:chapterId/run` | ✅ |
| 查看忠实性报告 | `GET /projects/:id/scenes/:sceneId/fidelity` | ✅ |
| 生成视觉提示 | `POST /projects/:id/scenes/:sceneId/visual-prompt/run` | ✅ |

### 2.5 Editor→Preview 联动

Editor 保存成功后：
1. 调用 `queryClient.invalidateQueries(['script', projectId, sceneId])`
2. PreviewPage 默认使用 staleTime=0，自动重新加载

### 2.6 导出结果展示

Export 成功后，显示可点击的路径 + 快速操作按钮：

```
┌─ 导出成功 ──────────────────────┐
│ 📁 data/projects/xxx/export/项目名/    │
│                                   │
│ [打开目录] [复制路径] [指南]      │
└───────────────────────────────────┘
```

---

## 3. 文件改动清单

### Phase A: 异步任务 + 章节并行

| 文件 | 改动 |
|------|------|
| `apps/api/src/task-queue/task-queue.ts` | **新建** — 任务队列类 |
| `apps/api/src/task-queue/index.ts` | **新建** — barrel export |
| `apps/api/src/routes/auto-export.ts` | **重写** — 改用 TaskQueue，支持 cancel |
| `apps/api/src/routes/progress.ts` | **增强** — 按 taskId 分组连接 |
| `apps/api/src/server/server.ts` | 注册 task-queue 相关路由 |
| `apps/workbench/src/pages/ProjectOverviewPage.tsx` | 章节级进度面板 |
| `apps/workbench/src/services/projects.ts` | 增加 cancelAutoExport |
| `apps/workbench/src/hooks/useAutoExport.ts` | **新建** — SSE hook |

### Phase B: ScenesPage 内容连线

| 文件 | 改动 |
|------|------|
| `apps/workbench/src/pages/ScenesPage.tsx` | 替换占位符为真实 API 数据，绑定按钮 |
| `apps/workbench/src/services/scenes.ts` | 添加 getNarrative/getAttribution/runVnMapping 等 |
| `apps/workbench/src/hooks/useScenes.ts` | 增加场景操作 mutations |

### Phase C: Editor→Preview + Export UX

| 文件 | 改动 |
|------|------|
| `apps/workbench/src/pages/EditorPage.tsx` | 保存后 invalidate preview |
| `apps/workbench/src/pages/ProjectOverviewPage.tsx` | 导出成功后显示路径+操作 |

### Phase D: 资产管理页面 + Preview 真实图片

**目标:** 建立独立资产页面，用户可查看/调整每张图片，改动自动同步到 Preview 和 Export。

#### D1 项目级资产存储

当前图片生成到 export 目录，不通用。改为项目级资产目录：

```
data/projects/{id}/
  assets/
    images/
      bg/                     # 背景图片
        {safeId}.png
      char/                   # 角色立绘
        {charId}/
          {expression}.png
          default.png
      cg/                     # CG (未来)
    manifest.json              # 资产清单 (复用 @novel2gal/asset)
```

**API 路由（新建 `apps/api/src/routes/assets.ts`）：**

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/projects/:id/assets` | 获取资产清单 + 所有图片列表 |
| GET | `/projects/:id/assets/bg` | 获取背景列表（含标签+预览URL+状态） |
| GET | `/projects/:id/assets/characters` | 角色立绘列表（按角色+表情分组） |
| POST | `/projects/:id/assets/generate` | 生成/重新生成指定资产 `{type, assetId, expression?, prompt?}` |
| GET | `/projects/:id/assets/image/:type/:path` | 提供图片文件服务 |

#### D2 资产页面（前端）

**新页面** `apps/workbench/src/pages/AssetsPage.tsx` → 路由 `/projects/:id/assets`

```
┌─ 项目管理 ─────────────────────────────┐
│ [背景] [角色] [CG(即将推出)]             │
│                                         │
│ ┌─── 第1章 蓝星区巷口 ───┐              │
│ │ [img] 蓝星区无人的巷口  │ ← 缩略图     │
│ │ 状态: ✅ 已生成          │              │
│ │ [重新生成▾] [选择风格▾]  │              │
│ └─────────────────────────┘              │
│                                         │
│ ┌─── 角色: 张三 ─────────┐              │
│ │ [img] default          │ ← 默认立绘   │
│ │ [img] arrogant         │ ← 傲慢表情   │
│ │ [img] smile            │ ← 微笑       │
│ │ [重新生成全部] [新增表情]│              │
│ └─────────────────────────┘              │
└─────────────────────────────────────────┘
```

**核心功能：**
- Tab 切换：背景 / 角色
- 按章节/场景筛选视图
- 每张卡片显示：缩略图、标签、状态(placeholder/generated/manual)
- 重新生成按钮 → 弹出模型选择（Agnes/Flux等）→ 调用 API → 刷新缩略图
- 未来支持：手动上传替换、CG 管理

#### D3 Preview 集成

`PreviewPage.tsx` 改动：
- 加载场景时，通过 `GET /projects/:id/assets/image/bg/{id}.png` 检查是否有真实图片
- 有 → `<img src="/api/projects/{id}/assets/image/bg/{id}.png" />`
- 无 → 保留当前占位色块
- 角色同理：`<img src="/api/projects/{id}/assets/image/char/{charId}/{expression}.png" />`

#### D4 Export 集成

`packages/export/src/renpy/renpy-builder.ts` 改动：
- 执行时读取项目资产目录 `data/projects/{id}/assets/images/`
- 遍历 assets/images/bg/ 中的 PNG，复制到 `game/images/bg/`
- 遍历 assets/images/char/ 中的 PNG，复制到 `game/images/char/{charId}/`
- 优先使用 PNG，回退到 SVG placeholder（asset-manager.ts 已有此逻辑）

#### D5 文件改动清单

| 文件 | 改动 |
|------|------|
| `apps/api/src/routes/assets.ts` | **新建** — 资产相关 API 路由 |
| `apps/api/src/server/server.ts` | 注册 `/assets` 路由 |
| `apps/workbench/src/pages/AssetsPage.tsx` | **新建** — 资产页面 |
| `apps/workbench/src/app/App.tsx` | 添加 `/projects/:id/assets` 路由 |
| `apps/workbench/src/services/assets.ts` | **新建** — 资产 API service |
| `apps/workbench/src/pages/PreviewPage.tsx` | 加载真实图片替换占位色块 |
| `apps/workbench/src/pages/ProjectOverviewPage.tsx` | 增加"资产管理"导航链接 |
| `apps/workbench/src/app/layouts/Layouts.tsx` | 侧边栏加资产导航 |
| `packages/export/src/renpy/renpy-builder.ts` | Build 时复制项目资产到 export 目录 |

---

## 4. 数据流

```
[Auto-Export 按钮]
       ↓
POST /projects/:id/auto-export (新)
       ↓
TaskQueue.enqueue(projectId, chapters)
       ↓
返回 { taskId, status: "started" }
       ↓
[后台] TaskQueue 循环:
  ├─ 取下一章 (max 3 并发)
  │    ↓
  │  runChapterPipeline(chapter)
  │    ├─ Narrative → Attribution → Segmentation
  │    └─ [每场景并行] VN Mapping → Fidelity → Visual Prompt
  │    ↓
  │  emit(progress SSE: chapterId, stage, status)
  │
  ├─ 所有章完成
  │    ↓
  │  自动 Export Ren'Py
  │    ↓
  │  emit(progress SSE: stage="export", status="completed")
  │
  └─ 过程中用户可:
       ├─ 点已完成章节 → 预览/编辑
       ├─ POST /projects/:id/auto-export/cancel/:chapterId
       └─ SSE 实时看每章进度
```

---

## 5. 错误处理

| 场景 | 处理 |
|------|------|
| 单章管线失败 | 标记该章为 `failed`，继续处理其余章 |
| 所有章都失败 | 整体标记 `failed`，不触发导出 |
| 用户取消 | AbortController 中断进行中的 LLM 调用 |
| API 超时/截断 | 复用现有 `withRetry`（指数退避，最多 3 次） |

---

## 6. 不纳入本次范围的

- Visual Editor 的实时游戏预览（需要更大的重构，单独规划）
- Godot/Web 等其他 runtime 导出（未来 Phase）
- AI Pipeline Agent 数量/准确率优化（管线已冻结）
- 数据库迁移或 schema 变更（不涉及）

---

## 7. 验收标准

| # | 验收项 |
|---|--------|
| 1 | Auto-export 同时处理 ≥3 章，SSE 展示每章独立进度 |
| 2 | 一章失败不影响其他章 |
| 3 | 处理中可取消指定章节 |
| 4 | ScenesPage 显示原文/解析/归因真实数据 |
| 5 | ScenesPage 操作按钮可触发对应 API 并展示结果 |
| 6 | Editor 保存后 Preview 页面立即显示新数据 |
| 7 | 导出成功后显示可操作的路径 |
| 8 | 已生成图片在 Preview 中展示（Phase D） |
