// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Subscriber detail extras (desktop parity rows audience-54/55/63/80/82):
// contact performance, per-channel best send times, the RFM & predictive
// profile, the raw event log with "Load older" + retry, and the subscriber's
// Shadow-PII findings. Each test drives a real render and asserts the
// CONSEQUENCE — the request's path + query, what the section renders from the
// response, and (for a withheld read) that no request was made at all.

import { act, createElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setOnlineStatusForTest } from "@/lib/online-manager";

import { trackRoot, unmountRoots } from "./_roots";
import { importBeforeTests, waitFor } from "./pages/_wait";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: mocks };
});
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return {
    ...actual,
    whoami: mocks.whoamiFresh,
    whoamiFresh: mocks.whoamiFresh,
  };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  ActivityLogSection,
  ContactPerformanceSection,
  PredictiveProfileSection,
  SendTimesSection,
} from "@/app/(dashboard)/app/subscribers/[id]/_engagement-extras";
import { SubscriberPiiFindingsPanel } from "@/app/(dashboard)/app/subscribers/[id]/_pii-findings-panel";
import { SubscriberDetailPanels } from "@/app/(dashboard)/app/subscribers/[id]/subscriber-detail-panels";
import { ApiError } from "@/lib/api";
import type { SubscriberAuthority } from "@/lib/subscriber-authority";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "99999999-9999-4999-8999-999999999999";
const tenantId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const campaignId = "66666666-6666-4666-8666-666666666666";
const findingId = "77777777-7777-4777-8777-777777777777";
const admin: SubscriberAuthority = { tenantId, userId, role: "admin" };
const editor: SubscriberAuthority = { tenantId, userId, role: "editor" };

type GetOptions = { query?: Record<string, unknown>; signal?: AbortSignal };
type GetHandler = (path: string, options?: GetOptions) => Promise<unknown>;

function me(role: "owner" | "admin" | "editor" | "viewer") {
  return {
    user_id: userId,
    tenant_id: tenantId,
    email: "operator@example.com",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
  };
}

function render(ui: ReactNode): Root {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = trackRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, ui));
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((r) => window.requestAnimationFrame(r));
  await new Promise((r) => window.setTimeout(r, 0));
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll("button")).find(
    (b): b is HTMLButtonElement =>
      b instanceof HTMLButtonElement &&
      (b.textContent?.trim() === label || b.getAttribute("aria-label") === label),
  );
  if (!found) throw new Error(`Button "${label}" not found`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
  });
}

function text(): string {
  return document.body.textContent ?? "";
}

function alertText(): string {
  return Array.from(document.querySelectorAll('[role="alert"]'))
    .map((node) => node.textContent ?? "")
    .join(" ");
}

function getCalls(path: string): Array<GetOptions | undefined> {
  return mocks.get.mock.calls
    .filter(([called]) => called === path)
    .map(([, options]) => options as GetOptions | undefined);
}

function route(handlers: Record<string, GetHandler>) {
  mocks.get.mockImplementation(async (path: string, options?: GetOptions) => {
    const handler = handlers[path];
    if (!handler) throw new Error(`unexpected GET ${path}`);
    return handler(path, options);
  });
}

beforeEach(() => {
  // Manual "load more" is refused unless the app is known to be online.
  setOnlineStatusForTest("online");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.whoamiFresh.mockResolvedValue(me("admin"));
});

afterEach(() => {
  // Unmount before emptying the body. Emptying it only detaches the roots,
  // and a next/dynamic section that lands after the file's last test then
  // commits into a torn-down environment and fails the run (see _roots.ts).
  unmountRoots();
  setOnlineStatusForTest("connecting");
  document.body.innerHTML = "";
});

/* --------------------- audience-55: contact performance ------------------ */

