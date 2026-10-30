// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// A write on one audience screen must reach every other screen that shows the
// same server data (CACHE-03, CACHE-04). Each screen used to invalidate only
// its own query: a list deleted on /app/lists stayed in the form editor's
// target-list picker for up to a day and in the subscriber pickers for up to a
// minute; members added on a list never reached the added people's profiles or
// the index's subscriber counts, and a removal on a profile never reached the
// list's Members tab.
//
// The screens are the real components, mounted side by side over ONE
// QueryClient, in front of an in-memory audience server whose reads are
// computed from the state the writes change. Nothing is seeded into the cache
// by hand: a screen shows what it fetched, and shows the write only if it
// fetched again.
//
// The operator is an owner working with an elevated effective role (admin),
// which is how the form picker's durable-role key used to escape the lists
// index's effective-role invalidation.

import { act, createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudienceServer } from "./_audience-server";
import { trackRoot, unmountRoots } from "./_roots";
import { importBeforeTests, waitFor } from "./pages/_wait";

const mocks = vi.hoisted(() => ({
  server: null as unknown as import("./_audience-server").AudienceServer,
  whoami: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: (path: string, opts?: { query?: Record<string, unknown> }) =>
        mocks.server.get(path, opts),
      post: (path: string, body?: unknown) => mocks.server.post(path, body),
      delete: (path: string) => mocks.server.delete(path),
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
  usePathname: () => "/app/lists",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
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
const NEWSLETTER = {
  id: 7,
  postwaveUuid: "33333333-3333-4333-8333-333333333333",
  name: "Newsletter",
};
const DIAG = {
  id: 9,
  postwaveUuid: "44444444-4444-4444-8444-444444444444",
  name: "Diag list",
};
const BOB = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "bob@example.com" };
const AUTHORITY = {
  tenantId: OPERATOR.tenant_id,
  userId: OPERATOR.user_id,
  role: "admin" as const,
};

importBeforeTests(
  () => import("@/app/(dashboard)/app/lists/lists-admin-client"),
  () => import("@/app/(dashboard)/app/forms/[id]/_list-picker"),
  () => import("@/app/(dashboard)/app/subscribers/[id]/_data-panels"),
  () => import("@/app/(dashboard)/app/subscribers/subscriber-list-controls"),
  () => import("@/app/(dashboard)/app/lists/[id]/_components/list-members-tab"),
);

beforeEach(() => {
  mocks.server = new AudienceServer([NEWSLETTER, DIAG], [BOB]);
  mocks.whoami.mockResolvedValue(OPERATOR);
});

afterEach(() => {
  unmountRoots();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function mount(ui: ReactNode): HTMLElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = trackRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return container;
}

/** One screen's region, so an assertion reads only what that screen shows. */
function region(name: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-screen="${name}"]`);
  if (!el) throw new Error(`screen ${name} is not mounted`);
  return el;
}

function screen(name: string, ui: ReactNode): ReactNode {
  return createElement("section", { "data-screen": name, key: name }, ui);
}

function optionTexts(select: HTMLSelectElement | null): string[] {
  return select ? [...select.options].map((o) => o.textContent ?? "") : [];
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

function dialog(): HTMLElement {
  const all = document.querySelectorAll<HTMLElement>('[role="dialog"]');
  const top = all[all.length - 1];
  if (!top) throw new Error("No open dialog");
  return top;
}

describe("the list catalogue is one resource (CACHE-03)", () => {
  it("a list deleted on /app/lists leaves the form picker and both subscriber pickers", async () => {
    const [{ ListsAdminClient }, { TargetListPicker }, { ListMembershipsPanel }, { BulkActionBar }] =
      await Promise.all([
        import("@/app/(dashboard)/app/lists/lists-admin-client"),
        import("@/app/(dashboard)/app/forms/[id]/_list-picker"),
        import("@/app/(dashboard)/app/subscribers/[id]/_data-panels"),
        import("@/app/(dashboard)/app/subscribers/subscriber-list-controls"),
      ]);
    const noop = () => undefined;
    mount(
      <>
        {screen("lists-index", <ListsAdminClient />)}
        {screen(
          "form-editor",
          <TargetListPicker value="" onChange={noop} />,
        )}
        {screen(
          "subscriber-profile",
          <ListMembershipsPanel
            id={BOB.id}
            email={BOB.email}
            tenantId={OPERATOR.tenant_id}
            role="admin"
            authority={AUTHORITY}
          />,
        )}
        {screen(
          "subscriber-directory",
          <BulkActionBar
            count={1}
            totalMatching={1}
            allMatchingSelected={false}
            onSelectAllMatching={noop}
            onClear={noop}
            onSuppress={noop}
            onDelete={noop}
            onTag={noop}
            onAddToList={noop}
            onExport={noop}
            exporting={false}
            canAdmin
            selectedRows={[]}
            resolveIds={async () => [BOB.id]}
            authority={AUTHORITY}
            onChanged={noop}
          />,
        )}
      </>,
    );
    await click(button("Add to list", region("subscriber-directory")));

    const offered = () => ({
      index: region("lists-index").textContent?.includes(DIAG.name) ?? false,
      formPicker: optionTexts(
        region("form-editor").querySelector("select"),
      ).some((t) => t.startsWith(DIAG.name)),
      profilePicker: optionTexts(
        region("subscriber-profile").querySelector("select"),
      ).some((t) => t.startsWith(DIAG.name)),
      directoryPicker: optionTexts(
        region("subscriber-directory").querySelector(
          'select[aria-label="Choose a list"]',
        ),
      ).some((t) => t.startsWith(DIAG.name)),
    });
    await waitFor(() => {
      expect(offered()).toEqual({
        index: true,
        formPicker: true,
        profilePicker: true,
        directoryPicker: true,
      });
    });

    await click(
      region("lists-index").querySelector(`button[aria-label="Delete ${DIAG.name}"]`)!,
    );
    await type(dialog().querySelector("input")!, DIAG.name);
    await click(button("Delete list", dialog()));
    expect(mocks.server.requests).toContain(`DELETE /api/v1/lists/${DIAG.id}`);

    await waitFor(() => {
      expect(offered()).toEqual({
        index: false,
        formPicker: false,
        profilePicker: false,
        directoryPicker: false,
      });
    });
  });
});

describe("a membership is seen from both sides (CACHE-04)", () => {
  async function mountBothSides() {
    const [{ ListsAdminClient }, { ListMembersTab }, { ListMembershipsPanel }] =
      await Promise.all([
        import("@/app/(dashboard)/app/lists/lists-admin-client"),
        import("@/app/(dashboard)/app/lists/[id]/_components/list-members-tab"),
        import("@/app/(dashboard)/app/subscribers/[id]/_data-panels"),
      ]);
    mount(
      <>
        {screen("lists-index", <ListsAdminClient />)}
        {screen(
          "list-members",
          <ListMembersTab
            list={{
              id: NEWSLETTER.id,
              postwave_uuid: NEWSLETTER.postwaveUuid,
              name: NEWSLETTER.name,
              type: "private",
              optin: "single",
              tags: [],
              description: "",
            }}
            me={OPERATOR}
            tenantId={OPERATOR.tenant_id}
            roleKey="admin"
            canAdmin
          />,
        )}
        {screen(
          "subscriber-profile",
          <ListMembershipsPanel
            id={BOB.id}
            email={BOB.email}
            tenantId={OPERATOR.tenant_id}
            role="admin"
            authority={AUTHORITY}
          />,
        )}
      </>,
    );
  }

  const chips = () =>
    [
      ...region("subscriber-profile").querySelectorAll(
        '[data-testid="subscriber-list-membership"]',
      ),
    ].map((chip) => chip.textContent?.trim());
  const indexCount = () =>
    /Newsletter[\s\S]*?(\d+) subscribers?/.exec(
      region("lists-index").textContent ?? "",
    )?.[1];

  it("members added on a list appear on their profiles and in the index count", async () => {
    await mountBothSides();
    await waitFor(() => {
      expect(region("list-members").textContent).toContain("No subscribers yet");
      expect(region("subscriber-profile").textContent).toContain(
        "Not a member of any list.",
      );
      expect(indexCount()).toBe("0");
    });

    await click(button("Add subscribers", region("list-members")));
    await waitFor(() => {
      expect(dialog().textContent).toContain(BOB.email);
    });
    await click(dialog().querySelector(`input[aria-label="Select ${BOB.email}"]`)!);
    await click(button("Add (1)", dialog()));

    await waitFor(() => {
      expect({
        membersTable: region("list-members").textContent?.includes(BOB.email),
        profileChips: chips(),
        indexCount: indexCount(),
      }).toEqual({
        membersTable: true,
        profileChips: [NEWSLETTER.name],
        indexCount: "1",
      });
    });
  });

  it("a removal on the profile empties the list's Members tab and its index count", async () => {
    mocks.server.memberships.push({
      listId: NEWSLETTER.id,
      subscriberId: BOB.id,
      addedAt: "2026-09-15T03:00:00Z",
    });
    await mountBothSides();
    await waitFor(() => {
      expect(region("list-members").textContent).toContain(BOB.email);
      expect(chips()).toEqual([NEWSLETTER.name]);
      expect(indexCount()).toBe("1");
    });

    await click(
      region("subscriber-profile").querySelector(
        `button[aria-label="Remove from ${NEWSLETTER.name}"]`,
      )!,
    );
    await click(button("Remove from list", dialog()));
    expect(mocks.server.requests).toContain(
      `DELETE /api/v1/lists/${NEWSLETTER.postwaveUuid}/subscribers/${BOB.id}`,
    );

    await waitFor(() => {
      expect({
        membersTable: region("list-members").textContent?.includes(BOB.email),
        profileChips: chips(),
        indexCount: indexCount(),
      }).toEqual({ membersTable: false, profileChips: [], indexCount: "0" });
    });
  });
});
