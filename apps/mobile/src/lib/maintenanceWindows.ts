/**
 * lib/maintenanceWindows.ts — the pure half of the maintenance-windows card.
 *
 * apps/api/internal/maintenance has had full tenant-admin CRUD for scheduled
 * maintenance windows and no shipping client on any surface: desktop's
 * MaintenanceWindowsPanel.tsx exists but is rendered nowhere. This module
 * carries the shape, the phase derivation, the create-form validation (a
 * mirror of the handler's own three rejections), and the per-row action
 * matrix.
 *
 * WIRE SHAPE (apps/api/internal/maintenance/maintenance.go):
 *   GET    → { windows: [{ id, tenant_id?, title, description, components,
 *                          starts_at, ends_at, status, created_at }] }
 *            newest-first by starts_at, LIMIT 200; includes platform-wide rows
 *            (tenant_id null) the tenant cannot edit.
 *   POST   → { title, description, components, starts_at, ends_at } → 201 {id}
 *            400 missing_title / invalid_window / starts_in_past
 *   PATCH  → { status?: scheduled|in_progress|completed|cancelled, title?, … }
 *   DELETE → soft-cancel (status = cancelled), history survives.
 *
 * Import-free so it runs under node vitest.
 */

export type MaintenanceStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface MaintenanceWindowView {
  id: string;
  title: string;
  description: string;
  components: string[];
  /** ISO timestamps as the server sent them. */
  startsAt: string;
  endsAt: string;
  status: MaintenanceStatus | string;
  /** True for a platform-wide row (tenant_id null): visible, never editable. */
  platform: boolean;
}

export type MaintenancePhase =
  | "active"
  | "upcoming"
  | "past"
  | "completed"
  | "cancelled";

export interface MaintenanceCreateBody {
  title: string;
  description: string;
  components: string[];
  starts_at: string;
  ends_at: string;
}

export interface MaintenanceDraft {
  title: string;
  description: string;
  /** Comma-separated as typed; parsed by parseMaintenanceComponents. */
  components: string;
  startsAt: Date;
  endsAt: Date;
}

export type MaintenanceActionKey = "start" | "complete" | "cancel";

export interface MaintenanceAction {
  key: MaintenanceActionKey;
  label: string;
  /** The PATCH status; undefined for cancel, which uses DELETE. */
  status?: MaintenanceStatus;
  destructive: boolean;
}

/** The handler tolerates a start up to one hour in the past (clock skew). */
export const MAINTENANCE_START_TOLERANCE_MS = 60 * 60_000;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const s = str(entry);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** `{windows: [...]}` → rows a card can render. Rows without an id or times are junk. */
export function normalizeMaintenanceWindows(
  payload: unknown,
): MaintenanceWindowView[] {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(raw.windows) ? raw.windows : [];
  const out: MaintenanceWindowView[] = [];
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>;
    const id = str(r.id);
    const startsAt = str(r.starts_at);
    const endsAt = str(r.ends_at);
    if (!id || !startsAt || !endsAt) continue;
    out.push({
      id,
      title: str(r.title) || "Untitled window",
      description: str(r.description),
      components: strList(r.components),
      startsAt,
      endsAt,
      status: str(r.status) || "scheduled",
      platform: r.tenant_id === null || r.tenant_id === undefined,
    });
  }
  return out;
}

/**
 * A window's phase. Status wins where the operator has spoken (cancelled,
 * completed, in_progress); otherwise the clock decides, exactly as the public
 * status-page handler does.
 */
