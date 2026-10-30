import { apiRequest } from "../api-client";
import type { CampaignTemplate, TemplateGoal } from "../api-client";
import { newUUIDv7 } from "../http-fetch";
import type { ApiErr, ApiResult } from "./result";

export interface CampaignTemplateRecentView {
  template: CampaignTemplate;
  view_count: number;
  first_viewed_at: string;
  last_viewed_at: string;
}

export interface CampaignTemplateCompareItem {
  requested_identifier: string;
  matched_by: "id" | "slug";
  template: CampaignTemplate;
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
  items?: CampaignTemplate[];
  item_count: number;
  created_at: string;
  updated_at: string;
  version: number;
  etag: string;
}

export type CampaignTemplateSavedSearchSource = "platform" | "team" | "mine";

export interface CampaignTemplateSavedSearchFilters {
  q?: string;
  goal?: TemplateGoal;
  category?: string;
  source?: CampaignTemplateSavedSearchSource;
  provider?: string;
  style?: string;
  layout?: string;
  industry?: string;
  kind?: "editable" | "reference";
  tags?: string[];
  featured?: boolean;
  favorited?: boolean;
  archived?: "active" | "archived" | "all";
  sort?: "recommended" | "name" | "most_used";
}

export interface CampaignTemplateSavedSearch {
  id: string;
  name: string;
  filters: CampaignTemplateSavedSearchFilters;
  created_at: string;
  updated_at: string;
  version: number;
  etag: string;
}

export interface CampaignTemplateSavedSearchResults {
  items: CampaignTemplate[];
  page: number;
  per_page: number;
  total: number;
  has_more?: boolean;
  next_cursor?: string;
}

export interface CreateCampaignTemplateCollectionInput {
  name: string;
  description?: string;
  template_ids?: string[];
}

export interface CreateCampaignTemplateSavedSearchInput {
  name: string;
  filters: CampaignTemplateSavedSearchFilters;
}

export interface DiscoveryMutationOptions {
  ifMatch: string;
}

export interface DiscoveryCreateOptions {
  /**
   * Caller-held request identity. Retain it for an ambiguous retry of the
   * exact same payload; generate a new key only after the payload changes.
   */
  idempotencyKey: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER_RE = /\p{Cc}/u;
const COLLECTION_ETAG_RE =
  /^"campaign-template-collection:([0-9a-f-]{36}):v([1-9]\d*)"$/i;
const SAVED_SEARCH_ETAG_RE =
  /^"campaign-template-saved-search:([0-9a-f-]{36}):v([1-9]\d*)"$/i;
const TEMPLATE_GOALS = new Set<TemplateGoal>([
  "welcome",
  "newsletter",
  "announcement",
  "promotional",
  "re_engagement",
  "transactional",
  "automation",
]);
const SAVED_SEARCH_SOURCES = new Set(["platform", "team", "mine"]);
const SAVED_SEARCH_KINDS = new Set(["editable", "reference"]);
const SAVED_SEARCH_ARCHIVE_STATES = new Set(["active", "archived", "all"]);
const SAVED_SEARCH_SORTS = new Set(["recommended", "name", "most_used"]);
const TEMPLATE_KINDS = new Set(["editable", "reference"]);
const REVIEW_STATES = new Set(["pending", "approved", "rejected"]);
const PREVIEW_VARIANTS = new Set(["desktop", "mobile", "card"]);
const PREVIEW_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const PREVIEW_STATUSES = new Set(["ready", "source_missing"]);
const CAPABILITY_KEYS = [
  "can_preview",
  "can_favorite",
  "can_adapt",
  "can_use_directly",
  "can_create_campaign",
  "can_edit_directly",
  "can_clone",
  "can_delete",
  "can_archive",
  "can_restore",
  "has_source_html",
  "has_source_mjml",
  "has_desktop_preview",
  "has_mobile_preview",
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(
  value: unknown,
  max = Number.POSITIVE_INFINITY,
): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    Array.from(value).length <= max
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function optionalTimestamp(value: unknown): boolean {
  return value === undefined || value === null || validTimestamp(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && Number(value) > 0;
}

function stringArray(value: unknown, max: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((item) => typeof item === "string")
  );
}

function uniqueStrings(values: string[]): boolean {
  return (
    new Set(values.map((value) => value.toLocaleLowerCase())).size ===
    values.length
  );
}

function invalidConfig(code: string, message: string): ApiErr {
  return {
    error: {
      kind: "invalid_config",
      code,
      message,
    },
    retryability: "not-retryable",
  };
}

function invalidResponse(resource: string): ApiErr {
  return {
    error: {
      kind: "parse",
      code: "invalid_campaign_template_discovery_response",
      message: `The server returned an invalid ${resource} response. Refresh before making another change.`,
    },
    retryability: "manual",
  };
}

function decodePreviewAssets(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      const asset = record(item);
      return Boolean(
        asset &&
        typeof asset.variant === "string" &&
        PREVIEW_VARIANTS.has(asset.variant) &&
        nonEmptyString(asset.url) &&
        typeof asset.mime_type === "string" &&
        PREVIEW_MIME_TYPES.has(asset.mime_type) &&
        positiveInteger(asset.width) &&
        positiveInteger(asset.height) &&
        positiveInteger(asset.size_bytes) &&
        typeof asset.status === "string" &&
        PREVIEW_STATUSES.has(asset.status),
      );
    })
  );
}

