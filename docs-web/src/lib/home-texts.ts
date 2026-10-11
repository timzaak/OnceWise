export interface HomeTexts {
  badge: string;
  heroTitle: string;
  heroDesc: string;
  getStarted: string;
  terminal: {
    label: string;
    lines: {
      prefix?: string;
      text: string;
      status?: "ok" | "info" | "command";
    }[];
  };
  featureSectionTitle: string;
  featureSectionDesc: string;
  features: {
    title: string;
    desc: string;
    bullets: string[];
  }[];
  stepsSectionTitle: string;
  stepsSectionDesc: string;
  steps: {
    num: string;
    title: string;
    desc: string;
  }[];
  compareSectionTitle: string;
  compareSectionDesc: string;
  compareHeaders: {
    onewise: string;
    recorder: string;
    rpa: string;
    agent: string;
  };
  compareRows: {
    label: string;
    onewise: string;
    recorder: string;
    rpa: string;
    agent: string;
  }[];
  faqSectionTitle: string;
  faqSectionDesc: string;
  faq: {
    question: string;
    answer: string;
  }[];
  ctaTitle: string;
  ctaDesc: string;
  ctaContactHint: string;
  starGithub: string;
  footer: {
    copyright: string;
    contact: string;
    privacy: string;
  };
}

