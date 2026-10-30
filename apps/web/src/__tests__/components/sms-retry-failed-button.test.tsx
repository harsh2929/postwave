// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Retry failed outbound SMS (parity row messaging-20). Renders only for a
// terminal outbound failure; the confirm loads context + senders through the
// real transport; while the context reports the release hold the confirm is
// disabled with the exact hold sentence and NO request is sent; with the hold
// lifted the retained body is re-sent as one new intent under one
// Idempotency-Key with the chosen eligible list and approved sender.
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

import {
  RetryFailedSmsButton,
  isRetryableSmsMessage,
} from "@/components/sms/RetryFailedSmsButton";
import type { SmsConversationMessage } from "@/lib/sms-inbox-contract";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PHONE = "+14155550123";
const LIST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SENDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const MSG = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const HOLD =
  "Live SMS reply dispatch is release-held while durable provider reconciliation and budget settlement are unavailable. No provider request can be started.";

const failed: SmsConversationMessage = {
  id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc9",
  tenant_id: TENANT,
  phone_e164: PHONE,
  provider: "twilio",
  direction: "outbound",
  body: "Your order shipped!",
  segments: 1,
  status: "failed",
  error_code: "30007",
  cost_micros: 0,
  created_at: "2026-09-12T09:00:00Z",
};

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
    eligibleLists: [{ id: LIST, name: "VIP texts", description: "" }],
    replyDispatchAvailable: available,
    ...(available ? {} : { replyDispatchUnavailableReason: "sms_reply_dispatch_release_held" }),
  };
}

const senders = {
  items: [
    {
      id: SENDER,
      provider: "twilio",
      country: "US",
      sender_type: "toll_free",
      phone_number: "+18005550100",
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
    provider: "twilio",
    provider_message_id: "SM9",
    direction: "outbound",
    segments: 1,
    status: "queued",
    cost_micros: 0,
    created_at: "2026-09-12T10:00:00Z",
  },
  providerReceipt: { provider: "twilio", providerMessageId: "SM9", status: "queued" },
};

let root: Root | null = null;
const onRetried = vi.fn((_outcome: unknown) => undefined);

function render(message: SmsConversationMessage = failed) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(RetryFailedSmsButton, {
          tenantId: TENANT,
          phoneE164: PHONE,
          message,
          intentScope: `${TENANT}:user`,
          online: "online",
          queryBase: ["sms", TENANT, "thread"],
          onRetried,
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

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`button ${label} missing`);
  return found as HTMLButtonElement;
}

function dialog(): HTMLElement {
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
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
  onRetried.mockReset();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("RetryFailedSmsButton", () => {
  it("offers Retry only for a terminal outbound failure with a retained body", () => {
    expect(isRetryableSmsMessage(failed)).toBe(true);
    expect(isRetryableSmsMessage({ ...failed, status: "delivered" })).toBe(false);
    expect(isRetryableSmsMessage({ ...failed, direction: "inbound" })).toBe(false);
    expect(
      isRetryableSmsMessage({ ...failed, body_omitted_reason: "legacy_body_unavailable" }),
    ).toBe(false);
    const container = render({ ...failed, status: "delivered" });
    expect(container.querySelector("button")).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("confirms with the recipient, body and eligible list, but holds the retry with the exact hold sentence", async () => {
    routeGet(false);
    const container = render();
    expect(mocks.get).not.toHaveBeenCalled();
    act(() => button("Retry", container).click());
    await flush();
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/sms/conversations/%2B14155550123/context",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/sms/senders");
    expect(dialog().textContent).toContain("Retry this failed SMS?");
    expect(dialog().textContent).toContain("may incur another carrier charge");
    expect(dialog().textContent).toContain(PHONE);
    expect(dialog().textContent).toContain("Your order shipped!");
    const confirm = button("Retry SMS", dialog());
    expect(confirm.disabled).toBe(true);
    const described = document.getElementById(confirm.getAttribute("aria-describedby")!);
    expect(described?.textContent).toBe(HOLD);
    act(() => confirm.click());
    await flush();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("re-sends the retained body as one new intent under one key when dispatch is available", async () => {
    routeGet(true);
    const container = render();
    act(() => button("Retry", container).click());
    await flush();
    const confirm = button("Retry SMS", dialog());
    expect(confirm.disabled).toBe(false);
    act(() => confirm.click());
    await flush(10);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [path, body, opts] = mocks.post.mock.calls[0]!;
    expect(path).toBe("/api/v1/sms/conversations/%2B14155550123/reply");
    expect(body).toEqual({
      sender_profile_id: SENDER,
      body: "Your order shipped!",
      list_id: LIST,
    });
    expect(opts).toEqual({
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      maxAttempts: 1,
      requireOnline: true,
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Retry persisted with a provider receipt");
    expect(onRetried).toHaveBeenCalledWith(expect.objectContaining({ disposition: "persisted" }));
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });
});
