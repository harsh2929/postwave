// SPDX-License-Identifier: AGPL-3.0-only

/** Safe copy only for typed client-error responses that confirm refusal. */
export function smsKnownWriteRefusalMessage(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  const status = (error as { status?: unknown }).status;
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 400 ||
    status >= 500
  ) {
    return null;
  }
  switch (status) {
    case 401:
      return "The server refused the request because the session is no longer authorized; no change was committed.";
    case 403:
      return "The server refused the request because admin authority is no longer valid; no change was committed.";
    case 404:
      return "The server refused the request because the exact row no longer exists; no change was committed.";
    case 409:
      return "The server refused the request because current stored state conflicted; no change was committed. Reload before retrying.";
    case 422:
      return "The server refused the unsupported policy change; no change was committed.";
    case 429:
      return "The server rate-limited the request; no change was committed. Wait before retrying.";
    default:
      return "The server rejected the request as invalid; no change was committed.";
  }
}
