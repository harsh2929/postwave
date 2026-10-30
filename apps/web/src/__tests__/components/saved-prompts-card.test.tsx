// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Saved prompts (desktop→web parity messaging-70): name + save the composer
// prompt, apply it, remove it with Undo, retry a refused browser write, and
// apply a shared starter read from GET /api/v1/voice/templates.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  get: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => []),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: mocks.get } };
});

import { SavedPromptsCard } from "@/components/ai/SavedPromptsCard";
import { ApiError } from "@/lib/api";
import { aiSavedPromptsKey } from "@/lib/ai-chat-storage";

const scope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
};
const promptsKey = aiSavedPromptsKey(scope)!;

let root: Root | null = null;
const onApply = vi.fn((_prompt: string) => undefined);

function render(currentPrompt: string) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const draw = (prompt: string) =>
    act(() => {
      root!.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(SavedPromptsCard, {
            scope,
            role: "editor",
            currentPrompt: prompt,
            onApply,
          }),
        ),
      );
    });
  draw(currentPrompt);
  return { rerender: draw };
}

const flush = async (times = 4) => {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (b) =>
      b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`button ${label} missing`);
  return found as HTMLButtonElement;
}

function click(el: HTMLElement) {
  act(() => {
    el.click();
  });
}

function typeInto(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      el,
      value,
    );
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submitNaming() {
  const form = document.querySelector("form")!;
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function stored(): Array<{ name: string; prompt: string }> {
  return JSON.parse(window.localStorage.getItem(promptsKey) ?? "[]");
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.get.mockImplementation(async (path: string) => {
    if (path !== "/api/v1/voice/templates") throw new Error(`unexpected ${path}`);
    return [
      {
        id: "tmpl-1",
        name: "Welcome series",
        description: "Three warm onboarding emails.",
      },
    ];
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("SavedPromptsCard", () => {
  it("names and saves the composer prompt to this user + workspace, then applies it", async () => {
    render("Draft a winter sale announcement for loyal customers");
    await flush();
    click(button("Save prompt"));
    const name = document.querySelector<HTMLInputElement>("form input")!;
    expect(name.value).toBe("Draft a winter sale announcement for loy…");
    typeInto(name, "Winter sale");
    submitNaming();
    expect(stored()).toEqual([
      expect.objectContaining({
        name: "Winter sale",
        prompt: "Draft a winter sale announcement for loyal customers",
      }),
    ]);
    click(button("Apply saved prompt Winter sale"));
    expect(onApply).toHaveBeenCalledWith(
      "Draft a winter sale announcement for loyal customers",
    );
  });

  it("withholds Save with the reason while the composer is empty", async () => {
    render("   ");
    await flush();
    expect(button("Save prompt").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Type a prompt in the composer before saving it.",
    );
  });

  it("Remove deletes the prompt from the browser and Undo restores it in place", async () => {
    window.localStorage.setItem(
      promptsKey,
      JSON.stringify([
        { id: "p-1", name: "First", prompt: "one" },
        { id: "p-2", name: "Second", prompt: "two" },
        { id: "p-3", name: "Third", prompt: "three" },
      ]),
    );
    render("");
    await flush();
    click(button("Remove saved prompt Second"));
    expect(stored().map((p) => p.name)).toEqual(["First", "Third"]);
    expect(document.body.textContent).toContain("Removed “Second”.");
    click(button("Undo"));
    expect(stored().map((p) => p.name)).toEqual(["First", "Second", "Third"]);
    expect(document.body.textContent).not.toContain("Removed “Second”.");
  });

  it("surfaces a refused browser write and Retry storage persists the same library", async () => {
    render("Plan a re-engagement flow");
    await flush();
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementationOnce(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });
    click(button("Save prompt"));
    submitNaming();
    expect(document.body.textContent).toContain(
      "this browser refused to store them",
    );
    expect(window.localStorage.getItem(promptsKey)).toBeNull();
    setItem.mockRestore();
    click(button("Retry storage"));
    expect(stored().map((p) => p.prompt)).toEqual(["Plan a re-engagement flow"]);
    expect(document.body.textContent).not.toContain(
      "this browser refused to store them",
    );
  });

  it("reads shared starters from GET /api/v1/voice/templates and applies one", async () => {
    render("");
    await flush();
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/voice/templates",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    click(button("Apply starter Welcome series"));
    expect(onApply).toHaveBeenCalledWith(
      "Draft a Welcome series. Three warm onboarding emails.",
    );
  });

  it("renders the server's sentence when starters fail and retries on request", async () => {
    mocks.get.mockImplementationOnce(async () => {
      throw new ApiError("Voice service unavailable", 503);
    });
    render("");
    await flush();
    expect(document.body.textContent).toContain("Voice service unavailable");
    click(button("Retry starters"));
    await flush();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Welcome series");
  });
});
