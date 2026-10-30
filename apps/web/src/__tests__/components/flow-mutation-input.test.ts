// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { buildFlowMutationInput } from "@/app/(dashboard)/app/flows/_components/flow-mutation-input";

const graph = {
  entry_id: "entry",
  nodes: [{ id: "entry", type: "send_email" }],
  triggers: [{ type: "subscriber.created" }],
  edges: [],
  goals: [],
};

describe("buildFlowMutationInput", () => {
  it.each([undefined, "paused" as const])(
    "persists the policy for every editor mutation status (%s)",
    (status) => {
      expect(
        buildFlowMutationInput({
          name: "Win-back",
          reEnrollment: "cooldown",
          cooldownHours: 48,
          graph,
          status,
        }),
      ).toMatchObject({
        ...(status ? { status } : {}),
        name: "Win-back",
        re_enrollment: "cooldown",
        re_enrollment_cooldown_hours: 48,
        entry_id: "entry",
      });
    },
  );

  it("persists always without sending an irrelevant cooldown", () => {
    const input = buildFlowMutationInput({
      name: "Abandoned cart",
      reEnrollment: "always",
      cooldownHours: 72,
      graph,
    });

    expect(input.re_enrollment).toBe("always");
    expect(input).not.toHaveProperty("re_enrollment_cooldown_hours");
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid cooldown hours (%s)",
    (cooldownHours) => {
      expect(() =>
        buildFlowMutationInput({
          name: "Win-back",
          reEnrollment: "cooldown",
          cooldownHours,
          graph,
        }),
      ).toThrow("positive whole number");
    },
  );
});
