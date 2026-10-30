# Desktop composite-widget migration

Date: 2026-07-16; source checkpoint refreshed 2026-07-16  
Audit item: DUX-023  
Status: **IN PROGRESS — composite source migration is code-qualified; title-policy and installed qualification remain**

## Decision

The audit baseline exposed a systemic composite-widget gap: only one of 37
semantic tablists had the complete focus and tab/panel relationship expected of
a desktop tabset, menu behavior diverged by owner, pseudo-tabs represented
ordinary choices, and several rich popups had no stable focus or dismissal
contract. That baseline is retained below because it explains the migration;
it no longer describes the current source tree.

The current source checkpoint has converged the major composite families:

1. Thirty-one true-tab hook sites across 30 production owners use the shared
   `useTabsInteraction` relationship. Production contains zero literal
   `tablist`, `tab`, or `tabpanel` roles outside the hook. Manual activation
   moves the real roving stop without changing the panel; automatic activation,
   stable value-based ids, dynamic removal, disabled skipping, focus reveal,
   and exact list/tab/panel relationships are covered centrally.
2. Twenty-two immediate-choice sites across 19 owners use `ChoiceGroup` rather
   than fabricated tabs. Unavailable choices remain discoverable, cannot be
   transiently selected, and expose their reason visibly and semantically.
3. The nine remaining semantic menu owners all use `useMenuInteraction` for
   entry, Arrow/Home/End, buffered typeahead, IME safety, Tab/focus departure,
   pointer dismissal, top-layer Escape, and trigger restoration. Analytics
   Saved Views and KPI configuration are correctly modelled as named non-modal
   dialog popovers because their content is not a lawful menu.
4. Analytics date range, suppressions date range, onboarding hints, SMS quick
   reply, AI/note autocomplete, and Library Grid/List/Quick Look now have
   explicit focus, pointer, asynchronous-state, collision, compact-window,
   forced-color, and restoration behavior appropriate to each semantic model.
5. `styles/overlay-layers.css` is the final cascade layer and assigns named
   levels to shell popups, drawers, tours, modals, command, portalled help,
   toasts, diagnostics, and the shortcut HUD. Modal/drawer convergence itself
   is tracked under DUX-009/022, not hidden inside this composite count.
6. All advertised global/navigation shortcuts derive from one platform-aware,
   remappable registry consumed by dispatch, Settings, shell, palette, help,
   and `aria-keyshortcuts`; conflict and persistence rules are tested once.

This is not a `VERIFIED` claim. Native interactive `title` debt is now measured
with `pnpm audit:interactive-titles` and is being replaced with visible
prerequisites, consequences, permission reasons, and durable accessible names.
Browser hit-testing, real IME, 200–400% zoom, operating-system contrast modes,
and VoiceOver/Narrator/NVDA still require the exact signed macOS/Windows
artifacts. Specialized evidence lives in `dux-023-analytics-popup-wave.md` and
`dux-023-autocomplete-wave.md`.

## Reproducible production inventory

The inventory scans production TSX only and excludes tests and stories. JSX
open tags were parsed as units so role strings in tests, comments, or selector
queries were not counted as rendered widgets.

| Family | Audit baseline | Current source checkpoint |
| --- | ---: | --- |
| True tabs | 37 semantic tablists across 35 files; 43 rendered sites; one complete relationship | 31 shared hook sites across 30 owners; zero bespoke literal tab roles; every owner is named and exposes a related panel. |
| Immediate choices masquerading as tabs | 10 groups inspected manually | 22 `ChoiceGroup` sites across 19 owners, including filters, providers, branches, input modes, and view modes. |
| Semantic menus | 10; seven named; only two had partial key handling | Nine lawful menus after Saved Views reclassification; all nine use the shared menu contract and the exact owner set is CI-pinned. |
| Multi-action/configuration popups | Invalid menu ownership or local dialog behavior | Saved Views and KPI Config are named non-modal dialog popovers with entry/return, focus departure, pointer, Escape, live result, and compact geometry contracts. |
| Custom autocomplete/listbox owners | Contradictory focus and popup ownership in AI/note/Library owners | Textarea-owned combobox/listbox relationships, stable active descendants, stale-query rejection, IME safety, pointer retention, honest zero/error state; Library is a truthful native list/table rather than a listbox. |
| Native selectors | 216 `select` elements in 130 files; five datalists | Native behavior remains preferred where it fits; label/error and blocked-action quality are tracked under DUX-010/021. |
| Native interactive `title` | Historical scan found 199 interactive uses within 677 total attributes | Live TypeScript-AST inventory: `pnpm audit:interactive-titles`; remediation is active and the command reports every owner, line, disabled exposure, and expression. |
| Portalled popup owners | One production `createPortal` call | Eight intentional production portal owners plus shared modal/drawer shells; each portalled composite has explicit positioning/layer/focus ownership. |
| Shortcut definitions | Scattered display and handler assumptions | One canonical platform-aware registry with dispatcher, remapping, persistence, conflict, Settings, help, palette, shell, and ARIA consumers. |

