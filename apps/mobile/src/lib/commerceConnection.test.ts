import { describe, expect, it } from "vitest";

import {
  commerceDisconnectErrorMessage,
  commercePauseErrorMessage,
  disconnectCleanupComplete,
  disconnectConfirmCopy,
  disconnectOutcomeHeadline,
  disconnectVerb,
  normalizeDisconnectOutcome,
  offersStoreAdministration,
  pauseConfirmCopy,
  pauseVerb,
  storeConnectionName,
} from "./commerceConnection";

const ACTIVE = {
  id: "int-1",
  provider: "shopify",
  shopDomain: "acme.myshopify.com",
  status: "active",
};

describe("store connection verbs", () => {
  it("names the shop before the provider, and never renders an empty name", () => {
    expect(storeConnectionName(ACTIVE)).toBe("acme.myshopify.com");
    expect(storeConnectionName({ ...ACTIVE, shopDomain: "" })).toBe("shopify");
    expect(
      storeConnectionName({ ...ACTIVE, shopDomain: "", provider: "" }),
    ).toBe("this store");
  });

  it("offers Pause for an active store", () => {
    expect(pauseVerb(ACTIVE)).toEqual({ enabled: true, reason: "" });
  });

  it("refuses Pause for a paused store, with the reason spoken", () => {
    // No un-pause route exists, so the disabled state must explain itself
    // rather than reading as a toggle that failed to flip.
    const verb = pauseVerb({ ...ACTIVE, status: "Paused" });
    expect(verb.enabled).toBe(false);
    expect(verb.reason).toBe("acme.myshopify.com is already paused.");
  });

  it("refuses Pause for a disconnected store before the server's 409 would", () => {
    const verb = pauseVerb({ ...ACTIVE, status: "disconnected" });
    expect(verb.enabled).toBe(false);
    expect(verb.reason).toBe(
      "acme.myshopify.com is disconnected. Reconnect it on the web admin first.",
    );
  });

  it("refuses a second Disconnect — the server would answer 200 and change nothing", () => {
    expect(disconnectVerb(ACTIVE)).toEqual({ enabled: true, reason: "" });
    const verb = disconnectVerb({ ...ACTIVE, status: "disconnected" });
    expect(verb.enabled).toBe(false);
    expect(verb.reason).toBe("acme.myshopify.com is already disconnected.");
  });

  it("offers the administrative controls only to an admin who is online", () => {
    expect(offersStoreAdministration({ canAdmin: true, online: true })).toBe(
      true,
    );
    expect(offersStoreAdministration({ canAdmin: false, online: true })).toBe(
      false,
    );
    expect(offersStoreAdministration({ canAdmin: true, online: false })).toBe(
      false,
    );
  });
});

