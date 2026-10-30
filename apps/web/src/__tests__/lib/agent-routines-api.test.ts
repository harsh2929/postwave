// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.delete,
  },
}));
vi.mock("@/lib/auth-api", () => ({
  effectiveAuthRole: (identity: { effective_role?: string; role: string }) =>
    identity.effective_role ?? identity.role,
  whoamiFresh: mocks.whoamiFresh,
}));

import {
  createAgentRoutine,
  listAgentRoutineRuns,
  listAgentRoutines,
  runAgentRoutine,
  updateAgentRoutine,
  verifyFreshRoutineAuthority,
  type AgentRoutine,
} from "@/lib/agent-routines-api";
import type { MeResponse } from "@/lib/auth-api";

const ROUTINE_ID = "11111111-1111-4111-8111-111111111111";
const SEGMENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";

const routineWire = (overrides: Record<string, unknown> = {}) => ({
  id: ROUTINE_ID,
  name: "Weekly re-engagement",
  prompt: "Draft a re-engagement campaign.",
  kind: "draft_campaign",
  schedule: "weekly",
  schedule_detail: {},
  target_segment_id: SEGMENT_ID,
  require_approval: true,
  enabled: true,
  has_active_run: false,
  created_by: "owner@example.test",
  created_at: "2026-08-30T10:00:00Z",
  updated_at: "2026-08-30T10:01:00Z",
  ...overrides,
});

const draft = {
  name: "Weekly re-engagement",
  prompt: "Draft a re-engagement campaign.",
  kind: "draft_campaign" as const,
  schedule: "weekly" as const,
  targetSegmentId: SEGMENT_ID,
  requireApproval: true,
  enabled: true,
};

beforeEach(() => vi.clearAllMocks());

describe("agent routines web client", () => {
  it("strictly decodes the canonical collection and rejects unknown fields", async () => {
    mocks.get.mockResolvedValue({ items: [routineWire()] });
    await expect(listAgentRoutines()).resolves.toMatchObject([
      {
        id: ROUTINE_ID,
        schedule: "weekly",
        targetSegmentId: SEGMENT_ID,
        requireApproval: true,
      },
    ]);
    mocks.get.mockResolvedValue({
      items: [routineWire({ next_run_at: "2026-09-01T00:00:00Z" })],
    });
    await expect(listAgentRoutines()).rejects.toThrow(/unexpected field/u);
  });

  it("creates online without automatic retries and validates the receipt", async () => {
    const signal = new AbortController().signal;
    mocks.post.mockResolvedValue(routineWire());
    await expect(createAgentRoutine(draft, signal)).resolves.toMatchObject({
      id: ROUTINE_ID,
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/agent-routines",
      {
        name: draft.name,
        prompt: draft.prompt,
        kind: draft.kind,
        schedule: draft.schedule,
        target_segment_id: SEGMENT_ID,
        require_approval: true,
        enabled: true,
      },
      { requireOnline: true, maxAttempts: 1, signal },
    );
  });

  it("uses empty strings for explicit target clears and legacy cleanup", async () => {
    mocks.get.mockResolvedValue({
      items: [
        routineWire({
          target_list_id: "44444444-4444-4444-8444-444444444444",
        }),
      ],
    });
    const [baseline] = await listAgentRoutines();
    expect(baseline).toBeDefined();
    const { target_segment_id: _clearedTarget, ...clearedWire } = routineWire();
    mocks.patch.mockResolvedValue(clearedWire);
    await updateAgentRoutine(baseline as AgentRoutine, {
      ...draft,
      targetSegmentId: "",
      clearLegacyTargetList: true,
    });
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/agent-routines/${ROUTINE_ID}`,
      { target_segment_id: "", target_list_id: "" },
      { requireOnline: true, maxAttempts: 1, signal: undefined },
    );
  });

  it("fails closed on a cross-routine run ledger and accepts only running receipts", async () => {
    mocks.get.mockResolvedValue({
      items: [
        {
          id: RUN_ID,
          routine_id: "55555555-5555-4555-8555-555555555555",
          status: "running",
          started_at: "2026-08-30T10:00:00Z",
        },
      ],
    });
    await expect(listAgentRoutineRuns(ROUTINE_ID)).rejects.toThrow(
      /another routine/u,
    );

    mocks.post.mockResolvedValue({ run_id: RUN_ID, status: "running" });
    await expect(runAgentRoutine(ROUTINE_ID)).resolves.toEqual({
      runId: RUN_ID,
      status: "running",
    });
    expect(mocks.post).toHaveBeenCalledWith(
      `/api/v1/agent-routines/${ROUTINE_ID}/run`,
      {},
      { requireOnline: true, maxAttempts: 1, signal: undefined },
    );
  });

  it("rechecks exact identity/role/viewer mode for editor-domain writes", async () => {
    const opened: MeResponse = {
      user_id: "user-1",
      tenant_id: "tenant-1",
      email: "editor@example.test",
      role: "editor",
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Test",
      workspace_slug: "test",
    };
    mocks.whoamiFresh.mockResolvedValue(opened);
    await expect(verifyFreshRoutineAuthority(opened)).resolves.toBe(opened);
    mocks.whoamiFresh.mockResolvedValue({ ...opened, role: "viewer" });
    await expect(verifyFreshRoutineAuthority(opened)).rejects.toThrow(
      /authority changed/u,
    );
    mocks.whoamiFresh.mockResolvedValue({ ...opened, viewer_mode: true });
    await expect(verifyFreshRoutineAuthority(opened)).rejects.toThrow();
  });
});
