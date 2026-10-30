// SPDX-License-Identifier: AGPL-3.0-only

import { api, parseRetryAfter } from "./api";
import type { Campaign } from "./campaigns-api";

export type CampaignTemplateSource =
  | "all"
  | "platform"
  | "team"
  | "mine"
  | "ingested"
  | string;

export interface CampaignTemplatePreviewAsset {
  variant: "desktop" | "mobile" | "card";
  url: string;
  mime_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width: number;
  height: number;
  size_bytes: number;
  /** source_missing retains the last-known-good hosted image. */
  status: "ready" | "source_missing";
}

export interface CampaignTemplateHostedPreview {
  variant: CampaignTemplatePreviewAsset["variant"];
  url: string;
  width?: number;
  height?: number;
  size_bytes?: number;
  status?: CampaignTemplatePreviewAsset["status"];
  legacy?: boolean;
}

export interface CampaignTemplateSummary {
  id: string;
  tenant_id?: string;
  /** Monotonic server revision used for optimistic concurrency. */
  version?: number;
  /** Strong entity tag that must be echoed on every editable-template write. */
  etag?: string;
  /** Present only while a workspace-owned editable template is archived. */
  archived_at?: string;
  name: string;
  description?: string;
  subject: string;
  goal?: string;
  category?: string;
  tags: string[];
  style?: string;
  industry?: string;
  layout_archetype?: string;
  /** Canonical API field; normalized into layout_archetype for the UI. */
  layout?: string;
  thumbnail_url?: string;
  preview_assets?: CampaignTemplatePreviewAsset[];
  source?: CampaignTemplateSource;
  provider?: string;
  source_provider?: string;
  source_brand?: string;
  template_kind?: "editable" | "reference" | string;
  is_featured?: boolean;
  is_favorited?: boolean;
  usage_count?: number;
  /** Server-controlled ingestion completeness/confidence score, 0–1. */
  quality_score?: number;
  reference_template_ids?: string[];
  generation_metadata?: Record<string, unknown>;
  source_metadata?: Record<string, unknown>;
  design_metadata?: Record<string, unknown>;
  review_status?: "pending" | "approved" | "rejected" | string;
  source_license_status?: string;
  capabilities?: Partial<CampaignTemplateCapabilities>;
  recommended_action?: CampaignTemplateRecommendedAction;
  warnings?: CampaignTemplateWarning[];
}

export interface CampaignTemplate extends CampaignTemplateSummary {
  slug?: string;
  preview_text?: string;
  body_html?: string;
  body_mjml?: string;
  variables?: Array<Record<string, unknown>>;
  editable_regions?: Array<Record<string, unknown>>;
  provenance?: Record<string, unknown>;
  license_status?: string;
  source_url?: string;
  created_at?: string;
  updated_at?: string;
}

export type CampaignTemplateRecommendedAction =
  | "adapt"
  | "use"
  | "request_access"
  | "await_review"
  | "none"
  | string;

/**
 * Authoritative per-template actions returned by newer API versions. Every
 * field is optional on the wire so the web app remains compatible with older
 * deployments while the derived fallback below keeps actions fail-closed for
 * governed reference designs.
 */
export interface CampaignTemplateCapabilities {
  can_preview: boolean;
  can_favorite: boolean;
  can_adapt: boolean;
  can_use_directly: boolean;
  can_edit_directly: boolean;
  can_clone: boolean;
  can_create_campaign: boolean;
  can_delete: boolean;
  can_archive: boolean;
  can_restore: boolean;
  has_source_html: boolean;
  has_source_mjml: boolean;
  has_desktop_preview: boolean;
  has_mobile_preview: boolean;
  preview_kind?: "html" | "screenshot" | "metadata";
}

export interface CampaignTemplateWarning {
  code: string;
  message: string;
  recommended_action?: string;
}

function metadataBoolean(
  object: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return object?.[key] === true;
}

export function campaignTemplateCapabilities(
  template: CampaignTemplateSummary,
): CampaignTemplateCapabilities {
  const explicit = template.capabilities ?? {};
  const storedHTMLBytes = Number(template.design_metadata?.stored_html_bytes);
  const trustedEditable = template.template_kind === "editable";
  const hasSourceHTML =
    trustedEditable &&
    (Boolean((template as CampaignTemplate).body_html?.trim()) ||
      (Number.isFinite(storedHTMLBytes) && storedHTMLBytes > 0));
  const hasSourceMJML =
    trustedEditable &&
    Boolean((template as CampaignTemplate).body_mjml?.trim());
  // Capability fallbacks must describe something this browser can actually
  // render. Provider URLs remain provenance until Moosewave has copied them
  // into a validated hosted asset; stored source is rendered network-silent.
  const hostedDesktopPreview = Boolean(
    campaignTemplatePreviewUrl(template, ["desktop", "card"]),
  );
  const hostedMobilePreview = Boolean(
    campaignTemplatePreviewUrl(template, ["mobile"]),
  );
  const editableMetadata = trustedEditable;
  const clientRenderableSource =
    editableMetadata && (hasSourceHTML || hasSourceMJML);
  const metadataDesktopPreview =
    metadataBoolean(template.design_metadata, "has_desktop_preview") &&
    editableMetadata;
  const metadataMobilePreview =
    metadataBoolean(template.design_metadata, "has_mobile_preview") &&
    editableMetadata;
  const hasDesktopPreview =
    hostedDesktopPreview || metadataDesktopPreview || clientRenderableSource;
  const hasMobilePreview = hostedMobilePreview || metadataMobilePreview;
  const fallback: CampaignTemplateCapabilities = {
    can_preview: hasDesktopPreview || hasMobilePreview,
    // Mutation rights are never reconstructed from license/review metadata in
    // the browser. Only the request-aware server capability projection can
    // grant an action; older deployments therefore fail closed.
    can_favorite: false,
    can_adapt: false,
    can_use_directly: false,
    can_edit_directly: false,
    can_clone: false,
    can_create_campaign: false,
    can_delete: false,
    can_archive: false,
    can_restore: false,
    has_source_html: hasSourceHTML,
    has_source_mjml: hasSourceMJML,
    has_desktop_preview: hasDesktopPreview,
    has_mobile_preview: hasMobilePreview,
  };
  return {
    can_preview: explicit.can_preview ?? fallback.can_preview,
    can_favorite: explicit.can_favorite ?? fallback.can_favorite,
    can_adapt: explicit.can_adapt ?? fallback.can_adapt,
    can_use_directly: explicit.can_use_directly ?? fallback.can_use_directly,
    can_edit_directly: explicit.can_edit_directly ?? fallback.can_edit_directly,
    can_clone: explicit.can_clone ?? fallback.can_clone,
    can_create_campaign:
      explicit.can_create_campaign ?? fallback.can_create_campaign,
    can_delete: explicit.can_delete ?? fallback.can_delete,
    can_archive: explicit.can_archive ?? fallback.can_archive,
    can_restore: explicit.can_restore ?? fallback.can_restore,
    has_source_html: explicit.has_source_html ?? fallback.has_source_html,
    has_source_mjml: explicit.has_source_mjml ?? fallback.has_source_mjml,
    has_desktop_preview:
      explicit.has_desktop_preview ?? fallback.has_desktop_preview,
    has_mobile_preview:
      explicit.has_mobile_preview ?? fallback.has_mobile_preview,
    preview_kind: explicit.preview_kind,
  };
}

export function campaignTemplateCapabilityLabel(
  template: CampaignTemplateSummary,
): string {
  const capabilities = campaignTemplateCapabilities(template);
  if (template.template_kind === "reference") return "Visual inspiration";
  if (capabilities.has_source_mjml) return "Edit in blocks";
  if (capabilities.has_source_html) return "Edit HTML";
  return "Editable template";
}

