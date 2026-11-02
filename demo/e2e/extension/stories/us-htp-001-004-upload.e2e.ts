import { expect, extensionEntryUrl, test } from '../fixtures'
import type { Page } from '@playwright/test'
import { startHostSite, type HostSite } from '../host-site'
import {
  expectUploadCount, startUploadReceiver, UPLOAD_RECEIPT_TOKEN, waitUploadRequest, type UploadReceiver,
} from '../upload-receiver'
import { SyncServer, freePort } from '../sync-server'
import { launchParticipant, type Participant } from '../participant'
import {
  ackOnboarding, autoAcceptDialogs, connectServer, createSpaceViaUi, enableFlowFromFlowsTab,
  expectFlowStatus, expectHostPhoneFilled, expectNoFailure, failureRow, flowCardLocation, getFlows,
  joinSpaceViaUi, openFlowsTab, openHostPage, openScriptDetail, openSpaceScripts, openSyncTab,
  openWorkbench, pokeBusinessClaims, previewVersion, pullVersion, readSpaceCode, saveUploadCredential,
  savedFlowCard, seedFlow, uploadFlowAsScript,
} from '../workbench'
import { nativeTest, pingUntilReady, runClient, saveFlowViaNative } from '../native-host'

// US-HTP-001~004（support-http）真实浏览器故事：声明与摘要显著可见 / 运行时上报按服务端结果
// 继续 / 本机具名凭据 / 拉取端可见性与设备 B 凭据边界——映射 PRD §5.2 目标 1~4（目标 5 披露
// 材料为人工核对项，不做 e2e）。全程真实链路：本机通道交付（T1）→ Settings 凭据卡真实表单 →
// 启用 → 受控页「采集→上报→捕获→断言」；上报目的地为本地 https 接收端（自签证书，由
// fixtures.ts 启动参数放行）。
// 预演/自动执行同 actor 真实发送（DEC-006）——故事不加副作用桩；upload-payload-too-large 与
// input-missing 不入 e2e（分别由 Vitest 与既有输入门禁覆盖）。断言文案一律 en/zh 双语 regex。

const CRED_NAME = '我的上报服务器'
const CRED_VALUE = 'Bearer ow-htp-demo-a'
// 设备 B 自己录入的值：接收端头里出现 B 的值而非 A 的值，即「值设备本机」的直接证据
const CRED_VALUE_B = 'Bearer ow-htp-demo-b'

const RX_NOT_ENABLED = /^(Not enabled|未启用)$/
const RX_EGRESS = /Sends data out|会外发数据/
const RX_EGRESS_WARN = /sends page data to the destination|会把页面数据发往/
const RX_CRED_MISSING = /is not saved on this device|本机未保存上报凭据/
const RX_STATUS_500 = /Upload rejected by the server \(HTTP 500\)|上报被服务器拒绝（HTTP 500）/
const RX_NETWORK = /destination unreachable|目的地不可达/
const RX_TIMEOUT = /timed out|等待超时/
const RX_TOO_LARGE = /response exceeded the capture limit|响应超过捕获上限/

// 受控表单页上报流程（US-HTP-002 主形态）：填联系电话 → 采集 → POST 上报（引用 vars.phone +
// 常量 source，可选凭据引用名 / capture / 末位回执断言）。无提交类动作；不声明 businessKey
// （业务占用只覆盖含提交类动作或声明 businessKey 的流程，纯上报流程不占用）。
interface UploadFlowOpts {
  name: string
  url: string
  phone: string
  credential?: string
  capture?: boolean
  finalAssert?: boolean
  timeoutMs?: number
}

function uploadFlowJson(site: string, opts: UploadFlowOpts): string {
  const steps: unknown[] = [
    {
      id: 'fill-phone', kind: 'action',
      action: {
        type: 'setInputValue',
        target: { clues: { id: 'contactPhone' }, componentType: 'input', displayLabel: '联系电话' },
        value: opts.phone,
      },
    },
    {
      id: 'read-phone', kind: 'read',
      read: { kind: 'scalar', target: { clues: { id: 'contactPhone' }, componentType: 'input', displayLabel: '联系电话' } },
      into: 'phone',
    },
    {
      id: 'u1', kind: 'upload', url: opts.url, method: 'POST', timeoutMs: opts.timeoutMs ?? 8_000,
      ...(opts.credential !== undefined ? { credential: opts.credential } : {}),
      payload: { phone: { ref: 'vars.phone' }, source: 'htp-demo' },
      ...(opts.capture ? { capture: { into: 'receipt' } } : {}),
    },
  ]
  if (opts.finalAssert) {
    steps.push({ id: 'assert-receipt', kind: 'assert', check: { kind: 'equals', ref: 'vars.receipt', value: UPLOAD_RECEIPT_TOKEN } })
  }
  return JSON.stringify({
    schemaVersion: 1,
    name: opts.name,
    site,
    page: { urlIncludes: '/form-page.html' },
    trigger: { kind: 'pageEnter' },
    steps: { id: 'root', kind: 'sequence', steps },
  })
}

