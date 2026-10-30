// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validate: vi.fn(),
  changeConsent: vi.fn(),
  removeTag: vi.fn(),
  reauthorize: vi.fn(),
}));

vi.mock("@/lib/subscriber-bulk-admin-api", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/subscriber-bulk-admin-api")
  >()),
  validateSelectedSubscriberEmails: mocks.validate,
  changeSelectedSubscriberConsent: mocks.changeConsent,
  removeTagFromSelectedSubscribers: mocks.removeTag,
}));

vi.mock("@/lib/subscriber-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/subscriber-authority")>()),
  reauthorizeSubscriberMutation: mocks.reauthorize,
}));

import { SubscriberBulkAudienceActions } from "@/app/(dashboard)/app/subscribers/subscriber-bulk-audience-actions";
import type { Subscriber } from "@/lib/subscribers-api";

const selected: Subscriber[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    email: "first@example.com",
    status: "enabled",
    consent_timestamp: null,
    consent_source: "unknown",
    custom_fields: {},
    tags: ["vip"],
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    email: "second@example.com",
    status: "enabled",
    consent_timestamp: null,
    consent_source: "unknown",
    custom_fields: {},
    tags: ["vip", "trial"],
  },
];

const authority = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  role: "admin" as const,
};

function render(
  overrides: Partial<
    Parameters<typeof SubscriberBulkAudienceActions>[0]
  > = {},
): { root: Root; onChanged: ReturnType<typeof vi.fn> } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChanged = vi.fn();
  act(() => {
    root.render(
      createElement(SubscriberBulkAudienceActions, {
        selected,
        allMatchingSelected: false,
        authority,
        role: "admin",
        onReviewDuplicates: vi.fn(),
        onChanged,
        ...overrides,
      }),
    );
  });
  return { root, onChanged };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await act(flush);
    }
  }
  throw last;
}

