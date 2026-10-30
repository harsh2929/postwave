/**
 * lib/ipPool.ts — reading the `ip_pool` projection off GET /settings/sending.
 *
 * The server attaches a read-only pool summary to the sending-settings row
 * (apps/api/internal/sendingsettings/sendingsettings.go:45-54,
 * `IPPool{name, dedicated}`, omitted when derivation fails). Desktop renders
 * it as IpPoolDomainCard (apps/desktop/src/pages/SendingSettings.tsx:851);
 * mobile never read the field, so the phone answered "which pool are we
 * sending from?" with nothing at all.
 *
 * THE HONESTY RULE, KEPT FROM DESKTOP: an absent or malformed field renders
 * as "unknown", never as "Shared" — an older API build that does not report
 * pool assignment is not evidence the workspace is on the shared pool.
 *
 * AND THERE ARE TWO KINDS OF UNKNOWN, which desktop also separates
 * (SendingSettings.tsx:869-887, "Not reported" vs "Unverified"). A verified
 * settings row that carried no `ip_pool` is the server declining to report.
 * NO settings row at all — the gate could not read, so the screen renders its
 * body with `row === undefined` — is Moosewave never having asked. Collapsing
 * them makes the phone say "not reported by this server" about a server it
 * never reached, which is a claim about someone else's infrastructure
 * manufactured out of our own missing read.
 *
 * That is why `verified` is a REQUIRED argument rather than a defaulted one:
 * a caller that forgets it would silently certify a read that never happened.
 *
 * Import-free so the node vitest environment can drive every shape.
 */

export type IpPoolSummary =
  | { kind: "known"; name: string; dedicated: boolean }
  /** A verified settings response that carried no usable pool projection. */
  | { kind: "not_reported" }
  /** No settings response was verified at all — nothing was asked. */
  | { kind: "unverified" };

/**
 * @param value the raw `ip_pool` field off the settings row, unparsed.
 * @param verified whether a settings row was actually loaded. `false` wins
 *   over everything: without a row there is no field to have been absent.
 */
export function describeIpPool(value: unknown, verified: boolean): IpPoolSummary {
  if (!verified) return { kind: "unverified" };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "not_reported" };
  }
  const row = value as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name) return { kind: "not_reported" };
  return { kind: "known", name, dedicated: row.dedicated === true };
}

/** The card's one-line reading of the pool, spoken and printed identically. */
export function ipPoolLine(pool: IpPoolSummary): string {
  if (pool.kind === "known") {
    return `${pool.name} · ${pool.dedicated ? "Dedicated" : "Shared"}`;
  }
  return pool.kind === "not_reported"
    ? "Unknown — not reported by this server"
    : "Unknown — no settings response has been verified";
}
