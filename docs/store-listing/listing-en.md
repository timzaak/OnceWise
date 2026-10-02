# Chrome Web Store 详细描述 — English(直接粘贴到控制台 Detailed description)

> 短描述(132 字符上限)用 manifest `_locales/en/messages.json` 的 `extDescription`,勿在此另写:
> "Turn verified web interactions into local-first, site-scoped flows your AI tool imports; enable a flow and it runs automatically."

---

OnceWise AI turns repetitive web work into flows that run themselves — locally, with you in control of every site and every step.

Describe a web routine to your AI assistant (any agent that can drive Chrome, e.g. Claude Code, Cursor or ZCode with the OnceWise skills). The agent tries it on the real page, distills it into a constrained flow, and hands it over to this extension through a channel that never leaves your machine. One click enables the flow — from then on, whenever you open a matching page, OnceWise AI runs the steps for you.

WHY IT'S SAFE

• Local-first: flows, settings and version history live in your browser's local storage. No accounts, no analytics, no telemetry, no ads, no tracking.
• Site-scoped: a flow only runs on the site it was written for. Content scripts are registered only for origins that actually carry flows, and are removed when the last flow for a site is deleted.
• Constrained by design: flows are constrained step sequences (fill, click, read, wait, assert, loop) with time budgets — not arbitrary scripts. Sensitive values are redacted in the side panel.
• You stay in charge: every flow has an on/off switch, a 10-version history you can roll back to, and a delete button. The same business instance is never submitted twice in one session.
• The AI handover channel is a local native-messaging host (installed separately, requires Node 22+); whatever it carries stays on your device.

OPTIONAL SELF-HOSTED SYNC

Run the open-source oncewise-ai-sync server (or use one you trust) and share selected flows as versioned scripts across devices and teammates via space codes. Fully optional — the extension works without it.

GETTING STARTED

1. Install this extension.
2. In your AI tool, install the OnceWise skills from the repository below; they guide the agent to build, verify and hand over flows.
3. Install the native host once: `node skills/oncewise-message/install.mjs` (requires Node 22 or newer).
4. Ask your AI assistant to record a flow on the page you are on, then review it and press Enable in the side panel.

Flows can also arrive from a sync space: enter your server URL in the Sync tab and pull a shared script.

Source code and docs: https://github.com/timzaak/OnceWise
Privacy policy: https://timzaak.github.io/OnceWise/
