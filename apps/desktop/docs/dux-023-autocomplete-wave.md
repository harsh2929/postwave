# DUX-023 autocomplete accessibility and interaction wave

Date: 2026-07-16  
Status: code-qualified; installed assistive-technology/platform qualification remains open  
Scope: Moosewave AI slash/resource autocomplete and subscriber-note teammate autocomplete

## Owned surfaces

| Surface | Owner | Popup | Result source |
| --- | --- | --- | --- |
| Moosewave AI chat composer | `pages/PostwaveAI.tsx` | `components/ai/SlashCommandMenu.tsx` | Local slash-command catalog |
| Moosewave AI chat composer | `pages/PostwaveAI.tsx` | `components/ai/MentionMenu.tsx` | Debounced campaign/subscriber/sequence/template/form search |
| Subscriber note composer | `components/subscriber/MarkdownNoteEditor.tsx` | `components/subscriber/NoteMentionMenu.tsx` | Parent-provided workspace-user candidates |

This wave deliberately does not claim the other DUX-023 tablists, menus,
date pickers, tooltips, or shortcut surfaces. It does not change autocomplete
transport, resource authorization, note persistence, prompt submission, or
accepted mention token formats.

## Findings closed

1. The AI slash and mention menus had no dedicated popup CSS. They rendered
   as ordinary form children rather than a reliably visible, bounded popup.
2. Neither owning textarea exposed a combobox/listbox relationship. A screen
   reader could encounter a listbox without knowing that it belonged to the
   active composer.
3. Option buttons were tabbable while the textarea also retained keyboard
   ownership. This created two competing focus models.
4. Options had no stable DOM ids, so an owner could not expose the currently
   highlighted result through `aria-activedescendant`.
5. A slash query with zero matches removed the popup entirely. There was no
   visible or live result context, and Escape could not explicitly dismiss
   that trigger state.
6. The subscriber editor only handled Escape when at least one candidate
   existed. Its broad keyup recomputation also reset ArrowDown selection and
   could reopen a just-dismissed trigger.
7. Enter and Escape could be interpreted as autocomplete commands during an
   IME composition sequence.
8. Committing immediately on pointer-down made a touch/pen attempt to scroll
   a long result list capable of selecting an option.
9. AI caret-selection events could reset an Arrow-key highlight to the first
   result. A navigation ownership window now suppresses that conflicting
   recomputation until keyup, and blur safely clears the window.

## Final interaction contract

| Interaction | Contract |
| --- | --- |
| Type `/query` in Moosewave AI | Open the slash listbox even when there are zero matches; keep the draft unchanged. |
| Type `@query` | Open the relevant mention listbox; AI reports search-in-progress while its debounced resource batch is pending. |
| Arrow Down / Arrow Up with results | Move the highlighted option cyclically, scroll it nearest into view, retain textarea focus, and update `aria-activedescendant`. |
| Enter with results | Commit the active option only for a non-composing, unmodified Enter. |
| Tab with results | Commit the active option on forward Tab; Shift+Tab remains native reverse focus navigation. |
| Enter or Tab with zero results | Preserve native textarea behavior because there is no actionable option. |
| Escape, including zero results | Dismiss the popup without deleting or rewriting the draft; the identical value/caret fingerprint stays dismissed until the operator changes the value or caret. |
| IME Enter / Escape or key code 229 | Do not commit or dismiss autocomplete. Recompute against the final text on composition end. |
| Mouse press | Prevent focus from leaving the owning textarea; commit through click. |
| Touch/pen drag | Preserve the native gesture so a bounded list can scroll without accidental selection; a completed click/tap commits. |
| Pointer commit | Insert the same existing token/fill text, retain surrounding draft text, restore the caret after insertion, and keep the textarea focused. |
| Mention loading / empty / results | Provide a polite atomic status: search context, zero-result context, or bounded result count. |

## Accessibility structure

- Each owning textarea is the sole focus owner and exposes `role="combobox"`,
  `aria-autocomplete="list"`, `aria-haspopup="listbox"`, `aria-expanded`,
  `aria-controls`, and an active `aria-activedescendant` only when a real
  option exists.
- AI slash and resource listboxes have page-stable ids. Subscriber-note
  listbox ids are instance-scoped with React `useId`, preventing collisions if
  more than one editor is ever mounted.
- Option ids derive from stable command/resource/user identities rather than
  result order. Options expose `role="option"`, exactly one selected state,
  and `tabIndex={-1}`.
- Loading and empty copy lives outside the listbox's owned option collection,
  avoiding a non-option child inside the listbox. Result context uses a polite,
  atomic status region.
