import {
  type ChangeEvent,
  type CompositionEvent,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
  type SyntheticEvent,
  useMemo,
} from "react";

import { AIMessage, type AIMessageData } from "../AIMessage";
import { HeroEmptyState } from "../HeroEmptyState";
import { InlineHelp } from "../InlineHelp";
import type { AIGenerateDraft } from "../../lib/api-client";
import { HERO } from "../../lib/heroAssets";
import {
  AI_MENTION_LISTBOX_ID,
  MentionMenu,
  MentionPreview,
  type MentionItem,
  mentionOptionId,
} from "./MentionMenu";
import {
  AI_SLASH_LISTBOX_ID,
  type SlashCommand,
  SlashCommandMenu,
  slashCommandOptionId,
} from "./SlashCommandMenu";
import { TonePicker, type Tone } from "./TonePicker";

export interface PostwaveAIQuickPrompt {
  id: string;
  label: string;
  fill: string;
}

const QUICK_PROMPTS: PostwaveAIQuickPrompt[] = [
  {
    id: "draft-campaign",
    label: "Draft a campaign",
    fill: "Draft a campaign about ",
  },
  {
    id: "subject-lines",
    label: "Suggest subject lines",
    fill: "Suggest five subject lines for an email about ",
  },
  {
    id: "test-plan",
    label: "Build a test plan",
    fill: "Build a focused A/B test plan for ",
  },
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

interface PostwaveAIChatPanelProps {
  messages: AIMessageData[];
  input: string;
  promptMaxChars: number;
  tone: Tone;
  isGenerating: boolean;
  canGenerate: boolean;
  historyLoading: boolean;
  historyPinned: boolean;
  onPickQuickPrompt: (prompt: PostwaveAIQuickPrompt) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onJumpToLatest: () => void;
  onUseDraft?: (draft: AIGenerateDraft) => void;
  onRegenerate: (message: AIMessageData) => void;
  onRetry: (message: AIMessageData) => void;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onInputKey: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onInputKeyUp: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onInputSelectionChange: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  onInputCompositionStart: () => void;
  onInputCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => void;
  onInputBlur: () => void;
  setTone: (tone: Tone) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  historyRef: RefObject<HTMLDivElement | null>;
  slashOpen: boolean;
  slashItems: SlashCommand[];
  slashIndex: number;
  slashQuery: string;
  onSlashHover: (index: number) => void;
  onPickSlashCommand: (command: SlashCommand) => void;
  mentionOpen: boolean;
  mentionItems: MentionItem[];
  mentionIndex: number;
  mentionLoading: boolean;
  mentionQuery: string;
  onMentionHover: (index: number) => void;
  onPickMention: (item: MentionItem) => void;
}

export function PostwaveAIChatPanel(
  props: PostwaveAIChatPanelProps,
): ReactElement {
  const {
    messages,
    input,
    promptMaxChars,
    tone,
    isGenerating,
    canGenerate,
    historyLoading,
    historyPinned,
    onPickQuickPrompt,
    onSubmit,
    onCancel,
    onJumpToLatest,
    onUseDraft,
    onRegenerate,
    onRetry,
    onInputChange,
    onInputKey,
    onInputKeyUp,
    onInputSelectionChange,
    onInputCompositionStart,
    onInputCompositionEnd,
    onInputBlur,
    setTone,
    inputRef,
    historyRef,
    slashOpen,
    slashItems,
    slashIndex,
    slashQuery,
    onSlashHover,
    onPickSlashCommand,
    mentionOpen,
    mentionItems,
    mentionIndex,
    mentionLoading,
    mentionQuery,
    onMentionHover,
    onPickMention,
  } = props;
  const hasMessages = messages.length > 0;
  const inputHasMentions = useMemo(
    () => /@\[[^\]\n]{1,120}\]\(\w+:[a-zA-Z0-9_-]{1,64}\)/.test(input),
    [input],
  );
  const boundedSlashIndex =
    slashItems.length === 0 ? 0 : Math.min(slashIndex, slashItems.length - 1);
  const boundedMentionIndex =
    mentionItems.length === 0
      ? 0
      : Math.min(mentionIndex, mentionItems.length - 1);
  const activeAutocompleteId = mentionOpen
    ? mentionItems[boundedMentionIndex]
      ? mentionOptionId(mentionItems[boundedMentionIndex])
      : undefined
    : slashOpen && slashItems[boundedSlashIndex]
      ? slashCommandOptionId(slashItems[boundedSlashIndex])
      : undefined;
  const autocompleteControls = mentionOpen
    ? AI_MENTION_LISTBOX_ID
    : slashOpen
      ? AI_SLASH_LISTBOX_ID
      : undefined;

  return (
    <div className="ai-pane">
      <div className="ai-history-frame">
        <div
          ref={historyRef}
          className="ai-history"
          aria-label="AI conversation"
        >
          {hasMessages ? (
            messages.map((message) => (
              <AIMessage
                key={message.id}
                msg={message}
                onUseDraft={onUseDraft}
                {...(canGenerate ? { onRegenerate, onRetry } : {})}
              />
            ))
          ) : (
            <ChatEmptyState onPickQuickPrompt={onPickQuickPrompt} />
          )}
        </div>
        {!historyPinned && hasMessages ? (
          <button
            type="button"
            className="btn btn-sm ai-jump-latest"
            onClick={onJumpToLatest}
          >
            Jump to latest
          </button>
        ) : null}
      </div>

      <div className="ai-composer-stack">
        <div className="ai-tone-row">
          <span className="muted ai-tone-label">
            Tone
            <InlineHelp
              text="Optional. Biases generation toward a tone (formal, friendly, urgent, etc.). Appended to the prompt as a [Tone: …] hint; leave unset to use your Voice Profile defaults."
              ariaLabel="About tone"
            />
          </span>
          <TonePicker value={tone} onChange={setTone} />
        </div>

        <form
          className="ai-input-row"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <SlashCommandMenu
            open={slashOpen}
            items={slashItems}
            activeIndex={boundedSlashIndex}
            query={slashQuery}
            onSelect={onPickSlashCommand}
            onHover={onSlashHover}
          />
          <MentionMenu
            open={mentionOpen}
            items={mentionItems}
            activeIndex={boundedMentionIndex}
            loading={mentionLoading}
            query={mentionQuery}
            onSelect={onPickMention}
            onHover={onMentionHover}
          />
          <div
            className="ai-input-wrap"
            data-has-mentions={inputHasMentions ? "true" : undefined}
          >
            {inputHasMentions ? (
              <div className="ai-input-highlight" aria-hidden="true">
                <MentionPreview text={input} />
              </div>
            ) : null}
            <textarea
              ref={inputRef}
              className="ai-input"
              value={input}
              onChange={onInputChange}
              onKeyDown={onInputKey}
              onKeyUp={onInputKeyUp}
              onSelect={onInputSelectionChange}
              onCompositionStart={onInputCompositionStart}
              onCompositionEnd={onInputCompositionEnd}
              onBlur={onInputBlur}
              placeholder="Ask Moosewave AI… Type / for commands or @ for context"
              rows={3}
              spellCheck
              autoComplete="off"
              maxLength={promptMaxChars}
              disabled={historyLoading}
              aria-label="Ask Moosewave AI"
              aria-describedby="postwave-ai-chat-input-hint"
              role="combobox"
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-expanded={mentionOpen || slashOpen}
              aria-controls={autocompleteControls}
              aria-activedescendant={activeAutocompleteId}
            />
          </div>
          <div className="ai-input-actions">
            <span
              id="postwave-ai-chat-input-hint"
              className="ai-input-hint subtle"
            >
              <span>
                {historyLoading
                  ? "Loading encrypted history…"
                  : !canGenerate
                    ? "View-only · ask an editor or admin to run AI generation"
                    : isGenerating
                      ? "Generating · you can draft the next prompt"
                      : "Type / for commands · @ for context · Ctrl/⌘+Enter to send"}
              </span>
              <span className="ai-input-count tabular">
                {input.length.toLocaleString()} /{" "}
                {promptMaxChars.toLocaleString()}
              </span>
            </span>
            <div className="row ai-input-buttons">
              {isGenerating ? (
                <button
                  type="button"
                  className="btn"
                  onClick={onCancel}
                  aria-label="Cancel generation"
                >
                  Stop
                </button>
              ) : null}
              <button
                type="submit"
                className="btn btn-primary"
                disabled={
                  !canGenerate ||
                  !input.trim() ||
                  input.length > promptMaxChars ||
                  isGenerating ||
                  historyLoading
                }
              >
                Send
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function ChatEmptyState({
  onPickQuickPrompt,
}: {
  onPickQuickPrompt: (prompt: PostwaveAIQuickPrompt) => void;
}): ReactElement {
  return (
    <HeroEmptyState
      tone="sand"
      eyebrow="AI Copilot"
      title="Moosewave's AI copilot, in your workspace."
      subtitle="Move from a blank page to review-ready copy with inspectable context and visible approval boundaries."
      imageSrc={HERO.ai}
      imageAlt="A minimalist speaker with a soft teal glow"
      meta={
        <>
          <div className="ai-quick-prompts">
            {QUICK_PROMPTS.map((prompt) => (
              <button
                key={prompt.id}
                type="button"
                className="chip"
                onClick={() => onPickQuickPrompt(prompt)}
              >
                {prompt.label}
              </button>
            ))}
          </div>
          <p className="subtle ai-empty-privacy">
            Prompts go to your tenant&apos;s Moosewave AI service. A ready voice
            profile is requested automatically; attach every other workspace
            source explicitly. Chat history is encrypted on this device.
          </p>
        </>
      }
    />
  );
}
