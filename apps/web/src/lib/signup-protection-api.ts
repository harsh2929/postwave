/**
 * lib/signup-protection-api.ts — preset segments, signup firewall, maintenance
 * windows.
 *
 * Four paths were reached by desktop and by no web file.
 *
 * THE FIREWALL REPORTS `observed` ALONGSIDE `accepted` AND `rejected`, and the
 * three are not a partition. `observed` is everything the firewall saw;
 * accepted and rejected are what it decided. A signup that was observed and
 * neither accepted nor rejected is one the firewall did not rule on — and
 * presenting accepted+rejected as the total hides exactly that case.
 *
 * COVERAGE: this module wires the complete firewall surface plus the related
 * reference reads:
 *   /api/v1/firewall/stats
 *   /api/v1/firewall/settings
 *   /api/v1/firewall/events
 *   /api/v1/firewall/detect
 *   /api/v1/maintenance-windows
 *   /api/v1/preset-segments
 */
import { api } from "@/lib/api";

export interface PresetSegment {
  key: string;
  label: string;
  description?: string;
  /** May be absent until computed. */
  count?: number | null;
}

export interface FirewallWindow {
  observed: number;
  accepted: number;
  rejected: number;
}

export interface FirewallStats {
  last_24h: FirewallWindow;
  last_7d: FirewallWindow;
}

export interface MaintenanceWindow {
  id?: string;
  starts_at?: string;
  ends_at?: string;
  reason?: string;
  [k: string]: unknown;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid " + label + " response.");
  }
  return value as Record<string, unknown>;
}

function integer(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error("Invalid " + label + ".");
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > 80 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("Invalid " + label + ".");
  }
  return value;
}

function optionalTimestamp(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return timestamp(value, label);
}

function firewallWindow(value: unknown, label: string): FirewallWindow {
  const source = record(value, label);
  const result = {
    observed: integer(source.observed, label + " observed count"),
    accepted: integer(source.accepted, label + " accepted count"),
    rejected: integer(source.rejected, label + " rejected count"),
  };
  if (result.accepted + result.rejected > result.observed) {
    throw new Error("Firewall decision counts do not reconcile.");
  }
  return result;
}

export async function listPresetSegments(): Promise<PresetSegment[]> {
  const res = await api.get<{ presets?: unknown }>("/api/v1/preset-segments");
  return asArray<PresetSegment>(res?.presets);
}

export function parseFirewallStats(value: unknown): FirewallStats {
  const source = record(value, "firewall statistics");
  return {
    last_24h: firewallWindow(source.last_24h, "24-hour firewall window"),
    last_7d: firewallWindow(source.last_7d, "7-day firewall window"),
  };
}

export async function getFirewallStats(
  signal?: AbortSignal,
): Promise<FirewallStats> {
  return parseFirewallStats(
    await api.get<unknown>("/api/v1/firewall/stats", { signal }),
  );
}

export async function listMaintenanceWindows(): Promise<MaintenanceWindow[]> {
  const res = await api.get<{ windows?: unknown }>(
    "/api/v1/maintenance-windows",
  );
  return asArray<MaintenanceWindow>(res?.windows);
}

/** Signups the firewall saw but did not rule on either way. */
export function undecidedSignups(w: FirewallWindow): number {
  return Math.max(0, w.observed - w.accepted - w.rejected);
}

export interface FirewallSettings {
  attack_mode_enabled: boolean;
  /** Arms attack mode by itself once the threshold is crossed. */
  auto_attack_mode: boolean;
  fingerprint_required: boolean;
  attack_mode_threshold: number;
  surge_multiplier: number;
  surge_min_per_hour: number;
  attack_mode_auto_enabled_at: string | null;
  attack_mode_auto_cooldown_until: string | null;
  updated_at: string;
}

export interface FirewallSettingsPatch {
  attack_mode_enabled?: boolean;
  auto_attack_mode?: boolean;
  fingerprint_required?: boolean;
  attack_mode_threshold?: number;
  surge_multiplier?: number;
  surge_min_per_hour?: number;
}

export interface FirewallEvent {
  id: string;
  formId: string | null;
  riskScore: number;
  action: "accepted" | "rejected" | "observed";
  at: string;
}

export interface FirewallEventsPage {
  events: FirewallEvent[];
  count: number;
}

const FIREWALL_ACTIONS = new Set<FirewallEvent["action"]>([
  "accepted",
  "rejected",
  "observed",
]);

function firewallIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Invalid " + label + ".");
  }
  return value;
}

export function parseFirewallSettings(
  value: unknown,
  expectedTenantId?: string,
): FirewallSettings {
  const source = record(value, "firewall settings");
  if (
    expectedTenantId &&
    source.tenant_id !== undefined &&
    source.tenant_id !== expectedTenantId
  ) {
    throw new Error("Firewall settings belong to another workspace.");
  }
  if (
    typeof source.attack_mode_enabled !== "boolean" ||
    typeof source.auto_attack_mode !== "boolean" ||
    typeof source.fingerprint_required !== "boolean"
  ) {
    throw new Error("Invalid firewall setting switches.");
  }
  return {
    attack_mode_enabled: source.attack_mode_enabled,
    auto_attack_mode: source.auto_attack_mode,
    fingerprint_required: source.fingerprint_required,
    attack_mode_threshold: integer(
      source.attack_mode_threshold,
      "firewall risk threshold",
      0,
      100,
    ),
    surge_multiplier: integer(
      source.surge_multiplier,
      "firewall surge multiplier",
      2,
      100,
    ),
    surge_min_per_hour: integer(
      source.surge_min_per_hour,
      "firewall hourly surge floor",
      1,
      100_000,
    ),
    attack_mode_auto_enabled_at: optionalTimestamp(
      source.attack_mode_auto_enabled_at,
      "firewall automatic enable time",
    ),
    attack_mode_auto_cooldown_until: optionalTimestamp(
      source.attack_mode_auto_cooldown_until,
      "firewall cooldown time",
    ),
    updated_at: timestamp(source.updated_at, "firewall update time"),
  };
}

