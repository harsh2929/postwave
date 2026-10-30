// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";

const FRESH_READ_OPTIONS = {
  requireOnline: true,
  maxAttempts: 1,
  cache: "no-store",
} as const;
const WRITE_OPTIONS = { requireOnline: true, maxAttempts: 1 } as const;
const MAX_GOALS_PER_PAGE = 100;
const MAX_GOALS_ACROSS_PAGES = 10_000;
const MAX_CURSOR_BYTES = 2_048;
const MAX_NAME_BYTES = 120;

export const GOAL_METRICS = [
  "subscribers",
  "open_rate",
  "revenue_cents",
  "list_growth",
] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];

export const GOAL_PERIODS = ["monthly", "quarterly"] as const;
export type GoalPeriod = (typeof GOAL_PERIODS)[number];

export const GOAL_PACES = ["ahead", "on_track", "behind"] as const;
export type GoalPace = (typeof GOAL_PACES)[number];

export interface WorkspaceGoal {
  id: string;
  name: string;
  metric: GoalMetric;
  target: number;
  period: GoalPeriod;
  startsAt: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceGoalProgress {
  goal: WorkspaceGoal;
  current: number;
  target: number;
  pct: number;
  pace: GoalPace;
  periodStart: string;
  periodEnd: string;
  asOf: string;
}

export interface GoalProgressSnapshot {
  /**
   * The goal wire rows do not repeat tenant_id. This local binding records the
   * authenticated workspace used for the request and is compared again before
   * every write; the server's tenant context remains the data boundary.
   */
  tenantId: string;
  asOf: string;
  progress: WorkspaceGoalProgress[];
}

export interface GoalDraft {
  name: string;
  metric: GoalMetric;
  target: string;
  period: GoalPeriod;
  startsAt: string;
}

export interface NormalizedGoalDraft {
  name: string;
  metric: GoalMetric;
  target: number;
  period: GoalPeriod;
  starts_at: string;
}

interface GoalPage {
  goals: WorkspaceGoal[];
  nextCursor: string | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedText(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") throw new Error(`Invalid goal ${label}`);
  if (
    utf8Bytes(value) > maxBytes ||
    (!allowEmpty && value.trim().length === 0)
  ) {
    throw new Error(`Invalid goal ${label}`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = boundedText(value, label, 128);
  if (
    !/^\d{4}-\d{2}-\d{2}T/u.test(text) ||
    !Number.isFinite(Date.parse(text)) ||
    text.startsWith("0001-01-01")
  ) {
    throw new Error(`Invalid goal ${label}`);
  }
  return text;
}

function finiteNumber(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid goal ${label}`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`Invalid goal ${label}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`Invalid goal ${label}`);
  }
  return value;
}

function closedValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  ) {
    throw new Error(`Invalid goal ${label}`);
  }
  return value as T[number];
}

function parseGoal(value: unknown): WorkspaceGoal {
  if (!record(value)) throw new Error("Invalid goal row");
  const goal: WorkspaceGoal = {
    id: boundedText(value.id, "id", 128),
    name: boundedText(value.name ?? "", "name", MAX_NAME_BYTES, true),
    metric: closedValue(value.metric, GOAL_METRICS, "metric"),
    target: finiteNumber(value.target, "target", {
      min: Number.MIN_VALUE,
      max: Number.MAX_SAFE_INTEGER,
    }),
    period: closedValue(value.period, GOAL_PERIODS, "period"),
    startsAt: timestamp(value.starts_at, "starts_at"),
    createdBy:
      value.created_by === undefined || value.created_by === null
        ? ""
        : boundedText(value.created_by, "created_by", 128, true),
    createdAt: timestamp(value.created_at, "created_at"),
    updatedAt: timestamp(value.updated_at, "updated_at"),
  };
  if (goal.metric === "open_rate" && goal.target > 100) {
    throw new Error("Invalid goal target");
  }
  if (
    goal.metric !== "open_rate" &&
    (!Number.isSafeInteger(goal.target) || goal.target < 1)
  ) {
    throw new Error("Invalid goal target");
  }
  if (Date.parse(goal.updatedAt) < Date.parse(goal.createdAt)) {
    throw new Error("Invalid goal revision timestamps");
  }
  return goal;
}

function parseGoalPage(value: unknown): GoalPage {
  if (
    !record(value) ||
    !Array.isArray(value.goals) ||
    value.goals.length > MAX_GOALS_PER_PAGE
  ) {
    throw new Error("Invalid goals response");
  }
  const nextCursor =
    value.nextCursor === undefined || value.nextCursor === null
      ? null
      : boundedText(value.nextCursor, "next cursor", MAX_CURSOR_BYTES);
  const goals = value.goals.map(parseGoal);
  if (new Set(goals.map((goal) => goal.id)).size !== goals.length) {
    throw new Error("Invalid duplicate goal row");
  }
  return { goals, nextCursor };
}

