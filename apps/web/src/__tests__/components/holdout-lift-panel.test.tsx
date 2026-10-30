// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  getHoldout: vi.fn(),
  getHoldoutLift: vi.fn(),
  deleteHoldout: vi.fn(),
  confirmAdmin: vi.fn(),
}));

vi.mock("@/lib/campaign-write-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaign-write-authority")>()),
  confirmFreshCampaignAdminAuthority: mocks.confirmAdmin,
}));

vi.mock("@/lib/holdout-lift", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/holdout-lift")>();
  return {
    ...original,
    getHoldout: mocks.getHoldout,
    getHoldoutLift: mocks.getHoldoutLift,
    deleteHoldout: mocks.deleteHoldout,
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { HoldoutLiftPanel } from "@/components/campaigns/holdout-lift-panel";
import { ApiError } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";

const ADMIN: MeResponse = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "admin@example.test",
  role: "admin",
  effective_role: "admin",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.getHoldout.mockReset();
  mocks.getHoldoutLift.mockReset();
  mocks.deleteHoldout.mockReset();
  mocks.deleteHoldout.mockResolvedValue(undefined);
  mocks.confirmAdmin.mockReset();
  mocks.confirmAdmin.mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("HoldoutLiftPanel holdout discovery", () => {
  it("stays silent for a viewer when the server confirms no holdout exists", async () => {
    mocks.getHoldout.mockRejectedValue(new ApiError("not found", 404));

    renderPanel(false);

    await waitFor(() => {
      expect(mocks.getHoldout).toHaveBeenCalledOnce();
      expect(document.body.textContent).not.toContain("Incremental lift");
      expect(document.querySelector('[role="alert"]')).toBeNull();
    });
  });

  it("offers setup to an admin only for a confirmed missing holdout", async () => {
    mocks.getHoldout.mockRejectedValue(new ApiError("not found", 404));

    renderPanel(true);

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Measure what this campaign causes",
      );
      expect(document.body.textContent).toContain("Set up holdout");
    });
  });

  it("fails loudly on a service error instead of pretending the holdout is absent", async () => {
    mocks.getHoldout.mockRejectedValue(new ApiError("unavailable", 503));

    renderPanel(true);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Incremental lift");
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "This is not a result of zero",
      );
      expect(document.body.textContent).not.toContain("Set up holdout");
    });
  });

  it("lets an admin remove only an undecided holdout through confirmation", async () => {
    mocks.getHoldout.mockResolvedValue({
      campaign_id: "campaign-1",
      percent: 10,
      seed: "opaque",
      held_out_count: 0,
      sent_count: 0,
      outcome_metric: "click",
      conversion_window_days: 7,
      minimum_relative_effect: 0.05,
      created_at: "2026-08-30T00:00:00Z",
      updated_at: "2026-08-30T00:00:00Z",
    });
    mocks.getHoldoutLift.mockResolvedValue({
      campaign_id: "campaign-1",
      percent: 10,
      status: "pending",
    });

    renderPanel(true);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Remove unsent holdout");
    });

    const trigger = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Remove unsent holdout",
    );
    expect(trigger).toBeDefined();
    act(() => (trigger as HTMLButtonElement).click());
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });
    const confirm = [
      ...document.querySelectorAll('[role="dialog"] button'),
    ].find((button) => button.textContent?.trim() === "Remove holdout");
    expect(confirm).toBeDefined();
    await act(async () => {
      (confirm as HTMLButtonElement).click();
    });
    await waitFor(() =>
      expect(mocks.deleteHoldout).toHaveBeenCalledWith("campaign-1"),
    );
    expect(mocks.confirmAdmin).toHaveBeenCalledWith(ADMIN);
  });

  it("never offers deletion after the assignment evidence is frozen", async () => {
    mocks.getHoldout.mockResolvedValue({
      campaign_id: "campaign-1",
      percent: 10,
      seed: "opaque",
      decided_at: "2026-08-30T01:00:00Z",
      held_out_count: 50,
      sent_count: 450,
      outcome_metric: "click",
      conversion_window_days: 7,
      minimum_relative_effect: 0.05,
      assignment_ledger_version: "postwave.holdout-assignment.v2",
      assignment_ledger_sha256: "a".repeat(64),
      created_at: "2026-08-30T00:00:00Z",
      updated_at: "2026-08-30T01:00:00Z",
    });
    mocks.getHoldoutLift.mockResolvedValue({
      campaign_id: "campaign-1",
      percent: 10,
      status: "pending",
    });

    renderPanel(true);
    await waitFor(() => {
      expect(document.body.textContent).toContain("ledger aaaaaaaa");
      expect(document.body.textContent).not.toContain("Remove unsent holdout");
    });
  });
});

function renderPanel(canConfigure: boolean): void {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <HoldoutLiftPanel
          campaignId="campaign-1"
          tenantId="tenant-1"
          role="admin"
          canConfigure={canConfigure}
          identity={ADMIN}
        />
      </QueryClientProvider>,
    );
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}
