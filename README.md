# FloorStock

Floor stock inventory and expiration tracker with UPC scanning, product auto-recognition,
and multi-store accounts. A real client-server app: Node.js + Express API, SQLite
database, and a browser frontend.

## Features

- **Manager signup** creates a store (name + address) and a manager login for it, plus
  an email address used for the daily expiration digest.
- **Managers add worker logins** from the "Manage" button — username and password, no
  email required for workers.
- **Each store's inventory is completely separate** — a worker or manager can only ever
  see and edit their own store's items.
- **UPC scanning + product auto-recognition** via a free barcode database, with manual
  entry always available as a fallback.
- **Camera scanning works on iPhone/Safari** (via [ZXing](https://github.com/zxing-js/library),
  not the Safari-unsupported `BarcodeDetector` API).
- **Duplicate-batch detection** — scanning or typing a UPC that's already on the floor
  shows the existing batch(es) with an "Add units here" option, instead of always
  creating a new separate tag.
- **Activity log** — every add/edit/remove/restock and worker change is recorded with
  who did it and when, visible to managers under Manage → Activity.
- **Configurable expiration email frequency** — daily, every other day, weekly,
  every 2 weeks, or monthly. Managers pick from Manage → Email digest. Nothing sends if
  there's nothing to flag, regardless of how often it's checked.
- **CSV export** — the "Export" button downloads the current store's full inventory.
- **Home screen install** — the app has a proper icon and name for "Add to Home Screen"
  on phones, so it opens full-screen instead of living in a browser tab.
- **Manager and worker password reset** — workers get reset by their manager from
  Manage → Workers; managers reset their own via an emailed link from the sign-in
  screen's "Forgot password?" link.
- **Paid subscriptions** — a 14-day free trial per store (no card required), then a flat
  monthly or annual subscription via Stripe. Managers can subscribe, update their card,
  or cancel from Manage → Billing. Needs a one-time Stripe setup — see below.
- **Custom product categories** — managers define their own categories (e.g. Food,
  Drinks, Salty, Snacks) with any color they like, from Manage → Categories. Items show
  a colored category pill, and the dashboard breaks down counts by category.
- **Drink/product size detection** — scanning a UPC tries to auto-detect the size (e.g.
  "500 mL", "12 oz") from the product database. When it can't, there's a manual size
  field (value + oz/mL/L/gal) right in the item form.
- **Dashboard home view** — the top of the inventory screen now shows stat tiles (total
  tags, expired, critical, expiring soon, locations) and clickable category chips that
  filter the list below.
- **Multiple expiration dates per add** — the New Tag form lets you add several
  expiration-date/quantity batches for the same scanned product in one go (e.g. a
  shipment with three different expiration dates), instead of repeating the whole form.
- **Cost price, selling price, and a margin suggestion** — enter a cost price and pick a
  target margin (defaults to 50%, the standard "keystone" retail benchmark, but you can
  set any percentage) and the selling price is suggested automatically, fully editable.
  When available, a scanned product also shows a "typically sells for $X–$Y" reference
  from market data.
- **Shrink report** — pick a reason (Sold / Expired / Other) each time you remove a tag,
  and Manage → Reports shows money lost to expiration vs. revenue and profit from items
  sold before they expired, over a selectable time period.
- **Automated weekly backup email** — every store's manager automatically gets a CSV
  snapshot of their inventory emailed weekly, as a portable copy of their data. This is
  *not* a substitute for real infrastructure-level backup of the whole database — see
  the note in "Data safety" below.
- **A public-facing landing intro** — the sign-in screen now leads with what the product
  does and its key features, for first-time visitors, not just a bare login form.
- **Basic rate limiting** — login, signup, and password-reset endpoints are throttled
  per IP to make brute-force guessing impractical.

### Important: existing data isn't tied to a store

If you had test items in the app before store accounts existed, they aren't associated
with any store and won't show up. Sign up as a manager and re-add them.

### Data safety: what the automated backup does and doesn't cover

The weekly backup email gives each manager a portable CSV of their own store's
inventory — useful if you ever want your data outside the app, or as a sanity check.
It does **not** protect the underlying database file itself (accounts, worker logins,
billing state, all stores at once) against corruption or disk loss. For that, you'd
want either Render's own disk snapshot feature (check current availability/pricing on
your plan) or a scheduled export of the whole SQLite file to external storage — a
reasonable next step if this becomes business-critical, but out of scope for what's
built here today.


