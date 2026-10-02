import type { BrowserContext, Page } from '@playwright/test'
import { expect, extensionEntryUrl } from './fixtures'

// 故事驱动 helper：同步用户故事用例（stories/us-ds-*.e2e.ts）共用的 UI 驱动原语。
// 断言文案一律 en/zh 双语 regex（lib/i18n.ts 按浏览器 UI 语言选择目录，不依赖运行语言）。

// 把已存在的 page（默认 fixture page，UnifiedLogger 已挂接）导航到 sidepanel 工作台入口；
// 路径取自 manifest.side_panel，不硬编码产物文件名。
export async function openWorkbench(page: Page, extensionId: string): Promise<void> {
  await page.goto(await extensionEntryUrl(extensionId, 'sidepanel'))
}

// UI 大量使用 window.confirm / alert；Playwright 默认 dismiss 会卡断流程。返回的
// dismissOnce() 让取消路径用例临时覆盖一次性 dialog（同页只能有一个 handler 生效）。
export interface DialogControl {
  dismissOnce: () => void
}

export function autoAcceptDialogs(page: Page): DialogControl {
  let nextAction: 'accept' | 'dismiss' | null = null
  page.on('dialog', dialog => {
    const action = nextAction ?? 'accept'
    nextAction = null
    void dialog[action]().catch(() => undefined)
  })
  return {
    dismissOnce: () => {
      nextAction = 'dismiss'
    },
  }
}

// 新 profile 首启 onboarding 声明视图（确认后写入 seen 标记）；已确认过的 profile 无此视图。
// 应用挂载时 onboardingSeen 初始为 null，先渲染 nav，chrome.storage 读回 false 后才整体替换为
// onboarding——首查无确认按钮可能只是命中这个瞬态 nav，需给 onboarding 一个有界出现窗口再
// 复查，超时仍无才认定该 profile 已确认过。
export async function ackOnboarding(page: Page): Promise<void> {
  const onboarding = page.locator('h2.sp-title', { hasText: /^(How to Use|使用说明)$/ })
  await expect(onboarding.or(page.locator('nav.sp-nav'))).toBeVisible({ timeout: 15_000 })
  const ackButton = page.locator('button.sp-btn.primary', { hasText: /^(I have read and understand|我已阅读并理解)$/ })
  if (await ackButton.count() === 0) {
    try {
      await expect(onboarding).toBeVisible({ timeout: 5_000 })
    } catch {
      return
    }
  }
  await ackButton.click()
  await expect(page.locator('nav.sp-nav .sp-tab')).toHaveCount(3)
}

// SyncPanel 的内部视图（spaces/scripts/detail）是组件状态，重复点击「同步」页签不会重置；
// 先切到「流程」再切回，让 SyncPanel 重新挂载、确定性地回到空间视图。
export async function openSyncTab(page: Page): Promise<void> {
  await openFlowsTab(page)
  await page.locator('nav.sp-nav .sp-tab', { hasText: /^(Sync|同步)$/ }).click()
  await expect(page.locator('h2.sp-title', { hasText: /^(Server|服务器)$/ })).toBeVisible()
}

export async function openFlowsTab(page: Page): Promise<void> {
  await page.locator('nav.sp-nav .sp-tab', { hasText: /^(Flows|流程)$/ }).click()
}

// Connect：填写服务器地址并连接（保存 + 探测）。此 helper 断言可达成功，失败时把错误文案
// 带进断言消息。
export async function connectServer(page: Page, origin: string): Promise<void> {
  await page.locator('#sync-server').fill(origin)
  await page.getByRole('button', { name: /^(Connect|连接)$/ }).click()
  const reachable = page.locator('p.sp-hint', { hasText: /^(Server reachable|服务可达)/ })
  const failure = page.locator('p.sp-error')
  await expect(reachable.or(failure)).toBeVisible({ timeout: 35_000 })
  const failureTexts = await failure.allInnerTexts().catch(() => [])
  await expect(reachable, `Connect 未达成可达状态：${failureTexts.join(' | ')}`).toBeVisible()
}

