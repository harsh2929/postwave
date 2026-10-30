/**
 * Release-qualified Automations capability boundary.
 *
 * The current build can persist and inspect draft configuration, but it does
 * not yet have the durable, tenant-safe execution evidence required to claim
 * that warehouse rows start journeys or that omnichannel drafts deliver.
 * Keep every renderer affordance derived from this immutable boundary until a
 * candidate-bound runtime qualification replaces it with observed readiness.
 */
export const AUTOMATIONS_RUNTIME_AVAILABLE = false;
export const ZERO_COPY_DRAFT_AUTHORING_AVAILABLE = true;
export const ZERO_COPY_LIVE_POLL_AVAILABLE = false;
export const ZERO_COPY_ALERTING_AVAILABLE = false;
export const ZERO_COPY_DLQ_RECOVERY_AVAILABLE = false;
export const TRIGGER_DELAY_MANUAL_OVERRIDE_AVAILABLE = true;
export const TRIGGER_DELAY_LEARNING_AVAILABLE = false;
/**
 * The current campaign form cannot bind an explicit tenant-owned audience,
 * approved template revision, or immutable plan. Keep even draft creation off
 * until that authoring contract exists; this is distinct from execution.
 */
export const OMNICHANNEL_DRAFT_CREATION_AVAILABLE = false;
export const OMNICHANNEL_EXECUTION_AVAILABLE = false;

export const AUTOMATIONS_RUNTIME_UNAVAILABLE_REASON =
  "Live warehouse-trigger execution and omnichannel delivery are unavailable in this build. Draft configuration and inspection do not prove that a journey ran or a message was delivered.";

export type AutomationReadinessTone = "available" | "limited" | "blocked";

export interface AutomationReadinessStage {
  id: "define" | "verify" | "execute" | "observe";
  label: string;
  tone: AutomationReadinessTone;
  detail: string;
}

/**
 * Ordered, user-facing readiness model. “Verify” remains limited because
 * server-side syntax validation is useful but is not an end-to-end dry run.
 */
export const AUTOMATIONS_READINESS_STAGES: readonly AutomationReadinessStage[] =
  [
    {
      id: "define",
      label: "Define drafts",
      tone: "available",
      detail:
        "Store trigger drafts and manual timing overrides; inspect existing campaign definitions.",
    },
    {
      id: "verify",
      label: "Validate inputs",
      tone: "limited",
      detail:
        "Syntax and field validation is available; runtime dependencies and delivery are not proven.",
    },
    {
      id: "execute",
      label: "Run automation",
      tone: "blocked",
      detail:
        "Polling, journey execution, audience materialization, and dispatch are disabled.",
    },
    {
      id: "observe",
      label: "Verify delivery",
      tone: "blocked",
      detail:
        "Fire rows, queued outcomes, and stored statuses are not delivery receipts.",
    },
  ] as const;

export type AutomationSurfaceKey =
  | "warehouse-triggers"
  | "timing-overrides"
  | "omnichannel-drafts";

export interface AutomationSurfaceBoundary {
  label: string;
  available: string;
  unavailable: string;
}

export const AUTOMATION_SURFACE_BOUNDARIES: Readonly<
  Record<AutomationSurfaceKey, AutomationSurfaceBoundary>
> = {
  "warehouse-triggers": {
    label: "Warehouse trigger drafts",
    available: "Draft definition, inspection, and input validation",
    unavailable: "Activation, live polling, alerting, and DLQ recovery",
  },
  "timing-overrides": {
    label: "Manual timing overrides",
    available: "Read and store an explicit subscriber-event override",
    unavailable: "Learned optimization, confidence, and universal enforcement",
  },
  "omnichannel-drafts": {
    label: "Omnichannel campaign drafts",
    available: "Catalog inspection and summarized stored path inspection",
    unavailable:
      "Safe draft creation, audience materialization, scheduling, dispatch, and delivery proof",
  },
};

export function automationRuntimeClaimIsAllowed(): boolean {
  return (
    AUTOMATIONS_RUNTIME_AVAILABLE &&
    ZERO_COPY_LIVE_POLL_AVAILABLE &&
    ZERO_COPY_ALERTING_AVAILABLE &&
    ZERO_COPY_DLQ_RECOVERY_AVAILABLE &&
    OMNICHANNEL_EXECUTION_AVAILABLE
  );
}
