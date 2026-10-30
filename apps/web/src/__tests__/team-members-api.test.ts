// SPDX-License-Identifier: AGPL-3.0-only
//
// SETC-010: the pure helpers behind the roster — role/status labels, the
// copy-link composer, and the assignable-role gating that keeps a non-owner
// from ever offering (or re-roling into) the owner role.

import { describe, expect, it } from "vitest";

import {
  acceptInviteUrl,
  assignableRoleOptions,
  labelForMemberRole,
  labelForMemberStatus,
} from "@/lib/team-members-api";

describe("labelForMemberRole / labelForMemberStatus", () => {
  it("maps known roles + statuses and passes unknowns through", () => {
    expect(labelForMemberRole("owner")).toBe("Owner");
    expect(labelForMemberRole("editor")).toBe("Editor");
    expect(labelForMemberRole("mystery")).toBe("mystery");
    expect(labelForMemberStatus("suspended")).toBe("Suspended");
    expect(labelForMemberStatus("weird")).toBe("weird");
  });
});

describe("acceptInviteUrl", () => {
  it("composes an encoded accept link", () => {
    expect(acceptInviteUrl("https://app.example", "abc123")).toBe(
      "https://app.example/accept-invite?token=abc123",
    );
  });
  it("encodes tokens with URL-special characters", () => {
    expect(acceptInviteUrl("https://x", "a b/c")).toBe(
      "https://x/accept-invite?token=a%20b%2Fc",
    );
  });
});

describe("assignableRoleOptions", () => {
  it("offers every role to an owner", () => {
    expect(assignableRoleOptions(true, "editor")).toEqual([
      "owner",
      "admin",
      "editor",
      "viewer",
    ]);
  });
  it("never offers owner to a non-owner", () => {
    expect(assignableRoleOptions(false, "editor")).toEqual([
      "admin",
      "editor",
      "viewer",
    ]);
    expect(assignableRoleOptions(false, "admin")).not.toContain("owner");
  });
  it("locks a non-owner out of re-roling a sitting owner", () => {
    // Only 'owner' is returned, and the row is otherwise disabled in the UI —
    // a non-owner cannot modify an owner at all.
    expect(assignableRoleOptions(false, "owner")).toEqual(["owner"]);
  });
});
