// This module owns the on-disk cache files for one site.
// It keeps the newer JSON snapshot as the source of truth, rebuilds the
// public preload file from that snapshot, and knows how to upgrade older cache
// files into the current format without changing the service behavior.
import { promises as fileSystem } from "fs";
import path from "node:path";

import { assertJsonObject, HttpError } from "@/lib/airtable-cache/errors";
import {
  normalizeAirtableUrl,
  normalizeSiteKey,
  siteKeyToFileToken,
} from "@/lib/airtable-cache/request";
import {
  AirtableConfig,
  CacheEntryState,
  CachePersistence,
  cloneJsonObject,
  isJsonObject,
  JsonObject,
  Logger,
  SiteSnapshot,
  stripOffsetField,
} from "@/lib/airtable-cache/types";

// This is the shape of one old cache page entry that was stored in legacy
// preload files before the service switched to a single JSON snapshot.
interface LegacyCachePage {
  rawUrl: string;
  body: JsonObject;
}

// Legacy cache files could keep the first page separately from the rest of the
// pages fetched by Airtable offset token.
interface LegacyPageGroup {
  basePage?: LegacyCachePage;
  paginatedPagesByOffset: Map<string, LegacyCachePage>;
}

// A migration result tells the caller which cache entries were recovered and
// which old files can be removed after the new snapshot has been written.
interface LegacyMigrationResult {
  entries: Record<string, CacheEntryState>;
  filesToDelete: string[];
}

// ENOENT means "the file does not exist", which is the normal case when the
// cache has not been written yet.
function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

// Build the JavaScript preload file that the public site can load before the
// app starts asking the service for cache data.
function buildPreloadScript(entries: Record<string, CacheEntryState>): string {
  // The public preload file mirrors the merged cache payloads only. Metadata stays private in
  // the JSON snapshot so the browser never becomes another source of truth.
  const preloadBody = Object.fromEntries(
    Object.entries(entries).map(([cacheKey, entry]) => [cacheKey, stripOffsetField(entry.body)]),
  );

  return `export const cache = ${JSON.stringify(preloadBody, null, 2)};\nwindow.airtableCache = cache;\n`;
}

// Write a file by first writing a temporary file and then renaming it into
// place, so readers never see a half-written file.
async function writeFileAtomically(filePath: string, contents: string): Promise<void> {
  await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fileSystem.writeFile(temporaryPath, contents, "utf8");
  await fileSystem.rename(temporaryPath, filePath);
}

// Read a file if it exists, or return null if the path is missing.
async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fileSystem.readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

// Put back the previous file contents if a later write step fails.
async function restoreFileContents(
  filePath: string,
  previousContents: string | null,
): Promise<void> {
  if (previousContents === null) {
    await fileSystem.rm(filePath, { force: true });
    return;
  }

  await writeFileAtomically(filePath, previousContents);
}

// Pull the JSON object out of an old preload file that wrapped the data inside
// `export const cache = ...` JavaScript.
function extractLegacyPreloadJson(fileContents: string): string {
  const match = fileContents.match(
    /export const cache =\s*(\{[\s\S]*\})\s*;\s*window\.airtableCache = cache;?\s*$/,
  );

  if (!match) {
    throw new Error("The cache file does not match the expected preload format.");
  }

  return match[1];
}

// Extract the Airtable offset token from a URL if one is present.
function readOffsetTokenFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return parsed.searchParams.get("offset");
  } catch {
    return null;
  }
}

// Normalize one loaded snapshot entry so bad or missing metadata does not break
// the rest of the cache snapshot.
function normalizeLoadedSnapshotEntry(
  now: number,
  rawEntry: unknown,
): CacheEntryState | null {
  if (!isJsonObject(rawEntry) || !isJsonObject(rawEntry.body)) {
    return null;
  }

  const updatedAt =
    typeof rawEntry.updatedAt === "number" && Number.isFinite(rawEntry.updatedAt)
      ? rawEntry.updatedAt
      : now;
  const lastAccessedAt =
    typeof rawEntry.lastAccessedAt === "number" && Number.isFinite(rawEntry.lastAccessedAt)
      ? rawEntry.lastAccessedAt
      : updatedAt;

  return {
    body: stripOffsetField(rawEntry.body),
    updatedAt,
    lastAccessedAt,
  };
}

