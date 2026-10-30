// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Archive custom domain — save the vanity host, verify its CNAME, copy the
 * DNS record, and remove the verification (desktop reference:
 * components/settings/ArchiveDomainSection.tsx).
 *
 * Two separate verbs, not one: clearing the domain is a SAVE with an empty
 * value (PUT tenant-settings), while removing the verification is a DELETE of
 * the verification row that leaves the saved host in place. A verification row
 * left behind keeps routing that host to this archive.
 *
 * Every hostname mutation passes through the shared custom-domain release
 * policy (lib/custom-domain-operational-availability.ts). While a verb is held
 * its control stays visible but disabled, with the policy's own sentence as
 * the reason; the transport refuses the request as well, so a held verb cannot
 * reach the network from any path. Reads and copying the DNS record are never
 * held.
 */

import { useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ShieldOff } from "lucide-react";

import { CopyTextButton } from "@/components/copy-text-button";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  domainNotRequested,
  getArchiveDomain,
  MAX_ARCHIVE_DOMAIN_LENGTH,
  removeArchiveDomainVerification,
  saveArchiveDomain,
  verifyArchiveDomain,
  type ArchiveDomain,
  type ArchiveSettings,
} from "@/lib/archive-admin-api";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import {
  CUSTOM_DOMAIN_REGISTRATION_AVAILABLE,
  CUSTOM_DOMAIN_RELEASE_HOLD_MESSAGE,
  CUSTOM_DOMAIN_REMOVAL_AVAILABLE,
  CUSTOM_DOMAIN_VERIFICATION_AVAILABLE,
} from "@/lib/custom-domain-operational-availability";
import { STALE } from "@/lib/query-keys";
import {
  EngagementLoading,
  EngagementQueryError,
} from "../_engagement/engagement-ui";

/** SSL issuance normally completes in under 90 seconds once DNS verifies. */
const SSL_POLL_MS = 10_000;

/**
 * The archive domain routes are mounted behind the admin scope
 * (archive.MountCustomDomainRoutes / MountTenantSettingsRoutes). A view-as
 * session is withheld: the effective role is what the workspace granted.
 */
export function canManageArchiveDomain(me: MeResponse): boolean {
  const role = effectiveAuthRole(me);
  return me.viewer_mode !== true && (role === "owner" || role === "admin");
}

function statusLabel(value: string): string {
  return value.replace(/_/gu, " ") || "Not reported";
}

