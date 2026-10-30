// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyAdmin: vi.fn(),
  domains: vi.fn(),
  clicks: vi.fn(),
  routing: vi.fn(),
  entitlement: vi.fn(),
  feedback: vi.fn(),
  retryEvents: vi.fn(),
  recovery: vi.fn(),
  cleanup: vi.fn(),
  listReports: vi.fn(),
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyAdmin,
}));

vi.mock("@/lib/deliverability-operations-api", () => ({
  listDomainSetups: mocks.domains,
  getClickTracking: mocks.clicks,
  getRoutingPolicy: mocks.routing,
  getEntitlement: mocks.entitlement,
  getFeedbackHistory: mocks.feedback,
  listRetryEvents: mocks.retryEvents,
  getSoftBounceStats: mocks.recovery,
  runSoftBounceCleanup: mocks.cleanup,
}));

vi.mock("@/lib/scheduled-reports-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scheduled-reports-api")>()),
  listScheduledReports: mocks.listReports,
}));

import { ScheduledReportsPanel } from "@/app/(dashboard)/app/compliance-requests/scheduled-reports-panel";
import { DeliverabilityOperationsPanel } from "@/app/(dashboard)/app/deliverability/operations-panel";
import type { MeResponse } from "@/lib/auth-api";
import type { ScheduledReportsSnapshot } from "@/lib/scheduled-reports-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const REPORT_ID = "44444444-4444-4444-8444-444444444444";

function identity(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: USER_ID,
    tenant_id: TENANT_ID,
    email: "owner@example.test",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Operations",
    workspace_slug: "operations",
    ...overrides,
  };
}

function reportSnapshot(): ScheduledReportsSnapshot {
  return {
    tenantId: TENANT_ID,
    observedAt: "2026-08-30T10:00:00Z",
    reports: [
      {
        id: REPORT_ID,
        name: "Recipient-bearing report",
        enabled: true,
        template: "deliverability",
        schedule: "weekly:mon@09:00",
        timezone: "UTC",
        recipients: ["private-recipient@example.test"],
        lastRunAt: null,
        latestRunId: null,
        latestRunStatus: null,
        latestRunCreatedAt: null,
        latestRunAcceptedCount: 0,
        latestRunFailedCount: 0,
        latestRunUnknownCount: 0,
        latestRunRecipientCount: 0,
        nextDueAt: "2026-09-07T09:00:00Z",
        createdAt: "2026-08-30T09:00:00Z",
      },
    ],
  };
}

function mount(node: ReactNode): {
  client: QueryClient;
  container: HTMLElement;
  render: (next: ReactNode) => void;
  root: Root;
} {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 60_000 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (next: ReactNode) => {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>{next}</QueryClientProvider>,
      );
    });
  };
  render(node);
  return { client, container, render, root };
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw last;
}

function button(
  label: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const target = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!target) throw new Error(`Missing button: ${label}`);
  return target;
}

