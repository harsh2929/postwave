# apps/api — main.go → internal/{server,boot,workers} migration

## Status

| Phase | Status | Notes |
|------:|:------:|-------|
| 0. Scaffold packages | shipped | `internal/server`, `internal/boot`, and `internal/workers` own the first complete route/worker slice. |
| 1. Migrate route mounts | in progress | 116 / 155 literal `MountRoutes` call sites moved. The thirty-two complete migrated groups own 445 registration calls and 1361 routes. |
| 2. Migrate workers     | in progress | Provider-worker composition is typed: deliverability/spam guards; support (26), review (9), loyalty (5), subscription (9), marketing (1), commerce/lifecycle (12), CRM/reconcile (13), lead (23), analytics integrations (4), integration delivery/audience (7), data retention/privacy (7), and operational maintenance (12) launches; intelligent retry also moved. |
| 3. Move boot sequence  | in progress | Proxy trust, validation/warnings, worker drain, tracing, PostgreSQL, sending persistence, file-upload storage, PostHog, AWS/KMS/secrets and event-bus/Redis lifecycles are extracted; Sentry remains inline. |
| 4. Delete main.go body | not started | Final step — main.go shrinks to `boot.Init() + server.New() + workers.Run()`. |

`main.go` is **5231 LoC**; today, `internal/server/server.go` is 239 LoC,
`internal/server/deliverability.go` is 69 LoC,
`internal/server/subscriber_lists_segments.go` is 191 LoC,
`internal/server/campaign_sending.go` is 218 LoC,
`internal/server/identity_api.go` is 217 LoC,
`internal/server/audit_operations.go` is 122 LoC,
`internal/server/tenant_governance.go` is 172 LoC,
`internal/server/audience_activation.go` is 128 LoC,
`internal/server/support_integrations.go` is 196 LoC,
`internal/server/customer_lifecycle_integrations.go` is 225 LoC,
`internal/server/provider_integrations.go` is 428 LoC,
`internal/server/reporting_compliance_tools.go` is 62 LoC,
`internal/server/subscriber_campaign_utilities.go` is 62 LoC,
`internal/server/analytics_integrations.go` is 75 LoC,
`internal/server/workspace_data_utilities.go` is 53 LoC,
`internal/server/engagement_preferences_webhooks.go` is 85 LoC,
`internal/server/collaboration_integrations.go` is 60 LoC,
`internal/server/analytics_realtime_routes.go` is 89 LoC,
`internal/server/sending_forms_routes.go` is 110 LoC,
`internal/server/editor_queue_routes.go` is 66 LoC,
`internal/server/platform_insights_routes.go` is 83 LoC,
`internal/server/user_experience_routes.go` is 73 LoC,
`internal/server/operator_reference_routes.go` is 83 LoC,
`internal/server/messaging_engagement_routes.go` is 50 LoC,
`internal/server/web_domain_tool_routes.go` is 44 LoC,
`internal/server/analytics_asset_routes.go` is 60 LoC,
`internal/boot/boot.go` is 95 LoC, and the nine `internal/workers` production
files total 1410 LoC.
The remaining body migrates in route-grouping, worker-grouping, and boot batches.

The Phase 1 denominator is an inventory of literal production
`.MountRoutes(...)` call sites: 39 remain in `main.go` and 121 now live in
`internal/server`. That is five more than the 116 counted in the migration
ratio above, because each is a net-new surface added directly in
`internal/server` rather than a call site moved out of `main.go`:
`MountVerificationSurface`, the `operation` cross-family
`GET /api/v1/operations` view, action tickets, and `MountContinuityRoutes`,
which contributes two — it mounts `activitycursor` and `editorcheckpoint`
together so a resume offer cannot ship without the draft behind it. All five
raise the location count without advancing the Phase 1 numerator, and the 39
in `main.go` is unchanged, which is what keeps the ratio honest: a surface
authored in its new home is not progress on moving the old ones.
`MountAgentMandateRoutes` mounts its surface without a literal
`.MountRoutes` call and so is not in this inventory. Named registration
functions such as `MountRead`, `MountArchiveRoutes`, and `MountWrite` are
tracked in each completed group's registration total instead of being
misreported as literal `MountRoutes` calls.

## Design contract

```
main.go                                  (target: ≤ 200 LoC)
 ├─ deps, err := boot.Init(ctx)          ← env + pool + obs init
 ├─ srv := server.New(deps)              ← attaches every MountRoutes
 ├─ go workers.Run(workersCtx, deps)     ← every safego.Go worker
 └─ srv.ListenAndServe() + graceful shutdown
```

* `server.Deps` is the **single** dependency bag passed across the seam.
* Adding a field to `Deps` requires a mount block that needs it — no speculative
  fields.
* Workers always take the same `Deps`; they get a separate `context.Context`
  (today main.go calls it `outboxCtx`) so HTTP shutdown can drain in-flight
  requests before workers are torn down.
* Tests can instantiate `server.Deps{Router: chi.NewRouter(), Pool: testPool}`
  and call `server.MountX(deps)` directly — no need to spin the full main.

## Migrated so far

### Deliverability surface (12 mounts / 43 routes)
* `server.MountDeliverabilitySurface(deps)` owns `dns_health`,
  `deliverability_hub`, `firewall_attack_mode`, `freq_caps`,
  `from_name_picker`, `inactive_keys`, `preset_segments`, `growth_source`,
  `isp_breakdown`, `campaign_benchmarks`, `campaign_to_template`, and
  `tag_taxonomy` in their original registration order.
* `main.go` passes the existing authenticated chi sub-router, so API-key,
  tenant, route-policy, impersonation, admin-IP, audit-scope, MFA, and region
  middleware stay outside the server helper and retain their exact order.
