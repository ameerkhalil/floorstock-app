# FloorStock

Floor stock inventory and expiration tracker with UPC scanning, product auto-recognition,
and multi-store accounts. A real client-server app: Node.js + Express API, SQLite
database, and a browser frontend.

## What's new: accounts and per-store data

- **Manager signup** creates a store (name + address) and a manager login for it.
- **Managers add worker logins** from the "Workers" button in the app header — just a
  username and password, no email required.
- **Each store's inventory is completely separate.** A worker or manager can only ever
  see and edit their own store's items.
- **Scanning a UPC now looks up the product** against a free public barcode database and
  pre-fills the product name (still editable, and it gracefully falls back to manual
  entry when a product isn't found).
- **Camera scanning now works on iPhone/Safari.** The previous version used a browser API
  (`BarcodeDetector`) that Safari never implemented. It's been replaced with a
  JavaScript-based scanner ([ZXing](https://github.com/zxing-js/library)) that works the
  same way across Chrome, Safari, and Android/iOS.

### Important: existing data isn't tied to a store

If you had test items in the app before this update, they aren't associated with any
store account and won't show up anymore. Sign up as a manager and re-add them — sorry
for the inconvenience, but there was no store to attach that old data to.

## What's inside

```
floorstock-app/
  server.js             The API server (Express + SQLite + sessions)
  package.json           Dependencies
  public/index.html       The frontend (login/signup + the inventory app)
  .node-version            Pins Node to a stable LTS version
  floorstock.db             Created automatically the first time you run the server
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

Same as before: push this folder to GitHub, connect it to your hosting provider, set the
start command to `npm start`. See the earlier setup notes if you've already deployed
once — you'll just need to push these updated files and let it redeploy.

One consequence of adding accounts: since sessions and worker logins are stored in the
same SQLite file as your inventory, the same *ephemeral storage* caveat applies to all of
it now, not just items. On hosts with ephemeral disks, a redeploy can wipe accounts too,
which would require re-registering your store. If that becomes a problem, ask about
moving to a persistent disk or a hosted database — the app is small enough that this is a
contained change later.

## API reference

All endpoints are JSON. Session cookie (`floorstock_sid`) is set on login/registration
and required on the routes marked "auth".

| Method | Path                      | Auth     | Description                              |
|--------|---------------------------|----------|-------------------------------------------|
| POST   | `/api/auth/register-store`| —        | Create a store + manager account, sign in |
| POST   | `/api/auth/login`         | —        | Sign in as manager or worker              |
| POST   | `/api/auth/logout`        | —        | End the session                           |
| GET    | `/api/auth/me`            | —        | Current session info, if any              |
| GET    | `/api/workers`            | manager  | List worker logins for your store         |
| POST   | `/api/workers`            | manager  | Create a worker login                     |
| DELETE | `/api/workers/:id`        | manager  | Remove a worker login                     |
| GET    | `/api/upc-lookup/:upc`    | any      | Look up a product name by UPC             |
| GET    | `/api/items`              | any      | List your store's items                   |
| POST   | `/api/items`              | any      | Create an item                            |
| PUT    | `/api/items/:id`          | any      | Update an item                            |
| DELETE | `/api/items/:id`          | any      | Delete an item                            |

`expirationDate` is `YYYY-MM-DD`. `quantity` is a non-negative number.

## Notes on the UPC lookup

It uses UPCitemdb's free trial endpoint, which doesn't require an API key but is capped
at roughly 100 lookups per day per server. If you outgrow that, swapping in a paid
lookup provider only requires changing the one function in `server.js` that calls it
(`/api/upc-lookup/:upc`) — the frontend doesn't need to change.

