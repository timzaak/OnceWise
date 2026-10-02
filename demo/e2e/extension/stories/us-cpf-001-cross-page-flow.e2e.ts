import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'
import { startHostSite, type HostSite } from '../host-site'
import {
  ackOnboarding, actionLogEntries, autoAcceptDialogs, countPendingHandovers, crossPageFlowJson,
  enableFlowFromFlowsTab, expectActionLogSequence, expectFlowStatus, flowCardLocation,
  openHostPage, openWorkbench, seedFlow, wizardConfirmPageQuery,
} from '../workbench'

// US-CPF-001 一条流程完成同一站点的多个页面（docs/user-stories/core/cross-page-flow.md
// 场景 1–6）。全部经真实链路：播种跨页流程（sp:saveFlow 保存通道）→ 本人启用 → 打开受控
// 三页向导自动执行（表单 GET 跳转 = 流程白名单提交点击造成的整页导航）。
// 页面侧受控信号：?biz= 区分业务实例、?open=new-tab 使确认以 target=_blank 打开结果页、
// ?scenario=slow 延迟结果页就绪约 3 秒（向导表单不带查询参数，该信号由宿主服务的 slowStep3
// 模式以 302 投递到表单发起的导航上）。
// 自动运行只在失败时向工作台报告——续跑页上的成功以「严格 in-flow 断言 + 无失败通知」验证。

const FLOW = '跨页向导流程'

async function setupEnabled(page: Page, extensionId: string, host: HostSite, flowJson: string): Promise<void> {
  await openWorkbench(page, extensionId)
  await ackOnboarding(page)
  await seedFlow(page, flowJson)
  await enableFlowFromFlowsTab(page, FLOW)
  await expectFlowStatus(page, FLOW, 'enabled')
}

async function expectFailureLine(page: Page, ...needles: RegExp[]): Promise<void> {
  const failure = flowCardLocation(page, FLOW).locator('details.sp-progress.fail')
  await expect(failure.locator('summary')).toBeVisible({ timeout: 15_000 })
  await failure.locator('summary').click()
  for (const needle of needles) await expect(failure.locator('p')).toContainText(needle)
}

async function expectNoFailureNotice(page: Page, settleMs: number): Promise<void> {
  await page.waitForTimeout(settleMs)
  await expect(flowCardLocation(page, FLOW).locator('details.sp-progress.fail')).toHaveCount(0)
}

// 源页在 target=_blank 变体下存活等待：确认后动作记录应冻结在这两条
const confirmTabLog = (biz: string): string[] => [`page-ready step=2 biz=${biz}`, `confirm biz=${biz} open=new-tab`]

// 结果页就绪组合断言（各用例共用的同一终态）：URL 到达 wizard-step3、终态标记可见；传 biz 时
// 一并断言经 URL 与表单字段延续的业务号（?scenario=slow 等可能追加在查询串后，匹配不加尾锚）
async function expectWizardResult(page: Page, biz?: string): Promise<void> {
  const url = biz ? new RegExp(`wizard-step3\\.html\\?orderNo=${biz}(?:$|[?&])`) : /wizard-step3\.html/
  await expect(page).toHaveURL(url, { timeout: 30_000 })
  await expect(page.locator('.done-marker.visible')).toBeVisible({ timeout: 15_000 })
  if (biz !== undefined) await expect(page.locator('#orderNo')).toHaveValue(biz)
}

test('T1 三页顺序续跑：每页按序执行、业务号逐页复核，最终只提交一次到达结果页', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(180_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await setupEnabled(page, extensionId, host, crossPageFlowJson(host.origin, { biz: 'B-1001' }))

    const hostPage = await openHostPage(context, host.wizardStepUrl(1, { biz: 'B-1001' }))
    // 同标签页经两道表单跳转到达结果页；URL 里的业务号经两页表单字段传递（提交 + 确认各一次）
    await expectWizardResult(hostPage, 'B-1001')
    // 每页业务号/回显断言内建于流程（read + assert 字面量）：任一页失败都会留下失败通知
    await expectNoFailureNotice(page, 5000)
  } finally {
    await host.close()
  }
})

