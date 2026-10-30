// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const inventory = vi.hoisted(() => ({
  globalStatus: "clear" as "clear" | "held" | "unavailable",
  scope: `v1-session-${"a".repeat(64)}` as string | null,
  status: "clear" as "clear" | "current" | "foreign" | "mixed" | "unavailable",
}));

vi.mock("../../lib/webhook-playground-fire-recovery", () => ({
  inspectWebhookPlaygroundFireRecoveryInventory: () => inventory.globalStatus,
  inspectWebhookPlaygroundFireRecoveryScopeInventory: (scope: string) => {
    expect(scope).toBe(inventory.scope);
    return inventory.status;
  },
}));

vi.mock("../../lib/webhook-playground-fire-verified-scope", () => ({
  currentVerifiedWebhookPlaygroundFireScope: () => inventory.scope,
}));

import { acquireWebhookPlaygroundFireIdentityTransitionLease } from "../../lib/webhook-playground-fire-identity-transition";
import {
  inspectWebhookPlaygroundFireOperationExclusion,
  resetWebhookPlaygroundFireOperationExclusionForTests,
  tryAcquireWebhookPlaygroundFireOperationLease,
} from "../../lib/webhook-playground-fire-operation";

beforeEach(() => {
  inventory.globalStatus = "clear";
  inventory.status = "clear";
  inventory.scope = `v1-session-${"a".repeat(64)}`;
  resetWebhookPlaygroundFireOperationExclusionForTests();
});

describe("webhook playground identity-transition exclusion", () => {
  it("holds an exclusive lease from clear preflight through transition release", () => {
    const transition = acquireWebhookPlaygroundFireIdentityTransitionLease();

    expect(inspectWebhookPlaygroundFireOperationExclusion()).toBe(
      "sign-out-active",
    );
    expect(tryAcquireWebhookPlaygroundFireOperationLease()).toBeNull();
    transition.release();
    expect(tryAcquireWebhookPlaygroundFireOperationLease()).not.toBeNull();
  });

  it.each(["current", "mixed", "unavailable"] as const)(
    "refuses %s checkpoint inventory without retaining the lease",
    (status) => {
      inventory.globalStatus =
        status === "unavailable" ? "unavailable" : "held";
      inventory.status = status;

      expect(() =>
        acquireWebhookPlaygroundFireIdentityTransitionLease(),
      ).toThrow(/webhook Simulator|checkpoint inventory/u);
      expect(inspectWebhookPlaygroundFireOperationExclusion()).toBe("clear");
    },
  );

  it("allows an exclusive transition toward a foreign artifact's identity", () => {
    inventory.globalStatus = "held";
    inventory.status = "foreign";

    const transition = acquireWebhookPlaygroundFireIdentityTransitionLease();

    expect(inspectWebhookPlaygroundFireOperationExclusion()).toBe(
      "sign-out-active",
    );
    transition.release();
  });

  it("allows credential restoration when held evidence has no currently verified scope", () => {
    inventory.globalStatus = "held";
    inventory.scope = null;

    const transition = acquireWebhookPlaygroundFireIdentityTransitionLease();

    expect(inspectWebhookPlaygroundFireOperationExclusion()).toBe(
      "sign-out-active",
    );
    transition.release();
    expect(inspectWebhookPlaygroundFireOperationExclusion()).toBe("clear");
  });

  it("refuses while a fire lifecycle owns the operation lease", () => {
    const fire = tryAcquireWebhookPlaygroundFireOperationLease();
    expect(fire).not.toBeNull();

    expect(() => acquireWebhookPlaygroundFireIdentityTransitionLease()).toThrow(
      /fire or identity transition is active/u,
    );
    expect(inspectWebhookPlaygroundFireOperationExclusion()).toBe(
      "operation-active",
    );
    fire?.release();
  });
});
