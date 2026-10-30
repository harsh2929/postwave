/**
 * lib/signInForm.ts — the decisions the sign-in screen makes, with no React,
 * no react-native and no expo-router anywhere near them.
 *
 * WHY (MAP#53). The audit's real complaint about `app/(auth)/sign-in.tsx` was
 * not its length but its testability: the credential/method branching was the
 * largest piece of logic on the auth path that could not be exercised in the
 * node vitest environment, because reaching it meant importing a route module
 * that pulls in the whole native runtime. Line count is a symptom. Everything
 * below is the actual decision table — which field is wrong, what the button
 * says, whether it is tappable, which workspaces are usable — and it is
 * covered by signInForm.test.ts.
 *
 * The screen keeps focus, announcements, network and navigation. Those need a
 * device. Deciding what to say does not.
 */

export type SignInMethod = "password" | "magic";

export const SIGN_IN_METHODS: readonly {
  value: SignInMethod;
  label: string;
}[] = [
  { value: "password", label: "Password" },
  { value: "magic", label: "Email link" },
];

/**
 * Lightweight client-side email sanity check. The backend remains the source
 * of truth; this only catches obvious typos (missing @ / domain) before we
 * spend a round-trip and show the user a generic 400.
 *
 * Shared by sign-in and sign-up, which had byte-identical private copies — an
 * address accepted at sign-up must be accepted at sign-in, and two copies of a
 * predicate is exactly how that stops being true.
 */
export function isLikelyEmail(value: string): boolean {
  const v = value.trim();
  if (v.length > 320 || /\s/u.test(v)) return false;
  const at = v.indexOf("@");
  if (at <= 0 || at !== v.lastIndexOf("@")) return false;
  const domain = v.slice(at + 1);
  return domain.length >= 3 && domain.includes(".") && !domain.endsWith(".");
}

/**
 * A type alias, not an interface, on purpose: the screen passes this straight
 * into `setFieldErrors(…, Record<string, string | undefined>)`, and TypeScript
 * gives an implicit index signature to aliases but not to interfaces.
 */
export type CredentialProblems = {
  email?: string | undefined;
  password?: string | undefined;
};

/**
 * Reports EVERY empty/malformed credential field at once. Fixing one blank
 * field only to be told about the next is the classic one-error-at-a-time
 * form, and on a phone each round trip costs a keyboard dismissal.
 *
 * `skipEmailShape` is set once the server has answered `needs_workspace`: it
 * has already accepted the address, so re-litigating its shape locally could
 * strand a user on a valid account whose address our regex dislikes.
 */
export function credentialProblems(input: {
  email: string;
  password: string;
  skipEmailShape: boolean;
}): CredentialProblems {
  const email = !input.email.trim()
    ? "Enter your email address"
    : !input.skipEmailShape && !isLikelyEmail(input.email)
      ? "That doesn't look like an email address"
      : undefined;
  const password = input.password ? undefined : "Enter your password";
  return {
    ...(email ? { email } : {}),
    ...(password ? { password } : {}),
  };
}

/** The magic-link path validates one field, and phrases it as a destination. */
export function magicLinkEmailProblem(email: string): string | undefined {
  if (!email.trim()) return "Enter the address to send the link to";
  if (!isLikelyEmail(email)) return "That doesn't look like an email address";
  return undefined;
}

/**
 * Drops entries a picker could not act on. A malformed `needs_workspace`
 * payload would otherwise render an empty list behind a permanently disabled
 * button — a dead end with no error and no way back.
 */
export function usableWorkspaces<T extends { tenant_id?: string | undefined }>(
  workspaces: readonly (T | null | undefined)[],
): T[] {
  return workspaces.filter((w): w is T => Boolean(w && w.tenant_id));
}

/**
 * The single workspace a picker should pre-select. One choice is not a choice;
 * making the user tap it adds a step that can only have one outcome.
 */
export function autoSelectedWorkspace<
  T extends { tenant_id?: string | undefined },
>(workspaces: readonly T[]): string {
  const only = workspaces.length === 1 ? workspaces[0] : undefined;
  return only?.tenant_id ?? "";
}

export interface SignInSubmitState {
  label: string;
  /** Spoken label; differs from `label` whenever the label hides state. */
  accessibilityLabel: string;
  disabled: boolean;
}

/**
 * What the primary button says and whether it can be tapped.
 *
 * The countdown case is the one that has to be spelled out for a screen
 * reader: "Try again in 43s" is read as "43 s", and a label that changes every
 * second under an `accessibilityLabel` that does not is worse than either.
 */
export function signInSubmitState(input: {
  method: SignInMethod;
  busy: boolean;
  localCleanupPending: boolean;
  resendSeconds: number;
  needsWorkspace: boolean;
  pickedWorkspace: string;
}): SignInSubmitState {
  const coolingDown = input.resendSeconds > 0;
  if (input.method === "magic") {
    const label = coolingDown
      ? `Try again in ${input.resendSeconds}s`
      : "Send sign-in link";
    return {
      label,
      accessibilityLabel: coolingDown
        ? `Sign-in link available again in ${input.resendSeconds} seconds`
        : label,
      disabled: input.busy || input.localCleanupPending || coolingDown,
    };
  }
  const label = input.needsWorkspace ? "Continue" : "Sign in";
  return {
    label,
    accessibilityLabel: label,
    disabled:
      input.busy ||
      input.localCleanupPending ||
      (input.needsWorkspace && !input.pickedWorkspace),
  };
}