function decodeCapabilities(value: unknown): boolean {
  const capabilities = record(value);
  return Boolean(
    capabilities &&
    CAPABILITY_KEYS.every((key) => typeof capabilities[key] === "boolean"),
  );
}

function decodeWarnings(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      const warning = record(item);
      return Boolean(
        warning &&
        nonEmptyString(warning.code) &&
        nonEmptyString(warning.message) &&
        optionalString(warning.recommended_action),
      );
    })
  );
}

/**
 * Discovery endpoints return compact template summaries. This decoder keeps
 * those summaries fail-closed before they reach card, comparison, or detail UI.
 */
export function decodeCampaignTemplateDiscoveryTemplate(
  value: unknown,
): CampaignTemplate | null {
  const template = record(value);
  if (
    !template ||
    !nonEmptyString(template.id) ||
    !nonEmptyString(template.slug) ||
    !nonEmptyString(template.name) ||
    typeof template.subject !== "string"
  ) {
    return null;
  }
  for (const key of [
    "tenant_id",
    "description",
    "category",
    "preview_text",
    "body_html",
    "body_mjml",
    "source_provider",
    "source_external_id",
    "source_url",
    "source_brand",
    "thumbnail_url",
    "source_license_status",
    "industry",
    "style",
    "layout",
    "content_hash",
    "etag",
    "recommended_action",
  ] as const) {
    if (!optionalString(template[key])) return null;
  }
  for (const key of [
    "created_at",
    "updated_at",
    "last_used_at",
    "source_captured_at",
    "imported_at",
    "archived_at",
  ] as const) {
    if (!optionalTimestamp(template[key])) return null;
  }
  if (
    template.goal !== undefined &&
    template.goal !== "" &&
    (typeof template.goal !== "string" ||
      !TEMPLATE_GOALS.has(template.goal as TemplateGoal))
  ) {
    return null;
  }
  if (
    template.template_kind !== undefined &&
    (typeof template.template_kind !== "string" ||
      !TEMPLATE_KINDS.has(template.template_kind))
  ) {
    return null;
  }
  if (
    template.review_status !== undefined &&
    (typeof template.review_status !== "string" ||
      !REVIEW_STATES.has(template.review_status))
  ) {
    return null;
  }
  for (const key of ["is_featured", "is_favorited"] as const) {
    if (template[key] !== undefined && typeof template[key] !== "boolean") {
      return null;
    }
  }
  if (
    template.usage_count !== undefined &&
    !nonNegativeInteger(template.usage_count)
  ) {
    return null;
  }
  if (
    template.quality_score !== undefined &&
    (typeof template.quality_score !== "number" ||
      !Number.isFinite(template.quality_score) ||
      template.quality_score < 0 ||
      template.quality_score > 1)
  ) {
    return null;
  }
  if (template.version !== undefined && !positiveInteger(template.version)) {
    return null;
  }
  if (template.tags !== undefined && !stringArray(template.tags, 100)) {
    return null;
  }
  if (
    template.variables !== undefined &&
    (!Array.isArray(template.variables) ||
      !template.variables.every((item) => record(item) !== null))
  ) {
    return null;
  }
  if (
    template.reference_template_ids !== undefined &&
    (!stringArray(template.reference_template_ids, 3) ||
      !template.reference_template_ids.every((item) => item.trim() !== ""))
  ) {
    return null;
  }
  if (
    template.preview_assets !== undefined &&
    !decodePreviewAssets(template.preview_assets)
  ) {
    return null;
  }
  if (
    template.capabilities !== undefined &&
    !decodeCapabilities(template.capabilities)
  ) {
    return null;
  }
  if (template.warnings !== undefined && !decodeWarnings(template.warnings)) {
    return null;
  }
  for (const key of [
    "source_metadata",
    "design_metadata",
    "generation_metadata",
  ] as const) {
    if (
      template[key] !== undefined &&
      template[key] !== null &&
      record(template[key]) === null
    ) {
      return null;
    }
  }
  return template as unknown as CampaignTemplate;
}

