import path from "node:path";
import { realpathSync } from "node:fs";

import { HttpError } from "@/lib/airtable-cache/errors";
import { AirtableConfig, CacheConfig } from "@/lib/airtable-cache/types";

export const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
export const DEFAULT_EVICT_AFTER_MS = 72 * 60 * 60 * 1000;
export const DEFAULT_FETCH_TIMEOUT_MS = 15 * 1000;
export const MAX_FETCH_TIMEOUT_MS = 2_147_483_647;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_PERSISTED_SITES = 256;
export const MAX_ACTIVE_REQUESTS = 128;

function parseDurationMs(
  rawValue: string | undefined,
  envKey: string,
  fallbackValue: number,
  maximumValue = Number.MAX_SAFE_INTEGER,
): number {
  if (!rawValue) {
    return fallbackValue;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0 || parsedValue > maximumValue) {
    throw new HttpError(
      500,
      "INVALID_CONFIGURATION",
      `${envKey} must be a positive safe integer number of milliseconds${
        maximumValue === Number.MAX_SAFE_INTEGER ? "" : ` no greater than ${maximumValue}`
      }.`,
      { envKey, providedValue: rawValue },
    );
  }

  return parsedValue;
}

function resolveDirectory(
  cwd: string,
  rawValue: string | undefined,
  fallbackRelativePath: string,
): string {
  if (!rawValue) {
    return path.join(cwd, fallbackRelativePath);
  }

  return path.resolve(cwd, rawValue);
}

function isInsideDirectory(candidatePath: string, directoryPath: string): boolean {
  const relativePath = path.relative(directoryPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== "..");
}

function physicalPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = path.dirname(filePath);
    if (parent === filePath) throw error;
    // These are deployment-time writable paths, not files to bundle into the build.
    return path.join(/* turbopackIgnore: true */ physicalPath(parent), path.basename(filePath));
  }
}

export function createAirtableConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): AirtableConfig {
  const apiKey = env.AIRTABLE_API_KEY?.trim();
  if (!apiKey) {
    throw new HttpError(
      500,
      "MISSING_AIRTABLE_API_KEY",
      "AIRTABLE_API_KEY is required to proxy Airtable requests.",
    );
  }

  return {
    ...createCacheConfig(env, cwd),
    apiKey,
    fetchTimeoutMs: parseDurationMs(env.AIRTABLE_FETCH_TIMEOUT_MS, "AIRTABLE_FETCH_TIMEOUT_MS", DEFAULT_FETCH_TIMEOUT_MS, MAX_FETCH_TIMEOUT_MS),
  };
}

export function createCacheConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): CacheConfig {
  const preloadCacheDir = physicalPath(resolveDirectory(
    cwd,
    env.CACHE_PRELOAD_DIR,
    path.join("data", "preloads"),
  ));
  const publicDirectory = physicalPath(path.join(cwd, "public"));

  if (isInsideDirectory(preloadCacheDir, publicDirectory)) {
    throw new HttpError(
      500,
      "INVALID_CONFIGURATION",
      "CACHE_PRELOAD_DIR must be outside the project public directory.",
      { envKey: "CACHE_PRELOAD_DIR", providedValue: preloadCacheDir },
    );
  }

  return {
    cacheDataDir: physicalPath(resolveDirectory(cwd, env.CACHE_DATA_DIR, path.join("data", "cache"))),
    preloadCacheDir,
    staleAfterMs: parseDurationMs(
      env.CACHE_STALE_AFTER_MS,
      "CACHE_STALE_AFTER_MS",
      DEFAULT_STALE_AFTER_MS,
    ),
    evictAfterMs: parseDurationMs(
      env.CACHE_EVICT_AFTER_MS,
      "CACHE_EVICT_AFTER_MS",
      DEFAULT_EVICT_AFTER_MS,
    ),
  };
}
