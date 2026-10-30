# DUX-023 analytics popup interaction wave

Date: 2026-07-17  
Status: code-qualified; installed qualification remains open  
Scope: Analytics Export, Group By, Saved Views, Chart Actions, and KPI Config

Date Range is explicitly out of scope for this wave. Its separate calendar
contract and evidence remain unchanged.

## Semantic disposition

| Surface | Final model | Reason |
| --- | --- | --- |
| Export | Named menu | Two mutually exclusive immediate commands. |
| Group By | Named menu of radio items | One dimension is selected at a time; unavailable dimensions remain discoverable but cannot activate. |
| Chart Actions | Instance-named menu | Each chart owns two immediate commands and an instance-unique trigger/popup relationship. |
| Saved Views | Labelled non-modal dialog popover | Every saved-view row has independent Apply and Delete actions, plus a nested naming modal. A menu cannot lawfully own that structure. |
| KPI Config | Labelled non-modal dialog popover | Checkboxes, drag targets, reorder buttons, Reset, status, and help form a small configuration task rather than a menu. |

This classification preserves all existing export, print, clipboard, saved
view, visibility, drag, reset, and ordering operations. It changes interaction
and presentation ownership, not data authority or permission boundaries.

## Findings closed

1. Export was unnamed and had no trigger/popup id relationship, focus entry,
   menu traversal, typeahead, IME guard, Escape return, Tab close, or pointer
   dismissal beyond mouse-only `mousedown`.
2. Group By had the same incomplete menu contract. Its unavailable choices
   were native-disabled and explained only through `title`, making the reason
   unreachable to keyboard focus and unreliable for assistive technology.
3. Saved Views used `role="menu"` around ordinary containers, two independent
   buttons per row, empty copy, and a create action. This was invalid menu
   ownership and offered no defined entry, focus-departure, Escape, or return
   path.
4. Chart Actions had local Arrow/Home/End code but no buffered typeahead, Tab
   close, programmatic focus-departure close, shared behavior, unique popup id,
   or responsive width/height contract.
5. KPI Config was correctly closer to a dialog, but it had no relationship to
   its trigger, focus entry/return, top-layer Escape, focus-departure close, or
   reorder announcement. Its comment incorrectly claimed that a native list
   supplies arrow traversal.
6. All five popups used fixed minimum widths and ad hoc layer values. Their
   shared stylesheet now clamps inline size to the viewport, bounds vertical
   scrolling with contained overscroll, uses the authoritative popover layer,
   and keeps focus/selected/unavailable cues in forced colors.

## Final interaction contract

### True menus

- Export, Group By, and every Chart Actions instance register with the shared
  logical dialog stack. Escape is honored only by the top surface.
- Their triggers expose `aria-haspopup="menu"`, expanded state, and an
  instance-safe `aria-controls` target while open. Every popup has an
  accessible name.
- Opening focuses the selected Group By item or the first Export/Chart action.
- Arrow Down/Up wrap, Home/End reach boundaries, and buffered repeated-letter
  typeahead uses the shared `useMenuInteraction` contract.
- Composition and key-code-229 events do not dismiss or typeahead-select.
- Escape closes and restores the trigger. Tab closes without stealing the
  browser's destination. Outside pointer and programmatic focus departure
  close without pulling focus away from the destination.
- Successful commands/selections close and return focus to the durable
  trigger. CSV, Print/PDF, PNG, Copy Link, and Group By callbacks are unchanged.

Group By unavailable rows deliberately remain focusable menu radio items with
`aria-disabled="true"`. They are included in Arrow/typeahead traversal, expose
visible “Unavailable” copy through `aria-describedby`, and guard activation in
the existing click callback. They are not native-disabled because an
unfocusable control would recreate the inaccessible explanation.

### Saved Views

- The trigger now opens a named non-modal dialog and focus enters its first
  Apply action, or Save Current View when the list is empty.
- Saved views are a semantic list. Apply and Delete remain distinct native
  buttons with complete names; there are no menu descendants or nested
  interactive controls.
- Deleting a row announces the deletion and moves focus to the next logical
  Apply action, the previous last Apply action, or Save Current View when the
  list becomes empty.
- Escape returns to the trigger. Outside pointer and focus departure close
  without focus theft.
- Save Current View hands off to the existing modal. The input id is
  instance-safe, validation is described/announced, and every modal dismissal
  returns to the Saved Views trigger after the modal's own cleanup.

### KPI Config

- The trigger controls a named, described non-modal dialog. Opening focuses
  the dialog container so its task name and instructions are encountered
  before its controls; native Tab then traverses Reset, checkboxes, and move
  buttons.
- The list remains a semantic list only. No Arrow-key traversal is claimed or
  synthesized. Pointer drag remains available and every row retains labelled
  Move up/Move down native buttons as the keyboard-equivalent operation.
- Button and drag reorder both announce the card's resulting one-based
  position and total. Visibility and Reset changes also announce their result.
- Minimum/maximum visibility restrictions remain enforced. A disabled
  checkbox now references a visible reason instead of relying on a hover-only
  label title.
- Escape returns to the trigger; outside pointer and focus departure close
  without focus theft. Close also clears transient drag/drop state.

## State, privacy, and security invariants

