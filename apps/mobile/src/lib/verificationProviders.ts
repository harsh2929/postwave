/**
 * lib/verificationProviders.ts — WHICH vendor is verifying addresses, said
 * plainly, and what changing that costs.
 *
 * Mobile could already see the verification POLICY (off/local/full) and the
 * credit meter, but never the vendor row behind them: a workspace could be in
 * "full" mode with ZeroBounce rejecting its key and the phone would show a
 * mode, a balance, and no way to learn which vendor — or whether one is
 * enabled at all. That is the gap this parses for.
 *
 * TWO RULES THIS FILE ENFORCES, both about money and secrets:
 *
 *  1. `credential_ref` NEVER reaches the parsed view. The server's own comment
 *     is that the row "deliberately has NO API-key field" and the ref is an
 *     opaque local id, but a phone has no business holding, rendering or
 *     caching the handle to a billable key either. The api layer re-reads it
 *     from the server at write time and echoes it back without it ever landing
 *     in component state (see api/verificationProviders.ts).
 *  2. A NULL balance is "not reported", never 0. Zero reads as "out of
 *     credits" and would stop somebody starting work they can actually afford.
 *
 * Import-free of react-native, so it is node-tested.
 */

import { WireShapeError } from "./deliverabilityContracts";

/** One verification_providers row, minus everything credential-shaped. */
export interface VerificationProviderConfig {
  provider: string;
  enabled: boolean;
  /** null when the vendor never reported one — NOT zero. */
  lastBalance: number | null;
  lastBalanceAt: string;
  /** Server-sanitised sentence; the raw provider error never leaves the API. */
  lastError: string;
  lastErrorAt: string;
  updatedAt: string;
}

export interface VerificationProvidersView {
  providers: VerificationProviderConfig[];
  /** What the server says CAN be configured; never hardcoded here. */
  available: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Parse GET /api/v1/verification/providers.
 *
 * A row with no usable provider name is dropped rather than rendered as a
 * blank vendor: "" verifies nothing and naming it would invite a write against
 * a path segment the server will reject anyway.
 */
export function parseVerificationProviders(
  payload: unknown,
): VerificationProvidersView {
  if (!isRecord(payload)) throw new WireShapeError("verification providers");
  const raw = payload.providers;
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    throw new WireShapeError("verification providers");
  }
  // Array.isArray, not `?? []` -- a truthy non-array would reach .map.
  const rows = Array.isArray(raw) ? raw : [];
  const providers: VerificationProviderConfig[] = [];
  for (const entry of rows) {
    if (!isRecord(entry)) throw new WireShapeError("verification providers");
    const provider = text(entry.provider).trim().toLowerCase();
    if (!provider) continue;
    const balance = entry.last_balance;
    if (
      balance !== undefined &&
      balance !== null &&
      (typeof balance !== "number" || !Number.isFinite(balance))
    ) {
      throw new WireShapeError("verification providers");
    }
    providers.push({
      provider,
      enabled: entry.enabled === true,
      lastBalance: typeof balance === "number" ? balance : null,
      lastBalanceAt: text(entry.last_balance_at),
      lastError: text(entry.last_error),
      lastErrorAt: text(entry.last_error_at),
      updatedAt: text(entry.updated_at),
    });
  }
  return {
    providers,
    available: stringList(payload.available)
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  };
}

/** Display names for the two vendors the server advertises. */
export function verificationVendorLabel(provider: string): string {
  const key = provider.trim().toLowerCase();
  if (key === "zerobounce") return "ZeroBounce";
  if (key === "kickbox") return "Kickbox";
  return provider.trim() || "Unnamed vendor";
}

/**
 * The vendor actually doing the probing.
 *
 * The server's BuildChain resolves ONE enabled provider, so a second enabled
 * row is not a second verifier — the first is what the list returns and what
 * this reports.
 */
export function activeVerificationProvider(
  view: VerificationProvidersView,
): VerificationProviderConfig | null {
  return view.providers.find((entry) => entry.enabled) ?? null;
}

/** The headline: who verifies addresses here, and what happens when nobody does. */
export function verificationProviderSummary(
  view: VerificationProvidersView,
): string {
  const active = activeVerificationProvider(view);
  if (active) {
    return `${verificationVendorLabel(active.provider)} is the vendor verifying addresses for this workspace.`;
  }
  if (view.providers.length > 0) {
    return "No vendor is enabled, so only the free local syntax and domain checks run — no mailbox is probed.";
  }
  return "No verification vendor is configured, so only the free local syntax and domain checks run — no mailbox is probed.";
}

function grouped(value: number): string {
  const sign = value < 0 ? "-" : "";
  return (
    sign +
    Math.abs(Math.trunc(value))
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/gu, ",")
  );
}

/**
 * One row's state line.
 *
 * The last balance is the vendor's own last answer, so it is dated rather than
 * presented as live; a null one says so instead of reading as an empty wallet.
 */
export function verificationProviderStatusLine(
  config: VerificationProviderConfig,
): string {
  const state = config.enabled ? "Enabled" : "Configured but off";
  const balance =
    config.lastBalance === null
      ? "balance not reported"
      : `${grouped(config.lastBalance)} credits at the last check`;
  return `${state} · ${balance}.`;
}

/**
 * The consequence sentence for turning the paid vendor off or removing it.
 *
 * Both land in the same place — no mailbox gets probed — so both say it. The
 * remove case adds the part that is not recoverable from the phone: the
 * credential handle is server-side configuration this surface cannot recreate.
 */
export function verificationProviderChangeConsequence(
  provider: string,
  action: "enable" | "disable" | "remove",
): string {
  const label = verificationVendorLabel(provider);
  if (action === "enable") {
    return `${label} will verify addresses from now on. Each address it checks spends one of this workspace's provider credits.`;
  }
  if (action === "disable") {
    return `${label} will stop verifying addresses. Only the free local syntax and domain checks will run, so no mailbox is probed until a vendor is enabled again.`;
  }
  return `${label} will be removed from this workspace. Only the free local checks will run, and its stored credential reference cannot be recreated from the phone.`;
}
