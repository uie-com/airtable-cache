import fs, { promises as files } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/[preloadFile]/route";
import { createAirtableConfig } from "@/lib/airtable-cache/config";
import { FileSystemCachePersistence, reconcilePreloadArtifactForToken } from "@/lib/airtable-cache/persistence";
import { createAirtableCacheService } from "@/lib/airtable-cache/service";
import { AirtableClient } from "@/lib/airtable-cache/airtable-client";
import { createTempWorkspace, createTestConfig, cleanupTempWorkspace, readPreloadCache, testLogger, writeSnapshot } from "@/tests/test-utils";

const workspaces: ReturnType<typeof createTempWorkspace>[] = [];
const site = "functional.test";
const key = "https://api.airtable.com/v0/app123/Table%20Name?fields%5B%5D=Name";
function setup() {
  const workspace = createTempWorkspace();
  workspaces.push(workspace);
  const config = createTestConfig(workspace, { staleAfterMs: 100, evictAfterMs: 200 });
  return { workspace, config };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const workspace of workspaces.splice(0)) cleanupTempWorkspace(workspace);
});

describe("functional acceptance regressions", () => {
  it("reports a real stalled HTTP response body as a timeout", async () => {
    const { config } = setup();
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"records":[');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const client = new AirtableClient({ ...config, fetchTimeoutMs: 50 }, testLogger);
      await expect(client.fetchMergedResponse(`http://127.0.0.1:${address.port}/v0/test`)).rejects.toMatchObject({ status: 504, code: "AIRTABLE_TIMEOUT" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects overload instead of retaining unlimited queued requests", async () => {
    const { config } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = createAirtableCacheService({ config, logger: testLogger, fetchImpl: async () => {
      await gate;
      return Response.json({ records: [] });
    } });
    const requests = Array.from({ length: 129 }, () => service.handle({ siteKey: site, cacheKey: key, airtableUrl: key, forceRefresh: false })
      .then((response) => response.status, (error) => error.status));
    try {
      expect(await Promise.race([requests[128], new Promise((resolve) => setTimeout(() => resolve("still queued"), 50))])).toBe(503);
    } finally {
      release();
      await Promise.all(requests);
      await service.waitForIdle();
    }
  });

  it("bounds response bytes from a real chunked HTTP server", async () => {
    const { config } = setup();
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"data":"');
      res.end(`${"x".repeat(2 * 1024 * 1024)}"}`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const client = new AirtableClient(config, testLogger);
      await expect(client.fetchMergedResponse(`http://127.0.0.1:${address.port}/v0/test`)).rejects.toMatchObject({ code: "AIRTABLE_RESPONSE_TOO_LARGE" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses new durable sites at capacity while existing sites remain writable", async () => {
    const { workspace, config } = setup();
    for (let i = 0; i < 256; i++) writeSnapshot(workspace, `site-${i}`, { version: 1, siteKey: `site-${i}`, savedAt: 1, entries: {} });
    const persistence = new FileSystemCachePersistence(config, testLogger);
    await expect(persistence.saveSiteSnapshot("overflow", {}, Date.now())).rejects.toMatchObject({ status: 507 });
    await expect(persistence.saveSiteSnapshot("site-0", {}, Date.now())).resolves.toBeUndefined();
    expect(fs.readdirSync(workspace.dataDir).length).toBe(256);
  });

  it("rejects oversized canonical snapshots before loading them", async () => {
    const { workspace, config } = setup();
    writeSnapshot(workspace, site, { version: 1, siteKey: site, savedAt: 1, entries: {
      [key]: { body: { data: "x".repeat(4 * 1024 * 1024) }, updatedAt: 1, lastAccessedAt: 1 },
    } });
    await expect(new FileSystemCachePersistence(config, testLogger).loadSiteSnapshot(site)).rejects.toMatchObject({ code: "CACHE_TOO_LARGE" });
  });

  it("evicts old entries by bytes before reaching the entry-count cap", async () => {
    const { workspace, config } = setup();
    let now = 10_000;
    const service = createAirtableCacheService({ config, logger: testLogger, now: () => now,
      fetchImpl: async () => Response.json({ data: "x".repeat(1_500_000) }),
    });
    for (let i = 0; i < 3; i++) {
      now++;
      await service.handle({ siteKey: site, cacheKey: `${key}&item=${i}`, airtableUrl: `${key}&item=${i}`, forceRefresh: false });
    }
    await service.waitForIdle();
    const snapshotPath = path.join(workspace.dataDir, `${site}.json`);
    expect(fs.statSync(snapshotPath).size).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(Object.keys(JSON.parse(fs.readFileSync(snapshotPath, "utf8")).entries)).toEqual([`${key}&item=1`, `${key}&item=2`]);
  });

  it("does not keep future-dated preload data fresh across successive validations", async () => {
    const { workspace, config } = setup();
    writeSnapshot(workspace, site, { version: 1, siteKey: site, savedAt: 1_000_000, entries: {
      [key]: { body: { records: [1] }, updatedAt: 1_000_000, lastAccessedAt: 1_000_000 },
    } });
    for (const now of [10_000, 10_200]) {
      const artifact = (await reconcilePreloadArtifactForToken(config, site, () => now))!;
      expect(Object.keys(readPreloadCache(artifact))).toEqual([]);
    }
  });

  it("retains failed access metadata under resident pressure and persists it after recovery", async () => {
    const { workspace, config } = setup();
    let now = 10_000;
    const entries = { [key]: { body: { records: [1] }, updatedAt: now, lastAccessedAt: now } };
    for (let i = 0; i < 65; i++) writeSnapshot(workspace, `site-${i}`, { version: 1, siteKey: `site-${i}`, savedAt: now, entries });
    const originalRename = files.rename.bind(files);
    vi.spyOn(files, "rename").mockImplementation(async (from, to) => {
      if (String(to) === path.join(workspace.dataDir, "site-0.json")) throw new Error("disk temporarily unavailable");
      return originalRename(from, to);
    });
    const service = createAirtableCacheService({ config, logger: testLogger, now: () => now,
      fetchImpl: async () => { throw new Error("upstream unavailable"); },
    });
    now += 50;
    for (let i = 0; i < 65; i++) {
      await service.handle({ siteKey: `site-${i}`, cacheKey: key, airtableUrl: key, forceRefresh: false });
      await service.waitForIdle();
    }
    vi.restoreAllMocks();
    // An evicted site-0 would reload its old timestamp and attempt an upstream fetch.
    now = 10_210;
    const response = await service.handle({ siteKey: "site-0", cacheKey: key, airtableUrl: key, forceRefresh: false });
    expect(response.headers?.["X-Airtable-Cache"]).toBe("stale");
    await service.waitForIdle();
    expect(JSON.parse(fs.readFileSync(path.join(workspace.dataDir, "site-0.json"), "utf8")).entries[key].lastAccessedAt).toBe(now);
  });

  it("serializes a missing-preload check against the first canonical save", async () => {
    const { workspace, config } = setup();
    const snapshotPath = path.join(workspace.dataDir, `${site}.json`);
    const originalStat = files.stat.bind(files);
    let entered!: () => void;
    let release!: () => void;
    const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
    const releaseGate = new Promise<void>((resolve) => { release = resolve; });
    let gated = false;
    vi.spyOn(files, "stat").mockImplementation((async (...args: Parameters<typeof files.stat>) => {
      if (String(args[0]) === snapshotPath && !gated) {
        gated = true;
        entered();
        await releaseGate;
        throw Object.assign(new Error("missing at check time"), { code: "ENOENT" });
      }
      return originalStat(...args);
    }) as typeof files.stat);
    const check = reconcilePreloadArtifactForToken(config, site);
    await enteredGate;
    const save = new FileSystemCachePersistence(config, testLogger).saveSiteSnapshot(site, {}, Date.now());
    // Let the old implementation finish its uncoordinated write before releasing the check.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await Promise.all([check, save]);
    expect(fs.existsSync(path.join(workspace.preloadDir, `cache-${site}.js`))).toBe(true);
  });

  it("expires preload data without an API request or snapshot modification", async () => {
    const { workspace, config } = setup();
    let now = 1_000;
    const persistence = new FileSystemCachePersistence(config, testLogger, () => now);
    await persistence.saveSiteSnapshot(site, { [key]: { body: { records: [1] }, updatedAt: now, lastAccessedAt: now } }, now);
    const artifact = (await reconcilePreloadArtifactForToken(config, site, () => now))!;
    expect(readPreloadCache(artifact)[key]).toEqual({ records: [1] });
    now += 100;
    await reconcilePreloadArtifactForToken(config, site, () => now);
    expect(readPreloadCache(artifact)).not.toHaveProperty(key);
    expect(fs.existsSync(path.join(workspace.dataDir, `${site}.json`))).toBe(true);
  });

  it("keeps validated preload reads stat-only after a metadata-only save", async () => {
    const { config } = setup();
    let now = Date.now();
    const persistence = new FileSystemCachePersistence(config, testLogger, () => now);
    const entries = { [key]: { body: { records: [1] }, updatedAt: now, lastAccessedAt: now } };
    await persistence.saveSiteSnapshot(site, entries, now);
    await new Promise((resolve) => setTimeout(resolve, 20));
    now++;
    await persistence.saveSiteSnapshot(site, { [key]: { ...entries[key], lastAccessedAt: now } }, now);
    // Observe real filesystem I/O, not calls to an internal implementation helper.
    const open = vi.spyOn(files, "open");
    const artifact = (await reconcilePreloadArtifactForToken(config, site, () => now))!;
    expect(open).not.toHaveBeenCalled();
    expect(readPreloadCache(artifact)[key]).toEqual({ records: [1] });
  });

  it("serves valid preloads without upstream credentials", async () => {
    const { workspace } = setup();
    vi.stubEnv("AIRTABLE_API_KEY", "");
    vi.stubEnv("AIRTABLE_FETCH_TIMEOUT_MS", "not-needed-for-preloads");
    vi.stubEnv("CACHE_DATA_DIR", workspace.dataDir);
    vi.stubEnv("CACHE_PRELOAD_DIR", workspace.preloadDir);
    const now = Date.now();
    writeSnapshot(workspace, site, { version: 1, siteKey: site, savedAt: now, entries: {
      [key]: { body: { records: [1] }, updatedAt: now, lastAccessedAt: now },
    } });
    const response = await GET(new NextRequest(`http://test/cache-${site}.js`), { params: Promise.resolve({ preloadFile: `cache-${site}.js` }) });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Table%20Name");
  });

  it("rejects a preload directory symlink into public even when the child is absent", () => {
    const { workspace } = setup();
    const alias = path.join(workspace.rootDir, "alias");
    fs.symlinkSync(workspace.publicDir, alias);
    expect(() => createAirtableConfig({ NODE_ENV: "test", AIRTABLE_API_KEY: "test", CACHE_PRELOAD_DIR: path.join(alias, "generated") }, workspace.rootDir)).toThrow(/public/i);
  });

  it("unloads future-dated snapshots without a repeating timer", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(10_000);
    const { workspace, config } = setup();
    writeSnapshot(workspace, site, { version: 1, siteKey: site, savedAt: Date.now(), entries: {
      [key]: { body: { records: [1] }, updatedAt: 1_000_000, lastAccessedAt: 1_000_000 },
    } });
    const service = createAirtableCacheService({ config, logger: testLogger, fetchImpl: async () => Response.json({ records: [1] }) });
    await service.handle({ siteKey: site, cacheKey: key, airtableUrl: key, forceRefresh: false });
    await service.waitForIdle();
    await vi.advanceTimersByTimeAsync(250);
    expect(vi.getTimerCount()).toBe(0);
  });
});
