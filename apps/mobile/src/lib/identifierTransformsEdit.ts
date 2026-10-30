/**
 * lib/identifierTransformsEdit.ts — the pure half of EDITING identifier
 * transforms from a phone: the draft diff, the preview request/response
 * shapes, and the sentences the confirm sheet shows.
 *
 * lib/platformConfig.ts owns the READ shape (IdentifierTransformsView) and
 * says why the phone was read-only; this file is the second half of that
 * decision, taken once the parity register (docs/mobile-desktop-parity-
 * 2026-08-28.md, "Identifier-transform rules") judged the edit phone-shaped
 * as long as it stays behind a confirm and a live preview.
 *
 * WIRE SHAPES, read off apps/api/internal/subscribers/identifier_normalizer.go:
 *
 *   PATCH /api/v1/settings/identifier-transforms  (admin)
 *     body: UpdateIdentifierTransformInput — every field a POINTER, so only
 *     the fields sent change; an empty body is 400 "at least one transform
 *     field is required". Response: the full IdentifierTransformConfig.
 *   POST /api/v1/subscribers/preview-transforms   (editor)
 *     body: {email, merge_fields, custom_fields, overrides?} — `overrides` is
 *     the UNSAVED draft, so the preview shows what a save would do.
 *     Response: PreviewTransformResult {config, email_input, email_output,
 *     email_changed, phones: [{key, input, output, changed}]}.
 *
 * Import-free so it runs under node vitest.
 */
import { transitionLabel } from "./direction";
import type { IdentifierTransformsView } from "./platformConfig";

export type IdentifierTransformsDraft = IdentifierTransformsView;

/** Partial PATCH body — snake_case, pointer semantics on the server. */
export interface IdentifierTransformsPatch {
  email_normalize_dots?: boolean;
  email_normalize_plus?: boolean;
  phone_e164_format?: boolean;
  phone_default_region?: string;
}

/**
 * The regions the picker offers, mirroring desktop's
 * IDENTIFIER_TRANSFORM_PHONE_REGIONS (apps/desktop/src/lib/api-client.ts).
 * The server validates against its own table; this list is the subset a
 * phone-sized picker can present, and every entry is one the server accepts.
 */
export const IDENTIFIER_TRANSFORM_PHONE_REGIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "", label: "None (international numbers only)" },
  { value: "US", label: "United States (+1)" },
  { value: "CA", label: "Canada (+1)" },
  { value: "GB", label: "United Kingdom (+44)" },
  { value: "IE", label: "Ireland (+353)" },
  { value: "AU", label: "Australia (+61)" },
  { value: "NZ", label: "New Zealand (+64)" },
  { value: "DE", label: "Germany (+49)" },
  { value: "FR", label: "France (+33)" },
  { value: "ES", label: "Spain (+34)" },
  { value: "IT", label: "Italy (+39)" },
  { value: "NL", label: "Netherlands (+31)" },
  { value: "SE", label: "Sweden (+46)" },
  { value: "NO", label: "Norway (+47)" },
  { value: "DK", label: "Denmark (+45)" },
  { value: "FI", label: "Finland (+358)" },
  { value: "IN", label: "India (+91)" },
  { value: "SG", label: "Singapore (+65)" },
  { value: "JP", label: "Japan (+81)" },
  { value: "BR", label: "Brazil (+55)" },
  { value: "MX", label: "Mexico (+52)" },
  { value: "ZA", label: "South Africa (+27)" },
  { value: "AE", label: "United Arab Emirates (+971)" },
  { value: "CH", label: "Switzerland (+41)" },
  { value: "AT", label: "Austria (+43)" },
  { value: "BE", label: "Belgium (+32)" },
  { value: "PT", label: "Portugal (+351)" },
  { value: "PL", label: "Poland (+48)" },
  { value: "CZ", label: "Czechia (+420)" },
];

/** The sample the preview opens with — one that every rule visibly changes. */
export const DEFAULT_PREVIEW_EMAIL = "J.o.h.n+promo@Gmail.com";
export const DEFAULT_PREVIEW_PHONE = "(202) 555-0147";

/**
 * Diff draft vs the server snapshot into the partial PATCH body. Null when
 * nothing changed, which is also the sheet's dirty flag. Sending only the
 * changed fields matters: the server's pointer semantics mean an untouched
 * field is never re-asserted from a phone over a value set at a desk.
 */
