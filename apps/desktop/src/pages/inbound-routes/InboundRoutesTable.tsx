/** Semantic route ordering table with equivalent pointer and keyboard controls. */

import {
  Fragment,
  type ReactElement,
  type ReactNode,
  useId,
  useState,
} from "react";

import { HeroEmptyState } from "../../components/HeroEmptyState";
import {
  formatInboundRouteAbsolute,
  formatInboundRouteRelative,
} from "../../components/inbound/inbound-route-time";
import type { InboundRoute, InboundRouteAction } from "../../lib/api-client";
import { HERO } from "../../lib/heroAssets";
import { inboundActionKindSpec } from "./action-specs";

export function InboundRoutesTable({
  rows,
  loading,
  canAdmin,
  onCreate,
  onEdit,
  onDelete,
  onToggle,
  onMove,
  onDuplicate,
  onReorder,
  activeOperations,
}: {
  rows: InboundRoute[] | null;
  loading: boolean;
  canAdmin: boolean;
  onCreate: () => void;
  onEdit: (route: InboundRoute) => void;
  onDelete: (route: InboundRoute) => void;
  onToggle: (route: InboundRoute) => void;
  onMove: (route: InboundRoute, direction: -1 | 1) => void;
  onDuplicate: (route: InboundRoute) => void;
  onReorder: (sourceId: string, targetId: string, placeBefore: boolean) => void;
  activeOperations: ReadonlySet<string>;
}): ReactElement {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    before: boolean;
  } | null>(null);
  const tableLabelId = useId();
  const tableDescriptionId = useId();

  if (loading && rows === null) return <InboundRoutesTableLoading />;
  if (rows?.length === 0) {
    return (
      <HeroEmptyState
        tone="sand"
        eyebrow="Routing"
        title="No inbound routes yet"
        subtitle="Create an ordered rule to match inbound mail and run a deliberate action pipeline."
        primaryCta={
          canAdmin ? { label: "Create route", onClick: onCreate } : undefined
        }
        imageSrc={HERO.inboundRoutes}
        imageAlt="Envelopes being sorted into trays"
      />
    );
  }

  return (
    <section className="inbound-routes-table" aria-labelledby={tableLabelId}>
      <div className="visually-hidden">
        <h3 id={tableLabelId}>Ordered inbound route rules</h3>
        <p id={tableDescriptionId}>
          Routes are evaluated from the lowest priority number to the highest.
          Administrators can reorder with the earlier and later buttons or by
          dragging the handle.
        </p>
      </div>
      <div
        className="inbound-routes-table-scroll"
        role="region"
        aria-labelledby={tableLabelId}
        aria-describedby={tableDescriptionId}
        // Keyboard users need a focusable boundary for horizontal panning.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
      >
        <table className="data-table">
          <caption className="visually-hidden">
            Inbound route priority order
          </caption>
          <thead>
            <tr>
              <th scope="col">Priority</th>
              <th scope="col">Name</th>
              <th scope="col">Matchers</th>
              <th scope="col">Actions</th>
              <th scope="col">Status</th>
              <th scope="col">Last matched</th>
              <th scope="col" className="numeric">
                Matches
              </th>
              <th scope="col">Route actions</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((route, index) => (
              <InboundRouteRow
                key={route.id}
                route={route}
                canAdmin={canAdmin}
                canMoveUp={index > 0}
                canMoveDown={index < (rows?.length ?? 0) - 1}
                routeBusy={
                  activeOperations.has(`route:${route.id}:toggle`) ||
                  activeOperations.has(`route:${route.id}:duplicate`)
                }
                reorderBusy={activeOperations.has("routes:reorder")}
                isDragging={dragId === route.id}
                dropIndicator={
                  dropTarget?.id === route.id
                    ? dropTarget.before
                      ? "top"
                      : "bottom"
                    : null
                }
                onEdit={() => onEdit(route)}
                onDelete={() => onDelete(route)}
                onToggle={() => onToggle(route)}
                onMoveUp={() => onMove(route, -1)}
                onMoveDown={() => onMove(route, 1)}
                onDuplicate={() => onDuplicate(route)}
                onDragStart={() => setDragId(route.id)}
                onDragOverRow={(before) => {
                  if (dragId && dragId !== route.id) {
                    setDropTarget({ id: route.id, before });
                  }
                }}
                onDropRow={() => {
                  if (dragId && dropTarget && dragId !== dropTarget.id) {
                    onReorder(dragId, dropTarget.id, dropTarget.before);
                  }
                  setDragId(null);
                  setDropTarget(null);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropTarget(null);
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function InboundRouteRow({
  route,
  canAdmin,
  canMoveUp,
  canMoveDown,
  routeBusy,
  reorderBusy,
  isDragging,
  dropIndicator,
  onEdit,
  onDelete,
  onToggle,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  onDragStart,
  onDragOverRow,
  onDropRow,
  onDragEnd,
}: {
  route: InboundRoute;
  canAdmin: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  routeBusy: boolean;
  reorderBusy: boolean;
  isDragging: boolean;
  dropIndicator: "top" | "bottom" | null;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDuplicate: () => void;
  onDragStart: () => void;
  onDragOverRow: (placeBefore: boolean) => void;
  onDropRow: () => void;
  onDragEnd: () => void;
}): ReactElement {
  const descriptionId = useId();
  const moveEarlierId = `${descriptionId}-earlier`;
  const moveLaterId = `${descriptionId}-later`;
  const routeLabel = route.name || "unnamed route";
  const unavailable = routeBusy || reorderBusy;
  const earlierUnavailable = !canMoveUp || unavailable;
  const laterUnavailable = !canMoveDown || unavailable;
  const busyReason = routeBusy
    ? `Wait for the current change to ${routeLabel} to finish.`
    : reorderBusy
      ? "Wait for route reordering to finish."
      : null;

  return (
    <tr
      data-dragging={isDragging || undefined}
      data-drop-indicator={dropIndicator ?? undefined}
      onDragOver={(event) => {
        if (!canAdmin || unavailable) return;
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        onDragOverRow(event.clientY - bounds.top < bounds.height / 2);
      }}
      onDrop={(event) => {
        if (!canAdmin || unavailable) return;
        event.preventDefault();
        onDropRow();
      }}
    >
      <td>
        <div className="inbound-route-priority">
          {canAdmin ? (
            <span
              className="inbound-route-drag-handle"
              draggable={!unavailable}
              onDragStart={(event) => {
                event.dataTransfer.setData("text/plain", route.id);
                event.dataTransfer.effectAllowed = "move";
                onDragStart();
              }}
              onDragEnd={onDragEnd}
              aria-hidden="true"
            >
              ⠿
            </span>
          ) : null}
          <span className="tabular">{route.priority}</span>
          {canAdmin ? (
            <div className="inbound-route-move-actions">
              <button
                type="button"
                className="link-button pw-discoverable-unavailable"
                aria-disabled={earlierUnavailable || undefined}
                aria-describedby={moveEarlierId}
                aria-label={`Move ${routeLabel} earlier`}
                onClick={() => {
                  if (!earlierUnavailable) onMoveUp();
                }}
              >
                ▲
              </button>
              <button
                type="button"
                className="link-button pw-discoverable-unavailable"
                aria-disabled={laterUnavailable || undefined}
                aria-describedby={moveLaterId}
                aria-label={`Move ${routeLabel} later`}
                onClick={() => {
                  if (!laterUnavailable) onMoveDown();
                }}
              >
                ▼
              </button>
              <span id={moveEarlierId} className="visually-hidden">
                {busyReason ??
                  (canMoveUp
                    ? "Moves this rule earlier in evaluation order."
                    : `${routeLabel} is already first.`)}
              </span>
              <span id={moveLaterId} className="visually-hidden">
                {busyReason ??
                  (canMoveDown
                    ? "Moves this rule later in evaluation order."
                    : `${routeLabel} is already last.`)}
              </span>
            </div>
          ) : null}
        </div>
      </td>
      <th scope="row">
        <button
          type="button"
          className="link-button inbound-route-name"
          aria-disabled={unavailable || undefined}
          aria-describedby={descriptionId}
          onClick={() => {
            if (!unavailable) onEdit();
          }}
        >
          {route.name || <em>(unnamed)</em>}
        </button>
        {route.stop_on_match ? (
          <span className="badge">Stop after match</span>
        ) : null}
      </th>
      <td>
        <MatcherSummary route={route} />
      </td>
      <td>
        <ActionSummary actions={route.actions} />
      </td>
      <td>
        <span className={`badge ${route.enabled ? "success" : "warning"}`}>
          {route.enabled ? "Enabled" : "Disabled"}
        </span>
      </td>
      <td>
        {route.last_matched_at ? (
          <time className="inbound-route-time" dateTime={route.last_matched_at}>
            <span>{formatInboundRouteRelative(route.last_matched_at)}</span>
            <span>{formatInboundRouteAbsolute(route.last_matched_at)}</span>
          </time>
        ) : (
          <span className="muted">Never</span>
        )}
      </td>
      <td className="numeric tabular">{route.match_count.toLocaleString()}</td>
      <td>
        <div className="inbound-route-row-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost pw-discoverable-unavailable"
            aria-disabled={unavailable || undefined}
            aria-describedby={descriptionId}
            onClick={() => {
              if (!unavailable) onEdit();
            }}
          >
            {canAdmin ? "Edit" : "View"}
          </button>
          {canAdmin ? (
            <>
              <button
                type="button"
                className="btn btn-sm btn-ghost pw-discoverable-unavailable"
                aria-disabled={unavailable || undefined}
                aria-describedby={descriptionId}
                onClick={() => {
                  if (!unavailable) onToggle();
                }}
              >
                {route.enabled ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost pw-discoverable-unavailable"
                aria-disabled={unavailable || undefined}
                aria-describedby={descriptionId}
                onClick={() => {
                  if (!unavailable) onDuplicate();
                }}
              >
                Duplicate
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost btn-danger pw-discoverable-unavailable"
                aria-disabled={unavailable || undefined}
                aria-describedby={descriptionId}
                onClick={() => {
                  if (!unavailable) onDelete();
                }}
              >
                Delete
              </button>
            </>
          ) : null}
        </div>
        <span id={descriptionId} className="visually-hidden" role="status">
          {busyReason ?? `${routeLabel} is ready.`}
        </span>
      </td>
    </tr>
  );
}

function MatcherSummary({ route }: { route: InboundRoute }): ReactElement {
  const parts: ReactNode[] = [];
  if (route.match_recipient && route.match_recipient !== "*") {
    parts.push(<code key="recipient">to {route.match_recipient}</code>);
  }
  if (route.match_subject_prefix) {
    parts.push(
      <code key="subject">subject ^{route.match_subject_prefix}</code>,
    );
  }
  if (route.match_from_domain) {
    parts.push(<code key="sender">from @{route.match_from_domain}</code>);
  }
  if (!parts.length) return <span className="muted">Catch-all</span>;
  return (
    <span className="inbound-route-summary">
      {parts.map((part, index) => (
        <Fragment key={index}>{part}</Fragment>
      ))}
    </span>
  );
}

function ActionSummary({
  actions,
}: {
  actions: InboundRouteAction[];
}): ReactElement {
  if (!actions.length) return <span className="muted">No actions</span>;
  return (
    <span className="inbound-route-summary">
      {actions.map((action, index) => (
        <span key={`${action.kind}:${index}`} className="badge">
          {inboundActionKindSpec(action.kind).label}
          {action.kind === "tag" && action.tag ? `: ${action.tag}` : ""}
          {action.kind === "automation_trigger" && action.event_type
            ? `: ${action.event_type}`
            : ""}
          {action.kind === "forward" && action.to ? ` → ${action.to}` : ""}
        </span>
      ))}
    </span>
  );
}

function InboundRoutesTableLoading(): ReactElement {
  return (
    <div className="inbound-routes-table-scroll" role="status">
      <table className="data-table" aria-busy="true">
        <caption className="visually-hidden">Loading inbound routes</caption>
        <thead>
          <tr>
            <th scope="col">Priority</th>
            <th scope="col">Name</th>
            <th scope="col">Matchers</th>
            <th scope="col">Actions</th>
            <th scope="col">Status</th>
            <th scope="col">Last matched</th>
            <th scope="col">Matches</th>
            <th scope="col">Route actions</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={8} className="inbound-routes-loading-cell">
              <span className="spinner" aria-hidden="true" />
              Verifying inbound routes…
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