* `server.Deps.TagHistory` is the only promoted group-specific dependency;
  repositories and the DNS worker remain constructed from the shared pool.
* `workers.StartDeliverabilityHub` receives the same hub dependency pointer as
  the routes. The adjacent spam-trap launch wrapper also moved to `workers`;
  final consolidation into `workers.Registered` remains a later Phase 2 step.
* Tests pin every method/path pair, read-versus-admin scope, authenticated
  router inheritance, `server.New` registration, and nil router/pool behavior.

This is the canonical recipe to follow when porting each subsequent
`pkg.MountRoutes(r, &pkg.Deps{Pool: pool, ...})` block.

### Subscribers / lists / segments (54 registrations / 191 routes)

* `server.MountSubscriberListSegmentSurface(deps)` owns the complete segment,
  segment-decay, merge-field, subscriber read/merge/profile/growth/write, list
  read/analytics/growth/version/archive/merge-field/webhook/import-export, and
  idempotent list-create registration set. Two of those 54 registrations are
  literal `MountRoutes` calls; all named mount variants are included in the
  group total.
* `main.go` calls ten focused server helpers at the original interleaving
  points. This keeps audiences between the segment and decay mounts,
  subscriber scoring between merge and profile mounts, lifecycle/PII scanning
  before subscriber growth, and list-create plus subscriber writes inside the
  second authenticated router's idempotency stack.
* `server.Deps` promotes only the already-assembled `Subscribers`, `Lists`,
  `IdempotentLists`, `Segments`, and shared `SegmentDecayStore` pointers. The
  primary and idempotent list dependency graphs remain intentionally distinct;
  repositories, AI provider, limiter, event bus, hardened webhook transport,
  and worker-facing decay store retain their original identity.
* Tests compare all 191 method/path pairs and every route middleware's scope
  behavior with the direct pre-migration registrations. Separate contracts pin
  all 54 registration calls in order, inherited authenticated middleware,
  dependency identity, every structural nil case, `server.New`, and the exact
  main.go security-boundary placement.

### Campaigns + sending (35 registrations / 75 routes)

* `server.MountCampaignSendingSurface(deps)` owns the canonical campaign read,
  template library, campaign A/B, send-domain, send-time optimization, sending
  identity, send-window, mutation/preview, compose, dedicated-IP, A/B-create,
  live-send, and queue registrations. Four of the 35 registrations are literal
  `MountRoutes` calls.
* Fourteen focused helpers preserve the live interleavings: analytics remains
  after campaign reads; conversions remain after the template library;
  campaign replies/translations/summaries remain between mutation and compose;
  transactional email plus SMTP remain between live-send and queue.
* The live-send helper owns its directly inseparable
  `write:campaigns + send:transactional` gate while the caller still supplies
  the idempotency-protected authenticated router. All other package scope
  middleware remains unchanged.
* `server.Deps` carries the existing `Campaigns`, `CampaignTemplates`,
  `CampaignABTests`, `SendTimeOptimization`, audience-count, send-preview, and
  live-send dependency pointers. This preserves repositories, the late-bound
  reply counter, warmup gates, suppression store, and provider clients shared
  with workers and adjacent routes.
* Tests mechanically compare all 75 method/path pairs and their route
  middleware across eight scope combinations with the direct registrations.
  Additional contracts pin all 35 registrations, helper/adjacent order,
  inherited authenticated middleware, dependency identity, every structural
  nil case, `server.New`, the idempotent placement, and the exact ledger.

### Identity / API surface (48 registrations / 87 routes)

* `server.MountIdentityAPISurface(deps)` owns the password/email-token, OAuth,
  PKCE/device-grant, authenticated session/TOTP, admin IP, API-key lifecycle,
  MCP execution/quota, OpenAPI document, scoring, audit-sink, SCIM, internal
  KMS, and spam-corpus registrations. Five of the 48 registrations are literal
  `MountRoutes` calls; OAuth contributes two optional routes when configured.
* Fourteen focused helpers retain the live security boundaries and interleaving:
  public auth remains outside tenant middleware; session routes remain inside
  the primary authenticated group; SCIM administration remains inside the
  idempotency-protected group; SCIM provisioning keeps its own bearer/region
  middleware on the root router; internal KMS/corpus routes remain top-level.
* `server.Deps` promotes the existing auth, OAuth, API-key, API-call,
  audit-sink, SCIM, KMS, and spam-corpus dependency pointers plus the exact
  distributed brute-force middleware function. Repositories, recorders,
  OAuth state, encryption, region lookup, and worker-facing stores therefore
  retain identity; pool-only admin-IP and scoring graphs remain freshly built.
* Tests mechanically compare all 87 method/path pairs, every regular API scope
  response across six scope sets, exact SCIM bearer placement, and the eleven
  brute-force-limited short-code/credential routes. Additional contracts pin
  all 48 registrations in order, dependency identity, every structural nil
  case, OAuth-disabled behavior, `server.New`, and exact main.go placement.

### Tenant governance (39 registrations / 60 routes)

* `server.MountTenantGovernanceSurface(deps)` owns workspace security and send
  defaults, paid-membership administration, outbox DLQ replay, feedback and
  region reads, email render preview, the complete privacy/incident/tabletop
  workflow, DPA download, compliance attestations, agency administration, cost
  ledger, and billing dashboard routes.
* Three focused helpers preserve the live interleaving: tenant policy precedes
  privacy/compliance; the independently scoped audit-sink surface remains
  between compliance and commercial administration; approvals still follow
  billing. `NewAuditSinkAdminDeps` centralizes the existing encrypt/decrypt
  identity without changing that registration boundary.