const performance = {
  subscriber_id: id,
  email: "ada@example.com",
  score: 42,
  counts: {
    sends: 1234,
    opens: 7,
    clicks: 3,
    replies: 1,
    revenue_cents: 12345,
    revenue_cents_saturated: false,
    revenue_currency: "USD",
    revenue_by_currency: [
      {
        currency: "USD",
        conversions: 2,
        revenue_cents: 12345,
        revenue_cents_saturated: false,
      },
      {
        currency: "EUR",
        conversions: 1,
        revenue_cents: 5000,
        revenue_cents_saturated: false,
      },
    ],
    mixed_currency: true,
    unclassified_monetary_conversions: 1,
  },
  window_days: 90,
  computed_at: "2026-09-10T10:00:00Z",
  opens_30d: 4,
  clicks_30d: 2,
};

const enginePath = `/api/v1/subscribers/${id}/engagement`;

describe("ContactPerformanceSection (audience-55)", () => {
  function renderSection() {
    return render(
      createElement(ContactPerformanceSection, { id, tenantId, role: "editor" }),
    );
  }

  it("GETs the subscriber's engagement report and renders counters plus revenue per currency", async () => {
    route({ [enginePath]: async () => performance });
    renderSection();
    await waitFor(() => expect(text()).toContain("$123.45"));
    expect(getCalls(enginePath)).toHaveLength(1);
    const metrics = document.querySelector(
      '[data-testid="contact-performance-metrics"]',
    );
    expect(metrics?.textContent).toContain("Sends1,234");
    expect(metrics?.textContent).toContain("Replies1");
    // Mixed currencies: the leading total is labelled, never summed.
    expect(metrics?.textContent).toContain("Leading revenue");
    expect(metrics?.textContent).toContain("USD");
    expect(metrics?.textContent).toContain("Mixed");
    expect(text()).not.toContain("$173.45");
    expect(text()).toContain("Revenue by currency · 2 currencies");
    expect(text()).toContain("€50.00");
    expect(text()).toContain(
      "1 amount-bearing conversion was missing a recognised currency",
    );
    expect(text()).toContain("Contact performance · 90 days");
    expect(text()).toContain("Last 30 days: 4 opens · 2 clicks");
  });

  it("withholds a legacy amount that carries no currency", async () => {
    route({
      [enginePath]: async () => ({
        ...performance,
        counts: { sends: 3, opens: 1, clicks: 0, replies: 0, revenue_cents: 999 },
      }),
    });
    renderSection();
    await waitFor(() => expect(text()).toContain("Currency unavailable"));
    expect(text()).toContain("Revenue currency unavailable");
    expect(text()).not.toContain("$9.99");
  });

  it("refuses an internally inconsistent currency contract and offers a retry that refetches", async () => {
    route({
      [enginePath]: async () => ({
        ...performance,
        counts: { ...performance.counts, mixed_currency: false },
      }),
    });
    renderSection();
    await waitFor(() =>
      expect(alertText()).toContain(
        "The contact-performance service returned an invalid response.",
      ),
    );
    expect(text()).not.toContain("$123.45");
    await click(button("Retry contact performance"));
    await waitFor(() => expect(getCalls(enginePath)).toHaveLength(2));
  });

  it("refuses a report for a different subscriber", async () => {
    route({
      [enginePath]: async () => ({ ...performance, subscriber_id: otherId }),
    });
    renderSection();
    await waitFor(() =>
      expect(alertText()).toContain("answered for a different subscriber"),
    );
    expect(text()).not.toContain("1,234");
  });
});

/* ---------------------- audience-63: best send times --------------------- */

const sendTimesPath = `/api/v1/subscribers/${id}/send-times`;

function channelRow(channel: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `tr[data-channel="${channel}"]`,
  );
  if (!row) throw new Error(`No row for ${channel}`);
  return row;
}

