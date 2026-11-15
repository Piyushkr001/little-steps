"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Lock,
  RefreshCw,
  Save,
  Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type AdminPlatformSettingItem,
  settings as settingsApi,
} from "@/lib/api/admin-api";
import { extractApiErrorMessage } from "@/lib/api/axios-client";

export default function AdminSettingsPage() {
  const [items, setItems] = useState<AdminPlatformSettingItem[]>([]);
  const [draftValues, setDraftValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const data = await settingsApi.getAll();
      setItems(data);
      const map: Record<string, unknown> = {};
      for (const s of data) {
        map[s.settingKey] = s.settingValue;
      }
      setDraftValues(map);
    } catch (err) {
      setError(extractApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(loadSettings);
  }, [loadSettings]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const payload = items.map((item) => ({
        settingKey: item.settingKey,
        settingValue: draftValues[item.settingKey],
        category: item.category as
          | "GENERAL"
          | "SECURITY"
          | "VERIFICATION"
          | "BOOKINGS"
          | "NOTIFICATIONS",
        description: item.description ?? undefined,
      }));
      const updated = await settingsApi.updateAll(payload);
      setItems(updated);
      setSuccessMessage(
        "Platform operational & security settings saved and recorded in audit logs."
      );
    } catch (err) {
      setError(extractApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-[#0B3B3C] dark:text-teal-50">
            Platform Operations & Security Settings
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Configure administrative authentication policies, provider
            verification rules, childcare capacity enforcement, and escalation
            channels.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void loadSettings()}
          disabled={loading}
          className="rounded-xl"
        >
          <RefreshCw
            className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Reload Configuration
        </Button>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}

      {successMessage && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          {successMessage}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        <Card className="border-slate-200/80 shadow-xs dark:border-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-bold">
              <Settings className="h-4 w-4 text-[#087F78]" />
              Active Platform Configuration Parameters
            </CardTitle>
            <CardDescription>
              All modifications require CSRF validation and generate a
              tamper-evident audit entry.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading ? (
              <div className="py-8 text-center text-sm text-slate-500">
                Loading platform settings...
              </div>
            ) : (
              items.map((item) => {
                const currentVal = draftValues[item.settingKey];
                const isBoolean = typeof item.settingValue === "boolean";
                const isNumber = typeof item.settingValue === "number";

                return (
                  <div
                    key={item.id}
                    className="flex flex-col justify-between gap-4 rounded-xl border border-slate-200/80 p-4 dark:border-slate-800 sm:flex-row sm:items-center"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="rounded-md bg-[#EAF8F5] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#087F78] dark:bg-teal-950 dark:text-teal-300">
                          {item.category}
                        </span>
                        <Label
                          htmlFor={item.settingKey}
                          className="font-mono text-xs font-bold text-slate-900 dark:text-slate-100"
                        >
                          {item.settingKey}
                        </Label>
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-400">
                        {item.description}
                      </p>
                    </div>

                    <div className="sm:w-64">
                      {isBoolean ? (
                        <select
                          id={item.settingKey}
                          value={Boolean(currentVal) ? "true" : "false"}
                          onChange={(e) =>
                            setDraftValues((prev) => ({
                              ...prev,
                              [item.settingKey]: e.target.value === "true",
                            }))
                          }
                          className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
                        >
                          <option value="true">Enabled (True)</option>
                          <option value="false">Disabled (False)</option>
                        </select>
                      ) : isNumber ? (
                        <Input
                          id={item.settingKey}
                          type="number"
                          value={String(currentVal ?? "")}
                          onChange={(e) =>
                            setDraftValues((prev) => ({
                              ...prev,
                              [item.settingKey]: Number(e.target.value),
                            }))
                          }
                          className="h-9 text-xs"
                        />
                      ) : (
                        <Input
                          id={item.settingKey}
                          type="text"
                          value={String(currentVal ?? "")}
                          onChange={(e) =>
                            setDraftValues((prev) => ({
                              ...prev,
                              [item.settingKey]: e.target.value,
                            }))
                          }
                          className="h-9 text-xs"
                        />
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card className="border-slate-200/80 bg-[#EAF8F5]/40 dark:border-slate-800 dark:bg-teal-950/20">
          <CardContent className="flex flex-col items-start justify-between gap-4 p-4 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3 text-xs text-slate-700 dark:text-slate-300">
              <div className="rounded-xl bg-[#087F78] p-2 text-white">
                <Lock className="h-4 w-4" />
              </div>
              <div>
                <p className="font-bold text-[#0B3B3C] dark:text-teal-100">
                  Enforced Security Invariants
                </p>
                <p>
                  Admin keyword eligibility, HMAC-SHA256 OTP hashing, 5-minute
                  OTP expiry, 5-attempt lockout, and 60-second resend cooldown
                  are enforced server-side.
                </p>
              </div>
            </div>

            <Button
              type="submit"
              disabled={saving || loading}
              className="rounded-xl bg-[#087F78] text-white hover:bg-[#06655F]"
            >
              <Save className="mr-1.5 h-4 w-4" />
              {saving ? "Saving Settings..." : "Save Configuration"}
            </Button>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
