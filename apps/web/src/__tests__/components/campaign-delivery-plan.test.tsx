// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Desktop gap campaigns-108 (schedule by best send time) and campaigns-36
// (personalized send window). Only the READ-ONLY preview reaches the network;
// the durable commit stays behind this app's scheduling release hold, and
// these tests pin both halves.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ApiModule from "@/lib/api";
import type * as CampaignsApi from "@/lib/campaigns-api";
import type { MeResponse } from "@/lib/auth-api";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  listCampaigns: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, post: mocks.post } };
});

vi.mock("@/lib/campaigns-api", async (importOriginal) => {
  const actual = await importOriginal<typeof CampaignsApi>();
  return { ...actual, listCampaigns: mocks.listCampaigns };
});

import { CAMPAIGN_SCHEDULING_RELEASE_HOLD } from "@/lib/campaigns-api";
import { CampaignDeliveryPlan } from "@/app/(dashboard)/app/settings/send-time/campaign-delivery-plan";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CAMPAIGN_ID = "00000000-0000-4000-8000-0000000000c1";
const roots: Root[] = [];

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: "sto-admin",
    tenant_id: "00000000-0000-4000-8000-000000000001",
    email: "sto-admin@example.test",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Send-time workspace",
    workspace_slug: "send-time-workspace",
    ...overrides,
  };
}

function previewResponse(overrides: Record<string, unknown> = {}) {
  const distribution = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    count: hour === 9 ? 30 : hour === 14 ? 10 : 0,
  }));
  return {
    campaign_id: CAMPAIGN_ID,
    scheduled: 40,
    within_days: 7,
    tenant_mean: 9,
    truncated: false,
    hard_cap: 250_000,
    strategy: "per_recipient",
    reference_at: "2026-09-10T00:00:00Z",
    distribution,
    max_per_minute: 4,
    max_per_day: 30,
    peak_day_utc: "2026-09-11",
    tier_cap_today: 25,
    warmup_cap_breach: true,
    counted_at: "2026-09-10T00:00:00Z",
    ...overrides,
  };
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === label,
  );
}

function selectOption(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

async function renderPlan(identity = me()) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, networkMode: "always", gcTime: 0 },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <CampaignDeliveryPlan identity={identity} baseKey={["send-time"]} />
      </QueryClientProvider>,
    );
  });
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listCampaigns.mockResolvedValue([
    { id: CAMPAIGN_ID, name: "September letter", status: "draft" },
    { id: "sent-one", name: "Already sent", status: "sent" },
  ]);
  mocks.post.mockResolvedValue(previewResponse());
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("CampaignDeliveryPlan", () => {
  it("previews the schedule with the chosen strategy and window, and never commits", async () => {
    const container = await renderPlan();
    await eventually(() =>
      expect(container.textContent).toContain("September letter"),
    );

    // A campaign that already sent is not a schedulable target.
    expect(container.textContent).not.toContain("Already sent");

    const select = container.querySelector(
      "#send-time-campaign",
    ) as HTMLSelectElement;
    await act(async () => selectOption(select, CAMPAIGN_ID));

    const modal = container.querySelector(
      "#send-time-strategy-modal_hour",
    ) as HTMLInputElement;
    await act(async () => modal.click());

    await act(async () => button("Preview schedule")!.click());
    await eventually(() => expect(mocks.post).toHaveBeenCalledTimes(1));

    const [path, body] = mocks.post.mock.calls[0] ?? [];
    expect(path).toBe(
      `/api/v1/campaigns/${CAMPAIGN_ID}/schedule-by-best-time/preview`,
    );
    expect(body).toEqual({ strategy: "modal_hour", within_days: 7 });
    // The commit path must never be reached from this surface.
    expect(
      mocks.post.mock.calls.some(
        ([called]) =>
          typeof called === "string" &&
          called.endsWith("/schedule-by-best-time"),
      ),
    ).toBe(false);

    await eventually(() =>
      expect(container.textContent).toContain("40 recipients would be placed"),
    );
    expect(container.textContent).toContain("Busiest minute: 4 recipients");
    expect(container.textContent).toContain(
      "Busiest day: 30 recipients on 2026-09-11",
    );
    expect(container.textContent).toContain(
      "busiest day exceeds today's warmup cap of 25",
    );

    // The accessible copy of the histogram carries the real per-hour numbers.
    const rows = Array.from(
      container.querySelectorAll("#send-time-distribution-table tbody tr"),
    ).map((row) => row.textContent);
    expect(rows).toHaveLength(24);
    expect(rows[9]).toBe("9:0030");
    expect(rows[14]).toBe("14:0010");
  });

  it("withholds the durable commit behind the app's own hold sentence", async () => {
    const container = await renderPlan();
    await eventually(() =>
      expect(button("Confirm durable schedule")).toBeDefined(),
    );
    expect(button("Confirm durable schedule")!.disabled).toBe(true);
    expect(container.textContent).toContain(CAMPAIGN_SCHEDULING_RELEASE_HOLD);
    expect(container.textContent).toContain(
      "per-campaign personalized send window",
    );
  });

  it("refuses a preview with no campaign chosen", async () => {
    const container = await renderPlan();
    await eventually(() => expect(button("Preview schedule")).toBeDefined());
    await act(async () => button("Preview schedule")!.click());
    expect(mocks.post).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Choose a campaign to preview");
  });

  it("rejects a preview whose histogram does not account for every recipient", async () => {
    mocks.post.mockResolvedValue(
      previewResponse({
        distribution: Array.from({ length: 24 }, (_, hour) => ({
          hour,
          count: hour === 9 ? 1 : 0,
        })),
      }),
    );
    const container = await renderPlan();
    await eventually(() =>
      expect(container.textContent).toContain("September letter"),
    );
    const select = container.querySelector(
      "#send-time-campaign",
    ) as HTMLSelectElement;
    await act(async () => selectOption(select, CAMPAIGN_ID));
    await act(async () => button("Preview schedule")!.click());
    await eventually(() =>
      expect(container.textContent).toContain(
        "does not account for every recipient",
      ),
    );
    expect(container.textContent).not.toContain("recipients would be placed");
  });

  it("withholds the preview from a viewer-mode session", async () => {
    const container = await renderPlan(
      me({ viewer_mode: true, effective_role: "viewer" }),
    );
    expect(button("Preview schedule")).toBeUndefined();
    expect(container.textContent).toContain(
      "cannot preview or change a campaign's delivery plan",
    );
    expect(mocks.listCampaigns).not.toHaveBeenCalled();
  });
});
