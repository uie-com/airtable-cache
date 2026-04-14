import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createZapierProxyService,
  getZapierProxyService,
} from "@/lib/zapier/service";
import { createJsonResponse } from "@/tests/test-utils";

describe("zapier proxy service", () => {
  const originalSecret = process.env.ZAPIER_SHARED_SECRET;
  const originalAllowHosts = process.env.ZAPIER_ALLOWED_HOSTS;
  const originalTimeout = process.env.AIRTABLE_FETCH_TIMEOUT_MS;

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.ZAPIER_SHARED_SECRET = originalSecret;
    process.env.ZAPIER_ALLOWED_HOSTS = originalAllowHosts;
    process.env.AIRTABLE_FETCH_TIMEOUT_MS = originalTimeout;
    delete (globalThis as typeof globalThis & { __zapierProxyService?: unknown })
      .__zapierProxyService;
  });

  it("requires env configuration before building the global service", () => {
    delete process.env.ZAPIER_SHARED_SECRET;
    delete process.env.ZAPIER_ALLOWED_HOSTS;

    expect(() => getZapierProxyService()).toThrow(/ZAPIER_SHARED_SECRET/i);
  });

  it("requires an endpoint allowlist before creating the service", () => {
    process.env.ZAPIER_SHARED_SECRET = "shared-secret";
    delete process.env.ZAPIER_ALLOWED_HOSTS;

    expect(() => createZapierProxyService()).toThrow(/ZAPIER_ALLOWED_HOSTS/i);
  });

  it("memoizes the global service and falls back to the default timeout", () => {
    process.env.ZAPIER_SHARED_SECRET = "shared-secret";
    process.env.ZAPIER_ALLOWED_HOSTS = "hooks.zapier.com, hooks.zapier.com";
    process.env.AIRTABLE_FETCH_TIMEOUT_MS = "not-a-number";

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const firstService = getZapierProxyService();
    const secondService = getZapierProxyService();

    expect(firstService).toBe(secondService);
    expect((firstService as unknown as { config: { fetchTimeoutMs: number } }).config.fetchTimeoutMs)
      .toBe(15_000);
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it("accepts bearer auth and forwards the JSON payload", async () => {
    process.env.ZAPIER_SHARED_SECRET = "shared-secret";
    process.env.ZAPIER_ALLOWED_HOSTS = "hooks.zapier.com";

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({ ok: true }),
    );
    const service = createZapierProxyService(fetchMock);

    const response = await service.handle(
      new NextRequest(
        "http://localhost:4444/zapier?endpoint=https://hooks.zapier.com/hooks/catch/123",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: "Bearer shared-secret",
          },
          body: JSON.stringify({ event: "published" }),
        },
      ),
    );

    expect(response).toEqual({
      status: 200,
      body: { ok: true },
      headers: {
        "Cache-Control": "no-store",
        "X-Zapier-Proxy": "forwarded",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.zapier.com/hooks/catch/123",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ event: "published" }),
      }),
    );
  });

  it("rejects invalid endpoints, invalid JSON bodies, and non-object responses", async () => {
    process.env.ZAPIER_SHARED_SECRET = "shared-secret";
    process.env.ZAPIER_ALLOWED_HOSTS = "hooks.zapier.com";

    const service = createZapierProxyService(
      vi.fn<typeof fetch>().mockResolvedValue(new Response('"ok"', { status: 200 })),
    );

    await expect(
      service.handle(
        new NextRequest("http://localhost:4444/zapier?endpoint=not-a-url", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-zapier-secret": "shared-secret",
          },
          body: JSON.stringify({ event: "published" }),
        }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_ENDPOINT",
    });

    await expect(
      service.handle(
        new NextRequest("http://localhost:4444/zapier?endpoint=ftp://hooks.zapier.com/upload", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-zapier-secret": "shared-secret",
          },
          body: JSON.stringify({ event: "published" }),
        }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_ENDPOINT",
    });

    await expect(
      service.handle(
        new NextRequest(
          "http://localhost:4444/zapier?endpoint=https://hooks.zapier.com/hooks/catch/123",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-zapier-secret": "shared-secret",
            },
            body: "not-json",
          },
        ),
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_JSON",
    });

    await expect(
      service.handle(
        new NextRequest(
          "http://localhost:4444/zapier?endpoint=https://hooks.zapier.com/hooks/catch/123",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-zapier-secret": "shared-secret",
            },
            body: JSON.stringify({ event: "published" }),
          },
        ),
      ),
    ).rejects.toMatchObject({
      status: 502,
      code: "ZAPIER_INVALID_RESPONSE",
    });
  });

  it("rejects missing endpoints and accepts empty upstream bodies as empty objects", async () => {
    process.env.ZAPIER_SHARED_SECRET = "shared-secret";
    process.env.ZAPIER_ALLOWED_HOSTS = "hooks.zapier.com";

    const service = createZapierProxyService(
      vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 200 })),
    );

    await expect(
      service.handle(
        new NextRequest("http://localhost:4444/zapier", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-zapier-secret": "shared-secret",
          },
          body: JSON.stringify({ event: "published" }),
        }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "MISSING_ENDPOINT",
    });

    await expect(
      service.handle(
        new NextRequest(
          "http://localhost:4444/zapier?endpoint=https://hooks.zapier.com/hooks/catch/123",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-zapier-secret": "shared-secret",
            },
            body: JSON.stringify({ event: "published" }),
          },
        ),
      ),
    ).resolves.toEqual({
      status: 200,
      body: {},
      headers: {
        "Cache-Control": "no-store",
        "X-Zapier-Proxy": "forwarded",
      },
    });
  });

  it("surfaces upstream JSON, upstream text, and network failures", async () => {
    process.env.ZAPIER_SHARED_SECRET = "shared-secret";
    process.env.ZAPIER_ALLOWED_HOSTS = "hooks.zapier.com";

    const jsonErrorService = createZapierProxyService(
      vi.fn<typeof fetch>().mockResolvedValue(
        createJsonResponse(
          { error: { message: "Denied" } },
          { status: 403 },
        ),
      ),
    );
    const textErrorService = createZapierProxyService(
      vi.fn<typeof fetch>().mockResolvedValue(new Response("gateway broke", { status: 502 })),
    );
    const networkErrorService = createZapierProxyService(
      vi.fn<typeof fetch>().mockRejectedValue(new Error("connect ECONNRESET")),
    );
    const unknownFailureService = createZapierProxyService(
      vi.fn<typeof fetch>().mockRejectedValue("socket hang up"),
    );

    const buildRequest = () =>
      new NextRequest(
        "http://localhost:4444/zapier?endpoint=https://hooks.zapier.com/hooks/catch/123",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-zapier-secret": "shared-secret",
          },
          body: JSON.stringify({ event: "published" }),
        },
      );

    await expect(jsonErrorService.handle(buildRequest())).rejects.toMatchObject({
      status: 403,
      code: "ZAPIER_UPSTREAM_ERROR",
      details: {
        upstreamBody: {
          error: {
            message: "Denied",
          },
        },
      },
    });
    await expect(textErrorService.handle(buildRequest())).rejects.toMatchObject({
      status: 502,
      code: "ZAPIER_UPSTREAM_ERROR",
      details: {
        upstreamText: "gateway broke",
      },
    });
    await expect(networkErrorService.handle(buildRequest())).rejects.toMatchObject({
      status: 502,
      code: "ZAPIER_NETWORK_ERROR",
    });
    await expect(unknownFailureService.handle(buildRequest())).rejects.toMatchObject({
      status: 502,
      code: "ZAPIER_NETWORK_ERROR",
      details: {
        cause: "Unknown error",
      },
    });
  });
});