## What's inside

```
floorstock-app/
  server.js               The API server (Express + SQLite + sessions + digest emailer)
  package.json             Dependencies
  public/index.html         The frontend (login/signup + the inventory app)
  public/manifest.json       Home-screen install metadata
  public/icon-192.png         App icon
  public/icon-512.png
  public/apple-touch-icon.png
  .node-version             Pins Node to a stable LTS version
  floorstock.db              Created automatically the first time you run the server
```

## Run it locally

You'll need [Node.js](https://nodejs.org) version 20 (see `.node-version`).

1. Open a terminal in this folder.
2. Install dependencies: `npm install`
3. Start the server: `npm start`
4. Open `http://localhost:3000` — you'll land on a sign-in screen. Use the "New store"
   tab to create your manager account the first time.

## Using it on multiple devices in your store

Same as before — other devices on your store's Wi-Fi can reach it via your computer's
local IP address (`http://<that-ip>:3000`) instead of `localhost`. See below for finding
that IP.

- **Mac**: System Settings → Wi-Fi → Details (or `ipconfig getifaddr en0` in Terminal)
- **Windows**: run `ipconfig` in Command Prompt, look for "IPv4 Address"

## Deploying (Render, Railway, Fly.io, a VPS, etc.)

Push this folder to GitHub, connect it to your hosting provider, set the start command
to `npm start`.

### Setting up a persistent disk on Render

By default, Render's disk is *ephemeral* — a redeploy can wipe your SQLite file,
including accounts and inventory. If you're on a paid Render plan, fix this once:

1. In the Render dashboard, open your service → **Disks** → **Add Disk**.
2. Give it a name, a size (1 GB is overkill for this app), and a **mount path** —
   e.g. `/data`.
3. Add an environment variable: **Key** `DB_PATH`, **Value** `/data/floorstock.db`.
4. Redeploy. From then on, the database file lives on the persistent disk and survives
   redeploys and restarts.

### Setting up the daily email digest

