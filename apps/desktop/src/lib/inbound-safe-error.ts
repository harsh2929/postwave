import { remoteFailureFromError, type RemoteApiError } from "./remote-resource";

/** Render a bounded category and safe correlation tokens, never server prose. */
export function safeInboundFailure(
  error: RemoteApiError,
  fallback: string,
): string {
  const failure = remoteFailureFromError(error);
  const category =
    failure.message === "The server could not verify this data."
      ? ""
      : ` ${failure.message}`;
  const reference = [failure.code, failure.requestId]
    .filter(Boolean)
    .join(" · ");
  return `${fallback}${category}${reference ? ` Reference: ${reference}.` : ""}`;
}
