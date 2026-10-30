// @vitest-environment happy-dom

import { act, type ReactElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  bulkPasteSubscribers: vi.fn(),
  checkEmail: vi.fn(),
  createSubscriber: vi.fn(),
  deleteSubscriber: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  track: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    bulkPasteSubscribers: mocks.bulkPasteSubscribers,
    createSubscriber: mocks.createSubscriber,
    deleteSubscriber: mocks.deleteSubscriber,
  },
  emailValidationApi: { check: mocks.checkEmail },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("../../lib/telemetry", () => ({ track: mocks.track }));

import {
  MAX_BULK_PASTE,
  SubscriberAddModal,
  mergeBulkPasteResults,
  parseBulkPasteEmails,
} from "../../components/subscribers/SubscriberAddModal";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.createSubscriber.mockResolvedValue({
    data: {
      id: "subscriber-1",
      email: "reader@example.com",
      version: `"subscriber:subscriber-1:v1"`,
    },
  });
  mocks.deleteSubscriber.mockResolvedValue({ data: undefined });
  mocks.checkEmail.mockResolvedValue({ data: undefined });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  queryClient = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const currentQueryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  queryClient = currentQueryClient;
  act(() =>
    root?.render(
      <StrictMode>
        <QueryClientProvider client={currentQueryClient}>
          {node}
        </QueryClientProvider>
      </StrictMode>,
    ),
  );
}

function rerender(node: ReactElement): void {
  if (!queryClient) throw new Error("Expected a query client");
  const currentQueryClient = queryClient;
  act(() =>
    root?.render(
      <StrictMode>
        <QueryClientProvider client={currentQueryClient}>
          {node}
        </QueryClientProvider>
      </StrictMode>,
    ),
  );
}

