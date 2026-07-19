# Laundry Service — In-house Hotel/Hostel Laundry System

A self-hosted laundry management app (CleanCloud-style) for a single property.
Guests scan a QR code to place orders; reception accepts, prices, and moves orders
through the cycle; guests get email updates at each stage and can message reception;
admins get revenue reporting and full access control.

Runs entirely on **GitHub + Netlify**. No separate database server:

- **Code** → GitHub
- **Hosting + serverless API** → Netlify Functions
- **Data** → Netlify Blobs (built into Netlify — nothing to set up)
- **Email** → Resend (free tier)

---

## Features

**Guest (via QR code)**
- Place an order: name, email, number of items
- Live order-tracking page with a status bar and estimated price
- Two-way messaging inbox with reception
- Automatic emails at every stage

**Reception / Admin**
- PIN-based cashier switching — one locked terminal, each staff member has a personal PIN (no full login)
- Accept orders: set room, pickup date & time, price, and payment (paid → cash/card, or pay at pickup)
- Order cycle: **New → Accepted → Cleaning → Ready → Completed** (guest emailed at accepted/cleaning/ready/completed)
- 24h standard turnaround, but reception picks any date & time
- Revenue reporting for any date range: revenue, collected vs outstanding, cash/card split, loads, items, average order value, daily breakdown — **export to CSV or PDF**
- Full audit log on every order (who did what, when — including emails sent)
- Guest message inbox with unread badges
- **Access levels**: admin chooses exactly what each cashier can do
- **Only admins can modify an already-accepted order** (enforced server-side)
- Email alert to admin + reception when an order sits at "Accepted" too long (default 4h, admin-adjustable)
- Settings: pick currency, upload logo, set property name, price per load, and max pieces per load

**Pricing model:** flat price **per load**. Loads = ⌈items ÷ max-pieces-per-load⌉ (default max 25/load, admin-configurable). Reception can override the price on any order.

---

## Deploy in ~10 minutes

### 1. Put the code on GitHub
```bash
cd hostel-laundry
git init
git add .
git commit -m "Laundry system"
# create an empty repo on github.com, then:
git remote add origin https://github.com/<you>/<repo>.git
git branch -M main
git push -u origin main
```

### 2. Connect to Netlify
1. Sign in at [app.netlify.com](https://app.netlify.com) → **Add new site → Import an existing project**.
2. Pick your GitHub repo. Netlify auto-detects settings from `netlify.toml` (publish `public`, functions `netlify/functions`). Click **Deploy**.
3. Netlify Blobs and the scheduled "stuck order" function are enabled automatically — no extra steps.

### 3. Set environment variables
In Netlify: **Site configuration → Environment variables → Add**:

| Key | Value |
|-----|-------|
| `RESEND_API_KEY` | Your key from [resend.com/api-keys](https://resend.com/api-keys) |
| `EMAIL_FROM` | e.g. `Laundry <laundry@yourdomain.com>` (see email note below) |
| `SESSION_SECRET` | A long random string. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

Then **Deploys → Trigger deploy → Deploy site** so the variables take effect.

### 4. First-run setup
Open `https://<your-site>.netlify.app/app`. On first visit you'll create the **admin account** (property name + admin PIN). After that, the terminal locks and everyone signs in with their PIN.

### 5. Finish configuration (Settings tab, admin only)
- Choose **currency**, upload your **logo**, set **price per load** and **max pieces per load**.
- Set **Base URL** to your Netlify address (used in guest emails + QR). Leaving it blank auto-uses the current address.
- Set **admin & reception alert emails** and the **stuck-order threshold**.
- Print the **guest order QR code** shown at the bottom and place it at reception.

Done. Guests scan the QR (or visit `/order`); staff work from `/app`.

---

## Email notes (Resend)

- Free tier covers 3,000 emails/month.
- To send to **any** guest address, verify your domain in Resend and set `EMAIL_FROM` to an address on that domain.
- Before verifying a domain you can use `EMAIL_FROM="Laundry <onboarding@resend.dev>"`, but Resend's sandbox only delivers to your own signup email — fine for testing.
- If `RESEND_API_KEY` is not set, the app still runs and logs emails as "dry-run" instead of sending (useful for local testing).

---

## Run locally (optional)

No Netlify CLI needed — a small dev server is included:

```bash
npm install
node scripts/dev-server.mjs      # → http://localhost:8888
```
Locally, data is stored as JSON files under `.data/` (git-ignored). On Netlify it uses Blobs automatically.

To also test emails locally, prefix with your key:
```bash
RESEND_API_KEY=re_xxx EMAIL_FROM="Laundry <onboarding@resend.dev>" node scripts/dev-server.mjs
```

---

## Tests

```bash
npm test                 # 47 backend/logic tests (order lifecycle, pricing, auth,
                         # permissions, reporting, messaging, stuck-order alerts)
node test/dom-smoke.mjs  # browser smoke test (needs: npm i jsdom) — boots the real
                         # HTML/JS and drives the UI
```

---

## How the pieces map to your requirements

| Requirement | Where |
|---|---|
| QR order (name, email, items) | `/order` page → `POST /api/orders` |
| Reception accept (room, pickup, paid/pay-at-pickup, cash/card) | Accept modal → `POST /api/orders/:id/accept` |
| Email on accept + each stage | `netlify/functions/lib/email.js`, sent from `logic.js` |
| Cycle accepted→cleaning→ready + notify | `POST /api/orders/:id/advance` |
| 24h turnaround, custom pickup date/time | Settings `turnaroundHours` + accept modal picker |
| Revenue reporting + CSV/PDF export | Reports tab → `GET /api/report`, `/api/report/csv`, in-app PDF |
| Central lock-in + PIN cashier switching | Lock screen + `POST /api/auth/pin` |
| Audit log per order | `order.logs[]`, shown in order detail |
| Alert if "Accepted" > N hours (admin-set) | `stuck-check.js` (scheduled every 15 min) + Settings threshold |
| Guest messaging inbox | Track page + Messages tab |
| Only admin edits accepted orders; per-cashier access levels | `api.js` permission checks + Cashiers tab |
| Choose currency, upload logo & name | Settings tab |

---

## Security notes

- PINs are stored salted + hashed (SHA-256), never in plain text.
- Staff sessions are short-lived HMAC-signed tokens (12h) signed with `SESSION_SECRET`.
- Guest tracking links use an unguessable random ID and expose only guest-safe fields (no internal logs, no other orders).
- All staff/admin API routes require a valid session; sensitive actions require the specific permission.
- Always set a strong `SESSION_SECRET` in production.

## License
MIT