// SyncSpacesView 的 notice（创建/加入/忘记/删除的结果文案）统一以 p.sp-error 渲染（该视图
// 不按成败切类名，成功文案也在此元素上）；只有 serverMsg 与详情视图 notice 按 kind 切类。
export async function createSpaceViaUi(page: Page, name: string): Promise<void> {
  await page.locator('#sync-space-name').fill(name)
  await page.getByRole('button', { name: /^(Create space|创建空间)$/ }).click()
  await expect(page.locator('p.sp-error', { hasText: /created and selected|已创建空间/ }))
    .toBeVisible({ timeout: 15_000 })
  await expect(spaceGroup(page, name)).toBeVisible()
}

export function spaceGroup(page: Page, name: string) {
  return page.locator(`.sp-group[aria-label="${name}"]`)
}

// 空间码读只读输入框 value：headless 下 clipboard-write 不可靠且复制失败被产品静默吞掉，
// 不能以复制按钮为断言路径。
export async function readSpaceCode(page: Page, spaceName: string): Promise<string> {
  return await spaceGroup(page, spaceName).locator('input[readonly]').inputValue()
}

export async function joinSpaceViaUi(page: Page, code: string): Promise<void> {
  await page.locator('#sync-join-code').fill(code)
  await page.getByRole('button', { name: /^(Join|加入)$/ }).click()
  await expect(page.locator('p.sp-error', { hasText: /Joined space|已加入空间/ })).toBeVisible({ timeout: 15_000 })
}

export async function openSpaceScripts(page: Page, spaceName: string): Promise<void> {
  await spaceGroup(page, spaceName).getByRole('button', { name: /^(Scripts|脚本)$/ }).click()
  await expect(page.getByRole('button', { name: /← Back to spaces|← 返回空间清单/ })).toBeVisible()
}

export function scriptCard(page: Page, scriptName: string) {
  return page.locator(`main.sp-main section.sp-card[aria-label="${scriptName}"]`)
}

export async function openScriptDetail(page: Page, scriptName: string): Promise<void> {
  await scriptCard(page, scriptName).getByRole('button', { name: /^(Open details|查看详情)$/ }).click()
  await expect(page.getByRole('button', { name: /← Back to scripts|← 返回脚本清单/ })).toBeVisible()
}

// 保存本机流程为脚本（含「数据离开设备」confirm，由 autoAcceptDialogs 接受）。下拉只列
// 未关联流程，取第一个即可（故事用例的 profile 内流程数量是已知的）。成功文案会被随后的
// 清单刷新立即清除，故断言结果物：脚本卡出现并带 v1 徽标。
export async function uploadFlowAsScript(
  page: Page,
  fields: { scriptName: string; note?: string; versionNote?: string },
): Promise<void> {
  await page.getByRole('button', { name: /^(Save a local flow as a script|把本机流程保存为脚本)$/ }).click()
  await page.locator('#sync-upload-flow').selectOption({ index: 1 })
  await page.locator('#sync-upload-name').fill(fields.scriptName)
  if (fields.note !== undefined) await page.locator('#sync-upload-note').fill(fields.note)
  if (fields.versionNote !== undefined) await page.locator('#sync-upload-vnote').fill(fields.versionNote)
  await page.getByRole('button', { name: /^(Save as script|保存为脚本)$/ }).click()
  const card = scriptCard(page, fields.scriptName)
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(card.locator('.sp-badge', { hasText: /^(Latest v1|最新 v1)$/ })).toBeVisible()
}

// 发布成功文案同样会被刷新清除；断言结果物：新版本入列表且本机固定徽标移至该版本。
export async function publishVersion(page: Page, versionNote: string, expectedVersion: number): Promise<void> {
  await page.locator('#sync-publish-note').fill(versionNote)
  await page.getByRole('button', { name: /^(Publish new version|发布新版本)$/ }).click()
  await expect(versionGroup(page, expectedVersion)).toBeVisible({ timeout: 20_000 })
  await expect(versionGroup(page, expectedVersion).locator('.sp-badge', { hasText: /^(Pinned|本机固定)$/ }))
    .toBeVisible({ timeout: 15_000 })
}

