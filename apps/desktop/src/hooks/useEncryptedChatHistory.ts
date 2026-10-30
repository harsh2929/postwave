/** Identity-isolated encrypted persistence and validation for Moosewave AI chat. */

import { useCallback, useEffect, useRef, useState } from "react";

import type { AIGroundingChip, AIMessageData } from "../components/AIMessage";
import {
  loadSensitiveLocalData,
  saveSensitiveLocalData,
  type SanitizedLocalData,
} from "../lib/sensitive-local-data";

const CHAT_LS_SUFFIX = "chat-history.v1";
const CHAT_VAULT_NAMESPACE = "ai-chat";
const CHAT_MAX_MESSAGES = 100;
const CHAT_MAX_CONTENT_CHARACTERS = 200_000;
const CHAT_MAX_SOURCE_PROMPT_CHARACTERS = 32_000;
const CHAT_MAX_DRAFT_FIELD_CHARACTERS = 100_000;
const CHAT_MAX_LIBRARY_BYTES = 440 * 1024;

function boundedOptionalString(
  value: unknown,
  maxCharacters: number,
): string | undefined {
  return typeof value === "string" && value.length <= maxCharacters
    ? value
    : undefined;
}

function sanitizeChatMessage(candidate: unknown): AIMessageData | null {
  if (!candidate || typeof candidate !== "object") return null;
  const raw = candidate as Partial<AIMessageData>;
  if (
    typeof raw.id !== "string" ||
    !raw.id.trim() ||
    raw.id.length > 200 ||
    (raw.role !== "user" && raw.role !== "assistant") ||
    typeof raw.content !== "string" ||
    raw.content.length > CHAT_MAX_CONTENT_CHARACTERS ||
    typeof raw.createdAt !== "number" ||
    !Number.isFinite(raw.createdAt) ||
    raw.createdAt < 0 ||
    raw.createdAt > 8_640_000_000_000_000
  ) {
    return null;
  }
  const message: AIMessageData = {
    id: raw.id,
    role: raw.role,
    content: raw.content,
    createdAt: raw.createdAt,
  };
  if (typeof raw.errored === "boolean") message.errored = raw.errored;
  const errorMessage = boundedOptionalString(raw.errorMessage, 1_000);
  if (errorMessage !== undefined) message.errorMessage = errorMessage;
  const sourcePrompt = boundedOptionalString(
    raw.sourcePrompt,
    CHAT_MAX_SOURCE_PROMPT_CHARACTERS,
  );
  if (sourcePrompt !== undefined) message.sourcePrompt = sourcePrompt;
  const sourceTone = boundedOptionalString(raw.sourceTone, 100);
  if (sourceTone !== undefined) message.sourceTone = sourceTone;
  if (raw.draft && typeof raw.draft === "object") {
    const draft = {
      name: boundedOptionalString(raw.draft.name, 500),
      subject: boundedOptionalString(raw.draft.subject, 2_000),
      body: boundedOptionalString(
        raw.draft.body,
        CHAT_MAX_DRAFT_FIELD_CHARACTERS,
      ),
      preview_text: boundedOptionalString(raw.draft.preview_text, 2_000),
    };
    if (Object.values(draft).some((value) => value !== undefined)) {
      message.draft = draft;
    }
  }
  if (Array.isArray(raw.groundingChips)) {
    const chips = raw.groundingChips.slice(0, 24).flatMap((chip) => {
      if (!chip || typeof chip !== "object") return [];
      const value = chip as Partial<AIGroundingChip>;
      if (
        typeof value.id !== "string" ||
        !value.id.trim() ||
        value.id.length > 200 ||
        typeof value.label !== "string" ||
        !value.label.trim() ||
        value.label.length > 256
      ) {
        return [];
      }
      return [
        {
          id: value.id,
          label: value.label,
          ...(typeof value.target === "string" && value.target.length <= 64
            ? { target: value.target }
            : {}),
          ...(typeof value.title === "string" && value.title.length <= 512
            ? { title: value.title }
            : {}),
        } satisfies AIGroundingChip,
      ];
    });
    if (chips.length > 0) message.groundingChips = chips;
  }
  return message;
}

export function sanitizeChatHistory(
  candidate: unknown,
): SanitizedLocalData<AIMessageData[]> | null {
  if (!Array.isArray(candidate)) return null;
  const messages: AIMessageData[] = [];
  const ids = new Set<string>();
  let altered = false;
  for (const raw of candidate.slice(-CHAT_MAX_MESSAGES * 2)) {
    const message = sanitizeChatMessage(raw);
    if (!message || ids.has(message.id)) {
      altered = true;
      continue;
    }
    try {
      const normalizedRaw = { ...(raw as Record<string, unknown>) };
      delete normalizedRaw.streaming;
      altered ||= JSON.stringify(normalizedRaw) !== JSON.stringify(message);
    } catch {
      altered = true;
    }
    ids.add(message.id);
    messages.push(message);
  }
  const bounded = messages.slice(-CHAT_MAX_MESSAGES);
  altered ||= bounded.length !== candidate.length;
  while (
    bounded.length > 0 &&
    new TextEncoder().encode(JSON.stringify(bounded)).byteLength >
      CHAT_MAX_LIBRARY_BYTES
  ) {
    bounded.shift();
    altered = true;
  }
  return { value: bounded, altered };
}

