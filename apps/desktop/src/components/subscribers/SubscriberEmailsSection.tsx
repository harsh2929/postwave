/**
 * Per-address identity, consent, and suppression controls for Subscriber
 * Detail. The canonical delivery identity is owned by the profile editor;
 * this surface manages alternate addresses without pretending a side-table
 * toggle can redirect campaign delivery.
 */

import {
  type Dispatch,
  type ReactElement,
  type SetStateAction,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  MAX_EMAILS_PER_PROFILE,
  type SubscriberEmail,
  type SubscriberEmailConsent,
  api,
} from "../../lib/api-client";
import { redact } from "../../lib/auth";
import { fmtDate } from "../../lib/format-date";
import { FormField } from "../FormField";
import { InlineHelp } from "../InlineHelp";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import {
  CONSENT_EVIDENCE_CHANNELS,
  CONSENT_LEGAL_BASES,
  CONSENT_PROVENANCE_SOURCES,
  consentEvidenceError,
  consentEvidencePayload,
  emptyConsentEvidenceDraft,
  type ConsentEvidenceDraft,
} from "./consent-evidence";

interface Props {
  subscriberId: string;
  /** Exact parent profile revision required when attaching an address. */
  subscriberVersion?: string;
  canonicalEmail: string;
  canMutate: boolean;
  onUnavailable?: () => void;
}

const CONSENT_OPTIONS: SubscriberEmailConsent[] = [
  "subscribed",
  "unsubscribed",
  "never_subscribed",
  "pending",
  "unknown",
];

const CONSENT_LABELS: Record<SubscriberEmailConsent, string> = {
  subscribed: "Subscribed",
  unsubscribed: "Unsubscribed",
  never_subscribed: "Never subscribed",
  pending: "Pending",
  unknown: "Unknown",
};

interface SuppressionDraft {
  reason: string;
  evidence: string;
  acknowledged: boolean;
  confirmation: string;
}

function emptySuppressionDraft(): SuppressionDraft {
  return { reason: "", evidence: "", acknowledged: false, confirmation: "" };
}

function consentTone(status: string): string {
  switch (status.toLowerCase()) {
    case "subscribed":
      return "badge success";
    case "unsubscribed":
      return "badge danger";
    case "never_subscribed":
    case "pending":
      return "badge warning";
    default:
      return "badge";
  }
}

function consentLabel(status: string): string {
  return CONSENT_LABELS[status as SubscriberEmailConsent] ?? "Unknown";
}

function addressDisposition(row: SubscriberEmail): string {
  if (row.suppressed) return "Delivery held by this address's suppression.";
  if (row.consent_status !== "subscribed") {
    return "Marketing delivery held by this address's consent state.";
  }
  if (!row.is_primary) {
    return "Not used for delivery unless selected in the profile editor.";
  }
  return "Address-level checks pass; campaign policy and global suppression still apply.";
}

function apiErrorDetail(message: string): string {
  return redact(message) || "The service did not provide a safe error detail.";
}

function normalizeAddressRecord(value: unknown): SubscriberEmail | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const requiredStrings = [
    "id",
    "subscriber_id",
    "email",
    "consent_status",
    "created_at",
    "updated_at",
  ] as const;
  if (
    requiredStrings.some(
      (key) => typeof row[key] !== "string" || !String(row[key]).trim(),
    ) ||
    typeof row.is_primary !== "boolean" ||
    typeof row.suppressed !== "boolean" ||
    !CONSENT_OPTIONS.includes(row.consent_status as SubscriberEmailConsent) ||
    String(row.email).length > 254 ||
    !Number.isFinite(Date.parse(String(row.created_at))) ||
    !Number.isFinite(Date.parse(String(row.updated_at)))
  ) {
    return null;
  }
  if (
    row.last_engaged_at != null &&
    (typeof row.last_engaged_at !== "string" ||
      !Number.isFinite(Date.parse(row.last_engaged_at)))
  ) {
    return null;
  }
  const rawVersion = typeof row.version === "string" ? row.version.trim() : "";
  const version =
    rawVersion.length <= 256 && !/[\r\n]/.test(rawVersion) ? rawVersion : "";
  return {
    id: String(row.id),
    subscriber_id: String(row.subscriber_id),
    email: String(row.email),
    is_primary: row.is_primary,
    consent_status: String(row.consent_status),
    suppressed: row.suppressed,
    ...(typeof row.last_engaged_at === "string"
      ? { last_engaged_at: row.last_engaged_at }
      : {}),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    version,
  };
}

