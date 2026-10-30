// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// What /app/subscribers tells the operator after a write, and what it
// refreshes. The real page runs over a stateful stubbed transport.
//
//   Paste emails   a partial paste keeps the dialog open with each failed
//                  address and its reason (erasure_blocked from the API),
//                  instead of a count-only toast and a closed dialog.
//   Bulk actions   a failed "select all matching" collection is reported and
//                  no longer leaves every later bulk action silently dead.
//   Refresh        a bulk delete refetches the growth trend and invalidates
//                  the other audience-derived caches, dropping the deleted
//                  contacts' profiles.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", async () =>
  (await import("../helpers/subscriber-directory-harness")).navigationMock(),
);
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const { WHOAMI } = await import("./_harness");
  return {
    ...(await importOriginal<typeof import("@/lib/auth-api")>()),
    whoami: vi.fn().mockResolvedValue(WHOAMI),
    whoamiFresh: vi.fn().mockResolvedValue(WHOAMI),
  };
});
vi.mock("@/lib/realtime/event-bus-client", () => ({
  connectRealtimeBus: () => () => undefined,
}));
const toasts = vi.hoisted(() => [] as { level: string; text: string }[]);
vi.mock("sonner", () => {
  const record = (level: string) => (message: unknown) => {
    toasts.push({ level, text: String(message) });
    return "toast-id";
  };
  return {
    toast: Object.assign(record("message"), {
      error: record("error"),
      success: record("success"),
      warning: record("warning"),
      message: record("message"),
    }),
  };
});

import { setOnlineStatusForTest } from "@/lib/online-manager";
import { base, qk } from "@/lib/query-keys";
import { WHOAMI } from "./_harness";
import {
  button,
  byAriaLabel,
  click,
  dialogs,
  field,
  navStore,
  queryButton,
  type,
} from "../helpers/subscriber-directory-harness";

const TENANT = WHOAMI.tenant_id;
const ROLE = "owner";
const ADA = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const BOB = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";

// The body POST /api/v1/subscribers/bulk-paste returns when one pasted
// address belongs to a deleted contact (subscribers.BulkPaste; pinned by
// apps/api/internal/subscribers/bulk_paste_erasure_db_test.go).
const ERASED_MESSAGE =
  "This address was permanently erased by a contact deletion or privacy request and can't be re-added.";

interface Recorded {
  method: string;
  url: URL;
  body: unknown;
}

const server = {
  requests: [] as Recorded[],
  total: 2,
  /** Pages larger than the directory's own 50 fail, as a flaky search does. */
  failWidePages: false,
  pasteResponse: null as unknown,
};

function rows() {
  return [
    {
      id: ADA,
      email: "ada@example.com",
      status: "unconfirmed",
      consent_source: "unknown",
      custom_fields: {},
      tags: [],
      version: `"subscriber:${ADA}:v1"`,
      created_at: "2026-08-01T10:00:00Z",
      updated_at: "2026-09-01T10:00:00Z",
    },
    {
      id: BOB,
      email: "bob@example.com",
      status: "enabled",
      consent_source: "api",
      custom_fields: {},
      tags: [],
      version: `"subscriber:${BOB}:v1"`,
      created_at: "2026-08-02T10:00:00Z",
      updated_at: "2026-09-02T10:00:00Z",
    },
  ];
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function handle(method: string, url: URL, body: unknown): Response {
  const path = url.pathname;
  if (path === "/api/v1/subscribers" && method === "GET") {
    const perPage = Number(url.searchParams.get("per_page") ?? "50");
    if (perPage !== 50 && server.failWidePages) {
      return json(
        { error: { code: "unavailable", message: "Subscriber listing is temporarily unavailable." } },
        503,
        { "Retry-After": "0" },
      );
    }
    return json({ items: rows(), total: server.total, page: 1, per_page: perPage });
  }
  if (path === "/api/v1/subscribers/growth") {
    return json({
      days: Number(url.searchParams.get("days") ?? "90"),
      series: [
        { date: "2026-09-01", total: 10, added: 1, unsubbed: 0, lapsed: 0 },
        { date: "2026-09-02", total: 12, added: 2, unsubbed: 0, lapsed: 0 },
      ],
      total_added: 3,
      total_unsubbed: 0,
      delta: 2,
      delta_pct: 20,
      unavailable_metrics: [],
      partial_metrics: [],
    });
  }
  if (path === "/api/v1/subscribers/bulk-paste" && method === "POST") {
    return json(server.pasteResponse);
  }
  if (path.startsWith("/api/v1/subscribers/bulk/") && method === "POST") {
    const ids = (body as { subscriber_ids: string[] }).subscriber_ids;
    return json({ affected: ids.length, source: "explicit_ids" });
  }
  return json({ error: { code: "not_found", message: "" } }, 404);
}

function posts(path: string): Recorded[] {
  return server.requests.filter((r) => r.method === "POST" && r.url.pathname === path);
}

function growthReads(): number {
  return server.requests.filter((r) => r.method === "GET" && r.url.pathname === "/api/v1/subscribers/growth")
    .length;
}

async function waitFor<T>(
  probe: () => T | null | undefined | false,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value: T | null | undefined | false = null;
    try {
      value = probe();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

let mounted: { root: Root; container: HTMLElement } | null = null;

async function mountPage(client: QueryClient) {
  const Page = (await import("@/app/(dashboard)/app/subscribers/page")).default;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Page)));
  });
  mounted = { root, container };
  await waitFor(() => container.querySelector(`table tr[data-id="${ADA}"]`), "the subscribers table");
  return container;
}

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}

