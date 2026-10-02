import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  launchExtensionContext, readExtensionManifest, resolveExtensionId, test as extensionBase,
  useExtensionContext,
} from './fixtures'
import { extensionPath } from './extension-target'

// 本机流程交接通道（support-native-messaging）的 Demo 基础设施：以真实 install.mjs/uninstall.mjs
// 在用户级注册/回收宿主（chromium 形态，HKCU/用户目录，结束撤销），经真实 client.mjs CLI 驱动
// ping/flow.read/flow.validate/flow.save/flow.verify。宿主与客户端都要求 Node 22+（assertNode22），
// 本机默认 Node 可能不满足——resolveNode22 先用当前进程，再找 NATIVE_DEMO_NODE 或 fnm 并存的
// v22+ 安装；找不到直接失败，不得为绕过版本门禁改用低版本 Node。
//
// 单用户单 IPC 端点（Windows 命名管道 / Unix socket，见 skills/oncewise-message/protocol.mjs 的
// ipcEndpoint）：并行浏览器会争用同一端点。playwright.config 固定 workers 1 + fullyParallel
// false，串行下同一时刻只有一个宿主存活；nativeTest 在每个用例内完成 install → 浏览器冷启动
// （扩展 connectNative 时注册已存在）→ 用例 → 卸载，回收粒度与 scripts/index.md 的说明一致。

const SKILL_DIR = path.resolve(fileURLToPath(new URL('../../../skills/oncewise-message/', import.meta.url)))
const HOST_EXT_ID = 'fkkfdckchahnjkcbimnbhonbgcefnafi'

interface InstallSummary {
  installed: boolean
  installDir: string
  manifestPath: string
  extensionId: string
}

export interface ClientResult {
  // client.mjs 单条 stdout JSON：协议应答（ok:true data | ok:false error）或传输失败
  // （ok:false error + transport:true）。exitCode 0 = 送达的明确结果（含拒绝），1 = 传输失败。
  result: Record<string, any>
  stderr: string
  exitCode: number
}

// 解析一个满足 Node 22 门禁的可执行文件。demo 测试进程自身常常是低版本 Node（CI/本机默认），
// 此时依次尝试 NATIVE_DEMO_NODE 环境变量与 fnm 的并存版本目录；仍无则失败并说明出路。
// 解析结果在进程内确定不变，首次成功后缓存（pingUntilReady 轮询与逐用例 CLI 调用反复走到，
// 免去每次重复探测文件系统）。
let cachedNode22: string | undefined

export function resolveNode22(): string {
  cachedNode22 ??= detectNode22()
  return cachedNode22
}

function detectNode22(): string {
  if (Number(process.versions.node.split('.')[0]) >= 22) return process.execPath
  const fromEnv = process.env.NATIVE_DEMO_NODE
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const fnmDir = process.env.FNM_DIR ?? path.join(os.homedir(), 'AppData', 'Roaming', 'fnm')
  const versionsDir = path.join(fnmDir, 'node-versions')
  if (existsSync(versionsDir)) {
    const candidates = readdirSync(versionsDir)
      .filter(v => /^v(2[2-9]|[3-9]\d)\./.test(v))
      .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))
    for (const v of candidates) {
      const bin = path.join(versionsDir, v, 'installation', 'node.exe')
      if (existsSync(bin)) return bin
    }
  }
  throw new Error(
    '没有可用的 Node 22+：设置 NATIVE_DEMO_NODE 指向 Node 22+ 可执行文件（本机通道宿主/客户端的强制门禁），'
    + '或让 demo 测试进程本身运行在 Node 22+ 上',
  )
}

function runNode22(script: string, args: string[]): ClientResult {
  const run = spawnSync(resolveNode22(), [path.join(SKILL_DIR, script), ...args], { encoding: 'utf8' })
  const stdout = (run.stdout ?? '').trim()
  let result: Record<string, any> | null = null
  // install/uninstall 输出缩进多行 JSON，client 输出单行 JSON——先整体解析，失败再退回末行
  for (const candidate of [stdout, stdout.split('\n').pop() as string]) {
    try {
      result = JSON.parse(candidate)
      break
    } catch {
      // 尝试下一个候选
    }
  }
  if (result === null) {
    throw new Error(`${script} 没有输出合法 JSON（exit ${run.status}）：stdout=${run.stdout} stderr=${run.stderr}`)
  }
  return { result, stderr: run.stderr ?? '', exitCode: run.status ?? -1 }
}

// 本进程内已确认注册位干净（成功卸载后置位；install.mjs 本就对注册位全量覆盖写入）：后续
// 安装免去防御性 uninstall 子进程。新进程从 false 起步，跨运行的中断残留仍由首次安装自愈回收。
let hostRegistrationConfirmedClean = false

