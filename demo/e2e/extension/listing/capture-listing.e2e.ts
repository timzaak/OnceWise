import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, openExtensionPage, test } from '../fixtures'
import {
  ackOnboarding,
  autoAcceptDialogs,
  demoFlowJson,
  enableFlowFromFlowsTab,
  openFlowsTab,
  openSyncTab,
  openWorkbench,
  renameFlowViaEditor,
  flowCardLocation,
  seedFlow,
} from '../workbench'
import { startHostSite } from '../host-site'

// 店铺资产采集(非验收用例):加载真实构建产物,播种演示流程,把 Chrome Web Store 所需
// 截图(1280×800)与宣传图(440×280 / 1400×560)直接写入 docs/store-listing/screenshots/。
// 清单与再生成说明见 docs/store-listing/screenshots.md;不入 CI,除截图就绪门外仅含一条
// 执行效果守卫断言(联系电话填值回显),非业务验收。
// 演示数据纪律:仅假数据(13800001234 样式电话、127.0.0.1 测试页),不得出现真实个人信息。

const FLOW_NAME = 'Fill contact phone'
const PHONE = '13800001234'

const shotsDir = path.resolve(
  fileURLToPath(new URL('../../../../docs/store-listing/screenshots', import.meta.url)),
)

async function shot(page: Page, file: string): Promise<void> {
  await page.screenshot({ path: path.join(shotsDir, file) })
}

test('capture store listing screenshots and promo tiles', async ({ page, extensionId }) => {
  autoAcceptDialogs(page)
  await mkdir(shotsDir, { recursive: true })
  await page.setViewportSize({ width: 1280, height: 800 })

  const host = await startHostSite()
  try {
    // 01 首启使用说明视图(确认前整页替换工作台,DEC-011)
    await openWorkbench(page, extensionId)
    await expect(page.locator('h2.sp-title', { hasText: /^(How to Use|使用说明)$/ })).toBeVisible({ timeout: 15_000 })
    await shot(page, '01-onboarding.png')
    await ackOnboarding(page)

    // 播种两条演示流程:一条待启用执行,一条保持未启用(展示开关态差异)
    await seedFlow(page, demoFlowJson(host.origin, { name: FLOW_NAME, value: PHONE }))
    await seedFlow(page, demoFlowJson(host.origin, { name: 'Weekly packing flow', value: '13900005678' }))

    // 02 流程工作台(1 条 Enabled 徽标)
    await enableFlowFromFlowsTab(page, FLOW_NAME)
    await expect(flowCardLocation(page, 'Weekly packing flow')).toBeVisible()
    await shot(page, '02-flows.png')

    // 03 流程编辑器
    await openFlowsTab(page)
    await flowCardLocation(page, FLOW_NAME).getByRole('button', { name: /^(View \/ Edit|查看 \/ 编辑)$/ }).click()
    await expect(page.locator('#flow-name')).toHaveValue(FLOW_NAME)
    await shot(page, '03-editor.png')

    // 04 版本历史:两次改名再改回,制造 v1/v2/v3 三版(终名不变)
    await renameFlowViaEditor(page, FLOW_NAME, `${FLOW_NAME} — alt`)
    await renameFlowViaEditor(page, `${FLOW_NAME} — alt`, FLOW_NAME)
    await openFlowsTab(page)
    await flowCardLocation(page, FLOW_NAME).getByRole('button', { name: /^(View \/ Edit|查看 \/ 编辑)$/ }).click()
    const history = page.locator('section.sp-card').filter({
      has: page.locator('h2.sp-title', { hasText: /^(Version history|版本历史)$/ }),
    })
    await expect(history).toBeVisible()
    await expect(history.locator('li')).toHaveCount(3)
    await shot(page, '04-history.png')

    // 05 同步页签(服务器视图;无需真实后端)
    await openSyncTab(page)
    await shot(page, '05-sync.png')

    // 06 流程导入页(AI 交接锚点页:保存摘要卡 + 本机通道连接状态 + 流程清单开关)
    const importPage = await openExtensionPage(page.context(), extensionId, 'import')
    await importPage.setViewportSize({ width: 1280, height: 800 })
    await expect(importPage.locator('h1')).toBeVisible({ timeout: 15_000 })
    await shot(importPage, '06-import.png')
    await importPage.close()

    // 07 流程在测试页执行后的效果(启用于 02 步,真实注册路径)
    const form = await page.context().newPage()
    await form.setViewportSize({ width: 1280, height: 800 })
    await form.goto(host.formUrl)
    await expect(form.locator('#contactPhone')).toHaveValue(PHONE, { timeout: 15_000 })
    await shot(form, '07-run.png')
    await form.close()

    // 宣传图:与扩展图标同源的品牌元素(#151515 底、#008f83 勾选圆),分小/大两种版式
    const tile = await page.context().newPage()
    await tile.setViewportSize({ width: 440, height: 280 })
    await tile.setContent(promoHtml('small'))
    await shot(tile, 'promo-440x280.png')
    await tile.setViewportSize({ width: 1400, height: 560 })
    await tile.setContent(promoHtml('large'))
    await shot(tile, 'promo-1400x560.png')
    await tile.close()
  } finally {
    // Chromium keep-alive sockets can keep server.close() pending past the assets' usefulness;
    // 资产已全部落盘,清理不阻塞用例收尾(故事用例的 await close 在此场景会挂到超时)
    host.close().catch(() => undefined)
  }
})

