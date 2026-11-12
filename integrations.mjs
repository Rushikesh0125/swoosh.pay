import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const env = process.env;
const buylist = env.BUYLIST_ENV_FILE ? parseEnv(readFileSync(env.BUYLIST_ENV_FILE, 'utf8')) : {};
const clientId = env.PAYPAL_CLIENT_ID || buylist.PAYPAL_CLIENT_ID;
const clientSecret = env.PAYPAL_CLIENT_SECRET || buylist.PAYPAL_CLIENT_SECRET;
const paypalOrigin = 'https://api-m.sandbox.paypal.com';
const discordOrigin = 'https://discord.com/api/v10';
const discordKey = /^[a-f0-9]{64}$/i.test(env.DISCORD_PUBLIC_KEY || '')
  ? createPublicKey({ key: Buffer.from('302a300506032b6570032100' + env.DISCORD_PUBLIC_KEY, 'hex'), format: 'der', type: 'spki' })
  : null;

export const discordReady = Boolean(env.DISCORD_APPLICATION_ID && env.DISCORD_CLIENT_SECRET);
export const paypalReady = Boolean(clientId && clientSecret && env.PAYPAL_PARTNER_MERCHANT_ID && env.PAYPAL_PARTNER_BN_CODE);

export function validDiscordSignature(timestamp, signature, body) {
  if (!discordKey || !/^\d{10}$/.test(timestamp || '') || !/^[a-f0-9]{128}$/i.test(signature || '')) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  return verify(null, Buffer.concat([Buffer.from(timestamp), body]), discordKey, Buffer.from(signature, 'hex'));
}

async function request(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(`${new URL(url).hostname} returned ${response.status} ${data.name || ''}`.trim());
    error.status = response.status;
    throw error;
  }
  return data;
}

export function discordAuthorize(state, redirectUri) {
  return 'https://discord.com/oauth2/authorize?' + new URLSearchParams({
    client_id: env.DISCORD_APPLICATION_ID, response_type: 'code', scope: 'identify', state, redirect_uri: redirectUri
  });
}

export async function discordLogin(code, redirectUri) {
  const token = await request(discordOrigin + '/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: env.DISCORD_APPLICATION_ID,
      client_secret: env.DISCORD_CLIENT_SECRET, code, redirect_uri: redirectUri })
  });
  return request(discordOrigin + '/users/@me', { headers: { Authorization: 'Bearer ' + token.access_token } });
}

export async function discordUser(id) {
  if (!env.DISCORD_BOT_TOKEN) return null;
  return request(discordOrigin + '/users/' + id, { headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN } });
}

export function discordEditOriginal(interactionToken, message) {
  return request(discordOrigin + '/webhooks/' + encodeURIComponent(env.DISCORD_APPLICATION_ID) + '/' +
    encodeURIComponent(interactionToken) + '/messages/@original', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message)
  });
}

let paypalToken;
export async function paypal(path, { method = 'GET', body, rawBody, merchant, requestId } = {}) {
  if (!paypalReady) throw new Error('PayPal Platforms Sandbox is not configured');
  if (!paypalToken || paypalToken.expires < Date.now()) {
    const token = await request(paypalOrigin + '/v1/oauth2/token', {
      method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials'
    });
    paypalToken = { access: token.access_token, expires: Date.now() + (token.expires_in - 60) * 1000 };
  }
  const headers = { Authorization: 'Bearer ' + paypalToken.access, 'Content-Type': 'application/json',
    'PayPal-Partner-Attribution-Id': env.PAYPAL_PARTNER_BN_CODE, Prefer: 'return=representation' };
  if (merchant) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    headers['PayPal-Auth-Assertion'] = encode({ alg: 'none' }) + '.' + encode({ iss: clientId, payer_id: merchant }) + '.';
  }
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  return request(paypalOrigin + path, { method, headers, body: rawBody ?? (body && JSON.stringify(body)) });
}

export const paypalWebhookReady = Boolean(env.PAYPAL_WEBHOOK_ID);

export async function validPayPalWebhook(headers, rawEvent) {
  const metadata = { webhook_id: env.PAYPAL_WEBHOOK_ID };
  for (const field of ['auth_algo', 'cert_url', 'transmission_id', 'transmission_sig', 'transmission_time']) {
    const value = headers['paypal-' + field.replaceAll('_', '-')];
    if (typeof value !== 'string' || !value) return false;
    metadata[field] = value;
  }
  const rawBody = JSON.stringify(metadata).slice(0, -1) + ',"webhook_event":' + rawEvent + '}';
  const result = await paypal('/v1/notifications/verify-webhook-signature', { method: 'POST', rawBody });
  return result.verification_status === 'SUCCESS';
}

export function sellerStatus(merchantId) {
  return paypal('/v1/customer/partners/' + encodeURIComponent(env.PAYPAL_PARTNER_MERCHANT_ID) +
    '/merchant-integrations/' + encodeURIComponent(merchantId));
}

export function eligibleSeller(status) {
  return status.payments_receivable === true && status.primary_email_confirmed === true &&
    status.oauth_integrations?.some(integration => integration.oauth_third_party?.some(grant =>
      grant.partner_client_id === clientId && grant.scopes?.includes('https://uri.paypal.com/services/payments/payment/authcapture')));
}

if (process.argv[2] === 'register') {
  if (!env.DISCORD_APPLICATION_ID || !env.DISCORD_BOT_TOKEN) throw new Error('Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN');
  await request(discordOrigin + '/applications/' + env.DISCORD_APPLICATION_ID + '/commands', {
    method: 'POST', headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'pay', description: 'Pay someone with PayPal through swoosh.pay',
      integration_types: [1], contexts: [1, 2], options: [
        { type: 6, name: 'recipient', description: 'The Discord account you are paying', required: true },
        { type: 3, name: 'amount', description: 'USD amount, such as 60 or 60.50', required: true }
      ] })
  });
  console.log('Registered /pay for user installs and DMs.');
}
