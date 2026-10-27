import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { runInNewContext } from "node:vm";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildAirtableProxyRequest, siteKeyToFileToken } from "@/lib/airtable-cache/request";
import {
  EXAMPLE_FILTERED_LABS_BODY,
  EXAMPLE_FILTERED_LABS_URL,
} from "@/tests/fixtures/cache-example";
import {
  cleanupTempWorkspace,
  createTempWorkspace,
  readPreloadCache,
  type TestWorkspace,
} from "@/tests/test-utils";

const TEST_TIMEOUT_MS = 180_000;
const REGRESSION_SITE_KEY = "regression-static-preload.test";
const ENCODED_REQUEST = "/v0/appEncoded/Table%20Name%2F%E2%9C%93?fields%5B%5D=Title&fields%5B%5D=Name&view=Grid+view";

interface RunningBuiltApp {
  baseUrl: string;
  logs: () => string;
  stop: () => Promise<void>;
}

interface AirtableStub {
  baseUrl: string;
  stop: () => Promise<void>;
}

interface HeaderSnapshot {
  statusCode: number;
  headers: Map<string, string>;
}

function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 45_000,
  intervalMs = 100,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const checkCondition = async () => {
      try {
        if (await condition()) {
          resolve();
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error("Timed out waiting for the expected condition."));
          return;
        }

        setTimeout(checkCondition, intervalMs);
      } catch (error) {
        reject(error);
      }
    };

    void checkCondition();
  });
}

async function stopChildProcess(childProcess: ReturnType<typeof spawn>): Promise<void> {
  if (childProcess.exitCode !== null) {
    return;
  }

  childProcess.kill("SIGTERM");

  await new Promise<void>((resolve) => {
    childProcess.once("exit", () => resolve());
    setTimeout(() => {
      if (childProcess.exitCode === null) {
        childProcess.kill("SIGKILL");
      }
    }, 5_000);
  });
}

async function findOpenPort(): Promise<number> {
  const server = http.createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  server.close();

  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate an open TCP port.");
  }

  return address.port;
}

async function startBuiltNextApp(
  workspace: TestWorkspace,
  airtableBaseUrl: string,
): Promise<RunningBuiltApp> {
  const port = await findOpenPort();
  const childProcess = spawn(
    process.execPath,
    [path.join(process.cwd(), "scripts", "run-next-with-preloads.mjs"), "start"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AIRTABLE_API_BASE_URL: airtableBaseUrl,
        AIRTABLE_API_KEY: "regression-airtable-key",
        CACHE_DATA_DIR: workspace.dataDir,
        CACHE_PRELOAD_DIR: workspace.preloadDir,
        CI: "1",
        HOST: "127.0.0.1",
        NEXT_TELEMETRY_DISABLED: "1",
        NODE_ENV: "production",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let logs = "";
  const appendLogs = (chunk: Buffer | string) => {
    logs += chunk.toString();
  };

  childProcess.stdout.on("data", appendLogs);
  childProcess.stderr.on("data", appendLogs);

  const baseUrl = `http://127.0.0.1:${port}`;

  await waitForCondition(async () => {
    if (childProcess.exitCode !== null) {
      throw new Error(`The launched production service exited early.\n${logs}`);
    }

    try {
      const response = await fetch(`${baseUrl}/does-not-exist`);
      return response.status === 404;
    } catch {
      return false;
    }
  }, 60_000, 100);

  return {
    baseUrl,
    logs: () => logs,
    stop: async () => {
      await stopChildProcess(childProcess);
    },
  };
}

async function startAirtableStub(): Promise<AirtableStub> {
  const port = await findOpenPort();
  const requestPath = new URL(EXAMPLE_FILTERED_LABS_URL).pathname;

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);

    if (request.url !== ENCODED_REQUEST && requestUrl.pathname !== requestPath) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { code: "UNKNOWN_UPSTREAM_REQUEST", path: request.url } }));
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(EXAMPLE_FILTERED_LABS_BODY));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

function buildProxyPath(airtableUrl: string, siteKey: string): string {
  const parsed = new URL(airtableUrl);
  const proxyPath = parsed.pathname.replace(/^\/v0\/?/, "/");
  const searchParams = new URLSearchParams(parsed.searchParams);
  searchParams.set("ref", siteKey);
  const query = searchParams.toString();
  return `/v0${proxyPath}${query ? `?${query}` : ""}`;
}