export function decodeCampaignTemplateRecentView(
  value: unknown,
): CampaignTemplateRecentView | null {
  const recent = record(value);
  const template = recent
    ? decodeCampaignTemplateDiscoveryTemplate(recent.template)
    : null;
  if (
    !recent ||
    !template ||
    !positiveInteger(recent.view_count) ||
    !validTimestamp(recent.first_viewed_at) ||
    !validTimestamp(recent.last_viewed_at) ||
    Date.parse(recent.first_viewed_at) > Date.parse(recent.last_viewed_at)
  ) {
    return null;
  }
  return {
    template,
    view_count: recent.view_count,
    first_viewed_at: recent.first_viewed_at,
    last_viewed_at: recent.last_viewed_at,
  };
}

export function decodeCampaignTemplateCompareResponse(
  value: unknown,
): CampaignTemplateCompareResponse | null {
  const response = record(value);
  if (
    !response ||
    !Array.isArray(response.items) ||
    !Array.isArray(response.unavailable_identifiers) ||
    !stringArray(response.unavailable_identifiers, 4) ||
    !response.unavailable_identifiers.every(
      (identifier) =>
        identifier.trim() !== "" && Array.from(identifier).length <= 256,
    ) ||
    !uniqueStrings(response.unavailable_identifiers)
  ) {
    return null;
  }
  if (response.items.length > 4) return null;
  const items: CampaignTemplateCompareItem[] = [];
  for (const valueItem of response.items) {
    const item = record(valueItem);
    const template = item
      ? decodeCampaignTemplateDiscoveryTemplate(item.template)
      : null;
    if (
      !item ||
      !template ||
      !nonEmptyString(item.requested_identifier, 256) ||
      (item.matched_by !== "id" && item.matched_by !== "slug")
    ) {
      return null;
    }
    items.push({
      requested_identifier: item.requested_identifier,
      matched_by: item.matched_by,
      template,
    });
  }
  const availableIdentifiers = items.map((item) => item.requested_identifier);
  const allIdentifiers = [
    ...availableIdentifiers,
    ...response.unavailable_identifiers,
  ];
  return uniqueStrings(allIdentifiers) &&
    allIdentifiers.length >= 2 &&
    allIdentifiers.length <= 4
    ? {
        items,
        unavailable_identifiers: [...response.unavailable_identifiers],
      }
    : null;
}

export function isCampaignTemplateCollectionEtag(
  value: unknown,
  id?: string,
  version?: number,
): value is string {
  if (typeof value !== "string") return false;
  const match = COLLECTION_ETAG_RE.exec(value);
  if (!match || !UUID_RE.test(match[1] ?? "")) return false;
  if (id && (match[1] ?? "").toLocaleLowerCase() !== id.toLocaleLowerCase()) {
    return false;
  }
  return version === undefined || Number(match[2]) === version;
}

export function isCampaignTemplateSavedSearchEtag(
  value: unknown,
  id?: string,
  version?: number,
): value is string {
  if (typeof value !== "string") return false;
  const match = SAVED_SEARCH_ETAG_RE.exec(value);
  if (!match || !UUID_RE.test(match[1] ?? "")) return false;
  if (id && (match[1] ?? "").toLocaleLowerCase() !== id.toLocaleLowerCase()) {
    return false;
  }
  return version === undefined || Number(match[2]) === version;
}

export function decodeCampaignTemplateCollection(
  value: unknown,
): CampaignTemplateCollection | null {
  const collection = record(value);
  if (
    !collection ||
    !nonEmptyString(collection.id) ||
    !UUID_RE.test(collection.id) ||
    !nonEmptyString(collection.name, 120) ||
    typeof collection.description !== "string" ||
    Array.from(collection.description).length > 1_000 ||
    !stringArray(collection.template_ids, 100) ||
    !collection.template_ids.every((id) => UUID_RE.test(id)) ||
    !uniqueStrings(collection.template_ids) ||
    !nonNegativeInteger(collection.item_count) ||
    collection.item_count !== collection.template_ids.length ||
    !validTimestamp(collection.created_at) ||
    !validTimestamp(collection.updated_at) ||
    !positiveInteger(collection.version) ||
    !isCampaignTemplateCollectionEtag(
      collection.etag,
      collection.id,
      collection.version,
    )
  ) {
    return null;
  }
  const templateIds = collection.template_ids;
  let items: CampaignTemplate[] | undefined;
  if (collection.items !== undefined) {
    if (!Array.isArray(collection.items)) return null;
    items = [];
    for (const item of collection.items) {
      const template = decodeCampaignTemplateDiscoveryTemplate(item);
      if (!template) return null;
      items.push(template);
    }
    if (
      !uniqueStrings(items.map((item) => item.id)) ||
      items.some((item) => !templateIds.includes(item.id))
    ) {
      return null;
    }
  }
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description,
    template_ids: [...templateIds],
    ...(items ? { items } : {}),
    item_count: collection.item_count,
    created_at: collection.created_at,
    updated_at: collection.updated_at,
    version: collection.version,
    etag: collection.etag,
  };
}

