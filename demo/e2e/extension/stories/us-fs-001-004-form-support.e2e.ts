import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'
import { SyncServer } from '../sync-server'
import { startHostSite, type HostSite } from '../host-site'
import { launchParticipant, type Participant } from '../participant'
import {
  ackOnboarding, autoAcceptDialogs, connectServer, createSpaceViaUi,
  enableFlowFromFlowsTab, expectHostPhoneFilled, joinSpaceViaUi, openHostPage,
  openFlowsTab, openScriptDetail, openSpaceScripts, openSyncTab, openWorkbench,
  pullVersion, readSpaceCode, flowCardLocation, seedFlow,
  uploadFlowAsScript,
} from '../workbench'

// US-FS-001～004 运行前输入与流程复用（docs/user-stories/core/form-support.md 故事 1～4）。
// 一条声明七类输入的流程承载四条故事：详情填写与无效反馈（T1）、同次流程快照复用与
// 运行中改值下次生效（T2）、缺必填零动作/选填缺席可启动（T3）、同步只共享定义（T4）。
// 两步骤复用：同一 inputs.orderNo 先写 #contactPhone 再写 #remark；中间 wait 以
// #successBanner.visible 为门禁（测试侧点 #saveBtn 放行），为「运行中保存 B」留出窗口。

const FLOW = '表单输入流程'

// A/B 两侧的填写值：字符串值刻意取只可能来自本机输入的样本（3.14 / 2026-10-01 等
// 不会与定义中的 label/options 撞形），供 T4 同步边界做「不含个人值」的反向断言。
const A_VALUES = {
  orderNo: 'A-SYNC-777', weight: '3.14', channel: 'online',
  shipDate: '2026-10-01', pickupTime: '08:45',
} as const
const B_ORDER_NO = 'B-SYNC-888'

// 双语文案 regex（lib/i18n.ts 按浏览器 UI 语言选择目录）
const RX_SAVED = /^Saved — takes effect from the next automatic run\.|^已保存，下次启动生效。/
const RX_INVALID_TOP = /^Some values are invalid and were NOT saved|^存在无效值，未保存/
const RX_INVALID_ITEM = /^Invalid value — not saved|^值无效，未保存/
const RX_REQUIRED_ITEM = /^Required — not filled in yet|^必填项未填写/
const RX_SKIP_NOTICE = /Skipped: flow inputs incomplete or invalid|已跳过：流程输入缺失或无效/

// 声明七类输入的流程：前两个步骤消费 inputs.orderNo（US-FS-002），其余声明项仅验证
// 详情表单与门禁（US-FS-001/003）；wait 预算 45s 内测试可完成「运行中保存」再放行。
function formInputsFlowJson(site: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    name: FLOW,
    site,
    page: { urlIncludes: '/form-page.html' },
    trigger: { kind: 'pageEnter' },
    budget: { waitMs: 45_000, runMs: 300_000 },
    inputs: [
      { key: 'orderNo', label: '联系单号', type: 'text', required: true },
      { key: 'weight', label: '重量', type: 'number', required: true },
      { key: 'channel', label: '渠道', type: 'single', required: true, options: [{ value: 'online', label: '线上' }, { value: 'offline', label: '线下' }] },
      { key: 'urgent', label: '加急', type: 'checkbox', required: false },
      { key: 'shipDate', label: '发货日期', type: 'date', required: true },
      { key: 'pickupTime', label: '提货时间', type: 'time', required: false },
      { key: 'tags', label: '标签', type: 'multi', required: false, options: [{ value: 'fragile', label: '易碎' }, { value: 'cold', label: '冷链' }, { value: 'bulk', label: '大宗' }] },
    ],
    steps: {
      id: 'root',
      kind: 'sequence',
      steps: [
        {
          id: 'fill-phone', kind: 'action',
          action: {
            type: 'setInputValue',
            target: { clues: { id: 'contactPhone' }, componentType: 'input', displayLabel: '联系电话' },
            value: { ref: 'inputs.orderNo' },
          },
        },
        {
          id: 'wait-confirm', kind: 'wait', timeoutMs: 40_000,
          until: { kind: 'elementPresent', target: { clues: { cssPath: '#successBanner.visible' }, componentType: 'other', displayLabel: '保存成功横幅' } },
        },
        {
          id: 'fill-remark', kind: 'action',
          action: {
            type: 'setInputValue',
            target: { clues: { id: 'remark' }, componentType: 'input', displayLabel: '备注' },
            value: { ref: 'inputs.orderNo' },
          },
        },
      ],
    },
  })
}

