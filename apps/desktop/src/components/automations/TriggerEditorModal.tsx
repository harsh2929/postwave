/**
 * TriggerEditorModal — create / edit a zero-copy trigger (#28).
 *
 * Live validation: while the operator types, the draft is debounced
 * (700ms) through POST /zero-copy-triggers/validate and the resulting
 * ValidationResult is rendered verbatim — green only when the server
 * said `valid: true`, every error and warning listed as returned.
 *
 * Save errors: create/update return HTTP 400 whose body IS the
 * validation result (WIRING-WRAPPERS.md deviation #5). We try to
 * recover the structured list via extractValidationResult(); when
 * that fails (truncated/plain-text body) the raw message is shown.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";

import { FormField } from "../FormField";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { usePersistentLifecycleOperation } from "../../hooks/usePersistentLifecycleOperation";
import {
  type ZeroCopyTrigger,
  type ZeroCopyValidationResult,
  zeroCopyTriggersApi,
} from "../../lib/api-client";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";

import {
  KNOWN_PROVIDERS,
  MAX_POLL_INTERVAL_SECONDS,
  MAX_ROWS_PER_TICK,
  MIN_POLL_INTERVAL_SECONDS,
  type TriggerDraft,
  canValidate,
  draftErrors,
  draftFromTrigger,
  draftToInput,
  extractValidationResult,
  normalizeValidationResult,
  savedTriggerMatchesInput,
} from "./zero-copy-helpers";
import { normalizeTriggerDefinition } from "./response-normalizers";

const VALIDATE_DEBOUNCE_MS = 700;

export function TriggerEditorModal({
  mode,
  existing,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  existing?: ZeroCopyTrigger;
  onClose: () => void;
  onSaved: () => Promise<boolean | void>;
}): ReactElement {
  const [draft, setDraft] = useState<TriggerDraft>(() =>
    draftFromTrigger(existing),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const saveOperation = usePersistentLifecycleOperation({
    ownerId: `zero-copy-trigger-${existing?.id ?? "create"}`,
    label:
      mode === "create"
        ? "Creating trigger draft"
        : "Saving trigger definition",
    detail: "Wait for this trigger definition to finish saving before exiting.",
  });
  const busy = saveOperation.active;
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(draftFromTrigger(existing));

  useEffect(() => {
    if (!dirty && !busy) return;
    return registerLifecycleGuard({
      id: `zero-copy-trigger-${existing?.id ?? "create"}`,
      label: mode === "create" ? "New zero-copy trigger" : "Trigger changes",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : busy
            ? {
                level: "blocking",
                detail: "The zero-copy trigger is still being saved.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail:
                  "The zero-copy query or trigger settings have unsaved local changes.",
              },
      discard: onClose,
    });
  }, [busy, dirty, existing?.id, mode, onClose]);

  // Live server validation state. `serverResult` is the most recent
  // ValidationResult; `validating` covers the in-flight window;
  // `validateError` is a transport-level failure of the validate call
  // itself (offline, 5xx) — rendered distinctly from "invalid".
  const [serverResult, setServerResult] =
    useState<ZeroCopyValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);
  const validateSeq = useRef(0);

  const patch = (p: Partial<TriggerDraft>): void => {
    if (saveOperation.promiseRef.current) return;
    setDraft((d) => ({ ...d, ...p }));
  };

  useEffect(() => {
    if (!canValidate(draft)) {
      setServerResult(null);
      setValidating(false);
      setValidateError(null);
      return;
    }
    const seq = ++validateSeq.current;
    setValidating(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await zeroCopyTriggersApi.validate(draftToInput(draft));
          if (seq !== validateSeq.current) return;
          if (res.error) {
            setServerResult(null);
            setValidateError(
              "The validator request failed. Retry, then review secure service logs if it persists.",
            );
            return;
          }
          const normalized = normalizeValidationResult(res.data);
          if (!normalized) {
            setServerResult(null);
            setValidateError(
              "The validator returned a malformed response. No validation conclusion was accepted.",
            );
            return;
          }
          setValidateError(null);
          setServerResult(normalized);
        } catch {
          if (seq !== validateSeq.current) return;
          setServerResult(null);
          setValidateError("The validation request did not complete.");
        } finally {
          if (seq === validateSeq.current) setValidating(false);
        }
      })();
    }, VALIDATE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      if (validateSeq.current === seq) validateSeq.current += 1;
    };
    // Re-run on every draft keystroke — that's the point of live validation.
  }, [draft]);

  const save = async (): Promise<void> => {
    const e = draftErrors(draft);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    const input = draftToInput(draft);
    let serverAccepted = false;
    const pending = saveOperation.run(async () => {
      const response =
        mode === "create"
          ? await zeroCopyTriggersApi.create(input)
          : await zeroCopyTriggersApi.update(existing?.id ?? "", input);
      if (response.error)
        return { response, normalizationError: null, suppressed: false };
      serverAccepted = true;
      const normalized = normalizeTriggerDefinition(
        response.data,
        mode === "edit" ? existing?.id : undefined,
      );
      if (!normalized.ok) {
        return {
          response,
          normalizationError: normalized.message,
          suppressed: false,
        };
      }
      if (!savedTriggerMatchesInput(normalized.value, input)) {
        return {
          response,
          normalizationError:
            "The server returned a trigger definition that did not match the saved draft.",
          suppressed: false,
        };
      }
      const reconciled = await onSaved();
      return {
        response,
        normalizationError: null,
        suppressed: reconciled === false,
      };
    });
    if (!pending) return;
    let res: Awaited<typeof pending>;
    try {
      res = await pending;
    } catch {
      toast.error({
        message:
          mode === "create"
            ? "Couldn't create trigger draft"
            : "Couldn't update trigger definition",
        detail: serverAccepted
          ? "The server accepted the definition, but desktop reconciliation did not complete. Refresh before retrying."
          : "The save request did not complete.",
      });
      return;
    }
    if (res.response.error) {
      const recovered = extractValidationResult(res.response.error.message);
      if (recovered) {
        // The 400 body was the validation result — render it in the
        // same panel the live validator uses.
        setServerResult(recovered);
        setValidateError(null);
        return;
      }
      toast.error({
        message:
          mode === "create"
            ? "Couldn't create trigger draft"
            : "Couldn't update trigger definition",
        detail: "Review secure service logs for the operational error.",
      });
      return;
    }
    if (res.normalizationError) {
      toast.error({
        message: "Saved response could not be verified",
        detail: `${res.normalizationError} The editor remains open; refresh before retrying.`,
      });
      return;
    }
    if (res.suppressed) return;
    toast.success(
      mode === "create"
        ? "Trigger draft created"
        : "Trigger definition updated",
    );
  };

  const requestClose = (): void => {
    if (saveOperation.promiseRef.current) return;
    if (dirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  };

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        size="lg"
        title={
          mode === "create"
            ? "New warehouse trigger draft"
            : `Edit ${existing?.name ?? "trigger"}`
        }
        description="Store a reviewable query definition. Validation checks accepted fields and query policy; it does not run the query, activate polling, or prove a journey can execute."
      >
        <TriggerEditorForm
          mode={mode}
          draft={draft}
          errors={errors}
          busy={busy}
          validating={validating}
          validationResult={serverResult}
          validationError={validateError}
          onPatch={patch}
          onCancel={requestClose}
          onSubmit={() => void save()}
        />
      </Modal>
      <ConfirmModal
        open={discardConfirmOpen}
        danger
        title="Discard unsaved trigger changes?"
        description="Your local query and definition changes have not been saved."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        onConfirm={() => {
          setDiscardConfirmOpen(false);
          onClose();
        }}
        onClose={() => setDiscardConfirmOpen(false)}
      />
    </>
  );
}

function TriggerEditorForm({
  mode,
  draft,
  errors,
  busy,
  validating,
  validationResult,
  validationError,
  onPatch,
  onCancel,
  onSubmit,
}: {
  mode: "create" | "edit";
  draft: TriggerDraft;
  errors: Record<string, string>;
  busy: boolean;
  validating: boolean;
  validationResult: ZeroCopyValidationResult | null;
  validationError: string | null;
  onPatch: (patch: Partial<TriggerDraft>) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): ReactElement {
  return (
    <form
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="automations-editor-boundary" role="note">
        <strong>Draft-only in this build</strong>
        <span>
          Live polling and activation are unavailable. A successful save or
          validation result is configuration evidence only.
        </span>
      </div>
      <FormField label="Name" required error={errors.name}>
        <input
          type="text"
          value={draft.name}
          disabled={busy}
          onChange={(event) => onPatch({ name: event.target.value })}
          placeholder="e.g. New high-LTV orders"
          autoComplete="off"
        />
      </FormField>

      <FormField
        label="Description (optional)"
        help="Explain the business intent so reviewers can evaluate the query without exposing provider configuration."
      >
        <textarea
          value={draft.description}
          disabled={busy}
          onChange={(event) => onPatch({ description: event.target.value })}
          placeholder="Describe which profiles this definition is intended to identify."
          rows={3}
        />
      </FormField>

      <div className="automations-form-grid automations-form-grid--two">
        <FormField
          label="Provider"
          required
          error={errors.provider}
          help="Choose one provider accepted by the trigger validator."
        >
          <select
            value={draft.provider}
            disabled={busy}
            onChange={(event) => onPatch({ provider: event.target.value })}
          >
            <option value="">Choose provider…</option>
            {KNOWN_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
        </FormField>
        <FormField
          label="Connection ID (optional)"
          error={errors.connectionId}
          help="Canonical UUID of the warehouse connection."
        >
          <input
            type="text"
            value={draft.connectionId}
            disabled={busy}
            onChange={(event) => onPatch({ connectionId: event.target.value })}
            placeholder="00000000-0000-4000-8000-000000000000"
            autoComplete="off"
          />
        </FormField>
      </div>

      <FormField
        label="Query"
        required
        error={errors.query}
        help="Must select the cursor and profile-key columns. If runtime support is later enabled, selected row fields may be retained in operational enqueue history."
      >
        <textarea
          value={draft.query}
          disabled={busy}
          onChange={(event) => onPatch({ query: event.target.value })}
          placeholder={
            "SELECT order_id, email, created_at\nFROM orders\nWHERE created_at > :cursor"
          }
          rows={5}
          style={{ fontFamily: "var(--pw-font-mono)", fontSize: 12 }}
        />
      </FormField>

      <div className="automations-form-grid automations-form-grid--two">
        <FormField
          label="Cursor column"
          required
          error={errors.cursorColumn}
          help="Monotonic column the poller advances past (timestamp or id)."
        >
          <input
            type="text"
            value={draft.cursorColumn}
            disabled={busy}
            onChange={(event) => onPatch({ cursorColumn: event.target.value })}
            placeholder="created_at"
            autoComplete="off"
          />
        </FormField>
        <FormField
          label="Profile-key column"
          required
          error={errors.profileKeyColumn}
          help="Column matched against subscriber profiles (usually email)."
        >
          <input
            type="text"
            value={draft.profileKeyColumn}
            disabled={busy}
            onChange={(event) =>
              onPatch({ profileKeyColumn: event.target.value })
            }
            placeholder="email"
            autoComplete="off"
          />
        </FormField>
      </div>

      <div className="automations-form-grid automations-form-grid--three">
        <FormField
          label="Polling interval (s)"
          error={errors.pollingIntervalSeconds}
        >
          <input
            type="number"
            min={MIN_POLL_INTERVAL_SECONDS}
            max={MAX_POLL_INTERVAL_SECONDS}
            value={draft.pollingIntervalSeconds}
            disabled={busy}
            onChange={(event) =>
              onPatch({ pollingIntervalSeconds: event.target.value })
            }
          />
        </FormField>
        <FormField label="Max rows per tick" error={errors.maxRowsPerTick}>
          <input
            type="number"
            min={1}
            max={MAX_ROWS_PER_TICK}
            value={draft.maxRowsPerTick}
            disabled={busy}
            onChange={(event) =>
              onPatch({ maxRowsPerTick: event.target.value })
            }
          />
        </FormField>
        <FormField label="Stored status" error={errors.status}>
          <select
            value={draft.status}
            disabled={busy}
            onChange={(event) => onPatch({ status: event.target.value })}
          >
            <option value="draft">draft</option>
            <option value="paused">paused</option>
            {draft.status === "active" ? (
              <option value="active" disabled>
                active (legacy; runtime blocked)
              </option>
            ) : null}
            {draft.status === "error" ? (
              <option value="error" disabled>
                error (legacy)
              </option>
            ) : null}
          </select>
        </FormField>
      </div>

      <div className="automations-form-grid automations-form-grid--two">
        <FormField
          label="Journey ID (optional)"
          error={errors.journeyId}
          help="Canonical UUID of the intended journey. The referenced journey is not checked end-to-end by input validation."
        >
          <input
            type="text"
            value={draft.journeyId}
            disabled={busy}
            onChange={(event) => onPatch({ journeyId: event.target.value })}
            placeholder="00000000-0000-4000-8000-000000000000"
            autoComplete="off"
          />
        </FormField>
      </div>

      <ValidationPanel
        enabled={canValidate(draft)}
        validating={validating}
        result={validationResult}
        transportError={validationError}
      />

      <ModalFooter>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy
            ? "Saving…"
            : mode === "create"
              ? "Create draft"
              : draft.status === "paused"
                ? "Save paused definition"
                : "Save draft"}
        </button>
      </ModalFooter>
    </form>
  );
}

/**
 * Renders the server's ValidationResult honestly:
 *   — nothing claimed until the server replied;
 *   — "Validating…" while in flight;
 *   — valid:true → success line (+ any warnings, verbatim);
 *   — valid:false → every error listed, verbatim;
 *   — transport failure of the validate call itself → a distinct
 *     callout (NOT rendered as "invalid" — we don't know).
 */
