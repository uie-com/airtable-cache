// This route is the small HTTP entry point for the Zapier proxy.
// Its job is to receive a request, hand it to the Zapier service, and turn the result back into a Next.js response.
import { NextRequest, NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/airtable-cache/errors";
import { getZapierProxyService } from "@/lib/zapier/service";

// Next.js should run this route in Node.js because the Zapier service uses server-only features like global process env access.
export const runtime = "nodejs";

// Handle POST requests from Zapier.
// The real work happens in the shared Zapier proxy service; this function only wraps success and failure into HTTP responses.
export async function POST(request: NextRequest) {
  try {
    const response = await getZapierProxyService().handle(request);

    return NextResponse.json(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    const response = toErrorResponse(error, "Failed to forward the Zapier request.");
    return NextResponse.json(response.body, { status: response.status });
  }
}
