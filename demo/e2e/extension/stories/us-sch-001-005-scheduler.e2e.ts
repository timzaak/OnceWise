import { attachParticipantLogger, expect, openExtensionPage, test } from '../fixtures'
import type { BrowserContext, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startHostSite } from '../host-site'
import {
  ackOnboarding, actionLogEntries, autoAcceptDialogs, crossPageFlowJson, dailyTimeIn,
  deleteScheduleViaUi, demoFlowJson, editScheduleViaUi, enableFlowFromFlowsTab, expectFlowStatus,
  expectNoTabPage, fillScheduleForm, flowCardLocation, getFlows, openFlowsTab, openHostPage,
  openScheduleCreate, openWorkbench, packingFlowJson, peekFlowSchedules, peekPendingTimedStarts,
  pokeBusinessClaims, pokeFlowSchedules, relaunchExtensionOnProfile, saveSchedule,
  saveScheduleExpectRow, schedulesCard, seedFlow, waitForTabPage,
} from '../workbench'

// US-SCH-001~005 定时触发（support-scheduler）真实浏览器故事：计划管理 / 到点自动执行 /
// 错过与门禁失败可见 / 定时与手动共用防重放 / 计划归属创建设备。全程真实链路——sidepanel UI
// 创建计划 → 真实 chrome.alarms → 后台裁决分发 → 内容脚本进入既有自动运行管线 → 页面结果断言。
// 时间推进按受控短间隔：每日计划取「当前时刻 + ~90s」（一次真实等待覆盖墙钟路径；时刻字段
// 最后填、保存后核对 occurrence 近未来并兜底重建，压掉负载尖峰把 occurrence 推过分钟桶的抖动）、
// 间隔计划 1~5 分钟；错过路径经扩展页直写过期记录 + 同一 profile 换进程「浏览器重启」（冷启动
// reconcile）构造，不等真实宽限窗流逝；上限/占用经扩展页直写存储构造前置。
// 断言文案一律 en/zh 双语 regex（lib/i18n.ts 按浏览器 UI 语言选择目录）。

const FLOW = '定时计划流程'

const RX_COUNT = (n: number) => new RegExp(`${n} schedule\\(s\\) on this flow|本流程 ${n} 条计划`)
const RX_NEXT = /Next: |下一次：/
const RX_LIMIT = /the schedule limit is reached|计划数量已达上限/
const RX_MISSED = /Missed scheduled trigger\(s\)|已错过定时触发/
const RX_EXPIRED = /Timed trigger expired|定时触发已过期/
const RX_CLAIMED = /business instance is already claimed|业务实例已被占用/
const RX_INPUT_SKIP = /Skipped: flow inputs incomplete or invalid|已跳过：流程输入缺失或无效/
const RX_INPUT_SAVED = /^Saved — takes effect from the next automatic run\.|^已保存，下次启动生效。/

// 定时故事的最简表单流程直接用 workbench 的 demoFlowJson（默认填 #contactPhone；T8 的 B 流程
// 传 field: 'remark'）：无输入声明、无业务键，不引入防重放变量——纯「触发 → 分发 → 执行」链路。

// 声明必填输入的定时流程：以本机已保存值为输入（输入门禁故事）；缺失 → 零页面动作 + 提示项目。
function timedInputsFlowJson(site: string, name: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    name,
    site,
    page: { urlIncludes: '/form-page.html' },
    trigger: { kind: 'pageEnter' },
    inputs: [{ key: 'orderNo', label: '联系单号', type: 'text', required: true }],
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
      ],
    },
  })
}

// 页面特征不符流程：contentIncludes 指向 form-page 上永不存在的元素——入口 URL 的 URL 侧指纹
// 匹配（保存期校验通过），到点后的 content 门禁永不满足 → 描述符过期 → timed-start-expired 提示。
function contentMismatchFlowJson(site: string, name: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    name,
    site,
    page: {
      urlIncludes: '/form-page.html',
      contentIncludes: [{ clues: { cssPath: '.sch-absent-marker' }, componentType: 'other', displayLabel: '不存在的页面标记' }],
    },
    trigger: { kind: 'pageEnter' },
    steps: {
      id: 'root',
      kind: 'sequence',
      steps: [
        {
          id: 'fill', kind: 'action',
          action: {
            type: 'setInputValue',
            target: { clues: { id: 'contactPhone' }, componentType: 'input', displayLabel: '联系电话' },
            value: 'SCH-NEVER-RUNS',
          },
        },
      ],
    },
  })
}

