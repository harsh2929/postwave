// SPDX-License-Identifier: AGPL-3.0-only
//
// board.ts — typed server-side fetch of GET /api/internal/ops/board.
//
// The console renders EXACTLY what the API derives; no client-side state, no
// caching. An unreachable or non-OK API is a distinct, loud result — never an
// empty board that could be mistaken for green. Unknown is not green.

import { loadOpsRuntimeConfig } from "./opsConfig";
import { knownOpsStatusMessage, resolveRunbookHref } from "./opsSecurity";
import { fetchOpsViewJSON } from "./opsViewFetch";
import {
  hasDuplicateKey,
  hasOnlyKeys,
  isBoundedText,
  isCheckID,
  isNonNegativeInteger,
  isRecord,
  isTimestamp,
} from "./viewSchema";

// Danger is an action's blast radius. It decides how the UI ASKS — one click,
// a modal, or type-the-check-id — and nothing else: the server audits, bounds,
// and de-duplicates every invocation regardless of what the client believes.
export type Danger = "safe" | "confirm" | "type_to_confirm";

// ActionMeta mirrors ops.ActionMeta. A card carries one at most: no action
// without a check.
export interface ActionMeta {
  id: string;
  label: string;
  danger: Danger;
  input_hint?: string;
}

// BlockedMeta mirrors ops.BlockedMeta: why a check cannot run, and who can
// change that. Present only on BLOCKED cards.
export interface BlockedMeta {
  reason: string;
  owner: string;
  tracking?: string;
}

// UnwatchedDomain mirrors ops.UnwatchedDomain — one declared coverage surface
// that nothing can currently report on. This is the row that stops the board
// lying by omission, so it is validated exactly as strictly as a Card.
export interface UnwatchedDomain {
  id: string;
  label: string;
  why: string;
  owner: string;
  reason: "no_check" | "all_checks_blocked";
  blocked_by?: string[];
}

// Card mirrors ops.Card (apps/api/internal/ops/handlers.go). `status` is the
// EFFECTIVE status — staleness is derived at read time by the API.
export interface Card {
  id: string;
  group?: string;
  title?: string;
  why: string;
  kind: string;
  severity: string;
  status: string;
  detail?: string;
  remediation: string;
  runbook?: string;
  last_ok_at?: string;
  first_red_at?: string;
  due_at?: string;
  acked_until?: string;
  ack_reason?: string;
  action?: ActionMeta;
  domain?: string;
  owner?: string;
  blocked?: BlockedMeta;
}

// Lane mirrors ops.Lane. Card lanes carry `cards`; AUTOMATIONS is an
// alive/stale summary plus stale IDs; GREEN is a count plus IDs.
export interface Lane {
  name: string;
  cards?: Card[];
  count: number;
  alive?: number;
  stale?: number;
  stale_ids?: string[];
  ids?: string[];
  domains?: UnwatchedDomain[];
}

// Coverage mirrors ops.Coverage: the board's own denominator, computed by the
// API. The console renders it; it never recomputes it.
export interface Coverage {
  declared: number;
  watched: number;
}

export interface BoardResponse {
  generated_at: string;
  lanes: Lane[];
  coverage: Coverage;
}

// The eight lanes, in the only order they are ever rendered.
//
// BLOCKED and UNWATCHED sit directly under the two fire lanes on purpose. They
// are not urgent, but they are the lanes that qualify everything below them: a
// GREEN count means nothing until you know how much of the platform is outside
// the board's field of view. Bury them and the board reads as more complete
// than it is, which is the failure this console exists to prevent.
export const LANE_ORDER = [
  "ON FIRE",
  "NEEDS YOU",
  "BLOCKED",
  "UNWATCHED",
  "CLOCKS",
  "AUTOMATIONS",
  "SNOOZED",
  "GREEN",
] as const;

export type BoardResult =
  | { ok: true; board: BoardResponse }
  | { ok: false; status?: number; message: string };

