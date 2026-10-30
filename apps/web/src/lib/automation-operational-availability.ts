// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Release-qualified automation boundary for the web client.
 *
 * Configuration persistence is useful, but it is not proof that a warehouse
 * was polled, a journey ran, or a message was delivered. Keep the blocked
 * capabilities immutable until a separately reviewed release qualification
 * changes this contract and its tests.
 */
export const AUTOMATIONS_RUNTIME_AVAILABLE = false;
export const ZERO_COPY_DRAFT_AUTHORING_AVAILABLE = true;
export const ZERO_COPY_LIVE_POLL_AVAILABLE = false;
export const ZERO_COPY_ALERTING_AVAILABLE = false;
export const ZERO_COPY_DLQ_RECOVERY_AVAILABLE = false;
export const TRIGGER_DELAY_MANUAL_OVERRIDE_AVAILABLE = true;
export const TRIGGER_DELAY_LEARNING_AVAILABLE = false;
export const OMNICHANNEL_DRAFT_CREATION_AVAILABLE = false;
export const OMNICHANNEL_EXECUTION_AVAILABLE = false;

export const AUTOMATIONS_RUNTIME_UNAVAILABLE_REASON =
  "Live warehouse polling, journey execution, omnichannel delivery, alerting, and recovery are release-held. Stored drafts and manual timing overrides are configuration only.";

export const AUTOMATION_CONFIGURATION_BOUNDARIES = {
  warehouseDrafts: {
    available:
      "Draft list, filter, create, edit, inspect, validate, and delete; read-only inspection of enqueue records, alert thresholds, and recovery entries",
    unavailable:
      "Activation, polling, alert editing, and DLQ retry — stored records are not execution or delivery proof",
  },
  timingOverrides: {
    available: "Read and store one explicit subscriber-event delay override",
    unavailable:
      "Learned timing, confidence claims, bulk optimization, and execution proof",
  },
  omnichannel: {
    available: "No authoring capability is release-qualified on this page",
    unavailable:
      "Draft creation, audience materialization, activation, dispatch, and delivery proof",
  },
} as const;

export function automationRuntimeClaimIsAllowed(): boolean {
  return (
    AUTOMATIONS_RUNTIME_AVAILABLE &&
    ZERO_COPY_LIVE_POLL_AVAILABLE &&
    ZERO_COPY_ALERTING_AVAILABLE &&
    ZERO_COPY_DLQ_RECOVERY_AVAILABLE &&
    OMNICHANNEL_EXECUTION_AVAILABLE
  );
}