// 墙钟 occurrence 的测试侧镜像（与 lib/flow-schedules.ts nextOccurrenceAfter 同规则）：以保存前
// 时刻推算，用于对记录 nextDueAt 的等值断言（编辑即时重排、创建排下一次）。
function nextDailyOccurrence(hm: string, after: number): number {
  const [h, m] = hm.split(':').map(Number)
  const base = new Date(after)
  let candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, 0, 0)
  if (candidate.getTime() <= after) {
    candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, h, m, 0, 0)
  }
  return candidate.getTime()
}

function nextWeeklyOccurrence(hm: string, weekday: number, after: number): number {
  const [h, m] = hm.split(':').map(Number)
  const base = new Date(after)
  let candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, 0, 0)
  let shift = (weekday - candidate.getDay() + 7) % 7
  if (shift === 0 && candidate.getTime() <= after) shift = 7
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + shift, h, m, 0, 0).getTime()
}

// 近未来每日计划的稳健创建（N 条可共享同一墙钟时刻，T8「多计划同时到点」用双流程）：每轮保存后
// 立即核对每条记录的 occurrence 确在近未来（≤180s）——若负载尖峰仍把 UI 保存推过分钟桶
// （occurrence 落入明日，产品行为本身无异常的纯测试时序问题），成对删除重建一次。两轮都远则
// 带证据失败（不再等 200s 超时才暴露）。自行进出流程编辑器，返回时停在流程清单。
async function createNearFutureDailies(
  page: Page, flows: ReadonlyArray<{ name: string; entryUrl: string }>,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const time = dailyTimeIn(90_000)
    const row = new RegExp(`Daily ${time}|每日 ${time}`)
    for (const flow of flows) {
      await openEditor(page, flow.name)
      await openScheduleCreate(page)
      await fillScheduleForm(page, { kind: 'daily', time, entryUrl: flow.entryUrl })
      await saveScheduleExpectRow(page, row)
      await backToFlows(page, flow.name)
    }
    const records = await peekFlowSchedules(page)
    if (records.length === flows.length && records.every((r) => r.nextDueAt - Date.now() <= 180_000)) return
    if (attempt >= 2) {
      throw new Error(`每日计划 occurrence 两轮均落入远未来（time=${time}，nextDueAt 距今 ${records.map((r) => Math.round((r.nextDueAt - Date.now()) / 1000))}s）`)
    }
    for (const flow of flows) {
      await openEditor(page, flow.name)
      await deleteScheduleViaUi(page, row)
      await backToFlows(page, flow.name)
    }
  }
}

// 单流程近未来每日计划（createNearFutureDailies 的 N=1 形态）
async function createNearFutureDaily(page: Page, flowName: string, entryUrl: string): Promise<void> {
  await createNearFutureDailies(page, [{ name: flowName, entryUrl }])
}

// T8 结果断言：某个 form-page 标签页的指定输入已被填为指定值（两条流程各自执行出的可观察面）
async function expectFormPageFilled(
  context: BrowserContext, selector: string, value: string, timeout: number,
): Promise<void> {
  await expect.poll(async () => {
    for (const p of context.pages()) {
      if (!p.url().includes('/form-page.html')) continue
      if (await p.locator(selector).inputValue().catch(() => '') === value) return true
    }
    return false
  }, { timeout }).toBe(true)
}

async function seedEnabled(page: Page, extensionId: string, flowJson: string, name: string): Promise<void> {
  await openWorkbench(page, extensionId)
  await ackOnboarding(page)
  await seedFlow(page, flowJson)
  await enableFlowFromFlowsTab(page, name)
}

