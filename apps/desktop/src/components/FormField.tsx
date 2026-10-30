/**
 * FormField + FieldError + useFormErrors — unified form-field chrome.
 *
 * Wraps label + optional inline help + optional inline hint + input +
 * optional error message. Keeps the existing `<input>` / `<select>` /
 * `<textarea>` markup intact — we wrap, we don't rewrite.
 *
 *   <FormField label="From email" required help="Must be a verified domain"
 *              error={errors.fromEmail}>
 *     <input value={fromEmail} onChange={...} />
 *   </FormField>
 *
 * For freestanding error messages (e.g. above a multi-step section):
 *   <FieldError>Couldn't reach the server.</FieldError>
 *
 * For controlled forms, the included `useFormErrors()` hook tracks a
 * Record<string, string> with .set / .clear / .get helpers.
 */

import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useId,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { InlineHelp } from "./InlineHelp";

interface FormFieldProps {
  label: ReactNode;
  /** Renders as `*` next to the label. */
  required?: boolean;
  /** Lightweight inline hint shown under the label until invalid. */
  help?: string;
  /** Long-form `i`-tooltip beside the label. */
  helpTooltip?: string;
  /** Optional action aligned with the label, such as account recovery. */
  labelAction?: ReactNode;
  /** Decorative or contextual content placed before the native control. */
  startAdornment?: ReactNode;
  /** Interactive or decorative content placed after the native control. */
  endAdornment?: ReactNode;
  /** Error message — when truthy, the field renders the invalid state. */
  error?: string | null | false;
  /** The actual input control. */
  children: ReactNode;
  /** Optional `id` to wire the label's `htmlFor`. */
  htmlFor?: string;
}

export function FormField({
  label,
  required,
  help,
  helpTooltip,
  labelAction,
  startAdornment,
  endAdornment,
  error,
  children,
  htmlFor,
}: FormFieldProps): ReactElement {
  const generatedId = useId();
  const helpId = `${generatedId}-help`;
  const errorId = `${generatedId}-error`;
  const invalid = Boolean(error);
  const childArray = Children.toArray(children);
  const onlyChild = childArray.length === 1 ? childArray[0] : null;
  const isNativeControl =
    isValidElement<Record<string, unknown>>(onlyChild) &&
    typeof onlyChild.type === "string" &&
    ["input", "select", "textarea"].includes(onlyChild.type);
  const nativeControl = isNativeControl ? onlyChild : null;
  const existingId =
    typeof nativeControl?.props.id === "string" ? nativeControl.props.id : null;
  const controlId =
    htmlFor ?? existingId ?? (nativeControl ? generatedId : undefined);
  const describedBy = [
    typeof nativeControl?.props["aria-describedby"] === "string"
      ? nativeControl.props["aria-describedby"]
      : null,
    help ? helpId : null,
    invalid ? errorId : null,
  ]
    .filter(Boolean)
    .join(" ");
  const callerInvalid = nativeControl?.props["aria-invalid"];
  const callerErrorMessage =
    typeof nativeControl?.props["aria-errormessage"] === "string"
      ? nativeControl.props["aria-errormessage"]
      : null;
  const errorMessage = [callerErrorMessage, invalid ? errorId : null]
    .filter(Boolean)
    .join(" ");
  const renderedChildren = nativeControl
    ? cloneElement(nativeControl, {
        id: controlId,
        required:
          Boolean(nativeControl.props.required) || required || undefined,
        "aria-invalid": invalid ? "true" : callerInvalid,
        "aria-describedby": describedBy || undefined,
        "aria-errormessage": errorMessage || undefined,
      })
    : children;
  const className = [
    "field-v2",
    required ? "is-required" : "",
    invalid ? "is-invalid" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const hasAdornment = Boolean(startAdornment || endAdornment);

  return (
    <div className={className}>
      <div className="field-v2-label-row">
        <label className="field-v2-label" htmlFor={controlId}>
          {label}
          {required ? <span className="sr-only"> (required)</span> : null}
        </label>
        {helpTooltip || labelAction ? (
          <div className="field-v2-label-actions">
            {helpTooltip ? <InlineHelp text={helpTooltip} /> : null}
            {labelAction}
          </div>
        ) : null}
      </div>
      {help ? (
        <div id={helpId} className="field-v2-help">
          {help}
        </div>
      ) : null}
      {hasAdornment ? (
        <div className="field-v2-control">
          {startAdornment ? (
            <span className="field-v2-adornment field-v2-adornment-start">
              {startAdornment}
            </span>
          ) : null}
          {renderedChildren}
          {endAdornment ? (
            <span className="field-v2-adornment field-v2-adornment-end">
              {endAdornment}
            </span>
          ) : null}
        </div>
      ) : (
        renderedChildren
      )}
      {invalid ? (
        <div id={errorId} className="field-v2-error" role="alert">
          <svg
            width="11"
            height="11"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="6" cy="6" r="5" />
            <path d="M6 3.5v3M6 8.5v.5" />
          </svg>
          {error}
        </div>
      ) : null}
    </div>
  );
}

export interface FormErrorSummaryItem {
  fieldId: string;
  label: string;
  message: string;
}

export function FormErrorSummary({
  errors,
  title = "Check the highlighted fields",
}: {
  errors: FormErrorSummaryItem[];
  title?: string;
}): ReactElement | null {
  const titleId = useId();
  if (errors.length === 0) return null;
  return (
    <section
      className="form-error-summary"
      role="alert"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <h3 id={titleId}>{title}</h3>
      <ul>
        {errors.map((error) => (
          <li key={error.fieldId}>
            <a
              href={`#${error.fieldId}`}
              onClick={(event) => {
                const control = document.getElementById(error.fieldId);
                if (!control) return;
                event.preventDefault();
                control.focus({ preventScroll: true });
                control.scrollIntoView({ block: "center" });
              }}
            >
              {error.label}: {error.message}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface FieldErrorProps {
  children: ReactNode;
}

export function FieldError({ children }: FieldErrorProps): ReactElement {
  return (
    <div
      className="field-v2-error"
      role="alert"
      style={{ display: "inline-flex" }}
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="6" cy="6" r="5" />
        <path d="M6 3.5v3M6 8.5v.5" />
      </svg>
      {children}
    </div>
  );
}

export interface FormErrors {
  errors: Record<string, string>;
  set: (key: string, message: string) => void;
  clear: (key?: string) => void;
  get: (key: string) => string | undefined;
  has: (key?: string) => boolean;
  setMany: (next: Record<string, string>) => void;
}

export function useFormErrors(initial?: Record<string, string>): FormErrors {
  const [errors, setErrors] = useState<Record<string, string>>(initial ?? {});

  const set = useCallback((key: string, message: string) => {
    setErrors((prev) => ({ ...prev, [key]: message }));
  }, []);

  const clear = useCallback((key?: string) => {
    setErrors((prev) => {
      if (!key) return {};
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const get = useCallback(
    (key: string): string | undefined => errors[key],
    [errors],
  );

  const has = useCallback(
    (key?: string): boolean => {
      if (key) return Boolean(errors[key]);
      return Object.keys(errors).length > 0;
    },
    [errors],
  );

  const setMany = useCallback((next: Record<string, string>) => {
    setErrors(next);
  }, []);

  return useMemo(
    () => ({ errors, set, clear, get, has, setMany }),
    [errors, set, clear, get, has, setMany],
  );
}
