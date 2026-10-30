// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
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
import { apiErrorMessage, isApiError } from "@/lib/api";
import { checkEmail, deliverableButUnwise, type EmailVerdict } from "@/lib/preflight-api";
import {
  reauthorizeSubscriberMutation,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";
import {
  createSubscriberWithEvidence,
  emptyEnableEvidenceDraft,
  enableEvidenceProblem,
  normalizeRenamedEmail,
  suggestEmailFix,
  type EnableEvidenceDraft,
  type Subscriber,
} from "@/lib/subscriber-directory-api";

import { EnableEvidenceFields } from "./EnableWithEvidenceDialog";

function verdictSentence(verdict: EmailVerdict): string | null {
  if (!verdict.valid)
    return verdict.verdict === "no_mx"
      ? "This domain does not accept mail (no MX record)."
      : "This address is not deliverable as typed.";
  if (verdict.disposable) return "Disposable address — deliverable, but rarely a real reader.";
  if (verdict.role_account) return "Shared role inbox — deliverable, but nobody owns it.";
  return null;
}

/**
 * Add one subscriber. Before save the typed address is checked twice: a local
 * domain-typo check offers a click-to-apply suggestion (never applied on its
 * own), and POST /api/v1/email-validation/check reports deliverability; an
 * undeliverable verdict must be acknowledged. Initial eligibility defaults to
 * Unconfirmed — Subscribed requires the full opt-in evidence envelope.
 */
export function AddSubscriberDialog({
  open,
  onOpenChange,
  canWrite,
  authority,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canWrite: boolean;
  authority?: SubscriberAuthority | null;
  onCreated: (subscriber: Subscriber) => void;
}) {
  const idPrefix = useId();
  const id = (name: string) => `${idPrefix}-${name}`;
  const [email, setEmail] = useState("");
  const [tags, setTags] = useState("");
  const [status, setStatus] = useState<"unconfirmed" | "enabled">("unconfirmed");
  const [evidence, setEvidence] = useState<EnableEvidenceDraft>(() => emptyEnableEvidenceDraft());
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<EmailVerdict | null>(null);
  const [checking, setChecking] = useState(false);
  const [override, setOverride] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setTags("");
    setStatus("unconfirmed");
    setEvidence(emptyEnableEvidenceDraft());
    setSuggestion(null);
    setVerdict(null);
    setOverride(false);
    setError(null);
  }, [open]);

  const check = async (value: string) => {
    const seq = ++checkSeq.current;
    setSuggestion(suggestEmailFix(value));
    setVerdict(null);
    const normalized = normalizeRenamedEmail(value);
    if (!normalized) return;
    setChecking(true);
    try {
      const result = await checkEmail(normalized);
      if (seq === checkSeq.current) setVerdict(result);
    } catch {
      // Deliverability is advisory; a failed check must not block the save.
    } finally {
      if (seq === checkSeq.current) setChecking(false);
    }
  };

  const applySuggestion = () => {
    if (!suggestion) return;
    const fixed = suggestion;
    setEmail(fixed);
    setOverride(false);
    void check(fixed);
  };

  const normalized = normalizeRenamedEmail(email);
  const undeliverable = verdict !== null && !verdict.valid;
  const evidenceProblem =
    status === "enabled" && normalized
      ? (enableEvidenceProblem(evidence, normalized) ??
        (/^[A-Z]{2}$/.test(evidence.jurisdiction.trim().toUpperCase())
          ? null
          : "Use the subscriber's two-letter country code as the jurisdiction."))
      : null;
  const blocked = !canWrite
    ? "Adding subscribers needs an owner, admin or editor role."
    : !normalized
      ? "Enter a valid email address."
      : undeliverable && !override
        ? "Review the deliverability warning first."
        : evidenceProblem;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (blocked || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (authority) await reauthorizeSubscriberMutation(authority);
      const created = await createSubscriberWithEvidence({
        email,
        tags: tags.split(","),
        status,
        evidence: status === "enabled" ? evidence : null,
      });
      toast.success(`Added ${created.email}.`);
      onCreated(created);
      onOpenChange(false);
    } catch (err) {
      setError(
        isApiError(err) && err.code === "email_taken"
          ? "A subscriber with this address already exists."
          : apiErrorMessage(err, "Could not add the subscriber."),
      );
    } finally {
      setSaving(false);
    }
  };

  const warning = verdict ? verdictSentence(verdict) : null;

  return (
    <Dialog open={open} onOpenChange={(next) => (!saving ? onOpenChange(next) : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add subscriber</DialogTitle>
          <DialogDescription>
            New subscribers start unconfirmed unless you record reviewed
            opt-in evidence.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor={id("email")}>Email</Label>
            <Input
              id={id("email")}
              type="email"
              maxLength={320}
              autoComplete="off"
              value={email}
              disabled={saving}
              onChange={(event) => {
                setEmail(event.target.value);
                setSuggestion(null);
                setVerdict(null);
                setOverride(false);
              }}
              onBlur={() => void check(email)}
            />
            {suggestion && suggestion !== email.trim() ? (
              <p className="text-sm">
                <button
                  type="button"
                  className="text-primary underline underline-offset-2"
                  aria-label={`Replace the typed address with suggested address ${suggestion}`}
                  onClick={applySuggestion}
                >
                  Did you mean <strong>{suggestion}</strong>?
                </button>
              </p>
            ) : null}
            {checking ? (
              <p role="status" className="text-xs text-muted-foreground">
                Checking deliverability…
              </p>
            ) : warning ? (
              <p
                role={undeliverable ? "alert" : "status"}
                className={undeliverable ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
              >
                {warning}
                {verdict && deliverableButUnwise(verdict) ? " Consider leaving it out." : ""}
              </p>
            ) : null}
            {undeliverable ? (
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-primary"
                  checked={override}
                  disabled={saving}
                  onChange={(event) => setOverride(event.target.checked)}
                />
                <span>I reviewed this warning and still want to add the address.</span>
              </label>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={id("status")}>Initial eligibility</Label>
              <Select
                id={id("status")}
                value={status}
                disabled={saving}
                onChange={(event) =>
                  setStatus(event.target.value as "unconfirmed" | "enabled")
                }
              >
                <option value="unconfirmed">Unconfirmed</option>
                <option value="enabled">Subscribed (with evidence)</option>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={id("tags")}>Tags (comma-separated)</Label>
              <Input
                id={id("tags")}
                value={tags}
                disabled={saving}
                onChange={(event) => setTags(event.target.value)}
              />
            </div>
          </div>
          {status === "enabled" ? (
            <EnableEvidenceFields
              draft={evidence}
              onChange={setEvidence}
              canonicalEmail={normalized ?? ""}
              disabled={saving || !normalized}
              idPrefix={id("evidence")}
            />
          ) : null}
          {blocked && normalized ? (
            <p className="text-xs text-muted-foreground">{blocked}</p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={Boolean(blocked) || saving}>
              {saving ? "Adding…" : "Add subscriber"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
