// SPDX-License-Identifier: AGPL-3.0-only
/**
 * lib/utm-templates-api.ts — UTM auto-tag templates (desktop UTMTemplatesView
 * parity).
 *
 *   GET    /api/v1/utm-templates                 list (default + overrides)
 *   POST   /api/v1/utm-templates                 upsert the workspace default
 *   POST   /api/v1/utm-templates/campaign/{id}   upsert one campaign's override
 *   DELETE /api/v1/utm-templates/{id}            delete one template
 *   POST   /api/v1/utm-templates/preview         {url, campaign_id} → rewritten
 *
 * The server resolves one template per send: a campaign's own override wins,
 * then the workspace default, then nothing (links untouched). It only ever
 * APPENDS missing utm_* parameters — a value already on a link is kept. So a
 * preview whose `rewritten` equals `original` means either no template
 * applies or the link already carried every parameter; the resolved template
 * in the response says which.
 *
 * Writes are ScopeAdmin on the server (owner/admin sessions); list and preview
 * are read scope. Every write is an idempotent upsert keyed by the target, so
 * the automatic idempotency key the api client mints is left in place.
 */
import { api } from "@/lib/api";

export const UTM_PARAM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;

export type UtmParamKey = (typeof UTM_PARAM_KEYS)[number];
export type UtmParams = Record<UtmParamKey, string>;

export const UTM_PARAM_PLACEHOLDERS: UtmParams = {
  utm_source: "newsletter",
  utm_medium: "email",
  utm_campaign: "{{campaign_name}}",
  utm_term: "",
  utm_content: "",
};

export const EMPTY_UTM_PARAMS: UtmParams = {
  utm_source: "",
  utm_medium: "",
  utm_campaign: "",
  utm_term: "",
  utm_content: "",
};

/** Server limits (apps/api/internal/utm_tagging). */
export const MAX_UTM_VALUE_CHARS = 256;
export const MAX_UTM_PREVIEW_URL_CHARS = 2048;

export interface UtmTemplateRecord extends UtmParams {
  id: string;
  /** Empty for the workspace default. */
  campaignId: string;
  isDefault: boolean;
  enabled: boolean;
  updatedAt: string;
}

export interface UtmPreviewResult {
  original: string;
  rewritten: string;
  /** Which template the server resolved for this preview. */
  appliedFrom: "campaign" | "default" | "none";
  template: UtmTemplateRecord | null;
}

export class UtmContractError extends Error {
  constructor(reason: string) {
    super(
      `The UTM template service returned an invalid response (${reason}). Nothing on this page was changed.`,
    );
    this.name = "UtmContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function decodeTemplate(raw: unknown): UtmTemplateRecord {
  if (!isRecord(raw) || typeof raw.id !== "string") {
    throw new UtmContractError("template without an id");
  }
  const campaignId = text(raw.campaign_id);
  return {
    id: raw.id,
    campaignId,
    // Derived, not trusted: the server's own rule is "no campaign = default".
    isDefault: campaignId === "",
    enabled: raw.enabled !== false,
    updatedAt: text(raw.updated_at),
    utm_source: text(raw.utm_source),
    utm_medium: text(raw.utm_medium),
    utm_campaign: text(raw.utm_campaign),
    utm_term: text(raw.utm_term),
    utm_content: text(raw.utm_content),
  };
}

export async function listUtmTemplateRecords(
  signal?: AbortSignal,
): Promise<UtmTemplateRecord[]> {
  const raw = await api.get<unknown>("/api/v1/utm-templates", { signal });
  if (!isRecord(raw) || !Array.isArray(raw.templates)) {
    // A missing array is not "no templates": refuse to render it as empty.
    throw new UtmContractError("missing templates");
  }
  return raw.templates.map(decodeTemplate);
}

export type UtmFormValidation =
  | { ok: true; input: Partial<UtmParams> }
  | { ok: false; error: string };

/** Mirrors the server: trimmed values, ≤256 characters, at least one set. */
export function validateUtmParams(form: UtmParams): UtmFormValidation {
  const input: Partial<UtmParams> = {};
  for (const key of UTM_PARAM_KEYS) {
    const value = form[key].trim();
    if (Array.from(value).length > MAX_UTM_VALUE_CHARS) {
      return {
        ok: false,
        error: `${key} must be ${MAX_UTM_VALUE_CHARS} characters or fewer.`,
      };
    }
    if (value) input[key] = value;
  }
  if (Object.keys(input).length === 0) {
    return { ok: false, error: "Enter at least one UTM parameter." };
  }
  return { ok: true, input };
}

export function validateUtmPreviewUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const url = raw.trim();
  if (!url) return { ok: false, error: "Enter a URL to preview." };
  if (Array.from(url).length > MAX_UTM_PREVIEW_URL_CHARS) {
    return {
      ok: false,
      error: `The preview URL must be ${MAX_UTM_PREVIEW_URL_CHARS} characters or fewer.`,
    };
  }
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.host
    ) {
      return { ok: false, error: "The preview URL must use http:// or https://." };
    }
  } catch {
    return { ok: false, error: "Enter a complete absolute URL." };
  }
  return { ok: true, url };
}