export const en: HomeTexts = {
  badge: "Open Source · Local-First · No Accounts",
  heroTitle: "Automate the web pages you open every day",
  heroDesc:
    "Describe the routine to your AI assistant. It verifies the steps on the real page, hands over a constrained flow through a channel that never leaves your machine, and you press Enable once. From then on the steps run by themselves every time you open a matching page.",
  getStarted: "Get Started",
  terminal: {
    label: "terminal",
    lines: [
      {
        prefix: "$",
        text: "node skills/oncewise-message/client.mjs ping",
        status: "command",
      },
      { text: '{"ok":true,"schemaVersion":1}', status: "info" },
      {
        prefix: "$",
        text: "node client.mjs flow.validate --file report-flow.json",
        status: "command",
      },
      { text: '{"ok":true,"errors":[]}', status: "info" },
      {
        prefix: "$",
        text: "node client.mjs flow.save --file report-flow.json",
        status: "command",
      },
      { text: "✓ Flow saved (disabled) — flowId flow_a1b2c3", status: "ok" },
      {
        text: "→ Review it in the side panel, then press Enable.",
        status: "info",
      },
    ],
  },
  featureSectionTitle: "What the extension does for you",
  featureSectionDesc:
    "OnceWise Flow turns a routine you can describe into steps the browser repeats for you, and keeps every safety decision in your hands.",
  features: [
    {
      title: "AI builds the flow",
      desc: "Your AI tool (Claude Code, Cursor, ZCode, or any agent that can drive Chrome) inspects the target page, verifies each step, and hands over the flow as JSON.",
      bullets: [
        "Locators verified on the real page",
        "Explicit approval before anything is saved",
        "Runs through the OnceWise agent skills",
      ],
    },
    {
      title: "Constrained step trees",
      desc: "A flow is a tree of fill, click, read, wait, assert and loop nodes with time budgets, not an arbitrary script.",
      bullets: [
        "No executable code in flows",
        "Bounded waits, typed predicates",
        "Duplicate-submit guard per business instance",
      ],
    },
    {
      title: "Runs when you open the page",
      desc: "Content scripts load only on the origins that actually carry your flows. When you open a matching page, the enabled flow runs.",
      bullets: [
        "Disabled until you enable it",
        "10-version history with rollback",
        "Per-flow on/off switch",
      ],
    },
    {
      title: "Pre-run input forms",
      desc: "Flows can declare inputs (order number, date, remarks). You fill the form once in the side panel; the next run consumes the saved values.",
      bullets: [
        "Typed inputs with options",
        "Referenced in steps, not hardcoded",
        "Your values never leave the browser",
      ],
    },
    {
      title: "Same-site cross-page wizards",
      desc: "A flow can continue across sequential pages of one site, form to confirmation to result, including a next page opened in a new tab.",
      bullets: [
        "Per-page fingerprints from the real DOM",
        "Inputs and loop progress carry over",
        "Business invariants rechecked on arrival",
      ],
    },
    {
      title: "Share without accounts",
      desc: "An optional self-hosted sync server shares selected flows as versioned scripts across devices and teammates via space codes.",
      bullets: [
        "Fully optional, works standalone",
        "Space addressed by client-generated ID + key",
        "Open-source Rust backend you can host",
      ],
    },
  ],
  stepsSectionTitle: "From description to automation in three steps",
  stepsSectionDesc: "Install once. Describe the routine. Press Enable.",
  steps: [
    {
      num: "01",
      title: "Install",
      desc: "Install the extension, then add the OnceWise skills to your AI tool and run the native host installer once (Node 22+). The setup skill checks both channels end to end.",
    },
    {
      num: "02",
      title: "Describe the routine",
      desc: "Tell your assistant what you do on the page. It inspects the page through browser tools, tries each step on data you authorize, and hands over a validated flow through the local channel.",
    },
    {
      num: "03",
      title: "Review and enable",
      desc: "Read every step in the side panel, fill the pre-run form if there is one, and press Enable yourself. The flow stays disabled until you do, and you can roll back or delete it at any time.",
    },
  ],
  compareSectionTitle: "How OnceWise Flow compares",
  compareSectionDesc:
    "Recorders capture what you clicked; enterprise RPA moves the work to a cloud studio; a free-running agent improvises on every request. OnceWise Flow lands the flow in between: AI-authored, constrained, reviewed by you.",
  compareHeaders: {
    onewise: "OnceWise Flow",
    recorder: "Recorder extensions",
    rpa: "Enterprise RPA",
    agent: "Free-running agent",
  },
  compareRows: [
    {
      label: "Who writes the automation",
      onewise: "Your AI, verified on the page",
      recorder: "You, by clicking",
      rpa: "You, in a desktop studio",
      agent: "The AI, every request",
    },
    {
      label: "Constrained steps, no arbitrary code",
      onewise: "Yes",
      recorder: "Recorded macros",
      rpa: "Yes, project-sized",
      agent: "No",
    },
    {
      label: "Runs by itself on page open",
      onewise: "Yes",
      recorder: "Manual trigger",
      rpa: "Scheduled / attended",
      agent: "Per request",
    },
    {
      label: "Data stays on your device",
      onewise: "Local-first",
      recorder: "Local-first",
      rpa: "Cloud consoles",
      agent: "Varies",
    },
    {
      label: "Share with teammates",
      onewise: "Space codes, self-hosted",
      recorder: "Export files",
      rpa: "Vendor platform",
      agent: "—",
    },
  ],
  faqSectionTitle: "Frequently asked questions",
  faqSectionDesc: "Everything you need to know about OnceWise Flow.",
  faq: [
    {
      question: "What is OnceWise Flow?",
      answer:
        "A Chrome extension that turns web page routines into automation flows. Your AI assistant inspects the target page, verifies the steps, and hands the flow over through a local native-messaging channel. The extension is the only validator and store: it checks the flow, saves it disabled, and runs it on matching pages once you enable it.",
    },
    {
      question: "Which AI tools work with it?",
      answer:
        "Any tool that can run the OnceWise agent skills and drive Chrome through Chrome DevTools MCP, such as Claude Code, Cursor or ZCode. The skills are installed with the Skills CLI (npx skills add). The extension itself is independent of the AI tool.",
    },
    {
      question: "Where does my data go?",
      answer:
        "Nowhere by default. Flows, settings and version history live in the extension's local storage. The only network destination is a sync server you explicitly configure, and the AI handover channel is a local native-messaging host that stays on your device. There is no analytics, telemetry or tracking.",
    },
    {
      question: "What can't flows do?",
      answer:
        "Flows cannot contain executable code, cross sites, run in parallel tabs, or recover an interrupted run. Delete, remove, payment, purchase and publish actions are excluded by the format, and flows are not created for platforms the usage instructions exclude, such as Taobao and Amazon. Cross-site orchestration ideas can go to the GitHub issue tracker.",
    },
    {
      question: "Do I need the sync server?",
      answer:
        "No. The extension works fully standalone. The oncewise-ai-sync server is for sharing selected flows as versioned scripts with teammates via space codes; it is open source and you host it yourself (a container image is published to ghcr.io).",
    },
    {
      question: "Why is there a native host to install?",
      answer:
        "The native-messaging host (ai.oncewise.native) is the local channel your AI tool uses to validate, save and verify flows in the extension. It is a small Node.js script registered at the user level (Node 22+). It relays data in memory, writes no flow data to disk, and carries nothing over the network.",
    },
    {
      question: "How is this different from a recorder?",
      answer:
        "A recorder captures your clicks and hopes the page stays the same. Here your AI verifies locators on the live page, the flow is a constrained step tree with time budgets that anyone can read in plain JSON, sensitive values are redacted in the side panel, and every flow has a switch, a 10-version history and a delete button.",
    },
    {
      question: "Is it free and open source?",
      answer:
        "Yes, Apache-2.0. The extension, the sync backend and the agent skills are all in the same repository. There is no account system and no paid tier.",
    },
    {
      question: "Can I get help?",
      answer:
        "Email zsy.evan@gmail.com, or open an issue at github.com/timzaak/OnceWise/issues. Please don't paste flow JSON, input values or business data into issues.",
    },
  ],
  ctaTitle: "Stop clicking through the same form",
  ctaDesc:
    "Install the extension, hand the routine to your assistant, and press Enable once. The next hundred times, the browser does them.",
  ctaContactHint: "Questions, or automating something interesting? Email us:",
  starGithub: "Star on GitHub",
  footer: {
    copyright: "OnceWise Flow · Apache 2.0",
    contact: "Contact",
    privacy: "Privacy",
  },
};

