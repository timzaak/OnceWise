import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Client } from 'pg'
import { SyncServer } from './sync-server'

// Herald 测试环境 harness：容器与实例来自 scripts/test-start.py（调用方先起环境，见
// scripts/index.md 的 Herald 鉴权测试环境），本文件只做用例所需的起服+播种与真实故障手段——
// 与后端 scenario_herald_auth 同款事实：种子账号密码固定 password（复用镜像 admin 哈希），
// 播种不带角色（无权限点账号即有效登录，登录门禁不查角色）。demo 后端监听随机端口，其
// callback 必须并入播种 client 的 redirect_uris 白名单（与后端测试的 8099 条目共存；后端
// 套件重跑会把白名单重置回 8099，本播种每次重新收敛，不累积陈旧的随机端口条目）。

const execFileAsync = promisify(execFile)

export const HERALD_REALM = 'oncewise'
export const HERALD_CLIENT_ID = 'oncewise-sync'
export const HERALD_ACCOUNT_PASSWORD = 'password'
const HERALD_CONTAINER = 'oncewise-test-herald'
const HERALD_REDIS_CONTAINER = 'oncewise-test-redis'
// 后端场景测试播种的固定 callback（scenario_herald_auth 的 CALLBACK_URI），与本用例的随机
// 端口 callback 一并写入白名单。
const BACKEND_TEST_CALLBACK = 'http://127.0.0.1:8099/api/auth/oauth/callback'

export interface HeraldTestEnv {
  baseUrl: string
  databaseUrl: string
}

// 与后端场景测试同一组变量名：一套 TEST_HERALD_* 同时驱动两套资产。
export function heraldTestEnv(): HeraldTestEnv {
  return {
    baseUrl: process.env.TEST_HERALD_URL ?? 'http://127.0.0.1:13001',
    databaseUrl: process.env.TEST_HERALD_DATABASE_URL
      ?? 'postgres://postgres:postgres@127.0.0.1:5432/herald_test',
  }
}

export interface HeraldServer {
  herald: HeraldTestEnv
  server: SyncServer
}

// 每个 us-hs 用例的固定前置：起 herald 模式后端，并把其 callback 并入播种 client 白名单。
export async function startHeraldServer(users: string[]): Promise<HeraldServer> {
  const herald = heraldTestEnv()
  const server = await SyncServer.startWithHerald({
    baseUrl: herald.baseUrl,
    realmId: HERALD_REALM,
    clientId: HERALD_CLIENT_ID,
  })
  await seedHeraldFixture(herald, { callbackUri: server.callbackUri, users })
  return { herald, server }
}

async function withHeraldDb<T>(env: HeraldTestEnv, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: env.databaseUrl })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

