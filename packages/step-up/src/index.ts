// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @postwave/step-up — the client half of `apps/api/internal/stepup`, once.
 *
 * THE WIRE CONTRACT (read from the Go source, not invented here). When a
 * high-risk route's possession proof has gone stale,
 * `stepup.Middleware.writeChallenge` answers:
 *
 *   HTTP 401                                   (policy.go `StatusCode`)
 *   X-Postwave-Step-Up: <action>               (middleware.go, the machine hint)
 *   {"error":{"code":"step_up_required",
 *             "action":"…","message":"…","max_age_seconds":N}}
 *                                              (policy.go `Requirement.Body`)
 *
 * WHY THE HEADER MATTERS MORE THAN THE STATUS. Every Moosewave client already
 * treats a 401 as a dead session — web dispatches `AUTH_SESSION_EXPIRED_EVENT`
 * and redirects to /login, desktop fires `onApiUnauthorized` and swaps in the
 * sign-in screen, mobile revalidates and signs out. Applied to a step-up
 * challenge that is the worst possible response: the session is perfectly
 * alive, and somebody exporting subscribers would be thrown out of the app for
 * what should have been a six-digit prompt. The server's own comment says it —
 * "the difference between showing a dialog and logging somebody out".
 *
 * That is also why this module exists as a PACKAGE rather than as a file in
 * apps/web. Mounting the middleware while only one client understood the header
 * would have converted every high-risk route into a logout on the other two, so
 * the protocol had to be identical on three surfaces before it could go live. A
 * protocol that must be identical on three surfaces should have one definition.
 *
 * IT IS NOW LIVE. `apps/api/main.go` mounts `stepup.Middleware` on the
 * authenticated router, and `mounted.test.ts` holds all three surfaces to
 * rendering a prompt component. Nothing here is dormant: a defect in this file
 * reaches real high-risk requests on web, desktop and mobile. (This header used
 * to say the middleware was "not mounted yet" — it outlived the mount, which is
 * exactly the kind of stale reassurance that makes a change here look safer
 * than it is.)
 *
 * WHY THE RE-PROOF GOES TO /totp/verify AND NOT /totp/challenge. Both endpoints
 * exist; only one of them can refresh freshness. `TOTPChallenge` short-circuits
 * with 200 `{already:true}` whenever `sess.MFASatisfied` is true — and a
 * step-up challenge is precisely the case where that flag is true but
 * `mfa_satisfied_at` is old. Re-proving through it would return success without
 * touching the timestamp, the retry would be challenged again, and the only
 * thing standing between the user and an endless prompt would be the retry
 * guard. `TOTPVerify` verifies a live code and calls `MarkSessionMFASatisfied`
 * unconditionally (`mfa_satisfied_at = now()`), which is the state change a
 * step-up needs. The consequence is deliberate: a recovery code cannot refresh
 * a step-up proof, because `/totp/verify` accepts authenticator codes only.
 *
 * NO DEPENDENCIES, NO DOM. React Native has no `window`, no `CustomEvent` and
 * no DOM `Headers` in every runtime path, so nothing here touches them: the
 * header reader accepts anything with `.get()` OR a plain record, and the
 * prompt broker is handed its delivery mechanism by the surface. Web and
 * desktop pass a `window.dispatchEvent`; mobile passes a listener registry.
 */

/** The machine-readable hint the middleware stamps. Lower-case: DOM `Headers.get` is case-insensitive, plain records are not, and this module normalises both. */
export const STEP_UP_HEADER = "x-postwave-step-up";

/** `stepup.ErrorBody.Code` — the envelope code that names this a prompt rather than a dead session. */
export const STEP_UP_CODE = "step_up_required";

/**
 * The event/topic name a surface uses to deliver a prompt.
 *
 * Lives here, with the protocol, because the string is a coupling between a
 * transport and a component that are in different directories on every
 * surface — exactly the kind of literal that drifts by one character and fails
 * silently (an unclaimed prompt looks like "nothing is listening", which this
 * module deliberately treats as "give up", not "hang").
 */
