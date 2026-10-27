import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HttpError } from "@/lib/airtable-cache/errors";
import {
  FileSystemCachePersistence,
  preloadPathForToken,
  reconcilePreloadArtifactForToken,
} from "@/lib/airtable-cache/persistence";
import { siteKeyToFileToken } from "@/lib/airtable-cache/request";
import { cleanupTempWorkspace, createTempWorkspace, createTestConfig, readPreloadCache, testLogger, writeSnapshot, type TestWorkspace } from "@/tests/test-utils";

const siteKey = "persistence.test";
const cacheKey = "https://api.airtable.com/v0/app123/Table?view=Grid";
let workspace: TestWorkspace;

afterEach(() => {
  if (workspace) cleanupTempWorkspace(workspace);
});

function createPersistence() {
  workspace = createTempWorkspace();
  return new FileSystemCachePersistence(createTestConfig(workspace), testLogger);
}

describe("file persistence", () => {
  it("writes canonical snapshots and non-public derived preloads with __proto__ preserved", async () => {
    const persistence = createPersistence();
    await persistence.saveSiteSnapshot(siteKey, {
      [cacheKey]: {
        body: JSON.parse('{"records":[],"__proto__":{"preserved":true}}') as never,
        updatedAt: Date.now(),
        lastAccessedAt: Date.now(),
      },
    }, 1);

    const token = siteKeyToFileToken(siteKey);
    const preloadPath = preloadPathForToken(createTestConfig(workspace), token);
    expect(preloadPath.startsWith(workspace.preloadDir)).toBe(true);
    expect(fs.existsSync(path.join(workspace.publicDir, `cache-${token}.js`))).toBe(false);
    expect(readPreloadCache(preloadPath)[cacheKey]).toHaveProperty("__proto__");
    expect(fs.readdirSync(workspace.preloadDir).every((name) => !name.endsWith(".tmp"))).toBe(true);
  });

  it("removes an artifact and returns a miss when its snapshot was deleted", async () => {
    const persistence = createPersistence();
    await persistence.saveSiteSnapshot(siteKey, {}, 1);
    const config = createTestConfig(workspace);
    const token = siteKeyToFileToken(siteKey);
    const preloadPath = preloadPathForToken(config, token);
    fs.rmSync(path.join(workspace.dataDir, `${token}.json`));
    await expect(persistence.loadSiteSnapshot(siteKey)).resolves.toBeNull();
    expect(fs.existsSync(preloadPath)).toBe(false);
  });

  it("removes an artifact before reporting a corrupt snapshot", async () => {
    createPersistence();
    const config = createTestConfig(workspace);
    const token = siteKeyToFileToken(siteKey);
    const preloadPath = preloadPathForToken(config, token);
    writeSnapshot(workspace, siteKey, { version: 1, siteKey, savedAt: 1, entries: {} });
    fs.writeFileSync(preloadPath, "stale", "utf8");
    fs.writeFileSync(path.join(workspace.dataDir, `${token}.json`), "{", "utf8");
    await expect(reconcilePreloadArtifactForToken(config, token)).rejects.toBeInstanceOf(HttpError);
    expect(fs.existsSync(preloadPath)).toBe(false);
  });

  it("rejects snapshot filename identities that do not match their site key", async () => {
    createPersistence();
    const token = siteKeyToFileToken(siteKey);
    writeSnapshot(workspace, siteKey, { version: 1, siteKey: "other.test", savedAt: 1, entries: {} });
    await expect(reconcilePreloadArtifactForToken(createTestConfig(workspace), token)).rejects.toBeInstanceOf(HttpError);
  });

  it("commits the canonical snapshot when derived artifact writing fails", async () => {
    const persistence = createPersistence();
    await persistence.saveSiteSnapshot(siteKey, {}, 1);
    const token = siteKeyToFileToken(siteKey);
    const snapshotPath = path.join(workspace.dataDir, `${token}.json`);
    const blockedPreloadDir = path.join(workspace.rootDir, "blocked-preloads");
    fs.writeFileSync(blockedPreloadDir, "not a directory", "utf8");
    const errorMessages: string[] = [];
    const blockedPersistence = new FileSystemCachePersistence(
      createTestConfig(workspace, { preloadCacheDir: blockedPreloadDir }),
      { ...testLogger, error: (message) => errorMessages.push(message) },
    );

    await expect(blockedPersistence.saveSiteSnapshot(siteKey, {
      [cacheKey]: { body: { records: [] }, updatedAt: 2, lastAccessedAt: 2 },
    }, 2)).resolves.toBeUndefined();
    expect(JSON.parse(fs.readFileSync(snapshotPath, "utf8"))).toMatchObject({
      savedAt: 2,
      entries: { [cacheKey]: { body: { records: [] } } },
    });
    expect(errorMessages).toContain(
      "Failed to reconcile the derived preload artifact after persisting a snapshot.",
    );
    expect(fs.readdirSync(workspace.dataDir).every((name) => !name.endsWith(".tmp"))).toBe(true);
  });

  it("loads a valid snapshot when artifact reconciliation is blocked, then rebuilds it on retry", async () => {
    createPersistence();
    const token = siteKeyToFileToken(siteKey);
    writeSnapshot(workspace, siteKey, {
      version: 1,
      siteKey,
      savedAt: 2,
      entries: {
        [cacheKey]: { body: { records: [] }, updatedAt: Date.now(), lastAccessedAt: Date.now() },
      },
    });
    const blockedPreloadDir = path.join(workspace.rootDir, "blocked-load-preloads");
    fs.writeFileSync(blockedPreloadDir, "not a directory", "utf8");
    const errors: string[] = [];
    const config = createTestConfig(workspace, { preloadCacheDir: blockedPreloadDir });
    const persistence = new FileSystemCachePersistence(
      config,
      { ...testLogger, error: (message) => errors.push(message) },
    );

    await expect(persistence.loadSiteSnapshot(siteKey)).resolves.toMatchObject({
      savedAt: 2,
      entries: { [cacheKey]: { body: { records: [] } } },
    });
    expect(errors).toContain("Failed to reconcile the derived preload artifact after loading a snapshot.");
    expect(fs.existsSync(preloadPathForToken(config, token))).toBe(false);

    fs.rmSync(blockedPreloadDir);
    fs.mkdirSync(blockedPreloadDir);
    const preloadPath = preloadPathForToken(config, token);
    await expect(reconcilePreloadArtifactForToken(config, token)).resolves.toBe(preloadPath);
    expect(readPreloadCache(preloadPath)[cacheKey]).toEqual({ records: [] });
  });

  it("reports snapshot write failures and leaves no temporary file", async () => {
    workspace = createTempWorkspace();
    const blockedDataDir = path.join(workspace.rootDir, "blocked-cache-data");
    fs.writeFileSync(blockedDataDir, "not a directory", "utf8");
    const persistence = new FileSystemCachePersistence(
      createTestConfig(workspace, { cacheDataDir: blockedDataDir }),
      testLogger,
    );

    await expect(persistence.saveSiteSnapshot(siteKey, {}, 1)).rejects.toMatchObject({
      code: "CACHE_WRITE_FAILED",
    });
    expect(fs.readdirSync(workspace.rootDir).every((name) => !name.endsWith(".tmp"))).toBe(true);
  });

  it("rebuilds a tampered artifact from its canonical snapshot", async () => {
    const persistence = createPersistence();
    await persistence.saveSiteSnapshot(siteKey, {
      [cacheKey]: { body: { records: [] }, updatedAt: Date.now(), lastAccessedAt: Date.now() },
    }, 1);
    const config = createTestConfig(workspace);
    const token = siteKeyToFileToken(siteKey);
    const preloadPath = preloadPathForToken(config, token);
    fs.writeFileSync(preloadPath, "tampered", "utf8");

    await expect(reconcilePreloadArtifactForToken(config, token)).resolves.toBe(preloadPath);
    expect(readPreloadCache(preloadPath)[cacheKey]).toEqual({ records: [] });
  });

  it("surfaces non-ENOENT snapshot filesystem failures instead of returning a miss", async () => {
    const persistence = createPersistence();
    const token = siteKeyToFileToken(siteKey);
    fs.mkdirSync(path.join(workspace.dataDir, `${token}.json`));

    await expect(persistence.loadSiteSnapshot(siteKey)).rejects.toMatchObject({
      code: "CACHE_READ_FAILED",
    });
  });

  it("persists maximum-length site tokens without overflowing temporary filenames", async () => {
    const persistence = createPersistence();
    const longSiteKey = "a".repeat(246);
    const token = siteKeyToFileToken(longSiteKey);
    const config = createTestConfig(workspace);

    await persistence.saveSiteSnapshot(longSiteKey, {}, 1);
    expect(fs.existsSync(path.join(workspace.dataDir, `${token}.json`))).toBe(true);
    expect(fs.existsSync(preloadPathForToken(config, token))).toBe(true);
    expect(fs.readdirSync(workspace.dataDir).every((name) => !name.endsWith(".tmp"))).toBe(true);
    expect(fs.readdirSync(workspace.preloadDir).every((name) => !name.endsWith(".tmp"))).toBe(true);
  });
});
