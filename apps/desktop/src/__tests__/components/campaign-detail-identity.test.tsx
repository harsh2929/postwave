// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
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

import type {
  Campaign,
  CampaignDetail,
  CampaignReport,
} from "../../lib/api-client";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  getCampaign: vi.fn(),
  getCampaignReport: vi.fn(),
  getArchiveTenantSettings: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getCampaign: mocks.getCampaign,
      getCampaignReport: mocks.getCampaignReport,
      getArchiveTenantSettings: mocks.getArchiveTenantSettings,
    },
  };
});

vi.mock("../../lib/sse", () => ({
  connectCampaignEvents: vi.fn(() => () => undefined),
}));

import {
  type CampaignDetailData,
  useCampaignDetailData,
} from "../../components/campaigns/useCampaignDetailData";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: CampaignDetailData | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getArchiveTenantSettings.mockResolvedValue({ data: {} });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  latest = null;
  document.body.replaceChildren();
});

function Probe({ campaign }: { campaign: Campaign }): ReactElement {
  latest = useCampaignDetailData(campaign);
  return (
    <div data-testid="detail">
      {String(latest.id)}:{latest.detail.name ?? "none"}:
      {latest.report?.sent ?? "no-report"}
    </div>
  );
}

describe("campaign detail identity ownership", () => {
  it("clears A's local detail and report before B's requests can settle", async () => {
    const detailA = deferred<{ data: CampaignDetail }>();
    const reportA = deferred<{ data: CampaignReport }>();
    const detailB = deferred<{ data: CampaignDetail }>();
    const reportB = deferred<{ data: CampaignReport }>();
    mocks.getCampaign
      .mockReturnValueOnce(detailA.promise)
      .mockReturnValueOnce(detailB.promise);
    mocks.getCampaignReport
      .mockReturnValueOnce(reportA.promise)
      .mockReturnValueOnce(reportB.promise);

    render(<Probe campaign={campaign("a", "Campaign A")} />);
    act(() => {
      latest?.setDetail({ ...campaign("a", "Unsaved A") });
    });
    expect(container?.textContent).toContain("a:Unsaved A:no-report");

    act(() => {
      root?.render(<Probe campaign={campaign("b", "Campaign B")} />);
    });
    expect(container?.textContent).toContain("b:Campaign B:no-report");
    expect(container?.textContent).not.toContain("Unsaved A");

    await act(async () => {
      detailA.resolve({ data: campaign("a", "Late A") });
      reportA.resolve({ data: { sent: 99 } as CampaignReport });
      await Promise.resolve();
    });
    expect(container?.textContent).toContain("b:Campaign B:no-report");

    await act(async () => {
      detailB.resolve({ data: campaign("b", "Confirmed B") });
      reportB.resolve({ data: { sent: 3 } as CampaignReport });
      await Promise.resolve();
    });
    expect(container?.textContent).toContain("b:Confirmed B:3");
  });
});

function campaign(id: string, name: string): CampaignDetail {
  return {
    id,
    name,
    subject: `${name} subject`,
    status: "draft",
  } as CampaignDetail;
}

function render(element: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}
