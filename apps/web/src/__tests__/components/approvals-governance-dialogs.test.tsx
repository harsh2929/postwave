// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDelegation: vi.fn(),
  getEscalationPolicy: vi.fn(),
  listDelegations: vi.fn(),
  revokeDelegation: vi.fn(),
  updateEscalationPolicy: vi.fn(),
}));

vi.mock("@/lib/approvals-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/approvals-api")>()),
  createDelegation: mocks.createDelegation,
  getEscalationPolicy: mocks.getEscalationPolicy,
  listDelegations: mocks.listDelegations,
  revokeDelegation: mocks.revokeDelegation,
  updateEscalationPolicy: mocks.updateEscalationPolicy,
}));

import { ApprovalsGovernancePanel } from "@/app/(dashboard)/app/approvals/approvals-governance-panel";

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("approval governance release hold", () => {
  it("renders the desktop-parity hold with zero reads, writes, or controls", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      act(() => root.render(<ApprovalsGovernancePanel />));

      expect(container.textContent).toContain(
        "Approval governance is on release hold",
      );
      expect(container.textContent).toContain(
        "performs no delegation or escalation-policy reads or writes",
      );
      expect(container.textContent).toContain("Staged approval chains");
      expect(container.textContent).toContain(
        "Signed links and Slack decisions",
      );
      expect(container.textContent).toContain(
        "must not be treated as active approval policy",
      );
      expect(container.querySelector("button")).toBeNull();
      expect(container.querySelector("input")).toBeNull();
      expect(mocks.listDelegations).not.toHaveBeenCalled();
      expect(mocks.getEscalationPolicy).not.toHaveBeenCalled();
      expect(mocks.createDelegation).not.toHaveBeenCalled();
      expect(mocks.revokeDelegation).not.toHaveBeenCalled();
      expect(mocks.updateEscalationPolicy).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
