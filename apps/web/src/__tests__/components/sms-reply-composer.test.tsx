// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Reply composer (parity row messaging-15) + saved-reply insert/use
// (messaging-16). Only the `api` shell is mocked; the real transport and the
// real durable-intent store (localStorage) run. Asserts: while the context
// reports the release hold, Send is aria-disabled with the exact hold
// sentence and NO request is sent (button and ⌘↵); when the hold is lifted
// the exact reply request (path, body, Idempotency-Key option, one attempt)
// goes out, the checkpoint settles, and a saved-reply pick is recorded
// through POST …/quick-replies/{id}/use after the persisted send.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  get: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => ({})),
  post: vi.fn(
    async (
      _path: string,
      _body?: unknown,
      _opts?: {
        idempotencyKey?: string | null;
        maxAttempts?: number;
        requireOnline?: boolean;
      },
    ): Promise<unknown> => ({}),
  ),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: mocks.get, post: mocks.post },
  };
});
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { ReplyComposer } from "@/components/sms/ReplyComposer";
import { ApiError } from "@/lib/api";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PHONE = "+14155550123";
const LIST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SENDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const MSG = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const QUICK = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const HOLD =
  "Live SMS reply dispatch is release-held while durable provider reconciliation and budget settlement are unavailable. No provider request can be started.";

function context(available: boolean) {
  return {
    tenantId: TENANT,
    phoneE164: PHONE,
    consentStatus: "opted_in",
    consentMixed: false,
    identityAmbiguous: false,
    consentEvidenceSufficient: true,
    subscribedLists: 1,
    totalMessages: 3,
    suppressed: false,
    suppressionReversible: false,
    hasInboundThread: true,
    eligibleLists: [
      {
        id: LIST,
        name: "VIP texts",
        description: "",
        consentSource: "form",
        consentAt: "2026-09-01T09:00:00Z",
      },
    ],
    replyDispatchAvailable: available,
    ...(available
      ? {}
      : { replyDispatchUnavailableReason: "sms_reply_dispatch_release_held" }),
  };
}

const senders = {
  items: [
    {
      id: SENDER,
      provider: "twilio",
      country: "US",
      sender_type: "10dlc",
      phone_number: "+14155550100",
      registration_status: "approved",
      created_at: "",
      updated_at: "",
    },
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      provider: "twilio",
      country: "US",
      sender_type: "10dlc",
      phone_number: "+14155550101",
      registration_status: "draft",
      created_at: "",
      updated_at: "",
    },
  ],
};

const persisted = {
  disposition: "persisted",
  message: {
    id: MSG,
    tenant_id: TENANT,
    sender_profile_id: SENDER,
    provider: "twilio",
    provider_message_id: "SM123",
    direction: "outbound",
    segments: 1,
    status: "queued",
    cost_micros: 0,
    created_at: "2026-09-12T10:00:00Z",
  },
  providerReceipt: { provider: "twilio", providerMessageId: "SM123", status: "queued" },
};

let root: Root | null = null;
const onSent = vi.fn((_outcome: unknown) => undefined);

function render() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ReplyComposer, {
          tenantId: TENANT,
          phoneE164: PHONE,
          intentScope: `${TENANT}:user`,
          online: "online",
          queryBase: ["sms", TENANT, "thread"],
          onSent,
        }),
      ),
    ),
  );
  return container;
}

const flush = async (times = 6) => {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

function textarea(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>("textarea")!;
}

function typeBody(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea(),
      value,
    );
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`button ${label} missing`);
  return found as HTMLButtonElement;
}

