import type { UTMTemplate, UTMTemplateInput } from "../../lib/api-client";

export const MAX_UTM_VALUE_CHARS = 256;
export const MAX_UTM_PREVIEW_URL_CHARS = 2048;
export const DEFAULT_UTM_PREVIEW_URL = "https://example.com/launch";

export const UTM_PARAM_FIELDS = [
  { key: "utm_source", label: "utm_source", placeholder: "newsletter" },
  { key: "utm_medium", label: "utm_medium", placeholder: "email" },
  {
    key: "utm_campaign",
    label: "utm_campaign",
    placeholder: "{{campaign_name}}",
  },
  { key: "utm_term", label: "utm_term", placeholder: "" },
  { key: "utm_content", label: "utm_content", placeholder: "" },
] as const;

export type UTMParamKey = (typeof UTM_PARAM_FIELDS)[number]["key"];
export type UTMFormState = Record<UTMParamKey, string>;

export const EMPTY_UTM_FORM: UTMFormState = {
  utm_source: "",
  utm_medium: "",
  utm_campaign: "",
  utm_term: "",
  utm_content: "",
};

export function templateSummary(template: UTMTemplate): string {
  const parts = UTM_PARAM_FIELDS.flatMap((field) => {
    const value = template[field.key];
    return value ? [`${field.label}=${value}`] : [];
  });
  return parts.length > 0 ? parts.join(" · ") : "(no parameters)";
}

export function formFromTemplate(template: UTMTemplate): UTMFormState {
  return Object.fromEntries(
    UTM_PARAM_FIELDS.map((field) => [field.key, template[field.key] ?? ""]),
  ) as UTMFormState;
}

export type UTMFormValidation =
  | { error: string; ok: false }
  | { input: UTMTemplateInput; ok: true };

export function validateUTMForm(form: UTMFormState): UTMFormValidation {
  const input: UTMTemplateInput = {};
  for (const field of UTM_PARAM_FIELDS) {
    const value = form[field.key].trim();
    if (Array.from(value).length > MAX_UTM_VALUE_CHARS) {
      return {
        error: `${field.label} must be ${MAX_UTM_VALUE_CHARS} characters or fewer.`,
        ok: false,
      };
    }
    if (value) input[field.key] = value;
  }
  if (Object.keys(input).length === 0) {
    return { error: "Enter at least one UTM parameter.", ok: false };
  }
  return { input, ok: true };
}

export function validateUTMPreviewUrl(
  raw: string,
): { error: string; ok: false } | { ok: true; url: string } {
  const url = raw.trim();
  if (!url) return { error: "Enter a URL to preview.", ok: false };
  if (url.length > MAX_UTM_PREVIEW_URL_CHARS) {
    return {
      error: `Preview URL must be ${MAX_UTM_PREVIEW_URL_CHARS} characters or fewer.`,
      ok: false,
    };
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        error: "Preview URL must use http:// or https://.",
        ok: false,
      };
    }
  } catch {
    return { error: "Enter a valid absolute URL.", ok: false };
  }
  return { ok: true, url };
}
