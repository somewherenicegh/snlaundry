// Tests for the second iteration: payment-at-placement, take-payment, paid-before-pickup,
// reverse moves, shift open/close reconciliation, and shift/staff reporting.

import { rmSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'laundry-feat-'));
process.env.FORCE_FILE_STORE = '1';
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET = 'feat-secret';
delete process.env.RESEND_API_KEY;

const { handleRequest } = await import('../netlify/functions/api.js');

let pass = 0, fail = 0; const out = [];
const ok = (n, c, x = '') => { if (c) { pass++; out.push(`  ✅ ${n}`); } else { fail++; out.push(`  ❌ ${n} ${x}`); } };
const section = (t) => out.push(`\n▶ ${t}`);
const api = (method, p, opts = {}) => handleRequest({ method, path: p, query: opts.query || {}, body: opts.body || {}, headers: opts.headers || {} });
const H = (t) => ({ authorization: `Bearer ${t}` });

try {
  await api('POST', '/api/setup', { body: { hostelName: 'somewhere nice', adminName: 'Ama', adminPin: '1234' } });
  const auth = await api('POST', '/api/auth/pin', { body: { pin: '1234' } });
  const adminT = auth.body.token;
  await api('PUT', '/api/settings', { headers: H(adminT), body: { currency: { code: 'GHS', symbol: '₵' }, pricePerLoad: 10, piecesPerLoad: 25 } });

  section('Payment chosen at order placement');
  let r = await api('POST', '/api/orders', { body: { guestName: 'Kojo B', guestEmail: 'kojo@example.com', items: 10, paymentTiming: 'now', paymentMethod: 'card' } });
  const A = r.body.id;
  r = await api('GET', `/api/orders/public/${r.body.publicId}`);
  ok('guest order stores pay-now + card', r.body.paymentTiming === 'now' && r.body.paymentMethod === 'card' && r.body.paymentStatus === 'unpaid', JSON.stringify(r.body));

  let r2 = await api('POST', '/api/orders', { body: { guestName: 'Efua P', guestEmail: 'efua@example.com', items: 30 } });
  const B = r2.body.id;
  r2 = await api('GET', `/api/orders/public/${r2.body.publicId}`);
  ok('default timing is pay-at-pickup', r2.body.paymentTiming === 'pickup' && r2.body.paymentMethod === null);

  section('Shift: open with float');
  r = await api('POST', '/api/shifts/open', { headers: H(adminT), body: { type: 'AM', openingFloat: 100 } });
  ok('shift opens with float', r.status === 201 && r.body.openingFloat === 100 && r.body.type === 'AM');
  r = await api('POST', '/api/shifts/open', { headers: H(adminT), body: { type: 'AM', openingFloat: 50 } });
  ok('cannot open a second shift', r.status === 409);
  r = await api('GET', '/api/shifts/current', { headers: H(adminT) });
  ok('current shift reported open', r.body.open === true);

  section('Accept + paid-before-pickup rule');
  await api('POST', `/api/orders/${A}/accept`, { headers: H(adminT), body: { room: '5' } }); // not collecting yet
  await api('POST', `/api/orders/${A}/advance`, { headers: H(adminT), body: {} }); // cleaning
  await api('POST', `/api/orders/${A}/advance`, { headers: H(adminT), body: {} }); // ready
  r = await api('POST', `/api/orders/${A}/advance`, { headers: H(adminT), body: {} }); // try completed
  ok('cannot mark picked up while unpaid', r.status === 409, `got ${r.status}`);

  section('Take payment (cash) → attribution + shift cash');
  r = await api('POST', `/api/orders/${A}/pay`, { headers: H(adminT), body: { method: 'cash' } });
  ok('payment recorded', r.status === 200 && r.body.paymentStatus === 'paid' && r.body.paymentMethod === 'cash');
  ok('payment attributed to staff', r.body.paidBy && r.body.paidBy.name === 'Ama');
  ok('payment linked to open shift', !!r.body.paidShiftId);
  r = await api('POST', `/api/orders/${A}/advance`, { headers: H(adminT), body: {} }); // now completed
  ok('now can mark picked up', r.status === 200 && r.body.status === 'completed');
  ok('completedBy recorded', r.body.completedBy && r.body.completedBy.name === 'Ama');

  section('Reverse status move');
  r = await api('POST', `/api/orders/${B}/accept`, { headers: H(adminT), body: { room: '8' } });
  await api('POST', `/api/orders/${B}/advance`, { headers: H(adminT), body: {} }); // cleaning
  r = await api('POST', `/api/orders/${B}/revert`, { headers: H(adminT), body: {} });
  ok('admin reverts cleaning → accepted', r.status === 200 && r.body.status === 'accepted', JSON.stringify(r.body.error || r.body.status));

  // cashier without reverseStatus cannot revert
  r = await api('POST', '/api/cashiers', { headers: H(adminT), body: { name: 'Yaw', pin: '4321', role: 'cashier', permissions: { advanceStatus: true, reverseStatus: false } } });
  const yawAuth = await api('POST', '/api/auth/pin', { body: { pin: '4321' } });
  r = await api('POST', `/api/orders/${B}/revert`, { headers: H(yawAuth.body.token), body: {} });
  ok('cashier without reverseStatus blocked', r.status === 403, `got ${r.status}`);

  section('Shift close + reconciliation');
  // Expected cash = float 100 + cash collected (order A = 10) = 110.
  r = await api('POST', '/api/shifts/close', { headers: H(adminT), body: { closingCash: 110 } });
  ok('shift closes', r.status === 200 && r.body.status === 'closed');
  ok('cash collected computed = 10', r.body.cashCollected === 10, `got ${r.body.cashCollected}`);
  ok('expected = 110', r.body.expectedCash === 110, `got ${r.body.expectedCash}`);
  ok('variance = 0 when counted matches', r.body.variance === 0, `got ${r.body.variance}`);

  section('Report: shift + staff breakdowns');
  r = await api('GET', '/api/report', { headers: H(adminT) });
  ok('report has byShift buckets', r.body.byShift && ['AM', 'PM', 'Night'].every(k => k in r.body.byShift));
  ok('report has byStaff', Array.isArray(r.body.byStaff) && r.body.byStaff.length >= 1, JSON.stringify(r.body.byStaff));
  const ama = r.body.byStaff.find(s => s.name === 'Ama');
  ok('staff activity counts accepted', ama && ama.accepted === 2, JSON.stringify(ama));
  ok('staff activity counts payment + collected', ama && ama.payments === 1 && ama.collected === 10, JSON.stringify(ama));
  ok('orders carry shift label', r.body.orders.every(o => ['AM', 'PM', 'Night'].includes(o.shift)));
  const csv = await api('GET', '/api/report/csv', { headers: H(adminT) });
  ok('CSV includes By shift + By staff', /By shift/.test(csv.body) && /By staff/.test(csv.body) && /Accepted by/.test(csv.body));

  section('Shift history endpoint');
  r = await api('GET', '/api/shifts', { headers: H(adminT) });
  ok('shift history lists the closed shift', r.status === 200 && r.body.length === 1 && r.body[0].variance === 0);
} catch (err) {
  fail++; out.push(`\n💥 ${err.stack || err}`);
}

console.log(out.join('\n'));
console.log(`\n${'─'.repeat(40)}\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
