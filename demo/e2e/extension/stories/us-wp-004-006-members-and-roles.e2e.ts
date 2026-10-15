import { expect, test } from '../fixtures'
import { launchParticipant, type Participant } from '../participant'
import { dropHeraldOwnerMembership, startHeraldServer } from '../herald'
import {
  ackOnboarding, autoAcceptDialogs, clickLeaveViaRow, connectAndExpectSignIn, createSpaceViaUi,
  demoFlowJson, demoteToMember, expectFlowStatus, expectLeaveProtectedRefusal, issueAnotherInvite,
  issueInviteAndReadCode, joinSpaceViaUi, leaveSpaceViaRow, memberCard,
  expectMemberRow, expectMemberRowButtonsAbsent, expectNoShareCodeRow, expectReadOnlyScriptDetail,
  expectReadOnlyScriptsView, expectSpaceAccessDenied, expectSpaceRoleBadge, flowCardLocation,
  openFlowsTab, openScriptDetail, openSpaceMembers, prepareParticipant,
  openSpaceScripts, openSyncTab, openWorkbench, peekSyncSpaces, promoteToAdmin, publishVersion,
  pullVersion, removeMemberViaUi, renameFlowViaEditor, scriptCard, seedFlow, signInViaUi,
  spaceGroup, submitJoinCode, transferOwnershipViaUi, uploadFlowAsScript,
} from '../workbench'

// US-WP-004 只读成员使用同步 + US-WP-005 管理员读写与成员管理 + US-WP-006 所有权转移
// （docs/user-stories/auth/workspace-permissions.md 故事 4/5/6）。三参与者用例按 T 分组、
// setTimeout 放宽；改名/改备注与保存走同一写门（require_space_access Manage 档），本文件以
// 「保存新脚本 + 发布新版本」代表写路径，改名归 us-ds-003 既有回归。
// T1 US-WP-004 场景 1/2：只读成员浏览/拉取照常（读语义逐字一致）；写与管理入口按角色隐藏
// （上传卡/发布/改名 + 空间行 Members/Delete 隐藏）并显示只读提示（PRD §7 主分支；服务端
// 403 兜底归后端 w03 与 T2 降级场景）。
// T2 US-WP-005 场景 1/2：owner 提升成员 → 被提升者重进即可写（保存/发布成功）→ 第三成员见
// 新版本提示照常拉取；随后降级 → 其下一次进入写入口隐藏。
// T3 US-WP-005 场景 3：移除近即时生效——被移除者下一次访问「无访问权」文案、本机数据与条目
// 保留、可忘记；旧码不能重入（已用码 409）。
// T4 US-WP-005 场景 4 + US-WP-006 场景 2：owner 行无移除/降级（UI 面即保护）、非 owner 无转移
// 入口；owner 自退 409；最后管理员档保护沿后端 w04 的异常态构造（删除 owner 成员行）后自退 409。
// T5 US-WP-006 场景 1：所有权一步转移——成员列表即时翻转（新 owner 标记、旧 owner=admin）、
// 原所有者视图不再有转移入口。
// T6 US-WP-005 场景 5 成功自退（DEC-010：空间行 Leave + 条目 myUserId 寻址）：服务端成员关系
// 移除、后续访问「无访问权」、本机数据与条目保留可自行忘记、owner 成员列表即时反映。

const EMAIL_A = 'us-wp-004-a@test.oncewise.local'
const EMAIL_B = 'us-wp-004-b@test.oncewise.local'
const EMAIL_C = 'us-wp-004-c@test.oncewise.local'
const SITE = 'http://127.0.0.1:9'

// A（owner）建空间 + 上传 v1 脚本 + 签发一枚邀请码（码单次有效，一成员一码）。需第二枚的用例
// （如 T2 的两成员加入）在返回后于成员界面经 issueAnotherInvite 补签，其余用例不再多签死码。
async function ownerPrep(
  page: import('@playwright/test').Page, context: import('@playwright/test').BrowserContext,
  extensionId: string, origin: string, spaceName: string, scriptName: string,
): Promise<string> {
  await openWorkbench(page, extensionId)
  await ackOnboarding(page)
  await seedFlow(page, demoFlowJson(SITE, { name: `${scriptName} flow`, value: '13800003333' }))
  await connectAndExpectSignIn(page, origin)
  await signInViaUi(context, page, EMAIL_A)
  await createSpaceViaUi(page, spaceName)
  await openSpaceScripts(page, spaceName)
  await uploadFlowAsScript(page, { scriptName, versionNote: 'v1' })
  await openSyncTab(page)
  await openSpaceMembers(page, spaceName)
  return await issueInviteAndReadCode(page)
}