test('T2 新标签页变体 + 慢加载认领：结果页在新标签页就绪后继续，原标签页不再动作', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(180_000)
  const host = await startHostSite({ slowStep3: true })
  autoAcceptDialogs(page)
  try {
    await setupEnabled(page, extensionId, host, crossPageFlowJson(host.origin, { biz: 'B-2001', entry: 2 }))

    const source = await openHostPage(context, host.wizardStepUrl(2, { biz: 'B-2001', openNewTab: true }))
    const childPromise = context.waitForEvent('page', { timeout: 30_000 })

    // 移交真实发生：暂存（在途移交 ≥1）→ 慢就绪后认领（清空）
    await expect.poll(() => countPendingHandovers(page), { timeout: 15_000 }).toBeGreaterThan(0)
    await expect.poll(() => countPendingHandovers(page), { timeout: 15_000 }).toBe(0)

    // 新标签页在就绪信号出现（约 3 秒延迟）后继续并完成（终态标记 + 业务号复核在流程内）
    const child = await childPromise
    await expectWizardResult(child, 'B-2001')

    // 源页存活但静止：动作记录冻结在确认一条，不再产生自动动作
    await expectActionLogSequence(source, confirmTabLog('B-2001'))
    await source.waitForTimeout(2000)
    expect(await actionLogEntries(source)).toHaveLength(2)
    await expectNoFailureNotice(page, 3000)
  } finally {
    await host.close()
  }
})

test('T3 声明页超时取消：下一页未在截止时间内就绪，运行失败且可见、不重试跳转', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(180_000)
  const host = await startHostSite({ slowStep3: true })
  autoAcceptDialogs(page)
  try {
    // navigate 截止 1500ms < 慢就绪约 3s：源页存活（target=_blank），走常规失败链
    await setupEnabled(page, extensionId, host, crossPageFlowJson(host.origin, { biz: 'B-3001', entry: 2, navTimeoutMs: 1500 }))

    const source = await openHostPage(context, host.wizardStepUrl(2, { biz: 'B-3001', openNewTab: true }))
    const childPromise = context.waitForEvent('page', { timeout: 30_000 })

    await expectFailureLine(page, /nav-result/, /navigate: timeout/)
    // 移交态已丢弃，不再可认领
    await expect.poll(() => countPendingHandovers(page), { timeout: 10_000 }).toBe(0)
    // 子页只是慢而非不存在：就绪信号随后出现（页面自身行为），但运行已失败，无任何自动动作
    const child = await childPromise
    await expectWizardResult(child)
    await expectActionLogSequence(source, confirmTabLog('B-3001'))
  } finally {
    await host.close()
  }
})

test('T4 意外中断保守取消：等待期关闭源标签页即取消，同单据不被重复提交', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(180_000)
  const host = await startHostSite({ slowStep3: true })
  autoAcceptDialogs(page)
  try {
    // 末页探针（必失败等待）：若运行被续跑会留下失败通知——取消则全程静默
    await setupEnabled(page, extensionId, host, crossPageFlowJson(host.origin, { biz: 'B-4001', entry: 2, failAfterResume: true }))

    const source = await openHostPage(context, host.wizardStepUrl(2, { biz: 'B-4001', openNewTab: true }))
    const childPromise = context.waitForEvent('page', { timeout: 30_000 })
    const child = await childPromise
    // 确认已执行（子页已打开）；在慢就绪窗口内关闭运行所在的源标签页 → 在途移交取消
    await source.close()

    // 取消静默：子页就绪后无续跑（否则探针失败通知会在窗口内出现）
    await expectWizardResult(child)
    await expectNoFailureNotice(page, 9000)
    // 同单据重复进入入口页：业务占用保持（确认已执行过一次），明确跳过、零自动动作
    const reopened = await openHostPage(context, host.wizardStepUrl(2, { biz: 'B-4001' }))
    await expectActionLogSequence(reopened, ['page-ready step=2 biz=B-4001'])
    await reopened.waitForTimeout(2500)
    expect(await actionLogEntries(reopened)).toHaveLength(1)
  } finally {
    await host.close()
  }
})