// 占用防重放形态（PRD 目标 2「占用未解除即跳过」）：入口为向导第 1 页（?biz= 预填 #orderNo），
// 声明 businessKey（读 #orderNo）且含 upload，满足业务占用条件（needsBusinessClaim：
// 提交类动作 ∨ 声明 businessKey 的上报）。
function occupiedUploadFlowJson(site: string, opts: { name: string; url: string; credential?: string }): string {
  const orderNo = { clues: { id: 'orderNo' }, componentType: 'input', displayLabel: '单据号' }
  return JSON.stringify({
    schemaVersion: 1,
    name: opts.name,
    site,
    page: { urlIncludes: '/wizard-step1.html' },
    trigger: { kind: 'pageEnter' },
    businessKey: { read: { kind: 'scalar', target: orderNo } },
    steps: {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'read-biz', kind: 'read', read: { kind: 'scalar', target: orderNo }, into: 'biz' },
        {
          id: 'u1', kind: 'upload', url: opts.url, method: 'POST', timeoutMs: 8_000,
          ...(opts.credential !== undefined ? { credential: opts.credential } : {}),
          payload: { biz: { ref: 'vars.biz' } },
        },
      ],
    },
  })
}

async function expectUploadFailure(page: Page, flowName: string, reason: RegExp): Promise<void> {
  const failure = failureRow(page, flowName)
  await expect(failure.locator('summary')).toBeVisible({ timeout: 25_000 })
  await failure.locator('summary').click()
  await expect(failure.locator('p')).toContainText('u1')
  await expect(failure.locator('p')).toContainText(reason)
}

// T3 单场景闭环：播种 → 启用 → 受控页执行 → 失败行（节点 + reason）→ 接收端计数恰为预期且
// 静置后不再增长（无自动重试）→ 暂停收尾。五个失败场景共用；受控页电话已填证明上报前的页面
// 步骤确已执行（保守中止只中止后续，不回滚已发生操作）。
async function runFailureScenario(
  page: Page, host: HostSite, receiver: UploadReceiver, opts: {
    flow: UploadFlowOpts
    reason: RegExp
    receiverPath: string
    expectedCount: number
  },
): Promise<void> {
  const flowName = opts.flow.name
  await seedFlow(page, uploadFlowJson(host.origin, opts.flow))
  await enableFlowFromFlowsTab(page, flowName)
  const tab = await openHostPage(page.context(), host.formUrl)
  try {
    await expectHostPhoneFilled(tab, opts.flow.phone)
    await expectUploadFailure(page, flowName, opts.reason)
    await expectUploadCount(receiver, opts.receiverPath, opts.expectedCount)
    // 无自动重试：失败可见后静置，到达数不再增长
    await page.waitForTimeout(3_000)
    await expectUploadCount(receiver, opts.receiverPath, opts.expectedCount)
  } finally {
    await tab.close()
  }
  // 暂停收尾（失败行断言刚在流程清单内完成，侧栏仍在流程页签）
  await flowCardLocation(page, flowName).getByRole('button', { name: /^(Pause|暂停)$/ }).click()
  await expectFlowStatus(page, flowName, 'paused')
}

