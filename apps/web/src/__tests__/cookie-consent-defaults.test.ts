// SPDX-License-Identifier: AGPL-3.0-only
//
// Non-essential cookie consent is opt-in, which means the boxes start empty.
// The banner had two ways into the Customize panel and they disagreed:
//
//   * First visit → "Customize" only flips `customizing`; analytics and
//     marketing stay at their useState(false) — correct.
//   * Footer "Cookie preferences" → openPrefs() ran
//     `existing?.analytics ?? !globalPrivacyControlEnabled()`. For a visitor
//     who had not chosen yet, `existing` is null and GPC is off, so Analytics
//     rendered pre-ticked. "Save preferences" is the primary button and takes
//     focus when the panel opens, so one keypress recorded analytics: true —
//     in localStorage and in the server consent ledger, whose entire purpose
//     is to be the audit trail of what the visitor actually chose.
//
// The GPC term read like a safeguard but could never fire: when GPC is on, the
// mount effect has already written a "gpc" record, so `existing` is non-null.
import { describe, expect, it } from "vitest";

import { initialOptionalPrefs } from "@/components/marketing/cookie-banner";

describe("cookie preference defaults", () => {
  it("starts every optional category unchecked when nothing is stored", () => {
    expect(initialOptionalPrefs(null)).toEqual({
      analytics: false,
      marketing: false,
    });
  });

  it("restores a stored choice exactly, in both directions", () => {
    // Guard the guard: if this returned constants, the test above would pass
    // while the panel silently discarded what the visitor had chosen.
    expect(
      initialOptionalPrefs({
        essential: true,
        analytics: true,
        marketing: true,
      }),
    ).toEqual({ analytics: true, marketing: true });
    expect(
      initialOptionalPrefs({
        essential: true,
        analytics: true,
        marketing: false,
      }),
    ).toEqual({ analytics: true, marketing: false });
    expect(
      initialOptionalPrefs({
        essential: true,
        analytics: false,
        marketing: false,
      }),
    ).toEqual({ analytics: false, marketing: false });
  });

  it("does not reintroduce a default that depends on the GPC signal", () => {
    // The specific expression that caused this. A default derived from an
    // absent GPC header is a default of `true`.
    const source = initialOptionalPrefs.toString();
    expect(source).not.toMatch(/globalPrivacyControl/i);
  });
});
