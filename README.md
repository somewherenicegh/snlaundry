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
- Pickup defaults to **6:00 PM the next day**; reception can pick any date & time
- Changing an order's **price requires a reason** (recorded in the order's audit log)
- Admin can **reset/change the order-number sequence** (Settings → Order numbering)
- Revenue reporting for any date range: revenue, collected vs outstanding, cash/card split, loads, items, average order value, daily breakdown — **export to CSV or PDF**
- Full audit log on every order (who did what, when — including emails sent)
- Guest message inbox with unread badges
- **Access levels**: admin chooses exactly what each cashier can do
- **Branded staff invitations**: email a new admin/cashier a welcome message with the app link, their role, and their PIN (Cashiers → Invite; the PIN is verified before it's included)
- **Only admins can modify an already-accepted order** (enforced server-side)
- Email alerts to **any number of recipients** when an order sits at "Accepted" too long (default 4h, admin-adjustable)
- Settings: pick currency, upload logo, set property name, price per load, and max pieces per load

**Pricing model:** flat price **per load**. Loads = ⌈items ÷ max-pieces-per-load⌉ (default max 25/load, admin-configurable). Reception can override the price on any order.

**Also included**
- Clean neutral theme; accent colour, **hover-highlight colour** (default `#FFF8ED`), logo and name are all set in Settings.
- Guest chooses payment at order time: **Pay now** (cash or card) or **Pay at pickup**.
- An order **cannot be marked picked up until payment is collected**.
- **Reverse** an order a stage (e.g. ready → cleaning) — admins and any cashier granted the *reverseStatus* permission.
- Reports show **who** accepted / cleaned / marked ready / took payment, plus breakdowns **by shift** (AM 06–14, PM 14–22, Night 22–06) and **by staff**. The report can also be **filtered and exported (CSV/PDF) to a single shift** within any date range.
- **Shift handovers:** opening *and* closing a shift lists the laundry currently in progress (with **unpaid items flagged**) and requires the receptionist to tick the items and acknowledge they've physically checked the laundry area. Closing also shows a **summary of the shift's activity** (laundry received, payments taken with cash/card split, and picked up). No cash counting. The shift (AM/PM/Night) is **auto-selected for the current time** and can't be set to a different one.
- **Repeating reception chimes**, each until resolved: a new-order ping (until every order is accepted), the same urgent ping for orders **stuck past the threshold** (default 4h), a new-message ping (until reception reads it), and a calmer start-a-shift chime (until a shift is open). **Only an admin can mute** the sound.
- **Auto-lock** after 5 minutes of inactivity.
- **Shift-boundary lock:** when the clock crosses into a new shift period, the terminal locks and asks whether to start a new shift or continue the current one — continuing requires the PIN of the cashier who started that shift. If they continue, the same prompt reappears on **every** subsequent auto-lock until a new shift is finally started.
- Orders are tagged by **room name** (e.g. *Duafe*), not room number.
- Generic app icon (favicon), and staff can type their PIN on a physical keyboard (PC) as well as the on-screen pad.
- **Installable app (PWA)** with **push notifications** — reception is alerted to new orders and messages even when the app tab is in the background or closed.
- **Admin can bulk-delete orders** created within a chosen date range (Settings → Delete orders).

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
In Netlify: **Site configuration → Environment variables → Add**. Set `SESSION_SECRET` plus **one** email backend:

| Key | Value |
|-----|-------|
| `SESSION_SECRET` | A long random string. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `GMAIL_USER` | Your Gmail address (Gmail backend) |
| `GMAIL_APP_PASSWORD` | A Gmail App Password — see "Sending with Gmail" below |
| `EMAIL_FROM` | e.g. `somewhere nice <youraddress@gmail.com>` |

(Prefer Resend instead? Set `RESEND_API_KEY` and leave the `GMAIL_*` vars blank.)

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

## Email

The app auto-selects a backend: **Gmail SMTP** if `GMAIL_USER` + `GMAIL_APP_PASSWORD` are set, otherwise **Resend** if `RESEND_API_KEY` is set, otherwise **dry-run** (logged only — handy for local testing).

### Sending with Gmail (App Password)

Gmail won't accept your normal password from an app, so you create a one-off **App Password**:

1. Turn on **2-Step Verification**: [myaccount.google.com/security](https://myaccount.google.com/security). (App Passwords only appear once 2-Step is on.)
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), name it e.g. "Laundry", and click **Create**.
3. Google shows a **16-character password** (four blocks of four). Copy it.
4. In Netlify → **Environment variables**, set:
   - `GMAIL_USER` = your Gmail address
   - `GMAIL_APP_PASSWORD` = that 16-character password (spaces are fine)
   - `EMAIL_FROM` = `somewhere nice <youraddress@gmail.com>`
5. **Deploys → Trigger deploy → Deploy site.**

Notes: Gmail sends from your real address (no domain setup needed) but caps at roughly **500 emails/day**, which is plenty for a hostel. If Google ever rotates/revokes the App Password, just create a new one and update `GMAIL_APP_PASSWORD`.

### Prefer Resend instead?

Set `RESEND_API_KEY` (and leave the `GMAIL_*` vars blank). Resend needs a **verified domain** to send from your own address — e.g. verify `hostelaccra.com` in Resend → Domains, then set `EMAIL_FROM="somewhere nice <info@hostelaccra.com>"`. Its sandbox sender `onboarding@resend.dev` only delivers to your own Resend signup email.

---

## Install the app + push notifications

The reception app is a **PWA**: open `https://<your-site>.netlify.app/app` in Chrome/Edge/Safari and choose **Install app** (desktop) or **Add to Home Screen** (mobile).

For notifications that arrive even when the app is closed, set up **Web Push** once:

1. Generate a key pair: `npm install` then `npm run gen-vapid`. It prints three values.
2. In Netlify → **Environment variables**, add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (e.g. `mailto:you@hostelaccra.com`).
3. Redeploy. In the app, each staff member taps **🔔 Enable alerts** once and allows notifications.

If you skip this, the app still works and still shows notifications while the tab is open in the background — you just won't get pushes when it's fully closed.

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