// 参与者登录并凭邀请码加入（加入成功断言 + 只读成员徽标）。
async function joinAsMember(
  p: Participant, email: string, origin: string, invite: string, spaceName: string,
): Promise<void> {
  await prepareParticipant(p, email, origin)
  await joinSpaceViaUi(p.page, invite, { timeout: 30_000 })
  await expectSpaceRoleBadge(p.page, spaceName, 'member')
}

test('T1 只读成员：浏览与拉取照常；写与管理入口隐藏并显示只读提示', async ({
  page, context, extensionId, demoHeadless,
}) => {
  test.setTimeout(360_000)
  const { server } = await startHeraldServer([EMAIL_A, EMAIL_B])
  autoAcceptDialogs(page)
  let b: Participant | null = null
  try {
    const inviteB = await ownerPrep(page, context, extensionId, server.origin, 'Member Space', 'Team Script')

    b = await launchParticipant(demoHeadless, 'us-wp-004 B')
    await joinAsMember(b, EMAIL_B, server.origin, inviteB, 'Member Space')

    // 读语义与密钥空间一致：脚本清单 → 详情 → 拉取 v1（本机固定）
    await openSpaceScripts(b.page, 'Member Space')
    await expect(scriptCard(b.page, 'Team Script')).toBeVisible()
    await openScriptDetail(b.page, 'Team Script')
    await pullVersion(b.page, 1)

    // 写入口隐藏 + 只读提示（脚本视图上传卡、详情发布/改名）
    await expectReadOnlyScriptDetail(b.page)
    await openSyncTab(b.page)
    await openSpaceScripts(b.page, 'Member Space')
    await expectReadOnlyScriptsView(b.page)

    // 管理入口按角色隐藏：回到空间视图再断言行按钮（Members/Delete 隐藏、Leave 在位）
    await openSyncTab(b.page)
    const row = spaceGroup(b.page, 'Member Space')
    await expect(row.getByRole('button', { name: /^(Members|成员)$/ })).toHaveCount(0)
    await expect(row.getByRole('button', { name: /^(Delete|删除)$/ })).toHaveCount(0)
    await expect(row.getByRole('button', { name: /^(Leave space|退出空间)$/ })).toBeVisible()
    await expectNoShareCodeRow(b.page, 'Member Space')

    // 本机数据不受影响：拉取产生的本机流程照常（本地优先）
    await expectFlowStatus(b.page, 'Team Script flow', 'draft')
  } finally {
    await b?.dispose()
    await server.cleanup()
  }
})

