import { expect, test } from '../fixtures'
import { SyncServer } from '../sync-server'
import { startHostSite } from '../host-site'
import { startHeraldServer } from '../herald'
import {
  ackOnboarding, authCard, autoAcceptDialogs, connectAndExpectSignIn, connectServer, createSpaceViaUi,
  demoFlowJson, enableFlowFromFlowsTab, expectSignInPrompt, flowCardLocation, openFlowsTab,
  openHostPage, expectHostPhoneFilled, openScriptDetail, openSpaceScripts, openSyncTab,
  openWorkbench, peekRawAuth, peekSyncAuth, publishVersion, seedFlow, signOutViaUi,
  signInViaUi, uploadFlowAsScript,
} from '../workbench'

// US-HS-002 登录状态管理（docs/user-stories/auth/herald-support.md 故事 2）。
// T1 场景 1 登出（仅清本机登录态、世代递增、空间/流程保留、后续操作重新要求登录）；
// T2 场景 2 切换服务器清登录态（A→B(none)→A 不复活旧会话）；
// T3 场景 3 无鉴权服务器零感知（全程无登录界面，行为与升级前一致）；
// T4 存储隔离现场证据（真实 content 上下文读取 local:syncAuth 被拒，合法本机路径照常）——
// extension phase 无法用 Vitest 假 API 证明的行在此用真实浏览器补齐。
const EMAIL = 'us-hs-002@test.oncewise.local'
const FLOW = 'demo flow hs002'
const VALUE = '13800002222'

test('T1 登出：仅清本机登录态（世代递增），空间清单与本机流程保留，操作重新要求登录', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(240_000)
  const { server } = await startHeraldServer([EMAIL])
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await seedFlow(page, demoFlowJson(host.origin, { name: FLOW, value: VALUE }))
    await connectAndExpectSignIn(page, server.origin)
    await signInViaUi(context, page, EMAIL)
    await createSpaceViaUi(page, 'Keep Space')
    await openSpaceScripts(page, 'Keep Space')
    await uploadFlowAsScript(page, { scriptName: 'Keep Script', versionNote: 'v1' })
    const before = await peekRawAuth(page)
    expect(before?.accessToken).not.toBe('')

    await signOutViaUi(page)

    const after = await peekRawAuth(page)
    expect(after?.accessToken ?? '', '登出必须清除本机令牌').toBe('')
    expect(after?.epoch ?? 0, '登出必须递增会话世代（迟到响应不得复活）').toBeGreaterThan(before?.epoch ?? 0)

    // 本机数据不受影响：重挂载回到空间视图后空间清单与本机流程照常
    await openSyncTab(page)
    await expect(page.locator('.sp-group[aria-label="Keep Space"]')).toBeVisible()
    await openFlowsTab(page)
    await expect(flowCardLocation(page, FLOW)).toBeVisible()

    // 后续同步操作重新要求登录（脚本清单触发 listScripts 被拒）
    await openSyncTab(page)
    await openSpaceScripts(page, 'Keep Space')
    await expect(page.locator('main.sp-main p.sp-error', { hasText: /requires signing in|要求登录后才能同步/ }))
      .toBeVisible({ timeout: 30_000 })
    await expectSignInPrompt(page)
  } finally {
    await host.close()
    await server.cleanup()
  }
})

test('T2 切换服务器清登录态：A→B(无鉴权)→A 后未登录，旧会话不复活', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(240_000)
  // 两个后端相互独立（独立端口/数据库/进程），并行起服与收尾
  const [{ server: serverA }, serverB] = await Promise.all([
    startHeraldServer([EMAIL]),
    SyncServer.start(),
  ])
  autoAcceptDialogs(page)
  try {
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await connectAndExpectSignIn(page, serverA.origin)
    await signInViaUi(context, page, EMAIL)
    await createSpaceViaUi(page, 'Switch Space')
    const before = await peekRawAuth(page)
    expect(before?.accessToken).not.toBe('')

    // 换到无鉴权服务器 B：登录卡消失（B 自身不要求登录），换服清空同步关联
    await connectServer(page, serverB.origin)
    await expect(authCard(page)).toHaveCount(0)
    await expect(page.locator('p.sp-hint', { hasText: /No spaces yet|尚无空间/ })).toBeVisible()
    const switched = await peekRawAuth(page)
    expect(switched?.accessToken ?? '', '换服必须清除旧服务器登录态').toBe('')
    expect(switched?.epoch ?? 0).toBeGreaterThan(before?.epoch ?? 0)

    // 切回 A：不得复活旧登录（A→B→A），重新出现登录引导
    await connectServer(page, serverA.origin)
    await expectSignInPrompt(page)
    const back = await peekRawAuth(page)
    expect(back?.accessToken ?? '').toBe('')
  } finally {
    await Promise.all([serverB.cleanup(), serverA.cleanup()])
  }
})

