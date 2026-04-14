// This file holds the small set of error helpers used by the route handlers and cache code.
// The goal is to turn different failure shapes into one predictable JSON response format.

import { isJsonObject, JsonObject, JsonValue } from "@/lib/airtable-cache/types";

// HttpError is the one error type the service uses when it already knows how to answer the client.
// It carries the HTTP status code, a stable machine-readable code, a human-readable message, and optional details.
export class HttpError extends Error {
  // The constructor stores everything needed to send a structured response back to the client.
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, JsonValue>,
  ) {
    super(message);
    this.name = "HttpError";
  }

  // Convert this error into the JSON object shape that the API returns to callers.
  toBody(): JsonObject {
    const errorBody: JsonObject = {
      code: this.code,
      message: this.message,
    };

    if (this.details && Object.keys(this.details).length > 0) {
      errorBody.details = this.details;
    }

    return { error: errorBody };
  }
}

// Turn any thrown value into the response shape expected by the route handlers.
// Known HttpError values keep their own status and message, while everything else becomes a generic 500 error.
export function toErrorResponse(
  error: unknown,
  fallbackMessage = "Unexpected server error.",
): { status: number; body: JsonObject } {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: error.toBody(),
    };
  }

  if (error instanceof Error) {
    return {
      status: 500,
      body: {
        error: {
          code: "INTERNAL_ERROR",
          message: fallbackMessage,
          details: { cause: error.message },
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: fallbackMessage,
      },
    },
  };
}

// Verify that an unknown value is a plain JSON object before code treats it like structured data.
// If the value is not a JSON object, throw a typed HttpError with the caller-provided status and message.
export function assertJsonObject(
  value: unknown,
  status: number,
  code: string,
  message: string,
  details?: Record<string, JsonValue>,
): asserts value is JsonObject {
  if (!isJsonObject(value)) {
    throw new HttpError(status, code, message, details);
  }
}
