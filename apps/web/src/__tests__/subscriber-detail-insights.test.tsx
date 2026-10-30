// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Subscriber detail insights, notes and DSAR export (desktop parity rows
// audience-50/74/78/79). Each test drives a real render and asserts the
// CONSEQUENCE of the verb — the request's method + path + body, the copy on
// the confirm that guards a destructive or workspace-wide write, and what the
// panel renders afterwards — or, for a withheld verb, that no request was
// made and the reason is shown.

import { act, createElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setOnlineStatusForTest } from "@/lib/online-manager";

import { trackRoot, unmountRoots } from "./_roots";
import { importBeforeTests, waitFor } from "./pages/_wait";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  whoamiFresh: vi.fn(),
  downloadBlobFile: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: mocks };
});
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return {
    ...actual,
    whoami: mocks.whoamiFresh,
    whoamiFresh: mocks.whoamiFresh,
  };
});
vi.mock("@/lib/download", () => ({
  downloadBlobFile: mocks.downloadBlobFile,
  downloadTextFile: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: mocks.toastInfo,
  },
}));

import { NotesPanel } from "@/app/(dashboard)/app/subscribers/[id]/_profile-panels";
import { SubscriberDetailPanels } from "@/app/(dashboard)/app/subscribers/[id]/subscriber-detail-panels";
import {
  SubscriberDataExportButton,
  SubscriberInsightsPanel,
} from "@/app/(dashboard)/app/subscribers/[id]/_insights-panels";
import { ApiError } from "@/lib/api";
import type { SubscriberAuthority } from "@/lib/subscriber-authority";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const id = "11111111-1111-4111-8111-111111111111";
const tenantId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const teammateId = "44444444-4444-4444-8444-444444444444";
const noteId = "55555555-5555-4555-8555-555555555555";
const admin: SubscriberAuthority = { tenantId, userId, role: "admin" };
const editor: SubscriberAuthority = { tenantId, userId, role: "editor" };

type Role = "owner" | "admin" | "editor" | "viewer";

function me(role: Role) {
  return {
    user_id: userId,
    tenant_id: tenantId,
    email: "operator@example.com",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
  };
}

