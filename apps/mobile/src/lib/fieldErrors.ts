/**
 * fieldErrors — keyed validation messages for the auth forms.
 *
 * Every auth screen held ONE `error: string` rendered once, near the bottom of
 * a scrolled form. "Email and password are required" told the user that
 * something was wrong and nothing about where, with the keyboard covering half
 * the screen; desktop has keyed errors and moves focus to the first invalid
 * control (`useFormErrors` + `focusInvalidRef`).
 *
 * The `_form` key is reserved for messages that belong to the submit as a
 * whole — a 401, a rate limit, an offline guard — so a screen can render one
 * alert region and still caption individual fields.
 *
 * Pure and import-free so the ordering rule (which field gets focus) is
 * testable in the node environment.
 */

/** Messages that are not about any single field. */
export const FORM_ERROR_KEY = "_form" as const;

export type FieldErrorMap = Readonly<Record<string, string>>;

export const NO_FIELD_ERRORS: FieldErrorMap = Object.freeze({});

/** Drop empty strings so `has()` never reports a blank caption. */
export function setFieldErrors(
  current: FieldErrorMap,
  next: Record<string, string | undefined>,
): FieldErrorMap {
  const merged: Record<string, string> = { ...current };
  for (const [key, value] of Object.entries(next)) {
    const message = (value ?? "").trim();
    if (message) merged[key] = message;
    else delete merged[key];
  }
  return merged;
}

export function clearFieldError(
  current: FieldErrorMap,
  key: string,
): FieldErrorMap {
  if (!(key in current)) return current;
  const next = { ...current };
  delete next[key];
  return next;
}

export function hasFieldErrors(errors: FieldErrorMap): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * The first field, IN VISUAL ORDER, that carries an error — the one to focus
 * and the one whose message the screen reader should hear first. Order comes
 * from the caller because only the screen knows its own layout; `_form` is
 * never a focus target because it has no control.
 */
export function firstInvalidField(
  errors: FieldErrorMap,
  order: readonly string[],
): string | null {
  for (const key of order) {
    if (key !== FORM_ERROR_KEY && errors[key]) return key;
  }
  return null;
}

/**
 * The single message to speak after a failed submit: the first field message
 * in visual order, else the form-level one. Announcing every message at once
 * produces an unparseable run-on for a screen-reader user.
 */
export function announcementFor(
  errors: FieldErrorMap,
  order: readonly string[],
): string {
  const field = firstInvalidField(errors, order);
  if (field) return errors[field] ?? "";
  return errors[FORM_ERROR_KEY] ?? "";
}
