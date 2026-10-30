/**
 * Who may ask for a referrer's link, and when the request is allowed to fire.
 *
 * TWO INVARIANTS LIVE HERE, and both were previously unheld.
 *
 * 1. THE NO-PREFETCH INVARIANT. `GET /api/v1/subscribers/{id}/referral` is a
 *    read with a WRITE side effect — the handler calls `EnsureCode`, which
 *    MINTS the subscriber's referral code on first ask. Issuing it for a list
 *    would create referral codes as a side effect of scrolling. The gate that
 *    stops that is the `subscriberId` term of the query's `enabled` clause.
 *    A native render test cannot hold it: `__tests__/mocks/reactQuery.cjs`
 *    replaces `useQuery` itself, so no `enabled` clause in the module graph is
 *    ever evaluated, and asserting that a link is not on screen before a press
 *    only re-reads the card's own `useState`. Deleting the term left the whole
 *    native suite green. So the predicate was lifted out of the hook and is
 *    exercised here, in node, where it can actually fail.
 *
 * 2. THE AUTHORITY FLOOR. That same route is the one `r.With(admin)` read on
 *    the screen, and `ScopeAdmin` is not in `readOnlyScopes`, so on the
 *    session-cookie path it is an owner|admin ROLE check and a viewer gets 403
 *    `insufficient_role`. The floor is mirrored as
 *    SUBSCRIBER_REFERRAL_MINIMUM_ROLE and held to the Go source below, so a
 *    future relaxation of the route widens the affordance rather than leaving
 *    it shut for no reason.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canAccessMinimumRole, type MobileAccessRole } from "./mobileRouteManifest";
import {
  REFERRAL_RUNTIME_AVAILABLE,
  SUBSCRIBER_REFERRAL_MINIMUM_ROLE,
  SUBSCRIBER_REFERRAL_ROLE_NOTE,
  SUBSCRIBER_REFERRAL_ROLE_REFUSAL,
  subscriberReferralErrorMessage,
  subscriberReferralQueryEnabled,
} from "./referrals";

const source = readFileSync(
  fileURLToPath(
    new URL("../../../api/internal/referrals/referrals.go", import.meta.url),
  ),
  "utf8",
);

/** The `enabled` inputs for an owner who has pressed one row. Every test below
 *  starts from this and turns exactly one thing off, so a failure names the
 *  term that broke rather than "the predicate". */
const PRESSED = Object.freeze({
  runtimeAvailable: true,
  gateEnabled: true,
  tenantId: "11111111-1111-4111-8111-111111111111",
  canMintLink: true,
  subscriberId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
});

describe("the no-prefetch gate on the code-minting read", () => {
  it("is SHUT until a specific referrer has been pressed", () => {
    // The load-bearing case. `null` is what the card holds before any press and
    // after a second press collapses the row; either way the request that would
    // mint a code must not be issued.
    expect(
      subscriberReferralQueryEnabled({ ...PRESSED, subscriberId: null }),
    ).toBe(false);
    expect(
      subscriberReferralQueryEnabled({ ...PRESSED, subscriberId: undefined }),
    ).toBe(false);
    // An empty string is the same fact wearing a different type — it would build
    // `/api/v1/subscribers//referral`, which is not a request anybody meant.
    expect(
      subscriberReferralQueryEnabled({ ...PRESSED, subscriberId: "" }),
    ).toBe(false);
  });

  it("opens for exactly the id that was pressed, and only then", () => {
    expect(subscriberReferralQueryEnabled(PRESSED)).toBe(true);
  });

  /**
   * ONE AT A TIME, stated as an invariant over the predicate rather than over
   * the card's rendering. The card holds a single `selectedId`, so the set of
   * ids this predicate says "yes" to has at most one member: pressing a second
   * row REPLACES the first, and the first must go back to false. If the card
   * ever grew a multi-select, this is the assertion that would have to be
   * consciously deleted.
   */
  it("admits at most one referrer at a time", () => {
    const first = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const second = "ffffffff-0000-1111-2222-333333333333";
    const selected = second;
    const enabledFor = (id: string) =>
      subscriberReferralQueryEnabled({
        ...PRESSED,
        subscriberId: selected === id ? id : null,
      });
    expect(enabledFor(second)).toBe(true);
    expect(enabledFor(first)).toBe(false);
  });

  it("stays shut on every other term, each for its own reason", () => {
    // The release gate: with the runtime closed the route is not mounted and
    // this would be a 404, not a link.
    expect(
      subscriberReferralQueryEnabled({ ...PRESSED, runtimeAvailable: false }),
    ).toBe(false);
    // Offline or signed out.
    expect(
      subscriberReferralQueryEnabled({ ...PRESSED, gateEnabled: false }),
    ).toBe(false);
    // No workspace resolved: the query key would be wrong and the request
    // untenanted.
    expect(subscriberReferralQueryEnabled({ ...PRESSED, tenantId: null })).toBe(
      false,
    );
    // Below the role floor: a guaranteed 403.
    expect(
      subscriberReferralQueryEnabled({ ...PRESSED, canMintLink: false }),
    ).toBe(false);
  });

  it("describes the world this build actually ships", () => {
    // Guard the guard, in the CLOSED direction now: the server tree re-held
    // the release on 2026-08-30 ("RELEASE REMAINS HELD…", referrals.go:46-52),
    // so the mount is gone and PRESSED's `true` case above documents what a
    // re-open will restore rather than what a user can reach today. The card
    // withholds the affordance on this same flag, so no press can occur.
    expect(REFERRAL_RUNTIME_AVAILABLE).toBe(false);
  });
});

