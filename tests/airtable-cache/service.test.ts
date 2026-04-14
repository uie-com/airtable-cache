import { afterEach, describe, expect, it } from "vitest";

import {
  createAirtableCacheService,
  getAirtableCacheService,
  resetAirtableCacheServiceForTests,
} from "@/lib/airtable-cache/service";
import { EXAMPLE_SITE_KEY } from "@/tests/fixtures/cache-example";
import {
  cleanupTempWorkspace,
  createTempWorkspace,
  createTestConfig,
  testLogger,
} from "@/tests/test-utils";

describe("airtable cache service factory", () => {
  const workspaces: string[] = [];
  const originalEnv = {
    AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
    CACHE_DATA_DIR: process.env.CACHE_DATA_DIR,
    CACHE_PUBLIC_DIR: process.env.CACHE_PUBLIC_DIR,
  };

  afterEach(() => {
    resetAirtableCacheServiceForTests();
    process.env.AIRTABLE_API_KEY = originalEnv.AIRTABLE_API_KEY;
    process.env.CACHE_DATA_DIR = originalEnv.CACHE_DATA_DIR;
    process.env.CACHE_PUBLIC_DIR = originalEnv.CACHE_PUBLIC_DIR;

    for (const rootDir of workspaces.splice(0)) {
      cleanupTempWorkspace({
        rootDir,
        publicDir: `${rootDir}/public`,
        dataDir: `${rootDir}/data/cache`,
      });
    }
  });

  it("creates independent service instances when asked explicitly", () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    const first = createAirtableCacheService({
      config: createTestConfig(workspace),
      logger: testLogger,
    });
    const second = createAirtableCacheService({
      config: createTestConfig(workspace),
      logger: testLogger,
    });

    expect(first).not.toBe(second);
  });

  it("memoizes the global service instance until it is reset", () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    process.env.AIRTABLE_API_KEY = "test-airtable-key";
    process.env.CACHE_DATA_DIR = workspace.dataDir;
    process.env.CACHE_PUBLIC_DIR = workspace.publicDir;

    const first = getAirtableCacheService();
    const second = getAirtableCacheService();

    expect(first).toBe(second);

    resetAirtableCacheServiceForTests();

    const third = getAirtableCacheService();
    expect(third).not.toBe(first);
  });

  it("waitForIdle resolves when the service has no queued work", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace.rootDir);

    const service = createAirtableCacheService({
      config: createTestConfig(workspace),
      logger: testLogger,
      fetchImpl: async () =>
        new Response(JSON.stringify({ records: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await service.waitForIdle(EXAMPLE_SITE_KEY);
  });
});
