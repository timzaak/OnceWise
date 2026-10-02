import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'
import { SyncServer } from '../sync-server'
import { startHostSite, type HostSite } from '../host-site'
import { launchParticipant, type Participant } from '../participant'
import {
  ackOnboarding, autoAcceptDialogs, connectServer, createSpaceViaUi, demoFlowJson,
  enableFlowFromFlowsTab, expectHostPhoneFilled, expectFlowStatus,
  joinSpaceViaUi, openHostPage, openFlowsTab, openScriptDetail,
  openSpaceScripts, openSyncTab, openWorkbench, previewVersion, publishVersion,
  pullVersion, readSpaceCode, renameFlowViaEditor, flowCardLocation, scriptCard,
  seedFlow, uploadFlowAsScript, versionGroup,
} from '../workbench'

// US-DS-004 拉取脚本并选择使用某个版本（docs/user-stories/core/data-sync.md 故事 4）。
// T1 场景 1 拉取并启用（DEC-004：同一校验、默认未启用、启用仅本人）；
// T2 场景 2 新版本仅提示不自动切换（DEC-002 本地固定）；
// T3 场景 3 手动切换与回退（切换前替换影响确认、切换后转未启用、宿主结果随所选版本变化）；
// T4 场景 4 拉取校验失败整体拒绝（本机零影响）——「steps 非法」与「未知 schemaVersion」
// 两种失败形态分别验证。
// 版本差异：v2 以流程改名承载（FlowEditor 仅名称可编辑，发布链路走真实 UI）；v3 为行为不同的
// 版本（执行值变化），经空间键服务端直写（等同另一客户端发布；服务端不解读内容），B 侧切换/
// 回退/启用/执行仍全走真实链路。

const SPACE = 'Team Space'
const SCRIPT = 'Warehouse Script'
const FLOW_V1 = 'demo flow v1'
const FLOW_V2 = 'demo flow v2'
const FLOW_V3 = 'demo flow v3'
const VALUE = '13800001111'
const VALUE_V3 = '13900002222'

interface Collab {
  b: Participant
  code: string
}

// A 建空间存脚本（v1 内容），B 凭码加入并停在脚本详情；B 流程侧未做任何事。
async function setupCollab(
  server: SyncServer, host: HostSite, page: Page,
  extensionId: string, demoHeadless: boolean,
): Promise<Collab> {
  await openWorkbench(page, extensionId)
  await ackOnboarding(page)
  await seedFlow(page, demoFlowJson(host.origin, { name: FLOW_V1, value: VALUE }))
  await openSyncTab(page)
  await connectServer(page, server.origin)
  await createSpaceViaUi(page, SPACE)
  const code = await readSpaceCode(page, SPACE)
  await openSpaceScripts(page, SPACE)
  await uploadFlowAsScript(page, { scriptName: SCRIPT, note: 'note', versionNote: 'v1' })

  const b = await launchParticipant(demoHeadless, 'us-ds-004 B')
  await ackOnboarding(b.page)
  await openSyncTab(b.page)
  await connectServer(b.page, server.origin)
  await joinSpaceViaUi(b.page, code)
  await openSpaceScripts(b.page, SPACE)
  await expect(scriptCard(b.page, SCRIPT)).toBeVisible()
  return { b, code }
}

// B 拉取 v1 → 未启用 → 本人启用。
async function pullAndEnable(b: Participant): Promise<void> {
  await openScriptDetail(b.page, SCRIPT)
  await pullVersion(b.page, 1)
  await expectFlowStatus(b.page, FLOW_V1, 'draft')
  await enableFlowFromFlowsTab(b.page, FLOW_V1)
  await expectFlowStatus(b.page, FLOW_V1, 'enabled')
}

// A 把 v1 流程改名（构成内容变化）并发布 v2（T2/T3 共用前置）。
async function publishV2FromA(page: Page): Promise<void> {
  await renameFlowViaEditor(page, FLOW_V1, FLOW_V2)
  await openSyncTab(page)
  await openSpaceScripts(page, SPACE)
  await openScriptDetail(page, SCRIPT)
  await publishVersion(page, 'v2 with different name', 2)
  await expect(versionGroup(page, 2)).toBeVisible()
}

