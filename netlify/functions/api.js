// Single API router for the whole app. Netlify redirects /api/* here.
//
// handleRequest() is exported separately so the test harness can drive every
// endpoint without spinning up HTTP.

import { verifyToken, can, PERMISSIONS } from './lib/auth.js';
import * as L from './lib/logic.js';
import { vapidPublicKey, addSubscription, removeSubscription } from './lib/push.js';

const json = (status, body) => ({ status, body });

function requireUser(headers) {
  const auth = headers['authorization'] || headers['Authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  const payload = verifyToken(token);
  if (!payload) throw L.httpError(401, 'Not signed in — enter your PIN.');
  return payload;
}

async function requirePerm(headers, perm) {
  const payload = requireUser(headers);
  const user = await L.getCashierById(payload.id);
  if (!user || !user.active) throw L.httpError(401, 'Session no longer valid.');
  if (!can(user, perm)) throw L.httpError(403, 'You do not have permission for this action.');
  return user;
}

async function requireAdmin(headers) {
  const payload = requireUser(headers);
  const user = await L.getCashierById(payload.id);
  if (!user || user.role !== 'admin') throw L.httpError(403, 'Admin only.');
  return user;
}

export async function handleRequest({ method, path, query = {}, body = {}, headers = {} }) {
  // Normalize: strip leading /api and split.
  const clean = path.replace(/^\/(\.netlify\/functions\/api|api)/, '').replace(/^\/+|\/+$/g, '');
  const parts = clean ? clean.split('/') : [];
  const m = method.toUpperCase();

  try {
    // ---------- meta / public ----------
    if (parts[0] === 'health') return json(200, { ok: true, storage: await (await import('./lib/store.js')).storeInfo() });

    if (parts[0] === 'status') {
      const settings = await L.getSettings();
      return json(200, { configured: settings.configured, isSetup: await L.isSetup(), hostelName: settings.hostelName });
    }

    if (parts[0] === 'setup' && m === 'POST') {
      return json(200, await L.firstRunSetup(body));
    }

    if (parts[0] === 'public-settings' && m === 'GET') {
      const s = await L.getSettings();
      return json(200, {
        hostelName: s.hostelName, logoDataUrl: s.logoDataUrl, accentColor: s.accentColor, hoverColor: s.hoverColor,
        currency: s.currency, piecesPerLoad: s.piecesPerLoad, pricePerLoad: s.pricePerLoad,
        turnaroundHours: s.turnaroundHours,
      });
    }

    // Public: the VAPID public key (needed by the browser to subscribe to push).
    if (parts[0] === 'push' && parts[1] === 'key' && m === 'GET') {
      return json(200, { key: vapidPublicKey() });
    }

    if (parts[0] === 'auth' && parts[1] === 'pin' && m === 'POST') {
      const res = await L.authenticatePin(body.pin);
      if (!res) return json(401, { error: 'Incorrect PIN' });
      return json(200, res);
    }

    // ---------- guest order endpoints (public) ----------
    if (parts[0] === 'orders' && parts[1] === 'public') {
      const publicId = parts[2];
      if (m === 'GET' && publicId) {
        const o = await L.getOrderByPublicId(publicId);
        if (!o) return json(404, { error: 'Order not found' });
        return json(200, guestView(o));
      }
      if (m === 'POST' && publicId && parts[3] === 'messages') {
        const o = await L.guestSendMessage(publicId, body.text);
        return json(200, guestView(o));
      }
    }

    if (parts[0] === 'orders' && parts.length === 1 && m === 'POST') {
      // guest places an order
      const o = await L.createOrder(body);
      return json(201, { id: o.id, publicId: o.publicId, number: o.number });
    }

    // ---------- everything below requires a signed-in cashier ----------
    if (parts[0] === 'me' && m === 'GET') {
      const payload = requireUser(headers);
      const user = await L.getCashierById(payload.id);
      if (!user) return json(401, { error: 'Session invalid' });
      return json(200, { user, permissionCatalogue: PERMISSIONS });
    }

    if (parts[0] === 'orders') {
      const id = parts[1];
      if (m === 'GET' && !id) {
        await requireUser(headers);
        return json(200, await L.listOrders(query));
      }
      if (m === 'GET' && id) {
        await requireUser(headers);
        const o = await L.getOrder(id);
        return o ? json(200, o) : json(404, { error: 'Not found' });
      }
      if (m === 'POST' && id && parts[2] === 'accept') {
        const user = await requirePerm(headers, 'acceptOrders');
        return json(200, await L.acceptOrder(id, body, user));
      }
      if (m === 'POST' && id && parts[2] === 'advance') {
        const user = await requirePerm(headers, 'advanceStatus');
        return json(200, await L.advanceStatus(id, body.target, user));
      }
      if (m === 'POST' && id && parts[2] === 'revert') {
        const user = await requirePerm(headers, 'reverseStatus');
        return json(200, await L.revertStatus(id, user, body.reason));
      }
      if (m === 'POST' && id && parts[2] === 'pay') {
        const user = await requirePerm(headers, 'takePayment');
        return json(200, await L.recordPayment(id, body.method, user));
      }
      if (m === 'PATCH' && id) {
        // Modifying an order: if it is already accepted (or beyond), require modifyAccepted.
        const existing = await L.getOrder(id);
        if (!existing) return json(404, { error: 'Not found' });
        const perm = existing.status === 'new' ? 'acceptOrders' : 'modifyAccepted';
        const user = await requirePerm(headers, perm);
        return json(200, await L.modifyOrder(id, body, user));
      }
      if (m === 'POST' && id && parts[2] === 'cancel') {
        const user = await requirePerm(headers, 'cancelOrders');
        return json(200, await L.cancelOrder(id, user, body.reason));
      }
      if (m === 'POST' && id && parts[2] === 'reply') {
        const user = await requirePerm(headers, 'messageGuests');
        return json(200, await L.staffReply(id, body.text, user));
      }
      if (m === 'POST' && id && parts[2] === 'read') {
        await requireUser(headers);
        return json(200, await L.markThreadRead(id));
      }
    }

    if (parts[0] === 'threads' && m === 'GET') {
      await requirePerm(headers, 'messageGuests');
      return json(200, await L.listThreads());
    }

    // ---------- push subscriptions ----------
    if (parts[0] === 'push') {
      if (parts[1] === 'subscribe' && m === 'POST') {
        requireUser(headers);
        return json(200, await addSubscription(body.subscription));
      }
      if (parts[1] === 'unsubscribe' && m === 'POST') {
        requireUser(headers);
        return json(200, await removeSubscription(body.endpoint));
      }
    }

    // ---------- admin: bulk delete orders in a date range ----------
    if (parts[0] === 'orders' && parts[1] === 'delete-range' && m === 'POST') {
      await requireAdmin(headers);
      return json(200, await L.deleteOrdersInRange(body));
    }

    // ---------- shifts (till sessions) ----------
    if (parts[0] === 'shifts') {
      if (m === 'GET' && parts[1] === 'current') {
        const payload = requireUser(headers);
        const user = await L.getCashierById(payload.id);
        return json(200, await L.currentShiftView(user));
      }
      if (m === 'POST' && parts[1] === 'open') {
        const payload = requireUser(headers);
        const user = await L.getCashierById(payload.id);
        return json(201, await L.openShift(body, user));
      }
      if (m === 'POST' && parts[1] === 'close') {
        const payload = requireUser(headers);
        const user = await L.getCashierById(payload.id);
        return json(200, await L.closeShift(body, user));
      }
      if (m === 'GET' && !parts[1]) {
        await requirePerm(headers, 'viewReports');
        return json(200, await L.listShifts(query));
      }
    }

    // ---------- cashiers ----------
    if (parts[0] === 'cashiers') {
      const id = parts[1];
      if (m === 'GET' && !id) { await requirePerm(headers, 'manageCashiers'); return json(200, await L.listCashiers()); }
      if (m === 'POST' && !id) { await requirePerm(headers, 'manageCashiers'); return json(201, await L.createCashier(body)); }
      if (m === 'PATCH' && id) { const u = await requirePerm(headers, 'manageCashiers'); return json(200, await L.updateCashier(id, body, u)); }
      if (m === 'DELETE' && id) { await requirePerm(headers, 'manageCashiers'); return json(200, await L.deleteCashier(id)); }
    }

    // ---------- settings ----------
    if (parts[0] === 'settings') {
      if (m === 'GET') { await requireUser(headers); return json(200, await L.getSettings()); }
      if (m === 'PUT') { await requirePerm(headers, 'manageSettings'); return json(200, await L.updateSettings(body)); }
    }

    // ---------- reports ----------
    if (parts[0] === 'report') {
      if (parts[1] === 'csv') {
        await requirePerm(headers, 'exportReports');
        const report = await L.revenueReport(query);
        return { status: 200, body: L.reportToCsv(report), contentType: 'text/csv', filename: 'revenue-report.csv' };
      }
      if (m === 'GET') { await requirePerm(headers, 'viewReports'); return json(200, await L.revenueReport(query)); }
    }

    return json(404, { error: `No route for ${m} /${parts.join('/')}` });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    return json(status, { error: err.message || 'Server error' });
  }
}

function guestView(o) {
  // Only expose what a guest should see.
  return {
    publicId: o.publicId, number: o.number, guestName: o.guestName,
    items: o.items, loads: o.loads, status: o.status, room: o.room,
    price: o.price, paymentStatus: o.paymentStatus, paymentTiming: o.paymentTiming,
    paymentMethod: o.paymentMethod, pickupAt: o.pickupAt,
    createdAt: o.createdAt, acceptedAt: o.acceptedAt,
    messages: (o.messages || []).map((mm) => ({ sender: mm.sender, staffName: mm.staffName, text: mm.text, at: mm.at })),
  };
}

// ---------- Netlify handler adapter ----------
export const handler = async (event) => {
  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch { body = {}; }
  }
  const headers = event.headers || {};
  const query = event.queryStringParameters || {};
  const res = await handleRequest({
    method: event.httpMethod,
    path: event.path,
    query, body, headers,
  });

  if (res.contentType === 'text/csv') {
    return {
      statusCode: res.status,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${res.filename}"`,
      },
      body: res.body,
    };
  }
  return {
    statusCode: res.status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(res.body),
  };
};
