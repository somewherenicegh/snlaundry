// Core business logic. Pure-ish functions over the storage layer so they can be
// unit-tested directly without HTTP.

import { readJSON, writeJSON, getCollection, saveCollection } from './store.js';
import {
  hashPin, verifyPin, signToken, defaultCashierPermissions, newId,
} from './auth.js';
import { sendEmail, orderEmail } from './email.js';

const K_SETTINGS = 'settings';
const K_CASHIERS = 'cashiers';
const K_ORDERS = 'orders';
const K_META = 'meta';

export const STATUSES = ['new', 'accepted', 'cleaning', 'ready', 'completed', 'cancelled'];
const FLOW = { accepted: 'cleaning', cleaning: 'ready', ready: 'completed' };

// ---------------------------------------------------------------- Settings ---
export function defaultSettings() {
  return {
    hostelName: '',
    logoDataUrl: '',
    accentColor: '#0f766e',
    currency: { code: 'USD', symbol: '$' },
    pricePerLoad: 10,
    piecesPerLoad: 25,
    turnaroundHours: 24,
    stuckThresholdHours: 4,
    adminEmail: '',
    receptionEmail: '',
    baseUrl: '',
    configured: false,
  };
}

export async function getSettings() {
  const s = await readJSON(K_SETTINGS, null);
  return { ...defaultSettings(), ...(s || {}) };
}

export async function updateSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  // Never let piecesPerLoad drop below 1.
  next.piecesPerLoad = Math.max(1, Number(next.piecesPerLoad) || 25);
  next.pricePerLoad = Math.max(0, Number(next.pricePerLoad) || 0);
  next.stuckThresholdHours = Math.max(0.25, Number(next.stuckThresholdHours) || 4);
  next.turnaroundHours = Math.max(1, Number(next.turnaroundHours) || 24);
  await writeJSON(K_SETTINGS, next);
  return next;
}

// ------------------------------------------------------------------- Setup ---
export async function isSetup() {
  const cashiers = await getCollection(K_CASHIERS);
  return cashiers.some((c) => c.role === 'admin');
}

export async function firstRunSetup({ hostelName, adminName, adminPin }) {
  if (await isSetup()) throw httpError(409, 'Already set up');
  validatePin(adminPin);
  const { salt, hash } = hashPin(adminPin);
  const admin = {
    id: newId('csh'), name: adminName || 'Admin', role: 'admin',
    salt, hash, permissions: {}, active: true, createdAt: nowIso(),
  };
  await saveCollection(K_CASHIERS, [admin]);
  await updateSettings({ hostelName: hostelName || '', configured: true });
  return { ok: true };
}

// ---------------------------------------------------------------- Cashiers ---
export async function listCashiers() {
  const cashiers = await getCollection(K_CASHIERS);
  return cashiers.map(publicCashier);
}

export async function createCashier({ name, pin, role = 'cashier', permissions }) {
  validatePin(pin);
  const cashiers = await getCollection(K_CASHIERS);
  if (await pinInUse(pin, cashiers)) throw httpError(409, 'That PIN is already in use — choose another.');
  const { salt, hash } = hashPin(pin);
  const c = {
    id: newId('csh'), name: name || 'Cashier',
    role: role === 'admin' ? 'admin' : 'cashier',
    salt, hash,
    permissions: role === 'admin' ? {} : { ...defaultCashierPermissions(), ...(permissions || {}) },
    active: true, createdAt: nowIso(),
  };
  cashiers.push(c);
  await saveCollection(K_CASHIERS, cashiers);
  return publicCashier(c);
}

export async function updateCashier(id, patch, actor) {
  const cashiers = await getCollection(K_CASHIERS);
  const c = cashiers.find((x) => x.id === id);
  if (!c) throw httpError(404, 'Cashier not found');
  if (patch.name != null) c.name = patch.name;
  if (patch.role != null) c.role = patch.role === 'admin' ? 'admin' : 'cashier';
  if (patch.active != null) c.active = !!patch.active;
  if (patch.permissions && c.role !== 'admin') c.permissions = { ...c.permissions, ...patch.permissions };
  if (patch.pin) {
    validatePin(patch.pin);
    if (await pinInUse(patch.pin, cashiers, id)) throw httpError(409, 'That PIN is already in use.');
    const { salt, hash } = hashPin(patch.pin);
    c.salt = salt; c.hash = hash;
  }
  // Never allow removing the last admin.
  if (c.role !== 'admin' && cashiers.filter((x) => x.role === 'admin' && x.active).length === 0) {
    throw httpError(400, 'At least one active admin is required.');
  }
  await saveCollection(K_CASHIERS, cashiers);
  return publicCashier(c);
}

