# 测试运行索引

本文件是本项目测试运行说明的唯一维护位置（新增或修改测试入口时同步更新本索引）。

## 如何运行

默认从项目根目录执行，优先运行与改动相关的最小可靠范围；仅在范围无法收敛或门禁要求时运行全量，并记录原因。

| 用途 | 命令 |
| --- | --- |
| 项目 skills 单向同步 | `python scripts/sync-skills.py`（`skills/` → `.agents/skills/`） |
| 项目 skills 差异检查（只读） | `python scripts/sync-skills.py --check`（一致退出 0，存在差异退出 1，错误退出 2） |
| 项目 skills 持续同步 | `python scripts/sync-skills.py --watch`（每秒检查，Ctrl+C 停止；需要目标目录写权限） |
| skills 同步脚本测试 | `python -m unittest discover -s scripts/tests -p test_sync_skills.py -v`（临时目录，不修改真实安装） |
| 扩展单元测试（Vitest，定向） | `cd extension && npm run test:run -- <文件或匹配模式>` |
| 扩展类型检查 | `cd extension && npm run compile` |
| 扩展构建（扩展 Demo 的必要前置） | `cd extension && npm run build` |
| Demo 类型检查 | `cd demo && npm run type-check` |
| Demo 用例发现（只列出，不执行） | `cd demo && npx playwright test --list` |
| 扩展 Demo 整文件测试 | `uv run scripts/web-demo-test-runner.py demo/e2e/extension/<file>.e2e.ts --run-id <唯一ID>` |
| 扩展 Demo 失败用例重测 | 上述命令追加 `--grep "<完整测试标题>"`，使用新的 run ID；通过后重跑整文件 |

⚠️ 每次执行扩展 Demo 前先运行扩展构建，成功后才启动 runner（`.output/chrome-mv3-dev` 热更新产物不得作为验证输入；`npm run compile` / `npm run type-check` 是静态检查，不替代测试）。环境由 fixture/用例自管（扩展加载、临时 profile、同步服务端、宿主静态页均自起自清），runner 不提供任何环境管理。

## 前置工具

- 基础：uv（Python runner）、Node + npm + npx、Playwright 自带 Chromium；Demo 首次准备 `cd demo && npm install` 再 `npx playwright install chromium`。
- 本机通道用例（us-nm-*）：需要 Node 22+（解析链见 `demo/e2e/extension/native-host.ts` 头注），并在目标浏览器用户级安装宿主 `node skills/oncewise-message/install.mjs`（Chromium 类加 `--browser chromium`；套件加载的是固定 key 开发构建，人工预装须再加 `--extension-id fkkfdckchahnjkcbimnbhonbgcefnafi`——`native-host.ts` 的自动安装已自带该参数）。安装位置、固定扩展 ID、排错与卸载统一见 `skills/oncewise-setup/references/native-host-setup.md`。
- 同步故事（`stories/` 下 us-ds / us-fs 同步类）：Rust 工具链 + PostgreSQL（默认 `postgres://postgres:postgres@127.0.0.1:5432/postgres`，`SYNC_DATABASE_URL` 可覆盖；本地可 `docker run -d --name oncewise-demo-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:18-alpine`）。

## Demo 套件

