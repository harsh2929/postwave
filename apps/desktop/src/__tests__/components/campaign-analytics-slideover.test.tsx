// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, useState } from "react";
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
  report: vi.fn(),
  links: vi.fn(),
  geo: vi.fn(),
  devices: vi.fn(),
  bounces: vi.fn(),
  benchmark: vi.fn(),
  engagement: vi.fn(),
  timeseries: vi.fn(),
  goal: vi.fn(),
  anomalies: vi.fn(),
  locales: vi.fn(),
  buildStreamUrl: vi.fn(),
  download: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    getCampaignReport: mocks.report,
    getCampaignLinkReport: mocks.links,
    getCampaignGeography: mocks.geo,
    getCampaignDevices: mocks.devices,
    getCampaignBounces: mocks.bounces,
    getCampaignBenchmark: mocks.benchmark,
    getCampaignEngagement: mocks.engagement,
    getCampaignTimeseries: mocks.timeseries,
    getCampaignGoalResults: mocks.goal,
    getCampaignAnomalies: mocks.anomalies,
    getCampaignLocaleReport: mocks.locales,
  },
  buildStreamUrl: mocks.buildStreamUrl,
}));

vi.mock("../../lib/file-transfer", () => ({
  downloadUrlToFile: mocks.download,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    success: mocks.toastSuccess,
    info: mocks.toastInfo,
    error: mocks.toastError,
    warning: mocks.toastWarning,
  },
}));

import {
  CampaignAnalyticsSlideover,
  campaignBenchmarkCanVerdict,
} from "../../components/analytics/CampaignAnalyticsSlideover";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface CampaignIdentity {
  id: string;
  name: string;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of [
    mocks.report,
    mocks.links,
    mocks.geo,
    mocks.devices,
    mocks.bounces,
    mocks.benchmark,
    mocks.engagement,
    mocks.timeseries,
    mocks.goal,
    mocks.anomalies,
    mocks.locales,
  ]) {
    mock.mockReset().mockResolvedValue({ data: null });
  }
  mocks.buildStreamUrl
    .mockReset()
    .mockResolvedValue("https://api.postwave.test/restricted-download");
  mocks.download.mockReset().mockResolvedValue({
    ok: true,
    status: "saved",
    transferId: "transfer-1",
  });
  mocks.toastSuccess.mockReset();
  mocks.toastInfo.mockReset();
  mocks.toastError.mockReset();
  mocks.toastWarning.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function report(
  campaignId = "campaign-1",
  overrides: Record<string, unknown> = {},
) {
  return {
    campaign_id: campaignId,
    sent: 100,
    delivered: 96,
    opens: 52,
    unique_opens: 48,
    clicks: 18,
    unique_clicks: 14,
    bounces: 4,
    complaints: 0,
    unsubscribes: 1,
    open_rate: 50,
    click_rate: 14.6,
    click_to_open_rate: 29.2,
    bounce_rate: 4,
    unsub_rate: 1,
    top_links: [],
    ...overrides,
  };
}

function Harness(): ReactElement {
  const [open, setOpen] = useState(false);
  const [campaign, setCampaign] = useState<CampaignIdentity>({
    id: "campaign-1",
    name: "July launch",
  });
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open analytics
      </button>
      <button
        type="button"
        onClick={() =>
          setCampaign({ id: "campaign-2", name: "August retention" })
        }
      >
        Switch campaign
      </button>
      {open ? (
        <CampaignAnalyticsSlideover
          campaignId={campaign.id}
          campaignName={campaign.name}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function renderHarness(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve();
    }
  });
}