// Merge the old page-per-file cache layout into the one-entry-per-query layout
// that the current service uses.
function mergeLegacyPaginatedResponses(
  rawEntries: Record<string, JsonObject>,
  timestamps: Record<string, number>,
  now: number,
): Record<string, CacheEntryState> {
  // Legacy files stored each Airtable page separately. Migration rebuilds the single merged
  // dataset that the current service contract promises for every base Airtable query.
  const pageGroupsByNormalizedUrl = new Map<string, LegacyPageGroup>();

  for (const [rawUrl, body] of Object.entries(rawEntries)) {
    const normalizedKey = normalizeAirtableUrl(rawUrl);
    if (!normalizedKey) {
      continue;
    }

    const pageGroup =
      pageGroupsByNormalizedUrl.get(normalizedKey) ??
      {
        paginatedPagesByOffset: new Map<string, LegacyCachePage>(),
      };

    const offsetToken = readOffsetTokenFromUrl(rawUrl);
    if (offsetToken) {
      pageGroup.paginatedPagesByOffset.set(offsetToken, { rawUrl, body });
    } else {
      pageGroup.basePage = { rawUrl, body };
    }

    pageGroupsByNormalizedUrl.set(normalizedKey, pageGroup);
  }

  const mergedEntries: Record<string, CacheEntryState> = {};

  for (const [cacheKey, pageGroup] of pageGroupsByNormalizedUrl.entries()) {
    if (!pageGroup.basePage) {
      continue;
    }

    const baseBody = cloneJsonObject(pageGroup.basePage.body);
    const mergedBody = stripOffsetField(baseBody);
    const sourceRawUrls = [pageGroup.basePage.rawUrl];

    if (
      typeof pageGroup.basePage.body.offset === "string" &&
      pageGroup.basePage.body.offset.length > 0
    ) {
      if (!Array.isArray(baseBody.records)) {
        continue;
      }

      const mergedRecords = [...baseBody.records];
      const visitedOffsets = new Set<string>();
      let nextOffset: string | undefined = pageGroup.basePage.body.offset;
      let isComplete = true;

      while (nextOffset) {
        if (visitedOffsets.has(nextOffset)) {
          isComplete = false;
          break;
        }

        visitedOffsets.add(nextOffset);
        const nextPage = pageGroup.paginatedPagesByOffset.get(nextOffset);
        if (!nextPage || !Array.isArray(nextPage.body.records)) {
          isComplete = false;
          break;
        }

        mergedRecords.push(...nextPage.body.records);
        sourceRawUrls.push(nextPage.rawUrl);
        nextOffset =
          typeof nextPage.body.offset === "string" && nextPage.body.offset.length > 0
            ? nextPage.body.offset
            : undefined;
      }

      if (!isComplete) {
        continue;
      }

      mergedBody.records = mergedRecords;
    }

    const sourceUpdatedAtValues = sourceRawUrls
      .map((rawUrl) => timestamps[rawUrl])
      .filter((value): value is number => Number.isFinite(value));
    const updatedAt =
      sourceUpdatedAtValues.length > 0 ? Math.max(...sourceUpdatedAtValues) : now;

    mergedEntries[cacheKey] = {
      body: mergedBody,
      updatedAt,
      lastAccessedAt: updatedAt,
    };
  }

  return mergedEntries;
}

