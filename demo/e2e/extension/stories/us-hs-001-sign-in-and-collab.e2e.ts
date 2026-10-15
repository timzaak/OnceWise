import { expect, test } from '../fixtures'
import { startHostSite } from '../host-site'
import { launchParticipant, type Participant } from '../participant'
import { heraldLogin, rotateAwayRefreshToken, startHeraldServer, type HeraldTestEnv } from '../herald'
import type { SyncServer } from '../sync-server'
import {
  ackOnboarding, authCard, autoAcceptDialogs, connectAndExpectSignIn, demoFlowJson,
  enableFlowFromFlowsTab, expectFlowStatus, expectSignInPrompt, expectSignedIn, joinSpaceViaUi,
  openFlowsTab, openHostPage, expectHostPhoneFilled, openScriptDetail, openSpaceScripts,
  openSyncTab, openWorkbench, peekSyncAuth, publishVersion, pullVersion, seedFlow,
  uploadFlowAsScript, expireStoredAccessToken, signInViaUi, flowCardLocation, scriptCard,
} from '../workbench'

// US-HS-001 在启用鉴权的服务器上登录后使用同步（docs/user-stories/auth/herald-support.md 故事 1）。
// T1 场景 1 登录后照常协作（A/B 双设备真实授权窗口登录、无权限账号可用、协作语义不变）；
// T2 场景 2 登录状态自动延续（过期后首操作静默续期、令牌族轮换且持久化）；
// T3 场景 3 续期失效引导重新登录（凭证彻底失效被明确拒绝、本机数据保留、重登恢复）。
// 播种账号不带任何角色：登录门禁只认有效登录，不查权限点（DEC-herald-support-003）。
// workspace-permissions 适配：wp 服务器上 UI 创建一律组织绑定（无码行），「创建并分享空间码」
// 前置改为 API 播种密钥空间（key 随体 = 后端过渡兼容路径）+ 参与者粘贴加入；协作/续期/重登
// 断言全部不变。

const EMAIL_A = 'us-hs-001-a@test.oncewise.local'
const EMAIL_B = 'us-hs-001-b@test.oncewise.local'
const FLOW = 'demo flow hs001'
const VALUE = '13800001111'

// API 播种一枚密钥空间并返回「空间ID#密钥」码（空间 id=sp-+16 base62、密钥=32 base62——与
// 扩展 parseEntryCode 的本地判型规则同形状，服务端侧 16–256 字符合法区间的中点取值）。
async function seedKeySpace(server: SyncServer, herald: HeraldTestEnv, email: string, name: string): Promise<string> {
  const base62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const random = (n: number) => Array.from({ length: n }, () => base62[Math.floor(Math.random() * 62)]).join('')
  const id = `sp-${random(16)}`
  const key = random(32)
  await server.createSpace(id, key, name, { bearer: await heraldLogin(herald, email) })
  return `${id}#${key}`
}

test('T1 登录后照常协作：真实授权窗口登录后凭码加入协作/发版，另一设备凭码拉取启用', async ({
  page, context, extensionId, demoHeadless,
}) => {
  test.setTimeout(300_000)
  const { herald, server } = await startHeraldServer([EMAIL_A, EMAIL_B])
  const host = await startHostSite()
  autoAcceptDialogs(page)
  let b: Participant | null = null
  try {
    // A（设备一）：登录前引导明确；真实窗口登录后粘贴加入 API 播种的密钥空间，协作与无鉴权
    // 服务器一致
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await seedFlow(page, demoFlowJson(host.origin, { name: FLOW, value: VALUE }))
    await connectAndExpectSignIn(page, server.origin)
    await signInViaUi(context, page, EMAIL_A)
    const code = await seedKeySpace(server, herald, EMAIL_A, 'Team Space')
    await joinSpaceViaUi(page, code)
    await openSpaceScripts(page, 'Team Space')
    await uploadFlowAsScript(page, { scriptName: 'Collab Script', note: 'note', versionNote: 'v1' })
    await openScriptDetail(page, 'Collab Script')
    await publishVersion(page, 'v2 with note', 2)

    // B（设备二，独立 profile）：同样经真实窗口登录后凭码加入并拉取启用
    b = await launchParticipant(demoHeadless, 'us-hs-001 B')
    autoAcceptDialogs(b.page)
    await ackOnboarding(b.page)
    await connectAndExpectSignIn(b.page, server.origin)
    await signInViaUi(b.context, b.page, EMAIL_B)
    await joinSpaceViaUi(b.page, code)
    await openSpaceScripts(b.page, 'Team Space')
    await openScriptDetail(b.page, 'Collab Script')
    await pullVersion(b.page, 1)
    await expectFlowStatus(b.page, FLOW, 'draft')
    await enableFlowFromFlowsTab(b.page, FLOW)
    await expectFlowStatus(b.page, FLOW, 'enabled')
    const hostPage = await openHostPage(b.context, host.formUrl)
    await expectHostPhoneFilled(hostPage, VALUE)
  } finally {
    await b?.dispose()
    await host.close()
    await server.cleanup()
  }
})

