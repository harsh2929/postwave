package subscribers

import "time"

const (
	StatusEnabled     = "enabled"
	StatusDisabled    = "disabled"
	StatusBlocklisted = "blocklisted"
	StatusUnconfirmed = "unconfirmed"

	ConsentDoubleOptIn = "double_optin"
	ConsentSingleOptIn = "single_optin"
	ConsentImport      = "import"
	ConsentAPI         = "api"
	ConsentUnknown     = "unknown"
)

// SignupSource is the taxonomy used by subscribers.signup_source. Aliased
// to string so the existing call sites (Term.Value: string, map keys in
// signup_source.go) can keep using these as plain strings without a
// pile of conversions.
type SignupSource = string

// signup_source CHECK-constrained vocabulary. Mirrors the values
// referenced by signup_source.go + the migration 0303 CHECK.
const (
	SignupSourceEmbeddedForm = "embedded_form"
	SignupSourceHostedPage   = "hosted_page"
	SignupSourceImport       = "import"
	SignupSourceAPI          = "api"
	SignupSourceIntegration  = "integration"
	SignupSourcePopup        = "popup"
	SignupSourceLandingPage  = "landing_page"
	SignupSourceAdmin        = "admin"
	SignupSourceUnknown      = "unknown"
)

// IdentifierTransformConfig is the per-tenant identifier normalization policy
// (SUB-018, migration 0463). It is read at ingest and applied to identifier
// fields (email, phone) before the row is upserted. The zero value is the
// conservative default: every optional transform OFF, so a tenant that never
// configures this surface keeps the historic lowercase-only behaviour.
//
//   - EmailNormalizeDots: strip dots from the email local-part (Gmail-style).
//   - EmailNormalizePlus: drop the "+tag" sub-address from the local-part.
//   - PhoneE164Format:    coerce phone identifiers to E.164.
//   - PhoneDefaultRegion: ISO 3166-1 alpha-2 region used to interpret a phone
//     number that lacks an explicit country code. Empty = no default region
//     (only already-international "+..." numbers are formatted).
type IdentifierTransformConfig struct {
	EmailNormalizeDots bool   `json:"email_normalize_dots"`
	EmailNormalizePlus bool   `json:"email_normalize_plus"`
	PhoneE164Format    bool   `json:"phone_e164_format"`
	PhoneDefaultRegion string `json:"phone_default_region"`
}

// UpdateIdentifierTransformInput is the PATCH /api/v1/settings/identifier-transforms
// body. Pointer fields distinguish "omitted" (leave unchanged) from an explicit
// new value, so a tenant can flip a single transform without re-sending the
// whole config.
type UpdateIdentifierTransformInput struct {
	EmailNormalizeDots *bool   `json:"email_normalize_dots"`
	EmailNormalizePlus *bool   `json:"email_normalize_plus"`
	PhoneE164Format    *bool   `json:"phone_e164_format"`
	PhoneDefaultRegion *string `json:"phone_default_region"`
}

