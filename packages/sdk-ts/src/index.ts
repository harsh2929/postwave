/**
 * @postwave/sdk — first-party TypeScript SDK for the Moosewave API.
 *
 * Quickstart:
 *
 *   import { PostwaveClient } from "@postwave/sdk";
 *
 *   const pw = new PostwaveClient({
 *     apiKey: process.env.POSTWAVE_API_KEY!,
 *     tenantId: "acme",
 *   });
 *
 *   const seq = await pw.sequences.generate({
 *     template_id: "tpl_welcome_3",
 *     name: "Welcome series",
 *   });
 */

export { PostwaveClient } from "./client.js";
export type {
  PostwaveClientOptions,
  RequestOptions,
  FetchFn,
} from "./client.js";

export {
  PostwaveError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  RateLimitError,
  ServerError,
  NetworkError,
  TimeoutError,
  RequestAbortedError,
  WrongRegionError,
  ParseError,
} from "./errors.js";
export type { PostwaveResponseMetadata, SendingCapOutcome } from "./errors.js";

export {
  verifySignature,
  computeSignatureHex,
  computeSignatureHeader,
} from "./webhook.js";
export type { VerifyWebhookOptions } from "./webhook.js";

export * from "./types.js";

export { MobilePushResource } from "./resources/mobile-push.js";
export type {
  MobilePushDeviceKeyInput,
  MobilePushDeviceRegistrationInput,
  MobilePushDeviceResponse,
  MobilePushPlatform,
  MobilePushQuietHours,
  MobilePushQuietHoursInput,
  MobilePushTestResult,
} from "./resources/mobile-push.js";