- **本机通道（us-nm-001～005，基础设施 `demo/e2e/extension/native-host.ts`）**：四个文件 us-nm-001-install-connectivity / us-nm-002-native-delivery / us-nm-003-native-revision / us-nm-005-history-rollback，入口同命令表。US-NM-004（交接结果真实可见）的两场景由 us-nm-002 文件内承载（无同名文件，非覆盖缺口）。`nativeTest` 每用例完成宿主注册 → 浏览器冷启动 → 用例 → 卸载回收（真实用户级注册，Windows 为 HKCU；中断残留由下次安装自愈，或手动 `node skills/oncewise-message/uninstall.mjs --browser chromium`）；`bareTest` 强制未注册承载未就绪场景。三平台真实 Chrome 与用户当前浏览器现场证据不在这些用例范围（见 `native-host-setup.md`）。
- **同步故事（stories/ 其余）**：oncewise-ai-sync 后端由 `sync-server.ts` 每用例自管（二进制解析 `ONCEWISE_AI_SYNC_BIN` → `backend/target/release|debug` → cargo 兜底；随机端口 + 自动建删独立库），宿主静态页由 `host-site.ts` 随机端口提供；任一环节失败即用例失败，不 skip。us-fs-001-004 为单文件承载 US-FS-001～004 四条故事的形态（T1–T4 逐故事映射，见文件头注）。
- **装箱流程（us-ssba-010）**：不起后端；宿主页由 host-site 提供，受控失败信号经 `packing-page.html?scenario=` 注入。
- **跨页流程（us-cpf-001，extension-demo 交付 `stories/us-cpf-001-cross-page-flow.e2e.ts`）**：不起后端；宿主三页向导由 host-site 提供（`wizardStepUrl(step, opts)`，静态源为 `extension/test-pages/wizard-step{1,2,3}.html`）。受控信号：`?open=new-tab`（第 2 步确认以 `target=_blank` 打开第 3 步）、`?scenario=slow`（第 3 步就绪信号延迟约 3 秒——慢加载认领与越过 navigate 截止时间；向导表单 GET 提交不带查询参数，该信号由宿主服务 `startHostSite({ slowStep3: true })` 以 302 投递到表单发起的导航上）、`?biz=`（区分业务实例；第 2 步换单据号即 business-changed 取消路径）。跨页受控页参数详见 `extension/test-pages/README.md`。
- **流程优化 UI 契约（verification/flow-optimization.e2e.ts，非故事验收）**：「用 AI 优化」的扩展侧半段——对启用中流程发起优化先暂停并发放 15 分钟单流程读取授权（session:nativeReadGrant 形状断言）；修订替换的本机通道往返（flow.read→对话确认→flow.save）由 us-nm-003 承载（e2e 的 CI Chrome 无宿主，不可驱动该段）。
- **店铺资产采集（listing/capture-listing.e2e.ts）**：非验收用例——加载生产构建产物、播种演示流程，把 Chrome Web Store 截图（1280×800）与宣传图（440×280 / 1400×560）直接写入 `docs/store-listing/screenshots/`；无需后端（宿主页由 host-site 自起；除截图就绪门外仅含一条执行效果守卫断言——联系电话填值回显，非业务验收），不入 CI；产物清单与拍摄纪律见 `docs/store-listing/`。
- 所有扩展用例直接加载生产构建产物 `extension/.output/chrome-mv3`（定位见 `extension-target.ts`）；host 权限随 manifest 安装获得，无需权限手势；扩展 ID 由 fixtures 从 background service worker URL 自动解析。其余用例无外部服务，不得为扩展用例启动默认 Docker Web 环境。
- 日志：runner 末行 `Result`（`logs` 相对 `demo/`），常见位置 `demo/test-results/runs/<run-id>/` 与统一日志 `demo/test-results/unified-logs/`。失败时保留命令、失败用例和日志，修复后定向重跑；未执行或受阻的测试明确记录原因，不得换脚本绕过。

## CI

`.github/workflows/ci.yml` 的 `native-demo-ci` 在 ubuntu / macos / windows runner 上串行跑全部 us-nm 文件（push 按 paths filter 触发，或 workflow_dispatch 手动全量），失败工件 `native-demo-results-<os>`；机制说明（NATIVE_DEMO_NODE 钉定、profile 内 NativeMessagingHosts 预置）见 ci.yml 与 native-host.ts 注释。同步类故事不进 CI（需 Rust + PG）。

## 版本发布

