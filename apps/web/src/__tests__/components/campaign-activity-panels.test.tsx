// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Campaign activity & insights (/app/campaigns/{id}/activity) — desktop parity
// rows campaigns-51/56/57/58/60/61/62. Web reached none of these routes before.
//
// Every test mounts the real page client, so what is asserted is reachability
// from the route plus the CONSEQUENCE of each verb: the exact method + path +
// body + transport options each one sends, what the answer renders as, the
// copy of the confirm in front of an irreversible one, and — for each role the
// server would refuse — that the verb is withheld with the reason and no
// request goes out.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => null),
  post: vi.fn(
    async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> =>
      null,
  ),
  whoami: vi.fn(),
  subscribe: vi.fn(),
  copy: vi.fn(async (_text: string) => "copied" as const),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      get: mocks.get,
      post: mocks.post,
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return { ...actual, whoami: mocks.whoami, whoamiFresh: mocks.whoami };
});
vi.mock("@/lib/campaign-detail-panels-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/campaign-detail-panels-api")>();
  return { ...actual, subscribeCampaignReportStream: mocks.subscribe };
});
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: mocks.copy,
  isClipboardAvailable: () => true,
}));
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

const CAMPAIGN_ID = "11111111-2222-4333-8444-555555555555";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/app/campaigns/${CAMPAIGN_ID}/activity`,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: CAMPAIGN_ID }),
}));

import { ApiError } from "@/lib/api";
import type { CampaignReport } from "@/lib/campaign-analytics-api";
import { CampaignActivityClient } from "@/app/(dashboard)/app/campaigns/[id]/activity/campaign-activity-client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = `/api/v1/campaigns/${CAMPAIGN_ID}`;
const PATHS = {
  campaign: BASE,
  report: `${BASE}/report`,
  summary: `${BASE}/summary`,
  regenerate: `${BASE}/summary/regenerate`,
  feedback: `${BASE}/feedback`,
  replies: `${BASE}/replies?limit=50`,
  repliesQuestion: `${BASE}/replies?limit=50&intent=question`,
  archiveSettings: "/api/v1/admin/archive/tenant-settings",
  audit: `/api/v1/audit?resource_type=campaign&resource_id=${CAMPAIGN_ID}&limit=20`,
  remix: `${BASE}/remix`,
} as const;

type Role = "owner" | "admin" | "editor" | "viewer";

function identity(role: Role = "owner") {
  return {
    user_id: "usr_1",
    tenant_id: "tnt_1",
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

const CAMPAIGN = {
  id: CAMPAIGN_ID,
  tenant_id: "tnt_1",
  name: "Spring sale",
  subject: "Spring is here",
  status: "sent",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-02T00:00:00Z",
  sent_at: "2026-08-02T00:00:00Z",
  archive_public: true,
  archive_slug: "spring-sale",
};

/** PERCENT-unit rates, as analytics.pct() sends them. */
const REPORT = {
  campaign_id: CAMPAIGN_ID,
  sent: 1000,
  delivered: 950,
  opens: 120,
  unique_opens: 76,
  clicks: 40,
  unique_clicks: 19,
  bounces: 50,
  complaints: 5,
  unsubscribes: 10,
  open_rate: 8,
  click_rate: 2,
  click_to_open_rate: 25,
  bounce_rate: 5,
  unsub_rate: 1,
  top_links: [{ url: "https://example.com/pricing", clicks: 30 }],
  human_opens: 90,
  human_unique_opens: 60,
  human_clicks: 30,
  human_unique_clicks: 15,
  human_open_rate: 6.3,
  human_click_rate: 1.6,
  human_click_to_open_rate: 25,
  human_top_links: [{ url: "https://example.com/human-only", clicks: 12 }],
  bot_signatures_applied: ["apple-mpp"],
};

const SUMMARY = {
  campaign_id: CAMPAIGN_ID,
  body_markdown:
    "Open rate **8%** beat the baseline.\n\nTop link `pricing` took most clicks.",
  source: "deterministic",
  generated_at: "2026-08-03T10:00:00Z",
};

const FEEDBACK = [
  {
    id: "fb-open",
    campaign_id: CAMPAIGN_ID,
    author_label: "reviewer@example.com",
    body: "Tighten the subject line.",
    created_at: "2026-08-01T09:00:00Z",
  },
  {
    id: "fb-done",
    campaign_id: CAMPAIGN_ID,
    author_label: "lead@example.com",
    body: "Swap the hero image.",
    resolved_at: "2026-08-01T12:00:00Z",
    created_at: "2026-08-01T08:00:00Z",
  },
];

const REPLY_UNCLASSIFIED = {
  id: "rep-1",
  from_email: "reader@example.org",
  subject: "Re: Spring is here",
  body_text: "Does the sale include shipping?",
  received_at: "2026-08-02T10:00:00Z",
  body_redacted: false,
};
const REPLY_PRAISE = {
  id: "rep-2",
  from_email: "fan@example.org",
  subject: "Re: Spring is here",
  body_text: "Love it!",
  received_at: "2026-08-02T09:00:00Z",
  body_redacted: false,
  intent_label: "praise",
  intent_confidence: 0.9,
};

const AUDIT_ROWS = [
  {
    id: 42,
    action: "campaign.scheduled.personalized",
    resourceType: "campaign",
    resourceId: CAMPAIGN_ID,
    actorType: "user",
    actorLabel: "alice@example.com",
    metadata: {},
    at: "2026-08-01T10:00:00Z",
  },
];

let summaryResponse: unknown;
/** Server-side state: the classify POST persists a label the next GET sees. */
let classifiedLabel: string | null;
let streamHandlers: {
  onStatus: (status: "connecting" | "open" | "closed") => void;
  onReport: (report: CampaignReport) => void;
} | null;

const roots: Root[] = [];

function render(ui: ReactNode): void {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, networkMode: "always", gcTime: 0 },
      mutations: { networkMode: "always" },
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

function section(testId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`Section ${testId} not rendered`);
  return found;
}

function buttonIn(root: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.includes(text) === true,
  );
  if (!found) throw new Error(`Button "${text}" not found`);
  return found;
}

function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error("No dialog is open");
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
  });
}

function setTextValue(
  element: HTMLTextAreaElement | HTMLInputElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function getPaths(): string[] {
  return mocks.get.mock.calls.map((call) => String(call[0]));
}

function postCalls(path: string) {
  return mocks.post.mock.calls.filter((call) => call[0] === path);
}

async function mountAs(role: Role = "owner"): Promise<void> {
  mocks.whoami.mockResolvedValue(identity(role));
  render(createElement(CampaignActivityClient));
  await waitFor(() => expect(getPaths()).toContain(PATHS.campaign));
  await act(async () => {
    await flush();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  streamHandlers = null;
  summaryResponse = SUMMARY;
  classifiedLabel = null;
  mocks.subscribe.mockImplementation(
    (_id: string, handlers: NonNullable<typeof streamHandlers>) => {
      streamHandlers = handlers;
      return () => undefined;
    },
  );
  mocks.get.mockImplementation(async (path: string) => {
    switch (path) {
      case PATHS.campaign:
        return CAMPAIGN;
      case PATHS.report:
        return REPORT;
      case PATHS.summary:
        if (summaryResponse === null) {
          throw new ApiError(
            "no summary yet — call /regenerate to compute one",
            404,
          );
        }
        return summaryResponse;
      case PATHS.feedback:
        return { items: FEEDBACK };
      case PATHS.replies:
        return {
          campaign_id: CAMPAIGN_ID,
          count: 2,
          intent_counts: { praise: 1 },
          replies: [
            classifiedLabel
              ? { ...REPLY_UNCLASSIFIED, intent_label: classifiedLabel }
              : REPLY_UNCLASSIFIED,
            REPLY_PRAISE,
          ],
        };
      case PATHS.repliesQuestion:
        return {
          campaign_id: CAMPAIGN_ID,
          count: 1,
          intent_counts: { question: 1 },
          replies: [
            { ...REPLY_UNCLASSIFIED, id: "rep-9", intent_label: "question" },
          ],
        };
      case PATHS.archiveSettings:
        return { tenant_archive_slug: "acme", archive_domain: "news.acme.com" };
      case PATHS.audit:
        return { rows: AUDIT_ROWS };
      default:
        throw new ApiError("No fixture recorded for this route.", 404);
    }
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("performance panel (campaigns-56)", () => {
  it("reads the report, renders percent-unit rates as themselves, and switches to the bot-stripped view", async () => {
    await mountAs("viewer");
    await waitFor(() =>
      expect(section("campaign-performance-panel").textContent).toContain(
        "Open rate8.0%",
      ),
    );
    expect(getPaths()).toContain(PATHS.report);
    const panel = section("campaign-performance-panel");
    expect(panel.textContent).toContain("Click rate2.0%");
    expect(panel.textContent).toContain("example.com/pricing");
    expect(panel.textContent).not.toContain("800");

    await click(buttonIn(panel, "Human"));
    expect(panel.textContent).toContain("Human open rate6.3%");
    expect(panel.textContent).toContain("Human click rate1.6%");
    expect(panel.textContent).toContain("signatures applied: apple-mpp");
    expect(panel.textContent).toContain("example.com/human-only");
    expect(panel.textContent).not.toContain("example.com/pricing");
  });

  it("holds the live stream open for a sent campaign and paints each frame over the report", async () => {
    await mountAs("viewer");
    await waitFor(() => expect(streamHandlers).not.toBeNull());
    expect(mocks.subscribe).toHaveBeenCalledWith(CAMPAIGN_ID, expect.any(Object));

    await act(async () => {
      streamHandlers?.onStatus("open");
      await flush();
    });
    const panel = section("campaign-performance-panel");
    expect(panel.textContent).toContain("Live");

    await act(async () => {
      streamHandlers?.onReport({ ...REPORT, sent: 4321, open_rate: 12 });
      await flush();
    });
    expect(panel.textContent).toContain("Sent4,321");
    expect(panel.textContent).toContain("Open rate12%");
  });
});

describe("AI summary (campaigns-58)", () => {
  it("offers Generate when none exists and POSTs regenerate online-only after a fresh authority check", async () => {
    summaryResponse = null;
    mocks.post.mockImplementation(async (path: string) => {
      if (path === PATHS.regenerate) return SUMMARY;
      throw new Error(`unexpected POST ${path}`);
    });
    await mountAs("editor");
    const card = section("campaign-summary-card");
    await waitFor(() => expect(card.textContent).toContain("No summary yet"));

    const callsBefore = mocks.whoami.mock.calls.length;
    await click(buttonIn(card, "Generate summary"));
    await waitFor(() => expect(postCalls(PATHS.regenerate)).toHaveLength(1));
    expect(postCalls(PATHS.regenerate)[0]?.[1]).toEqual({ force: false });
    expect(postCalls(PATHS.regenerate)[0]?.[2]).toEqual(
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );
    expect(mocks.whoami.mock.calls.length).toBeGreaterThan(callsBefore);

    await waitFor(() => expect(card.textContent).toContain("beat the baseline"));
    expect(card.querySelector("strong")?.textContent).toBe("8%");
    expect(card.querySelector("code")?.textContent).toBe("pricing");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Summary generated");
  });

  it("puts a refresh behind a confirm that says the current summary is overwritten", async () => {
    mocks.post.mockResolvedValue({
      ...SUMMARY,
      body_markdown: "A **fresh** take.",
      source: "voice",
    });
    await mountAs("owner");
    const card = section("campaign-summary-card");
    await waitFor(() => expect(card.textContent).toContain("beat the baseline"));

    await click(buttonIn(card, "Refresh"));
    expect(dialog().textContent).toContain("Replace this summary?");
    expect(dialog().textContent).toContain("overwrites the current one in place");
    expect(dialog().textContent).toContain("cannot be recovered");
    expect(mocks.post).not.toHaveBeenCalled();

    await click(buttonIn(dialog(), "Replace summary"));
    await waitFor(() => expect(postCalls(PATHS.regenerate)).toHaveLength(1));
    await waitFor(() => expect(card.textContent).toContain("A fresh take."));
    expect(card.textContent).toContain("Voice-authored");
  });

  it("withholds generation from a viewer with the read-only sentence", async () => {
    summaryResponse = null;
    await mountAs("viewer");
    const card = section("campaign-summary-card");
    await waitFor(() => expect(card.textContent).toContain("No summary yet"));
    expect(buttonIn(card, "Generate summary").disabled).toBe(true);
    expect(card.textContent).toContain(
      "Campaign changes are read-only for this session.",
    );
  });

  it("does not read or offer a summary for a campaign that has not sent", async () => {
    const draft = { ...CAMPAIGN, status: "draft" };
    const base = mocks.get.getMockImplementation();
    mocks.get.mockImplementation(async (path: string, opts?: unknown) =>
      path === PATHS.campaign ? draft : base?.(path, opts),
    );
    await mountAs("owner");
    const card = section("campaign-summary-card");
    await waitFor(() =>
      expect(card.textContent).toContain(
        "A summary is available after the campaign sends",
      ),
    );
    expect(getPaths()).not.toContain(PATHS.summary);
    expect(card.querySelectorAll("button")).toHaveLength(0);
    // A draft has no live numbers either.
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });
});

describe("web version card (campaigns-57)", () => {
  it("builds the public link from the archive address and copies it", async () => {
    await mountAs("admin");
    const card = section("campaign-web-version-card");
    await waitFor(() =>
      expect(card.textContent).toContain("https://news.acme.com/spring-sale"),
    );
    expect(getPaths()).toContain(PATHS.archiveSettings);
    expect(card.querySelector("a")?.getAttribute("href")).toBe(
      "https://news.acme.com/spring-sale",
    );

    await click(buttonIn(card, "Copy link"));
    expect(mocks.copy).toHaveBeenCalledWith("https://news.acme.com/spring-sale");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Web version link copied");
  });

  it("tells an editor who can resolve the link instead of reading admin settings", async () => {
    await mountAs("editor");
    const card = section("campaign-web-version-card");
    await waitFor(() =>
      expect(card.textContent).toContain("only an owner or admin can read"),
    );
    expect(getPaths()).not.toContain(PATHS.archiveSettings);
  });
});

describe("feedback thread (campaigns-60)", () => {
  it("posts a comment, shows it at the top, and clears the draft", async () => {
    mocks.post.mockImplementation(async (path: string, body?: unknown) => {
      if (path === PATHS.feedback) {
        return {
          id: "fb-new",
          campaign_id: CAMPAIGN_ID,
          author_label: "operator@example.com",
          body: (body as { body: string }).body,
          created_at: "2026-08-04T09:00:00Z",
        };
      }
      throw new Error(`unexpected POST ${path}`);
    });
    await mountAs("editor");
    const panel = section("campaign-feedback-panel");
    await waitFor(() =>
      expect(panel.textContent).toContain("Tighten the subject line."),
    );
    // Resolved rows stay out of the open list until asked for.
    expect(panel.textContent).not.toContain("Swap the hero image.");

    const textarea = panel.querySelector("textarea");
    if (!textarea) throw new Error("no comment box");
    setTextValue(textarea, "  Ship it after legal signs off.  ");
    await click(buttonIn(panel, "Post comment"));

    await waitFor(() => expect(postCalls(PATHS.feedback)).toHaveLength(1));
    expect(postCalls(PATHS.feedback)[0]?.[1]).toEqual({
      body: "Ship it after legal signs off.",
    });
    expect(postCalls(PATHS.feedback)[0]?.[2]).toEqual(
      expect.objectContaining({ requireOnline: true }),
    );
    await waitFor(() =>
      expect(panel.querySelector("li")?.textContent).toContain(
        "Ship it after legal signs off.",
      ),
    );
    expect(textarea.value).toBe("");
  });

  it("resolves only after a confirm that says there is no reopen, then files it under resolved", async () => {
    mocks.post.mockImplementation(async (path: string) => {
      if (path === `${PATHS.feedback}/fb-open/resolve`) {
        return { ...FEEDBACK[0], resolved_at: "2026-08-04T10:00:00Z" };
      }
      throw new Error(`unexpected POST ${path}`);
    });
    await mountAs("owner");
    const panel = section("campaign-feedback-panel");
    await waitFor(() =>
      expect(panel.textContent).toContain("Tighten the subject line."),
    );

    await click(buttonIn(panel, "Mark resolved"));
    expect(dialog().textContent).toContain("Resolving is one-way: there is no reopen.");
    expect(mocks.post).not.toHaveBeenCalled();
    await click(buttonIn(dialog(), "Mark resolved"));

    await waitFor(() =>
      expect(postCalls(`${PATHS.feedback}/fb-open/resolve`)).toHaveLength(1),
    );
    expect(postCalls(`${PATHS.feedback}/fb-open/resolve`)[0]?.[1]).toEqual({});
    await waitFor(() =>
      expect(panel.textContent).toContain("All comments resolved."),
    );
    await click(buttonIn(panel, "Show resolved (2)"));
    expect(panel.textContent).toContain("Tighten the subject line.");
    expect(panel.textContent).toContain("Swap the hero image.");
  });

  it("keeps the draft and says the server's sentence when a post is refused", async () => {
    mocks.post.mockRejectedValue(new ApiError("body is required", 422));
    await mountAs("editor");
    const panel = section("campaign-feedback-panel");
    await waitFor(() =>
      expect(panel.textContent).toContain("Tighten the subject line."),
    );
    const textarea = panel.querySelector("textarea");
    if (!textarea) throw new Error("no comment box");
    setTextValue(textarea, "Keep me");
    await click(buttonIn(panel, "Post comment"));
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.stringContaining("body is required"),
      ),
    );
    expect(textarea.value).toBe("Keep me");
  });

  it("withholds posting and resolving from a viewer", async () => {
    await mountAs("viewer");
    const panel = section("campaign-feedback-panel");
    await waitFor(() =>
      expect(panel.textContent).toContain("Tighten the subject line."),
    );
    expect(panel.textContent).toContain(
      "Campaign changes are read-only for this session.",
    );
    expect(buttonIn(panel, "Post comment").disabled).toBe(true);
    expect(buttonIn(panel, "Mark resolved").disabled).toBe(true);
  });
});

describe("campaign replies (campaigns-61)", () => {
  it("lists replies, filters by intent with ?intent=, and classifies one", async () => {
    mocks.post.mockImplementation(async (path: string) => {
      if (path === `${BASE}/replies/rep-1/classify`) {
        classifiedLabel = "question";
        return { ...REPLY_UNCLASSIFIED, intent_label: "question", intent_confidence: 0.8 };
      }
      throw new Error(`unexpected POST ${path}`);
    });
    await mountAs("admin");
    const panel = section("campaign-replies-panel");
    await waitFor(() =>
      expect(panel.textContent).toContain("Does the sale include shipping?"),
    );
    expect(getPaths()).toContain(PATHS.replies);
    expect(panel.textContent).toContain("Intent: Praise");

    await click(buttonIn(panel, "Classify"));
    await waitFor(() =>
      expect(postCalls(`${BASE}/replies/rep-1/classify`)).toHaveLength(1),
    );
    expect(postCalls(`${BASE}/replies/rep-1/classify`)[0]?.[2]).toEqual(
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );
    await waitFor(() => expect(panel.textContent).toContain("Intent: Question"));

    await click(buttonIn(panel, "Question"));
    await waitFor(() => expect(getPaths()).toContain(PATHS.repliesQuestion));
  });

  it("renders the classifier's refusal verbatim", async () => {
    mocks.post.mockRejectedValue(
      new ApiError("reply intent classifier is not configured", 503),
    );
    await mountAs("owner");
    const panel = section("campaign-replies-panel");
    await waitFor(() =>
      expect(panel.textContent).toContain("Does the sale include shipping?"),
    );
    await click(buttonIn(panel, "Classify"));
    await waitFor(() =>
      expect(panel.textContent).toContain(
        "reply intent classifier is not configured",
      ),
    );
  });

  it("does not load reply content for a non-admin", async () => {
    await mountAs("editor");
    const panel = section("campaign-replies-panel");
    expect(panel.textContent).toContain("Reply content is restricted");
    expect(getPaths().some((path) => path.includes("/replies"))).toBe(false);
  });
});

describe("content remix (campaigns-51)", () => {
  it("POSTs the picked channels and tone, renders each asset, and copies one", async () => {
    mocks.post.mockImplementation(async (path: string) => {
      if (path === PATHS.remix) {
        return {
          campaign_id: CAMPAIGN_ID,
          generated_at: "2026-08-04T10:00:00Z",
          assets: [
            { channel: "web_teaser", title: "Spring is here", body: "Teaser copy" },
            { channel: "social", title: "Social post", body: "Social copy" },
          ],
        };
      }
      throw new Error(`unexpected POST ${path}`);
    });
    await mountAs("admin");
    const card = section("campaign-remix-card");
    await click(buttonIn(card, "SMS"));
    await click(buttonIn(card, "Podcast outline"));
    const tone = card.querySelector("input");
    if (!tone) throw new Error("no tone input");
    setTextValue(tone, " playful ");
    await click(buttonIn(card, "Generate remix"));

    await waitFor(() => expect(postCalls(PATHS.remix)).toHaveLength(1));
    expect(postCalls(PATHS.remix)[0]?.[1]).toEqual({
      channels: ["web_teaser", "social"],
      tone: "playful",
    });
    expect(postCalls(PATHS.remix)[0]?.[2]).toEqual(
      expect.objectContaining({ requireOnline: true, idempotencyKey: null }),
    );
    await waitFor(() => expect(card.textContent).toContain("Social copy"));
    expect(card.textContent).toContain("Teaser copy");

    const copySocial = card.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy the Social asset"]',
    );
    if (!copySocial) throw new Error("no copy button");
    await click(copySocial);
    expect(mocks.copy).toHaveBeenCalledWith("Social copy");
  });

  it("withholds remix from an editor, whom the server's admin scope refuses", async () => {
    await mountAs("editor");
    const card = section("campaign-remix-card");
    expect(buttonIn(card, "Generate remix").disabled).toBe(true);
    expect(card.textContent).toContain(
      "Content remix is limited to owners and admins",
    );
  });
});

describe("audit-scoped activity feed (campaigns-62)", () => {
  it("reads the audit log scoped to this campaign and collapses", async () => {
    await mountAs("owner");
    const feed = section("campaign-audit-feed");
    await waitFor(() =>
      expect(feed.textContent).toContain("Campaign scheduled personalized"),
    );
    expect(getPaths()).toContain(PATHS.audit);
    expect(feed.textContent).toContain("alice@example.com");

    const toggle = buttonIn(feed, "Audit trail");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const controlled = document.getElementById(
      toggle.getAttribute("aria-controls") ?? "",
    );
    expect(controlled?.hidden).toBe(true);
  });

  it("tells a non-admin why the audit trail is withheld, without requesting it", async () => {
    await mountAs("editor");
    const feed = section("campaign-audit-feed");
    expect(feed.textContent).toContain("The audit trail is limited to owners and admins");
    expect(getPaths().some((path) => path.startsWith("/api/v1/audit"))).toBe(false);
  });
});