export function campaignTemplateActionReason(
  template: CampaignTemplateSummary,
): string | null {
  const capabilities = campaignTemplateCapabilities(template);
  if (template.archived_at) {
    return capabilities.can_restore
      ? "This template is archived. Restore it before editing or using it."
      : "This template is archived and read-only.";
  }
  if (template.template_kind === "reference" && !capabilities.can_adapt) {
    if (template.review_status === "pending") {
      return "This design is awaiting review before it can guide a new design.";
    }
    return "This design is available to preview, but adaptation is not enabled.";
  }
  if (
    template.template_kind !== "reference" &&
    !capabilities.can_create_campaign
  ) {
    return "You can preview this template, but you do not have access to use it.";
  }
  return null;
}

export function isVisualOnlyCampaignTemplate(
  template: CampaignTemplateSummary,
): boolean {
  // Governed reference source may exist server-side for adaptation, but the
  // browser contract always redacts it. References are therefore visual
  // inspiration regardless of internal source-availability capabilities.
  return template.template_kind === "reference";
}

export function campaignTemplateExportableSource(template: CampaignTemplate): {
  html: boolean;
  mjml: boolean;
} {
  // Export is intentionally stricter than rendering. A mixed-version server
  // may accidentally project source fields on a governed reference row. Only
  // explicit source capabilities on a workspace-owned editable template can
  // authorize a download; body presence alone never does.
  const trustedEditable =
    template.template_kind === "editable" &&
    isOwnedCampaignTemplate(template) &&
    template.capabilities != null;
  return {
    html:
      trustedEditable &&
      template.capabilities?.has_source_html === true &&
      Boolean(template.body_html?.trim()),
    mjml:
      trustedEditable &&
      template.capabilities?.has_source_mjml === true &&
      Boolean(template.body_mjml?.trim()),
  };
}

export interface CampaignTemplateFacetValue {
  value: string;
  count?: number;
}

export type CampaignTemplateFacet =
  | string[]
  | CampaignTemplateFacetValue[]
  | Record<string, number>;

export interface CampaignTemplateFacets {
  goals?: CampaignTemplateFacet;
  categories?: CampaignTemplateFacet;
  styles?: CampaignTemplateFacet;
  industries?: CampaignTemplateFacet;
  layouts?: CampaignTemplateFacet;
  layout_archetypes?: CampaignTemplateFacet;
  sources?: CampaignTemplateFacet;
  tags?: CampaignTemplateFacet;
  [key: string]: CampaignTemplateFacet | undefined;
}

export interface CampaignTemplateSearchResponse {
  items: CampaignTemplateSummary[];
  next_cursor: string | null;
  page?: number;
  per_page?: number;
  total: number;
  facets: CampaignTemplateFacets;
}

export interface CampaignTemplateSearchInput {
  q?: string;
  goal?: string;
  category?: string;
  source?: string;
  provider?: string;
  style?: string;
  layout?: string;
  industry?: string;
  kind?: "editable" | "reference";
  archived?: "active" | "archived" | "all";
  tags?: string | string[];
  featured?: boolean;
  favorited?: boolean;
  /** Server-owned catalog ordering, stable across cursor pages. */
  sort?: CampaignTemplateSortKey;
  cursor?: string;
  page?: number;
  perPage?: number;
}

export interface CampaignTemplateRequestOptions {
  signal?: AbortSignal;
}

export const CAMPAIGN_TEMPLATE_SORTS = [
  "recommended",
  "name",
  "most_used",
] as const;
export type CampaignTemplateSortKey = (typeof CAMPAIGN_TEMPLATE_SORTS)[number];

export type CampaignTemplateDesignMode = "adapt" | "generate";
export type CampaignTemplateDesignStatus =
  | "queued"
  | "generating"
  | "ready"
  | "failed"
  | "saved"
  | "campaign_created"
  | "archived";

export interface CampaignTemplateDesignOutput {
  name: string;
  subject: string;
  preview_text?: string;
  body_html: string;
  body_mjml?: string;
  variables?: Record<string, unknown>;
  unresolved_variables: string[];
  reference_template_ids: string[];
  warnings: string[];
}

export interface CampaignTemplateDesignValidationCheck {
  code: string;
  status: "pass" | "warn" | "fail";
  message: string;
  repaired?: boolean;
}

export interface CampaignTemplateDesignValidation {
  status: "pass" | "warn" | "fail";
  checks: CampaignTemplateDesignValidationCheck[];
}

export interface CampaignTemplateDesignRevision {
  id: string;
  draft_id: string;
  revision: number;
  operation: "initial" | "refine" | "repair" | string;
  base_revision?: number;
  output: CampaignTemplateDesignOutput;
  output_hash: string;
  validation: CampaignTemplateDesignValidation;
  warnings: CampaignTemplateWarning[];
  created_at: string;
}

export interface CampaignTemplateDesignCapabilities {
  can_refine: boolean;
  can_retry: boolean;
  can_save: boolean;
  can_create_campaign: boolean;
  can_archive: boolean;
}

export interface CampaignTemplateDesignDraft {
  id: string;
  mode: CampaignTemplateDesignMode;
  status: CampaignTemplateDesignStatus;
  source_template_id?: string;
  reference_template_ids: string[];
  current_revision: number;
  revision?: CampaignTemplateDesignRevision;
  attempt_count: number;
  last_error_code?: string;
  last_error_message?: string;
  saved_template_id?: string;
  saved_revision?: number;
  created_campaign_id?: string;
  campaign_revision?: number;
  capabilities: CampaignTemplateDesignCapabilities;
  recommended_action: string;
  retry_after_seconds?: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
  request: CreateCampaignTemplateDesignInput;
}

export interface CampaignTemplateDesignSummary {
  id: string;
  mode: CampaignTemplateDesignMode;
  status: CampaignTemplateDesignStatus;
  source_template_id?: string;
  current_revision: number;
  attempt_count: number;
  last_error_code?: string;
  last_error_message?: string;
  saved_template_id?: string;
  saved_revision?: number;
  created_campaign_id?: string;
  campaign_revision?: number;
  capabilities: CampaignTemplateDesignCapabilities;
  recommended_action: string;
  retry_after_seconds?: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignTemplateDesignSummaryPage {
  items: CampaignTemplateDesignSummary[];
  next_cursor?: string;
  generation_available?: boolean;
}

export interface AdaptCampaignTemplateInput {
  instructions?: string;
  tone?: string;
  content?: Record<string, unknown>;
  brand?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  reference_template_ids?: string[];
  name?: string;
  subject?: string;
  preview_text?: string;
  fidelity?: "close" | "balanced" | "inspired";
  audience?: string;
  industry?: string;
  style?: string;
  layout?: string;
  sections?: string[];
  cta?: string;
}

export interface GenerateCampaignTemplateInput {
  brief: string;
  kind?: "newsletter" | "promo" | "announcement";
  tone?: string;
  name?: string;
  goal?: string;
  category?: string;
  subject?: string;
  preview_text?: string;
  audience?: string;
  industry?: string;
  style?: string;
  layout?: string;
  brand?: Record<string, unknown>;
  content?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  reference_template_ids?: string[];
  fidelity?: "close" | "balanced" | "inspired";
  sections?: string[];
  cta?: string;
}

export interface CreateCampaignTemplateDesignInput extends Omit<
  GenerateCampaignTemplateInput,
  "brief"
> {
  mode: CampaignTemplateDesignMode;
  source_template_id?: string;
  brief?: string;
  instructions?: string;
}

export interface RefineCampaignTemplateDesignInput {
  instructions: string;
  base_revision: number;
}

export interface CommitCampaignTemplateDesignInput {
  revision: number;
  output_hash: string;
}

export interface SaveCampaignTemplateDesignInput extends CommitCampaignTemplateDesignInput {
  slug: string;
  name?: string;
  subject?: string;
  preview_text?: string;
}

export interface CreateCampaignFromDesignInput extends CommitCampaignTemplateDesignInput {
  name?: string;
  subject?: string;
  preview_text?: string;
  variables?: Record<string, unknown>;
  segment_id?: string;
  list_id?: string | number;
}

export interface CreateCampaignFromTemplateInput {
  template_id: string;
  name?: string;
  subject?: string;
  preview_text?: string;
  variables?: Record<string, unknown>;
  content?: Record<string, unknown>;
  brand?: Record<string, unknown>;
  segment_id?: string;
  list_id?: string | number;
}

export interface CampaignTemplateDesignMutationOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface CampaignTemplateDesignRequiredMutationOptions extends CampaignTemplateDesignMutationOptions {
  idempotencyKey: string;
}

export interface WaitForCampaignTemplateDesignOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  initialPollMs?: number;
  maxPollMs?: number;
  onUpdate?: (draft: CampaignTemplateDesignDraft) => void;
}

