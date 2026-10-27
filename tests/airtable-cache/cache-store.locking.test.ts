import { afterEach, describe, expect, it, vi } from "vitest";

import { AirtableCacheStore } from "@/lib/airtable-cache/cache-store";
import { HttpError } from "@/lib/airtable-cache/errors";
import {
  AirtableClientContract,
  CacheEntryState,
  CachePersistence,
  SiteSnapshot,
} from "@/lib/airtable-cache/types";
import {
  EXAMPLE_FILTERED_LABS_BODY,
  EXAMPLE_FILTERED_LABS_URL,
  EXAMPLE_PUBLISHED_DATES_BODY,
  EXAMPLE_PUBLISHED_DATES_URL,
  EXAMPLE_SITE_KEY,
} from "@/tests/fixtures/cache-example";
import {
  cleanupTempWorkspace,
  createTempWorkspace,
  createTestConfig,
} from "@/tests/test-utils";

type PrivateSiteCacheState = {
  loaded: boolean;
  entries: Record<string, CacheEntryState>;
  refreshingCacheKeys: Set<string>;
  hasQueuedPersist: boolean;
  metadataPersistDirty: boolean;
  pendingAccessedAt: Record<string, number>;
  activeRequestCount: number;
  lastUsedAt: number;
};

describe("airtable cache store locking and edge cases", () => {
  const workspaces: ReturnType<typeof createTempWorkspace>[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const workspace of workspaces.splice(0)) {
      cleanupTempWorkspace(workspace);
    }
  });

  it("returns a hit from the locked section when another request already populated the cache", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          status: 200,
          body: EXAMPLE_FILTERED_LABS_BODY,
          pageCount: 1,
        };
      }),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace),
      persistence,
      client,
      {
        info() {},
        warn() {},
        error() {},
      },
      () => 1_700_000_000_000,
    );

    const request = {
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: false,
      airtableUrl: EXAMPLE_FILTERED_LABS_URL,
      cacheKey: EXAMPLE_FILTERED_LABS_URL,
    };

    const [firstResponse, secondResponse] = await Promise.all([
      store.resolve(request),
      store.resolve(request),
    ]);

    expect(firstResponse.headers?.["X-Airtable-Cache"]).toBe("miss");
    expect(secondResponse.headers?.["X-Airtable-Cache"]).toBe("hit");
    expect(client.fetchMergedResponse).toHaveBeenCalledTimes(1);
  });

  it("rethrows unexpected load errors without wrapping them", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockRejectedValue(new Error("boom")),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace),
      persistence,
      client,
      {
        info() {},
        warn() {},
        error() {},
      },
    );

    await expect(
      store.resolve({
        siteKey: EXAMPLE_SITE_KEY,
        forceRefresh: false,
        airtableUrl: EXAMPLE_FILTERED_LABS_URL,
        cacheKey: EXAMPLE_FILTERED_LABS_URL,
      }),
    ).rejects.toThrow("boom");
  });

  it("waits for a replacement queue before reporting the site as idle", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace),
      persistence,
      client,
      {
        info() {},
        warn() {},
        error() {},
      },
    );
    const privateStore = store as unknown as {
      siteQueueByKey: Map<string, Promise<void>>;
    };

    let resolveFirstQueue!: () => void;
    let resolveSecondQueue!: () => void;
    const firstQueue = new Promise<void>((resolve) => {
      resolveFirstQueue = resolve;
    });
    const secondQueue = new Promise<void>((resolve) => {
      resolveSecondQueue = resolve;
    });

    privateStore.siteQueueByKey.set(EXAMPLE_SITE_KEY, firstQueue);

    let resolved = false;
    const waitPromise = store.waitForIdle(EXAMPLE_SITE_KEY).then(() => {
      resolved = true;
    });

    privateStore.siteQueueByKey.set(EXAMPLE_SITE_KEY, secondQueue);
    resolveFirstQueue();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolved).toBe(false);

    resolveSecondQueue();
    await waitPromise;
    expect(resolved).toBe(true);
  });

  it("waits across every queued site when no site key is provided", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace),
      persistence,
      client,
      {
        info() {},
        warn() {},
        error() {},
      },
    );
    const privateStore = store as unknown as {
      siteQueueByKey: Map<string, Promise<void>>;
    };

    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    privateStore.siteQueueByKey.set(
      EXAMPLE_SITE_KEY,
      new Promise<void>((resolve) => {
        resolveFirst = resolve;
      }),
    );
    privateStore.siteQueueByKey.set(
      "labs.centercentre.com",
      new Promise<void>((resolve) => {
        resolveSecond = resolve;
      }),
    );

    let resolved = false;
    const waitPromise = store.waitForIdle().then(() => {
      resolved = true;
    });

    resolveFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);

    resolveSecond();
    await waitPromise;
    expect(resolved).toBe(true);
  });

  it("skips snapshot loading when the site is already marked as loaded", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace),
      persistence,
      client,
      {
        info() {},
        warn() {},
        error() {},
      },
    );
    const privateStore = store as unknown as {
      siteStateByKey: Map<string, PrivateSiteCacheState>;
      ensureSiteLoaded(siteKey: string): Promise<void>;
    };

    privateStore.siteStateByKey.set(EXAMPLE_SITE_KEY, {
      loaded: true,
      entries: {},
      refreshingCacheKeys: new Set<string>(),
      hasQueuedPersist: false,
      metadataPersistDirty: false,
      pendingAccessedAt: {},
      activeRequestCount: 0,
      lastUsedAt: 1_700_000_000_000,
    });

    await privateStore.ensureSiteLoaded(EXAMPLE_SITE_KEY);

    expect(persistence.loadSiteSnapshot).not.toHaveBeenCalled();
  });

  it("rethrows HttpError refresh failures from the exclusive section unchanged", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const timeoutError = new HttpError(
      504,
      "AIRTABLE_TIMEOUT",
      "Timed out while waiting for Airtable.",
    );
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn().mockRejectedValue(timeoutError),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace),
      persistence,
      client,
      {
        info() {},
        warn() {},
        error() {},
      },
    );

    await expect(
      store.resolve({
        siteKey: EXAMPLE_SITE_KEY,
        forceRefresh: true,
        airtableUrl: EXAMPLE_FILTERED_LABS_URL,
        cacheKey: EXAMPLE_FILTERED_LABS_URL,
      }),
    ).rejects.toBe(timeoutError);
  });

  it("skips background refreshes that become fresh before the lock is acquired", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const now = 1_700_000_000_000;
    const store = new AirtableCacheStore(
      createTestConfig(workspace, { staleAfterMs: 100 }),
      persistence,
      client,
      {
        info() {},
        warn() {},
        error() {},
      },
      () => now,
    );
    const privateStore = store as unknown as {
      siteQueueByKey: Map<string, Promise<void>>;
      siteStateByKey: Map<string, PrivateSiteCacheState>;
      scheduleBackgroundRefresh(siteKey: string, cacheKey: string, airtableUrl: string): void;
    };

    privateStore.siteStateByKey.set(EXAMPLE_SITE_KEY, {
      loaded: true,
      entries: {
        [EXAMPLE_FILTERED_LABS_URL]: {
          body: EXAMPLE_FILTERED_LABS_BODY,
          updatedAt: now - 1_000,
          lastAccessedAt: now - 1_000,
        },
      },
      refreshingCacheKeys: new Set<string>(),
      hasQueuedPersist: false,
      metadataPersistDirty: false,
      pendingAccessedAt: {},
      activeRequestCount: 0,
      lastUsedAt: now,
    });

    let releaseQueue!: () => void;
    const blockingQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    privateStore.siteQueueByKey.set(EXAMPLE_SITE_KEY, blockingQueue);

    privateStore.scheduleBackgroundRefresh(
      EXAMPLE_SITE_KEY,
      EXAMPLE_FILTERED_LABS_URL,
      EXAMPLE_FILTERED_LABS_URL,
    );

    const siteState = privateStore.siteStateByKey.get(EXAMPLE_SITE_KEY);
    if (siteState) {
      siteState.entries[EXAMPLE_FILTERED_LABS_URL].updatedAt = now;
    }

    releaseQueue();
    await store.waitForIdle(EXAMPLE_SITE_KEY);

    expect(client.fetchMergedResponse).not.toHaveBeenCalled();
    expect(
      privateStore.siteStateByKey
        .get(EXAMPLE_SITE_KEY)
        ?.refreshingCacheKeys.has(EXAMPLE_FILTERED_LABS_URL),
    ).toBe(false);
  });

  it("logs and swallows queued persist failures on hot cache hits", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue({
        version: 1,
        siteKey: EXAMPLE_SITE_KEY,
        savedAt: 1_700_000_000_000,
        entries: {
          [EXAMPLE_FILTERED_LABS_URL]: {
            body: EXAMPLE_FILTERED_LABS_BODY,
            updatedAt: 1_700_000_000_000,
            lastAccessedAt: 1_700_000_000_000,
          },
        },
      } satisfies SiteSnapshot),
      saveSiteSnapshot: vi.fn().mockRejectedValue("disk full"),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace, { staleAfterMs: 60_000 }),
      persistence,
      client,
      logger,
      () => 1_700_000_000_100,
    );

    const response = await store.resolve({
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: false,
      airtableUrl: EXAMPLE_FILTERED_LABS_URL,
      cacheKey: EXAMPLE_FILTERED_LABS_URL,
    });

    expect(response.headers?.["X-Airtable-Cache"]).toBe("hit");

    await store.waitForIdle(EXAMPLE_SITE_KEY);

    expect(logger.error).toHaveBeenCalledWith(
      "Failed to persist cache access metadata.",
      expect.objectContaining({
        siteKey: EXAMPLE_SITE_KEY,
        cause: "Unknown error",
      }),
    );
  });

  it("logs persist failures with the thrown error message when available", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue({
        version: 1,
        siteKey: EXAMPLE_SITE_KEY,
        savedAt: 1_700_000_000_000,
        entries: {
          [EXAMPLE_FILTERED_LABS_URL]: {
            body: EXAMPLE_FILTERED_LABS_BODY,
            updatedAt: 1_700_000_000_000,
            lastAccessedAt: 1_700_000_000_000,
          },
        },
      } satisfies SiteSnapshot),
      saveSiteSnapshot: vi.fn().mockRejectedValue(new Error("disk full")),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace, { staleAfterMs: 60_000 }),
      persistence,
      client,
      logger,
      () => 1_700_000_000_100,
    );

    await store.resolve({
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: false,
      airtableUrl: EXAMPLE_FILTERED_LABS_URL,
      cacheKey: EXAMPLE_FILTERED_LABS_URL,
    });
    await store.waitForIdle(EXAMPLE_SITE_KEY);

    expect(logger.error).toHaveBeenCalledWith(
      "Failed to persist cache access metadata.",
      expect.objectContaining({
        siteKey: EXAMPLE_SITE_KEY,
        cause: "disk full",
      }),
    );
  });

  it("skips background refreshes when the entry disappears before refresh work starts", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace),
      persistence,
      client,
      {
        info() {},
        warn() {},
        error() {},
      },
    );
    const privateStore = store as unknown as {
      siteStateByKey: Map<string, PrivateSiteCacheState>;
      scheduleBackgroundRefresh(siteKey: string, cacheKey: string, airtableUrl: string): void;
    };

    privateStore.siteStateByKey.set(EXAMPLE_SITE_KEY, {
      loaded: true,
      entries: {},
      refreshingCacheKeys: new Set<string>(),
      hasQueuedPersist: false,
      metadataPersistDirty: false,
      pendingAccessedAt: {},
      activeRequestCount: 0,
      lastUsedAt: 1_700_000_000_000,
    });

    privateStore.scheduleBackgroundRefresh(
      EXAMPLE_SITE_KEY,
      EXAMPLE_FILTERED_LABS_URL,
      EXAMPLE_FILTERED_LABS_URL,
    );
    await store.waitForIdle(EXAMPLE_SITE_KEY);

    expect(client.fetchMergedResponse).not.toHaveBeenCalled();
    expect(
      privateStore.siteStateByKey
        .get(EXAMPLE_SITE_KEY)
        ?.refreshingCacheKeys.has(EXAMPLE_FILTERED_LABS_URL),
    ).toBe(false);
  });

  it("logs background refresh failures with the thrown error message when available", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn().mockRejectedValue(new Error("network down")),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace, { staleAfterMs: 100 }),
      persistence,
      client,
      logger,
      () => 1_700_000_000_000,
    );
    const privateStore = store as unknown as {
      siteStateByKey: Map<string, PrivateSiteCacheState>;
      scheduleBackgroundRefresh(siteKey: string, cacheKey: string, airtableUrl: string): void;
    };

    privateStore.siteStateByKey.set(EXAMPLE_SITE_KEY, {
      loaded: true,
      entries: {
        [EXAMPLE_FILTERED_LABS_URL]: {
          body: EXAMPLE_FILTERED_LABS_BODY,
          updatedAt: 1_699_999_999_000,
          lastAccessedAt: 1_699_999_999_000,
        },
      },
      refreshingCacheKeys: new Set<string>(),
      hasQueuedPersist: false,
      metadataPersistDirty: false,
      pendingAccessedAt: {},
      activeRequestCount: 0,
      lastUsedAt: 1_700_000_000_000,
    });

    privateStore.scheduleBackgroundRefresh(
      EXAMPLE_SITE_KEY,
      EXAMPLE_FILTERED_LABS_URL,
      EXAMPLE_FILTERED_LABS_URL,
    );
    await store.waitForIdle(EXAMPLE_SITE_KEY);

    expect(logger.error).toHaveBeenCalledWith(
      "Background refresh failed. Serving the last good cache entry.",
      expect.objectContaining({
        siteKey: EXAMPLE_SITE_KEY,
        cacheKey: EXAMPLE_FILTERED_LABS_URL,
        cause: "network down",
      }),
    );
  });

  it("fetches an entry whose eviction window has elapsed instead of reviving it", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const currentTime = 2_000;
    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue({
        version: 1,
        siteKey: EXAMPLE_SITE_KEY,
        savedAt: 1_000,
        entries: {
          [EXAMPLE_FILTERED_LABS_URL]: {
            body: EXAMPLE_FILTERED_LABS_BODY,
            updatedAt: 1_000,
            lastAccessedAt: 1_000,
          },
        },
      } satisfies SiteSnapshot),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn().mockResolvedValue({
        status: 200,
        body: EXAMPLE_PUBLISHED_DATES_BODY,
        pageCount: 1,
      }),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace, { staleAfterMs: 10_000, evictAfterMs: 500 }),
      persistence,
      client,
      { info() {}, warn() {}, error() {} },
      () => currentTime,
    );

    const response = await store.resolve({
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: false,
      airtableUrl: EXAMPLE_FILTERED_LABS_URL,
      cacheKey: EXAMPLE_FILTERED_LABS_URL,
    });

    expect(response.headers?.["X-Airtable-Cache"]).toBe("miss");
    expect(client.fetchMergedResponse).toHaveBeenCalledTimes(1);
    expect(persistence.saveSiteSnapshot).toHaveBeenCalledWith(
      EXAMPLE_SITE_KEY,
      expect.not.objectContaining({
        [EXAMPLE_FILTERED_LABS_URL]: expect.anything(),
      }),
      currentTime,
    );
  });

  it("keeps the last durable resident state when a refresh snapshot cannot be saved", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const oldBody = EXAMPLE_FILTERED_LABS_BODY;
    const newBody = EXAMPLE_PUBLISHED_DATES_BODY;
    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue({
        version: 1,
        siteKey: EXAMPLE_SITE_KEY,
        savedAt: 1_000,
        entries: {
          [EXAMPLE_FILTERED_LABS_URL]: {
            body: oldBody,
            updatedAt: 1_000,
            lastAccessedAt: 1_000,
          },
        },
      } satisfies SiteSnapshot),
      saveSiteSnapshot: vi.fn().mockRejectedValue(new Error("disk full")),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn().mockResolvedValue({
        status: 200,
        body: newBody,
        pageCount: 1,
      }),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace, { staleAfterMs: 10_000 }),
      persistence,
      client,
      { info() {}, warn() {}, error() {} },
      () => 2_000,
    );

    await expect(
      store.resolve({
        siteKey: EXAMPLE_SITE_KEY,
        forceRefresh: true,
        airtableUrl: EXAMPLE_FILTERED_LABS_URL,
        cacheKey: EXAMPLE_FILTERED_LABS_URL,
      }),
    ).rejects.toThrow("disk full");

    const privateStore = store as unknown as {
      siteStateByKey: Map<string, { entries: Record<string, { body: unknown }> }>;
    };
    expect(privateStore.siteStateByKey.get(EXAMPLE_SITE_KEY)?.entries[EXAMPLE_FILTERED_LABS_URL]?.body)
      .toEqual(oldBody);
  });

  it("persists an access that races a force refresh save", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    let currentTime = 100;
    let releaseSave!: () => void;
    let saveStarted!: () => void;
    const saveStartedPromise = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const savedEntries: Array<SiteSnapshot["entries"]> = [];
    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue({
        version: 1,
        siteKey: EXAMPLE_SITE_KEY,
        savedAt: 0,
        entries: {
          [EXAMPLE_FILTERED_LABS_URL]: {
            body: EXAMPLE_FILTERED_LABS_BODY,
            updatedAt: 100,
            lastAccessedAt: 100,
          },
        },
      } satisfies SiteSnapshot),
      saveSiteSnapshot: vi.fn().mockImplementation(async (_siteKey, entries) => {
        savedEntries.push(structuredClone(entries));
        if (savedEntries.length === 1) {
          saveStarted();
          await saveGate;
        }
      }),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn().mockResolvedValue({
        status: 200,
        body: EXAMPLE_PUBLISHED_DATES_BODY,
        pageCount: 1,
      }),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace, { staleAfterMs: 10_000 }),
      persistence,
      client,
      { info() {}, warn() {}, error() {} },
      () => currentTime,
    );

    const refreshPromise = store.resolve({
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: true,
      airtableUrl: EXAMPLE_FILTERED_LABS_URL,
      cacheKey: EXAMPLE_FILTERED_LABS_URL,
    });
    await saveStartedPromise;

    currentTime = 200;
    const hitResponse = await store.resolve({
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: false,
      airtableUrl: EXAMPLE_FILTERED_LABS_URL,
      cacheKey: EXAMPLE_FILTERED_LABS_URL,
    });
    expect(hitResponse.headers?.["X-Airtable-Cache"]).toBe("hit");

    releaseSave();
    await refreshPromise;
    await store.waitForIdle(EXAMPLE_SITE_KEY);

    expect(savedEntries.at(-1)?.[EXAMPLE_FILTERED_LABS_URL]?.lastAccessedAt).toBe(200);
  });

  it("timestamps a cold response at upstream completion", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    let currentTime = 100;
    let persistedEntries: SiteSnapshot["entries"] | undefined;
    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockImplementation(async (_siteKey, entries) => {
        persistedEntries = structuredClone(entries);
      }),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        currentTime = 250;
        return {
          status: 200,
          body: EXAMPLE_PUBLISHED_DATES_BODY,
          pageCount: 1,
        };
      }),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace),
      persistence,
      client,
      { info() {}, warn() {}, error() {} },
      () => currentTime,
    );

    await store.resolve({
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: false,
      airtableUrl: EXAMPLE_PUBLISHED_DATES_URL,
      cacheKey: EXAMPLE_PUBLISHED_DATES_URL,
    });

    expect(persistedEntries?.[EXAMPLE_PUBLISHED_DATES_URL]?.updatedAt).toBe(250);
  });

  it("releases failed random sites and unloads dormant successful sites", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    let currentTime = 100;
    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi
        .fn()
        .mockRejectedValueOnce(new Error("random ref failed"))
        .mockResolvedValueOnce({
          status: 200,
          body: EXAMPLE_FILTERED_LABS_BODY,
          pageCount: 1,
        }),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace, { evictAfterMs: 100 }),
      persistence,
      client,
      { info() {}, warn() {}, error() {} },
      () => currentTime,
    );
    const privateStore = store as unknown as {
      siteStateByKey: Map<string, unknown>;
    };

    await expect(
      store.resolve({
        siteKey: "random.failed.example",
        forceRefresh: false,
        airtableUrl: EXAMPLE_FILTERED_LABS_URL,
        cacheKey: EXAMPLE_FILTERED_LABS_URL,
      }),
    ).rejects.toThrow("random ref failed");
    expect(privateStore.siteStateByKey.has("random.failed.example")).toBe(false);

    await store.resolve({
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: false,
      airtableUrl: EXAMPLE_FILTERED_LABS_URL,
      cacheKey: EXAMPLE_FILTERED_LABS_URL,
    });
    expect(privateStore.siteStateByKey.has(EXAMPLE_SITE_KEY)).toBe(true);

    currentTime = 250;
    await store.waitForIdle(EXAMPLE_SITE_KEY);
    expect(privateStore.siteStateByKey.has(EXAMPLE_SITE_KEY)).toBe(false);
  });

  it("bounds resident sites and evicts the least recently used idle state", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    let currentTime = 1_000;
    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn().mockResolvedValue({
        status: 200,
        body: EXAMPLE_FILTERED_LABS_BODY,
        pageCount: 1,
      }),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace, { evictAfterMs: 10_000_000 }),
      persistence,
      client,
      { info() {}, warn() {}, error() {} },
      () => currentTime,
    );
    const privateStore = store as unknown as {
      siteStateByKey: Map<string, unknown>;
    };

    for (let index = 0; index < 65; index += 1) {
      const siteKey = `site-${index}.example`;
      const cacheKey = `${EXAMPLE_FILTERED_LABS_URL}&site=${index}`;
      await store.resolve({
        siteKey,
        forceRefresh: false,
        airtableUrl: cacheKey,
        cacheKey,
      });
      currentTime += 1;
    }

    expect(privateStore.siteStateByKey.size).toBeLessThanOrEqual(64);
    expect(privateStore.siteStateByKey.has("site-0.example")).toBe(false);
    expect(privateStore.siteStateByKey.has("site-64.example")).toBe(true);
  });

  it("admits no more than 64 concurrent site snapshots", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const loadedSiteKeys: string[] = [];
    const releaseFetches: Array<() => void> = [];
    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockImplementation(async (siteKey: string) => {
        loadedSiteKeys.push(siteKey);
        return null;
      }),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn().mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          releaseFetches.push(resolve);
        });
        return {
          status: 200,
          body: EXAMPLE_FILTERED_LABS_BODY,
          pageCount: 1,
        };
      }),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace),
      persistence,
      client,
      { info() {}, warn() {}, error() {} },
      () => 1_000,
    );
    const privateStore = store as unknown as {
      siteStateByKey: Map<string, unknown>;
    };
    const requests = Array.from({ length: 65 }, (_, index) => {
      const siteKey = `concurrent-${index}.example`;
      const cacheKey = `${EXAMPLE_FILTERED_LABS_URL}&site=${index}`;
      return store.resolve({
        siteKey,
        forceRefresh: false,
        airtableUrl: cacheKey,
        cacheKey,
      });
    });

    await vi.waitFor(() => {
      expect(loadedSiteKeys).toHaveLength(64);
      expect(releaseFetches).toHaveLength(64);
    });
    expect(privateStore.siteStateByKey.size).toBe(64);

    releaseFetches[0]?.();
    await vi.waitFor(() => {
      expect(loadedSiteKeys).toHaveLength(65);
      expect(releaseFetches).toHaveLength(65);
    });
    expect(privateStore.siteStateByKey.size).toBe(64);

    for (const releaseFetch of releaseFetches) {
      releaseFetch();
    }
    await Promise.all(requests);
    await store.waitForIdle();
    expect(privateStore.siteStateByKey.size).toBeLessThanOrEqual(64);
  });

  it("reconciles a metadata persist before admitting the 65th resident site", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    let currentTime = 1_000;
    const siteKeys = Array.from({ length: 64 }, (_, index) => `metadata-${index}.example`);
    const cacheKeys = siteKeys.map(
      (_, index) => `${EXAMPLE_FILTERED_LABS_URL}&metadata=${index}`,
    );
    const loadedSiteKeys: string[] = [];
    let deferMetadataSave = false;
    let releaseMetadataSave!: () => void;
    let metadataSaveStarted!: () => void;
    const metadataSaveStartedPromise = new Promise<void>((resolve) => {
      metadataSaveStarted = resolve;
    });
    const metadataSaveGate = new Promise<void>((resolve) => {
      releaseMetadataSave = resolve;
    });
    let metadataSaveCompleted = false;
    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockImplementation(async (siteKey: string) => {
        loadedSiteKeys.push(siteKey);
        return null;
      }),
      saveSiteSnapshot: vi.fn().mockImplementation(async (siteKey: string) => {
        if (!deferMetadataSave || siteKey !== siteKeys[0]) {
          return;
        }

        metadataSaveStarted();
        await metadataSaveGate;
        metadataSaveCompleted = true;
      }),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn().mockResolvedValue({
        status: 200,
        body: EXAMPLE_FILTERED_LABS_BODY,
        pageCount: 1,
      }),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace, { evictAfterMs: 10_000_000 }),
      persistence,
      client,
      { info() {}, warn() {}, error() {} },
      () => currentTime,
    );
    const privateStore = store as unknown as {
      siteStateByKey: Map<string, PrivateSiteCacheState>;
      scheduleMetadataPersist(siteKey: string): void;
    };

    for (let index = 0; index < siteKeys.length; index += 1) {
      await store.resolve({
        siteKey: siteKeys[index],
        forceRefresh: false,
        airtableUrl: cacheKeys[index],
        cacheKey: cacheKeys[index],
      });
      currentTime += 1;
    }

    for (const state of privateStore.siteStateByKey.values()) {
      state.activeRequestCount = 1;
    }

    const blockedState = privateStore.siteStateByKey.get(siteKeys[0]);
    expect(blockedState).toBeDefined();
    blockedState!.pendingAccessedAt[cacheKeys[0]] = currentTime + 1;
    blockedState!.metadataPersistDirty = true;
    deferMetadataSave = true;
    privateStore.scheduleMetadataPersist(siteKeys[0]);
    await metadataSaveStartedPromise;

    let admitted = false;
    const newcomer = store
      .resolve({
        siteKey: "metadata-64.example",
        forceRefresh: false,
        airtableUrl: `${EXAMPLE_FILTERED_LABS_URL}&metadata=64`,
        cacheKey: `${EXAMPLE_FILTERED_LABS_URL}&metadata=64`,
      })
      .then(() => {
        admitted = true;
      });

    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(loadedSiteKeys).toHaveLength(64);

    // The metadata task is the only newly eligible slot once its write
    // settles; admission must wake immediately after that reconciliation.
    blockedState!.activeRequestCount = 0;
    releaseMetadataSave();
    await newcomer;

    expect(metadataSaveCompleted).toBe(true);
    expect(admitted).toBe(true);
    expect(loadedSiteKeys).toContain("metadata-64.example");
    expect(privateStore.siteStateByKey.size).toBe(64);
  });

  it("reconciles a background refresh before admitting the 65th resident site", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    let currentTime = 1_000;
    const siteKeys = Array.from({ length: 64 }, (_, index) => `refresh-${index}.example`);
    const cacheKeys = siteKeys.map(
      (_, index) => `${EXAMPLE_FILTERED_LABS_URL}&refresh=${index}`,
    );
    const loadedSiteKeys: string[] = [];
    let deferBackgroundFetch = false;
    let releaseBackgroundFetch!: () => void;
    let backgroundFetchStarted!: () => void;
    const backgroundFetchStartedPromise = new Promise<void>((resolve) => {
      backgroundFetchStarted = resolve;
    });
    const backgroundFetchGate = new Promise<void>((resolve) => {
      releaseBackgroundFetch = resolve;
    });
    let backgroundFetchCompleted = false;
    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockImplementation(async (siteKey: string) => {
        loadedSiteKeys.push(siteKey);
        return null;
      }),
      saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn().mockImplementation(async (airtableUrl: string) => {
        if (deferBackgroundFetch && airtableUrl === cacheKeys[0]) {
          backgroundFetchStarted();
          await backgroundFetchGate;
          backgroundFetchCompleted = true;
        }

        return {
          status: 200,
          body: EXAMPLE_FILTERED_LABS_BODY,
          pageCount: 1,
        };
      }),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace, { staleAfterMs: 10, evictAfterMs: 10_000_000 }),
      persistence,
      client,
      { info() {}, warn() {}, error() {} },
      () => currentTime,
    );
    const privateStore = store as unknown as {
      siteStateByKey: Map<string, PrivateSiteCacheState>;
      scheduleBackgroundRefresh(siteKey: string, cacheKey: string, airtableUrl: string): void;
    };

    for (let index = 0; index < siteKeys.length; index += 1) {
      await store.resolve({
        siteKey: siteKeys[index],
        forceRefresh: false,
        airtableUrl: cacheKeys[index],
        cacheKey: cacheKeys[index],
      });
      currentTime += 1;
    }

    for (const state of privateStore.siteStateByKey.values()) {
      state.activeRequestCount = 1;
    }

    const blockedState = privateStore.siteStateByKey.get(siteKeys[0]);
    expect(blockedState).toBeDefined();
    blockedState!.entries[cacheKeys[0]].updatedAt = 0;
    deferBackgroundFetch = true;
    privateStore.scheduleBackgroundRefresh(siteKeys[0], cacheKeys[0], cacheKeys[0]);
    await backgroundFetchStartedPromise;

    let admitted = false;
    const newcomer = store
      .resolve({
        siteKey: "refresh-64.example",
        forceRefresh: false,
        airtableUrl: `${EXAMPLE_FILTERED_LABS_URL}&refresh=64`,
        cacheKey: `${EXAMPLE_FILTERED_LABS_URL}&refresh=64`,
      })
      .then(() => {
        admitted = true;
      });

    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(loadedSiteKeys).toHaveLength(64);

    // Keep the background marker as the only blocker for the chosen state.
    blockedState!.activeRequestCount = 0;
    releaseBackgroundFetch();
    await newcomer;

    expect(backgroundFetchCompleted).toBe(true);
    expect(admitted).toBe(true);
    expect(loadedSiteKeys).toContain("refresh-64.example");
    expect(privateStore.siteStateByKey.size).toBe(64);
  });

  it("chunks resident eviction timers beyond Node's maximum timeout", async () => {
    vi.useFakeTimers();

    try {
      const workspace = createTempWorkspace();
      workspaces.push(workspace);

      let currentTime = 0;
      const persistence: CachePersistence = {
        loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
        saveSiteSnapshot: vi.fn().mockResolvedValue(undefined),
      };
      const client: AirtableClientContract = {
        fetchMergedResponse: vi.fn().mockResolvedValue({
          status: 200,
          body: EXAMPLE_FILTERED_LABS_BODY,
          pageCount: 1,
        }),
      };
      const store = new AirtableCacheStore(
        createTestConfig(workspace, {
          staleAfterMs: 1_000_000,
          evictAfterMs: 2_147_484_647,
        }),
        persistence,
        client,
        { info() {}, warn() {}, error() {} },
        () => currentTime,
      );
      const privateStore = store as unknown as {
        siteStateByKey: Map<string, unknown>;
      };

      await store.resolve({
        siteKey: EXAMPLE_SITE_KEY,
        forceRefresh: false,
        airtableUrl: EXAMPLE_FILTERED_LABS_URL,
        cacheKey: EXAMPLE_FILTERED_LABS_URL,
      });
      expect(privateStore.siteStateByKey.has(EXAMPLE_SITE_KEY)).toBe(true);

      currentTime = 2_147_483_647;
      vi.advanceTimersByTime(2_147_483_647);
      expect(privateStore.siteStateByKey.has(EXAMPLE_SITE_KEY)).toBe(true);

      currentTime = 2_147_484_647;
      vi.advanceTimersByTime(1_000);
      expect(privateStore.siteStateByKey.has(EXAMPLE_SITE_KEY)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains access metadata across a failed save and retries after a later hit", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    let currentTime = 100;
    let releaseSave!: () => void;
    let saveStarted!: () => void;
    const saveStartedPromise = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let saveCount = 0;
    let successfulEntries: Record<string, CacheEntryState> | undefined;
    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue({
        version: 1,
        siteKey: EXAMPLE_SITE_KEY,
        savedAt: 0,
        entries: {
          [EXAMPLE_FILTERED_LABS_URL]: {
            body: EXAMPLE_FILTERED_LABS_BODY,
            updatedAt: 100,
            lastAccessedAt: 100,
          },
        },
      } satisfies SiteSnapshot),
      saveSiteSnapshot: vi.fn().mockImplementation(async (_siteKey, entries) => {
        saveCount += 1;
        if (saveCount === 1) {
          saveStarted();
          await saveGate;
          throw new Error("disk full");
        }
        successfulEntries = structuredClone(entries);
      }),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace, { staleAfterMs: 10_000 }),
      persistence,
      client,
      { info() {}, warn() {}, error() {} },
      () => currentTime,
    );
    const privateStore = store as unknown as {
      siteStateByKey: Map<
        string,
        {
          entries: Record<string, CacheEntryState>;
          pendingAccessedAt: Record<string, number>;
          metadataPersistDirty: boolean;
        }
      >;
    };

    await store.resolve({
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: false,
      airtableUrl: EXAMPLE_FILTERED_LABS_URL,
      cacheKey: EXAMPLE_FILTERED_LABS_URL,
    });
    await saveStartedPromise;

    currentTime = 200;
    await store.resolve({
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: false,
      airtableUrl: EXAMPLE_FILTERED_LABS_URL,
      cacheKey: EXAMPLE_FILTERED_LABS_URL,
    });
    releaseSave();
    await store.waitForIdle(EXAMPLE_SITE_KEY);

    const failedState = privateStore.siteStateByKey.get(EXAMPLE_SITE_KEY);
    expect(failedState?.entries[EXAMPLE_FILTERED_LABS_URL]?.lastAccessedAt).toBe(100);
    expect(failedState?.pendingAccessedAt[EXAMPLE_FILTERED_LABS_URL]).toBe(200);
    expect(failedState?.metadataPersistDirty).toBe(true);

    currentTime = 300;
    await store.resolve({
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: false,
      airtableUrl: EXAMPLE_FILTERED_LABS_URL,
      cacheKey: EXAMPLE_FILTERED_LABS_URL,
    });
    await store.waitForIdle(EXAMPLE_SITE_KEY);

    expect(saveCount).toBe(2);
    expect(successfulEntries?.[EXAMPLE_FILTERED_LABS_URL]?.lastAccessedAt).toBe(300);
  });

  it("trims an oversized loaded snapshot before resident commit and persistence", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const entries = Object.fromEntries(
      Array.from({ length: 1_001 }, (_, index) => {
        const cacheKey = `https://example.com/entry-${String(index).padStart(4, "0")}`;
        return [
          cacheKey,
          {
            body: EXAMPLE_FILTERED_LABS_BODY,
            updatedAt: 1_000,
            lastAccessedAt: 1_000,
          },
        ];
      }),
    );
    const savedSnapshots: Array<Record<string, unknown>> = [];
    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue({
        version: 1,
        siteKey: EXAMPLE_SITE_KEY,
        savedAt: 1_000,
        entries,
      } satisfies SiteSnapshot),
      saveSiteSnapshot: vi.fn().mockImplementation(async (_siteKey, savedEntries) => {
        savedSnapshots.push(structuredClone(savedEntries));
      }),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace, {
        staleAfterMs: 1_000_000,
        evictAfterMs: 1_000_000,
      }),
      persistence,
      client,
      { info() {}, warn() {}, error() {} },
      () => 2_000,
    );

    const retainedKey = "https://example.com/entry-1000";
    const response = await store.resolve({
      siteKey: EXAMPLE_SITE_KEY,
      forceRefresh: false,
      airtableUrl: retainedKey,
      cacheKey: retainedKey,
    });
    await store.waitForIdle(EXAMPLE_SITE_KEY);

    expect(response.headers?.["X-Airtable-Cache"]).toBe("hit");
    expect(client.fetchMergedResponse).not.toHaveBeenCalled();
    expect(savedSnapshots.length).toBeGreaterThan(0);
    expect(savedSnapshots.every((snapshot) => Object.keys(snapshot).length <= 1_000)).toBe(true);
    expect(savedSnapshots[0]).not.toHaveProperty("https://example.com/entry-0000");
    expect(savedSnapshots[0]).toHaveProperty(retainedKey);

    const privateStore = store as unknown as {
      siteStateByKey: Map<string, { entries: Record<string, unknown> }>;
    };
    expect(Object.keys(privateStore.siteStateByKey.get(EXAMPLE_SITE_KEY)?.entries ?? {})).toHaveLength(
      1_000,
    );
  });

  it("unloads an oversized snapshot when staged cleanup persistence fails", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const entries = Object.fromEntries(
      Array.from({ length: 1_001 }, (_, index) => [
        `https://example.com/entry-${String(index).padStart(4, "0")}`,
        {
          body: EXAMPLE_FILTERED_LABS_BODY,
          updatedAt: 1_000,
          lastAccessedAt: 1_000,
        },
      ]),
    );
    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue({
        version: 1,
        siteKey: EXAMPLE_SITE_KEY,
        savedAt: 1_000,
        entries,
      } satisfies SiteSnapshot),
      saveSiteSnapshot: vi.fn().mockRejectedValue(new Error("disk full")),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn(),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace, {
        staleAfterMs: 1_000_000,
        evictAfterMs: 1_000_000,
      }),
      persistence,
      client,
      { info() {}, warn() {}, error() {} },
      () => 2_000,
    );
    const privateStore = store as unknown as {
      siteStateByKey: Map<string, { loaded: boolean; entries: Record<string, unknown> }>;
    };

    await expect(
      store.resolve({
        siteKey: EXAMPLE_SITE_KEY,
        forceRefresh: false,
        airtableUrl: "https://example.com/entry-1000",
        cacheKey: "https://example.com/entry-1000",
      }),
    ).rejects.toThrow("disk full");

    expect(client.fetchMergedResponse).not.toHaveBeenCalled();
    expect(privateStore.siteStateByKey.has(EXAMPLE_SITE_KEY)).toBe(false);
  });

  it("keeps ongoing unique misses within the per-site entry cap", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);

    const currentTime = 1_000;
    const savedCounts: number[] = [];
    const persistence: CachePersistence = {
      loadSiteSnapshot: vi.fn().mockResolvedValue(null satisfies SiteSnapshot | null),
      saveSiteSnapshot: vi.fn().mockImplementation(async (_siteKey, savedEntries) => {
        savedCounts.push(Object.keys(savedEntries).length);
      }),
    };
    const client: AirtableClientContract = {
      fetchMergedResponse: vi.fn().mockResolvedValue({
        status: 200,
        body: EXAMPLE_FILTERED_LABS_BODY,
        pageCount: 1,
      }),
    };
    const store = new AirtableCacheStore(
      createTestConfig(workspace, {
        staleAfterMs: 1_000_000,
        evictAfterMs: 1_000_000,
      }),
      persistence,
      client,
      { info() {}, warn() {}, error() {} },
      () => currentTime,
    );

    for (let index = 0; index < 1_001; index += 1) {
      const cacheKey = `https://example.com/unique-${String(index).padStart(4, "0")}`;
      await store.resolve({
        siteKey: EXAMPLE_SITE_KEY,
        forceRefresh: false,
        airtableUrl: cacheKey,
        cacheKey,
      });
    }

    await store.waitForIdle(EXAMPLE_SITE_KEY);

    const privateStore = store as unknown as {
      siteStateByKey: Map<string, { entries: Record<string, unknown> }>;
    };
    expect(savedCounts).toHaveLength(1_001);
    expect(savedCounts.every((count) => count <= 1_000)).toBe(true);
    const residentEntries = privateStore.siteStateByKey.get(EXAMPLE_SITE_KEY)?.entries ?? {};
    expect(Object.keys(residentEntries)).toHaveLength(1_000);
    expect(residentEntries).toHaveProperty("https://example.com/unique-1000");
    expect(residentEntries).not.toHaveProperty("https://example.com/unique-0000");
  }, 20_000);
});
