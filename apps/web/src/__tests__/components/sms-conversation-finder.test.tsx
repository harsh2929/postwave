// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The Inbox tab's "Find conversations" card, driven through the real SMS
// transport with only the shared `api` shell mocked: server search (POST body,
// paging cursor, refresh), per-result subscriber + consent context, and the
// audited CSV export (reason header → server bounds → private save).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setOnlineStatusForTest } from "@/lib/online-manager";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  download: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
const network = vi.hoisted(() => ({ status: "online" as string }));

vi.mock("@/lib/api", () => ({
  api: { get: mocks.get, post: mocks.post },
  apiErrorMessage: (error: unknown, fallback = "Something went wrong") =>
    error instanceof Error && error.message ? error.message : fallback,
  isApiError: () => false,
}));
vi.mock("@/lib/download", () => ({ downloadBlobFile: mocks.download }));
vi.mock("@/lib/use-online", () => ({ useOnline: () => network.status }));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { SmsConversationFinder } from "@/components/sms/ConversationFinder";
import type { MeResponse } from "@/lib/auth-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const PHONE_A = "+15552345678";
const PHONE_B = "+15553456789";
const SNAPSHOT = "2026-09-10T10:00:00Z";
const roots: Root[] = [];
let lastClient: QueryClient | null = null;

function me(role: "owner" | "admin" | "editor", viewerMode = false): MeResponse {
  return {
    user_id: USER,
    tenant_id: TENANT,
    email: "admin@example.test",
    role,
    effective_role: role,
    viewer_mode: viewerMode,
    workspace_slug: "acme",
  } as unknown as MeResponse;
}

function row(phone: string, lastMessageAt: string, preview: string) {
  return {
    phoneE164: phone,
    identityAmbiguous: false,
    lastMessagePreview: preview,
    lastMessageAt,
    lastDirection: "inbound",
    messageCount: 3,
    unreadCount: 1,
    oldestUnreadAt: lastMessageAt,
    subscriberEmail: "ada@example.test",
  };
}

const CONTEXT = {
  tenantId: TENANT,
  phoneE164: PHONE_A,
  subscriberEmail: "ada@example.test",
  consentStatus: "none",
  consentMixed: false,
  identityAmbiguous: false,
  consentEvidenceSufficient: false,
  subscribedLists: 0,
  firstSeenAt: "2026-07-01T09:00:00Z",
  totalMessages: 42,
  suppressed: true,
  suppressionReason: "stop_keyword",
  suppressionReversible: false,
  hasInboundThread: true,
  eligibleLists: [],
  replyDispatchAvailable: false,
  replyDispatchUnavailableReason: "sms_reply_dispatch_release_held",
};

const CSV =
  "phone_e164,last_message_at,message_count,last_inbound_at\n" +
  "'+15552345678,2026-09-10T09:00:00Z,3,2026-09-10T09:00:00Z\n" +
  "'+15553456789,2026-09-09T09:00:00Z,1,\n";

async function eventually(assertion: () => void, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  do {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await act(
      async () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
    );
  } while (Date.now() < deadline);
  throw lastError;
}

async function mount(profile: MeResponse) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  lastClient = client;
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SmsConversationFinder baseKey={["sms", TENANT, "admin"]} me={profile} />
      </QueryClientProvider>,
    );
  });
  return container;
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name ||
      candidate.getAttribute("aria-label") === name,
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`button ${name} not found`);
  }
  return found;
}

