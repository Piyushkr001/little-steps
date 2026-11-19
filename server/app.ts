import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  dispatchAdminApiRequest,
  handleDocumentContentStreamRequest,
} from "./dispatcher";
import { extractTrustedClientIp } from "./middleware/rate-limit";
import { MAX_JSON_UPLOAD_REQUEST_BYTES } from "./services/document-storage.service";

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
  // Enforce early Content-Length bound & 14 MB base64 JSON cap specifically for document upload
  app.use(
    "/api/v1/admin/verification-documents/upload",
    (req: Request, res: Response, next: NextFunction) => {
      const contentLength = Number(req.headers["content-length"] ?? 0);
      if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_JSON_UPLOAD_REQUEST_BYTES
      ) {
        res.status(413).json({
          success: false,
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message:
              "Upload request exceeds maximum allowed payload size (14 MB encoded / 10 MB document).",
          },
        });
        return;
      }
      next();
    },
    express.json({ limit: MAX_JSON_UPLOAD_REQUEST_BYTES })
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

  app.use(
    (
      err: { type?: string; status?: number; statusCode?: number },
      _req: Request,
      res: Response,
      next: NextFunction
    ) => {
      if (
        err?.type === "entity.too.large" ||
        err?.status === 413 ||
        err?.statusCode === 413
      ) {
        res.status(413).json({
          success: false,
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "Request payload exceeds the maximum allowed size limit.",
          },
        });
        return;
      }
      next(err);
    }
  );

  return app;
}

export const expressApp = createExpressApp();
