// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// /app/lists/[id] extra tabs (audience-92/93/94/95/96/97/98) and the lists
// index additions (audience-88/89). Every assertion is on the CONSEQUENCE of a
// verb: the request's method + path + query/body, the rendered result, or the
// confirm's copy — never that a control merely exists.

import { act, createElement, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { importBeforeTests, waitFor } from "./_wait";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  search: { current: "" },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.push,
    replace: mocks.replace,
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/lists/7",
  useSearchParams: () => new URLSearchParams(mocks.search.current),
  useParams: () => ({ id: "7" }),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: mocks.apiGet,
      patch: mocks.apiPatch,
      post: mocks.apiPost,
      delete: mocks.apiDelete,
    },
  };
});

vi.mock("sonner", () => ({ toast: mocks.toast }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "qa@postwave.test",
  role: "owner" as const,
  effective_role: "owner" as const,
  viewer_mode: false,
};
const EDITOR = {
  ...OWNER,
  role: "editor" as const,
  effective_role: "editor" as const,
};
const VIEWER = {
  ...OWNER,
  role: "viewer" as const,
  effective_role: "viewer" as const,
};

const LIST = {
  id: 7,
  postwave_uuid: "33333333-3333-4333-8333-333333333333",
  name: "Newsletter",
  type: "private",
  optin: "single",
  tags: ["news"],
  description: "Weekly digest",
  subscriber_count: 1234,
};
const EMPTY_LIST = {
  id: 8,
  name: "Ghost town",
  type: "public",
  optin: "double",
  tags: [],
  description: "",
  subscriber_count: 0,
};
const ANN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const P = "/api/v1/lists/7";
const SECRET = "whsec_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c";

const webhook = {
  id: "w1",
  url: "https://hooks.example.com/postwave",
  events: ["list.subscriber.added"],
  active: true,
  url_status: "ready",
  auth_config_status: "ready",
  delivery_policy_status: "ready",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
  last_succeeded_at: "2026-08-02T00:00:00Z",
};

type Q = { query?: Record<string, unknown> };

function stubTransport(): void {
  mocks.apiGet.mockImplementation((path: string, opts?: Q) => {
    const q = opts?.query ?? {};
    switch (path) {
      case "/api/v1/lists":
        return Promise.resolve({ data: [LIST, EMPTY_LIST] });
      case `${P}/subscribers`:
        return Promise.resolve({
          list_id: LIST.postwave_uuid,
          items: [
            {
              id: ANN,
              email: "ann@example.com",
              status: "enabled",
              added_at: "2026-08-01T00:00:00Z",
            },
            {
              id: BOB,
              email: "bob@example.com",
              status: "enabled",
              added_at: "2026-08-02T00:00:00Z",
            },
          ],
          total: 30,
          page: 1,
          per_page: 25,
        });
      case `${P}/growth`:
        return Promise.resolve({
          list_id: LIST.postwave_uuid,
          window_days: 30,
          current: 1234,
          points: [
            { date: "2026-08-01", added: 5, removed: 1, net: 4, total: 1230 },
            { date: "2026-08-02", added: 6, removed: 2, net: 4, total: 1234 },
          ],
        });
      case `${P}/source-mix`:
        return Promise.resolve({
          list_id: LIST.postwave_uuid,
          sources: {
            form: 60,
            api: 40,
            csv: 0,
            integration: 0,
            admin: 0,
            migration: 0,
            listmonk_event: 0,
          },
        });
      case `${P}/engagement-breakdown`:
        return Promise.resolve({
          list_id: LIST.postwave_uuid,
          window_days: 30,
          opens: 4242,
          clicks: 17,
          unsubs: 3,
          complaints: 0,
          bounces: 1,
        });
      case `${P}/per-row-engagement`:
        return Promise.resolve({
          list_id: LIST.postwave_uuid,
          rows: [
            { id: BOB, email: "bob@example.com", opens: 1, clicks: 0 },
            {
              id: ANN,
              email: "ann@example.com",
              opens: 5,
              clicks: 2,
              last_engaged_at: "2026-08-03T00:00:00Z",
            },
          ],
        });
      case `${P}/health-history`:
        return Promise.resolve({
          list_id: LIST.postwave_uuid,
          window_days: 90,
          history: [
            {
              sampled_at: "2026-07-01T00:00:00Z",
              score: 70,
              grade: "C",
              bounce_rate: 0.01,
              complaint_rate: 0,
              unsubscribe_rate: 0.01,
              engagement_rate: 0.2,
            },
            {
              sampled_at: "2026-08-01T00:00:00Z",
              score: 78,
              grade: "B",
              bounce_rate: 0.004,
              complaint_rate: 0,
              unsubscribe_rate: 0.01,
              engagement_rate: 0.31,
            },
          ],
        });
      case `${P}/activity`:
        return Promise.resolve({
          list_id: LIST.postwave_uuid,
          events: Array.from({ length: 30 }, (_, i) => ({
            at: `2026-08-${String(30 - Math.floor(i / 2)).padStart(2, "0")}T10:00:00Z`,
            kind:
              i === 0
                ? "subscribed"
                : i === 1
                  ? "suppression_add"
                  : "unsubscribed",
            email: i === 29 ? "page-two@example.com" : `sub${i}@example.com`,
            ...(i === 0 ? { detail: { source: "form" } } : {}),
          })),
        });
      case `${P}/suppressions`:
        return Promise.resolve({
          items: [
            {
              email:
                q.page === 2 ? "page-two@example.com" : "bounced@example.com",
              reason: "hard_bounce",
              source: "ses",
              suppressed_at: "2026-08-01T00:00:00Z",
              created_at: "2026-08-01T00:00:00Z",
              source_table: "suppressions",
            },
          ],
          total: 30,
          page: q.page ?? 1,
          per_page: 25,
        });
      case `${P}/forms`:
        return Promise.resolve({
          list_id: LIST.postwave_uuid,
          forms: [
            {
              id: "f1",
              slug: "join",
              name: "Join us",
              status: "published",
              opt_in_mode: "double",
              updated_at: "2026-08-01T00:00:00Z",
            },
          ],
        });
      case `${P}/automations`:
        return Promise.resolve({
          list_id: LIST.postwave_uuid,
          automations: [
            {
              id: "a1",
              name: "Welcome flow",
              status: "active",
              updated_at: "2026-08-01T00:00:00Z",
            },
          ],
        });
      case `${P}/inbox-reality`:
        return Promise.resolve({
          list_id: "7",
          items: [
            {
              test_id: "t1",
              subject: "August issue",
              created_at: "2026-08-01T00:00:00Z",
              status: "completed",
              total_seeds: 10,
              inbox: 8,
              spam: 1,
              missing: 1,
              inbox_pct: 80,
            },
            {
              test_id: "t2",
              created_at: "2026-08-02T00:00:00Z",
              status: "pending",
              total_seeds: 0,
              inbox: 0,
              spam: 0,
              missing: 0,
              inbox_pct: 0,
            },
          ],
        });
      case `${P}/merge-fields`:
        return Promise.resolve({
          list_id: LIST.postwave_uuid,
          merge_fields: [
            {
              tag: "FNAME",
              type: "text",
              name: "First name",
              required: true,
              default: "Friend",
            },
          ],
        });
      case `${P}/webhooks`:
        return Promise.resolve({
          list_id: LIST.postwave_uuid,
          webhooks: [webhook],
          next_cursor: "",
        });
      case `${P}/webhooks/w1/deliveries`:
        return Promise.resolve({
          deliveries: [
            {
              id: "d1",
              webhook_id: "w1",
              event_type: "list.subscriber.added",
              attempt_count: 1,
              status: "delivered",
              last_status_code: 200,
              created_at: "2026-08-02T00:00:00Z",
              delivered_at: "2026-08-02T00:00:01Z",
            },
          ],
          next_cursor: "",
        });
      case "/api/v1/list-health":
        return Promise.resolve(
          q.tag === "Newsletter"
            ? {
                tag: "Newsletter",
                window_days: 90,
                total_subscribers: 1234,
                active_subscribers: 1200,
                engaged_subscribers: 400,
                blocklisted_count: 3,
                bounces: 2,
                complaints: 0,
                unsubscribes: 4,
                bounce_rate: 0.0017,
                complaint_rate: 0,
                unsubscribe_rate: 0.0033,
                engagement_rate: 0.33,
                suppression_rate: 0.0024,
                score: 78,
                grade: "B",
                notes: ["engagement 33.0% within thresholds"],
              }
            : {
                tag: q.tag,
                window_days: 90,
                total_subscribers: 0,
                active_subscribers: 0,
                engaged_subscribers: 0,
                blocklisted_count: 0,
                bounces: 0,
                complaints: 0,
                unsubscribes: 0,
                bounce_rate: 0,
                complaint_rate: 0,
                unsubscribe_rate: 0,
                engagement_rate: 0,
                suppression_rate: 0,
                score: 100,
                grade: "A",
                notes: [],
              },
        );
      default:
        return Promise.reject(new Error(`Unexpected GET ${path}`));
    }
  });
  mocks.apiPost.mockImplementation((path: string, body: unknown) => {
    if (path === `${P}/merge-fields`)
      return Promise.resolve({
        ...(body as object),
        created_at: "2026-08-03T00:00:00Z",
      });
    if (path === `${P}/webhooks`)
      return Promise.resolve({
        ...webhook,
        id: "w2",
        url: (body as { url: string }).url,
        signing_secret: SECRET,
      });
    if (path === `${P}/webhooks/w1/rotate-secret`)
      return Promise.resolve({
        ...webhook,
        signing_secret: "whsec_rotated_0123456789abcdef",
      });
    if (path === `${P}/webhooks/w1/test`)
      return Promise.resolve({
        webhook_id: "w1",
        status_code: 200,
        signed: true,
        signature: "t=1,v1=abc",
        response: "",
        filtered: false,
      });
    return Promise.reject(new Error(`Unexpected POST ${path}`));
  });
  mocks.apiPatch.mockImplementation((path: string, body: unknown) => {
    if (path.startsWith(`${P}/merge-fields/`))
      return Promise.resolve({ ...(body as object) });
    if (path === `${P}/webhooks/w1`)
      return Promise.resolve({ ...webhook, ...(body as object) });
    return Promise.reject(new Error(`Unexpected PATCH ${path}`));
  });
  mocks.apiDelete.mockResolvedValue(undefined);
}

async function render(ui: ReactNode): Promise<Root> {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(StrictMode, null, ui),
      ),
    );
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function q<T extends Element>(
  selector: string,
  scope: ParentNode = document,
): T {
  const el = scope.querySelector<T>(selector);
  if (!el) throw new Error(`Missing ${selector}`);
  return el;
}

