# Desktop lifecycle and window contract

Implementation date: 2026-07-16

Findings: DUX-015 (lifecycle coordination) and DUX-036 (window/menu/tray)

Moosewave now has one listener-first renderer/native lifecycle path. Native
window close, menu/tray quit, unapproved process exit, sign-out, workspace
switch, updater restart, and typed in-app destination changes all route through
the same fail-closed registry in `src/lib/lifecycle-coordinator.ts`. The native
side retains an intent until the renderer reports that every listener is
installed, so a close or quit during startup cannot race credential hydration.

This source contract materially implements DUX-036. DUX-015 remains in progress
because the static owner audit found a substantial long tail of unregistered
drafts and sensitive operations. The exact backlog is maintained in
[`desktop-lifecycle-owner-inventory.md`](desktop-lifecycle-owner-inventory.md).

## Transition model

Every transition has both an entry-point `kind` and a physical `disposition`:

| Kind               | Disposition       | Consequence                                                            |
| ------------------ | ----------------- | ---------------------------------------------------------------------- |
| `route-change`     | `navigate`        | Keep the current surface mounted until route-scoped work is resolved.  |
| `close-window`     | `hide` or `exit`  | Hide keeps the renderer/process alive; exit stops it.                  |
| `quit-app`         | `exit`            | Stop the desktop process.                                              |
| `sign-out`         | `identity-change` | Purge the selected identity only after review.                         |
| `workspace-switch` | `identity-change` | Park/flush old identity state before switching.                        |
| `update-restart`   | `restart`         | Flush/review, revalidate, approve exit, then relaunch.                 |
| `os-shutdown`      | `exit`            | Perform a bounded fail-closed inspection/flush before the OS deadline. |

Owners can treat `hide` as safe because the process and local state remain
alive. They must not infer that all `close-window` intents exit.

Programmatic navigation, deep links, section/resource helpers, route-backed
tabs, and browser Back/Forward share the `route-change` intent. Routes without
an applicable owner retain synchronous navigation. When an owner is active,
the current screen remains mounted during review. New history entries carry a
monotonic position: Back/Forward first returns to the protected entry, then
resumes the exact original target and scroll state only after approval. Cancel
leaves the user at the original history position. Legacy pre-index entries use
a safe replacement fallback. A second route request cannot replace an open
lifecycle decision.

The encrypted outbox and centralized transfers are process-owned: both survive
ordinary navigation and participate only when the process or identity can
change. Surface-local selected files, drafts, debounce buffers, and active
operations remain route-scoped owners.

The coordinator:

- inspects applicable owners concurrently in deterministic registration order;
- converts inspection failures and OS-shutdown timeouts into blockers;
- exposes save, recover, and discard only when the owner implements them;
- re-inspects before every action and again immediately before proceeding;
- invalidates a reviewed decision when active work changes;
- allows only one route/process/identity transition at a time;
- contains failed owner and native actions in the decision dialog; and
- defaults focus to Cancel, disables backdrop dismissal, and never offers the
  final action while any blocking concern remains.

For OS shutdown, each owner inspection has a 500 ms ceiling and the combined
prepare phase has a 1.5 s ceiling. These are safety bounds, not a guarantee that
the operating system will wait. Unique work therefore needs continuous durable
journaling rather than a last-second-only save.

## Native mediation

`src-tauri/src/window_lifecycle.rs` owns retained native intent state. The main
window's close event is prevented before `lifecycle:close-requested` is emitted.
Custom menu/tray Quit and an unapproved Tauri exit are also intercepted. Only
the reviewed renderer path invokes the guarded native quit/restart command,
which marks the exit approved before termination.

All lifecycle IPC commands require the trusted bundled main window. Window
titles are trimmed, bounded to 160 characters, reject control characters, and
menu context accepts only an allowlisted non-sensitive route class.

An OS-shutdown request writes a payload-free one-shot marker to a private
app-local `lifecycle` directory before renderer notification. Normal approved
exit removes it. If the OS terminates Moosewave first, the next launch presents
an interrupted-shutdown recovery dialog and retains the marker until the user
acknowledges that recovery. The marker does not contain draft, identity, route,
or credential data.

## Close preference