function setInput(target: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set?.call(target, value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyAdmin.mockResolvedValue(identity());
  mocks.domains.mockResolvedValue([]);
  mocks.clicks.mockResolvedValue({
    tracking_domain: "track.example.test",
    status: "active",
    ssl_status: "valid",
  });
  mocks.routing.mockResolvedValue({
    status: "active",
    strategy: "shared",
    dedicated_percentage_bp: 0,
    max_dedicated_percentage_bp: 10_000,
  });
  mocks.entitlement.mockResolvedValue({
    plan_tier: "pro",
    inbox_tests_monthly: 100,
    inbox_tests_used: 1,
    inbox_tests_remaining: 99,
    render_previews_monthly: 100,
    render_previews_used: 1,
    render_previews_remaining: 99,
    overage_policy: "blocked",
  });
  mocks.retryEvents.mockResolvedValue([]);
  mocks.recovery.mockResolvedValue({
    disabled_count: 0,
    eligible_now: 0,
    eligible_suppressions_now: 0,
    recovery_window_days: 7,
    automatic_reactivation_active: false,
  });
  mocks.feedback.mockResolvedValue({ bounces: [], complaints: [] });
  mocks.listReports.mockResolvedValue(reportSnapshot());
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("control edge cases", () => {
  it("runs a fresh protected feedback read when the same email is submitted again", async () => {
    const { container, root } = mount(
      <DeliverabilityOperationsPanel identity={identity()} />,
    );
    try {
      await eventually(() =>
        expect(container.textContent).toContain("No deferred recipient event"),
      );
      const email = container.querySelector<HTMLInputElement>(
        'input[type="email"]',
      );
      expect(email).not.toBeNull();
      await act(async () => {
        setInput(email as HTMLInputElement, "person@example.test");
      });

      await act(async () => button("Look up evidence", container).click());
      await eventually(() => expect(mocks.feedback).toHaveBeenCalledTimes(1));
      await eventually(() =>
        expect(container.textContent).toContain(
          "No recorded feedback returned",
        ),
      );
      await act(async () => button("Look up evidence", container).click());
      await eventually(() => expect(mocks.feedback).toHaveBeenCalledTimes(2));

      expect(mocks.verifyAdmin).toHaveBeenCalledTimes(2);
      expect(mocks.feedback).toHaveBeenNthCalledWith(2, "person@example.test", {
        signal: expect.any(AbortSignal),
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps a new monthly report editable when its day is temporarily invalid", async () => {
    const mounted = mount(<ScheduledReportsPanel identity={identity()} />);
    try {
      await eventually(() =>
        expect(mounted.container.textContent).toContain(
          "Recipient-bearing report",
        ),
      );
      act(() => button("New report", mounted.container).click());
      const cadence = mounted.container.querySelector<HTMLSelectElement>(
        "#scheduled-report-cadence",
      )!;
      act(() => {
        cadence.value = "monthly";
        cadence.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const day = mounted.container.querySelector<HTMLInputElement>(
        "#scheduled-report-month-day",
      )!;
      act(() => setInput(day, "32"));
      expect(mounted.container.textContent).toContain(
        "Monthly reports must use a day from 1 through 28.",
      );
      expect(button("Create report", mounted.container).disabled).toBe(true);
      expect(button("Discard draft", mounted.container)).toBeTruthy();
      act(() => setInput(day, "28"));
      expect(mounted.container.textContent).not.toContain(
        "Monthly reports must use a day from 1 through 28.",
      );
      expect(
        mounted.container.querySelector("#scheduled-report-name"),
      ).not.toBeNull();
    } finally {
      act(() => mounted.root.unmount());
      mounted.client.clear();
    }
  });

  it("uses a viewer-specific empty cache instead of attaching recipient data", async () => {
    const admin = identity();
    const viewer = identity({ viewer_mode: true });
    const mounted = mount(<ScheduledReportsPanel identity={admin} />);
    try {
      await eventually(() =>
        expect(mounted.container.textContent).toContain(
          "Recipient-bearing report",
        ),
      );
      const memberKey = [
        "scheduled-reports",
        TENANT_ID,
        USER_ID,
        "owner",
        "member",
      ] as const;
      const viewerKey = [
        "scheduled-reports",
        TENANT_ID,
        USER_ID,
        "owner",
        "viewer",
      ] as const;
      expect(mounted.client.getQueryData(memberKey)).toEqual(reportSnapshot());

      mounted.render(<ScheduledReportsPanel identity={viewer} />);
      await eventually(() =>
        expect(mounted.container.textContent).toContain(
          "Administrator access required",
        ),
      );

      expect(mounted.container.textContent).not.toContain(
        "private-recipient@example.test",
      );
      expect(mounted.client.getQueryData(viewerKey)).toBeUndefined();
      expect(
        mounted.client.getQueryCache().find({
          queryKey: viewerKey,
          exact: true,
        }),
      ).toBeDefined();
      expect(mocks.listReports).toHaveBeenCalledTimes(1);
    } finally {
      act(() => mounted.root.unmount());
    }
  });

  it("never fetches or renders deferred-recipient evidence below exact admin", async () => {
    mocks.retryEvents.mockResolvedValue([
      {
        id: "retry-1",
        tenant_id: TENANT_ID,
        campaign_id: "campaign-1",
        subscriber_email: "secret@private.test",
        reason: "frequency_cap",
        status: "pending",
        retry_after: "2026-09-02T10:00:00Z",
        attempts: 1,
        created_at: "2026-09-02T09:00:00Z",
        updated_at: "2026-09-02T09:01:00Z",
      },
    ]);
    const mounted = mount(
      <DeliverabilityOperationsPanel identity={identity()} />,
    );
    try {
      await eventually(() =>
        expect(mounted.container.textContent).toContain("s•••t@private.test"),
      );
      expect(mounted.container.textContent).toContain(
        "worker still re-evaluates frequency caps",
      );
      expect(mounted.container.textContent).toContain(
        "does not force delivery",
      );
      expect(button("Refresh queue", mounted.container)).toBeTruthy();
      expect(mocks.retryEvents).toHaveBeenCalledTimes(1);
      expect(mocks.retryEvents).toHaveBeenCalledWith(TENANT_ID);

      mounted.render(
        <DeliverabilityOperationsPanel
          identity={identity({
            effective_role: "viewer",
            role: "owner",
            viewer_mode: true,
          })}
        />,
      );
      await eventually(() =>
        expect(mounted.container.textContent).toContain(
          "Workspace owner or admin access is required",
        ),
      );

      expect(mounted.container.textContent).not.toContain("s•••t@private.test");
      expect(mounted.container.textContent).not.toContain("frequency cap");
      expect(mounted.container.textContent).not.toContain(
        "worker still re-evaluates frequency caps",
      );
      expect(() => button("Refresh queue", mounted.container)).toThrow(
        /Missing button/,
      );
      expect(mocks.retryEvents).toHaveBeenCalledTimes(1);
    } finally {
      act(() => mounted.root.unmount());
    }
  });
});
