import type { Page } from '@playwright/test'
import { expect, extensionEntryUrl } from '../fixtures'
import {
  ackOnboarding, autoAcceptDialogs, demoFlowJson, enableFlowFromFlowsTab, expectFlowStatus,
  getFlows, flowCardLocation,
} from '../workbench'
import { nativeTest, pingUntilReady, saveFlowViaNative } from '../native-host'

// US-NM-005 查看本地历史并回滚（docs/user-stories/core/support-native-messaging.md）：
// - T1 场景 2（上限与水位）：同一流程连续 11 次经本机通道成功保存（每次 CAS 链式替换），
//   详情只列最近 10 个版本（v2～v11，当前标记在 v11）；重放被裁剪的第 1 个 clientRef 得
//   ref-expired 且零新增版本。
// - T2 场景 1（用户回滚）：启用中的流程由用户在详情确认回滚到旧版本——内容恢复、落为
//   未启用的新当前版本，回滚前内容仍在历史中可再回滚。
// 回滚失败不部分改写的注入证明由 extension/tests/flow-history.test.ts 承载（UI 无真实失败
// 注入入口），本文件覆盖用户可见路径。

const NAME = '历史回滚流程'
const VALUE_V1 = '13811110001'
const VALUE_V2 = '13811110002'

const RX_HISTORY_TITLE = /^Version history$|^版本历史$/
const RX_ROLLBACK = /^Roll back to this version$|^回滚到此版本$/
const RX_CURRENT = /current|当前/

function historySection(page: Page) {
  return page.locator('section.sp-card').filter({ has: page.locator('h2.sp-title', { hasText: RX_HISTORY_TITLE }) })
}

async function openFlowDetail(page: Page): Promise<void> {
  await flowCardLocation(page, NAME).getByRole('button', { name: /^(View \/ Edit|查看 \/ 编辑)$/ }).click()
  await expect(historySection(page)).toBeVisible()
}

nativeTest('eleven native saves keep the last ten versions; the trimmed first ref is refused', async ({ page, extensionId }) => {
  await pingUntilReady()

  let flowId = ''
  let updatedAt = 0
  const refs: string[] = []
  const firstJson = demoFlowJson('https://www.example.com', { name: NAME, value: VALUE_V1 })
  for (let i = 1; i <= 11; i += 1) {
    const json = i === 1 ? firstJson : demoFlowJson('https://www.example.com', { name: NAME, value: `1381111000${i}` })
    const save = saveFlowViaNative(json, flowId === '' ? {} : { flowId, expectedUpdatedAt: updatedAt })
    expect(save.result.ok, `第 ${i} 次保存应成功`).toBe(true)
    refs.push(save.ref)
    flowId = save.result.data.flowId as string
    updatedAt = save.result.data.updatedAt as number
  }

  await page.goto(await extensionEntryUrl(extensionId, 'sidepanel'))
  await ackOnboarding(page)
  await openFlowDetail(page)

  // 只显示最近 10 个成功保存版本（v2～v11），最新在前并带当前标记
  const history = historySection(page)
  await expect(history.locator('li')).toHaveCount(10)
  await expect(history.locator('li').first()).toContainText('v11')
  await expect(history.locator('li').first()).toContainText(RX_CURRENT)
  await expect(history.locator('li').last()).toContainText('v2')

  // 被裁剪的第 1 个回执：重放明确拒绝（ref-expired），零新增版本
  const replay = saveFlowViaNative(firstJson, { ref: refs[0] })
  expect(replay.result.ok).toBe(false)
  expect(replay.result.error?.code).toBe('ref-expired')
  await expect(history.locator('li')).toHaveCount(10)
})

nativeTest('user rollback restores the chosen version as not-enabled and keeps prior content recoverable', async ({ page, extensionId }) => {
  await pingUntilReady()

  // 两个版本：v1 → v2（CAS 替换）；用户启用当前（v2）内容
  const first = saveFlowViaNative(demoFlowJson('https://www.example.com', { name: NAME, value: VALUE_V1 }))
  expect(first.result.ok).toBe(true)
  const flowId = first.result.data.flowId as string
  const second = saveFlowViaNative(
    demoFlowJson('https://www.example.com', { name: NAME, value: VALUE_V2 }),
    { flowId, expectedUpdatedAt: first.result.data.updatedAt as number },
  )
  expect(second.result.ok).toBe(true)

  await page.goto(await extensionEntryUrl(extensionId, 'sidepanel'))
  await ackOnboarding(page)
  await enableFlowFromFlowsTab(page, NAME)
  autoAcceptDialogs(page)

  // 用户在详情确认回滚到 v1（二次确认说明回滚后未启用）
  await openFlowDetail(page)
  await historySection(page).locator('li').last().getByRole('button', { name: RX_ROLLBACK }).click()

  // 回滚结果：内容恢复为 v1，落为未启用；回滚形成新当前版本，回滚前的 v2 仍可再回滚
  await expectFlowStatus(page, NAME, 'draft')
  const flows = await getFlows(page) as { steps: { steps: { action: { value: unknown } }[] } }[]
  expect(flows[0].steps.steps[0].action.value).toBe(VALUE_V1)

  await openFlowDetail(page)
  const history = historySection(page)
  await expect(history.locator('li')).toHaveCount(3)
  await expect(history.locator('li').first()).toContainText('v3')
  await expect(history.locator('li').first()).toContainText(RX_CURRENT)
  await expect(history.locator('li').last()).toContainText('v1')
  await expect(history.locator('li').nth(1).getByRole('button', { name: RX_ROLLBACK })).toBeVisible()
})
