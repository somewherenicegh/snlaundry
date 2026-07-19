// Core business logic. Pure-ish functions over the storage layer so they can be
// unit-tested directly without HTTP.

import { readJSON, writeJSON, getCollection, saveCollection } from './store.js';
import {
  hashPin, verifyPin, signToken, defaultCashierPermissions, newId,
} from './auth.js';
import { sendEmail, orderEmail } from './email.js';
import { sendPushToAll } from './push.js';

const K_SETTINGS = 'settings';
const K_CASHIERS = 'cashiers';
const K_ORDERS = 'orders';
const K_META = 'meta';
const K_SHIFTS = 'shifts';

export const STATUSES = ['new', 'accepted', 'cleaning', 'ready', 'completed', 'cancelled'];
const FLOW = { accepted: 'cleaning', cleaning: 'ready', ready: 'completed' };
const REVERSE = { completed: 'ready', ready: 'cleaning', cleaning: 'accepted' };

// Which staff-attribution field records each stage transition.
const STAGE_ACTOR_FIELD = { accepted: 'acceptedBy', cleaning: 'cleaningBy', ready: 'readyBy', completed: 'completedBy' };

// Reception shift windows (local time). AM 06:00–13:59, PM 14:00–21:59, Night 22:00–05:59.
export function shiftOf(date) {
  const h = new Date(date).getHours();
  if (h >= 6 && h < 14) return 'AM';
  if (h >= 14 && h < 22) return 'PM';
  return 'Night';
}

// ---------------------------------------------------------------- Settings ---
export function defaultSettings() {
  return {
    hostelName: 'somewhere nice',
    logoDataUrl: '',
    accentColor: '#0f766e',
    hoverColor: '#FFF8ED',
    currency: { code: 'GHS', symbol: '₵' },
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

export async function createOrder({ guestName, guestEmail, items, note, paymentTiming, paymentMethod }) {
  if (!guestName || !String(guestName).trim()) throw httpError(400, 'Name is required');
  if (!validEmail(guestEmail)) throw httpError(400, 'A valid email is required');
  const n = Math.floor(Number(items));
  if (!n || n < 1) throw httpError(400, 'Number of items must be at least 1');

  // Payment preference chosen by the guest at order time.
  const timing = paymentTiming === 'now' ? 'now' : 'pickup';
  const method = timing === 'now' ? (paymentMethod === 'card' ? 'card' : 'cash') : null;

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
    paymentTiming: timing, // 'now' | 'pickup'  (guest's choice)
    paymentMethod: method, // 'cash' | 'card' | null (guest's choice when paying now)
    paymentStatus: 'unpaid', // unpaid | paid (reception records actual collection)
    paidBy: null,
    paidAt: null,
    paidShiftId: null,
    // staff attribution, filled as the order progresses
    acceptedBy: null,
    cleaningBy: null,
    readyBy: null,
    completedBy: null,
    note: note ? String(note).slice(0, 500) : '',
    messages: [],
    logs: [],
    createdAt: nowIso(),
    acceptedAt: null,
    updatedAt: nowIso(),
  };
  addLog(order, { name: order.guestName, role: 'guest' }, 'placed',
    `Placed ${n} item(s) · ${timing === 'now' ? 'pay now (' + method + ')' : 'pay at pickup'}`);
  orders.push(order);
  await saveCollection(K_ORDERS, orders);
  try { await sendPushToAll({ title: 'New laundry order', body: `#${number} · ${order.guestName} · ${n} item(s)`, url: '/app', tag: 'order-' + number }); } catch {}
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
    o.acceptedBy = actorRef(actor);
    o.room = data.room ? String(data.room).trim() : o.room;
    o.loads = computeLoads(o.items, settings.piecesPerLoad);
    o.price = data.price != null && data.price !== ''
      ? Math.max(0, Number(data.price))
      : o.loads * settings.pricePerLoad;
    // Default pickup = now + turnaround, unless reception picked one.
    o.pickupAt = data.pickupAt || new Date(Date.now() + settings.turnaroundHours * 3600000).toISOString();
    addLog(o, actor, 'accepted',
      `Accepted · room ${o.room || '—'} · ${settings.currency.symbol}${o.price} · ready by ${o.pickupAt}`);
    // Reception may collect payment right at acceptance.
    if (data.paymentStatus === 'paid') {
      await applyPayment(o, data.paymentMethod, actor);
    }
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
    // An order cannot be picked up (completed) before it has been paid.
    if (expected === 'completed' && o.paymentStatus !== 'paid') {
      throw httpError(409, 'Payment must be collected before the order can be marked picked up.');
    }
    o.status = expected;
    if (STAGE_ACTOR_FIELD[expected]) o[STAGE_ACTOR_FIELD[expected]] = actorRef(actor);
    if (expected === 'completed') o.completedAt = nowIso();
    addLog(o, actor, 'status', `Status → ${expected}`);
    if (['cleaning', 'ready', 'completed'].includes(expected)) {
      await notifyGuest(expected, o, settings);
    }
    return o;
  });
}

