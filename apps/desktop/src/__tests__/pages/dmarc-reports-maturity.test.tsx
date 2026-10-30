// @vitest-environment happy-dom

import axe from "axe-core";
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
  callOrder: [] as string[],
  getDmarcInsights: vi.fn(),
  getDmarcSourceDetail: vi.fn(),
  listDmarcReports: vi.fn(),
  saveFile: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    getDmarcInsights: mocks.getDmarcInsights,
    getDmarcSourceDetail: mocks.getDmarcSourceDetail,
    listDmarcReports: mocks.listDmarcReports,
  },
}));

vi.mock("../../lib/file-transfer", () => ({
  saveFile: mocks.saveFile,
}));

import { DmarcReports } from "../../pages/DmarcReports";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-03T08:30:00.000Z"));
  mocks.callOrder.length = 0;
  mocks.getDmarcInsights.mockReset();
  mocks.getDmarcSourceDetail.mockReset();
  mocks.listDmarcReports.mockReset();
  mocks.saveFile.mockReset();
  mocks.listDmarcReports.mockImplementation(() => {
    mocks.callOrder.push("reports");
    return Promise.resolve({ data: reportResponse() });
  });
  mocks.getDmarcInsights.mockImplementation(() => {
    mocks.callOrder.push("insights");
    return Promise.resolve({ data: insightsResponse() });
  });
  mocks.saveFile.mockResolvedValue({
    ok: true,
    status: "saved",
    transferId: "transfer-1",
    collision: false,
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function reportResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const item = {
    id: "11111111-1111-4111-8111-111111111111",
    orgName: "Mailbox Example",
    reportId: "provider-report-01",
    domain: "example.test",
    policyP: "none",
    policyPct: 100,
    dateBegin: "2026-08-01T00:00:00.000Z",
    dateEnd: "2026-08-02T00:00:00.000Z",
    passCount: 90,
    failCount: 10,
    receivedAt: "2026-08-02T02:00:00.000Z",
  };
  return {
    items: [item],
    meta: {
      generatedAt: "2026-08-03T08:30:00.000Z",
      limit: 500,
      returned: 1,
      totalReports: 1,
      hasMore: false,
      availableDomains: ["example.test"],
      domainInventoryTruncated: false,
      scope: {
        from: "2026-07-04T08:30:00.000Z",
        to: "2026-08-03T08:30:00.000Z",
      },
    },
    ...overrides,
  };
}

function insightsResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const source = {
    sourceIp: "192.0.2.10",
    messages: 100,
    dkimPass: 80,
    spfPass: 70,
    bothPass: 60,
    alignedPct: 0.9,
    primaryDisposition: "none",
    quarantined: 0,
    rejected: 0,
    envelopeFromDomain: "mailer.example.test",
  };
  return {
    domain: "",
    periodDays: 30,
    generatedAt: "2026-08-03T08:30:00.000Z",
    windowStart: "2026-07-04T08:30:00.000Z",
    windowEnd: "2026-08-03T08:30:00.000Z",
    latestReportAt: "2026-08-02T02:00:00.000Z",
    reportingDays: 1,
    reportCount: 1,
    totalMessages: 100,
    sourceCount: 1,
    sourceListTruncated: false,
    alignment: {
      bothPass: 60,
      dkimOnlyPass: 20,
      spfOnlyPass: 10,
      neitherPass: 10,
      alignedPct: 0.9,
    },
    disposition: { none: 95, quarantine: 3, reject: 2, unknown: 0 },
    topSources: [source],
    topFailingSources: [],
    suggestions: [
      {
        code: "alignment_low",
        severity: "warning",
        action: "Review the largest unaligned source.",
        reason: "Ten messages did not align in this snapshot.",
      },
    ],
    series: [
      { date: "2026-08-01", messages: 100, aligned: 90, alignedPct: 0.9 },
    ],
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderRoute(node: ReactElement = <DmarcReports />): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function settle(turns = 8): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
  });
}

function button(name: string | RegExp): HTMLButtonElement {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => {
    const label =
      candidate.getAttribute("aria-label") ??
      candidate.textContent?.replace(/\s+/gu, " ").trim() ??
      "";
    return typeof name === "string" ? label === name : name.test(label);
  });
  if (!found) throw new Error(`Missing button ${String(name)}`);
  return found;
}

