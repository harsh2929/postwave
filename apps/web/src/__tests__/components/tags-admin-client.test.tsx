// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Tags page — the six desktop-parity verbs (audience-100/104/105/106/107/108).
// Each test asserts the CONSEQUENCE of a verb: the request the transport
// receives (method is fixed per client function; path + body are the
// function's arguments), the rendered outcome, or the conflict copy. Mocks
// sit at the two transport modules the page composes.

import { act, createElement, StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount } from "../pages/_harness";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  listTags: vi.fn(),
  listTagGroups: vi.fn(),
  createTag: vi.fn(),
  updateTag: vi.fn(),
  createTagGroup: vi.fn(),
  updateTagGroup: vi.fn(),
  deleteTagGroup: vi.fn(),
  mutateTagMembership: vi.fn(),
  tagHistory: vi.fn(),
  tagMembership: vi.fn(),
  listTagTaxonomy: vi.fn(),
  suggestTags: vi.fn(),
  listSubscribersWithTag: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => createElement("a", { href, ...props }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/tags",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));
vi.mock("@/lib/audience-admin-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audience-admin-api")>()),
  listTags: mocks.listTags,
  listTagGroups: mocks.listTagGroups,
  createTag: mocks.createTag,
  updateTag: mocks.updateTag,
  createTagGroup: mocks.createTagGroup,
  updateTagGroup: mocks.updateTagGroup,
  deleteTagGroup: mocks.deleteTagGroup,
  mutateTagMembership: mocks.mutateTagMembership,
  tagHistory: mocks.tagHistory,
  tagMembership: mocks.tagMembership,
}));
vi.mock("@/lib/tags-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tags-api")>()),
  listTagTaxonomy: mocks.listTagTaxonomy,
  suggestTags: mocks.suggestTags,
  listSubscribersWithTag: mocks.listSubscribersWithTag,
}));
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: vi.fn(),
  },
}));

import { ApiError } from "@/lib/api";
import type { TagGroup, TagRecord } from "@/lib/audience-admin-api";
import { TagsAdminClient as Page } from "@/app/(dashboard)/app/tags/tags-admin-client";

const TENANT = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const VIP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CHURN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const NEWS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const GROUP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const SUB_ADA = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const SUB_BOB = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";

function me(role: "owner" | "admin" | "editor" | "viewer" = "owner") {
  return {
    user_id: USER,
    tenant_id: TENANT,
    email: "qa@postwave.test",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "QA",
    workspace_slug: "qa",
  };
}

function tag(
  id: string,
  name: string,
  override: Partial<TagRecord> = {},
): TagRecord {
  const version = override.version ?? 1;
  return {
    id,
    name,
    color: "slate",
    description: "",
    group_id: "",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    pii: false,
    version,
    etag: `"tag:${id}:v${version}"`,
    subscriber_count: 0,
    ...override,
  };
}

const group: TagGroup = {
  id: GROUP,
  name: "Lifecycle",
  color: "slate",
  sort_order: 0,
  created_at: "2026-08-01T00:00:00Z",
};

function catalogue(): TagRecord[] {
  return [
    tag(VIP, "vip", {
      color: "teal",
      description: "High-value customers",
      group_id: GROUP,
      subscriber_count: 120,
      created_at: "2026-07-01T00:00:00Z",
    }),
    tag(CHURN, "churn-risk", {
      color: "rose",
      description: "Predicted to lapse",
      subscriber_count: 40,
      created_at: "2026-08-15T00:00:00Z",
    }),
    tag(NEWS, "weekly", {
      color: "teal",
      description: "Gets the newsletter",
      subscriber_count: 900,
      created_at: "2026-06-01T00:00:00Z",
    }),
  ];
}

function membership(id: string, days: number) {
  return {
    tag_id: id,
    days,
    current_count: 120,
    added: 7,
    removed: 2,
    daily: [{ date: "2026-09-01", net: 3 }],
    coverage: {
      completeness: "exact",
      requested_window_complete: true,
      as_of: "2026-09-05T00:00:00Z",
    },
  };
}