function button(name: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${name}`);
  }
  return match;
}

function tab(name: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ).find((candidate) => candidate.textContent?.includes(name));
  if (!match) throw new Error(`Tab not found: ${name}`);
  return match;
}

function openAnalytics(): HTMLButtonElement {
  const trigger = button("Open analytics");
  trigger.focus();
  act(() => trigger.click());
  return trigger;
}

async function selectTab(name: string): Promise<HTMLButtonElement> {
  const target = tab(name);
  act(() => target.click());
  await settle();
  return target;
}

function seriousAxeViolations(rootNode: HTMLElement) {
  return axe
    .run(rootNode)
    .then((result) =>
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    );
}

describe("CampaignAnalyticsSlideover", () => {
  it("contains unsafe thrown failures, retries only missing evidence, and restores opener focus", async () => {
    mocks.report.mockRejectedValueOnce(
      new Error("postgres://operator:secret@internal/analytics"),
    );
    renderHarness();
    const trigger = openAnalytics();

    const liveStatus = document.querySelector<HTMLElement>(
      ".campaign-evidence-status-message",
    )!;
    expect(liveStatus.getAttribute("aria-busy")).toBe("true");
    expect(liveStatus.textContent).toContain("You can close this panel safely");

    await settle();

    expect(document.body.textContent).not.toContain("operator:secret");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "The service could not be reached",
    );
    expect(mocks.report).toHaveBeenCalledTimes(1);

    act(() => button("Retry failed sources").click());
    await settle();

    expect(mocks.report).toHaveBeenCalledTimes(2);
    expect(mocks.benchmark).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alert"]')).toBeNull();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(
      document.getElementById(dialog.getAttribute("aria-labelledby")!)
        ?.textContent,
    ).toBe("July launch");
    expect(
      document.getElementById(dialog.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toContain("Campaign-lifetime evidence");
    expect(await seriousAxeViolations(dialog)).toEqual([]);

    act(() => {
      document
        .querySelector<HTMLElement>(".slideover-overlay")
        ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    await settle();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("implements manual APG tabs and demand-loads each evidence group once", async () => {
    renderHarness();
    openAnalytics();
    await settle();

    expect(mocks.report).toHaveBeenCalledTimes(1);
    expect(mocks.benchmark).toHaveBeenCalledTimes(1);
    expect(mocks.engagement).toHaveBeenCalledTimes(1);
    expect(mocks.timeseries).toHaveBeenCalledTimes(1);
    expect(mocks.goal).toHaveBeenCalledTimes(1);
    expect(mocks.anomalies).toHaveBeenCalledTimes(1);
    expect(mocks.links).not.toHaveBeenCalled();
    expect(mocks.geo).not.toHaveBeenCalled();
    expect(mocks.devices).not.toHaveBeenCalled();
    expect(mocks.locales).not.toHaveBeenCalled();
    expect(mocks.bounces).not.toHaveBeenCalled();

    const overview = tab("Overview");
    const audience = tab("Audience & links");
    overview.focus();
    act(() => {
      overview.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(document.activeElement).toBe(audience);
    expect(audience.getAttribute("aria-selected")).toBe("false");
    expect(mocks.links).not.toHaveBeenCalled();

    act(() => {
      audience.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();

    expect(audience.getAttribute("aria-selected")).toBe("true");
    const audiencePanel = document.getElementById(
      audience.getAttribute("aria-controls")!,
    )!;
    expect(audiencePanel.getAttribute("role")).toBe("tabpanel");
    expect(audiencePanel.getAttribute("aria-labelledby")).toBe(audience.id);
    expect(audiencePanel.hasAttribute("hidden")).toBe(false);
    expect(mocks.links).toHaveBeenCalledTimes(1);
    expect(mocks.geo).toHaveBeenCalledTimes(1);
    expect(mocks.devices).toHaveBeenCalledTimes(1);
    expect(mocks.locales).toHaveBeenCalledTimes(1);
    expect(mocks.bounces).not.toHaveBeenCalled();

    await selectTab("Overview");
    await selectTab("Audience & links");
    expect(mocks.links).toHaveBeenCalledTimes(1);
    expect(mocks.report).toHaveBeenCalledTimes(1);

    await selectTab("Delivery");
    expect(mocks.bounces).toHaveBeenCalledTimes(1);
    expect(mocks.report).toHaveBeenCalledTimes(1);

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(await seriousAxeViolations(dialog)).toEqual([]);
  });

  it("never presents demand-loading evidence as a verified empty result", async () => {
    const links = deferred<{ data: [] }>();
    const geo = deferred<{ data: [] }>();
    const devices = deferred<{ data: [] }>();
    const locales = deferred<{ data: { campaign_id: string; locales: [] } }>();
    mocks.links.mockReturnValueOnce(links.promise);
    mocks.geo.mockReturnValueOnce(geo.promise);
    mocks.devices.mockReturnValueOnce(devices.promise);
    mocks.locales.mockReturnValueOnce(locales.promise);

    renderHarness();
    openAnalytics();
    await settle();

    act(() => tab("Audience & links").click());
    await settle();

    expect(document.body.textContent).toContain(
      "Loading link-performance evidence",
    );
    expect(document.body.textContent).toContain("Loading mail-client evidence");
    expect(document.body.textContent).toContain("Loading geography evidence");
    expect(document.body.textContent).toContain(
      "Loading recipient-language evidence",
    );
    expect(document.body.textContent).not.toContain(
      "No link activity recorded",
    );
    expect(document.body.textContent).not.toContain("No geography signals");

    links.resolve({ data: [] });
    geo.resolve({ data: [] });
    devices.resolve({ data: [] });
    locales.resolve({
      data: { campaign_id: "campaign-1", locales: [] },
    });
    await settle();

    expect(document.body.textContent).toContain("No link activity recorded");
    expect(document.body.textContent).toContain("No mail-client signals");
    expect(document.body.textContent).toContain("No geography signals");
    expect(document.body.textContent).toContain(
      "No recipient-language evidence",
    );
    expect(document.body.textContent).not.toContain(
      "Loading link-performance evidence",
    );
  });

  it("renders a semantic benchmark table, withholds low-sample verdicts, and never emits NaN", async () => {
    const benchmark = {
      campaign_id: "campaign-1",
      baseline_days: 90,
      baseline_from: "2026-04-01T00:00:00Z",
      baseline_to: "2026-06-30T00:00:00Z",
      as_of: "2026-06-30T00:00:00Z",
      timezone: "UTC",
      baseline_selection: "sent_campaigns_by_last_recipient_sent_at",
      baseline_sample_size: 2,
      minimum_sample_size: 5,
      baseline_available: false,
      baseline_unavailable_reason: "insufficient_baseline_sample",
      this: {
        recipients: 100,
        open_rate: 0.4,
        click_rate: 0.1,
        bounce_rate: 0.02,
        complaint_rate: 0,
        unsubscribe_rate: 0,
      },
      tenant_baseline: {
        recipients: 200,
        open_rate: 0.3,
        click_rate: 0.08,
        bounce_rate: 0.03,
        complaint_rate: 0,
        unsubscribe_rate: 0,
      },
      metrics: [
        {
          name: "open_rate",
          value: 0.4,
          baseline: 0.3,
          delta: 0.1,
          delta_pct: 33.3,
          percentile: null,
          available: false,
          reason: "insufficient_baseline_sample",
        },
      ],
    };
    mocks.report.mockResolvedValue({
      data: report("campaign-1", {
        sent: Number.NaN,
        open_rate: Number.NaN,
      }),
    });
    mocks.benchmark.mockResolvedValue({ data: benchmark });
    mocks.goal.mockResolvedValue({
      data: {
        campaign_id: "campaign-1",
        goal_event: "purchase",
        goal_window_hours: 168,
        configured: true,
        conversion_count: 2,
        recipients: 100,
        conversion_rate: 0.02,
        attributed_revenue_cents: 5000,
        currency: "USD",
      },
    });

    renderHarness();
    openAnalytics();
    await settle();

    expect(campaignBenchmarkCanVerdict(benchmark)).toBe(false);
    expect(document.body.textContent).toContain(
      "Benchmark vs your 90-day baseline",
    );
    expect(document.body.textContent).toContain("2 comparison campaigns");
    expect(document.body.textContent).toContain(
      "Baseline verdicts are withheld",
    );
    expect(document.body.textContent).toContain("withheld");
    expect(document.body.textContent).toContain(
      "Unavailable — currency integrity not provided",
    );
    expect(document.body.textContent).not.toContain("NaN");

    const table = document.querySelector<HTMLTableElement>(
      ".campaign-analytics-benchmark",
    )!;
    expect(table.querySelector("caption")?.textContent).toContain(
      "tenant's 90-day baseline",
    );
    expect(
      Array.from(table.querySelectorAll("thead th")).map((cell) =>
        cell.textContent?.trim(),
      ),
    ).toEqual(["Metric", "Value", "Baseline", "Change", "Verdict"]);
    expect(table.querySelector('tbody th[scope="row"]')?.textContent).toContain(
      "open rate",
    );
  });

  it("refuses unsafe link schemes and keeps tracking queries out of visible labels", async () => {
    mocks.links.mockResolvedValue({
      data: [
        {
          url: "javascript:alert(document.cookie)",
          clicks: 12,
          unique_clickers: 8,
          ctr: 0.12,
        },
        {
          url: "https://example.com/launch?secret_token=never-display",
          clicks: 9,
          unique_clickers: 7,
          ctr: 0.09,
        },
      ],
    });
    mocks.geo.mockResolvedValue({ data: [] });
    mocks.devices.mockResolvedValue({ data: [] });
    mocks.locales.mockResolvedValue({
      data: { campaign_id: "campaign-1", locales: [] },
    });

    renderHarness();
    openAnalytics();
    await settle();
    await selectTab("Audience & links");

    const unsafe = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        ".campaign-analytics-link-row a",
      ),
    ).find((anchor) =>
      anchor.textContent?.includes("Unsupported destination"),
    )!;
    expect(unsafe.getAttribute("href")).toBeNull();
    expect(unsafe.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "example.com/launch · query hidden",
    );
    expect(document.body.textContent).not.toContain("never-display");
  });

  it("requires a field-level privacy review and keeps recipient export single-flight", async () => {
    mocks.report.mockResolvedValue({ data: report() });
    mocks.bounces.mockResolvedValue({
      data: { hard: 2, soft: 1, spam_trap: 0, total: 3 },
    });
    mocks.download.mockResolvedValueOnce({
      ok: true,
      status: "saved",
      transferId: "transfer-1",
      responseHeaders: {
        "x-postwave-truncated": "true",
        "x-postwave-returned-rows": "50,000",
        "x-postwave-total-rows": "61,204",
      },
    });

    renderHarness();
    openAnalytics();
    await settle();
    await selectTab("Delivery");

    expect(mocks.buildStreamUrl).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    const reviewTrigger = button("Review recipient export");
    reviewTrigger.focus();
    act(() => reviewTrigger.click());

    expect(document.body.textContent).toContain("Restricted personal data");
    expect(document.body.textContent).toContain("Subscriber email");
    expect(document.body.textContent).toContain(
      "first bounded page of up to 50,000 rows",
    );
    expect(document.body.textContent).toContain(
      "rechecks campaign, report, and subscriber-read permission",
    );
    expect(document.body.textContent).not.toContain("restricted-download");

    const exportDialog = Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"]'),
    ).find((candidate) =>
      candidate.textContent?.includes(
        "Export recipient-level campaign evidence?",
      ),
    )!;
    expect(await seriousAxeViolations(exportDialog)).toEqual([]);

    const confirm = button("Download up to 50,000 rows");
    act(() => {
      confirm.click();
      confirm.click();
    });
    await settle();

    expect(mocks.buildStreamUrl).toHaveBeenCalledTimes(1);
    expect(mocks.buildStreamUrl).toHaveBeenCalledWith(
      "/api/v1/campaigns/campaign-1/report.csv?limit=50000",
    );
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedName: "campaign-campaign-1-recipients.csv",
        privacy: "personal",
        maxBytes: 10 * 1024 * 1024,
        allowExternalFallback: false,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(document.body.textContent).not.toContain("restricted-download");
    expect(document.body.textContent).not.toContain(
      "Export recipient-level campaign evidence?",
    );
    expect(document.activeElement).toBe(reviewTrigger);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Recipient lifecycle export saved.",
    );
    expect(mocks.toastInfo).toHaveBeenCalledWith({
      message: "Saved 50,000 of 61,204 recipient rows",
      detail:
        "This download is the API's bounded first page. Use the paginated report API for the remaining rows.",
    });
  });

  it("keeps export failures generic and never exposes signed-url detail", async () => {
    mocks.report.mockResolvedValue({ data: report() });
    mocks.bounces.mockResolvedValue({
      data: { hard: 0, soft: 0, spam_trap: 0, total: 0 },
    });
    mocks.buildStreamUrl.mockRejectedValueOnce(
      new Error(
        "https://api.postwave.test/download?authorization=secret-token",
      ),
    );

    renderHarness();
    openAnalytics();
    await settle();
    await selectTab("Delivery");
    act(() => button("Review recipient export").click());
    act(() => button("Download up to 50,000 rows").click());
    await settle();

    expect(document.body.textContent).toContain("Export not created");
    expect(document.body.textContent).toContain(
      "could not authorize this restricted export",
    );
    expect(document.body.textContent).not.toContain("secret-token");
    expect(document.body.textContent).not.toContain("authorization=");
    expect(mocks.download).not.toHaveBeenCalled();
    expect(button("Download up to 50,000 rows").disabled).toBe(false);
  });

  it("discards a late response from the previous campaign identity", async () => {
    const firstReport = deferred<{ data: ReturnType<typeof report> }>();
    mocks.report
      .mockReturnValueOnce(firstReport.promise)
      .mockResolvedValueOnce({
        data: report("campaign-2", { sent: 22 }),
      });

    renderHarness();
    openAnalytics();
    await settle();
    act(() => button("Switch campaign").click());
    await settle();

    expect(document.body.textContent).toContain("August retention");
    const sentTerm = Array.from(document.querySelectorAll("dt")).find(
      (term) => term.textContent === "Sent",
    )!;
    expect(sentTerm.parentElement?.querySelector("dd")?.textContent).toBe("22");

    firstReport.resolve({
      data: report("campaign-1", { sent: 999_999 }),
    });
    await settle();

    expect(document.body.textContent).toContain("August retention");
    expect(sentTerm.parentElement?.querySelector("dd")?.textContent).toBe("22");
    expect(document.body.textContent).not.toContain("999,999");
    expect(mocks.report).toHaveBeenCalledTimes(2);
  });

  it("discards a late signed export URL after campaign identity changes", async () => {
    const signedUrl = deferred<string>();
    mocks.report
      .mockResolvedValueOnce({ data: report("campaign-1") })
      .mockResolvedValueOnce({ data: report("campaign-2") });
    mocks.buildStreamUrl.mockReturnValueOnce(signedUrl.promise);

    renderHarness();
    openAnalytics();
    await settle();
    await selectTab("Delivery");
    act(() => button("Review recipient export").click());
    act(() => button("Download up to 50,000 rows").click());
    await settle();

    expect(mocks.buildStreamUrl).toHaveBeenCalledTimes(1);
    expect(mocks.download).not.toHaveBeenCalled();

    act(() => button("Switch campaign").click());
    await settle();
    signedUrl.resolve(
      "https://api.postwave.test/download?authorization=late-secret",
    );
    await settle();

    expect(mocks.download).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("August retention");
    expect(document.body.textContent).not.toContain("late-secret");
    expect(document.body.textContent).not.toContain(
      "Export recipient-level campaign evidence?",
    );
  });

  it("aborts an in-flight personal-data transfer when campaign identity changes", async () => {
    let transferSignal: AbortSignal | null = null;
    mocks.report
      .mockResolvedValueOnce({ data: report("campaign-1") })
      .mockResolvedValueOnce({ data: report("campaign-2") });
    mocks.bounces.mockResolvedValue({
      data: { hard: 1, soft: 0, spam_trap: 0, total: 1 },
    });
    mocks.download.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          transferSignal = signal;
          const cancelled = () =>
            resolve({
              ok: false,
              code: "cancelled",
              message: "cancelled",
              transferId: "transfer-1",
            });
          if (signal.aborted) cancelled();
          else signal.addEventListener("abort", cancelled, { once: true });
        }),
    );

    renderHarness();
    openAnalytics();
    await settle();
    await selectTab("Delivery");
    act(() => button("Review recipient export").click());
    act(() => button("Download up to 50,000 rows").click());
    await settle();

    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(transferSignal).not.toBeNull();
    expect(transferSignal!.aborted).toBe(false);

    act(() => button("Switch campaign").click());
    await settle();

    expect(transferSignal!.aborted).toBe(true);
    expect(document.body.textContent).toContain("August retention");
    expect(document.body.textContent).not.toContain(
      "Export recipient-level campaign evidence?",
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
