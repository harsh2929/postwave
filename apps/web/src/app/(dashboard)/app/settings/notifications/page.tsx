// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { WebPushCard } from "@/components/notifications/web-push-card";
import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";
import { ApiError } from "@/lib/api";
import {
  notificationPrefsApi,
  type NotificationCategory,
  type NotificationPrefs,
  type WebhookKind,
} from "@/lib/notification-prefs-api";

type Digest = "daily" | "weekly" | "never";
type Channel = "email" | "inapp" | "webhook";

const CHANNELS: Array<{ key: Channel; label: string; hint: string }> = [
  { key: "email", label: "Email", hint: "Sent to your account email address." },
  {
    key: "inapp",
    label: "In-app",
    hint: "The notification bell, plus browser & mobile push.",
  },
  {
    key: "webhook",
    label: "Webhook",
    hint: "POST to your webhook URL (Slack-compatible).",
  },
];

const CATEGORIES: Array<{
  base: NotificationCategory;
  label: string;
  description: string;
}> = [
  {
    base: "send_complete",
    label: "Send completion",
    description: "When a campaign finishes sending — totals, opens, bounces.",
  },
  {
    base: "approval_request",
    label: "Approval requests",
    description:
      "When an agent-driven send needs human approval before going out.",
  },
  {
    base: "bounce_alert",
    label: "Bounce-rate alerts",
    description:
      "When a campaign's bounce rate crosses the deliverability threshold.",
  },
  {
    base: "deliverability_alert",
    label: "Blocklist & reputation alerts",
    description:
      "When your sending domain lands on a blocklist or its reputation drops.",
  },
  {
    base: "usage_alert",
    label: "Usage & spend alerts",
    description:
      "When a plan resource reaches your usage threshold (set below).",
  },
];

// The state is the full channel matrix flattened into one object, mirroring the
// API's `<channel>_on_<category>` field names so load/save is a direct copy.
type ChannelKey = `${Channel}_on_${NotificationCategory}`;
type Prefs = Record<ChannelKey, boolean> & {
  notification_webhook_url: string;
  notification_webhook_kind: WebhookKind;
  digest_frequency: Digest;
  // Kept as text while editing so clearing and retyping does not snap the
  // field to 0 after the first keystroke. It is validated/coerced at save.
  usage_alert_threshold_pct: string; // 0 or blank = disabled (BILL-038)
};

const channelKey = (ch: Channel, base: NotificationCategory): ChannelKey =>
  `${ch}_on_${base}` as ChannelKey;

function normalizeDigest(value: string | undefined): Digest {
  return (["daily", "weekly", "never"] as const).includes(value as Digest)
    ? (value as Digest)
    : "weekly";
}

// Map an API payload → local Prefs, applying the behavior-preservation defaults:
// email + in-app default ON (in-app was previously conflated into email_on_*),
// webhook defaults OFF, kind defaults to slack.
function toPrefs(p: NotificationPrefs): Prefs {
  const out = {
    notification_webhook_url: p.notification_webhook_url ?? "",
    notification_webhook_kind:
      p.notification_webhook_kind === "generic" ? "generic" : "slack",
    digest_frequency: normalizeDigest(p.digest_frequency),
    usage_alert_threshold_pct: String(p.usage_alert_threshold_pct ?? 0),
  } as Prefs;
  for (const { base } of CATEGORIES) {
    out[channelKey("email", base)] = p[`email_on_${base}`] ?? true;
    out[channelKey("inapp", base)] = p[`inapp_on_${base}`] ?? true;
    out[channelKey("webhook", base)] = p[`webhook_on_${base}`] ?? false;
  }
  return out;
}

const DEFAULT_PREFS: Prefs = toPrefs({
  user_id: "",
  tenant_id: "",
  email_on_send_complete: true,
  email_on_approval_request: true,
  email_on_bounce_alert: true,
  email_on_deliverability_alert: true,
  digest_frequency: "weekly",
});

