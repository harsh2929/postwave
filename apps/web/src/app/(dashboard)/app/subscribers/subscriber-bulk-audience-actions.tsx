// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2, ScanSearch, ShieldCheck, Tags } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
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
import { apiErrorMessage } from "@/lib/api";
import type { AuthRole } from "@/lib/auth-api";
import {
  BULK_CONSENT_CATEGORY_OPTIONS,
  BULK_CONSENT_CHANNEL_OPTIONS,
  BULK_CONSENT_LEGAL_BASIS_OPTIONS,
  BULK_CONSENT_SOURCE_OPTIONS,
  MAX_SELECTED_VALIDATION,
  SubscriberBulkAdminContractError,
  changeSelectedSubscriberConsent,
  normalizeBulkConsentEvidence,
  removeTagFromSelectedSubscribers,
  selectedSubscriberTargets,
  validateSelectedSubscriberEmails,
  type BulkConsentCategory,
  type BulkConsentChannel,
  type BulkConsentEvidenceInput,
  type BulkConsentLegalBasis,
  type BulkConsentMode,
  type BulkConsentSource,
  type SelectedBulkOperationResult,
  type SelectedEmailValidationResponse,
} from "@/lib/subscriber-bulk-admin-api";
import {
  reauthorizeSubscriberMutation,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";
import type { Subscriber } from "@/lib/subscribers-api";

type ScopeSubscriber = Pick<Subscriber, "id" | "email">;

interface OperationOutcome {
  tone: "success" | "error" | "info";
  title: string;
  message: string;
}

interface ConsentDraft {
  category: BulkConsentCategory;
  source: BulkConsentSource;
  channel: BulkConsentChannel;
  legalBasis: BulkConsentLegalBasis;
  occurredAt: string;
  jurisdiction: string;
  evidence: string;
  reason: string;
  policyVersion: string;
  acknowledged: boolean;
  confirmation: string;
}

export interface SubscriberBulkAudienceActionsProps {
  selected: Subscriber[];
  allMatchingSelected: boolean;
  authority: SubscriberAuthority | null;
  role: AuthRole | null;
  onReviewDuplicates: (ids: readonly [string, string]) => void;
  onChanged: () => void;
}

function localDateTimeNow(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function emptyConsentDraft(): ConsentDraft {
  return {
    category: "email_marketing",
    source: "direct_request",
    channel: "email",
    legalBasis: "consent",
    occurredAt: localDateTimeNow(),
    jurisdiction: "",
    evidence: "",
    reason: "",
    policyVersion: "",
    acknowledged: false,
    confirmation: "",
  };
}

function label(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function mutationId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.();
  if (!suffix) {
    throw new SubscriberBulkAdminContractError(
      "A secure retry identity could not be generated. Nothing was changed.",
    );
  }
  return `${prefix}:${suffix}`;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function operationError(error: unknown): string {
  if (error instanceof SubscriberBulkAdminContractError) return error.message;
  return apiErrorMessage(error);
}

function scopeKey(
  selected: readonly ScopeSubscriber[],
  allMatchingSelected: boolean,
): string {
  if (allMatchingSelected) return "all-matching";
  return selected
    .map((subscriber) => `${subscriber.id ?? "missing"}:${subscriber.email}`)
    .sort()
    .join("|");
}

function operationEvidence(result: SelectedBulkOperationResult): string {
  const exclusions = Object.entries(result.exclusions)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${label(reason)}: ${count.toLocaleString()}`)
    .join("; ");
  return `${result.affected.toLocaleString()} confirmed changed; ${result.skipped.toLocaleString()} unchanged or excluded${exclusions ? ` (${exclusions})` : ""}.`;
}

function isAdminRole(role: AuthRole | null): boolean {
  return role === "owner" || role === "admin";
}

/**
 * The datetime-local input is not `required`, so an emptied field reaches
 * `new Date("").toISOString()` and throws a RangeError before any envelope
 * validation runs. That surfaced as the bare JavaScript sentence "Invalid time
 * value" on the dialog and the outcome banner, naming neither the field nor
 * what went wrong.
 */
function consentOccurredAtError(value: string): string | null {
  if (value.trim() === "") {
    return "Enter the date and time this decision was captured.";
  }
  if (Number.isNaN(new Date(value).getTime())) {
    return "Enter a complete date and time, for example 2026-09-06 14:30.";
  }
  return null;
}

export function SubscriberBulkAudienceActions({
  selected,
  allMatchingSelected,
  authority,
  role,
  onReviewDuplicates,
  onChanged,
}: SubscriberBulkAudienceActionsProps) {
  const currentScopeKey = scopeKey(selected, allMatchingSelected);
  const explicitTargets = useMemo(() => {
    if (allMatchingSelected || selected.length === 0) return null;
    try {
      return selectedSubscriberTargets(selected);
    } catch {
      return null;
    }
  }, [allMatchingSelected, selected]);
  const validationEligible =
    explicitTargets !== null && explicitTargets.length <= MAX_SELECTED_VALIDATION;
  const canMutate = Boolean(authority && isAdminRole(role));
  const canMerge = Boolean(authority && explicitTargets?.length === 2);
  const tags = useMemo(
    () =>
      [...new Set(selected.flatMap((subscriber) => subscriber.tags))].sort(
        (a, b) => a.localeCompare(b),
      ),
    [selected],
  );

  const [validationOpen, setValidationOpen] = useState(false);
  const [validationPending, setValidationPending] = useState(false);
  const [validationResult, setValidationResult] =
    useState<SelectedEmailValidationResponse | null>(null);
  const validationAbortRef = useRef<AbortController | null>(null);

  const [consentMode, setConsentMode] = useState<BulkConsentMode | null>(null);
  const [consentScope, setConsentScope] = useState<ScopeSubscriber[]>([]);
  const [consentDraft, setConsentDraft] = useState<ConsentDraft>(
    emptyConsentDraft,
  );
  const [consentPending, setConsentPending] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const consentAbortRef = useRef<AbortController | null>(null);
  const consentAttemptRef = useRef<{ fingerprint: string; key: string } | null>(
    null,
  );

  const [untagOpen, setUntagOpen] = useState(false);
  const [untagScope, setUntagScope] = useState<ScopeSubscriber[]>([]);
  const [untag, setUntag] = useState("");
  const [untagPending, setUntagPending] = useState(false);
  const [untagError, setUntagError] = useState<string | null>(null);
  const untagAbortRef = useRef<AbortController | null>(null);
  const untagAttemptRef = useRef<{ fingerprint: string; key: string } | null>(
    null,
  );
  const [outcome, setOutcome] = useState<OperationOutcome | null>(null);

  const generationRef = useRef(0);
  const latestScopeKeyRef = useRef(currentScopeKey);
  latestScopeKeyRef.current = currentScopeKey;

  useEffect(() => {
    generationRef.current += 1;
    validationAbortRef.current?.abort();
    consentAbortRef.current?.abort();
    untagAbortRef.current?.abort();
    validationAbortRef.current = null;
    consentAbortRef.current = null;
    untagAbortRef.current = null;
    setValidationOpen(false);
    setValidationPending(false);
    setValidationResult(null);
    setConsentMode(null);
    setConsentScope([]);
    setConsentPending(false);
    setConsentError(null);
    consentAttemptRef.current = null;
    setUntagOpen(false);
    setUntagScope([]);
    setUntag("");
    setUntagPending(false);
    setUntagError(null);
    untagAttemptRef.current = null;
    setOutcome(null);
  }, [currentScopeKey]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      validationAbortRef.current?.abort();
      consentAbortRef.current?.abort();
      untagAbortRef.current?.abort();
    },
    [],
  );

  const beginValidation = async () => {
    if (!validationEligible || !explicitTargets) {
      setOutcome({
        tone: "info",
        title: "Choose an explicit validation scope",
        message: `Validation accepts 1–${MAX_SELECTED_VALIDATION.toLocaleString()} selected rows with stable, unique ids and emails. “Select all matching” is intentionally excluded.`,
      });
      return;
    }
    const frozen = explicitTargets.map(({ id, email }) => ({ id, email }));
    const openedFor = currentScopeKey;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    validationAbortRef.current?.abort();
    validationAbortRef.current = controller;
    setValidationResult(null);
    setValidationPending(true);
    setValidationOpen(true);
    try {
      const result = await validateSelectedSubscriberEmails(frozen, {
        signal: controller.signal,
      });
      if (
        generation !== generationRef.current ||
        openedFor !== latestScopeKeyRef.current
      ) {
        return;
      }
      setValidationResult(result);
    } catch (error) {
      if (!isAbortError(error) && generation === generationRef.current) {
        setValidationOpen(false);
        setOutcome({
          tone: "error",
          title: "Validation was not confirmed",
          message: `${operationError(error)} The exact ${frozen.length.toLocaleString()}-subscriber scope remains selected for an explicit retry.`,
        });
      }
    } finally {
      if (generation === generationRef.current) {
        validationAbortRef.current = null;
        setValidationPending(false);
      }
    }
  };

  const openConsent = (mode: BulkConsentMode) => {
    if (!canMutate || !explicitTargets || !authority) {
      setOutcome({
        tone: "info",
        title: "Admin review required",
        message:
          "Granting or revoking consent requires an explicit selected scope and a current admin or owner session.",
      });
      return;
    }
    setConsentScope(explicitTargets.map(({ id, email }) => ({ id, email })));
    setConsentDraft(emptyConsentDraft());
    setConsentError(null);
    consentAttemptRef.current = null;
    setConsentMode(mode);
  };

  const consentEvidence = (): BulkConsentEvidenceInput =>
    normalizeBulkConsentEvidence({
      category: consentDraft.category,
      source: consentDraft.source,
      channel: consentDraft.channel,
      legal_basis: consentDraft.legalBasis,
      occurred_at: new Date(consentDraft.occurredAt).toISOString(),
      jurisdiction: consentDraft.jurisdiction,
      evidence: consentDraft.evidence,
      reason: consentDraft.reason,
      policy_version: consentDraft.policyVersion,
    });

  const submitConsent = async () => {
    if (!consentMode || !authority || !isAdminRole(role)) return;
    const expected = `${consentMode === "grant" ? "GRANT" : "REVOKE"} ${consentScope.length}`;
    if (
      !consentDraft.acknowledged ||
      consentDraft.confirmation.trim() !== expected
    ) {
      setConsentError(`Acknowledge the scope and type ${expected} exactly.`);
      return;
    }
    const occurredAtError = consentOccurredAtError(consentDraft.occurredAt);
    if (occurredAtError) {
      setConsentError(occurredAtError);
      return;
    }
    let evidence: BulkConsentEvidenceInput;
    let idempotencyKey: string;
    try {
      evidence = consentEvidence();
      selectedSubscriberTargets(consentScope);
      const fingerprint = JSON.stringify({
        mode: consentMode,
        ids: consentScope.map((subscriber) => subscriber.id),
        evidence,
      });
      if (consentAttemptRef.current?.fingerprint !== fingerprint) {
        const key = mutationId(`subscriber-consent-${consentMode}`);
        consentAttemptRef.current = { fingerprint, key };
      }
      idempotencyKey = consentAttemptRef.current.key;
    } catch (error) {
      const message = operationError(error);
      setConsentError(message);
      setOutcome({
        tone: "error",
        title: "Consent write was not started",
        message,
      });
      return;
    }
    const openedFor = currentScopeKey;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    consentAbortRef.current?.abort();
    consentAbortRef.current = controller;
    setConsentPending(true);
    setConsentError(null);
    try {
      await reauthorizeSubscriberMutation(authority, controller.signal);
      const result = await changeSelectedSubscriberConsent(
        consentScope,
        consentMode,
        evidence,
        { idempotencyKey, signal: controller.signal },
      );
      let authorityChanged = false;
      try {
        await reauthorizeSubscriberMutation(authority, controller.signal);
      } catch {
        authorityChanged = true;
      }
      if (
        generation !== generationRef.current ||
        openedFor !== latestScopeKeyRef.current
      ) {
        return;
      }
      consentAttemptRef.current = null;
      setConsentMode(null);
      setOutcome({
        tone: "success",
        title: `Consent ${consentMode === "grant" ? "grant" : "revocation"} recorded`,
        message: `${operationEvidence(result)} The evidence ledger accepted the complete reviewed envelope.${authorityChanged ? " The write committed, but workspace access changed afterward; the audience was refreshed." : ""}`,
      });
      onChanged();
    } catch (error) {
      if (!isAbortError(error) && generation === generationRef.current) {
        const message = `${operationError(error)} No outcome is assumed; the exact ${consentScope.length.toLocaleString()}-subscriber scope and mutation identity are retained for an explicit retry.`;
        setConsentError(message);
        setOutcome({
          tone: "error",
          title: "Consent write was not confirmed",
          message,
        });
      }
    } finally {
      if (generation === generationRef.current) {
        consentAbortRef.current = null;
        setConsentPending(false);
      }
    }
  };

  const openUntag = () => {
    if (!canMutate || !explicitTargets || tags.length === 0) {
      setOutcome({
        tone: "info",
        title: "No removable tag in this scope",
        message:
          "Choose explicit tagged subscribers with a current admin or owner session.",
      });
      return;
    }
    setUntagScope(explicitTargets.map(({ id, email }) => ({ id, email })));
    setUntag(tags[0] ?? "");
    setUntagError(null);
    untagAttemptRef.current = null;
    setUntagOpen(true);
  };

  const submitUntag = async () => {
    if (!authority || !isAdminRole(role) || !untag) return;
    let idempotencyKey: string;
    try {
      const fingerprint = JSON.stringify({
        ids: untagScope.map((subscriber) => subscriber.id),
        tag: untag,
      });
      if (untagAttemptRef.current?.fingerprint !== fingerprint) {
        const key = mutationId("subscriber-untag");
        untagAttemptRef.current = { fingerprint, key };
      }
      idempotencyKey = untagAttemptRef.current.key;
    } catch (error) {
      const message = operationError(error);
      setUntagError(message);
      setOutcome({
        tone: "error",
        title: "Tag removal was not started",
        message,
      });
      return;
    }
    const openedFor = currentScopeKey;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    untagAbortRef.current?.abort();
    untagAbortRef.current = controller;
    setUntagPending(true);
    setUntagError(null);
    try {
      await reauthorizeSubscriberMutation(authority, controller.signal);
      const result = await removeTagFromSelectedSubscribers(
        untagScope,
        untag,
        { idempotencyKey, signal: controller.signal },
      );
      let authorityChanged = false;
      try {
        await reauthorizeSubscriberMutation(authority, controller.signal);
      } catch {
        authorityChanged = true;
      }
      if (
        generation !== generationRef.current ||
        openedFor !== latestScopeKeyRef.current
      ) {
        return;
      }
      untagAttemptRef.current = null;
      setUntagOpen(false);
      setOutcome({
        tone: "success",
        title: `Removed “${untag}”`,
        message: `${operationEvidence(result)}${result.recovery_until ? ` A revision-bound recovery receipt is available until ${new Date(result.recovery_until).toLocaleString()}.` : ""}${authorityChanged ? " The write committed, but workspace access changed afterward; the audience was refreshed." : ""}`,
      });
      onChanged();
    } catch (error) {
      if (!isAbortError(error) && generation === generationRef.current) {
        const message = `${operationError(error)} No outcome is assumed; the reviewed scope and mutation identity are retained for an explicit retry.`;
        setUntagError(message);
        setOutcome({
          tone: "error",
          title: "Tag removal was not confirmed",
          message,
        });
      }
    } finally {
      if (generation === generationRef.current) {
        untagAbortRef.current = null;
        setUntagPending(false);
      }
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={() => void beginValidation()}
        disabled={validationPending || !validationEligible}
        title={
          validationEligible
            ? "Read-only syntax, mail-routing, disposable-domain, and role-account checks"
            : `Select up to ${MAX_SELECTED_VALIDATION.toLocaleString()} explicit rows with stable ids`
        }
      >
        <ScanSearch className="h-4 w-4" />
        {validationPending ? "Validating…" : "Validate emails"}
      </Button>

      {explicitTargets?.length === 2 ? (
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={!canMerge}
          title={!canMerge ? "Merging requires an editor role or higher" : undefined}
          onClick={() =>
            onReviewDuplicates([explicitTargets[0]!.id, explicitTargets[1]!.id])
          }
        >
          <CheckCircle2 className="h-4 w-4" />
          Review duplicates
        </Button>
      ) : null}

      <Button
        variant="outline"
        size="sm"
        type="button"
        disabled={!canMutate || !explicitTargets}
        onClick={() => openConsent("grant")}
        title={!canMutate ? "Consent changes require an admin or owner role" : undefined}
      >
        <ShieldCheck className="h-4 w-4" />
        Grant consent
      </Button>
      <Button
        variant="outline"
        size="sm"
        type="button"
        disabled={!canMutate || !explicitTargets}
        onClick={() => openConsent("revoke")}
        title={!canMutate ? "Consent changes require an admin or owner role" : undefined}
      >
        Revoke consent
      </Button>
      <Button
        variant="outline"
        size="sm"
        type="button"
        disabled={!canMutate || !explicitTargets || tags.length === 0}
        onClick={openUntag}
      >
        <Tags className="h-4 w-4" />
        Remove tag
      </Button>

      {allMatchingSelected ? (
        <span className="basis-full text-xs text-muted-foreground">
          Validation, duplicate review, consent evidence, and tag removal require
          an explicit row selection so the reviewed identities cannot change
          underneath the action.
        </span>
      ) : null}
      {outcome ? (
        <div
          role={outcome.tone === "error" ? "alert" : "status"}
          className={`basis-full rounded-md border px-3 py-2 text-xs ${
            outcome.tone === "error"
              ? "border-destructive/40 text-destructive"
              : outcome.tone === "success"
                ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
                : "text-muted-foreground"
          }`}
        >
          <span className="font-medium">{outcome.title}.</span>{" "}
          {outcome.message}
        </div>
      ) : null}

      <ValidationDialog
        open={validationOpen}
        pending={validationPending}
        result={validationResult}
        onOpenChange={(open) => {
          if (!open) {
            generationRef.current += 1;
            validationAbortRef.current?.abort();
            validationAbortRef.current = null;
            setValidationPending(false);
            setValidationResult(null);
          }
          setValidationOpen(open);
        }}
      />

      <ConsentDialog
        mode={consentMode}
        count={consentScope.length}
        draft={consentDraft}
        pending={consentPending}
        error={consentError}
        onDraft={setConsentDraft}
        onClose={() => {
          if (consentPending) return;
          setConsentMode(null);
          setConsentError(null);
        }}
        onSubmit={() => void submitConsent()}
      />

      <UntagDialog
        open={untagOpen}
        count={untagScope.length}
        tags={tags}
        tag={untag}
        pending={untagPending}
        error={untagError}
        onTag={(value) => {
          setUntag(value);
          setUntagError(null);
        }}
        onClose={() => {
          if (untagPending) return;
          setUntagOpen(false);
          setUntagError(null);
        }}
        onSubmit={() => void submitUntag()}
      />
    </>
  );
}

function ValidationDialog({
  open,
  pending,
  result,
  onOpenChange,
}: {
  open: boolean;
  pending: boolean;
  result: SelectedEmailValidationResponse | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Email validation results</DialogTitle>
          <DialogDescription>
            Read-only syntax, MX, disposable-domain, and role-account signals.
            Validation does not prove mailbox ownership or change a subscriber.
          </DialogDescription>
        </DialogHeader>
        {pending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Checking the exact selected scope…
          </p>
        ) : result ? (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-sm">
              <Metric label="Checked" value={result.summary.total} />
              <Metric label="Routable" value={result.summary.valid} />
              <Metric label="Not routable" value={result.summary.invalid} />
            </div>
            <ul className="max-h-80 divide-y overflow-y-auto rounded-md border">
              {result.results.map((item) => (
                <li key={item.subscriber_id} className="space-y-1 px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-all font-medium">{item.email}</span>
                    <span className={item.valid ? "text-emerald-600" : "text-destructive"}>
                      {label(item.verdict)}
                    </span>
                  </div>
                  {item.reasons.length > 0 ? (
                    <p className="text-muted-foreground">{item.reasons.join("; ")}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" disabled={pending}>
              Done
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Metric({ label: metricLabel, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-muted-foreground">{metricLabel}</div>
      <div className="font-semibold tabular-nums">{value.toLocaleString()}</div>
    </div>
  );
}

function ConsentDialog({
  mode,
  count,
  draft,
  pending,
  error,
  onDraft,
  onClose,
  onSubmit,
}: {
  mode: BulkConsentMode | null;
  count: number;
  draft: ConsentDraft;
  pending: boolean;
  error: string | null;
  onDraft: (draft: ConsentDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  if (!mode) return null;
  const verb = mode === "grant" ? "Grant" : "Revoke";
  const expected = `${verb.toUpperCase()} ${count}`;
  const occurredAtError = consentOccurredAtError(draft.occurredAt);
  const update = <K extends keyof ConsentDraft,>(
    key: K,
    value: ConsentDraft[K],
  ) => onDraft({ ...draft, [key]: value });
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent
        className="max-w-2xl"
        closeDisabled={pending}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onPointerDownOutside={(event) => pending && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{verb} consent for selected subscribers</DialogTitle>
          <DialogDescription>
            This appends an immutable decision for exactly {count.toLocaleString()} selected
            subscriber{count === 1 ? "" : "s"}. Email marketing decisions also update the
            canonical address-level send gate; other categories do not change email status.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category" htmlFor="bulk-consent-category">
            <Select
              id="bulk-consent-category"
              value={draft.category}
              disabled={pending}
              onChange={(event) => update("category", event.target.value as BulkConsentCategory)}
            >
              {BULK_CONSENT_CATEGORY_OPTIONS.map((value) => (
                <option key={value} value={value}>{label(value)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Evidence source" htmlFor="bulk-consent-source">
            <Select
              id="bulk-consent-source"
              value={draft.source}
              disabled={pending}
              onChange={(event) => update("source", event.target.value as BulkConsentSource)}
            >
              {BULK_CONSENT_SOURCE_OPTIONS.map((value) => (
                <option key={value} value={value}>{label(value)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Channel" htmlFor="bulk-consent-channel">
            <Select
              id="bulk-consent-channel"
              value={draft.channel}
              disabled={pending}
              onChange={(event) => update("channel", event.target.value as BulkConsentChannel)}
            >
              {BULK_CONSENT_CHANNEL_OPTIONS.map((value) => (
                <option key={value} value={value}>{label(value)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Legal basis" htmlFor="bulk-consent-basis">
            <Select
              id="bulk-consent-basis"
              value={draft.legalBasis}
              disabled={pending}
              onChange={(event) => update("legalBasis", event.target.value as BulkConsentLegalBasis)}
            >
              {BULK_CONSENT_LEGAL_BASIS_OPTIONS.map((value) => (
                <option key={value} value={value}>{label(value)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Occurred at" htmlFor="bulk-consent-occurred">
            <Input
              id="bulk-consent-occurred"
              type="datetime-local"
              value={draft.occurredAt}
              disabled={pending}
              aria-invalid={occurredAtError !== null}
              aria-describedby="bulk-consent-occurred-help"
              onChange={(event) => update("occurredAt", event.target.value)}
            />
            <p
              id="bulk-consent-occurred-help"
              className={
                occurredAtError
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {occurredAtError ??
                "When the subject made this decision, in your local time."}
            </p>
          </Field>
          <Field label="Jurisdiction code" htmlFor="bulk-consent-jurisdiction">
            <Input
              id="bulk-consent-jurisdiction"
              value={draft.jurisdiction}
              maxLength={32}
              autoComplete="off"
              disabled={pending}
              placeholder="US-CA"
              onChange={(event) => update("jurisdiction", event.target.value)}
            />
          </Field>
          <Field label="Policy version" htmlFor="bulk-consent-policy">
            <Input
              id="bulk-consent-policy"
              value={draft.policyVersion}
              maxLength={100}
              autoComplete="off"
              disabled={pending}
              placeholder="privacy-2026-08"
              onChange={(event) => update("policyVersion", event.target.value)}
            />
          </Field>
          <div />
          <Field label="Reviewed evidence" htmlFor="bulk-consent-evidence" className="sm:col-span-2">
            <Textarea
              id="bulk-consent-evidence"
              value={draft.evidence}
              maxLength={2_048}
              disabled={pending}
              placeholder="Receipt id, signed-form reference, or reviewed request reference"
              onChange={(event) => update("evidence", event.target.value)}
            />
          </Field>
          <Field label="Reason for this decision" htmlFor="bulk-consent-reason" className="sm:col-span-2">
            <Textarea
              id="bulk-consent-reason"
              value={draft.reason}
              maxLength={500}
              disabled={pending}
              onChange={(event) => update("reason", event.target.value)}
            />
          </Field>
        </div>
        <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
            checked={draft.acknowledged}
            disabled={pending}
            onChange={(event) => update("acknowledged", event.target.checked)}
          />
          <span>
            I reviewed this exact scope and evidence. I understand a bulk decision
            is not proof that each person consented unless the cited record establishes it.
          </span>
        </label>
        <Field label={`Type ${expected} to confirm`} htmlFor="bulk-consent-confirmation">
          <Input
            id="bulk-consent-confirmation"
            value={draft.confirmation}
            autoComplete="off"
            disabled={pending}
            onChange={(event) => update("confirmation", event.target.value)}
          />
        </Field>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={mode === "revoke" ? "destructive" : "default"}
            disabled={
              pending ||
              !draft.acknowledged ||
              occurredAtError !== null ||
              draft.confirmation.trim() !== expected
            }
            onClick={onSubmit}
          >
            {pending ? "Recording…" : `${verb} and record evidence`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UntagDialog({
  open,
  count,
  tags,
  tag,
  pending,
  error,
  onTag,
  onClose,
  onSubmit,
}: {
  open: boolean;
  count: number;
  tags: string[];
  tag: string;
  pending: boolean;
  error: string | null;
  onTag: (tag: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent closeDisabled={pending}>
        <DialogHeader>
          <DialogTitle>Remove a tag from selected subscribers</DialogTitle>
          <DialogDescription>
            Removes the chosen tag only where present across the exact {count.toLocaleString()}-subscriber scope.
            The server returns a revision-bound recovery receipt for changed rows.
          </DialogDescription>
        </DialogHeader>
        <Field label="Tag" htmlFor="bulk-untag-tag">
          <Select
            id="bulk-untag-tag"
            value={tag}
            disabled={pending}
            onChange={(event) => onTag(event.target.value)}
          >
            {tags.map((value) => <option key={value} value={value}>{value}</option>)}
          </Select>
        </Field>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={pending || !tag} onClick={onSubmit}>
            {pending ? "Removing…" : "Remove tag"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label: fieldLabel,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`grid gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={htmlFor}>{fieldLabel}</Label>
      {children}
    </div>
  );
}
