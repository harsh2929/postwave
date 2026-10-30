// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The CSV import wizard at /app/subscribers/import over a stateful stubbed
// transport:
//
//   Custom fields  the Map step says what happens to a mapped custom field the
//                  workspace hasn't defined, per its mode, and saves the
//                  "create new custom fields" choice with the mapping; Review
//                  lists the fields the run will create.
//   Discard        going Back from Map, leaving the wizard, or discarding an
//                  unfinished upload from the upload step deletes the preview,
//                  and never an import the person already started.
//   Result         the result screen lists the recorded row failures with
//                  their reasons, not only a count and a CSV link.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
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
const toasts = vi.hoisted(() => [] as { level: string; text: string; description?: string }[]);
vi.mock("sonner", () => {
  const record = (level: string) => (message: unknown, options?: { description?: string }) => {
    toasts.push({ level, text: String(message), description: options?.description });
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
import { renderPage, unmount } from "./_harness";
import { button, click, dialogs, field, queryButton, type } from "../helpers/subscriber-directory-harness";

const IMPORT_ID = "3f2d6c1a-7b8e-4c5d-9e0f-1a2b3c4d5e6f";
const DRAFT_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

// Row failures exactly as the worker records them (subscriber_import
// erasure_guard.go and custom_field_policy.go).
const ERASED = "This address was permanently erased by a contact deletion or privacy request and can't be re-imported.";
const UNDEFINED_PLAN =
  'Custom field "plan" isn\'t defined, and this workspace only accepts defined custom fields. Add it under Settings › Custom fields, or skip the column.';

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

const server = {
  requests: [] as Recorded[],
  revision: 1,
  mode: "auto" as "auto" | "strict" | "off",
  /** GET /custom-fields/mode fails, as an outage would. */
  modeUnavailable: false,
  columns: [] as { index: number; name: string; kind: string; custom_key?: string }[],
  imports: [] as Record<string, unknown>[],
  /** The workspace's declared custom fields, as Settings › Custom fields defines them. */
  declared: [] as { key: string; label: string; type: string }[],
  /** Each import's status on the server, which a stale list can disagree with. */
  statuses: {} as Record<string, string>,
  /** Holds the Confirm POST open until the test lets it finish. */
  confirmGate: null as Promise<void> | null,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function handle(method: string, path: string, body: unknown): Promise<Response> {
  if (path === "/api/v1/subscriber-imports" && method === "GET") return json({ imports: server.imports });
  if (path === "/api/v1/subscriber-imports/preview" && method === "POST") {
    return json({
      id: IMPORT_ID,
      status: "preview",
      mapping: {
        path: "",
        headers: server.columns.map((c) => c.name),
        columns: server.columns,
        rows: 2,
      },
      sample_rows: [{ email: "ada@example.com", plan: "pro", "2024 Spend": "12" }],
      rows_total: 2,
      rows_new: 2,
      rows_existing: 0,
      rows_file_dupes: 0,
      on_existing: "skip",
      configuration_revision: server.revision,
      source_fingerprint: "a".repeat(64),
      source_fingerprint_scheme: "hmac-sha256-v1",
      source_fingerprint_key_version: "v1",
      classification_authoritative: false,
      upload_classification_exact: true,
      preflight_required: true,
      sample_values_truncated: false,
    });
  }
  if (path === "/api/v1/custom-fields/mode" && method === "GET") {
    if (server.modeUnavailable) return json({ error: { code: "forbidden", message: "" } }, 403);
    return json({ custom_fields_mode: server.mode });
  }
  if (path === "/api/v1/subscriber-imports/remap-options") {
    return json({
      merge_fields: [
        { kind: "email", label: "Email (required)" },
        { kind: "name", label: "Name" },
        { kind: "tags", label: "Tags" },
        { kind: "custom", label: "Custom field" },
        { kind: "ignore", label: "Skip this column" },
      ],
      custom_fields: server.declared,
    });
  }
  if (path === `/api/v1/subscriber-imports/${IMPORT_ID}` && method === "PATCH") {
    server.revision += 1;
    return json({ id: IMPORT_ID, status: "preview", updated: true, configuration_revision: server.revision });
  }
  if (path === `/api/v1/subscriber-imports/${IMPORT_ID}/confirm` && method === "POST") {
    if ((body as { dry_run?: boolean }).dry_run) {
      return json({
        id: IMPORT_ID,
        status: "preview",
        dry_run: true,
        dry_run_results: {
          rows_total: 3,
          would_create: 1,
          would_update: 0,
          would_skip: 0,
          would_fail: 2,
          file_dupes: 0,
          rows: [
            { row_number: 1, outcome: "create" },
            { row_number: 2, outcome: "fail", error_code: "erasure_blocked", error: ERASED },
            { row_number: 3, outcome: "fail", error_code: "unknown_custom_field", error: UNDEFINED_PLAN },
          ],
          detail_capped: false,
        },
      });
    }
    if (server.confirmGate) await server.confirmGate;
    server.statuses[IMPORT_ID] = "queued";
    return json({ id: IMPORT_ID, status: "queued" }, 202);
  }
  if (path === `/api/v1/subscriber-imports/${IMPORT_ID}` && method === "GET") {
    return json({
      id: IMPORT_ID,
      status: "ready",
      rows_total: 3,
      rows_imported: 1,
      rows_skipped: 0,
      rows_failed: 2,
      processed_rows: 3,
      configuration_revision: server.revision,
    });
  }
  if (path === `/api/v1/subscriber-imports/${IMPORT_ID}/errors` && method === "GET") {
    return json({
      items: [
        { row_number: 2, error_code: "erasure_blocked", error: ERASED, created_at: "2026-09-15T04:00:00Z" },
        { row_number: 3, error_code: "unknown_custom_field", error: UNDEFINED_PLAN, created_at: "2026-09-15T04:00:00Z" },
      ],
      total: 2,
      limit: 20,
      offset: 0,
    });
  }
  if (path.endsWith("/cancel") && method === "POST") {
    // As the API does: {"expected_status":"preview"} applies only to an
    // unconfirmed upload and leaves anything else untouched.
    const id = path.split("/")[4];
    const current = server.statuses[id] ?? "preview";
    if ((body as { expected_status?: string } | undefined)?.expected_status === "preview" && current !== "preview") {
      return json(
        {
          error: {
            code: "not_a_preview",
            message: "This upload has already started importing, finished or been discarded, so there is nothing to discard.",
          },
        },
        409,
      );
    }
    server.statuses[id] = "cancelled";
    return json({ id, status: "cancelled", cancel_requested: true }, 202);
  }
  return json({ error: { code: "not_found", message: "" } }, 404);
}

function patchBodies(): Record<string, unknown>[] {
  return server.requests.filter((r) => r.method === "PATCH").map((r) => r.body as Record<string, unknown>);
}

function cancels(id: string): Recorded[] {
  return server.requests.filter((r) => r.method === "POST" && r.path === `/api/v1/subscriber-imports/${id}/cancel`);
}

async function waitFor<T>(probe: () => T | null | undefined | false, label: string, timeoutMs = 10_000): Promise<T> {
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

async function mountPage() {
  const Page = (await import("@/app/(dashboard)/app/subscribers/import/page")).default;
  return renderPage(Page);
}

async function reachMapStep(container: HTMLElement): Promise<void> {
  const input = container.querySelector<HTMLInputElement>("#import-file");
  if (!input) throw new Error("file input not rendered");
  const dt = new DataTransfer();
  dt.items.add(new File(["email,plan\nada@example.com,pro\n"], "plans.csv", { type: "text/csv" }));
  await act(async () => {
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  click(button("Preview", container));
  await waitFor(() => container.textContent?.includes("Map 2 columns") || container.textContent?.includes("Map 3 columns"), "the map step");
}

async function reachReviewStep(container: HTMLElement): Promise<void> {
  await reachMapStep(container);
  click(button("Continue to consent", container));
  await waitFor(() => queryButton("Continue without proof", container), "the consent step");
  click(button("Continue without proof", container));
  await waitFor(() => container.textContent?.includes("Row preview"), "the review step");
  click(field(/^I reviewed the preflight/, container) as HTMLInputElement);
  click(field(/^2 rows will fail/, container) as HTMLInputElement);
}

function checkbox(label: RegExp, container: HTMLElement): HTMLInputElement {
  return field(label, container) as HTMLInputElement;
}

beforeEach(() => {
  server.requests = [];
  server.revision = 1;
  server.mode = "auto";
  server.modeUnavailable = false;
  server.imports = [];
  server.statuses = {};
  server.confirmGate = null;
  server.declared = [{ key: "age", label: "Age", type: "number" }];
  toasts.length = 0;
  server.columns = [
    { index: 0, name: "email", kind: "email" },
    { index: 1, name: "plan", kind: "custom", custom_key: "plan" },
  ];
  setOnlineStatusForTest("online");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const url = new URL(raw, "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
      server.requests.push({ method, path: url.pathname, query: url.searchParams, body });
      return handle(method, url.pathname, body);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the Map step and new custom fields", () => {
  it("auto mode: offers to create the field, saves the choice with the mapping, and Review lists it", async () => {
    const { container, root } = await mountPage();
    try {
      await reachMapStep(container);
      const create = checkbox(/^Create 1 new custom field as text: plan/, container);
      expect(create.checked).toBe(true);
      expect(create.disabled).toBe(false);
      expect(container.textContent).toContain("New field");

      click(button("Continue to consent", container));
      await waitFor(() => container.textContent?.includes("Consent evidence for these contacts"), "the consent step");
      expect(patchBodies()[0]).toMatchObject({ on_existing: "skip", auto_create_properties: true });

      click(button("Continue without proof", container));
      await waitFor(() => container.textContent?.includes("Row preview"), "the review step");
      expect(container.textContent).toContain("Custom fields: this import creates 1 new text field when it runs — plan.");
      expect(container.textContent).toContain(ERASED);
    } finally {
      unmount(root);
    }
  }, 30_000);

  it("auto mode: an operator who opts out saves auto_create_properties false", async () => {
    const { container, root } = await mountPage();
    try {
      await reachMapStep(container);
      click(checkbox(/^Create 1 new custom field as text: plan/, container));
      expect(container.textContent).toContain(
        "Rows with a value for this column won't be imported unless the field exists.",
      );
      click(button("Continue to consent", container));
      await waitFor(() => patchBodies().length === 1, "the mapping PATCH");
      expect(patchBodies()[0]).toMatchObject({ auto_create_properties: false });
    } finally {
      unmount(root);
    }
  }, 30_000);

  it("strict mode: the option is unavailable, points to Settings, and never asks to create", async () => {
    server.mode = "strict";
    const { container, root } = await mountPage();
    try {
      await reachMapStep(container);
      const create = checkbox(/^Create 1 new custom field: plan/, container);
      expect(create.disabled).toBe(true);
      expect(create.checked).toBe(false);
      const link = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(
        (a) => a.textContent?.startsWith("Settings › Custom fields") && a.closest('[role="note"]'),
      );
      expect(link?.getAttribute("href")).toBe("/app/settings/custom-fields");
      expect(link?.textContent).toBe("Settings › Custom fields (opens in a new tab)");
      expect(container.textContent).toContain("This workspace only accepts custom fields defined in");
      click(button("Continue to consent", container));
      await waitFor(() => patchBodies().length === 1, "the mapping PATCH");
      expect(patchBodies()[0]).toMatchObject({ auto_create_properties: false });
    } finally {
      unmount(root);
    }
  }, 30_000);

  it("strict mode: a field defined in Settings meanwhile stops showing as new", async () => {
    server.mode = "strict";
    const { container, root } = await mountPage();
    try {
      await reachMapStep(container);
      expect(container.textContent).toContain("New field");
      const remapReads = () => server.requests.filter((r) => r.path === "/api/v1/subscriber-imports/remap-options").length;
      const before = remapReads();

      // Defined in the other tab, and asked about explicitly.
      server.declared = [...server.declared, { key: "plan", label: "Plan", type: "text" }];
      click(button("Check again", container));
      await waitFor(() => !container.querySelector('[role="note"]'), "the notice to clear");
      expect(remapReads()).toBe(before + 1);
      expect(container.textContent).not.toContain("won't be imported");
      expect(container.textContent).not.toContain("New field");
    } finally {
      unmount(root);
    }
  }, 30_000);

  it("strict mode: returning to the tab re-reads the declared fields", async () => {
    server.mode = "strict";
    const { container, root } = await mountPage();
    try {
      await reachMapStep(container);
      expect(container.querySelector('[role="note"]')).not.toBeNull();
      server.declared = [...server.declared, { key: "plan", label: "Plan", type: "text" }];
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => !container.querySelector('[role="note"]'), "the notice to clear on focus");
      expect(container.textContent).not.toContain("New field");
    } finally {
      unmount(root);
    }
  }, 30_000);

  it("fills a valid key when a column becomes a custom field and holds Continue on an invalid one", async () => {
    server.columns = [
      { index: 0, name: "email", kind: "email" },
      { index: 1, name: "plan", kind: "custom", custom_key: "plan" },
      { index: 2, name: "2024 Spend", kind: "ignore" },
    ];
    const { container, root } = await mountPage();
    try {
      await reachMapStep(container);
      type(container.querySelector<HTMLSelectElement>('select[aria-label="Map column 2024 Spend"]')!, "custom");
      const key = container.querySelector<HTMLInputElement>('input[aria-label="Custom field key for 2024 Spend"]')!;
      expect(key.value).toBe("field_2024_spend");
      expect(checkbox(/^Create 2 new custom fields as text: field_2024_spend, plan/, container).checked).toBe(true);

      type(key, "Bad-Key");
      expect(key.getAttribute("aria-invalid")).toBe("true");
      expect(button("Continue to consent", container).disabled).toBe(true);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Give “2024 Spend” a custom field key that starts with a lower-case letter",
      );
      type(key, "age");
      expect(container.textContent).toContain("Existing field · Number");
      expect(button("Continue to consent", container).disabled).toBe(false);
    } finally {
      unmount(root);
    }
  }, 30_000);
});

describe("when the workspace mode can't be read", () => {
  it("promises nothing about new fields and leaves the upload's own default", async () => {
    server.modeUnavailable = true;
    const { container, root } = await mountPage();
    try {
      await reachMapStep(container);
      expect(container.textContent).not.toContain("new custom field");
      click(button("Continue to consent", container));
      await waitFor(() => patchBodies().length === 1, "the mapping PATCH");
      expect(patchBodies()[0]).not.toHaveProperty("auto_create_properties");
    } finally {
      unmount(root);
    }
  }, 30_000);
});

describe("unfinished uploads are discarded", () => {
  it("going Back from Map deletes the preview and keeps the chosen file", async () => {
    const { container, root } = await mountPage();
    try {
      await reachMapStep(container);
      click(button("Back", container));
      await waitFor(() => cancels(IMPORT_ID).length === 1, "the discard request");
      expect(cancels(IMPORT_ID)[0].body).toEqual({ expected_status: "preview" });
      expect(button("Preview", container).disabled).toBe(false);
      expect(container.textContent).toContain("Selected: plans.csv · up to 50 MB.");
    } finally {
      unmount(root);
    }
  }, 30_000);

  it("leaving the wizard mid-upload deletes the preview", async () => {
    const { container, root } = await mountPage();
    await reachMapStep(container);
    unmount(root);
    await waitFor(() => cancels(IMPORT_ID).length === 1, "the discard on leave");
    expect(cancels(IMPORT_ID)[0].body).toEqual({ expected_status: "preview" });
  }, 30_000);

  it("leaving while the import is starting never discards it", async () => {
    let finishConfirm: () => void = () => undefined;
    server.confirmGate = new Promise<void>((resolve) => {
      finishConfirm = resolve;
    });
    const { container, root } = await mountPage();
    await reachReviewStep(container);
    click(button("Import 1 contact", container));
    await waitFor(
      () => server.requests.some((r) => r.path === `/api/v1/subscriber-imports/${IMPORT_ID}/confirm` && !(r.body as { dry_run?: boolean })?.dry_run),
      "the confirm request",
    );
    unmount(root);
    finishConfirm();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(cancels(IMPORT_ID)).toHaveLength(0);
    expect(server.statuses[IMPORT_ID]).toBe("queued");
  }, 30_000);

  it("lists an earlier unfinished upload by its file name and discards it", async () => {
    server.imports = [
      {
        id: DRAFT_ID,
        filename: "",
        status: "preview",
        rows_total: 40,
        processed_rows: 0,
        rows_imported: 0,
        rows_failed: 0,
        cancel_requested: false,
        created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    ];
    const { container, root } = await mountPage();
    try {
      const section = await waitFor(
        () => container.querySelector<HTMLElement>('section[aria-label="Unfinished uploads"]'),
        "the unfinished uploads section",
      );
      expect(section.textContent).toContain("An upload was never imported");
      expect(section.textContent).toContain("an untitled file · uploaded 5 minutes ago");
      expect(section.textContent).not.toContain(DRAFT_ID);
      click(button("Discard…", section));
      const dialog = await waitFor(
        () => dialogs().find((d) => d.textContent?.includes("Discard this upload?")),
        "the discard confirmation",
      );
      click(button("Discard upload", dialog));
      await waitFor(() => cancels(DRAFT_ID).length === 1, "the draft discard");
      expect(cancels(DRAFT_ID)[0].body).toEqual({ expected_status: "preview" });
      await waitFor(() => toasts.find((t) => t.level === "success"), "the discard confirmation toast");
      expect(toasts).toEqual([{ level: "success", text: "Upload discarded." }]);
    } finally {
      unmount(root);
    }
  }, 30_000);

  it("a listed upload another tab already confirmed is left running, and says so", async () => {
    server.imports = [
      {
        id: DRAFT_ID,
        filename: "spring.csv",
        status: "preview",
        rows_total: 40,
        processed_rows: 0,
        rows_imported: 0,
        rows_failed: 0,
        cancel_requested: false,
        created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    ];
    server.statuses[DRAFT_ID] = "queued";
    const { container, root } = await mountPage();
    try {
      const section = await waitFor(
        () => container.querySelector<HTMLElement>('section[aria-label="Unfinished uploads"]'),
        "the unfinished uploads section",
      );
      click(button("Discard…", section));
      const dialog = await waitFor(
        () => dialogs().find((d) => d.textContent?.includes("Discard spring.csv?")),
        "the discard confirmation",
      );
      click(button("Discard upload", dialog));
      await waitFor(() => toasts.length > 0, "the outcome toast");
      expect(server.statuses[DRAFT_ID]).toBe("queued");
      expect(toasts).toEqual([
        {
          level: "message",
          text: "This upload wasn't discarded",
          description: "It has already started importing, or it was discarded somewhere else.",
        },
      ]);
      await waitFor(
        () => server.requests.filter((r) => r.method === "GET" && r.path === "/api/v1/subscriber-imports").length >= 2,
        "the refreshed upload list",
      );
    } finally {
      unmount(root);
    }
  }, 30_000);
});

describe("the result screen explains failed rows", () => {
  it("lists each recorded failure with its reason beside the CSV", async () => {
    const { container, root } = await mountPage();
    try {
      await reachReviewStep(container);
      click(button("Import 1 contact", container));

      await waitFor(() => container.textContent?.includes("Rows that weren't imported"), "the failed-row list");
      const errorsRead = server.requests.find(
        (r) => r.method === "GET" && r.path === `/api/v1/subscriber-imports/${IMPORT_ID}/errors`,
      );
      expect(errorsRead?.query.get("limit")).toBe("20");
      expect(container.textContent).toContain(
        "Row 2 — Permanently erased when the contact was deleted or by a privacy request, so it can't be added again.",
      );
      expect(container.textContent).toContain(`Row 3 — ${UNDEFINED_PLAN}`);
      expect(container.textContent).toContain("Download the 2 failed rows (CSV)");
    } finally {
      unmount(root);
    }
  }, 30_000);
});
