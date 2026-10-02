import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Client } from 'pg'

// oncewise-ai-sync 后端生命周期 helper：同步故事用例自管真实后端（由本文件而非 runner 负责环境）。
// 每用例一个实例：随机端口 + 独立 PostgreSQL 数据库（SYNC_DATABASE_URL 指向的实例上自动创建，
// cleanup 时 DROP），用例结束 kill 进程并清理库；workers=1 串行下无端口/状态串扰。stop()/start()
// 复用端口与数据库，供服务不可达→恢复场景。
const repoRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const exeSuffix = process.platform === 'win32' ? '.exe' : ''
const readyTimeoutMs = 20_000

// 后端所在 PostgreSQL 实例的管理连接（建库/DROP 用）；本地演示环境默认指向 demo 用的 docker PG。
const SYNC_ADMIN_URL = process.env.SYNC_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres'

// 把管理连接串的库名替换为 database（保留 query 段），得到后端进程用的 DATABASE_URL。
function databaseUrlFor(database: string): string {
  const [base, query] = SYNC_ADMIN_URL.split('?')
  const idx = base!.lastIndexOf('/')
  const rebuilt = `${base!.slice(0, idx)}/${database}`
  return query === undefined ? rebuilt : `${rebuilt}?${query}`
}

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: SYNC_ADMIN_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const execFileAsync = promisify(execFile)

// 二进制解析顺序：ONCEWISE_AI_SYNC_BIN → release → debug → cargo build 兜底。任一环节失败 = 用例
// 失败（不得 skip 成功）；Rust 工具链是同步故事 Demo 的环境前置。
function resolveBinary(): string {
  const envBin = process.env.ONCEWISE_AI_SYNC_BIN
  if (envBin) return path.isAbsolute(envBin) ? envBin : path.resolve(repoRoot, envBin)
  for (const profile of ['release', 'debug'] as const) {
    const candidate = path.join(repoRoot, 'backend', 'target', profile, `oncewise-ai-sync${exeSuffix}`)
    if (existsSync(candidate)) return candidate
  }
  return ''
}

async function buildBinary(): Promise<string> {
  await execFileAsync('cargo', ['build', '--release', '--bin', 'oncewise-ai-sync'], {
    cwd: path.join(repoRoot, 'backend'),
  })
  const built = path.join(repoRoot, 'backend', 'target', 'release', `oncewise-ai-sync${exeSuffix}`)
  if (!existsSync(built)) throw new Error('cargo build 未产出 oncewise-ai-sync 二进制')
  return built
}

// 探测一个空闲端口（host-site 等同目录 harness 也复用）。
export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

export class SyncServer {
  readonly port: number
  readonly origin: string
  private database: string
  private binary: string
  private proc: ChildProcess | null = null
  private output: string[] = []

  private constructor(port: number, database: string, binary: string) {
    this.port = port
    this.origin = `http://127.0.0.1:${port}`
    this.database = database
    this.binary = binary
  }

