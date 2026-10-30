// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Chart-data CSV export (desktop SubmissionsAnalytics AccessibleChartData):
// hosted-page visits from the series the tab already holds (no request), and
// — for admins only — daily submission volume and status mix from one cached
// walk of GET /api/v1/forms/{id}/submissions. Asserts the exact file handed to
// downloadTextFile: name, CSV bytes, and MIME type.
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FormChartCsvExport } from "@/components/forms/form-chart-csv-export";
import type { MeResponse } from "@/lib/auth-api";
import { downloadTextFile } from "@/lib/download";
import { FORM_ADMIN_ONLY_MESSAGE } from "@/lib/forms-authority";

import {
  button,
  click,
  eventually,
  identity,
  json,
  mount,
  stubFetch,
  unmountAll,
  type RecordedCall,
} from "../helpers/forms-extras-harness";

vi.mock("@/lib/download", () => ({ downloadTextFile: vi.fn() }));

const FORM_ID = "form_1";
const SUBS_PATH = `/api/v1/forms/${FORM_ID}/submissions`;
const CSV_MIME = "text/csv;charset=utf-8";

function sub(id: string, submittedAt: string, status: string) {
  return {
    id,
    formId: FORM_ID,
    email: `${id}@example.test`,
    customFields: {},
    status,
    ip: null,
    userAgent: null,
    submittedAt,
    confirmedAt: null,
  };
}

let calls: RecordedCall[];
let denied: boolean;

function subsCalls() {
  return calls.filter((c) => c.method === "GET" && c.path === SUBS_PATH);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
  denied = false;
  ({ calls } = stubFetch((call) => {
    if (call.path !== SUBS_PATH || call.method !== "GET") return undefined;
    if (denied) {
      return json(
        { error: { code: "forbidden", message: "admin scope required" } },
        { status: 403 },
      );
    }
    const cursor = new URLSearchParams(call.search).get("cursor");
    // Newest first, keyset paged — as the Go handler serves it.
    if (!cursor) {
      return json(
        [
          sub("a", "2026-09-12T09:00:00Z", "confirmed"),
          sub("b", "2026-09-12T01:00:00Z", "pending"),
        ],
        { headers: { "X-Next-Cursor": "c2" } },
      );
    }
    return json([
      sub("c", "2026-09-10T23:59:00Z", "confirmed"),
      sub("d", "2026-09-01T00:00:00Z", "unsubscribed"),
    ]);
  }));
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(downloadTextFile).mockReset();
});

function render(me: MeResponse) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mount(
    createElement(
      QueryClientProvider,
      { client },
      createElement(FormChartCsvExport, {
        formId: FORM_ID,
        days: 3,
        visits: [
          { date: "2026-09-10", count: 3 },
          { date: "2026-09-11", count: 0 },
          { date: "2026-09-12", count: 5 },
        ],
        identity: me,
      }),
    ),
  );
}

describe("FormChartCsvExport", () => {
  it("downloads the loaded visits series without a request", async () => {
    render(identity());
    await click(button("Hosted-page visits (CSV)"));

    expect(downloadTextFile).toHaveBeenCalledWith(
      "form-hosted-page-visits.csv",
      "Date,Visits\r\n2026-09-10,3\r\n2026-09-11,0\r\n2026-09-12,5",
      CSV_MIME,
    );
    expect(calls).toHaveLength(0);
  });

  it("walks the submissions window once and exports volume and status mix", async () => {
    render(identity());

    await click(button("Daily submission volume (CSV)"));
    await eventually(() => expect(downloadTextFile).toHaveBeenCalledTimes(1));
    expect(downloadTextFile).toHaveBeenLastCalledWith(
      "form-daily-submission-volume.csv",
      "Date,Submissions\r\n2026-09-10,1\r\n2026-09-11,0\r\n2026-09-12,2",
      CSV_MIME,
    );
    expect(subsCalls().map((c) => new URLSearchParams(c.search).get("cursor"))).toEqual([
      null,
      "c2",
    ]);
    expect(subsCalls().every((c) => new URLSearchParams(c.search).get("limit") === "1000")).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "3 submissions over 3 days",
    );

    await click(button("Status mix (CSV)"));
    await eventually(() => expect(downloadTextFile).toHaveBeenCalledTimes(2));
    expect(downloadTextFile).toHaveBeenLastCalledWith(
      "form-submission-status-mix.csv",
      "Status,Submissions,Share (%)\r\nConfirmed,2,66.7\r\nPending,1,33.3\r\nUnsubscribed,0,0",
      CSV_MIME,
    );
    // Served from the cached window, not a second walk.
    expect(subsCalls()).toHaveLength(2);
  });

  it("withholds the submission-backed exports from a non-admin, with the reason", async () => {
    render(identity({ role: "editor", effective_role: "editor" }));

    expect(button("Daily submission volume (CSV)").disabled).toBe(true);
    expect(button("Status mix (CSV)").disabled).toBe(true);
    expect(button("Hosted-page visits (CSV)").disabled).toBe(false);
    expect(document.body.textContent).toContain(FORM_ADMIN_ONLY_MESSAGE);
    await click(button("Status mix (CSV)"));
    expect(subsCalls()).toHaveLength(0);
    expect(downloadTextFile).not.toHaveBeenCalled();
  });

  it("renders the server's refusal instead of downloading an empty file", async () => {
    denied = true;
    render(identity());
    await click(button("Status mix (CSV)"));

    await eventually(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "admin scope required",
      ),
    );
    expect(downloadTextFile).not.toHaveBeenCalled();
  });
});
