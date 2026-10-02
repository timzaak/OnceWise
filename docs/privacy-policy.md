# OnceWise AI — Privacy Policy / 隐私政策

> 用途说明（中文）：本文档是 Chrome Web Store 上架所需隐私政策的唯一来源；"Permissions" 一节的权限理由同时可用作控制台权限说明字段的填写素材。发布页已备好：本地 `gh-pages` 分支（仅含自包含 `index.html`，内容取自本文档，更新政策后需同步重做该页）。仓库当前为私有，GitHub Pages 需公开仓库；**开源后**两步上线：
>
> 1. `git push origin gh-pages`
> 2. 启用 Pages：仓库 Settings → Pages → Source 选 `gh-pages` 分支根目录（或 `gh api -X POST repos/timzaak/OnceWise/pages -f 'source[branch]=gh-pages' -f 'source[path]=/'`）
>
> 上线后 URL：`https://timzaak.github.io/OnceWise/`，将其填入开发者控制台 Privacy 标签页。切勿改用 main 分支 `/docs` 目录发布——那会把内部 PRD/用户故事一起公开。

---

## English

**OnceWise AI Browser Extension — Privacy Policy**

Effective date: 2026-09-30

### Overview

OnceWise AI is a self-service browser automation extension. It turns web page operations you specify into automation flows ("constrained step trees") and runs them on the target pages you choose. The extension is local-first: your data is processed in your browser, and the extension developer does not collect, receive, or sell any of your data.

### What the extension stores on your device

- Automation flows and their settings, kept in the extension's local storage (`chrome.storage`), together with each flow's version history (the last 10 saved versions, so you can roll back).
- Import history entries for flow files you import (local files only).
- Delivery records for flows your AI tool hands over through the local channel described below (flow ID, delivery reference, timestamps, and a content hash — used to prevent duplicate delivery; they contain no page data and are capped at the last 10 per flow).
- Short-lived session data used to prevent duplicate submissions on the same business instance (business identifiers only, cleared when the browser session ends).

Data read from web pages during a flow run is processed in memory to execute that flow; it is not persisted by the extension beyond the flow definitions above.

### Data transmission

The extension makes network requests to exactly one kind of destination, and only when you configure it:

- **A sync server you configure.** If you set up synchronization, the extension sends your flows/scripts and related configuration to the oncewise-ai-sync server URL you enter, authenticated with the space key you provide. That server is operated by you or whoever you trust with the URL. The extension developer operates no server in this loop and never sees your data.

Besides network requests, the extension exchanges data over one kind of channel that never leaves your device:

- **A local flow-handover channel (optional).** If you install the OnceWise native host shipped with the OnceWise AI agent skills, your AI tool can deliver automation flows/scripts and configuration to the extension. Your AI tool writes them to a local IPC endpoint served by the native host (a small Node.js script registered at your operating-system user level), which relays them to the extension through Chrome's native messaging; save results and validation summaries travel back the same way. The host relays data in memory and writes no flow data to disk beyond creating the socket directory it listens on. Everything in this loop stays on your device, and the extension developer is not part of it.

There is no analytics, telemetry, advertising, or tracking of any kind, and the extension contains no remotely hosted code.

### Permissions and why they are needed

- `storage` — persist your flows and settings locally.
- `scripting` and host permissions for all http/https sites — every flow targets a site that you choose. Because targets cannot be known at install time, the permission must be requested up front; in practice, content scripts are registered only for the origins that actually carry your flows, and are removed when the last flow for a site is deleted.
- `nativeMessaging` — the optional local flow-handover channel described above: the extension opens a native-messaging port to the user-level host `ai.oncewise.native` so that your AI tool can deliver flows. Nothing else in the extension uses this permission, and no data crosses the network through it.
- `sidePanel` — the extension's entire interface is a browser side panel (the flows workbench). This permission only lets the toolbar button open that panel; it involves no data access.

### Retention and deletion

