// This route is the cold-start safety net for browser preload files.
// When `/cache-<site>.js` is missing on disk, Next.js rewrites the request here so the service can
// rebuild the generated preload from the private JSON snapshot and still satisfy the first page load.
import { promises as fileSystem } from "fs";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { toErrorResponse, HttpError } from "@/lib/airtable-cache/errors";
import { createAirtableConfig } from "@/lib/airtable-cache/config";
import { createLogger } from "@/lib/airtable-cache/logging";
import { FileSystemCachePersistence } from "@/lib/airtable-cache/persistence";
import { normalizeSiteKey, siteKeyToFileToken } from "@/lib/airtable-cache/request";

export const runtime = "nodejs";

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

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

async function resolvePreloadFileContents(siteToken: string): Promise<string | null> {
  const config = createAirtableConfig();
  const logger = createLogger("airtable-preload-route");
  const persistence = new FileSystemCachePersistence(config, logger);
  const preloadPath = path.join(config.publicCacheDir, `cache-${siteToken}.js`);
  const existingPreloadContents = await readFileIfExists(preloadPath);

  if (existingPreloadContents !== null) {
    return existingPreloadContents;
  }

  const snapshotPath = path.join(config.cacheDataDir, `${siteToken}.json`);
  const snapshotContents = await readFileIfExists(snapshotPath);
  if (snapshotContents === null) {
    return null;
  }

  let parsedSnapshot: unknown;
  try {
    parsedSnapshot = JSON.parse(snapshotContents);
  } catch {
    throw new HttpError(
      500,
      "CACHE_PARSE_FAILED",
      "Failed to parse the persisted cache snapshot.",
      {
        snapshotPath,
      },
    );
  }

  if (
    typeof parsedSnapshot !== "object" ||
    parsedSnapshot === null ||
    !("siteKey" in parsedSnapshot) ||
    typeof parsedSnapshot.siteKey !== "string"
  ) {
    throw new HttpError(
      500,
      "CACHE_PARSE_FAILED",
      "Persisted cache snapshots must include a siteKey.",
      {
        snapshotPath,
      },
    );
  }

  const siteKey = normalizeSiteKey(parsedSnapshot.siteKey);
  if (siteKeyToFileToken(siteKey) !== siteToken) {
    throw new HttpError(
      500,
      "CACHE_PARSE_FAILED",
      "The snapshot siteKey does not match the requested preload token.",
      {
        requestedToken: siteToken,
        snapshotSiteKey: siteKey,
      },
    );
  }

  await persistence.loadSiteSnapshot(siteKey);

  return readFileIfExists(preloadPath);
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ siteToken: string }> },
) {
  try {
    const { siteToken } = await context.params;
    const preloadContents = await resolvePreloadFileContents(siteToken);

    if (preloadContents === null) {
      return new NextResponse("Not Found", {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    return new NextResponse(preloadContents, {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  } catch (error) {
    const response = toErrorResponse(error, "Failed to load the Airtable preload cache file.");
    return NextResponse.json(response.body, { status: response.status });
  }
}
