// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage, isApiError } from "@/lib/api";
import {
  reauthorizeSubscriberMutation,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";
import {
  bulkResubscribeWithEvidence,
  classifyResubscribeEligibility,
  CONSENT_CHANNELS,
  CONSENT_LEGAL_BASES,
  CONSENT_SOURCES,
  consentEvidenceProblem,
  consentProvenance,
  emptyConsentEvidenceDraft,
  RESUBSCRIBE_EXCLUSION_LABELS,
  type ConsentEvidenceDraft,
  type DirectoryBulkResult,
  type Subscriber,
} from "@/lib/subscriber-directory-api";

function summarizeExclusions(result: DirectoryBulkResult): string {
  const parts = Object.entries(result.exclusions)
    .filter(([, n]) => n > 0)
    .map(
      ([key, n]) =>
        `${n.toLocaleString()} ${RESUBSCRIBE_EXCLUSION_LABELS[key] ?? key.replace(/_/g, " ")}`,
    );
  return parts.join("; ");
}

/**
 * Bulk resubscribe with the mandatory consent-evidence envelope. The rows are
 * preflighted locally (only unsubscribed rows are sent, and the operator sees
 * how many were left out and why), the evidence must satisfy the server's
 * bounds, the scope must be acknowledged, and `RESUBSCRIBE <n>` must be typed.
 * The server then re-checks every row and reports what it skipped.
 */
export function BulkResubscribeDialog({
  rows,
  allMatchingSelected = false,
  canAdmin,
  authority,
  onDone,
}: {
  /** The explicitly selected rows (eligibility is judged from their status). */
  rows: readonly Subscriber[];
  allMatchingSelected?: boolean;
  canAdmin: boolean;
  authority?: SubscriberAuthority | null;
  onDone?: (result: DirectoryBulkResult) => void;
}) {
  const idPrefix = useId();
  const id = (name: string) => `${idPrefix}-${name}`;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ConsentEvidenceDraft>(emptyConsentEvidenceDraft);
  const [scopeAcknowledged, setScopeAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DirectoryBulkResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(emptyConsentEvidenceDraft());
    setScopeAcknowledged(false);
    setConfirmation("");
    setError(null);
    setResult(null);
  }, [open]);

  const eligibility = classifyResubscribeEligibility(rows);
  const eligible = eligibility.eligibleIds.length;
  const token = `RESUBSCRIBE ${eligible}`;
  const evidenceProblem = consentEvidenceProblem(draft);
  const withheld = !canAdmin
    ? "Only an owner or admin can resubscribe in bulk."
    : allMatchingSelected
      ? "Select rows on this page so their eligibility can be reviewed; resubscribe does not run against every match."
      : null;
  const blocked =
    withheld ??
    (eligible === 0
      ? "None of the selected subscribers is unsubscribed, so none can be resubscribed."
      : evidenceProblem ??
        (!scopeAcknowledged
          ? "Acknowledge the exact scope before continuing."
          : confirmation.trim() !== token
            ? `Type ${token} to confirm.`
            : null));

  const set = <K extends keyof ConsentEvidenceDraft>(key: K, value: ConsentEvidenceDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (blocked || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (authority) await reauthorizeSubscriberMutation(authority);
      const outcome = await bulkResubscribeWithEvidence(
        eligibility.eligibleIds,
        consentProvenance(draft),
      );
      setResult(outcome);
      onDone?.(outcome);
      toast.success(`Resubscribed ${outcome.affected.toLocaleString()} subscribers.`);
    } catch (err) {
      setError(
        isApiError(err) && err.code === "concurrent_consent_change"
          ? "Another consent change was in progress for these subscribers. Try again in a moment."
          : apiErrorMessage(err, "Could not resubscribe the selection."),
      );
    } finally {
      setSaving(false);
    }
  };

  const localSkips = [
    eligibility.alreadySubscribed > 0
      ? `${eligibility.alreadySubscribed} already subscribed`
      : null,
    eligibility.ineligible > 0
      ? `${eligibility.ineligible} disabled or unconfirmed (use Review consent & enable on each)`
      : null,
    eligibility.missingId > 0 ? `${eligibility.missingId} not yet saved` : null,
  ].filter(Boolean);

  return (
    <Dialog open={open} onOpenChange={(next) => (!saving ? setOpen(next) : undefined)}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={Boolean(withheld)}
          title={withheld ?? undefined}
        >
          <RotateCcw aria-hidden className="h-4 w-4" />
          Re-subscribe…
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Re-subscribe {eligible.toLocaleString()} subscriber{eligible === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            They become eligible for marketing sends again. A resubscribe is a
            new consent decision, so it is recorded with the evidence below.
          </DialogDescription>
        </DialogHeader>
        {localSkips.length > 0 ? (
          <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
            Left out of this request: {localSkips.join(", ")}.
          </p>
        ) : null}
        {result ? (
          <div role="status" className="grid gap-2 text-sm">
            <p>
              Resubscribed <strong>{result.affected.toLocaleString()}</strong>.
              {result.skipped > 0
                ? ` The server skipped ${result.skipped.toLocaleString()}: ${summarizeExclusions(result) || "ineligible rows"}.`
                : ""}
            </p>
            <DialogFooter>
              <Button type="button" onClick={() => setOpen(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="grid gap-3" onSubmit={submit} noValidate>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor={id("source")}>Evidence source</Label>
                <Select
                  id={id("source")}
                  value={draft.source}
                  disabled={saving}
                  onChange={(event) => set("source", event.target.value)}
                >
                  <option value="">Choose where it came from…</option>
                  {CONSENT_SOURCES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={id("channel")}>Captured via</Label>
                <Select
                  id={id("channel")}
                  value={draft.channel}
                  disabled={saving}
                  onChange={(event) => set("channel", event.target.value)}
                >
                  {CONSENT_CHANNELS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={id("basis")}>Legal basis</Label>
                <Select
                  id={id("basis")}
                  value={draft.legalBasis}
                  disabled={saving}
                  onChange={(event) => set("legalBasis", event.target.value)}
                >
                  {CONSENT_LEGAL_BASES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={id("occurred")}>Captured at</Label>
                <Input
                  id={id("occurred")}
                  type="datetime-local"
                  value={draft.occurredAt}
                  disabled={saving}
                  onChange={(event) => set("occurredAt", event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={id("jurisdiction")}>Jurisdiction</Label>
                <Input
                  id={id("jurisdiction")}
                  value={draft.jurisdiction}
                  maxLength={32}
                  placeholder="GB, EU, US-CA"
                  disabled={saving}
                  onChange={(event) => set("jurisdiction", event.target.value.toUpperCase())}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={id("policy")}>Policy version</Label>
                <Input
                  id={id("policy")}
                  value={draft.policyVersion}
                  maxLength={100}
                  disabled={saving}
                  onChange={(event) => set("policyVersion", event.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={id("evidence")}>Evidence reference</Label>
              <Input
                id={id("evidence")}
                value={draft.evidence}
                maxLength={2048}
                placeholder="receipt:REOPTIN-2026-09"
                disabled={saving}
                onChange={(event) => set("evidence", event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={id("reason")}>Reason</Label>
              <Textarea
                id={id("reason")}
                value={draft.reason}
                maxLength={500}
                rows={2}
                disabled={saving}
                onChange={(event) => set("reason", event.target.value)}
              />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-primary"
                checked={scopeAcknowledged}
                disabled={saving}
                onChange={(event) => setScopeAcknowledged(event.target.checked)}
              />
              <span>
                This evidence covers each of the {eligible.toLocaleString()}{" "}
                addresses being resubscribed, for email marketing only.
              </span>
            </label>
            <div className="grid gap-1.5">
              <Label htmlFor={id("confirm")}>
                Type <span className="font-mono">{token}</span> to confirm
              </Label>
              <Input
                id={id("confirm")}
                value={confirmation}
                autoComplete="off"
                disabled={saving}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </div>
            {blocked && !error ? (
              <p className="text-xs text-muted-foreground">{blocked}</p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={saving} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={Boolean(blocked) || saving}>
                {saving ? "Resubscribing…" : `Re-subscribe ${eligible.toLocaleString()}`}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