// 行为不同的 v3（执行值变化）：经空间键服务端直写（另一客户端发布的等价物）。列表接口取
// scriptId，flowContent 为合法流程（不同值），服务端透传不解读。
async function publishServerBehaviorVersion(
  server: SyncServer, code: string, host: HostSite,
): Promise<void> {
  const [spaceId, key] = code.split('#')
  const listRes = await server.request('GET', `/api/spaces/${spaceId}/scripts`, { key })
  const list = (await listRes.json()) as { id?: string; items?: { id: string; name: string }[] } | { id: string; name: string }[]
  const scripts = Array.isArray(list) ? list : (list.items ?? [])
  const script = scripts.find(s => s.name === SCRIPT)
  if (!script) throw new Error(`script ${SCRIPT} not found on server`)
  const flowContent = JSON.parse(demoFlowJson(host.origin, { name: FLOW_V3, value: VALUE_V3 }))
  const res = await server.createScriptVersion(key, spaceId, script.id, {
    versionNote: 'server v3 different behavior',
    flowContent,
  })
  expect(res.status).toBe(201)
}

test('T1 拉取并启用：进入本机为未启用，本人启用后宿主页按 v1 执行', async ({
  page, context, extensionId, demoHeadless,
}) => {
  test.setTimeout(150_000)
  const server = await SyncServer.start()
  const host = await startHostSite()
  autoAcceptDialogs(page)
  let collab: Collab | null = null
  try {
    collab = await setupCollab(server, host, page, extensionId, demoHeadless)
    autoAcceptDialogs(collab.b.page)
    await pullAndEnable(collab.b)

    const hostPage = await openHostPage(collab.b.context, host.formUrl)
    await expectHostPhoneFilled(hostPage, VALUE)
  } finally {
    await collab?.b.dispose()
    await host.close()
    await server.cleanup()
  }
})

test('T2 新版本仅提示：A 发布 v2 后 B 固定 v1、徽标非阻塞、宿主页仍按 v1 执行', async ({
  page, context, extensionId, demoHeadless,
}) => {
  test.setTimeout(180_000)
  const server = await SyncServer.start()
  const host = await startHostSite()
  autoAcceptDialogs(page)
  let collab: Collab | null = null
  try {
    collab = await setupCollab(server, host, page, extensionId, demoHeadless)
    autoAcceptDialogs(collab.b.page)
    await pullAndEnable(collab.b)

    // A 改流程名（内容变化）→ 发布 v2
    await publishV2FromA(page)

    // B 重进脚本清单：new-version 徽标（非阻塞），固定仍在 v1
    await openSyncTab(collab.b.page)
    await openSpaceScripts(collab.b.page, SPACE)
    const card = scriptCard(collab.b.page, SCRIPT)
    await expect(card.locator('.sp-badge', { hasText: /^(Pinned v1|本机固定 v1)$/ })).toBeVisible()
    await expect(card.locator('.sp-badge.sync-new', { hasText: /New version v2|新版本 v2/ })).toBeVisible()

    // 本机执行不被他人发布改变：宿主页新文档仍填 v1 值
    const hostPage = await openHostPage(collab.b.context, host.formUrl)
    await expectHostPhoneFilled(hostPage, VALUE)
  } finally {
    await collab?.b.dispose()
    await host.close()
    await server.cleanup()
  }
})

test('T3 手动切换与回退：替换影响确认、切换后转未启用、宿主结果随所选版本变化', async ({
  page, context, extensionId, demoHeadless,
}) => {
  test.setTimeout(240_000)
  const server = await SyncServer.start()
  const host = await startHostSite()
  autoAcceptDialogs(page)
  let collab: Collab | null = null
  try {
    collab = await setupCollab(server, host, page, extensionId, demoHeadless)
    autoAcceptDialogs(collab.b.page)
    await pullAndEnable(collab.b)

    await publishV2FromA(page)
    // v3：行为不同的版本（执行值 13900002222），空间键服务端直写
    await publishServerBehaviorVersion(server, collab.code, host)

    // B 切换到 v3（confirmSwitch 由 autoAcceptDialogs 接受）：流程转未启用，须本人重新启用；
    // 本机流程内容随固定版本替换为 v3 内容（流程名 + 执行值）
    await openSyncTab(collab.b.page)
    await openSpaceScripts(collab.b.page, SPACE)
    await openScriptDetail(collab.b.page, SCRIPT)
    await expect(versionGroup(collab.b.page, 3)).toBeVisible({ timeout: 20_000 })
    await pullVersion(collab.b.page, 3)
    await expectFlowStatus(collab.b.page, FLOW_V3, 'draft')
    await expect(flowCardLocation(collab.b.page, FLOW_V1)).toHaveCount(0)
    await enableFlowFromFlowsTab(collab.b.page, FLOW_V3)
    await expectFlowStatus(collab.b.page, FLOW_V3, 'enabled')
    let hostPage = await openHostPage(collab.b.context, host.formUrl)
    await expectHostPhoneFilled(hostPage, VALUE_V3)

    // 回退 v1：同一数据流反向，宿主结果回到 v1 执行值
    await openSyncTab(collab.b.page)
    await openSpaceScripts(collab.b.page, SPACE)
    await openScriptDetail(collab.b.page, SCRIPT)
    await pullVersion(collab.b.page, 1)
    await expectFlowStatus(collab.b.page, FLOW_V1, 'draft')
    await enableFlowFromFlowsTab(collab.b.page, FLOW_V1)
    await expectFlowStatus(collab.b.page, FLOW_V1, 'enabled')
    hostPage = await openHostPage(collab.b.context, host.formUrl)
    await expectHostPhoneFilled(hostPage, VALUE)
  } finally {
    await collab?.b.dispose()
    await host.close()
    await server.cleanup()
  }
})

