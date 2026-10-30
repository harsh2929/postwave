// SPDX-License-Identifier: AGPL-3.0-only
//
// Forms domain types — mirrors apps/api/internal/forms/forms.go on the wire.
// Keep field names in lockSync with the Go JSON tags.

export type OptInMode = "single" | "double";
export type FormStatus = "draft" | "published" | "archived";
/**
 * `received` is a response that did not ask to subscribe: the form's consent
 * checkbox was left unticked, so nothing was confirmed or joined.
 */
export type SubmissionStatus = "pending" | "confirmed" | "unsubscribed" | "received";

/** Last outcome of a submission's double opt-in email. */
export type ConfirmationEmailState =
  | "queued"
  | "sent"
  | "send_failed"
  | "no_sender"
  | "quota_exceeded"
  | "recipient_suppressed";

/**
 * One field in a form. `kind` decides which input element gets rendered;
 * `key` is the column name we attach to the subscriber's custom_fields blob
 * for non-standard fields.
 */
export type FieldKind =
  | "heading"
  | "text"
  | "email"
  | "name"
  | "checkbox"
  | "custom"
  | "submit"
  | "honeypot"
  // Survey-mode kinds. The compiled HTML compiler renders these as
  // text inputs (since the embed.js path can't run JS); the React
  // SurveyForm renders them as proper widgets and respects step_break.
  | "radio"
  | "select"
  | "long_text"
  | "scale"
  | "step_break"
  // file_upload: lead-gen / survey attachment field (resume, brief, asset).
  // The compiled-HTML fallback renders a plain <input type="file">; the
  // SurveyForm wizard does a presigned PUT and stores the upload id as
  // the field value.
  | "file_upload";

export interface FormField {
  id: string;
  kind: FieldKind;
  label: string;
  placeholder?: string;
  required: boolean;
  /** Custom-field key used when kind === "custom". */
  customKey?: string;
  /** Default value (e.g. for hidden honeypot — empty string). */
  defaultValue?: string;
  /** Heading level / text content for non-input kinds. */
  content?: string;
  /** Choices for `radio` and `select`. value can default to label. */
  options?: Array<{ label: string; value?: string }>;
  /** For `scale`: min/max integers (e.g. 1–5 NPS). */
  scaleMin?: number;
  scaleMax?: number;
  /**
   * For `file_upload`: allowlist of accepted MIME types. When omitted,
   * the gateway's server-side allowlist (image/jpeg, image/png,
   * image/webp, application/pdf, text/plain) is the source of truth.
   */
  acceptMime?: string[];
  /**
   * For `file_upload`: per-field max size in bytes. The gateway also
   * enforces a 25 MiB hard cap regardless of this value.
   */
  maxBytes?: number;
}

/** Split a flat field array into step groups by `step_break` markers. */
export function chunkFieldsByStep(fields: FormField[]): FormField[][] {
  const steps: FormField[][] = [[]];
  for (const f of fields) {
    if (f.kind === "step_break") {
      steps.push([]);
    } else {
      steps[steps.length - 1].push(f);
    }
  }
  return steps.filter((s) => s.length > 0);
}

/**
 * True when the hosted public page needs the React survey renderer.
 *
 * File uploads also route through SurveyForm even when there is only one
 * visible step: the compiled HTML fallback cannot complete the presigned PUT
 * flow, and the public submit endpoint intentionally does not parse multipart
 * file bodies.
 */
export function isSurvey(structure: FormStructure): boolean {
  return structure.fields.some(
    (f) => f.kind === "step_break" || f.kind === "file_upload",
  );
}

export interface FormStructure {
  fields: FormField[];
}