export async function deleteCashier(id) {
  const cashiers = await getCollection(K_CASHIERS);
  const c = cashiers.find((x) => x.id === id);
  if (!c) throw httpError(404, 'Cashier not found');
  const remainingAdmins = cashiers.filter((x) => x.role === 'admin' && x.id !== id).length;
  if (c.role === 'admin' && remainingAdmins === 0) throw httpError(400, 'Cannot remove the last admin.');
  await saveCollection(K_CASHIERS, cashiers.filter((x) => x.id !== id));
  return { ok: true };
}

export async function authenticatePin(pin) {
  const cashiers = await getCollection(K_CASHIERS);
  const c = cashiers.find((x) => x.active && verifyPin(String(pin), x.salt, x.hash));
  if (!c) return null;
  const user = publicCashier(c);
  const token = signToken({ id: c.id, name: c.name, role: c.role });
  return { user, token };
}

export async function getCashierById(id) {
  const cashiers = await getCollection(K_CASHIERS);
  const c = cashiers.find((x) => x.id === id);
  return c ? publicCashier(c) : null;
}

// -------------------------------------------------------------------- Orders --
export function computeLoads(items, piecesPerLoad) {
  const n = Math.max(0, Math.floor(Number(items) || 0));
  return Math.max(items > 0 ? 1 : 0, Math.ceil(n / Math.max(1, piecesPerLoad)));
}

export async function createOrder({ guestName, guestEmail, items, note }) {
  if (!guestName || !String(guestName).trim()) throw httpError(400, 'Name is required');
  if (!validEmail(guestEmail)) throw httpError(400, 'A valid email is required');
  const n = Math.floor(Number(items));
  if (!n || n < 1) throw httpError(400, 'Number of items must be at least 1');

  const settings = await getSettings();
  const orders = await getCollection(K_ORDERS);
  const number = await nextOrderNumber();
  const loads = computeLoads(n, settings.piecesPerLoad);

  const order = {
    id: newId('ord'),
    publicId: newId('pub'),
    number,
    guestName: String(guestName).trim(),
    guestEmail: String(guestEmail).trim().toLowerCase(),
    items: n,
    loads,
    status: 'new',
    room: '',
    pickupAt: null,
    price: null,
    paymentStatus: 'unpaid', // unpaid | paid
    paymentMethod: null, // cash | card
    note: note ? String(note).slice(0, 500) : '',
    messages: [],
    logs: [],
    createdAt: nowIso(),
    acceptedAt: null,
    updatedAt: nowIso(),
  };
  addLog(order, { name: order.guestName, role: 'guest' }, 'placed', `Guest placed order: ${n} item(s)`);
  orders.push(order);
  await saveCollection(K_ORDERS, orders);
  return publicOrder(order);
}

export async function listOrders({ status, from, to } = {}) {
  const orders = await getCollection(K_ORDERS);
  let list = orders;
  if (status) list = list.filter((o) => o.status === status);
  if (from) list = list.filter((o) => new Date(o.createdAt) >= new Date(from));
  if (to) list = list.filter((o) => new Date(o.createdAt) <= new Date(to));
  return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(publicOrder);
}

export async function getOrder(id) {
  const orders = await getCollection(K_ORDERS);
  const o = orders.find((x) => x.id === id);
  return o ? publicOrder(o) : null;
}

export async function getOrderByPublicId(publicId) {
  const orders = await getCollection(K_ORDERS);
  const o = orders.find((x) => x.publicId === publicId);
  return o ? publicOrder(o) : null;
}

