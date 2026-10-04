# OnceWise AI 扩展（Chrome MV3）

WXT + React 构建的 Chrome 扩展：单击工具栏图标直达流程工作台 sidepanel、扩展导入/管理页（`entrypoints/import/`）、按流程站点动态注入的内容脚本运行期与「同步」页签。

- 目录：`entrypoints/`（background / content / sidepanel / import）、`lib/`（约 29 个模块，flow-* / import-* / sync-* 前缀家族）、`test-pages/`（受控测试页，见其 README）
- `tests/`：Vitest 单测，与 `lib/` 近 1:1 镜像命名（跨模块测试以文件头注自述被测面；故事级验收归 `demo/e2e/extension/` 的 demo e2e，单测不做故事回连）
- 构建：`npm run build`（生产构建 → `.output/chrome-mv3`）；开发：`npm run dev`
- 测试与 Demo 运行说明统一维护在仓库根 [scripts/index.md](../scripts/index.md)，本文件不重复维护命令
