/**
 * lib/verificationErrors.ts — the verification failures whose SERVER sentence
 * must survive the generic status→copy table.
 *
 * lib/errorCopy is deliberately built never to echo a server message: for most
 * routes a raw error is noise, and mapping status→copy is the safer default.
 * The verification surface is the exception, and MONEY is why.
 *
 * The server answers an uncertain billable outcome with a 409 carrying its own
 * sentence — "The batch was not retried to avoid duplicate charges." Run that
 * through the status table and 409 matches no arm, so the operator is told
 * "Something went wrong loading this. Please try again." That is wrong twice:
 * nothing was loading, and it instructs a retry of a request the server
 * refused to retry precisely because it may already have been charged.
 *
 * The 412s are the milder version of the same fault. Each names a workspace
 * configuration only an admin can fix (no vendor configured, key rejected, no
 * account); a generic "please try again" sends somebody pressing a button that
 * cannot begin to work until they leave and change something else.
 *
 * `verification_no_credits` is deliberately ABSENT: the server sends that one
 * as an entitlement Denial with a `remedy`, and lib/errorCopy's denial branch
 * already renders it better than a bare sentence would.
 *
 * Import-free of react-native, so it is node-tested.
 */

/** apps/api/internal/verification/handlers.go writeProviderError. */
const SERVER_AUTHORED_FAILURES: ReadonlySet<string> = new Set([
  // 409 — the billable boundary may already have been crossed.
  "verification_provider_outcome_ambiguous",
  "verification_usage_outcome_ambiguous",
  // 412 — customer-fixable configuration, not a fault.
  "verification_not_configured",
  "verification_provider_unauthorized",
  "verification_provider_account_rejected",
  // 502 — the VENDOR could not be reached, which the generic 5xx copy
  // ("the server had a problem") misattributes to Moosewave.
  "verification_provider_unavailable",
]);

/**
 * The codes above are raised by the credential PROBE that every provider PUT
 * runs before it touches the row (Store.ConfigureProvider calls
 * vendor.Credits before upsertProvider). That probe runs even when the write
 * is only turning the vendor OFF, so a workspace whose key has been revoked
 * cannot disable its own vendor — and the server's sentence, which talks about
 * updating the key, reads like a non-sequitur next to a Disable button.
 *
 * DeleteProvider does not probe: it is a plain row delete. So the escape hatch
 * is real and worth naming.
 */
const CREDENTIAL_PROBE_FAILURES: ReadonlySet<string> = new Set([
  "verification_provider_unauthorized",
  "verification_provider_account_rejected",
  "verification_not_configured",
]);

/**
 * Which sentence to show, preferring the server's own where it authored one.
 *
 * `fallback` is what the generic status→copy table produced; it wins whenever
 * the server did not classify the failure, so an unrecognised code can never
 * surface a raw or empty string.
 */
export function verificationFailureMessage(input: {
  code: string;
  serverMessage: string;
  fallback: string;
}): string {
  const server = input.serverMessage.trim();
  if (server && SERVER_AUTHORED_FAILURES.has(input.code.trim())) {
    return server;
  }
  return input.fallback;
}

/**
 * The extra sentence a FAILED enable/disable needs, or "" when none applies.
 *
 * Only ever appended to a provider write that failed, and only for the probe
 * codes: on any other failure the vendor row is untouched for reasons that
 * have nothing to do with the credential.
 */
export function verificationProviderProbeHint(code: string): string {
  if (!CREDENTIAL_PROBE_FAILURES.has(code.trim())) return "";
  return "Changing a vendor re-checks its credential first, so this cannot be turned off until the key works. Removing the vendor does not contact the provider.";
}