function button(text: string): HTMLButtonElement {
  const match = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${text}`);
  }
  return match;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("subscriber bulk audience actions", () => {
  it("keeps validation read-only and available without mutation authority", async () => {
    mocks.validate.mockResolvedValue({
      results: selected.map((subscriber) => ({
        subscriber_id: subscriber.id,
        email: subscriber.email,
        valid: true,
        verdict: "ok",
        has_mx: true,
        disposable: false,
        role_account: false,
        reasons: [],
      })),
      summary: { total: 2, valid: 2, invalid: 0 },
    });
    const { root } = render({ authority: null, role: "viewer" });
    try {
      expect(button("Grant consent").disabled).toBe(true);
      await act(async () => {
        button("Validate emails").click();
        await flush();
      });
      await waitFor(() => {
        expect(document.body.textContent).toContain("Email validation results");
        expect(document.body.textContent).toContain("first@example.com");
      });
      expect(mocks.validate).toHaveBeenCalledWith(
        selected.map(({ id, email }) => ({ id, email })),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(mocks.reauthorize).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("requires reviewed evidence and typed scope before an admin consent write", async () => {
    mocks.reauthorize.mockResolvedValue(undefined);
    mocks.changeConsent.mockResolvedValue({
      requested: 2,
      affected: 1,
      skipped: 1,
      source: "explicit_ids",
      exclusions: { already_withdrawn: 1 },
    });
    const { root, onChanged } = render();
    try {
      act(() => button("Grant consent").click());
      expect(document.body.textContent).toContain(
        "immutable decision for exactly 2 selected subscribers",
      );
      setValue(
        document.querySelector<HTMLInputElement>("#bulk-consent-jurisdiction")!,
        "us-ca",
      );
      setValue(
        document.querySelector<HTMLInputElement>("#bulk-consent-policy")!,
        "privacy-2026-08",
      );
      setValue(
        document.querySelector<HTMLTextAreaElement>("#bulk-consent-evidence")!,
        "receipt:CONSENT-123",
      );
      setValue(
        document.querySelector<HTMLTextAreaElement>("#bulk-consent-reason")!,
        "Reviewed the signed first-party record.",
      );
      const acknowledgement = document.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      )!;
      act(() => {
        acknowledgement.click();
      });
      setValue(
        document.querySelector<HTMLInputElement>("#bulk-consent-confirmation")!,
        "GRANT 2",
      );

      await act(async () => {
        button("Grant and record evidence").click();
        await flush();
      });
      await waitFor(() => {
        expect(mocks.changeConsent).toHaveBeenCalledTimes(1);
      });

      expect(mocks.reauthorize).toHaveBeenCalledTimes(2);
      expect(mocks.changeConsent).toHaveBeenCalledWith(
        selected.map(({ id, email }) => ({ id, email })),
        "grant",
        expect.objectContaining({
          category: "email_marketing",
          jurisdiction: "US-CA",
          evidence: "receipt:CONSENT-123",
          reason: "Reviewed the signed first-party record.",
        }),
        expect.objectContaining({
          idempotencyKey: expect.stringMatching(/^subscriber-consent-grant:/),
          signal: expect.any(AbortSignal),
        }),
      );
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("1 confirmed changed");
      expect(document.body.textContent).toContain("1 unchanged or excluded");
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not call the consent endpoint when fresh authority no longer matches", async () => {
    mocks.reauthorize.mockRejectedValue(new Error("Workspace access changed"));
    const { root } = render();
    try {
      act(() => button("Revoke consent").click());
      setValue(
        document.querySelector<HTMLInputElement>("#bulk-consent-jurisdiction")!,
        "US",
      );
      setValue(
        document.querySelector<HTMLInputElement>("#bulk-consent-policy")!,
        "privacy-v1",
      );
      setValue(
        document.querySelector<HTMLTextAreaElement>("#bulk-consent-evidence")!,
        "request:123",
      );
      setValue(
        document.querySelector<HTMLTextAreaElement>("#bulk-consent-reason")!,
        "Direct withdrawal request.",
      );
      act(() =>
        document
          .querySelector<HTMLInputElement>('input[type="checkbox"]')!
          .click(),
      );
      setValue(
        document.querySelector<HTMLInputElement>("#bulk-consent-confirmation")!,
        "REVOKE 2",
      );

      await act(async () => {
        button("Revoke and record evidence").click();
        await flush();
      });
      await waitFor(() => {
        expect(document.body.textContent).toContain("Workspace access changed");
      });
      expect(mocks.changeConsent).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("contains secure retry-identity generation failures inside the consent dialog", async () => {
    const { root } = render();
    try {
      act(() => button("Grant consent").click());
      setValue(
        document.querySelector<HTMLInputElement>("#bulk-consent-jurisdiction")!,
        "US-CA",
      );
      setValue(
        document.querySelector<HTMLInputElement>("#bulk-consent-policy")!,
        "privacy-v1",
      );
      setValue(
        document.querySelector<HTMLTextAreaElement>("#bulk-consent-evidence")!,
        "receipt:123",
      );
      setValue(
        document.querySelector<HTMLTextAreaElement>("#bulk-consent-reason")!,
        "Reviewed source evidence.",
      );
      act(() =>
        document
          .querySelector<HTMLInputElement>('input[type="checkbox"]')!
          .click(),
      );
      setValue(
        document.querySelector<HTMLInputElement>("#bulk-consent-confirmation")!,
        "GRANT 2",
      );
      vi.stubGlobal("crypto", {
        randomUUID: vi.fn(() => {
          throw new Error("entropy unavailable");
        }),
      });

      await act(async () => {
        button("Grant and record evidence").click();
        await flush();
      });

      expect(document.querySelector("[role='dialog']")).not.toBeNull();
      expect(document.body.textContent).toContain("Consent write was not started");
      expect(document.body.textContent).toContain("entropy unavailable");
      expect(mocks.reauthorize).not.toHaveBeenCalled();
      expect(mocks.changeConsent).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("contains a missing secure retry identity inside the tag-removal dialog", async () => {
    const { root } = render();
    try {
      act(() => button("Remove tag").click());
      vi.stubGlobal("crypto", {});
      const confirm = [
        ...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button"),
      ].find((candidate) => candidate.textContent?.trim() === "Remove tag");
      expect(confirm).toBeDefined();

      await act(async () => {
        confirm?.click();
        await flush();
      });

      expect(document.querySelector("[role='dialog']")).not.toBeNull();
      expect(document.body.textContent).toContain("Tag removal was not started");
      expect(document.body.textContent).toContain(
        "A secure retry identity could not be generated",
      );
      expect(mocks.reauthorize).not.toHaveBeenCalled();
      expect(mocks.removeTag).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
