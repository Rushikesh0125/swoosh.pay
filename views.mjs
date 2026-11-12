const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const dollars = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const shortDate = ms => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(ms);
const labels = { draft: 'Draft', awaiting_approval: 'Awaiting approval', processing: 'Processing',
  paid: 'Paid', failed: 'Payment failed', refunded: 'Refunded', partially_refunded: 'Partially refunded' };
const tones = { draft: 'neutral', awaiting_approval: 'accent', processing: 'warn', paid: 'good', failed: 'bad',
  refunded: 'neutral', partially_refunded: 'neutral' };
const settled = ['processing', 'paid', 'failed', 'refunded', 'partially_refunded'];

const arrow = '<span class="arrow" aria-hidden="true">→</span>';
const mark = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="currentColor"/>
  <path d="M7.5 21.5C11 12 19 9.5 24.5 12.5" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>
  <circle cx="23" cy="20.5" r="2.6" fill="#fff"/></svg>`;

function avatar(name, size = '') {
  const value = String(name || '?');
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.codePointAt(0)) % 5;
  return `<span class="avatar av-${hash}${size ? ' avatar-' + size : ''}" aria-hidden="true">${escape(value[0].toUpperCase())}</span>`;
}

const pill = (text, tone) => `<span class="pill pill-${tone}">${escape(text)}</span>`;

const stateText = { done: 'Done', current: 'In progress', todo: 'Not started', failed: 'Failed' };
function progress(steps) {
  return `<ol class="progress">${steps.map(step => `<li class="step step-${step.state}">
    <span class="step-dot" aria-hidden="true"></span><span class="step-label">${escape(step.label)}
    <span class="sr-only">(${stateText[step.state]})</span></span>
    ${step.note ? `<span class="step-note">${escape(step.note)}</span>` : ''}</li>`).join('')}</ol>`;
}

function party(label, name) {
  return `<div class="party">${avatar(name, 'lg')}<div class="party-text"><span class="party-label">${label}</span>
    <span class="handle">@${escape(name)}</span></div></div>`;
}

const slashCommand = `<div class="slash" aria-label="Example command: /pay recipient @pixelnova amount 60">
  <span class="slash-cmd">/pay</span><span class="slash-opt"><span>recipient</span><b>@pixelnova</b></span>
  <span class="slash-opt"><span>amount</span><b>60</b></span></div>`;

const connectForm = `<form method="post" action="/seller/connect" class="form form-tight">
  <label class="consent"><input type="checkbox" id="share_data" name="share_data" value="yes" required>
  <span>I agree to share my PayPal seller account information with swoosh.pay so I can receive payments.</span></label>
  <button class="button button-secondary" type="submit" data-loading="Opening PayPal…">Connect PayPal ${arrow}</button></form>`;

export function page({ title, body, refresh }, user) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="light dark"><meta name="theme-color" content="#f3f4f7" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0d0f15" media="(prefers-color-scheme: dark)">
  ${refresh ? `<meta http-equiv="refresh" content="0;url=${escape(refresh)}">` : ''}
  <title>${escape(title)} · swoosh.pay</title><link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script></head>
  <body><header class="topbar"><div class="wrap topbar-inner">
    <a class="brand" href="/">${mark}<span>swoosh<span class="brand-dot">.</span>pay</span></a>
    <span class="env" title="Test accounts only. No real money moves.">Sandbox</span>
    ${user ? `<form method="post" action="/logout" class="account-menu">${avatar(user.username, 'sm')}
      <span class="handle">@${escape(user.username)}</span><button class="link-button" type="submit" data-loading="Signing out…">Sign out</button></form>` : ''}
  </div></header>
  <main class="wrap">${body}</main>
  <footer class="wrap footer"><span>swoosh.pay</span><span>PayPal Sandbox · USD · Discord</span></footer></body></html>`;
}

function discordCard(discordReady, installed) {
  if (installed) {
    return `<section class="card card-quiet"><h2>Discord app connected</h2>
      <p>Run this in any DM to start a payment to the person you're talking with.</p>${slashCommand}</section>`;
  }
  const appId = process.env.DISCORD_APPLICATION_ID;
  return `<section class="card card-quiet"><h2>Pay from a DM</h2>
    <p>Install swoosh.pay on your Discord account, then run this in a DM with the person you're paying.</p>${slashCommand}
    ${appId ? `<a class="button button-secondary" href="https://discord.com/oauth2/authorize?client_id=${escape(encodeURIComponent(appId))}&amp;integration_type=1&amp;scope=applications.commands">Install Discord app ${arrow}</a>` : ''}
  </section>`;
}

function ledger(rows) {
  return `<ul class="ledger">${rows.map(row => `<li><a class="ledger-row" href="/payments/${escape(row.id)}" data-busy>
    ${avatar(row.name)}<span class="ledger-who"><span class="handle">${escape(row.title)}</span>
    <span class="ledger-meta">${escape(row.meta)}</span></span>${pill(row.status, row.tone)}
    <span class="amount">${dollars(row.cents)}</span></a></li>`).join('')}</ul>`;
}

