# Desktop toast and notice contract

## Outcome

The desktop renderer has one bounded toast host and an explicit severity
contract. Ordinary notices remain ephemeral and synchronous. A critical
failure is a separate, catalogued API whose unresolved state survives a
renderer restart without writing user-provided or server-provided copy to
local storage.

This system is supplemental feedback. The action point, form, job row,
transfer, sync journal, or other owning surface must still preserve its own
truthful state and recovery action. A toast must never turn an unverified
response into success, empty, or “all clear” UI.

## Severity and lifetime

| API | Use | Default lifetime | Durable |
| --- | --- | --- | --- |
| `toast.success` | Server-confirmed or otherwise completed outcome | 3.5 s | No |
| `toast.info` | Neutral status, queued state, or useful context | 3.5 s; 6 s with an action | No |
| `toast.error` | Recoverable operation failure whose owning surface remains available | 8 s | No |
| `toast.soon` | Preview/coming-soon disclosure only | 3.5 s | No |
| `toast.progress` | One in-place long-running operation | Caller-owned until `done`/`dismiss` | No |
| `toast.critical(code)` | Loss-of-recovery or comparable device-level failure with no continuously visible owner | Until resolved/dismissed | Code-only journal, up to 30 days |

Arbitrary callers cannot request persistence: `ToastInput` exposes no sticky
flag, non-positive/invalid durations fall back to the severity default, and
the progress handle owns its process-local lifetime. The source contract also
rejects literal `persistent: true` or `duration: 0` bypass attempts; reload
persistence requires a reviewed critical catalog code.

## Critical persistence and privacy boundary

The catalog is
`src/lib/toast-critical-notice-catalog.json`. The persisted envelope is
bounded to three unique entries and contains only:

```json
{
  "version": 1,
  "notices": [
    {
      "code": "campaign-draft-recovery-unavailable",
      "raisedAt": 1784203200000
    }
  ]
}
```

The journal never stores message/detail text, route state, query text,
resource IDs, tenant/user IDs, file paths, server errors, action callbacks,
or secrets. On hydration it accepts only known catalog codes, safe integer
timestamps, a five-minute future-clock tolerance, and entries no older than
30 days. Unknown, corrupt, duplicate, stale, and oversized-by-count data is
discarded and rewritten to the sanitized form. A denied/full local store does
not suppress the in-process critical notice.

The catalog/store module is not part of the cold renderer graph. `ToastHost`
loads it after mount for hydration, and `toast.critical`/`resolveCritical`
load it on first use. Critical operations are serialized so raise followed
immediately by resolve cannot resurrect stale state. Ordinary toast methods
do not cross this asynchronous boundary.

Current-source direct Vite/bundle evidence keeps the controller/catalog/store
in a deferred chunk: the aggregate critical graph is 662,765 raw / 188,290
gzip and the total graph is 4,911,508 raw / 1,390,070 gzip. The aggregate
`pnpm build` wrapper still awaits an unrelated migration-test TypeScript
reconciliation; these direct numbers are not presented as an immutable signed
release-artifact qualification.

Dismissal removes the durable code. The owning subsystem must also call
`toast.resolveCritical(code)` only after it has positively verified recovery.
For campaign draft recovery, a failed encrypted journal write raises the
catalogued notice once; a later durable write, explicit discard, or confirmed
campaign creation resolves it.

## Interaction and accessibility rules

- At most three notices are visible. Eviction prefers non-error transient
  notices, then transient errors, then the oldest persistent notice.
- Stable IDs and content identity update one row instead of stacking copies.
  Repeating identical semantic content does not emit another host update or
  live announcement; a changed title/detail is a new announcement.
- Errors/critical failures use one `role="alert"` owner per notice. Other
  notices use `role="status"`. The host is not another live region, avoiding
  nested duplicate announcements.
- Every notice has a specifically named dismiss button. A notice with focus,
  pointer hover, or a hidden document pauses its remaining timer.
- Rejected action callbacks are contained, never surface exception text, and
  convert the same notice into a generic retryable error.
- Kind-specific icons accompany color so severity is not color-only.
- Error telemetry contains a fixed error/catalog code and the typed route's
  section only. It never sends toast copy, resource IDs, query/filter state,
  or server error text.

VoiceOver/Narrator behavior, announcement timing under the exact production
WebViews, forced-colors rendering, zoom/text-scale behavior, and signed
macOS/Windows installed-package evidence remain external qualification. They
must be completed before DUX-027 is marked `VERIFIED`.

## Production caller classification

Run the reproducible source contract from `apps/desktop`:

```sh
pnpm check:toast-contract
```

The 2026-07-16 checkpoint scanned every production `.ts`/`.tsx` module under
`src` (excluding tests and stories): 1,353 direct calls across 270 modules —
517 success, 746 error, 84 info, zero soon, zero progress, one critical, and
five critical-resolution calls.

The TypeScript-AST contract follows the imported `toast` binding even when
the import is renamed. It fails on:

- unknown methods;
- aliasing, destructuring, or passing a method around, which would hide its
  severity from the inventory;
- arbitrary `persistent: true` copy or a `duration: 0` bypass;
- dynamic/unknown critical codes, extra critical arguments, or codes missing
  from the catalog; and
- malformed, control-bearing, untrimmed, overlong, or extra-field catalog
  copy.

The persistence-risk disposition is intentionally narrower than “every
error is critical”:

| Failure | Owner | Toast disposition |
| --- | --- | --- |
| Campaign draft encrypted recovery write cannot be verified | Draft lifecycle guard plus catalogued durable notice | `critical`; resolve only on verified write/discard/creation |
| Offline outbox journal failure | Persistent global offline banner, lifecycle blocker, and Sync journal detail | No duplicate critical toast/live announcement |
| Secure credential storage unavailable at boot | Full-page blocking recovery surface | No toast |
| Notification Center persistence failure | Notification Center and Desktop Notification Settings inline notices | No duplicate toast |
| Ordinary mutation/request failure | Form, row, panel, or job remains the primary recovery surface | Ephemeral `error` when supplemental feedback helps |

This table prevents both under-classification (losing a draft-recovery warning
on reload) and over-classification (turning every network error into a sticky
alarm or announcing the same critical failure twice).

## Adding a critical code

1. Confirm there is a genuine cross-navigation/reload recovery risk and no
   continuously visible owning surface already announcing it.
2. Add fixed generic copy to the catalog. Do not include a resource name,
   person, address, tenant, path, server response, count, or secret.
3. Raise the literal code only on transition into failure; do not raise on
   every retry loop.
4. Resolve the same literal code only after a positive health/write result or
   an explicit discard that removes the risk.
5. Add focused persistence, hydration, dismissal, dedupe, and recovery tests.
6. Run `pnpm check:toast-contract`, focused Vitest, scoped ESLint, TypeScript,
   the optimized bundle/graph gates, and the installed assistive-technology
   matrix.