// fetchBoard fetches the board server-side, forwarding the caller's Cookie so
// the API's platform-operator gate sees the real session. cache: 'no-store' —
// a cached board is a stale board, and staleness handling belongs to the API.
export async function fetchBoard(): Promise<BoardResult> {
  // Shares the SSRF-hardened, cookie-forwarding, bounded fetch every other view
  // uses (opsViewFetch); the board-specific parts — schema validation, runbook
  // resolution, lane completeness — stay here.
  const result = await fetchOpsViewJSON("/api/internal/ops/board");
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
  if (result.status < 200 || result.status >= 300) {
    return {
      ok: false,
      status: result.status,
      message: knownOpsStatusMessage(result.status) ?? "the ops service is unavailable",
    };
  }
  if (!isBoardResponse(result.body)) {
    return { ok: false, status: result.status, message: "the ops service returned invalid data" };
  }
  const board = result.body;

  // Config is valid here (the fetch above already loaded it); reload it for
  // runbook-href resolution. A failure would only happen if env changed
  // mid-request, in which case fail loud rather than render an unresolved link.
  let config;
  try {
    config = loadOpsRuntimeConfig();
  } catch {
    return { ok: false, status: result.status, message: "the ops console is not configured safely" };
  }

  for (const lane of board.lanes) {
    for (const card of lane.cards ?? []) {
      if (!card.runbook) continue;
      const href = resolveRunbookHref(card.runbook, config);
      if (!href) {
        return {
          ok: false,
          status: result.status,
          message: "the ops service returned an invalid runbook link",
        };
      }
      card.runbook = href;
    }
  }

  // A board missing any of the eight lanes is malformed — refuse to render it.
  // Rendering a partial board risks the exact lie this console exists to
  // prevent: an absent red lane reading as an empty (green) one.
  const names = new Set((board.lanes ?? []).map((l) => l.name));
  const missing = LANE_ORDER.filter((n) => !names.has(n));
  if (missing.length > 0) {
    return {
      ok: false,
      status: result.status,
      message: `the ops API returned a malformed board (missing lane(s): ${missing.join(", ")})`,
    };
  }

  return { ok: true, board };
}

export function isBoardResponse(value: unknown): value is BoardResponse {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["generated_at", "lanes", "coverage"]) ||
    !isTimestamp(value.generated_at) ||
    !isCoverage(value.coverage) ||
    !Array.isArray(value.lanes) ||
    value.lanes.length !== LANE_ORDER.length ||
    !value.lanes.every(isLane)
  ) return false;

  const lanes = value.lanes as Lane[];
  return !hasDuplicateKey(lanes, (lane) => lane.name) &&
    LANE_ORDER.every((name) => lanes.some((lane) => lane.name === name));
}

// Coverage is an accusation the board makes about itself, so it is bounded and
// internally consistent or the whole board is refused: watched can never
// exceed declared, and a board that claims otherwise is not one to reason from.
function isCoverage(value: unknown): value is Coverage {
  return isRecord(value) &&
    hasOnlyKeys(value, ["declared", "watched"]) &&
    isNonNegativeInteger(value.declared) &&
    isNonNegativeInteger(value.watched) &&
    value.declared <= 1000 &&
    value.watched <= value.declared;
}

const CARD_LANES = new Set(["ON FIRE", "NEEDS YOU", "BLOCKED", "CLOCKS", "SNOOZED"]);

function isLane(value: unknown): value is Lane {
  if (!isRecord(value) || !isNonNegativeInteger(value.count) || value.count > 500) {
    return false;
  }
  if (typeof value.name !== "string" || !LANE_ORDER.includes(value.name as typeof LANE_ORDER[number])) {
    return false;
  }
  if (CARD_LANES.has(value.name)) {
    if (!hasOnlyKeys(value, ["name", "count"], ["cards"])) return false;
    const cards = value.cards ?? [];
    return Array.isArray(cards) &&
      cards.length === value.count &&
      cards.every(isCard) &&
      !hasDuplicateKey(cards, (card) => (card as Card).id);
  }
  if (value.name === "UNWATCHED") {
    if (!hasOnlyKeys(value, ["name", "count"], ["domains"])) return false;
    const domains = value.domains ?? [];
    return Array.isArray(domains) &&
      domains.length === value.count &&
      domains.every(isUnwatchedDomain) &&
      !hasDuplicateKey(domains, (d) => (d as UnwatchedDomain).id);
  }
  if (value.name === "AUTOMATIONS") {
    if (!hasOnlyKeys(value, ["name", "count"], ["alive", "stale", "stale_ids"])) return false;
    const alive = value.alive ?? 0;
    const stale = value.stale ?? 0;
    const staleIDs = value.stale_ids ?? [];
    return isNonNegativeInteger(alive) &&
      isNonNegativeInteger(stale) &&
      Array.isArray(staleIDs) &&
      staleIDs.length === stale &&
      staleIDs.every(isCheckID) &&
      !hasDuplicateKey(staleIDs, (id) => id) &&
      alive + stale === value.count;
  }
  if (!hasOnlyKeys(value, ["name", "count"], ["ids"])) return false;
  const ids = value.ids ?? [];
  return Array.isArray(ids) &&
    ids.length === value.count &&
    ids.every(isCheckID) &&
    !hasDuplicateKey(ids, (id) => id);
}


