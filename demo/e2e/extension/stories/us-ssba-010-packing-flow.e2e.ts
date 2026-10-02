import { expect, test } from '../fixtures'
import type { Page } from '@playwright/test'
import { startHostSite, type HostSite } from '../host-site'
import {
  ackOnboarding, autoAcceptDialogs, enableFlowFromFlowsTab,
  expectPackingLogSequence, expectPackingPreviewHidden, expectPackingPreviewVisible,
  expectFlowStatus, openHostPage, openWorkbench,
  packingLogEntries, packingFlowJson, flowCardLocation, seedFlow,
} from '../workbench'

// US-SSBA-010 进入页面自动执行受约束流程 + US-SSBA-004 按业务实例防重放
// （docs/user-stories/core/self-service-browser-automation.md 故事 5/6，受控装箱页形态）。
// 全部经真实链路：播种流程（sp:saveFlow 保存通道，导入页 textarea 已随本机通道移除） →
// 本人启用 → 打开受控装箱页自动执行。
// 页面侧 ?scenario= 注入受控失败信号；动作记录与预览状态作为业务结果断言（页面模拟站点，
// 不调用扩展内部执行器）。

const FLOW = '装箱流程'

async function setupEnabled(page: Page, extensionId: string, host: HostSite): Promise<void> {
  await openWorkbench(page, extensionId)
  await ackOnboarding(page)
  await seedFlow(page, packingFlowJson(host.origin, { name: FLOW }))
  await enableFlowFromFlowsTab(page, FLOW)
  await expectFlowStatus(page, FLOW, 'enabled')
}

const perGroupLog = (key: string): string[] => [
  `switch:${key}`,
  `edit:${key}`,
  `selectall:${key}:true`,
  `autoload:${key}`,
  `save:${key}`,
]

// 页面就绪记录行（IIFE 末尾写入，位于预激活 switch 之后、流程动作之前）
const readyLine = (scenario: string, groups: number, biz: string): string =>
  `page-ready scenario=${scenario} groups=${groups} biz=${biz}`

test('T1 多组顺序处理：每组保存完成后进入下一组，最终确认一次，预览出现', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(180_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await setupEnabled(page, extensionId, host)

    const hostPage = await openHostPage(context, host.packingUrl('ok', 2))
    // 页面加载时预激活首组产生一条 switch:g1；随后流程完整处理两组并确认一次
    await expectPackingLogSequence(hostPage, [
      'switch:g1',
      readyLine('ok', 2, 'B-0001'),
      ...perGroupLog('g1'),
      ...perGroupLog('g2'),
      'confirm',
    ])
    await expectPackingPreviewVisible(hostPage)
    // 两组均已保存（完成信号元素出现）
    await expect(hostPage.locator('#panel-g1 .save-status')).toBeVisible()
    await expect(hostPage.locator('#panel-g2 .save-status')).toBeVisible()
  } finally {
    await host.close()
  }
})

test('T2 无效箱规：断言失败停止后续组与最终确认，已完成组保留不回滚', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(180_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await setupEnabled(page, extensionId, host)

    const hostPage = await openHostPage(context, host.packingUrl('invalid-data', 3))
    // g2 自动加载出 0 重量 → assert-rows 失败：g1 已保存保留，g3 与 confirm 不再发生
    await expectPackingLogSequence(hostPage, [
      'switch:g1',
      readyLine('invalid-data', 3, 'B-0001'),
      ...perGroupLog('g1'),
      'switch:g2',
      'edit:g2',
      'selectall:g2:true',
      'autoload:g2',
    ])
    await expect(hostPage.locator('#panel-g1 .save-status')).toBeVisible()
    await expect(hostPage.locator('#panel-g2 .save-status')).toBeHidden()
    await expectPackingPreviewHidden(hostPage)
    const failure = flowCardLocation(page, FLOW).locator('details.sp-progress.fail')
    await expect(failure.locator('summary')).toBeVisible({ timeout: 15_000 })
    await failure.locator('summary').click()
    await expect(failure.locator('p')).toContainText('assert-rows')
    await flowCardLocation(page, FLOW).getByRole('button', { name: /^(View \/ Edit|查看 \/ 编辑)$/ }).click()
    await expect(page.getByRole('button', { name: /^(Start dry run|开始预演)$/ })).toHaveCount(0)
    await expect(page.locator('.sp-progress.fail')).toContainText('assert-rows')
  } finally {
    await host.close()
  }
})

test('T3 保存无完成信号：等待超时按失败停止，不重放保存、不确认', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(180_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await setupEnabled(page, extensionId, host)

    const hostPage = await openHostPage(context, host.packingUrl('never-save', 2))
    // 保存点击发生但完成信号永不出现：saved 等待超时 → failed；不进入第二组与确认
    await expectPackingLogSequence(hostPage, [
      'switch:g1',
      readyLine('never-save', 2, 'B-0001'),
      ...perGroupLog('g1'),
    ])
    // loading 态保留（保存按钮停留在加载中，未重放点击）
    await expect(hostPage.locator('#panel-g1 .save-btn.ant-btn-loading')).toBeVisible()
    await expect(hostPage.locator('#panel-g1 .save-status')).toBeHidden()
    await expectPackingPreviewHidden(hostPage)
    const failure = flowCardLocation(page, FLOW).locator('details.sp-progress.fail')
    await expect(failure.locator('summary')).toBeVisible({ timeout: 15_000 })
    await failure.locator('summary').click()
    await expect(failure.locator('p')).toContainText('saved')
  } finally {
    await host.close()
  }
})

test('T4 同一业务实例刷新不重放，不同单据正常执行（按业务实例占用）', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(180_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await setupEnabled(page, extensionId, host)

    const hostPage = await openHostPage(context, host.packingUrl('ok', 2, 'B-0001'))
    await expectPackingPreviewVisible(hostPage)

    // 刷新同一单据：新 document 的动作记录只有页面初始化两条（预激活 + page-ready）；
    // 业务实例占用未解除 → 流程明确跳过，不产生任何自动化动作
    await hostPage.reload()
    await hostPage.waitForTimeout(4000)
    expect(await packingLogEntries(hostPage)).toHaveLength(2)
    await expectPackingPreviewHidden(hostPage)

    // 同页不同单据（业务键不同）：各自允许一次
    const otherBiz = await openHostPage(context, host.packingUrl('ok', 1, 'B-0002'))
    await expectPackingLogSequence(otherBiz, [
      'switch:g1',
      readyLine('ok', 1, 'B-0002'),
      ...perGroupLog('g1'),
      'confirm',
    ])
    await expectPackingPreviewVisible(otherBiz)
    await expect(flowCardLocation(page, FLOW)).toBeVisible()
  } finally {
    await host.close()
  }
})