// 校验必失败版本的注入 + 拒绝断言（T4a/T4b 共用）：预览显示校验错误、该版本拉取禁用、
// 本机零写入（B 无任何流程落地）。
async function expectBrokenVersionRefused(
  b: Participant, server: SyncServer, code: string, flowContent: unknown, errorFragment: RegExp,
): Promise<void> {
  const [spaceId, key] = code.split('#')
  const created = await server.createScript(key, spaceId, {
    id: 'sc-demobrokenscript00',
    name: 'Broken Script',
    note: 'injected',
    versionNote: 'broken',
    flowContent,
  })
  expect(created.status).toBe(201)

  await openSyncTab(b.page)
  await openSpaceScripts(b.page, SPACE)
  await openScriptDetail(b.page, 'Broken Script')
  await previewVersion(b.page, 1)
  await expect(b.page.locator('h2.sp-title', { hasText: /cannot enter this device|无法进入本机/ })).toBeVisible()
  await expect(b.page.locator('p.sp-error', { hasText: errorFragment }).first()).toBeVisible()
  const pullButton = versionGroup(b.page, 1).getByRole('button', { name: /^(Pull to this device|拉取到本机)$/ })
  await expect(pullButton).toBeDisabled()
  await openFlowsTab(b.page)
  await expect(b.page.locator('main.sp-main .sp-empty')).toBeVisible()
}

test('T4a 拉取校验失败（格式支持但 steps 非法）：整体拒绝且零写入', async ({
  page, context, extensionId, demoHeadless,
}) => {
  test.setTimeout(180_000)
  const server = await SyncServer.start()
  autoAcceptDialogs(page)
  let collab: Collab | null = null
  try {
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await openSyncTab(page)
    await connectServer(page, server.origin)
    await createSpaceViaUi(page, SPACE)
    const code = await readSpaceCode(page, SPACE)
    const b = await launchParticipant(demoHeadless, 'us-ds-004 B')
    collab = { b, code }
    autoAcceptDialogs(b.page)
    await ackOnboarding(b.page)
    await openSyncTab(b.page)
    await connectServer(b.page, server.origin)
    await joinSpaceViaUi(b.page, code)

    // steps 非法（未知节点 kind）：结构校验整体拒绝
    await expectBrokenVersionRefused(collab.b, server, code, {
      schemaVersion: 1, name: 'broken', site: 'http://127.0.0.1:9',
      page: { urlIncludes: '/x' }, trigger: { kind: 'pageEnter' },
      steps: { id: 'root', kind: 'sequence', steps: [{ id: 'x', kind: 'goto', label: 'top' }] },
    }, /unknown node kind|schemaVersion/)
  } finally {
    await collab?.b.dispose()
    await server.cleanup()
  }
})

test('T4b 拉取校验失败（未知 schemaVersion）：整体拒绝且零写入', async ({
  page, context, extensionId, demoHeadless,
}) => {
  test.setTimeout(180_000)
  const server = await SyncServer.start()
  autoAcceptDialogs(page)
  let collab: Collab | null = null
  try {
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await openSyncTab(page)
    await connectServer(page, server.origin)
    await createSpaceViaUi(page, SPACE)
    const code = await readSpaceCode(page, SPACE)
    const b = await launchParticipant(demoHeadless, 'us-ds-004 B')
    collab = { b, code }
    autoAcceptDialogs(b.page)
    await ackOnboarding(b.page)
    await openSyncTab(b.page)
    await connectServer(b.page, server.origin)
    await joinSpaceViaUi(b.page, code)

    // 未知 schemaVersion（2）：版本门整体拒绝
    await expectBrokenVersionRefused(collab.b, server, code, {
      schemaVersion: 2, name: 'broken', site: 'http://127.0.0.1:9',
      page: { urlIncludes: '/x' }, trigger: { kind: 'pageEnter' }, actions: [],
    }, /schemaVersion/)
  } finally {
    await collab?.b.dispose()
    await server.cleanup()
  }
})