function landing(discordReady) {
  const example = `<figure class="slip slip-example" aria-label="Example payment slip">
    <div class="slip-head"><div class="slip-top">${pill('Paid', 'good')}<span class="slip-tag">Example</span></div>
      <p class="slip-amount">$60.00<small>USD</small></p>${party('To', 'pixelnova')}</div>
    <div class="slip-section">${progress([
      { label: 'Request created', state: 'done', note: 'From a Discord DM' },
      { label: 'Recipient connected PayPal', state: 'done' },
      { label: 'Approved in PayPal', state: 'done' },
      { label: 'Paid', state: 'done', note: 'Receipt 7XK41982PL3301945' }
    ])}</div></figure>`;
  return `<section class="hero"><div class="hero-copy">
      <h1>Pay anyone by their <span class="handle">@handle</span>.</h1>
      <p>Send a commission payment to the Discord username you already chat with. They connect PayPal once, and you pay through PayPal checkout.</p>
      <div class="hero-actions">${discordReady
        ? `<a class="button button-primary button-lg" href="/auth/discord" data-loading="Opening Discord…">Sign in with Discord ${arrow}</a>`
        : '<div class="notice">Discord sign-in is awaiting configuration.</div>'}</div>
      <p class="fineprint">Sandbox mode. Payments use PayPal test accounts and no real money moves.</p>
    </div>${example}</section>
    <section class="how-section"><h2>How a payment works</h2><ol class="how">
      <li><h3>Send by handle</h3><p>Enter a Discord username and an amount here, or run <code>/pay</code> in a Discord DM.</p></li>
      <li><h3>Recipient connects PayPal</h3><p>New recipients get a private invite. They sign in with that exact Discord account and connect PayPal once.</p></li>
      <li><h3>Approve in PayPal</h3><p>You confirm the account and amount, approve in PayPal, and you both see the receipt.</p></li>
    </ol></section>
    <div class="layout layout-even">${discordCard(discordReady, false)}</div>`;
}

export function home({ user, payments, incoming, saved = [], discordReady, paypalReady, discordInstalled }) {
  if (!user) return { title: 'Pay by Discord handle', body: landing(discordReady) };
  const now = Date.now();
  const sent = payments.map(payment => {
    const expired = !payment.order_id && payment.expires <= now;
    return { id: payment.id, name: payment.handle, title: '@' + payment.handle,
      meta: payment.source_id ? 'Sent from a Discord DM' : 'Sent from the web',
      status: expired ? 'Expired' : labels[payment.status], tone: expired ? 'bad' : tones[payment.status], cents: payment.cents };
  });
  const received = incoming.map(payment => ({ id: payment.id, name: payment.sender_name || '?',
    title: payment.sender_name ? 'From @' + payment.sender_name : 'Incoming payment', meta: 'Paid to your PayPal',
    status: labels[payment.status], tone: tones[payment.status], cents: payment.cents }));

  const receive = `<section class="card"><div class="card-head"><h2>Receiving payments</h2>
      ${user.merchant ? pill('PayPal connected', 'good') : pill('Not connected', 'neutral')}</div>
    <p>${user.merchant ? 'Payments sent to @' + escape(user.username) + ' go to your PayPal Sandbox seller account.'
      : 'Connect a PayPal Sandbox seller account so people can pay @' + escape(user.username) + '.'}</p>
    ${!user.merchant && paypalReady ? connectForm : ''}
    ${!paypalReady ? '<div class="notice">PayPal Platforms Sandbox is awaiting configuration.</div>' : ''}</section>`;

  return { title: 'Send a payment', body: `
    <section class="page-head"><h1>Send a payment</h1>
      <p>Pay anyone on Discord by username. Nothing is charged until you approve it in PayPal.</p></section>
    <div class="layout">
      <section class="card composer" aria-labelledby="send-title"><h2 id="send-title">New payment</h2>
        <form method="post" action="/payments" class="form">
          <div class="field"><label for="handle">Discord username</label>
            <div class="input-affix"><span class="affix">@</span><input id="handle" name="handle" placeholder="pixelnova" maxlength="33"
              autocomplete="off" autocapitalize="none" spellcheck="false" required></div>
            <p class="hint">Use their username, not their display name.</p></div>
          <div class="field"><label for="amount">Amount</label>
            <div class="input-affix amount-input"><span class="affix">$</span><input id="amount" name="amount" placeholder="60.00"
              inputmode="decimal" maxlength="8" autocomplete="off" required><span class="affix affix-end">USD</span></div>
            <p class="hint">Up to $99,999.99, with at most two decimal places.</p></div>
          <button class="button button-primary button-block" type="submit" data-loading="Looking up recipient…">Review payment ${arrow}</button>
        </form></section>
      <div class="side">${receive}${saved.length ? `<section class="card"><div class="card-head"><h2>One-tap payments</h2>${pill('Saved PayPal', 'accent')}</div>
        <p>Your PayPal is saved for these artists. In Discord, /pay to them asks you to tap Confirm and then charges it, with no PayPal page, up to $500 per payment.</p>
        <ul class="saved-list">${saved.map(wallet => `<li>${avatar(wallet.username || '?', 'sm')}<span class="handle">@${escape(wallet.username || 'unknown artist')}</span>
          <form method="post" action="/saved/remove"><input type="hidden" name="merchant" value="${escape(wallet.merchant)}">
          <button class="link-button" type="submit" data-loading="Removing…">Remove</button></form></li>`).join('')}</ul></section>` : ''}${discordCard(discordReady, discordInstalled)}</div>
    </div>
    ${sent.length ? `<section class="activity"><div class="section-head"><h2>Sent payments</h2><span>Latest ${sent.length}</span></div>${ledger(sent)}</section>` : ''}
    ${received.length ? `<section class="activity"><div class="section-head"><h2>Incoming payments</h2><span>Latest ${received.length}</span></div>${ledger(received)}</section>` : ''}
    ${!sent.length && !received.length ? '<div class="empty">Payments you send and receive will appear here with their PayPal status.</div>' : ''}` };
}

