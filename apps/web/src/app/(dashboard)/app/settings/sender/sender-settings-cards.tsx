// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import type { RefObject } from "react";

import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import type { EmailComplianceProfileInput } from "@/lib/email-compliance-api";
import type {
  EmailSendingControl,
  SendingReadiness,
} from "@/lib/sending-controls-api";

import { Checkbox } from "@/components/ui/checkbox";
import {
  complianceFieldErrors,
  readinessItemHint,
  severityLabel,
  type EmailComplianceProfileDraft,
} from "./sender-settings-helpers";

function scrollToAnchor(id: string) {
  if (typeof document === "undefined") return;
  const target = document.getElementById(id);
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
  target?.focus({ preventScroll: true });
}

function RequiredMark() {
  return (
    <span className="text-destructive" aria-hidden="true">
      *
    </span>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-destructive" role="alert">
      {message}
    </p>
  );
}

export function EmailSendingSafetyCard({
  canWrite,
  control,
  actionRef,
  loading,
  loadError,
  onOpenPause,
  onResume,
  readOnly = false,
  readiness,
  savingControl,
}: {
  canWrite: boolean;
  control: EmailSendingControl | null;
  actionRef?: RefObject<HTMLButtonElement | null>;
  loading: boolean;
  loadError: string | null;
  onOpenPause: () => void;
  onResume: () => void;
  readOnly?: boolean;
  readiness: SendingReadiness | null;
  savingControl: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Email sending safety</CardTitle>
        <CardDescription>
          Tenant-level controls for pilot cutover, incident response, and warmup
          discipline.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex min-w-0 flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">Global email kill switch</span>
              {control ? (
                <Badge variant={control.paused ? "destructive" : "success"}>
                  {control.paused ? "Paused" : "Active"}
                </Badge>
              ) : (
                <Badge variant="secondary">Unknown</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              When paused, test sends, immediate sends, scheduled dispatch,
              queue sends, and queued-recipient drain are blocked.
            </p>
            {control?.paused && control.pause_reason ? (
              <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                Reason: {control.pause_reason}
              </p>
            ) : null}
          </div>
          {control?.paused ? (
            <Button
              ref={actionRef}
              type="button"
              onClick={onResume}
              loading={savingControl}
              disabled={savingControl || loading || readOnly || !canWrite}
            >
              Resume sends
            </Button>
          ) : (
            <Button
              ref={actionRef}
              type="button"
              variant="destructive"
              onClick={onOpenPause}
              disabled={
                savingControl || loading || readOnly || !control || !canWrite
              }
            >
              Pause sends
            </Button>
          )}
        </div>
        {!loading && !canWrite ? (
          <p className="text-xs text-muted-foreground">
            Email safety controls are read-only for your role.
          </p>
        ) : null}

        {readiness ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium">Production readiness</div>
              <Badge variant={readiness.ready ? "success" : "warning"}>
                {readiness.ready ? "Ready" : "Blocked"}
              </Badge>
            </div>
            <div className="space-y-2">
              {readiness.items.map((item) => {
                const hint = readinessItemHint(item);
                return (
                  <div
                    key={item.key}
                    className="flex min-w-0 items-start justify-between gap-3 rounded-md border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="break-words text-sm font-medium [overflow-wrap:anywhere]">
                        {item.label}
                      </div>
                      {item.detail ? (
                        <div className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                          {item.detail}
                        </div>
                      ) : null}
                      {/* Each unmet item now points at its fix (SETC-005). */}
                      {!item.complete ? (
                        hint.kind === "anchor" ? (
                          <button
                            type="button"
                            onClick={() => scrollToAnchor(hint.target)}
                            className="mt-1 inline-flex min-h-11 items-center text-xs font-medium text-primary underline underline-offset-2 sm:min-h-0"
                          >
                            {hint.label} ↓
                          </button>
                        ) : hint.kind === "link" ? (
                          <Link
                            href={hint.href as never}
                            className="mt-1 inline-flex min-h-11 items-center text-xs font-medium text-primary underline underline-offset-2 sm:min-h-0"
                          >
                            {hint.label}
                          </Link>
                        ) : (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {hint.text}
                          </div>
                        )
                      ) : null}
                    </div>
                    <Badge
                      variant={
                        item.complete
                          ? "success"
                          : item.severity === "blocker"
                            ? "destructive"
                            : "warning"
                      }
                    >
                      {item.complete ? "Done" : severityLabel(item.severity)}
                    </Badge>
                  </div>
                );
              })}
            </div>
            {readiness.warmup_started ? (
              <p className="text-xs text-muted-foreground">
                Warmup day {readiness.warmup_day ?? 0}:{" "}
                {readiness.todays_sent ?? 0}/{readiness.todays_cap ?? 0} sent
                today.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            {loadError
              ? "Could not load sending readiness."
              : "Loading sending readiness..."}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function FromIdentityCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>From identity</CardTitle>
        <CardDescription>
          From names and addresses are configured on each campaign, with
          optional variant overrides for A/B tests.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Your account login email is never presented as the campaign sender
          unless you explicitly enter it in that campaign&apos;s delivery
          settings. The compliance profile below separately controls production
          send eligibility.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/app/campaigns">Open campaigns</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export function ComplianceProfileCard({
  canWrite,
  complianceReady,
  loading,
  onProfileChange,
  onSave,
  profile,
  profileDirty,
  readOnly = false,
  savingProfile,
  unavailable = false,
}: {
  canWrite: boolean;
  complianceReady: boolean;
  loading: boolean;
  onProfileChange: (patch: Partial<EmailComplianceProfileInput>) => void;
  onSave: () => void;
  profile: EmailComplianceProfileDraft;
  profileDirty: boolean;
  readOnly?: boolean;
  savingProfile: boolean;
  unavailable?: boolean;
}) {
  const errors = loading || unavailable ? {} : complianceFieldErrors(profile);
  const hasErrors =
    Object.keys(errors).length > 0 ||
    !profile.list_unsubscribe_enabled ||
    !profile.one_click_unsubscribe_enabled;
  const disabled = loading || unavailable || readOnly || !canWrite;
  return (
    <Card
      id="compliance-profile"
      tabIndex={-1}
      className="scroll-mt-24 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-busy={loading || undefined}
    >
      <CardHeader>
        <CardTitle>Commercial email compliance profile</CardTitle>
        <CardDescription>
          Required for CAN-SPAM, GDPR/ePrivacy-ready sending, and one-click
          unsubscribe enforcement.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div
            role="status"
            className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
          >
            Loading the saved compliance profile…
          </div>
        ) : unavailable ? (
          <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
            The saved compliance profile is unavailable. Its fields stay hidden
            so unknown values cannot be overwritten; retry above.
          </div>
        ) : (
          <>
            {!complianceReady ? (
              <div className="rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-emphasis">
                Production sends are blocked until this profile is complete and
                a sender domain is verified.
              </div>
            ) : (
              <div className="rounded-md border border-success/30 bg-success-subtle p-3 text-sm text-success-emphasis">
                Sender compliance gate is ready for production sends.
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="legal-sender-name">
                Legal sender name <RequiredMark />
              </Label>
              <Input
                id="legal-sender-name"
                value={profile.legal_sender_name}
                onChange={(e) =>
                  onProfileChange({ legal_sender_name: e.target.value })
                }
                disabled={disabled}
                aria-invalid={Boolean(errors.legal_sender_name)}
                aria-describedby={
                  errors.legal_sender_name
                    ? "legal-sender-name-error"
                    : undefined
                }
              />
              <FieldError
                id="legal-sender-name-error"
                message={errors.legal_sender_name}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="compliance-email">
                Compliance contact email <RequiredMark />
              </Label>
              <Input
                id="compliance-email"
                type="email"
                value={profile.compliance_contact_email ?? ""}
                onChange={(e) =>
                  onProfileChange({ compliance_contact_email: e.target.value })
                }
                disabled={disabled}
                aria-invalid={Boolean(errors.compliance_contact_email)}
                aria-describedby={
                  errors.compliance_contact_email
                    ? "compliance-email-error"
                    : undefined
                }
              />
              <FieldError
                id="compliance-email-error"
                message={errors.compliance_contact_email}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="address-line1">
                  Physical address line 1 <RequiredMark />
                </Label>
                <Input
                  id="address-line1"
                  value={profile.physical_address_line1}
                  onChange={(e) =>
                    onProfileChange({ physical_address_line1: e.target.value })
                  }
                  disabled={disabled}
                  aria-invalid={Boolean(errors.physical_address_line1)}
                  aria-describedby={
                    errors.physical_address_line1
                      ? "address-line1-error"
                      : undefined
                  }
                />
                <FieldError
                  id="address-line1-error"
                  message={errors.physical_address_line1}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="address-line2">Physical address line 2</Label>
                <Input
                  id="address-line2"
                  value={profile.physical_address_line2}
                  onChange={(e) =>
                    onProfileChange({ physical_address_line2: e.target.value })
                  }
                  disabled={disabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="address-city">
                  City <RequiredMark />
                </Label>
                <Input
                  id="address-city"
                  value={profile.physical_address_city}
                  onChange={(e) =>
                    onProfileChange({ physical_address_city: e.target.value })
                  }
                  disabled={disabled}
                  aria-invalid={Boolean(errors.physical_address_city)}
                  aria-describedby={
                    errors.physical_address_city
                      ? "address-city-error"
                      : undefined
                  }
                />
                <FieldError
                  id="address-city-error"
                  message={errors.physical_address_city}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="address-region">State / region</Label>
                <Input
                  id="address-region"
                  value={profile.physical_address_region}
                  onChange={(e) =>
                    onProfileChange({ physical_address_region: e.target.value })
                  }
                  disabled={disabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="address-postal">Postal code</Label>
                <Input
                  id="address-postal"
                  value={profile.physical_address_postal_code}
                  onChange={(e) =>
                    onProfileChange({
                      physical_address_postal_code: e.target.value,
                    })
                  }
                  disabled={disabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="address-country">
                  Country <RequiredMark />
                </Label>
                <Input
                  id="address-country"
                  value={profile.physical_address_country}
                  onChange={(e) =>
                    onProfileChange({
                      physical_address_country: e.target.value.toUpperCase(),
                    })
                  }
                  disabled={disabled}
                  maxLength={2}
                  placeholder="US"
                  aria-invalid={Boolean(errors.physical_address_country)}
                  aria-describedby={
                    errors.physical_address_country
                      ? "address-country-error"
                      : undefined
                  }
                />
                <FieldError
                  id="address-country-error"
                  message={errors.physical_address_country}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="default-footer-text">
                Default compliance footer
              </Label>
              <Textarea
                id="default-footer-text"
                value={profile.default_footer_text}
                onChange={(e) =>
                  onProfileChange({ default_footer_text: e.target.value })
                }
                disabled={disabled}
                placeholder="Optional legal or contact copy for commercial email footers"
              />
              <p className="text-xs text-muted-foreground">
                Optional workspace footer copy stored with this compliance
                profile. Campaign-specific footer content can still add more
                context.
              </p>
            </div>
            <label className="flex min-h-11 items-start gap-3 rounded-md py-2 text-sm sm:min-h-0 sm:py-0">
              <Checkbox
                className="mt-1"
                checked={profile.list_unsubscribe_enabled}
                onChange={(e) =>
                  onProfileChange({
                    list_unsubscribe_enabled: e.target.checked,
                  })
                }
                disabled={disabled}
              />
              <span>
                Include List-Unsubscribe headers for every commercial email.
              </span>
            </label>
            {!profile.list_unsubscribe_enabled ? (
              <p className="text-xs text-destructive" role="alert">
                List-Unsubscribe headers must remain enabled for commercial
                sends.
              </p>
            ) : null}
            <label className="flex min-h-11 items-start gap-3 rounded-md py-2 text-sm sm:min-h-0 sm:py-0">
              <Checkbox
                className="mt-1"
                checked={profile.one_click_unsubscribe_enabled}
                onChange={(e) =>
                  onProfileChange({
                    one_click_unsubscribe_enabled: e.target.checked,
                  })
                }
                disabled={disabled}
              />
              <span>
                Enable RFC 8058 one-click unsubscribe for supported inboxes.
              </span>
            </label>
            {!profile.one_click_unsubscribe_enabled ? (
              <p className="text-xs text-destructive" role="alert">
                One-click unsubscribe must remain enabled for commercial sends.
              </p>
            ) : null}
            <div className="flex min-w-0 flex-col items-start gap-3 rounded-md border px-3 py-2 text-sm sm:flex-row sm:justify-between">
              <div className="min-w-0">
                <div className="font-medium">Sender domain verification</div>
                <p className="text-xs text-muted-foreground">
                  Managed by SPF, DKIM, and DMARC checks. This server-computed
                  gate cannot be self-certified from this form.
                </p>
              </div>
              <Badge
                variant={profile.verified_sender_domain ? "success" : "warning"}
              >
                {profile.verified_sender_domain ? "Verified" : "Not verified"}
              </Badge>
            </div>
            {!loading && !canWrite ? (
              <p className="text-xs text-muted-foreground">
                The compliance profile is read-only for your role.
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={onSave}
                loading={savingProfile}
                disabled={disabled || !profileDirty || hasErrors}
              >
                {savingProfile ? "Saving..." : "Save compliance profile"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
