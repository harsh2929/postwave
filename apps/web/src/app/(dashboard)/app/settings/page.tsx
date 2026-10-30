// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import Link from "next/link";
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
import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";
import { ApiError } from "@/lib/api";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { formatDateWithToken } from "@/lib/date-format-preview";
import { isValidHexColor, normalizeHexColor } from "@/lib/hex-color";
import { newUUIDv7 } from "@/lib/http-fetch";
import { STALE } from "@/lib/query-keys";
import { isKnownTimeZone, listTimeZones } from "@/lib/timezones";
import { useOnline } from "@/lib/use-online";
import {
  workspaceSettingsApi,
  type WorkspaceSettings,
  type WorkspaceSettingsPatch,
} from "@/lib/workspace-settings-api";
import { requestDashboardTourReplay } from "@/components/tour/dashboard-tour-events";
import { useSettingsQueryKey } from "./security/settings-query-key";
import {
  classifyLogoPreview,
  configuredAssetsOrigin,
  logoPreviewBlockedMessage,
} from "./logo-url-policy";

const DATE_FORMATS = ["YYYY-MM-DD", "MMM D, YYYY", "D MMM YYYY", "MM/DD/YYYY"];

interface FormState {
  name: string;
  timezone: string;
  dateFormat: string;
  replyTo: string;
  brandColor: string;
  logoUrl: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  timezone: "UTC",
  dateFormat: "MMM D, YYYY",
  replyTo: "",
  brandColor: "",
  logoUrl: "",
};

function formsEqual(a: FormState, b: FormState): boolean {
  return (
    a.name === b.name &&
    a.timezone === b.timezone &&
    a.dateFormat === b.dateFormat &&
    a.replyTo === b.replyTo &&
    a.brandColor === b.brandColor &&
    a.logoUrl === b.logoUrl
  );
}

