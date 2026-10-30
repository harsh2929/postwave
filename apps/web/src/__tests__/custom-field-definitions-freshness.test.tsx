// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// A custom field deleted in Settings must stop being offered everywhere
// (CACHE-05). GET /api/v1/custom-fields was cached under five unrelated keys,
// and the settings page invalidated only its own: the deleted field stayed on
// the subscriber profile for 30 s, in the edit dialog for 5 min, in the
// directory's bulk "Custom field…" dialog, and in the segment builder's field
// picker for a day — and the settings page's own fill-rate column was never
// refreshed.
//
// Real screens over ONE QueryClient, in front of an in-memory API whose reads
// follow the writes. The segment builder runs with a durable role (owner)
// that differs from the effective one (admin) — the shape that makes a
// role-exact invalidation miss it.

import { act, createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "./_roots";
import { importBeforeTests, waitFor } from "./pages/_wait";

interface Field {
  id: string;
  tenant_id: string;
  key: string;
  label: string;
  type: "string";
  config: null;
  created_at: string;
  updated_at: string;
}

const mocks = vi.hoisted(() => ({
  fields: [] as Field[],
  mode: "auto" as "strict" | "auto" | "off",
  requests: [] as string[],
  whoami: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

async function serve(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  mocks.requests.push(`${method} ${path}`);
  if (method === "GET" && path === "/api/v1/custom-fields") {
    return mocks.fields.map((f) => ({ ...f }));
  }
  if (method === "GET" && path === "/api/v1/custom-fields/mode") {
    return { custom_fields_mode: mocks.mode };
  }
  if (method === "PATCH" && path === "/api/v1/custom-fields/mode") {
    mocks.mode = (body as { custom_fields_mode: typeof mocks.mode })
      .custom_fields_mode;
    return { custom_fields_mode: mocks.mode };
  }
  if (method === "GET" && path === "/api/v1/settings/custom-fields/usage") {
    return {
      total_subscribers: 4,
      fields: mocks.fields.map((f) => ({
        key: f.key,
        label: f.label,
        filled: 1,
        rate: 0.25,
      })),
    };
  }
  if (method === "GET" && /\/references$/.test(path)) {
    return { segments: [], flows: [], forms: [] };
  }
  if (method === "GET" && path === "/api/v1/segments/predicate-registry") {
    return {
      registry_version: "test",
      boolean_ops: ["and", "or"],
      predicates: [],
      metrics: [],
      custom_objects: [],
    };
  }
  if (method === "POST" && path === "/api/v1/segments/preview") {
    return {
      count: 0,
      workspace_total: 4,
      workspace_percentage: 0,
      generated_at: "2026-09-15T03:00:00Z",
      archive_scope: "active_only",
      applied_exclusions: [],
    };
  }
  const del = /^\/api\/v1\/custom-fields\/([^/]+)$/.exec(path);
  if (method === "DELETE" && del) {
    mocks.fields = mocks.fields.filter(
      (f) => f.id !== decodeURIComponent(del[1]!),
    );
    return undefined;
  }
  throw Object.assign(new Error(`not found: ${method} ${path}`), {
    status: 404,
  });
}

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: (path: string) => serve("GET", path),
      post: (path: string) => serve("POST", path),
      patch: (path: string, body?: unknown) => serve("PATCH", path, body),
      delete: (path: string) => serve("DELETE", path),
    },
  };
});
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoami,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/settings/custom-fields",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "22222222-2222-4222-8222-222222222222";
const OPERATOR = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: TENANT,
  email: "operator@example.com",
  role: "owner" as const,
  effective_role: "admin" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Acme Outfitters",
  workspace_slug: "acme",
};
const SUBSCRIBER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const field = (id: string, key: string, label: string): Field => ({
  id,
  tenant_id: TENANT,
  key,
  label,
  type: "string",
  config: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
});

