import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

import { HttpError } from "@/lib/airtable-cache/errors";
import { ProxyRequest } from "@/lib/airtable-cache/types";

const SITE_REF_PATTERN = /^(?=.{1,255}$)[a-z0-9._-]+(?::\d{1,5})?$/i;
const DEFAULT_AIRTABLE_API_BASE_URL = "https://api.airtable.com";
const MAX_PRELOAD_TOKEN_LENGTH = 246;
const LONG_TOKEN_PREFIX_LENGTH = 176;

export function normalizeSiteKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new HttpError(400, "INVALID_REF", "The site ref cannot be empty.");
  }

  if (normalized.includes("://")) {
    throw new HttpError(
      400,
      "INVALID_REF",
      "The site ref must be a slug or hostname token, not a full URL.",
      { providedRef: normalized },
    );
  }

  if (!SITE_REF_PATTERN.test(normalized)) {
    throw new HttpError(
      400,
      "INVALID_REF",
      "The site ref contains unsupported characters.",
      { providedRef: normalized },
    );
  }

  return normalized;
}

export function siteKeyToFileToken(siteKey: string): string {
  const normalizedSiteKey = normalizeSiteKey(siteKey);
  const safeSiteKey = normalizedSiteKey.replace(":", "~");

  // Normalized refs contain only lowercase letters, digits, `.`, `_`, and `-`
  // (plus one optional `:` before a port). Encode that separator as `~`: it is
  // safe in filenames and URLs, and cannot occur in a normalized ordinary
  // slug, so `localhost:3000` cannot collide with `localhost_3000` while
  // existing ordinary host tokens remain unchanged (even on case-insensitive
  // filesystems).
  if (safeSiteKey.length <= MAX_PRELOAD_TOKEN_LENGTH) {
    return safeSiteKey;
  }

  // Keep generated `cache-${token}.js` names below the common 255-byte
  // filename limit. The leading `~` makes this form distinct from every
  // ordinary normalized slug (including on case-insensitive filesystems); the
  // digest keeps different long refs distinct even when their readable
  // prefixes match.
  const digest = createHash("sha256").update(normalizedSiteKey, "utf8").digest("hex");
  return `~${safeSiteKey.slice(0, LONG_TOKEN_PREFIX_LENGTH)}-${digest}`;
}

/**
 * Cache identity is based on the base Airtable query. Offset tokens are removed so
 * paginated fragments collapse into the one merged dataset the service returns.
 *
 * Important: we intentionally keep the remaining query parameter order exactly as
 * the caller sent it. The public preload script writes these URLs into
 * `window.airtableCache`, and the legacy program-sites client still does an exact
 * string comparison when looking them up. Sorting the parameters makes the cache
 * semantically equivalent but browser-incompatible, which breaks pre-render data.
 */
export function normalizeAirtableUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("offset");
    return parsed.toString();
  } catch {
    return null;
  }
}

export function resolveAirtableApiBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const rawValue = env.AIRTABLE_API_BASE_URL?.trim();
  if (!rawValue) {
    return DEFAULT_AIRTABLE_API_BASE_URL;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawValue);
  } catch {
    throw new HttpError(
      500,
      "INVALID_CONFIGURATION",
      "AIRTABLE_API_BASE_URL must be a valid absolute URL.",
      { envKey: "AIRTABLE_API_BASE_URL", providedValue: rawValue },
    );
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new HttpError(
      500,
      "INVALID_CONFIGURATION",
      "AIRTABLE_API_BASE_URL must use http or https.",
      { envKey: "AIRTABLE_API_BASE_URL", providedValue: rawValue },
    );
  }

  parsedUrl.hash = "";
  parsedUrl.search = "";
  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");

  return parsedUrl.toString().replace(/\/$/, "");
}

function resolveRequestSiteKey(request: NextRequest): string {
  const refParam = request.nextUrl.searchParams.get("ref");
  if (refParam) {
    return normalizeSiteKey(refParam);
  }

  const refererHeader = request.headers.get("referer");
  if (!refererHeader) {
    throw new HttpError(
      400,
      "MISSING_REF",
      "Provide ?ref=<site> or send a valid Referer header.",
    );
  }

  let refererUrl: URL;
  try {
    refererUrl = new URL(refererHeader);
  } catch {
    throw new HttpError(
      400,
      "INVALID_REFERER",
      "The Referer header must contain a valid URL.",
    );
  }

  if (!refererUrl.host) {
    throw new HttpError(
      400,
      "INVALID_REFERER",
      "The Referer header must include a hostname.",
    );
  }

  return normalizeSiteKey(refererUrl.host);
}

function encodeAirtablePathSegment(segment: string): string {
  try {
    // NextRequest exposes URL pathnames with their percent escapes intact.
    // Decode once before encoding so an already-encoded table name (for
    // example, `%20` or a Unicode escape) reaches Airtable encoded exactly
    // once instead of becoming `%2520`.
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    throw new HttpError(
      400,
      "INVALID_AIRTABLE_PATH",
      "The Airtable path contains a malformed percent-encoded segment.",
    );
  }
}

export function buildAirtableProxyRequest(
  request: NextRequest,
  airtableApiBaseUrl = resolveAirtableApiBaseUrl(),
): ProxyRequest {
  const requestPathWithoutProxyPrefix = request.nextUrl.pathname.replace(/^\/v0\/?/, "");
  const requestedPathSegments = requestPathWithoutProxyPrefix.split("/").filter(Boolean);
  if (requestedPathSegments.length === 0) {
    throw new HttpError(
      400,
      "INVALID_AIRTABLE_PATH",
      "The Airtable path is required after /v0/.",
    );
  }

  const upstreamPathSegments =
    requestedPathSegments[0]?.toLowerCase() === "v0"
      ? requestedPathSegments.slice(1)
      : requestedPathSegments;
  if (upstreamPathSegments.length === 0) {
    throw new HttpError(
      400,
      "INVALID_AIRTABLE_PATH",
      "The Airtable path is required after /v0/.",
    );
  }

  const upstreamSearchParams = new URLSearchParams(request.nextUrl.searchParams);
  upstreamSearchParams.delete("ref");
  upstreamSearchParams.delete("refresh");
  upstreamSearchParams.delete("offset");
  const encodedUpstreamPath = upstreamPathSegments
    .map(encodeAirtablePathSegment)
    .join("/");
  const upstreamAirtableUrl = new URL(`${airtableApiBaseUrl}/v0/${encodedUpstreamPath}`);
  for (const [key, value] of upstreamSearchParams.entries()) {
    upstreamAirtableUrl.searchParams.append(key, value);
  }

  const normalizedAirtableUrl = normalizeAirtableUrl(upstreamAirtableUrl.toString());
  if (!normalizedAirtableUrl) {
    throw new HttpError(
      400,
      "INVALID_AIRTABLE_URL",
      "The Airtable request could not be normalized.",
    );
  }

  return {
    siteKey: resolveRequestSiteKey(request),
    forceRefresh: request.nextUrl.searchParams.get("refresh") === "true",
    airtableUrl: normalizedAirtableUrl,
    cacheKey: normalizedAirtableUrl,
  };
}