describe("SendTimesSection (audience-63)", () => {
  function renderSection() {
    return render(
      createElement(SendTimesSection, { id, tenantId, role: "viewer" }),
    );
  }

  it("renders each channel's own window and flags the aggregate fallback", async () => {
    route({
      [sendTimesPath]: async () => ({
        subscriber_id: id,
        aggregate_best_send_hour: 57,
        aggregate_best_send_hour_at: "2026-09-09T00:00:00Z",
        channels: [
          {
            channel: "email",
            best_send_hour: 33,
            best_send_hour_at: "2026-09-08T00:00:00Z",
            day_of_week: 1,
            hour_of_day: 9,
          },
          { channel: "sms", best_send_hour: null },
        ],
      }),
    });
    renderSection();
    await waitFor(() => channelRow("email"));
    expect(getCalls(sendTimesPath)).toHaveLength(1);
    expect(channelRow("email").textContent).toContain("Monday 09:00 UTC");
    expect(channelRow("email").textContent).not.toContain("aggregate");
    // sms has a consent row but no learned hour; push has no row at all.
    for (const channel of ["sms", "push", "whatsapp", "rcs"]) {
      expect(channelRow(channel).textContent).toContain("Tuesday 09:00 UTC");
      expect(channelRow(channel).textContent).toContain("aggregate");
    }
    expect(text()).toContain("Aggregate best hour: Tuesday 09:00 UTC");
  });

  it("says a channel has not learned a window when there is no aggregate either", async () => {
    route({
      [sendTimesPath]: async () => ({
        subscriber_id: id,
        aggregate_best_send_hour: null,
        channels: [],
      }),
    });
    renderSection();
    await waitFor(() => channelRow("sms"));
    expect(channelRow("sms").textContent).toContain("Not learned yet");
    expect(channelRow("sms").textContent).not.toContain("aggregate");
    expect(text()).toContain("No best hour learned yet");
  });

  it("refuses a row whose derived day disagrees with its hour", async () => {
    route({
      [sendTimesPath]: async () => ({
        subscriber_id: id,
        aggregate_best_send_hour: null,
        channels: [
          { channel: "email", best_send_hour: 33, day_of_week: 4, hour_of_day: 9 },
        ],
      }),
    });
    renderSection();
    await waitFor(() =>
      expect(alertText()).toContain(
        "The send-time service returned an invalid response.",
      ),
    );
    expect(document.querySelector('tr[data-channel="email"]')).toBeNull();
  });
});

/* ------------------ audience-80: RFM & predictive profile ---------------- */

const profilePath = "/api/v1/predictive/profiles/ada%40example.com";

function profile(overrides: {
  prediction?: Record<string, unknown>;
  rfm?: Record<string, unknown>;
} = {}) {
  return {
    prediction: {
      email: "ada@example.com",
      subscriber_id: id,
      historic_clv_cents: 99900,
      predicted_clv_cents: 5000,
      total_clv_cents: 104900,
      churn_risk: 0.25,
      predicted_order_count: 3.5,
      average_days_between_orders: 30.5,
      expected_next_order_at: "2026-10-01T00:00:00Z",
      predicted_gender: "",
      confidence: 0.8,
      data_sufficiency: "sufficient",
      churn_drivers: [],
      calculated_at: "2026-09-10T00:00:00Z",
      ...overrides.prediction,
    },
    rfm: {
      email: "ada@example.com",
      subscriber_id: id,
      recency_days: 12,
      frequency: 3,
      monetary_cents: 99900,
      recency_score: 4,
      frequency_score: 3,
      monetary_score: 5,
      rfm_score: "435",
      segment_key: "loyal",
      calculated_at: "2026-09-10T00:00:00Z",
      ...overrides.rfm,
    },
  };
}

