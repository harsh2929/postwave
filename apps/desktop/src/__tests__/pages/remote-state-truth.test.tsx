// @vitest-environment happy-dom

import { act, type ReactElement, type ReactNode } from "react";
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

import serviceSuiteCatalogFixture from "../../../../web/src/__tests__/fixtures/api/service-suite_catalog.json";

const mocks = vi.hoisted(() => ({
  auditAlertsList: vi.fn(),
  catalog: vi.fn(),
  listApprovals: vi.fn(),
  listConsentEvents: vi.fn(),
  listConsentReceipts: vi.fn(),
  listPrivacyIncidents: vi.fn(),
  privacyPortalGet: vi.fn(),
  capabilityAvailable: vi.fn(),
  capabilityFromApiError: vi.fn(),
  helpdeskInboxRender: vi.fn(),
  useCanAdmin: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  getApiUrl: () => "https://api.example.test",
  api: {
    auditAlertsList: mocks.auditAlertsList,
    listApprovals: mocks.listApprovals,
    listConsentEvents: mocks.listConsentEvents,
    listConsentReceipts: mocks.listConsentReceipts,
    listPrivacyIncidents: mocks.listPrivacyIncidents,
    privacyPortal: { get: mocks.privacyPortalGet },
  },
  serviceSuiteApi: { catalog: mocks.catalog },
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.useCanAdmin(),
  useMe: () => ({
    user: "11111111-1111-4111-8111-111111111111",
    tenant: "22222222-2222-4222-8222-222222222222",
    effectiveRole: "admin",
  }),
  useRoleStatus: () => "resolved",
}));
vi.mock("../../lib/context-epoch", () => ({
  onContextEpochObserved: () => () => undefined,
  readContextEpoch: () => "epoch-1",
}));
vi.mock("../../lib/online-manager", () => ({ useOnline: () => "online" }));
vi.mock("../../lib/capability-observations", () => ({
  useCapabilityReporter: () => ({
    available: mocks.capabilityAvailable,
    fromApiError: mocks.capabilityFromApiError,
  }),
}));
vi.mock("../../lib/deep-link", () => ({
  consumePendingDeepLinkTarget: () => null,
  onPendingDeepLinkTarget: () => () => undefined,
}));
vi.mock("../../lib/heroAssets", () => ({ HERO: { approvals: "hero.webp" } }));
vi.mock("../../components/Toast", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock("../../components/PageHeader", () => ({
  PageHeader: ({
    title,
    subtitle,
    actions,
  }: {
    title: string;
    subtitle?: ReactNode;
    actions?: Array<{
      label: string;
      onClick: () => void;
      disabled?: boolean;
    }>;
  }) => (
    <header>
      <h1>{title}</h1>
      <div>{subtitle}</div>
      {actions?.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
        >
          {action.label}
        </button>
      ))}
    </header>
  ),
}));
vi.mock("../../components/SectionHeader", () => ({
  SectionHeader: ({
    title,
    actions,
  }: {
    title: string;
    actions?: ReactNode;
  }) => (
    <header>
      <h2>{title}</h2>
      {actions}
    </header>
  ),
}));
vi.mock("../../components/StatStrip", () => ({
  StatStrip: ({
    cells,
  }: {
    cells: Array<{ label: string; value: ReactNode }>;
  }) => (
    <div data-testid="stats">
      {cells.map((cell) => (
        <span key={cell.label}>
          {cell.label}: {cell.value}
        </span>
      ))}
    </div>
  ),
}));
vi.mock("../../components/HeroEmptyState", () => ({
  HeroEmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}));