The first native close opens an undismissable education decision with Cancel
initially focused. The choices are:

- **Keep running in the tray**: hide the window while sync, transfers, and
  server monitoring continue. Recommended on macOS.
- **Quit Moosewave**: inspect lifecycle owners and stop the process only after a
  safe decision. Recommended on Windows and unknown platforms.

The preference is persisted as `ask`, `hide`, or `quit` in renderer local
storage and can be changed from Desktop Settings. Storage refusal keeps the
choice for the current process without inventing persistence. Cancelling close
explicitly clears the retained native intent.

## Window, title, menu, tray, and hidden lifecycle

- The route-first native title is `<route> — Moosewave`; a leading `●` appears
  while the lifecycle registry reports unresolved work.
- Tauri's window-state plugin restores position, size, maximized state, and
  full-screen state. The configured default/minimum window geometry remains the
  authoritative supported bound.
- Navigation and compose menu/tray items start disabled and become enabled only
  after authenticated role/capability context resolves. The already-active
  Dashboard, Approvals, or Settings destination is disabled in the native menu.
- Close (`Cmd/Ctrl+W`) and Quit (`Cmd/Ctrl+Q`) remain native and available
  before hydration, but both route through retained lifecycle mediation.
- macOS primary-click follows menu-bar-extra convention and opens the tray menu.
  Windows notification-area primary-click reveals/unminimizes/focuses Moosewave;
  the context menu keeps an explicit Open command.
- Opening a route/action from the tray reveals and focuses the main window.
  macOS application Reopen restores a hidden window. Hidden operation does not
  discard owners or stop server monitoring.
- Menu/tray Sign out uses the same lifecycle registry; it does not bypass the
  outbox's explicit purge boundary.

## Registered owner contract

An owner registers only while it has active or recoverable work. Its stable ID
must be globally unique. `inspect` returns `null`, a warning, or a blocker.
Inspection errors are redacted and fail closed.

If two applicable instances nevertheless register the same public ID, the
registry retains both and reports a non-actionable blocking collision until one
unmounts. It never shadows an owner or throws from the registering React effect.

Optional owner actions are:

- `prepare`: save, flush, or await durable state;
- `discard`: explicitly abandon recoverable state;
- `recover`: reopen or repair retained work; and
- `kinds`: restrict the transitions the owner participates in.

One-time credentials use a stricter contract: block destructive transitions
while plaintext is visible, expose no automatic save/discard/recover action,
and allow hide because the process remains alive.

Implemented source coverage includes the encrypted outbox, active transfers,
campaign creation/detail/composition/translations, subscriber and suppression
imports, assets, migrations, Collections, Forms, Templates, Tags, SMS
reply/broadcast, API Playground, sequence editors/canvas, dashboard layout,
subscriber view preferences, queued mutation editing, AI template generation,
audience sync, zero-copy trigger editing, four shown-once credential surfaces,
gift redemption and podcast feed secrets, live audit-portal sessions, three
Settings editors, conversion tracking-key drafts/operations/plaintext, and
inbound/outbound-webhook drafts/operations/plaintext, and active campaign
sends, plus add-workspace credential drafts/keychain operations. The owner
contract also covers first-run API credentials, connection tests, secure save,
all nine native managed-provider credential dialogs, and the commerce store
connector. Inbound-email routes add store/copy/abandon handling for the
one-time endpoint secret, explicit abandon-before-rotation, exact
name/matcher/action/HMAC draft comparison, local close/tab discard, zeroizing
HMAC success/discard, discard-only preview input, and persistent single-flight
guards for toggle/reorder/duplicate/rotation even after page unmount. Their
global owners expose no prepare callback, so lifecycle Save cannot create,
update, rotate, duplicate, or preview. Provider drafts are instance-scoped,
never journal plaintext, retain retry state after contained failures, allow
hide, and require explicit discard before local close or provider replacement.
Connection commit and subsequent list refresh are treated separately, so a
refresh failure cannot mislabel a successful create or invite a duplicate
retry. The owner inventory also covers every Audit Sinks
configuration/credential field, create/test,
update/credential rotation, signing-key rotation, detail action, and deletion.
These mixed drafts are intentionally discard-only because no compatible
encrypted recovery service exists; global lifecycle Save cannot auto-run a
test, create, update, or rotation. Deliverability-provider and BYOK drafts now
use instance-scoped zeroizing discard plus single-flight operation blockers;
generated receiver tokens require copied/stored acknowledgement before their
one-way server digest replaces plaintext, and mirror credentials resolve only
through tenant-bound runtime-secret names; the complete boundary is documented
in [`deliverability-provider-security.md`](deliverability-provider-security.md).
AI regression settings expose an
awaitable coalesced queue with last-acknowledged discard while replay/golden
drafts remain explicitly discard-only and never auto-submit from global Save.
The complete audited Settings/governance subsection is now source-owned:
approval escalation/delegations, firewall, approval chain, archive domain,
custom-field limits, export selection/retention, feature flags, identifier
transforms, goal create/edit/delete, preference-center theme, and privacy
regions. Existing settings prepare through the exact validated save request and
discard to their last acknowledged baseline; create/action forms have no
prepare callback and therefore cannot auto-submit. All mutation paths use
same-tick single flight, contain thrown/rejected requests, retain retryable
drafts, release in `finally`, and prevent destructive local dismissal while
active. The process-level operation guard outlives a React unmount until the
exact promise settles. Instance identity comes from the mounted owner, so two
copies do not collide in the renderer-global registry.

