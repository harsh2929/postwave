// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  listWebhooks: vi.fn(),
  updateWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  rotateWebhookSecret: vi.fn(),
  reenableWebhook: vi.fn(),
  testWebhook: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/webhooks-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webhooks-api")>()),
  listWebhooks: mocks.listWebhooks,
  updateWebhook: mocks.updateWebhook,
  deleteWebhook: mocks.deleteWebhook,
  rotateWebhookSecret: mocks.rotateWebhookSecret,
  reenableWebhook: mocks.reenableWebhook,
  testWebhook: mocks.testWebhook,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
  },
}));

vi.mock("@/components/settings/webhook-owner-email-preference-card", () => ({
  WebhookOwnerEmailPreferenceCard: () => null,
}));

import WebhooksPage from "@/app/(dashboard)/app/settings/webhooks/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WEBHOOK = {
  id: "webhook_1",
  tenantId: "tenant_1",
  url: "https://hooks.example.test/postwave",
  events: ["subscriber.created", "campaign.sent"] as const,
  status: "active" as const,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

let root: Root | null = null;

function render(ui: ReactNode): void {
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

function exactButton(
  label: string,
  scope: ParentNode = document,
  occurrence = 0,
): HTMLButtonElement {
  const matches = Array.from(scope.querySelectorAll("button")).filter(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === label,
  );
  const match = matches[occurrence];
  if (!match) throw new Error(`Button not found: ${label} #${occurrence}`);
  return match;
}

function dialog(): HTMLElement {
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
  if (dialogs.length !== 1)
    throw new Error(`Expected one dialog, saw ${dialogs.length}`);
  return dialogs[0];
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
  const identity = {
    user_id: "owner_1",
    tenant_id: "tenant_1",
    email: "owner@example.test",
    role: "owner",
    effective_role: "owner",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Settings closure",
    workspace_slug: "settings-closure",
  };
  mocks.whoami.mockResolvedValue(identity);
  mocks.whoamiFresh.mockResolvedValue(identity);
  mocks.listWebhooks.mockResolvedValue([WEBHOOK]);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("settings Webhooks hidden states", () => {
  it("detects an edit no-op, freezes one update, and retries inline without losing intent", async () => {
    let rejectFirst: ((reason: Error) => void) | undefined;
    mocks.updateWebhook
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce({
        ...WEBHOOK,
        url: "https://hooks.example.test/recovered",
      });
    render(createElement(WebhooksPage));
    await waitFor(() =>
      expect(document.body.textContent).toContain(WEBHOOK.url),
    );

    const trigger = exactButton("Edit");
    act(() => trigger.click());
    const url = dialog().querySelector<HTMLInputElement>("#wh-url");
    if (!url) throw new Error("Webhook URL input missing");
    expect(exactButton("Save changes", dialog()).disabled).toBe(true);
    expect(dialog().textContent).toContain("Change the URL");
    await change(url, "  https://hooks.example.test/recovered  ");

    const save = exactButton("Save changes", dialog());
    await act(async () => {
      save.click();
      save.click();
      await Promise.resolve();
    });
    expect(mocks.updateWebhook).toHaveBeenCalledTimes(1);
    expect(dialog().getAttribute("aria-busy")).toBe("true");
    expect(url.disabled).toBe(true);
    act(() => exactButton("Close", dialog()).click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      rejectFirst?.(new Error("Endpoint changed while this dialog was open."));
      await flush();
    });
    const alert = dialog().querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("Endpoint changed");
    expect(document.activeElement).toBe(alert);
    expect(url.value).toContain("recovered");

    await act(async () => {
      exactButton("Save changes", dialog()).click();
      await flush();
    });
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    expect(mocks.updateWebhook).toHaveBeenCalledTimes(2);
    expect(mocks.updateWebhook).toHaveBeenLastCalledWith(
      WEBHOOK.id,
      {
        url: "https://hooks.example.test/recovered",
        events: [...WEBHOOK.events],
      },
      { signal: expect.any(AbortSignal) },
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("recovers rotation, protects the one-time secret, and dedupes clipboard writes", async () => {
    mocks.rotateWebhookSecret
      .mockRejectedValueOnce(new Error("Rotation lock is busy."))
      .mockResolvedValueOnce({
        webhook: WEBHOOK,
        secret: "whsec_one_time_value_123456789",
      });
    let resolveCopy: (() => void) | undefined;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve;
        }),
    );
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(createElement(WebhooksPage));
    await waitFor(() =>
      expect(document.body.textContent).toContain(WEBHOOK.url),
    );

    const rotateTrigger = exactButton("Rotate secret");
    act(() => rotateTrigger.click());
    expect(dialog().textContent).toContain(
      "current secret will fail verification",
    );
    act(() => exactButton("Cancel", dialog()).click());
    expect(mocks.rotateWebhookSecret).not.toHaveBeenCalled();

    act(() => rotateTrigger.click());
    await act(async () => {
      exactButton("Rotate secret", dialog()).click();
      await flush();
    });
    const alert = dialog().querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("Rotation lock is busy");
    expect(document.activeElement).toBe(alert);
    await act(async () => {
      exactButton("Rotate secret", dialog()).click();
      await flush();
    });
    await waitFor(() => {
      expect(dialog().textContent).toContain("Save your signing secret");
    });
    expect(dialog().textContent).toContain("whsec_one_time_value");

    act(() => exactButton("Close", dialog()).click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mocks.toastWarning).toHaveBeenCalled();

    const copy = exactButton("Copy", dialog());
    await act(async () => {
      copy.click();
      copy.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(dialog().getAttribute("aria-busy")).toBe("true");
    expect(exactButton("Done", dialog()).disabled).toBe(true);
    act(() => exactButton("Close", dialog()).click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      resolveCopy?.();
      await flush();
    });

    const acknowledgement = dialog().querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!acknowledgement) throw new Error("Secret acknowledgement missing");
    act(() => acknowledgement.click());
    act(() => exactButton("Done", dialog()).click());
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    expect(document.body.textContent).not.toContain("whsec_one_time_value");
    await waitFor(() => expect(document.activeElement).toBe(rotateTrigger));
  });

  it("cancels deletion without a write and retains a focused failure for retry", async () => {
    mocks.deleteWebhook
      .mockRejectedValueOnce(new Error("Deliveries are still draining."))
      .mockResolvedValueOnce({ ok: true });
    render(createElement(WebhooksPage));
    await waitFor(() =>
      expect(document.body.textContent).toContain(WEBHOOK.url),
    );

    const trigger = exactButton("Delete");
    act(() => trigger.click());
    expect(dialog().textContent).toContain("delivery history will be removed");
    act(() => exactButton("Cancel", dialog()).click());
    expect(mocks.deleteWebhook).not.toHaveBeenCalled();

    act(() => trigger.click());
    await act(async () => {
      exactButton("Delete", dialog()).click();
      await flush();
    });
    const alert = dialog().querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("still draining");
    expect(document.activeElement).toBe(alert);
    await act(async () => {
      exactButton("Delete", dialog()).click();
      await flush();
    });
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    expect(mocks.deleteWebhook).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
