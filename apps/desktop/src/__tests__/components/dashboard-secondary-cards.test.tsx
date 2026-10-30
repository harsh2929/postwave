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
  setSection: vi.fn(),
  navigateDesktopSectionResource: vi.fn(),
  navigateDesktopRoute: vi.fn(),
  setPendingCampaignDraft: vi.fn(),
  listDashboardAnomalies: vi.fn(),
  anomalyBriefModal: vi.fn(),
  getMailchimpCampaignPlanner: vi.fn(),
  getMailchimpAudienceInsights: vi.fn(),
  getMailchimpContentStudio: vi.fn(),
  getMailchimpMultiChannelReadiness: vi.fn(),
}));

vi.mock("../../lib/store", () => ({ setSection: mocks.setSection }));
vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopRoute: mocks.navigateDesktopRoute,
  navigateDesktopSectionResource: mocks.navigateDesktopSectionResource,
}));
vi.mock("../../lib/template-handoff", () => ({
  setPendingCampaignDraft: mocks.setPendingCampaignDraft,
}));
vi.mock("../../lib/api-client", () => ({
  ANOMALY_BRIEF_METRICS: [
    "opens",
    "clicks",
    "bounces",
    "complaints",
    "unsubscribes",
    "revenue",
  ],
  apiSendTimeAssets: {
    listDashboardAnomalies: mocks.listDashboardAnomalies,
  },
  api: {
    getMailchimpCampaignPlanner: mocks.getMailchimpCampaignPlanner,
    getMailchimpAudienceInsights: mocks.getMailchimpAudienceInsights,
    getMailchimpContentStudio: mocks.getMailchimpContentStudio,
    getMailchimpMultiChannelReadiness: mocks.getMailchimpMultiChannelReadiness,
  },
}));
vi.mock("../../components/dashboard/AnomalyBriefModal", () => ({
  AnomalyBriefModal: (props: unknown) => {
    mocks.anomalyBriefModal(props);
    return null;
  },
}));

