import { type NextRequest, NextResponse } from "next/server";
import { dispatchAdminApiRequest } from "@/server/dispatcher";

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

  const query: Record<string, string | undefined> = {};
  request.nextUrl.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const cookies: Record<string, string | undefined> = {};
  for (const cookie of request.cookies.getAll()) {
    cookies[cookie.name] = cookie.value;
  }

  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "127.0.0.1";
  const userAgent = request.headers.get("user-agent") || "NextClient";

  const result = await dispatchAdminApiRequest({
    method: request.method,
    segments: slug,
    query,
    body,
    cookies,
    headers,
    ipAddress,
    userAgent,
  });

  const response = NextResponse.json(result.body, { status: result.status });

  if (result.cookiesToSet) {
    for (const c of result.cookiesToSet) {
      response.cookies.set(c.name, c.value, {
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        path: c.path,
        maxAge: c.maxAge,
      });
    }
  }

  return response;
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
