import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { siteKeyToFileToken } from "@/lib/airtable-cache/request";
import { AirtableConfig, JsonObject, Logger, SiteSnapshot } from "@/lib/airtable-cache/types";

export interface TestWorkspace {
  rootDir: string;
  publicDir: string;
  dataDir: string;
}

export const testLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};

export function createTempWorkspace(): TestWorkspace {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "airtable-cache-"));
  const publicDir = path.join(rootDir, "public");
  const dataDir = path.join(rootDir, "data", "cache");

  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  return {
    rootDir,
    publicDir,
    dataDir,
  };
}

export function cleanupTempWorkspace(workspace: TestWorkspace): void {
  fs.rmSync(workspace.rootDir, { recursive: true, force: true });
}

export function createTestConfig(
  workspace: TestWorkspace,
  overrides: Partial<AirtableConfig> = {},
): AirtableConfig {
  return {
    apiKey: "test-airtable-key",
    cacheDataDir: workspace.dataDir,
    publicCacheDir: workspace.publicDir,
    staleAfterMs: 15 * 60 * 1000,
    evictAfterMs: 72 * 60 * 60 * 1000,
    fetchTimeoutMs: 5_000,
    ...overrides,
  };
}

export function createJsonResponse(body: JsonObject, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export function readPreloadCache(filePath: string): Record<string, JsonObject> {
  const fileContents = fs.readFileSync(filePath, "utf8");
  const match = fileContents.match(
    /export const cache =\s*(\{[\s\S]*\})\s*;\s*window\.airtableCache = cache;?\s*$/,
  );

  if (!match) {
    throw new Error(`Invalid preload format in ${filePath}`);
  }

  return JSON.parse(match[1]) as Record<string, JsonObject>;
}

export function writeSnapshot(
  workspace: TestWorkspace,
  siteKey: string,
  snapshot: SiteSnapshot,
): string {
  const snapshotPath = path.join(workspace.dataDir, `${siteKeyToFileToken(siteKey)}.json`);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return snapshotPath;
}
