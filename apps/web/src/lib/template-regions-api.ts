// SPDX-License-Identifier: AGPL-3.0-only
//
// Editable regions and merge-variable drafts for workspace campaign templates.
//
// Regions: GET /api/v1/campaign-templates/{id}/regions parses every
// `{{region:name}}…{{/region}}` zone out of the SAVED body (HTML, or MJML when
// the HTML is empty) and reports each zone's byte offset + byte span. The
// response is decoded strictly: a malformed envelope is an error, never an
// empty list, so a broken read cannot pass for "this template has no regions".
//
// Variables: the template row stores `variables` as an opaque
// `Array<Record<string, unknown>>` and a PATCH that carries `variables` is a
// FULL REPLACE. The draft helpers below edit name / label / default while
// carrying every other field of an existing definition through untouched, so a
// save from this editor never strips metadata another client wrote.

import { api } from "@/lib/api";
import { base, type RoleKey } from "@/lib/query-keys";

export interface CampaignTemplateRegion {
  /** Lower-cased region name, as the server parsed it. */
  name: string;
  /** Trimmed content between the opening and closing region tags. */
  default_html: string;
  /** Byte offset of the opening `{{region:…}}` tag in the saved source. */
  position: number;
  /** Byte span of the whole region, opening tag through closing tag. */
  length: number;
}

export const INVALID_REGIONS_RESPONSE =
  "The server returned an invalid regions response. No unverified region data was shown.";

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Strictly decode the regions envelope; `null` means "do not trust it". */
export function decodeCampaignTemplateRegions(
  value: unknown,
): CampaignTemplateRegion[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const regions = (value as Record<string, unknown>).regions;
  if (!Array.isArray(regions)) return null;
  const out: CampaignTemplateRegion[] = [];
  for (const item of regions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const region = item as Record<string, unknown>;
    if (
      typeof region.name !== "string" ||
      region.name.trim() === "" ||
      typeof region.default_html !== "string" ||
      !nonNegativeInteger(region.position) ||
      !nonNegativeInteger(region.length)
    ) {
      return null;
    }
    out.push({
      name: region.name,
      default_html: region.default_html,
      position: region.position,
      length: region.length,
    });
  }
  return out;
}

