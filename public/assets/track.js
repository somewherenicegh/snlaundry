// Guest tracking + messaging page.
const $ = (s) => document.querySelector(s);
const publicId = new URLSearchParams(location.search).get('id');
let settings = { currency: { symbol: '' } };
let order = null;

const STAGES = ['accepted', 'cleaning', 'ready', 'completed'];
const LABELS = { new: 'Received', accepted: 'Accepted', cleaning: 'Cleaning', ready: 'Ready', completed: 'Completed', cancelled: 'Cancelled' };

async function loadBranding() {
  try {
    settings = await (await fetch('/api/public-settings')).json();
    if (settings.accentColor) document.documentElement.style.setProperty('--accent', settings.accentColor);
    const name = settings.hostelName || 'Laundry Service';
    $('#brandName').textContent = name;
    document.title = `Track your Laundry · ${name}`;
    if (settings.logoDataUrl) {
      const img = document.createElement('img'); img.src = settings.logoDataUrl; img.alt = name;
      $('#brand').prepend(img);
    }
  } catch {}
}

function fmt(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-GB', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }); }
  catch { return iso; }
}
function esc(s){ return String(s??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function renderProgress(status) {
  if (status === 'cancelled') return `<div class="notice err">This order was cancelled. Please contact reception.</div>`;
  const curIdx = STAGES.indexOf(status);
  return `<div style="display:flex;justify-content:space-between;gap:4px">` + STAGES.map((s, i) => {
    const done = curIdx >= i && curIdx >= 0;
    const color = done ? 'var(--accent)' : 'var(--line)';
    return `<div style="flex:1;text-align:center">
      <div style="height:8px;border-radius:99px;background:${color};margin-bottom:6px"></div>
      <div style="font-size:11px;color:${done ? 'var(--ink)' : 'var(--muted)'}">${LABELS[s]}</div>
    </div>`;
  }).join('') + `</div>`;
}

function renderDetails(o) {
  const cur = settings.currency?.symbol || '';
  const rows = [
    ['Guest', esc(o.guestName)],
    o.room ? ['Room name', esc(o.room)] : null,
    ['Items', `${o.items} pcs · ${o.loads} load(s)`],
    o.price != null ? ['Total', `${cur}${Number(o.price).toFixed(2)}`] : null,
    ['Payment', paymentText(o)],
    o.pickupAt ? ['Ready by', fmt(o.pickupAt)] : null,
    ['Placed', fmt(o.createdAt)],
  ].filter(Boolean);
  return rows.map(([k, v]) => `<tr><td class="muted">${k}</td><td style="text-align:right;font-weight:600">${v}</td></tr>`).join('');
}

function paymentText(o) {
  if (o.paymentStatus === 'paid') return `Paid ✓${o.paymentMethod ? ' (' + o.paymentMethod + ')' : ''}`;
  if (o.paymentTiming === 'now') return `Pay now${o.paymentMethod ? ' — ' + o.paymentMethod : ''} (on drop-off)`;
  return 'Pay at pickup';
}

function renderThread(messages) {
  if (!messages.length) return `<p class="muted center" style="padding:14px">No messages yet.</p>`;
  return messages.map(m => `<div class="msg ${m.sender}">
    <div class="who">${m.sender === 'staff' ? esc(m.staffName || 'Reception') : 'You'} · ${fmt(m.at)}</div>
    ${esc(m.text)}</div>`).join('');
}

async function load() {
  if (!publicId) { $('#notFound').classList.remove('hidden'); return; }
  const res = await fetch(`/api/orders/public/${publicId}`);
  if (!res.ok) { $('#notFound').classList.remove('hidden'); return; }
  order = await res.json();
  $('#content').classList.remove('hidden');
  $('#oNum').textContent = order.number;
  const badge = $('#oStatus');
  badge.textContent = LABELS[order.status] || order.status;
  badge.className = `badge b-${order.status}`;
  $('#progress').innerHTML = renderProgress(order.status);
  $('#oDetails').innerHTML = renderDetails(order);
  const thread = $('#thread');
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
  thread.innerHTML = renderThread(order.messages || []);
  if (atBottom) thread.scrollTop = thread.scrollHeight;
}

$('#msgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#msgInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await fetch(`/api/orders/public/${publicId}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  });
  await load();
  $('#thread').scrollTop = $('#thread').scrollHeight;
});

loadBranding().then(load);
setInterval(load, 15000); // auto-refresh status + messages
