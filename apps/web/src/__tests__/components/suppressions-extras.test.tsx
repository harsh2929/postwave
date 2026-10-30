// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Desktop→web parity for the suppression surfaces (audience-114/118/121/122
// on /app/suppressions, audience-128/129 on the consent-evidence customer push
// registry). Every case asserts the CONSEQUENCE of the verb — the request's
// method/path/body via the api module the page calls, the rendered outcome,
// or the file that reaches the download helper — not that a control exists.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as SuppressionsApi from "@/lib/suppressions-admin-api";
import type { SuppressionEntry } from "@/lib/suppressions-admin-api";
import type * as PushApi from "@/lib/push-suppressions-api";
import type * as AdminGateModule from "@/lib/use-admin-gate";
import type { MeResponse } from "@/lib/auth-api";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  useAdminGate: vi.fn(),
  listSuppressions: vi.fn(),
  getSuppressionTrend: vi.fn(),
  getSuppressionTimeline: vi.fn(),
  importSuppressionsCsv: vi.fn(),
  removeSuppression: vi.fn(),
  listSuppressionAudit: vi.fn(),
  listPushSuppressions: vi.fn(),
  downloadTextFile: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  toastInfo: vi.fn(),
  online: "online" as "online" | "connecting" | "offline",
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

// The page mirrors list state into the URL and reconciles back out of it. A
// no-op router mock makes the mirror lose every write on the next reconcile,
// so the stub actually moves the address bar the way the real router does.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: (url: string) => window.history.replaceState(null, "", url),
    push: (url: string) => window.history.pushState(null, "", url),
    back: vi.fn(),
  }),
  usePathname: () => "/app/suppressions",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("@/lib/suppressions-admin-api", async (importOriginal) => ({
  ...(await importOriginal<typeof SuppressionsApi>()),
  listSuppressions: mocks.listSuppressions,
  getSuppressionTrend: mocks.getSuppressionTrend,
  getSuppressionTimeline: mocks.getSuppressionTimeline,
  importSuppressionsCsv: mocks.importSuppressionsCsv,
  removeSuppression: mocks.removeSuppression,
  listSuppressionAudit: mocks.listSuppressionAudit,
}));

vi.mock("@/lib/push-suppressions-api", async (importOriginal) => ({
  ...(await importOriginal<typeof PushApi>()),
  listPushSuppressions: mocks.listPushSuppressions,
}));

vi.mock("@/lib/use-admin-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof AdminGateModule>()),
  useAdminGate: mocks.useAdminGate,
}));

vi.mock("@/lib/download", () => ({
  downloadTextFile: mocks.downloadTextFile,
  downloadBlobFile: vi.fn(),
}));

vi.mock("@/lib/use-online", () => ({ useOnline: () => mocks.online }));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
    info: mocks.toastInfo,
  },
}));

import SuppressionsPage from "@/app/(dashboard)/app/suppressions/page-client";
import { PushSuppressionsManager } from "@/app/(dashboard)/app/consent-evidence/push-suppressions-manager";
import { api } from "@/lib/api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Fixtures. Timestamps are anchored to the real clock so the "New · 7d" bucket
// and the date-range bounds stay deterministic without faking timers (the
// page's 350 ms search debounce runs on real ones).
// ---------------------------------------------------------------------------

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const localDay = (msAgo: number): string => {
  const date = new Date(NOW - msAgo);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};

const HARD: SuppressionEntry = {
  id: "sup_hard",
  email: "bounced@example.com",
  reason: "hard_bounce",
  source: "ses",
  created_at: iso(2 * DAY),
};
const MANUAL: SuppressionEntry = {
  id: "sup_manual",
  email: "held@example.com",
  reason: "list_manual",
  source: "operator",
  created_at: iso(60 * DAY),
};
const TRAP: SuppressionEntry = {
  id: "sup_trap",
  email: "trap@example.com",
  reason: "spamtrap",
  source: "ses",
  created_at: iso(3 * DAY),
};
const ROWS = [HARD, MANUAL, TRAP];

const TENANT = "11111111-1111-4111-8111-111111111111";
const PUSH_ID = "33333333-3333-4333-8333-333333333333";

