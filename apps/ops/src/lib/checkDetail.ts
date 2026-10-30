// SPDX-License-Identifier: AGPL-3.0-only
//
// checkDetail.ts — one check, plus what it has actually been doing.
//
// The board answers "is this red". It cannot answer the two questions that
// decide what an operator does next:
//
//   - has this ever been green? A check red since the day it was written is
//     usually a wrong threshold, not an outage.
//   - is it flapping? Repeated crossings are a measurement bug, and treating
//     them as an incident spends the team's attention on the wrong thing.
//
// ops_check_history has recorded every transition since migration 1700 and
// nothing has ever read it. This does.

import type { Card } from "./board";
import { fetchOpsViewJSON, viewStatusMessage } from "./opsViewFetch";
import {
  hasOnlyKeys,
  isBoundedText,
  isCheckID,
  isNonNegativeInteger,
  isRecord,
  isTimestamp,
} from "./viewSchema";

export interface HistoryEntry {
  check_id: string;
  from: string;
  to: string;
  detail?: string;
  at: string;
}

export interface TickEntry {
  check_id: string;
  operator: string;
  note: string;
  ticked_at: string;
}

export interface CheckDetail {
  card: Card;
  history: HistoryEntry[];
  ticks?: TickEntry[];
  flap_count: number;
  flap_window_hours: number;
}

export type CheckDetailResult =
  | { ok: true; detail: CheckDetail }
  | { ok: false; status?: number; message: string };

export async function fetchCheckDetail(checkId: string): Promise<CheckDetailResult> {
  // The id lands in a forwarded path, so it is validated against the same
  // CHECK_ID shape the board and the action proxy use. An id like
  // "../../v1/subscribers" would otherwise aim the operator's cookie at a
  // different endpoint.
  if (!isCheckID(checkId)) {
    return { ok: false, message: "that is not a valid check id" };
  }
  const result = await fetchOpsViewJSON(
    `/api/internal/ops/checks/${encodeURIComponent(checkId)}`,
  );
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      message:
        result.kind === "configuration"
          ? "the ops console is not configured safely"
          : result.kind === "invalid"
            ? "the ops service returned invalid data"
            : "the ops service is unavailable",
    };
  }
  if (result.status === 404) {
    return { ok: false, status: 404, message: "no such check" };
  }
  if (result.status < 200 || result.status >= 300) {
    return {
      ok: false,
      status: result.status,
      message: viewStatusMessage(result.status, "this check"),
    };
  }
  if (!isCheckDetail(result.body)) {
    return { ok: false, status: result.status, message: "the ops service returned invalid data" };
  }
  return { ok: true, detail: result.body };
}

const STATUSES = new Set(["ok", "warn", "red", "stale", "due", "blocked", "unknown"]);

export function isCheckDetail(value: unknown): value is CheckDetail {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["card", "history", "flap_count", "flap_window_hours"], ["ticks"]) ||
    !isRecord(value.card) ||
    !isNonNegativeInteger(value.flap_count) ||
    !isNonNegativeInteger(value.flap_window_hours) ||
    !Array.isArray(value.history) ||
    value.history.length > 500 ||
    !value.history.every(isHistoryEntry)
  ) return false;
  if (value.ticks === undefined) return true;
  return Array.isArray(value.ticks) &&
    value.ticks.length <= 200 &&
    value.ticks.every(isTickEntry);
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  return isRecord(value) &&
    hasOnlyKeys(value, ["check_id", "from", "to", "at"], ["detail"]) &&
    isCheckID(value.check_id) &&
    typeof value.from === "string" && STATUSES.has(value.from) &&
    typeof value.to === "string" && STATUSES.has(value.to) &&
    isTimestamp(value.at) &&
    (value.detail === undefined || isBoundedText(value.detail, 4096, 16384));
}

function isTickEntry(value: unknown): value is TickEntry {
  return isRecord(value) &&
    hasOnlyKeys(value, ["check_id", "operator", "note", "ticked_at"]) &&
    isCheckID(value.check_id) &&
    isBoundedText(value.operator, 320, 1024) &&
    isBoundedText(value.note, 4096, 16384) &&
    isTimestamp(value.ticked_at);
}

// verdict turns the timeline into the sentence an operator needs. The raw
// numbers invite the wrong reading: eight crossings in a day is almost never
// eight incidents.
export function verdict(detail: CheckDetail): string {
  const { flap_count: flaps, flap_window_hours: hours, history, card } = detail;
  if (history.length === 0) {
    return card.status === "ok"
      ? "No recorded transitions — steady since it was first observed."
      : "No recorded transitions. This check has never been anything other than what it is now, which usually means the threshold is wrong rather than the platform.";
  }
  if (flaps >= 4) {
    return `${flaps} transitions in ${hours}h. That is flapping, and a flapping check is usually a threshold sitting exactly where the signal lives — fix the check before treating this as an incident.`;
  }
  if (flaps === 0) {
    return `Stable for at least ${hours}h. Whatever this is, it is not intermittent.`;
  }
  return `${flaps} transition${flaps === 1 ? "" : "s"} in the last ${hours}h.`;
}