async function openEditor(page: Page, flowName: string): Promise<void> {
  await openFlowsTab(page)
  await flowCardLocation(page, flowName).getByRole('button', { name: /^(View \/ Edit|查看 \/ 编辑)$/ }).click()
  await expect(schedulesCard(page)).toBeVisible({ timeout: 15_000 })
}

async function backToFlows(page: Page, flowName: string): Promise<void> {
  await page.locator('button.sp-back').first().click()
  await expect(flowCardLocation(page, flowName)).toBeVisible({ timeout: 15_000 })
}

// 流程清单失败行（展开后读正文；未展开时 summary 可见即提示存在）
function failureRow(page: Page, flowName: string) {
  return flowCardLocation(page, flowName).locator('details.sp-progress.fail')
}

async function expectNoFailure(page: Page, flowName: string): Promise<void> {
  await expect(failureRow(page, flowName)).toHaveCount(0)
}

test('T1 计划管理：创建/编辑即时重排/删除即时生效/上限拒绝；计划为设备本地记录', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(300_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await seedEnabled(page, extensionId, demoFlowJson(host.origin, {
      name: FLOW, value: 'SCH-ADMIN-001',
    }), FLOW)

    // 场景 1：创建每日计划 → 列表行 + 下一次触发时刻 + 计数
    await openEditor(page, FLOW)
    await openScheduleCreate(page)
    await fillScheduleForm(page, { kind: 'daily', time: '09:41', entryUrl: host.formUrl })
    const createdBefore = Date.now()
    await saveScheduleExpectRow(page, /Daily 09:41|每日 09:41/)
    await expect(schedulesCard(page).locator('p.sp-sub', { hasText: RX_COUNT(1) })).toBeVisible()
    await expect(schedulesCard(page).locator('p.sp-desc', { hasText: RX_NEXT })).toBeVisible()

    // 存储侧等值断言：nextDueAt = 下一个 09:41 墙钟；计划在 local:flowSchedules
    let records = await peekFlowSchedules(page)
    expect(records).toHaveLength(1)
    expect(records[0].flowId).toBe((await getFlows(page)).find((f) => f.name === FLOW)!.id)
    expect(records[0].period).toEqual({ kind: 'daily', time: '09:41' })
    expect(records[0].entryUrl).toBe(host.formUrl)
    expect(records[0].nextDueAt).toBe(nextDailyOccurrence('09:41', createdBefore))

    // 计划不进入流程定义：流程记录序列化后无任何计划字段痕迹
    const flowJson = JSON.stringify((await getFlows(page)).find((f) => f.name === FLOW))
    expect(flowJson).not.toContain('nextDueAt')
    expect(flowJson).not.toContain('entryUrl')

    // 场景 2：编辑为每周一 09:13 → 即时重排（下一次 = 下周一墙钟，历史安排不保留）
    await editScheduleViaUi(page, /Daily 09:41|每日 09:41/)
    await fillScheduleForm(page, { kind: 'weekly', time: '09:13', weekday: 1, entryUrl: host.formUrl })
    const editedBefore = Date.now()
    await saveScheduleExpectRow(page, /Weekly Monday 09:13|每周周一 09:13/)
    records = await peekFlowSchedules(page)
    expect(records).toHaveLength(1)
    expect(records[0].period).toEqual({ kind: 'weekly', weekday: 1, time: '09:13' })
    expect(records[0].nextDueAt).toBe(nextWeeklyOccurrence('09:13', 1, editedBefore))

    // 场景 3：删除即时生效——先建一个近期每日计划，删除后原定时刻零动作
    await deleteScheduleViaUi(page, /Weekly Monday 09:13|每周周一 09:13/)
    await expect(schedulesCard(page).locator('p.sp-sub', { hasText: RX_COUNT(0) })).toBeVisible()
    await createNearFutureDaily(page, FLOW, host.formUrl)
    await openEditor(page, FLOW)
    await deleteScheduleViaUi(page, /Daily |每日 /)
    expect(await peekFlowSchedules(page)).toHaveLength(0)
    // 原定时刻（保存后 ~60-70s）不再产生任何自动执行：静置盖过到点窗口，无开页、无失败行
    await expectNoTabPage(context, '/form-page.html', 100_000)
    await expectNoFailure(page, FLOW)

    // 场景 4：上限拒绝——直写 50 条存量后 UI 创建被拒，既有计划不受影响
    const flowId = (await getFlows(page)).find((f) => f.name === FLOW)!.id
    const farFuture = Date.now() + 365 * 24 * 3_600_000
    await pokeFlowSchedules(page, Array.from({ length: 50 }, (_, i) => ({
      id: `filler-${Date.now()}-${i}`,
      flowId,
      site: host.origin,
      entryUrl: host.formUrl,
      period: { kind: 'interval', minutes: 1440 },
      createdAt: 0,
      updatedAt: 0,
      nextDueAt: farFuture,
    })))
    await backToFlows(page, FLOW)
    await openEditor(page, FLOW)
    await expect(schedulesCard(page).locator('p.sp-sub', { hasText: RX_COUNT(50) })).toBeVisible()
    await openScheduleCreate(page)
    await fillScheduleForm(page, { kind: 'daily', time: '09:41', entryUrl: host.formUrl })
    await saveSchedule(page)
    await expect(schedulesCard(page).locator('p.sp-error[role="alert"]', { hasText: RX_LIMIT }))
      .toBeVisible({ timeout: 15_000 })
    expect(await peekFlowSchedules(page)).toHaveLength(50)
  } finally {
    await host.close()
  }
})

