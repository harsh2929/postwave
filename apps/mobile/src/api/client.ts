/**
 * api/client.ts
 *
 * Mobile API facade. It re-exports the SDK client factory plus typed
 * endpoint helpers used by screens and hooks.
 *
 * Why a factory rather than a singleton: the user can switch workspaces
 * without restarting the app — switching just rotates the credentials
 * and we mint a new client. Old in-flight requests still resolve against
 * the old client because they captured it at call time.
 *
 * The mobile app speaks the SAME @postwave/sdk that the TS SDK/CLI/MCP
 * server / Next.js admin all use. Network shape, error envelopes, and
 * resource APIs are identical — no parallel client to maintain.
 */

export {
  createABTestCampaign,
  getABResults,
  type ABBayesianOutcome,
  type ABBonferroni,
  type ABFrequentistOutcome,
  type ABMetric,
  type ABResultsResponse,
  type ABResultsVariant,
  type ABTestCampaign,
  type ABTestCreateInput,
  type ABTestCreateResponse,
  type ABWinner,
} from "./abTests";
export {
  buildEventBusConnection,
  connectEventBus,
  type MobileEventBusDisconnect,
  type MobileEventBusEvent,
  type MobileEventBusStatus,
} from "./eventBus";
export {
  streamAIGenerate,
  type AIGenerateInput,
  type AIStreamHandle,
  type AIStreamHandlers,
} from "./aiGenerate";
export {
  predictInboxPlacement,
  type InboxRealityPlacement,
  type InboxRealityPredictInput,
  type InboxRealityPrediction,
} from "./inboxReality";
export { getSegmentBestSendTime, type SegmentBestSendTime } from "./sendTime";
export {
  EMAIL_HEALTH_GRADES,
  getEmailHealth,
  getEmailHealthBatch,
  parseEmailHealth,
  type EmailHealth,
  type EmailHealthBatchResponse,
  type EmailHealthEvidence,
  type EmailHealthEvidenceKind,
  type EmailHealthGrade,
  type EmailHealthRecommendation,
  type EmailVerificationStatus,
} from "./emailHealth";
export {
  getMobileMailchimpParitySnapshot,
  getMobileOnboardingProgress,
  type MobileMailchimpParitySnapshot,
  type SubscriberTimelineEvent,
} from "./mobileParity";
export { NATIVE_CLIENT_HEADERS } from "./nativeClient";
export {
  getMobileAgencyBranding,
  getMobileAgencyInvoicePreview,
  listMobileAgencyChildrenPage,
  MOBILE_AGENCY_CHILDREN_PAGE_SIZE,
  type MobileAgencyBranding,
  type MobileAgencyChild,
} from "./agencyReads";
export {
  listMobileAuditSinkDlq,
  listMobileAuditSinks,
  listMobileMigrationSources,
  listMobileMigrations,
  listMobileScimRoleMappings,
  listMobileScimTokens,
  type MobileAuditSink,
  type MobileAuditSinkDlqEntry,
  type MobileMigrationJob,
  type MobileMigrationProgress,
  type MobileMigrationSource,
  type MobileMigrationStatus,
  type MobileScimRoleMapping,
  type MobileScimTokenInfo,
} from "./ops";
export type { AIApiError, AIApiResult } from "./request";
export {
  OUTBOUND_WEBHOOK_EVENTS,
  createOutboundWebhook,
  deleteOutboundWebhook,
  getNotificationPrefs,
  getRetentionPolicy,
  getWorkspaceSettings,
  listOutboundWebhooks,
  patchNotificationPrefs,
  patchRetentionPolicy,
  patchWorkspaceSettings,
  testOutboundWebhook,
  type NotificationPrefs,
  type NotificationPrefsPatch,
  type OutboundWebhook,
  type OutboundWebhookCreateInput,
  type OutboundWebhookCreateResponse,
  type OutboundWebhookTestResult,
  type RetentionPolicy,
  type RetentionPolicyPatch,
  type WorkspaceSettings,
  type WorkspaceSettingsPatch,
} from "./settings";
export { clearClient, getClient, type PostwaveContext } from "./sdkClient";
export {
  createSequence,
  getSequence,
  listSequences,
  updateSequence,
  type SequenceDetailWire,
  type SequenceListItem,
  type SequenceListResponse,
  type SequenceStepWire,
  type SequenceUpdatePatch,
} from "./sequences";
export {
  VOICE_AXES,
  createVoiceLabel,
  deleteVoiceLabel,
  listVoiceLabels,
  type VoiceAxis,
  type VoiceLabel,
  type VoiceLabelCreateInput,
  type VoiceLabelListQuery,
  type VoiceLabelListResponse,
} from "./voiceLabels";