// Subscriber is Moosewave's tenant-scoped mirror of a Listmonk subscriber.
type Subscriber struct {
	ID string `json:"id,omitempty"`
	// ProfileID is the SUB-017 stable synthetic profile identifier
	// (migration 0453), distinct from the physical row id. It sits at the
	// top of the identifier precedence hierarchy
	// (profile_id > external_id > email > phone > anonymous): an identify
	// call that resolves a profile_id wins outright before any other key is
	// consulted. Auto-assigned on insert; omitted from JSON when empty (e.g.
	// rows scanned before the column existed in a test fake).
	ProfileID string `json:"profile_id,omitempty"`
	Email     string `json:"email"`
	// PrimaryEmail is the SUB-016 canonical contact address (migration 0452).
	// A profile may own up to 5 addresses in subscriber_emails; exactly one is
	// the primary, and its value is mirrored here on subscribers.primary_email
	// by the multi-email set-primary path. Backfilled from email for legacy
	// rows; empty only on a row scanned before the column existed (test fakes).
	PrimaryEmail     string     `json:"primary_email,omitempty"`
	Status           string     `json:"status"`
	MailchimpStatus  string     `json:"mailchimp_status"`
	ConsentTimestamp *time.Time `json:"consent_timestamp"`
	ConsentSource    string     `json:"consent_source"`
	// Per-purpose consent vector (SUB-041, migration 0318). Each is the
	// state-of-record timestamp of the last 'granted' event for that purpose,
	// auto-maintained by the consent_events trigger. nil = no recorded grant
	// (treat as denied for non-essential purposes). Read-only on this surface —
	// the source of truth is the consent_events ledger, not a direct write here.
	ConsentEmailMarketingAt *time.Time       `json:"consent_email_marketing_at,omitempty"`
	ConsentSMSMarketingAt   *time.Time       `json:"consent_sms_marketing_at,omitempty"`
	ConsentProfilingAt      *time.Time       `json:"consent_profiling_at,omitempty"`
	ConsentTargetedAdsAt    *time.Time       `json:"consent_targeted_ads_at,omitempty"`
	ConsentAIProcessingAt   *time.Time       `json:"consent_ai_processing_at,omitempty"`
	CustomFields            map[string]any   `json:"custom_fields"`
	MergeFields             map[string]any   `json:"merge_fields"`
	Tags                    []string         `json:"tags"`
	Groups                  []map[string]any `json:"groups"`
	GDPRPermissions         []map[string]any `json:"gdpr_permissions"`
	SignupIP                string           `json:"signup_ip,omitempty"`
	UnsubscribeReason       string           `json:"unsubscribe_reason,omitempty"`
	MailchimpLastChanged    *time.Time       `json:"mailchimp_last_changed,omitempty"`
	ActivitySummary         map[string]any   `json:"activity_summary"`
	SourceID                string           `json:"source_id,omitempty"`
	SourcePlatform          string           `json:"source_platform,omitempty"`
	// First/last/full/display name columns (SUB-004). Promoted from the
	// merge_fields/custom_fields jsonb into first-class columns so they can
	// be sorted, deduped, and driven into picker UIs. Backed by text NOT
	// NULL DEFAULT '' columns; an empty string means "no name on file".
	FirstName   string `json:"first_name"`
	LastName    string `json:"last_name"`
	FullName    string `json:"full_name"`
	DisplayName string `json:"display_name"`
	// Localization columns (SUB-005). All four are nullable in the DB —
	// nil here means "never set". language is ISO 639-1 alpha-2, country is
	// ISO 3166-1 alpha-2, locale is a BCP-47-ish tag, and region is
	// free-text. Validation is best-effort at the application layer.
	Locale   *string `json:"locale,omitempty"`
	Language *string `json:"language,omitempty"`
	Country  *string `json:"country,omitempty"`
	Region   *string `json:"region,omitempty"`
	// DataRegion is the SUB-052 per-subscriber data-residency override
	// (migration 0524). nil = inherit the owning tenant's data_region
	// (the common case). A non-nil value is one of regions.Allowed()
	// (us-east-1 / eu-central-1 / …) and pins this profile's backups +
	// sub-processor selection to that data plane. The effective region is
	// resolved by regions.InheritedRegionFor(subscriber, tenant). Omitted
	// from JSON when nil.
	DataRegion *string `json:"data_region,omitempty"`
	// ExternalID is the stable per-tenant identifier supplied by the
	// caller via /identify (Shopify customer id, Stripe customer id,
	// etc). Stored nullable in the DB; nil here means "never set".
	ExternalID *string `json:"external_id,omitempty"`
	// AccountID is the SUB-012 many-to-one link to the first-class
	// accounts table (migration 0438). nil = unlinked (the common B2C
	// case). Set/cleared via PATCH /api/v1/subscribers/{id}/account; the
	// denormalised merge_fields.COMPANY pointer is preserved alongside it.
	AccountID *string `json:"account_id,omitempty"`
	// FederatedMasterID is the SUB-023 cross-tenant master identity link. When
	// this subscriber (a child-workspace row in an agency/MSP hierarchy) is
	// federated to a master subscriber in the parent workspace, this carries
	// the parent's master_subscriber_id. nil = not federated (the common case).
	// Hydrated only on the detail GET; nil on list rows to avoid an N+1 link
	// fetch. Omitted from JSON when nil.
	FederatedMasterID *string   `json:"federated_master_id,omitempty"`
	CreatedAt         time.Time `json:"created_at,omitempty"`
	UpdatedAt         time.Time `json:"updated_at,omitempty"`
	// Version is the strong optimistic-concurrency token derived from ID and
	// UpdatedAt. It is carried in every subscriber representation (including
	// list/search rows) so clients can issue an exact If-Match without an
	// extra detail round-trip. It is a projection, never persisted.
	Version string `json:"version,omitempty"`
	// ArchivedAt is the SUB-009 soft-delete marker. nil = active. Set by
	// the Archive path (PATCH /subscribers/{id}/archive); cleared by
	// Unarchive. List/Get/Search filter WHERE archived_at IS NULL by
	// default — the archived row is preserved (audit-join keys survive)
	// but hidden from the active list unless include_archived is set.
	ArchivedAt *time.Time `json:"archived_at,omitempty"`
	// CatalogAttributes is the SUB-013 catalog-linked profile attributes
	// (favorite_category / last_viewed_sku), computed by the commerce
	// listener from commerce_events and stored on
	// subscriber_computed_traits. nil on list rows (not hydrated there to
	// avoid an N+1 trait fetch); hydrated inline only on the subscriber
	// detail GET via Repo.GetCatalogAttributes so the slideover can show
	// catalog affinity without a second round-trip. Omitted from JSON when
	// nil (the common no-catalog-history case).
	CatalogAttributes *CatalogAttributes `json:"catalog_attributes,omitempty"`
	// DetectedJurisdiction is the SUB-055 ISO 3166-1 alpha-2 country inferred
	// from signup_ip by the geolocation detector (migration 0538). nil = no
	// detection has run. Compared against the stored Country on Upsert to
	// detect a jurisdiction drift.
	DetectedJurisdiction *string `json:"detected_jurisdiction,omitempty"`
	// JurisdictionChangedAt is when the most recent jurisdiction drift was
	// detected (inferred jurisdiction != stored country). nil = no drift ever
	// recorded.
	JurisdictionChangedAt *time.Time `json:"jurisdiction_changed_at,omitempty"`
	// JurisdictionReconfirmRequired is the SUB-055 flag: true when a drift
	// into a stricter consent regime (GDPR / CASL / Quebec Law 25) requires a
	// fresh consent re-confirmation. Cleared by
	// PATCH /api/v1/subscribers/{id}/jurisdiction-reconfirm.
	JurisdictionReconfirmRequired bool `json:"jurisdiction_reconfirm_required"`
	// GppSections is the SUB-120 per-jurisdiction IAB Global Privacy Platform
	// (GPP) section map (migration 0562), e.g.
	// {"usnat":"BAAAAAA...","usca":"BAAAAAA..."}. Stored verbatim — Moosewave
	// does not parse/decode the GPP string in this phase. Populated only by the
	// GPP-specific reads (Repo.GetGppSections / the GPP ingest path); nil on a
	// row scanned via the standard subscriber SELECT so the common list/detail
	// path is not burdened with the column. Omitted from JSON when empty.
	GppSections map[string]string `json:"gpp_sections,omitempty"`
	// PredictionModelVersion / PredictionConfidence are the SUB-010 predictive-
	// score versioning fields (migration 0900). They surface the model lineage
	// behind the cached churn/engagement scalars so the detail slideover can
	// render Klaviyo-style explainability ("scored by churn-xgb-v2, confidence
	// 0.82") without a second model call. Hydrated ONLY on the detail GET from
	// subscriber_prediction_metadata (the churn row wins when both exist, then
	// engagement); nil on list rows to avoid an N+1 metadata fetch. The full
	// per-feature snapshot + per-score-type history lives in the metadata table,
	// reachable via GET /api/v1/subscribers/{id}/prediction-metadata. Both
	// omitted from JSON when nil (no model has scored this subscriber yet).
	PredictionModelVersion *string  `json:"prediction_model_version,omitempty"`
	PredictionConfidence   *float64 `json:"prediction_confidence,omitempty"`
	// Prediction is the SUB-059 first-class predictive-CLV projection
	// (historic / predicted / total CLV in cents) plus churn risk and the
	// SUB-060 explainable churn drivers, hydrated on the detail GET via a
	// LEFT JOIN on profile_predictions (migration 0206 + 0912, populated by
	// the predictive worker). nil on list rows (not hydrated there to avoid
	// an N+1 join) and nil on the detail GET when the predictive worker has
	// not scored this subscriber's email yet. Omitted from JSON when nil so
	// the slideover's Insights section can branch on presence.
	Prediction *SubscriberPrediction `json:"prediction,omitempty"`
	// ExpectedNextOrderAt is the SUB-061 replenishment-cadence projection:
	// last_order_at + average_days_between_orders, derived by the commerce
	// replenishment-cadence worker and stored on subscriber_computed_traits
	// (key expected_next_order_at). nil on list rows (not hydrated there to
	// avoid an N+1 trait fetch); hydrated inline only on the subscriber detail
	// GET so the slideover can show a "next order expected" projection without
	// a second round-trip. Omitted from JSON when nil (the common no-order-
	// history case). The full cadence read/write surface lives at
	// GET/PATCH /api/v1/subscribers/{id}/replenishment-cadence.
	ExpectedNextOrderAt *time.Time `json:"expected_next_order_at,omitempty"`
	// OrderCadenceMetrics is the SUB-062 compact repeat-purchase projection
	// (average_days_between_orders + last_computed_at), read from the same
	// computed trait the replenishment-cadence worker maintains. nil on list
	// rows; hydrated inline only on the subscriber detail GET so the slideover
	// can render a "Repeat Purchase Behavior" card. Omitted from JSON when nil.
	OrderCadenceMetrics *OrderCadenceMetrics `json:"order_cadence_metrics,omitempty"`
	// Demographics is the SUB-063 confidence-labelled inferred-demographics
	// projection (gender / age group / interests, each with a model confidence)
	// read from subscriber_computed_traits under the inferred_* keys. nil on
	// list rows; hydrated inline only on the subscriber detail GET so the
	// slideover can render a confidence meter. Omitted from JSON when nil (no
	// demographic has been inferred yet). The full read/write surface lives at
	// GET /api/v1/subscribers/{id}/demographics +
	// PUT /api/v1/subscribers/{id}/traits/inferred_{gender,age_group,interests}.
	Demographics *Demographics `json:"demographics,omitempty"`
	// FrequencyPreference is the SUB-132 subscriber-level send-cadence hint
	// (migration 0180): 'default' | 'weekly' | 'monthly' | 'paused'. Chosen
	// via the smart-unsubscribe flow (POST /api/public/preferences/{token}/
	// frequency) or set directly via PATCH /api/v1/subscribers/{id}. Read at
	// send time by frequency.FilterBySubscriberPreference so a 'paused'
	// subscriber (or one whose paused_until is still in the future) is excluded
	// from the campaign audience at queue-fill. Always present (the column is
	// NOT NULL DEFAULT 'default'), so this is a non-pointer string.
	FrequencyPreference string `json:"frequency_preference"`
	// PausedUntil is the SUB-132 temporary-suppression auto-reactivation
	// timestamp (migration 0180). When frequency_preference='paused', a non-nil
	// PausedUntil in the future means "skip this subscriber until then"; a nil
	// PausedUntil with frequency_preference='paused' means "paused indefinitely"
	// (until the subscriber re-opts in). nil + a non-paused preference is the
	// common case. Omitted from JSON when nil.
	PausedUntil *time.Time `json:"paused_until,omitempty"`
	// PreferenceTopics is the SUB-134 per-topic opt-in state for this
	// subscriber, hydrated only on the detail GET (nil on list rows to avoid an
	// N+1 topics fetch). Each entry pairs a tenant topic with the subscriber's
	// current opt-in state (defaulting to the topic's default_opt_in when the
	// subscriber has no explicit row). Omitted from JSON when nil (no topics
	// configured / hydration skipped). The full read/write surface lives at
	// GET/PUT /api/v1/subscribers/{email}/topics.
	PreferenceTopics []SubscriberTopicView `json:"preference_topics,omitempty"`
	// EngagementScore / ChurnScore / Rating are the cached predictive +
	// Mailchimp-parity scalars the column-header sort affordance (SUB-076)
	// drives. They are real smallint columns on subscribers — engagement_score
	// (migration 0061), churn_score (migration 0180), rating (1..5 stars,
	// migration 0226) — already in the normalizeSort allow-list, but were not
	// being SELECTed, so the desktop's clickable headers had no values to render
	// or server-sort against. All three are nullable (nil = "never scored" /
	// "unrated"); pointers so a cold/unrated row omits the key rather than
	// reporting a misleading 0.
	EngagementScore *int `json:"engagement_score,omitempty"`
	ChurnScore      *int `json:"churn_score,omitempty"`
	Rating          *int `json:"rating,omitempty"`
}

