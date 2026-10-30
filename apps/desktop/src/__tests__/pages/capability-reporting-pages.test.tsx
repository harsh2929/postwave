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

const mocks = vi.hoisted(() => ({
  commerceList: vi.fn(),
  agencyChildren: vi.fn(),
  agencyInvoice: vi.fn(),
  me: {
    user: "47000000-0000-4000-8000-000000000010",
    tenant: "47000000-0000-4000-8000-000000000099",
    credentialSource: "session" as const,
    credentialFingerprint: null,
    webhookPlaygroundRecoveryScope: null,
    role: "admin" as const,
    effectiveRole: "admin" as const,
    telemetryIdentity: null,
    noteRecoveryPrincipal: null,
  },
  capabilityAvailable: vi.fn(),
  capabilityFromApiError: vi.fn(),
  capabilityPartialPlanRequired: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  getApiUrl: () => "https://api.example.test/gateway",
  commerceApi: { listIntegrations: mocks.commerceList },
  api: {
    agencyListChildren: mocks.agencyChildren,
    agencyInvoicePreview: mocks.agencyInvoice,
  },
}));

vi.mock("../../lib/capability-observations", () => ({
  useCapabilityReporter: () => ({
    available: mocks.capabilityAvailable,
    fromApiError: mocks.capabilityFromApiError,
    partialPlanRequired: mocks.capabilityPartialPlanRequired,
  }),
}));

vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopRoute: vi.fn(),
  useDesktopRoute: () => ({ section: "commerce" }),
  useDesktopRouteTab: <T,>(
    _section: string,
    _allowed: readonly T[],
    fallback: T,
  ) => [fallback, vi.fn()] as const,
}));
vi.mock("../../lib/store", () => ({
  loadMe: vi.fn(),
  useCanAdmin: () => true,
  useMe: () => mocks.me,
  useRoleStatus: () => "resolved",
}));
vi.mock("../../lib/heroAssets", () => ({ HERO: { agency: "agency.webp" } }));
vi.mock("../../components/Toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("../../components/PageHeader", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("../../components/commerce/IntegrationsTab", () => ({
  IntegrationsTab: () => <div>Commerce integrations</div>,
}));
vi.mock("../../components/commerce/CatalogsTab", () => ({
  CatalogsTab: () => null,
}));
vi.mock("../../components/commerce/RecoveryTab", () => ({
  RecoveryTab: () => null,
}));
vi.mock("../../components/commerce/LifecycleTab", () => ({
  LifecycleTab: () => null,
}));
vi.mock("../../components/agency/AgencyStatStrip", () => ({
  AgencyStatStrip: () => null,
}));
vi.mock("../../components/agency/BrandingPreviewCard", () => ({
  BrandingPreviewCard: () => null,
}));
vi.mock("../../components/ConfirmModal", () => ({ ConfirmModal: () => null }));
vi.mock("../../components/HeroEmptyState", () => ({
  HeroEmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}));
vi.mock("../../components/InlineHelp", () => ({ InlineHelp: () => null }));
vi.mock("../../components/Modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalFooter: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { Agency } from "../../pages/Agency";
import { Commerce } from "../../pages/Commerce";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.commerceList.mockResolvedValue({ data: [] });
  mocks.agencyChildren.mockResolvedValue({
    data: { children: [], count: 0, has_more: false },
  });
  mocks.agencyInvoice.mockResolvedValue({ data: { lines: [] } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("destination capability reporting", () => {
  it("blocks Commerce only on authoritative suite-endpoint absence", async () => {
    const error = { status: 404, code: "route_missing", message: "missing" };
    mocks.commerceList.mockResolvedValue({ error });
    render(<Commerce />);
    await flush();

    expect(mocks.capabilityFromApiError).toHaveBeenCalledWith(error, {
      endpointAbsenceMeansNotConfigured: true,
    });
    expect(mocks.capabilityAvailable).not.toHaveBeenCalled();
  });

  it("clears only the Commerce suite owner after a verified response", async () => {
    render(<Commerce />);
    await flush();
    expect(mocks.capabilityAvailable).toHaveBeenCalledTimes(1);
    expect(mocks.capabilityFromApiError).not.toHaveBeenCalled();
  });

  it("keeps Agency branding enterable when sub-accounts need a plan", async () => {
    mocks.agencyChildren.mockResolvedValue({
      error: {
        status: 403,
        code: "not_agency",
        message: "not an agency workspace",
      },
    });
    mocks.agencyInvoice.mockResolvedValue({
      error: { status: 403, code: "not_agency", message: "not agency" },
    });
    render(<Agency />);
    await flush();

    expect(mocks.capabilityPartialPlanRequired).toHaveBeenCalledWith(
      expect.stringContaining("branding record remains available"),
    );
    expect(mocks.capabilityFromApiError).not.toHaveBeenCalled();
    expect(mocks.capabilityAvailable).not.toHaveBeenCalled();
    expect(mocks.agencyInvoice).not.toHaveBeenCalled();
  });

  it("does not reinterpret an Agency transport failure as a plan claim", async () => {
    const error = { status: 503, code: "upstream", message: "unavailable" };
    mocks.agencyChildren.mockResolvedValue({ error });
    render(<Agency />);
    await flush();

    expect(mocks.capabilityFromApiError).toHaveBeenCalledWith(error, {
      impact: "partial",
    });
    expect(mocks.capabilityPartialPlanRequired).not.toHaveBeenCalled();
    expect(mocks.capabilityAvailable).not.toHaveBeenCalled();
    expect(mocks.agencyInvoice).not.toHaveBeenCalled();
  });
});