// 品牌元素取自 extension/public/icon/source.svg(深底圆角方 + 白卡 + 勾选圆),不引入外部资源。
function promoHtml(size: 'small' | 'large'): string {
  const s = size === 'small'
  const mark = s ? 76 : 152
  const title = s ? 34 : 84
  const tagline = s ? 15 : 34
  const chip = s ? 12 : 24
  const pad = s ? 28 : 64
  const markSvg = (d: number) => `
    <svg width="${d}" height="${d}" viewBox="0 0 128 128" aria-hidden="true">
      <rect x="4" y="4" width="120" height="120" rx="27" fill="#ffffff"/>
      <rect x="27" y="23" width="74" height="82" rx="10" fill="#151515"/>
      <rect x="39" y="38" width="35" height="8" rx="4" fill="#ffffff"/>
      <rect x="39" y="55" width="49" height="7" rx="3.5" fill="#8a8a86"/>
      <rect x="39" y="70" width="30" height="7" rx="3.5" fill="#8a8a86"/>
      <circle cx="85" cy="88" r="21" fill="#008f83"/>
      <path d="m75 88 7 7 13-15" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`
  const chips = ['Local-first', 'Site-scoped', 'AI-imported']
    .map(c => `<span class="chip">${c}</span>`).join('')
  const flows = [1, 2, 3].map(i => `
    <div class="flow">
      <span class="dot"></span>
      <span class="line l${i}"></span>
    </div>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; }
    body {
      font-family: -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      background: #151515; color: #ffffff; display: flex; align-items: center;
      padding: ${pad}px; gap: ${pad}px;
    }
    .brand { display: flex; align-items: center; gap: ${s ? 18 : 40}px; }
    .text h1 { font-size: ${title}px; font-weight: 750; letter-spacing: -0.02em; line-height: 1.1; }
    .text p { font-size: ${tagline}px; color: #b9b9b4; margin-top: ${s ? 8 : 18}px; font-weight: 500; }
    .chips { display: flex; gap: ${s ? 8 : 18}px; margin-top: ${s ? 14 : 30}px; }
    .chip { font-size: ${chip}px; font-weight: 600; color: #37c5b5; border: 1px solid #2e6a63; border-radius: 999px; padding: ${s ? 4 : 10}px ${s ? 10 : 22}px; }
    .stack { margin-left: auto; display: flex; flex-direction: column; gap: ${s ? 10 : 22}px; width: ${s ? 96 : 210}px; }
    .flow { background: #ffffff; border-radius: ${s ? 8 : 16}px; padding: ${s ? 10 : 22}px; display: flex; align-items: center; gap: ${s ? 8 : 16}px; }
    .dot { width: ${s ? 10 : 20}px; height: ${s ? 10 : 20}px; border-radius: 50%; background: #008f83; flex: none; }
    .line { height: ${s ? 8 : 16}px; border-radius: 4px; background: #cececa; }
    .l1 { width: 70%; } .l2 { width: 52%; } .l3 { width: 84%; }
  </style></head><body>
    <div class="brand">${markSvg(mark)}<div class="text">
      <h1>OnceWise AI</h1>
      <p>Web routines that run themselves.</p>
      <div class="chips">${chips}</div>
    </div></div>
    <div class="stack">${flows}</div>
  </body></html>`
}