describe("PredictiveProfileSection (audience-80)", () => {
  function renderSection(email = " Ada@Example.com ") {
    return render(
      createElement(PredictiveProfileSection, {
        id,
        email,
        tenantId,
        role: "editor",
      }),
    );
  }

  it("GETs the profile by the normalised email and renders RFM, churn, orders and cadence", async () => {
    route({ [profilePath]: async () => profile() });
    renderSection();
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="predictive-profile"]'),
      ).not.toBeNull(),
    );
    expect(getCalls(profilePath)).toHaveLength(1);
    const card =
      document.querySelector('[data-testid="predictive-profile"]')
        ?.textContent ?? "";
    expect(card).toContain("R4");
    expect(card).toContain("12 days since last order");
    expect(card).toContain("F3");
    expect(card).toContain("3 orders");
    expect(card).toContain("Churn risk");
    expect(card).toContain("25%");
    expect(card).toContain("Predicted orders / yr");
    expect(card).toContain("3.5");
    expect(card).toContain("30.5 days");
    expect(card).toContain("80%");
    // Monetary figures carry no currency on the wire, so none is shown.
    expect(card).not.toContain("$");
    expect(card).not.toContain("999");
    expect(card).not.toContain("Low confidence");
  });

  it("treats a 404 as 'no profile yet', not an error", async () => {
    route({
      [profilePath]: async () => {
        throw new ApiError("predictive profile not found", 404);
      },
    });
    renderSection();
    await waitFor(() =>
      expect(text()).toContain("No predictive profile for this subscriber yet"),
    );
    expect(alertText()).toBe("");
  });

  it("flags a low-sufficiency profile as a placeholder", async () => {
    route({
      [profilePath]: async () =>
        profile({
          prediction: {
            churn_risk: 0.5,
            confidence: 0.1,
            data_sufficiency: "insufficient",
          },
        }),
    });
    renderSection();
    await waitFor(() => expect(text()).toContain("Low confidence"));
    expect(text()).toContain("insufficient");
  });

  it("refuses a profile answered for a different address and never requests one without an email", async () => {
    route({
      [profilePath]: async () =>
        profile({ prediction: { email: "grace@example.com" } }),
    });
    renderSection();
    await waitFor(() =>
      expect(alertText()).toContain("answered for a different subscriber"),
    );
    document.body.innerHTML = "";
    mocks.get.mockClear();
    renderSection("   ");
    await waitFor(() =>
      expect(text()).toContain("This subscriber has no email address"),
    );
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

/* ----------------------- audience-54: raw event log ---------------------- */

const activityPath = `/api/v1/subscribers/${id}/activity`;

function activityRows(count: number, startId: number, startMs: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: startId - index,
    event_type: index === 0 ? "clicked" : "opened",
    campaign_id: campaignId,
    link_url: index === 0 ? "https://example.com/launch" : undefined,
    user_agent: "Mozilla/5.0",
    // Microsecond precision, as Postgres emits it.
    at: new Date(startMs - index * 60_000)
      .toISOString()
      .replace(".000Z", ".000456Z"),
  }));
}

describe("ActivityLogSection (audience-54)", () => {
  function renderSection() {
    return render(
      createElement(ActivityLogSection, { id, tenantId, role: "viewer" }),
    );
  }

  function listItems(): HTMLLIElement[] {
    return Array.from(
      document.querySelectorAll<HTMLLIElement>(
        'ol[aria-label="Subscriber event log"] > li',
      ),
    );
  }

  it("loads newest first, pages older with the last row's timestamp verbatim, and retries a failed page", async () => {
    const firstPage = activityRows(50, 5000, Date.parse("2026-09-10T12:00:00Z"));
    const lastAt = firstPage.at(-1)!.at;
    const olderPage = activityRows(2, 4000, Date.parse("2026-09-01T12:00:00Z"));
    let olderAttempts = 0;
    route({
      [activityPath]: async (_path, options) => {
        if (options?.query?.before === undefined) {
          return { items: firstPage, limit: 50 };
        }
        olderAttempts += 1;
        if (olderAttempts === 1) {
          throw new ApiError("Activity store is catching up.", 503);
        }
        return { items: olderPage, limit: 50 };
      },
    });
    renderSection();
    await waitFor(() => expect(listItems()).toHaveLength(50));
    expect(getCalls(activityPath)[0]?.query).toEqual({
      limit: 50,
      before: undefined,
    });
    expect(listItems()[0]?.textContent).toContain("Clicked");
    expect(listItems()[0]?.textContent).toContain("https://example.com/launch");
    const campaignLink = listItems()[0]?.querySelector("a");
    expect(campaignLink?.getAttribute("href")).toBe(
      `/app/campaigns/${campaignId}`,
    );
    // The URL a subscriber clicked is shown as text, never as a live link.
    expect(listItems()[0]?.querySelectorAll("a")).toHaveLength(1);
    expect(text()).not.toContain("Mozilla");

    await click(button("Load older events"));
    await waitFor(() =>
      expect(alertText()).toContain("Activity store is catching up."),
    );
    expect(getCalls(activityPath)[1]?.query).toEqual({
      limit: 50,
      before: lastAt,
    });
    // The already-loaded page survives the failed older page.
    expect(listItems()).toHaveLength(50);

    await click(button("Retry loading older events"));
    await waitFor(() => expect(listItems()).toHaveLength(52));
    expect(getCalls(activityPath)[2]?.query).toEqual({
      limit: 50,
      before: lastAt,
    });
    // A short page means nothing older exists.
    expect(() => button("Load older events")).toThrow();
  });

  it("shows an initial failure with a retry instead of an empty log", async () => {
    let attempts = 0;
    route({
      [activityPath]: async () => {
        attempts += 1;
        if (attempts === 1) throw new ApiError("Event store unavailable.", 503);
        return { items: [], limit: 50 };
      },
    });
    renderSection();
    await waitFor(() =>
      expect(alertText()).toContain("Event store unavailable."),
    );
    expect(text()).not.toContain("No activity recorded.");
    await click(button("Retry event log"));
    await waitFor(() => expect(text()).toContain("No activity recorded."));
  });

  it("refuses a page that is not newest-first", async () => {
    const rows = activityRows(2, 10, Date.parse("2026-09-10T12:00:00Z")).reverse();
    route({ [activityPath]: async () => ({ items: rows, limit: 50 }) });
    renderSection();
    await waitFor(() =>
      expect(alertText()).toContain(
        "The activity service returned an invalid response.",
      ),
    );
    expect(listItems()).toHaveLength(0);
  });
});

