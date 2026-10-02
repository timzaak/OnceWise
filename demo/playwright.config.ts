import { defineConfig } from '@playwright/test'

// OnceWise AI 扩展 Demo（demo/e2e/extension/**）的 Playwright 配置。
// - 独立扩展模式：不配置 webServer，不启动任何 Web 后端/前端环境；扩展加载、临时 profile
//   与页面均由 demo/e2e/extension/fixtures.ts 管理（runner 只执行测试，不提供环境）
// - testMatch 只发现扩展用例（**/extension/**/*.e2e.ts），后续新增其它 Web Demo 用例时互不影响
// - workers 1 且 fullyParallel false：每个用例独占一个 persistent context 加载扩展，串行执行
//   保证 profile 隔离与结果稳定
// - 唯一 project demo-fast（headless）：runner 固定选择该 project；扩展 fixture 在
//   launchPersistentContext 中使用 channel: 'chromium'，这是 headless 加载 MV3 扩展的前提
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/extension/**/*.e2e.ts',
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  outputDir: 'test-results/artifacts',
  reporter: [['list'], ['html', { open: 'never' }]],
  projects: [{ name: 'demo-fast', use: { headless: true } }],
})