* `server.Deps.TenantGovernance` carries only already-assembled handlers whose
  repositories are shared with billing webhooks, privacy workers, or public
  paid-content routes. Pool-only compliance, DPA, and agency graphs remain
  freshly constructed with the same pool, logger, and environment values.
* Tests mechanically compare all 60 method/path pairs and middleware outcomes
  with the direct registrations. Additional contracts pin all 39 registration
  calls in order, authenticated-router inheritance, dependency identity, every
  structural nil case, `server.New`, and exact main.go placement.

### Audit operations (48 registrations / 48 routes)

* `server.MountAuditOperationsSurface(deps)` owns the complete authenticated
  audit read/export/stream/saved-view/retention/NLQ surface, role and scope
  administration, Merkle proofs, replay/anomaly/investigation views, AIVS and
  redaction evidence, async and scheduled exports, access requests, and portal
  session administration.
* The surface remains between API-key administration and MCP composition on
  the same authenticated tenant router. One shared audit-read gate and the
  existing per-route meta-audit wrappers preserve every read/admin/retention/
  configure-sinks distinction and their original registration order.
* `server.Deps.AuditOperations` promotes only the existing `AuditHandlers` and
  `AuditPortalHandlers` pointers, retaining the NLQ, cipher, manifest writer,
  public-portal, and export-worker identities. RBAC, proof, investigation, and
  store handlers are still assembled from the same pool and logger.
* Tests mechanically compare all 48 method/path pairs and middleware outcomes
  with the direct registrations. Additional contracts pin all 48 registration
  calls in order, dependency identity, structural nil behavior, authenticated
  router inheritance, `server.New`, and exact main.go placement.

### Audience activation (5 registrations / 30 routes)

* `server.MountAudienceActivationSurface(deps)` owns audience-sync CRUD and
  run history, credentialed audience destinations, reverse-ETL write-back, and
  consent-firewall preview, receipt, and compliance routes in their original
  registration order.
* `server.Deps.AudienceActivation` carries only the existing suppression
  store, secrets resolver, SSRF-safe HTTP client, Klaviyo credential store,
  HTTPS posture, and receipt-signing configuration. Optional integrations keep
  their previous degraded-mode behavior.
* The helper returns one typed `AudienceActivationSurface`; the audience
  scheduler, provider-diagnostics poller, write-back scheduler, and zero-copy
  worker consume its exact repo, adapter registry, runner, firewall, receipt
  store, signing key, and write-back graph identities.
* Tests mechanically compare all 30 method/path pairs and scope middleware
  outcomes with the direct registrations. Additional contracts pin all five
  registrations, authenticated-router inheritance, construction and worker
  identity, unsigned-receipt warning behavior, optional/structural nil cases,
  `server.New`, and exact main.go placement.

### Customer support integrations (3 registrations / 77 routes)

* `server.MountSupportIntegrationsSurface(deps)` owns the Customer Hub service
  suite, authenticated support-provider administration, and credentialed
  provider callback registrations in their original order on the existing
  authenticated router.
* `server.Deps.SupportIntegrations` carries only the shared subscriber repo,
  secrets resolver, managed Salesforce credential store, and explicit public
  provider configuration. The server helper constructs one service-suite repo,
  support repo, event/flow sink, and the 26 native provider clients.
* The returned `SupportIntegrationsSurface` exposes that exact HTTP dependency
  graph and an ordered 26-provider backfill inventory.
  `workers.StartSupportIntegrationBackfills` consumes those identities, so no
  worker can silently diverge from the routes' repository, credentials,
  provider client, logger, or cancellation context.
* Tests mechanically compare all 77 method/path pairs and middleware outcomes
  with the direct pre-migration registrations. Additional contracts pin
  registration order, authenticated-router inheritance, every dependency and
  worker identity, structural/optional nil behavior, `server.New`, and exact
  main.go placement.

### Review, loyalty, and subscription integrations (7 registrations / 65 routes)

* `server.NewCustomerLifecycleIntegrationsSurface(deps)` assembles one typed
  graph for the native reviews product surface plus review, loyalty, and
  subscription provider administration and credentialed callbacks.
* Three focused mount helpers preserve the original startup interleaving:
  review routes precede review workers, loyalty routes precede loyalty workers,
  and subscription routes precede subscription workers. Their method/path,
  middleware, and scope inventory is unchanged.
* The graph retains the exact review-media store, subscriber repo, product
  event/flow fanout, secret resolver, repositories, and provider clients. The
  distinct Yotpo, Smile, and Recharge worker backfillers remain separate from
  the matching HTTP dependency values, exactly as in the former composition
  root.
* `workers.StartReviewIntegrationBackfills`,
  `StartLoyaltyIntegrationBackfills`, and
  `StartSubscriptionIntegrationBackfills` own the ordered 9, 5, and 9 native
  provider launches. Tests pin all 65 routes, scope outcomes, dependency and
  worker inventories, structural nil behavior, `server.New`, and exact main.go
  placement.

### Commerce, CRM, lead, and marketing integrations (8 registrations / 117 routes)

* `server.NewProviderIntegrationsSurface` owns the complete shared repository,
  credential-resolver, OAuth, webhook, subscriber-profile, list-membership,
  product-event, and provider-client graph for commerce, CRM, lead capture, and
  marketing integrations.
* Four focused mount helpers retain the original trust boundaries: 66
  authenticated routes, one abuse-limited OAuth callback, 38 signed provider
  callbacks outside the human-form limiter, and 12 Shopify signed-state/HMAC
  callbacks outside tenant middleware.
* The surface preserves the shared pool, envelope cipher and legacy key,
  subscriber repository, secrets resolver, logger, Shopify configuration, and
  provider OAuth environment values. Its repositories and dependency graphs
  are reused unchanged by the provider-worker cohort below.
