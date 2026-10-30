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

const mocks = vi.hoisted(() => ({
  me: { user: "operator@example.test", tenant: "tenant-a" },
  summary: vi.fn(),
  history: vi.fn(),
  dns: vi.fn(),
  hits: vi.fn(),
  webhooks: vi.fn(),
  bounces: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useMe: () => mocks.me,
}));

vi.mock("../../lib/api-client", () => ({
  deliverabilityHubApi: {
    get: mocks.summary,
    history: mocks.history,
    dnsHealth: mocks.dns,
    blocklistHits: mocks.hits,
    webhookErrors: mocks.webhooks,
    bounceClassBreakdown: mocks.bounces,
  },
}));

import {
  deliverabilityRefreshReceipt,
  type DeliverabilityHubData,
  useDeliverabilityHubData,
} from "../../pages/useDeliverabilityHubData";

const SUMMARY = {
  score: 92,
  grade: "A",
  status: "healthy",
  trend: "up",
  trend_delta: 2,
  trend_reference_at: "2026-07-07T00:00:00Z",
  history: [90, 91, 92],
  breaches: [],
  auto_throttled: false,
  event_rate_scope: "campaigns",
  model_version: "campaign-cohort-v2-2026-08-02",
  sample_qualified: true,
  minimum_sample_sends: 1000,
  totals: { sends_7d: 1000, sends_30d: 4000 },
  computed_at: "2026-07-14T00:00:00Z",
};

const HISTORY = {
  snapshots: [
    {
      sampled_at: "2026-07-14T00:00:00Z",
      score: 92,
      model_version: "campaign-cohort-v2-2026-08-02",
      sample_qualified: true,
      sample_size: 4000,
    },
  ],
  window_days: 30,
  count: 1,
  model_version: "campaign-cohort-v2-2026-08-02",
};

let root: Root | null = null;
let latest: DeliverabilityHubData | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of [
    mocks.summary,
    mocks.history,
    mocks.dns,
    mocks.hits,
    mocks.webhooks,
    mocks.bounces,
  ]) {
    mock.mockReset();
  }
  mocks.summary.mockResolvedValue({ data: SUMMARY });
  mocks.history.mockResolvedValue({ data: HISTORY });
  mocks.dns.mockResolvedValue({ data: { identities: [] } });
  mocks.hits.mockResolvedValue({ data: { items: [] } });
  mocks.webhooks.mockResolvedValue({ data: { items: [] } });
  mocks.bounces.mockResolvedValue({
    data: { window_days: 30, total_bounces: 0, classes: [] },
  });
  vi.spyOn(Date, "now").mockReturnValue(1_784_142_000_000);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  latest = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function Probe(): ReactElement {
  latest = useDeliverabilityHubData();
  return <output>{latest.loading ? "loading" : "settled"}</output>;
}

function current(): DeliverabilityHubData {
  if (!latest) throw new Error("Deliverability controller did not render");
  return latest;
}

async function renderProbe(): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Probe />);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useDeliverabilityHubData refresh receipts", () => {
  it("records a complete six-surface refresh as verified", async () => {
    await renderProbe();

    expect(current().errors).toEqual({});
    expect(current().summary?.score).toBe(92);
    expect(current().refreshCompletedAt).toBe(1_784_142_000_000);
    expect(deliverabilityRefreshReceipt(current())).toContain(
      "All 6 evidence surfaces verified at",
    );
  });

  it("reports a partial refresh and retains last-verified surfaces", async () => {
    await renderProbe();
    const verifiedHistory = current().history;
    mocks.history.mockRejectedValueOnce(new Error("History transport offline"));
    mocks.webhooks.mockResolvedValueOnce({
      error: { message: "Webhook audit unavailable" },
    });

    await act(async () => {
      await current().refresh();
    });

    expect(current().history).toBe(verifiedHistory);
    expect(current().errors).toMatchObject({
      history: "History transport offline",
      webhooks: "Webhook audit unavailable",
    });
    expect(deliverabilityRefreshReceipt(current())).toContain(
      "Partial refresh at",
    );
    expect(deliverabilityRefreshReceipt(current())).toContain(
      "4 of 6 surfaces verified",
    );
  });

  it("reports an all-failed attempt without claiming completion", async () => {
    for (const mock of [
      mocks.summary,
      mocks.history,
      mocks.dns,
      mocks.hits,
      mocks.webhooks,
      mocks.bounces,
    ]) {
      mock.mockRejectedValue(new Error("Transport offline"));
    }

    await renderProbe();

    expect(Object.keys(current().errors)).toHaveLength(6);
    expect(current().summary).toBeNull();
    expect(deliverabilityRefreshReceipt(current())).toContain(
      "Refresh failed at",
    );
    expect(deliverabilityRefreshReceipt(current())).toContain(
      "0 of 6 surfaces verified",
    );
    expect(deliverabilityRefreshReceipt(current())).not.toContain(
      "Refresh completed",
    );
  });
});
