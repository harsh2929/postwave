// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The subscribers directory components are REACHABLE from /app/subscribers:
// the real page is mounted over the real transport (global fetch stubbed with
// a small stateful server), and each test drives a mounted control and asserts
// the request it makes and what the page then shows.
//
//   audience-5   column picker   GET/PUT /api/v1/me/prefs/subscribers_view
//   audience-11  inline rename   PATCH {email} under If-Match
//   audience-12  inline status   PATCH {status} under If-Match
//   audience-13  inline tags     PATCH {tags} (whole array) under If-Match
//   audience-10  keyboard        j/k/x/Enter/n on the page's rows
//   audience-19  add subscriber  POST /api/v1/subscribers, unconfirmed by default
//   audience-25  bulk resubscribe POST /bulk/resubscribe WITH the evidence envelope
//   audience-27  bulk custom field POST /bulk/set-custom-field, one key
//   audience-28  bulk merge field  POST /bulk/update-merge-field, one key
import { act } from "react";
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

import { setOnlineStatusForTest } from "@/lib/online-manager";
import { renderPage, unmount } from "./_harness";
import {
  button,
  byAriaLabel,
  click,
  dialogs,
  field,
  navStore,
  queryButton,
  topDialog,
  type,
} from "../helpers/subscriber-directory-harness";

const ADA = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const BOB = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const GRACE = "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b";
const version = (id: string, n: number) => `"subscriber:${id}:v${n}"`;

type Row = Record<string, unknown> & { id: string; email: string; version: string };

interface Recorded {
  method: string;
  url: URL;
  body: unknown;
  headers: Headers;
}

const server = {
  rows: [] as Row[],
  prefs: {} as Record<string, unknown>,
  requests: [] as Recorded[],
};

function seed(): void {
  server.rows = [
    {
      id: ADA,
      email: "ada@example.com",
      status: "unconfirmed",
      consent_timestamp: null,
      consent_source: "unknown",
      custom_fields: { plan: "pro" },
      tags: ["vip", "beta"],
      version: version(ADA, 1),
      created_at: "2026-08-01T10:00:00Z",
      updated_at: "2026-09-01T10:00:00Z",
      engagement_score: 72,
    },
    {
      id: BOB,
      email: "bob@example.com",
      status: "blocklisted",
      consent_timestamp: null,
      consent_source: "unknown",
      custom_fields: {},
      tags: [],
      version: version(BOB, 1),
      created_at: "2026-08-02T10:00:00Z",
      updated_at: "2026-09-02T10:00:00Z",
    },
  ];
  // The user's saved column set: no Engagement, no Avatar.
  server.prefs = {
    columns: ["email", "status", "joined", "tags"],
    widths: {},
    sort: "",
    order: "",
  };
  server.requests = [];
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function handle(method: string, url: URL, body: unknown, headers: Headers): Promise<Response> {
  const path = url.pathname;
  if (path === "/api/v1/subscribers" && method === "GET") {
    const perPage = Number(url.searchParams.get("per_page") ?? "50");
    return json({
      items: perPage === 50 ? server.rows : [],
      total: server.rows.length,
      page: 1,
      per_page: perPage,
    });
  }
  if (path === "/api/v1/subscribers" && method === "POST") {
    const input = body as { email: string; tags: string[]; status: string };
    const created: Row = {
      id: GRACE,
      email: input.email,
      status: input.status,
      consent_timestamp: null,
      consent_source: "unknown",
      custom_fields: {},
      tags: input.tags,
      version: version(GRACE, 1),
    };
    server.rows = [created, ...server.rows];
    return json(created, 201);
  }
  const one = /^\/api\/v1\/subscribers\/([0-9a-f-]{36})$/.exec(path);
  if (one && method === "PATCH") {
    const row = server.rows.find((candidate) => candidate.id === one[1]);
    if (!row) return json({ error: { code: "not_found", message: "" } }, 404);
    if (headers.get("If-Match") !== row.version)
      return json({ error: { code: "precondition_failed", message: "stale" } }, 412);
    const n = Number(/v(\d+)"$/.exec(row.version)?.[1] ?? "1") + 1;
    Object.assign(row, body as object, { version: version(row.id, n) });
    return json(row, 200, { ETag: row.version });
  }
  if (path === "/api/v1/me/prefs/subscribers_view") {
    if (method === "PUT") server.prefs = body as Record<string, unknown>;
    return json(server.prefs);
  }
  if (path === "/api/v1/custom-fields" && method === "GET") {
    return json([{ id: 1, key: "plan", label: "Plan", type: "string" }]);
  }
  if (path.startsWith("/api/v1/subscribers/bulk/") && method === "POST") {
    const ids = (body as { subscriber_ids: string[] }).subscriber_ids;
    return json({ affected: ids.length, skipped: 0 });
  }
  return json({ error: { code: "not_found", message: "" } }, 404);
}

function requestsTo(method: string, path: string): Recorded[] {
  return server.requests.filter(
    (request) => request.method === method && request.url.pathname === path,
  );
}

function listFetches(): number {
  return server.requests.filter(
    (request) =>
      request.method === "GET" &&
      request.url.pathname === "/api/v1/subscribers" &&
      request.url.searchParams.get("per_page") === "50",
  ).length;
}

async function settle(turns = 14): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Polls until `probe` returns something truthy (lazy chunks load on a cold
 *  module graph, so a fixed number of turns is not enough the first time). */
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

function desktopTable(container: HTMLElement): HTMLTableElement {
  const table = container.querySelector("table");
  if (!table) throw new Error("desktop subscribers table not rendered");
  return table;
}

function headerLabels(table: HTMLTableElement): string[] {
  return [...table.querySelectorAll("thead th")]
    .map((th) => th.textContent?.trim() ?? "")
    .filter(Boolean);
}

function row(table: HTMLTableElement, id: string): HTMLTableRowElement {
  const match = table.querySelector<HTMLTableRowElement>(`tr[data-id="${id}"]`);
  if (!match) throw new Error(`row ${id} not rendered`);
  return match;
}

function key(target: EventTarget, keyName: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true }));
  });
}