export default function NotificationsPage() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [baseline, setBaseline] = useState<Prefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sendingTest, setSendingTest] = useState<null | "category" | "digest">(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const saveInFlightRef = useRef(false);
  const testInFlightRef = useRef(false);
  const loadErrorRef = useRef<HTMLDivElement>(null);
  const actionErrorRef = useRef<HTMLDivElement>(null);

  const dirty = baseline
    ? JSON.stringify(prefs) !== JSON.stringify(baseline)
    : false;
  useUnsavedChangesGuard(dirty);

  // Latest prefs, readable after an await. Every edit spreads into a fresh
  // object, so reference identity is an exact "did the operator touch this
  // while the request was open" signal.
  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  const disabled = loading || baseline === null || Boolean(loadError);
  const webhookUrl = prefs.notification_webhook_url.trim();
  const webhookUrlError = validateWebhookUrl(webhookUrl);
  const webhookUrlInvalid = webhookUrlError !== null;
  const usageThresholdText = prefs.usage_alert_threshold_pct.trim();
  const usageThreshold =
    usageThresholdText === "" ? 0 : Number(usageThresholdText);
  const usageThresholdInvalid =
    !Number.isInteger(usageThreshold) ||
    usageThreshold < 0 ||
    usageThreshold > 100;
  const anyWebhookChecked = useMemo(
    () => CATEGORIES.some(({ base }) => prefs[channelKey("webhook", base)]),
    [prefs],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const p = await notificationPrefsApi.get();
        if (!active) return;
        const loaded = toPrefs(p);
        setPrefs(loaded);
        setBaseline(loaded);
      } catch (e) {
        if (!active) return;
        setLoadError(
          errorMessage(e, "Could not load notification preferences."),
        );
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [loadRevision]);

  useEffect(() => {
    if (loadError) loadErrorRef.current?.focus();
  }, [loadError]);

  useEffect(() => {
    if (error) actionErrorRef.current?.focus();
  }, [error]);

  const onSave = async () => {
    if (saveInFlightRef.current || disabled) return;
    if (webhookUrlInvalid) {
      setError(webhookUrlError);
      return;
    }
    if (usageThresholdInvalid) {
      setError("Usage alert threshold must be a whole number from 0 to 100.");
      return;
    }
    saveInFlightRef.current = true;
    setSaving(true);
    setError(null);
    const sent = prefs;
    try {
      const updated = await notificationPrefsApi.patch({
        ...prefs,
        notification_webhook_url: webhookUrl,
        usage_alert_threshold_pct: usageThreshold,
      });
      const saved = toPrefs(updated);
      // Adopt the server's normalized copy only if nothing was toggled while
      // the request was open — the inputs stay enabled during a save, so
      // writing it back unconditionally reverted the operator's newer choice.
      // The baseline always moves to what the server now holds, which leaves
      // `dirty` (and the unsaved-changes guard) correctly armed for those
      // newer edits.
      if (prefsRef.current === sent) setPrefs(saved);
      setBaseline(saved);
      toast.success("Notification preferences saved.");
    } catch (e) {
      const msg = errorMessage(e, "Could not save notification preferences.");
      setError(msg);
      toast.error(msg);
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  };

  const onSendTest = async (kind: "category" | "digest") => {
    if (testInFlightRef.current || disabled) return;
    testInFlightRef.current = true;
    setSendingTest(kind);
    setError(null);
    try {
      const res = await notificationPrefsApi.sendTest(kind);
      toast.success(`Test ${kind} email sent to ${res.to}.`);
    } catch (e) {
      // 503 = mailer not configured; surface a specific hint.
      const fallback =
        e instanceof ApiError && e.status === 503
          ? "Email delivery isn't configured for this workspace."
          : "Could not send the test email.";
      const message = errorMessage(e, fallback);
      setError(message);
      toast.error(message);
    } finally {
      testInFlightRef.current = false;
      setSendingTest(null);
    }
  };

  const updatePrefs = (update: (current: Prefs) => Prefs) => {
    setError(null);
    setPrefs(update);
  };

  const toggle = (key: ChannelKey, checked: boolean) =>
    updatePrefs((p) => ({ ...p, [key]: checked }));

  return (
    <div className="space-y-6 max-w-3xl">
      <WebPushCard />
      <Card>
        <CardHeader>
          <CardTitle>Notification preferences</CardTitle>
          <CardDescription>
            Choose how you want each category delivered. Every category can go
            to your email, the in-app feed, an outgoing webhook, or any
            combination.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4" aria-busy={loading || undefined}>
          {loading ? (
            <div
              role="status"
              className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
            >
              Loading your saved notification preferences…
            </div>
          ) : loadError ? (
            <div
              ref={loadErrorRef}
              role="alert"
              tabIndex={-1}
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <p className="break-words [overflow-wrap:anywhere]">
                {loadError} Your saved choices were not replaced with defaults.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => {
                  setError(null);
                  setLoadRevision((revision) => revision + 1);
                }}
              >
                Retry preferences
              </Button>
            </div>
          ) : (
            <>
              <div
                role="region"
                aria-label="Notification preferences"
                tabIndex={0}
                className="overflow-x-auto rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th
                        scope="col"
                        className="sticky left-0 z-10 min-w-64 bg-muted px-3 py-2 text-left font-medium"
                      >
                        Category
                      </th>
                      {CHANNELS.map((ch) => (
                        <th
                          key={ch.key}
                          scope="col"
                          className="whitespace-nowrap px-3 py-2 font-medium"
                          title={ch.hint}
                        >
                          {ch.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {CATEGORIES.map((row) => (
                      <tr key={row.base} className="border-t">
                        <td className="sticky left-0 z-[1] max-w-md bg-background px-3 py-3 align-top">
                          <div className="font-medium">{row.label}</div>
                          <div className="text-xs text-muted-foreground mt-1">
                            {row.description}
                          </div>
                        </td>
                        {CHANNELS.map((ch) => {
                          const key = channelKey(ch.key, row.base);
                          return (
                            <td
                              key={ch.key}
                              className="px-3 py-3 text-center align-top"
                            >
                              <label className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md focus-within:ring-2 focus-within:ring-ring">
                                <Checkbox
                                  checked={prefs[key]}
                                  disabled={disabled}
                                  onChange={(e) =>
                                    toggle(key, e.target.checked)
                                  }
                                  aria-label={`${row.label} — ${ch.label}`}
                                />
                              </label>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                Webhook delivery only fires for checked categories once a URL is
                configured below.
              </p>

              {/* Webhook channel configuration (SETC-037). */}
              <div className="space-y-3 border-t pt-4">
                <div className="space-y-1">
                  <Label htmlFor="webhook-url">Notification webhook URL</Label>
                  <Input
                    id="webhook-url"
                    type="url"
                    inputMode="url"
                    placeholder="https://hooks.slack.com/services/…"
                    value={prefs.notification_webhook_url}
                    disabled={disabled}
                    aria-invalid={webhookUrlInvalid}
                    aria-describedby="webhook-url-help"
                    onChange={(e) =>
                      updatePrefs((p) => ({
                        ...p,
                        notification_webhook_url: e.target.value,
                      }))
                    }
                  />
                  <p
                    id="webhook-url-help"
                    className={
                      webhookUrlInvalid
                        ? "text-xs text-destructive"
                        : "text-xs text-muted-foreground"
                    }
                    role={webhookUrlInvalid ? "alert" : undefined}
                  >
                    {webhookUrlInvalid ? (
                      webhookUrlError
                    ) : (
                      <>
                        An https endpoint (Slack Incoming Webhook, or any
                        receiver). Private, reserved, and localhost addresses
                        are rejected. Leave blank to disable the webhook
                        channel.
                      </>
                    )}
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="webhook-kind">Webhook format</Label>
                  <Select
                    id="webhook-kind"
                    value={prefs.notification_webhook_kind}
                    disabled={disabled}
                    onChange={(e) =>
                      updatePrefs((p) => ({
                        ...p,
                        notification_webhook_kind: e.target
                          .value as WebhookKind,
                      }))
                    }
                  >
                    <option value="slack">Slack</option>
                    <option value="generic">Generic JSON</option>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Slack sends a{" "}
                    <code className="rounded bg-muted px-1">{`{ "text": … }`}</code>{" "}
                    body; Generic JSON adds an{" "}
                    <code className="rounded bg-muted px-1">event</code> field
                    for routing.
                  </p>
                </div>
                {anyWebhookChecked && webhookUrl === "" ? (
                  <p className="text-xs text-warning-emphasis" role="status">
                    You&apos;ve enabled webhook delivery for a category but no
                    URL is set — those notifications won&apos;t be sent until
                    you add one.
                  </p>
                ) : null}
              </div>

              <div className="space-y-2 border-t pt-4">
                <Label htmlFor="digest">Digest frequency</Label>
                <Select
                  id="digest"
                  value={prefs.digest_frequency}
                  disabled={disabled}
                  onChange={(e) =>
                    updatePrefs((p) => ({
                      ...p,
                      digest_frequency: e.target.value as Digest,
                    }))
                  }
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="never">Never</option>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Summary email of sends, opens, clicks and churn for your
                  workspace.
                </p>
              </div>

              {/* Usage/spend alert threshold (BILL-038). The channels for this
              category are chosen in the matrix above; this sets the trigger. */}
              <div className="space-y-2 border-t pt-4">
                <Label htmlFor="usage-threshold">Usage alert threshold</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="usage-threshold"
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    className="w-28 tabular-nums"
                    value={prefs.usage_alert_threshold_pct}
                    disabled={disabled}
                    aria-invalid={usageThresholdInvalid}
                    aria-describedby="usage-threshold-help"
                    onChange={(e) =>
                      updatePrefs((p) => ({
                        ...p,
                        usage_alert_threshold_pct: e.target.value,
                      }))
                    }
                  />
                  <span className="text-sm text-muted-foreground">
                    % of a plan limit (0 = off)
                  </span>
                </div>
                <p
                  id="usage-threshold-help"
                  className={
                    usageThresholdInvalid
                      ? "text-xs text-destructive"
                      : "text-xs text-muted-foreground"
                  }
                  role={usageThresholdInvalid ? "alert" : undefined}
                >
                  {usageThresholdInvalid ? (
                    "Enter a whole number from 0 to 100."
                  ) : (
                    <>
                      Warn when any plan resource (e.g. monthly sends) reaches
                      this share of its limit. Delivery follows the &ldquo;Usage
                      &amp; spend alerts&rdquo; row above.
                    </>
                  )}
                </p>
              </div>

              {/* Send a test notification (SETC-053). */}
              <div className="space-y-2 border-t pt-4">
                <div className="text-sm font-medium">Test delivery</div>
                <p className="text-xs text-muted-foreground">
                  Send a sample email to your own address to confirm
                  notifications reach your inbox.
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={sendingTest === "category"}
                    disabled={sendingTest !== null || disabled}
                    onClick={() => onSendTest("category")}
                  >
                    {sendingTest === "category"
                      ? "Sending…"
                      : "Send test notification"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={sendingTest === "digest"}
                    disabled={sendingTest !== null || disabled}
                    onClick={() => onSendTest("digest")}
                  >
                    {sendingTest === "digest" ? "Sending…" : "Send test digest"}
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {error ? (
        <div
          ref={actionErrorRef}
          role="alert"
          tabIndex={-1}
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring break-words [overflow-wrap:anywhere]"
        >
          {error}
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={onSave}
          loading={saving}
          disabled={
            disabled || !dirty || webhookUrlInvalid || usageThresholdInvalid
          }
        >
          {saving ? "Saving…" : "Save preferences"}
        </Button>
      </div>
    </div>
  );
}

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: { message?: string } } | undefined;
    return body?.error?.message ?? e.message ?? fallback;
  }
  return e instanceof Error ? e.message : fallback;
}

function validateWebhookUrl(value: string): string | null {
  if (value === "") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname === "") {
      return "Enter a valid URL that starts with https://";
    }
    if (url.username !== "" || url.password !== "") {
      return "Webhook URLs cannot include a username or password.";
    }
    return null;
  } catch {
    return "Enter a valid URL that starts with https://";
  }
}