test('T5 同一业务实例完成后不重放：重复进入入口页零自动动作', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await setupEnabled(page, extensionId, host, crossPageFlowJson(host.origin, { biz: 'B-5001', entry: 2 }))

    // 同标签页完整跑完一次（确认 → 结果页）
    const hostPage = await openHostPage(context, host.wizardStepUrl(2, { biz: 'B-5001' }))
    await expectWizardResult(hostPage, 'B-5001')
    await expectNoFailureNotice(page, 3000)

    // 同单据再次进入入口页：会话内已占用，跳过且不报错，无任何自动动作
    const reopened = await openHostPage(context, host.wizardStepUrl(2, { biz: 'B-5001' }))
    await expectActionLogSequence(reopened, ['page-ready step=2 biz=B-5001'])
    await reopened.waitForTimeout(2500)
    expect(await actionLogEntries(reopened)).toHaveLength(1)
    await expectNoFailureNotice(page, 500)
  } finally {
    await host.close()
  }
})

test('T6 失败页标识：续跑页上步骤失败，失败行指明所在页与步骤', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await setupEnabled(page, extensionId, host, crossPageFlowJson(host.origin, { biz: 'B-6001', entry: 2, failAfterResume: true }))

    const hostPage = await openHostPage(context, host.wizardStepUrl(2, { biz: 'B-6001' }))
    // 失败行带页前缀（en/zh）+ 节点 + wait 超时原因；已在前两页完成的操作保留
    await expectFailureLine(page, /(on page result: |于页 result：)/, /wait-final-signal/, /wait: timeout/)
    await expectWizardResult(hostPage)
  } finally {
    await host.close()
  }
})

test('T7 双标签页单胜者：两个相关标签页同时命中声明页，只有一个续跑', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await setupEnabled(page, extensionId, host, crossPageFlowJson(host.origin, { biz: 'B-7001' }))

    const source = await openHostPage(context, host.wizardStepUrl(1, { biz: 'B-7001' }))
    // 预开一个由源页打开的确认页子标签页（opener 关系，携带与流程自身到达等价的完整查询）：
    // 流程提交后源标签页同页跳转，两个相关候选同时命中声明页指纹
    const rivalPromise = context.waitForEvent('page', { timeout: 15_000 })
    await source.evaluate(
      (url) => { window.open(url) },
      `${host.origin}/wizard-step2.html?${wizardConfirmPageQuery('B-7001')}`,
    )
    const rival = await rivalPromise
    await rival.waitForLoadState()

    // 源页流程执行提交 → 同页跳转到确认页（候选 A 与候选 B 竞争）
    await expect(source).toHaveURL(/wizard-step2\.html/, { timeout: 30_000 })
    // 恰一页推进到结果页（若发生双认领，两页都会推进，断言失败）
    await expect.poll(async () => {
      return [source, rival].filter(p => /wizard-step3\.html/.test(p.url())).length
    }, { timeout: 40_000 }).toBe(1)
    const winner = /wizard-step3\.html/.test(source.url()) ? source : rival
    const loser = winner === source ? rival : source
    await expectWizardResult(winner)
    // 败者停留确认页且无任何自动动作（确认点击未在败者执行）
    await expect(loser).toHaveURL(/wizard-step2\.html/)
    await expectActionLogSequence(loser, ['page-ready step=2 biz=B-7001'])
    await expectNoFailureNotice(page, 4000)
  } finally {
    await host.close()
  }
})
