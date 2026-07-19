// End-to-end logic tests. No network, no Netlify — uses the file-store fallback.
// Run with: npm test

import { rmSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Force local file storage into a throwaway temp dir.
const dir = mkdtempSync(path.join(os.tmpdir(), 'laundry-test-'));
process.env.FORCE_FILE_STORE = '1';
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET = 'test-secret';
delete process.env.RESEND_API_KEY; // ensure email dry-run

const { handleRequest } = await import('../netlify/functions/api.js');
const L = await import('../netlify/functions/lib/logic.js');
const { runStuckCheck } = await import('../netlify/functions/stuck-check.js');
const { sentLog, clearSentLog } = await import('../netlify/functions/lib/email.js');
const store = await import('../netlify/functions/lib/store.js');

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name} ${extra}`); }
}
function section(t) { results.push(`\n▶ ${t}`); }

const api = (method, path, opts = {}) =>
  handleRequest({ method, path, query: opts.query || {}, body: opts.body || {}, headers: opts.headers || {} });
const authH = (token) => ({ authorization: `Bearer ${token}` });

try {
  // ---- storage mode sanity ----
  section('Storage');
  ok('falls back to file store outside Netlify', (await store.storeMode()) === 'file');

  // ---- setup ----
  section('First-run setup & PIN auth');
  let r = await api('GET', '/api/status');
  ok('status reports not set up', r.status === 200 && r.body.isSetup === false);

  r = await api('POST', '/api/setup', { body: { hostelName: 'Blue Wave Hostel', adminName: 'Ada', adminPin: '1234' } });
  ok('setup succeeds', r.status === 200 && r.body.ok);

  r = await api('POST', '/api/setup', { body: { hostelName: 'x', adminPin: '9999' } });
  ok('cannot set up twice', r.status === 409);

  r = await api('POST', '/api/auth/pin', { body: { pin: '0000' } });
  ok('wrong PIN rejected', r.status === 401);

  r = await api('POST', '/api/auth/pin', { body: { pin: '1234' } });
  ok('admin PIN authenticates', r.status === 200 && r.body.user.role === 'admin', JSON.stringify(r.body));
  const adminToken = r.body.token;
  const adminUser = r.body.user;

  // ---- settings ----
  section('Settings (currency, pricing, pieces per load, logo/name)');
  r = await api('PUT', '/api/settings', {
    headers: authH(adminToken),
    body: {
      currency: { code: 'GBP', symbol: '£' }, pricePerLoad: 8, piecesPerLoad: 10,
      turnaroundHours: 24, stuckThresholdHours: 4,
      adminEmail: 'admin@bluewave.test', receptionEmail: 'reception@bluewave.test',
      hostelName: 'Blue Wave Hostel', logoDataUrl: 'data:image/png;base64,AAAA',
    },
  });
  ok('admin can update settings', r.status === 200 && r.body.currency.code === 'GBP' && r.body.piecesPerLoad === 10);

  r = await api('GET', '/api/public-settings');
  ok('guest branding endpoint exposes name+currency', r.status === 200 && r.body.hostelName === 'Blue Wave Hostel' && r.body.currency.symbol === '£');

  // ---- create cashier w/ limited permissions ----
  section('Cashiers, PINs & access levels');
  r = await api('POST', '/api/cashiers', {
    headers: authH(adminToken),
    body: { name: 'Ben', pin: '5678', role: 'cashier',
      permissions: { acceptOrders: true, advanceStatus: true, modifyAccepted: false, viewReports: false, exportReports: false, cancelOrders: false, messageGuests: true } },
  });
  ok('admin creates a cashier', r.status === 201 && r.body.role === 'cashier');
  const benId = r.body.id;

  r = await api('POST', '/api/cashiers', { headers: authH(adminToken), body: { name: 'Dup', pin: '5678' } });
  ok('duplicate PIN rejected', r.status === 409);

  r = await api('POST', '/api/auth/pin', { body: { pin: '5678' } });
  ok('cashier PIN switches user (no full login)', r.status === 200 && r.body.user.name === 'Ben');
  const benToken = r.body.token;

  // ---- guest places order ----
  section('Guest order placement (QR flow)');
  r = await api('POST', '/api/orders', { body: { guestName: 'Carla Diaz', guestEmail: 'carla@example.com', items: 23 } });
  ok('guest places order (23 items)', r.status === 201 && r.body.number > 1000, JSON.stringify(r.body));
  const pub = r.body.publicId;
  const orderId = r.body.id;

  r = await api('POST', '/api/orders', { body: { guestName: '', guestEmail: 'bad', items: 0 } });
  ok('invalid order rejected', r.status === 400);

  r = await api('GET', `/api/orders/public/${pub}`);
  ok('guest can track order by public id', r.status === 200 && r.body.status === 'new');
  ok('loads computed = ceil(23/10) = 3', r.body.loads === 3, `got ${r.body.loads}`);
  ok('guest view hides email/logs', r.body.guestEmail === undefined && r.body.logs === undefined);

  // ---- accept order (permission + email) ----
  section('Reception accepts order + lifecycle emails');
  clearSentLog();
  r = await api('POST', `/api/orders/${orderId}/accept`, {
    headers: authH(benToken),
    body: { room: '204', paymentStatus: 'paid', paymentMethod: 'card' },
  });
  ok('cashier with acceptOrders can accept', r.status === 200 && r.body.status === 'accepted', JSON.stringify(r.body.error||''));
  ok('price auto = 3 loads × £8 = 24', r.body.price === 24, `got ${r.body.price}`);
  ok('pickup defaults to +24h', !!r.body.pickupAt);
  ok('payment recorded (paid/card)', r.body.paymentStatus === 'paid' && r.body.paymentMethod === 'card');
  ok('acceptance email sent to guest', sentLog().some((e) => e.to === 'carla@example.com' && /accepted/i.test(e.subject)));

  // ---- cashier cannot modify accepted order (admin-only) ----
  section('Access control: only admin modifies accepted orders');
  r = await api('PATCH', `/api/orders/${orderId}`, { headers: authH(benToken), body: { price: 5 } });
  ok('cashier without modifyAccepted is blocked (403)', r.status === 403, `got ${r.status}`);
  r = await api('PATCH', `/api/orders/${orderId}`, { headers: authH(adminToken), body: { price: 20, room: '205' } });
  ok('admin can modify accepted order', r.status === 200 && r.body.price === 20 && r.body.room === '205');

  // ---- advance through cycle w/ emails ----
  section('Status cycle accepted → cleaning → ready → completed');
  clearSentLog();
  r = await api('POST', `/api/orders/${orderId}/advance`, { headers: authH(benToken), body: {} });
  ok('advance to cleaning', r.status === 200 && r.body.status === 'cleaning');
  ok('cleaning email sent', sentLog().some((e) => /cleaned/i.test(e.subject)));
  r = await api('POST', `/api/orders/${orderId}/advance`, { headers: authH(benToken), body: {} });
  ok('advance to ready', r.status === 200 && r.body.status === 'ready');
  ok('ready email sent', sentLog().some((e) => /ready/i.test(e.subject)));
  r = await api('POST', `/api/orders/${orderId}/advance`, { headers: authH(benToken), body: {} });
  ok('advance to completed', r.status === 200 && r.body.status === 'completed');

  // ---- audit log ----
  section('Audit log per order');
  r = await api('GET', `/api/orders/${orderId}`, { headers: authH(adminToken) });
  const actions = r.body.logs.map((l) => l.action);
  ok('log captures placed/accepted/modified/status', ['placed','accepted','modified','status'].every((a) => actions.includes(a)), actions.join(','));
  ok('log records actor name', r.body.logs.some((l) => l.actor === 'Ben') && r.body.logs.some((l) => l.actor === 'Ada'));

  // ---- messaging inbox ----
  section('Guest messaging (inbox)');
  r = await api('POST', `/api/orders/public/${pub}/messages`, { body: { text: 'Can I get it by noon?' } });
  ok('guest sends message', r.status === 200 && r.body.messages.length === 1);
  clearSentLog();
  r = await api('POST', `/api/orders/${orderId}/reply`, { headers: authH(benToken), body: { text: 'Yes, ready by 11am.' } });
  ok('staff replies', r.status === 200);
  ok('reply emails guest', sentLog().some((e) => /message/i.test(e.subject)));
  r = await api('GET', '/api/threads', { headers: authH(benToken) });
  ok('threads list shows conversation', r.status === 200 && r.body.length === 1 && r.body[0].unread === 0);

  // ---- reporting ----
  section('Revenue reporting + CSV export');
  // add a second, cash order for richer numbers
  let r2 = await api('POST', '/api/orders', { body: { guestName: 'Sam Lee', guestEmail: 'sam@example.com', items: 5 } });
  await api('POST', `/api/orders/${r2.body.id}/accept`, { headers: authH(adminToken), body: { room: '101', paymentStatus: 'paid', paymentMethod: 'cash' } });
  r = await api('GET', '/api/report', { headers: authH(adminToken) });
  ok('report totals compute', r.status === 200 && r.body.totals.orders === 2, JSON.stringify(r.body.totals));
  ok('revenue = 20 (modified) + 8 (1 load) = 28', r.body.totals.revenue === 28, `got ${r.body.totals.revenue}`);
  ok('split by method present', r.body.byMethod.cash === 8 && r.body.byMethod.card === 20, JSON.stringify(r.body.byMethod));
  ok('daily breakdown present', Array.isArray(r.body.byDay) && r.body.byDay.length >= 1);

  r = await api('GET', '/api/report/csv', { headers: authH(adminToken) });
  ok('CSV export returns text/csv', r.contentType === 'text/csv' && /Total revenue/.test(r.body));

  r = await api('GET', '/api/report', { headers: authH(benToken) });
  ok('cashier without viewReports blocked from report', r.status === 403);

  // ---- stuck-order detection ----
  section('Stuck-order alert (accepted > threshold)');
  let r3 = await api('POST', '/api/orders', { body: { guestName: 'Old Order', guestEmail: 'old@example.com', items: 4 } });
  await api('POST', `/api/orders/${r3.body.id}/accept`, { headers: authH(adminToken), body: { room: '303' } });
  // backdate acceptedAt beyond threshold
  const orders = await store.getCollection('orders');
  const target = orders.find((o) => o.id === r3.body.id);
  target.acceptedAt = new Date(Date.now() - 5 * 3600000).toISOString();
  await store.saveCollection('orders', orders);
  clearSentLog();
  const stuckRes = await runStuckCheck();
  ok('stuck check finds the 5h-old order', stuckRes.alerted === 1, JSON.stringify(stuckRes));
  ok('alert emailed admin + reception', sentLog().filter((e) => /need attention/i.test(e.subject)).length === 2);
  const stuckRes2 = await runStuckCheck();
  ok('does not re-alert same order', stuckRes2.alerted === 0);

  // admin can lower threshold
  await api('PUT', '/api/settings', { headers: authH(adminToken), body: { stuckThresholdHours: 1 } });
  r = await api('GET', '/api/settings', { headers: authH(adminToken) });
  ok('admin can customise stuck threshold', r.body.stuckThresholdHours === 1);

  // ---- guard: unauthenticated ----
  section('Auth guards');
  r = await api('GET', '/api/orders');
  ok('unauthenticated order list blocked', r.status === 401);
  r = await api('POST', '/api/cashiers', { headers: authH(benToken), body: { name: 'X', pin: '1111' } });
  ok('cashier cannot manage cashiers', r.status === 403);
  r = await api('DELETE', `/api/cashiers/${adminUser.id}`, { headers: authH(adminToken) });
  ok('cannot delete last admin', r.status === 400);

} catch (err) {
  fail++;
  results.push(`\n💥 UNCAUGHT: ${err.stack || err}`);
}

console.log(results.join('\n'));
console.log(`\n${'─'.repeat(40)}`);
console.log(`${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
