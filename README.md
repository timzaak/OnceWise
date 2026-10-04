# OnceWise AI

智能表单自动化助手 Chrome 扩展（WXT + React，界面英语为主、内置中文 i18n，本地优先存储）与 oncewise-ai-sync 数据同步后端（Rust，无账号空间模型）。

## 目录结构

- `extension/` — Chrome MV3 扩展（单击工具栏图标直达流程工作台 sidepanel、流程导入（流程自带站点域名，内容脚本按流程站点动态注入）、运行前输入表单与同站顺序跨页续跑、dry-run；「同步」页签按空间码共享脚本）
- `backend/` — oncewise-ai-sync 数据同步服务（axum + PostgreSQL；空间由客户端生成的 ID+密钥寻址，无账号体系）
- `demo/` — Playwright 扩展集成测试（`demo/e2e/extension/`，独立 fixture 加载真实构建产物）
- `scripts/` — 测试与 Demo 运行脚本（Python runner）
- `docs/` — PRD 与用户故事（PRD 索引：[docs/prd/00-index.md](docs/prd/00-index.md)）
- `skills/oncewise-message/` — 本机流程交接程序（Node 22+，`host.mjs`/`client.mjs`/`install.mjs`/`uninstall.mjs`，随 Skill 分发；安装位置与排错见 `skills/oncewise-setup/references/native-host-setup.md`）
- `DESIGN.md` — 视觉规范（业务约束以 `docs/` 为准）

## 快速启动

```bash
# 扩展开发（extension/）
cd extension && npm install && npm run dev     # 构建产物手动加载到日常 Chrome
cd extension && npm run build                  # MV3 生产构建 → .output/chrome-mv3

# 同步后端（backend/，外部 PostgreSQL；DATABASE_URL 必填，BIND_ADDR 可覆盖）
docker run -d --name oncewise-demo-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:18-alpine
cd backend && DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres cargo run   # 默认 0.0.0.0:8080

# 扩展 Demo 集成测试（首次准备）
cd demo && npm install && npx playwright install chromium

# 运行扩展 Demo smoke（先构建扩展，再运行）
cd extension && npm run build
uv run scripts/web-demo-test-runner.py demo/e2e/extension/verification/smoke.e2e.ts --run-id <唯一ID>
```

所有测试与 Demo 运行说明统一维护在 [scripts/index.md](scripts/index.md)（含环境前置、日志位置与失败恢复），本文件不重复维护命令。

## 安装 Agent Skills

本仓库按 [Agent Skills 开放格式](https://agentskills.io/specification)提供三个目录，根目录的 [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) 把它们声明为同一插件（`oncewise`）的 skill 路径。每个目录的 `SKILL.md` 是入口，`references/` 和 `examples/` 是该 skill 的随附资料：

| Skill | 用途 |
| --- | --- |
| [`oncewise-setup`](skills/oncewise-setup/SKILL.md) | 首次安装扩展、配置 Chrome DevTools MCP，并检查 AI 是否能访问扩展导入页 |
| [`oncewise-flow`](skills/oncewise-flow/SKILL.md) | 在目标网页验证操作，经本机通道校验并保存自动化流程（保存前取得对话确认），启用由用户本人完成 |
| [`oncewise-message`](skills/oncewise-message/SKILL.md)（随附程序，硬依赖） | 本机流程交接宿主与 AI 侧 CLI：`install.mjs` 用户级安装，`client.mjs` 执行 ping/校验/保存/核验；另两个 skill 的交接步骤都运行它 |

支持 [Skills CLI](https://github.com/vercel-labs/skills) 的工具可让安装器发现并选择 skill。在本仓库根目录：

```bash
npx skills add . --list
npx skills add . --skill oncewise-setup --skill oncewise-flow --skill oncewise-message
```

本仓库开发时，`skills/` 是唯一源文件，`.agents/skills/` 是本机安装副本；安装副本不会自动跟随源文件更新。修改后运行 `python scripts/sync-skills.py`，再用 `python scripts/sync-skills.py --check` 确认一致。需要编辑时持续同步，可在终端运行 `python scripts/sync-skills.py --watch`（Ctrl+C 停止）。同步只从源文件覆盖副本，包含随附资料与程序，并清理对应 skill 内的过时文件；其他已安装 skill 保留。已从源目录移除的整个 skill 不会自动卸载。

`oncewise-message` 是另两个 skill 的硬依赖，三项必须装到同一位置成兄弟目录——`oncewise-flow` 通过 `../oncewise-message/client.mjs` 运行交接。若所用工具只装了两个 skill（清单或 `--list` 未列出 `oncewise-message` 即说明该工具不认清单声明），请把 `skills/oncewise-message/` 复制或链接到同一安装位置。

仓库发布并可被安装者访问后，也可把 `.` 换成仓库 Git URL 或 `owner/repo`。安装器负责选择目标 AI 工具和安装位置；`--list` 只列出可用 skill，不安装。若工具不支持 Skills CLI，可按该工具的说明导入**完整的三个 skill 目录**，不要只复制 `SKILL.md`。新 skill 未显示时，重启或刷新该工具。

按宿主工具支持的方式调用 `oncewise-setup` 完成环境检查，再调用 `oncewise-flow` 描述要自动化的网页操作。安装 skill **不会自动安装** Chrome DevTools MCP 或 OnceWise AI 扩展；需按[初始化指引](skills/oncewise-setup/references/mcp-setup.md)配置 MCP，并确认它能调用 `list_pages`、`take_snapshot`、`fill`、`click` 等浏览器工具。

兼容性以一次实际连通性检查为准：宿主须能读取随附资料、连接运行在用户本机的浏览器 MCP（目标网页探索与验证），并在用户本机运行 `skills/oncewise-message/client.mjs` 完成 Native Messaging 交接（Node 22+，`oncewise-setup` 负责安装与 `ping` 验证）；扩展是唯一的校验与持久化方，保存前须取得用户在对话中的明确确认，流程保存后未启用，启用与回滚仅由用户本人在扩展界面操作。仅支持上传 skill 或仅有内置网页浏览能力，不足以证明完整流程可用。云端执行环境尤其需要确认是否能连接用户本机的 Chrome 与本机通道。

本项目扩展有两种安装形态。**Chrome Web Store 版**（推荐）：商店链接上线后直接安装，运行在商店分配的 ID `dmmhmcdbkbbgbcidafhlhepdchjboenc` 下（商店拒绝带 `key` 字段的上传包，故商店版无法保留下面的固定开发 ID）。**源码开发版**：先在 `extension/` 执行 `npm install`、`npm run build`，再在 Chrome 的 `chrome://extensions` 打开开发者模式，通过「Load unpacked / 加载已解压的扩展程序」选择 `extension/.output/chrome-mv3`。开发版 manifest 固定了 `key`，扩展 ID 恒为 `fkkfdckchahnjkcbimnbhonbgcefnafi`（本机宿主安装时需加 `--extension-id fkkfdckchahnjkcbimnbhonbgcefnafi`；默认 `allowed_origins` 绑定的是商店版 ID）。扩展必须装在 MCP 操作的同一 Chrome 实例内。旧的无 key 开发实例派生不同 ID，其本地流程在新 ID 下不可见——所需流程须经 AI 本机通道重新创建。

## 开源许可证

本项目以 [Apache License 2.0](LICENSE) 开源。
