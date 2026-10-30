// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// /dmarc evidence verbs (parity rows deliverability-6/7/8/12/13/14).
//
// Requests are asserted at the transport — the stubbed fetch — so the path,
// the query NAMES and their values are what the server will see. The server
// allow-lists query names and rejects anything else with `invalid_query`, so
// an extra key is a defect this file must fail on, not tolerate; every
// request assertion therefore checks the full key set, not one key.
//
// Date is frozen (only Date — setTimeout stays real so React can flush), so
// the window edges the page computes are exact strings, not "roughly 30 days".
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DMARC_CSV_HEADER } from "@/lib/dmarc-api";

import { renderPage, unmount, WHOAMI } from "./_harness";

const mocks = vi.hoisted(() => ({
  downloadTextFile: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/download", () => ({
  downloadTextFile: mocks.downloadTextFile,
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/dmarc",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

const NOW = new Date("2026-09-05T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1_000;
const REPORTS_PATH = "/api/v1/deliverability/dmarc-reports";
const INSIGHTS_PATH = "/api/v1/deliverability/dmarc-insights";

const ALIGNED = {
  id: "0f4c9a2e-1111-4111-8111-aaaaaaaaaaaa",
  orgName: "google.com",
  reportId: "google-rid-1",
  domain: "example.com",
  policyP: "reject",
  policyPct: 100,
  dateBegin: "2026-09-01T00:00:00Z",
  dateEnd: "2026-09-01T23:59:59Z",
  passCount: 120,
  failCount: 0,
  receivedAt: "2026-09-02T03:00:00Z",
};
// The org name starts with "=" on purpose: a spreadsheet would execute it.
const FAILED = {
  id: "0f4c9a2e-2222-4222-8222-bbbbbbbbbbbb",
  orgName: "=Yahoo",
  reportId: "yahoo-rid-2",
  domain: "example.com",
  policyP: "quarantine",
  policyPct: null,
  dateBegin: "2026-09-02T00:00:00Z",
  dateEnd: "2026-09-02T23:59:59Z",
  passCount: 80,
  failCount: 20,
  receivedAt: "2026-09-03T03:00:00Z",
};
const EMPTY = {
  id: "0f4c9a2e-3333-4333-8333-cccccccccccc",
  orgName: "Outlook.com",
  reportId: "outlook-rid-3",
  domain: "mail.example.net",
  policyP: "",
  policyPct: null,
  dateBegin: "2026-09-03T00:00:00Z",
  dateEnd: "2026-09-03T23:59:59Z",
  passCount: 0,
  failCount: 0,
  receivedAt: "2026-09-04T03:00:00Z",
};
const SNAPSHOT_AT = "2026-09-05T11:59:58.000Z";

function urlOf(input: RequestInfo | URL): URL {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  return new URL(raw, "http://postwave.test");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Echoes the applied scope back the way the server does. */
function reportsFor(url: URL) {
  const scope: Record<string, string> = {};
  for (const key of ["domain", "from", "to"]) {
    const value = url.searchParams.get(key);
    if (value) scope[key] = value;
  }
  return {
    items: [ALIGNED, FAILED, EMPTY],
    meta: {
      generatedAt: SNAPSHOT_AT,
      limit: 500,
      returned: 3,
      totalReports: 3,
      hasMore: false,
      availableDomains: ["example.com", "mail.example.net"],
      domainInventoryTruncated: false,
      scope,
    },
  };
}

function insightsFor(url: URL) {
  return {
    domain: url.searchParams.get("domain") ?? "",
    periodDays: Number(url.searchParams.get("days") ?? "30"),
    reportCount: 3,
    totalMessages: 220,
    sourceCount: 2,
    sourceListTruncated: false,
    reportingDays: 2,
    alignment: {
      bothPass: 150,
      dkimOnlyPass: 30,
      spfOnlyPass: 20,
      neitherPass: 20,
      alignedPct: 0.9,
    },
    suggestions: [],
    topSources: [],
    generatedAt: SNAPSHOT_AT,
  };
}

function stubTransport(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === REPORTS_PATH) return json(reportsFor(url));
      if (url.pathname === INSIGHTS_PATH) return json(insightsFor(url));
      return json({ error: { code: "not_found", message: "" } }, 404);
    }),
  );
}

function requests(pathname: string): URL[] {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.map(([input]) => urlOf(input))
    .filter((url) => url.pathname === pathname);
}

function lastRequest(pathname: string): URL {
  const all = requests(pathname);
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1]!;
}

