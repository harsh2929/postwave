/**
 * lib/key-hygiene-api.ts — dormant API keys, activation exclusions, and the
 * deliverability score history.
 *
 * Four paths were reached by desktop and by no web file.
 *
 * `inactive-keys` REPORTS ITS OWN THRESHOLD (`threshold_days: 90`). "3 inactive
 * keys" is not a fact on its own — inactive since when? A key unused for 91
 * days and one unused for three years are the same row under a 90-day
 * threshold, and an operator deciding whether to revoke needs the window that
 * produced the list.
 *
 * `deliverability/hub/history` carries `model_version` alongside the snapshots.
 * Scores computed under different model versions are not comparable, so a
 * trend line across a version change is a chart of two different measurements.
 */
import { api } from "@/lib/api";

export interface InactiveKeys {
  count: number;
  keys: unknown[];
  /** The window that defines "inactive". Without it the count means nothing. */
  threshold_days: number;
}

export interface ScoreHistory {
  count: number;
  /** Snapshots from different model versions are not comparable. */
  model_version: string;
  snapshots: unknown[];
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function num(v: unknown): number {
  return Number.isFinite(v) ? Number(v) : 0;
}

export async function getInactiveKeys(): Promise<InactiveKeys> {
  const res = await api.get<InactiveKeys>("/api/v1/inactive-keys");
  return {
    count: num(res?.count),
    keys: asArray(res?.keys),
    threshold_days: num(res?.threshold_days),
  };
}

export async function getScoreHistory(): Promise<ScoreHistory> {
  const res = await api.get<ScoreHistory & { snapshots?: unknown }>(
    "/api/v1/deliverability/hub/history",
  );
  return {
    count: num(res?.count),
    model_version:
      typeof res?.model_version === "string" ? res.model_version : "",
    snapshots: asArray(res?.snapshots),
  };
}

export async function listActivationExclusions(): Promise<unknown[]> {
  const res = await api.get<{ items?: unknown }>(
    "/api/v1/activation-exclusions",
  );
  return asArray(res?.items);
}

export async function listSendingProviders(): Promise<unknown[]> {
  const res = await api.get<{ items?: unknown }>(
    "/api/v1/deliverability/providers",
  );
  return asArray(res?.items);
}