* Tests mechanically compare all 117 method/path pairs and middleware/scope
  outcomes with the direct registrations, and pin graph identity, optional and
  structural nil behavior, configuration transfer, route order, and exact
  composition-root placement.

### Reporting and compliance tools (17 registrations / 74 routes)

* `server.MountReportingComplianceTools` owns the adjacent authenticated
  export-retention, accessibility, scoring/predictive, goals/cohorts/reports,
  maintenance, consent/privacy/SAR, sender reputation, bot filtering, domain
  warmup, deliverability control, and list-health registrations.
* The helper receives the existing authenticated router plus shared pool,
  logger, and export storage; every package keeps the exact repository and
  dependency construction it had in the composition root.
* The extraction exposed that the OpenAPI-declared partition-rotator run route
  had been treated as reachable only because `main.go` referenced the worker
  package; no handler mount existed. The helper now mounts the operation behind
  an explicit admin scope using the exact same worker instance as the nightly
  runtime, closing the runtime/spec gap and raising the honest gateway audit
  from 2329 to 2330 routes.
* Tests mechanically compare all 74 method/path pairs, middleware counts, and
  scope outcomes with the direct registrations, and pin structural nil
  behavior, registration order, exact main.go placement, and the partition
  operation's denied-without-admin / handler-reachable-with-admin behavior.

### Subscriber protection and campaign utilities (12 registrations / 35 routes)

* `server.MountSubscriberProtectionUtilities` owns email validation, holdouts,
  control groups, duplicate detection/governance, soft-bounce recovery, and
  spam-trap administration. It returns the exact spam-trap worker graph so the
  launch remains interleaved before the campaign utility registrations.
* `server.MountCampaignDeliveryUtilities` then mounts UTM templates,
  recipient-timezone sends, campaign cloning, HTML-to-text conversion, and
  feature flags on the same authenticated router.
* Tests mechanically compare all 35 method/path pairs, middleware counts, and
  scope outcomes with the direct registrations, and pin route order, pool,
  logger and suppression-store identity, structural nil behavior, worker
  placement, and composition-root ownership.

### Analytics integrations (2 registrations / 18 routes; 4 launches)

* `server.NewAnalyticsIntegrationsSurface` assembles the shared repository,
  subscriber-profile/event sinks, Segment secret resolver, and PostHog,
  Triple Whale, Mixpanel, and Amplitude credentialed REST pullers.
* Focused authenticated and public mount helpers preserve the original
  route → worker → public-ingest interleaving. The worker launcher consumes the
  returned graph, so all four providers share the exact HTTP repositories,
  credentials, logger, and cancellation context.
* Tests mechanically compare all 18 method/path pairs, middleware counts, and
  scope outcomes, and pin provider order/types, graph and secret identity,
  structural nil behavior, launch placement, and composition-root ownership.

### Workspace data utilities (12 registrations / 37 routes)

* `server.MountWorkspaceDataUtilities` owns the five workspace/user settings
  surfaces, route-visible retention runner, custom objects/profile links, CDP
  transform preview/apply, AI translations, and Klaviyo migration translators.
* It preserves the shared retention sweeper used by the background worker and
  constructs every repository from the process pool; the translations gateway
  retains the configured voice-service URL and shared logger.
* Tests mechanically compare all 37 method/path pairs, middleware counts, and
  scope outcomes, and pin conditional custom-object registration, exact order,
  structural nil behavior, and composition-root ownership.

### Engagement preferences and legacy webhooks (30 registrations / 30 routes)

* `server.MountEngagementPreferencesAndWebhooks` owns topic preferences,
  subscription types, and the first fourteen legacy outbound-webhook routes on
  the same authenticated router and with their original per-route scopes.
* The returned webhook dependency graph retains the exact repository, envelope
  cipher, outbox, logger, and secure HTTP client identities consumed by the
  alert sender. `server.MountLegacyWebhookReplayRoute` keeps the replay route
  after that worker launch, preserving the prior route → worker → replay order.
* Tests mechanically compare all 30 method/path pairs, middleware counts, and
  scope outcomes with the direct registrations, and pin graph identity,
  structural nil behavior, exact interleaving, and composition-root ownership.

### Collaboration integrations (16 registrations / 16 routes)

* `server.MountCollaborationIntegrations` owns the authenticated Slack webhook,
  Slack workspace/OAuth-start/availability, Discord webhook, and Teams webhook
  surfaces in their original order. The Slack availability probe deliberately
  remains free of a route-level admin scope while the other fifteen routes keep
  their admin gate; the enclosing authenticated group is unchanged.
* The helper consumes the existing Slack, Discord, and Teams repositories and
  exact Slack OAuth dependency graph already shared with dispatchers and public
  signed callback routes. It does not reconstruct or copy secret-bearing state.
* Tests mechanically compare all 16 method/path pairs, middleware counts, and
  scope outcomes with the direct registrations, and pin shared identity,
  legacy nil-logger behavior, structural nil behavior, exact order, and
  composition-root ownership.

### Analytics, realtime, landing pages, and conversions (29 registrations / 31 routes)

* `server.MountAnalyticsRealtimeAndLandingRoutes` owns campaign/dashboard
  reporting, stream-token issuance, live dashboard/events/replay/publish,
  sequence funnel/live campaign metrics, and landing-page CRUD. Heavy-read
  cache middleware and every read-report/read-campaign/admin scope remain on
  the exact routes that carried them before extraction.
* The returned analytics repository is the same instance later consumed by
  the dashboard digest worker; its human-engagement flag, two-second live
  stream poll interval, event bus/replay graph, and process pool are preserved.
  `server.MountConversionAdminRoutes` remains after campaign templates and owns
  the four admin/key routes plus the three attribution routes.