export class CampaignTemplateDesignWaitError extends Error {
  constructor(
    public readonly code: "design_expired" | "design_poll_timeout",
    public readonly draft?: CampaignTemplateDesignDraft,
  ) {
    super(
      code === "design_expired"
        ? "This design draft expired before generation finished."
        : "The design is still processing. You can close this window and resume it later.",
    );
    this.name = "CampaignTemplateDesignWaitError";
  }
}

function readTagValue(tags: readonly string[] | undefined, prefix: string) {
  return tags
    ?.find((tag) => tag.toLowerCase().startsWith(`${prefix.toLowerCase()}:`))
    ?.slice(prefix.length + 1)
    .trim();
}

function normalizeSummary(
  item: CampaignTemplateSummary,
): CampaignTemplateSummary {
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const normalized = {
    ...item,
    tags,
    preview_assets: Array.isArray(item.preview_assets)
      ? item.preview_assets
      : [],
    style: item.style || readTagValue(tags, "style"),
    industry: item.industry || readTagValue(tags, "industry"),
    layout_archetype:
      item.layout_archetype ||
      item.layout ||
      readTagValue(tags, "layout") ||
      readTagValue(tags, "layout_archetype"),
    source:
      item.source ||
      (item.source_provider
        ? item.source_provider
        : item.tenant_id
          ? "team"
          : "platform"),
    provider: item.provider || item.source_provider || item.source_brand,
  };
  if (normalized.template_kind === "reference") {
    // Defense in depth for rolling/mixed-version deployments: reference
    // source is an internal adaptation input, never a browser payload.
    delete (normalized as CampaignTemplate).body_html;
    delete (normalized as CampaignTemplate).body_mjml;
  }
  return normalized;
}

export function normalizeCampaignTemplateSearchResponse(
  raw:
    | CampaignTemplateSearchResponse
    | CampaignTemplateSummary[]
    | { data?: CampaignTemplateSearchResponse | CampaignTemplateSummary[] },
): CampaignTemplateSearchResponse {
  let value: CampaignTemplateSearchResponse | CampaignTemplateSummary[];
  if (Array.isArray(raw)) {
    value = raw;
  } else if ("data" in raw) {
    value = raw.data ?? [];
  } else {
    value = raw as CampaignTemplateSearchResponse;
  }
  if (Array.isArray(value)) {
    const items = value.map(normalizeSummary);
    return { items, next_cursor: null, total: items.length, facets: {} };
  }
  return {
    items: (Array.isArray(value.items) ? value.items : []).map(normalizeSummary),
    next_cursor: value.next_cursor ?? null,
    ...(typeof value.page === "number" ? { page: value.page } : {}),
    ...(typeof value.per_page === "number" ? { per_page: value.per_page } : {}),
    total: Number.isFinite(value.total)
      ? value.total
      : (value.items?.length ?? 0),
    facets: value.facets ?? {},
  };
}

export function facetOptions(
  facet: CampaignTemplateFacet | undefined,
): string[] {
  if (!facet) return [];
  const values = Array.isArray(facet)
    ? facet.map((entry) =>
        typeof entry === "string" ? entry : String(entry.value ?? ""),
      )
    : Object.keys(facet);
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b));
}

export function buildCampaignTemplateSearchPath(
  input: CampaignTemplateSearchInput = {},
): string {
  const query = new URLSearchParams();
  const entries: Array<[string, string | undefined]> = [
    ["q", input.q?.trim() || undefined],
    ["goal", input.goal || undefined],
    ["category", input.category || undefined],
    [
      "source",
      input.source && input.source !== "all" ? input.source : undefined,
    ],
    ["provider", input.provider || undefined],
    ["style", input.style || undefined],
    ["layout", input.layout || undefined],
    ["industry", input.industry || undefined],
    ["kind", input.kind || undefined],
    ["archived", input.archived || undefined],
    ["cursor", input.cursor || undefined],
  ];
  for (const [key, value] of entries) {
    if (value) query.set(key, value);
  }
  if (input.tags) {
    const tags = Array.isArray(input.tags) ? input.tags.join(",") : input.tags;
    if (tags.trim()) query.set("tags", tags.trim());
  }
  // `featured=false` is an actual catalog predicate (only non-featured
  // templates), while omission means either. Preserve that three-state
  // contract instead of collapsing explicit false into the default.
  if (input.featured !== undefined) {
    query.set("featured", String(input.featured));
  }
  if (input.favorited) query.set("favorited", "true");
  if (input.sort) query.set("sort", input.sort);
  if (input.page && input.page > 0) query.set("page", String(input.page));
  query.set(
    "per_page",
    String(Math.min(100, Math.max(1, input.perPage ?? 24))),
  );
  return `/api/v1/campaign-templates/search?${query.toString()}`;
}

type CampaignTemplatePreviewCandidate = Pick<
  CampaignTemplateSummary,
  "id" | "thumbnail_url" | "preview_assets"
>;