export function maintenancePhase(
  w: Pick<MaintenanceWindowView, "status" | "startsAt" | "endsAt">,
  now: number = Date.now(),
): MaintenancePhase {
  if (w.status === "cancelled") return "cancelled";
  if (w.status === "completed") return "completed";
  if (w.status === "in_progress") return "active";
  const start = new Date(w.startsAt).getTime();
  const end = new Date(w.endsAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return "past";
  if (now < start) return "upcoming";
  if (now > end) return "past";
  return "active";
}

export function maintenancePhaseLabel(phase: MaintenancePhase): string {
  switch (phase) {
    case "active":
      return "Active";
    case "upcoming":
      return "Upcoming";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Past";
  }
}

/** Pill tone per phase — the word is always rendered too, never colour alone. */
export function maintenancePhaseTone(
  phase: MaintenancePhase,
): "warning" | "info" | "success" | "neutral" {
  switch (phase) {
    case "active":
      return "warning";
    case "upcoming":
      return "info";
    case "completed":
      return "success";
    default:
      return "neutral";
  }
}

export interface MaintenanceGroups {
  active: MaintenanceWindowView[];
  upcoming: MaintenanceWindowView[];
  /** Everything over: past by clock, completed, cancelled — newest first. */
  past: MaintenanceWindowView[];
}

function startMs(w: MaintenanceWindowView): number {
  const n = new Date(w.startsAt).getTime();
  return Number.isNaN(n) ? 0 : n;
}

/** Active and upcoming soonest-first (the next thing that matters on top); past newest-first. */
export function groupMaintenanceWindows(
  windows: MaintenanceWindowView[],
  now: number = Date.now(),
): MaintenanceGroups {
  const groups: MaintenanceGroups = { active: [], upcoming: [], past: [] };
  for (const w of windows) {
    const phase = maintenancePhase(w, now);
    if (phase === "active") groups.active.push(w);
    else if (phase === "upcoming") groups.upcoming.push(w);
    else groups.past.push(w);
  }
  groups.active.sort((a, b) => startMs(a) - startMs(b));
  groups.upcoming.sort((a, b) => startMs(a) - startMs(b));
  groups.past.sort((a, b) => startMs(b) - startMs(a));
  return groups;
}

/** "api, smtp,, api " → ["api", "smtp"]. */
export function parseMaintenanceComponents(text: string): string[] {
  return strList(text.split(","));
}

/** A sensible first draft: the next whole hour, one hour long. */
export function defaultMaintenanceDraft(now: number = Date.now()): MaintenanceDraft {
  const start = new Date(now);
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const end = new Date(start.getTime() + 60 * 60_000);
  return {
    title: "",
    description: "",
    components: "",
    startsAt: start,
    endsAt: end,
  };
}

/**
 * The handler's three rejections, caught before the request: missing_title,
 * invalid_window (end not after start) and starts_in_past (more than an hour
 * ago). Passing yields the exact POST body.
 */
export function validateMaintenanceDraft(
  draft: MaintenanceDraft,
  now: number = Date.now(),
): { ok: true; body: MaintenanceCreateBody } | { ok: false; message: string } {
  const title = draft.title.trim();
  if (!title) return { ok: false, message: "Give the window a title." };
  const start = draft.startsAt.getTime();
  const end = draft.endsAt.getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return { ok: false, message: "Choose when the window starts and ends." };
  }
  if (end <= start) {
    return { ok: false, message: "The window must end after it starts." };
  }
  if (start < now - MAINTENANCE_START_TOLERANCE_MS) {
    return { ok: false, message: "The window must start in the future." };
  }
  return {
    ok: true,
    body: {
      title,
      description: draft.description.trim(),
      components: parseMaintenanceComponents(draft.components),
      starts_at: draft.startsAt.toISOString(),
      ends_at: draft.endsAt.toISOString(),
    },
  };
}

/**
 * What an admin may do to a row. A platform-wide window is not this tenant's
 * to change — the handler's UPDATE is scoped to tenant_id, so a PATCH would
 * silently touch nothing — and a finished or cancelled one is history.
 */
export function maintenanceActionsFor(
  w: Pick<MaintenanceWindowView, "status" | "platform">,
  canAdmin: boolean,
): MaintenanceAction[] {
  if (!canAdmin || w.platform) return [];
  if (w.status === "scheduled") {
    return [
      { key: "start", label: "Start now", status: "in_progress", destructive: false },
      { key: "cancel", label: "Cancel", destructive: true },
    ];
  }
  if (w.status === "in_progress") {
    return [
      { key: "complete", label: "Mark complete", status: "completed", destructive: false },
      { key: "cancel", label: "Cancel", destructive: true },
    ];
  }
  return [];
}

/** The sentence a failed write shows; the server's own words where it has them. */
export function maintenanceErrorMessage(error: {
  status: number;
  code?: string;
  message: string;
}): string {
  if (error.status === 403) {
    return "Only workspace admins can change maintenance windows.";
  }
  if (error.status === 400 && error.message.trim() !== "") {
    return error.message;
  }
  return error.message || "Couldn't update the maintenance window.";
}

/**
 * True when the error means "this reader may not see maintenance windows".
 * The Go mount wraps every verb in RequireScope(ScopeAdmin), which floors a
 * session at admin too, so a lower role's GET is a 403 — a final answer that
 * hides the card, not a transient to retry. 401 is the same answer for a
 * lapsed session (the shell re-authenticates; the card has nothing to add),
 * and 404/501 mean the route is absent on this deployment. A 5xx stays an
 * error the card shows with Retry — the same policy hooks/useSettingsRoles
 * applies to the roles card beside this one.
 */
export function isMaintenanceSurfaceHidden(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  return (
    status === 401 || status === 403 || status === 404 || status === 501
  );
}
