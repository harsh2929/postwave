import {
  type ReactElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  FileCheck2,
  MailCheck,
  ShieldCheck,
} from "lucide-react";

import {
  api,
  type Subscriber,
  type SubscriberDetail,
  type SubscriberEnableConsentInput,
} from "../../lib/api-client";
import { FormField } from "../FormField";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import {
  CONSENT_EVIDENCE_CHANNELS,
  CONSENT_LEGAL_BASES,
  CONSENT_PROVENANCE_SOURCES,
} from "./consent-evidence";
import { engineStatusToUi, UI_STATUS_LABELS } from "./subscriber-status";

export interface SubscriberStatusConsentTarget extends Subscriber {
  id: string | number;
  version: string;
  country?: string | null;
}

interface SubscriberStatusConsentModalProps {
  target: SubscriberStatusConsentTarget | null;
  defaultJurisdiction?: string | null;
  onClose: () => void;
  onEnabled: (updated: SubscriberDetail) => void;
  onBusyChange?: (busy: boolean) => void;
}

export interface SubscriberStatusConsentDraft {
  source: "" | "double_optin" | "single_optin";
  channel: string;
  legalBasis: string;
  capturedAt: string;
  jurisdiction: string;
  evidence: string;
  reason: string;
  policyVersion: string;
  scopeAcknowledged: boolean;
  typedEmail: string;
}

export type SubscriberStatusConsentField =
  | "source"
  | "channel"
  | "legalBasis"
  | "capturedAt"
  | "jurisdiction"
  | "evidence"
  | "reason"
  | "policyVersion"
  | "scopeAcknowledged"
  | "typedEmail";

export type SubscriberStatusConsentErrors = Partial<
  Record<SubscriberStatusConsentField, string>
>;

const JURISDICTION_PATTERN = /^[A-Z][A-Z0-9-]{1,31}$/;
const FORBIDDEN_SINGLE_LINE_CONTROL = /[\p{Cc}\p{Cf}]/u;
const FORBIDDEN_MULTILINE_CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/u;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function emptyDraft(
  defaultJurisdiction?: string | null,
): SubscriberStatusConsentDraft {
  return {
    source: "",
    channel: "",
    legalBasis: "",
    capturedAt: "",
    jurisdiction: (defaultJurisdiction ?? "").trim().toUpperCase(),
    evidence: "",
    reason: "",
    policyVersion: "",
    scopeAcknowledged: false,
    typedEmail: "",
  };
}

export function validateSubscriberStatusConsentDraft(
  draft: SubscriberStatusConsentDraft,
  canonicalEmail: string,
  now = Date.now(),
): SubscriberStatusConsentErrors {
  const errors: SubscriberStatusConsentErrors = {};
  if (draft.source !== "double_optin" && draft.source !== "single_optin") {
    errors.source = "Choose the reviewed opt-in record that proves this grant.";
  }
  if (
    !CONSENT_EVIDENCE_CHANNELS.some(
      (option) => option.value === draft.channel.trim(),
    )
  ) {
    errors.channel = "Choose where the subscriber's decision was captured.";
  }
  if (
    !CONSENT_LEGAL_BASES.some(
      (option) => option.value === draft.legalBasis.trim(),
    )
  ) {
    errors.legalBasis = "Choose the legal basis confirmed during review.";
  }
  const captured = Date.parse(draft.capturedAt);
  if (!Number.isFinite(captured)) {
    errors.capturedAt = "Enter when this consent was actually captured.";
  } else if (captured > now + 5 * 60_000) {
    errors.capturedAt = "The captured time cannot be in the future.";
  }
  const jurisdiction = draft.jurisdiction.trim().toUpperCase();
  if (!JURISDICTION_PATTERN.test(jurisdiction)) {
    errors.jurisdiction =
      "Use a 2–32 character jurisdiction code such as GB, EU, or US-CA.";
  }
  const evidence = draft.evidence.trim();
  if (!evidence) {
    errors.evidence =
      "Enter a durable receipt, record, or approved evidence reference.";
  } else if (
    utf8Bytes(evidence) > 2_048 ||
    FORBIDDEN_MULTILINE_CONTROL.test(evidence)
  ) {
    errors.evidence =
      "Use no more than 2,048 UTF-8 bytes and remove invisible control characters.";
  }
  const reason = draft.reason.trim();
  if (!reason) {
    errors.reason = "Explain why the reviewed record proves this email grant.";
  } else if (
    utf8Bytes(reason) > 500 ||
    FORBIDDEN_MULTILINE_CONTROL.test(reason)
  ) {
    errors.reason =
      "Use no more than 500 UTF-8 bytes and remove invisible control characters.";
  }
  const policyVersion = draft.policyVersion.trim();
  if (!policyVersion) {
    errors.policyVersion = "Enter the policy version in force at capture time.";
  } else if (
    utf8Bytes(policyVersion) > 100 ||
    FORBIDDEN_SINGLE_LINE_CONTROL.test(policyVersion)
  ) {
    errors.policyVersion =
      "Use no more than 100 UTF-8 bytes and remove invisible control characters.";
  }
  if (!draft.scopeAcknowledged) {
    errors.scopeAcknowledged =
      "Confirm that the reviewed proof applies to this exact address and email marketing only.";
  }
  if (draft.typedEmail !== canonicalEmail) {
    errors.typedEmail = `Type ${canonicalEmail} exactly to confirm the address.`;
  }
  return errors;
}

