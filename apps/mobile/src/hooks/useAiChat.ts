/**
 * hooks/useAiChat.ts — the React half of the Moosewave AI chat.
 *
 * The transcript is a reducer (lib/aiChat) and the transport is
 * api/aiChat.sendAiChat; this hook owns the one thing neither can — the
 * AbortController for the turn in flight — and the ids.
 *
 * IN MEMORY ONLY, ON PURPOSE. Desktop persists chat history in its encrypted
 * identity-scoped vault; this device keeps the transcript for the life of the
 * screen and nothing longer. A conversation about a workspace's audience is
 * exactly the kind of text that should not outlive the session on a phone
 * that changes hands, and "we never wrote it down" is a smaller promise to
 * keep than "we encrypted it correctly". Clear is a button, not a setting.
 *
 * Nothing here re-asks on its own: no refetch, no retry, no re-run on focus.
 * A turn costs the workspace model tokens; every model call traces back to
 * a tap on Send, Retry or Regenerate.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";

import { sendAiChat } from "@/api/aiChat";
import {
  AI_CHAT_PROMPT_MAX_CHARS,
  buildAiChatRequest,
  inferAiChatKind,
  type AiChatKind,
  type AiChatTone,
} from "@/lib/aiChat";
import {
  classifyAiChatFailure,
  type AiChatFailure,
} from "@/lib/aiChatFailures";
import {
  AI_CHAT_INITIAL_STATE,
  aiChatReducer,
  newAiChatId,
  type AiChatMessage,
} from "@/lib/aiChatTranscript";

export interface AiChatController {
  messages: AiChatMessage[];
  /** True while an assistant turn is waiting on the server. */
  pending: boolean;
  /** The server's release hold, once seen; the screen is blocked until Clear. */
  hold: AiChatFailure | null;
  send: (prompt: string, tone: AiChatTone) => void;
  /** Retry a failed turn, or regenerate a finished one — same prompt, same tone. */
  retry: (assistantId: string) => void;
  stop: () => void;
  clear: () => void;
}

export function useAiChat(): AiChatController {
  const [state, dispatch] = useReducer(aiChatReducer, AI_CHAT_INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (
      assistantId: string,
      prompt: string,
      tone: AiChatTone,
      kind: AiChatKind,
    ): Promise<void> => {
      const built = buildAiChatRequest({ prompt, tone, kind });
      if (!built.ok) {
        dispatch({
          type: "fail",
          assistantId,
          failure: {
            kind: "invalid",
            message:
              built.reason === "empty"
                ? "Type something to ask."
                : `Keep a message under ${AI_CHAT_PROMPT_MAX_CHARS} characters.`,
            retryable: false,
            requestId: null,
            code: null,
          },
        });
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      const res = await sendAiChat(built.body, { signal: controller.signal });
      if (abortRef.current === controller) abortRef.current = null;
      if (res.error) {
        dispatch({
          type: "fail",
          assistantId,
          failure: classifyAiChatFailure(res.error),
        });
        return;
      }
      dispatch({ type: "reply", assistantId, reply: res.data, requestId: null });
    },
    [],
  );

  const send = useCallback(
    (prompt: string, tone: AiChatTone): void => {
      const trimmed = prompt.trim();
      const current = stateRef.current;
      if (!trimmed || current.pendingId !== null || current.hold) return;
      const userId = newAiChatId();
      const assistantId = newAiChatId();
      const kind = inferAiChatKind(trimmed);
      dispatch({
        type: "send",
        userId,
        assistantId,
        prompt: trimmed,
        tone,
        kind,
        at: Date.now(),
      });
      void run(assistantId, trimmed, tone, kind);
    },
    [run],
  );

  const retry = useCallback(
    (assistantId: string): void => {
      const current = stateRef.current;
      if (current.pendingId !== null || current.hold) return;
      const target = current.messages.find((m) => m.id === assistantId);
      if (!target || target.role !== "assistant" || target.status === "pending") {
        return;
      }
      dispatch({ type: "retry", assistantId, at: Date.now() });
      void run(assistantId, target.sourcePrompt, target.sourceTone, target.kind);
    },
    [run],
  );

  const stop = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    dispatch({ type: "cancel" });
  }, []);

  const clear = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    dispatch({ type: "clear" });
  }, []);

  // Leaving the screen ends the turn: a reply nobody is waiting for is spend
  // with no reader, and the reducer would ignore it anyway.
  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    messages: state.messages,
    pending: state.pendingId !== null,
    hold: state.hold,
    send,
    retry,
    stop,
    clear,
  };
}
