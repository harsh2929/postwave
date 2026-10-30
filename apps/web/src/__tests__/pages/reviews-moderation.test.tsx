// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Behaviour tests for the /app/reviews moderation inbox — parity rows
// commerce-38 (inbox), -39 (evidence), -40 (publish), -41 (reject),
// -42 (reply) and -44 (installation snippet).
//
// Every assertion is a CONSEQUENCE: the literal request a verb sends (method,
// path, body), what the page renders afterwards, or the confirm's copy. None
// of them is "a button exists". The transport is mocked at `api.get/post` so
// the paths asserted here are the ones the server mounts in reviews.go.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ReviewsPage from "@/app/(dashboard)/app/reviews/page";
import { ApiError } from "@/lib/api";

import { waitFor } from "./_wait";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/reviews",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth-api")>("@/lib/auth-api");
  return {
    ...actual,
    whoami: mocks.whoami,
    whoamiFresh: mocks.whoamiFresh,
  };
});

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: { ...actual.api, get: mocks.apiGet, post: mocks.apiPost },
  };
});

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------------------------------------------ *
 * Fixtures — shaped like reviews.go emits them (Go tags 1:1), including
 * the contact field the UI must never render.
 * ------------------------------------------------------------------ */

const OWNER = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "owner@example.test",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "QA workspace",
  workspace_slug: "qa",
} as const;

const VIEWER = { ...OWNER, role: "viewer", effective_role: "viewer" } as const;

const CATALOG = {
  statuses: ["pending", "approved", "rejected", "spam", "archived"],
  widget_types: ["product_reviews"],
  authenticity: ["verified_buyer"],
  request_channels: ["email"],
  public_contract:
    "Public widgets expose approved reviews only and redact reviewer email/raw moderation metadata.",
  schema_version: "klv11.reviews.v1",
};

const PUBLIC_BASE = "https://shop.example.test";
const WIDGET = {
  id: "w-1",
  slug: "storefront",
  name: "Storefront reviews",
  status: "active",
  widget_type: "product_reviews",
  language: "en",
  public_url: `${PUBLIC_BASE}/api/public/reviews/widgets/storefront`,
};

type ServerReview = Record<string, unknown> & { id: string; status: string };

function serverReview(overrides: Partial<ServerReview> & { id: string }) {
  return {
    tenant_id: "tenant-1",
    product_id: "sku-42",
    reviewer_name: "Ada",
    reviewer_email: "ada@example.test",
    rating: 4,
    title: "Untitled",
    body: "",
    status: "pending",
    verified_buyer: true,
    incentivized: false,
    featured: false,
    submitted_at: "2026-09-01T09:00:00Z",
    created_at: "2026-09-01T09:00:00Z",
    public_replies: [],
    ...overrides,
  } as ServerReview;
}

let reviews: ServerReview[];
let embedByFlavor: Record<string, () => Promise<unknown>>;

function installReviewsServer(): void {
  mocks.apiGet.mockImplementation(
    (path: string, opts?: { query?: Record<string, string> }) => {
      if (path === "/api/v1/reviews/catalog") return Promise.resolve(CATALOG);
      if (path === "/api/v1/reviews/widgets") {
        return Promise.resolve({ items: [WIDGET] });
      }
      if (path === "/api/v1/reviews") {
        const status = opts?.query?.status;
        return Promise.resolve({
          items: status
            ? reviews.filter((review) => review.status === status)
            : reviews,
        });
      }
      const detail = /^\/api\/v1\/reviews\/([^/]+)$/.exec(path);
      if (detail) {
        const found = reviews.find((review) => review.id === detail[1]);
        return found
          ? Promise.resolve({ ...found })
          : Promise.reject(new ApiError("Review not found.", 404));
      }
      const embed =
        /^\/api\/v1\/reviews\/widgets\/w-1\/embed\/(iframe|script)$/.exec(path);
      if (embed) return embedByFlavor[embed[1]]();
      return Promise.reject(new Error(`Unexpected GET ${path}`));
    },
  );
  mocks.apiPost.mockImplementation((path: string, body: unknown) => {
    const match = /^\/api\/v1\/reviews\/([^/]+)\/(approve|reject|reply)$/.exec(
      path,
    );
    if (!match) return Promise.reject(new Error(`Unexpected POST ${path}`));
    const found = reviews.find((review) => review.id === match[1]);
    if (!found) return Promise.reject(new ApiError("Review not found.", 404));
    if (match[2] === "reply") {
      return Promise.resolve({
        id: "reply-1",
        review_id: match[1],
        author: "Store",
        body: (body as { body: string }).body,
        status: "published",
        created_at: "2026-09-05T10:00:00Z",
      });
    }
    found.status = match[2] === "approve" ? "approved" : "rejected";
    found.moderated_at = "2026-09-05T10:00:00Z";
    if (match[2] === "approve") found.published_at = "2026-09-05T10:00:00Z";
    return Promise.resolve({ ...found });
  });
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

function render(): Root {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ReviewsPage),
      ),
    );
  });
  return root;
}

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const match = Array.from(scope.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === text,
  );
  if (!match) throw new Error(`Button not found: ${text}`);
  return match;
}

