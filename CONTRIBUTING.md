# Contributing to All Novel Can Be Galgame

欢迎贡献！无论是修 bug、提 feature、优化文档还是分享你生成的 Galgame 作品。

## 快速开始

```bash
git clone https://github.com/lin1753/novel2galgame.git
cd novel2galgame
pnpm install
pnpm build
```

## 开发流程

1. **Fork** 本仓库
2. 创建 feature branch: `git checkout -b feat/your-feature`
3. 提交代码: `git commit -m "feat: 描述你的改动"`
4. Push: `git push origin feat/your-feature`
5. 开 Pull Request

## 项目结构

```
apps/api/          TypeScript 后端 (Express + SQLite)
apps/workbench/    React 前端 (Vite + Tailwind)
packages/
  agents/          7 个 AI Agent
  rag/             RAG 知识检索 (bge-small-zh + Hybrid)
  core/            领域模型 & Zod Schema
  storage/         SQLite + 文件系统
  providers/       LLM/Image/Video Provider
  ir/              VN Script IR v1.0
  asset/           Asset Pipeline
  export/          Ren'Py Builder
  runtime/         VN Web 播放引擎
```

## Commit 规范

- `fix:` — bug 修复
- `feat:` — 新功能
- `docs:` — 文档
- `refactor:` — 重构
- `chore:` — 杂项
- `perf:` — 性能优化

## 测试

```bash
# 运行 structure agent 测试
npx tsx packages/agents/src/__test__/structure-agent.test.ts

# 运行 RAG A/B 评测
cd apps/api && npx tsx src/evaluate-rag-ab.ts
```

## License

Apache 2.0 — 详见 [LICENSE](LICENSE)
