import type {
  AuthLinkContractFailure,
  AuthLinkFlow,
} from "./auth-link-contract";
import type { AuthFlowStateFailureReason } from "./auth-flow-state";

export type AuthLinkRecoveryReason =
  | AuthLinkContractFailure
  | "request_expired"
  | "state_mismatch"
  | "not_requested"
  | "expired"
  | "already_used"
  | "expired_or_used"
  | "wrong_workspace"
  | "rate_limited"
  | "temporary_failure";

export interface AuthLinkApiError {
  message: string;
  status?: number;
  code?: string;
  kind?: "http" | "network" | "timeout" | "parse" | "invalid_config";
}

export interface AuthLinkRecoveryCopy {
  eyebrow: string;
  title: string;
  message: string;
}

export function authStateFailureToRecovery(
  reason: AuthFlowStateFailureReason,
): AuthLinkRecoveryReason {
  switch (reason) {
    case "expired":
      return "request_expired";
    case "mismatch":
      return "state_mismatch";
    case "missing_pending":
      return "not_requested";
    case "missing_state":
    case "invalid_pending":
      return "invalid_link";
  }
}

export function classifyAuthLinkApiError(
  error: AuthLinkApiError,
): AuthLinkRecoveryReason {
  switch (error.code) {
    case "token_expired":
    case "expired_token":
      return "expired";
    case "token_used":
    case "already_used":
      return "already_used";
    case "invalid_token":
      // Current API deliberately combines expiry, replay, and unknown token.
      // Keep the UX honest until the endpoint supplies a safe typed reason.
      return "expired_or_used";
    case "invalid_link_contract":
    case "missing_token":
    case "wrong_purpose":
      return "invalid_link";
    case "unsupported_link_version":
      return "unsupported_version";
    case "wrong_link_audience":
      return "wrong_device";
    case "wrong_workspace":
    case "workspace_access_revoked":
      return "wrong_workspace";
    case "rate_limited":
      return "rate_limited";
    case "link_verification_unavailable":
    case "reset_unavailable":
    case "update_failed":
      return "temporary_failure";
    default:
      if (
        error.kind === "network" ||
        error.kind === "timeout" ||
        error.kind === "parse" ||
        error.kind === "invalid_config" ||
        (error.status !== undefined && error.status >= 500)
      ) {
        return "temporary_failure";
      }
      if (error.status === 429) return "rate_limited";
      if (error.status === 403) return "wrong_workspace";
      return "temporary_failure";
  }
}

export function authLinkRecoveryCopy(
  reason: AuthLinkRecoveryReason,
  flow: AuthLinkFlow | null,
): AuthLinkRecoveryCopy {
  const noun = flow === "reset" ? "password reset link" : "sign-in link";
  switch (reason) {
    case "unsupported_version":
      return {
        eyebrow: "App update needed",
        title: "This link needs a newer version of Moosewave",
        message:
          "Update the desktop app, or request a new link and continue in your browser.",
      };
    case "wrong_device":
      return {
        eyebrow: "Different device",
        title: `This ${noun} belongs to another device`,
        message:
          "For your security, finish on the device or browser that requested it, or start a new request here.",
      };
    case "wrong_flow":
      return {
        eyebrow: "Link mismatch",
        title: `This ${noun} does not match the requested action`,
        message: "Start again so Moosewave can issue the correct one-time link.",
      };
    case "invalid_signature":
      return {
        eyebrow: "Link altered",
        title: `Moosewave could not verify this ${noun}`,
        message:
          "The secure signature is incomplete or has changed. Do not retry this link; request a new one.",
      };
    case "request_expired":
      return {
        eyebrow: "Request expired",
        title: `This ${noun} arrived after the desktop request expired`,
        message: "Start a fresh request from this app to continue securely.",
      };
    case "state_mismatch":
      return {
        eyebrow: "Request mismatch",
        title: `This ${noun} belongs to a different request`,
        message:
          "The current desktop request was left intact. Return to the device that started this link, or request another one here.",
      };
    case "not_requested":
      return {
        eyebrow: "Unrecognized request",
        title: `This ${noun} was not requested from this app`,
        message:
          "Start again from this device, or continue using another sign-in method.",
      };
    case "expired":
      return {
        eyebrow: "Link expired",
        title: `This ${noun} has expired`,
        message: "Request a fresh link to continue.",
      };
    case "already_used":
      return {
        eyebrow: "Link already used",
        title: `This one-time ${noun} has already been used`,
        message:
          "If you already completed the action, sign in normally. Otherwise request a fresh link.",
      };
    case "expired_or_used":
      return {
        eyebrow: "Link no longer active",
        title: `This ${noun} has expired or has already been used`,
        message:
          "One-time links cannot be replayed. Request a fresh link to continue.",
      };
    case "wrong_workspace":
      return {
        eyebrow: "Access changed",
        title: "Your account no longer has access to this workspace",
        message:
          "Sign in with another account or ask a workspace administrator to restore access.",
      };
    case "rate_limited":
      return {
        eyebrow: "Try again shortly",
        title: "Too many link attempts",
        message:
          "Wait a few minutes before retrying or requesting another link.",
      };
    case "temporary_failure":
      return {
        eyebrow: "Temporary problem",
        title: `Moosewave could not finish this ${noun}`,
        message:
          "Your request may still be valid. Check your connection and retry once, or request a fresh link.",
      };
    case "invalid_link":
    default:
      return {
        eyebrow: "Invalid link",
        title: `This ${noun} is incomplete or altered`,
        message:
          "For your security, Moosewave did not use it. Request a fresh link to continue.",
      };
  }
}
