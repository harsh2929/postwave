// SPDX-License-Identifier: AGPL-3.0-only
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const mocks = vi.hoisted(() => ({
  reputation: vi.fn(),
  stats: vi.fn(),
  reports: vi.fn(),
  history: vi.fn(),
}));
vi.mock("@/lib/inbox-reality-api", () => ({
  getReputation: mocks.reputation,
  getDmarcStats: mocks.stats,
  getDmarcReports: mocks.reports,
  getReputationHistory: mocks.history,
  getAuthChecks: vi.fn().mockResolvedValue([]),
  getDmarcReport: vi.fn(),
}));
vi.mock("@/lib/campaigns-api", () => ({
  listCampaigns: vi.fn().mockResolvedValue([]),
  countCampaigns: vi.fn().mockResolvedValue({ by_status: { sent: 0 } }),
}));
import InboxRealityPage from "@/app/(dashboard)/app/inbox-reality/page";
const reputation = {
  domain: "example.test",
  ip: "",
  google_score: "high",
  microsoft_score: null,
  sender_score: null,
  blacklist_hits: [],
  checked_at: "2026-10-25T00:00:00Z",
  data_available: true,
  sources_succeeded: ["google"],
  sources_failed: ["dnsbl"],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.reputation.mockResolvedValue(reputation);
  mocks.stats.mockResolvedValue({ total_reports: 0 });
  mocks.reports.mockResolvedValue([]);
  mocks.history.mockResolvedValue([]);
});
describe("Inbox Reality evidence failures", () => {
  it("does not label a failed DMARC request as a verified empty inbox", async () => {
    mocks.stats.mockRejectedValue(new Error("unavailable"));
    mocks.reports.mockRejectedValue(new Error("unavailable"));
    const html = renderToStaticMarkup(await InboxRealityPage());
    expect(html).toContain("DMARC monitoring unavailable");
    expect(html).not.toContain("No DMARC reports yet");
  });
  it("still shows a successful zero-report response as empty", async () => {
    const html = renderToStaticMarkup(await InboxRealityPage());
    expect(html).toContain("No DMARC reports yet");
  });
  it("does not show a healthy blocklist or collecting-history claim when those reads failed", async () => {
    mocks.history.mockRejectedValue(new Error("unavailable"));
    const html = renderToStaticMarkup(await InboxRealityPage());
    expect(html).toContain("Blocklist status unavailable");
    expect(html).not.toContain("No blocklist hits");
    expect(html).toContain("SenderScore history could not be loaded");
    expect(html).not.toContain("Collecting data");
  });
  it("shows no blocklist hits only after the blocklist source measured successfully", async () => {
    mocks.reputation.mockResolvedValue({
      ...reputation,
      sources_succeeded: ["dnsbl"],
      sources_failed: [],
    });
    const html = renderToStaticMarkup(await InboxRealityPage());
    expect(html).toContain("No blocklist hits");
    expect(html).not.toContain("Blocklist status unavailable");
  });
});
