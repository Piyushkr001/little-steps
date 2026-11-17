import { type NextRequest, NextResponse } from "next/server";
import { dispatchAdminApiRequest } from "@/server/dispatcher";
import {
  applyCookiesToNextResponse,
  extractUnifiedRequestFromNext,
} from "@/server/next-adapter";

async function handleRequest(
  request: NextRequest,
  context: { params: Promise<{ slug: string[] }> }
): Promise<NextResponse> {
  const { slug } = await context.params;

  let body: unknown = undefined;
  if (!["GET", "HEAD"].includes(request.method.toUpperCase())) {
    try {
      body = await request.json();
    } catch {
      body = {};
    }
  }

  const unifiedReq = extractUnifiedRequestFromNext(request, slug, body);
  const result = await dispatchAdminApiRequest(unifiedReq);

  return applyCookiesToNextResponse(
    NextResponse.json(result.body, { status: result.status }),
    result.cookiesToSet
  );
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string[] }> }
) {
  return handleRequest(request, context);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ slug: string[] }> }
) {
  return handleRequest(request, context);
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ slug: string[] }> }
) {
  return handleRequest(request, context);
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ slug: string[] }> }
) {
  return handleRequest(request, context);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ slug: string[] }> }
) {
  return handleRequest(request, context);
}
