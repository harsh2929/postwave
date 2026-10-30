/**
 * stepUp — MOBILE'S BINDING of the shared step-up protocol.
 *
 * The wire contract, the challenge parser and the one-prompt-at-a-time broker
 * live in `@postwave/step-up` (the client half of `apps/api/internal/stepup`).
 * This file is only the delivery mechanism, because React Native has no
 * `window` and no `CustomEvent`: prompts go through a small listener registry
 * instead of a DOM event, and the mounted `<StepUpPrompt>` subscribes to it.
 *
 * WHY MOBILE NEEDS THIS. `createMfaAwareFetch` runs `interceptExpiredSession`
 * on every 401, and `isExpiredSessionResponse` treats a 401 with NO readable
 * error code as an expired session — which signs the user out. A step-up
 * challenge whose body a proxy stripped, or whose body the clone could not
 * read, is exactly that shape. So mounting the server's gate without this file
 * would sign a mobile user out of a live session for asking to rotate an API
 * key. Even when the body does survive, the request still just fails with a raw
 * SDK error and no way to answer.
 *
 * NO REACT-NATIVE IMPORTS IN THIS FILE. Mobile's vitest runs in a NODE
 * environment, and the moment a lib module reaches react-native no `.test.ts`
 * can import it. Keeping the protocol binding pure is what lets the transport
 * tests exist at all.
 */

import {
  createStepUpBroker,
  createStepUpPromptBus,
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

const bus = createStepUpPromptBus();

const broker = createStepUpBroker({
  // With nothing subscribed there is no UI to answer with, so do not even open
  // a prompt slot: the transport should surface the server's own 401 instead of
  // waiting on a dialog that will never appear.
  isAvailable: () => bus.listenerCount > 0,
  deliver: (detail: StepUpPromptDetail) => bus.publish(detail),
});

/**
 * Subscribe to step-up prompts. Returns an unsubscribe function.
 *
 * `<StepUpPrompt>` calls this once from the root layout. A listener MUST call
 * `detail.claim()` before rendering and `detail.settle()` exactly once, or the
 * challenged request never resolves.
 */
export function onStepUpPrompt(
  listener: (detail: StepUpPromptDetail) => void,
): () => void {
  return bus.subscribe(listener);
}

/**
 * Ask the mounted prompt for a fresh possession proof.
 *
 * Resolves true when the user re-proved (the caller may retry), false when they
 * cancelled or when nothing is rendering a prompt. Never rejects: a failure to
 * prompt must surface as the original server error, not a second unrelated one.
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
