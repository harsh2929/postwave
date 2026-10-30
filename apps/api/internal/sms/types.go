package sms

import (
	"context"
	"time"
)

const (
	ProviderTwilio    = "twilio"
	ProviderTelnyx    = "telnyx"
	ProviderBandwidth = "bandwidth"
	// ConsentProviderProduct is non-carrier provenance for product/form/import/
	// manual evidence. It is deliberately not a send-capable Provider value.
	ConsentProviderProduct = "product"

	RegistrationNotStarted = "not_started"
	RegistrationDraft      = "draft"
	RegistrationPending    = "pending"
	RegistrationApproved   = "approved"
	RegistrationRejected   = "rejected"
	RegistrationSuspended  = "suspended"

	SubscriptionPending  = "pending"
	SubscriptionOptedIn  = "opted_in"
	SubscriptionOptedOut = "opted_out"

	ConsentGranted       = "granted"
	ConsentRevoked       = "revoked"
	ConsentHelpRequested = "help_requested"
	ConsentImported      = "imported"

	// SuppressionStopKeyword matches the canonical reason value in
	// sms_suppressions.reason set by migration 0253 (the legacy
	// 'opt_out' value is no longer in the CHECK enum).
	SuppressionStopKeyword = "stop_keyword"
)

// SenderProfile is the tenant's registered SMS sender identity. US/Canada
// launch supports Twilio, Telnyx, and Bandwidth through provider-specific
// sender/application/profile identifiers plus phone-number fallback where
// allowed.
type SenderProfile struct {
	ID                      string         `json:"id"`
	TenantID                string         `json:"tenant_id,omitempty"`
	Provider                string         `json:"provider"`
	Country                 string         `json:"country"`
	SenderType              string         `json:"sender_type"`
	PhoneNumber             string         `json:"phone_number,omitempty"`
	MessagingServiceSID     string         `json:"messaging_service_sid,omitempty"`
	BrandRegistrationSID    string         `json:"brand_registration_sid,omitempty"`
	CampaignRegistrationSID string         `json:"campaign_registration_sid,omitempty"`
	RegistrationStatus      string         `json:"registration_status"`
	Capabilities            map[string]any `json:"capabilities,omitempty"`
	Metadata                map[string]any `json:"metadata,omitempty"`
	CreatedAt               time.Time      `json:"created_at"`
	UpdatedAt               time.Time      `json:"updated_at"`
}

type SetupStatus struct {
	Senders         []SenderProfile `json:"senders"`
	CanSend         bool            `json:"can_send"`
	BlockingReasons []string        `json:"blocking_reasons"`
}

type ComplianceItem struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Complete bool   `json:"complete"`
	Detail   string `json:"detail,omitempty"`
}

type ComplianceStatus struct {
	CanSend bool             `json:"can_send"`
	Senders []SenderProfile  `json:"senders"`
	Items   []ComplianceItem `json:"items"`
}

