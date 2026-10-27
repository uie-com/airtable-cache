import { promises as fileSystem } from "fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { MAX_ACTIVE_REQUESTS, MAX_PERSISTED_SITES, MAX_SNAPSHOT_BYTES } from "@/lib/airtable-cache/config";

import { assertJsonObject, HttpError } from "@/lib/airtable-cache/errors";
import {
  normalizeAirtableUrl,
  normalizeSiteKey,
  siteKeyToFileToken,
} from "@/lib/airtable-cache/request";
import {
  buildPreloadScript,
  isCanonicalPreloadToken,
  isNotFoundError,
  preloadTokenFromFileName,
  writeFileAtomically,
} from "@/lib/airtable-cache/persistence/file-utils";
import {
  CacheConfig,
  CacheEntryState,
  CachePersistence,
  isJsonObject,
  Logger,
  SiteSnapshot,
  stripOffsetField,
} from "@/lib/airtable-cache/types";

interface FileSignature {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

interface ValidatedSnapshot {
  snapshot: SiteSnapshot;
  signature: FileSignature;
}

interface ValidatedPreloadSignature {
  snapshot: FileSignature;
  artifact: FileSignature;
  validUntil: number;
  policy: string;
  etag: string;
}

// ponytail: serialize local filesystem transactions; use per-site locks plus a
// directory admission lock if measured disk contention warrants the extra machinery.
const shared = globalThis as typeof globalThis & { __airtablePersistenceQueue?: { tail: Promise<unknown>; pending: number } };
const queue = shared.__airtablePersistenceQueue ??= { tail: Promise.resolve(), pending: 0 };
async function withPersistenceLock<T>(task: () => Promise<T>): Promise<T> {
  if (queue.pending >= MAX_ACTIVE_REQUESTS) throw new HttpError(503, "CACHE_BUSY", "The cache is busy. Retry shortly.");
  queue.pending++;
  const operation = queue.tail.then(task);
  queue.tail = operation.catch(() => undefined);
  try {
    return await operation;
  } finally {
    queue.pending--;
  }
}

const MAX_VALIDATED_SNAPSHOT_SIGNATURES = 256;
const validatedSnapshotSignatures = new Map<string, ValidatedPreloadSignature>();

function getValidatedSnapshotSignature(snapshotPath: string): ValidatedPreloadSignature | undefined {
  const signature = validatedSnapshotSignatures.get(snapshotPath);
  if (signature) {
    // Map insertion order provides a compact fixed-size LRU without extra state.
    validatedSnapshotSignatures.delete(snapshotPath);
    validatedSnapshotSignatures.set(snapshotPath, signature);
  }
  return signature;
}

function rememberValidatedSnapshotSignature(
  snapshotPath: string,
  signature: ValidatedPreloadSignature,
): void {
  validatedSnapshotSignatures.delete(snapshotPath);
  validatedSnapshotSignatures.set(snapshotPath, signature);
  if (validatedSnapshotSignatures.size > MAX_VALIDATED_SNAPSHOT_SIGNATURES) {
    const oldest = validatedSnapshotSignatures.keys().next();
    if (!oldest.done) {
      validatedSnapshotSignatures.delete(oldest.value);
    }
  }
}

function fileSignature(stat: Awaited<ReturnType<typeof fileSystem.stat>>): FileSignature {
  return {
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
    ino: Number(stat.ino),
  };
}

function sameSignature(left: FileSignature, right: FileSignature): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.ino === right.ino;
}

function normalizeLoadedSnapshotEntry(now: number, rawEntry: unknown): CacheEntryState | null {
  if (!isJsonObject(rawEntry) || !isJsonObject(rawEntry.body)) {
    return null;
  }
  const { updatedAt, lastAccessedAt } = rawEntry;
  // Invalid or future dates cannot establish freshness. Clamping to `now`
  // would restart their freshness window every time the snapshot is read.
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < 0 || updatedAt > now ||
      typeof lastAccessedAt !== "number" || !Number.isFinite(lastAccessedAt) || lastAccessedAt < 0 || lastAccessedAt > now) {
    return null;
  }

  return { body: stripOffsetField(rawEntry.body), updatedAt, lastAccessedAt };
}

