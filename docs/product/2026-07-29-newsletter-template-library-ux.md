# Newsletter template library: intuitive end-to-end experience

Date: 2026-07-29

## Product promise

Moosewave helps someone move from “I like this design” to a reviewed, editable
newsletter or campaign draft without pretending that an inspiration record is
send-ready source.

The interface and MCP surface use the same mental model:

1. **Discover** a trustworthy reference.
2. **Understand** what is previewable, editable, or restricted.
3. **Organize** candidates with favorites, recents, collections, saved
   searches, and comparison.
4. **Make it mine** as a durable design job.
5. **Review and refine** immutable versions.
6. **Commit** one exact version and hash to My templates or a campaign draft.

No browse, preview, favorite, compare, or generation action sends an email.

## First-run and everyday entry points

The page should open with one calm choice instead of exposing the whole system
at once:

- **Browse inspiration** for someone who wants to look around.
- **Describe what I need** for someone who already has a goal.
- **Use my templates** for someone returning to existing work.

After the first choice, keep the gallery visible and reveal advanced filters,
comparison, and organization tools only when they become relevant. Remember the
last workspace-scoped view for returning users, but offer a visible “Start
fresh” action that clears query, filters, sort, comparison, and selection
without deleting favorites or collections.

A first-run helper may offer to apply an existing brand kit. It must be
skippable, must not block browsing, and must explain that brand values are
copied into a generated design—not written into the inspiration record.

## Small details that make the flow feel lovely

- Use stable card dimensions and softly animated skeletons so filtering never
  causes layout jumps; disable non-essential motion when reduced motion is
  requested.
- Preserve scroll position, the originating card, and keyboard focus when a
  user returns from detail.
- Show active filters as removable plain-language chips and provide one
  predictable “Clear filters” action.
- Prefer capability copy such as “Preview unavailable—design can still be
  adapted” over internal states or unexplained disabled buttons.
- Celebrate only meaningful milestones: one restrained confirmation when a
  design becomes editable, with direct links to the saved template and campaign
  draft. Routine favorites and filter changes should remain quiet.
- Keep generated work visibly autosaved, show “Saved just now” or a recovery
  warning, and never claim recovery if browser/app storage rejected the write.
- In MCP results, end with the same recommended next action the UI shows so a
  user moving between chat and the app does not have to relearn the flow.

## Information architecture

The primary library views should remain easy to explain:

| View           | User question                        | Contents                                 |
| -------------- | ------------------------------------ | ---------------------------------------- |
| Inspiration    | “What could I make?”                 | Approved, adaptation-only references     |
| My templates   | “What can I edit or send from?”      | Workspace-owned editable templates       |
| Favorites      | “What did I save for later?”         | The current user’s private favorites     |
| Recent         | “What was I just looking at?”        | The current user’s bounded view history  |
| Collections    | “How did I group my shortlist?”      | Named, ordered private sets              |
| Saved searches | “Can I rerun this discovery recipe?” | Named filters, never a frozen result set |

Search, filters, sort, active view, and lifecycle state belong in the URL on
web. Desktop should retain them per workspace. Switching workspaces must never
carry private state, pending designs, or selection into another workspace.

## Browse and search

The initial gallery should feel useful before the user types:

- Default to newsletter inspiration with curated/recommended ordering.
- Show a hosted card preview, provider, style/layout, desktop/mobile
  availability, and one plain-language capability label.
- Keep “Make it mine” visually primary for eligible references.
- Keep “Use” primary for editable templates.
- Explain disabled actions next to the action, not in documentation.
- For inspiration browsing and previewing, render only validated
  `preview_assets` under the configured Moosewave asset origin. Keep provider
  asset URLs as inert provenance; never request third-party pixels, fonts,
  scripts, forms, images, CSS URLs, or prefetches from them. Present a source
  page, when useful, only as deliberate external navigation—not embedded
  preview content.

Search should:

- debounce without stealing focus;
- let Escape clear the query;
- show filter suggestions from bounded, ranked server facets, not only the
  loaded page; the tag suggestion list contains at most the top 100 values, but
  typed and saved filters may still use a valid tag outside that list;
- preserve the last verified result set during a refresh failure;
- cancel or ignore late responses after filters change;
- deduplicate cursor/page overlap;
- announce the result count and load state to assistive technology;
- distinguish “no matching results,” “empty personal library,” “not
  authorized,” and “catalog unavailable.”

## Preview and detail

Opening a design should record one recent view only after the server has
verified the template is still visible to that caller.

The detail surface should answer, in this order:

1. What does it look like on desktop and mobile?
2. Is it inspiration or editable source?
3. Where did it come from?
4. What may I do with it?
5. What happens if I click the primary action?

