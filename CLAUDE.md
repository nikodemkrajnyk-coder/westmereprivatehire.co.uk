# Westmere Private Hire — engineering notes

Node/Express backend in `server/` (better-sqlite3), static customer/staff HTML apps at the repo root. Entry point `server/index.js`; public routes mounted at `/api/public`, authed routes at `/api`. Deploy = fast-forward `main` → nixpacks auto-build. Rollback tag: `pre-redesign-backup`.

Run the payment regression guard before deploying anything that touches bookings, payments or emails:

```
node server/tests/payment-flow.test.js      # or: npm test
```

## Payment invariants — DO NOT REGRESS

These three invariants exist because of a real incident (the "Mr Ben" booking): a card choice was recorded as cash, the estimate email's Pay/Cash links didn't work, and "Send Estimate" auto-confirmed the booking. Each has an automated guard in `server/tests/payment-flow.test.js`.

### 1. Payment method is explicit, validated, and never silently defaulted
- A booking's `payment` is one of `pending | card | cash | account | invoice` (`server/payment-methods.js`).
- `pending` means *no choice yet*. It is the ONLY default. **Never write `x || 'cash'`** — an unknown/blank method must resolve to `pending` and be logged (`normalizePaymentMethod`), never assumed to be cash.
- `payment='card'` is written ONLY by a genuine card payment (the Stripe `payment_intent.succeeded` webhook). `payment='cash'` is written ONLY by the customer's explicit "pay your driver" action (`POST /api/public/pay/:ref/cash`). Both go through `assertPaymentMethod`.
- The `PATCH /bookings/:id` API rejects an unknown `payment` value (400).

### 2. Estimate & confirmation emails carry WORKING, tokenised payment links
- Every secure email link (Pay Now, Cash, Cancel, Add-a-note) is gated by the per-booking secret `pay_token`, minted once via `intake.ensurePayToken(bookingId)` (idempotent — never re-mint, or you invalidate the token in an already-sent email).
- The **estimate** email (`sendCustomerEstimate`) and the **confirmation** email (`sendCustomerConfirmed`) both include the tokenised Pay Now / Pay-driver(cash) / Cancel actions. The `send-estimate` route mints the token before sending, so the links always work.
- URLs are built against `HOST = https://westmereprivatehire.co.uk`. Pay page: `/westmere-pay.html?ref=&t=`. Actions: `/api/public/pay/:ref/cash?t=`, `/api/public/cancel/:ref?t=`, `/api/public/note/:ref?t=`.

### 3. Estimate-first: "Send Estimate" must NEVER auto-confirm
- `POST /bookings/:id/send-estimate` sets the fare (if supplied), mints the token, and sends the estimate email. It **does not change `status`** — the booking stays `pending`.
- A booking becomes `confirmed` ONLY when the customer acts:
  - pays by **card** → Stripe webhook sets `payment='card'`, `paid_at`, `status: pending→confirmed`;
  - chooses **pay driver on the day** → `POST /pay/:ref/cash` sets `payment='cash'`, `status: pending→confirmed`;
  - or is **cancelled** → `/cancel/:ref` sets `status='cancelled'`.
- Both owner-app entry points (inline job card `ownerSendEstimate`, edit modal `ebSendEstimate`) and admin (`admSendEstimate`) call `/send-estimate`. **None of them may `PATCH {status:'confirmed'}`.** A separate explicit "Confirm" action is the only place that force-confirms.
- Email-client link prefetch must never mutate state: state changes (mark cash, cancel) are POST-only; the GET pages only render a confirm screen.

## Timezone invariant — dates are wall-clock, not instants

`bookings.date` (`YYYY-MM-DD`) and `bookings.time` (`HH:MM`, default `ASAP`) are **UK wall-clock strings**, not instants. Railway runs UTC; dev machines and customer devices do not. Guard: `node server/tests/timezone-dayofweek.test.js` (re-execs itself under 6 host timezones).

- To **display** a booking date, render its literal components — do no timezone conversion at all. Build it with `Date.UTC(y, m-1, d)` and format with `timeZone:'UTC'` (server: `formatDate` in `email.js`; client: `drvDayLabel` in `westmere-driver.html`).
- **Never** `new Date('2026-08-16')` — that parses as UTC midnight and then reads back in *local* time, so it renders **Saturday 15th** on any host or device west of UTC.
- **Never** pin the formatter to `Europe/London` while parsing the string as a local instant. `new Date('2026-08-16T21:00')` formatted with `timeZone:'Europe/London'` renders **Monday 17 August** west of London. This is the tempting wrong fix; the test asserts it stays broken so nobody reintroduces it.
- **Never** build a `Date` out of `date + 'T' + time` without excluding `ASAP` — `'2026-08-16TASAP'` is an Invalid Date. This shipped, and put "Invalid Date" in every ASAP booking's emails.
- For "today", use `toLocaleDateString('sv-SE', {timeZone:'Europe/London'})`, not `toISOString().split('T')[0]` — the UTC date is still yesterday between 00:00 and 01:00 BST.
- Comparing an instant to a wall-clock time (the 12h reminder sweeper) is fine as long as *both* sides are built the same naive way — see `ukNowMs`/`pickupMs` in `reminder.js`.

## Local dev

```
PORT=3007 node server/index.js
```

Secrets (`RESEND_API_KEY`, `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`, Google, etc.) live in the deploy environment, not in the repo — so email/Stripe are inert locally. Test route logic by seeding a booking directly into `data/westmere.db`.