export interface FormSettings {
  /** What to show on success when no redirect URL is set. */
  successMessage: string;
  /** Optional redirect target on submit success. */
  successRedirectUrl?: string;
  /** Subject line of the confirmation email (double opt-in only). */
  confirmationSubject?: string;
  /** Body of the confirmation email; supports `{{confirm_url}}`. */
  confirmationBody?: string;
  /**
   * Sender of the confirmation email. Used, with the subject and body above,
   * only when its domain is one the workspace verified; otherwise a standard
   * confirmation that names the workspace and form is sent.
   */
  confirmationFromEmail?: string;
  /** Display name for `confirmationFromEmail`; defaults to the workspace name. */
  confirmationFromName?: string;
  /** Listmonk list ID to subscribe new sign-ups into. */
  targetListId?: string;
  /** Tags to apply on confirmation. */
  tagsOnSubmit?: string[];
  /** CSS class hooks applied to the rendered <form>. */
  styleClass?: string;
  /** FORM-034: require a reCAPTCHA v2 checkbox on this form. The verifying
   * secret stays deployment-level; this only toggles enforcement. */
  captchaRequired?: boolean;
  /** Optional public site key override; blank = deployment default. */
  recaptchaSiteKey?: string;
}

export interface Form {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  optInMode: OptInMode;
  structure: FormStructure;
  settings: FormSettings;
  status: FormStatus;
  createdAt: string;
  updatedAt: string;
  /** Public-render metadata returned only by GET /api/public/forms/:slug. */
  captchaRequired?: boolean;
  recaptchaSiteKey?: string;
}

/**
 * Allowlisted representation returned by the unauthenticated hosted-form API.
 * Tenant identity, internal delivery settings, and operator timestamps never
 * cross the public boundary.
 */
export type FormRenderModel = Pick<Form, "slug" | "structure"> & {
  settings: Pick<FormSettings, "successMessage" | "styleClass">;
  captchaRequired?: boolean;
  recaptchaSiteKey?: string;
};

export type PublicForm = FormRenderModel & Pick<Form, "optInMode" | "status">;

export interface FormListItem extends Form {
  /** Submission counts in the last 30 days. */
  submissions30d: number;
  /** Hosted-form visits in the last 30 days. */
  visits30d: number;
  /** Visit-to-submission conversion percentage for the last 30 days. */
  conversionRate: number;
}

export interface FormSubmission {
  id: string;
  formId: string;
  email: string;
  customFields: Record<string, string>;
  status: SubmissionStatus;
  ip: string | null;
  userAgent: string | null;
  submittedAt: string;
  confirmedAt: string | null;
  /** Absent when the submission has no confirmation email. */
  confirmationEmail?: ConfirmationEmailState;
}

export interface CreateFormInput {
  name: string;
  slug: string;
  optInMode: OptInMode;
  successMessage: string;
  successRedirectUrl?: string;
}

/** One UTC day-bucket of hosted-form visits — mirrors forms.VisitPoint. */
export interface FormVisitPoint {
  date: string; // YYYY-MM-DD
  count: number;
}

/** Response of GET /api/v1/forms/{id}/analytics — mirrors handlers.go Analytics. */
export interface FormAnalytics {
  formId: string;
  days: number;
  visits: FormVisitPoint[];
  visitsTotal: number;
}

/** Exact form_variants.status wire values. */
export type FormVariantStatus = "exploring" | "paused" | "promoted";

/** Mirrors form_variants.Variant on the wire. */
export interface FormVariant {
  id: string;
  tenantId: string;
  formId: string;
  label: string;
  displayConfig: Record<string, unknown>;
  trafficPct: number;
  status: FormVariantStatus;
  promotedAt?: string;
  lastZScore: number;
  impressions: number;
  submissions: number;
  conversionRate: number; // 0..1
  createdAt: string;
  updatedAt: string;
}

export interface CreateFormVariantInput {
  label: string;
  displayConfig?: Record<string, unknown>;
  trafficPct?: number;
}

export interface UpdateFormVariantInput {
  label?: string;
  displayConfig?: Record<string, unknown>;
  trafficPct?: number;
  status?: FormVariantStatus;
}

/** Mirrors form_variants.Promotion — one decided A/B run. */
export interface FormVariantPromotion {
  id: string;
  formId: string;
  winnerVariantId: string;
  winnerRate: number;
  runnerUpRate: number;
  zScore: number;
  winnerImpressions: number;
  runnerUpImpressions: number;
  decidedAt: string;
}