export { CampaignsABResource } from "./resources/campaigns-ab.js";
export { CampaignsResource } from "./resources/campaigns.js";
export { CampaignAssuranceResource } from "./resources/campaign-assurance.js";
export { CampaignPollsResource } from "./resources/campaign-polls.js";
export type {
  CampaignPollDefinition,
  CampaignPollDefinitionOption,
  CampaignPollList,
  CampaignPollListOptions,
  CampaignPollMaterializationInput,
  CampaignPollOptionTally,
  CampaignPollTally,
} from "./resources/campaign-polls.js";
export {
  ConversionIngestResource,
  computeConversionEmailHMACSHA256,
  computeConversionIngestSignatureHeader,
  computeConversionIngestSignatureHex,
} from "./resources/conversion-ingest.js";
export {
  AmbiguousConversionIngestSecretIssueError,
  CONVERSION_INGEST_SECRET_AMBIGUOUS_ISSUE_RECOVERY,
  CONVERSION_INGEST_SECRET_NOTICE,
  ConversionIngestSecretsResource,
} from "./resources/conversion-ingest-secrets.js";
export type {
  ConversionEmailHMACProjectionErrorCode,
  ConversionEmailHMACProjectionStatus,
  ConversionIngestSecretIssueOptions,
  ConversionIngestSecretListOptions,
  ConversionIngestSecretPage,
  ConversionIngestSecretSummary,
  IssuedConversionIngestSecret,
} from "./resources/conversion-ingest-secrets.js";
export type {
  SignedConversionCredentials,
  SignedConversionIdentity,
  SignedConversionIngestOptions,
  SignedConversionInput,
  SignedConversionReceipt,
} from "./resources/conversion-ingest.js";
export type {
  CampaignAssuranceAppealDecision,
  CampaignAssuranceAppealInput,
  CampaignAssuranceAppliedRevision,
  CampaignAssuranceApplyFindingInput,
  CampaignAssuranceApplyFindingResult,
  CampaignAssuranceApplyOptions,
  CampaignAssuranceApplicability,
  CampaignAssuranceEnvelope,
  CampaignAssuranceEvidence,
  CampaignAssuranceEvidenceParams,
  CampaignAssuranceExtraction,
  CampaignAssuranceExtractionStatus,
  CampaignAssuranceFinding,
  CampaignAssuranceGateDecision,
  CampaignAssuranceLatest,
  CampaignAssuranceManifest,
  CampaignAssuranceMeasurement,
  CampaignAssuranceMutationOptions,
  CampaignAssuranceOverride,
  CampaignAssurancePage,
  CampaignAssurancePatchApplication,
  CampaignAssuranceProfile,
  CampaignAssuranceProgressSnapshot,
  CampaignAssuranceRun,
  CampaignAssuranceRunArtifact,
  CampaignAssuranceRunConfiguration,
  CampaignAssuranceRunDetail,
  CampaignAssuranceRunState,
  CampaignAssuranceRunTarget,
  CampaignAssuranceSourceClass,
  CampaignAssuranceSourceDisclosure,
  CampaignAssuranceStartRun,
  CreateCampaignAssuranceRunInput,
  FactContractCriticality,
  FactContractDateTimeValueV1,
  FactContractFactType,
  FactContractIntentKind,
  FactContractMoneyValueV1,
  FactContractNumberValueV1,
  FactContractPrimaryActionRole,
  FactContractRequiredFactV1,
  FactContractSecondaryActionRole,
  FactContractV1,
  FactContractV1OrEmpty,
  SetFactContractOptions,
  SetFactContractResult,
} from "./resources/campaign-assurance.js";
export { CampaignTemplatesResource } from "./resources/campaign-templates.js";
export { EmailsResource } from "./resources/emails.js";
export type {
  SendEmailInput,
  SendEmailResult,
  EmailRecord,
  EmailAttachment,
  EmailTag,
} from "./resources/emails.js";
export type {
  Campaign,
  CampaignDirectAttributionEvidenceItem,
  CampaignDirectAttributionEvidenceListOptions,
  CampaignDirectAttributionEvidencePage,
  CampaignDirectAttributionEvidencePageInfo,
  CampaignDirectAttributionEvidenceSummary,
  CampaignStatus,
  CreateCampaignInput,
  UpdateCampaignInput,
  CampaignQueueResponse,
  CampaignSendOptions,
  SendTestEmailInput,
  SendTestEmailResponse,
} from "./resources/campaigns.js";
export { decodeCampaignDirectAttributionEvidencePage } from "./resources/campaigns.js";
export type {
  AdaptCampaignTemplateInput,
  CampaignTemplate,
  CampaignTemplateCapabilities,
  CampaignTemplateCatalogFacets,
  CampaignTemplateDesignCapabilities,
  CampaignTemplateDesignDraft,
  CampaignTemplateDesignListParams,
  CampaignTemplateDesignMode,
  CampaignTemplateDesignMutationOptions,
  CampaignTemplateDesignOutput,
  CampaignTemplateDesignPage,
  CampaignTemplateDesignRecommendedAction,
  CampaignTemplateDesignRecoveryStatus,
  CampaignTemplateDesignRevision,
  CampaignTemplateDesignStatus,
  CampaignTemplateDesignSummary,
  CampaignTemplateDesignValidation,
  CampaignTemplateDesignValidationCheck,
  CampaignTemplateFacetValue,
  CampaignTemplateGoal,
  CampaignTemplateKind,
  CampaignTemplateOwnershipSource,
  CampaignTemplateRecommendedAction,
  CampaignTemplateRevision,
  CampaignTemplateRevisionListParams,
  CampaignTemplateRevisionPage,
  CampaignTemplateRevisionSummary,
  CampaignTemplateRevisionTransition,
  CampaignTemplateReviewStatus,
  CampaignTemplateSearchParams,
  CampaignTemplateSearchResponse,
  CampaignTemplateSource,
  CampaignTemplateSummary,
  CampaignTemplateVariable,
  CampaignTemplateWarning,
  CloneCampaignTemplateInput,
  CommitCampaignTemplateDesignInput,
  CreateCampaignFromDesignInput,
  CampaignFromTemplateResult,
  CreateCampaignFromTemplateInput,
  CreateCampaignTemplateDesignInput,
  CreateCampaignTemplateInput,
  GenerateCampaignTemplateInput,
  RefineCampaignTemplateDesignInput,
  SaveCampaignTemplateDesignInput,
  UpdateCampaignTemplateInput,
  WaitForCampaignTemplateDesignOptions,
} from "./resources/campaign-templates.js";
export type {
  Variant as CampaignVariant,
  VariantResult as CampaignVariantResult,
  ABSettings as CampaignABSettings,
  ABView as CampaignABView,
  WinnerMetric as CampaignWinnerMetric,
  SetABSettingsInput as CampaignSetABSettingsInput,
} from "./resources/campaigns-ab.js";