// SubscriberTopicView is the SUB-134 per-topic opt-in projection surfaced on
// the subscriber detail GET. It mirrors preferences.SubscriberTopicView so the
// subscribers JSON is self-contained (no import of the preferences package's
// HTTP types) — one row per tenant topic with the subscriber's current opt-in
// state pre-applied.
type SubscriberTopicView struct {
	// TopicID is the topics row id.
	TopicID string `json:"topic_id"`
	// Slug is the operator-facing stable topic identifier.
	Slug string `json:"slug"`
	// Name is the human-readable topic name rendered in the preference center.
	Name string `json:"name"`
	// Description is the optional topic blurb (empty when none).
	Description string `json:"description,omitempty"`
	// DefaultOptIn is the topic's default opt-in state for subscribers with no
	// explicit subscriber_topics row.
	DefaultOptIn bool `json:"default_opt_in"`
	// DisplayOrder is the topic's sort order in the preference center.
	DisplayOrder int `json:"display_order"`
	// OptedIn is the subscriber's resolved opt-in state (their explicit
	// subscriber_topics value, or the topic default when unset).
	OptedIn bool `json:"opted_in"`
}

// SubscriberPrediction is the SUB-059 subscriber-level predictive payload
// surfaced on the detail GET. It is a read-only projection of the
// profile_predictions row keyed on (tenant, email) — the same row the
// /api/v1/predictive surface serves — narrowed to the fields the slideover's
// Insights section renders: the three CLV figures, churn risk, and the
// SUB-060 explainable churn drivers. Populated only when the predictive
// worker has scored this address.
type SubscriberPrediction struct {
	// HistoricCLVCents is realised lifetime value to date, in cents.
	HistoricCLVCents int `json:"historic_clv_cents"`
	// PredictedCLVCents is the modelled forward lifetime value, in cents.
	PredictedCLVCents int `json:"predicted_clv_cents"`
	// TotalCLVCents is historic + predicted, in cents — the headline CLV.
	TotalCLVCents int `json:"total_clv_cents"`
	// ChurnRisk is the churn probability in [0,1].
	ChurnRisk float64 `json:"churn_risk"`
	// Confidence is the model confidence in [0,1].
	Confidence float64 `json:"confidence"`
	// DataSufficiency is 'insufficient' | 'limited' | 'sufficient'.
	DataSufficiency string `json:"data_sufficiency"`
	// ChurnDrivers is the SUB-060 ranked top-3 explainable churn drivers
	// (highest impact first). Empty when no driver crosses the salience floor.
	ChurnDrivers []ChurnDriver `json:"churn_drivers"`
	// CalculatedAt is when the predictive worker last scored this profile.
	CalculatedAt time.Time `json:"calculated_at"`
}

// ChurnDriver is one explainable contributor to a churn prediction (SUB-060),
// mirrored from the predictive package so the subscribers JSON is
// self-contained. Impact is a coarse 'high' | 'medium' | 'low' band.
type ChurnDriver struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Value  string `json:"value"`
	Impact string `json:"impact"`
}

// PredictionScoreType is the SUB-010 (migration 0900) score-type taxonomy
// for subscriber_prediction_metadata: which cached predictive scalar a
// metadata row explains. Aliased to string so call sites can use the
// constants below as plain strings.
type PredictionScoreType = string

const (
	// PredictionScoreChurn explains subscribers.churn_score.
	PredictionScoreChurn = "churn"
	// PredictionScoreEngagement explains subscribers.engagement_score.
	PredictionScoreEngagement = "engagement"
)

// ValidPredictionScoreType reports whether v is a recognised score_type,
// matching the migration 0900 CHECK constraint.
func ValidPredictionScoreType(v string) bool {
	switch v {
	case PredictionScoreChurn, PredictionScoreEngagement:
		return true
	default:
		return false
	}
}

