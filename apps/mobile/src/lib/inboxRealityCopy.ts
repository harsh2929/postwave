/**
 * lib/inboxRealityCopy.ts — what the pre-send banner says when the predictor
 * does not answer.
 *
 * It used to interpolate the SDK's own string (`Inbox Reality unavailable:
 * ${error.message}`) straight into a send sheet, which is the same defect the
 * dashboard's failure taxonomy exists to prevent: transport internals shown to
 * a user who is one tap from mailing their list, at the moment they are least
 * able to act on them. Pure, so the mapping is testable without React Native.
 */

/** Statuses that mean "this deployment has no predictor", not "it broke". */
const NOT_CONFIGURED = new Set([404, 405, 501, 503]);

export function inboxRealityErrorCopy(status: number): string {
  if (NOT_CONFIGURED.has(status)) {
    return "Inbox Reality isn't available on this workspace yet — the predictor service isn't configured. Sending is unaffected.";
  }
  if (status === 401) {
    return "Your session expired before the placement check could run. Sending is unaffected.";
  }
  if (status === 403) {
    return "Your role doesn't include the placement predictor. Sending is unaffected.";
  }
  if (status === 429) {
    return "The placement predictor is rate-limiting this device. Sending is unaffected.";
  }
  if (status >= 500) {
    return "The placement predictor is having trouble — this is on our side. Sending is unaffected.";
  }
  if (status === 0) {
    return "The placement check couldn't reach Moosewave. Sending is unaffected.";
  }
  return "The placement check couldn't be completed. Sending is unaffected.";
}