const HOSTED_PREVIEW_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function configuredHostedPreviewBase(): URL | null {
  const raw = process.env.NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const value = new URL(raw);
    const localHTTP =
      process.env.NODE_ENV !== "production" &&
      value.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(value.hostname);
    if (
      (value.protocol !== "https:" && !localHTTP) ||
      value.username ||
      value.password ||
      value.search ||
      value.hash
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

// WEBASSET-01: a preview URL may carry CDN resize/format directives, and only
// those. The gallery renders these captures into ~250px cards, so the API (or a
// future image proxy) has to be able to hand back a card-sized rendition — an
// unconditional "search must be empty" rule made that structurally impossible.
// Keys are matched exactly and each value must be a short bare token, so
// nothing here can smuggle a path, a second origin, or a control character.
const HOSTED_PREVIEW_QUERY_KEYS = new Set(["dpr", "fit", "fm", "h", "q", "w"]);
const HOSTED_PREVIEW_QUERY_VALUE_RE = /^[A-Za-z0-9._-]{1,16}$/;

function hostedPreviewQueryAllowed(search: string): boolean {
  if (!search) return true;
  let count = 0;
  for (const [key, value] of new URLSearchParams(search)) {
    count += 1;
    if (count > HOSTED_PREVIEW_QUERY_KEYS.size) return false;
    if (!HOSTED_PREVIEW_QUERY_KEYS.has(key)) return false;
    if (!HOSTED_PREVIEW_QUERY_VALUE_RE.test(value)) return false;
  }
  return true;
}

function trustedHostedPreviewURL(raw: string): string | undefined {
  const configured = configuredHostedPreviewBase();
  const candidate = raw.trim();
  if (!configured || !candidate || /[\u0000-\u001f\u007f]/.test(candidate)) {
    return undefined;
  }
  try {
    const value = new URL(candidate);
    if (
      value.origin !== configured.origin ||
      value.protocol !== configured.protocol ||
      value.username ||
      value.password ||
      value.hash ||
      !hostedPreviewQueryAllowed(value.search)
    ) {
      return undefined;
    }
    const basePath = configured.pathname.replace(/\/+$/, "");
    if (
      basePath &&
      basePath !== "/" &&
      value.pathname !== basePath &&
      !value.pathname.startsWith(`${basePath}/`)
    ) {
      return undefined;
    }
    for (const segment of value.pathname.split("/")) {
      if (decodeURIComponent(segment) === "..") return undefined;
    }
    return value.toString();
  } catch {
    return undefined;
  }
}

export function campaignTemplatePreviewUrl(
  template: CampaignTemplatePreviewCandidate,
  preferredVariants: readonly CampaignTemplatePreviewAsset["variant"][] = [
    "desktop",
    "card",
    "mobile",
  ],
): string | undefined {
  const assets = campaignTemplateHostedPreviewAssets(template);
  for (const variant of preferredVariants) {
    const asset = assets.find((candidate) => candidate.variant === variant);
    if (asset) return asset.url;
  }

  return undefined;
}

export function campaignTemplateHostedPreviewAssets(
  template: CampaignTemplatePreviewCandidate,
): CampaignTemplateHostedPreview[] {
  const assets = Array.isArray(template.preview_assets)
    ? template.preview_assets
    : [];
  const result: CampaignTemplateHostedPreview[] = [];
  for (const variant of ["desktop", "card", "mobile"] as const) {
    const asset = assets.find(
      (candidate) =>
        candidate.variant === variant &&
        (candidate.status === "ready" ||
          candidate.status === "source_missing") &&
        HOSTED_PREVIEW_MIME_TYPES.has(candidate.mime_type) &&
        Number.isFinite(candidate.width) &&
        candidate.width > 0 &&
        Number.isFinite(candidate.height) &&
        candidate.height > 0 &&
        Number.isFinite(candidate.size_bytes) &&
        candidate.size_bytes > 0,
    );
    if (!asset) continue;
    const url = trustedHostedPreviewURL(asset.url);
    if (!url) continue;
    result.push({
      variant,
      url,
      width: asset.width,
      height: asset.height,
      size_bytes: asset.size_bytes,
      status: asset.status,
    });
  }

  // Backward compatibility for older API releases: a legacy thumbnail may be
  // displayed only as a card/desktop-like capture and only when it already
  // lives under the configured Moosewave asset base. It must never masquerade
  // as an independently captured mobile preview.
  if (!result.length && template.thumbnail_url) {
    const url = trustedHostedPreviewURL(template.thumbnail_url);
    if (url) result.push({ variant: "card", url, legacy: true });
  }
  return result;
}

/**
 * Variant order for the ~250px gallery/picker cards, smallest capture first.
 *
 * WEBASSET-01: the previous order fell back to "desktop" — the widest capture
 * the server will accept (up to 16384px / 10 MiB) — before "mobile", so a
 * template without a purpose-built card rendition shipped a full-width desktop
 * screenshot into a 4/5 card. A mobile capture is both a fraction of the bytes
 * and a better fit for a portrait card.
 */
const THUMBNAIL_VARIANT_ORDER = ["card", "mobile", "desktop"] as const;

export function campaignTemplateThumbnailUrl(
  template: CampaignTemplatePreviewCandidate,
): string | undefined {
  return campaignTemplatePreviewUrl(template, THUMBNAIL_VARIANT_ORDER);
}

/** Everything an <img> needs to render a card thumbnail responsively. */
export interface CampaignTemplateThumbnailSource {
  src: string;
  /** Intrinsic size of `src`, when the API declared one (absent for legacy). */
  width?: number;
  height?: number;
  /** `w`-descriptor candidates across the available variants, or undefined
   *  when fewer than two variants carry an intrinsic width. */
  srcSet?: string;
}

/**
 * Card thumbnail with its intrinsic dimensions and, when more than one hosted
 * variant exists, a `w`-descriptor srcSet so the browser can pick the smallest
 * rendition that covers the card rather than always downloading the first URL.
 *
 * Returns undefined on the same conditions as campaignTemplateThumbnailUrl, so
 * a caller can swap one for the other without changing its fallback branch.
 */
export function campaignTemplateThumbnailSource(
  template: CampaignTemplatePreviewCandidate,
): CampaignTemplateThumbnailSource | undefined {
  const assets = campaignTemplateHostedPreviewAssets(template);
  if (!assets.length) return undefined;
  let chosen: CampaignTemplateHostedPreview | undefined;
  for (const variant of THUMBNAIL_VARIANT_ORDER) {
    chosen = assets.find((asset) => asset.variant === variant);
    if (chosen) break;
  }
  if (!chosen) return undefined;

  // One candidate per distinct intrinsic width; duplicates would make the
  // descriptor list ambiguous and the browser's choice arbitrary.
  const byWidth = new Map<number, string>();
  for (const asset of assets) {
    if (!asset.width || !Number.isFinite(asset.width)) continue;
    if (!byWidth.has(asset.width)) byWidth.set(asset.width, asset.url);
  }
  const srcSet =
    byWidth.size > 1
      ? Array.from(byWidth.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([width, url]) => `${url} ${width}w`)
          .join(", ")
      : undefined;

  return {
    src: chosen.url,
    ...(chosen.width ? { width: chosen.width } : {}),
    ...(chosen.height ? { height: chosen.height } : {}),
    ...(srcSet ? { srcSet } : {}),
  };
}

export async function searchCampaignTemplates(
  input: CampaignTemplateSearchInput = {},
  options: CampaignTemplateRequestOptions = {},
): Promise<CampaignTemplateSearchResponse> {
  const raw = await api.get<
    CampaignTemplateSearchResponse | CampaignTemplateSummary[]
  >(buildCampaignTemplateSearchPath(input), { signal: options.signal });
  return normalizeCampaignTemplateSearchResponse(raw);
}

// FLOW-009: flat id+name list for the flow entity picker (template_id field).
// Reuses the existing search surface (first page, up to 100) rather than a new
// endpoint — the picker keeps unknown/legacy ids selectable regardless.
export async function listTemplates(): Promise<
  Array<{ id: string; name: string }>
> {
  const res = await searchCampaignTemplates({ perPage: 100 });
  return res.items.map((t) => ({ id: t.id, name: t.name }));
}

export async function getCampaignTemplate(
  id: string,
  options: CampaignTemplateRequestOptions = {},
): Promise<CampaignTemplate> {
  const template = await api.get<CampaignTemplate>(
    `/api/v1/campaign-templates/${encodeURIComponent(id)}`,
    { signal: options.signal },
  );
  const normalized = normalizeSummary(template) as CampaignTemplate;
  normalized.license_status =
    normalized.license_status || normalized.source_license_status;
  normalized.provenance =
    normalized.provenance ||
    (normalized.source_metadata ||
    normalized.source_url ||
    normalized.source_brand
      ? {
          ...(normalized.source_metadata ?? {}),
          source_url: normalized.source_url,
          source_name: normalized.source_brand,
        }
      : undefined);
  return normalized;
}

export interface CampaignTemplateRecentView {
  template: CampaignTemplateSummary;
  view_count: number;
  first_viewed_at: string;
  last_viewed_at: string;
}

export interface CampaignTemplateCompareItem {
  requested_identifier: string;
  matched_by: "id" | "slug";
  template: CampaignTemplateSummary;
}

export interface CampaignTemplateCompareResponse {
  items: CampaignTemplateCompareItem[];
  unavailable_identifiers: string[];
}

export interface CampaignTemplateCollection {
  id: string;
  name: string;
  description: string;
  template_ids: string[];
  items?: CampaignTemplateSummary[];
  item_count: number;
  created_at: string;
  updated_at: string;
  version: number;
  etag: string;
}

export interface CreateCampaignTemplateCollectionInput {
  name: string;
  description?: string;
  template_ids?: string[];
}

export interface UpdateCampaignTemplateCollectionInput {
  name?: string;
  description?: string;
}

export interface CampaignTemplateSavedSearchFilters {
  q?: string;
  goal?: string;
  category?: string;
  source?: string;
  provider?: string;
  industry?: string;
  style?: string;
  layout?: string;
  kind?: "editable" | "reference";
  tags?: string[];
  featured?: boolean;
  favorited?: boolean;
  archived?: "active" | "archived" | "all";
  sort?: CampaignTemplateSortKey;
}

export interface CampaignTemplateSavedSearchObsoleteFilter {
  field: string;
  value: string;
}

export interface CampaignTemplateSavedSearch {
  id: string;
  name: string;
  filters: CampaignTemplateSavedSearchFilters;
  /** Exact persisted values the server can no longer resolve. */
  obsolete_filters?: CampaignTemplateSavedSearchObsoleteFilter[];
  created_at: string;
  updated_at: string;
  version: number;
  etag: string;
}

export interface CreateCampaignTemplateSavedSearchInput {
  name: string;
  filters: CampaignTemplateSavedSearchFilters;
}

export interface UpdateCampaignTemplateSavedSearchInput {
  name?: string;
  filters?: CampaignTemplateSavedSearchFilters;
}

export interface CampaignTemplateDiscoveryCreateOptions extends CampaignTemplateRequestOptions {
  /**
   * Stable caller-owned key. The caller must keep and reuse this exact value
   * while recovering an ambiguous create; this client never silently replaces
   * it with a fresh key.
   */
  idempotencyKey: string;
}

export interface CampaignTemplateDiscoveryWriteOptions extends CampaignTemplateRequestOptions {
  ifMatch: string;
}

export interface CampaignTemplatePersonalStateDeleteResponse {
  ok: true;
  deleted: boolean;
}

export interface CampaignTemplateClearRecentResponse {
  ok: true;
  cleared: number;
}

const DISCOVERY_ETAG_RESOURCES = {
  collection: "campaign-template-collection",
  savedSearch: "campaign-template-saved-search",
} as const;

type CampaignTemplateDiscoveryETagResource =
  (typeof DISCOVERY_ETAG_RESOURCES)[keyof typeof DISCOVERY_ETAG_RESOURCES];

function requireCampaignTemplateDiscoveryIdempotencyKey(key: string): string {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(key) ||
    new TextEncoder().encode(key).byteLength > 255
  ) {
    throw new Error(
      "A stable Idempotency-Key of 1–255 UTF-8 bytes is required.",
    );
  }
  return key;
}

function requireCampaignTemplateDiscoveryETag(
  resource: CampaignTemplateDiscoveryETagResource,
  id: string,
  version: number,
  ifMatch: string,
): string {
  const expected = `"${resource}:${id}:v${version}"`;
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof ifMatch !== "string" ||
    ifMatch !== expected
  ) {
    throw new Error(
      "This personal library item changed. Reload it before saving again.",
    );
  }
  return ifMatch;
}

