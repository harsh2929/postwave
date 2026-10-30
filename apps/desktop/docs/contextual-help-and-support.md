# Contextual help and support handoff

Implementation date: 2026-07-16

Status: DUX-042 is source-implemented. Signed macOS/Windows, assistive-
technology, real support-portal, and task-usability qualification remains
external evidence.

## Outcome

The shell help shortcut and floating Help control now open one non-modal,
screen-specific help surface. It freezes the safe destination at launch, shows
local self-service guidance before support, preserves the onboarding/tour and
shortcut controls, and sends only allowlisted structural context when the user
explicitly copies context or opens Support.

The panel can move left or right. At workstation widths of 1,500px and above,
the shell reserves a matching rail so help remains beside the task instead of
covering it. At compact widths it is a bounded, movable, dismissible non-modal
overlay because reserving 390px would make the task less usable. It has no
scrim, does not inert the product, and closes for modal, lifecycle, critical,
hidden-window, onboarding, or active-tour blockers.

## Privacy boundary

`src/lib/contextual-help.ts` is the only support-context composer. Its request
schema accepts only:

- an enumerated task class;
- a bounded structural error code that rejects credential-related names; and
- a generated `PW-…` incident identifier.

The snapshot derives only the canonical destination enum/title, capability ID,
domain, readiness, public limitation/recovery destination, connectivity reason,
task class, structural code, and incident ID. It never accepts or derives a
resource ID, email, route URL, query, filter, overlay payload, workspace/user
identity, customer content, request/response body, free-form error message,
stack, cookie, credential, or secret.

The support URL contains the same fixed fields as query parameters on the
trusted HTTPS support base. Hashes are removed; HTTP and credential-bearing
URLs fail closed. The copied report uses the centralized clipboard service with
an explicit `personal` classification. Context is process-memory-only and is
cleared when the panel closes; no local/session storage or IndexedDB journal is
used.

## Self-service model

All declared desktop destinations resolve through the capability registry to
one of nine task domains. Each domain owns a concise local guide with a purpose
and three ordered checks. The panel additionally inserts:

- a reason-specific connectivity recovery step when the API is not online;
- the canonical readiness limitation and typed recovery destination for
  mixed/read-only/conditional/preview capabilities;
- guarded Documentation;
- Take/Restart tour;
- role-eligible Restart setup; and
- registry-derived keyboard shortcuts.

Only after those controls does the panel show Copy support context and Contact
support. Failed clipboard/external actions render bounded generic feedback and
never interpolate the underlying exception.

Fatal renderer recovery and the root native-crash/Safe Mode notice use the same
context composer. They include the last canonical destination, current
connectivity reason, a fixed recovery task/error class, and a validated incident
ID without requiring the ordinary Help panel to remain mounted.

## Interaction and accessibility contract

- The trigger exposes `aria-expanded`, `aria-controls`, `aria-haspopup`, and
  the remappable shortcut from the shared shortcut registry.
- The panel is a labelled non-modal `dialog`, not a menu containing non-menu
  content.
- Opening focuses the first self-service action. Tab remains native; optional
  Up/Down/Home/End traversal covers enabled actions; Escape closes and returns
  focus to the trigger.
- Pointer-down outside dismisses without trapping focus. An explicit Close
  button and Move left/right alternative are always available.
- The scroll owner is bounded, uses stable scrollbar space and contained
  overscroll, adapts at 520px/560px, and retains forced-color borders.
- The existing reduced-motion contract removes launcher/panel animation.
- Static availability/connectivity copy is not a live region. Only the result
  of an explicit copy/open action uses one polite status owner.

## Automated evidence

The focused DUX-042 checkpoint passes 24/24 cases across eight suites:

- exhaustive context/guide construction for every declared desktop section;
- malicious request-field, secret-code, incident-ID, endpoint, and route-payload
  rejection;
- self-service ordering and connectivity/readiness recovery;
- support URL and clipboard classification/content;
- rendered copy/open/recovery/failure behavior;
- launcher focus, arrows, Escape return, tour/setup handoff, and blocker close;
- fatal recovery integration;
- reason-specific Offline Banner handoff with critical persistence failures
  retained on their dedicated Sync journal path; and
- source contracts for privacy fields, non-persistence, dialog semantics,
  self-service order, movable placement, and recovery callers.

Scoped ESLint, default function/complexity rules, Stylelint, app TypeScript,
renderer-test TypeScript, and the four-case stylesheet-entry contract pass on
the reconciled source checkpoint.

## Extension rules

1. Never add free-form text to `ContextualHelpRequest`.
2. New task/error types must be finite enums or structural codes and must pass
   the sensitive-name rejection test.
3. Never attach serialized `DesktopRoute`, `window.location`, API errors,
   diagnostics messages, identities, record IDs, or form data.
4. Add self-service to the relevant domain guide or capability limitation
   before adding another support CTA.
5. Support callers must use `buildContextualSupportUrl`; direct support URL
   opens are not an equivalent handoff.
6. A new support destination must remain trusted HTTPS and complete installed
   privacy/redirect/failure qualification before release.

## Remaining qualification

Before DUX-042 becomes `VERIFIED`, exercise the exact signed macOS and Windows
artifacts with VoiceOver and Narrator at supported scaling, 200–400% zoom/text
scale, forced colors, reduced motion, keyboard-only and switch-style input.
Validate small/large/mixed-DPI placement, focus return, long localized copy,
offline/captive-portal/proxy/TLS failures, denied clipboard/default-browser
permissions, support redirect/auth/cookie policy, stale/invalid incident codes,
and a real end-to-end support case proving the portal receives only the documented
structural fields. Representative novices and experts must also complete common
self-service tasks without coaching and find Contact support without the panel
covering the task they are describing.
