// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../components/archive/CommentsModerationCard", () => ({
  CommentsModerationCard: () => (
    <button type="button" data-testid="comment-mutation">
      Moderate now
    </button>
  ),
}));

vi.mock("../../components/archive/PodcastTokensCard", () => ({
  PodcastTokensCard: () => (
    <button type="button" data-testid="podcast-mutation">
      Reveal token
    </button>
  ),
}));

import {
  ArchivePageContent,
  type ArchivePageContentProps,
} from "../../components/archive/ArchivePageContent";
import type { ArchiveIssue } from "../../lib/api-client";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const issues: ArchiveIssue[] = [
  {
    campaignId: "campaign-1",
    slug: "field-notes",
    subject: "Field notes from the studio",
    excerpt: "A considered dispatch.",
    publishedAt: "2026-07-24T10:00:00.000Z",
    pinned: true,
    viewCount: 1240,
  },
  {
    campaignId: "campaign-2",
    slug: "summer-launch",
    subject: "The summer launch",
    excerpt: "What shipped this month.",
    publishedAt: "2026-07-22T10:00:00.000Z",
    viewCount: 0,
  },
];

function callbacks() {
  return {
    onCommentsIssueChange: vi.fn(),
    onCopy: vi.fn(),
    onFindCampaign: vi.fn(() => null),
    onOpenPublish: vi.fn(),
    onOpenUrl: vi.fn(),
    onPageChange: vi.fn(),
    onPin: vi.fn(),
    onQueryChange: vi.fn(),
    onRefresh: vi.fn(),
    onSelect: vi.fn(),
  };
}

function props(
  overrides: Partial<ArchivePageContentProps> = {},
): ArchivePageContentProps {
  return {
    canAdmin: true,
    canMutate: true,
    canPublish: true,
    cidBySlug: {},
    commentsIssueId: "",
    err: null,
    filteredCount: issues.length,
    indexBase: "https://archive.postwave.test/acme",
    listBusy: false,
    loading: false,
    page: 1,
    pageRows: issues,
    pinningSlug: null,
    publicDeliveryReady: true,
    publicIndexUrl: "https://archive.postwave.test/acme",
    query: "",
    rows: issues,
    rssUrl: "https://archive.postwave.test/acme/feed.xml",
    sitemapUrl: "https://archive.postwave.test/acme/sitemap.xml",
    statCells: [
      { label: "Published", value: "2" },
      { label: "Views (30d)", value: "1.2k" },
      { label: "Pinned", value: "1" },
    ],
    totalPages: 1,
    ...callbacks(),
    ...overrides,
  };
}

function renderPage(
  overrides: Partial<ArchivePageContentProps> = {},
): ArchivePageContentProps {
  const resolved = props(overrides);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<ArchivePageContent {...resolved} />);
  });
  return resolved;
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function press(target: HTMLElement, key: string): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

