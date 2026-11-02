# Chrome Web Store 隐私/权限声明材料(控制台 Privacy 标签页逐字段粘贴)

素材来源:`docs/privacy-policy.md`(2026-11-02 版)。控制台字段以实际问卷为准,若措辞与下文有出入,以"事实不变、如实勾选"为原则现场调整。

## 1. Single purpose(单一用途声明)

> 控制台要求一句话,且必须能覆盖全部权限的使用场景。

**EN(粘贴用):**
Run user-defined automation flows on web pages: the extension executes locally stored, site-scoped flows on the sites the user chooses (including, when a flow declares it, sending the data that flow collected to an https endpoint named in the flow), manages those flows in a side panel, and can receive flow definitions from the user's own AI tool over a local native-messaging channel.

**ZH(对照理解):**
在网页上执行用户定义的自动化流程:扩展在用户选定的站点上运行本地存储、按站点生效的流程(流程声明时,还把该流程采集的数据发往流程内指定的 https 端点),在侧边栏管理这些流程,并可经本机原生消息通道接收用户自己 AI 工具交付的流程定义。

## 2. 权限理由(逐条粘贴到对应权限的 justification 字段)

**`storage`**
Persist the user's automation flows, per-flow version history, delivery receipts, settings and the user's named upload credentials (header name + value, device-local, never inside a flow) in the extension's local storage. Nothing is synced anywhere by default.

**`scripting`**
Register content scripts dynamically, only for the origins that actually carry the user's flows (flows target user-chosen sites that cannot be known at install time), and top up injection for tabs that were already open when a flow was enabled. Scripts are unregistered when the last flow for a site is deleted.

**Host permissions (all http/https sites)**
Every flow targets a site the user chooses, and a flow's upload step may name any https server of the user's as its destination; neither can be known at install time, so the permission is requested up front. In practice content scripts are registered only for origins that actually carry flows. Page data is read in memory solely to execute the user's flow on the matching page; it leaves the device only (a) when the user explicitly saves that flow as a script into a sync space, sent to the configured sync server (the official hosted service by default, or the user's own deployment), or (b) when a flow the user reviewed and enabled reaches an upload step — then exactly the data that step declares is sent from the background service worker straight to the constant https endpoint written in the flow, with the single header of a credential the user saved on this device. The extension's summary and flow list mark every upload step with its destination before the user enables the flow; uploads never pass through the developer.

**`nativeMessaging`**
Opens a native-messaging port to the user-level host `ai.oncewise.native` so the user's own AI tool can deliver flow definitions through a channel that stays on the device; save results and validation summaries travel back the same way. Nothing else in the extension uses this permission and no data crosses the network through it.

**`identity`**
Used only by the optional sync feature's sign-in: chrome.identity.launchWebAuthFlow runs the OAuth code+PKCE handoff against the configured sync server (the official hosted service by default, or the user's own oncewise-ai-sync deployment), with the redirect landing on this extension's own identity redirect URL. No Google account data is read; sign-in credentials are entered on the sync server's own login page and never pass through the extension, and the resulting tokens go only to that sync server and are stored on the user's device.

**`alarms`**
The alarms permission powers the extension's timed-trigger feature: after a user creates a daily/weekly/interval schedule for one of their automation flows (in the flow editor's Schedules card), chrome.alarms wakes the extension's service worker at the user-configured time so the flow can start unattended. MV3 service workers are terminated when idle, and chrome.alarms is the only platform mechanism to wake them at a specific time, so this permission is required for that feature. One additional internal housekeeping alarm surfaces an expiry notice when a scheduled start becomes stale. Alarms are created only for schedules the user explicitly creates and are cleared when the schedule or flow is deleted; schedule records stay in local device storage (storage.local). This API collects no data and sends nothing to any server.

**`sidePanel`**
The extension's entire interface is a browser side panel (the flows workbench). The permission only lets the toolbar button open that panel; it grants no data access.

## 3. 数据用途问卷(Data usage / Privacy practices)