* Tests mechanically compare all 31 method/path pairs, middleware counts, and
  scope outcomes with the direct registrations, and pin shared identity,
  feature flags, intervals, structural nil behavior, exact inter-helper order,
  and composition-root ownership.

### Analytics reporting and asset library (3 registrations / 42 routes)

* `server.MountAnalyticsReportingRoutes` owns the extended analytics and
  reporting surfaces inside their existing heavy-read cache subgroup;
  `server.MountAssetLibraryRoutes` owns both asset and folder registration at
  the original post-analytics position.
* Both helpers construct repositories from the process pool while preserving
  the configured logger, human-engagement flag, and asset-storage identity.
  The returned asset graph remains the exact instance consumed by the adjacent
  reference refresher worker.
* Tests compare all 42 method/path pairs, middleware counts, cache behavior,
  and scope outcomes, and pin dependency identity, structural nil behavior,
  registration order, worker interleaving, and composition-root ownership.

### Sending controls and discovery (15 registrations / 29 routes)

* `server.MountSendingDiscoveryRoutes` owns conditional direct provisioning,
  state/warmup/readiness/pause/resume, frequency caps, intelligent retry,
  trigger-delay preferences, content optimization/remix, global search, and
  both subscriber/campaign and analytics NLQ surfaces.
* The helper consumes the exact sending handlers, intelligent-retry queue,
  trigger-delay repository, audit NLQ gateway/tracker, logger, and process pool;
  the production-only direct-provision decision remains in the composition root
  and is passed as data.
* Tests compare all 29 method/path pairs, middleware counts, and scope outcomes,
  pin the disabled-provision shape and dependency identity, and reject partial
  registration for structurally incomplete graphs.

### Form administration (9 registrations / 15 routes)

* `server.MountFormAdminRoutes` owns embed/snippet routes, all seven
  metrics-wrapped form read/update/delete/export/analytics registrations, and
  form-variant administration. The idempotent form-create route remains in its
  later write group.
* The existing form dependency graph and configured public/API hosts are reused;
  the helper constructs only the variant repository from the shared process
  pool. Tests compare all 15 routes and scope outcomes, and pin metrics-wrapper
  placement, identity, order, nil behavior, and composition-root ownership.

### Editor, send queue, and recommendations (7 registrations / 16 routes)

* `server.MountEditorQueueRoutes` owns the send-queue snapshot/SSE feed,
  merge preview/apply, email-block catalog/compose and saved-block CRUD,
  campaign-template region reads, commerce recommendation previews, and the
  NBP settings/recommendation/syntax surface in their original order.
* The typed surface retains the exact pool, logger, product/coupon resolvers,
  campaign-template dependencies, commerce repository, and newly constructed
  NBP repository/recommender identities. The adjacent NBP builder consumes
  that same repository after all routes mount, preserving worker interleaving.
* Tests mechanically compare all 16 method/path pairs and every scope outcome
  with the former direct registrations. Additional contracts pin dependency
  identity, every structural nil case, source order, and composition-root
  ownership; fail-closed reachability records both transitive `merge` and
  `email_blocks` mounts.

### Platform catalogs (3 registrations / 52 routes)

* `server.MountPlatformCatalogRoutes` owns API-usage reporting, the complete
  developer marketplace/OAuth/reviewer surface, and the native integrations
  catalog facade at their original post-list-health-worker position.
* The API-usage dependency intentionally keeps its former nil logger; the
  marketplace graph retains the review secret, repository, and logger, while
  the integrations facade retains the same pool/logger identity.
* Tests compare all 52 method/path pairs and scope outcomes, and pin identity,
  structural nil behavior, source order, and exact composition-root placement.

### Subscriber and campaign insights (6 registrations / 18 routes)

* `server.MountSubscriberCampaignInsightRoutes` owns subscriber notes and
  attachments, resend-to-non-openers, send-window policy, reply analytics,
  onboarding progress, and subject analysis in their original order after the
  deliverability worker launch.
* Notes retain the shared tenant object store and logger. The other five
  dependency graphs intentionally preserve their former pool-only wiring,
  including the existing focused send-window helper.
* Tests compare all 18 method/path pairs and scope outcomes, pin every exposed
  dependency identity and structural nil boundary, and enforce source/main
  order. Reachability now proves the three-link send-window mount chain.

### User notifications (3 registrations / 11 routes)

* `server.MountUserNotificationRoutes` owns the per-user notification feed,
  browser web-push registration, and native mobile device routes while reusing
  the existing feed repository and push dependency pointers.
* The mobile routes remain inside the exact session-only auth-method group;
  the feed and web-push handlers retain their former handler-level session
  checks and placement before admin-IP configuration.
* Tests compare all routes and middleware boundaries, pin shared identity and
  every structural nil case, and enforce both source and main ordering.

### Subscriber personalization (3 registrations / 6 routes)

* `server.MountSubscriberPersonalizationRoutes` owns per-user subscriber-table
  preferences, manual contact rating/history, and heuristic rating recompute
  and introspection in their original post-merge-field position.
* The user-preference dependency intentionally keeps its former nil logger;
  both rating graphs retain the shared logger and all three repositories use
  the exact process pool.
* Tests compare all six route/scope outcomes, pin graph identity and structural
  nil behavior, and fail closed if any transitive mount-chain link disappears.

### Subscriber import and audit alerts (5 registrations / 18 routes)

* `server.MountImportAuditAlertRoutes` owns the subscriber CSV import wizard,
  audit-alert rule/inbound-webhook surface, and ServiceNow/Jira/PagerDuty
  credential verification routes in their original pre-editor position.