nativeTest('T1 声明与摘要：本机交付含 upload 流程，摘要/清单外发标注显著，http 目的地整体拒绝', async ({ page, extensionId }) => {
  test.setTimeout(150_000)
  const host = await startHostSite()
  const receiver = await startUploadReceiver()
  try {
    await pingUntilReady()
    const flowName = '上报声明流程'
    const flowJson = uploadFlowJson(host.origin, {
      name: flowName, url: receiver.createdUrl, phone: '13800001201', credential: CRED_NAME, capture: true,
    })

    // 本机校验摘要显式携带外发标志与未掩码目的地（外发可见性须贯通到 AI 可见的校验摘要）
    const validate = runClient(['flow.validate', '--text', flowJson]).result
    expect(validate.ok).toBe(true)
    const steps = validate.data.steps as { text: string; egress?: boolean; egressUrl?: string }[]
    const uploadStep = steps.find(s => s.egress === true)
    expect(uploadStep, '校验摘要应含 egress 步骤').toBeDefined()
    expect(uploadStep!.egressUrl).toBe(receiver.createdUrl)
    expect(uploadStep!.text).toContain(CRED_NAME)
    expect(steps.every(s => s.egress !== true || s === uploadStep)).toBe(true)

    // 本机保存 → 落为未启用（US-HTP-001 场景 3：保存后默认未启用）
    const save = saveFlowViaNative(flowJson)
    expect(save.result.ok).toBe(true)
    expect(save.result.data).toMatchObject({ status: 'draft', replayed: false })

    // 导入页摘要卡：upload 行徽标 + 目的地原样（多数字 URL 不经掩码）+ 凭据引用名可见
    await page.goto(await extensionEntryUrl(extensionId, 'import'))
    const card = savedFlowCard(page)
    await expect(card).toBeVisible()
    await expect(card.locator('.im-badge', { hasText: RX_NOT_ENABLED }).first()).toBeVisible()
    const uploadLine = card.locator('li.im-action-item', { hasText: 'upload' })
    await expect(uploadLine.locator('.im-badge.egress')).toBeVisible()
    await expect(uploadLine.locator('.im-egress-url')).toHaveText(receiver.createdUrl)
    await expect(uploadLine).toContainText(CRED_NAME)
    // 非 upload 行零外发徽标：整卡 egress 徽标恰 1
    await expect(card.locator('.im-badge.egress')).toHaveCount(1)

    // 导入页流程清单行（带直达启用切换）：同一外发徽标（FR4 清单口径）
    const listRow = page.locator('.im-list-item', { hasText: flowName })
    await expect(listRow.locator('.im-badge.egress')).toBeVisible()

    // http 明文目的地整体拒绝且 reason 提示 https（US-HTP-001 场景 2 / 目标 4 e2e 面）；
    // 同一流程仅 url 换为 http，保证被拒原因是目的地而非其它字段
    const httpUrl = `http://${receiver.origin.replace('https://', '')}/created`
    const httpFlow = uploadFlowJson(host.origin, {
      name: 'http 目的地流程', url: httpUrl, phone: '1', credential: CRED_NAME,
    })
    const rejected = runClient(['flow.validate', '--text', httpFlow]).result
    expect(rejected.ok).toBe(false)
    expect(JSON.stringify(rejected.error)).toContain('https')
    const rejectedSave = runClient(['flow.save', '--text', httpFlow]).result
    expect(rejectedSave.ok).toBe(false)
    expect(JSON.stringify(rejectedSave.error)).toContain('https')
    // 被拒交付零写入：本机仍只有已保存的 1 条流程
    const flows = await getFlows(page) as { name: string }[]
    expect(flows.map(f => f.name)).toEqual([flowName])
  } finally {
    await receiver.close()
    await host.close()
  }
})

test('T2 成功闭环：录入凭据→启用→采集→上报→捕获→断言；接收端收到与声明一致的请求', async ({ page, context, extensionId }) => {
  test.setTimeout(180_000)
  const host = await startHostSite()
  const receiver = await startUploadReceiver()
  autoAcceptDialogs(page)
  const flowName = '上报闭环流程'
  const phone = '13800001202'
  try {
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)

    // Settings 凭据卡真实表单录入（列表不回显值）
    await saveUploadCredential(page, { name: CRED_NAME, value: CRED_VALUE })
    await openFlowsTab(page)

    await seedFlow(page, uploadFlowJson(host.origin, {
      name: flowName, url: receiver.collectUrl, phone, credential: CRED_NAME, capture: true, finalAssert: true,
    }))
    // 侧栏流程清单常设外发徽标（FR4）
    await expect(flowCardLocation(page, flowName).locator('.sp-badge', { hasText: RX_EGRESS })).toBeVisible()
    await enableFlowFromFlowsTab(page, flowName)

    // 受控页「采集→上报→捕获→断言」：静默执行，页面结果即证据
    const tab = await openHostPage(context, host.formUrl)
    await expectHostPhoneFilled(tab, phone)

    // 接收端记录与流程声明一致：方法/URL/单凭据头/JSON 体 = 页面采集值 + 常量
    const record = await waitUploadRequest(receiver, '/collect')
    expect(record.method).toBe('POST')
    expect(record.url).toBe(receiver.collectUrl)
    expect(record.headers.authorization).toBe(CRED_VALUE)
    expect(record.headers['content-type']).toContain('application/json')
    expect(JSON.parse(record.body)).toEqual({ phone, source: 'htp-demo' })

    // 捕获槽位被后续断言消费（assert equals 回执 token）且恰一次上报、无失败行
    await page.waitForTimeout(1_500)
    await expectNoFailure(page, flowName)
    await expectUploadCount(receiver, '/collect', 1)
    await tab.close()
  } finally {
    await receiver.close()
    await host.close()
  }
})

