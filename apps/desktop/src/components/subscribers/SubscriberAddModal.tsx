import {
  type Dispatch,
  type ReactElement,
  type RefObject,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  RotateCcw,
  ShieldCheck,
  UserPlus,
  UsersRound,
} from "lucide-react";

import { FieldError, FormField, useFormErrors } from "../FormField";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import {
  api,
  emailValidationApi,
  type BulkPasteResponse,
  type EmailValidationResult,
  type Subscriber,
} from "../../lib/api-client";
import {
  mutKey,
  useFailedMutations,
  usePendingMutations,
} from "../../lib/pending-mutations";
import { track as trackTelemetry } from "../../lib/telemetry";
import { Avatar } from "./Avatar";
import { InlineTagChip } from "./InlineTagChip";
import { suggestEmailFix, verdictLabel } from "./subscriber-insights";
import {
  CONSENT_EVIDENCE_CHANNELS,
  CONSENT_LEGAL_BASES,
  CONSENT_PROVENANCE_SOURCES,
  consentEvidenceError,
  consentEvidencePayload,
  emptyConsentEvidenceDraft,
  type ConsentEvidenceDraft,
} from "./consent-evidence";

export const MAX_BULK_PASTE = 100;

type SubscriberAddMode = "single" | "paste";
type SubscriberAddTabs = ReturnType<
  typeof useTabsInteraction<SubscriberAddMode>
>;

export type CreateSubscriberVars = {
  email: string;
  tags: string[];
  status: "enabled" | "unconfirmed";
  consent_source?: "double_optin" | "single_optin";
  consent_timestamp?: string;
  consent_channel?: string;
  consent_legal_basis?: string;
  consent_evidence?: string;
  consent_reason?: string;
  consent_policy_version?: string;
  country?: string;
};
type SubscriberDraft = {
  email: string;
  tags: string;
  status: "enabled" | "unconfirmed";
};

export function parseBulkPasteEmails(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    const value = part.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function mergeBulkPasteResults(
  previous: BulkPasteResponse,
  retry: BulkPasteResponse,
): BulkPasteResponse {
  const retried = new Map(
    retry.rows.map((row) => [row.email.trim().toLowerCase(), row] as const),
  );
  const rows = previous.rows.map(
    (row) => retried.get(row.email.trim().toLowerCase()) ?? row,
  );
  const previousKeys = new Set(
    previous.rows.map((row) => row.email.trim().toLowerCase()),
  );
  for (const row of retry.rows) {
    if (!previousKeys.has(row.email.trim().toLowerCase())) rows.push(row);
  }
  const count = (status: BulkPasteResponse["rows"][number]["status"]): number =>
    rows.filter((row) => row.status === status).length;
  return {
    parsed: rows.length,
    created: count("created"),
    updated: count("updated"),
    skipped: count("skipped"),
    errored: count("error"),
    rows,
  };
}

function useCreateSubscriberMutation() {
  return useMutation<Subscriber, Error, CreateSubscriberVars>({
    mutationKey: mutKey("subscribers", "create"),
    mutationFn: async (vars) => {
      const result = await api.createSubscriber(vars);
      if (result.error) throw new Error(result.error.message);
      return result.data!;
    },
  });
}

function useSubscriberAddRequestGuards(open: boolean) {
  const emailCheckSeq = useRef(0);
  const bulkRequestSeq = useRef(0);
  const modalGeneration = useRef(0);
  const openRef = useRef(open);
  const mounted = useRef(true);
  const bulkBusyGeneration = useRef<number | null>(null);
  const createBusyGeneration = useRef<number | null>(null);
  useEffect(() => {
    openRef.current = open;
    modalGeneration.current += 1;
    emailCheckSeq.current += 1;
    bulkRequestSeq.current += 1;
  }, [open]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      emailCheckSeq.current += 1;
      bulkRequestSeq.current += 1;
      modalGeneration.current += 1;
    };
  }, []);
  return {
    emailCheckSeq,
    bulkRequestSeq,
    modalGeneration,
    open: openRef,
    mounted,
    bulkBusyGeneration,
    createBusyGeneration,
  };
}

function useSubscriberEmailValidation(
  open: boolean,
  requests: ReturnType<typeof useSubscriberAddRequestGuards>,
  setDraft: Dispatch<SetStateAction<SubscriberDraft>>,
) {
  const [result, setResult] = useState<EmailValidationResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const activeCheckEmail = useRef<string | null>(null);

  const invalidate = (): void => {
    requests.emailCheckSeq.current += 1;
    activeCheckEmail.current = null;
    setResult(null);
    setChecking(false);
    setSuggestion(null);
  };

  useEffect(() => {
    setResult(null);
    setChecking(false);
    setSuggestion(null);
  }, [open]);

  const check = async (raw: string): Promise<void> => {
    const email = raw.trim();
    if (email && activeCheckEmail.current === email) return;
    const seq = ++requests.emailCheckSeq.current;
    const generation = requests.modalGeneration.current;
    setSuggestion(suggestEmailFix(email));
    setResult(null);
    setChecking(false);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    activeCheckEmail.current = email;
    setChecking(true);
    const response = await emailValidationApi.check(email);
    if (activeCheckEmail.current === email) activeCheckEmail.current = null;
    if (
      !requests.mounted.current ||
      !requests.open.current ||
      generation !== requests.modalGeneration.current ||
      seq !== requests.emailCheckSeq.current
    ) {
      return;
    }
    setChecking(false);
    if (response.data) setResult(response.data);
  };

  const applySuggestion = (): void => {
    if (!suggestion) return;
    const fixed = suggestion;
    setDraft((current) => ({ ...current, email: fixed }));
    setSuggestion(null);
    setResult(null);
    void check(fixed);
  };

  return { result, checking, suggestion, invalidate, check, applySuggestion };
}

