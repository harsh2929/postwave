import { describe, expect, it } from "vitest";

import {
  checklistScore,
  checklistSummary,
  securityChecklist,
  type SecurityChecklistInput,
} from "./securityChecklist";

const capable: SecurityChecklistInput = {
  totpEnabled: false,
  emailVerified: false,
  appLockEnabled: false,
  appLockCapable: true,
};

function byKey(input: SecurityChecklistInput) {
  return Object.fromEntries(
    securityChecklist(input).map((item) => [item.key, item]),
  );
}

describe("securityChecklist", () => {
  it("reports each protection from the state the app already holds", () => {
    const items = byKey({
      totpEnabled: true,
      emailVerified: true,
      appLockEnabled: true,
      appLockCapable: true,
    });
    expect(items.two_factor?.status).toBe("on");
    expect(items.email_verified?.status).toBe("on");
    expect(items.app_lock?.status).toBe("on");
  });

  it("gives every unmet protection a verb, never a bare 'off'", () => {
    for (const item of securityChecklist(capable)) {
      expect(item.status).toBe("off");
      expect(item.action.length).toBeGreaterThan(0);
    }
  });

  it("spells the state out for assistive tech instead of relying on a glyph", () => {
    const items = byKey(capable);
    // The visible row is a tick/cross plus "On"/"Off"; neither is a sentence,
    // and colour alone may not carry state.
    expect(items.two_factor?.spoken).toMatch(/^Two-factor authentication: off\./);
    expect(items.two_factor?.spoken).toContain("Add an authenticator app");
  });

  it("marks app lock unavailable — not off — on a device that cannot do it", () => {
    const items = byKey({ ...capable, appLockCapable: false });
    expect(items.app_lock?.status).toBe("unavailable");
    // No action, because there is nothing the user can do inside this app.
    expect(items.app_lock?.action).toBe("");
    expect(items.app_lock?.spoken).toContain("no passcode or biometrics");
  });

  it("does not report app lock as ON when the device lost its authenticators", () => {
    // A stale "1" in SecureStore on a device whose passcode was removed must
    // not claim a protection that cannot be enforced.
    const items = byKey({
      ...capable,
      appLockEnabled: true,
      appLockCapable: false,
    });
    expect(items.app_lock?.status).toBe("unavailable");
  });
});

describe("checklistScore", () => {
  it("counts only what this device can actually provide", () => {
    // 2 of 3 achievable, app lock impossible → 2 of 2, not 2 of 3. Scoring an
    // unachievable row keeps the card permanently incomplete, which is exactly
    // how a checklist teaches users to ignore it.
    const score = checklistScore(
      securityChecklist({
        totpEnabled: true,
        emailVerified: true,
        appLockEnabled: false,
        appLockCapable: false,
      }),
    );
    expect(score).toEqual({ on: 2, total: 2, complete: true });
  });

  it("is incomplete while anything achievable is off", () => {
    const score = checklistScore(
      securityChecklist({ ...capable, totpEnabled: true, emailVerified: true }),
    );
    expect(score).toEqual({ on: 2, total: 3, complete: false });
  });

  it("is not 'complete' when there is nothing to complete", () => {
    expect(checklistScore([])).toEqual({ on: 0, total: 0, complete: false });
  });
});

describe("checklistSummary", () => {
  it("states the fraction in words the user can read at a glance", () => {
    expect(checklistSummary({ on: 1, total: 3, complete: false })).toBe(
      "1 of 3 protections on",
    );
  });

  it("celebrates completion instead of leaving '3 of 3' to be inferred", () => {
    expect(checklistSummary({ on: 3, total: 3, complete: true })).toBe(
      "All 3 protections on",
    );
    expect(checklistSummary({ on: 1, total: 1, complete: true })).toBe(
      "1 of 1 protection on",
    );
  });

  it("says so plainly when the device provides nothing", () => {
    expect(checklistSummary({ on: 0, total: 0, complete: false })).toBe(
      "No protections available on this device",
    );
  });
});
