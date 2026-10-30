# Desktop lifecycle owner inventory

Audit date: 2026-07-16

Scope: production renderer source under `apps/desktop/src`

Purpose: prevent DUX-015 from being closed while user-created work can still be
lost across an in-app destination change, Back/Forward, close, quit, sign-out,
workspace switch, update restart, or operating system shutdown.

This is a source inventory, not installed-app evidence. It records the lifecycle
owners found by a static sweep of pages, dialogs, slideovers, controllers, and
process-wide services. Runtime-only or conditionally mounted owners can still be
discovered during the signed-package matrix, so this inventory must be refreshed
before each release candidate.

## Owner rules

- A draft owner is responsible from the first user edit until server
  acknowledgement, durable encrypted journaling, or explicit discard.
- File-transfer ownership ends when the picker/read/upload/download/save
  operation ends. A selected file's remaining metadata or unsubmitted form is a
  separate draft owner.
- Offline-outbox ownership begins only after the mutation is durably admitted as
  `queued`. It does not cover debounce buffers, unsent fields, in-flight requests,
  or generated secrets.
- Create, send, test, replay, and export-request forms must never auto-submit from
  a global lifecycle **Save** action. Prefer an encrypted journal and explicit
  discard; wait or cancel an active operation.
- Existing-entity settings may offer save/discard only when validation and side
  effects are deterministic and a server baseline is retained.
- One-time secrets must block destructive transitions until acknowledged or
  explicitly abandoned. They must not be copied automatically or journaled as
  plaintext.
- Guard IDs are renderer-global. Entity and mounted-instance identity must be
  included whenever two copies can coexist.

## Implemented coverage

The current registry covers the following classes. A source implementation is
not equivalent to native qualification.

- Encrypted offline outbox, including persistence failure, active replay, and
  explicit sign-out purge.
- Process-wide native close, quit, OS-shutdown, workspace-switch, sign-out, and
  update-restart decisions.
- Typed section/resource/tab/deep-link navigation and indexed Back/Forward
  transitions. The current route stays mounted during review; cancel preserves
  its exact history position, while approval resumes the original target and
  scroll state. Process-owned transfers and the durable outbox deliberately
  continue across ordinary navigation.
- Active campaign send monitoring.
- Workspace, notification, retention, and desktop Settings editors.
- Campaign create recovery, campaign detail editing, block composition, and
  translations.
- Campaign feedback, scheduling, calendar rescheduling, locale translation,
  UTM-template/preview, template and saved-block creation, sequence creation/AI
  drafting, archive publishing/SEO, and referral-program editing.
- Subscriber and suppression file-import wizards.
- Asset uploads, migration drafts/operations, and the centralized file-transfer
  service.
- Collection create/edit, Form create/detail, Template detail, Tag detail, and
  API Playground endpoint drafts.
- SMS reply and broadcast composers.
- Sequence step, settings, trigger, and canvas mutation buffers.
- AI template generation, audience-sync editing, zero-copy trigger editing,
  dashboard-layout persistence, subscriber-view preferences, and queued-mutation
  editing.
- TOTP recovery codes, workspace API keys, agent keys, and SCIM tokens from
  issuance through successful copy/acknowledgement or explicit abandon. Their
  create drafts are discard-only, local dirty close is confirmed, and retained
  single-flight request owners hand plaintext to an already-registered shown-once
  guard before releasing.
- Gift redemption links and private podcast feed URLs until successful copy or
  explicit acknowledgement. Gift issuance retains its request guard through
  the reveal handoff and removes the redemption link from parent state after a
  successful copy. Podcast metadata is redacted from the mint response, so the
  raw token/feed URL has one state owner; changing subscriber, rotating, or
  revoking requires explicit abandon first.
- Audit portal session mint/revoke operations and every still-live session;
  dialog close/replacement revokes the old session instead of abandoning it.
- Conversion tracking-key create/revoke operations, unsent label drafts, and
  one-time plaintext; local close requires an explicit store-or-discard choice.
- Inbound-webhook endpoint drafts, create/rotate operations, and shown-once
  signing secrets; modal dismissal requires explicit secure-store or discard.
