# 交接文档：Auto-Export 管线截断与模型配置排查总结

**项目名称**: All Novel Can Be Galgame (novel2galgame)
**当前阶段**: 开发后期调试，主要针对 LLM 长文本截断与 JSON 格式化容错性进行修复。

## 1. 最近修改的代码与修复成果
我们在最近几个回合中对底层的稳定性进行了大手术，修改了以下文件：

1. **packages/agents/src/narrative-parsing/narrative-parsing-agent.ts**
   - **修改内容**: 彻底重写了 splitText 函数。旧版只按换行符 \n 切割，导致某些小说的长段落一次性被塞给 LLM（高达 300+ 字符），触发了推理模型（如 gnes-2.0-flash）的 inish_reason: length 超长截断报错。新版加入了按标点（。！？）分割，并加入了强制按字数（150字）硬截断的防呆机制。
   - **成果**: 彻底解决了 Completion truncated by max_tokens 报错，长段落的切分 Chunk 数量显著增加，运行极度平稳。

2. **packages/providers/src/llm/fetch/fetch-provider.ts**
   - **修改内容 1**: 修复了“取消任务引发无限重试”的低级 Bug。增加了对 AbortError 的判断：当用户手动取消时，拦截并停止 catch 块里的网络错误重试逻辑。
   - **修改内容 2**: 增加了请求模型的显式日志打印 console.log("[FetchLLM] Requesting model: " + modelName)，用于追踪前端模型配置是否真实生效。

3. **pps/api/src/routes/auto-export.ts 及 projects.ts、scenes.ts**
   - **修改内容**: 将硬编码兜底的 "agnes-2.0-flash" 移除，强制引入 esolveModelConfig("text").model，尝试让后端的 API 路由能够严格读取前端 UI 的全局模型映射配置。

4. **SQLite 数据库 (data/config/app.db)**
   - **修改内容**: 执行了 SQL 脚本去除了已存在项目 project.config 中私藏的 defaultTextModel 字段，试图破除历史项目对 gnes-2.0-flash 的执念。

5. **全系列 Agent 提示词外置化 (Hot-reloading Prompts)**
   - **修改内容**: 之前仅有 n-mapping 接入了外置加载。现在已为 
arrative-parsing, scene-segmentation, idelity-review 注入了 loadPrompt。
   - **成果**: 下次启动 API 并触发一键运行后，系统会自动在 data/prompts/ 下生成所有 .md 格式的 Prompt 文件。以后修改 Prompt（如添加 Goodcase/Badcase）只需直接修改 .md 文件，无需重启 API，无需重新编译！

---

## 2. 当前依然存在的两个核心问题（需 Claude 排查）

### 问题一：前端模型配置“幽灵”未生效
- **症状**: 用户明确在前端全局设置里把文本模型切换为了 gnes-2.5-flash，但后端终端打印的日志依然是 [FetchLLM] Requesting model: agnes-2.0-flash。
- **排查建议**:
  1. 请排查前端 pps/workbench 中调用 /projects/:id/auto-export/start 时，Payload 里的 model 字段是否传递了旧数据。
  2. 请排查 pps/api/src/config/index.ts 中的 esolveModelConfig("text") 是否存在缓存，或者 data/config/model-profiles.json 的读写同步是否存在问题。

### 问题二：LLM 的 JSON 语法错误（未转义双引号）
- **症状**: 推理模型经常在原文带有双引号时，输出诸如 "originalText": "他说："你好"" 的裸双引号，导致 jsonrepair 解析直接崩溃，报 Expected ',' or '}' after property value in JSON，并触发 3 次 Retry。
- **用户建议**: 通过在 Prompt 里增加 Goodcase 和 Badcase 来强制大模型学会转义。
- **排查建议**: 由于已经实现了提示词外置化，您可以直接前往 data/prompts/narrative-parsing.md，为其增加 JSON 格式的双引号转义正反面示例（Good/Bad Cases），以规避由于中文小说中包含引号而导致的结构破坏。

---

## 3. 接手指南
- 所有 packages/ 目录下的修改，必须在根目录执行 **pnpm build**（或针对特定包 pnpm --filter @novel2gal/agents build）才能使编译后的 dist 生效供 pps/api 读取。
- 启动 API 请使用 pnpm --filter @novel2gal/api dev，它使用 	sx watch 但只能热重载 API 本身的代码，外部 Workspace 依赖需要走编译。
