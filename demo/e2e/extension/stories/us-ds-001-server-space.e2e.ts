import { expect, test } from '../fixtures'
import { SyncServer } from '../sync-server'
import { startHostSite } from '../host-site'
import {
  ackOnboarding, autoAcceptDialogs, connectServer, createSpaceViaUi, demoFlowJson,
  openFlowsTab, openSpaceScripts, openSyncTab, openWorkbench,
  readSpaceCode, flowCardLocation, seedFlow, spaceGroup,
} from '../workbench'

// US-DS-001 配置同步服务并创建空间（docs/user-stories/core/data-sync.md 故事 1）。
// T1 对应场景 1（配置服务器并创建空间）；T2 对应场景 2（不配置不影响本地，DEC-005/008）。

test('T1 配置服务器并创建空间：空间码本机生成、清单选中、本地流程不受影响', async ({
  page, extensionId,
}) => {
  test.setTimeout(120_000)
  const server = await SyncServer.start()
  const host = await startHostSite()
  autoAcceptDialogs(page)
  const flowName = 'Demo warehouse flow'
  try {
    // 前置：本机已有一条已验证流程（seedFlow 经 sp:saveFlow 保存通道，见 workbench.ts）
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await seedFlow(page, demoFlowJson(host.origin, { name: flowName, value: '13800001111' }))

    // Connect 即保存并探测（connectServer 自带可达断言与失败文案）
    await openSyncTab(page)
    await connectServer(page, server.origin)

    // 创建空间：ID/密钥本机生成，注册成功后入册并选中
    await createSpaceViaUi(page, 'Team Space')
    const group = spaceGroup(page, 'Team Space')
    await expect(group.locator('.sp-badge', { hasText: /^(Current space|当前空间)$/ })).toBeVisible()

    // 空间码形状（sp-+16 base62 + '#' + 32 base62）
    const code = await readSpaceCode(page, 'Team Space')
    expect(code).toMatch(/^sp-[A-Za-z0-9]{16}#[A-Za-z0-9]{32}$/)

    // 本地流程功能不受任何影响：流程视图照常，且可进入脚本视图（空态）
    await openFlowsTab(page)
    await expect(flowCardLocation(page, flowName)).toBeVisible()
    await openSyncTab(page)
    await openSpaceScripts(page, 'Team Space')
    await expect(page.locator('.sp-empty', { hasText: /No scripts yet|尚无脚本/ })).toBeVisible()
  } finally {
    await host.close()
    await server.cleanup()
  }
})

test('T2 不配置不影响本地：同步页预置默认服务器，流程闭环照常', async ({ page, extensionId }) => {
  await openWorkbench(page, extensionId)
  // 首启 onboarding 流程不变（确认后进入工作台导航）
  await ackOnboarding(page)

  // 未显式配置服务器：地址栏预置托管默认（产品内置 DEFAULT_SYNC_SERVER_URL），
  // 空间清单为空态；同步面板可用与否不影响本地
  await openSyncTab(page)
  await expect(page.locator('#sync-server')).toHaveValue('https://auto.fornetcode.com')
  await expect(page.locator('p.sp-hint', { hasText: /No spaces yet|尚无空间/ })).toBeVisible()

  // 流程视图照常可用（空态提示，无任何同步前置）
  await openFlowsTab(page)
  await expect(page.locator('main.sp-main .sp-empty')).toBeVisible()
})
