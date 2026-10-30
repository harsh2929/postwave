/**
 * lib/firewallAdmin.ts — the pure half of ADMINISTERING the signup firewall
 * from a phone: the draft diff, the server's bounds, the events/stats wire
 * shapes and the verbatim copy for a surge sweep.
 *
 * lib/platformConfig.ts owns the READ shape (FirewallSettingsView) and
 * api/reputationResponse.ts already flips attack mode alone for the
 * deliverability push. This file is the general case the parity register
 * asked for (docs/mobile-desktop-parity-2026-08-28.md, "Signup-firewall
 * administration"): every setting, the recent events, the counters and the
 * manual sweep — "a signup attack detected off-hours cannot be answered from
 * the phone" was the gap.
 *
 * WIRE SHAPES, read off apps/api/internal/firewall_attack_mode/
 * firewall_attack_mode.go:
 *
 *   PUT  /api/v1/firewall/settings (admin) — UpdateSettingsInput, every field
 *        a POINTER (:347); validation (:376) threshold 0..100, multiplier
 *        2..100, min-per-hour 1..100000; answers the full Settings row.
 *   GET  /api/v1/firewall/events?limit= (viewer) → {events: Event[], count}
 *        Event (:618) {id, form_id, risk_score, action, ip, at, ...}
 *   GET  /api/v1/firewall/stats (viewer) → {last_24h: {accepted, rejected,
 *        observed}, last_7d: {...}}  (:712)
 *   POST /api/v1/firewall/detect (admin) → {flipped}  (:736)
 *
 * Import-free so it runs under node vitest.
 */
import type { FirewallSettingsView } from "./platformConfig";

/** The editable subset of the settings row. */
export interface FirewallDraft {
  attackModeEnabled: boolean;
  autoAttackMode: boolean;
  fingerprintRequired: boolean;
  attackModeThreshold: number;
  surgeMultiplier: number;
  surgeMinPerHour: number;
}

/** Partial PUT body — snake_case, pointer semantics on the server. */
export interface FirewallSettingsPatch {
  attack_mode_enabled?: boolean;
  auto_attack_mode?: boolean;
  fingerprint_required?: boolean;
  attack_mode_threshold?: number;
  surge_multiplier?: number;
  surge_min_per_hour?: number;
}

/** The server's bounds (UpdateSettings, firewall_attack_mode.go:376–388). */
export const FIREWALL_BOUNDS = {
  threshold: { min: 0, max: 100 },
  multiplier: { min: 2, max: 100 },
  minPerHour: { min: 1, max: 100_000 },
} as const;

export function firewallDraftFrom(settings: FirewallSettingsView): FirewallDraft {
  return {
    attackModeEnabled: settings.attackModeEnabled,
    autoAttackMode: settings.autoAttackMode,
    fingerprintRequired: settings.fingerprintRequired,
    attackModeThreshold: settings.attackModeThreshold,
    surgeMultiplier: settings.surgeMultiplier,
    surgeMinPerHour: settings.surgeMinPerHour,
  };
}

/**
 * Diff draft vs server into the partial PUT body; null when nothing changed.
 * Only changed fields travel — a phone must never re-send a threshold somebody
 * tuned at a desk just because the attack-mode switch was flipped.
 */
