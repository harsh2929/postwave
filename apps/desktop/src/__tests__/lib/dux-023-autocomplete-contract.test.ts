import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("DUX-023 autocomplete source contract", () => {
  it("keeps both owning textareas on one active-descendant combobox model", () => {
    const ai = source("components/ai/PostwaveAIChatPanel.tsx");
    const aiInteractions = source("pages/PostwaveAI.tsx");
    const notes = source("components/subscriber/MarkdownNoteEditor.tsx");

    for (const owner of [ai, notes]) {
      expect(owner).toContain('role="combobox"');
      expect(owner).toContain('aria-autocomplete="list"');
      expect(owner).toContain('aria-haspopup="listbox"');
      expect(owner).toContain("aria-expanded=");
      expect(owner).toContain("aria-controls=");
      expect(owner).toContain("aria-activedescendant=");
    }
    expect(notes).toContain("nativeEvent.isComposing");
    expect(notes).toContain("keyCode === 229");
    expect(aiInteractions).toContain("event.nativeEvent.isComposing");
    expect(aiInteractions).toContain("event.keyCode === 229");
    expect(aiInteractions).toContain(
      "const slashOpen = slashTrigger !== null;",
    );
    expect(aiInteractions).toContain("autocompleteNavigationRef.current");
    expect(aiInteractions).toContain("nativeEvent.isComposing");
    expect(aiInteractions).toContain("keyCode === 229");
    expect(notes).toContain("dismissedTriggerRef.current");
  });

  it("keeps options stable, selected, pointer-scroll-safe, and out of Tab order", () => {
    const menus = [
      source("components/ai/MentionMenu.tsx"),
      source("components/ai/SlashCommandMenu.tsx"),
      source("components/subscriber/NoteMentionMenu.tsx"),
    ];

    for (const menu of menus) {
      expect(menu).toContain('role="listbox"');
      expect(menu).toContain('role="option"');
      expect(menu).toContain("aria-selected={on}");
      expect(menu).toContain("tabIndex={-1}");
      expect(menu).toContain("encodeURIComponent");
      expect(menu).toContain(
        'if (e.pointerType === "mouse") e.preventDefault()',
      );
      expect(menu).toContain("onClick={() => onSelect(");
      expect(menu).toContain('role="status"');
      expect(menu).toContain('aria-live="polite"');
    }
  });

  it("pins both popup families to bounded visible surface styles", () => {
    const aiStyles = source("styles-ai-autocomplete.css");
    const noteStyles = source("styles-subscriber-notes.css");

    expect(aiStyles).toMatch(
      /\.ai-slash-menu\s*\{[\s\S]*position: absolute;[\s\S]*bottom:[\s\S]*max-width:[\s\S]*max-height:[\s\S]*overflow: hidden;/u,
    );
    expect(aiStyles).toContain("overscroll-behavior: contain;");
    expect(aiStyles).toContain("var(--pw-layer-popover, 400)");
    expect(aiStyles).toContain("@media (max-width: 560px)");
    expect(noteStyles).toMatch(
      /\.note-mention-menu\s*\{[\s\S]*bottom:[\s\S]*width: min\([\s\S]*max-height:[\s\S]*overflow: hidden;/u,
    );
    expect(noteStyles).toContain("@media (max-width: 420px)");
    expect(noteStyles).toContain("var(--pw-layer-popover, 400)");
  });
});