// 用户级安装宿主并绑定 Chromium 形态（Playwright 自带 Chromium 读取该注册位）。未确认干净时
// 先卸载再重装（自愈上次中断的残留注册），不把残留当作就绪证据。
export function installNativeHost(): InstallSummary {
  if (!hostRegistrationConfirmedClean) uninstallNativeHost()
  const { result } = runNode22('install.mjs', ['--browser', 'chromium'])
  if (result.installed !== true) {
    throw new Error(`宿主安装失败：${JSON.stringify(result)}`)
  }
  if (result.extensionId !== HOST_EXT_ID) {
    throw new Error(`allowed_origins 绑定了意外扩展 ID：${String(result.extensionId)}`)
  }
  return result as InstallSummary
}

// 幂等卸载：对未安装状态返回 false 而不是失败（uninstall.mjs 对缺失注册同样输出
// uninstalled:true）。宿主进程由 Chrome 以其安装目录为 CWD 拉起——浏览器刚关闭时进程
// 退出与句柄释放存在窗口，EPERM/EBUSY 重试等待，仍失败才让用例失败。
export function uninstallNativeHost(): boolean {
  let run = runNode22('uninstall.mjs', ['--browser', 'chromium'])
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (run.result.uninstalled === true) break
    if (!/EPERM|EBUSY|ENOTEMPTY/.test(String(run.result.error ?? ''))) break
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)
    run = runNode22('uninstall.mjs', ['--browser', 'chromium'])
  }
  if (run.result.uninstalled !== true) {
    throw new Error(`宿主卸载失败：${JSON.stringify(run.result)}`)
  }
  hostRegistrationConfirmedClean = true
  return run.result.registrationRemoved === true
}

// 运行一次真实客户端 CLI。args 形如 ['ping'] 或 ['flow.save', '--text', json]。
export function runClient(args: string[]): ClientResult {
  return runNode22('client.mjs', args)
}

export function pingNative(): ClientResult {
  return runClient(['ping'])
}

// 扩展冷启动 connectNative 与宿主进程拉起存在时序：轮询 ping 直到 ok:true（通道就绪的唯一标准）。
export async function pingUntilReady(timeoutMs = 20_000): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs
  let last: ClientResult | null = null
  while (Date.now() < deadline) {
    last = pingNative()
    if (last.result.ok === true) return last.result.data as Record<string, any>
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`本机通道在 ${timeoutMs}ms 内未就绪：${JSON.stringify(last?.result)}`)
}

// 经本机通道保存流程（设计 §9 的「本机通道播种」：故事前置的既有流程也走同一条真实通道）。
// 返回应答与本次使用的 clientRef（新铸造的 ref 在 client stderr 回显，--ref 透传时即该值）。
export function saveFlowViaNative(
  flowJson: string,
  opts: { flowId?: string, expectedUpdatedAt?: number, ref?: string, timeout?: number } = {},
): { result: Record<string, any>, ref: string } {
  const args = ['flow.save', '--text', flowJson]
  if (opts.flowId !== undefined) args.push('--flow-id', opts.flowId)
  if (opts.expectedUpdatedAt !== undefined) args.push('--expected-updated-at', String(opts.expectedUpdatedAt))
  if (opts.ref !== undefined) args.push('--ref', opts.ref)
  if (opts.timeout !== undefined) args.push('--timeout', String(opts.timeout))
  const run = runClient(args)
  const echoed = /save clientRef: (\S+)/.exec(run.stderr)
  const ref = opts.ref ?? echoed?.[1]
  if (ref === undefined) throw new Error(`没有拿到 save clientRef：${run.stderr}`)
  return { result: run.result, ref }
}

export function verifyRef(ref: string): Record<string, any> {
  return runClient(['flow.verify', '--ref', ref]).result
}

// 用户级端点推导，逐分支镜像 skills/oncewise-message/protocol.mjs 的 ipcEndpoint（demo 包
// 不跨目录 import skill 源码）；该处分支变动时同步这里。
function ipcEndpointPath(): string {
  if (process.platform === 'win32') {
    const user = os.userInfo().username.replace(/[^a-zA-Z0-9_-]/g, '_')
    return `\\\\.\\pipe\\ai.oncewise.native-${user}`
  }
  const dir = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'OnceWiseAI', 'ipc')
    : process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), '.local', 'run', 'oncewise-ai')
  return path.join(dir, 'ai.oncewise.native.sock')
}

// 确定性制造「结果未知」：直连 IPC 端点发出一条合法 flow.save，在请求写出（flush）后立刻
// 撤销连接——宿主侧等待者被丢弃，应答永远不会到达，客户端只能观察到 close-after-send。
// 随后用真实 client.mjs flow.verify 核对该 ref 的真实落盘结果（US-NM-004 场景 2 的承载）。
export function saveAndDropResponse(
  flowJson: string,
  opts: { flowId?: string, expectedUpdatedAt?: number } = {},
): Promise<string> {
  const ref = `${Date.now()}.${randomBytes(16).toString('hex')}`
  const payload: Record<string, unknown> = { text: flowJson, clientRef: ref }
  if (opts.flowId !== undefined) payload.flowId = opts.flowId
  if (opts.expectedUpdatedAt !== undefined) payload.expectedUpdatedAt = opts.expectedUpdatedAt
  return new Promise((resolve, reject) => {
    const socket = net.connect(ipcEndpointPath())
    socket.on('error', error => reject(new Error(`IPC 连接失败：${error.message}`)))
    socket.on('connect', () => {
      socket.write(JSON.stringify({ v: 1, id: `demo-${Date.now().toString(36)}`, op: 'flow.save', payload }) + '\n', () => {
        // 请求已离开客户端——现在断开，模拟「已发送但收不到回执」
        socket.destroy()
        resolve(ref)
      })
    })
  })
}