test('T2 登录状态自动延续：访问凭证过期后首个操作静默续期并轮换持久化', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(300_000)
  const { herald, server } = await startHeraldServer([EMAIL_A])
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await seedFlow(page, demoFlowJson(host.origin, { name: FLOW, value: VALUE }))
    await connectAndExpectSignIn(page, server.origin)
    await signInViaUi(context, page, EMAIL_A)
    await joinSpaceViaUi(page, await seedKeySpace(server, herald, EMAIL_A, 'Renew Space'))
    await openSpaceScripts(page, 'Renew Space')
    await uploadFlowAsScript(page, { scriptName: 'Renew Script', versionNote: 'v1' })
    await openScriptDetail(page, 'Renew Script')
    const before = await peekSyncAuth(page)
    expect(before).not.toBeNull()

    // 时间前置：Herald 访问令牌 TTL 固定 900s，等真实过期不可行；把本机过期视图改写为已过期
    // （仅本机时间视图，令牌与续期链路真实），再等 SW 空闲回收，让下一次操作走冷启动惰性续期
    await expireStoredAccessToken(page)
    await page.waitForTimeout(35_000)

    // 同一操作内自动续期并继续：发布 v2 成功即证明业务在续期后照常完成，全程无登录引导
    await publishVersion(page, 'v2 after renewal', 2)
    const after = await peekSyncAuth(page)
    expect(after).not.toBeNull()
    expect(after!.accessToken, '续期必须轮换访问令牌').not.toBe(before!.accessToken)
    expect(after!.refreshToken, '刷新令牌族必须轮换').not.toBe(before!.refreshToken)
    expect(after!.epoch, '续期不得变更会话世代').toBe(before!.epoch)
    await expectSignedIn(page)
    await expect(authCard(page).locator('p.sp-hint')).toHaveCount(0)
  } finally {
    await host.close()
    await server.cleanup()
  }
})

test('T3 续期失效引导重新登录：明确提示重登、本机数据保留、重登后恢复', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(300_000)
  const { herald, server } = await startHeraldServer([EMAIL_A])
  const host = await startHostSite()
  autoAcceptDialogs(page)
  try {
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await seedFlow(page, demoFlowJson(host.origin, { name: FLOW, value: VALUE }))
    await connectAndExpectSignIn(page, server.origin)
    await signInViaUi(context, page, EMAIL_A)
    await joinSpaceViaUi(page, await seedKeySpace(server, herald, EMAIL_A, 'Relogin Space'))
    await openSpaceScripts(page, 'Relogin Space')
    await uploadFlowAsScript(page, { scriptName: 'Relogin Script', versionNote: 'v1' })
    const before = await peekSyncAuth(page)
    expect(before).not.toBeNull()

    // 凭证彻底失效的真实前提：把本机 refresh token 经刷新端点轮换掉（旧 token 随即作废），
    // 同时把访问令牌的过期视图前置——下一次操作触发续期时被 401 拒绝
    expect(await rotateAwayRefreshToken(server.origin, before!.refreshToken)).toBe(200)
    await expireStoredAccessToken(page)

    // 重新进入脚本清单（listScripts）被拒并明确引导重登
    await openSyncTab(page)
    await openSpaceScripts(page, 'Relogin Space')
    await expect(page.locator('main.sp-main p.sp-error', { hasText: /requires signing in|要求登录后才能同步/ }))
      .toBeVisible({ timeout: 30_000 })
    // 登录卡状态在业务失败后不即时回读（扩展 P3 已知观察：失败路径不强制 refreshAuth）；
    // 卡片自身契约是重开页面经 GetAuthState 重读——重挂载同步页后再断言引导
    await openSyncTab(page)
    await expectSignInPrompt(page)
    expect(await peekSyncAuth(page), '失效凭证必须清除').toBeNull()

    // 本机数据不受影响：空间清单与本机流程照常
    await expect(page.locator('.sp-group[aria-label="Relogin Space"]')).toBeVisible()
    await openFlowsTab(page)
    await expect(flowCardLocation(page, FLOW)).toBeVisible()

    // 重登恢复：脚本清单重新可用
    await openSyncTab(page)
    await signInViaUi(context, page, EMAIL_A)
    await openSpaceScripts(page, 'Relogin Space')
    await expect(scriptCard(page, 'Relogin Script')).toBeVisible()
  } finally {
    await host.close()
    await server.cleanup()
  }
})