function ValidationPanel({
  enabled,
  validating,
  result,
  transportError,
}: {
  enabled: boolean;
  validating: boolean;
  result: ZeroCopyValidationResult | null;
  transportError: string | null;
}): ReactElement {
  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: "8px 12px",
        marginTop: 4,
        background: "var(--pw-bg-elev)",
        fontSize: 12,
      }}
      aria-live="polite"
    >
      <div className="label" style={{ marginBottom: 4 }}>
        Server validation
      </div>
      {!enabled ? (
        <span className="muted">
          Fill in provider, query, cursor column, and profile-key column to
          validate against the server.
        </span>
      ) : validating ? (
        <span className="muted">Validating…</span>
      ) : transportError ? (
        <span style={{ color: "var(--pw-danger)" }}>
          Couldn't reach the validator: {transportError}
        </span>
      ) : !result ? (
        <span className="muted">Waiting for the first validation pass.</span>
      ) : (
        <>
          {result.valid ? (
            <div>
              <span className="badge success">valid</span>{" "}
              <span className="muted">
                The server accepted this input shape. No warehouse query or
                journey execution was run.
              </span>
            </div>
          ) : (
            <div>
              <span className="badge danger">invalid</span>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {(result.errors ?? []).map((err, i) => (
                  <li key={i} style={{ color: "var(--pw-danger)" }}>
                    {err}
                  </li>
                ))}
                {(result.errors ?? []).length === 0 && (
                  <li className="muted">
                    The server returned no error details.
                  </li>
                )}
              </ul>
            </div>
          )}
          {(result.warnings ?? []).length > 0 && (
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {(result.warnings ?? []).map((w, i) => (
                <li key={i} style={{ color: "var(--pw-warning)" }}>
                  ⚠ {w}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
