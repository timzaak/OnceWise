# OnceWise Flow

[English](README.md) | 简体中文

OnceWise Flow 自动化重复的网页操作——反复填写的表单、多步页面流程、每日例行填报。用自然语言向 AI 助手描述这段例行工作，它会在真实页面上试做一遍、提炼成一条受约束的流程，再经一条永不离开你设备的通道交付给本扩展。你检查一次、点一下启用，之后每次打开匹配的页面，这些步骤自动执行。

**[从 Chrome 应用商店安装](https://chromewebstore.google.com/detail/dmmhmcdbkbbgbcidafhlhepdchjboenc)** | [入门教程](https://timzaak.github.io/OnceWise/zh/docs/getting-started) | [文档站](https://timzaak.github.io/OnceWise/) | [隐私政策](https://timzaak.github.io/OnceWise/en/privacy)

## 亮点

- **受约束的流程，而非任意脚本**——流程是带时间预算的受限步骤序列（填写、点击、读取、等待、断言、循环），在需要登录的页面上运行也安全
- **本地优先**——流程、设置与版本历史全部保存在浏览器本地存储；无账号、无分析、无追踪
- **按站点生效**——流程只在其编写时指定的站点上运行
- **你始终掌控**——每条流程到达时一律处于停用状态；由你检查、由你启用，可回滚最近 10 版历史
- **可选自托管同步**——把选定流程以带版本的脚本分享给同事与设备；没有它扩展照常工作

## 快速开始

1. 从 [Chrome 应用商店](https://chromewebstore.google.com/detail/dmmhmcdbkbbgbcidafhlhepdchjboenc)安装扩展。
2. 在你的 AI 工具（Claude Code、Cursor、ZCode 等支持 Agent Skills 格式的工具）中安装 OnceWise skills：

   ```bash
   npx skills add timzaak/OnceWise --skill oncewise-setup --skill oncewise-flow --skill oncewise-message
   ```

3. 安装一次本机宿主（Node 22+）：`node skills/oncewise-message/install.mjs`
4. 让 AI 在当前页面录一条流程，在侧边栏检查后点击启用。

完整教程（源码构建、MCP 配置、本机宿主排错、第一条流程）：[简体中文](https://timzaak.github.io/OnceWise/zh/docs/getting-started) · [English](https://timzaak.github.io/OnceWise/en/docs/getting-started)

## 目录结构

- `extension/` — Chrome MV3 扩展（WXT + React）：流程工作台 sidepanel、运行前输入表单、同站跨页续跑、dry-run、「同步」页签
- `backend/` — oncewise-ai-sync 数据同步服务（axum + PostgreSQL；空间由客户端生成的 ID+密钥寻址，无账号体系）
- `skills/` — 三个 Agent Skills（`oncewise-setup` / `oncewise-flow` / `oncewise-message`）及其交接所用的本机消息宿主（根目录 `.claude-plugin/marketplace.json` 将三者声明为同一插件）
- `demo/` — Playwright 扩展集成测试
- `docs/` — PRD 与用户故事（[索引](docs/prd/00-index.md)）；`docs/store-listing/` 为 Chrome Web Store 上架材料
- `DESIGN.md` — 视觉规范

## 开发

```bash
# 扩展（MV3 构建 → extension/.output/chrome-mv3；在 chrome://extensions「加载已解压的扩展程序」）
cd extension && npm install && npm run build

# 同步后端（外部 PostgreSQL 必填；默认监听 0.0.0.0:8080）
docker run -d --name oncewise-demo-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:18-alpine
cd backend && DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres cargo run
```

所有测试与 Demo 运行说明统一维护在 [scripts/index.md](scripts/index.md)；贡献者约定（含 `skills/` → `.agents/skills/` 同步纪律）见 [AGENTS.md](AGENTS.md)。

## 开源许可证

本项目以 [Apache License 2.0](LICENSE) 开源。