export function firewallPatch(
  server: FirewallDraft,
  draft: FirewallDraft,
): FirewallSettingsPatch | null {
  const patch: FirewallSettingsPatch = {};
  if (draft.attackModeEnabled !== server.attackModeEnabled) {
    patch.attack_mode_enabled = draft.attackModeEnabled;
  }
  if (draft.autoAttackMode !== server.autoAttackMode) {
    patch.auto_attack_mode = draft.autoAttackMode;
  }
  if (draft.fingerprintRequired !== server.fingerprintRequired) {
    patch.fingerprint_required = draft.fingerprintRequired;
  }
  if (draft.attackModeThreshold !== server.attackModeThreshold) {
    patch.attack_mode_threshold = draft.attackModeThreshold;
  }
  if (draft.surgeMultiplier !== server.surgeMultiplier) {
    patch.surge_multiplier = draft.surgeMultiplier;
  }
  if (draft.surgeMinPerHour !== server.surgeMinPerHour) {
    patch.surge_min_per_hour = draft.surgeMinPerHour;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Mirror of the server's bounds so an obvious typo fails with a field message
 * instead of a generic validation_failed toast. The server stays the authority.
 */
export function validateFirewallDraft(draft: FirewallDraft): string | null {
  const { threshold, multiplier, minPerHour } = FIREWALL_BOUNDS;
  if (
    !Number.isInteger(draft.attackModeThreshold) ||
    draft.attackModeThreshold < threshold.min ||
    draft.attackModeThreshold > threshold.max
  ) {
    return "Block score must be a whole number between 0 and 100.";
  }
  if (
    !Number.isInteger(draft.surgeMultiplier) ||
    draft.surgeMultiplier < multiplier.min ||
    draft.surgeMultiplier > multiplier.max
  ) {
    return "Surge multiplier must be a whole number between 2 and 100.";
  }
  if (
    !Number.isInteger(draft.surgeMinPerHour) ||
    draft.surgeMinPerHour < minPerHour.min ||
    draft.surgeMinPerHour > minPerHour.max
  ) {
    return "Surge minimum per hour must be a whole number between 1 and 100,000.";
  }
  return null;
}

/**
 * A numeric text field's contents as an integer, or null when it is not one.
 * A phone keyboard produces strings; "" and "1.5" both mean "not a valid
 * count", and null lets the caller keep the field's own error rather than
 * coercing to 0 and silently passing the server's lower bound.
 */
export function parseIntField(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

/** The lines a confirm sheet lists for a patch — the user's own choices. */
export function firewallPatchLines(patch: FirewallSettingsPatch): string[] {
  const out: string[] = [];
  if (patch.attack_mode_enabled !== undefined) {
    out.push(`Attack mode: ${patch.attack_mode_enabled ? "on" : "off"}`);
  }
  if (patch.auto_attack_mode !== undefined) {
    out.push(
      `Automatic escalation: ${patch.auto_attack_mode ? "on" : "off"}`,
    );
  }
  if (patch.fingerprint_required !== undefined) {
    out.push(
      `Browser fingerprint: ${patch.fingerprint_required ? "required" : "not required"}`,
    );
  }
  if (patch.attack_mode_threshold !== undefined) {
    out.push(`Block score: ${patch.attack_mode_threshold}`);
  }
  if (patch.surge_multiplier !== undefined) {
    out.push(`Surge multiplier: ${patch.surge_multiplier}×`);
  }
  if (patch.surge_min_per_hour !== undefined) {
    out.push(`Surge minimum per hour: ${patch.surge_min_per_hour}`);
  }
  return out;
}

export interface FirewallEventView {
  id: string;
  /** accepted | rejected | observed — rendered verbatim. */
  action: string;
  riskScore: number;
  ip: string;
  formId: string;
  at: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

/** `{events: [...]}` → rows. An event with no id cannot be keyed and is dropped. */
export function normalizeFirewallEvents(raw: unknown): FirewallEventView[] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(r.events) ? r.events : [];
  const out: FirewallEventView[] = [];
  for (const entry of rows) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const id = str(e.id);
    if (!id) continue;
    out.push({
      id,
      action: str(e.action),
      riskScore: int(e.risk_score),
      ip: str(e.ip),
      formId: str(e.form_id),
      at: str(e.at),
    });
  }
  return out;
}

export interface FirewallWindowCounts {
  accepted: number;
  rejected: number;
  observed: number;
}

export interface FirewallStatsView {
  last24h: FirewallWindowCounts;
  last7d: FirewallWindowCounts;
}

function windowCounts(raw: unknown): FirewallWindowCounts {
  const w = (raw ?? {}) as Record<string, unknown>;
  return {
    accepted: int(w.accepted),
    rejected: int(w.rejected),
    observed: int(w.observed),
  };
}

/**
 * Both windows as numbers. A freshly-provisioned tenant has no rows and the
 * server may omit a window; that reads as zeros, never as a crash on
 * `undefined.rejected` (the same defence desktop's firewall-helpers carries).
 */
export function normalizeFirewallStats(raw: unknown): FirewallStatsView {
  const r =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    last24h: windowCounts(r.last_24h),
    last7d: windowCounts(r.last_7d),
  };
}

/** `{flipped}` off POST /detect. Anything but `true` is "did not flip". */
export function normalizeDetectResult(raw: unknown): boolean {
  return (
    Boolean(raw) &&
    typeof raw === "object" &&
    (raw as Record<string, unknown>).flipped === true
  );
}

/**
 * Verbatim report of `{flipped}` — the same two sentences desktop's
 * firewall-helpers.ts uses, so both clients describe one sweep identically.
 */
export function surgeResultCopy(flipped: boolean): string {
  return flipped
    ? "Surge detected — attack mode was enabled by this check."
    : "No surge detected — settings unchanged.";
}

export type FirewallActionTone = "danger" | "warning" | "success" | "neutral";

/** Pill tone per event action, as desktop colours its badges. */
export function firewallActionTone(action: string): FirewallActionTone {
  switch (action) {
    case "rejected":
      return "danger";
    case "observed":
      return "warning";
    case "accepted":
      return "success";
    default:
      return "neutral";
  }
}

/** One event's detail line: the score, then whatever identifiers exist. */
export function firewallEventDetail(event: FirewallEventView): string {
  const parts = [`risk ${event.riskScore}`];
  if (event.ip) parts.push(event.ip);
  if (event.formId) parts.push(`form ${event.formId}`);
  return parts.join(" · ");
}

/** Accepted / rejected / observed for one window, in the order the server counts. */
export function windowCountsLine(counts: FirewallWindowCounts): string {
  return `${counts.rejected} rejected · ${counts.accepted} accepted · ${counts.observed} observed`;
}