async function mountPage() {
  const Page = (await import("@/app/(dashboard)/app/subscribers/page")).default;
  const mounted = await renderPage(Page);
  await waitFor(
    () => mounted.container.querySelector(`table tr[data-id="${ADA}"]`),
    "the subscribers table rows",
  );
  await settle();
  return mounted;
}

beforeEach(() => {
  seed();
  navStore.reset();
  setOnlineStatusForTest("online");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const url = new URL(raw, "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      const body =
        typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
      const headers = new Headers(init?.headers);
      server.requests.push({ method, url, body, headers });
      return handle(method, url, body, headers);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("subscribers page mounts the directory components", () => {
  it("audience-5: renders the saved column set and persists a picker change", async () => {
    const { container, root } = await mountPage();
    try {
      await waitFor(
        () => requestsTo("GET", "/api/v1/me/prefs/subscribers_view").length > 0,
        "the column preference read",
      );
      // The saved set replaces the defaults (which include Engagement).
      await waitFor(
        () => !headerLabels(desktopTable(container)).includes("Engagement"),
        "the saved column set",
      );
      const table = desktopTable(container);
      expect(headerLabels(table)).toEqual(
        expect.arrayContaining(["Email", "Status", "Joined", "Tags"]),
      );
      expect(headerLabels(table)).not.toContain("Engagement");

      click(button("Columns", container));
      const picker = await waitFor(
        () => dialogs().find((d) => d.textContent?.includes("Visible columns")),
        "the column picker dialog",
      );
      expect(picker.textContent).toContain("Visible columns");
      click(field("Engagement", picker) as HTMLInputElement);
      await settle(2);
      expect(headerLabels(desktopTable(container))).toContain("Engagement");
      // ADA's engagement score is now a visible cell.
      expect(row(desktopTable(container), ADA).textContent).toContain("72");

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 650));
      });
      const puts = requestsTo("PUT", "/api/v1/me/prefs/subscribers_view");
      expect(puts).toHaveLength(1);
      expect((puts[0]!.body as { columns: string[] }).columns).toEqual([
        "email",
        "status",
        "joined",
        "tags",
        "engagement",
      ]);
    } finally {
      unmount(root);
      await settle();
    }
  }, 30_000);

  it("audience-11/12/13: renames, re-statuses and re-tags a row in place under its revision", async () => {
    const { container, root } = await mountPage();
    try {
      let table = desktopTable(container);
      expect(row(table, ADA).getAttribute("data-subscriber-row-index")).toBe("0");
      expect(row(table, BOB).getAttribute("data-subscriber-row-index")).toBe("1");

      // Tags (audience-13): remove one chip; the whole remaining set is sent.
      click(button("Remove tag vip from ada@example.com", row(table, ADA)));
      await settle();
      let patches = requestsTo("PATCH", `/api/v1/subscribers/${ADA}`);
      expect(patches).toHaveLength(1);
      expect(patches[0]!.body).toEqual({ tags: ["beta"] });
      expect(patches[0]!.headers.get("If-Match")).toBe(version(ADA, 1));
      table = desktopTable(container);
      expect(queryButton("Remove tag vip from ada@example.com", row(table, ADA))).toBeNull();
      expect(queryButton("Remove tag beta from ada@example.com", row(table, ADA))).not.toBeNull();

      // Status (audience-12): a non-positive change is a versioned PATCH.
      type(
        byAriaLabel<HTMLSelectElement>("Status for ada@example.com", row(table, ADA)),
        "disabled",
      );
      await settle();
      patches = requestsTo("PATCH", `/api/v1/subscribers/${ADA}`);
      expect(patches).toHaveLength(2);
      expect(patches[1]!.body).toEqual({ status: "disabled" });
      expect(patches[1]!.headers.get("If-Match")).toBe(version(ADA, 2));
      table = desktopTable(container);
      expect(
        byAriaLabel<HTMLSelectElement>("Status for ada@example.com", row(table, ADA)).value,
      ).toBe("disabled");

      // Rename (audience-11): needs the identity-rotation review first.
      click(button("Rename email for ada@example.com", row(table, ADA)));
      await settle(2);
      const adaRow = row(desktopTable(container), ADA);
      type(field("New email for ada@example.com", adaRow), "ada.lovelace@example.com");
      expect(button("Save", adaRow).disabled).toBe(true);
      click(field(/^I reviewed this identity rotation/, adaRow) as HTMLInputElement);
      click(button("Save", adaRow));
      await settle();
      patches = requestsTo("PATCH", `/api/v1/subscribers/${ADA}`);
      expect(patches).toHaveLength(3);
      expect(patches[2]!.body).toEqual({ email: "ada.lovelace@example.com" });
      expect(patches[2]!.headers.get("If-Match")).toBe(version(ADA, 3));
      table = desktopTable(container);
      expect(row(table, ADA).textContent).toContain("ada.lovelace@example.com");
      expect(
        queryButton("Rename email for ada.lovelace@example.com", row(table, ADA)),
      ).not.toBeNull();
    } finally {
      unmount(root);
      await settle();
    }
  }, 30_000);

  it("audience-10: j/k move row focus, x selects, Enter opens, n opens the add form", async () => {
    const { container, root } = await mountPage();
    try {
      const table = desktopTable(container);
      key(document.body, "j");
      expect(document.activeElement).toBe(row(table, ADA));
      key(document.activeElement!, "j");
      expect(document.activeElement).toBe(row(table, BOB));
      key(document.activeElement!, "k");
      expect(document.activeElement).toBe(row(table, ADA));
      key(document.activeElement!, "j");

      key(document.activeElement!, "x");
      await settle(2);
      const bobBox = byAriaLabel<HTMLInputElement>("Select bob@example.com", table);
      expect(bobBox.checked).toBe(true);
      expect(container.textContent).toContain("1 selected");

      key(row(table, BOB), "Enter");
      expect(navStore.replaced).toContain(`/app/subscribers/${BOB}`);

      expect(dialogs()).toHaveLength(0);
      key(document.body, "n");
      const add = await waitFor(
        () => dialogs().find((d) => d.textContent?.includes("Add subscriber")),
        "the add-subscriber dialog",
      );
      expect(add.textContent).toContain("Initial eligibility");
    } finally {
      unmount(root);
      await settle();
    }
  }, 30_000);

  it("audience-19: New subscriber opens the evidence-gated add form and saves unconfirmed", async () => {
    const { container, root } = await mountPage();
    try {
      click(button("New subscriber", container));
      const dialog = await waitFor(
        () => dialogs().find((d) => d.textContent?.includes("Add subscriber")),
        "the add-subscriber dialog",
      );
      expect((field("Initial eligibility", dialog) as HTMLSelectElement).value).toBe(
        "unconfirmed",
      );
      type(field("Email", dialog), "grace@example.com");
      type(field("Tags (comma-separated)", dialog), "beta, vip");
      click(button("Add subscriber", dialog));
      await settle();

      const creates = requestsTo("POST", "/api/v1/subscribers");
      expect(creates).toHaveLength(1);
      expect(creates[0]!.body).toEqual({
        email: "grace@example.com",
        tags: ["beta", "vip"],
        status: "unconfirmed",
      });
      expect(row(desktopTable(container), GRACE).textContent).toContain(
        "grace@example.com",
      );
    } finally {
      unmount(root);
      await settle();
    }
  }, 30_000);

  it("audience-25: bulk Re-subscribe sends only eligible ids WITH the consent evidence", async () => {
    const { container, root } = await mountPage();
    try {
      const table = desktopTable(container);
      click(byAriaLabel<HTMLInputElement>("Select ada@example.com", table));
      click(byAriaLabel<HTMLInputElement>("Select bob@example.com", table));
      await settle();
      click(await waitFor(() => queryButton("Re-subscribe…", container), "Re-subscribe…"));
      // The bare id-only confirm is gone; the evidence dialog replaced it.
      expect(queryButton("Re-subscribe", container)).toBeNull();
      const dialog = await waitFor(
        () => dialogs().find((d) => d.textContent?.includes("Re-subscribe 1 subscriber")),
        "the resubscribe dialog",
      );
      expect(dialog.textContent).toContain("Re-subscribe 1 subscriber");
      expect(dialog.textContent).toContain(
        "Left out of this request: 1 disabled or unconfirmed",
      );
      type(field("Evidence source", dialog), "preference_center");
      type(field("Captured at", dialog), "2026-09-02T09:15");
      type(field("Jurisdiction", dialog), "eu");
      type(field("Policy version", dialog), "privacy-2026-06");
      type(field("Evidence reference", dialog), "receipt:REOPTIN-9");
      type(field("Reason", dialog), "Re-opted in through the preference center");
      click(field(/^This evidence covers each of the 1/, dialog) as HTMLInputElement);
      type(field("Type RESUBSCRIBE 1 to confirm", dialog), "RESUBSCRIBE 1");
      const before = listFetches();
      click(button("Re-subscribe 1", dialog));
      await settle();

      const posts = requestsTo("POST", "/api/v1/subscribers/bulk/resubscribe");
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body).toEqual({
        subscriber_ids: [BOB],
        source: "preference_center",
        channel: "web",
        legal_basis: "consent",
        occurred_at: new Date("2026-09-02T09:15").toISOString(),
        jurisdiction: "EU",
        evidence: "receipt:REOPTIN-9",
        reason: "Re-opted in through the preference center",
        policy_version: "privacy-2026-06",
      });
      expect(topDialog().textContent).toContain("Resubscribed 1.");
      // onDone refreshed the page's list.
      expect(listFetches()).toBeGreaterThan(before);
    } finally {
      unmount(root);
      await settle();
    }
  }, 30_000);

  it("audience-27/28: bulk custom and merge field writes send one key, never a map", async () => {
    const { container, root } = await mountPage();
    try {
      const table = desktopTable(container);
      click(byAriaLabel<HTMLInputElement>("Select ada@example.com", table));
      await settle();

      click(await waitFor(() => queryButton("Custom field…", container), "Custom field…"));
      await waitFor(
        () => requestsTo("GET", "/api/v1/custom-fields").length > 0,
        "the custom-field definitions read",
      );
      await settle(4);
      let dialog = topDialog();
      type(field("Field", dialog), "plan");
      type(field("Value", dialog), "gold");
      click(button("Review", dialog));
      await settle(2);
      click(button("Set on 1 subscriber", topDialog()));
      await settle();
      const custom = requestsTo("POST", "/api/v1/subscribers/bulk/set-custom-field");
      expect(custom).toHaveLength(1);
      expect(custom[0]!.body).toEqual({ subscriber_ids: [ADA], key: "plan", value: "gold" });

      click(button("Merge field…", container));
      await settle(4);
      dialog = topDialog();
      type(field("Field", dialog), "COMPANY");
      type(field("Value", dialog), "Acme Ltd");
      click(button("Review", dialog));
      await settle(2);
      click(button("Set on 1 subscriber", topDialog()));
      await settle();
      const merge = requestsTo("POST", "/api/v1/subscribers/bulk/update-merge-field");
      expect(merge).toHaveLength(1);
      expect(merge[0]!.body).toEqual({
        subscriber_ids: [ADA],
        key: "COMPANY",
        value: "Acme Ltd",
      });

      // No profile PATCH, and no request carried a whole field map.
      expect(server.requests.filter((request) => request.method === "PATCH")).toHaveLength(0);
      for (const request of server.requests) {
        const body = request.body as Record<string, unknown> | undefined;
        expect(body && "custom_fields" in body).toBeFalsy();
        expect(body && "merge_fields" in body).toBeFalsy();
      }
    } finally {
      unmount(root);
      await settle();
    }
  }, 30_000);
});
