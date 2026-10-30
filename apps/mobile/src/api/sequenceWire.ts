/**
 * api/sequenceWire.ts — the Voice service's sequence WIRE SHAPES.
 *
 * Split out of api/sequences.ts, which had grown past its source budget: the
 * transport there is now about twenty lines of SDK calls wrapped around a
 * hundred and fifty of type declarations, and the two change for entirely
 * different reasons. Splitting on that seam is also what keeps these shapes
 * IMPORT-FREE — nothing here reaches react-native — so the canvas converters
 * and the list view can use them from a node test.
 *
 * Every shape was read off the Go/service source, not off openapi.json. The
 * per-field notes that explain WHY a field exists (decode-only legacy fields,
 * the `description` field that is a guaranteed 400, the `active`/`paused`
 * statuses the handler refuses) moved with the declarations they annotate.
 */

/**
 * Wire-format step shape persisted by the Voice service. The mobile canvas
 * builder converts back and forth via `wireToCanvas` / `canvasToWire`.
 */
/** A/B arm on an email step (services/voice EmailConfig.Variants). */
export interface SequenceEmailVariantWire {
  key: string;
  subject: string;
  body: string;
  body_html?: string;
  weight_bp?: number;
}

export interface SequenceStepWire {
  type: "email" | "delay" | "condition" | "tag_add" | "tag_remove" | "exit";
  position: number;
  email?: {
    subject: string;
    body: string;
    body_html?: string;
    body_mjml?: string;
    delay_seconds?: number;
    template_id?: string;
    variants?: SequenceEmailVariantWire[];
  };
  delay?: {
    seconds: number;
    value?: number;
    unit?: "minutes" | "hours" | "days";
  };
  condition?: {
    predicate: string;
    value?: string;
    yes_branch: SequenceStepWire[];
    no_branch: SequenceStepWire[];
  };
  tag?: { tag: string };
  // Legacy flat fields remain decode-only for sequences stored before v0.3.
  //
  // These are also the shape of a `GeneratedEmail` row in the sequence's
  // `emails` projection (services/voice/internal/generation/types.go:28), which
  // the detail screen falls back to seeding from when `steps` is empty. Every
  // field EmailConfig can hold must be declared here or it is silently dropped
  // on the way into the canvas — and the server's PATCH sets `Emails = nil`
  // whenever a `steps` array is sent, so the legacy projection is not a backup.
  subject?: string;
  body?: string;
  body_html?: string;
  body_mjml?: string;
  delay_seconds?: number;
  template_id?: string;
  delay_value?: number;
  delay_unit?: "minutes" | "hours" | "days";
  interval_days?: number;
  delay_days?: number;
  /** Legacy flat predicate. Decode-only and deliberately widened to `string`
   *  so an unrecognised value is reported as unsupported, never coerced. */
  condition_type?: string;
  condition_value?: string;
  yes_branch?: SequenceStepWire[];
  no_branch?: SequenceStepWire[];
}

/**
 * Entry trigger stored on the sequence body. Mirrors the desktop union in
 * apps/desktop/src/lib/api/campaign-sequence-operations.ts:398 — a journey
 * preview without its entry condition cannot say WHO the journey applies to.
 */
export type SequenceTriggerKind =
  | "list_subscribe"
  | "segment_match"
  | "custom_event"
  | "schedule"
  | "tag_added"
  | "tag_removed";

export interface SequenceTriggerWire {
  kind: SequenceTriggerKind | (string & {});
  list_id?: number | string;
  segment_id?: string;
  event_name?: string;
  cron?: string;
  run_at?: string;
  tag_name?: string;
}

/** Sequence-level success criterion (voice_sequences.goal, migration 0395). */
export interface SequenceGoalWire {
  kind: "open" | "click" | "conversion" | (string & {});
  exit_on_goal?: boolean;
}

export interface SequenceListItem {
  id: string;
  name?: string;
  status?: string;
  updated_at?: string;
  steps?: number | SequenceStepWire[];
  emails?: unknown[];
  active_runs?: number;
}

export interface SequenceDetailWire {
  id: string;
  /** Positive server revision required in If-Match on every mutation. */
  version?: number;
  name?: string;
  status?: string;
  description?: string;
  emails?: unknown[];
  steps?: SequenceStepWire[];
  /** Entry condition. Absent/null means no trigger is configured. */
  trigger?: SequenceTriggerWire | null;
  goal?: SequenceGoalWire | null;
  /** >= 1 enables stuck-participant detection; 0/absent disables it. */
  stuck_after_days?: number;
  created_at?: string;
  updated_at?: string;
}

/**
 * PATCH body. Deliberately WITHOUT `description`: the Voice service decodes
 * `updateSequenceRequest` with `DisallowUnknownFields`
 * (services/voice/internal/handlers/sequences.go:870 →
 * httpbody.DecodeJSONStrict), and that struct has no description field. A
 * patch carrying one is rejected 400 `json: unknown field "description"`
 * before any of the other fields are looked at.
 *
 * `status` is kept because `draft` / `archived` are accepted authoring values;
 * `active` and `paused` are NOT — the handler answers 409 with "live sequence
 * statuses are unavailable because the execution runtime is not qualified"
 * (sequences.go:906 → writeSequenceStatusError).
 */
export interface SequenceUpdatePatch {
  name?: string;
  status?: string;
  emails?: unknown[];
  steps?: SequenceStepWire[];
}

export type SequenceListResponse =
  | SequenceListItem[]
  | {
      items?: SequenceListItem[];
      data?: SequenceListItem[];
      sequences?: SequenceListItem[];
    };

export function normalizeSequenceListResponse(
  response: SequenceListResponse | null | undefined,
): SequenceListItem[] {
  if (Array.isArray(response)) return response;
  return response?.items ?? response?.data ?? response?.sequences ?? [];
}

/* ------------------------------------------------------------------ *
 * Participants + stuck report
 *
 * Both are DERIVED from `sequence_funnel_events`, the only per-(sequence,
 * subscriber) table the platform writes (services/voice/internal/handlers/
 * participants.go:1-10). With no qualified delivery runtime nothing writes
 * that table, so an empty list is the honest, expected answer today — and the
 * zero-states must say so instead of implying a load failure.
 * ------------------------------------------------------------------ */

export interface SequenceParticipantWire {
  /** Empty when the subscriber row is gone; such rows surface as "exited". */
  subscriber_id: string;
  email: string;
  /** active | completed | completed_goal | exited */
  status: string;
  current_step: number;
  entered_at: string;
  last_event_at: string;
}

export interface SequenceParticipantsPage {
  items: SequenceParticipantWire[];
  total: number;
  page: number;
  per_page: number;
}

export type SequenceParticipantStatus =
  | "active"
  | "completed"
  | "completed_goal"
  | "exited";

export interface StuckParticipantWire {
  subscriber_id: string;
  email: string;
  current_step: number;
  idle_days: number;
}

export interface StuckParticipantsReport {
  items: StuckParticipantWire[];
  threshold_days: number;
}

