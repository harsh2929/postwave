/**
 * SequenceTriggerCard — entry-condition surface for the sequence canvas.
 *
 * Sits above the steps list and answers the "how does a subscriber land
 * in this flow?" question that the list-page ValueProp used to promise
 * but never delivered. Empty state shows a warning chip so operators
 * can't activate a sequence that has no entry condition without seeing
 * the gap; configured state shows a one-line summary + Edit button.
 *
 * Persistence lives one level up in StepCanvas — this component is a
 * dumb renderer that takes the current trigger + an onEdit callback.
 */
import { type ReactElement, useId } from "react";

import { type SequenceTrigger } from "../../lib/api-client";
import {
  SEQUENCE_RUNTIME_AVAILABLE,
  SEQUENCE_RUNTIME_UNAVAILABLE_REASON,
} from "../../lib/sequence-operational-availability";

import { triggerSummary } from "./trigger-config";

interface Props {
  trigger: SequenceTrigger | null;
  /** Editor + admin only; viewer hides the Edit affordance. */
  canMutate: boolean;
  runtimeAvailable?: boolean;
  onEdit: () => void;
}

export function SequenceTriggerCard({
  trigger,
  canMutate,
  runtimeAvailable = SEQUENCE_RUNTIME_AVAILABLE,
  onEdit,
}: Props): ReactElement {
  const summary = triggerSummary(trigger);
  const isEmpty = trigger == null;
  const actionDescriptionId = useId();
  const actionDescription = !runtimeAvailable
    ? SEQUENCE_RUNTIME_UNAVAILABLE_REASON
    : canMutate
      ? isEmpty
        ? "Pick how subscribers enter this sequence."
        : "Change how subscribers enter this sequence."
      : "Viewer role can't change the trigger.";

  return (
    <div
      className="seq-trigger-card"
      role="region"
      aria-label="Sequence entry trigger"
    >
      <div className="seq-trigger-card-icon" aria-hidden="true">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* Lightning bolt — visual shorthand for "fires when" used
              across the marketing-automation industry (Customer.io,
              Klaviyo, ActiveCampaign all use the same metaphor). */}
          <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
        </svg>
      </div>
      <div className="seq-trigger-card-body">
        <div className="seq-trigger-card-eyebrow">Trigger</div>
        <div className="seq-trigger-card-title">{summary.label}</div>
        {summary.detail ? (
          <div className="seq-trigger-card-detail">{summary.detail}</div>
        ) : null}
        {!runtimeAvailable ? (
          <div className="seq-trigger-warning" role="status">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <span>
              Entry automation is unavailable; any stored trigger is not
              running.
            </span>
          </div>
        ) : isEmpty ? (
          <div className="seq-trigger-warning" role="status" aria-live="polite">
            {/* Inline status chip rather than a Toast — the missing
                trigger is a persistent gap, not a one-shot
                notification, so it needs to stay visible until fixed. */}
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <span>No trigger configured — this sequence cannot start</span>
          </div>
        ) : null}
      </div>
      <div className="seq-trigger-card-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            if (canMutate && runtimeAvailable) onEdit();
          }}
          aria-disabled={!canMutate || !runtimeAvailable || undefined}
          aria-describedby={actionDescriptionId}
        >
          {!runtimeAvailable
            ? "Runtime required"
            : isEmpty
              ? "Configure trigger"
              : "Edit"}
        </button>
        <span id={actionDescriptionId} className="visually-hidden">
          {actionDescription}
        </span>
      </div>
    </div>
  );
}
