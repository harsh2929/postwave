// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// governance-108: privacy-portal KPI hints, DSAR-by-type and suppression
// charts, their data-table disclosures, and the three CSV exports — with a
// tenant-controlled formula-looking label neutralised in the downloaded file.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const downloads = vi.hoisted(() => ({
  downloadTextFile: vi.fn(
    (_name: string, _content: string, _mime?: string) => undefined,
  ),
}));
vi.mock("@/lib/download", () => downloads);

import { PortalDashboard } from "@/components/privacy/PortalDashboard";
import type { PrivacyPortal } from "@/lib/privacy-portal-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SUMMARY: PrivacyPortal = {
  tenantId: "22222222-2222-4222-8222-222222222222",
  regions: [],
  dsar_requests: [
    { request_type: "access", open: 3, overdue: 1, closed: 7 },
    { request_type: "=HYPERLINK(\"http://evil.test\")", open: 1, overdue: 0, closed: 0 },
  ],
  suppression_breakdown: [
    { reason: "hard_bounce", count: 40 },
    { reason: "@SUM(A1:A9)", count: 10 },
    { reason: "complaint", count: 5 },
    { reason: "manual", count: 2 },
    { reason: "fifth_reason_not_shown", count: 1 },
  ],
  consent_proof_summary: [],
  gpc_signaled_count: 12,
  do_not_sell_count: 4,
  double_optin_pending: 9,
  generated_at: "2026-09-10T08:00:00Z",
};

let container: HTMLElement;
let root: Root;

async function mount(summary: PrivacyPortal) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(PortalDashboard, { summary }));
  });
}

function exportButton(title: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    `button[aria-label="Export ${title} data as CSV"]`,
  );
  if (!found) throw new Error(`Missing export for ${title}`);
  return found;
}

async function exportCsv(title: string) {
  await act(async () => {
    exportButton(title).click();
  });
  const call = downloads.downloadTextFile.mock.calls.at(-1);
  if (!call) throw new Error("no download");
  return { name: call[0], csv: call[1], mime: call[2] };
}

afterEach(() => {
  act(() => root.unmount());
  downloads.downloadTextFile.mockReset();
  document.body.innerHTML = "";
});

describe("PortalDashboard", () => {
  it("renders every KPI with its hint and the summed DSAR counts", async () => {
    await mount(SUMMARY);
    const cells = [...container.querySelectorAll("dl > div")].map((cell) =>
      [...cell.children].map((child) => child.textContent),
    );
    expect(cells.slice(0, 5)).toEqual([
      [
        "DSAR · open",
        "4",
        "Privacy requests (access / deletion / portability) not yet completed.",
      ],
      [
        "DSAR · overdue",
        "1",
        "Open requests past their statutory due date (GDPR Art.12: 30d; CCPA: 45d).",
      ],
      [
        "GPC signaled",
        "12",
        "Subscribers whose browser sent the Global Privacy Control header.",
      ],
      [
        "Do-not-sell",
        "4",
        "Subscribers with the do-not-sell preference enabled (CCPA §1798.135).",
      ],
      [
        "Double opt-in · pending",
        "9",
        "Tokens awaiting subscriber confirmation. Expires after 60 days.",
      ],
    ]);
  });

  it("charts DSAR by type and the top four suppression reasons behind data-table disclosures", async () => {
    await mount(SUMMARY);
    const dsar = container.querySelector('[aria-label="DSAR requests by type"]');
    expect(dsar?.textContent).toContain("3 open · 1 overdue · 7 closed");
    const reasons = container.querySelector('[aria-label="Suppression reasons"]');
    expect(reasons?.querySelectorAll("li")).toHaveLength(4);
    expect(reasons?.textContent).not.toContain("fifth_reason_not_shown");
    const bar = reasons?.querySelector<HTMLElement>('[title="complaint: 5"]');
    expect(bar?.style.width).toBe("12.5%");

    const disclosures = [
      ...container.querySelectorAll<HTMLElement>("details > summary"),
    ].map((summary) => summary.getAttribute("aria-label"));
    expect(disclosures).toEqual([
      "View data table for Privacy-portal summary indicators",
      "View data table for DSAR requests by request type and status",
      "View data table for Privacy-portal suppression reasons",
    ]);
  });

  it("exports the DSAR table as CSV with formula-looking request types neutralised", async () => {
    await mount(SUMMARY);
    const { name, csv, mime } = await exportCsv(
      "DSAR requests by request type and status",
    );
    expect(name).toBe("privacy-dsar-requests-by-type.csv");
    expect(mime).toBe("text/csv;charset=utf-8");
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Chart,DSAR requests by request type and status");
    expect(lines[1]).toBe("Source,GET /api/v1/privacy/portal");
    expect(lines[3]).toBe("Data as of,2026-09-10T08:00:00Z");
    expect(lines.slice(6)).toEqual([
      "Request type,Open requests,Overdue requests,Closed requests",
      "access,3,1,7",
      `"'=HYPERLINK(""http://evil.test"")",1,0,0`,
    ]);
    expect(container.textContent).toContain("Chart data export started.");
  });

  it("exports suppression reasons and summary indicators to their own files", async () => {
    await mount(SUMMARY);
    const reasons = await exportCsv("Privacy-portal suppression reasons");
    expect(reasons.name).toBe("privacy-portal-suppression-reasons.csv");
    expect(reasons.csv.split("\r\n").slice(6)).toEqual([
      "Suppression reason,Suppressions,Relative to displayed maximum (%)",
      "hard_bounce,40,100",
      "'@SUM(A1:A9),10,25",
      "complaint,5,12.5",
      "manual,2,5",
    ]);

    const kpis = await exportCsv("Privacy-portal summary indicators");
    expect(kpis.name).toBe("privacy-portal-summary-indicators.csv");
    expect(kpis.csv.split("\r\n").slice(6)).toEqual([
      "Indicator,Count,Unit",
      "DSAR · open,4,requests",
      "DSAR · overdue,1,requests",
      "GPC signaled,12,subscribers",
      "Do-not-sell,4,subscribers",
      "Double opt-in · pending,9,pending confirmations",
    ]);
  });

  it("survives a partial summary body with honest empty states and no DSAR export", async () => {
    await mount({
      ...SUMMARY,
      dsar_requests: undefined as unknown as PrivacyPortal["dsar_requests"],
      suppression_breakdown: [],
    });
    expect(container.textContent).toContain("No privacy requests on file.");
    expect(container.textContent).toContain("No suppressions recorded.");
    expect(
      container.querySelector(
        'button[aria-label="Export DSAR requests by request type and status data as CSV"]',
      ),
    ).toBeNull();
  });
});