importBeforeTests(
  () => import("@/app/(dashboard)/app/settings/custom-fields/page"),
  () => import("@/app/(dashboard)/app/subscribers/[id]/_data-panels"),
  () => import("@/app/(dashboard)/app/subscribers/subscribers-custom-fields"),
  () => import("@/components/subscribers/BulkFieldValueDialog"),
  () => import("@/components/segments/segment-editor"),
  () => import("@/lib/custom-fields-api"),
);

beforeEach(() => {
  mocks.fields = [
    field("f-plan", "plan", "Plan"),
    field("f-loyalty", "loyalty_tier", "Loyalty tier"),
  ];
  mocks.mode = "auto";
  mocks.requests = [];
  mocks.whoami.mockResolvedValue(OPERATOR);
});

afterEach(() => {
  unmountRoots();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function mount(ui: ReactNode): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = trackRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
}

function region(name: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-screen="${name}"]`);
  if (!el) throw new Error(`screen ${name} is not mounted`);
  return el;
}

function screen(name: string, ui: ReactNode): ReactNode {
  return createElement("section", { "data-screen": name, key: name }, ui);
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
    await flush();
  });
}

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button "${text}"`);
  return found;
}

function openDialog(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>('[role="dialog"]');
  return all[all.length - 1] ?? null;
}

