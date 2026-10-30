// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// audience-16: the CSV import wizard's consent-evidence step, preflight
// acknowledgements and in-flight recovery are REACHABLE from
// /app/subscribers/import. The real page runs over a stateful stubbed
// transport; the assertions pin the order of the lifecycle requests
// (mapping PATCH -> consent PATCH -> dry run -> confirm), their bodies, the
// commit gate, and what the result screen then claims about sendability.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/subscribers/import",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const { WHOAMI } = await import("./_harness");
  return {
    ...(await importOriginal<typeof import("@/lib/auth-api")>()),
    whoami: vi.fn().mockResolvedValue(WHOAMI),
    whoamiFresh: vi.fn().mockResolvedValue(WHOAMI),
  };
});

import { setOnlineStatusForTest } from "@/lib/online-manager";
import { renderPage, unmount } from "./_harness";
import { button, click, field, type } from "../helpers/subscriber-directory-harness";

const IMPORT_ID = "0e5e1f0a-8a8e-4a55-9a53-6f1b8f0b1d11";
const RUNNING_ID = "5a7d3c1e-2b4f-4c6d-8e9f-0a1b2c3d4e5f";

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

const server = {
  requests: [] as Recorded[],
  revision: 1,
  inFlight: [] as Record<string, unknown>[],
  /** What GET /api/v1/subscriber-imports/{RUNNING_ID} reports right now. */
  runningStatus: "running",
};

/**
 * The browser's EventSource, minimally: records the URL and init it was
 * opened with, and lets a test emit named frames the way the server does.
 */