import { AnomalyHistoryCard } from "../../components/dashboard/AnomalyHistoryCard";
import { AuditFeedCard } from "../../components/dashboard/AuditFeedCard";
import { ForecastStrip } from "../../components/dashboard/ForecastStrip";
import { InboxHealthCard } from "../../components/dashboard/InboxHealthCard";
import { MailchimpParityCard } from "../../components/dashboard/MailchimpParityCard";
import { RecentCampaignsCard } from "../../components/dashboard/RecentCampaignsCard";
import type { AuditEvent, Campaign } from "../../lib/api-client";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.listDashboardAnomalies.mockResolvedValue({ data: { items: [] } });
  primeParitySuccess();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("dashboard secondary cards", () => {
  it("keeps retained activity visible during refresh and filters transport noise", () => {
    render(
      <AuditFeedCard
        loading
        events={[
          {
            id: "visible",
            actor: "A very long teammate name",
            description: "published the launch campaign",
            at: "2026-07-18T09:00:00Z",
          },
          {
            id: "noise",
            action: "http.request",
            description: "GET /api/v1/dashboard",
          },
        ]}
      />,
    );

    expect(document.body.textContent).toContain(
      "published the launch campaign",
    );
    expect(document.body.textContent).toContain("Refreshing");
    expect(document.body.textContent).not.toContain("GET /api/v1/dashboard");
    expect(document.querySelector("section")?.getAttribute("aria-busy")).toBe(
      "true",
    );
  });

  it("shows an announced skeleton only for the first activity load", () => {
    render(<AuditFeedCard loading events={undefined} />);

    expect(
      document.querySelector('[role="status"]')?.getAttribute("aria-label"),
    ).toBe("Loading workspace activity");
    expect(
      document.querySelectorAll(".pw-dash-secondary-skeleton-line"),
    ).toHaveLength(3);
  });

  it("defensively drops malformed audit rows instead of rendering fallbacks", () => {
    render(
      <AuditFeedCard
        loading={false}
        events={
          [null, {}, { action: { private: true } }] as unknown as AuditEvent[]
        }
      />,
    );

    expect(document.body.textContent).toContain("No recent activity");
    expect(document.body.textContent).not.toContain("system");
    expect(
      document.querySelector(".pw-dash-secondary-activity-list"),
    ).toBeNull();
  });

  it("uses a native campaign button and preserves rows while refreshing", () => {
    render(
      <RecentCampaignsCard
        loading
        campaigns={[
          {
            id: "campaign-1",
            name: "A launch campaign with a deliberately long working title",
            status: "sent",
            sent_at: "2026-07-17T12:00:00Z",
            open_rate: 0.42,
            click_rate: Number.NaN,
          },
        ]}
      />,
    );

    const row = button("A launch campaign");
    expect(row.getAttribute("role")).toBeNull();
    expect(document.body.textContent).toContain("42.0%");
    expect(document.body.textContent).toContain("—");
    expect(document.body.textContent).toContain("Refreshing");

    act(() => row.click());
    expect(mocks.navigateDesktopSectionResource).toHaveBeenCalledWith(
      "campaigns",
      "campaign-1",
    );
  });

  it("turns a verified empty campaign response into a useful next step", () => {
    const view = render(<RecentCampaignsCard loading campaigns={null} />);
    expect(
      document.querySelector('[role="status"]')?.getAttribute("aria-label"),
    ).toBe("Loading recent campaigns");

    view.rerender(<RecentCampaignsCard loading={false} campaigns={[]} />);
    expect(document.body.textContent).toContain("No campaigns yet");
    act(() => button("Create campaign").click());
    expect(mocks.setPendingCampaignDraft).toHaveBeenCalledWith({});
    expect(mocks.setSection).toHaveBeenCalledWith("campaigns");
  });

  it("makes an unverified initial campaign failure explicit and retryable", () => {
    const onRetry = vi.fn();
    render(
      <RecentCampaignsCard
        loading={false}
        campaigns={null}
        error
        stale={false}
        onRetry={onRetry}
      />,
    );

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Recent campaigns are unavailable",
    );
    expect(document.body.textContent).not.toContain("No campaigns yet");
    act(() => button("Try again").click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("retains the last verified campaign list with an explicit stale warning", () => {
    const onRetry = vi.fn();
    render(
      <RecentCampaignsCard
        loading={false}
        campaigns={[
          {
            id: "retained",
            name: "Last confirmed launch",
            open_rate: 42,
            click_rate: -0.2,
          },
        ]}
        error
        stale
        onRetry={onRetry}
      />,
    );

    expect(document.body.textContent).toContain("Last confirmed launch");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Showing the last confirmed campaign list",
    );
    expect(document.body.textContent).not.toContain("4200.0%");
    expect(document.body.textContent).not.toContain("-20.0%");
    act(() => button("Try again").click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("defensively renders malformed campaign scalars without throwing or navigating", () => {
    render(
      <RecentCampaignsCard
        loading={false}
        campaigns={[
          {
            id: { unexpected: true },
            name: { private: "object" },
            status: 42,
            sent_at: { invalid: true },
          } as unknown as Campaign,
        ]}
      />,
    );

    expect(document.body.textContent).toContain("Untitled");
    expect(document.body.textContent).toContain("Campaign");
    act(() => button("Untitled").click());
    expect(mocks.navigateDesktopSectionResource).not.toHaveBeenCalled();
    expect(mocks.setSection).toHaveBeenCalledWith("campaigns");
  });

  it("distinguishes loading, unavailable, malformed, and verified inbox health", () => {
    const view = render(<InboxHealthCard stats={null} />);
    expect(document.body.textContent).toContain(
      "Checking your sender-domain health",
    );
    expect(button("Review deliverability")).toBeTruthy();

    view.rerender(<InboxHealthCard stats={null} loading={false} />);
    expect(document.body.textContent).toContain(
      "workspace metrics could not be loaded",
    );
    expect(document.querySelector('[role="alert"]')).not.toBeNull();

    view.rerender(<InboxHealthCard stats={{}} />);
    expect(document.body.textContent).toContain(
      "No recent inbox-health snapshot",
    );
    expect(button("Review deliverability")).toBeTruthy();

    view.rerender(
      <InboxHealthCard
        stats={{ inbox_health: { score: 140, state: "healthy" } }}
      />,
    );
    expect(document.querySelector("meter")).toBeNull();
    expect(document.body.textContent).toContain("could not be verified");

    view.rerender(
      <InboxHealthCard
        stats={{ inbox_health: { score: 92, state: "healthy" } }}
      />,
    );
    expect(document.querySelector("meter")?.getAttribute("value")).toBe("92");
    act(() => button("Open report").click());
    expect(mocks.setSection).toHaveBeenCalledWith("deliverabilityHub");
  });

  it("renders only defensible projections without native title tooltips", () => {
    const view = render(
      <ForecastStrip sparkline={[1, 2, 3]} currentTotal={90} />,
    );
    expect(document.body.textContent).toBe("");

    view.rerender(
      <ForecastStrip sparkline={[1, 2, 3, 4, 5, 6, 7]} currentTotal={90} />,
    );
    expect(document.body.textContent).toContain("Growth trajectory");
    expect(document.body.textContent).toContain("Projection");
    expect(document.querySelector("[title]")).toBeNull();
    expect(button("i").getAttribute("aria-label")).toBe(
      "How this subscriber projection is calculated",
    );
  });

  it("makes anomaly failures retryable and preserves analytics navigation", async () => {
    mocks.listDashboardAnomalies
      .mockResolvedValueOnce({ error: { message: "signal service offline" } })
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              id: "anomaly-1",
              tenantId: "tenant-1",
              metric: "bounces",
              dayBucket: "2026-07-18",
              value: 28,
              mean: 4,
              zScore: 3.4,
              rangeUsed: "30d",
              detectedAt: "2026-07-18T08:00:00Z",
            },
          ],
        },
      });

    await renderAsync(<AnomalyHistoryCard />);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "We couldn't check recent metric signals",
    );
    expect(document.body.textContent).not.toContain("signal service offline");

    await click("Try again");
    expect(document.body.textContent).toContain("bounces spiked to 28");
    act(() => button("bounces").click());
    expect(mocks.navigateDesktopRoute).toHaveBeenCalledWith({
      section: "analytics",
      filters: [
        { key: "metric", value: "bounces" },
        { key: "range", value: "30d" },
      ],
    });
  });

  it.each([
    ["30d", 30],
    ["90d", 90],
    ["7d", 7],
    [undefined, 7],
    ["malformed", 7],
  ])(
    "uses the anomaly's %s detection range for its explanation window",
    async (rangeUsed, expectedWindowDays) => {
      mocks.listDashboardAnomalies.mockResolvedValueOnce({
        data: {
          items: [
            {
              id: "anomaly-1",
              metric: "bounces",
              value: 28,
              mean: 4,
              zScore: 3.4,
              rangeUsed,
              detectedAt: "2026-07-18T08:00:00Z",
            },
          ],
        },
      });

      await renderAsync(<AnomalyHistoryCard />);
      await click("Explain");

      expect(mocks.anomalyBriefModal).toHaveBeenLastCalledWith(
        expect.objectContaining({
          open: true,
          metric: "bounces",
          windowDays: expectedWindowDays,
        }),
      );
    },
  );

  it("keeps a verified healthy anomaly response out of the dashboard", async () => {
    await renderAsync(<AnomalyHistoryCard />);

    expect(mocks.listDashboardAnomalies).toHaveBeenCalledWith({ limit: 8 });
    expect(document.body.textContent).not.toContain("Recent anomalies");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("normalizes every anomaly row before formatting and caps over-returned history", async () => {
    mocks.listDashboardAnomalies.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: "PRIVATE-SUBSCRIBER-ID",
            metric: "unknown metric",
            value: Number.NaN,
            mean: Number.POSITIVE_INFINITY,
            zScore: "3.4",
            rangeUsed: "https://private.example.test",
            detectedAt: "not-a-timestamp",
          },
          ...Array.from({ length: 10 }, (_, index) => ({
            id: `anomaly-${index}`,
            metric: "opens",
            value: index,
            mean: index / 2,
            zScore: -1.25,
            rangeUsed: "30d",
            detectedAt: "2026-07-18T08:00:00Z",
          })),
        ],
      },
    });

    await renderAsync(<AnomalyHistoryCard />);

    expect(
      document.querySelectorAll(".pw-dash-secondary-anomaly-list > li"),
    ).toHaveLength(8);
    expect(document.body.textContent).toContain(
      "unknown metric spiked to value unavailable (mean unavailable, z unavailable)",
    );
    expect(document.body.textContent).not.toContain("NaN");
    expect(document.body.textContent).not.toContain("Infinity");
    expect(document.body.textContent).not.toContain("PRIVATE-SUBSCRIBER-ID");
    expect(document.body.textContent).not.toContain("private.example.test");
    expect(
      document
        .querySelector(".pw-dash-secondary-anomaly-list > li time")
        ?.getAttribute("datetime"),
    ).toBeNull();
    expect(button("unknown metric")).toBeTruthy();

    const result = await axe.run(document.querySelector("section")!);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("settles a thrown anomaly request into a non-disclosing retry state", async () => {
    mocks.listDashboardAnomalies
      .mockRejectedValueOnce(
        new Error(
          "GET https://private.example.test token=PRIVATE_ANOMALY_TOKEN",
        ),
      )
      .mockResolvedValueOnce({ data: { items: [] } });

    await renderAsync(<AnomalyHistoryCard />);

    const section = document.querySelector("section");
    expect(section?.getAttribute("aria-busy")).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Anomaly history is unavailable",
    );
    expect(document.body.textContent).not.toContain("private.example.test");
    expect(document.body.textContent).not.toContain("PRIVATE_ANOMALY_TOKEN");

    await click("Try again");
    expect(mocks.listDashboardAnomalies).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("Recent anomalies");
  });

  it("treats a structurally empty anomaly row as retryable corruption, not a healthy empty result", async () => {
    mocks.listDashboardAnomalies.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: "PRIVATE-SUBSCRIBER-ID",
            tenantId: "PRIVATE-TENANT-ID",
            metric: "",
            value: Number.NaN,
            mean: Number.POSITIVE_INFINITY,
            zScore: "3.4",
            rangeUsed: "30d",
            detectedAt: "2026-07-18T08:00:00Z",
          },
        ],
      },
    });

    await renderAsync(<AnomalyHistoryCard />);

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Anomaly history is unavailable",
    );
    expect(button("Try again")).toBeTruthy();
    expect(
      document.querySelector(".pw-dash-secondary-anomaly-list"),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("PRIVATE-SUBSCRIBER-ID");
    expect(document.body.textContent).not.toContain("PRIVATE-TENANT-ID");
  });

  it("renders unscoped revenue history as raw minor units without inventing USD", async () => {
    mocks.listDashboardAnomalies.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: "anomaly-revenue",
            metric: "revenue",
            value: 12_345,
            mean: 5_000,
            zScore: 3.4,
            rangeUsed: "7d",
            detectedAt: "2026-07-18T08:00:00Z",
          },
        ],
      },
    });

    await renderAsync(<AnomalyHistoryCard />);

    const description = document.querySelector(
      ".pw-dash-secondary-anomaly-description",
    )?.textContent;
    expect(description).toMatch(
      /revenue spiked to 12[,.]?345 minor units \(currency unavailable\)/,
    );
    expect(description).toMatch(
      /mean 5[,.]?000 minor units \(currency unavailable\)/,
    );
    expect(description).not.toMatch(/[$€£]/u);
    expect(description).not.toContain("USD");
    expect(description).not.toContain("123.45");

    await click("Explain");
    expect(mocks.anomalyBriefModal).toHaveBeenLastCalledWith(
      expect.objectContaining({
        open: true,
        metric: "revenue",
        windowDays: 7,
      }),
    );
  });

  it("never formats unsafe anomaly numerics as evidence", async () => {
    mocks.listDashboardAnomalies.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: "anomaly-unsafe",
            metric: "opens",
            value: Number.MAX_SAFE_INTEGER + 1,
            mean: Number.POSITIVE_INFINITY,
            zScore: 1e100,
            rangeUsed: "7d",
            detectedAt: "2026-07-18T08:00:00Z",
          },
        ],
      },
    });

    await renderAsync(<AnomalyHistoryCard />);

    expect(document.body.textContent).toContain(
      "opens spiked to value unavailable (mean unavailable, z unavailable)",
    );
    expect(document.body.textContent).not.toContain("Infinity");
    expect(document.body.textContent).not.toContain("1e+100");
    expect(document.body.textContent).not.toContain(
      String(Number.MAX_SAFE_INTEGER + 1),
    );
  });

  it("retains verified anomalies while refreshing and after refresh failure", async () => {
    let rejectRefresh!: (reason?: unknown) => void;
    mocks.listDashboardAnomalies
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              id: "anomaly-1",
              metric: "bounces",
              value: 28,
              mean: 4,
              zScore: 3.4,
              rangeUsed: "30d",
              detectedAt: "2026-07-18T08:00:00Z",
            },
          ],
        },
      })
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectRefresh = reject;
        }),
      );

    await renderAsync(<AnomalyHistoryCard />);
    act(() => button("Refresh").click());

    expect(document.body.textContent).toContain("bounces spiked to 28");
    expect(document.body.textContent).toContain("Refreshing…");
    expect(document.querySelector("section")?.getAttribute("aria-busy")).toBe(
      "true",
    );

    await act(async () => {
      rejectRefresh(new Error("PRIVATE REFRESH FAILURE"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("bounces spiked to 28");
    expect(document.body.textContent).toContain(
      "The last verified signals remain visible below.",
    );
    expect(document.body.textContent).not.toContain("PRIVATE REFRESH FAILURE");
    expect(
      document.querySelector("section")?.getAttribute("aria-busy"),
    ).toBeNull();
  });

  it("retries parity read failures and renders the live response as a definition list", async () => {
    mocks.getMailchimpCampaignPlanner
      .mockReset()
      .mockResolvedValueOnce({ error: { message: "planner unavailable" } })
      .mockResolvedValueOnce({
        data: { touchpoints: [{ id: 1 }], tasks: [{ id: 1 }, { id: 2 }] },
      });

    await renderAsync(<MailchimpParityCard />);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Some coverage data couldn't be loaded",
    );
    expect(document.body.textContent).not.toContain("planner unavailable");
    expect(document.querySelector("dl")).not.toBeNull();
    expect(document.body.textContent).toContain("Unavailable");
    expect(document.body.textContent).toContain("Couldn’t load this surface");

    await click("Try again");
    expect(document.querySelector("dl")).not.toBeNull();
    expect(document.body.textContent).toContain("1/2");
    expect(
      Array.from(document.querySelectorAll("dt"), (node) => node.textContent),
    ).toEqual(["Planner", "Channels", "Audience", "Content"]);
  });

  it("keeps shipped parity surfaces visible when one endpoint is absent", async () => {
    mocks.getMailchimpCampaignPlanner.mockReset().mockResolvedValue({
      error: { message: "not implemented", status: 501 },
    });

    await renderAsync(<MailchimpParityCard />);
    expect(document.body.textContent).toContain("Mailchimp parity surfaces");
    expect(document.body.textContent).toContain("Not available");
    expect(document.body.textContent).toContain(
      "Not shipped on this deployment",
    );
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("hides parity only when every endpoint proves the feature is absent", async () => {
    for (const endpoint of [
      mocks.getMailchimpCampaignPlanner,
      mocks.getMailchimpAudienceInsights,
      mocks.getMailchimpContentStudio,
      mocks.getMailchimpMultiChannelReadiness,
    ]) {
      endpoint.mockReset().mockResolvedValue({
        error: { message: "not implemented", status: 501 },
      });
    }

    await renderAsync(<MailchimpParityCard />);
    expect(document.body.textContent).not.toContain(
      "Mailchimp parity surfaces",
    );
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("distinguishes a mixed absent and failed parity response", async () => {
    mocks.getMailchimpCampaignPlanner.mockReset().mockResolvedValue({
      error: { message: "not implemented", status: 404 },
    });
    mocks.getMailchimpAudienceInsights.mockReset().mockResolvedValue({
      error: { message: "postgres://private", status: 500 },
    });

    await renderAsync(<MailchimpParityCard />);

    expect(document.body.textContent).toContain("Mailchimp parity surfaces");
    expect(document.body.textContent).toContain("Not available");
    expect(document.body.textContent).toContain("Unavailable");
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("postgres://private");
  });

  it("contains a thrown parity request while retaining other surfaces", async () => {
    mocks.getMailchimpContentStudio
      .mockReset()
      .mockRejectedValue(new Error("token=private"));

    await renderAsync(<MailchimpParityCard />);

    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.querySelector("dl")).not.toBeNull();
    expect(document.body.textContent).not.toContain("token=private");
  });
});

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return { rerender: (next) => act(() => root?.render(next)) };
}

async function renderAsync(node: ReactElement): Promise<void> {
  render(node);
  await flushEffects();
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.includes(label));
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function primeParitySuccess(): void {
  mocks.getMailchimpCampaignPlanner.mockResolvedValue({
    data: { touchpoints: [], tasks: [] },
  });
  mocks.getMailchimpAudienceInsights.mockResolvedValue({
    data: { segment_dimensions: [] },
  });
  mocks.getMailchimpContentStudio.mockResolvedValue({
    data: { files: [], status: "ready" },
  });
  mocks.getMailchimpMultiChannelReadiness.mockResolvedValue({
    data: { channels: [] },
  });
}