## P0 defect register

| Surface | Audit defect | Current disposition |
| --- | --- | --- |
| Global overlay order | Modal 1000, command 100, tooltip 100, tour 1500/1501 and Transfer Center 1100 contradicted both comments and dialog-stack order. | **Source-fixed.** Final-cascade named scale and a four-case source contract pass. Browser hit-testing and installed qualification remain. |
| Workspace menu | At the responsive 64 px sidebar width, 8 px insets produced an approximately 48 px menu that was clipped by sidebar overflow. | **Source-fixed.** Portalled fixed positioning, viewport clamp/max-height, menu keyboard behavior and trigger restoration pass five focused cases. |
| Library Grid/List | Listbox owns non-option buttons; container and children are all tab stops; Space both selects and opens Quick Look; tile actions are nested/unreachable; context menu is suppressed while handlers are TODOs. | **Source-fixed.** Grid is a native list and List is a semantic table. Both expose one roving primary asset button, Space-only selection, Enter-only Quick Look, Arrow/Home/End DOM focus, full Shift ranges and real sibling Preview/Copy/Delete controls. Native pointer and Shift+F10 context menus are no longer suppressed. Thirty focused cases, including rendered axe checks of both views, pass; installed pointer/AT qualification remains. |
| AI and note autocomplete | Audit baseline had no owning popup relationships or stable option IDs, unsafe IME selection, broken zero-result Note dismissal and no AI popup CSS. | **Source-fixed.** Textarea-owned combobox/listbox relationships, stable active descendant, one focus model, IME/key-229 safety, honest states, stale-result protection, pointer retention and responsive/forced-color CSS pass 21 cases across five suites, including axe. Installed IME/AT/pointer/network qualification remains. |
| Date range picker | Audit baseline had a fixed 560 px minimum, 84 day-button tab stops, missing calendar navigation/range announcements and no focus-leave/trigger-restoration contract. | **Source-fixed.** One/two-month responsive model, one roving day stop, full grid navigation, local-date validation, explicit draft review, live state, top-layer Escape, focus-leave close, portal collision clamp and 440×280 geometry pass ten focused tests. Installed AT/zoom qualification remains. |
| Command palette compact height | Fixed 96 px top padding plus 480 px content can exceed a short/high-zoom viewport. | **Source-fixed.** Dynamic top offset and `100dvh` content bound are governed by the overlay contract. |

### Library semantic decision

The Library intentionally does **not** use an ARIA grid or listbox. Each asset
has independent Preview, Copy URL and permission-gated Delete commands, while
the list presentation also has real tabular columns. A native list of cards and
a native table therefore communicate the content truthfully without placing
interactive descendants inside `option` elements or simulating table behavior.

In either view, only the current asset's primary button is in the collection's
roving Tab sequence. Arrow keys and Home/End move real DOM focus; Shift plus
movement adds every crossed asset to the selection; Space toggles only the
focused asset; and Enter opens Quick Look without changing selection. The
active asset's real sibling actions follow it in Tab order. Quick Look close
restores the corresponding primary button, including after previous/next
navigation. Right click and Shift+F10 remain browser-owned because the product
does not yet provide a real asset context menu with keyboard parity.

The existing 200-item page/load-more boundary, picker alternatives, drag
validation, centralized copy/delete paths, write-permission gating and transfer
lifecycle remain unchanged. Inactive asset actions are removed from sequential
keyboard navigation, keeping the collection bounded even at the current page
limit. The production asset contract has no favorite field, mutation or prior
favorite affordance, so this wave does not fabricate a misleading local-only
favorite. Adding favorite requires a separately owned persisted product/API
contract.

## True-tab migration inventory

These surfaces represent mutually exclusive document panels and are now
source-converged on `useTabsInteraction`. Each exposes one real roving stop,
stable `tab`/`tabpanel` ids and relationships, Arrow/Home/End behavior, focus
reveal, and a deliberate automatic-versus-manual activation policy. Tabs that
start work or switch substantial panels use manual activation; already-loaded
lightweight response panels can use automatic activation. Existing drafts stay
mounted unless the domain explicitly owns a guarded transition.

