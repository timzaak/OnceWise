import { expect, test } from '../fixtures'
import { launchParticipant, type Participant } from '../participant'
import { startHeraldContainerAndWait, startHeraldServer, stopHeraldContainer } from '../herald'
import {
  ackOnboarding, autoAcceptDialogs, connectAndExpectSignIn, connectServer, createSpaceViaUi,
  expectMemberRow, expectNoShareCodeRow, expectSpaceRoleBadge, issueAnotherInvite,
  issueInviteAndReadCode, joinSpaceViaUi, openSpaceMembers, openSyncTab, openWorkbench,
  peekSyncSpaces, prepareParticipant, signInViaUi, submitJoinCode,
} from '../workbench'

// US-WP-002 签发一次性邀请码 + US-WP-003 凭码加入（docs/user-stories/auth/workspace-permissions.md
// 故事 2/3），并入 US-WP-009 的故障核销不烧码（与 us-hs-004 同一容器停起手段）。
// T1 场景 1 签发与分享：成员界面签发——明文只读展示、单次/24h 规则明示、过期时间在位、并存多枚。
// T2 场景 2 已用码拒绝 + 加入为只读成员（US-WP-003 场景 1）：B 凭码加入记 myRole=member；
// C 同码 → 已被使用拒绝且 C 本机零条目。
// T3 场景 3 过期拒绝 + 非法形状本地拒绝（US-WP-003 场景 2）：SQL 推移 expires_at（时间前置替身，
// 与后端 w02 同款）→ 已过期拒绝；非法形状 → 本地 badCode 拒绝（零网络证据由扩展单测
// sync-service「非法形状零 fetch」锁定，浏览器面断言用户可见文案）。
// T4 场景 3 未登录先登录（US-WP-003 场景 3）：未登录 redeem → 登录引导、码保留表单；登录后同码
// 成功（成功本身即「码未在引导期被消费」的证明）。
// T5 故障核销不烧码（US-WP-009）：容器停 → 503 明确可重试、本机零条目；恢复 → 同码成功。

const EMAIL_A = 'us-wp-002-a@test.oncewise.local'
const EMAIL_B = 'us-wp-002-b@test.oncewise.local'
const EMAIL_C = 'us-wp-002-c@test.oncewise.local'
const EMAIL_E = 'us-wp-002-e@test.oncewise.local'

test('T1 签发与分享：明文单次展示、单次/24h 规则明示、并存多枚', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(240_000)
  const { server } = await startHeraldServer([EMAIL_A])
  autoAcceptDialogs(page)
  try {
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await connectAndExpectSignIn(page, server.origin)
    await signInViaUi(context, page, EMAIL_A)
    await createSpaceViaUi(page, 'Invite Space')
    await openSpaceMembers(page, 'Invite Space')
    await expectMemberRow(page, 'us-wp-002-a', 'owner', { you: true })

    // 签发原语统一断言码形状、规则明示与过期时间行
    const code1 = await issueInviteAndReadCode(page)
    // 同一空间可并存多枚有效码（丢失未分享 = 再签一枚）
    await issueAnotherInvite(page, code1)
  } finally {
    await server.cleanup()
  }
})

test('T2 凭码加入为只读成员；同码第二人被拒且本机不记录', async ({
  page, context, extensionId, demoHeadless,
}) => {
  test.setTimeout(300_000)
  const { server } = await startHeraldServer([EMAIL_A, EMAIL_B, EMAIL_C])
  autoAcceptDialogs(page)
  let b: Participant | null = null
  let c: Participant | null = null
  try {
    // A 建空间并签发一枚邀请码
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await connectAndExpectSignIn(page, server.origin)
    await signInViaUi(context, page, EMAIL_A)
    await createSpaceViaUi(page, 'Shared Space')
    await openSpaceMembers(page, 'Shared Space')
    const code = await issueInviteAndReadCode(page)

    // B（设备二）真实窗口登录后凭码加入：只读成员档、条目无 key 记 myRole/myUserId
    b = await launchParticipant(demoHeadless, 'us-wp-002 B')
    await prepareParticipant(b, EMAIL_B, server.origin)
    await joinSpaceViaUi(b.page, code, { timeout: 30_000 })
    await expectSpaceRoleBadge(b.page, 'Shared Space', 'member')
    await expectNoShareCodeRow(b.page, 'Shared Space')
    const bSpaces = await peekSyncSpaces(b.page)
    expect(bSpaces.length).toBe(1)
    expect(bSpaces[0]!.key).toBeUndefined()
    expect(bSpaces[0]!.myRole).toBe('member')
    expect(bSpaces[0]!.myUserId).toBeTruthy()

    // C（设备三）同码再试：已被使用拒绝，C 本机不记录该空间
    c = await launchParticipant(demoHeadless, 'us-wp-002 C')
    await prepareParticipant(c, EMAIL_C, server.origin)
    await submitJoinCode(c.page, code)
    await expect(c.page.locator('p.sp-error', { hasText: /already been used|已被使用/ })).toBeVisible({ timeout: 30_000 })
    expect(await peekSyncSpaces(c.page), '被拒的加入不得产生本机条目').toEqual([])
  } finally {
    await b?.dispose()
    await c?.dispose()
    await server.cleanup()
  }
})