- Inbound-email routing endpoint creation/rotation and one-time signing-secret
  reveal, route create/edit matcher/action/HMAC drafts, preview drafts, route
  deletion, and table toggle/reorder/duplicate operations. Copy requests
  clear-if-unchanged after 60 seconds and clear the in-app reveal only after a
  successful copy or explicit stored acknowledgement; abandon and
  abandon-before-rotation are separate confirmations. Route modal close and
  configuration-to-history transitions require explicit discard, newly typed
  HMAC material is zeroized on discard/success, and global lifecycle Save has
  no create/update/rotate/preview callback. Controller mutations are
  instance/resource-scoped, same-tick single-flight, exception-contained, and
  retain their process guard until the request settles even if the page
  unmounts.
- Outbound-webhook test/bulk/save/create operations, edit and receiver-preset
  drafts, and returned signing secrets; dirty local close and shown-secret
  dismissal both require explicit discard decisions.
- Add-workspace keychain operations and unsaved URL/API-key drafts; explicit
  discard zeroizes every credential field before the dialog closes.
- First-run API URL/key setup, connection tests, and keychain save; destructive
  transitions block until secure save or explicit in-memory zeroization.
- All nine native managed-provider connection dialogs: instance-scoped
  credential drafts, validation/create/OAuth operations, explicit local
  discard, successful-completion clearing, and retained retry state after a
  contained request failure. A committed connection is not misreported as a
  failed/retryable create merely because the subsequent list refresh failed;
  thrown registry loads are also contained without exposing transport details.
- Commerce `StoreConnectModal` credentials and connection/OAuth operations;
  dirty close and provider switches require separate explicit discard
  decisions, while active requests cannot be dismissed and post-commit refresh
  failures cannot invite a duplicate connection retry. Registry-load throws
  settle to an actionable, cleanly closable error state.
- Deliverability-provider label/token/runtime-secret-reference drafts and
  create/remove operations. Provider switching and removal require explicit
  confirmation; same-tick requests are single-flight; failures preserve the
  retryable draft; explicit discard/success clears every typed value. Generated
  receiver tokens cannot be irretrievably saved until copied or explicitly
  acknowledged, are strength-validated, and are stored server-side only as a
  one-way digest. Mirror API keys resolve through a tenant-bound runtime-secret
  name; raw keys are rejected and legacy raw values migrate away on save.
- BYOK registration references/descriptions and every create/activate/health/
  delete request. Dirty modal close requires explicit zeroizing discard, all
  requests block destructive lifecycle and local dismissal, confirmations stay
  visible and busy until completion, and rejected promises release controls
  without losing the draft.
- AI regression setting queues, replay tags, and manual golden-example drafts.
  Lifecycle Save awaits the exact coalesced settings drain (including the
  newest queued value), failures retain the draft, explicit discard restores
  the last acknowledged baseline, and an unmounted surface still completes its
  queued write. Replay/golden drafts are discard-only and can never be
  auto-submitted by global Save; trigger/capture/archive operations are
  single-flight blockers with failure-safe cleanup.
- Every owner from the 2026-07-16 **Settings and governance** subsection:
  approval escalation, delegation creation/revocation, firewall policy,
  campaign approval chain, archive custom domain, custom-field governance,
  data-export selection/request, export retention, feature-flag override,
  identifier transforms, goal create/edit/delete, preference-center theme, and
  privacy-region create/delete. Existing settings retain an acknowledged
  server baseline and expose deterministic prepare/save plus explicit discard;
  create/action drafts expose discard only and can never auto-create a
  delegation, export, feature flag, goal, or region from lifecycle Save. Every
  mutation uses an exact ref-owned same-tick single-flight promise, contains
  thrown requests, releases in `finally`, preserves retry state, blocks local
  dismissal while active, and permits non-destructive hide. A transient
  process-level operation guard remains registered until that exact promise
  settles even if its React surface unmounts. Inline/collapsible owners remain
  mounted while visually hidden, and modal/action-form close paths require
  explicit discard when they would lose a changed draft.
- The audited subscriber-work wave: audience-destination create/edit plus its
  controlled auth configuration/check, write-back target creation, both
  lookalike generators and result export, natural-language and visual segment
  creation, saved-segment folder create/rename, save-current-segment, holdout
  configuration, list member addition, merge-field create/edit, list settings,
  and list-webhook creation/test/delete. Create/action drafts are discard-only;
  existing destination, folder, schema and list settings retain acknowledged
  baselines. Incomplete visual rules and controlled auth fields report to their
  parent aggregate instead of registering child duplicates. Dirty local close
  is confirmed, visually hidden controlled drafts remain owned, thrown
  requests retain retry state, and exact operation guards survive unmount.