// Move an order one stage backwards (e.g. ready → cleaning). Permission-gated at API.
export async function revertStatus(id, actor, reason) {
  return mutateOrder(id, async (o) => {
    const prev = REVERSE[o.status];
    if (!prev) throw httpError(409, `Cannot move ${o.status} backwards`);
    const from = o.status;
    o.status = prev;
    if (from === 'completed') o.completedAt = null;
    addLog(o, actor, 'reverted', `Moved back ${from} → ${prev}${reason ? ' · ' + reason : ''}`);
    return o;
  });
}

// Record that payment was collected. Used at acceptance or later.
export async function recordPayment(id, method, actor) {
  return mutateOrder(id, async (o) => {
    if (o.paymentStatus === 'paid') throw httpError(409, 'Order is already paid');
    await applyPayment(o, method, actor);
    return o;
  });
}

async function applyPayment(o, method, actor) {
  o.paymentStatus = 'paid';
  o.paymentMethod = method === 'card' ? 'card' : (method === 'cash' ? 'cash' : (o.paymentMethod || 'cash'));
  o.paidAt = nowIso();
  o.paidBy = actorRef(actor);
  const shift = actor?.id ? await getOpenShiftFor(actor.id) : null;
  o.paidShiftId = shift ? shift.id : null;
  addLog(o, actor, 'payment', `Payment received · ${o.paymentMethod}${shift ? ' · shift ' + shift.type : ''}`);
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
    if (patch.paymentTiming != null) set('paymentTiming', patch.paymentTiming === 'now' ? 'now' : 'pickup', 'timing');
    if (patch.paymentStatus != null) {
      if (patch.paymentStatus === 'paid' && o.paymentStatus !== 'paid') {
        await applyPayment(o, patch.paymentMethod, actor);
        changes.push('payment: unpaid → paid');
      } else if (patch.paymentStatus !== 'paid' && o.paymentStatus === 'paid') {
        o.paymentStatus = 'unpaid'; o.paidAt = null; o.paidBy = null; o.paidShiftId = null;
        changes.push('payment: paid → unpaid');
      }
    }
    if (changes.length) addLog(o, actor, 'modified', changes.join(' · '));
    return o;
  });
}