The campaign/content lifecycle wave adds discard-only owners for campaign
feedback, schedule/PSTO, calendar rescheduling, locale translation, UTM
templates and preview, template/saved-block creation, sequence creation and AI
drafting, and archive publishing. Existing archive SEO and referral-program
editing use acknowledged baselines and deterministic save/discard; a new
referral program remains discard-only. Exact request guards register
imperatively before work begins and survive surface unmount until their promise
settles. Commit and refresh are separate boundaries, so a successful create
cannot be presented as a retryable form after only its follow-up refresh fails.
This wave intentionally leaves Template detail, campaign AI/body translation,
and sequence step/settings/trigger/canvas state with their existing owners.

The owner inventory defines the remaining release-blocking surface; this
paragraph is not a completeness claim.

## Automated evidence

The route-lifecycle checkpoint passes 48/48 cases across four focused suites.
Behavior tests cover blocking discard, cancel-without-navigation, automatic
prepare for a safe owner, process-owner exclusion, exact indexed Back rollback,
approval/resume with scroll restoration, and cancelled Back without history
loss. Source contracts pin every public typed helper, the singleton history
gate, the `route-change`/`navigate` intent, indexed rollback, and the explicit
outbox/transfer boundary. This is renderer source evidence, not signed
WebView/WebView2 or operating-system navigation qualification.

The native-provider/commerce-store wave passes eleven focused tests across three
suites:

- five native-provider dialog tests cover contained registry-load failure,
  labelled fields, trimmed submission, hide/destructive-close behavior,
  explicit discard, thrown-request retention, successful clearing, and
  same-tick single flight;
- four commerce-store dialog tests cover contained registry-load failure,
  explicit local/provider-switch discard, post-commit refresh separation,
  thrown OAuth retention, active-close blocking, clearing, and same-tick single
  flight; and
- two source-contract tests prove all nine native dialogs and the commerce
  dialog use the instance-scoped lifecycle owner, no plaintext logging path,
  explicit discard UI, and `finally`-released operations.

The broader renderer lifecycle aggregate moves as other owner waves land; its
revision-specific count belongs in the implementation ledger rather than being
inferred from this provider checkpoint.

The Audit Sinks wave adds nine behavior tests plus one source-contract case.
They pin the exact seven-destination config/credential field classification,
hide versus destructive transitions, explicit local discard before close,
destination switch or rotation abandonment, same-tick single flight, retained
retry state after thrown create/test/update requests, credential clearing,
signing-key confirmation, and `finally`-released operations. The reconciled
lifecycle/modal checkpoint passes 54/54 tests across ten suites. Renderer
TypeScript and scoped zero-warning ESLint pass; the touched page and extracted
primitive remain within source-size and 300-line-function limits. The global
source-size gate is separately red on concurrent, untouched growth in
`src/lib/api-client.ts` and `ImportSubscribersWizard.tsx` and is not evidence
against this owner wave.