describe("DMARC evidence workspace", () => {
  it("renders scoped aggregate evidence with deterministic reads and no unsafe DNS actions", async () => {
    renderRoute();
    await settle();

    expect(mocks.callOrder).toEqual(["reports", "insights"]);
    expect(mocks.listDmarcReports.mock.calls[0]?.[0]?.signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(mocks.listDmarcReports.mock.calls[0]?.[0]?.to).toBe(
      "2026-08-03T08:30:00.000Z",
    );
    expect(mocks.getDmarcInsights.mock.calls[0]?.[0]?.signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(
      document.querySelector('[aria-label="DMARC evidence scope"]'),
    ).not.toBeNull();
    expect(document.querySelector("#dmarc-domain")).not.toBeNull();
    expect(document.body.textContent).toContain(
      "100 messages across 1 report · 1 source IP",
    );
    expect(document.body.textContent).not.toContain("1 reports");
    expect(document.body.textContent).not.toContain("1 source IPs");
    expect(document.body.textContent).toContain("1 reporting day");
    expect(document.body.textContent).toContain("90.0%");
    expect(document.body.textContent).toContain(
      "messages were explicitly reported with disposition=none",
    );
    expect(document.body.textContent).toContain("Observation only");
    expect(document.body.textContent).toContain("not a live DNS lookup");
    expect(document.body.textContent).not.toContain("Copy DNS");
    expect(document.body.textContent).not.toContain("Restore dismissed");
    expect(document.body.textContent).not.toContain("delivered");
    expect(
      document.querySelector(
        '[aria-label="DMARC workspaces"] [aria-selected="true"]',
      )?.textContent,
    ).toContain("Overview");

    vi.useRealTimers();
    const results = await axe.run(container!);
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("withholds malformed insights while preserving a valid report workspace", async () => {
    mocks.getDmarcInsights.mockResolvedValueOnce({
      data: insightsResponse({ totalMessages: 999 }),
    });
    renderRoute();
    await settle();

    expect(document.body.textContent).toContain(
      "Aggregate insights response withheld",
    );
    expect(document.body.textContent).toContain(
      "1 report receipt available; aggregate insights are unavailable",
    );
    expect(document.body.textContent).toContain(
      "No empty state, zero metric, or policy conclusion",
    );
    expect(
      document.querySelector(
        '[aria-label="Validated DMARC aggregate summary"]',
      ),
    ).toBeNull();

    act(() => button(/^Reports/).click());
    expect(document.body.textContent).toContain("1 of 1 report loaded");
    expect(document.body.textContent).toContain("Mailbox Example");
  });

  it("uses roving keyboard tabs and mounts only the active workspace", async () => {
    renderRoute();
    await settle();
    const tablist = document.querySelector(
      '[role="tablist"][aria-label="DMARC workspaces"]',
    );
    const workspaceTabs = Array.from(
      tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
    );
    const overview = workspaceTabs.find((tab) =>
      tab.textContent?.includes("Overview"),
    );
    const sources = workspaceTabs.find((tab) =>
      tab.textContent?.includes("Sources"),
    );
    const reports = workspaceTabs.find((tab) =>
      tab.textContent?.includes("Reports"),
    );
    expect(overview?.getAttribute("aria-selected")).toBe("true");
    expect(overview?.getAttribute("aria-controls")).toBeTruthy();
    expect(
      document.getElementById(overview?.getAttribute("aria-controls") ?? ""),
    ).not.toBeNull();
    expect(
      document.getElementById(sources?.getAttribute("aria-controls") ?? ""),
    ).toBeNull();

    act(() => {
      overview?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(sources?.getAttribute("aria-selected")).toBe("true");
    expect(
      document.getElementById(overview?.getAttribute("aria-controls") ?? ""),
    ).toBeNull();
    expect(
      document.getElementById(sources?.getAttribute("aria-controls") ?? ""),
    ).not.toBeNull();

    act(() => {
      sources?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    });
    expect(reports?.getAttribute("aria-selected")).toBe("true");
    expect(
      document.getElementById(reports?.getAttribute("aria-controls") ?? ""),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[role="group"][aria-label="Filter loaded reports by alignment result"]',
      ),
    ).not.toBeNull();
  });

  it("commits the fast report resource without waiting for slow insights", async () => {
    const pendingInsights = deferred<{ data: Record<string, unknown> }>();
    mocks.getDmarcInsights.mockReset().mockReturnValue(pendingInsights.promise);
    renderRoute();
    await settle();

    act(() => button(/^Reports/).click());
    expect(document.body.textContent).toContain("1 of 1 report loaded");
    expect(document.body.textContent).toContain("Mailbox Example");
    expect(document.body.textContent).toContain(
      "Validating aggregate evidence",
    );

    await act(async () => {
      pendingInsights.resolve({ data: insightsResponse() });
      await pendingInsights.promise;
    });
    expect(document.body.textContent).toContain("100 messages across 1 report");
  });

  it("retains and labels the last contract-valid snapshot when a same-scope refresh fails", async () => {
    renderRoute();
    await settle();
    expect(document.body.textContent).toContain("90.0%");

    mocks.getDmarcInsights.mockResolvedValueOnce({
      error: { kind: "network", message: "insights service unavailable" },
    });
    act(() => button("Refresh evidence").click());
    await settle();

    expect(document.body.textContent).toContain("insights service unavailable");
    expect(document.body.textContent).toContain(
      "last contract-valid snapshot for this exact scope",
    );
    expect(document.body.textContent).toContain("90.0%");
    expect(document.body.textContent).toContain(
      "Last contract-valid insights snapshot",
    );
  });

  it("ignores a late superseded scope even when its mocked transport resolves", async () => {
    const oldReports = deferred<{ data: Record<string, unknown> }>();
    const oldInsights = deferred<{ data: Record<string, unknown> }>();
    mocks.listDmarcReports
      .mockReset()
      .mockReturnValueOnce(oldReports.promise)
      .mockResolvedValue({
        data: reportResponse({
          meta: {
            generatedAt: "2026-08-03T08:30:00.000Z",
            limit: 500,
            returned: 1,
            totalReports: 1,
            hasMore: false,
            availableDomains: ["example.test"],
            domainInventoryTruncated: false,
            scope: {
              from: "2026-07-27T08:30:00.000Z",
              to: "2026-08-03T08:30:00.000Z",
            },
          },
        }),
      });
    mocks.getDmarcInsights
      .mockReset()
      .mockReturnValueOnce(oldInsights.promise)
      .mockResolvedValue({
        data: insightsResponse({
          periodDays: 7,
          windowStart: "2026-07-27T08:30:00.000Z",
          totalMessages: 200,
          reportCount: 2,
          alignment: {
            bothPass: 120,
            dkimOnlyPass: 40,
            spfOnlyPass: 20,
            neitherPass: 20,
            alignedPct: 0.9,
          },
          disposition: { none: 190, quarantine: 6, reject: 4, unknown: 0 },
          series: [
            {
              date: "2026-08-01",
              messages: 200,
              aligned: 180,
              alignedPct: 0.9,
            },
          ],
        }),
      });

    renderRoute();
    act(() => button("7 days").click());
    await settle();
    expect(document.body.textContent).toContain(
      "200 messages across 2 reports",
    );

    await act(async () => {
      oldReports.resolve({ data: reportResponse() });
      oldInsights.resolve({ data: insightsResponse() });
      await Promise.all([oldReports.promise, oldInsights.promise]);
    });
    expect(document.body.textContent).toContain(
      "200 messages across 2 reports",
    );
    expect(document.body.textContent).not.toContain(
      "100 messages across 1 report",
    );
  });

  it("exports only loaded filtered rows with formula neutralization and a partial receipt", async () => {
    const partialRows = Array.from({ length: 500 }, (_, index) => ({
      id: `${(500 - index).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
      orgName: index === 0 ? "+Mailbox Formula" : `Mailbox ${index}`,
      reportId:
        index === 0
          ? '=WEBSERVICE("https://attacker.invalid")'
          : `provider-report-${index}`,
      domain: "example.test",
      policyP: "none",
      policyPct: 100,
      dateBegin: "2026-08-01T00:00:00.000Z",
      dateEnd: "2026-08-02T00:00:00.000Z",
      passCount: 90,
      failCount: 10,
      receivedAt: "2026-08-02T02:00:00.000Z",
    }));
    mocks.listDmarcReports.mockResolvedValueOnce({
      data: reportResponse({
        items: partialRows,
        meta: {
          generatedAt: "2026-08-03T08:30:00.000Z",
          limit: 500,
          returned: 500,
          totalReports: 501,
          hasMore: true,
          availableDomains: ["example.test"],
          domainInventoryTruncated: false,
          scope: {
            from: "2026-07-04T08:30:00.000Z",
            to: "2026-08-03T08:30:00.000Z",
          },
        },
      }),
    });
    renderRoute();
    await settle();
    act(() => button(/^Reports/).click());
    expect(document.body.textContent).toContain(
      "This list and export are partial",
    );
    act(() => button("Export 500 loaded rows").click());
    await settle();

    const payload = mocks.saveFile.mock.calls[0]?.[0];
    expect(payload.privacy).toBe("confidential");
    expect(payload.data).toContain("partial_export,stale_snapshot");
    expect(payload.data).toContain(",true,false,");
    expect(payload.data).toContain("2026-08-03T08:30:00.000Z");
    expect(payload.data).toContain("postwave_receipt_id,report_id");
    expect(payload.data).toContain("'=WEBSERVICE");
    expect(payload.data).toContain("'+Mailbox Formula");
    expect(payload.data).not.toMatch(/\n=WEBSERVICE/u);
    expect(payload.data).not.toMatch(/,\+Mailbox Formula/u);
  });

  it("deduplicates an in-flight export and announces cancellation and retry failure", async () => {
    const save = deferred<{
      ok: true;
      status: "cancelled";
      transferId: string;
    }>();
    mocks.saveFile.mockReset().mockReturnValueOnce(save.promise);
    renderRoute();
    await settle();
    act(() => button(/^Reports/).click());
    act(() => button("Export 1 loaded row").click());
    expect(button("Preparing export…").disabled).toBe(true);
    act(() => button("Preparing export…").click());
    expect(mocks.saveFile).toHaveBeenCalledOnce();

    await act(async () => {
      save.resolve({
        ok: true,
        status: "cancelled",
        transferId: "transfer-cancel",
      });
      await save.promise;
    });
    expect(document.body.textContent).toContain(
      "Export cancelled; no destination was written",
    );

    mocks.saveFile.mockResolvedValueOnce({
      ok: false,
      transferId: "transfer-fail",
      code: "write_failed",
      message: "Moosewave could not save the file.",
    });
    act(() => button("Export 1 loaded row").click());
    await settle();
    expect(document.body.textContent).toContain(
      "Moosewave could not save the file",
    );
    expect(document.body.textContent).not.toContain(
      "Report receipts could not be refreshed",
    );
  });

  it("distinguishes no report receipts from reports with no usable message rows", async () => {
    const emptyEvidence = {
      reportingDays: 0,
      totalMessages: 0,
      sourceCount: 0,
      sourceListTruncated: false,
      alignment: {
        bothPass: 0,
        dkimOnlyPass: 0,
        spfOnlyPass: 0,
        neitherPass: 0,
        alignedPct: 0,
      },
      disposition: { none: 0, quarantine: 0, reject: 0, unknown: 0 },
      topSources: [],
      topFailingSources: [],
      series: [],
    };
    mocks.getDmarcInsights.mockResolvedValueOnce({
      data: insightsResponse({
        ...emptyEvidence,
        reportCount: 0,
        latestReportAt: undefined,
        suggestions: [
          {
            code: "no_reports",
            severity: "info",
            action: "Wait for the first DMARC report",
            reason: "No aggregate reports were ingested in this window.",
          },
        ],
      }),
    });
    renderRoute();
    await settle();

    expect(document.body.textContent).toContain("No ingested report receipts");
    expect(document.body.textContent).toContain(
      "does not prove reporting is connected",
    );
    expect(document.body.textContent).toContain(
      "Wait for the first DMARC report",
    );

    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    mocks.getDmarcInsights.mockResolvedValueOnce({
      data: insightsResponse({
        ...emptyEvidence,
        reportCount: 2,
        latestReportAt: "2026-08-02T02:00:00.000Z",
        suggestions: [
          {
            code: "no_observed_messages",
            severity: "warning",
            action: "Review reports with no message records",
            reason: "Two reports contributed no positive message count.",
          },
        ],
      }),
    });
    renderRoute();
    await settle();

    expect(document.body.textContent).toContain(
      "Reports without usable message rows",
    );
    expect(document.body.textContent).toContain(
      "2 reports contributed no positive message count",
    );
    expect(document.body.textContent).toContain(
      "Review reports with no message records",
    );
  });

  it("aborts an in-flight export when the same scope refreshes", async () => {
    const save = deferred<{
      ok: true;
      status: "saved";
      transferId: string;
      collision: false;
    }>();
    mocks.saveFile.mockReset().mockReturnValueOnce(save.promise);
    renderRoute();
    await settle();
    act(() => button(/^Reports/).click());
    act(() => button("Export 1 loaded row").click());
    const signal = mocks.saveFile.mock.calls[0]?.[0]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    act(() => button("Refresh evidence").click());
    await settle();
    expect(signal.aborted).toBe(true);
    expect(document.body.textContent).not.toContain("Preparing the receipt");

    await act(async () => {
      save.resolve({
        ok: true,
        status: "saved",
        transferId: "stale-export",
        collision: false,
      });
      await save.promise;
    });
    expect(document.body.textContent).not.toContain(
      "CSV saved with its evidence receipt",
    );
  });

  it("offers an editable exact-domain recovery when the discovery inventory is partial", async () => {
    mocks.listDmarcReports.mockResolvedValueOnce({
      data: reportResponse({
        meta: {
          generatedAt: "2026-08-03T08:30:00.000Z",
          limit: 500,
          returned: 1,
          totalReports: 1,
          hasMore: false,
          availableDomains: ["example.test"],
          domainInventoryTruncated: true,
          scope: {
            from: "2026-07-04T08:30:00.000Z",
            to: "2026-08-03T08:30:00.000Z",
          },
        },
      }),
    });
    renderRoute();
    await settle();
    const input = document.querySelector<HTMLInputElement>("#dmarc-domain");
    expect(input?.tagName).toBe("INPUT");
    expect(input?.getAttribute("list")).toBe("dmarc-domain-options");
    expect(document.body.textContent).toContain(
      "accepts an exact known hostname",
    );
    expect(document.body.textContent).toContain("Inventory is partial");
  });
});
