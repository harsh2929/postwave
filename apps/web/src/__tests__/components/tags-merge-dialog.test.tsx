// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Tags page — merge tags (desktop parity audience-103).
//
// Desktop renders "Merge…" permanently disabled with
// TAG_MERGE_UNAVAILABLE_REASON and never sends the request; the server
// answers POST /api/v1/tag-taxonomy/merge with 409 unsafe_mutation_disabled.
// What must be true on web: the control is disabled with that exact reason
// attached, nothing leaves the client while held, the transport refuses
// before fetch, and — with the flag simulated as lifted — the dialog fans out
// one POST per source with the {from, into} body and reads the server's
// subscribers_updated receipt.

import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount } from "../pages/_harness";

const state = vi.hoisted(() => ({ available: false }));
const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  listTags: vi.fn(),
  listTagGroups: vi.fn(),
  listTagTaxonomy: vi.fn(),
  suggestTags: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
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
}));
vi.mock("@/lib/tags-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tags-api")>()),
  listTagTaxonomy: mocks.listTagTaxonomy,
  suggestTags: mocks.suggestTags,
}));
// The availability flag is a compile-time constant on both clients. The
// mutable getter lets one file prove both states: held (default) and lifted.
vi.mock("@/lib/tag-merge-availability", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/tag-merge-availability")>();
  return {
    ...actual,
    get TAG_MERGE_AVAILABLE() {
      return state.available;
    },
    requireTagMergeAvailable: () => {
      if (!state.available) throw new actual.TagMergeUnavailableError();
    },
  };
});
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: mocks.apiGet, post: mocks.apiPost },
  };
});
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: vi.fn(),
  },
}));

import type { TagRecord } from "@/lib/audience-admin-api";
import {
  TAG_MERGE_UNAVAILABLE_REASON,
  TagMergeUnavailableError,
} from "@/lib/tag-merge-availability";
import { mergeTags } from "@/lib/tags-api";
import { TagsAdminClient as Page } from "@/app/(dashboard)/app/tags/tags-admin-client";
import {
  mergePlanCopy,
  mergeResultToastCopy,
} from "@/app/(dashboard)/app/tags/merge-tags-model";

const TENANT = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const VIP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CHURN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const NEWS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

const DESKTOP_REASON =
  "Merge is paused until the server can plan and commit every membership projection atomically with an idempotent receipt.";

