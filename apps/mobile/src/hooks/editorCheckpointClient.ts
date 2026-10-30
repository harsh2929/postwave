/**
 * hooks/editorCheckpointClient.ts — the one live checkpoint client.
 *
 * Bound in its own module, away from both the rules
 * (hooks/editorCheckpointOutcome.ts) and the lifecycle
 * (hooks/useEditorCheckpoint.ts and hooks/useEditorCheckpointAutosave.ts), so
 * that every part of the lifecycle can reach the wire without importing the
 * hook that used to own it. api/editorCheckpoint.ts stays the WIRE itself:
 * paths, status codes, which failure is permanent and which is worth another
 * tick.
 */
import {
  createEditorCheckpointClient,
  type CheckpointResult,
} from "@/api/editorCheckpoint";
import { rawRequest } from "@/api/request";
import { isProbablyOnline } from "@/lib/connectivity";

/** The live client. Bound here so the rules module stays node-testable. */
export const editorCheckpoints = createEditorCheckpointClient({
  request: <T,>(method: string, path: string, body?: unknown) =>
    rawRequest<T>(method, path, body) as Promise<CheckpointResult<T>>,
  isOnline: isProbablyOnline,
});
