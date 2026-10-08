import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // Dev loop convention: reuse the daily Chrome — dev does not auto-launch a browser;
  // the user loads .output/chrome-mv3-dev manually as unpacked into the daily Chrome (a stable path keeps the
  // extension ID stable); host tabs must be refreshed after content script changes; remove the dev extension when done.
  webExt: {
    disabled: true,
  },
  manifest: {
    // - storage: persistence for flows/config (wxt storage)
    // - scripting: runtime content script registration per flow site + executeScript top-up for
    //   already-open tabs (DEC-007 dynamic injection)
    // - nativeMessaging: connectNative port to the user-level host ai.oncewise.native — the AI's flow
    //   handover channel; nothing else in the extension uses it
    // - identity: launchWebAuthFlow + getRedirectURL for the sync sign-in on Herald-gated servers
    //   (the authorization window renders the real Herald pages; the extension builds no login form)
    // - host_permissions: all http(s) granted at install — every flow carries its own site, so there is
    //   no separate per-site authorization step; content scripts are still registered dynamically only
    //   for origins that actually carry flows
    // - the sidePanel permission and side_panel entry are injected automatically by the WXT sidepanel entrypoint;
    //   the toolbar action has no popup — the background sets openPanelOnActionClick so one icon click
    //   opens the sidepanel workbench directly on its flows view
    // - i18n: English-first (default_locale en); name/description resolve through _locales (en + zh)
    //   while all in-page UI strings live in lib/i18n.ts
    // - key: pinned RSA public key fixing the extension ID at fkkfdckchahnjkcbimnbhonbgcefnafi
    //   (SHA-256 of the SPKI DER, first 16 bytes mapped 0-f -> a-p). The native host manifest's
    //   allowed_origins binds to exactly this origin (skills/oncewise-message/protocol.mjs
    //   EXTENSION_ID). Dev instances that previously loaded without a key derive a different ID and
    //   cannot see old-profile flows — re-create them through the native channel (no migration promise).
    permissions: ['storage', 'scripting', 'nativeMessaging', 'identity'],
    host_permissions: ['http://*/*', 'https://*/*'],
    default_locale: 'en',
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu2xlgTnRF52dquirie1F6HpEzhdCE+4VWvhSR2gQe8oZ4g5fiGlFKAxC3JsEqKUCeddRwWABt6tt1d1kTr+PxB+66N3y1yqN+yLjS1mI6WzD9SfCoVMfB9fY7pVWVZxcVVVkcB/9EriubFOcnrKMxa8m6jwuF46axxCoi/XAti5hyfZ/QLjbqmbEQyNxMmKqO1IoYVDOBS75xtiW+gkPXIBHyY3hTo4gQBa/JcAVCIY95grPjLHbnpWJqRvIRKwF19gAQCUZeeme/rhuLw4yt1wTY8pNvcLm9gkyLPwifignU3gPnOVaki0koqNtW5zwLmhTA8ixMyfW9q7XPn+QDQIDAQAB',
    action: {
      default_title: '__MSG_extName__',
    },
  },
});
