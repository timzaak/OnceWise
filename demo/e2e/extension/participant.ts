import type { BrowserContext, Page } from '@playwright/test'
import { attachParticipantLogger, launchExtensionContext, readExtensionManifest, resolveExtensionId } from './fixtures'
import { extensionPath } from './extension-target'
import { openWorkbench } from './workbench'

// 第二参与者 launcher：为参与者 B 启动独立 persistent context，加载与故事 fixture 相同的
// 生产构建产物。同一产物加载进两个独立 profile 即两台「设备」：unpacked 扩展 ID 由路径推导故
// 两实例相同，而设备身份（空间清单、本机流程）是各自 profile 的存储。
export interface Participant {
  context: BrowserContext
  page: Page
  extensionId: string
  dispose: () => Promise<void>
}

export async function launchParticipant(headless: boolean, label: string): Promise<Participant> {
  const manifest = await readExtensionManifest()
  const context = await launchExtensionContext(extensionPath, headless)
  try {
    const extensionId = await resolveExtensionId(context, manifest)
    // 参与者的工作台页复用本 context 的初始页（不新开）；与默认 fixture 的 page 语义一致
    const page = context.pages()[0] ?? await context.newPage()
    await openWorkbench(page, extensionId)
    const finalizeLogger = await attachParticipantLogger(page, `${label} sidepanel`)
    return {
      context,
      page,
      extensionId,
      dispose: async () => {
        await finalizeLogger().catch(() => undefined)
        await context.close()
      },
    }
  } catch (error) {
    await context.close()
    throw error
  }
}