export function versionGroup(page: Page, versionNumber: number) {
  return page.locator(`.sp-group[aria-label="v${versionNumber}"]`)
}

export async function previewVersion(page: Page, versionNumber: number): Promise<void> {
  await versionGroup(page, versionNumber).getByRole('button', { name: /^(Preview summary|查看摘要)$/ }).click()
  await expect(page.locator('section.sp-card h2.sp-title', { hasText: new RegExp(`^v${versionNumber} `) })).toBeVisible()
}

// 拉取（未关联）与切换/回退（已链接同一脚本的其它版本）共用同一数据流；按钮文案随关联
// 状态不同，confirm 文案分 confirmNew / confirmSwitch。成功文案会被刷新清除，断言本机
// 固定徽标落到目标版本。
export async function pullVersion(page: Page, versionNumber: number): Promise<void> {
  await versionGroup(page, versionNumber)
    .getByRole('button', { name: /^(Pull to this device|Switch to this version|拉取到本机|切换到此版本)$/ })
    .click()
  await expect(versionGroup(page, versionNumber).locator('.sp-badge', { hasText: /^(Pinned|本机固定)$/ }))
    .toBeVisible({ timeout: 20_000 })
}

export async function renameScript(page: Page, newName: string): Promise<void> {
  await page.getByRole('button', { name: /^(Rename \/ edit note|修改名称 \/ 备注)$/ }).click()
  await page.locator('#sync-rename-name').fill(newName)
  await page.getByRole('button', { name: /^(Save changes|保存修改)$/ }).click()
  // 结果物断言：详情卡（aria-label 为脚本名）更新为新名称
  await expect(page.locator(`main.sp-main section.sp-card[aria-label="${newName}"]`)).toBeVisible({ timeout: 20_000 })
}

