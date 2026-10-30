// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  listTopics: vi.fn(),
  createTopic: vi.fn(),
  deleteTopic: vi.fn(),
  updateTopic: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/preferences-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/preferences-api")>()),
  listTopics: mocks.listTopics,
  createTopic: mocks.createTopic,
  deleteTopic: mocks.deleteTopic,
  updateTopic: mocks.updateTopic,
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: vi.fn(async (opened: unknown) => opened),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import TopicsPage from "@/app/(dashboard)/app/settings/topics/page";
import { qk } from "@/lib/query-keys";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TOPIC = {
  id: "topic_1",
  slug: "product-news",
  name: "Product news",
  description: "A deliberate description for the hosted preference center.",
  defaultOptIn: true,
  displayOrder: 0,
  optedInCount: 12,
  optedOutCount: 3,
};

const TOPICS_KEY = [
  ...qk.settings("tenant_1", "owner", "topics"),
  "owner_1",
  "durable-mode",
] as const;

let root: Root | null = null;

function render(ui: ReactNode): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(QueryClientProvider, { client: queryClient }, ui),
    );
  });
  return queryClient;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (cause) {
      last = cause;
      await act(flush);
    }
  }
  throw last;
}

function button(
  label: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const match = Array.from(scope.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function dialog(): HTMLElement {
  const match = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!match) throw new Error("Dialog not found");
  return match;
}

async function change(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.whoami.mockResolvedValue({
    user_id: "owner_1",
    tenant_id: "tenant_1",
    email: "owner@example.test",
    role: "owner",
    effective_role: "owner",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Settings closure",
    workspace_slug: "settings-closure",
  });
  mocks.listTopics.mockResolvedValue([TOPIC]);
  mocks.deleteTopic.mockResolvedValue(undefined);
  mocks.updateTopic.mockResolvedValue(TOPIC);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("settings Topics hidden states", () => {
  it("freezes one create intent, focuses a retryable failure, and restores trigger focus", async () => {
    let rejectFirst: ((reason: Error) => void) | undefined;
    mocks.createTopic
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce({
        ...TOPIC,
        id: "topic_2",
        slug: "weekly-digest",
        name: "Weekly digest",
      });
    render(createElement(TopicsPage));
    await waitFor(() =>
      expect(document.body.textContent).toContain(TOPIC.name),
    );

    const trigger = button("Add topic");
    act(() => trigger.click());
    const name = dialog().querySelector<HTMLInputElement>("#t-name");
    if (!name) throw new Error("Topic name input missing");
    await change(name, "Weekly digest");
    expect(dialog().querySelector<HTMLInputElement>("#t-slug")?.value).toBe(
      "weekly-digest",
    );

    const submit = button("Create", dialog());
    await act(async () => {
      submit.click();
      submit.click();
      await Promise.resolve();
    });
    expect(mocks.createTopic).toHaveBeenCalledTimes(1);
    expect(dialog().getAttribute("aria-busy")).toBe("true");
    expect(name.disabled).toBe(true);
    act(() => button("Close", dialog()).click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      rejectFirst?.(new Error("Slug was reserved by another operator."));
      await flush();
    });
    const alert = dialog().querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("reserved by another operator");
    expect(document.activeElement).toBe(alert);
    expect(name.value).toBe("Weekly digest");

    await act(async () => {
      button("Create", dialog()).click();
      await flush();
    });
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    expect(mocks.createTopic).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("previews truthful defaults and deletes only after explicit confirmation", async () => {
    let resolveDelete: (() => void) | undefined;
    mocks.deleteTopic.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const queryClient = render(createElement(TopicsPage));
    await waitFor(() =>
      expect(document.body.textContent).toContain(TOPIC.name),
    );

    const previewTrigger = button("Preview preference center");
    act(() => previewTrigger.click());
    expect(dialog().textContent).toContain("Manage your subscriptions");
    const previewDefault = dialog().querySelector<HTMLInputElement>(
      `input[aria-label="${TOPIC.name}"]`,
    );
    expect(previewDefault?.checked).toBe(true);
    expect(previewDefault?.disabled).toBe(true);
    act(() => {
      const closes = Array.from(dialog().querySelectorAll("button")).filter(
        (candidate) => candidate.textContent?.trim() === "Close",
      );
      (closes.at(-1) as HTMLButtonElement | undefined)?.click();
    });
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(previewTrigger));

    await act(async () => {
      button("Delete").click();
      await Promise.resolve();
    });
    expect(dialog().textContent).toContain("Subscriber opt-in state");
    expect(mocks.deleteTopic).not.toHaveBeenCalled();
    await act(async () => {
      button("Cancel", dialog()).click();
      await Promise.resolve();
    });
    expect(mocks.deleteTopic).not.toHaveBeenCalled();

    await act(async () => {
      button("Delete").click();
      await Promise.resolve();
    });
    vi.useFakeTimers();
    await act(async () => {
      button("Delete", dialog()).click();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.body.textContent).not.toContain(TOPIC.name);
    expect(mocks.deleteTopic).not.toHaveBeenCalled();

    // A background list read that began during the undo window can finish
    // with the pre-delete row. The successful commit must remove it again.
    await act(async () => {
      queryClient.setQueryData(TOPICS_KEY, [TOPIC]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.body.textContent).toContain(TOPIC.name);
    mocks.listTopics.mockResolvedValue([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(mocks.deleteTopic).toHaveBeenCalledWith(TOPIC.id);
    await act(async () => {
      resolveDelete?.();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(queryClient.getQueryData(TOPICS_KEY)).toEqual([]);
    expect(document.body.textContent).not.toContain(TOPIC.name);
  });
});
