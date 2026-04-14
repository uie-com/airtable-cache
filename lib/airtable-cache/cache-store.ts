import { HttpError } from "@/lib/airtable-cache/errors";
import {
  AirtableClientContract,
  AirtableConfig,
  CacheEntryState,
  CachePersistence,
  Logger,
  ProxyRequest,
  ProxyResponse,
} from "@/lib/airtable-cache/types";

// This file owns the in-memory cache for one running Node process.
// It decides when to read from memory, when to refresh from Airtable, when to write to disk,
// and how to keep different requests for the same site from stepping on each other.
interface SiteCacheState {
  // `loaded` tells us whether we have already read the on-disk snapshot into memory.
  loaded: boolean;
  // `entries` holds the current cached results for one site, keyed by the normalized request.
  entries: Record<string, CacheEntryState>;
  // `refreshingCacheKeys` tracks which cache keys already have a background refresh running.
  refreshingCacheKeys: Set<string>;
  // `hasQueuedPersist` prevents us from starting many metadata-only disk writes at once.
  hasQueuedPersist: boolean;
}

// This class is the main cache controller for the service.
// It keeps the cache fast for reads, safe for writes, and predictable when multiple requests
// arrive for the same site at nearly the same time.
export class AirtableCacheStore {
  // One map stores the full cache state for each site key.
  private readonly siteStateByKey = new Map<string, SiteCacheState>();
  // Another map stores the per-site promise chain used as a simple lock.
  private readonly siteQueueByKey = new Map<string, Promise<void>>();

