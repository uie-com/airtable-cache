import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";

import { NextRequest, NextResponse } from "next/server";

import { createCacheConfig } from "@/lib/airtable-cache/config";
import { toErrorResponse } from "@/lib/airtable-cache/errors";
import {
  preloadTokenFromFileName,
  openPreloadArtifact,
} from "@/lib/airtable-cache/persistence";

export const runtime = "nodejs";

const CACHE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Expose-Headers": "ETag, Last-Modified, Content-Length",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Cache-Control": "public, max-age=0, must-revalidate",
};

function notFoundResponse(): NextResponse {
  return new NextResponse(null, { status: 404, headers: { ...CACHE_HEADERS, "Cache-Control": "no-store" } });
}

function isNotModified(request: NextRequest, etag: string): boolean {
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch) {
    return ifNoneMatch.split(",").map((value) => value.trim().replace(/^W\//, "")).includes(etag) || ifNoneMatch.trim() === "*";
  }
  // Second-granularity dates cannot safely validate rapidly updated content.
  return false;
}

function artifactHeaders(size: number, mtimeMs: number, etag: string): Headers {
  return new Headers({
    ...CACHE_HEADERS,
    "Content-Type": "application/javascript; charset=utf-8",
    "Content-Length": String(size),
    "Last-Modified": new Date(mtimeMs).toUTCString(),
    ETag: etag,
  });
}

async function openPreload(request: NextRequest, preloadFile: string, includeBody: boolean): Promise<Response> {
  const token = preloadTokenFromFileName(preloadFile);
  if (!token) return notFoundResponse();

  try {
    const artifact = await openPreloadArtifact(createCacheConfig(), token);
    if (!artifact) return notFoundResponse();

    let handle: FileHandle | undefined = artifact.handle;
    try {
      const { stat, etag } = artifact;
      const headers = artifactHeaders(stat.size, stat.mtimeMs, etag);
      const notModified = isNotModified(request, etag);
      if (!includeBody || notModified) {
        await handle.close();
        handle = undefined;
        return new NextResponse(null, { status: notModified ? 304 : 200, headers });
      }

      const stream = handle.createReadStream();
      handle = undefined;
      return new NextResponse(Readable.toWeb(stream) as ReadableStream, { status: 200, headers });
    } finally {
      await handle?.close();
    }
  } catch (error) {
    const response = toErrorResponse(error, "Failed to serve the preload artifact.");
    return NextResponse.json(response.body, {
      status: response.status,
      headers: { ...CACHE_HEADERS, "Cache-Control": "no-store" },
    });
  }
}

export async function OPTIONS(
  _request: NextRequest,
  context: { params: Promise<{ preloadFile: string }> },
): Promise<NextResponse> {
  const preloadFile = (await context.params).preloadFile;
  return preloadTokenFromFileName(preloadFile)
    ? new NextResponse(null, { status: 204, headers: CACHE_HEADERS })
    : notFoundResponse();
}

export async function GET(request: NextRequest, context: { params: Promise<{ preloadFile: string }> }) {
  return openPreload(request, (await context.params).preloadFile, true);
}

export async function HEAD(request: NextRequest, context: { params: Promise<{ preloadFile: string }> }) {
  return openPreload(request, (await context.params).preloadFile, false);
}
