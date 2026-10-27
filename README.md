# Airtable Cache Service

A targeted data service for static Center Centre sites that need live Airtable content without paying the latency cost on every page load.

The service has two jobs:

1. Act as a runtime cache in front of Airtable.
2. Publish per-site preload files so browser clients can start with data already on hand.

That combination lets static sites keep their current hosting and deployment model while moving dynamic content closer to first render.

## Why It Exists

Center Centre course sites are mostly static, but key conversion paths depend on frequently changing Airtable data such as cohort schedules and enrollment links. Direct client-side Airtable requests kept the operational model simple, but introduced a visible delay before critical page content appeared.

This service is a localized intervention. It avoids a full SSR migration, keeps the client request format backward compatible, and improves latency in two stages:

1. Runtime caching reduces repeated Airtable calls.
2. Prehydrated preload files let clients skip many network calls entirely.

## Request Model

`GET /v0/<airtable-path>?<original-query>&ref=<site-key>&refresh=true|false`

Behavior:

1. The route normalizes the Airtable request and resolves the site key from `ref` or `Referer`.
2. Cache identity ignores Airtable pagination offsets.
3. Airtable pages are merged into one cached dataset before persistence.
4. The response includes `X-Airtable-Cache` with `hit`, `stale`, `miss`, or `refresh`.

## Prehydrated Cache

Each site snapshot is stored as:

1. `data/cache/<site-token>.json` as the canonical on-disk record
2. `data/preloads/cache-<site-token>.js` as the derived, non-public preload artifact

The runtime serves the derived artifact at `/cache-<site-token>.js`; it is never placed in Next's `public` directory. A request checks the canonical snapshot first, rebuilds a missing or outdated artifact immediately, and never serves an artifact whose snapshot is missing or corrupt.

Only fresh, non-evicted entries are included. After the freshness deadline, a missing browser-cache entry uses the existing API fallback (which may return a stale response once while refreshing in the background). An already-loaded page's JavaScript object is not updated automatically.
Entries with invalid or future timestamps are ignored rather than repeatedly receiving a new freshness window.

Unchanged requests validate file metadata and stream the artifact without parsing its contents again. Content-hash ETags support conditional GET/HEAD; `If-Modified-Since` alone receives a full response to avoid false 304s for rapid updates. Range requests receive the full file. Preload serving does not require `AIRTABLE_API_KEY`.

## Fallback Chain

The service is designed as an enhancement, not a hard dependency.

1. Clients prefer the preloaded browser cache.
2. If the preload misses, clients can call this service.
3. If this service is unavailable, clients can still fall back to Airtable directly.

That keeps the integration low-risk for existing sites.

## Architecture

1. `app/v0/[[...path]]/route.ts` is the thin route adapter for Airtable requests.
2. `lib/airtable-cache/` contains request normalization, caching, persistence, and Airtable-specific behavior.
3. `lib/airtable-cache/persistence.ts` is the only preload generator/reconciler. `scripts/run-next-with-preloads.mjs` only removes obsolete generated files from `public` before it launches Next.
4. `tests/` covers route behavior, cache behavior, persistence, and regressions.

The live endpoints use the App Router. The tiny `pages/` files exist only because Next.js still expects `_document` and `404` during production builds.

## Configuration

Required for API requests (not for reading existing preloads):

1. `AIRTABLE_API_KEY`

Optional:

1. `CACHE_STALE_AFTER_MS`
2. `CACHE_EVICT_AFTER_MS`
3. `AIRTABLE_FETCH_TIMEOUT_MS`
4. `CACHE_DATA_DIR`
5. `CACHE_PRELOAD_DIR`
6. `AIRTABLE_API_BASE_URL`

Default policy:

1. Stale after 15 minutes
2. Evict after 72 hours

Eviction is based on `lastAccessedAt`, not only `updatedAt`.

Resource limits are explicit: 64 resident sites, 1,000 entries and a 4 MiB serialized snapshot budget per site, 256 persisted sites, and 128 concurrent API requests. Least-recently-used entries/sites are unloaded as needed; dirty access metadata is retained and retried. The merged upstream response is limited to 2 MiB and 100 pages, with one timeout covering the entire fetch including response bodies. Overload returns 503; a new site beyond the disk-site limit returns 507; oversized upstream data returns 502 instead of being truncated. These limits bound stored work, not total Node process memory. Existing deployments with larger datasets must assess these limits before rollout.

## Local Development
Use Node.js 24 for development and validation. With nvm, select the project version with:

```bash
nvm use
```

Install dependencies:

```bash
npm ci
npm run dev
```

Validation:

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

## Operational Notes

1. Generated files under `data/cache/` and `data/preloads/` should not be committed. `CACHE_PRELOAD_DIR` must be outside the project `public` directory.
2. Stop the process before manually removing snapshots to invalidate a loaded cache. A corrupt or oversized snapshot is rejected; remove that snapshot to allow the next API request to fetch it again.
3. The cache is process-local and assumes one Node process per VM. Filesystem commits and preload reconciliation are serialized inside that process; this is not a distributed lock.
4. Use `npm start` for deployment. It removes recognized legacy generated public preloads and their paired timestamp files before starting Next; unrelated files are preserved. Direct `next start` bypasses that cleanup. Both configured data directories need to be writable by the application user.
5. Snapshots remain on disk after resident eviction. At the 256-site limit, stop the service and archive unused snapshots and paired derived artifacts before admitting new sites.

## Upgrade Notes

- Keep the upstream Node 24 pin and dependency lockfile. No providers or hosting architecture change.
- `CACHE_PRELOAD_DIR` replaces `CACHE_PUBLIC_DIR` and must resolve outside `public`, including through symlinks. The default is `data/preloads`.
- Ordinary hostname preload URLs are unchanged. Refs with ports use `~` in filenames (`localhost:3000` becomes `cache-localhost~3000.js`), and very long refs use a bounded hashed token. Update hard-coded preload URLs for those exceptional refs; their old snapshots are not migrated automatically.
- Legacy JavaScript-only caches are no longer imported. Keep a backup before upgrading if they are the only copy; otherwise API misses fetch fresh Airtable data. `/preload-cache/<token>` and the startup preload-generation command are removed; the normal `/cache-<token>.js` URL now repairs itself at runtime.
- The browser cache still exports `cache` and assigns `window.airtableCache`. Encoded table paths are encoded once. Query order is preserved as supplied by Next; Next groups repeated parameters, so subscriber URLs should keep repeated `fields[]` parameters together.
- API and preload responses allow cross-origin public access. `ref` partitions caches; it is not an authorization boundary. The removed Zapier endpoint and its configuration/checks are not restored.