- Audit-sink create/test, edit/update, replacement-credential rotation,
  signing-key rotation, detail test/toggle/reset, and delete operations. Draft
  IDs include the sink resource where one exists plus mounted-instance
  identity; hide remains safe, destructive lifecycle transitions block, and
  local close/destination-kind/rotation changes require explicit discard. All
  write-only credential state is cleared on discard or successful commit.

### Cross-route lifecycle checkpoint

Every public typed route helper now requests a `route-change` / `navigate`
decision before changing a destination when an applicable owner is mounted.
This includes section/resource helpers, route-backed tabs, native deep links,
and the Sidebar, command palette, notifications, menus, and tray because those
entry points already converge on the typed router. Browser Back and Forward use
indexed history rollback: the current owner remains mounted for review, Cancel
preserves the exact current position, and approval resumes the original target
with its recorded scroll. Multi-entry jumps and Forward use the same path.

The fast path remains synchronous when no route-scoped owner is mounted.
Process-wide transfers and the encrypted outbox explicitly participate only in
process/identity transitions because they remain durable and visible across
routes. Focused behavior and source proof passes 48/48 cases across four suites;
the router also passes the default function-length and complexity gates without
a legacy exception. Signed WebView/WebView2, OS Back/Forward, deep-link,
keyboard, and assistive-technology qualification remains external evidence.

### Sensitive issuance and credential-draft checkpoint

This wave reconciled each listed owner against the live source rather than
counting a visible warning as lifecycle coverage. The common shown-once hook is
now always registered with mounted-instance identity and exposes an imperative
`activate`/`resolve` handoff. A mutation can acquire the secret owner inside its
retained request callback before that request's `finally` releases, closing the
response-to-render gap. Inactive guards inspect cleanly, hide remains safe, and
no shown value has a global prepare/save path.

