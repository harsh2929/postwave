// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Campaign calendar (desktop parity campaigns-23) and the manual snapshot
// refresh (campaigns-16).
//
// The calendar is asserted read-only: desktop withholds calendar rescheduling
// behind CAMPAIGN_SCHEDULING_AVAILABLE = false and web holds every scheduling
// adapter behind CAMPAIGN_SCHEDULING_RELEASE_HOLD, so what must be true is
// that the held sentence renders and no reschedule affordance exists — not
// merely that a grid draws.
//
// The refresh is asserted by what it re-reads: GET /api/v1/campaigns and
// GET /api/v1/campaigns/count, and what a failed refetch leaves on screen.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => null),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      get: mocks.get,
      post: mocks.post,
      patch: mocks.patch,
      put: vi.fn(),
      delete: vi.fn(),
    },
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/app/campaigns",
  useSearchParams: () => new URLSearchParams(),
}));

import { ApiError } from "@/lib/api";
import { CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON } from "@/lib/campaign-operational-availability";
import {
  CAMPAIGN_SCHEDULING_RELEASE_HOLD,
  type Campaign,
  countCampaigns,
  listCampaigns,
} from "@/lib/campaigns-api";
import { rescheduleCampaign } from "@/lib/campaign-schedule-api";
import { base, qk } from "@/lib/query-keys";
import {
  CampaignCalendar,
  type CampaignViewMode,
  CampaignViewToggle,
} from "@/components/campaigns/campaign-calendar";
import {
  RefreshSnapshotButton,
  isCampaignSnapshotStale,
} from "@/components/campaigns/refresh-snapshot-button";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function render(ui: ReactNode): void {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, networkMode: "always", gcTime: 0 },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flush();
      });
    }
  }
  throw lastError;
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      (candidate.getAttribute("aria-label") === label ||
        candidate.textContent?.trim() === label),
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

