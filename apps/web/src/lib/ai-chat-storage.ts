// SPDX-License-Identifier: AGPL-3.0-only
//
// Device-local state for the Moosewave AI chat: the conversation history and
// the personal saved-prompt library. Desktop keeps both in its encrypted OS
// vault; the browser has no equivalent vault, so web follows the
// recent-template-briefs precedent instead — keys are scoped to the signed-in
// user AND workspace, values are validated on every read (a corrupt or foreign
// record yields nothing rather than being trusted), and nothing is sent to the
// server. Every write reports whether the browser accepted it so the UI can
// offer "Retry storage" instead of silently losing a change.

import { AI_CHAT_PROMPT_MAX_CHARS } from "@/lib/ai-chat-api";

export interface AiChatStorageScope {
  tenantId: string;
  userId: string;
}

export type AiChatMessageStatus = "pending" | "done" | "error";

export interface AiChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status: AiChatMessageStatus;
  errorMessage?: string;
  /** Prompt + tone that produced an assistant turn (Regenerate / Retry). */
  sourcePrompt?: string;
  sourceTone?: string;
  draftSubject?: string;
  draftPreview?: string;
}

export interface AiSavedPrompt {
  id: string;
  name: string;
  prompt: string;
}

const HISTORY_PREFIX = "postwave.ai.chat-history.v1";
const PROMPTS_PREFIX = "postwave.ai.saved-prompts.v1";
export const AI_CHAT_MAX_HISTORY_MESSAGES = 200;
export const AI_MAX_SAVED_PROMPTS = 50;
export const AI_MAX_PROMPT_NAME_CHARS = 120;
const MAX_MESSAGE_CHARS = 200_000;
export const AI_CHAT_INTERRUPTED_MESSAGE =
  "Interrupted before a reply arrived. Retry to ask again.";

function scopedKey(prefix: string, scope: AiChatStorageScope): string | null {
  const tenantId = scope.tenantId.trim();
  const userId = scope.userId.trim();
  if (!tenantId || !userId) return null;
  return `${prefix}:${encodeURIComponent(tenantId)}:${encodeURIComponent(userId)}`;
}

export function aiChatHistoryKey(scope: AiChatStorageScope): string | null {
  return scopedKey(HISTORY_PREFIX, scope);
}

export function aiSavedPromptsKey(scope: AiChatStorageScope): string | null {
  return scopedKey(PROMPTS_PREFIX, scope);
}

function readJson(key: string | null): unknown {
  if (!key || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string | null, value: unknown): boolean {
  if (!key || typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function sanitizeMessage(raw: unknown): AiChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = boundedText(value.id, 200);
  const content = boundedText(value.content, MAX_MESSAGE_CHARS);
  if (
    !id ||
    content === null ||
    (value.role !== "user" && value.role !== "assistant") ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt)
  ) {
    return null;
  }
  const status: AiChatMessageStatus =
    value.status === "done" || value.status === "error"
      ? value.status
      : "pending";
  const message: AiChatMessage = {
    id,
    role: value.role,
    content,
    createdAt: value.createdAt,
    status,
  };
  const optional = [
    ["errorMessage", 2_000],
    ["sourcePrompt", AI_CHAT_PROMPT_MAX_CHARS],
    ["sourceTone", 40],
    ["draftSubject", 1_000],
    ["draftPreview", 2_000],
  ] as const;
  for (const [field, max] of optional) {
    const text = boundedText(value[field], max);
    if (text !== null) message[field] = text;
  }
  // A turn persisted mid-generation can never finish after a reload: the
  // request that would have completed it belonged to the closed page.
  if (message.status === "pending") {
    if (message.role === "user") message.status = "done";
    else {
      message.status = "error";
      message.errorMessage = AI_CHAT_INTERRUPTED_MESSAGE;
    }
  }
  return message;
}

export function readAiChatHistory(scope: AiChatStorageScope): AiChatMessage[] {
  const parsed = readJson(aiChatHistoryKey(scope));
  if (!Array.isArray(parsed)) return [];
  return parsed
    .slice(-AI_CHAT_MAX_HISTORY_MESSAGES)
    .map(sanitizeMessage)
    .filter((message): message is AiChatMessage => message !== null);
}

export function writeAiChatHistory(
  scope: AiChatStorageScope,
  messages: readonly AiChatMessage[],
): boolean {
  return writeJson(
    aiChatHistoryKey(scope),
    messages.slice(-AI_CHAT_MAX_HISTORY_MESSAGES),
  );
}

/** Remove only this user + workspace's history from this browser. */
export function clearAiChatHistory(scope: AiChatStorageScope): boolean {
  const key = aiChatHistoryKey(scope);
  if (!key || typeof window === "undefined") return false;
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeAiSavedPrompts(candidate: unknown): AiSavedPrompt[] {
  if (!Array.isArray(candidate)) return [];
  const ids = new Set<string>();
  const out: AiSavedPrompt[] = [];
  for (const raw of candidate) {
    if (!raw || typeof raw !== "object") continue;
    const value = raw as Record<string, unknown>;
    const id = boundedText(value.id, 200);
    const name = boundedText(value.name, AI_MAX_PROMPT_NAME_CHARS);
    const prompt = boundedText(value.prompt, AI_CHAT_PROMPT_MAX_CHARS);
    if (!id?.trim() || ids.has(id) || !name?.trim() || !prompt?.trim()) {
      continue;
    }
    ids.add(id);
    out.push({ id, name, prompt });
  }
  return out.slice(-AI_MAX_SAVED_PROMPTS);
}

export function readAiSavedPrompts(scope: AiChatStorageScope): AiSavedPrompt[] {
  return sanitizeAiSavedPrompts(readJson(aiSavedPromptsKey(scope)));
}

export function writeAiSavedPrompts(
  scope: AiChatStorageScope,
  prompts: readonly AiSavedPrompt[],
): boolean {
  return writeJson(aiSavedPromptsKey(scope), prompts);
}

export function newAiLocalId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `${prefix}-${uuid}`
    : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
