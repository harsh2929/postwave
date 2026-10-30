/**
 * Data Platform → CDP transforms section (#37).
 *
 * A non-persistent server-side preview laboratory. Registered operations are
 * discoverable, JSON inputs are validated before transport, superseded
 * responses cannot overwrite newer work, and edited inputs visibly mark an
 * existing result as stale.
 */
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The horizontally scrollable result region must be keyboard reachable. */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";

import { Icon } from "../Icon";
import { FormField } from "../FormField";
import { Notice } from "../Notice";
import { SectionHeader } from "../SectionHeader";
import { Skeleton } from "../Skeleton";
import {
  type CDPTransformOutcome,
  cdpTransformsApi,
} from "../../lib/api-client";

import {
  SAMPLE_OPS,
  SAMPLE_PROPERTIES,
  outcomeSummary,
  parsePreviewInput,
  resultRows,
} from "./cdp-transforms-helpers";
import {
  classifiedDataPlatformIssue,
  safeDataPlatformFailure,
} from "./safe-failures";

type EditorTarget = "properties" | "ops";

const MAX_PROPERTIES_CHARS = 256 * 1024;
const MAX_OPERATIONS_CHARS = 128 * 1024;
const MAX_OPERATIONS = 100;
const MAX_FIELD_PATH_LENGTH = 256;
const MAX_FIELD_PATH_DEPTH = 16;
const MAX_EDITOR_JSON_DEPTH = 32;
const OPERATION_SKELETON_WIDTHS = [96, 122, 82] as const;

function editorBoundaryError(
  target: EditorTarget,
  text: string,
): string | null {
  const label = target === "properties" ? "Properties" : "Operations";
  const maxChars =
    target === "properties" ? MAX_PROPERTIES_CHARS : MAX_OPERATIONS_CHARS;
  if (text.length > maxChars) {
    return `${label} JSON must be ${maxChars.toLocaleString()} characters or fewer for local editing.`;
  }
  if (!hasBoundedJsonDepth(text)) {
    return `${label} JSON must be nested ${MAX_EDITOR_JSON_DEPTH} levels or fewer for local editing.`;
  }
  return null;
}

function hasBoundedJsonDepth(text: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_EDITOR_JSON_DEPTH) return false;
    } else if ((character === "}" || character === "]") && depth > 0) {
      depth -= 1;
    }
  }
  return true;
}

interface CdpTransformsController {
  ops: string[] | null;
  opsErr: string | null;
  propertiesText: string;
  opsText: string;
  propertiesError: string | null;
  opsError: string | null;
  outcome: CDPTransformOutcome | null;
  outcomeStale: boolean;
  previewErr: string | null;
  busy: boolean;
  opsEditorRef: RefObject<HTMLTextAreaElement | null>;
  refreshCatalog: () => void;
  retryCatalog: () => void;
  changeProperties: (value: string) => void;
  changeOperations: (value: string) => void;
  preview: () => Promise<void>;
  appendOperation: (type: string) => void;
  formatEditor: (target: EditorTarget) => void;
  resetExample: () => void;
}