- The async AI mention listbox exposes `aria-busy` while resource search is in
  flight.

## Visual and adaptive contract

- AI autocomplete is absolutely anchored above the composer, with a 440 px
  preferred width, form-width clamping, a viewport-relative height cap,
  contained overscroll, stable scrollbar gutter, elevation, selected-row
  border/background, and a narrow-window inset fallback at 560 px.
- Subscriber mention autocomplete opens above the bottom-drawer textarea,
  clamps to its editor width and viewport height, contains scroll, and switches
  to four-pixel inline insets below 420 px.
- Both families retain a non-color selected boundary in forced-colors mode.
- Both use the authoritative popover layer token, remaining below drawer,
  tour, modal, command, tooltip, toast, diagnostics, and shortcut-HUD owners.
- Truncated labels and hints keep row height and popup width stable; complete
  accessible names still include primary and secondary context.

## Draft, data, and security invariants

- Slash fills, destructive `/clear` confirmation, AI mention token syntax,
  subscriber mention token syntax, prompt context refs, and note markdown
  storage remain unchanged.
- Escape, loading, no results, Arrow navigation, and IME keys never submit a
  prompt or note.
- React continues to render result labels and queries as text; this wave adds
  no HTML injection path and persists no new data.
- The AI resource search remains abortable, debounced, tenant-scoped through
  existing API ownership, and capped at eight results. Subscriber candidates
  remain parent-derived; no fabricated directory endpoint was introduced.

## Automated evidence

Focused command:

```text
pnpm test -- --run \
  src/__tests__/lib/dux-023-autocomplete-contract.test.ts \
  src/__tests__/pages/postwave-ai-autocomplete.test.tsx \
  src/__tests__/components/ai-autocomplete-menus.test.tsx \
  src/__tests__/components/markdown-note-editor-autocomplete.test.tsx \
  src/__tests__/components/subscriber-notes-panel.test.tsx
```

Result: 5 suites, 21 tests passed.

Coverage includes:

- AI zero-result slash ownership and live status;
- AI Arrow selection surviving React selection events;
- composing versus non-composing Enter and Escape;
- raw-trigger submission clearing popup ownership before generation;
- debounced AI mention loading and fetched active option;
- stable option ids, selected state, and no second Tab stop;
- subscriber Arrow/Enter insertion, zero-result Escape dismissal,
  composition, pointer insertion, surrounding-draft retention, and focus
  restoration;
- an expanded subscriber combobox/listbox axe-core check with no serious or
  critical automated violations;
- existing subscriber-note permission, attachment, mutation, and candidate
  regressions;
- a static source/CSS ratchet for owner relationships, IME guards,
  scroll-safe pointer behavior, and popup clamping.

Additional checks:

```text
pnpm typecheck
pnpm typecheck:renderer-tests
pnpm exec eslint <owned production and focused test files> --max-warnings 0
pnpm exec stylelint src/styles-ai-autocomplete.css src/styles-subscriber-notes.css
pnpm check:function-quality
pnpm test:design-system
git diff --check
```

Result: focused tests, scoped lint/style, renderer-test TypeScript,
function-quality/design-system gates, and diff-check pass. App TypeScript was
green at the stable implementation checkpoint. The final shared-tree rerun
reports one concurrent, unowned diagnostic only:
`src/__tests__/components/data-platform-provider-replacement.test.tsx:101`
passes numeric `schema_version: 1` where its provider contract now expects a
string. This wave does not own or modify that untracked test.

## Residual installed qualification

DUX-023 must remain `IN PROGRESS` until the following evidence is recorded on
packaged desktop builds:

1. VoiceOver on supported macOS and NVDA on supported Windows: popup
   expansion, result count, active-option speech, async busy transition,
   zero-result Escape, and post-insertion caret speech.
2. Windows High Contrast and macOS increase-contrast/reduce-transparency:
   popup boundary, selected row, status text, and focus visibility.
3. 200% and 400% zoom plus the minimum supported native window: popup width,
   height, above-composer placement, no viewport clipping, and scroll reach to
   the first and last options.
4. Real CJK IMEs on both platforms, including composition Enter, composition
   Escape, key-code-229 fallback, and final-query search after composition end.
5. Mouse, trackpad, touch, and pen where supported: scroll versus tap
   disambiguation and focus retention.
6. Slow, failed, aborted, and rapidly superseded AI mention searches against a
   deployed tenant with mixed resource permissions.
7. A usability pass confirming that forward Tab-to-accept remains desirable
   for both multiline composers and does not surprise the target client cohort.
