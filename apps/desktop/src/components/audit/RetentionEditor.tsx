/**
 * RetentionEditor — inline editor for the per-tenant
 * audit_retention_days. Refined Audit PR 4.
 *
 * Reads /audit/retention; writes via PUT. Presents three quick
 * presets (90 / 365 / 2555) plus a custom integer input. The most
 * common compliance windows are surfaced as one-clicks; auditors
 * with bespoke requirements use the input.
 *
 * Sits under a "Retention" disclosure in the audit page header so
 * the editor doesn't clutter the default view.
 */

import {
  useCallback,
  type ReactElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { api } from "../../lib/api-client";
import {
  lifecycleOperationError,
  useExistingSettingLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import { useAuditScopes } from "../../lib/auditScopes";
import { toast } from "../Toast";

const PRESETS: Array<{ days: number; label: string; tag: string }> = [
  { days: 90, label: "90 days", tag: "Standard" },
  { days: 365, label: "1 year", tag: "SOC 2" },
  { days: 2555, label: "7 years", tag: "HIPAA" },
];

interface RetentionDraftValidation {
  days: number | null;
  error: string | null;
}

export function validateAuditRetentionDraft(
  value: string,
): RetentionDraftValidation {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return { days: null, error: "Enter a whole number from 1 to 3650." };
  }
  const days = Number(normalized);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
    return { days: null, error: "Enter a whole number from 1 to 3650." };
  }
  return { days, error: null };
}

interface RetentionFeedback {
  tone: "success" | "error";
  message: string;
}