describe("confirm copy", () => {
  it("pause copy claims only what the server does: status flag, data kept, plan slot freed", () => {
    const copy = pauseConfirmCopy(ACTIVE);
    expect(copy.title).toBe("Pause store integration?");
    expect(copy.message).toBe(
      "Moosewave will mark acme.myshopify.com paused and keep everything it has already imported.",
    );
    expect(copy.confirmLabel).toBe("Pause integration");
    // The desktop promises "scheduled provider syncs" stop; no worker in
    // apps/api/internal/commerce reads the paused status, so the phone must not.
    expect(copy.message).not.toMatch(/sync/i);
    expect(copy.consequence).toMatch(/plan's store limit/);
  });

  it("disconnect copy says the imported records survive", () => {
    const copy = disconnectConfirmCopy({ ...ACTIVE, shopDomain: "" });
    expect(copy.title).toBe("Disconnect store integration?");
    expect(copy.message).toBe(
      "Moosewave will stop syncing shopify and mark the connection disconnected.",
    );
    expect(copy.confirmLabel).toBe("Disconnect");
    expect(copy.consequence).toMatch(
      /Already-imported customers, products, and orders are kept/,
    );
  });
});

describe("error messages", () => {
  it("maps the pause route's three refusals", () => {
    expect(commercePauseErrorMessage({ status: 403 })).toBe(
      "Pausing a store needs an owner or admin session.",
    );
    expect(commercePauseErrorMessage({ status: 409 })).toBe(
      "This store is disconnected. Reconnect it on the web admin first.",
    );
    expect(commercePauseErrorMessage({ status: 404 })).toBe(
      "That store no longer exists. Pull to refresh.",
    );
  });

  it("keeps an unclassified pause error's own message, or a fallback", () => {
    expect(commercePauseErrorMessage(new Error("boom"))).toBe("boom");
    expect(commercePauseErrorMessage({ status: 500 })).toBe(
      "Couldn't pause the store.",
    );
    expect(commercePauseErrorMessage(undefined)).toBe(
      "Couldn't pause the store.",
    );
  });

  it("says the connection was left as it was for every provider-cleanup failure", () => {
    // 429/502/422 are all emitted BEFORE DisconnectIntegrationWithProviderCleanup
    // runs (handlers.go:384-423), so "left as it was" is a fact, not comfort.
    for (const status of [429, 502, 422]) {
      expect(commerceDisconnectErrorMessage({ status })).toMatch(
        /left as it was/,
      );
    }
    expect(commerceDisconnectErrorMessage({ status: 403 })).toBe(
      "Disconnecting a store needs an owner or admin session.",
    );
    expect(commerceDisconnectErrorMessage({ status: 404 })).toBe(
      "That store no longer exists. Pull to refresh.",
    );
    expect(commerceDisconnectErrorMessage({ status: 500 })).toBe(
      "Couldn't disconnect the store.",
    );
  });
});

describe("disconnect outcome", () => {
  const WIRE = {
    ok: true,
    provider_cleanup: {
      provider: "shopify",
      status: "disconnected",
      postwave_status: "disconnected",
      provider_cleanup_posture: "managed",
      managed_provider_cleanup: true,
      webhook_cleanup_status: "completed",
      credential_cleanup_status: "completed",
      postwave_effects: [
        "local commerce integration is marked disconnected",
        "  ",
        "stored access token was cleared",
      ],
      provider_console_actions: ["Uninstall the Moosewave app from Shopify admin"],
      provider_cleanup_evidence: ["deleted 3 webhook subscriptions"],
    },
  };

  it("keeps every server sentence verbatim and drops only blanks", () => {
    const outcome = normalizeDisconnectOutcome(WIRE);
    expect(outcome.ok).toBe(true);
    expect(outcome.provider).toBe("shopify");
    expect(outcome.postwaveStatus).toBe("disconnected");
    expect(outcome.postwaveEffects).toEqual([
      "local commerce integration is marked disconnected",
      "stored access token was cleared",
    ]);
    expect(outcome.providerConsoleActions).toEqual([
      "Uninstall the Moosewave app from Shopify admin",
    ]);
    expect(outcome.providerCleanupEvidence).toEqual([
      "deleted 3 webhook subscriptions",
    ]);
  });

  it("is complete only when managed AND both halves completed", () => {
    expect(disconnectCleanupComplete(normalizeDisconnectOutcome(WIRE))).toBe(
      true,
    );
    const unmanaged = normalizeDisconnectOutcome({
      ...WIRE,
      provider_cleanup: {
        ...WIRE.provider_cleanup,
        managed_provider_cleanup: false,
      },
    });
    expect(disconnectCleanupComplete(unmanaged)).toBe(false);
    const halfDone = normalizeDisconnectOutcome({
      ...WIRE,
      provider_cleanup: {
        ...WIRE.provider_cleanup,
        credential_cleanup_status: "manual",
      },
    });
    expect(disconnectCleanupComplete(halfDone)).toBe(false);
  });

  it("headlines the cleanup boundary unless cleanup is provably complete", () => {
    expect(disconnectOutcomeHeadline(normalizeDisconnectOutcome(WIRE))).toMatch(
      /removed what it had installed/,
    );
    expect(
      disconnectOutcomeHeadline(normalizeDisconnectOutcome({ ok: true })),
    ).toMatch(/Review the provider cleanup boundary/);
  });

  it("survives a bare {ok:true} and garbage", () => {
    const bare = normalizeDisconnectOutcome({ ok: true });
    expect(bare.ok).toBe(true);
    expect(bare.postwaveEffects).toEqual([]);
    expect(bare.webhookCleanupStatus).toBe("");
    const junk = normalizeDisconnectOutcome("nope");
    expect(junk.ok).toBe(false);
    expect(junk.providerConsoleActions).toEqual([]);
  });
});
