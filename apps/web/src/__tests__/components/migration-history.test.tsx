// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics-106: migration history — refresh, free-text search (job id /
// source / status), page size, pagination (desktop
// components/migration/MigrationHistorySurface.tsx:1057-1117, refresh
// :112-121). Mounted the way the migrations index mounts its history: the
// page's jobs + sources queries feed it and Refresh re-runs both, so the
// real transport is exercised through a stubbed fetch and the assertions
// cover GET /api/v1/migrations and GET /api/v1/migrations/sources.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MigrationHistory } from "@/app/(dashboard)/app/migrations/_migration-history";
import { listCapabilities, listJobs } from "@/lib/migration-api";
import { searchRecent } from "@/lib/migration-recent-list";
import { toRecentMigration } from "@/lib/migration-recent";
import type {
  MigrationJob,
  MigrationStatus,
  SourcePlatform,
} from "@/lib/types";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCES: SourcePlatform[] = ["mailchimp", "klaviyo", "brevo"];
const STATUSES: MigrationStatus[] = ["completed", "failed", "rolled_back"];

function job(i: number): MigrationJob {
  const n = String(i).padStart(2, "0");
  return {
    id: `job-${n}-${SOURCES[i % 3]}`,
    tenant_id: "tenant-1",
    source: SOURCES[i % 3] as SourcePlatform,
    status: STATUSES[i % 3] as MigrationStatus,
    progress: {
      subscribers_total: 10,
      subscribers_done: 10,
      segments_total: 0,
      segments_done: 0,
      automations_total: 0,
      automations_done: 0,
      paid_subs_total: 0,
      paid_subs_done: 0,
      archive_total: 0,
      archive_done: 0,
    },
    cursor: {},
    // Newest first by index so the default sort is predictable.
    started_at: new Date(
      Date.UTC(2026, 8, 1, 0, 0, 0) + i * 60_000,
    ).toISOString(),
    completed_at: null,
    rollback_until: null,
    verification_report: null,
    error: null,
    label: i === 7 ? "Spring list move" : null,
  };
}

const JOBS = Array.from({ length: 30 }, (_, i) => job(i));

let fetchMock: ReturnType<
  typeof vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >
>;
const roots: Root[] = [];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function requests(): string[] {
  return fetchMock.mock.calls.map(([input, init]) => {
    const url = input instanceof Request ? input.url : String(input);
    const method =
      (input instanceof Request ? input.method : init?.method) ?? "GET";
    return `${method} ${new URL(url, "http://localhost").pathname}`;
  });
}

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = new URL(
      input instanceof Request ? input.url : String(input),
      "http://localhost",
    ).pathname;
    if (path === "/api/v1/migrations/sources") return json([]);
    return json(JOBS);
  });
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/** Mirrors migrations/page.tsx + _index-content.tsx. */
function Harness() {
  const capabilitiesQuery = useQuery({
    queryKey: ["migrations", "t", "admin", "p", "index", "capabilities"],
    queryFn: ({ signal }) => listCapabilities(signal),
  });
  const jobsQuery = useQuery({
    queryKey: ["migrations", "t", "admin", "p", "index", "jobs"],
    queryFn: ({ signal }) => listJobs(signal),
  });
  if (!jobsQuery.data) return null;
  return createElement(MigrationHistory, {
    jobs: jobsQuery.data,
    principalKey: "tenant-1:user-1:admin:member",
    tenantId: "tenant-1",
    onRefresh: () =>
      Promise.all([capabilitiesQuery.refetch(), jobsQuery.refetch()]),
  });
}

function render(): HTMLElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      createElement(QueryClientProvider, { client }, createElement(Harness)),
    ),
  );
  return host;
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function rowIds(el: HTMLElement): string[] {
  return [...el.querySelectorAll('[data-testid="migration-history-row"]')].map(
    (row) => row.textContent?.match(/job-\d\d-[a-z]+/)?.[0] ?? "?",
  );
}

function summary(el: HTMLElement): string {
  return (
    [...el.querySelectorAll('[role="status"]')]
      .map((node) => node.textContent ?? "")
      .find((text) => /matching migration/.test(text)) ?? ""
  );
}