export function useEncryptedChatHistory(
  identityScope: string | null,
  onIdentityReset: () => void,
) {
  const scopeToken = identityScope ?? "unresolved";
  const [messages, setMessages] = useState<AIMessageData[]>([]);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorRetryable, setErrorRetryable] = useState(false);
  const [retry, setRetry] = useState(0);
  const generationRef = useRef(0);
  const hydratedRef = useRef(false);
  const dirtyRef = useRef(false);
  const fingerprintRef = useRef<string | null>(null);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const latestRef = useRef<AIMessageData[]>([]);

  const persist = useCallback(
    (
      scope: string | null,
      candidate: AIMessageData[],
      generation: number,
    ): void => {
      const sanitized = sanitizeChatHistory(candidate);
      if (!sanitized || !scope) {
        if (generation === generationRef.current) {
          setError(
            "Chat history is available for this session, but cannot be encrypted until the signed-in workspace identity is resolved.",
          );
          setErrorRetryable(false);
        }
        return;
      }
      const fingerprint = JSON.stringify(sanitized.value);
      const write = writeQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          await saveSensitiveLocalData({
            identityScope: scope,
            namespace: CHAT_VAULT_NAMESPACE,
            validate: sanitizeChatHistory,
            value: sanitized.value,
          });
          if (generation === generationRef.current) {
            fingerprintRef.current = fingerprint;
            const latest = sanitizeChatHistory(latestRef.current);
            dirtyRef.current =
              !latest || JSON.stringify(latest.value) !== fingerprint;
            setError(null);
            setErrorRetryable(false);
          }
        });
      writeQueueRef.current = write;
      void write.catch(() => {
        if (generation === generationRef.current) {
          dirtyRef.current = true;
          setError(
            "Chat history changed for this session, but the encrypted desktop vault is unavailable. Keep this window open and retry to avoid losing it.",
          );
          setErrorRetryable(true);
        }
      });
    },
    [],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    hydratedRef.current = false;
    dirtyRef.current = false;
    fingerprintRef.current = null;
    onIdentityReset();
    setMessages([]);
    latestRef.current = [];
    setLoading(true);
    setError(null);
    setErrorRetryable(false);
    void loadSensitiveLocalData({
      identityScope,
      namespace: CHAT_VAULT_NAMESPACE,
      fallback: [] as AIMessageData[],
      validate: sanitizeChatHistory,
      unownedLegacyKeys: [CHAT_LS_SUFFIX],
      unownedTenantLegacySuffixes: [CHAT_LS_SUFFIX],
    }).then((loaded) => {
      if (generation !== generationRef.current) return;
      hydratedRef.current = true;
      latestRef.current = loaded.value;
      fingerprintRef.current = JSON.stringify(loaded.value);
      setMessages(loaded.value);
      setLoadedScope(scopeToken);
      setLoading(false);
      setError(loaded.warning);
      setErrorRetryable(loaded.retryable);
    });
    return () => {
      if (generation === generationRef.current) generationRef.current += 1;
    };
  }, [identityScope, onIdentityReset, retry, scopeToken]);

  useEffect(() => {
    latestRef.current = messages;
    if (!hydratedRef.current) return;
    const sanitized = sanitizeChatHistory(messages);
    if (!sanitized) return;
    const fingerprint = JSON.stringify(sanitized.value);
    if (fingerprint === fingerprintRef.current) return;
    dirtyRef.current = true;
    const generation = generationRef.current;
    const timer = window.setTimeout(() => {
      persist(identityScope, messages, generation);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [identityScope, messages, persist]);

  useEffect(() => {
    const scope = identityScope;
    const generation = generationRef.current;
    return () => {
      if (hydratedRef.current && dirtyRef.current) {
        persist(scope, latestRef.current, generation);
      }
    };
  }, [identityScope, persist]);

  const retryStorage = useCallback((): void => {
    if (dirtyRef.current) {
      persist(identityScope, latestRef.current, generationRef.current);
    } else {
      setRetry((value) => value + 1);
    }
  }, [identityScope, persist]);

  const ownsRenderedScope = loadedScope === scopeToken;
  return {
    messages: ownsRenderedScope ? messages : [],
    setMessages,
    loading: !ownsRenderedScope || loading,
    error: ownsRenderedScope ? error : null,
    errorRetryable: ownsRenderedScope && errorRetryable,
    retryStorage,
    ready: ownsRenderedScope && hydratedRef.current,
  };
}