export const STEP_UP_PROMPT_EVENT = "postwave:step-up-required";

/**
 * Shown when the challenge body never arrived and only the header did.
 *
 * Deliberately generic. The real sentence is `Requirement.Reason`, written by
 * the server next to the policy it explains; re-deriving per-action copy from
 * the action id on the client would be the same rule in two places, and the
 * client's copy is the one that would be wrong.
 */
export const DEFAULT_STEP_UP_REASON = "Confirm it's you to continue.";

/** What the server asked for, in the words it chose. */
export interface StepUpChallenge {
  /** Stable action id from the header, e.g. `subscribers.export`. */
  action: string;
  /** The server's sentence for the person, e.g. "Confirm it's you before …". */
  reason: string;
  /** How fresh the proof must be, in seconds. Absent when the body was lost. */
  maxAgeSeconds?: number;
}

/**
 * The payload handed to whatever renders the prompt.
 *
 * A handshake rather than a bare notification, because the transport has to
 * know whether anybody is listening. A request that awaits a prompt nobody
 * renders — a marketing route, a server render, a background refresh with no
 * UI mounted, a test that forgot the provider — hangs until its timeout with
 * no error and no UI, which is a worse failure than the 401 it replaced.
 * `claim()` is the listener saying "I will show this and I will report back";
 * without it the transport gives up immediately and the original error is
 * thrown.
 */
export interface StepUpPromptDetail {
  challenge: StepUpChallenge;
  /** Take ownership of this prompt. Returns false if another listener already did. */
  claim(): boolean;
  /** Report the outcome. Only the first call counts. */
  settle(proved: boolean): void;
}

/** Anything a fetch Response's headers can be, across the three runtimes. */
export type StepUpHeaderSource =
  | { get(name: string): string | null }
  | Record<string, string | undefined>
  | null
  | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function readHeader(source: StepUpHeaderSource, name: string): string {
  if (!source) return "";
  const getter = (source as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = (source as { get(n: string): string | null }).get(name);
    return typeof value === "string" ? value : "";
  }
  const record = source as Record<string, string | undefined>;
  // A plain record is case-SENSITIVE, so try both spellings the server and any
  // intermediary might use rather than assuming the lower-case one survived.
  const direct = record[name] ?? record[name.toLowerCase()];
  if (typeof direct === "string") return direct;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name.toLowerCase() && typeof value === "string") {
      return value;
    }
  }
  return "";
}

interface StepUpEnvelope {
  code?: string;
  message?: string;
  action?: string;
  maxAgeSeconds?: number;
}

/**
 * Read the four fields this protocol needs out of an API error body.
 *
 * Scoped on purpose: this is NOT a second copy of `@postwave/errors`. It reads
 * `code`, `message`, `action` and `max_age_seconds` and nothing else, because
 * this package must stay dependency-free for React Native — pulling the full
 * envelope parser in would make the shared protocol drag a second package onto
 * a surface that does not otherwise have it. Every other field of the error
 * (request id, retry-after, field errors) is read by each surface's own error
 * layer, unchanged, from the same body.
 */
function readEnvelope(body: unknown): StepUpEnvelope {
  // A plain string body IS the message — some proxies and gateway timeouts
  // answer with raw text rather than the JSON envelope.
  if (typeof body === "string") return body ? { message: body } : {};

  const root = asRecord(body) ?? {};
  // The canonical envelope nests under `error`; a flat RFC-7807-shaped body
  // puts the same keys at the root. Both are read, so a proxy that unwraps the
  // envelope degrades to a correct prompt rather than to a logout.
  const env = asRecord(root.error) ?? root;

  const out: StepUpEnvelope = {};
  const code = str(env.code);
  if (code) out.code = code;
  const message =
    str(env.message) ?? str(root.message) ?? str(root.detail) ?? str(root.error);
  if (message) out.message = message;
  const action = str(env.action);
  if (action) out.action = action;
  const rawMaxAge = env.max_age_seconds ?? env.maxAgeSeconds;
  if (
    typeof rawMaxAge === "number" &&
    Number.isFinite(rawMaxAge) &&
    rawMaxAge > 0
  ) {
    out.maxAgeSeconds = rawMaxAge;
  }
  return out;
}

