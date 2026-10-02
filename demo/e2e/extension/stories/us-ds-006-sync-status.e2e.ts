import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'
import { SyncServer } from '../sync-server'
import { startHostSite, type HostSite } from '../host-site'
import {
  ackOnboarding, autoAcceptDialogs, connectServer, createSpaceViaUi, demoFlowJson,
  enableFlowFromFlowsTab, expectHostPhoneFilled, expectFlowStatus,
  openHostPage, openSpaceScripts, openSyncTab,
  openWorkbench, seedFlow, uploadFlowAsScript,
} from '../workbench'

// US-DS-006 同步状态与异常可见（docs/user-stories/core/data-sync.md 故事 6）。
// T1 场景 1 服务不可达时本地不受影响（DEC-008 本地优先）；T2 场景 2 失败原因可见且可重试。

const SPACE = 'Team Space'
const SCRIPT = 'Warehouse Script'
const FLOW = 'demo flow v1'
const VALUE = '13800001111'

// 单参与者已启用消费者的前置：本机流程保存为脚本（上传即固定 v1 并关联）→ 本人启用。
async function setupEnabledConsumer(
  server: SyncServer, host: HostSite, page: Page, extensionId: string,
): Promise<void> {
  await openWorkbench(page, extensionId)
  await ackOnboarding(page)
  await seedFlow(page, demoFlowJson(host.origin, { name: FLOW, value: VALUE }))
  await openSyncTab(page)
  await connectServer(page, server.origin)
  await createSpaceViaUi(page, SPACE)
  await openSpaceScripts(page, SPACE)
  await uploadFlowAsScript(page, { scriptName: SCRIPT, note: 'note', versionNote: 'v1' })
  await expectFlowStatus(page, FLOW, 'draft')
  await enableFlowFromFlowsTab(page, FLOW)
  await expectFlowStatus(page, FLOW, 'enabled')
}

test('T1 服务不可达：同步区显示不可达，本地流程宿主页照常执行', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(150_000)
  const server = await SyncServer.start()
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await setupEnabledConsumer(server, host, page, extensionId)

    await server.stop()
    await openSyncTab(page)
    await openSpaceScripts(page, SPACE)
    await page.getByRole('button', { name: /^(Refresh|刷新)$/ }).click()
    // 健康行/错误文案显示不可达（失败保留上次列表供查看）
    await expect(page.locator('.sp-badge.fail, p.sp-error', { hasText: /unreachable|不可达/ }).first()).toBeVisible()

    // 本地执行不受影响
    const hostPage = await openHostPage(context, host.formUrl)
    await expectHostPhoneFilled(hostPage, VALUE)
  } finally {
    await host.close()
    await server.cleanup()
  }
})

test('T2 失败原因可见且可重试：停止时操作失败原因展示，恢复后重连转 ok', async ({
  page, extensionId,
}) => {
  test.setTimeout(150_000)
  const server = await SyncServer.start()
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await setupEnabledConsumer(server, host, page, extensionId)

    // 服务停止时尝试创建空间：失败原因可见（地址已保存可重试）
    await server.stop()
    await openSyncTab(page)
    await page.locator('#sync-space-name').fill('Second Space')
    await page.getByRole('button', { name: /^(Create space|创建空间)$/ }).click()
    await expect(page.locator('p.sp-error', { hasText: /Server unreachable.*retry|服务不可达.*重试|服务不可达：/ })).toBeVisible()

    // 恢复后重试：重连（地址未变时连接即重新探测）转 ok，同一操作可重试成功。故事语义即
    // “可重试”——有界重试容忍 SW 侧对旧进程连接的短暂失效。
    await server.start()
    await openSyncTab(page)
    let reachable = false
    for (let attempt = 0; attempt < 4 && !reachable; attempt++) {
      await page.getByRole('button', { name: /^(Connect|连接)$/ }).first().click()
      try {
        await expect(page.locator('p.sp-hint', { hasText: /^(Server reachable|服务可达)/ })).toBeVisible({ timeout: 10_000 })
        reachable = true
      } catch {
        await page.waitForTimeout(2_000)
      }
    }
    expect(reachable, '恢复后重连应转为可达').toBe(true)
    await createSpaceViaUi(page, 'Second Space')
  } finally {
    await host.close()
    await server.cleanup()
  }
})