export async function acceptOrder(id, data, actor) {
  const settings = await getSettings();
  return mutateOrder(id, async (o) => {
    if (o.status !== 'new') throw httpError(409, `Order already ${o.status}`);
    o.status = 'accepted';
    o.acceptedAt = nowIso();
    o.room = data.room ? String(data.room).trim() : o.room;
    o.loads = computeLoads(o.items, settings.piecesPerLoad);
    o.price = data.price != null && data.price !== ''
      ? Math.max(0, Number(data.price))
      : o.loads * settings.pricePerLoad;
    // Default pickup = now + turnaround, unless reception picked one.
    o.pickupAt = data.pickupAt || new Date(Date.now() + settings.turnaroundHours * 3600000).toISOString();
    if (data.paymentStatus === 'paid') {
      o.paymentStatus = 'paid';
      o.paymentMethod = data.paymentMethod === 'card' ? 'card' : 'cash';
      o.paidAt = nowIso();
    } else {
      o.paymentStatus = 'unpaid';
      o.paymentMethod = null;
    }
    addLog(o, actor, 'accepted',
      `Accepted · room ${o.room || '—'} · ${o.price} · ${o.paymentStatus}${o.paymentMethod ? ' (' + o.paymentMethod + ')' : ''} · ready by ${o.pickupAt}`);
    await notifyGuest('accepted', o, settings);
    return o;
  });
}

export async function advanceStatus(id, target, actor) {
  const settings = await getSettings();
  return mutateOrder(id, async (o) => {
    const expected = FLOW[o.status];
    if (!expected) throw httpError(409, `Cannot advance from ${o.status}`);
    if (target && target !== expected) throw httpError(400, `Next stage must be ${expected}`);
    o.status = expected;
    if (expected === 'completed') o.completedAt = nowIso();
    addLog(o, actor, 'status', `Status → ${expected}`);
    if (['cleaning', 'ready', 'completed'].includes(expected)) {
      await notifyGuest(expected, o, settings);
    }
    return o;
  });
}

export async function modifyOrder(id, patch, actor) {
  const settings = await getSettings();
  return mutateOrder(id, async (o) => {
    const changes = [];
    const set = (field, val, label) => {
      if (val != null && String(val) !== String(o[field] ?? '')) {
        changes.push(`${label}: ${o[field] ?? '—'} → ${val}`);
        o[field] = val;
      }
    };
    if (patch.room != null) set('room', String(patch.room).trim(), 'room');
    if (patch.items != null) {
      const n = Math.max(1, Math.floor(Number(patch.items)));
      set('items', n, 'items');
      o.loads = computeLoads(o.items, settings.piecesPerLoad);
    }
    if (patch.price != null && patch.price !== '') set('price', Math.max(0, Number(patch.price)), 'price');
    if (patch.pickupAt != null) set('pickupAt', patch.pickupAt, 'pickup');
    if (patch.paymentStatus != null) {
      set('paymentStatus', patch.paymentStatus === 'paid' ? 'paid' : 'unpaid', 'payment');
      o.paymentMethod = o.paymentStatus === 'paid'
        ? (patch.paymentMethod === 'card' ? 'card' : 'cash')
        : null;
      if (o.paymentStatus === 'paid' && !o.paidAt) o.paidAt = nowIso();
    }
    if (changes.length) addLog(o, actor, 'modified', changes.join(' · '));
    return o;
  });
}

export async function cancelOrder(id, actor, reason) {
  return mutateOrder(id, async (o) => {
    if (o.status === 'completed') throw httpError(409, 'Completed orders cannot be cancelled');
    o.status = 'cancelled';
    addLog(o, actor, 'cancelled', reason ? `Cancelled: ${reason}` : 'Cancelled');
    return o;
  });
}

// ------------------------------------------------------------------ Messages --
export async function guestSendMessage(publicId, text) {
  const clean = String(text || '').trim();
  if (!clean) throw httpError(400, 'Message cannot be empty');
  const orders = await getCollection(K_ORDERS);
  const o = orders.find((x) => x.publicId === publicId);
  if (!o) throw httpError(404, 'Order not found');
  o.messages.push({ id: newId('msg'), sender: 'guest', text: clean.slice(0, 1000), at: nowIso(), readByStaff: false });
  o.updatedAt = nowIso();
  await saveCollection(K_ORDERS, orders);
  return publicOrder(o);
}

