# Desktop notification contract

Moosewave treats an operating-system notification as an optional projection of
an in-app event, never as the event's source of truth. Actionable events are
first admitted to encrypted Notification Center history and are then evaluated
for optional OS delivery.

## Trust and privacy invariants

- Notification history is encrypted through the desktop secure vault, scoped
  to the active user and tenant, capped at 200 entries, and pruned after 90
  days. Sign-out purges the vault and its key.
- Lock-screen title/body copy is generic. It must not contain campaign names or
  subjects, subscriber addresses, requester names, metric names or values,
  audience totals, tenant names, or raw backend errors.
- Deep links are accepted only when the shared route-map parser validates the
  entity and resource ID and the entity matches the notification category.
  Invalid or mismatched targets fall back to the category landing page.
- Native activation receives only the center row's exact 16-hex opaque ID.
  Native memory, the cold-start queue, and OS callbacks never receive a tenant,
  email address, domain resource ID, or deep link. The renderer resolves that
  ID only against the currently decrypted identity; clicks on stale alerts
  from another account focus Moosewave but cannot route into either account.
- Background delivery never requests browser permission. The only permission
  request is the explicit **Enable desktop alerts** / **Send test alert** action
  in Settings.
- Failed OS delivery is not recorded as success. The center entry remains, and
  event-level delivery dedupe remains retryable. Concurrent copies reserve the
  same delivery identity so only one OS alert can be emitted.
- Read, mark-all-read, archive, and restore update one model. The TopBar badge,
  panel summary, and native tray/dock badge all consume its unread count.

## Delivery policy

New accounts start with OS alerts off. Users can independently configure:

- approval requested, campaign sent, subscriber bounced, dashboard anomaly,
  and audience milestone topics;
- Notification Center only or OS + center while Moosewave is focused; and
- overnight quiet hours, including an explicit all-day interpretation when
  start and end are equal.

An event suppressed by channel, topic, foreground, or quiet-hour policy is
still retained in Notification Center. A keychain/persistence problem is shown
as a persistent in-app error rather than silently pretending history is safe.

## Native activation boundary

The desktop shell owns `notify-rust` directly rather than using the official
plugin's fire-and-forget wrapper. It retains the platform notification handle
on a blocking worker, focuses/reveals the main window after a non-dismissal
action, emits an opaque activation, and keeps the same ID in a deduplicated
32-entry native queue until the listener-first renderer handshake drains it.
The renderer deduplicates the live-event/queue pair and opens only a matching
entry in the active encrypted center through the typed router. Copy and IDs are
independently validated on both sides of IPC. The unused notification plugin
and renderer package were removed so there is one delivery backend.

This source behavior does not prove every installed OS path. In particular,
Windows activation after the Moosewave process has fully exited depends on the
signed installer's AppUserModelID/toast registration, and the current macOS
backend must be exercised against supported notification-center releases.
Production qualification therefore still requires clean signed packages and
the following artifact-bound matrix:

- warm, hidden-to-tray, minimized, renderer-reload, and cold-process clicks;
- default-body click, explicit **Open Moosewave**, dismissal, repeated click,
  stale-account click, and a center row removed before click;
- permission grant, denial, revocation, Focus/Do Not Disturb, and OS settings
  recovery;
- locked-screen redaction, quiet-hour/timezone/clock boundaries, sleep/wake,
  badge clearing, multi-display focus, and VoiceOver/Narrator announcements.

## Evidence

Forty-nine focused renderer tests across nine files cover encrypted identity
isolation, malformed-state
rejection, retention bounds, dedupe, persistence failures, read/archive flows,
exact/fallback routing, permission prompting, privacy copy, foreground/topic/
quiet-hour policy, badge convergence, concurrent delivery, failure retry,
listener-before-drain ordering, live/queued idempotence, and cross-identity
activation rejection, including proof that domain IDs/deep links never enter
the native payload. Four native unit/source-contract tests cover copy/ID
validation, the bounded queue, and single-backend wiring; the reconciled native
suite passes 64 tests with warning-denying
Clippy, formatting, locked dependency checks, and the release-target dependency
gate. The installed matrix must supplement—not replace—those deterministic
tests.