describe("custom-field definitions are one resource (CACHE-05)", () => {
  it("a field deleted in Settings leaves the profile, the edit dialog, the bulk dialog and the segment builder", async () => {
    const [
      { default: CustomFieldsSettingsPage },
      { CustomFieldValuesPanel },
      { useCustomFields, CustomFieldsEditor },
      { BulkFieldValueDialog },
      { SegmentEditor },
    ] = await Promise.all([
      import("@/app/(dashboard)/app/settings/custom-fields/page"),
      import("@/app/(dashboard)/app/subscribers/[id]/_data-panels"),
      import("@/app/(dashboard)/app/subscribers/subscribers-custom-fields"),
      import("@/components/subscribers/BulkFieldValueDialog"),
      import("@/components/segments/segment-editor"),
    ]);

    // The edit dialog's own composition: the hook it calls, the editor it
    // renders the definitions with.
    function EditDialogFields() {
      const definitions = useCustomFields();
      return (
        <CustomFieldsEditor
          fields={Array.isArray(definitions.data) ? definitions.data : []}
          values={{}}
          onChange={() => undefined}
          idPrefix="edit"
        />
      );
    }

    mount(
      <>
        {screen("settings", <CustomFieldsSettingsPage />)}
        {screen(
          "profile",
          <CustomFieldValuesPanel
            id={SUBSCRIBER_ID}
            record={
              {
                id: SUBSCRIBER_ID,
                email: "bob@example.com",
                status: "enabled",
                tags: [],
                custom_fields: {},
                version: `"subscriber:${SUBSCRIBER_ID}:v1"`,
              } as never
            }
            email="bob@example.com"
            tenantId={TENANT}
            role="admin"
            authority={{
              tenantId: TENANT,
              userId: OPERATOR.user_id,
              role: "admin",
            }}
            onRecordRefetch={() => undefined}
          />,
        )}
        {screen("edit-dialog", <EditDialogFields />)}
        {screen(
          "directory",
          <BulkFieldValueDialog
            mode="custom"
            count={1}
            resolveIds={async () => [SUBSCRIBER_ID]}
            canAdmin
            authority={{
              tenantId: TENANT,
              userId: OPERATOR.user_id,
              role: "admin",
            }}
          />,
        )}
        {screen("segment-builder", <SegmentEditor />)}
      </>,
    );

    const segmentFieldOffered = () =>
      [
        ...region("segment-builder").querySelectorAll("option"),
      ].some((o) => o.value === "custom.loyalty_tier");
    const bulkFieldOffered = () =>
      [...(openDialog()?.querySelectorAll("option") ?? [])].some(
        (o) => o.value === "loyalty_tier",
      );
    const offered = () => ({
      settings:
        region("settings").textContent?.includes("loyalty_tier") ?? false,
      profile: [
        ...region("profile").querySelectorAll(
          '[data-testid="subscriber-custom-field"]',
        ),
      ].some((row) => row.textContent?.includes("loyalty_tier")),
      editDialog: Boolean(
        region("edit-dialog").querySelector("#edit-loyalty_tier"),
      ),
      segmentBuilder: segmentFieldOffered(),
    });

    // Every screen has read the definitions, the bulk dialog included (it
    // reads only while open, and keeps what it read).
    await waitFor(() => {
      expect(offered()).toEqual({
        settings: true,
        profile: true,
        editDialog: true,
        segmentBuilder: true,
      });
    });
    await click(button("Custom field…", region("directory")));
    await waitFor(() => {
      expect(bulkFieldOffered()).toBe(true);
    });
    await click(button("Cancel", openDialog()!));
    await waitFor(() => {
      expect(openDialog()).toBeNull();
    });
    const usageReadsBefore = mocks.requests.filter(
      (r) => r === "GET /api/v1/settings/custom-fields/usage",
    ).length;

    const row = [...region("settings").querySelectorAll("tr")].find((tr) =>
      tr.textContent?.includes("loyalty_tier"),
    );
    await click(button("Delete", row!));
    await waitFor(() => {
      expect(openDialog()?.textContent).toContain("Delete custom field?");
    });
    await click(button("Delete", openDialog()!));
    expect(mocks.requests).toContain("DELETE /api/v1/custom-fields/f-loyalty");

    await waitFor(() => {
      expect(offered()).toEqual({
        settings: false,
        profile: false,
        editDialog: false,
        segmentBuilder: false,
      });
      // The settings page's own fill-rate column re-read as well.
      expect(
        mocks.requests.filter(
          (r) => r === "GET /api/v1/settings/custom-fields/usage",
        ).length,
      ).toBeGreaterThan(usageReadsBefore);
    });

    await click(button("Custom field…", region("directory")));
    await waitFor(() => {
      expect(
        [...(openDialog()?.querySelectorAll("option") ?? [])].some(
          (o) => o.value === "plan",
        ),
      ).toBe(true);
      expect(bulkFieldOffered()).toBe(false);
    });
  });
  it("a validator-mode switch re-reads the policy and nothing a definition write would", async () => {
    const { default: CustomFieldsSettingsPage } = await import(
      "@/app/(dashboard)/app/settings/custom-fields/page"
    );
    mount(screen("settings", createElement(CustomFieldsSettingsPage)));
    const count = (request: string) =>
      mocks.requests.filter((r) => r === request).length;
    const radio = (label: string) =>
      [
        ...region("settings").querySelectorAll<HTMLButtonElement>(
          '[role="radio"]',
        ),
      ].find((r) => r.textContent?.includes(label));
    await waitFor(() => {
      expect(radio("Auto-register")?.getAttribute("aria-checked")).toBe(
        "true",
      );
      expect(count("GET /api/v1/settings/custom-fields/usage")).toBe(1);
    });
    const policyReadsBefore = count("GET /api/v1/custom-fields/mode");

    await click(radio("Strict")!);
    await waitFor(() => {
      expect(openDialog()?.textContent).toContain("Switch validator mode");
    });
    await click(button("Switch mode", openDialog()!));
    expect(mocks.requests).toContain("PATCH /api/v1/custom-fields/mode");

    // The registry that carries the mode reconciles with the server...
    await waitFor(() => {
      expect(count("GET /api/v1/custom-fields/mode")).toBeGreaterThan(
        policyReadsBefore,
      );
      expect(radio("Strict")?.getAttribute("aria-checked")).toBe("true");
    });
    // ...but the tenant's policy is not a definition, a fill rate or a
    // reference: the fill-rate column is not re-read for it.
    await act(flush);
    await act(flush);
    expect(count("GET /api/v1/settings/custom-fields/usage")).toBe(1);
  });
});
