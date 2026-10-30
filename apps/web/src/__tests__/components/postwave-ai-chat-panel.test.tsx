// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Moosewave AI chat (desktop→web parity messaging-52 / messaging-53). Each test
// asserts the consequence of a verb: the exact request the gateway receives
// (method, path, body, one-attempt options), what the conversation renders,
// and what the device-local history holds afterwards.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MeResponse } from "@/lib/auth-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  get: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => []),
  post: vi.fn(
    async (
      _path: string,
      _body?: unknown,
      _opts?: { signal?: AbortSignal; maxAttempts?: number },
    ): Promise<unknown> => ({ text: "ok" }),
  ),
  whoamiFresh: vi.fn(async (_signal?: AbortSignal): Promise<unknown> => null),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: mocks.get, post: mocks.post },
  };
});
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return { ...actual, whoamiFresh: mocks.whoamiFresh };
});

import { PostwaveAIChatPanel } from "@/components/ai/PostwaveAIChatPanel";
import { ApiError } from "@/lib/api";
import { aiChatHistoryKey } from "@/lib/ai-chat-storage";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

function identity(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: USER,
    tenant_id: TENANT,
    email: "ed@example.com",
    role: "editor",
    effective_role: "editor",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
    ...overrides,
  };
}

const historyKey = aiChatHistoryKey({ tenantId: TENANT, userId: USER })!;

function routeGet(path: string): unknown {
  switch (path) {
    case "/api/v1/voice/profile":
      return {
        generated_at: "2026-09-01T00:00:00Z",
        tonal: { warmth: 0.8, directness: 0.4 },
        stylistic: { avg_sentence_length: 14 },
        representative_samples: [{ text: "PRIVATE SAMPLE" }],
      };
    case "/api/v1/campaigns":
      return [
        { id: 42, name: "Spring launch", subject: "Hello spring", status: "draft" },
      ];
    case "/api/v1/voice/sequences":
      return [{ id: "seq-1", name: "Welcome", status: "active", emails: [{}, {}] }];
    case "/api/v1/forms":
      return [{ id: "form-1", name: "Newsletter", slug: "newsletter" }];
    case "/api/v1/voice/templates":
      return [];
    default:
      throw new Error(`unexpected GET ${path}`);
  }
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(me: MeResponse = identity()) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(PostwaveAIChatPanel, { identity: me }),
      ),
    );
  });
}

function unmount() {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
}

const flush = async (times = 6) => {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

function composer(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-autocomplete="list"]',
  );
  if (!el) throw new Error("composer missing");
  return el;
}

function typeInto(el: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLTextAreaElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    if (el instanceof HTMLTextAreaElement) {
      el.setSelectionRange(value.length, value.length);
    }
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

function key(el: HTMLElement, init: KeyboardEventInit) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`button ${label} missing`);
  return found as HTMLButtonElement;
}

function click(el: HTMLElement) {
  act(() => {
    el.click();
  });
}