async function requestHeadersWithCurl(url: string): Promise<HeaderSnapshot> {
  const childProcess = spawn("curl", ["-I", "-sS", url], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let standardOutput = "";
  let standardError = "";
  childProcess.stdout.on("data", (chunk: Buffer | string) => {
    standardOutput += chunk.toString();
  });
  childProcess.stderr.on("data", (chunk: Buffer | string) => {
    standardError += chunk.toString();
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    childProcess.once("error", reject);
    childProcess.once("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`curl failed for ${url}.\n${standardError}`);
  }

  const lines = standardOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const statusLine = lines[0] ?? "";
  const statusMatch = statusLine.match(/^HTTP\/\d+(?:\.\d+)?\s+(\d+)/i);
  if (!statusMatch) {
    throw new Error(`Could not parse the response status from curl output.\n${standardOutput}`);
  }

  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const headerName = line.slice(0, separatorIndex).trim().toLowerCase();
    const headerValue = line.slice(separatorIndex + 1).trim();
    headers.set(headerName, headerValue);
  }

  return {
    statusCode: Number(statusMatch[1]),
    headers,
  };
}

describe("live runtime preload regression", () => {
  let workspace: TestWorkspace;
  let app: RunningBuiltApp;
  let airtableStub: AirtableStub;
  let preloadPath: string;
  let obsoletePublicArtifactPath: string;
  let obsoletePublicPreloadPath: string;

  beforeAll(async () => {
    workspace = createTempWorkspace();
    airtableStub = await startAirtableStub();
    preloadPath = path.join(
      workspace.preloadDir,
      `cache-${siteKeyToFileToken(REGRESSION_SITE_KEY)}.js`,
    );
    obsoletePublicArtifactPath = path.join(process.cwd(), "public", "timestamps-legacy:3000.json");
    obsoletePublicPreloadPath = path.join(process.cwd(), "public", "cache-legacy:3000.js");

    fs.rmSync(preloadPath, { force: true });
    fs.mkdirSync(path.dirname(obsoletePublicArtifactPath), { recursive: true });
    fs.writeFileSync(obsoletePublicArtifactPath, "{}", "utf8");
    fs.writeFileSync(obsoletePublicPreloadPath, "export const cache = {};\nwindow.airtableCache = cache;\n", "utf8");

    if (!fs.existsSync(path.join(process.cwd(), ".next", "build-manifest.json"))) {
      throw new Error("The static preload regression requires a built app. Run `npm run build` first.");
    }

    app = await startBuiltNextApp(workspace, airtableStub.baseUrl);
    expect(fs.existsSync(obsoletePublicArtifactPath)).toBe(false);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await app?.stop();
    await airtableStub?.stop();
    if (preloadPath) {
      fs.rmSync(preloadPath, { force: true });
    }
    if (obsoletePublicArtifactPath) {
      fs.rmSync(obsoletePublicArtifactPath, { force: true });
    }
    if (obsoletePublicPreloadPath) fs.rmSync(obsoletePublicPreloadPath, { force: true });
    if (workspace) {
      cleanupTempWorkspace(workspace);
    }
  }, TEST_TIMEOUT_MS);

  it(
    "serves a preload created after boot without a restart",
    async () => {
      const cacheFileToken = siteKeyToFileToken(REGRESSION_SITE_KEY);
      const proxyPath = buildProxyPath(EXAMPLE_FILTERED_LABS_URL, REGRESSION_SITE_KEY);
      const expectedCacheKey = buildAirtableProxyRequest(
        new NextRequest(`${airtableStub.baseUrl}${proxyPath}`),
        airtableStub.baseUrl,
      ).cacheKey;

      const initialPreloadResponse = await fetch(`${app.baseUrl}/cache-${cacheFileToken}.js`);
      expect(initialPreloadResponse.status).toBe(404);
      expect(fs.existsSync(preloadPath)).toBe(false);

      const liveResponse = await fetch(`${app.baseUrl}${proxyPath}`);
      const liveBody = (await liveResponse.json()) as typeof EXAMPLE_FILTERED_LABS_BODY;

      expect(liveResponse.status).toBe(200);
      expect(liveResponse.headers.get("X-Airtable-Cache")).toBe("miss");
      expect(liveBody).toEqual(EXAMPLE_FILTERED_LABS_BODY);

      await waitForCondition(() => fs.existsSync(preloadPath), 10_000, 50);

      const preloadCache = readPreloadCache(preloadPath);
      expect(preloadCache[expectedCacheKey]).toEqual(EXAMPLE_FILTERED_LABS_BODY);
      expect(preloadCache[expectedCacheKey]).not.toHaveProperty("offset");

      const staticHeaders = await requestHeadersWithCurl(
        `${app.baseUrl}/cache-${cacheFileToken}.js`,
      );
      expect(staticHeaders.statusCode).toBe(200);
      expect(staticHeaders.headers.get("content-type")).toContain("application/javascript");
      expect(staticHeaders.headers.get("cache-control")).toContain("public");
      expect(staticHeaders.headers.get("content-length")).toBeTruthy();
      expect(staticHeaders.headers.get("last-modified")).toBeTruthy();
      expect(staticHeaders.headers.get("access-control-allow-origin")).toBe("*");
      expect(staticHeaders.headers.get("access-control-expose-headers")).toContain("Content-Length");
      expect(staticHeaders.headers.get("cross-origin-resource-policy")).toBe("cross-origin");

      const preloadResponse = await fetch(`${app.baseUrl}/cache-${cacheFileToken}.js`);
      const preloadText = await preloadResponse.text();

      expect(preloadResponse.status).toBe(200);
      expect(preloadText).toContain("window.airtableCache = cache;");
      const etag = preloadResponse.headers.get("etag");
      expect(etag).toBeTruthy();
      expect((await fetch(`${app.baseUrl}/cache-${cacheFileToken}.js`, {
        headers: { "If-None-Match": etag! },
      })).status).toBe(304);
    },
    TEST_TIMEOUT_MS,
  );

  it("preserves encoded table paths and exact subscriber keys through HTTP and executable preloads", async () => {
    const response = await fetch(`${app.baseUrl}${ENCODED_REQUEST}&ref=encoded.test`, {
      headers: { Origin: "https://subscriber.test" },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual(EXAMPLE_FILTERED_LABS_BODY);
    const options = await fetch(`${app.baseUrl}${ENCODED_REQUEST}&ref=encoded.test`, {
      method: "OPTIONS",
      headers: { Origin: "https://subscriber.test", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "Content-Type" },
    });
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-headers")).toBe("Content-Type");
    const preload = await fetch(`${app.baseUrl}/cache-encoded.test.js`);
    expect(preload.status).toBe(200);
    const browser: { airtableCache?: Record<string, unknown> } = {};
    // Execute the published code in a browser-like global, removing only the ESM export keyword.
    runInNewContext((await preload.text()).replace(/^export /, ""), { window: browser });
    expect(browser.airtableCache?.[`${airtableStub.baseUrl}${ENCODED_REQUEST}`]).toEqual(EXAMPLE_FILTERED_LABS_BODY);
  }, TEST_TIMEOUT_MS);
});