function sortedEntries(url: URL): Array<[string, string]> {
  return [...url.searchParams.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === text);
  expect(found, `button "${text}"`).toBeDefined();
  return found!;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();
}

async function setValue(
  el: HTMLInputElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  // React installs its own value setter on inputs, so assigning `.value`
  // directly is swallowed; go through the prototype setter like _harness does.
  const proto =
    el instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();
}

function tableText(container: HTMLElement): string {
  return container.querySelector("tbody")?.textContent ?? "";
}

async function mount() {
  const Page = (await import("@/app/(dashboard)/app/dmarc/page")).default;
  return renderPage(Page);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  stubTransport();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("dmarc evidence", () => {
  it("loads insights and reports for the default 30-day tenant-wide scope", async () => {
    const { container, root, text } = await mount();
    try {
      const reports = requests(REPORTS_PATH);
      expect(reports).toHaveLength(1);
      expect(sortedEntries(reports[0]!)).toEqual([
        ["from", new Date(NOW.getTime() - 30 * DAY).toISOString()],
        ["limit", "500"],
        ["to", NOW.toISOString()],
      ]);

      const insights = requests(INSIGHTS_PATH);
      expect(insights).toHaveLength(1);
      expect(sortedEntries(insights[0]!)).toEqual([["days", "30"]]);

      expect(text).toContain("Last 30 days");
      expect(text).toContain("3 reports in this window, all loaded.");
      const rows = tableText(container);
      expect(rows).toContain("google.com");
      expect(rows).toContain("=Yahoo");
      expect(rows).toContain("Outlook.com");
      expect(button(container, "Export 3 loaded rows").disabled).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("scoping by domain and changing the window change both requests' query", async () => {
    const { container, root } = await mount();
    try {
      const select = container.querySelector<HTMLSelectElement>(
        "select#dmarc-domain",
      );
      expect(select).not.toBeNull();
      // Options come from the server's availableDomains, plus "all".
      expect(
        [...select!.options].map((option) => option.value),
      ).toEqual(["", "example.com", "mail.example.net"]);

      await setValue(select!, "example.com");
      expect(sortedEntries(lastRequest(REPORTS_PATH))).toEqual([
        ["domain", "example.com"],
        ["from", new Date(NOW.getTime() - 30 * DAY).toISOString()],
        ["limit", "500"],
        ["to", NOW.toISOString()],
      ]);
      expect(sortedEntries(lastRequest(INSIGHTS_PATH))).toEqual([
        ["days", "30"],
        ["domain", "example.com"],
      ]);

      const ninety = button(container, "90 days");
      expect(ninety.getAttribute("aria-pressed")).toBe("false");
      await click(ninety);
      expect(ninety.getAttribute("aria-pressed")).toBe("true");
      expect(button(container, "30 days").getAttribute("aria-pressed")).toBe(
        "false",
      );
      expect(sortedEntries(lastRequest(INSIGHTS_PATH))).toEqual([
        ["days", "90"],
        ["domain", "example.com"],
      ]);
      expect(sortedEntries(lastRequest(REPORTS_PATH))).toEqual([
        ["domain", "example.com"],
        ["from", new Date(NOW.getTime() - 90 * DAY).toISOString()],
        ["limit", "500"],
        ["to", NOW.toISOString()],
      ]);
      // The rollup heading is the server's periodDays/domain, not the chip.
      expect(container.textContent).toContain("Last 90 days · example.com");
    } finally {
      unmount(root);
    }
  });

  it("refresh re-requests both evidence endpoints in the current scope", async () => {
    const { container, root } = await mount();
    try {
      await click(button(container, "7 days"));
      const reportsBefore = requests(REPORTS_PATH).length;
      const insightsBefore = requests(INSIGHTS_PATH).length;

      await click(button(container, "Refresh evidence"));

      expect(requests(REPORTS_PATH)).toHaveLength(reportsBefore + 1);
      expect(requests(INSIGHTS_PATH)).toHaveLength(insightsBefore + 1);
      // Same scope as before the refresh — refresh is not a reset.
      expect(sortedEntries(lastRequest(INSIGHTS_PATH))).toEqual([
        ["days", "7"],
      ]);
      expect(lastRequest(REPORTS_PATH).searchParams.get("from")).toBe(
        new Date(NOW.getTime() - 7 * DAY).toISOString(),
      );
    } finally {
      unmount(root);
    }
  });

  it("filters loaded rows by alignment and search without a request", async () => {
    const { container, root } = await mount();
    try {
      const baseline = vi.mocked(globalThis.fetch).mock.calls.length;

      await click(button(container, "Has unaligned"));
      let rows = tableText(container);
      expect(rows).toContain("=Yahoo");
      expect(rows).not.toContain("google.com");
      expect(rows).not.toContain("Outlook.com");
      expect(button(container, "Export 1 loaded row")).toBeDefined();

      // A zero-message report has nothing to be "fully aligned" about.
      await click(button(container, "Fully aligned"));
      rows = tableText(container);
      expect(rows).toContain("google.com");
      expect(rows).not.toContain("=Yahoo");
      expect(rows).not.toContain("Outlook.com");

      await click(button(container, "All loaded"));
      const search = container.querySelector<HTMLInputElement>(
        "input#dmarc-search",
      );
      expect(search).not.toBeNull();
      // "outlook.com" matches the org name only — not the report ID
      // "outlook-rid-3" nor the domain — so this proves org-name search.
      await setValue(search!, "outlook.com");
      rows = tableText(container);
      expect(rows).toContain("Outlook.com");
      expect(rows).not.toContain("google.com");
      expect(rows).not.toContain("=Yahoo");

      await setValue(search!, "nothing-matches-this");
      expect(container.textContent).toContain("No loaded report matches");
      expect(button(container, "Export 0 loaded rows").disabled).toBe(true);

      expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(baseline);
    } finally {
      unmount(root);
    }
  });

  it("opens a report's detail from its row", async () => {
    const { container, root } = await mount();
    try {
      const open = [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((candidate) =>
          candidate
            .getAttribute("aria-label")
            ?.includes("report from =Yahoo for example.com"),
        );
      expect(open).toBeDefined();
      expect(document.querySelector('[role="dialog"]')).toBeNull();

      await click(open!);

      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      const detail = dialog!.textContent ?? "";
      expect(detail).toContain("Validated report receipt");
      expect(detail).toContain(FAILED.reportId);
      expect(detail).toContain(FAILED.id);
      expect(detail).toContain("p=quarantine");
      // 80 of 100 aligned.
      expect(detail).toContain("80.0%");
      expect(detail).toContain("Not reported"); // legacy pct is null
      expect(detail).toContain(
        "not a live DNS observation, a reporter-authenticity verdict",
      );
    } finally {
      unmount(root);
    }
  });

  it("exports the loaded rows as CSV with the evidence receipt", async () => {
    const { container, root } = await mount();
    try {
      const select = container.querySelector<HTMLSelectElement>(
        "select#dmarc-domain",
      );
      await setValue(select!, "example.com");
      await click(button(container, "Has unaligned"));

      await click(button(container, "Export 1 loaded row"));

      expect(mocks.downloadTextFile).toHaveBeenCalledTimes(1);
      const [filename, csv, mime] = mocks.downloadTextFile.mock.calls[0]! as [
        string,
        string,
        string,
      ];
      expect(filename).toBe("dmarc-reports-30d-example.com.csv");
      expect(mime).toBe("text/csv;charset=utf-8");

      const lines = csv.split("\n");
      expect(lines[0]).toBe(DMARC_CSV_HEADER.join(","));
      expect(lines).toHaveLength(2);
      const cells = lines[1]!.split(",");
      expect(cells).toHaveLength(DMARC_CSV_HEADER.length);
      const record = Object.fromEntries(
        DMARC_CSV_HEADER.map((key, index) => [key, cells[index]]),
      );
      expect(record).toMatchObject({
        export_created_at: NOW.toISOString(),
        snapshot_generated_at: SNAPSHOT_AT,
        scope_domain: "example.com",
        scope_from: new Date(NOW.getTime() - 30 * DAY).toISOString(),
        scope_to: NOW.toISOString(),
        scope_window_days: "30",
        local_filter: "failed",
        local_query: "",
        scope_total_reports: "3",
        partial_export: "false",
        stale_snapshot: "false",
        postwave_receipt_id: FAILED.id,
        report_id: FAILED.reportId,
        sending_domain: "example.com",
        // Formula-leading cell neutralised before it reaches a spreadsheet.
        reporting_organization: "'=Yahoo",
        observed_policy: "quarantine",
        observed_policy_pct: "",
        aligned_messages: "80",
        unaligned_messages: "20",
        ingested_at: FAILED.receivedAt,
      });
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Download started with its evidence receipt.",
      );
    } finally {
      unmount(root);
    }
  });
});