vi.mock("../../components/ApprovalDetailSlideover", () => ({
  ApprovalDetailSlideover: () => null,
}));
vi.mock("../../components/Modal", () => ({
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  ModalFooter: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/ConfirmModal", () => ({ ConfirmModal: () => null }));
vi.mock("../../components/privacy/PortalDashboard", () => ({
  PortalDashboard: ({
    summary,
  }: {
    summary: { gpc_signaled_count: number };
  }) => <div>Portal KPI {summary.gpc_signaled_count}</div>,
}));
vi.mock("../../components/privacy/ConsentProofPanel", () => ({
  ConsentProofPanel: () => <div>Consent proof</div>,
}));
vi.mock("../../components/privacy/DoubleOptinPendingTable", () => ({
  DoubleOptinPendingTable: () => <div>Double opt-in</div>,
}));
vi.mock("../../components/privacy/PreferenceCenterCustomization", () => ({
  PreferenceCenterCustomization: () => <div>Preference center</div>,
}));
vi.mock("../../components/privacy/RegionsCard", () => ({
  RegionsCard: () => <div>Regions</div>,
}));
vi.mock("../../components/audit/AuditAlertIncidents", () => ({
  AuditAlertIncidents: () => null,
}));
vi.mock("../../components/audit/AuditAlertRuleForm", () => ({
  AuditAlertRuleForm: () => null,
}));
vi.mock("../../components/helpdesk/HelpdeskInbox", () => ({
  HelpdeskInbox: ({ catalog }: { catalog: unknown | null }) => {
    mocks.helpdeskInboxRender({ catalog });
    return (
      <div>{catalog ? "Inbox with catalog" : "Inbox without catalog"}</div>
    );
  },
}));
vi.mock("../../components/helpdesk/CustomerHubConfig", () => ({
  CustomerHubConfig: () => <div>Hub</div>,
}));
vi.mock("../../components/helpdesk/CustomerAgentPanel", () => ({
  CustomerAgentPanel: () => <div>Agent</div>,
}));

import { Approvals } from "../../pages/Approvals";
import { AuditAlerts } from "../../pages/AuditAlerts";
import { Consent } from "../../pages/Consent";
import { Helpdesk } from "../../pages/Helpdesk";
import { PrivacyIncidents } from "../../pages/PrivacyIncidents";
import { PrivacyPortal } from "../../pages/PrivacyPortal";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.auditAlertsList.mockResolvedValue({ data: { rules: [] } });
  mocks.catalog.mockResolvedValue({ data: {} });
  mocks.listApprovals.mockResolvedValue({ data: { approvals: [] } });
  mocks.listConsentEvents.mockResolvedValue({
    data: {
      schema_version: 1,
      workspace_id: "",
      snapshot_at: "2026-08-20T10:00:00.000000Z",
      source_planes: ["consent_events"],
      events: [],
      count: 0,
      has_more: false,
    },
  });
  mocks.listConsentReceipts.mockResolvedValue({
    data: {
      schema_version: 1,
      workspace_id: "",
      snapshot_at: "2026-08-20T10:00:00.000000Z",
      source_planes: ["consent_receipts", "consent_records"],
      receipts: [],
      count: 0,
      has_more: false,
    },
  });
  mocks.listPrivacyIncidents.mockResolvedValue({ data: { incidents: [] } });
  mocks.privacyPortalGet.mockResolvedValue({
    data: {
      regions: [],
      dsar_requests: [],
      gpc_signaled_count: 0,
      do_not_sell_count: 0,
      double_optin_pending: 0,
      suppression_breakdown: [],
      consent_proof_summary: [],
    },
  });
  mocks.useCanAdmin.mockReturnValue(false);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
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

function bodyText(): string {
  return document.body.textContent ?? "";
}

function clickRemoteRetry(state: string): void {
  const button = document.querySelector<HTMLButtonElement>(
    `[data-remote-state="${state}"] button`,
  );
  if (!button) throw new Error(`Expected Retry for ${state}`);
  act(() => button.click());
}

describe("audited failure-as-empty surfaces", () => {
  it("Privacy Portal never substitutes zero KPIs for an unverified response", async () => {
    mocks.privacyPortalGet
      .mockResolvedValueOnce({
        error: { message: "sensitive database detail", status: 500 },
      })
      .mockResolvedValueOnce({
        data: {
          regions: [],
          dsar_requests: [],
          gpc_signaled_count: 0,
          do_not_sell_count: 0,
          double_optin_pending: 0,
          suppression_breakdown: [],
          consent_proof_summary: [],
        },
      });
    render(<PrivacyPortal />);

    await waitFor(() =>
      expect(bodyText()).toContain("Couldn’t verify privacy portal"),
    );
    expect(bodyText()).not.toContain("Portal KPI 0");
    expect(bodyText()).not.toContain("sensitive database detail");

    clickRemoteRetry("initial-error");
    await waitFor(() => expect(bodyText()).toContain("Portal KPI 0"));
  });

  it("Privacy Portal normalizes a verified partial response without inventing failure data", async () => {
    mocks.privacyPortalGet.mockResolvedValueOnce({
      data: { gpc_signaled_count: 7 },
    });
    render(<PrivacyPortal />);

    await waitFor(() => expect(bodyText()).toContain("Portal KPI 7"));
    expect(bodyText()).not.toContain("Couldn’t verify privacy portal");
  });

  it("Audit Alerts renders permission denial instead of first-run empty copy", async () => {
    mocks.auditAlertsList
      .mockResolvedValueOnce({
        error: { message: "forbidden internals", status: 403 },
      })
      .mockResolvedValueOnce({ data: { rules: [] } });
    render(<AuditAlerts />);

    await waitFor(() =>
      expect(bodyText()).toContain("Access denied for audit-alert rules"),
    );
    expect(bodyText()).not.toContain("No alert rules yet");
    expect(bodyText()).not.toContain("forbidden internals");

    clickRemoteRetry("permission-denied");
    await waitFor(() => expect(bodyText()).toContain("No alert rules yet"));
  });

  it("Approvals keeps verified rows and labels a failed refresh stale", async () => {
    mocks.useCanAdmin.mockReturnValue(true);
    let pendingReads = 0;
    mocks.listApprovals.mockImplementation(
      ({ includeResolved }: { includeResolved?: boolean }) => {
        if (includeResolved)
          return Promise.resolve({ data: { approvals: [] } });
        pendingReads += 1;
        if (pendingReads === 1) {
          return Promise.resolve({
            data: {
              approvals: [
                {
                  id: "approval-1",
                  status: "pending",
                  resourceType: "campaign",
                  resourceId: "campaign-1",
                  requestedAt: "2026-07-16T10:00:00.000Z",
                },
              ],
            },
          });
        }
        return Promise.resolve({
          error: { message: "refresh detail", kind: "network" },
        });
      },
    );
    render(<Approvals />);
    await waitFor(() => expect(bodyText()).toContain("Campaign"));

    const refresh = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Refresh evidence",
    );
    if (!refresh) throw new Error("Expected approvals Refresh");
    act(() => refresh.click());

    await waitFor(() =>
      expect(bodyText()).toContain("Showing a retained, stale snapshot"),
    );
    expect(bodyText()).toContain("Campaign");
    expect(bodyText()).not.toContain("Nothing is waiting in the loaded queue");
  });

  it("Approvals shows success-empty copy only after a verified empty retry", async () => {
    mocks.useCanAdmin.mockReturnValue(true);
    let pendingReads = 0;
    mocks.listApprovals.mockImplementation(
      ({ includeResolved }: { includeResolved?: boolean }) => {
        if (includeResolved)
          return Promise.resolve({ data: { approvals: [] } });
        pendingReads += 1;
        return Promise.resolve(
          pendingReads === 1
            ? { error: { message: "unavailable", status: 500 } }
            : { data: { approvals: [] } },
        );
      },
    );
    render(<Approvals />);
    await waitFor(() =>
      expect(bodyText()).toContain("Approval evidence unavailable"),
    );
    expect(bodyText()).not.toContain("Nothing is waiting in the loaded queue");

    const retry = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    );
    if (!retry) throw new Error("Expected approvals Retry");
    act(() => retry.click());
    await waitFor(() =>
      expect(bodyText()).toContain("Nothing is waiting in the loaded queue"),
    );
    expect(bodyText()).toContain("Pending · loaded window: 0");
  });

  it("Consent never combines receipt failure with the no-receipts state", async () => {
    mocks.listConsentReceipts
      .mockResolvedValueOnce({ error: { message: "unavailable", status: 500 } })
      .mockResolvedValueOnce({
        data: {
          schema_version: 1,
          workspace_id: "",
          snapshot_at: "2026-08-20T10:00:00.000000Z",
          source_planes: ["consent_receipts", "consent_records"],
          receipts: [],
          count: 0,
          has_more: false,
        },
      });
    render(<Consent />);

    await waitFor(() =>
      expect(bodyText()).toContain(
        "Couldn’t verify receipt and proof evidence",
      ),
    );
    expect(bodyText()).not.toContain(
      "No receipt or proof evidence was returned",
    );

    clickRemoteRetry("initial-error");
    await waitFor(() =>
      expect(bodyText()).toContain("No receipt or proof evidence was returned"),
    );
    expect(bodyText()).toContain("Loaded receipt / proof rows: 0");
  });

  it("Privacy Incidents owns initial failure and verifies real zero metrics", async () => {
    mocks.listPrivacyIncidents
      .mockResolvedValueOnce({ error: { message: "unavailable", status: 500 } })
      .mockResolvedValueOnce({
        data: { incidents: [], known_jurisdictions: [] },
      });
    render(<PrivacyIncidents />);

    await waitFor(() =>
      expect(bodyText()).toContain("Couldn’t verify privacy incidents"),
    );
    expect(bodyText()).not.toContain("No incidents on file");
    expect(bodyText()).not.toContain(
      "No incident records are available in the loaded response",
    );
    expect(bodyText()).not.toContain("End of loaded incident register");
    expect(bodyText()).not.toContain("0 of 0 loaded");
    expect(
      document.querySelector('table[aria-label="Privacy incidents"]'),
    ).toBeNull();
    expect(
      document.querySelector(".privacy-incident-mobile-register"),
    ).toBeNull();
    expect(document.querySelector('[data-testid="stats"]')).toBeNull();

    clickRemoteRetry("initial-error");
    await waitFor(() => expect(bodyText()).toContain("No incidents on file"));
    expect(bodyText()).toContain("Needs attention: 0");
    expect(bodyText()).toContain("Loaded non-terminal: 0");
    expect(bodyText()).toContain("Scope fields complete: 0 / 0");
  });

  it("Helpdesk exposes catalog failure and accepts only the verified frozen catalog", async () => {
    mocks.useCanAdmin.mockReturnValue(true);
    mocks.catalog
      .mockResolvedValueOnce({
        error: { message: "catalog internals", status: 500 },
      })
      .mockResolvedValueOnce({
        data: serviceSuiteCatalogFixture,
      });
    render(<Helpdesk />);

    await waitFor(() =>
      expect(bodyText()).toContain("Couldn’t verify helpdesk catalog"),
    );
    expect(bodyText()).toContain("Inbox without catalog");
    expect(bodyText()).not.toContain("catalog internals");
    expect(mocks.capabilityFromApiError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 500 }),
      { endpointAbsenceMeansNotConfigured: true },
    );

    clickRemoteRetry("initial-error");
    await waitFor(() => expect(bodyText()).toContain("Inbox with catalog"));
    expect(bodyText()).not.toContain("no configured picker values");
    expect(bodyText()).toContain("Inbox with catalog");
    expect(mocks.capabilityAvailable).toHaveBeenCalledTimes(1);
  });

  it("preserves a safe status deep link without mounting protected records until catalog verification", async () => {
    mocks.useCanAdmin.mockReturnValue(true);
    mocks.catalog
      .mockResolvedValueOnce({
        error: { message: "catalog transport held", status: 503 },
      })
      .mockResolvedValueOnce({
        data: serviceSuiteCatalogFixture,
      });
    window.history.replaceState(null, "", "/app/helpdesk?f.status=open");
    window.dispatchEvent(new PopStateEvent("popstate"));
    render(<Helpdesk />);

    await waitFor(() =>
      expect(bodyText()).toContain("Couldn’t verify helpdesk catalog"),
    );
    expect(window.location.search).toBe("?f.status=open");
    expect(bodyText()).toContain("Verifying queue filter");
    expect(mocks.helpdeskInboxRender).not.toHaveBeenCalled();

    clickRemoteRetry("initial-error");
    await waitFor(() => expect(bodyText()).toContain("Inbox with catalog"));
    expect(window.location.search).toBe("?f.status=open");
    expect(mocks.helpdeskInboxRender).toHaveBeenCalledTimes(1);
  });
});