/** A subscriber list, for the target-list picker. Mirrors lists.List. */
export interface ListRef {
  id: number;
  name: string;
  subscriberCount?: number;
}

export interface UpdateFormInput {
  name?: string;
  slug?: string;
  optInMode?: OptInMode;
  structure?: FormStructure;
  settings?: FormSettings;
  status?: FormStatus;
}

export const DEFAULT_STRUCTURE: FormStructure = {
  fields: [
    {
      id: "h1",
      kind: "heading",
      label: "Heading",
      required: false,
      content: "Subscribe to our newsletter",
    },
    {
      id: "f_email",
      kind: "email",
      label: "Email address",
      placeholder: "you@example.com",
      required: true,
    },
    {
      id: "f_name",
      kind: "name",
      label: "First name",
      placeholder: "Jane",
      required: false,
    },
    {
      id: "f_consent",
      kind: "checkbox",
      label: "I agree to receive emails. You can unsubscribe at any time.",
      required: true,
    },
    {
      id: "f_hp",
      kind: "honeypot",
      label: "Leave this empty",
      required: false,
      defaultValue: "",
    },
    {
      id: "f_submit",
      kind: "submit",
      label: "Subscribe",
      required: false,
    },
  ],
};

export const DEFAULT_SETTINGS: FormSettings = {
  successMessage: "Thanks! Check your inbox to confirm your subscription.",
  confirmationSubject: "Confirm your subscription",
  confirmationBody:
    "Hi! Click the link below to confirm your subscription:\n\n{{confirm_url}}\n\nIf you didn't sign up, ignore this email.",
  tagsOnSubmit: [],
};

const MAX_COMPILED_FORM_FIELDS = 100;
const MAX_COMPILED_FIELD_TEXT_CHARS = 512;
const MAX_COMPILED_CONTENT_CHARS = 4_096;
const MAX_COMPILED_OPTIONS = 100;
const MAX_CUSTOM_FIELD_KEY_CHARS = 80;
const MAX_ACCEPT_MIME_TOKENS = 20;

export { slugify } from "./slugify";

export function validateFormSlug(slug: string): string | null {
  const value = slug.trim();
  if (!value) return "Slug is required.";
  if (value.length > 128) return "Slug must be 128 characters or fewer.";
  if (!/^[A-Za-z0-9._~-]+$/.test(value)) {
    return "Slug may contain only letters, numbers, dots, underscores, tildes, and hyphens.";
  }
  return null;
}

export function safeFormSuccessRedirectUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Keep the client aligned with the gateway's redirect-header boundary.
  // Encoded controls remain controls after URL decoding and must not survive
  // merely because they are not literal CR/LF/NUL characters yet.
  if (/[\r\n\u0000]|%(?:0a|0d|00)/i.test(trimmed)) return null;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    if (url.username || url.password) return null;
    if (url.protocol === "https:" || isLocalHttpUrl(url)) {
      url.hash = "";
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function isLocalHttpUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === "http:" &&
    (host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]")
  );
}

/**
 * Compile a FormStructure to a self-contained HTML <form> string that can
 * be rendered in an iframe srcDoc OR returned by the public hosted page.
 * The output uses `data-postwave-form="<slug>"` so embed.js can find it.
 */