export { PreferencesResource } from "./resources/preferences.js";
export type {
  Topic,
  CreateTopicInput,
  UpdateTopicInput,
  SubscriberTopicView,
  TopicOptIn,
  PreferenceLookupResponse,
} from "./resources/preferences.js";

export { WebhooksResource } from "./resources/webhooks.js";
export type {
  WebhookDelivery,
  WebhookDeliveryPage,
  WebhookCreateResponse,
  WebhookListPage,
  WebhookReplayResponse,
  WebhookTestResult,
} from "./resources/webhooks.js";

export { EventsResource } from "./resources/events.js";
export type { EventRecord, StreamParams } from "./resources/events.js";

export { AccountResource } from "./resources/account.js";
export type {
  AccountDeletionDisclosure,
  AccountDeletionRequest,
  AccountDeletionResponse,
  AccountDeletionStatusResponse,
  AccountUpdateInput,
  DeleteOwnAccountInput,
  WorkspaceSettings,
} from "./resources/account.js";
export { ACCOUNT_DELETION_CONFIRMATION } from "./resources/account.js";

export { SegmentsResource } from "./resources/segments.js";
export type {
  Segment,
  SegmentNode,
  CreateSegmentInput,
  CompileFromTextResponse,
} from "./resources/segments.js";

export { APIKeysResource, API_KEY_SCOPES } from "./resources/api-keys.js";
export type {
  APIKey,
  APIKeyScope,
  CreateAPIKeyInput,
  CreateAPIKeyResponse,
} from "./resources/api-keys.js";

export { TopicsResource } from "./resources/topics.js";
export type { TopicCreateInput } from "./resources/topics.js";

export { AuditResource } from "./resources/audit.js";
export type {
  AuditEntry,
  AuditQueryParams,
  AuditQueryResponse,
} from "./resources/audit.js";

export { ApprovalsResource } from "./resources/approvals.js";
export type {
  Approval,
  ApprovalStatus,
  ApprovalListParams,
  ApprovalListPage,
  ApprovalDecisionInput,
} from "./resources/approvals.js";

export { SandboxResource } from "./resources/sandbox.js";
export type { SandboxEvent, SandboxStatus } from "./resources/sandbox.js";

export { CostResource } from "./resources/cost.js";
export type {
  CostBucket,
  CostGroupBy,
  CostAggregateInput,
  CostAggregateResponse,
} from "./resources/cost.js";

export { SafetyResource } from "./resources/safety.js";
export type {
  SafetyCheckInput,
  SafetyCheckResponse,
  SafetyFinding,
} from "./resources/safety.js";

export { AudienceDestinationsResource } from "./resources/audience-destinations.js";
export type {
  AudienceDestination,
  AudienceDestinationCreateInput,
  AudienceDestinationJob,
  AudienceDestinationJobDiagnostics,
  AudienceDestinationJobDiagnosticsResponse,
  AudienceDestinationJobsResponse,
  AudienceDestinationListResponse,
  AudienceDestinationPreview,
  AudienceDestinationProvider,
  AudienceDestinationProvidersResponse,
  AudienceDestinationReadiness,
  AudienceDestinationStatus,
  AudienceDestinationSyncResponse,
  AudienceDestinationUpdateInput,
} from "./resources/audience-destinations.js";
export { AudienceSyncsResource } from "./resources/audience-syncs.js";
export type {
  AudienceSync,
  AudienceSyncCreateInput,
  AudienceSyncDestination,
  AudienceSyncListResponse,
  AudienceSyncRun,
  AudienceSyncRunsResponse,
  AudienceSyncSchedule,
  AudienceSyncSource,
  AudienceSyncUpdateInput,
} from "./resources/audience-syncs.js";

export { AIComposeResource } from "./resources/ai-compose.js";
export type {
  CampaignDraft,
  ComposeBroadcastInput,
  ComposeBroadcastOutput,
  ComposeVariantsInput,
  ComposeVariantsOutput,
} from "./resources/ai-compose.js";

