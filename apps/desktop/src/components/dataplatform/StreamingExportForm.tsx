/**
 * StreamingExportForm — SUB-111 review/validation modal for a scheduled
 * streaming-export destination backed by tenant-bound workspace storage.
 *
 * A streaming-export destination is created as a warehouse_connection
 * with provider="streaming_export"; this modal collects the
 * streaming-specific knobs (prefix, format, compression, batch size, and
 * optional field filters) and:
 *   1. validates the config block server-side via
 *      POST /api/v1/warehouse/streaming/validate (errors + warnings
 *      rendered), then
 *   2. creates the connection via the warehouse connections endpoint.
 *
 * Mirrors the existing ConnectionCreateModal posture: client-side draft
 * validation first, then an honest server validation panel, then save.
 *
 * Backend: apps/api/internal/streaming_export +
 * apps/api/internal/warehouse (connections CRUD).
 */

import { useId, useState, type ReactElement } from "react";

import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import { ConfirmModal } from "../ConfirmModal";
import { FormField } from "../FormField";
import { Modal, ModalFooter } from "../Modal";
import { Notice } from "../Notice";
import { toast } from "../Toast";
import {
  warehouseApi,
  type WarehouseValidationResult,
} from "../../lib/api-client";
import {
  STREAMING_COMPRESSIONS,
  STREAMING_FORMATS,
  STREAMING_INTERVALS,
  type StreamingExportDraft,
  emptyStreamingExportDraft,
  extractWarehouseValidation,
  streamingDraftErrors,
  streamingDraftToConfig,
  streamingDraftToConnectionInput,
} from "./warehouse-helpers";
import { safeDataPlatformFailure } from "./safe-failures";

function normalizedValidationResult(
  result: WarehouseValidationResult | null | undefined,
): WarehouseValidationResult | null {
  if (!result) return null;
  try {
    return extractWarehouseValidation(JSON.stringify(result));
  } catch {
    return null;
  }
}

function ValidationPanel({
  result,
  transportError,
  validating,
}: {
  result: WarehouseValidationResult | null;
  transportError: string | null;
  validating: boolean;
}): ReactElement | null {
  if (validating) {
    return (
      <p className="muted" style={{ fontSize: 12 }}>
        Validating against the server…
      </p>
    );
  }
  if (transportError) {
    return (
      <Notice tone="danger" announcement="assertive">
        Couldn&apos;t reach the validator: {transportError}
      </Notice>
    );
  }
  if (!result) return null;
  return (
    <div
      style={{
        border: `1px solid ${result.valid ? "color-mix(in srgb, var(--pw-accent) 35%, transparent)" : "color-mix(in srgb, var(--pw-danger) 35%, transparent)"}`,
        borderRadius: 6,
        padding: "10px 12px",
        fontSize: 12,
        marginTop: 8,
      }}
      role="status"
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {result.valid ? "Server validation passed" : "Server validation failed"}
      </div>
      {(result.errors ?? []).map((e, i) => (
        <div key={`e${i}`} style={{ color: "var(--pw-danger)" }}>
          ✕ {e}
        </div>
      ))}
      {(result.warnings ?? []).map((w, i) => (
        <div key={`w${i}`} style={{ color: "var(--pw-warning)" }}>
          ⚠ {w}
        </div>
      ))}
    </div>
  );
}

