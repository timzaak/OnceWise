import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePort } from './sync-server'

// 宿主静态页服务：在随机端口提供 extension/test-pages/ 下的页面（执行证据的目标页面），
// 每用例独立实例；form-page.html 是同步故事的流程目标页（#contactPhone 输入 + 页面指纹
// urlIncludes '/form-page.html'）。
const pagesDir = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'extension', 'test-pages')

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

export interface HostSite {
  origin: string
  formUrl: string
  packingUrl: (scenario: 'ok' | 'invalid-data' | 'never-save', groups?: number, biz?: string) => string
  wizardStepUrl: (step: 1 | 2 | 3, opts?: { biz?: string; openNewTab?: boolean }) => string
  close: () => Promise<void>
}

export async function startHostSite(opts: { slowStep3?: boolean } = {}): Promise<HostSite> {
  const port = await freePort()
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? ''
    // 向导第 3 步的慢就绪受控信号（?scenario=slow，约 3 秒延迟）只能经查询参数进入，而向导表单
    // 是 GET 提交、不带查询参数——slowStep3 模式以 302 把该参数投递到「表单提交发起的导航」上；
    // 页面的延迟行为仍是页面自己的（见 extension/test-pages/README.md）。
    const base = path.basename(url.split('?')[0] ?? '')
    if (opts.slowStep3 && base === 'wizard-step3.html' && !url.includes('scenario=slow')) {
      res.writeHead(302, { location: `${url}${url.includes('?') ? '&' : '?'}scenario=slow` })
      res.end()
      return
    }
    // 只按 basename 提供静态文件，不暴露目录枚举
    const file = path.join(pagesDir, base)
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    formUrl: `${origin}/form-page.html`,
    // packing-page 的受控失败信号经查询参数注入（?scenario=invalid-data 等），同页承载多场景
    packingUrl: (scenario, groups = 2, biz = 'B-0001') =>
      `${origin}/packing-page.html?scenario=${scenario}&groups=${groups}&biz=${biz}`,
    // 跨页向导三页（wizard-step{1,2,3}.html）；?biz= 覆盖业务号，?open=new-tab 使第 2 步确认
    // 以 target=_blank 打开第 3 步
    wizardStepUrl: (step, opts = {}) => {
      const params = new URLSearchParams()
      if (opts.biz !== undefined) params.set('biz', opts.biz)
      if (opts.openNewTab) params.set('open', 'new-tab')
      const query = params.toString()
      return `${origin}/wizard-step${step}.html${query ? `?${query}` : ''}`
    },
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}
