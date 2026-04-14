import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createAirtableConfig,
  DEFAULT_EVICT_AFTER_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_STALE_AFTER_MS,
} from "@/lib/airtable-cache/config";
import { HttpError } from "@/lib/airtable-cache/errors";

describe("airtable cache config", () => {
  it("creates a config with defaults when only the Airtable key is present", () => {
    const config = createAirtableConfig(
      {
        AIRTABLE_API_KEY: " test-key ",
      } as unknown as NodeJS.ProcessEnv,
      "/srv/airtable",
    );

    expect(config).toEqual({
      apiKey: "test-key",
      cacheDataDir: path.join("/srv/airtable", "data", "cache"),
      publicCacheDir: path.join("/srv/airtable", "public"),
      staleAfterMs: DEFAULT_STALE_AFTER_MS,
      evictAfterMs: DEFAULT_EVICT_AFTER_MS,
      fetchTimeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    });
  });

  it("resolves directory and duration overrides", () => {
    const config = createAirtableConfig(
      {
        AIRTABLE_API_KEY: "key",
        CACHE_DATA_DIR: "../shared/cache",
        CACHE_PUBLIC_DIR: "/var/www/cache-public",
        CACHE_STALE_AFTER_MS: "1234",
        CACHE_EVICT_AFTER_MS: "5678",
        AIRTABLE_FETCH_TIMEOUT_MS: "9012",
      } as unknown as NodeJS.ProcessEnv,
      "/srv/airtable/app",
    );

    expect(config.cacheDataDir).toBe(path.resolve("/srv/airtable/app", "../shared/cache"));
    expect(config.publicCacheDir).toBe("/var/www/cache-public");
    expect(config.staleAfterMs).toBe(1234);
    expect(config.evictAfterMs).toBe(5678);
    expect(config.fetchTimeoutMs).toBe(9012);
  });

  it("rejects missing Airtable keys and invalid duration overrides", () => {
    expect(() => createAirtableConfig({} as unknown as NodeJS.ProcessEnv, "/srv")).toThrow(
      HttpError,
    );

    expect(() =>
      createAirtableConfig(
        {
          AIRTABLE_API_KEY: "key",
          CACHE_STALE_AFTER_MS: "0",
        } as unknown as NodeJS.ProcessEnv,
        "/srv",
      ),
    ).toThrow(/CACHE_STALE_AFTER_MS must be a positive number/i);
  });
});
