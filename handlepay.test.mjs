import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { openStore } from './store.mjs';
import { parseAmount } from './payment-input.mjs';
import { accountCreatedAt, lookalikes, safetySignals, overallRisk } from './commission.mjs';

function installProviderFixture() {
  const merchant = 'TESTMERCHANT1';
  // The first order captures as PENDING and settles by webhook. Later orders capture as COMPLETED.
  const orders = new Map();
  let tracking;
  globalThis.fetch = async (url, options) => {
    const { pathname } = new URL(url);
    const body = typeof options.body === 'string' && options.body.startsWith('{') ? JSON.parse(options.body) : null;
    const reply = (value, status = 200) => Response.json(value, { status });
    if (pathname === '/api/v10/oauth2/token') {
      if (options.body.get('code') !== 'fixture-code') throw new Error('Unexpected OAuth code');
      return reply({ access_token: 'fixture-discord-user' });
    }
    if (pathname === '/api/v10/users/@me') {
      if (options.headers.Authorization !== 'Bearer fixture-discord-user') throw new Error('Unexpected Discord token');
      return reply({ id: '100000000000000001', username: 'sender' });
    }
    if (pathname === '/v1/oauth2/token') return reply({ access_token: 'fixture', expires_in: 3600 });
    if (pathname === '/v2/customer/partner-referrals') {
      tracking = body.tracking_id;
      return reply({ links: [{ rel: 'action_url', href: 'https://www.sandbox.paypal.com/onboard' }] }, 201);
    }
    if (pathname === '/v1/customer/partners/PLATFORM/merchant-integrations/' + merchant) {
      return reply({ merchant_id: merchant, tracking_id: tracking, payments_receivable: true, primary_email_confirmed: true,
        oauth_integrations: [{ oauth_third_party: [{ partner_client_id: 'fixture-client',
          scopes: ['https://uri.paypal.com/services/payments/payment/authcapture',
            'https://uri.paypal.com/services/vault/payment-tokens/readwrite'] }] }] });
    }
    if (pathname === '/v3/vault/payment-tokens/VAULT-FIXTURE' && options.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (pathname === '/v2/checkout/orders') {
      if (body.purchase_units[0].payee.merchant_id !== merchant || body.purchase_units[0].amount.value !== '60.00') {
        throw new Error('Incorrect payee or amount');
      }
      if (orders.size === 2 && body.purchase_units[0].description !== 'Full-body character sheet, 2 poses') {
        throw new Error('Commission order is missing the agreed terms');
      }
      const suffix = orders.size ? '-' + (orders.size + 1) : '';
      const vaultId = body.payment_source?.paypal?.vault_id;
      if (vaultId) {
        // A saved PayPal is charged without a buyer redirect: the order comes back captured.
        if (vaultId !== 'VAULT-FIXTURE' || !options.headers['PayPal-Auth-Assertion'] || body.payment_source.paypal.experience_context) {
          throw new Error('Unexpected saved PayPal order');
        }
        const order = { id: 'SANDBOX-ORDER' + suffix, status: 'COMPLETED', purchase_units: [{ ...body.purchase_units[0],
          payments: { captures: [{ id: 'SANDBOX-CAPTURE' + suffix, status: 'COMPLETED', amount: body.purchase_units[0].amount }] } }] };
        orders.set(order.id, { order, approved: true, captureStatus: 'COMPLETED', captureId: 'SANDBOX-CAPTURE' + suffix });
        return reply(order, 201);
      }
      const wantsVault = body.payment_source?.paypal?.attributes?.vault?.store_in_vault === 'ON_SUCCESS';
      const order = { id: 'SANDBOX-ORDER' + suffix, purchase_units: body.purchase_units, status: 'CREATED',
        links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=SANDBOX-ORDER' + suffix }] };
      orders.set(order.id, { order, approved: false, captureStatus: null, captureId: 'SANDBOX-CAPTURE' + suffix, wantsVault,
        captureAs: orders.size ? 'COMPLETED' : 'PENDING' });
      return reply(order, 201);
    }
    const orderPath = pathname.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    if (orderPath && orders.has(orderPath[1])) {
      const state = orders.get(orderPath[1]);
      const { order } = state;
      if (orderPath[2]) {
        if (state.captureStatus || order.status !== 'APPROVED' || !options.headers['PayPal-Request-Id']?.startsWith('capture-')) {
          throw new Error('Unexpected capture');
        }
        state.captureStatus = state.captureAs;
        return reply({ id: order.id, status: 'COMPLETED' }, 201);
      }
      if (state.captureStatus) {
        order.status = 'COMPLETED';
        order.purchase_units[0].payments = { captures: [{ id: state.captureId, status: state.captureStatus,
          amount: order.purchase_units[0].amount,
          status_details: state.captureStatus === 'PENDING' ? { reason: 'PENDING_REVIEW' } : undefined }] };
        // Only the Discord fast-path order saves the buyer's PayPal in this scenario.
        if (state.wantsVault && order.id === 'SANDBOX-ORDER-2') {
          order.payment_source = { paypal: { attributes: { vault: { id: 'VAULT-FIXTURE', status: 'VAULTED' } } } };
        }
      } else if (state.approved) {
        order.status = 'APPROVED';
      } else {
        // The first lookup stands in for the buyer approving in PayPal.
        state.approved = true;
      }
      return reply(order);
    }
    if (pathname === '/v1/notifications/verify-webhook-signature') {
      if (body.transmission_sig !== 'fixture-valid' || body.webhook_id !== 'fixture-hook' ||
          !options.body.includes('"webhook_event":{\n  "id"')) {
        return reply({ verification_status: 'FAILURE' });
      }
      const orderId = body.webhook_event.resource.supplementary_data.related_ids.order_id;
      orders.get(orderId).captureStatus = 'COMPLETED';
      return reply({ verification_status: 'SUCCESS' });
    }
    const discordEdit = pathname.match(/^\/api\/v10\/webhooks\/fixture-app\/(fixture-interaction|fixture-component)\/messages\/@original$/);
    if (options.method === 'PATCH' && discordEdit) {
      const receipt = discordEdit[1] === 'fixture-interaction' ? 'SANDBOX-CAPTURE-2' : 'SANDBOX-CAPTURE-4';
      if (!body.content.startsWith('✅ Paid **$60.00** to `@pixelnova`. PayPal receipt `' + receipt + '`')) {
        throw new Error('Unexpected Discord update ' + body.content);
      }
      return reply({ id: 'fixture-message' });
    }
    if (pathname === '/v1/messages') {
      const headers = new Headers(options.headers);
      if (headers.get('authorization') !== 'Bearer fixture-anthropic' ||!headers.get('anthropic-beta')?.includes('server-side-fallback-2026-07-01') ||
          body.model !== 'claude-opus-5-5' || body.fallbacks !== 'default' || body.output_config.format.type !== 'json_schema' ||
          !body.messages[0].content.includes('<quote>\nFull-body character sheet')) {
        throw new Error('Unexpected Claude request');
      }
      return reply({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn',
        usage: { input_tokens: 600, output_tokens: 200 }, content: [{ type: 'text', text: JSON.stringify({
          summary: 'Full-body character sheet, 2 poses', deliverables: ['Full-body character sheet', '2 poses, flat colour'],
          amount_usd: 60, payment_type: 'full', deadline: 'By Friday', revisions: null,
          missing: ['Number of revisions', 'Usage rights'],
          red_flags: [{ kind: 'friends_and_family', evidence: 'send it as friends and family',
            explanation: 'Friends and Family payments have no PayPal buyer protection, so you could not get your money back.' }],
          risk: 'high', advice: 'Pay only through the swoosh.pay checkout, which uses Goods and Services, and agree on revisions first.'
        }) }] });
    }
    if (pathname === '/api/v10/users/100000000000000002') {
      return reply({ id: '100000000000000002', username: 'pixelnova' });
    }
    throw new Error('Unexpected provider request ' + pathname);
  };
}

test('USD amount is parsed exactly and rejects fractional cents and exponent notation', () => {
  assert.equal(parseAmount('60.05'), 6005);
  for (const value of ['0', '-1', '1.001', '1e2', '100000', null]) assert.equal(parseAmount(value), null);
});

test('Discord and web share review, seller onboarding, checkout and webhook reconciliation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'handlepay-test-'));
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const path = join(dir, 'test.db');
  const db = openStore(path);
  const sender = '100000000000000001';
  const recipient = '100000000000000002';
  const outsider = '100000000000000003';
  const sessions = new Map();
  for (const [id, username] of [[sender, 'sender'], [recipient, 'pixelnova'], [outsider, 'outsider']]) {
    const token = randomUUID();
    sessions.set(id, 'hp_session=' + token);
    db.run('INSERT INTO users(id, username) VALUES(?, ?)', id, username);
    db.run('INSERT INTO sessions VALUES(?, ?, ?)', token, id, Date.now() + 600000);
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const fixture = 'data:text/javascript;base64,' + Buffer.from('(' + installProviderFixture.toString() + ')()').toString('base64');
  const child = spawn(process.execPath, ['--import', fixture, 'server.mjs'], { env: { ...process.env, APP_ORIGIN: origin, PORT: String(port),
    HOST: '127.0.0.1', DATABASE_PATH: path, BUYLIST_ENV_FILE: '',
    DISCORD_APPLICATION_ID: 'fixture-app', DISCORD_CLIENT_SECRET: 'fixture-secret', DISCORD_BOT_TOKEN: 'fixture-bot',
    PAYPAL_CLIENT_ID: 'fixture-client', PAYPAL_CLIENT_SECRET: 'fixture-secret',
    PAYPAL_PARTNER_MERCHANT_ID: 'PLATFORM', PAYPAL_PARTNER_BN_CODE: 'fixture-bn', PAYPAL_WEBHOOK_ID: 'fixture-hook',
    ANTHROPIC_API_KEY: 'fixture-anthropic',
    DISCORD_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex') } });
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }
    db.close();
    rmSync(dir, { recursive: true });
  });
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => { throw new Error('Server exited with ' + code); })
  ]);
  const signIn = await fetch(origin + '/auth/discord', { redirect: 'manual' });
  assert.equal(signIn.status, 303);
  const state = new URL(signIn.headers.get('location')).searchParams.get('state');
  const stateCookie = signIn.headers.getSetCookie()[0].split(';')[0];
  const callback = (value, headers = {}) => fetch(origin + '/auth/discord/callback?' +
    new URLSearchParams({ state: value, code: 'fixture-code' }), { redirect: 'manual', headers });
  assert.equal((await callback(state)).status, 400);
  const signedIn = await callback(state, { Cookie: stateCookie });
  assert.equal(signedIn.status, 303);
  sessions.set(sender, signedIn.headers.getSetCookie().find(value => value.startsWith('hp_session=')).split(';')[0]);
  assert.equal((await callback(state, { Cookie: stateCookie })).status, 400);

  const interaction = async (event, valid = true, path = '/discord/interactions') => {
    const body = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
    return fetch(origin + path, { method: 'POST', body, headers: {
      'x-signature-timestamp': timestamp, 'x-signature-ed25519': valid ? signature : '00'.repeat(64)
    } });
  };
  assert.equal((await interaction({ type: 1 }, false)).status, 401);
  assert.deepEqual(await (await interaction({ type: 1 })).json(), { type: 1 });
  const senderHome = async () => (await fetch(origin, { headers: { Cookie: sessions.get(sender) } })).text();
  assert.match(await senderHome(), /Install Discord app/);
  const installationEvent = { type: 1, application_id: 'fixture-app', event: {
    type: 'APPLICATION_AUTHORIZED', timestamp: '2026-11-12T08:00:00.000',
    data: { integration_type: 1, scopes: ['applications.commands'], user: { id: sender } }
  } };
  assert.equal((await interaction(installationEvent, false, '/discord/events')).status, 401);
  assert.match(await senderHome(), /Install Discord app/);
  assert.equal((await interaction(installationEvent, true, '/discord/events')).status, 204);
  assert.doesNotMatch(await senderHome(), /Pay from a DM|Install Discord app/);
  const deauthorization = { ...installationEvent, event: {
    ...installationEvent.event, type: 'APPLICATION_DEAUTHORIZED', timestamp: '2026-11-12T08:01:00Z'
  } };
  assert.equal((await interaction(deauthorization, true, '/discord/events')).status, 204);
  assert.equal((await interaction(installationEvent, true, '/discord/events')).status, 204);
  assert.match(await senderHome(), /Install Discord app/);
  const event = { id: 'discord-retry-test', type: 2, user: { id: sender }, data: { name: 'pay',
    options: [{ name: 'recipient', value: recipient }, { name: 'amount', value: '60' }],
    resolved: { users: { [recipient]: { id: recipient, username: 'pixelnova' } } } } };
  const command = await (await interaction(event)).json();
  assert.equal(command.data.flags, 64);
  assert.deepEqual(await (await interaction(event)).json(), command);
  const reviewUrl = command.data.components[0].components[0].url;
  const review = await fetch(reviewUrl, { headers: { Cookie: sessions.get(sender) } });
  const reviewHtml = await review.text();
  assert.match(reviewHtml, /Waiting for recipient setup/);
  assert.equal((await fetch(reviewUrl, { headers: { Cookie: sessions.get(outsider) } })).status, 404);
  const payment = db.get('SELECT * FROM payments WHERE source_id = ?', event.id);
  assert.equal(payment.order_id, null);
  const inviteUrl = origin + '/invite/' + payment.invite;
  assert.match(reviewHtml, /<button[^>]*id="copy-invite"[^>]*>Copy invite link<\/button>/);
  assert.doesNotMatch(reviewHtml, /<input[^>]*id="invite"/);
  assert.match(review.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(review.headers.get('referrer-policy'), 'same-origin');
  assert.match(reviewHtml, /<script src="\/app\.js" defer><\/script>/);
  assert.equal((await fetch(origin + '/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  const script = await fetch(origin + '/copy-invite.js');
  assert.equal(script.status, 200);
  let click;
  let copied;
  const status = { textContent: '' };
  const button = {
    dataset: { inviteUrl: reviewHtml.match(/data-invite-url="([^"]+)"/)[1] },
    addEventListener: (event, handler) => {
      assert.equal(event, 'click');
      click = handler;
    }
  };
  const clipboard = { writeText: async value => { copied = value; } };
  runInNewContext(await script.text(), {
    document: { getElementById: id => id === 'copy-invite' ? button : status },
    navigator: { clipboard }
  });
  await click();
  assert.equal(copied, inviteUrl);
  assert.equal(status.textContent, 'Invite link copied.');
  clipboard.writeText = async () => { throw new Error('Clipboard access denied'); };
  await click();
  assert.match(status.textContent, /Could not copy/);
  assert.equal((await fetch(inviteUrl, { headers: { Cookie: sessions.get(outsider) } })).status, 404);
  assert.match(await (await fetch(inviteUrl, { headers: { Cookie: sessions.get(recipient) } })).text(), /Payment invitation/);
  const web = await fetch(origin + '/payments', { method: 'POST', redirect: 'manual', headers: {
    Cookie: sessions.get(sender), Origin: origin
  }, body: new URLSearchParams({ handle: '@newartist', amount: '25.50' }) });
  assert.equal(web.status, 303);
  const webPayment = db.get('SELECT * FROM payments WHERE source_id IS NULL');
  assert.equal(webPayment.handle, 'newartist');
  assert.equal(webPayment.cents, 2550);
  assert.equal(webPayment.order_id, null);

  const post = (path, id, fields = {}) => fetch(origin + path, { method: 'POST', redirect: 'manual',
    headers: { Cookie: sessions.get(id), Origin: origin }, body: new URLSearchParams(fields) });
  const crossOriginReferral = await fetch(origin + '/seller/connect', { method: 'POST', redirect: 'manual',
    headers: { Cookie: sessions.get(recipient), Origin: 'null' }, body: new URLSearchParams({ share_data: 'yes' }) });
  assert.equal(crossOriginReferral.status, 403);
  const referral = await post('/seller/connect', recipient, { share_data: 'yes' });
  assert.equal(referral.status, 303);
  assert.match(referral.headers.get('location'), /sandbox\.paypal\.com\/onboard/);
  const merchant = 'TESTMERCHANT1';
  const { referral: tracking } = db.get('SELECT referral FROM users WHERE id = ?', recipient);
  const linked = await fetch(origin + '/seller/return?' + new URLSearchParams({
    merchantId: tracking, merchantIdInPayPal: merchant
  }), { redirect: 'manual', headers: { Cookie: sessions.get(recipient) } });
  assert.equal(linked.status, 303);
  assert.equal(db.get('SELECT merchant FROM users WHERE id = ?', recipient).merchant, merchant);

  const ready = await fetch(reviewUrl, { headers: { Cookie: sessions.get(sender) } });
  const seller = (await ready.text()).match(/name="seller" value="([^"]+)"/)[1];
  const fields = { recipient, handle: 'pixelnova', seller };
  assert.equal((await post('/payments/' + payment.id + '/checkout', sender, { ...fields, seller: 'stale' })).status, 409);
  const approval = await post('/payments/' + payment.id + '/checkout', sender, fields);
  assert.equal(approval.status, 303);
  assert.equal(approval.headers.get('location'), 'https://www.sandbox.paypal.com/checkoutnow?token=SANDBOX-ORDER');
  const headers = { Cookie: sessions.get(sender) };
  const recipientHeaders = { Cookie: sessions.get(recipient) };
  assert.equal((await fetch(reviewUrl, { headers: recipientHeaders })).status, 404);
  await fetch(reviewUrl, { headers });
  assert.match(await (await fetch(reviewUrl, { headers })).text(), /Complete payment/);
  assert.equal((await post('/payments/' + payment.id + '/capture', sender)).status, 303);
  assert.match(await (await fetch(reviewUrl, { headers })).text(), /PayPal is reviewing this payment/);
  const incomingHome = await (await fetch(origin, { headers: recipientHeaders })).text();
  assert.match(incomingHome, /Incoming payments/);
  assert.match(incomingHome, /From @sender/);
  const incomingDetail = await (await fetch(reviewUrl, { headers: recipientHeaders })).text();
  assert.match(incomingDetail, /PayPal is reviewing this payment/);
  assert.doesNotMatch(incomingDetail, /Complete payment|Continue to PayPal/);
  assert.equal((await post('/payments/' + payment.id + '/capture', recipient)).status, 404);
  assert.equal((await fetch(reviewUrl, { headers: { Cookie: sessions.get(outsider) } })).status, 404);
  assert.equal((await post('/payments/' + payment.id + '/capture', sender)).status, 303);

  const eventBody = JSON.stringify({ id: 'webhook-1', event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: 'SANDBOX-CAPTURE', supplementary_data: { related_ids: { order_id: 'SANDBOX-ORDER' } } } }, null, 2);
  const webhook = signature => fetch(origin + '/paypal/webhooks', { method: 'POST', body: eventBody, headers: {
    'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
    'paypal-transmission-id': 'test', 'paypal-transmission-sig': signature, 'paypal-transmission-time': new Date().toISOString()
  } });
  assert.equal((await webhook('fixture-invalid')).status, 401);
  assert.equal((await webhook('fixture-valid')).status, 204);
  assert.equal((await webhook('fixture-valid')).status, 204);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM paypal_events').count, 1);
  assert.match(await (await fetch(reviewUrl, { headers })).text(), /PayPal receipt/);
  assert.match(await (await fetch(reviewUrl, { headers: recipientHeaders })).text(), /PayPal receipt/);
  const repeatWeb = await post('/payments', sender, { handle: '@pixelnova', amount: '12' });
  assert.equal(repeatWeb.status, 303);
  assert.equal(db.get('SELECT recipient FROM payments WHERE id = ?', repeatWeb.headers.get('location').split('/').at(-1)).recipient, recipient);

  // Fast path: /pay to a connected recipient opens PayPal straight from Discord and completes on return.
  const fastEvent = { ...event, id: 'discord-fast-pay', token: 'fixture-interaction' };
  const fast = await (await interaction(fastEvent)).json();
  assert.equal(fast.data.flags, 64);
  const [payButton, detailsButton] = fast.data.components[0].components;
  assert.equal(payButton.label, 'Pay $60.00 with PayPal');
  const fastPayment = db.get('SELECT * FROM payments WHERE source_id = ?', 'discord-fast-pay');
  assert.equal(payButton.url, origin + '/checkout/' + fastPayment.id);
  assert.equal(detailsButton.url, origin + '/payments/' + fastPayment.id);
  assert.equal(fastPayment.discord_token, 'fixture-interaction');
  assert.equal((await fetch(origin + '/checkout/' + payment.id.replace(/.$/, '0'), { redirect: 'manual' })).status, 404);
  const opening = await fetch(payButton.url, { redirect: 'manual' });
  assert.equal(opening.status, 200);
  assert.match(await opening.text(), /http-equiv="refresh" content="0;url=\/checkout\/[a-f0-9-]{36}\?go=1"[\s\S]*Opening PayPal/);
  assert.equal(db.get('SELECT order_id FROM payments WHERE id = ?', fastPayment.id).order_id, null);
  const go = await fetch(payButton.url + '?go=1', { redirect: 'manual' });
  assert.equal(go.status, 303);
  assert.equal(go.headers.get('location'), 'https://www.sandbox.paypal.com/checkoutnow?token=SANDBOX-ORDER-2');
  const returnUrl = origin + '/paypal/return/' + fastPayment.id;
  assert.match(await (await fetch(returnUrl)).text(), /http-equiv="refresh" content="0;url=\/paypal\/return\/[a-f0-9-]{36}\?complete=1"[\s\S]*Completing your payment/);
  const canceled = await (await fetch(returnUrl + '?complete=1')).text();
  assert.match(canceled, /No money was charged/);
  assert.match(canceled, /href="\/checkout\/[^"]+" data-loading="Opening PayPal…">Try again in PayPal/);
  const done = await (await fetch(returnUrl + '?complete=1')).text();
  assert.match(done, /Payment sent\. You can close this tab/);
  assert.match(done, /SANDBOX-CAPTURE-2/);
  const settled = db.get('SELECT * FROM payments WHERE id = ?', fastPayment.id);
  assert.equal(settled.status, 'paid');
  assert.equal(settled.discord_token, null);
  const again = await fetch(payButton.url, { redirect: 'manual' });
  assert.equal(again.headers.get('location'), '/paypal/return/' + fastPayment.id);
  const signedInReturn = await fetch(returnUrl, { redirect: 'manual', headers });
  assert.equal(signedInReturn.headers.get('location'), '/payments/' + fastPayment.id);

  // Commission review: right-click the artist's quote, Claude reads it, safety checks run, terms go on the PayPal order.
  const quoteMessage = { id: 'quote-1', author: { id: recipient, username: 'pixelnova' },
    content: 'Full-body character sheet, 2 poses, flat colour. $60, done by Friday. Please send it as friends and family to save fees!' };
  const quoteEvent = { id: 'discord-commission', type: 2, token: 'fixture-commission', user: { id: sender },
    data: { type: 3, name: 'Pay for this commission', target_id: 'quote-1', resolved: { messages: { 'quote-1': quoteMessage } } } };
  const ownQuote = await (await interaction({ ...quoteEvent, id: 'discord-own-quote', data: { ...quoteEvent.data,
    resolved: { messages: { 'quote-1': { ...quoteMessage, author: { id: sender, username: 'sender' } } } } } })).json();
  assert.match(ownQuote.data.content, /That message is yours/);
  const quoteReply = await (await interaction(quoteEvent)).json();
  assert.equal(quoteReply.data.flags, 64);
  const reviewButton = quoteReply.data.components[0].components[0];
  assert.equal(reviewButton.label, 'Review commission');
  assert.deepEqual(await (await interaction(quoteEvent)).json(), quoteReply);
  assert.match(await (await fetch(reviewButton.url)).text(), /http-equiv="refresh"[\s\S]*Reviewing the quote/);
  const analyzed = await fetch(reviewButton.url + '?go=1', { redirect: 'manual' });
  assert.equal(analyzed.status, 303);
  const commissionHtml = await (await fetch(reviewButton.url)).text();
  assert.match(commissionHtml, /pill-bad">High risk/);
  assert.match(commissionHtml, /Asks for Friends and Family/);
  assert.match(commissionHtml, /<q>send it as friends and family<\/q>/);
  assert.match(commissionHtml, /Discord account since/);
  assert.match(commissionHtml, /You&#39;ve paid @pixelnova before/);
  assert.match(commissionHtml, /class="chip">Usage rights/);
  assert.match(commissionHtml, /name="amount" value="60.00"/);
  assert.match(commissionHtml, /name="memo" maxlength="120" value="Full-body character sheet, 2 poses"/);
  assert.match(commissionHtml, /Continue to PayPal anyway/);
  assert.equal((await fetch(reviewButton.url + '/pay', { method: 'POST', redirect: 'manual', headers: { Origin: 'https://evil.example' },
    body: new URLSearchParams({ amount: '60' }) })).status, 403);
  const startPay = await fetch(reviewButton.url + '/pay', { method: 'POST', redirect: 'manual', headers: { Origin: origin },
    body: new URLSearchParams({ amount: '60', memo: 'Full-body character sheet, 2 poses' }) });
  assert.equal(startPay.status, 303);
  const commissionPayment = db.get("SELECT * FROM payments WHERE source_id LIKE 'commission:%'");
  assert.equal(startPay.headers.get('location'), '/checkout/' + commissionPayment.id);
  assert.equal(commissionPayment.recipient, recipient);
  assert.equal(commissionPayment.cents, 6000);
  assert.equal(commissionPayment.memo, 'Full-body character sheet, 2 poses');
  assert.equal(commissionPayment.discord_token, 'fixture-commission');
  const commissionCheckout = await fetch(origin + '/checkout/' + commissionPayment.id + '?go=1', { redirect: 'manual' });
  assert.equal(commissionCheckout.headers.get('location'), 'https://www.sandbox.paypal.com/checkoutnow?token=SANDBOX-ORDER-3');
  const repeatPay = await fetch(reviewButton.url + '/pay', { method: 'POST', redirect: 'manual', headers: { Origin: origin },
    body: new URLSearchParams({ amount: '60' }) });
  assert.equal(repeatPay.headers.get('location'), '/checkout/' + commissionPayment.id);
  assert.match(await (await fetch(origin + '/payments/' + commissionPayment.id, { headers })).text(), /<dt>For<\/dt><dd>Full-body character sheet, 2 poses/);

  // One-tap: the fast-path checkout saved the buyer's PayPal for this artist, so /pay now confirms inside Discord.
  assert.equal(db.get('SELECT vault_id FROM saved_wallets WHERE sender = ? AND merchant = ?', sender, merchant).vault_id, 'VAULT-FIXTURE');
  const oneTap = await (await interaction({ ...event, id: 'discord-one-tap', token: 'fixture-one-tap' })).json();
  const [confirmButton, cancelButton, checkoutButton] = oneTap.data.components[0].components;
  assert.equal(oneTap.data.flags, 64);
  assert.deepEqual([confirmButton.label, confirmButton.style, cancelButton.label, cancelButton.style], ['Confirm $60.00', 3, 'Cancel', 2]);
  const oneTapPayment = db.get('SELECT * FROM payments WHERE source_id = ?', 'discord-one-tap');
  assert.equal(confirmButton.custom_id, 'confirm:' + oneTapPayment.id);
  assert.equal(checkoutButton.url, origin + '/checkout/' + oneTapPayment.id);
  const tap = (customId, user = sender) => interaction({ id: 'click-' + randomUUID(), type: 3, token: 'fixture-component',
    user: { id: user }, data: { component_type: 2, custom_id: customId } });
  assert.match((await (await tap(confirmButton.custom_id, outsider)).json()).data.content, /someone else/);
  const confirmed = await (await tap(confirmButton.custom_id)).json();
  assert.equal(confirmed.type, 7);
  assert.match(confirmed.data.content, /^⏳ Paying \*\*\$60\.00\*\* to `@pixelnova` with your saved PayPal/);
  assert.deepEqual(confirmed.data.components, []);
  const oneTapRow = () => db.get('SELECT * FROM payments WHERE id = ?', oneTapPayment.id);
  for (let attempt = 0; attempt < 100 && oneTapRow().discord_token; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(oneTapRow().status, 'paid');
  assert.equal(oneTapRow().capture_id, 'SANDBOX-CAPTURE-4');
  assert.equal(oneTapRow().discord_token, null);
  assert.match((await (await tap(confirmButton.custom_id)).json()).data.content, /already being processed/);
  const toCancel = await (await interaction({ ...event, id: 'discord-one-tap-cancel' })).json();
  const cancelReply = await (await tap(toCancel.data.components[0].components[1].custom_id)).json();
  assert.equal(cancelReply.data.content, 'Canceled. No money was charged.');
  assert.match((await (await tap(toCancel.data.components[0].components[0].custom_id)).json()).data.content, /not available/);
  const bigOneTap = await (await interaction({ ...event, id: 'discord-one-tap-limit', data: { ...event.data,
    options: [{ name: 'recipient', value: recipient }, { name: 'amount', value: '600' }] } })).json();
  assert.equal(bigOneTap.data.components[0].components[0].label, 'Pay $600.00 with PayPal');
  assert.match(await senderHome(), /One-tap payments[\s\S]*@pixelnova/);
  assert.equal((await post('/saved/remove', sender, { merchant })).status, 303);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM saved_wallets').count, 0);
  assert.doesNotMatch(await senderHome(), /One-tap payments/);
});

test('commission safety checks: account age, lookalike handles and overall risk', () => {
  assert.equal(new Date(accountCreatedAt('175928847299117063')).toISOString(), '2016-04-30T11:18:25.796Z');
  const known = [{ id: '1', handle: 'pixelnova' }, { id: '2', handle: 'inkwell' }];
  assert.deepEqual(lookalikes('pixeinova', '9', known).map(match => match.handle), ['pixelnova']);
  assert.deepEqual(lookalikes('pixel_nova', '9', known).map(match => match.handle), ['pixelnova']);
  assert.deepEqual(lookalikes('pixelnova', '1', known), []);
  assert.deepEqual(lookalikes('mossbyte', '9', known), []);
  const now = Date.UTC(2026, 10, 12);
  const freshId = String(BigInt(now - 2 * 86400000 - 1420070400000) << 22n);
  const signals = safetySignals({ recipientId: freshId, handle: 'pixeinova', known, paidBefore: 0, connected: false, review: null, now });
  assert.deepEqual(signals.map(signal => [signal.level, signal.title]), [
    ['high', 'Discord account is 2 days old'], ['high', 'Looks like @pixelnova'], ['info', 'PayPal not connected yet']
  ]);
  assert.equal(overallRisk(signals, null), 'high');
  assert.equal(overallRisk([{ level: 'ok' }], { risk: 'medium' }), 'medium');
  assert.equal(overallRisk([{ level: 'ok' }, { level: 'info' }], { risk: 'low' }), 'low');
});
