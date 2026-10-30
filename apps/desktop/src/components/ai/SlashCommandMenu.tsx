/**
 * SlashCommandMenu — popover menu that surfaces canned prompt verbs
 * (draft / subject / summarize / sequence / clear / new) when the user
 * types `/` in the chat composer.
 *
 * The empty-state quick-prompt chips disappear after the first user turn
 * (HeroEmptyState only renders on messages.length===0). This menu makes
 * the same canned starters reachable at any point in the conversation,
 * matching the ChatGPT / Claude / Cursor norm.
 *
 * Rendering: positioned absolutely inside an .ai-input-row that already
 * has `position: relative` applied at the call site. Owner page drives
 * the open/close + filter + selection — this file is purely presentational.
 */

import { type ReactElement, useEffect, useRef } from "react";

export interface SlashCommand {
  id: string;
  /** Token typed after `/` — e.g. "draft" for `/draft`. */
  trigger: string;
  label: string;
  hint: string;
  /** Replacement text inserted into the textarea on select. */
  fill: string;
  /** Action commands run instead of inserting fill text (e.g. clear chat). */
  action?: "clear";
}

export const AI_SLASH_LISTBOX_ID = "postwave-ai-slash-options";

/** Stable DOM id used by the composer's active-descendant relationship. */
export function slashCommandOptionId(command: SlashCommand): string {
  return `${AI_SLASH_LISTBOX_ID}-${encodeURIComponent(command.id)}`;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "draft",
    trigger: "draft",
    label: "/draft",
    hint: "Draft a campaign",
    fill: "Draft a campaign about ",
  },
  {
    id: "subject",
    trigger: "subject",
    label: "/subject",
    hint: "Suggest subject lines",
    fill: "Suggest five subject lines for an email about ",
  },
  {
    id: "summarize",
    trigger: "summarize",
    label: "/summarize",
    hint: "Summarize this week",
    fill: "Summarize this week's campaign performance.",
  },
  {
    id: "sequence",
    trigger: "sequence",
    label: "/sequence",
    hint: "Plan a sequence",
    fill: "Plan a 4-step welcome sequence for new subscribers tagged ",
  },
  {
    id: "clear",
    trigger: "clear",
    label: "/clear",
    hint: "Clear chat history",
    fill: "",
    action: "clear",
  },
  {
    id: "new",
    trigger: "new",
    label: "/new",
    hint: "Start a new conversation",
    fill: "",
    action: "clear",
  },
];

export function filterSlashCommands(query: string): SlashCommand[] {
  if (!query) return SLASH_COMMANDS;
  const q = query.toLowerCase();
  // Match against trigger prefix first (typical use: typing `/su` → `/subject`),
  // then fall back to substring of the hint so users searching by intent
  // ("plan", "summary") still see results.
  const prefixHits = SLASH_COMMANDS.filter((c) => c.trigger.startsWith(q));
  if (prefixHits.length > 0) return prefixHits;
  return SLASH_COMMANDS.filter(
    (c) => c.trigger.includes(q) || c.hint.toLowerCase().includes(q),
  );
}

interface Props {
  open: boolean;
  items: SlashCommand[];
  activeIndex: number;
  query: string;
  onSelect: (cmd: SlashCommand) => void;
  onHover: (index: number) => void;
}

export function SlashCommandMenu({
  open,
  items,
  activeIndex,
  query,
  onSelect,
  onHover,
}: Props): ReactElement | null {
  const listRef = useRef<HTMLDivElement | null>(null);

  // Keep the highlighted row visible as the user arrow-navigates through
  // a list longer than the popover's max-height.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLButtonElement>(
      `[data-slash-idx="${activeIndex}"]`,
    );
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  if (!open) return null;

  const resultStatus =
    items.length > 0
      ? `${items.length} slash ${items.length === 1 ? "command" : "commands"} available`
      : query
        ? `No slash commands match ${query}`
        : "No slash commands available";

  return (
    <div ref={listRef} className="ai-slash-menu">
      <div
        id={AI_SLASH_LISTBOX_ID}
        className="ai-autocomplete-options"
        role="listbox"
        aria-label="Slash commands"
      >
        {items.map((cmd, i) => {
          const on = i === activeIndex;
          return (
            <button
              key={cmd.id}
              id={slashCommandOptionId(cmd)}
              type="button"
              role="option"
              aria-selected={on}
              aria-label={`${cmd.label}: ${cmd.hint}`}
              tabIndex={-1}
              data-slash-idx={i}
              className="ai-slash-item"
              data-active={on ? "true" : undefined}
              onPointerDown={(e) => {
                // Retain the owner on mouse press without turning a
                // touch/pen scroll gesture into an accidental command.
                if (e.pointerType === "mouse") e.preventDefault();
              }}
              onClick={() => onSelect(cmd)}
              onMouseEnter={() => onHover(i)}
            >
              <span className="ai-slash-item-label">{cmd.label}</span>
              <span className="ai-slash-item-hint">{cmd.hint}</span>
            </button>
          );
        })}
      </div>
      <div
        className={items.length === 0 ? "ai-mention-status" : "visually-hidden"}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {resultStatus}
      </div>
    </div>
  );
}
