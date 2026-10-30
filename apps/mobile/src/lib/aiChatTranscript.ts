/**
 * lib/aiChatTranscript.ts — the chat's state machine, its access policy, and
 * where the Article 50 notice sits.
 *
 * Send → wait → whole reply, as a reducer. A turn is a user message plus an
 * assistant message that is `pending` until the server's one JSON answer
 * lands (see lib/aiChat for why there is nothing to stream). Failures come
 * pre-classified from lib/aiChatFailures.
 *
 * No react-native / expo import: vitest runs this in node.
 */
import { AI_DISCLOSURE_TEXT } from "@postwave/ai-disclosure";

import type {
  AiChatDraft,
  AiChatKind,
  AiChatReply,
  AiChatTone,
} from "@/lib/aiChat";
import type { AiChatFailure } from "@/lib/aiChatFailures";

/** Bounded in-memory transcript; older turns fall off the front. */
export const AI_CHAT_MAX_MESSAGES = 200;

export type AiChatRole = "user" | "assistant";
export type AiChatMessageStatus = "pending" | "done" | "failed";

export interface AiChatMessage {
  id: string;
  role: AiChatRole;
  /** A user turn is always `done`; an assistant turn is pending until the reply lands. */
  status: AiChatMessageStatus;
  text: string;
  createdAt: number;
  /** Assistant turns keep the prompt that produced them, for retry/regenerate. */
  sourcePrompt: string;
  sourceTone: AiChatTone;
  kind: AiChatKind;
  draft: AiChatDraft | null;
  failure: AiChatFailure | null;
  requestId: string | null;
}

export interface AiChatState {
  messages: AiChatMessage[];
  /** The assistant turn currently waiting on the server, if any. */
  pendingId: string | null;
  /** Sticky once the server answers with the release hold: the surface is blocked. */
  hold: AiChatFailure | null;
}

export const AI_CHAT_INITIAL_STATE: AiChatState = {
  messages: [],
  pendingId: null,
  hold: null,
};

export type AiChatAction =
  | {
      type: "send";
      userId: string;
      assistantId: string;
      prompt: string;
      tone: AiChatTone;
      kind: AiChatKind;
      at: number;
    }
  | {
      type: "reply";
      assistantId: string;
      reply: AiChatReply;
      requestId: string | null;
    }
  | { type: "fail"; assistantId: string; failure: AiChatFailure }
  | { type: "retry"; assistantId: string; at: number }
  | { type: "cancel" }
  | { type: "clear" };

export function newAiChatId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function trimHistory(messages: AiChatMessage[]): AiChatMessage[] {
  if (messages.length <= AI_CHAT_MAX_MESSAGES) return messages;
  return messages.slice(messages.length - AI_CHAT_MAX_MESSAGES);
}

function patch(
  messages: AiChatMessage[],
  id: string,
  update: (message: AiChatMessage) => AiChatMessage,
): AiChatMessage[] {
  return messages.map((message) =>
    message.id === id ? update(message) : message,
  );
}

const CANCELLED: AiChatFailure = {
  kind: "cancelled",
  message: "Stopped before a reply arrived.",
  retryable: true,
  requestId: null,
  code: null,
};

/**
 * Invariants the tests pin:
 *  - at most ONE assistant turn is pending; a send while one is in flight is
 *    ignored rather than queued (one model call per tap, no surprise spend);
 *  - a reply or failure is only accepted for the turn that is pending — a late
 *    answer to a cancelled turn changes nothing;
 *  - retry and regenerate are the same action on a failed or a done turn;
 *  - a release hold is sticky until the transcript is cleared.
 */
