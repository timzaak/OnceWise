# 店铺截图与宣传图清单

图形材料规格(以控制台当日要求为准):

| 材料 | 规格 | 数量 |
| --- | --- | --- |
| 截图 | 1280×800(或 640×400),PNG | ≥1,控制台一般展示前 5 张 |
| 小宣传图(Small promo tile) | 440×280,PNG | 1(影响推荐位资格) |
| 大宣传图(Marquee promo tile) | 1400×560,PNG | 1(可选) |
| 图标 | 128×128 | 已有(`extension/public/icon/128.png`,manifest 引用) |

## 截图形态(2026-10-07 改版,同日二改)

商店截图是宣传海报,不是裸产品截图:1280×800 品牌深底画布(#151515,与宣传图同源),每张只放三样东西——左侧一句大标语(含一个品牌色重音词)+ 一行副文,右侧一个焦点卡片(真实 UI 的 1:1 元素裁片,白色圆角框 + 投影)。版式纪律:每张图一个焦点、一句标语;整面板/多卡片/特性胶囊同屏会显乱,不采用(首版教训)。焦点卡片在窄视口下按侧边栏真实宽度渲染采集(侧边栏页 480px、import 整页 640px);裸字段类裁片(无自带内边距)由白框补 28×32px 内边距。画面文案全部英文(商店默认 listing 语言,截图各语言共用);流程种子数据 displayLabel 用英文("Contact phone"),不留中文字形。

07-run(中文宿主表单的执行效果页)已移除:执行效果改由采集用例内的守卫断言保证(启用流程后宿主表单电话自动填值,只断言不截图),画面语境交给标语与详细描述补足。

## 建议上传顺序(前 5 张上墙面)

`01-hero` → `02-ai-handover` → `03-editor` → `04-history` → `05-local-first`;`06-sync` 作补充位。

## 截图清单

| 文件 | 标语(画布左侧) | 焦点卡片(画布右侧,真实 UI 元素) | 想传达的信息 |
| --- | --- | --- | --- |
| `screenshots/01-hero.png` | Web routines that run themselves. | 启用态流程卡(Enabled 徽标 + 操作按钮 + 脱敏描述) | 启用后自动执行的核心价值 |
| `screenshots/02-ai-handover.png` | Built by your AI. Approved by you. | 导入页「Saved flow」摘要卡(名称/站点/触发器/步骤) | AI 交接的真实入口与数据边界 |
| `screenshots/03-editor.png` | Every step in plain sight. | 编辑器「Actions」动作清单卡 | 流程可见可改,不是黑盒 |
| `screenshots/04-history.png` | Ten versions kept. One click back. | 「Version history」卡(v3 当前 + v2/v1,带回滚) | 10 版历史 + 回滚,安全网 |
| `screenshots/05-local-first.png` | Your data never leaves the browser. | 首启说明「Data boundary (local-first)」字段块 | 本地优先承诺 |
| `screenshots/06-sync.png` | Optional, self-hosted sync. | 同步页签「Server」卡 | 可选自托管同步 |
| `promo-440x280.png` | 小宣传图(品牌深底 + 勾选徽标 + 标语 + 三枚特性胶囊) | — | — |
| `promo-1400x560.png` | 大宣传图(同源设计,右侧模拟流程卡) | — | — |

已过视觉验收门(2026-10-07 二版,visual-judge 逐张通过):无中文字形、单一焦点无拼贴感、裁片 1:1 无拉伸无贴边截断、六张版式一致。

## 拍摄纪律

- 演示数据一律使用假数据(`13800001234` 样式电话、`http://127.0.0.1:<port>` 本地测试页),不得出现真实个人信息、真实账号或内部环境。
- 店铺截图只展示扩展自身 UI 与测试页,不出现开发者工具、书签栏等本地环境痕迹。
- 演示流程名使用业务化名称(如 "Fill contact phone"),不用 "Demo flow 138" 这类内部叫法。
- 合成取舍记录:02-ai-handover 的导入页裁片隐藏了 `.im-hint` 通道状态行(运行时探针的即时显示,采集环境无本机宿主必然显示"未连接",与本图要传达的交接入口无关;等价于裁切取舍,不伪造功能)。除此之外不对 UI 内容做增删。

## 再生成

截图由 demo 基建自动生成(加载真实构建产物、播种演示流程、窄视口采集 UI 裁片、合成宣传式截图与宣传图):

```bash
cd extension && npm run build      # 前置:新鲜构建
cd demo && npm install && npx playwright install chromium   # 首次
uv run scripts/web-demo-test-runner.py demo/e2e/extension/listing/capture-listing.e2e.ts --run-id <唯一ID>
```

产物直接写入 `docs/store-listing/screenshots/`(采集脚本 `demo/e2e/extension/listing/capture-listing.e2e.ts` 不做业务验收断言,仅含一条执行效果守卫断言;它不在 CI 运行,不属于验收用例)。改 UI 或改标语后重跑即可刷新全部截图与宣传图;只改标语则编辑脚本内 `compose(...)` 调用的文案参数即可。