### Page and major-panel tabsets

- `pages/WebhooksHome.tsx`
- `pages/Reviews.tsx`
- `pages/SMSInbox.tsx`
- `pages/MCP.tsx`
- `pages/PostwaveAI.tsx`
- `pages/APIPlayground.tsx`, including its inner response tabset
- `pages/InboundRoutes.tsx`
- `pages/Agency.tsx`
- `pages/Helpdesk.tsx`

### Detail and tool tabsets

- `components/automations/TriggerDetailSlideover.tsx`
- `components/forms/GrowthPanel.tsx`
- `components/forms/SocialCaptureSection.tsx`
- `components/TemplateDetailSlideover.tsx`
- `components/ai/AgentConnectCard.tsx`
- `components/inbound/InboundRouteDiagnostics.tsx`
- `components/playground/PlaygroundCodeGen.tsx`
- `components/webhook-simulator/ResponseInspector.tsx`
- `components/webhooks/EventCatalogDialog.tsx`
- `components/webhooks/VerificationSnippetDialog.tsx`
- `components/subscribers/SubscriberDetailPresentation.tsx` primary panels
- `components/CampaignDetailEditor.tsx`
- `pages/campaigns/CampaignCreateOverlays.tsx`
- `components/EmailPreviewTabs.tsx`
- `components/FormDetailSlideover.tsx`
- `components/campaigns/CampaignABResultsModal.tsx`
- `components/lists/ListDetailSlideover.tsx`

`APIPlayground` formerly placed a Copy control and spacer directly inside a
`tablist`. Copy now sits outside the list while remaining associated with the
active response panel; a rendered contract prevents non-tab children from
returning.

## Choice and filter correction inventory

The following controls represented filters, providers, branches, input
methods, logical operators, or view modes rather than document panels. They are
now source-converged on native radios or the shared labelled `ChoiceGroup`, not
fabricated tabpanels:

- Audience destination platform — `AudienceDestinationModal.tsx`
- Dynamic-content branch — `DynamicContentPanel.tsx`
- Comment status filter — `CommentsModerationCard.tsx`
- Helpdesk status filter — `HelpdeskInbox.tsx`
- Library smart filter — `LibrarySmartFilters.tsx`
- Subscriber channel filter — `SubscriberDetailPresentation.tsx`
- Template source filter — `TemplateLibraryPrimitives.tsx`
- Sequence trigger/input mode — `SequenceTriggerEditor.tsx`
- Suppression import mode — `BulkImportSuppressionsModal.tsx`
- Sequence schedule/input mode — `Sequences.tsx`
- Template device preview — `TemplatePreview.tsx` (validate whether a labelled
  choice group is clearer than a tabset)
- Segment authoring mode — `NaturalLanguageBuilder.tsx`
- Segment AND/OR choice — `VisualSegmentBuilder.tsx`
- Campaign view mode — `CampaignsTopPanels.tsx`

## Menu inventory and required disposition

| Owner | Current source disposition |
| --- | --- |
| Workspace Menu | Portalled and collision-clamped; shared selected/first entry, arrows, Home/End, buffered typeahead, IME guard, Tab/focus/pointer close, Escape restore, compact scrolling, and nested-modal suspension. |
| Account Menu | Shared menu behavior, compact scrolling, and a sibling sign-out dialog rather than an invalid dialog descendant. |
| Analytics Export | Named menu with instance-safe trigger relationship and shared keyboard/dismissal/return behavior. |
| Analytics Group By | Named radio-item menu; unavailable dimensions remain focusable, guarded, visibly explained, and semantically described. |
| Analytics Saved Views | Reclassified to a labelled non-modal dialog popover because each row has Apply and Delete plus a nested naming modal. |
| Chart Actions | Instance-named menu with shared typeahead, Tab/focus/pointer dismissal, collision handling, and trigger restoration. |
| Sequence Status | Named radio-item menu with instance-safe ids, collision handling, visible unavailable reason, and shared behavior. |
| SMS Snooze | Named menu with complete trigger relationship, shared entry/navigation/dismissal, and focus return. |
| Subscriber Column Picker | Named checkbox-item menu with one roving action, focusable guarded required columns, and visible locked reasons. |
| Subscriber Saved Segments | Named action menu with lawful separate Apply/Delete actions, preview state, shared navigation/dismissal, and guarded mutation reasons. |

Pointer dismissal should use pointer events, not mouse-only events. Every owner
must defer Escape to the logical top layer and must define what happens when a
menu launches a modal.

## Combobox, listbox and autocomplete inventory