export function review(payment, recipient, order, origin, paypalReady, merchantFingerprint, { incoming, sender, pendingReason }) {
  const path = '/payments/' + payment.id;
  const expired = Date.now() >= payment.expires && !payment.order_id;
  const ready = Boolean(recipient?.merchant);
  const status = expired ? 'Request expired' : payment.status === 'draft'
    ? (ready ? 'Ready to pay' : 'Waiting for recipient setup') : labels[payment.status];
  const tone = expired ? 'bad' : payment.status === 'draft' ? (ready ? 'accent' : 'neutral') : tones[payment.status];
  const inviteUrl = origin + '/invite/' + payment.invite;
  const handle = recipient?.username || payment.handle;
  const approved = order?.status === 'APPROVED' || order?.status === 'COMPLETED' || settled.includes(payment.status);

  const final = { paid: ['Paid', 'done'], processing: ['Processing in PayPal', 'current'], failed: ['Payment failed', 'failed'],
    refunded: ['Refunded', 'done'], partially_refunded: ['Partially refunded', 'done'] }[payment.status] || ['Paid', 'todo'];
  const steps = progress([
    { label: 'Request created', state: 'done', note: payment.source_id ? 'From a Discord DM' : 'From the web' },
    { label: 'Recipient connected PayPal', state: ready || payment.order_id ? 'done' : expired ? 'failed' : 'current',
      note: expired ? 'The invite expired on ' + shortDate(payment.expires) : !ready && !payment.order_id ? 'Invite open until ' + shortDate(payment.expires) : '' },
    { label: 'Approved in PayPal', state: approved ? 'done' : ready && !expired ? 'current' : 'todo' },
    { label: final[0], state: final[1], note: payment.capture_id && payment.status === 'paid' ? 'Funds sent to @' + handle : '' }
  ]);

  let action = '';
  if (order?.status === 'APPROVED' && payment.status === 'awaiting_approval') {
    action = `<p>You approved this in PayPal. Finish the payment to send the funds.</p>
      <form method="post" action="${path}/capture"><button class="button button-primary button-block" data-loading="Completing payment…">Complete payment ${arrow}</button></form>`;
  } else if (!expired && ready && ['draft', 'awaiting_approval'].includes(payment.status) && paypalReady) {
    action = `<p>Check the recipient and amount. PayPal opens next so you can approve the payment.</p>
      <form method="post" action="${path}/checkout">
      <input type="hidden" name="recipient" value="${escape(recipient.id)}"><input type="hidden" name="handle" value="${escape(recipient.username)}">
      <input type="hidden" name="seller" value="${escape(merchantFingerprint)}">
      <button class="button button-primary button-block" data-loading="Opening PayPal…">Continue to PayPal ${arrow}</button></form>`;
  } else if (!expired && !ready && !payment.order_id) {
    action = `<div class="stack"><h2 class="slip-title">Invite @${escape(handle)} to get paid</h2>
      <p>Share this link in your Discord DM. It works only for ${payment.source_id ? 'the Discord account you picked' : 'the Discord account named @' + escape(handle)}
      and stays open until ${shortDate(payment.expires)}. You can pay once they connect PayPal.</p>
      <div class="invite"><code class="invite-url">${escape(inviteUrl)}</code>
      <button type="button" class="button button-secondary" id="copy-invite" data-invite-url="${escape(inviteUrl)}">Copy invite link</button></div>
      <span id="copy-invite-status" role="status"></span>
      <script src="/copy-invite.js" defer></script></div>`;
  }

  const messages = [];
  if (payment.status === 'processing') messages.push(['warn', pendingReason === 'PENDING_REVIEW'
    ? 'PayPal is reviewing this payment. This page updates when PayPal finishes.' : 'PayPal is still processing this payment.']);
  if (payment.status === 'failed') messages.push(['bad', 'PayPal declined this payment. No funds were sent.']);
  if (!paypalReady && ready && payment.status === 'draft') messages.push(['warn', 'PayPal Platforms Sandbox is awaiting configuration.']);

  const facts = [
    [incoming ? 'From' : 'To', '<span class="handle">@' + escape(incoming ? sender?.username || 'unknown' : handle) + '</span>'],
    ...(payment.memo ? [['For', escape(payment.memo)]] : []),
    ['Amount', dollars(payment.cents) + ' USD'],
    ['Charged', payment.order_id ? (payment.capture_id ? 'Yes' : 'Not yet') : 'No money charged']
  ];
  if (payment.capture_id && payment.status === 'paid') facts.push(['PayPal receipt', '<code>' + escape(payment.capture_id) + '</code>']);

  return { title: status, body: `<div class="detail"><a class="back" href="/">← All payments</a>
    <article class="slip">
      <div class="slip-head"><div class="slip-top">${pill(status, tone)}</div>
        <h1 class="slip-amount">${dollars(payment.cents)}<small>USD</small></h1>
        ${incoming ? party('From', sender?.username || 'unknown') : party('To', handle)}</div>
      <div class="slip-section">${steps}</div>
      ${messages.length ? `<div class="slip-section">${messages.map(([kind, text]) => `<div class="message message-${kind}">${text}</div>`).join('')}</div>` : ''}
      ${!incoming && action ? `<div class="slip-section">${action}</div>` : ''}
      <div class="slip-section"><dl class="facts">${facts.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join('')}</dl></div>
      <div class="slip-foot"><span>PayPal Sandbox</span><a href="${path}" data-loading="Checking PayPal…">Refresh status</a></div>
    </article></div>` };
}