function setValue(node: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    const proto =
      node instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(node, value);
    node.dispatchEvent(
      new Event(node instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

function labelled(el: HTMLElement, text: string) {
  const label = [...el.querySelectorAll("label")].find(
    (node) => node.textContent === text,
  );
  const id = label?.getAttribute("for");
  const control = id ? el.querySelector(`[id="${id}"]`) : null;
  if (!control) throw new Error(`no control labelled ${text}`);
  return control as HTMLInputElement | HTMLSelectElement;
}

function button(el: HTMLElement, text: RegExp): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find((node) =>
    text.test(node.textContent ?? ""),
  );
  if (!found) throw new Error(`no button ${text}`);
  return found;
}

async function ready(): Promise<HTMLElement> {
  const el = render();
  await eventually(() => expect(rowIds(el)).toHaveLength(10));
  return el;
}

describe("searchRecent", () => {
  it("matches id, source label and key, name, and raw or human status", () => {
    const rows = JOBS.map(toRecentMigration);
    expect(searchRecent(rows, "job-07").map((r) => r.id)).toEqual([
      "job-07-klaviyo",
    ]);
    expect(searchRecent(rows, "SPRING").map((r) => r.id)).toEqual([
      "job-07-klaviyo",
    ]);
    expect(searchRecent(rows, "Klaviyo")).toHaveLength(10);
    expect(searchRecent(rows, "rolled back")).toHaveLength(10);
    expect(searchRecent(rows, "rolled_back")).toHaveLength(10);
    expect(searchRecent(rows, "  ")).toHaveLength(30);
  });
});

describe("MigrationHistory", () => {
  it("returns to normal history when the last dismissed migration is restored", async () => {
    const el = await ready();
    const dismiss = el.querySelector<HTMLButtonElement>(
      'button[aria-label^="Dismiss "]',
    )!;
    expect(dismiss).not.toBeNull();
    click(dismiss);
    click(button(el, /^Show dismissed \(1\)$/));
    expect(rowIds(el)).toHaveLength(1);
    click(button(el, /^\s*Restore\s*$/));
    expect(rowIds(el)).toHaveLength(10);
    expect(summary(el)).toBe("30 matching migrations · page 1 of 3");
    expect(el.textContent).not.toContain("No migrations match");
  });

  it("pages the history and changes the page size", async () => {
    const el = await ready();
    expect(summary(el)).toBe("30 matching migrations · page 1 of 3");
    // Default sort: newest first.
    expect(rowIds(el)[0]).toBe("job-29-brevo");

    click(button(el, /^Next$/));
    expect(summary(el)).toBe("30 matching migrations · page 2 of 3");
    expect(rowIds(el)[0]).toBe("job-19-klaviyo");

    setValue(labelled(el, "Per page"), "25");
    expect(summary(el)).toBe("30 matching migrations · page 1 of 2");
    expect(rowIds(el)).toHaveLength(25);
    click(button(el, /^Next$/));
    expect(rowIds(el)).toEqual([
      "job-04-klaviyo",
      "job-03-mailchimp",
      "job-02-brevo",
      "job-01-klaviyo",
      "job-00-mailchimp",
    ]);
    expect(button(el, /^Next$/).disabled).toBe(true);
  });

  it("searches by job id, source, and status, combined with the status filter", async () => {
    const el = await ready();
    const search = labelled(el, "Search migrations");

    setValue(search, "job-12");
    expect(rowIds(el)).toEqual(["job-12-mailchimp"]);
    expect(summary(el)).toBe("1 matching migration · page 1 of 1");

    setValue(search, "brevo");
    expect(summary(el)).toBe("10 matching migrations · page 1 of 1");
    expect(rowIds(el).every((id) => id.endsWith("brevo"))).toBe(true);

    setValue(labelled(el, "Status"), "failed");
    // brevo rows are all rolled_back (i % 3 === 2), so nothing is failed.
    expect(rowIds(el)).toHaveLength(0);
    expect(el.textContent).toContain(
      "No migrations match “brevo” with this status.",
    );

    click(button(el, /^Clear filters$/));
    expect(summary(el)).toBe("30 matching migrations · page 1 of 3");
    // Searching and filtering never re-request: they work on the loaded page.
    expect(
      requests().filter((r) => r === "GET /api/v1/migrations"),
    ).toHaveLength(1);
  });

  it("Refresh re-reads the history and the sources", async () => {
    const el = await ready();
    expect(requests().sort()).toEqual([
      "GET /api/v1/migrations",
      "GET /api/v1/migrations/sources",
    ]);
    let release: () => void = () => undefined;
    fetchMock.mockImplementationOnce(
      (input: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              new URL(
                input instanceof Request ? input.url : String(input),
                "http://localhost",
              ).pathname === "/api/v1/migrations/sources"
                ? json([])
                : json(JOBS),
            );
        }),
    );
    click(button(el, /^Refresh$/));
    await eventually(() =>
      expect(button(el, /Refreshing…/).disabled).toBe(true),
    );
    await act(async () => release());
    await eventually(() =>
      expect(requests().sort()).toEqual([
        "GET /api/v1/migrations",
        "GET /api/v1/migrations",
        "GET /api/v1/migrations/sources",
        "GET /api/v1/migrations/sources",
      ]),
    );
    await eventually(() =>
      expect(button(el, /^Refresh$/).disabled).toBe(false),
    );
  });
});

function click(node: Element) {
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
