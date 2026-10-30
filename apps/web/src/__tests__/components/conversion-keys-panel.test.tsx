// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// ConversionKeysPanel had NEITHER a test nor a page that renders it. Nothing
// executed the one branch that matters most here: a revoked key must not offer
// a Revoke button, and the mint form must not submit an empty label.
//
// Route table rather than recorded fixtures — /api/v1/conversions/keys was
// never recorded, and on a 404 the panel renders only its error branch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TrackingKey } from "@/lib/conversions-api";

import { stubRouteTransport } from "../helpers/route-transport";
import {
  clickEveryControl,
  renderPage,
  unmount,
  WHOAMI,
} from "../pages/_harness";

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

const KEYS: TrackingKey[] = [
  {
    id: "key_live",
    tenant_id: WHOAMI.tenant_id,
    label: "Storefront checkout",
    prefix: "pw_ck_ab12",
    revoked_at: null,
    created_at: "2026-07-14T00:00:00Z",
  },
  {
    id: "key_dead",
    tenant_id: WHOAMI.tenant_id,
    label: "Old staging key",
    prefix: "pw_ck_zz99",
    revoked_at: "2026-08-01T00:00:00Z",
    created_at: "2026-05-02T00:00:00Z",
  },
];

function routes(keys: TrackingKey[] = KEYS) {
  return {
    "/api/v1/auth/me": WHOAMI,
    "/api/v1/conversions/keys": keys,
  };
}

async function panel() {
  return (await import("@/components/integrations/conversion-keys-panel"))
    .ConversionKeysPanel;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ConversionKeysPanel", () => {
  beforeEach(() => {
    stubRouteTransport(routes());
  });

  it("lists every key with its prefix, and never leaks a full secret", async () => {
    const ConversionKeysPanel = await panel();
    const { text, root } = await renderPage(ConversionKeysPanel);
    try {
      expect(text).toContain("Publishable conversion tracking keys");
      expect(text).toContain("do not create an HMAC signature");
      expect(text).toContain("Trusted server conversion ingest");
      expect(text).toContain("Storefront checkout");
      expect(text).toContain("Old staging key");
      expect(text).toContain("pw_ck_ab12");
      // The one-time plaintext banner belongs only to a just-minted key.
      expect(text).not.toContain("it won't be shown again");
      expect(text).not.toContain("No tracking keys yet");
    } finally {
      unmount(root);
    }
  });

  it("badges the revoked key and offers Revoke only on the live one", async () => {
    const ConversionKeysPanel = await panel();
    const { container, root } = await renderPage(ConversionKeysPanel);
    try {
      const revokeButtons = [...container.querySelectorAll("button")].filter(
        (b) => b.textContent?.trim() === "Revoke",
      );
      // Falsifiable: guarding on `keys.length` instead of `k.revoked_at`, or
      // dropping the guard, makes this 2.
      expect(revokeButtons).toHaveLength(1);
      expect(container.textContent).toContain("revoked");
    } finally {
      unmount(root);
    }
  });

  it("keeps Create key disabled until a label is typed", async () => {
    const ConversionKeysPanel = await panel();
    const { container, root } = await renderPage(ConversionKeysPanel);
    try {
      const submit = container.querySelector<HTMLButtonElement>(
        "button[type='submit']",
      );
      expect(submit?.textContent).toBe("Create key");
      expect(submit?.disabled).toBe(true);
      // The label input must be reachable by its own <label>.
      const input = container.querySelector<HTMLInputElement>(
        "#conversion-key-label",
      );
      expect(input).not.toBeNull();
      expect(
        container.querySelector("label[for='conversion-key-label']")
          ?.textContent,
      ).toBe("New key label");
    } finally {
      unmount(root);
    }
  });

  it("shows the empty state when the tenant has minted nothing", async () => {
    vi.unstubAllGlobals();
    stubRouteTransport(routes([]));
    const ConversionKeysPanel = await panel();
    const { text, root } = await renderPage(ConversionKeysPanel);
    try {
      expect(text).toContain("No tracking keys yet");
    } finally {
      unmount(root);
    }
  });

  it("clicks every control without a handler exploding", async () => {
    const ConversionKeysPanel = await panel();
    const { container, root } = await renderPage(ConversionKeysPanel);
    try {
      expect(document.body.textContent).not.toContain(
        "Revoke this tracking key?",
      );
      const { clicked, failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
      // Create key is disabled and skipped; Revoke is the enabled one.
      expect(clicked).toBeGreaterThanOrEqual(1);
      // Revoking is confirm-gated and the dialog names the key.
      expect(document.body.textContent).toContain("Revoke this tracking key?");
      expect(document.body.textContent).toContain("Storefront checkout");
    } finally {
      unmount(root);
    }
  });
});