Strong local references:

- `CommandPalette.tsx`: active descendant, IME guard, asynchronous clamp, live
  result count, pointer focus retention and dialog focus isolation.
- `settings/SettingsNavigator.tsx`: labelled combobox, active descendant,
  result announcement, bounded list and pointer blur prevention.

Source-migrated autocomplete owners:

- `ai/MentionMenu.tsx`
- `ai/SlashCommandMenu.tsx`
- `subscriber/NoteMentionMenu.tsx`
- `pages/PostwaveAI.tsx` composer
- `subscriber/MarkdownNoteEditor.tsx`

Source-converged collection owners:

- `library/LibraryGrid.tsx`
- `library/LibraryList.tsx`
- `library/LibraryTile.tsx`

Library deliberately uses native list/table structure with one roving primary
asset action rather than forcing independent row actions into `option`
descendants. Autocomplete acceptance criteria include stable popup/option IDs, one DOM
focus owner, active-descendant integrity after asynchronous shrink, zero-result
Escape, composition/key-229 safety, pointer selection without premature blur,
and an announcement that does not echo every keystroke.

## Popover and callout inventory

| Owner | Current source disposition / residual |
| --- | --- |
| Analytics Date Range Picker | **Source-fixed:** roving calendar grid, compact one-month layout, collision clamp, draft announcements, focus-leave close and focus return. |
| Analytics KPI Config | Named/described non-modal dialog popover; container entry, native Tab order, keyboard move controls, live reorder/visibility/reset speech, collision clamp, focus departure/Escape/pointer close and return. |
| Suppressions Date Range | Trigger relationship, portalled collision placement, entry/return, IME-safe top-layer Escape, pointer/focus dismissal, and short-viewport containment are source-qualified. |
| SMS Quick Reply | Named and related non-modal dialog; complete entry/dismissal/return, explicit labels, honest create state, collision clamp, and nested-confirm suspension. |
| Onboarding Hint | Portalled, collision-safe, scroll/resize-aware, keyboard-entered, focus/pointer dismissed, top-layer IME-safe Escape, and forced-color qualified. |
| Notifications Panel | Dialog-stack and initial focus exist; remaining source convergence is tracked with the DUX-009/022 non-modal overlay wave. |
| Transfer Center | Dialog-stack participation exists; remaining focus-departure/convergence work is tracked with DUX-009/022. |
| Tour Launcher | Entry, pointer/Escape dismissal, focus return and optional Arrow/Home/End movement exist; dialog-stack/IME and compact placement re-audit remains under DUX-009/022. |
| Tour Tooltip | Non-modal naming, step focus, keyboard actions, reduced motion and target placement exist; measured-height collision and shared stack ownership remain under DUX-009/022. |

## Tooltip policy

`InlineHelp` is a semantic button with description, hover/focus behavior,
Escape, viewport clamping and portal placement. Its named layer paints over the
dialog containing its trigger. `pnpm audit:interactive-titles` is the live
production inventory and remediation queue. Remaining policy and qualification
work:

- A tooltip should not become click-persistent. If persistence is a product
  requirement, expose a labelled non-modal popover and outside dismissal.
- Pointer transit must not make content impossible to inspect.
- Test within a modal, slideover, scroll container, command surface, 200–400%
  zoom and forced colors.
- Do not count `title` on disabled or nonfocusable elements as keyboard or AT
  help. Replace decision-bearing titles with visible copy, described help, or
  a qualified tooltip/popover.

## Bounded implementation order

1. **Foundation and paint order — source-qualified:** named layer scale,
   anchored positioning, shared Tabs, Choice Group, Menu, calendar,
   autocomplete, collection, Popover, and InlineHelp behavior.
2. **Shell menus — source-qualified:** Workspace and Account use one shared
   menu contract. Notifications/Transfer overlay convergence remains in
   DUX-009/022.
3. **AI/note autocomplete — source-qualified.**
4. **Library collection and Quick Look — source-qualified.**
5. **Analytics menus/popovers/calendar — source-qualified.**
6. **Subscriber/SMS menus and popovers — source-qualified.**
7. **True tabs across developer, webhook, messaging, automation, content,
   audience, governance, data, commerce, and integrations — source-qualified.**
8. **Semantic pseudo-tab corrections — source-qualified.**
9. **Interactive-title and blocked-action policy — active:** remove hover-only
   prerequisites/consequences, expose visible reasons, and retain only
   nonessential truncation assistance where justified.
10. **Installed qualification — external evidence:** exact signed packages,
    native WebView behavior, AT, IME, zoom, contrast, pointer, and hit-testing.