| Owner                                       | Exact ownership result                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TotpSetupModal` recovery step              | Enrollment/verification is same-tick single-flight and retained through unmount. Successful verification activates the recovery-code owner before the request releases; acknowledgement resolves it and clears codes, URI, QR data, and typed code before parent callbacks. Copy failure never acknowledges.                                   |
| `settings/ApiKeysSection`                   | Create label/scopes are discard-only with local close confirmation. Create/rotate/revoke share one retained mutation owner. A valid create/rotate response activates the plaintext owner before request release; missing plaintext fails closed with revoke guidance. Acknowledgement clears the only plaintext state.                         |
| `ai/AgentKeyCard` + `PostwaveAI.AgentPanel` | `AgentPanel.activeKey` is the sole plaintext state and shown-once owner. `AgentKeyCard` owns only its discard-only form and retained create/revoke request; it neither mirrors plaintext nor registers a child secret guard. Snippet projection is read-only and clears with the aggregate owner.                                              |
| `archive/PodcastTokensCard`                 | Normal token rows receive a redacted metadata object with both `token` and token-bearing `feed_url` removed. Mint has one plaintext owner; successful copy/ack clears it. Lookup replacement, rotate, and revoke require an explicit one-time-value abandon. All requests are retained single-flight and thrown failures preserve retry state. |
| SCIM `TokensPanel` / reveal                 | Token description is discard-only and dirty close is confirmed. Mint hands the full token to the parent owner before its request guard releases; reveal close requires acknowledge or explicit abandon. Revoke is retained single-flight.                                                                                                      |
| Track `ConversionsSection`                  | Create label is discard-only with a local confirmation. Create/revoke share one retained owner; plaintext activation occurs before create release, and store/abandon both zeroize the reveal.                                                                                                                                                  |
| `InboundWebhooks`                           | Endpoint label is discard-only with confirmed local close. Create/rotate share one retained owner and activate the returned signing-secret owner before release. Store/abandon clears the reveal; malformed success never pretends a secret is safe.                                                                                           |
| `OutboundWebhooks` + `ReceiverPresetDialog` | Parent test/bulk operations are one retained single-flight aggregate. The receiver child exclusively owns its discard-only URL/event draft and create request; parent exclusively owns returned plaintext. The child invokes the parent's synchronous activation before its request releases.                                                  |
| Gift `CreatedSheet`                         | Gift creation is retained through the parent-owned redemption-link handoff. A failed clipboard write leaves the owner blocking; successful copy resolves it and removes the link from parent state. Local close without copy is an explicit abandon and clears the parent row state.                                                           |
| `AuditPortalSessionModal`                   | Mint/revoke/replace use one retained owner. Replacement has a separate destructive confirmation. Active links must be revoked to close; route unmount starts a contained retained best-effort revoke whose guard survives React unmount.                                                                                                       |
| `WorkspaceMenu.AddWorkspaceModal`           | Name/URL/key are one discard-only credential draft with confirmed local close. Keychain save is same-tick single-flight and retained; success or discard clears every field, and thrown requests preserve the retryable draft.                                                                                                                 |
| `Welcome` first-run configuration           | URL/key/step/result are one blocking discard-only draft. Test and keychain save share a retained single-flight owner, disable mutation of the tested tuple while active, contain failures, and clear the key on secure-save acknowledgement or explicit discard.                                                                               |

Focused proof passes 77/77 tests across twelve suites. The matrix includes
prepare-without-auto-submit, global/local discard, failed and successful secret
copy, acknowledgement, explicit abandon-before-replacement, same-tick
single-flight, operation failure and retry retention, post-unmount settlement,
and duplicate semantic owners with collision-free instance IDs. Scoped source
and test ESLint is warning-free; full app and renderer-test TypeScript both
pass on the reconciled shared tree.

This checkpoint does not close DUX-015. Typed in-app destination changes now
participate in lifecycle review, but other production drafts remain below and
exact signed macOS/Windows navigation/close/quit/sign-out/workspace/update/
shutdown qualification is still external release evidence.

### Audit-sink field and operation inventory

`pages/AuditSinks.tsx` has no compatible encrypted draft-recovery service for
this mixed configuration/credential form. It therefore exposes discard only:
the global lifecycle coordinator has no `prepare` callback and cannot invoke
test, create, update, or rotation. Non-secret fields are not separated into a
misleading partial recovery record, and credential values are never written to
local/session storage, IndexedDB, an outbox, a log, or a diagnostics payload.

Common create state is `name`, `kind`, `output_format`, and `webhook_format`.
Common edit state is `name`, `output_format`, `webhook_format`, and the explicit
`rotating` choice. The canonical per-kind map is:

| Destination             | Non-secret configuration fields                                    | Write-only credential fields                 |
| ----------------------- | ------------------------------------------------------------------ | -------------------------------------------- |
| Datadog                 | `site`                                                             | `api_key`                                    |
| Splunk HEC              | `hec_url`, `index`                                                 | `token`                                      |
| AWS S3                  | `region`, `bucket`, `prefix`                                       | `aws_access_key_id`, `aws_secret_access_key` |
| Parquet archive         | `region`, `bucket`, `prefix`, `retention_days`, `object_lock_mode` | `aws_access_key_id`, `aws_secret_access_key` |
| Generic HTTP            | `url`                                                              | `bearer_token`, `hmac_secret`                |
| Snowflake shareback     | `account_locator`, `share_name`, `bucket`, `region`, `prefix`      | `aws_access_key_id`, `aws_secret_access_key` |
| OpenTelemetry OTLP Logs | `endpoint`, `service_name`, `compression`, `headers`               | `bearer_token`, `api_key`                    |

Focused behavior pins this exact classification, explicit local discard before
close/destination switch/rotation abandonment, hide-vs-exit behavior,
same-tick single flight, retained retry state after thrown requests, credential
clearing on discard/success, signing-key confirmation, and operation release in
`finally`.

### Campaign and content lifecycle boundary

The campaign/content wave owns nine previously unregistered surface groups:
campaign feedback; scheduling/PSTO; calendar rescheduling; locale translations;
UTM-template editing and preview; template and saved-block creation; sequence
creation and AI drafting; archive publication and per-issue SEO; and referral
program editing. Create/action forms are discard-only and expose no lifecycle
`prepare` callback, so a global Save decision cannot post feedback, reschedule,
publish, generate content, or create a resource. Existing archive SEO and
existing referral programs retain an acknowledged server baseline and offer an
exact deterministic save/discard path.

Every covered mutation uses a ref-owned, same-tick single-flight promise.
Destructive lifecycle transitions block until that exact promise settles, even
if its React surface unmounts; hiding the window remains safe. Local modal,
editor-replacement, and selection-change paths require explicit discard when
they would otherwise erase a changed draft. Rejected and thrown requests are
contained, controls release in `finally`, retryable input is retained, and a
committed create is separated from a subsequent refresh failure so retry cannot
silently duplicate the resource.

Ownership deliberately does not overlap existing Template detail, campaign
AI/body translation, or sequence step/settings/trigger/canvas owners. Internal
typed destination changes, deep links, and indexed Back/Forward now use the
same lifecycle registry, so registered route-scoped owners remain mounted until
review resolves. This source coverage does not replace signed installed-app
navigation and lifecycle qualification.

## P0 uncovered owners

These owners contain security material, one-time values, in-flight local work,
or high-consequence drafts. They block a DUX-015 completion claim.

No owner remains in this narrowly classified P0 table after the inbound-routes
wave. This does **not** make DUX-015 complete: the production-draft inventory
below still contains owners that may be promoted to P0 as their exact payloads
and side effects are reviewed.

### Inbound-routes security and navigation boundary

The inbound route editor deliberately keeps mixed route/HMAC drafts in memory
and exposes discard only. It does not create a partial non-secret recovery
record that could imply the credential was recovered, and it writes neither
draft nor plaintext to local/session storage, IndexedDB, the offline outbox,
logs, or diagnostics.

Route list and preview payloads now expose only
`actions[].has_stored_hmac_secret`; the signing value stays server-side. The
editor sends an opaque source-index preservation control, never pre-fills a
stored value, never copies the capability into a duplicate, and zeroizes every
newly typed replacement. The value remains stored in the route JSONB record, so
a future vault/reference migration can further narrow the server-side storage
boundary without reopening the client disclosure path.

Internal typed destination changes now share the close/quit/identity/restart
decision registry. Programmatic routes and indexed Back/Forward keep this page
mounted until its registered route/HMAC draft, operation, or shown-once secret
is saved where supported, explicitly discarded/abandoned, or cancelled. The
remaining production boundary here is exact signed installed-app qualification
plus the server-side JSONB-to-vault migration described above.

The sensitive issuance checkpoint above now covers the surrounding drafts,
operations, local dismissal, response-to-reveal handoff, and zeroization for
`TotpSetupModal`, `ApiKeysSection`, `AgentKeyCard`/`AgentPanel`, SCIM
`TokensPanel`, podcast, gift reveal, conversion keys, inbound/outbound webhook
issuance, audit portal sessions, add-workspace credentials, and first-run API
configuration. These entries must not be re-added to the residual list merely
because their plaintext state is visible; a fresh audit should instead test the
exact ownership contract and identify a concrete uncovered path.

### Audience and subscriber-work checkpoint

This checkpoint reconciled the live source at the owner boundary instead of
counting a busy boolean or modal warning as persistence. The exact source
contracts are:

| Aggregate owner                             | Ownership and transition result                                                                                                                                                                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AudienceDestinationModal`                  | One modal owns provider, source, external id and controlled auth configuration. Create is discard-only; edit saves/discards against normalized provider defaults. The readiness child uses the parent operation runner and has no lifecycle registration.                  |
| `CreateWritebackModal`                      | Provider, vault reference, source, tags, field/trait maps, interval and advanced JSON form one discard-only draft. Success/discard clears the credential reference and mappings; a failed create preserves them.                                                           |
| Segment and subscriber lookalikes           | Generation and destination-export forms are action drafts with no prepare callback. A generated server resource is not misreported as local unsaved work; a failed generation/export retains its exact retry input.                                                        |
| `NaturalLanguageBuilder`                    | Description, compiled AST, rationale, name and visual rule tree form one owner. `VisualSegmentBuilder.onDirtyChange` reports incomplete rows which cannot yet produce an AST; the child registers no duplicate. Compile/create share one retained single-flight operation. |
| Saved-segment folder and save-current flows | Folder creation and save-current are discard-only. Folder rename is an existing setting with its folder name as the acknowledged baseline. Dirty rename dismissal is separately confirmed.                                                                                 |
| Holdout and list-member actions             | Holdout selection and member search/selection are discard-only. Search failure settles honestly; failed mutations retain the selected values; local close requires explicit discard.                                                                                       |
| Merge fields and list settings              | New merge fields are discard-only. Existing merge fields and list settings use deterministic save/discard against an acknowledged server baseline; refreshes advance the baseline without clobbering an active edit. The parent slideover confirms dirty Settings tab dismissal and waits during save without a duplicate registry owner. |
| List webhooks                               | URL/event creation is discard-only. Create, test and delete share one exact retained operation; create failure preserves the URL/event selection and local close is confirmed.                                                                                             |

