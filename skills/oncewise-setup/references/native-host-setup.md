# Native Messaging host installation, troubleshooting, and removal

OnceWise AI uses `skills/oncewise-message/` to hand flows to its Chrome extension. Install and verify the host during `oncewise-setup`.

## Prerequisites

- Desktop Chrome 114+ on Windows, macOS, or Linux, with the OnceWise AI extension installed.
- Node.js 22 or later (prefer a supported LTS release). Check with `node --version`; the installer, host, and client enforce the minimum version.
- The skill repository's `skills/oncewise-message/` directory, containing `protocol.mjs`, `host.mjs`, `client.mjs`, `install.mjs`, and `uninstall.mjs`.

## Fixed extension ID

The extension manifest pins its `key`, so the extension ID is always `fkkfdckchahnjkcbimnbhonbgcefnafi`. The host manifest's `allowed_origins` contains only `chrome-extension://fkkfdckchahnjkcbimnbhonbgcefnafi/`, with no wildcard. For a development build loaded with a different key, explicitly pass `--extension-id <actual ID>` when installing.

## Install for the current user (no administrator rights)

```bash
cd <repository>/skills/oncewise-message
node install.mjs                       # Google Chrome (default)
node install.mjs --browser chromium    # Chromium, Playwright's bundled browser, etc.
node install.mjs --extension-id <id>   # Development build without the fixed key
```

The installer copies `host.mjs` and `protocol.mjs` to a stable user-level directory, creates a launcher using the current Node binary's absolute path, writes and registers the host manifest (`stdio`, exact origin), verifies what it wrote, and prints a JSON summary with `installed: true` and the paths. On failure it prints `installed: false` and a reason. Rerun it after fixing the cause. `client.mjs` stays in the skill directory for the AI to call; it needs no separate installation.

Installation and registration locations:

| Platform | Installation directory | Chrome registration |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\OnceWiseAI\native-host` | Registry `HKCU\Software\Google\Chrome\NativeMessagingHosts\ai.oncewise.native` (Chromium: `HKCU\Software\Chromium\...`) |
| macOS | `~/Library/Application Support/OnceWiseAI/native-host` | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.oncewise.native.json` (Chromium: `.../Chromium/...`) |
| Linux | `$XDG_DATA_HOME|~/.local/share` + `/oncewise-ai/native-host` | `~/.config/google-chrome/NativeMessagingHosts/ai.oncewise.native.json` (Chromium: `~/.config/chromium/...`) |

Local IPC endpoint between the AI client and host, scoped to the current user:

- Windows: named pipe `\\.\pipe\ai.oncewise.native-<username>`.
- macOS/Linux: Unix socket, with directory mode 0700 and socket mode 0600. The host refuses to start if it cannot enforce those modes. On macOS the socket is under `~/Library/Application Support/OnceWiseAI/ipc/`; on Linux it prefers `$XDG_RUNTIME_DIR` and falls back to `~/.local/run/oncewise-ai/`.

## Verify connectivity

After installation, start or restart Chrome so the extension calls `connectNative`, then run:

```bash
node client.mjs ping        # Expect one stdout JSON result: ok:true, data.schemaVersion
```

`ping` does not enumerate flows. See the failure table below. The channel is ready only when the response has `ok:true`.

## Troubleshooting

| Symptom | Meaning and action |
| --- | --- |
| `extension-not-connected` (ENOENT/ECONNREFUSED) | The host is not running: it may be uninstalled, Chrome may not have started or restarted, the extension may be disabled, or Chrome may have ended the host before it reconnected. Fix the cause and rerun `node client.mjs ping`. |
| `result-unknown` | The request was sent but no response arrived (disconnect or timeout). **Do not treat it as success or failure.** Use `flow.verify --ref <ref>` (the client echoes the ref to stderr) and inspect the extension's flow state. Before saving again, obtain a fresh user confirmation and issue a new ref. |
| `not-delivered` | The connection broke before the request was written. This is a definite failure; retry after repair. |
| `unsupported-op` | An operation outside this channel was requested (enable, delete, rollback, list, browser, script, etc.). Rejection is intentional and has no side effects. Do not retry. |
| `read-not-authorized` | `flow.read` requires the user to click the side-panel button `用 AI 优化` (Improve with AI), granting 15 minutes of read access. An expired grant or mismatched flow ID is rejected. |
| `revision-stale` / `flow-enabled` / `flow-not-found` | The original flow changed, was enabled, or was deleted after reading. Ask the user to start optimization again from the side panel; do not overwrite it. |
| `ref-expired` / `clock-regressed` / `bad-ref-time` | The clientRef is too old, or the clock moved backward or ahead. Check extension state, then obtain fresh user confirmation and issue a new ref. |
| Extension page shows `本机通道：未连接` (local channel disconnected) | The host is missing or Chrome has not started the extension. Verify the paths in the installer's JSON summary, restart Chrome, and refresh the page. |

On Windows, verify the `.cmd` launcher with real Chrome; registration alone does not prove connectivity.

## Uninstall

```bash
node uninstall.mjs                       # Unregister and remove the installation directory
node uninstall.mjs --keep-files          # Unregister only; retain the files
```

Uninstalling affects only the local channel. Flow execution, management, and sync in the extension continue to work. Restart Chrome for the change to take effect.

## Security boundary

- The host exposes IPC only to the current user. It does not use the network or expose IPC to page scripts. Stdout contains protocol frames only; diagnostics go to stderr.
- Both the host and extension validate the operation whitelist and payload. Unknown operations have no side effects.
- The channel supports only `ping`, `flow.read` (time-limited authorization), `flow.validate`, `flow.save`, and `flow.verify`. It cannot enable, delete, or roll back flows, run scripts, or operate the browser.
- Flow content and handoff records are not written to unnecessary persistent files. The host does not persist flow data.
