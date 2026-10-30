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
  canWrite: true,
  getVoiceProfile: vi.fn(),
  listCampaigns: vi.fn(),
  listCampaignTemplates: vi.fn(),
  listForms: vi.fn(),
  listSequences: vi.fn(),
  listSubscribers: vi.fn(),
  loadSensitiveLocalData: vi.fn(),
  saveSensitiveLocalData: vi.fn(),
  streamAIGenerate: vi.fn(),
}));

vi.mock("../../components/AIMessage", () => ({
  AIMessage: () => <div>Message</div>,
}));
vi.mock("../../components/ConfirmModal", () => ({
  ConfirmModal: () => null,
}));
vi.mock("../../components/HeroEmptyState", () => ({
  HeroEmptyState: () => <div>Start a conversation</div>,
}));
vi.mock("../../components/InlineHelp", () => ({ InlineHelp: () => null }));
vi.mock("../../components/SubjectLabWorkspace", () => ({
  SubjectLabWorkspace: () => null,
}));
vi.mock("../../components/Toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("../../components/ai/BrandVoicePanel", () => ({
  BrandVoicePanel: () => null,
}));
vi.mock("../../components/ai/ComposeBroadcastForm", () => ({
  ComposeBroadcastForm: () => null,
}));
vi.mock("../../components/ai/McpAgentSummary", () => ({
  McpAgentSummary: () => null,
}));
vi.mock("../../components/ai/PresendCheckPanel", () => ({
  PresendCheckPanel: () => null,
}));
vi.mock("../../components/ai/RecentExecutionsStrip", () => ({
  RecentExecutionsStrip: () => null,
}));
vi.mock("../../components/ai/RoutinesPanel", () => ({
  RoutinesPanel: () => null,
}));
vi.mock("../../components/ai/SavedPromptsCard", () => ({
  SavedPromptsCard: () => null,
}));
vi.mock("../../components/ai/TonePicker", () => ({
  TonePicker: () => null,
}));
vi.mock("../../components/ai/VoiceProfileCard", () => ({
  VoiceProfileCard: () => null,
}));
vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getVoiceProfile: mocks.getVoiceProfile,
      listCampaigns: mocks.listCampaigns,
      listCampaignTemplates: mocks.listCampaignTemplates,
      listForms: mocks.listForms,
      listSequences: mocks.listSequences,
      listSubscribers: mocks.listSubscribers,
    },
  };
});
vi.mock("../../lib/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ai-client")>();
  return { ...actual, streamAIGenerate: mocks.streamAIGenerate };
});
vi.mock("../../lib/desktop-router", () => ({
  desktopRouteIdentityScope: () => "1111111111111111",
  requestDesktopRouteNavigation: vi.fn().mockResolvedValue("proceeded"),
  useDesktopRouteTab: () => ["chat", vi.fn()],
}));
vi.mock("../../lib/heroAssets", () => ({ HERO: { ai: "ai.png" } }));
vi.mock("../../lib/store", () => ({
  setSection: vi.fn(),
  useCanWrite: () => mocks.canWrite,
  useMe: () => ({ user: "user-1", tenant: "tenant-1" }),
  useTenantId: () => "tenant-1",
}));
vi.mock("../../lib/sensitive-local-data", () => ({
  loadSensitiveLocalData: mocks.loadSensitiveLocalData,
  saveSensitiveLocalData: mocks.saveSensitiveLocalData,
  sensitiveLocalIdentityScope: () => "1111111111111111",
}));
vi.mock("../../lib/template-handoff", () => ({
  markAIGeneratedHTML: (value: string | undefined) => value,
  peekPendingCampaignDraft: () => null,
  setPendingCampaignDraft: vi.fn(),
}));