For inspiration, say “visual inspiration” and “Make it mine.” Do not say
“template source available” unless Moosewave holds usable HTML or MJML. If no
hosted preview exists, show a neutral metadata state; never fall back to an
upstream URL in the browser.

Keyboard focus should move to the detail heading on navigation and return to
the originating card on close/back when that card still exists. A mobile
preview must not force horizontal page scrolling.

## Organize and decide

### Favorites

Favorites are private to the authenticated user, including when the caller is
an API key explicitly bound to that user. An unbound or legacy API key must
fail closed rather than reading or mutating another user’s state.

Favoriting should be optimistic with rollback and a concise retry message.
Bulk favorite should report partial success without dropping failed
selections.

### Recent

Recents are ordered by last viewed time and aggregate a view count. Users can:

- remove one entry;
- clear all entries after a lightweight confirmation;
- recover cleanly if the underlying reference was removed or rejected.

Recent history is a convenience, not an audit log.

### Collections

Users can create a named collection from selected designs, add/remove designs,
and reorder the collection. Creation is idempotent. Every later mutation uses
the latest strong entity tag so two tabs cannot silently overwrite each other.

On a version conflict, reload the collection and explain that it changed
elsewhere. Do not blindly retry a stale reorder. If a referenced design becomes
unavailable, omit it from executable/previewable results and show the
collection as partially unavailable.

### Saved searches

A saved search stores only canonical discovery filters and sort intent. It
must not store cursor, page, tenant/user identity, or arbitrary unknown keys.
Running it always searches the current catalog.

Create is idempotent; rename/filter changes and deletion require the latest
entity tag. If a taxonomy value disappears, preserve the saved search but
surface the obsolete filter and offer to remove it.

Every saved-search entity exposes `obsolete_filters` as exact `{field, value}`
pairs. The server derives these from the complete tenant-visible taxonomy,
including tags outside the bounded catalog-facet payload. Cleanup is explicit:
remove or replace the reported values in the full `filters` object, then send
the existing saved-search update with the entity's exact current ETag. The
server never silently broadens a saved query.

### Compare

Comparison accepts two to four unique, currently visible templates. It should
align:

- desktop/mobile preview availability;
- style, layout, industry, and goal;
- editable versus adaptation-only state;
- favorite and collection state;
- provenance and review status.

The compare response preserves the relative requested order of every available
item and reports missing, inaccessible, rejected, or archived selections in
`unavailable_identifiers`, also in exact request order. One unavailable
selection does not discard the rest of the comparison.

The compare tray is keyboard reachable, survives accidental scrolling, and
clears unavailable items. It never implies that quality or legal eligibility
can be determined from visual similarity alone.

## Make it mine and generate

Generation and adaptation use one durable workflow:

1. Collect a useful brief, audience, tone, sections, CTA, and optional brand
   direction.
2. Persist the create input and caller-generated idempotency key before the
   request leaves the client.
3. Receive a durable design ID.
4. Poll queued/generating work with bounded backoff and server retry hints.
5. Resume after close, reload, app restart, sleep, or a dropped acknowledgement.
6. Show a failed state with a safe retry that reuses durable state.
7. Review the latest immutable revision.
8. Refine from an explicit base revision.
9. Commit an exact revision and output hash.

The user may close after the server acknowledges the durable ID. Before
acknowledgement, navigation must explain that the local direction could be
lost. An ambiguous create response must reuse the exact stored idempotency key
after reload; it must not create a second job.

Adaptation should explain fidelity in human terms:

- **Inspired**: carry over broad rhythm and ideas.
- **Balanced**: retain recognizable structure with original execution.
- **Close**: preserve more composition while still generating new owned
  source, only where policy permits it.

## Review, refine, and finish

Review should show:

- the exact server revision number;
- desktop/mobile safe previews;
- validation pass/warn/fail results in plain language;
- unresolved variables;
- warnings with an actionable next step;
- prior immutable versions;
- whether the viewed version is the latest.

Refinement is disabled while viewing an old version. A base-version conflict
refreshes the design and preserves the user’s refinement text.

“Save as template” and “Use in campaign” are separate commits. Either can
happen first, and the second must still use the same revision/hash without
duplicating the first result. A lost acknowledgement is resolved by the
idempotency key and design lineage, not by issuing a new commit.

The finish state should link directly to the saved template or campaign and
retain a safe path to complete the other action.

## MCP parity

MCP should expose the same nouns and rules rather than a special shortcut:

- search/get/compare references;
- favorite/unfavorite;
- list/record/clear recents;
- create/list/get/update/reorder/delete collections;
- create/list/get/update/run/delete saved searches;
- start/get/refine/retry/archive durable designs;
- list revisions;
- save an exact revision as a template;
- create a campaign from an exact revision.

Every durable mutation requires a caller-supplied printable idempotency key.
Tools that mutate versioned resources require the current entity tag/version.
Tool descriptions must state that inspiration is not edited in place and that
no tool sends a campaign.

