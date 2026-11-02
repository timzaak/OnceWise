# OnceWise Flow — Privacy Policy / 隐私政策

> 用途说明（中文）：本文档是 Chrome Web Store 上架所需隐私政策的唯一来源；"Permissions" 一节的权限理由同时可用作控制台权限说明字段的填写素材。
>
> **发布方式（2026-10-11 已上线）**：隐私政策页随 `docs-web/` 文档站发布（站点含英中双语 `/en/privacy`、`/zh/privacy` 页面，内容取自本文档；更新政策后同步修订 `docs-web/src/components/privacy-page.tsx` 并更新其生效日期）。发布走 `.github/workflows/docs-pages.yml`（main 分支改动 `docs-web/**` 或后端 OpenAPI 面即自动构建部署）；仓库已公开，Pages 已按 Actions 模式启用（`build_type=workflow`，`github-pages` 环境仅允许 main 部署），站点上线于 `https://timzaak.github.io/OnceWise/`。
>
> 控制台 Privacy 标签页填 `https://timzaak.github.io/OnceWise/en/privacy`。旧的独立 `gh-pages` 分支（自包含 index.html）已废弃：Pages 的 Source 只有一个，切到 Actions 模式后该分支不再参与发布（分支保留未删，确认无用后可删）。仍勿改用 main 分支 `/docs` 目录发布——那会把内部 PRD/用户故事一起公开（`docs-web/content/` 是独立维护的对外内容，不含这些）。

---

## English

**OnceWise Flow Browser Extension — Privacy Policy**

Effective date: 2026-11-02

### Overview

OnceWise Flow is a self-service browser automation extension. It turns web page operations you specify into automation flows ("constrained step trees") and runs them on the target pages you choose. The extension is local-first: your data is processed in your browser, nothing leaves your device unless you explicitly save a flow as a script into a sync space or a flow you have reviewed and enabled reaches an upload step that sends data to a server named in that flow, and the extension developer does not sell your data.

### What the extension stores on your device

- Automation flows and their settings, kept in the extension's local storage (`chrome.storage`), together with each flow's version history (the last 10 saved versions, so you can roll back).
- Import history entries for flow files you import (local files only).
- Delivery records for flows your AI tool hands over through the local channel described below (flow ID, delivery reference, timestamps, and a content hash — used to prevent duplicate delivery; they contain no page data and are capped at the last 10 per flow).
- Upload credentials you save under Settings (a name, an HTTP header name and its value) for flows that upload data to your own server. They are stored only on your device: a flow references a credential by name and never contains the header name or the value, so sharing a flow through a sync space shares no secret.
- Short-lived session data used to prevent duplicate submissions on the same business instance (business identifiers only, cleared when the browser session ends).

Data read from web pages during a flow run is processed in memory to execute that flow; it is not persisted by the extension beyond the flow definitions above. Data sent by an upload step, and any response captured from it, is likewise held in memory for that run only.

### Data transmission

The extension makes network requests to exactly two kinds of destinations, and in both cases only as a direct consequence of something you did:

- **The sync server configured in the Sync tab.** The extension ships pre-configured against the official hosted sync service, which is operated by the extension developer; you can switch it to your own oncewise-ai-sync deployment at any time. Opening the Sync tab sends an automated sign-in-mode check to the configured server (it carries no flow data); your flows/scripts and related configuration are transmitted only when you save a script into a space, pull a script, or manage spaces and members — only the content involved in that action. Key spaces authenticate with the space key you hold; sign-in-gated spaces use the server's own sign-in: credentials are entered on the server's login page and never pass through the extension, and the resulting sign-in tokens are stored only on your device.
- **The upload endpoint(s) a flow declares.** A flow may contain an upload step that sends data the flow has read from the page (and values you entered for the flow) to a constant `https://` address written in the flow file. The saved-flow summary and the flow list mark every such step with its destination, the data it sends and the credential name it uses, and a flow only runs after you personally enable it. When the step runs, exactly the data the step declares is sent to exactly that address — nothing else is added — with the single request header of the credential you saved on this device, if the step names one. Such uploads go straight from your browser to that endpoint: they are never routed through, stored by, or visible to the extension developer or the sync server. The endpoint's response is used only as data for the rest of that run and is never executed.

