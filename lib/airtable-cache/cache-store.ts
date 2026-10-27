import { HttpError } from "@/lib/airtable-cache/errors";
import { MAX_ACTIVE_REQUESTS, MAX_SNAPSHOT_BYTES } from "@/lib/airtable-cache/config";
import {
  AirtableClientContract,
  AirtableConfig,
  CacheEntryState,
  CachePersistence,
  Logger,
  ProxyRequest,
  ProxyResponse,
} from "@/lib/airtable-cache/types";

const MAX_RESIDENT_SITES = 64;
const MAX_ENTRIES_PER_SITE = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface SiteCacheState {
  loaded: boolean;
  /**
   * The entries in this map are the last successfully persisted snapshot.
   * Requests never mutate this map while a snapshot is being written.  This
   * makes a failed write unable to leave a new body in resident memory.
   */
  entries: Record<string, CacheEntryState>;
  refreshingCacheKeys: Set<string>;
  hasQueuedPersist: boolean;
  metadataPersistDirty: boolean;
  pendingAccessedAt: Record<string, number>;
  activeRequestCount: number;
  lastUsedAt: number;
  residentEvictionTimer?: ReturnType<typeof setTimeout>;
}

export class AirtableCacheStore {
  private readonly siteStateByKey = new Map<string, SiteCacheState>();
  private readonly siteQueueByKey = new Map<string, Promise<void>>();
  private readonly residentAdmissionWaiters = new Set<() => void>();
  private activeRequests = 0;

