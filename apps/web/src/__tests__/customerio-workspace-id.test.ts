import { describe, expect, it } from "vitest";

import { customerIOWorkspaceIDError } from "@/lib/customerio-workspace-id";

describe("Customer.io workspace ID validation", () => {
  it("accepts an omitted or 1-to-64-digit workspace ID", () => {
    expect(customerIOWorkspaceIDError(" ")).toBeNull();
    expect(customerIOWorkspaceIDError(" 9001 ")).toBeNull();
    expect(customerIOWorkspaceIDError("9".repeat(64))).toBeNull();
  });

  it("rejects names, signs, whitespace, and overlong IDs", () => {
    expect(customerIOWorkspaceIDError("workspace-name")).not.toBeNull();
    expect(customerIOWorkspaceIDError("+9001")).not.toBeNull();
    expect(customerIOWorkspaceIDError("90 01")).not.toBeNull();
    expect(customerIOWorkspaceIDError("9".repeat(65))).not.toBeNull();
  });
});
