/**
 * list-members-copy — honesty invariants for the MembersTab add-result
 * toast (Wave-2 membership editing).
 *
 * The contract: the toast must report the server's `{added, skipped}`
 * counts verbatim. In particular it must never claim "Added N" when
 * any of the N were skipped, and a fully-skipped batch must read as
 * "No subscribers added" — not as a success.
 */

import { describe, expect, it } from "vitest";

import { addMembersToastCopy } from "../../components/lists/tabs/members-copy";

describe("addMembersToastCopy", () => {
  it("clean add — message names the exact count and list", () => {
    const c = addMembersToastCopy("VIPs", { added: 3, skipped: 0 });
    expect(c.message).toBe("Added 3 subscribers to VIPs");
    expect(c.detail).toBeUndefined();
  });

  it("singular add pluralizes correctly", () => {
    const c = addMembersToastCopy("VIPs", { added: 1, skipped: 0 });
    expect(c.message).toBe("Added 1 subscriber to VIPs");
  });

  it("partial add — message says 'N of M', detail names the skips", () => {
    const c = addMembersToastCopy("VIPs", { added: 2, skipped: 3 });
    expect(c.message).toBe("Added 2 of 5 subscribers to VIPs");
    expect(c.detail).toContain("3 skipped");
    // Must not read as an unqualified success.
    expect(c.message).not.toBe("Added 2 subscribers to VIPs");
  });

  it("fully-skipped batch is NOT presented as a success", () => {
    const c = addMembersToastCopy("VIPs", { added: 0, skipped: 4 });
    expect(c.message).toBe("No subscribers added");
    expect(c.detail).toContain("All 4");
    expect(c.detail).toContain("skipped");
  });

  it("empty result (0/0) still reads as a no-op, never a success", () => {
    const c = addMembersToastCopy("VIPs", { added: 0, skipped: 0 });
    expect(c.message).toBe("No subscribers added");
  });

  it("never fabricates counts — added + skipped appear as returned", () => {
    const c = addMembersToastCopy("Newsletter", { added: 10, skipped: 1 });
    expect(c.message).toBe("Added 10 of 11 subscribers to Newsletter");
    expect(c.detail).toBe(
      "1 skipped (already members, suppressed, or unknown).",
    );
  });
});
