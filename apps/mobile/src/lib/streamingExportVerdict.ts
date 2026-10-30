/**
 * lib/streamingExportVerdict.ts — what the streaming-export dock SAYS.
 *
 * `lib/streamingExportRuns.ts` parses the wire and reduces one run to a row;
 * this module makes the JUDGEMENTS above the row: a connection's one-line
 * verdict read off its newest window, the dock strip's sentence across every
 * connection, the roster⇄reads join that never drops a connection whose
 * history is missing, and the sentence for a read the server refused. Split
 * from the parser by responsibility so each half stays under the 450-line
 * source ceiling; every decision here is tested under node vitest.
 *
 * DELIBERATELY IMPORT-FREE of react-native so it runs under node vitest.
 */
import { num, plural } from "@/lib/format";
import type {
  StreamingExportHistory,
  StreamingRunTone,
} from "@/lib/streamingExportRuns";

export type StreamingConnectionVerdictKind =
  | "never_shipped"
  | "failed_window"
  | "in_flight"
  | "behind"
  | "caught_up";

export interface StreamingConnectionVerdict {
  kind: StreamingConnectionVerdictKind;
  headline: string;
  /** Windows in THIS response that did not land — never a total. */
  failedWindows: number;
}

/**
 * The connection's one-line verdict, read off the NEWEST run.
 *
 * The newest run decides the kind because it is the one that will repeat
 * tonight; older failures in the window are counted, not headlined, so a
 * connection that failed at 02:00 and recovered at 03:00 reads as recovered
 * with a failure on record — which is what happened.
 */
export function streamingConnectionVerdict(
  history: StreamingExportHistory,
): StreamingConnectionVerdict {
  const runs = history.runs;
  const failedWindows = runs.filter((run) => run.failed).length;
  const newest = runs[0];
  if (!newest) {
    return {
      kind: "never_shipped",
      headline: "No shipment records were returned.",
      failedWindows: 0,
    };
  }
  const earlier =
    failedWindows > 0
      ? ` ${plural(failedWindows, "earlier window")} in this response did not land.`
      : "";
  if (newest.failed) {
    return {
      kind: "failed_window",
      headline:
        failedWindows > 1
          ? `The newest window did not land — ${plural(failedWindows, "window")} in this response did not.`
          : "The newest window did not land.",
      failedWindows,
    };
  }
  if (newest.outcome === "running") {
    return {
      kind: "in_flight",
      headline: `A window is shipping now.${earlier}`,
      failedWindows,
    };
  }
  if (newest.hasMore) {
    return {
      kind: "behind",
      headline: `The newest window landed with more events still due.${earlier}`,
      failedWindows,
    };
  }
  return {
    kind: "caught_up",
    headline: `Caught up — the newest window landed.${earlier}`,
    failedWindows,
  };
}

/** One streaming connection as the dock sees it: roster row + its read. */
export interface StreamingConnectionEntry {
  connectionId: string;
  name: string;
  /** null until the read resolves, or when it failed. */
  history: StreamingExportHistory | null;
  /** HTTP status of a failed read (0 = unreachable); null when it succeeded. */
  errorStatus: number | null;
}

/** The human sentence for a refused or failed history read. */
export function streamingHistoryErrorMessage(status: number): string {
  if (status === 404) {
    // Desktop's wording for the same status (StreamingExportStatus.tsx:285),
    // plus the other cause `ListRuns` can 404 for (repo.go:376).
    return "Streaming export isn't enabled on this Moosewave server, or this connection was deleted.";
  }
  if (status === 403) {
    return "Reading shipment history needs an owner or admin session.";
  }
  if (status === 0) {
    return "Couldn't reach the server to read shipped windows.";
  }
  return "The server couldn't return this connection's shipped windows.";
}

export interface StreamingDockSummary {
  connections: number;
  /** Connections whose newest window did not land. */
  failing: number;
  /** Connections whose history read itself failed. */
  unreadable: number;
  tone: StreamingRunTone;
  headline: string;
  /** The newest caught-up window across every readable connection; "" if none. */
  lastShippedAt: string;
}

/**
 * The strip's sentence — the one line an operator reads before deciding
 * whether to open the sheet. Failures lead; an unreadable history is named as
 * unreadable and never folded into "caught up".
 */
export function streamingDockSummary(
  entries: readonly StreamingConnectionEntry[],
  loaded: boolean,
  /** The online gate is closed: an unloaded read is "reconnect", not "reading". */
  offline = false,
): StreamingDockSummary {
  const connections = entries.length;
  const base = { connections, failing: 0, unreadable: 0, lastShippedAt: "" };
  if (!loaded) {
    return {
      ...base,
      tone: "neutral",
      headline: offline
        ? `${plural(connections, "connection")} · reconnect to read shipped windows`
        : `${plural(connections, "connection")} · reading shipped windows…`,
    };
  }
  let failing = 0;
  let unreadable = 0;
  let neverShipped = 0;
  let lastShippedAt = "";
  for (const entry of entries) {
    if (!entry.history) {
      unreadable += 1;
      continue;
    }
    const verdict = streamingConnectionVerdict(entry.history);
    if (verdict.kind === "failed_window") failing += 1;
    if (verdict.kind === "never_shipped") neverShipped += 1;
    if (entry.history.lastShippedAt > lastShippedAt) {
      lastShippedAt = entry.history.lastShippedAt;
    }
  }
  const readable = connections - unreadable;
  if (failing > 0) {
    return {
      ...base,
      failing,
      unreadable,
      lastShippedAt,
      tone: "danger",
      headline: `${num(failing)} of ${plural(connections, "connection")} did not land the newest window`,
    };
  }
  if (unreadable === connections) {
    return {
      ...base,
      unreadable,
      lastShippedAt,
      tone: "warning",
      headline: `Shipment history couldn't be read for ${
        connections === 1 ? "this connection" : `any of ${num(connections)} connections`
      }`,
    };
  }
  if (neverShipped === readable) {
    return {
      ...base,
      unreadable,
      lastShippedAt,
      tone: "neutral",
      headline: `${plural(connections, "connection")} · nothing has shipped yet`,
    };
  }
  const unreadNote = unreadable > 0 ? ` · ${num(unreadable)} unreadable` : "";
  return {
    ...base,
    unreadable,
    lastShippedAt,
    tone: "success",
    headline: `${plural(readable, "connection")} landed the newest window${unreadNote}`,
  };
}

/**
 * Join the roster to the reads. Every streaming connection gets an entry even
 * when its read has not resolved, so the sheet lists the roster the operator
 * expects and never silently drops a connection whose history is missing.
 */
export function streamingConnectionEntries(
  connections: readonly { id: string; name: string; provider: string }[],
  reads:
    | readonly {
        connectionId: string;
        history: StreamingExportHistory | null;
        errorStatus: number | null;
      }[]
    | undefined,
): StreamingConnectionEntry[] {
  return connections.map((connection) => {
    const read = reads?.find((r) => r.connectionId === connection.id);
    return {
      connectionId: connection.id,
      name:
        connection.name ||
        connection.provider ||
        `Connection ${connection.id.slice(0, 8)}`,
      history: read?.history ?? null,
      errorStatus: read?.errorStatus ?? null,
    };
  });
}
