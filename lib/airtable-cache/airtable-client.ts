import { HttpError } from "@/lib/airtable-cache/errors";
import {
  AirtableClientContract,
  AirtableConfig,
  FetchLike,
  isJsonObject,
  JsonObject,
  JsonValue,
  Logger,
  stripOffsetField,
} from "@/lib/airtable-cache/types";

// This file knows how to talk to Airtable itself.
// It fetches one page at a time, joins all pages into one merged JSON object,
// and raises typed errors when Airtable responds with something unsafe or broken.

// We cap the number of pages we will follow so a bad cursor from Airtable cannot
// keep this process busy forever.
const MAX_AIRTABLE_PAGES = 100;

// Fetch can stop in more than one way, and different runtimes label that stop
// differently. This helper treats the timeout-shaped cases as the same thing.
function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

// Airtable can return empty bodies, JSON bodies, or plain text error bodies.
// This helper reads the raw text first and then decides how much structure there is.
async function parseResponseBody(response: Response): Promise<unknown> {
  const rawBody = await response.text();
  if (!rawBody.trim()) {
    return {};
  }

  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return rawBody;
  }
}

// Airtable pagination returns one page at a time, but the cache layer wants one
// complete dataset. This helper joins all page payloads into one JSON object.
function mergePaginatedResponses(pages: JsonObject[]): JsonObject {
  // Every public cache entry represents the full Airtable dataset for a base query, so all
  // Airtable pages are merged into one response before the result reaches the cache layer.
  const firstPage = stripOffsetField(pages[0]);
  if (pages.length === 1) {
    return firstPage;
  }

  if (!Array.isArray(firstPage.records)) {
    throw new HttpError(
      502,
      "AIRTABLE_INVALID_PAGINATION",
      "Airtable pagination returned a response without a records array.",
    );
  }

  const mergedRecords = [...firstPage.records];
  for (const page of pages.slice(1)) {
    if (!Array.isArray(page.records)) {
      throw new HttpError(
        502,
        "AIRTABLE_INVALID_PAGINATION",
        "Airtable returned a paginated page without a records array.",
      );
    }

    mergedRecords.push(...page.records);
  }

  return {
    ...firstPage,
    records: mergedRecords,
  };
}

// This class is a small adapter around Airtable's HTTP API.
// It does not keep cache state itself; it only fetches, validates, and merges pages.
export class AirtableClient implements AirtableClientContract {
  // The constructor only stores the config, logger, and fetch implementation
  // so the rest of the class can use the same settings for every request.
  constructor(
    private readonly config: AirtableConfig,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  // Fetch the Airtable query, follow every pagination cursor, and return one
  // merged response body that represents the whole dataset.
  async fetchMergedResponse(
    airtableUrl: string,
  ): Promise<{ status: number; body: JsonObject; pageCount: number }> {
    const pageBodies: JsonObject[] = [];
    const seenOffsetTokens = new Set<string>();
    let nextOffsetToken: string | undefined;

    do {
      if (pageBodies.length >= MAX_AIRTABLE_PAGES) {
        throw new HttpError(
          502,
          "AIRTABLE_PAGINATION_LIMIT_EXCEEDED",
          "Airtable pagination exceeded the maximum supported page count.",
          {
            airtableUrl,
            maxPages: MAX_AIRTABLE_PAGES,
            pageCount: pageBodies.length,
          },
      );
      }

      // Each loop builds the next URL from the original Airtable URL and, if
      // needed, adds the cursor that Airtable gave us on the previous page.
      const airtablePageUrl = new URL(airtableUrl);
      if (nextOffsetToken) {
        airtablePageUrl.searchParams.set("offset", nextOffsetToken);
      }

      const pageBody = await this.fetchPage(airtablePageUrl.toString());
      pageBodies.push(pageBody);

      const nextOffsetTokenFromPage =
        typeof pageBody.offset === "string" && pageBody.offset.length > 0
          ? pageBody.offset
          : undefined;
      if (nextOffsetTokenFromPage) {
        // Airtable should advance the cursor on every page. Repeating an offset would loop
        // forever, so fail fast and keep the last good cache snapshot intact.
        if (seenOffsetTokens.has(nextOffsetTokenFromPage)) {
          throw new HttpError(
            502,
            "AIRTABLE_INVALID_PAGINATION",
            "Airtable pagination repeated an offset token.",
            {
              airtableUrl,
              repeatedOffset: nextOffsetTokenFromPage,
              pageCount: pageBodies.length,
            },
          );
        }

        seenOffsetTokens.add(nextOffsetTokenFromPage);
      }

      nextOffsetToken = nextOffsetTokenFromPage;
    } while (nextOffsetToken);

    const mergedBody = mergePaginatedResponses(pageBodies);
    this.logger.info("Fetched Airtable response.", {
      airtableUrl,
      pageCount: pageBodies.length,
      recordCount: Array.isArray(mergedBody.records) ? mergedBody.records.length : "n/a",
    });

    return {
      status: 200,
      body: mergedBody,
      pageCount: pageBodies.length,
    };
  }

  // Fetch one Airtable page, send the auth header, enforce the timeout, and
  // turn the response into a plain JSON object that the rest of the service can trust.
  private async fetchPage(airtableUrl: string): Promise<JsonObject> {
    let response: Response;

    try {
      response = await this.fetchImpl(airtableUrl, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(this.config.fetchTimeoutMs),
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new HttpError(
          504,
          "AIRTABLE_TIMEOUT",
          "Timed out while waiting for Airtable.",
          { airtableUrl, timeoutMs: this.config.fetchTimeoutMs },
        );
      }

      throw new HttpError(
        502,
        "AIRTABLE_NETWORK_ERROR",
        "Failed to reach Airtable.",
        {
          airtableUrl,
          cause: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }

    const parsedBody = await parseResponseBody(response);

    if (!response.ok) {
      const details: Record<string, JsonValue> = {
        airtableUrl,
        airtableStatus: response.status,
      };

      if (isJsonObject(parsedBody)) {
        details.airtableBody = parsedBody;
      } else if (typeof parsedBody === "string") {
        details.airtableText = parsedBody;
      }

      throw new HttpError(
        response.status,
        "AIRTABLE_REQUEST_FAILED",
        "Airtable returned an error response.",
        details,
      );
    }

    if (!isJsonObject(parsedBody)) {
      throw new HttpError(
        502,
        "AIRTABLE_INVALID_RESPONSE",
        "Airtable returned a non-object JSON payload.",
        { airtableUrl },
      );
    }

    return parsedBody;
  }
}