/**
 * Read a step-up challenge out of a response, or null if it is not one.
 *
 * Keyed on the header FIRST because that is what the middleware guarantees.
 * The body is the richer half (reason, max age) and is also accepted on its
 * own, so a proxy that strips unknown headers degrades to a correct prompt
 * rather than to a logout.
 *
 * THE BODY FALLBACK IS NOT HYPOTHETICAL ON DESKTOP. The Tauri shell fetches
 * from `tauri://localhost`, which is cross-origin to the API, and CORS hides
 * every response header not named in `Access-Control-Expose-Headers`.
 * `X-Postwave-Step-Up` is not in `browserExposedResponseHeaders` today, so on
 * desktop `headers.get()` returns null for it and the BODY is the only signal
 * there is.
 */
export function parseStepUpChallenge(
  status: number,
  headers: StepUpHeaderSource,
  body: unknown,
): StepUpChallenge | null {
  // 401, not 403 — see stepup.StatusCode. Matching the status as well as the
  // marker keeps this from firing on a stray header on some unrelated response.
  if (status !== 401) return null;
  const headerAction = readHeader(headers, STEP_UP_HEADER).trim();
  const env = readEnvelope(body);
  const bodyIsStepUp = env.code === STEP_UP_CODE;
  if (!headerAction && !bodyIsStepUp) return null;
  const bodyAction = env.action?.trim() ?? "";
  return {
    action: headerAction || bodyAction,
    reason: env.message || DEFAULT_STEP_UP_REASON,
    ...(env.maxAgeSeconds !== undefined
      ? { maxAgeSeconds: env.maxAgeSeconds }
      : {}),
  };
}

/**
 * Turn `subscribers.export` into `Subscribers · export` for display.
 *
 * A pure transform of the identifier, NOT a lookup table of per-action copy —
 * the human sentence is `challenge.reason` and it comes from the server. This
 * exists only so the action the user is re-authenticating for is legible
 * beside it instead of appearing as a raw enum.
 */
export function formatStepUpAction(action: string): string {
  const trimmed = action.trim();
  if (!trimmed) return "";
  return trimmed
    .split(".")
    .map((part) => part.replace(/_/g, " ").trim())
    .filter(Boolean)
    .map((part, index) =>
      index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part,
    )
    .join(" · ");
}

/** How a surface hands a prompt to whatever renders it. */
export interface StepUpBrokerOptions {
  /**
   * Deliver the prompt. Called SYNCHRONOUSLY, and the broker inspects
   * `claim()` the instant it returns — an asynchronous delivery would always
   * look unclaimed and every challenge would fail immediately.
   */
  deliver: (detail: StepUpPromptDetail) => void;
  /**
   * Whether a prompt can be shown at all right now. Web/desktop answer "is
   * there a window"; a surface with no UI mounted answers false and the
   * transport throws the server's own 401 instead of waiting on nobody.
   */
  isAvailable?: () => boolean;
}

export interface StepUpBroker {
  /**
   * Ask for a fresh possession proof.
   *
   * Resolves true when the user re-proved (the caller may retry), false when
   * they cancelled, when nothing is listening, or when prompting is
   * unavailable. NEVER REJECTS: a failure to prompt must surface as the
   * original server error, not as a second unrelated one.
   */
  request(challenge: StepUpChallenge): Promise<boolean>;
  /** Test seam — forgets any prompt still believed to be open. */
  reset(): void;
  /** True while a prompt raised through this broker is unanswered. */
  readonly pending: boolean;
}