interface BulkPasteSubmissionContext {
  canMutate: boolean;
  raw: string;
  tagsRaw: string;
  requests: ReturnType<typeof useSubscriberAddRequestGuards>;
  errors: ReturnType<typeof useFormErrors>;
  setSubmitErr: Dispatch<SetStateAction<string | null>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setRetrying: Dispatch<SetStateAction<boolean>>;
  setResult: Dispatch<SetStateAction<BulkPasteResponse | null>>;
  clearPaste: () => void;
  onReload: () => void;
}

async function runBulkPasteSubmission(
  context: BulkPasteSubmissionContext,
  retryRaw?: string,
): Promise<void> {
  const {
    canMutate,
    raw: initialRaw,
    tagsRaw,
    requests,
    errors,
    setSubmitErr,
    setBusy,
    setRetrying,
    setResult,
    clearPaste,
    onReload,
  } = context;
  const retrying = retryRaw !== undefined;
  const raw = retryRaw ?? initialRaw;
  const emails = parseBulkPasteEmails(raw);
  if (!canMutate) {
    errors.set("_form", "Your role can't add subscribers.");
    return;
  }
  if (emails.length === 0) {
    setSubmitErr(
      "Paste at least one address (one per line or comma-separated).",
    );
    return;
  }
  if (emails.length > MAX_BULK_PASTE) {
    setSubmitErr(
      `That's ${emails.length.toLocaleString()} addresses — the paste box is capped at ${MAX_BULK_PASTE}. Use Import CSV for larger lists.`,
    );
    return;
  }
  const generation = requests.modalGeneration.current;
  if (requests.bulkBusyGeneration.current === generation) return;
  requests.bulkBusyGeneration.current = generation;
  const requestSeq = ++requests.bulkRequestSeq.current;
  setSubmitErr(null);
  errors.clear();
  setBusy(true);
  setRetrying(retrying);
  if (!retrying) setResult(null);
  const tags = splitTags(tagsRaw);
  const result = await api.bulkPasteSubscribers({
    emails: raw,
    tags,
    status: "unconfirmed",
  });
  const current =
    requests.mounted.current &&
    requests.open.current &&
    generation === requests.modalGeneration.current &&
    requestSeq === requests.bulkRequestSeq.current;
  if (requests.bulkBusyGeneration.current === generation) {
    requests.bulkBusyGeneration.current = null;
  }
  if (current) {
    setBusy(false);
    setRetrying(false);
  }
  if (result.error) {
    const message =
      result.error.kind === "http" && result.error.status === 422
        ? `Too many addresses — the paste box is capped at ${MAX_BULK_PASTE}. Use Import CSV for larger lists.`
        : result.error.message;
    if (current) setSubmitErr(`Couldn't add subscribers: ${message}`);
    else toast.error(`Couldn't add subscribers: ${message}`);
    return;
  }
  const data = result.data;
  if (current) {
    setResult((previous) =>
      retrying && previous ? mergeBulkPasteResults(previous, data) : data,
    );
  }
  const added = data.created + data.updated;
  if (added > 0) {
    const summary = [
      data.created ? `${data.created} added` : "",
      data.updated ? `${data.updated} updated` : "",
      data.errored ? `${data.errored} failed` : "",
    ].filter(Boolean);
    toast.success(`Bulk paste: ${summary.join(", ")}`);
    trackTelemetry("subscriber_added", {
      source: "bulk_paste",
      tag_count: tags.length,
    });
    onReload();
    if (current && !retrying) clearPaste();
  } else if (data.errored > 0) {
    toast.error(`Bulk paste: all ${data.errored} addresses failed.`);
  }
}

function subscriberCreateReadiness(
  draft: SubscriberDraft,
  consentEvidence: ConsentEvidenceDraft,
  validation: EmailValidationResult | null,
  deliverabilityOverride: boolean,
): {
  emailSyntaxValid: boolean;
  consentReady: boolean;
  deliverabilityReady: boolean;
} {
  const email = draft.email.trim();
  return {
    emailSyntaxValid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    consentReady:
      draft.status === "unconfirmed" ||
      (consentEvidenceError(consentEvidence, {
        requireEvidence: true,
        requireScope: true,
      }) === null &&
        consentEvidence.confirmation.trim() === `ENABLE ${email}`),
    deliverabilityReady: validation?.valid !== false || deliverabilityOverride,
  };
}