export { AudiencesResource } from "./resources/audiences.js";
export type {
  CreateLookalikeInput,
  LookalikeMember,
  LookalikeMemberPage,
  LookalikeMembersOptions,
  LookalikeModel,
  LookalikeStatus,
} from "./resources/audiences.js";

export { IntegrationsResource } from "./resources/integrations.js";
export type {
  IntegrationActionResponse,
  IntegrationAuditTrailEntry,
  IntegrationBadge,
  IntegrationBlueprint,
  IntegrationCatalogItem,
  IntegrationCatalogQuery,
  IntegrationCatalogResponse,
  IntegrationCapability,
  IntegrationCategory,
  IntegrationCategoryCoverage,
  IntegrationConnection,
  IntegrationConnectionsResponse,
  IntegrationConnectorContract,
  IntegrationCoverageReport,
  IntegrationCustomerStackCoverage,
  IntegrationDataDeleteAction,
  IntegrationDetailResponse,
  IntegrationFieldMapping,
  IntegrationHealthCheck,
  IntegrationHealthReport,
  IntegrationLifecycleAction,
  IntegrationPriorityGap,
  IntegrationReadinessCheck,
  IntegrationReadinessIssue,
  IntegrationReadinessReport,
  IntegrationRecipe,
  IntegrationRecipeApplyResponse,
  IntegrationRecipeDetailResponse,
  IntegrationRecipesQuery,
  IntegrationRecipesResponse,
  IntegrationRetryPolicy,
  IntegrationRuntimeStatus,
  IntegrationSetupStep,
  IntegrationStackComponent,
  IntegrationStackGap,
  IntegrationStackReport,
  IntegrationSyncHistoryEntry,
} from "./resources/integrations.js";

export {
  AnalyticsNativeIntegrationsResource,
  CommerceNativeIntegrationsResource,
  LeadNativeIntegrationsResource,
  NativeIntegrationFamilyResource,
  NativeIntegrationsResource,
  SUPPORT_INTEGRATION_RUNTIME_HELD_CODE,
  SubscriptionNativeIntegrationsResource,
  SupportNativeIntegrationsResource,
  WarehouseNativeIntegrationsResource,
} from "./resources/native-integrations.js";
export type {
  AnalyticsEventInput,
  AnalyticsIntegration,
  AnalyticsIntegrationInput,
  AnalyticsProfileInput,
  AnalyticsProviderField,
  AnalyticsProviderSpec,
  AnalyticsSyncRequest,
  AnalyticsSyncRun,
  AnalyticsSyncRunsResponse,
  AnalyticsSyncSummary,
  CommerceNativeIntegration,
  CommerceDisconnectCleanupEvidence,
  CommerceDisconnectResponse,
  CommerceNativeIntegrationCreateInput,
  CommerceNativeProviderSpec,
  CommerceNativeSyncInput,
  CommerceNativeSyncSummary,
  CRMSyncRequest,
  LeadIntegration,
  LeadIntegrationInput,
  LeadProviderSpec,
  LeadSubmissionInput,
  LeadSyncRequest,
  LeadSyncRun,
  LeadSyncRunsResponse,
  LeadSyncSummary,
  LoyaltyEventInput,
  LoyaltySyncRequest,
  ManagedNativeIntegrationInput,
  NativeIntegration,
  NativeIntegrationAuthMode,
  NativeIntegrationCreateInput,
  NativeIntegrationFamilyPaths,
  NativeIntegrationFieldKind,
  NativeIntegrationIngestInput,
  NativeIntegrationIngestResponse,
  NativeIntegrationLifecycleInput,
  NativeIntegrationLifecycleResponse,
  NativeIntegrationListResponse,
  NativeIntegrationProviderField,
  NativeIntegrationProviderListResponse,
  NativeIntegrationProviderSpec,
  NativeIntegrationRun,
  NativeIntegrationRunsResponse,
  NativeIntegrationSyncSummary,
  ReviewInput,
  ReviewSyncRequest,
  SubscriptionInput,
  SubscriptionIntegration,
  SubscriptionIntegrationInput,
  SubscriptionLifecycleEventInput,
  SubscriptionProviderSpec,
  SubscriptionShipmentInput,
  SubscriptionSyncRequest,
  SubscriptionSyncRun,
  SubscriptionSyncRunsResponse,
  SubscriptionSyncSummary,
  SupportEventInput,
  SupportIntegrationListOptions,
  SupportIntegrationListResponse,
  SupportIntegrationProjection,
  SupportProviderCatalogItem,
  SupportProviderCatalogResponse,
  SupportSyncRun,
  SupportSyncRequest,
  SupportSyncRunsResponse,
  WarehouseNativeConnection,
  WarehouseNativeConnectionInput,
  WarehouseNativeHealth,
  WarehouseNativeRun,
  WarehouseNativeRunInput,
  WarehouseNativeRunsResponse,
} from "./resources/native-integrations.js";