/* ------------------------ audience-82: PII findings ---------------------- */

const piiPath = `/api/v1/subscribers/${id}/pii-findings`;

const finding = {
  id: findingId,
  subscriber_id: id,
  field_name: "custom_fields.notes",
  detected_type: "ssn",
  confidence: 0.92,
  fingerprint: "a".repeat(64),
  fingerprint_scheme: "hmac-sha256-v1",
  fingerprint_key_version: "k1",
  status: "pending",
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-01T10:00:00Z",
  scanner_name: "shadow-pii",
  scanner_version: "1.0.0",
  detector_name: "regex",
  detector_version: "1.0.0",
  policy_name: "default",
  policy_version: "1",
};

describe("SubscriberPiiFindingsPanel (audience-82)", () => {
  // Inspect opens a next/dynamic review dialog. Import its chunk in a hook, on
  // the cold-import timeout, rather than on the test's 5 s clock.
  importBeforeTests(
    () => import("@/app/(dashboard)/app/pii-findings/pii-finding-dialog"),
  );

  function renderPanel(authority: SubscriberAuthority | null) {
    return render(
      createElement(SubscriberPiiFindingsPanel, {
        id,
        tenantId,
        role: authority?.role ?? "viewer",
        authority,
      }),
    );
  }

  it("lists this subscriber's findings for an admin and opens the review dialog on Inspect", async () => {
    route({
      [piiPath]: async () => ({
        items: [finding],
        total: 1,
        page: 1,
        per_page: 20,
      }),
    });
    renderPanel(admin);
    await waitFor(() => expect(text()).toContain("custom_fields.notes"));
    expect(getCalls(piiPath)[0]?.query).toEqual({ page: 1, per_page: 20 });
    expect(text()).toContain("SSN");
    expect(text()).toContain("92%");
    expect(text()).toContain("Needs review");
    expect(text()).toContain("1 finding · page 1 of 1");
    const inspect = button("Inspect SSN finding in field custom_fields.notes");
    await waitFor(() => expect(inspect.disabled).toBe(false));
    await click(inspect);
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        "Shadow-PII finding",
      ),
    );
    expect(
      document.querySelector('[role="dialog"]')?.textContent,
    ).toContain("Record reviewed");
  });

  it("withholds the admin-scoped read below owner/admin and says why", async () => {
    route({});
    renderPanel(editor);
    await waitFor(() =>
      expect(text()).toContain(
        "restricted to workspace owners and administrators, so no findings were requested",
      ),
    );
    await act(async () => {
      await flush();
    });
    expect(getCalls(piiPath)).toHaveLength(0);
    renderPanel(null);
    await act(async () => {
      await flush();
    });
    expect(getCalls(piiPath)).toHaveLength(0);
  });

  it("renders the scanner's failure instead of an empty queue", async () => {
    route({
      [piiPath]: async () => {
        throw new ApiError("scanner down", 503);
      },
    });
    renderPanel(admin);
    await waitFor(() =>
      expect(alertText()).toContain("Scanner service unavailable"),
    );
    expect(text()).not.toContain("No PII findings recorded");
  });
});

