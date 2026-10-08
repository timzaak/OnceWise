# oncewise-ai-sync — 脚本同步与空间协作后端

自建轻量同步服务（data-sync）：空间、脚本与版本的**存储与分发**——空间由客户端生成的 ID+密钥寻址（`X-Space-Key` 请求头），空间模型无账号（DEC-data-sync-007），部署可加服务级登录门禁。只存储分发结构化脚本数据，不生成、不执行流程，不做流程结构校验（格式校验由本机扩展把关，DEC-data-sync-004）。

- API 契约：代码内 utoipa 注解为唯一事实源（运行时 `GET /api/openapi.json` 输出完整 OpenAPI 文档）
- 技术栈：Rust + Tokio + Axum + PostgreSQL（sqlx，运行时查询 API）单 crate 单二进制

## 构建与运行

```bash
cd backend
cargo run --release          # 开发：cargo run
cargo test                   # 场景测试（tests/scenario_data_sync.rs + tests/scenario_herald_auth.rs；
                              # 后者需先在仓库根 `uv run scripts/test-start.py` 起真实 docker Herald）
```

启动即自动执行迁移（`migrations/`）。
测试需要一台 PostgreSQL：`TEST_DATABASE_URL`（缺省回落 `DATABASE_URL`）指向该实例的任一库，
每个用例会在其下自建一次性 `oncewise_ai_test_*` 库并在进程启动时清理旧残留。本地可用
`docker run -d --name pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:18-alpine`
起一个，再 `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres cargo test`。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DATABASE_URL` | （必填） | PostgreSQL 连接串（`postgres://user:pass@host:5432/dbname`） |
| `BIND_ADDR` | `0.0.0.0:8080` | HTTP 监听地址 |
| `AUTH_MODE` | `herald` | `herald`（默认，登录门禁）/ `none`（显式保留原无鉴权行为）；其他值启动失败 |
| `HERALD_BASE_URL` | （herald 必填） | Herald 实例 HTTPS origin（HTTP 仅限 loopback），无 userinfo/path/query/fragment |
| `HERALD_REALM_ID` | （herald 必填） | 部署级 realm（1–256 字符，无路径分隔符）；登录校验必须匹配该 realm |
| `HERALD_CLIENT_ID` | （herald 必填） | 在 Herald 控制台注册的 client app id |
| `HERALD_REDIRECT_URI` | （herald 必填） | 固定为本服务规范 origin 下的 `/api/auth/oauth/callback`（HTTPS；loopback 调试可 HTTP） |
| `RUST_LOG` | `info` | tracing 日志级别（如 `debug`） |
| `CREATE_DB_IF_MISSING` | （未设置） | 设为 `1` 时，目标库不存在则先在同实例上创建（仅限开发/演示自举，生产勿用） |

## Herald 登录门禁（AUTH_MODE=herald，默认）

业务接口（空间/脚本/版本）前置用户身份校验：每个请求持 `Authorization: Bearer <accessToken>`
访问服务端，服务端向 Herald `GET /api/auth/status` 逐请求确认登录有效且 realm 匹配，再走原有空间密钥校验。
**有效登录即可访问，不检查权限点、角色或权限列表**（无需配置任何 API key 或权限点）；空间内对等读写仍由空间密钥承担。
`/api/health`、`/api/openapi.json` 与 `/api/auth/*` 保持公开。Herald 不可用时业务请求 fail-closed（503 `AUTH_UNAVAILABLE`），
不降级放行；账号停用在下一次业务请求生效（无缓存窗口）。

公开鉴权端点（详见 OpenAPI 文档）：

- `GET /api/auth/config` — 模式探测（none 模式下其余鉴权端点 404）
- `GET /api/auth/oauth/start` / `GET /api/auth/oauth/callback` — OAuth Code+PKCE 代理（授权窗口用）
- `POST /api/auth/redeem` — 扩展凭一次性交接码 + 领取证明领取令牌（令牌只走 POST 响应体，不进 URL）
- `POST /api/auth/refresh` — 刷新令牌轮换代理

### 部署准备（Herald 控制台）

