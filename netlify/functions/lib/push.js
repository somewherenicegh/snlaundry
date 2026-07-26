// Web Push (VAPID) delivery. Subscriptions are stored in the blob store, each with
// a friendly label, the role of whoever registered it, and a per-device flag for
// whether it should receive the "open shift" reminder when the app is closed.
//
// If VAPID keys aren't configured (or web-push isn't installed), everything is a
// graceful no-op so the rest of the app keeps working.

import { getCollection, saveCollection } from './store.js';
import { newId } from './auth.js';

const K_SUBS = 'push_subscriptions';

export function vapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export async function addSubscription(subscription, meta = {}) {
  if (!subscription || !subscription.endpoint) return { ok: false };
  const subs = await getCollection(K_SUBS);
  const existing = subs.find((s) => s.subscription.endpoint === subscription.endpoint);
  if (existing) {
    existing.label = meta.label || existing.label;
    existing.role = meta.role || existing.role;
    existing.seenAt = new Date().toISOString();
    await saveCollection(K_SUBS, subs);
    return { ok: true, existing: true, id: existing.id };
  }
  const rec = {
    id: newId('sub'),
    subscription,
    label: meta.label || 'Device',
    role: meta.role || 'staff',
    shiftReminders: false, // admin opts a device in for closed-app shift reminders
    at: new Date().toISOString(),
    seenAt: new Date().toISOString(),
  };
  subs.push(rec);
  await saveCollection(K_SUBS, subs);
  return { ok: true, id: rec.id };
}

export async function removeSubscription(endpoint) {
  const subs = await getCollection(K_SUBS);
  await saveCollection(K_SUBS, subs.filter((s) => s.subscription.endpoint !== endpoint));
  return { ok: true };
}

export async function removeSubscriptionById(id) {
  const subs = await getCollection(K_SUBS);
  await saveCollection(K_SUBS, subs.filter((s) => s.id !== id));
  return { ok: true };
}

export async function updateSubscription(id, patch) {
  const subs = await getCollection(K_SUBS);
  const s = subs.find((x) => x.id === id);
  if (!s) return { ok: false };
  if (patch.shiftReminders != null) s.shiftReminders = !!patch.shiftReminders;
  if (patch.label != null) s.label = String(patch.label).slice(0, 80);
  await saveCollection(K_SUBS, subs);
  return { ok: true, device: publicDevice(s) };
}

export async function listDevices() {
  return (await getCollection(K_SUBS)).map(publicDevice);
}

function publicDevice(s) {
  return { id: s.id, label: s.label, role: s.role, shiftReminders: !!s.shiftReminders, at: s.at, seenAt: s.seenAt };
}

// Send to every subscription matching filter (default: all).
export async function sendPushTo(payload, filter = () => true) {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:laundry@example.com';
  if (!pub || !priv) return { ok: false, skipped: 'no VAPID keys' };

  const all = await getCollection(K_SUBS);
  const subs = all.filter(filter);
  if (!subs.length) return { ok: true, sent: 0 };

  let webpush;
  try { webpush = (await import('web-push')).default; }
  catch { return { ok: false, skipped: 'web-push not installed' }; }
  webpush.setVapidDetails(subject, pub, priv);

  const dead = [];
  await Promise.all(subs.map(async (s) => {
    try { await webpush.sendNotification(s.subscription, JSON.stringify(payload)); }
    catch (err) { if (err && (err.statusCode === 410 || err.statusCode === 404)) dead.push(s.id); }
  }));
  if (dead.length) await saveCollection(K_SUBS, all.filter((s) => !dead.includes(s.id)));
  return { ok: true, sent: subs.length - dead.length };
}

export async function sendPushToAll(payload) {
  return sendPushTo(payload, () => true);
}
