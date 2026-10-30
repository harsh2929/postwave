// @vitest-environment happy-dom

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

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    addSMSConversationTag: mocks.add,
    listSMSConversationTags: mocks.list,
    removeSMSConversationTag: mocks.remove,
  },
}));
vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError },
}));

import { ConversationTagsNotes } from "../../components/sms/ConversationTagsNotes";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  mocks.add.mockReset();
  mocks.list.mockReset();
  mocks.remove.mockReset();
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

function render(phone: string): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(<ConversationTagsNotes phone={phone} />));
}

describe("ConversationTagsNotes confidentiality and text isolation", () => {
  it("aborts the prior confidential read when the phone owner changes", async () => {
    const first = deferred<{ data: { tags: [] } }>();
    mocks.list
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ data: { tags: [] } });

    render("+12025550101");
    const firstSignal = mocks.list.mock.calls[0]?.[1]?.signal as
      | AbortSignal
      | undefined;
    expect(firstSignal?.aborted).toBe(false);

    render("+12025550102");
    expect(firstSignal?.aborted).toBe(true);
    expect(mocks.list.mock.calls[1]?.[0]).toBe("+12025550102");

    await act(async () => {
      first.resolve({ data: { tags: [] } });
      await first.promise;
    });
    expect(document.body.textContent).toContain("No tags");
  });

  it("isolates hostile tag text and never puts it in a control name", async () => {
    const hostile = `Synthetic tag \u202Eremove all\u202C\n${"longtoken".repeat(20)} مرحبا`;
    mocks.list.mockResolvedValue({
      data: {
        tags: [
          {
            tag: hostile,
            createdAt: "2026-08-21T10:00:00.000Z",
          },
        ],
      },
    });

    render("+12025550101");
    await act(async () => Promise.resolve());

    const text = document.querySelector(".sms-tag-text");
    expect(text?.tagName).toBe("BDI");
    expect(text?.getAttribute("dir")).toBe("auto");
    expect(text?.textContent).toBe(hostile);
    const remove = document.querySelector(".sms-tag-remove");
    expect(remove?.getAttribute("aria-label")).toBe(
      "Remove conversation tag 1",
    );
    for (const node of document.querySelectorAll("[title], [aria-label]")) {
      expect(
        node.getAttribute("title") ?? node.getAttribute("aria-label"),
      ).not.toContain(hostile);
    }
  });

  it("aborts the in-flight read as soon as the page becomes hidden", () => {
    mocks.list.mockReturnValue(new Promise(() => undefined));
    render("+12025550101");
    const signal = mocks.list.mock.calls[0]?.[1]?.signal as
      | AbortSignal
      | undefined;
    expect(signal?.aborted).toBe(false);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(signal?.aborted).toBe(true);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
});
