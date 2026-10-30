// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks }));

import {
  createWorkspaceGoal,
  deleteWorkspaceGoal,
  getGoalProgress,
  goalDraftError,
  listAllGoalDefinitions,
  normalizeGoalDraft,
  sameGoalRevision,
  updateWorkspaceGoal,
  type GoalDraft,
} from "@/lib/goals-admin-api";

const TENANT = "11111111-1111-4111-8111-111111111111";

function wireGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Monthly audience",
    metric: "subscribers",
    target: 1000,
    period: "monthly",
    starts_at: "2026-08-01T00:00:00Z",
    created_by: "33333333-3333-4333-8333-333333333333",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-30T10:00:00Z",
    ...overrides,
  };
}

function draft(overrides: Partial<GoalDraft> = {}): GoalDraft {
  return {
    name: "Monthly audience",
    metric: "subscribers",
    target: "1000",
    period: "monthly",
    startsAt: "2026-08-01T00:00",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("goals admin API", () => {
  it("strictly decodes a tenant-bound progress snapshot and reconciles target/as_of", async () => {
    mocks.get.mockResolvedValue({
      progress: [
        {
          goal: wireGoal(),
          current: 750,
          target: 1000,
          pct: 0.75,
          pace: "ahead",
          period_start: "2026-08-01T00:00:00Z",
          period_end: "2026-09-01T00:00:00Z",
          as_of: "2026-08-30T10:05:00Z",
        },
      ],
      as_of: "2026-08-30T10:05:00Z",
    });

    await expect(getGoalProgress(TENANT, { fresh: true })).resolves.toMatchObject({
      tenantId: TENANT,
      progress: [{ pace: "ahead", current: 750, goal: { metric: "subscribers" } }],
    });
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/goals/progress", {
      signal: undefined,
      requireOnline: true,
      maxAttempts: 1,
      cache: "no-store",
    });
  });

  it.each([
    ["unknown pace", { pace: "fast" }],
    ["target mismatch", { target: 999 }],
    ["row timestamp mismatch", { as_of: "2026-08-30T10:06:00Z" }],
    ["backwards period", { period_end: "2026-07-01T00:00:00Z" }],
  ])("fails closed on %s", async (_label, rowOverride) => {
    mocks.get.mockResolvedValue({
      progress: [
        {
          goal: wireGoal(),
          current: 750,
          target: 1000,
          pct: 0.75,
          pace: "ahead",
          period_start: "2026-08-01T00:00:00Z",
          period_end: "2026-09-01T00:00:00Z",
          as_of: "2026-08-30T10:05:00Z",
          ...rowOverride,
        },
      ],
      as_of: "2026-08-30T10:05:00Z",
    });
    await expect(getGoalProgress(TENANT)).rejects.toThrow();
  });

  it("exhausts advancing keyset pages and rejects duplicate rows across pages", async () => {
    mocks.get
      .mockResolvedValueOnce({ goals: [wireGoal()], nextCursor: "next-1" })
      .mockResolvedValueOnce({
        goals: [
          wireGoal({
            id: "44444444-4444-4444-8444-444444444444",
            name: "Open rate",
            metric: "open_rate",
            target: 45,
          }),
        ],
      });
    await expect(listAllGoalDefinitions(TENANT, { fresh: true })).resolves.toHaveLength(2);
    expect(mocks.get).toHaveBeenNthCalledWith(
      2,
      "/api/v1/goals?limit=100&cursor=next-1",
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );

    mocks.get
      .mockReset()
      .mockResolvedValueOnce({ goals: [wireGoal()], nextCursor: "next-1" })
      .mockResolvedValueOnce({ goals: [wireGoal()] });
    await expect(listAllGoalDefinitions(TENANT)).rejects.toThrow(/duplicate/u);
  });

  it("normalizes metric units and bounds UTF-8 input", () => {
    expect(
      normalizeGoalDraft(
        draft({ metric: "revenue_cents", target: "$1,234.56" }),
      ).target,
    ).toBe(123456);
    expect(
      goalDraftError(draft({ metric: "open_rate", target: "101" })),
    ).toMatch(/100%/u);
    expect(goalDraftError(draft({ name: "é".repeat(61) }))).toMatch(/UTF-8/u);
    expect(goalDraftError(draft({ target: "1.5" }))).toMatch(/whole/u);
  });

  it("creates online once, verifies the receipt, and includes the pacing anchor", async () => {
    const startsAt = new Date(draft().startsAt).toISOString();
    mocks.post.mockResolvedValue(wireGoal({ starts_at: startsAt }));
    await expect(createWorkspaceGoal(draft())).resolves.toMatchObject({
      id: wireGoal().id,
      target: 1000,
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/goals",
      {
        name: "Monthly audience",
        metric: "subscribers",
        target: 1000,
        period: "monthly",
        starts_at: startsAt,
      },
      { requireOnline: true, maxAttempts: 1, signal: undefined },
    );
  });

  it("sends the exact baseline revision on update and delete", async () => {
    const signal = new AbortController().signal;
    mocks.get.mockResolvedValue({ goals: [wireGoal()] });
    const [baseline] = await listAllGoalDefinitions(TENANT);
    expect(baseline).toBeDefined();
    if (!baseline) return;
    const startsAt = new Date(draft().startsAt).toISOString();
    mocks.patch.mockResolvedValue(
      wireGoal({
        target: 1200,
        starts_at: startsAt,
        updated_at: "2026-08-30T10:10:00Z",
      }),
    );
    await expect(
      updateWorkspaceGoal(baseline, draft({ target: "1200" }), signal),
    ).resolves.toMatchObject({ target: 1200 });
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/goals/${baseline.id}`,
      expect.objectContaining({
        target: 1200,
        expected_updated_at: baseline.updatedAt,
      }),
      { requireOnline: true, maxAttempts: 1, signal },
    );

    mocks.delete.mockResolvedValue(undefined);
    await deleteWorkspaceGoal(baseline, signal);
    const deletePath = mocks.delete.mock.calls[0]?.[0] as string;
    expect(deletePath).toContain(`/api/v1/goals/${baseline.id}?`);
    expect(new URL(deletePath, "https://postwave.test").searchParams.get("expected_updated_at")).toBe(
      baseline.updatedAt,
    );
    expect(mocks.delete.mock.calls[0]?.[1]).toEqual({
      requireOnline: true,
      maxAttempts: 1,
      signal,
    });
  });

  it("detects exact revision changes", async () => {
    mocks.get.mockResolvedValue({ goals: [wireGoal()] });
    const [goal] = await listAllGoalDefinitions(TENANT);
    expect(goal).toBeDefined();
    if (!goal) return;
    expect(sameGoalRevision(goal, { ...goal })).toBe(true);
    expect(
      sameGoalRevision(goal, {
        ...goal,
        updatedAt: "2026-08-30T10:10:00Z",
      }),
    ).toBe(false);
  });
});
