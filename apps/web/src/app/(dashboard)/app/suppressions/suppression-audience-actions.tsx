// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import { newUUIDv7 } from "@/lib/http-fetch";
import {
  MAX_SELECTED_SUPPRESSION_REASON_CHANGES,
  SUPPRESSION_MIRROR_PROVIDERS,
  SUPPRESSION_RECLASSIFICATION_REASONS,
  SuppressionAdminContractError,
  changeSelectedSuppressionReason,
  mirrorSuppressionsFromProvider,
  selectedSuppressionTargets,
  type SelectedSuppressionTarget,
  type SuppressionEntry,
  type SuppressionMirrorProvider,
  type SuppressionMirrorResult,
  type SuppressionReason,
  type SuppressionReasonMutationResult,
} from "@/lib/suppressions-admin-api";
import { reasonLabel } from "@/lib/suppression-reasons";
import {
  reauthorizeSubscriberMutation,
  SubscriberAuthorityError,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";

const PROVIDER_DETAILS: Record<
  SuppressionMirrorProvider,
  { label: string; description: string; setup: string }
> = {
  ses: {
    label: "Amazon SES",
    description: "Pulls the account-level SES suppression list.",
    setup:
      "Configure the AWS credential chain and region for this Moosewave deployment, then retry.",
  },
  mailgun: {
    label: "Mailgun",
    description:
      "Pulls bounces, complaints, and unsubscribes for the configured sending domain.",
    setup:
      "Configure the Mailgun credential and sending domain in Deliverability, then retry.",
  },
  postmark: {
    label: "Postmark",
    description: "Pulls Postmark's suppression and bounce records.",
    setup:
      "Configure the Postmark server credential in Deliverability, then retry.",
  },
  mailchimp: {
    label: "Mailchimp",
    description: "Pulls unsubscribed and cleaned audience members.",
    setup:
      "Configure the Mailchimp credential and audience in Deliverability, then retry.",
  },
  sendgrid: {
    label: "SendGrid",
    description: "Pulls bounces, blocks, spam reports, and unsubscribes.",
    setup: "Configure the SendGrid credential in Deliverability, then retry.",
  },
};

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function operationError(error: unknown): string {
  if (error instanceof SuppressionAdminContractError) return error.message;
  if (error instanceof SubscriberAuthorityError) return error.message;
  return apiErrorMessage(error, "The suppression operation failed.");
}

function authorityFingerprint(authority: SubscriberAuthority): string {
  return `${authority.tenantId}:${authority.userId}:${authority.role}`;
}

function selectedScopeKey(
  entries: readonly Pick<SuppressionEntry, "id" | "email">[],
): string {
  return entries
    .map((entry, index) => {
      if (typeof entry.id !== "string" || typeof entry.email !== "string") {
        return `invalid:${index}`;
      }
      return `${entry.id.trim().toLowerCase()}:${entry.email.trim().toLowerCase()}`;
    })
    .sort()
    .join("|");
}

function stableAttempt(
  ref: MutableRefObject<{ fingerprint: string; key: string } | null>,
  fingerprint: string,
): string {
  if (ref.current?.fingerprint !== fingerprint) {
    ref.current = { fingerprint, key: newUUIDv7() };
  }
  return ref.current.key;
}

export function SuppressionProviderMirrorAction({
  authority,
  onChanged,
}: {
  authority: SubscriberAuthority | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] =
    useState<SuppressionMirrorProvider>("mailchimp");
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SuppressionMirrorResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const attemptRef = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  if (!authority) return null;

  const expectedConfirmation = `SYNC ${provider.toUpperCase()}`;
  const resetReview = (): void => {
    setAcknowledged(false);
    setConfirmation("");
    setError(null);
    setResult(null);
    attemptRef.current = null;
  };
  const close = (): void => {
    if (pending) return;
    abortRef.current?.abort();
    abortRef.current = null;
    setOpen(false);
    resetReview();
  };

  const runMirror = async (): Promise<void> => {
    if (
      pending ||
      !acknowledged ||
      confirmation.trim() !== expectedConfirmation
    ) {
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setPending(true);
    setError(null);
    setResult(null);
    let responseReceived = false;
    try {
      await reauthorizeSubscriberMutation(authority, controller.signal);
      const fingerprint = `${authorityFingerprint(authority)}:${provider}`;
      const response = await mirrorSuppressionsFromProvider(provider, {
        idempotencyKey: stableAttempt(attemptRef, fingerprint),
        signal: controller.signal,
      });
      responseReceived = true;
      if (!response.not_configured && response.fetched > 0) onChanged();
      await reauthorizeSubscriberMutation(authority, controller.signal);
      setResult(response);
      setAcknowledged(false);
      setConfirmation("");
      attemptRef.current = null;
    } catch (caught) {
      if (isAbortError(caught)) return;
      setError(
        responseReceived
          ? "The provider response was received, but your workspace access changed before it could be confirmed. The list was refreshed; review it before retrying."
          : operationError(caught),
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setPending(false);
    }
  };

  const providerDetails = PROVIDER_DETAILS[provider];
  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          resetReview();
          setOpen(true);
        }}
      >
        <RefreshCw className="h-4 w-4" />
        Sync provider
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => (!next ? close() : undefined)}
      >
        <DialogContent
          closeDisabled={pending}
          aria-busy={pending || undefined}
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (pending) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Sync suppressions from provider</DialogTitle>
            <DialogDescription>
              Pull the provider&apos;s bounded recent suppression window into
              this workspace. Existing source events are deduplicated.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="suppression-mirror-provider">Provider</Label>
            <Select
              id="suppression-mirror-provider"
              value={provider}
              disabled={pending}
              onChange={(event) => {
                setProvider(event.target.value as SuppressionMirrorProvider);
                resetReview();
              }}
            >
              {SUPPRESSION_MIRROR_PROVIDERS.map((item) => (
                <option key={item} value={item}>
                  {PROVIDER_DETAILS[item].label}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">
              {providerDetails.description} Credentials remain server-side and
              are never returned to this page.
            </p>
          </div>

          {result?.not_configured ? (
            <div
              role="status"
              className="rounded-md border bg-muted/40 p-3 text-sm"
            >
              <p className="font-medium">
                {providerDetails.label} is not configured for this workspace.
              </p>
              <p className="mt-1 text-muted-foreground">
                {providerDetails.setup}
              </p>
            </div>
          ) : result ? (
            <div
              role={result.errors > 0 ? "alert" : "status"}
              className="rounded-md border bg-muted/40 p-3 text-sm"
            >
              <p className="font-medium">Provider sync completed.</p>
              <p className="mt-1 text-muted-foreground">
                {result.fetched.toLocaleString()} fetched ·{" "}
                {result.imported.toLocaleString()} imported ·{" "}
                {result.skipped.toLocaleString()} already present ·{" "}
                {result.errors.toLocaleString()} failed.
              </p>
              {result.errors > 0 ? (
                <p className="mt-2 text-destructive-emphasis">
                  The provider route reports aggregate failures only. Review the
                  suppression list before relying on this sync as complete.
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
                <Checkbox
                  checked={acknowledged}
                  disabled={pending}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  aria-label="Confirm provider sync review"
                />
                <span>
                  I reviewed the provider and understand this can add new
                  campaign-blocking suppression rows.
                </span>
              </label>
              <div className="space-y-2">
                <Label htmlFor="suppression-mirror-confirmation">
                  Type {expectedConfirmation} to confirm
                </Label>
                <Input
                  id="suppression-mirror-confirmation"
                  value={confirmation}
                  disabled={pending}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </div>
            </>
          )}

          {error ? (
            <div role="alert" className="text-sm text-destructive-emphasis">
              {error}
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={pending}
            >
              {result ? "Close" : "Cancel"}
            </Button>
            {!result ? (
              <Button
                type="button"
                onClick={() => void runMirror()}
                disabled={
                  pending ||
                  !acknowledged ||
                  confirmation.trim() !== expectedConfirmation
                }
              >
                {pending ? "Syncing…" : `Sync ${providerDetails.label}`}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function SuppressionBulkReasonAction({
  selected,
  authority,
  onChanged,
  onClear,
}: {
  selected: SuppressionEntry[];
  authority: SubscriberAuthority | null;
  onChanged: () => void;
  onClear: () => void;
}) {
  const currentScopeKey = selectedScopeKey(selected);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<SelectedSuppressionTarget[]>([]);
  const [scopeKey, setScopeKey] = useState("");
  const [reason, setReason] = useState<SuppressionReason>("manual_unsubscribe");
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SuppressionReasonMutationResult | null>(
    null,
  );
  const abortRef = useRef<AbortController | null>(null);
  const attemptRef = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (!open || scopeKey === currentScopeKey) return;
    abortRef.current?.abort();
    abortRef.current = null;
    attemptRef.current = null;
    setPending(false);
    setOpen(false);
    setScope([]);
    setScopeKey("");
    setError(null);
    setResult(null);
  }, [currentScopeKey, open, scopeKey]);

  const priorReasons = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of scope) {
      const prior = entry.reason || "unknown";
      counts.set(prior, (counts.get(prior) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
  }, [scope]);

  if (!authority || selected.length === 0) return null;

  const expectedConfirmation = `CHANGE ${scope.length}`;
  const alreadyTarget = scope.filter((entry) => entry.reason === reason).length;
  const allAlreadyTarget = scope.length > 0 && alreadyTarget === scope.length;

  const reset = (): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    attemptRef.current = null;
    setOpen(false);
    setScope([]);
    setScopeKey("");
    setAcknowledged(false);
    setConfirmation("");
    setPending(false);
    setError(null);
    setResult(null);
  };

  const openReview = (): void => {
    try {
      const frozen = selectedSuppressionTargets(selected);
      setScope(frozen);
      setScopeKey(currentScopeKey);
      setAcknowledged(false);
      setConfirmation("");
      setError(null);
      setResult(null);
      attemptRef.current = null;
      setOpen(true);
    } catch (caught) {
      setScope([]);
      setScopeKey(currentScopeKey);
      setError(operationError(caught));
      setOpen(true);
    }
  };

  const runChange = async (): Promise<void> => {
    if (
      pending ||
      scope.length === 0 ||
      allAlreadyTarget ||
      !acknowledged ||
      confirmation.trim() !== expectedConfirmation
    ) {
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setPending(true);
    setError(null);
    setResult(null);
    let responseReceived = false;
    try {
      await reauthorizeSubscriberMutation(authority, controller.signal);
      const frozenEvidence = scope
        .map((entry) => `${entry.id}:${entry.email}:${entry.reason ?? ""}`)
        .sort()
        .join("|");
      const fingerprint = `${authorityFingerprint(authority)}:${reason}:${frozenEvidence}`;
      const response = await changeSelectedSuppressionReason(scope, reason, {
        idempotencyKey: stableAttempt(attemptRef, fingerprint),
        signal: controller.signal,
      });
      responseReceived = true;
      if (response.updated > 0) onChanged();
      await reauthorizeSubscriberMutation(authority, controller.signal);
      setResult(response);
      setAcknowledged(false);
      setConfirmation("");
      attemptRef.current = null;
    } catch (caught) {
      if (isAbortError(caught)) return;
      setError(
        responseReceived
          ? "The server returned a result, but your workspace access changed before it could be confirmed. The list was refreshed; review it before retrying."
          : operationError(caught),
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setPending(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={openReview}
        disabled={selected.length > MAX_SELECTED_SUPPRESSION_REASON_CHANGES}
      >
        Change reason
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => (!next ? reset() : undefined)}
      >
        <DialogContent
          closeDisabled={pending}
          aria-busy={pending || undefined}
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (pending) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Change selected suppression reasons</DialogTitle>
            <DialogDescription>
              The mutation is locked to the {scope.length.toLocaleString()}{" "}
              reviewed canonical row ID{scope.length === 1 ? "" : "s"}. The
              server keeps every prior reason in the suppression audit trail.
            </DialogDescription>
          </DialogHeader>

          {scope.length > 0 ? (
            <>
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                <p className="font-medium">Reviewed prior reasons</p>
                <ul className="mt-1 space-y-1 text-muted-foreground">
                  {priorReasons.map(([prior, count]) => (
                    <li key={prior}>
                      {reasonLabel(prior)}: {count.toLocaleString()}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-2">
                <Label htmlFor="selected-suppression-reason">New reason</Label>
                <Select
                  id="selected-suppression-reason"
                  value={reason}
                  disabled={pending || Boolean(result)}
                  onChange={(event) => {
                    setReason(event.target.value as SuppressionReason);
                    setAcknowledged(false);
                    setConfirmation("");
                    setError(null);
                    attemptRef.current = null;
                  }}
                >
                  {SUPPRESSION_RECLASSIFICATION_REASONS.map((item) => (
                    <option key={item} value={item}>
                      {reasonLabel(item)}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-muted-foreground">
                  {alreadyTarget.toLocaleString()} selected row
                  {alreadyTarget === 1 ? " already has" : "s already have"} this
                  reason. Reclassification does not restore consent or change
                  the durable provider bounce category.
                </p>
              </div>
            </>
          ) : null}

          {result ? (
            <div
              role={result.updated === result.requested ? "status" : "alert"}
              className="rounded-md border bg-muted/40 p-3 text-sm"
            >
              <p className="font-medium">
                {result.updated.toLocaleString()} of{" "}
                {result.requested.toLocaleString()} reviewed rows now carry{" "}
                {reasonLabel(reason)}.
              </p>
              {result.failed > 0 || result.missing > 0 ? (
                <p className="mt-1 text-destructive-emphasis">
                  {result.failed.toLocaleString()} lookup error
                  {result.failed === 1 ? "" : "s"};{" "}
                  {result.missing.toLocaleString()} row
                  {result.missing === 1 ? " was" : "s were"} no longer present.
                  No unconfirmed row is counted as updated.
                </p>
              ) : (
                <p className="mt-1 text-muted-foreground">
                  The response reconciled with the entire reviewed scope.
                </p>
              )}
            </div>
          ) : scope.length > 0 ? (
            <>
              <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
                <Checkbox
                  checked={acknowledged}
                  disabled={pending || allAlreadyTarget}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  aria-label="Confirm suppression reason review"
                />
                <span>
                  I reviewed the exact selected scope and target reason. I
                  understand this changes classification, not consent evidence.
                </span>
              </label>
              <div className="space-y-2">
                <Label htmlFor="selected-suppression-reason-confirmation">
                  Type {expectedConfirmation} to confirm
                </Label>
                <Input
                  id="selected-suppression-reason-confirmation"
                  value={confirmation}
                  disabled={pending || allAlreadyTarget}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </div>
            </>
          ) : null}

          {allAlreadyTarget && !result ? (
            <div role="status" className="text-sm text-muted-foreground">
              Every selected row already carries this reason; there is no change
              to submit.
            </div>
          ) : null}
          {error ? (
            <div role="alert" className="text-sm text-destructive-emphasis">
              {error}
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                const completed = Boolean(result);
                reset();
                if (completed) onClear();
              }}
              disabled={pending}
            >
              {result ? "Done" : "Cancel"}
            </Button>
            {!result && scope.length > 0 ? (
              <Button
                type="button"
                onClick={() => void runChange()}
                disabled={
                  pending ||
                  allAlreadyTarget ||
                  !acknowledged ||
                  confirmation.trim() !== expectedConfirmation
                }
              >
                {pending
                  ? "Updating…"
                  : `Apply to ${scope.length.toLocaleString()}`}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
