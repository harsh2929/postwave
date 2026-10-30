/**
 * Privacy-region configuration with explicit framework and consent semantics.
 * Mutations are single-flight, draft-aware, and never expose raw server errors.
 */

import {
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  useDiscardOnlyDraftLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import {
  type PrivacyFramework,
  type PrivacyPortalRegion,
  api,
} from "../../lib/api-client";
import {
  type RemoteApiError,
  remoteFailureFromError,
} from "../../lib/remote-resource";
import { ConfirmModal } from "../ConfirmModal";
import { toast } from "../Toast";

interface FrameworkOption {
  value: PrivacyFramework;
  label: string;
}

const FRAMEWORKS: FrameworkOption[] = [
  { value: "gdpr", label: "GDPR — General Data Protection Regulation" },
  { value: "ccpa", label: "CCPA/CPRA — California privacy" },
  { value: "lgpd", label: "LGPD — Brazil data protection" },
  { value: "pipeda", label: "PIPEDA — Canada privacy" },
  { value: "apo", label: "APO" },
  { value: "other", label: "Other or organization-defined framework" },
];

const REGION_CODE_PATTERN = /^[A-Z0-9]{2,8}(?:-[A-Z0-9]{1,8})*$/u;
const REMOTE_ERROR_KINDS = new Set<NonNullable<RemoteApiError["kind"]>>([
  "http",
  "network",
  "offline",
  "storage",
  "timeout",
  "parse",
  "invalid_config",
]);

type FeedbackTone = "success" | "warning" | "error";
type OperationScope = "create" | "delete";

interface RegionFeedback {
  scope: OperationScope | "refresh";
  tone: FeedbackTone;
  message: string;
  detail?: string;
}

interface Props {
  regions: PrivacyPortalRegion[];
  onChanged: () => void;
}

export function RegionsCard({ regions, onChanged }: Props): ReactElement {
  const controller = useRegionsCardController(regions ?? [], onChanged);
  const {
    regs,
    adding,
    regionCode,
    framework,
    requiresDOI,
    requiresExplicit,
    doNotSell,
    gpcHonored,
    validationRequested,
    pendingDelete,
    discardConfirmOpen,
    operationScope,
    feedback,
    operationActive,
    codeError,
    addToggleRef,
    codeInputRef,
    titleId,
    operationHelpId,
    setRegionCode,
    setFramework,
    setRequiresDOI,
    setRequiresExplicit,
    setDoNotSell,
    setGpcHonored,
    requestFormClose,
    toggleAdding,
    onCreate,
    requestDelete,
    confirmDelete,
    discardDraft,
    closeDeleteModal,
    closeDiscardModal,
  } = controller;

  return (
    <section
      className="card privacy-regions-card"
      aria-labelledby={titleId}
      aria-busy={operationActive ? "true" : undefined}
    >
      <RegionsHeader
        titleId={titleId}
        adding={adding}
        unavailable={operationActive}
        operationHelpId={operationHelpId}
        buttonRef={addToggleRef}
        onToggle={toggleAdding}
      />

      <p id={operationHelpId} className="pw-action-status" role="status">
        {operationActive
          ? operationScope === "delete"
            ? "Removing the selected region. Other region actions are unavailable until the server responds."
            : "Adding the region. The draft is preserved until the server confirms the change."
          : "Changes affect future send-eligibility checks; they do not rewrite historical consent records."}
      </p>

      {feedback && feedback.scope !== "delete" ? (
        <RegionFeedbackNotice feedback={feedback} />
      ) : null}

      {adding ? (
        <RegionDraftForm
          regionCode={regionCode}
          framework={framework}
          requiresDOI={requiresDOI}
          requiresExplicit={requiresExplicit}
          doNotSell={doNotSell}
          gpcHonored={gpcHonored}
          validationRequested={validationRequested}
          codeError={codeError}
          busy={operationActive}
          operationHelpId={operationHelpId}
          codeInputRef={codeInputRef}
          onRegionCode={setRegionCode}
          onFramework={setFramework}
          onRequiresDOI={setRequiresDOI}
          onRequiresExplicit={setRequiresExplicit}
          onDoNotSell={setDoNotSell}
          onGpcHonored={setGpcHonored}
          onCancel={requestFormClose}
          onCreate={onCreate}
        />
      ) : null}

      <RegionList
        regions={regs}
        operationActive={operationActive}
        operationHelpId={operationHelpId}
        onDelete={requestDelete}
      />

      <ConfirmModal
        open={pendingDelete !== null}
        title="Remove privacy region?"
        description={
          pendingDelete
            ? `Remove ${pendingDelete.code}? Subscribers in this region won't have its framework applied to future sends.`
            : ""
        }
        confirmLabel="Remove region"
        danger
        busy={operationActive}
        onConfirm={confirmDelete}
        onClose={closeDeleteModal}
      >
        {feedback?.scope === "delete" ? (
          <RegionFeedbackNotice feedback={feedback} />
        ) : (
          <p className="pw-action-status">
            This changes future eligibility only. Historical consent evidence is
            retained.
          </p>
        )}
      </ConfirmModal>

      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard privacy-region draft?"
        description="The region code, framework, and consent requirements have not been saved."
        confirmLabel="Discard draft"
        danger
        busy={operationActive}
        onConfirm={discardDraft}
        onClose={closeDiscardModal}
      />
    </section>
  );
}

function useRegionsCardController(
  regs: PrivacyPortalRegion[],
  onChanged: () => void,
) {
  const [adding, setAdding] = useState(false);
  const [regionCode, setRegionCode] = useState("");
  const [framework, setFramework] = useState<PrivacyFramework>("gdpr");
  const [requiresDOI, setRequiresDOI] = useState(false);
  const [requiresExplicit, setRequiresExplicit] = useState(false);
  const [doNotSell, setDoNotSell] = useState(false);
  const [gpcHonored, setGpcHonored] = useState(true);
  const [validationRequested, setValidationRequested] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    code: string;
  } | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [operationScope, setOperationScope] = useState<OperationScope | null>(
    null,
  );
  const [feedback, setFeedback] = useState<RegionFeedback | null>(null);
  const activeRef = useRef(true);
  const addToggleRef = useRef<HTMLButtonElement | null>(null);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const wasAddingRef = useRef(false);
  const titleId = useId();
  const operationHelpId = useId();
  const operation = useSingleFlightOperation({
    ownerId: "privacy-region",
    label: "Privacy region request",
  });
  const operationActive = operation.active || operationScope !== null;
  const codeError = validateRegionCode(regionCode, regs);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (wasAddingRef.current && !adding) addToggleRef.current?.focus();
    wasAddingRef.current = adding;
  }, [adding]);

  useEffect(() => {
    if (adding) codeInputRef.current?.focus();
  }, [adding]);

  const resetForm = useCallback((): void => {
    setRegionCode("");
    setFramework("gdpr");
    setRequiresDOI(false);
    setRequiresExplicit(false);
    setDoNotSell(false);
    setGpcHonored(true);
    setValidationRequested(false);
  }, []);

  const closeAndResetForm = useCallback((): void => {
    resetForm();
    setAdding(false);
    setDiscardConfirmOpen(false);
  }, [resetForm]);

  const discardDraft = useCallback((): void => {
    closeAndResetForm();
    setFeedback(null);
  }, [closeAndResetForm]);

  const draftDirty =
    adding &&
    Boolean(
      regionCode ||
      framework !== "gdpr" ||
      requiresDOI ||
      requiresExplicit ||
      doNotSell ||
      !gpcHonored,
    );

  const requestFormClose = useCallback((): void => {
    if (operation.promiseRef.current) return;
    if (draftDirty) setDiscardConfirmOpen(true);
    else discardDraft();
  }, [discardDraft, draftDirty, operation.promiseRef]);

  useDiscardOnlyDraftLifecycle({
    ownerId: "privacy-region-create",
    label: "Privacy region draft",
    dirty: draftDirty,
    operationRef: operation.promiseRef,
    discard: discardDraft,
    detail:
      "This privacy-region configuration has not been created. Return to the form or explicitly discard it.",
    operationDetail:
      "Wait for the privacy-region request to finish before leaving Moosewave.",
  });

  const reportFailure = useCallback(
    (scope: OperationScope, error: unknown, fallback: string): void => {
      if (!activeRef.current) return;
      const failure = regionOperationFailure(error, fallback, scope);
      const next: RegionFeedback = {
        scope,
        tone: "error",
        message: failure.message,
        detail: failure.detail,
      };
      setFeedback(next);
      toast.error({ message: next.message, detail: next.detail });
    },
    [],
  );

  async function onCreate(): Promise<void> {
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    const code = regionCode.trim().toUpperCase();
    const validation = validateRegionCode(code, regs);
    if (validation) {
      setValidationRequested(true);
      setFeedback({
        scope: "create",
        tone: "error",
        message: "Review the region code before adding this configuration.",
        detail: validation,
      });
      codeInputRef.current?.focus();
      return;
    }

    setFeedback(null);
    setOperationScope("create");
    const request = operation.run(async (): Promise<void> => {
      try {
        const result = await api.privacyPortal.regions.create({
          region_code: code,
          framework,
          requires_double_optin: requiresDOI,
          requires_explicit_consent: requiresExplicit,
          do_not_sell_default: doNotSell,
          gpc_honored: gpcHonored,
        });
        if (!activeRef.current) return;
        if (result.error) {
          reportFailure(
            "create",
            result.error,
            "The privacy region couldn't be created.",
          );
          return;
        }
        closeAndResetForm();
        const refreshed = notifyRegionChanged(onChanged, `${code} was added`);
        setFeedback(committedRegionFeedback(code, "added", refreshed));
        toast.success({ message: `${code} was added.` });
      } catch (createError) {
        reportFailure(
          "create",
          createError,
          "The privacy region couldn't be created.",
        );
      } finally {
        if (activeRef.current) setOperationScope(null);
      }
    });
    if (request) await request;
  }

  function requestDelete(id: string, code: string): void {
    if (operation.promiseRef.current) return;
    setFeedback(null);
    setPendingDelete({ id, code });
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    const target = pendingDelete;
    setFeedback(null);
    setOperationScope("delete");
    const request = operation.run(async (): Promise<void> => {
      try {
        const result = await api.privacyPortal.regions.remove(target.id);
        if (!activeRef.current) return;
        if (result.error) {
          reportFailure(
            "delete",
            result.error,
            "The privacy region couldn't be removed.",
          );
          return;
        }
        setPendingDelete(null);
        const refreshed = notifyRegionChanged(
          onChanged,
          `${target.code} was removed`,
        );
        setFeedback(committedRegionFeedback(target.code, "removed", refreshed));
        toast.success({ message: `${target.code} was removed.` });
      } catch (deleteError) {
        reportFailure(
          "delete",
          deleteError,
          "The privacy region couldn't be removed.",
        );
      } finally {
        if (activeRef.current) setOperationScope(null);
      }
    });
    if (request) await request;
  }

  const toggleAdding = useCallback((): void => {
    if (operation.promiseRef.current) return;
    if (adding) requestFormClose();
    else {
      setFeedback(null);
      setAdding(true);
    }
  }, [adding, operation.promiseRef, requestFormClose]);

  const closeDeleteModal = useCallback((): void => {
    if (operation.promiseRef.current) return;
    setPendingDelete(null);
    setFeedback(null);
  }, [operation.promiseRef]);

  const closeDiscardModal = useCallback((): void => {
    if (!operation.promiseRef.current) setDiscardConfirmOpen(false);
  }, [operation.promiseRef]);

  return {
    regs,
    adding,
    regionCode,
    framework,
    requiresDOI,
    requiresExplicit,
    doNotSell,
    gpcHonored,
    validationRequested,
    pendingDelete,
    discardConfirmOpen,
    operationScope,
    feedback,
    operationActive,
    codeError,
    addToggleRef,
    codeInputRef,
    titleId,
    operationHelpId,
    setRegionCode,
    setFramework,
    setRequiresDOI,
    setRequiresExplicit,
    setDoNotSell,
    setGpcHonored,
    requestFormClose,
    toggleAdding,
    onCreate,
    requestDelete,
    confirmDelete,
    discardDraft,
    closeDeleteModal,
    closeDiscardModal,
  };
}

