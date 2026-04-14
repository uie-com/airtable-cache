// This file defines the shared data shapes used by the Airtable cache service.
// The goal is to keep the names small for TypeScript, while the comments explain
// what each shape means in the service flow for someone new to the codebase.

// A JSON primitive is the simplest kind of JSON value: text, numbers, true/false,
// or null. These are the building blocks for every larger JSON structure below.
export type JsonPrimitive = string | number | boolean | null;

// A JSON value can be a primitive, an object, or an array. This recursive type is
// the general "anything JSON-shaped" type used throughout the cache service.
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

// A JSON object is a dictionary of string keys to other JSON values.
// It matches the common JavaScript object shape used for parsed API responses.
export interface JsonObject {
  [key: string]: JsonValue;
}

// A JSON array is an ordered list of JSON values.
export type JsonArray = JsonValue[];

// CacheEntryState stores one fully merged Airtable response in memory and on disk.
// `body` is the payload returned to callers, `updatedAt` is when Airtable was last
// fetched for this entry, and `lastAccessedAt` is when the cache entry was last used.
export interface CacheEntryState {
  body: JsonObject;
  updatedAt: number;
  lastAccessedAt: number;
}

/**
 * SiteSnapshot is the canonical on-disk record for one site's cache.
 * The JSON snapshot is the source of truth; the public preload file is generated from it.
 */
export interface SiteSnapshot {
  version: 1;
  siteKey: string;
  savedAt: number;
  entries: Record<string, CacheEntryState>;
}

// ProxyRequest is the normalized request object the route handler passes into the service.
// It keeps the cache key and the upstream Airtable URL separate so the service can decide
// whether a request is a hit, miss, or refresh without re-parsing the HTTP request.
export interface ProxyRequest {
  siteKey: string;
  forceRefresh: boolean;
  /** Normalized upstream Airtable URL with cache-only params removed. */
  airtableUrl: string;
  /** Cache identity for the full Airtable dataset; never includes an `offset` page token. */
  cacheKey: string;
}

// ProxyResponse is the service's HTTP-ready answer shape.
// The route converts this into a NextResponse at the edge of the system.
export interface ProxyResponse {
  status: number;
  body: JsonObject;
  headers?: Record<string, string>;
}

// Logger is the tiny logging contract used by the cache service.
// It stays small so the rest of the code can log without caring about the logging backend.
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

// FetchLike lets the service accept either the real global fetch or a test double.
// This makes the Airtable client easier to test without changing production behavior.
export type FetchLike = typeof fetch;

// AirtableConfig collects the few knobs that control the service's runtime behavior.
// Keeping them in one object makes dependency wiring and tests easier to follow.
export interface AirtableConfig {
  apiKey: string;
  cacheDataDir: string;
  publicCacheDir: string;
  staleAfterMs: number;
  evictAfterMs: number;
  fetchTimeoutMs: number;
}

// CachePersistence describes the file-system storage layer.
// The store only cares that it can load and save snapshots, not how files are written.
export interface CachePersistence {
  loadSiteSnapshot(siteKey: string): Promise<SiteSnapshot | null>;
  saveSiteSnapshot(
    siteKey: string,
    entries: Record<string, CacheEntryState>,
    savedAt: number,
  ): Promise<void>;
}

// AirtableClientContract describes the network client that fetches and merges Airtable pages.
// The cache store depends on this contract so it can be tested with a fake client.
export interface AirtableClientContract {
  fetchMergedResponse(
    airtableUrl: string,
  ): Promise<{ status: number; body: JsonObject; pageCount: number }>;
}

// This helper checks whether an unknown value is a plain JSON object.
// It is used before code tries to treat parsed data like a dictionary.
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// This helper makes a deep copy of a JSON object.
// Copying prevents one caller from accidentally changing data that another caller still uses.
export function cloneJsonObject<T extends JsonObject>(value: T): T {
  return structuredClone(value);
}

// Airtable can return an `offset` field when the data is paginated.
// The cache stores only the merged dataset, so this helper removes that page token before saving.
export function stripOffsetField<T extends JsonObject>(value: T): T {
  // Persisted and in-memory cache entries always model the merged dataset, not an Airtable page.
  const cloned = cloneJsonObject(value);
  delete cloned.offset;
  return cloned;
}
