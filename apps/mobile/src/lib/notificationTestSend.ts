/**
 * lib/notificationTestSend.ts — what to SAY about a test notification.
 *
 * The point of the test-send is to answer one question — "does Moosewave mail
 * actually reach me?" — and the server answers it in four distinguishable ways
 * that a client collapsing them into "Couldn't send" would throw away:
 *
 *   200 …………………………… it left the building; the body names the address it went to.
 *   503 mailer_unavailable … this DEPLOYMENT has no mailer wired
 *                            (apps/api/internal/settings/notifications.go:320).
 *                            Retrying will never work; only an operator can fix it.
 *   422 no_email ………… this ACCOUNT has no address on it. Also not retryable,
 *                       and the fix is somewhere else entirely.
 *   4xx/5xx ………………… an ordinary failure, which retrying may well fix.
 *
 * Two of those four are product boundaries, not faults, and telling a user to
 * "check your connection" in either case sends them to look in the wrong place.
 *
 * Import-free of react-native/expo by construction (the one import is a TYPE,
 * erased at compile time), so this runs in the node vitest environment.
 */
import type { AIApiError } from "@/api/request";

export interface TestSendOutcome {
  kind: "success" | "error";
  message: string;
  /**
   * False when retrying is guaranteed to fail again — a missing mailer or a
   * missing address. Callers use it to decide whether offering "Try again" is
   * honest.
   */
  retryable: boolean;
}

/** The address the server reports it mailed, when it reported one. */
function addressed(to: unknown): string {
  return typeof to === "string" && to.trim() ? to.trim() : "";
}

export function testSendOutcome(res: {
  data?: { to?: string } | null;
  error?: AIApiError | null;
}): TestSendOutcome {
  const error = res.error;
  if (!error) {
    const to = addressed(res.data?.to);
    return {
      kind: "success",
      // Echo the server's address rather than the profile's: they can differ,
      // and the one that matters is the one it was sent to.
      message: to ? `Test notification sent to ${to}.` : "Test notification sent.",
      retryable: true,
    };
  }
  if (error.code === "mailer_unavailable" || error.status === 503) {
    return {
      kind: "error",
      message:
        "This deployment has no email delivery configured, so no notification can be sent. Ask whoever runs your Moosewave server.",
      retryable: false,
    };
  }
  if (error.code === "no_email" || error.status === 422) {
    return {
      kind: "error",
      message:
        "Your account has no email address on it, so there is nowhere to send a notification.",
      retryable: false,
    };
  }
  if (error.status === 403) {
    return {
      kind: "error",
      message: "Only workspace admins can send a test notification.",
      retryable: false,
    };
  }
  return {
    kind: "error",
    message: error.message
      ? `Couldn't send the test notification. ${error.message}`
      : "Couldn't send the test notification.",
    retryable: true,
  };
}
