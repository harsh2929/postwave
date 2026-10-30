import { type ReactElement, useId, useMemo, useState } from "react";

import {
  type OutboundWebhook,
  type OutboundWebhookTransformTemplate,
} from "../../lib/api-client";

export interface DeliveryPolicyProjection {
  id: string;
  field: string;
  pointer: string;
}

export interface DeliveryPolicyDraft {
  filterExpression: string;
  projections: DeliveryPolicyProjection[];
}

interface Props {
  value: DeliveryPolicyDraft;
  onChange: (value: DeliveryPolicyDraft) => void;
  disabled?: boolean;
  invalid?: boolean;
}

const SAMPLE_EVENT = `{
  "subscriber": {
    "email": "ada@example.com",
    "status": "active",
    "tags": ["vip", "launch"]
  },
  "campaign": {
    "recipients_count": 1250
  }
}`;

let projectionSequence = 0;

function nextProjectionId(): string {
  projectionSequence += 1;
  return `projection-${projectionSequence}`;
}

export function emptyDeliveryPolicyDraft(): DeliveryPolicyDraft {
  return { filterExpression: "", projections: [] };
}

export function deliveryPolicyDraftFromWebhook(
  webhook: OutboundWebhook | null,
): DeliveryPolicyDraft {
  return {
    filterExpression: webhook?.filter_expression ?? "",
    projections: Object.entries(webhook?.transform_template ?? {}).map(
      ([field, pointer]) => ({
        id: nextProjectionId(),
        field,
        pointer,
      }),
    ),
  };
}

export function deliveryPolicyTransform(
  draft: DeliveryPolicyDraft,
): OutboundWebhookTransformTemplate | null {
  const rows = draft.projections.filter(
    (projection) => projection.field.trim() || projection.pointer.trim(),
  );
  if (rows.length === 0) return null;
  return Object.fromEntries(
    rows.map((projection) => [
      projection.field.trim(),
      projection.pointer.trim(),
    ]),
  );
}

export function deliveryPolicyEquals(
  left: DeliveryPolicyDraft,
  right: DeliveryPolicyDraft,
): boolean {
  return (
    left.filterExpression.trim() === right.filterExpression.trim() &&
    JSON.stringify(deliveryPolicyTransform(left)) ===
      JSON.stringify(deliveryPolicyTransform(right))
  );
}

export function validateDeliveryPolicyDraft(
  draft: DeliveryPolicyDraft,
): string | null {
  const expressionError = filterError(draft.filterExpression);
  if (expressionError) return expressionError;
  const firstProjectionError = projectionErrors(draft.projections)
    .values()
    .next().value;
  return typeof firstProjectionError === "string" ? firstProjectionError : null;
}

function filterError(expression: string): string | null {
  const value = expression.trim();
  if (!value) return null;
  if (new TextEncoder().encode(value).length > 4096) {
    return "Filter must be 4 KiB or smaller.";
  }
  const clauses = value.split(/\s+(?:&&|\|\|)\s+/);
  if (clauses.length > 32) return "Use no more than 32 conditions.";
  const condition =
    /^[A-Za-z0-9_.-]+\s+(?:==|!=|>=|<=|>|<|contains|startswith|endswith|includes)\s+.+$/;
  if (clauses.some((clause) => !condition.test(clause.trim()))) {
    return "Use: field operator value. Join conditions with && or ||; parentheses are not supported.";
  }
  return null;
}

function projectionErrors(
  projections: DeliveryPolicyProjection[],
): Map<string, string> {
  const errors = new Map<string, string>();
  const names = new Set<string>();
  for (const row of projections) {
    const field = row.field.trim();
    const pointer = row.pointer.trim();
    if (!field && !pointer) continue;
    if (!field) {
      errors.set(row.id, "Enter an output field.");
      continue;
    }
    if (names.has(field)) {
      errors.set(row.id, "Output fields must be unique.");
      continue;
    }
    names.add(field);
    if (pointer !== "" && !pointer.startsWith("/")) {
      errors.set(row.id, "JSON Pointer must be empty (root) or start with /.");
      continue;
    }
    if (/(?:~(?![01]))/.test(pointer)) {
      errors.set(row.id, "Escape ~ as ~0 and / inside a token as ~1.");
    }
  }
  return errors;
}

function resolvePointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  let current = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const token = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      current === null ||
      typeof current !== "object" ||
      !(token in current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

export function DeliveryPolicyFields({
  value,
  onChange,
  disabled = false,
  invalid = false,
}: Props): ReactElement {
  const [sample, setSample] = useState(SAMPLE_EVENT);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const filterHelpId = useId();
  const currentFilterError = filterError(value.filterExpression);
  const currentProjectionErrors = useMemo(
    () => projectionErrors(value.projections),
    [value.projections],
  );
  const configured =
    Boolean(value.filterExpression.trim()) ||
    value.projections.some((row) => row.field.trim() || row.pointer.trim());

  const updateProjection = (
    id: string,
    patch: Partial<DeliveryPolicyProjection>,
  ): void => {
    onChange({
      ...value,
      projections: value.projections.map((row) =>
        row.id === id ? { ...row, ...patch } : row,
      ),
    });
    setPreview(null);
  };

  const runPreview = (): void => {
    setPreview(null);
    setPreviewError(null);
    if (currentFilterError || currentProjectionErrors.size > 0) {
      setPreviewError("Fix the policy validation errors before previewing.");
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(sample);
    } catch {
      setPreviewError("Sample payload must be valid JSON.");
      return;
    }
    const transform = deliveryPolicyTransform(value);
    if (!transform) {
      setPreview(JSON.stringify(payload, null, 2));
      return;
    }
    const projected: Record<string, unknown> = {};
    for (const [field, pointer] of Object.entries(transform)) {
      const resolved = resolvePointer(payload, pointer);
      if (resolved !== undefined) projected[field] = resolved;
    }
    setPreview(JSON.stringify(projected, null, 2));
  };

  return (
    <details className="wh-policy-editor" open={configured || invalid}>
      <summary>
        <span>
          <strong>Delivery policy</strong>
          <small>
            {invalid
              ? "Needs repair before activation"
              : configured
                ? "Filter or projection configured"
                : "Optional advanced controls"}
          </small>
        </span>
        <span
          className={`badge ${invalid ? "danger" : configured ? "success" : ""}`}
        >
          {invalid ? "Invalid" : configured ? "Configured" : "Off"}
        </span>
      </summary>
      <div className="wh-policy-editor-body">
        <div className="field">
          <label className="field-label" htmlFor={filterHelpId}>
            Deliver only when
          </label>
          <input
            id={filterHelpId}
            className="input mono"
            value={value.filterExpression}
            disabled={disabled}
            spellCheck={false}
            placeholder="subscriber.status == active && subscriber.tags includes vip"
            aria-invalid={currentFilterError ? "true" : undefined}
            onChange={(event) => {
              onChange({ ...value, filterExpression: event.target.value });
              setPreview(null);
            }}
          />
          {currentFilterError ? (
            <p className="field-error" role="alert">
              {currentFilterError}
            </p>
          ) : (
            <p className="field-help">
              Operators:{" "}
              <code>
                == != &gt; &lt; &gt;= &lt;= contains startswith endswith
                includes
              </code>
              . Combine left-to-right with <code>&amp;&amp;</code> or{" "}
              <code>||</code>. Empty matches every selected event.
            </p>
          )}
        </div>

        <fieldset className="wh-projection-builder" disabled={disabled}>
          <legend>Shape the signed payload</legend>
          <p className="field-help">
            Map friendly output fields to RFC 6901 JSON Pointers. Unresolved
            pointers are omitted. With no rows, Moosewave sends the original
            payload.
          </p>
          <div className="wh-projection-head" aria-hidden="true">
            <span>Output field</span>
            <span>JSON Pointer</span>
            <span />
          </div>
          {value.projections.map((row, index) => {
            const error = currentProjectionErrors.get(row.id);
            return (
              <div className="wh-projection-row" key={row.id}>
                <label className="sr-only" htmlFor={`${row.id}-field`}>
                  Projection {index + 1} output field
                </label>
                <input
                  id={`${row.id}-field`}
                  className="input mono"
                  placeholder="email"
                  value={row.field}
                  aria-invalid={error ? "true" : undefined}
                  onChange={(event) =>
                    updateProjection(row.id, { field: event.target.value })
                  }
                />
                <label className="sr-only" htmlFor={`${row.id}-pointer`}>
                  Projection {index + 1} JSON Pointer
                </label>
                <input
                  id={`${row.id}-pointer`}
                  className="input mono"
                  placeholder="/subscriber/email"
                  value={row.pointer}
                  aria-invalid={error ? "true" : undefined}
                  onChange={(event) =>
                    updateProjection(row.id, { pointer: event.target.value })
                  }
                />
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  aria-label={`Remove projection ${index + 1}`}
                  onClick={() => {
                    onChange({
                      ...value,
                      projections: value.projections.filter(
                        (candidate) => candidate.id !== row.id,
                      ),
                    });
                    setPreview(null);
                  }}
                >
                  Remove
                </button>
                {error ? (
                  <p className="field-error" role="alert">
                    {error}
                  </p>
                ) : null}
              </div>
            );
          })}
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled || value.projections.length >= 64}
            onClick={() =>
              onChange({
                ...value,
                projections: [
                  ...value.projections,
                  { id: nextProjectionId(), field: "", pointer: "" },
                ],
              })
            }
          >
            Add output field
          </button>
        </fieldset>

        <div className="wh-policy-preview-grid">
          <div className="field">
            <label className="field-label" htmlFor={`${filterHelpId}-sample`}>
              Sample event
            </label>
            <textarea
              id={`${filterHelpId}-sample`}
              className="textarea mono"
              rows={8}
              value={sample}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => {
                setSample(event.target.value);
                setPreview(null);
                setPreviewError(null);
              }}
            />
          </div>
          <div className="field">
            <div className="field-label">Projection preview</div>
            <pre className="wh-policy-preview" aria-live="polite">
              {preview ??
                "Preview shows payload shaping locally. The server validates the filter and transform again when you save."}
            </pre>
          </div>
        </div>
        {previewError ? (
          <p className="field-error" role="alert">
            {previewError}
          </p>
        ) : null}
        <div className="wh-policy-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled}
            onClick={runPreview}
          >
            Preview projection
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={disabled || (!configured && sample === SAMPLE_EVENT)}
            onClick={() => {
              onChange(emptyDeliveryPolicyDraft());
              setSample(SAMPLE_EVENT);
              setPreview(null);
              setPreviewError(null);
            }}
          >
            Reset policy
          </button>
        </div>
      </div>
    </details>
  );
}
