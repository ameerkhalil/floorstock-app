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
- **Daily email digest** — once a day, managers get an email listing everything expired,
  critical, or expiring soon. Nothing sends if there's nothing to flag. Needs a one-time
  email service setup — see below.
- **CSV export** — the "Export" button downloads the current store's full inventory.
- **Home screen install** — the app has a proper icon and name for "Add to Home Screen"
  on phones, so it opens full-screen instead of living in a browser tab.
- **Worker password reset** — managers can reset a worker's password from Manage →
  Workers without deleting and recreating the account.
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

### Important: existing data isn't tied to a store

If you had test items in the app before store accounts existed, they aren't associated
with any store and won't show up. Sign up as a manager and re-add them.


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
| GET    | `/api/workers`                | manager  | List worker logins for your store          |
| POST   | `/api/workers`                | manager  | Create a worker login                      |
| PUT    | `/api/workers/:id/password`   | manager  | Reset a worker's password                  |
| DELETE | `/api/workers/:id`            | manager  | Remove a worker login                      |
| GET    | `/api/audit`                  | manager  | Recent activity log (last 200 entries)     |
| GET    | `/api/categories`             | any      | List your store's categories               |
| POST   | `/api/categories`             | manager  | Create a category; body `{ name, color }` (color is `#rrggbb`) |
| PUT    | `/api/categories/:id`         | manager  | Update a category's name/color             |
| DELETE | `/api/categories/:id`         | manager  | Remove a category (items keep their other data, category just clears) |
| POST   | `/api/digest/send-test`       | manager  | Send the manager a digest email right now  |
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
| DELETE | `/api/items/:id`              | any      | Delete an item                             |

`expirationDate` is `YYYY-MM-DD`. `quantity` is a non-negative number.

## Notes on the UPC lookup

It checks [Open Food Facts](https://world.openfoodfacts.org) first (free, no key, no
rate limit worth worrying about, huge food/beverage coverage) and falls back to
UPCitemdb's free trial tier for non-food items it doesn't have. Because Open Food Facts
is food/beverage-focused, things like household goods, tobacco, or auto items may still
come back "not found" — that's expected, and the form always accepts a manually typed
name either way. If you want broader non-food coverage later, swapping in a paid lookup
provider only requires editing the one function in `server.js` that calls these services
(`/api/upc-lookup/:upc`) — the frontend doesn't need to change.

