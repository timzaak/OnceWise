import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'
import { SyncServer } from '../sync-server'
import { startHostSite } from '../host-site'
import { launchParticipant, type Participant } from '../participant'
import {
  ackOnboarding, autoAcceptDialogs, connectServer, createSpaceViaUi, demoFlowJson,
  joinSpaceViaUi, openScriptDetail, openSpaceScripts, openSyncTab,
  openWorkbench, pullVersion, readSpaceCode, renameScript, scriptCard,
  seedFlow, uploadFlowAsScript, spaceGroup,
} from '../workbench'

// US-DS-002 凭空间码加入空间（docs/user-stories/core/data-sync.md 故事 2）。
// T1 对应场景 1（凭码加入 + 持码对等读写，DEC-007）；T2 对应场景 2 失败路径（格式本地拦截、
// 未知 ID、密钥不匹配——服务端验证失败不记入本机）。

// 双参与者前置：A 建空间并存脚本；返回空间码。B 由调用方启动。
async function setupSpaceWithScript(
  server: SyncServer, page: Page, extensionId: string,
  spaceName: string, scriptName: string,
): Promise<string> {
  await openWorkbench(page, extensionId)
  await ackOnboarding(page)
  await seedFlow(page, demoFlowJson('http://127.0.0.1:9', { name: `flow-${scriptName}`, value: '13800001111' }))
  await openSyncTab(page)
  await connectServer(page, server.origin)
  await createSpaceViaUi(page, spaceName)
  const code = await readSpaceCode(page, spaceName)
  await openSpaceScripts(page, spaceName)
  await uploadFlowAsScript(page, { scriptName, note: 'team script', versionNote: 'first' })
  return code
}

test('T1 凭码加入：服务端验证通过才入册，持码对等读写（B 改名 A 可见）', async ({
  page, extensionId, demoHeadless,
}) => {
  test.setTimeout(150_000)
  const server = await SyncServer.start()
  const host = await startHostSite()
  autoAcceptDialogs(page)
  let b: Participant | null = null
  try {
    const code = await setupSpaceWithScript(server, page, extensionId, 'Team Space', 'Warehouse Script')

    // B：独立 profile（第二台设备）粘贴空间码加入
    b = await launchParticipant(demoHeadless, 'us-ds-002 B')
    autoAcceptDialogs(b.page)
    await ackOnboarding(b.page)
    await openSyncTab(b.page)
    await connectServer(b.page, server.origin)
    await joinSpaceViaUi(b.page, code)
    await expect(spaceGroup(b.page, 'Team Space')).toBeVisible()

    // 脚本视图可见该脚本
    await openSpaceScripts(b.page, 'Team Space')
    await expect(scriptCard(b.page, 'Warehouse Script')).toBeVisible()

    // 持码对等读写：B 拉取建立关联后改名，A Refresh 可见（无角色差异）
    await openScriptDetail(b.page, 'Warehouse Script')
    await pullVersion(b.page, 1)
    await renameScript(b.page, 'Warehouse Script v2 name')
    await b.page.getByRole('button', { name: /← Back to scripts|← 返回脚本清单/ }).click()
    await expect(scriptCard(b.page, 'Warehouse Script v2 name')).toBeVisible()

    await page.getByRole('button', { name: /^(Refresh|刷新)$/ }).click()
    await expect(scriptCard(page, 'Warehouse Script v2 name')).toBeVisible()
  } finally {
    await b?.dispose()
    await host.close()
    await server.cleanup()
  }
})

test('T2 无效空间码：格式本地拒绝、未知 ID 与错密钥服务端拒绝，均不入册', async ({
  page, extensionId, demoHeadless,
}) => {
  test.setTimeout(150_000)
  const server = await SyncServer.start()
  autoAcceptDialogs(page)
  let b: Participant | null = null
  try {
    const code = await setupSpaceWithScript(server, page, extensionId, 'Team Space', 'Warehouse Script')

    b = await launchParticipant(demoHeadless, 'us-ds-002 B')
    autoAcceptDialogs(b.page)
    await ackOnboarding(b.page)
    await openSyncTab(b.page)
    await connectServer(b.page, server.origin)

    const joinExpecting = async (codeText: string, message: RegExp) => {
      await b!.page.locator('#sync-join-code').fill(codeText)
      await b!.page.getByRole('button', { name: /^(Join|加入)$/ }).click()
      await expect(b!.page.locator('p.sp-error', { hasText: message })).toBeVisible()
      // 三种失败后 B 的空间清单保持为空（不记入本机）
      await expect(b!.page.locator('.sp-group')).toHaveCount(0)
    }

    // 格式畸形：本地直接拦截（不发网络请求）
    await joinExpecting('not-a-space-code', /does not look like a space code|这看起来不是空间码/)
    // 合法形状但未知空间 ID：服务端 404，不泄露存在性
    await joinExpecting(`sp-aaaaaaaaaaaaaaaa#${'k'.repeat(32)}`, /No space with that code exists|服务器上不存在该空间码/)
    // 真实 ID + 被篡改的密钥：服务端 401 密钥被拒
    const tamperedKey = code.replace(/#(.{32})$/, () => `#${'m'.repeat(32)}`)
    await joinExpecting(tamperedKey, /space key was rejected|空间密钥被拒绝/)
  } finally {
    await b?.dispose()
    await server.cleanup()
  }
})
