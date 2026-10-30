import type { ApiErr } from "./result";

function normalizedIdentity(value: string | number): string {
  return String(value).trim().toLowerCase();
}

/**
 * Subscriber and list identifiers are opaque on the wire. Comparison is
 * deliberately limited to trimming and ASCII-safe case folding: it never
 * coerces UUIDs, numeric aliases, or emails into one another.
 */
export function responseIdentityMatches(
  expected: string | number,
  actual: string | number,
): boolean {
  return normalizedIdentity(expected) === normalizedIdentity(actual);
}

/**
 * A response-body identity mismatch is a parse/contract failure, not a valid
 * domain success. Keep the message free of subscriber, tenant, and resource
 * identifiers so diagnostics cannot disclose data from the rejected payload.
 */
export function responseIdentityMismatch(
  resource:
    | "subscriber"
    | "list"
    | "audience field"
    | "note"
    | "attachment"
    | "PII finding"
    | "lookalike audience"
    | "subscriber import" = "subscriber",
): ApiErr {
  return {
    error: {
      kind: "parse",
      code: "subscriber_response_identity_mismatch",
      message: `The server returned data for a different ${resource}. The previous verified data was kept; retry the request.`,
    },
    retryability: "manual",
  };
}

export function responseContractFailure(message: string): ApiErr {
  return {
    error: {
      kind: "parse",
      code: "invalid_subscriber_response_contract",
      message,
    },
    retryability: "manual",
  };
}