test('T2 到点无匹配页：前台自动打开入口页执行，页面静默，标签页保留', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(330_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await seedEnabled(page, extensionId, demoFlowJson(host.origin, {
      name: FLOW, value: 'SCH-AUTO-777',
    }), FLOW)

    // 每日计划取当前时刻 + ~90s：浏览器内无任何该站点标签页
    await createNearFutureDaily(page, FLOW, host.formUrl)

    // 到点：扩展以前台标签页打开入口网址并在该页执行（US-SCH-002 场景 1）
    const tab = await waitForTabPage(context, '/form-page.html', 220_000)
    await expect(tab.locator('#contactPhone')).toHaveValue('SCH-AUTO-777', { timeout: 30_000 })
    // 前台供给：打开的标签页为活动页（visibilityState 可见）
    expect(await tab.evaluate(() => document.visibilityState)).toBe('visible')
    // 页面静默：运行成功无任何失败/错过提示
    await expectNoFailure(page, FLOW)
    // 运行结束标签页保留（页面即结果证据）
    await tab.waitForTimeout(3_000)
    expect(tab.isClosed()).toBe(false)
  } finally {
    await host.close()
  }
})

test('T3 已有匹配页原地执行；暂停零动作无失败行，恢复后下一次触发执行', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(390_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await seedEnabled(page, extensionId, demoFlowJson(host.origin, {
      name: FLOW, value: 'SCH-INPLACE-001',
    }), FLOW)

    // 间隔 1 分钟计划；到点前先打开入口页标签页
    await openEditor(page, FLOW)
    await openScheduleCreate(page)
    await fillScheduleForm(page, { kind: 'interval', minutes: 1, entryUrl: host.formUrl })
    await saveScheduleExpectRow(page, /Every 1 min|每 1 分钟/)
    await backToFlows(page, FLOW)
    const hostPage = await openHostPage(context, host.formUrl)
    const pagesBefore = context.pages().length

    // 到点：在已打开的匹配标签页内执行，不再新开标签页（US-SCH-002 场景 2）
    await expect(hostPage.locator('#contactPhone')).toHaveValue('SCH-INPLACE-001', { timeout: 150_000 })
    expect(context.pages().length).toBe(pagesBefore)

    // US-SCH-002 场景 3：暂停后下一次到点零动作、不记失败、计划保留
    await flowCardLocation(page, FLOW).getByRole('button', { name: /^(Pause|暂停)$/ }).click()
    await expectFlowStatus(page, FLOW, 'paused')
    await hostPage.locator('#contactPhone').fill('')
    // 下一次 occurrence 在首个之后 ~60s：静置盖过它，输入保持空 = 零页面动作
    await hostPage.waitForTimeout(70_000)
    expect(await hostPage.locator('#contactPhone').inputValue()).toBe('')
    await expectNoFailure(page, FLOW)
    // 计划保留且 nextDueAt 已静默推进到未来 occurrence
    const paused = (await peekFlowSchedules(page))[0]
    expect(paused, '暂停后计划应保留').toBeDefined()
    expect(paused!.nextDueAt).toBeGreaterThan(Date.now())

    // 恢复启用后按后续计划时刻正常触发
    await flowCardLocation(page, FLOW).getByRole('button', { name: /^(Resume|恢复)$/ }).click()
    await expectFlowStatus(page, FLOW, 'enabled')
    await expect(hostPage.locator('#contactPhone')).toHaveValue('SCH-INPLACE-001', { timeout: 150_000 })
    expect(context.pages().length).toBe(pagesBefore)
  } finally {
    await host.close()
  }
})