* Import keeps the exact object-storage identity and former nil logger; alert
  rules retain the shared logger, while all three channel handlers use the
  same process pool and configure-sinks scope.
* Tests compare all 18 routes across admin, audit-read, and configure-sinks
  scopes, and pin dependency identity, structural nil behavior, and order.

### CRM reference objects (2 registrations / 10 routes)

* `server.MountCRMReferenceRoutes` owns account/company and workspace reference
  collection CRUD immediately after custom-field settings. Both repositories
  retain the shared pool/logger and subscriber read/write scope split.
* Tests compare all ten routes and middleware outcomes, pin dependency identity
  and nil behavior, and enforce composition-root ownership.

### Authored brand voice (1 registration / 2 routes)

* `server.MountBrandVoiceRoutes` owns authored voice-profile read/write routes
  at the original voice-proxy interleaving point. The graph intentionally keeps
  its former pool-only, nil-logger wiring; package-level reads used by AI compose
  and drift enrichment remain unchanged in `main.go`.
* Tests pin both scope outcomes, identity, structural nil behavior, and order.

### Lookalike audiences (1 registration / 4 routes)

* `server.MountLookalikeAudienceRoutes` owns first-party lookalike audience
  create/read/member/delete registration at the exact segment → audience →
  decay interleaving point. Its repository and optional logger retain the
  shared process identities.
* Tests compare all four subscriber read/write scope outcomes, pin dependency
  identity and structural nil behavior, and prevent composition from returning
  to `main.go`.

### Messaging and engagement (6 registrations / 93 routes)

* `server.MountMessagingEngagementRoutes` owns SMS configuration/compliance,
  push-token suppressions, campaign content-optimizer runs, social capture,
  and both SMS conversation-inbox registration sets in their original order.
* The helper reuses the exact SMS and social-capture graphs, while constructed
  suppression and optimizer dependencies retain the shared pool/logger and
  optimizer repository identity.
* Tests mechanically compare all 93 method/path pairs across six scope classes,
  and pin dependency identity, every structural nil case, registration order,
  and composition-root ownership.

### Web and domain tools (4 registrations / 11 routes)

* `server.MountWebDomainToolRoutes` owns DMARC reporting/acknowledgement,
  template preview, custom-domain CRUD/verification, and campaign link checks
  at the original inbound-email → tools → archive interleaving point.
* All four graphs retain the exact process pool and intentionally preserve
  their former nil logger/client wiring; custom domains still construct the
  canonical default resolver once at registration.
* Tests compare all 11 method/path and read/admin scope outcomes, pin graph
  shape and structural nil behavior, and enforce source/main ordering.

### Marketing, commerce, CRM, and lead provider workers (50 launches)

* `workers.StartMarketingIntegrationBackfills`,
  `StartCommerceProviderBackfills`, `StartCRMProviderBackfills`, and
  `StartLeadProviderBackfills` own the exact former launch sequence for one
  Klaviyo puller, commerce lifecycle plus flow-run draining and ten commerce
  pullers, twelve CRM pullers plus optional HubSpot webhook reconciliation,
  and twenty-three lead-source pullers. `StartIntelligentRetryWorker` retains
  its original position between marketing and commerce.
* Typed dependency bags carry the existing repositories, handler dependency
  graphs, logger, pool, and automation URL. Provider workers reconstruct the
  same dedicated REST backfiller values from the credential-resolver identities
  already held by the HTTP dependency graphs; static CRM workers retain the
  exact handler-owned backfillers.
* Tests pin all launch names, warning messages, concrete worker types, provider
  order, shared dependency identity, structural nil behavior, and the exact
  composition-root placement. The production module is 418 LoC.

### Operational maintenance workers (12 launches)

* `workers.StartOperationalMaintenanceWorkers` owns scoring, subscriber CSV
  import, predictive recomputation, scheduled reports, audit export and export
  schedules, audit alerts, audit UEBA, tenant exports, and the three audit-sink
  delivery/integrity/key-rotation launches in their original order.
* The typed surface preserves every shared pool, logger, object store, mailer,
  Slack dispatcher, public URL, and envelope-cipher identity. Feature flags
  retain the former environment gates; scheduled reports and exports also keep
  their dependency-presence gates, while audit sinks preserve nil-cipher
  development behavior.
* Tests pin dependency identity, intervals/defaults, structural and optional
  nil behavior, exact launch order, and composition-root ownership. The daily
  predictive implementation now lives with its launcher in the 263-LoC worker
  module.

### Data-retention and privacy workers (7 launches)

* `workers.StartDataRetentionWorkers` owns the audit trimmer, partition
  rotator, shared multi-class retention sweeper, privacy-overdue and GDPR
  incident-clock metrics, privacy-deletion fulfillment, and self-account
  deletion launch order.
* The typed graph reuses the route-visible retention sweeper and preserves the
  tag-history redactor, account-deletion mailer/from address, privacy repo,
  pool, and logger identities. The four historical positive-integer
  environment overrides retain their exact defaults and invalid-value
  behavior.
* Tests pin graph identity, intervals and environment parsing, optional and
  structural nil behavior, notifier construction, exact launch order, and
  composition-root ownership. The production module is 137 LoC.

### Integration-delivery and audience workers (7 launches)

* Three focused launchers preserve the original startup placement for the
  legacy webhook alert sender, outbound webhook bus/delivery/redaction trio,
  and audience-sync/provider-diagnostics/reverse-ETL trio.
* The typed surfaces retain the mounted webhook repository, hardened outbound
  store and event bus, audience activation route surface, adapter registry,
  credential resolver, write-back dependencies, mailer, pool, and logger
  identities. Structural nil boundaries prevent partial graphs while the
  outbound event bus remains intentionally optional.