function useSubscriberCreateUndo(onReload: () => void) {
  const inFlight = useRef(new Set<string>());
  const undo = (subscriberID: string, email: string, version: string): void => {
    if (inFlight.current.has(subscriberID)) return;
    inFlight.current.add(subscriberID);
    void (async () => {
      try {
        const result = await api.deleteSubscriber(subscriberID, version);
        if (result.error) {
          toast.error({
            message: `Couldn't undo adding ${email}`,
            detail: "The subscriber is still in your audience. Try again.",
            action: {
              label: "Try again",
              onClick: () => undo(subscriberID, email, version),
            },
          });
          return;
        }
        toast.success(`${email} removed`);
        onReload();
      } finally {
        inFlight.current.delete(subscriberID);
      }
    })();
  };
  return undo;
}

interface SubscriberAddModalProps {
  open: boolean;
  canMutate: boolean;
  onClose: () => void;
  onReload: () => void;
}

export function SubscriberAddModal({
  open,
  canMutate,
  onClose,
  onReload,
}: SubscriberAddModalProps): ReactElement {
  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<SubscriberAddMode>("single");
  const [draft, setDraft] = useState<SubscriberDraft>({
    email: "",
    tags: "",
    status: "unconfirmed",
  });
  const [consentEvidence, setConsentEvidence] = useState(
    emptyConsentEvidenceDraft,
  );
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [bulkPaste, setBulkPaste] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkRetrying, setBulkRetrying] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkPasteResponse | null>(null);
  const [deliverabilityOverride, setDeliverabilityOverride] = useState(false);
  const requests = useSubscriberAddRequestGuards(open);
  const emailValidation = useSubscriberEmailValidation(
    open,
    requests,
    setDraft,
  );
  const errors = useFormErrors();
  const createSubscriber = useCreateSubscriberMutation();
  const undoCreatedSubscriber = useSubscriberCreateUndo(onReload);
  const parsedEmails = useMemo(
    () => parseBulkPasteEmails(bulkPaste),
    [bulkPaste],
  );

  useEffect(() => {
    setMode("single");
    setDraft({ email: "", tags: "", status: "unconfirmed" });
    setConsentEvidence(emptyConsentEvidenceDraft());
    setSubmitErr(null);
    errors.clear();
    setBulkPaste("");
    setBulkResult(null);
    setBulkBusy(false);
    setBulkRetrying(false);
    setDeliverabilityOverride(false);
    setSubmitting(false);
  }, [open]); // `errors` is a stable form controller.

  useEffect(() => {
    setDeliverabilityOverride(false);
  }, [draft.email]);

  const submitBulkPaste = (retryRaw?: string): Promise<void> =>
    runBulkPasteSubmission(
      {
        canMutate,
        raw: bulkPaste,
        tagsRaw: draft.tags,
        requests,
        errors,
        setSubmitErr,
        setBusy: setBulkBusy,
        setRetrying: setBulkRetrying,
        setResult: setBulkResult,
        clearPaste: () => setBulkPaste(""),
        onReload,
      },
      retryRaw,
    );

  const submitCreate = async (): Promise<void> => {
    if (!canMutate) {
      errors.set("_form", "Your role can't add subscribers.");
      return;
    }
    const email = draft.email.trim();
    errors.clear();
    if (!email) {
      errors.set("email", "Email is required.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.set("email", "Enter a valid email address.");
      return;
    }
    if (emailValidation.result?.valid === false && !deliverabilityOverride) {
      setSubmitErr(
        "Review the deliverability warning and acknowledge the override before adding this address.",
      );
      return;
    }
    const tags = splitTags(draft.tags);
    let consentFields: Omit<CreateSubscriberVars, "email" | "tags" | "status"> =
      {};
    if (draft.status === "enabled") {
      const consentError = consentEvidenceError(consentEvidence, {
        requireEvidence: true,
        requireScope: true,
      });
      const evidence = consentEvidencePayload(consentEvidence);
      if (consentError || !evidence) {
        setSubmitErr(consentError ?? "Complete the consent evidence.");
        return;
      }
      if (
        evidence.source !== "double_optin" &&
        evidence.source !== "single_optin"
      ) {
        setSubmitErr(
          "A sendable subscriber requires a single- or double-opt-in record.",
        );
        return;
      }
      if (!/^[A-Z]{2}$/.test(evidence.jurisdiction)) {
        setSubmitErr("Use a 2-letter country code for the jurisdiction.");
        return;
      }
      const expected = `ENABLE ${email}`;
      if (consentEvidence.confirmation.trim() !== expected) {
        setSubmitErr(`Type ${expected} to confirm send eligibility.`);
        return;
      }
      consentFields = {
        consent_source: evidence.source,
        consent_timestamp: evidence.occurred_at,
        consent_channel: evidence.channel,
        consent_legal_basis: evidence.legal_basis,
        consent_evidence: evidence.evidence,
        consent_reason: evidence.reason,
        consent_policy_version: evidence.policy_version,
        country: evidence.jurisdiction,
      };
    }
    const generation = requests.modalGeneration.current;
    if (requests.createBusyGeneration.current === generation) return;
    requests.createBusyGeneration.current = generation;
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const subscriber = await createSubscriber.mutateAsync({
        email,
        tags,
        status: draft.status,
        ...consentFields,
      });
      const createdSubscriberID =
        subscriber.id == null ? "" : String(subscriber.id);
      const createdSubscriberVersion = subscriber.version?.trim() ?? "";
      toast.success({
        message: `${email} added`,
        action:
          createdSubscriberID && createdSubscriberVersion
            ? {
                label: "Undo",
                onClick: () => {
                  undoCreatedSubscriber(
                    createdSubscriberID,
                    email,
                    createdSubscriberVersion,
                  );
                },
              }
            : undefined,
      });
      trackTelemetry("subscriber_added", {
        source: "page",
        tag_count: tags.length,
      });
      onReload();
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Couldn't add ${email}: ${message}`);
    } finally {
      if (requests.createBusyGeneration.current === generation) {
        requests.createBusyGeneration.current = null;
      }
      if (
        requests.mounted.current &&
        requests.open.current &&
        generation === requests.modalGeneration.current
      ) {
        setSubmitting(false);
      }
    }
  };

  const { emailSyntaxValid, consentReady, deliverabilityReady } =
    subscriberCreateReadiness(
      draft,
      consentEvidence,
      emailValidation.result,
      deliverabilityOverride,
    );
  const createDisabled =
    !canMutate ||
    submitting ||
    bulkBusy ||
    emailValidation.checking ||
    !emailSyntaxValid ||
    !consentReady ||
    !deliverabilityReady;
  const bulkDisabled =
    !canMutate ||
    bulkBusy ||
    submitting ||
    parsedEmails.length === 0 ||
    parsedEmails.length > MAX_BULK_PASTE;
  const modeTabs = useTabsInteraction<SubscriberAddMode>({
    value: mode,
    items: [
      { value: "single", disabled: submitting || bulkBusy },
      { value: "paste", disabled: submitting || bulkBusy },
    ],
    onChange: (nextMode) => {
      setMode(nextMode);
      setSubmitErr(null);
      errors.clear();
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add subscriber"
      description="Choose a deliberate path, review eligibility, and see the outcome of every address."
      size="lg"
      closeOnBackdrop={!submitting && !bulkBusy}
      closeOnEscape={!submitting && !bulkBusy}
      closeDisabled={submitting || bulkBusy}
      initialFocusRef={emailInputRef}
    >
      <div className="subscriber-add-flow">
        <SubscriberAddModePicker tabs={modeTabs} />
        {!canMutate ? (
          <div className="subscriber-add-permission" role="note">
            <ShieldCheck aria-hidden="true" size={17} />
            <span>
              <strong>View-only access</strong>
              Your role can't add subscribers. Ask a workspace admin for edit
              access.
            </span>
          </div>
        ) : null}
        <SubscriberAddFields
          mode={mode}
          tabs={modeTabs}
          emailInputRef={emailInputRef}
          draft={draft}
          setDraft={setDraft}
          consentEvidence={consentEvidence}
          setConsentEvidence={setConsentEvidence}
          setSubmitErr={setSubmitErr}
          submitting={submitting}
          bulkPaste={bulkPaste}
          setBulkPaste={setBulkPaste}
          bulkBusy={bulkBusy}
          bulkRetrying={bulkRetrying}
          bulkResult={bulkResult}
          setBulkResult={setBulkResult}
          parsedCount={parsedEmails.length}
          submitErr={submitErr}
          emailValidation={emailValidation}
          deliverabilityOverride={deliverabilityOverride}
          setDeliverabilityOverride={setDeliverabilityOverride}
          errors={errors}
          onRetryFailures={(emails) => void submitBulkPaste(emails.join("\n"))}
        />
      </div>
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={onClose}
          disabled={submitting || bulkBusy}
        >
          Cancel
        </button>
        {mode === "paste" ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submitBulkPaste()}
            disabled={bulkDisabled}
          >
            {bulkBusy
              ? bulkRetrying
                ? "Retrying…"
                : "Adding…"
              : `Add ${parsedEmails.length.toLocaleString()} pasted`}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submitCreate()}
            disabled={createDisabled}
          >
            {submitting ? "Adding…" : "Add subscriber"}
          </button>
        )}
      </ModalFooter>
    </Modal>
  );
}