/* ------------- reachability: mounted by the detail page's tabs ----------- */

describe("SubscriberDetailPanels — the extras are reachable from their tabs", () => {
  // Each tab mounts more next/dynamic sections than the ones its test asserts
  // on: the mobile layout keeps the Timeline open, Engagement also mounts the
  // insights panel, and Audit mounts the audit history and receipts. Pay
  // their cold imports in a hook, on its cold-import timeout, rather than on a
  // test's 5 s clock.
  importBeforeTests(
    () => import("@/app/(dashboard)/app/subscribers/[id]/_insights-panels"),
    () => import("@/app/(dashboard)/app/subscribers/[id]/_profile-panels"),
    () => import("@/app/(dashboard)/app/subscribers/[id]/_timeline"),
  );

  /**
   * The "Loading …" placeholders still mounted, one per next/dynamic section
   * whose chunk has not landed yet. Each test ends only once this is empty,
   * so no section finishes loading after its test and commits outside act().
   */
  function sectionsStillLoading(): string[] {
    return Array.from(document.querySelectorAll('[role="status"]'))
      .map((node) => node.textContent?.trim() ?? "")
      .filter((label) => /^Loading .+…$/.test(label));
  }

  function renderTab(tab: "engagement" | "audit") {
    return render(
      createElement(SubscriberDetailPanels, {
        tab,
        onTabChange: () => undefined,
        timeline: {
          subscriber_id: id,
          email: "ada@example.com",
          stats: {} as never,
          events: [],
          pagination: {} as never,
        },
        record: undefined,
        id,
        tenantId,
        role: "admin",
        authority: admin,
        buckets: [],
        hasMore: false,
        onLoadMore: () => undefined,
        loadingMore: false,
        loadMoreError: null,
        category: "all",
        onCategoryChange: () => undefined,
        onRecordRefetch: () => undefined,
      }),
    );
  }

  it("mounts contact performance, send times, the predictive profile and the event log on Engagement", async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path === enginePath) return performance;
      if (path === sendTimesPath) {
        return { subscriber_id: id, aggregate_best_send_hour: 57, channels: [] };
      }
      if (path === profilePath) return profile();
      if (path === activityPath) {
        return {
          items: activityRows(1, 1, Date.parse("2026-09-10T12:00:00Z")),
          limit: 50,
        };
      }
      throw new ApiError("not part of this test", 404);
    });
    renderTab("engagement");
    await waitFor(() => {
      expect(text()).toContain("$123.45");
      expect(channelRowOrNull("sms")?.textContent).toContain(
        "Tuesday 09:00 UTC",
      );
      expect(text()).toContain("12 days since last order");
      expect(text()).toContain("Event log");
      expect(
        document.querySelectorAll('ol[aria-label="Subscriber event log"] > li'),
      ).toHaveLength(1);
    });
    for (const path of [enginePath, sendTimesPath, profilePath, activityPath]) {
      expect(getCalls(path).length).toBeGreaterThan(0);
    }
    await waitFor(() => expect(sectionsStillLoading()).toEqual([]));
  });

  it("mounts the subscriber's PII findings on the Audit tab", async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path === piiPath) {
        return { items: [finding], total: 1, page: 1, per_page: 20 };
      }
      return { items: [] };
    });
    renderTab("audit");
    await waitFor(() => expect(text()).toContain("custom_fields.notes"));
    expect(getCalls(piiPath).length).toBeGreaterThan(0);
    expect(text()).toContain("Shadow-PII findings");
    await waitFor(() => expect(sectionsStillLoading()).toEqual([]));
  });
});

function channelRowOrNull(channel: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`tr[data-channel="${channel}"]`);
}
