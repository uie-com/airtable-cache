// This file turns environment variables into the one configuration object the cache service uses.
// The goal is to keep the rest of the service from reading `process.env` directly so the behavior
// stays centralized, testable, and easier for a new teammate to understand.
import path from "node:path";

import { HttpError } from "@/lib/airtable-cache/errors";
import { AirtableConfig } from "@/lib/airtable-cache/types";

// This is the default age, in milliseconds, after which a cache entry is considered stale.
// Stale entries can still be served, but the service will try to refresh them in the background.
export const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
// This is the default lifetime, in milliseconds, after which a cache entry should be removed.
// Once an entry is this old, the service treats it as expired instead of trying to reuse it.
export const DEFAULT_EVICT_AFTER_MS = 72 * 60 * 60 * 1000;
// This is the default timeout, in milliseconds, for outbound Airtable fetches.
// It prevents a slow upstream request from tying up the service forever.
export const DEFAULT_FETCH_TIMEOUT_MS = 15 * 1000;

// Read a duration from an environment variable and make sure it is a real positive number.
// If the variable is missing, the caller's fallback value is used instead.
function parseDurationMs(
  rawValue: string | undefined,
  envKey: string,
  fallbackValue: number,
): number {
  if (!rawValue) {
    return fallbackValue;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new HttpError(
      500,
      "INVALID_CONFIGURATION",
      `${envKey} must be a positive number of milliseconds.`,
      { envKey, providedValue: rawValue },
    );
  }

  return parsedValue;
}

// Convert a path from configuration into an absolute directory path.
// If the environment variable is missing, the code falls back to a known directory relative to the
// current working directory so the service has a stable default on disk.
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

// Build the complete Airtable cache configuration from environment variables.
// This is the only place that enforces required settings and default values, which keeps the rest of
// the code from repeating the same checks in multiple places.
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
    apiKey,
    cacheDataDir: resolveDirectory(cwd, env.CACHE_DATA_DIR, path.join("data", "cache")),
    publicCacheDir: resolveDirectory(cwd, env.CACHE_PUBLIC_DIR, "public"),
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
    fetchTimeoutMs: parseDurationMs(
      env.AIRTABLE_FETCH_TIMEOUT_MS,
      "AIRTABLE_FETCH_TIMEOUT_MS",
      DEFAULT_FETCH_TIMEOUT_MS,
    ),
  };
}