function pushRow(over: Record<string, unknown> = {}) {
  return {
    id: PUSH_ID,
    tenantId: TENANT,
    fingerprint: "0123456789abcdef",
    platform: "apns" as const,
    reason: "manual" as const,
    source: "dashboard" as const,
    createdAt: "2026-08-29T09:00:00Z",
    updatedAt: "2026-08-29T09:30:00Z",
    version: 3,
    reversible: true,
    ...over,
  };
}

function pushPage(items = [pushRow()]) {
  return {
    tenantId: TENANT,
    items,
    total: items.length,
    snapshotAt: "2026-08-29T10:00:00Z",
  };
}

function me(over: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: "usr_admin",
    tenant_id: TENANT,
    email: "admin@example.test",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Workspace",
    workspace_slug: "workspace",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const roots: Root[] = [];

function render(ui: ReactNode): {
  container: HTMLElement;
  client: QueryClient;
} {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, networkMode: "always" },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return { container, client };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await settle();
    }
  }
  throw last;
}

function buttons(
  label: string,
  scope: ParentNode = document,
): HTMLButtonElement[] {
  return Array.from(scope.querySelectorAll("button")).filter(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === label,
  );
}

function button(
  label: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const found = buttons(label, scope)[0];
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

/** The open dialog whose accessible content includes `text`. */
function dialogWith(text: string): HTMLElement {
  const found = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"]'),
  ).find((candidate) => candidate.textContent?.includes(text));
  if (!found) throw new Error(`No dialog containing: ${text}`);
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await settle();
  });
}