function parseProgress(value: unknown): Omit<GoalProgressSnapshot, "tenantId"> {
  if (
    !record(value) ||
    !Array.isArray(value.progress) ||
    value.progress.length > MAX_GOALS_PER_PAGE
  ) {
    throw new Error("Invalid goal progress response");
  }
  const envelopeAsOf = timestamp(value.as_of, "progress as_of");
  const progress = value.progress.map((candidate) => {
    if (!record(candidate)) throw new Error("Invalid goal progress row");
    const goal = parseGoal(candidate.goal);
    const current = finiteNumber(candidate.current, "current", {
      min: -Number.MAX_SAFE_INTEGER,
      max: Number.MAX_SAFE_INTEGER,
    });
    const target = finiteNumber(candidate.target, "progress target", {
      min: Number.MIN_VALUE,
      max: Number.MAX_SAFE_INTEGER,
    });
    const pct = finiteNumber(candidate.pct, "progress pct", {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    });
    const pace = closedValue(candidate.pace, GOAL_PACES, "pace");
    const periodStart = timestamp(candidate.period_start, "period_start");
    const periodEnd = timestamp(candidate.period_end, "period_end");
    const asOf = timestamp(candidate.as_of, "row as_of");
    if (
      target !== goal.target ||
      asOf !== envelopeAsOf ||
      Date.parse(periodStart) >= Date.parse(periodEnd)
    ) {
      throw new Error("Inconsistent goal progress response");
    }
    return {
      goal,
      current,
      target,
      pct,
      pace,
      periodStart,
      periodEnd,
      asOf,
    };
  });
  if (
    new Set(progress.map((row) => row.goal.id)).size !== progress.length
  ) {
    throw new Error("Invalid duplicate goal progress row");
  }
  return { asOf: envelopeAsOf, progress };
}

function normalizeTenantId(value: string): string {
  const tenantId = value.trim();
  if (!tenantId || utf8Bytes(tenantId) > 128) {
    throw new Error("A verified workspace is required");
  }
  return tenantId;
}