export function RetentionEditor(): ReactElement {
  // D13-governance-privacy#11: PUT /api/v1/audit/retention is mounted
  // with RequireScope(ScopeAuditConfigureRetention). Gate the mutating
  // controls (presets / Default / custom Apply) so audit_viewer-role
  // operators don't get an enabled-looking button that always 403s.
  // Fails CLOSED while scopes load (useAuditScopes grants nothing on a
  // failed fetch), matching the page's existing scope-gating pattern.
  const {
    hasScope,
    loading: scopesLoading,
    error: scopesError,
  } = useAuditScopes();
  const canConfigure = hasScope("audit:configure_retention");
  const [current, setCurrent] = useState<number | null>(null);
  const [defaultDays, setDefaultDays] = useState<number>(90);
  const [draft, setDraft] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<RetentionFeedback | null>(null);
  const mountedRef = useRef(true);
  const loadRequestRef = useRef<Promise<void> | null>(null);
  const loadGenerationRef = useRef(0);
  const availabilityId = useId();
  const validationId = useId();
  const operationStatusId = useId();
  const operation = useSingleFlightOperation({
    ownerId: "audit-retention-setting",
    label: "Audit retention update",
    detail: "Wait for the audit-retention request to finish before leaving.",
  });

  const loadRetention = useCallback((): Promise<void> => {
    const pending = loadRequestRef.current;
    if (pending) return pending;
    const generation = ++loadGenerationRef.current;
    setLoaded(false);
    setLoadErr(null);
    setFeedback(null);
    let request!: Promise<void>;
    request = (async (): Promise<void> => {
      try {
        const response = await api.getAuditRetention();
        if (!mountedRef.current || generation !== loadGenerationRef.current) {
          return;
        }
        if (response.error || !response.data) {
          setLoadErr(
            response.error?.message ?? "The retention setting was unavailable.",
          );
          return;
        }
        setCurrent(response.data.retentionDays);
        setDefaultDays(response.data.defaultDays);
        setDraft(
          response.data.retentionDays == null
            ? ""
            : String(response.data.retentionDays),
        );
      } catch (error) {
        if (!mountedRef.current || generation !== loadGenerationRef.current) {
          return;
        }
        setLoadErr(
          lifecycleOperationError(
            error,
            "The retention setting couldn't be loaded.",
          ),
        );
      } finally {
        if (mountedRef.current && generation === loadGenerationRef.current) {
          setLoaded(true);
        }
        if (loadRequestRef.current === request) {
          loadRequestRef.current = null;
        }
      }
    })();
    loadRequestRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadRetention();
    return () => {
      mountedRef.current = false;
    };
  }, [loadRetention]);

  const persistentUnavailableReason = scopesLoading
    ? "Checking whether you can change audit retention."
    : scopesError
      ? `Permissions could not be verified: ${scopesError}`
      : !canConfigure
        ? "View-only — changing retention requires the audit:configure_retention scope."
        : !loaded
          ? "Loading the current retention setting."
          : loadErr
            ? "The current retention setting could not be verified. Retry before changing it."
            : null;
  const canMutate = persistentUnavailableReason == null;

  const save = async (days: number | null): Promise<boolean> => {
    if (!canMutate) return false;
    const pending = operation.promiseRef.current;
    if (pending) return (await pending) === true;
    setFeedback(null);
    const request = operation.run(async (): Promise<boolean> => {
      try {
        const res = await api.setAuditRetention(days);
        if (res.error) {
          const message = `Save failed: ${res.error.message}`;
          if (mountedRef.current) setFeedback({ tone: "error", message });
          toast.error(message);
          return false;
        }
        const message =
          days == null
            ? `Retention reverted to deployment default (${defaultDays} days)`
            : `Retention set to ${days} days`;
        if (mountedRef.current) {
          setCurrent(days);
          setDraft(days == null ? "" : String(days));
          setFeedback({ tone: "success", message });
        }
        toast.success(message);
        return true;
      } catch (error) {
        const message = lifecycleOperationError(
          error,
          "The retention update failed.",
        );
        if (mountedRef.current) setFeedback({ tone: "error", message });
        toast.error(message);
        return false;
      }
    });
    return request ? await request : false;
  };

  const submitDraft = async (): Promise<boolean> => {
    if (!canMutate) return false;
    const validation = validateAuditRetentionDraft(draft);
    if (validation.error || validation.days == null) {
      const message = validation.error ?? "Enter a valid retention window.";
      setFeedback({ tone: "error", message });
      toast.error(message);
      return false;
    }
    return save(validation.days);
  };
  const baselineDraft = current == null ? "" : String(current);
  const draftValidation = validateAuditRetentionDraft(draft);
  const applyUnavailableReason =
    persistentUnavailableReason ??
    draftValidation.error ??
    (draft === baselineDraft ? "No unsaved custom retention change." : null);
  useExistingSettingLifecycle({
    ownerId: "audit-retention-setting",
    label: "Audit retention changes",
    dirty: loaded && !loadErr && draft !== baselineDraft,
    operationRef: operation.promiseRef,
    save: submitDraft,
    discard: () => setDraft(baselineDraft),
    detail: "This custom audit-retention window has not been saved.",
    operationDetail:
      "Wait for the audit-retention request to finish before leaving Moosewave.",
    enabled: canMutate,
  });

  const effective = current ?? defaultDays;
  return (
    <details className="audit-retention">
      <summary className="muted small">
        Retention:{" "}
        <strong>
          {!loaded ? "Loading…" : loadErr ? "Unavailable" : `${effective}d`}
        </strong>
        {loaded && !loadErr && current == null ? " (deployment default)" : ""}
      </summary>
      <div className="audit-retention-body">
        <p id={availabilityId} className="muted small audit-retention-help">
          {persistentUnavailableReason ??
            "Changes save immediately and apply to the next trim-worker run."}
        </p>
        {loadErr ? (
          <div className="audit-retention-error" role="alert">
            <span>Couldn&apos;t load retention: {loadErr}</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void loadRetention()}
              disabled={!loaded}
            >
              {!loaded ? "Retrying…" : "Retry"}
            </button>
          </div>
        ) : null}
        <div className="audit-retention-presets">
          {PRESETS.map((p) => (
            <button
              key={p.days}
              type="button"
              className={`chip${current === p.days ? " is-active" : ""}`}
              aria-pressed={current === p.days}
              aria-disabled={!canMutate}
              aria-describedby={`${availabilityId} ${operationStatusId}`}
              onClick={() => {
                if (canMutate && !operation.promiseRef.current) {
                  void save(p.days);
                }
              }}
              disabled={operation.active}
            >
              {p.label}
              <span className="muted small" style={{ marginLeft: 4 }}>
                {p.tag}
              </span>
            </button>
          ))}
          <button
            type="button"
            className={`chip${current == null ? " is-active" : ""}`}
            aria-pressed={current == null && loaded && !loadErr}
            aria-disabled={!canMutate}
            aria-describedby={`${availabilityId} ${operationStatusId}`}
            onClick={() => {
              if (canMutate && !operation.promiseRef.current) void save(null);
            }}
            disabled={operation.active}
          >
            Deployment default
            <span className="muted small" style={{ marginLeft: 4 }}>
              {defaultDays} days
            </span>
          </button>
        </div>
        <form
          className="audit-retention-custom"
          onSubmit={(event) => {
            event.preventDefault();
            if (!applyUnavailableReason && !operation.promiseRef.current) {
              void submitDraft();
            }
          }}
        >
          <label className="muted small" htmlFor="audit-retention-days">
            Custom (days)
          </label>
          <input
            id="audit-retention-days"
            type="number"
            min={1}
            max={3650}
            className="input"
            style={{ width: 100, fontSize: 12 }}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setFeedback(null);
            }}
            readOnly={!canMutate}
            disabled={operation.active || !loaded}
            aria-invalid={draft.length > 0 && draftValidation.error != null}
            aria-describedby={`${validationId} ${availabilityId} ${operationStatusId}`}
          />
          <button
            type="submit"
            className="btn btn-sm"
            aria-disabled={applyUnavailableReason != null}
            aria-describedby={`${validationId} ${availabilityId} ${operationStatusId}`}
            disabled={operation.active}
          >
            Apply
          </button>
        </form>
        <p id={validationId} className="muted small audit-retention-help">
          {applyUnavailableReason ??
            `Ready to apply ${draftValidation.days ?? "the custom window"} days.`}
        </p>
        <div
          id={operationStatusId}
          className={`small audit-retention-status${
            feedback?.tone === "error" ? " is-error" : ""
          }`}
          role={feedback?.tone === "error" ? "alert" : "status"}
          aria-live={feedback?.tone === "error" ? "assertive" : "polite"}
          aria-atomic="true"
        >
          {operation.active
            ? "Saving retention…"
            : (feedback?.message ?? "No retention update in progress.")}
        </div>
        <div className="muted audit-retention-policy-note">
          The trim worker reads this on each tick and deletes audit_log rows
          older than the window. Deployment default is {defaultDays} days.
        </div>
      </div>
    </details>
  );
}