import { PostwaveAI } from "../../pages/PostwaveAI";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canWrite = true;
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function") mock.mockReset();
  }
  mocks.getVoiceProfile.mockResolvedValue({ error: { message: "absent" } });
  mocks.listCampaigns.mockResolvedValue({
    data: {
      items: [
        {
          id: "campaign-1",
          name: "July launch",
          subject: "A summer update",
          status: "draft",
        },
      ],
    },
  });
  mocks.listSubscribers.mockResolvedValue({ data: { items: [] } });
  mocks.listSequences.mockResolvedValue({ data: { items: [] } });
  mocks.listCampaignTemplates.mockResolvedValue({ data: [] });
  mocks.listForms.mockResolvedValue({ data: [] });
  mocks.loadSensitiveLocalData.mockResolvedValue({
    value: [],
    state: "ready",
    warning: null,
    retryable: false,
  });
  mocks.saveSensitiveLocalData.mockImplementation(({ value }) =>
    Promise.resolve(value),
  );
  mocks.streamAIGenerate.mockReturnValue({ abort: vi.fn() });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
    () => undefined,
  );
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Moosewave AI autocomplete", () => {
  it("keeps viewer prompts local and explains why generation is unavailable", async () => {
    mocks.canWrite = false;
    await renderPage();
    const textarea = composer();
    setTextarea(textarea, "Draft a launch campaign");
    const send = document.querySelector<HTMLButtonElement>(
      'form.ai-input-row button[type="submit"]',
    );
    expect(textarea.disabled).toBe(false);
    expect(send?.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "View-only · ask an editor or admin to run AI generation",
    );
    act(() => send?.click());
    expect(mocks.streamAIGenerate).not.toHaveBeenCalled();
  });

  it("bounds the prompt at the UI/server-safe character envelope and exposes the count", async () => {
    await renderPage();
    const textarea = composer();
    expect(textarea.maxLength).toBe(8_000);
    expect(textarea.getAttribute("aria-describedby")).toBe(
      "postwave-ai-chat-input-hint",
    );

    setTextarea(textarea, "x".repeat(8_010));

    expect(textarea.value).toHaveLength(8_000);
    expect(
      document.getElementById("postwave-ai-chat-input-hint")?.textContent,
    ).toContain("8,000 / 8,000");
  });

  it("keeps its context claims explicit and lets the work canvas expand", async () => {
    await renderPage();
    expect(document.body.textContent).toContain("Explicit workspace sources");
    expect(document.body.textContent).toContain("Encrypted local history");
    expect(document.body.textContent).not.toContain("last 30 days");

    const inspector = document.getElementById("postwave-ai-inspector");
    const toggle = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Hide context",
    );
    expect(inspector?.hidden).toBe(false);
    expect(toggle?.getAttribute("aria-controls")).toBe("postwave-ai-inspector");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");

    act(() => toggle?.click());
    expect(inspector?.hidden).toBe(true);
    expect(toggle?.textContent?.trim()).toBe("Show context");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");

    act(() => toggle?.click());
    expect(inspector?.hidden).toBe(false);
    expect(toggle?.textContent?.trim()).toBe("Hide context");
  });

  it("blocks chat edits while encrypted history hydrates and ignores completion after unmount", async () => {
    const pending = deferred<{
      value: [];
      state: "ready";
      warning: null;
      retryable: false;
    }>();
    mocks.loadSensitiveLocalData.mockReturnValue(pending.promise);
    await renderPage();

    const textarea = composer();
    expect(textarea.disabled).toBe(true);
    const send = document.querySelector<HTMLButtonElement>(
      'form.ai-input-row button[type="submit"]',
    );
    expect(send?.disabled).toBe(true);
    act(() => send?.click());
    expect(mocks.streamAIGenerate).not.toHaveBeenCalled();

    act(() => root?.unmount());
    root = null;
    await act(async () =>
      pending.resolve({
        value: [],
        state: "ready",
        warning: null,
        retryable: false,
      }),
    );
    expect(mocks.saveSensitiveLocalData).not.toHaveBeenCalled();
  });

  it("keeps a zero-result slash popup controlled by the composer and handles IME Escape", async () => {
    await renderPage();
    const textarea = composer();
    textarea.focus();
    setTextarea(textarea, "/unknown");

    const listboxId = textarea.getAttribute("aria-controls");
    expect(textarea.getAttribute("role")).toBe("combobox");
    expect(textarea.getAttribute("aria-autocomplete")).toBe("list");
    expect(textarea.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(listboxId ?? "")?.getAttribute("role")).toBe(
      "listbox",
    );
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "No slash commands match unknown",
    );
    const emptyEnter = press(textarea, "Enter");
    expect(emptyEnter.defaultPrevented).toBe(false);
    expect(textarea.getAttribute("aria-expanded")).toBe("true");

    const composingEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composingEscape, "isComposing", { value: true });
    act(() => {
      textarea.dispatchEvent(composingEscape);
    });
    expect(textarea.getAttribute("aria-expanded")).toBe("true");

    const escape = press(textarea, "Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(textarea.getAttribute("aria-expanded")).toBe("false");
    expect(textarea.value).toBe("/unknown");
  });

  it("updates the active slash descendant and commits only a non-composing Enter", async () => {
    await renderPage();
    const textarea = composer();
    textarea.focus();
    setTextarea(textarea, "/su");

    const options = () =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
      );
    expect(options()).toHaveLength(2);
    expect(textarea.getAttribute("aria-activedescendant")).toBe(
      options()[0]?.id,
    );
    press(textarea, "ArrowDown");
    expect(textarea.getAttribute("aria-activedescendant")).toBe(
      options()[1]?.id,
    );
    release(textarea, "ArrowDown");

    const composingEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composingEnter, "isComposing", { value: true });
    act(() => {
      textarea.dispatchEvent(composingEnter);
    });
    expect(textarea.value).toBe("/su");

    press(textarea, "Enter");
    expect(textarea.value).toBe("Summarize this week's campaign performance.");
    expect(textarea.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(textarea);
  });

  it("clears autocomplete ownership when an open raw trigger is submitted", async () => {
    await renderPage();
    const textarea = composer();
    setTextarea(textarea, "/unknown");
    expect(textarea.getAttribute("aria-expanded")).toBe("true");

    const send = document.querySelector<HTMLButtonElement>(
      'form.ai-input-row button[type="submit"]',
    );
    act(() => send?.click());

    expect(mocks.streamAIGenerate).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe("");
    // Keep the composer editable while the current turn streams so the user
    // can prepare the next prompt; submission remains single-flight.
    expect(textarea.disabled).toBe(false);
    expect(send?.disabled).toBe(true);
    expect(textarea.getAttribute("aria-expanded")).toBe("false");
    expect(textarea.hasAttribute("aria-controls")).toBe(false);
    expect(textarea.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("requests the real generated-at voice profile shape as compact context", async () => {
    mocks.getVoiceProfile.mockResolvedValue({
      data: {
        version: 6,
        generated_at: "2026-08-08T00:00:00Z",
        tonal: { warmth: 0.8, directness: 0.7 },
      },
    });
    await renderPage();
    const textarea = composer();
    setTextarea(textarea, "Draft a concise launch update");

    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          'form.ai-input-row button[type="submit"]',
        )
        ?.click(),
    );

    expect(mocks.streamAIGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        contextRefs: [{ type: "voice_profile", id: "active" }],
      }),
      expect.any(Object),
    );
  });

  it("owns only exact-query mention results across loading transitions", async () => {
    vi.useFakeTimers();
    await renderPage();
    const textarea = composer();
    setTextarea(textarea, "@ju");

    expect(textarea.getAttribute("aria-expanded")).toBe("true");
    expect(textarea.getAttribute("aria-controls")).toBe(
      "postwave-ai-mention-options",
    );
    expect(textarea.hasAttribute("aria-activedescendant")).toBe(false);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Searching for ju",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
      await Promise.resolve();
    });
    const option = document.querySelector<HTMLButtonElement>('[role="option"]');
    expect(option?.textContent).toContain("July launch");
    expect(textarea.getAttribute("aria-activedescendant")).toBe(option?.id);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "1 result available",
    );

    setTextarea(textarea, "@zz");
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(textarea.hasAttribute("aria-activedescendant")).toBe(false);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Searching for zz",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
      await Promise.resolve();
    });
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "No matches for zz",
    );
    expect(mocks.listSubscribers).not.toHaveBeenCalled();
  });
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

async function renderPage(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<PostwaveAI />));
  await act(async () => Promise.resolve());
}

function composer(): HTMLTextAreaElement {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Ask Moosewave AI"]',
  );
  if (!textarea) throw new Error("Missing AI composer");
  return textarea;
}

function setTextarea(textarea: HTMLTextAreaElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(textarea, value);
    textarea.setSelectionRange(value.length, value.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(textarea: HTMLTextAreaElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    textarea.dispatchEvent(event);
  });
  return event;
}

function release(textarea: HTMLTextAreaElement, key: string): void {
  act(() => {
    textarea.dispatchEvent(
      new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }),
    );
  });
}
