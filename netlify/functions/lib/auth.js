// Authentication + authorization.
//
// Model:
//   - The whole deployment is ONE locked terminal ("central lock-in").
//   - Each staff member (cashier/admin) has a personal PIN.
//   - Entering a PIN "switches" the active cashier and issues a short signed
//     session token — no full email/password login required.
//   - Admins can create cashiers and grant granular permissions (CleanCloud-style
//     access levels).

import crypto from 'node:crypto';

const SECRET = () => process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';

// ---- PIN hashing (salted SHA-256; PINs are short so we also rate-context them) ----
export function hashPin(pin, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.createHash('sha256').update(`${s}:${pin}`).digest('hex');
  return { salt: s, hash: h };
}

export function verifyPin(pin, salt, hash) {
  const h = crypto.createHash('sha256').update(`${salt}:${pin}`).digest('hex');
  // constant-time compare
  const a = Buffer.from(h);
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Session tokens (compact HMAC-signed, stateless) ----
export function signToken(payload, ttlSeconds = 60 * 60 * 12) {
  const body = { ...payload, exp: Date.now() + ttlSeconds * 1000 };
  const json = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET()).update(json).digest('base64url');
  return `${json}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [json, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET()).update(json).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body;
  try {
    body = JSON.parse(Buffer.from(json, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!body.exp || body.exp < Date.now()) return null;
  return body;
}

// ---- Permission catalogue (what each access level can toggle) ----
export const PERMISSIONS = {
  acceptOrders: 'Accept new guest orders',
  advanceStatus: 'Move orders forward (cleaning → ready → picked up)',
  reverseStatus: 'Move orders backward (e.g. ready → cleaning)',
  modifyAccepted: 'Edit an order after it has been accepted',
  cancelOrders: 'Cancel / delete orders',
  takePayment: 'Record payments',
  messageGuests: 'Reply to guest messages',
  viewReports: 'View revenue reports & analytics',
  exportReports: 'Export reports (CSV / PDF)',
  manageCashiers: 'Add/remove cashiers & set access levels',
  manageSettings: 'Change hostel settings (pricing, currency, logo, etc.)',
};

// Admins implicitly have everything.
export function can(user, permission) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return !!(user.permissions && user.permissions[permission]);
}

// Default permission set for a brand-new cashier (safe, minimal).
export function defaultCashierPermissions() {
  return {
    acceptOrders: true,
    advanceStatus: true,
    reverseStatus: false, // admin-granted only by default
    modifyAccepted: false, // only admins by default — matches the requirement
    cancelOrders: false,
    takePayment: true,
    messageGuests: true,
    viewReports: false,
    exportReports: false,
    manageCashiers: false,
    manageSettings: false,
  };
}

export function newId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}
