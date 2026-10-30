/**
 * lib/signInFlow.ts — the ORDER in which sign-in refuses to submit.
 *
 * WHY THIS EXISTS (MAP#53, second half). `signInForm.ts` already held the
 * per-field decision table ("is this address shaped like one", "what does the
 * button say"). What stayed trapped inside the route module was the sequence:
 * which check runs first, which failure wins when two are true at once, and
 * which of them is even allowed to reach the network. That sequence is the
 * part with real consequences —
 *
 *   - a blank-password submit that reached the network would burn one of the
 *     account's rate-limited attempts for nothing;
 *   - an offline check placed BEFORE the field check tells a user with an
 *     empty form to reconnect, which is not their problem;
 *   - a base-URL check placed AFTER the network call means a self-hosted
 *     operator's typo is reported as a connection failure.
 *
 * None of that could be exercised in the node vitest environment while it
 * lived in `app/(auth)/sign-in.tsx`, because reaching it meant importing a
 * route module that pulls react-native and expo-router. It is here instead,
 * and signInFlow.test.ts pins the order.
 *
 * IMPORT DISCIPLINE: only `./config` (env + URL parsing, no imports of its
 * own) and `./signInForm` (pure). Nothing here may import react-native,
 * expo-*, or `@/api/*`. The offline verdict is returned as a KIND rather than
 * as copy precisely so this module does not have to reach into
 * `authErrorCopy`, which imports the API client.
 */

import { validateApiBaseUrl } from "./config";
import {
  autoSelectedWorkspace,
  credentialProblems,
  magicLinkEmailProblem,
  usableWorkspaces,
  type CredentialProblems,
} from "./signInForm";

/**
 * Visual order of the credential fields. Decides which control gets focus and
 * which single message is spoken after a failed submit, so it belongs beside
 * the decisions rather than beside the JSX.
 */
export const SIGN_IN_FIELD_ORDER = ["email", "password"] as const;

/** Copy for the one form-level refusal that is not an API error. */
export const PICK_WORKSPACE_MESSAGE = "Select a workspace to continue";

/** Copy for a `needs_workspace` payload with nothing selectable in it. */
export const UNUSABLE_WORKSPACES_MESSAGE =
  "Couldn't load your workspaces. Please try again.";

/**
 * Appended when SecureStore refused to drop a pending magic-link nonce. The
 * user's fix is to unlock the device, which no API error string would tell
 * them, so it rides along with whatever the real failure was.
 */
export const PENDING_CLEANUP_SUFFIX =
  " Secure device cleanup is pending; unlock the device and try again.";

/**
 * A submit verdict.
 *
 * `offline` is deliberately distinct from `form`: the screen also emits
 * failure telemetry for it, and collapsing the two would make the telemetry
 * depend on string matching.
 */
export type SignInPreflight =
  /** Per-field captions; focus moves to the first one in visual order. */
  | { kind: "fields"; problems: CredentialProblems }
  /** No connection. Caller renders OFFLINE_COPY and counts a failure. */
  | { kind: "offline" }
  /** A refusal that belongs to the submit as a whole. */
  | { kind: "form"; message: string }
  /** The server address is unusable; the collapsed field must be revealed. */
  | { kind: "baseUrl"; message: string }
  /** Cleared to call the API against this normalised base URL. */
  | { kind: "ready"; baseUrl: string };

/**
 * Password submit. Order, and why each step is where it is:
 *
 *   1. FIELDS first — a local problem must never cost a network round trip or
 *      a rate-limit attempt, and it is the only failure the user can fix
 *      without leaving the form.
 *   2. WORKSPACE second — reached only after the server has already accepted
 *      the credentials once, so it outranks the connectivity guard: a user
 *      who dropped offline mid-flow should be told which step they are on.
 *   3. OFFLINE third.
 *   4. BASE URL last, because it is the only check whose failure the user
 *      cannot see (the field is collapsed by default) and reporting it when a
 *      simpler problem is also present would send them to the wrong control.
 *
 * `skipEmailShape` is set once `needs_workspace` has come back: the server has
 * already accepted that address, so re-litigating its shape locally could
 * strand a user on a valid account our regex dislikes.
 */
export function passwordPreflight(input: {
  email: string;
  password: string;
  online: boolean;
  baseUrl: string;
  needsWorkspace: boolean;
  pickedWorkspace: string;
}): SignInPreflight {
  const problems = credentialProblems({
    email: input.email,
    password: input.password,
    skipEmailShape: input.needsWorkspace,
  });
  if (problems.email || problems.password) return { kind: "fields", problems };
  if (input.needsWorkspace && !input.pickedWorkspace) {
    return { kind: "form", message: PICK_WORKSPACE_MESSAGE };
  }
  if (!input.online) return { kind: "offline" };
  return baseUrlVerdict(input.baseUrl);
}

/**
 * Magic-link submit. One field, and its message names the DESTINATION ("the
 * address to send the link to") rather than the credential, because at this
 * point the user is not proving anything — they are choosing a mailbox.
 */
export function magicLinkPreflight(input: {
  email: string;
  online: boolean;
  baseUrl: string;
}): SignInPreflight {
  const email = magicLinkEmailProblem(input.email);
  if (email) return { kind: "fields", problems: { email } };
  if (!input.online) return { kind: "offline" };
  return baseUrlVerdict(input.baseUrl);
}

/**
 * What to do with a `needs_workspace` response.
 *
 * A payload whose entries all lack a `tenant_id` would otherwise render an
 * empty radio list behind a permanently disabled Continue button: a dead end
 * with no message and no way back to the credentials. It is reported as a
 * form-level failure instead, which leaves the form editable.
 */
export type WorkspaceStep<T> =
  | { kind: "pick"; workspaces: T[]; selected: string }
  | { kind: "form"; message: string };

export function workspaceStep<T extends { tenant_id?: string | undefined }>(
  raw: readonly (T | null | undefined)[],
): WorkspaceStep<T> {
  const workspaces = usableWorkspaces(raw);
  if (workspaces.length === 0) {
    return { kind: "form", message: UNUSABLE_WORKSPACES_MESSAGE };
  }
  return {
    kind: "pick",
    workspaces,
    selected: autoSelectedWorkspace(workspaces),
  };
}

function baseUrlVerdict(raw: string): SignInPreflight {
  const valid = validateApiBaseUrl(raw);
  return valid.ok
    ? { kind: "ready", baseUrl: valid.url }
    : { kind: "baseUrl", message: valid.message };
}

/**
 * Attaches the unlock-your-device hint to a failure message when the pending
 * magic-link nonce could NOT be cleared. Silence there would leave a live
 * one-time nonce on the device with nothing on screen explaining why the next
 * attempt behaves oddly.
 */
export function withCleanupSuffix(message: string, cleared: boolean): string {
  return cleared ? message : `${message}${PENDING_CLEANUP_SUFFIX}`;
}