export function buildSubscriberStatusConsentPatch(
  draft: SubscriberStatusConsentDraft,
  canonicalEmail: string,
  now = Date.now(),
): SubscriberEnableConsentInput | null {
  if (
    Object.keys(
      validateSubscriberStatusConsentDraft(draft, canonicalEmail, now),
    ).length > 0 ||
    draft.source === ""
  ) {
    return null;
  }
  const captured = Date.parse(draft.capturedAt);
  if (!Number.isFinite(captured)) return null;
  return {
    status: "enabled",
    consent_source: draft.source,
    consent_timestamp: new Date(captured).toISOString(),
    consent_channel: draft.channel.trim(),
    consent_legal_basis: draft.legalBasis.trim(),
    consent_jurisdiction: draft.jurisdiction.trim().toUpperCase(),
    consent_evidence: draft.evidence.trim(),
    consent_reason: draft.reason.trim(),
    consent_policy_version: draft.policyVersion.trim(),
  };
}

function safeMutationError(status?: number, code?: string): string {
  if (code === "aborted") return "The review request was cancelled.";
  if (status === 409 || status === 412) {
    return "This subscriber changed after the review began. Refresh the record and review the current state before trying again.";
  }
  if (status === 400 || status === 422) {
    return "The server rejected this consent envelope. Recheck every evidence field and try again.";
  }
  return "The consent decision could not be confirmed online. No success was accepted in this view; reconnect and refresh the subscriber before trying again.";
}