export function claim(payment, user, paypalReady, sender) {
  const claimed = payment.recipient === user.id;
  const connected = Boolean(user.merchant);
  const from = sender?.username;
  let action;
  if (!claimed) {
    action = `<p>Accept with your signed-in Discord account, <span class="handle">@${escape(user.username)}</span>. You'll connect PayPal next.</p>
      <form method="post"><button class="button button-primary button-block" data-loading="Accepting invite…">Accept invite ${arrow}</button></form>`;
  } else if (connected) {
    action = `<div class="message message-good">Your PayPal seller account is connected. ${from ? '@' + escape(from) : 'The sender'} can now approve the payment.</div>`;
  } else if (paypalReady) {
    action = `<p>Connect PayPal so ${from ? '@' + escape(from) : 'the sender'} can complete the payment. You only do this once.</p>${connectForm}`;
  } else {
    action = '<div class="notice">PayPal Platforms Sandbox is awaiting configuration.</div>';
  }
  return { title: 'Payment invitation', body: `<div class="detail"><article class="slip">
    <div class="slip-head"><div class="slip-top">${pill('Payment invitation', 'accent')}</div>
      <h1 class="slip-amount">${dollars(payment.cents)}<small>USD</small></h1>
      ${from ? party('From', from) : ''}
      <p class="slip-lede">${from ? '@' + escape(from) + ' wants' : 'Someone wants'} to pay <span class="handle">@${escape(user.username)}</span> on Discord.</p></div>
    <div class="slip-section">${progress([
      { label: 'Accept the invite', state: claimed ? 'done' : 'current' },
      { label: 'Connect PayPal', state: connected ? 'done' : claimed ? 'current' : 'todo' },
      { label: 'Get paid', state: 'todo', note: 'Funds go straight to your PayPal account' }
    ])}</div>
    <div class="slip-section">${action}</div>
    <div class="slip-foot"><span>Invite open until ${shortDate(payment.expires)}</span><span>PayPal Sandbox</span></div>
  </article></div>` };
}

export function result(payment) {
  const retry = payment.source_id ? '/checkout/' + payment.id : '/payments/' + payment.id;
  const outcome = {
    paid: ['Payment sent', 'good', 'Payment sent. You can close this tab and go back to Discord.'],
    processing: ['Processing', 'warn', 'PayPal is reviewing this payment. No action is needed from you.'],
    failed: ['Payment failed', 'bad', 'PayPal declined this payment. No money was sent.'],
    refunded: ['Refunded', 'neutral', 'This payment was refunded.'],
    partially_refunded: ['Partially refunded', 'neutral', 'Part of this payment was refunded.']
  }[payment.status] || ['Not completed', 'neutral', 'Payment not completed. No money was charged.'];
  const retryable = ['draft', 'awaiting_approval'].includes(payment.status);
  return { title: outcome[0], body: `<div class="detail"><article class="slip">
    <div class="slip-head"><div class="slip-top">${pill(outcome[0], outcome[1])}</div>
      <h1 class="slip-amount">${dollars(payment.cents)}<small>USD</small></h1>${party('To', payment.handle)}</div>
    <div class="slip-section"><div class="message message-${outcome[1]}">${outcome[2]}</div>
      ${retryable ? `<a class="button button-primary button-block" href="${retry}" data-loading="Opening PayPal…">Try again in PayPal ${arrow}</a>` : ''}</div>
    ${payment.capture_id && payment.status === 'paid' ? `<div class="slip-section"><dl class="facts"><dt>PayPal receipt</dt>
      <dd><code>${escape(payment.capture_id)}</code></dd></dl></div>` : ''}
    <div class="slip-foot"><span>PayPal Sandbox</span><a href="/payments/${escape(payment.id)}">View payment details</a></div>
  </article></div>` };
}

const riskLabels = { low: ['No warning signs found', 'good'], medium: ['Review carefully', 'warn'], high: ['High risk', 'bad'] };
const levelLabels = { high: 'Warning', medium: 'Caution', info: 'Note', ok: 'Checked' };
const paymentTypes = { full: 'Full payment', deposit: 'Deposit (part of the price)', balance: 'Remaining balance', unclear: 'Not stated' };

export function commissionReview({ commission, review, reason, signals, risk, connected, paypalReady }) {
  const [riskText, riskTone] = riskLabels[risk];
  const handle = escape(commission.handle);
  const path = '/commission/' + commission.id;
  const terms = review ? [
    ['What', review.deliverables.length ? '<ul class="plain">' + review.deliverables.map(item => '<li>' + escape(item) + '</li>').join('') + '</ul>' : escape(review.summary || 'Not stated')],
    ['Price', review.cents ? dollars(review.cents) + ' USD' : '<span class="muted">No USD price found</span>'],
    ['Payment', escape(paymentTypes[review.paymentType])],
    ['Deadline', review.deadline ? escape(review.deadline) : '<span class="muted">Not stated</span>'],
    ['Revisions', review.revisions ? escape(review.revisions) : '<span class="muted">Not stated</span>']
  ] : [];
  const unavailable = reason === 'not_configured' ? 'AI review is not configured on this server, so only swoosh.pay\'s own checks ran.'
    : 'Claude could not review this quote right now, so only swoosh.pay\'s own checks ran. Read the quote carefully.';
  let action;
  if (commission.payment_id) {
    action = `<p>You already started this payment.</p><a class="button button-primary button-block" href="/checkout/${escape(commission.payment_id)}" data-loading="Opening PayPal…">Continue to PayPal ${arrow}</a>`;
  } else if (!paypalReady) {
    action = '<div class="notice">PayPal Platforms Sandbox is awaiting configuration.</div>';
  } else {
    const amount = review?.cents ? (review.cents / 100).toFixed(2) : '';
    action = `<form method="post" action="${path}/pay" class="form">
      <div class="field"><label for="amount">Amount to pay now</label>
        <div class="input-affix amount-input"><span class="affix">$</span><input id="amount" name="amount" value="${amount}" placeholder="60.00"
          inputmode="decimal" maxlength="8" autocomplete="off" required><span class="affix affix-end">USD</span></div>
        <p class="hint">${review?.cents ? 'Taken from the quote. Change it if you agreed on something else.' : 'Enter the price you agreed on.'}</p></div>
      <div class="field"><label for="memo">What you're paying for</label>
        <input class="text-input" id="memo" name="memo" maxlength="120" value="${escape(review?.summary || '')}" placeholder="Full-body character sheet, 2 poses">
        <p class="hint">Saved on the PayPal order, so the receipt records what you bought if you ever need to open a dispute.</p></div>
      ${risk === 'high' ? '<div class="message message-bad">Read the warnings above before you continue. PayPal buyer protection only helps if you pay through this checkout.</div>' : ''}
      <button class="button button-primary button-block" type="submit" data-loading="Creating payment…">${connected
        ? (risk === 'high' ? 'Continue to PayPal anyway' : 'Continue to PayPal') + ' ' + arrow
        : 'Create payment and invite @' + handle + ' ' + arrow}</button>
    </form>`;
  }
  return { title: 'Commission review', body: `<div class="detail"><article class="slip">
    <div class="slip-head"><div class="slip-top">${pill(riskText, riskTone)}<span class="slip-tag">Commission review</span></div>
      ${party('Quote from', commission.handle)}
      <blockquote class="quote">${escape(commission.quote)}</blockquote></div>
    <div class="slip-section"><div class="section-title"><h2 class="slip-title">Safety check</h2><span class="byline">Claude + swoosh.pay</span></div>
      ${review?.advice ? `<p class="advice">${escape(review.advice)}</p>` : ''}
      ${!review ? `<div class="message message-warn">${unavailable}</div>` : ''}
      <ul class="signals">${signals.map(signal => `<li class="signal signal-${signal.level}">
        <span class="signal-dot" aria-hidden="true"></span><div class="signal-body">
        <strong>${escape(signal.title)}</strong><span class="sr-only"> (${levelLabels[signal.level]})</span>
        ${signal.detail ? `<p>${escape(signal.detail)}</p>` : ''}
        ${signal.evidence ? `<q>${escape(signal.evidence)}</q>` : ''}</div></li>`).join('')}</ul></div>
    ${review ? `<div class="slip-section"><h2 class="slip-title">Terms in the quote</h2>
      <dl class="facts facts-left">${terms.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join('')}</dl>
      ${review.missing.length ? `<div class="missing"><span>Not mentioned:</span>${review.missing.map(item => `<span class="chip">${escape(item)}</span>`).join('')}</div>
        <p class="hint">Agree on these in the DM before paying, so there's a record if something goes wrong.</p>` : ''}</div>` : ''}
    <div class="slip-section">${action}</div>
    <div class="slip-foot"><span>To @${handle} · PayPal Sandbox</span><span>Nothing is charged until you approve in PayPal</span></div>
  </article></div>` };
}