// PredictionMetadata is one versioned predictive-score metadata snapshot
// (SUB-010, migration 0900) — a single current row per (subscriber,
// score_type) carrying the model lineage + confidence + per-feature
// explainability snapshot for a cached churn/engagement scalar.
type PredictionMetadata struct {
	ID           string         `json:"id"`
	SubscriberID string         `json:"subscriber_id"`
	ScoreType    string         `json:"score_type"`
	ModelVersion string         `json:"model_version"`
	Confidence   *float64       `json:"confidence,omitempty"`
	Features     map[string]any `json:"features"`
	ComputedAt   time.Time      `json:"computed_at"`
	CreatedAt    time.Time      `json:"created_at"`
	UpdatedAt    time.Time      `json:"updated_at"`
}

// PredictionMetadataList is the GET /api/v1/subscribers/{id}/prediction-metadata
// response: every per-score-type metadata snapshot for one subscriber.
type PredictionMetadataList struct {
	SubscriberID string               `json:"subscriber_id"`
	Items        []PredictionMetadata `json:"items"`
}

// UpsertPredictionMetadataInput is the body accepted on the generic
// PATCH /api/v1/subscribers/{id} (model_version + confidence) and the
// dedicated PATCH /api/v1/subscribers/{id}/prediction-metadata. ScoreType
// selects which cached scalar the metadata explains (defaults to 'churn'
// when omitted on the generic PATCH). Features is optional; an explicit
// non-nil map replaces the stored snapshot.
type UpsertPredictionMetadataInput struct {
	ScoreType    string         `json:"score_type"`
	ModelVersion *string        `json:"model_version"`
	Confidence   *float64       `json:"confidence"`
	Features     map[string]any `json:"features"`
}

// PreSendRefineInput is the POST /api/v1/campaigns/{id}/presend-refine body
// (SUB-067). All fields are optional; zero values use the package defaults
// (churn_threshold=80, cooling_off_hours=24). DryRun previews the counts +
// sample WITHOUT persisting exclusion rows (the Compose checklist uses it).
type PreSendRefineInput struct {
	ChurnThreshold        int  `json:"churn_threshold"`
	CoolingOffHours       int  `json:"cooling_off_hours"`
	ExcludeRecentlyPaused bool `json:"exclude_recently_paused"`
	DryRun                bool `json:"dry_run"`
}

// PreSendExcludedSubscriber is one churn-risk-suppressed subscriber in the
// preview sample (SUB-067).
type PreSendExcludedSubscriber struct {
	SubscriberID string `json:"subscriber_id"`
	Email        string `json:"email"`
	ChurnScore   int    `json:"churn_score"`
	Reason       string `json:"reason"`
}

// PreSendRefineResult is the POST/GET /api/v1/campaigns/{id}/presend-refine
// response (SUB-067): the excluded count, the cooling-off count + window, and
// a bounded sample of affected subscribers for the Compose checklist preview.
type PreSendRefineResult struct {
	CampaignID            string                      `json:"campaign_id"`
	ChurnThreshold        int                         `json:"churn_threshold"`
	CoolingOffHours       int                         `json:"cooling_off_hours,omitempty"`
	ExcludedCount         int                         `json:"excluded_count"`
	CoolingOffCount       int                         `json:"cooling_off_count"`
	CoolingOffUntil       *time.Time                  `json:"cooling_off_until,omitempty"`
	DryRun                bool                        `json:"dry_run"`
	ExcludeRecentlyPaused bool                        `json:"exclude_recently_paused"`
	AffectedSample        []PreSendExcludedSubscriber `json:"affected_subscribers_sample"`
}

// LookalikeAudience is the metadata header for one generated lookalike
// audience (SUB-068, migration 0949). It records the seed segment, the
// requested size + confidence floor, the realised member count, an optional
// export destination, and a payload carrying seed stats + similarity bands.
type LookalikeAudience struct {
	ID                    string         `json:"id"`
	Name                  string         `json:"name"`
	SeedSegmentID         string         `json:"seed_segment_id"`
	SizeRequested         int            `json:"size_requested"`
	MemberCount           int            `json:"member_count"`
	SeedCount             int            `json:"seed_count"`
	ConfidenceThreshold   *float64       `json:"confidence_threshold,omitempty"`
	ModelVersion          string         `json:"model_version"`
	Status                string         `json:"status"`
	ExportedDestinationID *string        `json:"exported_destination_id,omitempty"`
	Payload               map[string]any `json:"payload"`
	Error                 string         `json:"error,omitempty"`
	CreatedAt             time.Time      `json:"created_at"`
	UpdatedAt             time.Time      `json:"updated_at"`
}

// LookalikeMember is one ranked, modeled subscriber in a lookalike audience
// (SUB-068, migration 0950).
type LookalikeMember struct {
	SubscriberID    string         `json:"subscriber_id"`
	Email           string         `json:"email"`
	SimilarityScore float64        `json:"similarity_score"`
	Rank            int            `json:"rank"`
	Features        map[string]any `json:"features"`
}

// LookalikeAudienceList is the GET /api/v1/subscribers/lookalike response.
type LookalikeAudienceList struct {
	Items []LookalikeAudience `json:"items"`
}

// LookalikeAudienceDetail is the GET /api/v1/subscribers/lookalike/{id}
// response: the header plus a page of ranked members.
type LookalikeAudienceDetail struct {
	Audience LookalikeAudience `json:"audience"`
	Members  []LookalikeMember `json:"members"`
	Page     int               `json:"page"`
	PerPage  int               `json:"per_page"`
	// PIIIncluded is false unless the caller explicitly requests the ranked
	// member identities. The default detail contract is aggregate-only so a
	// status poll cannot accidentally hydrate subscriber PII.
	PIIIncluded bool `json:"pii_included"`
}

// CreateLookalikeInput is the POST /api/v1/subscribers/lookalike body. The
// seed id and an explicit first-party data-use acknowledgement are required;
// size + confidence default at the repository boundary.
type CreateLookalikeInput struct {
	Name                string   `json:"name"`
	SeedSegmentID       string   `json:"seed_segment_id"`
	Size                int      `json:"size"`
	ConfidenceThreshold *float64 `json:"confidence_threshold"`
	DataUseAcknowledged bool     `json:"data_use_acknowledged"`
}

// ExportLookalikeInput is the POST /api/v1/subscribers/lookalike/{id}/export
// body — the audience_destinations id to route the modeled audience to.
type ExportLookalikeInput struct {
	DestinationID string `json:"destination_id"`
}

// DecisionExplanation is one stored automated-decision explanation (SUB-070,
// migration 0951): why the subscriber matched a segment or was included in a
// campaign. reasoning_snapshot carries the human-readable drivers.
type DecisionExplanation struct {
	ID                string         `json:"id"`
	SubscriberID      string         `json:"subscriber_id"`
	DecisionType      string         `json:"decision_type"`
	TargetID          string         `json:"target_id"`
	ReasoningSnapshot map[string]any `json:"reasoning_snapshot"`
	CreatedAt         time.Time      `json:"created_at"`
	UpdatedAt         time.Time      `json:"updated_at"`
}

// DecisionExplanationList is the GET
// /api/v1/subscribers/{id}/decision-explanations response.
type DecisionExplanationList struct {
	SubscriberID string                `json:"subscriber_id"`
	Items        []DecisionExplanation `json:"items"`
}

