/**
 * lib/denialEnvelope.ts — the "you cannot do this, and here is why" contract,
 * parsed.
 *
 * The backend has one shape for a refusal (apps/api/internal/entitlement). It
 * emits, alongside the ordinary `{error:{code,message}}` framing:
 *
 *   {"error":{"reason":"role","code":"insufficient_permission",
 *             "message":…,"required_role":"editor","remedy":…,
 *             "subject":…,"tier":…,"limit":…,"current":…,
 *             "retry_after_seconds":…}}
 *
 * `reason` is the whole point: `plan`, `role`, `flag`, `quota`, `policy` and
 * `runtime` are six refusals with six different remedies. It is written by the
 * RBAC chokepoint (internal/rbac), the route-authorization manifest gate
 * (internal/routeauth), the plan-ceiling writer (internal/limits) and ~45 other
 * sites, so almost every refusal mobile can receive carries one.
 *
 * Mobile modelled NONE of it. `AIApiError` stopped at `{status, message, code}`
 * and `errorPresentation` branched on bare HTTP status, so a role denial, a
 * feature switched off for the workspace and a compliance block — 403, 403,
 * 403 — produced the same sentence and the same (wrong) advice, while a plan
 * ceiling's 402 fell through to "Something went wrong loading this."
 *
 * The VOCABULARY lives in @postwave/errors, shared with web and desktop, so
 * the three surfaces classify a refusal identically. The COPY is local,
 * because mobile's rule is different from theirs: `errorCopy.ts` never echoes a
 * server message verbatim, so the sentences here are built from the class and
 * the one or two fields that are safe and actionable, never from `message`.
 *
 * Import-free apart from that pure vocabulary module, so it stays testable in
 * mobile's node vitest environment.
 */
import {
  denialRetryable,
  formatRetryDelay,
  parseErrorEnvelope,
  type ApiDenial,
} from "@postwave/errors";

export type { ApiDenial };

/**
 * Read the denial off a decoded error body.
 *
 * Returns undefined for an ordinary error envelope: only a body carrying a
 * reason inside the closed vocabulary is a classified refusal, and an
 * unrecognised class must fall back to the surface's status handling rather
 * than being rendered as a class the client does not understand.
 */
export function parseDenialEnvelope(payload: unknown): ApiDenial | undefined {
  return parseErrorEnvelope(payload).denial;
}

/**
 * Pull the SDK error's decoded body (`PostwaveError.payload`) and classify it.
 *
 * Mirrors `capabilityEnvelopeFromError` — the SDK carries the body but not the
 * response headers, so the body's `retry_after_seconds` is the only reachable
 * half of the Retry-After pair. That is the authoritative half: the server
 * mirrors the field INTO the header, not the other way round.
 */
export function denialFromError(err: unknown): ApiDenial | undefined {
  if (!err || typeof err !== "object" || !("payload" in err)) return undefined;
  return parseDenialEnvelope((err as { payload?: unknown }).payload);
}

/** The shape any mobile error envelope needs to answer the question. */
export interface DenialAwareError {
  denial?: ApiDenial | undefined;
}

/** True when the server classified this refusal. */
export function isClassifiedDenial(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return Boolean((err as DenialAwareError).denial);
}

export interface DenialPresentation {
  message: string;
  /** False when retrying cannot possibly help — the button is then hidden. */
  retryable: boolean;
}

/**
 * The sentence for a classified refusal, and whether a Retry button on it
 * could ever work.
 *
 * Built from the CLASS, not from the server's prose: the copy has to survive
 * being shown on a phone with no support console next to it, and mobile's
 * standing rule is that a server message is never echoed. The fields that DO
 * appear — `required_role`, `retry_after_seconds` — are the actionable half,
 * and each is only mentioned when the server actually sent it.
 */
export function denialPresentation(denial: ApiDenial): DenialPresentation {
  const retryable = denialRetryable(denial);
  switch (denial.reason) {
    case "role":
      return {
        message: denial.requiredRole
          ? `Your role can't do this. Ask a workspace ${denial.requiredRole} to do it for you.`
          : "Your role can't do this. Ask a workspace administrator for access.",
        retryable,
      };
    case "plan":
      // The remedy is the server's call, never the client's: it withholds
      // `upgrade_plan` on the top tier and for ceilings no plan raises, and a
      // client that re-derives "upgrade" from the class points at a button
      // that cannot help.
      if (denial.remedy === "upgrade_plan") {
        return {
          message: "Your plan doesn't include this. Upgrade or reduce usage to continue.",
          retryable,
        };
      }
      if (denial.remedy === "contact_workspace_admin") {
        return {
          message: "You've reached this workspace's limit. An administrator can raise it.",
          retryable,
        };
      }
      return {
        message: "You've reached this workspace's limit. Upgrading won't raise it.",
        retryable,
      };
    case "quota":
      return {
        message:
          denial.retryAfterSeconds && denial.retryAfterSeconds > 0
            ? `You've hit a rate limit. Try again in ${formatRetryDelay(denial.retryAfterSeconds)}.`
            : "You've hit a rate limit. Try again shortly.",
        retryable,
      };
    case "flag":
      // The remedy is the server's call here too, and this arm used to ignore
      // it — it said "An administrator can turn it on" for EVERY flag denial.
      // Three sites deliberately send none and say why in so many words:
      // `agency.not_agency` ("the honest answer is that nothing the caller does
      // in-product resolves it"), `archive.tips_disabled` (a PUBLIC endpoint —
      // the reader is not the person who can enable tips) and
      // `handlers.direct_provision_disabled` (an ops switch). Promising an
      // admin can fix those sends someone to ask for something no admin can
      // grant, which is the same failure as showing a paywall to a role denial.
      if (denial.remedy === "contact_workspace_admin") {
        return {
          message: "This is switched off for your workspace. An administrator can turn it on.",
          retryable,
        };
      }
      return {
        message: "This is switched off for your workspace. Nothing here can turn it on.",
        retryable,
      };
    case "policy":
      return {
        message: "A workspace policy blocks this. Nothing you change on this device will allow it.",
        retryable,
      };
    case "runtime":
      // NOT "switched off in this deployment" — that is a claim this envelope
      // cannot substantiate. `internal/runtimecapability` owns the permanent
      // version, carries an explicit `capability` + `retryable: false`, and
      // lib/capabilityEnvelope reads it. The entitlement-side `runtime` is
      // 503 and its highest-traffic emitter is
      // `rbacresolve.permission_check_failed` — the grant store being
      // unreadable for a moment. Calling that permanent left the user with a
      // false statement and no way forward, on a refusal that clears itself.
      return {
        message: "This isn't available right now. Try again shortly.",
        retryable,
      };
  }
}
