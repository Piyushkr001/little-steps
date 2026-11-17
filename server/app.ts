import express, { type Request, type Response } from "express";
import {
  dispatchAdminApiRequest,
  handleDocumentContentStreamRequest,
} from "./dispatcher";
import { extractTrustedClientIp } from "./middleware/rate-limit";

function parseCookieHeader(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey) {
      result[rawKey.trim()] = decodeURIComponent(rest.join("="));
    }
  }
  return result;
}

function extractExpressRequestMeta(req: Request) {
  const query: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (typeof v === "string") query[k] = v;
  }

  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers[k.toLowerCase()] = v;
  }

  return {
    query,
    headers,
    cookies: parseCookieHeader(req.headers.cookie),
    ipAddress: extractTrustedClientIp(headers, req.ip || "127.0.0.1"),
    userAgent: req.headers["user-agent"] || "ExpressClient",
  };
}

export function createExpressApp() {
  const app = express();
  app.disable("x-powered-by");
  // Allow larger base64 JSON payloads specifically for document upload
  app.use(
    "/api/v1/admin/verification-documents/upload",
    express.json({ limit: "15mb" })
  );
  app.use(express.json({ limit: "1mb" }));

  app.get(
    "/api/v1/admin/verification-documents/:id/content",
    async (req: Request, res: Response) => {
      const meta = extractExpressRequestMeta(req);
      const rawDocId = req.params.id;
      const docId = Array.isArray(rawDocId) ? rawDocId[0] ?? "" : rawDocId;

      const streamResult = await handleDocumentContentStreamRequest(
        {
          method: "GET",
          segments: ["verification-documents", docId, "content"],
          query: meta.query,
          body: undefined,
          cookies: meta.cookies,
          headers: meta.headers,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
        docId
      );

      if (!streamResult.ok) {
        res.status(streamResult.response.status).json(streamResult.response.body);
        return;
      }

      for (const [headerName, headerValue] of Object.entries(
        streamResult.headers
      )) {
        res.setHeader(headerName, headerValue);
      }
      res.status(200).send(streamResult.buffer);
    }
  );

  app.all("/api/v1/admin/*splat", async (req: Request, res: Response) => {
    const rawSplat = req.params.splat;
    const segments = Array.isArray(rawSplat)
      ? rawSplat.filter(Boolean)
      : typeof rawSplat === "string"
        ? rawSplat.split("/").filter(Boolean)
        : [];

    const meta = extractExpressRequestMeta(req);

    const result = await dispatchAdminApiRequest({
      method: req.method,
      segments,
      query: meta.query,
      body: req.body,
      cookies: meta.cookies,
      headers: meta.headers,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    if (result.cookiesToSet) {
      for (const c of result.cookiesToSet) {
        res.cookie(c.name, c.value, {
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
          path: c.path,
          maxAge: c.maxAge * 1000,
        });
      }
    }

    res.status(result.status).json(result.body);
  });

  return app;
}

export const expressApp = createExpressApp();
