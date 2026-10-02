import { chromium, test as base, type BrowserContext, type Page, type TestInfo } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UnifiedLogger } from 'playwright-unified-logger'
import { extensionPath } from './extension-target'

// 构建产物 manifest 的最小类型：只声明 Demo 需要读取的字段（background service worker、
// action popup、options 页面与 ID 推导所需的 key）。
type ExtensionManifest = {
  manifest_version: number
  name: string
  version: string
  key?: string
  background?: { service_worker?: string }
  action?: { default_popup?: string }
  side_panel?: { default_path: string }
  options_ui?: { page: string }
  options_page?: string
}

// OnceWise AI 扩展 Demo 基础 fixture（加载纯生产构建产物，verification/ 冒烟使用）：
// - extensionManifest：读取并校验 MV3 构建产物，缺失或非 MV3 直接失败（不用 skip 隐藏加载错误）
// - context：覆盖 Playwright 默认 context，用自带 Chromium（channel: 'chromium'，headless 由
//   demo-fast project 传入）以独立临时 profile 加载构建产物，并把 extension-build 信息附加到
//   测试报告，失败时可追溯实际加载的产物路径与 manifest
// - extensionId：本项目构建含 background service worker（background.js），从 worker URL 解析
//   扩展 ID；无 background 的分支（manifest key 推导 / EXTENSION_ID 环境变量）保留模板能力，
//   不为取 ID 修改生产 manifest 或伪造 background
// - extensionLogs：auto fixture，对默认 page 启用统一日志，用例结束（含失败）时落盘
// - demoHeadless：把 project 的 headless 取值暴露给用例（双参与者启动第二 context 时复用）
export const test = base.extend<{
  extensionManifest: ExtensionManifest
  extensionId: string
  demoHeadless: boolean
  extensionLogs: void
}>({
  extensionManifest: async ({}, use) => {
    await use(await readExtensionManifest())
  },
  context: async ({ extensionManifest, headless }, use, testInfo) => {
    await useExtensionContext(extensionManifest, headless, testInfo, use)
  },
  extensionId: async ({ context, extensionManifest }, use) => {
    await use(await resolveExtensionId(context, extensionManifest))
  },
  demoHeadless: async ({ headless }, use) => {
    await use(headless)
  },
  extensionLogs: [async ({ page }, use) => {
    // 自动启用日志，失败时也落盘；page 来自上面的扩展 context。finalize 是统一日志的唯一
    // 落盘路径（network/route JSON 与 console 尾部 flush 都在 finalize 内），必须收尾调用。
    const finalize = await attachParticipantLogger(page, test.info().title)
    try {
      await use()
    } finally {
      await finalize()
    }
  }, { auto: true }],
})

export const expect = test.expect

export async function readExtensionManifest(): Promise<ExtensionManifest> {
  // 缺失或无效构建直接失败，不通过 skip 隐藏加载错误。
  const manifest = JSON.parse(
    await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'),
  ) as ExtensionManifest
  if (manifest.manifest_version !== 3) throw new Error('需要 Chrome MV3 构建产物')
  return manifest
}

// 以独立临时 profile 加载指定构建产物目录（生产 extensionPath；第二参与者 launcher 也走同一
// 入口，保证启动策略单点生效）。profileDir 缺省时由 Playwright 生成随机临时 profile 并自清
// 理；显式传入时（nativeTest 需要预置 NativeMessagingHosts）由调用方负责清理。
export async function launchExtensionContext(
  loadPath: string, projectHeadless: boolean, profileDir?: string,
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDir ?? '', {
    // MV3 扩展的 headless 模式要求使用 Playwright 自带 Chromium channel
    channel: 'chromium',
    headless: projectHeadless,
    args: [
      `--disable-extensions-except=${loadPath}`,
      `--load-extension=${loadPath}`,
    ],
  })
}

// 扩展 context 的完整启动体，本文件 context fixture 与 native-host.ts 的覆盖 context（需把
// 启动排在宿主注册/回收 fixture 之后）共用一份，两处启动策略不分叉。
export async function useExtensionContext(
  extensionManifest: ExtensionManifest,
  headless: boolean,
  testInfo: TestInfo,
  use: (context: BrowserContext) => Promise<void>,
  profileDir?: string,
): Promise<void> {
  await testInfo.attach('extension-build', {
    body: Buffer.from(JSON.stringify({ path: extensionPath, manifest: extensionManifest })),
    contentType: 'application/json',
  })
  const context = await launchExtensionContext(extensionPath, headless, profileDir)
  try {
    await use(context)
  } finally {
    // 每个用例独立临时 profile，结束时关闭，保证文件间隔离
    await context.close()
  }
}

export async function resolveExtensionId(context: BrowserContext, manifest: ExtensionManifest): Promise<string> {
  let id: string
  if (manifest.background?.service_worker) {
    const isExtensionWorker = (url: string) => url.startsWith('chrome-extension://')
    const worker = context.serviceWorkers().find(w => isExtensionWorker(w.url()))
      ?? await context.waitForEvent('serviceworker', {
        predicate: w => isExtensionWorker(w.url()), timeout: 10_000,
      })
    id = new URL(worker.url()).host
  } else if (manifest.key) {
    // Chromium 的公钥 ID 算法；只读取现有 key，不修改生产 manifest。
    id = createHash('sha256').update(Buffer.from(manifest.key, 'base64'))
      .digest('hex').slice(0, 32)
      .replace(/[0-9a-f]/g, n => String.fromCharCode(97 + parseInt(n, 16)))
  } else {
    id = process.env.EXTENSION_ID ?? ''
  }
  if (!/^[a-p]{32}$/.test(id)) {
    throw new Error('没有可用扩展 ID；为无 background/key 的页面测试提供本次产物的 EXTENSION_ID')
  }
  return id
}

// 扩展自有页面（sidepanel / import）都以 chrome-extension://<id>/<path> 直开；sidepanel 路径
// 取自 manifest。import 入口不在 manifest 中，固定为构建产物文件名 import.html（wxt 目录入口
// 约定产出；入口改名需同步此处）。
export async function extensionEntryUrl(extensionId: string, entry: 'sidepanel' | 'import'): Promise<string> {
  const manifest = await readExtensionManifest()
  const entryPath = entry === 'sidepanel'
    ? manifest.side_panel?.default_path
    : 'import.html'
  if (!entryPath) throw new Error('manifest.side_panel.default_path 缺失')
  return `chrome-extension://${extensionId}/${String(entryPath).replace(/^\//, '')}`
}

// 总是新开 page：持久化 context 的 pages()[0] 可能正是默认 page fixture 所在页（Playwright
// 会复用首个初始页），复用它会把调用方的工作台页面导航走。
export async function openExtensionPage(
  context: BrowserContext,
  extensionId: string,
  entry: 'sidepanel' | 'import',
): Promise<Page> {
  const page = await context.newPage()
  await page.goto(await extensionEntryUrl(extensionId, entry))
  return page
}

// 为参与者页面启用与 extensionLogs 相同的统一日志落盘；返回收尾函数。
export async function attachParticipantLogger(page: Page, title: string): Promise<() => Promise<void>> {
  const outputDir = path.resolve(process.env.UNIFIED_LOG_OUTPUT_DIR
    || process.env.DEMO_LOG_OUTPUT_DIR || 'test-results/unified-logs')
  await mkdir(outputDir, { recursive: true })
  const logger = new UnifiedLogger(page, title, { outputDir })
  return async () => {
    await logger.finalize()
  }
}
