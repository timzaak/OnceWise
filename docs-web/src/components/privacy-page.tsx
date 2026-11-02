import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions, SiteFooter } from "@/lib/layout.shared";

interface PrivacyTexts {
  title: string;
  updated: string;
  sections: { heading: string; body: string }[];
  footer: {
    copyright: string;
    privacy: string;
  };
}

const en: PrivacyTexts = {
  title: "Privacy Policy",
  updated: "Effective date: 2026-11-02",
  sections: [
    {
      heading: "Overview",
      body: "OnceWise Flow is a self-service browser automation extension. It turns web page operations you specify into automation flows (constrained step trees) and runs them on the target pages you choose. The extension is local-first: your data is processed in your browser, nothing leaves your device unless you explicitly save a flow as a script into a sync space or a flow you have reviewed and enabled reaches an upload step that sends data to a server named in that flow, and the extension developer does not sell your data.",
    },
    {
      heading: "What the extension stores on your device",
      body: "Flows and their settings live in the extension's local storage (chrome.storage), together with each flow's version history (the last 10 saved versions, for rollback). The extension keeps import history for flow files you import (local files only), delivery records for flows your AI tool hands over through the local channel (flow ID, delivery reference, timestamps, and a content hash; capped at the last 10 per flow), upload credentials you save under Settings (a name, an HTTP header name and its value — stored only on your device; a flow references a credential by name and never contains the header name or the value), and short-lived session data used to prevent duplicate submissions on the same business instance (cleared when the browser session ends). Data read from web pages during a run, data sent by an upload step and any response captured from it are processed in memory for that run and not persisted beyond the flow definitions.",
    },
    {
      heading: "Data transmission",
      body: "The extension makes network requests to exactly two kinds of destinations, in both cases only as a direct consequence of something you did. (1) The sync server configured in the Sync tab: the extension ships pre-configured against the official hosted sync service operated by the extension developer; you can switch it to your own oncewise-ai-sync deployment at any time. Opening the Sync tab sends an automated sign-in-mode check to the configured server (it carries no flow data); flows/scripts and related configuration are transmitted only when you save a script into a space, pull a script, or manage spaces and members. Key spaces authenticate with the space key you hold; sign-in-gated spaces use the server's own sign-in (credentials are entered on the server's login page and never pass through the extension; the resulting sign-in tokens are stored only on your device). (2) The upload endpoint(s) a flow declares: a flow may contain an upload step that sends data the flow has read from the page (and values you entered for the flow) to a constant https:// address written in the flow file. The saved-flow summary and the flow list mark every such step with its destination, the data it sends and the credential name it uses, and a flow only runs after you personally enable it. When the step runs, exactly the data it declares is sent to exactly that address with the single request header of the credential you saved on this device, if any; such uploads go straight from your browser to that endpoint and are never routed through, stored by, or visible to the extension developer or the sync server, and the endpoint's response is used only as data for the rest of that run. Separately, the optional local flow-handover channel (a user-level Node.js native host installed with the agent skills) relays flows between your AI tool and the extension entirely on your device. There is no analytics, telemetry, advertising, or tracking of any kind, and no remotely hosted code.",
    },
    {
      heading: "Permissions and why they are needed",
      body: "storage persists your flows, settings and upload credentials locally. scripting plus host permissions for all http/https sites exist because every flow targets a site you choose and a flow's upload step may name any https:// server of yours as its destination, neither of which can be known at install time; in practice, content scripts are registered only for origins that actually carry your flows and are removed when the last flow for a site is deleted, and the only requests the extension makes beyond the sync server are the uploads your enabled flows declare. nativeMessaging is the optional local handover channel (host ai.oncewise.native); no data crosses the network through it. sidePanel only lets the toolbar button open the workbench panel.",
    },
    {
      heading: "Retention and deletion",
      body: "Uninstalling the extension deletes all locally stored flows, settings and upload credentials; individual upload credentials can be deleted at any time under Settings. Data previously saved to a sync space lives on that sync server and is governed by its operator — the extension developer for the official hosted service, or whoever runs your self-hosted deployment; spaces and scripts can be deleted with the controls inside the extension (deleting a space removes its scripts from the server), or you can stop using sync. Data sent by an upload step lives on the server the flow named and is governed by that server's operator; the extension keeps no upload history. The optional native host lives outside the browser, so uninstalling the extension does not remove it; its files can be deleted with the uninstall command shipped with the agent skills.",
    },
    {
      heading: "Changes",
      body: "If this policy changes, the updated version will be published at the same URL with a new effective date. The source of this page is docs/privacy-policy.md in the GitHub repository.",
    },
    {
      heading: "Contact",
      body: "zsy.evan@gmail.com",
    },
  ],
  footer: {
    copyright: "OnceWise Flow · Apache 2.0",
    privacy: "Privacy",
  },
};

