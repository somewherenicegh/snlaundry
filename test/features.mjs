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
const { sentLog, clearSentLog, inviteEmail } = await import('../netlify/functions/lib/email.js');
const { effectiveBaseUrl, inQuietHours, findFollowUpOrders } = await import('../netlify/functions/lib/logic.js');
const featStore = await import('../netlify/functions/lib/store.js');

let pass = 0, fail = 0; const out = [];
const ok = (n, c, x = '') => { if (c) { pass++; out.push(`  ✅ ${n}`); } else { fail++; out.push(`  ❌ ${n} ${x}`); } };
const section = (t) => out.push(`\n▶ ${t}`);
const api = (method, p, opts = {}) => handleRequest({ method, path: p, query: opts.query || {}, body: opts.body || {}, headers: opts.headers || {} });
const H = (t) => ({ authorization: `Bearer ${t}` });
const CUR_SHIFT = ((h) => (h >= 6 && h < 14) ? 'AM' : (h >= 14 && h < 22) ? 'PM' : 'Night')(new Date().getHours());

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
  const Bpub = r2.body.publicId;
  r2 = await api('GET', `/api/orders/public/${r2.body.publicId}`);
  ok('default timing is pay-at-pickup', r2.body.paymentTiming === 'pickup' && r2.body.paymentMethod === null);

  section('Shift: open (laundry handover, must acknowledge)');
  r = await api('POST', '/api/shifts/open', { headers: H(adminT), body: { type: 'AM' } });
  ok('open blocked without acknowledgement', r.status === 400, `got ${r.status}`);
  r = await api('POST', '/api/shifts/open', { headers: H(adminT), body: { type: 'AM', acknowledged: true } });
  ok('shift opens and auto-selects the due shift', r.status === 201 && r.body.type === CUR_SHIFT && r.body.status === 'open', `type ${r.body.type} vs due ${CUR_SHIFT}`);
  ok('no cash fields on shift', r.body.openingFloat === undefined);
  ok('records opening acknowledgement', r.body.openingAcknowledged === true);
  r = await api('POST', '/api/shifts/open', { headers: H(adminT), body: { type: 'AM', acknowledged: true } });
  ok('cannot open a second shift', r.status === 409);
  r = await api('GET', '/api/shifts/current', { headers: H(adminT) });
  ok('current shift reports open + in-progress list', r.body.open === true && Array.isArray(r.body.inProgress));
  ok('in-progress items carry payment status', r.body.inProgress.every(o => 'paymentStatus' in o));

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
  const yawId = r.body.id;
  const yawAuth = await api('POST', '/api/auth/pin', { body: { pin: '4321' } });
  r = await api('POST', `/api/orders/${B}/revert`, { headers: H(yawAuth.body.token), body: {} });
  ok('cashier without reverseStatus blocked', r.status === 403, `got ${r.status}`);

  section('Push subscriptions');
  r = await api('GET', '/api/push/key');
  ok('push key endpoint responds (null when unset)', r.status === 200 && ('key' in r.body));
  r = await api('POST', '/api/push/subscribe', { body: { subscription: { endpoint: 'https://push/1', keys: { p256dh: 'a', auth: 'b' } } } });
  ok('subscribe requires sign-in', r.status === 401);
  r = await api('POST', '/api/push/subscribe', { headers: H(adminT), body: { subscription: { endpoint: 'https://push/1', keys: { p256dh: 'a', auth: 'b' } } } });
  ok('signed-in staff can subscribe', r.status === 200 && r.body.ok);
  r = await api('POST', '/api/push/subscribe', { headers: H(adminT), body: { subscription: { endpoint: 'https://push/1', keys: {} } } });
  ok('duplicate subscription is de-duped', r.status === 200 && r.body.existing === true);

  section('Unread guest messages (drives the message ping)');
  await api('POST', `/api/orders/public/${Bpub}/messages`, { body: { text: 'Is it ready yet?' } });
  r = await api('GET', '/api/orders', { headers: H(adminT) });
  let bOrder = r.body.find(o => o.id === B);
  ok('order exposes unread guest message', bOrder.messages.some(m => m.sender === 'guest' && !m.readByStaff));
  await api('POST', `/api/orders/${B}/read`, { headers: H(adminT) });
  r = await api('GET', '/api/orders', { headers: H(adminT) });
  bOrder = r.body.find(o => o.id === B);
  ok('marking read clears the unread flag', bOrder.messages.every(m => m.readByStaff));

  section('Shift close (confirm laundry in progress, no cash)');
  r = await api('POST', '/api/shifts/close', { headers: H(adminT), body: { acknowledged: false } });
  ok('close blocked without acknowledgement', r.status === 400, `got ${r.status}`);
  // Order B is in progress (accepted) at this point; confirm it.
  r = await api('POST', '/api/shifts/close', { headers: H(adminT), body: { acknowledged: true, confirmedOrderIds: [B], note: 'all present' } });
  ok('shift closes with acknowledgement', r.status === 200 && r.body.status === 'closed' && r.body.acknowledged === true, JSON.stringify(r.body.error || ''));
  ok('records confirmed laundry items', r.body.confirmedOrderIds.includes(B));
  ok('records in-progress count at close', typeof r.body.closingInProgress === 'number');
  ok('no cash fields recorded', r.body.closingCash === undefined && r.body.variance === undefined);

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

  section('Report filtered to a single shift');
  const nowH = new Date().getHours();
  const curShift = (nowH >= 6 && nowH < 14) ? 'AM' : (nowH >= 14 && nowH < 22) ? 'PM' : 'Night';
  const otherShift = curShift === 'AM' ? 'PM' : 'AM';
  r = await api('GET', '/api/report', { headers: H(adminT), query: { shift: curShift } });
  ok('report filtered to the current shift returns its orders', r.body.range.shift === curShift && r.body.totals.orders > 0, JSON.stringify(r.body.range));
  r = await api('GET', '/api/report', { headers: H(adminT), query: { shift: otherShift } });
  ok('report filtered to a different shift returns none', r.body.range.shift === otherShift && r.body.totals.orders === 0);
  const csvShift = await api('GET', '/api/report/csv', { headers: H(adminT), query: { shift: curShift } });
  ok('CSV notes the selected shift', new RegExp('Shift,' + curShift).test(csvShift.body));

  section('Shift history endpoint');
  r = await api('GET', '/api/shifts', { headers: H(adminT) });
  ok('shift history lists the closed shift', r.status === 200 && r.body.length === 1 && r.body[0].acknowledged === true);

  section('Handover auto-closes the prior open shift');
  await api('POST', '/api/shifts/open', { headers: H(adminT), body: { acknowledged: true } });
  r = await api('POST', '/api/shifts/open', { headers: H(adminT), body: { acknowledged: true, handover: true } });
  ok('handover opens the new (due) shift', r.status === 201 && r.body.type === CUR_SHIFT);
  r = await api('GET', '/api/shifts', { headers: H(adminT) });
  ok('only one shift open after handover', r.body.filter(s => s.status === 'open').length === 1);

  section('Staff invitation email');
  r = await api('POST', `/api/cashiers/${yawId}/invite`, { headers: H(adminT), body: { email: 'yaw@example.com', pin: '0000' } });
  ok('invite rejected when the PIN is wrong', r.status === 400, `got ${r.status}`);
  clearSentLog();
  r = await api('POST', `/api/cashiers/${yawId}/invite`, { headers: H(adminT), body: { email: 'yaw@example.com', pin: '4321' } });
  ok('invite sent with the correct PIN', r.status === 200 && r.body.sentTo === 'yaw@example.com', JSON.stringify(r.body));
  ok('invitation email dispatched', sentLog().some((e) => e.to === 'yaw@example.com' && /invited/i.test(e.subject)));
  r = await api('GET', '/api/cashiers', { headers: H(adminT) });
  ok('cashier email stored from invite', (r.body.find((x) => x.id === yawId) || {}).email === 'yaw@example.com');
  r = await api('POST', `/api/cashiers/${yawId}/invite`, { headers: H(yawAuth.body.token), body: { email: 'x@x.com', pin: '4321' } });
  ok('non-manager cannot send invites', r.status === 403);
  const inv = inviteEmail({ name: 'Yaw Mensah', role: 'admin', permissions: {}, pin: '4321' }, { hostelName: 'somewhere nice', accentColor: '#0f766e', baseUrl: 'https://x.netlify.app' }, { inviterName: 'Ama' });
  ok('invite email includes the PIN', /4321/.test(inv.html));
  ok('invite email states admin full access + app link', /Administrator/.test(inv.html) && /full access/i.test(inv.html) && /https:\/\/x\.netlify\.app\/app/.test(inv.html));
  ok('invite email has no do-not-reply footer', !/do not reply/i.test(inv.html));
  // The app button/link should appear even if the admin never set a Base URL.
  process.env.URL = 'https://fallback.netlify.app';
  ok('email URL falls back to the Netlify site URL', effectiveBaseUrl({ baseUrl: '' }) === 'https://fallback.netlify.app');
  ok('an explicit Base URL wins (trailing slash trimmed)', effectiveBaseUrl({ baseUrl: 'https://custom.example/' }) === 'https://custom.example');
  const invFb = inviteEmail({ name: 'Kofi', role: 'cashier', permissions: { acceptOrders: true }, pin: '2468' }, { hostelName: 'X', baseUrl: 'https://fallback.netlify.app' }, {});
  ok('invite email shows the Open-app button + link', /Open the laundry app/.test(invFb.html) && /https:\/\/fallback\.netlify\.app\/app/.test(invFb.html));
  delete process.env.URL;

  section('Multiple stuck-order alert recipients');
  r = await api('PUT', '/api/settings', { headers: H(adminT), body: { alertRecipients: 'a@x.com, b@x.com; c@x.com\nnot-an-email, a@x.com' } });
  ok('recipients parsed, de-duped, validated', Array.isArray(r.body.alertRecipients) && r.body.alertRecipients.length === 3 && r.body.alertRecipients.includes('a@x.com'), JSON.stringify(r.body.alertRecipients));

  section('Email formatting');
  const { orderEmail } = await import('../netlify/functions/lib/email.js');
  const em = orderEmail('accepted',
    { number: 5, guestName: 'Test User', items: 3, loads: 1, price: 10, paymentStatus: 'unpaid', pickupAt: new Date().toISOString(), publicId: 'p' },
    { hostelName: 'somewhere nice', currency: { symbol: '₵' } });
  ok('email footer line removed', !/do not reply directly/i.test(em.html));
  ok('status badge is on its own row, separate from the sentence', /Accepted<\/span><\/p>\s*<p[^>]*>Your laundry order/.test(em.html), 'badge not separated');

  section('Price change requires a reason');
  r = await api('PATCH', `/api/orders/${B}`, { headers: H(adminT), body: { price: 99 } });
  ok('price change without a reason is blocked', r.status === 400, `got ${r.status}`);
  r = await api('PATCH', `/api/orders/${B}`, { headers: H(adminT), body: { price: 99, priceReason: 'added express service' } });
  ok('price change with a reason is accepted', r.status === 200 && r.body.price === 99);
  ok('reason recorded in the order log', r.body.logs.some((l) => /reason: added express service/.test(l.detail)));

  section('Admin can reset the order-number sequence');
  r = await api('GET', '/api/sequence', { headers: H(adminT) });
  ok('reads the next order number', typeof r.body.next === 'number');
  r = await api('POST', '/api/sequence', { headers: H(adminT), body: { next: 5000 } });
  ok('sets the next order number', r.status === 200 && r.body.next === 5000);
  r = await api('POST', '/api/orders', { body: { guestName: 'Seq Test', guestEmail: 'seq@example.com', items: 3 } });
  ok('the next new order uses it', r.body.number === 5000, `got ${r.body.number}`);
  r = await api('POST', '/api/sequence', { headers: H(yawAuth.body.token), body: { next: 10 } });
  ok('non-admin cannot change the sequence', r.status === 403);

  section('Default pickup is 6PM the next day');
  let pu = await api('POST', '/api/orders', { body: { guestName: 'Pick Up', guestEmail: 'pu@example.com', items: 2 } });
  await api('POST', `/api/orders/${pu.body.id}/accept`, { headers: H(adminT), body: { room: 'Duafe' } });
  r = await api('GET', `/api/orders/public/${pu.body.publicId}`);
  const pk = new Date(r.body.pickupAt);
  ok('pickup defaults to 18:00', pk.getHours() === 18 && pk.getMinutes() === 0, r.body.pickupAt);

  section('Completed order gives a friendly advance message');
  r = await api('POST', `/api/orders/${A}/advance`, { headers: H(adminT), body: {} });
  ok('advancing a completed order is not a scary error', r.status === 409 && /already been picked up/i.test(r.body.error), JSON.stringify(r.body));

  section('Shift activity summary');
  r = await api('GET', '/api/shifts/current', { headers: H(adminT) });
  ok('current shift includes an activity summary', r.body.open === true && !!r.body.activity && typeof r.body.activity.received.count === 'number' && typeof r.body.activity.payments.total === 'number', JSON.stringify(r.body.activity || {}));

  section('Reason required when the cashier changes price at accept');
  const pr = await api('POST', '/api/orders', { body: { guestName: 'Prc', guestEmail: 'prc@example.com', items: 5 } });
  r = await api('POST', `/api/orders/${pr.body.id}/accept`, { headers: H(adminT), body: { room: 'Duafe', price: 30 } });
  ok('changing accept price without a reason is blocked', r.status === 400, `got ${r.status}`);
  r = await api('POST', `/api/orders/${pr.body.id}/accept`, { headers: H(adminT), body: { room: 'Duafe', price: 30, priceReason: 'bulky items' } });
  ok('changing accept price with a reason is accepted', r.status === 200 && r.body.price === 30, JSON.stringify(r.body.error || r.body.price));
  ok('accept price change is logged with the reason', r.body.logs.some((l) => /reason: bulky items/.test(l.detail)));

  section('Quiet hours logic');
  ok('2 AM is within 18:00–07:00 quiet window', inQuietHours(new Date(2020, 0, 1, 2, 0, 0), 18, 7) === true);
  ok('noon is not quiet', inQuietHours(new Date(2020, 0, 1, 12, 0, 0), 18, 7) === false);
  ok('equal from/to disables quiet entirely', inQuietHours(new Date(), 0, 0) === false);

  section('Laundry person role');
  r = await api('POST', '/api/cashiers', { headers: H(adminT), body: { name: 'Kwame', pin: '2020', role: 'laundry' } });
  ok('laundry role created', r.status === 201 && r.body.role === 'laundry', JSON.stringify(r.body));
  ok('laundry has advanceStatus but not takePayment/acceptOrders', r.body.permissions.advanceStatus === true && !r.body.permissions.takePayment && !r.body.permissions.acceptOrders);
  const laundryAuth = await api('POST', '/api/auth/pin', { body: { pin: '2020' } });
  const lo = await api('POST', '/api/orders', { body: { guestName: 'L Guest', guestEmail: 'l@example.com', items: 5 } });
  await api('POST', `/api/orders/${lo.body.id}/accept`, { headers: H(adminT), body: { room: 'Duafe', paymentStatus: 'paid', paymentMethod: 'cash' } });
  r = await api('POST', `/api/orders/${lo.body.id}/advance`, { headers: H(laundryAuth.body.token), body: {} });
  ok('laundry advances accepted → cleaning', r.status === 200 && r.body.status === 'cleaning');
  r = await api('POST', `/api/orders/${lo.body.id}/advance`, { headers: H(laundryAuth.body.token), body: {} });
  ok('laundry advances cleaning → ready', r.status === 200 && r.body.status === 'ready');
  r = await api('POST', `/api/orders/${lo.body.id}/advance`, { headers: H(laundryAuth.body.token), body: {} });
  ok('laundry cannot mark picked up', r.status === 403, `got ${r.status}`);
  r = await api('POST', `/api/orders/${lo.body.id}/advance`, { headers: H(adminT), body: {} });
  ok('admin can mark picked up', r.status === 200 && r.body.status === 'completed');

  section('Delay reason snoozes the follow-up');
  await api('PUT', '/api/settings', { headers: H(adminT), body: { quietFrom: 0, quietTo: 0, followUpHours: 0.5, followUpEveryHours: 0.5, pickupLeadHours: 0 } });
  const d1 = await api('POST', '/api/orders', { body: { guestName: 'D Guest', guestEmail: 'd@example.com', items: 4 } });
  await api('POST', `/api/orders/${d1.body.id}/accept`, { headers: H(adminT), body: { room: 'X' } });
  let ords = await featStore.getCollection('orders');
  ords.find((o) => o.id === d1.body.id).acceptedAt = new Date(Date.now() - 3600000).toISOString(); // 1h ago
  await featStore.saveCollection('orders', ords);
  let due = await findFollowUpOrders();
  ok('accepted-too-long order is due', due.some((o) => o.id === d1.body.id));
  r = await api('POST', `/api/orders/${d1.body.id}/delay-reason`, { headers: H(adminT), body: { reason: 'machine broken' } });
  ok('delay reason recorded', r.status === 200 && r.body.delayReason === 'machine broken');
  due = await findFollowUpOrders();
  ok('snoozed order is not due', !due.some((o) => o.id === d1.body.id));

  section('Pickup-approaching triggers, past-pickup does not');
  await api('PUT', '/api/settings', { headers: H(adminT), body: { quietFrom: 0, quietTo: 0, followUpHours: 100, pickupLeadHours: 3 } });
  const p1 = await api('POST', '/api/orders', { body: { guestName: 'P Guest', guestEmail: 'p@example.com', items: 3 } });
  await api('POST', `/api/orders/${p1.body.id}/accept`, { headers: H(adminT), body: { room: 'X', pickupAt: new Date(Date.now() + 2 * 3600000).toISOString() } });
  due = await findFollowUpOrders();
  ok('order 2h before pickup (lead 3h) is due', due.some((o) => o.id === p1.body.id && o._reason === 'pickupSoon'), JSON.stringify(due.map((o) => [o.id, o._reason])));
  ords = await featStore.getCollection('orders');
  ords.find((o) => o.id === p1.body.id).pickupAt = new Date(Date.now() - 3600000).toISOString(); // pickup 1h ago
  await featStore.saveCollection('orders', ords);
  due = await findFollowUpOrders();
  ok('order past pickup time is NOT due (no sound after pickup)', !due.some((o) => o.id === p1.body.id));
  // A READY order approaching pickup should NOT trigger a follow-up (it's already done).
  const p2 = await api('POST', '/api/orders', { body: { guestName: 'P2', guestEmail: 'p2@example.com', items: 2, paymentTiming: 'pickup' } });
  await api('POST', `/api/orders/${p2.body.id}/accept`, { headers: H(adminT), body: { room: 'X', pickupAt: new Date(Date.now() + 2 * 3600000).toISOString() } });
  await api('POST', `/api/orders/${p2.body.id}/advance`, { headers: H(adminT), body: {} }); // cleaning
  await api('POST', `/api/orders/${p2.body.id}/advance`, { headers: H(adminT), body: {} }); // ready
  due = await findFollowUpOrders();
  ok('a READY order approaching pickup is NOT due', !due.some((o) => o.id === p2.body.id));

  section('Admin-defined rooms');
  r = await api('PUT', '/api/settings', { headers: H(adminT), body: { rooms: 'Duafe\nSankofa, Adinkra\nDuafe' } });
  ok('rooms parsed and de-duped', Array.isArray(r.body.rooms) && r.body.rooms.length === 3 && r.body.rooms.includes('Duafe'), JSON.stringify(r.body.rooms));

  section('Backup export / restore');
  r = await api('GET', '/api/backup', { headers: H(adminT) });
  ok('export returns a full snapshot', r.status === 200 && r.body.app === 'hostel-laundry' && Array.isArray(r.body.cashiers) && Array.isArray(r.body.orders));
  const snap = r.body;
  r = await api('GET', '/api/backup', { headers: H(yawAuth.body.token) });
  ok('non-admin cannot export', r.status === 403);
  r = await api('POST', '/api/backup/restore', { headers: H(adminT), body: { data: { foo: 1 } } });
  ok('rejects a non-backup file', r.status === 400);
  r = await api('POST', '/api/backup/restore', { headers: H(adminT), body: { data: { app: 'hostel-laundry', cashiers: [{ role: 'cashier', active: true }] } } });
  ok('refuses a restore with no admin (anti-lockout)', r.status === 400);
  r = await api('POST', '/api/backup/restore', { headers: H(adminT), body: { data: snap } });
  ok('restores a valid snapshot', r.status === 200 && r.body.ok);

  section('Notification devices + open-shift flag');
  r = await api('POST', '/api/push/subscribe', { headers: H(adminT), body: { subscription: { endpoint: 'https://push/dev1', keys: { p256dh: 'a', auth: 'b' } }, label: 'Reception PC' } });
  ok('device subscribes with a label', r.status === 200 && r.body.ok);
  r = await api('GET', '/api/push/devices', { headers: H(adminT) });
  const dev = r.body.find((d) => d.label === 'Reception PC');
  ok('admin lists devices (default: no shift reminder)', r.status === 200 && dev && dev.role === 'admin' && dev.shiftReminders === false, JSON.stringify(dev || {}));
  r = await api('PATCH', `/api/push/devices/${dev.id}`, { headers: H(adminT), body: { shiftReminders: true } });
  ok('admin flags a device for the open-shift reminder', r.status === 200 && r.body.device.shiftReminders === true);
  r = await api('GET', '/api/push/devices', { headers: H(yawAuth.body.token) });
  ok('non-admin cannot manage devices', r.status === 403);
  r = await api('DELETE', `/api/push/devices/${dev.id}`, { headers: H(adminT) });
  ok('admin removes a device', r.status === 200 && r.body.ok);

  section('Required fields (admin-controlled)');
  // email required by default
  r = await api('POST', '/api/orders', { body: { guestName: 'No Email', items: 3, paymentTiming: 'pickup' } });
  ok('order without email is blocked when required', r.status === 400, `got ${r.status}`);
  await api('PUT', '/api/settings', { headers: H(adminT), body: { requireEmail: false } });
  r = await api('POST', '/api/orders', { body: { guestName: 'No Email', items: 3 } });
  ok('order without email allowed once requirement is off', r.status === 201);
  r = await api('GET', `/api/orders/public/${r.body.publicId}`);
  ok('payment defaults to pay-at-pickup', r.body.paymentTiming === 'pickup');
  await api('PUT', '/api/settings', { headers: H(adminT), body: { requireEmail: true } });
  // room required on accept by default
  const rq = await api('POST', '/api/orders', { body: { guestName: 'Room Req', guestEmail: 'rr@example.com', items: 2, paymentTiming: 'pickup' } });
  r = await api('POST', `/api/orders/${rq.body.id}/accept`, { headers: H(adminT), body: {} });
  ok('accept without a room is blocked when required', r.status === 400, `got ${r.status}`);
  await api('PUT', '/api/settings', { headers: H(adminT), body: { requireRoomOnAccept: false } });
  r = await api('POST', `/api/orders/${rq.body.id}/accept`, { headers: H(adminT), body: {} });
  ok('accept without a room allowed once requirement is off', r.status === 200 && r.body.status === 'accepted');
  await api('PUT', '/api/settings', { headers: H(adminT), body: { requireRoomOnAccept: true } });

  section('Admin: delete orders in a timeframe');
  const before = (await api('GET', '/api/orders', { headers: H(adminT) })).body.length;
  ok('there are orders to delete', before > 0);
  r = await api('POST', '/api/orders/delete-range', { headers: H(yawAuth.body.token), body: { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' } });
  ok('non-admin cannot bulk delete', r.status === 403, `got ${r.status}`);
  r = await api('POST', '/api/orders/delete-range', { headers: H(adminT), body: { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' } });
  ok('admin deletes orders in range', r.status === 200 && r.body.removed === before, JSON.stringify(r.body));
  r = await api('GET', '/api/orders', { headers: H(adminT) });
  ok('orders cleared after delete', r.body.length === 0);
} catch (err) {
  fail++; out.push(`\n💥 ${err.stack || err}`);
}

console.log(out.join('\n'));
console.log(`\n${'─'.repeat(40)}\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