// RecordDecisionExplanationInput is the POST
// /api/v1/subscribers/{id}/decision-explanations body. decision_type is
// 'segment' | 'campaign'; target_id is the segment/campaign id; the snapshot
// is the freeform reasoning payload.
type RecordDecisionExplanationInput struct {
	DecisionType      string         `json:"decision_type"`
	TargetID          string         `json:"target_id"`
	ReasoningSnapshot map[string]any `json:"reasoning_snapshot"`
}

// SegmentConditionResult is one leaf condition of a segment, evaluated against
// the subscriber, with a human-readable reason (SUB-070).
type SegmentConditionResult struct {
	Field       string `json:"field"`
	Comparator  string `json:"comparator"`
	Value       string `json:"value,omitempty"`
	Matched     bool   `json:"matched"`
	Description string `json:"description"`
}

// SegmentMembership reports whether the subscriber belongs to one segment and
// which of its conditions matched (SUB-070 right-to-explanation).
type SegmentMembership struct {
	SegmentID       string                   `json:"segment_id"`
	SegmentName     string                   `json:"segment_name"`
	IsMember        bool                     `json:"is_member"`
	MatchedCount    int                      `json:"matched_count"`
	TotalConditions int                      `json:"total_conditions"`
	Summary         string                   `json:"summary"`
	Conditions      []SegmentConditionResult `json:"conditions"`
}

// SegmentMembershipResponse is the GET
// /api/v1/subscribers/{id}/segment-membership response: every tenant segment
// with the subscriber's live membership + per-condition reasons.
type SegmentMembershipResponse struct {
	SubscriberID string              `json:"subscriber_id"`
	Segments     []SegmentMembership `json:"segments"`
}

// Page is the response shape for list/search endpoints.
//
// NextCursor is populated ONLY on the keyset path (List called with a
// cursor under the default updated_at-DESC sort). It is omitted on the
// offset path so existing callers see a byte-identical body, and it is
// empty (omitted) when the keyset page is the last one. Total stays
// returned on the offset path; on the keyset path Total is 0 because a
// full COUNT defeats the point of keyset paging at 5M rows (see
// Repo.List).
type Page struct {
	Items      []Subscriber `json:"items"`
	Total      int          `json:"total"`
	Page       int          `json:"page"`
	PerPage    int          `json:"per_page"`
	NextCursor string       `json:"next_cursor,omitempty"`
}

// ListOptions carries the optional, combinable filters/sort/paging knobs
// for Repo.List. The zero value reproduces the historic List behaviour
// exactly (no q, no status, default updated_at-DESC sort, OFFSET paging)
// so callers that pass an empty ListOptions get byte-identical results.
type ListOptions struct {
	// Q is a free-text search string. Empty means "no search" and the
	// List behaves exactly as before. Non-empty applies the same ILIKE
	// predicate the /search endpoint uses (shared via subscriberSearchWhere).
	Q string
	// Status, when non-empty AND recognised, filters on the matching
	// column (status or mailchimp_status — see statusFilterClause). The
	// handler validates it up front and 400s on an unknown value, so the
	// repo only ever receives a recognised status or "".
	Status string
	// Sort / Order select the ORDER BY via the normalizeSort allow-list.
	// Anything outside the allow-list falls back to updated_at DESC. Only
	// the default (updated_at DESC) sort supports cursor paging; every
	// other sort uses OFFSET.
	Sort  string
	Order string
	// Cursor, when set (decoded ID non-empty), switches the page to keyset
	// paging on (updated_at, id) and is honoured ONLY for the default
	// sort. For any non-default sort the cursor is ignored and OFFSET is
	// used (documented behaviour). Page/PerPage drive the OFFSET path.
	Cursor  listCursor
	Page    int
	PerPage int
	// IncludeArchived, when false (the default), filters the listing to
	// active rows only (archived_at IS NULL) — SUB-009. The handler flips
	// it true on ?include_archived=true so the "show archived" toggle can
	// surface soft-deleted subscribers.
	IncludeArchived bool
}

// usesKeyset reports whether this request should take the keyset path:
// a cursor was supplied AND the effective sort is the default
// (updated_at DESC). Any other sort forces the OFFSET path.
func (o ListOptions) usesKeyset() bool {
	if o.Cursor.ID == "" {
		return false
	}
	col, dir := normalizeSort(o.Sort, o.Order)
	return col == "updated_at" && dir == "DESC"
}

// SubscriberEmail is one address attached to a profile (SUB-016, migration
// 0452). A profile may own up to MaxEmailsPerProfile addresses, each with
// independent consent / suppression / engagement state. Exactly one address
// per profile is the primary (canonical contact) address.
type SubscriberEmail struct {
	ID            string     `json:"id"`
	SubscriberID  string     `json:"subscriber_id"`
	Email         string     `json:"email"`
	IsPrimary     bool       `json:"is_primary"`
	ConsentStatus string     `json:"consent_status"`
	Suppressed    bool       `json:"suppressed"`
	LastEngagedAt *time.Time `json:"last_engaged_at,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	// Version is the strong per-address concurrency token clients echo in
	// If-Match for PATCH/DELETE. It is derived from ID + UpdatedAt and never
	// accepted from a JSON request body.
	Version string `json:"version"`
}

// AddEmailInput is the POST /api/v1/subscribers/{id}/emails body.
type AddEmailInput struct {
	Email     string `json:"email"`
	IsPrimary bool   `json:"is_primary"`
	// ConsentStatus is a pointer so omission can safely mean
	// never_subscribed while an explicit status must carry evidence.
	ConsentStatus *string `json:"consent_status"`
	ConsentProvenanceInput
}

// UpdateEmailInput is the PATCH /api/v1/subscribers/{id}/emails/{email_id}
// body. Pointer fields so an omitted key is a no-op while an explicit value
// updates the column. Setting is_primary=true demotes the prior primary.
type UpdateEmailInput struct {
	IsPrimary     *bool   `json:"is_primary"`
	ConsentStatus *string `json:"consent_status"`
	Suppressed    *bool   `json:"suppressed"`
	ConsentProvenanceInput
	SuppressionReason   string `json:"suppression_reason"`
	SuppressionEvidence string `json:"suppression_evidence"`
	IfMatchToken        string `json:"-"`
}

// ChannelConsent is one (profile, channel) consent row (SUB-042, migration
// 0488). A profile may carry up to five rows — one per channel — each with its
// own status, consent timestamp/source, and a shared frequency cap. The
// denormalised email/phone are mirrored for send-time join efficiency.
type ChannelConsent struct {
	ID           string `json:"id"`
	SubscriberID string `json:"subscriber_id"`
	// SubscriberVersion is the fresh strong parent-profile revision emitted
	// after a channel mutation. The list envelope also carries the current
	// parent revision. Clients must echo the latest value in If-Match on the
	// next subscriber or channel-consent write.
	SubscriberVersion string     `json:"subscriber_version,omitempty"`
	Channel           string     `json:"channel"`
	Status            string     `json:"status"`
	ConsentTimestamp  *time.Time `json:"consent_timestamp,omitempty"`
	ConsentSource     string     `json:"consent_source"`
	FrequencyCapUntil *time.Time `json:"frequency_cap_until,omitempty"`
	Email             string     `json:"email,omitempty"`
	PhoneE164         string     `json:"phone_e164,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
}

