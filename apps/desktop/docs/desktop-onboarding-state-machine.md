# Desktop onboarding state machine

Status: source implemented for DUX-034; installed usability qualification remains.

## Outcome

Desktop product education has one typed, versioned state owner. The first-run
wizard, Dashboard checklist, spotlight tour, and Settings quick-tour catalog
retain presentation appropriate to their task, but no longer own independent
completion, skip, dismissal, resume, reset, eligibility, or persistence logic.

The canonical source manifest is
src/lib/onboarding-manifest.ts. The pure transition model is
src/lib/onboarding-state-machine.ts; validation and migration live in
src/lib/onboarding-state-storage.ts; the controller and React binding own
persistence, analytics intent delivery, storage sync, and UI suppression.

## Source inventory

| System | Previous owner/problem | Current presentation | Auto-open policy |
| --- | --- | --- | --- |
| First-run setup | OnboardingWizard used tenant/global dismissal flags plus an independent store mode and three extra probes | Four-step modal wizard | Only a role-applicable workspace with unresolved first-send goals; a persisted in-progress run resumes |
| Setup checklist | useOnboardingProgress used unscoped per-step skip/dismiss keys and a separate tenant cache | Inline Dashboard checklist | Never a modal; visible while applicable and unresolved unless explicitly dismissed |
| Spotlight tour | TourProvider used unscoped completed/dismissed/index keys and scanned every onboarding dismissal key | Target spotlight and tooltip | Only after the wizard is terminal/inapplicable or first-send work is already complete |
| Quick-tour catalog | OnboardingTour was an independent Settings modal with no durable outcome | Manual routed surface catalog | Manual only |

The Settings account-security setup strip is not a fifth persistence system. It
is a read-only projection of current auth/theme facts and has no independent
completion, skip, dismissal, resume, or reset state.

## Persisted contract

The current envelope is version 3:

- storage key: postwave.desktop.onboarding.v3 followed by an opaque scope token;
- scope token: a bounded deterministic hash of workspace plus user identity;
- payload: version, opaque scope token, revision/timestamps, four surface
  records, and a validated five-goal completion snapshot;
- outcomes: not-started, in-progress, completed, skipped, or dismissed;
- surface progress: stable current step ID, completed step IDs, skipped step
  IDs, run count, and timestamps;
- bounds: 32 KiB maximum, exact top-level/record keys, manifest-known step IDs,
  unique/disjoint arrays, bounded counters, safe timestamps, and matching scope.

Workspace IDs, user IDs/emails, route query/resource state, form/task drafts,
API keys, secrets, names, and server error text are never persisted. A denied or
full local store falls back to in-process state without blocking the app.

Every local transition first reconciles the newest validated stored state.
Surface-level timestamps merge concurrent window changes; a browser/Tauri
storage event updates sibling windows without producing analytics.

## Migration and recovery

The loader accepts and rewrites:

- the bounded v2 unified envelope;
- postwave_onboarded;
- global and tenant-suffixed wizard dismissal timestamps;
- tour completion, dismissal, and numeric resume-index keys;
- checklist dismissal and per-step skip keys;
- global and tenant-suffixed onboarding-progress caches.

Only allowlisted status, step, and boolean fields migrate. Unknown fields are
dropped, so an old or malicious task payload cannot enter version 3. Legacy
keys are removed only after the version 3 write succeeds. Malformed,
wrong-scope, oversized, future-version, or payload-bearing current envelopes
reset to a safe empty state.

## Eligibility and transitions

The manifest defines ordered steps and role applicability. The mutating setup
wizard/checklist apply to admin/editor sessions; the read-only tours apply to
all resolved roles. A role change re-evaluates presentation without rewriting
history.

