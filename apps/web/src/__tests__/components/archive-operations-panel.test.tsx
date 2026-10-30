// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setOnlineStatusForTest } from "@/lib/online-manager";

import type * as ArchiveAdminApi from "@/lib/archive-admin-api";
import type * as AuthApi from "@/lib/auth-api";
import type { MeResponse } from "@/lib/auth-api";

const mocks = vi.hoisted(() => ({
  getPreview: vi.fn(),
  getStats: vi.fn(),
  listIssues: vi.fn(),
  setPinned: vi.fn(),
  unpublish: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("@/lib/archive-admin-api", async (importOriginal) => {
  const actual = await importOriginal<typeof ArchiveAdminApi>();
  return {
    ...actual,
    getArchiveIssuePreview: mocks.getPreview,
    getArchiveStats: mocks.getStats,
    listArchiveIssues: mocks.listIssues,
    setArchiveIssuePinned: mocks.setPinned,
    unpublishArchiveIssue: mocks.unpublish,
  };
});

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof AuthApi>();
  return { ...actual, whoamiFresh: mocks.whoamiFresh };
});

import {
  ArchiveOperationsPanel,
  ArchiveShareLinks,
  assertFreshArchiveAuthority,
} from "@/app/(dashboard)/app/archive-settings/archive-operations-panel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000002";
const OPERATION_ID = "00000000-0000-4000-8000-000000000003";
const roots: Root[] = [];

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: "archive-admin",
    tenant_id: TENANT_ID,
    email: "archive-admin@example.test",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Archive workspace",
    workspace_slug: "archive-workspace",
    ...overrides,
  };
}

const issue = {
  slug: "august-update",
  subject: "August update",
  excerpt: "What shipped this month.",
  publishedAt: "2026-08-29T09:30:00Z",
  pinned: true,
  campaignId: CAMPAIGN_ID,
  viewCount: 12,
  uniqueVisitors: 9,
};

const preview = {
  ...issue,
  htmlBody:
    '<main><h1>August update</h1><img src="https://tracker.test/pixel"></main>',
  metaDescription: "Monthly product update",
  ogImage: null,
  heroImage: null,
  authorName: "Public author",
  canonicalUrl: null,
};

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === label,
  );
}

function setInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
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

async function renderPanel(identity = me()) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, networkMode: "always", gcTime: 0 },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ArchiveOperationsPanel
          me={identity}
          queryBase={[
            "archive-admin",
            identity.tenant_id,
            identity.effective_role ?? identity.role,
            identity.user_id,
            Boolean(identity.viewer_mode),
          ]}
        />
      </QueryClientProvider>,
    );
  });
  return { client, container };
}

beforeEach(() => {
  // Manual "load more" is refused unless the app is known to be online.
  setOnlineStatusForTest("online");
  vi.clearAllMocks();
  mocks.getStats.mockResolvedValue({
    totalIssues: 1,
    pinnedIssues: 1,
    views30d: 12,
    uniqueVisitors30d: 9,
    topIssueSlug: issue.slug,
    topIssueSubject: issue.subject,
    topIssueViews: 12,
    lastPublishedAt: issue.publishedAt,
  });
  mocks.listIssues.mockResolvedValue({ items: [issue], nextCursor: null });
  mocks.getPreview.mockResolvedValue(preview);
  mocks.whoamiFresh.mockResolvedValue(me());
  mocks.unpublish.mockResolvedValue({ ok: true });
  mocks.setPinned.mockImplementation(
    ({ pinned }: { pinned: boolean }) => Promise.resolve({ ok: true, pinned }),
  );
  vi.stubGlobal("crypto", { randomUUID: () => OPERATION_ID });
});

