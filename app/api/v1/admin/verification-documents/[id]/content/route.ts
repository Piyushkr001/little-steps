import type { NextRequest } from "next/server";
import { handleNextDocumentContentGet } from "@/server/next-adapter";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  return handleNextDocumentContentGet(request, id);
}