  // The store needs the cache policy, the disk persistence layer, the Airtable client,
  // a logger, and a clock source so tests can control time.
  constructor(
    private readonly config: AirtableConfig,
    private readonly persistence: CachePersistence,
    private readonly client: AirtableClientContract,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  // This is the main entry point for one proxy request.
  // It tries memory first, refreshes stale data in the background when possible,
  // and falls back to a locked fetch path when it needs to rebuild the cache.
  async resolve(request: ProxyRequest): Promise<ProxyResponse> {
    // Make sure the site snapshot has been loaded before we inspect or mutate it.
    await this.ensureSiteLoaded(request.siteKey);

    const siteState = this.getOrCreateSiteState(request.siteKey);
    const cachedEntry = siteState.entries[request.cacheKey];
    const requestTime = this.now();

    // A warm cache hit should return quickly without waiting for disk or Airtable.
    if (cachedEntry && !request.forceRefresh) {
      cachedEntry.lastAccessedAt = requestTime;
      // Touch metadata should not slow down hot reads, so the disk write is queued.
      this.scheduleMetadataPersist(request.siteKey);

      // If the entry is old enough to be stale, serve the last good value now and refresh later.
      if (this.isEntryStale(cachedEntry, requestTime)) {
        // Stale cache hits return immediately and refresh in the background under the site lock.
        this.scheduleBackgroundRefresh(
          request.siteKey,
          request.cacheKey,
          request.airtableUrl,
        );

        return {
          status: 200,
          body: structuredClone(cachedEntry.body),
          headers: {
            "Cache-Control": "no-store",
            "X-Airtable-Cache": "stale",
          },
        };
      }

      return {
        status: 200,
        body: structuredClone(cachedEntry.body),
        headers: {
          "Cache-Control": "no-store",
          "X-Airtable-Cache": "hit",
        },
      };
    }

    // Cold misses, forced refreshes, and re-checking stale entries are serialized per site so
    // only one request mutates the in-memory snapshot and on-disk files at a time.
    return this.runWithSiteLock(request.siteKey, async () => {
      const lockedSiteState = await this.loadSiteSnapshotIfNeeded(request.siteKey);
      const lockedEntry = lockedSiteState.entries[request.cacheKey];
      const lockedTime = this.now();

      if (lockedEntry && !request.forceRefresh && !this.isEntryStale(lockedEntry, lockedTime)) {
        lockedEntry.lastAccessedAt = lockedTime;
        await this.persistSiteSnapshot(request.siteKey, lockedSiteState, lockedTime);

        return {
          status: 200,
          body: structuredClone(lockedEntry.body),
          headers: {
            "Cache-Control": "no-store",
            "X-Airtable-Cache": "hit",
          },
        };
      }

      const freshResponse = await this.client.fetchMergedResponse(request.airtableUrl);

      lockedSiteState.entries[request.cacheKey] = {
        body: freshResponse.body,
        updatedAt: lockedTime,
        lastAccessedAt: lockedTime,
      };

      this.removeExpiredEntries(lockedSiteState, lockedTime);
      await this.persistSiteSnapshot(request.siteKey, lockedSiteState, lockedTime);

      return {
        status: freshResponse.status,
        body: structuredClone(freshResponse.body),
        headers: {
          "Cache-Control": "no-store",
          "X-Airtable-Cache": request.forceRefresh ? "refresh" : "miss",
        },
      };
    });
  }

  // Tests and shutdown code can wait for all queued work to finish for one site,
  // or for every site the process currently knows about.
  async waitForIdle(siteKey?: string): Promise<void> {
    if (siteKey) {
      await this.waitForSiteQueueToDrain(siteKey);
      return;
    }

    await Promise.all(
      Array.from(this.siteQueueByKey.keys()).map((key) => this.waitForSiteQueueToDrain(key)),
    );
  }

  // Loads the snapshot for one site the first time we need it.
  // If the site is already in memory, this returns immediately.
  private async ensureSiteLoaded(siteKey: string): Promise<void> {
    const siteState = this.getOrCreateSiteState(siteKey);
    if (siteState.loaded) {
      return;
    }

    await this.runWithSiteLock(siteKey, async () => {
      await this.loadSiteSnapshotIfNeeded(siteKey);
    });
  }

  // Reads the on-disk snapshot once and keeps the result in memory.
  // This is also where expired entries are trimmed after startup or migration.
  private async loadSiteSnapshotIfNeeded(siteKey: string): Promise<SiteCacheState> {
    const siteState = this.getOrCreateSiteState(siteKey);
    if (siteState.loaded) {
      return siteState;
    }

    // The JSON snapshot is the source of truth. Legacy preload files are migrated on first load.
    const snapshot = await this.persistence.loadSiteSnapshot(siteKey);
    siteState.entries = snapshot?.entries ?? {};
    siteState.loaded = true;

    const removedEntries = this.removeExpiredEntries(siteState, this.now());
    if (removedEntries > 0) {
      await this.persistSiteSnapshot(siteKey, siteState, this.now());
    }

    this.logger.info("Loaded site cache into memory.", {
      siteKey,
      entryCount: Object.keys(siteState.entries).length,
    });

    return siteState;
  }

  // Returns the existing in-memory state for a site, or creates a fresh empty one.
  private getOrCreateSiteState(siteKey: string): SiteCacheState {
    const existingState = this.siteStateByKey.get(siteKey);
    if (existingState) {
      return existingState;
    }

    const newState: SiteCacheState = {
      loaded: false,
      entries: {},
      refreshingCacheKeys: new Set<string>(),
      hasQueuedPersist: false,
    };
    this.siteStateByKey.set(siteKey, newState);
    return newState;
  }

  // An entry is stale when it is old enough that we want to refresh it before trusting it again.
  private isEntryStale(entry: CacheEntryState, currentTime: number): boolean {
    return currentTime - entry.updatedAt >= this.config.staleAfterMs;
  }

  // Removes entries that have not been accessed for longer than the eviction window.
  // This keeps disk usage bounded and drops cache rows that are no longer worth keeping.
  private removeExpiredEntries(siteState: SiteCacheState, currentTime: number): number {
    let removedEntries = 0;

    for (const [cacheKey, entry] of Object.entries(siteState.entries)) {
      if (currentTime - entry.lastAccessedAt <= this.config.evictAfterMs) {
        continue;
      }

      delete siteState.entries[cacheKey];
      removedEntries += 1;
    }

    return removedEntries;
  }

  // Writes the current in-memory snapshot to disk through the persistence layer.
  private async persistSiteSnapshot(
    siteKey: string,
    siteState: SiteCacheState,
    savedAt: number,
  ): Promise<void> {
    await this.persistence.saveSiteSnapshot(siteKey, siteState.entries, savedAt);
  }

  // Metadata-only writes are queued so a burst of reads does not cause a burst of disk writes.
  private scheduleMetadataPersist(siteKey: string): void {
    const siteState = this.getOrCreateSiteState(siteKey);
    if (siteState.hasQueuedPersist) {
      return;
    }

    siteState.hasQueuedPersist = true;

    void this.runWithSiteLock(siteKey, async () => {
      try {
        const lockedSiteState = await this.loadSiteSnapshotIfNeeded(siteKey);
        const currentTime = this.now();
        this.removeExpiredEntries(lockedSiteState, currentTime);
        await this.persistSiteSnapshot(siteKey, lockedSiteState, currentTime);
      } catch (error) {
        this.logger.error("Failed to persist cache access metadata.", {
          siteKey,
          cause: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        siteState.hasQueuedPersist = false;
      }
    });
  }

  // Background refresh keeps stale hits fast by serving the old value first
  // and quietly replacing it after the lock is available.
  private scheduleBackgroundRefresh(
    siteKey: string,
    cacheKey: string,
    airtableUrl: string,
  ): void {
    const siteState = this.getOrCreateSiteState(siteKey);
    if (siteState.refreshingCacheKeys.has(cacheKey)) {
      return;
    }

    siteState.refreshingCacheKeys.add(cacheKey);

    void this.runWithSiteLock(siteKey, async () => {
      try {
        const lockedSiteState = await this.loadSiteSnapshotIfNeeded(siteKey);
        const existingEntry = lockedSiteState.entries[cacheKey];
        if (!existingEntry) {
          return;
        }

        const currentTime = this.now();
        if (!this.isEntryStale(existingEntry, currentTime)) {
          return;
        }

        const freshResponse = await this.client.fetchMergedResponse(airtableUrl);
        lockedSiteState.entries[cacheKey] = {
          body: freshResponse.body,
          updatedAt: currentTime,
          lastAccessedAt: existingEntry.lastAccessedAt,
        };

        this.removeExpiredEntries(lockedSiteState, currentTime);
        await this.persistSiteSnapshot(siteKey, lockedSiteState, currentTime);
      } catch (error) {
        this.logger.error("Background refresh failed. Serving the last good cache entry.", {
          siteKey,
          cacheKey,
          cause: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        siteState.refreshingCacheKeys.delete(cacheKey);
      }
      });
  }

  // This helper is the per-site lock.
  // It chains work so only one task for a site runs at a time in this process.
  private async runWithSiteLock<T>(siteKey: string, task: () => Promise<T>): Promise<T> {
    const previousQueuedTask = this.siteQueueByKey.get(siteKey) ?? Promise.resolve();
    let releaseCurrentQueueSlot: (() => void) | undefined;
    const currentQueueSlot = new Promise<void>((resolve) => {
      releaseCurrentQueueSlot = resolve;
    });
    const updatedQueueTail = previousQueuedTask
      .catch(() => undefined)
      .then(() => currentQueueSlot);
    this.siteQueueByKey.set(siteKey, updatedQueueTail);

    // Promise chaining provides a simple per-site single-flight lock for this single-process VM.
    await previousQueuedTask.catch(() => undefined);

    try {
      return await task();
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      throw error;
    } finally {
      releaseCurrentQueueSlot?.();
      if (this.siteQueueByKey.get(siteKey) === updatedQueueTail) {
        this.siteQueueByKey.delete(siteKey);
      }
    }
  }

  // Waits until the current promise chain for one site has finished draining.
  private async waitForSiteQueueToDrain(siteKey: string): Promise<void> {
    let currentQueuedTask = this.siteQueueByKey.get(siteKey);

    while (currentQueuedTask) {
      await currentQueuedTask.catch(() => undefined);
      const nextQueuedTask = this.siteQueueByKey.get(siteKey);
      if (!nextQueuedTask || nextQueuedTask === currentQueuedTask) {
        return;
      }

      currentQueuedTask = nextQueuedTask;
    }
  }
}