afterEach(() => {
  setOnlineStatusForTest("connecting");
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ArchiveOperationsPanel", () => {
  it("rejects tenant, user, role, and viewer-mode drift before mutation", () => {
    const opened = me();
    for (const changed of [
      me({ tenant_id: "00000000-0000-4000-8000-000000000099" }),
      me({ user_id: "different-admin" }),
      me({ role: "editor", effective_role: "editor" }),
      me({ viewer_mode: true, effective_role: "viewer" }),
    ]) {
      expect(() => assertFreshArchiveAuthority(opened, changed)).toThrow(
        /authority changed/i,
      );
    }
  });

  it("renders verified metrics/list state and keeps held delivery controls absent", async () => {
    const { container } = await renderPanel();
    await eventually(() =>
      expect(container.textContent).toContain("August update"),
    );

    const search = container.querySelector("#archive-issue-search");
    expect(search).toBeInstanceOf(HTMLInputElement);
    expect(
      container.querySelector('label[for="archive-issue-search"]')?.textContent,
    ).toContain("Search published issues");
    expect(container.textContent).toContain("12 views");
    expect(container.textContent).toContain("All verified results are loaded");
    expect(container.textContent).toContain(
      "Public-delivery controls remain held",
    );

    const buttonLabels = Array.from(container.querySelectorAll("button")).map(
      (candidate) => candidate.textContent?.trim(),
    );
    expect(buttonLabels).not.toContain("Publish");
    expect(buttonLabels).not.toContain("Edit");
    expect(buttonLabels).not.toContain("Enable comments");
    // Featuring reorders an issue that is ALREADY public, so it is reachable
    // while publication stays held — and the note must no longer claim
    // otherwise.
    expect(buttonLabels).toContain("Unfeature");
    expect(container.textContent).toContain(
      "featuring only reorders issues that are already published",
    );
    expect(container.textContent).not.toContain(CAMPAIGN_ID);
  });

  it("wires cursor paging, debounced search, and search clearing", async () => {
    mocks.listIssues
      .mockResolvedValueOnce({ items: [issue], nextCursor: "cursor-2" })
      .mockResolvedValueOnce({
        items: [
          {
            ...issue,
            slug: "second-issue",
            subject: "Second issue",
            campaignId: "00000000-0000-4000-8000-000000000004",
          },
        ],
        nextCursor: null,
      });
    const { container } = await renderPanel();
    await eventually(() => expect(button("Load more issues")).toBeDefined());
    await act(async () => button("Load more issues")!.click());
    await eventually(() =>
      expect(container.textContent).toContain("Second issue"),
    );
    expect(mocks.listIssues.mock.calls[1]?.[0]).toMatchObject({
      cursor: "cursor-2",
      limit: 25,
    });

    const search = container.querySelector(
      "#archive-issue-search",
    ) as HTMLInputElement;
    await act(async () => setInput(search, "august"));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    });
    await eventually(() =>
      expect(
        mocks.listIssues.mock.calls.some(
          ([options]) => options.q === "august" && options.cursor === undefined,
        ),
      ).toBe(true),
    );

    const clear = container.querySelector(
      'button[aria-label="Clear archive search"]',
    ) as HTMLButtonElement;
    await act(async () => clear.click());
    expect(search.value).toBe("");
    expect(document.activeElement).toBe(search);
  });

  it("loads HTML only on inspection and renders it in a network-silent sandbox", async () => {
    await renderPanel();
    await eventually(() => expect(button("Inspect safely")).toBeDefined());
    expect(mocks.getPreview).not.toHaveBeenCalled();

    await act(async () => button("Inspect safely")!.click());
    await eventually(() =>
      expect(document.querySelector("iframe")).toBeInstanceOf(
        HTMLIFrameElement,
      ),
    );

    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.referrerPolicy).toBe("no-referrer");
    expect(frame.srcdoc).toContain("default-src 'none'");
    expect(frame.srcdoc).toContain("connect-src 'none'");
    expect(document.body.textContent).not.toContain(CAMPAIGN_ID);
    expect(button("Emergency unpublish")).toBeDefined();
    expect(document.body.textContent).toContain("version precondition");
  });

  it("rechecks authority and issue identity before an idempotent unpublish", async () => {
    await renderPanel();
    await eventually(() => expect(button("Inspect safely")).toBeDefined());
    await act(async () => button("Inspect safely")!.click());
    await eventually(() => expect(button("Emergency unpublish")).toBeDefined());
    await act(async () => button("Emergency unpublish")!.click());

    const token = `UNPUBLISH ${issue.slug}`;
    await eventually(() =>
      expect(document.body.textContent).toContain(`Type ${token} to confirm`),
    );
    const tokenLabel = Array.from(document.querySelectorAll("label")).find(
      (candidate) => candidate.textContent?.includes(token),
    ) as HTMLLabelElement;
    const tokenInput = document.getElementById(
      tokenLabel.htmlFor,
    ) as HTMLInputElement;
    expect(button("Unpublish issue")?.disabled).toBe(true);
    await act(async () => setInput(tokenInput, token));
    expect(button("Unpublish issue")?.disabled).toBe(false);

    // A post-receipt refresh is a separate read concern. It must not recast a
    // confirmed write as a failed write or invite a duplicate manual retry.
    mocks.listIssues.mockRejectedValue(new Error("refresh failed"));
    mocks.getStats.mockRejectedValue(new Error("refresh failed"));
    await act(async () => button("Unpublish issue")!.click());
    await eventually(() => expect(mocks.unpublish).toHaveBeenCalledTimes(1));
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(mocks.getPreview).toHaveBeenCalledTimes(2);
    expect(mocks.unpublish).toHaveBeenCalledWith({
      campaignId: CAMPAIGN_ID,
      idempotencyKey: OPERATION_ID,
      signal: expect.any(AbortSignal),
    });
    await eventually(() =>
      expect(document.body.textContent).toContain("was unpublished"),
    );
  });

  it("never exposes emergency unpublish to editors or view-as admins", async () => {
    for (const identity of [
      me({ role: "editor", effective_role: "editor" }),
      me({ viewer_mode: true, effective_role: "viewer" }),
    ]) {
      await renderPanel(identity);
      await eventually(() => expect(button("Inspect safely")).toBeDefined());
      await act(async () => button("Inspect safely")!.click());
      await eventually(() =>
        expect(document.body.textContent).toContain("Admin or owner required"),
      );
      expect(button("Emergency unpublish")).toBeUndefined();
      await act(async () => {
        button("Close")?.click();
      });
      await eventually(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
    }
    expect(mocks.unpublish).not.toHaveBeenCalled();
  });

  it("unfeatures a pinned issue and repaints the row from the receipt", async () => {
    const { container } = await renderPanel();
    await eventually(() => expect(button("Unfeature")).toBeDefined());
    expect(container.textContent).toContain("Featured");

    // Strand the post-write refresh so the repaint below can only have come
    // from the server receipt, not from a re-read.
    mocks.listIssues.mockReturnValue(new Promise(() => {}));
    mocks.getStats.mockReturnValue(new Promise(() => {}));
    await act(async () => button("Unfeature")!.click());

    await eventually(() => expect(mocks.setPinned).toHaveBeenCalledTimes(1));
    expect(mocks.setPinned).toHaveBeenCalledWith({
      campaignId: CAMPAIGN_ID,
      pinned: false,
      idempotencyKey: OPERATION_ID,
      signal: expect.any(AbortSignal),
    });
    await eventually(() => expect(button("Feature")).toBeDefined());
    expect(container.textContent).toContain(
      "August update was removed from the featured section of the public archive.",
    );
    expect(container.textContent).not.toContain("Featured");
  });

  it("features an unpinned issue and shows the server sentence on refusal", async () => {
    mocks.listIssues.mockResolvedValue({
      items: [{ ...issue, pinned: false }],
      nextCursor: null,
    });
    mocks.setPinned.mockRejectedValueOnce(
      new Error("issue not published or not yours"),
    );
    const { container } = await renderPanel();
    await eventually(() => expect(button("Feature")).toBeDefined());

    await act(async () => button("Feature")!.click());
    await eventually(() =>
      expect(container.textContent).toContain(
        "issue not published or not yours",
      ),
    );
    expect(mocks.setPinned.mock.calls[0]?.[0]).toMatchObject({
      campaignId: CAMPAIGN_ID,
      pinned: true,
    });
    // The refused write must leave the row exactly as it was.
    expect(button("Feature")).toBeDefined();
    expect(button("Unfeature")).toBeUndefined();
  });

  it("withholds featuring from editors and view-as admins", async () => {
    for (const identity of [
      me({ role: "editor", effective_role: "editor" }),
      me({ viewer_mode: true, effective_role: "viewer" }),
    ]) {
      await renderPanel(identity);
      await eventually(() => expect(button("Inspect safely")).toBeDefined());
      expect(button("Feature")).toBeUndefined();
      expect(button("Unfeature")).toBeUndefined();
    }
    expect(mocks.setPinned).not.toHaveBeenCalled();
  });

  it("separates verified-empty and failed reads", async () => {
    mocks.getStats.mockResolvedValueOnce({
      totalIssues: 0,
      pinnedIssues: 0,
      views30d: 0,
      uniqueVisitors30d: 0,
      topIssueSlug: null,
      topIssueSubject: null,
      topIssueViews: null,
      lastPublishedAt: null,
    });
    mocks.listIssues.mockResolvedValueOnce({ items: [], nextCursor: null });
    const empty = await renderPanel();
    await eventually(() =>
      expect(empty.container.textContent).toContain(
        "Verified empty: the archive statistics request succeeded",
      ),
    );
    expect(empty.container.textContent).toContain("verified empty");

    mocks.getStats.mockRejectedValueOnce(new Error("stats contract failure"));
    mocks.listIssues.mockRejectedValueOnce(new Error("list contract failure"));
    const failed = await renderPanel();
    await eventually(() =>
      expect(failed.container.textContent).toContain(
        "No zero values are inferred from a failed statistics request",
      ),
    );
    expect(failed.container.textContent).toContain(
      "an empty archive is not being inferred",
    );
    expect(
      Array.from(failed.container.querySelectorAll('div[role="alert"]')).length,
    ).toBeGreaterThanOrEqual(2);
  });
});