interface SubscriberAddFieldsProps {
  mode: SubscriberAddMode;
  tabs: SubscriberAddTabs;
  emailInputRef: RefObject<HTMLInputElement | null>;
  draft: SubscriberDraft;
  setDraft: Dispatch<SetStateAction<SubscriberDraft>>;
  consentEvidence: ConsentEvidenceDraft;
  setConsentEvidence: Dispatch<SetStateAction<ConsentEvidenceDraft>>;
  setSubmitErr: Dispatch<SetStateAction<string | null>>;
  submitting: boolean;
  bulkPaste: string;
  setBulkPaste: Dispatch<SetStateAction<string>>;
  bulkBusy: boolean;
  bulkRetrying: boolean;
  bulkResult: BulkPasteResponse | null;
  setBulkResult: Dispatch<SetStateAction<BulkPasteResponse | null>>;
  parsedCount: number;
  submitErr: string | null;
  emailValidation: ReturnType<typeof useSubscriberEmailValidation>;
  deliverabilityOverride: boolean;
  setDeliverabilityOverride: Dispatch<SetStateAction<boolean>>;
  errors: ReturnType<typeof useFormErrors>;
  onRetryFailures: (emails: string[]) => void;
}

function SubscriberAddModePicker({
  tabs,
}: {
  tabs: SubscriberAddTabs;
}): ReactElement {
  return (
    <div
      ref={tabs.listRef}
      className="subscriber-add-mode-picker"
      {...tabs.listProps}
      aria-label="Subscriber entry method"
    >
      <button type="button" {...tabs.getTabProps("single")}>
        <span className="subscriber-add-mode-icon">
          <UserPlus aria-hidden="true" size={19} />
        </span>
        <span>
          <strong>One subscriber</strong>
          <small>Review eligibility and consent</small>
        </span>
        <span className="subscriber-add-mode-check" aria-hidden="true">
          <CheckCircle2 size={16} />
        </span>
      </button>
      <button type="button" {...tabs.getTabProps("paste")}>
        <span className="subscriber-add-mode-icon">
          <UsersRound aria-hidden="true" size={19} />
        </span>
        <span>
          <strong>Paste a list</strong>
          <small>Up to {MAX_BULK_PASTE} unconfirmed addresses</small>
        </span>
        <span className="subscriber-add-mode-check" aria-hidden="true">
          <CheckCircle2 size={16} />
        </span>
      </button>
    </div>
  );
}

