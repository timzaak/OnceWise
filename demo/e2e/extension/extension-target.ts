import path from 'node:path'
import { fileURLToPath } from 'node:url'

// OnceWise AI 扩展 MV3 生产构建产物目录：
// 在 extension/ 目录执行 `npm run build` 生成 extension/.output/chrome-mv3（相对项目根）。
// 注意：extension/.output/chrome-mv3-dev 是 `npm run dev` 的热更新产物，不能作为验证输入。
// 从本文件位置向上三级解析项目根，不依赖执行命令时的 cwd。
export const extensionPath = path.resolve(
  fileURLToPath(new URL('../../../', import.meta.url)),
  'extension/.output/chrome-mv3',
)