// FileSystemCachePersistence is the disk-backed store for cache snapshots and
// their derived preload files.
export class FileSystemCachePersistence implements CachePersistence {
  // The constructor keeps the config, logger, and clock together so the class
  // can be tested without depending on real environment values or wall clock time.
  constructor(
    private readonly config: AirtableConfig,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  // Load the current cache snapshot for one site, or migrate older cache files
  // if the new snapshot does not exist yet.
  async loadSiteSnapshot(siteKey: string): Promise<SiteSnapshot | null> {
    const snapshotPath = this.getSnapshotPath(siteKey);

    try {
      const fileContents = await fileSystem.readFile(snapshotPath, "utf8");
      const parsed = JSON.parse(fileContents) as unknown;
      const snapshot = this.normalizeLoadedSnapshot(siteKey, parsed);
      await this.reconcileDerivedPreloadFile(siteKey, snapshot.entries);
      return snapshot;
    } catch (error) {
      if (isNotFoundError(error)) {
        return this.migrateLegacyArtifacts(siteKey);
      }

      if (error instanceof SyntaxError) {
        throw new HttpError(
          500,
          "CACHE_PARSE_FAILED",
          "Failed to parse the persisted cache snapshot.",
          { siteKey },
        );
      }

      if (error instanceof HttpError) {
        throw error;
      }

      throw new HttpError(
        500,
        "CACHE_READ_FAILED",
        "Failed to read the persisted cache snapshot.",
        {
          siteKey,
          cause: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }
  }

  // Rebuild every missing or stale public preload file from the canonical JSON snapshots.
  // The live service now relies on the `/cache-<site>.js` rewrite route to heal one file on
  // demand, but this bulk helper is still useful for maintenance scripts and focused tests.
  async reconcileAllDerivedPreloadFiles(): Promise<void> {
    const snapshotFilePaths = await this.findSnapshotPaths();

    for (const snapshotFilePath of snapshotFilePaths) {
      try {
        const fileContents = await fileSystem.readFile(snapshotFilePath, "utf8");
        const parsed = JSON.parse(fileContents) as unknown;
        assertJsonObject(parsed, 500, "CACHE_PARSE_FAILED", "Cache snapshot must be an object.");

        if (typeof parsed.siteKey !== "string") {
          this.logger.warn("Skipping startup preload reconciliation for a snapshot without siteKey.", {
            snapshotFilePath,
          });
          continue;
        }

        const siteKey = normalizeSiteKey(parsed.siteKey);
        const snapshot = this.normalizeLoadedSnapshot(siteKey, parsed);
        await this.reconcileDerivedPreloadFile(siteKey, snapshot.entries);
      } catch (error) {
        this.logger.error("Failed to reconcile a startup preload file from a snapshot.", {
          snapshotFilePath,
          cause: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  }

  // Save one site's cache snapshot and its derived preload file.
  async saveSiteSnapshot(
    siteKey: string,
    entries: Record<string, CacheEntryState>,
    savedAt: number,
  ): Promise<void> {
    const snapshot: SiteSnapshot = {
      version: 1,
      siteKey,
      savedAt,
      entries: Object.fromEntries(
        Object.entries(entries).map(([cacheKey, entry]) => [
          cacheKey,
          {
            body: stripOffsetField(entry.body),
            updatedAt: entry.updatedAt,
            lastAccessedAt: entry.lastAccessedAt,
          },
        ]),
      ),
    };

    const snapshotPath = this.getSnapshotPath(siteKey);
    const preloadPath = this.getPreloadPath(siteKey);
    const snapshotContents = `${JSON.stringify(snapshot, null, 2)}\n`;
    const derivedPreloadContents = buildPreloadScript(snapshot.entries);
    let previousSnapshotContents: string | null = null;
    let didWriteNewSnapshot = false;

    try {
      // Write the source-of-truth snapshot first. If the derived preload write fails, restore the
      // previous snapshot so the process never leaves disk state split across versions.
      previousSnapshotContents = await readFileIfExists(snapshotPath);
      await writeFileAtomically(snapshotPath, snapshotContents);
      didWriteNewSnapshot = true;
      await writeFileAtomically(preloadPath, derivedPreloadContents);
      this.logger.info("Persisted site cache.", {
        siteKey,
        snapshotPath,
        preloadPath,
        entryCount: Object.keys(snapshot.entries).length,
      });
    } catch (error) {
      if (didWriteNewSnapshot) {
        try {
          await restoreFileContents(snapshotPath, previousSnapshotContents);
        } catch (rollbackError) {
          this.logger.error("Failed to roll back the snapshot after a preload write failure.", {
            siteKey,
            snapshotPath,
            cause: rollbackError instanceof Error ? rollbackError.message : "Unknown error",
          });
        }
      }

      throw new HttpError(
        500,
        "CACHE_WRITE_FAILED",
        "Failed to persist the cache snapshot to disk.",
        {
          siteKey,
          cause: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }
  }

  // Make sure the public preload file matches the JSON snapshot on disk.
  private async reconcileDerivedPreloadFile(
    siteKey: string,
    entries: Record<string, CacheEntryState>,
  ): Promise<void> {
    const preloadPath = this.getPreloadPath(siteKey);
    const expectedPreloadContents = buildPreloadScript(entries);
    let currentPreloadContents: string | null;

    try {
      currentPreloadContents = await readFileIfExists(preloadPath);
    } catch (error) {
      this.logger.error("Failed to read the derived preload cache file.", {
        siteKey,
        preloadPath,
        cause: error instanceof Error ? error.message : "Unknown error",
      });
      currentPreloadContents = null;
    }

    if (currentPreloadContents === expectedPreloadContents) {
      return;
    }

    try {
      await writeFileAtomically(preloadPath, expectedPreloadContents);
      this.logger.info("Reconciled the derived preload cache file from the JSON snapshot.", {
        siteKey,
        preloadPath,
        reason: currentPreloadContents === null ? "missing" : "mismatch",
      });
    } catch (error) {
      this.logger.error("Failed to reconcile the derived preload cache file.", {
        siteKey,
        preloadPath,
        cause: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  // Normalize the data that was read from disk so the rest of the service can
  // work with one predictable snapshot shape.
  private normalizeLoadedSnapshot(siteKey: string, parsed: unknown): SiteSnapshot {
    const now = this.now();
    assertJsonObject(parsed, 500, "CACHE_PARSE_FAILED", "Cache snapshot must be an object.");

    const rawEntries = isJsonObject(parsed.entries) ? parsed.entries : {};
    const entries = Object.fromEntries(
      Object.entries(rawEntries).flatMap(([cacheKey, rawEntry]) => {
        const normalizedCacheKey = normalizeAirtableUrl(cacheKey);
        const normalizedEntry = normalizeLoadedSnapshotEntry(now, rawEntry);

        if (!normalizedCacheKey || !normalizedEntry) {
          return [];
        }

        return [[normalizedCacheKey, normalizedEntry] as const];
      }),
    );

    return {
      version: 1,
      siteKey,
      savedAt:
        typeof parsed.savedAt === "number" && Number.isFinite(parsed.savedAt)
          ? parsed.savedAt
          : now,
      entries,
    };
  }

  // Look for old cache files, rebuild the merged entries from them, and report
  // which old files can be deleted after migration succeeds.
  private async migrateLegacyArtifacts(siteKey: string): Promise<SiteSnapshot | null> {
    const migration = await this.readLegacyArtifacts(siteKey);
    if (!migration) {
      return null;
    }

    // Migration writes the new snapshot/preload pair first, then removes obsolete legacy files.
    const snapshot: SiteSnapshot = {
      version: 1,
      siteKey,
      savedAt: this.now(),
      entries: migration.entries,
    };

    await this.saveSiteSnapshot(siteKey, migration.entries, snapshot.savedAt);
    await Promise.all(
      migration.filesToDelete
        .filter((filePath) => filePath !== this.getPreloadPath(siteKey))
        .map(async (filePath) => {
          await fileSystem.rm(filePath, { force: true });
        }),
    );

    this.logger.info("Migrated legacy cache files into the JSON snapshot format.", {
      siteKey,
      migratedFiles: migration.filesToDelete,
    });

    return snapshot;
  }

  // Read all older cache files for a site and merge their contents into the new
  // single-snapshot format.
  private async readLegacyArtifacts(siteKey: string): Promise<LegacyMigrationResult | null> {
    const legacyCachePaths = await this.findExistingPaths(this.getLegacyCachePaths(siteKey));
    if (legacyCachePaths.length === 0) {
      return null;
    }

    // Legacy cache files could contain page fragments keyed by `offset`. Those are merged here.
    const legacyTimestampPaths = await this.findExistingPaths(this.getLegacyTimestampPaths(siteKey));
    const rawEntries: Record<string, JsonObject> = {};
    const rawTimestamps: Record<string, number> = {};

    for (const cachePath of legacyCachePaths) {
      Object.assign(rawEntries, await this.readLegacyCacheFile(cachePath));
    }

    for (const timestampPath of legacyTimestampPaths) {
      Object.assign(rawTimestamps, await this.readLegacyTimestampFile(timestampPath));
    }

    const entries = mergeLegacyPaginatedResponses(rawEntries, rawTimestamps, this.now());
    if (Object.keys(entries).length === 0) {
      return null;
    }

    return {
      entries,
      filesToDelete: [...legacyCachePaths, ...legacyTimestampPaths],
    };
  }

  // Read one old preload file and turn it back into plain JSON objects that can
  // be merged into the new snapshot format.
  private async readLegacyCacheFile(filePath: string): Promise<Record<string, JsonObject>> {
    try {
      const fileContents = await fileSystem.readFile(filePath, "utf8");
      const jsonString = extractLegacyPreloadJson(fileContents);
      const parsed = JSON.parse(jsonString) as unknown;

      assertJsonObject(
        parsed,
        500,
        "CACHE_PARSE_FAILED",
        "Legacy cache files must contain an object payload.",
      );

      const entries: Record<string, JsonObject> = {};
      for (const [rawUrl, value] of Object.entries(parsed)) {
        if (!isJsonObject(value)) {
          continue;
        }

        entries[rawUrl] = value;
      }

      return entries;
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      throw new HttpError(
        500,
        "CACHE_PARSE_FAILED",
        "Failed to parse a legacy cache preload file.",
        {
          filePath,
          cause: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }
  }

  // Read one old timestamp file and keep only valid numeric values.
  private async readLegacyTimestampFile(filePath: string): Promise<Record<string, number>> {
    try {
      const fileContents = await fileSystem.readFile(filePath, "utf8");
      const parsed = JSON.parse(fileContents) as unknown;
      assertJsonObject(
        parsed,
        500,
        "CACHE_PARSE_FAILED",
        "Legacy timestamp files must contain an object payload.",
      );

      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === "number" && Number.isFinite(entry[1]),
        ),
      );
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      throw new HttpError(
        500,
        "CACHE_PARSE_FAILED",
        "Failed to parse a legacy timestamp file.",
        {
          filePath,
          cause: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }
  }

  // Build the path to the private JSON snapshot file for one site.
  private getSnapshotPath(siteKey: string): string {
    return path.join(this.config.cacheDataDir, `${siteKeyToFileToken(siteKey)}.json`);
  }

  // Build the path to the public preload file that the browser can import.
  private getPreloadPath(siteKey: string): string {
    return path.join(this.config.publicCacheDir, `cache-${siteKeyToFileToken(siteKey)}.js`);
  }

  // Build the list of legacy preload file names that might still exist for a
  // site, including both the original hostname form and the sanitized token form.
  private getLegacyCachePaths(siteKey: string): string[] {
    const token = siteKeyToFileToken(siteKey);
    const variants = Array.from(new Set([siteKey, token]));
    return variants.map((variant) => path.join(this.config.publicCacheDir, `cache-${variant}.js`));
  }

  // Build the list of old timestamp file names that may still be on disk.
  private getLegacyTimestampPaths(siteKey: string): string[] {
    const token = siteKeyToFileToken(siteKey);
    const variants = Array.from(new Set([siteKey, token]));
    return variants.map((variant) =>
      path.join(this.config.publicCacheDir, `timestamps-${variant}.json`),
    );
  }

  // Return only the paths that actually exist on disk.
  private async findExistingPaths(candidatePaths: string[]): Promise<string[]> {
    const foundPaths: string[] = [];

    for (const candidatePath of candidatePaths) {
      try {
        await fileSystem.access(candidatePath);
        foundPaths.push(candidatePath);
      } catch {
        continue;
      }
    }

    return foundPaths;
  }

  // Return every canonical snapshot file currently stored on disk.
  private async findSnapshotPaths(): Promise<string[]> {
    try {
      const directoryEntries = await fileSystem.readdir(this.config.cacheDataDir, {
        withFileTypes: true,
      });

      return directoryEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => path.join(this.config.cacheDataDir, entry.name));
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }

      throw error;
    }
  }
}
