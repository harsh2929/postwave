import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import {
  api,
  type SubscriberImportDryRunResults,
  type SubscriberImportPatchInput,
  type SubscriberImportPreview,
  type SubscriberImportRemapOptions,
  type SubscriberImportStrategy,
} from "../../lib/api-client";
import type { ApiErr } from "../../lib/api/result";
import type { ImportPolicy } from "../../lib/file-transfer-types";
import { newUUIDv7 } from "../../lib/http-fetch";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import {
  clearImportConsentFields,
  emptyImportConsentDraft,
  importConsentDraftFromContract,
  validateImportConsentDraft,
  type ImportConsentDraft,
} from "./consent-evidence";
import {
  type ImportMappingColumn,
  addTags,
  buildImportOptionsPatch,
  buildMappingPatch,
  importPreflightIsFresh,
  mappingPatchError,
  readMappingColumns,
} from "./import-options";
import type { ImportPollingIssue } from "./import-polling";
import {
  ConsentStep,
  IMPORT_STEPS,
  ImportStepper,
  MappingStep,
  OptionsStep,
  ReviewStep,
  UploadStep,
  type ImportStepId,
} from "./SubscriberImportSteps";
import { useImportExecution } from "./useImportExecution";
import "./subscriber-import.css";

export { MappingStep } from "./SubscriberImportSteps";

const MAX_BYTES = 50 * 1024 * 1024;
const SUBSCRIBER_IMPORT_POLICY: ImportPolicy = {
  label: "subscriber CSV",
  privacy: "confidential",
  extensions: ["csv"],
  mimeTypes: ["text/csv", "application/csv"],
  maxBytes: MAX_BYTES,
};

