/**
 * lib/sequenceSnapshot.ts — minimised offline projections for Sequences and
 * Voice.
 *
 * Why a projection rather than "cache the response": `queryClient.ts`'s
 * `shouldPersistQuery` returns false for EVERYTHING by design, and directs
 * cold-offline screens to write an explicit, minimised vault projection
 * instead. The vault also silently drops any payload over ~24 KB
 * (secureVault MAX_BYTES), so an un-minimised sequence — whose email bodies
 * can each run to several KB — would write nothing at all and the operator
 * would find an empty screen on a plane with no explanation.
 *
 * What survives, and why:
 *   - The list keeps exactly the five fields the row renders.
 *   - The detail keeps the TOPOLOGY: type, order, subject, delay, condition,
 *     tag, branch structure, variant count. Email BODIES are dropped — the
 *     read-only canvas never renders one (StepNode shows `stepSummary`, which
 *     reads `subject` and never `body`), and they are the entire size problem.
 *   - `version` is deliberately DROPPED from the detail projection. The detail
 *     screen seeds its canvas from whatever it is given, and `updateSequence`
 *     fails closed without a positive server version, so a save can never be
 *     built on top of a snapshot. That is the intended behaviour: a body-less
 *     projection must never become a PATCH that replaces real bodies with
 *     nothing.
 *
 * Import-free (house rule: vitest runs in a node environment), so every cap
 * below is directly testable. Rows are accepted structurally.
 */

/** Hard ceilings. Chosen so a hostile payload cannot exceed the vault's
 *  ~24 KB envelope, with room to spare for the wrapper metadata. */
export const SNAPSHOT_LIST_ROW_LIMIT = 80;
export const SNAPSHOT_STEP_LIMIT = 80;
export const SNAPSHOT_TEXT_LIMIT = 160;
/** Names dominate the list projection's size; 80 chars is well past the point
 *  a row can display them anyway (two lines at 15pt). */
export const SNAPSHOT_NAME_LIMIT = 80;
export const SNAPSHOT_BRANCH_DEPTH_LIMIT = 6;
export const SNAPSHOT_VOICE_SAMPLES = 3;
export const SNAPSHOT_VOICE_SAMPLE_CHARS = 400;

function text(value: unknown, limit = SNAPSHOT_TEXT_LIMIT): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/* ------------------------------------------------------------------ *
 * List
 * ------------------------------------------------------------------ */

export interface SnapshotListRow {
  id: string;
  name?: string;
  status?: string;
  updated_at?: string;
  /** Pre-counted so the projection never carries a step array. */
  steps?: number;
  active_runs?: number;
}

export interface SnapshotListRowInput {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  updated_at?: unknown;
  steps?: unknown;
  emails?: unknown;
  active_runs?: unknown;
}

/**
 * `stepCount` is injected rather than recomputed so the snapshot row and the
 * live row can never disagree about what "4 steps" means — the list screen
 * already owns that definition in `sequenceRowStepCount`.
 */
