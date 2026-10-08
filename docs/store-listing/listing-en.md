# Chrome Web Store 详细描述 — English(直接粘贴到控制台 Detailed description)

> 短描述(132 字符上限)用 manifest `_locales/en/messages.json` 的 `extDescription`,勿在此另写:
> "Automate repetitive web tasks with AI: describe a routine, your AI tool builds a verified flow that auto-runs on matching pages."

---

You know the drill. Same page, same form, same twenty clicks, every single day. OnceWise Flow does them for you.

Describe the routine in plain language to your AI assistant (any agent that can drive Chrome works: Claude Code, Cursor or ZCode with the OnceWise skills). It tries the steps on the real page, turns them into a constrained flow, and hands it over through a channel that never leaves your machine. You review the flow and press Enable once. From then on, every time you open a matching page, the steps run by themselves.

WHAT IT'S FOR

• Forms you fill again and again: reports, ERP/OA screens, internal tools
• Multi-step routines that should just happen when you open the page: fill, click, read, wait, verify
• Handing a verified routine to teammates as a versioned script (with optional self-hosted sync)

Most automation tools hand you a recorder and wish you luck. OnceWise Flow flows are constrained step sequences with time budgets, not arbitrary scripts, and that is what makes them safe enough to run on pages you log into.

WHY IT'S SAFE: LOCAL-FIRST, NO ACCOUNTS, NO TRACKING

• Local-first: flows, settings and version history live in your browser's local storage. No accounts, no analytics, no telemetry, no ads, no tracking.
• Site-scoped: a flow only runs on the site it was written for. Content scripts load only on origins that actually carry flows, and are removed when the last flow for a site is deleted.
• Nothing hidden: open any flow and read every step (fill, click, read, wait, assert, loop). Sensitive values are redacted in the side panel.
• You stay in charge: every flow has an on/off switch, a 10-version history you can roll back to, and a delete button. The same business instance is never submitted twice in one session.
• The AI handover runs through a local native-messaging host (installed separately, requires Node 22+). Whatever it carries stays on your device.

OPTIONAL SELF-HOSTED SYNC

Run the open-source oncewise-ai-sync server, or point at one you trust, and share selected flows as versioned scripts across devices and teammates via space codes. Fully optional; the extension works without it.

GETTING STARTED

1. Install this extension.
2. Install the OnceWise skills in your AI tool (repository below); they guide the agent to build, verify and hand over flows.
3. Install the native host once: `node skills/oncewise-message/install.mjs` (requires Node 22 or newer).
4. Ask your assistant to record a flow on the page you are on, review it, and press Enable in the side panel.

Flows can also arrive from a sync space: enter your server URL in the Sync tab and pull a shared script.

Source code and docs: https://github.com/timzaak/OnceWise
Privacy policy: https://timzaak.github.io/OnceWise/
