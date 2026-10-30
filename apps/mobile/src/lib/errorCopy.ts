/**
 * lib/errorCopy.ts — turning a thrown error into copy a user can act on.
 *
 * `ErrorState` accepted an `error` prop and IGNORED it: every failure produced
 * one of two strings and the same "Try again" button. So a 403 permission
 * denial, a 429 rate limit and a 500 all read identically, and users retried
 * things that could never succeed — the retry button on a 403 is a lie the
 * product tells forever.
 *
 * The original intent (never show a raw server error verbatim) is right and is
 * preserved: this maps STATUS CODES to human copy and never echoes the message.
 * The ONE exception is the runtimecapability envelope, whose message is static
 * product-contract data by design — see below.
 *
 * Status codes are the FALLBACK, though, not the first answer. When the server
 * classified the refusal (apps/api/internal/entitlement), status is the wrong
 * key: `role`, `flag` and `policy` are all 403 and need three different next
 * steps, and a `plan` ceiling's 402 matched no arm here at all. The denial
 * class is read first — see `denialEnvelope`.
 */
import {
  capabilityUnavailableMessage,
  isCapabilityUnavailable,
  type CapabilityAwareError,
} from "./capabilityEnvelope";
import {
  denialPresentation,
  type ApiDenial,
  type DenialAwareError,
} from "./denialEnvelope";

export interface ErrorPresentation {
  message: string;
  /** False when retrying cannot possibly help — the button is then hidden. */
  retryable: boolean;
}

/** Pull the server's classified refusal off a thrown error or an `AIApiError`.
 *  Both carry it under the same key — `checkedApiResult` re-tags it onto the
 *  rejection so a mutation's `onError` sees what a query's error state sees. */
export function denialOf(error: unknown): ApiDenial | undefined {
  if (!error || typeof error !== "object") return undefined;
  return (error as DenialAwareError).denial;
}

/** Pull a numeric status off a thrown error, mirroring api/request.ts. */
export function statusOf(error: unknown): number {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return 0;
}

/** True for a 2xx body this client could not read (lib/wireShapeError). Read
 *  off the error's own `code`, as statusOf reads `status`, so this module
 *  imports nothing from api/ and stays node-pure. */
function isWireShape(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "wire_shape"
  );
}

/** The server's own sentence, when it sent one. Only read for the capability
 *  envelope, whose message is static product-contract data. */
function messageOf(error: unknown): string | undefined {
  if (error instanceof Error && error.message.trim()) return error.message;
  return undefined;
}

export interface ErrorCopyOptions {
  /** Explicit override from the caller. Always wins. */
  explicit?: string | undefined;
  /** Result of `isProbablyOnline()`. Injected so this module stays pure. */
  online?: boolean;
}

export function errorPresentation(
  error: unknown,
  { explicit, online = true }: ErrorCopyOptions = {},
): ErrorPresentation {
  if (explicit) return { message: explicit, retryable: true };

  const status = statusOf(error);

  // Auth/permission verdicts are deterministic: the same request will produce
  // the same answer a second later, so offering a retry wastes the user's time.
  if (status === 401) {
    return {
      message: "Your session has expired. Sign in again to continue.",
      retryable: false,
    };
  }
  // A CLASSIFIED refusal beats the status table, because status cannot tell
  // these apart. Checked after 401 only: an expired session is about the
  // credential rather than the entitlement, and the server never classifies it.
  const denial = denialOf(error);
  if (denial) return denialPresentation(denial);

  // Unclassified 403 — a handler that predates the denial contract, or a proxy
  // that ate the body. The generic advice is the best available answer here,
  // and is now reached only when the server really did not say why.
  if (status === 403) {
    return {
      message:
        "You don't have access to this. Ask a workspace administrator if you need it.",
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      message: "This no longer exists. It may have been deleted or moved.",
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      message: "Too many requests — wait a moment and try again.",
      retryable: true,
    };
  }

  // A deliberately disabled runtime (apps/api/internal/runtimecapability) is a
  // 503, so without this it fell into the generic 5xx branch below and got
  // "the server had a problem — please try again" plus a Retry button. Both
  // halves are wrong: nothing is broken, and `retryable` is false BY CONTRACT.
  if (isCapabilityUnavailable(error)) {
    const e = error as CapabilityAwareError & { capability: string };
    return {
      message: capabilityUnavailableMessage(
        {
          capability: e.capability,
          runtimeStatus: e.runtimeStatus ?? "unavailable",
          retryable: false,
        },
        messageOf(error),
      ),
      retryable: false,
    };
  }

  // A body arrived and this app version could not read it: rolling-deploy
  // drift or a truncated body, not a dropped connection. It is a received
  // response, so it comes before the offline check. Retry stays, because a
  // retry clears the transient cases (a non-JSON captive-portal page never
  // gets here; the SDK raises ParseError for that).
  if (isWireShape(error)) {
    return {
      message:
        "Moosewave sent a response this version of the app can't read. If this keeps happening, update the app.",
      retryable: true,
    };
  }

  // A connectivity check only makes sense once a specific server verdict has
  // been ruled out: a 403 received while online is not an offline problem.
  if (!online) {
    return {
      message: "You appear to be offline. Check your connection and try again.",
      retryable: true,
    };
  }

  if (status >= 500) {
    return {
      message: "The server had a problem with this request. Please try again.",
      retryable: true,
    };
  }
  return {
    message: "Something went wrong loading this. Please try again.",
    retryable: true,
  };
}