function render(ui: ReactNode): Root {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = trackRoot(container);
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, ui),
    );
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((r) => window.requestAnimationFrame(r));
  await new Promise((r) => window.setTimeout(r, 0));
}

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll("button")).find(
    (b): b is HTMLButtonElement =>
      b instanceof HTMLButtonElement && b.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Button "${text}" not found`);
  return found;
}

function byAriaLabel(label: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`Button aria-label="${label}" not found`);
  return found;
}

function dialog(): HTMLElement {
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
  const top = dialogs[dialogs.length - 1];
  if (!top) throw new Error("No open dialog");
  return top;
}

function change(
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    control instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : control instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    control,
    value,
  );
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function labelled<T extends HTMLElement>(text: string): T {
  const label = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  const control = label?.htmlFor
    ? document.getElementById(label.htmlFor)
    : null;
  if (!control) throw new Error(`Control labelled "${text}" not found`);
  return control as T;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
  });
}

function text(): string {
  return document.body.textContent ?? "";
}

beforeEach(() => {
  // Manual "load more" is refused unless the app is known to be online.
  setOnlineStatusForTest("online");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.whoamiFresh.mockResolvedValue(me("admin"));
});

afterEach(() => {
  // Unmount before emptying the body. Emptying it only detaches the roots,
  // and a next/dynamic section that lands after the file's last test then
  // commits into a torn-down environment and fails the run (see _roots.ts).
  unmountRoots();
  setOnlineStatusForTest("connecting");
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

/* ------------------------ audience-74: notes ---------------------------- */

describe("NotesPanel — markdown notes, mentions, edit, attachments (audience-74)", () => {
  const baseNote = {
    id: noteId,
    subscriber_id: id,
    body: "Met at the trade show",
    markdown_body: "Met at the **trade show**",
    mentions: [],
    attachments: [],
    author_user_id: userId,
    author_email: "operator@example.com",
    pinned: false,
    created_at: "2026-09-01T10:00:00Z",
  };

  function prime(notes: unknown[]) {
    let current = notes;
    mocks.get.mockImplementation(async (path: string) => {
      if (path === `/api/v1/subscribers/${id}/notes`) {
        return { notes: current, count: current.length };
      }
      if (path === "/api/v1/workspace/members") {
        return {
          members: [
            {
              id: teammateId,
              email: "grace@example.com",
              role: "editor",
              status: "active",
              authProvider: "password",
              emailVerified: true,
              effectiveScopes: [],
              isSelf: false,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
          assignableRoles: [],
          assignableStatus: [],
          callerIsOwner: false,
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    return (next: unknown[]) => {
      current = next;
    };
  }

  function renderNotes() {
    return render(
      createElement(NotesPanel, { id, enabled: true, tenantId, role: "admin" }),
    );
  }

  it("posts a markdown note carrying the @-mention token picked from the roster", async () => {
    const setNotes = prime([]);
    mocks.post.mockImplementation(
      async (_path: string, _body?: unknown, _options?: unknown) => {
        setNotes([
          {
            ...baseNote,
            markdown_body: `Loop in @[grace@example.com](user:${teammateId}) on the *renewal*`,
            mentions: [{ user_id: teammateId, display: "grace@example.com" }],
          },
        ]);
        return { id: noteId };
      },
    );
    renderNotes();
    await waitFor(() =>
      expect(
        Array.from(
          labelled<HTMLSelectElement>("Mention a teammate").options,
        ).map((option) => option.text),
      ).toContain("grace@example.com"),
    );
    const composer = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="New note"]',
    )!;
    await act(async () => {
      change(composer, "Loop in ");
      composer.setSelectionRange(8, 8);
      await flush();
    });
    await act(async () => {
      change(labelled<HTMLSelectElement>("Mention a teammate"), teammateId);
      await flush();
    });
    expect(composer.value).toBe(
      `Loop in @[grace@example.com](user:${teammateId}) `,
    );
    await act(async () => {
      change(composer, `${composer.value}on the *renewal*`);
      await flush();
    });
    await click(button("Add note"));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const [path, body] = mocks.post.mock.calls[0] as [string, unknown];
    expect(path).toBe(`/api/v1/subscribers/${id}/notes`);
    expect(body).toEqual({
      markdown_body: `Loop in @[grace@example.com](user:${teammateId}) on the *renewal*`,
      pinned: false,
    });
    // The saved note renders as markdown with the mention as a teammate pill.
    await waitFor(() =>
      expect(
        document.querySelector(`[data-mention-user="${teammateId}"]`)
          ?.textContent,
      ).toBe("@grace@example.com"),
    );
    expect(document.querySelector("li em")?.textContent).toBe("renewal");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Note added.");
  });

  it("renders stored markdown safely: formatting yes, raw HTML never", async () => {
    prime([
      {
        ...baseNote,
        markdown_body:
          'Met at the **trade show** <img src="x" onerror="alert(1)"> [site](javascript:alert(1))',
      },
    ]);
    renderNotes();
    await waitFor(() =>
      expect(document.querySelector("li strong")?.textContent).toBe(
        "trade show",
      ),
    );
    expect(document.querySelector("li img")).toBeNull();
    const link = Array.from(document.querySelectorAll("li a")).find(
      (a) => a.textContent === "site",
    );
    expect(link?.getAttribute("href") ?? "").not.toMatch(/javascript:/i);
  });

  it("edits a note's markdown through the dialog with PATCH {markdown_body}", async () => {
    const setNotes = prime([baseNote]);
    mocks.patch.mockImplementation(
      async (_path: string, _body?: unknown, _options?: unknown) => {
        setNotes([{ ...baseNote, markdown_body: "Renewal due in **May**" }]);
        return { markdown_body: "Renewal due in **May**" };
      },
    );
    renderNotes();
    await waitFor(() => byAriaLabel("Edit note from operator@example.com"));
    await click(byAriaLabel("Edit note from operator@example.com"));
    const field = labelled<HTMLTextAreaElement>("Note text");
    expect(field.value).toBe("Met at the **trade show**");
    expect(dialog().textContent).toContain(
      "Saving replaces this note's text for everyone on the team.",
    );
    await act(async () => {
      change(field, "Renewal due in **May**");
      await flush();
    });
    await click(button("Save note", dialog()));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    const [path, body, options] = mocks.patch.mock.calls[0] as [
      string,
      unknown,
      { requireOnline?: boolean },
    ];
    expect(path).toBe(`/api/v1/subscribers/${id}/notes/${noteId}`);
    expect(body).toEqual({ markdown_body: "Renewal due in **May**" });
    expect(options.requireOnline).toBe(true);
    await waitFor(() =>
      expect(document.querySelector("li strong")?.textContent).toBe("May"),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Note updated.");
  });

  it("pins a note with PATCH {pinned: true}", async () => {
    prime([baseNote]);
    mocks.patch.mockImplementation(
      async (_path: string, _body?: unknown, _options?: unknown) => ({
        pinned: true,
      }),
    );
    renderNotes();
    await waitFor(() => byAriaLabel("Pin note from operator@example.com"));
    await click(byAriaLabel("Pin note from operator@example.com"));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    const [path, body] = mocks.patch.mock.calls[0] as [string, unknown];
    expect(path).toBe(`/api/v1/subscribers/${id}/notes/${noteId}`);
    expect(body).toEqual({ pinned: true });
  });

  it("withholds every note write from an editor (admin-scoped routes) with the reason", async () => {
    mocks.whoamiFresh.mockResolvedValue(me("editor"));
    prime([baseNote]);
    renderNotes();
    await waitFor(() =>
      expect(text()).toContain(
        "Notes need an owner or admin role; this session can read them but cannot add, edit, pin, or delete them.",
      ),
    );
    expect(byAriaLabel("Edit note from operator@example.com").disabled).toBe(
      true,
    );
    expect(byAriaLabel("Pin note from operator@example.com").disabled).toBe(
      true,
    );
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="New note"]',
      )?.disabled,
    ).toBe(true);
    // The roster (admin-only) is never requested for a session that can't use it.
    expect(
      mocks.get.mock.calls.some(
        ([path]) => path === "/api/v1/workspace/members",
      ),
    ).toBe(false);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("downloads an attachment from its presigned https link, and never links a script URL", async () => {
    prime([
      {
        ...baseNote,
        attachments: [
          {
            id: "a1",
            note_id: noteId,
            file_key: "invoice.pdf",
            filename: "invoice.pdf",
            content_type: "application/pdf",
            size_bytes: 2048,
            uploaded_at: "2026-09-01T10:00:00Z",
            download_url:
              "https://objects.example.com/tenants/t/invoice.pdf?X-Amz-Signature=abc",
          },
          {
            id: "a2",
            note_id: noteId,
            file_key: "evil.html",
            filename: "evil.html",
            content_type: "text/html",
            size_bytes: 10,
            uploaded_at: "2026-09-01T10:00:00Z",
            download_url: "javascript:alert(1)",
          },
        ],
      },
    ]);
    renderNotes();
    await waitFor(() =>
      expect(
        document.querySelector('a[aria-label="Download invoice.pdf"]'),
      ).not.toBeNull(),
    );
    const link = document.querySelector<HTMLAnchorElement>(
      'a[aria-label="Download invoice.pdf"]',
    )!;
    expect(link.getAttribute("href")).toBe(
      "https://objects.example.com/tenants/t/invoice.pdf?X-Amz-Signature=abc",
    );
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("download")).toBe("invoice.pdf");
    expect(text()).toContain("2.0 KB");
    expect(
      document.querySelector('a[aria-label="Download evil.html"]'),
    ).toBeNull();
    expect(text()).toContain("evil.html (download unavailable)");
  });

  it("removes an addressable attachment after a confirm that names the consequence", async () => {
    const setNotes = prime([
      {
        ...baseNote,
        attachments: [
          {
            id: "a1",
            note_id: noteId,
            file_key: "invoice.pdf",
            filename: "invoice.pdf",
            content_type: "application/pdf",
            size_bytes: 2048,
            uploaded_at: "2026-09-01T10:00:00Z",
          },
        ],
      },
    ]);
    mocks.delete.mockImplementation(
      async (_path: string, _options?: unknown) => {
        setNotes([baseNote]);
        return undefined;
      },
    );
    renderNotes();
    await waitFor(() => byAriaLabel("Remove invoice.pdf"));
    await click(byAriaLabel("Remove invoice.pdf"));
    expect(dialog().textContent).toContain(
      "This permanently deletes invoice.pdf from this note and from file storage. It cannot be restored",
    );
    expect(mocks.delete).not.toHaveBeenCalled();
    await click(button("Remove attachment", dialog()));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledTimes(1));
    const [path] = mocks.delete.mock.calls[0] as [string];
    expect(path).toBe(
      `/api/v1/subscribers/${id}/notes/${noteId}/attachments/invoice.pdf`,
    );
    await waitFor(() =>
      expect(document.querySelector('[aria-label="Attachments"]')).toBeNull(),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Removed invoice.pdf.");
  });

  it("removes a tenants/… storage key through the multi-segment route, one encoded segment per path part", async () => {
    // The route is {file_key:.+}: the key's slashes travel as separators, as
    // desktop sends them.
    const setNotes = prime([
      {
        ...baseNote,
        attachments: [
          {
            id: "a1",
            note_id: noteId,
            file_key: `tenants/${tenantId}/notes/invoice.pdf`,
            filename: "invoice.pdf",
            content_type: "application/pdf",
            size_bytes: 2048,
            uploaded_at: "2026-09-01T10:00:00Z",
          },
        ],
      },
    ]);
    mocks.delete.mockImplementation(
      async (_path: string, _options?: unknown) => {
        setNotes([baseNote]);
        return undefined;
      },
    );
    renderNotes();
    await waitFor(() => byAriaLabel("Remove invoice.pdf"));
    expect(byAriaLabel("Remove invoice.pdf").disabled).toBe(false);
    await click(byAriaLabel("Remove invoice.pdf"));
    await click(button("Remove attachment", dialog()));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledTimes(1));
    const [path] = mocks.delete.mock.calls[0] as [string];
    expect(path).toBe(
      `/api/v1/subscribers/${id}/notes/${noteId}/attachments/tenants/${tenantId}/notes/invoice.pdf`,
    );
  });

  it("withholds removal of a key whose path part needs escaping, with the reason", async () => {
    // An escaped segment makes the API route on the raw path and compare the
    // key still percent-encoded, so the request could never remove the row.
    prime([
      {
        ...baseNote,
        attachments: [
          {
            id: "a1",
            note_id: noteId,
            file_key: `tenants/${tenantId}/notes/report Q3.pdf`,
            filename: "report Q3.pdf",
            content_type: "application/pdf",
            size_bytes: 2048,
            uploaded_at: "2026-09-01T10:00:00Z",
          },
        ],
      },
    ]);
    renderNotes();
    await waitFor(() => byAriaLabel("Remove report Q3.pdf"));
    const remove = byAriaLabel("Remove report Q3.pdf");
    expect(remove.disabled).toBe(true);
    const reason = document.getElementById(
      remove.getAttribute("aria-describedby") ?? "",
    );
    expect(reason?.textContent).toContain(
      "storage path can't be addressed from the web app yet",
    );
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("keeps attachment upload withheld (server release hold) and never POSTs one", async () => {
    prime([baseNote]);
    renderNotes();
    await waitFor(() => button("Attach file · Unavailable"));
    const upload = button("Attach file · Unavailable");
    expect(upload.disabled).toBe(true);
    expect(
      document.getElementById(upload.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("Secure note uploads are unavailable");
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

/* -------------------- audience-78: engagement + AI ---------------------- */

const summary = {
  summary: "Engaged reader who clicks product launches.",
  drivers: [
    { key: "opens", label: "Opens (90d)", value: "14" },
    { key: "clicks", label: "Clicks (90d)", value: "6", weight: "high" },
  ],
  last_updated: "2026-09-10T08:00:00Z",
  cache_hit: true,
  source: "ai",
};

function primeInsights(
  overrides: {
    summaryResponse?: () => unknown;
    score?: unknown;
    rating?: () => unknown;
    history?: (options: { query?: Record<string, unknown> }) => unknown;
  } = {},
) {
  mocks.get.mockImplementation(
    async (path: string, options?: { query?: Record<string, unknown> }) => {
      if (path === `/api/v1/subscribers/${id}/ai-summary`) {
        return overrides.summaryResponse
          ? overrides.summaryResponse()
          : options?.query?.refresh === 1
            ? {
                ...summary,
                summary: "Freshly regenerated.",
                cache_hit: false,
              }
            : summary;
      }
      if (path === `/api/v1/subscribers/${id}/engagement-score`) {
        return (
          overrides.score ?? {
            score: 72,
            computed_at: "2026-09-11T08:00:00Z",
          }
        );
      }
      if (path === `/api/v1/contact-ratings/${id}`) {
        return overrides.rating
          ? overrides.rating()
          : {
              subscriber_id: id,
              stars: 3,
              engagement_score: 72,
              engagement_score_at: "2026-09-11T08:00:00Z",
              source: "manual",
            };
      }
      if (path === `/api/v1/subscribers/${id}/history`) {
        return overrides.history
          ? overrides.history(options ?? {})
          : { subscriber_id: id, items: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    },
  );
}

function renderInsights(authority: SubscriberAuthority | null) {
  return render(
    createElement(SubscriberInsightsPanel, {
      id,
      tenantId,
      role: authority ? authority.role : "viewer",
      authority,
    }),
  );
}

describe("SubscriberInsightsPanel — engagement score + AI summary (audience-78)", () => {
  it("renders the summary with its authorship disclosed, the drivers, and refreshes with ?refresh=1", async () => {
    primeInsights();
    renderInsights(editor);
    await waitFor(() =>
      expect(text()).toContain("Engaged reader who clicks product launches."),
    );
    expect(text()).toContain("AI-generated");
    expect(text()).toContain(
      "Written by an AI model from this subscriber's activity signals",
    );
    expect(text()).not.toContain("Opens (90d)");
    await click(button("▸ Why is this person here?"));
    expect(text()).toContain("Opens (90d): 14");
    expect(text()).toContain("Clicks (90d): 6");

    await click(button("Refresh"));
    await waitFor(() => expect(text()).toContain("Freshly regenerated."));
    const refreshCall = mocks.get.mock.calls.find(
      ([path, options]) =>
        path === `/api/v1/subscribers/${id}/ai-summary` &&
        (options as { query?: Record<string, unknown> } | undefined)?.query
          ?.refresh === 1,
    );
    expect(refreshCall).toBeDefined();
  });

  it("labels a rule-based summary as not AI-written", async () => {
    primeInsights({
      summaryResponse: () => ({ ...summary, source: "deterministic" }),
    });
    renderInsights(editor);
    await waitFor(() => expect(text()).toContain("Rule-based"));
    expect(text()).toContain("no AI model was used for this summary");
    expect(text()).not.toContain("AI-generated");
  });

  it("renders the stored engagement score, or says it has not been scored", async () => {
    primeInsights();
    const root = renderInsights(editor);
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="engagement-score-value"]')
          ?.textContent,
      ).toBe("72 / 100"),
    );
    act(() => root.unmount());
    document.body.innerHTML = "";

    primeInsights({ score: { score: null } });
    renderInsights(editor);
    await waitFor(() => expect(text()).toContain("Not scored yet"));
    expect(
      document.querySelector('[data-testid="engagement-score-value"]'),
    ).toBeNull();
  });

  it("renders the server's sentence when the summary fails", async () => {
    primeInsights({
      summaryResponse: () => {
        throw new ApiError(
          "Profile summaries are paused for this workspace.",
          503,
        );
      },
    });
    renderInsights(editor);
    await waitFor(() =>
      expect(text()).toContain(
        "Profile summaries are paused for this workspace.",
      ),
    );
    expect(button("Retry summary")).toBeTruthy();
  });
});

/* -------------------- audience-79: contact rating ----------------------- */

describe("SubscriberInsightsPanel — contact rating, history, recompute (audience-79)", () => {
  it("sets a manual rating with PATCH {rating} and shows it in the history", async () => {
    mocks.whoamiFresh.mockResolvedValue(me("editor"));
    let stars = 3;
    let events: unknown[] = [];
    primeInsights({
      rating: () => ({
        subscriber_id: id,
        stars,
        engagement_score: 72,
        source: "manual",
      }),
      history: () => ({ subscriber_id: id, items: events }),
    });
    mocks.patch.mockImplementation(
      async (_path: string, body?: unknown, _options?: unknown) => {
        stars = (body as { rating: number }).rating;
        events = [
          {
            id: "h1",
            tenant_id: tenantId,
            subscriber_id: id,
            kind: "rating.changed",
            at: "2026-09-12T09:00:00Z",
            payload: { rating: stars },
          },
        ];
        return { subscriber_id: id, rating: stars };
      },
    );
    renderInsights(editor);
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="rating-value"]')?.textContent,
      ).toBe("3/5"),
    );
    expect(text()).toContain("No history events recorded.");
    await click(byAriaLabel("4 stars"));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    const [path, body, options] = mocks.patch.mock.calls[0] as [
      string,
      unknown,
      { requireOnline?: boolean; idempotencyKey?: string },
    ];
    expect(path).toBe(`/api/v1/subscribers/${id}/rating`);
    expect(body).toEqual({ rating: 4 });
    expect(options.requireOnline).toBe(true);
    expect(options.idempotencyKey).toMatch(/^subscriber-rating:/);
    expect(mocks.whoamiFresh).toHaveBeenCalled();
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="rating-value"]')?.textContent,
      ).toBe("4/5"),
    );
    await waitFor(() =>
      expect(text()).toContain("Contact rating changed · 4 of 5 stars"),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Rated 4 of 5 stars.");
  });

  it("clears the manual rating with {rating: 0} when the current star is chosen again", async () => {
    mocks.whoamiFresh.mockResolvedValue(me("editor"));
    primeInsights();
    mocks.patch.mockImplementation(
      async (_path: string, _body?: unknown, _options?: unknown) => ({
        subscriber_id: id,
        rating: null,
      }),
    );
    renderInsights(editor);
    await waitFor(() =>
      expect(byAriaLabel("3 stars").getAttribute("aria-checked")).toBe("true"),
    );
    await click(byAriaLabel("3 stars"));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(mocks.patch.mock.calls[0]?.[1]).toEqual({ rating: 0 });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Manual rating cleared.");
  });

  it("keeps the stars read-only for a viewer and never PATCHes", async () => {
    primeInsights();
    renderInsights(null);
    // Wait for the loaded rating so "disabled" is the role gate, not the
    // loading state.
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="rating-value"]')?.textContent,
      ).toBe("3/5"),
    );
    expect(text()).toContain(
      "Viewer access can see the rating but can't change it.",
    );
    expect(byAriaLabel("4 stars").disabled).toBe(true);
    await click(byAriaLabel("4 stars"));
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("recomputes ratings workspace-wide for an admin, behind a confirm naming the consequence", async () => {
    primeInsights();
    mocks.post.mockImplementation(
      async (_path: string, _body?: unknown, _options?: unknown) => ({
        updated: 12,
        scanned: 40,
        started_at: "2026-09-12T09:00:00Z",
        finished_at: "2026-09-12T09:00:02Z",
        window_days: 90,
      }),
    );
    renderInsights(admin);
    await waitFor(() => button("Recompute (workspace-wide)"));
    await click(button("Recompute (workspace-wide)"));
    expect(dialog().textContent).toContain(
      "writes derived star ratings for every subscriber in this workspace that has no manual rating",
    );
    expect(dialog().textContent).toContain(
      "Manual ratings are never overwritten.",
    );
    expect(mocks.post).not.toHaveBeenCalled();
    await click(button("Recompute ratings", dialog()));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const [path, body, options] = mocks.post.mock.calls[0] as [
      string,
      unknown,
      { maxAttempts?: number; requireOnline?: boolean },
    ];
    expect(path).toBe("/api/v1/contact-ratings/recompute");
    expect(body).toEqual({});
    expect(options.maxAttempts).toBe(1);
    expect(options.requireOnline).toBe(true);
    await waitFor(() =>
      expect(text()).toContain(
        "Recomputed ratings workspace-wide: 12 updated of 40 scanned (90-day window).",
      ),
    );
  });

  it("withholds the recompute from an editor with the reason", async () => {
    primeInsights();
    renderInsights(editor);
    await waitFor(() => button("Recompute (workspace-wide)"));
    const recompute = button("Recompute (workspace-wide)");
    expect(recompute.disabled).toBe(true);
    expect(
      document.getElementById(recompute.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("Recomputing ratings needs an owner or admin role.");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("pages older rating history with the server's cursor", async () => {
    primeInsights({
      history: ({ query }) =>
        query?.before === "cursor-1"
          ? {
              subscriber_id: id,
              items: [
                {
                  id: "h0",
                  subscriber_id: id,
                  kind: "rating.changed",
                  at: "2026-08-01T09:00:00Z",
                  payload: { rating: 0 },
                },
              ],
            }
          : {
              subscriber_id: id,
              items: [
                {
                  id: "h1",
                  subscriber_id: id,
                  kind: "rating.changed",
                  at: "2026-09-01T09:00:00Z",
                  payload: { rating: 5 },
                },
              ],
              next_cursor: "cursor-1",
            },
    });
    renderInsights(editor);
    await waitFor(() =>
      expect(text()).toContain("Contact rating changed · 5 of 5 stars"),
    );
    await click(button("Load older events"));
    await waitFor(() =>
      expect(text()).toContain("Contact rating changed · Rating cleared"),
    );
    const historyCalls = mocks.get.mock.calls.filter(
      ([path]) => path === `/api/v1/subscribers/${id}/history`,
    );
    expect(
      historyCalls.map(
        ([, options]) =>
          (options as { query?: Record<string, unknown> }).query?.before,
      ),
    ).toEqual([undefined, "cursor-1"]);
  });
});

/* ---------------------- audience-50: DSAR export ------------------------ */

describe("SubscriberDataExportButton — DSAR data package (audience-50)", () => {
  function stubFetch(response: () => Response) {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => response(),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("downloads the ZIP the server names and confirms it", async () => {
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const fetchMock = stubFetch(
      () =>
        new Response(zipBytes, {
          status: 200,
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition":
              'attachment; filename="subscriber-ada-example-com-data-export-2026-09-12.zip"',
          },
        }),
    );
    render(createElement(SubscriberDataExportButton, { id, authority: admin }));
    await click(button("Export data (DSAR)"));

    await waitFor(() =>
      expect(mocks.downloadBlobFile).toHaveBeenCalledTimes(1),
    );
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toMatch(
      new RegExp(`/api/v1/subscribers/${id}/data-export\\.zip$`),
    );
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).Accept).toBe(
      "application/zip",
    );
    const [filename, blob] = mocks.downloadBlobFile.mock.calls[0] as [
      string,
      Blob,
    ];
    expect(filename).toBe(
      "subscriber-ada-example-com-data-export-2026-09-12.zip",
    );
    expect(blob.size).toBe(zipBytes.byteLength);
    await waitFor(() =>
      expect(text()).toContain(
        "Data export downloaded (subscriber-ada-example-com-data-export-2026-09-12.zip).",
      ),
    );
  });

  it("renders the server's denial sentence and saves nothing", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: "insufficient_role",
              message: "Your role does not have permission for this route.",
            },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
    );
    render(createElement(SubscriberDataExportButton, { id, authority: admin }));
    await click(button("Export data (DSAR)"));
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Your role does not have permission for this route.",
      ),
    );
    expect(mocks.downloadBlobFile).not.toHaveBeenCalled();
  });

  it("withholds the export from an editor with the reason and never fetches", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));
    render(
      createElement(SubscriberDataExportButton, { id, authority: editor }),
    );
    const exportButton = button("Export data (DSAR)");
    expect(exportButton.disabled).toBe(true);
    expect(
      document.getElementById(
        exportButton.getAttribute("aria-describedby") ?? "",
      )?.textContent,
    ).toBe(
      "Exporting a subscriber's data package needs an owner or admin role.",
    );
    await click(exportButton);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ------------- reachability: mounted by the detail page's tabs ----------- */

describe("SubscriberDetailPanels — the new sections are reachable from their tabs", () => {
  // Each tab mounts more next/dynamic sections than the one its test asserts
  // on: the mobile layout keeps the Timeline open, and Engagement also mounts
  // four engagement-extras sections. Pay their cold imports in a hook, on its
  // cold-import timeout, rather than on a test's 5 s clock.
  importBeforeTests(
    () => import("@/app/(dashboard)/app/subscribers/[id]/_engagement-extras"),
    () => import("@/app/(dashboard)/app/subscribers/[id]/_timeline"),
    () => import("@/app/(dashboard)/app/subscribers/[id]/_pii-findings-panel"),
  );

  /**
   * The "Loading …" placeholders still mounted, one per next/dynamic section
   * whose chunk has not landed yet. Each test ends only once this is empty,
   * so no section finishes loading after its test and commits outside act().
   */
  function sectionsStillLoading(): string[] {
    return Array.from(document.querySelectorAll('[role="status"]'))
      .map((node) => node.textContent?.trim() ?? "")
      .filter((label) => /^Loading .+…$/.test(label));
  }

  function renderTab(tab: "engagement" | "notes" | "audit") {
    return render(
      createElement(SubscriberDetailPanels, {
        tab,
        onTabChange: () => undefined,
        timeline: {
          subscriber_id: id,
          email: "ada@example.com",
          stats: {} as never,
          events: [],
          pagination: {} as never,
        },
        record: undefined,
        id,
        tenantId,
        role: "admin",
        authority: admin,
        buckets: [],
        hasMore: false,
        onLoadMore: () => undefined,
        loadingMore: false,
        loadMoreError: null,
        category: "all",
        onCategoryChange: () => undefined,
        onRecordRefetch: () => undefined,
      }),
    );
  }

  it("mounts the insights panel on the Engagement tab", async () => {
    primeInsights();
    renderTab("engagement");
    await waitFor(() =>
      expect(text()).toContain("Engaged reader who clicks product launches."),
    );
    expect(
      document.querySelector('[role="radiogroup"][aria-label="Rating"]'),
    ).not.toBeNull();
    expect(text()).toContain("Recompute (workspace-wide)");
    await waitFor(() => expect(sectionsStillLoading()).toEqual([]));
  });

  it("mounts the DSAR export beside the compliance receipts on the Audit tab", async () => {
    mocks.get.mockImplementation(async () => ({ items: [] }));
    renderTab("audit");
    await waitFor(() => button("Export data (DSAR)"));
    expect(button("Export data (DSAR)").disabled).toBe(false);
    await waitFor(() => expect(sectionsStillLoading()).toEqual([]));
  });

  it("mounts the extended notes panel on the Notes tab", async () => {
    mocks.get.mockImplementation(async (path: string) =>
      path === "/api/v1/workspace/members"
        ? { members: [] }
        : { notes: [], count: 0 },
    );
    renderTab("notes");
    await waitFor(() => button("Attach file · Unavailable"));
    expect(
      mocks.get.mock.calls.some(
        ([path]) => path === `/api/v1/subscribers/${id}/notes`,
      ),
    ).toBe(true);
    await waitFor(() => expect(sectionsStillLoading()).toEqual([]));
  });
});