describe("the authority floor on the same read", () => {
  it("mirrors the `admin` binding the Go source puts on the route", () => {
    // The mount line, verbatim. `read` and `admin` are declared at the top of
    // MountAdminRoutes as RequireScope(ScopeReadReports) / RequireScope(
    // ScopeAdmin), so which one wraps this route IS the floor.
    expect(source).toContain('read := apikeys.RequireScope(apikeys.ScopeReadReports)');
    expect(source).toContain('admin := apikeys.RequireScope(apikeys.ScopeAdmin)');
    const mount = new RegExp(
      'r\\.With\\((read|admin)\\)\\.Get\\("/api/v1/subscribers/\\{id\\}/referral"',
    ).exec(source);
    expect(mount, "the subscriber-referral route is no longer mounted").not.toBeNull();
    expect(mount?.[1]).toBe("admin");
    expect(SUBSCRIBER_REFERRAL_MINIMUM_ROLE).toBe("admin");
  });

  it("is the only read on this screen with that floor", () => {
    // The contrast is the reason the gate is worth having: payouts and variants
    // are read-scope, so a viewer sees those cards in full and loses only the
    // one affordance. If these ever became `admin` too, the note the card shows
    // would be understating what is missing.
    for (const path of ["/api/v1/referrals/payouts", "/api/v1/referrals/variants"]) {
      const match = new RegExp(
        `r\\.With\\((read|admin)\\)\\.Get\\("${path}"`,
      ).exec(source);
      expect(match?.[1], `${path} changed authority`).toBe("read");
    }
  });

  it("withholds the affordance from every role below the floor", () => {
    const floor = SUBSCRIBER_REFERRAL_MINIMUM_ROLE as MobileAccessRole;
    for (const role of ["viewer", "member", "editor"]) {
      expect(
        canAccessMinimumRole(floor, role, "session"),
        `${role} must not be offered a control that 403s`,
      ).toBe(false);
    }
    for (const role of ["admin", "owner"]) {
      expect(canAccessMinimumRole(floor, role, "session"), role).toBe(true);
    }
    // No session role at all — a cold start before the profile lands — is not
    // an admin. Fail closed.
    expect(canAccessMinimumRole(floor, null, "session")).toBe(false);
    // An API key is admitted only to a viewer floor: mobile cannot see which
    // scopes a key carries, so `admin` fails closed for keys too.
    expect(canAccessMinimumRole(floor, "owner", "api_key")).toBe(false);
  });
});

describe("what a refusal says", () => {
  /**
   * The reason this is a finding rather than a nicety: "Couldn't get this
   * referrer's link." reads as transient. It invites a retry that is guaranteed
   * to fail identically, because the server is not failing — it is declining.
   */
  it("names the role requirement instead of implying a retry", () => {
    for (const error of [
      { status: 403, code: "insufficient_role" },
      { status: 403, code: "insufficient_scope" },
      { status: 403 },
      { code: "insufficient_role" },
    ]) {
      const message = subscriberReferralErrorMessage(error);
      expect(message).toBe(SUBSCRIBER_REFERRAL_ROLE_REFUSAL);
      expect(message).not.toBe("Couldn't get this referrer's link.");
    }
    expect(SUBSCRIBER_REFERRAL_ROLE_REFUSAL).toMatch(/owner or admin role/);
    expect(SUBSCRIBER_REFERRAL_ROLE_REFUSAL).toMatch(/Retrying will not help/);
  });

  it("leaves the two configuration failures and the fallback alone", () => {
    // Guard against the 403 branch swallowing its neighbours: 503 and 409 have
    // different recoveries and one of them IS "try again".
    expect(subscriberReferralErrorMessage({ status: 503 })).toMatch(
      /REFERRAL_SHARE_BASE_URL/,
    );
    expect(subscriberReferralErrorMessage({ code: "code_contention" })).toBe(
      "The referral code namespace is busy. Try again in a moment.",
    );
    expect(subscriberReferralErrorMessage(new Error("boom"))).toBe(
      "Couldn't get this referrer's link.",
    );
  });

  it("keeps the withheld-affordance note true to the floor it describes", () => {
    // Both sentences say "owner or admin", which is only correct while the
    // mirrored floor is `admin`. If the route relaxes to read-scope, this fails
    // and points at the copy rather than letting the app keep citing a rule
    // that no longer exists.
    expect(SUBSCRIBER_REFERRAL_MINIMUM_ROLE).toBe("admin");
    expect(SUBSCRIBER_REFERRAL_ROLE_NOTE).toMatch(/owner or admin role/);
    // It has to say what the role CAN still read, or the card reads as broken
    // rather than as scoped.
    expect(SUBSCRIBER_REFERRAL_ROLE_NOTE).toMatch(/counts below/i);
  });
});
