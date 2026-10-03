import { expect, test } from '../fixtures'

// 冒烟用例：验证 MV3 生产构建产物（extension/.output/chrome-mv3）能被真实 Chromium 加载，
// 并通过 sidepanel 工作台页面观察最小用户可见结果。
// 入口选择：当前扩展没有 popup（wxt.config.ts —— action 无 default_popup，工具栏图标点击由
// background 的 openPanelOnActionClick 直接打开 sidepanel），sidepanel.html 是主 UI 入口；
// 页面路径从 manifest.side_panel.default_path 读取，不硬编码。
// 确定性链路（全新临时 profile、storage 为空）：
// 1) 首次打开显示 onboarding 声明视图（DEC-011：首次打开必现，确认后写入 seen 标记）；
// 2) 点击确认后进入工作台导航（3 个视图 tab）；
// 3) 流程视图向 background 发送真实消息 sp:getFlows，空 profile 下收敛到空态提示。
// 文本断言同时匹配 en/zh 两个内置目录（lib/i18n.ts 按浏览器 UI 语言选择），不依赖运行语言。
// 范围说明（初始化阶段不覆盖，留给后续用户故事用例）：
// - 工具栏图标点击打开 side panel 的真实生命周期（Side Panel API 需要用户手势）；
// - content script：按流程 site 动态注册（manifest 无固定宿主，host 权限于安装时统一获得）。
test('sidepanel 工作台加载：首次打开显示使用说明，确认后进入工作台', async ({
  page,
  extensionManifest,
  extensionId,
}) => {
  const sidePanelPath = extensionManifest.side_panel?.default_path
  expect(sidePanelPath, 'manifest.side_panel.default_path 必须存在').toBeTruthy()

  // 在本次加载的扩展实例中打开 sidepanel 页面
  await page.goto(`chrome-extension://${extensionId}/${String(sidePanelPath).replace(/^\//, '')}`)

  // 校验页面确实运行在本次加载的扩展里，而不是其它扩展或普通页面
  const runtimeId = await page.evaluate(() => {
    const runtime = (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime
    return runtime?.id ?? ''
  })
  expect(runtimeId).toBe(extensionId)

  // 首次打开：onboarding 声明视图（OnboardingView.tsx —— h2.sp-title + primary 确认按钮）
  const onboardingTitle = page.locator('h2.sp-title')
  await expect(onboardingTitle).toHaveText(/^(How to Use|使用说明)$/)
  const ackButton = page.locator('button.sp-btn.primary')
  await expect(ackButton).toHaveText(/^(I have read and understand|我已阅读并理解)$/)

  // 确认声明：写入本地 seen 标记后进入工作台导航（App.tsx —— nav.sp-nav 下 3 个视图 tab）
  await ackButton.click()
  const tabs = page.locator('nav.sp-nav .sp-tab')
  await expect(tabs).toHaveCount(3)

  // 流程视图收敛：sp:getFlows 在空 profile 下返回空列表，渲染空态提示（而非停留在加载态）
  await expect(page.locator('main.sp-main .sp-empty')).toBeVisible()
})
