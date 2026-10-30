// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";

export const PRESET_MEMBER_PAGE_SIZE = 25;
export const MIN_COMPARE_SEGMENTS = 2;
export const MAX_COMPARE_SEGMENTS = 5;

export class SegmentParityContractError extends Error {
  readonly code = "segment_parity_contract_invalid";
  constructor(surface: string) {
    super(
      `Moosewave returned an invalid ${surface} response. Refresh and try again.`,
    );
    this.name = "SegmentParityContractError";
  }
}

function rec(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function str(value: unknown, max = 2_000): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function timestamp(value: unknown): value is string {
  return str(value, 80) && Number.isFinite(Date.parse(value));
}
function int(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
  );
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function rate(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1;
}
function id(value: unknown): value is string {
  return (
    str(value, 256) &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
function assertDays(days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > 365)
    throw new RangeError("days must be between 1 and 365");
}

export interface PresetSegmentRecipe {
  key: string;
  label: string;
  description: string;
  count: number;
}

export async function listPresetSegmentRecipes(
  signal?: AbortSignal,
): Promise<PresetSegmentRecipe[]> {
  const raw = rec(
    await api.get<unknown>("/api/v1/preset-segments", { signal }),
  );
  const rows = Array.isArray(raw?.presets) ? raw.presets : null;
  if (!rows || rows.length > 100 || raw?.count !== rows.length)
    throw new SegmentParityContractError("preset segment");
  const seen = new Set<string>();
  return rows.map((value) => {
    const row = rec(value);
    if (
      !row ||
      !str(row.key, 64) ||
      !/^[a-z0-9_]+$/u.test(row.key) ||
      seen.has(row.key) ||
      !str(row.label, 160) ||
      !str(row.description, 1_000) ||
      !int(row.count)
    ) {
      throw new SegmentParityContractError("preset segment");
    }
    seen.add(row.key);
    return {
      key: row.key,
      label: row.label,
      description: row.description,
      count: row.count,
    };
  });
}

export interface PresetSegmentMember {
  id: string;
  email: string;
  createdAt: string;
  status: string;
}
export interface PresetSegmentMembersPage {
  preset: string;
  label: string;
  members: PresetSegmentMember[];
  limit: number;
  offset: number;
  hasNext: boolean;
}

export async function listPresetSegmentMembers(
  key: string,
  opts: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<PresetSegmentMembersPage> {
  if (!/^[a-z0-9_]{1,64}$/u.test(key)) throw new Error("Invalid preset key.");
  const limit = opts.limit ?? PRESET_MEMBER_PAGE_SIZE;
  const offset = opts.offset ?? 0;
  if (!int(limit, 1, 100) || !int(offset, 0, 1_000_000))
    throw new RangeError("Invalid preset page.");
  const raw = rec(
    await api.get<unknown>(
      `/api/v1/preset-segments/${encodeURIComponent(key)}/list?limit=${limit}&offset=${offset}`,
      { signal: opts.signal },
    ),
  );
  const rows = Array.isArray(raw?.subscribers) ? raw.subscribers : null;
  if (
    !raw ||
    raw.preset !== key ||
    raw.limit !== limit ||
    raw.offset !== offset ||
    !str(raw.label, 160) ||
    !rows ||
    rows.length > limit ||
    raw.count !== rows.length
  )
    throw new SegmentParityContractError("preset member page");
  const seen = new Set<string>();
  const members = rows.map((value) => {
    const row = rec(value);
    if (
      !row ||
      !id(row.id) ||
      seen.has(row.id) ||
      !str(row.email, 320) ||
      !row.email.includes("@") ||
      !timestamp(row.created_at) ||
      !str(row.status, 64)
    )
      throw new SegmentParityContractError("preset member page");
    seen.add(row.id);
    return {
      id: row.id,
      email: row.email,
      createdAt: row.created_at,
      status: row.status,
    };
  });
  return {
    preset: key,
    label: raw.label,
    members,
    limit,
    offset,
    hasNext: members.length === limit,
  };
}

export interface SegmentPnLComparisonItem {
  segmentId: string;
  memberCount: number;
  revenueCents: number;
  revenuePerMemberCents: number | null;
  currency: string | null;
}
export interface SegmentPnLComparison {
  days: number;
  items: SegmentPnLComparisonItem[];
}

export async function compareSegmentPnL(
  ids: string[],
  days: number,
  signal?: AbortSignal,
): Promise<SegmentPnLComparison> {
  assertDays(days);
  const unique = [...new Set(ids)];
  if (
    unique.length !== ids.length ||
    unique.length < MIN_COMPARE_SEGMENTS ||
    unique.length > MAX_COMPARE_SEGMENTS ||
    unique.some((value) => !id(value))
  ) {
    throw new Error("Choose two to five distinct segments.");
  }
  const params = new URLSearchParams({
    ids: unique.join(","),
    days: String(days),
  });
  const raw = rec(
    await api.get<unknown>(
      `/api/v1/segments/pnl/compare?${params.toString()}`,
      { signal },
    ),
  );
  const rows = Array.isArray(raw?.items) ? raw.items : null;
  if (
    !raw ||
    raw.days !== days ||
    raw.window_days !== days ||
    !rows ||
    rows.length !== unique.length
  )
    throw new SegmentParityContractError("segment P&L comparison");
  const expected = new Set(unique);
  const seen = new Set<string>();
  const items = rows.map((value) => {
    const row = rec(value);
    const per = row?.revenue_per_member_cents;
    const currency = row?.currency;
    if (
      !row ||
      !id(row.segment_id) ||
      !expected.has(row.segment_id) ||
      seen.has(row.segment_id) ||
      !int(row.member_count) ||
      !int(row.revenue_cents, -Number.MAX_SAFE_INTEGER) ||
      (per !== null && per !== undefined && !finite(per)) ||
      (currency !== undefined &&
        currency !== "" &&
        (!str(currency, 3) || !/^[A-Z]{3}$/u.test(currency)))
    ) {
      throw new SegmentParityContractError("segment P&L comparison");
    }
    seen.add(row.segment_id);
    return {
      segmentId: row.segment_id,
      memberCount: row.member_count,
      revenueCents: row.revenue_cents,
      revenuePerMemberCents: finite(per) ? per : null,
      currency: str(currency, 3) ? currency : null,
    };
  });
  return { days, items };
}

export interface SegmentEngagementMetrics {
  segmentId: string;
  memberCount: number;
  sends: number;
  openRate: number;
  clickRate: number;
  unsubRate: number;
}
export async function getSegmentEngagementMetrics(
  segmentId: string,
  days: number,
  signal?: AbortSignal,
): Promise<SegmentEngagementMetrics> {
  assertDays(days);
  if (!id(segmentId)) throw new Error("Invalid segment id.");
  const raw = rec(
    await api.get<unknown>(
      `/api/v1/segments/${encodeURIComponent(segmentId)}/engagement-summary?days=${days}`,
      { signal },
    ),
  );
  const counts = [
    raw?.opens,
    raw?.clicks,
    raw?.unsubs,
    raw?.bounces,
    raw?.complaints,
  ];
  const sends = raw?.sends;
  const expectedRates =
    int(sends) && sends > 0
      ? counts.slice(0, 3).map((value) => Number(value) / sends)
      : [0, 0, 0];
  if (
    !raw ||
    raw.segment_id !== segmentId ||
    raw.window_days !== days ||
    !int(raw.member_count) ||
    !int(sends) ||
    counts.some((value) => !int(value)) ||
    counts.reduce<number>((sum, value) => sum + Number(value), 0) !== sends ||
    !rate(raw.open_rate) ||
    !rate(raw.click_rate) ||
    !rate(raw.unsub_rate) ||
    Math.abs(raw.open_rate - expectedRates[0]!) > 1e-12 ||
    Math.abs(raw.click_rate - expectedRates[1]!) > 1e-12 ||
    Math.abs(raw.unsub_rate - expectedRates[2]!) > 1e-12 ||
    raw.rate_basis !== "delivery_outcome_events" ||
    !timestamp(raw.generated_at)
  )
    throw new SegmentParityContractError("segment engagement");
  return {
    segmentId,
    memberCount: raw.member_count,
    sends,
    openRate: raw.open_rate,
    clickRate: raw.click_rate,
    unsubRate: raw.unsub_rate,
  };
}

export interface SegmentGrowthMetrics {
  segmentId: string;
  delta: number;
  deltaPct: number;
  snapshots: number;
}
export async function getSegmentGrowthMetrics(
  segmentId: string,
  days: number,
  signal?: AbortSignal,
): Promise<SegmentGrowthMetrics> {
  assertDays(days);
  if (!id(segmentId)) throw new Error("Invalid segment id.");
  const raw = rec(
    await api.get<unknown>(
      `/api/v1/segments/${encodeURIComponent(segmentId)}/growth?days=${days}`,
      { signal },
    ),
  );
  const series = Array.isArray(raw?.series) ? raw.series : null;
  if (
    !raw ||
    raw.segment_id !== segmentId ||
    raw.days !== days ||
    !series ||
    series.length > days + 1 ||
    !int(raw.delta, -Number.MAX_SAFE_INTEGER) ||
    !finite(raw.delta_pct)
  )
    throw new SegmentParityContractError("segment growth");
  let prior = "";
  let firstCount: number | null = null;
  let lastCount: number | null = null;
  for (const value of series) {
    const row = rec(value);
    if (
      !row ||
      !str(row.date, 10) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(row.date) ||
      (prior !== "" && row.date <= prior) ||
      !timestamp(row.evaluated_at) ||
      !int(row.count)
    ) {
      throw new SegmentParityContractError("segment growth");
    }
    prior = row.date;
    if (firstCount === null) firstCount = row.count;
    lastCount = row.count;
  }
  const expectedDelta =
    firstCount !== null && lastCount !== null && series.length >= 2
      ? lastCount - firstCount
      : 0;
  const expectedDeltaPct =
    series.length >= 2 && firstCount ? (expectedDelta / firstCount) * 100 : 0;
  if (
    raw.delta !== expectedDelta ||
    Math.abs(raw.delta_pct - expectedDeltaPct) > 1e-9
  ) {
    throw new SegmentParityContractError("segment growth");
  }
  return {
    segmentId,
    delta: raw.delta,
    deltaPct: raw.delta_pct,
    snapshots: series.length,
  };
}

export type SavedSegmentScope = "personal" | "workspace";
export interface SavedSegmentBookmark {
  id: string;
  name: string;
  description: string;
  isPinned: boolean;
  pinOrder: number | null;
  visibilityScope: SavedSegmentScope;
  folderId: string | null;
  lastCount: number | null;
  lastEvaluatedAt: string | null;
  updatedAt: string;
}
export interface SavedSegmentBookmarkList {
  items: SavedSegmentBookmark[];
  totalItems: number;
  maxItems: number;
}

function parseBookmark(value: unknown, tenantId: string): SavedSegmentBookmark {
  const row = rec(value);
  const pin = row?.pin_order;
  const folder = row?.folder_id;
  const lastCount = row?.last_count;
  const lastAt = row?.last_evaluated_at;
  if (
    !row ||
    row.tenant_id !== tenantId ||
    !id(row.id) ||
    !str(row.name, 120) ||
    typeof row.description !== "string" ||
    row.description.length > 1_000 ||
    typeof row.is_pinned !== "boolean" ||
    (pin !== undefined && pin !== null && !int(pin)) ||
    (row.visibility_scope !== "personal" &&
      row.visibility_scope !== "workspace") ||
    (folder !== undefined && folder !== null && !id(folder)) ||
    (lastCount !== undefined && lastCount !== null && !int(lastCount)) ||
    (lastAt !== undefined && lastAt !== null && !timestamp(lastAt)) ||
    !timestamp(row.updated_at)
  ) {
    throw new SegmentParityContractError("saved segment");
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isPinned: row.is_pinned,
    pinOrder: int(pin) ? pin : null,
    visibilityScope: row.visibility_scope,
    folderId: id(folder) ? folder : null,
    lastCount: int(lastCount) ? lastCount : null,
    lastEvaluatedAt: timestamp(lastAt) ? lastAt : null,
    updatedAt: row.updated_at,
  };
}

export async function listSavedSegmentBookmarks(
  tenantId: string,
  signal?: AbortSignal,
): Promise<SavedSegmentBookmarkList> {
  if (!id(tenantId)) throw new Error("Invalid workspace id.");
  const raw = rec(await api.get<unknown>("/api/v1/segments/saved", { signal }));
  const rows = Array.isArray(raw?.items) ? raw.items : null;
  if (
    !raw ||
    !rows ||
    rows.length > 200 ||
    !int(raw.total_items) ||
    !int(raw.max_items, 1, 200) ||
    raw.total_items > raw.max_items
  ) {
    throw new SegmentParityContractError("saved segment list");
  }
  const items = rows.map((value) => parseBookmark(value, tenantId));
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new SegmentParityContractError("saved segment list");
  return { items, totalItems: raw.total_items, maxItems: raw.max_items };
}

export type SavedSegmentBookmarkPatch = Partial<
  Pick<
    SavedSegmentBookmark,
    "isPinned" | "pinOrder" | "visibilityScope" | "folderId"
  >
>;
export async function patchSavedSegmentBookmark(
  savedId: string,
  patch: SavedSegmentBookmarkPatch,
  tenantId: string,
): Promise<SavedSegmentBookmark> {
  const keys = Object.keys(patch);
  if (
    !id(savedId) ||
    !id(tenantId) ||
    keys.length === 0 ||
    keys.some(
      (key) =>
        !["isPinned", "pinOrder", "visibilityScope", "folderId"].includes(key),
    ) ||
    (patch.isPinned !== undefined && typeof patch.isPinned !== "boolean") ||
    (patch.pinOrder !== undefined &&
      (patch.pinOrder === null || !int(patch.pinOrder))) ||
    (patch.visibilityScope !== undefined &&
      patch.visibilityScope !== "personal" &&
      patch.visibilityScope !== "workspace") ||
    (patch.folderId !== undefined &&
      patch.folderId !== null &&
      !id(patch.folderId))
  )
    throw new Error("Invalid saved segment update.");
  const body: Record<string, unknown> = {};
  if (patch.isPinned !== undefined) body.is_pinned = patch.isPinned;
  if (patch.pinOrder !== undefined) body.pin_order = patch.pinOrder;
  if (patch.visibilityScope !== undefined)
    body.visibility_scope = patch.visibilityScope;
  if (patch.folderId !== undefined) body.folder_id = patch.folderId ?? "";
  const raw = await api.patch<unknown>(
    `/api/v1/segments/saved/${encodeURIComponent(savedId)}`,
    body,
    { requireOnline: true, maxAttempts: 1 },
  );
  const parsed = parseBookmark(raw, tenantId);
  if (parsed.id !== savedId)
    throw new SegmentParityContractError("saved segment update");
  return parsed;
}

export interface SavedSegmentAggregatePreview {
  id: string;
  count: number;
  workspaceTotal: number;
  workspacePercentage: number;
  generatedAt: string;
}
export async function getSavedSegmentAggregatePreview(
  savedId: string,
  signal?: AbortSignal,
): Promise<SavedSegmentAggregatePreview> {
  if (!id(savedId)) throw new Error("Invalid saved segment id.");
  const raw = rec(
    await api.get<unknown>(
      `/api/v1/segments/saved/${encodeURIComponent(savedId)}/preview`,
      { signal },
    ),
  );
  if (
    !raw ||
    raw.id !== savedId ||
    !int(raw.count) ||
    !int(raw.workspace_total) ||
    raw.count > raw.workspace_total ||
    !finite(raw.workspace_percentage) ||
    raw.workspace_percentage < 0 ||
    raw.workspace_percentage > 100 ||
    !timestamp(raw.generated_at)
  ) {
    throw new SegmentParityContractError("saved segment preview");
  }
  return {
    id: savedId,
    count: raw.count,
    workspaceTotal: raw.workspace_total,
    workspacePercentage: raw.workspace_percentage,
    generatedAt: raw.generated_at,
  };
}

export interface StrictSegmentFolder {
  id: string;
  name: string;
}
function parseFolder(value: unknown, tenantId: string): StrictSegmentFolder {
  const row = rec(value);
  if (!row || row.tenant_id !== tenantId || !id(row.id) || !str(row.name, 120))
    throw new SegmentParityContractError("segment folder");
  return { id: row.id, name: row.name };
}
export async function listStrictSegmentFolders(
  tenantId: string,
  signal?: AbortSignal,
): Promise<StrictSegmentFolder[]> {
  const raw = rec(
    await api.get<unknown>("/api/v1/segment-folders", { signal }),
  );
  const rows = Array.isArray(raw?.items) ? raw.items : null;
  if (!rows || rows.length > 200)
    throw new SegmentParityContractError("segment folder list");
  const items = rows.map((value) => parseFolder(value, tenantId));
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new SegmentParityContractError("segment folder list");
  return items;
}
export async function createStrictSegmentFolder(
  name: string,
  tenantId: string,
): Promise<StrictSegmentFolder> {
  const trimmed = name.trim();
  if (
    !trimmed ||
    [...trimmed].length > 120 ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  )
    throw new Error("Enter a valid folder name.");
  return parseFolder(
    await api.post<unknown>(
      "/api/v1/segment-folders",
      { name: trimmed },
      { requireOnline: true, maxAttempts: 1 },
    ),
    tenantId,
  );
}
export async function renameStrictSegmentFolder(
  folderId: string,
  name: string,
  tenantId: string,
): Promise<StrictSegmentFolder> {
  const trimmed = name.trim();
  if (
    !id(folderId) ||
    !trimmed ||
    [...trimmed].length > 120 ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  )
    throw new Error("Enter a valid folder name.");
  const row = parseFolder(
    await api.patch<unknown>(
      `/api/v1/segment-folders/${encodeURIComponent(folderId)}`,
      { name: trimmed },
      { requireOnline: true, maxAttempts: 1 },
    ),
    tenantId,
  );
  if (row.id !== folderId)
    throw new SegmentParityContractError("segment folder update");
  return row;
}
export async function deleteStrictSegmentFolder(
  folderId: string,
): Promise<void> {
  if (!id(folderId)) throw new Error("Invalid folder id.");
  const raw = rec(
    await api.delete<unknown>(
      `/api/v1/segment-folders/${encodeURIComponent(folderId)}`,
      { requireOnline: true, maxAttempts: 1 },
    ),
  );
  if (raw?.ok !== true)
    throw new SegmentParityContractError("segment folder deletion");
}