function normalizeCampaignTemplateCollection(
  collection: CampaignTemplateCollection,
): CampaignTemplateCollection {
  const normalized = {
    ...collection,
    template_ids: Array.isArray(collection.template_ids)
      ? collection.template_ids
      : [],
    items: Array.isArray(collection.items)
      ? collection.items.map(normalizeSummary)
      : undefined,
  };
  requireCampaignTemplateDiscoveryETag(
    DISCOVERY_ETAG_RESOURCES.collection,
    normalized.id,
    normalized.version,
    normalized.etag,
  );
  return normalized;
}

function normalizeCampaignTemplateSavedSearch(
  savedSearch: CampaignTemplateSavedSearch,
): CampaignTemplateSavedSearch {
  const normalized = {
    ...savedSearch,
    filters: {
      ...(savedSearch.filters ?? {}),
      ...(Array.isArray(savedSearch.filters?.tags)
        ? { tags: savedSearch.filters.tags }
        : {}),
    },
    obsolete_filters: Array.isArray(savedSearch.obsolete_filters)
      ? savedSearch.obsolete_filters
      : [],
  };
  requireCampaignTemplateDiscoveryETag(
    DISCOVERY_ETAG_RESOURCES.savedSearch,
    normalized.id,
    normalized.version,
    normalized.etag,
  );
  return normalized;
}

function discoveryWriteRequestOptions(
  resource: CampaignTemplateDiscoveryETagResource,
  id: string,
  version: number,
  options: CampaignTemplateDiscoveryWriteOptions,
) {
  return {
    headers: {
      "If-Match": requireCampaignTemplateDiscoveryETag(
        resource,
        id,
        version,
        options.ifMatch,
      ),
    },
    signal: options.signal,
    maxAttempts: 1,
    requireOnline: true,
  };
}

export function campaignTemplateDiscoveryIdempotencyKey(
  operation: "collection" | "saved-search",
): string {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `web-campaign-template-${operation}:${random}`;
}

export async function recordCampaignTemplateView(
  id: string,
  options: CampaignTemplateRequestOptions = {},
): Promise<CampaignTemplateRecentView> {
  const view = await api.post<CampaignTemplateRecentView>(
    `/api/v1/campaign-templates/${encodeURIComponent(id)}/view`,
    {},
    {
      signal: options.signal,
      maxAttempts: 1,
      requireOnline: true,
    },
  );
  return { ...view, template: normalizeSummary(view.template) };
}

export async function listRecentCampaignTemplateViews(
  limit = 24,
  options: CampaignTemplateRequestOptions = {},
): Promise<CampaignTemplateRecentView[]> {
  const response = await api.get<{ items: CampaignTemplateRecentView[] }>(
    "/api/v1/campaign-templates/recent",
    {
      query: {
        limit: Math.min(100, Math.max(1, Math.floor(limit))),
      },
      signal: options.signal,
    },
  );
  return (Array.isArray(response.items) ? response.items : []).map((view) => ({
    ...view,
    template: normalizeSummary(view.template),
  }));
}

export function clearRecentCampaignTemplateViews(
  id?: string,
  options: CampaignTemplateRequestOptions = {},
): Promise<CampaignTemplateClearRecentResponse> {
  return api.delete<CampaignTemplateClearRecentResponse>(
    id
      ? `/api/v1/campaign-templates/recent/${encodeURIComponent(id)}`
      : "/api/v1/campaign-templates/recent",
    {
      signal: options.signal,
      maxAttempts: 1,
      requireOnline: true,
    },
  );
}

export async function compareCampaignTemplates(
  identifiers: readonly string[],
  options: CampaignTemplateRequestOptions = {},
): Promise<CampaignTemplateCompareResponse> {
  const values = identifiers.map((value) => value.trim()).filter(Boolean);
  if (
    values.length < 2 ||
    values.length > 4 ||
    new Set(values.map((value) => value.toLocaleLowerCase())).size !==
      values.length
  ) {
    throw new Error("Choose 2–4 different templates to compare.");
  }
  const query = new URLSearchParams();
  values.forEach((value) => query.append("template", value));
  const response = await api.get<CampaignTemplateCompareResponse>(
    `/api/v1/campaign-templates/compare?${query.toString()}`,
    { signal: options.signal },
  );
  return {
    items: (Array.isArray(response.items) ? response.items : []).map((item) => ({
      ...item,
      template: normalizeSummary(item.template),
    })),
    unavailable_identifiers: Array.isArray(response.unavailable_identifiers)
      ? response.unavailable_identifiers
      : [],
  };
}

