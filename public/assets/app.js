// Reception / Admin single-page app.
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const TOKEN_KEY = 'laundry_token';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  user: null,
  perms: {},
  catalogue: {},
  settings: null,
  tab: 'orders',
  pin: '',
  poll: null,
};

const STATUS_LABEL = { new: 'New', accepted: 'Accepted', cleaning: 'Cleaning', ready: 'Ready', completed: 'Completed', cancelled: 'Cancelled' };

// ---------------- API ----------------
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401 && state.user) { lock(); throw new Error('Session expired — please re-enter your PIN.'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || 'Request failed');
  return data;
}

function can(perm) {
  if (!state.user) return false;
  if (state.user.role === 'admin') return true;
  return !!state.perms[perm];
}

// ---------------- helpers ----------------
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function cur() { return state.settings?.currency?.symbol || ''; }
function money(n) { return n == null ? '—' : `${cur()}${Number(n).toFixed(2)}`; }
function fmt(iso) { if (!iso) return '—'; try { return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return iso; } }
function ago(iso) { if (!iso) return ''; const h = (Date.now() - new Date(iso)) / 3600000; return h < 1 ? `${Math.round(h * 60)}m ago` : `${h.toFixed(1)}h ago`; }
function toLocalInput(iso) { const d = iso ? new Date(iso) : new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
function notice(el, kind, text) { el.innerHTML = text ? `<div class="notice ${kind}">${esc(text)}</div>` : ''; }

// ---------------- boot ----------------
async function boot() {
  let status;
  try { status = await api('GET', '/status'); } catch { status = {}; }
  if (!status.isSetup) return showSetup();
  if (state.token) {
    try {
      const me = await api('GET', '/me');
      state.user = me.user; state.perms = me.user.permissions || {}; state.catalogue = me.permissionCatalogue;
      state.settings = await api('GET', '/settings');
      return enterApp();
    } catch { state.token = null; localStorage.removeItem(TOKEN_KEY); }
  }
  showLock();
}

// ---------------- setup ----------------
function showSetup() {
  hideAll(); $('#setupScreen').classList.remove('hidden');
  $('#setupBtn').onclick = async () => {
    const pin = $('#setupPin').value.trim();
    if (pin !== $('#setupPin2').value.trim()) return notice($('#setupMsg'), 'err', 'PINs do not match.');
    if (!/^\d{4,8}$/.test(pin)) return notice($('#setupMsg'), 'err', 'PIN must be 4–8 digits.');
    try {
      await api('POST', '/setup', { hostelName: $('#setupHostel').value.trim(), adminName: $('#setupAdmin').value.trim() || 'Admin', adminPin: pin });
      const auth = await api('POST', '/auth/pin', { pin });
      afterAuth(auth);
    } catch (e) { notice($('#setupMsg'), 'err', e.message); }
  };
}

// ---------------- lock / PIN ----------------
function hideAll() { ['setupScreen', 'lockScreen', 'app'].forEach(id => $('#' + id).classList.add('hidden')); }

async function showLock() {
  hideAll(); $('#lockScreen').classList.remove('hidden');
  state.pin = ''; renderPinDots();
  try { const s = await (await fetch('/api/public-settings')).json();
    if (s.accentColor) document.documentElement.style.setProperty('--accent', s.accentColor);
    $('#lockName').textContent = s.hostelName || 'Laundry';
    if (s.logoDataUrl && !$('#lockBrand img')) { const i = document.createElement('img'); i.src = s.logoDataUrl; $('#lockBrand').prepend(i); }
  } catch {}
  buildPinpad();
}
function renderPinDots() { $('#pinDots').textContent = state.pin.replace(/./g, '•') || ' '; }
function buildPinpad() {
  const pad = $('#pinpad'); pad.innerHTML = '';
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK'];
  keys.forEach(k => { const b = document.createElement('button'); b.textContent = k; b.onclick = () => pinKey(k); pad.appendChild(b); });
}
async function pinKey(k) {
  notice($('#pinMsg'), '', '');
  if (k === '⌫') { state.pin = state.pin.slice(0, -1); return renderPinDots(); }
  if (k === 'OK') return submitPin();
  if (state.pin.length >= 8) return;
  state.pin += k; renderPinDots();
  if (state.pin.length === 8) submitPin();
}
async function submitPin() {
  if (state.pin.length < 4) return notice($('#pinMsg'), 'err', 'PIN is at least 4 digits.');
  try { const auth = await api('POST', '/auth/pin', { pin: state.pin }); afterAuth(auth); }
  catch { state.pin = ''; renderPinDots(); notice($('#pinMsg'), 'err', 'Incorrect PIN. Try again.'); }
}
async function afterAuth(auth) {
  state.token = auth.token; localStorage.setItem(TOKEN_KEY, auth.token);
  const me = await api('GET', '/me');
  state.user = me.user; state.perms = me.user.permissions || {}; state.catalogue = me.permissionCatalogue;
  state.settings = await api('GET', '/settings');
  enterApp();
}
function lock() {
  state.token = null; state.user = null; localStorage.removeItem(TOKEN_KEY);
  if (state.poll) clearInterval(state.poll);
  showLock();
}

// ---------------- app shell ----------------
function enterApp() {
  hideAll(); $('#app').classList.remove('hidden');
  $('#topName').textContent = state.settings?.hostelName || 'Laundry';
  if (state.settings?.accentColor) document.documentElement.style.setProperty('--accent', state.settings.accentColor);
  $('#whoName').textContent = state.user.name;
  $('#whoRole').textContent = state.user.role;
  $('#lockBtn').onclick = lock;
  buildTabs();
  selectTab('orders');
  if (state.poll) clearInterval(state.poll);
  state.poll = setInterval(() => { if (['orders', 'messages'].includes(state.tab)) renderTab(true); }, 15000);
}

function buildTabs() {
  const tabs = [{ id: 'orders', label: 'Orders' }];
  if (can('messageGuests')) tabs.push({ id: 'messages', label: 'Messages' });
  if (can('viewReports')) tabs.push({ id: 'reports', label: 'Reports' });
  if (can('manageCashiers')) tabs.push({ id: 'cashiers', label: 'Cashiers' });
  if (can('manageSettings')) tabs.push({ id: 'settings', label: 'Settings' });
  const host = $('#tabs'); host.innerHTML = '';
  tabs.forEach(t => {
    const b = document.createElement('button');
    b.dataset.tab = t.id; b.innerHTML = `${t.label}<span class="tab-badge hidden" id="badge-${t.id}"></span>`;
    b.onclick = () => selectTab(t.id);
    host.appendChild(b);
  });
}
function selectTab(id) {
  state.tab = id;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  renderTab();
}
async function renderTab(silent) {
  const view = $('#view');
  try {
    if (state.tab === 'orders') return renderOrders(view, silent);
    if (state.tab === 'messages') return renderMessages(view, silent);
    if (state.tab === 'reports') return renderReports(view);
    if (state.tab === 'cashiers') return renderCashiers(view);
    if (state.tab === 'settings') return renderSettings(view);
  } catch (e) { if (!silent) view.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
}

// ---------------- ORDERS ----------------
async function renderOrders(view, silent) {
  const orders = await api('GET', '/orders');
  const cols = ['new', 'accepted', 'cleaning', 'ready'];
  const colTitle = { new: 'New — awaiting acceptance', accepted: 'Accepted', cleaning: 'Cleaning', ready: 'Ready for pickup' };
  const newCount = orders.filter(o => o.status === 'new').length;

  const boards = cols.map(st => {
    const items = orders.filter(o => o.status === st);
    return `<div class="col"><h3>${colTitle[st]} (${items.length})</h3>${items.map(orderCard).join('') || '<p class="muted" style="margin:6px 4px;font-size:13px">None</p>'}</div>`;
  }).join('');

  const recent = orders.filter(o => ['completed', 'cancelled'].includes(o.status)).slice(0, 12);
  view.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <h2 style="margin:0">Orders ${newCount ? `<span class="pill">${newCount} new</span>` : ''}</h2>
      <button class="small secondary" onclick="location.reload()">↻ Refresh</button>
    </div>
    <div class="cols">${boards}</div>
    <h3 style="margin-top:26px;color:var(--muted)">Recently completed / cancelled</h3>
    <table class="data"><thead><tr><th>#</th><th>Guest</th><th>Room</th><th>Items</th><th>Total</th><th>Status</th><th>When</th></tr></thead>
    <tbody>${recent.map(o => `<tr style="cursor:pointer" onclick="openOrder('${o.id}')"><td>#${o.number}</td><td>${esc(o.guestName)}</td><td>${esc(o.room || '—')}</td><td>${o.items}</td><td>${money(o.price)}</td><td><span class="badge b-${o.status}">${STATUS_LABEL[o.status]}</span></td><td class="muted">${fmt(o.completedAt || o.updatedAt)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">None yet</td></tr>'}</tbody></table>`;
  window._orders = orders;
}

function orderCard(o) {
  const stuck = o.status === 'accepted' && o.acceptedAt && (Date.now() - new Date(o.acceptedAt)) > (state.settings?.stuckThresholdHours || 4) * 3600000;
  const nextBtn = { accepted: 'Start cleaning', cleaning: 'Mark ready', ready: 'Mark picked up' }[o.status];
  const unread = (o.messages || []).filter(m => m.sender === 'guest' && !m.readByStaff).length;
  return `<div class="ocard" onclick="openOrder('${o.id}')">
    <div class="top"><span class="num">#${o.number}</span><span class="badge b-${o.status}">${STATUS_LABEL[o.status]}</span></div>
    <div>${esc(o.guestName)} ${o.room ? `· Room ${esc(o.room)}` : ''} ${unread ? `<span class="tab-badge">${unread}✉</span>` : ''}</div>
    <div class="meta">${o.items} items · ${o.loads} load(s) · ${money(o.price)}</div>
    <div class="meta">${o.status === 'new' ? 'Placed ' + ago(o.createdAt) : 'Ready by ' + fmt(o.pickupAt)}</div>
    ${stuck ? '<div class="meta" style="color:var(--danger);font-weight:600">⏰ waiting ' + ago(o.acceptedAt) + '</div>' : ''}
    <div style="margin-top:10px" onclick="event.stopPropagation()">
      ${o.status === 'new' && can('acceptOrders') ? `<button class="small" onclick="openAccept('${o.id}')">Accept</button>` : ''}
      ${nextBtn && can('advanceStatus') ? `<button class="small" onclick="advance('${o.id}')">${nextBtn}</button>` : ''}
    </div>
  </div>`;
}

window.openOrder = async (id) => {
  const o = await api('GET', `/orders/${id}`);
  const canModify = o.status === 'new' ? can('acceptOrders') : can('modifyAccepted');
  const logs = (o.logs || []).slice().reverse().map(l => `<div class="log"><b>${esc(l.actor)}</b> <span class="muted">(${esc(l.role)})</span> — ${esc(l.detail)}<br><span class="muted" style="font-size:11px">${fmt(l.at)}</span></div>`).join('');
  const msgs = (o.messages || []).map(m => `<div class="msg ${m.sender}"><div class="who">${m.sender === 'staff' ? esc(m.staffName || 'Reception') : esc(o.guestName)} · ${fmt(m.at)}</div>${esc(m.text)}</div>`).join('') || '<p class="muted">No messages.</p>';
  const nextBtn = { accepted: 'Start cleaning', cleaning: 'Mark ready', ready: 'Mark picked up' }[o.status];
  openModal(`
    <button class="ghost small close" onclick="closeModal()">✕ Close</button>
    <h3>Order #${o.number} <span class="badge b-${o.status}">${STATUS_LABEL[o.status]}</span></h3>
    <table class="data">
      <tr><td class="muted">Guest</td><td>${esc(o.guestName)}</td></tr>
      <tr><td class="muted">Email</td><td>${esc(o.guestEmail)}</td></tr>
      <tr><td class="muted">Room</td><td>${esc(o.room || '—')}</td></tr>
      <tr><td class="muted">Items / loads</td><td>${o.items} / ${o.loads}</td></tr>
      <tr><td class="muted">Total</td><td>${money(o.price)}</td></tr>
      <tr><td class="muted">Payment</td><td>${o.paymentStatus === 'paid' ? 'Paid (' + (o.paymentMethod || '') + ')' : 'Pay at pickup'}</td></tr>
      <tr><td class="muted">Ready by</td><td>${fmt(o.pickupAt)}</td></tr>
      ${o.note ? `<tr><td class="muted">Note</td><td>${esc(o.note)}</td></tr>` : ''}
    </table>
    <div id="modalMsg"></div>
    <div class="stack" style="margin-top:12px">
      ${o.status === 'new' && can('acceptOrders') ? `<button onclick="openAccept('${o.id}')">Accept order…</button>` : ''}
      ${nextBtn && can('advanceStatus') ? `<button onclick="advance('${o.id}', true)">${nextBtn}</button>` : ''}
      ${o.status !== 'new' && canModify ? `<button class="secondary" onclick="openModify('${o.id}')">Edit order</button>` : ''}
      ${o.status !== 'new' && o.status !== 'completed' && o.status !== 'cancelled' && !canModify ? `<p class="muted" style="font-size:13px">Only an admin can edit an accepted order.</p>` : ''}
      ${!['completed', 'cancelled'].includes(o.status) && can('cancelOrders') ? `<button class="danger" onclick="cancelOrder('${o.id}')">Cancel order</button>` : ''}
    </div>
    <h3 style="margin-top:20px">Messages</h3>
    <div class="thread">${msgs}</div>
    ${can('messageGuests') ? `<form onsubmit="return replyOrder(event,'${o.id}')" style="display:flex;gap:8px;margin-top:10px"><input id="replyInput" placeholder="Reply to guest…" style="flex:1" required><button class="small">Send</button></form>` : ''}
    <h3 style="margin-top:20px">Activity log</h3>
    <div style="max-height:220px;overflow:auto">${logs || '<p class="muted">No activity.</p>'}</div>
  `);
};

window.openAccept = async (id) => {
  const o = (window._orders || []).find(x => x.id === id) || await api('GET', `/orders/${id}`);
  const est = (o.loads || 1) * (state.settings?.pricePerLoad || 0);
  const pickupDefault = toLocalInput(new Date(Date.now() + (state.settings?.turnaroundHours || 24) * 3600000).toISOString());
  openModal(`
    <button class="ghost small close" onclick="closeModal()">✕</button>
    <h3>Accept order #${o.number}</h3>
    <p class="hint">${esc(o.guestName)} · ${o.items} items · ${o.loads} load(s)</p>
    <div id="acceptMsg"></div>
    <label>Room number</label>
    <input id="acRoom" placeholder="e.g. 204" value="${esc(o.room || '')}">
    <label>Ready for pickup</label>
    <input id="acPickup" type="datetime-local" value="${pickupDefault}">
    <p class="muted" style="font-size:12px;margin:6px 0 0">Standard turnaround is ${state.settings?.turnaroundHours || 24}h — adjust if needed.</p>
    <label>Price (${cur()})</label>
    <input id="acPrice" type="number" step="0.01" min="0" value="${est.toFixed(2)}">
    <p class="muted" style="font-size:12px;margin:6px 0 0">${o.loads} load(s) × ${money(state.settings?.pricePerLoad)} = ${money(est)} (editable).</p>
    <label>Payment</label>
    <select id="acPayStatus" onchange="document.getElementById('acMethodRow').style.display=this.value==='paid'?'block':'none'">
      <option value="unpaid">Pay at pickup</option>
      <option value="paid">Paid now</option>
    </select>
    <div id="acMethodRow" style="display:none">
      <label>Method</label>
      <select id="acMethod"><option value="cash">Cash</option><option value="card">Card</option></select>
    </div>
    <button class="btn-full" style="margin-top:16px" onclick="doAccept('${o.id}')">Accept & notify guest</button>
  `);
};
window.doAccept = async (id) => {
  try {
    const pickup = $('#acPickup').value ? new Date($('#acPickup').value).toISOString() : null;
    await api('POST', `/orders/${id}/accept`, {
      room: $('#acRoom').value.trim(), pickupAt: pickup, price: $('#acPrice').value,
      paymentStatus: $('#acPayStatus').value, paymentMethod: $('#acMethod') ? $('#acMethod').value : 'cash',
    });
    closeModal(); renderTab();
  } catch (e) { notice($('#acceptMsg'), 'err', e.message); }
};

window.openModify = async (id) => {
  const o = await api('GET', `/orders/${id}`);
  openModal(`
    <button class="ghost small close" onclick="closeModal()">✕</button>
    <h3>Edit order #${o.number}</h3>
    <div id="modMsg"></div>
    <label>Room</label><input id="mdRoom" value="${esc(o.room || '')}">
    <label>Items</label><input id="mdItems" type="number" min="1" value="${o.items}">
    <label>Price (${cur()})</label><input id="mdPrice" type="number" step="0.01" min="0" value="${o.price ?? ''}">
    <label>Ready by</label><input id="mdPickup" type="datetime-local" value="${o.pickupAt ? toLocalInput(o.pickupAt) : ''}">
    <label>Payment</label>
    <select id="mdPayStatus" onchange="document.getElementById('mdMethodRow').style.display=this.value==='paid'?'block':'none'">
      <option value="unpaid" ${o.paymentStatus !== 'paid' ? 'selected' : ''}>Pay at pickup</option>
      <option value="paid" ${o.paymentStatus === 'paid' ? 'selected' : ''}>Paid</option>
    </select>
    <div id="mdMethodRow" style="display:${o.paymentStatus === 'paid' ? 'block' : 'none'}">
      <label>Method</label>
      <select id="mdMethod"><option value="cash" ${o.paymentMethod === 'cash' ? 'selected' : ''}>Cash</option><option value="card" ${o.paymentMethod === 'card' ? 'selected' : ''}>Card</option></select>
    </div>
    <button class="btn-full" style="margin-top:16px" onclick="doModify('${o.id}')">Save changes</button>
  `);
};
window.doModify = async (id) => {
  try {
    await api('PATCH', `/orders/${id}`, {
      room: $('#mdRoom').value.trim(), items: $('#mdItems').value, price: $('#mdPrice').value,
      pickupAt: $('#mdPickup').value ? new Date($('#mdPickup').value).toISOString() : undefined,
      paymentStatus: $('#mdPayStatus').value, paymentMethod: $('#mdMethod').value,
    });
    closeModal(); renderTab();
  } catch (e) { notice($('#modMsg'), 'err', e.message); }
};

window.advance = async (id, close) => { try { await api('POST', `/orders/${id}/advance`, {}); if (close) closeModal(); renderTab(); } catch (e) { alert(e.message); } };
window.cancelOrder = async (id) => { const reason = prompt('Reason for cancelling (optional):'); if (reason === null) return; try { await api('POST', `/orders/${id}/cancel`, { reason }); closeModal(); renderTab(); } catch (e) { alert(e.message); } };
window.replyOrder = async (e, id) => { e.preventDefault(); const t = $('#replyInput').value.trim(); if (!t) return false; try { await api('POST', `/orders/${id}/reply`, { text: t }); openOrder(id); } catch (err) { notice($('#modalMsg'), 'err', err.message); } return false; };

// ---------------- MESSAGES ----------------
async function renderMessages(view, silent) {
  const threads = await api('GET', '/threads');
  const totalUnread = threads.reduce((a, t) => a + t.unread, 0);
  setBadge('messages', totalUnread);
  view.innerHTML = `<h2>Guest messages ${totalUnread ? `<span class="pill">${totalUnread} unread</span>` : ''}</h2>
    <div class="grid">${threads.map(t => `
      <div class="ocard" onclick="openOrder('${t.id}')">
        <div class="top"><span class="num">#${t.number} · ${esc(t.guestName)}</span>${t.unread ? `<span class="tab-badge">${t.unread}</span>` : ''}</div>
        <div class="meta">${esc(t.lastMessage.sender === 'staff' ? 'You: ' : '')}${esc(t.lastMessage.text)}</div>
        <div class="meta">${fmt(t.lastMessage.at)} · <span class="badge b-${t.status}">${STATUS_LABEL[t.status]}</span></div>
      </div>`).join('') || '<p class="muted">No messages yet.</p>'}</div>`;
}
function setBadge(tab, n) { const b = $('#badge-' + tab); if (!b) return; if (n > 0) { b.textContent = n; b.classList.remove('hidden'); } else b.classList.add('hidden'); }

// ---------------- REPORTS ----------------
async function renderReports(view) {
  const today = new Date(); const p = n => String(n).padStart(2, '0');
  const toStr = d => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const start = new Date(today); start.setDate(today.getDate() - 30);
  view.innerHTML = `<h2>Revenue reporting</h2>
    <div class="card">
      <div class="row" style="align-items:flex-end">
        <div><label>From</label><input id="rpFrom" type="date" value="${toStr(start)}"></div>
        <div><label>To</label><input id="rpTo" type="date" value="${toStr(today)}"></div>
        <div style="flex:0"><button onclick="loadReport()">Run</button></div>
        ${can('exportReports') ? `<div style="flex:0"><button class="secondary" onclick="exportCsv()">CSV</button></div><div style="flex:0"><button class="secondary" onclick="exportPdf()">PDF</button></div>` : ''}
      </div>
    </div>
    <div id="reportBody"></div>`;
  loadReport();
}
function reportRange() { return { from: new Date($('#rpFrom').value + 'T00:00:00').toISOString(), to: new Date($('#rpTo').value + 'T23:59:59').toISOString() }; }
window.loadReport = async () => {
  const { from, to } = reportRange();
  const r = await api('GET', `/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  window._report = r;
  const t = r.totals;
  const maxRev = Math.max(1, ...r.byDay.map(d => d.revenue));
  $('#reportBody').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="k">Revenue</div><div class="v">${money(t.revenue)}</div></div>
      <div class="stat"><div class="k">Collected</div><div class="v">${money(t.collected)}</div></div>
      <div class="stat"><div class="k">Outstanding</div><div class="v">${money(t.outstanding)}</div></div>
      <div class="stat"><div class="k">Orders</div><div class="v">${t.orders}</div></div>
      <div class="stat"><div class="k">Loads</div><div class="v">${t.loads}</div></div>
      <div class="stat"><div class="k">Items</div><div class="v">${t.items}</div></div>
      <div class="stat"><div class="k">Avg order</div><div class="v">${money(t.avgOrderValue)}</div></div>
      <div class="stat"><div class="k">Cash / Card</div><div class="v" style="font-size:18px">${money(r.byMethod.cash)} / ${money(r.byMethod.card)}</div></div>
    </div>
    <div class="card"><h3 style="margin-top:0">Revenue by day</h3>
      ${r.byDay.length ? r.byDay.map(d => `<div style="display:flex;align-items:center;gap:10px;margin:6px 0">
        <span class="muted" style="width:96px;font-size:12px">${d.date}</span>
        <div style="flex:1;background:#eef2f5;border-radius:6px;height:20px;overflow:hidden"><div style="width:${(d.revenue / maxRev * 100).toFixed(1)}%;background:var(--accent);height:100%"></div></div>
        <span style="width:90px;text-align:right;font-size:13px">${money(d.revenue)}</span>
      </div>`).join('') : '<p class="muted">No revenue in this range.</p>'}
    </div>
    <div class="card"><h3 style="margin-top:0">Orders in range (${r.orders.length})</h3>
      <table class="data"><thead><tr><th>#</th><th>Date</th><th>Guest</th><th>Room</th><th>Loads</th><th>Total</th><th>Payment</th><th>Status</th></tr></thead>
      <tbody>${r.orders.map(o => `<tr><td>#${o.number}</td><td>${fmt(o.acceptedAt || o.createdAt)}</td><td>${esc(o.guestName)}</td><td>${esc(o.room || '—')}</td><td>${o.loads}</td><td>${money(o.price)}</td><td>${o.paymentStatus === 'paid' ? 'Paid (' + (o.paymentMethod || '') + ')' : 'Unpaid'}</td><td><span class="badge b-${o.status}">${STATUS_LABEL[o.status]}</span></td></tr>`).join('') || '<tr><td colspan="8" class="muted">None</td></tr>'}</tbody></table>
    </div>`;
};
window.exportCsv = async () => {
  const { from, to } = reportRange();
  const res = await fetch(`/api/report/csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { headers: { authorization: `Bearer ${state.token}` } });
  const blob = await res.blob();
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `revenue-${$('#rpFrom').value}_to_${$('#rpTo').value}.csv`; a.click();
};
window.exportPdf = () => {
  const r = window._report; if (!r) return;
  const t = r.totals; const name = esc(state.settings?.hostelName || 'Laundry');
  const w = window.open('', '_blank');
  w.document.write(`<html><head><title>Revenue Report</title><style>
    body{font-family:Arial,sans-serif;color:#222;padding:30px;max-width:760px;margin:auto}
    h1{color:${state.settings?.accentColor || '#0f766e'}} table{width:100%;border-collapse:collapse;margin:12px 0}
    td,th{border:1px solid #ddd;padding:7px 9px;text-align:left;font-size:13px} th{background:#f4f6f8}
    .kv{display:flex;flex-wrap:wrap;gap:8px}.kv div{border:1px solid #eee;border-radius:8px;padding:10px 14px;min-width:120px}
    .kv b{display:block;font-size:20px}</style></head><body>
    <h1>${name} — Revenue Report</h1>
    <p>${$('#rpFrom').value} to ${$('#rpTo').value}</p>
    <div class="kv">
      <div>Revenue<b>${money(t.revenue)}</b></div><div>Collected<b>${money(t.collected)}</b></div>
      <div>Outstanding<b>${money(t.outstanding)}</b></div><div>Orders<b>${t.orders}</b></div>
      <div>Loads<b>${t.loads}</b></div><div>Avg order<b>${money(t.avgOrderValue)}</b></div>
      <div>Cash<b>${money(r.byMethod.cash)}</b></div><div>Card<b>${money(r.byMethod.card)}</b></div>
    </div>
    <h3>Daily</h3><table><tr><th>Date</th><th>Orders</th><th>Loads</th><th>Revenue</th></tr>
    ${r.byDay.map(d => `<tr><td>${d.date}</td><td>${d.orders}</td><td>${d.loads}</td><td>${money(d.revenue)}</td></tr>`).join('')}</table>
    <h3>Orders</h3><table><tr><th>#</th><th>Guest</th><th>Room</th><th>Loads</th><th>Total</th><th>Payment</th></tr>
    ${r.orders.map(o => `<tr><td>${o.number}</td><td>${esc(o.guestName)}</td><td>${esc(o.room || '')}</td><td>${o.loads}</td><td>${money(o.price)}</td><td>${o.paymentStatus}</td></tr>`).join('')}</table>
    <p style="color:#888;font-size:12px;margin-top:20px">Generated ${new Date().toLocaleString()}</p>
    <script>window.onload=()=>window.print()<\/script></body></html>`);
  w.document.close();
};

// ---------------- CASHIERS ----------------
async function renderCashiers(view) {
  const list = await api('GET', '/cashiers');
  view.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><h2>Cashiers & access levels</h2><button onclick="openCashier()">+ Add cashier</button></div>
    <div class="grid" style="margin-top:12px">${list.map(c => `
      <div class="card" style="margin:0">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div><b>${esc(c.name)}</b> <span class="pill">${c.role}</span> ${c.active ? '' : '<span class="badge b-cancelled">inactive</span>'}</div>
        </div>
        <div class="muted" style="font-size:13px;margin:8px 0">${c.role === 'admin' ? 'Full access to everything.' : (Object.entries(c.permissions).filter(([, v]) => v).map(([k]) => state.catalogue[k] || k).join(', ') || 'No permissions set')}</div>
        <div style="display:flex;gap:8px"><button class="small secondary" onclick='openCashier(${JSON.stringify(c)})'>Edit</button>
        <button class="small danger" onclick="delCashier('${c.id}','${esc(c.name)}')">Remove</button></div>
      </div>`).join('')}</div>`;
}
window.openCashier = (c) => {
  c = c || null;
  const perms = state.catalogue;
  const checks = Object.entries(perms).map(([k, label]) => `<label style="font-weight:400;display:flex;gap:8px;align-items:center;margin:4px 0"><input type="checkbox" data-perm="${k}" style="width:auto" ${c && c.permissions && c.permissions[k] ? 'checked' : ''}> ${esc(label)}</label>`).join('');
  openModal(`
    <button class="ghost small close" onclick="closeModal()">✕</button>
    <h3>${c ? 'Edit' : 'Add'} cashier</h3>
    <div id="cshMsg"></div>
    <label>Name</label><input id="cshName" value="${c ? esc(c.name) : ''}">
    <label>Role</label>
    <select id="cshRole" onchange="document.getElementById('permBox').style.display=this.value==='admin'?'none':'block'">
      <option value="cashier" ${c && c.role === 'cashier' ? 'selected' : ''}>Cashier (limited)</option>
      <option value="admin" ${c && c.role === 'admin' ? 'selected' : ''}>Admin (full access)</option>
    </select>
    <label>PIN ${c ? '(leave blank to keep current)' : '(4–8 digits)'}</label>
    <input id="cshPin" inputmode="numeric" maxlength="8" placeholder="${c ? '••••' : 'e.g. 4821'}">
    <div id="permBox" style="display:${c && c.role === 'admin' ? 'none' : 'block'};margin-top:10px">
      <label>Permissions</label>
      <div style="background:#f9fafb;border-radius:10px;padding:10px 14px">${checks}</div>
    </div>
    ${c ? `<label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-weight:400"><input type="checkbox" id="cshActive" style="width:auto" ${c.active ? 'checked' : ''}> Active</label>` : ''}
    <button class="btn-full" style="margin-top:16px" onclick="saveCashier(${c ? `'${c.id}'` : 'null'})">Save</button>
  `);
};
window.saveCashier = async (id) => {
  const role = $('#cshRole').value;
  const permissions = {};
  document.querySelectorAll('[data-perm]').forEach(cb => permissions[cb.dataset.perm] = cb.checked);
  const body = { name: $('#cshName').value.trim(), role, permissions };
  const pin = $('#cshPin').value.trim(); if (pin) body.pin = pin;
  if ($('#cshActive')) body.active = $('#cshActive').checked;
  try {
    if (id) await api('PATCH', `/cashiers/${id}`, body);
    else { if (!pin) throw new Error('A PIN is required for a new cashier.'); await api('POST', '/cashiers', body); }
    closeModal(); renderCashiers($('#view'));
  } catch (e) { notice($('#cshMsg'), 'err', e.message); }
};
window.delCashier = async (id, name) => { if (!confirm(`Remove ${name}?`)) return; try { await api('DELETE', `/cashiers/${id}`); renderCashiers($('#view')); } catch (e) { alert(e.message); } };

// ---------------- SETTINGS ----------------
const CURRENCIES = [
  ['USD', '$'], ['EUR', '€'], ['GBP', '£'], ['JPY', '¥'], ['AUD', 'A$'], ['CAD', 'C$'], ['CHF', 'CHF'],
  ['CNY', '¥'], ['INR', '₹'], ['NGN', '₦'], ['GHS', '₵'], ['ZAR', 'R'], ['KES', 'KSh'], ['BRL', 'R$'],
  ['MXN', '$'], ['SGD', 'S$'], ['HKD', 'HK$'], ['NZD', 'NZ$'], ['SEK', 'kr'], ['NOK', 'kr'], ['DKK', 'kr'],
  ['PLN', 'zł'], ['THB', '฿'], ['IDR', 'Rp'], ['PHP', '₱'], ['AED', 'د.إ'], ['SAR', '﷼'], ['TRY', '₺'],
];
async function renderSettings(view) {
  const s = state.settings = await api('GET', '/settings');
  const orderUrl = (s.baseUrl || location.origin) + '/order';
  view.innerHTML = `<h2>Settings</h2>
    <div id="setMsg"></div>
    <div class="card">
      <h3 style="margin-top:0">Branding</h3>
      <label>Hostel / property name</label><input id="stName" value="${esc(s.hostelName || '')}">
      <label>Accent colour</label><input id="stColor" type="color" value="${s.accentColor || '#0f766e'}" style="height:44px">
      <label>Logo</label>
      <div style="display:flex;gap:12px;align-items:center">
        <img id="logoPreview" src="${s.logoDataUrl || ''}" style="max-height:46px;${s.logoDataUrl ? '' : 'display:none'}">
        <input id="stLogo" type="file" accept="image/*" onchange="previewLogo(this)">
        ${s.logoDataUrl ? '<button class="small secondary" onclick="clearLogo()">Remove</button>' : ''}
      </div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">Pricing & loads</h3>
      <label>Currency</label>
      <select id="stCurrency">${CURRENCIES.map(([c, sym]) => `<option value="${c}|${sym}" ${s.currency?.code === c ? 'selected' : ''}>${c} (${sym})</option>`).join('')}</select>
      <div class="row">
        <div><label>Price per load</label><input id="stPrice" type="number" step="0.01" min="0" value="${s.pricePerLoad}"></div>
        <div><label>Max pieces per load</label><input id="stPieces" type="number" min="1" value="${s.piecesPerLoad}"></div>
      </div>
      <label>Standard turnaround (hours)</label><input id="stTurn" type="number" min="1" value="${s.turnaroundHours}">
    </div>
    <div class="card">
      <h3 style="margin-top:0">Alerts</h3>
      <label>Alert when an order stays "Accepted" longer than (hours)</label>
      <input id="stStuck" type="number" min="0.25" step="0.25" value="${s.stuckThresholdHours}">
      <div class="row">
        <div><label>Admin alert email</label><input id="stAdminEmail" type="email" value="${esc(s.adminEmail || '')}"></div>
        <div><label>Reception alert email</label><input id="stRecEmail" type="email" value="${esc(s.receptionEmail || '')}"></div>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">Public site URL</h3>
      <label>Base URL (used in guest emails & QR)</label>
      <input id="stBase" placeholder="https://your-site.netlify.app" value="${esc(s.baseUrl || '')}">
      <p class="muted" style="font-size:12px">Leave blank to auto-use this site's address.</p>
    </div>
    <button class="btn-full" onclick="saveSettings()">Save settings</button>

    <div class="card" style="margin-top:20px;text-align:center">
      <h3 style="margin-top:0">Guest order QR code</h3>
      <p class="hint">Print this and place it at reception. Guests scan to order.</p>
      <div id="qrbox" style="display:inline-block;padding:12px;background:#fff;border-radius:12px"></div>
      <p class="muted" style="font-size:12px;word-break:break-all">${esc(orderUrl)}</p>
      <button class="small secondary" onclick="downloadQr()">Download QR</button>
    </div>`;
  drawQr(orderUrl);
}
window.previewLogo = (input) => {
  const f = input.files[0]; if (!f) return;
  if (f.size > 400000) { notice($('#setMsg'), 'err', 'Logo too large — please use an image under 400KB.'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => { const img = $('#logoPreview'); img.src = reader.result; img.style.display = 'inline'; state._newLogo = reader.result; };
  reader.readAsDataURL(f);
};
window.clearLogo = () => { state._newLogo = ''; $('#logoPreview').style.display = 'none'; };
window.saveSettings = async () => {
  const [code, symbol] = $('#stCurrency').value.split('|');
  const body = {
    hostelName: $('#stName').value.trim(), accentColor: $('#stColor').value,
    currency: { code, symbol }, pricePerLoad: $('#stPrice').value, piecesPerLoad: $('#stPieces').value,
    turnaroundHours: $('#stTurn').value, stuckThresholdHours: $('#stStuck').value,
    adminEmail: $('#stAdminEmail').value.trim(), receptionEmail: $('#stRecEmail').value.trim(),
    baseUrl: $('#stBase').value.trim(),
  };
  if (state._newLogo !== undefined) body.logoDataUrl = state._newLogo;
  try {
    state.settings = await api('PUT', '/settings', body);
    delete state._newLogo;
    $('#topName').textContent = state.settings.hostelName || 'Laundry';
    document.documentElement.style.setProperty('--accent', state.settings.accentColor);
    notice($('#setMsg'), 'ok', 'Settings saved.');
    window.scrollTo(0, 0);
  } catch (e) { notice($('#setMsg'), 'err', e.message); }
};
function drawQr(url) {
  const box = $('#qrbox'); if (!box || !window.QRCode) return;
  box.innerHTML = ''; new QRCode(box, { text: url, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
}
window.downloadQr = () => {
  const cvs = $('#qrbox canvas'); const img = $('#qrbox img');
  const src = cvs ? cvs.toDataURL('image/png') : (img ? img.src : null);
  if (!src) return;
  const a = document.createElement('a'); a.href = src; a.download = 'laundry-order-qr.png'; a.click();
};

// ---------------- modal ----------------
function openModal(html) { $('#modalHost').innerHTML = `<div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal">${html}</div></div>`; }
window.closeModal = () => { $('#modalHost').innerHTML = ''; };

boot();