test('T4 错过：浏览器重启后冷启动裁决出错过提示且不补跑，下一次按计划正常执行并清除提示', async ({
  demoHeadless,
}) => {
  test.setTimeout(390_000)
  const host = await startHostSite()
  // 「浏览器重启」以同一 profile 目录换进程实现：storage.local 落盘留存，alarm/SW 随旧进程
  // 消亡，新进程冷启动执行 reconcile（PRD 场景：浏览器关闭期间到点，之后启动浏览器）
  const profileDir = await mkdtemp(path.join(tmpdir(), 'sch-restart-'))
  const contexts: BrowserContext[] = []
  try {
    // 第一段会话：播种流程、启用、建 5 分钟间隔计划
    const deviceA = await relaunchExtensionOnProfile(profileDir, demoHeadless)
    contexts.push(deviceA.context)
    const sp = await openExtensionPage(deviceA.context, deviceA.extensionId, 'sidepanel')
    autoAcceptDialogs(sp)
    const finalizeA = await attachParticipantLogger(sp, 'us-sch T4 session A')
    await seedEnabled(sp, deviceA.extensionId, demoFlowJson(host.origin, {
      name: FLOW, value: 'SCH-MISS-999',
    }), FLOW)
    await openEditor(sp, FLOW)
    await openScheduleCreate(sp)
    await fillScheduleForm(sp, { kind: 'interval', minutes: 5, entryUrl: host.formUrl })
    await saveScheduleExpectRow(sp, /Every 5 min|每 5 分钟/)

    // 伪造「浏览器关闭期间多次到点」：armed 回拨 8.5 分钟——5 分钟网格落在 -8.5/-3.5 分钟两次
    // occurrence，最新者距今 3.5 分钟 > 120s 宽限窗 → 两次全部错过（不补跑），下一次 = +1.5 分钟
    const [record] = await peekFlowSchedules(sp)
    record.nextDueAt = Date.now() - 8.5 * 60_000
    await pokeFlowSchedules(sp, [record])
    await finalizeA()
    await deviceA.context.close()

    // 浏览器重启（同一 profile 新进程）：用户先访问流程站点（站点内容脚本的
    // ct:getEnabledFlows 是真实唤醒路径——本产品无 onStartup 监听，SW 由站点/消息/事件唤醒）
    const deviceB = await relaunchExtensionOnProfile(profileDir, demoHeadless)
    contexts.push(deviceB.context)
    const wakePage = await openHostPage(deviceB.context, `${host.origin}/other-page.html`)
    const sp2 = await openExtensionPage(deviceB.context, deviceB.extensionId, 'sidepanel')
    const finalizeB = await attachParticipantLogger(sp2, 'us-sch T4 session B')
    await expect(sp2.locator('nav.sp-nav')).toBeVisible({ timeout: 15_000 })
    await openFlowsTab(sp2)

    // 错过提示可见：次数 2× + 最近时刻（US-SCH-003 场景 1/2——关机期间到点与处理过迟同径）
    const failure = failureRow(sp2, FLOW)
    await expect(failure.locator('summary')).toBeVisible({ timeout: 20_000 })
    await failure.locator('summary').click()
    await expect(failure.locator('p')).toContainText(/2× /)

    // 不补跑：错过不产生任何分发——隔离页（other-page 不属流程指纹）零动作、暂存描述符为空
    await wakePage.waitForTimeout(4_000)
    expect(await wakePage.locator('#contactPhone').inputValue()).toBe('')
    expect(await peekPendingTimedStarts(sp2)).toHaveLength(0)

    // 下一次按计划正常触发（重挂的真实 alarm → 无匹配页前台开页执行），成功后清除提示（场景 4）
    const tab = await waitForTabPage(deviceB.context, '/form-page.html', 200_000)
    await expect(tab.locator('#contactPhone')).toHaveValue('SCH-MISS-999', { timeout: 30_000 })
    await expectNoFailure(sp2, FLOW)
    await finalizeB()
  } finally {
    for (const c of contexts) await c.close().catch(() => undefined)
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
    await host.close()
  }
})

