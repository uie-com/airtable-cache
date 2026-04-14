import { NextRequest } from "next/server";

import { HttpError } from "@/lib/airtable-cache/errors";
import { createLogger } from "@/lib/airtable-cache/logging";
import { FetchLike, isJsonObject, JsonObject, JsonValue, ProxyResponse } from "@/lib/airtable-cache/types";

// This file owns the Zapier proxy behavior.
// It checks who is calling, checks where the request is allowed to go, forwards the JSON body, and turns the upstream result into the shape the route expects.

// This is the small bundle of settings the Zapier proxy needs in order to work.
interface ZapierProxyConfig {
  sharedSecret: string;
  allowedHosts: Set<string>;
  fetchTimeoutMs: number;
}

// This turns a comma-separated list of hostnames into a lookup set.
// A set is easier to check later because we only need to ask whether a host is present.
function parseAllowedHosts(rawValue: string | undefined): Set<string> {
  return new Set(
    (rawValue ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

// This reads the environment and builds the settings object for the Zapier proxy.
// It throws a clear error right away if the service does not have the secrets it needs.
function resolveZapierConfig(env: NodeJS.ProcessEnv = process.env): ZapierProxyConfig {
  const sharedSecret = env.ZAPIER_SHARED_SECRET?.trim();
  if (!sharedSecret) {
    throw new HttpError(
      500,
      "MISSING_ZAPIER_SECRET",
      "ZAPIER_SHARED_SECRET is required to use the Zapier proxy.",
    );
  }

  const allowedHosts = parseAllowedHosts(env.ZAPIER_ALLOWED_HOSTS);
  if (allowedHosts.size === 0) {
    throw new HttpError(
      500,
      "MISSING_ZAPIER_ALLOWLIST",
      "ZAPIER_ALLOWED_HOSTS must contain at least one hostname.",
    );
  }

  const timeoutValue = Number(env.AIRTABLE_FETCH_TIMEOUT_MS ?? 15_000);
  const fetchTimeoutMs =
    Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : 15_000;

  return {
    sharedSecret,
    allowedHosts,
    fetchTimeoutMs,
  };
}

// This reads an upstream response body in a safe order.
// It first gets the raw text, then decides whether the body is empty, JSON, or plain text.
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

// This looks for the shared secret on the request.
// The service accepts either a custom header or a Bearer token so callers have two simple ways to send the same secret.
function extractSharedSecret(request: NextRequest): string | null {
  const headerSecret = request.headers.get("x-zapier-secret");
  if (headerSecret) {
    return headerSecret;
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length).trim();
}

// This takes the endpoint query value and turns it into a real URL object.
// It also checks that the protocol is safe and that the host is on the allowlist.
function validateEndpoint(endpointValue: string, allowedHosts: Set<string>): URL {
  let endpointUrl: URL;

  try {
    endpointUrl = new URL(endpointValue);
  } catch {
    throw new HttpError(
      400,
      "INVALID_ENDPOINT",
      "The endpoint query parameter must be a valid URL.",
    );
  }

  if (!["http:", "https:"].includes(endpointUrl.protocol)) {
    throw new HttpError(
      400,
      "INVALID_ENDPOINT",
      "The endpoint must use http or https.",
      { protocol: endpointUrl.protocol },
    );
  }

  if (!allowedHosts.has(endpointUrl.host.toLowerCase())) {
    throw new HttpError(
      403,
      "DISALLOWED_ENDPOINT",
      "The endpoint host is not in the Zapier allowlist.",
      { endpointHost: endpointUrl.host.toLowerCase() },
    );
  }

  return endpointUrl;
}

// This class contains the full Zapier proxy workflow.
// Keeping the logic here makes the route file tiny and keeps the request flow in one place.
export class ZapierProxyService {
  // The constructor saves the settings and the fetch function the service should use when it forwards requests.
  constructor(
    private readonly config: ZapierProxyConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  // This handles one incoming request from start to finish.
  // It checks the secret, checks the destination, forwards the body, and returns the upstream response in the service's format.
  async handle(request: NextRequest): Promise<ProxyResponse> {
    const sharedSecret = extractSharedSecret(request);
    if (sharedSecret !== this.config.sharedSecret) {
      throw new HttpError(
        401,
        "UNAUTHORIZED",
        "A valid shared secret is required to use the Zapier proxy.",
      );
    }

    const endpointValue = request.nextUrl.searchParams.get("endpoint");
    if (!endpointValue) {
      throw new HttpError(
        400,
        "MISSING_ENDPOINT",
        "The endpoint query parameter is required.",
      );
    }

    const endpointUrl = validateEndpoint(endpointValue, this.config.allowedHosts);

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      throw new HttpError(
        400,
        "INVALID_JSON",
        "The Zapier proxy expects a JSON request body.",
      );
    }

    let response: Response;
    try {
      response = await this.fetchImpl(endpointUrl.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.fetchTimeoutMs),
      });
    } catch (error) {
      throw new HttpError(
        502,
        "ZAPIER_NETWORK_ERROR",
        "Failed to reach the configured Zapier endpoint.",
        {
          endpointHost: endpointUrl.host.toLowerCase(),
          cause: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }

    const parsedBody = await parseResponseBody(response);
    if (!response.ok) {
      const details: Record<string, JsonValue> = {
        endpointHost: endpointUrl.host.toLowerCase(),
        upstreamStatus: response.status,
      };

      if (isJsonObject(parsedBody)) {
        details.upstreamBody = parsedBody;
      } else if (typeof parsedBody === "string") {
        details.upstreamText = parsedBody;
      }

      throw new HttpError(
        response.status,
        "ZAPIER_UPSTREAM_ERROR",
        "The Zapier endpoint returned an error response.",
        details,
      );
    }

    if (!isJsonObject(parsedBody)) {
      throw new HttpError(
        502,
        "ZAPIER_INVALID_RESPONSE",
        "The Zapier endpoint returned a non-object JSON payload.",
        { endpointHost: endpointUrl.host.toLowerCase() },
      );
    }

    return {
      status: response.status,
      body: parsedBody as JsonObject,
      headers: {
        "Cache-Control": "no-store",
        "X-Zapier-Proxy": "forwarded",
      },
    };
  }
}

// This is the one shared Zapier proxy service slot for the current process.
// Reusing a single instance avoids rebuilding the config and logger over and over again.
const globalForZapierProxy = globalThis as typeof globalThis & {
  __zapierProxyService?: ZapierProxyService;
};

// This returns the shared Zapier proxy service instance.
// The first call creates it, and later calls reuse the same object.
export function getZapierProxyService(): ZapierProxyService {
  if (!globalForZapierProxy.__zapierProxyService) {
    globalForZapierProxy.__zapierProxyService = new ZapierProxyService(resolveZapierConfig());
    createLogger("zapier-proxy").info("Initialized the Zapier proxy service.");
  }

  return globalForZapierProxy.__zapierProxyService;
}

// This creates a fresh Zapier proxy service instance.
// Tests can use this when they want to provide their own fetch function instead of the real global one.
export function createZapierProxyService(fetchImpl?: FetchLike): ZapierProxyService {
  return new ZapierProxyService(resolveZapierConfig(), fetchImpl);
}
