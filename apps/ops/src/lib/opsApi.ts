// SPDX-License-Identifier: AGPL-3.0-only
//
// opsApi.ts — the server-side proxy the console's POST buttons go through.
//
// The browser never talks to the API directly: it POSTs to this app's own
// route handlers, which forward the operator's Cookie exactly as the board
// fetch does (lib/board.ts). Same session, same platform-operator gate — the
// console adds no auth of its own and therefore cannot weaken any.
//
// The IP allowlist is the one factor a proxy can destroy just by existing: the
// API reads the client address off the request it receives, which is ours. We
// therefore relay the browser's address (opsSecurity.forwardedClientHeaders),
// and the API honours it only when this console's egress address is registered
// in POSTWAVE_TRUSTED_PROXY_CIDRS. Until it is, the allowlist sees the console
// and decides nothing — so that registration is part of deploying this app.
//
// Everything that decides whether an action may run — the operator gate, the
// audit write, the idempotency key, the 30s timeout, the critical-snooze cap —
// lives in the API. This file forwards and reports; it never judges. The shared
// forward/CSRF/bound/normalize envelope lives in opsSecurity.forwardOpsMutation;
// this module supplies only the check-action specifics.

import {
  forwardOpsMutation,
  MAX_ACTION_BODY_BYTES,
  MAX_ACTION_RESULT_BYTES,
  MAX_ACTION_RESULT_CHARS,
  safeJSON,
} from "./opsSecurity";
import {
  containsControlCharacter,
  hasOnlyKeys,
  isBoundedMultilineText,
  isBoundedText,
  isCanonicalUUID,
  isCheckID,
  isRecord,
  isTimestamp,
} from "./viewSchema";

export { isCheckID };

type ActionVerb = "action" | "snooze";

// forwardOpsPost proxies one POST to /api/internal/ops/checks/{id}/{verb}.
//
// The API's response is passed through VERBATIM — status code and body. In
// particular a 200 carrying {"status":"failed"} stays a 200 carrying
// "failed": the console must not launder a failed action into a success, and
// it must not invent an outcome the API never reported.
export async function forwardOpsPost(
  req: Request,
  checkID: string,
  verb: ActionVerb,
): Promise<Response> {
  // The check id is placed in the forwarded PATH, so it is validated before it
  // is ever concatenated into a URL: an id of "../../v1/subscribers" would let
  // a crafted link aim the operator's cookie at a different endpoint entirely.
  if (!isCheckID(checkID)) {
    return safeJSON(400, "bad_check_id", "that is not a check id");
  }
  return forwardOpsMutation<ActionVerb>(req, {
    path: `/api/internal/ops/checks/${encodeURIComponent(checkID)}/${verb}`,
    bodyLimit: MAX_ACTION_BODY_BYTES,
    unreachableMessage:
      "the ops service did not provide a definitive answer; retry with the same idempotency key",
    validate: (parsed) =>
      isValidActionRequest(parsed, verb) ? { body: parsed, context: verb } : null,
    normalize: (payload, ctx) => normalizeSuccess(payload, ctx),
  });
}

function normalizeSuccess(
  payload: unknown,
  verb: ActionVerb,
): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload;
  if (verb === "snooze") {
    if (
      !hasOnlyKeys(value, ["run_id", "status", "result", "snoozed_until", "replayed"]) ||
      !isCanonicalUUID(value.run_id) ||
      (value.status !== "running" &&
        value.status !== "succeeded" &&
        value.status !== "failed") ||
      typeof value.result !== "string" ||
      [...value.result].length > MAX_ACTION_RESULT_CHARS ||
      new TextEncoder().encode(value.result).byteLength > MAX_ACTION_RESULT_BYTES ||
      typeof value.replayed !== "boolean"
    ) {
      return undefined;
    }
    if (value.status === "succeeded") {
      if (!isTimestamp(value.snoozed_until)) return undefined;
    } else if (value.snoozed_until !== null) {
      // A running/failed row is an ambiguous or negative outcome. Claiming an
      // expiry before the durable ledger says succeeded would lie to the
      // operator and could tempt the UI to retire the only safe retry key.
      return undefined;
    }
    return {
      run_id: value.run_id,
      status: value.status,
      result: value.result,
      snoozed_until: value.snoozed_until,
      replayed: value.replayed,
    };
  }
  if (!hasOnlyKeys(value, ["run_id", "status", "result", "replayed"])) return undefined;
  if (!isCanonicalUUID(value.run_id)) return undefined;
  // A payload-bound retry can race the original detached execution. `running`
  // is a truthful, durable replay result: rejecting it as malformed would turn
  // an in-progress idempotent request into an apparent proxy failure and tempt
  // the client to retire the only key that prevents a duplicate action.
  if (
    value.status !== "running" &&
    value.status !== "succeeded" &&
    value.status !== "failed"
  ) {
    return undefined;
  }
  if (
    typeof value.result !== "string" ||
    [...value.result].length > MAX_ACTION_RESULT_CHARS ||
    new TextEncoder().encode(value.result).byteLength > MAX_ACTION_RESULT_BYTES
  ) {
    return undefined;
  }
  if (typeof value.replayed !== "boolean") return undefined;
  return {
    status: value.status,
    result: value.result,
    replayed: value.replayed,
  };
}

function isValidActionRequest(
  payload: unknown,
  verb: ActionVerb,
): payload is Record<string, unknown> {
  if (!isRecord(payload)) return false;
  if (verb === "snooze") {
    return (
      hasOnlyKeys(payload, ["idempotency_key", "duration", "reason"]) &&
      isCanonicalUUID(payload.idempotency_key) &&
      isBoundedText(payload.duration, 32, 64) &&
      isBoundedMultilineText(payload.reason, 4_096, 16_384)
    );
  }
  return (
    hasOnlyKeys(payload, ["idempotency_key", "input"]) &&
    isCanonicalUUID(payload.idempotency_key) &&
    typeof payload.input === "string" &&
    [...payload.input].length <= 4_096 &&
    new TextEncoder().encode(payload.input).byteLength <= 16_384 &&
    !containsControlCharacter(payload.input)
  );
}