function campaign(
  id: string,
  name: string,
  extra: Partial<Campaign> = {},
): Campaign {
  return {
    id,
    tenant_id: "tnt_1",
    name,
    subject: `${name} subject`,
    status: "draft",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...extra,
  };
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.patch.mockReset();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// campaigns-23 — calendar view + month navigation
// ---------------------------------------------------------------------------

describe("CampaignCalendar", () => {
  // Noon UTC keeps each campaign on the same local day in any test timezone.
  const SCHEDULED = campaign("camp-a", "Autumn launch", {
    status: "scheduled",
    scheduled_at: "2026-09-15T12:00:00Z",
  });
  const SENT = campaign("camp-b", "Back to school", {
    status: "sent",
    sent_at: "2026-09-03T12:00:00Z",
  });
  const UNDATED = campaign("camp-c", "Idea");
  const NEXT_MONTH = campaign("camp-d", "Halloween", {
    status: "scheduled",
    scheduled_at: "2026-10-20T12:00:00Z",
  });
  const NOW = () => new Date(2026, 8, 12, 9, 0, 0);

  function monthLabel(year: number, month: number): string {
    return new Date(year, month, 1).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
  }

  function heading(): string {
    return (
      document
        .querySelector('[data-testid="campaign-calendar"] h2')
        ?.textContent?.trim() ?? ""
    );
  }

  function cell(day: string): HTMLElement {
    const found = document.querySelector<HTMLElement>(`td[data-day="${day}"]`);
    if (!found) throw new Error(`No cell for ${day}`);
    return found;
  }

  function mount() {
    render(
      createElement(CampaignCalendar, {
        campaigns: [SCHEDULED, SENT, UNDATED, NEXT_MONTH],
        now: NOW,
      }),
    );
  }

  it("places campaigns on their scheduled, else sent, day and links to each", () => {
    mount();
    expect(heading()).toBe(monthLabel(2026, 8));
    const scheduledLink = cell("2026-09-15").querySelector("a");
    expect(scheduledLink?.textContent).toContain("Autumn launch");
    expect(scheduledLink?.textContent).toContain("Scheduled");
    expect(scheduledLink?.getAttribute("href")).toBe("/app/campaigns/camp-a");
    expect(cell("2026-09-03").querySelector("a")?.getAttribute("href")).toBe(
      "/app/campaigns/camp-b",
    );
    // Undated drafts are not silently dropped: the calendar says so.
    expect(document.body.textContent).toContain(
      "1 campaign has no scheduled or sent date and is not on the calendar.",
    );
    // 6 weeks x 7 days, Sunday-first, with scoped column headers.
    expect(document.querySelectorAll("tbody td")).toHaveLength(42);
    expect(
      Array.from(document.querySelectorAll('thead th[scope="col"]')).map(
        (th) => th.textContent,
      ),
    ).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  });

  it("navigates Next / Previous / Today", async () => {
    mount();
    await click(button("Next month"));
    expect(heading()).toBe(monthLabel(2026, 9));
    expect(cell("2026-10-20").textContent).toContain("Halloween");
    expect(document.body.textContent).not.toContain("Autumn launch");

    await click(button("Previous month"));
    await click(button("Previous month"));
    expect(heading()).toBe(monthLabel(2026, 7));
    expect(document.body.textContent).not.toContain("Autumn launch");

    await click(button("Today"));
    expect(heading()).toBe(monthLabel(2026, 8));
    expect(cell("2026-09-15").textContent).toContain("Autumn launch");
  });

  it("holds rescheduling: the per-campaign control is disabled with desktop's reason and nothing is sent (campaigns-24)", async () => {
    mount();
    const section = document.querySelector<HTMLElement>(
      '[data-testid="campaign-calendar"]',
    )!;
    expect(section.textContent).toContain("Schedule changes are paused.");
    expect(section.textContent).toContain(CAMPAIGN_SCHEDULING_RELEASE_HOLD);
    expect(section.querySelector('[draggable="true"]')).toBeNull();
    const controls = Array.from(section.querySelectorAll("button")).map(
      (b) => b.getAttribute("aria-label") ?? b.textContent?.trim(),
    );
    // Only drafts and scheduled campaigns carry a Reschedule control; the
    // sent campaign is pinned (desktop isDraggable).
    expect(controls).toEqual([
      "Previous month",
      "Next month",
      "Today",
      "Reschedule Autumn launch",
    ]);
    const reschedule = button("Reschedule Autumn launch");
    expect(reschedule.disabled).toBe(true);
    expect(reschedule.getAttribute("title")).toBe(
      CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON,
    );
    const reasonId = reschedule.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId!)?.textContent).toBe(
      CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON,
    );
    expect(cell("2026-09-03").querySelector("button")).toBeNull();
    // No picker, no form, no request while held — even if something forces
    // the click through the disabled attribute.
    expect(section.querySelector("input, select, form")).toBeNull();
    await click(reschedule);
    expect(section.querySelector("input, select, form")).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("refuses the reschedule transport before any request leaves while held", async () => {
    await expect(
      rescheduleCampaign("camp-a", "2026-09-20T09:00:00.000Z"),
    ).rejects.toMatchObject({ code: "campaign_scheduling_unqualified" });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});

describe("CampaignViewToggle", () => {
  it("switches between List and Calendar and reports the pressed view", async () => {
    const onChange = vi.fn((_next: CampaignViewMode) => undefined);
    render(createElement(CampaignViewToggle, { value: "list", onChange }));
    expect(button("List").getAttribute("aria-pressed")).toBe("true");
    expect(button("Calendar").getAttribute("aria-pressed")).toBe("false");
    await click(button("Calendar"));
    expect(onChange).toHaveBeenCalledWith("calendar");
  });
});

// ---------------------------------------------------------------------------
// campaigns-16 — Refresh / Try again on a retained snapshot
// ---------------------------------------------------------------------------

describe("RefreshSnapshotButton", () => {
  const LIST_PATH = "/api/v1/campaigns?per_page=500";
  const COUNT_PATH = "/api/v1/campaigns/count";
  const ROWS = [campaign("c1", "One"), campaign("c2", "Two")];

  /** Mirrors the campaigns page: list window + counts under one base key. */
  function Harness() {
    const baseKey = base("campaigns", "tnt_1", "editor");
    const list = useQuery({
      queryKey: qk.campaigns("tnt_1", "editor", { query: "" }),
      queryFn: () => listCampaigns({ perPage: 500, query: "" }),
    });
    useQuery({
      queryKey: [...baseKey, "counts", "all"],
      queryFn: () => countCampaigns(),
    });
    return createElement(
      "div",
      null,
      createElement(
        "output",
        { "data-testid": "loaded" },
        list.isSuccess ? "loaded" : "",
      ),
      createElement(RefreshSnapshotButton, {
        queryKey: baseKey,
        stale: isCampaignSnapshotStale(list),
        lastConfirmedAt: list.dataUpdatedAt,
        loadedCount: Array.isArray(list.data) ? list.data.length : 0,
        error: list.error,
      }),
    );
  }

  /** The first read must SETTLE before a refetch can be a second request. */
  async function waitForLoaded(): Promise<void> {
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="loaded"]')?.textContent,
      ).toBe("loaded"),
    );
  }

  function calls(path: string): number {
    return mocks.get.mock.calls.filter((call) => call[0] === path).length;
  }

  it("re-reads the list window and the status counts", async () => {
    let release: (() => void) | null = null;
    mocks.get.mockImplementation(async (path: string) => {
      if (path === COUNT_PATH) return { total: 2, by_status: { draft: 2 } };
      if (path === LIST_PATH) {
        if (calls(LIST_PATH) === 2) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return ROWS;
      }
      throw new Error(`unexpected GET ${path}`);
    });
    render(createElement(Harness));
    await waitForLoaded();
    expect(calls(LIST_PATH)).toBe(1);
    expect(calls(COUNT_PATH)).toBe(1);
    await waitFor(() => expect(button("Refresh").disabled).toBe(false));

    await click(button("Refresh"));
    await waitFor(() => {
      expect(calls(LIST_PATH)).toBe(2);
      expect(calls(COUNT_PATH)).toBe(2);
    });
    // While the re-read is in flight the control says so and cannot stack.
    expect(button("Refreshing…").disabled).toBe(true);
    await act(async () => {
      release?.();
      await flush();
    });
    await waitFor(() => expect(button("Refresh").disabled).toBe(false));
    expect(document.body.textContent).not.toContain(
      "Showing last-confirmed campaigns",
    );
  });

  it("keeps the last-confirmed rows on a failed refresh, says so, and retries", async () => {
    let failNext = false;
    mocks.get.mockImplementation(async (path: string) => {
      if (path === COUNT_PATH) return { total: 2, by_status: {} };
      if (path === LIST_PATH) {
        if (failNext) {
          failNext = false;
          throw new ApiError("Campaign store timed out.", 503);
        }
        return ROWS;
      }
      throw new Error(`unexpected GET ${path}`);
    });
    render(createElement(Harness));
    await waitForLoaded();
    expect(calls(LIST_PATH)).toBe(1);
    await waitFor(() => expect(button("Refresh").disabled).toBe(false));

    failNext = true;
    await click(button("Refresh"));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Showing last-confirmed campaigns",
      ),
    );
    const notice = document.body.textContent ?? "";
    expect(notice).toContain("Refresh failed.");
    expect(notice).toContain(
      "The retained snapshot contains 2 loaded campaigns",
    );
    expect(notice).toContain("Campaign store timed out.");
    expect(notice).toContain(
      "Changes to campaigns wait until a refresh succeeds.",
    );

    await click(button("Try again"));
    await waitFor(() => expect(calls(LIST_PATH)).toBe(3));
    await waitFor(() =>
      expect(document.body.textContent).not.toContain(
        "Showing last-confirmed campaigns",
      ),
    );
  });
});