export function projectSequenceListSnapshot(
  rows: readonly SnapshotListRowInput[] | null | undefined,
  stepCount: (row: SnapshotListRowInput) => number,
): SnapshotListRow[] {
  if (!Array.isArray(rows)) return [];
  const out: SnapshotListRow[] = [];
  for (const row of rows) {
    if (out.length >= SNAPSHOT_LIST_ROW_LIMIT) break;
    const id = text(row?.id, 120);
    if (!id) continue;
    const name = text(row?.name, SNAPSHOT_NAME_LIMIT);
    const status = text(row?.status, 40);
    const updatedAt = text(row?.updated_at, 40);
    const activeRuns = finiteNumber(row?.active_runs);
    out.push({
      id,
      ...(name ? { name } : {}),
      ...(status ? { status } : {}),
      ...(updatedAt ? { updated_at: updatedAt } : {}),
      steps: stepCount(row),
      ...(activeRuns !== undefined ? { active_runs: activeRuns } : {}),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Detail
 * ------------------------------------------------------------------ */

export type SnapshotStepType =
  | "email"
  | "delay"
  | "condition"
  | "tag_add"
  | "tag_remove"
  | "exit";

/**
 * The projection emits the SERVER'S WIRE SHAPE, not a second private format.
 * That is deliberate: the detail screen decodes with `wireToCanvas`, so an
 * offline read goes through exactly the same codec — and therefore renders
 * exactly the same topology — as a live one. A bespoke snapshot shape would
 * need a second decoder, and the two would drift.
 *
 * `body` is always `""`. The read-only canvas renders `stepSummary`, which
 * reads `subject` and never `body`, and bodies are the entire size problem.
 * The projection deliberately carries no `version`, so this stripped tree can
 * never become a PATCH (see `projectSequenceDetailSnapshot`).
 */
export interface SnapshotWireStep {
  type: SnapshotStepType;
  position: number;
  email?: {
    subject: string;
    body: string;
    variants?: { key: string; subject: string; body: string }[];
  };
  delay?: {
    seconds: number;
    value?: number;
    unit?: "minutes" | "hours" | "days";
  };
  condition?: {
    predicate: string;
    value?: string;
    yes_branch: SnapshotWireStep[];
    no_branch: SnapshotWireStep[];
  };
  tag?: { tag: string };
}

export interface SnapshotDetail {
  id: string;
  name?: string;
  status?: string;
  description?: string;
  updated_at?: string;
  stuck_after_days?: number;
  trigger?: unknown;
  goal?: unknown;
  steps: SnapshotWireStep[];
  /** Marker the screen branches on. Never a server field. */
  snapshot: true;
}

interface StepInput {
  type?: unknown;
  position?: unknown;
  email?: {
    subject?: unknown;
    delay_seconds?: unknown;
    variants?: unknown;
  } | null;
  delay?: { seconds?: unknown; value?: unknown; unit?: unknown } | null;
  condition?: {
    predicate?: unknown;
    value?: unknown;
    yes_branch?: unknown;
    no_branch?: unknown;
  } | null;
  tag?: { tag?: unknown } | null;
  // Legacy flat shape (pre-v0.3 rows, and the `emails` projection).
  subject?: unknown;
  delay_seconds?: unknown;
  delay_value?: unknown;
  delay_unit?: unknown;
  interval_days?: unknown;
  delay_days?: unknown;
  condition_type?: unknown;
  condition_value?: unknown;
  yes_branch?: unknown;
  no_branch?: unknown;
  variants?: unknown;
}

const STEP_TYPES: readonly string[] = [
  "email",
  "delay",
  "condition",
  "tag_add",
  "tag_remove",
  "exit",
];

/** Same inference `wireToCanvas` applies, so the offline canvas cannot show a
 *  different node type from the live one for the same row. */
function stepTypeOf(s: StepInput): SnapshotStepType {
  if (typeof s.type === "string" && STEP_TYPES.includes(s.type)) {
    return s.type as SnapshotStepType;
  }
  return s.email || s.subject !== undefined ? "email" : "delay";
}

function delayUnit(value: unknown): "minutes" | "hours" | "days" | undefined {
  return value === "minutes" || value === "hours" || value === "days"
    ? value
    : undefined;
}

function projectEmail(s: StepInput): NonNullable<SnapshotWireStep["email"]> {
  const rawVariants = Array.isArray(s.email?.variants)
    ? s.email.variants
    : Array.isArray(s.variants)
      ? s.variants
      : null;
  const variants = rawVariants
    ? rawVariants.map((v, i) => {
        const arm = (v ?? {}) as Record<string, unknown>;
        return {
          key: text(arm.key, 24) ?? String(i),
          subject: text(arm.subject) ?? "",
          // Bodies never survive the projection; see the module header.
          body: "",
        };
      })
    : null;
  return {
    subject: text(s.email?.subject ?? s.subject) ?? "",
    body: "",
    ...(variants ? { variants } : {}),
  };
}

function projectDelay(s: StepInput): NonNullable<SnapshotWireStep["delay"]> {
  const nested = s.delay;
  const legacyDays =
    finiteNumber(s.interval_days) ?? finiteNumber(s.delay_days) ?? 0;
  const seconds =
    finiteNumber(nested?.seconds) ??
    finiteNumber(s.delay_seconds) ??
    legacyDays * 86_400;
  const value = finiteNumber(nested?.value) ?? finiteNumber(s.delay_value);
  const unit = delayUnit(nested?.unit) ?? delayUnit(s.delay_unit);
  return {
    seconds,
    ...(value !== undefined ? { value } : {}),
    ...(unit ? { unit } : {}),
  };
}

function projectCondition(
  s: StepInput,
  budget: { left: number },
  depth: number,
): NonNullable<SnapshotWireStep["condition"]> {
  const value = text(s.condition?.value ?? s.condition_value, 80);
  return {
    predicate: text(s.condition?.predicate ?? s.condition_type, 48) ?? "",
    ...(value !== undefined ? { value } : {}),
    yes_branch: projectSteps(
      s.condition?.yes_branch ?? s.yes_branch,
      budget,
      depth + 1,
    ),
    no_branch: projectSteps(
      s.condition?.no_branch ?? s.no_branch,
      budget,
      depth + 1,
    ),
  };
}

function projectStep(
  s: StepInput,
  fallbackPosition: number,
  budget: { left: number },
  depth: number,
): SnapshotWireStep {
  const type = stepTypeOf(s);
  const node: SnapshotWireStep = {
    type,
    position: finiteNumber(s.position) ?? fallbackPosition,
  };
  if (type === "email") node.email = projectEmail(s);
  else if (type === "delay") node.delay = projectDelay(s);
  else if (type === "condition") {
    node.condition = projectCondition(s, budget, depth);
  } else if (type === "tag_add" || type === "tag_remove") {
    node.tag = { tag: text(s.tag?.tag, 64) ?? "" };
  }
  return node;
}

function projectSteps(
  steps: unknown,
  budget: { left: number },
  depth: number,
): SnapshotWireStep[] {
  if (!Array.isArray(steps) || depth > SNAPSHOT_BRANCH_DEPTH_LIMIT) return [];
  const out: SnapshotWireStep[] = [];
  for (const raw of steps) {
    if (budget.left <= 0) break;
    if (!raw) continue;
    budget.left -= 1;
    out.push(projectStep(raw as StepInput, out.length, budget, depth));
  }
  return out;
}

interface DetailInput {
  id?: unknown;
  /** Read and DELIBERATELY discarded — see the module header. Declared so a
   *  caller passing a whole server row is not a type error. */
  version?: unknown;
  name?: unknown;
  status?: unknown;
  description?: unknown;
  updated_at?: unknown;
  stuck_after_days?: unknown;
  trigger?: unknown;
  goal?: unknown;
  steps?: unknown;
  emails?: unknown;
}

export function projectSequenceDetailSnapshot(
  detail: DetailInput | null | undefined,
): SnapshotDetail | null {
  const id = text(detail?.id, 120);
  if (!id) return null;
  const budget = { left: SNAPSHOT_STEP_LIMIT };
  // Same precedence the detail screen seeds its canvas with ([id].tsx:158):
  // a PRESENT-BUT-EMPTY `steps` array still falls back to `emails`, because
  // that is exactly the shape a pre-v0.3 row has.
  const source =
    Array.isArray(detail?.steps) && detail.steps.length > 0
      ? detail.steps
      : Array.isArray(detail?.emails)
        ? detail.emails
        : [];
  const name = text(detail?.name, SNAPSHOT_NAME_LIMIT);
  const status = text(detail?.status, 40);
  const description = text(detail?.description, 240);
  const updatedAt = text(detail?.updated_at, 40);
  const stuck = finiteNumber(detail?.stuck_after_days);
  return {
    id,
    ...(name ? { name } : {}),
    ...(status ? { status } : {}),
    ...(description ? { description } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    ...(stuck !== undefined ? { stuck_after_days: stuck } : {}),
    ...(detail?.trigger ? { trigger: detail.trigger } : {}),
    ...(detail?.goal ? { goal: detail.goal } : {}),
    steps: projectSteps(source, budget, 0),
    snapshot: true,
  };
}

/* ------------------------------------------------------------------ *
 * Voice profile
 * ------------------------------------------------------------------ */

interface VoiceInput {
  representative_samples?: unknown;
  [key: string]: unknown;
}

/**
 * The measured profile is mostly small numeric sections; the one unbounded
 * part is `representative_samples`, which carries whole passages of the
 * tenant's own copy. Cap the count and the length rather than dropping the
 * section — a sample or three is exactly what makes the offline read useful.
 */
export function projectVoiceProfileSnapshot<T extends VoiceInput>(
  profile: T | null | undefined,
): T | null {
  if (!profile || typeof profile !== "object") return null;
  const samples = Array.isArray(profile.representative_samples)
    ? profile.representative_samples
        .slice(0, SNAPSHOT_VOICE_SAMPLES)
        .map((sample) => {
          const s = (sample ?? {}) as Record<string, unknown>;
          const body = text(s.text, SNAPSHOT_VOICE_SAMPLE_CHARS);
          return { ...s, ...(body ? { text: body } : { text: "" }) };
        })
    : undefined;
  return {
    ...profile,
    ...(samples ? { representative_samples: samples } : {}),
  };
}