async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function searchInput(): HTMLInputElement {
  const input = document.querySelector('input[type="search"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("no search input");
  return input;
}

beforeEach(() => {
  // Manual "load more" is refused unless the app is known to be online.
  setOnlineStatusForTest("online");
  network.status = "online";
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.post.mockImplementation(
    async (_path: string, body: { cursor?: string }) =>
      body.cursor
        ? {
            tenantId: TENANT,
            conversations: [row(PHONE_B, "2026-09-09T09:00:00Z", "Second page")],
            snapshotAt: SNAPSHOT,
          }
        : {
            tenantId: TENANT,
            conversations: [row(PHONE_A, "2026-09-10T09:00:00Z", "Where is my order?")],
            nextCursor: "v1.page-two",
            snapshotAt: SNAPSHOT,
          },
  );
  mocks.get.mockImplementation(
    async (path: string, opts?: { onResponse?: (response: Response) => void }) => {
      if (path.endsWith("/context")) return CONTEXT;
      if (path === "/api/v1/sms/conversations.csv") {
        opts?.onResponse?.(
          new Response(null, {
            headers: {
              "Content-Disposition":
                'attachment; filename="postwave-sms-conversations-20260910-100000.csv"',
              "X-Postwave-Export-Limit": "10000",
              "X-Postwave-Export-As-Of": "2026-09-10T10:00:00Z",
              "X-Postwave-Export-Row-Count": "2",
              "X-Postwave-Truncated": "false",
            },
          }),
        );
        return CSV;
      }
      throw new Error(`unexpected GET ${path}`);
    },
  );
});

afterEach(() => {
  setOnlineStatusForTest("connecting");
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("SmsConversationFinder", () => {
  it("is withheld from non-admin and viewer-mode sessions and requests nothing", async () => {
    const editor = await mount(me("editor"));
    expect(editor.textContent).toBe("");
    const viewer = await mount(me("admin", true));
    expect(viewer.textContent).toBe("");
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("waits for three characters, then POSTs the search in the body and renders matches", async () => {
    const container = await mount(me("admin"));
    await type(searchInput(), "ad");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(mocks.post).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Type at least 3 characters to search.");

    await type(searchInput(), "ada@");
    await eventually(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const [path, body, opts] = mocks.post.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(path).toBe("/api/v1/sms/conversations/search");
    expect(body).toEqual({ query: "ada@", limit: 50 });
    expect(opts.idempotencyKey).toBeNull();
    await eventually(() => {
      expect(container.textContent).toContain(PHONE_A);
      expect(container.textContent).toContain("Where is my order?");
      expect(container.textContent).toContain(
        "1 match shown · more results available for this response cutoff",
      );
    });
  });

  it("loads the next page with the server cursor and restarts on Refresh search", async () => {
    const container = await mount(me("owner"));
    await type(searchInput(), "order");
    await eventually(() => expect(container.textContent).toContain(PHONE_A));

    await act(async () => button("Load more results").click());
    await eventually(() => expect(container.textContent).toContain(PHONE_B));
    expect(mocks.post.mock.calls[1]?.[1]).toEqual({
      query: "order",
      limit: 50,
      cursor: "v1.page-two",
    });
    expect(container.textContent).toContain("2 matches shown · end of results");

    await act(async () => button("Refresh search").click());
    await eventually(() => expect(mocks.post).toHaveBeenCalledTimes(3));
    expect(mocks.post.mock.calls[2]?.[1]).toEqual({ query: "order", limit: 50 });
    await eventually(() => {
      expect(container.textContent).toContain(PHONE_A);
      expect(container.textContent).not.toContain(PHONE_B);
    });
  });

  it("renders the server's refusal sentence when search fails", async () => {
    mocks.post.mockRejectedValueOnce(
      new Error("query must be 3 to 128 safe Unicode characters"),
    );
    const container = await mount(me("admin"));
    await type(searchInput(), "order");
    await eventually(() =>
      expect(container.textContent).toContain(
        "Server search could not complete. query must be 3 to 128 safe Unicode characters",
      ),
    );
  });

  it("shows the subscriber, suppression, dispatch and retained-count context for a match", async () => {
    const container = await mount(me("admin"));
    await type(searchInput(), "order");
    await eventually(() => expect(container.textContent).toContain(PHONE_A));

    await act(async () =>
      button(`Show subscriber & consent for ${PHONE_A}`).click(),
    );
    await eventually(() =>
      expect(container.textContent).toContain("42 retained message records"),
    );
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/sms/conversations/%2B15552345678/context",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Suppressed");
    expect(text).toContain("Subscriber: ada@example.test");
    expect(text).toContain("Suppression category: STOP keyword");
    expect(text).toContain("Live dispatch unavailable");
    expect(text).toContain("sms_reply_dispatch_release_held");
    expect(text).toContain("No exact send-eligible SMS list");
    // Neither the raw phone number nor the search text enters cache metadata.
    const keys = JSON.stringify(
      lastClient?.getQueryCache().getAll().map((query) => query.queryKey),
    );
    expect(keys).toContain("conversation-finder");
    expect(keys).not.toContain("5552345678");
    expect(keys).not.toContain("order");
    expect(
      button(`Hide subscriber & consent for ${PHONE_A}`).getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");
  });

  it("exports only after an audit reason and a review of the server's bounds", async () => {
    await mount(me("admin"));
    await act(async () => button("Export CSV").click());
    await eventually(() =>
      expect(document.body.textContent).toContain("Prepare audited SMS export"),
    );
    const reason = document.getElementById("sms-export-audit-reason");
    if (!(reason instanceof HTMLTextAreaElement)) throw new Error("no reason");

    await act(async () => button("Review export bounds").click());
    await eventually(() =>
      expect(document.body.textContent).toContain(
        "Enter an audit reason for this export.",
      ),
    );
    expect(mocks.get).not.toHaveBeenCalled();

    await type(reason, "Quarterly support review");
    await act(async () => button("Review export bounds").click());
    await eventually(() =>
      expect(document.body.textContent).toContain("Save 2-row SMS export?"),
    );
    const [path, opts] = mocks.get.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/api/v1/sms/conversations.csv");
    expect(opts.headers).toEqual({
      Accept: "text/csv",
      "X-Postwave-Audit-Reason": "Quarterly support review",
    });
    expect(document.body.textContent).toContain(
      "The response cap is 10,000 rows. The server did not report truncation. Current inbox filters and search are not applied.",
    );
    expect(mocks.download).not.toHaveBeenCalled();

    await act(async () => button("Save private CSV").click());
    await eventually(() => expect(mocks.download).toHaveBeenCalledTimes(1));
    const [filename, blob] = mocks.download.mock.calls[0] as [string, Blob];
    expect(filename).toBe("postwave-sms-conversations-20260910-100000.csv");
    expect(await blob.text()).toBe(CSV);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("2 rows saved with a server as-of boundary"),
    );
  });

  it("withholds export and search while offline, saying why", async () => {
    network.status = "offline";
    const container = await mount(me("admin"));
    expect(button("Export CSV").disabled).toBe(true);
    expect(container.textContent).toContain("Export needs a live connection.");
    await type(searchInput(), "order");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(container.textContent).toContain(
      "Offline — search needs a live connection.",
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("discarding the prepared export saves nothing", async () => {
    await mount(me("admin"));
    await act(async () => button("Export CSV").click());
    await eventually(() =>
      expect(document.getElementById("sms-export-audit-reason")).not.toBeNull(),
    );
    const reason = document.getElementById("sms-export-audit-reason");
    if (!(reason instanceof HTMLTextAreaElement)) throw new Error("no reason");
    await type(reason, "Audit");
    await act(async () => button("Review export bounds").click());
    await eventually(() =>
      expect(document.body.textContent).toContain("Save 2-row SMS export?"),
    );
    await act(async () => button("Discard prepared export").click());
    await eventually(() =>
      expect(document.body.textContent).not.toContain("Save 2-row SMS export?"),
    );
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
