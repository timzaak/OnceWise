import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
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

// 店铺资产采集(非验收用例):加载真实构建产物,播种演示流程,为 Chrome Web Store 生成
// 宣传式截图(1280×800:一句大标语 + 单一焦点卡片,卡片为真实 UI 的 1:1 元素裁片)与
// 宣传图(440×280 / 1400×560),直接写入 docs/store-listing/screenshots/。清单与再生成
// 说明见 docs/store-listing/screenshots.md;不入 CI,除各画面就绪等待外仅含一条执行效果
// 守卫断言(启用流程后宿主表单电话填值回显,只断言不截图),非业务验收。
// 版式纪律:每张图一个焦点、一句标语,整面板/多卡片裁片会显乱,不采用。
// 演示数据纪律:仅假数据(13800001234 样式电话、127.0.0.1 测试页),不得出现真实个人信息;
// 流程种子 displayLabel 用英文(商店默认 listing 为英文,截图各语言共用)。

const FLOW_NAME = 'Fill contact phone'
const PHONE = '13800001234'

// 元素在窄视口下按侧边栏真实宽度渲染(整面板裁片太密,只取单卡片作焦点);import 是整页布局,稍宽。
const PANEL_W = 480
const IMPORT_W = 640
const CANVAS_W = 1280
const CANVAS_H = 800

const shotsDir = path.resolve(
  fileURLToPath(new URL('../../../../docs/store-listing/screenshots', import.meta.url)),
)

async function shot(page: Page, file: string): Promise<void> {
  await page.screenshot({ path: path.join(shotsDir, file) })
}

// 焦点卡片裁片(1:1 原尺寸,返回 base64 数据 URL,不落盘中间产物)
async function cropOf(locator: Locator): Promise<string> {
  const buf = await locator.screenshot()
  return `data:image/png;base64,${buf.toString('base64')}`
}

test.setTimeout(180_000)