- Uninstalling the extension deletes all locally stored flows and settings.
- Data previously synced to a sync server is governed by the operator of that server; remove it with that server's own means (or stop using it).
- The optional native host lives outside the browser, so uninstalling the extension does not remove it; its files (host script, manifest, socket directory) can be deleted with the uninstall command shipped with the agent skills.

### Changes

If this policy changes, the updated version will be published at the same URL with a new effective date.

### Contact

zsy.evan@gmail.com

---

## 中文

**OnceWise AI 浏览器扩展 — 隐私政策**

生效日期：2026-09-30

### 概述

OnceWise AI 是一个自助浏览器自动化扩展。它把你指定的网页操作固化为自动化流程（受约束步骤树），并只在你选择的目标页面上运行。扩展以本地优先方式工作：数据在你的浏览器内处理，扩展开发者不收集、不接收、不出售你的任何数据。

### 扩展在设备上存储的内容

- 自动化流程及其设置，保存在扩展本地存储（`chrome.storage`）中，连同每条流程的版本历史（最近 10 个已保存版本，用于回滚）。
- 你导入的流程文件（仅本地文件）的导入记录。
- AI 工具经下文本机通道交付流程时留下的投递记录（流程 ID、投递引用、时间戳与内容哈希——用于防止重复投递；不含任何页面数据，每条流程最多保留最近 10 条）。
- 用于防止同一业务实例重复提交的短期会话数据（仅业务标识，浏览器会话结束即清除）。

流程运行期间从网页读取的数据仅在内存中用于执行该流程；除上述流程定义外，扩展不会将其持久化。

### 数据传输

扩展只向一类目的地发起网络请求，且仅在你主动配置时发生：

- **你配置的同步服务器。** 若你启用同步，扩展会把你的流程/脚本及相关配置发送到你填写的 oncewise-ai-sync 服务器地址，并使用你提供的空间密钥认证。该服务器由你或你信任的地址运营者管理；扩展开发者在链路中不运营任何服务器，也永远看不到你的数据。

除网络请求外，扩展还会通过一类完全不离开你设备的通道收发数据：

- **本机流程交接通道（可选）。** 若你安装 OnceWise AI agent skills 随附的 OnceWise 本机宿主，你的 AI 工具即可把自动化流程/脚本及配置交付给扩展：AI 工具将数据写入本机宿主监听的本地 IPC 端点（宿主是一个注册在操作系统用户层级的 Node.js 小脚本），宿主再经 Chrome 原生消息转发给扩展；保存结果与校验摘要沿同一通道返回。宿主仅在内存中转发数据，除创建监听所需的套接字目录外不向磁盘写入任何流程数据。这条链路上的一切都留在你的设备内，扩展开发者不在其中。

扩展不含任何分析、遥测、广告或追踪代码，也不含远程托管代码。

### 权限及必要性

- `storage` — 在本地保存你的流程和设置。
- `scripting` 与全站 http/https 主机权限 — 每条流程的目标站点由你指定，安装时无法预知目标，因此只能预置申请；实际使用中，内容脚本只注册到真正携带流程的站点，某站点最后一条流程被删除后即解除注册。
- `nativeMessaging` — 上述可选的本机流程交接通道：扩展向用户层宿主 `ai.oncewise.native` 打开原生消息端口，使你的 AI 工具能够交付流程。扩展中没有其他功能使用该权限，也没有任何数据经它离开本机。
- `sidePanel` — 扩展的全部界面就是一个浏览器侧边栏（流程工作台）；该权限仅用于让工具栏按钮打开此面板，不涉及任何数据访问。

### 保留与删除

- 卸载扩展即删除本地存储的全部流程和设置。
- 已同步到同步服务器的数据由该服务器的运营者管理；请通过该服务器自身的手段删除，或停止使用。
- 可选的本机宿主安装在浏览器之外，卸载扩展不会移除它；其文件（宿主脚本、清单、套接字目录）可用 agent skills 随附的卸载命令删除。

### 政策变更

政策如有变更，将在同一地址发布更新版本并更新生效日期。

### 联系方式

zsy.evan@gmail.com
