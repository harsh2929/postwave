// @vitest-environment happy-dom

import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PlaygroundTabs, ResponseTabs } from "../../pages/APIPlayground";
import {
  type Mode,
  PostwaveAIModeTabs,
  usePostwaveModeTabs,
} from "../../pages/PostwaveAI";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function key(
  target: HTMLElement,
  value: string,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: value,
    ...options,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function namedTab(list: HTMLElement, label: string): HTMLButtonElement {
  const match = [
    ...list.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ].find((candidate) => candidate.textContent?.trim().startsWith(label));
  if (!match) throw new Error(`Missing tab: ${label}`);
  return match;
}

function expectExactPanelOwner(tab: HTMLButtonElement): HTMLElement {
  const panelId = tab.getAttribute("aria-controls");
  const panel = panelId ? document.getElementById(panelId) : null;
  expect(panel?.getAttribute("role")).toBe("tabpanel");
  expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
  return panel!;
}

function expectEveryTabOwnsPanel(list: HTMLElement): void {
  for (const tab of list.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    expectExactPanelOwner(tab);
  }
}

function PlaygroundHarness(): ReactElement {
  const [tab, setTab] = useState<"explore" | "reference" | "history">(
    "explore",
  );
  return (
    <PlaygroundTabs
      tab={tab}
      onChange={setTab}
      panels={{
        explore: <div>Explore panel</div>,
        reference: <div>Reference panel</div>,
        history: <div>History panel</div>,
      }}
    />
  );
}

function DisabledPlaygroundHarness(): ReactElement {
  return (
    <PlaygroundTabs
      tab="history"
      onChange={vi.fn()}
      disabled
      panels={{
        explore: <div>Request in flight</div>,
        reference: <div>Reference panel</div>,
        history: <div>History panel</div>,
      }}
    />
  );
}

function QueuedPlaygroundTabHarness(): ReactElement {
  const [tab, setTab] = useState<"explore" | "reference" | "history">(
    "explore",
  );
  const [sending, setSending] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setTab("history")}>
        Deep-link History
      </button>
      <button type="button" onClick={() => setSending(false)}>
        Complete request
      </button>
      <button
        type="button"
        onClick={() => {
          setTab("history");
          setSending(false);
        }}
      >
        Deep-link History at completion
      </button>
      <PlaygroundTabs
        tab={tab}
        onChange={setTab}
        onDiscardDisabledTab={() => setTab("explore")}
        disabled={sending}
        panels={{
          explore: sending ? (
            <div>Request in flight</div>
          ) : (
            <div role="alert">Outcome may be ambiguous. Verify state.</div>
          ),
          reference: <div>Reference panel</div>,
          history: <div>History panel</div>,
        }}
      />
    </>
  );
}

const AI_MODES: readonly Mode[] = [
  "chat",
  "compose",
  "subject",
  "presend",
  "agent",
  "routines",
];

function PostwaveAIHarness(): ReactElement {
  const [mode, setMode] = useState<Mode>("chat");
  const tabs = usePostwaveModeTabs(mode, setMode);
  return (
    <>
      <PostwaveAIModeTabs mode={mode} tabs={tabs} />
      {AI_MODES.map((item) => (
        <div key={item} {...tabs.getPanelProps(item)}>
          {item} panel
        </div>
      ))}
    </>
  );
}

function NestedPlaygroundHarness(): ReactElement {
  const [outer, setOuter] = useState<"explore" | "reference" | "history">(
    "explore",
  );
  const [response, setResponse] = useState<"body" | "headers">("body");
  const responseTabs = (
    <ResponseTabs
      value={response}
      onChange={setResponse}
      headerCount={3}
      action={<button type="button">Copy response</button>}
      panels={{
        body: <div>Response body</div>,
        headers: <div>Response headers</div>,
      }}
    />
  );
  return (
    <PlaygroundTabs
      tab={outer}
      onChange={setOuter}
      panels={{
        explore: responseTabs,
        reference: <div>Reference panel</div>,
        history: <div>History panel</div>,
      }}
    />
  );
}