class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    super();
    FakeEventSource.instances.push(this);
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  emit(name: string, data: string): void {
    this.dispatchEvent(new MessageEvent(name, { data }));
  }

  close(): void {
    this.closed = true;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function handle(method: string, path: string, body: unknown): Response {
  if (path === "/api/v1/subscriber-imports" && method === "GET") {
    return json({ imports: server.inFlight });
  }
  if (path === "/api/v1/subscriber-imports/preview" && method === "POST") {
    return json({
      id: IMPORT_ID,
      status: "previewed",
      mapping: {
        path: "uploads/subs.csv",
        headers: ["email", "name"],
        columns: [
          { index: 0, name: "email", kind: "email" },
          { index: 1, name: "name", kind: "name" },
        ],
        rows: 2,
      },
      sample_rows: [{ email: "ada@example.com", name: "Ada" }],
      rows_total: 2,
      rows_new: 2,
      rows_existing: 0,
      rows_file_dupes: 0,
      on_existing: "skip",
      configuration_revision: server.revision,
    });
  }
  if (path === "/api/v1/subscriber-imports/remap-options") {
    return json({ merge_fields: [], custom_fields: [] });
  }
  if (path === `/api/v1/subscriber-imports/${IMPORT_ID}` && method === "PATCH") {
    const input = body as { configuration_revision: number };
    if (input.configuration_revision !== server.revision)
      return json({ error: { code: "revision_conflict", message: "stale" } }, 409);
    server.revision += 1;
    return json({
      id: IMPORT_ID,
      status: "previewed",
      updated: true,
      configuration_revision: server.revision,
    });
  }
  if (path === `/api/v1/subscriber-imports/${IMPORT_ID}/confirm` && method === "POST") {
    if ((body as { dry_run?: boolean }).dry_run) {
      return json({
        id: IMPORT_ID,
        status: "previewed",
        dry_run_results: {
          rows_total: 2,
          would_create: 1,
          would_update: 0,
          would_skip: 0,
          would_fail: 1,
          file_dupes: 0,
          rows: [
            { row_number: 1, outcome: "create" },
            { row_number: 2, outcome: "fail", error_code: "invalid_email", error: "bad address" },
          ],
          detail_capped: false,
        },
      });
    }
    return json({ id: IMPORT_ID, status: "queued" }, 202);
  }
  if (path === `/api/v1/subscriber-imports/${IMPORT_ID}` && method === "GET") {
    return json({
      id: IMPORT_ID,
      status: "ready",
      rows_total: 2,
      rows_imported: 1,
      rows_skipped: 0,
      rows_failed: 1,
      processed_rows: 2,
      configuration_revision: server.revision,
    });
  }
  if (path === `/api/v1/subscriber-imports/${RUNNING_ID}` && method === "GET") {
    return json({
      id: RUNNING_ID,
      filename: "spring.csv",
      status: server.runningStatus,
      rows_total: 100,
      rows_imported: 38,
      rows_skipped: 1,
      rows_failed: 1,
      processed_rows: 40,
      configuration_revision: 4,
    });
  }
  return json({ error: { code: "not_found", message: "" } }, 404);
}

function lifecycle(): string[] {
  return server.requests
    .filter(
      (request) =>
        request.path.startsWith("/api/v1/subscriber-imports/") &&
        request.path !== "/api/v1/subscriber-imports/preview" &&
        request.method !== "GET",
    )
    .map((request) => {
      const body = request.body as Record<string, unknown> | undefined;
      if (request.path.endsWith("/confirm"))
        return body?.dry_run ? "dry-run" : "confirm";
      if (request.method === "PATCH")
        return "consent_scope_acknowledged" in (body ?? {}) ? "consent" : "mapping";
      return `${request.method} ${request.path}`;
    });
}

function patches(): Record<string, unknown>[] {
  return server.requests
    .filter((request) => request.method === "PATCH")
    .map((request) => request.body as Record<string, unknown>);
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

async function attachCsv(container: HTMLElement): Promise<void> {
  const input = container.querySelector<HTMLInputElement>("#import-file");
  if (!input) throw new Error("file input not rendered");
  const dt = new DataTransfer();
  dt.items.add(new File(["email,name\nada@example.com,Ada\n"], "subs.csv", { type: "text/csv" }));
  await act(async () => {
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Upload -> Map -> the consent step. */
async function reachConsentStep(container: HTMLElement): Promise<void> {
  await attachCsv(container);
  click(button("Preview", container));
  await waitFor(() => container.textContent?.includes("Map 2 columns"), "the map step");
  click(button("Continue to consent", container));
  await waitFor(
    () => container.textContent?.includes("Consent evidence for these contacts"),
    "the consent step",
  );
}

async function mountPage() {
  const Page = (await import("@/app/(dashboard)/app/subscribers/import/page")).default;
  return renderPage(Page);
}

beforeEach(() => {
  server.requests = [];
  server.revision = 1;
  server.inFlight = [];
  server.runningStatus = "running";
  FakeEventSource.instances = [];
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
      server.requests.push({ method, path: url.pathname, query: url.searchParams, body });
      return handle(method, url.pathname, body);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("subscribers/import page mounts the wizard steps (audience-16)", () => {
  it("records first-party proof BEFORE the preflight, then gates the commit on both acknowledgements", async () => {
    const { container, root } = await mountPage();
    try {
      // In-flight recovery asked for running imports (none here).
      await waitFor(
        () => server.requests.some((r) => r.method === "GET" && r.path === "/api/v1/subscriber-imports"),
        "the in-flight import list",
      );
      expect(container.textContent).not.toContain("still running");

      await reachConsentStep(container);
      expect(lifecycle()).toEqual(["mapping"]);

      click(field(/^I hold first-party email-marketing consent/, container) as HTMLInputElement);
      type(field("Proof type", container), "double_optin");
      type(field("Captured at", container), "2026-09-01T10:00");
      type(field("Evidence URL (HTTPS)", container), "https://forms.example.com/consent/export-1");
      type(field("Jurisdiction", container), "gb");
      type(field("Policy version", container), "privacy-2026-06");
      type(field("Evidence reference", container), "receipt:CONSENT-123");
      type(field("Audit reason", container), "Signed up through the pricing page form");
      click(field(/^This proof covers email marketing only/, container) as HTMLInputElement);
      type(field("Type EMAIL MARKETING to confirm the scope", container), "EMAIL MARKETING");
      click(button("Save proof & run preflight", container));
      await waitFor(() => container.textContent?.includes("Row preview"), "the review step");

      expect(lifecycle()).toEqual(["mapping", "consent", "dry-run"]);
      expect(patches()[1]).toEqual({
        configuration_revision: 2,
        consent_scope_acknowledged: true,
        consent_source: "double_optin",
        consent_source_url: "https://forms.example.com/consent/export-1",
        consent_captured_at: new Date("2026-09-01T10:00").toISOString(),
        consent_legal_basis: "consent",
        consent_jurisdiction: "GB",
        consent_reason: "Signed up through the pricing page form",
        consent_policy_version: "privacy-2026-06",
        consent_evidence_reference: "receipt:CONSENT-123",
        consent_scope: "email_marketing",
      });

      // Commit is withheld until the preflight AND the failing row are acknowledged.
      const commit = button("Import 1 contact", container);
      expect(commit.disabled).toBe(true);
      click(field(/^I reviewed the preflight: 1 to create/, container) as HTMLInputElement);
      expect(button("Import 1 contact", container).disabled).toBe(true);
      expect(container.textContent).toContain(
        "Acknowledge that the failing rows will not be imported.",
      );
      click(field(/^1 row will fail and will not be imported/, container) as HTMLInputElement);
      expect(button("Import 1 contact", container).disabled).toBe(false);
      click(button("Import 1 contact", container));

      await waitFor(() => container.textContent?.includes("Import complete"), "the done step");
      expect(lifecycle()).toEqual(["mapping", "consent", "dry-run", "confirm"]);
      // Proof was recorded, so the result does not claim the rows are unsendable.
      expect(container.textContent).not.toContain("not yet sendable");
    } finally {
      unmount(root);
    }
  }, 30_000);

  it("persists 'no proof' as a cleared contract and keeps the unconfirmed warning", async () => {
    const { container, root } = await mountPage();
    try {
      await reachConsentStep(container);
      click(button("Continue without proof", container));
      await waitFor(() => container.textContent?.includes("Row preview"), "the review step");
      expect(lifecycle()).toEqual(["mapping", "consent", "dry-run"]);
      expect(patches()[1]).toEqual({
        configuration_revision: 2,
        consent_scope_acknowledged: false,
      });
      click(field(/^I reviewed the preflight/, container) as HTMLInputElement);
      click(field(/^1 row will fail/, container) as HTMLInputElement);
      click(button("Import 1 contact", container));
      await waitFor(() => container.textContent?.includes("Import complete"), "the done step");
      expect(container.textContent).toContain("not yet sendable");
    } finally {
      unmount(root);
    }
  }, 30_000);

  it("offers a still-running import on the upload step and re-attaches its progress", async () => {
    server.inFlight = [
      {
        id: RUNNING_ID,
        filename: "spring.csv",
        status: "running",
        rows_total: 100,
        processed_rows: 40,
        rows_imported: 38,
        rows_failed: 1,
        cancel_requested: false,
        created_at: "2026-09-12T08:00:00Z",
      },
    ];
    const { container, root } = await mountPage();
    try {
      await waitFor(
        () => container.textContent?.includes("An import is still running"),
        "the in-flight import section",
      );
      expect(container.textContent).toContain("spring.csv · running · 40 of 100 rows (40%)");
      click(button("Show progress", container));
      await waitFor(
        () =>
          server.requests.some(
            (r) => r.method === "GET" && r.path === `/api/v1/subscriber-imports/${RUNNING_ID}`,
          ) && container.textContent?.includes("40 / 100 (40%)"),
        "the running import's progress",
      );
      expect(button("Cancel import", container)).toBeTruthy();
    } finally {
      unmount(root);
    }
  }, 30_000);

  it("follows a running import over its progress stream, then makes one full read at the terminal frame (import progress SSE)", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    server.inFlight = [
      {
        id: RUNNING_ID,
        filename: "spring.csv",
        status: "running",
        rows_total: 100,
        processed_rows: 40,
        rows_imported: 38,
        rows_failed: 1,
        cancel_requested: false,
        created_at: "2026-09-12T08:00:00Z",
      },
    ];
    const { container, root } = await mountPage();
    try {
      await waitFor(
        () => container.textContent?.includes("An import is still running"),
        "the in-flight import section",
      );
      expect(FakeEventSource.instances).toHaveLength(0);
      click(button("Show progress", container));

      // The page opened the import's own progress stream, with credentials.
      const es = await waitFor(() => FakeEventSource.instances[0], "the progress stream");
      expect(es.url).toBe(`/api/v1/subscriber-imports/${RUNNING_ID}/progress`);
      expect(es.init?.withCredentials).toBe(true);
      await act(async () => es.open());

      // A progress frame paints the running step without any poll read.
      const reads = () =>
        server.requests.filter(
          (r) => r.method === "GET" && r.path === `/api/v1/subscriber-imports/${RUNNING_ID}`,
        );
      await act(async () => {
        es.emit(
          "progress",
          JSON.stringify({
            status: "importing",
            processed_rows: 60,
            total_rows: 100,
            rows_imported: 58,
            rows_skipped: 1,
            rows_failed: 1,
          }),
        );
      });
      await waitFor(() => container.textContent?.includes("60 / 100 (60%)"), "the streamed progress");
      expect(reads()).toHaveLength(0);

      // The terminal frame triggers exactly one full read, then the result screen.
      server.runningStatus = "ready";
      await act(async () => {
        es.emit(
          "progress",
          JSON.stringify({
            status: "ready",
            processed_rows: 100,
            total_rows: 100,
            rows_imported: 98,
            rows_skipped: 1,
            rows_failed: 1,
          }),
        );
      });
      await waitFor(() => container.textContent?.includes("Import complete"), "the done step");
      expect(reads()).toHaveLength(1);
      expect(es.closed).toBe(true);
    } finally {
      unmount(root);
    }
  }, 30_000);
});