test('T5 输入门禁：缺失零页面动作并提示项目，补齐后下一次触发执行', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(480_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await seedEnabled(page, extensionId, timedInputsFlowJson(host.origin, FLOW), FLOW)

    await openEditor(page, FLOW)
    await openScheduleCreate(page)
    await fillScheduleForm(page, { kind: 'interval', minutes: 1, entryUrl: host.formUrl })
    await saveScheduleExpectRow(page, /Every 1 min|每 1 分钟/)
    await backToFlows(page, FLOW)

    // 第一次到点：前台开页但必填未保存 → 零页面动作 + 提示具体缺失项目（US-SCH-003 场景 3）
    const tab = await waitForTabPage(context, '/form-page.html', 200_000)
    await tab.waitForTimeout(6_000)
    expect(await tab.locator('#contactPhone').inputValue()).toBe('')
    const failure = failureRow(page, FLOW)
    await expect(failure.locator('summary')).toBeVisible({ timeout: 15_000 })
    await failure.locator('summary').click()
    await expect(failure.locator('p')).toContainText(RX_INPUT_SKIP)
    await expect(failure.locator('p')).toContainText('联系单号 (orderNo): required-missing')

    // 补齐并保存输入值 → 下一次触发（间隔 1 分钟）在已开标签页内正常执行，成功后清除提示
    await openEditor(page, FLOW)
    await page.locator('#flow-input-orderNo').fill('SCH-INPUT-555')
    await page.getByRole('button', { name: /^(Save inputs|保存输入)$/ }).click()
    await expect(page.locator('.sp-progress', { hasText: RX_INPUT_SAVED })).toBeVisible({ timeout: 15_000 })
    await backToFlows(page, FLOW)
    await expect(tab.locator('#contactPhone')).toHaveValue('SCH-INPUT-555', { timeout: 150_000 })
    await expectNoFailure(page, FLOW)
  } finally {
    await host.close()
  }
})

test('T6 到点页面特征不符：不启动零动作，窗口期满后失败提示说明页面不匹配', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(450_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await seedEnabled(page, extensionId, contentMismatchFlowJson(host.origin, FLOW), FLOW)

    await createNearFutureDaily(page, FLOW, host.formUrl)

    // 到点：入口页被打开，但 content 门禁永不满足 → 不启动、零页面动作（US-SCH-002 场景 4）
    const tab = await waitForTabPage(context, '/form-page.html', 220_000)
    // 60s 分发窗 + janitor 自唤：过期 GC 落 timed-start-expired 提示
    const failure = failureRow(page, FLOW)
    await expect(failure.locator('summary')).toBeVisible({ timeout: 160_000 })
    await failure.locator('summary').click()
    await expect(failure.locator('p')).toContainText(RX_EXPIRED)
    expect(await tab.locator('#contactPhone').inputValue()).toBe('')
  } finally {
    await host.close()
  }
})

