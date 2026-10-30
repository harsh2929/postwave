/**
 * api/reputationResponse.ts — the three writes that answer a
 * `deliverability.degraded` push.
 *
 *   PUT  /api/v1/firewall/settings                                    (admin)
 *   GET  /api/v1/monitoring/blocklist-status                          (viewer)
 *   POST /api/v1/monitoring/blocklist-status/{type}/{subject}/suppress (admin)
 *   POST /api/v1/spam-trap-guard/run-now                              (admin)
 *
 * The blocklist suppress endpoint had no client on ANY surface before this —
 * mobile, web, desktop and the SDK all returned nothing for `blocklist-status`.
 *
 * `api/platformConfig.ts` already reads the firewall settings, and this module
 * deliberately does not duplicate that read: it owns the WRITES plus the
 * blocklist reads that have no other home.
 */
import { rawRequest, type AIApiError } from "./request";

import type {
  BlocklistSubjectLike,
  FirewallSettingsLike,
  SpamTrapRunResult,
} from "@/lib/reputationResponse";

class ReputationError extends Error {
  readonly status: number;
  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "ReputationError";
    this.status = error.status;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function normalizeFirewallForWrite(raw: unknown): FirewallSettingsLike | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    attackModeEnabled: r.attack_mode_enabled === true,
    autoAttackMode: r.auto_attack_mode === true,
    ...(str(r.attack_mode_auto_enabled_at)
      ? { attackModeAutoEnabledAt: str(r.attack_mode_auto_enabled_at) }
      : {}),
    ...(str(r.attack_mode_auto_cooldown_until)
      ? { attackModeAutoCooldownUntil: str(r.attack_mode_auto_cooldown_until) }
      : {}),
  };
}

/** `GET /api/v1/firewall/settings` — the flat settings object. */
export async function fetchFirewallSettings(): Promise<FirewallSettingsLike | null> {
  const res = await rawRequest<unknown>("GET", "/api/v1/firewall/settings");
  if (res.error) {
    throw new ReputationError(res.error, "Couldn't load firewall settings.");
  }
  return normalizeFirewallForWrite(res.data);
}

/**
 * Flip attack mode, and NOTHING else.
 *
 * `UpdateSettingsInput` is all pointers, so this one-field body leaves the
 * thresholds and surge multipliers exactly as they are. Sending a whole
 * settings object from a phone would quietly overwrite numbers somebody tuned
 * at a desk.
 */
export async function setAttackMode(
  enabled: boolean,
): Promise<FirewallSettingsLike | null> {
  const res = await rawRequest<unknown>("PUT", "/api/v1/firewall/settings", {
    attack_mode_enabled: enabled,
  });
  if (res.error) {
    throw new ReputationError(res.error, "Couldn't change attack mode.");
  }
  return normalizeFirewallForWrite(res.data);
}

function normalizeSubject(raw: unknown): BlocklistSubjectLike | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const subject = typeof r.subject === "string" ? r.subject : "";
  if (!subject) return null;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const int = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  return {
    subject_type: typeof r.subject_type === "string" ? r.subject_type : "",
    subject,
    listed_zones: strings(r.listed_zones),
    tier1_hit: r.tier1_hit === true,
    listed_count: int(r.listed_count),
    total_zones: int(r.total_zones),
    would_auto_suppress: r.would_auto_suppress === true,
    last_checked: typeof r.last_checked === "string" ? r.last_checked : "",
  };
}

/** Every subject this tenant owns — dedicated IPs and verified domains. */
export async function listBlocklistStatus(): Promise<BlocklistSubjectLike[]> {
  const res = await rawRequest<unknown>(
    "GET",
    "/api/v1/monitoring/blocklist-status",
  );
  if (res.error) {
    throw new ReputationError(res.error, "Couldn't load blocklist status.");
  }
  const data = res.data as
    | { subjects?: unknown; items?: unknown }
    | unknown[]
    | null;
  const raw = Array.isArray(data)
    ? data
    : ((data as { subjects?: unknown })?.subjects ??
      (data as { items?: unknown })?.items ??
      []);
  const list = Array.isArray(raw) ? raw : [];
  const out: BlocklistSubjectLike[] = [];
  for (const entry of list) {
    const subject = normalizeSubject(entry);
    if (subject) out.push(subject);
  }
  return out;
}

/**
 * Suppress a listed subject by hand.
 *
 * The handler answers 201 when the suppression was added and 409 when one
 * already existed. 409 is NOT an error to show as a failure — the caller's
 * intent is satisfied — so it is normalised to `{ added: false }` rather than
 * thrown, and the UI says "already suppressed" instead of "couldn't suppress".
 */
export async function suppressBlocklistSubject(
  subjectType: string,
  subject: string,
): Promise<{ added: boolean }> {
  const res = await rawRequest<unknown>(
    "POST",
    `/api/v1/monitoring/blocklist-status/${encodeURIComponent(subjectType)}/${encodeURIComponent(subject)}/suppress`,
    {},
  );
  if (res.error) {
    if (res.error.status === 409) return { added: false };
    throw new ReputationError(res.error, "Couldn't suppress that subject.");
  }
  const data = res.data as { added?: unknown } | null;
  return { added: data?.added === true };
}

/** Run the spam-trap sweep now. Desktop had this; mobile did not. */
export async function runSpamTrapSweep(): Promise<SpamTrapRunResult> {
  const res = await rawRequest<unknown>(
    "POST",
    "/api/v1/spam-trap-guard/run-now",
    {},
  );
  if (res.error) {
    throw new ReputationError(res.error, "Couldn't run the spam-trap sweep.");
  }
  const data = res.data as
    | { blocklisted?: unknown; completed_at?: unknown }
    | null;
  return {
    blocklisted:
      typeof data?.blocklisted === "number" && Number.isFinite(data.blocklisted)
        ? data.blocklisted
        : 0,
    completed_at:
      typeof data?.completed_at === "string" ? data.completed_at : "",
  };
}