export { DeveloperMarketplaceResource } from "./resources/developer-marketplace.js";
export type {
  DeveloperMarketplaceAPIRevisionWarning,
  DeveloperMarketplaceApp,
  DeveloperMarketplaceAppDistribution,
  DeveloperMarketplaceAppInput,
  DeveloperMarketplaceAppMonitoringReport,
  DeveloperMarketplaceAppsResponse,
  DeveloperMarketplaceAppStatus,
  DeveloperMarketplaceAppType,
  DeveloperMarketplaceAuditLog,
  DeveloperMarketplaceAuditLogsResponse,
  DeveloperMarketplaceCatalog,
  DeveloperMarketplaceInstallation,
  DeveloperMarketplaceInstallationInput,
  DeveloperMarketplaceInstallationsResponse,
  DeveloperMarketplaceListing,
  DeveloperMarketplaceListingInput,
  DeveloperMarketplaceListingsResponse,
  DeveloperMarketplaceMonitoringCheck,
  DeveloperMarketplaceMonitoringStatusCounts,
  DeveloperMarketplaceOAuthAuthorizeInput,
  DeveloperMarketplaceOAuthAuthorizeResponse,
  DeveloperMarketplaceOAuthClient,
  DeveloperMarketplaceOAuthClientInput,
  DeveloperMarketplaceOAuthClientResponse,
  DeveloperMarketplaceOAuthClientsResponse,
  DeveloperMarketplaceOAuthRevokeRequest,
  DeveloperMarketplaceOAuthRevokeResponse,
  DeveloperMarketplaceOAuthTokenRequest,
  DeveloperMarketplaceOAuthTokenResponse,
  DeveloperMarketplacePartnerLevel,
  DeveloperMarketplacePartnerProfile,
  DeveloperMarketplacePartnerProfileInput,
  DeveloperMarketplacePartnerProfileReviewDecisionInput,
  DeveloperMarketplacePartnerProfileStatus,
  DeveloperMarketplacePartnerProfileType,
  DeveloperMarketplacePartnerProfilesResponse,
  DeveloperMarketplaceReviewDecisionInput,
  DeveloperMarketplaceReviewItem,
  DeveloperMarketplaceReviewQueueQuery,
  DeveloperMarketplaceReviewQueueResponse,
  DeveloperMarketplaceTestAccount,
  DeveloperMarketplaceTestAccountInput,
  DeveloperMarketplaceTestAccountsResponse,
  DeveloperMarketplaceValidationResult,
  DeveloperMarketplaceWebhookSubscription,
  DeveloperMarketplaceWebhookSubscriptionInput,
  DeveloperMarketplaceWebhookSubscriptionsResponse,
} from "./resources/developer-marketplace.js";

export {
  ChatIntegrationChannelResource,
  ChatIntegrationsResource,
} from "./resources/chat-integrations.js";
export type {
  ChatIntegration,
  ChatIntegrationCreateInput,
  ChatIntegrationProvider,
  ChatIntegrationUpdateInput,
} from "./resources/chat-integrations.js";

export { SlackIntegrationsResource } from "./resources/slack-integrations.js";
export type {
  SlackIntegration,
  CreateSlackIntegrationInput,
  UpdateSlackIntegrationInput,
} from "./resources/slack-integrations.js";

