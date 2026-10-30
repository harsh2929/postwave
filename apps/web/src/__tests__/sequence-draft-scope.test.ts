// SPDX-License-Identifier: AGPL-3.0-only
//
// The sequence-builder draft (email subject + body, up to 64KB) autosaves to
// sessionStorage. Sign-out is a router.push in the SAME tab, so sessionStorage
// survives it — and so does an in-place workspace switch. Under a single
// identity-less key, the next person to open /app/sequences/new had the
// previous operator's subject and body restored into the canvas verbatim, and
// could save them into their own workspace.
//
// Keying on (tenant, user) makes that structurally impossible, which is the
// same construction campaign-template-design-session.ts uses for its recovery
// slots.

import { describe, expect, it } from "vitest";

import {
  LEGACY_DRAFT_KEYS,
  STORAGE_KEY_PREFIX,
  sequenceDraftKey,
} from "@/app/(dashboard)/app/sequences/new/_components/sequence-builder-helpers";

describe("sequenceDraftKey", () => {
  it("gives two identities two different slots", () => {
    const a = sequenceDraftKey({ tenantId: "tenant-a", userId: "user-1" });
    const b = sequenceDraftKey({ tenantId: "tenant-b", userId: "user-1" });
    const c = sequenceDraftKey({ tenantId: "tenant-a", userId: "user-2" });

    expect(a).toBeTruthy();
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("is stable for the same identity", () => {
    expect(sequenceDraftKey({ tenantId: "t", userId: "u" })).toBe(
      sequenceDraftKey({ tenantId: "t", userId: "u" }),
    );
  });

  it("never falls back to an unscoped key", () => {
    expect(sequenceDraftKey(null)).toBeNull();
    expect(sequenceDraftKey(undefined)).toBeNull();
    expect(sequenceDraftKey({ tenantId: "", userId: "u" })).toBeNull();
    expect(sequenceDraftKey({ tenantId: "t", userId: "  " })).toBeNull();
    // The bare prefix is exactly the key that leaked; it must never be produced.
    expect(sequenceDraftKey({ tenantId: "t", userId: "u" })).not.toBe(
      STORAGE_KEY_PREFIX,
    );
  });

  it("escapes identity segments so one identity cannot forge another's key", () => {
    const forged = sequenceDraftKey({ tenantId: "t:u", userId: "x" });
    const real = sequenceDraftKey({ tenantId: "t", userId: "u:x" });
    expect(forged).not.toBe(real);
  });

  it("names the pre-scoping keys so they can be purged on mount", () => {
    expect(LEGACY_DRAFT_KEYS).toContain(STORAGE_KEY_PREFIX);
    expect(LEGACY_DRAFT_KEYS).toContain(`${STORAGE_KEY_PREFIX}:at`);
  });
});
