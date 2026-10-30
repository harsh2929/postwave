// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The CSV import wizard's destination list, over a stateful stubbed transport
// shaped like the real API:
//
//   Map step   offers the workspace's lists, and the choice travels on the same
//              PATCH as the column mapping (target_list_id), so the import adds
//              the contacts itself instead of leaving a second bulk "Add to
//              list" for the operator to remember.
//   Mapping    the per-column dropdown offers the first/last name destinations
//              the API now publishes, so a "first_name" column can be a name
//              instead of a brand-new custom field.
//   Result     names the list the contacts joined.
//   Outage     a lists read that fails says so and never blocks the import.
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
vi.mock("sonner", () => {
  const noop = () => "toast-id";
  return {
    toast: Object.assign(noop, { error: noop, success: noop, warning: noop, message: noop }),
  };
});

import { setOnlineStatusForTest } from "@/lib/online-manager";
import { renderPage, unmount } from "./_harness";
import { button, click, queryButton, field } from "../helpers/subscriber-directory-harness";

const IMPORT_ID = "3f2d6c1a-7b8e-4c5d-9e0f-1a2b3c4d5e6f";
const NEWSLETTER_ID = 42;

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

const server = {
  requests: [] as Recorded[],
  revision: 1,
  listsFail: false,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function handle(method: string, path: string, body: unknown): Response {
  if (path === "/api/v1/subscriber-imports" && method === "GET") return json({ imports: [] });
  // The gateway proxies Listmonk, which wraps rows in {data:{results:[…]}}.
  if (path === "/api/v1/lists" && method === "GET") {
    if (server.listsFail) return json({ error: { code: "repo_unavailable", message: "" } }, 503);
    return json({
      data: {
        results: [
          { id: NEWSLETTER_ID, name: "Newsletter", subscriber_count: 3 },
          { id: 7, name: "Beta testers", subscriber_count: 0 },
        ],
      },
    });
  }
  if (path === "/api/v1/custom-fields/mode" && method === "GET") return json({ custom_fields_mode: "auto" });
  if (path === "/api/v1/subscriber-imports/remap-options" && method === "GET") {
    return json({
      merge_fields: [
        { kind: "email", label: "Email (required)" },
        { kind: "name", label: "Full name" },
        { kind: "first_name", label: "First name" },
        { kind: "last_name", label: "Last name" },
        { kind: "tags", label: "Tags" },
        { kind: "custom", label: "Custom field" },
        { kind: "ignore", label: "Skip this column" },
      ],
      custom_fields: [],
    });
  }
  if (path === "/api/v1/subscriber-imports/preview" && method === "POST") {
    return json({
      id: IMPORT_ID,
      status: "preview",
      mapping: {
        path: "",
        headers: ["email", "first_name", "last_name"],
        columns: [
          { index: 0, name: "email", kind: "email" },
          { index: 1, name: "first_name", kind: "first_name" },
          { index: 2, name: "last_name", kind: "last_name" },
        ],
        rows: 1,
      },
      sample_rows: [{ email: "ada@example.com", first_name: "Ada", last_name: "Lovelace" }],
      rows_total: 1,
      rows_new: 1,
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
          rows_total: 1,
          would_create: 1,
          would_update: 0,
          would_skip: 0,
          would_fail: 0,
          file_dupes: 0,
          rows: [{ row_number: 1, outcome: "create" }],
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
      rows_total: 1,
      rows_imported: 1,
      rows_skipped: 0,
      rows_failed: 0,
      processed_rows: 1,
      configuration_revision: server.revision,
      target_list_id: "f2b7c5e0-0000-4000-8000-000000000042",
    });
  }
  if (path.endsWith("/cancel") && method === "POST") {
    return json({ id: IMPORT_ID, status: "cancelled", cancel_requested: true }, 202);
  }
  return json({ error: { code: "not_found", message: "" } }, 404);
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

async function reachMapStep(container: HTMLElement): Promise<void> {
  const input = container.querySelector<HTMLInputElement>("#import-file");
  if (!input) throw new Error("file input not rendered");
  const dt = new DataTransfer();
  dt.items.add(
    new File(["email,first_name,last_name\nada@example.com,Ada,Lovelace\n"], "contacts.csv", { type: "text/csv" }),
  );
  await act(async () => {
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  click(button("Preview", container));
  await waitFor(() => container.textContent?.includes("Map 3 columns"), "the map step");
}

function targetListSelect(container: HTMLElement): HTMLSelectElement {
  const select = container.querySelector<HTMLSelectElement>("#import-target-list");
  if (!select) throw new Error("the target-list control is not rendered");
  return select;
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function patchBodies(): Record<string, unknown>[] {
  return server.requests.filter((r) => r.method === "PATCH").map((r) => r.body as Record<string, unknown>);
}

beforeEach(() => {
  server.requests = [];
  server.revision = 1;
  server.listsFail = false;
  setOnlineStatusForTest("online");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const url = new URL(raw, "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
      server.requests.push({ method, path: url.pathname, body });
      return handle(method, url.pathname, body);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function mountPage() {
  const Page = (await import("@/app/(dashboard)/app/subscribers/import/page")).default;
  return renderPage(Page);
}

describe("the import wizard's destination list", () => {
  it("saves the chosen list with the mapping and names it on the result", async () => {
    const { container, root } = await mountPage();
    try {
      await reachMapStep(container);
      // A one-row file used to read "1 rows", and the list picker "(3 contacts)"
      // would have read "(1 contacts)" for a list of one.
      expect(container.textContent).toContain("1 row (1 new, 0 existing)");
      const select = await waitFor(() => {
        const control = container.querySelector<HTMLSelectElement>("#import-target-list");
        return control && control.querySelector('option[value="42"]') ? control : null;
      }, "the workspace's lists");
      expect(select.textContent).toContain("Beta testers (0 contacts)");
      expect(select.textContent).toContain("Newsletter");
      // Opt in: the default must stay "no list", which is what an import has
      // always done.
      expect(select.value).toBe("");
      await choose(select, String(NEWSLETTER_ID));

      click(button("Continue to consent", container));
      await waitFor(() => queryButton("Continue without proof", container), "the consent step");
      const saved = patchBodies().find((patch) => "mapping" in patch);
      expect(saved?.target_list_id).toBe(String(NEWSLETTER_ID));

      click(button("Continue without proof", container));
      await waitFor(() => container.textContent?.includes("Row preview"), "the review step");
      click(field(/^I reviewed the preflight/, container) as HTMLInputElement);
      click(button(/^Import 1 contact/, container));
      await waitFor(() => container.textContent?.includes("Import complete"), "the result step");
      expect(container.textContent).toContain("The contacts this import wrote are now on");
      expect(container.textContent).toContain("Newsletter");
    } finally {
      unmount(root);
    }
  });

  it("sends an empty target list when none is chosen, and never invents one", async () => {
    const { container, root } = await mountPage();
    try {
      await reachMapStep(container);
      await waitFor(() => container.querySelector("#import-target-list"), "the target-list control");
      click(button("Continue to consent", container));
      await waitFor(() => queryButton("Continue without proof", container), "the consent step");
      const saved = patchBodies().find((patch) => "mapping" in patch);
      expect(saved?.target_list_id).toBe("");
    } finally {
      unmount(root);
    }
  });

  it("offers the first/last name destinations the API publishes", async () => {
    const { container, root } = await mountPage();
    try {
      await reachMapStep(container);
      const select = await waitFor(() => {
        const controls = Array.from(
          container.querySelectorAll<HTMLSelectElement>("select[aria-label^='Map column']"),
        );
        return controls.find((control) => control.getAttribute("aria-label") === "Map column first_name") ?? null;
      }, "the first_name column's mapping control");
      // The detected mapping already points the column at the name field,
      // instead of at a custom field the workspace has never heard of.
      expect(select.value).toBe("first_name");
      const options = Array.from(select.options).map((option) => option.textContent?.trim());
      expect(options).toEqual(
        expect.arrayContaining(["Full name", "First name", "Last name", "Custom field"]),
      );
      expect(container.textContent).not.toContain("New field");
    } finally {
      unmount(root);
    }
  });

  it("says so when the lists cannot be read, and still lets the import run", async () => {
    server.listsFail = true;
    const { container, root } = await mountPage();
    try {
      await reachMapStep(container);
      await waitFor(
        () => container.textContent?.includes("couldn’t be loaded"),
        "the lists-unavailable explanation",
      );
      const select = targetListSelect(container);
      expect(select.value).toBe("");
      click(button("Continue to consent", container));
      await waitFor(() => queryButton("Continue without proof", container), "the consent step");
      const saved = patchBodies().find((patch) => "mapping" in patch);
      expect(saved?.target_list_id).toBe("");
    } finally {
      unmount(root);
    }
  });
});
