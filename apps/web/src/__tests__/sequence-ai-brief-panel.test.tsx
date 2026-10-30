// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Brief-driven sequence creation (desktop parity rows automation-61/62). Each
// test drives a real render and asserts the CONSEQUENCE: the draft POST's
// path + body + options, the create POST's expanded step graph, the route the
// operator lands on, the named fallback for each AI refusal — and that Quick
// match makes no request at all.

import { act, createElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "./_roots";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  whoami: vi.fn(),
  push: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: mocks };
});
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return { ...actual, whoami: mocks.whoami, whoamiFresh: mocks.whoami };
});
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.push }),
  usePathname: () => "/app/sequences/new",
  useSearchParams: () => new URLSearchParams(),
}));

import { ApiError } from "@/lib/api";
import {
  AiBriefPanel,
  SEQUENCE_CREATE_READ_ONLY_MESSAGE,
} from "@/app/(dashboard)/app/sequences/new/_components/ai-brief-panel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DRAFT_PATH = "/api/v1/voice/sequences/draft";
const CREATE_PATH = "/api/v1/voice/sequences";
const BRIEF = "3-step welcome for B2C signups";

const aiDraft = {
  name: "Welcome flow",
  steps: [
    { position: 1, subject: "Hi there", body: "b1", delay_hours: 0 },
    { position: 2, subject: "The value", body: "b2", delay_hours: 48 },
    { position: 3, subject: "Your next step", body: "b3", delay_hours: 72 },
  ],
};

function created(name: string) {
  return { id: "seq_new", version: 1, name, status: "draft", steps: [] };
}

function me(role: "admin" | "viewer" = "admin") {
  return {
    user_id: "usr_1",
    tenant_id: "tnt_1",
    email: "operator@example.com",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
  };
}

function render(ui: ReactNode): Root {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = trackRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, ui));
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((r) => window.requestAnimationFrame(r));
  await new Promise((r) => window.setTimeout(r, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flush();
      });
    }
  }
  throw lastError;
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (b): b is HTMLButtonElement =>
      b instanceof HTMLButtonElement && b.textContent?.includes(text) === true,
  );
  if (!found) throw new Error(`Button "${text}" not found`);
  return found;
}

function inputByLabel(text: string): HTMLInputElement | HTMLTextAreaElement {
  const label = Array.from(document.querySelectorAll("label")).find(
    (l) => l.textContent?.trim() === text,
  );
  const control = label?.htmlFor
    ? document.getElementById(label.htmlFor)
    : null;
  if (
    !(control instanceof HTMLInputElement) &&
    !(control instanceof HTMLTextAreaElement)
  ) {
    throw new Error(`Control labelled "${text}" not found`);
  }
  return control;
}

async function set(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      control,
      value,
    );
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
  });
}

function alertText(): string {
  return document.querySelector('[role="alert"]')?.textContent ?? "";
}

function preview(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[aria-live="polite"]');
}

async function renderReady(): Promise<void> {
  render(createElement(AiBriefPanel));
  await waitFor(() => expect(mocks.whoami).toHaveBeenCalled());
  await waitFor(() => expect(button("Generate with AI").disabled).toBe(false));
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.whoami.mockResolvedValue(me());
});

afterEach(() => {
  unmountRoots();
  document.body.innerHTML = "";
});

