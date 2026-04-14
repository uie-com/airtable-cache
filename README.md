# Airtable Cache Service

This project is a persistent Airtable proxy for Center Centre sites.

It does three jobs:

1. Proxies Airtable `GET` requests through `/v0/...`
2. Caches merged Airtable datasets per site key in memory and on disk
3. Publishes a generated preload file for each site so clients can hydrate synchronously

The service is designed for a long-running VM process, not a function runtime.

## How It Works

Each Airtable request is scoped to a site key.

- Preferred: pass `?ref=<site-key>`
- Fallback: omit `ref` and send a valid `Referer` header

The route handler normalizes the request into one Airtable URL and one cache key.
`offset` is never part of the cache identity. A paginated Airtable query is always fetched and stored as one merged dataset.

### Request lifecycle

1. Parse the site key and Airtable path.
2. Load the site's JSON snapshot from `data/cache/` if it is not already in memory.
3. Return a hot cache hit immediately.
4. If the cached entry is stale, return it immediately and refresh it in the background.
5. On a cold miss or `refresh=true`, fetch every Airtable page, merge the records, persist the result, and return it.

### Persistence model

`data/cache/<site-token>.json` is the source of truth.

Each snapshot stores:

- `body`
- `updatedAt`
- `lastAccessedAt`

`public/cache-<site-token>.js` is generated from that snapshot and only contains the `url -> json` preload map used by clients.

Both files are written with temp-file rename semantics so partially written files are not served.

### Legacy migration

Older deployments wrote cache state directly to `public/cache-*.js` plus optional `timestamps-*.json`.

On first load, the service will:

- read supported legacy files for the requested site
- merge paginated fragments keyed by `offset`
- write the new JSON snapshot and generated preload file
- remove obsolete legacy files when the new files are in place

Historical filename variants are supported, including names such as `cache-localhost:3000.js`.

## Cache Policy

Default policy:

- stale after `15 minutes`
- evict after `72 hours`

Eviction uses `lastAccessedAt`, not only `updatedAt`.

Environment overrides:

- `CACHE_STALE_AFTER_MS`
- `CACHE_EVICT_AFTER_MS`
- `AIRTABLE_FETCH_TIMEOUT_MS`
- `CACHE_DATA_DIR`
- `CACHE_PUBLIC_DIR`
- `AIRTABLE_API_BASE_URL` for local/regression testing only

## API

### Airtable proxy

`GET /v0/<airtable-path>?<original-query>&ref=<site-key>&refresh=true|false`

Notes:

- `ref` must be a slug/hostname token, not a full URL
- base requests always return one merged dataset for paginated Airtable tables
- `refresh=true` bypasses the cached entry and fetches fresh Airtable data
- response headers include `X-Airtable-Cache` with `hit`, `stale`, `miss`, or `refresh`

### Zapier proxy

`POST /zapier?endpoint=<url>`

Required environment:

- `ZAPIER_SHARED_SECRET`
- `ZAPIER_ALLOWED_HOSTS` as a comma-separated allowlist

Required request auth:

- `x-zapier-secret: <secret>`
- or `Authorization: Bearer <secret>`

The endpoint host must be allowlisted. Arbitrary forwarding is intentionally blocked.

## Environment

Required:

- `AIRTABLE_API_KEY`

Optional:

- `CACHE_DATA_DIR`
- `CACHE_PUBLIC_DIR`
- `CACHE_STALE_AFTER_MS`
- `CACHE_EVICT_AFTER_MS`
- `AIRTABLE_FETCH_TIMEOUT_MS`
- `ZAPIER_SHARED_SECRET`
- `ZAPIER_ALLOWED_HOSTS`

## Development

Install dependencies:

```bash
npm install
```

Run the service:

```bash
npm run dev
```

Run the full validation gate:

```bash
npm run check
```

Other useful commands:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## File Layout

Important paths:

- `app/v0/[[...path]]/route.ts`: thin Airtable proxy route
- `app/zapier/route.ts`: thin Zapier route
- `lib/airtable-cache/`: request parsing, Airtable client, persistence, cache store, logging, config
- `lib/zapier/service.ts`: hardened Zapier forwarding
- `tests/`: request, persistence, route, and cache behavior coverage

The route handlers should stay small. If you need to change cache behavior, change the service modules first and keep the routes as adapters.

## Operational Notes

- Generated files under `data/cache/` and `public/cache-*.js` are runtime artifacts and should not be committed.
- If a snapshot becomes corrupted, delete the affected `data/cache/<site-token>.json` and the next request will rebuild it from Airtable.
- If an old deployment still has `public/cache-*.js` files only, the first request for that site will migrate them.
- The service assumes one Node process per VM. It does not coordinate cache state across multiple workers or multiple machines.
