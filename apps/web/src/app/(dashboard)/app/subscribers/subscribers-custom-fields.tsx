// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Renders inputs for the tenant's defined custom fields, typed per field.
// Shared by the create dialog (SUB-043) and the profile edit dialog (SUB-012)
// so both write the same shape.

import { useQuery } from "@tanstack/react-query";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { listCustomFields, type CustomField } from "@/lib/custom-fields-api";
import { base, qk, STALE } from "@/lib/query-keys";

export type CustomFieldValue = string | number | boolean | null;

/** Coerce the string form-state into the API's typed value for a field. */
export function coerceCustomFieldValue(
  field: CustomField,
  raw: string,
): CustomFieldValue {
  if (raw === "") return null;
  if (field.type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (field.type === "boolean") return raw === "true";
  return raw;
}

/**
 * Build the `custom_fields` object for a NEW subscriber, omitting untouched and
 * empty values.
 *
 * Create-only. On create an empty box means "don't set this field", so dropping
 * it is right. On update it means "clear this field" — see
 * mergeCustomFieldEdits, which exists because those two readings are opposite.
 */
export function buildCustomFields(
  fields: CustomField[],
  values: Record<string, string>,
): Record<string, CustomFieldValue> {
  const out: Record<string, CustomFieldValue> = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (raw === undefined || raw === "") continue;
    out[field.key] = coerceCustomFieldValue(field, raw);
  }
  return out;
}

/**
 * Apply edited values over a subscriber's existing `custom_fields` for an
 * UPDATE.
 *
 * The edit dialog used to spread buildCustomFields over the existing map. That
 * correctly avoided the documented PATCH-replace wipe (a non-nil custom_fields
 * replaces the whole map server-side, so sending only the defined fields would
 * destroy ad-hoc keys like the list's display `name`) — but because
 * buildCustomFields omits empties, an emptied box was simply absent from the
 * spread and the old value survived. Clearing a custom field was impossible;
 * the dialog reported success and the value came back.
 *
 * The three input states are distinct here and each is deliberate:
 *   undefined — never rendered a value and never touched ⇒ leave as-is
 *   ""        — the user emptied the box ⇒ remove the key
 *   anything  — coerce to the field's type and set it
 *
 * Only DEFINED fields are removable. Keys the editor never renders are carried
 * through untouched, which is what keeps this from reintroducing the wipe.
 */
export function mergeCustomFieldEdits(
  existing: Record<string, CustomFieldValue>,
  fields: CustomField[],
  values: Record<string, string>,
): Record<string, CustomFieldValue> {
  const out: Record<string, CustomFieldValue> = { ...existing };
  for (const field of fields) {
    const raw = values[field.key];
    if (raw === undefined) continue;
    if (raw === "") {
      delete out[field.key];
      continue;
    }
    out[field.key] = coerceCustomFieldValue(field, raw);
  }
  return out;
}

/**
 * The workspace's custom-field definitions, under the same tenant/role key the
 * profile's custom-field panel reads, so a field created or deleted in
 * Settings reaches the edit dialog through the one invalidation Settings
 * issues.
 */
export function useCustomFields() {
  const me = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = me.data?.tenant_id ?? "anon";
  const role = me.data ? effectiveAuthRole(me.data) : null;
  return useQuery({
    queryKey: base("custom-fields", tenantId, role),
    queryFn: ({ signal }) => listCustomFields(signal),
    // Never under the synthetic "anon" key.
    enabled: me.isSuccess,
    staleTime: STALE.list,
  });
}

export function CustomFieldsEditor({
  fields,
  values,
  onChange,
  idPrefix = "cf",
  disabled = false,
}: {
  fields: CustomField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  idPrefix?: string;
  disabled?: boolean;
}) {
  if (fields.length === 0) return null;
  return (
    <div className="grid gap-3">
      {fields.map((field) => {
        const inputId = `${idPrefix}-${field.key}`;
        const value = values[field.key] ?? "";
        if (field.type === "boolean") {
          return (
            <label
              key={field.key}
              htmlFor={inputId}
              className="flex items-center gap-2 text-sm"
            >
              <input
                id={inputId}
                type="checkbox"
                checked={value === "true"}
                disabled={disabled}
                onChange={(e) =>
                  onChange(field.key, e.target.checked ? "true" : "false")
                }
                className="h-4 w-4 rounded border-input accent-primary"
              />
              {field.label}
            </label>
          );
        }
        return (
          <div key={field.key} className="grid gap-1.5">
            <Label htmlFor={inputId}>{field.label}</Label>
            <Input
              id={inputId}
              type={
                field.type === "number"
                  ? "number"
                  : field.type === "date"
                    ? "date"
                    : "text"
              }
              value={value}
              disabled={disabled}
              onChange={(e) => onChange(field.key, e.target.value)}
            />
          </div>
        );
      })}
    </div>
  );
}

export function CustomFieldsEditorSkeleton() {
  return (
    <div className="grid gap-3">
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}