// 输入表单所在的详情卡（hydration 完成前控件不渲染，标题可见即已就绪）。
function inputsCard(page: Page) {
  return page.locator('section.sp-card').filter({
    has: page.locator('h2.sp-title', { hasText: /^(Flow inputs|流程输入)$/ }),
  })
}

async function seedDraftFlow(page: Page, extensionId: string, host: HostSite): Promise<void> {
  await openWorkbench(page, extensionId)
  await ackOnboarding(page)
  await seedFlow(page, formInputsFlowJson(host.origin))
  await openFlowsTab(page)
}

async function openFlowEditor(page: Page, flowName: string): Promise<void> {
  await openFlowsTab(page)
  await flowCardLocation(page, flowName).getByRole('button', { name: /^(View \/ Edit|查看 \/ 编辑)$/ }).click()
  await expect(inputsCard(page)).toBeVisible({ timeout: 15_000 })
}

async function backToFlows(page: Page): Promise<void> {
  await page.locator('button.sp-back').first().click()
  await expect(flowCardLocation(page, FLOW)).toBeVisible({ timeout: 15_000 })
}

// 填写输入表单：未指定的项保持当前/未填写状态。
async function fillInputs(
  page: Page,
  values: { orderNo?: string; weight?: string; channel?: string; urgent?: boolean; shipDate?: string; pickupTime?: string; tags?: string[] },
): Promise<void> {
  if (values.orderNo !== undefined) await page.locator('#flow-input-orderNo').fill(values.orderNo)
  if (values.weight !== undefined) await page.locator('#flow-input-weight').fill(values.weight)
  if (values.channel !== undefined) await page.locator('#flow-input-channel').selectOption(values.channel)
  if (values.urgent !== undefined) await page.locator('#flow-input-urgent').setChecked(values.urgent)
  if (values.shipDate !== undefined) await page.locator('#flow-input-shipDate').fill(values.shipDate)
  if (values.pickupTime !== undefined) await page.locator('#flow-input-pickupTime').fill(values.pickupTime)
  for (const tag of values.tags ?? []) {
    await page.locator(`[data-input-key="tags"] input[type="checkbox"][value="${tag}"]`).check()
  }
}

async function saveInputs(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^(Save inputs|保存输入)$/ }).click()
}

// 保存并等待「已保存」提示；断言其他结果的调用点（如非法值被拒）仍直接用 saveInputs。
async function saveInputsExpectSaved(page: Page): Promise<void> {
  await saveInputs(page)
  await expect(page.locator('.sp-progress', { hasText: RX_SAVED })).toBeVisible({ timeout: 15_000 })
}

// 放行运行中的 wait（#saveBtn → 成功横幅），随后断言 #remark 由流程写入期望值。
async function releaseBannerAndWaitRemark(hostPage: Page, expectValue: string): Promise<void> {
  await hostPage.locator('#saveBtn').click()
  await expect(hostPage.locator('#successBanner.visible')).toBeVisible()
  await expect(hostPage.locator('#remark')).toHaveValue(expectValue, { timeout: 15_000 })
}