1. 在 Herald 控制台的目标 realm 下创建 client app，取得 `HERALD_CLIENT_ID`。
2. 在该 client 的回调白名单中注册本服务的规范回调地址，即 `HERALD_REDIRECT_URI`
   （如 `https://sync.example.com/api/auth/oauth/callback`；必须与扩展所连服务的 origin 完全一致）。
3. 无需 API key、权限点或角色配置。
4. 服务端四个 `HERALD_*` 环境变量按上表配置。

### 运行要求

- **单实例或会话亲和**：OAuth 登录握手状态保存在进程内存（交易 5 分钟、交接码 60 秒，各有上限 128 项）。
  多实例部署必须保证 `oauth/start`、`oauth/callback`、`redeem` 命中同一实例（反向代理按 cookie 亲和）；
  进程重启只会中断尚未完成的登录（重登即可），已领取的令牌由 Herald 校验，不受影响。
- **HTTPS**：生产回调必须 HTTPS（`__Host-` cookie 需要 Secure 属性）；loopback HTTP 仅用于本机调试与测试。
- **反向代理日志脱敏**：访问日志只记不带 query 的路径；不要输出 `Authorization`/`Cookie`/`Set-Cookie` 头、
  OAuth 回调 query（state/code）或 upstream 调试 body。服务端自身的请求日志只记 method + path。

### 升级迁移（两条出路，无第三种隐式状态）

- 既有部署升级后未显式选择模式且缺 Herald 配置 → **启动失败**，报错列出缺失变量并给出两条出路；
- 出路一：补齐四个 `HERALD_*` 配置启用登录门禁（推荐对外部署）；
- 出路二：显式设置 `AUTH_MODE=none`，行为与升级前一致——唯一差异是新增的公开模式探测端点 `GET /api/auth/config`（内网/本地开发的逃生通道）。

## 数据库

- PostgreSQL，连接池 `max_connections=8`
- schema 变更一律追加递增迁移文件，不修改已发布迁移
- 版本号分配在 scripts 行锁（`SELECT … FOR UPDATE`）内做 MAX+1，UNIQUE 约束兜底

## 部署（Docker）

- 交付物 = 容器镜像（`docker/Dockerfile`，CI 推送到 ghcr）；数据库由外部提供（共享实例或独立容器均可）
- **生产要求反向代理终止 TLS**（明文 HTTP 会暴露密钥与脚本内容）：

```text
# Caddy 示例（自动签发证书）
sync.example.com {
    reverse_proxy oncewise-ai-sync:8080
}
```

- 局域网明文 `http://` 仅限调试（扩展配置界面会显示明文传输警示）

## 备份与恢复

```bash
pg_dump -h <host> -U <user> oncewise_ai_sync > backup.sql   # 在线备份
# 恢复：psql 导入到空库
```

不做自动备份机制（小范围定位，避免过度设计）。

## 接口

- 健康探针：`GET /api/health`
- OpenAPI 文档：`GET /api/openapi.json`（全部接口的 utoipa 注解已注册，可据此核对契约）
- 接口清单、字段、错误体与兼容策略以代码内 utoipa 注解（`src/routes/*.rs`）为唯一事实源

## 当前状态

- 全部 9 个业务接口已实现：空间（注册 / 读取[凭码加入验证] / 删除[级联]）、脚本与版本（创建 / 清单 / 改名改备注 / 追加版本 / 版本清单 / 取指定版本内容），另有 `health` 与 `openapi.json` 两个运维端点
- 鉴权（双层正交）：① 服务级 Herald 登录门禁（`AUTH_MODE=herald` 默认；Bearer + 每请求 status 校验，无权限点/角色/缓存；401 `AUTH_REQUIRED` 与 503 `AUTH_UNAVAILABLE` 独立成类）② 空间密钥（`X-Space-Key` 请求头；服务端只存 SHA-256 哈希并常数时间比对，错误密钥 401、未知空间 404；空间模型无账号 / 令牌 / 成员概念，DEC-data-sync-007）
- 服务端不持久化用户身份：不记录“哪个用户访问了哪个空间”，无审计；登录握手状态仅在内存中短时存在
- 场景测试见 `tests/scenario_data_sync.rs`（s01–s10 对应 US-DS-001～006）与 `tests/scenario_herald_auth.rs`（a01–a09，对接真实 docker Herald——先 `uv run scripts/test-start.py` 起环境，无 mock）
