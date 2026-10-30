# Mobile widget and share-extension privacy contract

Status: implemented in source on 2026-07-15; signed-device verification is
still required as part of release qualification.

## Product decision

Workspace metrics in the iOS widget are **off by default**. A user must opt in
from Mobile Settings after being shown that the widget sits outside Moosewave's
app lock. Enabling app lock, signing out, or replacing the account revokes the
opt-in. Subscriber totals, open rate, recent sends, pending approvals, and the
workspace display name are the only widget fields.

Opted-in snapshots expire after 15 minutes. The WidgetKit timeline contains an
explicit empty entry at expiry, native reads require exact opt-in/schema/ready
markers, and metric views use SwiftUI `privacySensitive()` so iOS can redact
them in protected previews. A missing, partial, malformed, future-skewed, or
expired record renders a generic hidden/expired state; the next native timeline
load physically removes expired snapshot fields while retaining the user's
opt-in preference.

The share extension is an ephemeral hand-off, not a notes or general content
feature. It accepts only:

- a canonical `moosewave://` entity link;
- a canonical `https://app.moosewave.com/app/...` entity link; or
- one bare email address for subscriber search.

It never retains compose text, arbitrary plain text, generic URLs, URL query
strings, fragments, or v1 records. Queue records expire after 15 minutes, are
limited to 2 KiB each, 8 records, and 12 KiB total, and are revalidated and
rewritten by both the extension and the main app. Failed actions retain their
original creation time, so retry cannot extend retention.

The hand-off remains inside the signed App Group's iOS sandbox and device data
protection boundary; it does not claim application-level encryption. That is
why the allowlist excludes campaign content, notes, arbitrary text, generic
URLs, credentials, query strings, and fragments rather than treating the App
Group as a general cache.

## Cleanup and failure behavior

Widget writes use a privacy tombstone followed by a ready marker. Cleanup first
sets the opt-in and ready markers to false and reloads WidgetKit, then removes
and verifies every field. This keeps residual values non-renderable if physical
deletion needs a retry. Strict cleanup helpers reject on incomplete App Group
deletion so the authentication cleanup journal can report and retry it.

The share inbox verifies deletion of both v2 and legacy keys. Taking an item
commits the pruned queue before returning the action, preventing a failed App
Group write from both processing and retaining the same item.

## Release verification

Before App Store submission, run the automated mobile tests and repeat these
checks on a signed iOS build using a physical locked device:

1. Fresh install and upgrade: widget says **Metrics hidden** and contains no
   workspace values.
2. Opt in: valid metrics appear, locked-device/StandBy previews respect the
   system's widget-preview privacy setting, and the timeline becomes empty at
   15 minutes without reopening the app.
3. Enable app lock, sign out, and switch accounts: the old workspace disappears
   immediately and never flashes for the next account.
4. Background Moosewave: the app-switcher preview remains protected while app
   lock is armed.
5. Share valid/invalid/oversized inputs: only entity links and bare emails can
   be posted; notes, generic URLs, oversized data, expired items, and legacy
   queue data never reach the main app.
6. Simulate App Group write/remove failures: the UI reports failure, widget
   values remain non-renderable, and the next cleanup attempt succeeds.
