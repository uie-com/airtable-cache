import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createAirtableConfig,
  DEFAULT_EVICT_AFTER_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_STALE_AFTER_MS,
  MAX_FETCH_TIMEOUT_MS,
} from "@/lib/airtable-cache/config";
import { HttpError } from "@/lib/airtable-cache/errors";

describe("airtable cache config", () => {
  it("uses a non-public preload directory by default", () => {
    const config = createAirtableConfig({ AIRTABLE_API_KEY: " test-key " } as unknown as NodeJS.ProcessEnv, "/srv/app");
    expect(config).toEqual({
      apiKey: "test-key",
      cacheDataDir: path.join("/srv/app", "data", "cache"),
      preloadCacheDir: path.join("/srv/app", "data", "preloads"),
      staleAfterMs: DEFAULT_STALE_AFTER_MS,
      evictAfterMs: DEFAULT_EVICT_AFTER_MS,
      fetchTimeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    });
  });

  it("accepts custom non-public directories and rejects public descendants", () => {
    const config = createAirtableConfig(
      { AIRTABLE_API_KEY: "key", CACHE_PRELOAD_DIR: "../preloads" } as unknown as NodeJS.ProcessEnv,
      "/srv/app",
    );
    expect(config.preloadCacheDir).toBe("/srv/preloads");
    expect(() => createAirtableConfig(
      { AIRTABLE_API_KEY: "key", CACHE_PRELOAD_DIR: "public/generated" } as unknown as NodeJS.ProcessEnv,
      "/srv/app",
    )).toThrow(HttpError);
  });

  it("rejects missing keys and invalid durations", () => {
    expect(() => createAirtableConfig({} as unknown as NodeJS.ProcessEnv, "/srv")).toThrow(HttpError);
    expect(() => createAirtableConfig(
      { AIRTABLE_API_KEY: "key", CACHE_STALE_AFTER_MS: "0" } as unknown as NodeJS.ProcessEnv,
      "/srv",
    )).toThrow(/CACHE_STALE_AFTER_MS must be a positive safe integer/i);
  });

  it("requires integer-safe durations and a platform-safe fetch timeout", () => {
    for (const [envKey, value] of [
      ["CACHE_EVICT_AFTER_MS", "1.5"],
      ["CACHE_STALE_AFTER_MS", String(Number.MAX_SAFE_INTEGER + 1)],
      ["AIRTABLE_FETCH_TIMEOUT_MS", "1.5"],
      ["AIRTABLE_FETCH_TIMEOUT_MS", String(MAX_FETCH_TIMEOUT_MS + 1)],
    ]) {
      expect(() => createAirtableConfig(
        { AIRTABLE_API_KEY: "key", [envKey]: value } as unknown as NodeJS.ProcessEnv,
        "/srv",
      )).toThrow(HttpError);
    }

    expect(() => createAirtableConfig(
      { AIRTABLE_API_KEY: "key", AIRTABLE_FETCH_TIMEOUT_MS: String(MAX_FETCH_TIMEOUT_MS + 1) } as unknown as NodeJS.ProcessEnv,
      "/srv",
    )).toThrow(`no greater than ${MAX_FETCH_TIMEOUT_MS}`);

    expect(createAirtableConfig(
      { AIRTABLE_API_KEY: "key", AIRTABLE_FETCH_TIMEOUT_MS: String(MAX_FETCH_TIMEOUT_MS) } as unknown as NodeJS.ProcessEnv,
      "/srv",
    ).fetchTimeoutMs).toBe(MAX_FETCH_TIMEOUT_MS);
  });
});