/**
 * One prompt at a time, shared by every request challenged while it is open.
 *
 * Sharing is not just an ergonomic choice — it is correct. A successful proof
 * sets `mfa_satisfied_at = now()` on the SESSION, so it satisfies every
 * requirement in the policy at once, whatever action each challenged request
 * was for. Prompting per request would ask for two codes to authorise one
 * moment of presence, and the second code would already be redundant.
 */
export function createStepUpBroker(options: StepUpBrokerOptions): StepUpBroker {
  let inFlight: Promise<boolean> | null = null;

  return {
    get pending(): boolean {
      return inFlight !== null;
    },
    reset(): void {
      inFlight = null;
    },
    request(challenge: StepUpChallenge): Promise<boolean> {
      // `isAvailable` is supplied by the surface and typically touches host
      // globals (`typeof window`, a navigation ref, a mount registry). A throw
      // there must mean "cannot prompt", not become a second error stacked on
      // the 401 the caller is already holding — this method's contract is that
      // it never rejects.
      if (options.isAvailable) {
        let available: boolean;
        try {
          available = options.isAvailable();
        } catch {
          available = false;
        }
        if (!available) return Promise.resolve(false);
      }
      if (inFlight) return inFlight;

      let claimed = false;
      let settled = false;
      let resolveProof: (proved: boolean) => void = () => {};
      const promise = new Promise<boolean>((resolve) => {
        resolveProof = resolve;
      });
      const detail: StepUpPromptDetail = {
        challenge,
        claim: () => {
          if (claimed) return false;
          claimed = true;
          return true;
        },
        settle: (proved: boolean) => {
          if (settled) return;
          settled = true;
          resolveProof(proved);
        },
      };
      inFlight = promise;
      const clear = (): void => {
        if (inFlight === promise) inFlight = null;
      };
      void promise.then(clear, clear);

      // A throwing `deliver` must not escape, and must not leave `inFlight`
      // set. Both were possible: the exception propagated out of request() —
      // breaking the never-rejects contract stated on the interface — and
      // because settle() was skipped, the promise never resolved, `clear()`
      // never ran, and `inFlight` stayed pointing at it FOREVER. Every later
      // step-up then returned that same dead promise, so each high-risk action
      // hung with no error and no prompt. That is precisely the failure the
      // claim/settle handshake exists to prevent, reached through the one path
      // the handshake did not cover.
      //
      // Settled unconditionally when delivery threw, even if the listener had
      // already claimed: a delivery that blew up part-way cannot be trusted to
      // report back, and an unanswered claim wedges the broker just as surely.
      let deliveryFailed = false;
      try {
        options.deliver(detail);
      } catch {
        deliveryFailed = true;
      }
      if (deliveryFailed || !claimed) {
        // Nobody is rendering a prompt. Fail now and let the caller throw the
        // 401 it already has, rather than leaving the request pending forever.
        detail.settle(false);
      }
      return promise;
    },
  };
}

/**
 * A minimal listener registry, for a surface with no DOM event bus.
 *
 * React Native is the reason this exists: `window.dispatchEvent` is how web and
 * desktop deliver a prompt, and there is no equivalent in RN. The semantics are
 * the ones the broker relies on — synchronous delivery, and errors in one
 * listener isolated so a throwing subscriber cannot take down the transport.
 */
export interface StepUpPromptBus {
  subscribe(listener: (detail: StepUpPromptDetail) => void): () => void;
  publish(detail: StepUpPromptDetail): void;
  readonly listenerCount: number;
}

export function createStepUpPromptBus(): StepUpPromptBus {
  const listeners = new Set<(detail: StepUpPromptDetail) => void>();
  return {
    get listenerCount(): number {
      return listeners.size;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(detail) {
      for (const listener of [...listeners]) {
        try {
          listener(detail);
        } catch {
          // A prompt renderer that throws must not become a transport failure;
          // the unclaimed prompt already degrades to "throw the server's 401".
        }
      }
    },
  };
}
