/**
 * lib/connectionStatus.ts — the ONE derivation of "is this app talking to the
 * server, and under what credential".
 *
 * This rule used to live inline in app/(tabs)/more.tsx: fifteen lines of nested
 * ternaries computing a label and a colour that no other screen could reach. So
 * the only place in the app that admitted "you are looking at cached data" was a
 * dot on a card six sections down the More menu — a user on a stale session saw
 * identical chrome on every product screen.
 *
 * Deliberately import-free (no react-native, no store) so the rule is unit
 * testable in the node vitest environment and so a header, a card and a
 * diagnostics block can all read the same answer. Colour is expressed as a
 * semantic TONE, never a hex value: the caller maps it through the theme.
 */

/** Mirrors `AuthMode` in src/store/auth.ts. */
export type ConnectionMode = "session" | "api_key" | null;

/** Mirrors `SessionValidation` in src/store/auth.ts. */
export type ConnectionValidation =
  | "none"
  | "checking"
  | "validated_online"
  | "offline_cached";

export type ConnectionTone = "success" | "warning" | "info" | "neutral";

export interface ConnectionStatus {
  /** Short chrome label — fits a pill. */
  label: string;
  tone: ConnectionTone;
  /**
   * True only when the app is provably talking to the server right now. The
   * shell renders NO indicator in this state: healthy is the default and does
   * not deserve permanent chrome.
   */
  healthy: boolean;
  /**
   * What a screen reader says. State must never be colour-alone, and "Cached"
   * on its own does not explain the consequence.
   */
  spoken: string;
}

const HEALTHY_SESSION: ConnectionStatus = {
  label: "Session",
  tone: "success",
  healthy: true,
  spoken: "Connected with a live session",
};

const API_KEY: ConnectionStatus = {
  label: "API key",
  tone: "info",
  // An API key has no server-side validation handshake to fail, so there is no
  // "cached" state to warn about — it is as healthy as the network is.
  healthy: true,
  spoken: "Connected with an API key",
};

const SIGNED_OUT: ConnectionStatus = {
  label: "Offline",
  tone: "neutral",
  healthy: false,
  spoken: "Not connected",
};

const CHECKING: ConnectionStatus = {
  label: "Checking",
  tone: "warning",
  healthy: false,
  spoken: "Checking the connection to your workspace",
};

const CACHED: ConnectionStatus = {
  label: "Cached",
  tone: "warning",
  healthy: false,
  spoken: "Showing cached data — the server could not be reached",
};

export function connectionStatus(input: {
  mode: ConnectionMode;
  sessionValidation: ConnectionValidation;
}): ConnectionStatus {
  if (input.mode === "api_key") return API_KEY;
  if (input.mode !== "session") return SIGNED_OUT;
  switch (input.sessionValidation) {
    case "validated_online":
      return HEALTHY_SESSION;
    case "checking":
      return CHECKING;
    case "offline_cached":
      return CACHED;
    default:
      // "none" under mode === "session" is the brief window between hydrate
      // resolving the profile and the first revalidation being scheduled.
      // Reporting it as a hard "Offline" would flash a scary label on every
      // cold start, so it reads as the in-progress state it actually is.
      return CHECKING;
  }
}

/**
 * Should the app shell render a connection indicator at all?
 *
 * The healthy path deliberately renders nothing. OfflineBanner already made
 * this choice for hard-offline; this extends the same discipline to the softer
 * "cached / still checking" states that previously had no representation.
 */
export function shouldShowConnectionIndicator(
  status: ConnectionStatus,
): boolean {
  return !status.healthy && status.label !== SIGNED_OUT.label;
}