  constructor(
    private readonly config: AirtableConfig,
    private readonly persistence: CachePersistence,
    private readonly client: AirtableClientContract,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(request: ProxyRequest): Promise<ProxyResponse> {
    if (this.activeRequests >= MAX_ACTIVE_REQUESTS) {
      throw new HttpError(503, "CACHE_BUSY", "The cache is busy. Retry shortly.");
    }
    this.activeRequests++;
    try {
      return await this.resolveAdmitted(request);
    } finally {
      this.activeRequests--;
    }
  }

  private async resolveAdmitted(request: ProxyRequest): Promise<ProxyResponse> {
    const residentState = await this.acquireSiteState(request.siteKey);
    let resolveFailed = false;

    try {
      await this.ensureSiteLoaded(request.siteKey);

      const siteState = this.getOrCreateSiteState(request.siteKey);
      const requestTime = this.now();
      const cachedEntry = this.getEffectiveEntry(siteState, request.cacheKey);

      // Eviction is checked before recording this request as an access.  A
      // dormant entry therefore cannot be revived by the request that finds it.
      if (
        cachedEntry &&
        !request.forceRefresh &&
        !this.isEntryExpired(cachedEntry, requestTime)
      ) {
        this.recordAccess(siteState, request.siteKey, request.cacheKey, requestTime);

        if (this.isEntryStale(cachedEntry, requestTime)) {
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

      return await this.runWithSiteLock(request.siteKey, async () => {
        const lockedSiteState = await this.loadSiteSnapshotIfNeeded(request.siteKey);
        const lockedTime = this.now();
        const lockedEntries = this.buildWorkingEntries(lockedSiteState);
        this.removeExpiredEntries(lockedEntries, lockedTime);
        this.trimEntriesToCap(lockedEntries);
        const lockedEntry = lockedEntries[request.cacheKey];

        if (
          lockedEntry &&
          !request.forceRefresh &&
          !this.isEntryStale(lockedEntry, lockedTime)
        ) {
          lockedEntry.lastAccessedAt = Math.max(lockedEntry.lastAccessedAt, lockedTime);
          await this.saveCandidateAndCommit(
            request.siteKey,
            lockedSiteState,
            lockedEntries,
            lockedTime,
          );

          return {
            status: 200,
            body: structuredClone(lockedEntry.body),
            headers: {
              "Cache-Control": "no-store",
              "X-Airtable-Cache": "hit",
            },
          };
        }

        // Do not timestamp a response before the upstream request completes.
        // In particular, a slow fetch must not make its data appear older than
        // it really is when it first enters the cache.
        const freshResponse = await this.client.fetchMergedResponse(request.airtableUrl);
        const completedAt = this.now();
        this.touchSiteState(lockedSiteState, completedAt);
        const candidateEntries = this.buildWorkingEntries(lockedSiteState);
        this.removeExpiredEntries(candidateEntries, completedAt);
        this.trimEntriesToCap(candidateEntries, request.cacheKey);
        const previousLastAccessedAt = lockedEntry?.lastAccessedAt;
        const existingLastAccessedAt = candidateEntries[request.cacheKey]?.lastAccessedAt;
        const latestAccessedAt = Math.max(
          completedAt,
          previousLastAccessedAt ?? Number.NEGATIVE_INFINITY,
          existingLastAccessedAt ?? Number.NEGATIVE_INFINITY,
        );

        candidateEntries[request.cacheKey] = {
          body: structuredClone(freshResponse.body),
          updatedAt: completedAt,
          lastAccessedAt: latestAccessedAt,
        };

        await this.saveCandidateAndCommit(
          request.siteKey,
          lockedSiteState,
          candidateEntries,
          completedAt,
          request.cacheKey,
        );

        return {
          status: freshResponse.status,
          body: structuredClone(freshResponse.body),
          headers: {
            "Cache-Control": "no-store",
            "X-Airtable-Cache": request.forceRefresh ? "refresh" : "miss",
          },
        };
      });
    } catch (error) {
      resolveFailed = true;
      throw error;
    } finally {
      this.releaseSiteState(request.siteKey, residentState, resolveFailed);
    }
  }

  async waitForIdle(siteKey?: string): Promise<void> {
    if (siteKey) {
      await this.waitForSiteQueueToDrain(siteKey);
      this.scheduleResidentEviction(siteKey);
      return;
    }

    await Promise.all(
      Array.from(this.siteQueueByKey.keys()).map((key) => this.waitForSiteQueueToDrain(key)),
    );

    // A caller often uses waitForIdle after advancing a test clock.  Running
    // the lifecycle check here also makes dormant states release promptly,
    // without requiring that a timer happen to fire at that instant.
    for (const siteKeyToCheck of this.siteStateByKey.keys()) {
      this.scheduleResidentEviction(siteKeyToCheck);
    }
  }

  private async ensureSiteLoaded(siteKey: string): Promise<void> {
    const siteState = this.getOrCreateSiteState(siteKey);
    this.touchSiteState(siteState);
    if (siteState.loaded) {
      return;
    }

    await this.runWithSiteLock(siteKey, async () => {
      await this.loadSiteSnapshotIfNeeded(siteKey);
    });
  }

  private async loadSiteSnapshotIfNeeded(siteKey: string): Promise<SiteCacheState> {
    const siteState = this.getOrCreateSiteState(siteKey);
    if (siteState.loaded) {
      return siteState;
    }

    const snapshot = await this.persistence.loadSiteSnapshot(siteKey);
    const cleanedEntries = this.cloneEntries(snapshot?.entries ?? {});
    const loadedAt = this.now();
    const removedExpiredEntries = this.removeExpiredEntries(cleanedEntries, loadedAt);
    const removedOverflowEntries = this.trimEntriesToCap(cleanedEntries);

    // Expired and over-cap entries are removed from a staged map.  A cleanup
    // write must succeed before the staged map becomes resident; otherwise
    // unload the state and rethrow so memory never diverges from disk.
    if (removedExpiredEntries > 0 || removedOverflowEntries > 0) {
      try {
        await this.persistSiteSnapshot(siteKey, cleanedEntries, loadedAt);
        siteState.entries = cleanedEntries;
      } catch (error) {
        this.logger.error("Failed to persist expired cache entries.", {
          siteKey,
          cause: error instanceof Error ? error.message : "Unknown error",
        });
        siteState.entries = {};
        siteState.loaded = false;
        throw error;
      }
    } else {
      siteState.entries = cleanedEntries;
    }

    siteState.loaded = true;
    this.touchSiteState(siteState);

    this.logger.info("Loaded site cache into memory.", {
      siteKey,
      entryCount: Object.keys(siteState.entries).length,
    });

    return siteState;
  }

  private getOrCreateSiteState(siteKey: string): SiteCacheState {
    const existingState = this.siteStateByKey.get(siteKey);
    if (existingState) {
      return existingState;
    }

    this.trimResidentStates();

    const newState: SiteCacheState = {
      loaded: false,
      entries: {},
      refreshingCacheKeys: new Set<string>(),
      hasQueuedPersist: false,
      metadataPersistDirty: false,
      pendingAccessedAt: {},
      activeRequestCount: 0,
      lastUsedAt: this.now(),
    };
    this.siteStateByKey.set(siteKey, newState);
    return newState;
  }

  private trimResidentStates(targetSize = MAX_RESIDENT_SITES): void {
    if (this.siteStateByKey.size <= targetSize) {
      return;
    }

    const idleStates = Array.from(this.siteStateByKey.entries())
      .filter(([siteKey, siteState]) => {
        return (
          siteState.activeRequestCount === 0 &&
          !this.siteQueueByKey.has(siteKey) &&
          siteState.refreshingCacheKeys.size === 0 &&
          !siteState.hasQueuedPersist &&
          !siteState.metadataPersistDirty
        );
      })
      .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt);

    let removedState = false;
    while (this.siteStateByKey.size > targetSize && idleStates.length > 0) {
      const [siteKey, siteState] = idleStates.shift()!;
      if (siteState.residentEvictionTimer) {
        clearTimeout(siteState.residentEvictionTimer);
        siteState.residentEvictionTimer = undefined;
      }
      this.siteStateByKey.delete(siteKey);
      removedState = true;
    }

    if (removedState) {
      this.wakeResidentAdmissionWaiters();
    }
  }

  private async acquireSiteState(siteKey: string): Promise<SiteCacheState> {
    while (true) {
      const existingState = this.siteStateByKey.get(siteKey);
      if (existingState) {
        existingState.activeRequestCount += 1;
        this.touchSiteState(existingState);
        return existingState;
      }

      this.trimResidentStates(MAX_RESIDENT_SITES - 1);
      if (this.siteStateByKey.size < MAX_RESIDENT_SITES) {
        const siteState = this.getOrCreateSiteState(siteKey);
        siteState.activeRequestCount += 1;
        this.touchSiteState(siteState);
        return siteState;
      }

      await this.waitForResidentCapacity();
    }
  }

  private async waitForResidentCapacity(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        clearTimeout(timer);
        this.residentAdmissionWaiters.delete(waiter);
        resolve();
      };
      const timer = setTimeout(() => {
        this.residentAdmissionWaiters.delete(waiter);
        reject(new HttpError(503, "CACHE_BUSY", "Timed out waiting for cache capacity."));
      }, this.config.fetchTimeoutMs);
      this.residentAdmissionWaiters.add(waiter);
    });
  }

  private wakeResidentAdmissionWaiters(): void {
    const waiters = Array.from(this.residentAdmissionWaiters);
    this.residentAdmissionWaiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }

  private releaseSiteState(
    siteKey: string,
    siteState: SiteCacheState,
    resolveFailed = false,
  ): void {
    siteState.activeRequestCount = Math.max(0, siteState.activeRequestCount - 1);
    if (
      resolveFailed &&
      Object.keys(siteState.entries).length === 0 &&
      this.siteQueueByKey.has(siteKey) === false &&
      this.siteStateByKey.get(siteKey) === siteState
    ) {
      this.siteStateByKey.delete(siteKey);
      this.wakeResidentAdmissionWaiters();
      return;
    }
    this.trimResidentStates(
      this.residentAdmissionWaiters.size > 0 ? MAX_RESIDENT_SITES - 1 : MAX_RESIDENT_SITES,
    );
    this.scheduleResidentEviction(siteKey, siteState);
  }

  private touchSiteState(siteState: SiteCacheState, at = this.now()): void {
    siteState.lastUsedAt = Math.max(siteState.lastUsedAt, at);
    if (siteState.residentEvictionTimer) {
      clearTimeout(siteState.residentEvictionTimer);
      siteState.residentEvictionTimer = undefined;
    }
  }

  private getEffectiveEntry(
    siteState: SiteCacheState,
    cacheKey: string,
  ): CacheEntryState | undefined {
    const entry = siteState.entries[cacheKey];
    if (!entry) {
      return undefined;
    }

    const pendingAccessedAt = siteState.pendingAccessedAt[cacheKey];
    if (pendingAccessedAt === undefined || pendingAccessedAt <= entry.lastAccessedAt) {
      return entry;
    }

    return {
      body: entry.body,
      updatedAt: entry.updatedAt,
      lastAccessedAt: pendingAccessedAt,
    };
  }

  private recordAccess(
    siteState: SiteCacheState,
    siteKey: string,
    cacheKey: string,
    accessedAt: number,
  ): void {
    this.touchSiteState(siteState, accessedAt);
    const previousAccessedAt = siteState.pendingAccessedAt[cacheKey];
    if (previousAccessedAt === undefined || accessedAt > previousAccessedAt) {
      siteState.pendingAccessedAt[cacheKey] = accessedAt;
    }
    siteState.metadataPersistDirty = true;
    this.scheduleMetadataPersist(siteKey);
  }

  private isEntryStale(entry: CacheEntryState, currentTime: number): boolean {
    return currentTime - entry.updatedAt >= this.config.staleAfterMs;
  }

  private isEntryExpired(entry: CacheEntryState, currentTime: number): boolean {
    return currentTime - entry.lastAccessedAt >= this.config.evictAfterMs;
  }

  private removeExpiredEntries(
    entries: Record<string, CacheEntryState>,
    currentTime: number,
  ): number {
    let removedEntries = 0;

    for (const [cacheKey, entry] of Object.entries(entries)) {
      if (!this.isEntryExpired(entry, currentTime)) {
        continue;
      }

      delete entries[cacheKey];
      removedEntries += 1;
    }

    return removedEntries;
  }

  private trimEntriesToCap(
    entries: Record<string, CacheEntryState>,
    protectedCacheKey?: string,
  ): number {
    let count = Object.keys(entries).length;
    const entrySizes = new Map(Object.entries(entries).map(([key, entry]) => [key, Buffer.byteLength(JSON.stringify({ [key]: entry }))]));
    let bytes = Array.from(entrySizes.values()).reduce((sum, size) => sum + size, 0);
    // Leave room for the snapshot envelope and site key.
    const maxBytes = MAX_SNAPSHOT_BYTES - 1024;
    if (count <= MAX_ENTRIES_PER_SITE && bytes <= maxBytes) {
      return 0;
    }

    const oldestEntries = Object.entries(entries)
      .filter(([cacheKey]) => cacheKey !== protectedCacheKey)
      .sort(([leftKey, leftEntry], [rightKey, rightEntry]) => {
        const accessDifference = leftEntry.lastAccessedAt - rightEntry.lastAccessedAt;
        if (accessDifference !== 0) {
          return accessDifference;
        }

        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });

    let removed = 0;
    for (const [cacheKey] of oldestEntries) {
      if (count <= MAX_ENTRIES_PER_SITE && bytes <= maxBytes) break;
      bytes -= entrySizes.get(cacheKey)!;
      count--;
      removed++;
      delete entries[cacheKey];
    }

    if (bytes > maxBytes) throw new HttpError(502, "CACHE_TOO_LARGE", "The cache entry exceeds the snapshot budget.");
    return removed;
  }

  private mergePendingAccesses(
    prior: Record<string, number>,
    concurrent: Record<string, number>,
  ): Record<string, number> {
    const merged = { ...prior };
    for (const [cacheKey, accessedAt] of Object.entries(concurrent)) {
      merged[cacheKey] = Math.max(merged[cacheKey] ?? Number.NEGATIVE_INFINITY, accessedAt);
    }
    return merged;
  }

  private buildWorkingEntries(siteState: SiteCacheState): Record<string, CacheEntryState> {
    const entries = this.cloneEntries(siteState.entries);

    for (const [cacheKey, pendingAccessedAt] of Object.entries(siteState.pendingAccessedAt)) {
      const entry = entries[cacheKey];
      if (entry && pendingAccessedAt > entry.lastAccessedAt) {
        entry.lastAccessedAt = pendingAccessedAt;
      }
    }

    return entries;
  }

  private cloneEntries(
    entries: Record<string, CacheEntryState>,
  ): Record<string, CacheEntryState> {
    return structuredClone(entries);
  }

  private async persistSiteSnapshot(
    siteKey: string,
    entries: Record<string, CacheEntryState>,
    savedAt: number,
    protectedCacheKey?: string,
  ): Promise<void> {
    this.trimEntriesToCap(entries, protectedCacheKey);
    await this.persistence.saveSiteSnapshot(siteKey, entries, savedAt);
  }

  /**
   * Persist a staged map and make it resident only after the write succeeds.
   * Accesses that arrive while persistence is in flight remain in a separate
   * map and are therefore not overwritten by this commit.
   */
  private async saveCandidateAndCommit(
    siteKey: string,
    siteState: SiteCacheState,
    candidateEntries: Record<string, CacheEntryState>,
    savedAt: number,
    protectedCacheKey?: string,
  ): Promise<void> {
    const priorPendingAccesses = siteState.pendingAccessedAt;
    siteState.pendingAccessedAt = {};
    siteState.metadataPersistDirty = false;

    try {
      await this.persistSiteSnapshot(siteKey, candidateEntries, savedAt, protectedCacheKey);
    } catch (error) {
      // Keep the old resident entries and retain metadata from before and
      // during the failed write. A later hit-triggered write can retry it.
      siteState.pendingAccessedAt = this.mergePendingAccesses(
        priorPendingAccesses,
        siteState.pendingAccessedAt,
      );
      siteState.metadataPersistDirty = true;
      throw error;
    }

    siteState.entries = candidateEntries;
    siteState.loaded = true;
    for (const [cacheKey, pendingAccessedAt] of Object.entries(siteState.pendingAccessedAt)) {
      const committedEntry = candidateEntries[cacheKey];
      if (!committedEntry || pendingAccessedAt <= committedEntry.lastAccessedAt) {
        delete siteState.pendingAccessedAt[cacheKey];
      }
    }
    siteState.metadataPersistDirty = Object.keys(siteState.pendingAccessedAt).length > 0;
  }

  private scheduleMetadataPersist(siteKey: string): void {
    const siteState = this.getOrCreateSiteState(siteKey);
    siteState.metadataPersistDirty = true;
    if (siteState.hasQueuedPersist) {
      return;
    }

    siteState.hasQueuedPersist = true;

    const queuedWork = this.runWithSiteLock(siteKey, async () => {
      let persisted = false;

      try {
        const lockedSiteState = await this.loadSiteSnapshotIfNeeded(siteKey);
        if (
          !lockedSiteState.metadataPersistDirty &&
          Object.keys(lockedSiteState.pendingAccessedAt).length === 0
        ) {
          return;
        }

        const currentTime = this.now();
        const candidateEntries = this.buildWorkingEntries(lockedSiteState);
        this.removeExpiredEntries(candidateEntries, currentTime);
        this.trimEntriesToCap(candidateEntries);
        await this.saveCandidateAndCommit(
          siteKey,
          lockedSiteState,
          candidateEntries,
          currentTime,
        );
        persisted = true;
      } catch (error) {
        this.logger.error("Failed to persist cache access metadata.", {
          siteKey,
          cause: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        siteState.hasQueuedPersist = false;

        // Capture at most one follow-up per completed write.  This records an
        // access that raced the write without spinning in a loop while hits
        // continue to arrive.
        if (
          persisted &&
          siteState.metadataPersistDirty &&
          Object.keys(siteState.pendingAccessedAt).length > 0
        ) {
          this.scheduleMetadataPersist(siteKey);
        }
      }
    });

    // Reconcile lifecycle state after the whole queued operation settles. The
    // lock's finally block runs before this promise settles, but an admission
    // waiter must also see the flags cleared by the task callback itself.
    void queuedWork.then(
      () => this.reconcileResidentAdmission(siteKey, siteState),
      () => this.reconcileResidentAdmission(siteKey, siteState),
    );
  }

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

    const queuedWork = this.runWithSiteLock(siteKey, async () => {
      try {
        const lockedSiteState = await this.loadSiteSnapshotIfNeeded(siteKey);
        const currentTime = this.now();
        const lockedEntries = this.buildWorkingEntries(lockedSiteState);
        this.removeExpiredEntries(lockedEntries, currentTime);
        this.trimEntriesToCap(lockedEntries);
        const existingEntry = lockedEntries[cacheKey];
        if (!existingEntry || !this.isEntryStale(existingEntry, currentTime)) {
          return;
        }

        const freshResponse = await this.client.fetchMergedResponse(airtableUrl);
        const completedAt = this.now();
        this.touchSiteState(lockedSiteState, completedAt);
        const candidateEntries = this.buildWorkingEntries(lockedSiteState);
        this.removeExpiredEntries(candidateEntries, completedAt);
        this.trimEntriesToCap(candidateEntries);
        const refreshedEntry = candidateEntries[cacheKey];

        // If the stale entry aged out while the upstream request was in
        // flight, do not resurrect it merely because refresh completed.
        if (!refreshedEntry) {
          return;
        }

        candidateEntries[cacheKey] = {
          body: structuredClone(freshResponse.body),
          updatedAt: completedAt,
          lastAccessedAt: Math.max(existingEntry.lastAccessedAt, refreshedEntry.lastAccessedAt),
        };
        await this.saveCandidateAndCommit(
          siteKey,
          lockedSiteState,
          candidateEntries,
          completedAt,
        );
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

    // Re-run admission reconciliation after the background task has settled,
    // including after its refresh marker is removed in the task finally.
    void queuedWork.then(
      () => this.reconcileResidentAdmission(siteKey, siteState),
      () => this.reconcileResidentAdmission(siteKey, siteState),
    );
  }

  private async runWithSiteLock<T>(siteKey: string, task: () => Promise<T>): Promise<T> {
    const siteState = this.getOrCreateSiteState(siteKey);
    this.touchSiteState(siteState);

    const previousQueuedTask = this.siteQueueByKey.get(siteKey) ?? Promise.resolve();
    let releaseCurrentQueueSlot: (() => void) | undefined;
    const currentQueueSlot = new Promise<void>((resolve) => {
      releaseCurrentQueueSlot = resolve;
    });
    const updatedQueueTail = previousQueuedTask
      .catch(() => undefined)
      .then(() => currentQueueSlot);
    this.siteQueueByKey.set(siteKey, updatedQueueTail);

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
      this.reconcileResidentAdmission(siteKey, siteState);
    }
  }

  private reconcileResidentAdmission(siteKey: string, siteState: SiteCacheState): void {
    this.scheduleResidentEviction(siteKey, siteState);
    this.trimResidentStates(
      this.residentAdmissionWaiters.size > 0 ? MAX_RESIDENT_SITES - 1 : MAX_RESIDENT_SITES,
    );
  }

  private async waitForSiteQueueToDrain(siteKey: string): Promise<void> {
    while (true) {
      const queuedWork = this.siteQueueByKey.get(siteKey);
      if (!queuedWork) {
        return;
      }

      await queuedWork.catch(() => undefined);

      if (this.siteQueueByKey.get(siteKey) === queuedWork) {
        return;
      }
    }
  }

  private scheduleResidentEviction(siteKey: string, state?: SiteCacheState): void {
    const siteState = state ?? this.siteStateByKey.get(siteKey);
    if (!siteState || this.siteStateByKey.get(siteKey) !== siteState) {
      return;
    }

    if (siteState.residentEvictionTimer) {
      clearTimeout(siteState.residentEvictionTimer);
      siteState.residentEvictionTimer = undefined;
    }

    if (
      siteState.activeRequestCount > 0 ||
      this.siteQueueByKey.has(siteKey) ||
      siteState.refreshingCacheKeys.size > 0 ||
      siteState.hasQueuedPersist
    ) {
      return;
    }

    if (siteState.metadataPersistDirty) {
      // Retain failed access writes and retry without spinning or losing them to LRU pressure.
      siteState.residentEvictionTimer = setTimeout(() => this.scheduleMetadataPersist(siteKey), 1_000);
      siteState.residentEvictionTimer.unref?.();
      return;
    }

    const entryCount = Object.keys(siteState.entries).length;
    if (!siteState.loaded) {
      this.siteStateByKey.delete(siteKey);
      this.wakeResidentAdmissionWaiters();
      return;
    }

    const currentTime = this.now();
    if (
      entryCount > 0 &&
      Object.values(siteState.entries).every((entry) => this.isEntryExpired(entry, currentTime))
    ) {
      // The durable snapshot is deliberately left untouched.  A later
      // request can reload it and perform normal cleanup/fetch behavior.
      this.siteStateByKey.delete(siteKey);
      this.wakeResidentAdmissionWaiters();
      return;
    }

    const age = Math.max(0, currentTime - siteState.lastUsedAt);
    const remainingMs = this.config.evictAfterMs - age;
    if (remainingMs <= 0) {
      this.siteStateByKey.delete(siteKey);
      this.wakeResidentAdmissionWaiters();
      return;
    }
    const delayMs = Math.max(1, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
    siteState.residentEvictionTimer = setTimeout(() => {
      siteState.residentEvictionTimer = undefined;
      this.scheduleResidentEviction(siteKey, siteState);
    }, delayMs);

    // Timers should not keep a short-lived worker alive solely to release a
    // cache object.  Node's Timeout exposes unref; browser-like test timers do
    // not, hence the guarded call.
    const timer = siteState.residentEvictionTimer as unknown as { unref?: () => void };
    timer.unref?.();
  }
}