function snapshotPathForToken(config: CacheConfig, token: string): string {
  return path.join(config.cacheDataDir, `${token}.json`);
}

export function preloadPathForToken(config: CacheConfig, token: string): string {
  return path.join(config.preloadCacheDir, `cache-${token}.js`);
}

function normalizeSnapshot(
  expectedToken: string,
  parsed: unknown,
  now: () => number,
): SiteSnapshot {
  assertJsonObject(parsed, 500, "CACHE_PARSE_FAILED", "Cache snapshot must be an object.");
  if (parsed.version !== 1 || typeof parsed.siteKey !== "string" || !isJsonObject(parsed.entries)) {
    throw new HttpError(500, "CACHE_PARSE_FAILED", "Cache snapshot has an invalid schema.");
  }

  let siteKey: string;
  try {
    siteKey = normalizeSiteKey(parsed.siteKey);
  } catch {
    throw new HttpError(500, "CACHE_PARSE_FAILED", "Cache snapshot has an invalid site key.");
  }
  if (siteKey !== parsed.siteKey || siteKeyToFileToken(siteKey) !== expectedToken) {
    throw new HttpError(500, "CACHE_PARSE_FAILED", "Cache snapshot identity does not match its filename.");
  }

  const currentTime = now();
  const entries = Object.fromEntries(
    Object.entries(parsed.entries).flatMap(([cacheKey, rawEntry]) => {
      const normalizedCacheKey = normalizeAirtableUrl(cacheKey);
      const normalizedEntry = normalizeLoadedSnapshotEntry(currentTime, rawEntry);
      return normalizedCacheKey && normalizedEntry
        ? [[normalizedCacheKey, normalizedEntry] as const]
        : [];
    }),
  );

  return {
    version: 1,
    siteKey,
    savedAt:
      typeof parsed.savedAt === "number" && Number.isFinite(parsed.savedAt)
        ? parsed.savedAt
        : currentTime,
    entries,
  };
}

async function readValidatedSnapshot(
  config: CacheConfig,
  token: string,
  now: () => number,
): Promise<ValidatedSnapshot> {
  const snapshotPath = snapshotPathForToken(config, token);
  const handle = await fileSystem.open(snapshotPath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size > MAX_SNAPSHOT_BYTES) throw new HttpError(500, "CACHE_TOO_LARGE", "The cache snapshot exceeds 4 MiB.");
    const contents = await handle.readFile("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      throw new HttpError(500, "CACHE_PARSE_FAILED", "Failed to parse the persisted cache snapshot.");
    }

    return {
      snapshot: normalizeSnapshot(token, parsed, now),
      signature: fileSignature(stat),
    };
  } finally {
    await handle.close();
  }
}

async function removeDerivedArtifact(config: CacheConfig, token: string): Promise<void> {
  validatedSnapshotSignatures.delete(snapshotPathForToken(config, token));
  await fileSystem.rm(preloadPathForToken(config, token), { force: true });
}

/**
 * Returns the derived artifact only after its matching canonical snapshot has been
 * checked. Snapshot signatures are memoized so unchanged requests only perform stat
 * calls; a changed, missing, or corrupt snapshot can never resurrect a preload.
 */
export async function reconcilePreloadArtifactForToken(
  config: CacheConfig,
  token: string,
  now: () => number = Date.now,
): Promise<string | null> {
  return withPersistenceLock(() => reconcilePreloadArtifactUnlocked(config, token, now));
}

export async function openPreloadArtifact(config: CacheConfig, token: string) {
  return withPersistenceLock(async () => {
    const artifactPath = await reconcilePreloadArtifactUnlocked(config, token, Date.now);
    if (!artifactPath) return null;
    const handle = await fileSystem.open(artifactPath, "r");
    try {
      const stat = await handle.stat();
      const validated = getValidatedSnapshotSignature(snapshotPathForToken(config, token))!;
      if (!sameSignature(validated.artifact, fileSignature(stat))) throw new HttpError(503, "CACHE_CHANGED", "The preload changed. Retry shortly.");
      return { handle, stat, etag: validated.etag };
    } catch (error) {
      await handle.close();
      throw error;
    }
  });
}