test('T2 提升后重进即可写、他人见新版本照常拉取；降级后下一次进入写入口隐藏', async ({
  page, context, extensionId, demoHeadless,
}) => {
  test.setTimeout(420_000)
  const { server } = await startHeraldServer([EMAIL_A, EMAIL_B, EMAIL_C])
  autoAcceptDialogs(page)
  let b: Participant | null = null
  let c: Participant | null = null
  try {
    const inviteB = await ownerPrep(page, context, extensionId, server.origin, 'Roles Space', 'Shared Script')
    // 两成员各自加入需两枚码：ownerPrep 结束时成员界面仍开着，直接补签第二枚
    const inviteC = await issueAnotherInvite(page, inviteB)

    b = await launchParticipant(demoHeadless, 'us-wp-004 B')
    await joinAsMember(b, EMAIL_B, server.origin, inviteB, 'Roles Space')
    c = await launchParticipant(demoHeadless, 'us-wp-004 C')
    await joinAsMember(c, EMAIL_C, server.origin, inviteC, 'Roles Space')

    // C 先固定 v1（为「新版本提示」建立基线）
    await openSpaceScripts(c.page, 'Roles Space')
    await openScriptDetail(c.page, 'Shared Script')
    await pullVersion(c.page, 1)

    // owner 成员界面提升 B 为管理员；列表即时翻转（复拉断言）
    await openSyncTab(page)
    await openSpaceMembers(page, 'Roles Space')
    await expectMemberRow(page, 'us-wp-004-b', 'member')
    await promoteToAdmin(page, 'us-wp-004-b')

    // B 的上传素材先落本机（在进入脚本视图之前播种——视图的流程清单在挂载时读取，
    // 视图内后播种不会刷新其上传入口的可用态）
    await seedFlow(b.page, demoFlowJson(SITE, { name: 'flow authored by B', value: '13800004444' }))

    // B 重进脚本视图：写入口出现（角色刷新以服务端为准），保存新脚本成功
    await openSyncTab(b.page)
    await openSpaceScripts(b.page, 'Roles Space')
    await expect(scriptCard(b.page, 'Shared Script')).toBeVisible()
    await expect(b.page.getByRole('button', { name: /^(Save a local flow as a script|把本机流程保存为脚本)$/ }))
      .toBeVisible()
    await uploadFlowAsScript(b.page, { scriptName: 'Script From B', versionNote: 'v1' })

    // B 对既有脚本发布 v2：先拉 v1 建立本机关联，改名构成内容变化，发布成功
    await openScriptDetail(b.page, 'Shared Script')
    await pullVersion(b.page, 1)
    await renameFlowViaEditor(b.page, 'Shared Script flow', 'Shared Script flow edited by B')
    await openSyncTab(b.page)
    await openSpaceScripts(b.page, 'Roles Space')
    await openScriptDetail(b.page, 'Shared Script')
    await publishVersion(b.page, 'v2 by admin B', 2)

    // C（只读）见新版本提示并照常拉取
    await openSyncTab(c.page)
    await openSpaceScripts(c.page, 'Roles Space')
    await expect(scriptCard(c.page, 'Shared Script')
      .locator('.sp-badge.sync-new', { hasText: /New version v2 available|新版本 v2 可用/ })).toBeVisible()
    await openScriptDetail(c.page, 'Shared Script')
    await pullVersion(c.page, 2)

    // owner 降级 B → B 下一次进入：写入口隐藏 + 只读提示（服务端判定为准）
    await openSyncTab(page)
    await openSpaceMembers(page, 'Roles Space')
    await demoteToMember(page, 'us-wp-004-b')
    await openSyncTab(b.page)
    await openSpaceScripts(b.page, 'Roles Space')
    await expectReadOnlyScriptsView(b.page)
  } finally {
    await b?.dispose()
    await c?.dispose()
    await server.cleanup()
  }
})

test('T3 移除近即时生效：下一次访问无权限、本机数据保留可忘记、旧码不能重入', async ({
  page, context, extensionId, demoHeadless,
}) => {
  test.setTimeout(360_000)
  const { server } = await startHeraldServer([EMAIL_A, EMAIL_C])
  autoAcceptDialogs(page)
  let c: Participant | null = null
  try {
    const inviteC = await ownerPrep(page, context, extensionId, server.origin, 'Revoke Space', 'Doomed Script')

    c = await launchParticipant(demoHeadless, 'us-wp-004 C')
    await joinAsMember(c, EMAIL_C, server.origin, inviteC, 'Revoke Space')
    await openSpaceScripts(c.page, 'Revoke Space')
    await openScriptDetail(c.page, 'Doomed Script')
    await pullVersion(c.page, 1)

    // owner 移除 C（显式确认由 autoAcceptDialogs 接受）；列表复拉后行消失
    await openSyncTab(page)
    await openSpaceMembers(page, 'Revoke Space')
    await removeMemberViaUi(page, 'us-wp-004-c')

    // C 下一次进入：明确「已无该空间访问权」；回空间视图断言本机条目保留（本地优先）
    await openSyncTab(c.page)
    await openSpaceScripts(c.page, 'Revoke Space')
    await expectSpaceAccessDenied(c.page)
    await openSyncTab(c.page)
    await expect(spaceGroup(c.page, 'Revoke Space')).toBeVisible()
    await expectFlowStatus(c.page, 'Doomed Script flow', 'draft')

    // C 持有的旧邀请码（已核销）不能使其重新加入
    await openSyncTab(c.page)
    await submitJoinCode(c.page, inviteC)
    await expect(c.page.locator('p.sp-error', { hasText: /already been used|已被使用/ })).toBeVisible({ timeout: 30_000 })

    // 本机清单条目可自行忘记：忘记后行消失（本机流程保留）
    await spaceGroup(c.page, 'Revoke Space').getByRole('button', { name: /^(Forget|忘记)$/ }).click()
    await expect(spaceGroup(c.page, 'Revoke Space')).toHaveCount(0, { timeout: 15_000 })
    await openFlowsTab(c.page)
    await expect(flowCardLocation(c.page, 'Doomed Script flow')).toBeVisible()
  } finally {
    await c?.dispose()
    await server.cleanup()
  }
})

