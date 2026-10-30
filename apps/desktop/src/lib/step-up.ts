// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Step-up re-authentication — DESKTOP'S BINDING of the shared protocol.
 *
 * The wire contract, the challenge parser and the one-prompt-at-a-time broker
 * live in `@postwave/step-up` (the client half of `apps/api/internal/stepup`).
 * This file is only the delivery mechanism: the Tauri shell is a WebView, so a
 * DOM `CustomEvent` on `window` is the same seam web uses and the same seam the
 * rest of this app's cross-cutting UI could use.
 *
 * WHY DESKTOP NEEDS THIS AT ALL, IN ONE SENTENCE: `api-client.ts` fires
 * `fireUnauthorized()` on EVERY 401 except the `/auth/me` boot probe, and the
 * registered listener is `<AuthGate>`, which wipes `me` and re-renders the
 * SignIn screen. Mounting the server's gate without this file would turn
 * "confirm it's you before rotating an API key" into "you have been signed
 * out", on the surface where the user is most likely to be halfway through a
 * long piece of work.
 *
 * THE HEADER IS PROBABLY INVISIBLE HERE. The shell fetches from
 * `tauri://localhost`, which is cross-origin to the API, and CORS drops every
 * response header that is not in `Access-Control-Expose-Headers`.
 * `X-Postwave-Step-Up` is not in `browserExposedResponseHeaders` in
 * apps/api/main.go today — so on desktop, detection rests on the BODY code
 * (`step_up_required`), which the shared parser accepts on its own for exactly
 * this reason. Adding the header to that list is a real improvement, not a
 * prerequisite.
 */

import {
  STEP_UP_PROMPT_EVENT,
  createStepUpBroker,
  type StepUpChallenge,
  type StepUpPromptDetail,
} from "@postwave/step-up";

export {
  DEFAULT_STEP_UP_REASON,
  STEP_UP_CODE,
  STEP_UP_HEADER,
  STEP_UP_PROMPT_EVENT,
  formatStepUpAction,
  parseStepUpChallenge,
} from "@postwave/step-up";
export type { StepUpChallenge, StepUpPromptDetail } from "@postwave/step-up";

const broker = createStepUpBroker({
  // Several desktop test suites exercise the api-client under a node
  // environment with only a stub `window` and no `dispatchEvent`. Treating that
  // as "no prompt available" makes the transport throw the server's own 401,
  // which is the correct outcome when there is no UI to answer with.
  isAvailable: () =>
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function" &&
    typeof CustomEvent === "function",
  deliver: (detail: StepUpPromptDetail) => {
    window.dispatchEvent(
      new CustomEvent<StepUpPromptDetail>(STEP_UP_PROMPT_EVENT, { detail }),
    );
  },
});

/**
 * Ask the mounted prompt for a fresh possession proof.
 *
 * Resolves true when the user re-proved (the caller may retry), false when they
 * cancelled or when nothing is rendering a prompt. Never rejects.
 */
export function requestStepUpProof(
  challenge: StepUpChallenge,
): Promise<boolean> {
  return broker.request(challenge);
}

/** Test seam — forgets any prompt still believed to be open. */
export function resetStepUpState(): void {
  broker.reset();
}

/**
 * Whether this request can be sent a second time byte-for-byte.
 *
 * A `ReadableStream` body is consumed by the first attempt, so retrying it
 * would send an empty body and turn a prompt into silent data loss. Every other
 * shape desktop puts on the wire (string, FormData, Blob, URLSearchParams,
 * ArrayBuffer) can be re-read.
 */
export function isReplayableRequestBody(body: BodyInit | null | undefined): boolean {
  if (body === undefined || body === null) return true;
  return !(
    typeof ReadableStream !== "undefined" && body instanceof ReadableStream
  );
}