function normalizeAddressList(value: unknown): SubscriberEmail[] | null {
  if (!Array.isArray(value) || value.length > MAX_EMAILS_PER_PROFILE)
    return null;
  const rows: SubscriberEmail[] = [];
  const ids = new Set<string>();
  const addresses = new Set<string>();
  let primaryCount = 0;
  let owner = "";
  for (const candidate of value) {
    const row = normalizeAddressRecord(candidate);
    if (!row) return null;
    const addressKey = row.email.toLowerCase();
    if (ids.has(row.id) || addresses.has(addressKey)) return null;
    if (owner && owner !== row.subscriber_id) return null;
    owner = row.subscriber_id;
    ids.add(row.id);
    addresses.add(addressKey);
    if (row.is_primary) primaryCount += 1;
    if (primaryCount > 1) return null;
    rows.push(row);
  }
  return rows;
}

export function SubscriberEmailsSection({
  subscriberId,
  subscriberVersion,
  canonicalEmail,
  canMutate,
  onUnavailable,
}: Props): ReactElement | null {
  const [emails, setEmails] = useState<SubscriberEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newEmailError, setNewEmailError] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [pendingConsent, setPendingConsent] = useState<SubscriberEmail | null>(
    null,
  );
  const [consentTarget, setConsentTarget] =
    useState<SubscriberEmailConsent>("subscribed");
  const [consentDraft, setConsentDraft] = useState(emptyConsentEvidenceDraft);
  const [pendingSuppression, setPendingSuppression] =
    useState<SubscriberEmail | null>(null);
  const [suppressionDraft, setSuppressionDraft] = useState(
    emptySuppressionDraft,
  );
  const [pendingRemoval, setPendingRemoval] = useState<SubscriberEmail | null>(
    null,
  );
  const [removalConfirmation, setRemovalConfirmation] = useState("");

  const operationRef = useRef<string | null>(null);
  const mutationAbortRef = useRef<AbortController | null>(null);
  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const unavailableRef = useRef(onUnavailable);
  const permissionReasonId = useId();
  const canonicalReasonId = useId();
  const revisionReasonId = useId();

  useEffect(() => {
    unavailableRef.current = onUnavailable;
  }, [onUnavailable]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setEmails([]);
    void (async () => {
      const result = await api.listSubscriberEmails(subscriberId, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setLoading(false);
      if (result.error) {
        if (result.error.kind === "http" && result.error.status === 404) {
          unavailableRef.current?.();
          return;
        }
        setLoadError(apiErrorDetail(result.error.message));
        return;
      }
      const normalized = normalizeAddressList(result.data.items);
      if (!normalized) {
        setLoadError(
          "The service returned an invalid address contract. No address actions are available.",
        );
        return;
      }
      setEmails(normalized);
    })();
    return () => controller.abort();
  }, [subscriberId, loadRevision]);

  useEffect(() => {
    mutationAbortRef.current?.abort();
    operationRef.current = null;
    setRowBusy(null);
    setPendingConsent(null);
    setPendingSuppression(null);
    setPendingRemoval(null);
    setNewEmail("");
    setNewEmailError(null);
    return () => mutationAbortRef.current?.abort();
  }, [subscriberId]);

  const retryLoad = (): void => setLoadRevision((revision) => revision + 1);
  const atCap = emails.length >= MAX_EMAILS_PER_PROFILE;
  const canonicalPresent = emails.some((row) => row.is_primary);
  const missingRevisions = emails.some((row) => !row.version);
  const missingSubscriberRevision = !subscriberVersion;
  const anyOperation = operationRef.current != null;

  const beginOperation = (key: string): AbortController | null => {
    if (operationRef.current) return null;
    const controller = new AbortController();
    operationRef.current = key;
    mutationAbortRef.current = controller;
    setRowBusy(key);
    return controller;
  };

  const finishOperation = (key: string): void => {
    if (operationRef.current !== key) return;
    operationRef.current = null;
    mutationAbortRef.current = null;
    setRowBusy(null);
  };

  const handleStaleRevision = (status: number | null | undefined): boolean => {
    if (status !== 412 && status !== 428) return false;
    toast.error({
      message: "Address changed in another session",
      detail:
        "The latest address state is being loaded. Review it before trying again.",
    });
    setPendingConsent(null);
    setPendingSuppression(null);
    setPendingRemoval(null);
    retryLoad();
    return true;
  };

  const validateNewEmail = (): string | null => {
    const value = newEmail.trim();
    if (!value) return "Enter an email address.";
    if (value.length > 254)
      return "Email addresses must be 254 characters or fewer.";
    if (emailInputRef.current && !emailInputRef.current.validity.valid) {
      return "Enter a valid email address.";
    }
    if (
      !canonicalPresent &&
      value.toLowerCase() !== canonicalEmail.trim().toLowerCase()
    ) {
      return `The missing canonical row must be repaired with ${canonicalEmail}.`;
    }
    return null;
  };

  const addEmail = async (): Promise<void> => {
    if (!canMutate || atCap || !subscriberVersion) return;
    const validation = validateNewEmail();
    setNewEmailError(validation);
    if (validation) return;
    const key = "add";
    const controller = beginOperation(key);
    if (!controller) return;
    const address = newEmail.trim();
    try {
      const result = await api.addSubscriberEmail(
        subscriberId,
        { email: address },
        subscriberVersion,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (result.error) {
        const status =
          result.error.kind === "http" ? result.error.status : null;
        if (handleStaleRevision(status)) return;
        toast.error({
          message:
            status === 409
              ? "Address already belongs to a profile"
              : "Couldn't add address",
          detail: apiErrorDetail(result.error.message),
        });
        return;
      }
      const added = normalizeAddressRecord(result.data);
      if (!added) {
        toast.error({
          message: "Address wasn't reconciled",
          detail:
            "The service returned an invalid address contract. Reload before continuing.",
        });
        retryLoad();
        return;
      }
      setEmails((current) =>
        [...current, added].sort(
          (a, b) =>
            Number(b.is_primary) - Number(a.is_primary) ||
            a.created_at.localeCompare(b.created_at),
        ),
      );
      setNewEmail("");
      setNewEmailError(null);
      setAnnouncement(`${added.email} added as never subscribed.`);
      toast.success({
        message: "Address added",
        detail:
          "It starts as never subscribed. Record evidence before granting consent.",
      });
    } catch {
      if (!controller.signal.aborted)
        toast.error("Couldn't add the address. Try again.");
    } finally {
      finishOperation(key);
    }
  };

  const openConsentReview = (row: SubscriberEmail): void => {
    if (!canMutate || operationRef.current) return;
    if (!row.version) {
      toast.error(
        "Reload after the address API is upgraded before changing consent.",
      );
      return;
    }
    const defaultTarget: SubscriberEmailConsent =
      row.consent_status === "subscribed" ? "unsubscribed" : "subscribed";
    setConsentTarget(defaultTarget);
    setConsentDraft(emptyConsentEvidenceDraft());
    setPendingConsent(row);
  };

  const commitConsent = async (): Promise<void> => {
    const row = pendingConsent;
    if (
      !row ||
      !row.version ||
      !canMutate ||
      consentTarget === row.consent_status
    )
      return;
    const validation = consentEvidenceError(consentDraft, {
      requireEvidence: true,
      requireScope: true,
    });
    const payload = consentEvidencePayload(consentDraft);
    const grantConfirmationMissing =
      consentTarget === "subscribed" &&
      consentDraft.confirmation.trim().toLowerCase() !==
        row.email.toLowerCase();
    if (validation || !payload || grantConfirmationMissing) {
      toast.error(
        validation ??
          `Type ${row.email} exactly to confirm this address-level grant.`,
      );
      return;
    }
    const key = row.id;
    const controller = beginOperation(key);
    if (!controller) return;
    try {
      const result = await api.updateSubscriberEmail(
        subscriberId,
        row.id,
        { consent_status: consentTarget, ...payload },
        row.version,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (result.error) {
        const status =
          result.error.kind === "http" ? result.error.status : null;
        if (handleStaleRevision(status)) return;
        toast.error({
          message: "Couldn't record consent decision",
          detail: apiErrorDetail(result.error.message),
        });
        return;
      }
      const updated = normalizeAddressRecord(result.data);
      if (!updated) {
        toast.error({
          message: "Consent response couldn't be verified",
          detail:
            "The latest state is being reloaded before another change is allowed.",
        });
        setPendingConsent(null);
        retryLoad();
        return;
      }
      setEmails((current) =>
        current.map((item) => (item.id === row.id ? updated : item)),
      );
      setPendingConsent(null);
      setAnnouncement(
        `${row.email} consent is now ${consentLabel(consentTarget)}.`,
      );
      toast.success({
        message: "Consent decision recorded",
        detail: `${row.email} is now ${consentLabel(consentTarget).toLowerCase()}.`,
      });
    } catch {
      if (!controller.signal.aborted)
        toast.error("Couldn't record consent. Try again.");
    } finally {
      finishOperation(key);
    }
  };

  const openSuppressionReview = (row: SubscriberEmail): void => {
    if (!canMutate || operationRef.current) return;
    if (!row.version) {
      toast.error(
        "Reload after the address API is upgraded before changing suppression.",
      );
      return;
    }
    setSuppressionDraft(emptySuppressionDraft());
    setPendingSuppression(row);
  };

  const suppressionValidation = (): string | null => {
    const row = pendingSuppression;
    if (!row) return "Choose an address.";
    const reason = suppressionDraft.reason.trim();
    const evidence = suppressionDraft.evidence.trim();
    if (!reason) return "Explain why this suppression state is changing.";
    if (reason.length > 500) return "Reason must be 500 characters or fewer.";
    if (evidence.length > 2_048)
      return "Evidence must be 2,048 characters or fewer.";
    if (row.suppressed && !evidence)
      return "Provide evidence before restoring delivery.";
    if (!suppressionDraft.acknowledged)
      return "Acknowledge the delivery impact.";
    if (
      row.suppressed &&
      suppressionDraft.confirmation.trim().toLowerCase() !==
        row.email.toLowerCase()
    ) {
      return `Type ${row.email} exactly to restore this address.`;
    }
    return null;
  };

  const commitSuppression = async (): Promise<void> => {
    const row = pendingSuppression;
    if (!row || !row.version || !canMutate) return;
    const validation = suppressionValidation();
    if (validation) {
      toast.error(validation);
      return;
    }
    const key = row.id;
    const controller = beginOperation(key);
    if (!controller) return;
    try {
      const result = await api.updateSubscriberEmail(
        subscriberId,
        row.id,
        {
          suppressed: !row.suppressed,
          suppression_reason: suppressionDraft.reason.trim(),
          suppression_evidence: suppressionDraft.evidence.trim() || undefined,
        },
        row.version,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (result.error) {
        const status =
          result.error.kind === "http" ? result.error.status : null;
        if (handleStaleRevision(status)) return;
        toast.error({
          message: "Couldn't update suppression",
          detail: apiErrorDetail(result.error.message),
        });
        return;
      }
      const updated = normalizeAddressRecord(result.data);
      if (!updated) {
        toast.error({
          message: "Suppression response couldn't be verified",
          detail:
            "The latest state is being reloaded before another change is allowed.",
        });
        setPendingSuppression(null);
        retryLoad();
        return;
      }
      setEmails((current) =>
        current.map((item) => (item.id === row.id ? updated : item)),
      );
      setPendingSuppression(null);
      setAnnouncement(
        `${row.email} ${updated.suppressed ? "suppressed" : "restored"}.`,
      );
      toast.success({
        message: updated.suppressed ? "Address suppressed" : "Address restored",
        detail: updated.suppressed
          ? "Delivery is now held for this address."
          : "Address suppression was removed; consent and global safety checks still apply.",
      });
    } catch {
      if (!controller.signal.aborted)
        toast.error("Couldn't update suppression. Try again.");
    } finally {
      finishOperation(key);
    }
  };

  const openRemovalReview = (row: SubscriberEmail): void => {
    if (!canMutate || row.is_primary || operationRef.current) return;
    if (!row.version) {
      toast.error(
        "Reload after the address API is upgraded before removing it.",
      );
      return;
    }
    setRemovalConfirmation("");
    setPendingRemoval(row);
  };

  const commitRemoval = async (): Promise<void> => {
    const row = pendingRemoval;
    if (
      !row ||
      !row.version ||
      !canMutate ||
      row.is_primary ||
      removalConfirmation.trim().toLowerCase() !== row.email.toLowerCase()
    ) {
      return;
    }
    const key = row.id;
    const controller = beginOperation(key);
    if (!controller) return;
    try {
      const result = await api.deleteSubscriberEmail(
        subscriberId,
        row.id,
        row.version,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (result.error) {
        const status =
          result.error.kind === "http" ? result.error.status : null;
        if (handleStaleRevision(status)) return;
        toast.error({
          message: "Couldn't remove address",
          detail: apiErrorDetail(result.error.message),
        });
        return;
      }
      setEmails((current) => current.filter((item) => item.id !== row.id));
      setPendingRemoval(null);
      setAnnouncement(`${row.email} removed from this profile.`);
      toast.success({
        message: "Alternate address removed",
        detail: row.email,
      });
    } catch {
      if (!controller.signal.aborted)
        toast.error("Couldn't remove the address. Try again.");
    } finally {
      finishOperation(key);
    }
  };

  return (
    <section
      className="subscriber-addresses"
      aria-labelledby={`${permissionReasonId}-title`}
    >
      <div className="subscriber-addresses__heading">
        <div>
          <div
            className="label subscriber-addresses__title"
            id={`${permissionReasonId}-title`}
          >
            Email identities
            <InlineHelp text="The profile editor owns the canonical delivery address. Alternate addresses retain independent consent and suppression evidence." />
          </div>
          <p className="subscriber-addresses__intro">
            One delivery identity, up to {MAX_EMAILS_PER_PROFILE - 1}{" "}
            alternates. New addresses start held until reviewed evidence is
            recorded.
          </p>
        </div>
        <span
          className="subscriber-addresses__capacity tabular"
          aria-label={`${emails.length} of ${MAX_EMAILS_PER_PROFILE} addresses used`}
        >
          {emails.length}/{MAX_EMAILS_PER_PROFILE}
        </span>
      </div>

      <span className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </span>

      {loading ? (
        <AddressSkeleton />
      ) : loadError ? (
        <div className="subscriber-addresses__state" role="alert">
          <strong>Addresses couldn't be loaded.</strong>
          <span>{loadError}</span>
          <button type="button" className="btn btn-sm" onClick={retryLoad}>
            Try again
          </button>
        </div>
      ) : (
        <>
          {!canonicalPresent ? (
            <div className="subscriber-addresses__warning" role="status">
              <strong>Canonical address record needs repair.</strong>
              <span>
                Add <b>{canonicalEmail}</b> below. It will start as never
                subscribed; existing permission is not inferred.
              </span>
            </div>
          ) : null}
          {missingRevisions ? (
            <div
              className="subscriber-addresses__warning"
              id={revisionReasonId}
              role="status"
            >
              <strong>Address actions are temporarily held.</strong>
              <span>
                This deployment did not return revision tokens. Reload after the
                address API upgrade completes; Moosewave will not perform an
                unconditional consent or suppression write.
              </span>
            </div>
          ) : null}
          {missingSubscriberRevision && canMutate ? (
            <div className="subscriber-addresses__warning" role="status">
              <strong>Adding addresses is temporarily held.</strong>
              <span>
                Reload the subscriber to obtain its exact profile revision.
                Existing address state remains available for review.
              </span>
            </div>
          ) : null}
          <div className="subscriber-addresses__list">
            {emails.map((row) => (
              <AddressRow
                key={row.id}
                row={row}
                canMutate={canMutate}
                busy={rowBusy === row.id}
                operationActive={rowBusy != null}
                permissionReasonId={permissionReasonId}
                canonicalReasonId={canonicalReasonId}
                revisionReasonId={revisionReasonId}
                onConsent={() => openConsentReview(row)}
                onSuppression={() => openSuppressionReview(row)}
                onRemove={() => openRemovalReview(row)}
              />
            ))}
          </div>
          {emails.length === 0 ? (
            <div className="subscriber-addresses__empty">
              No per-address records exist yet. Repair the canonical address
              below.
            </div>
          ) : null}

          {!canMutate ? (
            <p
              id={permissionReasonId}
              className="subscriber-addresses__guidance"
              role="status"
            >
              Viewer access can inspect address state but cannot change it.
            </p>
          ) : null}
          <p id={canonicalReasonId} className="subscriber-addresses__guidance">
            Change the delivery address in the profile editor before removing
            the current canonical address.
          </p>

          {atCap ? (
            <div className="subscriber-addresses__capacity-note">
              Address capacity reached. Remove an unused alternate before adding
              another.
            </div>
          ) : (
            <form
              className="subscriber-addresses__add"
              onSubmit={(event) => {
                event.preventDefault();
                void addEmail();
              }}
              noValidate
            >
              <FormField
                label={
                  canonicalPresent
                    ? "Add alternate address"
                    : "Repair canonical address"
                }
                error={newEmailError}
              >
                <input
                  ref={emailInputRef}
                  className="input"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  maxLength={254}
                  value={newEmail}
                  disabled={
                    !canMutate || anyOperation || missingSubscriberRevision
                  }
                  placeholder={
                    canonicalPresent ? "name@example.com" : canonicalEmail
                  }
                  onChange={(event) => {
                    setNewEmail(event.target.value);
                    if (newEmailError) setNewEmailError(null);
                  }}
                  aria-describedby={`${permissionReasonId}-add-note`}
                />
              </FormField>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={
                  !canMutate ||
                  anyOperation ||
                  missingSubscriberRevision ||
                  !newEmail.trim()
                }
              >
                {rowBusy === "add"
                  ? "Adding…"
                  : canonicalPresent
                    ? "Add alternate"
                    : "Repair record"}
              </button>
              <p
                id={`${permissionReasonId}-add-note`}
                className="subscriber-addresses__add-note"
              >
                Added as <b>Never subscribed</b>. Consent is never copied from
                another address.
              </p>
            </form>
          )}
        </>
      )}

      <ConsentReviewModal
        row={pendingConsent}
        target={consentTarget}
        draft={consentDraft}
        busy={pendingConsent != null && rowBusy === pendingConsent.id}
        onTargetChange={setConsentTarget}
        onDraftChange={setConsentDraft}
        onClose={() => setPendingConsent(null)}
        onConfirm={() => void commitConsent()}
      />
      <SuppressionReviewModal
        row={pendingSuppression}
        draft={suppressionDraft}
        busy={pendingSuppression != null && rowBusy === pendingSuppression.id}
        validation={suppressionValidation()}
        onDraftChange={setSuppressionDraft}
        onClose={() => setPendingSuppression(null)}
        onConfirm={() => void commitSuppression()}
      />
      <RemovalReviewModal
        row={pendingRemoval}
        confirmation={removalConfirmation}
        busy={pendingRemoval != null && rowBusy === pendingRemoval.id}
        onConfirmationChange={setRemovalConfirmation}
        onClose={() => setPendingRemoval(null)}
        onConfirm={() => void commitRemoval()}
      />
    </section>
  );
}

function AddressSkeleton(): ReactElement {
  return (
    <div
      className="subscriber-addresses__list"
      aria-busy="true"
      aria-label="Loading email identities"
    >
      {[0, 1].map((item) => (
        <div className="subscriber-addresses__skeleton skel" key={item} />
      ))}
    </div>
  );
}

function AddressRow({
  row,
  canMutate,
  busy,
  operationActive,
  permissionReasonId,
  canonicalReasonId,
  revisionReasonId,
  onConsent,
  onSuppression,
  onRemove,
}: {
  row: SubscriberEmail;
  canMutate: boolean;
  busy: boolean;
  operationActive: boolean;
  permissionReasonId: string;
  canonicalReasonId: string;
  revisionReasonId: string;
  onConsent: () => void;
  onSuppression: () => void;
  onRemove: () => void;
}): ReactElement {
  const revisionAvailable = Boolean(row.version);
  const disabled = !canMutate || operationActive || !revisionAvailable;
  const describedBy = !canMutate
    ? permissionReasonId
    : !revisionAvailable
      ? revisionReasonId
      : undefined;
  return (
    <article
      className={`subscriber-address${row.is_primary ? " is-canonical" : ""}`}
      aria-busy={busy || undefined}
    >
      <div className="subscriber-address__marker" aria-hidden="true" />
      <div className="subscriber-address__body">
        <div className="subscriber-address__topline">
          <span className="subscriber-address__email" title={row.email}>
            {row.email}
          </span>
          <span className={row.is_primary ? "badge accent" : "badge"}>
            {row.is_primary ? "Delivery address" : "Alternate"}
          </span>
          <span className={consentTone(row.consent_status)}>
            {consentLabel(row.consent_status)}
          </span>
          {row.suppressed ? (
            <span className="badge danger">Suppressed</span>
          ) : null}
        </div>
        <p className="subscriber-address__disposition">
          {addressDisposition(row)}
        </p>
        <div className="subscriber-address__meta">
          <span>Added {fmtDate(row.created_at)}</span>
          <span>
            {row.last_engaged_at
              ? `Last engaged ${fmtDate(row.last_engaged_at)}`
              : "No engagement recorded"}
          </span>
        </div>
      </div>
      <div className="subscriber-address__actions">
        <button
          type="button"
          className="btn btn-sm"
          disabled={disabled}
          aria-describedby={describedBy}
          onClick={onConsent}
        >
          {busy ? "Saving…" : "Review consent"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={disabled}
          aria-describedby={describedBy}
          onClick={onSuppression}
        >
          {row.suppressed ? "Review restoration" : "Review suppression"}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger-ghost"
          disabled={disabled || row.is_primary}
          aria-describedby={row.is_primary ? canonicalReasonId : describedBy}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>
    </article>
  );
}

function ConsentReviewModal({
  row,
  target,
  draft,
  busy,
  onTargetChange,
  onDraftChange,
  onClose,
  onConfirm,
}: {
  row: SubscriberEmail | null;
  target: SubscriberEmailConsent;
  draft: ConsentEvidenceDraft;
  busy: boolean;
  onTargetChange: (target: SubscriberEmailConsent) => void;
  onDraftChange: Dispatch<SetStateAction<ConsentEvidenceDraft>>;
  onClose: () => void;
  onConfirm: () => void;
}): ReactElement {
  const validation = consentEvidenceError(draft, {
    requireEvidence: true,
    requireScope: true,
  });
  const grantConfirmationMissing =
    target === "subscribed" &&
    row != null &&
    draft.confirmation.trim().toLowerCase() !== row.email.toLowerCase();
  const update = <K extends keyof ConsentEvidenceDraft>(
    key: K,
    value: ConsentEvidenceDraft[K],
  ): void => onDraftChange((current) => ({ ...current, [key]: value }));
  return (
    <Modal
      open={row != null}
      onClose={() => (busy ? undefined : onClose())}
      title="Review address consent"
      description="This appends immutable evidence for this exact address. It does not copy permission from the profile or another address."
      size="lg"
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeDisabled={busy}
    >
      {row ? (
        <div className="subscriber-review-context">
          <span>Address</span>
          <strong>{row.email}</strong>
          <span>Current state</span>
          <strong>{consentLabel(row.consent_status)}</strong>
        </div>
      ) : null}
      <label className="field" htmlFor="address-consent-target">
        <span className="field-label">Reviewed decision</span>
        <select
          id="address-consent-target"
          className="input"
          value={target}
          disabled={busy}
          onChange={(event) =>
            onTargetChange(event.target.value as SubscriberEmailConsent)
          }
        >
          {CONSENT_OPTIONS.map((option) => (
            <option
              key={option}
              value={option}
              disabled={option === row?.consent_status}
            >
              {CONSENT_LABELS[option]}
              {option === row?.consent_status ? " (current)" : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="subscriber-review-grid">
        <EvidenceSelect
          id="address-consent-source"
          label="Evidence source"
          value={draft.source}
          options={CONSENT_PROVENANCE_SOURCES}
          disabled={busy}
          onChange={(value) => update("source", value)}
        />
        <EvidenceSelect
          id="address-consent-channel"
          label="Capture channel"
          value={draft.channel}
          options={CONSENT_EVIDENCE_CHANNELS}
          disabled={busy}
          onChange={(value) => update("channel", value)}
        />
        <EvidenceSelect
          id="address-consent-basis"
          label="Legal basis"
          value={draft.legalBasis}
          options={CONSENT_LEGAL_BASES}
          disabled={busy}
          onChange={(value) => update("legalBasis", value)}
        />
        <label className="field" htmlFor="address-consent-at">
          <span className="field-label">Decision captured at</span>
          <input
            id="address-consent-at"
            type="datetime-local"
            className="input"
            value={draft.occurredAt}
            disabled={busy}
            onChange={(event) => update("occurredAt", event.target.value)}
          />
        </label>
        <label className="field" htmlFor="address-consent-jurisdiction">
          <span className="field-label">Jurisdiction</span>
          <input
            id="address-consent-jurisdiction"
            className="input"
            maxLength={32}
            placeholder="US-CA, GB, EU"
            value={draft.jurisdiction}
            disabled={busy}
            onChange={(event) => update("jurisdiction", event.target.value)}
          />
        </label>
        <label className="field" htmlFor="address-consent-policy">
          <span className="field-label">Policy version</span>
          <input
            id="address-consent-policy"
            className="input"
            maxLength={100}
            placeholder="privacy-2026-07"
            value={draft.policyVersion}
            disabled={busy}
            onChange={(event) => update("policyVersion", event.target.value)}
          />
        </label>
      </div>
      <label className="field" htmlFor="address-consent-evidence">
        <span className="field-label">Durable evidence reference</span>
        <textarea
          id="address-consent-evidence"
          className="input"
          rows={2}
          maxLength={2048}
          value={draft.evidence}
          disabled={busy}
          placeholder="Receipt ID, signed record, or approved evidence URL"
          onChange={(event) => update("evidence", event.target.value)}
        />
      </label>
      <label className="field" htmlFor="address-consent-reason">
        <span className="field-label">Operator reason</span>
        <textarea
          id="address-consent-reason"
          className="input"
          rows={2}
          maxLength={500}
          value={draft.reason}
          disabled={busy}
          onChange={(event) => update("reason", event.target.value)}
        />
      </label>
      <label className="subscriber-review-check">
        <input
          type="checkbox"
          checked={draft.scopeAcknowledged}
          disabled={busy}
          onChange={(event) =>
            update("scopeAcknowledged", event.target.checked)
          }
        />
        <span>
          I reviewed the exact address, evidence, jurisdiction, and resulting
          marketing state.
        </span>
      </label>
      {target === "subscribed" && row ? (
        <label className="field" htmlFor="address-consent-confirmation">
          <span className="field-label">
            Type {row.email} to confirm the grant
          </span>
          <input
            id="address-consent-confirmation"
            className="input"
            autoComplete="off"
            value={draft.confirmation}
            disabled={busy}
            onChange={(event) => update("confirmation", event.target.value)}
          />
        </label>
      ) : null}
      {validation || grantConfirmationMissing ? (
        <div className="field-error" role="status">
          {validation ??
            `Type ${row?.email ?? "the address"} exactly to confirm this grant.`}
        </div>
      ) : null}
      <ModalFooter>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            busy ||
            validation != null ||
            grantConfirmationMissing ||
            target === row?.consent_status
          }
          onClick={onConfirm}
        >
          {busy ? "Recording…" : "Record decision"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function SuppressionReviewModal({
  row,
  draft,
  busy,
  validation,
  onDraftChange,
  onClose,
  onConfirm,
}: {
  row: SubscriberEmail | null;
  draft: SuppressionDraft;
  busy: boolean;
  validation: string | null;
  onDraftChange: Dispatch<SetStateAction<SuppressionDraft>>;
  onClose: () => void;
  onConfirm: () => void;
}): ReactElement {
  const restoring = row?.suppressed === true;
  const update = <K extends keyof SuppressionDraft>(
    key: K,
    value: SuppressionDraft[K],
  ): void => onDraftChange((current) => ({ ...current, [key]: value }));
  return (
    <Modal
      open={row != null}
      onClose={() => (busy ? undefined : onClose())}
      title={
        restoring ? "Review address restoration" : "Review address suppression"
      }
      description={
        restoring
          ? "Removing this address-level hold may restore delivery. Consent, complaint, bounce, erasure, and global suppression controls still apply."
          : "This immediately holds delivery for this exact address and records the operator rationale."
      }
      role={restoring ? "alertdialog" : "dialog"}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeDisabled={busy}
    >
      {row ? (
        <div className="subscriber-review-context">
          <span>Address</span>
          <strong>{row.email}</strong>
          <span>New state</span>
          <strong>{restoring ? "Address hold removed" : "Suppressed"}</strong>
        </div>
      ) : null}
      <label className="field" htmlFor="address-suppression-reason">
        <span className="field-label">Operator reason</span>
        <textarea
          id="address-suppression-reason"
          className="input"
          rows={2}
          maxLength={500}
          value={draft.reason}
          disabled={busy}
          onChange={(event) => update("reason", event.target.value)}
        />
      </label>
      <label className="field" htmlFor="address-suppression-evidence">
        <span className="field-label">
          Evidence reference{restoring ? "" : " (recommended)"}
        </span>
        <textarea
          id="address-suppression-evidence"
          className="input"
          rows={2}
          maxLength={2048}
          value={draft.evidence}
          disabled={busy}
          placeholder="Ticket, provider trace, complaint, or reviewed receipt"
          onChange={(event) => update("evidence", event.target.value)}
        />
      </label>
      <label className="subscriber-review-check">
        <input
          type="checkbox"
          checked={draft.acknowledged}
          disabled={busy}
          onChange={(event) => update("acknowledged", event.target.checked)}
        />
        <span>
          I reviewed the exact address and understand the delivery impact.
        </span>
      </label>
      {restoring && row ? (
        <label className="field" htmlFor="address-suppression-confirmation">
          <span className="field-label">
            Type {row.email} to restore this address
          </span>
          <input
            id="address-suppression-confirmation"
            className="input"
            autoComplete="off"
            value={draft.confirmation}
            disabled={busy}
            onChange={(event) => update("confirmation", event.target.value)}
          />
        </label>
      ) : null}
      {validation ? (
        <div className="field-error" role="status">
          {validation}
        </div>
      ) : null}
      <ModalFooter>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={restoring ? "btn btn-primary" : "btn btn-danger"}
          disabled={busy || validation != null}
          onClick={onConfirm}
        >
          {busy
            ? "Saving…"
            : restoring
              ? "Remove address hold"
              : "Suppress address"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function RemovalReviewModal({
  row,
  confirmation,
  busy,
  onConfirmationChange,
  onClose,
  onConfirm,
}: {
  row: SubscriberEmail | null;
  confirmation: string;
  busy: boolean;
  onConfirmationChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}): ReactElement {
  const confirmed =
    row != null &&
    confirmation.trim().toLowerCase() === row.email.toLowerCase();
  return (
    <Modal
      open={row != null}
      onClose={() => (busy ? undefined : onClose())}
      title="Remove alternate address?"
      description="This removes the address from the profile. Consent and audit history remain retained according to policy."
      role="alertdialog"
      closeOnBackdrop={false}
      closeOnEscape={!busy}
      closeDisabled={busy}
    >
      {row ? (
        <label className="field" htmlFor="address-removal-confirmation">
          <span className="field-label">
            Type {row.email} to confirm removal
          </span>
          <input
            id="address-removal-confirmation"
            className="input"
            autoComplete="off"
            value={confirmation}
            disabled={busy}
            onChange={(event) => onConfirmationChange(event.target.value)}
          />
        </label>
      ) : null}
      <ModalFooter>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy || !confirmed}
          onClick={onConfirm}
        >
          {busy ? "Removing…" : "Remove alternate"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function EvidenceSelect({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled: boolean;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <select
        id={id}
        className="input"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Select…</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