test('T1 七类输入填写保存：逐项水合持久，非法数字指出项目且不覆盖旧值', async ({
  page, extensionId,
}) => {
  test.setTimeout(150_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await seedDraftFlow(page, extensionId, host)

    // 七类控件按定义渲染（hydration 后控件块才出现）
    await openFlowEditor(page, FLOW)
    for (const key of ['orderNo', 'weight', 'channel', 'urgent', 'shipDate', 'pickupTime']) {
      await expect(page.locator(`#flow-input-${key}`)).toBeVisible()
    }
    await expect(page.locator('[data-input-key="tags"]')).toBeVisible()

    // 场景 1：填写全部七类并保存 → 已保存，下次启动生效
    await fillInputs(page, {
      orderNo: 'SO-2026-001', weight: '12.5', channel: 'online', urgent: true,
      shipDate: '2026-10-01', pickupTime: '09:30', tags: ['fragile', 'cold'],
    })
    await saveInputsExpectSaved(page)
    await expect(inputsCard(page).locator('p.sp-error')).toHaveCount(0)

    // 重进详情：从本机记录重新水合同一组值
    await backToFlows(page)
    await openFlowEditor(page, FLOW)
    await expect(page.locator('#flow-input-orderNo')).toHaveValue('SO-2026-001')
    await expect(page.locator('#flow-input-weight')).toHaveValue('12.5')
    await expect(page.locator('#flow-input-channel')).toHaveValue('online')
    await expect(page.locator('#flow-input-urgent')).toBeChecked()
    await expect(page.locator('#flow-input-shipDate')).toHaveValue('2026-10-01')
    await expect(page.locator('#flow-input-pickupTime')).toHaveValue('09:30')
    for (const tag of ['fragile', 'cold']) {
      await expect(page.locator(`[data-input-key="tags"] input[value="${tag}"]`)).toBeChecked()
    }
    await expect(page.locator('[data-input-key="tags"] input[value="bulk"]')).not.toBeChecked()

    // 场景 2：非法数字保存被拒——逐项错误 + 总错误，旧值不被覆盖
    await page.locator('#flow-input-weight').fill('abc')
    await saveInputs(page)
    await expect(inputsCard(page).locator('p.sp-error[role="alert"]').filter({ hasText: RX_INVALID_TOP })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('#flow-input-weight-err')).toHaveText(RX_INVALID_ITEM)
    await backToFlows(page)
    await openFlowEditor(page, FLOW)
    await expect(page.locator('#flow-input-weight')).toHaveValue('12.5')
    await expect(page.locator('#flow-input-orderNo')).toHaveValue('SO-2026-001')
  } finally {
    await host.close()
  }
})

test('T2 同次流程两步骤同值：运行中保存 B 当前仍用 A，下次触发用 B', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(150_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await seedDraftFlow(page, extensionId, host)
    await enableFlowFromFlowsTab(page, FLOW)

    // 保存 A（必填齐全；选填留空不阻止，见 T3 场景 2）
    await openFlowEditor(page, FLOW)
    await fillInputs(page, { orderNo: 'A-777001', weight: '12.5', channel: 'online', shipDate: '2026-10-01' })
    await saveInputsExpectSaved(page)
    await backToFlows(page)

    // 触发：首步骤用 A 写 #contactPhone，随后流程停在 wait-confirm 窗口内
    const hostPage = await openHostPage(context, host.formUrl)
    await expectHostPhoneFilled(hostPage, 'A-777001', 20_000)

    // 运行中把输入改为 B 并保存（只影响下次）
    await openFlowEditor(page, FLOW)
    await page.locator('#flow-input-orderNo').fill('B-998002')
    await saveInputsExpectSaved(page)
    await backToFlows(page)

    // 放行 wait：第二步骤仍使用启动快照 A，不串入 B
    await releaseBannerAndWaitRemark(hostPage, 'A-777001')

    // 下一次触发（新 document 重新取快照）：两步骤均为 B
    await hostPage.reload()
    await expectHostPhoneFilled(hostPage, 'B-998002', 20_000)
    await releaseBannerAndWaitRemark(hostPage, 'B-998002')
  } finally {
    await host.close()
  }
})

test('T3 缺必填零页面动作并列出项目；补必填留选填后可启动', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(150_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await seedDraftFlow(page, extensionId, host)
    await enableFlowFromFlowsTab(page, FLOW)

    // 场景 1：必填未填 → 触发被跳过，首动作目标保持空（零页面动作）
    const hostPage = await openHostPage(context, host.formUrl)
    await hostPage.waitForTimeout(4_000)
    await expect(hostPage.locator('#contactPhone')).toHaveValue('')
    await expect(hostPage.locator('#remark')).toHaveValue('')

    // 流程卡指出缺失项目（label (key): reason，只有标签不泄漏值）
    const notice = flowCardLocation(page, FLOW).locator('details.sp-progress.fail')
    await expect(notice.locator('summary')).toBeVisible({ timeout: 15_000 })
    await notice.locator('summary').click()
    await expect(notice.locator('p')).toContainText(RX_SKIP_NOTICE)
    await expect(notice.locator('p')).toContainText('联系单号 (orderNo): required-missing')
    await expect(notice.locator('p')).toContainText('重量 (weight): required-missing')

    // 场景 2：补齐必填、选填（加急/提货时间/标签）保持未填 → 可启动，首步骤动作发生
    await openFlowEditor(page, FLOW)
    await fillInputs(page, { orderNo: 'C-330001', weight: '12.5', channel: 'online', shipDate: '2026-10-01' })
    await saveInputsExpectSaved(page)
    await backToFlows(page)

    await hostPage.reload()
    await expectHostPhoneFilled(hostPage, 'C-330001', 20_000)
    await releaseBannerAndWaitRemark(hostPage, 'C-330001')
  } finally {
    await host.close()
  }
})

