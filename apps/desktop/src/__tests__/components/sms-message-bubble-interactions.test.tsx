// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { SMSMessage } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  clipboard: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: mocks.clipboard,
}));
vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError },
}));
vi.mock("../../components/InlineHelp", () => ({
  InlineHelp: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock("../../components/ExternalLink", () => ({
  ExternalLink: ({ children }: { children: string }) => (
    <a href="#media">{children}</a>
  ),
}));

import { MessageBubble } from "../../components/sms/MessageBubble";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.clipboard.mockReset();
  mocks.toastError.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function message(overrides: Partial<SMSMessage> = {}): SMSMessage {
  return {
    id: "message-1",
    direction: "outbound",
    status: "failed",
    body: "Your code is 1234",
    created_at: "2026-07-16T10:00:00Z",
    error_code: "30005",
    error_message: "Unknown destination handset",
    ...overrides,
  } as SMSMessage;
}

function renderBubble(
  value: SMSMessage,
  onRetry?: (value: SMSMessage) => void | Promise<void>,
): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<MessageBubble message={value} onRetry={onRetry} />));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing ${label} button`);
  }
  return match;
}

describe("MessageBubble interactions", () => {
  it("coalesces copy and retry operations while keeping their state visible", async () => {
    const copyPending = deferred<{ ok: true; message: string }>();
    const retryPending = deferred<void>();
    const onRetry = vi.fn(() => retryPending.promise);
    mocks.clipboard.mockReturnValue(copyPending.promise);
    renderBubble(message(), onRetry);

    const copy = button("Copy");
    act(() => {
      copy.click();
      copy.click();
    });
    expect(mocks.clipboard).toHaveBeenCalledTimes(1);
    expect(button("Copying…").disabled).toBe(false);
    expect(button("Copying…").getAttribute("aria-disabled")).toBe("true");

    const retry = button("Retry");
    act(() => {
      retry.click();
      retry.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(button("Retrying…").getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      copyPending.resolve({ ok: true, message: "Copied" });
      retryPending.resolve();
      await copyPending.promise;
      await retryPending.promise;
    });
    expect(button("Copied").getAttribute("aria-label")).toBe(
      "Message body copied",
    );
    expect(button("Retry").getAttribute("aria-disabled")).toBeNull();
    expect(document.querySelector("[title]")).toBeNull();

    const results = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("does not expose raw untrusted provider diagnostics", () => {
    mocks.clipboard.mockResolvedValue({ ok: true, message: "Copied" });
    renderBubble(
      message({
        direction: "inbound",
        status: "received",
        error_code: "MMS_PARSE",
        error_message: "Attachment metadata was incomplete",
      }),
    );
    expect(document.body.textContent).not.toContain("MMS_PARSE");
    expect(document.body.textContent).not.toContain(
      "Attachment metadata was incomplete",
    );
    expect(document.body.textContent).toContain(
      "Inbound processing issue recorded",
    );
    expect(document.querySelector("[title]")).toBeNull();
  });

  it("contains thrown clipboard failures and restores the action", async () => {
    mocks.clipboard.mockRejectedValue(new Error("clipboard unavailable"));
    renderBubble(message({ status: "delivered" }));
    act(() => button("Copy").click());
    await act(async () => Promise.resolve());
    expect(mocks.toastError).toHaveBeenCalledWith("clipboard unavailable");
    expect(button("Copy").getAttribute("aria-disabled")).toBeNull();
  });

  it("isolates hostile Unicode and keeps message text out of action labels", () => {
    const body = `Synthetic RTL \u202E321 CBA\u202C\n${"verylongtoken".repeat(30)} 🧑🏽‍💻`;
    renderBubble(message({ direction: "inbound", status: "received", body }));
    const text = document.querySelector(".sms-message-text");
    expect(text?.textContent).toBe(body);
    expect(text?.tagName).toBe("BDI");
    expect(text?.getAttribute("dir")).toBe("auto");
    for (const node of document.querySelectorAll("[title], [aria-label]")) {
      expect(
        node.getAttribute("title") ?? node.getAttribute("aria-label"),
      ).not.toContain(body);
    }
  });

  it("keeps a reconciliation row held even when its message status says failed", () => {
    renderBubble(
      message({
        status: "failed",
        dispatch_state: "reconciliation_required",
      }),
      vi.fn(),
    );
    expect(document.body.textContent).toContain("reconciling");
    expect(document.body.textContent).toContain("Do not send it again");
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Retry",
      ),
    ).toBe(false);
  });

  it("does not conflate a reserved reply intent with reconciliation or provider acceptance", () => {
    renderBubble(
      message({
        status: "queued",
        dispatch_state: "reserved",
      }),
      vi.fn(),
    );
    expect(document.body.textContent).toContain("intent reserved");
    expect(document.body.textContent).toContain(
      "Provider submission is not established",
    );
    expect(document.body.textContent).not.toContain("provider accepted");
    expect(document.body.textContent).not.toContain(
      "delivery outcome is unknown",
    );
    expect(button("Copy")).toBeInstanceOf(HTMLButtonElement);
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Retry",
      ),
    ).toBe(false);
  });

  it("renders an oversize retained body as unavailable evidence without truncating or copying it", () => {
    renderBubble(
      message({
        direction: "inbound",
        status: "received",
        body: "",
        body_omitted_reason: "body_exceeds_inbox_limit",
      }),
    );
    expect(document.body.textContent).toContain("Message body unavailable");
    expect(document.body.textContent).toContain("was not truncated");
    expect(document.querySelector(".sms-message-text")).toBeNull();
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Copy",
      ),
    ).toBe(false);
  });

  it("renders unavailable legacy content without claiming it exceeded a limit", () => {
    renderBubble(
      message({
        direction: "inbound",
        status: "received",
        body: "",
        body_omitted_reason: "legacy_body_unavailable",
      }),
    );
    expect(document.body.textContent).toContain(
      "Legacy message content unavailable",
    );
    expect(document.body.textContent).not.toContain("exceeded");
    expect(document.querySelector(".sms-message-text")).toBeNull();
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Copy",
      ),
    ).toBe(false);
  });
});
