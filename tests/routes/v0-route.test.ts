import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/v0/[[...path]]/route";
import { HttpError } from "@/lib/airtable-cache/errors";
import { createAirtableCacheService } from "@/lib/airtable-cache/service";
import * as airtableServiceModule from "@/lib/airtable-cache/service";
import {
  EXAMPLE_PUBLISHED_DATES_BODY,
  EXAMPLE_SITE_KEY,
} from "@/tests/fixtures/cache-example";
import {
  cleanupTempWorkspace,
  createJsonResponse,
  createTempWorkspace,
  createTestConfig,
  testLogger,
} from "@/tests/test-utils";

describe("/v0 route", () => {
  const workspaceRoots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const rootDir of workspaceRoots.splice(0)) {
      cleanupTempWorkspace({
        rootDir,
        publicDir: `${rootDir}/public`,
        dataDir: `${rootDir}/data/cache`,
      });
    }
  });

  it("returns the proxied Airtable payload on success", async () => {
    const workspace = createTempWorkspace();
    workspaceRoots.push(workspace.rootDir);

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse(EXAMPLE_PUBLISHED_DATES_BODY),
    );
    const service = createAirtableCacheService({
      config: createTestConfig(workspace),
      fetchImpl: fetchMock,
      logger: testLogger,
      now: () => 1_700_000_000_000,
    });

    vi.spyOn(airtableServiceModule, "getAirtableCacheService").mockReturnValue(service);

    const response = await GET(
      new NextRequest(
        `http://localhost:4444/v0/appHcZTzlfXAJpL7I/tblVtIK7hg8LOJfZd?ref=${EXAMPLE_SITE_KEY}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Airtable-Cache")).toBe("miss");
    await expect(response.json()).resolves.toEqual(EXAMPLE_PUBLISHED_DATES_BODY);
  });

  it("returns a structured 400 response for an invalid ref", async () => {
    const response = await GET(
      new NextRequest("http://localhost:4444/v0/app123/tbl456?ref=https://bad.example"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_REF",
        message: "The site ref must be a slug or hostname token, not a full URL.",
        details: {
          providedRef: "https://bad.example",
        },
      },
    });
  });

  it("serializes HttpError and unexpected service errors", async () => {
    vi.spyOn(airtableServiceModule, "getAirtableCacheService").mockReturnValue({
      handle: vi
        .fn()
        .mockRejectedValueOnce(
          new HttpError(504, "AIRTABLE_TIMEOUT", "Timed out while waiting for Airtable."),
        )
        .mockRejectedValueOnce(new Error("boom")),
      waitForIdle: vi.fn(),
    } as unknown as ReturnType<typeof airtableServiceModule.getAirtableCacheService>);

    const timeoutResponse = await GET(
      new NextRequest(
        `http://localhost:4444/v0/appHcZTzlfXAJpL7I/tblVtIK7hg8LOJfZd?ref=${EXAMPLE_SITE_KEY}`,
      ),
    );
    const genericResponse = await GET(
      new NextRequest(
        `http://localhost:4444/v0/appHcZTzlfXAJpL7I/tblVtIK7hg8LOJfZd?ref=${EXAMPLE_SITE_KEY}`,
      ),
    );

    expect(timeoutResponse.status).toBe(504);
    await expect(timeoutResponse.json()).resolves.toEqual({
      error: {
        code: "AIRTABLE_TIMEOUT",
        message: "Timed out while waiting for Airtable.",
      },
    });
    expect(genericResponse.status).toBe(500);
    await expect(genericResponse.json()).resolves.toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to proxy the Airtable request.",
        details: {
          cause: "boom",
        },
      },
    });
  });
});
