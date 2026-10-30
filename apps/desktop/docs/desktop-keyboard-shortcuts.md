# Desktop keyboard shortcut contract

Status: source foundation implemented; DUX-035 remains in progress

Owner: desktop shell

Last reconciled: 2026-07-16

## Authority and scope

`src/lib/desktop-shortcuts.ts` is the only authority for application-wide
renderer shortcuts, native-menu accelerators, the opt-in OS-global quick
compose binding, display labels, ARIA metadata, help content, Settings, and
contract tests. It stores semantic intents rather than callbacks or route
strings.

Page-local commands such as submit, canvas movement, table navigation, and
editor formatting still need migration into scoped registries before DUX-035
can be called implemented. They must not be added to the application-wide
dispatcher merely to improve the completion count: their focus, editor, and
overlay rules are different.

## Current architecture

- Each definition owns an ID, label, description, category, scope, binding,
  semantic intent, editable-field policy, overlay policy, and remap policy.
- Bindings carry both a logical `KeyboardEvent.key` and a physical
  `KeyboardEvent.code`. The device preference selects logical or physical
  matching.
- macOS uses Meta as the primary modifier. Windows/Linux use Control. An
  unknown platform accepts exactly one of Meta or Control; it never treats
  both as a valid chord.
- The renderer dispatcher ignores repeat events, active IME composition,
  key-code 229, and AltGraph. Extra modifiers fail exact matching.
- Shell navigation is suppressed in text entry and while a top-layer dialog is
  active. Search and commands remains available from a text field and while
  its own dialog is open so the same shortcut can close it.
- `G` sequences arm for 1.5 seconds and show the complete, live-region chord
  HUD. A mismatching second key cancels the chord and is evaluated once as a
  fresh shortcut.
- Sidebar, command palette, Top Bar, help/tour, onboarding, and routed Settings
  labels project the same current binding. No consumer owns a second string
  such as `Cmd+K`.
- Device-local preferences are versioned, bounded, schema-validated, and
  contain key metadata only. Corrupt, unknown, native-owned, and malformed
  overrides are ignored.
- Remapping refuses unmodified character keys, standard Edit/Window keys,
  reserved function keys, exact collisions, IME/AltGraph input, and native
  menu bindings. Save failures remain visible and do not change the active
  binding.
- Native-owned Dashboard and Approvals accelerators are represented by the
  same definitions but deliberately locked until the Rust menu can atomically
  accept and persist dynamic accelerator changes. New campaign, Settings,
  close, quit, and global quick compose are also visible as system-managed.

## Intent ownership

| Intent class                        | Delivery                                                | Current policy                                                             |
| ----------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| Search, help, onboarding            | Renderer dispatcher                                     | Remappable; platform label and ARIA metadata update immediately.           |
| Section navigation                  | Renderer dispatcher, plus native Dashboard/Approvals    | Editable- and overlay-suppressed; native-owned entries locked.             |
| `G`, then destination               | Renderer dispatcher                                     | Unmodified only outside editors/overlays; visible timed HUD.               |
| New campaign, Settings, close, quit | Native menu event into typed shell/lifecycle path       | System managed; cannot drift into an unreviewed renderer action.           |
| Quick compose                       | Opt-in Rust global shortcut, then retained native event | Disabled by default; system managed; app reveal/focus precedes the intent. |

## Settings behavior

The routed `Settings → Keyboard shortcuts` surface is addressable as
`/app/settings?anchor=keyboard-shortcuts`. It provides:

- logical-versus-physical layout behavior;
- search across action, description, and category;
- a semantic table with row/column headers and horizontal overflow;
- current, custom, and system-owned status;
- capture instructions in a polite live region;
- collision/reserved/storage failure explanations;
- Escape to cancel, Backspace/Delete to restore one default;
- per-binding reset and an explicit all-defaults confirmation.

Preferences take effect in the dispatcher on the next key event and notify
other same-origin windows through the storage event. There is no unsaved draft
and no lifecycle owner: each accepted change is persisted atomically before it
is announced as active.

## Automated evidence

The shortcut-specific checkpoint covers 26 tests across four suites:

- registry uniqueness, route projection, macOS/Windows labels, spoken labels,
  and `aria-keyshortcuts`;
- strict platform modifiers, logical/physical layouts, IME, AltGraph, repeat,
  corrupt storage, unsafe bare keys, reserved commands, native locks,
  collisions, persistence, and reset;
- dispatcher editable/overlay policy, palette exception, chord HUD,
  destination dispatch, cancellation, timeout, and mismatching-key recovery;
- Settings table/search/remap/conflict/cancel/reset behavior and Rust
  native-menu/global-accelerator source parity.

The reconciled focused checkpoint is 33/33 across five suites after adding the
existing Account Menu behaviors and its exact in-app Settings-anchor handoff.

Focused tests, scoped zero-warning ESLint, app TypeScript, and renderer-test
TypeScript pass on the reconciled shared tree. The whole renderer, production
build, bundle, stylesheet, and native suites remain part of the final
reconciled checkpoint.

## Exact installed qualification still required

Run against the hash-bound signed release candidate, not a browser preview.

| Matrix                      | Required proof                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS Intel + Apple Silicon | Command labels, application-menu interception, close/quit lifecycle review, Dashboard/Approvals parity, global-shortcut opt-in/failure, VoiceOver announcements, focus restoration. |
| Windows/WebView2            | Control labels, Alt+F4/system-menu behavior, Narrator announcements, global-shortcut registration conflict, focus after hidden-window reveal.                                       |
| Layouts                     | US, AZERTY, QWERTZ, Dvorak and one non-Latin layout in logical and physical modes; labels must stay truthful.                                                                       |
| Input methods               | Japanese and Indic IME composition, dead keys, AltGr, sticky keys, repeat, external keyboards, and remote-desktop input. No intermediate event may dispatch.                        |
| Editors and overlays        | Input, search, password, textarea, select, contenteditable, combobox, modal, slideover, palette, onboarding, and nested layers.                                                     |
| Persistence/faults          | Relaunch, second window, corrupt/old JSON, denied/quota-full storage, profile reset, and Settings reset/cancel.                                                                     |
| Accessibility               | Keyboard-only discovery and completion, 200% zoom, 880×560, forced colors, reduced motion, VoiceOver, Narrator/NVDA, and no duplicate live announcement.                            |

## DUX-035 exit criteria

DUX-035 may move to `IMPLEMENTED` only after every production keyboard listener
is inventoried and either migrated to the global registry or a documented
scoped registry; scoped dispatch has the same composition/editable/overlay and
conflict rules; native dynamic remapping is either implemented atomically or
explicitly removed from the product promise; and the source/native contract
suites plus the full renderer/build gates pass.

It may move to `VERIFIED` only after the installed matrix above passes on exact
signed macOS and Windows artifacts with artifact hashes and reviewer evidence.
