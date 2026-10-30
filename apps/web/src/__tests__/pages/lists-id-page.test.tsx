// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// /app/lists/[id] — the list detail workspace (audience-90/91/86). Every
// assertion is on the CONSEQUENCE of a verb: the request's method + path +
// body, the rendered result, or the confirm's copy.

import { act, createElement, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every tab but the overview is a next/dynamic chunk, and the workspace's
// reads import their API module on first use, so waits are on wall-clock time.
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
};
const ANN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CARA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MEMBERS_PATH = "/api/v1/lists/7/subscribers";

function membersPage(page: number) {
  return {
    list_id: LIST.postwave_uuid,
    items:
      page === 1
        ? [
            {
              id: ANN,
              // Long, template-generated addresses are what made the column
              // unreadable: every row truncated to the shared prefix.
              email: "ann-verify-check-9f2a@example.com",
              status: "enabled",
              source: "admin",
              added_at: "2026-08-01T00:00:00Z",
            },
            {
              id: BOB,
              email: "bob@example.com",
              status: "unconfirmed",
              source: "api",
              added_at: "2026-08-02T00:00:00Z",
            },
          ]
        : [
            {
              id: CARA,
              email: "page-two@example.com",
              status: "enabled",
              added_at: "2026-08-03T00:00:00Z",
            },
          ],
    total: 30,
    page,
    per_page: 25,
  };
}

