"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Lock,
  Mail,
  ShieldCheck,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { hasAdminEmailKeyword } from "@/lib/admin/validation";
import { adminAuth } from "@/lib/api/admin-api";
import { AdminApiClientError } from "@/lib/api/axios-client";

function AdminLoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const expiredNotice = searchParams.get("session") === "expired";

  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const normalized = email.trim().toLowerCase();
    if (!normalized) {
      setErrorMessage("Please enter your registered administrator email.");
      return;
    }

    if (!hasAdminEmailKeyword(normalized)) {
      setErrorMessage(
        "Admin Portal sign-in requires an authorized administrator email containing the keyword 'admin'."
      );
      return;
    }

    setSubmitting(true);
    try {
      const response = await adminAuth.requestOtp(normalized);
      if (typeof window !== "undefined") {
        sessionStorage.setItem("ls_pending_admin_email", response.data.email);
      }
      router.push(
        `/admin/verify-otp?email=${encodeURIComponent(response.data.email)}`
      );
    } catch (err) {
      if (err instanceof AdminApiClientError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage(
          "Unable to initiate OTP verification. Please check your connection and try again."
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full flex-col justify-between bg-[#F6FBF9] px-4 py-8 dark:bg-background sm:px-6 lg:px-8">
      {/* Top Bar */}
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-medium text-slate-600 transition-colors hover:text-[#087F78] dark:text-muted-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to Little Steps Public Site
        </Link>

        <Badge className="gap-1.5 rounded-full bg-[#EAF8F5] px-3 py-1 text-xs font-semibold text-[#087F78] dark:bg-teal-950/70 dark:text-teal-300">
          <ShieldCheck className="size-3.5" />
          Zero-Trust Admin Gateway
        </Badge>
      </div>

      {/* Main Content */}
      <div className="mx-auto my-8 flex w-full max-w-5xl flex-col items-center gap-8 lg:flex-row lg:items-stretch lg:gap-10">
        {/* Left Branding & Security Notice */}
        <div className="flex flex-1 flex-col justify-between rounded-3xl bg-[#087F78] p-8 text-white shadow-xl sm:p-10">
          <div className="flex flex-col gap-6">
            <div className="inline-flex w-fit items-center gap-2 rounded-full bg-white/15 px-3.5 py-1.5 text-xs font-semibold tracking-wide text-white uppercase">
              <Lock className="size-3.5 text-[#F2A65A]" />
              Authorized Personnel Only
            </div>

            <h1 className="text-3xl leading-tight font-extrabold tracking-tight sm:text-4xl">
              Little Steps
              <span className="mt-1 block text-[#F2A65A]">
                Admin Operations Portal
              </span>
            </h1>

            <p className="text-sm leading-relaxed text-white/85 sm:text-base">
              Oversee childcare provider verifications, daycare centre safety
              compliance, 24×7 booking capacity, and incident investigations from
              a single audited command centre.
            </p>

            <div className="mt-2 flex flex-col gap-3 rounded-2xl bg-white/10 p-4 text-xs leading-relaxed text-white/90 sm:text-sm">
              <p className="font-semibold text-white">
                Multi-Layer Eligibility Enforcement:
              </p>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[#F2A65A]" />
                <span>
                  Requires an approved <strong>ADMIN</strong> or{" "}
                  <strong>SUPER_ADMIN</strong> profile.
                </span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[#F2A65A]" />
                <span>
                  Email address must satisfy the mandatory{" "}
                  <code className="rounded bg-white/20 px-1.5 py-0.5 font-mono text-xs">
                    admin
                  </code>{" "}
                  keyword policy.
                </span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[#F2A65A]" />
                <span>
                  Single-use 6-digit HMAC-verified Email OTP challenge (5-minute
                  TTL).
                </span>
              </div>
            </div>
          </div>

          <div className="mt-8 border-t border-white/15 pt-5 text-xs text-white/75">
            No public administrator registration is permitted. All access
            attempts and administrative actions are recorded in tamper-evident
            audit logs.
          </div>
        </div>

        {/* Right Sign-In Card */}
        <Card className="flex w-full flex-1 flex-col justify-center rounded-3xl border-slate-200/80 bg-white p-2 shadow-lg dark:border-border dark:bg-card sm:p-4">
          <CardHeader className="space-y-3">
            <div className="flex items-center justify-between">
              <Image
                src="/Images/logo.svg"
                alt="Little Steps"
                width={185}
                height={44}
                preload
                className="h-auto w-44 object-contain"
              />
            </div>
            <CardTitle className="text-2xl font-bold text-slate-900 dark:text-foreground">
              Administrator Sign In
            </CardTitle>
            <CardDescription className="text-sm text-slate-600 dark:text-muted-foreground">
              Enter your registered administrator email to receive a 6-digit
              One-Time Password (OTP).
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-5">
            {expiredNotice && (
              <Alert className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
                <AlertCircle className="size-4" />
                <AlertTitle>Session Expired</AlertTitle>
                <AlertDescription>
                  Your administrator session has expired. Please authenticate
                  again with a fresh OTP.
                </AlertDescription>
              </Alert>
            )}

            {errorMessage && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertTitle>Authentication Rejected</AlertTitle>
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="admin-email">Administrator Email Address</Label>
                <div className="relative flex items-center">
                  <Mail className="pointer-events-none absolute left-3.5 size-4 text-slate-400" />
                  <Input
                    id="admin-email"
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="admin@littlesteps.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="h-11 rounded-xl pl-10 text-sm"
                  />
                </div>
              </div>

              <Button
                type="submit"
                disabled={submitting}
                className="h-11 w-full gap-2 rounded-full bg-[#087F78] text-sm font-semibold text-white hover:bg-[#066B65]"
              >
                {submitting
                  ? "Verifying Eligibility & Sending OTP..."
                  : "Send 6-Digit Verification OTP"}
                <ArrowRight className="size-4" />
              </Button>
            </form>
          </CardContent>

          <CardFooter className="flex justify-between border-t pt-4 text-xs text-slate-500 dark:text-muted-foreground">
            <span>Protected by HttpOnly Session & CSRF Guard</span>
            <span>OTP TTL: 5 Minutes</span>
          </CardFooter>
        </Card>
      </div>

      <p className="text-center text-xs text-slate-500 dark:text-muted-foreground">
        © 2026 Little Steps Childcare Platform • Trust & Safety Security Portal
      </p>
    </div>
  );
}

export default function AdminLoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#F6FBF9] dark:bg-background" />}>
      <AdminLoginForm />
    </Suspense>
  );
}