- Export still passes content through the classified file-transfer boundary;
  Chart Copy Link still uses the classified clipboard boundary and configured
  web-dashboard fallback for packaged Tauri origins.
- React continues to render saved names and labels as text. No HTML injection,
  arbitrary selector construction, URL construction, or new transport was
  introduced.
- Saved-view names retain their 60-character cap and inline validation. Delete
  focus recovery uses a numeric row position rather than interpolating a
  persisted id into a selector.
- KPI normalization, four-card floor, eight-card ceiling, drag lifecycle,
  visibility, reset, and persistence shape remain unchanged.
- The existing localStorage keys remain browser-global rather than truly
  workspace-scoped. Their payloads contain layout/range preferences rather
  than credentials or message content, but cross-workspace preference bleed is
  a pre-existing correctness/privacy residual. This bounded wave does not
  migrate or silently invalidate stored state.

## Automated evidence

Focused rendered and source contract:

```text
pnpm --dir apps/desktop test -- --run \
  src/__tests__/components/analytics-menu-interactions.test.tsx \
  src/__tests__/components/analytics-popover-interactions.test.tsx \
  src/__tests__/components/analytics-popup-source-contract.test.ts
```

Coverage includes menu naming/relationships; first/selected entry; Arrow,
Home, End, buffered typeahead; composing and ordinary Escape; Tab and outside
pointer close; focus-departure close; action focus return; focusable described
unavailable radio items; collision-safe instance ids; valid multi-action
Saved Views structure; delete focus continuity; naming-modal return; KPI entry,
visibility help, reorder state/live speech, and Escape return; plus an expanded
Group By, Saved Views, and KPI Config axe-core runs with no serious or critical
automated violations.

Result at the reconciled wave checkpoint: **3 suites, 15 tests passed**. The
adjacent Analytics Group By, dashboard-boundary, presentation, and DUX-025
export-ownership checkpoint also passed **4 suites, 19 tests**.

Additional qualification commands:

```text
pnpm --dir apps/desktop exec eslint \
  src/components/analytics/{ExportMenu,GroupByMenu,SavedViewsMenu,ChartActions,KpiConfigMenu}.tsx \
  src/__tests__/components/analytics-{menu-interactions,popover-interactions,popup-source-contract}.test.ts* \
  --max-warnings 0
pnpm --dir apps/desktop exec stylelint src/styles-analytics-popups.css
pnpm --dir apps/desktop exec eslint <owned production files> \
  --rule 'max-lines-per-function:["error",{"max":300,"skipBlankLines":true,"skipComments":true}]' \
  --rule 'complexity:["error",50]'
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop typecheck:renderer-tests
pnpm --dir apps/desktop build
git diff --check
```

Scoped production/test ESLint, popup Stylelint, the owned default 300-line and
complexity-50 limits, full desktop app TypeScript, renderer-test TypeScript,
the production Vite build (1,516 transformed modules), and diff-check pass.
The shared-tree `check:function-quality` run reached its
five passing contract cases, then correctly rejected concurrent exact-ratchet
drift in unowned files such as `Collections`, `FormDetailSlideover`,
`MigrationWizard`, `APIPlayground`, and `PostwaveAI`; none of this wave's five
production files appeared in that finding list. This distinction is retained
instead of misreporting a global green gate. Repository automation is evidence
of source behavior; it is not installed-platform evidence.

## Residual installed qualification

DUX-023 remains `IN PROGRESS` until these checks are captured against the exact
signed macOS and Windows builds:

1. VoiceOver on supported macOS and NVDA on supported Windows: trigger state,
   menu/dialog name, first/selected entry, radio checked/disabled explanation,
   multi-action row navigation, modal handoff/return, and live reorder speech.
2. Keyboard-only traversal: repeated and multi-character typeahead timing,
   Shift+Tab/Tab destination retention, top-layer Escape with another modal,
   delete focus continuity, all move buttons, and cancelled/complete drag.
3. 200% and 400% zoom plus the minimum supported native window: no horizontal
   clipping, first/last item reachability, internal scrolling, long saved names,
   localized expansion, and chart-card popups near every viewport edge.
4. Windows High Contrast and macOS increase-contrast/reduce-transparency:
   popup boundary, focus ring, selected radio, unavailable explanation, drop
   target, disabled checkbox reason, and live status visibility.
5. Real CJK IMEs: composing Escape and key-code-229 behavior while a true menu
   is open, followed by normal typeahead after composition completes.
6. Mouse, trackpad, touch, and pen where supported: outside dismissal, no
   accidental activation while scrolling, Saved Views delete targeting, and
   native drag/drop versus labelled-button equivalence.
7. Native integration denial/failure: Print/PDF cancellation, file-picker
   cancellation and denial for CSV/PNG, clipboard denial, empty chart capture,
   long-running export, and focus state after each result.
8. Browser/WebView hit-testing for overlapping toolbar, chart, tooltip, modal,
   toast, and drawer layers; automated CSS assertions cannot prove the painted
   or pointer-target order.
9. A usability pass with prospective-client workflows to validate naming,
   discoverability of unavailable dimensions, Saved Views Apply/Delete
   separation, and whether dialog-container entry for KPI Config produces the
   clearest VoiceOver/NVDA announcement.