test('capture store listing screenshots and promo tiles', async ({ page, extensionId }) => {
  autoAcceptDialogs(page)
  await mkdir(shotsDir, { recursive: true })

  const host = await startHostSite()
  try {
    await page.setViewportSize({ width: PANEL_W, height: CANVAS_H })

    // 素材:首启说明的「数据边界(本地优先)」字段块(确认前整页替换工作台,DEC-011)
    await openWorkbench(page, extensionId)
    const onboardingTitle = page.locator('h2.sp-title', { hasText: /^(How to Use|使用说明)$/ })
    await expect(onboardingTitle).toBeVisible({ timeout: 15_000 })
    const dataBoundary = page.locator('div.sp-field').filter({
      has: page.locator('.sp-label', { hasText: /^(Data boundary|数据边界)/ }),
    })
    await expect(dataBoundary).toBeVisible()
    const dataBoundaryShot = await cropOf(dataBoundary)
    await ackOnboarding(page)

    // 播种两条演示流程:一条待启用执行,一条保持未启用(展示开关态差异)
    await seedFlow(page, demoFlowJson(host.origin, { name: FLOW_NAME, value: PHONE, label: 'Contact phone' }))
    await seedFlow(page, demoFlowJson(host.origin, { name: 'Weekly packing flow', value: '13900005678', label: 'Contact phone' }))

    // 素材:启用态流程卡(Enabled 徽标 + 操作按钮 + 脱敏描述)
    await enableFlowFromFlowsTab(page, FLOW_NAME)
    await expect(flowCardLocation(page, 'Weekly packing flow')).toBeVisible()
    const flowsShot = await cropOf(flowCardLocation(page, FLOW_NAME))

    // 素材:编辑器「动作清单」卡(流程可见可改,不是黑盒)
    await openFlowsTab(page)
    await flowCardLocation(page, FLOW_NAME).getByRole('button', { name: /^(View \/ Edit|查看 \/ 编辑)$/ }).click()
    await expect(page.locator('#flow-name')).toHaveValue(FLOW_NAME)
    const actionsCard = page.locator('section.sp-card').filter({
      has: page.locator('h2.sp-title', { hasText: /^(Actions|动作清单)$/ }),
    })
    await expect(actionsCard).toBeVisible()
    const actionsShot = await cropOf(actionsCard)

    // 素材:版本历史卡。两次改名再改回,制造 v1/v2/v3 三版(终名不变)
    await renameFlowViaEditor(page, FLOW_NAME, `${FLOW_NAME} — alt`)
    await renameFlowViaEditor(page, `${FLOW_NAME} — alt`, FLOW_NAME)
    await openFlowsTab(page)
    await flowCardLocation(page, FLOW_NAME).getByRole('button', { name: /^(View \/ Edit|查看 \/ 编辑)$/ }).click()
    const history = page.locator('section.sp-card').filter({
      has: page.locator('h2.sp-title', { hasText: /^(Version history|版本历史)$/ }),
    })
    await expect(history).toBeVisible()
    await expect(history.locator('li')).toHaveCount(3)
    const historyShot = await cropOf(history)

    // 素材:同步页签「服务器」卡(无需真实后端;标题带 ⓘ 自托管链接,前缀匹配)
    await openSyncTab(page)
    const serverCard = page.locator('section.sp-card').filter({
      has: page.locator('h2.sp-title', { hasText: /^(Server|服务器)/ }),
    })
    await expect(serverCard).toBeVisible()
    const serverShot = await cropOf(serverCard)

    // 素材:流程导入页「已保存流程」摘要卡(AI 交接锚点)。
    // 隐藏通道状态行:它是运行时探针的即时显示,采集环境无本机宿主必然为"未连接",
    // 与本图要传达的交接入口无关(等价于裁切取舍,不伪造功能)。
    const importPage = await openExtensionPage(page.context(), extensionId, 'import')
    await importPage.setViewportSize({ width: IMPORT_W, height: CANVAS_H })
    await importPage.addStyleTag({ content: '.im-hint { display: none !important; }' })
    await expect(importPage.locator('h1')).toBeVisible({ timeout: 15_000 })
    const savedCard = importPage.locator('main.im-main section.im-card').first()
    await expect(savedCard).toBeVisible()
    const importShot = await cropOf(savedCard)
    await importPage.close()

    // 执行效果守卫(不截图):启用于上文的流程,打开宿主表单即应已自动填入电话
    const form = await page.context().newPage()
    await form.goto(host.formUrl)
    await expect(form.locator('#contactPhone')).toHaveValue(PHONE, { timeout: 15_000 })
    await form.close()

    // 合成宣传式截图:浅色清新画布(产品同源 #f7f7f5 + 薄荷光晕)+ 一句大标语(含青绿重音词)
    // + 一行副文 + 焦点卡片(pad: 裸字段类裁片自带无内边距,由白框补;整卡裁片自带内边距,不加)
    const compose = async (file: string, o: { title: string; sub: string; img: string; pad?: boolean }) => {
      const tile = await page.context().newPage()
      await tile.setViewportSize({ width: CANVAS_W, height: CANVAS_H })
      await tile.setContent(marketingHtml(o))
      await shot(tile, file)
      await tile.close()
    }
    await compose('01-hero.png', {
      title: 'Web routines that run <em>themselves</em>.',
      sub: 'Enable a flow once. Matching pages take it from there.',
      img: flowsShot,
    })
    await compose('02-ai-handover.png', {
      title: 'Built by your AI. <em>Approved</em> by you.',
      sub: 'The handover channel never leaves your machine.',
      img: importShot,
    })
    await compose('03-editor.png', {
      title: 'Every step in <em>plain sight</em>.',
      sub: 'A short, readable step list. No black boxes.',
      img: actionsShot,
    })
    await compose('04-history.png', {
      title: 'Ten versions kept. <em>One click</em> back.',
      sub: 'Roll back any change, any time.',
      img: historyShot,
    })
    await compose('05-local-first.png', {
      title: 'Your data <em>never</em> leaves the browser.',
      sub: 'No accounts, no analytics, no telemetry, no ads.',
      img: dataBoundaryShot,
      pad: true,
    })
    await compose('06-sync.png', {
      title: 'Optional, <em>self-hosted</em> sync.',
      sub: 'Your server, your space codes, your teammates.',
      img: serverShot,
    })

    // 宣传图:与扩展图标同源的品牌元素(#008f83 青绿底、白卡、白环勾选圆),分小/大两种版式
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

// 宣传式截图版式:浅色画布取产品同源色(#f7f7f5 暖白 + #e8f7f4 薄荷
// 光晕),左侧一句大标语(墨色 + 青绿重音词)+ 一行副文;右侧单一焦点卡片(真实 UI 的 1:1 元素
// 裁片,白框细边 + 轻投影)。品牌元素取自 extension/public/icon/source.svg(#008f83 底、
// 白卡、白环勾选圆),不引入外部资源。
function marketingHtml(o: { title: string; sub: string; img: string; pad?: boolean }): string {
  const mark = `
    <svg width="34" height="34" viewBox="0 0 128 128" aria-hidden="true">
      <rect x="4" y="4" width="120" height="120" rx="24" fill="#008f83"/>
      <rect x="27" y="23" width="74" height="82" rx="9" fill="#ffffff"/>
      <rect x="39" y="42" width="35" height="8" rx="4" fill="#008f83"/>
      <rect x="39" y="59" width="49" height="7" rx="3.5" fill="#cececa"/>
      <rect x="39" y="74" width="24" height="7" rx="3.5" fill="#cececa"/>
      <circle cx="84.5" cy="87.5" r="19" fill="#08786f" stroke="#ffffff" stroke-width="4.5"/>
      <path d="m76.5 88 6 6 11.5-12.5" fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; }
    body {
      font-family: -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      background: radial-gradient(1000px 700px at 80% 22%, #e8f7f4 0%, rgba(232, 247, 244, 0) 58%) #f7f7f5;
      color: #151515; display: flex; align-items: center; padding: 80px; gap: 80px;
    }
    .col { flex: 1; min-width: 0; max-width: 560px; }
    .eyebrow { display: flex; align-items: center; gap: 14px; color: #08786f; font-size: 15px; font-weight: 700; letter-spacing: 0.18em; }
    h1 { margin-top: 28px; font-size: 62px; line-height: 1.1; font-weight: 750; letter-spacing: -0.02em; }
    h1 em { font-style: normal; color: #008f83; }
    .sub { margin-top: 22px; font-size: 20px; line-height: 1.5; color: #626262; font-weight: 500; max-width: 40ch; }
    .frame { flex: none; align-self: center; max-width: 720px; border-radius: 16px; overflow: hidden;
      box-shadow: 0 30px 70px rgba(21, 21, 21, 0.12), 0 4px 14px rgba(21, 21, 21, 0.06), 0 0 0 1px #e2e2e0;
      background: #ffffff; }
    .frame.padded { padding: 28px 32px; }
    .frame img { display: block; max-height: 620px; max-width: 720px; }
  </style></head><body>
    <div class="col">
      <div class="eyebrow">${mark}<span>ONCEWISE FLOW</span></div>
      <h1>${o.title}</h1>
      <p class="sub">${o.sub}</p>
    </div>
    <div class="frame${o.pad ? ' padded' : ''}"><img alt="" src="${o.img}"></div>
  </body></html>`
}

// 宣传图:浅色画布与截图同源,品牌元素取自 extension/public/icon/source.svg
// (青绿圆角方 + 白卡 + 白环勾选圆),薄荷底特性胶囊 + 白卡流程示意,不引入外部资源。
function promoHtml(size: 'small' | 'large'): string {
  const s = size === 'small'
  const mark = s ? 76 : 152
  const title = s ? 34 : 84
  const tagline = s ? 15 : 34
  const chip = s ? 12 : 24
  const pad = s ? 28 : 64
  const markSvg = (d: number) => `
    <svg width="${d}" height="${d}" viewBox="0 0 128 128" aria-hidden="true">
      <rect x="4" y="4" width="120" height="120" rx="24" fill="#008f83"/>
      <rect x="27" y="23" width="74" height="82" rx="9" fill="#ffffff"/>
      <rect x="39" y="42" width="35" height="8" rx="4" fill="#008f83"/>
      <rect x="39" y="59" width="49" height="7" rx="3.5" fill="#cececa"/>
      <rect x="39" y="74" width="24" height="7" rx="3.5" fill="#cececa"/>
      <circle cx="84.5" cy="87.5" r="19" fill="#08786f" stroke="#ffffff" stroke-width="4.5"/>
      <path d="m76.5 88 6 6 11.5-12.5" fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`
  const chips = ['Local-first', 'Site-scoped', 'AI-imported']
    .map(c => `<span class="chip">${c}</span>`).join('')
  const flows = [1, 2, 3].map(i => `
    <div class="flow">
      <span class="dot"></span>
      <span class="line l${i}"></span>
    </div>`).join('')
  // 小图(440×280)文字列只有 ~166px,三枚胶囊在标题下必折两行;改为品牌行下方整行通排,
  // 一行放下。大图宽度充足,维持胶囊随标题的原结构。
  const content = s
    ? `<div class="row">
        <div class="brand">${markSvg(mark)}<div class="text">
          <h1>OnceWise Flow</h1>
          <p>Web routines that run themselves.</p>
        </div></div>
        <div class="stack">${flows}</div>
      </div>
      <div class="chips">${chips}</div>`
    : `<div class="brand">${markSvg(mark)}<div class="text">
        <h1>OnceWise Flow</h1>
        <p>Web routines that run themselves.</p>
        <div class="chips">${chips}</div>
      </div></div>
      <div class="stack">${flows}</div>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; }
    body {
      font-family: -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      background: radial-gradient(${s ? 340 : 780}px ${s ? 260 : 520}px at 82% 20%, #e8f7f4 0%, rgba(232, 247, 244, 0) 60%) #f7f7f5;
      color: #151515; display: flex; flex-direction: ${s ? 'column' : 'row'}; justify-content: center;
      align-items: ${s ? 'stretch' : 'center'};
      padding: ${pad}px; gap: ${pad}px;
    }
    .row { display: flex; align-items: center; }
    .brand { display: flex; align-items: center; gap: ${s ? 18 : 40}px; }
    .text h1 { font-size: ${title}px; font-weight: 750; letter-spacing: -0.02em; line-height: 1.1; }
    .text p { font-size: ${tagline}px; color: #626262; margin-top: ${s ? 8 : 18}px; font-weight: 500; }
    .chips { display: flex; gap: ${s ? 8 : 18}px; margin-top: ${s ? 2 : 30}px; }
    .chip { font-size: ${chip}px; font-weight: 600; color: #08786f; background: #e8f7f4; border: 1px solid #c6e8e1; border-radius: 999px; padding: ${s ? 4 : 10}px ${s ? 10 : 22}px; white-space: nowrap; }
    .stack { margin-left: auto; display: flex; flex-direction: column; gap: ${s ? 10 : 22}px; width: ${s ? 96 : 210}px; }
    .flow { background: #ffffff; border: 1px solid #e2e2e0; border-radius: ${s ? 8 : 16}px; padding: ${s ? 10 : 22}px; display: flex; align-items: center; gap: ${s ? 8 : 16}px; box-shadow: 0 6px 18px rgba(21, 21, 21, 0.06); }
    .dot { width: ${s ? 10 : 20}px; height: ${s ? 10 : 20}px; border-radius: 50%; background: #008f83; flex: none; }
    .line { height: ${s ? 8 : 16}px; border-radius: 4px; background: #cececa; }
    .l1 { width: 70%; } .l2 { width: 52%; } .l3 { width: 84%; }
  </style></head><body>
    ${content}
  </body></html>`
}
