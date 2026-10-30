// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Saved-reply picker (parity row messaging-16): opens over the real
// GET /api/v1/sms/quick-replies transport, ranks most-used first, hands the
// picked reply to the composer, saves a new one through POST and deletes
// through DELETE behind a confirm. A pick alone sends no request.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  get: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => ({})),
  post: vi.fn(async (_path: string, _body?: unknown): Promise<unknown> => ({})),
  del: vi.fn(async (_path: string): Promise<unknown> => ({})),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: mocks.get, post: mocks.post, delete: mocks.del },
  };
});
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { QuickReplyPicker } from "@/components/sms/QuickReplyPicker";

const A = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const B = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const replies = [
  { id: A, label: "Hours", body: "We are open 9–5.", useCount: 1, createdAt: "", updatedAt: "" },
  { id: B, label: "Thanks", body: "Thanks!", useCount: 7, createdAt: "", updatedAt: "" },
];

let root: Root | null = null;
const onPick = vi.fn((_reply: unknown) => undefined);

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
        createElement(QuickReplyPicker, { queryKey: ["sms", "quick-replies"], onPick }),
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
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`button ${label} missing`);
  return found as HTMLButtonElement;
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

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue({ replies });
  mocks.post.mockReset().mockResolvedValue({ ...replies[0], id: A });
  mocks.del.mockReset().mockResolvedValue({ ok: true });
  onPick.mockReset();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("QuickReplyPicker", () => {
  it("loads on open, ranks most-used first, and hands the pick to the composer without any request", async () => {
    const container = render();
    expect(mocks.get).not.toHaveBeenCalled();
    act(() => button("Quick replies").click());
    await flush();
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/sms/quick-replies",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const items = Array.from(
      container.querySelectorAll('ul[aria-label="Saved replies"] li'),
    ).map((li) => li.textContent);
    expect(items[0]).toContain("Thanks");
    expect(items[0]).toContain("Used 7 times");
    expect(items[1]).toContain("Hours");
    act(() => button("Insert saved reply: Thanks").click());
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: B, body: "Thanks!" }));
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("saves a new reply through POST with the trimmed label and body", async () => {
    const container = render();
    act(() => button("Quick replies").click());
    await flush();
    act(() => button("New reply").click());
    const label = Array.from(container.querySelectorAll("label")).find(
      (l) => l.textContent?.trim() === "Reply label",
    )!;
    const body = Array.from(container.querySelectorAll("label")).find(
      (l) => l.textContent?.trim() === "Reply body",
    )!;
    expect(button("Save reply").disabled).toBe(true);
    setValue(document.getElementById(label.htmlFor) as HTMLInputElement, "  Greeting ");
    setValue(document.getElementById(body.htmlFor) as HTMLTextAreaElement, " Hi! ");
    expect(button("Save reply").disabled).toBe(false);
    act(() => button("Save reply").click());
    await flush();
    expect(mocks.post).toHaveBeenCalledWith("/api/v1/sms/quick-replies", {
      label: "Greeting",
      body: "Hi!",
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Quick reply saved");
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it("deletes only through a confirm that names the reply", async () => {
    render();
    act(() => button("Quick replies").click());
    await flush();
    act(() => button("Delete saved reply: Hours").click());
    await flush(2);
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
      ?? Array.from(document.querySelectorAll('[role="dialog"]')).at(-1)!;
    expect(dialog.textContent).toContain("Delete this quick reply?");
    expect(dialog.textContent).toContain("“Hours”");
    expect(mocks.del).not.toHaveBeenCalled();
    act(() => button("Delete reply", dialog).click());
    await flush();
    expect(mocks.del).toHaveBeenCalledWith(`/api/v1/sms/quick-replies/${A}`);
  });
});
