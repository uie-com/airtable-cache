import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/zapier/route";
import { HttpError } from "@/lib/airtable-cache/errors";
import { createZapierProxyService } from "@/lib/zapier/service";
import * as zapierServiceModule from "@/lib/zapier/service";
import { createJsonResponse } from "@/tests/test-utils";

describe("/zapier route", () => {
  const originalSecret = process.env.ZAPIER_SHARED_SECRET;
  const originalAllowHosts = process.env.ZAPIER_ALLOWED_HOSTS;

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.ZAPIER_SHARED_SECRET = originalSecret;
    process.env.ZAPIER_ALLOWED_HOSTS = originalAllowHosts;
  });

  it("forwards allowed POST requests with the shared secret", async () => {
    process.env.ZAPIER_SHARED_SECRET = "super-secret";
    process.env.ZAPIER_ALLOWED_HOSTS = "hooks.zapier.com";

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({ ok: true }),
    );
    vi.spyOn(zapierServiceModule, "getZapierProxyService").mockReturnValue(
      createZapierProxyService(fetchMock),
    );

    const response = await POST(
      new NextRequest("http://localhost:4444/zapier?endpoint=https://hooks.zapier.com/hooks/catch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-zapier-secret": "super-secret",
        },
        body: JSON.stringify({ hello: "world" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Zapier-Proxy")).toBe("forwarded");
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects requests without the shared secret", async () => {
    process.env.ZAPIER_SHARED_SECRET = "super-secret";
    process.env.ZAPIER_ALLOWED_HOSTS = "hooks.zapier.com";

    vi.spyOn(zapierServiceModule, "getZapierProxyService").mockReturnValue(
      createZapierProxyService(),
    );

    const response = await POST(
      new NextRequest("http://localhost:4444/zapier?endpoint=https://hooks.zapier.com/hooks/catch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ hello: "world" }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNAUTHORIZED",
        message: "A valid shared secret is required to use the Zapier proxy.",
      },
    });
  });

  it("rejects disallowed endpoint hosts", async () => {
    process.env.ZAPIER_SHARED_SECRET = "super-secret";
    process.env.ZAPIER_ALLOWED_HOSTS = "hooks.zapier.com";

    vi.spyOn(zapierServiceModule, "getZapierProxyService").mockReturnValue(
      createZapierProxyService(),
    );

    const response = await POST(
      new NextRequest("http://localhost:4444/zapier?endpoint=https://example.com/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-zapier-secret": "super-secret",
        },
        body: JSON.stringify({ hello: "world" }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "DISALLOWED_ENDPOINT",
        message: "The endpoint host is not in the Zapier allowlist.",
        details: {
          endpointHost: "example.com",
        },
      },
    });
  });

  it("serializes HttpError and unexpected Zapier route failures", async () => {
    vi.spyOn(zapierServiceModule, "getZapierProxyService").mockReturnValue({
      handle: vi
        .fn()
        .mockRejectedValueOnce(
          new HttpError(502, "ZAPIER_NETWORK_ERROR", "Failed to reach the configured Zapier endpoint."),
        )
        .mockRejectedValueOnce(new Error("boom")),
    } as unknown as ReturnType<typeof zapierServiceModule.getZapierProxyService>);

    const createRequest = () =>
      new NextRequest(
        "http://localhost:4444/zapier?endpoint=https://hooks.zapier.com/hooks/catch",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-zapier-secret": "super-secret",
          },
          body: JSON.stringify({ hello: "world" }),
        },
      );

    const upstreamResponse = await POST(createRequest());
    const genericResponse = await POST(createRequest());

    expect(upstreamResponse.status).toBe(502);
    await expect(upstreamResponse.json()).resolves.toEqual({
      error: {
        code: "ZAPIER_NETWORK_ERROR",
        message: "Failed to reach the configured Zapier endpoint.",
      },
    });
    expect(genericResponse.status).toBe(500);
    await expect(genericResponse.json()).resolves.toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to forward the Zapier request.",
        details: {
          cause: "boom",
        },
      },
    });
  });
});
