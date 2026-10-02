# Chrome Web Store 上线材料包

本文件夹是 OnceWise AI 扩展上架 Chrome Web Store 的全部材料与发布清单。除截图产物外,所有文案为"粘贴即用"形态;隐私相关声明与 `docs/privacy-policy.md`(2026-09-30 版)同源,政策变更后需同步修订。

## 文件索引

| 文件 | 用途 |
| --- | --- |
| `listing-en.md` | 默认 listing:详细描述(EN),短描述取 manifest `extDescription` |
| `listing-zh.md` | 中文 listing:详细描述(ZH) |
| `privacy-declarations.md` | Privacy 标签页:单一用途声明、逐权限理由、数据用途问卷答案、审核备注 |
| `screenshots.md` | 截图/宣传图清单、上传顺序、拍摄纪律、再生成方法 |
| `screenshots/` | 9 张图形产物(7 截图 + 2 宣传图),采集脚本自动生成 |

## 控制台字段映射

| 控制台位置 | 取材 |
| --- | --- |
| Store listing → Summary(短描述) | `extension/public/_locales/{en,zh}/messages.json` 的 `extDescription` |
| Store listing → Detailed description | `listing-en.md` / `listing-zh.md` 正文 |
| Store listing → Category / Language | Productivity;English(默认)+ Chinese(Simplified,可选) |
| Store listing → Screenshots / Promo tiles | `screenshots/`(顺序见 `screenshots.md`) |
| Privacy → Privacy policy URL | `https://timzaak.github.io/OnceWise/`(发布步骤见下) |
| Privacy → Single purpose | `privacy-declarations.md` §1 |
| Privacy → 权限理由(逐条) | `privacy-declarations.md` §2 |
| Privacy → 数据用途 / 认证 | `privacy-declarations.md` §3 |
| Privacy → 远程代码 | 无远程托管代码(`privacy-declarations.md` §4) |
| 提审时的审核备注(可选) | `privacy-declarations.md` §5 |

## 发布步骤(按序执行)

1. **开发者账号**:Chrome Web Store 开发者注册(一次性 $5)。
2. **开源**——决策已定(2026-09-30):仓库**全部内容公开**,包括 `docs/prd/`、`docs/user-stories/`、`DESIGN.md`("都暴露",不做裁剪)。操作:`gh repo edit timzaak/OnceWise --visibility public` 后 `git push origin main`。
3. **隐私政策页面上线**(两步,详见 `docs/privacy-policy.md` 头部):`git push origin gh-pages` → 启用 Pages(gh-pages 分支根目录)。得到 URL 后填入控制台 Privacy 标签页。**切勿**改用 main 的 `/docs` 发布。
4. **打包**:`cd extension && npm run build && npm run zip` → 产物 `.output/chrome-mv3-*.zip`。
5. **上传与填报**:开发者控制台 → New item → 上传 zip → 按上表逐项粘贴/上传。
6. **提审**:全站 host 权限的审核周期偏长(数天到数周),材料齐后尽早提交;提审时贴上 `privacy-declarations.md` §5 审核备注。
7. **上架后核验(关键)**:确认商店版扩展 ID 仍为 `fkkfdckchahnjkcbimnbhonbgcefnafi`(manifest 带 pinned key 上传应保留该 ID)。若商店分配了新 ID,`skills/oncewise-message/protocol.mjs` 的 `EXTENSION_ID` 与宿主 manifest 的 `allowed_origins` 必须同步更新,否则 AI 交接通道对新装用户全部失效。

## 维护纪律

- 扩展 UI 变化后重跑采集刷新全部截图:`uv run scripts/web-demo-test-runner.py demo/e2e/extension/listing/capture-listing.e2e.ts --run-id <唯一ID>`(入口说明见 `scripts/index.md`)。
- 隐私政策修订后:更新 `docs/privacy-policy.md` 生效日期 → 同步 `gh-pages` 的 `index.html` → 核对本包 `privacy-declarations.md` 与政策无出入。
- 版本号递增:`extension/package.json`(当前 1.0.1)。