// UpdateChannelConsentInput is the PATCH
// /api/v1/subscribers/{id}/channel-consents/{channel} body. Pointer fields so
// an omitted key is a no-op while an explicit value updates the column. Setting
// status also re-stamps consent_timestamp to now unless consent_timestamp is
// supplied explicitly.
type UpdateChannelConsentInput struct {
	Status            *string    `json:"status"`
	ConsentSource     *string    `json:"consent_source"`
	ConsentTimestamp  *time.Time `json:"consent_timestamp"`
	EvidenceChannel   *string    `json:"evidence_channel"`
	LegalBasis        *string    `json:"legal_basis"`
	Evidence          *string    `json:"evidence"`
	Jurisdiction      *string    `json:"jurisdiction"`
	Reason            *string    `json:"reason"`
	PolicyVersion     *string    `json:"policy_version"`
	FrequencyCapUntil *time.Time `json:"frequency_cap_until"`
	// ClearFrequencyCap, when true, drops the frequency cap (sets it NULL).
	// Distinguishes "clear the cap" from "leave it unchanged" since a nil
	// FrequencyCapUntil already means "unchanged".
	ClearFrequencyCap bool `json:"clear_frequency_cap"`
	// IfMatchToken is transport metadata populated from the required HTTP
	// If-Match header. It is never accepted from JSON.
	IfMatchToken string `json:"-"`
}

// ChannelSendTime is the per-channel optimal send window for one
// (subscriber, channel) pair (SUB-066, migration 0936). BestSendHour is a
// modal hour-of-week 0-167 (UTC-bucketed, matching the legacy
// subscribers.best_send_hour convention). It is nil when no per-channel
// value has been computed yet — callers fall back to the aggregate.
type ChannelSendTime struct {
	Channel        string     `json:"channel"`
	BestSendHour   *int       `json:"best_send_hour"`
	BestSendHourAt *time.Time `json:"best_send_hour_at,omitempty"`
	DayOfWeek      *int       `json:"day_of_week,omitempty"` // derived: best_send_hour / 24 (0=Sun)
	HourOfDay      *int       `json:"hour_of_day,omitempty"` // derived: best_send_hour % 24
}

// PerChannelSendTimes is the GET /api/v1/subscribers/{id}/send-times
// response (SUB-066). It exposes the per-channel optimal windows from
// subscriber_channel_consents alongside the legacy per-subscriber
// aggregate (AggregateBestSendHour) so the desktop can render both. A
// channel with no consent row simply has no entry in Channels; a row that
// exists but was never computed has a nil BestSendHour, and the caller
// should fall back to the aggregate.
type PerChannelSendTimes struct {
	SubscriberID string `json:"subscriber_id"`
	// AggregateBestSendHour is subscribers.best_send_hour (0076) — the
	// channel-agnostic modal hour-of-week, nil when cold.
	AggregateBestSendHour   *int              `json:"aggregate_best_send_hour"`
	AggregateBestSendHourAt *time.Time        `json:"aggregate_best_send_hour_at,omitempty"`
	Channels                []ChannelSendTime `json:"channels"`
}

// ErasureReceipt is the machine-readable right-to-be-forgotten proof (SUB-046,
// migration 0501) written in the same tx as a subscriber delete. It carries no
// cleartext PII — EmailRedacted is a stable {hash}@{domain} token and EmailHash
// is the SHA-256 hex of the erased address that a downstream DSAR tool can
// recompute to match the receipt. ProofURL is the canonical self-reference for
// the receipt (the GET endpoint that produced it), hydrated by the handler.
type ErasureReceipt struct {
	ID            string         `json:"id"`
	SubscriberID  string         `json:"subscriber_id"`
	EmailRedacted string         `json:"email_redacted"`
	EmailHash     string         `json:"email_hash"`
	ErasedAt      time.Time      `json:"erased_at"`
	Metadata      map[string]any `json:"metadata"`
	ProofURL      string         `json:"proof_url,omitempty"`
	CreatedAt     time.Time      `json:"created_at"`
}

// ConsentReceiptJSON is the SUB-056 ISO 27560 / Kantara Consent Receipt v1.1
// portable consent receipt. It is constructed from the subscriber's existing
// consent vector (0318) + consent_receipts history (0140) + per-tenant
// organizational context (migration 0548), and exported in portable form for
// identity wallets via GET /api/v1/subscribers/{id}/consent-receipt.json.
//
// The field names follow the Kantara CR v1.1 schema (camelCase) so a wallet
// that already parses Kantara receipts can ingest ours without a custom mapping.
type ConsentReceiptJSON struct {
	// Version pins the receipt schema. "KI-CR-v1.1" is the Kantara Initiative
	// Consent Receipt v1.1 identifier, which ISO 27560 codifies.
	Version string `json:"version"`
	// JurisdictionSpec is the receipt-format jurisdiction; "ISO/IEC 27560" here.
	JurisdictionSpec string `json:"jurisdiction"`
	// ConsentReceiptID is a stable per-receipt identifier (the subscriber's
	// profile_id, or the row id when no profile_id is assigned).
	ConsentReceiptID string `json:"consentReceiptID"`
	// ConsentTimestamp is when the receipt was generated (RFC3339).
	ConsentTimestamp time.Time `json:"consentTimestamp"`
	// PIIPrincipalID identifies the data subject — the subscriber's email.
	PIIPrincipalID string `json:"piiPrincipalId"`
	// SubjectProfileID is the Moosewave stable profile id (omitted when none).
	SubjectProfileID string `json:"subjectProfileId,omitempty"`
	// PIIController is the organizational controller block.
	PIIController ConsentReceiptController `json:"piiController"`
	// PolicyURI is the privacy policy URL the consent was granted under.
	// Omitted when the tenant has not configured one (migration 0548).
	PolicyURI string `json:"policyUri,omitempty"`
	// Services carries the consent purposes + their current state-of-record.
	Services []ConsentReceiptService `json:"services"`
	// History is the append-only consent change log from consent_receipts.
	History []ConsentReceiptHistoryEntry `json:"history"`
}

// ConsentReceiptController is the Kantara CR piiController block.
type ConsentReceiptController struct {
	// PIIControllerName is the controller display name (tenant controller_name
	// override, or the tenant name).
	PIIControllerName string `json:"piiControllerName"`
	// Contact is an optional controller contact (DPO email / address).
	Contact string `json:"contact,omitempty"`
}

