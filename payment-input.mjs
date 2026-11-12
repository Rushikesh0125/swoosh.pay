export function parseAmount(input) {
  const amount = String(input).trim();
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(amount)) return null;
  const [dollars, cents = ''] = amount.split('.');
  return Number(dollars) * 100 + Number(cents.padEnd(2, '0')) || null;
}

export function parseHandle(input) {
  const handle = String(input).trim().toLowerCase().replace(/^@/, '');
  return /^(?!.*\.\.)[a-z0-9_.]{2,32}$/.test(handle) ? handle : null;
}

export function canClaim(payment, user, now = Date.now()) {
  return payment.expires > now && !payment.order_id && payment.sender !== user.id &&
    (payment.recipient ? payment.recipient === user.id : payment.handle === user.username);
}
