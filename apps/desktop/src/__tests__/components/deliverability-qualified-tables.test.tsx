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

import { IspBreakdownCard } from "../../components/deliverability/IspBreakdownCard";
import { PlacementReportCard } from "../../components/deliverability/PlacementReportCard";
import { AuthChecksMatrixCard } from "../../components/deliverability/AuthChecksMatrixCard";

const mocks = vi.hoisted(() => ({
  ispTenant: vi.fn(),
  ispCampaign: vi.fn(),
  placementReport: vi.fn(),
  authMatrix: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  ispBreakdownApi: {
    tenant: mocks.ispTenant,
    byCampaign: mocks.ispCampaign,
  },
  inboxRealityCampaignsApi: {
    report: mocks.placementReport,
  },
  authChecksApi: {
    matrix: mocks.authMatrix,
  },
}));

vi.mock("../../components/deliverability/CampaignSelect", () => ({
  CampaignSelect: ({
    ariaLabel,
    value,
    onChange,
    disabled,
  }: {
    ariaLabel: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      <option value="">All campaigns</option>
      <option value="campaign-1">Campaign one</option>
    </select>
  ),
}));

vi.mock("../../components/charts/CategoricalDistributionChart", () => ({
  CategoricalDistributionChart: ({ title }: { title: string }) => (
    <div>{title}</div>
  ),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.ispTenant.mockReset();
  mocks.ispCampaign.mockReset();
  mocks.placementReport.mockReset();
  mocks.authMatrix.mockReset();
});

afterEach(() => {
  if (root) {
    const current = root;
    act(() => current.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

async function render(node: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const ISP_BUCKET = {
  isp: "Gmail",
  subscribers: 40,
  sent: 30,
  opens: 12,
  clicks: 3,
  bounces: 1,
  complaints: 0,
  open_rate: 0.4,
  click_rate: 0.1,
  bounce_rate: 0.033,
  complaint_rate: 0,
};

describe("deliverability qualified tables", () => {
  it("renders the ISP response as a captioned native table with exact rates", async () => {
    mocks.ispTenant.mockResolvedValue({
      data: { buckets: [ISP_BUCKET], window_days: 30 },
      error: null,
    });
    await render(<IspBreakdownCard />);

    expect(document.querySelector("caption")?.textContent).toBe(
      "ISP breakdown",
    );
    expect(document.querySelectorAll('th[scope="col"]')).toHaveLength(6);
    expect(document.body.textContent).toContain(
      "Engagement per mailbox provider · last 30d",
    );
    expect(document.body.textContent).toContain("40.0%");
    expect(document.body.textContent).toContain("3.3%");
  });

  it("keeps a thrown ISP request distinct from a successful no-sends state", async () => {
    mocks.ispTenant.mockRejectedValue(new Error("network down"));
    await render(<IspBreakdownCard />);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "couldn't load the ISP breakdown",
    );
    expect(document.body.textContent).toContain(
      "ISP breakdown data is unavailable. Retry to load it.",
    );
    expect(document.body.textContent).not.toContain("No sends in the window");
  });

  it("renders per-provider placement counts in a captioned native table", async () => {
    mocks.placementReport.mockResolvedValue({
      data: {
        campaign_id: "campaign-1",
        total_inboxes: 2,
        generated_at: "2026-07-16T12:00:00Z",
        overall_pct: { primary: 0.5, spam: 0.5 },
        providers: [
          {
            provider: "gmail",
            total: 2,
            placements: { primary: 1, spam: 1 },
          },
        ],
      },
      error: null,
    });
    await render(<PlacementReportCard />);
    const campaign = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Campaign for placement report"]',
    )!;
    await act(async () => {
      campaign.value = "campaign-1";
      campaign.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector("caption")?.textContent).toBe(
      "Placement counts by provider",
    );
    expect(document.body.textContent).toContain(
      "2 seed inboxes for the selected campaign",
    );
    expect(document.body.textContent).toContain("gmail");
    expect(document.querySelectorAll('th[scope="col"]')).toHaveLength(4);
  });

  it("expands named authentication details and retains verified rows after re-check failure", async () => {
    const pass = { status: "ok", detail: "Record verified" };
    mocks.authMatrix
      .mockResolvedValueOnce({
        data: [
          {
            domain: "mail.example.test",
            spf: pass,
            dkim: pass,
            dmarc: pass,
            bimi: pass,
            ptr: pass,
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { message: "Temporary DNS outage", status: 500 },
      });
    await render(<AuthChecksMatrixCard />);
    expect(document.querySelector("caption")?.textContent).toBe(
      "Authentication checks",
    );

    const domain = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("mail.example.test"),
    )!;
    act(() => domain.click());
    expect(domain.getAttribute("aria-expanded")).toBe("true");
    const details = document.querySelector(
      '#auth-check-details-mail-example-test[role="region"]',
    )!;
    expect(details.getAttribute("aria-label")).toContain(
      "mail.example.test authentication check details",
    );
    expect(details.textContent).toContain("Record verified");

    const recheck = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Re-check",
    )!;
    await act(async () => {
      recheck.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Temporary DNS outage",
    );
    expect(document.body.textContent).toContain("mail.example.test");
    expect(document.body.textContent).not.toContain(
      "No sending domains resolved",
    );
  });
});