export async function staffReply(id, text, actor) {
  const clean = String(text || '').trim();
  if (!clean) throw httpError(400, 'Message cannot be empty');
  const settings = await getSettings();
  return mutateOrder(id, async (o) => {
    o.messages.push({ id: newId('msg'), sender: 'staff', staffName: actor?.name || 'Reception', text: clean.slice(0, 1000), at: nowIso(), readByStaff: true });
    o.messages.forEach((m) => { if (m.sender === 'guest') m.readByStaff = true; });
    addLog(o, actor, 'message', 'Replied to guest');
    const withReply = { ...o, _lastReply: clean };
    await notifyGuest('reply', withReply, settings);
    return o;
  });
}

export async function markThreadRead(id) {
  return mutateOrder(id, async (o) => {
    o.messages.forEach((m) => { if (m.sender === 'guest') m.readByStaff = true; });
    return o;
  });
}

export async function listThreads() {
  const orders = await getCollection(K_ORDERS);
  return orders
    .filter((o) => o.messages && o.messages.length)
    .map((o) => ({
      id: o.id,
      publicId: o.publicId,
      number: o.number,
      guestName: o.guestName,
      status: o.status,
      lastMessage: o.messages[o.messages.length - 1],
      unread: o.messages.filter((m) => m.sender === 'guest' && !m.readByStaff).length,
      messages: o.messages,
    }))
    .sort((a, b) => new Date(b.lastMessage.at) - new Date(a.lastMessage.at));
}

// ------------------------------------------------------------------- Reports --
export async function revenueReport({ from, to } = {}) {
  const settings = await getSettings();
  const orders = await getCollection(K_ORDERS);
  const fromD = from ? new Date(from) : new Date(0);
  const toD = to ? new Date(to) : new Date(8640000000000000);

  // Revenue is recognised on orders that were accepted (have a price) within range,
  // excluding cancelled. We use acceptedAt as the revenue date.
  const inRange = orders.filter((o) => {
    if (o.status === 'cancelled' || o.status === 'new') return false;
    const d = new Date(o.acceptedAt || o.createdAt);
    return d >= fromD && d <= toD;
  });

  const revenue = sum(inRange.map((o) => Number(o.price) || 0));
  const paid = inRange.filter((o) => o.paymentStatus === 'paid');
  const unpaid = inRange.filter((o) => o.paymentStatus !== 'paid');
  const byMethod = {
    cash: sum(paid.filter((o) => o.paymentMethod === 'cash').map((o) => Number(o.price) || 0)),
    card: sum(paid.filter((o) => o.paymentMethod === 'card').map((o) => Number(o.price) || 0)),
  };
  const totalItems = sum(inRange.map((o) => o.items));
  const totalLoads = sum(inRange.map((o) => o.loads));

  // Daily breakdown.
  const byDayMap = {};
  for (const o of inRange) {
    const day = (o.acceptedAt || o.createdAt).slice(0, 10);
    if (!byDayMap[day]) byDayMap[day] = { date: day, orders: 0, revenue: 0, loads: 0, items: 0 };
    byDayMap[day].orders += 1;
    byDayMap[day].revenue += Number(o.price) || 0;
    byDayMap[day].loads += o.loads;
    byDayMap[day].items += o.items;
  }
  const byDay = Object.values(byDayMap).sort((a, b) => a.date.localeCompare(b.date));

  return {
    currency: settings.currency,
    range: { from: from || null, to: to || null },
    totals: {
      orders: inRange.length,
      revenue: round2(revenue),
      collected: round2(sum(paid.map((o) => Number(o.price) || 0))),
      outstanding: round2(sum(unpaid.map((o) => Number(o.price) || 0))),
      items: totalItems,
      loads: totalLoads,
      avgOrderValue: inRange.length ? round2(revenue / inRange.length) : 0,
      paidCount: paid.length,
      unpaidCount: unpaid.length,
    },
    byMethod: { cash: round2(byMethod.cash), card: round2(byMethod.card) },
    byDay,
    orders: inRange.map(publicOrder),
  };
}

