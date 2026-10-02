import { expect, extensionEntryUrl, openExtensionPage } from '../fixtures'
import { ackOnboarding, enableFlowFromFlowsTab, seedFlow, demoFlowJson } from '../workbench'
import {
  bareTest, launchBareExtensionContext, nativeTest, pingNative, pingUntilReady, uninstallNativeHost,
} from '../native-host'

// US-NM-001 安装本机流程交接环境（docs/user-stories/core/support-native-messaging.md）：
// 场景 1 安装并验证连通（真实 install→ping）；场景 2 未就绪时明确失败而非「已保存」假象
// （真实缺失：宿主未注册）；场景 3 卸载不影响扩展其余功能（卸载后重新拉起浏览器，流程
// 播种/启用等工作台功能照常）。安装位置、固定扩展 ID 与排错见
// skills/oncewise-setup/references/native-host-setup.md。

const RX_CONNECTED = /Native channel: connected|本机通道：已连接/
const RX_DISCONNECTED = /Native channel: not connected|本机通道：未连接/

// 场景 2：宿主未注册时，客户端 ping 明确失败（extension-not-connected），导入页如实显示
// 未连接——不产生通道可用或「已保存」的假象。
bareTest('host not installed: ping fails explicitly and the import page says not connected', async ({ page, extensionId }) => {
  const ping = pingNative()
  expect(ping.result.ok).toBe(false)
  expect(ping.result.error?.code).toBe('extension-not-connected')

  await page.goto(await extensionEntryUrl(extensionId, 'import'))
  await expect(page.locator('p.im-hint[role="status"]', { hasText: RX_DISCONNECTED })).toBeVisible()
  await expect(page.locator('p.im-hint[role="status"]', { hasText: RX_CONNECTED })).toHaveCount(0)
})

// 场景 1：真实用户级安装（chromium 注册位）→ 扩展冷启动连接 → ping 返回真实结果
// （schemaVersion，不枚举流程），导入页显示已连接；注册绑定与浏览器实际加载的是同一个
// 固定扩展 ID。
nativeTest('installed host answers ping with real channel state', async ({ page, extensionId, nativeChannel }) => {
  const data = await pingUntilReady()
  expect(data.schemaVersion).toBeGreaterThanOrEqual(1)
  expect(JSON.stringify(data)).not.toContain('"flows"')

  // 通道状态提示按轮询刷新（约 15s 周期），连接后给足一个轮询窗口
  await page.goto(await extensionEntryUrl(extensionId, 'import'))
  await expect(page.locator('p.im-hint[role="status"]', { hasText: RX_CONNECTED })).toBeVisible({ timeout: 25_000 })

  // installNativeHost 已保证注册绑定的就是固定 ID；这里核验浏览器实际加载的与注册绑定的一致
  expect(extensionId).toBe(nativeChannel.extensionId)
})

// 场景 3：卸载只撤销本机通道——先关浏览器让宿主进程随 Chrome 退出，卸载后重新拉起
// （无宿主注册）的浏览器里，流程播种、启用等工作台功能照常，导入页回到未连接。
nativeTest('uninstall leaves the rest of the extension working', async ({ page, demoHeadless }) => {
  await pingUntilReady()

  await page.context().close()
  uninstallNativeHost()
  const bare = await launchBareExtensionContext(demoHeadless)
  try {
    const barePage = await openExtensionPage(bare.context, bare.extensionId, 'sidepanel')
    await ackOnboarding(barePage)
    await seedFlow(barePage, demoFlowJson('https://www.example.com', { name: 'After uninstall', value: '13700000000' }))
    await enableFlowFromFlowsTab(barePage, 'After uninstall')

    const importPage = await openExtensionPage(bare.context, bare.extensionId, 'import')
    await expect(importPage.locator('p.im-hint[role="status"]', { hasText: RX_DISCONNECTED })).toBeVisible({ timeout: 25_000 })
  } finally {
    await bare.context.close()
  }
})
