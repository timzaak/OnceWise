// Store-upload shipping: uploads the zip produced by zip-store.mjs to the Chrome Web
// Store Publish API as a new console draft. CI counterpart of zip-store.mjs; also
// usable for manual uploads by exporting the same env vars.
//
// Auth is a self-signed RS256 service-account JWT exchanged for an access token at
// oauth2.googleapis.com (RFC 7523 jwt-bearer), scope chromewebstore. Deliberately NOT
// google-github-actions/auth: that action mints tokens through the IAM Service Account
// Credentials API, which needs both that API enabled (SERVICE_DISABLED without it) and
// roles/iam.serviceAccountTokenCreator granted to the SA on itself (PERMISSION_DENIED
// iam.serviceAccounts.getAccessToken without it) — both hit in practice 2026-10-07;
// the direct exchange needs nothing beyond the key itself.

import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function jsonBody(response, what) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 500)}`);
  }
}

async function main() {
  for (const name of ['CWS_SA_JSON', 'CWS_PUBLISHER_ID', 'CWS_ITEM_ID', 'ZIP_PATH']) {
    if (!process.env[name]) {
      throw new Error(`Missing required env ${name}.`);
    }
  }
  const extRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let sa;
  try {
    sa = JSON.parse(process.env.CWS_SA_JSON);
  } catch {
    throw new Error('CWS_SA_JSON is not valid JSON.');
  }

  const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const claims = b64url({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/chromewebstore',
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${signer.sign(sa.private_key, 'base64url')}`;

  const tokenResponse = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const token = await jsonBody(tokenResponse, 'Token exchange');
  if (!tokenResponse.ok) {
    throw new Error(`Token exchange failed (${tokenResponse.status}): ${JSON.stringify(token)}`);
  }

  const zipPath = path.resolve(extRoot, process.env.ZIP_PATH);
  const uploadUrl = `https://chromewebstore.googleapis.com/upload/v2/publishers/${process.env.CWS_PUBLISHER_ID}/items/${process.env.CWS_ITEM_ID}:upload`;
  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-File-Name': 'extension.zip',
    },
    body: await readFile(zipPath),
  });
  const upload = await jsonBody(uploadResponse, 'Package upload');
  console.log(JSON.stringify(upload, null, 2));
  if (upload.uploadState !== 'SUCCEEDED') {
    console.error(
      `::error::Upload state was '${upload.uploadState ?? 'none'}' (expected SUCCEEDED) — check the response above and the Developer Dashboard.`,
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
