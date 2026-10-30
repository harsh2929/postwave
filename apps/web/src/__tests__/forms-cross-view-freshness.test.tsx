// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Form writes must reach the other screens that show forms (CACHE-09). A form
// created on /app/forms/new was missing from /app/forms for up to 30 s after
// returning to it, because the list page's cached query was still "fresh";
// and a form's save never refreshed the Forms tab of the list it targets.
//
// Real screens over ONE QueryClient, in front of an in-memory forms API whose
// reads follow its writes.

import { act, createElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "./_roots";
import { importBeforeTests, waitFor } from "./pages/_wait";

interface ServerForm {
  id: string;
  name: string;
  slug: string;
  status: "draft" | "published" | "archived";
  targetListId?: string;
}

const mocks = vi.hoisted(() => ({
  forms: [] as ServerForm[],
  requests: [] as string[],
  whoami: vi.fn(),
  push: vi.fn(),
  params: { id: "" },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function formBody(f: ServerForm) {
  return {
    id: f.id,
    tenantId: "22222222-2222-4222-8222-222222222222",
    slug: f.slug,
    name: f.name,
    optInMode: "double",
    structure: { fields: [] },
    settings: f.targetListId ? { targetListId: f.targetListId } : {},
    status: f.status,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-15T03:00:00Z",
  };
}

async function serve(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  mocks.requests.push(`${method} ${path}`);
  if (method === "GET" && path === "/api/v1/forms") {
    return mocks.forms.map((f) => ({
      ...formBody(f),
      submissions30d: 0,
      visits30d: 0,
      conversionRate: 0,
    }));
  }
  if (method === "POST" && path === "/api/v1/forms") {
    const input = body as { name: string; slug: string };
    const created: ServerForm = {
      id: `form-${mocks.forms.length + 1}`,
      name: input.name,
      slug: input.slug,
      status: "draft",
    };
    mocks.forms.push(created);
    return formBody(created);
  }
  const one = /^\/api\/v1\/forms\/([^/]+)$/.exec(path);
  if (one) {
    const form = mocks.forms.find((f) => f.id === decodeURIComponent(one[1]!));
    if (!form) throw Object.assign(new Error("not found"), { status: 404 });
    if (method === "PATCH") {
      const patch = body as {
        status?: ServerForm["status"];
        name?: string;
        settings?: { targetListId?: string };
      };
      if (patch.status) form.status = patch.status;
      if (patch.name) form.name = patch.name;
      if (patch.settings) form.targetListId = patch.settings.targetListId;
    }
    return formBody(form);
  }
  const listForms = /^\/api\/v1\/lists\/(\d+)\/forms$/.exec(path);
  if (method === "GET" && listForms) {
    return {
      forms: mocks.forms
        .filter((f) => f.targetListId === listForms[1])
        .map((f) => ({
          id: f.id,
          slug: f.slug,
          name: f.name,
          status: f.status,
          opt_in_mode: "double",
          updated_at: "2026-09-15T03:00:00Z",
        })),
    };
  }
  if (method === "GET" && /^\/api\/v1\/lists\/\d+\/automations$/.test(path)) {
    return { automations: [] };
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
      post: (path: string, body?: unknown) => serve("POST", path, body),
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
vi.mock("@/lib/use-unsaved-changes-guard", () => ({
  useUnsavedChangesGuard: vi.fn(),
  canNavigateWithUnsavedChanges: () => true,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.push,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/forms",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => mocks.params,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OPERATOR = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "operator@example.com",
  role: "owner" as const,
  effective_role: "admin" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Acme Outfitters",
  workspace_slug: "acme",
};

importBeforeTests(
  () => import("@/app/(dashboard)/app/forms/forms-list-client"),
  () => import("@/app/(dashboard)/app/forms/new/page"),
  () => import("@/app/(dashboard)/app/forms/[id]/page"),
  () => import("@/app/(dashboard)/app/lists/[id]/_components/list-forms-automations-tab"),
  () => import("@/lib/forms-types"),
);

beforeEach(() => {
  mocks.forms = [{ id: "form-1", name: "Welcome", slug: "welcome", status: "draft" }];
  mocks.requests = [];
  mocks.whoami.mockResolvedValue(OPERATOR);
});

afterEach(() => {
  unmountRoots();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function mount(client: QueryClient, ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = trackRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return root;
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

async function type(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
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

describe("forms are one resource across screens (CACHE-09)", () => {
  it("a form created on /app/forms/new is listed when /app/forms is shown again", async () => {
    const [{ FormsListClient }, { default: NewFormPage }] = await Promise.all([
      import("@/app/(dashboard)/app/forms/forms-list-client"),
      import("@/app/(dashboard)/app/forms/new/page"),
    ]);
    const client = newClient();
    // The server component's payload when /app/forms was first rendered.
    const initialForms = (await serve("GET", "/api/v1/forms")) as never;

    const list = mount(client, <FormsListClient initialForms={initialForms} />);
    // Viewed as the signed-in operator: row selection unlocks once the
    // workspace identity has resolved.
    await waitFor(() => {
      expect(document.body.textContent).toContain("Welcome");
      expect(
        document.querySelector<HTMLInputElement>(
          'input[aria-label="Select all forms on this page"]',
        )?.disabled,
      ).toBe(false);
    });
    act(() => list.unmount());

    const create = mount(client, <NewFormPage />);
    await waitFor(() => {
      expect(document.querySelector<HTMLInputElement>("#form-name")).not.toBeNull();
    });
    await type(document.querySelector<HTMLInputElement>("#form-name")!, "Spring launch");
    // The blank starter: no follow-up structure write.
    await click(
      [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.startsWith("Blank form"),
      )!,
    );
    await click(button("Create"));
    await waitFor(() => {
      expect(mocks.push).toHaveBeenCalledWith(expect.stringMatching(/^\/app\/forms\/form-2$/));
    });
    act(() => create.unmount());

    // Back on /app/forms within the list query's staleTime.
    mount(client, <FormsListClient initialForms={initialForms} />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Spring launch");
    });
  });

  it("a status change made from /app/forms refreshes the Forms tab of the list it targets", async () => {
    mocks.forms[0]!.targetListId = "7";
    const [{ FormsListClient }, { ListFormsAutomationsTab }] = await Promise.all([
      import("@/app/(dashboard)/app/forms/forms-list-client"),
      import("@/app/(dashboard)/app/lists/[id]/_components/list-forms-automations-tab"),
    ]);
    const initialForms = (await serve("GET", "/api/v1/forms")) as never;
    mount(
      newClient(),
      <>
        <section data-screen="list-forms">
          <ListFormsAutomationsTab
            list={{
              id: 7,
              name: "Newsletter",
              type: "private",
              optin: "single",
              tags: [],
              description: "",
            }}
            tenantId={OPERATOR.tenant_id}
            roleKey="admin"
          />
        </section>
        <section data-screen="forms-index">
          <FormsListClient initialForms={initialForms} />
        </section>
      </>,
    );
    const tab = () => document.querySelector('[data-screen="list-forms"]')!;
    const index = () => document.querySelector('[data-screen="forms-index"]')!;
    const rowCheckbox = () =>
      index().querySelector<HTMLInputElement>('input[aria-label="Select Welcome"]');
    await waitFor(() => {
      expect(tab().textContent).toContain("draft");
      expect(rowCheckbox()?.disabled).toBe(false);
    });

    await click(rowCheckbox()!);
    await click(button("Publish", index()));
    await waitFor(() => {
      expect(mocks.requests).toContain("PATCH /api/v1/forms/form-1");
      expect(tab().textContent).toContain("published");
    });
  });

  it("publishing a form refreshes the Forms tab of the list it targets", async () => {
    mocks.forms[0]!.targetListId = "7";
    mocks.params = { id: "form-1" };
    const [{ default: FormEditorPage }, { ListFormsAutomationsTab }] =
      await Promise.all([
        import("@/app/(dashboard)/app/forms/[id]/page"),
        import("@/app/(dashboard)/app/lists/[id]/_components/list-forms-automations-tab"),
      ]);
    mount(
      newClient(),
      <>
        <section data-screen="list-forms">
          <ListFormsAutomationsTab
            list={{
              id: 7,
              name: "Newsletter",
              type: "private",
              optin: "single",
              tags: [],
              description: "",
            }}
            tenantId={OPERATOR.tenant_id}
            roleKey="admin"
          />
        </section>
        <section data-screen="form-editor">
          <FormEditorPage />
        </section>
      </>,
    );
    const tab = () => document.querySelector('[data-screen="list-forms"]')!;
    const editor = () => document.querySelector('[data-screen="form-editor"]')!;
    await waitFor(() => {
      expect(tab().textContent).toContain("Welcome");
      expect(tab().textContent).toContain("draft");
      button("Publish", editor());
    });

    await click(button("Publish", editor()));
    await waitFor(() => {
      expect(mocks.requests).toContain("PATCH /api/v1/forms/form-1");
      expect(tab().textContent).toContain("published");
    });
  });
});
