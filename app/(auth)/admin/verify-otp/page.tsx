"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  KeyRound,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { adminAuth } from "@/lib/api/admin-api";
import { AdminApiClientError } from "@/lib/api/axios-client";

function VerifyOtpContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryEmail = searchParams.get("email") || "";

  const [email] = useState(() => {
    if (queryEmail) return queryEmail;
    if (typeof window !== "undefined") {
      return sessionStorage.getItem("ls_pending_admin_email") || "";
    }
    return "";
  });
  const [otp, setOtp] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [expirySeconds, setExpirySeconds] = useState(300);
  const [resendCooldown, setResendCooldown] = useState(60);

  useEffect(() => {
    if (!email) {
      router.replace("/admin/login");
    }
  }, [email, router]);

  useEffect(() => {
    const timer = setInterval(() => {
      setExpirySeconds((prev) => (prev > 0 ? prev - 1 : 0));
      setResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTimer = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return `${mins}:${String(rem).padStart(2, "0")}`;
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setStatusBanner(null);

    if (!/^\d{6}$/.test(otp.trim())) {
      setErrorMessage("Please enter a valid 6-digit numerical OTP code.");
      return;
    }

    setVerifying(true);
    try {
      await adminAuth.verifyOtp(email, otp.trim());
      if (typeof window !== "undefined") {
        sessionStorage.removeItem("ls_pending_admin_email");
      }
      router.push("/admin/dashboard");
      router.refresh();
    } catch (err) {
      if (err instanceof AdminApiClientError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage("OTP verification failed. Please try again.");
      }
    } finally {
      setVerifying(false);
    }
  };

  const handleResend = async () => {
    if (resendCooldown > 0 || !email) return;
    setErrorMessage(null);
    setStatusBanner(null);
    setResending(true);

    try {
      const res = await adminAuth.resendOtp(email);
      setOtp("");
      setExpirySeconds(res.data.expiresInSeconds || 300);
      setResendCooldown(res.data.resendCooldownSeconds || 60);
      setStatusBanner(
        "A new 6-digit OTP has been sent. Previous OTP codes have been invalidated."
      );
    } catch (err) {
      if (err instanceof AdminApiClientError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage("Could not resend OTP at this time.");
      }
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center bg-[#F6FBF9] px-4 py-10 dark:bg-background sm:px-6">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center justify-between">
          <Link
            href="/admin/login"
            className="inline-flex items-center gap-2 text-sm font-medium text-slate-600 transition-colors hover:text-[#087F78] dark:text-muted-foreground"
          >
            <ArrowLeft className="size-4" />
            Change Admin Email
          </Link>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#EAF8F5] px-3 py-1 text-xs font-semibold text-[#087F78] dark:bg-teal-950/60 dark:text-teal-300">
            <KeyRound className="size-3.5" />
            Step 2 of 2
          </span>
        </div>

        <Card className="rounded-3xl border-slate-200/80 bg-white shadow-xl dark:border-border dark:bg-card">
          <CardHeader className="space-y-3 text-center">
            <div className="mx-auto flex justify-center">
              <Image
                src="/Images/logo.svg"
                alt="Little Steps"
                width={175}
                height={42}
                preload
                className="h-auto w-40 object-contain"
              />
            </div>
            <CardTitle className="text-2xl font-bold text-slate-900 dark:text-foreground">
              Verify Email OTP
            </CardTitle>
            <CardDescription className="text-sm">
              Enter the 6-digit verification code sent to{" "}
              <span className="font-semibold text-[#087F78] dark:text-teal-300">
                {email || "your admin email"}
              </span>
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-5">
            {errorMessage && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertTitle>Verification Error</AlertTitle>
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            )}

            {statusBanner && (
              <Alert className="border-teal-300 bg-[#EAF8F5] text-[#087F78] dark:border-teal-800 dark:bg-teal-950/50 dark:text-teal-200">
                <CheckCircle2 className="size-4" />
                <AlertTitle>OTP Sent</AlertTitle>
                <AlertDescription>{statusBanner}</AlertDescription>
              </Alert>
            )}

            <form onSubmit={handleVerify} className="space-y-6">
              <div className="flex flex-col items-center gap-3">
                <InputOTP
                  maxLength={6}
                  value={otp}
                  onChange={(value) =>
                    setOtp(value.replace(/\D/g, "").slice(0, 6))
                  }
                >
                  <InputOTPGroup>
                    <InputOTPSlot index={0} className="size-11 text-base font-bold" />
                    <InputOTPSlot index={1} className="size-11 text-base font-bold" />
                    <InputOTPSlot index={2} className="size-11 text-base font-bold" />
                  </InputOTPGroup>
                  <InputOTPSeparator />
                  <InputOTPGroup>
                    <InputOTPSlot index={3} className="size-11 text-base font-bold" />
                    <InputOTPSlot index={4} className="size-11 text-base font-bold" />
                    <InputOTPSlot index={5} className="size-11 text-base font-bold" />
                  </InputOTPGroup>
                </InputOTP>

                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-muted-foreground">
                  <Clock className="size-3.5 text-[#F2A65A]" />
                  {expirySeconds > 0 ? (
                    <span>
                      Code expires in{" "}
                      <strong className="text-slate-700 dark:text-foreground">
                        {formatTimer(expirySeconds)}
                      </strong>{" "}
                      (Max 5 attempts)
                    </span>
                  ) : (
                    <span className="font-semibold text-destructive">
                      Code expired — please request a new OTP below
                    </span>
                  )}
                </div>

                {(email.endsWith("@littlesteps.com") ||
                  email === "littlesteps.admin@gmail.com") && (
                  <button
                    type="button"
                    onClick={() => {
                      setOtp("123456");
                      setErrorMessage(null);
                    }}
                    className="mt-1 rounded-full border border-[#087F78]/30 bg-[#EAF8F5] px-3 py-1 text-xs font-semibold text-[#087F78] transition-colors hover:bg-[#d5f1eb] dark:bg-teal-950/60 dark:text-teal-300"
                  >
                    Demo Account OTP: <span className="font-mono font-bold">123456</span> (Click to autofill)
                  </button>
                )}
              </div>

              <Button
                type="submit"
                disabled={verifying || otp.length !== 6 || expirySeconds === 0}
                className="h-11 w-full gap-2 rounded-full bg-[#087F78] text-sm font-semibold text-white hover:bg-[#066B65]"
              >
                <ShieldCheck className="size-4" />
                {verifying ? "Verifying Code..." : "Verify & Enter Admin Portal"}
              </Button>
            </form>

            <div className="flex items-center justify-between border-t pt-4 text-xs">
              <span className="text-slate-500 dark:text-muted-foreground">
                Didn&apos;t receive the code?
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={resendCooldown > 0 || resending}
                onClick={handleResend}
                className="gap-1.5 text-xs font-semibold text-[#087F78] hover:bg-[#EAF8F5]"
              >
                <RefreshCw className="size-3.5" />
                {resendCooldown > 0
                  ? `Resend in ${resendCooldown}s`
                  : resending
                    ? "Sending..."
                    : "Resend New OTP"}
              </Button>
            </div>
          </CardContent>

          <CardFooter className="justify-center border-t bg-slate-50/60 py-3 text-center text-[11px] text-slate-500 dark:bg-muted/20 dark:text-muted-foreground">
            In local development without SMTP credentials, check the server
            terminal log for the 6-digit OTP code.
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}

export default function AdminVerifyOtpPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#F6FBF9] dark:bg-background" />}>
      <VerifyOtpContent />
    </Suspense>
  );
}