export default function GeneralSettingsPage() {
  const queryClient = useQueryClient();
  const online = useOnline();
  const {
    queryKey,
    enabled,
    identityLoading,
    identityError,
    identity,
    canAdmin,
    authorityKey,
    retryIdentity,
    retryingIdentity,
  } = useSettingsQueryKey("general", { adminOnly: true });
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [baseline, setBaseline] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logoBroken, setLogoBroken] = useState(false);
  const saveRef = useRef(false);
  const saveControllerRef = useRef<AbortController | null>(null);
  const authorityKeyRef = useRef(authorityKey);
  authorityKeyRef.current = authorityKey;

  const settingsQuery = useQuery({
    queryKey,
    enabled,
    staleTime: STALE.detail,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const loaded = await workspaceSettingsApi.get({ signal });
      if (!identity || loaded.tenant_id !== identity.tenant_id) {
        throw new Error(
          "Workspace-settings response did not match the verified workspace.",
        );
      }
      return loaded;
    },
  });

  // The dashboard CSP decides whether this preview can even be attempted.
  // Rendering an <img> the policy will refuse produced a console violation, a
  // /api/csp-report POST, and an error message blaming the operator's URL.
  // Both of this page's client-only inputs are resolved AFTER mount, not during
  // render. Reading `window.location.origin` or constructing `new Date()` while
  // rendering makes the server and the browser produce different HTML, and React
  // reported exactly that on this route ("some attributes of the server rendered
  // HTML didn't match the client properties"). The server has no origin and its
  // clock is not the user's, so first paint must not depend on either.
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => setOrigin(window.location.origin), []);

  const logoVerdict = useMemo(
    () => classifyLogoPreview(form.logoUrl, origin),
    [form.logoUrl, origin],
  );
  const logoNotice =
    logoVerdict.kind === "blocked"
      ? logoPreviewBlockedMessage(logoVerdict)
      : logoVerdict.kind === "invalid"
        ? "That doesn't look like an image URL — it should start with https://."
        : logoVerdict.kind === "allowed" && logoBroken
          ? "That logo URL didn't load — check it resolves to an image."
          : null;

  const assetsOriginHint = useMemo(
    () => configuredAssetsOrigin() ?? "https://assets.example.com",
    [],
  );

  const timeZones = useMemo(() => listTimeZones(), []);
  // null until mounted — see the note above `origin`. The date-format preview is
  // the only consumer, and it degrades to the bare format token for one frame.
  const [today, setToday] = useState<Date | null>(null);
  useEffect(() => setToday(new Date()), []);
  const dirty = baseline ? !formsEqual(form, baseline) : false;
  const loading =
    identityLoading || (settingsQuery.isPending && !settingsQuery.data);
  const formUnavailable =
    loading ||
    saving ||
    !canAdmin ||
    baseline === null ||
    settingsQuery.isError;
  // Latest form, readable after an await. Every edit spreads into a fresh
  // object, so reference identity says whether the operator typed while the
  // PATCH was open — the fields stay enabled during a save, so they can.
  const formRef = useRef(form);
  useEffect(() => {
    formRef.current = form;
  }, [form]);
  useUnsavedChangesGuard(dirty && canAdmin);

  const brandColorInvalid =
    form.brandColor.trim() !== "" && !isValidHexColor(form.brandColor);
  const timezoneInvalid = !isKnownTimeZone(form.timezone);
  const replyToInvalid =
    form.replyTo.trim() !== "" &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.replyTo.trim());
  const logoInputError = validateLogoSettingUrl(form.logoUrl);
  const swatch = normalizeHexColor(form.brandColor);

  const patch = (next: Partial<FormState>) =>
    setForm((cur) => ({ ...cur, ...next }));

  useEffect(() => {
    saveControllerRef.current?.abort();
    saveControllerRef.current = null;
    saveRef.current = false;
    setSaving(false);
    setError(null);
    setLogoBroken(false);
    setForm(EMPTY_FORM);
    setBaseline(null);
    return () => saveControllerRef.current?.abort();
  }, [authorityKey]);

  useEffect(() => {
    if (!settingsQuery.data || !identity || dirty) return;
    const loaded = workspaceForm(settingsQuery.data);
    setForm(loaded);
    setBaseline(loaded);
  }, [dirty, identity, settingsQuery.data]);

  const onSave = async () => {
    // The disabled button is presentation; this guard is the data-safety
    // boundary if a synthetic click or future refactor bypasses it.
    if (
      loading ||
      saveRef.current ||
      baseline === null ||
      !identity ||
      !canAdmin ||
      settingsQuery.isError
    )
      return;
    if (online === "offline") {
      setError("Reconnect before saving workspace settings.");
      return;
    }
    if (brandColorInvalid) {
      setError("Brand color must be a six-digit hex (e.g. #3b82f6).");
      return;
    }
    if (timezoneInvalid) {
      setError("Choose a valid timezone from the list.");
      return;
    }
    if (replyToInvalid) {
      setError("Reply-to address must look like a valid email address.");
      return;
    }
    if (logoInputError) {
      setError(logoInputError);
      return;
    }
    const sent = form;
    const openedAuthorityKey = authorityKey;
    const intent: WorkspaceSettingsPatch = Object.freeze({
      display_name: form.name.trim(),
      timezone: form.timezone,
      date_format: form.dateFormat,
      // Empty strings explicitly clear nullable defaults; PATCH sends the
      // complete intended state (no sparse leave-unchanged surprises).
      default_reply_to: form.replyTo.trim(),
      brand_color: form.brandColor.trim(),
      logo_url: form.logoUrl.trim(),
    });
    const controller = new AbortController();
    saveRef.current = true;
    saveControllerRef.current = controller;
    setSaving(true);
    setError(null);
    try {
      await queryClient.cancelQueries({ queryKey, exact: true });
      await verifyFreshAdminAuthority(identity, controller.signal);
      if (authorityKeyRef.current !== openedAuthorityKey) return;
      const updated = await workspaceSettingsApi.patch(intent, {
        signal: controller.signal,
        idempotencyKey: newUUIDv7(),
      });
      if (updated.tenant_id !== identity.tenant_id) {
        throw new Error(
          "Workspace-settings write receipt did not match the verified workspace.",
        );
      }
      let readback: WorkspaceSettings | null = null;
      try {
        const candidate = await workspaceSettingsApi.get({
          signal: controller.signal,
        });
        if (candidate.tenant_id === identity.tenant_id) readback = candidate;
      } catch {
        // The PATCH receipt remains the best known state; report readback
        // uncertainty separately rather than claiming the write failed.
      }
      if (authorityKeyRef.current !== openedAuthorityKey) return;
      const resolved = readback ?? updated;
      const saved = workspaceForm(resolved);
      // Adopt the server's normalized copy only if nothing was typed while
      // the request was open; otherwise those newer edits reverted under the
      // operator. The baseline still moves to what the server now holds, so
      // `dirty` stays correctly armed for them.
      if (formRef.current === sent) {
        setForm(saved);
        setLogoBroken(false);
      }
      setBaseline(saved);
      queryClient.setQueryData(queryKey, resolved);
      toast.success("Workspace settings saved.");
      if (!readback || !workspacePatchMatches(intent, readback)) {
        void queryClient.invalidateQueries({ queryKey, exact: true });
        toast.warning(
          "The workspace settings write was accepted, but its live readback could not be reconciled. Refresh before relying on the displayed values.",
        );
      }
    } catch (e) {
      if (
        controller.signal.aborted ||
        authorityKeyRef.current !== openedAuthorityKey
      )
        return;
      const msg = errorMessage(e, "Could not save workspace settings.");
      setError(msg);
      toast.error(msg);
    } finally {
      if (saveControllerRef.current === controller) {
        saveControllerRef.current = null;
        saveRef.current = false;
        setSaving(false);
      }
    }
  };

  if (identityError) {
    return (
      <SettingsAccessState
        message="Workspace settings access could not be verified. No settings data was requested."
        retrying={retryingIdentity}
        onRetry={retryIdentity}
      />
    );
  }

  if (!identityLoading && !canAdmin) {
    return (
      <SettingsAccessState message="Workspace settings require an owner or administrator role and are unavailable in viewer mode." />
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <Card data-tour="dashboard-workspace-settings">
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
          <CardDescription>
            Name shown in dashboards and emails.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ws-name">Workspace name</Label>
            <Input
              id="ws-name"
              value={form.name}
              maxLength={512}
              onChange={(e) => patch({ name: e.target.value })}
              disabled={formUnavailable}
            />
          </div>
          <div className="space-y-2">
            <Label>Logo</Label>
            <div className="flex items-center gap-3">
              {logoVerdict.kind === "allowed" && !logoBroken ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={form.logoUrl.trim()}
                  alt="Workspace logo preview"
                  className="h-12 w-12 rounded-md border object-cover"
                  onError={() => setLogoBroken(true)}
                  onLoad={() => setLogoBroken(false)}
                />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted text-sm text-muted-foreground">
                  {initialsFor(form.name)}
                </div>
              )}
              <p className="flex-1 text-xs text-muted-foreground">
                {logoNotice ??
                  "Initials from the workspace name are used until you set a logo URL below."}
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ws-logo-url">Logo URL (optional)</Label>
            {/* The placeholder names the asset host when one is configured:
                the old "your own CDN" example is precisely the URL the
                dashboard CSP refuses to render. */}
            <Input
              id="ws-logo-url"
              value={form.logoUrl}
              maxLength={2_048}
              onChange={(e) => {
                setLogoBroken(false);
                patch({ logoUrl: e.target.value });
              }}
              placeholder={`${assetsOriginHint}/logo.png`}
              disabled={formUnavailable}
              aria-invalid={Boolean(logoInputError)}
              aria-describedby={
                logoInputError ? "ws-logo-url-error" : undefined
              }
            />
            {logoInputError ? (
              <p
                id="ws-logo-url-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {logoInputError}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="ws-brand">Brand color</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="Brand color picker"
                value={swatch ?? "#000000"}
                onChange={(e) => patch({ brandColor: e.target.value })}
                disabled={formUnavailable}
                className="h-9 w-12 cursor-pointer rounded-md border bg-background p-1"
              />
              <Input
                id="ws-brand"
                value={form.brandColor}
                onChange={(e) => patch({ brandColor: e.target.value })}
                placeholder="#3b82f6"
                disabled={formUnavailable}
                aria-invalid={brandColorInvalid}
                className="font-mono"
              />
            </div>
            {brandColorInvalid ? (
              <p className="text-xs text-destructive" role="alert">
                Enter a six-digit hex, e.g. <code>#3b82f6</code>.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Six-digit hex (e.g. <code>#3b82f6</code>). Use the swatch to
                pick.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Locale</CardTitle>
          <CardDescription>
            Defaults applied to scheduled sends and analytics.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tz">Timezone</Label>
            <Input
              id="tz"
              list="tz-options"
              value={form.timezone}
              onChange={(e) => patch({ timezone: e.target.value })}
              disabled={formUnavailable}
              aria-invalid={timezoneInvalid}
              placeholder="Search e.g. America/Chicago"
            />
            <datalist id="tz-options">
              {timeZones.map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
            {timezoneInvalid ? (
              <p className="text-xs text-destructive" role="alert">
                Pick a valid IANA timezone from the list.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Full IANA list — start typing to search any zone.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="df">Date format</Label>
            <select
              id="df"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={form.dateFormat}
              onChange={(e) => patch({ dateFormat: e.target.value })}
              disabled={formUnavailable}
            >
              {DATE_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {today ? `${f} — ${formatDateWithToken(f, today)}` : f}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {today ? (
                <>
                  Today looks like{" "}
                  <span className="font-medium text-foreground">
                    {formatDateWithToken(form.dateFormat, today)}
                  </span>{" "}
                  in this format.
                </>
              ) : (
                <>Each option shows how today&rsquo;s date will look.</>
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Default reply-to</CardTitle>
          <CardDescription>
            Used for campaigns that don&apos;t override it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reply-to">Reply-to address</Label>
            <Input
              id="reply-to"
              type="email"
              value={form.replyTo}
              maxLength={320}
              onChange={(e) => patch({ replyTo: e.target.value })}
              disabled={formUnavailable}
              aria-invalid={replyToInvalid}
              aria-describedby={replyToInvalid ? "reply-to-error" : undefined}
            />
            {replyToInvalid ? (
              <p
                id="reply-to-error"
                role="alert"
                className="text-xs text-destructive"
              >
                Enter a valid email address or leave the field blank.
              </p>
            ) : null}
          </div>
          <div className="pt-3 border-t flex items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              Want a refresher on the dashboard? The product tour walks through
              the major surfaces in under two minutes.
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-tour="dashboard-settings-replay"
              onClick={requestDashboardTourReplay}
            >
              Replay tour
            </Button>
          </div>
        </CardContent>
      </Card>

      {settingsQuery.isError ? (
        <div
          role="alert"
          className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
        >
          <p>
            {errorMessage(
              settingsQuery.error,
              "Could not load workspace settings. The form remains locked because it has no authoritative baseline.",
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={settingsQuery.isFetching || online === "offline"}
            onClick={() => void settingsQuery.refetch()}
          >
            {settingsQuery.isFetching
              ? "Retrying…"
              : "Retry workspace settings"}
          </Button>
        </div>
      ) : null}

      {online === "offline" ? (
        <p role="note" className="text-sm text-muted-foreground">
          Reconnect to load or change workspace settings. Administration writes
          are never queued for later replay.
        </p>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
        >
          {error}
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={onSave}
          disabled={
            saving ||
            formUnavailable ||
            !dirty ||
            brandColorInvalid ||
            timezoneInvalid ||
            replyToInvalid ||
            Boolean(logoInputError)
          }
        >
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>

      {/* SETC-054: consolidated workspace danger zone. Rename is the Workspace
          card above; export + deletion run from Privacy & data (kept there so
          the reauth/MFA/typed-confirm flows aren't duplicated). */}
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>
            Irreversible, workspace-wide actions.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/app/settings/privacy">Export all workspace data</Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className="border-destructive/40 text-destructive"
          >
            <Link href="/app/settings/privacy">Delete workspace…</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function initialsFor(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return value.slice(0, 2).toUpperCase() || "PW";
}

function workspaceForm(settings: WorkspaceSettings): FormState {
  return {
    name: settings.display_name ?? "",
    replyTo: settings.default_reply_to ?? "",
    timezone: settings.timezone || "UTC",
    dateFormat: settings.date_format || "MMM D, YYYY",
    brandColor: settings.brand_color ?? "",
    logoUrl: settings.logo_url ?? "",
  };
}

function workspacePatchMatches(
  expected: WorkspaceSettingsPatch,
  actual: WorkspaceSettings,
): boolean {
  return (
    (actual.display_name ?? "").trim() === expected.display_name &&
    actual.timezone === expected.timezone &&
    actual.date_format === expected.date_format &&
    (actual.default_reply_to ?? "").trim() === expected.default_reply_to &&
    (actual.brand_color ?? "").trim().toLowerCase() ===
      expected.brand_color?.toLowerCase() &&
    (actual.logo_url ?? "").trim() === expected.logo_url
  );
}

function SettingsAccessState({
  message,
  retrying = false,
  onRetry,
}: {
  message: string;
  retrying?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div className="max-w-2xl">
      <Card>
        <CardContent className="space-y-3 p-5">
          <p
            role={onRetry ? "alert" : "note"}
            className="text-sm text-muted-foreground"
          >
            {message}
          </p>
          {onRetry ? (
            <Button
              type="button"
              variant="outline"
              loading={retrying}
              onClick={onRetry}
            >
              {retrying ? "Retrying…" : "Retry identity"}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function validateLogoSettingUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (raw.length > 2_048) return "Logo URL must be 2,048 characters or fewer.";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "Logo URL must be a valid absolute URL.";
  }
  if (parsed.username || parsed.password) {
    return "Logo URL must not contain embedded credentials.";
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host.endsWith(".localhost");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    return "Logo URL must use HTTPS (HTTP is allowed only for localhost development).";
  }
  if (
    /^(?:0\.0\.0\.0|127\.|169\.254\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(
      host,
    ) ||
    host === "::" ||
    host === "::1" ||
    host.startsWith("fe80:")
  ) {
    return "Logo URL must not point at a private, loopback, or metadata address.";
  }
  return null;
}

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: { message?: string } } | undefined;
    const publicMessage = body?.error?.message?.trim();
    if (publicMessage) return publicMessage;
    if (body?.error) return fallback;
    return e.message.trim() || fallback;
  }
  return e instanceof Error ? e.message.trim() || fallback : fallback;
}