test('T4 保护：owner 行无管理按钮、自退 409；非 owner 无转移入口；最后管理员档自退 409', async ({
  page, context, extensionId, demoHeadless,
}) => {
  test.setTimeout(360_000)
  const { herald, server } = await startHeraldServer([EMAIL_A, EMAIL_B])
  autoAcceptDialogs(page)
  let b: Participant | null = null
  try {
    const inviteB = await ownerPrep(page, context, extensionId, server.origin, 'Guard Space', 'Guard Script')

    b = await launchParticipant(demoHeadless, 'us-wp-004 B')
    await joinAsMember(b, EMAIL_B, server.origin, inviteB, 'Guard Space')

    // owner 视角：owner 行不出现移除/降级（Herald 原生保护的 UI 面）；member 行有提升、无转移
    await openSyncTab(page)
    await openSpaceMembers(page, 'Guard Space')
    await expectMemberRow(page, 'us-wp-004-a', 'owner', { you: true })
    await expectMemberRowButtonsAbsent(page, 'us-wp-004-a', [/^(Remove|移除)$/, /^(Demote to read-only|降为只读成员)$/])
    await expectMemberRowButtonsAbsent(page, 'us-wp-004-b', [/^(Transfer ownership|转移所有权)$/])
    await promoteToAdmin(page, 'us-wp-004-b')

    // B（管理员，非 owner）打开成员界面：无任何转移入口（仅所有者视图出现）。条目 myRole 还是
    // 加入时的 member——先重进脚本视图触发服务端角色刷新回写，Members 入口才会出现
    await openSyncTab(b.page)
    await openSpaceScripts(b.page, 'Guard Space')
    await openSyncTab(b.page)
    await openSpaceMembers(b.page, 'Guard Space')
    await expectMemberRow(b.page, 'us-wp-004-b', 'admin', { you: true })
    await expectMemberRowButtonsAbsent(b.page, 'us-wp-004-a', [/^(Transfer ownership|转移所有权)$/])
    await expectMemberRowButtonsAbsent(b.page, 'us-wp-004-b', [/^(Transfer ownership|转移所有权)$/])

    // owner 自退被 Herald 原生保护拒绝（409 文案含转移指引）
    await openSyncTab(page)
    await clickLeaveViaRow(page, 'Guard Space')
    await expectLeaveProtectedRefusal(page, 'owner')

    // 最后管理员档保护：正常组织不可达（owner 恒为管理员档），沿后端 w04 的异常态构造——
    // 删除 owner 的组织成员行后 B 成为唯一管理员档成员，其自退被 409 拒绝
    const spaces = await peekSyncSpaces(page)
    const orgId = await server.spaceOrgId(spaces[0]!.id)
    expect(orgId, '组织绑定空间必须能解析到组织 id').toBeTruthy()
    await dropHeraldOwnerMembership(herald, orgId!, EMAIL_A)
    await openSyncTab(b.page)
    await clickLeaveViaRow(b.page, 'Guard Space')
    await expectLeaveProtectedRefusal(b.page, 'last-admin')
  } finally {
    await b?.dispose()
    await server.cleanup()
  }
})