test('T3 失败五场景保守中止可见、零外发/无重试计数正确；占用未解除跳过零上报', async ({ page, context, extensionId }) => {
  test.setTimeout(330_000)
  const host = await startHostSite()
  const receiver = await startUploadReceiver()
  autoAcceptDialogs(page)
  try {
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    // 除「凭据缺失」外各场景都引用已录入凭据（单头在场由 T2 断言，此处聚焦失败分类）
    await saveUploadCredential(page, { name: CRED_NAME, value: CRED_VALUE })

    // 场景 1 非 2xx：/error 500 → upload-status，detail=状态码，恰 1 次请求
    await runFailureScenario(page, host, receiver, {
      flow: { name: '上报失败-非2xx', url: receiver.errorUrl, phone: '13800001301', credential: CRED_NAME },
      reason: RX_STATUS_500,
      receiverPath: '/error',
      expectedCount: 1,
    })

    // 场景 2 等待超时：/slow 延迟 8s > timeoutMs 2s → upload-timeout；请求已发出（计数 1）不重试
    await runFailureScenario(page, host, receiver, {
      flow: { name: '上报失败-超时', url: receiver.slowUrl, phone: '13800001302', credential: CRED_NAME, timeoutMs: 2_000 },
      reason: RX_TIMEOUT,
      receiverPath: '/slow',
      expectedCount: 1,
    })

    // 场景 3 响应超限：/huge 响应体 > 64 KiB 且声明 capture → upload-response-too-large，不截断续用
    await runFailureScenario(page, host, receiver, {
      flow: { name: '上报失败-响应超限', url: receiver.hugeUrl, phone: '13800001303', credential: CRED_NAME, capture: true },
      reason: RX_TOO_LARGE,
      receiverPath: '/huge',
      expectedCount: 1,
    })

    // 场景 4 网络不可达：关闭端口上的 https 端点 → upload-network（detail=目的地）
    const deadPort = await freePort()
    await runFailureScenario(page, host, receiver, {
      flow: { name: '上报失败-不可达', url: `https://127.0.0.1:${deadPort}/collect`, phone: '13800001304', credential: CRED_NAME },
      reason: RX_NETWORK,
      receiverPath: '/created',
      expectedCount: 0,
    })

    // 场景 5 凭据缺失：引用未录入凭据 → 保守中止提示具体凭据名，零外发（/collect 计数 0）
    await runFailureScenario(page, host, receiver, {
      flow: { name: '上报失败-凭据缺失', url: receiver.collectUrl, phone: '13800001305', credential: '未录入的服务器凭据' },
      reason: RX_CRED_MISSING,
      receiverPath: '/collect',
      expectedCount: 0,
    })
    await expect(failureRow(page, '上报失败-凭据缺失').locator('p')).toContainText('未录入的服务器凭据')

    // 场景 6 占用未解除：声明 businessKey 的 upload 流程撞上既有占用 → 跳过、零上报、零页面动作。
    // pageEnter 的占用跳过按噪音治理保持页面静默（content.ts：仅无人值守的定时触发上报跳过
    // 可见），可观察面是「零上报 + 零页面动作 + 无失败行」
    const occName = '上报占用防重'
    await seedFlow(page, occupiedUploadFlowJson(host.origin, { name: occName, url: receiver.collectUrl, credential: CRED_NAME }))
    const occId = (await getFlows(page)).find(f => f.name === occName)!.id
    const biz = 'B-HTP-OCC-001'
    await pokeBusinessClaims(page, [`${host.origin}|${occId}|${biz}`])
    await enableFlowFromFlowsTab(page, occName)
    const tab = await openHostPage(context, host.wizardStepUrl(1, { biz }))
    // 静置盖过触发窗口：零上报（凭据缺失场景的 0 计数保持）、零页面动作（仍停在第 1 页）、无失败行
    await tab.waitForTimeout(6_000)
    await expectUploadCount(receiver, '/collect', 0)
    await expect(tab).toHaveURL(/wizard-step1\.html/)
    await expectNoFailure(page, occName)
    await tab.close()
  } finally {
    await receiver.close()
    await host.close()
  }
})

