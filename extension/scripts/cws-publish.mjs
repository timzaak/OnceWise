// Submits the item's current console draft for review (Chrome Web Store Publish
// API, publishTarget=default). Companion of cws-upload.mjs — same self-signed SA
// JWT auth, see its header for the token-exchange rationale. Console-only
// listing assets (screenshots/promo tiles) have no API and must be updated in
// the Developer Dashboard.

import { createSign } from 'node:crypto';

async function jsonBody(response, what) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 500)}`);
  }
}

async function main() {
  for (const name of ['CWS_SA_JSON', 'CWS_ITEM_ID']) {
    if (!process.env[name]) {
      throw new Error(`Missing required env ${name}.`);
    }
  }
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

  const publishUrl = `https://www.googleapis.com/chromewebstore/v1.1/items/${process.env.CWS_ITEM_ID}/publish?publishTarget=default`;
  const publishResponse = await fetch(publishUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const result = await jsonBody(publishResponse, 'Publish');
  console.log(JSON.stringify(result, null, 2));
  if (!publishResponse.ok) {
    throw new Error(`Publish failed (${publishResponse.status}): ${JSON.stringify(result)}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
