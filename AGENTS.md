# Repository guide

## Stack and boundaries
- Actual organizational upstream: https://github.com/uie-com/airtable-cache. This checkout's `origin` points to the older personal repository https://github.com/alextyang/airtable-cache-service; do not equate origin/main with the latest organizational release.
- Next.js 16 App Router, TypeScript, React 19; Node 24 runtime and filesystem persistence.
- HTTP routes call request normalization and the cache service. The cache store coordinates Airtable fetching and persistence; persistence owns canonical JSON snapshots and derived preload artifacts.
- `data/cache` snapshots are canonical. `data/preloads` artifacts are derived and served by the runtime preload route.
- Deployment assumes one Node process per VM. Preserve the current architecture and integration providers.
- Filesystem snapshot/artifact operations share a bounded process-wide queue. API state remains process-local; do not run multiple writers against these directories.
- Limits: 128 active API requests, 64 resident sites, 1,000 entries/4 MiB per snapshot, 256 durable sites, 2 MiB/100 pages per merged upstream response. Preserve explicit overload errors and LRU behavior.
- Preloads contain only fresh entries, use content ETags, and require no upstream credentials. Preserve exact subscriber URL keys as received from Next.
- Review tasks do not authorize application changes or publication.

## Commands
- Install the locked dependencies: `npm ci`.
- Full verification: `npm run check` (lint, typecheck, unit/integration tests, production build and HTTP regressions).
- Focused tests: `npm test -- <test-path>`; coverage: `npm run test:coverage`.
- Production dependency audit: `npm audit --package-lock-only --omit=dev`.
- Start: `npm start`; development: `npm run dev`. These use the startup cleanup wrapper.

## Execution rules
- Keep one active task in TODO.md, with an explicit acceptance gate.
- Reproduce bugs at real HTTP, filesystem, or persistence boundaries before fixing them.
- Prefer concrete, legible code; avoid speculative abstractions and tangential refactors.
- Keep this guide and TODO.md synchronized. Never store credentials in repository memory.
<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
