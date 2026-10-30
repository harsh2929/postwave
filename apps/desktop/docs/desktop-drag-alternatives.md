# Desktop drag-and-drop alternative contract

Status: source implemented; DUX-026 awaits installed qualification

Owner: desktop design system and each drag-task owner

Last reconciled: 2026-07-16

## Authority

`src/lib/desktop-drag-alternatives.ts` is the complete production inventory of
app-owned HTML drag interactions. The contract test recursively discovers
every `onDragStart`, `onDragEnter`, and `onDrop` owner and fails if a new owner
is not assigned to a documented task with source-pinned non-drag evidence.

Drag is always an accelerator. It may not be the only way to import, insert,
reorder, or reschedule, and an instruction such as “drag this” is incomplete
unless the adjacent UI names the alternative.

## Current inventory

| Task                   | Pointer path                    | Complete non-drag path                                    |
| ---------------------- | ------------------------------- | --------------------------------------------------------- |
| Asset-library import   | Drop files anywhere on Assets   | Upload action → native validated picker                   |
| Collection import      | Drop CSV/JSON in the importer   | Native validated picker                                   |
| Migration import       | Drop the migration CSV          | Labelled Choose control → native validated picker         |
| Saved-block insertion  | Drag a block to the HTML caret  | Copy HTML → focus caret → keyboard paste                  |
| Analytics KPI order    | Drag configuration rows         | Named Move up/down buttons                                |
| Campaign reschedule    | Drag campaign to a calendar day | Reschedule button → labelled date form → submit           |
| Dashboard metric order | Drag metric cards               | Named Move earlier/later buttons with position feedback   |
| Saved-segment order    | Drag pinned segments            | Named Move up/down buttons                                |
| Sequence canvas        | Drag palette/trunk/branch steps | Palette Add plus trunk/branch Move earlier/later controls |
| Inbound priority       | Drag routes                     | Move up/down for routes and actions within a route        |

Native image dragging without an app-owned drop handler is not treated as a
product task. No production resize-only task was discovered in this source
checkpoint; pointer inspection of charts is covered by the visualization
contract rather than this reorder contract.

## Interaction requirements

- Alternative controls are always keyboard reachable and have object-specific
  accessible names.
- Move controls disable at the relevant boundary and report the resulting
  position/count through stable text or a polite live region.
- Focus stays on the moved object/control after reorder. Reordering never
  jumps focus to the start of the collection.
- Pointer and non-pointer paths call the same domain mutation and preserve the
  same optimistic, failure, retry, lifecycle, and persistence behavior.
- Permission and busy state disable both paths together.
- A drag preview or drop highlight is supplemental and does not replace target
  labels, instructions, or a visible action.
- File drop and picker paths share extension/MIME/size/count validation and the
  centralized transfer service; drop cannot bypass the picker policy.
- Calendar and sequence alternatives expose an explicit destination, not an
  opaque “move” that requires visual inference.
- Reduced motion removes decorative movement; forced colors retains focus,
  boundaries, pressed/selected state, and named controls.

## Automated evidence

The current checkpoint passes seven tests across two suites:

- recursive source discovery reconciles all 15 production event-owner files
  to ten stable task contracts;
- each task has meaningful pointer/non-drag copy and exact alternative source
  tokens;
- Dashboard controls retain position semantics, focus, and announcements;
- Sequence trunk and branch steps can be inserted/reordered without drag;
- Campaign calendar rescheduling is completable through its date form; and
- audit calendar/heatmap keyboard regressions remain green alongside the
  broader DUX-011 workflow suite.

Scoped ESLint and both desktop TypeScript checkpoints pass. The manifest test
must remain in the broad renderer suite so a future drag handler cannot land
without an accountable alternative.

## Installed qualification boundary

`IMPLEMENTED` is not `VERIFIED`. Run the complete tasks in exact hash-bound
signed macOS and Windows packages with keyboard only, VoiceOver,
Narrator/NVDA, switch/sticky keys, non-US layouts, 200–400% zoom/text scaling,
880×560, forced colors/high contrast, and reduced motion. Verify boundary
disabled states, focus after every move, live announcements, slow/failing
mutations, permission loss, offline/queued results, relaunch persistence, and
equivalence between drop and picker validation.