test('T4 同步边界：上传/服务端仅有定义；拉取方本机为空，填自己的值后执行', async ({
  page, extensionId, demoHeadless,
}) => {
  test.setTimeout(240_000)
  const server = await SyncServer.start()
  const host = await startHostSite()
  const SPACE = 'Input Boundary'
  const SCRIPT = 'Form Inputs Script'
  autoAcceptDialogs(page)
  let b: Participant | null = null
  try {
    // A：导入流程并保存本机值（制造「可能被泄漏」的个人数据），再上传为共享脚本
    await seedDraftFlow(page, extensionId, host)
    await openFlowEditor(page, FLOW)
    await fillInputs(page, { ...A_VALUES, urgent: true, tags: ['fragile'] })
    await saveInputsExpectSaved(page)
    await backToFlows(page)

    await openSyncTab(page)
    await connectServer(page, server.origin)
    await createSpaceViaUi(page, SPACE)
    const code = await readSpaceCode(page, SPACE)
    await openSpaceScripts(page, SPACE)
    await uploadFlowAsScript(page, { scriptName: SCRIPT, note: 'inputs boundary', versionNote: 'v1' })

    // 服务端存储的上传内容：输入定义完整、流程引用保留，但不包含 A 的任何填写值
    const [spaceId, key] = code.split('#')
    const listRes = await server.request('GET', `/api/spaces/${spaceId}/scripts`, { key })
    const list = (await listRes.json()) as { id?: string; items?: { id: string; name: string }[] } | { id: string; name: string }[]
    const scripts = Array.isArray(list) ? list : (list.items ?? [])
    const script = scripts.find(s => s.name === SCRIPT)
    if (!script) throw new Error(`script ${SCRIPT} not found on server`)
    const versionRes = await server.request('GET', `/api/spaces/${spaceId}/scripts/${script.id}/versions/1`, { key })
    expect(versionRes.status).toBe(200)
    const version = (await versionRes.json()) as { flowContent: { inputs?: unknown[] } }
    const serialized = JSON.stringify(version.flowContent)
    expect(version.flowContent.inputs).toHaveLength(7)
    expect(serialized).toContain('inputs.orderNo')
    for (const personal of [A_VALUES.orderNo, A_VALUES.weight, A_VALUES.shipDate, A_VALUES.pickupTime]) {
      expect(serialized, `上传内容不得包含本机填写值 ${personal}`).not.toContain(personal)
    }

    // B：凭码加入并拉取——只有定义，本机值为空且必填缺失被逐项指出
    b = await launchParticipant(demoHeadless, 'us-fs-001-004 B')
    autoAcceptDialogs(b.page)
    await ackOnboarding(b.page)
    await openSyncTab(b.page)
    await connectServer(b.page, server.origin)
    await joinSpaceViaUi(b.page, code)
    await openSpaceScripts(b.page, SPACE)
    await openScriptDetail(b.page, SCRIPT)
    await pullVersion(b.page, 1)

    await openFlowEditor(b.page, FLOW)
    await expect(b.page.locator('#flow-input-orderNo')).toHaveValue('')
    await expect(b.page.locator('#flow-input-orderNo-err')).toHaveText(RX_REQUIRED_ITEM)
    await expect(b.page.locator('#flow-input-weight-err')).toHaveText(RX_REQUIRED_ITEM)

    // B 填自己的值并保存 → 以 B 的值执行
    await fillInputs(b.page, { orderNo: B_ORDER_NO, weight: '1.5', channel: 'offline', shipDate: '2026-11-15' })
    await saveInputsExpectSaved(b.page)
    await backToFlows(b.page)
    await enableFlowFromFlowsTab(b.page, FLOW)

    const hostPage = await openHostPage(b.context, host.formUrl)
    await expectHostPhoneFilled(hostPage, B_ORDER_NO, 20_000)
    await releaseBannerAndWaitRemark(hostPage, B_ORDER_NO)

    // A 的本机值不受上传/共享影响（双方本机值独立）
    await openFlowEditor(page, FLOW)
    await expect(page.locator('#flow-input-orderNo')).toHaveValue(A_VALUES.orderNo)
  } finally {
    await b?.dispose()
    await host.close()
    await server.cleanup()
  }
})
