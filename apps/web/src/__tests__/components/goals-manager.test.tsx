// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyAdmin: vi.fn(),
  progress: vi.fn(),
  listAll: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyAdmin,
}));
vi.mock("@/lib/goals-admin-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/goals-admin-api")>()),
  getGoalProgress: mocks.progress,
  listAllGoalDefinitions: mocks.listAll,
  createWorkspaceGoal: mocks.create,
  updateWorkspaceGoal: mocks.update,
  deleteWorkspaceGoal: mocks.remove,
}));

import { GoalsManager } from "@/app/(dashboard)/app/lifecycle/goals-manager";
import type { MeResponse } from "@/lib/auth-api";
import type {
  GoalProgressSnapshot,
  WorkspaceGoal,
} from "@/lib/goals-admin-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const IDENTITY: MeResponse = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.test",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Test",
  workspace_slug: "test",
};

const GOAL: WorkspaceGoal = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Audience growth",
  metric: "subscribers",
  target: 1000,
  period: "monthly",
  startsAt: "2026-08-01T00:00:00Z",
  createdBy: IDENTITY.user_id,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-30T10:00:00Z",
};

function snapshot(goal = GOAL): GoalProgressSnapshot {
  return {
    tenantId: IDENTITY.tenant_id,
    asOf: "2026-08-30T10:05:00Z",
    progress: [
      {
        goal,
        current: 750,
        target: goal.target,
        pct: 0.75,
        pace: "ahead",
        periodStart: "2026-08-01T00:00:00Z",
        periodEnd: "2026-09-01T00:00:00Z",
        asOf: "2026-08-30T10:05:00Z",
      },
    ],
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.verifyAdmin.mockResolvedValue(IDENTITY);
  mocks.progress.mockResolvedValue(snapshot());
  mocks.listAll.mockResolvedValue([GOAL]);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("GoalsManager", () => {
  it("renders server-computed current, target, period, and pace evidence", async () => {
    const root = render(IDENTITY);
    try {
      await flush();
      expect(document.body.textContent).toContain("Audience growth");
      expect(document.body.textContent).toContain("Ahead");
      expect(document.body.textContent).toContain("750");
      expect(document.body.textContent).toContain("1,000");
      expect(document.body.textContent).toContain("75% complete");
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps viewer-mode management read only", async () => {
    const root = render({ ...IDENTITY, viewer_mode: true, effective_role: "viewer" });
    try {
      await flush();
      expect(document.body.textContent).toContain("Goal management is read only");
      expect(button("New goal")).toBeNull();
      expect(button("Edit")).toBeNull();
      expect(mocks.verifyAdmin).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("creates only after review, exact definition readback, and progress refresh", async () => {
    const created = {
      ...GOAL,
      id: "44444444-4444-4444-8444-444444444444",
      name: "Quarter target",
      target: 1200,
      startsAt: "2026-08-30T10:06:00Z",
      createdAt: "2026-08-30T10:06:00Z",
      updatedAt: "2026-08-30T10:06:00Z",
    };
    let receipt: WorkspaceGoal | null = null;
    mocks.create.mockImplementation(
      async (draft: { name: string; target: string; startsAt: string }) => {
        receipt = {
          ...created,
          name: draft.name,
          target: Number(draft.target),
          startsAt: new Date(draft.startsAt).toISOString(),
        };
        return receipt;
      },
    );
    mocks.listAll.mockImplementation(async () => (receipt ? [receipt] : []));
    mocks.progress
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(
        snapshot({ ...created, name: "Quarter target", target: 1200 }),
      );
    const root = render(IDENTITY);
    try {
      await flush();
      await click(requiredButton("New goal"));
      await setInput(requiredInput("goal-name"), "Quarter target");
      await setInput(requiredInput("goal-target"), "1200");
      await check(requiredInput("goal-reviewed"));
      await click(requiredButton("Create goal"));
      await flush(10);

      expect(mocks.verifyAdmin).toHaveBeenCalledWith(
        IDENTITY,
        expect.any(AbortSignal),
      );
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Quarter target", target: "1200" }),
        expect.any(AbortSignal),
      );
      expect(mocks.listAll).toHaveBeenCalledWith(
        IDENTITY.tenant_id,
        expect.objectContaining({ fresh: true }),
      );
      expect(document.body.textContent).toContain("Goal created and confirmed");
    } finally {
      act(() => root.unmount());
    }
  });

  it("refuses to overwrite a goal whose fresh revision changed", async () => {
    mocks.listAll.mockResolvedValue([
      { ...GOAL, updatedAt: "2026-08-30T10:10:00Z" },
    ]);
    const root = render(IDENTITY);
    try {
      await flush();
      await click(requiredButton("Edit"));
      await setInput(requiredInput("goal-target"), "1200");
      await check(requiredInput("goal-reviewed"));
      await click(requiredButton("Save goal"));
      await flush(8);
      expect(mocks.update).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Nothing was overwritten");
    } finally {
      act(() => root.unmount());
    }
  });
});

function render(identity: MeResponse): Root {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(GoalsManager, { identity }),
      ),
    );
  });
  return root;
}

async function flush(times = 5): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function button(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    ) ?? null
  );
}

function requiredButton(label: string): HTMLButtonElement {
  const found = button(label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function requiredInput(id: string): HTMLInputElement {
  const found = document.getElementById(id);
  if (!(found instanceof HTMLInputElement)) throw new Error(`Missing input: ${id}`);
  return found;
}

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function setInput(target: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function check(target: HTMLInputElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
