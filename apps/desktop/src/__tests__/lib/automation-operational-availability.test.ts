import { describe, expect, it } from "vitest";

import {
  AUTOMATIONS_READINESS_STAGES,
  AUTOMATIONS_RUNTIME_AVAILABLE,
  AUTOMATIONS_RUNTIME_UNAVAILABLE_REASON,
  AUTOMATION_SURFACE_BOUNDARIES,
  automationRuntimeClaimIsAllowed,
  OMNICHANNEL_DRAFT_CREATION_AVAILABLE,
  OMNICHANNEL_EXECUTION_AVAILABLE,
  TRIGGER_DELAY_LEARNING_AVAILABLE,
  TRIGGER_DELAY_MANUAL_OVERRIDE_AVAILABLE,
  ZERO_COPY_ALERTING_AVAILABLE,
  ZERO_COPY_DRAFT_AUTHORING_AVAILABLE,
  ZERO_COPY_DLQ_RECOVERY_AVAILABLE,
  ZERO_COPY_LIVE_POLL_AVAILABLE,
} from "../../lib/automation-operational-availability";

describe("Automations operational availability", () => {
  it("fails every live execution and recovery capability closed", () => {
    expect({
      runtime: AUTOMATIONS_RUNTIME_AVAILABLE,
      zeroCopyDrafts: ZERO_COPY_DRAFT_AUTHORING_AVAILABLE,
      poll: ZERO_COPY_LIVE_POLL_AVAILABLE,
      alerting: ZERO_COPY_ALERTING_AVAILABLE,
      dlq: ZERO_COPY_DLQ_RECOVERY_AVAILABLE,
      manualDelay: TRIGGER_DELAY_MANUAL_OVERRIDE_AVAILABLE,
      learning: TRIGGER_DELAY_LEARNING_AVAILABLE,
      omnichannelDraftCreation: OMNICHANNEL_DRAFT_CREATION_AVAILABLE,
      omnichannel: OMNICHANNEL_EXECUTION_AVAILABLE,
    }).toEqual({
      runtime: false,
      zeroCopyDrafts: true,
      poll: false,
      alerting: false,
      dlq: false,
      manualDelay: true,
      learning: false,
      omnichannelDraftCreation: false,
      omnichannel: false,
    });
    expect(automationRuntimeClaimIsAllowed()).toBe(false);
  });

  it("separates safe draft work from unavailable execution claims", () => {
    expect(AUTOMATIONS_READINESS_STAGES.map((stage) => stage.id)).toEqual([
      "define",
      "verify",
      "execute",
      "observe",
    ]);
    expect(AUTOMATIONS_READINESS_STAGES.map((stage) => stage.tone)).toEqual([
      "available",
      "limited",
      "blocked",
      "blocked",
    ]);
    expect(AUTOMATIONS_RUNTIME_UNAVAILABLE_REASON).toContain("unavailable");
    expect(AUTOMATIONS_RUNTIME_UNAVAILABLE_REASON).not.toMatch(
      /operational|ready to send/i,
    );
  });

  it("documents every route surface without implying delivery", () => {
    expect(Object.keys(AUTOMATION_SURFACE_BOUNDARIES)).toEqual([
      "warehouse-triggers",
      "timing-overrides",
      "omnichannel-drafts",
    ]);
    for (const boundary of Object.values(AUTOMATION_SURFACE_BOUNDARIES)) {
      expect(boundary.available.length).toBeGreaterThan(20);
      expect(boundary.unavailable.length).toBeGreaterThan(20);
    }
    expect(
      AUTOMATION_SURFACE_BOUNDARIES["omnichannel-drafts"].unavailable,
    ).toContain("delivery proof");
  });
});
