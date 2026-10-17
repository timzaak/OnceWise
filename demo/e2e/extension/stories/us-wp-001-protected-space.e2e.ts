import { expect, test } from '../fixtures'
import { startHeraldContainerAndWait, startHeraldServer, stopHeraldContainer } from '../herald'
import {
  ackOnboarding, autoAcceptDialogs, connectAndExpectSignIn, createSpaceViaUi, expectMemberRow,
  expectNoShareCodeRow, expectSpaceRoleBadge, issueInviteAndReadCode, openSpaceMembers, openWorkbench,
  peekSyncSpaces, signInViaUi, spaceGroup,
} from '../workbench'

// US-WP-001 创建受保护空间并成为所有者（docs/user-stories/auth/space-permissions.md 故事 1）。
// T1 场景 1 创建即保护：herald+wp 服务器上 UI 创建一律组织绑定——角色徽标 Owner、无分享码行、
// 本机条目无 key 而记 myRole/myUserId、成员入口在位且自身行「你」标记。
// T2 场景 2 + US-WP-009 创建 fail-closed：Herald 容器停 → 创建失败文案明确可重试、本机零条目；
// 容器恢复 → 同名创建成功（不产生「已建但不受保护」或「创建者不在成员中」的半成品）。
// 「容器停时探测/登录等门禁层可见性」由 us-hs-004 承载，本文件只断言组织绑定创建语义。

const EMAIL_A = 'us-wp-001-a@test.oncewise.local'

test('T1 创建即保护：组织绑定空间、Owner 徽标、无分享码、条目记 myRole/myUserId', async ({
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

    // 创建成功文案沿用既有键（createSpaceViaUi 断言「已创建并选中」）；结果物断言走双类别形状
    await createSpaceViaUi(page, 'Protected Space')
    await expectSpaceRoleBadge(page, 'Protected Space', 'owner')
    await expectNoShareCodeRow(page, 'Protected Space')
    await expect(spaceGroup(page, 'Protected Space').getByRole('button', { name: /^(Members|成员)$/ })).toBeVisible()

    // 本机清单条目：无 key、myRole=owner、myUserId 在位（DEC-008/010——不记密钥、记我的角色）
    const spaces = await peekSyncSpaces(page)
    expect(spaces.length).toBe(1)
    expect(spaces[0]!.key, '组织绑定条目不得记录空间密钥').toBeUndefined()
    expect(spaces[0]!.myRole).toBe('owner')
    expect(spaces[0]!.myUserId, '自身标识随条目记录（自退寻址/「你」标记数据源）').toBeTruthy()

    // 成员视图自身行：播种昵称取邮箱本地部分；「你」标记 + Owner 徽标，且无行内管理按钮
    await openSpaceMembers(page, 'Protected Space')
    await expectMemberRow(page, 'us-wp-001-a', 'owner', { you: true })
    // 邀请码区对 owner 可用（签发闭环归 us-wp-002-003，此处只确认入口；码形状/规则明示由
    // 签发原语统一断言）
    await issueInviteAndReadCode(page)
  } finally {
    await server.cleanup()
  }
})

test('T2 权限服务不可用时创建失败（fail-closed）：明确可重试、本机零条目、恢复后成功', async ({
  page, context, extensionId,
}) => {
  test.setTimeout(300_000)
  const { herald, server } = await startHeraldServer([EMAIL_A])
  autoAcceptDialogs(page)
  try {
    await openWorkbench(page, extensionId)
    await ackOnboarding(page)
    await connectAndExpectSignIn(page, server.origin)
    await signInViaUi(context, page, EMAIL_A)

    // 真实故障手段（与后端 w06 同款）：停 Herald 容器后创建——后端组织登记失败整体回滚 503，
    // 扩展经既有 auth-unavailable 文案明确「稍后重试」
    await stopHeraldContainer()
    await page.locator('#sync-space-name').fill('Fault Space')
    await page.getByRole('button', { name: /^(Create space|创建空间)$/ }).click()
    await expect(page.locator('p.sp-error', { hasText: /temporarily unavailable — try again later|暂不可用，请稍后重试/ }))
      .toBeVisible({ timeout: 30_000 })
    expect(await peekSyncSpaces(page), '失败不得产生本机条目（含错误类别的半成品）').toEqual([])

    // 容器恢复后重试成功：空间完整受保护、创建者在成员中（无中间态可见）
    await startHeraldContainerAndWait(herald)
    await createSpaceViaUi(page, 'Fault Space')
    await expectSpaceRoleBadge(page, 'Fault Space', 'owner')
    expect((await peekSyncSpaces(page)).length).toBe(1)
  } finally {
    // finally 里兜底恢复容器：容器停在半途中断时也不把停机状态泄漏给后续用例
    await startHeraldContainerAndWait(herald).catch(() => undefined)
    await server.cleanup()
  }
})
