// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Moosewave AI chat (desktop PostwaveAIChatPanel.tsx + pages/PostwaveAI.tsx).
//
// Verbs: send a prompt with an optional tone; Stop generation (aborts the one
// in-flight request); Regenerate a finished reply; Retry a failed one; quick
// prompts; @mentions that attach campaigns / sequences / forms as context;
// /slash commands; Ctrl/⌘+Enter to send; Jump to latest; Clear chat history.
//
// Transport and context resolution live in lib/ai-chat-api; history and saved
// prompts are device-local (lib/ai-chat-storage). Generation is a campaign
// write on the server (write_campaigns), so the composer is withheld — with
// the reason — from roles that cannot write campaigns, and authority is
// re-read fresh before every request.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import { AI_DISCLOSURE_TEXT } from "@postwave/ai-disclosure";

import {
  applyToneHint,
  isAiTone,
  TonePicker,
  type AiTone,
} from "@/components/ai/TonePicker";
import { SavedPromptsCard } from "@/components/ai/SavedPromptsCard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AI_CHAT_MAX_CONTEXT_REFS,
  AI_CHAT_PROMPT_MAX_CHARS,
  buildAiChatContextText,
  generateAiChatReply,
  getAiChatVoiceProfile,
  inferAiChatKind,
  listAiChatCampaigns,
  listAiChatForms,
  listAiChatSequences,
  mentionRefs,
  mentionToken,
  stripMentionSyntax,
  type AiContextRef,
  type AiMentionCandidate,
} from "@/lib/ai-chat-api";
import {
  clearAiChatHistory,
  newAiLocalId,
  readAiChatHistory,
  writeAiChatHistory,
  type AiChatMessage,
  type AiChatStorageScope,
} from "@/lib/ai-chat-storage";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import {
  canWriteCampaigns,
  confirmFreshCampaignWriteAuthority,
} from "@/lib/campaign-write-authority";
import { base, qk, STALE } from "@/lib/query-keys";
import { isServiceNotDeployed } from "@/lib/service-availability";

export interface PostwaveAIQuickPrompt {
  id: string;
  label: string;
  fill: string;
}

export const AI_CHAT_QUICK_PROMPTS: readonly PostwaveAIQuickPrompt[] = [
  { id: "draft-campaign", label: "Draft a campaign", fill: "Draft a campaign about " },
  {
    id: "subject-lines",
    label: "Suggest subject lines",
    fill: "Suggest five subject lines for an email about ",
  },
  { id: "test-plan", label: "Build a test plan", fill: "Build a focused A/B test plan for " },
  {
    id: "deliverability-plan",
    label: "Review deliverability",
    fill: "Create a pre-launch deliverability checklist for ",
  },
  {
    id: "plan-sequence",
    label: "Plan a sequence",
    fill: "Plan a 4-step welcome sequence for new subscribers tagged ",
  },
];

interface SlashCommand {
  id: string;
  label: string;
  hint: string;
  fill: string;
  action?: "clear";
}

export const AI_CHAT_SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: "draft", label: "/draft", hint: "Draft a campaign", fill: "Draft a campaign about " },
  {
    id: "subject",
    label: "/subject",
    hint: "Suggest subject lines",
    fill: "Suggest five subject lines for an email about ",
  },
  {
    id: "summarize",
    label: "/summarize",
    hint: "Summarize this week",
    fill: "Summarize this week's campaign performance.",
  },
  {
    id: "sequence",
    label: "/sequence",
    hint: "Plan a sequence",
    fill: "Plan a 4-step welcome sequence for new subscribers tagged ",
  },
  { id: "clear", label: "/clear", hint: "Clear chat history", fill: "", action: "clear" },
  { id: "new", label: "/new", hint: "Start a new conversation", fill: "", action: "clear" },
];

const STOPPED_MESSAGE = "Generation stopped by you.";
const AI_CHAT_NOT_DEPLOYED_MESSAGE =
  "AI chat isn't available in this environment.";
const HISTORY_REFUSED =
  "This conversation changed, but this browser refused to store it. Retry before closing the page to keep it.";
const MENTION_LIMIT = 8;

interface Trigger {
  kind: "mention" | "slash";
  start: number;
  end: number;
  query: string;
}

