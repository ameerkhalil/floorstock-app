# FloorStock

Floor stock inventory and expiration tracker with UPC scanning. A real client-server
app: Node.js + Express API, SQLite database, and a browser frontend — every device
that opens the site talks to the same server and sees the same data.

## What's inside

```
floorstock-app/
  server.js          The API server (Express + SQLite)
  package.json        Dependencies
  public/index.html    The frontend (served by the API server)
  floorstock.db        Created automatically the first time you run the server
```

## Run it locally

You'll need [Node.js](https://nodejs.org) version 18 or newer installed.

1. Open a terminal in this folder.
2. Install dependencies:
   ```
   npm install
   ```
3. Start the server:
   ```
   npm start
   ```
4. Open `http://localhost:3000` in your browser.

That's it — the database file (`floorstock.db`) is created automatically on first run,
right next to `server.js`.

## Using it on multiple devices in your store

If you run the server on a computer connected to your store's Wi-Fi, other devices on
the *same network* (phones, tablets, another PC) can reach it using that computer's
local IP address instead of `localhost`. For example:

1. Find the computer's local IP address:
   - **Mac**: System Settings → Wi-Fi → Details (or run `ipconfig getifaddr en0` in Terminal)
   - **Windows**: run `ipconfig` in Command Prompt and look for "IPv4 Address"
2. On another device's browser, go to `http://<that-ip-address>:3000` — e.g. `http://192.168.1.42:3000`.

The computer running the server needs to stay on and awake for others to reach it, and
this only works while everyone is on the same local network.

## Hosting it so it's reachable from anywhere

For access from outside your store's network (e.g. from home, or from cellular data),
you'd deploy this to a small hosting provider instead of running it on a personal
computer. This code is a standard Node.js + Express app, so it works as-is on services
like:

- **Render** (render.com) — free/low-cost tier, straightforward for small Node apps
- **Railway** (railway.app)
- **Fly.io**
- Any VPS (DigitalOcean, Linode, etc.) running Node.js

General steps for most of these:
1. Push this folder to a GitHub repository.
2. Connect that repo to the hosting service.
3. Set the start command to `npm start` (most platforms auto-detect this from `package.json`).
4. Deploy — the platform gives you a public URL.

One note on SQLite specifically: some hosting platforms (like Render's free tier) use
*ephemeral* storage, meaning the `floorstock.db` file can get wiped on redeploys or
restarts. If you go this route and want data to survive long-term, look for a plan with
persistent disk storage, or ask about swapping SQLite for a hosted database (e.g.
Postgres) — the API layer in `server.js` is small enough that this is a straightforward
follow-up if you want it.

## API reference

All endpoints are under `/api/items` and return JSON.

| Method | Path              | Body                                                              | Description        |
|--------|-------------------|--------------------------------------------------------------------|---------------------|
| GET    | `/api/items`      | —                                                                  | List all items      |
| GET    | `/api/items/:id`  | —                                                                  | Get one item        |
| POST   | `/api/items`      | `{ upc, name, expirationDate, quantity, unit, location }`         | Create an item      |
| PUT    | `/api/items/:id`  | `{ upc, name, expirationDate, quantity, unit, location }`         | Update an item      |
| DELETE | `/api/items/:id`  | —                                                                  | Delete an item      |

`expirationDate` is a string in `YYYY-MM-DD` format. `quantity` is a non-negative number.

## Notes on scanning

UPC scanning uses the browser's built-in `BarcodeDetector` API, which currently works
in Chrome/Edge on Android and desktop. Where it's unsupported (notably Safari/iOS), the
app falls back to manual UPC entry — that fallback always works everywhere.
