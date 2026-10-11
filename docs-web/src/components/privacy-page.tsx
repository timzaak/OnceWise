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
  updated: "Effective date: 2026-10-07",
  sections: [
    {
      heading: "Overview",
      body: "OnceWise Flow is a self-service browser automation extension. It turns web page operations you specify into automation flows (constrained step trees) and runs them on the target pages you choose. The extension is local-first: your data is processed in your browser, and the extension developer does not collect, receive, or sell any of your data.",
    },
    {
      heading: "What the extension stores on your device",
      body: "Flows and their settings live in the extension's local storage (chrome.storage), together with each flow's version history (the last 10 saved versions, for rollback). The extension keeps import history for flow files you import (local files only), delivery records for flows your AI tool hands over through the local channel (flow ID, delivery reference, timestamps, and a content hash; capped at the last 10 per flow), and short-lived session data used to prevent duplicate submissions on the same business instance (cleared when the browser session ends). Data read from web pages during a run is processed in memory and not persisted beyond the flow definitions.",
    },
    {
      heading: "Data transmission",
      body: "The extension makes network requests to exactly one kind of destination, and only when you configure it: a sync server you configure. If you set up synchronization, flows and related configuration go to the oncewise-ai-sync server URL you enter, authenticated with the space key you provide. That server is operated by you or someone you trust; the extension developer operates no server in this loop. Separately, the optional local flow-handover channel (a user-level Node.js native host installed with the agent skills) relays flows between your AI tool and the extension entirely on your device. There is no analytics, telemetry, advertising, or tracking of any kind, and no remotely hosted code.",
    },
    {
      heading: "Permissions and why they are needed",
      body: "storage persists your flows and settings locally. scripting plus host permissions for all http/https sites exist because every flow targets a site you choose, which cannot be known at install time; in practice, content scripts are registered only for origins that actually carry your flows and are removed when the last flow for a site is deleted. nativeMessaging is the optional local handover channel (host ai.oncewise.native); no data crosses the network through it. sidePanel only lets the toolbar button open the workbench panel.",
    },
    {
      heading: "Retention and deletion",
      body: "Uninstalling the extension deletes all locally stored flows and settings. Data previously synced to a sync server is governed by that server's operator. The optional native host lives outside the browser, so uninstalling the extension does not remove it; its files can be deleted with the uninstall command shipped with the agent skills.",
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
  updated: "生效日期：2026-10-07",
  sections: [
    {
      heading: "概述",
      body: "OnceWise Flow 是一个自助浏览器自动化扩展。它把你指定的网页操作固化为自动化流程（受约束步骤树），并只在你选择的目标页面上运行。扩展以本地优先方式工作：数据在你的浏览器内处理，扩展开发者不收集、不接收、不出售你的任何数据。",
    },
    {
      heading: "扩展在设备上存储的内容",
      body: "流程及其设置保存在扩展本地存储（chrome.storage）中，连同每条流程的版本历史（最近 10 个已保存版本，用于回滚）。扩展还会保留：你导入的流程文件（仅本地文件）的导入记录；AI 工具经本机通道交付流程时的投递记录（流程 ID、投递引用、时间戳与内容哈希，每条流程最多保留最近 10 条）；以及防止同一业务实例重复提交的短期会话数据（浏览器会话结束即清除）。流程运行期间从网页读取的数据仅在内存中用于执行该流程，除流程定义外不会被持久化。",
    },
    {
      heading: "数据传输",
      body: "扩展只向一类目的地发起网络请求，且仅在你主动配置时发生：你配置的同步服务器。启用同步后，流程及相关配置发送到你填写的 oncewise-ai-sync 服务器地址，使用你提供的空间密钥认证；该服务器由你或你信任的运营者管理，扩展开发者在链路中不运营任何服务器。此外，可选的本机流程交接通道（随 agent skills 安装的用户级 Node.js 本机宿主）在你的设备内完成 AI 工具与扩展之间的流程交付。扩展不含任何分析、遥测、广告或追踪代码，也不含远程托管代码。",
    },
    {
      heading: "权限及必要性",
      body: "storage 在本地保存你的流程和设置。scripting 与全站 http/https 主机权限是因为每条流程的目标站点由你指定、安装时无法预知；实际使用中，内容脚本只注册到真正携带流程的站点，某站点最后一条流程被删除后即解除注册。nativeMessaging 用于可选的本机交接通道（宿主 ai.oncewise.native），没有任何数据经它离开本机。sidePanel 仅用于让工具栏按钮打开流程工作台侧边栏。",
    },
    {
      heading: "保留与删除",
      body: "卸载扩展即删除本地存储的全部流程和设置。已同步到同步服务器的数据由该服务器的运营者管理。可选的本机宿主安装在浏览器之外，卸载扩展不会移除它；其文件（宿主脚本、清单、套接字目录）可用 agent skills 随附的卸载命令删除。",
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
