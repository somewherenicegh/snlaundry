// Email delivery. Chooses a backend based on which env vars are set:
//   1. Gmail SMTP  — if GMAIL_USER + GMAIL_APP_PASSWORD are set (uses nodemailer)
//   2. Resend      — if RESEND_API_KEY is set
//   3. Dry-run     — otherwise: logged/recorded but not actually sent (local/tests)

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

let _sentLog = []; // in-memory record, useful for tests

export function sentLog() {
  return _sentLog;
}
export function clearSentLog() {
  _sentLog = [];
}

export async function sendEmail({ to, subject, html, from }) {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  const apiKey = process.env.RESEND_API_KEY;
  const sender = from || process.env.EMAIL_FROM
    || (gmailUser ? `somewhere nice <${gmailUser}>` : 'Laundry <onboarding@resend.dev>');
  const record = { to, subject, from: sender, at: new Date().toISOString() };

  // 1) Gmail SMTP
  if (gmailUser && gmailPass) {
    try {
      const nodemailer = (await import('nodemailer')).default;
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 465, secure: true,
        auth: { user: gmailUser, pass: String(gmailPass).replace(/\s+/g, '') }, // app passwords display with spaces
      });
      const info = await transporter.sendMail({ from: sender, to, subject, html });
      record.ok = true; record.id = info.messageId; record.via = 'gmail';
      _sentLog.push(record);
      return { ok: true, id: info.messageId, via: 'gmail' };
    } catch (err) {
      record.ok = false; record.error = String(err); record.via = 'gmail';
      _sentLog.push(record);
      return { ok: false, error: String(err) };
    }
  }

  // 2) Resend
  if (apiKey) {
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: sender, to: [to], subject, html }),
      });
      const data = await res.json().catch(() => ({}));
      record.ok = res.ok; record.id = data.id; record.via = 'resend';
      if (!res.ok) record.error = data;
      _sentLog.push(record);
      return { ok: res.ok, id: data.id, error: res.ok ? undefined : data };
    } catch (err) {
      record.ok = false; record.error = String(err); record.via = 'resend';
      _sentLog.push(record);
      return { ok: false, error: String(err) };
    }
  }

  // 3) Dry-run
  record.dryRun = true;
  _sentLog.push(record);
  console.log(`[email:dry-run] to=${to} subject="${subject}"`);
  return { ok: true, dryRun: true };
}