export function working({ title, detail, next }) {
  return { title, refresh: next, body: `<div class="detail"><section class="card working" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span><h1 class="card-title">${escape(title)}</h1><p>${escape(detail)}</p>
    <p class="working-fallback">Taking longer than usual? <a href="${escape(next)}">Continue</a></p></section></div>` };
}

export function failure(message) {
  return { title: 'Action unavailable', body: `<div class="detail"><section class="card">
    <div class="card-head">${pill('Action unavailable', 'bad')}</div>
    <h1 class="card-title">${escape(message)}</h1>
    <a class="button button-secondary" href="/">Back to payments</a></section></div>` };
}

// Gives instant feedback on actions that wait on Discord or PayPal, and blocks double submits.
export const appScript = `
const idle = new WeakMap();
function busy(element) {
  if (element.classList.contains('is-loading')) return;
  idle.set(element, element.innerHTML);
  element.style.minWidth = element.offsetWidth + 'px';
  element.textContent = element.dataset.loading;
  element.classList.add('is-loading');
  element.setAttribute('aria-busy', 'true');
}
const root = document.documentElement;
document.addEventListener('submit', event => {
  const form = event.target;
  if (form.dataset.submitting) return event.preventDefault();
  root.classList.add('navigating');
  const button = event.submitter && event.submitter.dataset.loading ? event.submitter : form.querySelector('[data-loading]');
  if (!button) return;
  form.dataset.submitting = 'true';
  busy(button);
});
document.addEventListener('click', event => {
  const link = event.target.closest && event.target.closest('a[href]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (link.target && link.target !== '_self') return;
  const destination = new URL(link.href, location.href);
  if (destination.origin === location.origin && destination.pathname === location.pathname && destination.hash) return;
  if (link.classList.contains('is-loading') || link.classList.contains('is-busy')) return event.preventDefault();
  root.classList.add('navigating');
  if (link.dataset.loading) busy(link);
  else if (link.hasAttribute('data-busy')) {
    link.classList.add('is-busy');
    link.setAttribute('aria-busy', 'true');
  }
});
// Coming back with the browser's Back button restores the page from cache; reset any busy controls.
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  root.classList.remove('navigating');
  for (const element of document.querySelectorAll('.is-busy')) {
    element.classList.remove('is-busy');
    element.removeAttribute('aria-busy');
  }
  for (const element of document.querySelectorAll('.is-loading')) {
    element.innerHTML = idle.get(element) || element.innerHTML;
    element.classList.remove('is-loading');
    element.removeAttribute('aria-busy');
    element.style.minWidth = '';
  }
  for (const form of document.querySelectorAll('form[data-submitting]')) delete form.dataset.submitting;
});
`;

export const inviteScript = `
const button = document.getElementById('copy-invite');
const status = document.getElementById('copy-invite-status');

button.addEventListener('click', async () => {
  status.textContent = '';
  try {
    await navigator.clipboard.writeText(button.dataset.inviteUrl);
    status.textContent = 'Invite link copied.';
  } catch {
    status.textContent = 'Could not copy the invite link. Check clipboard permissions and try again.';
  }
});
`;

