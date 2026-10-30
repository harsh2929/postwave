/**
 * SequenceParticipantsDrawer — right-side slideover that lists the
 * subscribers currently enrolled in a sequence (active + completed +
 * exited).
 *
 * Why: the list-row's `active_runs` count is the only existing surface
 * that tells marketers "people are in this sequence." The detail view
 * has zero visibility into WHO is in step N or who already finished.
 * This is the single biggest debugging gap — Customer.io's "campaign
 * subscribers" tab, Klaviyo's "flow subscribers", and Iterable's
 * "journey participants" all expose exactly this view.
 *
 * Data flow: api.listSequenceParticipants → paginate / sort / filter on
 * the wire (GET /api/v1/voice/sequences/{id}/participants). Row click
 * jumps the user to the Subscribers section so the subscriber profile
 * is one tab away (we deliberately don't open a nested slideover inside
 * this drawer — that pattern fails ergonomics).
 *
 * Older gateways may 404 the route, which renders the unavailable notice.
 * A 503 from the current voice service is a retryable database outage and
 * keeps the normal Retry action. Per the project's strict no-fixtures rule,
 * the drawer never synthesizes participants.
 */
import { type ReactElement, type ReactNode } from "react";

import {
  type SequenceParticipant,
  type SequenceParticipantSort,
} from "../../lib/api-client";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import { setSection } from "../../lib/store";
import { SlideoverShell } from "../SlideoverShell";
import { SequenceStuckPanel } from "./SequenceStuckPanel";
import type { CanvasStep } from "./types";
import {
  SEQUENCE_PARTICIPANTS_PAGE_SIZE,
  type SequenceParticipantsController,
  type SequenceParticipantsStatusFilter,
  type SequenceParticipantsView,
  useSequenceParticipantsController,
} from "./useSequenceParticipantsController";

interface Props {
  open: boolean;
  onClose: () => void;
  sequenceId: string | number;
  /**
   * Live canvas step list so we can resolve `current_step` (a 1-based
   * position) into a human label without a second backend round-trip.
   * The drawer falls back to the server-supplied `current_step_label`
   * when the canvas has been edited and positions no longer align.
   */
  steps: CanvasStep[];
  /**
   * Active-runs hint pulled from the parent list-row when known. Drives
   * the drawer's loading-state total so the count doesn't flicker
   * between 0 and the real number. Optional — undefined means "no
   * hint, wait for the server".
   */
  activeRunsHint?: number;
  /**
   * The sequence's stuck_after_days setting (0 = off) from the canvas
   * state — drives the Stuck tab's pre-emptive "set a threshold first"
   * state so we don't fire a guaranteed-400 fetch.
   */
  stuckAfterDays?: number;
}

/**
 * Sort option presented in the drawer toolbar. Pairs a server-side key
 * with a human label; the array order is the dropdown's render order.
 */
const SORT_OPTIONS: ReadonlyArray<{
  key: SequenceParticipantSort;
  label: string;
}> = [
  { key: "entered_at_desc", label: "Newest first" },
  { key: "entered_at_asc", label: "Oldest first" },
  { key: "current_step_desc", label: "Furthest along" },
  { key: "current_step_asc", label: "Just started" },
];

const STATUS_FILTERS: ReadonlyArray<{
  key: SequenceParticipantsStatusFilter;
  label: string;
}> = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "completed", label: "Completed" },
  { key: "completed_goal", label: "Goal met" },
  { key: "exited", label: "Exited" },
];

function statusBadge(status: string | undefined): ReactElement {
  // Match the status badge tones the rest of the app uses (see
  // .badge.success in styles.css). Unknown / missing status renders as
  // a neutral pill so we never imply a state we can't prove.
  switch (status) {
    case "active":
      return <span className="badge success">Active</span>;
    case "completed":
      return <span className="badge success">Completed</span>;
    case "completed_goal":
      // Roadmap goals: participant met the sequence's open/click goal.
      // The engine can't exit them mid-flight yet (exit_on_goal is
      // advisory) — this badge is the honest reporting surface.
      return <span className="badge success">Goal met</span>;
    case "exited":
      return <span className="badge">Exited</span>;
    default:
      return <span className="badge">—</span>;
  }
}

