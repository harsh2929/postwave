/**
 * Moosewave AI — multi-mode AI workspace.
 *
 * The page used to be a single chat panel. It's now a tabbed workspace
 * because the AI surface area on the backend supports six distinct
 * intents, each with its own ideal UI:
 *
 *   1. Chat       — free-form Q&A about audience, campaigns, sequences.
 *                   Streaming response via /api/v1/voice/generate.
 *   2. Compose    — structured "brief → draft + variants" via the
 *                   dedicated /api/v1/ai/compose/broadcast endpoint.
 *   3. Subject lab — canonical confidence/baseline workflow with an
 *                   explicit campaign-draft handoff.
 *   4. Pre-send   — unified verdict (EQ + drift + placement) tester via
 *                   /api/v1/presend/verdict.
 *   5. Agent      — contextual bridge to MCP execution observability.
 *   6. Routines   — approval-gated scheduled drafting workflows.
 *
 * A collapsible contextual inspector shows voice, saved-prompt, or execution
 * context without permanently shrinking the active canvas. Chat history is
 * persisted in the identity-scoped encrypted local vault with bounded
 * retention. Ownership-ambiguous legacy chat keys are purged without being
 * imported into the active account.
 */

import {
  type ChangeEvent,
  type CompositionEvent,
  type Dispatch,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
  type SetStateAction,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import "../styles-ai-autocomplete.css";
import "../styles-postwave-ai.css";

import type { AIGroundingChip, AIMessageData } from "../components/AIMessage";
import { ConfirmModal } from "../components/ConfirmModal";
import { AIInteractionDisclosure } from "../components/ai/AIInteractionDisclosure";
import { McpAgentSummary } from "../components/ai/McpAgentSummary";
import { ComposeBroadcastForm } from "../components/ai/ComposeBroadcastForm";
import {
  type MentionItem,
  buildMentionToken,
} from "../components/ai/MentionMenu";
import {
  PostwaveAIChatPanel,
  type PostwaveAIQuickPrompt,
} from "../components/ai/PostwaveAIChatPanel";
import { BrandVoicePanel } from "../components/ai/BrandVoicePanel";
import { PresendCheckPanel } from "../components/ai/PresendCheckPanel";
import { RecentExecutionsStrip } from "../components/ai/RecentExecutionsStrip";
import { RoutinesPanel } from "../components/ai/RoutinesPanel";
import { SavedPromptsCard } from "../components/ai/SavedPromptsCard";
import {
  type SlashCommand,
  filterSlashCommands,
} from "../components/ai/SlashCommandMenu";
import {
  SubjectLabWorkspace,
  type SubjectLabCampaignHandoff,
} from "../components/SubjectLabWorkspace";
import type { Tone } from "../components/ai/TonePicker";
import { VoiceProfileCard } from "../components/ai/VoiceProfileCard";
import { Notice } from "../components/Notice";
import { toast } from "../components/Toast";
import {
  type AIRequestInput,
  type AIStreamHandle,
  MAX_AI_CONTEXT_REFS,
  buildGroundingChips,
  detectContextRefs,
  normalizeAIContextRefs,
  streamAIGenerate,
  stripMentionSyntax,
} from "../lib/ai-client";
import {
  api,
  type AIContextRef,
  type AIGenerateDraft,
  type AIGenerateKind,
  type VoiceProfile,
} from "../lib/api-client";
import type { Section } from "../lib/store";
import {
  requestDesktopRouteNavigation,
  useDesktopRouteTab,
} from "../lib/desktop-router";
import { useEncryptedChatHistory } from "../hooks/useEncryptedChatHistory";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import { sensitiveLocalIdentityScope } from "../lib/sensitive-local-data";
import { useCanWrite, useMe } from "../lib/store";
import {
  markAIGeneratedHTML,
  peekPendingCampaignDraft,
  setPendingCampaignDraft,
  type PendingCampaignDraft,
} from "../lib/template-handoff";

/* ---------- modes --------------------------------------------------- */

export type Mode =
  | "chat"
  | "compose"
  | "subject"
  | "presend"
  | "agent"
  | "routines";

const MODES: { id: Mode; label: string; hint: string }[] = [
  {
    id: "chat",
    label: "Chat",
    hint: "Q&A with voice + context you explicitly attach",
  },
  { id: "compose", label: "Compose", hint: "Brief → draft + subject variants" },
  { id: "subject", label: "Subject lab", hint: "Generate + score variants" },
  { id: "presend", label: "Pre-send", hint: "EQ · drift · placement check" },
  {
    id: "agent",
    label: "Agent",
    hint: "Review release-held MCP source candidate",
  },
  {
    id: "routines",
    label: "Routines",
    hint: "Scheduled agent drafting — drafts only, approval-gated",
  },
];
const MODE_VALUES = MODES.map((item) => item.id);
const MODE_TAB_ITEMS = MODES.map((item) => ({ value: item.id }));
const CHAT_PROMPT_MAX_CHARS = 8_000;

function boundChatPrompt(value: string): string {
  return value.slice(0, CHAT_PROMPT_MAX_CHARS);
}

export function usePostwaveModeTabs(
  mode: Mode,
  onChange: (mode: Mode) => void,
) {
  return useTabsInteraction({
    value: mode,
    items: MODE_TAB_ITEMS,
    onChange,
    activation: "manual",
  });
}

type PostwaveModeTabsController = ReturnType<typeof usePostwaveModeTabs>;

export function PostwaveAIModeTabs({
  mode,
  tabs,
}: {
  mode: Mode;
  tabs: PostwaveModeTabsController;
}): ReactElement {
  return (
    <div
      ref={tabs.listRef}
      {...tabs.listProps}
      aria-label="Moosewave AI mode"
      className="ai-mode-tabs"
    >
      {MODES.map((item, index) => {
        const active = mode === item.id;
        return (
          <button
            key={item.id}
            type="button"
            {...tabs.getTabProps(item.id)}
            aria-label={`${item.label}: ${item.hint}`}
            className="ai-mode-tab"
            data-active={active ? "true" : undefined}
          >
            <span className="ai-mode-copy">
              <strong>{item.label}</strong>
              <small>{item.hint}</small>
            </span>
            <span className="ai-mode-index" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------- slash command trigger detection ----------------------- */

interface SlashTrigger {
  /** Index of the `/` character in the text. */
  start: number;
  /** Token typed after the `/` (excluding the slash itself). */
  query: string;
}

/**
 * Return the active slash trigger if the cursor sits inside a `/word`
 * that lives at the start of a line or directly after whitespace. Used
 * to know when to open the popover and what to filter against.
 */
function detectSlashTrigger(text: string, caret: number): SlashTrigger | null {
  // Walk back from the caret to find a `/` that is either at index 0 or
  // preceded by whitespace. Bail out if we hit a space or newline first
  // (means the caret is not inside a slash token).
  let i = caret;
  while (i > 0) {
    const ch = text[i - 1];
    if (ch === "/") {
      const prev = i - 2 >= 0 ? text[i - 2] : "";
      if (i - 2 < 0 || prev === " " || prev === "\n" || prev === "\t") {
        const query = text.slice(i, caret);
        // Reject queries that contain whitespace — they're no longer a
        // single slash token (user moved past it).
        if (/\s/.test(query)) return null;
        return { start: i - 1, query };
      }
      return null;
    }
    if (ch === " " || ch === "\n" || ch === "\t") return null;
    i -= 1;
  }
  return null;
}

/* ---------- @-mention trigger detection ---------------------------- */

interface MentionTrigger {
  /** Index of the `@` character in the text. */
  start: number;
  /** Token typed after the `@` (excluding the sigil itself). */
  query: string;
}

/**
 * Return the active mention trigger if the cursor sits inside a `@word`
 * that begins at index 0 or directly after whitespace. Bails out the
 * moment the token has already been closed into the pill form
 * `@[…](type:id)` — those need to stay rendered, not re-trigger the
 * menu — and also when the user has typed whitespace past the sigil.
 */
function detectMentionTrigger(
  text: string,
  caret: number,
): MentionTrigger | null {
  let i = caret;
  while (i > 0) {
    const ch = text[i - 1];
    if (ch === "@") {
      const prev = i - 2 >= 0 ? text[i - 2] : "";
      if (i - 2 < 0 || prev === " " || prev === "\n" || prev === "\t") {
        const query = text.slice(i, caret);
        // `[` means the user already accepted a mention — that token is
        // a pill, not a fresh trigger; leave the menu closed.
        if (query.startsWith("[")) return null;
        if (/[\s\n]/.test(query)) return null;
        return { start: i - 1, query };
      }
      return null;
    }
    if (ch === " " || ch === "\n" || ch === "\t") return null;
    i -= 1;
  }
  return null;
}

function autocompleteFingerprint(text: string, caret: number): string {
  return `${caret}\u0000${text}`;
}

/**
 * Find a complete mention token `@[Name](type:id)` whose end index is
 * exactly at `caret`. Used by the backspace handler to detect "cursor
 * sits at the end of a pill" and delete the whole token in one stroke.
 */
function findTokenEndingAt(
  text: string,
  caret: number,
): { start: number; end: number; type: string; id: string } | null {
  // Walk backwards from caret looking for the `@[` opener. Bounded scan
  // (token has a strict length envelope) so this is O(1) per keystroke.
  if (caret <= 0 || text[caret - 1] !== ")") return null;
  const maxLookback = Math.min(caret, 240);
  for (let i = caret - 1; i >= caret - maxLookback; i -= 1) {
    if (text[i] === "@" && text[i + 1] === "[") {
      const slice = text.slice(i, caret);
      const m = slice.match(
        /^@\[([^\]\n]{1,120})\]\((\w+):([a-zA-Z0-9_-]{1,64})\)$/,
      );
      if (m) {
        return {
          start: i,
          end: caret,
          type: (m[2] ?? "").toLowerCase(),
          id: m[3] ?? "",
        };
      }
      return null;
    }
  }
  return null;
}

function inferKind(prompt: string): AIGenerateKind {
  const p = prompt.toLowerCase();
  if (/\bsubject(?:\s*line)?\b/.test(p)) return "subject_line";
  if (/\b(draft|campaign|compose|write|email)\b/.test(p)) {
    return "campaign_draft";
  }
  if (/\b(summari[sz]e|summary|report|performance|recap)\b/.test(p)) {
    return "summary";
  }
  return "free_form";
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/* ---------- mention candidate search ------------------------------- */

const MENTION_LIMIT = 8;

/**
 * Walk a list-endpoint response and pull out the row array. Mirrors the
 * `items ?? results ?? data` shape the Go gateway uses for paginated
 * resources — keeps callers from re-implementing the same fallback chain.
 */
function pickItems<T>(
  res: { items?: T[]; data?: T[]; results?: T[] } | null | undefined,
): T[] {
  if (!res) return [];
  return res.items ?? res.results ?? res.data ?? [];
}

function matches(value: string | undefined | null, q: string): boolean {
  if (!q) return true;
  return (value ?? "").toLowerCase().includes(q);
}

/**
 * Pull up to `MENTION_LIMIT` candidates across the four workspace resource
 * kinds currently approved for direct model context. Subscriber records stay
 * excluded until Chat is routed through the server-side PII gateway.
 * for `query`. Each list endpoint runs in parallel; failures degrade
 * silently (a missing API surface should not blank the entire menu).
 *
 * `signal` is threaded into all four list calls, so a superseded
 * search genuinely cancels its network requests (the api-client
 * resolves them with an `aborted` error envelope, which falls into the
 * same silent-degrade path as any other failure). The post-await
 * `signal.aborted` check stays as a belt-and-braces stale-merge guard.
 */
async function fetchMentionCandidates(
  query: string,
  signal: AbortSignal,
): Promise<MentionItem[]> {
  const q = query.trim().toLowerCase();
  const [campaigns, sequences, templates, forms] = await Promise.all([
    api.listCampaigns({ perPage: 40 }, { signal }).catch(() => null),
    api.listSequences({ signal }).catch(() => null),
    api
      .listCampaignTemplates({ query: q || undefined }, { signal })
      .catch(() => null),
    api.listForms({ signal }).catch(() => null),
  ]);
  if (signal.aborted) return [];

  const out: MentionItem[] = [];

  for (const c of pickItems(campaigns?.data)) {
    if (!c.id) continue;
    if (!matches(c.name, q) && !matches(c.subject, q)) continue;
    out.push({
      kind: "campaign",
      id: String(c.id),
      label: c.name ?? c.subject ?? `Campaign ${c.id}`,
      hint: c.subject && c.name && c.subject !== c.name ? c.subject : c.status,
    });
  }
  for (const seq of pickItems(sequences?.data)) {
    if (!seq.id) continue;
    if (!matches(seq.name, q)) continue;
    out.push({
      kind: "sequence",
      id: String(seq.id),
      label: seq.name ?? `Sequence ${seq.id}`,
      hint: seq.status,
    });
  }
  for (const t of templates?.data ?? []) {
    if (!t.id) continue;
    if (!matches(t.name, q) && !matches(t.subject, q)) continue;
    out.push({
      kind: "template",
      id: t.id,
      label: t.name,
      hint: t.subject || t.category,
    });
  }
  for (const f of forms?.data ?? []) {
    if (!f.id) continue;
    if (!matches(f.name, q) && !matches(f.slug, q)) continue;
    out.push({ kind: "form", id: f.id, label: f.name, hint: f.slug });
  }

  // Prefer rows that label-match the query before subject matches
  // so the most likely target sits at the top of the list.
  if (q) {
    out.sort((a, b) => {
      const aHit = a.label.toLowerCase().startsWith(q) ? 0 : 1;
      const bHit = b.label.toLowerCase().startsWith(q) ? 0 : 1;
      return aHit - bHit;
    });
  }
  return out.slice(0, MENTION_LIMIT);
}

/**
 * Reduce a VoiceProfile payload to the minimal label + tooltip the requested-
 * context chip strip needs. Returns null when the profile is not built yet.
 */
function snapshotVoiceProfile(
  p: VoiceProfile | null,
): { label: string; title?: string } | null {
  if (!p) return null;
  const generatedAt =
    typeof p.generated_at === "string" ? p.generated_at : undefined;
  const builtAt = p.built_at ?? generatedAt;
  // Prefer an explicit version when the upstream exposes one; otherwise
  // fall back to a generic label so the chip still reads as a citation.
  const versionRaw = p.version ?? p.profile_version ?? p.revision;
  if (!builtAt && p.status !== "ready" && versionRaw == null) return null;
  const version =
    typeof versionRaw === "number" || typeof versionRaw === "string"
      ? `v${String(versionRaw)}`
      : null;
  const label = version ? `Voice profile ${version}` : "Voice profile";
  let title: string | undefined;
  if (builtAt) {
    const timestamp = Date.parse(builtAt);
    if (Number.isFinite(timestamp)) {
      title = `Built ${new Date(timestamp).toLocaleString()}`;
    }
  }
  return { label, title };
}

function promptContextRefs(
  prompt: string,
  acceptedMentions: Map<string, MentionItem>,
): AIContextRef[] {
  const detected = detectContextRefs(prompt);
  const contextRefs: AIContextRef[] = [...detected];
  const seen = new Set(detected.map((ref) => `${ref.type}:${ref.id}`));
  for (const mention of acceptedMentions.values()) {
    const key = `${mention.kind}:${mention.id}`;
    if (!prompt.includes(`(${mention.kind}:${mention.id})`) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    contextRefs.push({ type: mention.kind, id: mention.id });
  }
  return contextRefs;
}

interface AIConversationInput {
  identityScope: string | null;
  canGenerate: boolean;
  mode: Mode;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  acceptedMentionsRef: RefObject<Map<string, MentionItem>>;
  historyRef: RefObject<HTMLDivElement | null>;
  scrollRafRef: RefObject<number | null>;
  focusRafRef: RefObject<number | null>;
  resetAutocomplete: () => void;
}

function useReadyVoiceProfile(
  identityScope: string | null,
): RefObject<VoiceProfile | null> {
  const profileRef = useRef<VoiceProfile | null>(null);
  useEffect(() => {
    profileRef.current = null;
    let alive = true;
    void api.getVoiceProfile().then(
      (response) => {
        if (alive && !response.error) profileRef.current = response.data;
      },
      () => {
        /* Availability is represented by a missing optional snapshot. */
      },
    );
    return () => {
      alive = false;
    };
  }, [identityScope]);
  return profileRef;
}

function useGenerationRoleGuard(
  canGenerate: boolean,
  streamRef: RefObject<AIStreamHandle | null>,
  setIsGenerating: Dispatch<SetStateAction<boolean>>,
  setMessages: Dispatch<SetStateAction<AIMessageData[]>>,
): void {
  useEffect(() => {
    if (canGenerate || !streamRef.current) return;
    streamRef.current.abort();
    streamRef.current = null;
    setIsGenerating(false);
    setMessages((previous) =>
      previous.map((message) =>
        message.streaming
          ? {
              ...message,
              streaming: false,
              errored: true,
              errorMessage:
                "Generation stopped because your workspace role changed.",
            }
          : message,
      ),
    );
  }, [canGenerate, setIsGenerating, setMessages, streamRef]);
}

function useConversationViewport({
  mode,
  historyPinned,
  setHistoryPinned,
  messages,
  historyRef,
  scrollRafRef,
  focusRafRef,
  streamRef,
}: {
  mode: Mode;
  historyPinned: boolean;
  setHistoryPinned: Dispatch<SetStateAction<boolean>>;
  messages: AIMessageData[];
  historyRef: RefObject<HTMLDivElement | null>;
  scrollRafRef: RefObject<number | null>;
  focusRafRef: RefObject<number | null>;
  streamRef: RefObject<AIStreamHandle | null>;
}): void {
  useEffect(() => {
    if (mode !== "chat") return;
    const historyElement = historyRef.current;
    if (!historyElement) return;
    const updatePinnedState = (): void => {
      const distanceFromEnd =
        historyElement.scrollHeight -
        historyElement.scrollTop -
        historyElement.clientHeight;
      setHistoryPinned(distanceFromEnd <= 48);
    };
    historyElement.addEventListener("scroll", updatePinnedState, {
      passive: true,
    });
    updatePinnedState();
    return () =>
      historyElement.removeEventListener("scroll", updatePinnedState);
  }, [historyRef, mode, setHistoryPinned]);

  useEffect(() => {
    if (mode !== "chat" || !historyPinned) return;
    const historyElement = historyRef.current;
    if (!historyElement) return;
    if (scrollRafRef.current !== null) {
      window.cancelAnimationFrame(scrollRafRef.current);
    }
    scrollRafRef.current = window.requestAnimationFrame(() => {
      historyElement.scrollTop = historyElement.scrollHeight;
      scrollRafRef.current = null;
    });
  }, [historyPinned, historyRef, messages, mode, scrollRafRef]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
      if (focusRafRef.current !== null) {
        window.cancelAnimationFrame(focusRafRef.current);
      }
      streamRef.current?.abort();
      streamRef.current = null;
    };
  }, [focusRafRef, scrollRafRef, streamRef]);
}

function usePostwaveAIConversation({
  identityScope,
  canGenerate,
  mode,
  input,
  setInput,
  acceptedMentionsRef,
  historyRef,
  scrollRafRef,
  focusRafRef,
  resetAutocomplete,
}: AIConversationInput) {
  const [tone, setTone] = useState<Tone>("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [historyPinned, setHistoryPinned] = useState(true);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const voiceProfileRef = useReadyVoiceProfile(identityScope);
  const streamRef = useRef<AIStreamHandle | null>(null);
  const onHistoryIdentityReset = useCallback((): void => {
    streamRef.current?.abort();
    streamRef.current = null;
    setIsGenerating(false);
    setHistoryPinned(true);
    setInput("");
    acceptedMentionsRef.current = new Map();
    resetAutocomplete();
  }, [acceptedMentionsRef, resetAutocomplete, setInput]);
  const history = useEncryptedChatHistory(
    identityScope,
    onHistoryIdentityReset,
  );
  const {
    messages,
    setMessages,
    loading: historyLoading,
    error: historyError,
    errorRetryable: historyErrorRetryable,
    retryStorage: retryHistoryStorage,
    ready: historyReady,
  } = history;
  useGenerationRoleGuard(canGenerate, streamRef, setIsGenerating, setMessages);
  useConversationViewport({
    mode,
    historyPinned,
    setHistoryPinned,
    messages,
    historyRef,
    scrollRafRef,
    focusRafRef,
    streamRef,
  });

  const runPrompt = useCallback(
    (
      rawPrompt: string,
      requestTone: Tone,
      replaceAssistantId?: string,
    ): void => {
      const prompt = rawPrompt.trim();
      if (
        !canGenerate ||
        !prompt ||
        prompt.length > CHAT_PROMPT_MAX_CHARS ||
        isGenerating ||
        !historyReady
      ) {
        return;
      }
      setHistoryPinned(true);
      const normalizedContext = normalizeAIContextRefs(
        promptContextRefs(prompt, acceptedMentionsRef.current),
        MAX_AI_CONTEXT_REFS,
      );
      const needsVoiceProfile = !normalizedContext.refs.some(
        (ref) => ref.type === "voice_profile",
      );
      if (
        normalizedContext.overflowCount > 0 ||
        (needsVoiceProfile &&
          normalizedContext.refs.length >= MAX_AI_CONTEXT_REFS)
      ) {
        toast.error({
          message: "Too many workspace references",
          detail: `Attach up to ${MAX_AI_CONTEXT_REFS - 1} other resources per prompt; Moosewave reserves one of ${MAX_AI_CONTEXT_REFS} slots for the active voice profile.`,
        });
        return;
      }
      const contextRefs = normalizedContext.refs;
      const flatPrompt = stripMentionSyntax(prompt);
      const requestPrompt = requestTone
        ? `${flatPrompt}\n\n[Tone: ${requestTone}]`
        : flatPrompt;
      const voiceSnapshot = snapshotVoiceProfile(voiceProfileRef.current);
      const requestContextRefs: AIContextRef[] = !needsVoiceProfile
        ? contextRefs
        : [...contextRefs, { type: "voice_profile", id: "active" }];
      const descriptors = buildGroundingChips(
        contextRefs,
        voiceSnapshot ?? { label: "Voice profile" },
      );
      const groundingChips: AIGroundingChip[] = descriptors.map((chip) => ({
        id: chip.id,
        label: chip.label,
        target: chip.target as Section | undefined,
        title: chip.title,
      }));
      const assistantId = replaceAssistantId ?? uid();
      if (replaceAssistantId) {
        setMessages((previous) =>
          previous.map((message) => {
            if (message.id !== replaceAssistantId) return message;
            const resetMessage = { ...message };
            delete resetMessage.errorMessage;
            return {
              ...resetMessage,
              content: "",
              streaming: true,
              errored: false,
              draft: undefined,
              createdAt: Date.now(),
              sourcePrompt: prompt,
              sourceTone: requestTone,
              groundingChips: groundingChips.length
                ? groundingChips
                : undefined,
            };
          }),
        );
      } else {
        setMessages((previous) => [
          ...previous,
          {
            id: uid(),
            role: "user",
            content: prompt + (requestTone ? `  ·  tone: ${requestTone}` : ""),
            createdAt: Date.now(),
          },
          {
            id: assistantId,
            role: "assistant",
            content: "",
            createdAt: Date.now(),
            streaming: true,
            sourcePrompt: prompt,
            sourceTone: requestTone,
            groundingChips: groundingChips.length ? groundingChips : undefined,
          },
        ]);
        setInput("");
        resetAutocomplete();
        acceptedMentionsRef.current = new Map();
      }
      setIsGenerating(true);
      const updateAssistant = (
        update: (message: AIMessageData) => AIMessageData,
      ): void => {
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantId ? update(message) : message,
          ),
        );
      };
      const request: AIRequestInput = {
        prompt: requestPrompt,
        kind: inferKind(prompt),
        contextRefs: requestContextRefs.length ? requestContextRefs : undefined,
      };
      streamRef.current = streamAIGenerate(request, {
        onDelta: (chunk) =>
          updateAssistant((message) => ({
            ...message,
            content: message.content + chunk,
          })),
        onDone: ({ full, draft }) => {
          updateAssistant((message) => ({
            ...message,
            streaming: false,
            content: message.content || full,
            ...(draft ? { draft } : {}),
          }));
          setIsGenerating(false);
          streamRef.current = null;
        },
        onError: (message) => {
          updateAssistant((current) => ({
            ...current,
            streaming: false,
            errored: true,
            errorMessage: message,
          }));
          setIsGenerating(false);
          streamRef.current = null;
        },
      });
    },
    [
      acceptedMentionsRef,
      canGenerate,
      historyReady,
      isGenerating,
      resetAutocomplete,
      setInput,
    ],
  );

  const jumpToLatest = useCallback((): void => {
    const historyElement = historyRef.current;
    if (!historyElement) return;
    historyElement.scrollTop = historyElement.scrollHeight;
    setHistoryPinned(true);
  }, [historyRef]);

  const onSubmit = useCallback(
    () => runPrompt(input, tone),
    [input, runPrompt, tone],
  );
  const replay = useCallback(
    (message: AIMessageData): void => {
      if (!message.sourcePrompt) return;
      runPrompt(
        message.sourcePrompt,
        (message.sourceTone as Tone) ?? "",
        message.id,
      );
    },
    [runPrompt],
  );
  const onCancel = useCallback((): void => {
    streamRef.current?.abort();
    streamRef.current = null;
    setIsGenerating(false);
    setMessages((previous) =>
      previous.map((message) =>
        message.streaming
          ? {
              ...message,
              streaming: false,
              errored: true,
              errorMessage: "Generation stopped by you.",
            }
          : message,
      ),
    );
  }, []);
  const performClear = useCallback((): void => {
    streamRef.current?.abort();
    streamRef.current = null;
    setMessages([]);
    setIsGenerating(false);
    setHistoryPinned(true);
    setClearConfirmOpen(false);
  }, []);
  const onClear = useCallback((): void => {
    if (messages.length === 0) performClear();
    else setClearConfirmOpen(true);
  }, [messages.length, performClear]);
  return {
    messages,
    historyLoading,
    historyError,
    historyErrorRetryable,
    retryHistoryStorage,
    tone,
    setTone,
    isGenerating,
    historyPinned,
    jumpToLatest,
    clearConfirmOpen,
    setClearConfirmOpen,
    onSubmit,
    onCancel,
    onRegenerate: replay,
    onRetry: replay,
    onClear,
    performClear,
  };
}

function useMentionCandidatesForTrigger(trigger: MentionTrigger | null) {
  const [items, setItems] = useState<MentionItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const batchInFlightRef = useRef(false);
  const pendingRef = useRef<{
    query: string;
    signal: AbortSignal;
  } | null>(null);
  const runBatch = useCallback(async function run(
    query: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (batchInFlightRef.current) {
      pendingRef.current = { query, signal };
      return;
    }
    batchInFlightRef.current = true;
    try {
      const nextItems = await fetchMentionCandidates(query, signal);
      if (!signal.aborted) {
        setItems(nextItems);
        setActiveIndex(0);
        setLoading(false);
      }
    } finally {
      batchInFlightRef.current = false;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending && !pending.signal.aborted) {
        void run(pending.query, pending.signal);
      }
    }
  }, []);
  useEffect(() => {
    if (!trigger) {
      setItems([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setItems([]);
    setActiveIndex(0);
    const timer = window.setTimeout(() => {
      void runBatch(trigger.query, controller.signal);
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [runBatch, trigger]);
  return {
    mentionItems: items,
    mentionIndex: activeIndex,
    setMentionIndex: setActiveIndex,
    mentionLoading: loading,
  };
}

interface AIInputKeyHandlerInput {
  inputCompositionRef: RefObject<boolean>;
  autocompleteNavigationRef: RefObject<boolean>;
  dismissedAutocompleteRef: RefObject<string | null>;
  acceptedMentionsRef: RefObject<Map<string, MentionItem>>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  focusRafRef: RefObject<number | null>;
  mentionOpen: boolean;
  mentionItems: MentionItem[];
  mentionIndex: number;
  setMentionTrigger: Dispatch<SetStateAction<MentionTrigger | null>>;
  setMentionIndex: Dispatch<SetStateAction<number>>;
  onPickMention: (item: MentionItem) => void;
  slashOpen: boolean;
  slashItems: SlashCommand[];
  slashIndex: number;
  setSlashTrigger: Dispatch<SetStateAction<SlashTrigger | null>>;
  setSlashIndex: Dispatch<SetStateAction<number>>;
  onPickSlashCommand: (command: SlashCommand) => void;
  setInput: Dispatch<SetStateAction<string>>;
  onSubmit: () => void;
}

function usePostwaveAIInputKeyHandler({
  inputCompositionRef,
  autocompleteNavigationRef,
  dismissedAutocompleteRef,
  acceptedMentionsRef,
  inputRef,
  focusRafRef,
  mentionOpen,
  mentionItems,
  mentionIndex,
  setMentionTrigger,
  setMentionIndex,
  onPickMention,
  slashOpen,
  slashItems,
  slashIndex,
  setSlashTrigger,
  setSlashIndex,
  onPickSlashCommand,
  setInput,
  onSubmit,
}: AIInputKeyHandlerInput) {
  return useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (
        inputCompositionRef.current ||
        event.nativeEvent.isComposing ||
        event.keyCode === 229
      ) {
        return;
      }
      const plainCommit = !event.metaKey && !event.ctrlKey && !event.altKey;
      if (mentionOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          dismissedAutocompleteRef.current = autocompleteFingerprint(
            event.currentTarget.value,
            event.currentTarget.selectionStart ?? 0,
          );
          setMentionTrigger(null);
          setMentionIndex(0);
          return;
        }
        if (mentionItems.length && event.key === "ArrowDown") {
          autocompleteNavigationRef.current = true;
          event.preventDefault();
          setMentionIndex((index) => (index + 1) % mentionItems.length);
          return;
        }
        if (mentionItems.length && event.key === "ArrowUp") {
          autocompleteNavigationRef.current = true;
          event.preventDefault();
          setMentionIndex((index) =>
            index === 0 ? mentionItems.length - 1 : index - 1,
          );
          return;
        }
        if (
          mentionItems.length &&
          ((event.key === "Enter" && plainCommit) ||
            (event.key === "Tab" && !event.shiftKey && plainCommit))
        ) {
          event.preventDefault();
          const item = mentionItems[mentionIndex];
          if (item) onPickMention(item);
          return;
        }
      }
      if (slashOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          dismissedAutocompleteRef.current = autocompleteFingerprint(
            event.currentTarget.value,
            event.currentTarget.selectionStart ?? 0,
          );
          setSlashTrigger(null);
          setSlashIndex(0);
          return;
        }
        if (slashItems.length && event.key === "ArrowDown") {
          autocompleteNavigationRef.current = true;
          event.preventDefault();
          setSlashIndex((index) => (index + 1) % slashItems.length);
          return;
        }
        if (slashItems.length && event.key === "ArrowUp") {
          autocompleteNavigationRef.current = true;
          event.preventDefault();
          setSlashIndex((index) =>
            index === 0 ? slashItems.length - 1 : index - 1,
          );
          return;
        }
        if (
          slashItems.length &&
          ((event.key === "Enter" && plainCommit) ||
            (event.key === "Tab" && !event.shiftKey && plainCommit))
        ) {
          event.preventDefault();
          const command = slashItems[slashIndex];
          if (command) onPickSlashCommand(command);
          return;
        }
      }
      if (
        event.key === "Backspace" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        const caret = event.currentTarget.selectionStart ?? 0;
        const end = event.currentTarget.selectionEnd ?? caret;
        const token =
          caret === end
            ? findTokenEndingAt(event.currentTarget.value, caret)
            : null;
        if (token) {
          event.preventDefault();
          setInput(
            event.currentTarget.value.slice(0, token.start) +
              event.currentTarget.value.slice(token.end),
          );
          acceptedMentionsRef.current.delete(`${token.type}:${token.id}`);
          if (focusRafRef.current !== null) {
            window.cancelAnimationFrame(focusRafRef.current);
          }
          focusRafRef.current = window.requestAnimationFrame(() => {
            focusRafRef.current = null;
            inputRef.current?.focus();
            try {
              inputRef.current?.setSelectionRange(token.start, token.start);
            } catch {
              /* Selection APIs are not available in every embedded renderer. */
            }
          });
          return;
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        onSubmit();
      }
    },
    [
      acceptedMentionsRef,
      autocompleteNavigationRef,
      dismissedAutocompleteRef,
      focusRafRef,
      inputCompositionRef,
      inputRef,
      mentionIndex,
      mentionItems,
      mentionOpen,
      onPickMention,
      onPickSlashCommand,
      onSubmit,
      setInput,
      setMentionIndex,
      setMentionTrigger,
      setSlashIndex,
      setSlashTrigger,
      slashIndex,
      slashItems,
      slashOpen,
    ],
  );
}

interface AIComposerInteractionsInput {
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  setMode: (mode: Mode) => void;
  slashTrigger: SlashTrigger | null;
  setSlashTrigger: Dispatch<SetStateAction<SlashTrigger | null>>;
  slashIndex: number;
  setSlashIndex: Dispatch<SetStateAction<number>>;
  slashItems: SlashCommand[];
  mentionTrigger: MentionTrigger | null;
  setMentionTrigger: Dispatch<SetStateAction<MentionTrigger | null>>;
  mentionIndex: number;
  setMentionIndex: Dispatch<SetStateAction<number>>;
  mentionItems: MentionItem[];
  acceptedMentionsRef: RefObject<Map<string, MentionItem>>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  inputCompositionRef: RefObject<boolean>;
  autocompleteNavigationRef: RefObject<boolean>;
  dismissedAutocompleteRef: RefObject<string | null>;
  focusRafRef: RefObject<number | null>;
  onClear: () => void;
  onSubmit: () => void;
}

function usePostwaveAIComposerInteractions({
  input,
  setInput,
  setMode,
  slashTrigger,
  setSlashTrigger,
  slashIndex,
  setSlashIndex,
  slashItems,
  mentionTrigger,
  setMentionTrigger,
  mentionIndex,
  setMentionIndex,
  mentionItems,
  acceptedMentionsRef,
  inputRef,
  inputCompositionRef,
  autocompleteNavigationRef,
  dismissedAutocompleteRef,
  focusRafRef,
  onClear,
  onSubmit,
}: AIComposerInteractionsInput) {
  const closeMenus = useCallback((): void => {
    setSlashTrigger(null);
    setSlashIndex(0);
    setMentionTrigger(null);
    setMentionIndex(0);
  }, [setMentionIndex, setMentionTrigger, setSlashIndex, setSlashTrigger]);
  const reset = useCallback((): void => {
    dismissedAutocompleteRef.current = null;
    closeMenus();
  }, [closeMenus, dismissedAutocompleteRef]);
  const focusAt = useCallback(
    (position?: number): void => {
      if (focusRafRef.current !== null) {
        window.cancelAnimationFrame(focusRafRef.current);
      }
      focusRafRef.current = window.requestAnimationFrame(() => {
        const textarea = inputRef.current;
        focusRafRef.current = null;
        if (!textarea) return;
        textarea.focus();
        const caret = position ?? textarea.value.length;
        try {
          textarea.setSelectionRange(caret, caret);
        } catch {
          /* Selection APIs are not available in every embedded renderer. */
        }
      });
    },
    [focusRafRef, inputRef],
  );
  const onPickQuickPrompt = useCallback(
    (prompt: PostwaveAIQuickPrompt): void => {
      setInput((current) => {
        if (!current.trim()) return boundChatPrompt(prompt.fill);
        return boundChatPrompt(
          current.endsWith("\n") || current.endsWith(" ")
            ? current + prompt.fill
            : current + "\n" + prompt.fill,
        );
      });
      reset();
      focusAt();
    },
    [focusAt, reset, setInput],
  );
  const replaceSlashTokenWith = useCallback(
    (trigger: SlashTrigger, replacement: string): void => {
      const current = inputRef.current?.value ?? input;
      const tokenEnd = trigger.start + 1 + trigger.query.length;
      const next = boundChatPrompt(
        current.slice(0, trigger.start) + replacement + current.slice(tokenEnd),
      );
      setInput(next);
      reset();
      focusAt(Math.min(trigger.start + replacement.length, next.length));
    },
    [focusAt, input, inputRef, reset, setInput],
  );
  const onPickSlashCommand = useCallback(
    (command: SlashCommand): void => {
      if (command.action === "clear") {
        if (slashTrigger) replaceSlashTokenWith(slashTrigger, "");
        onClear();
        return;
      }
      if (slashTrigger) replaceSlashTokenWith(slashTrigger, command.fill);
    },
    [onClear, replaceSlashTokenWith, slashTrigger],
  );
  const onPickMention = useCallback(
    (item: MentionItem): void => {
      if (!mentionTrigger) return;
      const current = inputRef.current?.value ?? input;
      const replacement = `${buildMentionToken(item)} `;
      const triggerEnd = mentionTrigger.start + 1 + mentionTrigger.query.length;
      const next = boundChatPrompt(
        current.slice(0, mentionTrigger.start) +
          replacement +
          current.slice(triggerEnd),
      );
      setInput(next);
      acceptedMentionsRef.current.set(`${item.kind}:${item.id}`, item);
      reset();
      focusAt(Math.min(mentionTrigger.start + replacement.length, next.length));
    },
    [
      acceptedMentionsRef,
      focusAt,
      input,
      inputRef,
      mentionTrigger,
      reset,
      setInput,
    ],
  );
  const onInputKey = usePostwaveAIInputKeyHandler({
    inputCompositionRef,
    autocompleteNavigationRef,
    dismissedAutocompleteRef,
    acceptedMentionsRef,
    inputRef,
    focusRafRef,
    mentionOpen: mentionTrigger !== null,
    mentionItems,
    mentionIndex,
    setMentionTrigger,
    setMentionIndex,
    onPickMention,
    slashOpen: slashTrigger !== null,
    slashItems,
    slashIndex,
    setSlashTrigger,
    setSlashIndex,
    onPickSlashCommand,
    setInput,
    onSubmit,
  });
  const updateTriggers = useCallback(
    (value: string, caret: number): void => {
      const fingerprint = autocompleteFingerprint(value, caret);
      if (dismissedAutocompleteRef.current === fingerprint) {
        setSlashTrigger(null);
        setMentionTrigger(null);
        return;
      }
      dismissedAutocompleteRef.current = null;
      const slash = detectSlashTrigger(value, caret);
      setSlashTrigger(slash);
      setMentionTrigger(slash ? null : detectMentionTrigger(value, caret));
      setSlashIndex(0);
      setMentionIndex(0);
    },
    [
      dismissedAutocompleteRef,
      setMentionIndex,
      setMentionTrigger,
      setSlashIndex,
      setSlashTrigger,
    ],
  );
  const onInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>): void => {
      const value = boundChatPrompt(event.target.value);
      setInput(value);
      if (inputCompositionRef.current) {
        setSlashTrigger(null);
        setMentionTrigger(null);
        return;
      }
      updateTriggers(value, event.target.selectionStart ?? value.length);
    },
    [
      inputCompositionRef,
      setInput,
      setMentionTrigger,
      setSlashTrigger,
      updateTriggers,
    ],
  );
  const onInputSelectionChange = useCallback(
    (event: SyntheticEvent<HTMLTextAreaElement>): void => {
      if (inputCompositionRef.current || autocompleteNavigationRef.current) {
        return;
      }
      const target = event.currentTarget;
      updateTriggers(
        target.value,
        target.selectionStart ?? target.value.length,
      );
    },
    [autocompleteNavigationRef, inputCompositionRef, updateTriggers],
  );
  const onInputKeyUp = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        autocompleteNavigationRef.current = false;
      }
    },
    [autocompleteNavigationRef],
  );
  const onInputCompositionStart = useCallback((): void => {
    inputCompositionRef.current = true;
  }, [inputCompositionRef]);
  const onInputCompositionEnd = useCallback(
    (event: CompositionEvent<HTMLTextAreaElement>): void => {
      inputCompositionRef.current = false;
      updateTriggers(
        event.currentTarget.value,
        event.currentTarget.selectionStart ?? event.currentTarget.value.length,
      );
    },
    [inputCompositionRef, updateTriggers],
  );
  const onInputBlur = useCallback((): void => {
    inputCompositionRef.current = false;
    autocompleteNavigationRef.current = false;
    window.requestAnimationFrame(closeMenus);
  }, [autocompleteNavigationRef, closeMenus, inputCompositionRef]);
  const onApplySavedPrompt = useCallback(
    (prompt: string): void => {
      setMode("chat");
      setInput(boundChatPrompt(prompt));
      reset();
      if (focusRafRef.current !== null) {
        window.cancelAnimationFrame(focusRafRef.current);
      }
      focusRafRef.current = window.requestAnimationFrame(() => {
        focusRafRef.current = null;
        inputRef.current?.focus();
      });
    },
    [focusRafRef, inputRef, reset, setInput, setMode],
  );
  return {
    onPickQuickPrompt,
    onPickSlashCommand,
    onPickMention,
    onInputKey,
    onInputChange,
    onInputSelectionChange,
    onInputKeyUp,
    onInputCompositionStart,
    onInputCompositionEnd,
    onInputBlur,
    onApplySavedPrompt,
  };
}

interface PostwaveAIHeaderProps {
  mode: Mode;
  inspectorOpen: boolean;
  historyLoading: boolean;
  hasMessages: boolean;
  isGenerating: boolean;
  onClear: () => void;
  onToggleInspector: () => void;
}

function PostwaveAIHeader({
  mode,
  inspectorOpen,
  historyLoading,
  hasMessages,
  isGenerating,
  onClear,
  onToggleInspector,
}: PostwaveAIHeaderProps): ReactElement {
  return (
    <header className="ai-page-header">
      <div className="ai-title-cluster">
        <span className="ai-eyebrow">
          <span className="ai-eyebrow-mark" aria-hidden="true" />
          Intelligence workspace
        </span>
        <div className="ai-title-row">
          <h1 className="page-title">Moosewave AI</h1>
          <span className="badge accent">Beta</span>
        </div>
        <p className="page-subtitle ai-page-subtitle">
          Draft, compare, and validate with your active voice profile plus the
          workspace sources you explicitly attach. Chat history stays encrypted
          to this user and workspace on this device.
        </p>
        <div className="ai-trust-strip" aria-label="Workspace safeguards">
          <span>
            <i aria-hidden="true" /> Explicit workspace sources
          </span>
          <span>
            <i aria-hidden="true" /> Encrypted local history
          </span>
          <span>
            <i aria-hidden="true" /> Human review before handoff
          </span>
        </div>
      </div>
      <div className="ai-header-actions">
        {mode === "chat" ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClear}
            disabled={historyLoading || (!hasMessages && !isGenerating)}
            aria-label="Clear chat"
          >
            Clear chat
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost ai-inspector-toggle"
          aria-expanded={inspectorOpen}
          aria-controls="postwave-ai-inspector"
          onClick={onToggleInspector}
        >
          <span className="ai-inspector-toggle-mark" aria-hidden="true" />
          {inspectorOpen ? "Hide context" : "Show context"}
        </button>
      </div>
    </header>
  );
}

function AIHistoryStorageNotice({
  loading,
  error,
  retryable,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  retryable: boolean;
  onRetry: () => void;
}): ReactElement | null {
  if (loading) {
    return (
      <Notice tone="neutral" announcement="polite">
        Loading encrypted chat history…
      </Notice>
    );
  }
  if (!error) return null;
  return (
    <Notice
      tone="danger"
      announcement="assertive"
      action={
        retryable ? (
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry encrypted storage
          </button>
        ) : null
      }
    >
      {error}
    </Notice>
  );
}

/* ---------- page ---------------------------------------------------- */

export function PostwaveAI(): ReactElement {
  const [mode, setMode] = useDesktopRouteTab<Mode>("ai", MODE_VALUES, "chat");
  const modeTabs = usePostwaveModeTabs(mode, setMode);
  const me = useMe();
  const canWrite = useCanWrite();
  const identityScope = sensitiveLocalIdentityScope(me?.user, me?.tenant);
  const [inspectorOpen, setInspectorOpen] = useState(true);

  const [input, setInput] = useState("");
  const [slashTrigger, setSlashTrigger] = useState<SlashTrigger | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashItems = slashTrigger
    ? filterSlashCommands(slashTrigger.query)
    : [];
  const slashOpen = slashTrigger !== null;
  const [mentionTrigger, setMentionTrigger] = useState<MentionTrigger | null>(
    null,
  );
  const { mentionItems, mentionIndex, setMentionIndex, mentionLoading } =
    useMentionCandidatesForTrigger(mentionTrigger);
  const acceptedMentionsRef = useRef<Map<string, MentionItem>>(new Map());
  const mentionOpen = mentionTrigger !== null;
  const historyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const inputCompositionRef = useRef(false);
  const autocompleteNavigationRef = useRef(false);
  const dismissedAutocompleteRef = useRef<string | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const focusRafRef = useRef<number | null>(null);
  const resetAutocomplete = useCallback((): void => {
    dismissedAutocompleteRef.current = null;
    setSlashTrigger(null);
    setSlashIndex(0);
    setMentionTrigger(null);
    setMentionIndex(0);
  }, []);
  const conversation = usePostwaveAIConversation({
    identityScope,
    canGenerate: canWrite,
    mode,
    input,
    setInput,
    acceptedMentionsRef,
    historyRef,
    scrollRafRef,
    focusRafRef,
    resetAutocomplete,
  });
  const {
    messages,
    historyLoading,
    historyError,
    historyErrorRetryable,
    retryHistoryStorage,
    tone,
    setTone,
    isGenerating,
    historyPinned,
    jumpToLatest,
    clearConfirmOpen,
    setClearConfirmOpen,
    onSubmit,
    onCancel,
    onRegenerate,
    onRetry,
    onClear,
    performClear,
  } = conversation;

  const onUseDraft = useCallback(
    (draft: AIGenerateDraft): void => {
      if (!canWrite) {
        toast.error({
          message: "Campaign editing is unavailable for your role",
          detail:
            "Ask a workspace editor or admin to review and use this draft.",
        });
        return;
      }
      const pendingDraft: PendingCampaignDraft = {
        name: draft.name,
        subject: draft.subject,
        body: markAIGeneratedHTML(draft.body),
        preview_text: draft.preview_text,
      };
      setPendingCampaignDraft(pendingDraft);
      void (async () => {
        const result = await requestDesktopRouteNavigation({
          section: "campaigns",
        });
        if (result !== "proceeded") {
          if (peekPendingCampaignDraft() === pendingDraft) {
            setPendingCampaignDraft(null);
          }
          return;
        }
        toast.success({
          message: "AI draft handed to Campaigns",
          detail:
            "It is ready for human review. No campaign was created or sent.",
        });
      })();
    },
    [canWrite],
  );

  const {
    onPickQuickPrompt,
    onPickSlashCommand,
    onPickMention,
    onInputKey,
    onInputChange,
    onInputSelectionChange,
    onInputKeyUp,
    onInputCompositionStart,
    onInputCompositionEnd,
    onInputBlur,
    onApplySavedPrompt,
  } = usePostwaveAIComposerInteractions({
    input,
    setInput,
    setMode,
    slashTrigger,
    setSlashTrigger,
    slashIndex,
    setSlashIndex,
    slashItems,
    mentionTrigger,
    setMentionTrigger,
    mentionIndex,
    setMentionIndex,
    mentionItems,
    acceptedMentionsRef,
    inputRef,
    inputCompositionRef,
    autocompleteNavigationRef,
    dismissedAutocompleteRef,
    focusRafRef,
    onClear,
    onSubmit,
  });

  const hasMessages = messages.length > 0;

  return (
    <div className="ai-shell">
      <PostwaveAIHeader
        mode={mode}
        inspectorOpen={inspectorOpen}
        historyLoading={historyLoading}
        hasMessages={hasMessages}
        isGenerating={isGenerating}
        onClear={onClear}
        onToggleInspector={() => setInspectorOpen((open) => !open)}
      />

      <AIInteractionDisclosure />

      <PostwaveAIModeTabs mode={mode} tabs={modeTabs} />

      <AIHistoryStorageNotice
        loading={historyLoading}
        error={historyError}
        retryable={historyErrorRetryable}
        onRetry={retryHistoryStorage}
      />

      <div
        className="ai-workspace-grid"
        data-inspector-open={inspectorOpen ? "true" : "false"}
      >
        {/* Mode panel — keep the cheap form-only panels mounted so
            switching tabs doesn't blow away the user's in-progress
            work. Compose / Subject Lab / Presend only call APIs on
            button click. The Agent summary has no administrative fetch;
            recent confirmation remains lazily mounted in the sidebar. */}
        <section className="ai-workspace-stage">
          <div {...modeTabs.getPanelProps("chat")}>
            <PostwaveAIChatPanel
              messages={messages}
              input={historyLoading ? "" : input}
              promptMaxChars={CHAT_PROMPT_MAX_CHARS}
              tone={tone}
              isGenerating={isGenerating}
              canGenerate={canWrite}
              historyLoading={historyLoading}
              historyPinned={historyPinned}
              onPickQuickPrompt={onPickQuickPrompt}
              onSubmit={onSubmit}
              onCancel={onCancel}
              onJumpToLatest={jumpToLatest}
              onUseDraft={canWrite ? onUseDraft : undefined}
              onRegenerate={onRegenerate}
              onRetry={onRetry}
              onInputChange={onInputChange}
              onInputKey={onInputKey}
              onInputKeyUp={onInputKeyUp}
              onInputSelectionChange={onInputSelectionChange}
              onInputCompositionStart={onInputCompositionStart}
              onInputCompositionEnd={onInputCompositionEnd}
              onInputBlur={onInputBlur}
              setTone={setTone}
              inputRef={inputRef}
              historyRef={historyRef}
              slashOpen={slashOpen}
              slashItems={slashItems}
              slashIndex={slashIndex}
              slashQuery={slashTrigger?.query ?? ""}
              onSlashHover={setSlashIndex}
              onPickSlashCommand={onPickSlashCommand}
              mentionOpen={mentionOpen}
              mentionItems={mentionItems}
              mentionIndex={mentionIndex}
              mentionLoading={mentionLoading}
              mentionQuery={mentionTrigger?.query ?? ""}
              onMentionHover={setMentionIndex}
              onPickMention={onPickMention}
            />
          </div>
          <div {...modeTabs.getPanelProps("compose")}>
            <ComposeBroadcastForm
              onUseDraft={onUseDraft}
              canMutate={canWrite}
            />
          </div>
          <div {...modeTabs.getPanelProps("subject")}>
            <PostwaveSubjectLabPanel />
          </div>
          <div {...modeTabs.getPanelProps("presend")}>
            <PresendCheckPanel canMutate={canWrite} />
          </div>
          <div {...modeTabs.getPanelProps("agent")}>
            {mode === "agent" ? <AgentPanel /> : null}
          </div>
          {/* Routines (roadmap R5): fetches /agent-routines on mount,
              so lazily mounted like AgentPanel. */}
          <div {...modeTabs.getPanelProps("routines")}>
            {mode === "routines" ? <RoutinesPanel /> : null}
          </div>
        </section>

        {/* Right sidebar */}
        <aside
          id="postwave-ai-inspector"
          className="ai-inspector"
          hidden={!inspectorOpen}
          aria-label={
            mode === "agent" || mode === "routines"
              ? "Agent execution context"
              : "AI workspace context"
          }
        >
          <div className="ai-inspector-heading">
            <div>
              <span className="ai-inspector-kicker">
                {mode === "agent" || mode === "routines"
                  ? "Execution context"
                  : "Workspace context"}
              </span>
              <strong>
                {mode === "agent" || mode === "routines"
                  ? "Recent activity"
                  : "What shapes the work"}
              </strong>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-ghost ai-inspector-close"
              onClick={() => setInspectorOpen(false)}
              aria-label="Hide context panel"
            >
              Hide
            </button>
          </div>
          {mode === "agent" || mode === "routines" ? (
            <RecentExecutionsStrip />
          ) : (
            <>
              <VoiceProfileCard />
              {/* G10 (campaigns 2026): operator-authored brand voice
                  profile. Sits above SavedPrompts so it's the next
                  thing the operator sees after the auto-extracted
                  voice card. */}
              <BrandVoicePanel />
              <SavedPromptsCard
                currentPrompt={input}
                onApply={onApplySavedPrompt}
              />
            </>
          )}
        </aside>
      </div>
      <ConfirmModal
        open={clearConfirmOpen}
        title="Clear chat history?"
        description="The conversation will be removed from this device. Drafts that have already been handed off to campaigns are unaffected."
        danger
        confirmLabel="Clear"
        onConfirm={performClear}
        onClose={() => setClearConfirmOpen(false)}
      />
    </div>
  );
}

/* ---------- agent panel -------------------------------------------- */

function PostwaveSubjectLabPanel(): ReactElement {
  const canWrite = useCanWrite();
  const onContinueInCampaigns = useCallback(
    async (handoff: SubjectLabCampaignHandoff): Promise<boolean> => {
      const pendingDraft: PendingCampaignDraft = {
        subject: handoff.subject,
        body: markAIGeneratedHTML(handoff.body),
      };
      setPendingCampaignDraft(pendingDraft);
      const result = await requestDesktopRouteNavigation({
        section: "campaigns",
      });
      if (result !== "proceeded") {
        if (peekPendingCampaignDraft() === pendingDraft) {
          setPendingCampaignDraft(null);
        }
        return false;
      }
      toast.success({
        message: "Subject Lab draft handed to Campaigns",
        detail:
          handoff.stagedSubjects.length > 1
            ? "The selected top candidate and body context are ready for review. No campaign was created or sent."
            : "The subject and body context are ready for review. No campaign was created or sent.",
      });
      return true;
    },
    [],
  );
  return (
    <SubjectLabWorkspace
      canMutate={canWrite}
      onContinueInCampaigns={onContinueInCampaigns}
    />
  );
}

/**
 * AgentPanel is intentionally contextual. MCP owns installation, API-key
 * issuance, the tool catalog and full execution observability.
 */
function AgentPanel(): ReactElement {
  return <McpAgentSummary />;
}
