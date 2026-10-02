import type { Page } from '@playwright/test'
import { expect, extensionEntryUrl } from '../fixtures'
import { startHostSite, type HostSite } from '../host-site'
import {
  ackOnboarding, demoFlowJson, enableFlowFromFlowsTab, expectHostPhoneFilled, expectFlowStatus,
  getFlows, openHostPage, renameFlowViaEditor, flowCardLocation,
} from '../workbench'
import {
  nativeTest, pingUntilReady, runClient, saveFlowViaNative, sendRawRequest,
} from '../native-host'

// US-NM-003 修订已有流程经本机通道交付（docs/user-stories/core/support-native-messaging.md）：
// - T1 场景 1：侧栏「用 AI 优化」→ 暂停 + 15 分钟单流程读取授权（DEC-004）→ flow.read 取
//   完整原流程 → 修订经同一校验 → 【对话确认前提同 us-nm-002】→ 按原 ID + expectedUpdatedAt
//   CAS 替换 → 未启用、无并行新流程 → 用户本人再启用 → 受控页执行修订内容。
// - T2 场景 2：读取后原流程被另一处修改（编辑器改名）→ 替换被 revision-stale 拒绝，当前
//   内容不受影响。
// - T3 场景 3 + 通道边界：无授权 flow.read 被拒绝零副作用；白名单外 op 得 unsupported-op；
//   放弃修订时原流程保持暂停。

const ORIGINAL_VALUE = '13911110000'
const REVISED_VALUE = '13922220000'

let hostSite: HostSite

nativeTest.beforeAll(async () => {
  hostSite = await startHostSite()
})

nativeTest.afterAll(async () => {
  await hostSite.close()
})

// 经本机通道播种既有流程（设计 §9「本机通道播种」），并打开其编辑器详情发起优化。
async function seedAndStartOptimize(page: Page, name: string): Promise<{ flowId: string, updatedAt: number }> {
  const seeded = saveFlowViaNative(demoFlowJson(hostSite.origin, { name, value: ORIGINAL_VALUE }))
  expect(seeded.result.ok).toBe(true)
  const flowId = seeded.result.data.flowId as string
  await page.getByRole('button', { name: /^(View \/ Edit|查看 \/ 编辑)$/ }).click()
  await page.getByRole('button', { name: /^(Improve with AI|用 AI 优化)$/ }).click()
  await expect(
    page.locator('.sp-progress[role="status"]', { hasText: /^Read access granted for \d+ min|^已授权读取 \d+ 分钟/ }),
  ).toBeVisible()
  const read = runClient(['flow.read', '--flow-id', flowId]).result
  expect(read.ok).toBe(true)
  return { flowId, updatedAt: read.data.updatedAt as number }
}

nativeTest('revision replaces the original flow id, lands not-enabled, and runs after user re-enable', async ({ page, extensionId }) => {
  await pingUntilReady()
  await page.goto(await extensionEntryUrl(extensionId, 'sidepanel'))
  await ackOnboarding(page)
  const { flowId, updatedAt } = await seedAndStartOptimize(page, '本机修订流程')

  const revisedJson = demoFlowJson(hostSite.origin, { name: '本机修订流程', value: REVISED_VALUE })
  const validate = runClient(['flow.validate', '--text', revisedJson]).result
  expect(validate.ok).toBe(true)

  // —— 对话确认前提在此完成后才发起替换（同 us-nm-002 的确认语义） ——
  const replace = saveFlowViaNative(revisedJson, { flowId, expectedUpdatedAt: updatedAt })
  expect(replace.result.ok).toBe(true)
  expect(replace.result.data).toMatchObject({ flowId, status: 'draft', replayed: false })

  // 同 ID 覆盖：清单没有并行新流程；内容是修订版；状态未启用
  const flows = await getFlows(page) as { id: string, status: string, steps: { steps: { action: { value: unknown } }[] } }[]
  expect(flows).toHaveLength(1)
  expect(flows[0].id).toBe(flowId)
  expect(flows[0].status).toBe('draft')
  expect(flows[0].steps.steps[0].action.value).toBe(REVISED_VALUE)
  await expectFlowStatus(page, '本机修订流程', 'draft')

  // 只有用户本人再次启用后才执行修订内容
  await enableFlowFromFlowsTab(page, '本机修订流程')
  const hostPage = await openHostPage(page.context(), hostSite.formUrl)
  await expectHostPhoneFilled(hostPage, REVISED_VALUE)
})

nativeTest('saving a revision over a concurrently changed original is refused', async ({ page, extensionId }) => {
  await pingUntilReady()
  await page.goto(await extensionEntryUrl(extensionId, 'sidepanel'))
  await ackOnboarding(page)
  const { flowId, updatedAt } = await seedAndStartOptimize(page, '冲突保护流程')

  // 读取之后、替换之前：原流程在另一处被修改（编辑器改名落盘，updatedAt 前移）
  await renameFlowViaEditor(page, '冲突保护流程', '冲突保护流程-已改')

  const staleSave = saveFlowViaNative(
    demoFlowJson(hostSite.origin, { name: '冲突保护流程-已改', value: REVISED_VALUE }),
    { flowId, expectedUpdatedAt: updatedAt },
  )
  expect(staleSave.result.ok).toBe(false)
  expect(staleSave.result.error?.code).toBe('revision-stale')

  // 拒绝是零副作用：仍是单条流程、内容保持被改名后的当前状态
  const flows = await getFlows(page) as { name: string, steps: { steps: { action: { value: unknown } }[] } }[]
  expect(flows).toHaveLength(1)
  expect(flows[0].name).toBe('冲突保护流程-已改')
  expect(flows[0].steps.steps[0].action.value).toBe(ORIGINAL_VALUE)
})

nativeTest('unauthorized reads and out-of-channel ops are refused; abandoning keeps the flow paused', async ({ page, extensionId }) => {
  await pingUntilReady()
  const seeded = saveFlowViaNative(demoFlowJson(hostSite.origin, { name: '边界流程', value: ORIGINAL_VALUE }))
  const flowId = seeded.result.data.flowId as string

  // 无授权读取（用户从未点「用 AI 优化」）：拒绝，零副作用
  const unauth = runClient(['flow.read', '--flow-id', flowId]).result
  expect(unauth.ok).toBe(false)
  expect(unauth.error?.code).toBe('read-not-authorized')

  // 白名单外 op（启用属于用户独占操作）：unsupported-op，零副作用
  const boundary = await sendRawRequest('flow.enable', { flowId })
  expect(boundary.ok).toBe(false)
  expect(boundary.error?.code).toBe('unsupported-op')

  await page.goto(await extensionEntryUrl(extensionId, 'sidepanel'))
  await ackOnboarding(page)

  // 放弃修订（场景 3）：与故事前提一致——用户先启用流程，再从详情发起优化（暂停 + 授权）、
  // 读取后不替换：原流程保持暂停，是否重新启用由用户决定
  await enableFlowFromFlowsTab(page, '边界流程')
  await flowCardLocation(page, '边界流程').getByRole('button', { name: /^(View \/ Edit|查看 \/ 编辑)$/ }).click()
  await page.getByRole('button', { name: /^(Improve with AI|用 AI 优化)$/ }).click()
  await expect(
    page.locator('.sp-progress[role="status"]', { hasText: /^Read access granted for \d+ min|^已授权读取 \d+ 分钟/ }),
  ).toBeVisible()
  const read = runClient(['flow.read', '--flow-id', flowId]).result
  expect(read.ok).toBe(true)
  await expectFlowStatus(page, '边界流程', 'paused')
})