interface Props {
  open: boolean;
  onClose: () => void;
  onCompleted: () => void;
  /** Remount/purge boundary supplied by the route identity owner. */
  identityScope?: string | null;
  /** Import endpoints are admin-scoped; permission loss must purge the draft. */
  canImport?: boolean;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

function safeWizardError(
  error: ApiErr["error"] | undefined,
  action: "upload" | "save" | "reload" | "options",
): string {
  if (error?.code === "aborted") return "The request was interrupted. Your local choices were kept.";
  if (error?.status === 403) return "Your current role does not permit subscriber imports.";
  if (error?.status === 404) return "This import review no longer exists. Upload the source again.";
  if (error?.status === 409 || error?.code?.includes("stale")) {
    return "The server-side review changed. Nothing was queued; reload or upload a fresh source before continuing.";
  }
  if (error?.code === "invalid_subscriber_import_response_contract") {
    return "The server returned an unverified import response. The last verified state was kept.";
  }
  if (action === "upload") return "The CSV could not be previewed safely. Check its format and try again.";
  if (action === "options") {
    return "The governed custom-field catalog is unavailable. Upload the source again before assigning custom destinations; detected canonical destinations remain available.";
  }
  if (action === "reload") return "Settings were saved, but their authoritative server echo could not be verified. Retry Review.";
  return "The import contract could not be saved. Nothing was queued; review the highlighted fields and try again.";
}

function echoedContractMatches(
  preview: SubscriberImportPreview,
  patch: SubscriberImportPatchInput,
): boolean {
  const mapping = patch.mapping;
  if (!mapping || !preview.mapping) return false;
  const echoedMapping = preview.mapping;
  const mappingMatches =
    echoedMapping.path === mapping.path &&
    echoedMapping.rows === mapping.rows &&
    echoedMapping.headers.length === mapping.headers.length &&
    echoedMapping.headers.every(
      (header, index) => header === mapping.headers[index],
    ) &&
    echoedMapping.columns.length === mapping.columns.length &&
    echoedMapping.columns.every((column, index) => {
      const expected = mapping.columns[index];
      return (
        expected != null &&
        column.index === expected.index &&
        column.name === expected.name &&
        column.kind === expected.kind &&
        column.custom_key === expected.custom_key
      );
    });
  if (
    !mappingMatches ||
    preview.on_existing !== patch.on_existing ||
    preview.auto_create_properties !== patch.auto_create_properties ||
    JSON.stringify(preview.tags ?? []) !== JSON.stringify(patch.tags ?? []) ||
    preview.schedule_type !== "immediate" ||
    preview.schedule_cron !== "" ||
    preview.drip_hours_interval !== 0 ||
    preview.drip_hours_total !== 0
  ) {
    return false;
  }
  if (patch.consent_scope_acknowledged === false) {
    return (
      preview.consent_contract_state === "none" &&
      preview.consent_scope_acknowledged === false &&
      preview.consent_contract_version === "subscriber-import-consent/v1" &&
      preview.consent_source === "" &&
      preview.consent_source_url === "" &&
      preview.consent_captured_at === "" &&
      preview.consent_legal_basis === "" &&
      preview.consent_jurisdiction === "" &&
      preview.consent_reason === "" &&
      preview.consent_policy_version === "" &&
      preview.consent_evidence_reference === "" &&
      preview.consent_scope === ""
    );
  }
  return (
    preview.consent_contract_state === "complete" &&
    preview.consent_scope_acknowledged === true &&
    preview.consent_source === patch.consent_source &&
    preview.consent_source_url === patch.consent_source_url &&
    preview.consent_captured_at === patch.consent_captured_at &&
    preview.consent_legal_basis === "consent" &&
    preview.consent_jurisdiction === patch.consent_jurisdiction &&
    preview.consent_reason === patch.consent_reason &&
    preview.consent_policy_version === patch.consent_policy_version &&
    preview.consent_evidence_reference === patch.consent_evidence_reference &&
    preview.consent_scope === "email_marketing" &&
    preview.consent_contract_version === "subscriber-import-consent/v1"
  );
}

interface DraftLifecycleOptions {
  busy: boolean;
  cancelling: boolean;
  polling: boolean;
  dirty: boolean;
  onClose: () => void;
  discard: () => void;
}

function useImportDraftLifecycle({
  busy,
  cancelling,
  polling,
  dirty,
  onClose,
  discard,
}: DraftLifecycleOptions) {
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  useEffect(() => {
    if (!dirty && !busy && !polling && !cancelling) return;
    return registerLifecycleGuard({
      id: "subscriber-import-wizard",
      label: "Subscriber import review",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : busy || cancelling
            ? {
                level: "blocking",
                detail: "A subscriber import request is still settling.",
                canDiscard: false,
              }
            : polling
              ? {
                  level: "warning",
                  detail: "The server-side import continues if this live view closes.",
                  canDiscard: false,
                }
              : {
                  level: "blocking",
                  detail: "The source-bound import review is not queued.",
                },
      discard: (intent) => {
        discard();
        if (intent.kind !== "route-change") onClose();
      },
    });
  }, [busy, cancelling, dirty, discard, onClose, polling]);
  return {
    discardConfirmOpen,
    cancelDiscard: () => setDiscardConfirmOpen(false),
    requestClose: (): void => {
      if (busy || cancelling) return;
      if (dirty && !polling) setDiscardConfirmOpen(true);
      else onClose();
    },
    discardAndClose: (): void => {
      discard();
      setDiscardConfirmOpen(false);
      onClose();
    },
  };
}

export function ImportSubscribersWizard({
  open,
  onClose,
  onCompleted,
  identityScope = null,
  canImport = true,
}: Props): ReactElement | null {
  if (!open) return null;
  if (!canImport) {
    return (
      <Modal open title="Import subscribers" description="Admin access is required for source-bound subscriber imports." onClose={onClose}>
        <div className="subscriber-import subscriber-import-access-denied" role="status">
          <strong>This workspace role cannot import subscribers.</strong>
          <p>Ask a workspace administrator for an admin-scoped session. No file has been selected or uploaded.</p>
          <ModalFooter><button type="button" className="btn btn-primary" onClick={onClose}>Close</button></ModalFooter>
        </div>
      </Modal>
    );
  }
  return (
    <ImportSubscribersWizardSession
      key={identityScope ?? "subscriber-import-current-identity"}
      onClose={onClose}
      onCompleted={onCompleted}
    />
  );
}

function ImportSubscribersWizardSession({
  onClose,
  onCompleted,
}: Omit<Props, "open" | "identityScope" | "canImport">): ReactElement {
  const [step, setStep] = useState<ImportStepId>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SubscriberImportPreview | null>(null);
  const [mappingColumns, setMappingColumns] = useState<ImportMappingColumn[]>([]);
  const [detectedColumns, setDetectedColumns] = useState<ImportMappingColumn[]>([]);
  const [remapOptions, setRemapOptions] = useState<SubscriberImportRemapOptions | null>(null);
  const [autoCreateProperties, setAutoCreateProperties] = useState(false);
  const [consent, setConsent] = useState<ImportConsentDraft>(emptyImportConsentDraft);
  const [revealConsentErrors, setRevealConsentErrors] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<SubscriberImportStrategy>("skip");
  const [preflight, setPreflight] = useState<SubscriberImportDryRunResults | null>(null);
  const [queueAcknowledged, setQueueAcknowledged] = useState(false);
  const [failureAcknowledged, setFailureAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const requestControllersRef = useRef(new Set<AbortController>());
  const uploadFlightRef = useRef(false);
  const saveFlightRef = useRef(false);
  const uploadIdempotencyKeyRef = useRef(newUUIDv7());

  const { runPreflight, queueImport, requestCancel, stopProgress, progressIssue, retryProgress, activeAction } =
    useImportExecution({
      preview,
      cancelling,
      onCompleted,
      setBusy,
      setPolling,
      setError,
      setPreview,
      setCancelling,
      setPreflight,
    });

  const consentErrors = useMemo(() => validateImportConsentDraft(consent), [consent]);
  const stepIndex = IMPORT_STEPS.findIndex((item) => item.id === step);
  const freshPreflight = importPreflightIsFresh(preflight, clock);
  const terminal = preview?.status === "ready" || preview?.status === "failed" || preview?.status === "cancelled";
  const dirty = !terminal && (file !== null || preview !== null || step !== "upload");

  const abortOwnedRequests = useCallback((): void => {
    for (const controller of requestControllersRef.current) controller.abort();
    requestControllersRef.current.clear();
    uploadFlightRef.current = false;
    saveFlightRef.current = false;
  }, []);

  const resetDraft = useCallback((): void => {
    abortOwnedRequests();
    stopProgress();
    setStep("upload");
    setFile(null);
    setPreview(null);
    setMappingColumns([]);
    setDetectedColumns([]);
    setRemapOptions(null);
    setAutoCreateProperties(false);
    setConsent(emptyImportConsentDraft());
    setRevealConsentErrors(false);
    setTags([]);
    setTagDraft("");
    setTagError(null);
    setStrategy("skip");
    setPreflight(null);
    setQueueAcknowledged(false);
    setFailureAcknowledged(false);
    setError(null);
    uploadIdempotencyKeyRef.current = newUUIDv7();
  }, [abortOwnedRequests, stopProgress]);

  const lifecycle = useImportDraftLifecycle({
    busy,
    cancelling,
    polling,
    dirty,
    onClose,
    discard: resetDraft,
  });

  useEffect(() => () => abortOwnedRequests(), [abortOwnedRequests]);
  useEffect(() => {
    if (step !== "review" || !preflight) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [preflight, step]);

  const withController = useCallback(async <T,>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    requestControllersRef.current.add(controller);
    try {
      return await operation(controller.signal);
    } finally {
      requestControllersRef.current.delete(controller);
    }
  }, []);

  function invalidatePreflight(): void {
    setPreflight(null);
    setQueueAcknowledged(false);
    setFailureAcknowledged(false);
  }

  function onFileSelected(nextFile: File): void {
    setError(null);
    if (nextFile.size > MAX_BYTES) {
      setError(`The selected file is ${formatBytes(nextFile.size)}; the limit is 50 MB.`);
      return;
    }
    if (!nextFile.name.toLocaleLowerCase("en-US").endsWith(".csv")) {
      setError("Choose a file with a .csv extension.");
      return;
    }
    setFile(nextFile);
    uploadIdempotencyKeyRef.current = newUUIDv7();
    setPreview(null);
    setMappingColumns([]);
    setDetectedColumns([]);
    invalidatePreflight();
  }

  async function pickFile(): Promise<void> {
    const { pickImportFiles } = await import("../../lib/file-transfer");
    const selected = await pickImportFiles(SUBSCRIBER_IMPORT_POLICY);
    if (selected.ok && selected.files[0]) onFileSelected(selected.files[0]);
    else if (!selected.ok) setError("Moosewave could not read the selected CSV. Choose the file again.");
  }

  async function uploadPreview(): Promise<void> {
    if (!file || uploadFlightRef.current) return;
    uploadFlightRef.current = true;
    setBusy(true);
    setError(null);
    const { beginUploadTransfer } = await import("../../lib/file-transfer");
    const transfer = beginUploadTransfer(file, {
      label: "Subscriber import preview",
      privacy: "confidential",
      retry: uploadPreview,
    });
    try {
      const result = await withController((signal) =>
        api.previewSubscriberImport(file, {
          signal,
          idempotencyKey: uploadIdempotencyKeyRef.current,
        }),
      );
      if (result.error) {
        transfer.fail("subscriber_import_preview_failed");
        setError(safeWizardError(result.error, "upload"));
        return;
      }
      const columns = readMappingColumns(result.data.mapping);
      setPreview(result.data);
      setStrategy(result.data.on_existing ?? "skip");
      setDetectedColumns(columns);
      setMappingColumns(columns);
      setConsent(clearImportConsentFields("none"));
      transfer.complete();
      const options = await withController((signal) => api.getImportRemapOptions({ signal }));
      if (options.error) {
        setRemapOptions(null);
        setError(safeWizardError(options.error, "options"));
      } else {
        setRemapOptions(options.data);
      }
      setStep("mapping");
    } catch {
      transfer.fail("subscriber_import_preview_failed");
      setError(safeWizardError(undefined, "upload"));
    } finally {
      uploadFlightRef.current = false;
      setBusy(false);
    }
  }

  function commitTagDraft(): boolean {
    if (!tagDraft.trim()) {
      setTagError(null);
      return true;
    }
    const result = addTags(tags, tagDraft);
    setTagError(result.error);
    if (result.error) return false;
    setTags(result.tags);
    setTagDraft("");
    invalidatePreflight();
    return true;
  }

  function tagsForSave(): string[] | null {
    if (!tagDraft.trim()) {
      setTagError(null);
      return tags;
    }
    const result = addTags(tags, tagDraft);
    setTagError(result.error);
    if (result.error) return null;
    // Return the computed collection directly. React state commits later, so
    // reading `tags` again in this tick would silently omit the final chip.
    setTags(result.tags);
    setTagDraft("");
    return result.tags;
  }

  function adoptAuthoritativeDraft(next: SubscriberImportPreview): void {
    const columns = readMappingColumns(next.mapping);
    setPreview(next);
    setDetectedColumns(columns);
    setMappingColumns(columns);
    setStrategy(next.on_existing ?? "skip");
    setTags(next.tags ?? []);
    setTagDraft("");
    setTagError(null);
    setAutoCreateProperties(next.auto_create_properties ?? false);
    setConsent(importConsentDraftFromContract(next));
    setRevealConsentErrors(false);
    invalidatePreflight();
  }

  async function recoverRevisionConflict(
    importId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const latest = await api.getSubscriberImport(importId, { signal });
    if (latest.error || latest.data.status !== "preview") return false;
    const repairedLegacyConsent =
      latest.data.consent_contract_state === "incomplete";
    adoptAuthoritativeDraft(latest.data);
    setStep(repairedLegacyConsent ? "consent" : "options");
    setError(
      repairedLegacyConsent
        ? "A legacy partial consent record was found. It was not treated as permission; review the no-proof repair before saving again."
        : "Another administrator changed this review. The latest server version is loaded; review every changed choice before saving again.",
    );
    return true;
  }

  async function saveAndReview(): Promise<void> {
    if (!preview || saveFlightRef.current) return;
    const configurationRevision = preview.configuration_revision;
    if (
      typeof configurationRevision !== "number" ||
      !Number.isSafeInteger(configurationRevision) ||
      configurationRevision < 0
    ) {
      setError("This review has no verified configuration revision. Upload the source again before saving.");
      return;
    }
    const committedTags = tagsForSave();
    if (!committedTags) return;
    const mapping = buildMappingPatch(preview.mapping, mappingColumns);
    const options = buildImportOptionsPatch({
      strategy,
      consent,
      tags: committedTags,
      autoCreateProperties,
    });
    if (!mapping || !options) {
      setError("Resolve the mapping, consent proof, or tag errors before review.");
      return;
    }
    const patch: SubscriberImportPatchInput = {
      ...options,
      configuration_revision: configurationRevision,
      mapping,
      schedule_type: "immediate",
      schedule_cron: "",
      scheduled_at: "",
      drip_hours_interval: 0,
      drip_hours_total: 0,
    };
    saveFlightRef.current = true;
    setBusy(true);
    setError(null);
    invalidatePreflight();
    try {
      const saved = await withController((signal) =>
        api.patchSubscriberImport(preview.id, patch, { signal }),
      );
      if (saved.error) {
        if (
          saved.error.status === 409 &&
          saved.error.code === "configuration_revision_mismatch"
        ) {
          const recovered = await withController((signal) =>
            recoverRevisionConflict(preview.id, signal),
          );
          if (recovered) return;
        }
        setError(safeWizardError(saved.error, "save"));
        return;
      }
      if (saved.data.configuration_revision < patch.configuration_revision) {
        setError("The server returned an older review revision. Nothing was queued; reload the source-bound review.");
        return;
      }
      const echoed = await withController((signal) =>
        api.getSubscriberImport(preview.id, { signal }),
      );
      if (echoed.error) {
        setError(safeWizardError(echoed.error, "reload"));
        return;
      }
      if (echoed.data.configuration_revision !== saved.data.configuration_revision) {
        adoptAuthoritativeDraft(echoed.data);
        setStep("options");
        setError("The review changed again while its server echo was loading. The latest revision is loaded; review it before saving.");
        return;
      }
      if (!echoedContractMatches(echoed.data, patch)) {
        setError("The authoritative server echo does not match this draft. Nothing was queued; reload or upload the source again.");
        return;
      }
      setPreview(echoed.data);
      setClock(Date.now());
      setStep("review");
    } catch {
      setError(safeWizardError(undefined, "save"));
    } finally {
      saveFlightRef.current = false;
      setBusy(false);
    }
  }

  function back(): void {
    if (polling || busy) return;
    if (step === "review") {
      invalidatePreflight();
      setStep("options");
    } else if (step === "options") setStep("consent");
    else if (step === "consent") setStep("mapping");
    else if (step === "mapping") setStep("upload");
    setError(null);
  }

  function next(): void {
    if (busy || polling) return;
    if (step === "upload") {
      void uploadPreview();
      return;
    }
    if (step === "mapping") {
      const mappingError = mappingPatchError(preview?.mapping, mappingColumns);
      if (mappingError) {
        setError(mappingError);
        return;
      }
      setStep("consent");
      setError(null);
      return;
    }
    if (step === "consent") {
      if (Object.keys(consentErrors).length) {
        setRevealConsentErrors(true);
        setError("Complete every required proof field, or choose No positive consent proof.");
        return;
      }
      setStep("options");
      setError(null);
      return;
    }
    if (step === "options") {
      void saveAndReview();
      return;
    }
    if (!freshPreflight) {
      setQueueAcknowledged(false);
      setFailureAcknowledged(false);
      void runPreflight();
      return;
    }
    const conflictFreeBlocked =
      strategy === "error" &&
      ((preflight?.would_fail ?? 0) > 0 || (preview?.rows_existing ?? 0) > 0);
    if (conflictFreeBlocked) {
      setError("Conflict-free mode cannot queue while the preflight reports invalid or existing rows.");
      return;
    }
    if (!queueAcknowledged || ((preflight?.would_fail ?? 0) > 0 && !failureAcknowledged)) {
      setError("Acknowledge the current preflight outcomes before queueing.");
      return;
    }
    void queueImport();
  }

  const canAdvance =
    step === "upload"
      ? Boolean(file)
      : step === "mapping"
        ? !mappingPatchError(preview?.mapping, mappingColumns)
        : step === "consent"
          ? Object.keys(consentErrors).length === 0
          : step === "options"
            ? Boolean(preview)
            : preview?.status === "preview";

  return (
    <>
      <Modal
        open
        size="xl"
        title="Import subscribers"
        description="A source-bound, consent-safe workflow with an exhaustive preflight before any live write."
        onClose={lifecycle.requestClose}
        closeOnBackdrop={!busy && !cancelling}
        closeOnEscape={!busy && !cancelling}
        closeDisabled={busy || cancelling}
      >
        <div className="subscriber-import">
          <ImportStepper stepIndex={stepIndex} />
          <div className="subscriber-import-workspace" aria-busy={busy || undefined}>
            {step === "upload" ? <UploadStep file={file} onPick={() => void pickFile()} policy={SUBSCRIBER_IMPORT_POLICY} formatBytes={formatBytes} /> : null}
            {step === "mapping" && preview ? <MappingStep preview={preview} columns={mappingColumns} detected={detectedColumns} remapOptions={remapOptions} autoCreate={autoCreateProperties} onAutoCreate={(value) => { setAutoCreateProperties(value); invalidatePreflight(); }} onColumnsChange={(columns) => { setMappingColumns(columns); invalidatePreflight(); }} /> : null}
            {step === "consent" ? <ConsentStep draft={consent} errors={consentErrors} revealErrors={revealConsentErrors} onChange={(draft) => { setConsent(draft); setRevealConsentErrors(false); invalidatePreflight(); }} /> : null}
            {step === "options" ? <OptionsStep tags={tags} tagDraft={tagDraft} tagError={tagError} strategy={strategy} onTagDraft={(value) => { setTagDraft(value); setTagError(null); }} onCommitTag={commitTagDraft} onRemoveTag={(tag) => { setTags((current) => current.filter((item) => item !== tag)); setTagError(null); invalidatePreflight(); }} onStrategy={(value) => { setStrategy(value); invalidatePreflight(); }} /> : null}
            {step === "review" && preview ? <ReviewStep preview={preview} preflight={preflight} now={clock} queueAcknowledged={queueAcknowledged} failureAcknowledged={failureAcknowledged} onQueueAcknowledged={setQueueAcknowledged} onFailureAcknowledged={setFailureAcknowledged} /> : null}
          </div>
          {error ? <div className="subscriber-import-alert is-danger subscriber-import-global-error" role="alert"><strong>Import paused</strong><span>{error}</span></div> : null}
          {progressIssue ? <ProgressIssue issue={progressIssue} onRetry={retryProgress} /> : null}
          <ModalFooter>
            <button type="button" className="btn" onClick={lifecycle.requestClose} disabled={busy || cancelling}>{polling || terminal ? "Close" : "Cancel"}</button>
            {terminal ? <button type="button" className="btn" onClick={resetDraft}>Start a new import</button> : null}
            {stepIndex > 0 && !polling && !terminal ? <button type="button" className="btn" onClick={back} disabled={busy}>Back</button> : null}
            {polling && (preview?.status === "queued" || preview?.status === "running") ? <button type="button" className="btn btn-danger" onClick={() => void requestCancel()} disabled={cancelling || preview.cancel_requested}>{preview.cancel_requested ? "Cancellation requested" : cancelling ? "Requesting…" : "Cancel import"}</button> : null}
            {!terminal ? <button type="button" className="btn btn-primary" onClick={next} disabled={!canAdvance || busy || polling}>{primaryLabel({ step, busy, activeAction, freshPreflight, preview })}</button> : null}
          </ModalFooter>
        </div>
      </Modal>
      <ConfirmModal open={lifecycle.discardConfirmOpen} title="Leave this import review?" description="The import has not been queued. Local choices will be cleared; the time-bounded server review artifact will expire independently." confirmLabel="Leave and clear" danger onConfirm={lifecycle.discardAndClose} onClose={lifecycle.cancelDiscard} />
    </>
  );
}

function primaryLabel({
  step,
  busy,
  activeAction,
  freshPreflight,
  preview,
}: {
  step: ImportStepId;
  busy: boolean;
  activeAction: "preflight" | "queue" | null;
  freshPreflight: boolean;
  preview: SubscriberImportPreview | null;
}): string {
  if (busy) {
    if (activeAction === "preflight") return "Verifying every row…";
    if (activeAction === "queue") return "Queueing once…";
    if (step === "upload") return "Creating preview…";
    return "Saving reviewed contract…";
  }
  if (step === "upload") return "Create safe preview";
  if (step === "mapping") return "Review consent boundary";
  if (step === "consent") return "Review handling";
  if (step === "options") return "Save and verify";
  if (!freshPreflight) return `Run exhaustive preflight · ${(preview?.rows_total ?? 0).toLocaleString()} rows`;
  return `Queue verified import · ${(preview?.rows_total ?? 0).toLocaleString()} rows`;
}

function ProgressIssue({ issue, onRetry }: { issue: ImportPollingIssue; onRetry: () => void }): ReactElement {
  return (
    <div className={`subscriber-import-alert ${issue.kind === "offline" ? "" : "is-warning"}`} role="status">
      <strong>{issue.kind === "offline" ? "Live status paused" : "Live status interrupted"}</strong>
      <span>{issue.message}</span>
      {issue.kind !== "offline" ? <button type="button" className="btn" onClick={onRetry}>Retry status now</button> : null}
    </div>
  );
}
