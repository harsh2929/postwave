// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount } from "./_harness";

type RenderedPage = Awaited<ReturnType<typeof renderPage>>;

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  getAnalysis: vi.fn(),
  listSendTimeSegments: vi.fn(),
  getSendingSettings: vi.fn(),
  listAudit: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/settings/send-time",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/send-time-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/send-time-api")>()),
  sendTimeOptimizationApi: {
    get: mocks.getSetting,
    set: mocks.setSetting,
  },
  getBestTimeAnalysis: mocks.getAnalysis,
  listSendTimeSegments: mocks.listSendTimeSegments,
}));

vi.mock("@/lib/sending-settings-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sending-settings-api")>()),
  sendingSettingsApi: {
    get: mocks.getSendingSettings,
  },
}));

vi.mock("@/lib/audit-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit-api")>()),
  listAuditLog: mocks.listAudit,
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue({
    user_id: "send-time-user",
    tenant_id: "send-time-tenant",
    email: "owner@example.test",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
    auth_provider: "local",
    email_verified: true,
    workspace_name: "Send time QA",
    workspace_slug: "send-time-qa",
  }),
}));

vi.mock("@/lib/use-admin-gate", () => ({
  useAdminGate: () => ({ canWrite: true, loading: false }),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess },
}));

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