export const stylesheet = `
/* Layout: one calm column of payment "slips". The slip is the object; header, cards and lists stay quiet around it. */
:root{
  --paper:#f3f4f7;--surface:#ffffff;--sunken:#eceef3;--ink:#11131b;--muted:#596074;--line:#dfe2ea;--line-strong:#c4c9d6;
  --accent:#3341f0;--accent-hover:#2532d4;--accent-ink:#ffffff;--accent-soft:#e7e9ff;--accent-text:#2a36d1;
  --good:#12704a;--good-soft:#e0f3e9;--warn:#7f5300;--warn-soft:#fbefd6;--bad:#b42318;--bad-soft:#fde7e4;
  --font-ui:"Inter","Segoe UI Variable Text","Segoe UI",ui-sans-serif,system-ui,-apple-system,Roboto,sans-serif;
  --font-display:"Inter Display","Segoe UI Variable Display","Segoe UI",ui-sans-serif,system-ui,-apple-system,sans-serif;
  --font-mono:ui-monospace,"Cascadia Mono","SF Mono",Menlo,Consolas,monospace;
  --radius:16px;--radius-sm:10px;--shadow:0 1px 2px rgb(17 19 27 / .04),0 12px 32px -16px rgb(17 19 27 / .18);
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root{
  --paper:#0d0f15;--surface:#161922;--sunken:#1d212c;--ink:#eceef4;--muted:#9aa1b4;--line:#272b37;--line-strong:#383d4d;
  --accent:#7380ff;--accent-hover:#8c97ff;--accent-ink:#0d0f15;--accent-soft:#20264d;--accent-text:#a6adff;
  --good:#62d29b;--good-soft:#13291e;--warn:#efb44f;--warn-soft:#2c2212;--bad:#ff8b80;--bad-soft:#311614;
  --shadow:0 1px 0 rgb(255 255 255 / .03) inset;color-scheme:dark;
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--paper);color:var(--ink);font:400 16px/1.55 var(--font-ui)}
h1,h2,h3,p{margin:0}
h1,h2,h3{text-wrap:balance;letter-spacing:-.02em;line-height:1.15}
a{color:var(--accent-text);text-underline-offset:3px}
code{font-family:var(--font-mono);font-size:.9em}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:6px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.wrap{width:100%;max-width:1040px;margin-inline:auto;padding-left:max(20px,env(safe-area-inset-left,0px));padding-right:max(20px,env(safe-area-inset-right,0px))}
.handle{font-family:var(--font-mono);font-size:.94em;letter-spacing:-.01em}

.topbar{background:var(--surface);border-bottom:1px solid var(--line)}
.topbar-inner{display:flex;align-items:center;gap:12px;min-height:64px}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;font-weight:700;font-size:1.06rem;letter-spacing:-.025em}
.mark{width:30px;height:30px;color:var(--accent);flex:none}
.brand-dot{color:var(--accent-text)}
.env{font:700 .68rem/1 var(--font-ui);text-transform:uppercase;letter-spacing:.09em;color:var(--warn);background:var(--warn-soft);padding:5px 8px;border-radius:999px}
.account-menu{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:.9rem;min-width:0}
.account-menu .handle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.link-button{background:none;border:0;padding:4px 2px;font:inherit;color:var(--muted);cursor:pointer;text-decoration:underline;text-underline-offset:3px;white-space:nowrap}
.link-button:hover{color:var(--ink)}

main{flex:1;display:grid;grid-template-columns:minmax(0,1fr);gap:32px;align-content:start;padding-block:40px 72px}
.footer{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px 16px;padding-block:20px 28px;border-top:1px solid var(--line);color:var(--muted);font-size:.82rem}

.page-head{display:grid;gap:8px;max-width:60ch}
.page-head h1{font:700 clamp(1.9rem,4vw,2.6rem)/1.1 var(--font-display);letter-spacing:-.035em}
.page-head p{color:var(--muted);font-size:1.05rem}
.layout{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:20px;align-items:start}
.layout-even{grid-template-columns:minmax(0,1fr)}
.side{display:grid;gap:20px}

.card{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;align-content:start;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:24px;box-shadow:var(--shadow)}
.card-quiet{background:transparent;border-style:dashed;box-shadow:none}
.card h2{font-size:1.06rem}
.card p{color:var(--muted)}
.card-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 12px}
.card-title{font-size:1.3rem;line-height:1.3}
.composer{padding:28px;gap:20px}

.form,.field,.stack,.detail,.slip-head,.slip-section{grid-template-columns:minmax(0,1fr)}
.form{display:grid;gap:20px}
.form-tight{gap:14px}
.field{display:grid;gap:7px}
label{font-weight:600;font-size:.9rem}
.hint{font-size:.82rem;color:var(--muted)}
.input-affix{display:flex;align-items:center;background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--radius-sm);transition:border-color .15s,box-shadow .15s}
.input-affix:hover{border-color:var(--muted)}
.input-affix:focus-within{border-color:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
.affix{padding-left:14px;color:var(--muted);font-family:var(--font-mono)}
.affix-end{padding:0 14px 0 0;font-size:.78rem;letter-spacing:.08em}
.input-affix input{flex:1;width:100%;min-width:0;border:0;background:transparent;color:var(--ink);padding:13px 14px 13px 6px;font:inherit;outline:none}
.input-affix input::placeholder{color:var(--muted);opacity:.6}
#handle{font-family:var(--font-mono)}
.amount-input input{font-size:1.3rem;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.consent{display:flex;gap:10px;align-items:flex-start;font-weight:500;font-size:.88rem;color:var(--muted)}
.consent input{flex:none;width:17px;height:17px;margin:2px 0 0;accent-color:var(--accent)}

.button{display:inline-flex;align-items:center;justify-content:center;gap:10px;width:fit-content;min-height:46px;padding:0 18px;border:1px solid transparent;border-radius:var(--radius-sm);font:600 .95rem/1 var(--font-ui);text-decoration:none;cursor:pointer;transition:background-color .15s,border-color .15s}
.button-primary{background:var(--accent);color:var(--accent-ink)}
.button-primary:hover{background:var(--accent-hover)}
.button-secondary{background:var(--surface);color:var(--ink);border-color:var(--line-strong)}
.button-secondary:hover{background:var(--sunken);border-color:var(--muted)}
.button-block{width:100%}
.button-lg{min-height:52px;padding:0 22px;font-size:1rem}
.arrow{transition:transform .15s}
.button:hover .arrow{transform:translateX(3px)}

.pill{display:inline-flex;align-items:center;gap:7px;width:fit-content;padding:4px 10px;border-radius:999px;font:600 .76rem/1.25 var(--font-ui);white-space:nowrap}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill-neutral{background:var(--sunken);color:var(--muted)}
.pill-accent{background:var(--accent-soft);color:var(--accent-text)}
.pill-warn{background:var(--warn-soft);color:var(--warn)}
.pill-good{background:var(--good-soft);color:var(--good)}
.pill-bad{background:var(--bad-soft);color:var(--bad)}

.avatar{display:inline-grid;place-items:center;flex:none;width:36px;height:36px;border-radius:50%;color:#fff;font:700 .9rem/1 var(--font-ui)}
.avatar-sm{width:26px;height:26px;font-size:.72rem}
.avatar-lg{width:44px;height:44px;font-size:1.05rem}
.av-0{background:#3f4ce0}.av-1{background:#0f7a6b}.av-2{background:#b0437f}.av-3{background:#b85a16}.av-4{background:#566074}

.slash{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:10px 12px;background:var(--sunken);border:1px solid var(--line);border-radius:var(--radius-sm);font:.84rem/1.4 var(--font-mono)}
.slash-cmd{font-weight:700;color:var(--accent-text);margin-right:2px}
.slash-opt{display:inline-flex;border:1px solid var(--line-strong);border-radius:6px;overflow:hidden}
.slash-opt span{padding:2px 7px;background:var(--line);color:var(--muted)}
.slash-opt b{padding:2px 7px;background:var(--surface);font-weight:500}

.notice,.message{padding:11px 14px;border-radius:var(--radius-sm);font-size:.9rem}
.notice,.message-warn{background:var(--warn-soft);color:var(--warn)}
.message-bad{background:var(--bad-soft);color:var(--bad)}
.message-good{background:var(--good-soft);color:var(--good)}
.message-neutral{background:var(--sunken);color:var(--muted)}

.activity{display:grid;gap:12px}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.section-head h2{font-size:1.06rem}
.section-head span{color:var(--muted);font-size:.84rem}
.saved-list{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.saved-list li{display:flex;align-items:center;gap:10px;min-width:0}
.saved-list .handle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ledger{list-style:none;margin:0;padding:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.ledger li+li{border-top:1px solid var(--line)}
.ledger-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:14px;padding:14px 20px;color:inherit;text-decoration:none;transition:background-color .12s}
.ledger-row:hover{background:var(--sunken)}
.ledger-who{display:grid;min-width:0}
.ledger-who .handle{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ledger-meta{color:var(--muted);font-size:.8rem}
.amount{min-width:8ch;text-align:right;font-weight:650;font-variant-numeric:tabular-nums}
.empty{padding:32px 24px;border:1px dashed var(--line-strong);border-radius:var(--radius);color:var(--muted);text-align:center}

.detail{display:grid;gap:14px;width:100%;max-width:620px;margin-inline:auto}
.back{justify-self:start;color:var(--muted);text-decoration:none;font-size:.9rem}
.back:hover{color:var(--ink)}
.slip{background:var(--surface);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);overflow:hidden;margin:0}
.slip-head{display:grid;gap:16px;padding:28px 28px 26px}
.slip-top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.slip-tag{font:600 .7rem/1 var(--font-mono);text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.slip-amount{font:750 clamp(2.6rem,10vw,3.9rem)/1 var(--font-display);letter-spacing:-.05em;font-variant-numeric:tabular-nums}
.slip-amount small{margin-left:8px;font:600 .82rem/1 var(--font-mono);letter-spacing:.08em;color:var(--muted);vertical-align:1.6em}
.slip-lede{color:var(--muted)}
.slip-title{font-size:1.06rem}
.slip-section{display:grid;gap:14px;padding:22px 28px;border-top:1px dashed var(--line-strong)}
.slip-section > p,.stack > p{color:var(--muted);font-size:.94rem}
.slip-foot{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px 16px;padding:14px 28px;background:var(--sunken);color:var(--muted);font-size:.84rem}
.party{display:flex;align-items:center;gap:12px;min-width:0}
.party-text{display:grid;min-width:0}
.party-label{font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}
.party .handle{font-size:1.08rem;font-weight:600;overflow-wrap:anywhere}
.stack{display:grid;gap:12px}

.progress{list-style:none;margin:0;padding:0;display:grid}
.step{position:relative;display:grid;grid-template-columns:22px minmax(0,1fr);column-gap:14px;padding-bottom:18px}
.step:last-child{padding-bottom:0}
.step::before{content:"";position:absolute;left:10px;top:24px;bottom:2px;width:2px;border-radius:2px;background:var(--line)}
.step:last-child::before{display:none}
.step-done::before{background:var(--accent)}
.step-dot{grid-row:1 / span 2;display:grid;place-items:center;width:22px;height:22px;border:2px solid var(--line-strong);border-radius:50%;background:var(--surface)}
.step-done .step-dot{background:var(--accent);border-color:var(--accent)}
.step-done .step-dot::after{content:"";width:8px;height:4px;margin-top:-2px;border:2px solid var(--accent-ink);border-top:0;border-right:0;transform:rotate(-45deg)}
.step-current .step-dot{border-color:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
.step-current .step-dot::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--accent)}
.step-failed .step-dot{background:var(--bad);border-color:var(--bad)}
.step-failed .step-dot::after{content:"";width:8px;height:2px;background:var(--surface)}
.step-label{font-weight:600;font-size:.95rem;line-height:22px}
.step-todo .step-label{color:var(--muted);font-weight:500}
.step-note{grid-column:2;color:var(--muted);font-size:.82rem}

.facts{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px 24px;margin:0;font-size:.9rem}
.facts dt{color:var(--muted)}
.facts dd{margin:0;text-align:right;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}

.invite{display:flex;flex-wrap:wrap;align-items:stretch;gap:8px}
.invite-url{flex:1 1 240px;min-width:0;padding:12px 14px;background:var(--sunken);border:1px solid var(--line);border-radius:var(--radius-sm);font-size:.82rem;line-height:1.45;overflow-wrap:anywhere;color:var(--ink)}
.invite .button{min-height:auto;padding-block:12px}
#copy-invite-status{min-height:1.3em;color:var(--muted);font-size:.85rem}

.quote{margin:0;padding:14px 16px;background:var(--sunken);border-left:3px solid var(--accent);border-radius:0 var(--radius-sm) var(--radius-sm) 0;color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere;font-size:.95rem;max-height:16rem;overflow:auto}
.section-title{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.byline{font:600 .7rem/1 var(--font-mono);text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.slip-section > .advice{color:var(--ink);font-size:1rem}
.signals{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.signal{display:grid;grid-template-columns:12px minmax(0,1fr);gap:12px;align-items:start}
.signal-dot{width:10px;height:10px;margin-top:7px;border-radius:50%;background:var(--muted)}
.signal-high .signal-dot{background:var(--bad);box-shadow:0 0 0 4px var(--bad-soft)}
.signal-medium .signal-dot{background:var(--warn);box-shadow:0 0 0 4px var(--warn-soft)}
.signal-ok .signal-dot{background:var(--good)}
.signal-info .signal-dot{background:var(--accent)}
.signal-body{display:grid;gap:3px}
.signal-body strong{font-size:.95rem}
.signal-high strong{color:var(--bad)}
.signal-body p{color:var(--muted);font-size:.88rem}
.signal-body q{font-size:.85rem;color:var(--ink);font-style:italic}
.facts-left dd{text-align:left}
.plain{margin:0;padding-left:1.1em}
.muted{color:var(--muted)}
.missing{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:.85rem;color:var(--muted)}
.chip{padding:3px 9px;border-radius:999px;background:var(--warn-soft);color:var(--warn);font-weight:600;font-size:.78rem}
.text-input{width:100%;padding:13px 14px;border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--surface);color:var(--ink);font:inherit}
.text-input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
.hero{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:56px;align-items:center;padding-block:16px 8px}
.hero-copy{display:grid;gap:20px;max-width:34rem}
.hero h1{font:750 clamp(2.5rem,6.2vw,4.2rem)/1.02 var(--font-display);letter-spacing:-.05em}
.hero h1 .handle{color:var(--accent-text);font-weight:650;letter-spacing:-.06em}
.hero-copy p{color:var(--muted);font-size:1.1rem;max-width:46ch}
.hero-copy .fineprint{font-size:.85rem}
.slip-example{transform:rotate(1.5deg)}
.how-section{display:grid;gap:20px;padding-top:16px}
.how-section h2{font-size:1.3rem}
.how{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;counter-reset:how}
.how li{counter-increment:how;display:grid;gap:8px;align-content:start;padding-top:16px;border-top:2px solid var(--ink)}
.how li::before{content:"0" counter(how);font:600 .8rem/1 var(--font-mono);color:var(--accent-text)}
.how h3{font-size:1.05rem}
.how p{color:var(--muted);font-size:.93rem}

.is-loading{cursor:progress;pointer-events:none}
.button.is-loading{opacity:.88}
.is-loading::before,.spinner{content:"";display:inline-block;flex:none;width:1em;height:1em;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
a.is-loading:not(.button)::before,.link-button.is-loading::before{margin-right:.45em;vertical-align:-.15em}
.spinner{width:30px;height:30px;border-width:3px;color:var(--accent)}
.working{justify-items:center;text-align:center;padding-block:44px}
.card .working-fallback{font-size:.85rem}
@keyframes spin{to{transform:rotate(360deg)}}
.ledger-row.is-busy{background:var(--sunken);cursor:progress}
.ledger-row.is-busy .avatar{position:relative;color:transparent;background:var(--accent-soft)}
.ledger-row.is-busy .avatar::after{content:"";position:absolute;inset:8px;border:2px solid var(--accent);border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
.navigating body::after{content:"";position:fixed;z-index:20;top:env(safe-area-inset-top,0px);left:0;height:3px;width:100%;background:var(--accent);transform-origin:left;animation:progress 10s cubic-bezier(.1,.7,.3,1) forwards}
@keyframes progress{from{transform:scaleX(0)}to{transform:scaleX(.92)}}
@media (prefers-reduced-motion:reduce){.is-loading::before,.spinner,.ledger-row.is-busy .avatar::after{animation-duration:1.8s}.navigating body::after{animation:none;transform:scaleX(.6);opacity:.7}}
@media (prefers-reduced-motion:no-preference){
  .step-current .step-dot{animation:pulse 2.4s ease-in-out infinite}
  @keyframes pulse{50%{box-shadow:0 0 0 7px var(--accent-soft)}}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
@media (max-width:820px){
  .layout,.hero{grid-template-columns:minmax(0,1fr)}
  .hero{gap:36px}
  .slip-example{transform:none}
  .how{grid-template-columns:minmax(0,1fr);gap:20px}
}
@media (max-width:540px){
  main{padding-block:28px 56px}
  .card,.composer{padding:20px}
  .slip-head{padding:22px 20px 20px}
  .slip-section{padding:18px 20px}
  .slip-foot{padding:12px 20px}
  .ledger-row{grid-template-columns:auto minmax(0,1fr) auto;row-gap:6px;padding:14px 16px}
  .ledger-row .avatar{grid-row:1 / span 2}
  .ledger-row .pill{grid-column:2;grid-row:2;justify-self:start}
  .ledger-row .amount{grid-column:3;grid-row:1 / span 2}
  .env{display:none}
}
`;
