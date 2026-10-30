// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Reachability of the campaigns-list and send-dialog mounts (parity rows
// campaigns-7/8/9/10/11/12/15/16/23 and campaigns-31/32/34).
//
// Each component below already has its own behaviour suite
// (components/campaign-folders-bulk, campaign-calendar-snapshot,
// campaign-send-check-rows, presend-refine-panel). What those suites cannot
// prove is that a user can REACH the component from /app/campaigns. So this
// file mounts the real page over a stubbed transport and asserts, per mount,
// the request the page issues and what it renders — never merely that a
// button exists.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";
import { importBeforeTests } from "./_wait";

const navigation = vi.hoisted(() => ({
  router: {
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  },
}));

const auth = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation.router,
  usePathname: () => "/app/campaigns",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: auth.whoami,
  whoamiFresh: auth.whoamiFresh,
}));

import { setOnlineStatusForTest } from "@/lib/online-manager";

const FOLDER_ID = "f0000000-0000-4000-8000-000000000001";
const SPRING = "c0000000-0000-4000-8000-000000000001";
const AUTUMN = "c0000000-0000-4000-8000-000000000002";
const WINTER = "c0000000-0000-4000-8000-000000000003";

function midMonthIso(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 15, 12).toISOString();
}

function campaignRows(): Record<string, unknown>[] {
  const base = {
    campaign_type: "regular",
    editor_mode: "html",
    from_name: "Moosewave",
    created_at: "2026-09-01T10:00:00Z",
  };
  return [
    {
      ...base,
      id: SPRING,
      name: "Spring launch",
      subject: "Spring is here",
      status: "draft",
      body_html: '<p>Hi <a href="https://example.com/a">shop</a></p>',
      folder_id: FOLDER_ID,
      open_rate: 0.42,
      click_rate: 0.051,
      updated_at: "2026-09-10T10:00:00Z",
    },
    {
      ...base,
      id: AUTUMN,
      name: "Autumn digest",
      subject: "Leaves",
      status: "sent",
      body_html: "<p>Autumn</p>",
      open_rate: 0.2,
      click_rate: 0.01,
      sent_at: midMonthIso(),
      updated_at: "2026-09-09T10:00:00Z",
    },
    {
      ...base,
      id: WINTER,
      name: "Winter draft",
      subject: "Snow",
      status: "draft",
      body_html: "<p>Winter</p>",
      updated_at: "2026-09-08T10:00:00Z",
    },
  ];
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const calls: Call[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<unknown> {
  const raw =
    input instanceof Request
      ? await input.clone().text()
      : typeof init?.body === "string"
        ? init.body
        : "";
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function route(method: string, path: string, body: unknown): Response {
  if (method === "GET" && path === "/api/v1/campaigns") {
    return json(200, campaignRows());
  }
  if (method === "GET" && path === "/api/v1/campaigns/count") {
    return json(200, { total: 3, by_status: { draft: 2, sent: 1 } });
  }
  if (method === "GET" && path === "/api/v1/campaigns/folders") {
    return json(200, {
      items: [{ id: FOLDER_ID, name: "Launches", campaign_count: 1 }],
    });
  }
  const folderMove = path.match(/^\/api\/v1\/campaigns\/([^/]+)\/folder$/);
  if (method === "PATCH" && folderMove) {
    const folderId = (body as { folder_id?: string } | null)?.folder_id ?? "";
    return json(200, { ok: true, folder_id: folderId });
  }
  if (method === "POST" && path === "/api/v1/campaigns/org-tags/bulk") {
    return json(200, { tag: "launch", tagged: 1 });
  }
  if (method === "POST" && /\/check-links$/.test(path)) {
    return json(200, [
      { url: "https://example.com/a", status: 200, ok: true },
      { url: "https://example.com/gone", status: 404, ok: false },
    ]);
  }
  if (method === "POST" && path === "/api/v1/a11y/check") {
    return json(200, { findings: [], counts: {}, score: 100 });
  }
  if (/\/presend-refine$/.test(path)) {
    const preview = method === "POST";
    return json(200, {
      campaign_id: SPRING,
      churn_threshold: 80,
      cooling_off_hours: 24,
      excluded_count: preview ? 7 : 0,
      cooling_off_count: preview ? 7 : 0,
      dry_run: preview,
      exclude_recently_paused: false,
      affected_subscribers_sample: [],
    });
  }
  return json(404, { error: { code: "not_found", message: "" } });
}

function stubTransport(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (
        input instanceof Request ? input.method : (init?.method ?? "GET")
      ).toUpperCase();
      const path = new URL(url, "http://postwave.test").pathname;
      const body = await readBody(input, init);
      calls.push({ method, path, body });
      return route(method, path, body);
    }),
  );
}

function callsTo(method: string, path: string | RegExp): Call[] {
  return calls.filter(
    (call) =>
      call.method === method &&
      (typeof path === "string" ? call.path === path : path.test(call.path)),
  );
}

