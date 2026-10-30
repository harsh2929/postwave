/**
 * The widget snapshot's PURE payload contract — no storage, no platform.
 *
 * Split out of lib/widgetData.ts because that file owns the App Group
 * transaction (opt-in marker, ready tombstone, verified purge) and this one
 * owns the shape of what goes into it. Keeping them apart also means the rules
 * below can be unit-tested without importing `react-native` or
 * `@bacons/apple-targets`, neither of which loads in a node test environment.
 *
 * Everything here is re-exported from lib/widgetData.ts, which is still the
 * only module callers should need to know about.
 */
import { utf8ByteLength } from "./utf8";

export const MAX_WIDGET_WORKSPACE_BYTES = 128;
export const MAX_WIDGET_INTEGER = 2_147_483_647;

/**
 * ABSENCE IS NOT ZERO (DASHBOARD#72).
 *
 * `ExtensionStorage` stores an Int, and an Int has no way to say "the server
 * did not report this". So every unmeasured figure used to arrive at the widget
 * as a 0, and the widget then had to guess what a 0 meant. It guessed
 * differently for the two shapes, and both guesses were wrong:
 *
 *   - COUNTS were drawn as "0". A workspace whose stats payload omitted
 *     `subscribers_total` — the exact case `pickSubscribersTotal` returns null
 *     for — published "Subscribers 0" to somebody's home screen. That is a
 *     fabricated measurement, and it is the same class of lie the pending count
 *     already refuses to tell (see `readPublishedWidgetPending`).
 *   - The OPEN RATE was drawn as an em-dash, because native `pct()` treated
 *     `<= 0` as "no data". So a workspace that genuinely achieved 0% opens on
 *     its last send — the single situation an operator most needs to notice —
 *     was hidden behind the same dash as a missing field.
 *
 * The fix is one boolean per metric, published beside it, so the reader never
 * has to infer meaning from the value. `pending` gets no marker because it
 * already has a stronger guarantee: BOTH writers (useWidgetMirror and the
 * background task) refuse to publish a pending count they did not measure, so a
 * published snapshot's pending is measured by construction.
 *
 * WHY A NEW KEY RATHER THAN A SENTINEL OR A SCHEMA BUMP. A sentinel (-1) would
 * be rejected by the native `0...100` / `0...maxWidgetInteger` range guards and
 * purge the whole snapshot; a schema bump would do the same thing to any reader
 * older than the writer. JS ships over the air and the two Swift readers ship
 * through the App Store, so writer-newer-than-reader is a real state. An extra
 * key degrades in both directions instead: an older reader ignores it, and a
 * newer reader treats its absence as "this build predates the marker", falling
 * back to the only reading that build could have meant
 * (`measuredFlag` in targets/widget/index.swift).
 */
export const WIDGET_MEASURED_KEYS = [
  "pw_widget_subs_known",
  "pw_widget_open_rate_known",
  "pw_widget_sent30d_known",
] as const;

export type WidgetSnapshotInput = {
  subscribers: number | null | undefined;
  openRate: number | null | undefined; // 0..100 (percentage)
  sent30d: number | null | undefined;
  pending: number | null | undefined;
  workspace: string | null | undefined;
};

export type WidgetPayload = {
  subs: number;
  subsKnown: boolean;
  openRate: number;
  openRateKnown: boolean;
  sent30d: number;
  sent30dKnown: boolean;
  pending: number;
  workspace: string;
};

/**
 * Whether a raw dashboard value is a MEASUREMENT rather than an absence.
 *
 * null/undefined is what every `pick*` helper in `useDashboard` returns when
 * the field is missing from the stats payload. A non-finite number is a
 * malformed one, and a negative count or percentage cannot have been measured
 * by anything — all three are absences, and the value written beside the
 * marker is then a clamped placeholder the reader must discard.
 *
 * A genuine 0 is a measurement and reads as one. That is the whole point.
 */
export function isMeasured(v: number | null | undefined): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * The bounded Int written beside the marker. Its value is only meaningful when
 * `isMeasured` agreed; otherwise it is a placeholder.
 */
function intOrZero(v: number | null | undefined): number {
  if (!isMeasured(v) || (v as number) <= 0) return 0;
  return Math.min(MAX_WIDGET_INTEGER, Math.round(v as number));
}

function clampPct(v: number | null | undefined): number {
  if (!isMeasured(v)) return 0;
  const value = v as number;
  if (value > 100) return 100;
  // ExtensionStorage stores numbers as Int and the widget renders a whole
  // percentage, so sub-percent precision would be misleading.
  return Math.round(value);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let out = "";
  for (const character of value) {
    if (utf8ByteLength(out + character) > maxBytes) break;
    out += character;
  }
  return out;
}

/** Clamp raw dashboard values to the bounded native storage contract. */
export function buildWidgetPayload(input: WidgetSnapshotInput): WidgetPayload {
  const normalizedWorkspace = (input.workspace || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const workspace = truncateUtf8(
    normalizedWorkspace || "Moosewave",
    MAX_WIDGET_WORKSPACE_BYTES,
  );
  return {
    subs: intOrZero(input.subscribers),
    subsKnown: isMeasured(input.subscribers),
    openRate: clampPct(input.openRate),
    openRateKnown: isMeasured(input.openRate),
    sent30d: intOrZero(input.sent30d),
    sent30dKnown: isMeasured(input.sent30d),
    pending: intOrZero(input.pending),
    workspace: workspace || "Moosewave",
  };
}