export async function getCampaignTemplateRegions(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<CampaignTemplateRegion[]> {
  const raw = await api.get<unknown>(
    `/api/v1/campaign-templates/${encodeURIComponent(id)}/regions`,
    { signal: options.signal },
  );
  const regions = decodeCampaignTemplateRegions(raw);
  if (!regions) throw new Error(INVALID_REGIONS_RESPONSE);
  return regions;
}

/**
 * Tenant/role-scoped key for one template's saved regions. The ETag is part of
 * the key so a newer saved version is never answered from an older parse.
 */
export const templateRegionKeys = {
  list: (
    tenantId: string,
    role: RoleKey,
    templateId: string,
    etag: string | null | undefined,
  ) =>
    [
      ...base("campaign-template-regions", tenantId, role),
      templateId,
      etag ?? null,
    ] as const,
};

/** Which saved body the server parsed: MJML wins for legacy dual-source records. */
export function regionSourceFormat(template: {
  body_html?: string | null;
  body_mjml?: string | null;
}): "html" | "mjml" {
  return template.body_mjml ? "mjml" : "html";
}

/** Convert a UTF-8 byte offset in `source` to a UTF-16 string index. */
export function byteOffsetToIndex(source: string, byteOffset: number): number {
  const encoder = new TextEncoder();
  let bytes = 0;
  let index = 0;
  for (const char of source) {
    if (bytes >= byteOffset) break;
    bytes += encoder.encode(char).length;
    index += char.length;
  }
  return index;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function regionPattern(name: string, flags: string): RegExp {
  return new RegExp(
    `\\{\\{\\s*region:${escapeRegExp(name)}\\s*\\}\\}[\\s\\S]*?\\{\\{\\s*/\\s*region\\s*\\}\\}`,
    flags,
  );
}

/**
 * Where a saved region sits in the source the operator is editing now.
 *
 * When the draft still equals the saved source, the server's byte offset is
 * used — but only if the span it names really is that region (the page's copy
 * of the body can be projected differently from the row the server parsed).
 * Otherwise the region is re-found by name — the `ordinal`-th region of that
 * name, matching the server's own non-greedy parse — and `null` means it is no
 * longer in the source.
 */
export function locateRegionInSource(
  source: string,
  savedSource: string,
  region: CampaignTemplateRegion,
  ordinal: number,
): { start: number; end: number } | null {
  if (source === savedSource) {
    const start = byteOffsetToIndex(source, region.position);
    const end = byteOffsetToIndex(source, region.position + region.length);
    const span = source.slice(start, end);
    const exact = regionPattern(region.name, "i").exec(span);
    if (end > start && exact?.index === 0 && exact[0].length === span.length) {
      return { start, end };
    }
  }
  const pattern = regionPattern(region.name, "gi");
  let seen = 0;
  for (const match of source.matchAll(pattern)) {
    if (seen === ordinal && match.index !== undefined) {
      return { start: match.index, end: match.index + match[0].length };
    }
    seen += 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Merge-variable drafts
// ---------------------------------------------------------------------------

/** Server ceilings (apps/api campaigntemplates) plus the desktop editor's. */
export const TEMPLATE_VARIABLE_MAX = 100;
export const TEMPLATE_VARIABLE_NAME_MAX = 64;
export const TEMPLATE_VARIABLE_LABEL_MAX = 200;
export const TEMPLATE_VARIABLE_DEFAULT_MAX = 4096;
const TEMPLATE_VARIABLE_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

export interface TemplateVariableDraft {
  name: string;
  label: string;
  default: string;
  /** Which stored field carries the identifier (`name`, or legacy `key`). */
  nameField: "name" | "key";
  /** Every other stored field, carried through a save untouched. */
  extra: Record<string, unknown>;
}

export function emptyTemplateVariableDraft(): TemplateVariableDraft {
  return { name: "", label: "", default: "", nameField: "name", extra: {} };
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

export function readTemplateVariableDrafts(
  variables: unknown,
): TemplateVariableDraft[] {
  if (!Array.isArray(variables)) return [];
  const drafts: TemplateVariableDraft[] = [];
  for (const value of variables) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const nameField: "name" | "key" =
      typeof record.name === "string" || typeof record.key !== "string"
        ? "name"
        : "key";
    const extra: Record<string, unknown> = {};
    for (const [field, fieldValue] of Object.entries(record)) {
      if (field === nameField || field === "label" || field === "default") {
        continue;
      }
      extra[field] = fieldValue;
    }
    drafts.push({
      name: text(record[nameField]),
      label: text(record.label),
      default: text(record.default),
      nameField,
      extra,
    });
  }
  return drafts;
}

export function serializeTemplateVariableDrafts(
  drafts: readonly TemplateVariableDraft[],
): Array<Record<string, unknown>> {
  return drafts.map((draft) => ({
    ...draft.extra,
    [draft.nameField]: draft.name.trim(),
    label: draft.label,
    default: draft.default,
  }));
}

/** Stable comparison key for dirty tracking. */
export function templateVariablesFingerprint(
  drafts: readonly TemplateVariableDraft[],
): string {
  return JSON.stringify(serializeTemplateVariableDrafts(drafts));
}

/** Returns the first problem as a sentence, or `null` when the set is valid. */
export function validateTemplateVariableDrafts(
  drafts: readonly TemplateVariableDraft[],
): string | null {
  if (drafts.length > TEMPLATE_VARIABLE_MAX) {
    return `Templates support at most ${TEMPLATE_VARIABLE_MAX} merge variables.`;
  }
  const names = new Set<string>();
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!TEMPLATE_VARIABLE_NAME_RE.test(name)) {
      return "Every merge variable needs a name of up to 64 letters, numbers, or underscores.";
    }
    if (names.has(name)) {
      return `Merge variable "${name}" is listed twice. Variable names must be unique.`;
    }
    names.add(name);
    if (
      draft.label.length > TEMPLATE_VARIABLE_LABEL_MAX ||
      draft.default.length > TEMPLATE_VARIABLE_DEFAULT_MAX
    ) {
      return `Merge variable "${name}" has a label over ${TEMPLATE_VARIABLE_LABEL_MAX} characters or a default over ${TEMPLATE_VARIABLE_DEFAULT_MAX.toLocaleString("en-US")} characters.`;
    }
  }
  return null;
}