export { LandingPagesResource } from "./resources/landing-pages.js";
export type {
  LandingPage,
  LandingPageStatus,
  CreateLandingPageInput,
  UpdateLandingPageInput,
} from "./resources/landing-pages.js";

export { AnalyticsResource } from "./resources/analytics.js";
export type {
  CampaignReport,
  DashboardStats,
  // X1+X2+X3 analytics additions
  LinkReportRow,
  CampaignCompareRow,
  GeographyRow,
  DeviceRow,
  BounceCounts,
  CohortRow,
  CohortMetric,
  RevenueReport,
  ReportCSVOptions,
  ReportCSVResult,
  EngagementClassifierVersionCoverage,
  EngagementClassificationSummary,
  PoweredIncrementalLift,
  HumanEngagedReachReport,
  EngagementReportQuery,
  HumanEngagedReachMachineSubtypeEvidence,
  HumanEngagedReachEvidenceIntegrity,
  HumanEngagedReachEvidenceSemantics,
  HumanEngagedReachEvidenceReport,
  HumanEngagedReachEvidenceArtifact,
  HumanEngagedReachEvidenceExportQuery,
} from "./resources/analytics.js";

export {
  SENDING_SETTINGS_RECONCILIATION_WAIT_MS,
  SendingSettingsResource,
} from "./resources/sending-settings.js";
export type {
  SendingSettings,
  SendingSettingsInput,
  SendingSettingsStatus,
} from "./resources/sending-settings.js";

export type { RotateAPIKeyResponse } from "./resources/api-keys.js";
export type {
  ArchiveSequenceRequest,
  CreateDraftSequenceRequest,
  SequenceFunnel,
  SequenceFunnelStep,
  SequenceJob,
  SequenceJobAck,
  SequenceParticipant,
  SequenceParticipantStatus,
  SequenceParticipantsPage,
  SequenceParticipantsQuery,
  StuckParticipantsReport,
  StuckSequenceParticipant,
  UpdateDraftSequenceRequest,
  UpdateSequenceRequest,
} from "./resources/sequences.js";
export {
  isSequenceJobAck,
  isSequenceVersion,
  sequenceIfMatch,
} from "./resources/sequences.js";
export type { IngestJob } from "./resources/voice-profile.js";

export type {
  Automation,
  AutomationNode,
  AutomationEdge,
  AutomationTriggerSpec,
  CreateAutomationInput,
  UpdateAutomationInput,
  AutomationListPage,
  BehavioralTrigger,
  BehavioralTriggerInput,
} from "./resources/automations.js";

export type { SubscribeInput, SubscribeResponse } from "./resources/events.js";
export type { SegmentListPage } from "./resources/segments.js";

/* ===== X1+X2+X3 resource exports ===== */

export { ListsResource } from "./resources/lists.js";
export type {
  List,
  CreateListInput,
  UpdateListInput,
  SubscriberListReference,
  ListMember,
  ListMembersPage,
  ListMembersParams,
} from "./resources/lists.js";

export { TagsResource } from "./resources/tags.js";
export type {
  Tag,
  TagColor,
  CreateTagInput,
  UpdateTagInput,
  TagListOptions,
} from "./resources/tags.js";

export { SuppressionsResource } from "./resources/suppressions.js";
export type {
  Suppression,
  SuppressionBulkResult,
} from "./resources/suppressions.js";

export { AssetsResource } from "./resources/assets.js";
export type {
  Asset,
  AssetCounts,
  AssetDetail,
  AssetListPage,
  AssetReferrer,
  AssetUsage,
} from "./resources/assets.js";

export { InboundWebhooksResource } from "./resources/inbound-webhooks.js";
export type {
  InboundWebhookActionType,
  InboundWebhookEndpoint,
  InboundWebhookEvent,
  InboundWebhookEventPage,
  InboundWebhookCreateResponse,
  InboundWebhookListPage,
  InboundWebhookMatchOperator,
  InboundWebhookReplayResponse,
  InboundWebhookTrigger,
  InboundWebhookTriggerInput,
} from "./resources/inbound-webhooks.js";

export { TrackResource } from "./resources/track.js";
export type {
  TrackInput,
  TrackResponse,
  ProductEvent,
  ProductEventListPage,
} from "./resources/track.js";