describe("Archive page presentation", () => {
  it("renders a semantic, task-first issue catalog with persistent actions", async () => {
    const resolved = renderPage();

    expect(document.querySelector("h1")?.textContent).toContain(
      "Give every issue a useful life after send.",
    );
    expect(
      document.querySelector(
        '[role="tablist"][aria-label="Archive workspaces"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector('table[aria-label="Published archive issues"]'),
    ).not.toBeNull();
    expect(document.querySelector("[style]")).toBeNull();
    expect(
      Array.from(document.querySelectorAll("th")).map((cell) =>
        cell.textContent?.trim(),
      ),
    ).toEqual(["Issue", "Permalink", "30-day views", "Published", "Actions"]);
    expect(document.body.textContent).toContain("2 published issues");
    expect(document.body.textContent).toContain("1.2k");
    expect(document.body.textContent).toContain("0");
    expect(document.body.textContent).not.toContain("Page 1 of 1");

    const open = button("Open Field notes from the studio in browser");
    const pin = button("Unpin Field notes from the studio");
    const detail = button("Edit Field notes from the studio");
    expect(open.classList.contains("arc-row-action")).toBe(true);
    expect(pin.classList.contains("arc-row-action")).toBe(true);
    expect(detail.classList.contains("arc-row-action")).toBe(true);

    // Public delivery is centrally fail-closed even when callers supply a
    // configured URL and optimistic readiness flags.
    expect(open.getAttribute("aria-disabled")).toBe("true");
    act(() => open.click());
    expect(resolved.onOpenUrl).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Public delivery review-gated");

    act(() => pin.click());
    expect(resolved.onPin).toHaveBeenCalledWith(issues[0]);
    act(() => detail.click());
    expect(resolved.onSelect).toHaveBeenCalledWith(issues[0]);

    const publish = button("Publish from campaign");
    expect(publish.getAttribute("aria-disabled")).toBe("true");
    act(() => publish.click());
    expect(resolved.onOpenPublish).not.toHaveBeenCalled();

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("provides APG keyboard navigation and keeps unsafe workspaces non-actionable", async () => {
    renderPage();
    const tabs = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    expect(
      tabs.map((tab) => tab.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual(["Issues2", "CommentsReview gated", "Private feedsReview gated"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.tabIndex).toBe(0);
    expect(tabs[1]?.tabIndex).toBe(-1);

    act(() => tabs[0]?.focus());
    press(tabs[0]!, "ArrowRight");
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[0]?.tabIndex).toBe(-1);
    expect(tabs[1]?.tabIndex).toBe(0);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");

    press(tabs[1]!, "Enter");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.body.textContent).toContain(
      "Comment moderation is held back.",
    );
    expect(
      document.querySelector('[data-testid="comment-mutation"]'),
    ).toBeNull();

    press(tabs[1]!, "End");
    expect(document.activeElement).toBe(tabs[2]);
    expect(tabs[1]?.tabIndex).toBe(-1);
    expect(tabs[2]?.tabIndex).toBe(0);
    press(tabs[2]!, " ");
    expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
    expect(document.body.textContent).toContain(
      "Private feed access is held back.",
    );
    expect(
      document.querySelector('[data-testid="podcast-mutation"]'),
    ).toBeNull();

    const panelId = tabs[2]?.getAttribute("aria-controls");
    expect(document.getElementById(panelId ?? "")?.getAttribute("role")).toBe(
      "tabpanel",
    );
    expect(
      document.getElementById(panelId ?? "")?.getAttribute("aria-labelledby"),
    ).toBe(tabs[2]?.id);

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("keeps issue inspection available while explaining review-only permissions", () => {
    const resolved = renderPage({
      canAdmin: false,
      canMutate: false,
      canPublish: false,
    });

    expect(document.body.textContent).toContain("Review-only access");
    const pin = button("Unpin Field notes from the studio");
    const detail = button("View details for Field notes from the studio");
    expect(pin.getAttribute("aria-disabled")).toBe("true");

    act(() => pin.click());
    expect(resolved.onPin).not.toHaveBeenCalled();
    act(() => detail.click());
    expect(resolved.onSelect).toHaveBeenCalledWith(issues[0]);
  });

  it("keeps last-good rows during refresh and exposes a useful retry state", () => {
    const resolved = renderPage({
      err: "The upstream request timed out.",
      loading: true,
    });

    expect(document.body.textContent).toContain(
      "Refreshing — 2 published issues",
    );
    expect(document.body.textContent).toContain(
      "The issue catalog remains visible.",
    );
    expect(
      document.querySelector('table[aria-label="Published archive issues"]'),
    ).not.toBeNull();
    expect(button("Refreshing…").disabled).toBe(true);

    expect(button("Retrying…").disabled).toBe(true);

    act(() => {
      root?.render(<ArchivePageContent {...resolved} loading={false} />);
    });
    act(() => button("Try again").click());
    expect(resolved.onRefresh).toHaveBeenCalledOnce();
  });

  it("distinguishes first load, terminal load failure, and empty search results", () => {
    renderPage({
      rows: null,
      pageRows: [],
      loading: true,
      filteredCount: 0,
    });
    expect(
      document.querySelector(
        '[role="status"][aria-label="Loading archive issues"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector('table[aria-label="Published archive issues"]'),
    ).toBeNull();

    act(() => {
      root?.render(
        <ArchivePageContent
          {...props({
            rows: null,
            pageRows: [],
            loading: false,
            err: "Service unavailable.",
            filteredCount: 0,
          })}
        />,
      );
    });
    expect(document.body.textContent).toContain(
      "No catalog data is available yet.",
    );
    expect(
      document.querySelector(
        '[role="status"][aria-label="Loading archive issues"]',
      ),
    ).toBeNull();

    const onQueryChange = vi.fn();
    act(() => {
      root?.render(
        <ArchivePageContent
          {...props({
            rows: issues,
            pageRows: [],
            query: "missing issue",
            filteredCount: 0,
            onQueryChange,
          })}
        />,
      );
    });
    expect(document.body.textContent).toContain(
      "No issues match “missing issue”",
    );
    act(() => button("Clear search").click());
    expect(onQueryChange).toHaveBeenCalledWith("");
  });

  it("only renders pagination when navigation has somewhere to go", () => {
    const onPageChange = vi.fn();
    renderPage({ page: 2, totalPages: 3, onPageChange });

    const navigation = document.querySelector(
      'nav[aria-label="Archive issue pages"]',
    );
    expect(navigation?.textContent).toContain("Page 2 of 3");
    act(() => button("Previous").click());
    act(() => button("Next").click());
    expect(onPageChange.mock.calls).toEqual([[1], [3]]);
  });
});
