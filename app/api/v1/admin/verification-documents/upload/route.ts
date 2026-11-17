import type { NextRequest } from "next/server";
import { handleNextDocumentUploadPost } from "@/server/next-adapter";

export async function POST(request: NextRequest) {
  return handleNextDocumentUploadPost(request);
}
