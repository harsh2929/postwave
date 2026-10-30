// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Step-up re-authentication — WEB'S BINDING of the shared protocol.
 *
 * The protocol itself (wire contract, challenge parsing, the one-prompt-at-a-
 * time broker, and the long-form reasoning about why the header matters more
 * than the status and why the re-proof goes to `/totp/verify`) now lives in
 * `@postwave/step-up`, because desktop and mobile have to answer the very same
 * challenge and the server's gate cannot be mounted until all three do. This
 * file is the ~20 lines that are genuinely web-specific: delivery over a DOM
 * `CustomEvent` on `window`.
 *
 * Everything the app imported from here still resolves from here, with the same
 * names and the same behaviour — call sites and the pinned tests in
 * `src/__tests__/step-up-challenge.test.ts` did not change, which is the point:
 * this was a move, not a redesign.
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

/**
 * Web delivers a prompt as a `CustomEvent` on `window`, which `StepUpPrompt`
 * (mounted once in the dashboard shell) listens for.
 *
 * `isAvailable` is the server-render guard: Next renders this transport's call
 * sites on the server, where there is no window to dispatch to and no human to
 * answer. Without it a server-side challenge would be delivered to nobody and
 * the broker's unclaimed path would be the only thing saving the request.
 */
const broker = createStepUpBroker({
  isAvailable: () => typeof window !== "undefined",
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
 * cancelled, when nothing is listening, or when there is no window at all.
 * Never rejects: a failure to prompt must surface as the original server error,
 * not as a second unrelated one.
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
