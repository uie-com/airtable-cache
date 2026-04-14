// This file is the small HTTP doorway for the Airtable cache service.
// It does not do the cache work itself. It only turns a web request into the
// format the service understands, asks the service for an answer, and sends
// that answer back to the caller.
import { NextRequest, NextResponse } from "next/server";

// These helpers do the real work. One turns the incoming Next.js request into
// a proxy request, one runs the cache service, and one turns errors into safe
// JSON responses.
import { toErrorResponse } from "@/lib/airtable-cache/errors";
import { buildAirtableProxyRequest } from "@/lib/airtable-cache/request";
import { getAirtableCacheService } from "@/lib/airtable-cache/service";

// This route must run in Node.js because the cache service reads and writes
// files on disk and uses server-side state.
export const runtime = "nodejs";

// This handler is the only job of the route. It takes the incoming request,
// hands it to the cache service, and returns whatever the service decides.
export async function GET(request: NextRequest) {
  try {
    // First, reshape the Next.js request into the proxy request format the
    // cache service expects.
    const proxyRequest = buildAirtableProxyRequest(request);
    // Next, let the shared service inspect the request, use cache if possible,
    // and fetch Airtable if it needs fresh data.
    const response = await getAirtableCacheService().handle(proxyRequest);

    // Finally, send the service result back as JSON with the status and any
    // headers the service wants the caller to see.
    return NextResponse.json(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    // If anything goes wrong here, turn it into a safe JSON error response so
    // the caller does not see an unhandled exception page.
    const response = toErrorResponse(error, "Failed to proxy the Airtable request.");
    return NextResponse.json(response.body, { status: response.status });
  }
}
