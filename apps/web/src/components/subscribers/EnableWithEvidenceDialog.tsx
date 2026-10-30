// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage, isApiError } from "@/lib/api";
import {
  reauthorizeSubscriberMutation,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";
import {
  CONSENT_CHANNELS,
  CONSENT_LEGAL_BASES,
  emptyEnableEvidenceDraft,
  enableEvidenceProblem,
  enableSubscriberWithEvidence,
  type EnableEvidenceDraft,
  type Subscriber,
} from "@/lib/subscriber-directory-api";

const OPT_IN_SOURCES = [
  { value: "double_optin", label: "Double opt-in confirmation" },
  { value: "single_optin", label: "Single opt-in record" },
] as const;

/**
 * The opt-in evidence envelope the server requires before a subscriber may
 * become `enabled`: source, capture channel, legal basis, capture time,
 * jurisdiction, evidence reference, reason and policy version — plus two
 * client-side gates (scope acknowledgement and the typed address).
 */
export function EnableEvidenceFields({
  draft,
  onChange,
  canonicalEmail,
  disabled,
  idPrefix,
  requireTypedEmail = true,
}: {
  draft: EnableEvidenceDraft;
  onChange: (next: EnableEvidenceDraft) => void;
  canonicalEmail: string;
  disabled?: boolean;
  idPrefix: string;
  requireTypedEmail?: boolean;
}) {
  const set = <K extends keyof EnableEvidenceDraft>(
    key: K,
    value: EnableEvidenceDraft[K],
  ) => onChange({ ...draft, [key]: value });
  const id = (name: string) => `${idPrefix}-${name}`;
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={id("source")}>Opt-in record</Label>
          <Select
            id={id("source")}
            value={draft.source}
            disabled={disabled}
            onChange={(event) => set("source", event.target.value)}
          >
            <option value="">Choose the reviewed record…</option>
            {OPT_IN_SOURCES.map((option) => (
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
            disabled={disabled}
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
            disabled={disabled}
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
          <Label htmlFor={id("captured")}>Captured at</Label>
          <Input
            id={id("captured")}
            type="datetime-local"
            value={draft.capturedAt}
            disabled={disabled}
            onChange={(event) => set("capturedAt", event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={id("jurisdiction")}>Jurisdiction</Label>
          <Input
            id={id("jurisdiction")}
            value={draft.jurisdiction}
            maxLength={32}
            placeholder="GB, EU, US-CA"
            disabled={disabled}
            onChange={(event) => set("jurisdiction", event.target.value.toUpperCase())}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={id("policy")}>Policy version</Label>
          <Input
            id={id("policy")}
            value={draft.policyVersion}
            maxLength={100}
            placeholder="privacy-2026-06"
            disabled={disabled}
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
          placeholder="receipt:CONSENT-123 or the confirmation record URL"
          disabled={disabled}
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
          disabled={disabled}
          onChange={(event) => set("reason", event.target.value)}
        />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-primary"
          checked={draft.scopeAcknowledged}
          disabled={disabled}
          onChange={(event) => set("scopeAcknowledged", event.target.checked)}
        />
        <span>
          This proof applies to <strong>{canonicalEmail || "this address"}</strong>{" "}
          and to email marketing only.
        </span>
      </label>
      {requireTypedEmail ? (
        <div className="grid gap-1.5">
          <Label htmlFor={id("typed")}>
            Type <span className="font-mono">{canonicalEmail}</span> to confirm
          </Label>
          <Input
            id={id("typed")}
            value={draft.typedEmail}
            autoComplete="off"
            disabled={disabled}
            onChange={(event) => set("typedEmail", event.target.value)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Statuses from which a reviewed enable is offered (desktop's canReviewEnable). */
export function canReviewEnable(subscriber: Subscriber): boolean {
  return (
    subscriber.status !== "enabled" &&
    !subscriber.archived_at &&
    Boolean(subscriber.id)
  );
}

/**
 * Review consent & enable: PATCH /api/v1/subscribers/{id} with status
 * `enabled` and the complete evidence envelope, under the row's exact
 * revision. Nothing is sent until every field satisfies the server's bounds.
 */
export function EnableWithEvidenceDialog({
  subscriber,
  open,
  onOpenChange,
  onEnabled,
  authority,
}: {
  subscriber: Subscriber;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnabled: (updated: Subscriber) => void;
  authority?: SubscriberAuthority | null;
}) {
  const idPrefix = useId();
  const [draft, setDraft] = useState<EnableEvidenceDraft>(() =>
    emptyEnableEvidenceDraft(subscriber.country),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(emptyEnableEvidenceDraft(subscriber.country));
    setError(null);
  }, [open, subscriber.id, subscriber.country]);

  const problem = enableEvidenceProblem(draft, subscriber.email);
  const verb = subscriber.status === "unconfirmed" ? "confirm" : "enable";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (authority) await reauthorizeSubscriberMutation(authority);
      const updated = await enableSubscriberWithEvidence(subscriber, draft);
      toast.success(`${subscriber.email} is now subscribed.`);
      onEnabled(updated);
      onOpenChange(false);
    } catch (err) {
      setError(
        isApiError(err) && (err.status === 409 || err.status === 412)
          ? "This subscriber changed after the review began. Reload the record and review its current state before trying again."
          : apiErrorMessage(err, "Could not record the reviewed consent."),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && saving) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Review consent & {verb}</DialogTitle>
          <DialogDescription>
            {subscriber.email} becomes eligible for marketing sends only with a
            reviewed opt-in record. The evidence is stored with the change.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <EnableEvidenceFields
            draft={draft}
            onChange={setDraft}
            canonicalEmail={subscriber.email}
            disabled={saving}
            idPrefix={idPrefix}
          />
          {problem && !error ? (
            <p className="text-xs text-muted-foreground">{problem}</p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={Boolean(problem) || saving}>
              {saving ? "Recording…" : `Record evidence & ${verb}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