async function flush(turns = 4) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function settle(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
  await flush();
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (b) =>
      b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
  );
  expect(button, `button "${label}"`).toBeTruthy();
  return button as HTMLButtonElement;
}
async function click(label: string) {
  const button = buttonByLabel(label);
  await act(async () => {
    button.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush();
}
async function setField(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null,
  value: string,
) {
  expect(el, "field").toBeTruthy();
  const proto =
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el?.dispatchEvent(new Event("input", { bubbles: true }));
    el?.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush();
}
function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T | null;
  expect(el, `#${id}`).toBeTruthy();
  return el as T;
}
function rowNames(): string[] {
  return [...document.querySelectorAll("tbody tr th[scope=row]")].map((th) =>
    (th.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoami.mockResolvedValue(me());
  mocks.whoamiFresh.mockResolvedValue(me());
  mocks.listTags.mockResolvedValue(catalogue());
  mocks.listTagGroups.mockResolvedValue([group]);
  mocks.listTagTaxonomy.mockResolvedValue([
    { tag: "vip", subscribers: 120, registered: true },
    { tag: "churn-risk", subscribers: 40, registered: true },
    { tag: "weekly", subscribers: 900, registered: true },
  ]);
  mocks.suggestTags.mockResolvedValue([]);
  mocks.listSubscribersWithTag.mockResolvedValue([]);
  mocks.tagHistory.mockResolvedValue([]);
  mocks.tagMembership.mockImplementation((id: string, days: number) =>
    Promise.resolve(membership(id, days)),
  );
  mocks.createTag.mockImplementation((input: { name: string }) =>
    Promise.resolve(tag("dddddddd-dddd-4ddd-8ddd-ddddddddddd1", input.name)),
  );
  mocks.updateTag.mockImplementation(
    (t: TagRecord, patch: Partial<TagRecord>) =>
      Promise.resolve({ ...t, ...patch, version: t.version + 1 }),
  );
  mocks.createTagGroup.mockResolvedValue({
    ...group,
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
    name: "Region",
  });
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("tags catalogue view (audience-107)", () => {
  it("searches names and descriptions, filters by colour, sorts, pages and resets client-side", async () => {
    // 27 registered tags → two pages at 25/page.
    const many = Array.from({ length: 24 }, (_, i) =>
      tag(
        `eeeeeeee-eeee-4eee-8eee-${String(i).padStart(12, "0")}`,
        `bulk-${String(i).padStart(2, "0")}`,
        {
          color: "amber",
        },
      ),
    );
    mocks.listTags.mockResolvedValue([...catalogue(), ...many]);
    const { root } = await renderPage(() =>
      createElement(StrictMode, null, createElement(Page)),
    );
    try {
      expect(mocks.listTags).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("Page 1 of 2");
      expect(rowNames()).toHaveLength(25);

      await setField(byId<HTMLInputElement>("tag-search"), "newsletter");
      expect(rowNames()).toEqual(["weekly v1"]);
      // No refetch: the search is over the list the page already holds.
      expect(mocks.listTags).toHaveBeenCalledTimes(1);

      await setField(byId<HTMLInputElement>("tag-search"), "");
      await setField(byId<HTMLSelectElement>("tag-color-filter"), "teal");
      expect(rowNames()).toEqual(["vip v1", "weekly v1"]);

      await setField(byId<HTMLSelectElement>("tag-color-filter"), "all");
      await click("Subscribers");
      await click("Subscribers");
      expect(
        document.querySelector('th[aria-sort="descending"]')?.textContent,
      ).toContain("Subscribers");
      expect(rowNames().slice(0, 3)).toEqual([
        "weekly v1",
        "vip v1",
        "churn-risk v1",
      ]);

      await click("Next");
      expect(document.body.textContent).toContain("Page 2 of 2");
      expect(rowNames()).toHaveLength(2);

      await click("Reset view");
      expect(document.body.textContent).toContain("Page 1 of 2");
      expect(byId<HTMLSelectElement>("tag-color-filter").value).toBe("all");
      expect(rowNames()[0]).toBe("bulk-00 v1");
    } finally {
      unmount(root);
    }
  });
});

describe("tag groups (audience-105)", () => {
  it("filters by group and by 'No group', and creates a group with the exact body", async () => {
    const { root } = await renderPage(() =>
      createElement(StrictMode, null, createElement(Page)),
    );
    try {
      await setField(byId<HTMLSelectElement>("tag-group-filter"), GROUP);
      expect(rowNames()).toEqual(["vip v1"]);
      await setField(byId<HTMLSelectElement>("tag-group-filter"), "none");
      expect(rowNames()).toEqual(["churn-risk v1", "weekly v1"]);

      await setField(
        document.querySelector<HTMLInputElement>(
          'input[aria-label="New group name"]',
        ),
        "Region",
      );
      await click("Add");
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
      expect(mocks.createTagGroup).toHaveBeenCalledWith(
        { name: "Region", color: "slate", sort_order: 1 },
        expect.stringMatching(/^web-audience:group-create:/),
      );
      expect(mocks.listTagGroups.mock.calls.length).toBeGreaterThanOrEqual(2);
      await click("Create tag");
      expect(buttonByLabel("Teal").disabled).toBe(false);
      expect(buttonByLabel("Cancel").disabled).toBe(false);
      await click("Cancel");
    } finally {
      unmount(root);
    }
  });

  it("renames and deletes through the exact-read gate", async () => {
    const { root } = await renderPage(() =>
      createElement(StrictMode, null, createElement(Page)),
    );
    try {
      await click("Rename group Lifecycle");
      await setField(
        document.querySelector<HTMLInputElement>(
          'input[aria-label="New name for Lifecycle"]',
        ),
        "Stage",
      );
      await click("Rename");
      expect(mocks.updateTagGroup).toHaveBeenCalledWith(
        GROUP,
        { name: "Stage" },
        expect.stringMatching(/^web-audience:group-update:/),
      );

      await click("Delete group Lifecycle");
      const token = document.querySelector<HTMLInputElement>(
        'input[placeholder="Lifecycle"]',
      );
      await setField(token, "Lifecycle");
      await click("Delete group");
      expect(mocks.deleteTagGroup).toHaveBeenCalledWith(
        GROUP,
        expect.stringMatching(/^web-audience:group-delete:/),
      );
    } finally {
      unmount(root);
    }
  });

  it("withholds group management from editors with the reason", async () => {
    mocks.whoami.mockResolvedValue(me("editor"));
    mocks.whoamiFresh.mockResolvedValue(me("editor"));
    const { root } = await renderPage(() =>
      createElement(StrictMode, null, createElement(Page)),
    );
    try {
      expect(document.body.textContent).toContain(
        "Only workspace owners and admins can create, rename, or delete tag groups.",
      );
      expect(
        document.querySelector('input[aria-label="New group name"]'),
      ).toBeNull();
      expect(buttonByLabel("Rename group Lifecycle").disabled).toBe(true);
      expect(buttonByLabel("Delete group Lifecycle").disabled).toBe(true);
      // Editors can still create tags.
      expect(buttonByLabel("Create tag").disabled).toBe(false);
    } finally {
      unmount(root);
    }
  });
});

describe("create tag with suggestions (audience-100)", () => {
  it("asks the server for suggestions, applies one, warns on a duplicate, and posts the palette colour", async () => {
    mocks.suggestTags.mockResolvedValue([
      { tag: "vip", subscribers: 120, registered: true },
      { tag: "vip-2025", subscribers: 3, registered: true },
    ]);
    const { root } = await renderPage(() =>
      createElement(StrictMode, null, createElement(Page)),
    );
    try {
      await click("Create tag");
      await setField(byId<HTMLInputElement>("tag-name"), "vi");
      await settle(250);
      expect(mocks.suggestTags).toHaveBeenCalledWith(
        "vi",
        5,
        expect.anything(),
      );
      expect(document.body.textContent).toContain("Did you mean:");
      await click("vip-2025");
      expect(byId<HTMLInputElement>("tag-name").value).toBe("vip-2025");

      await setField(byId<HTMLInputElement>("tag-name"), "VIP");
      await settle(250);
      expect(document.body.textContent).toContain(
        "already exists in your catalogue.",
      );

      await setField(byId<HTMLInputElement>("tag-name"), "vip-2026");
      await setField(
        byId<HTMLTextAreaElement>("tag-description"),
        "This year's cohort",
      );
      await click("Teal");
      await setField(byId<HTMLSelectElement>("tag-group"), GROUP);
      const submit = [
        ...document.querySelectorAll<HTMLButtonElement>("button"),
      ].filter((b) => b.textContent?.trim() === "Create tag");
      await act(async () => {
        submit[submit.length - 1]?.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      await flush();
      expect(mocks.whoamiFresh).toHaveBeenCalled();
      expect(mocks.createTag).toHaveBeenCalledWith(
        {
          name: "vip-2026",
          color: "teal",
          description: "This year's cohort",
          group_id: GROUP,
          pii: false,
        },
        expect.stringMatching(/^web-audience:tag-create:/),
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Tag created");
    } finally {
      unmount(root);
    }
  });

  it("says suggestions are unavailable without blocking the create", async () => {
    mocks.suggestTags.mockRejectedValue(new ApiError("boom", 503));
    // The taxonomy is down too, so only the catalogue rows can answer the
    // duplicate hint — nothing else may mask a missing local lookup.
    mocks.listTagTaxonomy.mockRejectedValue(new ApiError("boom", 503));
    const { root } = await renderPage(() =>
      createElement(StrictMode, null, createElement(Page)),
    );
    try {
      await click("Create tag");
      await setField(byId<HTMLInputElement>("tag-name"), "vi");
      await settle(250);
      expect(document.body.textContent).toContain(
        "Tag suggestions are unavailable. You can still create this tag.",
      );
      // The duplicate hint does not depend on the suggest endpoint: the
      // catalogue the page already holds answers it, case- and space-blind.
      await setField(byId<HTMLInputElement>("tag-name"), "  Churn-Risk ");
      await settle(250);
      expect(document.body.textContent).toContain(
        "churn-risk already exists in your catalogue.",
      );
    } finally {
      unmount(root);
    }
  });
});

describe("register an orphan tag (audience-104)", () => {
  it("lists catalogue ∖ taxonomy as orphans and registers one by name with colour and description", async () => {
    mocks.listTagTaxonomy.mockResolvedValue([
      { tag: "vip", subscribers: 120, registered: true },
      { tag: "legacy-import", subscribers: 12, registered: false },
    ]);
    const { root } = await renderPage(() =>
      createElement(StrictMode, null, createElement(Page)),
    );
    try {
      expect(rowNames()).toContain("legacy-import Orphan");
      expect(document.body.textContent).toContain("4 results");

      await click("Register legacy-import");
      expect(document.body.textContent).toContain(
        "Currently applied to 12 subscribers.",
      );
      expect(byId<HTMLInputElement>("orphan-tag-name").readOnly).toBe(true);
      await click("Rose");
      await setField(
        byId<HTMLTextAreaElement>("orphan-tag-description"),
        "Imported from the old CRM",
      );
      await click("Register tag");
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
      expect(mocks.createTag).toHaveBeenCalledWith(
        {
          name: "legacy-import",
          color: "rose",
          description: "Imported from the old CRM",
          group_id: "",
          pii: false,
        },
        expect.stringMatching(/^web-audience:tag-register:/),
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        'Registered "legacy-import"',
      );
      expect(mocks.listTags.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mocks.listTagTaxonomy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      unmount(root);
    }
  });

  it("hides orphans under a colour filter and says how many", async () => {
    mocks.listTagTaxonomy.mockResolvedValue([
      { tag: "legacy-import", subscribers: 12, registered: false },
    ]);
    const { root } = await renderPage(() =>
      createElement(StrictMode, null, createElement(Page)),
    );
    try {
      await setField(byId<HTMLSelectElement>("tag-color-filter"), "teal");
      expect(rowNames()).not.toContain("legacy-import Orphan");
      expect(document.body.textContent).toContain(
        "1 orphan hidden by the active colour or group filter",
      );

      // Typing an orphan's name in Create tag names it as applied-but-unregistered
      // from the taxonomy the page holds — the suggest endpoint returned nothing.
      await click("Create tag");
      await setField(byId<HTMLInputElement>("tag-name"), "Legacy-Import");
      await settle(250);
      expect(document.body.textContent).toContain(
        "legacy-import is already applied to 12 subscribers but is not registered yet.",
      );
    } finally {
      unmount(root);
    }
  });
});

describe("multi-select bulk edit (audience-106)", () => {
  it("PATCHes each selected tag against its own ETag and keeps only failed tags selected after a 412", async () => {
    const { root } = await renderPage(() =>
      createElement(StrictMode, null, createElement(Page)),
    );
    try {
      const vip = document.querySelector<HTMLInputElement>(
        'input[aria-label="Select vip"]',
      );
      const churn = document.querySelector<HTMLInputElement>(
        'input[aria-label="Select churn-risk"]',
      );
      await act(async () => {
        vip?.click();
        churn?.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      await flush();
      expect(document.body.textContent).toContain("2 selected");

      await click("Recolour…");
      await click("Lime");
      await click("Apply to 2 tags");
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
      expect(mocks.updateTag).toHaveBeenCalledTimes(2);
      expect(mocks.updateTag).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ id: VIP, etag: `"tag:${VIP}:v1"` }),
        { color: "lime" },
        expect.stringMatching(/^web-audience:tag-bulk-edit:/),
      );
      expect(mocks.updateTag).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ id: CHURN, etag: `"tag:${CHURN}:v1"` }),
        { color: "lime" },
        expect.stringMatching(/^web-audience:tag-bulk-edit:/),
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Updated 2 tags");
      expect(document.body.textContent).not.toContain("selected");

      // Conflict path: the second tag moved on the server.
      mocks.updateTag.mockReset();
      mocks.updateTag
        .mockImplementationOnce((t: TagRecord, patch: Partial<TagRecord>) =>
          Promise.resolve({ ...t, ...patch, version: t.version + 1 }),
        )
        .mockRejectedValueOnce(new ApiError("precondition failed", 412));
      const listCalls = mocks.listTags.mock.calls.length;
      await act(async () => {
        document
          .querySelector<HTMLInputElement>('input[aria-label="Select vip"]')
          ?.click();
        document
          .querySelector<HTMLInputElement>(
            'input[aria-label="Select churn-risk"]',
          )
          ?.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      await flush();
      await click("Describe…");
      await setField(
        byId<HTMLTextAreaElement>("bulk-tag-description"),
        "Shared note",
      );
      await click("Apply to 2 tags");
      expect(mocks.updateTag).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ id: CHURN }),
        { description: "Shared note" },
        expect.any(String),
      );
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Updated 1; 1 failed. Only failed tags remain selected for retry. Some tags changed on the server; the catalogue was reloaded.",
        ),
      );
      expect(mocks.listTags.mock.calls.length).toBeGreaterThan(listCalls);
      expect(document.body.textContent).toContain("1 selected");
      expect(document.body.textContent).toContain("Retry 1 failed tag");
    } finally {
      unmount(root);
    }
  });

  it("does not offer selection to viewers", async () => {
    mocks.whoami.mockResolvedValue({
      ...me("owner"),
      effective_role: "viewer",
      viewer_mode: true,
    });
    const { root } = await renderPage(() =>
      createElement(StrictMode, null, createElement(Page)),
    );
    try {
      expect(
        document.querySelector<HTMLInputElement>(
          'input[aria-label="Select vip"]',
        )?.disabled,
      ).toBe(true);
      expect(buttonByLabel("Create tag").disabled).toBe(true);
    } finally {
      unmount(root);
    }
  });
});

describe("tag detail (audience-108)", () => {
  it("loads the member sample with links into Subscribers, switches the membership window, and saves the description against the ETag", async () => {
    mocks.listSubscribersWithTag.mockResolvedValue([
      {
        id: SUB_ADA,
        email: "ada@example.test",
        status: "enabled",
        created_at: "2026-08-01T00:00:00Z",
      },
      {
        id: SUB_BOB,
        email: "bob@example.test",
        status: "blocklisted",
        created_at: "2026-08-02T00:00:00Z",
      },
    ]);
    const { root } = await renderPage(() =>
      createElement(StrictMode, null, createElement(Page)),
    );
    try {
      await click("Inspect vip");
      expect(mocks.listSubscribersWithTag).toHaveBeenCalledWith(
        "vip",
        50,
        expect.anything(),
      );
      expect(mocks.tagMembership).toHaveBeenCalledWith(
        VIP,
        30,
        expect.anything(),
      );
      const link = document.querySelector<HTMLAnchorElement>(
        'a[aria-label="Open ada@example.test in Subscribers"]',
      );
      expect(link?.getAttribute("href")).toBe(`/app/subscribers/${SUB_ADA}`);
      expect(document.body.textContent).toContain("bob@example.test");
      expect(document.body.textContent).toContain(
        "Exact for the requested 30-day window.",
      );

      await click("90 days");
      expect(mocks.tagMembership).toHaveBeenCalledWith(
        VIP,
        90,
        expect.anything(),
      );
      expect(document.body.textContent).toContain("Membership · last 90 days");

      await setField(
        byId<HTMLTextAreaElement>("tag-detail-description-field"),
        "VIP customers",
      );
      await click("Save description");
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
      expect(mocks.updateTag).toHaveBeenCalledWith(
        expect.objectContaining({ id: VIP, etag: `"tag:${VIP}:v1"` }),
        { description: "VIP customers" },
        expect.stringMatching(/^web-audience:tag-describe:/),
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Description saved");
      expect(buttonByLabel("Close").disabled).toBe(false);
      await click("Close");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      unmount(root);
    }
  });

  it("keeps the draft and reloads on a 412, and renders the server's membership refusal", async () => {
    mocks.updateTag.mockRejectedValue(new ApiError("precondition failed", 412));
    mocks.tagMembership.mockRejectedValue(
      new ApiError(
        "Membership coverage is not yet available for this workspace.",
        503,
        undefined,
        {
          code: "membership_coverage_unavailable",
        },
      ),
    );
    const { root } = await renderPage(() =>
      createElement(StrictMode, null, createElement(Page)),
    );
    try {
      await click("Inspect vip");
      expect(document.body.textContent).toContain(
        "Membership coverage is not yet available for this workspace.",
      );
      const listCalls = mocks.listTags.mock.calls.length;
      // The reload brings back the SAME tag with a description changed
      // elsewhere and a moved ETag; the operator's draft must survive it.
      mocks.listTags.mockResolvedValue(
        catalogue().map((t) =>
          t.id === VIP
            ? tag(VIP, "vip", {
                color: "teal",
                description: "Changed elsewhere",
                group_id: GROUP,
                subscriber_count: 120,
                created_at: "2026-07-01T00:00:00Z",
                version: 2,
              })
            : t,
        ),
      );
      await setField(
        byId<HTMLTextAreaElement>("tag-detail-description-field"),
        "Draft kept",
      );
      await click("Save description");
      expect(mocks.toastError).toHaveBeenCalledWith(
        "This tag changed elsewhere. Your description draft was kept while the latest version reloads.",
      );
      expect(mocks.listTags.mock.calls.length).toBeGreaterThan(listCalls);
      expect(document.body.textContent).toContain("v2");
      expect(
        byId<HTMLTextAreaElement>("tag-detail-description-field").value,
      ).toBe("Draft kept");

      // Saving again goes against the refreshed ETag, never the stale one.
      mocks.updateTag.mockImplementation(
        (t: TagRecord, patch: Partial<TagRecord>) =>
          Promise.resolve({ ...t, ...patch, version: t.version + 1 }),
      );
      await click("Save description");
      expect(mocks.updateTag).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: VIP, etag: `"tag:${VIP}:v2"` }),
        { description: "Draft kept" },
        expect.stringMatching(/^web-audience:tag-describe:/),
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Description saved");
    } finally {
      unmount(root);
    }
  });

  it("disables the description edit for viewers", async () => {
    mocks.whoami.mockResolvedValue({
      ...me("owner"),
      effective_role: "viewer",
      viewer_mode: true,
    });
    const { root } = await renderPage(() =>
      createElement(StrictMode, null, createElement(Page)),
    );
    try {
      await click("Inspect vip");
      expect(
        byId<HTMLTextAreaElement>("tag-detail-description-field").disabled,
      ).toBe(true);
      expect(document.body.textContent).toContain(
        "Editor access is required to edit.",
      );
    } finally {
      unmount(root);
    }
  });
});