type SMSList struct {
	ID              string    `json:"id"`
	TenantID        string    `json:"tenant_id,omitempty"`
	Name            string    `json:"name"`
	Description     string    `json:"description"`
	Keyword         string    `json:"keyword,omitempty"`
	SenderProfileID string    `json:"sender_profile_id,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
	RecipientCount  int       `json:"recipient_count"`
}

type SMSListInput struct {
	Name            string `json:"name"`
	Description     string `json:"description"`
	Keyword         string `json:"keyword"`
	SenderProfileID string `json:"sender_profile_id"`
}

// SMSListMember is one row of a list's opted-in roster (SMS-004).
type SMSListMember struct {
	PhoneE164       string  `json:"phone_e164"`
	Status          string  `json:"status"`
	Source          string  `json:"source,omitempty"`
	SubscriberEmail string  `json:"subscriber_email,omitempty"`
	ConsentAt       *string `json:"consent_at,omitempty"`
}

type SenderInput struct {
	Provider                string         `json:"provider"`
	Country                 string         `json:"country"`
	SenderType              string         `json:"sender_type"`
	PhoneNumber             string         `json:"phone_number"`
	MessagingServiceSID     string         `json:"messaging_service_sid"`
	BrandRegistrationSID    string         `json:"brand_registration_sid"`
	CampaignRegistrationSID string         `json:"campaign_registration_sid"`
	RegistrationStatus      string         `json:"registration_status"`
	Capabilities            map[string]any `json:"capabilities"`
	Metadata                map[string]any `json:"metadata"`
}

type SenderRegistrationPatch struct {
	BrandRegistrationSID    string         `json:"brand_registration_sid"`
	CampaignRegistrationSID string         `json:"campaign_registration_sid"`
	RegistrationStatus      string         `json:"registration_status"`
	Metadata                map[string]any `json:"metadata"`
}

type SenderPauseInput struct {
	Reason string `json:"reason"`
}

type TwilioBrandRegistrationInput struct {
	CustomerProfileBundleSID string `json:"customer_profile_bundle_sid"`
	A2PProfileBundleSID      string `json:"a2p_profile_bundle_sid"`
	BrandType                string `json:"brand_type"`
	SkipAutomaticSecVet      bool   `json:"skip_automatic_sec_vet"`
}

type A2PBrandRegistrationInput struct {
	TwilioBrandRegistrationInput
	EntityType           string `json:"entity_type"`
	DisplayName          string `json:"display_name"`
	CompanyName          string `json:"company_name"`
	EIN                  string `json:"ein"`
	Phone                string `json:"phone"`
	Street               string `json:"street"`
	City                 string `json:"city"`
	State                string `json:"state"`
	PostalCode           string `json:"postal_code"`
	Country              string `json:"country"`
	Email                string `json:"email"`
	Website              string `json:"website"`
	Vertical             string `json:"vertical"`
	AltBusinessID        string `json:"alt_business_id"`
	AltBusinessIDType    string `json:"alt_business_id_type"`
	StockSymbol          string `json:"stock_symbol"`
	StockExchange        string `json:"stock_exchange"`
	BrandRelationship    string `json:"brand_relationship"`
	BusinessContactEmail string `json:"business_contact_email"`
	IsMain               *bool  `json:"is_main"`
}

type TwilioCampaignRegistrationInput struct {
	BrandRegistrationSID string   `json:"brand_registration_sid"`
	Usecase              string   `json:"usecase"`
	Description          string   `json:"description"`
	MessageFlow          string   `json:"message_flow"`
	MessageSamples       []string `json:"message_samples"`
	SubscriberOptIn      bool     `json:"subscriber_opt_in"`
	HasEmbeddedLinks     bool     `json:"has_embedded_links"`
	HasEmbeddedPhone     bool     `json:"has_embedded_phone"`
	AgeGated             bool     `json:"age_gated"`
	DirectLending        bool     `json:"direct_lending"`
	OptInKeywords        string   `json:"opt_in_keywords"`
	OptInMessage         string   `json:"opt_in_message"`
	OptOutKeywords       string   `json:"opt_out_keywords"`
	OptOutMessage        string   `json:"opt_out_message"`
	HelpKeywords         string   `json:"help_keywords"`
	HelpMessage          string   `json:"help_message"`
}

type A2PCampaignRegistrationInput struct {
	TwilioCampaignRegistrationInput
	Vertical               string   `json:"vertical"`
	SubUsecases            []string `json:"sub_usecases"`
	NumberPool             bool     `json:"number_pool"`
	AffiliateMarketing     bool     `json:"affiliate_marketing"`
	AutoRenewal            *bool    `json:"auto_renewal"`
	TermsAndConditionsLink string   `json:"terms_and_conditions_link"`
	PrivacyPolicyLink      string   `json:"privacy_policy_link"`
}

type SmsRegistrationResource struct {
	SID    string         `json:"sid,omitempty"`
	Status string         `json:"status,omitempty"`
	Raw    map[string]any `json:"raw,omitempty"`
}

type A2PRegistrationResult struct {
	Sender   SenderProfile           `json:"sender"`
	Brand    SmsRegistrationResource `json:"brand,omitempty"`
	Campaign SmsRegistrationResource `json:"campaign,omitempty"`
	Message  string                  `json:"message,omitempty"`
}

type PilotReadinessItem struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Status   string `json:"status"` // pass|warning|blocker
	Detail   string `json:"detail,omitempty"`
	Evidence string `json:"evidence,omitempty"`
}

type SmsPilotReadiness struct {
	CanPilot bool                 `json:"can_pilot"`
	Counts   map[string]int       `json:"counts"`
	Items    []PilotReadinessItem `json:"items"`
}

type SenderPilotCertification struct {
	Sender      SenderProfile        `json:"sender"`
	CanPilot    bool                 `json:"can_pilot"`
	GeneratedAt time.Time            `json:"generated_at"`
	Items       []PilotReadinessItem `json:"items"`
	CallbackURL string               `json:"callback_url,omitempty"`
	StatusURL   string               `json:"status_url,omitempty"`
}

type SendSlotLease struct {
	WaitUntil           time.Time `json:"wait_until"`
	SuspendedUntil      time.Time `json:"suspended_until,omitempty"`
	ConsecutiveFailures int       `json:"consecutive_failures"`
}

type ConsentInput struct {
	ListID          string         `json:"list_id"`
	PhoneE164       string         `json:"phone_e164"`
	SubscriberEmail string         `json:"subscriber_email"`
	Action          string         `json:"action"`
	Source          string         `json:"source"`
	ProofText       string         `json:"proof_text"`
	Provider        string         `json:"provider"`
	ProviderEventID string         `json:"provider_event_id"`
	Metadata        map[string]any `json:"metadata"`
}

type Campaign struct {
	ID              string         `json:"id"`
	TenantID        string         `json:"tenant_id,omitempty"`
	SenderProfileID string         `json:"sender_profile_id,omitempty"`
	ListID          string         `json:"list_id,omitempty"`
	Name            string         `json:"name"`
	Body            string         `json:"body"`
	MediaURL        string         `json:"media_url,omitempty"`
	Status          string         `json:"status"`
	ScheduledAt     *time.Time     `json:"scheduled_at,omitempty"`
	SentAt          *time.Time     `json:"sent_at,omitempty"`
	Stats           map[string]any `json:"stats,omitempty"`
	Metadata        map[string]any `json:"metadata,omitempty"`
	CreatedAt       time.Time      `json:"created_at"`
	UpdatedAt       time.Time      `json:"updated_at"`
}

type CampaignInput struct {
	SenderProfileID string         `json:"sender_profile_id"`
	ListID          string         `json:"list_id"`
	Name            string         `json:"name"`
	Body            string         `json:"body"`
	MediaURL        string         `json:"media_url"`
	Status          string         `json:"status"`
	ScheduledAt     *time.Time     `json:"scheduled_at"`
	Metadata        map[string]any `json:"metadata"`
}

type CampaignStatusInput struct {
	ScheduledAt *time.Time `json:"scheduled_at"`
}

type BroadcastInput struct {
	Limit        int   `json:"limit"`
	LinkTracking *bool `json:"link_tracking"`
}

type BroadcastResult struct {
	Campaign   Campaign `json:"campaign"`
	Recipients int      `json:"recipients"`
	Queued     int      `json:"queued"`
	// Scheduled counts recipients whose delivery was deferred to a future
	// per-recipient instant by send-time optimization (SMS-037); they are
	// included in Queued.
	Scheduled           int      `json:"scheduled,omitempty"`
	Accepted            int      `json:"accepted"`
	Blocked             int      `json:"blocked"`
	Failed              int      `json:"failed"`
	Segments            int      `json:"segments"`
	CostMicros          int64    `json:"cost_micros"`
	EstimatedCostMicros int64    `json:"estimated_cost_micros"`
	CostCapMicros       int64    `json:"cost_cap_micros,omitempty"`
	LinkTracking        bool     `json:"link_tracking"`
	BlockingCodes       []string `json:"blocking_codes,omitempty"`
}

type MMSProviderSupport struct {
	Provider          string `json:"provider"`
	SupportsMMS       bool   `json:"supports_mms"`
	SupportsMediaURL  bool   `json:"supports_media_url"`
	SmokeTestRequired bool   `json:"smoke_test_required"`
	Detail            string `json:"detail"`
}

type MMSSenderReadiness struct {
	SenderID           string     `json:"sender_id"`
	Provider           string     `json:"provider"`
	Country            string     `json:"country"`
	SenderType         string     `json:"sender_type"`
	RegistrationStatus string     `json:"registration_status"`
	Ready              bool       `json:"ready"`
	LiveSmokeStatus    string     `json:"live_smoke_status"`
	LiveSmokeRequired  bool       `json:"live_smoke_required"`
	LastSmokeAt        *time.Time `json:"last_smoke_at,omitempty"`
	Warnings           []string   `json:"warnings,omitempty"`
}

type MMSReadinessResponse struct {
	Ready              bool                 `json:"ready"`
	SupportedCountries []string             `json:"supported_countries"`
	Providers          []MMSProviderSupport `json:"providers"`
	Senders            []MMSSenderReadiness `json:"senders"`
	LiveSmokeRequired  bool                 `json:"live_smoke_required"`
	SmokeTestContract  map[string]any       `json:"smoke_test_contract,omitempty"`
	Warnings           []string             `json:"warnings,omitempty"`
}

type SMSCreditPreviewInput struct {
	Body           string `json:"body"`
	MediaURL       string `json:"media_url"`
	Country        string `json:"country"`
	SenderType     string `json:"sender_type"`
	RecipientCount int    `json:"recipient_count"`
}

type SMSCreditLineItem struct {
	Label   string `json:"label"`
	Credits int    `json:"credits"`
	Count   int    `json:"count"`
	Total   int    `json:"total"`
}

type SMSCreditPreviewResponse struct {
	Channel                  string              `json:"channel"`
	Country                  string              `json:"country"`
	RegionStatus             string              `json:"region_status"`
	MMS                      bool                `json:"mms"`
	MMSSupported             bool                `json:"mms_supported"`
	Segments                 int                 `json:"segments"`
	RecipientCount           int                 `json:"recipient_count"`
	PerRecipientCredits      int                 `json:"per_recipient_credits"`
	TotalCredits             int                 `json:"total_credits"`
	CreditValueMicros        int64               `json:"credit_value_micros"`
	EstimatedCostMicros      int64               `json:"estimated_cost_micros"`
	EstimatedDurationSeconds int                 `json:"estimated_duration_seconds"`
	SendDurationLabel        string              `json:"send_duration_label"`
	LineItems                []SMSCreditLineItem `json:"line_items"`
	BalanceAfterCredits      *int                `json:"balance_after_credits,omitempty"`
	EntitlementStatus        string              `json:"entitlement_status,omitempty"`
	TopUpRecommended         bool                `json:"top_up_recommended,omitempty"`
	Warnings                 []string            `json:"warnings,omitempty"`
}

type SMSCreditBalanceResponse struct {
	TenantID         string         `json:"tenant_id,omitempty"`
	Plan             string         `json:"plan"`
	IncludedCredits  int            `json:"included_credits"`
	PurchasedCredits int            `json:"purchased_credits"`
	UsedCredits      int            `json:"used_credits"`
	AvailableCredits int            `json:"available_credits"`
	PeriodStart      time.Time      `json:"period_start"`
	PeriodEnd        time.Time      `json:"period_end"`
	Entitlements     map[string]any `json:"entitlements"`
	LedgerMode       string         `json:"ledger_mode"`
	Warnings         []string       `json:"warnings,omitempty"`
}

type SMSCreditTopUpInput struct {
	Credits int    `json:"credits"`
	Plan    string `json:"plan"`
}

type SMSCreditTopUpQuoteResponse struct {
	Credits            int                      `json:"credits"`
	UnitPriceMicros    int64                    `json:"unit_price_micros"`
	SubtotalMicros     int64                    `json:"subtotal_micros"`
	BonusCredits       int                      `json:"bonus_credits"`
	TotalCredits       int                      `json:"total_credits"`
	CheckoutMode       string                   `json:"checkout_mode"`
	EntitlementPreview SMSCreditBalanceResponse `json:"entitlement_preview"`
	LineItems          []SMSCreditLineItem      `json:"line_items"`
	Warnings           []string                 `json:"warnings,omitempty"`
}

type SMSCreditTopUpCheckoutResponse struct {
	Status      string                      `json:"status"`
	CheckoutURL string                      `json:"checkout_url,omitempty"`
	Quote       SMSCreditTopUpQuoteResponse `json:"quote"`
	Metadata    map[string]any              `json:"metadata,omitempty"`
}

type SMSProgramRegion struct {
	Country              string   `json:"country"`
	Label                string   `json:"label"`
	Status               string   `json:"status"`
	SupportsSMS          bool     `json:"supports_sms"`
	SupportsMMS          bool     `json:"supports_mms"`
	SMSCredits           int      `json:"sms_credits"`
	MMSCredits           int      `json:"mms_credits,omitempty"`
	DefaultSenderTypes   []string `json:"default_sender_types"`
	ComplianceSummary    string   `json:"compliance_summary"`
	ProviderRequirements []string `json:"provider_requirements,omitempty"`
	LiveSendingEnabled   bool     `json:"live_sending_enabled"`
	LaunchPhase          string   `json:"launch_phase"`
	RequiredSetup        []string `json:"required_setup,omitempty"`
}

type SMSProgramRegionsResponse struct {
	Items []SMSProgramRegion `json:"items"`
}

type SMSTemplate struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Category     string   `json:"category"`
	Body         string   `json:"body"`
	MediaAllowed bool     `json:"media_allowed"`
	MergeFields  []string `json:"merge_fields"`
	Tags         []string `json:"tags"`
}

type SMSTemplatesResponse struct {
	Items []SMSTemplate `json:"items"`
}

type SMSDiscountCode struct {
	ID                  string     `json:"id"`
	Code                string     `json:"code"`
	Label               string     `json:"label"`
	PercentOff          int        `json:"percent_off,omitempty"`
	AmountOffCents      int        `json:"amount_off_cents,omitempty"`
	Currency            string     `json:"currency,omitempty"`
	AppliesTo           string     `json:"applies_to"`
	MaxRedemptions      int        `json:"max_redemptions,omitempty"`
	TimesRedeemed       int        `json:"times_redeemed"`
	ExpiresAt           *time.Time `json:"expires_at,omitempty"`
	CurrentlyRedeemable bool       `json:"currently_redeemable"`
	Source              string     `json:"source"`
	SyncStatus          string     `json:"sync_status"`
	StoreProvider       string     `json:"store_provider,omitempty"`
	CreatedAt           time.Time  `json:"created_at"`
}

type SMSDiscountCodesResponse struct {
	Items        []SMSDiscountCode `json:"items"`
	Sources      []string          `json:"sources,omitempty"`
	SyncStatus   string            `json:"sync_status,omitempty"`
	Capabilities []string          `json:"capabilities,omitempty"`
}

type CampaignReport struct {
	Campaign       Campaign                   `json:"campaign"`
	Recipients     int                        `json:"recipients"`
	Queued         int                        `json:"queued"`
	Sending        int                        `json:"sending"`
	Sent           int                        `json:"sent"`
	Blocked        int                        `json:"blocked"`
	Failed         int                        `json:"failed"`
	Cancelled      int                        `json:"cancelled"`
	Delivered      int                        `json:"delivered"`
	Undelivered    int                        `json:"undelivered"`
	Clicks         int                        `json:"clicks"`
	UniqueClickers int                        `json:"unique_clickers"`
	Segments       int                        `json:"segments"`
	CostMicros     int64                      `json:"cost_micros"`
	StatusCounts   map[string]int             `json:"status_counts"`
	LinkClicks     []CampaignLinkClickSummary `json:"link_clicks"`
	RecentClicks   []CampaignLinkClickEvent   `json:"recent_clicks"`
}

// CampaignVariantStat is the per-variant send outcome for an A/B campaign
// (SMS-036). Metrics are recipient-side (send success + cost per variant),
// the winner signal for the bounded A/B slice.
type CampaignVariantStat struct {
	Variant    string `json:"variant"`
	Total      int    `json:"total"`
	Sent       int    `json:"sent"`
	Failed     int    `json:"failed"`
	Blocked    int    `json:"blocked"`
	Segments   int    `json:"segments"`
	CostMicros int64  `json:"cost_micros"`
}

type CampaignLinkClickSummary struct {
	URL            string    `json:"url"`
	Clicks         int       `json:"clicks"`
	UniqueClickers int       `json:"unique_clickers"`
	LastClickedAt  time.Time `json:"last_clicked_at"`
}

type CampaignLinkClickEvent struct {
	PhoneE164 string    `json:"phone_e164"`
	MessageID string    `json:"message_id,omitempty"`
	URL       string    `json:"url"`
	ClickedAt time.Time `json:"clicked_at"`
}

type CampaignReportExportRow struct {
	PhoneE164         string     `json:"phone_e164"`
	RecipientStatus   string     `json:"recipient_status"`
	MessageStatus     string     `json:"message_status,omitempty"`
	Attempts          int        `json:"attempts"`
	Segments          int        `json:"segments"`
	CostMicros        int64      `json:"cost_micros"`
	ProviderMessageID string     `json:"provider_message_id,omitempty"`
	ErrorCode         string     `json:"error_code,omitempty"`
	ErrorMessage      string     `json:"error_message,omitempty"`
	QueuedAt          time.Time  `json:"queued_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
	SentAt            *time.Time `json:"sent_at,omitempty"`
	DeliveredAt       *time.Time `json:"delivered_at,omitempty"`
}