beforeEach(() => {
  server.requests = [];
  server.total = 2;
  server.failWidePages = false;
  server.pasteResponse = null;
  toasts.length = 0;
  navStore.reset();
  setOnlineStatusForTest("online");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const url = new URL(raw, "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
      server.requests.push({ method, url, body });
      return handle(method, url, body);
    }),
  );
});

afterEach(() => {
  if (mounted) {
    const { root } = mounted;
    act(() => root.unmount());
    mounted = null;
  }
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("paste emails explains the addresses it could not add", () => {
  it("keeps the dialog open with each failed address and why, leaving only those to retry", async () => {
    server.pasteResponse = {
      parsed: 3,
      created: 1,
      updated: 0,
      skipped: 0,
      errored: 2,
      rows: [
        { email: "gone@example.com", status: "error", error_code: "erasure_blocked", error: ERASED_MESSAGE },
        { email: "new@example.com", status: "created" },
        {
          email: "not-an-address",
          status: "error",
          error_code: "validation_failed",
          error: "email must be a valid mailbox address",
        },
      ],
    };
    const container = await mountPage(newClient());
    click(button("Paste emails", container));
    const dialog = await waitFor(
      () => dialogs().find((d) => d.textContent?.includes("Paste emails")),
      "the paste dialog",
    );
    type(field("Emails (one per line or comma-separated)", dialog), "gone@example.com\nnew@example.com\nnot-an-address");
    click(button("Add emails", dialog));

    const alert = await waitFor(() => dialog.querySelector<HTMLElement>('[role="alert"]'), "the failure list");
    expect(dialogs()).toContain(dialog);
    expect(alert.textContent).toContain("2 addresses weren't added");
    expect(alert.textContent).toContain(
      "gone@example.com — Permanently erased when the contact was deleted or by a privacy request, so it can't be added again.",
    );
    expect(alert.textContent).toContain("not-an-address — Email must be a valid mailbox address.");
    expect(alert.textContent).toContain("The other 1 was added.");
    expect((field("Emails (one per line or comma-separated)", dialog) as HTMLTextAreaElement).value).toBe(
      "gone@example.com\nnot-an-address",
    );
    expect(toasts).toContainEqual({
      level: "warning",
      text: "Added 1 of 3. 1 was permanently erased and can't be added again; 1 couldn't be added.",
    });
  }, 30_000);

  it("closes once every address was added", async () => {
    server.pasteResponse = {
      parsed: 1,
      created: 1,
      updated: 0,
      skipped: 0,
      errored: 0,
      rows: [{ email: "new@example.com", status: "created" }],
    };
    const container = await mountPage(newClient());
    click(button("Paste emails", container));
    const dialog = await waitFor(
      () => dialogs().find((d) => d.textContent?.includes("Paste emails")),
      "the paste dialog",
    );
    type(field("Emails (one per line or comma-separated)", dialog), "new@example.com");
    click(button("Add emails", dialog));
    await waitFor(() => !dialogs().some((d) => d.textContent?.includes("Paste emails")), "the dialog to close");
    expect(toasts).toContainEqual({ level: "success", text: "Added 1 contact." });
  }, 30_000);
});

describe("bulk actions after a failed select-all collection", () => {
  it("reports the failure and still runs the next bulk action", async () => {
    server.total = 120;
    server.failWidePages = true;
    const container = await mountPage(newClient());
    const table = container.querySelector("table")!;
    click(byAriaLabel<HTMLInputElement>("Select ada@example.com", table));
    click(await waitFor(() => queryButton("Select all 120 matching", container), "select all matching"));
    click(button("Delete", container));
    type(byAriaLabel<HTMLInputElement>("Type DELETE to confirm", container), "DELETE");
    click(button("Erase", container));

    await waitFor(() => toasts.some((t) => t.level === "error"), "the collection failure toast");
    expect(toasts.find((t) => t.level === "error")?.text).toContain(
      "Subscriber listing is temporarily unavailable.",
    );
    expect(posts("/api/v1/subscribers/bulk/delete")).toHaveLength(0);

    // The next bulk action on an ordinary selection must still run.
    server.failWidePages = false;
    click(button("Clear", container));
    click(byAriaLabel<HTMLInputElement>("Select bob@example.com", container.querySelector("table")!));
    click(await waitFor(() => queryButton("Tag", container), "the Tag action"));
    type(byAriaLabel<HTMLInputElement>("Tag to apply", container), "vip");
    click(button("Apply", container));
    await waitFor(() => posts("/api/v1/subscribers/bulk/tag").length === 1, "the bulk tag request");
    expect(posts("/api/v1/subscribers/bulk/tag")[0]!.body).toMatchObject({ subscriber_ids: [BOB], tag: "vip" });
  }, 30_000);
});

describe("a bulk delete refreshes what is derived from the audience", () => {
  it("refetches the growth trend, invalidates list and dashboard caches and drops the deleted profiles", async () => {
    const client = newClient();
    const listMembers = [...base("list-members", TENANT, ROLE), "42", null];
    const dashboard = qk.dashboard(TENANT, ROLE);
    const otherTenantLists = [...base("lists", "33333333-3333-4333-8333-333333333333", ROLE), null];
    client.setQueryData(listMembers, { items: [{ id: ADA }], total: 1 });
    client.setQueryData(dashboard, { subscribers: 12 });
    client.setQueryData(otherTenantLists, []);
    client.setQueryData(qk.subscriber(TENANT, ROLE, ADA), { id: ADA, email: "ada@example.com" });
    client.setQueryData(qk.subscriber(TENANT, ROLE, BOB), { id: BOB, email: "bob@example.com" });

    const container = await mountPage(client);
    await waitFor(() => growthReads() > 0, "the growth trend");
    const growthBefore = growthReads();

    click(byAriaLabel<HTMLInputElement>("Select ada@example.com", container.querySelector("table")!));
    click(await waitFor(() => queryButton("Delete", container), "the Delete action"));
    type(byAriaLabel<HTMLInputElement>("Type DELETE to confirm", container), "DELETE");
    click(button("Erase", container));
    await waitFor(() => posts("/api/v1/subscribers/bulk/delete").length === 1, "the bulk delete");
    await waitFor(() => growthReads() > growthBefore, "the growth trend to refetch");

    expect(client.getQueryState(listMembers)?.isInvalidated).toBe(true);
    expect(client.getQueryState(dashboard)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherTenantLists)?.isInvalidated).toBe(false);
    expect(client.getQueryData(qk.subscriber(TENANT, ROLE, ADA))).toBeUndefined();
    expect(client.getQueryData(qk.subscriber(TENANT, ROLE, BOB))).toBeDefined();
  }, 30_000);
});
