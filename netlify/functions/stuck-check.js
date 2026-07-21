// Scheduled function (see netlify.toml). Every run it looks for laundry that needs
// a follow-up — orders sitting at "accepted" past the follow-up window, or orders
// whose pickup time has passed — and reminds staff by email + push. It respects the
// admin-set quiet hours and repeat interval, and repeats the reminder until the
// order moves on.

import { getSettings, findFollowUpOrders, markFollowedUp } from './lib/logic.js';
import { sendEmail, followUpEmail } from './lib/email.js';
import { sendPushToAll } from './lib/push.js';

export async function runStuckCheck() {
  const settings = await getSettings();
  const due = await findFollowUpOrders(settings); // [] during quiet hours
  if (!due.length) return { alerted: 0 };

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

  // Push to every subscribed device (cashiers + admin).
  await sendPushToAll({
    title: 'Laundry needs follow-up',
    body: `${due.length} order(s) need attention at the laundry`,
    url: '/app',
    tag: 'follow-up',
  });

  await markFollowedUp(due.map((o) => o.id));
  return { alerted: due.length, recipients };
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