The digest uses [Resend](https://resend.com) to send email — free tier covers 100
emails/day, no credit card required.

1. Sign up at resend.com and create an **API key**.
2. In Render, add an environment variable: **Key** `RESEND_API_KEY`, **Value** your key.
3. (Optional) By default, digests send from `onboarding@resend.dev`, Resend's shared
   sending address. Without verifying your own domain on Resend, that address may only
   reliably deliver to the email you signed up to Resend with. If you want it to email
   an address that isn't your Resend account's own email, verify a domain in Resend
   (their dashboard walks you through the DNS records) and set an environment variable
   **Key** `DIGEST_FROM_EMAIL`, **Value** something like `alerts@yourdomain.com`.
4. (Optional) The digest checks hourly and sends once per store per day at 13:00 UTC by
   default (roughly 8–9am US Eastern). To change it, add an environment variable **Key**
   `DIGEST_HOUR_UTC`, **Value** an hour 0–23 in UTC.
5. Redeploy. Managers can send themselves a test email anytime from Manage → Email
   digest, without waiting for the scheduled time.

If `RESEND_API_KEY` is never set, the digest feature simply stays off — everything else
in the app works the same either way.

### Setting up billing (Stripe)

Every new store gets a 14-day free trial automatically, no card required. After that,
managers are prompted to subscribe — with a choice of **monthly** or **annual** billing.
This needs a one-time Stripe setup:

1. Create a free account at [stripe.com](https://stripe.com). No business details are
   required to start in **test mode** — you can build and test the whole flow before
   ever going live.
2. In the Stripe dashboard, go to **Product catalog** → **Add product**. Name it
   something like "FloorStock Subscription". Under pricing, add a **Recurring** price
   with a **Monthly** billing period and save. Then, on that same product, click **Add
   another price** and add a second **Recurring** price with a **Yearly** billing period
   (typically discounted vs. 12x the monthly price, but that's up to you). Keeping both
   prices on one product (rather than creating two separate products) keeps your catalog
   simpler.
3. Open each price and copy its **Price ID** (starts with `price_`) — you'll have two:
   one for monthly, one for annual.
4. Go to **Developers** → **API keys**. Copy the **Secret key** (starts with `sk_test_`
   while in test mode).
5. In Render, add these environment variables:
   - **Key** `STRIPE_SECRET_KEY`, **Value** the secret key from step 4
   - **Key** `STRIPE_PRICE_ID_MONTHLY`, **Value** the monthly price ID from step 3
   - **Key** `STRIPE_PRICE_ID_ANNUAL`, **Value** the annual price ID from step 3
   - (Only offering one billing period? Just set whichever one applies — the app only
     shows a subscribe button for plans that have a price ID configured. The legacy
     variable name `STRIPE_PRICE_ID` still works as the monthly price if you'd rather
     not rename it.)
6. Set up the webhook so Stripe can tell your app when someone pays. Stripe's dashboard
   recently renamed this area to **Workbench** — webhooks live in its **Webhooks** tab
   (`dashboard.stripe.com/webhooks`), and what used to be called a "webhook endpoint" is
   now called an **event destination**:
   - Go to `dashboard.stripe.com/webhooks` → **Create new destination**.
   - Choose **Events on your account** (not Connected accounts).
   - Select these event types: `checkout.session.completed`,
     `customer.subscription.updated`, `customer.subscription.created`,
     `customer.subscription.deleted`. Continue.
   - Choose **Webhook** as the destination type. Endpoint URL:
     `https://<your-render-url>/api/webhooks/stripe`. Create the destination.
   - Open it and reveal the **Signing secret** (starts with `whsec_`).
   - In Render, add environment variable **Key** `STRIPE_WEBHOOK_SECRET`, **Value** that
     signing secret.
7. Redeploy. Sign up a test store and try Manage → Billing — you should see both
   "Subscribe monthly" and "Subscribe annually" buttons. In test mode, Stripe's checkout
   accepts the card number `4242 4242 4242 4242` with any future expiry date and any
   CVC.
8. When you're ready to charge real cards, flip Stripe out of test mode (top-right
   toggle in their dashboard), repeat steps 2–6 for **live mode** (live keys and
   live prices are separate from test ones), and update the Render environment
   variables with the live values.

If `STRIPE_SECRET_KEY` is never set, billing stays off entirely and the app is fully
usable without any trial limit — useful if you want to run it for your own store only,
without charging anyone.

**Changing the trial length or prices:** the trial length is controlled by the optional
`TRIAL_DAYS` environment variable (defaults to 14). The prices themselves live entirely
in Stripe — change the amount on the Price in Stripe's dashboard (Stripe recommends
creating a new Price rather than editing an old one, since existing subscribers stay on
whatever Price they signed up under unless you migrate them).

**A note on handling your Stripe secret key:** treat `sk_test_...` / `sk_live_...`
values as passwords — don't paste them anywhere outside Render's environment variable
fields (not in chat, not in code, not in this README). If one ever gets exposed, roll it
from Stripe's API keys page immediately; the old value stops working right away.

## API reference

All endpoints are JSON (except the CSV export). Session cookie (`floorstock_sid`) is set
on login/registration and required on the routes marked "auth".

| Method | Path                          | Auth     | Description                              |
|--------|-------------------------------|----------|--------------------------------------------|
| POST   | `/api/auth/register-store`    | —        | Create a store + manager account, sign in  |
| POST   | `/api/auth/login`             | —        | Sign in as manager or worker               |
| POST   | `/api/auth/logout`            | —        | End the session                            |
| GET    | `/api/auth/me`                | —        | Current session info, if any               |
| POST   | `/api/auth/forgot-password`   | —        | Email a manager a password reset link      |
| POST   | `/api/auth/reset-password`    | —        | Set a new password using a reset token     |
| GET    | `/api/workers`                | manager  | List worker logins for your store          |
| POST   | `/api/workers`                | manager  | Create a worker login                      |
| PUT    | `/api/workers/:id/password`   | manager  | Reset a worker's password                  |
| DELETE | `/api/workers/:id`            | manager  | Remove a worker login                      |
| GET    | `/api/audit`                  | manager  | Recent activity log (last 200 entries)     |
| GET    | `/api/reports/shrink`         | manager  | Money lost/saved from removals; query `?days=30` |
| GET    | `/api/categories`             | any      | List your store's categories               |
| POST   | `/api/categories`             | manager  | Create a category; body `{ name, color }` (color is `#rrggbb`) |
| PUT    | `/api/categories/:id`         | manager  | Update a category's name/color             |
| DELETE | `/api/categories/:id`         | manager  | Remove a category (items keep their other data, category just clears) |
| GET    | `/api/store/digest-frequency` | manager  | Current email frequency setting            |
| PUT    | `/api/store/digest-frequency` | manager  | Update it; body `{ frequency }` (daily/every_other_day/weekly/biweekly/monthly) |
| POST   | `/api/digest/send-test`       | manager  | Send the manager a digest email right now  |
| POST   | `/api/backup/send-test`       | manager  | Send the manager a backup email right now  |
| GET    | `/api/billing/status`         | any      | Current trial/subscription status          |
| POST   | `/api/billing/create-checkout-session` | manager | Start a Stripe Checkout session; body `{ plan: "monthly" \| "annual" }` |
| POST   | `/api/billing/create-portal-session`   | manager | Open Stripe's billing portal (update card, cancel) |
| GET    | `/api/billing/confirm-checkout` | manager | Confirm a just-completed checkout immediately |
| POST   | `/api/webhooks/stripe`        | —        | Stripe calls this; not for direct use      |
| GET    | `/api/upc-lookup/:upc`        | any      | Look up a product name by UPC              |
| GET    | `/api/items`                  | any      | List your store's items                    |
| GET    | `/api/items/by-upc/:upc`      | any      | Find existing batches with this UPC        |
| GET    | `/api/items/export.csv`       | any      | Download the store's inventory as CSV      |
| POST   | `/api/items`                  | any      | Create an item                             |
| POST   | `/api/items/:id/add-quantity` | any      | Add units to an existing batch             |
| PUT    | `/api/items/:id`              | any      | Update an item                             |
| DELETE | `/api/items/:id`              | any      | Delete an item; body `{ reason }` (sold/expired/other) |

`expirationDate` is `YYYY-MM-DD`. `quantity` is a non-negative number.

## Notes on the UPC lookup

Scanning a UPC checks, in order:

1. **A shared cache** — if any store has ever successfully looked up this exact UPC
   before, the result comes back instantly with no external API call at all. This
   cache grows over time and meaningfully stretches free lookup quotas, since popular
   products get scanned repeatedly across every store using the app.
2. **[Open Food Facts](https://world.openfoodfacts.org)** — free, no key required, no
   rate limit worth worrying about, huge global food/beverage coverage.
3. **USDA FoodData Central** — free, US government database, strong on branded US
   packaged food and beverage products. Requires a free API key (see below); the
   source is simply skipped if you don't set one up.
4. **UPCitemdb's free trial tier** — covers more non-food items, but is capped at 100
   combined lookups per day, shared across every store using this deployment (not per
   store). This is why it's tried last, after the two unlimited free sources above.

Because coverage still leans food/beverage, things like household goods, tobacco, or
auto parts may come back "not found" — that's expected, and the form always accepts a
manually typed name either way.

### Setting up the free USDA source (optional, no cost)

1. Go to [fdc.nal.usda.gov/api-key-signup](https://fdc.nal.usda.gov/api-key-signup) and
   request a free API key — no credit card, just an email address.
2. In Render, add environment variable **Key** `USDA_FDC_API_KEY`, **Value** the key you
   received.
3. Redeploy. The startup logs will confirm whether it picked up the key.

### If you outgrow the free sources

If you eventually need broader non-food coverage or hit real limits with real volume,
UPCitemdb's paid DEV plan ($99/month for 20,000 lookups/day at time of writing) uses the
exact same database as the free tier — it just removes the shared rate limit. Swapping
it in only requires changing the `lookupUpcItemDb` function in `server.js` to call the
paid endpoint (`/prod/v1/lookup` with an API key header instead of `/prod/trial/lookup`)
— the frontend and the rest of the lookup chain don't need to change.