function buttonByText(
  text: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const el = [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!el) throw new Error(`Missing button "${text}"`);
  return el;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
    await flush();
  });
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
}

async function mountPage(tab: string): Promise<Root> {
  mocks.search.current = tab ? `tab=${tab}` : "";
  const Page = (await import("@/app/(dashboard)/app/lists/[id]/page")).default;
  const root = await render(
    createElement(Page, { params: Promise.resolve({ id: "7" }) }),
  );
  await waitFor(() => {
    expect(document.querySelector("h1")?.textContent).toBe("Newsletter");
  });
  return root;
}

function getCalls(path: string) {
  return mocks.apiGet.mock.calls.filter(([p]) => p === path);
}

function dialog(): HTMLElement {
  return q<HTMLElement>('[role="dialog"]');
}

// The modules these tests import are cold work for vitest's transform
// pipeline; pay them before any test's 5 s clock starts.
importBeforeTests(
  () => import("@/app/(dashboard)/app/lists/[id]/page"),
  () => import("@/app/(dashboard)/app/lists/lists-admin-client"),
);

beforeEach(() => {
  mocks.whoami.mockResolvedValue(OWNER);
  mocks.whoamiFresh.mockResolvedValue(OWNER);
  stubTransport();
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("lists/[id] extra tabs", () => {
  it("Analytics: reads the five facets with the server's window params and scores the first members page", async () => {
    const root = await mountPage("analytics");
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("1,234");
        expect(document.body.textContent).toContain("4,242");
      });
      expect(mocks.apiGet).toHaveBeenCalledWith(
        `${P}/growth`,
        expect.objectContaining({ query: { window: 30 } }),
      );
      expect(mocks.apiGet).toHaveBeenCalledWith(
        `${P}/source-mix`,
        expect.anything(),
      );
      expect(mocks.apiGet).toHaveBeenCalledWith(
        `${P}/engagement-breakdown`,
        expect.objectContaining({ query: { window: 30 } }),
      );
      expect(mocks.apiGet).toHaveBeenCalledWith(
        `${P}/health-history`,
        expect.objectContaining({ query: { window_days: 90 } }),
      );
      // Per-row engagement needs explicit ids: the first members page feeds it.
      await waitFor(() => {
        expect(mocks.apiGet).toHaveBeenCalledWith(
          `${P}/per-row-engagement`,
          expect.objectContaining({
            query: { subscriber_ids: `${ANN},${BOB}` },
          }),
        );
      });
      await waitFor(() => {
        // Growth sums over the window + source share + latest health grade.
        expect(document.body.textContent).toContain("+8");
        expect(document.body.textContent).toContain("60%");
        expect(document.body.textContent).toContain("Form");
        expect(document.body.textContent).toContain("Members now");
        // Health: latest sample B/78, change +8 since first sample.
        expect(document.body.textContent).toContain("78");
        // Per-row sorted by opens+clicks: ann (7) before bob (1).
        const cells = [
          ...document.querySelectorAll(
            '[aria-label="Member engagement"] tbody tr',
          ),
        ].map((r) => r.textContent ?? "");
        expect(cells[0]).toContain("ann@example.com");
        expect(cells[1]).toContain("bob@example.com");
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("Activity: reads ?limit=100 once, pages client-side and states the server cap", async () => {
    const root = await mountPage("activity");
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("sub0@example.com");
      });
      expect(mocks.apiGet).toHaveBeenCalledWith(
        `${P}/activity`,
        expect.objectContaining({ query: { limit: 100 } }),
      );
      expect(document.body.textContent).toContain("Subscribed");
      expect(document.body.textContent).toContain("Suppressed");
      expect(document.body.textContent).toContain("source form");
      expect(document.body.textContent).toContain("Page 1 of 2");
      expect(document.body.textContent).not.toContain("page-two@example.com");
      const before = getCalls(`${P}/activity`).length;
      await click(q('button[aria-label="Next page"]'));
      await waitFor(() => {
        expect(document.body.textContent).toContain("page-two@example.com");
        expect(document.body.textContent).toContain("Page 2 of 2");
      });
      // Client-side paging: no second request.
      expect(getCalls(`${P}/activity`).length).toBe(before);
    } finally {
      act(() => root.unmount());
    }
  });

  it("Suppression: pages through GET /suppressions with page + per_page", async () => {
    const root = await mountPage("suppression");
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("bounced@example.com");
      });
      expect(mocks.apiGet).toHaveBeenCalledWith(
        `${P}/suppressions`,
        expect.objectContaining({ query: { page: 1, per_page: 25 } }),
      );
      expect(document.body.textContent).toContain("hard_bounce");
      expect(document.body.textContent).toContain(
        "Page 1 of 2 · 30 suppressions",
      );
      await click(q('button[aria-label="Next page"]'));
      await waitFor(() => {
        expect(mocks.apiGet).toHaveBeenCalledWith(
          `${P}/suppressions`,
          expect.objectContaining({ query: { page: 2, per_page: 25 } }),
        );
        expect(document.body.textContent).toContain("page-two@example.com");
      });
      expect(q<HTMLAnchorElement>('a[href="/app/suppressions"]')).toBeTruthy();
    } finally {
      act(() => root.unmount());
    }
  });

  it("Forms & automations: lists what targets the list and links each row into its editor", async () => {
    const root = await mountPage("forms");
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Join us");
        expect(document.body.textContent).toContain("Welcome flow");
      });
      expect(mocks.apiGet).toHaveBeenCalledWith(
        `${P}/forms`,
        expect.anything(),
      );
      expect(mocks.apiGet).toHaveBeenCalledWith(
        `${P}/automations`,
        expect.anything(),
      );
      expect(q<HTMLAnchorElement>('a[href="/app/forms/f1"]').textContent).toBe(
        "Join us",
      );
      expect(q<HTMLAnchorElement>('a[href="/app/flows/a1"]').textContent).toBe(
        "Welcome flow",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("Inbox reality: reads ?limit=25, never fabricates a 0% for a pending test, and states the tenant-wide scope", async () => {
    const root = await mountPage("inbox-reality");
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("August issue");
      });
      expect(mocks.apiGet).toHaveBeenCalledWith(
        `${P}/inbox-reality`,
        expect.objectContaining({ query: { limit: 25 } }),
      );
      const rows = [
        ...document.querySelectorAll(
          '[aria-label="Seed placement tests"] tbody tr',
        ),
      ].map((r) => r.textContent ?? "");
      expect(rows[0]).toContain("80%");
      expect(rows[0]).toContain("8 inbox · 1 spam · 1 missing (10 seeds)");
      expect(rows[1]).toContain("Test t2");
      expect(rows[1]).toContain("—");
      expect(rows[1]).not.toContain("0%");
      expect(document.body.textContent).toContain(
        "does not yet filter them to Newsletter",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("Merge fields: create POSTs the normalised body, edit PATCHes by tag, delete confirms the consequence then DELETEs by tag", async () => {
    const root = await mountPage("merge-fields");
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("FNAME");
      });
      expect(mocks.apiGet).toHaveBeenCalledWith(
        `${P}/merge-fields`,
        expect.anything(),
      );
      expect(document.body.textContent).toContain("Friend");

      // Create — the tag is suggested from the name until touched.
      await click(buttonByText("Add field"));
      await waitFor(() =>
        expect(dialog().textContent).toContain("Add merge field to Newsletter"),
      );
      await type(
        q<HTMLInputElement>('input[id$="-name"]', dialog()),
        "Company name ",
      );
      expect(q<HTMLInputElement>('input[id$="-tag"]', dialog()).value).toBe(
        "COMPANY_NA",
      );
      await type(q<HTMLInputElement>('input[id$="-tag"]', dialog()), "company");
      await type(
        q<HTMLInputElement>('input[id$="-default"]', dialog()),
        " Acme ",
      );
      await click(buttonByText("Add field", dialog()));
      await waitFor(() => {
        expect(mocks.apiPost).toHaveBeenCalledWith(
          `${P}/merge-fields`,
          {
            tag: "COMPANY",
            type: "text",
            name: "Company name",
            required: false,
            default: "Acme",
          },
          expect.objectContaining({
            requireOnline: true,
            idempotencyKey: expect.stringContaining("list-merge-field-create"),
          }),
        );
      });
      expect(mocks.whoamiFresh).toHaveBeenCalled();
      await waitFor(() => {
        expect(mocks.toast.success).toHaveBeenCalledWith(
          "Merge field COMPANY added to Newsletter",
        );
        expect(document.querySelector('[role="dialog"]')).toBeNull();
      });

      // Edit — addressed by the existing tag; the tag input is locked.
      await click(q('button[aria-label="Edit FNAME"]'));
      await waitFor(() => expect(dialog().textContent).toContain("Edit FNAME"));
      expect(q<HTMLInputElement>('input[id$="-tag"]', dialog()).disabled).toBe(
        true,
      );
      await click(
        q<HTMLInputElement>('[role="dialog"] input[type="checkbox"]'),
      );
      await click(buttonByText("Save changes", dialog()));
      await waitFor(() => {
        expect(mocks.apiPatch).toHaveBeenCalledWith(
          `${P}/merge-fields/FNAME`,
          {
            tag: "FNAME",
            type: "text",
            name: "First name",
            required: false,
            default: "Friend",
          },
          expect.objectContaining({
            requireOnline: true,
            idempotencyKey: expect.stringContaining("list-merge-field-update"),
          }),
        );
      });
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );

      // Delete — names the consequence, then DELETEs by tag.
      await click(q('button[aria-label="Delete FNAME"]'));
      await waitFor(() => {
        expect(dialog().textContent).toContain(
          "{{ merge_fields.FNAME }} render empty",
        );
      });
      expect(mocks.apiDelete).not.toHaveBeenCalled();
      await click(buttonByText("Delete field", dialog()));
      await waitFor(() => {
        expect(mocks.apiDelete).toHaveBeenCalledWith(
          `${P}/merge-fields/FNAME`,
          expect.objectContaining({
            requireOnline: true,
            idempotencyKey: expect.stringContaining("list-merge-field-delete"),
          }),
        );
        expect(mocks.toast.success).toHaveBeenCalledWith(
          "Merge field FNAME removed from Newsletter",
        );
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("Merge fields: closing a dirty editor asks before discarding and sends nothing", async () => {
    const root = await mountPage("merge-fields");
    try {
      await waitFor(() => expect(document.body.textContent).toContain("FNAME"));
      await click(buttonByText("Add field"));
      await waitFor(() =>
        expect(dialog().textContent).toContain("Add merge field"),
      );
      await type(q<HTMLInputElement>('input[id$="-name"]', dialog()), "Draft");
      await click(buttonByText("Cancel", dialog()));
      await waitFor(() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"]')];
        expect(
          dialogs.some((d) =>
            d.textContent?.includes("Discard merge-field draft?"),
          ),
        ).toBe(true);
      });
      const confirm = [...document.querySelectorAll('[role="dialog"]')].find(
        (d) => d.textContent?.includes("Discard merge-field draft?"),
      )!;
      await click(buttonByText("Discard", confirm));
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      expect(mocks.apiPost).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("Webhooks (admin): create reveals the one-time secret behind a stored gate; rotate, test, deliveries and typed delete hit their routes", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    const root = await mountPage("webhooks");
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "https://hooks.example.com/postwave",
        );
      });
      expect(mocks.apiGet).toHaveBeenCalledWith(
        `${P}/webhooks`,
        expect.objectContaining({ query: { limit: 50, cursor: undefined } }),
      );

      // Create.
      await click(buttonByText("Add webhook"));
      await waitFor(() =>
        expect(dialog().textContent).toContain("Add webhook to Newsletter"),
      );
      await type(
        q<HTMLInputElement>('input[id$="-url"]', dialog()),
        "https://new.example.com/hook ",
      );
      await click(buttonByText("Add webhook", dialog()));
      await waitFor(() => {
        expect(mocks.apiPost).toHaveBeenCalledWith(
          `${P}/webhooks`,
          {
            url: "https://new.example.com/hook",
            events: ["list.subscriber.added"],
          },
          expect.objectContaining({
            requireOnline: true,
            idempotencyKey: expect.stringContaining("list-webhook-create"),
          }),
        );
      });
      expect(mocks.whoamiFresh).toHaveBeenCalled();
      // The secret is shown once, with a copy control and a stored gate.
      await waitFor(() => {
        expect(dialog().textContent).toContain("Store your signing secret");
      });
      const secretDialog = dialog();
      expect(secretDialog.textContent).toContain(SECRET);
      expect(secretDialog.textContent).toContain("shown exactly once");
      const stored = buttonByText("I've stored it securely", secretDialog);
      expect(stored.disabled).toBe(true);
      await click(buttonByText("Copy signing secret", secretDialog));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRET));
      // While the secret is up, every other webhook action is withheld.
      expect(buttonByText("Add webhook").disabled).toBe(true);
      await click(q<HTMLInputElement>('input[type="checkbox"]', secretDialog));
      expect(
        buttonByText("I've stored it securely", secretDialog).disabled,
      ).toBe(false);
      await click(buttonByText("I've stored it securely", secretDialog));
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      expect(buttonByText("Add webhook").disabled).toBe(false);

      // Rotate — the confirm names the grace window; the new secret is shown once.
      await click(
        q(
          'button[aria-label="Rotate secret for https://hooks.example.com/postwave"]',
        ),
      );
      await waitFor(() =>
        expect(dialog().textContent).toContain("24-hour grace window"),
      );
      await click(buttonByText("Rotate secret", dialog()));
      await waitFor(() => {
        expect(mocks.apiPost).toHaveBeenCalledWith(
          `${P}/webhooks/w1/rotate-secret`,
          {},
          expect.objectContaining({
            requireOnline: true,
            idempotencyKey: expect.stringContaining("list-webhook-rotate"),
          }),
        );
      });
      await waitFor(() =>
        expect(dialog().textContent).toContain(
          "whsec_rotated_0123456789abcdef",
        ),
      );
      // Discard path: explicit, and it names the consequence.
      await click(buttonByText("Discard shown secret…", dialog()));
      await waitFor(() => {
        expect(
          [...document.querySelectorAll('[role="dialog"]')].some((d) =>
            d.textContent?.includes("This value cannot be recovered"),
          ),
        ).toBe(true);
      });
      const discard = [...document.querySelectorAll('[role="dialog"]')].find(
        (d) => d.textContent?.includes("This value cannot be recovered"),
      )!;
      await click(buttonByText("Discard shown value", discard));
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );

      // Test.
      await click(
        q('button[aria-label="Test https://hooks.example.com/postwave"]'),
      );
      await waitFor(() => {
        expect(mocks.apiPost).toHaveBeenCalledWith(
          `${P}/webhooks/w1/test`,
          {},
          expect.objectContaining({ requireOnline: true }),
        );
        expect(mocks.toast.success).toHaveBeenCalledWith(
          "Test fired — the receiver answered HTTP 200.",
        );
      });

      // Pause via PATCH {active:false}.
      await click(
        q('button[aria-label="Pause https://hooks.example.com/postwave"]'),
      );
      await waitFor(() => {
        expect(mocks.apiPatch).toHaveBeenCalledWith(
          `${P}/webhooks/w1`,
          { active: false },
          expect.objectContaining({
            requireOnline: true,
            idempotencyKey: expect.stringContaining("list-webhook-update"),
          }),
        );
      });

      // Deliveries.
      await click(
        q(
          'button[aria-label="Show deliveries for https://hooks.example.com/postwave"]',
        ),
      );
      await waitFor(() => {
        expect(mocks.apiGet).toHaveBeenCalledWith(
          `${P}/webhooks/w1/deliveries`,
          expect.objectContaining({ query: { limit: 50, cursor: undefined } }),
        );
        expect(document.body.textContent).toContain("delivered");
      });

      // Delete — typed DELETE, consequence named.
      await click(
        q(
          'button[aria-label="Delete webhook https://hooks.example.com/postwave"]',
        ),
      );
      await waitFor(() =>
        expect(dialog().textContent).toContain(
          "secrets are shredded immediately",
        ),
      );
      expect(buttonByText("Delete webhook", dialog()).disabled).toBe(true);
      await type(q<HTMLInputElement>('[role="dialog"] input'), "DELETE");
      await click(buttonByText("Delete webhook", dialog()));
      await waitFor(() => {
        expect(mocks.apiDelete).toHaveBeenCalledWith(
          `${P}/webhooks/w1`,
          expect.objectContaining({
            requireOnline: true,
            idempotencyKey: expect.stringContaining("list-webhook-delete"),
          }),
        );
      });
    } finally {
      act(() => root.unmount());
      Object.defineProperty(globalThis.navigator, "clipboard", {
        value: undefined,
        configurable: true,
        writable: true,
      });
    }
  });

  it("Webhooks: authority that drifted between render and confirm refuses the rotation and sends nothing", async () => {
    // The page rendered as owner; by the time the operator confirms, the
    // fresh read says viewer mode. Nothing may be signed under stale authority.
    mocks.whoamiFresh.mockResolvedValue({ ...OWNER, viewer_mode: true });
    const root = await mountPage("webhooks");
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "https://hooks.example.com/postwave",
        );
      });
      await click(
        q(
          'button[aria-label="Rotate secret for https://hooks.example.com/postwave"]',
        ),
      );
      await waitFor(() =>
        expect(dialog().textContent).toContain("24-hour grace window"),
      );
      await click(buttonByText("Rotate secret", dialog()));
      await waitFor(() => {
        expect(q('[role="dialog"] [role="alert"]').textContent).toContain(
          "Your workspace authority changed. Nothing was written; refresh and retry.",
        );
      });
      expect(mocks.apiPost).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain(
        "Store your signing secret",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("Webhooks (editor): the tab is withheld with the reason and requests no webhook data", async () => {
    mocks.whoami.mockResolvedValue(EDITOR);
    mocks.whoamiFresh.mockResolvedValue(EDITOR);
    const root = await mountPage("webhooks");
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Admin access required");
        expect(document.body.textContent).toContain(
          "No webhook data was requested.",
        );
      });
      expect(getCalls(`${P}/webhooks`).length).toBe(0);
    } finally {
      act(() => root.unmount());
    }
  });

  it("Viewer: merge-field writes are withheld with the reason", async () => {
    mocks.whoami.mockResolvedValue(VIEWER);
    mocks.whoamiFresh.mockResolvedValue(VIEWER);
    const root = await mountPage("merge-fields");
    try {
      await waitFor(() => expect(document.body.textContent).toContain("FNAME"));
      expect(buttonByText("Add field").disabled).toBe(true);
      expect(
        q<HTMLButtonElement>('button[aria-label="Delete FNAME"]').disabled,
      ).toBe(true);
      expect(document.body.textContent).toContain(
        "Viewer access is read-only; an editor or admin can change merge fields.",
      );
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("lists index", () => {
  /** Fixture-agnostic readiness: the catalogue resolved and rows rendered. */
  async function mountIndex(): Promise<Root> {
    const { ListsAdminClient } =
      await import("@/app/(dashboard)/app/lists/lists-admin-client");
    const root = await render(createElement(ListsAdminClient));
    await waitFor(() => {
      expect(
        document.querySelectorAll('a[aria-label^="Open "]').length,
      ).toBeGreaterThan(0);
    });
    return root;
  }

  /** Engine ids of the rows the index is currently rendering, in order. */
  function renderedListIds(): number[] {
    return [
      ...document.querySelectorAll<HTMLAnchorElement>('a[aria-label^="Open "]'),
    ].map((a) => Number(a.getAttribute("href")!.replace("/app/lists/", "")));
  }

  it("shows the stat strip, a 90-day health grade per row, and suppresses the fabricated A/100 for an empty list", async () => {
    const root = await mountIndex();
    try {
      expect(q<HTMLAnchorElement>('a[href="/app/lists/7"]').textContent).toBe(
        "Newsletter",
      );
      const strip = q('[aria-label="List inventory"]').textContent ?? "";
      expect(strip).toContain("Lists2");
      expect(strip).toContain("Subscribers1,234");
      expect(strip).toContain("Public lists1");
      expect(strip).toContain("Double opt-in1");
      expect(document.body.textContent).toContain("1,234 subscribers");
      await waitFor(() => {
        expect(mocks.apiGet).toHaveBeenCalledWith(
          "/api/v1/list-health",
          expect.objectContaining({
            query: { tag: "Newsletter", window_days: 90 },
          }),
        );
        expect(
          q('[aria-label="Health grade B, score 78 of 100 for Newsletter"]')
            .textContent,
        ).toBe("B78");
        expect(
          q('[aria-label="No health data for Ghost town"]').textContent,
        ).toBe("—");
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("filters by visibility chip and pages client-side", async () => {
    mocks.apiGet.mockImplementation((path: string) =>
      path === "/api/v1/lists"
        ? Promise.resolve({
            data: Array.from({ length: 30 }, (_, i) => ({
              id: i + 1,
              name:
                i === 0
                  ? "Newsletter"
                  : i === 29
                    ? "Page two"
                    : `List ${i + 1}`,
              type: i % 3 === 0 ? "public" : "private",
              optin: "single",
              tags: [],
              description: "",
              subscriber_count: i,
            })),
          })
        : Promise.reject(new Error(`Unexpected GET ${path}`)),
    );
    const root = await mountIndex();
    try {
      // Page 1 holds the first 25 of 30; the 30th row is not rendered.
      expect(document.body.textContent).toContain("Page 1 of 2 · 30 lists");
      expect(renderedListIds()).toEqual(
        Array.from({ length: 25 }, (_, i) => i + 1),
      );
      expect(document.body.textContent).not.toContain("Page two");

      await click(q('button[aria-label="Next page"]'));
      await waitFor(() =>
        expect(document.body.textContent).toContain("Page two"),
      );
      expect(renderedListIds()).toEqual([26, 27, 28, 29, 30]);

      // The chip filters to exactly the public rows (every third).
      await click(buttonByText("Public"));
      await waitFor(() => {
        expect(document.body.textContent).toContain("Page 1 of 1 · 10 lists");
      });
      expect(renderedListIds()).toEqual([1, 4, 7, 10, 13, 16, 19, 22, 25, 28]);

      await click(buttonByText("Private"));
      await waitFor(() =>
        expect(document.body.textContent).toContain("Page 1 of 1 · 20 lists"),
      );
      expect(renderedListIds()).toEqual([
        2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 23, 24, 26, 27, 29,
        30,
      ]);
      expect(document.querySelector('a[href="/app/lists/1"]')).toBeNull();

      // Changing the chip resets paging: back on All the operator lands on
      // page 1, not stranded on the page 2 they were reading before.
      await click(buttonByText("All"));
      await waitFor(() =>
        expect(document.body.textContent).toContain("Page 1 of 2 · 30 lists"),
      );
      expect(renderedListIds()[0]).toBe(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("search sends the term to the catalogue read and Refresh re-reads it", async () => {
    const root = await mountIndex();
    try {
      expect(mocks.apiGet).toHaveBeenCalledWith(
        "/api/v1/lists",
        expect.objectContaining({ query: undefined }),
      );
      await type(q<HTMLInputElement>("#list-search"), "news");
      await waitFor(() => {
        expect(mocks.apiGet).toHaveBeenCalledWith(
          "/api/v1/lists",
          expect.objectContaining({ query: { query: "news" } }),
        );
      });
      const before = getCalls("/api/v1/lists").length;
      await click(buttonByText("Refresh"));
      await waitFor(() => {
        expect(getCalls("/api/v1/lists").length).toBeGreaterThan(before);
      });
      expect(getCalls("/api/v1/lists").at(-1)?.[1]).toMatchObject({
        query: { query: "news" },
      });
    } finally {
      act(() => root.unmount());
    }
  });
});
