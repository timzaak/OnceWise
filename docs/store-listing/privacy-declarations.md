# Chrome Web Store 隐私/权限声明材料(控制台 Privacy 标签页逐字段粘贴)

素材来源:`docs/privacy-policy.md`(2026-09-30 版)。控制台字段以实际问卷为准,若措辞与下文有出入,以"事实不变、如实勾选"为原则现场调整。

## 1. Single purpose(单一用途声明)

> 控制台要求一句话,且必须能覆盖全部权限的使用场景。

**EN(粘贴用):**
Run user-defined automation flows on web pages: the extension executes locally stored, site-scoped flows on the sites the user chooses, manages those flows in a side panel, and can receive flow definitions from the user's own AI tool over a local native-messaging channel.

**ZH(对照理解):**
在网页上执行用户定义的自动化流程:扩展在用户选定的站点上运行本地存储、按站点生效的流程流程,在侧边栏管理这些流程,并可经本机原生消息通道接收用户自己 AI 工具交付的流程定义。

## 2. 权限理由(逐条粘贴到对应权限的 justification 字段)

**`storage`**
Persist the user's automation flows, per-flow version history, delivery receipts and settings in the extension's local storage. Nothing is synced anywhere by default.

**`scripting`**
Register content scripts dynamically, only for the origins that actually carry the user's flows (flows target user-chosen sites that cannot be known at install time), and top up injection for tabs that were already open when a flow was enabled. Scripts are unregistered when the last flow for a site is deleted.

**Host permissions (all http/https sites)**
Every flow targets a site the user chooses; targets cannot be known at install time, so the permission is requested up front. In practice content scripts are registered only for origins that actually carry flows. Page data is read in memory solely to execute the user's flow on the matching page and is never transmitted off the device.

**`nativeMessaging`**
Opens a native-messaging port to the user-level host `ai.oncewise.native` so the user's own AI tool can deliver flow definitions through a channel that stays on the device; save results and validation summaries travel back the same way. Nothing else in the extension uses this permission and no data crosses the network through it.

**`sidePanel`**
The extension's entire interface is a browser side panel (the flows workbench). The permission only lets the toolbar button open that panel; it grants no data access.

## 3. 数据用途问卷(Data usage / Privacy practices)

CWS 对 "collect" 的定义是**传出设备**。本扩展不向开发者传任何数据,网页内容只在内存中用于执行流程,唯一出网流量是用户自配同步服务器。建议勾选:

| 问卷项 | 建议答案 | 依据 |
| --- | --- | --- |
| Website content(网页内容) | 声明为本地处理、不传输(not collected / processed locally only) | 流程运行时在内存读取页面执行流程,不持久化、不外传 |
| Personally identifiable / Health / Financial / Authentication / Personal communications / Location / Web history 等全部类别 | 不收集 | 无账号、无遥测;业务标识仅存会话级短数据防重复提交,会话结束清除 |
| Browsing activity | 不收集 | 不记录浏览历史;流程历史仅含流程定义与时间戳 |
| Sold / transferred to third parties / used for creditworthiness 等认证项 | 全部确认"否" | 无任何数据离开设备(用户自配同步除外,且不经过开发者) |

若问卷出现"数据是否发送到你(开发者)运营的服务器"一类问题:答"否,扩展开发者不运营任何服务器";同步功能仅在用户自行配置服务器地址后,把流程/脚本发送到该用户指定地址。

## 4. 远程代码(Remotely hosted code)

确认声明:**扩展不含远程托管代码**——所有逻辑随扩展包分发,无 CDN 脚本、无 eval 远程内容。(见隐私政策 "no remotely hosted code"。)

## 5. 审核备注(可选,提交时贴给审核员)

The extension requires broad host permissions because every automation flow targets a user-chosen site that cannot be known at install time. Content scripts are registered at runtime only for origins that carry enabled flows. Reviewers can verify: install → the side panel lists no sites until a flow exists; enabling/deleting flows registers/unregisters content scripts per origin (chrome.scripting.registerContentScripts calls in the background service worker). The nativeMessaging port only connects to the locally installed host `ai.oncewise.native`; without that host (not shipped in the store package) the extension still manages flows normally.