export async function getGoalProgress(
  expectedTenantId: string,
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<GoalProgressSnapshot> {
  const tenantId = normalizeTenantId(expectedTenantId);
  const decoded = parseProgress(
    await api.get<unknown>("/api/v1/goals/progress", {
      signal: options.signal,
      ...(options.fresh ? FRESH_READ_OPTIONS : {}),
    }),
  );
  return { tenantId, ...decoded };
}

export async function listGoalDefinitions(
  expectedTenantId: string,
  options: {
    signal?: AbortSignal;
    fresh?: boolean;
    cursor?: string;
  } = {},
): Promise<GoalPage> {
  normalizeTenantId(expectedTenantId);
  const cursor = options.cursor?.trim();
  if (cursor && utf8Bytes(cursor) > MAX_CURSOR_BYTES) {
    throw new Error("Invalid goals cursor");
  }
  const query = new URLSearchParams({ limit: String(MAX_GOALS_PER_PAGE) });
  if (cursor) query.set("cursor", cursor);
  return parseGoalPage(
    await api.get<unknown>(`/api/v1/goals?${query.toString()}`, {
      signal: options.signal,
      ...(options.fresh ? FRESH_READ_OPTIONS : {}),
    }),
  );
}

/** Exhausts keyset pages for exact mutation preflight/readback evidence. */
export async function listAllGoalDefinitions(
  expectedTenantId: string,
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<WorkspaceGoal[]> {
  const rows: WorkspaceGoal[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await listGoalDefinitions(expectedTenantId, {
      ...options,
      cursor,
    });
    for (const goal of page.goals) {
      if (ids.has(goal.id)) throw new Error("Invalid duplicate goal page row");
      ids.add(goal.id);
      rows.push(goal);
      if (rows.length > MAX_GOALS_ACROSS_PAGES) {
        throw new Error("Goal registry exceeds the supported review bound");
      }
    }
    if (!page.nextCursor) return rows;
    if (cursors.has(page.nextCursor)) {
      throw new Error("Goal pagination did not advance");
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export function normalizeGoalDraft(draft: GoalDraft): NormalizedGoalDraft {
  const name = draft.name.trim();
  if (utf8Bytes(name) > MAX_NAME_BYTES) {
    throw new Error("Goal name must be 120 UTF-8 bytes or fewer.");
  }
  const metric = closedValue(draft.metric, GOAL_METRICS, "metric");
  const period = closedValue(draft.period, GOAL_PERIODS, "period");
  const cleanedTarget = draft.target.replace(/[$,%\s]/gu, "");
  const enteredTarget = Number(cleanedTarget);
  if (!cleanedTarget || !Number.isFinite(enteredTarget) || enteredTarget <= 0) {
    throw new Error("Target must be a number greater than zero.");
  }
  let target = enteredTarget;
  if (metric === "open_rate") {
    if (enteredTarget > 100) {
      throw new Error("Open-rate target cannot exceed 100%.");
    }
  } else if (metric === "revenue_cents") {
    target = Math.round(enteredTarget * 100);
    if (!Number.isSafeInteger(target) || target < 1) {
      throw new Error("Revenue target must fit in whole cents.");
    }
  } else if (!Number.isSafeInteger(enteredTarget)) {
    throw new Error("Subscriber targets must be whole numbers.");
  }
  if (!Number.isSafeInteger(target) && metric !== "open_rate") {
    throw new Error("Target exceeds the supported numeric range.");
  }
  const startsAtDate = new Date(draft.startsAt);
  if (!draft.startsAt.trim() || Number.isNaN(startsAtDate.getTime())) {
    throw new Error("Choose a valid pacing anchor date and time.");
  }
  const starts_at = startsAtDate.toISOString();
  const normalized = { name, metric, target, period, starts_at };
  if (utf8Bytes(JSON.stringify(normalized)) > 8_192) {
    throw new Error("Goal request is too large.");
  }
  return normalized;
}

export function goalDraftError(draft: GoalDraft): string | null {
  try {
    normalizeGoalDraft(draft);
    return null;
  } catch (caught) {
    return caught instanceof Error ? caught.message : "Invalid goal draft";
  }
}

export async function createWorkspaceGoal(
  draft: GoalDraft,
  signal?: AbortSignal,
): Promise<WorkspaceGoal> {
  const input = normalizeGoalDraft(draft);
  const created = parseGoal(
    await api.post<unknown>("/api/v1/goals", input, {
      ...WRITE_OPTIONS,
      signal,
    }),
  );
  if (!sameGoalConfiguration(created, input)) {
    throw new Error("Goal creation receipt did not match the reviewed draft");
  }
  return created;
}

export async function updateWorkspaceGoal(
  baseline: WorkspaceGoal,
  draft: GoalDraft,
  signal?: AbortSignal,
): Promise<WorkspaceGoal> {
  const input = normalizeGoalDraft(draft);
  if (input.metric !== baseline.metric) {
    throw new Error("A goal metric cannot change after creation");
  }
  const updated = parseGoal(
    await api.patch<unknown>(
      `/api/v1/goals/${encodeURIComponent(baseline.id)}`,
      {
        name: input.name,
        target: input.target,
        period: input.period,
        starts_at: input.starts_at,
        expected_updated_at: baseline.updatedAt,
      },
      { ...WRITE_OPTIONS, signal },
    ),
  );
  if (
    updated.id !== baseline.id ||
    updated.metric !== baseline.metric ||
    !sameGoalConfiguration(updated, input)
  ) {
    throw new Error("Goal update receipt did not match the reviewed draft");
  }
  return updated;
}

export async function deleteWorkspaceGoal(
  baseline: WorkspaceGoal,
  signal?: AbortSignal,
): Promise<void> {
  const query = new URLSearchParams({
    expected_updated_at: baseline.updatedAt,
  });
  await api.delete<void>(
    `/api/v1/goals/${encodeURIComponent(baseline.id)}?${query.toString()}`,
    { ...WRITE_OPTIONS, signal },
  );
}

export function sameGoalRevision(
  left: WorkspaceGoal,
  right: WorkspaceGoal,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.metric === right.metric &&
    left.target === right.target &&
    left.period === right.period &&
    left.startsAt === right.startsAt &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

export function sameGoalConfiguration(
  goal: WorkspaceGoal,
  expected: NormalizedGoalDraft,
): boolean {
  return (
    goal.name === expected.name &&
    goal.metric === expected.metric &&
    goal.target === expected.target &&
    goal.period === expected.period &&
    Date.parse(goal.startsAt) === Date.parse(expected.starts_at)
  );
}

export function goalTargetInput(goal: WorkspaceGoal): string {
  return goal.metric === "revenue_cents"
    ? String(goal.target / 100)
    : String(goal.target);
}

export function goalDateTimeLocal(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function newGoalDraft(now = new Date()): GoalDraft {
  return {
    name: "",
    metric: "subscribers",
    target: "",
    period: "monthly",
    startsAt: goalDateTimeLocal(now.toISOString()),
  };
}
