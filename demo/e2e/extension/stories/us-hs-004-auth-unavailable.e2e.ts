import { expect, test } from '../fixtures'
import { startHostSite } from '../host-site'
import {
  setHeraldAccountStatus, startHeraldContainerAndWait, startHeraldServer, stopHeraldContainer,
} from '../herald'
import {
  ackOnboarding, autoAcceptDialogs, connectAndExpectSignIn, createSpaceViaUi, demoFlowJson,
  enableFlowFromFlowsTab, expectSignInPrompt, expectSignedIn, flowCardLocation, openFlowsTab,
  openHostPage, expectHostPhoneFilled, openScriptDetail, openSpaceScripts, openSyncTab,
  openWorkbench, peekSyncAuth, seedFlow, signInViaUi, scriptCard, uploadFlowAsScript,
} from '../workbench'

// US-HS-004 鉴权门禁异常可见（docs/user-stories/auth/herald-support.md 故事 4）。
// T1 场景 1 门禁不可用拒绝且不含糊：真实容器停机→下一同步操作明确失败（凭证保留）→本机宿主
// 流程照常→容器恢复后免重登继续（fail-closed 只影响同步，DEC-data-sync-005）；
// T2 场景 2 账号停用在下一次校验时生效：无缓存等候，明确引导重登，本机数据保留。
// 故障手段与后端 a04/a05 同款（docker 停起 + SQL 停用），容器在用例内恢复，套件串行。
const EMAIL = 'us-hs-004@test.oncewise.local'
const FLOW = 'demo flow hs004'
const VALUE = '13800003333'

test('T1 门禁不可用拒绝且不含糊：停机→同步明确失败且本机照常→恢复免重登', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(300_000)
  const { herald, server } = await startHeraldServer([EMAIL])
  const host = await startHostSite()
  autoAcceptDialogs(page)
  let heraldStopped = false
  try {
    // 先成功：登录、建空间、存脚本，并启用一条本机流程
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await seedFlow(page, demoFlowJson(host.origin, { name: FLOW, value: VALUE }))
    await connectAndExpectSignIn(page, server.origin)
    await signInViaUi(context, page, EMAIL)
    await createSpaceViaUi(page, 'Outage Space')
    await openSpaceScripts(page, 'Outage Space')
    await uploadFlowAsScript(page, { scriptName: 'Outage Script', versionNote: 'v1' })
    await enableFlowFromFlowsTab(page, FLOW)

    // Herald 真实停机（容器停止）：下一同步操作明确失败，凭证保留
    await stopHeraldContainer()
    heraldStopped = true
    await openSyncTab(page)
    await openSpaceScripts(page, 'Outage Space')
    await expect(page.locator('main.sp-main p.sp-error', { hasText: /temporarily unavailable|暂不可用/ }))
      .toBeVisible({ timeout: 30_000 })
    await expectSignedIn(page)
    expect(await peekSyncAuth(page), '依赖故障不得清除本机凭证').not.toBeNull()

    // 本机宿主流程照常执行（门禁故障只影响同步）
    const hostPage = await openHostPage(context, host.formUrl)
    await expectHostPhoneFilled(hostPage, VALUE)

    // 容器恢复：同一会话免重登继续同步
    await startHeraldContainerAndWait(herald)
    heraldStopped = false
    await openFlowsTab(page)
    await openSyncTab(page)
    await openSpaceScripts(page, 'Outage Space')
    await expect(scriptCard(page, 'Outage Script')).toBeVisible({ timeout: 30_000 })
    await expectSignedIn(page)
  } finally {
    if (heraldStopped) await startHeraldContainerAndWait(herald).catch(() => undefined)
    await host.close()
    await server.cleanup()
  }
})

test('T2 账号停用在下一次校验时生效：无缓存等候，明确引导重登，本机数据保留', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(240_000)
  const { herald, server } = await startHeraldServer([EMAIL])
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await seedFlow(page, demoFlowJson(host.origin, { name: FLOW, value: VALUE }))
    await connectAndExpectSignIn(page, server.origin)
    await signInViaUi(context, page, EMAIL)
    await createSpaceViaUi(page, 'Disabled Space')
    await openSpaceScripts(page, 'Disabled Space')
    await uploadFlowAsScript(page, { scriptName: 'Disabled Script', versionNote: 'v1' })

    // 管理员在 Herald 侧停用账号（真实 SQL，UserStatus 2=Forbidden）
    await setHeraldAccountStatus(herald, EMAIL, 2)

    // 下一次校验即拒绝：无缓存等候；续期同样被拒，凭证清除并引导重登
    await openSyncTab(page)
    await openSpaceScripts(page, 'Disabled Space')
    await expect(page.locator('main.sp-main p.sp-error', { hasText: /requires signing in|要求登录后才能同步/ }))
      .toBeVisible({ timeout: 30_000 })
    // 登录卡在业务失败后不即时回读（扩展 P3 已知观察）；按卡片自身契约重挂载后经 GetAuthState 重读
    await openSyncTab(page)
    await expectSignInPrompt(page)
    expect(await peekSyncAuth(page), '停用后凭证必须清除').toBeNull()

    // 本机数据保留：空间清单与本机流程照常
    await expect(page.locator('.sp-group[aria-label="Disabled Space"]')).toBeVisible()
    await openFlowsTab(page)
    await expect(flowCardLocation(page, FLOW)).toBeVisible()
  } finally {
    await setHeraldAccountStatus(herald, EMAIL, 1).catch(() => undefined)
    await host.close()
    await server.cleanup()
  }
})