## Verification contract

Source completion requires all of the following, not merely an ARIA scan:

- Tabs: one tab stop; Arrow/Home/End; disabled skip; dynamic removal;
  automatic/manual activation; exact tab/panel IDs; overflow focus reveal;
  unsaved-switch veto.
- Menus: keyboard/pointer open; selected-or-first entry; arrows/Home/End;
  typeahead; Enter/Space; Tab close; top-layer Escape restore; outside pointer;
  explainable disabled states; radio/checkbox announcements; nested modal.
- Comboboxes: asynchronous shrink; zero result; IME; active-descendant
  integrity; pointer acceptance without blur; bounded live result context.
- Popovers: entry/return; top-layer Escape; pointer/focusout policy; collision
  flip/shift; resize/scroll reposition; viewport maximums.
- Library: one roving primary asset stop; Space selects only; Enter opens only;
  DOM focus follows Arrow/Home/End; Shift includes every crossed item; active
  sibling actions are reachable; native Shift+F10/right-click remains intact.
- Calendar: one roving day stop; Arrow/Home/End/PageUp/PageDown; range-start and
  range-end announcements; trigger restoration; 440×280 containment.
- Painted layering: browser `elementFromPoint`, focus containment and Escape
  routing for command-over-modal, tooltip-in-modal, tour/modal and nested
  popup/modal.
- Visual matrix: 880×560, 440×280 proxy, 200% and 400% actual zoom, long
  localized labels, text spacing, forced colors and reduced motion.

Installed verification must run at least one instance of every composite in
the exact signed macOS package with VoiceOver and the exact signed Windows
package with Narrator plus NVDA. Record artifact hash, OS/runtime version,
input method, reviewer, task, expected/actual focus sequence, announcement,
visual result and defect link. Until that evidence exists, DUX-023 remains
`IN PROGRESS` even when all source migrations are complete.

## Current focused evidence

| Checkpoint | Result |
| --- | --- |
| Reconciled composite checkpoint, 2026-07-16 | 142/142 tests across 29 suites: shared tabs/menu hooks and inventories, page/detail tabs, ChoiceGroup migrations, Analytics menus/popovers, Account/Workspace, both date-range models, Hint, AI/note autocomplete, Library collection/Quick Look, and shortcut registry/dispatcher/Settings. |
| Production tab inventory | Zero bespoke literal tab roles; 31 shared hook sites across 30 owners; source contracts require every shared owner to name the list and expose a related panel. |
| Production menu inventory | Nine exact semantic-menu owners; all use shared behavior, a named popup, trigger `haspopup`/expanded/controls, and explicit item focus positions. A three-case source contract blocks unreviewed growth. |
| Semantic choice inventory | 22 sites across 19 owners; rendered and source contracts distinguish immediate choices from document tabs and cover unavailable-choice prevention. |
| Analytics popup focused/adjacent evidence | 15/15 focused across three suites and 19/19 adjacent across four suites; source lint/style/function/TypeScript/build gates passed at the wave checkpoint. |
| AI/note autocomplete focused evidence | 21/21 across five suites, including rendered axe and stale-query/IME/pointer cases. |
| Library focused/adjacent evidence | 30/30 collection cases plus 40/40 adjacent filter/workflow/drag/transfer cases; Quick Look adds focused modal ownership, busy dismissal, focus restoration, and axe evidence. |
| Shortcut registry/dispatcher/Settings evidence | 18/18 across three suites for platform labels/ARIA, unique/conflict-safe bindings, remapping persistence, text-entry protection, chords, and Settings disclosure. |
| Design-token/composite CSS boundary | Seven design-system/token cases pass; every fallback-free token resolves and the focus-shadow token cannot be used as a color. Scoped popup/calendar/menu/autocomplete/collection Stylelint checkpoints pass. |
| Interactive-title/blocked-action boundary | `pnpm audit:interactive-titles` parses production TSX and reports every intrinsic interactive title, owner, line, expression, and potentially disabled control. A fixture-proved exact per-owner budget rejects additions, transfers, and stale counts. Remediation remains active; source completion is not claimed while essential hover-only information remains. |
| Function-quality boundary | New shared hooks and migrated composite owners pass the default 300-line/complexity-50 policy; obsolete owner ratchets are removed as decomposition waves settle. The global checker, not a local exception claim, is the final source gate. |
| Application/renderer TypeScript and production build | Passed at the latest overlay/composite reconciliation checkpoint; must be rerun on the final immutable source tree. |
| Signed/browser/AT layer qualification | Not yet executed; explicit release evidence gate. |