  static async start(): Promise<SyncServer> {
    let binary = resolveBinary()
    if (binary === '') binary = await buildBinary()
    const database = `oncewise_demo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    await withAdmin(async client => {
      // 幂等建库：并发残留/重跑时 42P04（duplicate database）不视为失败
      await client.query(`CREATE DATABASE "${database}"`).catch(error => {
        if ((error as { code?: string }).code !== '42P04') throw error
      })
    }).catch(error => {
      throw new Error(`无法在 ${SYNC_ADMIN_URL} 上创建测试数据库 ${database}（SYNC_DATABASE_URL 可覆盖）：${error instanceof Error ? error.message : String(error)}`)
    })
    const server = new SyncServer(await freePort(), database, binary)
    await server.start()
    return server
  }

  async start(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) return
    this.proc = spawn(this.binary, [], {
      env: {
        ...process.env,
        BIND_ADDR: `127.0.0.1:${this.port}`,
        DATABASE_URL: databaseUrlFor(this.database),
        // cleanup() 后再 start() 的自愈路径：库被 DROP 时后端自行重建空库
        CREATE_DB_IF_MISSING: '1',
        RUST_LOG: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.proc.stdout?.on('data', (chunk: Buffer) => this.collect(chunk))
    this.proc.stderr?.on('data', (chunk: Buffer) => this.collect(chunk))
    await this.waitHealthy()
  }

  private collect(chunk: Buffer): void {
    this.output.push(chunk.toString())
    if (this.output.length > 200) this.output.splice(0, this.output.length - 200)
  }

  // 就绪判定以 /api/health 返回 200 为准（与扩展连接探针同一端点）。
  private async waitHealthy(): Promise<void> {
    const deadline = Date.now() + readyTimeoutMs
    let lastError = 'unknown'
    let delay = 50
    while (Date.now() < deadline) {
      if (this.proc && this.proc.exitCode !== null) {
        throw new Error(`oncewise-ai-sync 进程提前退出（code=${this.proc.exitCode}）\n${this.outputTail()}`)
      }
      try {
        // 单次探测带超时：后端"已监听但不响应"时 undici 默认 ~300s 挂起会让 readyTimeoutMs 失效
        const res = await fetch(`${this.origin}/api/health`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) return
        lastError = `HTTP ${res.status}`
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      // 二进制 bind 通常在首两次重试内完成，短起步指数退避（上限 250ms）避免整周期空等
      await new Promise(resolve => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, 250)
    }
    throw new Error(`oncewise-ai-sync ${this.origin}/api/health 就绪超时（${readyTimeoutMs}ms，last=${lastError}）\n${this.outputTail()}`)
  }

  async stop(): Promise<void> {
    const proc = this.proc
    // Windows 下被 kill 的进程 exitCode 可能长期不更新（exit 事件不触发），不能以它判定
    // 存活；stop 后置空句柄，start() 据此无条件重启
    this.proc = null
    if (!proc || proc.exitCode !== null) return
    await new Promise<void>(resolve => {
      let settled = false
      const done = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      proc.once('exit', done)
      proc.kill()
      setTimeout(() => {
        if (proc.exitCode === null) {
          // 兜底补杀后等 exit 确认（有界）再放行：TerminateProcess 异步完成，立即返回可能让
          // stop→start 同端口重启撞上未死透的旧进程；exit 事件不触发时由超时兜底放行
          proc.kill('SIGKILL')
          setTimeout(done, 2000).unref()
          proc.once('exit', done)
        } else {
          done()
        }
      }, 5000).unref()
    })
  }

  async cleanup(): Promise<void> {
    await this.stop()
    // WITH (FORCE)：断开残留连接后删库；失败不阻塞用例收尾（本地残留可用 DROP DATABASE 手动清）
    const database = this.database
    await withAdmin(async client => {
      await client.query(`DROP DATABASE "${database}" WITH (FORCE)`)
    }).catch(() => undefined)
  }

  outputTail(): string {
    return this.output.join('').slice(-4000)
  }

  // Node 直连 API：造前置数据（如校验失败版本）与断言服务端状态。写接口逐请求携带
  // X-Space-Key（与扩展同一鉴权方式；无账号模型下持密钥即对等读写）。
  async request(
    method: string,
    requestPath: string,
    options: { key?: string; body?: unknown } = {},
  ): Promise<Response> {
    return await fetch(`${this.origin}${requestPath}`, {
      method,
      headers: {
        ...(options.key !== undefined ? { 'X-Space-Key': options.key } : {}),
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })
  }

  async createSpace(id: string, key: string, name: string): Promise<Response> {
    return await this.request('POST', '/api/spaces', { body: { id, key, name } })
  }

  async createScript(
    key: string,
    spaceId: string,
    body: { id: string; name: string; note?: string; versionNote?: string; flowContent: unknown },
  ): Promise<Response> {
    return await this.request('POST', `/api/spaces/${spaceId}/scripts`, { key, body })
  }

  async createScriptVersion(
    key: string,
    spaceId: string,
    scriptId: string,
    body: { versionNote?: string; flowContent: unknown },
  ): Promise<Response> {
    return await this.request('POST', `/api/spaces/${spaceId}/scripts/${scriptId}/versions`, { key, body })
  }
}
