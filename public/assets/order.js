// Guest order page.
const $ = (s) => document.querySelector(s);
let settings = { piecesPerLoad: 25, currency: { symbol: '' }, pricePerLoad: 0 };

async function loadBranding() {
  try {
    const res = await fetch('/api/public-settings');
    settings = await res.json();
    applyBrand(settings);
  } catch { /* keep defaults */ }
}

function applyBrand(s) {
  if (s.accentColor) document.documentElement.style.setProperty('--accent', s.accentColor);
  const brand = $('#brand');
  const name = s.hostelName || 'Laundry Service';
  $('#brandName').textContent = name;
  document.title = `Place a Laundry Order · ${name}`;
  if (s.logoDataUrl) {
    const img = document.createElement('img');
    img.src = s.logoDataUrl; img.alt = name;
    brand.prepend(img);
  }
  if (s.pricePerLoad != null && s.currency) {
    $('#priceHint').textContent =
      `${s.currency.symbol}${Number(s.pricePerLoad).toFixed(2)} per load · up to ${s.piecesPerLoad} items per load. Reception confirms the final price.`;
  }
}

function updateLoadHint() {
  const items = parseInt($('#items').value, 10);
  const per = settings.piecesPerLoad || 25;
  if (items > 0) {
    const loads = Math.max(1, Math.ceil(items / per));
    const est = settings.pricePerLoad != null
      ? ` · est. ${settings.currency.symbol}${(loads * settings.pricePerLoad).toFixed(2)}`
      : '';
    $('#loadHint').textContent = `That's ${loads} load${loads > 1 ? 's' : ''} (max ${per} items/load)${est}.`;
  } else {
    $('#loadHint').textContent = '';
  }
}

function notify(kind, text) {
  $('#msg').innerHTML = `<div class="notice ${kind}">${text}</div>`;
}

$('#items').addEventListener('input', updateLoadHint);

$('#orderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#submitBtn');
  btn.disabled = true; btn.textContent = 'Submitting…';
  $('#msg').innerHTML = '';
  const payload = {
    guestName: $('#name').value.trim(),
    guestEmail: $('#email').value.trim(),
    items: parseInt($('#items').value, 10),
    note: $('#note').value.trim(),
  };
  try {
    const res = await fetch('/api/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    $('#formCard').classList.add('hidden');
    $('#doneCard').classList.remove('hidden');
    $('#doneMsg').textContent = `Your order number is #${data.number}. Reception will confirm it shortly.`;
    $('#trackLink').href = `/track?id=${data.publicId}`;
  } catch (err) {
    notify('err', err.message);
    btn.disabled = false; btn.textContent = 'Submit order';
  }
});

loadBranding();
