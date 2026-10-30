import type {
  CampaignTemplate,
  CampaignTemplateRevision,
  CampaignTemplateRevisionPage,
  CampaignTemplateSearchResponse,
  SavedBlock,
  TemplateRegion,
  TemplateGoal,
  TemplateGoalCount,
  TemplateStats,
} from "../../lib/api-client";

const TEMPLATE_GOALS = new Set<TemplateGoal>([
  "welcome",
  "newsletter",
  "announcement",
  "promotional",
  "re_engagement",
  "transactional",
  "automation",
]);
const TEMPLATE_KINDS = new Set(["editable", "reference"]);
const REVIEW_STATES = new Set(["pending", "approved", "rejected"]);
const BLOCK_KINDS = new Set(["block", "snippet", "section"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function nonNegativeInteger(value: unknown): value is number {
  return finiteNumber(value) && value >= 0 && Number.isInteger(value);
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isStrongCampaignTemplateEntityTag(
  value: string | null | undefined,
): value is string {
  return Boolean(
    value && /^"campaign-template:[^"\\\s,]+:v[1-9]\d*"$/.test(value.trim()),
  );
}

const TEMPLATE_PREVIEW_VARIANTS = new Set(["desktop", "mobile", "card"]);
const TEMPLATE_PREVIEW_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const TEMPLATE_PREVIEW_STATUSES = new Set(["ready", "source_missing"]);

function validPreviewAssets(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    const asset = record(item);
    return Boolean(
      asset &&
      typeof asset.variant === "string" &&
      TEMPLATE_PREVIEW_VARIANTS.has(asset.variant) &&
      typeof asset.url === "string" &&
      asset.url.trim() !== "" &&
      typeof asset.mime_type === "string" &&
      TEMPLATE_PREVIEW_MIME_TYPES.has(asset.mime_type) &&
      nonNegativeInteger(asset.width) &&
      asset.width > 0 &&
      nonNegativeInteger(asset.height) &&
      asset.height > 0 &&
      nonNegativeInteger(asset.size_bytes) &&
      asset.size_bytes > 0 &&
      typeof asset.status === "string" &&
      TEMPLATE_PREVIEW_STATUSES.has(asset.status),
    );
  });
}

function decodeTemplateWarnings(
  value: unknown,
): CampaignTemplate["warnings"] | null {
  if (!Array.isArray(value)) return null;
  const warnings: NonNullable<CampaignTemplate["warnings"]> = [];
  for (const item of value) {
    const warning = record(item);
    if (
      !warning ||
      typeof warning.code !== "string" ||
      warning.code.trim() === "" ||
      typeof warning.message !== "string" ||
      warning.message.trim() === "" ||
      (warning.recommended_action !== undefined &&
        typeof warning.recommended_action !== "string")
    ) {
      return null;
    }
    warnings.push({
      code: warning.code,
      message: warning.message,
      ...(typeof warning.recommended_action === "string"
        ? { recommended_action: warning.recommended_action }
        : {}),
    });
  }
  return warnings;
}

export function decodeCampaignTemplate(
  value: unknown,
): CampaignTemplate | null {
  const row = record(value);
  if (!row) return null;
  if (
    typeof row.id !== "string" ||
    row.id.trim() === "" ||
    typeof row.slug !== "string" ||
    row.slug.trim() === "" ||
    typeof row.name !== "string" ||
    row.name.trim() === "" ||
    typeof row.subject !== "string"
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
    "created_at",
    "updated_at",
    "last_used_at",
    "source_provider",
    "source_external_id",
    "source_url",
    "source_brand",
    "thumbnail_url",
    "source_captured_at",
    "source_license_status",
    "industry",
    "style",
    "layout",
    "content_hash",
    "imported_at",
    "etag",
    "archived_at",
    "recommended_action",
  ] as const) {
    if (!optionalString(row[key])) return null;
  }
  if (
    row.goal !== undefined &&
    row.goal !== "" &&
    (typeof row.goal !== "string" ||
      !TEMPLATE_GOALS.has(row.goal as TemplateGoal))
  ) {
    return null;
  }
  if (
    row.template_kind !== undefined &&
    (typeof row.template_kind !== "string" ||
      !TEMPLATE_KINDS.has(row.template_kind))
  ) {
    return null;
  }
  if (
    row.review_status !== undefined &&
    (typeof row.review_status !== "string" ||
      !REVIEW_STATES.has(row.review_status))
  ) {
    return null;
  }
  if (row.usage_count !== undefined && !nonNegativeInteger(row.usage_count)) {
    return null;
  }
  if (
    row.quality_score !== undefined &&
    (!finiteNumber(row.quality_score) ||
      row.quality_score < 0 ||
      row.quality_score > 1)
  ) {
    return null;
  }
  for (const key of ["is_featured", "is_favorited"] as const) {
    if (row[key] !== undefined && typeof row[key] !== "boolean") return null;
  }
  if (
    row.version !== undefined &&
    (!nonNegativeInteger(row.version) || row.version < 1)
  ) {
    return null;
  }
  if (
    row.etag !== undefined &&
    !isStrongCampaignTemplateEntityTag(
      typeof row.etag === "string" ? row.etag : undefined,
    )
  ) {
    return null;
  }
  if (
    row.archived_at !== undefined &&
    (typeof row.archived_at !== "string" ||
      !Number.isFinite(Date.parse(row.archived_at)))
  ) {
    return null;
  }
  if (
    row.preview_assets !== undefined &&
    !validPreviewAssets(row.preview_assets)
  ) {
    return null;
  }
  let lifecycleMutationAllowed = false;
  if (row.capabilities !== undefined) {
    const capabilities = record(row.capabilities);
    if (
      !capabilities ||
      [
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
      ].some((key) => typeof capabilities[key] !== "boolean")
    ) {
      return null;
    }
    lifecycleMutationAllowed =
      capabilities.can_edit_directly === true ||
      capabilities.can_archive === true ||
      capabilities.can_restore === true;
  }
  if (
    lifecycleMutationAllowed &&
    (!nonNegativeInteger(row.version) ||
      row.version < 1 ||
      !isStrongCampaignTemplateEntityTag(
        typeof row.etag === "string" ? row.etag : undefined,
      ))
  ) {
    return null;
  }
  if (
    row.warnings !== undefined &&
    decodeTemplateWarnings(row.warnings) === null
  ) {
    return null;
  }
  if (row.tags !== undefined && !stringArray(row.tags)) {
    return null;
  }
  if (
    row.variables !== undefined &&
    (!Array.isArray(row.variables) ||
      !row.variables.every((item) => record(item) !== null))
  ) {
    return null;
  }
  if (
    row.reference_template_ids !== undefined &&
    (!Array.isArray(row.reference_template_ids) ||
      row.reference_template_ids.length > 3 ||
      !row.reference_template_ids.every(
        (item) => typeof item === "string" && item.trim() !== "",
      ))
  ) {
    return null;
  }
  return row as unknown as CampaignTemplate;
}