// Time-bounded rather than turn-bounded: the send dialog is a lazy chunk, and
// its first dynamic import can take longer than any fixed number of ticks.
async function waitFor(
  assertion: () => void,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(
    root.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === text);
  if (!found) throw new Error(`Button "${text}" not found`);
  return found;
}

function buttonByLabel(root: ParentNode, label: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`Button labelled "${label}" not found`);
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
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function choose(element: HTMLSelectElement, value: string): void {
  act(() => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function typeInto(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function rowNames(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLTableRowElement>(
      '[data-testid="campaign-row"]',
    ),
  ).map((row) => row.querySelector("a")?.textContent?.trim() ?? "");
}

function rowFor(container: HTMLElement, id: string): HTMLTableRowElement {
  const row = container.querySelector<HTMLTableRowElement>(
    `[data-testid="campaign-row"][data-id="${id}"]`,
  );
  if (!row) throw new Error(`Row ${id} not found`);
  return row;
}

async function mountPage(): Promise<{
  container: HTMLElement;
  root: import("react-dom/client").Root;
}> {
  const Page = (
    await import("@/app/(dashboard)/app/campaigns/campaigns-client")
  ).CampaignsClient;
  const { container, root } = await renderPage(Page);
  await waitFor(() => expect(rowNames(container)).toHaveLength(3));
  return { container, root };
}

// The page module these tests import is cold work for vitest's transform
// pipeline; pay it before any test's 5 s clock starts.
importBeforeTests(
  () => import("@/app/(dashboard)/app/campaigns/campaigns-client"),
);

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  auth.whoami.mockResolvedValue(WHOAMI);
  auth.whoamiFresh.mockResolvedValue(WHOAMI);
  setOnlineStatusForTest("online");
  stubTransport();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("/app/campaigns list mounts", () => {
  it("campaigns-7: loads the folder list and narrows the table to the chosen folder", async () => {
    const { container, root } = await mountPage();
    try {
      await waitFor(() =>
        expect(callsTo("GET", "/api/v1/campaigns/folders")).not.toHaveLength(0),
      );
      const select = container.querySelector<HTMLSelectElement>(
        'select[aria-label="Filter by folder"]',
      );
      expect(select).not.toBeNull();
      await waitFor(() =>
        expect(
          Array.from(select!.options).map((option) => option.textContent),
        ).toEqual(["All folders", "Uncategorised", "Launches (1)"]),
      );

      choose(select!, FOLDER_ID);
      await waitFor(() =>
        expect(rowNames(container)).toEqual(["Spring launch"]),
      );
    } finally {
      unmount(root);
    }
  });

  it("campaigns-8: creates a folder from the list with a POST", async () => {
    const { container, root } = await mountPage();
    try {
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="New folder name"]',
      );
      expect(input).not.toBeNull();
      await waitFor(() => expect(input!.disabled).toBe(false));
      typeInto(input!, "Newsletters");
      await act(async () => {
        input!.form!.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() =>
        expect(callsTo("POST", "/api/v1/campaigns/folders")).toEqual([
          {
            method: "POST",
            path: "/api/v1/campaigns/folders",
            body: { name: "Newsletters" },
          },
        ]),
      );
    } finally {
      unmount(root);
    }
  });

  it("campaigns-9: the row Move action PATCHes that campaign's folder", async () => {
    const { container, root } = await mountPage();
    try {
      await click(buttonByLabel(container, "Move Spring launch to a folder"));
      await waitFor(() =>
        expect(dialog().textContent).toContain("Move “Spring launch”"),
      );
      const picker = dialog().querySelector<HTMLSelectElement>("select");
      expect(picker).not.toBeNull();
      // Filed in "Launches" today; move it back to Uncategorised.
      choose(picker!, "");
      await click(buttonByText(dialog(), "Move"));
      await waitFor(() =>
        expect(callsTo("PATCH", /\/folder$/)).toEqual([
          {
            method: "PATCH",
            path: `/api/v1/campaigns/${SPRING}/folder`,
            body: { folder_id: "" },
          },
        ]),
      );
    } finally {
      unmount(root);
    }
  });

  it("campaigns-10/11/12: the bulk bar carries Move to folder, Tag and Export CSV for the selection", async () => {
    const { container, root } = await mountPage();
    try {
      const checkbox = container.querySelector<HTMLInputElement>(
        'input[aria-label="Select Spring launch"]',
      );
      expect(checkbox).not.toBeNull();
      await click(checkbox!);
      await waitFor(() =>
        expect(container.textContent).toContain("1 selected"),
      );
      expect(buttonByText(container, "Move to folder").disabled).toBe(false);
      expect(buttonByText(container, "Export CSV")).toBeTruthy();

      await click(buttonByText(container, "Tag"));
      await waitFor(() =>
        expect(dialog().textContent).toContain("Tag 1 campaign"),
      );
      const tagInput = dialog().querySelector<HTMLInputElement>("input");
      typeInto(tagInput!, "Launch");
      await act(async () => {
        dialog()
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() =>
        expect(callsTo("POST", "/api/v1/campaigns/org-tags/bulk")).toEqual([
          {
            method: "POST",
            path: "/api/v1/campaigns/org-tags/bulk",
            body: { campaign_ids: [SPRING], tag: "launch" },
          },
        ]),
      );
    } finally {
      unmount(root);
    }
  });

  it("campaigns-15: renders open/click rates and sorts by them, unrated last", async () => {
    const { container, root } = await mountPage();
    try {
      const spring = rowFor(container, SPRING).textContent ?? "";
      expect(spring).toContain("42.0%");
      expect(spring).toContain("5.1%");
      expect(rowFor(container, WINTER).textContent).toContain("—");

      await click(buttonByLabel(container, "Sort by Open rate"));
      await waitFor(() =>
        expect(rowNames(container)).toEqual([
          "Spring launch",
          "Autumn digest",
          "Winter draft",
        ]),
      );
      await click(buttonByLabel(container, "Sort by Open rate"));
      await waitFor(() =>
        expect(rowNames(container)).toEqual([
          "Autumn digest",
          "Spring launch",
          "Winter draft",
        ]),
      );
    } finally {
      unmount(root);
    }
  });

  it("campaigns-16: Refresh re-reads the list window and the status counts", async () => {
    const { container, root } = await mountPage();
    try {
      const listReads = callsTo("GET", "/api/v1/campaigns").length;
      const countReads = callsTo("GET", "/api/v1/campaigns/count").length;
      await click(buttonByText(container, "Refresh"));
      await waitFor(() => {
        expect(callsTo("GET", "/api/v1/campaigns").length).toBeGreaterThan(
          listReads,
        );
        expect(
          callsTo("GET", "/api/v1/campaigns/count").length,
        ).toBeGreaterThan(countReads);
      });
    } finally {
      unmount(root);
    }
  });

  it("campaigns-23: switches to a read-only month calendar of the campaigns", async () => {
    const { container, root } = await mountPage();
    try {
      const calendarToggle = buttonByText(container, "Calendar");
      expect(calendarToggle.getAttribute("aria-pressed")).toBe("false");
      await click(calendarToggle);
      await waitFor(() =>
        expect(
          container.querySelector('[data-testid="campaign-calendar"]'),
        ).not.toBeNull(),
      );
      const calendar = container.querySelector<HTMLElement>(
        '[data-testid="campaign-calendar"]',
      )!;
      // The sent campaign sits on its sent day and links to its detail page.
      expect(
        calendar.querySelector(`a[href="/app/campaigns/${AUTUMN}"]`),
      ).not.toBeNull();
      expect(calendar.textContent).toContain("Schedule changes are paused.");
      expect(
        container.querySelector('[data-testid="campaign-row"]'),
      ).toBeNull();
    } finally {
      unmount(root);
    }
  });
});

describe("/app/campaigns send dialog mounts", () => {
  async function openSendDialog(container: HTMLElement): Promise<void> {
    await click(rowFor(container, SPRING));
    await click(buttonByText(container, "Send"));
    await waitFor(() =>
      expect(dialog().textContent).toContain("Send campaign"),
    );
  }

  it("campaigns-31/32: runs the accessibility lint and the link sweep for the campaign being sent", async () => {
    const { container, root } = await mountPage();
    try {
      await openSendDialog(container);
      await waitFor(() => {
        expect(
          callsTo("POST", `/api/v1/campaigns/${SPRING}/check-links`),
        ).toHaveLength(1);
        expect(callsTo("POST", "/api/v1/a11y/check")).toHaveLength(1);
      });
      expect(callsTo("POST", "/api/v1/a11y/check")[0]?.body).toEqual({
        html: '<p>Hi <a href="https://example.com/a">shop</a></p>',
        subject: "Spring is here",
      });
      await waitFor(() => {
        const checks = dialog().querySelector(
          '[data-testid="campaign-send-checks"]',
        );
        expect(checks?.textContent).toContain("Content checks");
        expect(
          checks
            ?.querySelector('[data-testid="send-check-links"]')
            ?.getAttribute("data-status"),
        ).toBe("fail");
      });
    } finally {
      unmount(root);
    }
  });

  it("campaigns-34: previews the pre-send refinement with a dry run and renders the count", async () => {
    const { container, root } = await mountPage();
    try {
      await openSendDialog(container);
      await waitFor(() => {
        expect(
          callsTo("GET", `/api/v1/campaigns/${SPRING}/presend-refine`),
        ).toHaveLength(1);
        expect(
          callsTo("POST", `/api/v1/campaigns/${SPRING}/presend-refine`)[0]
            ?.body,
        ).toEqual({
          churn_threshold: 80,
          exclude_recently_paused: false,
          dry_run: true,
        });
      });
      await waitFor(() => {
        const panel = dialog().querySelector(
          '[data-testid="presend-refine-panel"]',
        );
        expect(panel?.textContent).toContain("Audience refinement");
        expect(
          panel?.querySelector('[data-testid="presend-refine-preview"]')
            ?.textContent,
        ).toContain("7");
      });
    } finally {
      unmount(root);
    }
  });
});