export function decodeCampaignTemplateSavedSearchFilters(
  value: unknown,
): CampaignTemplateSavedSearchFilters | null {
  const filters = record(value);
  if (!filters) return null;
  const output: CampaignTemplateSavedSearchFilters = {};
  if (filters.q !== undefined) {
    if (typeof filters.q !== "string" || Array.from(filters.q).length > 500) {
      return null;
    }
    if (filters.q) output.q = filters.q;
  }
  if (filters.goal !== undefined && filters.goal !== "") {
    if (
      typeof filters.goal !== "string" ||
      !TEMPLATE_GOALS.has(filters.goal as TemplateGoal)
    ) {
      return null;
    }
    output.goal = filters.goal as TemplateGoal;
  }
  for (const key of [
    "category",
    "provider",
    "style",
    "layout",
    "industry",
  ] as const) {
    const candidate = filters[key];
    if (candidate !== undefined && candidate !== "") {
      if (typeof candidate !== "string" || Array.from(candidate).length > 100) {
        return null;
      }
      output[key] = candidate;
    }
  }
  if (filters.source !== undefined && filters.source !== "") {
    if (
      typeof filters.source !== "string" ||
      !SAVED_SEARCH_SOURCES.has(filters.source)
    ) {
      return null;
    }
    output.source = filters.source as CampaignTemplateSavedSearchSource;
  }
  if (filters.kind !== undefined && filters.kind !== "") {
    if (
      typeof filters.kind !== "string" ||
      !SAVED_SEARCH_KINDS.has(filters.kind)
    ) {
      return null;
    }
    output.kind = filters.kind as "editable" | "reference";
  }
  if (filters.tags !== undefined) {
    if (
      !stringArray(filters.tags, 20) ||
      !filters.tags.every(
        (tag) => tag.trim() !== "" && Array.from(tag).length <= 80,
      ) ||
      !uniqueStrings(filters.tags)
    ) {
      return null;
    }
    if (filters.tags.length) output.tags = [...filters.tags];
  }
  for (const key of ["featured", "favorited"] as const) {
    const candidate = filters[key];
    if (candidate !== undefined) {
      if (typeof candidate !== "boolean") return null;
      output[key] = candidate;
    }
  }
  if (filters.archived !== undefined && filters.archived !== "") {
    if (
      typeof filters.archived !== "string" ||
      !SAVED_SEARCH_ARCHIVE_STATES.has(filters.archived)
    ) {
      return null;
    }
    output.archived = filters.archived as "active" | "archived" | "all";
  }
  if (filters.sort !== undefined && filters.sort !== "") {
    if (
      typeof filters.sort !== "string" ||
      !SAVED_SEARCH_SORTS.has(filters.sort)
    ) {
      return null;
    }
    output.sort = filters.sort as "recommended" | "name" | "most_used";
  }
  return output;
}

export function decodeCampaignTemplateSavedSearch(
  value: unknown,
): CampaignTemplateSavedSearch | null {
  const savedSearch = record(value);
  const filters = savedSearch
    ? decodeCampaignTemplateSavedSearchFilters(savedSearch.filters)
    : null;
  if (
    !savedSearch ||
    !nonEmptyString(savedSearch.id) ||
    !UUID_RE.test(savedSearch.id) ||
    !nonEmptyString(savedSearch.name, 120) ||
    !filters ||
    !validTimestamp(savedSearch.created_at) ||
    !validTimestamp(savedSearch.updated_at) ||
    !positiveInteger(savedSearch.version) ||
    !isCampaignTemplateSavedSearchEtag(
      savedSearch.etag,
      savedSearch.id,
      savedSearch.version,
    )
  ) {
    return null;
  }
  return {
    id: savedSearch.id,
    name: savedSearch.name,
    filters,
    created_at: savedSearch.created_at,
    updated_at: savedSearch.updated_at,
    version: savedSearch.version,
    etag: savedSearch.etag,
  };
}

