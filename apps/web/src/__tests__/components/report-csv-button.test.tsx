// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics-64: "Download CSV" of the report builder's preview rows (desktop
// components/analytics/ReportBuilderSection.tsx:1164). Client-side only, so
// the consequence is the file handed to the shared download helper: its name,
// MIME type, header order, RFC-4180 quoting, the spreadsheet formula guard,
// and that an empty preview withholds the control instead of saving a
// header-only file.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const downloadTextFile = vi.fn(
  (_filename: string, _content: string, _mime?: string) => undefined,
);
vi.mock("@/lib/download", () => ({
  downloadTextFile: (filename: string, content: string, mime?: string) =>
    downloadTextFile(filename, content, mime),
}));

import { ReportCsvButton } from "@/app/(dashboard)/app/reports/_components/report-csv-button";
import { reportCsvFilename, reportRowsToCsv } from "@/lib/report-rows-csv";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ROWS = [
  { campaign: "Launch, part 1", opens: 120, meta: { a: 1 } },
  { campaign: "=HYPERLINK(\"x\")", opens: null, extra: true },
];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  downloadTextFile.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 12, 9, 30));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

function render(props: Parameters<typeof ReportCsvButton>[0]) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(ReportCsvButton, props)));
  return host;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("report preview CSV", () => {
  it("serializes the shown columns first, then extra keys, guarded", () => {
    const csv = reportRowsToCsv(["campaign", "opens"], ROWS);
    expect(csv).toBe(
      [
        "campaign,opens,meta,extra",
        '"Launch, part 1",120,"{""a"":1}",',
        "\"'=HYPERLINK(\"\"x\"\")\",,,true",
        "",
      ].join("\r\n"),
    );
  });

  it("names the file after the draft, falling back to report", () => {
    const today = new Date(2026, 8, 12);
    expect(reportCsvFilename("Weekly Engagement!", today)).toBe(
      "weekly-engagement-preview-2026-09-12.csv",
    );
    expect(reportCsvFilename("   ", today)).toBe(
      "report-preview-2026-09-12.csv",
    );
  });
});

describe("ReportCsvButton", () => {
  it("downloads exactly the preview rows as text/csv", () => {
    const el = render({
      name: "Weekly engagement",
      columns: ["campaign", "opens"],
      rows: ROWS,
    });
    const button = el.querySelector("button");
    expect(button?.textContent).toContain("Download CSV");
    expect(button?.textContent).toContain("(2 rows)");
    click(button!);
    expect(downloadTextFile).toHaveBeenCalledTimes(1);
    const [filename, content, mime] = downloadTextFile.mock.calls[0]!;
    expect(filename).toBe("weekly-engagement-preview-2026-09-12.csv");
    expect(mime).toBe("text/csv;charset=utf-8");
    expect(content).toBe(reportRowsToCsv(["campaign", "opens"], ROWS));
    expect(content.split("\r\n")[0]).toBe("campaign,opens,meta,extra");
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it("withholds the download, with its reason, when the preview has no rows", () => {
    const el = render({ name: "Empty", columns: ["campaign"], rows: [] });
    const button = el.querySelector("button")!;
    expect(button.disabled).toBe(true);
    const reason = el.querySelector(
      `[id="${button.getAttribute("aria-describedby")}"]`,
    );
    expect(reason?.textContent).toBe(
      "Run a preview that returns rows to download them as CSV.",
    );
    click(button);
    expect(downloadTextFile).not.toHaveBeenCalled();
  });

  it("shows a blocked download instead of pretending it worked", () => {
    downloadTextFile.mockImplementationOnce(() => {
      throw new Error("blocked");
    });
    const el = render({ name: "x", columns: ["campaign"], rows: ROWS });
    click(el.querySelector("button")!);
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(
      "The browser blocked the CSV download. Try again.",
    );
  });
});