// ---- Branded templates ----
function shell(settings, bodyHtml) {
  const name = escapeHtml(settings.hostelName || 'Hostel Laundry');
  const logo = settings.logoDataUrl
    ? `<img src="${settings.logoDataUrl}" alt="${name}" style="max-height:52px;margin-bottom:8px" />`
    : '';
  const accent = settings.accentColor || '#0f766e';
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <div style="text-align:center;padding:20px 0;border-bottom:3px solid ${accent}">
      ${logo}
      <div style="font-size:18px;font-weight:700;color:${accent}">${name}</div>
      <div style="font-size:12px;color:#6b7280;letter-spacing:.08em;text-transform:uppercase">Laundry Service</div>
    </div>
    <div style="padding:24px 4px;font-size:15px;line-height:1.55">${bodyHtml}</div>
    <div style="border-top:1px solid #e5e7eb;padding:14px 4px;font-size:12px;color:#9ca3af;text-align:center">
      This is an automated message from ${name}. Please do not reply directly.
    </div>
  </div>`;
}

function statusBadge(label, color) {
  return `<span style="display:inline-block;background:${color};color:#fff;font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px">${label}</span>`;
}

export function orderEmail(kind, order, settings) {
  const cur = settings.currency?.symbol || '';
  const track = settings.baseUrl
    ? `${settings.baseUrl}/track?id=${order.publicId}`
    : null;
  const trackBtn = track
    ? `<p style="text-align:center;margin:22px 0">
         <a href="${track}" style="background:${settings.accentColor || '#0f766e'};color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;display:inline-block">Track your order</a>
       </p>`
    : '';

  const details = `
    <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
      <tr><td style="padding:6px 0;color:#6b7280">Order</td><td style="padding:6px 0;text-align:right;font-weight:600">#${order.number}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280">Guest</td><td style="padding:6px 0;text-align:right">${escapeHtml(order.guestName)}</td></tr>
      ${order.room ? `<tr><td style="padding:6px 0;color:#6b7280">Room</td><td style="padding:6px 0;text-align:right">${escapeHtml(order.room)}</td></tr>` : ''}
      <tr><td style="padding:6px 0;color:#6b7280">Items</td><td style="padding:6px 0;text-align:right">${order.items} pcs · ${order.loads} load(s)</td></tr>
      ${order.price != null ? `<tr><td style="padding:6px 0;color:#6b7280">Total</td><td style="padding:6px 0;text-align:right;font-weight:700">${cur}${Number(order.price).toFixed(2)}</td></tr>` : ''}
      ${order.pickupAt ? `<tr><td style="padding:6px 0;color:#6b7280">Ready by</td><td style="padding:6px 0;text-align:right">${formatDate(order.pickupAt)}</td></tr>` : ''}
    </table>`;

  const map = {
    accepted: {
      subject: `Order #${order.number} accepted — ${settings.hostelName || 'Laundry'}`,
      body: `<p>Hi ${escapeHtml(firstName(order.guestName))},</p>
        <p>${statusBadge('Accepted', '#2563eb')} Your laundry order has been received and accepted.</p>
        ${details}
        <p>We'll let you know as soon as it moves into cleaning.</p>${trackBtn}`,
    },
    cleaning: {
      subject: `Order #${order.number} is being cleaned`,
      body: `<p>Hi ${escapeHtml(firstName(order.guestName))},</p>
        <p>${statusBadge('Cleaning', '#d97706')} Good news — your laundry is now being cleaned.</p>
        ${details}${trackBtn}`,
    },
    ready: {
      subject: `Order #${order.number} is ready for pickup 🧺`,
      body: `<p>Hi ${escapeHtml(firstName(order.guestName))},</p>
        <p>${statusBadge('Ready', '#16a34a')} Your laundry is clean and ready for pickup at reception.</p>
        ${details}
        <p>${order.paymentStatus === 'paid' ? 'Payment received — thank you!' : 'Payment will be collected at pickup.'}</p>${trackBtn}`,
    },
    completed: {
      subject: `Order #${order.number} completed — thank you!`,
      body: `<p>Hi ${escapeHtml(firstName(order.guestName))},</p>
        <p>${statusBadge('Completed', '#4b5563')} Your laundry has been picked up. Thank you for staying with us!</p>
        ${details}`,
    },
    reply: {
      subject: `New message about your order #${order.number}`,
      body: `<p>Hi ${escapeHtml(firstName(order.guestName))},</p>
        <p>Reception has replied to your message:</p>
        <blockquote style="border-left:3px solid ${settings.accentColor || '#0f766e'};margin:12px 0;padding:8px 14px;background:#f9fafb">${escapeHtml(order._lastReply || '')}</blockquote>
        ${trackBtn}`,
    },
  };

  const t = map[kind];
  if (!t) throw new Error(`Unknown email kind: ${kind}`);
  return { subject: t.subject, html: shell(settings, t.body) };
}

export function stuckAlertEmail(orders, settings, thresholdHours) {
  const rows = orders
    .map(
      (o) => `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">#${o.number}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(o.guestName)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${o.room ? escapeHtml(o.room) : '—'}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${hoursSince(o.acceptedAt)}h</td>
      </tr>`,
    )
    .join('');
  const body = `<p><strong>${orders.length} order(s)</strong> have been sitting at <b>Accepted</b> for more than ${thresholdHours}h and haven't moved to cleaning:</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:10px">
      <tr style="text-align:left;color:#6b7280"><th style="padding:6px 8px">Order</th><th style="padding:6px 8px">Guest</th><th style="padding:6px 8px">Room</th><th style="padding:6px 8px">Waiting</th></tr>
      ${rows}
    </table>
    <p style="margin-top:14px">Please progress these orders in the reception app.</p>`;
  return { subject: `⏰ ${orders.length} laundry order(s) need attention`, html: shell(settings, body) };
}

// ---- helpers ----
function firstName(name = '') {
  return String(name).trim().split(/\s+/)[0] || 'there';
}
function hoursSince(iso) {
  if (!iso) return '?';
  return Math.floor((Date.now() - new Date(iso).getTime()) / 3600000);
}
function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
export function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