test('T7 防重放共用：占用未解除的定时触发跳过可见且零动作；定时与手动并发提交恰一次', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(480_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  const BIZ = 'B-TIMED-001'
  try {
    // 装箱流程（提交类动作 + 业务实例声明）：动作记录可数，是「提交恰一次」的观察面
    await seedEnabled(page, extensionId, packingFlowJson(host.origin, { name: FLOW }), FLOW)
    const flowId = (await getFlows(page)).find((f) => f.name === FLOW)!.id

    // US-SCH-004 场景 1：业务实例占用未解除（直写 session 占用构造「前次运行结果未知」）
    await pokeBusinessClaims(page, [`${host.origin}|${flowId}|${BIZ}`])
    await openEditor(page, FLOW)
    await openScheduleCreate(page)
    await fillScheduleForm(page, { kind: 'interval', minutes: 1, entryUrl: host.packingUrl('ok', 1, BIZ) })
    await saveScheduleExpectRow(page, /Every 1 min|每 1 分钟/)
    await backToFlows(page, FLOW)

    // 到点：开出的装箱页只有页面初始化两条记录（switch:g1 + page-ready），零自动化动作
    const tabA = await waitForTabPage(context, '/packing-page.html', 200_000)
    const firstAt = Date.now()
    await tabA.waitForTimeout(5_000)
    const openedEntries = (await actionLogEntries(tabA)).map((e) => e.slice(13))
    expect(openedEntries).toHaveLength(2)
    // 跳过可见：明确说明业务实例已被占用
    let failure = failureRow(page, FLOW)
    await expect(failure.locator('summary')).toBeVisible({ timeout: 15_000 })
    await failure.locator('summary').click()
    await expect(failure.locator('p')).toContainText(RX_CLAIMED)

    // 场景 2：占用解除后，到点前手动打开同单据入口页触发 pageEnter——手动运行先占住业务实例
    // （成功后占用不解除），下一次到点撞上占用 → 定时跳过，提交类动作总数恰为手动运行的 1 次
    await pokeBusinessClaims(page, [])
    const tabM = await openHostPage(context, host.packingUrl('ok', 1, BIZ))
    await expect(tabM.locator('.preview-modal.visible')).toBeVisible({ timeout: 30_000 })
    const manualEntries = (await actionLogEntries(tabM)).map((e) => e.slice(13))
    expect(manualEntries.filter((e) => e.startsWith('save:'))).toHaveLength(1)
    expect(manualEntries.filter((e) => e === 'confirm')).toHaveLength(1)

    // 下一次 occurrence ≈ firstAt + 60s（间隔网格）：静置盖过到点 + SW 唤醒余量（宽限窗内迟到合法）
    await page.waitForTimeout(Math.max(0, firstAt + 150_000 - Date.now()))
    // 定时触发被跳过：两个标签页都没有第二次提交
    const manualAfter = (await actionLogEntries(tabM)).map((e) => e.slice(13))
    expect(manualAfter.filter((e) => e.startsWith('save:'))).toHaveLength(1)
    expect(manualAfter.filter((e) => e === 'confirm')).toHaveLength(1)
    const openedAfter = (await actionLogEntries(tabA)).map((e) => e.slice(13))
    expect(openedAfter).toHaveLength(2)
    // 跳过原因可见（手动运行成功清除旧提示后，定时占用跳过重写）
    failure = failureRow(page, FLOW)
    await expect(failure.locator('summary')).toBeVisible({ timeout: 15_000 })
    await failure.locator('summary').click()
    await expect(failure.locator('p')).toContainText(RX_CLAIMED)
  } finally {
    await host.close()
  }
})