// 经真实 IPC 端点发出任意信封并等待一条应答。用于验证通道边界（如白名单外的 op 得到
// unsupported-op）——client.mjs 只暴露五个合法 op，越界请求只能从这一层如实送入。
export function sendRawRequest(op: string, payload: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(ipcEndpointPath())
    let buffer = ''
    const fail = (message: string) => {
      clearTimeout(timer)
      socket.destroy()
      reject(new Error(message))
    }
    const timer = setTimeout(() => fail('raw 请求超时'), timeoutMs)
    socket.on('error', error => fail(`IPC 连接失败：${error.message}`))
    socket.on('connect', () => {
      socket.write(JSON.stringify({ v: 1, id: `demo-${Date.now().toString(36)}`, op, payload }) + '\n')
    })
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timer)
      socket.end()
      try {
        resolve(JSON.parse(buffer.slice(0, newline)))
      } catch (error) {
        reject(new Error(`应答不是合法 JSON：${String(error)}`))
      }
    })
  })
}

// nativeTest：在项目扩展 fixture（fixtures.ts 的 extensionManifest/extensionId/extensionLogs
// 等）之上，把 context 的启动排在宿主注册之后（覆盖 context 使其依赖 nativeChannel
// fixture），保证扩展冷启动 connectNative 时注册已存在，不靠重连退避碰运气。用例结束按
// 依赖逆序收尾：先关 context，再卸载宿主（注册回收）。
//
// unix 上 Playwright chromium 的用户级 NM 查找目录跟随 --user-data-dir（strace 实测为
// <profile>/NativeMessagingHosts，Chrome 启动时还会自建该目录），不读文档里的 ~/.config/
// chromium 等固定目录；Windows 走 HKCU 注册表不受影响。因此除 install.mjs 的标准注册外，
// 再把宿主 manifest 预置进本次 profile 的 NativeMessagingHosts/，冷启动 connectNative 才能
// 找到宿主（真实用户默认 profile 的 Chrome 仍由标准注册覆盖）。
export const nativeTest = extensionBase.extend<{
  nativeChannel: InstallSummary
}>({
  nativeChannel: async ({}, use) => {
    const summary = installNativeHost()
    await use(summary)
    uninstallNativeHost()
  },
  context: async ({ nativeChannel, extensionManifest, headless }, use, testInfo) => {
    let profileDir: string | undefined
    if (process.platform !== 'win32') {
      profileDir = await mkdtemp(path.join(os.tmpdir(), 'ow-native-profile-'))
      const nmDir = path.join(profileDir, 'NativeMessagingHosts')
      await mkdir(nmDir, { recursive: true })
      await copyFile(nativeChannel.manifestPath, path.join(nmDir, path.basename(nativeChannel.manifestPath)))
    }
    try {
      await useExtensionContext(extensionManifest, headless, testInfo, use, profileDir)
    } finally {
      if (profileDir !== undefined) await removeProfileDir(profileDir)
    }
  },
})

// 浏览器进程退出与句柄释放存在窗口（Windows 上尤甚），EPERM/EBUSY 时短暂重试；仍失败则保留
// 目录（os.tmpdir() 下的一次性 profile），不让清理失败掩盖用例本身的结论。
async function removeProfileDir(profileDir: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(profileDir, { recursive: true, force: true })
      return
    } catch (error) {
      if (!/EPERM|EBUSY|ENOTEMPTY/.test(String(error))) throw error
      await new Promise(resolve => setTimeout(resolve, 400))
    }
  }
}

// bareTest：强制「宿主未注册」再冷启动浏览器（自愈清理上次中断的残留注册），承载
// US-NM-001 的未就绪场景——该场景必须由真实缺失产生，不能用 mock 冒充。
export const bareTest = extensionBase.extend<{ noNativeChannel: void }>({
  noNativeChannel: [async ({}, use) => {
    uninstallNativeHost()
    await use()
  }, { auto: true }],
  context: async ({ noNativeChannel, extensionManifest, headless }, use, testInfo) => {
    void noNativeChannel
    await useExtensionContext(extensionManifest, headless, testInfo, use)
  },
})

// 卸载后验证「扩展其余功能不受影响」时，用例自行拉起无宿主注册的浏览器上下文。
export async function launchBareExtensionContext(headless: boolean) {
  const context = await launchExtensionContext(extensionPath, headless)
  const id = await resolveExtensionId(context, await readExtensionManifest())
  return { context, extensionId: id }
}
