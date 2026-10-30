// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Delivery policy: the optional filter that decides whether an event is sent
 * at all, and the optional transform that decides what shape the receiver is
 * handed. Both are server-evaluated; the preview below is computed LOCALLY
 * against a fixed sample event, so it shows the projection the operator wrote,
 * never a claim about what the server did.
 *
 * Mirrors apps/desktop/src/components/webhooks/DeliveryPolicyFields.
 */

import { useId, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type {
  OutboundWebhookRecord,
  OutboundWebhookTransformTemplate,
} from "@/lib/outbound-webhooks-api";

export interface DeliveryPolicyProjection {
  id: string;
  field: string;
  pointer: string;
}

export interface DeliveryPolicyDraft {
  filterExpression: string;
  projections: DeliveryPolicyProjection[];
}

const SAMPLE_EVENT = {
  subscriber: {
    email: "ada@example.com",
    status: "active",
    tags: ["vip", "launch"],
  },
  campaign: { recipients_count: 1250 },
};

let projectionSequence = 0;

function nextProjectionId(): string {
  projectionSequence += 1;
  return `projection-${projectionSequence}`;
}

export function emptyDeliveryPolicyDraft(): DeliveryPolicyDraft {
  return { filterExpression: "", projections: [] };
}

export function deliveryPolicyDraftFromWebhook(
  webhook: OutboundWebhookRecord | null,
): DeliveryPolicyDraft {
  return {
    filterExpression: webhook?.filter_expression ?? "",
    projections: Object.entries(webhook?.transform_template ?? {}).map(
      ([field, pointer]) => ({ id: nextProjectionId(), field, pointer }),
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

export function projectionErrors(
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

export function validateDeliveryPolicyDraft(
  draft: DeliveryPolicyDraft,
): string | null {
  const expressionError = filterError(draft.filterExpression);
  if (expressionError) return expressionError;
  const first = projectionErrors(draft.projections).values().next().value;
  return typeof first === "string" ? first : null;
}

function resolvePointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  let current = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const token = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object" || !(token in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

export function DeliveryPolicyFields({
  value,
  onChange,
  disabled,
}: {
  value: DeliveryPolicyDraft;
  onChange: (value: DeliveryPolicyDraft) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const errors = useMemo(
    () => projectionErrors(value.projections),
    [value.projections],
  );
  const expressionError = filterError(value.filterExpression);
  const preview = useMemo(() => {
    const template = deliveryPolicyTransform(value);
    if (!template) return null;
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(template).map(([field, pointer]) => [
          field,
          resolvePointer(SAMPLE_EVENT, pointer) ?? null,
        ]),
      ),
      null,
      2,
    );
  }, [value]);

  return (
    <fieldset className="space-y-3 rounded-lg border p-4" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">Delivery policy</legend>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-filter`}>Filter expression (optional)</Label>
        <Textarea
          id={`${id}-filter`}
          rows={2}
          spellCheck={false}
          placeholder="subscriber.status == active"
          value={value.filterExpression}
          aria-invalid={expressionError ? true : undefined}
          onChange={(event) =>
            onChange({ ...value, filterExpression: event.target.value })
          }
        />
        <p className="text-xs text-muted-foreground">
          An event that does not match is not delivered and no receiver request
          is made. Leave empty to deliver every subscribed event.
        </p>
        {expressionError ? (
          <p className="text-sm text-destructive-emphasis" role="alert">
            {expressionError}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <span className="text-sm font-medium">Transform (optional)</span>
        <p className="text-xs text-muted-foreground">
          Each row maps an output field to an RFC 6901 JSON Pointer into the
          event payload. With no rows the receiver gets the full envelope.
        </p>
        {value.projections.map((projection, index) => (
          <div key={projection.id} className="space-y-1">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1 space-y-1.5">
                <Label htmlFor={`${id}-field-${projection.id}`}>
                  Output field {index + 1}
                </Label>
                <Input
                  id={`${id}-field-${projection.id}`}
                  value={projection.field}
                  autoComplete="off"
                  onChange={(event) =>
                    onChange({
                      ...value,
                      projections: value.projections.map((row) =>
                        row.id === projection.id
                          ? { ...row, field: event.target.value }
                          : row,
                      ),
                    })
                  }
                />
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                <Label htmlFor={`${id}-pointer-${projection.id}`}>
                  JSON Pointer {index + 1}
                </Label>
                <Input
                  id={`${id}-pointer-${projection.id}`}
                  value={projection.pointer}
                  autoComplete="off"
                  placeholder="/subscriber/email"
                  onChange={(event) =>
                    onChange({
                      ...value,
                      projections: value.projections.map((row) =>
                        row.id === projection.id
                          ? { ...row, pointer: event.target.value }
                          : row,
                      ),
                    })
                  }
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove projection ${index + 1}`}
                onClick={() =>
                  onChange({
                    ...value,
                    projections: value.projections.filter(
                      (row) => row.id !== projection.id,
                    ),
                  })
                }
              >
                Remove
              </Button>
            </div>
            {errors.get(projection.id) ? (
              <p className="text-sm text-destructive-emphasis" role="alert">
                {errors.get(projection.id)}
              </p>
            ) : null}
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
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
          Add projection
        </Button>
      </div>

      {preview ? (
        <div className="space-y-1">
          <span className="text-sm font-medium">
            Local preview against a sample event
          </span>
          <pre
            tabIndex={0}
            role="region"
            aria-label="Local projection preview"
            className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs"
          >
            <code>{preview}</code>
          </pre>
          <p className="text-xs text-muted-foreground">
            Computed in this browser from a fixed sample. It is not a reply from
            the server and does not prove the receiver accepted anything.
          </p>
        </div>
      ) : null}
    </fieldset>
  );
}
