// Browser smoke test: load the actual HTML + JS in jsdom against the real API
// (file-store) and drive the UI the way a receptionist would. Catches runtime
// reference errors and verifies rendering/interaction wiring.

import { JSDOM } from 'jsdom';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const dir = mkdtempSync(path.join(os.tmpdir(), 'laundry-dom-'));
process.env.FORCE_FILE_STORE = '1';
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET = 'dom-secret';
delete process.env.RESEND_API_KEY;

const { handleRequest } = await import('../netlify/functions/api.js');

// A fetch() shim that routes /api to handleRequest and reads local files otherwise.
function makeFetch() {
  return async (url, opts = {}) => {
    const u = new URL(url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) {
      const query = Object.fromEntries(u.searchParams.entries());
      let body = {}; try { body = opts.body ? JSON.parse(opts.body) : {}; } catch {}
      const r = await handleRequest({ method: opts.method || 'GET', path: u.pathname, query, body, headers: opts.headers || {} });
      const payload = r.contentType === 'text/csv' ? r.body : JSON.stringify(r.body);
      return {
        ok: r.status < 400, status: r.status,
        headers: { get: () => (r.contentType || 'application/json') },
        json: async () => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body),
        text: async () => payload, blob: async () => payload,
      };
    }
    // static asset
    const file = path.join(ROOT, 'public', u.pathname.replace(/^\//, ''));
    return { ok: true, status: 200, headers: { get: () => 'text/javascript' }, text: async () => readFileSync(file, 'utf8') };
  };
}

let pass = 0, fail = 0; const out = [];
const ok = (n, c, x = '') => { if (c) { pass++; out.push(`  ✅ ${n}`); } else { fail++; out.push(`  ❌ ${n} ${x}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function loadPage(htmlFile, jsFile, { search = '' } = {}) {
  const html = readFileSync(path.join(ROOT, 'public', htmlFile), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: `http://localhost${search ? '/track' + search : '/'}`, pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = makeFetch();
  window.QRCode = function (el) { el.innerHTML = '<canvas></canvas>'; }; // stub CDN lib
  window.QRCode.CorrectLevel = { M: 0 };
  window.alert = () => {}; window.confirm = () => true; window.prompt = () => 'x';
  window.scrollTo = () => {};
  global.window = window; global.document = window.document; global.localStorage = window.localStorage;
  global.fetch = window.fetch; global.FileReader = window.FileReader; global.URLSearchParams = window.URLSearchParams;
  const js = readFileSync(path.join(ROOT, 'public/assets', jsFile), 'utf8');
  window.eval(js);
  await sleep(60);
  return window;
}

try {
  // Seed: set up admin + settings + one order via API first.
  await handleRequest({ method: 'POST', path: '/api/setup', body: { hostelName: 'DOM Hostel', adminName: 'Ada', adminPin: '1234' } });
  const auth = await handleRequest({ method: 'POST', path: '/api/auth/pin', body: { pin: '1234' } });
  const H = { authorization: `Bearer ${auth.body.token}` };
  await handleRequest({ method: 'PUT', path: '/api/settings', headers: H, body: { currency: { code: 'USD', symbol: '$' }, pricePerLoad: 6, piecesPerLoad: 25 } });

  out.push('\n▶ Guest order page (order.js)');
  let w = await loadPage('order.html', 'order.js');
  ok('branding applied from settings', w.document.querySelector('#brandName').textContent === 'DOM Hostel', w.document.querySelector('#brandName').textContent);
  ok('order form shows payment choice (timing + method)', w.document.querySelectorAll('input[name="timing"]').length === 2 && w.document.querySelectorAll('input[name="method"]').length === 2);
  w.document.querySelector('#items').value = '30';
  w.document.querySelector('#items').dispatchEvent(new w.Event('input'));
  ok('load hint computes 2 loads for 30 items', /2 loads/.test(w.document.querySelector('#loadHint').textContent), w.document.querySelector('#loadHint').textContent);
  w.document.querySelector('#name').value = 'Zoe Q';
  w.document.querySelector('#email').value = 'zoe@example.com';
  w.document.querySelector('#orderForm').dispatchEvent(new w.Event('submit'));
  await sleep(80);
  ok('order submits & shows confirmation', !w.document.querySelector('#doneCard').classList.contains('hidden'));
  ok('track link populated', /\/track\?id=pub_/.test(w.document.querySelector('#trackLink').href), w.document.querySelector('#trackLink').href);

  out.push('\n▶ Reception app (app.js) — setup already done, so shows lock screen');
  w = await loadPage('app.html', 'app.js');
  ok('lock screen visible (not setup)', !w.document.querySelector('#lockScreen').classList.contains('hidden'));
  ok('PIN pad rendered', w.document.querySelectorAll('#pinpad button').length === 12);
  // keyboard PIN entry works on the lock screen
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: '7' }));
  ok('keyboard digit updates the PIN', w.document.querySelector('#pinDots').textContent.includes('•'));
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Backspace' }));
  ok('keyboard backspace clears it', w.document.querySelector('#pinDots').textContent.trim() === '');
  // enter admin PIN via the pad
  ['1', '2', '3', '4', 'OK'].forEach(k => [...w.document.querySelectorAll('#pinpad button')].find(b => b.textContent === k).click());
  await sleep(120);
  ok('app shell shown after correct PIN', !w.document.querySelector('#app').classList.contains('hidden'));
  ok('admin sees all tabs (orders,messages,reports,cashiers,settings)', w.document.querySelectorAll('#tabs button').length === 5, w.document.querySelectorAll('#tabs button').length + '');
  ok('who-name shows Ada', w.document.querySelector('#whoName').textContent === 'Ada');
  await sleep(60);
  ok('orders board rendered with the guest order', /Zoe Q/.test(w.document.querySelector('#view').innerHTML), 'no order in view');
  ok('new order shows Accept button', /Accept/.test(w.document.querySelector('#view').innerHTML));
  ok('sound mute button present in topbar', !!w.document.querySelector('#muteBtn'));
  ok('shift bar offers Start shift', /Start shift/.test(w.document.querySelector('#view').innerHTML));
  // open the start-shift modal (laundry handover — acknowledge, no cash float)
  w.openStartShift();
  ok('start-shift modal auto-selects shift (no chooser), has acknowledgement, no cash float', !!w.document.querySelector('#shAck') && !w.document.querySelector('#shType') && !w.document.querySelector('#shFloat'));
  w.closeModal();
  ok('admin-selected hover colour applied (--hover)', w.document.documentElement.style.getPropertyValue('--hover').toUpperCase() === '#FFF8ED');

  // shift-boundary lock UI (render the banner directly)
  w.__test.state.shiftEnded = { shiftId: 'x', starterId: 'y', starterName: 'Ada', oldType: 'AM', newType: 'PM' };
  w.__test.state.continueMode = false;
  w.__test.renderShiftEndBanner();
  ok('shift-end lock shows continue + new-shift buttons', !!w.document.querySelector('#btnContinueShift') && !!w.document.querySelector('#btnNewShift'));
  ok('lock heading reflects ended shift', /AM shift has ended/.test(w.document.querySelector('#lockScreen h2').textContent));
  w.__test.state.continueMode = true; w.__test.renderShiftEndBanner();
  ok('continue mode asks for starter PIN', /Ada/.test(w.document.querySelector('#lockScreen .hint').textContent));
  w.__test.state.shiftEnded = null; w.__test.renderShiftEndBanner(); // reset

  // open settings tab and verify currency + QR render
  [...w.document.querySelectorAll('#tabs button')].find(b => b.dataset.tab === 'settings').click();
  await sleep(80);
  ok('settings shows currency select', !!w.document.querySelector('#stCurrency'));
  ok('QR code drawn', !!w.document.querySelector('#qrbox canvas, #qrbox img'));

  // cashiers tab: open add-cashier modal and confirm permission checkboxes exist
  [...w.document.querySelectorAll('#tabs button')].find(b => b.dataset.tab === 'cashiers').click();
  await sleep(80);
  w.openCashier();
  ok('add-cashier modal has permission checkboxes', w.document.querySelectorAll('[data-perm]').length >= 8, w.document.querySelectorAll('[data-perm]').length + '');
} catch (err) {
  fail++; out.push(`\n💥 ${err.stack || err}`);
}

console.log(out.join('\n'));
console.log(`\n${'─'.repeat(40)}\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