export { InboundEmailsResource } from "./resources/inbound-emails.js";
export type {
  InboundEmail,
  InboundEmailListPage,
  InboundEmailEndpoint,
  InboundEmailEndpointSecret,
} from "./resources/inbound-emails.js";

export { DmarcResource } from "./resources/dmarc.js";
export type {
  DmarcReport,
  DmarcReportListMeta,
  DmarcReportListPage,
} from "./resources/dmarc.js";

export { TemplatePreviewResource } from "./resources/template-preview.js";
export type {
  TemplatePreviewInput,
  TemplatePreviewResponse,
} from "./resources/template-preview.js";

export { CustomDomainsResource } from "./resources/custom-domains.js";
export type {
  CustomDomain,
  CustomDomainPurpose,
  CreateCustomDomainInput,
  DNSRecord,
} from "./resources/custom-domains.js";

export { LinkCheckResource } from "./resources/link-check.js";
export type { LinkCheckResult } from "./resources/link-check.js";

export { ArchiveResource } from "./resources/archive.js";
export type {
  ArchiveIssueSummary,
  ArchiveIssueDetail,
  ArchiveListPage,
  ArchiveListParams,
  PublishToArchiveInput,
} from "./resources/archive.js";

export { ReferralsResource } from "./resources/referrals.js";
export type {
  ReferralProgram,
  ReferralMilestone,
  ReferralSubscriberView,
} from "./resources/referrals.js";

export { DiscountsResource } from "./resources/discounts.js";
export type {
  Discount,
  DiscountListPage,
  DiscountListParams,
  DiscountRedemptionEvent,
  DiscountRedemptionsPage,
  DiscountRedemptionsParams,
  AppliesTo as DiscountAppliesTo,
} from "./resources/discounts.js";

export { GiftSubscriptionsResource } from "./resources/gift-subscriptions.js";
export type {
  GiftSubscription,
  GiftSubscriptionListPage,
  GiftSubscriptionListParams,
  GiftSubscriptionStats,
  GiftSubStatus,
} from "./resources/gift-subscriptions.js";

export { SendTimeResource } from "./resources/send-time.js";
export type {
  BestSendTime,
  ScheduleByBestTimeResult,
  SegmentSendTimeParams,
  SegmentBestSendTime,
  SegmentSendTimeHeatmap,
} from "./resources/send-time.js";

export {
  SmsResource,
  SMS_A2P_REGISTRATION_RELEASE_HELD_CODE,
  SMS_CAMPAIGN_DISPATCH_RELEASE_HELD_CODE,
  SMS_CAMPAIGN_RESUME_RELEASE_HELD_CODE,
  SMS_CAMPAIGN_SCHEDULE_RELEASE_HELD_CODE,
  SMS_EVIDENCE_READ_RELEASE_HELD_CODE,
  SMS_TEST_DISPATCH_RELEASE_HELD_CODE,
} from "./resources/sms.js";
export type {
  SmsA2PBrandRegistrationInput,
  SmsA2PCampaignRegistrationInput,
  SmsA2PRegistrationResult,
  SmsBroadcastInput,
  SmsBroadcastResult,
  SmsCampaign,
  SmsCampaignInput,
  SmsCampaignReport,
  SmsComplianceStatus,
  SmsConsentInput,
  SmsConsentRevocationReceipt,
  SmsCountry,
  SmsGateDecision,
  SmsList,
  SmsListInput,
  SmsMessage,
  SmsPilotReadiness,
  SmsProvider,
  SmsRegistrationStatus,
  SmsSendInput,
  SmsSenderInput,
  SmsSenderPilotCertification,
  SmsSenderProfile,
  SmsSenderType,
  SmsSetupStatus,
  SmsSuppressionAddInput,
  SmsSuppressionDeleteReceipt,
  SmsSuppressionListOptions,
  SmsSuppressionReason,
  SmsSuppressionSource,
  SmsSuppressionRow,
  SmsSuppressionsPage,
} from "./resources/sms.js";
export {
  decodeSmsSuppressionsPage,
  SMS_SUPPRESSION_LOCKED_REASON,
  SMS_SUPPRESSION_REASONS,
  SMS_SUPPRESSION_SOURCES,
} from "./resources/sms.js";