// An UNWATCHED row is rendered as an accusation ("nothing is watching this"),
// so it is bounded and shape-checked like every other rendered field: a
// malformed row must fail the whole board rather than render as an empty
// coverage gap, which would read as full coverage.
function isUnwatchedDomain(value: unknown): value is UnwatchedDomain {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "label", "why", "owner", "reason"], ["blocked_by"]) ||
    !isCheckID(value.id) ||
    !isBoundedText(value.label, 256, 1024) ||
    !isBoundedText(value.why, 4096, 16384) ||
    !isBoundedText(value.owner, 128, 512) ||
    (value.reason !== "no_check" && value.reason !== "all_checks_blocked")
  ) return false;
  if (value.blocked_by === undefined) return true;
  return Array.isArray(value.blocked_by) &&
    value.blocked_by.length <= 32 &&
    value.blocked_by.every((reason) => isBoundedText(reason, 1024, 4096));
}

function isBlockedMeta(value: unknown): value is BlockedMeta {
  return isRecord(value) &&
    hasOnlyKeys(value, ["reason", "owner"], ["tracking"]) &&
    isBoundedText(value.reason, 1024, 4096) &&
    isBoundedText(value.owner, 128, 512) &&
    optionalText(value.tracking, 2048, 8192);
}

function isCard(value: unknown): value is Card {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      ["id", "why", "kind", "severity", "status", "remediation"],
      [
        "group", "title", "detail", "runbook", "last_ok_at", "first_red_at",
        "due_at", "acked_until", "ack_reason", "action", "domain", "owner",
        "blocked",
      ],
    ) ||
    !isCheckID(value.id) ||
    !isBoundedText(value.why, 4096, 16384) ||
    (value.kind !== "evaluated" && value.kind !== "heartbeat" && value.kind !== "manual") ||
    (value.severity !== "critical" && value.severity !== "high" && value.severity !== "routine") ||
    (value.status !== "ok" && value.status !== "warn" && value.status !== "red" &&
      value.status !== "stale" && value.status !== "due" &&
      value.status !== "blocked") ||
    !isBoundedText(value.remediation, 4096, 16384) ||
    !optionalText(value.group, 128, 512) ||
    !optionalText(value.title, 256, 1024) ||
    !optionalText(value.detail, 4096, 16384) ||
    !optionalText(value.runbook, 2048, 8192) ||
    !optionalText(value.ack_reason, 4096, 16384) ||
    !optionalTimestamp(value.last_ok_at) ||
    !optionalTimestamp(value.first_red_at) ||
    !optionalTimestamp(value.due_at) ||
    !optionalTimestamp(value.acked_until) ||
    (value.ack_reason !== undefined && value.acked_until === undefined) ||
    !optionalText(value.domain, 128, 512) ||
    !optionalText(value.owner, 128, 512) ||
    (value.action !== undefined && !isAction(value.action)) ||
    (value.blocked !== undefined && !isBlockedMeta(value.blocked))
  ) return false;
  return true;
}

function optionalText(
  value: unknown,
  maximumCodePoints: number,
  maximumBytes: number,
): boolean {
  return value === undefined || isBoundedText(value, maximumCodePoints, maximumBytes);
}

function optionalTimestamp(value: unknown): boolean {
  return value === undefined || isTimestamp(value);
}

function isAction(value: unknown): value is ActionMeta {
  return isRecord(value) &&
    hasOnlyKeys(value, ["id", "label", "danger"], ["input_hint"]) &&
    isBoundedText(value.id, 128, 512) &&
    isBoundedText(value.label, 256, 1024) &&
    (value.danger === "safe" || value.danger === "confirm" || value.danger === "type_to_confirm") &&
    optionalText(value.input_hint, 1024, 4096);
}

// formatAge renders the magnitude of a duration the way an operator reads it:
// minutes under an hour ("42m"), hours under two days ("19h"), days beyond
// ("8d"). Used as "red 19h" (age since first_red_at) and "due in 3d".
export function formatAge(fromISO: string, toISO: string): string {
  const ms = Math.abs(new Date(toISO).getTime() - new Date(fromISO).getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