test('T8 多计划同时到点：各计划独立运行分别执行', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(390_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  const FLOW_A = '定时多计划A'
  const FLOW_B = '定时多计划B'
  try {
    await seedEnabled(page, extensionId, demoFlowJson(host.origin, {
      name: FLOW_A, value: 'PLAN-A-111',
    }), FLOW_A)
    await seedEnabled(page, extensionId, demoFlowJson(host.origin, {
      name: FLOW_B, value: 'PLAN-B-222', field: 'remark',
    }), FLOW_B)

    // 两条计划取同一墙钟时刻（同一次到点）；两次分发的第二页是否复用首开标签页取决于 URL
    // 提交时序——断言按「两条流程各自执行出结果」，不按标签页数量。任一条 occurrence 落远
    // （负载尖峰推过分钟桶）则由 createNearFutureDailies 成对删除重建，保持「同时到点」语义
    await createNearFutureDailies(page, [
      { name: FLOW_A, entryUrl: host.formUrl },
      { name: FLOW_B, entryUrl: host.formUrl },
    ])

    await expectFormPageFilled(context, '#contactPhone', 'PLAN-A-111', 220_000)
    await expectFormPageFilled(context, '#remark', 'PLAN-B-222', 30_000)

    await expectNoFailure(page, FLOW_A)
    await expectNoFailure(page, FLOW_B)
  } finally {
    await host.close()
  }
})

test('T9 计划归属本机：删除流程后计划随之清理，原定时刻零动作', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(240_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await seedEnabled(page, extensionId, demoFlowJson(host.origin, {
      name: FLOW, value: 'SCH-LOCAL-333',
    }), FLOW)

    await createNearFutureDaily(page, FLOW, host.formUrl)
    expect(await peekFlowSchedules(page)).toHaveLength(1)

    // 删除流程（confirm 由 autoAcceptDialogs 接受）→ 本机计划随之清理（US-SCH-005 场景 2）
    await flowCardLocation(page, FLOW).getByRole('button', { name: /^(Delete|删除)$/ }).click()
    await expect(flowCardLocation(page, FLOW)).toHaveCount(0, { timeout: 15_000 })
    expect(await peekFlowSchedules(page)).toHaveLength(0)

    // 原定时刻（保存后 ~60-70s）不再触发：静置盖过到点窗口，无开页
    await expectNoTabPage(context, '/form-page.html', 100_000)
  } finally {
    await host.close()
  }
})

test('T10 定时触发的跨页流程照常续跑：按页序至结果页，防重放与失败可见语义一致', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(420_000)
  const host = await startHostSite()
  autoAcceptDialogs(page)
  const BIZ = 'B-CROSS-777'
  try {
    // 向导三页链（填写 → 确认 → 结果），业务号逐页内建断言；入口 = 第 1 页
    await seedEnabled(page, extensionId, crossPageFlowJson(host.origin, { name: FLOW, biz: BIZ, entry: 1 }), FLOW)

    await createNearFutureDaily(page, FLOW, host.wizardStepUrl(1, { biz: BIZ }))

    // 到点前台开页 → 定时认领（pageEnter 抑制）→ 按页序续跑至结果页 done 标记，同一标签页导航
    let tab: Page
    try {
      tab = await waitForTabPage(context, '/wizard-step1.html', 220_000)
    } catch (error) {
      // 失败诊断：到点未开页时区分「错过/未到点/分发失败」——记录 nextDueAt 相对现在、暂存
      // 描述符、失败行文案与现存页面清单
      const schedules = await peekFlowSchedules(page).catch(() => [])
      const starts = await peekPendingTimedStarts(page).catch(() => [])
      const failText = await failureRow(page, FLOW).locator('p').innerText().catch(() => '(none)')
      const pages = context.pages().map((p) => p.url())
      throw new Error(`T10 到点未开页：nextDueAt(相对s)=${JSON.stringify(schedules.map((r) => Math.round((r.nextDueAt - Date.now()) / 1000)))} pendingStarts=${JSON.stringify(starts)} failure=${failText} pages=${JSON.stringify(pages)}`)
    }
    await expect.poll(() => tab.url(), { timeout: 90_000 }).toContain('/wizard-step3.html')
    await expect(tab.locator('.done-marker')).toBeVisible({ timeout: 30_000 })
    // 双触发（pageEnter 与定时并发）或续跑失败都会留下失败行——成功续跑则零失败行
    await expectNoFailure(page, FLOW)
    expect(tab.isClosed()).toBe(false)
  } finally {
    await host.close()
  }
})
