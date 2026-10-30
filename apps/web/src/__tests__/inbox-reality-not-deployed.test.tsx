// SPDX-License-Identifier: AGPL-3.0-only
//
// /app/inbox-reality on an environment that does not run the deliverability
// service (its DELIVERABILITY_SERVICE_URL is "disabled"): every deliverability
// read answers 503 service_not_deployed. The page listed five "Could not
// load …" failures under "partially unavailable" and an empty DMARC card, as
// if the service had broken. It is the environment, and the page says so.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  deliverability: vi.fn<() => Promise<never>>(),
  listCampaigns: vi.fn(async () => []),
  countCampaigns: vi.fn(async () => ({ by_status: { sent: 0 } })),
}));

vi.mock("@/lib/inbox-reality-api", () => ({
  getAuthChecks: mocks.deliverability,
  getDmarcReport: mocks.deliverability,
  getDmarcReports: mocks.deliverability,
  getDmarcStats: mocks.deliverability,
  getReputation: mocks.deliverability,
  getReputationHistory: mocks.deliverability,
}));
vi.mock("@/lib/campaigns-api", () => ({
  listCampaigns: mocks.listCampaigns,
  countCampaigns: mocks.countCampaigns,
}));

import InboxRealityPage from "@/app/(dashboard)/app/inbox-reality/page";

async function renderInboxReality(): Promise<string> {
  return renderToStaticMarkup(await InboxRealityPage());
}

beforeEach(() => {
  mocks.deliverability.mockReset();
});

describe("Inbox Reality without a deliverability service", () => {
  it("says deliverability monitoring is not available here instead of listing failures", async () => {
    mocks.deliverability.mockRejectedValue(
      new ApiError(
        "This feature isn't available in this environment.",
        503,
        undefined,
        {
          code: "service_not_deployed",
        },
      ),
    );

    const html = await renderInboxReality();

    expect(html).toContain(
      "Deliverability monitoring isn&#x27;t set up in this environment",
    );
    // Written from the reader's side: no internal service names.
    expect(html).not.toMatch(/deliverability service/i);
    expect(html).not.toContain("partially unavailable");
    expect(html).not.toContain("Could not load");
    // No DMARC card pretending there are simply no reports yet.
    expect(html).not.toMatch(/DMARC monitoring/i);
    // The page's own data still renders.
    expect(html).toContain("No sent campaigns yet");
  });

  it("explains missing sending setup without treating it as a broken service", async () => {
    mocks.deliverability.mockRejectedValue(
      new ApiError("Set up a sending domain", 422, undefined, {
        code: "sending_domain_not_configured",
      }),
    );
    const html = await renderInboxReality();
    expect(html).toContain("Set up your sending domain");
    expect(html).toContain('href="/app/settings/sender"');
    expect(html).not.toContain("Could not load domain reputation monitoring.");
    expect(html).not.toContain("Could not load authentication checks");
  });

  it("still reports a real failure of a deployed service as partial unavailability", async () => {
    mocks.deliverability.mockRejectedValue(
      new ApiError("an internal error occurred", 502, undefined, {
        code: "internal_error",
      }),
    );

    const html = await renderInboxReality();

    expect(html).toContain("Inbox Reality data is partially unavailable");
    expect(html).toContain("Could not load domain reputation monitoring.");
    expect(html).not.toContain("isn&#x27;t set up in this environment");
  });
});
