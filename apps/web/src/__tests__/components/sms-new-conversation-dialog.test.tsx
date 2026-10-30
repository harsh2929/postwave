// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// New SMS conversation (parity row messaging-19). Real transport, real
// durable-intent store. Typing a US/CA recipient loads the context through
// GET …/{phone}/context (debounced); while it reports the release hold, Send
// stays disabled with the exact hold sentence as its description and no
// request is sent. With the hold lifted the same reply route receives the
// exact request under one Idempotency-Key and the caller learns the number.
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
      _opts?: { idempotencyKey?: string | null; maxAttempts?: number; requireOnline?: boolean },
    ): Promise<unknown> => ({}),
  ),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: mocks.get, post: mocks.post } };
});
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { NewConversationDialog } from "@/components/sms/NewConversationDialog";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PHONE = "+12025550118";
const LIST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SENDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const MSG = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
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
    totalMessages: 0,
    suppressed: false,
    suppressionReversible: false,
    hasInboundThread: false,
    eligibleLists: [{ id: LIST, name: "VIP texts", description: "" }],
    replyDispatchAvailable: available,
    ...(available ? {} : { replyDispatchUnavailableReason: "sms_reply_dispatch_release_held" }),
  };
}

const senders = {
  items: [
    {
      id: SENDER,
      provider: "telnyx",
      country: "US",
      sender_type: "10dlc",
      phone_number: "+14155550100",
      registration_status: "approved",
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
    provider: "telnyx",
    provider_message_id: "TX1",
    direction: "outbound",
    segments: 1,
    status: "queued",
    cost_micros: 0,
    created_at: "2026-09-12T10:00:00Z",
  },
  providerReceipt: { provider: "telnyx", providerMessageId: "TX1", status: "queued" },
};

let root: Root | null = null;
const onClose = vi.fn(() => undefined);
const onSent = vi.fn((_phone: string) => undefined);

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
        createElement(NewConversationDialog, {
          tenantId: TENANT,
          intentScope: `${TENANT}:user`,
          online: "online",
          queryBase: ["sms", TENANT],
          onClose,
          onSent,
        }),
      ),
    ),
  );
}

const flush = async (times = 6, ms = 0) => {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
};

function dialog(): HTMLElement {
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const target = Array.from(dialog().querySelectorAll("label")).find(
    (l) => l.textContent?.trim() === label,
  )!;
  return document.getElementById(target.htmlFor) as HTMLInputElement | HTMLTextAreaElement;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(dialog().querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`button ${label} missing`);
  return found as HTMLButtonElement;
}

function routeGet(available: boolean) {
  mocks.get.mockImplementation(async (path: string) => {
    if (path.endsWith("/context")) return context(available);
    if (path === "/api/v1/sms/senders") return senders;
    throw new Error(`unexpected GET ${path}`);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.get.mockReset();
  mocks.post.mockReset().mockResolvedValue(persisted);
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  onClose.mockReset();
  onSent.mockReset();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("NewConversationDialog", () => {
  it("is mounted on demand in the SMS workspace inbox tab through next/dynamic", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const workspace = readFileSync(
      resolve(process.cwd(), "src/app/(dashboard)/app/sms/sms-workspace.tsx"),
      "utf8",
    );
    expect(workspace).toContain('import("@/components/sms/NewConversationDialog")');
    expect(workspace).not.toMatch(
      /^import (?!type )[^;]*from "@\/components\/sms\/NewConversationDialog";/m,
    );
    expect(workspace).toContain("New conversation");
    expect(workspace).toMatch(
      /newConversationOpen && inboxAdmin \? \(\s*<SmsNewConversationDialog/,
    );
    expect(workspace).toContain('queryKey: [...smsBaseKey, "inbox-v2"]');
  });

  it("verifies the typed number, then keeps Send disabled with the exact hold sentence and sends nothing", async () => {
    routeGet(false);
    render();
    await flush();
    expect(dialog().textContent).toContain("New SMS conversation");
    setValue(field("Recipient (US/Canada only)"), "(202) 555-0118");
    setValue(field("Message"), "Welcome aboard");
    await flush(3, 150);
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/sms/conversations/%2B12025550118/context",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const send = button("Send");
    expect(send.disabled).toBe(true);
    const described = document.getElementById(send.getAttribute("aria-describedby")!);
    expect(described?.textContent).toBe(HOLD);
    const status = Array.from(dialog().querySelectorAll('[role="status"]')).map((el) => el.textContent);
    expect(status).toContain(HOLD);
    act(() => send.click());
    await flush();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("rejects a non-US/CA recipient before any context read", async () => {
    routeGet(false);
    render();
    await flush();
    setValue(field("Recipient (US/Canada only)"), "+44 20 7946 0958");
    await flush(3, 150);
    expect(dialog().textContent).toContain("Enter 10 US/Canada digits");
    expect(mocks.get.mock.calls.some(([path]) => String(path).endsWith("/context"))).toBe(false);
    expect(button("Send").disabled).toBe(true);
  });

  it("sends the exact first message under one durable key when dispatch is available", async () => {
    routeGet(true);
    render();
    await flush();
    setValue(field("Recipient (US/Canada only)"), "+1 202 555 0118");
    setValue(field("Message"), "  Welcome aboard ");
    await flush(3, 150);
    expect(dialog().textContent).toContain("1 billable segment");
    const send = button("Send");
    expect(send.disabled).toBe(false);
    act(() => send.click());
    await flush(10);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [path, body, opts] = mocks.post.mock.calls[0]!;
    expect(path).toBe("/api/v1/sms/conversations/%2B12025550118/reply");
    expect(body).toEqual({ sender_profile_id: SENDER, body: "Welcome aboard", list_id: LIST });
    expect(opts).toEqual({
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      maxAttempts: 1,
      requireOnline: true,
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Message persisted with a provider receipt");
    expect(onSent).toHaveBeenCalledWith(PHONE);
    expect(window.localStorage.length).toBe(0);
  });
});