export async function listCampaignTemplateCollections(
  options: CampaignTemplateRequestOptions = {},
): Promise<CampaignTemplateCollection[]> {
  const response = await api.get<{ items: CampaignTemplateCollection[] }>(
    "/api/v1/campaign-template-collections",
    { signal: options.signal },
  );
  return (Array.isArray(response.items) ? response.items : []).map(normalizeCampaignTemplateCollection);
}

export async function getCampaignTemplateCollection(
  id: string,
  options: CampaignTemplateRequestOptions = {},
): Promise<CampaignTemplateCollection> {
  const collection = await api.get<CampaignTemplateCollection>(
    `/api/v1/campaign-template-collections/${encodeURIComponent(id)}`,
    { signal: options.signal },
  );
  return normalizeCampaignTemplateCollection(collection);
}

export async function createCampaignTemplateCollection(
  input: CreateCampaignTemplateCollectionInput,
  options: CampaignTemplateDiscoveryCreateOptions,
): Promise<CampaignTemplateCollection> {
  const collection = await api.post<CampaignTemplateCollection>(
    "/api/v1/campaign-template-collections",
    input,
    {
      headers: {
        "Idempotency-Key": requireCampaignTemplateDiscoveryIdempotencyKey(
          options.idempotencyKey,
        ),
      },
      signal: options.signal,
      maxAttempts: 1,
      requireOnline: true,
    },
  );
  return normalizeCampaignTemplateCollection(collection);
}

export async function updateCampaignTemplateCollection(
  collection: Pick<CampaignTemplateCollection, "id" | "version" | "etag">,
  input: UpdateCampaignTemplateCollectionInput,
  options: CampaignTemplateRequestOptions = {},
): Promise<CampaignTemplateCollection> {
  const updated = await api.patch<CampaignTemplateCollection>(
    `/api/v1/campaign-template-collections/${encodeURIComponent(collection.id)}`,
    input,
    discoveryWriteRequestOptions(
      DISCOVERY_ETAG_RESOURCES.collection,
      collection.id,
      collection.version,
      { ifMatch: collection.etag, signal: options.signal },
    ),
  );
  return normalizeCampaignTemplateCollection(updated);
}

export async function replaceCampaignTemplateCollectionItems(
  collection: Pick<CampaignTemplateCollection, "id" | "version" | "etag">,
  templateIds: readonly string[],
  options: CampaignTemplateRequestOptions = {},
): Promise<CampaignTemplateCollection> {
  const updated = await api.put<CampaignTemplateCollection>(
    `/api/v1/campaign-template-collections/${encodeURIComponent(collection.id)}/items`,
    { template_ids: [...templateIds] },
    discoveryWriteRequestOptions(
      DISCOVERY_ETAG_RESOURCES.collection,
      collection.id,
      collection.version,
      { ifMatch: collection.etag, signal: options.signal },
    ),
  );
  return normalizeCampaignTemplateCollection(updated);
}

export function deleteCampaignTemplateCollection(
  collection: Pick<CampaignTemplateCollection, "id" | "version" | "etag">,
  options: CampaignTemplateRequestOptions = {},
): Promise<CampaignTemplatePersonalStateDeleteResponse> {
  return api.delete<CampaignTemplatePersonalStateDeleteResponse>(
    `/api/v1/campaign-template-collections/${encodeURIComponent(collection.id)}`,
    discoveryWriteRequestOptions(
      DISCOVERY_ETAG_RESOURCES.collection,
      collection.id,
      collection.version,
      { ifMatch: collection.etag, signal: options.signal },
    ),
  );
}

export async function listCampaignTemplateSavedSearches(
  options: CampaignTemplateRequestOptions = {},
): Promise<CampaignTemplateSavedSearch[]> {
  const response = await api.get<{ items: CampaignTemplateSavedSearch[] }>(
    "/api/v1/campaign-template-saved-searches",
    { signal: options.signal },
  );
  return (Array.isArray(response.items) ? response.items : []).map(normalizeCampaignTemplateSavedSearch);
}

export async function getCampaignTemplateSavedSearch(
  id: string,
  options: CampaignTemplateRequestOptions = {},
): Promise<CampaignTemplateSavedSearch> {
  const savedSearch = await api.get<CampaignTemplateSavedSearch>(
    `/api/v1/campaign-template-saved-searches/${encodeURIComponent(id)}`,
    { signal: options.signal },
  );
  return normalizeCampaignTemplateSavedSearch(savedSearch);
}

export async function createCampaignTemplateSavedSearch(
  input: CreateCampaignTemplateSavedSearchInput,
  options: CampaignTemplateDiscoveryCreateOptions,
): Promise<CampaignTemplateSavedSearch> {
  const savedSearch = await api.post<CampaignTemplateSavedSearch>(
    "/api/v1/campaign-template-saved-searches",
    input,
    {
      headers: {
        "Idempotency-Key": requireCampaignTemplateDiscoveryIdempotencyKey(
          options.idempotencyKey,
        ),
      },
      signal: options.signal,
      maxAttempts: 1,
      requireOnline: true,
    },
  );
  return normalizeCampaignTemplateSavedSearch(savedSearch);
}

export async function updateCampaignTemplateSavedSearch(
  savedSearch: Pick<CampaignTemplateSavedSearch, "id" | "version" | "etag">,
  input: UpdateCampaignTemplateSavedSearchInput,
  options: CampaignTemplateRequestOptions = {},
): Promise<CampaignTemplateSavedSearch> {
  const updated = await api.patch<CampaignTemplateSavedSearch>(
    `/api/v1/campaign-template-saved-searches/${encodeURIComponent(savedSearch.id)}`,
    input,
    discoveryWriteRequestOptions(
      DISCOVERY_ETAG_RESOURCES.savedSearch,
      savedSearch.id,
      savedSearch.version,
      { ifMatch: savedSearch.etag, signal: options.signal },
    ),
  );
  return normalizeCampaignTemplateSavedSearch(updated);
}

export function deleteCampaignTemplateSavedSearch(
  savedSearch: Pick<CampaignTemplateSavedSearch, "id" | "version" | "etag">,
  options: CampaignTemplateRequestOptions = {},
): Promise<CampaignTemplatePersonalStateDeleteResponse> {
  return api.delete<CampaignTemplatePersonalStateDeleteResponse>(
    `/api/v1/campaign-template-saved-searches/${encodeURIComponent(savedSearch.id)}`,
    discoveryWriteRequestOptions(
      DISCOVERY_ETAG_RESOURCES.savedSearch,
      savedSearch.id,
      savedSearch.version,
      { ifMatch: savedSearch.etag, signal: options.signal },
    ),
  );
}

export async function runCampaignTemplateSavedSearch(
  id: string,
  input: { cursor?: string; perPage?: number } = {},
  options: CampaignTemplateRequestOptions = {},
): Promise<CampaignTemplateSearchResponse> {
  const response = await api.get<CampaignTemplateSearchResponse>(
    `/api/v1/campaign-template-saved-searches/${encodeURIComponent(id)}/results`,
    {
      query: {
        cursor: input.cursor,
        per_page: Math.min(100, Math.max(1, input.perPage ?? 24)),
      },
      signal: options.signal,
    },
  );
  return normalizeCampaignTemplateSearchResponse(response);
}

// FLOW-029: a flow (journey) that references this template.
export interface TemplateFlowUsage {
  id: string;
  name: string;
  status?: string;
}

export function getCampaignTemplateFlowUsage(
  id: string,
): Promise<TemplateFlowUsage[]> {
  return api
    .get<{
      items: TemplateFlowUsage[];
    }>(`/api/v1/campaign-templates/${encodeURIComponent(id)}/flow-usage`)
    .then((r) => Array.isArray(r.items) ? r.items : []);
}

