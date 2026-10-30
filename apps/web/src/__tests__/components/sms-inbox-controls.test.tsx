// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// SMS inbox building blocks meant for the message-log thread/list:
//  * SmsInboxFilters — All / Unread / Unknown subscriber chips with server
//    totals, and the Most recent / Oldest unread sort.
//  * CopySmsMessageBodyButton — copies exactly the retained body; a refused
//    write is visible; an omitted body offers nothing to copy.
//  * SmsConversationContextPanel — the thread-header consent context, read
//    through the real transport (only the `api` shell mocked).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), writeText: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { get: mocks.get },
  apiErrorMessage: (error: unknown, fallback = "Something went wrong") =>
    error instanceof Error && error.message ? error.message : fallback,
}));

import { CopySmsMessageBodyButton } from "@/components/sms/CopyMessageBodyButton";
import { SmsInboxFilters } from "@/components/sms/InboxFilters";
import { SmsConversationContextPanel } from "@/components/sms/ThreadHeader";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "11111111-1111-4111-8111-111111111111";
const PHONE = "+15552345678";
const LIST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const roots: Root[] = [];

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  return container;
}

async function eventually(assertion: () => void) {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  do {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await act(async () => new Promise<void>((r) => setTimeout(r, 10)));
  } while (Date.now() < deadline);
  throw lastError;
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name ||
      candidate.getAttribute("aria-label") === name,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no ${name}`);
  return found;
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.writeText.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.writeText },
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("SmsInboxFilters", () => {
  it("renders server totals and reports the chosen filter and sort", async () => {
    const onFilterChange = vi.fn((_filter: string) => undefined);
    const onSortChange = vi.fn((_sort: string) => undefined);
    const container = await render(
      <SmsInboxFilters
        filter="all"
        sort="recent"
        totals={{ total: 12, unread: 3, unknown: 5 }}
        onFilterChange={onFilterChange}
        onSortChange={onSortChange}
      />,
    );
    expect(button(container, "All (12)").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(button(container, "Unread (3)").getAttribute("aria-pressed")).toBe(
      "false",
    );
    await act(async () => button(container, "Unread (3)").click());
    expect(onFilterChange).toHaveBeenCalledWith("unread");
    await act(async () => button(container, "Unknown subscriber (5)").click());
    expect(onFilterChange).toHaveBeenLastCalledWith("unknown");
    await act(async () => button(container, "All (12)").click());
    expect(onFilterChange).toHaveBeenCalledTimes(2);

    const select = container.querySelector("select");
    if (!(select instanceof HTMLSelectElement)) throw new Error("no select");
    expect(select.labels?.[0]?.textContent).toContain("Sort");
    await act(async () => {
      select.value = "oldest_unread";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSortChange).toHaveBeenCalledWith("oldest_unread");
  });

  it("omits counts until a page has verified", async () => {
    const container = await render(
      <SmsInboxFilters
        filter="unread"
        sort="oldest_unread"
        totals={null}
        onFilterChange={() => undefined}
        onSortChange={() => undefined}
      />,
    );
    expect(button(container, "Unread").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain(
      "Oldest unread orders by the earliest unread inbound record",
    );
  });
});

describe("CopySmsMessageBodyButton", () => {
  it("copies exactly the retained body and confirms it", async () => {
    mocks.writeText.mockResolvedValueOnce(undefined);
    const body = "Line one\nSTOP? no — just asking";
    const container = await render(<CopySmsMessageBodyButton body={body} />);
    await act(async () => button(container, "Copy message body").click());
    expect(mocks.writeText).toHaveBeenCalledWith(body);
    await eventually(() =>
      expect(button(container, "Message body copied")).toBeTruthy(),
    );
  });

  it("makes a refused clipboard write visible", async () => {
    mocks.writeText.mockRejectedValueOnce(new Error("denied"));
    const container = await render(<CopySmsMessageBodyButton body="Hello" />);
    await act(async () => button(container, "Copy message body").click());
    await eventually(() =>
      expect(container.textContent).toContain(
        "Copy failed: the browser refused clipboard access.",
      ),
    );
  });

  it("offers nothing to copy when the server withheld the body", async () => {
    const container = await render(
      <CopySmsMessageBodyButton
        body=""
        bodyOmittedReason="body_exceeds_inbox_limit"
      />,
    );
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("SmsConversationContextPanel", () => {
  it("reads the phone's context and renders eligible consent lists", async () => {
    mocks.get.mockResolvedValueOnce({
      tenantId: TENANT,
      phoneE164: PHONE,
      consentStatus: "opted_in",
      consentSource: "form",
      consentAt: "2026-08-01T09:00:00Z",
      consentMixed: true,
      identityAmbiguous: true,
      consentEvidenceSufficient: true,
      subscribedLists: 1,
      totalMessages: 1,
      suppressed: false,
      suppressionReversible: false,
      hasInboundThread: true,
      eligibleLists: [
        {
          id: LIST,
          name: "VIP texts",
          description: "Early access",
          consentSource: "keyword",
          consentAt: "2026-08-01T09:00:00Z",
        },
      ],
      replyDispatchAvailable: false,
      replyDispatchUnavailableReason: "sms_configured_sender_unavailable",
    });
    const container = await render(
      <SmsConversationContextPanel
        tenantId={TENANT}
        phoneE164={PHONE}
        queryKey={["sms", "thread", "context"]}
      />,
    );
    await eventually(() => expect(container.textContent).toContain("VIP texts"));
    expect(mocks.get.mock.calls[0]?.[0]).toBe(
      "/api/v1/sms/conversations/%2B15552345678/context",
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Opted in · mixed lists");
    expect(text).toContain("Multiple linked identities · no subscriber was selected");
    expect(text).toContain("Early access");
    expect(text).toContain("Source: keyword");
    expect(text).toContain("1 retained message record");
    expect(text).toContain("No configured sender can dispatch a reply");
    expect(text).not.toContain("Suppression category");
  });

  it("renders a refused context as an error with a retry, not as empty", async () => {
    mocks.get.mockRejectedValueOnce(new Error("bad_phone"));
    const container = await render(
      <SmsConversationContextPanel
        tenantId={TENANT}
        phoneE164={PHONE}
        queryKey={["sms", "thread", "context-error"]}
      />,
    );
    await eventually(() =>
      expect(container.textContent).toContain(
        "Subscriber context could not be loaded. bad_phone",
      ),
    );
    expect(button(container, "Retry context")).toBeTruthy();
  });
});
