import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'
import { SyncServer } from '../sync-server'
import { startHostSite, type HostSite } from '../host-site'
import { launchParticipant, type Participant } from '../participant'
import {
  ackOnboarding, autoAcceptDialogs, connectServer, createSpaceViaUi, demoFlowJson,
  enableFlowFromFlowsTab, expectHostPhoneFilled, expectFlowStatus,
  joinSpaceViaUi, openHostPage, openFlowsTab, openScriptDetail,
  openSpaceScripts, openSyncTab, openWorkbench, pullVersion, readSpaceCode, scriptCard,
  seedFlow, uploadFlowAsScript, spaceGroup,
} from '../workbench'

// US-DS-005 空间生命周期管理（docs/user-stories/core/data-sync.md 故事 5）。
// T1 场景 1 在本机忘记：仅移除本机条目与关联，本机流程与已拉取内容保留（DEC-008 本地优先）；
// T2 场景 2 删除服务端空间：级联删除，各端 404 提示，本机数据保留。

const SPACE = 'Team Space'
const SCRIPT = 'Warehouse Script'
const FLOW = 'demo flow v1'
const VALUE = '13800001111'

// A 建空间存脚本；B 加入、拉取 v1 并启用（T1/T2 共用的“已在使用”前置）。
async function setupActiveConsumer(
  server: SyncServer, host: HostSite, page: Page,
  extensionId: string, demoHeadless: boolean,
): Promise<Participant> {
  await openWorkbench(page, extensionId)
  await ackOnboarding(page)
  await seedFlow(page, demoFlowJson(host.origin, { name: FLOW, value: VALUE }))
  await openSyncTab(page)
  await connectServer(page, server.origin)
  await createSpaceViaUi(page, SPACE)
  const code = await readSpaceCode(page, SPACE)
  await openSpaceScripts(page, SPACE)
  await uploadFlowAsScript(page, { scriptName: SCRIPT, note: 'note', versionNote: 'v1' })

  const b = await launchParticipant(demoHeadless, 'us-ds-005 B')
  autoAcceptDialogs(b.page)
  await ackOnboarding(b.page)
  await openSyncTab(b.page)
  await connectServer(b.page, server.origin)
  await joinSpaceViaUi(b.page, code)
  await openSpaceScripts(b.page, SPACE)
  await openScriptDetail(b.page, SCRIPT)
  await pullVersion(b.page, 1)
  await expectFlowStatus(b.page, FLOW, 'draft')
  await enableFlowFromFlowsTab(b.page, FLOW)
  await expectFlowStatus(b.page, FLOW, 'enabled')
  return b
}

test('T1 在本机忘记：条目与关联移除，本机流程保留且宿主页照常执行，A 不受影响', async ({
  page, extensionId, demoHeadless,
}) => {
  test.setTimeout(180_000)
  const server = await SyncServer.start()
  const host = await startHostSite()
  autoAcceptDialogs(page)
  let b: Participant | null = null
  try {
    b = await setupActiveConsumer(server, host, page, extensionId, demoHeadless)

    // B 忘记（confirmForget 由 autoAcceptDialogs 接受）：清单条目消失
    await openSyncTab(b.page)
    await b.page.getByRole('button', { name: /^(Forget|忘记)$/ }).click()
    await expect(b.page.locator('p.sp-hint', { hasText: /No spaces yet|尚无空间/ })).toBeVisible()

    // 本机流程与已拉取内容保留：流程仍在且保持启用，宿主页照常执行
    await expectFlowStatus(b.page, FLOW, 'enabled')
    const hostPage = await openHostPage(b.context, host.formUrl)
    await expectHostPhoneFilled(hostPage, VALUE)

    // 服务端与其他参与者不受影响：A 清单仍在、脚本仍可见
    await openSyncTab(page)
    await expect(spaceGroup(page, SPACE)).toBeVisible()
    await openSpaceScripts(page, SPACE)
    await expect(scriptCard(page, SCRIPT)).toBeVisible()
  } finally {
    await b?.dispose()
    await host.close()
    await server.cleanup()
  }
})

test('T2 删除服务端空间：级联删除，B 后续访问 404 提示、本机数据保留后忘记收尾', async ({
  page, extensionId, demoHeadless,
}) => {
  test.setTimeout(180_000)
  const server = await SyncServer.start()
  const host = await startHostSite()
  autoAcceptDialogs(page)
  let b: Participant | null = null
  try {
    b = await setupActiveConsumer(server, host, page, extensionId, demoHeadless)

    // A 删除（confirmDelete 文案区分服务端删除，由 autoAcceptDialogs 接受）：A 清单清除
    await openSyncTab(page)
    await page.getByRole('button', { name: /^(Delete|删除)$/ }).click()
    await expect(page.locator('p.sp-error', { hasText: /Space .* deleted|已删除空间/ })).toBeVisible()
    await expect(page.locator('p.sp-hint', { hasText: /No spaces yet|尚无空间/ })).toBeVisible()

    // B 后续访问：清单刷新得到“空间已不存在”警示，本机流程保留
    await openSyncTab(b.page)
    await openSpaceScripts(b.page, SPACE)
    await b.page.getByRole('button', { name: /^(Refresh|刷新)$/ }).click()
    await expect(b.page.locator('p.sp-warn', { hasText: /no longer exists on the server|该空间在服务器上已不存在/ })).toBeVisible()
    await expectFlowStatus(b.page, FLOW, 'enabled')
    const hostPage = await openHostPage(b.context, host.formUrl)
    await expectHostPhoneFilled(hostPage, VALUE)

    // B 忘记收尾：死条目移除，流程仍在（openSyncTab 重挂载回空间视图）
    await openSyncTab(b.page)
    await b.page.getByRole('button', { name: /^(Forget|忘记)$/ }).click()
    await expect(b.page.locator('p.sp-hint', { hasText: /No spaces yet|尚无空间/ })).toBeVisible()
    await expectFlowStatus(b.page, FLOW, 'enabled')
  } finally {
    await b?.dispose()
    await host.close()
    await server.cleanup()
  }
})
