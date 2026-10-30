/**
 * securityChecklist — compose the protections the app already knows about into
 * one answer to "is this account actually protected?".
 *
 * Every input here was already on the device: `totp_enabled` and
 * `email_verified` come off /me into the session profile, and the app-lock
 * preference is a local SecureStore read. Neither mobile nor web ever composed
 * them — web's security page is a flat stack of independent cards — so the user
 * had to visit three controls and hold the answer in their head.
 *
 * TWO RULES MAKE THIS A CHECKLIST RATHER THAN A NAG:
 *
 *  1. A protection the DEVICE cannot provide is "unavailable", not "off", and
 *     it leaves the denominator. A phone with no passcode and no biometrics can
 *     never satisfy app lock, and scoring it 2/3 forever teaches the user to
 *     ignore the card.
 *  2. Every unmet row states the next action in words. "Off" with no verb is
 *     an accusation, not a checklist.
 *
 * Pure and import-free so the scoring rules are testable in the node
 * environment (a module that reaches react-native or expo-secure-store cannot
 * be — see src/lib/approvalPolicy.ts for the same split).
 */

export type SecurityProtectionKey =
  | "two_factor"
  | "email_verified"
  | "app_lock";

export type SecurityProtectionStatus = "on" | "off" | "unavailable";

export interface SecurityProtection {
  key: SecurityProtectionKey;
  label: string;
  status: SecurityProtectionStatus;
  /** The next action, in words. Empty once the protection is satisfied. */
  action: string;
  /**
   * The state as a full spoken phrase. The visible row pairs a glyph with a
   * two-letter word; neither is a sentence, and state must never be carried by
   * colour or icon alone.
   */
  spoken: string;
}

export interface SecurityChecklistInput {
  /** /me `totp_enabled`, via the session profile. */
  totpEnabled: boolean;
  /** /me `email_verified`, via the session profile. */
  emailVerified: boolean;
  /** Local preference — biometric/passcode gate over the authenticated app. */
  appLockEnabled: boolean;
  /**
   * Whether device-owner authentication exists at all. False on a device with
   * no passcode and no enrolled biometrics, where app lock is unachievable.
   */
  appLockCapable: boolean;
}

export interface SecurityChecklistScore {
  on: number;
  /** Excludes protections this device cannot provide. */
  total: number;
  complete: boolean;
}

function protection(
  key: SecurityProtectionKey,
  label: string,
  on: boolean,
  action: string,
  onSpoken: string,
): SecurityProtection {
  return {
    key,
    label,
    status: on ? "on" : "off",
    action: on ? "" : action,
    spoken: on ? onSpoken : `${label}: off. ${action}`,
  };
}

export function securityChecklist(
  input: SecurityChecklistInput,
): readonly SecurityProtection[] {
  const appLock: SecurityProtection = !input.appLockCapable
    ? {
        key: "app_lock",
        label: "App lock",
        status: "unavailable",
        action: "",
        spoken:
          "App lock: unavailable. This device has no passcode or biometrics set up.",
      }
    : protection(
        "app_lock",
        "App lock",
        input.appLockEnabled,
        "Turn on App lock below so a found phone cannot open this workspace.",
        "App lock: on.",
      );

  return [
    protection(
      "two_factor",
      "Two-factor authentication",
      input.totpEnabled,
      "Add an authenticator app in Two-factor authentication below.",
      "Two-factor authentication: on.",
    ),
    protection(
      "email_verified",
      "Email verified",
      input.emailVerified,
      "Resend the verification email from your account details above.",
      "Email verified: yes.",
    ),
    appLock,
  ];
}

/** Unavailable protections leave the denominator — see rule 1 above. */
export function checklistScore(
  items: readonly SecurityProtection[],
): SecurityChecklistScore {
  const scored = items.filter((item) => item.status !== "unavailable");
  const on = scored.filter((item) => item.status === "on").length;
  return { on, total: scored.length, complete: scored.length > 0 && on === scored.length };
}

/**
 * The headline. Says the number out loud rather than compacting it, and states
 * completion as a fact instead of leaving "3 of 3" to be inferred.
 */
export function checklistSummary(score: SecurityChecklistScore): string {
  if (score.total === 0) return "No protections available on this device";
  if (score.complete) {
    return score.total === 1
      ? "1 of 1 protection on"
      : `All ${score.total} protections on`;
  }
  return `${score.on} of ${score.total} protection${score.total === 1 ? "" : "s"} on`;
}
