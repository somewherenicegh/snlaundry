// Scheduled function (see netlify.toml schedule). Every run it checks for orders
// that have been sitting at "accepted" for longer than the admin-set threshold
// (default 4h) and haven't yet been alerted, then emails admin + reception once.

import { getSettings, findStuckOrders, markStuckAlerted } from './lib/logic.js';
import { sendEmail, stuckAlertEmail } from './lib/email.js';

export async function runStuckCheck() {
  const settings = await getSettings();
  const stuck = await findStuckOrders(settings);
  if (!stuck.length) return { alerted: 0 };

  const recipients = [settings.adminEmail, settings.receptionEmail].filter(Boolean);
  if (recipients.length) {
    const { subject, html } = stuckAlertEmail(stuck, settings, settings.stuckThresholdHours);
    for (const to of recipients) {
      await sendEmail({ to, subject, html });
    }
  }
  await markStuckAlerted(stuck.map((o) => o.id));
  return { alerted: stuck.length, recipients };
}

export const handler = async () => {
  try {
    const result = await runStuckCheck();
    console.log('[stuck-check]', JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error('[stuck-check] error', err);
    return { statusCode: 500, body: String(err) };
  }
};