export function decodeCampaignTemplateRevisionPage(
  value: unknown,
): CampaignTemplateRevisionPage | null {
  const page = record(value);
  if (
    !page ||
    !Array.isArray(page.items) ||
    !nonNegativeInteger(page.page) ||
    page.page < 1 ||
    !nonNegativeInteger(page.per_page) ||
    page.per_page < 1 ||
    !nonNegativeInteger(page.total) ||
    page.items.length > page.per_page ||
    page.items.length > page.total
  ) {
    return null;
  }
  const items: CampaignTemplateRevisionPage["items"] = [];
  for (const item of page.items) {
    const revision = record(item);
    if (
      !revision ||
      !nonNegativeInteger(revision.version) ||
      revision.version < 1 ||
      !isStrongCampaignTemplateEntityTag(
        typeof revision.etag === "string" ? revision.etag : undefined,
      ) ||
      typeof revision.transition !== "string" ||
      revision.transition.trim() === "" ||
      typeof revision.name !== "string" ||
      typeof revision.subject !== "string" ||
      typeof revision.snapshot_time !== "string" ||
      !Number.isFinite(Date.parse(revision.snapshot_time)) ||
      (revision.archived_at !== undefined &&
        (typeof revision.archived_at !== "string" ||
          !Number.isFinite(Date.parse(revision.archived_at))))
    ) {
      return null;
    }
    items.push({
      version: revision.version,
      etag: revision.etag as string,
      transition: revision.transition,
      name: revision.name,
      subject: revision.subject,
      snapshot_time: revision.snapshot_time,
      ...(typeof revision.archived_at === "string"
        ? { archived_at: revision.archived_at }
        : {}),
    });
  }
  return {
    items,
    page: page.page,
    per_page: page.per_page,
    total: page.total,
  };
}

export function decodeCampaignTemplateRevision(
  value: unknown,
): CampaignTemplateRevision | null {
  const revision = record(value);
  if (
    !revision ||
    !nonNegativeInteger(revision.version) ||
    revision.version < 1 ||
    !isStrongCampaignTemplateEntityTag(
      typeof revision.etag === "string" ? revision.etag : undefined,
    ) ||
    typeof revision.transition !== "string" ||
    revision.transition.trim() === "" ||
    typeof revision.snapshot_time !== "string" ||
    !Number.isFinite(Date.parse(revision.snapshot_time))
  ) {
    return null;
  }
  const snapshot = decodeCampaignTemplate(revision.snapshot);
  if (!snapshot) return null;
  return {
    version: revision.version,
    etag: revision.etag as string,
    transition: revision.transition,
    snapshot_time: revision.snapshot_time,
    snapshot,
  };
}