export function StreamingExportForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const baseline = emptyStreamingExportDraft();
  const [draft, setDraft] = useState<StreamingExportDraft>(
    emptyStreamingExportDraft,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [validating, setValidating] = useState(false);
  const [serverResult, setServerResult] =
    useState<WarehouseValidationResult | null>(null);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [validatedOnce, setValidatedOnce] = useState(false);
  const saveDescriptionId = useId();
  const busyReasonId = useId();

  const patch = (p: Partial<StreamingExportDraft>): void => {
    setDraft((d) => ({ ...d, ...p }));
    setValidatedOnce(false);
    setServerResult(null);
  };

  const runValidate = async (): Promise<WarehouseValidationResult | null> => {
    const e = streamingDraftErrors(draft);
    setErrors(e);
    if (Object.keys(e).length > 0) return null;
    setValidating(true);
    setValidateError(null);
    let res;
    try {
      res = await warehouseApi.validateStreaming(streamingDraftToConfig(draft));
    } finally {
      setValidating(false);
    }
    if (res.error) {
      const recovered = extractWarehouseValidation(res.error.message);
      if (recovered) {
        setServerResult(recovered);
        setValidatedOnce(true);
        return recovered;
      }
      setValidateError(
        safeDataPlatformFailure(
          res.error,
          "The streaming service could not validate this destination.",
        ),
      );
      setServerResult(null);
      return null;
    }
    const normalized = normalizedValidationResult(res.data);
    if (!normalized) {
      setValidateError(
        "The streaming validator returned an unusable response. Retry validation before saving.",
      );
      setServerResult(null);
      setValidatedOnce(false);
      return null;
    }
    setServerResult(normalized);
    setValidatedOnce(true);
    return normalized;
  };

  const save = async (): Promise<boolean> => {
    const v =
      validatedOnce && serverResult ? serverResult : await runValidate();
    // Workspace-storage warnings are non-blocking; only hard errors stop save.
    if (!v || !v.valid) return false;
    const res = await warehouseApi.createConnection(
      streamingDraftToConnectionInput(draft),
    );
    if (res.error) {
      const recovered = extractWarehouseValidation(res.error.message);
      if (recovered) {
        setServerResult(recovered);
        return false;
      }
      // GAP-1#13: the client core truncates unenveloped error bodies to 200
      // chars, so a large create-400 ValidationResult arrives as unparseable
      // truncated JSON (recovered === null). Re-fetch the full structured
      // result from the validate endpoint (always 200, untruncated) instead
      // of dumping the cut-off blob into errors.form.
      const revalidated = await warehouseApi.validateStreaming(
        streamingDraftToConfig(draft),
      );
      const normalized = !revalidated.error
        ? normalizedValidationResult(revalidated.data)
        : null;
      if (normalized) {
        setServerResult(normalized);
        return false;
      }
      setErrors({
        form: safeDataPlatformFailure(
          res.error,
          "The warehouse service could not create this destination.",
        ),
      });
      return false;
    }
    toast.success(`Streaming export "${draft.name.trim()}" created`);
    onSaved();
    return true;
  };

  const lifecycle = useDraftLifecycleController({
    ownerId: "streaming-export-create",
    label: "New streaming export draft",
    mode: "create",
    enabled: true,
    dirty: (Object.keys(baseline) as Array<keyof StreamingExportDraft>).some(
      (key) => draft[key] !== baseline[key],
    ),
    save,
    discard: () => {
      setDraft(baseline);
      setErrors({});
      setServerResult(null);
      setValidateError(null);
      setValidatedOnce(false);
    },
    close: onClose,
    detail:
      "This streaming export has not been created. Return to it or explicitly discard it.",
    operationDetail:
      "Wait for the streaming-export request to finish before leaving Moosewave.",
    onError: (error) =>
      setErrors({
        form: safeDataPlatformFailure(
          error,
          "The streaming export couldn't be saved.",
        ),
      }),
  });

  const runPreflight = async (): Promise<void> => {
    const request = lifecycle.runOperation(runValidate);
    if (!request) return;
    try {
      await request;
    } catch (error) {
      setValidating(false);
      setValidateError(
        safeDataPlatformFailure(error, "The validation request failed."),
      );
    }
  };

  return (
    <Modal
      open
      onClose={lifecycle.requestClose}
      closeOnBackdrop={!lifecycle.active}
      closeOnEscape={!lifecycle.active}
      closeDisabled={lifecycle.active}
      size="lg"
      title="New streaming export"
      description="Scheduled subscriber-event batches use tenant-bound Moosewave workspace storage with failure-safe, overflow-safe cursors."
    >
      <form
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          if (lifecycle.active || lifecycle.promiseRef.current) return;
          void lifecycle.submit();
        }}
      >
        <fieldset
          disabled={lifecycle.active}
          style={{ border: 0, margin: 0, padding: 0 }}
        >
          {errors.form ? (
            <Notice
              tone="danger"
              announcement="assertive"
              style={{ marginBottom: 12 }}
            >
              {errors.form}
            </Notice>
          ) : null}

          <StreamingExportDraftFields
            draft={draft}
            errors={errors}
            validationResult={serverResult}
            validationError={validateError}
            validating={validating}
            onPatch={patch}
          />
        </fieldset>
        <StreamingExportFooter
          busy={lifecycle.active}
          validating={validating}
          saveDescriptionId={saveDescriptionId}
          busyReasonId={busyReasonId}
          onClose={lifecycle.requestClose}
          onValidate={() => void runPreflight()}
        />
      </form>
      <StreamingExportConfirms
        discardOpen={lifecycle.discardConfirmOpen}
        busy={lifecycle.active}
        onDiscard={lifecycle.discardAndClose}
        onKeepEditing={lifecycle.keepEditing}
      />
    </Modal>
  );
}

