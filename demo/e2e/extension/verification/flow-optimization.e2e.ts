import { expect, extensionEntryUrl, test } from '../fixtures'
import { ackOnboarding, demoFlowJson, openWorkbench, seedFlow } from '../workbench'

// 「用 AI 优化」的 UI 侧契约：对启用中的流程发起优化会先暂停它，并发放 15 分钟
// 单流程读取授权（session:nativeReadGrant，本机通道 flow.read 的唯一凭证）。修订替换本身经
// 本机通道往返（flow.read → 对话确认 → flow.save），由 us-nm-* 本机通道 Demo 用例覆盖——
// e2e 的 CI Chrome 无宿主不可驱动该段（见 scripts/index.md）。
test('improving with AI pauses the enabled flow and grants a time-limited native read', async ({ page, extensionId }) => {
  await page.goto(await extensionEntryUrl(extensionId, 'import'))
  await seedFlow(page, demoFlowJson('https://www.example.com', { name: 'Phone flow', value: '111' }))
  const original = await page.evaluate(async () => {
    const result = await (globalThis as any).chrome.runtime.sendMessage({ type: 'sp:getFlows' })
    return result.flows[0]
  })

  // 导入页流程清单的独立启用开关（DEC-016）置为启用——优化的暂停分支以此为目标
  await page.getByRole('button', { name: /^(Enable|启用)$/ }).first().click()
  await expect(page.locator('.im-badge.enabled').first()).toBeVisible()

  // 工作台详情内的「用 AI 优化」：暂停 + 授权，编辑器保持打开并显示剩余分钟
  await openWorkbench(page, extensionId)
  await ackOnboarding(page)
  await page.getByRole('button', { name: /^(View \/ Edit|查看 \/ 编辑)$/ }).click()
  await page.getByRole('button', { name: /^(Improve with AI|用 AI 优化)$/ }).click()
  await expect(
    page.locator('.sp-progress[role="status"]', { hasText: /^Read access granted for \d+ min|^已授权读取 \d+ 分钟/ }),
  ).toBeVisible()

  // 事实断言：流程已暂停；读取授权确实指向该流程（TTL 与过期行为由单测覆盖）。
  // 授权记录按键名无关的形状识别（{flowId, grantedAt}），不绑定 wxt storage 的键映射细节
  const state = await page.evaluate(async (flowId: string) => {
    const flows = await (globalThis as any).chrome.runtime.sendMessage({ type: 'sp:getFlows' })
    const stored = await (globalThis as any).chrome.storage.session.get(null)
    const grant = Object.values(stored).find(
      (v: any) => v !== null && typeof v === 'object' && 'flowId' in v && 'grantedAt' in v,
    ) ?? null
    return {
      status: flows.flows.find((r: { id: string }) => r.id === flowId)?.status,
      grant,
    }
  }, original.id)
  expect(state.status).toBe('paused')
  expect(state.grant).toMatchObject({ flowId: original.id })
})