export function decodeTemplateSearchResponse(
  value: unknown,
): CampaignTemplateSearchResponse | null {
  const response = record(value);
  if (!response || !Array.isArray(response.items)) return null;
  const items = response.items.map(decodeCampaignTemplate);
  if (items.some((item) => item === null)) return null;
  if (
    !finiteNumber(response.page) ||
    response.page < 1 ||
    !Number.isInteger(response.page) ||
    !finiteNumber(response.per_page) ||
    response.per_page < 1 ||
    !Number.isInteger(response.per_page) ||
    !finiteNumber(response.total) ||
    response.total < 0 ||
    !Number.isInteger(response.total) ||
    response.items.length > response.per_page ||
    response.items.length > response.total
  ) {
    return null;
  }
  const facets = record(response.facets);
  if (!facets) return null;
  const decodeFacets = (
    input: unknown,
  ): Array<{ value: string; count: number }> | null => {
    if (!Array.isArray(input)) return null;
    const out: Array<{ value: string; count: number }> = [];
    for (const value of input) {
      const facet = record(value);
      if (
        !facet ||
        typeof facet.value !== "string" ||
        facet.value.trim() === "" ||
        !finiteNumber(facet.count) ||
        facet.count < 0 ||
        !Number.isInteger(facet.count)
      ) {
        return null;
      }
      out.push({ value: facet.value, count: facet.count });
    }
    return out;
  };
  const goals = decodeFacets(facets.goals);
  const categories = decodeFacets(facets.categories);
  const providers = decodeFacets(facets.providers);
  const industries = decodeFacets(facets.industries);
  const styles = decodeFacets(facets.styles);
  const layouts = decodeFacets(facets.layouts);
  if (
    !goals ||
    !categories ||
    !providers ||
    !industries ||
    !styles ||
    !layouts
  ) {
    return null;
  }
  return {
    items: items as CampaignTemplate[],
    page: Math.trunc(response.page),
    per_page: Math.trunc(response.per_page),
    total: Math.trunc(response.total),
    ...(typeof response.next_cursor === "string"
      ? { next_cursor: response.next_cursor }
      : {}),
    facets: {
      goals,
      categories,
      providers,
      industries,
      styles,
      layouts,
    },
  };
}

export function decodeTemplateStats(value: unknown): TemplateStats | null {
  const stats = record(value);
  if (!stats) return null;
  for (const key of [
    "total",
    "mine",
    "featured",
    "favorites",
    "used_last_30d",
  ] as const) {
    if (!nonNegativeInteger(stats[key])) return null;
  }
  for (const key of ["top_usage_count"] as const) {
    if (stats[key] !== undefined && !nonNegativeInteger(stats[key])) {
      return null;
    }
  }
  return stats as unknown as TemplateStats;
}

export function decodeTemplateGoalCounts(
  value: unknown,
): TemplateGoalCount[] | null {
  if (!Array.isArray(value)) return null;
  const out: TemplateGoalCount[] = [];
  for (const item of value) {
    const goal = record(item);
    if (
      !goal ||
      typeof goal.goal !== "string" ||
      (goal.goal !== "" && !TEMPLATE_GOALS.has(goal.goal as TemplateGoal)) ||
      !nonNegativeInteger(goal.count)
    ) {
      return null;
    }
    out.push({
      goal: goal.goal as TemplateGoal | "",
      count: goal.count,
    });
  }
  return out;
}

export function decodeSavedBlock(value: unknown): SavedBlock | null {
  const block = record(value);
  if (
    !block ||
    typeof block.id !== "string" ||
    block.id.trim() === "" ||
    typeof block.name !== "string" ||
    block.name.trim() === "" ||
    typeof block.kind !== "string" ||
    !BLOCK_KINDS.has(block.kind) ||
    typeof block.body_html !== "string" ||
    !Object.prototype.hasOwnProperty.call(block, "body_json") ||
    typeof block.created_at !== "string" ||
    !Number.isFinite(Date.parse(block.created_at)) ||
    typeof block.updated_at !== "string" ||
    !Number.isFinite(Date.parse(block.updated_at)) ||
    !nonNegativeInteger(block.version) ||
    block.version < 1 ||
    (block.tenant_id !== undefined && typeof block.tenant_id !== "string")
  ) {
    return null;
  }
  return block as unknown as SavedBlock;
}

export function decodeSavedBlocks(value: unknown): SavedBlock[] | null {
  const response = record(value);
  if (!response || !Array.isArray(response.items)) return null;
  const out = response.items.map(decodeSavedBlock);
  return out.some((block) => block === null) ? null : (out as SavedBlock[]);
}

/** Bind a destructive receipt to the exact block and revision we removed. */
export function decodeSavedBlockDeleteReceipt(
  value: unknown,
  expectedId: string,
  expectedVersion: number,
): boolean {
  const receipt = record(value);
  return Boolean(
    receipt &&
    expectedId.trim() !== "" &&
    nonNegativeInteger(expectedVersion) &&
    expectedVersion > 0 &&
    Object.keys(receipt).length === 3 &&
    receipt.ok === true &&
    receipt.id === expectedId &&
    nonNegativeInteger(receipt.version) &&
    receipt.version === expectedVersion + 1,
  );
}

export function decodeTemplateRegions(value: unknown): TemplateRegion[] | null {
  const response = record(value);
  if (!response || !Array.isArray(response.regions)) return null;
  const out: TemplateRegion[] = [];
  for (const item of response.regions) {
    const region = record(item);
    if (
      !region ||
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
