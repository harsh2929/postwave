// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure structural edits on a form's field list (FORM-029): duplicate a field
// (deep clone + fresh id, inserted right after its source) and insert a new
// block at a chosen position (before Submit by default). Kept pure so the
// builder's mutation logic is unit-tested without React.

import type { FormField } from "./forms-types";

/** Deep-clone a field's config, giving it a new id. Options/mime arrays are
 *  copied so the clone and source never share references. */
export function cloneField(field: FormField, newId: string): FormField {
  return {
    ...field,
    id: newId,
    options: field.options ? field.options.map((o) => ({ ...o })) : field.options,
    acceptMime: field.acceptMime ? [...field.acceptMime] : field.acceptMime,
  };
}

/**
 * Return a new field list with a duplicate of `sourceId` inserted immediately
 * after it. `makeId` supplies the clone's id (injectable for deterministic
 * tests). No-op (returns the same array contents) when the source is missing.
 */
export function duplicateFieldAt(
  fields: readonly FormField[],
  sourceId: string,
  makeId: () => string,
): FormField[] {
  const idx = fields.findIndex((f) => f.id === sourceId);
  if (idx < 0) return [...fields];
  const clone = cloneField(fields[idx], makeId());
  const next = [...fields];
  next.splice(idx + 1, 0, clone);
  return next;
}

/**
 * Insert `field` at `index` (clamped to the list bounds). When `index` is
 * omitted the field is placed just before the first Submit block (or appended
 * when there is none) — matching the builder's append behavior.
 */
export function insertFieldAt(
  fields: readonly FormField[],
  field: FormField,
  index?: number,
): FormField[] {
  const next = [...fields];
  let at: number;
  if (index === undefined) {
    const submitIdx = next.findIndex((f) => f.kind === "submit");
    at = submitIdx >= 0 ? submitIdx : next.length;
  } else {
    at = Math.min(Math.max(0, index), next.length);
  }
  next.splice(at, 0, field);
  return next;
}
