import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { parseAmount, parseHandle, canClaim } from './payment-input.mjs';
import { discordReady, paypalReady, discordAuthorize, discordLogin, discordUser, validDiscordSignature, discordEditOriginal,
  paypal, sellerStatus, eligibleSeller, paypalWebhookReady, validPayPalWebhook } from './integrations.mjs';
import { page, home, review, claim, result, working, failure, dollars, appScript, inviteScript, stylesheet } from './views.mjs';

export function createSwooshPay({ db, origin }) {
  const callback = origin + '/auth/discord/callback';
  const day = 86400000;
  const uuid = /^[0-9a-f-]{36}$/;
  const secure = origin.startsWith('https:') ? '; Secure' : '';

  function cookie(req, name) {
    return req.headers.cookie?.split('; ').find(value => value.startsWith(name + '='))?.slice(name.length + 1);
  }

  function setCookie(res, name, value, age) {
    res.appendHeader('Set-Cookie', name + '=' + value + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=' + age + secure);
  }

  function send(res, status, content, type = 'text/html; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type });
    res.end(content);
  }

  function redirect(res, location) {
    res.writeHead(303, { Location: location });
    res.end();
  }

  function error(status, message) {
    throw Object.assign(new Error(message), { httpStatus: status });
  }

  function json(res, value) {
    send(res, 200, JSON.stringify(value), 'application/json');
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 32768) error(413, 'Request is too large.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  function paymentBy(id) {
    return db.get('SELECT * FROM payments WHERE id = ?', id);
  }

  function userBy(id) {
    return db.get('SELECT * FROM users WHERE id = ?', id);
  }

  function fingerprint(merchant) {
    return merchant && createHash('sha256').update(merchant).digest('hex');
  }

  function paymentUnit(payment, order) {
    return order.id === payment.order_id && order.purchase_units?.find(unit =>
      unit.reference_id === payment.id && unit.payee?.merchant_id === payment.merchant &&
      unit.amount?.currency_code === 'USD' && unit.amount.value === (payment.cents / 100).toFixed(2));
  }

  async function newPayment({ sourceId = null, sender, recipient = null, handle, cents, discordToken = null }) {
    const id = randomUUID();
    // A Discord interaction token can edit the original reply for 15 minutes. Keep a margin.
    await db.run(`INSERT INTO payments(id, source_id, sender, recipient, handle, cents, invite, expires, discord_token, discord_token_expires)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id) DO NOTHING`,
      id, sourceId, sender, recipient, handle, cents, randomUUID(), Date.now() + 7 * day,
      discordToken, discordToken ? Date.now() + 14 * 60000 : null);
    return sourceId ? await db.get('SELECT * FROM payments WHERE source_id = ?', sourceId) : paymentBy(id);
  }

  function recordDiscordInstallation(userId, installed, timestamp) {
    return db.run(`INSERT INTO discord_installations (user_id, installed, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET installed = excluded.installed, updated_at = excluded.updated_at
      WHERE excluded.updated_at > discord_installations.updated_at`, userId, installed, timestamp);
  }

  async function interaction(req, res, webhook = false) {
    const body = await readBody(req);
    if (!validDiscordSignature(req.headers['x-signature-timestamp'], req.headers['x-signature-ed25519'], body)) {
      return send(res, 401, 'Invalid signature', 'text/plain');
    }
    const event = JSON.parse(body);
    if (webhook) {
      if (event.type === 1 && event.application_id === process.env.DISCORD_APPLICATION_ID) {
        const { type, data, timestamp } = event.event || {};
        const userId = data?.user?.id;
        const updatedAt = typeof timestamp === 'string'
          ? Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(timestamp) ? timestamp : timestamp + 'Z')
          : NaN;
        if (userId && Number.isFinite(updatedAt)) {
          if (type === 'APPLICATION_AUTHORIZED' && data.integration_type === 1 && data.scopes?.includes('applications.commands')) {
            await recordDiscordInstallation(userId, 1, updatedAt);
          } else if (type === 'APPLICATION_DEAUTHORIZED') {
            await recordDiscordInstallation(userId, 0, updatedAt);
          }
        }
      }
      return send(res, 204, '');
    }
    if (event.type === 1) return json(res, { type: 1 });
    const reply = (content, url, buttons = url ? [{ label: 'Open swoosh.pay', url }] : []) => json(res, { type: 4, data: {
      content, flags: 64, allowed_mentions: { parse: [] }, components: buttons.length ? [{ type: 1, components:
        buttons.map(button => ({ type: 2, style: 5, ...button })) }] : [] } });
    if (event.type !== 2 || event.data?.name !== 'pay') return reply('Use /pay to start a payment.');
    const sender = event.user || event.member?.user;
    if (sender?.id && event.authorizing_integration_owners?.['1'] === sender.id) {
      const issuedAt = Number((BigInt(event.id) >> 22n) + 1420070400000n);
      await recordDiscordInstallation(sender.id, 1, issuedAt);
    }
    const options = Object.fromEntries((event.data.options || []).map(option => [option.name, option.value]));
    const recipient = event.data.resolved?.users?.[options.recipient];
    const cents = parseAmount(options.amount);
    if (!sender?.id || !recipient || recipient.bot || recipient.id === sender.id || !cents) {
      return reply('Choose another Discord user and enter a positive USD amount with up to two decimals.');
    }
    const payment = await newPayment({ sourceId: event.id, sender: sender.id, recipient: recipient.id,
      handle: recipient.username, cents, discordToken: typeof event.token === 'string' ? event.token : null });
    const linked = await userBy(recipient.id);
    if (linked?.merchant && paypalReady) {
      const amount = dollars(payment.cents);
      return reply('**' + amount + '** to `@' + payment.handle + '`\nTap Pay to approve in PayPal. ' +
        'The payment completes as soon as you approve, and this message updates with the receipt.', null, [
        { label: 'Pay ' + amount + ' with PayPal', url: origin + '/checkout/' + payment.id },
        { label: 'Details', url: origin + '/payments/' + payment.id }
      ]);
    }
    return reply('Review your payment in swoosh.pay. If the recipient needs to connect, you can share an invite from there.',
      origin + '/payments/' + payment.id);
  }

  async function createOrder(payment, recipient) {
    if (!paypalReady) error(503, 'PayPal Platforms Sandbox is not configured.');
    if (payment.expires <= Date.now() && !payment.order_id) error(410, 'This request has expired.');
    if (!recipient?.merchant) error(409, 'The recipient needs to connect PayPal first.');
    if (payment.merchant && payment.merchant !== recipient.merchant) error(409, 'The recipient changed PayPal accounts. Create a new payment.');
    if (payment.order_id) return paypal('/v2/checkout/orders/' + payment.order_id, { merchant: payment.merchant });
    if (payment.create_started && Date.now() - payment.create_started > 5 * 3600000) {
      error(409, 'The previous checkout could not be recovered. Check PayPal before creating a new payment.');
    }
    const status = await sellerStatus(recipient.merchant);
    if (!eligibleSeller(status)) error(409, 'The recipient’s PayPal account needs attention before it can receive this payment.');
    await db.run(`UPDATE payments SET merchant = ?, create_started = COALESCE(create_started, ?)
      WHERE id = ? AND merchant IS NULL`, recipient.merchant, Date.now(), payment.id);
    const current = await paymentBy(payment.id);
    if (current.merchant !== recipient.merchant) error(409, 'The recipient changed. Review the payment again.');
    const url = origin + '/paypal/return/' + payment.id;
    const result = await paypal('/v2/checkout/orders', {
      method: 'POST', merchant: current.merchant, requestId: 'create-' + current.id,
      body: { intent: 'CAPTURE', purchase_units: [{
        reference_id: current.id, payee: { merchant_id: current.merchant },
        amount: { currency_code: 'USD', value: (current.cents / 100).toFixed(2) }
      }], payment_source: { paypal: { experience_context: {
        shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', return_url: url, cancel_url: url
      } } } }
    });
    await db.run(`UPDATE payments SET order_id = ?, status = 'awaiting_approval' WHERE id = ? AND order_id IS NULL`, result.id, current.id);
    return result;
  }

  function orderCapture(payment, order) {
    const unit = paymentUnit(payment, order);
    return unit?.payments?.captures?.find(value =>
      value.amount?.currency_code === 'USD' && value.amount.value === (payment.cents / 100).toFixed(2));
  }

  async function reconcile(payment, order) {
    const capture = orderCapture(payment, order);
    if (!capture?.id) return null;
    const status = { COMPLETED: 'paid', PENDING: 'processing', DECLINED: 'failed', DENIED: 'failed', FAILED: 'failed',
      REFUNDED: 'refunded', PARTIALLY_REFUNDED: 'partially_refunded' }[capture.status];
    if (!status) return null;
    await db.run(`UPDATE payments SET capture_id = ?, status = ? WHERE id = ?
      AND (status NOT IN ('paid', 'refunded', 'partially_refunded') OR ? IN ('refunded', 'partially_refunded'))
      AND (status != 'refunded' OR ? = 'refunded')`, capture.id, status, payment.id, status, status);
    return status;
  }

  const captureEvents = new Set(['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING',
    'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.REFUNDED']);

  async function paypalWebhook(req, res) {
    if (!paypalReady || !paypalWebhookReady) return send(res, 503, 'Webhook is not configured', 'text/plain');
    const raw = (await readBody(req)).toString('utf8');
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return send(res, 400, 'Invalid event', 'text/plain');
    }
    if (typeof event?.id !== 'string' || !await validPayPalWebhook(req.headers, raw)) {
      return send(res, 401, 'Invalid signature', 'text/plain');
    }
    if (!captureEvents.has(event.event_type) || await db.get('SELECT 1 FROM paypal_events WHERE id = ?', event.id)) {
      return send(res, 204, '');
    }
    const related = event.resource?.supplementary_data?.related_ids;
    const orderId = related?.order_id || null;
    const captureId = related?.capture_id || (event.event_type === 'PAYMENT.CAPTURE.REFUNDED' ? null : event.resource?.id) || null;
    const payment = await db.get('SELECT * FROM payments WHERE order_id = ? OR capture_id = ?', orderId, captureId);
    if (!payment) return send(res, 204, '');
    const order = await paypal('/v2/checkout/orders/' + payment.order_id, { merchant: payment.merchant });
    const status = await reconcile(payment, order);
    const reflected = event.event_type === 'PAYMENT.CAPTURE.PENDING' ? Boolean(status)
      : event.event_type === 'PAYMENT.CAPTURE.DENIED' ? status === 'failed'
      : event.event_type === 'PAYMENT.CAPTURE.REFUNDED' ? ['refunded', 'partially_refunded'].includes(status)
      : ['paid', 'refunded', 'partially_refunded'].includes(status);
    if (!reflected) return send(res, 503, 'PayPal order is still updating', 'text/plain');
    await db.run('INSERT OR IGNORE INTO paypal_events VALUES(?, ?)', event.id, Date.now());
    await notifyDiscord(payment.id);
    return send(res, 204, '');
  }

  async function notifyDiscord(id) {
    const payment = await paymentBy(id);
    if (!payment?.discord_token || payment.discord_token_expires <= Date.now()) return;
    const amount = dollars(payment.cents);
    const content = {
      paid: '✅ Paid **' + amount + '** to `@' + payment.handle + '`. PayPal receipt `' + payment.capture_id + '`.',
      processing: '⏳ **' + amount + '** to `@' + payment.handle + '` is processing in PayPal.',
      failed: 'PayPal declined **' + amount + '** to `@' + payment.handle + '`. No money was sent. Run /pay to try again.'
    }[payment.status];
    if (!content) return;
    try {
      await discordEditOriginal(payment.discord_token, { content, allowed_mentions: { parse: [] }, components: [{ type: 1, components: [
        { type: 2, style: 5, label: payment.status === 'paid' ? 'View receipt' : 'Details', url: origin + '/payments/' + payment.id }
      ] }] });
    } catch (err) {
      console.error('Discord message update failed: ' + err.message);
      return;
    }
    if (payment.status !== 'processing') {
      await db.run('UPDATE payments SET discord_token = NULL WHERE id = ? AND discord_token = ?', payment.id, payment.discord_token);
    }
  }

  async function checkout(payment, recipient, res, done = '/payments/' + payment.id) {
    const order = await createOrder(payment, recipient);
    await reconcile(await paymentBy(payment.id), order);
    if (order.status === 'APPROVED' || order.status === 'COMPLETED') return redirect(res, done);
    const href = order.links?.find(link => ['approve', 'payer-action'].includes(link.rel))?.href;
    if (!href || new URL(href).origin !== 'https://www.sandbox.paypal.com') {
      error(502, 'PayPal did not return a Sandbox approval link.');
    }
    return redirect(res, href);
  }

  async function capture(payment, order) {
    await reconcile(payment, order);
    if (order.status !== 'APPROVED') return;
    if (!paymentUnit(payment, order)) error(409, 'The PayPal order could not be matched to this payment.');
    if (payment.capture_started && Date.now() - payment.capture_started > 5 * 3600000) {
      error(409, 'This capture attempt needs review in PayPal.');
    }
    await db.run('UPDATE payments SET capture_started = COALESCE(capture_started, ?) WHERE id = ?', Date.now(), payment.id);
    const result = await paypal('/v2/checkout/orders/' + payment.order_id + '/capture', {
      method: 'POST', merchant: payment.merchant, requestId: 'capture-' + payment.id
    });
    const confirmed = paymentUnit(payment, result) ? result :
      await paypal('/v2/checkout/orders/' + payment.order_id, { merchant: payment.merchant });
    await reconcile(payment, confirmed);
  }

  async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    // Browser form POSTs need a same-origin Origin header for the CSRF check.
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self' https://www.sandbox.paypal.com https://sandbox.paypal.com; frame-ancestors 'none'; base-uri 'none'");
    const url = new URL(req.url, origin);
    const path = url.pathname;
    const post = req.method === 'POST';
    if (post && path === '/discord/interactions') return interaction(req, res);
    if (post && path === '/discord/events') return interaction(req, res, true);
    if (post && path === '/paypal/webhooks') return paypalWebhook(req, res);
    if (post && req.headers.origin !== origin) error(403, 'Open this action from swoosh.pay.');
    if (!post && req.method !== 'GET') error(405, 'Method not allowed.');
    if (!post && path === '/style.css') return send(res, 200, stylesheet, 'text/css; charset=utf-8');
    if (!post && path === '/copy-invite.js') return send(res, 200, inviteScript, 'text/javascript; charset=utf-8');
    if (!post && path === '/app.js') return send(res, 200, appScript, 'text/javascript; charset=utf-8');
    const sessionToken = cookie(req, 'hp_session');
    const session = sessionToken && await db.get('SELECT * FROM sessions WHERE token = ? AND expires > ?', sessionToken, Date.now());
    const user = session && await userBy(session.user_id);
    const login = target => '/auth/discord?next=' + encodeURIComponent(target);

    if (!post && path === '/auth/discord') {
      if (!discordReady) error(503, 'Discord sign-in is not configured. See the setup instructions.');
      const target = url.searchParams.get('next') || '/';
      if (!/^\/(?:payments\/[a-f0-9-]{36}|invite\/[a-f0-9-]{36})?$/.test(target)) error(400, 'Invalid return path.');
      const state = randomUUID();
      await db.run('INSERT INTO oauth VALUES(?, ?, ?)', state, target, Date.now() + 600000);
      setCookie(res, 'hp_oauth', state, 600);
      return redirect(res, discordAuthorize(state, callback));
    }
    if (!post && path === '/auth/discord/callback') {
      const state = url.searchParams.get('state');
      if (!state || state !== cookie(req, 'hp_oauth')) error(400, 'Sign-in expired. Try again.');
      const pending = await db.get('DELETE FROM oauth WHERE state = ? RETURNING *', state);
      const code = url.searchParams.get('code');
      if (!pending || pending.expires < Date.now() || !code) error(400, 'Sign-in expired or was canceled.');
      const profile = await discordLogin(code, callback);
      await db.run(`INSERT INTO users(id, username) VALUES(?, ?)
        ON CONFLICT(id) DO UPDATE SET username = excluded.username`, profile.id, profile.username);
      if (session) await db.run('DELETE FROM sessions WHERE token = ?', session.token);
      const token = randomUUID();
      await db.run('INSERT INTO sessions VALUES(?, ?, ?)', token, profile.id, Date.now() + 7 * day);
      setCookie(res, 'hp_oauth', '', 0);
      setCookie(res, 'hp_session', token, 604800);
      return redirect(res, pending.target);
    }
    if (post && path === '/logout') {
      if (session) await db.run('DELETE FROM sessions WHERE token = ?', session.token);
      setCookie(res, 'hp_session', '', 0);
      return redirect(res, '/');
    }
    if (!post && path === '/') {
      const payments = user ? await db.all('SELECT * FROM payments WHERE sender = ? ORDER BY rowid DESC LIMIT 12', user.id) : [];
      const incoming = user ? await db.all(`SELECT p.id, p.cents, p.status, s.username AS sender_name
        FROM payments p LEFT JOIN users s ON s.id = p.sender
        WHERE p.recipient = ? AND p.capture_id IS NOT NULL ORDER BY p.rowid DESC LIMIT 12`, user.id) : [];
      const installation = user && await db.get(`SELECT COALESCE(
        (SELECT installed FROM discord_installations WHERE user_id = ?),
        EXISTS(SELECT 1 FROM payments WHERE sender = ? AND source_id IS NOT NULL)
      ) AS installed`, user.id, user.id);
      return send(res, 200, page(home({ user, payments, incoming, discordReady, paypalReady,
        discordInstalled: Boolean(installation?.installed) }), user));
    }
    if (post && path === '/payments') {
      if (!user) return redirect(res, login('/'));
      const form = new URLSearchParams((await readBody(req)).toString());
      const handle = parseHandle(form.get('handle'));
      const cents = parseAmount(form.get('amount'));
      if (!handle || !cents) error(400, 'Enter a valid Discord username and positive USD amount.');
      const matches = await db.all('SELECT * FROM users WHERE username = ?', handle);
      let recipient = null;
      for (const match of matches) {
        const profile = await discordUser(match.id).catch(err => { if (err.status !== 404) throw err; });
        if (profile && profile.username !== match.username) await db.run('UPDATE users SET username = ? WHERE id = ?', profile.username, match.id);
        if (profile?.username === handle) { recipient = profile.id; break; }
      }
      if (recipient === user.id || handle === user.username) error(400, 'Choose a recipient other than yourself.');
      const payment = await newPayment({ sender: user.id, recipient, handle, cents });
      return redirect(res, '/payments/' + payment.id);
    }
    const invitePath = path.match(/^\/invite\/([^/]+)$/);
    if (invitePath && uuid.test(invitePath[1])) {
      if (!user) return redirect(res, login(path));
      const payment = await db.get('SELECT * FROM payments WHERE invite = ?', invitePath[1]);
      if (!payment || !canClaim(payment, user)) error(404, 'This invitation is unavailable for this Discord account.');
      if (post) {
        if (!payment.recipient) {
          const profile = await discordUser(user.id);
          if (profile?.username !== payment.handle) error(409, 'Discord could not verify this account’s current username.');
        }
        const result = await db.run(`UPDATE payments SET recipient = ? WHERE id = ? AND order_id IS NULL AND expires > ?
          AND (recipient = ? OR (recipient IS NULL AND handle = ?))`, user.id, payment.id, Date.now(), user.id, user.username);
        if (!result.changes) error(409, 'This invite has changed. Ask the sender for a new link.');
        return redirect(res, path);
      }
      return send(res, 200, page(claim(payment, user, paypalReady, await userBy(payment.sender)), user));
    }
    if (post && path === '/seller/connect') {
      if (!user) return redirect(res, login('/'));
      if (user.merchant) error(409, 'This Discord account already has a PayPal seller connection.');
      if (!paypalReady) error(503, 'PayPal Platforms Sandbox is not configured.');
      const form = new URLSearchParams((await readBody(req)).toString());
      if (form.get('share_data') !== 'yes') error(400, 'Agree to share seller account information before connecting PayPal.');
      const tracking = randomUUID();
      await db.run('UPDATE users SET referral = ? WHERE id = ?', tracking, user.id);
      const result = await paypal('/v2/customer/partner-referrals', { method: 'POST', body: {
        tracking_id: tracking, partner_config_override: { return_url: origin + '/seller/return' },
        operations: [{ operation: 'API_INTEGRATION', api_integration_preference: { rest_api_integration: {
          integration_method: 'PAYPAL', integration_type: 'THIRD_PARTY', third_party_details: { features: ['PAYMENT', 'REFUND'] }
        } } }], products: ['EXPRESS_CHECKOUT'], legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }]
      } });
      const link = result.links?.find(value => value.rel === 'action_url')?.href;
      if (!link || new URL(link).protocol !== 'https:' || !['www.sandbox.paypal.com', 'sandbox.paypal.com'].includes(new URL(link).hostname)) {
        error(502, 'PayPal did not return a Sandbox onboarding link.');
      }
      return redirect(res, link);
    }
    if (!post && path === '/seller/return') {
      const tracking = url.searchParams.get('merchantId');
      const merchant = url.searchParams.get('merchantIdInPayPal');
      if (!user?.referral || tracking !== user.referral || !/^[A-Z0-9]{13}$/.test(merchant || '')) {
        error(400, 'This PayPal connection could not be matched to your account.');
      }
      const status = await sellerStatus(merchant);
      if (status.merchant_id !== merchant || status.tracking_id !== tracking || !eligibleSeller(status)) {
        error(409, 'Complete PayPal onboarding and confirm your PayPal email before trying again.');
      }
      const result = await db.run('UPDATE users SET merchant = ?, referral = NULL WHERE id = ? AND referral = ? AND merchant IS NULL',
        merchant, user.id, tracking);
      if (!result.changes) error(409, 'A newer connection request has replaced this one.');
      return redirect(res, '/');
    }
    const fastPath = path.match(/^\/checkout\/([a-f0-9-]{36})$/);
    if (!post && fastPath) {
      // Opened from the sender-only Discord reply. Whoever approves pays with their own PayPal,
      // and the recipient and amount were fixed when the command ran, so no swoosh.pay sign-in is needed.
      const payment = await paymentBy(fastPath[1]);
      if (!payment?.source_id) error(404, 'Payment request unavailable.');
      if (['paid', 'processing', 'refunded', 'partially_refunded'].includes(payment.status)) {
        return redirect(res, '/paypal/return/' + payment.id);
      }
      if (payment.status === 'failed') error(409, 'PayPal declined this payment. Run /pay again to start a new one.');
      if (!url.searchParams.has('go')) {
        // Paint a loading screen first; the refresh does the slow PayPal work while it stays visible.
        return send(res, 200, page(working({ title: 'Opening PayPal…',
          detail: 'Setting up your ' + dollars(payment.cents) + ' payment to @' + payment.handle + '.', next: path + '?go=1' }), user));
      }
      return checkout(payment, payment.recipient && await userBy(payment.recipient), res, '/paypal/return/' + payment.id);
    }
    const returned = path.match(/^\/paypal\/return\/([a-f0-9-]{36})$/);
    if (!post && returned) {
      let payment = await paymentBy(returned[1]);
      if (!payment) error(404, 'Payment request unavailable.');
      if (payment.order_id && !['paid', 'failed', 'refunded', 'partially_refunded'].includes(payment.status)) {
        if (!url.searchParams.has('complete')) {
          return send(res, 200, page(working({ title: 'Completing your payment…',
            detail: 'Confirming ' + dollars(payment.cents) + ' to @' + payment.handle + ' with PayPal. Keep this tab open.',
            next: path + '?complete=1' }), user));
        }
        const order = await paypal('/v2/checkout/orders/' + payment.order_id, { merchant: payment.merchant });
        await capture(payment, order);
        await notifyDiscord(payment.id);
        payment = await paymentBy(payment.id);
      }
      if (user?.id === payment.sender) return redirect(res, '/payments/' + payment.id);
      return send(res, 200, page(result(payment), user));
    }
    const paymentPath = path.match(/^\/payments\/([a-f0-9-]{36})(?:\/(checkout|capture))?$/);
    if (paymentPath) {
      if (!user) return redirect(res, login('/payments/' + paymentPath[1]));
      const payment = await paymentBy(paymentPath[1]);
      const incoming = Boolean(payment && payment.sender !== user.id && payment.recipient === user.id && payment.capture_id);
      if (!payment || (payment.sender !== user.id && (!incoming || post))) error(404, 'Payment request unavailable.');
      const recipient = payment.recipient && await userBy(payment.recipient);
      const action = paymentPath[2];
      if (post && action === 'checkout') {
        const form = new URLSearchParams((await readBody(req)).toString());
        if (!recipient?.merchant || form.get('recipient') !== recipient.id || form.get('handle') !== recipient.username ||
            form.get('seller') !== fingerprint(recipient.merchant)) {
          error(409, 'The recipient changed. Return to the payment and review the current details.');
        }
        return checkout(payment, recipient, res);
      }
      if ((post && action !== 'capture') || (!post && action)) error(405, 'Method not allowed.');
      let order;
      if (payment.order_id && !['paid', 'failed', 'refunded', 'partially_refunded'].includes(payment.status)) {
        order = await paypal('/v2/checkout/orders/' + payment.order_id, { merchant: payment.merchant });
        await reconcile(payment, order);
      }
      if (post) {
        if (order) {
          await capture(payment, order);
          await notifyDiscord(payment.id);
        }
        return redirect(res, path.replace(/\/capture$/, ''));
      }
      const sender = incoming ? await userBy(payment.sender) : null;
      return send(res, 200, page(review(await paymentBy(payment.id), recipient, order, origin, paypalReady,
        fingerprint(recipient?.merchant), { incoming, sender, pendingReason: order && orderCapture(payment, order)?.status_details?.reason }), user));
    }
    error(404, 'Page not found.');
  }

  return createServer((req, res) => {
    handler(req, res).catch(err => {
      if (res.headersSent) return res.end();
      if (!err.httpStatus) console.error(err.message);
      send(res, err.httpStatus || 502, page(failure(err.httpStatus ? err.message
        : 'swoosh.pay could not reach Discord or PayPal. Try again in a moment.')));
    });
  });
}