/** The `@query` or line-leading `/query` token the caret sits at the end of. */
export function detectComposerTrigger(
  value: string,
  caret: number,
): Trigger | null {
  const before = value.slice(0, caret);
  const match = /(^|\s)([@/])([^\s@/]{0,40})$/.exec(before);
  if (!match) return null;
  const query = match[3] ?? "";
  const start = caret - query.length - 1;
  if (match[2] === "/") {
    const lineStart = before.lastIndexOf("\n", start - 1) + 1;
    if (before.slice(lineStart, start).trim() !== "") return null;
    return { kind: "slash", start, end: caret, query: query.toLowerCase() };
  }
  return { kind: "mention", start, end: caret, query };
}

function matches(candidate: AiMentionCandidate, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    candidate.label.toLowerCase().includes(q) ||
    candidate.hint.toLowerCase().includes(q)
  );
}

export function PostwaveAIChatPanel({ identity }: { identity: MeResponse }) {
  const queryClient = useQueryClient();
  const role = effectiveAuthRole(identity);
  const tenantId = identity.tenant_id;
  const scope = useMemo<AiChatStorageScope>(
    () => ({ tenantId: identity.tenant_id, userId: identity.user_id }),
    [identity.tenant_id, identity.user_id],
  );
  const canGenerate = canWriteCampaigns(identity);
  const deniedReason =
    identity.viewer_mode === true
      ? "This session is in viewer mode, so AI generation is refused. Leave viewer mode to chat."
      : "View-only: running AI generation requires an editor, admin, or owner role.";

  const [messages, setMessages] = useState<AiChatMessage[]>(() =>
    readAiChatHistory(scope),
  );
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [tone, setTone] = useState<AiTone>("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Set by the first "not deployed" answer: this environment runs no AI
  // service, so the composer closes instead of letting every message fail
  // the same way.
  const [notDeployed, setNotDeployed] = useState(false);
  const chatAvailable = canGenerate && !notDeployed;
  const [pinned, setPinned] = useState(true);
  const [clearOpen, setClearOpen] = useState(false);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [mentionsWanted, setMentionsWanted] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerId = useId();
  const toneId = useId();
  const hintId = useId();
  const listboxId = useId();

  // Persist every settled change; an in-flight turn is stored as pending and
  // becomes "interrupted" if the page closes before it resolves.
  const firstPersist = useRef(true);
  useEffect(() => {
    if (firstPersist.current) {
      firstPersist.current = false;
      return;
    }
    setHistoryError(writeAiChatHistory(scope, messages) ? null : HISTORY_REFUSED);
  }, [messages, scope]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const el = historyRef.current;
    if (pinned && el) el.scrollTop = el.scrollHeight;
  }, [messages, pinned]);

  const campaignsKey = qk.campaigns(tenantId, role, { purpose: "ai-chat-context" });
  const formsKey = qk.forms(tenantId, role, { purpose: "ai-chat-context" });
  const sequencesKey = [
    ...base("voice-sequences", tenantId, role),
    "ai-chat-context",
  ] as const;
  const profileKey = [
    ...base("voice-profile", tenantId, role),
    "ai-chat-context",
  ] as const;

  const campaignsQuery = useQuery({
    queryKey: campaignsKey,
    queryFn: ({ signal }) => listAiChatCampaigns(signal),
    staleTime: STALE.list,
    enabled: mentionsWanted,
  });
  const sequencesQuery = useQuery({
    queryKey: sequencesKey,
    queryFn: ({ signal }) => listAiChatSequences(signal),
    staleTime: STALE.list,
    enabled: mentionsWanted,
  });
  const formsQuery = useQuery({
    queryKey: formsKey,
    queryFn: ({ signal }) => listAiChatForms(signal),
    staleTime: STALE.list,
    enabled: mentionsWanted,
  });
  const mentionLoading =
    campaignsQuery.isPending || sequencesQuery.isPending || formsQuery.isPending;
  const mentionFailed =
    campaignsQuery.isError || sequencesQuery.isError || formsQuery.isError;

  const mentionItems = useMemo(() => {
    if (trigger?.kind !== "mention") return [];
    const all = [
      campaignsQuery.data,
      sequencesQuery.data,
      formsQuery.data,
    ]
      .flatMap((rows) => (Array.isArray(rows) ? rows : []))
      .filter((candidate) => matches(candidate, trigger.query));
    const q = trigger.query.toLowerCase();
    if (q) {
      all.sort(
        (a, b) =>
          Number(!a.label.toLowerCase().startsWith(q)) -
          Number(!b.label.toLowerCase().startsWith(q)),
      );
    }
    return all.slice(0, MENTION_LIMIT);
  }, [campaignsQuery.data, formsQuery.data, sequencesQuery.data, trigger]);

  const slashItems = useMemo(
    () =>
      trigger?.kind === "slash"
        ? AI_CHAT_SLASH_COMMANDS.filter((command) =>
            command.id.startsWith(trigger.query),
          )
        : [],
    [trigger],
  );
  const menuOpen = trigger !== null;
  const menuLength =
    trigger?.kind === "mention" ? mentionItems.length : slashItems.length;
  const boundedIndex = menuLength === 0 ? 0 : Math.min(activeIndex, menuLength - 1);

  const updateTrigger = (value: string, caret: number): void => {
    const next = detectComposerTrigger(value, caret);
    setTrigger(next);
    setActiveIndex(0);
    if (next?.kind === "mention") setMentionsWanted(true);
  };

  const replaceTriggerWith = (text: string): void => {
    if (!trigger) return;
    const next = input.slice(0, trigger.start) + text + input.slice(trigger.end);
    setInput(next.slice(0, AI_CHAT_PROMPT_MAX_CHARS));
    setTrigger(null);
    const caret = trigger.start + text.length;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caret, caret);
    });
  };

  const requestClear = useCallback((): void => {
    if (messages.length === 0) return;
    setClearOpen(true);
  }, [messages.length]);

  const pickSlash = (command: SlashCommand): void => {
    if (command.action === "clear") {
      replaceTriggerWith("");
      requestClear();
      return;
    }
    replaceTriggerWith(command.fill);
  };

  const pickMention = (candidate: AiMentionCandidate): void => {
    replaceTriggerWith(`${mentionToken(candidate)} `);
  };

  const updateAssistant = (
    id: string,
    update: (message: AiChatMessage) => AiChatMessage,
  ): void => {
    setMessages((previous) =>
      previous.map((message) => (message.id === id ? update(message) : message)),
    );
  };

  const resolveContext = async (
    refs: readonly AiContextRef[],
  ): Promise<{ refs: AiContextRef[]; text: string }> => {
    const kinds = new Set(refs.map((ref) => ref.kind));
    const loads: Array<Promise<AiMentionCandidate[]>> = [];
    if (kinds.has("campaign")) {
      loads.push(
        queryClient
          .fetchQuery({
            queryKey: campaignsKey,
            queryFn: ({ signal }) => listAiChatCampaigns(signal),
            staleTime: STALE.list,
          })
          .catch(() => []),
      );
    }
    if (kinds.has("sequence")) {
      loads.push(
        queryClient
          .fetchQuery({
            queryKey: sequencesKey,
            queryFn: ({ signal }) => listAiChatSequences(signal),
            staleTime: STALE.list,
          })
          .catch(() => []),
      );
    }
    if (kinds.has("form")) {
      loads.push(
        queryClient
          .fetchQuery({
            queryKey: formsKey,
            queryFn: ({ signal }) => listAiChatForms(signal),
            staleTime: STALE.list,
          })
          .catch(() => []),
      );
    }
    // The ready voice profile is requested automatically (desktop parity); a
    // workspace without one simply sends no voice block.
    const profile = await queryClient
      .fetchQuery({
        queryKey: profileKey,
        queryFn: ({ signal }) => getAiChatVoiceProfile(signal),
        staleTime: STALE.list,
      })
      .catch(() => null);
    const candidates = (await Promise.all(loads)).flat();
    const requestRefs: AiContextRef[] = profile
      ? [...refs, { kind: "voice_profile", id: "active" }]
      : [...refs];
    return {
      refs: requestRefs,
      text: buildAiChatContextText(requestRefs, candidates, profile),
    };
  };

  const runPrompt = (
    rawPrompt: string,
    requestTone: AiTone,
    replaceId?: string,
  ): void => {
    const prompt = rawPrompt.trim();
    if (
      !chatAvailable ||
      !prompt ||
      prompt.length > AI_CHAT_PROMPT_MAX_CHARS ||
      controllerRef.current
    ) {
      return;
    }
    const refs = mentionRefs(prompt);
    if (refs.length > AI_CHAT_MAX_CONTEXT_REFS - 1) {
      setNotice(
        `Attach up to ${AI_CHAT_MAX_CONTEXT_REFS - 1} workspace resources per prompt; one of ${AI_CHAT_MAX_CONTEXT_REFS} slots is reserved for the voice profile.`,
      );
      return;
    }
    setNotice(null);
    setPinned(true);
    const assistantId = replaceId ?? newAiLocalId("a");
    const now = Date.now();
    if (replaceId) {
      updateAssistant(replaceId, (message) => ({
        id: message.id,
        role: "assistant",
        content: "",
        createdAt: now,
        status: "pending",
        sourcePrompt: prompt,
        sourceTone: requestTone,
      }));
    } else {
      setMessages((previous) => [
        ...previous,
        {
          id: newAiLocalId("u"),
          role: "user",
          content: prompt + (requestTone ? `  ·  tone: ${requestTone}` : ""),
          createdAt: now,
          status: "done",
        },
        {
          id: assistantId,
          role: "assistant",
          content: "",
          createdAt: now,
          status: "pending",
          sourcePrompt: prompt,
          sourceTone: requestTone,
        },
      ]);
      setInput("");
      setTrigger(null);
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsGenerating(true);
    void (async () => {
      try {
        await confirmFreshCampaignWriteAuthority(identity, controller.signal);
        const context = await resolveContext(refs);
        if (controllerRef.current !== controller) return;
        const reply = await generateAiChatReply({
          prompt: applyToneHint(stripMentionSyntax(prompt), requestTone),
          kind: inferAiChatKind(prompt),
          contextRefs: context.refs,
          contextText: context.text,
          signal: controller.signal,
        });
        if (controllerRef.current !== controller) return;
        updateAssistant(assistantId, (message) => ({
          ...message,
          content: reply.text,
          status: "done",
          ...(reply.draft?.subject ? { draftSubject: reply.draft.subject } : {}),
          ...(reply.draft?.previewText
            ? { draftPreview: reply.draft.previewText }
            : {}),
        }));
      } catch (err) {
        if (controllerRef.current !== controller) return;
        if (isServiceNotDeployed(err)) {
          // Not a failure of this reply: this environment runs no AI service.
          // The pending reply goes, one neutral notice says so, and the
          // composer closes; a Retry or another message could never succeed.
          setMessages((current) =>
            current.filter((message) => message.id !== assistantId),
          );
          setNotDeployed(true);
          return;
        }
        updateAssistant(assistantId, (message) => ({
          ...message,
          status: "error",
          errorMessage: apiErrorMessage(
            err,
            "Moosewave AI could not complete this reply. Retry when ready.",
          ),
        }));
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setIsGenerating(false);
        }
      }
    })();
  };

  const submit = (): void => runPrompt(input, tone);

  const stop = (): void => {
    const controller = controllerRef.current;
    if (!controller) return;
    controllerRef.current = null;
    controller.abort();
    setIsGenerating(false);
    setMessages((previous) =>
      previous.map((message) =>
        message.status === "pending"
          ? { ...message, status: "error", errorMessage: STOPPED_MESSAGE }
          : message,
      ),
    );
  };

  const replay = (message: AiChatMessage): void => {
    if (!message.sourcePrompt) return;
    runPrompt(
      message.sourcePrompt,
      isAiTone(message.sourceTone) ? message.sourceTone : "",
      message.id,
    );
  };

  const performClear = (): void => {
    const controller = controllerRef.current;
    controllerRef.current = null;
    controller?.abort();
    setIsGenerating(false);
    firstPersist.current = true;
    setMessages([]);
    setPinned(true);
    setHistoryError(
      clearAiChatHistory(scope)
        ? null
        : "This browser refused to remove the stored conversation. Retry clearing before leaving a shared device.",
    );
  };

  const jumpToLatest = (): void => {
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setPinned(true);
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (menuOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        setTrigger(null);
        return;
      }
      if (menuLength > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        setActiveIndex((index) =>
          event.key === "ArrowDown"
            ? (index + 1) % menuLength
            : (index - 1 + menuLength) % menuLength,
        );
        return;
      }
      if (
        menuLength > 0 &&
        (event.key === "Tab" ||
          (event.key === "Enter" && !event.metaKey && !event.ctrlKey))
      ) {
        event.preventDefault();
        if (trigger?.kind === "mention") {
          const item = mentionItems[boundedIndex];
          if (item) pickMention(item);
        } else {
          const command = slashItems[boundedIndex];
          if (command) pickSlash(command);
        }
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  const sendDisabled =
    !chatAvailable ||
    !input.trim() ||
    input.length > AI_CHAT_PROMPT_MAX_CHARS ||
    isGenerating;
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section
        aria-label="Moosewave AI chat"
        className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-3 sm:p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden />
            Chat with Moosewave AI
          </h2>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={requestClear}
            disabled={messages.length === 0}
          >
            <Trash2 aria-hidden />
            Clear chat
          </Button>
        </div>

        {!canGenerate ? (
          <Alert role="note">
            <AlertDescription>{deniedReason}</AlertDescription>
          </Alert>
        ) : null}

        {canGenerate && notDeployed ? (
          <Alert role="status">
            <AlertDescription>{AI_CHAT_NOT_DEPLOYED_MESSAGE}</AlertDescription>
          </Alert>
        ) : null}

        {historyError ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription className="space-y-2">
              <p>{historyError}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setHistoryError(
                    messages.length === 0
                      ? clearAiChatHistory(scope)
                        ? null
                        : historyError
                      : writeAiChatHistory(scope, messages)
                        ? null
                        : HISTORY_REFUSED,
                  )
                }
              >
                <RefreshCw aria-hidden />
                Retry storage
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="relative min-w-0">
          <div
            ref={historyRef}
            role="log"
            aria-label="Moosewave AI conversation"
            aria-live="polite"
            tabIndex={0}
            data-testid="ai-chat-history"
            className="max-h-[60vh] min-h-48 space-y-3 overflow-y-auto rounded-md border bg-background p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onScroll={(event) => {
              const el = event.currentTarget;
              setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
            }}
          >
            {messages.length === 0 ? (
              <div className="space-y-3 py-6 text-center">
                <p className="text-sm text-muted-foreground">
                  Move from a blank page to review-ready copy. Start with a
                  quick prompt, type / for commands, or @ to attach a
                  campaign, sequence, or form.
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {AI_CHAT_QUICK_PROMPTS.map((prompt) => (
                    <Button
                      key={prompt.id}
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setInput(prompt.fill);
                        inputRef.current?.focus();
                      }}
                    >
                      {prompt.label}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Prompts go to your workspace&apos;s Moosewave AI service with
                  your voice profile when one is built. This conversation is
                  kept in this browser for you and this workspace.
                </p>
              </div>
            ) : (
              messages.map((message) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  canGenerate={chatAvailable && !isGenerating}
                  onReplay={replay}
                />
              ))
            )}
          </div>
          {!pinned && messages.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="absolute bottom-3 right-3"
              onClick={jumpToLatest}
            >
              <ArrowDown aria-hidden />
              Jump to latest
            </Button>
          ) : null}
        </div>

        {notice ? (
          <p role="alert" className="text-sm text-destructive-emphasis">
            {notice}
          </p>
        ) : null}

        <TonePicker
          id={toneId}
          value={tone}
          disabled={!chatAvailable}
          onChange={setTone}
        />

        <form
          className="relative space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {menuOpen ? (
            <ul
              id={listboxId}
              role="listbox"
              aria-label={
                trigger?.kind === "mention"
                  ? "Attach workspace context"
                  : "Chat commands"
              }
              className="absolute bottom-full left-0 z-10 mb-2 max-h-64 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-pw-sm sm:w-96"
            >
              {trigger?.kind === "mention" && mentionLoading ? (
                <li role="presentation" className="px-2 py-1.5 text-sm text-muted-foreground">
                  Loading campaigns, sequences, and forms…
                </li>
              ) : null}
              {trigger?.kind === "mention" && mentionFailed ? (
                <li role="presentation" className="px-2 py-1.5 text-sm text-destructive-emphasis">
                  Some workspace resources could not be loaded; they are
                  missing from this list.
                </li>
              ) : null}
              {trigger?.kind === "mention"
                ? mentionItems.map((item, index) => (
                    <li
                      key={`${item.kind}:${item.id}`}
                      id={optionId(index)}
                      role="option"
                      aria-selected={index === boundedIndex}
                      className="cursor-pointer rounded px-2 py-1.5 text-sm data-[selected=true]:bg-accent"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        pickMention(item);
                      }}
                      onMouseEnter={() => setActiveIndex(index)}
                    >
                      <span className="font-medium">{item.label}</span>{" "}
                      <span className="text-xs text-muted-foreground">
                        {item.kind}
                        {item.hint ? ` · ${item.hint}` : ""}
                      </span>
                    </li>
                  ))
                : slashItems.map((command, index) => (
                    <li
                      key={command.id}
                      id={optionId(index)}
                      role="option"
                      aria-selected={index === boundedIndex}
                      className="cursor-pointer rounded px-2 py-1.5 text-sm data-[selected=true]:bg-accent"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        pickSlash(command);
                      }}
                      onMouseEnter={() => setActiveIndex(index)}
                    >
                      <span className="font-medium">{command.label}</span>{" "}
                      <span className="text-xs text-muted-foreground">
                        {command.hint}
                      </span>
                    </li>
                  ))}
              {menuLength === 0 &&
              !(trigger?.kind === "mention" && mentionLoading) ? (
                <li role="presentation" className="px-2 py-1.5 text-sm text-muted-foreground">
                  {trigger?.kind === "mention"
                    ? "No matching campaign, sequence, or form."
                    : "No matching command."}
                </li>
              ) : null}
            </ul>
          ) : null}
          <Label htmlFor={composerId}>Ask Moosewave AI</Label>
          <Textarea
            ref={inputRef}
            id={composerId}
            value={input}
            rows={3}
            maxLength={AI_CHAT_PROMPT_MAX_CHARS}
            disabled={!chatAvailable}
            placeholder="Ask Moosewave AI… Type / for commands or @ for context"
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? listboxId : undefined}
            aria-activedescendant={
              menuOpen && menuLength > 0 ? optionId(boundedIndex) : undefined
            }
            aria-describedby={hintId}
            onChange={(event) => {
              setInput(event.target.value);
              updateTrigger(
                event.target.value,
                event.target.selectionStart ?? event.target.value.length,
              );
            }}
            onKeyDown={onComposerKeyDown}
            onBlur={() => setTrigger(null)}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p id={hintId} className="text-xs text-muted-foreground">
              {!canGenerate
                ? deniedReason
                : isGenerating
                  ? "Generating · you can draft the next prompt"
                  : "Type / for commands · @ for context · Ctrl/⌘+Enter to send"}{" "}
              <span className="tabular-nums">
                {input.length.toLocaleString()} /{" "}
                {AI_CHAT_PROMPT_MAX_CHARS.toLocaleString()}
              </span>
            </p>
            <div className="flex gap-2">
              {isGenerating ? (
                <Button type="button" variant="outline" size="sm" onClick={stop}>
                  <Square aria-hidden />
                  Stop generation
                </Button>
              ) : null}
              <Button type="submit" size="sm" disabled={sendDisabled}>
                <Send aria-hidden />
                Send
              </Button>
            </div>
          </div>
        </form>
      </section>

      <SavedPromptsCard
        scope={scope}
        role={role}
        currentPrompt={input}
        onApply={(prompt) => {
          setInput(prompt.slice(0, AI_CHAT_PROMPT_MAX_CHARS));
          inputRef.current?.focus();
        }}
      />

      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="Clear chat history?"
        description={`This permanently removes all ${messages.length} message${messages.length === 1 ? "" : "s"} of this conversation from this browser for you and this workspace. Moosewave keeps no server copy, so it cannot be recovered.`}
        confirmLabel="Clear chat"
        onConfirm={performClear}
      />
    </div>
  );
}