export function compileFormHtml<TForm extends FormRenderModel>(
  form: TForm,
  opts: {
    actionUrl?: string;
    /** Hosted pages load reCAPTCHA through next/script; iframe srcDoc output
     * keeps the self-contained script by default. */
    includeCaptchaScript?: boolean;
    /** Localized empty option for select fields on hosted pages. */
    selectPlaceholder?: string;
    /** Localized explanation for an authored choice field with no choices. */
    noOptionsMessage?: string;
  } = {},
): string {
  const action =
    opts.actionUrl ??
    `/api/public/forms/${encodeURIComponent(form.slug)}/submit`;
  const captcha =
    form.captchaRequired && form.recaptchaSiteKey
      ? `<div class="g-recaptcha" data-sitekey="${escapeAttr(form.recaptchaSiteKey)}"></div>`
      : "";
  const fields = form.structure.fields
    .slice(0, MAX_COMPILED_FORM_FIELDS)
    .map(
      (f) =>
        `${f.kind === "submit" ? captcha : ""}${fieldToHtml(
          f,
          opts.selectPlaceholder ?? "Select…",
          opts.noOptionsMessage ??
            "No choices are available for this question.",
        )}`,
    )
    .join("\n  ");
  const trailingCaptcha =
    captcha && !form.structure.fields.some((field) => field.kind === "submit")
      ? captcha
      : "";
  const script =
    captcha && opts.includeCaptchaScript !== false
      ? '<script src="https://www.google.com/recaptcha/api.js" async defer></script>'
      : "";
  return `<form method="POST" action="${escapeAttr(action)}" data-postwave-form="${escapeAttr(form.slug)}" class="postwave-form ${escapeAttr(safeStyleClass(form.settings.styleClass ?? ""))}">
  <input type="hidden" name="submission_attempt_id" value="" />
  ${fields}
	${trailingCaptcha}
</form>${script}`;
}

function fieldToHtml(
  f: FormField,
  selectPlaceholder: string,
  noOptionsMessage: string,
): string {
  switch (f.kind) {
    case "heading":
      return `<h2 class="pw-heading">${htmlText(f.content ?? f.label, MAX_COMPILED_CONTENT_CHARS)}</h2>`;
    case "text":
      return `<p class="pw-text">${htmlText(f.content ?? f.label, MAX_COMPILED_CONTENT_CHARS)}</p>`;
    case "email":
      return labelWrap(
        f,
        `<input type="email" name="email" placeholder="${attrText(f.placeholder ?? "")}" ${f.required ? "required" : ""} />`,
      );
    case "name":
      return labelWrap(
        f,
        `<input type="text" name="name" placeholder="${attrText(f.placeholder ?? "")}" ${f.required ? "required" : ""} />`,
      );
    case "checkbox":
      return `<label class="pw-checkbox"><input type="checkbox" name="consent" value="yes" ${f.required ? "required" : ""} /> ${htmlText(f.label)}</label>`;
    case "custom":
      return labelWrap(
        f,
        `<input type="text" name="${customFieldName(f)}" placeholder="${attrText(f.placeholder ?? "")}" ${f.required ? "required" : ""} />`,
      );
    case "honeypot":
      return `<input type="text" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px;opacity:0;height:0;width:0;" aria-hidden="true" />`;
    case "submit":
      return `<button type="submit" class="pw-submit">${htmlText(f.label)}</button>`;
    case "radio": {
      const opts = (f.options ?? [])
        .slice(0, MAX_COMPILED_OPTIONS)
        .map((o, i) => {
          const v = attrText(o.value ?? o.label);
          return `<label class="pw-radio"><input type="radio" name="${customFieldName(
            f,
          )}" value="${v}" ${f.required && i === 0 ? "required" : ""} /> ${htmlText(o.label)}</label>`;
        })
        .join("");
      const empty = opts
        ? ""
        : `<p class="pw-field-error">${htmlText(noOptionsMessage, 240)}</p>`;
      return `<fieldset class="pw-fieldset"><legend>${htmlText(f.label)}${f.required ? " *" : ""}</legend>${opts}${empty}</fieldset>`;
    }
    case "select": {
      const opts = (f.options ?? [])
        .slice(0, MAX_COMPILED_OPTIONS)
        .map(
          (o) =>
            `<option value="${attrText(o.value ?? o.label)}">${htmlText(o.label)}</option>`,
        )
        .join("");
      const select = labelWrap(
        f,
        `<select name="${customFieldName(f)}" ${f.required ? "required" : ""}><option value="">${htmlText(selectPlaceholder, 120)}</option>${opts}</select>`,
      );
      return opts
        ? select
        : `${select}<p class="pw-field-error">${htmlText(noOptionsMessage, 240)}</p>`;
    }
    case "long_text":
      return labelWrap(
        f,
        `<textarea name="${customFieldName(f)}" rows="4" placeholder="${attrText(f.placeholder ?? "")}" ${f.required ? "required" : ""}></textarea>`,
      );
    case "scale": {
      const { min, max } = normalizeScaleRange(f.scaleMin, f.scaleMax);
      const inputs: string[] = [];
      for (let n = min; n <= max; n++) {
        inputs.push(
          `<label class="pw-scale-opt"><input type="radio" name="${customFieldName(
            f,
          )}" value="${n}" ${f.required && n === min ? "required" : ""} /> ${n}</label>`,
        );
      }
      return `<fieldset class="pw-fieldset pw-scale"><legend>${htmlText(f.label)}${f.required ? " *" : ""}</legend>${inputs.join("")}</fieldset>`;
    }
    case "step_break":
      // Step breaks render as a horizontal rule when JS is off — the
      // form still works as a single page in that fallback path.
      return `<hr class="pw-step-break" />`;
    case "file_upload": {
      // JS-off fallback: the browser will multipart-POST the file
      // alongside other fields. The gateway's submit handler does NOT
      // currently parse multipart bodies — this fallback exists so a
      // form built with a file_upload field still RENDERS without JS.
      // The JS path (SurveyForm) does the presigned-PUT dance and
      // submits the upload id as the field value.
      const accept = safeAcceptMimeList(f.acceptMime ?? []).join(",");
      return labelWrap(
        f,
        `<input type="file" name="${customFieldName(f)}" ${accept ? `accept="${escapeAttr(accept)}"` : ""} ${
          f.required ? "required" : ""
        } />`,
      );
    }
  }
}