test('T4 拉取端可见性与设备 B：预览外发标注，同步不含凭据值，B 无凭据零外发、录入后跑通', async ({ page, extensionId, demoHeadless }) => {
  test.setTimeout(300_000)
  const server = await SyncServer.start()
  const host = await startHostSite()
  const receiver = await startUploadReceiver()
  autoAcceptDialogs(page)
  const space = 'Upload Space'
  const script = 'Upload Story Script'
  const flowName = '上报同步流程'
  const phone = '13800001204'
  let b: Participant | null = null
  try {
    // 设备 A：录入凭据（值只在本机）→ 播种上报流程 → 上传为脚本（真实同步链路）
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await saveUploadCredential(page, { name: CRED_NAME, value: CRED_VALUE })
    await seedFlow(page, uploadFlowJson(host.origin, {
      name: flowName, url: receiver.collectUrl, phone, credential: CRED_NAME, capture: true, finalAssert: true,
    }))
    await openSyncTab(page)
    await connectServer(page, server.origin)
    await createSpaceViaUi(page, space)
    const code = await readSpaceCode(page, space)
    await openSpaceScripts(page, space)
    await uploadFlowAsScript(page, { scriptName: script, note: 'upload story', versionNote: 'v1' })

    // 设备 B：凭码加入 → 脚本详情 → 拉取预览逐行 egress 徽标 + 目的地原样 + 卡片级警示
    b = await launchParticipant(demoHeadless, 'us-htp T4 B')
    autoAcceptDialogs(b.page)
    await ackOnboarding(b.page)
    await openSyncTab(b.page)
    await connectServer(b.page, server.origin)
    await joinSpaceViaUi(b.page, code)
    await openSpaceScripts(b.page, space)
    await openScriptDetail(b.page, script)
    await previewVersion(b.page, 1)
    const previewLine = b.page.locator('.sp-group .sp-option', { hasText: 'upload' })
    await expect(previewLine.locator('.sp-badge.egress')).toBeVisible()
    await expect(previewLine.locator('.sp-egress-url')).toHaveText(receiver.collectUrl)
    await expect(previewLine).toContainText(CRED_NAME)
    await expect(b.page.locator('p.sp-warn', { hasText: RX_EGRESS_WARN })).toBeVisible()

    // 拉取到本机为未启用；同步载荷只带凭据引用名，不含 A 的凭据值（值设备本机，DEC-002）
    await pullVersion(b.page, 1)
    await expectFlowStatus(b.page, flowName, 'draft')
    const flowJsonOnB = JSON.stringify((await getFlows(b.page)).find(f => f.name === flowName))
    expect(flowJsonOnB).toContain(CRED_NAME)
    expect(flowJsonOnB).not.toContain(CRED_VALUE)
    await expectUploadCount(receiver, '/collect', 0)

    // B 未录凭据即启用运行：保守中止提示具体凭据名，零外发
    await enableFlowFromFlowsTab(b.page, flowName)
    const hostPage = await openHostPage(b.context, host.formUrl)
    await expectHostPhoneFilled(hostPage, phone)
    await expectUploadFailure(b.page, flowName, RX_CRED_MISSING)
    await expect(failureRow(b.page, flowName).locator('p')).toContainText(CRED_NAME)
    await expectUploadCount(receiver, '/collect', 0)
    await hostPage.close()

    // B 录入本机凭据后同一流程跑通：单头值是 B 自己录入的（值不随同步分发）
    await saveUploadCredential(b.page, { name: CRED_NAME, value: CRED_VALUE_B })
    const hostPage2 = await openHostPage(b.context, host.formUrl)
    await expectHostPhoneFilled(hostPage2, phone)
    const record = await waitUploadRequest(receiver, '/collect')
    expect(record.headers.authorization).toBe(CRED_VALUE_B)
    expect(JSON.parse(record.body)).toEqual({ phone, source: 'htp-demo' })
    await b.page.waitForTimeout(1_500)
    await expectNoFailure(b.page, flowName)
    await expectUploadCount(receiver, '/collect', 1)
    await hostPage2.close()
  } finally {
    await b?.dispose()
    await receiver.close()
    await host.close()
    await server.cleanup()
  }
})
