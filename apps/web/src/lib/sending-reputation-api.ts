/**
 * lib/sending-reputation-api.ts — send timing, auto-suppression, sender
 * reputation and spam-trap hits.
 *
 * Five paths desktop reached and no web file did.
 *
 * TWO PLACES WHERE THE SETTING AND THE DATA DISAGREE:
 *
 * 1. `settings/sending/status` reports `quiet_hours_per_recipient: true` and
 *    `bucket_count: 0`. The switch says sends are timed to each recipient;
 *    the bucket count says no recipient has a resolved local time to be timed
 *    against. Rendering only the switch promises per-recipient timing that
 *    cannot happen. Both are shown and the gap is named.
 *
 * 2. `blocklist/auto-suppress` reports `eligible_now` alongside
 *    `auto_suppress`. When auto-suppression is OFF, `eligible_now` is a
 *    COUNTERFACTUAL — how many addresses would be suppressed if it were
 *    turned on — not a count of anything that has happened. Shown without
 *    that framing it reads as a live suppression figure.
 *
 * `observed_at` makes the suppression block a snapshot, not a live read, so
 * it is carried through rather than dropped.
 */
import { api } from "@/lib/api";

export interface SendingStatus {
  quiet_hours_per_recipient: boolean;
  bucket_count: number;
}

export interface SendSettings {
  default_sto_strategy: string;
  newsletters_force_per_recipient: boolean;
}

export interface AutoSuppressState {
  auto_suppress: boolean;
  eligible_now: number;
  active_suppressions: number;
  observed_at: string;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export async function getSendingStatus(): Promise<SendingStatus> {
  const r = await api.get<Partial<SendingStatus>>(
    "/api/v1/settings/sending/status",
  );
  return {
    quiet_hours_per_recipient: r?.quiet_hours_per_recipient === true,
    bucket_count: num(r?.bucket_count),
  };
}

export async function getSendSettings(): Promise<SendSettings> {
  const r = await api.get<Partial<SendSettings>>("/api/v1/send-settings");
  return {
    default_sto_strategy: str(r?.default_sto_strategy),
    newsletters_force_per_recipient:
      r?.newsletters_force_per_recipient === true,
  };
}

export async function getAutoSuppress(): Promise<AutoSuppressState> {
  const r = await api.get<Partial<AutoSuppressState>>(
    "/api/v1/blocklist/auto-suppress",
  );
  return {
    auto_suppress: r?.auto_suppress === true,
    eligible_now: num(r?.eligible_now),
    active_suppressions: num(r?.active_suppressions),
    observed_at: str(r?.observed_at),
  };
}

export async function getSenderReputation(): Promise<unknown[]> {
  const r = await api.get<{ domains?: unknown }>("/api/v1/sender-reputation");
  return asArray(r?.domains);
}

export async function getSpamTrapHits(): Promise<{
  hits: unknown[];
  count: number;
}> {
  const r = await api.get<{ hits?: unknown; count?: unknown }>(
    "/api/v1/spam-trap-guard/hits",
  );
  return { hits: asArray(r?.hits), count: num(r?.count) };
}

/**
 * True when per-recipient timing is switched on but no recipient time buckets
 * exist for it to act on — the setting promises something the data cannot
 * deliver, and every send silently falls back to workspace time.
 */
export function perRecipientTimingIsInert(s: SendingStatus): boolean {
  return s.quiet_hours_per_recipient && s.bucket_count === 0;
}

/**
 * Whether `eligible_now` describes something that has happened, or something
 * that would happen if auto-suppression were enabled.
 */
export function eligibleIsCounterfactual(s: AutoSuppressState): boolean {
  return !s.auto_suppress;
}