export function decodeCampaignTemplateSavedSearchResults(
  value: unknown,
): CampaignTemplateSavedSearchResults | null {
  const response = record(value);
  if (
    !response ||
    !Array.isArray(response.items) ||
    !positiveInteger(response.page) ||
    !positiveInteger(response.per_page) ||
    !nonNegativeInteger(response.total) ||
    response.items.length > response.per_page ||
    response.items.length > response.total ||
    (response.has_more !== undefined &&
      typeof response.has_more !== "boolean") ||
    (response.next_cursor !== undefined &&
      typeof response.next_cursor !== "string")
  ) {
    return null;
  }
  const items: CampaignTemplate[] = [];
  for (const item of response.items) {
    const template = decodeCampaignTemplateDiscoveryTemplate(item);
    if (!template) return null;
    items.push(template);
  }
  return {
    items,
    page: response.page,
    per_page: response.per_page,
    total: response.total,
    ...(typeof response.has_more === "boolean"
      ? { has_more: response.has_more }
      : {}),
    ...(typeof response.next_cursor === "string" &&
    response.next_cursor.trim() !== ""
      ? { next_cursor: response.next_cursor }
      : {}),
  };
}

function decodeList<T>(
  value: unknown,
  decode: (item: unknown) => T | null,
  maximum: number,
): { items: T[] } | null {
  const response = record(value);
  if (
    !response ||
    !Array.isArray(response.items) ||
    response.items.length > maximum
  ) {
    return null;
  }
  const items: T[] = [];
  for (const item of response.items) {
    const decoded = decode(item);
    if (!decoded) return null;
    items.push(decoded);
  }
  return { items };
}

function decodeMutationReceipt(
  value: unknown,
): { ok: boolean; deleted?: boolean; cleared?: number } | null {
  const receipt = record(value);
  if (!receipt || receipt.ok !== true) return null;
  if (receipt.deleted !== undefined && typeof receipt.deleted !== "boolean") {
    return null;
  }
  if (receipt.cleared !== undefined && !nonNegativeInteger(receipt.cleared)) {
    return null;
  }
  return {
    ok: true,
    ...(typeof receipt.deleted === "boolean"
      ? { deleted: receipt.deleted }
      : {}),
    ...(typeof receipt.cleared === "number"
      ? { cleared: receipt.cleared }
      : {}),
  };
}

async function validatedRequest<T>(
  request: Promise<ApiResult<unknown>>,
  decode: (value: unknown) => T | null,
  resource: string,
): Promise<ApiResult<T>> {
  const result = await request;
  if (result.error) return result;
  const data = decode(result.data);
  if (!data) return invalidResponse(resource);
  return {
    data,
    ...(result.serverVersion ? { serverVersion: result.serverVersion } : {}),
  };
}

async function versionedEntityRequest<T extends { etag: string }>(
  request: Promise<ApiResult<unknown>>,
  decode: (value: unknown) => T | null,
  resource: string,
): Promise<ApiResult<T>> {
  const result = await validatedRequest(request, decode, resource);
  if (result.error) return result;
  if (
    !result.serverVersion ||
    result.serverVersion.trim() !== result.data.etag
  ) {
    return invalidResponse(`${resource} version`);
  }
  return result;
}

function normalizedName(value: string): string | null {
  const name = value.trim();
  return name && Array.from(name).length <= 120 ? name : null;
}

function normalizedDescription(value: string | undefined): string | null {
  const description = value?.trim() ?? "";
  return Array.from(description).length <= 1_000 ? description : null;
}

function normalizedTemplateIds(value: string[] | undefined): string[] | null {
  const ids = (value ?? []).map((id) => id.trim());
  if (
    ids.length > 100 ||
    ids.some((id) => !UUID_RE.test(id)) ||
    !uniqueStrings(ids)
  ) {
    return null;
  }
  return ids;
}

export function normalizeCampaignTemplateDiscoveryIdempotencyKey(
  value: string,
): string | null {
  const key = value.trim();
  if (
    !key ||
    CONTROL_CHARACTER_RE.test(key) ||
    new TextEncoder().encode(key).length > 255
  ) {
    return null;
  }
  return key;
}

export function newCampaignTemplateDiscoveryIdempotencyKey(): string {
  return newUUIDv7();
}

function collectionIfMatch(
  id: string,
  value: string,
): ApiErr | { value: string } {
  const expected = value.trim();
  return isCampaignTemplateCollectionEtag(expected, id)
    ? { value: expected }
    : invalidConfig(
        "campaign_template_collection_etag_required",
        "Reload this collection to obtain its exact current version before changing it.",
      );
}