function me(role: "owner" | "viewer" = "owner") {
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

function tag(id: string, name: string, subscriber_count: number): TagRecord {
  return {
    id,
    name,
    color: "slate",
    description: "",
    group_id: "",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    pii: false,
    version: 1,
    etag: `"tag:${id}:v1"`,
    subscriber_count,
  };
}

async function flush(turns = 4) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function buttons(label: string): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
    (b) =>
      b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
  );
}
function buttonByLabel(label: string): HTMLButtonElement {
  const found = buttons(label)[0];
  expect(found, `button "${label}"`).toBeTruthy();
  return found as HTMLButtonElement;
}
async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush();
}
async function setSelect(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  state.available = false;
  mocks.whoami.mockResolvedValue(me());
  mocks.whoamiFresh.mockResolvedValue(me());
  mocks.listTags.mockResolvedValue([
    tag(VIP, "vip", 120),
    tag(CHURN, "churn-risk", 40),
    tag(NEWS, "weekly", 900),
  ]);
  mocks.listTagGroups.mockResolvedValue([]);
  mocks.listTagTaxonomy.mockResolvedValue([
    { tag: "vip", subscribers: 120, registered: true },
    { tag: "churn-risk", subscribers: 40, registered: true },
    { tag: "weekly", subscribers: 900, registered: true },
  ]);
  mocks.suggestTags.mockResolvedValue([]);
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("merge tags — held (audience-103)", () => {
  it("mirrors desktop's reason on every Merge control and sends nothing", async () => {
    const { root } = await renderPage(Page);
    try {
      expect(TAG_MERGE_UNAVAILABLE_REASON).toBe(DESKTOP_REASON);
      const header = buttonByLabel("Merge…");
      expect(header.disabled).toBe(true);
      expect(header.getAttribute("title")).toBe(DESKTOP_REASON);
      const reasonId = header.getAttribute("aria-describedby");
      expect(reasonId).toBe("tags-merge-availability");
      const reason = document.getElementById(reasonId!);
      expect(reason?.getAttribute("role")).toBe("status");
      expect(reason?.textContent).toBe(DESKTOP_REASON);

      // Selecting rows reveals the bulk bar; its Merge is held the same way.
      const selectVip = document.querySelector<HTMLInputElement>(
        'input[aria-label="Select vip"]',
      );
      expect(selectVip).toBeTruthy();
      await click(selectVip!);
      const bulk = buttons("Merge…");
      expect(bulk).toHaveLength(2);
      for (const control of bulk) {
        expect(control.disabled).toBe(true);
        expect(control.getAttribute("title")).toBe(DESKTOP_REASON);
        expect(control.getAttribute("aria-describedby")).toBe(reasonId);
      }

      // A forced click never opens the dialog nor sends a request.
      await click(header);
      await click(bulk[1]!);
      expect(document.body.textContent).not.toContain("Pick a destination tag");
      expect(mocks.apiPost).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("refuses the transport before fetch while held", async () => {
    await expect(mergeTags({ from: "vip", into: "weekly" })).rejects.toBeInstanceOf(
      TagMergeUnavailableError,
    );
    await expect(
      mergeTags({ from: "vip", into: "weekly" }),
    ).rejects.toMatchObject({ code: "tag_merge_unavailable", message: DESKTOP_REASON });
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("keeps Merge disabled for viewers with the read-only reason instead", async () => {
    mocks.whoami.mockResolvedValue(me("viewer"));
    const { root } = await renderPage(Page);
    try {
      const header = buttonByLabel("Merge…");
      expect(header.disabled).toBe(true);
      expect(header.getAttribute("title")).toMatch(/Editor, admin, or owner access/);
    } finally {
      unmount(root);
    }
  });
});

describe("merge tags — flag simulated as lifted", () => {
  beforeEach(() => {
    state.available = true;
  });

  it("opens from the bulk bar with the selection as sources, confirms, and POSTs one merge per source", async () => {
    mocks.apiPost
      .mockResolvedValueOnce({ from: "vip", into: "weekly", subscribers_updated: 120 })
      .mockResolvedValueOnce({ from: "churn-risk", into: "weekly" });
    const { root } = await renderPage(Page);
    try {
      const header = buttonByLabel("Merge…");
      expect(header.disabled).toBe(false);
      expect(header.getAttribute("aria-describedby")).toBeNull();
      expect(document.getElementById("tags-merge-availability")).toBeNull();

      await click(document.querySelector<HTMLInputElement>('input[aria-label="Select vip"]')!);
      await click(document.querySelector<HTMLInputElement>('input[aria-label="Select churn-risk"]')!);
      await click(buttons("Merge…")[1]!);

      // Sources pre-checked from the selection; pick the destination.
      const group = document.querySelector<HTMLElement>('[role="group"][aria-label="Source tags"]');
      expect(group).toBeTruthy();
      const checked = [...group!.querySelectorAll<HTMLInputElement>("input")].filter((i) => i.checked);
      expect(checked).toHaveLength(2);
      const into = [...document.querySelectorAll<HTMLSelectElement>("select")].find((s) =>
        [...s.options].some((o) => o.textContent?.includes("Pick a destination tag")),
      );
      expect(into).toBeTruthy();
      // Sources are disqualified as destinations.
      expect([...into!.options].find((o) => o.value === "vip")?.disabled).toBe(true);
      await setSelect(into!, "weekly");
      expect(document.body.textContent).toContain("Will move ~160 subscribers");

      await click(buttonByLabel("Merge 2 tags…"));
      expect(document.body.textContent).toContain('Merge 2 tags into "weekly"?');
      expect(document.body.textContent).toContain("Currently ~160 subscribers carry the source tags");
      expect(mocks.apiPost).not.toHaveBeenCalled();

      await click(buttonByLabel("Merge"));
      await flush(6);

      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
      expect(mocks.apiPost).toHaveBeenCalledTimes(2);
      expect(mocks.apiPost.mock.calls[0]?.[0]).toBe("/api/v1/tag-taxonomy/merge");
      expect(mocks.apiPost.mock.calls[0]?.[1]).toEqual({ from: "vip", into: "weekly" });
      expect(mocks.apiPost.mock.calls[0]?.[2]).toMatchObject({ requireOnline: true, maxAttempts: 1 });
      expect(mocks.apiPost.mock.calls[1]?.[1]).toEqual({ from: "churn-risk", into: "weekly" });
      // Honest receipt: one server count, one omitted.
      expect(mocks.toastSuccess).toHaveBeenCalledWith('Merged 2 tags into "weekly"', {
        description: "at least 120 subscribers updated (server didn't report a count for every merge).",
      });
      // The catalogue was re-read after the merge.
      expect(mocks.listTags.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mocks.listTagTaxonomy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      unmount(root);
    }
  });

  it("names the failed source and keeps a partial success honest", async () => {
    mocks.apiPost.mockRejectedValueOnce(new Error("unsafe_mutation_disabled"));
    const { root } = await renderPage(Page);
    try {
      await click(buttonByLabel("Merge…"));
      const group = document.querySelector<HTMLElement>('[role="group"][aria-label="Source tags"]')!;
      const vip = [...group.querySelectorAll<HTMLInputElement>("input")][0]!;
      await click(vip);
      const into = [...document.querySelectorAll<HTMLSelectElement>("select")].find((s) =>
        [...s.options].some((o) => o.textContent?.includes("Pick a destination tag")),
      )!;
      await setSelect(into, "weekly");
      await click(buttonByLabel("Merge tags…"));
      await click(buttonByLabel("Merge"));
      await flush(6);
      expect(mocks.apiPost).toHaveBeenCalledTimes(1);
      expect(mocks.toastError).toHaveBeenCalledWith('Couldn\'t merge "vip"', {
        description: "unsafe_mutation_disabled",
      });
      // Nothing succeeded, so the catalogue is not re-read and the dialog stays.
      expect(document.body.textContent).toContain("Pick a destination tag");
    } finally {
      unmount(root);
    }
  });

  it("decodes the server receipt and rejects a malformed count", async () => {
    mocks.apiPost.mockResolvedValueOnce({ into: "weekly", subscribers_updated: 3 });
    await expect(mergeTags({ from: "vip", into: "weekly" })).resolves.toEqual({
      into: "weekly",
      subscribers_updated: 3,
    });
    mocks.apiPost.mockResolvedValueOnce({ into: "weekly", subscribers_updated: -1 });
    await expect(mergeTags({ from: "vip", into: "weekly" })).rejects.toThrow(
      /updated subscriber count/,
    );
    await expect(mergeTags({ from: "VIP ", into: "vip" })).rejects.toThrow(/identical/);
    expect(mocks.apiPost).toHaveBeenCalledTimes(2);
  });
});

describe("merge copy model", () => {
  it("cites predicted counts and reports only server-confirmed totals", () => {
    const usage = new Map([
      ["vip", { tag: "vip", subscribers: 120, registered: true }],
    ]);
    expect(mergePlanCopy(["vip"], "weekly", usage)).toMatchObject({
      title: 'Merge "vip" into "weekly"?',
      predicted: 120,
    });
    expect(mergePlanCopy(["vip"], "weekly").description).toContain(
      "Subscriber counts are unavailable right now",
    );
    expect(
      mergeResultToastCopy("weekly", [
        { from: "vip", ok: true, subscribersUpdated: 5 },
        { from: "churn-risk", ok: false, error: "boom" },
      ]),
    ).toEqual({
      ok: false,
      message: 'Merged 1 of 2 tags into "weekly"',
      detail: '5 subscribers updated. Failed: "churn-risk" (boom).',
    });
    expect(mergeResultToastCopy("weekly", [{ from: "vip", ok: true }])).toEqual({
      ok: true,
      message: 'Merged "vip" into "weekly"',
      detail: "server didn't report how many subscribers were updated.",
    });
  });
});