// 故事前置种子流程：导入页的 textarea 流程已移除（流程导入的唯一
// UI 入口是本机通道，e2e 的 CI Chrome 无宿主不可驱动），改在扩展页上下文内发送 sp:saveFlow ——
// 这是编辑器自己的保存通道，走同一套 validateFlow('full') + 单写者存储 + 内容脚本注册。信封
// （id/status/provenance）在此构造，形状对齐 buildImportedFlow 的铸造。调用时 page 必须停在
// 任一扩展页（工作台或导入页均可）。
export async function seedFlow(page: Page, flowJson: string): Promise<void> {
  const draft = JSON.parse(flowJson) as Record<string, unknown>
  const now = Date.now()
  const flow = {
    ...draft,
    id: `r_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    status: 'draft',
    provenance: { source: 'import', importedAt: now, createdAt: now, updatedAt: now },
  }
  const res = await page.evaluate(async (message) => {
    return await (globalThis as any).chrome.runtime.sendMessage(message)
  }, { type: 'sp:saveFlow', flow })
  expect(res, `sp:saveFlow 播种失败：${JSON.stringify(res)}`).toMatchObject({ ok: true })
}

// 读回扩展真实流程清单（sp:getFlows）。与 seedFlow 同一约束：chrome.runtime 仅扩展页可用，
// 调用时 page 必须停在扩展页。返回宽松形状，调用方按需窄化——各用例只声明自己断言的字段。
export async function getFlows(page: Page): Promise<Record<string, any>[]> {
  const res = await page.evaluate(async (message) => {
    return await (globalThis as any).chrome.runtime.sendMessage(message)
  }, { type: 'sp:getFlows' })
  return res.flows as Record<string, any>[]
}

export function flowCardLocation(page: Page, flowName: string) {
  return page.locator(
    `main.sp-main section.sp-card[aria-label="Flow ${flowName}"], main.sp-main section.sp-card[aria-label="流程 ${flowName}"]`,
  )
}

// 流程视图启用（本人点击；alert 等对话框由 autoAcceptDialogs 接受）。
export async function enableFlowFromFlowsTab(page: Page, flowName: string): Promise<void> {
  await openFlowsTab(page)
  const card = flowCardLocation(page, flowName)
  await card.getByRole('button', { name: /^(Enable|启用)$/ }).click()
  await expect(card.locator('.sp-badge', { hasText: /^(Enabled|已启用)$/ })).toBeVisible({ timeout: 15_000 })
}

export async function expectFlowStatus(page: Page, flowName: string, status: 'draft' | 'enabled' | 'paused'): Promise<void> {
  await openFlowsTab(page)
  const labels = { draft: /^(Not enabled|未启用)$/, enabled: /^(Enabled|已启用)$/, paused: /^(Paused|已暂停)$/ }
  await expect(flowCardLocation(page, flowName).locator('.sp-badge', { hasText: labels[status] })).toBeVisible()
}

// 流程编辑器改名：flowDraftHash 含 name，改名即构成「本机已修改未发布」的内容变化。
export async function renameFlowViaEditor(page: Page, flowName: string, newName: string): Promise<void> {
  await openFlowsTab(page)
  await flowCardLocation(page, flowName).getByRole('button', { name: /^(View \/ Edit|查看 \/ 编辑)$/ }).click()
  await page.locator('#flow-name').fill(newName)
  await page.getByRole('button', { name: /^(Save|保存)$/ }).click()
  await expect(flowCardLocation(page, newName)).toBeVisible({ timeout: 15_000 })
}

export async function openHostPage(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(url)
  return page
}

export function expectHostPhoneFilled(page: Page, value: string, timeout: number = 15_000): Promise<void> {
  return expect(page.locator('#contactPhone')).toHaveValue(value, { timeout })
}

// demo 流程 JSON（schemaVersion 1 流程）：进入 form-page.html 即把 #contactPhone 填为常量值。
// 值用 7+ 位电话样式，兼证脱敏展示。导入校验会重写 envelope（id/status/provenance），故只需
// 内容字段；无提交类动作，无需 businessKey。
export function demoFlowJson(site: string, opts: { name?: string; value: string }): string {
  return JSON.stringify({
    schemaVersion: 1,
    name: opts.name ?? `Demo flow ${opts.value.slice(0, 3)}`,
    site,
    page: { urlIncludes: '/form-page.html' },
    trigger: { kind: 'pageEnter' },
    steps: {
      id: 'root',
      kind: 'sequence',
      steps: [
        {
          id: 'fill-phone',
          kind: 'action',
          action: {
            type: 'setInputValue',
            target: { clues: { id: 'contactPhone' }, componentType: 'input', displayLabel: '联系电话' },
            value: opts.value,
          },
        },
      ],
    },
  })
}

// 装箱流程（US-SSBA-010 受控验收形态）：读组集合 → 逐组（within 作用域）切换页签并确认
// 激活 → 未编辑则点编辑并等编辑态 → 未全选则勾选 → 自动加载 → 等行数据稳定 → 断言全有限正数 →
// 保存并等「已保存」完成信号 → 全部组后确认一次 → 等货件预览。含提交类动作 → 声明 businessKey
// （#orderNo 单据号，G1 假设的受控替身），同业务实例会话内只执行一次。
export function packingFlowJson(site: string, opts: { name?: string; timeoutMs?: number } = {}): string {
  const timeoutMs = opts.timeoutMs ?? 5000
  const tab = (within?: string) => ({
    clues: { cssPath: '.group-tab' }, componentType: 'other', displayLabel: '包装组页签', ...(within ? { within } : {}),
  })
  const scoped = (cssPath: string, componentType: 'button' | 'other' | 'checkbox', displayLabel: string) => ({
    clues: { cssPath }, componentType, displayLabel, within: 'group',
  })
  const rowsRead = {
    kind: 'rows' as const,
    table: { clues: { cssPath: 'tbody' }, componentType: 'other' as const, displayLabel: '装箱行', within: 'group' },
    columns: ['weight', 'length', 'width', 'height'],
  }
  return JSON.stringify({
    schemaVersion: 1,
    name: opts.name ?? '装箱流程',
    site,
    page: { urlIncludes: '/packing-page.html' },
    trigger: { kind: 'pageEnter' },
    businessKey: { read: { kind: 'scalar', target: { clues: { id: 'orderNo' }, componentType: 'input', displayLabel: '单据号' } } },
    budget: { waitMs: 10000, runMs: 300000 },
    steps: {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'read-groups', kind: 'read', read: { kind: 'collection', target: tab() }, into: 'groups' },
        {
          id: 'per-group', kind: 'foreach', over: 'vars.groups', itemVar: 'group', maxIterations: 20, do: [
            { id: 'switch', kind: 'action', action: { type: 'clickButton', target: tab('group') } },
            {
              id: 'active', kind: 'wait', timeoutMs,
              until: {
                kind: 'readMatches', read: { kind: 'boolean', target: tab('group') }, into: 'tabActive',
                when: { kind: 'boolean', ref: 'vars.tabActive', equals: true },
              },
            },
            { id: 'edit-state', kind: 'read', read: { kind: 'boolean', target: scoped('.autoload-btn', 'other', '自动加载箱规') }, into: 'editing' },
            {
              id: 'need-edit', kind: 'if', when: { kind: 'boolean', ref: 'vars.editing', equals: false }, then: [
                { id: 'click-edit', kind: 'action', action: { type: 'clickButton', target: scoped('.edit-btn', 'button', '编 辑') } },
                { id: 'wait-edit', kind: 'wait', timeoutMs, until: { kind: 'elementPresent', target: scoped('.autoload-btn', 'other', '自动加载箱规') } },
              ],
            },
            { id: 'sel-state', kind: 'read', read: { kind: 'boolean', target: scoped('.select-all', 'checkbox', '全选') }, into: 'selected' },
            {
              id: 'need-select', kind: 'if', when: { kind: 'boolean', ref: 'vars.selected', equals: false }, then: [
                { id: 'click-select', kind: 'action', action: { type: 'setCheckbox', checked: true, target: scoped('.select-all', 'checkbox', '全选') } },
              ],
            },
            { id: 'auto-load', kind: 'action', action: { type: 'clickButton', target: scoped('.autoload-btn', 'button', '自动加载箱规') } },
            {
              id: 'stable', kind: 'wait', timeoutMs,
              until: { kind: 'readMatches', read: rowsRead, into: 'rows', when: { kind: 'nonEmpty', ref: 'vars.rows' } },
            },
            { id: 'read-rows', kind: 'read', read: rowsRead, into: 'rows' },
            {
              id: 'assert-rows', kind: 'assert',
              check: {
                kind: 'and', parts: [
                  { kind: 'nonEmpty', ref: 'vars.rows' },
                  {
                    kind: 'every', ref: 'vars.rows',
                    item: {
                      kind: 'and', parts: ['weight', 'length', 'width', 'height'].map(col => (
                        { kind: 'numberCompare', ref: `item.${col}`, op: '>' as const, value: 0 }
                      )),
                    },
                  },
                ],
              },
            },
            { id: 'save', kind: 'action', action: { type: 'clickButton', submitLike: true, target: scoped('.save-btn', 'button', '保 存') } },
            { id: 'saved', kind: 'wait', timeoutMs, until: { kind: 'elementPresent', target: scoped('.save-status', 'other', '保存完成信号') } },
          ],
        },
        { id: 'confirm', kind: 'action', action: { type: 'clickButton', submitLike: true, target: { clues: { cssPath: '.confirm-btn' }, componentType: 'button', displayLabel: '确定并装箱' } } },
        { id: 'preview', kind: 'wait', timeoutMs, until: { kind: 'elementPresent', target: { clues: { cssPath: '.preview-modal' }, componentType: 'other', displayLabel: '货件预览' } } },
      ],
    },
  })
}

// 测试页动作记录约定（packing-page / wizard-step* 共用）：动作写入本页 #action-log（每条一
// li，行格式 "HH:MM:SS.mmm text"，前缀固定 13 字符 = 12 时间 + 1 空格）；#action-log 每页独
// 立，跨页跳转后旧页记录随 document 消失——存活页（源页/新标签页）的记录可稳定断言，已离开
// 的页改用 URL/终态断言。
export function actionLogEntries(page: Page): Promise<string[]> {
  return page.locator('#action-log li').allInnerTexts()
}

export async function expectActionLogSequence(page: Page, entries: string[]): Promise<void> {
  await expect
    .poll(async () => (await actionLogEntries(page)).map(e => e.slice(13)), { timeout: 20_000 })
    .toEqual(entries)
}

// packing-page 动作记录断言：页面加载时会预激活首组（记录一条 switch:g1），断言一律用完整序列
export function packingLogEntries(page: Page): Promise<string[]> {
  return actionLogEntries(page)
}

export async function expectPackingLogSequence(page: Page, entries: string[]): Promise<void> {
  await expectActionLogSequence(page, entries)
}

export async function expectPackingPreviewVisible(page: Page): Promise<void> {
  await expect(page.locator('.preview-modal.visible')).toBeVisible({ timeout: 15_000 })
}

export async function expectPackingPreviewHidden(page: Page): Promise<void> {
  await expect(page.locator('.preview-modal.visible')).toHaveCount(0)
}

// 经扩展页读 session 存储（chrome.storage.session 只对可信上下文开放，sidepanel 可读）：
// 跨页用例用来直接观察移交「暂存 → 认领」的内部状态，是页面可观测面之外的补充证据，
// 不替代页面侧断言。调用时 page 必须停在扩展页。
export async function peekSessionStore(page: Page, key: string): Promise<unknown> {
  return await page.evaluate(async (k) => {
    const store = (globalThis as any).chrome?.storage?.session
    if (!store) throw new Error('当前页不是扩展页（chrome.storage.session 不可用）')
    const values = await store.get(k)
    return values[k]
  }, key)
}

// 在途移交条数（pendingHandovers 是数组，空数组为 truthy——不能用真值断言观察清空）
export async function countPendingHandovers(page: Page): Promise<number> {
  const value = await peekSessionStore(page, 'pendingHandovers')
  return Array.isArray(value) ? value.length : 0
}

// 跨页向导流程（crossPageFlowJson）在入口页填写、并经表单字段带到确认页的值
const wizardCarrier = '顺丰速运'
const wizardRemark = '易碎品，轻拿轻放'

// 流程自身提交后确认页的完整查询串（业务号 + 两处填写经表单字段回显）：预开竞争标签页时
// 用它构造与流程自身到达等价的声明页 URL（缺参数的到达会在确认页断言上失败，混淆归因）
export function wizardConfirmPageQuery(biz: string): string {
  return new URLSearchParams({ orderNo: biz, carrier: wizardCarrier, remark: wizardRemark }).toString()
}

// 跨页流程（US-CPF-001 受控验收形态，向导三页）：entry=1 为三页链（填写→确认→结果），entry=2
// 为两页链（确认→结果，供新标签页/超时/取消等机制场景从确认页进入）。业务号断言逐页内建于
// 流程（read + assert 字面量 equals）——跨页数据延续由运行本身验证，任一页失败都会在侧栏留下
// 失败通知，被用例的「无失败通知」断言捕获；结果页声明页指纹带 contentIncludes（.done-marker
// 唯一可见 = 就绪信号，慢加载场景下认领自然等待）。failAfterResume 在最后一页追加必失败的
// 等待：取消/单胜者场景据此区分「续跑发生」（出现失败通知）与「续跑未发生」（静默）。
export function crossPageFlowJson(site: string, opts: {
  name?: string
  biz: string
  entry?: 1 | 2
  navTimeoutMs?: number
  failAfterResume?: boolean
}): string {
  const navTimeoutMs = opts.navTimeoutMs ?? 8000
  const orderNoTarget = { clues: { id: 'orderNo' }, componentType: 'input', displayLabel: '单据号' }
  const doneMarker = { clues: { cssPath: '.done-marker' }, componentType: 'other', displayLabel: '提交完成标记' }
  const resultPage = {
    id: 'result',
    page: { urlIncludes: '/wizard-step3.html', contentIncludes: [doneMarker] },
  }
  const readBiz = (id: string, into: string) => ({
    id, kind: 'read', read: { kind: 'scalar', target: orderNoTarget }, into,
  })
  const assertBiz = (id: string, ref: string) => ({
    id, kind: 'assert', check: { kind: 'equals', ref, value: opts.biz },
  })
  // 入口页业务号校验是两条链的共同头：entry=1 的填写链从它开始，entry=2 从确认页进入时同样先复核
  const entryCheck = [readBiz('read-biz', 'orderNo'), assertBiz('assert-biz', 'vars.orderNo')]
  // 每页动作与业务号断言（故事场景 1）：填写在入口页，确认页复核业务号 + 回显，
  // 结果页等待终态标记后复核业务号
  const entry1Steps = [
    ...entryCheck,
    {
      id: 'fill-carrier', kind: 'action',
      action: { type: 'setInputValue', target: { clues: { id: 'carrier' }, componentType: 'input', displayLabel: '承运商' }, value: wizardCarrier },
    },
    {
      id: 'fill-remark', kind: 'action',
      action: { type: 'setInputValue', target: { clues: { id: 'remark' }, componentType: 'input', displayLabel: '备注' }, value: wizardRemark },
    },
    {
      id: 'submit', kind: 'action',
      action: { type: 'clickButton', submitLike: true, target: { clues: { cssPath: '.submit-btn' }, componentType: 'button', displayLabel: '提 交' } },
    },
    { id: 'nav-confirm', kind: 'navigate', to: 'confirm', timeoutMs: navTimeoutMs },
    readBiz('read-biz-confirm', 'confirmBiz'),
    assertBiz('assert-biz-confirm', 'vars.confirmBiz'),
    {
      id: 'read-carrier-view', kind: 'read',
      read: { kind: 'scalar', target: { clues: { id: 'carrierView' }, componentType: 'other', displayLabel: '承运商回显' } },
      into: 'carrierSeen',
    },
    { id: 'assert-carrier', kind: 'assert', check: { kind: 'equals', ref: 'vars.carrierSeen', value: wizardCarrier } },
  ]
  const confirmClick = {
    id: 'confirm', kind: 'action',
    action: { type: 'clickButton', submitLike: true, target: { clues: { cssPath: '.confirm-btn' }, componentType: 'button', displayLabel: '确认并继续' } },
  }
  const tailSteps = [
    { id: 'wait-done', kind: 'wait', timeoutMs: navTimeoutMs, until: { kind: 'elementPresent', target: doneMarker } },
    readBiz('read-biz-result', 'resultBiz'),
    assertBiz('assert-biz-result', 'vars.resultBiz'),
    ...(opts.failAfterResume ? [{
      id: 'wait-final-signal', kind: 'wait', timeoutMs: 2500,
      until: { kind: 'elementPresent', target: { clues: { cssPath: '.cpf-no-such-signal' }, componentType: 'other', displayLabel: '终态信号（受控缺失）' } },
    }] : []),
  ]
  return JSON.stringify({
    schemaVersion: 1,
    name: opts.name ?? '跨页向导流程',
    site,
    page: { urlIncludes: opts.entry === 2 ? '/wizard-step2.html' : '/wizard-step1.html' },
    trigger: { kind: 'pageEnter' },
    businessKey: { read: { kind: 'scalar', target: orderNoTarget } },
    budget: { waitMs: 10000, runMs: 300000 },
    pages: opts.entry === 2 ? [resultPage] : [{ id: 'confirm', page: { urlIncludes: '/wizard-step2.html' } }, resultPage],
    steps: {
      id: 'root',
      kind: 'sequence',
      steps: [
        ...(opts.entry === 2 ? entryCheck : entry1Steps),
        confirmClick,
        { id: 'nav-result', kind: 'navigate', to: 'result', timeoutMs: navTimeoutMs },
        ...tailSteps,
      ],
    },
  })
}
