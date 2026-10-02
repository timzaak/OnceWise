import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'
import { SyncServer } from '../sync-server'
import {
  ackOnboarding, autoAcceptDialogs, connectServer, createSpaceViaUi, demoFlowJson,
  openScriptDetail, openSpaceScripts, openSyncTab,
  openWorkbench, previewVersion, publishVersion, renameFlowViaEditor, renameScript, scriptCard,
  seedFlow, uploadFlowAsScript, versionGroup,
} from '../workbench'

// US-DS-003 保存脚本并维护名称、备注与版本（docs/user-stories/core/data-sync.md 故事 3）。
// T1 场景 1 首次保存；T2 场景 2 修改内容发布新版本（版本号服务端写锁内 MAX+1，DEC-007）；
// T3 场景 3 改名不产生新版本。
// 内容变化以流程改名承载（FlowEditor 仅名称与 map 分组值可编辑），版本身份以固定徽标与
// 版本列表断言。

const SPACE = 'Team Space'
const SCRIPT = 'Warehouse Script'

async function setupConnected(page: Page, extensionId: string, server: SyncServer): Promise<void> {
  await openWorkbench(page, extensionId)
  await ackOnboarding(page)
  await seedFlow(page, demoFlowJson('http://127.0.0.1:9', { name: 'demo flow', value: '13800001111' }))
  await openSyncTab(page)
  await connectServer(page, server.origin)
  await createSpaceViaUi(page, SPACE)
  await openSpaceScripts(page, SPACE)
}

test('T1 首次保存为脚本：v1 入册、备注脱敏展示、数据离开设备确认链路', async ({
  page, extensionId,
}) => {
  test.setTimeout(120_000)
  const server = await SyncServer.start()
  autoAcceptDialogs(page)
  try {
    await setupConnected(page, extensionId, server)
    // cloudConfirm（“数据将存储到该服务器”）由 autoAcceptDialogs 接受；备注携带 7+ 位电话值
    await uploadFlowAsScript(page, { scriptName: SCRIPT, note: 'contact 13800001111', versionNote: 'first version' })
    const card = scriptCard(page, SCRIPT)
    await expect(card.locator('.sp-badge', { hasText: /^(Latest v1|最新 v1)$/ })).toBeVisible()
    // 脱敏仅展示层：电话值打码，原值不出现
    await expect(card).toContainText(/138\*\*\*\*1111/)
    await expect(card).not.toContainText('13800001111')
  } finally {
    await server.cleanup()
  }
})

test('T2 修改内容发布新版本：版本列表含 v2，本机固定移至 v2', async ({
  page, extensionId,
}) => {
  test.setTimeout(150_000)
  const server = await SyncServer.start()
  autoAcceptDialogs(page)
  try {
    await setupConnected(page, extensionId, server)
    await uploadFlowAsScript(page, { scriptName: SCRIPT, note: 'note', versionNote: 'v1' })
    await expect(scriptCard(page, SCRIPT).locator('.sp-badge', { hasText: /^(Pinned v1|本机固定 v1)$/ })).toBeVisible()

    // 本机修改流程内容（改名进入 flowDraftHash）→ local-edits 徽标 → 发布 v2
    await renameFlowViaEditor(page, 'demo flow', 'demo flow edited')
    await openSyncTab(page)
    await openSpaceScripts(page, SPACE)
    await expect(scriptCard(page, SCRIPT).locator('.sp-badge', { hasText: /Local edits not published|本机已修改未发布/ })).toBeVisible()

    await openScriptDetail(page, SCRIPT)
    await publishVersion(page, 'second version', 2)
    await expect(versionGroup(page, 2)).toBeVisible()
    await expect(versionGroup(page, 2).locator('.sp-badge', { hasText: /^(Latest|最新)$/ })).toBeVisible()
    // 发布后 re-pin：本机固定移至 v2
    await expect(scriptCard(page, SCRIPT).locator('.sp-badge', { hasText: /^(Pinned v2|本机固定 v2)$/ })).toBeVisible()
    await expect(versionGroup(page, 2).locator('.sp-badge', { hasText: /^(Pinned|本机固定)$/ })).toBeVisible()

    // 流程内容完整传输的证据：v2 版本预览摘要渲染流程步骤行（电话值脱敏展示），
    // 不只依赖流程改名证明内容进入版本
    await previewVersion(page, 2)
    await expect(page.locator('.sp-option .sp-desc', { hasText: /setInputValue/ })).toBeVisible()
    await expect(page.locator('.sp-option .sp-desc', { hasText: /138\*\*\*\*1111/ })).toBeVisible()
  } finally {
    await server.cleanup()
  }
})

test('T3 修改名称不产生新版本：信息更新、版本列表不变', async ({
  page, extensionId,
}) => {
  test.setTimeout(150_000)
  const server = await SyncServer.start()
  autoAcceptDialogs(page)
  try {
    await setupConnected(page, extensionId, server)
    await uploadFlowAsScript(page, { scriptName: SCRIPT, note: 'note', versionNote: 'v1' })
    await openScriptDetail(page, SCRIPT)
    await publishVersion(page, 'second version', 2)
    await expect(versionGroup(page, 2)).toBeVisible()

    // 脚本改名（PATCH 语义）：名称更新，latest 版本号不变，版本仍只有 v1/v2
    await renameScript(page, 'Warehouse Script renamed')
    await expect(page.locator('h2.sp-title', { hasText: 'Warehouse Script renamed' })).toBeVisible()
    await expect(page.locator('.sp-badge', { hasText: /^(Latest v2|最新 v2)$/ }).first()).toBeVisible()
    await expect(page.locator('.sp-group[aria-label^="v"]')).toHaveCount(2)
  } finally {
    await server.cleanup()
  }
})