function routeGet(available: boolean) {
  mocks.get.mockImplementation(async (path: string) => {
    if (path.endsWith("/context")) return context(available);
    if (path === "/api/v1/sms/senders") return senders;
    if (path === "/api/v1/sms/quick-replies") {
      return {
        replies: [
          {
            id: QUICK,
            label: "Thanks",
            body: "Thanks for reaching out!",
            useCount: 2,
            createdAt: "",
            updatedAt: "",
          },
        ],
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.get.mockReset();
  mocks.post.mockReset().mockResolvedValue(persisted);
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  onSent.mockReset();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("ReplyComposer under the release hold (messaging-15)", () => {
  it("disables Send with the exact hold sentence and sends nothing on click or ⌘↵", async () => {
    routeGet(false);
    const container = render();
    await flush();
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/sms/conversations/%2B14155550123/context",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/sms/senders");
    const status = Array.from(container.querySelectorAll('[role="status"]')).find(
      (el) => el.textContent?.includes(HOLD),
    );
    expect(status?.textContent).toContain("sms_reply_dispatch_release_held");

    typeBody("Hello there");
    const send = button("Send reply");
    expect(send.getAttribute("aria-disabled")).toBe("true");
    expect(send.title).toBe(HOLD);
    const described = document.getElementById(send.getAttribute("aria-describedby")!);
    expect(described?.textContent).toBe(HOLD);

    act(() => send.click());
    act(() => {
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
      );
    });
    await flush();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });
});

describe("ReplyComposer with dispatch available", () => {
  it("sends the exact reply request under one durable key on ⌘↵, then settles and reports the receipt", async () => {
    routeGet(true);
    render();
    await flush();
    typeBody("Hello there");
    const send = button("Send reply");
    expect(send.getAttribute("aria-disabled")).toBe("false");
    expect(document.body.textContent).toContain("1 segment");

    act(() => {
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
    });
    await flush(10);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [path, body, opts] = mocks.post.mock.calls[0]!;
    expect(path).toBe("/api/v1/sms/conversations/%2B14155550123/reply");
    expect(body).toEqual({ sender_profile_id: SENDER, body: "Hello there", list_id: LIST });
    expect(opts).toEqual({
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      maxAttempts: 1,
      requireOnline: true,
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Reply persisted with a provider receipt");
    expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ disposition: "persisted" }));
    expect(textarea().value).toBe("");
    // Terminal outcome: the checkpoint is settled, nothing lingers.
    expect(window.localStorage.length).toBe(0);
  });

  it("locks the composer on a reconciliation outcome and refuses to replay the same draft", async () => {
    routeGet(true);
    mocks.post.mockResolvedValueOnce({
      disposition: "reconciliation_required",
      code: "reply_reconciliation_required",
      intentMessageId: MSG,
      providerReceipt: { provider: "twilio", status: "unknown" },
    });
    const container = render();
    await flush();
    typeBody("Hello there");
    act(() => button("Send reply").click());
    await flush(10);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("The delivery outcome is not yet known.");
    expect(button("Send reply").getAttribute("aria-disabled")).toBe("true");
    const stored = window.localStorage.getItem(
      `postwave.web.sms-reply-intents.v1:${TENANT}:user`,
    );
    expect(stored).toContain('"state":"unknown"');
    expect(stored).not.toContain(PHONE);
    act(() => button("Send reply").click());
    await flush();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(onSent).not.toHaveBeenCalled();
  });

  it("renders the server's 503 hold refusal verbatim and settles the checkpoint", async () => {
    routeGet(true);
    mocks.post.mockRejectedValueOnce(
      new ApiError("held", 503, undefined, { code: "sms_reply_dispatch_release_held" }),
    );
    render();
    await flush();
    typeBody("Hello there");
    act(() => button("Send reply").click());
    await flush(10);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "SMS reply dispatch is release-held while durable provider reconciliation and budget settlement are unavailable. No provider send was attempted.",
    );
    expect(window.localStorage.length).toBe(0);
    expect(onSent).not.toHaveBeenCalled();
  });

  it("inserts a saved reply and records its use only after a persisted send (messaging-16)", async () => {
    routeGet(true);
    render();
    await flush();
    act(() => button("Quick replies").click());
    await flush();
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/sms/quick-replies",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    act(() => button("Insert saved reply: Thanks").click());
    await flush();
    expect(textarea().value).toBe("Thanks for reaching out!");
    expect(mocks.post).not.toHaveBeenCalled();

    mocks.post.mockImplementation(async (path: string) =>
      path.endsWith("/use")
        ? { ok: true, tenantId: TENANT, id: QUICK, useCount: 3, lastUsedAt: "2026-09-12T10:00:00Z" }
        : persisted,
    );
    act(() => button("Send reply").click());
    await flush(10);
    const paths = mocks.post.mock.calls.map(([path]) => path);
    expect(paths).toEqual([
      "/api/v1/sms/conversations/%2B14155550123/reply",
      `/api/v1/sms/quick-replies/${QUICK}/use`,
    ]);
    expect(mocks.post.mock.calls[0]![1]).toEqual({
      sender_profile_id: SENDER,
      body: "Thanks for reaching out!",
      list_id: LIST,
    });
  });
});
