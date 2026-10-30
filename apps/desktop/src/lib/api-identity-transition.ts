import type { ApiErr } from "./api/result";

export const PENDING_WORKSPACE_SWITCH_STORAGE_KEY =
  "postwave.desktop.workspace-switch.v1";

export function hasPendingWorkspaceSwitch(): boolean {
  return (
    window.localStorage.getItem(PENDING_WORKSPACE_SWITCH_STORAGE_KEY) !== null
  );
}

export function pendingWorkspaceSwitchIsKnownAbsent(): boolean {
  try {
    return !hasPendingWorkspaceSwitch();
  } catch {
    return false;
  }
}

export interface ApiIdentityTransitionToken {
  readonly generation: number;
}

let generation = 0;
let activeTransition: ApiIdentityTransitionToken | null = null;
let requestAbortController = new AbortController();

/** Invalidate old dispatch and reject new dispatch until source rollback. */
export function beginApiIdentityTransition(): ApiIdentityTransitionToken {
  if (activeTransition) {
    throw new Error("An API identity transition is already in progress.");
  }
  generation += 1;
  const token = Object.freeze({ generation });
  activeTransition = token;
  requestAbortController.abort("api-identity-transition");
  requestAbortController = new AbortController();
  return token;
}

export function releaseApiIdentityTransition(
  token: ApiIdentityTransitionToken,
): void {
  if (!activeTransition || activeTransition.generation !== token.generation) {
    throw new Error("API identity transition token is stale.");
  }
  activeTransition = null;
}

export function captureApiIdentityGeneration(): number | null {
  return activeTransition ? null : generation;
}

export function apiIdentityGenerationIsCurrent(value: number): boolean {
  return activeTransition === null && value === generation;
}

export function apiIdentityTransitionError(
  code: "identity_transition" | "identity_changed",
  preservedDraft?: unknown,
): ApiErr {
  return {
    error: {
      kind: "network",
      code,
      message:
        code === "identity_transition"
          ? "Workspace identity is changing. Retry after the transition finishes."
          : "This response belongs to the previous workspace and was discarded.",
    },
    retryability: "not-retryable",
    ...(preservedDraft === undefined ? {} : { preservedDraft }),
  };
}

export function apiIdentitySignal(caller: AbortSignal | null): AbortSignal {
  const transition = requestAbortController.signal;
  if (!caller || caller === transition) return transition;
  return AbortSignal.any([caller, transition]);
}

export function resetApiIdentityTransitionForTests(): void {
  requestAbortController.abort("test-reset");
  requestAbortController = new AbortController();
  generation = 0;
  activeTransition = null;
}
