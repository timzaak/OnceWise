# oncewise-ai-sync — 脚本同步与 Workspace 协作后端

自建轻量同步服务（data-sync）：账号、workspace、成员、邀请、脚本与版本的**存储与分发**。只存储分发结构化脚本数据，不生成、不执行流程，不做流程结构校验（格式校验由本机扩展把关，DEC-data-sync-004）。

- 设计文档（API 契约唯一设计源）：`.ai/design/data-sync/backend.md`
- 技术栈：Rust + Tokio + Axum + PostgreSQL（sqlx，运行时查询 API）单 crate 单二进制

## 构建与运行

```bash
cd backend
cargo run --release          # 开发：cargo run
cargo test                   # 场景测试（tests/scenario_data_sync.rs）
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
| `RUST_LOG` | `info` | tracing 日志级别（如 `debug`） |
| `CREATE_DB_IF_MISSING` | （未设置） | 设为 `1` 时，目标库不存在则先在同实例上创建（仅限开发/演示自举，生产勿用） |

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
- OpenAPI 文档：`GET /api/openapi.json`（22 个接口的 utoipa 注解已全量注册，可据此核对契约）
- 接口清单、字段、错误体与兼容策略以 `.ai/design/data-sync/backend.md` §4 为唯一设计源

## 当前状态

- 全部 22 个业务接口已实现：账号（注册/登录/退出/getMe）、workspace（创建/清单/删除）、成员（清单/移除/退出）、邀请（生成/清单/作废/凭码加入）、脚本与版本（创建/清单/改名改备注/追加版本/版本清单/取内容）
- 鉴权：bearer token（argon2id 密码 + SHA-256 token 哈希，30 天有效期）；workspace 域按请求实时鉴权（被移除成员下一请求即 403）
- 场景测试见 `tests/scenario_data_sync.rs`（`cargo test`）
