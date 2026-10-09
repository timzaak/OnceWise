# 本地验证索引

本文件记录 AI 在本地开发机进行验证的脚本：环境启动（人工 Demo、Herald 鉴权测试）与前端 e2e 测试入口（新增或修改入口时同步更新本索引）；其余命令不在本索引维护。

## 人工 Demo 环境

固定端口 + 持久状态，供连续操作验证（与随机端口、一次性 profile 的测试 harness 不同）：

| 用途 | 命令 |
| --- | --- |
| 启动（构建扩展 + Herald 登录依赖 + oncewise-ai-sync 后端 + 宿主测试页 + 加载扩展的浏览器） | `uv run scripts/demo-start.py` |
| 停止（浏览器、后端、宿主页、demo Herald 容器、demo PostgreSQL 容器） | `uv run scripts/demo-stop.py` |

- 可选跳过项：`--no-build`（复用现有 `extension/.output/chrome-mv3`）、`--no-sync`（不起后端，无需 Rust）、`--no-herald`（后端显式 `AUTH_MODE=none` 原无鉴权形态，不起 Herald 容器）、`--no-browser`、`--no-remote-debugging`；端口可用 `--backend-port` / `--host-port` / `--debug-port` 覆盖。
- Herald 登录依赖（默认启用）：demo 专用容器 `oncewise-demo-herald` / `oncewise-demo-redis`（端口 13101 / 16481，库 `herald_demo` 挂 demo PostgreSQL，与测试环境的 13001 / `herald_test` 完全独立、可并行）；后端以 herald 模式运行并把自身 callback 并入播种 client 白名单。登录账号 `demo@oncewise.local` / `password`（无角色，播种幂等）。已健康实例直接复用；`HERALD_IMAGE` 可覆盖镜像。操作者显式设置 `AUTH_MODE` / `HERALD_*` 时完全透传、不起镜像。
- 端口：sync 后端 `127.0.0.1:8080`（就绪判定 `/api/health` 200）、宿主测试页 `127.0.0.1:8899`、CDP 远程调试 `127.0.0.1:9222`（仅环回，随 demo-stop 关闭；被占用时启动直接报错）。
- 持久状态：PostgreSQL 库 `oncewise_demo_manual`（本机 5432 无监听时自动起 `oncewise-demo-pg` 容器；demo-stop 停该容器但数据保留，下次 demo-start 自动拉起；`DEMO_DATABASE_URL` 可指向自己的实例）；浏览器专用 profile `log/demo-profile`；会话 PID 与日志在 `log/`（已 gitignore）。
- 浏览器优先 Playwright 自带 Chromium（brand Chrome 137+ 禁用 `--load-extension`），回退系统 Chrome 并提示手动加载 `extension/.output/chrome-mv3`；Chrome 136+ 对默认 profile 的远程调试限制不适用于本专用 profile。
- 前置：uv、Docker、Node + npm；Rust 工具链仅在起 sync 后端时需要（`--no-sync` 可免）。
- Chrome DevTools MCP 接入与调试端口细节见 `skills/oncewise-setup/references/mcp-setup.md`；日常 Chrome 接入走 `skills/oncewise-setup` 的 autoConnect 路径（用户确认门）。

## Herald 鉴权测试环境

真实 docker Herald + Redis，供后端 `scenario_herald_auth`（a01–a09）与扩展 us-hs 故事的验证前置：

| 用途 | 命令 |
| --- | --- |
| 启动（Herald + Redis 测试容器，复用 demo PostgreSQL 并确保 `herald_test` 库） | `uv run scripts/test-start.py` |
| 停止（移除 Herald/Redis 测试容器，不动共享 PostgreSQL 与 `herald_test` 库） | `uv run scripts/test-stop.py` |

- 地址：Herald `http://127.0.0.1:13001`（就绪判定 `/health`）、Herald 库 `herald_test`（共享 demo PostgreSQL 5432 上）、Redis `127.0.0.1:16381`；`TEST_HERALD_URL` / `TEST_HERALD_DATABASE_URL` / `TEST_HERALD_REDIS` 可覆盖。
- 镜像默认 `ghcr.io/timzaak/herald:0.6.1`，`HERALD_IMAGE` 可覆盖；生成的 config.toml 含 `static_dir`，在 API origin 服务真实登录页。
- 前置：uv、Docker；共享 PostgreSQL 由脚本自动确保（本机 5432 无监听时起 `oncewise-demo-pg`）。

## 前端测试（扩展 Demo e2e）

| 用途 | 命令 |
| --- | --- |
| 扩展 Demo 整文件测试 | `uv run scripts/web-demo-test-runner.py demo/e2e/extension/<file>.e2e.ts --run-id <唯一ID>` |
| 失败用例重测 | 上述命令追加 `--grep "<完整测试标题>"`，使用新的 run ID；通过后重跑整文件 |

- ⚠️ 每次执行前先扩展构建 `cd extension && npm run build`，成功后才启动 runner（`.output/chrome-mv3-dev` 热更新产物不得作为验证输入）。
- 环境由 fixture/用例自管（扩展加载、临时 profile、同步服务端、宿主静态页均自起自清），runner 不提供任何环境管理；us-hs 故事先起 Herald 鉴权测试环境（见上）。
- 日志：runner 末行 `Result`（`logs` 相对 `demo/`），常见位置 `demo/test-results/runs/<run-id>/` 与统一日志 `demo/test-results/unified-logs/`。
