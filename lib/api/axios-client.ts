import axios, { type AxiosError, type InternalAxiosRequestConfig } from "axios";
import type { ApiErrorResponse } from "@/lib/admin/types";

export class AdminApiClientError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(message: string, status = 500, code = "API_ERROR", details?: unknown) {
    super(message);
    this.name = "AdminApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function getBrowserCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split("=").slice(1).join("=")) : null;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "/api/v1";

export const adminAxiosClient = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  timeout: 25_000,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

adminAxiosClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    if (
      typeof FormData !== "undefined" &&
      config.data instanceof FormData &&
      config.headers
    ) {
      config.headers.delete("Content-Type");
    }
    const method = (config.method || "get").toUpperCase();
    if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
      const csrfToken = getBrowserCookie("ls_admin_csrf");
      if (csrfToken && config.headers) {
        config.headers.set("x-csrf-token", csrfToken);
      }
    }
    return config;
  },
  (error) => Promise.reject(error)
);

adminAxiosClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiErrorResponse>) => {
    const status = error.response?.status ?? 500;
    const payload = error.response?.data;
    const code = payload?.error?.code ?? "NETWORK_OR_SERVER_ERROR";
    const message =
      payload?.error?.message ||
      error.message ||
      "Unable to complete request. Please try again.";

    // Handle expired admin session without causing redirect loops on auth pages
    if (
      status === 401 &&
      code === "UNAUTHORIZED_ADMIN_SESSION" &&
      typeof window !== "undefined"
    ) {
      const pathname = window.location.pathname;
      const isAuthPage =
        pathname.startsWith("/admin/login") ||
        pathname.startsWith("/admin/verify-otp");
      if (pathname.startsWith("/admin") && !isAuthPage) {
        window.location.href = "/admin/login?session=expired";
      }
    }

    return Promise.reject(
      new AdminApiClientError(message, status, code, payload?.error?.details)
    );
  }
);

export function extractApiErrorMessage(err: unknown): string {
  if (err instanceof AdminApiClientError) {
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "Unable to complete request. Please try again.";
}