export function reportToCsv(report) {
  const cur = report.currency?.code || '';
  const lines = [];
  lines.push(`Revenue Report,${report.range.from || 'all'},to,${report.range.to || 'all'}`);
  lines.push('');
  lines.push('Metric,Value');
  lines.push(`Total orders,${report.totals.orders}`);
  lines.push(`Total revenue (${cur}),${report.totals.revenue}`);
  lines.push(`Collected (${cur}),${report.totals.collected}`);
  lines.push(`Outstanding (${cur}),${report.totals.outstanding}`);
  lines.push(`Cash (${cur}),${report.byMethod.cash}`);
  lines.push(`Card (${cur}),${report.byMethod.card}`);
  lines.push(`Total items,${report.totals.items}`);
  lines.push(`Total loads,${report.totals.loads}`);
  lines.push(`Average order value (${cur}),${report.totals.avgOrderValue}`);
  lines.push('');
  lines.push('Daily breakdown');
  lines.push('Date,Orders,Loads,Items,Revenue');
  report.byDay.forEach((d) => lines.push(`${d.date},${d.orders},${d.loads},${d.items},${round2(d.revenue)}`));
  lines.push('');
  lines.push('Orders');
  lines.push('Number,Date,Guest,Room,Items,Loads,Price,Payment,Method,Status');
  report.orders.forEach((o) => {
    lines.push([
      o.number, (o.acceptedAt || o.createdAt).slice(0, 16).replace('T', ' '),
      csv(o.guestName), csv(o.room), o.items, o.loads, o.price ?? '',
      o.paymentStatus, o.paymentMethod || '', o.status,
    ].join(','));
  });
  return lines.join('\n');
}

// ------------------------------------------------------- Stuck-order detection
export async function findStuckOrders(settings) {
  const s = settings || (await getSettings());
  const orders = await getCollection(K_ORDERS);
  const cutoff = Date.now() - s.stuckThresholdHours * 3600000;
  return orders.filter(
    (o) => o.status === 'accepted' && o.acceptedAt && new Date(o.acceptedAt).getTime() < cutoff && !o.stuckAlertedAt,
  );
}

export async function markStuckAlerted(ids) {
  const orders = await getCollection(K_ORDERS);
  const set = new Set(ids);
  orders.forEach((o) => { if (set.has(o.id)) o.stuckAlertedAt = nowIso(); });
  await saveCollection(K_ORDERS, orders);
}

// -------------------------------------------------------------- internals ----
async function mutateOrder(id, fn) {
  const orders = await getCollection(K_ORDERS);
  const o = orders.find((x) => x.id === id);
  if (!o) throw httpError(404, 'Order not found');
  const result = await fn(o);
  o.updatedAt = nowIso();
  await saveCollection(K_ORDERS, orders);
  return publicOrder(result || o);
}

async function notifyGuest(kind, order, settings) {
  try {
    const { subject, html } = orderEmail(kind, order, settings);
    const r = await sendEmail({ to: order.guestEmail, subject, html });
    order.logs.push({ id: newId('log'), at: nowIso(), actor: 'system', role: 'system', action: 'email', detail: `Sent "${kind}" email${r.dryRun ? ' (dry-run)' : ''}` });
  } catch (err) {
    order.logs.push({ id: newId('log'), at: nowIso(), actor: 'system', role: 'system', action: 'email-error', detail: String(err.message || err) });
  }
}

function addLog(order, actor, action, detail) {
  order.logs = order.logs || [];
  order.logs.push({
    id: newId('log'), at: nowIso(),
    actor: actor?.name || 'system', role: actor?.role || 'system',
    actorId: actor?.id || null, action, detail,
  });
}

async function nextOrderNumber() {
  const meta = (await readJSON(K_META, { orderSeq: 1000 })) || { orderSeq: 1000 };
  meta.orderSeq = (meta.orderSeq || 1000) + 1;
  await writeJSON(K_META, meta);
  return meta.orderSeq;
}

async function pinInUse(pin, cashiers, exceptId) {
  return cashiers.some((c) => c.id !== exceptId && verifyPin(String(pin), c.salt, c.hash));
}

function publicCashier(c) {
  return { id: c.id, name: c.name, role: c.role, permissions: c.role === 'admin' ? {} : c.permissions, active: c.active, createdAt: c.createdAt };
}

function publicOrder(o) {
  const { ...rest } = o;
  return rest;
}

function validatePin(pin) {
  if (!/^\d{4,8}$/.test(String(pin || ''))) throw httpError(400, 'PIN must be 4–8 digits');
}
function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
}
export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
function nowIso() { return new Date().toISOString(); }
function sum(arr) { return arr.reduce((a, b) => a + (Number(b) || 0), 0); }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function csv(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