function StreamingExportDraftFields({
  draft,
  errors,
  validationResult,
  validationError,
  validating,
  onPatch,
}: {
  draft: StreamingExportDraft;
  errors: Record<string, string>;
  validationResult: WarehouseValidationResult | null;
  validationError: string | null;
  validating: boolean;
  onPatch: (patch: Partial<StreamingExportDraft>) => void;
}): ReactElement {
  return (
    <>
      <FormField label="Name" required error={errors.name}>
        <input
          type="text"
          value={draft.name}
          onChange={(event) => onPatch({ name: event.target.value })}
          placeholder="e.g. Events → Snowflake"
        />
      </FormField>

      <StreamingDestinationFields draft={draft} onPatch={onPatch} />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 12,
        }}
      >
        <FormField label="Format" error={errors.format}>
          <select
            value={draft.format}
            onChange={(event) => onPatch({ format: event.target.value })}
          >
            {STREAMING_FORMATS.map((format) => (
              <option key={format} value={format}>
                {format}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Compression" error={errors.compression}>
          <select
            value={draft.compression}
            onChange={(event) => onPatch({ compression: event.target.value })}
          >
            {STREAMING_COMPRESSIONS.map((compression) => (
              <option key={compression} value={compression}>
                {compression}
              </option>
            ))}
          </select>
        </FormField>
        <FormField
          label="Batch size"
          error={errors.batchSize}
          help="Rows per shipment."
        >
          <input
            type="number"
            min={100}
            value={draft.batchSize}
            onChange={(event) => onPatch({ batchSize: event.target.value })}
          />
        </FormField>
      </div>

      <FormField
        label="Field filters (optional)"
        help="Comma-separated event types to include. Empty exports all subscriber.* events."
      >
        <input
          type="text"
          value={draft.fieldFilters}
          onChange={(event) => onPatch({ fieldFilters: event.target.value })}
          placeholder="open, click, purchase"
        />
      </FormField>

      <ValidationPanel
        result={validationResult}
        transportError={validationError}
        validating={validating}
      />
    </>
  );
}

function StreamingDestinationFields({
  draft,
  onPatch,
}: {
  draft: StreamingExportDraft;
  onPatch: (patch: Partial<StreamingExportDraft>) => void;
}): ReactElement {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <FormField label="Batch interval">
        <select
          value={draft.interval}
          onChange={(event) => onPatch({ interval: event.target.value })}
        >
          {STREAMING_INTERVALS.map((interval) => (
            <option key={interval} value={interval}>
              {interval}
            </option>
          ))}
        </select>
      </FormField>
      <FormField
        label="Workspace-storage prefix"
        help="Relative path under this tenant's Moosewave object store."
      >
        <input
          type="text"
          value={draft.prefix}
          onChange={(event) => onPatch({ prefix: event.target.value })}
          placeholder="streaming-export"
        />
      </FormField>
    </div>
  );
}

function StreamingExportConfirms({
  discardOpen,
  busy,
  onDiscard,
  onKeepEditing,
}: {
  discardOpen: boolean;
  busy: boolean;
  onDiscard: () => void;
  onKeepEditing: () => void;
}): ReactElement {
  return (
    <>
      <ConfirmModal
        open={discardOpen}
        title="Discard streaming-export draft?"
        description="The destination has not been created."
        confirmLabel="Discard draft"
        danger
        busy={busy}
        onConfirm={onDiscard}
        onClose={onKeepEditing}
      />
    </>
  );
}

function StreamingExportFooter({
  busy,
  validating,
  saveDescriptionId,
  busyReasonId,
  onClose,
  onValidate,
}: {
  busy: boolean;
  validating: boolean;
  saveDescriptionId: string;
  busyReasonId: string;
  onClose: () => void;
  onValidate: () => void;
}): ReactElement {
  return (
    <ModalFooter>
      <span id={saveDescriptionId} className="visually-hidden">
        Creates an hourly export in tenant-bound workspace storage after the
        exact draft passes server validation.
      </span>
      {busy ? (
        <span id={busyReasonId} className="visually-hidden" role="status">
          Wait for the current streaming-export request to finish.
        </span>
      ) : null}
      <button
        type="button"
        className="btn"
        aria-disabled={busy || undefined}
        aria-describedby={busy ? busyReasonId : undefined}
        onClick={() => {
          if (busy) return;
          onClose();
        }}
      >
        Cancel
      </button>
      <button
        type="button"
        className="btn"
        aria-disabled={busy || undefined}
        aria-describedby={busy ? busyReasonId : undefined}
        onClick={() => {
          if (busy) return;
          onValidate();
        }}
      >
        {validating ? "Validating…" : "Validate"}
      </button>
      <button
        type="submit"
        className="btn btn-primary"
        aria-disabled={busy || undefined}
        aria-describedby={
          busy ? `${saveDescriptionId} ${busyReasonId}` : saveDescriptionId
        }
        onClick={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        {busy && !validating ? "Saving…" : "Create streaming export"}
      </button>
    </ModalFooter>
  );
}