Focused proof passes 10/10 lifecycle cases across the behavior, source-contract
and list-slideover suites. The matrix covers prepare without action auto-submit,
explicit local discard, failed existing-setting prepare followed by an
acknowledged retry, post-unmount request lifetime, a controlled hidden draft,
two concurrent semantic owners without a registry collision, explicit discard
before tab/close dismissal, and wait-only behavior during inline settings save.
Reconciled existing lookalike, saved-segment manager, list-detail, write-back
input, destination-auth and subscribers-controller regressions pass 30/30;
the combined checkpoint is 40/40 across eight suites. Scoped production/test
ESLint and the default 300-line/complexity-50
function gate pass; `MergeFieldsTab` was split below the default threshold and
its legacy 397-line ratchet was removed. Full renderer and renderer-test
TypeScript pass on the reconciled shared tree.

Source completion here is not native qualification. Exact signed macOS/Windows
close, quit, sign-out, workspace switch, restart and shutdown behavior for these
owners remains part of DUX-015's release matrix.

## Remaining production draft owners

The following state was found without lifecycle registration. Parenthesized
notes identify the intended aggregate owner where multiple child controls share
one draft.

### Campaigns, content, and growth checkpoint

No owner remains in this bounded subsection after the campaign/growth/page
lifecycle wave. `GrowthPanel`, `LandingPagesSection`, `SocialCaptureSection`,
`VariantsPanel`, `FeedSourceFormModal`, Affiliates, Discounts, Custom Domains,
Lists, Tags, and the non-secret Gift Subscriptions drafts now distinguish
discard-only create/action state from acknowledged-baseline edits. Lifecycle
prepare cannot create a resource or run an action. Dirty local close and draft
replacement require an explicit discard decision, failed work retains its
input, and accepted operations are same-tick single-flight guards whose process
concern survives component unmount. Growth and social-capture tab content stays
mounted while hidden so switching tabs cannot silently destroy an owned draft.