function buttonLabelled(
  label: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const match = scope.querySelector(`button[aria-label="${label}"]`);
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Button not found by label: ${label}`);
  }
  return match;
}

function dialogTitled(title: string): HTMLElement {
  const match = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"]'),
  ).find((candidate) => candidate.textContent?.includes(title));
  if (!match) throw new Error(`Dialog not found: ${title}`);
  return match;
}

function queue(): HTMLElement {
  const match = document.querySelector<HTMLElement>(
    '[aria-label="Review queue"]',
  );
  if (!match) throw new Error("Review queue not rendered");
  return match;
}

function queueTitles(): string[] {
  return Array.from(queue().querySelectorAll("article h3")).map(
    (heading) => heading.textContent ?? "",
  );
}

function typeInto(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function reviewListCalls(): number {
  return mocks.apiGet.mock.calls.filter(([path]) => path === "/api/v1/reviews")
    .length;
}

function liveReadOptions(extra: Record<string, unknown> = {}) {
  return expect.objectContaining({
    ...extra,
    cache: "no-store",
    requireOnline: true,
    maxAttempts: 1,
    signal: expect.any(AbortSignal),
  });
}

function liveWriteOptions() {
  return expect.objectContaining({
    cache: "no-store",
    requireOnline: true,
    maxAttempts: 1,
    signal: expect.any(AbortSignal),
    idempotencyKey: expect.any(String),
  });
}

beforeEach(() => {
  mocks.whoami.mockResolvedValue(OWNER);
  mocks.whoamiFresh.mockResolvedValue(OWNER);
  reviews = [];
  embedByFlavor = {
    iframe: () =>
      Promise.resolve({
        flavor: "iframe",
        snippet: `<iframe src="${WIDGET.public_url}" data-postwave-reviews="storefront" loading="lazy"></iframe>`,
      }),
    script: () =>
      Promise.resolve({
        flavor: "script",
        snippet: `<script async src="${PUBLIC_BASE}/api/public/reviews/widgets/storefront/embed.js" data-postwave-reviews="storefront"></script>`,
      }),
  };
  installReviewsServer();
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

/* ------------------------------------------------------------------ */

describe("reviews moderation inbox", () => {
  it("loads the pending rail with the literal status query, then searches, sorts and refreshes inside the loaded window (commerce-38)", async () => {
    reviews = [
      serverReview({
        id: "rev-old",
        title: "Battery lasts for days",
        submitted_at: "2026-09-01T09:00:00Z",
      }),
      serverReview({
        id: "rev-new",
        title: "Strap broke in a week",
        submitted_at: "2026-09-03T09:00:00Z",
      }),
      serverReview({
        id: "rev-pub",
        title: "Already public",
        status: "approved",
      }),
    ];
    const root = render();
    try {
      await waitFor(() =>
        expect(queue().textContent).toContain("Battery lasts for days"),
      );
      expect(mocks.apiGet).toHaveBeenCalledWith(
        "/api/v1/reviews",
        liveReadOptions({ query: { status: "pending" } }),
      );
      // The approved review is not in the pending rail.
      expect(queue().textContent).not.toContain("Already public");
      // Queue priority surfaces the OLDEST pending review first.
      expect(queueTitles()).toEqual([
        "Battery lasts for days",
        "Strap broke in a week",
      ]);

      // Sort: newest first.
      const select = document.querySelector<HTMLSelectElement>(
        "select[id$='-sort']",
      );
      if (!select) throw new Error("Order select not rendered");
      act(() => {
        select.value = "newest";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(queueTitles()).toEqual([
        "Strap broke in a week",
        "Battery lasts for days",
      ]);

      // Search filters inside the loaded window without another request.
      const before = reviewListCalls();
      const search = document.querySelector<HTMLInputElement>(
        "input[type='search']",
      );
      if (!search) throw new Error("Search input not rendered");
      typeInto(search, "strap");
      expect(queueTitles()).toEqual(["Strap broke in a week"]);
      expect(reviewListCalls()).toBe(before);
      act(() => buttonLabelled("Clear review search").click());
      expect(queueTitles()).toHaveLength(2);

      // "All loaded" drops the status query entirely.
      act(() => button("All loaded").click());
      await waitFor(() =>
        expect(queue().textContent).toContain("Already public"),
      );
      expect(mocks.apiGet).toHaveBeenCalledWith(
        "/api/v1/reviews",
        liveReadOptions(),
      );

      // Refresh re-verifies the current rail with one more request.
      const beforeRefresh = reviewListCalls();
      act(() => buttonLabelled("Refresh review queue").click());
      await waitFor(() => expect(reviewListCalls()).toBe(beforeRefresh + 1));
    } finally {
      act(() => root.unmount());
    }
  });

  it("opens the complete evidence record by id and withholds reviewer contact details (commerce-39)", async () => {
    reviews = [
      serverReview({
        id: "rev-1",
        title: "Battery lasts for days",
        body: "Charged once all week.",
        moderation_reason: "Awaiting photo check",
      }),
    ];
    const root = render();
    try {
      await waitFor(() =>
        expect(queue().textContent).toContain("Battery lasts for days"),
      );
      act(() =>
        buttonLabelled(
          "Review and decide Battery lasts for days by Ada",
        ).click(),
      );
      await waitFor(() =>
        expect(mocks.apiGet).toHaveBeenCalledWith(
          "/api/v1/reviews/rev-1",
          liveReadOptions(),
        ),
      );
      await waitFor(() =>
        expect(dialogTitled("Review evidence").textContent).toContain(
          "Awaiting photo check",
        ),
      );
      const evidence = dialogTitled("Review evidence");
      expect(evidence.textContent).toContain("sku-42");
      expect(evidence.textContent).toContain("Charged once all week.");
      expect(evidence.textContent).toContain("Buyer verification reported");
      // The contact field the server sent never reaches the DOM.
      expect(document.body.textContent).not.toContain("ada@example.test");
      // A pending review has no reply verb.
      expect(() => button("Write public reply", evidence)).toThrow();
    } finally {
      act(() => root.unmount());
    }
  });

  it("publishes a pending review after a confirm that names its consequence, then the row leaves the pending rail (commerce-40, P1)", async () => {
    reviews = [
      serverReview({ id: "rev-1", title: "Battery lasts for days" }),
      serverReview({
        id: "rev-2",
        title: "Strap broke in a week",
        submitted_at: "2026-09-03T09:00:00Z",
      }),
    ];
    const root = render();
    try {
      await waitFor(() =>
        expect(queue().textContent).toContain("Battery lasts for days"),
      );
      act(() =>
        buttonLabelled(
          "Review and decide Battery lasts for days by Ada",
        ).click(),
      );
      // Decision controls stay withheld until the complete record is verified.
      await waitFor(() =>
        expect(
          button("Publish review", dialogTitled("Review evidence")).disabled,
        ).toBe(false),
      );
      expect(mocks.apiPost).not.toHaveBeenCalled();

      act(() =>
        button("Publish review", dialogTitled("Review evidence")).click(),
      );
      const confirm = dialogTitled("Publish this review now?");
      expect(confirm.textContent).toContain(
        "The service marks the review public immediately",
      );
      expect(confirm.textContent).toContain(
        "Immediate server-side publication",
      );

      await act(async () => button("Publish review now", confirm).click());
      await waitFor(() =>
        expect(mocks.apiPost).toHaveBeenCalledWith(
          "/api/v1/reviews/rev-1/approve",
          {},
          liveWriteOptions(),
        ),
      );
      expect(mocks.apiPost).toHaveBeenCalledTimes(1);

      // The row leaves the pending rail once the queue is re-verified.
      await waitFor(() =>
        expect(queue().textContent).not.toContain("Battery lasts for days"),
      );
      expect(queue().textContent).toContain("Strap broke in a week");
      // The evidence record reflects the server's new state.
      expect(dialogTitled("Review evidence").textContent).toContain(
        "Published",
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Review marked public by the service",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("rejects a pending review after a confirm that names the missing restore path, then the row leaves the pending rail (commerce-41, P1)", async () => {
    reviews = [
      serverReview({ id: "rev-1", title: "Battery lasts for days" }),
      serverReview({
        id: "rev-2",
        title: "Strap broke in a week",
        submitted_at: "2026-09-03T09:00:00Z",
      }),
    ];
    const root = render();
    try {
      await waitFor(() =>
        expect(queue().textContent).toContain("Battery lasts for days"),
      );
      act(() =>
        buttonLabelled(
          "Review and decide Battery lasts for days by Ada",
        ).click(),
      );
      await waitFor(() =>
        expect(
          button("Reject review", dialogTitled("Review evidence")).disabled,
        ).toBe(false),
      );

      act(() =>
        button("Reject review", dialogTitled("Review evidence")).click(),
      );
      const confirm = dialogTitled("Reject this review?");
      expect(confirm.textContent).toContain(
        "The review will leave the pending moderation queue.",
      );
      expect(confirm.textContent).toContain("No recovery path");

      await act(async () => button("Reject review now", confirm).click());
      await waitFor(() =>
        expect(mocks.apiPost).toHaveBeenCalledWith(
          "/api/v1/reviews/rev-1/reject",
          {},
          liveWriteOptions(),
        ),
      );
      expect(mocks.apiPost).toHaveBeenCalledTimes(1);

      await waitFor(() =>
        expect(queue().textContent).not.toContain("Battery lasts for days"),
      );
      expect(queue().textContent).toContain("Strap broke in a week");
      const evidence = dialogTitled("Review evidence");
      expect(evidence.textContent).toContain("Rejected");
      expect(evidence.textContent).toContain("No restore path");
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Review rejected");
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders the server's refusal sentence inside the confirm and keeps the row pending when a decision is denied", async () => {
    reviews = [serverReview({ id: "rev-1", title: "Battery lasts for days" })];
    mocks.apiPost.mockImplementation(() =>
      Promise.reject(
        new ApiError("Your role does not permit moderation.", 403),
      ),
    );
    const root = render();
    try {
      await waitFor(() =>
        expect(queue().textContent).toContain("Battery lasts for days"),
      );
      act(() =>
        buttonLabelled(
          "Review and decide Battery lasts for days by Ada",
        ).click(),
      );
      await waitFor(() =>
        expect(
          button("Publish review", dialogTitled("Review evidence")).disabled,
        ).toBe(false),
      );
      act(() =>
        button("Publish review", dialogTitled("Review evidence")).click(),
      );
      await act(async () =>
        button(
          "Publish review now",
          dialogTitled("Publish this review now?"),
        ).click(),
      );
      await waitFor(() => {
        const alert = dialogTitled("Publish this review now?").querySelector(
          '[role="alert"]',
        );
        expect(alert?.textContent).toContain(
          "Your role does not permit moderation.",
        );
      });
      expect(queue().textContent).toContain("Battery lasts for days");
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("rechecks exact admin authority before moderation and blocks a stale control", async () => {
    reviews = [serverReview({ id: "rev-1", title: "Battery lasts for days" })];
    mocks.whoamiFresh.mockResolvedValue(VIEWER);
    const root = render();
    try {
      await waitFor(() =>
        expect(queue().textContent).toContain("Battery lasts for days"),
      );
      act(() =>
        buttonLabelled(
          "Review and decide Battery lasts for days by Ada",
        ).click(),
      );
      await waitFor(() =>
        expect(
          button("Publish review", dialogTitled("Review evidence")).disabled,
        ).toBe(false),
      );
      act(() =>
        button("Publish review", dialogTitled("Review evidence")).click(),
      );
      await act(async () =>
        button(
          "Publish review now",
          dialogTitled("Publish this review now?"),
        ).click(),
      );
      await waitFor(() => expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1));
      expect(mocks.apiPost).not.toHaveBeenCalled();
      expect(queue().textContent).toContain("Battery lasts for days");
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("rejects a false-success moderation receipt", async () => {
    reviews = [serverReview({ id: "rev-1", title: "Battery lasts for days" })];
    mocks.apiPost.mockResolvedValue(
      serverReview({ id: "rev-1", title: "Battery lasts for days" }),
    );
    const root = render();
    try {
      await waitFor(() =>
        expect(queue().textContent).toContain("Battery lasts for days"),
      );
      act(() =>
        buttonLabelled(
          "Review and decide Battery lasts for days by Ada",
        ).click(),
      );
      await waitFor(() =>
        expect(
          button("Publish review", dialogTitled("Review evidence")).disabled,
        ).toBe(false),
      );
      act(() =>
        button("Publish review", dialogTitled("Review evidence")).click(),
      );
      await act(async () =>
        button(
          "Publish review now",
          dialogTitled("Publish this review now?"),
        ).click(),
      );
      await waitFor(() =>
        expect(dialogTitled("Publish this review now?").textContent).toContain(
          "did not confirm that the review is approved",
        ),
      );
      expect(queue().textContent).toContain("Battery lasts for days");
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("publishes a store reply for a published review only after previewing the exact text (commerce-42)", async () => {
    reviews = [
      serverReview({
        id: "rev-3",
        title: "Already public",
        status: "approved",
        published_at: "2026-09-02T09:00:00Z",
      }),
    ];
    const root = render();
    try {
      await waitFor(() =>
        expect(queue().textContent).toContain(
          "No pending reviews in this loaded window",
        ),
      );
      act(() => button("Published").click());
      await waitFor(() =>
        expect(mocks.apiGet).toHaveBeenCalledWith(
          "/api/v1/reviews",
          liveReadOptions({ query: { status: "approved" } }),
        ),
      );
      await waitFor(() =>
        expect(queue().textContent).toContain("Already public"),
      );
      act(() => buttonLabelled("Inspect Already public by Ada").click());
      await waitFor(() =>
        expect(
          button("Write public reply", dialogTitled("Review evidence"))
            .disabled,
        ).toBe(false),
      );
      // No decision verbs on a published review.
      expect(() =>
        button("Publish review", dialogTitled("Review evidence")),
      ).toThrow();

      act(() =>
        button("Write public reply", dialogTitled("Review evidence")).click(),
      );
      const textarea =
        dialogTitled("Review evidence").querySelector("textarea");
      if (!textarea) throw new Error("Reply composer not rendered");
      expect(
        button("Review public reply", dialogTitled("Review evidence")).disabled,
      ).toBe(true);
      typeInto(textarea, "Thanks for the kind words.");
      act(() =>
        button("Review public reply", dialogTitled("Review evidence")).click(),
      );

      const confirm = dialogTitled("Publish this store reply?");
      expect(confirm.textContent).toContain(
        "Review the exact text the service will store as public.",
      );
      expect(confirm.textContent).toContain("Thanks for the kind words.");
      expect(mocks.apiPost).not.toHaveBeenCalled();

      await act(async () => button("Publish reply now", confirm).click());
      await waitFor(() =>
        expect(mocks.apiPost).toHaveBeenCalledWith(
          "/api/v1/reviews/rev-3/reply",
          { body: "Thanks for the kind words." },
          liveWriteOptions(),
        ),
      );
      await waitFor(() =>
        expect(dialogTitled("Review evidence").textContent).toContain(
          "Reported author: Store",
        ),
      );
      expect(dialogTitled("Review evidence").textContent).toContain(
        "Thanks for the kind words.",
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Reply marked public by the service",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("withholds publish, reject and reply from a non-admin and says why", async () => {
    mocks.whoami.mockResolvedValue(VIEWER);
    reviews = [serverReview({ id: "rev-1", title: "Battery lasts for days" })];
    const root = render();
    try {
      await waitFor(() =>
        expect(queue().textContent).toContain("Battery lasts for days"),
      );
      expect(document.body.textContent).toContain("Read-only review access");
      // The card offers inspection, not a decision.
      act(() =>
        buttonLabelled("Inspect Battery lasts for days by Ada").click(),
      );
      await waitFor(() =>
        expect(dialogTitled("Review evidence").textContent).toContain(
          "Read-only review evidence",
        ),
      );
      const evidence = dialogTitled("Review evidence");
      expect(() => button("Publish review", evidence)).toThrow();
      expect(() => button("Reject review", evidence)).toThrow();
      expect(() => button("Write public reply", evidence)).toThrow();
      expect(mocks.apiPost).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("review widget installation", () => {
  it("fetches each flavor's snippet by widget id, retries a failed request, and blocks copy that fails the safety gate (commerce-44)", async () => {
    const iframeEmbed = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("Embed generation failed.", 500))
      .mockResolvedValue({
        flavor: "iframe",
        snippet: `<iframe src="${WIDGET.public_url}" data-postwave-reviews="storefront" loading="lazy"></iframe>`,
      });
    embedByFlavor.iframe = iframeEmbed;
    const root = render();
    try {
      await waitFor(() => expect(button("Review installation")).toBeTruthy());
      act(() => button("Review installation").click());
      await waitFor(() =>
        expect(mocks.apiGet).toHaveBeenCalledWith(
          "/api/v1/reviews/widgets/w-1/embed/iframe",
        ),
      );
      const dialog = () =>
        dialogTitled("Review installation · Storefront reviews");
      await waitFor(() =>
        expect(dialog().textContent).toContain("Embed generation failed."),
      );

      // Retry is a manual verb and re-requests the same flavor.
      act(() => button("Retry iframe", dialog()).click());
      await waitFor(() =>
        expect(dialog().querySelector("textarea")?.value).toContain("<iframe"),
      );
      expect(iframeEmbed).toHaveBeenCalledTimes(2);

      // The server's iframe has no title and does not target /html: copy is
      // withheld with the reason beside it.
      const blockedCopy = button("Iframe copy unavailable", dialog());
      expect(blockedCopy.disabled).toBe(true);
      expect(dialog().textContent).toContain(
        "needs a non-empty title and must target the rendered /html view",
      );

      // Script flavor: fetched by its own path; delivery is not certified.
      act(() => button("Script", dialog()).click());
      await waitFor(() =>
        expect(mocks.apiGet).toHaveBeenCalledWith(
          "/api/v1/reviews/widgets/w-1/embed/script",
        ),
      );
      await waitFor(() =>
        expect(button("Script copy unavailable", dialog()).disabled).toBe(true),
      );
      expect(dialog().textContent).toContain(
        "Storefront delivery not certified",
      );
      expect(dialog().querySelector("textarea")?.value).toContain("<script");
    } finally {
      act(() => root.unmount());
    }
  });

  it("copies an iframe that names its content and targets the rendered /html view", async () => {
    const snippet = `<iframe title="Storefront reviews" src="${WIDGET.public_url}/html" data-postwave-reviews="storefront" loading="lazy"></iframe>`;
    embedByFlavor.iframe = () => Promise.resolve({ flavor: "iframe", snippet });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const root = render();
    try {
      await waitFor(() => expect(button("Review installation")).toBeTruthy());
      act(() => button("Review installation").click());
      const dialog = () =>
        dialogTitled("Review installation · Storefront reviews");
      await waitFor(() =>
        expect(button("Copy iframe code", dialog()).disabled).toBe(false),
      );
      await act(async () => button("Copy iframe code", dialog()).click());
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(snippet));
      await waitFor(() => expect(button("Copied", dialog())).toBeTruthy());
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Iframe installation code copied",
      );
    } finally {
      act(() => root.unmount());
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});
