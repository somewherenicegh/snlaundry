// Web Push (VAPID) delivery. Subscriptions are stored in the same blob store.
// If VAPID keys aren't configured (or web-push isn't installed), everything is a
// graceful no-op so the rest of the app keeps working.

import { getCollection, saveCollection } from './store.js';
import { newId } from './auth.js';

const K_SUBS = 'push_subscriptions';

export function vapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export async function addSubscription(subscription) {
  if (!subscription || !subscription.endpoint) return { ok: false };
  const subs = await getCollection(K_SUBS);
  if (subs.some((s) => s.subscription.endpoint === subscription.endpoint)) return { ok: true, existing: true };
  subs.push({ id: newId('sub'), subscription, at: new Date().toISOString() });
  await saveCollection(K_SUBS, subs);
  return { ok: true };
}

export async function removeSubscription(endpoint) {
  const subs = await getCollection(K_SUBS);
  await saveCollection(K_SUBS, subs.filter((s) => s.subscription.endpoint !== endpoint));
  return { ok: true };
}

export async function subscriptionCount() {
  return (await getCollection(K_SUBS)).length;
}

export async function sendPushToAll(payload) {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:laundry@example.com';
  if (!pub || !priv) return { ok: false, skipped: 'no VAPID keys' };

  const subs = await getCollection(K_SUBS);
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
  if (dead.length) await saveCollection(K_SUBS, subs.filter((s) => !dead.includes(s.id)));
  return { ok: true, sent: subs.length - dead.length };
}
