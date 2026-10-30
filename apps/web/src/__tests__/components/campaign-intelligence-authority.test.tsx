// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MeResponse } from "@/lib/auth-api";

const mocks = vi.hoisted(() => ({
  cancelDelivery: vi.fn(),
  confirmWrite: vi.fn(),
  identity: undefined as MeResponse | undefined,
  queryKeys: [] as (readonly unknown[])[],
  refetch: vi.fn(),
  reportLoading: false,
}));

vi.mock("@/lib/campaign-write-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaign-write-authority")>()),
  confirmFreshCampaignWriteAuthority: mocks.confirmWrite,
}));

vi.mock("@/lib/mailchimp-compat-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mailchimp-compat-api")>()),
  cancelDelivery: mocks.cancelDelivery,
  getCampaignInbox: vi.fn(),
  getCampaignPlanner: vi.fn(),
  getClickMap: vi.fn(),
  getCustomReport: vi.fn(),
  getDeliveryInsights: vi.fn(),
  getMultivariateTest: vi.fn(),
  getSendDayOptimization: vi.fn(),
  getSendTimeOptimization: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly unknown[] }) => {
    mocks.queryKeys.push(options.queryKey);
    const common = {
      error: null,
      isError: false,
      isFetched: true,
      isFetching: false,
      isPending: false,
      refetch: mocks.refetch,
    };
    const surface = options.queryKey[0];
    if (surface === "auth-me") return { ...common, data: mocks.identity };
    if (surface === "campaign-planner") {
      return { ...common, data: { tasks: [], touchpoints: [] } };
    }
    if (surface === "custom-report") {
      return {
        ...common,
        isFetching: mocks.reportLoading,
        data: { graph: [], metrics: [], rows: [] },
      };
    }
    if (surface === "campaign-intel") {
      return {
        ...common,
        data: {
          clickMap: { links: [], total_clicks: 0 },
          delivery: {
            can_cancel: true,
            delivery_status: "sending",
            progress: {},
            status: "sending",
            warnings: [],
          },
          inbox: { follow_up_open: false, replies: [], total_items: 0 },
          multivariate: {
            enabled: false,
            report: [],
            variations: [],
            winner_metric: "opens",
          },
          sendDay: { recommendation: { label: "Learning" } },
          sendTime: { recommendation: { label: "Learning" } },
        },
      };
    }
    return { ...common, data: undefined };
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { CampaignIntelligencePanel } from "@/components/mailchimp-parity/campaign-intelligence-panel";

const EDITOR: MeResponse = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "editor@example.test",
  role: "editor",
  effective_role: "editor",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

let root: Root | null = null;

beforeEach(() => {
  mocks.identity = EDITOR;
  mocks.reportLoading = false;
  mocks.queryKeys.length = 0;
  mocks.cancelDelivery.mockReset();
  mocks.cancelDelivery.mockResolvedValue(undefined);
  mocks.confirmWrite.mockReset();
  mocks.confirmWrite.mockResolvedValue(undefined);
  mocks.refetch.mockReset();
  mocks.refetch.mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("campaign intelligence write authority", () => {
  it.each([true, false])(
    "prevents exporting the previous report while a new selection loads (%s)",
    (loading) => {
      mocks.reportLoading = loading;
      render();
      expect(button("CSV").disabled).toBe(loading);
    },
  );

  it("revalidates the opened identity immediately before delivery cancellation", async () => {
    render();
    act(() => button("Cancel in-flight delivery").click());
    await act(async () => button("Cancel delivery").click());

    expect(mocks.confirmWrite).toHaveBeenCalledWith(EDITOR);
    expect(mocks.cancelDelivery).toHaveBeenCalledWith("campaign-1");
    expect(mocks.confirmWrite.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.cancelDelivery.mock.invocationCallOrder[0]!,
    );
  });

  it("isolates viewer-mode queries and removes the cancellation control", () => {
    mocks.identity = {
      ...EDITOR,
      role: "admin",
      effective_role: "viewer",
      viewer_mode: true,
    };
    render();

    expect(document.body.textContent).not.toContain(
      "Cancel in-flight delivery",
    );
    const campaignKey = mocks.queryKeys.find(
      (key) => key[0] === "campaign-intel",
    );
    expect(campaignKey).toContain("viewer");
    expect(campaignKey).not.toContain("admin");
    expect(mocks.confirmWrite).not.toHaveBeenCalled();
    expect(mocks.cancelDelivery).not.toHaveBeenCalled();
  });
});

function render(): void {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(CampaignIntelligencePanel, { campaignId: "campaign-1" }),
    );
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.includes(label));
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}
