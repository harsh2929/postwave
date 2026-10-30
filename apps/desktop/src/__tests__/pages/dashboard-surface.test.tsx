// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
  data: {
    stats: {
      subscribers_total: 1_250,
      subscribers_added_30d: 50,
      emails_sent_30d: 1_000,
      opens_total_30d: 420,
      clicks_total_30d: 86,
      bounces_total_30d: 4,
      previous: {
        subscribers_added: 40,
        emails_sent: 1_000,
        opens_total: 390,
        clicks_total: 70,
        bounces_total: 6,
      },
    } as Record<string, unknown> | null,
    campaigns: [],
    campaignsLoading: false,
    campaignsError: false,
    campaignsStale: false,
    loading: false,
    loadState: "ready" as "initial" | "range" | "refresh" | "ready",
    resolvedRange: "30d" as "7d" | "30d" | "90d" | null,
    lastSuccessAt: Date.parse("2026-07-18T07:00:00.000Z"),
    error: null as string | null,
    statsFailure: null as null | {
      kind:
        | "offline"
        | "access"
        | "unavailable"
        | "service"
        | "invalid"
        | "generic";
      message: string;
    },
    liveStatus: "open" as "connecting" | "open" | "reconnecting" | "closed",
    lastEventAt: Date.parse("2026-07-18T07:00:00.000Z"),
    now: Date.parse("2026-07-18T07:00:02.000Z"),
    load: vi.fn().mockResolvedValue(undefined),
    refreshCampaigns: vi.fn().mockResolvedValue(undefined),
  },
  layout: {
    layout: null as string[] | null,
    editing: false,
    saveStatus: "idle" as "idle" | "saving" | "saved" | "failed",
    saveMessage: null as string | null,
    toggleEditing: vi.fn(),
    persist: vi.fn(),
  },
  navigate: vi.fn(),
  setSection: vi.fn(),
}));

vi.mock("../../pages/dashboard/useDashboardData", () => ({
  useDashboardData: () => mocks.data,
}));

vi.mock("../../pages/dashboard/useDashboardLayout", () => ({
  useDashboardLayout: () => mocks.layout,
}));

vi.mock("../../lib/store", () => ({
  setSection: mocks.setSection,
  useMe: () => ({
    user: "user-1",
    tenant: "tenant-1",
    role: "admin",
    effectiveRole: "admin",
  }),
  useRole: () => "admin",
}));

vi.mock("../../lib/desktop-router", () => ({
  desktopRouteIdentityScope: () => "user-1:tenant-1",
  navigateDesktopRoute: mocks.navigate,
}));

vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../../components/OnboardingChecklist", () => ({
  OnboardingChecklist: () => (
    <section aria-label="Workspace setup">
      <h2>Finish setting up your workspace</h2>
    </section>
  ),
}));

vi.mock("../../components/dashboard/DashboardSectionList", () => ({
  DashboardSectionList: () => (
    <section data-testid="dashboard-sections" aria-label="Dashboard insights" />
  ),
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { Dashboard } from "../../pages/Dashboard";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.data.stats = {
    subscribers_total: 1_250,
    subscribers_added_30d: 50,
    emails_sent_30d: 1_000,
    opens_total_30d: 420,
    clicks_total_30d: 86,
    bounces_total_30d: 4,
    previous: {
      subscribers_added: 40,
      emails_sent: 1_000,
      opens_total: 390,
      clicks_total: 70,
      bounces_total: 6,
    },
  };
  mocks.data.loading = false;
  mocks.data.loadState = "ready";
  mocks.data.resolvedRange = "30d";
  mocks.data.error = null;
  mocks.data.statsFailure = null;
  mocks.layout.layout = null;
  mocks.layout.editing = false;
  mocks.layout.saveStatus = "idle";
  mocks.layout.saveMessage = null;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  window.localStorage.clear();
});

function renderDashboard(): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(<Dashboard />));
}

describe("Dashboard surface hierarchy", () => {
  it("puts the workspace picture before setup and keeps customization opt-in", () => {
    renderDashboard();

    expect(document.querySelectorAll("h1").length).toBe(1);
    expect(document.querySelector("h1")?.textContent).toBe("Dashboard");
    const metrics = document.getElementById("dashboard-metrics");
    const setup = document.querySelector('[aria-label="Workspace setup"]');
    expect(metrics).not.toBeNull();
    expect(setup).not.toBeNull();
    if (!metrics || !setup) throw new Error("Dashboard hierarchy is missing");
    expect(
      metrics.compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(document.querySelector('[draggable="true"]')).toBeNull();
    expect(
      document.querySelector('[aria-label^="Move Subscribers"]'),
    ).toBeNull();

    mocks.layout.editing = true;
    mocks.layout.saveStatus = "saving";
    mocks.layout.saveMessage = "Saving layout…";
    renderDashboard();

    expect(document.querySelector('[draggable="true"]')).not.toBeNull();
    expect(document.body.textContent).toContain(
      "Rearrange metrics and sections",
    );
    expect(document.body.textContent).toContain("Saving layout…");
    expect(
      document.querySelector('[aria-label="Open Subscribers details"]'),
    ).toBeNull();
  });

  it("contains initial errors in Performance without exposing server detail", () => {
    mocks.data.stats = null;
    mocks.data.error = "token=secret internal upstream trace";
    mocks.data.statsFailure = {
      kind: "service",
      message: "The reporting service is temporarily unavailable. Try again.",
    };
    mocks.data.resolvedRange = null;
    renderDashboard();

    expect(document.body.textContent).toContain(
      "Workspace metrics are temporarily unavailable",
    );
    expect(document.body.textContent).toContain("Retry metrics");
    expect(document.body.textContent).not.toContain("token=secret");
    expect(document.getElementById("dashboard-metrics")).toBeNull();
  });

  it("retains confirmed metrics behind a local refresh warning", () => {
    mocks.data.error = "upstream failed";
    mocks.data.statsFailure = {
      kind: "service",
      message: "The reporting service is temporarily unavailable. Try again.",
    };
    renderDashboard();

    expect(document.body.textContent).toContain("Couldn’t refresh");
    expect(document.body.textContent).toContain(
      "Showing the last confirmed metrics",
    );
    expect(document.body.textContent).toContain("1,250");
    expect(document.getElementById("dashboard-metrics")).not.toBeNull();
  });

  it("distinguishes offline, access, unavailable, and invalid metric failures", () => {
    mocks.data.stats = null;
    const cases = [
      ["offline", "Dashboard is offline", "Retry connection"],
      ["access", "Workspace metrics are restricted", "Check access again"],
      [
        "unavailable",
        "Dashboard reporting isn’t available here",
        "Check availability",
      ],
      ["invalid", "Workspace metrics couldn’t be verified", "Retry metrics"],
    ] as const;

    for (const [kind, title, action] of cases) {
      mocks.data.statsFailure = {
        kind,
        message: "Safe recovery guidance.",
      };
      renderDashboard();
      expect(document.body.textContent).toContain(title);
      expect(document.body.textContent).toContain(action);
    }
  });

  it("has no serious or critical accessibility violations in the normal state", async () => {
    renderDashboard();
    const result = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