| Action | Result |
| --- | --- |
| Open/start | Starts a new run or resumes the stable current step |
| Complete step | Records completion and advances when a next step is supplied |
| Skip step | Records a distinct skipped step and advances without claiming completion |
| Complete surface | Terminal completed; emits its one completion intent |
| Skip surface | Terminal skipped; resume requires an explicit manual start/reset |
| Dismiss surface | Terminal dismissed; remains distinct from work completion and skip |
| Reset surface/all | Clears education decisions but never falsifies server-proven product goals |
| Server progress sync | Updates only the allowlisted goal snapshot; first hydration is analytics-silent |

Only one modal education policy can win. Auto-open waits while:

- another registered modal or slideover is active;
- lifecycle close, quit, sign-out, workspace, or update review is non-idle;
- a persistent critical error notice is visible;
- the document/window is hidden.

A validated cache may paint the inline checklist and resume an already-started
surface, but it cannot initiate a new modal. Fresh wizard/tour auto-open waits
for a live progress confirmation in the current process and identity scope.

An already-open education surface suspends behind a newer critical/modal review
and resumes afterwards. The inline checklist does not obscure content.

## Routing and task handoff

All onboarding destinations use navigateDesktopRoute. Subscriber import/add
handoff is a validated route overlay named import or create, replacing the
module-singleton task store. The Subscribers controller consumes and clears the
overlay with a route replace after applying role checks. Tour navigation,
checklist CTAs, wizard domain/campaign handoff, completion suggestions, and the
Settings catalog use the same canonical router, history, and identity boundary.

## Analytics

OnboardingAnalyticsIntent is derived from the shared onboarding-schema event
map. A committed local state transition is the only intent producer, and
emitOnboardingAnalyticsIntent is the only emitter. Migration, hydration,
corrupt-state recovery, reset, and cross-window sync are silent.

No-op repeated opens cannot re-emit start/view events. The first server goal
snapshot does not replay historical completions; later observed goal changes
emit goal, completion, and milestone intents once.

## Accessibility and motion

- Wizard and quick-tour catalog have labelled/described dialogs, focus entry,
  focus restoration, focus containment, Escape handling, background isolation,
  progress semantics, and polite step announcements.
- The spotlight tooltip restores trigger focus, contains keyboard focus, keeps
  explicit Back, Next, Skip, and Done actions, and supports Enter, arrows, and
  Escape without stealing keys from editable controls.
- Final-step completion is never timer-driven.
- Reduced-motion users receive no confetti; CSS also removes spotlight,
  tooltip, and wizard transitions.
- The Help launcher supports menu focus, Arrow Up/Down, Home, End, and Escape.
- Education hides rather than competing with a critical error or lifecycle
  review.

## Automated checkpoint

The focused checkpoint currently proves:

- 35 of 35 focused cases across the state-machine, source-contract,
  rendered-surface, existing dashboard-tour, and subscriber-controller suites;
- the reconciled onboarding, shortcut, critical-notice, Dashboard-identity, and
  contextual-Help checkpoint passes 77 of 77 cases across twelve suites;
- scoped zero-warning ESLint across all changed production and focused test
  files;
- scoped complexity at most 50 and function length at most 300;
- full desktop application TypeScript passes;
- renderer-test TypeScript passes.

## Evidence still required before VERIFIED

Source implementation is not installed usability proof. Qualification still
requires:

- signed macOS and Windows runs covering first launch, restart, workspace/user
  switch, role downgrade/upgrade, multiple windows, storage denial, corrupt and
  migrated profiles, offline cache, and lifecycle-review interruption;
- VoiceOver and Narrator/NVDA task recordings for wizard, checklist, spotlight,
  quick catalog, confirmation, focus return, and live-region timing;
- keyboard-only, 200% zoom, 880x560, high-contrast/forced-colors, and reduced
  motion recordings;
- usability sessions validating auto-open timing, skip/dismiss language,
  resume/reset discoverability, and whether adaptive steps match real admin,
  editor, and viewer expectations;
- telemetry observation proving one event per intended transition across
  reload and multi-window sessions without identity or task payload leakage.
