import https from 'node:https'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from './fixtures'
import { freePort } from './sync-server'

// 本地 https 接收端夹具（support-http / PRD §2.3「验收用受控 https 接收端」）：Node https 服务，
// 127.0.0.1 + 随机空闲端口 + 仓库内静态自签证书（upload-receiver-cert/key.pem；Chromium 由
// fixtures.ts 的 --ignore-certificate-errors 接受）。场景路径承载上传故事的全部服务端行为：
// /collect 200 + 短回执 token（capture → assert equals 的断言对象）、/created 201（2xx 区间）、
// /error 500（非 2xx 保守中止）、/slow 延迟 8s 响应（等待超时）、/huge 超过 64 KiB 捕获上限的
// 响应体（响应超限）。每个到达的请求（方法/完整 URL/头/体）都被记录，供用例断言「接收端收到
// 的请求与流程声明一致」与「零外发/无重试」的计数断言。

export interface UploadedRequest {
  method: string
  url: string
  path: string
  headers: Record<string, string>
  body: string
}

export interface UploadReceiver {
  origin: string
  collectUrl: string
  createdUrl: string
  errorUrl: string
  slowUrl: string
  hugeUrl: string
  /** 已记录请求的快照：按 path 过滤、按到达顺序返回 */
  requests: (path: string) => UploadedRequest[]
  close: () => Promise<void>
}

// /collect 的固定回执 token：capture 槽位随后用 assert equals 逐字核对
export const UPLOAD_RECEIPT_TOKEN = 'RECEIPT-7F3K9Q2M'

// MAX_UPLOAD_CAPTURE_BYTES(65_536) 之上的响应体（响应超限场景）
const HUGE_BODY_BYTES = 65_536 + 1_024

const SLOW_DELAY_MS = 8_000

export async function startUploadReceiver(): Promise<UploadReceiver> {
  const port = await freePort()
  const fixtureDir = fileURLToPath(new URL('.', import.meta.url))
  const [key, cert] = await Promise.all([
    readFile(path.join(fixtureDir, 'upload-receiver-key.pem')),
    readFile(path.join(fixtureDir, 'upload-receiver-cert.pem')),
  ])
  const records: UploadedRequest[] = []
  const origin = `https://127.0.0.1:${port}`
  const server = https.createServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      records.push({
        method: req.method ?? '',
        url: `${origin}${req.url ?? ''}`,
        path: (req.url ?? '').split('?')[0],
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([name, value]) => [
            name,
            Array.isArray(value) ? value.join(', ') : String(value ?? ''),
          ]),
        ),
        body: Buffer.concat(chunks).toString('utf8'),
      })
      switch ((req.url ?? '').split('?')[0]) {
        case '/collect':
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(UPLOAD_RECEIPT_TOKEN)
          return
        case '/created':
          res.writeHead(201, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
          return
        case '/error':
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('controlled failure')
          return
        case '/slow':
          // 响应延迟远超故事流程的 timeoutMs（等待超时场景）；请求已在上方记录
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end(UPLOAD_RECEIPT_TOKEN)
          }, SLOW_DELAY_MS)
          return
        case '/huge':
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('x'.repeat(HUGE_BODY_BYTES))
          return
        default:
          res.writeHead(404).end('not found')
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    origin,
    collectUrl: `${origin}/collect`,
    createdUrl: `${origin}/created`,
    errorUrl: `${origin}/error`,
    slowUrl: `${origin}/slow`,
    hugeUrl: `${origin}/huge`,
    requests: (filterPath: string) => records.filter(r => r.path === filterPath),
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

// 等待 path 的首个请求到达并返回（上报从 SW fetch 到达接收端存在毫秒级窗口）。
export async function waitUploadRequest(
  receiver: UploadReceiver, path: string, timeout = 20_000,
): Promise<UploadedRequest> {
  await expect.poll(
    () => receiver.requests(path).length,
    { message: `接收端 ${path} 在 ${timeout}ms 内未收到请求`, timeout },
  ).toBeGreaterThan(0)
  return receiver.requests(path)[0]
}

// 断言 path 的到达数恰为 expected（零外发 / 无重试的计数断言；expected=0 时立即判定）。
export async function expectUploadCount(
  receiver: UploadReceiver, path: string, expected: number,
): Promise<void> {
  const actual = receiver.requests(path)
  expect(
    actual.length,
    `接收端 ${path} 应恰有 ${expected} 条记录，实际 ${actual.length}：${JSON.stringify(actual.map(r => ({ method: r.method, body: r.body })))}`,
  ).toBe(expected)
}
