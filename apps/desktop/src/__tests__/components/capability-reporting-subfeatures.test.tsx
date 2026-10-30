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
  audienceList: vi.fn(),
  warehouseCatalog: vi.fn(),
  warehouseConnections: vi.fn(),
  warehouseRuns: vi.fn(),
  available: vi.fn(),
  fromApiError: vi.fn(),
  partialNotConfigured: vi.fn(),
  reporters: new Map<
    string,
    {
      available: () => void;
      fromApiError: (error: unknown, evidence: unknown) => void;
      partialNotConfigured: (reason: string) => void;
    }
  >(),
}));

vi.mock("../../lib/api-client", () => ({
  audienceDestinationsApi: { list: mocks.audienceList },
  warehouseApi: {
    catalog: mocks.warehouseCatalog,
    listConnections: mocks.warehouseConnections,
    listRuns: mocks.warehouseRuns,
  },
}));

vi.mock("../../lib/capability-observations", () => ({
  useCapabilityReporter: (_section: string, owner: string) => {
    const existing = mocks.reporters.get(owner);
    if (existing) return existing;
    const reporter = {
      available: () => mocks.available(owner),
      fromApiError: (error: unknown, evidence: unknown) =>
        mocks.fromApiError(owner, error, evidence),
      partialNotConfigured: (reason: string) =>
        mocks.partialNotConfigured(owner, reason),
    };
    mocks.reporters.set(owner, reporter);
    return reporter;
  },
}));

vi.mock("../../components/SectionHeader", () => ({
  SectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}));
vi.mock("../../components/HeroEmptyState", () => ({
  HeroEmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}));
vi.mock("../../components/Modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalFooter: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/ConfirmModal", () => ({ ConfirmModal: () => null }));
vi.mock("../../components/FormField", () => ({ FormField: () => null }));
vi.mock("../../components/Toast", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
vi.mock("../../components/AudienceDestinationModal", () => ({
  AudienceDestinationModal: () => null,
}));
vi.mock("../../components/warehouse/ReverseETLMappingModal", () => ({
  ReverseETLMappingModal: () => null,
}));
vi.mock("../../components/dataplatform/StreamingExportForm", () => ({
  StreamingExportForm: () => null,
}));
vi.mock("../../components/dataplatform/StreamingExportStatus", () => ({
  StreamingExportStatus: () => null,
}));
vi.mock("../../lib/heroAssets", () => ({ HERO: { migrations: "hero.webp" } }));

import { AudienceDestinationsSection } from "../../components/AudienceDestinationsSection";
import { ReverseETLSection } from "../../components/dataplatform/ReverseETLSection";
import { WarehouseSection } from "../../components/dataplatform/WarehouseSection";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.audienceList.mockResolvedValue({ data: { items: [] } });
  mocks.warehouseCatalog.mockResolvedValue({ data: {} });
  mocks.warehouseConnections.mockResolvedValue({ data: { items: [] } });
  mocks.warehouseRuns.mockResolvedValue({ data: { items: [] } });
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

describe("mixed-destination capability reporters", () => {
  it("keeps webhook/writeback tasks available when ad platforms are absent", async () => {
    mocks.audienceList.mockResolvedValue({
      error: { status: 404, code: "route_missing", message: "missing" },
    });
    render(<AudienceDestinationsSection canAdmin />);
    await flush();

    expect(mocks.partialNotConfigured).toHaveBeenCalledWith(
      "ad-platforms",
      expect.stringContaining("Webhook sync and writeback tools remain"),
    );
    expect(mocks.available).not.toHaveBeenCalledWith("ad-platforms");
  });

  it("reports Warehouse catalog and connection evidence independently", async () => {
    const error = { status: 404, code: "route_missing", message: "missing" };
    mocks.warehouseCatalog.mockResolvedValue({ error });
    render(<WarehouseSection canAdmin />);
    await flush();

    expect(mocks.fromApiError).toHaveBeenCalledWith(
      "warehouse-catalog",
      error,
      { endpointAbsenceMeansNotConfigured: true, impact: "partial" },
    );
    expect(mocks.available).toHaveBeenCalledWith("warehouse-connections");
    expect(mocks.available).not.toHaveBeenCalledWith("warehouse-catalog");
  });

  it("does not block custom objects when Reverse ETL is absent", async () => {
    const error = { status: 405, code: "route_missing", message: "missing" };
    mocks.warehouseConnections.mockResolvedValue({ error });
    render(<ReverseETLSection canAdmin />);
    await flush();

    expect(mocks.fromApiError).toHaveBeenCalledWith("reverse-etl", error, {
      endpointAbsenceMeansNotConfigured: true,
      impact: "partial",
    });
    expect(mocks.available).not.toHaveBeenCalledWith("reverse-etl");
  });
});