function input(id: string, value: string): void {
  const element = document.getElementById(id) as
    | HTMLInputElement
    | HTMLTextAreaElement;
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function select(id: string, value: string): void {
  const element = document.getElementById(id) as HTMLSelectElement;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function openPasteMode(): void {
  const tab = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[role="tablist"][aria-label="Subscriber entry method"] [role="tab"]',
    ),
  ).find((candidate) => candidate.textContent?.includes("Paste a list"));
  if (!tab) throw new Error("Missing paste-mode tab");
  act(() => tab.click());
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("SubscriberAddModal", () => {
  it("parses pasted lists with order-preserving case-insensitive dedupe", () => {
    expect(
      parseBulkPasteEmails(
        "First@example.com, second@example.com\nFIRST@example.com; third@example.com",
      ),
    ).toEqual(["First@example.com", "second@example.com", "third@example.com"]);
    expect(MAX_BULK_PASTE).toBe(100);
  });

  it("merges retried row outcomes without losing successful rows", () => {
    expect(
      mergeBulkPasteResults(
        {
          parsed: 2,
          created: 1,
          updated: 0,
          skipped: 0,
          errored: 1,
          rows: [
            { email: "done@example.com", status: "created" },
            {
              email: "RETRY@example.com",
              status: "error",
              error: "temporary",
            },
          ],
        },
        {
          parsed: 1,
          created: 0,
          updated: 1,
          skipped: 0,
          errored: 0,
          rows: [{ email: "retry@example.com", status: "updated" }],
        },
      ),
    ).toEqual({
      parsed: 2,
      created: 1,
      updated: 1,
      skipped: 0,
      errored: 0,
      rows: [
        { email: "done@example.com", status: "created" },
        { email: "retry@example.com", status: "updated" },
      ],
    });
  });

  it("gates viewer submissions before creating an optimistic mutation", () => {
    render(
      <SubscriberAddModal
        open
        canMutate={false}
        onClose={vi.fn()}
        onReload={vi.fn()}
      />,
    );
    input("sub-email", "viewer@example.com");
    act(() => button("Add subscriber").click());

    expect(document.body.textContent).toContain(
      "Your role can't add subscribers.",
    );
    expect(mocks.createSubscriber).not.toHaveBeenCalled();
  });

  it("uses an explicit keyboard-operable entry-mode choice", () => {
    render(
      <SubscriberAddModal
        open
        canMutate
        onClose={vi.fn()}
        onReload={vi.fn()}
      />,
    );
    const entryTabs = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[role="tablist"][aria-label="Subscriber entry method"] [role="tab"]',
      ),
    );
    const single = entryTabs.find((candidate) =>
      candidate.textContent?.includes("One subscriber"),
    )!;
    const paste = entryTabs.find((candidate) =>
      candidate.textContent?.includes("Paste a list"),
    )!;
    expect(single.getAttribute("aria-selected")).toBe("true");
    expect(single.getAttribute("aria-controls")).toBeTruthy();
    expect(paste.getAttribute("aria-controls")).toBeTruthy();
    expect(paste.tabIndex).toBe(-1);
    expect(document.getElementById("sub-email")).not.toBeNull();
    expect(document.getElementById("sub-bulk-paste")).toBeNull();

    act(() => {
      single.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(paste.getAttribute("aria-selected")).toBe("true");
    expect(
      document.getElementById(paste.getAttribute("aria-controls")!),
    ).not.toBeNull();
    expect(document.getElementById("sub-email")).toBeNull();
    expect(document.getElementById("sub-bulk-paste")).not.toBeNull();
  });

  it("defaults to unconfirmed and closes only after successful creation", async () => {
    const onClose = vi.fn();
    const onReload = vi.fn();
    render(
      <SubscriberAddModal
        open
        canMutate
        onClose={onClose}
        onReload={onReload}
      />,
    );
    input("sub-email", " reader@example.com ");
    input("sub-tags", "vip, newsletter, ");
    act(() => button("Add subscriber").click());

    expect(onClose).not.toHaveBeenCalled();
    await flush();
    expect(mocks.createSubscriber).toHaveBeenCalledWith({
      email: "reader@example.com",
      tags: ["vip", "newsletter"],
      status: "unconfirmed",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith("subscriber_added", {
      source: "page",
      tag_count: 2,
    });
  });

  it("requires complete evidence and an exact phrase before creating a sendable subscriber", async () => {
    const onClose = vi.fn();
    render(
      <SubscriberAddModal
        open
        canMutate
        onClose={onClose}
        onReload={vi.fn()}
      />,
    );
    input("sub-email", "verified@example.com");
    select("sub-status", "enabled");
    expect(button("Add subscriber").disabled).toBe(true);
    act(() => button("Add subscriber").click());
    expect(mocks.createSubscriber).not.toHaveBeenCalled();

    const captured = "2026-01-02T10:30";
    select("sub-consent-source", "double_optin");
    select("sub-consent-channel", "email");
    select("sub-consent-basis", "consent");
    input("sub-consent-at", captured);
    input("sub-consent-country", "gb");
    input("sub-consent-policy", "privacy-2026-01");
    input("sub-consent-evidence", "receipt:consent-123");
    input("sub-consent-reason", "Reviewed the double opt-in receipt.");
    const scope = document.querySelector<HTMLInputElement>(
      'fieldset input[type="checkbox"]',
    );
    if (!scope) throw new Error("Missing consent scope acknowledgement");
    act(() => scope.click());
    input("sub-consent-confirmation", "ENABLE verified@example.com");
    expect(button("Add subscriber").disabled).toBe(false);
    act(() => button("Add subscriber").click());

    await flush();
    expect(mocks.createSubscriber).toHaveBeenCalledWith({
      email: "verified@example.com",
      tags: [],
      status: "enabled",
      consent_source: "double_optin",
      consent_timestamp: new Date(captured).toISOString(),
      consent_channel: "email",
      consent_legal_basis: "consent",
      consent_evidence: "receipt:consent-123",
      consent_reason: "Reviewed the double opt-in receipt.",
      consent_policy_version: "privacy-2026-01",
      country: "GB",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the modal open when creation fails", async () => {
    mocks.createSubscriber.mockResolvedValueOnce({
      error: { kind: "http", status: 422, message: "consent rejected" },
    });
    const onClose = vi.fn();
    render(
      <SubscriberAddModal
        open
        canMutate
        onClose={onClose}
        onReload={vi.fn()}
      />,
    );
    input("sub-email", "retry@example.com");
    act(() => button("Add subscriber").click());
    await flush();

    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't add retry@example.com: consent rejected",
    );
  });

  it("does not render an email verdict for an address changed during validation", async () => {
    const pending = deferred<{
      data: {
        email: string;
        valid: boolean;
        verdict: string;
        has_mx: boolean;
        disposable: boolean;
        role_account: boolean;
        reasons: string[];
      };
    }>();
    mocks.checkEmail.mockReturnValueOnce(pending.promise);
    render(
      <SubscriberAddModal
        open
        canMutate
        onClose={vi.fn()}
        onReload={vi.fn()}
      />,
    );
    input("sub-email", "previous@example.com");
    act(() => {
      document
        .getElementById("sub-email")
        ?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(mocks.checkEmail).toHaveBeenCalledWith("previous@example.com");
    input("sub-email", "current-invalid-address");

    await act(async () => {
      pending.resolve({
        data: {
          email: "previous@example.com",
          valid: false,
          verdict: "syntax_invalid",
          has_mx: false,
          disposable: false,
          role_account: false,
          reasons: ["previous subscriber secret"],
        },
      });
      await pending.promise;
    });
    expect(document.body.textContent).not.toContain(
      "previous subscriber secret",
    );
    expect(document.body.textContent).not.toContain("Checking deliverability");
  });

  it("requires an explicit operator acknowledgement for a failed address-quality verdict", async () => {
    const pending = deferred<{
      data: {
        email: string;
        valid: boolean;
        verdict: string;
        has_mx: boolean;
        disposable: boolean;
        role_account: boolean;
        reasons: string[];
      };
    }>();
    mocks.checkEmail.mockReturnValueOnce(pending.promise);
    const verdict = {
      data: {
        email: "risky@example.com",
        valid: false,
        verdict: "disposable",
        has_mx: true,
        disposable: true,
        role_account: false,
        reasons: ["Disposable mailbox provider"],
      },
    };
    render(
      <SubscriberAddModal
        open
        canMutate
        onClose={vi.fn()}
        onReload={vi.fn()}
      />,
    );
    input("sub-email", "risky@example.com");
    act(() => {
      document
        .getElementById("sub-email")
        ?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(mocks.checkEmail).toHaveBeenCalledWith("risky@example.com");
    await act(async () => {
      pending.resolve(verdict);
      await pending.promise;
    });

    expect(mocks.checkEmail).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Disposable mailbox provider");
    expect(button("Add subscriber").disabled).toBe(true);
    const acknowledgement = document.querySelector<HTMLInputElement>(
      ".subscriber-email-override input",
    );
    if (!acknowledgement) throw new Error("Missing deliverability override");
    act(() => acknowledgement.click());
    expect(button("Add subscriber").disabled).toBe(false);
    act(() => button("Add subscriber").click());
    await flush();
    expect(mocks.createSubscriber).toHaveBeenCalledWith({
      email: "risky@example.com",
      tags: [],
      status: "unconfirmed",
    });
  });

  it("renders every bulk outcome and retries only failed addresses", async () => {
    mocks.bulkPasteSubscribers
      .mockResolvedValueOnce({
        data: {
          parsed: 4,
          created: 1,
          updated: 1,
          skipped: 1,
          errored: 1,
          rows: [
            { email: "new@example.com", status: "created" },
            { email: "known@example.com", status: "updated" },
            { email: "blocked@example.com", status: "skipped" },
            {
              email: "retry@example.com",
              status: "error",
              error: "temporary provider failure",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          parsed: 1,
          created: 0,
          updated: 1,
          skipped: 0,
          errored: 0,
          rows: [{ email: "retry@example.com", status: "updated" }],
        },
      });
    render(
      <SubscriberAddModal
        open
        canMutate
        onClose={vi.fn()}
        onReload={vi.fn()}
      />,
    );
    openPasteMode();
    input(
      "sub-bulk-paste",
      "new@example.com\nknown@example.com\nblocked@example.com\nretry@example.com",
    );
    act(() => button("Add 4 pasted").click());
    await flush();

    for (const email of [
      "new@example.com",
      "known@example.com",
      "blocked@example.com",
      "retry@example.com",
    ]) {
      expect(document.body.textContent).toContain(email);
    }
    expect(document.body.textContent).toContain("temporary provider failure");
    act(() => button("Retry 1 failed").click());
    await flush();

    expect(mocks.bulkPasteSubscribers).toHaveBeenNthCalledWith(2, {
      emails: "retry@example.com",
      tags: [],
      status: "unconfirmed",
    });
    expect(document.body.textContent).not.toContain(
      "temporary provider failure",
    );
    expect(document.body.textContent).not.toContain("Retry 1 failed");
    expect(document.body.textContent).toContain("2Updated");
  });

  it("reports undo failures instead of silently claiming success", async () => {
    mocks.deleteSubscriber.mockResolvedValueOnce({
      error: { kind: "http", status: 503, message: "service unavailable" },
    });
    const onReload = vi.fn();
    render(
      <SubscriberAddModal
        open
        canMutate
        onClose={vi.fn()}
        onReload={onReload}
      />,
    );
    input("sub-email", "undo@example.com");
    act(() => button("Add subscriber").click());
    await flush();
    const successCall = mocks.toastSuccess.mock.calls.find(
      ([value]) => typeof value === "object" && value?.action?.label === "Undo",
    );
    if (!successCall) throw new Error("Missing undo toast action");
    act(() => {
      void successCall[0].action.onClick();
      void successCall[0].action.onClick();
    });
    await flush();

    expect(mocks.deleteSubscriber).toHaveBeenCalledWith(
      "subscriber-1",
      `"subscriber:subscriber-1:v1"`,
    );
    expect(mocks.deleteSubscriber).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Couldn't undo adding undo@example.com",
        detail: "The subscriber is still in your audience. Try again.",
        action: expect.objectContaining({ label: "Try again" }),
      }),
    );
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "service unavailable",
    );
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("does not restore a previous modal's bulk result after close and reopen", async () => {
    const pending = deferred<{
      data: {
        parsed: number;
        created: number;
        updated: number;
        skipped: number;
        errored: number;
        rows: Array<{
          email: string;
          status: "error";
          error: string;
        }>;
      };
    }>();
    mocks.bulkPasteSubscribers.mockReturnValueOnce(pending.promise);
    const props = { canMutate: true, onClose: vi.fn(), onReload: vi.fn() };
    render(<SubscriberAddModal open {...props} />);
    openPasteMode();
    input("sub-bulk-paste", "previous-secret@example.com");
    act(() => button("Add 1 pasted").click());
    expect(mocks.bulkPasteSubscribers).toHaveBeenCalledTimes(1);

    rerender(<SubscriberAddModal open={false} {...props} />);
    rerender(<SubscriberAddModal open {...props} />);
    await act(async () => {
      pending.resolve({
        data: {
          parsed: 1,
          created: 0,
          updated: 0,
          skipped: 0,
          errored: 1,
          rows: [
            {
              email: "previous-secret@example.com",
              status: "error",
              error: "previous workspace failure",
            },
          ],
        },
      });
      await pending.promise;
    });

    expect(document.body.textContent).not.toContain(
      "previous-secret@example.com",
    );
    expect(document.body.textContent).not.toContain(
      "previous workspace failure",
    );
  });
});