function fmtRelative(s: string | undefined | null): string {
  if (!s) return "—";
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  const delta = Date.now() - t;
  if (delta < 0) return "in the future";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

/**
 * Resolve a 1-based step position into a human label. Tries the
 * server-supplied label first (it may carry richer context like the
 * email subject), then falls back to the canvas step at that position.
 * Returns null when no label can be derived — the row then prints just
 * the step number.
 */
export function resolveStepLabel(
  participant: SequenceParticipant,
  steps: CanvasStep[],
): string | null {
  if (participant.current_step_label) return participant.current_step_label;
  const pos = participant.current_step;
  if (pos == null || pos < 1) return null;
  // The index fallback is only sound for LINEAR sequences. `steps` is
  // the flat TOP-LEVEL canvas list, but a participant's `current_step`
  // position counts along their actual path — which descends into a
  // condition's yes/no branch steps. For a branching sequence,
  // steps[pos - 1] would therefore label a branch participant with
  // whatever top-level step happens to sit at that index (confidently
  // wrong). When any condition step exists, return null and let the row
  // render a plain "Step N" instead.
  if (steps.some((s) => s.type === "condition")) return null;
  // D07-templates-seq-automations#7: the backend's current_step is an EMAIL
  // ordinal — max(position)+1 over per-email funnel rows, i.e. "received
  // email N" — NOT an index into the flat canvas, which also contains
  // delay/tag/exit nodes. Indexing the flat list mislabels a participant who
  // just received the 2nd email of a [email, delay, email, …] sequence as the
  // delay node at flat index 1. Map the ordinal onto the Nth email step.
  const emailSteps = steps.filter((s) => s.type === "email");
  const step = emailSteps[pos - 1];
  if (!step) return null;
  const subject = step.subject?.trim();
  return subject ? `Email · ${subject}` : "Email";
}

export function SequenceParticipantsDrawer({
  open,
  onClose,
  sequenceId,
  steps,
  activeRunsHint,
  stuckAfterDays,
}: Props): ReactElement | null {
  const controller = useSequenceParticipantsController({
    open,
    sequenceId,
    activeRunsHint,
    stuckAfterDays,
  });
  if (!open) return null;
  return (
    <SequenceParticipantsPresentation
      controller={controller}
      onClose={onClose}
      sequenceId={sequenceId}
      steps={steps}
      stuckAfterDays={stuckAfterDays}
    />
  );
}

const DRAWER_VIEWS = [
  { value: "participants", label: "Participants" },
  { value: "stuck", label: "Stuck" },
] as const;

function DrawerViewTabs({
  children,
  controller,
}: {
  children: ReactNode;
  controller: SequenceParticipantsController;
}): ReactElement {
  const view = controller.view;
  const tabs = useTabsInteraction<SequenceParticipantsView>({
    value: view,
    items: DRAWER_VIEWS,
    onChange: controller.setView,
  });
  return (
    <>
      <div
        ref={tabs.listRef}
        {...tabs.listProps}
        aria-label="Drawer view"
        style={{ display: "inline-flex", gap: 4, marginBottom: 8 }}
      >
        {DRAWER_VIEWS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            {...tabs.getTabProps(value)}
            className={"btn btn-sm" + (view === value ? " btn-primary" : "")}
          >
            {label}
          </button>
        ))}
      </div>
      {DRAWER_VIEWS.map(({ value }) => (
        <div key={value} {...tabs.getPanelProps(value)}>
          {view === value ? children : null}
        </div>
      ))}
    </>
  );
}