export {
  decodePushSuppressionsPage,
  PushSuppressionsResource,
  PUSH_SUPPRESSION_LOCKED_REASONS,
  PUSH_SUPPRESSION_PLATFORMS,
  PUSH_SUPPRESSION_REASONS,
  PUSH_SUPPRESSION_SOURCES,
} from "./resources/push-suppressions.js";
export type {
  PushSuppressionAddInput,
  PushSuppressionBulkImportReceipt,
  PushSuppressionBulkRemoveItem,
  PushSuppressionBulkRemoveReceipt,
  PushSuppressionDeleteReceipt,
  PushSuppressionListOptions,
  PushSuppressionLockedReason,
  PushSuppressionMutationOptions,
  PushSuppressionPlatform,
  PushSuppressionReason,
  PushSuppressionRow,
  PushSuppressionSource,
  PushSuppressionsPage,
} from "./resources/push-suppressions.js";

export { CUTOVER_EVIDENCE_KEYS } from "./resources/migrations.js";
export type {
  CutoverEvidenceInput,
  CutoverEvidenceKey,
  MigrationCredentialInput,
  SourceEventReviewInput,
  SourceSessionRefreshInput,
} from "./resources/migrations.js";

// Tier-1 enterprise additions (2026-05).
export {
  AGENCY_BILLING_MODE_RELEASE_HELD_CODE,
  AGENCY_BRANDING_UPDATE_RELEASE_HELD_CODE,
  AGENCY_CHILD_CREATE_RELEASE_HELD_CODE,
  AGENCY_CHILD_UNLINK_RELEASE_HELD_CODE,
  AGENCY_INVOICE_PREVIEW_RELEASE_HELD_CODE,
  AgencyReleaseHeldError,
  AgencyResource,
  decodeAgencyBranding,
  decodeAgencyChildrenPage,
} from "./resources/agency.js";
export type {
  AgencyBranding,
  AgencyBrandingPatch,
  AgencyChild,
  AgencyChildrenPage,
  AgencyChildrenParams,
  AgencyChildrenResponse,
  AgencyCreateChildInput,
} from "./resources/agency.js";

export { AuditSinksResource } from "./resources/audit-sinks.js";
export type {
  AuditSink,
  AuditSinkConfigDatadog,
  AuditSinkConfigHTTP,
  AuditSinkConfigS3,
  AuditSinkConfigSplunk,
  AuditSinkInput,
  AuditSinkKind,
} from "./resources/audit-sinks.js";

export { InboundRoutesResource } from "./resources/inbound-routes.js";
export type {
  InboundRoute,
  InboundRouteAction,
  InboundRouteInput,
} from "./resources/inbound-routes.js";

export { AgentMandatesResource } from "./resources/agent-mandates.js";
export type {
  AgentMandateGrant,
  AgentMandateMinted,
  AgentMandateSummary,
} from "./resources/agent-mandates.js";
export { ScimResource } from "./resources/scim.js";
export type {
  ScimRoleMapping,
  ScimTokenInfo,
  ScimTokenMinted,
} from "./resources/scim.js";

export { VoiceDriftResource } from "./resources/voice-drift.js";
export type { VoiceDriftResponse } from "./resources/voice-drift.js";

export {
  type OnboardingStepState,
  type OnboardingStepDecision,
  type OnboardingStepDecisions,
  type OnboardingStepDecisionAck,
  OnboardingResource,
} from "./resources/onboarding.js";

// The generated, contract-derived operation surface.
//
// Exported as a LOWER-LEVEL alternative to the hand-written resources, not a
// replacement: those carry documentation, tuned parameter shapes and quirks
// this cannot derive from a spec. What it offers is a guarantee they cannot —
// its paths, verbs and types come from the contract, so a method that calls the
// wrong route or types a body the gateway does not accept is a build failure
// rather than a runtime `undefined`.
//
// Regenerated by `pnpm --filter @postwave/sdk generate:operations`; CI fails on
// drift.
export {
  GeneratedOperations,
  OPERATIONS,
  type OperationId,
  type OperationTransport,
} from "./generated/operations.js";
