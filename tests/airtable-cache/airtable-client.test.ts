import { afterEach, describe, expect, it, vi } from "vitest";

import { AirtableClient } from "@/lib/airtable-cache/airtable-client";
import {
  EXAMPLE_FILTERED_LABS_BODY,
  EXAMPLE_PAGINATED_PAGE_ONE,
  EXAMPLE_PAGINATED_PAGE_TWO,
  EXAMPLE_PUBLISHED_DATES_URL,
  EXAMPLE_TOPICS_BODY,
  EXAMPLE_TOPICS_URL,
} from "@/tests/fixtures/cache-example";
import { createJsonResponse, createTestConfig, createTempWorkspace, cleanupTempWorkspace, testLogger } from "@/tests/test-utils";

describe("airtable client", () => {
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

  it("returns a single-page Airtable response unchanged except for offset removal", async () => {
    const workspace = createTempWorkspace();
    workspaceRoots.push(workspace.rootDir);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(createJsonResponse(EXAMPLE_TOPICS_BODY));
    const client = new AirtableClient(createTestConfig(workspace), testLogger, fetchMock);

    const response = await client.fetchMergedResponse(EXAMPLE_TOPICS_URL);

    expect(response).toEqual({
      status: 200,
      body: EXAMPLE_TOPICS_BODY,
      pageCount: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      EXAMPLE_TOPICS_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-airtable-key",
        }),
      }),
    );
  });

  it("fetches and merges every paginated Airtable page", async () => {
    const workspace = createTempWorkspace();
    workspaceRoots.push(workspace.rootDir);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createJsonResponse(EXAMPLE_PAGINATED_PAGE_ONE))
      .mockResolvedValueOnce(createJsonResponse(EXAMPLE_PAGINATED_PAGE_TWO));
    const client = new AirtableClient(createTestConfig(workspace), testLogger, fetchMock);

    const response = await client.fetchMergedResponse(EXAMPLE_PUBLISHED_DATES_URL);

    expect(response.pageCount).toBe(2);
    expect(response.body.records).toEqual([
      ...(EXAMPLE_PAGINATED_PAGE_ONE.records as unknown[]),
      ...(EXAMPLE_PAGINATED_PAGE_TWO.records as unknown[]),
    ]);
    expect(response.body).not.toHaveProperty("offset");
  });

  it("accepts empty Airtable response bodies as empty objects", async () => {
    const workspace = createTempWorkspace();
    workspaceRoots.push(workspace.rootDir);

    const client = new AirtableClient(
      createTestConfig(workspace),
      testLogger,
      vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 200 })),
    );

    await expect(client.fetchMergedResponse(EXAMPLE_TOPICS_URL)).resolves.toEqual({
      status: 200,
      body: {},
      pageCount: 1,
    });
  });

  it("rejects paginated responses without records arrays", async () => {
    const workspace = createTempWorkspace();
    workspaceRoots.push(workspace.rootDir);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createJsonResponse(EXAMPLE_PAGINATED_PAGE_ONE))
      .mockResolvedValueOnce(
        createJsonResponse({
          ...EXAMPLE_PAGINATED_PAGE_TWO,
          records: "not-an-array" as never,
        }),
      );
    const client = new AirtableClient(createTestConfig(workspace), testLogger, fetchMock);

    await expect(client.fetchMergedResponse(EXAMPLE_PUBLISHED_DATES_URL)).rejects.toMatchObject({
      status: 502,
      code: "AIRTABLE_INVALID_PAGINATION",
    });
  });

  it("rejects paginated responses when the first page does not contain records", async () => {
    const workspace = createTempWorkspace();
    workspaceRoots.push(workspace.rootDir);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          offset: "itrNextPage",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          records: [],
        }),
      );
    const client = new AirtableClient(createTestConfig(workspace), testLogger, fetchMock);

    await expect(client.fetchMergedResponse(EXAMPLE_PUBLISHED_DATES_URL)).rejects.toMatchObject({
      status: 502,
      code: "AIRTABLE_INVALID_PAGINATION",
    });
  });

  it("rejects repeated Airtable pagination offsets to avoid infinite loops", async () => {
    const workspace = createTempWorkspace();
    workspaceRoots.push(workspace.rootDir);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          records: [{ id: "rec001" }],
          offset: "itrLoop",
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          records: [{ id: "rec002" }],
          offset: "itrLoop",
        }),
      );
    const client = new AirtableClient(createTestConfig(workspace), testLogger, fetchMock);

    await expect(client.fetchMergedResponse(EXAMPLE_PUBLISHED_DATES_URL)).rejects.toMatchObject({
      status: 502,
      code: "AIRTABLE_INVALID_PAGINATION",
      details: {
        repeatedOffset: "itrLoop",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects Airtable pagination that exceeds the maximum page count", async () => {
    const workspace = createTempWorkspace();
    workspaceRoots.push(workspace.rootDir);

    let pageNumber = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      pageNumber += 1;

      return createJsonResponse({
        records: [{ id: `rec${pageNumber}` }],
        ...(pageNumber < 100 ? { offset: `itrPage${pageNumber}` } : { offset: "itrPage100" }),
      });
    });
    const client = new AirtableClient(createTestConfig(workspace), testLogger, fetchMock);

    await expect(client.fetchMergedResponse(EXAMPLE_PUBLISHED_DATES_URL)).rejects.toMatchObject({
      status: 502,
      code: "AIRTABLE_PAGINATION_LIMIT_EXCEEDED",
      details: {
        maxPages: 100,
        pageCount: 100,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(100);
  });

  it("surfaces Airtable JSON and text errors with structured details", async () => {
    const workspace = createTempWorkspace();
    workspaceRoots.push(workspace.rootDir);

    const jsonErrorClient = new AirtableClient(
      createTestConfig(workspace),
      testLogger,
      vi.fn<typeof fetch>().mockResolvedValue(
        createJsonResponse(
          {
            error: {
              type: "NOT_FOUND",
            },
          },
          { status: 404 },
        ),
      ),
    );
    const textErrorClient = new AirtableClient(
      createTestConfig(workspace),
      testLogger,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response("upstream exploded", { status: 502 }),
      ),
    );

    await expect(jsonErrorClient.fetchMergedResponse(EXAMPLE_TOPICS_URL)).rejects.toMatchObject({
      status: 404,
      code: "AIRTABLE_REQUEST_FAILED",
      details: {
        airtableBody: {
          error: {
            type: "NOT_FOUND",
          },
        },
      },
    });
    await expect(textErrorClient.fetchMergedResponse(EXAMPLE_TOPICS_URL)).rejects.toMatchObject({
      status: 502,
      code: "AIRTABLE_REQUEST_FAILED",
      details: {
        airtableText: "upstream exploded",
      },
    });
  });

  it("rejects non-object success payloads and network failures", async () => {
    const workspace = createTempWorkspace();
    workspaceRoots.push(workspace.rootDir);

    const invalidPayloadClient = new AirtableClient(
      createTestConfig(workspace),
      testLogger,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify([EXAMPLE_FILTERED_LABS_BODY]), { status: 200 }),
      ),
    );
    const networkFailureClient = new AirtableClient(
      createTestConfig(workspace),
      testLogger,
      vi.fn<typeof fetch>().mockRejectedValue(new Error("connect ECONNREFUSED")),
    );
    const timeoutClient = new AirtableClient(
      createTestConfig(workspace),
      testLogger,
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError")),
    );
    const abortClient = new AirtableClient(
      createTestConfig(workspace),
      testLogger,
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new DOMException("The operation was aborted.", "AbortError")),
    );
    const unknownFailureClient = new AirtableClient(
      createTestConfig(workspace),
      testLogger,
      vi.fn<typeof fetch>().mockRejectedValue("socket hung up"),
    );

    await expect(invalidPayloadClient.fetchMergedResponse(EXAMPLE_TOPICS_URL)).rejects.toMatchObject(
      {
        status: 502,
        code: "AIRTABLE_INVALID_RESPONSE",
      },
    );
    await expect(networkFailureClient.fetchMergedResponse(EXAMPLE_TOPICS_URL)).rejects.toMatchObject(
      {
        status: 502,
        code: "AIRTABLE_NETWORK_ERROR",
      },
    );
    await expect(timeoutClient.fetchMergedResponse(EXAMPLE_TOPICS_URL)).rejects.toMatchObject({
      status: 504,
      code: "AIRTABLE_TIMEOUT",
    });
    await expect(abortClient.fetchMergedResponse(EXAMPLE_TOPICS_URL)).rejects.toMatchObject({
      status: 504,
      code: "AIRTABLE_TIMEOUT",
    });
    await expect(unknownFailureClient.fetchMergedResponse(EXAMPLE_TOPICS_URL)).rejects.toMatchObject(
      {
        status: 502,
        code: "AIRTABLE_NETWORK_ERROR",
        details: {
          cause: "Unknown error",
        },
      },
    );
  });
});