export async function adaptCampaignTemplate(
  id: string,
  input: AdaptCampaignTemplateInput,
  options: CampaignTemplateDesignMutationOptions = {},
): Promise<CampaignTemplateDesignDraft> {
  return createCampaignTemplateDesign(
    {
      ...input,
      mode: "adapt",
      source_template_id: id,
    },
    options,
  );
}

export async function generateCampaignTemplate(
  input: GenerateCampaignTemplateInput,
  options: CampaignTemplateDesignMutationOptions = {},
): Promise<CampaignTemplateDesignDraft> {
  return createCampaignTemplateDesign({ ...input, mode: "generate" }, options);
}

export function campaignTemplateDesignIdempotencyKey(
  operation: string,
): string {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `web-campaign-template-design:${operation}:${random}`;
}

function designMutationOptions(
  operation: string,
  options: CampaignTemplateDesignMutationOptions,
) {
  return {
    headers: {
      "Idempotency-Key":
        options.idempotencyKey ??
        campaignTemplateDesignIdempotencyKey(operation),
    },
    signal: options.signal,
    timeoutMs: 30_000,
    maxAttempts: 1,
    requireOnline: true,
  };
}

export function createCampaignTemplateDesign(
  input: CreateCampaignTemplateDesignInput,
  options: CampaignTemplateDesignMutationOptions = {},
): Promise<CampaignTemplateDesignDraft> {
  return api.post<CampaignTemplateDesignDraft>(
    "/api/v1/campaign-template-designs",
    input,
    designMutationOptions("create", options),
  );
}

export function listCampaignTemplateDesigns(
  input: { limit?: number; cursor?: string } = {},
  options: CampaignTemplateRequestOptions = {},
): Promise<CampaignTemplateDesignSummaryPage> {
  return api.get<CampaignTemplateDesignSummaryPage>(
    "/api/v1/campaign-template-designs",
    {
      query: {
        limit: Math.min(50, Math.max(1, input.limit ?? 20)),
        cursor: input.cursor,
      },
      signal: options.signal,
      timeoutMs: 20_000,
      maxAttempts: 1,
      requireOnline: true,
    },
  );
}

export async function getCampaignTemplateDesign(
  id: string,
  options: {
    signal?: AbortSignal;
    onRetryAfter?: (seconds: number | undefined) => void;
  } = {},
): Promise<CampaignTemplateDesignDraft> {
  let retryAfter: number | undefined;
  const draft = await api.get<CampaignTemplateDesignDraft>(
    `/api/v1/campaign-template-designs/${encodeURIComponent(id)}`,
    {
      signal: options.signal,
      timeoutMs: 20_000,
      maxAttempts: 1,
      requireOnline: true,
      onResponse: (response) => {
        retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      },
    },
  );
  options.onRetryAfter?.(retryAfter);
  return draft;
}

export function listCampaignTemplateDesignRevisions(
  id: string,
  signal?: AbortSignal,
): Promise<{ items: CampaignTemplateDesignRevision[] }> {
  return api.get<{ items: CampaignTemplateDesignRevision[] }>(
    `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/revisions`,
    {
      signal,
      maxAttempts: 1,
      requireOnline: true,
    },
  );
}

export function refineCampaignTemplateDesign(
  id: string,
  input: RefineCampaignTemplateDesignInput,
  options: CampaignTemplateDesignMutationOptions = {},
): Promise<CampaignTemplateDesignDraft> {
  return api.post<CampaignTemplateDesignDraft>(
    `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/refine`,
    input,
    designMutationOptions(`refine:${input.base_revision}`, options),
  );
}

export function retryCampaignTemplateDesign(
  id: string,
  options: CampaignTemplateDesignMutationOptions = {},
): Promise<CampaignTemplateDesignDraft> {
  return api.post<CampaignTemplateDesignDraft>(
    `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/retry`,
    {},
    designMutationOptions("retry", options),
  );
}

export function saveCampaignTemplateDesign(
  id: string,
  input: SaveCampaignTemplateDesignInput,
  options: CampaignTemplateDesignMutationOptions = {},
): Promise<CampaignTemplate> {
  return api.post<CampaignTemplate>(
    `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/save`,
    input,
    designMutationOptions(
      `save:${input.revision}:${input.output_hash}`,
      options,
    ),
  );
}

/**
 * A draft made from a template, with the merge tags in it that nothing
 * filled: content the template has no value for (a link), workspace details
 * the workspace has not set (a reply-to address). The author must fill each
 * before sending.
 */
export type CampaignFromTemplate = Campaign & {
  unresolved_variables?: string[];
};

export async function createCampaignFromTemplate(
  input: CreateCampaignFromTemplateInput,
): Promise<CampaignFromTemplate> {
  return api.post<CampaignFromTemplate>(
    "/api/v1/campaigns/from-template",
    input,
    { requireOnline: true },
  );
}

export function createCampaignFromTemplateDesign(
  id: string,
  input: CreateCampaignFromDesignInput,
  options: CampaignTemplateDesignMutationOptions = {},
): Promise<Campaign> {
  return api.post<Campaign>(
    `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/create-campaign`,
    input,
    designMutationOptions(
      `create-campaign:${input.revision}:${input.output_hash}`,
      options,
    ),
  );
}

export function archiveCampaignTemplateDesign(
  id: string,
  options: CampaignTemplateDesignRequiredMutationOptions,
): Promise<CampaignTemplateDesignDraft> {
  return api.post<CampaignTemplateDesignDraft>(
    `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/archive`,
    {},
    designMutationOptions("archive", {
      ...options,
      idempotencyKey: requireCampaignTemplateDiscoveryIdempotencyKey(
        options.idempotencyKey,
      ),
    }),
  );
}

export async function waitForCampaignTemplateDesign(
  id: string,
  options: WaitForCampaignTemplateDesignOptions = {},
): Promise<CampaignTemplateDesignDraft> {
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 180_000);
  const initialPollMs = Math.max(250, options.initialPollMs ?? 750);
  const maxPollMs = Math.max(initialPollMs, options.maxPollMs ?? 10_000);
  const startedAt = Date.now();
  let attempt = 0;

  for (;;) {
    let headerRetryAfter: number | undefined;
    const draft = await getCampaignTemplateDesign(id, {
      signal: options.signal,
      onRetryAfter: (seconds) => {
        headerRetryAfter = seconds;
      },
    });
    options.onUpdate?.(draft);
    if (draft.status !== "queued" && draft.status !== "generating") {
      return draft;
    }
    if (Date.parse(draft.expires_at) <= Date.now()) {
      throw new CampaignTemplateDesignWaitError("design_expired", draft);
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new CampaignTemplateDesignWaitError("design_poll_timeout", draft);
    }
    const exponential = Math.min(maxPollMs, initialPollMs * 2 ** attempt);
    const serverDelay =
      Math.max(headerRetryAfter ?? 0, draft.retry_after_seconds ?? 0) * 1_000;
    const remaining = timeoutMs - (Date.now() - startedAt);
    await waitForCampaignTemplateDesignDelay(
      Math.min(Math.max(exponential, serverDelay), Math.max(1, remaining)),
      options.signal,
    );
    if (Date.now() - startedAt >= timeoutMs) {
      throw new CampaignTemplateDesignWaitError("design_poll_timeout", draft);
    }
    attempt += 1;
  }
}