export function identifierTransformsPatch(
  server: IdentifierTransformsDraft,
  draft: IdentifierTransformsDraft,
): IdentifierTransformsPatch | null {
  const patch: IdentifierTransformsPatch = {};
  if (draft.emailNormalizeDots !== server.emailNormalizeDots) {
    patch.email_normalize_dots = draft.emailNormalizeDots;
  }
  if (draft.emailNormalizePlus !== server.emailNormalizePlus) {
    patch.email_normalize_plus = draft.emailNormalizePlus;
  }
  if (draft.phoneE164Format !== server.phoneE164Format) {
    patch.phone_e164_format = draft.phoneE164Format;
  }
  if (draft.phoneDefaultRegion !== server.phoneDefaultRegion) {
    patch.phone_default_region = draft.phoneDefaultRegion;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Mirror of the server's region check so a bad code fails with a field
 * message instead of a 400 toast. The picker only offers valid codes, so this
 * mostly guards a draft assembled some other way.
 */
export function validateIdentifierTransformsDraft(
  draft: IdentifierTransformsDraft,
): string | null {
  const region = draft.phoneDefaultRegion;
  if (region !== "" && !/^[A-Z]{2}$/.test(region)) {
    return "Default region must be a two-letter country code, or none.";
  }
  return null;
}

/** POST /subscribers/preview-transforms body. */
export interface TransformPreviewRequest {
  email: string;
  custom_fields: Record<string, string>;
  overrides: {
    email_normalize_dots: boolean;
    email_normalize_plus: boolean;
    phone_e164_format: boolean;
    phone_default_region: string;
  };
}

/**
 * The preview request for a draft and a pair of samples. The phone rides in
 * `custom_fields.phone` because the server only previews keys it recognises
 * as phone fields (phoneFieldKeys); an empty sample is omitted rather than
 * sent as "" so the response carries no meaningless row.
 */
export function previewRequestBody(
  draft: IdentifierTransformsDraft,
  sampleEmail: string,
  samplePhone: string,
): TransformPreviewRequest {
  const phone = samplePhone.trim();
  return {
    email: sampleEmail.trim(),
    custom_fields: phone ? { phone } : {},
    overrides: {
      email_normalize_dots: draft.emailNormalizeDots,
      email_normalize_plus: draft.emailNormalizePlus,
      phone_e164_format: draft.phoneE164Format,
      phone_default_region: draft.phoneDefaultRegion,
    },
  };
}

export interface TransformPreviewLine {
  key: string;
  input: string;
  output: string;
  changed: boolean;
}

export interface TransformPreviewView {
  email: TransformPreviewLine;
  phones: TransformPreviewLine[];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * PreviewTransformResult → the lines a card renders. Null when the payload is
 * not the preview shape at all (an SPA fallback body, a paged envelope), so
 * the sheet says "malformed" rather than rendering an empty, reassuring
 * preview that proves nothing.
 */
export function normalizeTransformPreview(
  raw: unknown,
): TransformPreviewView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.email_input !== "string" ||
    typeof r.email_output !== "string" ||
    typeof r.email_changed !== "boolean"
  ) {
    return null;
  }
  const phones: TransformPreviewLine[] = [];
  for (const entry of Array.isArray(r.phones) ? r.phones : []) {
    const p = (entry ?? {}) as Record<string, unknown>;
    const key = str(p.key);
    if (!key) continue;
    phones.push({
      key,
      input: str(p.input),
      output: str(p.output),
      changed: p.changed === true,
    });
  }
  return {
    email: {
      key: "email",
      input: r.email_input,
      output: r.email_output,
      changed: r.email_changed,
    },
    phones,
  };
}

/**
 * One before → after line as a sentence. The unchanged case says so in words
 * — the absence of a transform is the thing a reader is checking for as often
 * as its presence — and an empty input reads as an em-dash, not as "".
 */
export function previewLineText(line: TransformPreviewLine): string {
  const input = line.input || "—";
  if (!line.changed) return `${line.output || input} (no change)`;
  return transitionLabel(input, line.output);
}

/** What a rule does, in the words the confirm sheet uses. */
const RULE_SENTENCES: Record<keyof IdentifierTransformsPatch, [string, string]> =
  {
    email_normalize_dots: [
      "Dots will be removed from email local-parts",
      "Dots in email local-parts will be kept",
    ],
    email_normalize_plus: [
      "“+tag” sub-addresses will be dropped",
      "“+tag” sub-addresses will be kept",
    ],
    phone_e164_format: [
      "Phone numbers will be coerced to E.164",
      "Phone numbers will be stored as received",
    ],
    phone_default_region: ["", ""],
  };

/**
 * The consequence lines for a confirm sheet, one per changed rule. These are
 * the user's own choices restated — never a count or a claim about existing
 * rows, because the server rewrites nothing retroactively.
 */
export function transformChangeLines(
  patch: IdentifierTransformsPatch,
): string[] {
  const out: string[] = [];
  for (const key of [
    "email_normalize_dots",
    "email_normalize_plus",
    "phone_e164_format",
  ] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    const [on, off] = RULE_SENTENCES[key];
    out.push(value ? on : off);
  }
  if (patch.phone_default_region !== undefined) {
    out.push(
      patch.phone_default_region
        ? `National-format numbers will default to ${patch.phone_default_region}`
        : "National-format numbers will have no default region",
    );
  }
  return out;
}

/**
 * The sentence every save carries. Desktop states it under the buttons
 * ("Changes apply to new ingests only — existing rows are not rewritten.");
 * on a phone it is the confirm sheet's consequence line, where it cannot be
 * scrolled past.
 */
export const TRANSFORM_SCOPE_SENTENCE =
  "Applies to new imports and signups only — existing subscribers are not rewritten.";
