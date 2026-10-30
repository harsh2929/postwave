// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The two forms extras mounted into their natural pages, driven through the
// real pages: the Analytics tab hands its loaded visits series to the chart
// CSV export, and the Embed page reads the server-authored share code.
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnalyticsPanel } from "@/app/(dashboard)/app/forms/[id]/_analytics-panel";
import EmbedPage from "@/app/(dashboard)/app/forms/[id]/embed/page";
import { downloadTextFile } from "@/lib/download";

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
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "form_1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/app/forms/form_1/embed",
  useSearchParams: () => new URLSearchParams(),
}));

const FORM = {
  id: "form_1",
  tenantId: "tenant-1",
  slug: "newsletter",
  name: "Newsletter",
  optInMode: "single",
  structure: { fields: [] },
  settings: { successMessage: "Thanks" },
  status: "published",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
};

let calls: RecordedCall[];

beforeEach(() => {
  ({ calls } = stubFetch((call) => {
    if (call.path === "/api/v1/auth/me") return json(identity());
    if (call.path === "/api/v1/forms") return json([]);
    if (call.path === "/api/v1/forms/form_1") return json(FORM);
    if (call.path === "/api/v1/forms/form_1/analytics") {
      return json({
        form_id: "form_1",
        days: 30,
        visits: [
          { date: "2026-09-11", count: 4 },
          { date: "2026-09-12", count: 6 },
        ],
        visits_total: 10,
      });
    }
    if (call.path === "/api/v1/forms/form_1/embed/iframe") {
      return json({
        flavor: "iframe",
        snippet: '<iframe src="https://forms.acme.test/forms/newsletter"></iframe>',
        language: "html",
        instructions: "Paste it.",
        public_host: "https://forms.acme.test",
        public_url: "https://forms.acme.test/forms/newsletter",
      });
    }
    return undefined;
  }));
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.mocked(downloadTextFile).mockReset();
});

function withClient(node: ReturnType<typeof createElement>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, node);
}

describe("forms extras mounted in their pages", () => {
  it("Analytics tab exports the visits series it loaded", async () => {
    mount(withClient(createElement(AnalyticsPanel, { formId: "form_1" })));
    await eventually(() =>
      expect(button("Hosted-page visits (CSV)").disabled).toBe(false),
    );
    await click(button("Hosted-page visits (CSV)"));
    expect(downloadTextFile).toHaveBeenCalledWith(
      "form-hosted-page-visits.csv",
      "Date,Visits\r\n2026-09-11,4\r\n2026-09-12,6",
      "text/csv;charset=utf-8",
    );
  });

  it("Embed page shows the server-authored hosted URL for an admin", async () => {
    mount(withClient(createElement(EmbedPage)));
    await eventually(() =>
      expect(
        document.querySelector('pre[aria-label="Hosted page share code"]')
          ?.textContent,
      ).toBe("https://forms.acme.test/forms/newsletter"),
    );
    expect(
      calls.some(
        (c) => c.method === "GET" && c.path === "/api/v1/forms/form_1/embed/iframe",
      ),
    ).toBe(true);
  });
});