// 幂等播种：realm（含 Herald 建域服务会自动创建的两个 first-party client app——登录页提交的
// clientId 固定解析到本域的 admin-web-console，缺它则浏览器登录必被拒，裸 SQL 建域须补齐）、
// BFF client（redirect_uris 每次收敛为「后端 8099 条目 ∪ 本用例 callback」）、无角色测试账号
// （含法定协议同意，否则 Herald 登录会先弹 consent 而非直接发码）。重跑会把账号 status 复位为
// 1，上一次运行停用的账号不泄漏。
export async function seedHeraldFixture(
  env: HeraldTestEnv,
  opts: { callbackUri: string; users: string[] },
): Promise<void> {
  await withHeraldDb(env, async client => {
    const redirectUris = JSON.stringify([BACKEND_TEST_CALLBACK, opts.callbackUri])

    const userSql = opts.users.map(email => `
      INSERT INTO account (id, realm_id, email, password, status)
      VALUES (uuidv7(), '${HERALD_REALM}', '${email}', v_hash, 1)
      ON CONFLICT (realm_id, email) DO UPDATE SET status = 1;
      SELECT id INTO v_user FROM account WHERE realm_id = '${HERALD_REALM}' AND email = '${email}';
      INSERT INTO profile (id, realm_id, nickname) VALUES (v_user, '${HERALD_REALM}', 'Demo User')
      ON CONFLICT (id, realm_id) DO NOTHING;
      INSERT INTO user_agreement_consent (id, user_id, realm_id, agreement_type, consented_version_id)
      SELECT uuidv7(), v_user, '${HERALD_REALM}', v.agreement_type, v.id FROM legal_agreement_version v
      WHERE v.id IN (SELECT DISTINCT ON (lv.agreement_type) lv.id FROM legal_agreement_version lv
        WHERE (lv.realm_id IS NULL OR lv.realm_id = '${HERALD_REALM}')
        ORDER BY lv.agreement_type, (lv.realm_id IS NULL), lv.version_no DESC)
      ON CONFLICT (user_id, agreement_type) DO UPDATE SET
        consented_version_id = EXCLUDED.consented_version_id, consented_at = CURRENT_TIMESTAMP;`)

    await client.query(`
      DO $seed$
      DECLARE v_hash text; v_user uuid;
      BEGIN
        SELECT password INTO v_hash FROM account WHERE realm_id = 'admin' LIMIT 1;
        INSERT INTO realm (id, name) VALUES ('${HERALD_REALM}', 'OnceWise Test') ON CONFLICT (id) DO NOTHING;
        INSERT INTO client_app (id, realm_id, client_id, name, is_first_party, enabled)
        VALUES (uuidv7(), '${HERALD_REALM}', 'admin-web-console', 'Admin Web Console', true, true)
        ON CONFLICT (realm_id, client_id) DO NOTHING;
        INSERT INTO client_app (id, realm_id, client_id, name, is_first_party, enabled)
        VALUES (uuidv7(), '${HERALD_REALM}', 'user-account-center', 'User Account Center', true, true)
        ON CONFLICT (realm_id, client_id) DO NOTHING;
        INSERT INTO client_app (id, realm_id, client_id, name, redirect_uris)
        VALUES (uuidv7(), '${HERALD_REALM}', '${HERALD_CLIENT_ID}', 'OnceWise Sync BFF', '${redirectUris}'::jsonb)
        ON CONFLICT (realm_id, client_id) DO UPDATE SET redirect_uris = EXCLUDED.redirect_uris;
        ${userSql.join('')}
      END $seed$;`)
  })
}

// Herald UserStatus：1=Normal、2=Forbidden（停用对身份校验在下一个请求生效）。
export async function setHeraldAccountStatus(
  env: HeraldTestEnv,
  email: string,
  status: 1 | 2,
): Promise<void> {
  await withHeraldDb(env, client =>
    client.query('UPDATE account SET status = $1 WHERE realm_id = $2 AND email = $3', [
      status,
      HERALD_REALM,
      email,
    ]))
}

// 删除 Herald 的 rl:* 限流键：login/authorize/token 的 60s 窗口会让相邻用例的登录被拒。
// Redis 与 Herald 同为 test-start.py 起的测试容器，直接 docker exec redis-cli 即可（失败按
// 尽力而为处理——限流照常生效只会让用例失败暴露）。
export async function clearHeraldRateLimits(): Promise<void> {
  try {
    const scan = await execFileAsync(
      'docker', ['exec', HERALD_REDIS_CONTAINER, 'redis-cli', '--scan', '--pattern', 'rl:*'],
    )
    const keys = scan.stdout.split(/\r?\n/).filter(key => key !== '')
    if (keys.length > 0) {
      await execFileAsync('docker', ['exec', HERALD_REDIS_CONTAINER, 'redis-cli', 'DEL', ...keys])
    }
  } catch {
    // docker 或容器不可用：按未清理处理
  }
}

// 真实故障手段（与后端 a05 同款）：容器停起由 docker CLI 控制，健康恢复轮询 /health。
export async function stopHeraldContainer(): Promise<void> {
  await execFileAsync('docker', ['stop', HERALD_CONTAINER])
}

export async function startHeraldContainerAndWait(env: HeraldTestEnv): Promise<void> {
  await execFileAsync('docker', ['start', HERALD_CONTAINER])
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${env.baseUrl}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
    } catch {
      // 容器启动早期的拒绝连接按未就绪处理
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('Herald 容器重启后 120s 未恢复健康')
}

// 经 BFF 刷新端点把指定 refresh token 轮换掉（响应即新令牌族，旧 token 从此被 Herald 拒绝）。
export async function rotateAwayRefreshToken(
  bffOrigin: string,
  refreshToken: string,
): Promise<number> {
  const res = await fetch(`${bffOrigin}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    signal: AbortSignal.timeout(10_000),
  })
  // 令牌不落日志：只回状态码
  await res.arrayBuffer()
  return res.status
}