const zh: PrivacyTexts = {
  title: "隐私政策",
  updated: "生效日期：2026-11-02",
  sections: [
    {
      heading: "概述",
      body: "OnceWise Flow 是一个自助浏览器自动化扩展。它把你指定的网页操作固化为自动化流程（受约束步骤树），并只在你选择的目标页面上运行。扩展以本地优先方式工作：数据在你的浏览器内处理，除非你主动把流程保存为脚本放入同步空间，或你确认并启用的流程运行到把数据发往该流程内指定服务器的上报步骤，任何数据都不会离开你的设备；扩展开发者不出售你的任何数据。",
    },
    {
      heading: "扩展在设备上存储的内容",
      body: "流程及其设置保存在扩展本地存储（chrome.storage）中，连同每条流程的版本历史（最近 10 个已保存版本，用于回滚）。扩展还会保留：你导入的流程文件（仅本地文件）的导入记录；AI 工具经本机通道交付流程时的投递记录（流程 ID、投递引用、时间戳与内容哈希，每条流程最多保留最近 10 条）；你在「设置」中录入的上报凭据（名称、HTTP 请求头名及其值，只保存在你的设备上——流程按名称引用凭据，流程文件本身不含请求头名与值）；以及防止同一业务实例重复提交的短期会话数据（浏览器会话结束即清除）。流程运行期间从网页读取的数据、上报步骤发送的数据及从中捕获的响应仅在该次运行的内存中用于执行该流程，除流程定义外不会被持久化。",
    },
    {
      heading: "数据传输",
      body: "扩展只向两类目的地发起网络请求，且两类都只因你本人的操作而发生。（1）「同步」页签所配置的同步服务器：扩展出厂预配置为官方托管同步服务（由扩展开发者运营），你可以随时切换为自己部署的 oncewise-ai-sync 服务器。打开「同步」页签时会对所配置的服务器做一次登录模式自动检查（不发送任何流程数据）；只有当你把流程保存为脚本放入空间、拉取脚本或管理空间与成员时，才会把该操作涉及的流程/脚本内容及配置发送到该服务器。密钥空间使用你持有的空间密钥认证；登录门禁空间使用服务器自身的登录（凭据在服务器自己的登录页输入、不经过扩展，产生的登录令牌只保存在你的设备上）。（2）流程声明的上报端点：流程可以包含上报步骤，把流程从页面读取的数据（以及你为该流程填写的输入值）发送到流程文件内写明的固定 https:// 地址。保存摘要与流程清单会对每个此类步骤标注其目的地、发送的数据与所引用的凭据名，并且流程只有在你本人启用后才会运行。该步骤执行时，只会把它声明的数据原样发往它写明的地址，若引用了凭据则附带你在本机保存的那一个请求头；上报请求从你的浏览器直达该端点，不经过扩展开发者或同步服务器，也不会被其存储或看到；端点返回的内容只作为该次运行后续步骤的数据使用。此外，可选的本机流程交接通道（随 agent skills 安装的用户级 Node.js 本机宿主）在你的设备内完成 AI 工具与扩展之间的流程交付。扩展不含任何分析、遥测、广告或追踪代码，也不含远程托管代码。",
    },
    {
      heading: "权限及必要性",
      body: "storage 在本地保存你的流程、设置与上报凭据。scripting 与全站 http/https 主机权限是因为每条流程的目标站点由你指定，流程的上报步骤还可以把你自己的任意 https:// 服务器作为目的地，两者在安装时都无法预知；实际使用中，内容脚本只注册到真正携带流程的站点，某站点最后一条流程被删除后即解除注册，除同步服务器外扩展发出的唯一网络请求就是你已启用流程所声明的上报。nativeMessaging 用于可选的本机交接通道（宿主 ai.oncewise.native），没有任何数据经它离开本机。sidePanel 仅用于让工具栏按钮打开流程工作台侧边栏。",
    },
    {
      heading: "保留与删除",
      body: "卸载扩展即删除本地存储的全部流程、设置与上报凭据；单条上报凭据可随时在「设置」中删除。已保存到同步空间的数据存放在该同步服务器上，由其运营者管理——使用官方托管服务时即扩展开发者，自建部署时即运行该服务器的人；可通过扩展内的删除控件删除空间与脚本（删除空间会同时删除服务器上的全部脚本），也可停止使用同步。上报步骤发送的数据存放在流程指定的服务器上，由该服务器的运营者管理，扩展不保存任何上报历史。可选的本机宿主安装在浏览器之外，卸载扩展不会移除它；其文件（宿主脚本、清单、套接字目录）可用 agent skills 随附的卸载命令删除。",
    },
    {
      heading: "政策变更",
      body: "政策如有变更，将在同一地址发布更新版本并更新生效日期。本页内容的来源是 GitHub 仓库中的 docs/privacy-policy.md。",
    },
    {
      heading: "联系方式",
      body: "zsy.evan@gmail.com",
    },
  ],
  footer: {
    copyright: "OnceWise Flow · Apache 2.0",
    privacy: "隐私政策",
  },
};

const textsMap: Record<string, PrivacyTexts> = { en, zh };

export function PrivacyPage({ lang }: { lang: string }) {
  const t = textsMap[lang] ?? en;
  return (
    <HomeLayout {...baseOptions(lang)}>
      <div className="relative z-10 py-20 px-4 min-h-[60vh]">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-4xl md:text-5xl font-serif font-bold text-stone-900 dark:text-stone-100 mb-2 tracking-tight">
            {t.title}
          </h1>
          <p className="text-stone-500 dark:text-stone-400 text-sm mb-12">
            {t.updated}
          </p>

          <div className="space-y-10">
            {t.sections.map((section) => (
              <section key={section.heading}>
                <h2 className="text-xl font-bold text-stone-900 dark:text-stone-100 mb-3">
                  {section.heading}
                </h2>
                <p className="text-stone-600 dark:text-stone-400 leading-relaxed">
                  {section.body}
                </p>
              </section>
            ))}
          </div>
        </div>
      </div>

      <SiteFooter lang={lang} labels={t.footer} />
    </HomeLayout>
  );
}
