import { describe, expect, it } from "vitest";

import {
  assertJsonObject,
  HttpError,
  toErrorResponse,
} from "@/lib/airtable-cache/errors";
import { EXAMPLE_TOPICS_BODY } from "@/tests/fixtures/cache-example";

describe("airtable cache errors", () => {
  it("serializes HttpError details when present", () => {
    const error = new HttpError(422, "BAD_DATA", "Payload was invalid.", {
      cacheKey: "example",
    });

    expect(error.toBody()).toEqual({
      error: {
        code: "BAD_DATA",
        message: "Payload was invalid.",
        details: {
          cacheKey: "example",
        },
      },
    });
  });

  it("omits empty details from the HttpError payload", () => {
    const error = new HttpError(404, "NOT_FOUND", "Missing");

    expect(error.toBody()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Missing",
      },
    });
  });

  it("normalizes HttpError, Error, and unknown values into response bodies", () => {
    const httpResponse = toErrorResponse(
      new HttpError(400, "INVALID_REF", "Bad ref.", { providedRef: "bad" }),
    );
    const errorResponse = toErrorResponse(new Error("boom"), "Fallback message.");
    const unknownResponse = toErrorResponse("boom");

    expect(httpResponse).toEqual({
      status: 400,
      body: {
        error: {
          code: "INVALID_REF",
          message: "Bad ref.",
          details: {
            providedRef: "bad",
          },
        },
      },
    });
    expect(errorResponse).toEqual({
      status: 500,
      body: {
        error: {
          code: "INTERNAL_ERROR",
          message: "Fallback message.",
          details: {
            cause: "boom",
          },
        },
      },
    });
    expect(unknownResponse).toEqual({
      status: 500,
      body: {
        error: {
          code: "INTERNAL_ERROR",
          message: "Unexpected server error.",
        },
      },
    });
  });

  it("asserts that payloads are JSON objects", () => {
    expect(() =>
      assertJsonObject(["bad"], 500, "INVALID", "Must be object."),
    ).toThrow(HttpError);

    expect(() =>
      assertJsonObject(EXAMPLE_TOPICS_BODY, 500, "INVALID", "Must be object."),
    ).not.toThrow();
  });
});