function archiveSettings(
  overrides: Partial<ArchiveAdminApi.ArchiveSettings> = {},
): ArchiveAdminApi.ArchiveSettings {
  return {
    tenant_archive_slug: "acme-letter",
    archive_domain: "",
    archive_title: "Acme letter",
    archive_tagline: "",
    tips_enabled: false,
    tips_currency: "usd",
    tips_suggested_amounts: [],
    tips_min_amount: 100,
    tips_message: "",
    archive_bar_default_enabled: false,
    view_in_browser_default_enabled: false,
    ...overrides,
  };
}

async function renderShareLinks(settings: ArchiveAdminApi.ArchiveSettings) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<ArchiveShareLinks settings={settings} />);
  });
  return container;
}

function copyTargets(container: HTMLElement): Record<string, string> {
  const entries = Array.from(container.querySelectorAll("button")).map(
    (candidate) => [candidate.textContent?.trim() ?? "", candidate.title],
  );
  return Object.fromEntries(entries);
}

describe("ArchiveShareLinks", () => {
  it("splits slug archives across the web index and the API feed origins", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.postwave.test");
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const container = await renderShareLinks(archiveSettings());
    await eventually(() =>
      expect(container.textContent).toContain("/en/archive/acme-letter"),
    );

    // The index is rendered by THIS app; the feed and sitemap are rendered by
    // the API. Collapsing them onto one origin hands out two dead links.
    expect(copyTargets(container)).toMatchObject({
      "Copy public URL": "http://localhost:3000/en/archive/acme-letter",
      "Copy RSS":
        "https://api.postwave.test/api/public/archive/acme-letter/feed.xml",
      "Copy sitemap":
        "https://api.postwave.test/api/public/archive/acme-letter/sitemap.xml",
    });

    const rss = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Copy RSS",
    )!;
    await act(async () => rss.click());
    expect(writeText).toHaveBeenCalledWith(
      "https://api.postwave.test/api/public/archive/acme-letter/feed.xml",
    );
    await eventually(() =>
      expect(container.textContent).toContain("RSS feed URL copied"),
    );

    const open = container.querySelector("a") as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe(
      "http://localhost:3000/en/archive/acme-letter",
    );
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("hangs every URL off a configured vanity host", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.postwave.test");
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const container = await renderShareLinks(
      archiveSettings({ archive_domain: "https://letters.acme.test/" }),
    );
    await eventually(() =>
      expect(container.textContent).toContain("letters.acme.test"),
    );
    expect(copyTargets(container)).toMatchObject({
      "Copy public URL": "https://letters.acme.test",
      "Copy RSS": "https://letters.acme.test/feed.xml",
      "Copy sitemap": "https://letters.acme.test/sitemap.xml",
    });
  });

  it("offers no URL when the archive has no address", async () => {
    const container = await renderShareLinks(
      archiveSettings({ tenant_archive_slug: "", archive_domain: "" }),
    );
    expect(container.textContent).toContain("Public archive links unavailable");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("surfaces a rejected clipboard write instead of swallowing it", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const container = await renderShareLinks(archiveSettings());
    const copy = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Copy public URL",
    )!;
    await act(async () => copy.click());
    await eventually(() =>
      expect(container.textContent).toContain("Copy failed"),
    );
    expect(container.textContent).toContain("could not be copied");
  });
});