function generateCalls() {
  return mocks.post.mock.calls.filter(
    ([path]) => path === "/api/v1/voice/generate",
  );
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.get.mockImplementation(async (path: string) => routeGet(path));
  mocks.post.mockImplementation(async () => ({ text: "Here is your draft." }));
  mocks.whoamiFresh.mockImplementation(async () => identity());
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("PostwaveAIChatPanel — chat verbs", () => {
  it("sends the prompt with its tone, attached @mention context and the voice profile as ONE POST", async () => {
    render();
    typeInto(composer(), "Draft a campaign about @Spr");
    await flush();
    const option = Array.from(
      document.querySelectorAll('[role="option"]'),
    ).find((el) => el.textContent?.includes("Spring launch"));
    expect(option, "mention menu lists the campaign").toBeTruthy();
    key(composer(), { key: "Enter" });
    expect(composer().value).toBe(
      "Draft a campaign about @[Spring launch](campaign:42) ",
    );

    const tone = document.querySelector<HTMLSelectElement>("select")!;
    typeInto(tone, "friendly");
    click(button("Send"));
    await flush();

    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    const calls = generateCalls();
    expect(calls).toHaveLength(1);
    const [path, body, opts] = calls[0]!;
    expect(path).toBe("/api/v1/voice/generate");
    const sent = body as Record<string, unknown>;
    expect(sent.prompt).toBe(
      "Draft a campaign about @Spring launch\n\n[Tone: friendly]",
    );
    expect(sent.kind).toBe("campaign_draft");
    expect(sent.stream).toBe(false);
    expect(sent.context_refs).toEqual([
      { kind: "campaign", id: "42" },
      { kind: "voice_profile", id: "active" },
    ]);
    const contextText = String(sent.context_text);
    expect(contextText).toContain("[[campaign:42]]");
    expect(contextText).toContain("subject: Hello spring");
    expect(contextText).toContain("[[voice_profile:active]]");
    expect(contextText).toContain("warmth=0.8");
    expect(contextText).not.toContain("PRIVATE SAMPLE");
    expect(opts?.maxAttempts).toBe(1);
    expect(opts?.signal).toBeInstanceOf(AbortSignal);

    const log = document.querySelector('[role="log"]')!;
    expect(log.textContent).toContain("Here is your draft.");
    expect(log.textContent).toContain("tone: friendly");
    expect(composer().value).toBe("");
  });

  it("Stop generation aborts the in-flight request, marks the turn stopped, and Retry replays it", async () => {
    let seenSignal: AbortSignal | undefined;
    mocks.post.mockImplementationOnce(
      (_path, _body, opts) =>
        new Promise((_resolve, reject) => {
          seenSignal = opts?.signal;
          opts?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    render();
    typeInto(composer(), "Plan a sequence for trials");
    click(button("Send"));
    await flush();
    expect(seenSignal?.aborted).toBe(false);

    click(button("Stop generation"));
    await flush();
    expect(seenSignal?.aborted).toBe(true);
    const log = document.querySelector('[role="log"]')!;
    expect(log.textContent).toContain("Generation stopped by you.");
    expect(document.body.textContent).not.toContain("Stop generation");

    click(button("Retry"));
    await flush();
    const calls = generateCalls();
    expect(calls).toHaveLength(2);
    expect((calls[1]![1] as { prompt: string }).prompt).toBe(
      "Plan a sequence for trials",
    );
    expect(log.textContent).toContain("Here is your draft.");
    expect(log.textContent).not.toContain("Generation stopped by you.");
  });

  it("Regenerate replays the same prompt and tone into the same reply", async () => {
    mocks.post
      .mockImplementationOnce(async () => ({ text: "First answer" }))
      .mockImplementationOnce(async () => ({ text: "Second answer" }));
    render();
    typeInto(document.querySelector<HTMLSelectElement>("select")!, "urgent");
    typeInto(composer(), "Write a flash sale email");
    click(button("Send"));
    await flush();
    expect(document.body.textContent).toContain("First answer");

    click(button("Regenerate"));
    await flush();
    const calls = generateCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]![1]).toMatchObject({
      prompt: "Write a flash sale email\n\n[Tone: urgent]",
      kind: "campaign_draft",
    });
    const replies = document.querySelectorAll('[aria-label="Moosewave AI reply"]');
    expect(replies).toHaveLength(1);
    expect(replies[0]!.textContent).toContain("Second answer");
    expect(replies[0]!.textContent).not.toContain("First answer");
  });

  it("renders the server's refusal sentence and lets the user Retry deliberately", async () => {
    mocks.post.mockImplementationOnce(async () => {
      throw new ApiError("AI chat could not complete", 503, undefined, {
        code: "ai_chat_failed",
      });
    });
    render();
    typeInto(composer(), "Summarize last week");
    click(button("Send"));
    await flush();
    expect(document.body.textContent).toContain("AI chat could not complete");
    expect(generateCalls()).toHaveLength(1);
    click(button("Retry"));
    await flush();
    expect(generateCalls()).toHaveLength(2);
    expect(generateCalls()[1]![1]).toMatchObject({ kind: "summary" });
  });

  it("says once that AI chat is not available where the environment runs no AI service, and closes the composer", async () => {
    // The API's answer on an environment whose VOICE_SERVICE_URL is
    // "disabled": a state of the deployment, which asking again cannot change.
    mocks.post.mockImplementationOnce(async () => {
      throw new ApiError("AI chat isn't available in this environment.", 503, undefined, {
        code: "service_not_deployed",
        requestId: "req-7",
      });
    });
    render();
    typeInto(composer(), "Summarize last week");
    click(button("Send"));
    await flush();
    // One neutral notice, not an errored reply with a Retry that could never
    // succeed, and no request id: nothing failed.
    const notices = Array.from(document.querySelectorAll('[role="status"]')).filter((el) =>
      el.textContent?.includes("AI chat isn't available in this environment."),
    );
    expect(notices).toHaveLength(1);
    expect(document.body.textContent).not.toContain("req-7");
    expect(document.querySelector('[aria-label="Moosewave AI reply"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    // Every further message would get the same answer, so none can be sent.
    expect(composer().disabled).toBe(true);
    typeInto(composer(), "Try again");
    click(button("Send"));
    await flush();
    expect(generateCalls()).toHaveLength(1);
  });

  it("quick prompts and /slash commands fill the composer; Ctrl/⌘+Enter sends", async () => {
    render();
    click(button("Suggest subject lines"));
    expect(composer().value).toBe(
      "Suggest five subject lines for an email about ",
    );
    typeInto(composer(), "/sum");
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    expect(options.map((el) => el.textContent)).toEqual([
      expect.stringContaining("/summarize"),
    ]);
    key(composer(), { key: "Enter" });
    expect(composer().value).toBe("Summarize this week's campaign performance.");
    key(composer(), { key: "Enter", metaKey: true });
    await flush();
    expect(generateCalls()).toHaveLength(1);
    expect(generateCalls()[0]![1]).toMatchObject({
      prompt: "Summarize this week's campaign performance.",
      // Desktop's inferKind checks draft words first; "campaign" wins.
      kind: "campaign_draft",
    });
  });

  it("withholds generation from a viewer with the reason, and sends nothing", async () => {
    render(identity({ role: "viewer", effective_role: "viewer" }));
    expect(composer().disabled).toBe(true);
    expect(button("Send").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "running AI generation requires an editor, admin, or owner role",
    );
    key(composer(), { key: "Enter", ctrlKey: true });
    await flush();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("keeps the conversation in this browser and restores it for the same user + workspace", async () => {
    render();
    typeInto(composer(), "Draft a note about pricing");
    click(button("Send"));
    await flush();
    const stored = JSON.parse(window.localStorage.getItem(historyKey) ?? "[]");
    expect(stored.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(stored[1].content).toBe("Here is your draft.");
    unmount();
    render();
    expect(document.querySelector('[role="log"]')!.textContent).toContain(
      "Here is your draft.",
    );
  });

  it("Jump to latest appears when scrolled up and returns to the newest turn", async () => {
    render();
    typeInto(composer(), "Draft a hello email");
    click(button("Send"));
    await flush();
    const log = document.querySelector<HTMLDivElement>('[role="log"]')!;
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 200 });
    log.scrollTop = 100;
    act(() => {
      log.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    click(button("Jump to latest"));
    expect(log.scrollTop).toBe(1000);
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (b) => b.textContent?.trim() === "Jump to latest",
      ),
    ).toBe(false);
  });
});

describe("PostwaveAIChatPanel — clear chat history (messaging-53)", () => {
  function seedHistory() {
    window.localStorage.setItem(
      historyKey,
      JSON.stringify([
        { id: "u-1", role: "user", content: "Old question", createdAt: 1, status: "done" },
        {
          id: "a-1",
          role: "assistant",
          content: "Old answer",
          createdAt: 2,
          status: "done",
          sourcePrompt: "Old question",
        },
      ]),
    );
  }

  it("confirms with the consequence, then removes only the device-local conversation", async () => {
    seedHistory();
    render();
    expect(document.body.textContent).toContain("Old answer");
    click(button("Clear chat"));
    await flush(2);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Clear chat history?");
    expect(dialog?.textContent).toContain("all 2 messages");
    expect(dialog?.textContent).toContain("cannot be recovered");
    expect(window.localStorage.getItem(historyKey)).not.toBeNull();

    click(button("Clear chat", dialog!));
    await flush();
    expect(window.localStorage.getItem(historyKey)).toBeNull();
    expect(document.body.textContent).not.toContain("Old answer");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("/clear opens the same confirmation instead of clearing silently", async () => {
    seedHistory();
    render();
    typeInto(composer(), "/cle");
    key(composer(), { key: "Enter" });
    await flush(2);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Clear chat history?",
    );
    expect(window.localStorage.getItem(historyKey)).not.toBeNull();
  });

  it("a turn interrupted by a page close restores as a retryable failure", () => {
    window.localStorage.setItem(
      historyKey,
      JSON.stringify([
        { id: "u-1", role: "user", content: "Q", createdAt: 1, status: "done" },
        {
          id: "a-1",
          role: "assistant",
          content: "",
          createdAt: 2,
          status: "pending",
          sourcePrompt: "Q",
        },
      ]),
    );
    render();
    expect(document.body.textContent).toContain(
      "Interrupted before a reply arrived",
    );
    expect(button("Retry")).toBeTruthy();
  });
});