function useCdpTransformsController(
  canAdmin: boolean,
): CdpTransformsController {
  const [ops, setOps] = useState<string[] | null>(null);
  const [opsErr, setOpsErr] = useState<string | null>(null);
  const [propertiesText, setPropertiesText] = useState(SAMPLE_PROPERTIES);
  const [opsText, setOpsText] = useState(SAMPLE_OPS);
  const [propertiesError, setPropertiesError] = useState<string | null>(null);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CDPTransformOutcome | null>(null);
  const [outcomeStale, setOutcomeStale] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(false);
  const opsRequestRef = useRef(0);
  const previewRequestRef = useRef(0);
  const previewFlightRef = useRef<Promise<void> | null>(null);
  const draftRevisionRef = useRef(0);
  const opsEditorRef = useRef<HTMLTextAreaElement | null>(null);

  const loadOps = useCallback(async (): Promise<void> => {
    const requestId = ++opsRequestRef.current;
    setOpsErr(null);
    try {
      const res = await cdpTransformsApi.ops();
      if (!mountedRef.current || requestId !== opsRequestRef.current) return;
      if (res.error) {
        setOpsErr(
          res.error.status === 404 || res.error.status === 405
            ? "CDP transforms aren't enabled on this Moosewave server."
            : "The registered operation catalog couldn't be verified.",
        );
        setOps([]);
        return;
      }
      setOps(res.data?.ops ?? []);
    } catch {
      if (!mountedRef.current || requestId !== opsRequestRef.current) return;
      setOpsErr(
        "Couldn't reach the transform catalog. Check the connection and retry.",
      );
      setOps([]);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadOps();
    return () => {
      mountedRef.current = false;
      opsRequestRef.current += 1;
      previewRequestRef.current += 1;
      previewFlightRef.current = null;
    };
  }, [loadOps]);

  const markEdited = (): void => {
    draftRevisionRef.current += 1;
    previewRequestRef.current += 1;
    previewFlightRef.current = null;
    setBusy(false);
    setPreviewErr(null);
    if (outcome) setOutcomeStale(true);
  };

  const preview = async (): Promise<void> => {
    if (previewFlightRef.current || busy || !canAdmin) return;
    if (propertiesText.length > MAX_PROPERTIES_CHARS) {
      setPropertiesError(
        `Properties JSON must be ${MAX_PROPERTIES_CHARS.toLocaleString()} characters or fewer for an interactive preview.`,
      );
      return;
    }
    if (opsText.length > MAX_OPERATIONS_CHARS) {
      setOpsError(
        `Operations JSON must be ${MAX_OPERATIONS_CHARS.toLocaleString()} characters or fewer for an interactive preview.`,
      );
      return;
    }
    const parsed = parsePreviewInput(propertiesText, opsText);
    let nextOpsError = parsed.opsError;
    if (!nextOpsError && parsed.ops && parsed.ops.length > MAX_OPERATIONS) {
      nextOpsError = `Use ${MAX_OPERATIONS.toLocaleString()} operations or fewer in one interactive preview.`;
    }
    const unsafePath = parsed.ops?.find((op) => {
      const path = op.field.trim();
      return (
        path.length > MAX_FIELD_PATH_LENGTH ||
        path.split(".").length > MAX_FIELD_PATH_DEPTH
      );
    });
    if (!nextOpsError && unsafePath) {
      nextOpsError = `Field paths must be ${MAX_FIELD_PATH_LENGTH} characters or fewer and no deeper than ${MAX_FIELD_PATH_DEPTH} segments.`;
    }
    if (!nextOpsError && parsed.ops && ops && ops.length > 0) {
      const unsupported = parsed.ops.find((op) => !ops.includes(op.type));
      if (unsupported) {
        nextOpsError = `Operation “${unsupported.type}” is not registered on this server.`;
      }
    }
    setPropertiesError(parsed.propertiesError);
    setOpsError(nextOpsError);
    if (!parsed.properties || !parsed.ops || nextOpsError) return;

    const requestId = ++previewRequestRef.current;
    const draftRevision = draftRevisionRef.current;
    setBusy(true);
    setPreviewErr(null);
    const request = runPreviewRequest({
      properties: parsed.properties,
      operations: parsed.ops,
      isCurrent: () =>
        mountedRef.current &&
        requestId === previewRequestRef.current &&
        draftRevision === draftRevisionRef.current,
      onOutcome: (nextOutcome) => {
        setOutcome(nextOutcome);
        setOutcomeStale(false);
      },
      onFailure: (message) => {
        setPreviewErr(message);
        setOutcome(null);
        setOutcomeStale(false);
      },
    });
    previewFlightRef.current = request;
    try {
      await request;
    } finally {
      if (previewFlightRef.current === request) previewFlightRef.current = null;
      if (
        mountedRef.current &&
        requestId === previewRequestRef.current &&
        draftRevision === draftRevisionRef.current
      ) {
        setBusy(false);
      }
    }
  };

  const appendOperation = (type: string): void => {
    const boundaryError = editorBoundaryError("ops", opsText);
    if (boundaryError) {
      setOpsError(boundaryError);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(opsText);
    } catch {
      // Replace invalid JSON with a safe one-operation draft.
      parsed = [];
    }
    const next: unknown[] = Array.isArray(parsed) ? [...parsed] : [];
    if (next.length >= MAX_OPERATIONS) {
      setOpsError(
        `Use ${MAX_OPERATIONS.toLocaleString()} operations or fewer in one interactive preview.`,
      );
      return;
    }
    next.push({ type, field: "" });
    let serialized: string;
    try {
      serialized = JSON.stringify(next, null, 2);
    } catch {
      setOpsError(
        "Operations JSON could not be safely updated. Keep the current draft and try a smaller document.",
      );
      return;
    }
    const outputBoundaryError = editorBoundaryError("ops", serialized);
    if (outputBoundaryError) {
      setOpsError(outputBoundaryError);
      return;
    }
    setOpsText(serialized);
    setOpsError(null);
    markEdited();
    window.requestAnimationFrame(() => {
      opsEditorRef.current?.focus();
      const length = opsEditorRef.current?.value.length ?? 0;
      opsEditorRef.current?.setSelectionRange(length, length);
    });
  };

  const formatEditor = (target: EditorTarget): void => {
    const text = target === "properties" ? propertiesText : opsText;
    const boundaryError = editorBoundaryError(target, text);
    if (boundaryError) {
      if (target === "properties") setPropertiesError(boundaryError);
      else setOpsError(boundaryError);
      return;
    }
    try {
      const formatted = JSON.stringify(JSON.parse(text), null, 2);
      const outputBoundaryError = editorBoundaryError(target, formatted);
      if (outputBoundaryError) {
        if (target === "properties") setPropertiesError(outputBoundaryError);
        else setOpsError(outputBoundaryError);
        return;
      }
      if (target === "properties") {
        setPropertiesText(formatted);
        setPropertiesError(null);
      } else {
        setOpsText(formatted);
        setOpsError(null);
      }
      markEdited();
    } catch {
      const message =
        "Cannot format invalid JSON. Check quotes, commas, and brackets, then try again.";
      if (target === "properties") setPropertiesError(message);
      else setOpsError(message);
    }
  };

  const resetExample = (): void => {
    draftRevisionRef.current += 1;
    previewRequestRef.current += 1;
    previewFlightRef.current = null;
    setPropertiesText(SAMPLE_PROPERTIES);
    setOpsText(SAMPLE_OPS);
    setPropertiesError(null);
    setOpsError(null);
    setPreviewErr(null);
    setOutcome(null);
    setOutcomeStale(false);
    setBusy(false);
  };

  const changeProperties = (value: string): void => {
    setPropertiesText(value);
    setPropertiesError(null);
    markEdited();
  };
  const changeOperations = (value: string): void => {
    setOpsText(value);
    setOpsError(null);
    markEdited();
  };
  const refreshCatalog = (): void => {
    if (ops === null) return;
    setOps(null);
    void loadOps();
  };
  const retryCatalog = (): void => {
    setOps(null);
    void loadOps();
  };

  return {
    ops,
    opsErr,
    propertiesText,
    opsText,
    propertiesError,
    opsError,
    outcome,
    outcomeStale,
    previewErr,
    busy,
    opsEditorRef,
    refreshCatalog,
    retryCatalog,
    changeProperties,
    changeOperations,
    preview,
    appendOperation,
    formatEditor,
    resetExample,
  };
}

async function runPreviewRequest({
  properties,
  operations,
  isCurrent,
  onOutcome,
  onFailure,
}: {
  properties: Record<string, unknown>;
  operations: Parameters<typeof cdpTransformsApi.preview>[0]["ops"];
  isCurrent: () => boolean;
  onOutcome: (outcome: CDPTransformOutcome | null) => void;
  onFailure: (message: string) => void;
}): Promise<void> {
  try {
    const res = await cdpTransformsApi.preview({ properties, ops: operations });
    if (!isCurrent()) return;
    if (res.error) {
      onFailure(
        safeDataPlatformFailure(
          res.error,
          "The transform service could not complete this preview.",
        ),
      );
      return;
    }
    onOutcome(res.data ?? null);
  } catch (error) {
    if (!isCurrent()) return;
    onFailure(
      safeDataPlatformFailure(
        error,
        "The preview request couldn't reach the transform service. Retry when the server is available.",
      ),
    );
  }
}

export function CdpTransformsSection({
  canAdmin,
}: {
  canAdmin: boolean;
}): ReactElement {
  const controller = useCdpTransformsController(canAdmin);
  const previewDisclosureId = useId();
  const previewPermissionId = useId();

  return (
    <div className="dp-section dp-transforms">
      <OperationCatalog controller={controller} />
      <PreviewLaboratory
        controller={controller}
        canAdmin={canAdmin}
        disclosureId={previewDisclosureId}
        permissionId={previewPermissionId}
      />
    </div>
  );
}

function OperationCatalog({
  controller,
}: {
  controller: CdpTransformsController;
}): ReactElement {
  const { ops, opsErr } = controller;
  return (
    <>
      <SectionHeader
        title="Registered operation catalog"
        description="Select an operation to append a valid draft block, then provide its field and any documented arguments in the editor."
        actions={
          <button
            type="button"
            className="btn btn-sm"
            aria-disabled={ops === null || undefined}
            aria-busy={ops === null || undefined}
            onClick={controller.refreshCatalog}
          >
            {ops === null ? "Verifying…" : "Refresh catalog"}
          </button>
        }
      />
      {opsErr ? (
        <Notice
          className="dp-notice"
          tone="danger"
          announcement="assertive"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={controller.retryCatalog}
            >
              Retry catalog
            </button>
          }
        >
          {opsErr}
        </Notice>
      ) : ops === null ? (
        <div
          className="dp-chip-skeleton"
          role="status"
          aria-label="Loading registered operations"
          aria-busy="true"
        >
          {OPERATION_SKELETON_WIDTHS.map((width) => (
            <Skeleton key={width} width={width} height={29} />
          ))}
        </div>
      ) : ops.length === 0 ? (
        <div className="dp-quiet-empty">
          <Icon name="alert-triangle" size={21} />
          <div>
            <strong>No registered operations were reported</strong>
            <p>
              Preview remains available for server validation, but there is no
              verified operation catalog to build from.
            </p>
          </div>
        </div>
      ) : (
        <div className="dp-op-catalog" aria-label="Registered operations">
          <div className="dp-op-catalog-summary">
            <span className="dp-status-pill">
              {ops.length.toLocaleString()} registered
            </span>
            <span>Click an operation to append it to the JSON draft.</span>
          </div>
          <div className="dp-op-chips">
            {ops.map((op) => (
              <button
                key={op}
                type="button"
                className="chip mono dp-op-chip"
                aria-label={`Append a ${op} operation to the playground`}
                onClick={() => controller.appendOperation(op)}
              >
                <Icon name="plus" size={12} />
                {op}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function PreviewLaboratory({
  controller,
  canAdmin,
  disclosureId,
  permissionId,
}: {
  controller: CdpTransformsController;
  canAdmin: boolean;
  disclosureId: string;
  permissionId: string;
}): ReactElement {
  return (
    <>
      <div className="dp-transform-heading">
        <SectionHeader
          title="Preview laboratory"
          description="Apply the operation sequence to one sample profile and inspect the exact before/after evidence."
          actions={
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={controller.busy}
              onClick={controller.resetExample}
            >
              Reset example
            </button>
          }
        />
      </div>
      {!canAdmin ? <PreviewPermissionNote id={permissionId} /> : null}
      <PreviewDisclosure id={disclosureId} />
      <div
        className="dp-transform-workbench"
        aria-busy={controller.busy || undefined}
      >
        <PreviewInputs
          controller={controller}
          canAdmin={canAdmin}
          disclosureId={disclosureId}
          permissionId={permissionId}
        />
        <PreviewOutcome controller={controller} />
      </div>
    </>
  );
}

function PreviewPermissionNote({ id }: { id: string }): ReactElement {
  return (
    <div id={id} className="dp-permission-note" role="note">
      <Icon name="lock" size={17} />
      <div>
        <strong>Preview execution requires administrator access</strong>
        <span>
          You can inspect registered operations and compose local JSON in a
          view-only session. The server preview request remains unavailable.
        </span>
      </div>
    </div>
  );
}

function PreviewDisclosure({ id }: { id: string }): ReactElement {
  return (
    <div className="dp-sensitive-disclosure" id={id}>
      <Icon name="lock" size={17} />
      <div>
        <strong>Treat preview input as transmitted data</strong>
        <span>
          The JSON is sent to your current Moosewave server for processing. Avoid
          credentials, secrets, or unnecessary personal data; your
          environment&apos;s normal request logging and retention may apply.
        </span>
      </div>
      <span className="dp-status-pill">Nothing saved by this tool</span>
    </div>
  );
}

function PreviewInputs({
  controller,
  canAdmin,
  disclosureId,
  permissionId,
}: {
  controller: CdpTransformsController;
  canAdmin: boolean;
  disclosureId: string;
  permissionId: string;
}): ReactElement {
  return (
    <div className="card dp-transform-inputs">
      <div className="dp-panel-heading">
        <span>01</span>
        <div>
          <strong>Compose the preview</strong>
          <small>JSON is validated locally before transport.</small>
        </div>
      </div>
      <EditorField
        label="Input properties (JSON)"
        value={controller.propertiesText}
        error={controller.propertiesError}
        rows={11}
        onChange={controller.changeProperties}
        onFormat={() => controller.formatEditor("properties")}
      />
      <EditorField
        label="Operations (JSON array)"
        value={controller.opsText}
        error={controller.opsError}
        rows={11}
        textareaRef={controller.opsEditorRef}
        help='Each operation needs {"type", "field", "args"?}. Fields support dotted paths such as "address.country".'
        onChange={controller.changeOperations}
        onFormat={() => controller.formatEditor("ops")}
      />
      <div className="dp-preview-actions">
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={!canAdmin || controller.busy || undefined}
          aria-describedby={
            canAdmin ? disclosureId : `${permissionId} ${disclosureId}`
          }
          onClick={() => {
            if (canAdmin && !controller.busy) void controller.preview();
          }}
        >
          {controller.busy
            ? "Running preview…"
            : canAdmin
              ? "Run preview"
              : "Preview requires admin"}
        </button>
        <span>Server-side dry run · no pipeline changes</span>
      </div>
    </div>
  );
}

function PreviewOutcome({
  controller,
}: {
  controller: CdpTransformsController;
}): ReactElement {
  const rows = controller.outcome
    ? resultRows(controller.outcome.results ?? [])
    : [];
  return (
    <div className="card dp-transform-outcome">
      <div className="dp-panel-heading">
        <span>02</span>
        <div>
          <strong>Inspect the evidence</strong>
          <small>Every operation is accounted for separately.</small>
        </div>
        {controller.outcomeStale ? (
          <span className="dp-status-pill dp-status-pill-warning">
            Inputs changed
          </span>
        ) : null}
      </div>
      {controller.busy ? (
        <div className="dp-outcome-empty" role="status">
          <span className="dp-outcome-loader" aria-hidden="true" />
          <strong>Applying operations…</strong>
          <p>The latest request will be the only result shown.</p>
        </div>
      ) : controller.previewErr ? (
        <Notice
          className="dp-preview-error"
          tone="danger"
          announcement="assertive"
          title="Preview failed"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void controller.preview()}
            >
              Retry preview
            </button>
          }
        >
          {controller.previewErr}
        </Notice>
      ) : controller.outcome === null ? (
        <div className="dp-outcome-empty">
          <span className="dp-outcome-glyph" aria-hidden="true">
            <Icon name="git-branch" size={24} />
          </span>
          <strong>Ready for a dry run</strong>
          <p>
            Run the sample to see resulting properties and an operation-level
            audit trail here.
          </p>
        </div>
      ) : (
        <TransformOutcome
          outcome={controller.outcome}
          rows={rows}
          stale={controller.outcomeStale}
        />
      )}
    </div>
  );
}

function EditorField({
  label,
  value,
  error,
  rows,
  help,
  textareaRef,
  onChange,
  onFormat,
}: {
  label: string;
  value: string;
  error: string | null;
  rows: number;
  help?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onFormat: () => void;
}): ReactElement {
  return (
    <div className="dp-editor-field">
      <FormField
        label={label}
        error={error}
        help={help}
        labelAction={
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onFormat}
          >
            Format JSON
          </button>
        }
      >
        <textarea
          ref={textareaRef}
          className="mono dp-code-editor"
          rows={rows}
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </FormField>
    </div>
  );
}

function TransformOutcome({
  outcome,
  rows,
  stale,
}: {
  outcome: CDPTransformOutcome;
  rows: ReturnType<typeof resultRows>;
  stale: boolean;
}): ReactElement {
  return (
    <div
      className={stale ? "dp-outcome-content is-stale" : "dp-outcome-content"}
    >
      <div
        className="dp-outcome-summary"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <div>
          <span>Outcome</span>
          <strong>{outcomeSummary(outcome)}</strong>
        </div>
        <span
          className={`badge${outcome.failed === 0 ? " success" : " warning"}`}
        >
          {outcome.failed === 0 ? "Preview passed" : "Review failures"}
        </span>
      </div>
      {stale ? (
        <p className="dp-stale-warning" role="status">
          These results belong to the previous input. Run preview again before
          relying on them.
        </p>
      ) : null}
      <div className="label">Resulting properties</div>
      <pre className="mono dp-json-output">
        {JSON.stringify(outcome.properties, null, 2)}
      </pre>
      <div className="dp-result-table-heading">
        <span className="label">Operation results</span>
        <span>{rows.length.toLocaleString()} evaluated</span>
      </div>
      {rows.length === 0 ? (
        <p className="muted">The server returned no per-operation results.</p>
      ) : (
        <div
          className="dp-result-table-wrap"
          role="region"
          aria-label="Scrollable operation-result table"
          tabIndex={0}
        >
          <table className="data-table dp-result-table">
            <caption>Per-operation transform preview results</caption>
            <thead>
              <tr>
                <th scope="col">Operation</th>
                <th scope="col">Before</th>
                <th scope="col">After</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.label}-${index}`}>
                  <td className="mono">{row.label}</td>
                  <td className="mono muted">{row.oldValue}</td>
                  <td className="mono">{row.newValue}</td>
                  <td>
                    {row.error ? (
                      <span className="dp-op-error">
                        {classifiedDataPlatformIssue(
                          row.error,
                          "This operation could not be applied to the preview input.",
                        )}
                      </span>
                    ) : row.changed ? (
                      <span className="badge success">Changed</span>
                    ) : (
                      <span className="badge">No change</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
