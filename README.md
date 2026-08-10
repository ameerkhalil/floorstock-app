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
| POST   | `/api/digest/send-test`       | manager  | Send the manager a digest email right now  |
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