The deliverability/BYOK checkpoint adds fifteen pure provider-configuration
tests, five lifecycle behavior tests, and two focused source-contract cases.
The API `webhooks` and `suppressions` packages prove sparse-secret preservation,
legacy migration, webhook-token digest verification, raw-credential rejection,
runtime-secret parsing, tenant binding, legacy/env compatibility, and provider
client behavior; the complete API `go test ./...` suite passes. The AI
regression suite passes ten renderer cases plus its source contract, including
overlapping queue serialization, lifecycle drain waiting, failed-save discard,
post-unmount queue completion, and proof that replay/golden drafts are never
submitted by lifecycle preparation. Scoped zero-warning ESLint and the full
desktop TypeScript build pass on the reconciled tree.

The inbound-routes checkpoint passes 20 focused cases across three suites:
nine controller behaviors cover overlapping reloads, all table/endpoint
mutations, same-tick suppression, hide-versus-exit, post-unmount guard lifetime,
contained thrown promises with retry, missing-secret fail-closed handling, and
credential-free duplication; eight rendered behaviors cover exact draft
fingerprints, stored-secret non-prefill, local/global discard, no automatic
mutation from lifecycle Save, HMAC preservation/replacement/zeroization,
retry retention, endpoint acknowledgement/abandon-before-rotation, and preview
ownership; three source contracts pin no plaintext journal/log path,
instance-safe guards, and `finally` release. This checkpoint is source evidence
only. The legacy route-list API still returns stored action HMAC material and
remains a non-production backend boundary in the owner inventory. Typed
destination changes now use the same lifecycle registry; exact signed-package
history, deep-link, keyboard, and assistive-technology qualification remains
outside this source checkpoint.

The Settings/governance checkpoint passes 40/40 focused tests across nine
suites. Five reusable-hook behaviors prove hide safety, deterministic
prepare/discard, retained failed drafts, no action-form auto-submit,
instance-safe collision handling, same-tick single flight, and exact promise
completion after unmount. Six source-contract cases pin every listed owner.
Twenty-nine rendered/controller cases exercise all twelve inventory entries,
including successful acknowledgement, thrown/rejected retry retention,
operation blocking, explicit local discard, and create-versus-edit semantics.
An additional 78/78 relevant settings regression tests across eight suites
pass. Scoped production/test ESLint is warning-free. Full app and renderer-test
TypeScript both passed after the deterministic `Promise<boolean>` prepare
contract was reconciled; the moving shared tree requires the normal final
rerun. Every newly enlarged owner is back within the default 300-line function
limit, and the Archive domain legacy ratchet improved from 502 to 496. The
global source-size gate remains separately red on untouched/concurrent
`api-client.ts`, `InboundRoutes.tsx`, and `ImportSubscribersWizard.tsx` growth;
the broader function-quality gate likewise reports unrelated shared-tree
ratchet drift. Neither is hidden or treated as proof for this wave.

The campaign/content checkpoint passes 41/41 focused cases across nine suites,
with another 6/6 referral-program controller regressions passing separately.
They cover exact post-unmount operation lifetime, hide versus destructive
transitions, explicit local discard, no action/create auto-submit from global
Save, acknowledged existing-setting baselines, same-tick single flight, thrown
request containment, retained retry state, successful commit clearing, and
owner-boundary non-overlap. Scoped production/test ESLint and renderer-test
TypeScript pass. The page extraction keeps every new function within the
default 300-line limit; legacy ratchets improve from 623 to 559 for Sequences
and from 922 to 920 for Templates, whose page is now 1,604 lines. The global
function-quality and source-size checks report only concurrent/untouched
shared-tree failures, not a file in this wave. Full app and renderer-test
TypeScript pass on the reconciled tree; both must still be rerun on the final
release revision.