// ConsentReceiptService is one consent purpose + its current granted state.
type ConsentReceiptService struct {
	// Purpose is the machine purpose key (email_marketing, sms_marketing,
	// profiling, targeted_ads, ai_processing).
	Purpose string `json:"purpose"`
	// ConsentType is the Kantara CR consent basis; "EXPLICIT" for an opt-in.
	ConsentType string `json:"consentType"`
	// Active reports whether the subject currently has a recorded grant for
	// this purpose (the consent vector column is non-NULL).
	Active bool `json:"active"`
	// GrantedAt is the state-of-record grant timestamp (omitted when not
	// granted).
	GrantedAt *time.Time `json:"grantedAt,omitempty"`
}

// ConsentReceiptHistoryEntry is one append-only consent change from
// consent_receipts (0140), in the portable receipt's history block.
type ConsentReceiptHistoryEntry struct {
	PrevState            string    `json:"prevState,omitempty"`
	NewState             string    `json:"newState"`
	Source               string    `json:"source"`
	SourceDetail         string    `json:"sourceDetail,omitempty"`
	IP                   string    `json:"ip,omitempty"`
	UserAgent            string    `json:"userAgent,omitempty"`
	PrivacyPolicyVersion string    `json:"privacyPolicyVersion,omitempty"`
	CapturedText         string    `json:"capturedText,omitempty"`
	At                   time.Time `json:"at"`
}

type Suppression struct {
	ID              string         `json:"id"`
	Email           string         `json:"email"`
	Reason          string         `json:"reason"`
	Source          string         `json:"source"`
	ProviderEventID string         `json:"provider_event_id,omitempty"`
	CampaignID      string         `json:"campaign_id,omitempty"`
	Metadata        map[string]any `json:"metadata"`
	SuppressedAt    time.Time      `json:"suppressed_at"`
	ExpiresAt       *time.Time     `json:"expires_at,omitempty"`
	CreatedAt       time.Time      `json:"created_at"`
}

type SuppressionPage struct {
	Items   []Suppression `json:"items"`
	Total   int           `json:"total"`
	Page    int           `json:"page"`
	PerPage int           `json:"per_page"`
}

type CreateSuppressionInput struct {
	Email           string         `json:"email"`
	Reason          string         `json:"reason"`
	Source          string         `json:"source"`
	ProviderEventID string         `json:"provider_event_id"`
	CampaignID      string         `json:"campaign_id"`
	Metadata        map[string]any `json:"metadata"`
	ExpiresAt       *time.Time     `json:"expires_at"`
}

// CreateInput is accepted by POST /api/v1/subscribers.
type CreateInput struct {
	// PreserveConsentState makes profile-only integration upserts consent
	// neutral on conflict. It is never decoded from JSON. Fresh identities still
	// start unconfirmed/unknown; existing status, purpose timestamps, and
	// unsubscribe state are not overwritten by a CRM/analytics/support sync.
	PreserveConsentState bool             `json:"-"`
	Email                string           `json:"email"`
	Status               string           `json:"status"`
	MailchimpStatus      string           `json:"mailchimp_status"`
	ConsentTimestamp     *time.Time       `json:"consent_timestamp"`
	ConsentSource        string           `json:"consent_source"`
	ConsentChannel       string           `json:"consent_channel"`
	ConsentLegalBasis    string           `json:"consent_legal_basis"`
	ConsentEvidence      string           `json:"consent_evidence"`
	ConsentReason        string           `json:"consent_reason"`
	ConsentPolicyVersion string           `json:"consent_policy_version"`
	CustomFields         map[string]any   `json:"custom_fields"`
	MergeFields          map[string]any   `json:"merge_fields"`
	Tags                 []string         `json:"tags"`
	Groups               []map[string]any `json:"groups"`
	GDPRPermissions      []map[string]any `json:"gdpr_permissions"`
	SignupIP             string           `json:"signup_ip"`
	UnsubscribeReason    string           `json:"unsubscribe_reason"`
	MailchimpLastChanged *time.Time       `json:"mailchimp_last_changed"`
	ActivitySummary      map[string]any   `json:"activity_summary"`
	SourceID             string           `json:"source_id"`
	SourcePlatform       string           `json:"source_platform"`
	// Name columns (SUB-004). When omitted, the upsert path derives
	// first/last from merge_fields FNAME/LNAME (Mailchimp) or custom_fields
	// first_name/last_name (Klaviyo), and full/display from those.
	FirstName   string `json:"first_name"`
	LastName    string `json:"last_name"`
	FullName    string `json:"full_name"`
	DisplayName string `json:"display_name"`
	// Localization columns (SUB-005). Pointer-free here because Create
	// always writes a value (empty becomes NULL via NULLIF in the upsert).
	Locale   string `json:"locale"`
	Language string `json:"language"`
	Country  string `json:"country"`
	Region   string `json:"region"`
	// SignupSource pins the subscribers.signup_source column at create
	// time. Optional — Repo.Upsert falls through to the consent-derived
	// resolver when empty. Use the SignupSource* constants in types.go.
	SignupSource SignupSource `json:"signup_source"`
	// GppSections is the SUB-120 per-jurisdiction GPP section map captured at
	// create time (migration 0562). Optional; merged into the row's
	// gpp_sections jsonb. nil/empty leaves the column at its '{}' default.
	GppSections map[string]string `json:"gpp_sections,omitempty"`
}

// UpdateInput is accepted by PATCH /api/v1/subscribers/{id}. Pointer fields
// distinguish omitted values from explicit empty values.
// --- Extended bulk-verb inputs (SUB-100-bulk-verbs) ---
//
// Each embeds BulkTarget so the existing resolveAudience(explicit ids OR
// segment_id) machinery applies unchanged. The verb-specific payload field is
// validated in the handler before any DB write.

// BulkResubscribeInput is the body for POST /subscribers/bulk/resubscribe —
// the inverse of bulk/unsubscribe. It carries only the audience selector.
type BulkResubscribeInput struct {
	BulkTarget
	ConsentProvenanceInput
}

// ConsentProvenanceInput is the defensible, immutable evidence attached to a
// consent grant, revocation, or send-eligibility restoration. None of these
// fields is inferred from the import/admin channel.
type ConsentProvenanceInput struct {
	Source        string     `json:"source"`
	Channel       string     `json:"channel"`
	LegalBasis    string     `json:"legal_basis"`
	OccurredAt    *time.Time `json:"occurred_at"`
	Jurisdiction  string     `json:"jurisdiction"`
	Evidence      string     `json:"evidence"`
	Reason        string     `json:"reason"`
	PolicyVersion string     `json:"policy_version"`
}

// BulkCustomFieldInput is the body for POST /subscribers/bulk/set-custom-field.
// Key is the custom_fields JSON key to set; Value is the new value (any JSON
// scalar/object). A nil Value with Remove=true deletes the key instead.
type BulkCustomFieldInput struct {
	BulkTarget
	Key    string `json:"key"`
	Value  any    `json:"value"`
	Remove bool   `json:"remove,omitempty"`
}

// BulkMergeFieldInput is the body for POST /subscribers/bulk/update-merge-field.
// Identical shape to BulkCustomFieldInput but patches the merge_fields jsonb
// column (Mailchimp-style merge tags) rather than custom_fields.
type BulkMergeFieldInput struct {
	BulkTarget
	Key    string `json:"key"`
	Value  any    `json:"value"`
	Remove bool   `json:"remove,omitempty"`
}

