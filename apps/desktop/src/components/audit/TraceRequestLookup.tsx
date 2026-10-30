/**
 * TraceRequestLookup — reach a request chain from an id you already have. ECO-22.
 *
 * The sibling `AuditRequestChain` opens the chain from a row an operator is
 * already looking at, which assumes they found the row first. The case the
 * endpoint was actually written for runs the other way: an engineer is holding
 * a request id out of a log line, an error report or an `X-Request-ID` response
 * header, and wants to know what that request did. Without this they have to
 * filter the audit list until they rediscover a row whose id they already have
 * — the manual join across screens that the program exists to remove.
 *
 * Self-contained. It owns the id it is typing and mounts its own modal, so the
 * audit page controller does not grow a field that only this control reads.
 */

import { useState, type ReactElement } from "react";

import { AuditChainModal } from "./AuditChainModal";

/**
 * Whether an id is worth asking the endpoint about.
 *
 * The server answers two values with a 422 — the empty string, and the "-"
 * sentinel `audit.Emit` writes when a row has no correlation. Refusing them
 * before the modal opens matters more than it looks: an empty chain renders as
 * "this request touched nothing", so sending a value that can only fail turns a
 * refusal into a confident wrong answer to the one question being asked.
 */
export function isTraceableRequestId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 && trimmed !== "-";
}

export function TraceRequestLookup(): ReactElement {
  const [draft, setDraft] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);

  return (
    <>
      <form
        className="row"
        style={{ gap: 4, alignItems: "center" }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!isTraceableRequestId(draft)) return;
          setRequestId(draft.trim());
        }}
      >
        <input
          type="text"
          value={draft}
          maxLength={256}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Trace a request id…"
          aria-label="Request id to trace"
          aria-describedby="audit-trace-request-limit"
          style={{ fontSize: 12, minWidth: 200 }}
        />
        <button
          type="submit"
          className="btn"
          disabled={!isTraceableRequestId(draft)}
        >
          Trace
        </button>
        <span id="audit-trace-request-limit" className="sr-only">
          Request IDs are limited to 256 characters.
        </span>
      </form>
      {requestId ? (
        <AuditChainModal
          requestId={requestId}
          onClose={() => setRequestId(null)}
        />
      ) : null}
    </>
  );
}