The bounded audit/compliance/data-governance checkpoint passes 127/127 focused
cases across 21 suites. New behavior proof covers masked audit-channel secrets
with accessible reveal, no credential-bearing draft serialization, explicit
operator/channel/provider/destination replacement, a generation-bound export
poller that cannot start after unmount, discard-only attestation and alert
drafts, same-tick single flight, failed-request retry retention, framework
identity, and an accepted operation whose process guard survives React
unmount. The source
contract pins every owner in this wave, create/action versus acknowledged-edit
semantics, shared validation operations, capability reporters, and adjacent
residual inventory. Full renderer TypeScript and scoped zero-warning ESLint
pass. Function maxima improve without a new exception: AuditEvent slideover
548→446 with its complexity exception removed, Warehouse 381→373, and Audit
Investigation 440→369. The repository-wide function gate remains red on
concurrent files outside this bounded wave; its exact diagnostics are not
hidden or treated as proof of completion.

The reconciled native checkpoint is 64/64 Rust tests across the whole shell. Six
source-contract tests in `window_lifecycle.rs` pin retained snapshot naming,
trusted title/context validation, close/exit mediation, window-state/geometry
configuration, and tray/menu conventions. Rust formatting, locked Cargo check,
all-target/all-feature Clippy with warnings denied, and the release dependency
gate pass at that checkpoint.

These tests prove source behavior only. The renderer typecheck/lint/full-suite
evidence must be re-run after every owner wave and tied to the immutable release
revision; current results are recorded in the implementation ledger.

## Required signed-package matrix

DUX-036 may move from `IMPLEMENTED` to `VERIFIED`, and DUX-015 may move from
source-complete to `VERIFIED`, only after the following is run against hash-bound
signed macOS Intel/Apple Silicon and Windows/WebView2 artifacts.

| Area                    | Required cases                                                                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Close/quit entry points | Title-bar red control, `Cmd+W`, `Cmd+Q`, Dock Quit, macOS app menu, Windows close button, `Alt+F4`, native File/Window menu, tray Quit, and OS logoff/shutdown.                                                                                    |
| Close preference        | First close, Cancel, choose hide, choose quit, persistence across relaunch/update, Settings change, and locked/failed local preference storage.                                                                                                    |
| Hidden/reopen           | Dock/taskbar/app icon, tray Open, macOS Reopen, second-instance/deep-link/notification activation, minimized/full-screen/hidden combinations, and focus-stealing policy.                                                                           |
| Active-work matrix      | Every registered owner in safe, warning, blocking, save, discard, recovery, changed-after-review, failed-action, and hung-inspection states. Repeat for close, quit, sign-out, workspace switch, update restart, and OS shutdown where applicable. |
| Forced termination      | Renderer crash, native panic, process kill, force quit/task kill, OS deadline termination, power loss, and crash during journal/transfer/update flush; verify one-shot recovery and no false completion.                                           |
| Geometry/display        | Clean launch, relaunch, maximize/full screen, display disconnect/reconnect, mixed DPI, scaling, orientation, work-area changes, off-screen recovery, 880×560 minimum, and multi-monitor placement.                                                 |
| Menu/tray state         | Anonymous, hydrating, role denied, authenticated read-only/write-capable, active destination, sign-out, workspace switch, hidden, update-ready, and failed global-shortcut states.                                                                 |
| Time/system state       | Sleep/wake during each transition, rapid repeated close/quit, clock jumps, OS vault locked/unlocked, disk full/quota/permission refusal, and concurrent update/transfer/replay.                                                                    |
| Accessibility           | Full keyboard-only completion, VoiceOver and Narrator announcements/focus, 200–400% zoom/text scale, high contrast/forced colors, reduced motion, and no inaccessible tray/menu-only action.                                                       |
| Privacy/security        | No secrets/identities in title, native events, marker, logs, or diagnostics; IPC rejection from untrusted windows; marker permissions and cleanup; clipboard-history behavior for shown-once values.                                               |

Each result must record artifact hash, version, OS/build, architecture, display
setup, operator, timestamp, exact fixture/owner, result, evidence link, and defect
ID. A unit test, development build, or unsigned local binary cannot substitute
for this matrix.

## Current release boundary

- DUX-036: `IMPLEMENTED`, not `VERIFIED`; exact signed native qualification
  remains.
- DUX-015: `IN PROGRESS`; native coordination and many high-value owners are
  implemented, but the durable owner inventory still contains release-blocking
  gaps. No production-ready claim is permitted until that inventory is empty
  and the signed matrix passes.