function RegionsHeader({
  titleId,
  adding,
  unavailable,
  operationHelpId,
  buttonRef,
  onToggle,
}: {
  titleId: string;
  adding: boolean;
  unavailable: boolean;
  operationHelpId: string;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
}): ReactElement {
  return (
    <header className="privacy-region-toolbar">
      <div>
        <h3 id={titleId} className="privacy-region-title">
          Privacy regions
        </h3>
        <p className="privacy-region-subtitle">
          Declare the framework and consent defaults applied in each market.
        </p>
      </div>
      <button
        ref={buttonRef}
        type="button"
        className={`${adding ? "btn" : "btn btn-primary"} pw-discoverable-unavailable`}
        onClick={() => {
          if (!unavailable) onToggle();
        }}
        aria-disabled={unavailable || undefined}
        aria-describedby={operationHelpId}
      >
        {adding ? "Cancel adding region" : "Add region"}
      </button>
    </header>
  );
}

function RegionDraftForm({
  regionCode,
  framework,
  requiresDOI,
  requiresExplicit,
  doNotSell,
  gpcHonored,
  validationRequested,
  codeError,
  busy,
  operationHelpId,
  codeInputRef,
  onRegionCode,
  onFramework,
  onRequiresDOI,
  onRequiresExplicit,
  onDoNotSell,
  onGpcHonored,
  onCancel,
  onCreate,
}: {
  regionCode: string;
  framework: PrivacyFramework;
  requiresDOI: boolean;
  requiresExplicit: boolean;
  doNotSell: boolean;
  gpcHonored: boolean;
  validationRequested: boolean;
  codeError: string | null;
  busy: boolean;
  operationHelpId: string;
  codeInputRef: RefObject<HTMLInputElement | null>;
  onRegionCode: (value: string) => void;
  onFramework: (value: PrivacyFramework) => void;
  onRequiresDOI: (value: boolean) => void;
  onRequiresExplicit: (value: boolean) => void;
  onDoNotSell: (value: boolean) => void;
  onGpcHonored: (value: boolean) => void;
  onCancel: () => void;
  onCreate: () => Promise<void>;
}): ReactElement {
  const formTitleId = useId();
  const codeId = useId();
  const codeHelpId = useId();
  const codeErrorId = useId();
  const frameworkId = useId();
  const visibleError = validationRequested ? codeError : null;

  return (
    <form
      className="privacy-region-form"
      aria-labelledby={formTitleId}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void onCreate();
      }}
    >
      <h4 id={formTitleId} className="privacy-region-form-title">
        Add a privacy region
      </h4>
      <div className="privacy-region-form-grid">
        <label className="privacy-region-field" htmlFor={codeId}>
          <span>Region code</span>
          <input
            ref={codeInputRef}
            id={codeId}
            name="region-code"
            className="input"
            placeholder="EU / US-CA / BR / …"
            value={regionCode}
            onChange={(event) => onRegionCode(event.target.value.toUpperCase())}
            maxLength={32}
            pattern={REGION_CODE_PATTERN.source}
            autoComplete="off"
            spellCheck={false}
            required
            disabled={busy}
            aria-invalid={visibleError ? "true" : undefined}
            aria-describedby={`${codeHelpId}${visibleError ? ` ${codeErrorId}` : ""}`}
          />
          <span id={codeHelpId} className="field-hint">
            Use 2–8 uppercase letters or numbers per segment, separated by
            hyphens; for example EU, US-CA, or BR.
          </span>
          {visibleError ? (
            <span id={codeErrorId} className="field-error" role="alert">
              {visibleError}
            </span>
          ) : null}
        </label>

        <label className="privacy-region-field" htmlFor={frameworkId}>
          <span>Privacy framework</span>
          <select
            id={frameworkId}
            name="privacy-framework"
            className="input"
            value={framework}
            onChange={(event) =>
              onFramework(event.target.value as PrivacyFramework)
            }
            disabled={busy}
          >
            {FRAMEWORKS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <span className="field-hint">
            Choose the legal framework used by send-time eligibility checks.
          </span>
        </label>
      </div>

      <fieldset className="privacy-region-requirements" disabled={busy}>
        <legend>Consent requirements and defaults</legend>
        <ToggleRow
          label="Require double opt-in"
          detail="Recipients need a confirmed opt-in before eligible sends."
          checked={requiresDOI}
          onChange={onRequiresDOI}
        />
        <ToggleRow
          label="Require explicit consent"
          detail="Eligibility requires an explicit consent record."
          checked={requiresExplicit}
          onChange={onRequiresExplicit}
        />
        <ToggleRow
          label="Enable do-not-sell by default"
          detail="New regional preference records default to do-not-sell."
          checked={doNotSell}
          onChange={onDoNotSell}
        />
        <ToggleRow
          label="Honor Global Privacy Control"
          detail="A browser GPC signal is applied as a privacy preference."
          checked={gpcHonored}
          onChange={onGpcHonored}
        />
      </fieldset>

      <div className="privacy-region-form-actions">
        <button
          type="button"
          className="btn pw-discoverable-unavailable"
          onClick={() => {
            if (!busy) onCancel();
          }}
          aria-disabled={busy || undefined}
          aria-describedby={busy ? operationHelpId : undefined}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary pw-discoverable-unavailable"
          aria-disabled={busy || undefined}
          aria-busy={busy ? "true" : undefined}
          aria-describedby={busy ? operationHelpId : codeHelpId}
        >
          {busy ? "Adding region…" : "Add region"}
        </button>
      </div>
    </form>
  );
}

