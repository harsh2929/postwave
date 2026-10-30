// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement } from "react";
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
  copy: vi.fn(),
}));

vi.mock("../../hooks/useClipboardCopy", () => ({
  useClipboardCopy: () => ({
    status: "idle",
    copied: false,
    announcement: "",
    liveRegionProps: { "aria-live": "polite", "aria-atomic": true },
    copy: mocks.copy,
  }),
}));

import { AIMessage, type AIMessageData } from "../../components/AIMessage";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.copy.mockReset();
  mocks.copy.mockResolvedValue({ ok: true, method: "clipboard" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  act(() => root?.render(node));
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

describe("AIMessage lifecycle", () => {
  it("preserves interrupted output and exposes safe recovery without replaying", async () => {
    const onRetry = vi.fn();
    const onRegenerate = vi.fn();
    const message: AIMessageData = {
      id: "assistant-1",
      role: "assistant",
      content: "The launch should begin with a small engaged cohort.",
      createdAt: 1,
      errored: true,
      errorMessage: "The connection ended before completion.",
      sourcePrompt: "Plan the launch",
      groundingChips: [{ id: "campaign:one", label: "Campaign · Launch" }],
    };

    render(
      <AIMessage msg={message} onRetry={onRetry} onRegenerate={onRegenerate} />,
    );

    const article = document.querySelector("article");
    expect(article?.hasAttribute("aria-live")).toBe(false);
    expect(article?.getAttribute("aria-busy")).toBeNull();
    expect(document.body.textContent).toContain(message.content);
    expect(document.body.textContent).toContain("Response interrupted");
    expect(document.body.textContent).toContain(message.errorMessage);
    expect(document.body.textContent).toContain(
      "The partial response above was preserved and was not retried.",
    );
    expect(document.body.textContent).toContain("Context requested");
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "generation stopped before completion",
    );
    expect(document.body.textContent).not.toContain("Regenerate");

    act(() => button("Retry").click());
    expect(onRetry).toHaveBeenCalledWith(message);
    expect(onRegenerate).not.toHaveBeenCalled();

    act(() => button("Copy").click());
    expect(mocks.copy).toHaveBeenCalledWith(
      message.content,
      { contentClass: "personal", label: "AI response" },
      "AI response",
    );

    const accessibility = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      accessibility.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("announces streaming state once and keeps the visual motion decorative", async () => {
    render(
      <AIMessage
        msg={{
          id: "assistant-streaming",
          role: "assistant",
          content: "Working draft",
          createdAt: 1,
          streaming: true,
        }}
      />,
    );

    const article = document.querySelector("article");
    expect(article?.getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "is generating a response",
    );
    expect(
      document.querySelector(".ai-streaming-bar")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(document.body.textContent).not.toContain("Copy");
    const accessibility = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      accessibility.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
