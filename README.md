# Airtable Cache

The **Airtable Cache** is a tiny proxy layer in front of the Airtable REST API that dramatically reduces perceived load time for our React sites.  
It does this by (1) caching GET responses per-site, (2) publishing that cache as a public JS file that ships with your site, and (3) checking that file synchronously during the very first render — so data is there **before** the UI paints.

## 🧭 Overview

- **Drop-in proxy**: React apps rewrite Airtable API requests to the cache service URL instead of the Airtable API.
- **Warm, per-site memory**: First time a request is seen, the cache forwards to Airtable, stores the JSON, and returns it.  
  Next time, it returns immediately and refreshes in the background if stale.
- **Static preload**: For each site (identified by a slug/hostname), the cache writes a **public JS file** that exports the site’s request→response map and attaches it to `window.airtableCache`.  
  Each React app loads this file at startup to get “instant” data.

Result: common views render with fresh data without any visible loading states.

## ✨ Key Behaviors

- **Cache TTL**: in-memory entries are considered stale after **5 minutes** and refresh in the background.  
- **Garbage collection**: entries unused for **24 hours** are dropped.
- **Per-site isolation**: cache is keyed by the site slug/hostname; sites do not share entries.
- **Non-critical**: if the cache is unreachable, the async helpers fall back to Airtable directly — pages still work (just slower).

## 🧑‍💻 Client Usage

Use the shared helpers under `shared/data/airtable/` in your codebase. Each helper has **sync** and **async** flavors:

- **Sync (“cache”) helpers** — labeled with “cache”:  
  - Meant for **initial render** (server or client)  
  - Read from the preloaded JS file (`window.airtableCache`) synchronously  
  - No network, instant return

- **Async helpers** — e.g., `airtableFetch(url)`:  
  - Check the preloaded file first  
  - Then call the cache service  
  - If that fails, **fallback to Airtable API** directly

> These fallbacks make the cache an **important but non-critical** service.

## ⚙️ Configuration (per-site slug)

Every site identifies itself with a unique **slug** so it can read/write the correct cache file.

- In local dev, the slug comes from the dev script (e.g., `npm run dev:my-site`) and populates an env like `VITE_APP`.
- In production, ensure the same slug is set for **all** deployments of the same site so they share the same preload file.

## 📦 Preloading the Cache (static file)

Once your site routes its Airtable calls through the helpers, the cache will start generating the per-site preload file automatically.

Add this to your site’s `<head>` (replace `[SLUG]` with your slug or hostname):

```html
<script type="module" src="https://airtable.centercentre.com/cache-[SLUG].centercentre.com.js"></script>
```

- The server writes files named `public/cache-[referrerHostname].js` (derived from the `ref` query param or the request’s `Referer` host).
- The file looks like:

  ```js
  export const cache = { /* url → json */ };
  window.airtableCache = cache;
  ```

> If you’ve added a **new** slug, you may need to restart the service (per your deployment) so the file is publicly served.

## 🔌 API (Cache Service)

The cache is a **Next.js** app with a single route that handles **all GETs** as if it were Airtable. It preserves path and query, with two additional parameters:

- `ref` — site slug/hostname (string). If missing, the cache tries to infer it from the HTTP `Referer` header’s hostname (falls back to `unknown`).
- `refresh` — `"true"` or `"false"` (string). When `true`, bypasses the in-memory entry and fetches live from Airtable.

### Request mapping

- Incoming request:  
  `GET https://airtable.centercentre.com/app/**...**?<original_query>&ref=<slug>&refresh=<bool>`
- The server rewrites to Airtable:  
  `GET https://api.airtable.com/**...**?<original_query>` (removing `ref` and `refresh`)

### Response

- Returns Airtable’s JSON payload and HTTP status.  
- On **cache hit** and `refresh !== "true"`: responds immediately from memory (200) and may refresh in the background if stale.  
- On **cache miss**: fetches from Airtable, stores the result (per `ref` + URL), saves/updates the preload file, returns the JSON.

## 🗃️ Caching Rules (from code)

- **TTL** (`REFRESH_INTERVAL`): `5 * 60 * 1000` ms (5 minutes)  
  > After TTL, a hit still returns **instantly**, but the server kicks off a background refresh.
- **GC** (`FORGET_INTERVAL`): `24 * 60 * 60 * 1000` ms (24 hours)  
  > Entries older than GC with no refresh are deleted during refresh passes.
- **Per-site dictionary**:  
  `cache[referrer][url] = json`  
  `timestamps[referrer][url] = lastUpdatedMs`

## 🔒 Security Notes

- The Airtable API key is **server-side only** (never placed in the preload file).
- Consider restricting who can call the cache:
  - add an **Origin allowlist**,
  - or require a **shared secret** header/query,
  - or place the service behind your network edge.
- The cache **only supports GET**; do not route mutations through it.

## 🛠️ Environment

Create `.env.local` in the project root:

| Variable             | Purpose |
|---|---|
| `AIRTABLE_API_KEY` | Airtable API key used by the proxy to call `api.airtable.com`. |

> Do **not** commit secrets. Use a secrets manager in production.

## 🏗️ Hosting

- Next.js app hosted on your infrastructure (e.g., a droplet/VM).  
- Public base URL (examples above use `https://airtable.centercentre.com`).  
- Ensure the process has write access to `public/` to emit **cache preload** files.  
- Per your platform, a restart may be required for newly created preload files to be served publicly.

## 🧪 Local Setup

1. Clone & install  
   ```bash
   git clone https://github.com/uie-com/airtable-cache
   cd airtable-cache
   npm install
   ```

2. Configure env  
   ```dotenv
   AIRTABLE_API_KEY=YOUR_KEY
   ```

3. Run  
   ```bash
   npm run dev
   # Then call it like you'd call Airtable (append ?ref=<slug>):
   curl "http://localhost:3000/app/v0/appXXXXXXXX/tblYYYYYYYY?maxRecords=1&ref=my-site"
   ```

4. Add the preload script to your site  
   ```html
   <script type="module" src="http://localhost:3000/cache-my-site.js"></script>
   ```

## 🧩 Integration Tips

- Route **all Airtable GETs** through the shared helpers in `shared/data/airtable`.
- Keep a stable **slug** across environments for the same site so they share the same preload file.
- When you add a brand-new slug/hostname, verify the cache file exists at:  
  `/cache-<slug>.js` on the cache server.

## 🧰 Troubleshooting

- **I don’t see `window.airtableCache` on first paint**  
  - Confirm the preload script tag URL (hostname/slug) is correct.  
  - Ensure the cache service wrote `public/cache-<slug>.js` and it’s being served.  
  - Restart the cache service if your platform needs it to serve new files.

- **Data changes aren’t visible immediately**  
  - TTL is 5 minutes. Force live data by adding `&refresh=true` to the request (async paths only).

- **The cache is down**  
  - Async helpers will fall back to Airtable API directly; pages will work with normal loading spinners.

## 📄 License

Released under the **MIT License**. See `LICENSE`.