type QueuedRecipient struct {
	ID              string
	TenantID        string
	CampaignID      string
	SenderProfileID string
	ListID          string
	PhoneE164       string
	Body            string
	MediaURL        string
	Segments        int
	Attempts        int
	LinkTracking    bool
	Metadata        map[string]any
}

type SendInput struct {
	SenderProfileID string         `json:"sender_profile_id"`
	ListID          string         `json:"list_id"`
	To              string         `json:"to"`
	Body            string         `json:"body"`
	MediaURL        string         `json:"media_url"`
	CampaignID      string         `json:"campaign_id"`
	Metadata        map[string]any `json:"metadata"`
}

type Message struct {
	ID                string `json:"id"`
	TenantID          string `json:"tenant_id,omitempty"`
	CampaignID        string `json:"campaign_id,omitempty"`
	SenderProfileID   string `json:"sender_profile_id,omitempty"`
	PhoneE164         string `json:"phone_e164"`
	Provider          string `json:"provider"`
	ProviderMessageID string `json:"provider_message_id,omitempty"`
	Direction         string `json:"direction"`
	Body              string `json:"body"`
	// BodyOmittedReason is set only by the private inbox projection when a
	// historical/raw row predates the bounded display contract. Evidence stays
	// untouched in storage; clients render an explicit unavailable state.
	BodyOmittedReason string         `json:"body_omitted_reason,omitempty"`
	MediaURL          string         `json:"media_url,omitempty"`
	Segments          int            `json:"segments"`
	Status            string         `json:"status"`
	ErrorCode         string         `json:"error_code,omitempty"`
	ErrorMessage      string         `json:"error_message,omitempty"`
	CostMicros        int64          `json:"cost_micros"`
	Metadata          map[string]any `json:"metadata,omitempty"`
	SentAt            *time.Time     `json:"sent_at,omitempty"`
	DeliveredAt       *time.Time     `json:"delivered_at,omitempty"`
	ReceivedAt        *time.Time     `json:"received_at,omitempty"`
	CreatedAt         time.Time      `json:"created_at"`
	// DispatchState is exposed only by the private inbox projection for durable
	// reply-intent recovery. The idempotency key is never projected.
	DispatchState string `json:"dispatch_state,omitempty"`
}