function SubscriberAddFields({
  mode,
  tabs,
  emailInputRef,
  draft,
  setDraft,
  consentEvidence,
  setConsentEvidence,
  setSubmitErr,
  submitting,
  bulkPaste,
  setBulkPaste,
  bulkBusy,
  bulkRetrying,
  bulkResult,
  setBulkResult,
  parsedCount,
  submitErr,
  emailValidation,
  deliverabilityOverride,
  setDeliverabilityOverride,
  errors,
  onRetryFailures,
}: SubscriberAddFieldsProps): ReactElement {
  return (
    <>
      {mode === "single" ? (
        <section
          {...tabs.getPanelProps("single")}
          className="subscriber-add-panel"
        >
          <div className="subscriber-add-panel-heading">
            <span className="subscriber-add-eyebrow">Individual entry</span>
            <h3>Identity and send eligibility</h3>
            <p>
              Start safely as unconfirmed, or attach complete evidence before
              making the address sendable.
            </p>
          </div>
          <FormField
            label="Email"
            required
            htmlFor="sub-email"
            error={errors.get("email")}
          >
            <input
              ref={emailInputRef}
              id="sub-email"
              type="email"
              className="input"
              placeholder="user@example.com"
              value={draft.email}
              disabled={submitting || bulkBusy}
              aria-describedby={
                emailValidation.checking ||
                emailValidation.result ||
                emailValidation.suggestion
                  ? "subscriber-email-feedback"
                  : undefined
              }
              onChange={(event) => {
                emailValidation.invalidate();
                setDraft({ ...draft, email: event.target.value });
              }}
              onBlur={() => void emailValidation.check(draft.email)}
            />
          </FormField>
          <EmailValidationFeedback
            checking={emailValidation.checking}
            result={emailValidation.result}
            suggestion={emailValidation.suggestion}
            overrideAcknowledged={deliverabilityOverride}
            onOverrideAcknowledged={setDeliverabilityOverride}
            onApplySuggestion={emailValidation.applySuggestion}
          />
          <FormField
            label="Initial send eligibility"
            required
            htmlFor="sub-status"
            helpTooltip="Unconfirmed is the safe default. Choose sendable only when you can attach complete, defensible consent evidence."
          >
            <select
              id="sub-status"
              className="input"
              value={draft.status}
              disabled={submitting || bulkBusy}
              onChange={(event) => {
                const status = event.target.value as SubscriberDraft["status"];
                setDraft((current) => ({ ...current, status }));
                setConsentEvidence(emptyConsentEvidenceDraft());
                setSubmitErr(null);
              }}
            >
              <option value="unconfirmed">Unconfirmed · not sendable</option>
              <option value="enabled">
                Sendable · verified evidence required
              </option>
            </select>
          </FormField>
          {draft.status === "enabled" ? (
            <CreateConsentEvidenceFields
              email={draft.email.trim()}
              draft={consentEvidence}
              disabled={submitting || bulkBusy}
              onChange={setConsentEvidence}
            />
          ) : (
            <div className="subscriber-add-safety-note">
              <ShieldCheck aria-hidden="true" size={16} />
              <span>
                <strong>Safe default</strong>
                Campaigns cannot send until verified consent is recorded.
              </span>
            </div>
          )}
          <SubscriberTagsField
            value={draft.tags}
            disabled={submitting || bulkBusy}
            onChange={(tags) => setDraft({ ...draft, tags })}
            error={errors.get("tags")}
          />
        </section>
      ) : (
        <section
          {...tabs.getPanelProps("paste")}
          className="subscriber-add-panel"
        >
          <div className="subscriber-add-panel-heading subscriber-add-paste-heading">
            <span className="subscriber-add-eyebrow">Quick batch</span>
            <h3>Paste, review, then reconcile every row</h3>
            <p>
              Addresses are deduplicated case-insensitively and always enter as
              unconfirmed. Use CSV Import for mapping, provenance, or more than{" "}
              {MAX_BULK_PASTE} contacts.
            </p>
          </div>
          <FormField
            label="Subscriber addresses"
            required
            htmlFor="sub-bulk-paste"
            helpTooltip={`Paste one address per line, or comma-separated. The maximum is ${MAX_BULK_PASTE}.`}
          >
            <textarea
              id="sub-bulk-paste"
              className="input subscriber-add-paste-input"
              rows={6}
              placeholder={"a@example.com\nb@example.com, c@example.com"}
              value={bulkPaste}
              disabled={bulkBusy}
              onChange={(event) => {
                setBulkPaste(event.target.value);
                setBulkResult(null);
              }}
            />
          </FormField>
          <BulkPasteCount count={parsedCount} />
          <SubscriberTagsField
            value={draft.tags}
            disabled={submitting || bulkBusy}
            onChange={(tags) => setDraft({ ...draft, tags })}
            error={errors.get("tags")}
            bulk
          />
          <div className="subscriber-add-safety-note">
            <ShieldCheck aria-hidden="true" size={16} />
            <span>
              <strong>Consent-safe batch</strong>
              Import provenance is not proof; every pasted address remains
              non-sendable until consent is verified.
            </span>
          </div>
          {bulkResult ? (
            <BulkPasteResults
              result={bulkResult}
              retrying={bulkRetrying}
              onRetryFailures={onRetryFailures}
            />
          ) : null}
        </section>
      )}
      {errors.get("_form") ? (
        <FieldError>{errors.get("_form")}</FieldError>
      ) : submitErr ? (
        <div className="field-error">{submitErr}</div>
      ) : null}
    </>
  );
}