function waitForCampaignTemplateDesignDelay(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function favoriteCampaignTemplate(id: string, favorited: boolean) {
  return api.post<{ ok: boolean; favorited: boolean }>(
    `/api/v1/campaign-templates/${encodeURIComponent(id)}/${favorited ? "favorite" : "unfavorite"}`,
    {},
  );
}

export function cloneCampaignTemplate(id: string, name?: string) {
  return api.post<CampaignTemplate>(
    `/api/v1/campaign-templates/${encodeURIComponent(id)}/clone`,
    name ? { name } : {},
  );
}

/**
 * A template the workspace owns (has a tenant id / source mine|team) and can
 * therefore rename, edit, duplicate, or delete. Platform-catalog and ingested
 * reference designs have no tenant id and are read-only to the tenant — the
 * backend Update/Delete are tenant-scoped and won't touch tenant_id IS NULL
 * rows, so we gate the UI to match rather than surface actions that 404.
 */
export function isOwnedCampaignTemplate(
  template: Pick<CampaignTemplateSummary, "tenant_id" | "source">,
): boolean {
  if (template.tenant_id) return true;
  return template.source === "mine" || template.source === "team";
}

/**
 * Derive an API-valid slug from a template name: lowercase, non-alphanumerics
 * collapsed to single dashes, trimmed, forced to start with a letter, and
 * bounded to the server's 80-char limit (`^[a-z][a-z0-9-]{0,79}$`). Falls back
 * to a stable "template" stem when the name has no usable letters.
 */
export function templateSlugFromName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const withLetter = /^[a-z]/.test(base) ? base : `template-${base}`;
  const cleaned = withLetter.replace(/^-+|-+$/g, "").slice(0, 80);
  return cleaned || "template";
}

export interface CreateCampaignTemplateInput {
  slug: string;
  name: string;
  subject: string;
  description?: string;
  category?: string;
  preview_text?: string;
  body_html?: string;
  body_mjml?: string;
  variables?: Array<Record<string, unknown>>;
  tags?: string[];
  goal?: string;
  industry?: string;
  style?: string;
  layout?: string;
  thumbnail_url?: string;
  design_metadata?: Record<string, unknown>;
}

/**
 * PATCH body for a template. Every field is optional and the backend treats a
 * PRESENT `body_html`/`body_mjml`/`variables` as a FULL REPLACE (an omitted
 * field is left untouched). Callers editing content MUST send the complete body
 * — never a partial that drops blocks — while a rename sends only `name`.
 */
export interface UpdateCampaignTemplateInput {
  name?: string;
  description?: string;
  category?: string;
  subject?: string;
  preview_text?: string;
  body_html?: string;
  body_mjml?: string;
  variables?: Array<Record<string, unknown>>;
  tags?: string[];
  goal?: string;
  industry?: string;
  style?: string;
  layout?: string;
  thumbnail_url?: string;
  design_metadata?: Record<string, unknown>;
}

export interface CampaignTemplateRevisionSummary {
  version: number;
  etag: string;
  transition: "created" | "updated" | "archived" | "restored" | string;
  name: string;
  subject: string;
  archived_at?: string;
  snapshot_time: string;
  /** Who made the edit that produced this revision (TMPL-040); may be absent. */
  changed_by_email?: string;
}

export interface CampaignTemplateRevisionPage {
  items: CampaignTemplateRevisionSummary[];
  page: number;
  per_page: number;
  total: number;
}

export interface CampaignTemplateRevision {
  version: number;
  etag: string;
  transition: CampaignTemplateRevisionSummary["transition"];
  snapshot_time: string;
  snapshot: CampaignTemplate;
}

function requireStrongCampaignTemplateETag(ifMatch: string): string {
  const token = ifMatch.trim();
  if (
    token.length < 2 ||
    token === "*" ||
    token.startsWith("W/") ||
    token.includes(",") ||
    token[0] !== '"' ||
    token[token.length - 1] !== '"'
  ) {
    throw new Error(
      "A fresh template version is required. Reload the template and try again.",
    );
  }
  return token;
}

export function createCampaignTemplate(
  input: CreateCampaignTemplateInput,
): Promise<CampaignTemplate> {
  return api.post<CampaignTemplate>("/api/v1/campaign-templates", input, {
    requireOnline: true,
  });
}

export function updateCampaignTemplate(
  id: string,
  input: UpdateCampaignTemplateInput,
  ifMatch: string,
): Promise<CampaignTemplate> {
  return api.patch<CampaignTemplate>(
    `/api/v1/campaign-templates/${encodeURIComponent(id)}`,
    input,
    {
      headers: { "If-Match": requireStrongCampaignTemplateETag(ifMatch) },
      requireOnline: true,
    },
  );
}

export function archiveCampaignTemplate(
  id: string,
  ifMatch: string,
): Promise<CampaignTemplate> {
  return api.patch<CampaignTemplate>(
    `/api/v1/campaign-templates/${encodeURIComponent(id)}/archive`,
    undefined,
    {
      headers: { "If-Match": requireStrongCampaignTemplateETag(ifMatch) },
      requireOnline: true,
    },
  );
}

export function restoreCampaignTemplate(
  id: string,
  ifMatch: string,
): Promise<CampaignTemplate> {
  return api.patch<CampaignTemplate>(
    `/api/v1/campaign-templates/${encodeURIComponent(id)}/restore`,
    undefined,
    {
      headers: { "If-Match": requireStrongCampaignTemplateETag(ifMatch) },
      requireOnline: true,
    },
  );
}

/**
 * Backward-compatible safe-delete alias. The API never hard-deletes a
 * template: DELETE creates an immutable revision and archives the row.
 */
export function deleteCampaignTemplate(
  id: string,
  ifMatch: string,
): Promise<CampaignTemplate> {
  return api.delete<CampaignTemplate>(
    `/api/v1/campaign-templates/${encodeURIComponent(id)}`,
    {
      headers: { "If-Match": requireStrongCampaignTemplateETag(ifMatch) },
      requireOnline: true,
    },
  );
}

export function listCampaignTemplateRevisions(
  id: string,
  page = 1,
  perPage = 20,
): Promise<CampaignTemplateRevisionPage> {
  return api.get<CampaignTemplateRevisionPage>(
    `/api/v1/campaign-templates/${encodeURIComponent(id)}/revisions`,
    {
      query: {
        page: Math.max(1, Math.floor(page)),
        per_page: Math.min(50, Math.max(1, Math.floor(perPage))),
      },
    },
  );
}

export function getCampaignTemplateRevision(
  id: string,
  version: number,
): Promise<CampaignTemplateRevision> {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("Template revision must be a positive integer.");
  }
  return api.get<CampaignTemplateRevision>(
    `/api/v1/campaign-templates/${encodeURIComponent(id)}/revisions/${encodeURIComponent(String(version))}`,
  );
}

/**
 * Restore an earlier revision (TMPL-040). The restore is itself recorded as a
 * new version, so the current content is never lost.
 */
export function restoreCampaignTemplateRevision(
  id: string,
  version: number,
): Promise<CampaignTemplate> {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("Template revision must be a positive integer.");
  }
  return api.post<CampaignTemplate>(
    `/api/v1/campaign-templates/${encodeURIComponent(id)}/revisions/${encodeURIComponent(String(version))}/restore`,
    undefined,
    { requireOnline: true },
  );
}

export interface ImportCampaignTemplatesResult {
  items: CampaignTemplate[];
  created: number;
  updated: number;
  failed: number;
  errors: Array<{ index: number; code: string; message?: string }>;
}

/**
 * Import one hand-authored template from raw HTML (or MJML) source via the bulk
 * import endpoint. The workspace owns the result. Returns the created record on
 * success or throws with the first item error the server reported.
 */
export async function importCampaignTemplate(
  input: CreateCampaignTemplateInput,
): Promise<CampaignTemplate> {
  const result = await api.post<ImportCampaignTemplatesResult>(
    "/api/v1/campaign-templates/import",
    { items: [input] },
    { requireOnline: true },
  );
  if (result.items?.length) return result.items[0];
  const firstError = result.errors?.[0];
  throw new Error(
    firstError?.message ||
      firstError?.code ||
      "The template could not be imported.",
  );
}