export function aiChatReducer(
  state: AiChatState,
  action: AiChatAction,
): AiChatState {
  switch (action.type) {
    case "send": {
      const prompt = action.prompt.trim();
      if (!prompt || state.pendingId !== null || state.hold) return state;
      const user: AiChatMessage = {
        id: action.userId,
        role: "user",
        status: "done",
        text: prompt,
        createdAt: action.at,
        sourcePrompt: prompt,
        sourceTone: action.tone,
        kind: action.kind,
        draft: null,
        failure: null,
        requestId: null,
      };
      const assistant: AiChatMessage = {
        ...user,
        id: action.assistantId,
        role: "assistant",
        status: "pending",
        text: "",
      };
      return {
        ...state,
        messages: trimHistory([...state.messages, user, assistant]),
        pendingId: action.assistantId,
      };
    }
    case "reply": {
      if (state.pendingId !== action.assistantId) return state;
      return {
        ...state,
        pendingId: null,
        messages: patch(state.messages, action.assistantId, (message) => ({
          ...message,
          status: "done",
          text: action.reply.text,
          draft: action.reply.draft,
          failure: null,
          requestId: action.requestId,
        })),
      };
    }
    case "fail": {
      if (state.pendingId !== action.assistantId) return state;
      return {
        ...state,
        pendingId: null,
        hold: action.failure.kind === "held" ? action.failure : state.hold,
        messages: patch(state.messages, action.assistantId, (message) => ({
          ...message,
          status: "failed",
          text: "",
          draft: null,
          failure: action.failure,
          requestId: action.failure.requestId,
        })),
      };
    }
    case "retry": {
      if (state.pendingId !== null || state.hold) return state;
      const target = state.messages.find((m) => m.id === action.assistantId);
      if (!target || target.role !== "assistant" || target.status === "pending") {
        return state;
      }
      return {
        ...state,
        pendingId: action.assistantId,
        messages: patch(state.messages, action.assistantId, (message) => ({
          ...message,
          status: "pending",
          text: "",
          draft: null,
          failure: null,
          requestId: null,
          createdAt: action.at,
        })),
      };
    }
    case "cancel": {
      if (state.pendingId === null) return state;
      const id = state.pendingId;
      return {
        ...state,
        pendingId: null,
        messages: patch(state.messages, id, (message) => ({
          ...message,
          status: "failed",
          failure: CANCELLED,
        })),
      };
    }
    case "clear":
      return AI_CHAT_INITIAL_STATE;
    default:
      return state;
  }
}

/* ---------- access + disclosure -------------------------------------- */

export type AiChatAccess =
  | { kind: "ready" }
  | { kind: "held"; message: string }
  | { kind: "no_tenant"; message: string }
  | { kind: "offline"; message: string }
  | { kind: "role"; message: string };

/**
 * Whether the composer is offered, and if not, the one sentence that says
 * why. Most-blocking first: a server hold is final for the session, a missing
 * workspace cannot be talked to, a closed gate cannot reach the server, and a
 * viewer holds no write:campaigns — the scope this route mounts.
 */
export function aiChatAccess(input: {
  hold: AiChatFailure | null;
  hasTenant: boolean;
  gateEnabled: boolean;
  online: boolean;
  canWrite: boolean;
}): AiChatAccess {
  if (input.hold) return { kind: "held", message: input.hold.message };
  if (!input.hasTenant) {
    return {
      kind: "no_tenant",
      message:
        "This screen needs an authenticated workspace before it can talk to the AI.",
    };
  }
  if (!input.gateEnabled || !input.online) {
    return {
      kind: "offline",
      message:
        "Asking needs a connection. Replies are generated on the server and nothing here is cached.",
    };
  }
  if (!input.canWrite) {
    return {
      kind: "role",
      message:
        "Anyone with editor access or above can chat with Moosewave AI. Viewers can read a transcript someone else opened on this device, but cannot send.",
    };
  }
  return { kind: "ready" };
}

export type AiChatTranscriptRow =
  | { kind: "disclosure"; id: "disclosure"; text: string }
  | { kind: "message"; id: string; message: AiChatMessage };

/**
 * Article 50(1) gating. The notice is REQUIRED whenever a turn can happen or
 * has happened — i.e. before the first assistant turn on a usable screen, and
 * for as long as any turn is on screen — and it is the package constant
 * byte-for-byte, never a paraphrase. A blocked screen with an empty transcript
 * has no AI turn to disclose, so the notice is not forced there; rendering it
 * anyway is allowed.
 */
export function aiChatDisclosureRequired(input: {
  messages: readonly AiChatMessage[];
  canSend: boolean;
}): boolean {
  return input.canSend || input.messages.length > 0;
}

/**
 * The rows a transcript list renders, disclosure FIRST: the ordering is
 * structural, so no assistant turn can ever be placed above the notice.
 */
export function aiChatTranscriptRows(
  messages: readonly AiChatMessage[],
  input: { canSend: boolean },
): AiChatTranscriptRow[] {
  const rows: AiChatTranscriptRow[] = [];
  if (aiChatDisclosureRequired({ messages, canSend: input.canSend })) {
    rows.push({ kind: "disclosure", id: "disclosure", text: AI_DISCLOSURE_TEXT });
  }
  for (const message of messages) {
    rows.push({ kind: "message", id: message.id, message });
  }
  return rows;
}