// Admin-only bulk delete: permanently remove orders created within a date range.
export async function deleteOrdersInRange({ from, to } = {}) {
  const orders = await getCollection(K_ORDERS);
  const fromD = from ? new Date(from) : new Date(0);
  const toD = to ? new Date(to) : new Date(8640000000000000);
  const keep = orders.filter((o) => {
    const d = new Date(o.createdAt);
    return !(d >= fromD && d <= toD);
  });
  const removed = orders.length - keep.length;
  await saveCollection(K_ORDERS, keep);
  return { removed, remaining: keep.length };
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
  try { await sendPushToAll({ title: 'New guest message', body: `${o.guestName} · order #${o.number}`, url: '/app', tag: 'msg-' + o.number }); } catch {}
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

  // Shift breakdown — categorized by the time the order was accepted.
  const byShift = { AM: shiftBucket('AM'), PM: shiftBucket('PM'), Night: shiftBucket('Night') };
  for (const o of inRange) {
    const s = byShift[shiftOf(o.acceptedAt || o.createdAt)];
    s.orders += 1; s.revenue += Number(o.price) || 0; s.loads += o.loads;
    if (o.paymentStatus === 'paid') s.collected += Number(o.price) || 0;
  }
  Object.values(byShift).forEach((s) => { s.revenue = round2(s.revenue); s.collected = round2(s.collected); });

  // Staff activity — who did what, and cash collected by whom.
  const staff = {};
  const bump = (ref, field, amount = 0) => {
    if (!ref || !ref.name) return;
    const k = ref.id || ref.name;
    if (!staff[k]) staff[k] = { name: ref.name, accepted: 0, cleaned: 0, ready: 0, completed: 0, payments: 0, collected: 0 };
    staff[k][field] += 1;
    if (amount) staff[k].collected += amount;
  };
  for (const o of inRange) {
    bump(o.acceptedBy, 'accepted');
    bump(o.cleaningBy, 'cleaned');
    bump(o.readyBy, 'ready');
    bump(o.completedBy, 'completed');
    if (o.paymentStatus === 'paid' && o.paidBy) bump(o.paidBy, 'payments', Number(o.price) || 0);
  }
  const byStaff = Object.values(staff).map((s) => ({ ...s, collected: round2(s.collected) }))
    .sort((a, b) => b.collected - a.collected);

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
    byShift,
    byStaff,
    orders: inRange.map((o) => ({ ...publicOrder(o), shift: shiftOf(o.acceptedAt || o.createdAt) })),
  };
}

function shiftBucket() { return { orders: 0, revenue: 0, collected: 0, loads: 0 }; }

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
  lines.push('By shift');
  lines.push('Shift,Orders,Loads,Revenue,Collected');
  ['AM', 'PM', 'Night'].forEach((s) => {
    const b = report.byShift[s];
    lines.push(`${s} (${SHIFT_LABEL[s]}),${b.orders},${b.loads},${b.revenue},${b.collected}`);
  });
  lines.push('');
  lines.push('By staff');
  lines.push('Staff,Accepted,Cleaned,Ready,Completed,Payments,Cash+Card collected');
  (report.byStaff || []).forEach((s) => {
    lines.push(`${csv(s.name)},${s.accepted},${s.cleaned},${s.ready},${s.completed},${s.payments},${s.collected}`);
  });
  lines.push('');
  lines.push('Orders');
  lines.push('Number,Date,Shift,Guest,Room,Items,Loads,Price,Payment,Method,Accepted by,Cleaned by,Ready by,Completed by,Paid by,Status');
  report.orders.forEach((o) => {
    lines.push([
      o.number, (o.acceptedAt || o.createdAt).slice(0, 16).replace('T', ' '), o.shift,
      csv(o.guestName), csv(o.room), o.items, o.loads, o.price ?? '',
      o.paymentStatus, o.paymentMethod || '',
      csv(nameOf(o.acceptedBy)), csv(nameOf(o.cleaningBy)), csv(nameOf(o.readyBy)),
      csv(nameOf(o.completedBy)), csv(nameOf(o.paidBy)), o.status,
    ].join(','));
  });
  return lines.join('\n');
}

const SHIFT_LABEL = { AM: '06:00–14:00', PM: '14:00–22:00', Night: '22:00–06:00' };
function nameOf(ref) { return ref && ref.name ? ref.name : ''; }

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

// -------------------------------------------------------------- Shifts -------
// A shift is a reception handover session. At open and close the cashier confirms
// the laundry that is in progress and acknowledges they've physically checked the
// laundry area. (No cash counting.)
export async function getOpenShiftFor(cashierId) {
  const shifts = await getCollection(K_SHIFTS);
  return shifts.find((s) => s.cashierId === cashierId && s.status === 'open') || null;
}