* Tests pin dependency identity, canonical outbound-worker construction,
  optional behavior, warning/cancellation source contracts, exact launch
  order, and composition-root ownership. The production module is 152 LoC.

### Startup and authenticated-route boundaries

* `startup_configuration.go` owns proxy trust, the fail-closed production
  configuration gate, safego drain registration, and tracing shutdown order.
* `internal/boot/aws.go` owns the shared AWS SDK configuration, KMS/static
  envelope selection and readiness probe, plus the Secrets Manager fallback.
* `internal/boot/events.go` owns the in-process event bus and presence tracker,
  upgrading to Redis cross-replica fan-out when its optional startup succeeds.
* `internal/boot/telemetry.go` owns PostHog selection, noop fallback, status
  logging and best-effort flush/close reporting.
* `internal/boot/database.go` owns the bounded primary-pool open and the
  pool-close/context-cancel shutdown order; `configuration.go` owns boot-only
  development fallback warnings.
* `internal/boot/sending.go` owns regional Postmark client selection plus the
  PostgreSQL state/warmup stores and their explicit memory-fallback policy.
* `internal/boot/uploads.go` owns S3 client/store/presigner selection, the
  production SSE-KMS configuration gate, and the local upload plus in-memory
  warehouse fallback. Its typed result retains the shared S3 client for later
  asset-storage wiring even when form uploads use the development fallback.
* `authenticated_route_stack.go` owns the invariant API-key → tenant → route
  policy → impersonation → admin-IP → audit-scope → MFA → region sequence used
  by both authenticated route groups. Tests reject direct security-stack mounts
  in `main.go` so a third group cannot silently drift.
* `audit_rbac_middleware.go` owns the path-gated dashboard-role scope lookup
  formerly embedded in `composition_adapters.go`.
  `event_billing_notification_adapters.go` now owns the cohesive event-bus,
  billing, mailer, push, and notification bridge cohort. The original adapter
  file is 1748 LoC and therefore uses the default ≤2000-line source budget;
  the extracted file is 804 LoC.

## Migration recipe (per mount block)

For each `pkg.MountRoutes(r, &pkg.Deps{...})` call in main.go:

1. **Read the block.** Identify every field on `pkg.Deps` (Pool, Bus, Logger,
   custom clients, in-process repos, …).
2. **Promote shared fields to `server.Deps`.** Pool/Bus/Logger are already
   present. For new dependencies (e.g. `S3Client`, `KMS`, `RedisAuditQueue`),
   add a typed field on `server.Deps`. Make optional fields nilable so
   degraded-mode boot keeps working.
3. **Add `server.MountFoo(deps Deps)`** that constructs `&foo.Deps{...}` from
   `deps` and calls `foo.MountRoutes(deps.Router, fooDeps)`. Guard against
   `nil` Pool / Router up front.