function CreateConsentEvidenceFields({
  email,
  draft,
  disabled,
  onChange,
}: {
  email: string;
  draft: ConsentEvidenceDraft;
  disabled: boolean;
  onChange: Dispatch<SetStateAction<ConsentEvidenceDraft>>;
}): ReactElement {
  const update = <K extends keyof ConsentEvidenceDraft>(
    key: K,
    value: ConsentEvidenceDraft[K],
  ): void => onChange((current) => ({ ...current, [key]: value }));
  const expected = `ENABLE ${email || "subscriber@example.com"}`;
  const optInSources = CONSENT_PROVENANCE_SOURCES.filter(
    (source) =>
      source.value === "double_optin" || source.value === "single_optin",
  );
  return (
    <fieldset
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 8,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <legend style={{ padding: "0 6px", fontSize: 12, fontWeight: 600 }}>
        Verified email-consent evidence
      </legend>
      <div className="muted" style={{ fontSize: 11 }}>
        Importing or manually entering an address is not proof. These fields are
        written to the immutable consent ledger with the subscriber.
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 10,
        }}
      >
        <CreateEvidenceSelect
          id="sub-consent-source"
          label="Opt-in source"
          value={draft.source}
          options={optInSources}
          disabled={disabled}
          onChange={(value) => update("source", value)}
        />
        <CreateEvidenceSelect
          id="sub-consent-channel"
          label="Capture channel"
          value={draft.channel}
          options={CONSENT_EVIDENCE_CHANNELS}
          disabled={disabled}
          onChange={(value) => update("channel", value)}
        />
        <CreateEvidenceSelect
          id="sub-consent-basis"
          label="Legal basis"
          value={draft.legalBasis}
          options={CONSENT_LEGAL_BASES}
          disabled={disabled}
          onChange={(value) => update("legalBasis", value)}
        />
        <label className="field" htmlFor="sub-consent-at">
          <span className="field-label">Consent captured at</span>
          <input
            id="sub-consent-at"
            type="datetime-local"
            className="input"
            value={draft.occurredAt}
            disabled={disabled}
            onChange={(event) => update("occurredAt", event.target.value)}
          />
        </label>
        <label className="field" htmlFor="sub-consent-country">
          <span className="field-label">Country / jurisdiction</span>
          <input
            id="sub-consent-country"
            className="input"
            value={draft.jurisdiction}
            disabled={disabled}
            maxLength={2}
            placeholder="GB"
            autoCapitalize="characters"
            onChange={(event) => update("jurisdiction", event.target.value)}
          />
        </label>
        <label className="field" htmlFor="sub-consent-policy">
          <span className="field-label">Policy version</span>
          <input
            id="sub-consent-policy"
            className="input"
            value={draft.policyVersion}
            disabled={disabled}
            maxLength={100}
            placeholder="privacy-2026-07"
            onChange={(event) => update("policyVersion", event.target.value)}
          />
        </label>
      </div>
      <label className="field" htmlFor="sub-consent-evidence">
        <span className="field-label">Durable evidence reference</span>
        <textarea
          id="sub-consent-evidence"
          className="input"
          rows={2}
          value={draft.evidence}
          disabled={disabled}
          maxLength={2048}
          placeholder="Receipt id, signed-form id, or approved evidence URL"
          onChange={(event) => update("evidence", event.target.value)}
        />
      </label>
      <label className="field" htmlFor="sub-consent-reason">
        <span className="field-label">Operator review note</span>
        <textarea
          id="sub-consent-reason"
          className="input"
          rows={2}
          value={draft.reason}
          disabled={disabled}
          maxLength={500}
          placeholder="Why this evidence establishes email marketing permission"
          onChange={(event) => update("reason", event.target.value)}
        />
      </label>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <input
          type="checkbox"
          checked={draft.scopeAcknowledged}
          disabled={disabled}
          onChange={(event) =>
            update("scopeAcknowledged", event.target.checked)
          }
        />
        <span style={{ fontSize: 12 }}>
          I reviewed the evidence and confirm it applies to this exact address.
        </span>
      </label>
      <label className="field" htmlFor="sub-consent-confirmation">
        <span className="field-label">
          Type <strong>{expected}</strong> to enable sending
        </span>
        <input
          id="sub-consent-confirmation"
          className="input"
          value={draft.confirmation}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => update("confirmation", event.target.value)}
        />
      </label>
    </fieldset>
  );
}

