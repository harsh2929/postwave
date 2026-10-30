# Desktop command task intents

Status: bounded DUX-019 wave complete; DUX-019 remains **IN PROGRESS**.

## What changed

The command palette's five task-shaped rows no longer stop at a destination
list. They dispatch one strict, credential-free intent and the destination's
real controller opens the named task:

| Command | Canonical route | Owner | Initial focus |
| --- | --- | --- | --- |
| New campaign | `/app/campaigns?overlay=create` | `useCampaignCreation` / `CampaignCreateOverlays` | Campaign name |
| New form | `/app/forms?overlay=create` | `Forms` create controller | Form name |
| New list | `/app/lists?overlay=create` | List create lifecycle controller | List name |
| New template | `/app/templates?overlay=create` | Template create lifecycle controller | Template name |
| Import subscribers | `/app/subscribers?overlay=import` | Subscriber page controller / import wizard | CSV picker |

`desktop-task-intents.ts` is the only command registry. Its parser accepts
only the exact section + overlay pair and rejects resource ids, tabs, search,
sort, filters, Settings anchors and overlay payloads. No draft, email address,
file name, API key, token or other user/credential material enters history or
identity-scoped route persistence.

## History and close contract

- Launch pushes the task route through the lifecycle-coordinated desktop
  router. Existing work can block or review the destination change.
- Reload/reopen and Forward parse the same bounded route and activate the
  owner once. A repeated render cannot open a duplicate modal.
- Back/Forward is not treated as a local close. It remains under the global
  lifecycle coordinator; after an approved same-page exit, the activation
  bridge closes only the local UI.
- An owner calls `consumeDesktopTaskIntent` only after a confirmed local close
  or successful completion. Consumption removes the overlay with `replace`,
  so Forward cannot resurrect a task the operator explicitly closed.
- Role resolution is fail-closed. Activation waits while the role loads; a
  forged/reloaded write intent for a viewer is explained, not opened, and is
  consumed without carrying a payload.

The narrow explicit-close router primitive intentionally bypasses another
lifecycle scan only for removal of the exact active overlay. Ordinary route
changes, including Back/Forward, cannot use that path.

## Draft and operation safety

- Campaign dismissal verifies the encrypted campaign journal before closing.
  A journal failure leaves the composer open with an actionable form error.
  Submission keeps the route until the server accepts the create, allowing a
  failed request to reopen the same routed draft.
- Forms now require explicit discard for a dirty create draft; active submit
  requests remain blocking lifecycle work.
- Lists retain their shared discard/single-flight controller. Clean close,
  confirmed discard and successful create are the only local consumption
  paths.
- Templates retain their discard-only draft journal and persistent operation
  owner. Confirmed discard or committed create consumes the routed task.
- Subscriber import keeps selected-file/mapping/options work behind explicit
  discard, blocks dismissal during local requests, and treats a server-owned
  running import as recoverable work. Lifecycle-driven route discard does not
  race the browser-history rollback.

All five use the shared Modal focus algorithm, which focuses the first
focusable control in the body. Command-palette cleanup now declines to restore
its old trigger when another dialog owns the stack, preventing it from stealing
focus from the newly opened task.

## Evidence

The bounded checkpoint passes 23 tests across six suites:

- exact five-intent route round trips and payload rejection;
- Back, Forward, reload and explicit-close replacement behavior;
- one-shot activation, delayed role resolution, viewer rejection and
  history-approved route exit;
- actual command-palette dispatch (route, not `setSection`);
- subscriber import owner behavior and exhaustive owner/source/focus
  contracts.

Scoped ESLint, application TypeScript and renderer-test TypeScript pass.
Function quality improved: Import Subscribers tightens 568→554, Forms
679→672, Templates 920→919, Lists remains at 582, and campaign creation is
back under the default 300-line ceiling. The palette's formerly oversized
controller and 321-line item-builder closure are now bounded navigation,
action, record, server-merge and presentation owners; all functions pass the
default 300-line/complexity limits and the legacy 638-line palette exception
has been removed. The refactor preserves 30/30 focused palette/task-intent
cases across five suites.

## Remaining DUX-019 work

This wave does not make DUX-019 complete. Non-navigation actions still need a
general typed async job/progress/result model, offline/retry and broader
permission qualification. Exact installed macOS/Windows keyboard, IME,
VoiceOver/Narrator/NVDA, focus-restoration and minimum-window evidence also
remains external qualification work.