Besides network requests, the extension exchanges data over one kind of channel that never leaves your device:

- **A local flow-handover channel (optional).** If you install the OnceWise native host shipped with the OnceWise Flow agent skills, your AI tool can deliver automation flows/scripts and configuration to the extension. Your AI tool writes them to a local IPC endpoint served by the native host (a small Node.js script registered at your operating-system user level), which relays them to the extension through Chrome's native messaging; save results and validation summaries travel back the same way. The host relays data in memory and writes no flow data to disk beyond creating the socket directory it listens on. Everything in this loop stays on your device, and the extension developer is not part of it.

There is no analytics, telemetry, advertising, or tracking of any kind, and the extension contains no remotely hosted code.

### Permissions and why they are needed

- `storage` — persist your flows, settings and upload credentials locally.
- `scripting` and host permissions for all http/https sites — every flow targets a site that you choose, and a flow's upload step may name any `https://` server of yours as its destination. Because neither can be known at install time, the permission must be requested up front; in practice, content scripts are registered only for the origins that actually carry your flows, and are removed when the last flow for a site is deleted, and the only requests the extension makes beyond the sync server are the uploads your enabled flows declare.
- `nativeMessaging` — the optional local flow-handover channel described above: the extension opens a native-messaging port to the user-level host `ai.oncewise.native` so that your AI tool can deliver flows. Nothing else in the extension uses this permission, and no data crosses the network through it.
- `sidePanel` — the extension's entire interface is a browser side panel (the flows workbench). This permission only lets the toolbar button open that panel; it involves no data access.

### Retention and deletion

- Uninstalling the extension deletes all locally stored flows, settings and upload credentials. Individual upload credentials can be deleted at any time under Settings.
- Data previously saved to a sync space lives on that sync server and is governed by its operator — the extension developer for the official hosted service, or whoever runs your self-hosted deployment. Spaces and scripts can be deleted with the controls inside the extension (deleting a space removes its scripts from the server), or you can stop using sync.
- Data sent by an upload step lives on the server the flow named and is governed by that server's operator; the extension keeps no upload history.
- The optional native host lives outside the browser, so uninstalling the extension does not remove it; its files (host script, manifest, socket directory) can be deleted with the uninstall command shipped with the agent skills.

### Changes

If this policy changes, the updated version will be published at the same URL with a new effective date.

### Contact

zsy.evan@gmail.com

---

## 中文

**OnceWise Flow 浏览器扩展 — 隐私政策**

生效日期：2026-11-02

### 概述

OnceWise Flow 是一个自助浏览器自动化扩展。它把你指定的网页操作固化为自动化流程（受约束步骤树），并只在你选择的目标页面上运行。扩展以本地优先方式工作：数据在你的浏览器内处理，除非你主动把流程保存为脚本放入同步空间，或你确认并启用的流程运行到把数据发往该流程内指定服务器的上报步骤，任何数据都不会离开你的设备；扩展开发者不出售你的任何数据。

### 扩展在设备上存储的内容

- 自动化流程及其设置，保存在扩展本地存储（`chrome.storage`）中，连同每条流程的版本历史（最近 10 个已保存版本，用于回滚）。
- 你导入的流程文件（仅本地文件）的导入记录。
- AI 工具经下文本机通道交付流程时留下的投递记录（流程 ID、投递引用、时间戳与内容哈希——用于防止重复投递；不含任何页面数据，每条流程最多保留最近 10 条）。
- 你在「设置」中为上报流程录入的上报凭据（名称、HTTP 请求头名及其值）。它们只保存在你的设备上：流程按名称引用凭据，流程文件本身不含请求头名与值，因此经同步空间分享流程不会泄漏任何秘密。
- 用于防止同一业务实例重复提交的短期会话数据（仅业务标识，浏览器会话结束即清除）。

流程运行期间从网页读取的数据仅在内存中用于执行该流程；除上述流程定义外，扩展不会将其持久化。上报步骤发送的数据及从中捕获的响应同样只在该次运行的内存中存在。