function labelWrap(f: FormField, input: string): string {
  return `<label class="pw-field"><span>${htmlText(f.label)}${f.required ? " *" : ""}</span>${input}</label>`;
}

/**
 * Clamp a stored scale range into something answerable, repairing an inverted
 * one to the default band. Exported because every surface that renders a
 * `scale` field must agree: the builder lets Minimum and Maximum be set
 * independently, so Minimum > Maximum is reachable, and a renderer that loops
 * `min..max` without this produces a REQUIRED question with zero options —
 * unsatisfiable, so the survey can never be submitted.
 */
export function normalizeScaleRange(
  rawMin: number | undefined,
  rawMax: number | undefined,
): { min: number; max: number } {
  const min = clampInt(rawMin ?? 1, 0, 10);
  const max = clampInt(rawMax ?? 5, 0, 10);
  if (min > max) return { min: 1, max: 5 };
  return { min, max };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function htmlText(s: string, maxChars = MAX_COMPILED_FIELD_TEXT_CHARS): string {
  return escapeHtml(limitText(s, maxChars));
}

function attrText(s: string, maxChars = MAX_COMPILED_FIELD_TEXT_CHARS): string {
  return escapeAttr(limitText(s, maxChars));
}

function limitText(s: string, maxChars: number): string {
  return String(s ?? "").slice(0, maxChars);
}

function customFieldName(f: FormField): string {
  return `cf_${escapeAttr(safeCustomFieldKey(f.customKey ?? f.id))}`;
}

export function safeCustomFieldKey(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9_:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_CUSTOM_FIELD_KEY_CHARS);
  return cleaned || "field";
}

function safeAcceptMimeList(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const token = String(raw ?? "")
      .trim()
      .slice(0, 128);
    if (
      !/^(\.[a-z0-9]{1,16}|[a-z0-9.+-]{1,64}\/[a-z0-9.+*-]{1,64})$/i.test(token)
    ) {
      continue;
    }
    const normalized = token.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_ACCEPT_MIME_TOKENS) break;
  }
  return out;
}

function safeStyleClass(raw: string): string {
  return raw
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => /^[a-zA-Z0-9_:-]{1,64}$/.test(token))
    .slice(0, 12)
    .join(" ");
}