function CreateEvidenceSelect({
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

function SubscriberTagsField({
  value,
  disabled,
  onChange,
  error,
  bulk = false,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  error?: string;
  bulk?: boolean;
}): ReactElement {
  return (
    <FormField
      label={bulk ? "Shared tags" : "Tags"}
      htmlFor="sub-tags"
      helpTooltip={
        bulk
          ? "Comma-separated. These tags are applied to every detected address."
          : "Comma-separated. Tags power segments, automation triggers, and personalization rules."
      }
      error={error}
    >
      <input
        id="sub-tags"
        type="text"
        className="input"
        placeholder={bulk ? "newsletter, imported-july" : "newsletter, vip"}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </FormField>
  );
}

function splitTags(raw: string): string[] {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function EmailValidationFeedback({
  checking,
  result,
  suggestion,
  overrideAcknowledged,
  onOverrideAcknowledged,
  onApplySuggestion,
}: {
  checking: boolean;
  result: EmailValidationResult | null;
  suggestion: string | null;
  overrideAcknowledged: boolean;
  onOverrideAcknowledged: (value: boolean) => void;
  onApplySuggestion: () => void;
}): ReactElement | null {
  if (checking) {
    return (
      <div
        id="subscriber-email-feedback"
        className="subscriber-email-verdict is-checking"
        role="status"
      >
        <span className="subscriber-add-spinner" aria-hidden="true" />
        <span>
          <strong>Checking address quality</strong>
          Looking for syntax, mailbox, disposable, and role-account signals…
        </span>
      </div>
    );
  }
  if (result) {
    if (result.valid) {
      return (
        <div
          id="subscriber-email-feedback"
          className="subscriber-email-verdict is-valid"
          role="status"
        >
          <CheckCircle2 aria-hidden="true" size={17} />
          <span>
            <strong>{verdictLabel(result.verdict)}</strong>
            The address passed the available quality checks. This does not
            replace consent evidence.
          </span>
        </div>
      );
    }
    return (
      <div
        id="subscriber-email-feedback"
        className="subscriber-email-verdict is-warning"
        role="group"
        aria-label="Deliverability warning"
      >
        <AlertTriangle aria-hidden="true" size={18} />
        <span className="subscriber-email-verdict-copy">
          <strong>{verdictLabel(result.verdict)}</strong>
          {result.reasons.length > 0 ? (
            <span>{result.reasons.join(" · ")}</span>
          ) : (
            <span>The address needs an operator review.</span>
          )}
          <label className="subscriber-email-override">
            <input
              type="checkbox"
              checked={overrideAcknowledged}
              onChange={(event) => onOverrideAcknowledged(event.target.checked)}
            />
            I reviewed this warning and still want to add the address.
          </label>
        </span>
      </div>
    );
  }
  if (!suggestion) return null;
  return (
    <div id="subscriber-email-feedback" className="subscriber-email-suggestion">
      <button
        type="button"
        className="btn btn-xs btn-ghost"
        onClick={onApplySuggestion}
        aria-label={`Replace the typed address with suggested address ${suggestion}`}
      >
        Did you mean <strong>{suggestion}</strong>?
      </button>
    </div>
  );
}

function BulkPasteCount({ count }: { count: number }): ReactElement | null {
  if (count === 0) return null;
  const over = count > MAX_BULK_PASTE;
  return (
    <div
      className={`subscriber-add-paste-count${over ? " is-over" : ""}`}
      role={over ? "alert" : "status"}
    >
      <ClipboardList aria-hidden="true" size={15} />
      <span>
        <strong>
          {count.toLocaleString()} address{count === 1 ? "" : "es"} detected
        </strong>
        {over
          ? `Over the ${MAX_BULK_PASTE} cap — use Import CSV for larger lists.`
          : `${(MAX_BULK_PASTE - count).toLocaleString()} places remain in this batch.`}
      </span>
    </div>
  );
}

function BulkPasteResults({
  result,
  retrying,
  onRetryFailures,
}: {
  result: BulkPasteResponse;
  retrying: boolean;
  onRetryFailures: (emails: string[]) => void;
}): ReactElement {
  const failedEmails = result.rows
    .filter((row) => row.status === "error")
    .map((row) => row.email);
  const summaries = [
    { key: "created", label: "Added", value: result.created },
    { key: "updated", label: "Updated", value: result.updated },
    { key: "skipped", label: "Skipped", value: result.skipped },
    { key: "error", label: "Failed", value: result.errored },
  ] as const;
  return (
    <section className="subscriber-add-results" aria-live="polite">
      <div className="subscriber-add-results-heading">
        <span>
          <strong>Batch outcome</strong>
          {result.parsed.toLocaleString()} distinct address
          {result.parsed === 1 ? "" : "es"} reconciled
        </span>
        {failedEmails.length > 0 ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={retrying}
            onClick={() => onRetryFailures(failedEmails)}
          >
            <RotateCcw aria-hidden="true" size={14} />
            {retrying
              ? "Retrying…"
              : `Retry ${failedEmails.length.toLocaleString()} failed`}
          </button>
        ) : null}
      </div>
      <div className="subscriber-add-result-summary" aria-label="Batch totals">
        {summaries.map((item) => (
          <div key={item.key} data-status={item.key}>
            <strong>{item.value.toLocaleString()}</strong>
            <span>{item.label}</span>
          </div>
        ))}
      </div>
      <div className="subscriber-add-result-list" role="list">
        {result.rows.map((row, index) => (
          <div
            key={`${row.email}-${index}`}
            className="subscriber-add-result-row"
            role="listitem"
            title={row.error ?? ""}
          >
            <span className="subscriber-add-result-email">{row.email}</span>
            {row.error ? (
              <span className="subscriber-add-result-error">{row.error}</span>
            ) : null}
            <span
              className="subscriber-add-result-status"
              data-status={row.status}
            >
              {row.status === "created"
                ? "Added"
                : row.status === "updated"
                  ? "Updated"
                  : row.status === "skipped"
                    ? "Skipped"
                    : "Failed"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

interface SubscriberCreateMutationRowsProps {
  visibleColumnKeys: readonly string[];
  gridTemplateColumns: string;
  onReload: () => void;
}

export function SubscriberCreateMutationRows({
  visibleColumnKeys,
  gridTemplateColumns,
  onReload,
}: SubscriberCreateMutationRowsProps): ReactElement {
  const queryClient = useQueryClient();
  const retryCreate = useCreateSubscriberMutation();
  const pending = usePendingMutations<CreateSubscriberVars>(
    "subscribers",
    "create",
  );
  const failed = useFailedMutations<CreateSubscriberVars>(
    "subscribers",
    "create",
  );

  const retry = (vars: CreateSubscriberVars): void => {
    void retryCreate
      .mutateAsync(vars)
      .then(() => {
        const cache = queryClient.getMutationCache();
        for (const mutation of cache.getAll()) {
          const key = mutation.options.mutationKey;
          const failedVars = mutation.state.variables as
            | CreateSubscriberVars
            | undefined;
          if (
            mutation.state.status === "error" &&
            Array.isArray(key) &&
            key[0] === "subscribers" &&
            key[1] === "create" &&
            failedVars?.email === vars.email
          ) {
            cache.remove(mutation);
          }
        }
        onReload();
      })
      .catch(() => {
        // The failed mutation remains visible and supplies the retry affordance.
      });
  };

  return (
    <>
      {pending.map((vars, index) => (
        <SubscriberCreateRow
          key={`pending-${vars.email}-${index}`}
          kind="pending"
          vars={vars}
          visibleColumnKeys={visibleColumnKeys}
          gridTemplateColumns={gridTemplateColumns}
        />
      ))}
      {failed.map((vars, index) => (
        <SubscriberCreateRow
          key={`failed-${vars.email}-${index}`}
          kind="failed"
          vars={vars}
          visibleColumnKeys={visibleColumnKeys}
          gridTemplateColumns={gridTemplateColumns}
          onRetry={() => retry(vars)}
        />
      ))}
    </>
  );
}

function SubscriberCreateRow({
  kind,
  vars,
  visibleColumnKeys,
  gridTemplateColumns,
  onRetry,
}: {
  kind: "pending" | "failed";
  vars: CreateSubscriberVars;
  visibleColumnKeys: readonly string[];
  gridTemplateColumns: string;
  onRetry?: () => void;
}): ReactElement {
  const pending = kind === "pending";
  return (
    <div
      className={`list-row ${pending ? "pw-pending-row" : "pw-failed-row"}`}
      style={{
        gridTemplateColumns,
        ...(pending ? { pointerEvents: "none" } : {}),
      }}
      aria-label={`${pending ? "Adding" : "Failed to add"} ${vars.email}`}
    >
      <div />
      {visibleColumnKeys.map((key) => {
        if (key === "avatar" && pending) {
          return (
            <div key={key} style={{ display: "flex", alignItems: "center" }}>
              <Avatar email={vars.email} size={24} />
            </div>
          );
        }
        if (key === "email") {
          return (
            <div
              key={key}
              style={{
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {vars.email}
              {!pending ? (
                <button
                  type="button"
                  className="pw-retry-link"
                  onClick={onRetry}
                >
                  Sync failed — Retry
                </button>
              ) : null}
            </div>
          );
        }
        if (key === "status" && pending) {
          return (
            <div key={key} className="muted">
              Adding…
            </div>
          );
        }
        if (key === "tags" && pending) {
          return (
            <div
              key={key}
              style={{ display: "flex", flexWrap: "wrap", gap: 4 }}
            >
              {vars.tags.map((tag) => (
                <InlineTagChip key={tag} tag={tag} removable={false} />
              ))}
            </div>
          );
        }
        return (
          <div key={key} className="muted">
            —
          </div>
        );
      })}
      <div />
    </div>
  );
}