Gift creation reuses the existing retained issuance operation and still has one
shown-once secret owner; this wave adds only the non-secret create and
cancellation-reason draft boundaries. Focused controller and source-contract
proof passes 19/19 cases. The reconciled campaign/growth/page checkpoint passes
195/195 tests across 15 suites, scoped production/test ESLint, full app and
renderer-test TypeScript, the five-case function-quality contract suite, and
exact ratchet reconciliation for every file in this wave. Legacy
function maxima tighten for Growth Panel (459→426), Variants Panel (418→403),
Custom Domains (422→322), Discounts (387→381), Gift Subscriptions (585→551),
Lists (660→582), and Tags (1203→1035); the Affiliates exception is removed and
the Tags complexity exception is no longer needed.

A second review pass also locks existing experiment keys to their acknowledged
resource, disables Growth/Variants row replacement until the open editor is
closed or explicitly discarded, and retains only failed tag IDs after a
partial bulk delete. The source contract pins all three regression boundaries.

This is a subsection result, not a DUX-015 completion claim. The remaining
production-owner sections below and exact signed macOS/Windows lifecycle
qualification remain release work. The cross-cutting route checkpoint passes
48/48 focused cases, including typed internal navigation, deep links, and
Back/Forward rollback/resume/cancel, while durable process outbox/transfer
owners remain excluded from ordinary route changes.

### Audience and subscriber work

- `subscriber/NoteAttachmentForm.tsx` and `SubscriberNotesPanel.tsx`: note text
  and attachment metadata (one `subscriber-notes:<subscriberId>` owner).
