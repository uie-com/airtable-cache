import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HttpError } from "@/lib/airtable-cache/errors";
import { FileSystemCachePersistence } from "@/lib/airtable-cache/persistence";
import { normalizeAirtableUrl, siteKeyToFileToken } from "@/lib/airtable-cache/request";
import {
  EXAMPLE_FILTERED_LABS_BODY,
  EXAMPLE_FILTERED_LABS_URL,
  EXAMPLE_PAGINATED_PAGE_ONE,
  EXAMPLE_PAGINATED_PAGE_TWO,
  EXAMPLE_TOPICS_URL,
  EXAMPLE_PUBLISHED_DATES_URL,
  EXAMPLE_SITE_KEY,
} from "@/tests/fixtures/cache-example";
import {
  createTempWorkspace,
  createTestConfig,
  readPreloadCache,
  testLogger,
} from "@/tests/test-utils";

describe("file system cache persistence", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const rootDir of workspaces.splice(0)) {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("migrates legacy paginated preload files into a canonical snapshot", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    const siteKey = "localhost:3000";
    const baseUrl =
      "https://api.airtable.com/v0/app123/tbl456?fields%5B%5D=Name&maxRecords=1";
    const legacyOffsetUrl = `${baseUrl}&offset=itrABC%2Frec001`;

    fs.writeFileSync(
      path.join(workspace.publicDir, "cache-localhost:3000.js"),
      `export const cache = {
  "${baseUrl}": {
    "records": [{ "id": "rec001" }],
    "offset": "itrABC/rec001"
  },
  "${legacyOffsetUrl}": {
    "records": [{ "id": "rec002" }]
  }
};
window.airtableCache = cache;
`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspace.publicDir, "timestamps-localhost:3000.json"),
      JSON.stringify(
        {
          [baseUrl]: 1_700_000_000_000,
          [legacyOffsetUrl]: 1_700_000_000_100,
        },
        null,
        2,
      ),
      "utf8",
    );

    const persistence = new FileSystemCachePersistence(
      createTestConfig(workspace),
      testLogger,
      () => 1_700_000_000_500,
    );
    const snapshot = await persistence.loadSiteSnapshot(siteKey);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.entries).toHaveProperty(baseUrl);
    expect(snapshot?.entries[baseUrl]?.body.records).toHaveLength(2);
    expect(snapshot?.entries[baseUrl]?.body).not.toHaveProperty("offset");

    const snapshotPath = path.join(
      workspace.dataDir,
      `${siteKeyToFileToken(siteKey)}.json`,
    );
    const preloadPath = path.join(
      workspace.publicDir,
      `cache-${siteKeyToFileToken(siteKey)}.js`,
    );

    expect(fs.existsSync(snapshotPath)).toBe(true);
    expect(fs.existsSync(preloadPath)).toBe(true);
    expect(fs.existsSync(path.join(workspace.publicDir, "cache-localhost:3000.js"))).toBe(false);
    expect(fs.existsSync(path.join(workspace.publicDir, "timestamps-localhost:3000.json"))).toBe(
      false,
    );

    const preloadCache = readPreloadCache(preloadPath);
    expect(Object.keys(preloadCache)).toEqual([baseUrl]);
    expect(preloadCache[baseUrl].records).toHaveLength(2);
    expect(preloadCache[baseUrl]).not.toHaveProperty("offset");
  });

  it("writes snapshots and preload files without leaving temp files behind", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    const siteKey = EXAMPLE_SITE_KEY;
    const cacheKey = EXAMPLE_FILTERED_LABS_URL;
    const persistence = new FileSystemCachePersistence(
      createTestConfig(workspace),
      testLogger,
      () => 1_700_000_000_500,
    );

    await persistence.saveSiteSnapshot(
      siteKey,
      {
        [cacheKey]: {
          body: {
            ...EXAMPLE_FILTERED_LABS_BODY,
            offset: "itrShouldNotPersist",
          },
          updatedAt: 1_700_000_000_000,
          lastAccessedAt: 1_700_000_000_100,
        },
      },
      1_700_000_000_500,
    );

    const snapshotPath = path.join(
      workspace.dataDir,
      `${siteKeyToFileToken(siteKey)}.json`,
    );
    const preloadPath = path.join(
      workspace.publicDir,
      `cache-${siteKeyToFileToken(siteKey)}.js`,
    );
    const snapshotContents = fs.readFileSync(snapshotPath, "utf8");
    const preloadCache = readPreloadCache(preloadPath);

    expect(snapshotContents).not.toContain("itrShouldNotPersist");
    expect(preloadCache[cacheKey]).not.toHaveProperty("offset");
    expect(fs.readdirSync(path.dirname(snapshotPath)).every((name) => !name.endsWith(".tmp"))).toBe(
      true,
    );
    expect(fs.readdirSync(path.dirname(preloadPath)).every((name) => !name.endsWith(".tmp"))).toBe(
      true,
    );
  });

  it("rolls back the snapshot when the preload write fails", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    const siteKey = EXAMPLE_SITE_KEY;
    const snapshotPath = path.join(
      workspace.dataDir,
      `${siteKeyToFileToken(siteKey)}.json`,
    );
    const blockedPublicDir = path.join(workspace.rootDir, "blocked-public-dir");
    fs.writeFileSync(blockedPublicDir, "not-a-directory", "utf8");

    fs.writeFileSync(
      snapshotPath,
      JSON.stringify(
        {
          version: 1,
          siteKey,
          savedAt: 1_700_000_000_000,
          entries: {
            [EXAMPLE_FILTERED_LABS_URL]: {
              body: EXAMPLE_FILTERED_LABS_BODY,
              updatedAt: 1_700_000_000_000,
              lastAccessedAt: 1_700_000_000_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const persistence = new FileSystemCachePersistence(
      createTestConfig(workspace, {
        publicCacheDir: blockedPublicDir,
      }),
      testLogger,
      () => 1_700_000_000_500,
    );

    await expect(
      persistence.saveSiteSnapshot(
        siteKey,
        {
          [EXAMPLE_FILTERED_LABS_URL]: {
            body: {
              records: [{ id: "recUpdated" }],
            },
            updatedAt: 1_700_000_000_500,
            lastAccessedAt: 1_700_000_000_500,
          },
        },
        1_700_000_000_500,
      ),
    ).rejects.toMatchObject({
      status: 500,
      code: "CACHE_WRITE_FAILED",
    });

    expect(JSON.parse(fs.readFileSync(snapshotPath, "utf8"))).toEqual({
      version: 1,
      siteKey,
      savedAt: 1_700_000_000_000,
      entries: {
        [EXAMPLE_FILTERED_LABS_URL]: {
          body: EXAMPLE_FILTERED_LABS_BODY,
          updatedAt: 1_700_000_000_000,
          lastAccessedAt: 1_700_000_000_000,
        },
      },
    });
  });

  it("surfaces filesystem write failures while saving snapshots", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    const blockedDirectoryPath = path.join(workspace.rootDir, "blocked-cache-dir");
    fs.writeFileSync(blockedDirectoryPath, "not-a-directory", "utf8");
    const persistence = new FileSystemCachePersistence(
      createTestConfig(workspace, {
        cacheDataDir: blockedDirectoryPath,
      }),
      testLogger,
      () => 1_700_000_000_500,
    );

    await expect(
      persistence.saveSiteSnapshot(
        EXAMPLE_SITE_KEY,
        {
          [EXAMPLE_FILTERED_LABS_URL]: {
            body: EXAMPLE_FILTERED_LABS_BODY,
            updatedAt: 1_700_000_000_000,
            lastAccessedAt: 1_700_000_000_100,
          },
        },
        1_700_000_000_500,
      ),
    ).rejects.toMatchObject({
      status: 500,
      code: "CACHE_WRITE_FAILED",
    });
  });

  it("rebuilds stale preload files from the canonical snapshot on load", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    const siteKey = EXAMPLE_SITE_KEY;
    const snapshotPath = path.join(
      workspace.dataDir,
      `${siteKeyToFileToken(siteKey)}.json`,
    );
    const preloadPath = path.join(
      workspace.publicDir,
      `cache-${siteKeyToFileToken(siteKey)}.js`,
    );

    fs.writeFileSync(
      snapshotPath,
      JSON.stringify(
        {
          version: 1,
          siteKey,
          savedAt: 1_700_000_000_000,
          entries: {
            [EXAMPLE_FILTERED_LABS_URL]: {
              body: EXAMPLE_FILTERED_LABS_BODY,
              updatedAt: 1_700_000_000_000,
              lastAccessedAt: 1_700_000_000_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(
      preloadPath,
      `export const cache = {
  "${EXAMPLE_FILTERED_LABS_URL}": {
    "records": [{ "id": "recStale" }]
  }
};
window.airtableCache = cache;
`,
      "utf8",
    );

    const persistence = new FileSystemCachePersistence(
      createTestConfig(workspace),
      testLogger,
      () => 1_700_000_000_500,
    );
    const snapshot = await persistence.loadSiteSnapshot(siteKey);

    expect(snapshot?.entries[EXAMPLE_FILTERED_LABS_URL]?.body).toEqual(EXAMPLE_FILTERED_LABS_BODY);
    expect(readPreloadCache(preloadPath)[EXAMPLE_FILTERED_LABS_URL]).toEqual(
      EXAMPLE_FILTERED_LABS_BODY,
    );
  });

  it("normalizes persisted snapshots by dropping invalid entries and stripping offsets", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    const siteKey = EXAMPLE_SITE_KEY;
    const snapshotPath = path.join(
      workspace.dataDir,
      `${siteKeyToFileToken(siteKey)}.json`,
    );

    fs.writeFileSync(
      snapshotPath,
      JSON.stringify(
        {
          version: 1,
          siteKey,
          entries: {
            [`${EXAMPLE_PUBLISHED_DATES_URL}&offset=itrIgnored`]: {
              body: {
                ...EXAMPLE_PAGINATED_PAGE_ONE,
              },
              updatedAt: "bad-timestamp",
              lastAccessedAt: 1_700_000_000_000,
            },
            "https://api.airtable.com/bad-url": {
              body: "bad-body",
            },
            [EXAMPLE_FILTERED_LABS_URL]: {
              body: EXAMPLE_FILTERED_LABS_BODY,
              updatedAt: 1_700_000_000_250,
              lastAccessedAt: "bad-timestamp",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const persistence = new FileSystemCachePersistence(
      createTestConfig(workspace),
      testLogger,
      () => 1_700_000_000_500,
    );
    const snapshot = await persistence.loadSiteSnapshot(siteKey);

    expect(snapshot?.entries).toEqual({
      [normalizeAirtableUrl(EXAMPLE_PUBLISHED_DATES_URL) as string]: {
        body: {
          records: EXAMPLE_PAGINATED_PAGE_ONE.records,
        },
        updatedAt: 1_700_000_000_500,
        lastAccessedAt: 1_700_000_000_000,
      },
      [EXAMPLE_FILTERED_LABS_URL]: {
        body: EXAMPLE_FILTERED_LABS_BODY,
        updatedAt: 1_700_000_000_250,
        lastAccessedAt: 1_700_000_000_250,
      },
    });
    expect(snapshot?.savedAt).toBe(1_700_000_000_500);
  });

  it("returns null when no snapshot or legacy files exist", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    const persistence = new FileSystemCachePersistence(
      createTestConfig(workspace),
      testLogger,
    );

    await expect(persistence.loadSiteSnapshot(EXAMPLE_SITE_KEY)).resolves.toBeNull();
  });

  it("surfaces non-parse snapshot read failures and preserves structured parse errors", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    const blockedDirectoryPath = path.join(workspace.rootDir, "blocked-read-dir");
    fs.writeFileSync(blockedDirectoryPath, "not-a-directory", "utf8");
    const readFailurePersistence = new FileSystemCachePersistence(
      createTestConfig(workspace, {
        cacheDataDir: blockedDirectoryPath,
      }),
      testLogger,
    );

    await expect(readFailurePersistence.loadSiteSnapshot(EXAMPLE_SITE_KEY)).rejects.toMatchObject({
      status: 500,
      code: "CACHE_READ_FAILED",
    });

    const snapshotPath = path.join(
      workspace.dataDir,
      `${siteKeyToFileToken(EXAMPLE_SITE_KEY)}.json`,
    );
    fs.writeFileSync(snapshotPath, "[]", "utf8");

    const parseFailurePersistence = new FileSystemCachePersistence(
      createTestConfig(workspace),
      testLogger,
    );

    await expect(parseFailurePersistence.loadSiteSnapshot(EXAMPLE_SITE_KEY)).rejects.toMatchObject({
      status: 500,
      code: "CACHE_PARSE_FAILED",
    });
  });

  it("rejects malformed persisted and legacy files", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    const siteKey = EXAMPLE_SITE_KEY;
    const snapshotPath = path.join(
      workspace.dataDir,
      `${siteKeyToFileToken(siteKey)}.json`,
    );
    fs.writeFileSync(snapshotPath, "{not-json", "utf8");

    const persistence = new FileSystemCachePersistence(
      createTestConfig(workspace),
      testLogger,
    );

    await expect(persistence.loadSiteSnapshot(siteKey)).rejects.toMatchObject({
      status: 500,
      code: "CACHE_PARSE_FAILED",
    });

    fs.rmSync(snapshotPath, { force: true });
    fs.writeFileSync(
      path.join(workspace.publicDir, "cache-influence.centercentre.com.js"),
      "window.airtableCache = cache;",
      "utf8",
    );

    await expect(persistence.loadSiteSnapshot(siteKey)).rejects.toMatchObject({
      status: 500,
      code: "CACHE_PARSE_FAILED",
    });

    await expect(
      (persistence as unknown as {
        readLegacyCacheFile(filePath: string): Promise<Record<string, unknown>>;
      }).readLegacyCacheFile(path.join(workspace.publicDir, "cache-influence.centercentre.com.js")),
    ).rejects.toMatchObject({
      status: 500,
      code: "CACHE_PARSE_FAILED",
    });

    try {
      await (persistence as unknown as {
        readLegacyCacheFile(filePath: string): Promise<Record<string, unknown>>;
      }).readLegacyCacheFile(path.join(workspace.publicDir, "cache-influence.centercentre.com.js"));
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }

    fs.rmSync(path.join(workspace.publicDir, "cache-influence.centercentre.com.js"), {
      force: true,
    });
    fs.writeFileSync(
      path.join(workspace.publicDir, "cache-influence.centercentre.com.js"),
      "export const cache = [];\nwindow.airtableCache = cache;\n",
      "utf8",
    );

    await expect(persistence.loadSiteSnapshot(siteKey)).rejects.toMatchObject({
      status: 500,
      code: "CACHE_PARSE_FAILED",
    });

    fs.rmSync(path.join(workspace.publicDir, "cache-influence.centercentre.com.js"), {
      force: true,
    });
    fs.writeFileSync(
      path.join(workspace.publicDir, "cache-influence.centercentre.com.js"),
      `export const cache = {
  "${EXAMPLE_FILTERED_LABS_URL}": ${JSON.stringify(EXAMPLE_FILTERED_LABS_BODY, null, 2)}
};
window.airtableCache = cache;
`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspace.publicDir, "timestamps-influence.centercentre.com.json"),
      JSON.stringify([], null, 2),
      "utf8",
    );

    await expect(persistence.loadSiteSnapshot(siteKey)).rejects.toMatchObject({
      status: 500,
      code: "CACHE_PARSE_FAILED",
    });

    fs.writeFileSync(
      path.join(workspace.publicDir, "timestamps-influence.centercentre.com.json"),
      "{not-json",
      "utf8",
    );

    await expect(persistence.loadSiteSnapshot(siteKey)).rejects.toMatchObject({
      status: 500,
      code: "CACHE_PARSE_FAILED",
    });
  });

  it("ignores incomplete legacy pagination chains instead of persisting partial merges", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    fs.writeFileSync(
      path.join(workspace.publicDir, "cache-influence.centercentre.com.js"),
      `export const cache = {
  "${EXAMPLE_PUBLISHED_DATES_URL}": ${JSON.stringify(EXAMPLE_PAGINATED_PAGE_ONE, null, 2)}
};
window.airtableCache = cache;
`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspace.publicDir, "timestamps-influence.centercentre.com.json"),
      JSON.stringify(
        {
          [EXAMPLE_PUBLISHED_DATES_URL]: 1_700_000_000_000,
          [`${EXAMPLE_PUBLISHED_DATES_URL}&offset=itrExamplePublished%2Frec0kecsFCvqKgw0C`]:
            1_700_000_000_100,
        },
        null,
        2,
      ),
      "utf8",
    );

    const persistence = new FileSystemCachePersistence(
      createTestConfig(workspace),
      testLogger,
      () => 1_700_000_000_500,
    );

    await expect(persistence.loadSiteSnapshot(EXAMPLE_SITE_KEY)).resolves.toBeNull();
  });

  it("migrates only complete legacy chains and falls back to now when timestamps are missing", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    const orphanOffsetUrl = `${EXAMPLE_TOPICS_URL}&offset=itrOrphan`;
    const loopBaseUrl = "https://api.airtable.com/v0/appLoop/tblLoop?view=Grid";
    const loopPageUrl = `${loopBaseUrl}&offset=itrLoop`;
    const badBaseUrl = "https://api.airtable.com/v0/appBad/tblBad?view=Grid";
    const badPageUrl = `${badBaseUrl}&offset=itrBad`;
    const secondPageUrl = `${EXAMPLE_PUBLISHED_DATES_URL}&offset=itrExamplePublished%2Frec0kecsFCvqKgw0C`;

    fs.writeFileSync(
      path.join(workspace.publicDir, "cache-influence.centercentre.com.js"),
      `export const cache = {
  "not-a-url": { "records": [{ "id": "recInvalid" }] },
  "${orphanOffsetUrl}": ${JSON.stringify(EXAMPLE_PAGINATED_PAGE_TWO, null, 2)},
  "${EXAMPLE_PUBLISHED_DATES_URL}": ${JSON.stringify(EXAMPLE_PAGINATED_PAGE_ONE, null, 2)},
  "${secondPageUrl}": ${JSON.stringify(EXAMPLE_PAGINATED_PAGE_TWO, null, 2)},
  "${loopBaseUrl}": {
    "records": [{ "id": "recLoopBase" }],
    "offset": "itrLoop"
  },
  "${loopPageUrl}": {
    "records": [{ "id": "recLoopPage" }],
    "offset": "itrLoop"
  },
  "${badBaseUrl}": {
    "records": "bad-records",
    "offset": "itrBad"
  },
  "${badPageUrl}": {
    "records": [{ "id": "recBadPage" }]
  }
};
window.airtableCache = cache;
`,
      "utf8",
    );

    const persistence = new FileSystemCachePersistence(
      createTestConfig(workspace),
      testLogger,
      () => 1_700_000_000_500,
    );
    const snapshot = await persistence.loadSiteSnapshot(EXAMPLE_SITE_KEY);
    const normalizedPublishedDatesUrl = normalizeAirtableUrl(EXAMPLE_PUBLISHED_DATES_URL);

    expect(snapshot).toEqual({
      version: 1,
      siteKey: EXAMPLE_SITE_KEY,
      savedAt: 1_700_000_000_500,
      entries: {
        [normalizedPublishedDatesUrl as string]: {
          body: {
            records: [
              ...(EXAMPLE_PAGINATED_PAGE_ONE.records as unknown[]),
              ...(EXAMPLE_PAGINATED_PAGE_TWO.records as unknown[]),
            ],
          },
          updatedAt: 1_700_000_000_500,
          lastAccessedAt: 1_700_000_000_500,
        },
      },
    });
  });

  it("treats legacy offset parsing failures as non-offset entries", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    const legacyOffsetUrl = `${EXAMPLE_TOPICS_URL}&offset=itrLegacy`;
    fs.writeFileSync(
      path.join(workspace.publicDir, "cache-influence.centercentre.com.js"),
      `export const cache = {
  "${legacyOffsetUrl}": ${JSON.stringify(EXAMPLE_FILTERED_LABS_BODY, null, 2)}
};
window.airtableCache = cache;
`,
      "utf8",
    );

    const NativeUrl = URL;
    const originalUrl = globalThis.URL;
    let airtableUrlCalls = 0;

    class FaultyUrl extends NativeUrl {
      constructor(input: string | URL, base?: string | URL) {
        if (typeof input === "string" && input === legacyOffsetUrl) {
          airtableUrlCalls += 1;
          if (airtableUrlCalls === 2) {
            throw new TypeError("offset parse failed");
          }
        }

        super(input, base);
      }
    }

    globalThis.URL = FaultyUrl as unknown as typeof URL;

    try {
      const persistence = new FileSystemCachePersistence(
        createTestConfig(workspace),
        testLogger,
      );
      const snapshot = await persistence.loadSiteSnapshot(EXAMPLE_SITE_KEY);

      expect(snapshot?.entries).toEqual({
        [normalizeAirtableUrl(legacyOffsetUrl) as string]: {
          body: EXAMPLE_FILTERED_LABS_BODY,
          updatedAt: expect.any(Number),
          lastAccessedAt: expect.any(Number),
        },
      });
    } finally {
      globalThis.URL = originalUrl;
    }
  });

  it("skips non-object values inside legacy cache files while keeping valid pages", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    const persistence = new FileSystemCachePersistence(
      createTestConfig(workspace),
      testLogger,
      () => 1_700_000_000_500,
    );
    const legacyCachePath = path.join(workspace.publicDir, "cache-influence.centercentre.com.js");

    fs.writeFileSync(
      legacyCachePath,
      `export const cache = {
  "${EXAMPLE_FILTERED_LABS_URL}": ${JSON.stringify(EXAMPLE_FILTERED_LABS_BODY, null, 2)},
  "ignored": "not-an-object"
};
window.airtableCache = cache;
`,
      "utf8",
    );

    await expect(
      (persistence as unknown as {
        readLegacyCacheFile(filePath: string): Promise<Record<string, unknown>>;
      }).readLegacyCacheFile(legacyCachePath),
    ).resolves.toEqual({
      [EXAMPLE_FILTERED_LABS_URL]: EXAMPLE_FILTERED_LABS_BODY,
    });
  });

  it("rethrows structured legacy cache parse errors without wrapping them", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    const persistence = new FileSystemCachePersistence(
      createTestConfig(workspace),
      testLogger,
    );
    const legacyCachePath = path.join(workspace.publicDir, "cache-influence.centercentre.com.js");

    fs.writeFileSync(
      legacyCachePath,
      "export const cache = [];\nwindow.airtableCache = cache;\n",
      "utf8",
    );

    try {
      await (persistence as unknown as {
        readLegacyCacheFile(filePath: string): Promise<Record<string, unknown>>;
      }).readLegacyCacheFile(legacyCachePath);
      throw new Error("Expected the legacy cache read to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({
        status: 500,
        code: "CACHE_PARSE_FAILED",
      });
    }
  });
});