function stubTransport(): void {
  mocks.apiGet.mockImplementation(
    (path: string, opts?: { query?: Record<string, unknown> }) => {
      if (path === "/api/v1/lists") return Promise.resolve({ data: [LIST] });
      if (path === MEMBERS_PATH)
        return Promise.resolve(membersPage(Number(opts?.query?.page ?? 1)));
      if (path === "/api/v1/subscribers")
        return Promise.resolve({
          items: [
            { id: BOB, email: "bob@example.com", status: "enabled" },
            { id: CARA, email: "cara@example.com", status: "enabled" },
          ],
          total: 2,
          page: 1,
          per_page: 20,
        });
      return Promise.reject(new Error(`Unexpected GET ${path}`));
    },
  );
  mocks.apiDelete.mockResolvedValue(undefined);
  mocks.apiPatch.mockResolvedValue({ data: LIST });
  mocks.apiPost.mockResolvedValue({ added: 1, skipped: 1 });
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
  // `use(params)` suspends on the first pass; the act must be awaited so the
  // resolved promise commits before anything is asserted.
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function q<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
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

async function choose(el: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
}

async function mountPage(tab: string, strict = true): Promise<Root> {
  mocks.search.current = tab ? `tab=${tab}` : "";
  const Page = (await import("@/app/(dashboard)/app/lists/[id]/page")).default;
  const page = createElement(Page, { params: Promise.resolve({ id: "7" }) });
  const root = await render(
    strict ? createElement(StrictMode, null, page) : page,
  );
  await waitFor(() => {
    expect(document.querySelector("h1")?.textContent).toBe("Newsletter");
  });
  return root;
}

// The settings tab is code-split, so its form lands on wall-clock time after
// the header has rendered; a test that only waited for the header passes only
// when an earlier test already loaded the chunk.
async function settingsForm(): Promise<HTMLInputElement> {
  await waitFor(() => {
    q('input[id$="-name"]');
  });
  return q<HTMLInputElement>('input[id$="-name"]');
}

function membersCalls(): number {
  return mocks.apiGet.mock.calls.filter(([p]) => p === MEMBERS_PATH).length;
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

describe("lists/[id] workspace", () => {
  it("renders the header from the catalogue and rewrites ?tab= when a tab is chosen", async () => {
    const root = await mountPage("");
    try {
      expect(mocks.apiGet).toHaveBeenCalledWith(
        "/api/v1/lists",
        expect.objectContaining({ query: undefined }),
      );
      expect(document.body.textContent).toContain("Weekly digest");
      expect(document.body.textContent).toContain("single opt-in");
      // Overview pulls the server-side total with a one-row page.
      expect(mocks.apiGet).toHaveBeenCalledWith(
        MEMBERS_PATH,
        expect.objectContaining({
          query: expect.objectContaining({ page: 1, per_page: 1 }),
        }),
      );
      await waitFor(() => {
        expect(document.body.textContent).toContain("30");
      });
      const membersTab = [...document.querySelectorAll('[role="tab"]')].find(
        (t) => t.textContent === "Members",
      );
      if (!membersTab) throw new Error("Missing Members tab");
      await click(membersTab);
      expect(mocks.replace).toHaveBeenCalledWith("/app/lists/7?tab=members", {
        scroll: false,
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("Members: lists the page, then narrows by search + status and pages", async () => {
    const root = await mountPage("members");
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("@example.com");
      });
      expect(mocks.apiGet).toHaveBeenCalledWith(
        MEMBERS_PATH,
        expect.objectContaining({
          query: expect.objectContaining({
            page: 1,
            per_page: 25,
            query: undefined,
            status: undefined,
          }),
        }),
      );
      expect(document.body.textContent).toContain("Page 1 of 2");

      await type(q<HTMLInputElement>('input[id$="-search"]'), "ann");
      await settle(260);
      await choose(
        q<HTMLSelectElement>('select[aria-label="Filter by status"]'),
        "enabled",
      );
      await waitFor(() => {
        expect(mocks.apiGet).toHaveBeenCalledWith(
          MEMBERS_PATH,
          expect.objectContaining({
            query: expect.objectContaining({
              query: "ann",
              status: "enabled",
              page: 1,
              per_page: 25,
            }),
          }),
        );
      });

      await click(q('button[aria-label="Next page"]'));
      await waitFor(() => {
        expect(mocks.apiGet).toHaveBeenCalledWith(
          MEMBERS_PATH,
          expect.objectContaining({
            query: expect.objectContaining({
              page: 2,
              query: "ann",
              status: "enabled",
            }),
          }),
        );
        expect(document.body.textContent).toContain("page-two@example.com");
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("Members: says who added each contact and keeps long addresses apart", async () => {
    const root = await mountPage("members");
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("@example.com");
      });
      const rows = [...document.querySelectorAll("tbody tr")];
      const annRow = rows.find((row) =>
        row.textContent?.includes("ann-verify-check-9f2a"),
      );
      const bobRow = rows.find((row) =>
        row.textContent?.includes("bob@example.com"),
      );
      if (!annRow || !bobRow) throw new Error("member rows not rendered");

      // The column used to print the wire value. An operator who had just
      // pressed Add saw "api"; now the two callers read as what they are.
      expect(annRow.textContent).toContain("Operator");
      expect(annRow.textContent).not.toContain("admin");
      expect(bobRow.textContent).toContain("API");
      // ...and the label explains itself on hover.
      expect(
        annRow.querySelector(
          '[title="Added by someone working in this workspace"]',
        ),
      ).not.toBeNull();

      // The address is middle-truncated: the head is the shrinkable half and
      // the tail always renders, so two rows generated from one template stay
      // distinguishable — with the whole value available on hover.
      const emailCell = annRow.querySelector("td");
      const full = emailCell?.querySelector(
        '[title="ann-verify-check-9f2a@example.com"]',
      );
      expect(full).not.toBeNull();
      const parts = [...(full?.querySelectorAll("span") ?? [])].map(
        (span) => span.textContent ?? "",
      );
      expect(parts.join("")).toBe("ann-verify-check-9f2a@example.com");
      expect(parts.at(-1)).toBe("f2a@example.com".slice(1));
    } finally {
      act(() => root.unmount());
    }
  });

  it("Members: the remove confirm names its consequence, then DELETEs that member and refetches", async () => {
    const root = await mountPage("members");
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("@example.com");
      });
      const before = membersCalls();
      await click(
        q(
          'button[aria-label="Remove ann-verify-check-9f2a@example.com from Newsletter"]',
        ),
      );
      await waitFor(() => {
        const dialog = q('[role="dialog"]');
        expect(dialog.textContent).toContain(
          "ann-verify-check-9f2a@example.com will be removed from Newsletter",
        );
        expect(dialog.textContent).toContain(
          "subscriber record itself is kept",
        );
      });
      expect(mocks.apiDelete).not.toHaveBeenCalled();

      await click(buttonByText("Remove", q('[role="dialog"]')));
      await waitFor(() => {
        expect(mocks.apiDelete).toHaveBeenCalledWith(
          `/api/v1/lists/7/subscribers/${ANN}`,
          expect.objectContaining({
            requireOnline: true,
            idempotencyKey: expect.stringContaining("list-member-remove"),
          }),
        );
      });
      expect(mocks.whoamiFresh).toHaveBeenCalled();
      await waitFor(() => {
        expect(mocks.toast.success).toHaveBeenCalledWith(
          expect.stringContaining(
            "ann-verify-check-9f2a@example.com is no longer on Newsletter",
          ),
        );
        expect(membersCalls()).toBeGreaterThan(before);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("Members: the picker browses GET /subscribers, POSTs the selection and reports the server's counts verbatim", async () => {
    const root = await mountPage("members", true);
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("@example.com");
      });
      await click(buttonByText("Add subscribers"));
      await waitFor(() => {
        expect(mocks.apiGet).toHaveBeenCalledWith(
          "/api/v1/subscribers",
          expect.objectContaining({
            query: expect.objectContaining({ page: 1, per_page: 20 }),
          }),
        );
        expect(q('[role="dialog"]').textContent).toContain("cara@example.com");
      });
      expect(buttonByText("Add", q('[role="dialog"]')).disabled).toBe(true);

      await click(q('input[aria-label="Select bob@example.com"]'));
      await click(q('input[aria-label="Select cara@example.com"]'));
      await click(buttonByText("Add (2)", q('[role="dialog"]')));

      await waitFor(() => {
        expect(mocks.apiPost).toHaveBeenCalledWith(
          MEMBERS_PATH,
          { subscriber_ids: [BOB, CARA] },
          expect.objectContaining({
            requireOnline: true,
            idempotencyKey: expect.stringContaining("list-members-add"),
          }),
        );
      });
      await waitFor(() => {
        expect(mocks.toast.success).toHaveBeenCalledWith(
          "1 added, 1 skipped on Newsletter.",
        );
        expect(document.querySelector('[role="dialog"]')).toBeNull();
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("Settings: saves rename / visibility / opt-in / tags / description as the whitelisted PATCH after a fresh identity read", async () => {
    const root = await mountPage("settings");
    try {
      const name = await settingsForm();
      expect(name.value).toBe("Newsletter");
      expect(buttonByText("Save changes").disabled).toBe(true);

      await type(name, "Newsletter EU");
      await choose(q<HTMLSelectElement>('select[id$="-type"]'), "public");
      await choose(q<HTMLSelectElement>('select[id$="-optin"]'), "double");
      await type(q<HTMLInputElement>('input[id$="-tags"]'), "vip, eu, ");
      await type(
        q<HTMLTextAreaElement>('textarea[id$="-description"]'),
        "Weekly digest for EU ",
      );
      expect(buttonByText("Save changes").disabled).toBe(false);

      await click(buttonByText("Save changes"));
      await waitFor(() => {
        expect(mocks.apiPatch).toHaveBeenCalledWith(
          "/api/v1/lists/7",
          {
            name: "Newsletter EU",
            type: "public",
            optin: "double",
            description: "Weekly digest for EU",
            tags: ["vip", "eu"],
          },
          expect.objectContaining({
            requireOnline: true,
            idempotencyKey: expect.stringContaining("list-update"),
          }),
        );
      });
      expect(mocks.whoamiFresh).toHaveBeenCalled();
      await waitFor(() => {
        expect(mocks.toast.success).toHaveBeenCalledWith(
          'List "Newsletter EU" updated',
        );
        // The acknowledged draft becomes the new baseline.
        expect(buttonByText("Save changes").disabled).toBe(true);
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("Settings: a stale identity refuses the write and nothing is sent", async () => {
    mocks.whoamiFresh.mockResolvedValue({
      ...OWNER,
      tenant_id: "99999999-9999-4999-8999-999999999999",
    });
    const root = await mountPage("settings");
    try {
      await settingsForm();
      await type(q<HTMLInputElement>('input[id$="-name"]'), "Renamed");
      await click(buttonByText("Save changes"));
      await waitFor(() => {
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "Your workspace authority changed",
        );
      });
      expect(mocks.apiPatch).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("Viewer: membership and settings verbs are withheld with the reason, and Delete is not offered", async () => {
    mocks.whoami.mockResolvedValue(VIEWER);
    mocks.whoamiFresh.mockResolvedValue(VIEWER);
    let root = await mountPage("members");
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("@example.com");
      });
      expect(
        q<HTMLButtonElement>(
          'button[aria-label="Remove ann-verify-check-9f2a@example.com from Newsletter"]',
        ).disabled,
      ).toBe(true);
      expect(buttonByText("Add subscribers").disabled).toBe(true);
      expect(document.body.textContent).toContain(
        "Admin role required to change list membership.",
      );
      expect(
        [...document.querySelectorAll("button")].some(
          (b) => b.textContent?.trim() === "Delete",
        ),
      ).toBe(false);
    } finally {
      act(() => root.unmount());
      document.body.innerHTML = "";
    }

    root = await mountPage("settings");
    try {
      await settingsForm();
      expect(buttonByText("Save changes").disabled).toBe(true);
      expect(q<HTMLInputElement>('input[id$="-name"]').disabled).toBe(true);
      expect(document.body.textContent).toContain(
        "Viewer access is read-only; an editor or admin can change list settings.",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("Header: Delete asks for the exact name and then DELETEs the list and leaves the page", async () => {
    const root = await mountPage("");
    try {
      await click(buttonByText("Delete"));
      await waitFor(() => {
        expect(q('[role="dialog"]').textContent).toContain(
          'permanently deletes "Newsletter" and every membership in it',
        );
      });
      const confirm = buttonByText("Delete list", q('[role="dialog"]'));
      expect(confirm.disabled).toBe(true);
      await type(q<HTMLInputElement>('[role="dialog"] input'), "Newsletter");
      await click(buttonByText("Delete list", q('[role="dialog"]')));
      await waitFor(() => {
        expect(mocks.apiDelete).toHaveBeenCalledWith(
          "/api/v1/lists/7",
          expect.objectContaining({ requireOnline: true }),
        );
        expect(mocks.push).toHaveBeenCalledWith("/app/lists");
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("handles an unknown id and a malformed id without inventing a record", async () => {
    mocks.apiGet.mockImplementation((path: string) =>
      path === "/api/v1/lists"
        ? Promise.resolve({ data: [] })
        : Promise.reject(new Error(`Unexpected GET ${path}`)),
    );
    const Page = (await import("@/app/(dashboard)/app/lists/[id]/page"))
      .default;
    mocks.search.current = "";
    let root = await render(
      createElement(Page, { params: Promise.resolve({ id: "7" }) }),
    );
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("List not found");
      });
      expect(mocks.apiGet).not.toHaveBeenCalledWith(
        MEMBERS_PATH,
        expect.anything(),
      );
    } finally {
      act(() => root.unmount());
      document.body.innerHTML = "";
    }
    mocks.apiGet.mockClear();
    root = await render(
      createElement(Page, { params: Promise.resolve({ id: "../x" }) }),
    );
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Invalid list link");
      });
      expect(mocks.apiGet).not.toHaveBeenCalledWith(
        "/api/v1/lists",
        expect.anything(),
      );
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("lists index", () => {
  it("can edit after creating a list under StrictMode", async () => {
    const { ListsAdminClient } =
      await import("@/app/(dashboard)/app/lists/lists-admin-client");
    mocks.apiPost.mockResolvedValue({
      data: { ...LIST, id: 8, name: "QA list" },
    });
    const root = await render(
      createElement(StrictMode, null, createElement(ListsAdminClient)),
    );
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain("Newsletter"),
      );
      await click(buttonByText("Create list"));
      await type(q<HTMLInputElement>("#list-name"), "QA list");
      await click(buttonByText("Save"));
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      await click(q('button[aria-label="Edit Newsletter"]'));
      expect(buttonByText("Save").disabled).toBe(false);
      await type(
        q<HTMLTextAreaElement>("#list-description"),
        "Updated after creating another list",
      );
      await click(buttonByText("Save"));
      await waitFor(() =>
        expect(mocks.apiPatch).toHaveBeenCalledWith(
          "/api/v1/lists/7",
          expect.objectContaining({
            description: "Updated after creating another list",
          }),
          expect.objectContaining({
            requireOnline: true,
            idempotencyKey: expect.any(String),
          }),
        ),
      );
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("links each row to its detail workspace", async () => {
    const { ListsAdminClient } =
      await import("@/app/(dashboard)/app/lists/lists-admin-client");
    const root = await render(createElement(ListsAdminClient));
    try {
      await waitFor(() => {
        const link = document.querySelector<HTMLAnchorElement>(
          'a[href="/app/lists/7"]',
        );
        expect(link?.textContent).toBe("Newsletter");
      });
      expect(
        document
          .querySelector('a[aria-label="Open Newsletter"]')
          ?.getAttribute("href"),
      ).toBe("/app/lists/7");
    } finally {
      act(() => root.unmount());
    }
  });
});
