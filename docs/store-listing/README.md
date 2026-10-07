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
4. **打包**:`cd extension && npm run build && npm run zip:store` → 产物 `.output/oncewise-ai-<版本>-chrome-store.zip`(`extension/scripts/zip-store.mjs` 复制 `.output/chrome-mv3`、剥掉 manifest 的 `key` 字段后打包,manifest 位于 zip 根)。控制台**拒绝 manifest 含 `key` 字段的上传包**(2026-10-02 实测);`npm run zip` 的产物含 key,不用于商店上传。
5. **上传与填报**:
   - 手动路径:开发者控制台 → 条目 → Package → 上传步骤 4 的 zip(新上架时为 New item,并按上表逐项粘贴/上传)。
   - CI 路径(版本更新推荐):`v*.*.*` 标签触发的 CD 含 `store-upload` 任务,在 `chrome-store` environment 审批门后自动构建剥 key 包、经 Chrome Web Store API(V2)上传为控制台新版本草稿,并把 zip 挂到 Release assets。**不自动提审**——提交审核仍为控制台手动动作(顺序纪律见步骤 7)。一次性配置(需开发者账号本人操作):
     1. GCP:建项目 → 启用 Chrome Web Store API → 建 service account(角色授予可跳过——2026-10-07 实测角色目录中无 Chrome Web Store 专用角色,条目授权在下一步控制台侧完成)→ Keys 标签导出 JSON 私钥(官方步骤见 developer.chrome.com/docs/webstore/service-accounts);
     2. 开发者控制台 设置 页:把 service account 邮箱填入"服务账号"区添加(服务账号将能够通过公共 API 访问所有项),同页"发布商 ID"字段即 `CWS_PUBLISHER_ID`(UUID 形式);
     3. 仓库 Settings → Secrets and variables → Actions:Secrets 加 `CWS_SA_JSON`(JSON 私钥全文)与 `CWS_PUBLISHER_ID`(发布商 UUID),Variables 加 `CWS_UPLOAD_ENABLED=true`(删除或置 false 可随时停用 CI 上传);
     4. Settings → Environments → 新建 `chrome-store` 并配置 required reviewer,作为每次上传的人工审批门(不配置则任务无门直传)。
6. **提审**:全站 host 权限的审核周期偏长(数天到数周),材料齐后尽早提交;提审时贴上 `privacy-declarations.md` §5 审核备注。
7. **上架后核验(关键)**——已核验(2026-10-02):商店分配了新 ID `dmmhmcdbkbbgbcidafhlhepdchjboenc`(商店拒绝 manifest `key` 字段,pinned ID 无法保留)。`skills/oncewise-message/protocol.mjs` 的 `EXTENSION_ID` 已同步为商店 ID(宿主默认 `allowed_origins` 绑定商店版);固定 key 开发构建(`fkkfdckchahnjkcbimnbhonbgcefnafi`,e2e 套件与其本机安装)须显式 `--extension-id fkkfdckchahnjkcbimnbhonbgcefnafi`。后续若出 v1.1.1+ 的 plugin/skills 版本,务必在商店版公开可得后发布,否则商店用户装旧 skills 会把宿主绑到旧 ID,AI 交接通道失效。

## 维护纪律

- 扩展 UI 变化后重跑采集刷新全部截图:`uv run scripts/web-demo-test-runner.py demo/e2e/extension/listing/capture-listing.e2e.ts --run-id <唯一ID>`(入口说明见 `scripts/index.md`)。
- 隐私政策修订后:更新 `docs/privacy-policy.md` 生效日期 → 同步 `gh-pages` 的 `index.html` → 核对本包 `privacy-declarations.md` 与政策无出入。
- 版本号递增:`extension/package.json`(以最新 `git tag` 为准,不在此维护具体版本号)。