function ToggleRow({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}): ReactElement {
  return (
    <label className="privacy-region-toggle" aria-label={label}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </label>
  );
}

function RegionList({
  regions,
  operationActive,
  operationHelpId,
  onDelete,
}: {
  regions: PrivacyPortalRegion[];
  operationActive: boolean;
  operationHelpId: string;
  onDelete: (id: string, code: string) => void;
}): ReactElement {
  if (regions.length === 0) {
    return (
      <div className="privacy-region-empty" role="status">
        <strong>No privacy regions are configured.</strong>
        <span>
          Add at least one region so send-time eligibility can apply a named
          privacy framework and consent policy.
        </span>
      </div>
    );
  }

  return (
    <div>
      <p className="privacy-region-count">
        {regions.length} {regions.length === 1 ? "region" : "regions"}
        {" configured"}
      </p>
      <ul
        className="privacy-region-list"
        aria-label="Configured privacy regions"
      >
        {regions.map((region) => (
          <li key={region.id} className="privacy-region-item">
            <article>
              <header className="privacy-region-item-header">
                <div>
                  <h4>{region.region_code}</h4>
                  <p>{frameworkLabel(region.framework)}</p>
                  <p className="privacy-region-id">
                    Configuration ID: <code>{region.id}</code>
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost pw-discoverable-unavailable"
                  onClick={() => {
                    if (!operationActive) {
                      onDelete(region.id, region.region_code);
                    }
                  }}
                  aria-label={`Remove privacy region ${region.region_code}`}
                  aria-disabled={operationActive || undefined}
                  aria-describedby={operationHelpId}
                >
                  Remove
                </button>
              </header>
              <dl className="privacy-region-definition-grid">
                <RequirementDefinition
                  term="Double opt-in"
                  value={
                    region.requires_double_optin ? "Required" : "Not required"
                  }
                  active={region.requires_double_optin}
                />
                <RequirementDefinition
                  term="Explicit consent"
                  value={
                    region.requires_explicit_consent
                      ? "Required"
                      : "Not required"
                  }
                  active={region.requires_explicit_consent}
                />
                <RequirementDefinition
                  term="Do-not-sell default"
                  value={region.do_not_sell_default ? "Enabled" : "Not enabled"}
                  active={region.do_not_sell_default}
                />
                <RequirementDefinition
                  term="Global Privacy Control"
                  value={region.gpc_honored ? "Honored" : "Not honored"}
                  active={region.gpc_honored}
                />
              </dl>
            </article>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RequirementDefinition({
  term,
  value,
  active,
}: {
  term: string;
  value: string;
  active: boolean;
}): ReactElement {
  return (
    <div>
      <dt>{term}</dt>
      <dd data-active={active ? "true" : "false"}>{value}</dd>
    </div>
  );
}

function RegionFeedbackNotice({
  feedback,
}: {
  feedback: RegionFeedback;
}): ReactElement {
  return (
    <div
      className="privacy-region-feedback"
      data-tone={feedback.tone}
      role={feedback.tone === "error" ? "alert" : "status"}
      aria-live={feedback.tone === "error" ? "assertive" : "polite"}
    >
      <strong>{feedback.message}</strong>
      {feedback.detail ? <span>{feedback.detail}</span> : null}
    </div>
  );
}

function frameworkLabel(framework: PrivacyFramework): string {
  return (
    FRAMEWORKS.find((item) => item.value === framework)?.label ??
    framework.toUpperCase()
  );
}

function validateRegionCode(
  value: string,
  regions: PrivacyPortalRegion[],
): string | null {
  const code = value.trim().toUpperCase();
  if (!code) return "Enter a region code.";
  if (code.length > 32)
    return "Region codes can contain at most 32 characters.";
  if (!REGION_CODE_PATTERN.test(code)) {
    return "Use 2–8 uppercase letters or numbers per segment, separated by hyphens.";
  }
  if (
    regions.some((region) => region.region_code.trim().toUpperCase() === code)
  ) {
    return `${code} is already configured.`;
  }
  return null;
}

function normalizeRemoteError(error: unknown): RemoteApiError {
  if (!error || typeof error !== "object") return {};
  const source = error as Record<string, unknown>;
  const kind =
    typeof source.kind === "string" &&
    REMOTE_ERROR_KINDS.has(source.kind as NonNullable<RemoteApiError["kind"]>)
      ? (source.kind as NonNullable<RemoteApiError["kind"]>)
      : undefined;
  return {
    ...(typeof source.message === "string" ? { message: source.message } : {}),
    ...(typeof source.status === "number" ? { status: source.status } : {}),
    ...(typeof source.code === "string" ? { code: source.code } : {}),
    ...(typeof source.requestId === "string"
      ? { requestId: source.requestId }
      : {}),
    ...(kind ? { kind } : {}),
  };
}

function regionOperationFailure(
  error: unknown,
  fallback: string,
  scope: OperationScope,
): { message: string; detail: string } {
  const normalized = normalizeRemoteError(error);
  const failure = remoteFailureFromError(normalized);
  let message = failure.message;
  if (failure.access === "denied") {
    message =
      normalized.status === 401 || normalized.code === "unauthorized"
        ? "Your session is no longer authorized to change privacy regions."
        : "Your current role cannot change privacy regions.";
  } else if (message === "The server could not verify this data.") {
    message = fallback;
  }

  const references = [
    failure.code ? `code ${failure.code}` : null,
    failure.requestId ? `request ${failure.requestId}` : null,
  ].filter((value): value is string => value !== null);
  const referenceDetail =
    references.length > 0
      ? ` Support reference: ${references.join(", ")}.`
      : "";
  return {
    message,
    detail: `${
      scope === "create"
        ? "No region change was confirmed; your region draft is preserved."
        : "No region change was confirmed; the region remains configured."
    }${referenceDetail}`,
  };
}

function committedRegionFeedback(
  code: string,
  action: "added" | "removed",
  refreshed: boolean,
): RegionFeedback {
  if (!refreshed) {
    return {
      scope: "refresh",
      tone: "warning",
      message: `${code} was ${action}, but the region list couldn't refresh.`,
      detail: "Refresh Privacy Portal before making another change.",
    };
  }
  return {
    scope: "refresh",
    tone: "success",
    message: `${code} was ${action}.`,
    detail:
      action === "added"
        ? "Its framework will be considered by future send-eligibility checks."
        : "Its framework will no longer be applied by future send-eligibility checks.",
  };
}

function notifyRegionChanged(
  onChanged: () => void,
  committed: string,
): boolean {
  try {
    onChanged();
    return true;
  } catch {
    toast.error({
      message: `${committed}, but the list couldn't refresh.`,
      detail: "Refresh Privacy Portal before making another change.",
    });
    return false;
  }
}
