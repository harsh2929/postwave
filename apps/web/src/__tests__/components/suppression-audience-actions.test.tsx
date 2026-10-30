// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SuppressionBulkReasonAction,
  SuppressionProviderMirrorAction,
} from "@/app/(dashboard)/app/suppressions/suppression-audience-actions";
import type * as SuppressionApi from "@/lib/suppressions-admin-api";
import type * as SubscriberAuthorityModule from "@/lib/subscriber-authority";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  changeReason: vi.fn(),
  mirror: vi.fn(),
  reauthorize: vi.fn(),
  nextKey: vi.fn(() => "018f0f5e-7b2d-7000-8000-000000000001"),
}));

vi.mock("@/lib/suppressions-admin-api", async (importOriginal) => {
  const actual = await importOriginal<typeof SuppressionApi>();
  return {
    ...actual,
    changeSelectedSuppressionReason: mocks.changeReason,
    mirrorSuppressionsFromProvider: mocks.mirror,
  };
});

vi.mock("@/lib/subscriber-authority", async (importOriginal) => {
  const actual = await importOriginal<typeof SubscriberAuthorityModule>();
  return {
    ...actual,
    reauthorizeSubscriberMutation: mocks.reauthorize,
  };
});

vi.mock("@/lib/http-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/http-fetch")>();
  return { ...actual, newUUIDv7: mocks.nextKey };
});

const authority = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  role: "admin" as const,
};

const selected = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    email: "first@example.com",
    reason: "hard_bounce",
    created_at: "2026-08-29T10:00:00Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    email: "second@example.com",
    reason: "spam_complaint",
    created_at: "2026-08-29T11:00:00Z",
  },
];

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return root;
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