// BulkConsentInput is the body for POST /subscribers/bulk/grant-consent and
// /subscribers/bulk/revoke-consent. Category must be one of the consent_events
// CHECK vocabulary; Channel defaults to 'api'.
type BulkConsentInput struct {
	BulkTarget
	Category string `json:"category"`
	ConsentProvenanceInput
}

// BulkExportInput is the body for POST /subscribers/bulk/export-by-segment.
// Limit (optional) caps the exported rows.
type BulkExportInput struct {
	BulkTarget
	Limit int `json:"limit,omitempty"`
}

type UpdateInput struct {
	// IfMatchToken carries the optimistic-concurrency token parsed from the
	// request's If-Match header (json:"-" so a client can't set it via the
	// body). When non-empty, Update returns ErrPreconditionFailed unless it
	// matches the row's current version.
	IfMatchToken string `json:"-"`

	Email            *string    `json:"email"`
	Status           *string    `json:"status"`
	MailchimpStatus  *string    `json:"mailchimp_status"`
	ConsentTimestamp *time.Time `json:"consent_timestamp"`
	ConsentSource    *string    `json:"consent_source"`
	// The remaining consent_* fields form the reviewed evidence envelope for
	// an explicit status=enabled transition on the generic PATCH surface.
	// Omission never fabricates consent; callers without this evidence must use
	// a non-sendable status or the dedicated consent workflow.
	ConsentChannel       string           `json:"consent_channel,omitempty"`
	ConsentLegalBasis    string           `json:"consent_legal_basis,omitempty"`
	ConsentJurisdiction  string           `json:"consent_jurisdiction,omitempty"`
	ConsentEvidence      string           `json:"consent_evidence,omitempty"`
	ConsentReason        string           `json:"consent_reason,omitempty"`
	ConsentPolicyVersion string           `json:"consent_policy_version,omitempty"`
	CustomFields         map[string]any   `json:"custom_fields"`
	MergeFields          map[string]any   `json:"merge_fields"`
	Tags                 []string         `json:"tags"`
	Groups               []map[string]any `json:"groups"`
	GDPRPermissions      []map[string]any `json:"gdpr_permissions"`
	SignupIP             *string          `json:"signup_ip"`
	UnsubscribeReason    *string          `json:"unsubscribe_reason"`
	MailchimpLastChanged *time.Time       `json:"mailchimp_last_changed"`
	ActivitySummary      map[string]any   `json:"activity_summary"`
	SourceID             *string          `json:"source_id"`
	SourcePlatform       *string          `json:"source_platform"`
	// Name columns (SUB-004). Pointer fields so an omitted key leaves the
	// existing value untouched while an explicit empty string clears it.
	FirstName   *string `json:"first_name"`
	LastName    *string `json:"last_name"`
	FullName    *string `json:"full_name"`
	DisplayName *string `json:"display_name"`
	// Localization columns (SUB-005). Pointer fields so an omitted key is a
	// no-op and an explicit value (including "") updates the column. An
	// empty string is normalised to a NULL write in the repo.
	Locale   *string `json:"locale"`
	Language *string `json:"language"`
	Country  *string `json:"country"`
	Region   *string `json:"region"`
	// DataRegion is the SUB-052 per-subscriber data-residency override
	// (migration 0524). Pointer so an omitted key is a no-op; an explicit
	// "" clears the override (revert to tenant inheritance); a non-empty
	// value must be one of regions.Allowed() and is validated in
	// normalizeUpdate before the repo write.
	DataRegion *string `json:"data_region"`
	// GppSections is the SUB-120 per-jurisdiction GPP section map (migration
	// 0562). When non-nil it MERGES into the existing gpp_sections jsonb (a key
	// with an empty-string value deletes that jurisdiction's section); nil is a
	// no-op. The dedicated PATCH /subscribers/{id}/gpp handler is the primary
	// write path, but it is also accepted on the generic PATCH for convenience.
	GppSections map[string]string `json:"gpp_sections,omitempty"`
	// PredictionModelVersion / PredictionConfidence are the SUB-010 predictive-
	// score versioning fields (migration 0900). When either is non-nil the
	// generic PATCH upserts a subscriber_prediction_metadata snapshot for
	// PredictionScoreType (default 'churn' when omitted), recording the model
	// lineage behind the cached churn/engagement scalar. The dedicated
	// PATCH /subscribers/{id}/prediction-metadata is the primary write path; this
	// convenience accept keeps the generic Update lossless. Pointer fields so an
	// omitted key is a no-op. nil/nil = no metadata write.
	PredictionModelVersion *string  `json:"prediction_model_version"`
	PredictionConfidence   *float64 `json:"prediction_confidence"`
	PredictionScoreType    string   `json:"prediction_score_type,omitempty"`
	// FrequencyPreference is the SUB-132 subscriber-level send-cadence hint
	// (migration 0180 column). Pointer so an omitted key is a no-op; an explicit
	// value must be one of 'default' | 'weekly' | 'monthly' | 'paused'
	// (validated in normalizeUpdate against the migration 0180 CHECK). This is
	// the API write path the FrequencyPreferencePanel uses, mirroring the
	// smart-unsubscribe public endpoint that already writes the same column.
	FrequencyPreference *string `json:"frequency_preference"`
	// PausedUntil is the SUB-132 auto-reactivation timestamp (migration 0180
	// column). Pointer + ClearPausedUntil distinguish the three intents: nil +
	// ClearPausedUntil=false → leave unchanged; non-nil → set the timestamp;
	// ClearPausedUntil=true → set NULL (paused indefinitely or unpaused). Read
	// at send time by frequency.FilterBySubscriberPreference.
	PausedUntil *time.Time `json:"paused_until"`
	// ClearPausedUntil, when true, drops paused_until (sets it NULL).
	// Distinguishes "clear the timestamp" from "leave it unchanged" since a nil
	// PausedUntil already means "unchanged".
	ClearPausedUntil bool `json:"clear_paused_until"`
	// PauseDays is the SUB-135 vacation-mode convenience: when > 0 it is the
	// number of days from now to auto-reactivation, and normalizeUpdate computes
	// PausedUntil = now + PauseDays (mirroring the smart-unsubscribe public
	// endpoint's pauseDays semantics). Bounded 1..365; an out-of-range value
	// 422s. Supplying PauseDays also pins FrequencyPreference to 'paused' when
	// the caller did not set it explicitly, so "pause for N days" is a single
	// field. Wins over an explicit PausedUntil to keep one canonical source.
	// Omitted (0) is a no-op so the raw PausedUntil/ClearPausedUntil path is
	// unaffected. Not persisted — purely an input-side convenience.
	PauseDays int `json:"pause_days,omitempty"`
}

// ValidFrequencyPreference reports whether v is a recognised
// frequency_preference, matching the migration 0180 CHECK constraint
// (subscribers_frequency_preference_check).
func ValidFrequencyPreference(v string) bool {
	switch v {
	case "default", "weekly", "monthly", "paused":
		return true
	default:
		return false
	}
}
