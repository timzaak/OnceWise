# 店铺截图与宣传图清单

图形材料规格(以控制台当日要求为准):

| 材料 | 规格 | 数量 |
| --- | --- | --- |
| 截图 | 1280×800(或 640×400),PNG | ≥1,控制台一般展示前 5 张 |
| 小宣传图(Small promo tile) | 440×280,PNG | 1(影响推荐位资格) |
| 大宣传图(Marquee promo tile) | 1400×560,PNG | 1(可选) |
| 图标 | 128×128 | 已有(`extension/public/icon/128.png`,manifest 引用) |

## 建议上传顺序(前 5 张上墙面)

`02-flows` → `03-editor` → `04-history` → `06-import` → `07-run`;`01-onboarding` 与 `05-sync` 作补充位。

## 截图清单

全部截图来自真实构建产物 + 演示数据,生成方式见下"再生成"。UI 为英文(商店默认语言 listing;截图各语言 listing 共用)。

| 文件 | 内容 | 想传达的信息 |
| --- | --- | --- |
| `screenshots/01-onboarding.png` | 首次打开的使用说明/隐私承诺视图 | 上手引导 + 本地优先承诺 |
| `screenshots/02-flows.png` | 流程工作台,2 条流程(1 条 Enabled 徽标) | 核心界面:流程卡片、开关、脱敏描述 |
| `screenshots/03-editor.png` | 流程编辑器(名称/站点/触发器/步骤/输入区) | 流程可见可改,不是黑盒 |
| `screenshots/04-history.png` | 编辑器内版本历史(v3 当前 + v2/v1,带回滚) | 10 版历史 + 回滚,安全网 |
| `screenshots/05-sync.png` | 同步页签(服务器视图) | 可选自托管同步 |
| `screenshots/06-import.png` | 流程导入页(交付摘要卡 + 本机通道连接状态 + 流程清单开关) | AI 交接的真实入口与数据边界声明 |
| `screenshots/07-run.png` | 流程在测试页执行后的效果(联系电话已自动填入) | "启用后自动执行"的实证 |
| `promo-440x280.png` | 小宣传图(品牌深底 + 勾选徽标 + 标语 + 三枚特性胶囊) | — |
| `promo-1400x560.png` | 大宣传图(同源设计,右侧模拟流程卡) | — |

已目检(2026-09-30):9 张尺寸精确、无裁切/重叠;07-run 页面本身无自动化指示物(产品常规运行不留痕),靠上传顺序与详细描述文案补足语境,不伪造横幅。

## 拍摄纪律

- 演示数据一律使用假数据(`13800001234` 样式电话、`http://127.0.0.1:<port>` 本地测试页),不得出现真实个人信息、真实账号或内部环境。
- 店铺截图只展市扩展自身 UI 与测试页,不出现开发者工具、书签栏等本地环境痕迹。
- 演示流程名使用业务化名称(如 "Fill contact phone"),不用 "Demo flow 138" 这类内部叫法。

## 再生成

截图由 demo 基建自动生成(加载真实构建产物、播种演示流程、按上表逐一截屏):

```bash
cd extension && npm run build      # 前置:新鲜构建
cd demo && npm install && npx playwright install chromium   # 首次
uv run scripts/web-demo-test-runner.py demo/e2e/extension/listing/capture-listing.e2e.ts --run-id <唯一ID>
```

产物直接写入 `docs/store-listing/screenshots/`(采集脚本 `demo/e2e/extension/listing/capture-listing.e2e.ts` 不做断言,只生成资产;它不在 CI 运行,不属于验收用例)。改 UI 后重跑即可刷新全部截图与宣传图。