## Roles, permissions, and identity

- Viewers can browse and preview but cannot generate, adapt, edit, archive, or
  create campaigns.
- Workspace writers can manage owned templates and durable designs.
- Reference review/publishing remains an audited administrator/operator action.
- Personal state requires a verified user principal.
- Source filters such as `mine` and `team` must return no private results when
  the principal is absent or unbound.
- A resource that belongs to another tenant should be indistinguishable from a
  missing resource.

The UI should hide actions it knows are impossible while still honoring
server-returned capabilities as the final authority.

## Failure and recovery matrix

| Situation                                   | Expected experience                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Offline before a mutation                   | Keep input, explain that a connection is required                                                         |
| Request timed out before acknowledgement    | Reuse the exact idempotency key; do not assume failure                                                    |
| Queued job outlives the window              | Resume from durable design ID                                                                             |
| Generator unavailable                       | Preserve direction and show safe retry                                                                    |
| Design expired                              | Explain expiry and offer a new design with copied direction                                               |
| Stale base revision                         | Refresh versions; preserve unsent refinement text                                                         |
| Stale template/collection/search entity tag | Show conflict; reload before another mutation                                                             |
| Partial bulk result                         | Report success and failure counts; retain failed selection                                                |
| Hosted preview missing                      | Show metadata-only state; never load upstream pixels                                                      |
| Upstream preview disappears after hosting   | Keep the last-known-good hosted image with `source_missing`; if no hosted blob exists, show metadata only |
| Reference is rejected or unpublished        | Remove it from discovery/execution and explain unavailable saved state                                    |
| Catalog refresh fails                       | Keep last verified catalog and label it stale                                                             |
| Checkpoint/import interrupted               | Preserve canonical bundle; resume deterministic checkpoint                                                |
| Workspace changes mid-flow                  | Abort requests and discard cross-workspace private state                                                  |
| Session expires                             | Preserve non-sensitive local direction, reauthenticate, then verify server state                          |
| API key lacks a user binding                | Fail closed for private state and `mine`/`team` filters                                                   |
| Commit response is ambiguous                | Query/reopen durable design before retrying exact mutation                                                |
| Two tabs reorder a collection               | One succeeds; the stale entity tag receives a conflict                                                    |
| Saved filter no longer exists               | Show obsolete filter and offer a one-click cleanup                                                        |
| Browser/app storage unavailable             | Continue after acknowledgement; warn that pre-ack recovery is unavailable                                 |
| Oversized or malformed local recovery state | Ignore and clear it without rendering untrusted content                                                   |

## Accessibility and interaction quality

- All library tabs implement roving focus with Arrow keys, Home, and End.
- Cards expose a descriptive accessible name; selection and favorite controls
  expose state.
- Dialogs trap focus, name themselves, restore focus, and prevent accidental
  close only while an unacknowledged mutation is in flight.
- Loading uses `role=status`; failures use `role=alert`; background refreshes
  do not repeatedly interrupt screen readers.
- Color is never the only signal for status, selection, warnings, or
  validation.
- Motion respects `prefers-reduced-motion`.
- Touch targets are at least 44 by 44 CSS pixels on compact layouts.
- The complete browse, compare, Make it mine, review, retry, and finish paths
  are keyboard operable and covered by automated accessibility checks.

## Operational truth

The checked-in catalog is a build/import artifact, not what clients download
wholesale. Search returns 24 compact rows by default and at most 100; clients
follow the opaque cursor and fetch one selected detail. Catalog records may
include upstream provenance fields, but renderers use only same-origin
Moosewave-hosted `preview_assets`. Editable source and design revisions remain
server-side and are returned only to authorized callers.

The checked-in bundle has 3,194 records, a 28,019,693-byte gzip artifact, a
2,732,692-byte HTML-free manifest, and 220,103,072 retained logical HTML bytes.
It has 3,194 desktop and 1,832 mobile source-preview candidates, but hosted
object-storage bytes remain unknown until a real worker run reaches reviewed
steady state; aliases, failures, and content-hash deduplication make candidate
counts an invalid storage estimate.

`personal-use-unreviewed` does not authorize copying screenshots to a public
asset origin. Because import enqueues previews and the durable worker hosts
them, obtain preview-hosting rights before importing into an environment where
that worker is enabled. Keep an unreviewed personal prototype isolated and
metadata-only unless those rights are established. Production publication and
adaptation require their own documented review.

Shared publication is allowed only when:

- the crawl is complete and pagination is exhausted;
- record identities are unique;
- the artifact and exact sidecar SHA/size match;
- each declared content hash matches its stored HTML;
- review/publication policy is satisfied;
- hosted preview assets are ready or the capability accurately says they are
  not.