- `sms/ConversationTagsNotes.tsx`: tag and unsaved notes.
- `subscribers/AccountSection.tsx`, `DuplicatesModal.tsx`,
  `FederatedIdentityPanel.tsx`, and `FrequencyPreferencePanel.tsx`: local drafts
  and active mutations.
- `InlineEmailEdit.tsx` and `InlineTagChip.tsx`: per-row edits; IDs must include
  subscriber/resource or be aggregated at the table.
- `MergeFieldsSchemaModal.tsx`, `ScoringRulesCard.tsx`,
  `SubscriberAddModal.tsx`, `SubscriberEmailsSection.tsx`,
  `SubscriberListsPanel.tsx`, `SubscriberNaturalLanguageSegmentPanel.tsx`,
  `SubscriberProfilePanel.tsx`, and `SunsetPoliciesCard.tsx`: their form drafts
  and active mutations.
- `subscriber/SubscriberCustomObjectLinks.tsx`: relationship link/edit draft.

### Settings and governance

No owner remains in this audited subsection after the settings/governance
lifecycle wave. This is a subsection result, not a DUX-015 completion claim:
the audience/subscriber, audit/compliance, messaging and page-level inventories
below and above still contain release-blocking owners.
The cross-cutting route gate now protects registered owners; universal
route-to-route loss protection still depends on emptying those owner lists.

### Audit, compliance, automation, and data platform checkpoint

The bounded audit/compliance/data-governance wave now owns alert-rule criteria,
SOC channel credentials and verification, async-export notification input and
its otherwise-unrecoverable progress handle, replay ranges and sink replacement,
evidence schedules, retention overrides, saved views, access requests, event
PII/investigation/retention actions, investigation decisions, framework
attestation/revocation, all four privacy-incident authoring actions, custom
object types/records, streaming export creation/shipment, warehouse connection
validation/creation/run/mapping, and reverse-ETL creation/sync/delete.

Create/action drafts are discard-only and cannot be submitted by global Save.
Existing retention, custom-object schema, and warehouse mapping edits use their
last acknowledged server value. Identity replacement is explicit; accepted
mutations are same-tick single-flight owners whose process concern survives
surface unmount, and failures retain the exact retry input. AuditEvent
aggregates its retention child, while connection verification shares its parent
create owner rather than registering a duplicate. Audit channel credentials are
masked with explicit accessible reveal and `new-password` autofill semantics;
dirty checks compare values without serializing the secret-bearing config.
Operator, channel, warehouse-provider, and streaming-destination replacements
clear the displaced scoped values only after confirmation. Async export
polling is sequential and bound to the mounted/open request generation, so a
late enqueue response cannot install a timer after unmount.

This is not a DUX-015 completion claim. Residuals in or adjacent to this domain
remain:

- `audit/AuditSinkTables.tsx`: row enable/reset and single/bulk replay actions
  still use surface-local busy flags without a retained operation owner.
- `privacy/DoubleOptinPendingTable.tsx`: rearm and cancel mutations still need
  retained action ownership.
- `automations/OmniCampaignCreateModal.tsx`, `TriggerDelayCard.tsx`, and
  `TriggerDetailSlideover.tsx`: campaign, delay, alert, and load-test drafts.
- Reproducible `audit/AuditNLQBar.tsx` and
  `dataplatform/CdpTransformsSection.tsx` input remains in the lower-loss list
  below; it was inventoried but deliberately not absorbed into this wave.

### Messaging, webhooks, and integrations

- `SMSInbox.tsx` new-conversation modal and `sms/QuickReplyPicker.tsx`.
- `sms/SmsA2PRegistrationCard.tsx`, `SmsKeywordResponsesCard.tsx`, and
  `SmsQuietHoursCard.tsx`.
- `SmsSuppressions.tsx`, `PushSuppressions.tsx`, `Suppressions.tsx`,
  `BulkImportSuppressionsModal.tsx`, and `suppressions/BulkActionsMenu.tsx`.
- `tags/BulkEditModal.tsx`, `MergeTagsDialog.tsx`, `RegisterOrphanModal.tsx`,
  and `TagGroupManageModal.tsx`.
