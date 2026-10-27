import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { GET, HEAD, OPTIONS } from "@/app/[preloadFile]/route";
import { siteKeyToFileToken } from "@/lib/airtable-cache/request";
import { cleanupTempWorkspace, createTempWorkspace, writeSnapshot, type TestWorkspace } from "@/tests/test-utils";

const siteKey = "route-preload.test";
let workspace: TestWorkspace | undefined;
let previousEnv: NodeJS.ProcessEnv;

function context(preloadFile: string) {
  return { params: Promise.resolve({ preloadFile }) };
}

function prepareSnapshot(): string {
  workspace = createTempWorkspace();
  previousEnv = { ...process.env };
  process.env.AIRTABLE_API_KEY = "test-key";
  process.env.CACHE_DATA_DIR = workspace.dataDir;
  process.env.CACHE_PRELOAD_DIR = workspace.preloadDir;
  const token = siteKeyToFileToken(siteKey);
  writeSnapshot(workspace, siteKey, {
    version: 1,
    siteKey,
    savedAt: 1,
    entries: {
      "https://api.airtable.com/v0/app123/Table": {
        body: { records: [] },
        updatedAt: Date.now(),
        lastAccessedAt: Date.now(),
      },
    },
  });
  return `cache-${token}.js`;
}

afterEach(() => {
  if (previousEnv) {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
  if (workspace) cleanupTempWorkspace(workspace);
  workspace = undefined;
});

describe("preload runtime route", () => {
  it("does not return 304 for changed content with the same size and file time", async () => {
    const preloadFile = prepareSnapshot();
    const url = `http://test/${preloadFile}`;
    const first = await GET(new NextRequest(url), context(preloadFile));
    await first.text();
    const artifactPath = path.join(workspace!.preloadDir, preloadFile);
    const snapshotPath = path.join(workspace!.dataDir, `${siteKeyToFileToken(siteKey)}.json`);
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    snapshot.entries["https://api.airtable.com/v0/app123/Table"].body = { records: [1] };
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
    const second = await GET(new NextRequest(url), context(preloadFile));
    await second.text();
    // Preserve the last representation's exact timestamp, but change the canonical data again.
    const fixedTime = new Date(Math.floor(Date.now() / 1000) * 1000);
    fs.utimesSync(artifactPath, fixedTime, fixedTime);
    const before = await GET(new NextRequest(url), context(preloadFile));
    await before.text();
    snapshot.entries["https://api.airtable.com/v0/app123/Table"].body = { records: [3] };
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
    const rebuilt = await GET(new NextRequest(url), context(preloadFile));
    await rebuilt.text();
    fs.utimesSync(artifactPath, fixedTime, fixedTime);
    const conditional = await GET(new NextRequest(url, { headers: { "If-None-Match": before.headers.get("etag")! } }), context(preloadFile));
    expect(conditional.status).toBe(200);
    expect(await conditional.text()).toContain("[3]");
    const dated = await GET(new NextRequest(url, { headers: { "If-Modified-Since": fixedTime.toUTCString() } }), context(preloadFile));
    expect(dated.status).toBe(200);
    await dated.text();
  });

  it("reconciles and streams a preload with validators and CORS", async () => {
    const preloadFile = prepareSnapshot();
    const response = await GET(new NextRequest(`http://test/${preloadFile}`), context(preloadFile));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("window.airtableCache = cache;");
    expect(response.headers.get("content-type")).toContain("application/javascript");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(response.headers.get("etag")).toMatch(/^"[a-f0-9]{64}"$/);
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
    expect(fs.existsSync(path.join(workspace!.preloadDir, preloadFile))).toBe(true);

    const head = await HEAD(new NextRequest(`http://test/${preloadFile}`), context(preloadFile));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const conditional = await GET(new NextRequest(`http://test/${preloadFile}`, {
      headers: { "If-None-Match": response.headers.get("etag")! },
    }), context(preloadFile));
    expect(conditional.status).toBe(304);
  });

  it("returns no-store 404 for invalid tokens and supports OPTIONS only for canonical names", async () => {
    prepareSnapshot();
    const invalid = await GET(new NextRequest("http://test/cache-UPPER.js"), context("cache-UPPER.js"));
    expect(invalid.status).toBe(404);
    expect(invalid.headers.get("cache-control")).toBe("no-store");
    expect(invalid.headers.get("access-control-allow-origin")).toBe("*");
    expect((await OPTIONS(new NextRequest("http://test/cache-UPPER.js"), context("cache-UPPER.js"))).status).toBe(404);
    const preloadFile = `cache-${siteKeyToFileToken(siteKey)}.js`;
    expect((await OPTIONS(new NextRequest(`http://test/${preloadFile}`), context(preloadFile))).status).toBe(204);
  });
});