function formatTimestamp(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

type Outcome = { tone: "success" | "warning"; text: string };

export function ArchiveDomainSection({
  me,
  queryBase,
}: {
  me: MeResponse;
  queryBase: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const domainKey = [...queryBase, "archive-domain"] as const;
  const settingsKey = [...queryBase, "settings"] as const;
  const inputId = useId();
  const holdId = useId();
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const domainQuery = useQuery({
    queryKey: domainKey,
    queryFn: ({ signal }) => getArchiveDomain(signal),
    staleTime: STALE.reference,
    // Follow certificate issuance without a manual refresh; stop as soon as
    // the edge reports anything other than "issuing".
    refetchInterval: (query) =>
      query.state.data?.ssl_status === "issuing" ? SSL_POLL_MS : false,
  });

  // `null` means "not edited": the input shows the saved host, so a refetch
  // that changes the saved value can never be mistaken for an operator edit.
  const [draft, setDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState<Outcome | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  const canManage = canManageArchiveDomain(me);
  const saved = domainQuery.data?.domain ?? "";
  const shown = draft ?? saved;
  const nextValue = shown.trim().toLowerCase();
  const dirty = draft !== null && nextValue !== saved.trim().toLowerCase();

  const saveOperationAvailable =
    saved.trim() !== "" && nextValue === ""
      ? CUSTOM_DOMAIN_REMOVAL_AVAILABLE
      : CUSTOM_DOMAIN_REGISTRATION_AVAILABLE;
  const hostnameEditable =
    CUSTOM_DOMAIN_REGISTRATION_AVAILABLE || CUSTOM_DOMAIN_REMOVAL_AVAILABLE;
  const anyHeld =
    !CUSTOM_DOMAIN_REGISTRATION_AVAILABLE ||
    !CUSTOM_DOMAIN_VERIFICATION_AVAILABLE ||
    !CUSTOM_DOMAIN_REMOVAL_AVAILABLE;

  const save = useMutation({
    mutationFn: (next: string) => saveArchiveDomain({ previous: saved, next }),
    onSuccess: (settings: ArchiveSettings) => {
      const host = settings.archive_domain;
      // The receipt is the write result. Reflect it locally, with the
      // verification state for the NEW host marked unknown (it is keyed by
      // domain server-side), then re-read as a separate concern.
      queryClient.setQueryData(settingsKey, settings);
      queryClient.setQueryData<ArchiveDomain>(domainKey, (current) =>
        current
          ? {
              ...current,
              domain: host,
              status: "",
              ssl_status: "",
              verification_token: "",
              last_checked_at: "",
              verified_at: "",
              last_error: "",
              ssl_last_error: "",
            }
          : current,
      );
      setDraft(null);
      setNotice({
        tone: "success",
        text: host
          ? `Archive domain saved as ${host}. Publish the CNAME record below, then verify it.`
          : "Archive domain cleared. The archive is served from its hosted address.",
      });
      void queryClient
        .invalidateQueries({ queryKey: domainKey })
        .catch(() => undefined);
    },
  });

  const verify = useMutation({
    mutationFn: () => verifyArchiveDomain(),
    onSuccess: (status: ArchiveDomain) => {
      queryClient.setQueryData(domainKey, status);
      setNotice(
        status.status === "verified"
          ? {
              tone: "success",
              text: `${status.domain} passed DNS verification. The certificate is issued separately and is shown below.`,
            }
          : {
              tone: "warning",
              text:
                status.last_error ||
                "The CNAME record was not found yet. Check the record at your DNS provider and verify again.",
            },
      );
    },
  });

  const busy = save.isPending || verify.isPending || removing;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || busy || !dirty || !saveOperationAvailable) return;
    setNotice(null);
    verify.reset();
    save.mutate(shown);
  }

  function onVerify() {
    if (!canManage || busy || !CUSTOM_DOMAIN_VERIFICATION_AVAILABLE) return;
    setNotice(null);
    save.reset();
    verify.mutate();
  }

  async function onConfirmRemove() {
    setRemoving(true);
    try {
      await removeArchiveDomainVerification();
    } catch (error: unknown) {
      throw new Error(
        apiErrorMessage(
          error,
          "The verification could not be removed. Nothing was assumed to have changed.",
        ),
      );
    } finally {
      setRemoving(false);
    }
    setNotice({
      tone: "success",
      text: "Verification removed. The host no longer routes to this archive; the CNAME at your DNS provider is untouched.",
    });
    void queryClient
      .invalidateQueries({ queryKey: domainKey })
      .catch(() => undefined);
  }

  if (domainQuery.isPending) {
    return <EngagementLoading label="Loading archive custom domain" />;
  }
  if (domainQuery.isError || !domainQuery.data) {
    return (
      <EngagementQueryError
        title="Archive domain could not be loaded"
        description="Domain setup and certificate readiness are unknown; pending is not being assumed."
        retrying={domainQuery.isFetching}
        onRetry={() => void domainQuery.refetch()}
      />
    );
  }

  const status = domainQuery.data;
  const requested = !domainNotRequested(status);
  const lastChecked = formatTimestamp(status.last_checked_at);
  const verifiedAt = formatTimestamp(status.verified_at);
  const mutationError = save.error ?? verify.error;

  return (
    <div className="space-y-4">
      {canManage ? (
        <form className="space-y-2" onSubmit={onSubmit} noValidate>
          <Label htmlFor={inputId}>Custom domain</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              ref={inputRef}
              id={inputId}
              value={shown}
              placeholder="news.example.com"
              maxLength={MAX_ARCHIVE_DOMAIN_LENGTH}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              inputMode="url"
              className="min-h-11 font-mono"
              disabled={busy || !hostnameEditable}
              aria-describedby={hostnameEditable ? undefined : holdId}
              onChange={(event) => setDraft(event.target.value.toLowerCase())}
            />
            <Button
              type="submit"
              className="min-h-11 shrink-0"
              loading={save.isPending}
              disabled={busy || !dirty || !saveOperationAvailable}
              aria-describedby={saveOperationAvailable ? undefined : holdId}
            >
              Save domain
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            A bare sub-domain such as news.example.com, with no scheme or path.
            Leave it blank and save to serve the archive from its hosted
            address.
          </p>
        </form>
      ) : (
        <p className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
          Only workspace owners and admins can change, verify, or remove the
          archive domain.
        </p>
      )}

      {!requested ? (
        <div className="rounded-lg border border-dashed bg-muted/20 p-4 text-sm">
          <p className="font-medium">No custom domain requested</p>
          <p className="mt-1 leading-relaxed text-muted-foreground">
            {status.cname_target
              ? `Point a CNAME at ${status.cname_target} when you are ready to use your own domain.`
              : "The archive remains on its default host. No CNAME target was returned."}
          </p>
        </div>
      ) : (
        <>
          <p className="break-all font-mono text-sm font-medium">
            {status.domain}
          </p>

          <div className="rounded-lg border bg-background/60 p-3">
            <p className="text-sm font-medium">DNS record</p>
            <p className="mt-1 text-xs text-muted-foreground">
              At your DNS provider, create a CNAME record:
            </p>
            <dl className="mt-3 space-y-2 text-sm">
              <DnsValue
                label="Host"
                value={status.domain}
                copyLabel="Copy host"
              />
              {status.cname_target ? (
                <DnsValue
                  label="Value (CNAME target)"
                  value={status.cname_target}
                  copyLabel="Copy target"
                />
              ) : (
                <div>
                  <dt className="text-xs text-muted-foreground">
                    Value (CNAME target)
                  </dt>
                  <dd className="mt-1 text-sm">
                    No CNAME target was returned by the server.
                  </dd>
                </div>
              )}
              {status.verification_token ? (
                <DnsValue
                  label={`TXT alternative at _postwave-verify.${status.domain}`}
                  value={`postwave-verify=${status.verification_token}`}
                  copyLabel="Copy TXT value"
                />
              ) : null}
            </dl>
          </div>

          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border bg-background/60 p-3">
              <dt className="text-xs text-muted-foreground">
                DNS verification
              </dt>
              <dd className="mt-1 break-words text-sm font-medium capitalize">
                {statusLabel(status.status)}
              </dd>
              {status.status === "verified" && verifiedAt ? (
                <dd className="mt-1 text-xs text-muted-foreground">
                  Verified {verifiedAt}
                </dd>
              ) : null}
              {status.status === "failed" && status.last_error ? (
                <dd className="mt-1 break-words text-xs text-destructive-emphasis">
                  {status.last_error}
                </dd>
              ) : null}
              {lastChecked ? (
                <dd className="mt-1 text-xs text-muted-foreground">
                  Last checked {lastChecked}
                </dd>
              ) : null}
            </div>
            <div className="rounded-lg border bg-background/60 p-3">
              <dt className="text-xs text-muted-foreground">Certificate</dt>
              <dd className="mt-1 break-words text-sm font-medium capitalize">
                {statusLabel(status.ssl_status)}
              </dd>
              {status.ssl_status === "issuing" ? (
                <dd className="mt-1 text-xs text-muted-foreground">
                  Checking again every {SSL_POLL_MS / 1000} seconds.
                </dd>
              ) : null}
              {status.ssl_status === "failed" && status.ssl_last_error ? (
                <dd className="mt-1 break-words text-xs text-destructive-emphasis">
                  {status.ssl_last_error}
                </dd>
              ) : null}
            </div>
          </dl>

          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                loading={verify.isPending}
                disabled={busy || !CUSTOM_DOMAIN_VERIFICATION_AVAILABLE}
                aria-describedby={
                  CUSTOM_DOMAIN_VERIFICATION_AVAILABLE ? undefined : holdId
                }
                onClick={onVerify}
              >
                <CheckCircle2 aria-hidden />
                {status.status === "verified" ? "Re-check DNS" : "Verify DNS"}
              </Button>
              <Button
                ref={removeButtonRef}
                type="button"
                variant="outline"
                className="min-h-11"
                loading={removing}
                disabled={busy || !CUSTOM_DOMAIN_REMOVAL_AVAILABLE}
                aria-describedby={
                  CUSTOM_DOMAIN_REMOVAL_AVAILABLE ? undefined : holdId
                }
                onClick={() => {
                  if (!busy && CUSTOM_DOMAIN_REMOVAL_AVAILABLE) {
                    setConfirmRemove(true);
                  }
                }}
              >
                <ShieldOff aria-hidden />
                Remove verification
              </Button>
            </div>
          ) : null}
        </>
      )}

      {canManage && anyHeld ? (
        <div
          id={holdId}
          role="note"
          className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm leading-relaxed"
        >
          <p className="font-medium">Some domain changes are release-held</p>
          <p className="mt-1 text-muted-foreground">
            {CUSTOM_DOMAIN_RELEASE_HOLD_MESSAGE}
          </p>
        </div>
      ) : null}

      {mutationError ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
        >
          {apiErrorMessage(
            mutationError,
            save.error
              ? "The archive domain could not be saved. Nothing was assumed to have changed."
              : "DNS verification could not be completed. The previous status is unchanged.",
          )}
        </div>
      ) : notice ? (
        <div
          role="status"
          className={
            notice.tone === "success"
              ? "flex items-start gap-2 rounded-lg border bg-muted/20 p-3 text-sm"
              : "flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm"
          }
        >
          {notice.tone === "success" ? (
            <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0" />
          ) : (
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          )}
          <span className="min-w-0 break-words">{notice.text}</span>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        returnFocusRef={removeButtonRef}
        fallbackFocusRef={inputRef}
        title="Remove custom-domain verification?"
        description={
          <>
            <strong>{status.domain}</strong> will stop routing to this archive
            immediately. The saved domain and the CNAME at your DNS provider
            are left in place, so you can verify again at any time.
          </>
        }
        confirmLabel="Remove verification"
        confirmVariant="destructive"
        onConfirm={onConfirmRemove}
      />
    </div>
  );
}

function DnsValue({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <dt className="break-all text-xs text-muted-foreground">{label}</dt>
        <dd className="mt-1 break-all font-mono text-sm">{value}</dd>
      </div>
      <CopyTextButton
        value={value}
        label={copyLabel}
        className="min-h-11 shrink-0 sm:min-h-9"
      />
    </div>
  );
}
