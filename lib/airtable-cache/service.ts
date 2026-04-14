// This file builds the cache service that the route handler uses.
// It connects configuration, logging, persistence, the Airtable client, and the in-memory store
// into one object so the rest of the app can call a small, simple API.
import { AirtableClient } from "@/lib/airtable-cache/airtable-client";
import { AirtableCacheStore } from "@/lib/airtable-cache/cache-store";
import { createAirtableConfig } from "@/lib/airtable-cache/config";
import { createLogger } from "@/lib/airtable-cache/logging";
import { FileSystemCachePersistence } from "@/lib/airtable-cache/persistence";
import {
  AirtableConfig,
  FetchLike,
  Logger,
  ProxyRequest,
  ProxyResponse,
} from "@/lib/airtable-cache/types";

// These options let tests or special call sites replace the default config, fetch function,
// logger, or clock while keeping the normal production wiring in one place.
interface AirtableCacheServiceOptions {
  config?: AirtableConfig;
  fetchImpl?: FetchLike;
  logger?: Logger;
  now?: () => number;
}

// This is the small public service wrapper around the cache store.
// It exists so callers do not need to know about the store internals.
export class AirtableCacheService {
  // The store holds the actual cache state and does the real work.
  constructor(private readonly store: AirtableCacheStore) {}

  // Handle one proxy request by passing it to the store and returning the response.
  async handle(request: ProxyRequest): Promise<ProxyResponse> {
    return this.store.resolve(request);
  }

  // Wait until any queued work for one site, or for every site, has finished.
  async waitForIdle(siteKey?: string): Promise<void> {
    await this.store.waitForIdle(siteKey);
  }
}

// Build a fresh service instance with the normal production dependencies.
// This helper keeps the wiring in one place so tests can also reuse it.
function createAirtableCacheServiceInstance(
  options: AirtableCacheServiceOptions = {},
): AirtableCacheService {
  const config = options.config ?? createAirtableConfig();
  const logger = options.logger ?? createLogger("airtable-cache");
  const now = options.now ?? Date.now;
  const persistence = new FileSystemCachePersistence(config, logger, now);
  const client = new AirtableClient(config, logger, options.fetchImpl);
  const store = new AirtableCacheStore(config, persistence, client, logger, now);

  return new AirtableCacheService(store);
}

// Next.js can reload modules during development, so the service is stored on globalThis to keep
// one in-memory cache alive for the life of the process.
const globalAirtableCacheSingleton = globalThis as typeof globalThis & {
  __airtableCacheService?: AirtableCacheService;
};

// Build a new service using either caller-provided test dependencies or the default production ones.
export function createAirtableCacheService(
  options: AirtableCacheServiceOptions = {},
): AirtableCacheService {
  return createAirtableCacheServiceInstance(options);
}

// Reuse one process-wide service instance so the in-memory cache survives module reloads.
export function getAirtableCacheService(): AirtableCacheService {
  // Keep one process-wide service instance so Next.js hot reloads do not rebuild the in-memory
  // cache on every module evaluation while the VM process is still alive.
  if (!globalAirtableCacheSingleton.__airtableCacheService) {
    globalAirtableCacheSingleton.__airtableCacheService =
      createAirtableCacheServiceInstance();
  }

  return globalAirtableCacheSingleton.__airtableCacheService;
}

// Tests can clear the singleton so each test starts with a fresh service and a clean cache state.
export function resetAirtableCacheServiceForTests(): void {
  delete globalAirtableCacheSingleton.__airtableCacheService;
}