function setValue(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function emailRows(): string[] {
  return Array.from(document.querySelectorAll("tbody tr")).map(
    (row) => row.querySelector("td:nth-child(2)")?.textContent?.trim() ?? "",
  );
}

function stat(name: string): string {
  const node = document.querySelector(`[data-stat="${name}"]`);
  if (!node) throw new Error(`No stat card: ${name}`);
  return node.textContent?.trim() ?? "";
}

async function renderSuppressions(canWrite = true): Promise<void> {
  mocks.useAdminGate.mockReturnValue({
    role: canWrite ? "admin" : "viewer",
    canWrite,
    loading: false,
  });
  render(createElement(SuppressionsPage));
  await eventually(() => {
    expect(document.body.textContent).toContain("bounced@example.com");
  });
}

async function renderPushRegistry(): Promise<QueryClient> {
  const { client } = render(
    createElement(PushSuppressionsManager, {
      me: me(),
      authPending: false,
      authError: false,
      authFetching: false,
      onRetryAuth: vi.fn(),
    }),
  );
  await eventually(() => {
    expect(document.body.textContent).toContain("0123456789abcdef");
  });
  return client;
}

beforeEach(() => {
  mocks.online = "online";
  for (const value of Object.values(mocks)) {
    if (typeof value === "function" && "mockReset" in value) value.mockReset();
  }
  mocks.whoami.mockResolvedValue(me());
  mocks.listSuppressions.mockResolvedValue({
    items: ROWS,
    total: 412,
    page: 1,
    size: 100,
  });
  mocks.getSuppressionTrend.mockResolvedValue([]);
  mocks.listSuppressionAudit.mockResolvedValue([]);
  mocks.listPushSuppressions.mockResolvedValue(pushPage());
  window.history.replaceState(null, "", "/app/suppressions");
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

// ---------------------------------------------------------------------------
// Transport contract. The page-level cases above stop at the api module, so
// these pin the method, path, and body the module actually puts on the wire.
// `importActual` bypasses this file's own module mock while keeping the real
// `api` object, which the spies below intercept.
// ---------------------------------------------------------------------------

async function realSuppressionsApi(): Promise<typeof SuppressionsApi> {
  return vi.importActual<typeof SuppressionsApi>(
    "@/lib/suppressions-admin-api",
  );
}

describe("suppression transport contract", () => {
  it("POSTs the CSV as multipart to /api/v1/suppressions/import, unretried", async () => {
    const postRaw = vi.spyOn(api, "postRaw").mockResolvedValue({
      inserted: 5,
      existing: 1,
      skipped: 0,
      errors: 0,
      bytes_read: 64,
    });
    try {
      const lib = await realSuppressionsApi();
      const file = new File(["email\na@example.com\n"], "holds.csv", {
        type: "text/csv",
      });
      const result = await lib.importSuppressionsCsv(file, "role_account");

      expect(postRaw).toHaveBeenCalledTimes(1);
      const [path, body, options] = postRaw.mock.calls[0] as [
        string,
        FormData,
        { maxAttempts?: number; requireOnline?: boolean },
      ];
      expect(path).toBe("/api/v1/suppressions/import");
      expect(body).toBeInstanceOf(FormData);
      expect(body.get("file")).toBeInstanceOf(File);
      expect((body.get("file") as File).name).toBe("holds.csv");
      expect(body.get("default_reason")).toBe("role_account");
      // A re-sent upload is a second import, so it must never be retried.
      expect(options.maxAttempts).toBe(1);
      expect(options.requireOnline).toBe(true);
      expect(result).toMatchObject({ inserted: 5, existing: 1 });
    } finally {
      postRaw.mockRestore();
    }
  });

  it("refuses an oversize file before any request is made", async () => {
    const postRaw = vi.spyOn(api, "postRaw");
    try {
      const lib = await realSuppressionsApi();
      const file = new File(["x"], "holds.csv", { type: "text/csv" });
      Object.defineProperty(file, "size", { value: 26 * 1024 * 1024 });
      await expect(lib.importSuppressionsCsv(file)).rejects.toThrow(/25 MiB/u);
      expect(postRaw).not.toHaveBeenCalled();
    } finally {
      postRaw.mockRestore();
    }
  });

  it("GETs /api/v1/suppressions/{id}/timeline with the id encoded", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({
      suppression: {
        id: "sup/1",
        email: "blocked@example.com",
        created_at: iso(0),
        reason: "hard_bounce",
        expires_at: null,
      },
      audit: [
        {
          id: "aud_1",
          action: "suppressed",
          source_table: "bounce_events",
          created_at: iso(0),
        },
      ],
    });
    try {
      const lib = await realSuppressionsApi();
      const timeline = await lib.getSuppressionTimeline("sup/1");

      expect(get).toHaveBeenCalledTimes(1);
      expect(get.mock.calls[0]?.[0]).toBe(
        "/api/v1/suppressions/sup%2F1/timeline",
      );
      expect(timeline.suppression.email).toBe("blocked@example.com");
      // The timeline route names the origin `source_table`; the paged audit
      // route names it `source`. One normaliser has to fold them together.
      expect(timeline.audit[0]?.source).toBe("bounce_events");
    } finally {
      get.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// audience-114 — POST /api/v1/suppressions/import (multipart, 25 MiB cap)
// ---------------------------------------------------------------------------

describe("audience-114 · suppression CSV import", () => {
  it("uploads the picked file with the chosen default reason and renders the server's counts", async () => {
    mocks.importSuppressionsCsv.mockResolvedValue({
      inserted: 12,
      existing: 3,
      skipped: 1,
      errors: 2,
      bad_rows: ["row 7: not-an-email"],
      bytes_read: 2048,
    });
    await renderSuppressions();

    await click(button("Import CSV"));
    const picker =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(picker).not.toBeNull();

    const file = new File(
      ["email,reason\na@example.com,list_manual\n"],
      "holds.csv",
      {
        type: "text/csv",
      },
    );
    Object.defineProperty(picker!, "files", {
      value: [file],
      configurable: true,
    });
    await act(async () => {
      picker!.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    });

    const reason = document.querySelector<HTMLSelectElement>(
      '[role="dialog"] select',
    );
    await act(async () => {
      setValue(reason!, "manual_unsubscribe");
      await settle();
    });

    const before = mocks.listSuppressions.mock.calls.length;
    await click(button("Upload and import"));

    await eventually(() => {
      expect(mocks.importSuppressionsCsv).toHaveBeenCalledWith(
        file,
        "manual_unsubscribe",
      );
    });
    await eventually(() => {
      const dialog = dialogWith("Import complete.");
      expect(dialog.textContent).toContain("12");
      expect(dialog.textContent).toContain("row 7: not-an-email");
      expect(dialog.textContent).toContain("2.0 KB");
    });
    // The verb changed server state, so the list must be re-read.
    await eventually(() => {
      expect(mocks.listSuppressions.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it("refuses a file the server would reject and sends nothing", async () => {
    await renderSuppressions();
    await click(button("Import CSV"));
    const picker =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    const oversize = new File(["x"], "holds.csv", { type: "text/csv" });
    Object.defineProperty(oversize, "size", { value: 26 * 1024 * 1024 });
    Object.defineProperty(picker!, "files", {
      value: [oversize],
      configurable: true,
    });
    await act(async () => {
      picker!.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    });

    expect(document.body.textContent).toContain("the limit is 25 MiB");
    expect(button("Upload and import").disabled).toBe(true);
    expect(mocks.importSuppressionsCsv).not.toHaveBeenCalled();
  });

  it("withholds the import control from a read-only caller", async () => {
    await renderSuppressions(false);
    expect(buttons("Import CSV")).toHaveLength(0);
    expect(buttons("Refresh")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// audience-118 — server exact/prefix search, date-added range, refresh
// ---------------------------------------------------------------------------

describe("audience-118 · search classification, date range, refresh", () => {
  it("sends a full address as email= and a ≥3-character fragment as q=", async () => {
    await renderSuppressions();
    expect(mocks.listSuppressions).toHaveBeenNthCalledWith(1, {
      page: 1,
      size: 100,
    });

    const search = document.querySelector<HTMLInputElement>(
      'input[placeholder="Search by email…"]',
    );
    await act(async () => {
      setValue(search!, "Bounced@Example.com");
      await new Promise((resolve) => window.setTimeout(resolve, 400));
      await settle();
    });
    await eventually(() => {
      expect(mocks.listSuppressions).toHaveBeenCalledWith({
        email: "bounced@example.com",
        page: 1,
        size: 100,
      });
    });
    expect(document.body.textContent).toContain(
      "Exact-match search across the whole suppression store.",
    );

    await act(async () => {
      setValue(search!, "bounce");
      await new Promise((resolve) => window.setTimeout(resolve, 400));
      await settle();
    });
    await eventually(() => {
      expect(mocks.listSuppressions).toHaveBeenCalledWith({
        q: "bounce",
        page: 1,
        size: 100,
      });
    });
    expect(document.body.textContent).toContain("Prefix search across");
  });

  it("keeps a 1–2 character fragment off the server and narrows the loaded page instead", async () => {
    await renderSuppressions();
    const before = mocks.listSuppressions.mock.calls.length;
    const search = document.querySelector<HTMLInputElement>(
      'input[placeholder="Search by email…"]',
    );
    await act(async () => {
      setValue(search!, "tr");
      await new Promise((resolve) => window.setTimeout(resolve, 400));
      await settle();
    });

    await eventually(() => {
      expect(emailRows()).toEqual(["trap@example.com"]);
    });
    expect(mocks.listSuppressions.mock.calls.length).toBe(before);
    expect(
      mocks.listSuppressions.mock.calls.some((call) => {
        const options = (call as readonly unknown[])[0] as
          | Record<string, unknown>
          | undefined;
        return options?.q === "tr" || options?.email === "tr";
      }),
    ).toBe(false);
    expect(document.body.textContent).toContain(
      "Too short for a server search",
    );
  });

  it("filters by date added without issuing a request, and clears back", async () => {
    await renderSuppressions();
    const before = mocks.listSuppressions.mock.calls.length;

    await click(button("Added: Any time"));
    const panel = dialogWith("Filter by date added");
    const from =
      panel.querySelectorAll<HTMLInputElement>('input[type="date"]')[0];
    await act(async () => {
      setValue(from!, localDay(30 * DAY));
      await settle();
    });
    await click(button("Apply", panel));

    await eventually(() => {
      expect(emailRows().sort()).toEqual([
        "bounced@example.com",
        "trap@example.com",
      ]);
    });
    expect(mocks.listSuppressions.mock.calls.length).toBe(before);
    expect(document.body.textContent).toContain(
      `Added: From ${localDay(30 * DAY)}`,
    );

    await click(button(`Added: From ${localDay(30 * DAY)}`));
    await click(button("Clear", dialogWith("Filter by date added")));
    await eventually(() => {
      expect(emailRows()).toHaveLength(3);
    });
  });

  it("refreshes the list and the trend on demand", async () => {
    await renderSuppressions();
    const listBefore = mocks.listSuppressions.mock.calls.length;
    const trendBefore = mocks.getSuppressionTrend.mock.calls.length;

    await click(button("Refresh"));

    await eventually(() => {
      expect(mocks.listSuppressions.mock.calls.length).toBeGreaterThan(
        listBefore,
      );
      expect(mocks.getSuppressionTrend.mock.calls.length).toBeGreaterThan(
        trendBefore,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// audience-121 — GET /api/v1/suppressions/{id}/timeline (+ audit, remove)
// ---------------------------------------------------------------------------

describe("audience-121 · suppression row detail", () => {
  it("reads the clicked row's timeline by id and renders its audit trail", async () => {
    mocks.getSuppressionTimeline.mockResolvedValue({
      suppression: {
        ...TRAP,
        bounce_category: "permanent",
        source_event_id: "evt_9001",
      },
      audit: [
        {
          id: "aud_1",
          action: "auto_suppressed",
          reason: "spamtrap",
          source: "ses_feedback",
          actor: "system",
          created_at: iso(3 * DAY),
        },
      ],
    });
    await renderSuppressions();

    // Deliberately not the first row: a detail wired to the wrong entry would
    // still look right if only row one were ever opened.
    const trigger = document.querySelector<HTMLButtonElement>(
      '[aria-label="Open details for trap@example.com"]',
    );
    expect(trigger).not.toBeNull();
    await click(trigger!);

    await eventually(() => {
      expect(mocks.getSuppressionTimeline).toHaveBeenCalledWith("sup_trap");
    });
    expect(mocks.getSuppressionTimeline).not.toHaveBeenCalledWith("sup_hard");
    await eventually(() => {
      const dialog = dialogWith("Suppression detail and timeline");
      expect(dialog.textContent).toContain("trap@example.com");
      expect(dialog.textContent).toContain("permanent");
      expect(dialog.textContent).toContain("evt_9001");
      expect(dialog.textContent).toContain("auto suppressed");
      expect(dialog.textContent).toContain("Source: ses_feedback");
    });
  });

  it("removes the address from the detail and re-reads the list", async () => {
    mocks.getSuppressionTimeline.mockResolvedValue({
      suppression: HARD,
      audit: [],
    });
    mocks.removeSuppression.mockResolvedValue(undefined);
    await renderSuppressions();

    await click(button("Details"));
    await eventually(() =>
      expect(mocks.getSuppressionTimeline).toHaveBeenCalled(),
    );
    const before = mocks.listSuppressions.mock.calls.length;

    await click(button("Remove suppression"));
    const confirm = await (async () => {
      await eventually(() => dialogWith("Remove bounced@example.com?"));
      return dialogWith("Remove bounced@example.com?");
    })();
    expect(confirm.textContent).toContain(
      "Moosewave may email this address again after removal",
    );
    await click(button("Remove", confirm));

    await eventually(() => {
      expect(mocks.removeSuppression).toHaveBeenCalledWith(
        "bounced@example.com",
      );
      expect(mocks.listSuppressions.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it("withholds the remove verb inside the detail for a read-only caller", async () => {
    mocks.getSuppressionTimeline.mockResolvedValue({
      suppression: HARD,
      audit: [],
    });
    await renderSuppressions(false);

    await click(button("Details"));
    await eventually(() =>
      expect(mocks.getSuppressionTimeline).toHaveBeenCalled(),
    );
    expect(buttons("Remove suppression")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// audience-122 — stat strip over the loaded rows
// ---------------------------------------------------------------------------

describe("audience-122 · suppression stat strip", () => {
  it("shows the server total and buckets the loaded rows", async () => {
    await renderSuppressions();

    expect(stat("total")).toBe("412");
    // hard_bounce + spamtrap, from the three loaded rows.
    expect(stat("bounces")).toBe("2");
    expect(stat("complaints")).toBe("0");
    // Two rows landed inside the trailing seven days; the 60-day-old one did not.
    expect(stat("added-7d")).toBe("2");
    expect(document.body.textContent).toContain(
      "Breakdown covers the 3 loaded rows",
    );
  });

  it("says the breakdown is scoped when a reason filter narrows the rows", async () => {
    await renderSuppressions();
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Filter by reason"]',
    );
    await act(async () => {
      setValue(select!, "hard_bounce");
      await settle();
    });

    await eventually(() => {
      expect(stat("total")).toBe("1");
      expect(stat("bounces")).toBe("1");
    });
    expect(document.body.textContent).toContain(
      "Filtered to “Hard bounce” on this page",
    );
  });
});

// ---------------------------------------------------------------------------
// audience-128 — client-side CSV export of the verified push page
// ---------------------------------------------------------------------------

describe("audience-128 · push suppression fingerprint export", () => {
  it("writes fingerprints-only CSV for the loaded verified rows", async () => {
    await renderPushRegistry();

    await click(button("Export verified rows (CSV)"));

    expect(mocks.downloadTextFile).toHaveBeenCalledTimes(1);
    const [filename, csv, mime] = mocks.downloadTextFile.mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(filename).toMatch(
      /^push-suppressions-fingerprints-\d{4}-\d{2}-\d{2}\.csv$/u,
    );
    expect(mime).toBe("text/csv;charset=utf-8");
    const lines = csv.replace(/^﻿/u, "").trim().split("\r\n");
    expect(lines[0]).toBe(
      "fingerprint,platform,reason,source,created_at,updated_at,version,reversible,locked_reason",
    );
    expect(lines[1]).toBe(
      "0123456789abcdef,apns,manual,dashboard,2026-08-29T09:00:00Z,2026-08-29T09:30:00Z,3,true,",
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Exported 1 verified row with fingerprints only",
      expect.objectContaining({
        description: expect.stringContaining("Raw device tokens"),
      }),
    );
  });

  it("locks the export while the roster is refetching, even though rows are on screen", async () => {
    const client = await renderPushRegistry();
    expect(button("Export verified rows (CSV)").disabled).toBe(false);

    const pending = deferred<ReturnType<typeof pushPage>>();
    mocks.listPushSuppressions.mockReturnValueOnce(pending.promise);
    await act(async () => {
      void client.invalidateQueries({
        queryKey: ["consent-evidence", "push-registry"],
      });
      await settle();
    });

    await eventually(() => {
      // Rows are still painted, but they are orientation only until a
      // complete current response verifies again — so is any file made of them.
      expect(document.body.textContent).toContain("0123456789abcdef");
      expect(document.body.textContent).toContain("Rows are orientation only");
      expect(button("Export verified rows (CSV)").disabled).toBe(true);
    });
    expect(mocks.downloadTextFile).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(pushPage());
      await settle();
    });
    await eventually(() => {
      expect(button("Export verified rows (CSV)").disabled).toBe(false);
    });
  });

  it("offers no export at all when the registry could not be verified", async () => {
    // An unverifiable roster is orientation only; a file written from it would
    // read as a record of a registry the client cannot vouch for.
    mocks.listPushSuppressions.mockRejectedValue(new Error("network"));
    render(
      createElement(PushSuppressionsManager, {
        me: me(),
        authPending: false,
        authError: false,
        authFetching: false,
        onRetryAuth: vi.fn(),
      }),
    );

    await eventually(() => {
      expect(document.body.textContent).toContain("registry total is unknown");
    });
    expect(buttons("Export verified rows (CSV)")).toHaveLength(0);
    expect(mocks.downloadTextFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// audience-129 — push row detail panel + copy the fingerprint
// ---------------------------------------------------------------------------

describe("audience-129 · push suppression row detail", () => {
  it("renders the row's authority facts and copies the fingerprint", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await renderPushRegistry();

    await click(button("Details"));
    const dialog = dialogWith("Privacy-safe fingerprint");
    expect(dialog.textContent).toContain("0123456789abcdef");
    expect(dialog.textContent).toContain("APNs");
    expect(dialog.textContent).toContain("Dashboard");
    expect(dialog.textContent).toContain("Manual dashboard authority");
    expect(dialog.textContent).toContain("Reversible");
    expect(dialog.textContent).toContain("3");

    await click(button("Copy fingerprint", dialog));
    await eventually(() => {
      expect(writeText).toHaveBeenCalledWith("0123456789abcdef");
      expect(document.body.textContent).toContain("Fingerprint copied.");
    });
  });

  it("opens the detail for a locked row and names the authority holding it", async () => {
    mocks.listPushSuppressions.mockResolvedValue(
      pushPage([
        pushRow({
          reversible: false,
          reason: "complaint",
          source: "provider",
          lockedReason: "provider_authority",
        }),
      ]),
    );
    await renderPushRegistry();

    await click(button("Details"));
    const dialog = dialogWith("Privacy-safe fingerprint");
    expect(dialog.textContent).toContain("Provider feedback");
    expect(dialog.textContent).toContain("Locked by provider authority");
  });
});
