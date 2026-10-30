/** Debounced, race-safe live count for natural-language segment drafts. */

import { type ReactElement, useEffect, useMemo, useState } from "react";

import {
  remoteFailureFromError,
  type RemoteFailure,
} from "../../lib/remote-resource";
import { segmentsClient } from "./segmentsClient";

interface Props {
  queryAst?: unknown;
  text?: string;
  debounceMs?: number;
}

type State =
  | { kind: "idle" }
  | { kind: "waiting" }
  | { kind: "loading" }
  | { kind: "ok"; count: number; capped: boolean; ms: number }
  | { kind: "err"; failure: RemoteFailure };

export function SegmentPreviewCount({
  queryAst,
  text,
  debounceMs = 400,
}: Props): ReactElement {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [retryNonce, setRetryNonce] = useState(0);
  const request = useMemo(
    () => serializePreviewRequest(queryAst, text),
    [queryAst, text],
  );
  const waitMs = Number.isFinite(debounceMs)
    ? Math.max(0, Math.min(5_000, Math.round(debounceMs)))
    : 400;

  useEffect(() => {
    if (!request) {
      setState({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setState({ kind: "waiting" });
    const timer = window.setTimeout(() => {
      setState({ kind: "loading" });
      void (async (): Promise<void> => {
        try {
          const input = JSON.parse(request) as {
            queryAst?: unknown;
            text?: string;
          };
          const result = await segmentsClient.previewCount(input);
          if (cancelled) return;
          if (result.error) {
            setState({
              kind: "err",
              failure: remoteFailureFromError(result.error),
            });
            return;
          }
          if (
            !Number.isFinite(result.data.count) ||
            result.data.count < 0 ||
            !Number.isFinite(result.data.computed_in_ms) ||
            result.data.computed_in_ms < 0
          ) {
            setState({
              kind: "err",
              failure: remoteFailureFromError({
                kind: "parse",
                code: "invalid_segment_preview_response",
              }),
            });
            return;
          }
          setState({
            kind: "ok",
            count: Math.floor(result.data.count),
            capped: !!result.data.capped,
            ms: Math.round(result.data.computed_in_ms),
          });
        } catch {
          if (!cancelled) {
            setState({
              kind: "err",
              failure: remoteFailureFromError({ kind: "network" }),
            });
          }
        }
      })();
    }, waitMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [request, retryNonce, waitMs]);

  if (state.kind === "idle") {
    return (
      <span className="muted" aria-label="No segment preview yet">
        Enter a description to see the matching count.
      </span>
    );
  }
  if (state.kind === "waiting") {
    return (
      <span className="muted" role="status" aria-live="polite">
        Waiting for the description to settle before recomputing…
      </span>
    );
  }
  if (state.kind === "loading") {
    return (
      <span className="muted" role="status" aria-live="polite" aria-busy="true">
        Computing the matching count…
      </span>
    );
  }
  if (state.kind === "err") {
    const diagnostics = [state.failure.code, state.failure.requestId]
      .filter(Boolean)
      .join(" · ");
    return (
      <span className="visual-segment-preview-error" role="alert">
        <span>
          <strong>Couldn&apos;t verify the matching count.</strong>{" "}
          {state.failure.message}
          {diagnostics ? (
            <span className="muted"> Reference: {diagnostics}.</span>
          ) : null}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setRetryNonce((value) => value + 1)}
        >
          Retry count
        </button>
      </span>
    );
  }
  return (
    <span
      className="visual-segment-preview-result"
      role="status"
      aria-live="polite"
    >
      <span className="tabular">
        {state.capped ? "At least " : ""}
        <strong>{state.count.toLocaleString()}</strong> matching subscriber
        {state.count === 1 ? "" : "s"}
      </span>
      <span className="muted">Computed in {state.ms.toLocaleString()} ms.</span>
      {state.capped ? (
        <span className="visual-segment-cap-notice">
          <span className="badge warning">Evaluation capped</span>
          <span className="muted">
            The evaluation budget was reached, so the true count is at least the
            value shown.
          </span>
        </span>
      ) : null}
    </span>
  );
}

function serializePreviewRequest(
  queryAst: unknown,
  text: string | undefined,
): string {
  try {
    if (queryAst) return JSON.stringify({ queryAst });
    const trimmed = text?.trim();
    return trimmed ? JSON.stringify({ text: trimmed }) : "";
  } catch {
    return "";
  }
}