describe("AiBriefPanel — generate a sequence draft from a brief (automation-61)", () => {
  it("drafts with AI, previews the steps, and creates the accepted draft with waits expanded into delay nodes", async () => {
    mocks.post.mockImplementation(async (path: string) =>
      path === DRAFT_PATH ? aiDraft : created("Welcome flow"),
    );
    await renderReady();
    await set(inputByLabel("Brief"), BRIEF);
    await set(inputByLabel("Emails (optional)"), "3");
    await set(inputByLabel("Tone (optional)"), "friendly");

    await click(button("Generate with AI"));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post).toHaveBeenCalledWith(
      DRAFT_PATH,
      { brief: BRIEF, step_count: 3, tone: "friendly" },
      expect.objectContaining({
        requireOnline: true,
        maxAttempts: 1,
        timeoutMs: 60_000,
      }),
    );
    await waitFor(() => expect(preview()).not.toBeNull());
    const text = preview()!.textContent ?? "";
    expect(text).toContain("AI draft: Welcome flow");
    expect(text).toContain("Wait 2 days");
    expect(text).toContain("The value");
    expect(text).toContain("Nothing is saved yet");
    expect(mocks.push).not.toHaveBeenCalled();

    await click(button("Create sequence"));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post).toHaveBeenLastCalledWith(CREATE_PATH, {
      name: "Welcome flow",
      status: "draft",
      steps: [
        {
          type: "email",
          position: 1,
          email: { subject: "Hi there", body: "b1", delay_seconds: 0 },
        },
        {
          type: "delay",
          position: 2,
          delay: { seconds: 172_800, value: 2, unit: "days" },
        },
        {
          type: "email",
          position: 3,
          email: { subject: "The value", body: "b2", delay_seconds: 0 },
        },
        {
          type: "delay",
          position: 4,
          delay: { seconds: 259_200, value: 3, unit: "days" },
        },
        {
          type: "email",
          position: 5,
          email: { subject: "Your next step", body: "b3", delay_seconds: 0 },
        },
      ],
    });
    await waitFor(() => {
      expect(mocks.push).toHaveBeenCalledWith("/app/sequences/seq_new");
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Sequence "Welcome flow" created as a draft.',
    );
  });

  it("names the Quick match fallback when the tenant's AI quota is exhausted (429)", async () => {
    mocks.post.mockRejectedValue(new ApiError("Daily AI quota reached.", 429));
    await renderReady();
    await set(inputByLabel("Brief"), BRIEF);
    await click(button("Generate with AI"));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(alertText()).toContain("AI quota reached: Daily AI quota reached.");
    });
    expect(alertText()).toContain("Quick match");
    expect(preview()).toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("names the no-AI fallbacks when the server has no LLM configured (503)", async () => {
    mocks.post.mockRejectedValue(new ApiError("llm not configured", 503));
    await renderReady();
    await set(inputByLabel("Brief"), BRIEF);
    await click(button("Generate with AI"));
    await waitFor(() => {
      expect(alertText()).toContain(
        "AI drafting isn't configured on this server (llm not configured).",
      );
    });
    expect(alertText()).toContain("Quick match or a template");
    expect(preview()).toBeNull();
  });

  it("asks for a brief before making any request", async () => {
    await renderReady();
    await click(button("Generate with AI"));
    expect(alertText()).toBe("Describe the sequence you want to generate.");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("tells a viewer why both verbs are withheld and sends nothing", async () => {
    mocks.whoami.mockResolvedValue(me("viewer"));
    render(createElement(AiBriefPanel));
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        SEQUENCE_CREATE_READ_ONLY_MESSAGE,
      );
    });
    const generate = button("Generate with AI");
    const quick = button("Quick match (no AI)");
    expect(generate.disabled).toBe(true);
    expect(quick.disabled).toBe(true);
    const reasonId = generate.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(reasonId)?.textContent).toBe(
      SEQUENCE_CREATE_READ_ONLY_MESSAGE,
    );
    expect(quick.getAttribute("aria-describedby")).toBe(reasonId);
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

describe("AiBriefPanel — Quick match (no AI) (automation-62)", () => {
  it("matches the brief to the local starter library with no request and creates that draft", async () => {
    mocks.post.mockResolvedValue(created(BRIEF));
    await renderReady();
    await set(inputByLabel("Brief"), BRIEF);
    await click(button("Quick match (no AI)"));

    expect(mocks.post).not.toHaveBeenCalled();
    await waitFor(() => expect(preview()).not.toBeNull());
    const text = preview()!.textContent ?? "";
    expect(text).toContain(
      'Adapted the "Welcome series" template to 3 emails based on your brief.',
    );
    expect(text).toContain("Welcome aboard — here's what to expect");
    expect(inputByLabel("Sequence name").value).toBe(BRIEF);

    await click(button("Create sequence"));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const [path, body] = mocks.post.mock.calls[0] as [
      string,
      { name: string; status: string; steps: Array<Record<string, unknown>> },
    ];
    expect(path).toBe(CREATE_PATH);
    expect(body.name).toBe(BRIEF);
    expect(body.status).toBe("draft");
    expect(body.steps.map((s) => s.type)).toEqual([
      "email",
      "delay",
      "email",
      "delay",
      "email",
    ]);
    expect(body.steps.map((s) => s.position)).toEqual([1, 2, 3, 4, 5]);
    expect(body.steps[0]?.email).toMatchObject({
      subject: "Welcome aboard — here's what to expect",
    });
    expect(body.steps[1]?.delay).toEqual({
      seconds: 172_800,
      value: 2,
      unit: "days",
    });
    await waitFor(() => {
      expect(mocks.push).toHaveBeenCalledWith("/app/sequences/seq_new");
    });
  });

  it("explains when no starter matches instead of inventing a flow", async () => {
    await renderReady();
    await set(inputByLabel("Brief"), "Send the invoice PDF to accounting");
    await click(button("Quick match (no AI)"));
    expect(alertText()).toBe(
      "No close template match yet. Try one of the examples or start from a template.",
    );
    expect(preview()).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