function ParticipantsToolbar({
  controller,
}: {
  controller: SequenceParticipantsController;
}): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
        marginBottom: 4,
      }}
    >
      <div
        role="group"
        aria-label="Filter by status"
        style={{ display: "inline-flex", gap: 4 }}
      >
        {STATUS_FILTERS.map((filter) => {
          const active = controller.statusFilter === filter.key;
          return (
            <button
              key={filter.key}
              type="button"
              aria-pressed={active}
              className={"btn btn-sm" + (active ? " btn-primary" : "")}
              onClick={() => controller.changeStatusFilter(filter.key)}
            >
              {filter.label}
            </button>
          );
        })}
      </div>
      <span style={{ flex: 1 }} />
      <label
        htmlFor="seq-participants-sort"
        className="muted"
        style={{ fontSize: 11 }}
      >
        Sort
      </label>
      <select
        id="seq-participants-sort"
        className="input"
        style={{ width: "auto", padding: "4px 8px", fontSize: 12 }}
        value={controller.sort}
        onChange={(event) =>
          controller.changeSort(
            event.target.value as SequenceParticipantSort,
          )
        }
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ParticipantsEmptyState({
  hasSteps,
  statusFilter,
}: {
  hasSteps: boolean;
  statusFilter: SequenceParticipantsStatusFilter;
}): ReactElement {
  const title = !hasSteps
    ? "No steps in this sequence yet"
    : statusFilter === "all"
      ? "No subscribers in this sequence yet"
      : `No ${statusFilter} subscribers`;
  const detail = !hasSteps
    ? "Drag steps from the palette to build a flow. Subscribers can't enroll until at least one email step exists."
    : statusFilter === "all"
      ? "Connect a trigger — a list subscription, product event, or schedule — so subscribers can enroll into this flow."
      : "Try the All filter to see subscribers in other states.";
  return (
    <div
      role="status"
      style={{
        padding: "32px 16px",
        textAlign: "center",
        border: "1px dashed var(--pw-border-soft)",
        borderRadius: "var(--pw-radius-md)",
        background: "var(--pw-bg-elev)",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
        {detail}
      </div>
    </div>
  );
}

function ParticipantRow({
  participant,
  steps,
  onOpen,
}: {
  participant: SequenceParticipant;
  steps: CanvasStep[];
  onOpen: () => void;
}): ReactElement {
  const stepLabel = resolveStepLabel(participant, steps);
  const stepCell = participant.current_step
    ? `Step ${participant.current_step}${stepLabel ? ` · ${stepLabel}` : ""}`
    : stepLabel ?? "—";
  return (
    <li style={{ listStyle: "none" }}>
      <button
        type="button"
        className="list-row"
        aria-label={`Open profile for ${participant.email}`}
        style={{
          cursor: "pointer",
          display: "block",
          padding: 12,
          width: "100%",
          textAlign: "left",
        }}
        onClick={onOpen}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {participant.email}
            </div>
            <div
              className="muted"
              style={{
                fontSize: 12,
                marginTop: 2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={stepCell}
            >
              {stepCell}
            </div>
            <div
              className="muted"
              style={{ fontSize: 11, marginTop: 4, display: "flex", gap: 12 }}
            >
              <span title={participant.entered_at ?? undefined}>
                Entered {fmtRelative(participant.entered_at)}
              </span>
              <span title={participant.last_event_at ?? undefined}>
                Last event {fmtRelative(participant.last_event_at)}
              </span>
            </div>
          </div>
          <div style={{ flexShrink: 0 }}>
            {statusBadge(participant.status)}
          </div>
        </div>
      </button>
    </li>
  );
}

function ParticipantsContent({
  controller,
  steps,
  onClose,
}: {
  controller: SequenceParticipantsController;
  steps: CanvasStep[];
  onClose: () => void;
}): ReactElement {
  if (controller.err) {
    return (
      <div
        className="notice"
        role={controller.err.unavailable ? "status" : "alert"}
        style={{ marginTop: 8 }}
      >
        <span>
          {controller.err.unavailable
            ? "The participants list isn't available on this server — it needs a voice service with the /participants endpoint and a Postgres-backed enrollment store. Upgrade the deployment to enable this view."
            : `Couldn't load participants: ${controller.err.message}`}
        </span>
        {!controller.err.unavailable ? (
          <button type="button" className="btn btn-sm" onClick={controller.retry}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }
  if (controller.loading && !controller.data) {
    return (
      <div
        className="step-list"
        role="status"
        aria-label="Loading sequence participants"
        aria-busy="true"
      >
        {[0, 1, 2, 3, 4].map((index) => (
          <div key={index} className="skel" style={{ height: 56 }} />
        ))}
      </div>
    );
  }
  if (controller.participants.length === 0) {
    return (
      <ParticipantsEmptyState
        hasSteps={steps.length > 0}
        statusFilter={controller.statusFilter}
      />
    );
  }
  return (
    <ul
      className="step-list"
      aria-label="Subscribers in this sequence"
      style={{ display: "flex", flexDirection: "column", gap: 6 }}
    >
      {controller.participants.map((participant) => (
        <ParticipantRow
          key={`${participant.subscriber_id}-${participant.current_step ?? 0}`}
          participant={participant}
          steps={steps}
          onOpen={() => {
            setSection("subscribers");
            onClose();
          }}
        />
      ))}
    </ul>
  );
}

function ParticipantsPagination({
  controller,
}: {
  controller: SequenceParticipantsController;
}): ReactElement | null {
  if (!controller.data || controller.total <= SEQUENCE_PARTICIPANTS_PAGE_SIZE) {
    return null;
  }
  return (
    <div
      role="navigation"
      aria-label="Sequence participants pages"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: 12,
        paddingTop: 12,
        borderTop: "1px solid var(--pw-border-soft)",
      }}
    >
      <button
        type="button"
        className="btn btn-sm"
        disabled={controller.loading || controller.page <= 1}
        onClick={controller.previousPage}
      >
        ← Prev
      </button>
      <span className="muted" style={{ fontSize: 12 }}>
        Page {controller.page} of {controller.totalPages}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={
          controller.loading || controller.page >= controller.totalPages
        }
        onClick={controller.nextPage}
      >
        Next →
      </button>
    </div>
  );
}

function ParticipantsPanel({
  controller,
  steps,
  onClose,
}: {
  controller: SequenceParticipantsController;
  steps: CanvasStep[];
  onClose: () => void;
}): ReactElement {
  return (
    <>
      <ParticipantsToolbar controller={controller} />
      <ParticipantsContent
        controller={controller}
        steps={steps}
        onClose={onClose}
      />
      <ParticipantsPagination controller={controller} />
    </>
  );
}

function SequenceParticipantsPresentation({
  controller,
  onClose,
  sequenceId,
  steps,
  stuckAfterDays,
}: Omit<Props, "open" | "activeRunsHint"> & {
  controller: SequenceParticipantsController;
}): ReactElement {
  return (
    <SlideoverShell
      open
      onClose={onClose}
      size="lg"
      eyebrow="Sequence"
      title="Subscribers in this sequence"
      subtitle={controller.subtitle}
    >
      <DrawerViewTabs controller={controller}>
        {controller.view === "stuck" ? (
          <SequenceStuckPanel
            sequenceId={sequenceId}
            stuckAfterDays={stuckAfterDays ?? 0}
            onNavigate={onClose}
          />
        ) : (
          <ParticipantsPanel
            controller={controller}
            steps={steps}
            onClose={onClose}
          />
        )}
      </DrawerViewTabs>
    </SlideoverShell>
  );
}
