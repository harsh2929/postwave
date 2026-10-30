// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AuthApi from "@/lib/auth-api";
import type * as SecretsApi from "@/lib/conversion-ingest-secrets-api";

import { stubRouteTransport } from "../helpers/route-transport";
import { renderPage, unmount, WHOAMI } from "../pages/_harness";

const mocks = vi.hoisted(() => ({
  issue: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("@/lib/conversion-ingest-secrets-api", async (importOriginal) => {
  const actual = await importOriginal<typeof SecretsApi>();
  return {
    ...actual,
    conversionIngestSecretsApi: {
      issue: mocks.issue,
      list: mocks.list,
      revoke: mocks.revoke,
    },
  };
});

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof AuthApi>();
  return { ...actual, whoamiFresh: mocks.whoamiFresh };
});

import { ConversionIngestSecretsPanel } from "@/components/integrations/conversion-ingest-secrets-panel";

const LIVE = {
  keyId: "0123456789abcdef0123456789abcdef",
  label: "Production checkout",
  createdAt: "2026-08-30T10:00:00Z",
  revokedAt: null,
  identityProjectionStatus: "ready" as const,
  identityProjectionErrorCode: null,
  identityProjectionUpdatedAt: "2026-08-30T10:01:00Z",
};
const RETIRED = {
  keyId: "fedcba9876543210fedcba9876543210",
  label: "Retired checkout",
  createdAt: "2026-08-01T10:00:00Z",
  revokedAt: "2026-08-29T10:00:00Z",
  identityProjectionStatus: "failed" as const,
  identityProjectionErrorCode: "secret_unavailable" as const,
  identityProjectionUpdatedAt: "2026-08-29T10:01:00Z",
};
const REVEALED_SECRET = "A".repeat(43);

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw failure;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ items: [LIVE, RETIRED] });
  mocks.issue.mockResolvedValue({
    ...LIVE,
    keyId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    label: "Replacement checkout",
    secret: REVEALED_SECRET,
    notice: "This is the only time the secret is shown.",
    identityProjectionStatus: "pending",
    identityProjectionErrorCode: null,
    identityProjectionUpdatedAt: "2026-08-30T11:00:00Z",
  });
  mocks.revoke.mockResolvedValue({ revoked: true });
  mocks.whoamiFresh.mockResolvedValue(WHOAMI);
  stubRouteTransport({ "/api/v1/auth/me": WHOAMI });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("ConversionIngestSecretsPanel", () => {
  it("separates private server keys from publishable browser keys and shows v2 exactly", async () => {
    const { container, root } = await renderPage(ConversionIngestSecretsPanel);
    try {
      expect(container.textContent).toContain(
        "Trusted server conversion ingest",
      );
      expect(container.textContent).toContain(
        "separate from the publishable browser tracking keys",
      );
      expect(container.textContent).toContain(
        "X-Postwave-Signature: keyid=<id>,v2=<hex>",
      );
      expect(container.textContent).toContain(
        "email_hmac_sha256 = HMAC-SHA256(signing secret, lower(trim(email)))",
      );
      expect(container.textContent).toContain(
        "never send identity.email, plaintext email",
      );
      expect(container.textContent).toContain("Rotate overlap-first");
      expect(container.textContent).toContain("Production checkout");
      expect(container.textContent).toContain("Retired checkout");
      expect(container.textContent).toContain("email HMAC ready");
      expect(container.textContent).toContain("email HMAC failed");
      expect(container.textContent).toContain(
        "This key cannot prepare email identities",
      );
      expect(
        Array.from(container.querySelectorAll("button")).filter(
          (candidate) => candidate.textContent?.trim() === "Revoke",
        ),
      ).toHaveLength(1);
    } finally {
      unmount(root);
    }
  });

  it("issues once, keeps the credential out of query data, and requires secure storage acknowledgement", async () => {
    const { container, root } = await renderPage(ConversionIngestSecretsPanel);
    try {
      const input = container.querySelector<HTMLInputElement>(
        "#conversion-ingest-secret-label",
      );
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(input, "Replacement checkout");
        input?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => button("Issue server key")?.click());
      await waitFor(() =>
        expect(document.body.textContent).toContain(REVEALED_SECRET),
      );
      expect(mocks.issue).toHaveBeenCalledTimes(1);
      expect(mocks.issue).toHaveBeenCalledWith("Replacement checkout");
      expect(document.body.textContent).toContain("this is its only display");
      expect(document.body.textContent).toContain("approved secret manager");
      expect(document.body.textContent).toContain("email HMAC pending");
      expect(document.body.textContent).toContain("requests receive 503");
      expect(document.body.textContent).toContain(
        "Click-ID and external-ID-only events are unaffected",
      );
      expect(button("Acknowledge and clear")?.disabled).toBe(true);
      const beforeUnload = new Event("beforeunload", { cancelable: true });
      expect(window.dispatchEvent(beforeUnload)).toBe(false);
      expect(beforeUnload.defaultPrevented).toBe(true);
      // A refetch can update list metadata, but the one-time value remains in
      // component-local state and is never passed to list/query data.
      expect(mocks.list).toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("fences an ambiguous issue until the register is explicitly reconciled", async () => {
    mocks.issue.mockRejectedValue(new Error("connection lost after upload"));
    const { container, root } = await renderPage(ConversionIngestSecretsPanel);
    try {
      const input = container.querySelector<HTMLInputElement>(
        "#conversion-ingest-secret-label",
      );
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(input, "Possibly issued key");
        input?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => button("Issue server key")?.click());
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "The issue outcome is unknown",
        ),
      );
      expect(document.body.textContent).toContain(
        "If a new key ID appeared, revoke it, then issue a replacement",
      );
      expect(document.body.textContent).toContain(
        "Never retry this issuance blindly",
      );
      expect(button("Issue server key")?.disabled).toBe(true);
      await act(async () => button("Issue server key")?.click());
      expect(mocks.issue).toHaveBeenCalledTimes(1);
      expect(mocks.list.mock.calls.length).toBeGreaterThan(1);

      await act(async () =>
        button("Register reconciled — allow replacement")?.click(),
      );
      expect(button("Issue server key")?.disabled).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("confirm-gates immediate revocation and names overlap-first impact", async () => {
    const { container, root } = await renderPage(ConversionIngestSecretsPanel);
    try {
      const revoke = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === "Revoke",
      );
      await act(async () => revoke?.click());
      expect(document.body.textContent).toContain(
        "Revoke this server signing key?",
      );
      expect(document.body.textContent).toContain(
        "move and verify traffic on a new live key first",
      );
      await act(async () => button("Revoke server key")?.click());
      await waitFor(() =>
        expect(mocks.revoke).toHaveBeenCalledWith(LIVE.keyId),
      );
    } finally {
      unmount(root);
    }
  });

  it("loads bounded history explicitly instead of hiding a next page", async () => {
    mocks.list.mockImplementation(
      async ({ cursor }: { cursor?: string } = {}) =>
        cursor
          ? { items: [RETIRED] }
          : { items: [LIVE], nextCursor: "opaque-page-2" },
    );
    const { container, root } = await renderPage(ConversionIngestSecretsPanel);
    try {
      await waitFor(() => expect(button("Load more server keys")).toBeTruthy());
      expect(container.textContent).not.toContain("Retired checkout");
      await act(async () => button("Load more server keys")?.click());
      await waitFor(() =>
        expect(container.textContent).toContain("Retired checkout"),
      );
      expect(mocks.list).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: "opaque-page-2" }),
      );
    } finally {
      unmount(root);
    }
  });

  it("does not fetch or render admin affordances for a viewer", async () => {
    vi.unstubAllGlobals();
    stubRouteTransport({
      "/api/v1/auth/me": {
        ...WHOAMI,
        role: "viewer",
        effective_role: "viewer",
      },
    });
    const { container, root } = await renderPage(ConversionIngestSecretsPanel);
    try {
      expect(container.textContent).toContain("admin-only");
      expect(container.querySelector("form")).toBeNull();
      expect(mocks.list).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });
});