// Orders currently in the laundry area (accepted / cleaning / ready), incl. payment.
async function inProgressOrders() {
  const orders = await getCollection(K_ORDERS);
  return orders
    .filter((o) => ['accepted', 'cleaning', 'ready'].includes(o.status))
    .map((o) => ({ id: o.id, number: o.number, guestName: o.guestName, room: o.room, status: o.status, items: o.items, loads: o.loads, paymentStatus: o.paymentStatus, price: o.price }));
}

export async function openShift({ type, note, acknowledged, confirmedOrderIds, handover }, actor) {
  if (!actor?.id) throw httpError(401, 'Sign in first');
  const mineOpen = await getOpenShiftFor(actor.id);
  if (mineOpen && !handover) throw httpError(409, 'You already have an open shift — close it first.');
  if (!acknowledged) throw httpError(400, 'Please confirm you have checked the laundry area and the items are present.');
  const inProgress = await inProgressOrders();
  const shifts = await getCollection(K_SHIFTS);
  // Single reception: starting a shift auto-closes any other still-open shift (handover).
  shifts.forEach((s) => {
    if (s.status === 'open') {
      s.status = 'closed'; s.closedAt = nowIso();
      s.closingNote = s.closingNote || 'Closed at shift handover';
      s.closingInProgress = inProgress.length;
    }
  });
  const shift = {
    id: newId('shf'),
    cashierId: actor.id,
    cashierName: actor.name,
    type: ['AM', 'PM', 'Night'].includes(type) ? type : shiftOf(new Date()),
    openingNote: note ? String(note).slice(0, 300) : '',
    openingInProgress: inProgress.length,
    openingAcknowledged: true,
    openingConfirmedIds: Array.isArray(confirmedOrderIds) ? confirmedOrderIds : inProgress.map((o) => o.id),
    openedAt: nowIso(),
    status: 'open',
    closedAt: null,
    closingNote: '',
    acknowledged: false,
    confirmedOrderIds: [],
    closingInProgress: null,
  };
  shifts.push(shift);
  await saveCollection(K_SHIFTS, shifts);
  return shift;
}

export async function closeShift({ note, acknowledged, confirmedOrderIds }, actor) {
  const shifts = await getCollection(K_SHIFTS);
  const shift = shifts.find((s) => s.cashierId === actor.id && s.status === 'open');
  if (!shift) throw httpError(404, 'You have no open shift.');
  if (!acknowledged) throw httpError(400, 'Please confirm you have checked the laundry area and the items are present.');
  const inProgress = await inProgressOrders();
  shift.status = 'closed';
  shift.closedAt = nowIso();
  shift.closingNote = note ? String(note).slice(0, 300) : '';
  shift.acknowledged = true;
  shift.confirmedOrderIds = Array.isArray(confirmedOrderIds) ? confirmedOrderIds : inProgress.map((o) => o.id);
  shift.closingInProgress = inProgress.length;
  await saveCollection(K_SHIFTS, shifts);
  return shift;
}

export async function listShifts({ from, to } = {}) {
  const shifts = await getCollection(K_SHIFTS);
  const fromD = from ? new Date(from) : new Date(0);
  const toD = to ? new Date(to) : new Date(8640000000000000);
  return shifts
    .filter((s) => { const d = new Date(s.openedAt); return d >= fromD && d <= toD; })
    .sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
}

export async function currentShiftView(actor) {
  const inProgress = await inProgressOrders();
  const shift = actor?.id ? await getOpenShiftFor(actor.id) : null;
  if (!shift) return { open: false, inProgress };
  return { open: true, shift, inProgress };
}

// -------------------------------------------------------------- internals ----
function actorRef(actor) {
  return actor ? { id: actor.id || null, name: actor.name || 'system', role: actor.role || 'system' } : null;
}

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
