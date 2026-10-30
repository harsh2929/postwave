// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
  AUTOMATIONS_RUNTIME_AVAILABLE,
  OMNICHANNEL_DRAFT_CREATION_AVAILABLE,
  OMNICHANNEL_EXECUTION_AVAILABLE,
  TRIGGER_DELAY_LEARNING_AVAILABLE,
  TRIGGER_DELAY_MANUAL_OVERRIDE_AVAILABLE,
  ZERO_COPY_ALERTING_AVAILABLE,
  ZERO_COPY_DLQ_RECOVERY_AVAILABLE,
  ZERO_COPY_DRAFT_AUTHORING_AVAILABLE,
  ZERO_COPY_LIVE_POLL_AVAILABLE,
  automationRuntimeClaimIsAllowed,
} from "@/lib/automation-operational-availability";

describe("automation operational availability", () => {
  it("keeps every runtime and learned capability release-held", () => {
    expect(AUTOMATIONS_RUNTIME_AVAILABLE).toBe(false);
    expect(ZERO_COPY_LIVE_POLL_AVAILABLE).toBe(false);
    expect(ZERO_COPY_ALERTING_AVAILABLE).toBe(false);
    expect(ZERO_COPY_DLQ_RECOVERY_AVAILABLE).toBe(false);
    expect(TRIGGER_DELAY_LEARNING_AVAILABLE).toBe(false);
    expect(OMNICHANNEL_DRAFT_CREATION_AVAILABLE).toBe(false);
    expect(OMNICHANNEL_EXECUTION_AVAILABLE).toBe(false);
    expect(automationRuntimeClaimIsAllowed()).toBe(false);
  });

  it("enables only inert draft authoring and manual timing overrides", () => {
    expect(ZERO_COPY_DRAFT_AUTHORING_AVAILABLE).toBe(true);
    expect(TRIGGER_DELAY_MANUAL_OVERRIDE_AVAILABLE).toBe(true);
  });
});