- 产品版本载体：`extension/package.json`（含 `package-lock.json` 根版本）与 `.claude-plugin/marketplace.json` 的 oncewise 条目；`backend/`、`demo/` 各自维护版本，不随发布变动。发布走 `/t-tool t-release`（等价 `python scripts/release.py [版本号]`）：要求 main + 干净工作区，`npm run compile` 与 `npm run test:run` 通过后创建 `chore: bump version to <版本号>` commit 与 `v<版本号>` 标签并推送。每个 `v*.*.*` 标签都会触发 `.github/workflows/cd.yml` 的 GitHub Release；后端镜像仅当 `backend/` 或 `docker/Dockerfile` 相对上一版本有改动时才重新构建，否则跳过构建、将上一版镜像别名到新 tag（详见 `scripts/release.py` 头注）。无参数运行给出的推荐版本基于最新 tag 推算（以 `git tag` 为准，不在此维护具体版本号），产品线发布请显式传版本号。

## 缺口（未配置，不虚构命令）

后端（`backend/`）测试入口尚未在本索引配置；需要时按其 nextest 约定补齐 `backend-test.py` 与对应说明。同域真实入口：`cd backend && TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres cargo test`（s01–s10 场景测试，每用例自建一次性 `oncewise_ai_test_*` 库）。

扩展故事 demo 覆盖缺口（显式记录，非遗漏）：US-SSBA-003（字段变化联动，全部 demo 流程均为 pageEnter 触发）、US-SSBA-005 场景 4（用户暂停/恢复不自动续跑）无用例；US-CPF-001 场景 4 声明手动刷新/关闭标签页/重启浏览器三种中断形态，us-cpf-001 T4 仅覆盖关闭标签页（三形态走同一保守取消路径）；US-SSBA-010 场景 2（非目标页面不执行）与场景 1 的 L2 文档级去重由单测承载（`extension/tests/page-enter.test.ts` 负样本），demo 不重复承载；US-NM-002 场景 2（对话未确认或要求修改时不保存）属 AI 对话侧纪律，由 skills/oncewise-flow 的保存前确认门承载（us-nm-002 用例中确认由用例代行，无负路径用例）；US-SSBA-007 属 AI 工具侧产出（Playwright 无法承载，由 skills/ 交付与人工路径覆盖）；US-SSBA-002/009/011 由 smoke/packing/us-nm-002/us-ds-004 用例部分触及。

## 人工 Demo 环境

与测试 harness（随机端口、一次性 profile）不同，人工 Demo 使用固定端口与持久状态，方便连续操作：

| 用途 | 命令 |
| --- | --- |
| 启动（构建扩展 + sync 后端 + 宿主测试页 + 带扩展的浏览器） | `uv run scripts/demo-start.py` |
| 可选跳过项 | `--no-build`、`--no-sync`（不起后端，无需 Rust）、`--no-browser`、`--no-remote-debugging` |
| 停止 | `uv run scripts/demo-stop.py` |

- 端口：sync 后端 `127.0.0.1:8080`（就绪判定 `/api/health` 200）、宿主测试页 `127.0.0.1:8899`、CDP 远程调试 `127.0.0.1:9222`（仅环回，随 demo-stop 关闭；被占用时启动直接报错）。
- 持久状态：PostgreSQL 库 `oncewise_demo_manual`（本机 5432 无监听时自动起 `oncewise-demo-pg` 容器；demo-stop 会停该容器，数据保留、下次 demo-start 自动 `docker start` 拉起——同步故事测试共用它，并发跑测试时慎停；`DEMO_DATABASE_URL` 可指向自己的实例）；浏览器专用 profile `log/demo-profile`；会话 PID 与日志在 `log/`（已 gitignore）。
- 浏览器优先 Playwright 自带 Chromium（brand Chrome 137+ 禁用 `--load-extension`），回退系统 Chrome 并提示手动加载 `extension/.output/chrome-mv3`；Chrome 136+ 对默认 profile 的远程调试限制不适用于本专用 profile。
- Chrome DevTools MCP 接入与调试端口细节见 `skills/oncewise-setup/references/mcp-setup.md`；日常 Chrome 接入走 `skills/oncewise-setup` 的 autoConnect 路径（用户确认门）。

## 批量与验收

单文件执行用 `/t-tools:t-extension-demo-run`，故事验收用 `/t-tools:t-extension-demo-accept`。初始化 smoke（`demo/e2e/extension/verification/smoke.e2e.ts`）只证明基础设施与入口加载，不替代故事验收。
