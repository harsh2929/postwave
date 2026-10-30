import { describe, expect, it } from "vitest";

import { subscriberDetailGates } from "./subscriberDetailGates";

const authed = {
  online: true,
  hasWriteRole: true,
  hasAdminRole: true,
  hasSessionNotice: false,
};

describe("subscriberDetailGates", () => {
  it("allows everything for an online editor on a validated session", () => {
    const gates = subscriberDetailGates(authed);
    expect(gates.canMutate).toBe(true);
    expect(gates.canAddToList).toBe(true);
    expect(gates.unavailableReason).toBeUndefined();
    expect(gates.addToListUnavailableReason).toBeUndefined();
  });

  it("keeps add-to-list available offline and refuses the rest (AUDIENCE#33)", () => {
    // lists.AddSubscribers only ever adds and the route is idempotent by
    // construction, so a queued add cannot destroy anything on replay.
    const gates = subscriberDetailGates({ ...authed, online: false });
    expect(gates.canAddToList).toBe(true);
    expect(gates.addToListUnavailableReason).toBeUndefined();
    expect(gates.canMutate).toBe(false);
    expect(gates.unavailableReason).toBe(
      "You're offline. Subscriber changes need a connection.",
    );
  });

  it("refuses BOTH for a viewer, online or not", () => {
    for (const online of [true, false]) {
      const gates = subscriberDetailGates({
        ...authed,
        online,
        hasWriteRole: false,
        hasAdminRole: false,
      });
      expect(gates.canMutate).toBe(false);
      expect(gates.canAddToList).toBe(false);
      expect(gates.addToListUnavailableReason).toBe(
        "Your role has read-only access to subscribers.",
      );
    }
  });

  it("refuses BOTH on a cached, unvalidated session", () => {
    // The queue re-proves origin + tenant + principal + role at replay time,
    // so enqueuing against an identity that may still 401 would only produce a
    // failure the user reads long after the moment they acted.
    const gates = subscriberDetailGates({ ...authed, hasSessionNotice: true });
    expect(gates.canMutate).toBe(false);
    expect(gates.canAddToList).toBe(false);
    expect(gates.addToListUnavailableReason).toBe(
      "Reconnect this session before making changes.",
    );
  });

  it("puts the role reason ahead of the offline one", () => {
    // A viewer who is also offline must be told the thing that will still be
    // true when the signal comes back.
    const gates = subscriberDetailGates({
      online: false,
      hasWriteRole: false,
      hasAdminRole: false,
      hasSessionNotice: true,
    });
    expect(gates.unavailableReason).toBe(
      "Your role has read-only access to subscribers.",
    );
  });

  it("gates the consent ledger on ADMIN, not on the editor write role", () => {
    // consent.go:156 mounts the receipts read behind RequireScope(ScopeAdmin),
    // which is neither a read-only nor an editor-write scope: an editor may
    // edit this subscriber and still cannot see their consent records.
    expect(
      subscriberDetailGates({ ...authed, hasAdminRole: false }).canReadConsent,
    ).toBe(false);
    expect(subscriberDetailGates(authed).canReadConsent).toBe(true);
  });

  it("keeps the consent READ open on a cached, unvalidated session", () => {
    // It is a read: it either succeeds or 401s honestly. Hiding an auditor's
    // evidence because the session is stale would be the wrong failure.
    expect(
      subscriberDetailGates({ ...authed, hasSessionNotice: true })
        .canReadConsent,
    ).toBe(true);
  });

  it("never returns a reason alongside an allowed action", () => {
    for (const online of [true, false]) {
      for (const hasWriteRole of [true, false]) {
        for (const hasSessionNotice of [true, false]) {
          const gates = subscriberDetailGates({
            online,
            hasWriteRole,
            hasAdminRole: hasWriteRole,
            hasSessionNotice,
          });
          if (gates.canMutate) expect(gates.unavailableReason).toBeUndefined();
          else expect(gates.unavailableReason).toBeTruthy();
          if (gates.canAddToList) {
            expect(gates.addToListUnavailableReason).toBeUndefined();
          } else {
            expect(gates.addToListUnavailableReason).toBeTruthy();
          }
        }
      }
    }
  });
});

describe("consent-ledger gate", () => {
  const base = { online: true, hasWriteRole: true, hasSessionNotice: false };

  it("is CLOSED for an editor — the receipts route is admin-scoped", () => {
    // GET /api/v1/consent/receipts/by-email/{email} is
    // RequireScope(ScopeAdmin), and ScopeAdmin is in neither readOnlyScopes
    // nor editorWriteScopes, so a session admits owner|admin only.
    expect(subscriberDetailGates(base).canReadConsent).toBe(false);
    expect(subscriberDetailGates({ ...base, hasAdminRole: false }).canReadConsent).toBe(
      false,
    );
  });

  it("is OPEN for an admin", () => {
    expect(subscriberDetailGates({ ...base, hasAdminRole: true }).canReadConsent).toBe(
      true,
    );
  });

  it("stays open on a stale session — it is a READ, not a write", () => {
    const g = subscriberDetailGates({
      ...base,
      hasAdminRole: true,
      hasSessionNotice: true,
    });
    expect(g.canMutate).toBe(false);
    expect(g.canReadConsent).toBe(true);
  });

  it("stays open offline — the request 401s or fails honestly on its own", () => {
    expect(
      subscriberDetailGates({ ...base, hasAdminRole: true, online: false })
        .canReadConsent,
    ).toBe(true);
  });

  it("fails closed when the caller says nothing about the admin tier", () => {
    expect(subscriberDetailGates(base).canReadConsent).toBe(false);
  });
});
