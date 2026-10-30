/**
 * StatCard — one tile in the Dashboard stat grid.
 *
 * Value + delta + sparkline + anomaly pill. Stateless. When `onClick`
 * is provided, the card lifts on hover and behaves as a button
 * (Enter/Space activate). The anomaly pill is rendered top-right so
 * it doesn't compete with the value's visual weight.
 */

import { type ReactElement, useId } from "react";

import { type DeltaResult } from "../../lib/dashboard-helpers";

import { Sparkline, type SparklineTone } from "./Sparkline";
import { Icon } from "../Icon";

interface Props {
  label: string;
  value: string;
  delta?: DeltaResult | null;
  /** Truthful reason a rate cannot be computed from verified denominator data. */
  unavailableContext?: string;
  comparisonLabel?: string;
  /** Which direction represents an improvement for semantic delta colour. */
  preferredDirection?: "increase" | "decrease";
  /** Daily-bucketed values from the server. Empty array → no sparkline. */
  sparkline?: number[];
  /** Tones the sparkline + delta. Pass `bad` for bounces, `good` for opens, etc. */
  tone?: SparklineTone;
  /** When true, renders a small "spike" pill in the top-right corner. */
  anomaly?: boolean;
  onClick?: () => void;
  /** Short reason shown in the anomaly tooltip. */
  anomalyReason?: string;
  /** PR 4: drag-reorder. When set, renders a grip handle and wires
   *  HTML5 native drag events. Parent reorders by key. */
  draggable?: boolean;
  cardKey?: string;
  onDragStart?: (key: string) => void;
  onDragEnter?: (key: string) => void;
  onDragEnd?: () => void;
  isDragging?: boolean;
  isDropTarget?: boolean;
  /** Keyboard/switch alternative to drag-reordering. */
  reorderPosition?: number;
  reorderTotal?: number;
  onMoveEarlier?: () => void;
  onMoveLater?: () => void;
  /** Full-surface wiring (2026-06): "Ask why" — opens the AI anomaly
   *  brief for this metric. Only passed for whitelisted brief metrics
   *  (opens/clicks/bounces); the click never bubbles into the card's
   *  drill-down onClick. */
  onAskWhy?: () => void;
  /** Visible/accessible copy must name what the backing explanation analyzes. */
  askWhyLabel?: string;
  askWhyAriaLabel?: string;
}

export function StatCard({
  label,
  value,
  delta,
  unavailableContext,
  comparisonLabel = "vs previous period",
  preferredDirection = "increase",
  sparkline,
  tone = "neutral",
  anomaly = false,
  onClick,
  anomalyReason,
  draggable = false,
  cardKey,
  onDragStart,
  onDragEnter,
  onDragEnd,
  isDragging = false,
  isDropTarget = false,
  reorderPosition,
  reorderTotal,
  onMoveEarlier,
  onMoveLater,
  onAskWhy,
  askWhyLabel = "Ask why",
  askWhyAriaLabel = `Ask why — explain ${label} with AI`,
}: Props): ReactElement {
  const reorderHelpId = useId();
  const positionDescriptionId = useId();
  const anomalyReasonId = useId();
  const interactive = typeof onClick === "function";
  const hasPosition = reorderPosition != null && reorderTotal != null;
  const deltaSentiment =
    !delta || delta.dir === "flat"
      ? "neutral"
      : (delta.dir === "up") === (preferredDirection === "increase")
        ? "positive"
        : "negative";
  const cls = ["stat-card", "dash-stat-card"];
  if (interactive) cls.push("is-clickable");
  if (anomaly) cls.push("has-anomaly");
  if (isDragging) cls.push("is-dragging");
  if (isDropTarget) cls.push("is-drop-target");

  return (
    <div
      className={cls.join(" ")}
      role="listitem"
      aria-describedby={hasPosition ? positionDescriptionId : undefined}
      aria-posinset={reorderPosition}
      aria-setsize={reorderTotal}
      draggable={draggable && !!cardKey}
      onDragStart={(e) => {
        if (!draggable || !cardKey) return;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/x-pw-card", cardKey);
        onDragStart?.(cardKey);
      }}
      onDragOver={(e) => {
        if (!draggable) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDragEnter={() => {
        if (!draggable || !cardKey) return;
        onDragEnter?.(cardKey);
      }}
      onDragEnd={() => {
        if (!draggable) return;
        onDragEnd?.();
      }}
    >
      {hasPosition ? (
        <span id={positionDescriptionId} className="visually-hidden">
          {label}, position {reorderPosition} of {reorderTotal}
        </span>
      ) : null}
      {draggable ? (
        <div
          className="dash-drag-handle"
          role="group"
          aria-label={`Reorder ${label}`}
          aria-describedby={reorderHelpId}
        >
          <Icon name="grip-vertical" size={12} />
          <span id={reorderHelpId} className="dash-drag-help">
            Drag or use arrows
          </span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-label={`Move ${label} earlier`}
            disabled={!onMoveEarlier}
            draggable={false}
            onClick={() => onMoveEarlier?.()}
          >
            <Icon name="chevron-left" size={11} />
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-label={`Move ${label} later`}
            disabled={!onMoveLater}
            draggable={false}
            onClick={() => onMoveLater?.()}
          >
            <Icon name="chevron-right" size={11} />
          </button>
        </div>
      ) : null}
      <div className="stat-label">
        {interactive ? (
          <button
            type="button"
            className="stat-card-open"
            aria-label={`Open ${label} details`}
            onClick={onClick}
          >
            {label}
          </button>
        ) : (
          label
        )}
        {anomaly ? (
          <>
            <span
              className="dash-anomaly-pill"
              aria-label="Anomaly detected"
              aria-describedby={anomalyReasonId}
            >
              <Icon name="alert-triangle" size={11} /> spike
            </span>
            <span id={anomalyReasonId} className="dash-anomaly-reason">
              {anomalyReason ?? "Unusual activity versus the trailing window"}
            </span>
          </>
        ) : null}
        {onAskWhy ? (
          <button
            type="button"
            className="btn btn-sm dash-ask-why"
            aria-label={askWhyAriaLabel}
            onClick={(e) => {
              e.stopPropagation();
              onAskWhy();
            }}
            onKeyDown={(e) => {
              // Don't let Enter/Space bubble into the card's drill-down.
              e.stopPropagation();
            }}
            draggable={false}
          >
            {askWhyLabel}
          </button>
        ) : null}
      </div>
      <div className="stat-value tabular">{value}</div>
      {delta ? (
        <div className={`stat-delta ${delta.dir} is-${deltaSentiment} tabular`}>
          {/* When the value is unchanged the helper emits text="—" — avoid
              "— —" by skipping the arrow glyph in the flat case. */}
          {delta.dir === "flat" ? (
            <span>{delta.text}</span>
          ) : (
            <>
              <Icon
                name={delta.dir === "up" ? "chevron-up" : "chevron-down"}
                size={11}
              />{" "}
              {delta.text}
            </>
          )}{" "}
          <span className="stat-delta-context">{comparisonLabel}</span>
        </div>
      ) : unavailableContext ? (
        <div className="stat-evidence-status">{unavailableContext}</div>
      ) : (
        <div className="stat-delta subtle">—</div>
      )}
      {sparkline && sparkline.length > 0 ? (
        <Sparkline
          values={sparkline}
          tone={tone}
          ariaLabel={`${label} trend`}
        />
      ) : null}
    </div>
  );
}