function setInput(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype =
    input instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await settle();
    }
  }
  throw lastError;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reauthorize.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SuppressionBulkReasonAction", () => {
  it("requires exact-scope review and renders partial-success evidence", async () => {
    mocks.changeReason.mockResolvedValue({
      requested: 2,
      updated: 1,
      failed: 0,
      missing: 1,
      errors: [],
    });
    const onChanged = vi.fn();
    const onClear = vi.fn();
    const root = render(
      createElement(SuppressionBulkReasonAction, {
        selected,
        authority,
        onChanged,
        onClear,
      }),
    );

    try {
      await act(async () => button("Change reason").click());
      expect(document.body.textContent).toContain("Reviewed prior reasons");
      expect(button("Apply to 2").disabled).toBe(true);

      const acknowledgement = document.querySelector<HTMLInputElement>(
        '[aria-label="Confirm suppression reason review"]',
      );
      const confirmation = document.querySelector<HTMLInputElement>(
        "#selected-suppression-reason-confirmation",
      );
      if (!acknowledgement || !confirmation)
        throw new Error("Review fields missing");
      await act(async () => {
        acknowledgement.click();
        setInput(confirmation, "CHANGE 2");
      });
      expect(button("Apply to 2").disabled).toBe(false);

      await act(async () => button("Apply to 2").click());
      await settle();

      expect(mocks.reauthorize).toHaveBeenCalledTimes(2);
      expect(mocks.changeReason).toHaveBeenCalledWith(
        selected.map(({ id, email, reason }) => ({ id, email, reason })),
        "manual_unsubscribe",
        expect.objectContaining({
          idempotencyKey: "018f0f5e-7b2d-7000-8000-000000000001",
          signal: expect.any(AbortSignal),
        }),
      );
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain(
        "1 of 2 reviewed rows now carry Manual unsubscribe",
      );
      expect(document.body.textContent).toContain(
        "1 row was no longer present",
      );
      expect(onClear).not.toHaveBeenCalled();

      await act(async () => button("Done").click());
      expect(onClear).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps one idempotency key across an uncertain retry", async () => {
    mocks.changeReason
      .mockRejectedValueOnce(new Error("network uncertain"))
      .mockResolvedValueOnce({
        requested: 2,
        updated: 2,
        failed: 0,
        missing: 0,
        errors: [],
      });
    const root = render(
      createElement(SuppressionBulkReasonAction, {
        selected,
        authority,
        onChanged: vi.fn(),
        onClear: vi.fn(),
      }),
    );
    try {
      await act(async () => button("Change reason").click());
      const acknowledgement = document.querySelector<HTMLInputElement>(
        '[aria-label="Confirm suppression reason review"]',
      );
      const confirmation = document.querySelector<HTMLInputElement>(
        "#selected-suppression-reason-confirmation",
      );
      if (!acknowledgement || !confirmation)
        throw new Error("Review fields missing");
      await act(async () => {
        acknowledgement.click();
        setInput(confirmation, "CHANGE 2");
      });
      await act(async () => button("Apply to 2").click());
      await settle();
      await waitFor(() =>
        expect(document.body.textContent).toContain("network uncertain"),
      );
      await act(async () => button("Apply to 2").click());
      await settle();
      expect(mocks.changeReason).toHaveBeenCalledTimes(2);
      const firstKey = mocks.changeReason.mock.calls[0]?.[2].idempotencyKey;
      const secondKey = mocks.changeReason.mock.calls[1]?.[2].idempotencyKey;
      expect(firstKey).toBe(secondKey);
      expect(mocks.nextKey).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("blocks the endpoint when the fresh authority check fails", async () => {
    mocks.reauthorize.mockRejectedValueOnce(
      new Error("Workspace access changed. Refresh before continuing."),
    );
    const root = render(
      createElement(SuppressionBulkReasonAction, {
        selected,
        authority,
        onChanged: vi.fn(),
        onClear: vi.fn(),
      }),
    );
    try {
      await act(async () => button("Change reason").click());
      const acknowledgement = document.querySelector<HTMLInputElement>(
        '[aria-label="Confirm suppression reason review"]',
      );
      const confirmation = document.querySelector<HTMLInputElement>(
        "#selected-suppression-reason-confirmation",
      );
      if (!acknowledgement || !confirmation)
        throw new Error("Review fields missing");
      await act(async () => {
        acknowledgement.click();
        setInput(confirmation, "CHANGE 2");
      });
      await act(async () => button("Apply to 2").click());
      await settle();
      expect(mocks.changeReason).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Workspace access changed");
    } finally {
      act(() => root.unmount());
    }
  });

  it("fails closed before review when the selected scope contains DSAR evidence", async () => {
    const root = render(
      createElement(SuppressionBulkReasonAction, {
        selected: [{ ...selected[0], reason: "dsar_deletion" }],
        authority,
        onChanged: vi.fn(),
        onClear: vi.fn(),
      }),
    );
    try {
      await act(async () => button("Change reason").click());
      expect(document.body.textContent).toContain(
        "DSAR deletion suppressions are permanent",
      );
      expect(document.querySelector("#selected-suppression-reason")).toBeNull();
      expect(mocks.changeReason).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("SuppressionProviderMirrorAction", () => {
  it("offers every live provider and renders not-configured as setup state", async () => {
    mocks.mirror.mockResolvedValue({
      provider: "mailchimp",
      fetched: 0,
      imported: 0,
      skipped: 0,
      errors: 0,
      not_configured: true,
      not_configured_reason: "credential missing",
    });
    const onChanged = vi.fn();
    const root = render(
      createElement(SuppressionProviderMirrorAction, {
        authority,
        onChanged,
      }),
    );
    try {
      await act(async () => button("Sync provider").click());
      const provider = document.querySelector<HTMLSelectElement>(
        "#suppression-mirror-provider",
      );
      expect(provider?.options).toHaveLength(5);
      const acknowledgement = document.querySelector<HTMLInputElement>(
        '[aria-label="Confirm provider sync review"]',
      );
      const confirmation = document.querySelector<HTMLInputElement>(
        "#suppression-mirror-confirmation",
      );
      if (!acknowledgement || !confirmation)
        throw new Error("Review fields missing");
      await act(async () => {
        acknowledgement.click();
        setInput(confirmation, "SYNC MAILCHIMP");
      });
      await act(async () => button("Sync Mailchimp").click());
      await settle();
      expect(mocks.reauthorize).toHaveBeenCalledTimes(2);
      expect(mocks.mirror).toHaveBeenCalledWith(
        "mailchimp",
        expect.objectContaining({
          idempotencyKey: "018f0f5e-7b2d-7000-8000-000000000001",
          signal: expect.any(AbortSignal),
        }),
      );
      expect(document.body.textContent).toContain(
        "Mailchimp is not configured for this workspace",
      );
      expect(onChanged).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