function savedSearchIfMatch(
  id: string,
  value: string,
): ApiErr | { value: string } {
  const expected = value.trim();
  return isCampaignTemplateSavedSearchEtag(expected, id)
    ? { value: expected }
    : invalidConfig(
        "campaign_template_saved_search_etag_required",
        "Reload this saved search to obtain its exact current version before changing it.",
      );
}

export const campaignTemplateDiscoveryApi = {
  compare(
    identifiers: string[],
  ): Promise<ApiResult<CampaignTemplateCompareResponse>> {
    const normalized = identifiers.map((identifier) => identifier.trim());
    if (
      normalized.length < 2 ||
      normalized.length > 4 ||
      normalized.some(
        (identifier) => !identifier || Array.from(identifier).length > 256,
      ) ||
      !uniqueStrings(normalized)
    ) {
      return Promise.resolve(
        invalidConfig(
          "invalid_campaign_template_compare_selection",
          "Choose two to four different templates before comparing.",
        ),
      );
    }
    const query = new URLSearchParams({ templates: normalized.join(",") });
    return validatedRequest(
      apiRequest(`/api/v1/campaign-templates/compare?${query.toString()}`),
      decodeCampaignTemplateCompareResponse,
      "template comparison",
    );
  },

  recordView(id: string): Promise<ApiResult<CampaignTemplateRecentView>> {
    const templateId = id.trim();
    if (!templateId) {
      return Promise.resolve(
        invalidConfig(
          "invalid_campaign_template_id",
          "A verified template ID is required before recording a recent view.",
        ),
      );
    }
    return validatedRequest(
      apiRequest(
        `/api/v1/campaign-templates/${encodeURIComponent(templateId)}/view`,
        { method: "POST", body: JSON.stringify({}) },
        { requireOnline: true, maxAttempts: 1 },
      ),
      decodeCampaignTemplateRecentView,
      "recent template view",
    );
  },

  recent(
    limit = 24,
  ): Promise<ApiResult<{ items: CampaignTemplateRecentView[] }>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return Promise.resolve(
        invalidConfig(
          "invalid_campaign_template_recent_limit",
          "Recent-template limit must be a whole number from 1 to 100.",
        ),
      );
    }
    const query = new URLSearchParams({ limit: String(limit) });
    return validatedRequest(
      apiRequest(`/api/v1/campaign-templates/recent?${query.toString()}`),
      (value) => decodeList(value, decodeCampaignTemplateRecentView, limit),
      "recent templates",
    );
  },

  clearRecent(
    id?: string,
  ): Promise<ApiResult<{ ok: boolean; cleared: number }>> {
    const templateId = id?.trim();
    if (id !== undefined && !templateId) {
      return Promise.resolve(
        invalidConfig(
          "invalid_campaign_template_id",
          "A template ID is required to remove one recent view.",
        ),
      );
    }
    return validatedRequest(
      apiRequest(
        templateId
          ? `/api/v1/campaign-templates/recent/${encodeURIComponent(templateId)}`
          : "/api/v1/campaign-templates/recent",
        { method: "DELETE" },
        { requireOnline: true, maxAttempts: 1 },
      ),
      (value) => {
        const receipt = decodeMutationReceipt(value);
        return receipt && typeof receipt.cleared === "number"
          ? { ok: true, cleared: receipt.cleared }
          : null;
      },
      "recent-template removal",
    );
  },

  listCollections(): Promise<
    ApiResult<{ items: CampaignTemplateCollection[] }>
  > {
    return validatedRequest(
      apiRequest("/api/v1/campaign-template-collections"),
      (value) => decodeList(value, decodeCampaignTemplateCollection, 100),
      "template collections",
    );
  },

  getCollection(id: string): Promise<ApiResult<CampaignTemplateCollection>> {
    return versionedEntityRequest(
      apiRequest(
        `/api/v1/campaign-template-collections/${encodeURIComponent(id)}`,
      ),
      decodeCampaignTemplateCollection,
      "template collection",
    );
  },

  createCollection(
    input: CreateCampaignTemplateCollectionInput,
    options: DiscoveryCreateOptions,
  ): Promise<ApiResult<CampaignTemplateCollection>> {
    const name = normalizedName(input.name);
    const description = normalizedDescription(input.description);
    const templateIds = normalizedTemplateIds(input.template_ids);
    const idempotencyKey = normalizeCampaignTemplateDiscoveryIdempotencyKey(
      options.idempotencyKey,
    );
    if (!name || description === null) {
      return Promise.resolve(
        invalidConfig(
          "invalid_campaign_template_collection",
          "Collection name must contain 1 to 120 characters and description at most 1,000 characters.",
        ),
      );
    }
    if (!templateIds) {
      return Promise.resolve(
        invalidConfig(
          "invalid_campaign_template_collection_items",
          "A collection accepts at most 100 different verified template IDs.",
        ),
      );
    }
    if (!idempotencyKey) {
      return Promise.resolve(
        invalidConfig(
          "campaign_template_discovery_idempotency_key_required",
          "Retain one valid request identity for this exact collection create attempt.",
        ),
      );
    }
    return versionedEntityRequest(
      apiRequest(
        "/api/v1/campaign-template-collections",
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({
            name,
            description,
            template_ids: templateIds,
          }),
        },
        { requireOnline: true, maxAttempts: 1 },
      ),
      decodeCampaignTemplateCollection,
      "template collection",
    );
  },

  updateCollection(
    id: string,
    input: { name?: string; description?: string },
    options: DiscoveryMutationOptions,
  ): Promise<ApiResult<CampaignTemplateCollection>> {
    const ifMatch = collectionIfMatch(id, options.ifMatch);
    if ("error" in ifMatch) return Promise.resolve(ifMatch);
    if (input.name === undefined && input.description === undefined) {
      return Promise.resolve(
        invalidConfig(
          "invalid_campaign_template_collection_update",
          "Change the collection name or description before saving.",
        ),
      );
    }
    const name =
      input.name === undefined ? undefined : normalizedName(input.name);
    const description =
      input.description === undefined
        ? undefined
        : normalizedDescription(input.description);
    if (
      (input.name !== undefined && !name) ||
      (input.description !== undefined && description === null)
    ) {
      return Promise.resolve(
        invalidConfig(
          "invalid_campaign_template_collection_update",
          "Collection name must contain 1 to 120 characters and description at most 1,000 characters.",
        ),
      );
    }
    return versionedEntityRequest(
      apiRequest(
        `/api/v1/campaign-template-collections/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { "If-Match": ifMatch.value },
          body: JSON.stringify({
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
          }),
        },
        { requireOnline: true, maxAttempts: 1 },
      ),
      decodeCampaignTemplateCollection,
      "template collection",
    );
  },

  replaceCollectionItems(
    id: string,
    templateIdsInput: string[],
    options: DiscoveryMutationOptions,
  ): Promise<ApiResult<CampaignTemplateCollection>> {
    const ifMatch = collectionIfMatch(id, options.ifMatch);
    if ("error" in ifMatch) return Promise.resolve(ifMatch);
    const templateIds = normalizedTemplateIds(templateIdsInput);
    if (!templateIds) {
      return Promise.resolve(
        invalidConfig(
          "invalid_campaign_template_collection_items",
          "A collection accepts at most 100 different verified template IDs.",
        ),
      );
    }
    return versionedEntityRequest(
      apiRequest(
        `/api/v1/campaign-template-collections/${encodeURIComponent(id)}/items`,
        {
          method: "PUT",
          headers: { "If-Match": ifMatch.value },
          body: JSON.stringify({ template_ids: templateIds }),
        },
        { requireOnline: true, maxAttempts: 1 },
      ),
      decodeCampaignTemplateCollection,
      "template collection",
    );
  },

  async deleteCollection(
    id: string,
    options: DiscoveryMutationOptions,
  ): Promise<ApiResult<{ ok: boolean; deleted: boolean }>> {
    const ifMatch = collectionIfMatch(id, options.ifMatch);
    if ("error" in ifMatch) return ifMatch;
    return validatedRequest(
      apiRequest(
        `/api/v1/campaign-template-collections/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: { "If-Match": ifMatch.value },
        },
        { requireOnline: true, maxAttempts: 1 },
      ),
      (value) => {
        const receipt = decodeMutationReceipt(value);
        return receipt && typeof receipt.deleted === "boolean"
          ? { ok: true, deleted: receipt.deleted }
          : null;
      },
      "template collection deletion",
    );
  },

  listSavedSearches(): Promise<
    ApiResult<{ items: CampaignTemplateSavedSearch[] }>
  > {
    return validatedRequest(
      apiRequest("/api/v1/campaign-template-saved-searches"),
      (value) => decodeList(value, decodeCampaignTemplateSavedSearch, 100),
      "saved template searches",
    );
  },

  getSavedSearch(id: string): Promise<ApiResult<CampaignTemplateSavedSearch>> {
    return versionedEntityRequest(
      apiRequest(
        `/api/v1/campaign-template-saved-searches/${encodeURIComponent(id)}`,
      ),
      decodeCampaignTemplateSavedSearch,
      "saved template search",
    );
  },

  createSavedSearch(
    input: CreateCampaignTemplateSavedSearchInput,
    options: DiscoveryCreateOptions,
  ): Promise<ApiResult<CampaignTemplateSavedSearch>> {
    const name = normalizedName(input.name);
    const filters = decodeCampaignTemplateSavedSearchFilters(input.filters);
    const idempotencyKey = normalizeCampaignTemplateDiscoveryIdempotencyKey(
      options.idempotencyKey,
    );
    if (!name || !filters) {
      return Promise.resolve(
        invalidConfig(
          "invalid_campaign_template_saved_search",
          "Saved-search name or filters are invalid. Review the current library filters.",
        ),
      );
    }
    if (!idempotencyKey) {
      return Promise.resolve(
        invalidConfig(
          "campaign_template_discovery_idempotency_key_required",
          "Retain one valid request identity for this exact saved-search create attempt.",
        ),
      );
    }
    return versionedEntityRequest(
      apiRequest(
        "/api/v1/campaign-template-saved-searches",
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({ name, filters }),
        },
        { requireOnline: true, maxAttempts: 1 },
      ),
      decodeCampaignTemplateSavedSearch,
      "saved template search",
    );
  },

  updateSavedSearch(
    id: string,
    input: {
      name?: string;
      filters?: CampaignTemplateSavedSearchFilters;
    },
    options: DiscoveryMutationOptions,
  ): Promise<ApiResult<CampaignTemplateSavedSearch>> {
    const ifMatch = savedSearchIfMatch(id, options.ifMatch);
    if ("error" in ifMatch) return Promise.resolve(ifMatch);
    if (input.name === undefined && input.filters === undefined) {
      return Promise.resolve(
        invalidConfig(
          "invalid_campaign_template_saved_search_update",
          "Change the saved-search name or filters before saving.",
        ),
      );
    }
    const name =
      input.name === undefined ? undefined : normalizedName(input.name);
    const filters =
      input.filters === undefined
        ? undefined
        : decodeCampaignTemplateSavedSearchFilters(input.filters);
    if (
      (input.name !== undefined && !name) ||
      (input.filters !== undefined && !filters)
    ) {
      return Promise.resolve(
        invalidConfig(
          "invalid_campaign_template_saved_search_update",
          "Saved-search name or filters are invalid. Review the current library filters.",
        ),
      );
    }
    return versionedEntityRequest(
      apiRequest(
        `/api/v1/campaign-template-saved-searches/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { "If-Match": ifMatch.value },
          body: JSON.stringify({
            ...(name !== undefined ? { name } : {}),
            ...(filters !== undefined ? { filters } : {}),
          }),
        },
        { requireOnline: true, maxAttempts: 1 },
      ),
      decodeCampaignTemplateSavedSearch,
      "saved template search",
    );
  },

  async deleteSavedSearch(
    id: string,
    options: DiscoveryMutationOptions,
  ): Promise<ApiResult<{ ok: boolean; deleted: boolean }>> {
    const ifMatch = savedSearchIfMatch(id, options.ifMatch);
    if ("error" in ifMatch) return ifMatch;
    return validatedRequest(
      apiRequest(
        `/api/v1/campaign-template-saved-searches/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: { "If-Match": ifMatch.value },
        },
        { requireOnline: true, maxAttempts: 1 },
      ),
      (value) => {
        const receipt = decodeMutationReceipt(value);
        return receipt && typeof receipt.deleted === "boolean"
          ? { ok: true, deleted: receipt.deleted }
          : null;
      },
      "saved template search deletion",
    );
  },

  savedSearchResults(
    id: string,
    params: { cursor?: string; per_page?: number } = {},
  ): Promise<ApiResult<CampaignTemplateSavedSearchResults>> {
    if (
      (params.cursor !== undefined &&
        (!params.cursor.trim() || params.cursor.length > 2_048)) ||
      (params.per_page !== undefined &&
        (!Number.isInteger(params.per_page) ||
          params.per_page < 1 ||
          params.per_page > 100))
    ) {
      return Promise.resolve(
        invalidConfig(
          "invalid_campaign_template_saved_search_page",
          "Saved-search result pages require a valid cursor and page size from 1 to 100.",
        ),
      );
    }
    const query = new URLSearchParams();
    if (params.cursor) query.set("cursor", params.cursor);
    if (params.per_page) query.set("per_page", String(params.per_page));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return validatedRequest(
      apiRequest(
        `/api/v1/campaign-template-saved-searches/${encodeURIComponent(id)}/results${suffix}`,
      ),
      decodeCampaignTemplateSavedSearchResults,
      "saved template search results",
    );
  },
};