type GateSnapshot struct {
	RegistrationStatus string
	SenderPaused       bool
	SubscriptionStatus string
	Suppressed         bool
	QuietHours         bool
	// StatutoryFloor carries the TCPA calling-time evaluation
	// (statutory_quiet_hours.go). It is a separate field from QuietHours
	// because the two answer different questions — "has the operator asked us
	// to hold?" versus "does 47 CFR 64.1200(c)(1) forbid this send?" — and
	// collapsing them would let a tenant switch the statute off by clearing
	// their own window.
	StatutoryFloor       StatutoryFloor
	TenantLimitRemaining int
	Body                 string
}

type GateDecision struct {
	Allowed  bool   `json:"allowed"`
	Reason   string `json:"reason,omitempty"`
	Segments int    `json:"segments"`
	// HoldUntil is set when the block is temporal (quiet_hours): the
	// UTC instant sending may resume. The queue worker uses it to
	// defer the message instead of permanently blocking it.
	HoldUntil *time.Time `json:"hold_until,omitempty"`
}

type ProviderOutbound struct {
	Provider            string
	To                  string
	Body                string
	MediaURL            string
	FromNumber          string
	MessagingServiceSID string
	StatusCallbackURL   string
}

type ProviderResult struct {
	Provider     string
	MessageID    string
	Status       string
	ErrorCode    string
	ErrorMessage string
	RetryAfter   time.Duration
	PriceMicros  int64
	Raw          map[string]any
}

type Provider interface {
	Send(ctx context.Context, msg ProviderOutbound) (ProviderResult, error)
}