async function reconcilePreloadArtifactUnlocked(config: CacheConfig, token: string, now: () => number): Promise<string | null> {
  if (!isCanonicalPreloadToken(token)) {
    return null;
  }
  const snapshotPath = snapshotPathForToken(config, token);
  const preloadPath = preloadPathForToken(config, token);
  const currentTime = now();
  const policy = JSON.stringify([preloadPath, config.staleAfterMs, config.evictAfterMs]);
  let snapshotStat;
  try {
    snapshotStat = await fileSystem.stat(snapshotPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      await removeDerivedArtifact(config, token);
      return null;
    }
    throw new HttpError(500, "CACHE_READ_FAILED", "Failed to read the persisted cache snapshot.");
  }

  const signature = fileSignature(snapshotStat);
  const priorSignature = getValidatedSnapshotSignature(snapshotPath);
  let artifactStat: Awaited<ReturnType<typeof fileSystem.stat>> | null = null;
  try {
    artifactStat = await fileSystem.stat(preloadPath);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw new HttpError(500, "CACHE_READ_FAILED", "Failed to read the derived preload artifact.");
    }
  }

  if (
    priorSignature &&
    sameSignature(priorSignature.snapshot, signature) &&
    artifactStat &&
    sameSignature(priorSignature.artifact, fileSignature(artifactStat)) &&
    priorSignature.policy === policy &&
    currentTime < priorSignature.validUntil
  ) {
    return preloadPath;
  }

  let validated: ValidatedSnapshot;
  try {
    validated = await readValidatedSnapshot(config, token, now);
  } catch (error) {
    await removeDerivedArtifact(config, token);
    throw error;
  }

  // Stale entries must miss in the browser so its existing API fallback can refresh them.
  const freshEntries = Object.entries(validated.snapshot.entries)
    .filter(([, entry]) => currentTime < entry.updatedAt + config.staleAfterMs && currentTime < entry.lastAccessedAt + config.evictAfterMs)
    .sort(([a, left], [b, right]) => right.lastAccessedAt - left.lastAccessedAt || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, 1_000);
  const validUntil = freshEntries.reduce((deadline, [, entry]) => Math.min(deadline, entry.updatedAt + config.staleAfterMs, entry.lastAccessedAt + config.evictAfterMs), Infinity);
  const expectedContents = buildPreloadScript(Object.fromEntries(freshEntries));
  const currentContents = artifactStat && artifactStat.size <= MAX_SNAPSHOT_BYTES * 2
    ? await fileSystem.readFile(preloadPath, "utf8") : null;
  if (currentContents !== expectedContents) {
    await writeFileAtomically(preloadPath, expectedContents);
  }
  const finalArtifactStat = currentContents === expectedContents
    ? artifactStat
    : await fileSystem.stat(preloadPath);
  if (!finalArtifactStat) {
    throw new HttpError(500, "CACHE_WRITE_FAILED", "Failed to write the derived preload artifact.");
  }
  rememberValidatedSnapshotSignature(snapshotPath, {
    snapshot: validated.signature,
    artifact: fileSignature(finalArtifactStat),
    validUntil,
    policy,
    etag: `"${createHash("sha256").update(expectedContents).digest("hex")}"`,
  });
  return preloadPath;
}