### 数据传输

扩展只向两类目的地发起网络请求，且两类都只因你本人的操作而发生：

- **「同步」页签所配置的同步服务器。** 扩展出厂预配置为官方托管同步服务（由扩展开发者运营），你可以随时切换为自己部署的 oncewise-ai-sync 服务器。打开「同步」页签时会对所配置的服务器做一次登录模式自动检查（不发送任何流程数据）；只有当你把流程保存为脚本放入空间、拉取脚本或管理空间与成员时，才会把该操作涉及的流程/脚本内容及配置发送到该服务器。密钥空间使用你持有的空间密钥认证；登录门禁空间使用服务器自身的登录：凭据在服务器自己的登录页输入、不经过扩展，产生的登录令牌只保存在你的设备上。
- **流程声明的上报端点。** 流程可以包含上报步骤，把流程从页面读取的数据（以及你为该流程填写的输入值）发送到流程文件内写明的固定 `https://` 地址。保存摘要与流程清单会对每个此类步骤标注其目的地、发送的数据与所引用的凭据名，并且流程只有在你本人启用后才会运行。该步骤执行时，只会把它声明的数据原样发往它写明的地址——不附加任何其他内容——若步骤引用了凭据，则附带你在本机保存的那一个请求头。上报请求从你的浏览器直达该端点：不经过扩展开发者或同步服务器，也不会被其存储或看到。端点返回的内容只作为该次运行后续步骤的数据使用，绝不会被执行。

除网络请求外，扩展还会通过一类完全不离开你设备的通道收发数据：

- **本机流程交接通道（可选）。** 若你安装 OnceWise Flow agent skills 随附的 OnceWise 本机宿主，你的 AI 工具即可把自动化流程/脚本及配置交付给扩展：AI 工具将数据写入本机宿主监听的本地 IPC 端点（宿主是一个注册在操作系统用户层级的 Node.js 小脚本），宿主再经 Chrome 原生消息转发给扩展；保存结果与校验摘要沿同一通道返回。宿主仅在内存中转发数据，除创建监听所需的套接字目录外不向磁盘写入任何流程数据。这条链路上的一切都留在你的设备内，扩展开发者不在其中。

扩展不含任何分析、遥测、广告或追踪代码，也不含远程托管代码。

### 权限及必要性

- `storage` — 在本地保存你的流程、设置与上报凭据。
- `scripting` 与全站 http/https 主机权限 — 每条流程的目标站点由你指定，流程的上报步骤还可以把你自己的任意 `https://` 服务器作为目的地；两者在安装时都无法预知，因此只能预置申请。实际使用中，内容脚本只注册到真正携带流程的站点，某站点最后一条流程被删除后即解除注册；除同步服务器外，扩展发出的唯一网络请求就是你已启用流程所声明的上报。
- `nativeMessaging` — 上述可选的本机流程交接通道：扩展向用户层宿主 `ai.oncewise.native` 打开原生消息端口，使你的 AI 工具能够交付流程。扩展中没有其他功能使用该权限，也没有任何数据经它离开本机。
- `sidePanel` — 扩展的全部界面就是一个浏览器侧边栏（流程工作台）；该权限仅用于让工具栏按钮打开此面板，不涉及任何数据访问。

### 保留与删除

- 卸载扩展即删除本地存储的全部流程、设置与上报凭据；单条上报凭据可随时在「设置」中删除。
- 已保存到同步空间的数据存放在该同步服务器上，由其运营者管理——使用官方托管服务时即扩展开发者，自建部署时即运行该服务器的人。可通过扩展内的删除控件删除空间与脚本（删除空间会同时删除服务器上的全部脚本），也可停止使用同步。
- 上报步骤发送的数据存放在流程指定的服务器上，由该服务器的运营者管理；扩展不保存任何上报历史。
- 可选的本机宿主安装在浏览器之外，卸载扩展不会移除它；其文件（宿主脚本、清单、套接字目录）可用 agent skills 随附的卸载命令删除。

### 政策变更

政策如有变更，将在同一地址发布更新版本并更新生效日期。

### 联系方式

zsy.evan@gmail.com