CWS 对 "collect" 的定义是**传出设备**。默认状态下扩展不出网:网页内容只在内存中用于执行流程。出网流量只有两类,都只因用户本人的操作发生:(1)同步功能——扩展出厂预配置为开发者运营的官方托管同步服务(用户可随时切换为自建的 oncewise-ai-sync 服务器),仅当用户主动使用同步(保存脚本入空间/拉取/管理空间与成员)时才传输内容;(2)流程声明的上报步骤——用户确认并启用的流程运行到上报步骤时,把该步骤声明的页面数据与输入值从浏览器直接发到流程内写明的 https 端点(用户自己的服务器),不经过开发者;请求头携带用户在本机录入的具名凭据。建议勾选:

| 问卷项 | 建议答案 | 依据 |
| --- | --- | --- |
| Website content(网页内容) | **已勾选**(2026-10-22 提交审核;2026-11-02 补充上报路径):① 使用官方同步并保存脚本时,流程内容(含其中的网页字段值)会传输到开发者运营的官方同步服务器,仅用于用户选定的同步功能、不售卖、不用于其他用途;仅自建路径则仍为不传输。② 用户启用的流程运行到其声明的上报步骤时,该步骤声明的页面数据会从浏览器直接发往流程内写明的用户自己的 https 端点,不经过开发者、开发者不可见 | 流程运行时在内存读取页面执行流程,不持久化;同步仅在用户显式操作时传输该操作涉及的流程/脚本内容;上报仅在用户启用流程后、按流程声明的数据与目的地发生,摘要与清单事先标注 |
| Authentication information(认证信息) | **已勾选**(2026-11-02 新增):用户为上报端点在扩展设置中录入的具名凭据(请求头名 + 值,如 Authorization Bearer 令牌或 X-API-Key)。只保存在用户设备的 storage.local;仅在用户启用的流程执行其上报步骤时,作为单个请求头发往该流程内写明的用户自己的 https 端点;不进入流程文件、版本历史、同步空间或开发者服务器,不售卖、不用于其他用途 | 凭据为用户自有服务器的认证信息,由用户主动录入;传输目的地只有流程声明的端点;开发者不可见 |
| Personally identifiable / Health / Financial / Personal communications / Location / Web history 等其余类别 | 不收集(扩展自身);若官方服务开启登录门禁,用户在服务器登录页提交的凭据归服务器侧,如实按实际配置补充声明 | 扩展自身无账号、无遥测;登录门禁服务器使用服务器自身账号(凭据不经过扩展);业务标识仅存会话级短数据防重复提交,会话结束清除 |
| Browsing activity | 不收集 | 不记录浏览历史;流程历史仅含流程定义与时间戳;不保存上报历史 |
| Sold / transferred to third parties / used for creditworthiness 等认证项 | 全部确认"否" | 无任何数据默认离开设备;同步场景仅传输用户主动保存的脚本内容到所配置服务器(默认为开发者运营的官方服务,可自建);上报场景仅把流程声明的数据发往用户自己指定的端点;两者都不用于认证/征信用途,不出售、不转移给第三方 |

若问卷出现"数据是否发送到你(开发者)运营的服务器"一类问题:如实回答——扩展出厂预配置为开发者运营的官方托管同步服务,打开「同步」页签会对其做一次不含内容的登录模式自动检查,用户主动保存脚本或管理空间时内容才传输到该服务器;用户可随时切换为自建服务器,自建路径完全不经过开发者。流程上报步骤的流量只发往流程内写明的用户自己的端点,任何情况下都不经过开发者运营的服务器。

## 4. 远程代码(Remotely hosted code)

确认声明:**扩展不含远程托管代码**——所有逻辑随扩展包分发,无 CDN 脚本、无 eval 远程内容。(见隐私政策 "no remotely hosted code"。)

## 5. 审核备注(可选,提交时贴给审核员)

The extension requires broad host permissions because every automation flow targets a user-chosen site that cannot be known at install time, and a flow's optional upload step may name any https endpoint of the user's own. Content scripts are registered at runtime only for origins that carry enabled flows. Reviewers can verify: install → the side panel lists no sites until a flow exists; enabling/deleting flows registers/unregisters content scripts per origin (chrome.scripting.registerContentScripts calls in the background service worker). Uploads are the only other network calls: the background service worker fetches the constant https URL written in an enabled flow's upload step (redirect: 'error', credentials: 'omit') with exactly the payload that step declares and at most one credential header the user saved under Settings; the saved-flow summary and the flow list show the destination before the user enables the flow. The nativeMessaging port only connects to the locally installed host `ai.oncewise.native`; without that host (not shipped in the store package) the extension still manages flows normally.