export class FileSystemCachePersistence implements CachePersistence {
  constructor(
    private readonly config: CacheConfig,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  private async reconcilePreloadArtifactBestEffort(
    siteKey: string,
    token: string,
    operation: "loading" | "persisting",
  ): Promise<void> {
    try {
      await reconcilePreloadArtifactUnlocked(this.config, token, this.now);
    } catch (error) {
      this.logger.error(`Failed to reconcile the derived preload artifact after ${operation} a snapshot.`, {
        siteKey,
        snapshotPath: snapshotPathForToken(this.config, token),
        preloadPath: preloadPathForToken(this.config, token),
        cause: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async loadSiteSnapshot(rawSiteKey: string): Promise<SiteSnapshot | null> {
    return withPersistenceLock(() => this.loadSiteSnapshotUnlocked(rawSiteKey));
  }

  private async loadSiteSnapshotUnlocked(rawSiteKey: string): Promise<SiteSnapshot | null> {
    const siteKey = normalizeSiteKey(rawSiteKey);
    const token = siteKeyToFileToken(siteKey);
    let validated: ValidatedSnapshot;
    try {
      validated = await readValidatedSnapshot(this.config, token, this.now);
    } catch (error) {
      if (isNotFoundError(error)) {
        await removeDerivedArtifact(this.config, token);
        return null;
      }
      if (error instanceof HttpError) {
        await removeDerivedArtifact(this.config, token);
        throw error;
      }
      throw new HttpError(500, "CACHE_READ_FAILED", "Failed to read the persisted cache snapshot.", {
        siteKey,
        cause: error instanceof Error ? error.message : "Unknown error",
      });
    }

    await this.reconcilePreloadArtifactBestEffort(siteKey, token, "loading");
    return validated.snapshot;
  }

  async saveSiteSnapshot(
    rawSiteKey: string,
    entries: Record<string, CacheEntryState>,
    savedAt: number,
  ): Promise<void> {
    return withPersistenceLock(() => this.saveSiteSnapshotUnlocked(rawSiteKey, entries, savedAt));
  }

  private async saveSiteSnapshotUnlocked(rawSiteKey: string, entries: Record<string, CacheEntryState>, savedAt: number): Promise<void> {
    const siteKey = normalizeSiteKey(rawSiteKey);
    const token = siteKeyToFileToken(siteKey);
    const snapshot: SiteSnapshot = {
      version: 1,
      siteKey,
      savedAt,
      entries: Object.fromEntries(
        Object.entries(entries).flatMap(([cacheKey, entry]) => {
          const normalizedCacheKey = normalizeAirtableUrl(cacheKey);
          return normalizedCacheKey && isJsonObject(entry.body)
            ? [[normalizedCacheKey, {
                body: stripOffsetField(entry.body),
                updatedAt: entry.updatedAt,
                lastAccessedAt: entry.lastAccessedAt,
              }] as const]
            : [];
        }),
      ),
    };
    const snapshotPath = snapshotPathForToken(this.config, token);
    const contents = `${JSON.stringify(snapshot)}\n`;
    if (Buffer.byteLength(contents) > MAX_SNAPSHOT_BYTES) throw new HttpError(500, "CACHE_TOO_LARGE", "The cache snapshot exceeds 4 MiB.");
    await fileSystem.mkdir(this.config.cacheDataDir, { recursive: true }).catch(() => undefined);
    try {
      await fileSystem.stat(snapshotPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        const files = await fileSystem.readdir(this.config.cacheDataDir);
        if (files.filter((name) => name.endsWith(".json")).length >= MAX_PERSISTED_SITES) {
          throw new HttpError(507, "CACHE_SITE_LIMIT", "The cache has reached its 256-site storage limit.");
        }
      }
    }
    try {
      await writeFileAtomically(snapshotPath, contents);
    } catch (error) {
      throw new HttpError(500, "CACHE_WRITE_FAILED", "Failed to persist the cache snapshot to disk.", {
        siteKey,
        cause: error instanceof Error ? error.message : "Unknown error",
      });
    }

    // The canonical snapshot is committed by the rename above. A derived artifact
    // can be retried safely by the runtime route and must not roll that commit back.
    validatedSnapshotSignatures.delete(snapshotPath);
    await this.reconcilePreloadArtifactBestEffort(siteKey, token, "persisting");
    this.logger.info("Persisted site cache.", {
      siteKey,
      snapshotPath,
      preloadPath: preloadPathForToken(this.config, token),
      entryCount: Object.keys(snapshot.entries).length,
    });
  }

}

export { isCanonicalPreloadToken, preloadTokenFromFileName };