test('T3 过期码拒绝；非法形状本地拒绝（本机均不记录）', async ({
  page, context, extensionId, demoHeadless,
}) => {
  test.setTimeout(300_000)
  const { server } = await startHeraldServer([EMAIL_A, EMAIL_B])
  autoAcceptDialogs(page)
  let b: Participant | null = null
  try {
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await connectAndExpectSignIn(page, server.origin)
    await signInViaUi(context, page, EMAIL_A)
    await createSpaceViaUi(page, 'Expiring Space')
    await openSpaceMembers(page, 'Expiring Space')
    const code = await issueInviteAndReadCode(page)

    // 时间前置替身：把该码 expires_at 推移到过去（24h 真实等待不可行；与后端 w02 同款 SQL 手段）
    await server.expireInvite(code)

    // B（设备二，加入者视角）登录后用过期码：明确「已过期」拒绝
    b = await launchParticipant(demoHeadless, 'us-wp-002 B')
    await prepareParticipant(b, EMAIL_B, server.origin)
    await submitJoinCode(b.page, code)
    await expect(b.page.locator('p.sp-error', { hasText: /has expired|已过期/ })).toBeVisible({ timeout: 30_000 })

    // 非法形状（非码、多 #、码体长度错）：本地 badCode 拒绝（零网络由扩展单测锁定）
    for (const bad of ['not-a-code', `${code}#extra`, 'sp-abc#iv-short']) {
      await submitJoinCode(b.page, bad)
      await expect(b.page.locator('p.sp-error', { hasText: /does not look like a space code or invite code|这不是空间码或邀请码/ }))
        .toBeVisible({ timeout: 15_000 })
    }
    expect(await peekSyncSpaces(b.page), '被拒的加入不得产生本机条目').toEqual([])
  } finally {
    await b?.dispose()
    await server.cleanup()
  }
})

test('T4 未登录使用邀请码：先引导登录、码不被消费，登录后同码加入成功', async ({
  page, context, extensionId, demoHeadless,
}) => {
  test.setTimeout(300_000)
  const { server } = await startHeraldServer([EMAIL_A, EMAIL_B])
  autoAcceptDialogs(page)
  let b: Participant | null = null
  try {
    // A 建空间签发码
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await connectAndExpectSignIn(page, server.origin)
    await signInViaUi(context, page, EMAIL_A)
    await createSpaceViaUi(page, 'Gate Space')
    await openSpaceMembers(page, 'Gate Space')
    const code = await issueInviteAndReadCode(page)

    // B（设备二）连接但未登录：redeem 被登录前置拦下（服务端门禁双保险——未登录请求不达核销），
    // 提示需要登录且码保留在表单
    b = await launchParticipant(demoHeadless, 'us-wp-002 B')
    autoAcceptDialogs(b.page)
    await ackOnboarding(b.page)
    // 连接服务器即达空间视图（登录引导由登录卡承载，不阻塞加入表单）
    await openSyncTab(b.page)
    await connectServer(b.page, server.origin)
    await submitJoinCode(b.page, code)
    await expect(b.page.locator('p.sp-error', { hasText: /requires signing in before syncing|要求登录后才能同步/ }))
      .toBeVisible({ timeout: 30_000 })
    expect(await b.page.locator('#sync-join-code').inputValue(), '码必须保留在表单，登录后重按即入').toBe(code)

    // B 真实窗口登录后同一枚码加入成功——成功即证明引导期间码未被消费
    await signInViaUi(b.context, b.page, EMAIL_B)
    await b.page.getByRole('button', { name: /^(Join|加入)$/ }).click()
    await expect(b.page.locator('p.sp-error', { hasText: /Joined space|已加入空间/ })).toBeVisible({ timeout: 30_000 })
    await expectSpaceRoleBadge(b.page, 'Gate Space', 'member')
  } finally {
    await b?.dispose()
    await server.cleanup()
  }
})

test('T5 权限服务故障时核销失败不烧码：恢复后同一枚码成功（US-WP-009）', async ({
  page, context, extensionId, demoHeadless,
}) => {
  test.setTimeout(360_000)
  const { herald, server } = await startHeraldServer([EMAIL_A, EMAIL_E])
  autoAcceptDialogs(page)
  let e: Participant | null = null
  try {
    // A 建空间签发码（容器健康时）
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await connectAndExpectSignIn(page, server.origin)
    await signInViaUi(context, page, EMAIL_A)
    await createSpaceViaUi(page, 'Fault Redeem Space')
    await openSpaceMembers(page, 'Fault Redeem Space')
    const code = await issueInviteAndReadCode(page)

    // E（设备二）登录后待命；容器停 → 核销 503：明确可重试、E 本机零条目、码不消费
    e = await launchParticipant(demoHeadless, 'us-wp-002 E')
    await prepareParticipant(e, EMAIL_E, server.origin)
    await stopHeraldContainer()
    await submitJoinCode(e.page, code)
    await expect(e.page.locator('p.sp-error', { hasText: /temporarily unavailable — try again later|暂不可用，请稍后重试/ }))
      .toBeVisible({ timeout: 30_000 })
    expect(await peekSyncSpaces(e.page), '故障核销不得产生本机条目').toEqual([])

    // 容器恢复 → 同一枚码核销成功（服务端依赖故障不烧码，扩展无需换码）
    await startHeraldContainerAndWait(herald)
    await joinSpaceViaUi(e.page, code, { timeout: 30_000 })
    await expectSpaceRoleBadge(e.page, 'Fault Redeem Space', 'member')
  } finally {
    await startHeraldContainerAndWait(herald).catch(() => undefined)
    await e?.dispose()
    await server.cleanup()
  }
})