function ChatMessage({
  message,
  canGenerate,
  onReplay,
}: {
  message: AiChatMessage;
  canGenerate: boolean;
  onReplay: (message: AiChatMessage) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="ml-auto max-w-[85%] rounded-lg bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap break-words">
        <span className="sr-only">You: </span>
        {message.content}
      </div>
    );
  }
  return (
    <article
      aria-label="Moosewave AI reply"
      className="max-w-[92%] space-y-2 rounded-lg border px-3 py-2 text-sm"
    >
      {message.status === "pending" ? (
        <p role="status" className="text-muted-foreground">
          Generating…
        </p>
      ) : message.status === "error" ? (
        <div className="space-y-2">
          <p className="text-destructive-emphasis">{message.errorMessage}</p>
          {canGenerate && message.sourcePrompt ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onReplay(message)}
            >
              <RotateCcw aria-hidden />
              Retry
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
          {message.draftSubject ? (
            <dl className="rounded-md bg-muted/40 p-2 text-xs">
              <dt className="font-semibold">Draft subject</dt>
              <dd className="break-words">{message.draftSubject}</dd>
              {message.draftPreview ? (
                <>
                  <dt className="mt-1 font-semibold">Preview text</dt>
                  <dd className="break-words">{message.draftPreview}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
          <p className="text-[11px] leading-tight text-muted-foreground">
            {AI_DISCLOSURE_TEXT}
          </p>
          {canGenerate && message.sourcePrompt ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onReplay(message)}
            >
              <RefreshCw aria-hidden />
              Regenerate
            </Button>
          ) : null}
        </>
      )}
    </article>
  );
}