function switchControl(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="Toggle send-time optimization"]',
  );
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${name}`);
  }
  return match;
}

async function settle(turns = 3): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

async function mountPage(): Promise<RenderedPage> {
  const Page = (await import("@/app/(dashboard)/app/settings/send-time/page"))
    .default;
  return renderPage(Page);
}

beforeEach(() => {
  mocks.listSendTimeSegments.mockReset().mockResolvedValue([]);
  mocks.getSetting.mockReset().mockResolvedValue({ enabled: false });
  mocks.setSetting.mockReset().mockResolvedValue({ enabled: true });
  mocks.getAnalysis.mockReset().mockResolvedValue({
    lookback_days: 90,
    generated_at: "2026-08-26T08:00:00Z",
    top_buckets: [],
    heatmap: [],
  });
  mocks.getSendingSettings.mockReset().mockResolvedValue({
    quiet_hours_enabled: false,
  });
  mocks.listAudit.mockReset().mockResolvedValue({ rows: [], total: 0 });
  mocks.toastSuccess.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("settings/send-time state integrity", () => {
  it("protects an unknown setting and recovers through an explicit retry", async () => {
    mocks.getSetting
      .mockRejectedValueOnce(new Error("HTTP 503"))
      .mockResolvedValueOnce({ enabled: true });
    const rendered = await mountPage();

    try {
      const alert = rendered.container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("HTTP 503");
      expect(alert?.textContent).toContain("will not be overwritten");
      expect(document.activeElement).toBe(alert);
      expect(switchControl(rendered.container)).toBeNull();
      expect(mocks.setSetting).not.toHaveBeenCalled();

      act(() => button(rendered.container, "Retry setting").click());
      await settle();

      const toggle = switchControl(rendered.container);
      expect(toggle).not.toBeNull();
      expect(toggle?.getAttribute("aria-checked")).toBe("true");
      expect(toggle?.className).toContain("size-11");
      expect(document.activeElement).toBe(toggle);
      expect(mocks.getSetting).toHaveBeenCalledTimes(2);
    } finally {
      unmount(rendered.root);
    }
  });

  it("deduplicates a same-tick toggle and keeps its optimistic state locked", async () => {
    let finishSave: ((value: { enabled: boolean }) => void) | undefined;
    mocks.setSetting.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    const rendered = await mountPage();

    try {
      const toggle = switchControl(rendered.container);
      expect(toggle).not.toBeNull();
      act(() => {
        toggle?.click();
        toggle?.click();
      });
      await settle(1);

      expect(mocks.setSetting).toHaveBeenCalledTimes(1);
      expect(mocks.setSetting).toHaveBeenCalledWith(true);
      expect(toggle?.disabled).toBe(true);
      expect(toggle?.getAttribute("aria-checked")).toBe("true");

      await act(async () => finishSave?.({ enabled: true }));
      await settle();
      expect(toggle?.disabled).toBe(false);
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Send-time optimization enabled",
      );
    } finally {
      unmount(rendered.root);
    }
  });

  it("reverts a failed save and focuses its actionable error", async () => {
    mocks.setSetting.mockRejectedValueOnce(new Error("Save HTTP 503"));
    const rendered = await mountPage();

    try {
      const toggle = switchControl(rendered.container);
      act(() => toggle?.click());
      await settle();

      expect(toggle?.getAttribute("aria-checked")).toBe("false");
      const alert = Array.from(
        rendered.container.querySelectorAll('[role="alert"]'),
      ).find((candidate) => candidate.textContent?.includes("Save HTTP 503"));
      expect(alert).toBeDefined();
      expect(document.activeElement).toBe(alert);
      expect(toggle?.disabled).toBe(false);
    } finally {
      unmount(rendered.root);
    }
  });

  it("names analysis and quiet-hours failures and retries each independently", async () => {
    mocks.getAnalysis
      .mockRejectedValueOnce(new Error("analysis unavailable"))
      .mockResolvedValueOnce({
        lookback_days: 90,
        generated_at: "2026-08-26T08:00:00Z",
        top_buckets: [],
        heatmap: [],
      });
    mocks.getSendingSettings
      .mockRejectedValueOnce(new Error("quiet unavailable"))
      .mockResolvedValueOnce({ quiet_hours_enabled: false });
    const rendered = await mountPage();

    try {
      expect(rendered.container.textContent).toContain(
        "No missing data is being presented as an empty history",
      );
      expect(rendered.container.textContent).toContain(
        "guardrail state is unknown, not unset",
      );
      act(() => button(rendered.container, "Retry analysis").click());
      await settle();
      expect(mocks.getAnalysis).toHaveBeenCalledTimes(2);
      expect(rendered.container.textContent).toContain(
        "Not enough send history yet",
      );
      expect(document.activeElement?.textContent).toContain(
        "Not enough send history yet",
      );

      act(() => button(rendered.container, "Retry quiet hours").click());
      await settle();
      expect(mocks.getSendingSettings).toHaveBeenCalledTimes(2);
      expect(rendered.container.textContent).toContain(
        "No quiet-hours window set",
      );
      expect(document.activeElement?.textContent).toContain(
        "No quiet-hours window set",
      );
    } finally {
      unmount(rendered.root);
    }
  });

  it("exposes complete heatmap data and derives a best window when the summary is absent", async () => {
    mocks.getAnalysis.mockResolvedValueOnce({
      lookback_days: 90,
      generated_at: "2026-08-26T08:00:00Z",
      top_buckets: [],
      heatmap: [
        {
          day_of_week: 2,
          hour_utc: 14,
          sent: 25,
          delivered: 24,
          opened: 12,
          clicked: 3,
          open_rate: 0.5,
          click_rate: 0.125,
          score: 0.8,
        },
      ],
    });
    const rendered = await mountPage();

    try {
      const heatmap = rendered.container.querySelector<HTMLElement>(
        '[role="img"][aria-label="Engagement heatmap by hour of week"]',
      );
      expect(heatmap).not.toBeNull();
      const summaryId = heatmap?.getAttribute("aria-describedby");
      const summary = summaryId
        ? rendered.container.querySelector<HTMLElement>(`#${summaryId}`)
        : null;
      expect(summary?.textContent).toContain(
        "Engagement was recorded in 1 hourly window",
      );
      expect(summary?.textContent).toContain("Tue");
      expect(summary?.textContent).toContain("14:00");
      expect(summary?.textContent).toContain("25");
      expect(summary?.textContent).toContain("50%");
      expect(rendered.container.textContent).toContain(
        "Best windows: Tue 14:00 UTC (50% open)",
      );
    } finally {
      unmount(rendered.root);
    }
  });
});
