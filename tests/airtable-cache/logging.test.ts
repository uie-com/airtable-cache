import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "@/lib/airtable-cache/logging";

describe("airtable cache logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs scoped info messages with and without context", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logger = createLogger("airtable-cache");

    logger.info("Loaded snapshot.");
    logger.info("Persisted snapshot.", { siteKey: "influence.centercentre.com" });

    expect(infoSpy).toHaveBeenNthCalledWith(1, "[airtable-cache] Loaded snapshot.");
    expect(infoSpy).toHaveBeenNthCalledWith(2, "[airtable-cache] Persisted snapshot.", {
      siteKey: "influence.centercentre.com",
    });
  });

  it("logs warnings and errors with the expected scope prefix", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = createLogger("zapier-proxy");

    logger.warn("Missing allowlist.", { source: "env" });
    logger.error("Request failed.");

    expect(warnSpy).toHaveBeenCalledWith("[zapier-proxy] Missing allowlist.", {
      source: "env",
    });
    expect(errorSpy).toHaveBeenCalledWith("[zapier-proxy] Request failed.");
  });

  it("logs warning and error context only when context keys exist", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = createLogger("zapier-proxy");

    logger.warn("Missing cache metadata.");
    logger.error("Request failed.", { endpointHost: "hooks.zapier.com" });

    expect(warnSpy).toHaveBeenCalledWith("[zapier-proxy] Missing cache metadata.");
    expect(errorSpy).toHaveBeenCalledWith("[zapier-proxy] Request failed.", {
      endpointHost: "hooks.zapier.com",
    });
  });
});