- `webhooks/OutboundWebhookEditDialog.tsx`, `AlertPrefsSection.tsx`,
  `TestPayloadsPicker.tsx`, and `TriggersPanel.tsx`. Receiver-preset
  create/draft ownership is covered above.
- `webhook-simulator/SavedPayloadsPanel.tsx` and the authoring/fire state in
  `WebhookSimulator.tsx`.
- `commerce/CatalogsTab.tsx` and `RecoveryTab.tsx`: create/import/feed/cart and
  product-subscription drafts.
- `experiments/ControlGroupsCard.tsx`,
  `deliverability/FrequencyCapsCard.tsx`, and
  `deliverability/BlocklistAutoSuppressCard.tsx`.

### Other page-level editors

- `AEOSensor.tsx`, `Agency.tsx`, `Approvals.tsx`, SCIM role
  mapping, `SendTime.tsx`, and `SendingSettings.tsx`.
- `reviews/ReviewCard.tsx`, `reviews/WidgetsTab.tsx`,
  `helpdesk/CustomerHubConfig.tsx`, `HelpdeskInbox.tsx`, and
  `CustomerAgentPanel.tsx`.
- `library/LibraryQuickLook.tsx`, `track/EventComposer.tsx`, and
  `WebhookSimulator.tsx`.

### Reproducible but still user-created local work

These are lower-loss because they can usually be regenerated, but they still
need a small session journal and active-operation cancellation:

- `SubjectLab.tsx`, `SubjectLineAssistant.tsx`, `ai/SubjectLab.tsx`,
  `ai/ComposeBroadcastForm.tsx`, and `ai/PresendCheckPanel.tsx`.
- `composer/ContentRemixCard.tsx`, `analytics/AnalyticsNlqBar.tsx`,
  `audit/AuditNLQBar.tsx`, and `dataplatform/CdpTransformsSection.tsx`.
- `deliverability/DiagnosticianCard.tsx`, `EqScoreLookupCard.tsx`, and
  `sms/TapToTextBlockEditor.tsx`.
- `PostwaveAI.tsx`: input and active stream; retain the partial answer when
  cancelling. Existing messages already flush to tenant-scoped local storage.

## Duplicate-owner and collision risks

- `asset-uploads` overlaps the process-wide `file-transfers` owner during byte
  movement. The component should own only selected/unsubmitted and retained
  failed work; the transfer service should exclusively own active bytes.
- The same overlap exists in migration, subscriber import, suppression import,
  and campaign translations.
- A campaign aggregate must not duplicate block-editor or translation concerns.
- Agent-key plaintext is intentionally aggregated at
  `PostwaveAI.AgentPanel.activeKey`; `AgentKeyCard` must never regain a mirrored
  plaintext state or child shown-once guard. The source contract pins this
  no-duplicate boundary.
- Inline row editors and two-pane entity views can mount more than once. Constant
  or entity-only IDs are insufficient in those layouts.
- API Playground IDs based on a folded/truncated method/path can collide; use a
  canonical operation ID plus mounted-instance token.
- The registry retains every colliding instance under an internal key and
  exposes one synthetic blocking concern instead of throwing from a React
  effect or silently shadowing either owner. Unmount/remount collision tests
  pass. Duplicate IDs must still be corrected: while two applicable copies are
  mounted, destructive transitions intentionally remain blocked.

## Explicit exclusions

Read-only polling, filters/search, reproducible lookups, and server-side jobs
that safely continue without unique local state were excluded. Examples include
routine automation runs, audit replay jobs after submission, migration progress,
warehouse runs, and optimizer runs. The compile-time-disabled Retention Offers
editor is also excluded while `PAID_RETENTION_MUTATIONS_AVAILABLE` remains
false. `Consent.tsx` is read-only in this inventory. Compliance Article 50
bundle generation is reproducible/file-transfer work and remains owned by the
transfer boundary rather than an ordinary form draft.

## Exit criteria

DUX-015 may move to `IMPLEMENTED` only when every owner above is either
registered, removed, or explicitly documented as durable/server-owned; overlap
and duplicate-ID tests pass; and a fresh source sweep finds no unowned local
draft, debounce queue, sensitive plaintext, or in-flight local operation. It may
move to `VERIFIED` only after the exact signed macOS/Windows lifecycle matrix in
`desktop-lifecycle.md` passes against an immutable release artifact.
