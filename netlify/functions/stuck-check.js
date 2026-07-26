// Scheduled function (see netlify.toml). Every run it looks for laundry that needs
// a follow-up — orders sitting at "accepted" past the follow-up window, or orders
// whose pickup time has passed — and reminds staff by email + push. It respects the
// admin-set quiet hours and repeat interval, and repeats the reminder until the
// order moves on.

import { getSettings, findFollowUpOrders, markFollowedUp, anyShiftOpen, getMeta, setMeta } from './lib/logic.js';
import { sendEmail, followUpEmail } from './lib/email.js';
import { sendPushToAll, sendPushTo } from './lib/push.js';

const SHIFT_REMINDER_EVERY_MS = 30 * 60000;

// The "open shift" reminder is the exception: it only pushes (when the app is
// closed) to devices an admin has flagged. Throttled to every 30 minutes.
async function shiftOpenReminder() {
  if (await anyShiftOpen()) { await setMeta({ lastShiftReminderAt: null }); return { shiftReminder: 'shift open' }; }
  const meta = await getMeta();
  const last = meta.lastShiftReminderAt ? new Date(meta.lastShiftReminderAt).getTime() : 0;
  if (Date.now() - last < SHIFT_REMINDER_EVERY_MS) return { shiftReminder: 'throttled' };
  const res = await sendPushTo(
    { title: 'Start a reception shift', body: 'No shift is currently open.', url: '/app', tag: 'shift-open' },
    (s) => s.shiftReminders,
  );
  await setMeta({ lastShiftReminderAt: new Date().toISOString() });
  return { shiftReminder: res };
}

export async function runStuckCheck() {
  const settings = await getSettings();
  const shift = await shiftOpenReminder();
  const due = await findFollowUpOrders(settings); // [] during quiet hours
  if (!due.length) return { alerted: 0, ...shift };

  // Email everyone on the alert list.
  const recipients = [...new Set(
    [settings.adminEmail, settings.receptionEmail, ...(settings.alertRecipients || [])]
      .map((e) => (e || '').trim().toLowerCase())
      .filter(Boolean),
  )];
  if (recipients.length) {
    const { subject, html } = followUpEmail(due, settings);
    for (const to of recipients) await sendEmail({ to, subject, html });
  }

  // Push to every subscribed device (cashiers + admin + laundry).
  await sendPushToAll({
    title: 'Laundry needs follow-up',
    body: `${due.length} order(s) need attention at the laundry`,
    url: '/app',
    tag: 'follow-up',
  });

  await markFollowedUp(due.map((o) => o.id));
  return { alerted: due.length, recipients, ...shift };
}

export const handler = async () => {
  try {
    const result = await runStuckCheck();
    console.log('[follow-up-check]', JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error('[follow-up-check] error', err);
    return { statusCode: 500, body: String(err) };
  }
};
