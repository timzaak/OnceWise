import { expect, extensionEntryUrl } from '../fixtures'
import { startHostSite, type HostSite } from '../host-site'
import { demoFlowJson, getFlows, openHostPage, expectHostPhoneFilled, openWorkbench, ackOnboarding } from '../workbench'
import {
  nativeTest, pingUntilReady, runClient, saveAndDropResponse, saveFlowViaNative, verifyRef,
} from '../native-host'

// US-NM-002 新流程经本机通道交付并核对摘要 + US-NM-004 交接结果真实可见
// （docs/user-stories/core/support-native-messaging.md）。全程不出现 AI 逐控件操作导入页：
// 导入页只承载保存后摘要（SavedFlowCard）与用户本人的启用点击（DEC-016）。
// - T1 主路径：本机 validate 出可读摘要 → 【对话确认前提：用例在此代表用户完成对本次内容
//   的明确确认（DEC-007），此后才允许发起 save】→ 本机 save 落为未启用 → flow.verify 读回
//   与扩展真实状态一致 → 导入页摘要卡与真实流程一致 → 用户本人点击启用 → 受控页自动执行。
// - T2 校验失败整体拒绝：validation-failed 带具体条目、零写入。
// - T3 结果未知（US-NM-004 场景 2）：请求送出后收不到回执（连接在写出后断开）时结果未确认，
//   用 flow.verify 核对真实落盘；同 ref 同载荷重放幂等，不产生第二次保存。

const FLOW_NAME = '本机交付联系电话流程'
const FLOW_VALUE = '13800001234'

const RX_NOT_ENABLED = /^Not enabled$|^未启用$/
const RX_ENABLED = /^Enabled$|^已启用$/

let hostSite: HostSite

nativeTest.beforeAll(async () => {
  hostSite = await startHostSite()
})

nativeTest.afterAll(async () => {
  await hostSite.close()
})

nativeTest('validated flow saves as not-enabled after in-conversation confirmation, user enables it, it runs', async ({ page, extensionId }) => {
  await pingUntilReady()
  const flowJson = demoFlowJson(hostSite.origin, { name: FLOW_NAME, value: FLOW_VALUE })

  // 扩展全量校验给出可读摘要（站点、页面、触发、步骤；无提交类动作）
  const validate = runClient(['flow.validate', '--text', flowJson]).result
  expect(validate.ok).toBe(true)
  expect(validate.data).toMatchObject({ name: FLOW_NAME, site: hostSite.origin })
  expect(String(validate.data.page)).toContain('form-page.html')
  expect(validate.data.steps.length).toBeGreaterThanOrEqual(1)
  expect(validate.data.steps.every((s: { submit: boolean }) => s.submit === false)).toBe(true)

  // —— 对话确认前提在此完成（见文件头）；确认后 AI 才经本机通道发起保存 ——
  const save = saveFlowViaNative(flowJson)
  expect(save.result.ok).toBe(true)
  expect(save.result.data).toMatchObject({ flowId: expect.any(String), status: 'draft', replayed: false })

  // US-NM-004 场景 1：成功报告与扩展读回一致
  const verify = verifyRef(save.ref)
  expect(verify.ok).toBe(true)
  expect(verify.data).toMatchObject({ confirmed: true, flowStatus: 'draft', updatedAt: save.result.data.updatedAt })

  // 导入页 = 保存后摘要载体：摘要卡读取真实流程，状态未启用，启用按钮属于用户
  await page.goto(await extensionEntryUrl(extensionId, 'import'))
  const card = page.locator('section.im-card[aria-label="Saved flow"], section.im-card[aria-label="已保存的流程"]')
  await expect(card).toBeVisible()
  await expect(card.locator('.im-badge', { hasText: RX_NOT_ENABLED })).toBeVisible()
  await expect(card.locator('strong.im-desc', { hasText: FLOW_NAME })).toBeVisible()
  await expect(card.locator('.im-info-row', { hasText: hostSite.origin })).toBeVisible()
  await expect(card.locator('li.im-action-item').first()).toBeVisible()

  // 用户本人点击一键启用（DEC-016）：此后进入流程目标页自动执行。启用成功后卡头状态
  // 徽标与一键区的完成徽标都会显示 Enabled，取其一即可。
  await card.getByRole('button', { name: /^(Enable|启用)$/ }).click()
  await expect(card.locator('.im-badge', { hasText: RX_ENABLED }).first()).toBeVisible()

  const hostPage = await openHostPage(page.context(), hostSite.formUrl)
  await expectHostPhoneFilled(hostPage, FLOW_VALUE)
})

nativeTest('validation failure rejects the whole delivery with zero writes', async ({ page, extensionId }) => {
  await pingUntilReady()

  // 缺少流程主体的残缺流程：整体拒绝并给出具体条目，不保存任何部分
  const broken = JSON.stringify({ schemaVersion: 1, name: '残缺流程', site: hostSite.origin })
  const validate = runClient(['flow.validate', '--text', broken]).result
  expect(validate.ok).toBe(false)
  expect(validate.error?.code).toBe('validation-failed')
  expect(validate.error?.errors?.length).toBeGreaterThanOrEqual(1)

  const save = runClient(['flow.save', '--text', broken]).result
  expect(save.ok).toBe(false)
  expect(save.error?.code).toBe('validation-failed')

  // 零写入核对须在扩展页上下文内发消息（chrome.runtime 仅在扩展页可用）
  await page.goto(await extensionEntryUrl(extensionId, 'import'))
  const flows = await getFlows(page) as { id: string }[]
  expect(flows).toHaveLength(0)
})

nativeTest('an unanswered save is result-unknown, then verified — never assumed', async ({ page, extensionId }) => {
  // page/extensionId 让浏览器与本机宿主保持运行（宿主由 Chrome 拉起，是 IPC 端点的所有者）
  await pingUntilReady()
  const flowJson = demoFlowJson(hostSite.origin, { name: `${FLOW_NAME}-未知`, value: '13800009999' })

  // 请求已写出（flush）后连接断开：客户端只能得到「结果未知」，不得推断成败
  const ref = await saveAndDropResponse(flowJson)

  // 先核对再行动（业务流程 8）：真实 CLI flow.verify 读回持久回执
  const verify = verifyRef(ref)
  expect(verify.ok).toBe(true)
  expect(verify.data).toMatchObject({ confirmed: true, flowStatus: 'draft' })

  // 同 ref 同载荷重放：幂等命中已保存回执，不产生新版本/第二次保存
  const replay = saveFlowViaNative(flowJson, { ref })
  expect(replay.result.ok).toBe(true)
  expect(replay.result.data).toMatchObject({ flowId: verify.data.receipt.flowId, replayed: true })
  expect(replay.result.data.updatedAt).toBe(verify.data.updatedAt)

  // 扩展侧真实状态与核对结论一致：工作台里恰好这一条未启用流程
  await openWorkbench(page, extensionId)
  await ackOnboarding(page)
  const flows = await getFlows(page) as { name: string, status: string }[]
  expect(flows).toHaveLength(1)
  expect(flows[0]).toMatchObject({ name: `${FLOW_NAME}-未知`, status: 'draft' })
})
