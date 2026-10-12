// 把 extension/public/icon/source.svg 栅格化为 manifest 引用的五个尺寸。
// 依赖 demo 已装的 playwright,从 demo 目录运行:node scripts/render-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const svg = readFileSync(path.join(root, 'extension/public/icon/source.svg'), 'utf8')
const sizes = [16, 32, 48, 96, 128]

const browser = await chromium.launch()
const page = await browser.newPage()
for (const size of sizes) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<!doctype html><style>
    * { margin: 0; padding: 0; }
    html, body { width: ${size}px; height: ${size}px; overflow: hidden; }
    svg { display: block; width: ${size}px; height: ${size}px; }
  </style>${svg}`)
  await page.screenshot({ path: path.join(root, `extension/public/icon/${size}.png`) })
  console.log(`wrote ${size}.png`)
}
await browser.close()