describe("DUX-023 owned page tabs", () => {
  it("keeps the in-flight Playground panel and its cancel controls visible", () => {
    render(<DisabledPlaygroundHarness />);
    const tabs = document.querySelectorAll<HTMLButtonElement>(
      '[role="tablist"][aria-label="Playground sections"] [role="tab"]',
    );
    expect([...tabs].every((tab) => tab.disabled)).toBe(true);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(document.body.textContent).toContain("Request in flight");
    expect(document.body.textContent).not.toContain("History panel");
    act(() => tabs[1]?.click());
    expect(document.body.textContent).not.toContain("Reference panel");
  });

  it("discards a deep-link tab change during send so completion stays visible", () => {
    render(<QueuedPlaygroundTabHarness />);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
    const deepLink = buttons.find(
      (button) => button.textContent?.trim() === "Deep-link History",
    )!;
    const complete = buttons.find(
      (button) => button.textContent?.trim() === "Complete request",
    )!;

    act(() => deepLink.click());
    expect(document.body.textContent).toContain("Request in flight");
    expect(document.body.textContent).not.toContain("History panel");

    act(() => complete.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Outcome may be ambiguous",
    );
    expect(document.body.textContent).not.toContain("History panel");
  });

  it("keeps completion visible when send and deep-link state settle together", () => {
    render(<QueuedPlaygroundTabHarness />);
    const simultaneous = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (button) =>
        button.textContent?.trim() === "Deep-link History at completion",
    )!;

    act(() => simultaneous.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Outcome may be ambiguous",
    );
    expect(document.body.textContent).not.toContain("History panel");
  });

  it("gives routed Playground tabs exact ownership and manual keyboard activation", () => {
    render(<PlaygroundHarness />);
    const list = document.querySelector<HTMLElement>(
      '[role="tablist"][aria-label="Playground sections"]',
    )!;
    const explore = namedTab(list, "Explore");
    const reference = namedTab(list, "API Reference");
    expectEveryTabOwnsPanel(list);
    expect(document.body.textContent).toContain("Explore panel");
    expect(document.body.textContent).not.toContain("Reference panel");
    expect(
      [...list.querySelectorAll('[role="tab"]')].filter(
        (item) => (item as HTMLElement).tabIndex === 0,
      ),
    ).toHaveLength(1);

    act(() => explore.focus());
    expect(key(explore, "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(reference);
    expect(explore.getAttribute("aria-selected")).toBe("true");
    expect(document.body.textContent).not.toContain("Reference panel");
    key(reference, "Enter");
    expect(reference.getAttribute("aria-selected")).toBe("true");
    expect(document.body.textContent).toContain("Reference panel");
    expect(document.body.textContent).not.toContain("Explore panel");
    key(reference, "End");
    expect(document.activeElement).toBe(namedTab(list, "History"));
    key(namedTab(list, "History"), "Home");
    expect(document.activeElement).toBe(explore);
  });

  it("keeps Moosewave AI route/network modes manual and IME-safe", () => {
    render(<PostwaveAIHarness />);
    const list = document.querySelector<HTMLElement>(
      '[role="tablist"][aria-label="Moosewave AI mode"]',
    )!;
    const chat = namedTab(list, "Chat");
    const compose = namedTab(list, "Compose");
    expectEveryTabOwnsPanel(list);
    act(() => chat.focus());
    expect(
      key(chat, "ArrowRight", { isComposing: true }).defaultPrevented,
    ).toBe(false);
    expect(document.activeElement).toBe(chat);
    key(chat, "ArrowRight");
    expect(document.activeElement).toBe(compose);
    expect(chat.getAttribute("aria-selected")).toBe("true");
    key(compose, " ");
    expect(compose.getAttribute("aria-selected")).toBe("true");
    expect(
      [...list.querySelectorAll('[role="tab"]')].filter(
        (item) => (item as HTMLElement).tabIndex === 0,
      ),
    ).toHaveLength(1);
  });

  it("isolates nested response navigation and keeps Copy outside the tablist", () => {
    render(<NestedPlaygroundHarness />);
    const outer = document.querySelector<HTMLElement>(
      '[role="tablist"][aria-label="Playground sections"]',
    )!;
    const inner = document.querySelector<HTMLElement>(
      '[role="tablist"][aria-label="Response content"]',
    )!;
    const body = namedTab(inner, "Body");
    const headers = namedTab(inner, "Headers");
    const copy = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Copy response",
    )!;
    expect(inner.contains(copy)).toBe(false);
    expect(copy.closest('[role="tablist"]')).toBeNull();
    expect(inner.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expectEveryTabOwnsPanel(inner);

    act(() => body.focus());
    expect(document.body.textContent).toContain("Response body");
    key(body, "ArrowRight");
    expect(headers.getAttribute("aria-selected")).toBe("true");
    expect(document.body.textContent).toContain("Response headers");
    expect(document.body.textContent).not.toContain("Response body");
    expect(namedTab(outer, "Explore").getAttribute("aria-selected")).toBe(
      "true",
    );
    act(() => copy.click());
    expect(headers.getAttribute("aria-selected")).toBe("true");
    expect(namedTab(outer, "Explore").getAttribute("aria-selected")).toBe(
      "true",
    );
  });
});
