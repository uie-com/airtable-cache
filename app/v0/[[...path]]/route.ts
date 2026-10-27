import { NextRequest, NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/airtable-cache/errors";
import { buildAirtableProxyRequest } from "@/lib/airtable-cache/request";
import { getAirtableCacheService } from "@/lib/airtable-cache/service";

export const runtime = "nodejs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "X-Airtable-Cache",
};

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export async function GET(request: NextRequest) {
  try {
    const proxyRequest = buildAirtableProxyRequest(request);
    const response = await getAirtableCacheService().handle(proxyRequest);

    return NextResponse.json(response.body, {
      status: response.status,
      headers: {
        ...response.headers,
        ...CORS_HEADERS,
      },
    });
  } catch (error) {
    const response = toErrorResponse(error, "Failed to proxy the Airtable request.");
    return NextResponse.json(response.body, {
      status: response.status,
      headers: CORS_HEADERS,
    });
  }
}