function requireValid(form: UtmParams): Partial<UtmParams> {
  const validation = validateUtmParams(form);
  if (!validation.ok) throw new Error(validation.error);
  return validation.input;
}

/** Upsert the workspace default (campaign_id NULL). */
export async function saveDefaultUtmTemplate(
  form: UtmParams,
): Promise<{ id: string }> {
  const raw = await api.post<unknown>("/api/v1/utm-templates", requireValid(form), {
    requireOnline: true,
  });
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) {
    throw new UtmContractError("save returned no id");
  }
  return { id: raw.id };
}

/** Upsert one campaign's override. It wins over the default for that send. */
export async function saveCampaignUtmOverride(
  campaignId: string,
  form: UtmParams,
): Promise<{ id: string }> {
  if (!campaignId.trim()) throw new Error("A campaign is required.");
  const raw = await api.post<unknown>(
    `/api/v1/utm-templates/campaign/${encodeURIComponent(campaignId)}`,
    requireValid(form),
    { requireOnline: true },
  );
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) {
    throw new UtmContractError("save returned no id");
  }
  return { id: raw.id };
}

export async function deleteUtmTemplate(id: string): Promise<void> {
  if (!id.trim()) throw new Error("A template id is required.");
  await api.delete<void>(`/api/v1/utm-templates/${encodeURIComponent(id)}`, {
    requireOnline: true,
  });
}

/**
 * Rewrite one URL through the template the server would use. A preview writes
 * nothing, so no idempotency identity is minted and it is never queued.
 */
export async function previewUtmTemplate(input: {
  url: string;
  campaignId?: string;
}): Promise<UtmPreviewResult> {
  const checked = validateUtmPreviewUrl(input.url);
  if (!checked.ok) throw new Error(checked.error);
  const campaignId = input.campaignId?.trim() ?? "";
  const raw = await api.post<unknown>(
    "/api/v1/utm-templates/preview",
    campaignId ? { url: checked.url, campaign_id: campaignId } : { url: checked.url },
    { idempotencyKey: null },
  );
  if (
    !isRecord(raw) ||
    typeof raw.original !== "string" ||
    typeof raw.rewritten !== "string"
  ) {
    throw new UtmContractError("preview without a rewritten URL");
  }
  // The server answers a zero-value template (empty id) when none applies.
  const template =
    isRecord(raw.template) && text(raw.template.id)
      ? decodeTemplate(raw.template)
      : null;
  return {
    original: raw.original,
    rewritten: raw.rewritten,
    appliedFrom: !template ? "none" : template.isDefault ? "default" : "campaign",
    template,
  };
}

export function paramsFromTemplate(template: UtmParams): UtmParams {
  return {
    utm_source: template.utm_source,
    utm_medium: template.utm_medium,
    utm_campaign: template.utm_campaign,
    utm_term: template.utm_term,
    utm_content: template.utm_content,
  };
}