export function SubscriberStatusConsentModal({
  target,
  defaultJurisdiction,
  onClose,
  onEnabled,
  onBusyChange,
}: SubscriberStatusConsentModalProps): ReactElement | null {
  const targetKey = target
    ? `${typeof target.id}:${String(target.id)}:${target.email}`
    : "closed";
  const [draft, setDraft] = useState<SubscriberStatusConsentDraft>(() =>
    emptyDraft(defaultJurisdiction),
  );
  const [attempted, setAttempted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sourceRef = useRef<HTMLSelectElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const errorSummaryRef = useRef<HTMLDivElement | null>(null);
  const inFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const onBusyChangeRef = useRef(onBusyChange);
  const errorRootId = useId();
  onBusyChangeRef.current = onBusyChange;

  useEffect(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    inFlightRef.current = false;
    setBusy(false);
    onBusyChangeRef.current?.(false);
    setAttempted(false);
    setSubmitError(null);
    setDraft(emptyDraft(defaultJurisdiction));
  }, [defaultJurisdiction, targetKey]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      inFlightRef.current = false;
      onBusyChangeRef.current?.(false);
    },
    [],
  );

  const errors = useMemo(
    () =>
      target ? validateSubscriberStatusConsentDraft(draft, target.email) : {},
    [draft, target],
  );
  const localTimezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "local time",
    [],
  );
  const completedChecks = 10 - Object.keys(errors).length;
  const visibleErrors = attempted ? errors : {};
  const update = <K extends keyof SubscriberStatusConsentDraft>(
    key: K,
    value: SubscriberStatusConsentDraft[K],
  ): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSubmitError(null);
  };

  const submit = async (): Promise<void> => {
    if (!target || inFlightRef.current) return;
    setAttempted(true);
    setSubmitError(null);
    const patch = buildSubscriberStatusConsentPatch(draft, target.email);
    if (!patch) {
      window.requestAnimationFrame(() => {
        const firstInvalid = formRef.current?.querySelector<HTMLElement>(
          '[aria-invalid="true"]',
        );
        (firstInvalid ?? errorSummaryRef.current)?.focus();
      });
      return;
    }

    inFlightRef.current = true;
    const generation = generationRef.current;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setBusy(true);
    onBusyChangeRef.current?.(true);
    try {
      const result = await api.updateSubscriber(target.id, patch, {
        version: target.version,
        signal: controller.signal,
        requireOnline: true,
        maxAttempts: 1,
      });
      if (generation !== generationRef.current || controller.signal.aborted) {
        return;
      }
      if (result.queued) {
        setSubmitError(
          "This high-consequence consent change was not confirmed online and cannot be queued. Reconnect and try again.",
        );
        return;
      }
      if (result.error) {
        setSubmitError(
          safeMutationError(result.error.status, result.error.code),
        );
        return;
      }
      if (
        result.data.email.trim().toLowerCase() !==
          target.email.trim().toLowerCase() ||
        result.data.status?.trim().toLowerCase() !== "enabled" ||
        result.data.consent_source?.trim().toLowerCase() !==
          patch.consent_source ||
        Date.parse(result.data.consent_timestamp ?? "") !==
          Date.parse(patch.consent_timestamp) ||
        Date.parse(result.data.consent_email_marketing_at ?? "") !==
          Date.parse(patch.consent_timestamp)
      ) {
        setSubmitError(
          "The server response did not verify this exact address and its email-marketing grant. No success was accepted in this view; refresh before trying again.",
        );
        return;
      }
      onEnabled(result.data);
      toast.success({
        message: `Consent recorded for ${target.email}`,
        detail:
          "The profile is enabled. Independent bounce, complaint, erasure, and manual suppressions still apply.",
      });
      onClose();
    } catch {
      if (generation === generationRef.current && !controller.signal.aborted) {
        setSubmitError(safeMutationError());
      }
    } finally {
      if (generation === generationRef.current) {
        inFlightRef.current = false;
        if (abortRef.current === controller) abortRef.current = null;
        setBusy(false);
        onBusyChangeRef.current?.(false);
      }
    }
  };

  if (!target) return null;
  const currentStatus = engineStatusToUi(target.status);
  const currentStatusLabel = UI_STATUS_LABELS[currentStatus];
  const suppressed = currentStatus === "unsubscribed";
  return (
    <Modal
      open
      role="alertdialog"
      size="lg"
      title="Review consent before enabling"
      description={`This creates a new email-marketing grant for ${target.email}.`}
      initialFocusRef={sourceRef}
      closeOnBackdrop={false}
      closeOnEscape={!busy}
      closeDisabled={busy}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        ref={formRef}
        className="subscriber-status-consent"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="subscriber-status-consent__scope" role="note">
          <div>
            <MailCheck aria-hidden="true" size={20} />
            <span>
              <strong>One exact address</strong>
              {target.email}
            </span>
          </div>
          <div>
            <FileCheck2 aria-hidden="true" size={20} />
            <span>
              <strong>Email marketing only</strong>
              No SMS, profiling, or ad consent
            </span>
          </div>
          <div>
            <ShieldCheck aria-hidden="true" size={20} />
            <span>
              <strong>Online and audited</strong>
              Immutable evidence is written atomically
            </span>
          </div>
        </div>

        <div className="subscriber-status-consent__transition">
          <span className="badge warning">{currentStatusLabel}</span>
          <span aria-hidden="true">→</span>
          <span className="badge success">Enabled profile</span>
        </div>

        <div className="subscriber-status-consent__notice">
          <AlertTriangle aria-hidden="true" size={18} />
          <span>
            <strong>This is not an operator opt-in.</strong> Record only a
            decision the subscriber already made and whose source evidence you
            reviewed. Enabling the profile does not clear independent bounce,
            complaint, erasure, or manual suppressions.
          </span>
        </div>
        {suppressed ? (
          <div className="subscriber-status-consent__suppression-note">
            This profile is currently shown as unsubscribed or blocklisted. The
            consent grant may enable its profile status, but protected
            suppression records remain in force and must be reviewed in
            Suppressions.
          </div>
        ) : null}

        {attempted && Object.keys(errors).length > 0 ? (
          <div
            ref={errorSummaryRef}
            className="subscriber-status-consent__errors"
            role="alert"
            tabIndex={-1}
          >
            Complete the {Object.keys(errors).length} highlighted review field
            {Object.keys(errors).length === 1 ? "" : "s"} before enabling.
          </div>
        ) : null}
        {submitError ? (
          <div
            className="subscriber-status-consent__errors"
            role="alert"
            tabIndex={-1}
          >
            {submitError}
          </div>
        ) : null}

        <fieldset disabled={busy}>
          <legend>Reviewed consent evidence</legend>
          <div className="subscriber-status-consent__grid">
            <FormField
              label="Opt-in source"
              required
              htmlFor={`${errorRootId}-source`}
              error={visibleErrors.source ?? null}
            >
              <select
                ref={sourceRef}
                id={`${errorRootId}-source`}
                className="input"
                value={draft.source}
                aria-invalid={Boolean(visibleErrors.source) || undefined}
                onChange={(event) =>
                  update(
                    "source",
                    event.currentTarget
                      .value as SubscriberStatusConsentDraft["source"],
                  )
                }
              >
                <option value="">Select reviewed proof…</option>
                {CONSENT_PROVENANCE_SOURCES.filter(
                  (option) =>
                    option.value === "double_optin" ||
                    option.value === "single_optin",
                ).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField
              label="Capture channel"
              required
              htmlFor={`${errorRootId}-channel`}
              error={visibleErrors.channel ?? null}
            >
              <select
                id={`${errorRootId}-channel`}
                className="input"
                value={draft.channel}
                aria-invalid={Boolean(visibleErrors.channel) || undefined}
                onChange={(event) =>
                  update("channel", event.currentTarget.value)
                }
              >
                <option value="">Select channel…</option>
                {CONSENT_EVIDENCE_CHANNELS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField
              label="Legal basis"
              required
              htmlFor={`${errorRootId}-basis`}
              error={visibleErrors.legalBasis ?? null}
            >
              <select
                id={`${errorRootId}-basis`}
                className="input"
                value={draft.legalBasis}
                aria-invalid={Boolean(visibleErrors.legalBasis) || undefined}
                onChange={(event) =>
                  update("legalBasis", event.currentTarget.value)
                }
              >
                <option value="">Select basis…</option>
                {CONSENT_LEGAL_BASES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField
              label="Consent captured at"
              required
              htmlFor={`${errorRootId}-captured`}
              help={`Interpreted in ${localTimezone} and stored as UTC.`}
              error={visibleErrors.capturedAt ?? null}
            >
              <input
                id={`${errorRootId}-captured`}
                type="datetime-local"
                className="input"
                value={draft.capturedAt}
                aria-invalid={Boolean(visibleErrors.capturedAt) || undefined}
                onChange={(event) =>
                  update("capturedAt", event.currentTarget.value)
                }
              />
            </FormField>
            <FormField
              label="Governing jurisdiction"
              required
              htmlFor={`${errorRootId}-jurisdiction`}
              help="Use a reviewed code such as GB, EU, or US-CA."
              error={visibleErrors.jurisdiction ?? null}
            >
              <input
                id={`${errorRootId}-jurisdiction`}
                className="input"
                value={draft.jurisdiction}
                maxLength={32}
                autoCapitalize="characters"
                placeholder="GB"
                aria-invalid={Boolean(visibleErrors.jurisdiction) || undefined}
                onChange={(event) =>
                  update("jurisdiction", event.currentTarget.value)
                }
              />
            </FormField>
            <FormField
              label="Policy version"
              required
              htmlFor={`${errorRootId}-policy`}
              help={`${utf8Bytes(draft.policyVersion.trim()).toLocaleString()} / 100 UTF-8 bytes`}
              error={visibleErrors.policyVersion ?? null}
            >
              <input
                id={`${errorRootId}-policy`}
                className="input"
                value={draft.policyVersion}
                autoComplete="off"
                placeholder="privacy-2026-07"
                aria-invalid={Boolean(visibleErrors.policyVersion) || undefined}
                onChange={(event) =>
                  update("policyVersion", event.currentTarget.value)
                }
              />
            </FormField>
          </div>
          <FormField
            label="Durable evidence reference"
            required
            htmlFor={`${errorRootId}-evidence`}
            help={`${utf8Bytes(draft.evidence.trim()).toLocaleString()} / 2,048 UTF-8 bytes · cite the record, not secret credentials`}
            error={visibleErrors.evidence ?? null}
          >
            <textarea
              id={`${errorRootId}-evidence`}
              className="input"
              rows={2}
              value={draft.evidence}
              spellCheck={false}
              placeholder="receipt:CONSENT-123 or an approved evidence URL"
              aria-invalid={Boolean(visibleErrors.evidence) || undefined}
              onChange={(event) =>
                update("evidence", event.currentTarget.value)
              }
            />
          </FormField>
          <FormField
            label="Operator review reason"
            required
            htmlFor={`${errorRootId}-reason`}
            help={`${utf8Bytes(draft.reason.trim()).toLocaleString()} / 500 UTF-8 bytes`}
            error={visibleErrors.reason ?? null}
          >
            <textarea
              id={`${errorRootId}-reason`}
              className="input"
              rows={3}
              value={draft.reason}
              placeholder="Why this reviewed record proves permission for this address"
              aria-invalid={Boolean(visibleErrors.reason) || undefined}
              onChange={(event) => update("reason", event.currentTarget.value)}
            />
          </FormField>
        </fieldset>

        <div className="subscriber-status-consent__confirm">
          <label>
            <input
              type="checkbox"
              checked={draft.scopeAcknowledged}
              disabled={busy}
              aria-invalid={
                Boolean(visibleErrors.scopeAcknowledged) || undefined
              }
              onChange={(event) =>
                update("scopeAcknowledged", event.currentTarget.checked)
              }
            />
            <span>
              I reviewed the source proof and confirm it applies to the exact
              address <strong>{target.email}</strong> for email marketing only.
            </span>
          </label>
          {visibleErrors.scopeAcknowledged ? (
            <span className="field-error">
              {visibleErrors.scopeAcknowledged}
            </span>
          ) : null}
          <FormField
            label={
              <>
                Type <strong>{target.email}</strong> exactly to authorize this
                grant
              </>
            }
            required
            htmlFor={`${errorRootId}-email`}
            error={visibleErrors.typedEmail ?? null}
          >
            <input
              id={`${errorRootId}-email`}
              type="email"
              className="input"
              value={draft.typedEmail}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(visibleErrors.typedEmail) || undefined}
              onChange={(event) =>
                update("typedEmail", event.currentTarget.value)
              }
            />
          </FormField>
        </div>

        <div
          className="subscriber-status-consent__readiness"
          role="status"
          aria-live="polite"
        >
          <span>Review completeness</span>
          <progress value={completedChecks} max={10}>
            {completedChecks} of 10
          </progress>
          <strong>{completedChecks} / 10</strong>
        </div>

        <ModalFooter>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Recording consent evidence…" : "Record consent & enable"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