test('T3 无鉴权服务器零感知：全程无登录界面，同步全流程与升级前一致', async ({
  page, extensionId,
}) => {
  test.setTimeout(180_000)
  const server = await SyncServer.start()
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await seedFlow(page, demoFlowJson(host.origin, { name: FLOW, value: VALUE }))
    await openSyncTab(page)
    await connectServer(page, server.origin)

    // 连接后、每步操作后都不出现登录入口或登录状态展示
    await expect(authCard(page)).toHaveCount(0)
    await createSpaceViaUi(page, 'Plain Space')
    await expect(authCard(page)).toHaveCount(0)
    await openSpaceScripts(page, 'Plain Space')
    await uploadFlowAsScript(page, { scriptName: 'Plain Script', versionNote: 'v1' })
    await openScriptDetail(page, 'Plain Script')
    await publishVersion(page, 'plain v2', 2)
    await expect(authCard(page)).toHaveCount(0)

    // 登录凭证从未写入（none 连接只产生 epoch 递增的空 fallback 记录），业务无需任何凭证即全通
    expect(await peekSyncAuth(page), 'none 服务器不得留存任何凭证').toBeNull()
  } finally {
    await host.close()
    await server.cleanup()
  }
})

test('T4 存储隔离：content 上下文读取 syncAuth 被拒，本机流程执行照常', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(240_000)
  const { server } = await startHeraldServer([EMAIL])
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await seedFlow(page, demoFlowJson(host.origin, { name: FLOW, value: VALUE }))
    await connectAndExpectSignIn(page, server.origin)
    await signInViaUi(context, page, EMAIL)
    await enableFlowFromFlowsTab(page, FLOW)

    // 启用流程后内容脚本按站点注册：宿主页带真实 content script 的 isolated world。
    // 监听器必须在 Runtime.enable 之前挂接——既有 context 的上报在 enable 调用内即派发；
    // Playwright 自身的 utility world 同为 isolated，按名称排除。
    const hostPage = await openHostPage(context, host.formUrl)
    const cdp = await context.newCDPSession(hostPage)
    const worlds: { id: number; name: string; type?: unknown }[] = []
    cdp.on('Runtime.executionContextCreated', event => {
      const aux = event.context.auxData as { type?: string } | undefined
      worlds.push({ id: event.context.id, name: event.context.name, type: aux?.type })
    })
    await cdp.send('Runtime.enable')
    const deadline = Date.now() + 15_000
    let isolated: { id: number; name: string } | undefined
    while (Date.now() < deadline) {
      isolated = worlds.find(w => w.type === 'isolated' && !w.name.startsWith('__playwright'))
      if (isolated) break
      await page.waitForTimeout(500)
    }
    expect(isolated, '宿主页未出现 content script 的 isolated world').toBeDefined()

    // 整个 storage.local 区域已收紧为受信任上下文：content world 的读取必须被拒（不是拿到值）
    const probe = await cdp.send('Runtime.evaluate', {
      contextId: isolated!.id,
      expression: `(async () => {
        try {
          const values = await chrome.storage.local.get('syncAuth')
          return { denied: false, keys: Object.keys(values) }
        } catch (error) {
          return { denied: true, message: String((error && error.message) || error) }
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    const result = probe.result.value as { denied: boolean; message?: string; keys?: string[] }
    expect(result.denied, `content 读取不得成功：${JSON.stringify(result)}`).toBe(true)
    expect(result.message ?? '').toMatch(/not allowed|denied/)

    // 合法本机路径不受收紧影响：流程照常执行（电话已填），受信任扩展页读取照常
    // （登录徽标已由 signInViaUi 收尾断言，此处页面停在 Flows 页签无登录卡）
    await expectHostPhoneFilled(hostPage, VALUE)
    expect(await peekRawAuth(page), '受信任扩展页必须仍可读会话').not.toBeNull()
  } finally {
    await host.close()
    await server.cleanup()
  }
})