export function parseFirewallEvents(value: unknown): FirewallEventsPage {
  const source = record(value, "firewall events");
  if (!Array.isArray(source.events) || source.events.length > 100) {
    throw new Error("Invalid firewall event rows.");
  }
  const seen = new Set<string>();
  const events = source.events.map((value) => {
    const row = record(value, "firewall event");
    const id = firewallIdentity(row.id, "firewall event identity");
    if (seen.has(id)) throw new Error("Duplicate firewall event identity.");
    seen.add(id);
    if (
      typeof row.action !== "string" ||
      !FIREWALL_ACTIONS.has(row.action as FirewallEvent["action"])
    ) {
      throw new Error("Invalid firewall event action.");
    }
    return {
      id,
      formId:
        row.form_id === undefined || row.form_id === ""
          ? null
          : firewallIdentity(row.form_id, "firewall form identity"),
      riskScore: integer(row.risk_score, "firewall event risk score", 0, 100),
      action: row.action as FirewallEvent["action"],
      at: timestamp(row.at, "firewall event time"),
    };
  });
  const count = integer(source.count, "firewall event count", 0, 100);
  if (count !== events.length) {
    throw new Error("Firewall event count does not reconcile.");
  }
  return { events, count };
}

/**
 * Signup firewall posture.
 *
 * `attack_mode_enabled: false` DOES NOT MEAN UNPROTECTED. With
 * `auto_attack_mode` true the firewall arms itself once signups cross
 * `attack_mode_threshold`, so the honest reading of the pair is "not currently
 * under attack, and will engage on its own" — not "off". Showing the first
 * flag alone invites someone to switch attack mode on permanently and take the
 * false-positive cost for no gain.
 */
export async function getFirewallSettings(
  options: { tenantId?: string; signal?: AbortSignal } = {},
): Promise<FirewallSettings> {
  return parseFirewallSettings(
    await api.get<unknown>("/api/v1/firewall/settings", {
      signal: options.signal,
    }),
    options.tenantId,
  );
}

export async function listFirewallEvents(
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<FirewallEventsPage> {
  const limit = options.limit ?? 20;
  integer(limit, "firewall event limit", 1, 100);
  return parseFirewallEvents(
    await api.get<unknown>(`/api/v1/firewall/events?limit=${limit}`, {
      signal: options.signal,
    }),
  );
}

export function validateFirewallPatch(
  patch: FirewallSettingsPatch,
): FirewallSettingsPatch {
  const allowed = new Set([
    "attack_mode_enabled",
    "auto_attack_mode",
    "fingerprint_required",
    "attack_mode_threshold",
    "surge_multiplier",
    "surge_min_per_hour",
  ]);
  if (
    Object.keys(patch).length === 0 ||
    Object.keys(patch).some((key) => !allowed.has(key))
  ) {
    throw new Error("Choose at least one valid firewall setting to update.");
  }
  for (const key of [
    "attack_mode_enabled",
    "auto_attack_mode",
    "fingerprint_required",
  ] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== "boolean") {
      throw new Error("Invalid firewall switch value.");
    }
  }
  if (patch.attack_mode_threshold !== undefined) {
    integer(patch.attack_mode_threshold, "firewall risk threshold", 0, 100);
  }
  if (patch.surge_multiplier !== undefined) {
    integer(patch.surge_multiplier, "firewall surge multiplier", 2, 100);
  }
  if (patch.surge_min_per_hour !== undefined) {
    integer(
      patch.surge_min_per_hour,
      "firewall hourly surge floor",
      1,
      100_000,
    );
  }
  return { ...patch };
}

export async function updateFirewallSettings(
  patch: FirewallSettingsPatch,
  expectedTenantId?: string,
  options: { signal?: AbortSignal; idempotencyKey?: string } = {},
): Promise<FirewallSettings> {
  return parseFirewallSettings(
    await api.put<unknown>(
      "/api/v1/firewall/settings",
      validateFirewallPatch(patch),
      { requireOnline: true, maxAttempts: 1, signal: options.signal, idempotencyKey: options.idempotencyKey },
    ),
    expectedTenantId,
  );
}

export async function runFirewallSurgeDetection(options: { signal?: AbortSignal; idempotencyKey?: string } = {}): Promise<{
  flipped: boolean;
}> {
  const source = record(
    await api.post<unknown>(
      "/api/v1/firewall/detect",
      {},
      {
        requireOnline: true,
        maxAttempts: 1,
        signal: options.signal,
        idempotencyKey: options.idempotencyKey,
      },
    ),
    "firewall surge detection",
  );
  if (typeof source.flipped !== "boolean") {
    throw new Error("Invalid firewall surge detection result.");
  }
  return { flipped: source.flipped };
}

/** Off right now, but armed to engage without anyone intervening. */
export function firewallSelfArming(f: FirewallSettings): boolean {
  return !f.attack_mode_enabled && f.auto_attack_mode;
}
