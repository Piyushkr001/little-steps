import express, { type Request, type Response } from "express";
import { dispatchAdminApiRequest } from "./dispatcher";

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

export function createExpressApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.all("/api/v1/admin/*splat", async (req: Request, res: Response) => {
    const rawSplat = req.params.splat;
    const segments = Array.isArray(rawSplat)
      ? rawSplat.filter(Boolean)
      : typeof rawSplat === "string"
        ? rawSplat.split("/").filter(Boolean)
        : [];

    const query: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === "string") query[k] = v;
    }

    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
    }

    const result = await dispatchAdminApiRequest({
      method: req.method,
      segments,
      query,
      body: req.body,
      cookies: parseCookieHeader(req.headers.cookie),
      headers,
      ipAddress:
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
        req.ip ||
        "127.0.0.1",
      userAgent: req.headers["user-agent"] || "ExpressClient",
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