4. **Wire it from `server.New`.** Append `MountFoo(deps)` to the call list.
5. **Replace the inline block in main.go** with a single
   `apiserver.MountFoo(apiserver.Deps{Router: r, Pool: pool, ...})` call. (Or
   delete it entirely once `server.New` is invoked from main.go for every
6. **Build + run targeted tests:**
   ```
   cd apps/api && go build ./internal/server/... ./internal/<pkg>/...
   go test ./internal/<pkg>/...
   ```

## Migration recipe (per worker)

For each `safego.Go(logger, "name", func() { (&pkg.Worker{...}).Run(ctx) })`:

1. Add an entry to `workers.Registered(deps)` building the same
   `&pkg.Worker{...}` value from `deps`.
2. The worker's `ctx` becomes the one `workers.Run` receives — main.go must
   pass a cancellable context (today, `outboxCtx`).
3. Delete the inline `safego.Go(...)` block in main.go.

## Function-by-function breakdown

The headers below correspond to ranges in main.go (`wc -l = 5231`). Numbers
drift as small fixes land; treat them as orientation, not exact line cites.

### Boot / process setup → `internal/boot/boot.go`

| main.go range | Concern | Target |
|--------------:|---------|--------|
| 1-200         | Imports + package doc | (stays in main.go, but pruned as mounts move) |
| 200-660       | Env loading, slog setup, sentinel checks, AWS clients (`secretsmanager`, `kms`, `s3`), config decode | `boot.Init` (sub-helpers: `boot.loadAWS`, `boot.loadConfig`) |
| 660-720       | pgxpool + events bus + redis backend | `boot.Init` (already partially modelled) |
| 720-880       | OTel tracer + meter providers, Sentry, prometheus registry | `boot.initObservability` (calls into `packages/runtime/observability`) |
| 877-895       | `outboxCtx` + outbox / intelligent-retry / commerce-lifecycle workers | `workers.Run` (workers, not boot) |

### Route mounts → `internal/server/server.go`

The 155 literal `MountRoutes(...)` call sites are tracked by the Phase 1
inventory above. Named mount variants are included in the completed group's
registration count. The route surface splits into the following groups; each
group should migrate as one reviewable unit:

1. **deliverability surface** ✅ migrated — `dns_health`,
   `deliverability_hub`, `firewall_attack_mode`,
   `freq_caps`, `from_name_picker`, `inactive_keys`,
   `preset_segments`, `growth_source`, `isp_breakdown`,
   `campaign_benchmarks`, `campaign_to_template`, `tag_taxonomy`.
2. **subscribers / lists / segments** ✅ migrated — `subscribers`, `lists`,
   `segments`, `merge_fields`, subscriber bulk operations, list archive, and
   subscriber/list import-export surfaces (54 registrations / 191 routes).
3. **campaigns + sending** ✅ migrated — `campaigns`, `campaigntemplates`,
   `sending`, `sending_identity`, `send_window`, `send_time_opt`, and
   `ab_tests` (35 registrations / 75 routes).
4. **identity / API surface** ✅ migrated — `auth`, `apikeys`, `apikeycalls`,
   `apidocs`, `scim`, `admin`, `admin_ip`, `scoring`, and `auditsink`
   (48 registrations / 87 routes).
5. **tenant governance** ✅ migrated — workspace security/send settings,
   paid members, DLQ, privacy/incidents/DPA, compliance, agency, costs, and
   billing (39 registrations / 60 routes).
6. **audit operations** ✅ migrated — authenticated audit reads/exports, RBAC,
   proofs, investigations, evidence bundles, access requests, and portal admin
   (48 registrations / 48 routes).
7. **audience activation** ✅ migrated — `audience_destinations`,
   `integration_writeback`, and `activation_firewall` control-plane routes
   (5 registrations / 30 routes); the returned graph remains shared with
   adjacent schedulers and zero-copy activation.
8. **automation + flows** (lines ~3400-3900) — `approvals`, `automationclient`,
   `digest_runner`, `scheduled_reports`, `send_guard`.
9. **AI / agents** (lines ~4000-4400) — `ai_subject_lines`, `aicompose`,
   `ai_segment_compiler`, `aeo`, `affiliates`.
10. **compliance / observability remainder** (lines ~4500-5000) —
   `audit_alerts`, `archive_bar`, and `archive_comments`; compliance moved with
   tenant governance, audit reads moved with audit operations, and audit-sink
   composition moved with identity/API.
11. **deliverability proxies + external service forwarders** (lines ~3490-3700) —
   `deliverabilityProxy`, inbox-reality, reputation, auth-checks, diagnose.
12. **agency / paid tiers remainder** (lines ~5100-5500) — `affiliates` and
    adjacent paid-tier surfaces; agency and billing moved with tenant governance.
13. **everything else** (lines ~5500-7000) — remaining one-off surfaces
    discovered as we walk top-to-bottom; expect 1–2 ad hoc PRs.

### Workers → `internal/workers/workers.go`

The 51 literal `safego.Go(...)` call sites still in `main.go` group similarly;
migrated launchers live in `internal/workers` and are not included in this
remaining-body count:

| main.go line | Worker | Status |
|-------------:|--------|--------|
| 879 | `outbox-worker` | pending |
| 887 | `intelligent-retry-worker` | pending |
| 891 | `commerce-lifecycle-worker` | pending |
| 910 | `ip-snapshot-worker` | pending |
| 925 | `blocklist-auto-suppress` | pending |
| 950 | `double-optin-purger` | pending |
| 971 | `campaign-scheduler` | pending |
| 981 | `sms-worker` | pending |
| 1054 | `send-guard-loop` | pending |
| 1065 | `send-guard-stuck-recovery` | pending |
| 1112 | `ab-test-scheduler` | pending |
| 1128 | `digest-runner` | pending |
| 1142 | `inbound-route-matches-retention` | pending |
| 1270 | `approvals-escalation-sweeper` | pending |
| 1278 | `subscriber-churn-scorer` | pending |
| 1349 | `sandbox-flusher` | pending |
| 1352 | `approvals-expiry-sweeper` | pending |
| 1814 | `apikeycalls-retention-sweeper` | pending |
| 2294 | `assets-references-refresher` | pending |
| 2306 | `dashboard-digest-sender` | pending |
| 3313 | `deliverability-hub-worker` | launch wrapper migrated; `Registered` consolidation pending |
| ~6100 | `spam-trap-guard-worker` | launch wrapper migrated; `Registered` consolidation pending |
| ~5569 | operational maintenance cohort (12 launches) | migrated behind typed surface |
| ~5490 | data-retention/privacy cohort (7 launches) | migrated behind typed surface |
| ~3400 | integration-delivery/audience cohort (7 launches) | migrated behind typed surfaces |
| … 32 more (run `grep -nE '^[[:space:]]*safego\.Go\(' apps/api/main.go`) | pending |

### Graceful shutdown (lines ~7000-7136)

The shutdown block (signal handler, `outboxCancel`, `srv.Shutdown`,
`pool.Close`) moves to a `boot.Close(deps)` + a top-level
`defer boot.Close(deps)` in `main.go`. Lifecycle ordering today:

1. Stop accepting new HTTP requests (`server.Shutdown` with a deadline).
2. Cancel `outboxCtx` to stop workers (`workers.Run` returns when all
   spawned goroutines drain).
3. Flush OTel exporter, Sentry.
4. Close the pgxpool.

`workers.Run` already blocks until `ctx` is cancelled and every worker
returns, so the only new wiring is the order: HTTP shutdown → cancel workers
ctx → wait for `workers.Run` to return → close obs + pool.

## Verification gates

After each migration PR, the following must pass:

```
cd apps/api && go build ./...               # the whole binary must compile
cd apps/api && go test ./internal/<pkg>/... # affected package tests
```

Use the targeted form from CLAUDE.md (`go build ./internal/server/...`) for
fast inner-loop iteration. The CI pipeline already runs the full build +
linter, so a green local build is necessary but not sufficient.

## Deferred / out of scope

* **Splitting `main.go` itself into multiple files** (e.g. `main.go` +
  `routes_subscribers.go` in the same package): explicitly out — the migration
  goal is to move logic into `internal/{server,boot,workers}`, not to shuffle
  files inside `package main`.
* **Replacing chi.Router** with a different router or restructuring the route
  tree: out of scope.
* **Re-naming public route paths**: out of scope; the migration is a no-op for
  external callers.
* **Touching `apps/api/internal/deliverability_hub` internals**: the migration
  only touches the *registration* of the package, never its body.