export const zh: HomeTexts = {
  badge: "开源 · 本地优先 · 无账号",
  heroTitle: "自动化你每天都要打开的网页",
  heroDesc:
    "把重复操作描述给你的 AI 助手。它在真实页面上逐步验证，通过一条不离开你机器的通道交付受约束的流程，你只需确认启用一次。之后每次打开匹配的页面，这些步骤都会自动完成。",
  getStarted: "快速开始",
  terminal: {
    label: "terminal",
    lines: [
      {
        prefix: "$",
        text: "node skills/oncewise-message/client.mjs ping",
        status: "command",
      },
      { text: '{"ok":true,"schemaVersion":1}', status: "info" },
      {
        prefix: "$",
        text: "node client.mjs flow.validate --file report-flow.json",
        status: "command",
      },
      { text: '{"ok":true,"errors":[]}', status: "info" },
      {
        prefix: "$",
        text: "node client.mjs flow.save --file report-flow.json",
        status: "command",
      },
      { text: "✓ 流程已保存（禁用态）— flowId flow_a1b2c3", status: "ok" },
      {
        text: "→ 在侧边栏确认内容后，手动按下启用。",
        status: "info",
      },
    ],
  },
  featureSectionTitle: "扩展为你做什么",
  featureSectionDesc:
    "OnceWise Flow 把你能描述清楚的例行操作变成浏览器替你重复的步骤，并把所有安全决定留在你手里。",
  features: [
    {
      title: "AI 编写流程",
      desc: "你的 AI 工具（Claude Code、Cursor、ZCode 等能驱动 Chrome 的 agent）检查目标页面、逐步验证，并以 JSON 交付流程。",
      bullets: [
        "定位符在真实页面上验证",
        "保存前必须获得你的明确确认",
        "通过 OnceWise agent skills 完成",
      ],
    },
    {
      title: "受约束的步骤树",
      desc: "流程是由 fill、click、read、wait、assert、loop 节点组成并带时间预算的树，不是任意脚本。",
      bullets: [
        "流程内不含可执行代码",
        "有界等待与类型化断言",
        "同一业务实例的防重复提交保护",
      ],
    },
    {
      title: "打开页面即运行",
      desc: "内容脚本只注入真正携带流程的站点。打开匹配页面时，已启用的流程自动运行。",
      bullets: ["启用前保持禁用态", "10 版本历史可回滚", "每条流程独立开关"],
    },
    {
      title: "运行前输入表单",
      desc: "流程可声明输入项（单号、日期、备注）。你在侧边栏填一次表单，下一次运行直接使用保存的值。",
      bullets: [
        "带选项的类型化输入",
        "步骤中引用而非硬编码",
        "你的输入值不离开浏览器",
      ],
    },
    {
      title: "同站跨页向导",
      desc: "一条流程可以在同一站点内顺序跨页续跑，从表单到确认页再到结果页，包括新标签页打开的下一页。",
      bullets: [
        "逐页指纹取自真实 DOM",
        "输入与循环进度自动携带",
        "到达后复查业务不变量",
      ],
    },
    {
      title: "无账号共享",
      desc: "可选的自托管同步服务器，通过空间码把选定流程以带版本的脚本共享给同事和你的其他设备。",
      bullets: [
        "完全可选，单机即可使用",
        "空间由客户端生成的 ID + 密钥寻址",
        "开源 Rust 后端，可自行部署",
      ],
    },
  ],
  stepsSectionTitle: "三步从描述到自动化",
  stepsSectionDesc: "安装一次，描述操作，按下启用。",
  steps: [
    {
      num: "01",
      title: "安装",
      desc: "安装扩展，把 OnceWise skills 装进你的 AI 工具，并运行一次本机宿主安装程序（需 Node 22+）。setup skill 会端到端检查两条通道。",
    },
    {
      num: "02",
      title: "描述操作",
      desc: "告诉助手你在这个页面上做什么。它通过浏览器工具检查页面，在你授权的数据上试每一步，然后经本机通道交付经过校验的流程。",
    },
    {
      num: "03",
      title: "确认并启用",
      desc: "在侧边栏逐步阅读内容，有输入表单就先填写，然后由你亲手按下启用。在此之前流程保持禁用，你随时可以回滚或删除。",
    },
  ],
  compareSectionTitle: "OnceWise Flow 的位置",
  compareSectionDesc:
    "录制器记住你点过什么；企业级 RPA 把工作搬进云端工作室；自由运行的 agent 每次请求都即兴发挥。OnceWise Flow 取中间：AI 编写、受约束、由你审阅。",
  compareHeaders: {
    onewise: "OnceWise Flow",
    recorder: "录制器扩展",
    rpa: "企业级 RPA",
    agent: "自由运行的 agent",
  },
  compareRows: [
    {
      label: "谁来编写自动化",
      onewise: "你的 AI，在页面上验证",
      recorder: "你自己，靠点击",
      rpa: "你自己，在桌面工作室",
      agent: "AI，每次请求",
    },
    {
      label: "受约束步骤，无任意代码",
      onewise: "是",
      recorder: "录制的宏",
      rpa: "是，工程级",
      agent: "否",
    },
    {
      label: "打开页面自动运行",
      onewise: "是",
      recorder: "手动触发",
      rpa: "定时 / 有人值守",
      agent: "按请求",
    },
    {
      label: "数据留在设备上",
      onewise: "本地优先",
      recorder: "本地优先",
      rpa: "云端控制台",
      agent: "视实现而定",
    },
    {
      label: "共享给同事",
      onewise: "空间码，自托管",
      recorder: "导出文件",
      rpa: "厂商平台",
      agent: "—",
    },
  ],
  faqSectionTitle: "常见问题",
  faqSectionDesc: "关于 OnceWise Flow 你需要知道的事。",
  faq: [
    {
      question: "OnceWise Flow 是什么？",
      answer:
        "一个把网页例行操作变成自动化流程的 Chrome 扩展。你的 AI 助手检查目标页面、验证步骤，并通过本机原生消息通道交付流程。扩展是唯一的校验者和存储点：校验流程、以禁用态保存，并在你启用后于匹配页面运行。",
    },
    {
      question: "支持哪些 AI 工具？",
      answer:
        "任何能运行 OnceWise agent skills 并通过 Chrome DevTools MCP 驱动 Chrome 的工具，例如 Claude Code、Cursor、ZCode。skills 用 Skills CLI（npx skills add）安装。扩展本身不依赖特定 AI 工具。",
    },
    {
      question: "我的数据会去哪里？",
      answer:
        "默认哪儿也不去。流程、设置和版本历史都在扩展本地存储。唯一的网络目的地是你显式配置的同步服务器；AI 交接通道是留在设备上的本机原生消息宿主。没有分析、遥测或追踪。",
    },
    {
      question: "流程不能做什么？",
      answer:
        "流程不能包含可执行代码、跨站、并行多标签页运行，也不能恢复被中断的运行。delete、remove、payment、purchase、publish 类动作被格式排除；使用说明排除的平台（如淘宝、Amazon）不会为其创建流程。跨站编排的需求可以提到 GitHub issue。",
    },
    {
      question: "必须部署同步服务器吗？",
      answer:
        "不必。扩展单机完全可用。oncewise-ai-sync 服务器用于通过空间码把选定流程以带版本脚本共享给同事，开源且由你自己部署（容器镜像发布在 ghcr.io）。",
    },
    {
      question: "为什么要装一个本机宿主？",
      answer:
        "本机宿主（ai.oncewise.native）是 AI 工具用来在扩展中校验、保存和验证流程的本机通道。它是一个注册在用户层级的 Node.js 小脚本（需 Node 22+），只在内存中转发数据，不向磁盘写流程数据，也不经网络传输任何内容。",
    },
    {
      question: "与录制器有什么不同？",
      answer:
        "录制器记录你的点击并指望页面不变。这里由 AI 在真实页面上验证定位符；流程是带时间预算、任何人都能以纯 JSON 读懂的受约束步骤树；敏感值在侧边栏打码；每条流程都有开关、10 版本历史和删除按钮。",
    },
    {
      question: "是否免费开源？",
      answer:
        "是，Apache-2.0。扩展、同步后端和 agent skills 都在同一个仓库。没有账号体系，也没有付费档。",
    },
    {
      question: "可以获得帮助吗？",
      answer:
        "邮件 zsy.evan@gmail.com，或在 github.com/timzaak/OnceWise/issues 提交 issue。请不要在 issue 中粘贴流程 JSON、输入值或业务数据。",
    },
  ],
  ctaTitle: "别再一遍遍点同一个表单了",
  ctaDesc:
    "装上扩展，把例行操作交给助手，按下一次启用。之后的一百次，浏览器替你完成。",
  ctaContactHint: "有疑问，或正在自动化什么有意思的事？欢迎邮件联系：",
  starGithub: "Star on GitHub",
  footer: {
    copyright: "OnceWise Flow · Apache 2.0",
    contact: "联系我们",
    privacy: "隐私政策",
  },
};