test('T5 所有权一步转移：成员列表即时翻转、原所有者降为管理员且失去转移入口', async ({
  page, context, extensionId, demoHeadless,
}) => {
  test.setTimeout(360_000)
  const { server } = await startHeraldServer([EMAIL_A, EMAIL_B])
  autoAcceptDialogs(page)
  let b: Participant | null = null
  try {
    const inviteB = await ownerPrep(page, context, extensionId, server.origin, 'Transfer Space', 'Transfer Script')

    b = await launchParticipant(demoHeadless, 'us-wp-004 B')
    await joinAsMember(b, EMAIL_B, server.origin, inviteB, 'Transfer Space')

    // 前置：B 提升为管理员（转移目标须在册；故事以「转移给某位管理员」为形）
    await openSyncTab(page)
    await openSpaceMembers(page, 'Transfer Space')
    await promoteToAdmin(page, 'us-wp-004-b')

    // 一步转移（显式确认由 autoAcceptDialogs 接受）：B 行翻转为所有者，A 行降为管理员
    await transferOwnershipViaUi(page, 'us-wp-004-b')
    await expectMemberRow(page, 'us-wp-004-a', 'admin')
    await expectMemberRowButtonsAbsent(page, 'us-wp-004-a', [/^(Transfer ownership|转移所有权)$/])

    // 双方空间行徽标随之翻转：A 侧由转移操作的回写即时刷新；B 侧条目仍是加入时的 member，
    // 重进脚本视图以服务端为准刷新后翻转为 Owner（角色新鲜度机制本身即故事断言）
    await page.getByRole('button', { name: /← Back to spaces|← 返回空间清单/ }).click()
    await expectSpaceRoleBadge(page, 'Transfer Space', 'admin')
    await openSyncTab(b.page)
    await openSpaceScripts(b.page, 'Transfer Space')
    await openSyncTab(b.page)
    await expectSpaceRoleBadge(b.page, 'Transfer Space', 'owner')
  } finally {
    await b?.dispose()
    await server.cleanup()
  }
})

test('T6 成员自主退出（US-WP-005 场景5）：服务端成员关系移除、后续无权、本机保留可忘记', async ({
  page, context, extensionId, demoHeadless,
}) => {
  test.setTimeout(360_000)
  const { server } = await startHeraldServer([EMAIL_A, EMAIL_B])
  autoAcceptDialogs(page)
  let b: Participant | null = null
  try {
    const inviteB = await ownerPrep(page, context, extensionId, server.origin, 'Exit Space', 'Exit Script')

    // B 加入为只读成员并拉取 v1（本机已有关联数据，供「本地优先保留」断言）
    b = await launchParticipant(demoHeadless, 'us-wp-004 B')
    await joinAsMember(b, EMAIL_B, server.origin, inviteB, 'Exit Space')
    await openSpaceScripts(b.page, 'Exit Space')
    await openScriptDetail(b.page, 'Exit Script')
    await pullVersion(b.page, 1)

    // 只读成员的空间行：Leave（自退入口）在位、无成员管理入口
    await openSyncTab(b.page)
    const row = spaceGroup(b.page, 'Exit Space')
    await expect(row.getByRole('button', { name: /^(Leave space|退出空间)$/ })).toBeVisible()
    await expect(row.getByRole('button', { name: /^(Members|成员)$/ })).toHaveCount(0)

    // 确认自退（confirm 由 autoAcceptDialogs 接受；条目 myUserId 寻址，DEC-010）：成功文案明示
    // 服务端成员关系移除 + 本机条目与已拉取内容保留
    await leaveSpaceViaRow(b.page, 'Exit Space')

    // 后续访问：明确「已无该空间访问权」；本机数据与条目保留（本地优先），可自行忘记。
    // 顺序注意：先在空间视图完成 Forget，再切流程页断言本机流程保留（expectFlowStatus 会
    // 切走页签，行定位在其后必空）
    await openSyncTab(b.page)
    await openSpaceScripts(b.page, 'Exit Space')
    await expectSpaceAccessDenied(b.page)
    await openSyncTab(b.page)
    await expect(spaceGroup(b.page, 'Exit Space')).toBeVisible()
    await spaceGroup(b.page, 'Exit Space').getByRole('button', { name: /^(Forget|忘记)$/ }).click()
    await expect(spaceGroup(b.page, 'Exit Space')).toHaveCount(0, { timeout: 15_000 })
    await expectFlowStatus(b.page, 'Exit Script flow', 'draft')
    await expect(flowCardLocation(b.page, 'Exit Script flow')).toBeVisible()

    // owner 视角复核：B 已不在成员列表（自退即时反映）
    await openSyncTab(page)
    await openSpaceMembers(page, 'Exit Space')
    await expect(memberCard(page, 'us-wp-004-b')).toHaveCount(0, { timeout: 15_000 })
  } finally {
    await b?.dispose()
    await server.cleanup()
  }
})
