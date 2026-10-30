package mailchimpv3

import "time"

type ListResponse struct {
	Lists      []AudienceList `json:"lists"`
	TotalItems int            `json:"total_items"`
}

type AudienceList struct {
	ID                 string           `json:"id"`
	WebID              int              `json:"web_id"`
	Name               string           `json:"name"`
	Contact            AudienceContact  `json:"contact"`
	PermissionReminder string           `json:"permission_reminder"`
	UseArchiveBar      bool             `json:"use_archive_bar"`
	CampaignDefaults   CampaignDefaults `json:"campaign_defaults"`
	DateCreated        time.Time        `json:"date_created"`
	ListRating         int              `json:"list_rating"`
	EmailTypeOption    bool             `json:"email_type_option"`
	SubscribeURLShort  string           `json:"subscribe_url_short"`
	SubscribeURLLong   string           `json:"subscribe_url_long"`
	BeamerAddress      string           `json:"beamer_address"`
	Visibility         string           `json:"visibility"`
	Stats              AudienceStats    `json:"stats"`
}

type AudienceContact struct {
	Company  string `json:"company"`
	Address1 string `json:"address1"`
	City     string `json:"city"`
	State    string `json:"state"`
	Zip      string `json:"zip"`
	Country  string `json:"country"`
}

type CampaignDefaults struct {
	FromName  string `json:"from_name"`
	FromEmail string `json:"from_email"`
	Subject   string `json:"subject"`
	Language  string `json:"language"`
}

type AudienceStats struct {
	MemberCount               int     `json:"member_count"`
	UnsubscribeCount          int     `json:"unsubscribe_count"`
	CleanedCount              int     `json:"cleaned_count"`
	MemberCountSinceSend      int     `json:"member_count_since_send"`
	UnsubscribeCountSinceSend int     `json:"unsubscribe_count_since_send"`
	CleanedCountSinceSend     int     `json:"cleaned_count_since_send"`
	CampaignCount             int     `json:"campaign_count"`
	CampaignLastSent          string  `json:"campaign_last_sent"`
	MergeFieldCount           int     `json:"merge_field_count"`
	AvgSubRate                int     `json:"avg_sub_rate"`
	AvgUnsubRate              int     `json:"avg_unsub_rate"`
	TargetSubRate             int     `json:"target_sub_rate"`
	OpenRate                  float64 `json:"open_rate"`
	ClickRate                 float64 `json:"click_rate"`
	LastSubDate               string  `json:"last_sub_date"`
	LastUnsubDate             string  `json:"last_unsub_date"`
}

type MembersResponse struct {
	Members    []Member `json:"members"`
	ListID     string   `json:"list_id"`
	TotalItems int      `json:"total_items"`
}

type Member struct {
	ID                          string          `json:"id"`
	EmailAddress                string          `json:"email_address"`
	UniqueEmailID               string          `json:"unique_email_id"`
	ContactID                   string          `json:"contact_id"`
	FullName                    string          `json:"full_name"`
	WebID                       int             `json:"web_id"`
	EmailType                   string          `json:"email_type"`
	Status                      string          `json:"status"`
	ConsentsToOneToOneMessaging bool            `json:"consents_to_one_to_one_messaging"`
	MergeFields                 map[string]any  `json:"merge_fields"`
	Interests                   map[string]bool `json:"interests"`
	Stats                       MemberStats     `json:"stats"`
	IPSignup                    string          `json:"ip_signup"`
	TimestampSignup             *time.Time      `json:"timestamp_signup,omitempty"`
	IPOpt                       string          `json:"ip_opt"`
	TimestampOpt                *time.Time      `json:"timestamp_opt,omitempty"`
	MemberRating                int             `json:"member_rating"`
	LastChanged                 time.Time       `json:"last_changed"`
	Language                    string          `json:"language"`
	VIP                         bool            `json:"vip"`
	EmailClient                 string          `json:"email_client"`
	Location                    map[string]any  `json:"location"`
	Source                      string          `json:"source"`
	TagsCount                   int             `json:"tags_count"`
	Tags                        []Tag           `json:"tags"`
	ListID                      string          `json:"list_id"`
	// Sendable is the canonical Moosewave lifecycle result at the consent layer,
	// not an inference from Mailchimp's descriptive status string. Final
	// delivery can still be withheld by suppression, tenant, or campaign safety
	// controls; clients can use this field to distinguish `status=pending` from
	// a reviewed activation without treating it as a delivery guarantee.
	Sendable            bool   `json:"sendable"`
	ConsentReviewStatus string `json:"consent_review_status"`
	ConsentReviewReason string `json:"consent_review_reason,omitempty"`
	ConsentPurpose      string `json:"consent_purpose,omitempty"`
	// CanonicalStatus is server-internal state used while orchestrating a
	// compatibility update. Never expose it as part of the Mailchimp shape.
	CanonicalStatus string `json:"-"`
}

type MemberStats struct {
	AvgOpenRate  float64 `json:"avg_open_rate"`
	AvgClickRate float64 `json:"avg_click_rate"`
}

type MemberInput struct {
	EmailAddress string          `json:"email_address"`
	Status       string          `json:"status"`
	StatusIfNew  string          `json:"status_if_new"`
	EmailType    string          `json:"email_type"`
	MergeFields  map[string]any  `json:"merge_fields"`
	Interests    map[string]bool `json:"interests"`
	Language     string          `json:"language"`
	VIP          bool            `json:"vip"`
	IPSignup     string          `json:"ip_signup"`
	IPOpt        string          `json:"ip_opt"`
	Tags         []string        `json:"tags"`
	// PostwaveConsent is an opt-in extension for callers that possess a
	// complete, reviewed consent proof. Mailchimp's bare `status=subscribed`
	// is never treated as evidence. The envelope is bound to one exact address
	// and the email_marketing purpose before delegation to the canonical
	// subscriber consent workflow.
	PostwaveConsent *MemberConsentEvidence `json:"postwave_consent,omitempty"`
}

// MemberConsentEvidence is the compatibility facade's reviewed activation
// envelope. Proof is deliberately separate from source/status metadata: every
// field is required for activation and no value is inferred from the request
// channel or a historical subscribers.consent_timestamp.
type MemberConsentEvidence struct {
	EmailAddress  string     `json:"email_address"`
	Purpose       string     `json:"purpose"`
	Source        string     `json:"source"`
	Channel       string     `json:"channel"`
	LegalBasis    string     `json:"legal_basis"`
	OccurredAt    *time.Time `json:"occurred_at"`
	Jurisdiction  string     `json:"jurisdiction"`
	Proof         string     `json:"proof"`
	Reason        string     `json:"reason"`
	PolicyVersion string     `json:"policy_version"`
}

type TagsResponse struct {
	Tags       []Tag `json:"tags"`
	TotalItems int   `json:"total_items"`
}

type Tag struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type TagsInput struct {
	Tags []TagOperation `json:"tags"`
}

type TagOperation struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

type Report struct {
	ID             string          `json:"id"`
	CampaignTitle  string          `json:"campaign_title"`
	Type           string          `json:"type"`
	ListID         string          `json:"list_id"`
	EmailsSent     int             `json:"emails_sent"`
	AbuseReports   int             `json:"abuse_reports"`
	Unsubscribed   int             `json:"unsubscribed"`
	SendTime       *time.Time      `json:"send_time,omitempty"`
	Opens          ReportOpens     `json:"opens"`
	Clicks         ReportClicks    `json:"clicks"`
	Bounces        ReportBounces   `json:"bounces"`
	Ecommerce      ReportEcommerce `json:"ecommerce"`
	DeliveryStatus map[string]any  `json:"delivery_status"`
}

type ReportOpens struct {
	OpensTotal  int     `json:"opens_total"`
	UniqueOpens int     `json:"unique_opens"`
	OpenRate    float64 `json:"open_rate"`
	LastOpen    string  `json:"last_open"`
}

type ReportClicks struct {
	ClicksTotal  int     `json:"clicks_total"`
	UniqueClicks int     `json:"unique_clicks"`
	ClickRate    float64 `json:"click_rate"`
	LastClick    string  `json:"last_click"`
}

type ReportBounces struct {
	HardBounces  int `json:"hard_bounces"`
	SoftBounces  int `json:"soft_bounces"`
	SyntaxErrors int `json:"syntax_errors"`
}

type ReportEcommerce struct {
	TotalOrders  int     `json:"total_orders"`
	TotalSpent   float64 `json:"total_spent"`
	TotalRevenue float64 `json:"total_revenue"`
	CurrencyCode string  `json:"currency_code"`
}

type EmailActivityResponse struct {
	Emails     []EmailActivity `json:"emails"`
	CampaignID string          `json:"campaign_id"`
	TotalItems int             `json:"total_items"`
}

type EmailActivity struct {
	EmailID      string               `json:"email_id"`
	EmailAddress string               `json:"email_address"`
	Activity     []EmailActivityEvent `json:"activity"`
}

type EmailActivityEvent struct {
	Action    string    `json:"action"`
	Timestamp time.Time `json:"timestamp"`
	Type      string    `json:"type,omitempty"`
	URL       string    `json:"url,omitempty"`
	IP        string    `json:"ip,omitempty"`
}

type CampaignsResponse struct {
	Campaigns  []Campaign `json:"campaigns"`
	TotalItems int        `json:"total_items"`
}

type CampaignInput struct {
	Type       string         `json:"type"`
	Recipients map[string]any `json:"recipients"`
	Settings   map[string]any `json:"settings"`
	Tracking   map[string]any `json:"tracking"`
}

type Campaign struct {
	ID             string         `json:"id"`
	WebID          int            `json:"web_id"`
	Type           string         `json:"type"`
	CreateTime     time.Time      `json:"create_time"`
	ArchiveURL     string         `json:"archive_url"`
	LongArchiveURL string         `json:"long_archive_url"`
	Status         string         `json:"status"`
	EmailsSent     int            `json:"emails_sent"`
	SendTime       *time.Time     `json:"send_time,omitempty"`
	ContentType    string         `json:"content_type"`
	Recipients     map[string]any `json:"recipients"`
	Settings       map[string]any `json:"settings"`
	Tracking       map[string]any `json:"tracking"`
	ReportSummary  map[string]any `json:"report_summary"`
}

type CampaignContent struct {
	HTML        string           `json:"html,omitempty"`
	PlainText   string           `json:"plain_text,omitempty"`
	ArchiveHTML string           `json:"archive_html,omitempty"`
	Blocks      []map[string]any `json:"blocks,omitempty"`
	Template    map[string]any   `json:"template,omitempty"`
}

type CampaignScheduleInput struct {
	ScheduleTime string `json:"schedule_time"`
}

type CampaignTestInput struct {
	TestEmails []string `json:"test_emails"`
	SendType   string   `json:"send_type"`
}

type CampaignActionResponse struct {
	ID        string         `json:"id"`
	Status    string         `json:"status"`
	Action    string         `json:"action"`
	Complete  bool           `json:"complete"`
	Queued    bool           `json:"queued,omitempty"`
	Message   string         `json:"message,omitempty"`
	Details   map[string]any `json:"details,omitempty"`
	Timestamp time.Time      `json:"timestamp"`
}

type PlannerQuery struct {
	Start time.Time
	End   time.Time
}

type CampaignPlannerResponse struct {
	Window       map[string]string     `json:"window"`
	Goals        []CampaignGoal        `json:"goals"`
	Touchpoints  []CampaignTouchpoint  `json:"touchpoints"`
	Tasks        []CampaignTask        `json:"tasks"`
	Workflow     PlannerWorkflow       `json:"workflow"`
	Channels     []PlannerChannel      `json:"channels"`
	Capabilities []PlannerCapability   `json:"capabilities"`
	Summary      map[string]int        `json:"summary"`
	Reports      []PlannerReportRollup `json:"reports"`
}

type CampaignGoal struct {
	ID         string    `json:"id"`
	CampaignID string    `json:"campaign_id"`
	Name       string    `json:"name"`
	Metric     string    `json:"metric"`
	Target     float64   `json:"target"`
	Actual     float64   `json:"actual"`
	Status     string    `json:"status"`
	DueAt      time.Time `json:"due_at,omitempty"`
}

type CampaignTouchpoint struct {
	ID               string            `json:"id"`
	Channel          string            `json:"channel"`
	Kind             string            `json:"kind"`
	Name             string            `json:"name"`
	Status           string            `json:"status"`
	ScheduledAt      *time.Time        `json:"scheduled_at,omitempty"`
	SentAt           *time.Time        `json:"sent_at,omitempty"`
	CampaignID       string            `json:"campaign_id,omitempty"`
	ParentCampaignID string            `json:"parent_campaign_id,omitempty"`
	ItemType         string            `json:"item_type,omitempty"`
	Links            map[string]string `json:"links,omitempty"`
	Report           map[string]any    `json:"report,omitempty"`
}

type CampaignTask struct {
	ID          string     `json:"id"`
	CampaignID  string     `json:"campaign_id,omitempty"`
	Title       string     `json:"title"`
	Status      string     `json:"status"`
	Priority    string     `json:"priority"`
	Channel     string     `json:"channel,omitempty"`
	Kind        string     `json:"kind,omitempty"`
	BlockedBy   []string   `json:"blocked_by,omitempty"`
	DueAt       *time.Time `json:"due_at,omitempty"`
	GeneratedBy string     `json:"generated_by"`
}

type PlannerCapability struct {
	Feature string `json:"feature"`
	Status  string `json:"status"`
	Detail  string `json:"detail"`
}

type PlannerReportRollup struct {
	CampaignID   string  `json:"campaign_id"`
	Name         string  `json:"name"`
	Channel      string  `json:"channel"`
	Sent         int     `json:"sent"`
	Opened       int     `json:"opened"`
	Clicked      int     `json:"clicked"`
	Replies      int     `json:"replies"`
	RevenueCents int     `json:"revenue_cents"`
	OpenRate     float64 `json:"open_rate"`
	ClickRate    float64 `json:"click_rate"`
}

type PlannerWorkflow struct {
	Phases       []PlannerPhase      `json:"phases"`
	Reporting    []map[string]string `json:"reporting"`
	GeneratedAt  time.Time           `json:"generated_at"`
	Completeness map[string]any      `json:"completeness"`
}

type PlannerPhase struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Status      string   `json:"status"`
	Touchpoints []string `json:"touchpoints"`
	Tasks       []string `json:"tasks"`
}

type PlannerChannel struct {
	Channel   string `json:"channel"`
	Draft     int    `json:"draft"`
	Scheduled int    `json:"scheduled"`
	Sending   int    `json:"sending"`
	Sent      int    `json:"sent"`
	Planned   int    `json:"planned"`
	Cancelled int    `json:"cancelled"`
	Failed    int    `json:"failed"`
}

type MultivariateTestInput struct {
	WinnerMetric          string                       `json:"winner_metric"`
	EvaluationWindowHours int                          `json:"evaluation_window_hours"`
	SamplePct             float64                      `json:"sample_pct"`
	WinnerRecipientsPct   float64                      `json:"winner_recipients_pct"`
	Variations            []MultivariateVariationInput `json:"variations"`
}

type MultivariateVariationInput struct {
	Label                 string  `json:"label"`
	SubjectLine           string  `json:"subject_line,omitempty"`
	FromName              string  `json:"from_name,omitempty"`
	FromEmail             string  `json:"from_email,omitempty"`
	HTML                  string  `json:"html,omitempty"`
	MJML                  string  `json:"mjml,omitempty"`
	SendTimeOffsetMinutes int     `json:"send_time_offset_minutes,omitempty"`
	Weight                float64 `json:"weight,omitempty"`
}

type MultivariateTest struct {
	CampaignID            string                  `json:"campaign_id"`
	Enabled               bool                    `json:"enabled"`
	WinnerMetric          string                  `json:"winner_metric"`
	EvaluationWindowHours int                     `json:"evaluation_window_hours"`
	SamplePct             float64                 `json:"sample_pct"`
	WinnerRecipientsPct   float64                 `json:"winner_recipients_pct"`
	WinnerDecidedAt       *time.Time              `json:"winner_decided_at,omitempty"`
	WinningVariantID      string                  `json:"winning_variant_id,omitempty"`
	Variations            []MultivariateVariation `json:"variations"`
	Dimensions            []string                `json:"dimensions"`
	Limits                map[string]any          `json:"limits"`
	Execution             MultivariateExecution   `json:"execution"`
	Report                []MultivariateReportRow `json:"report"`
}

type MultivariateVariation struct {
	ID                    string         `json:"id"`
	Label                 string         `json:"label"`
	SubjectLine           string         `json:"subject_line,omitempty"`
	FromName              string         `json:"from_name,omitempty"`
	FromEmail             string         `json:"from_email,omitempty"`
	HTML                  string         `json:"html,omitempty"`
	MJML                  string         `json:"mjml,omitempty"`
	SendTimeOffsetMinutes int            `json:"send_time_offset_minutes"`
	Weight                float64        `json:"weight"`
	Results               map[string]any `json:"results"`
}

type MultivariateExecution struct {
	Status           string   `json:"status"`
	Ready            bool     `json:"ready"`
	VariantCount     int      `json:"variant_count"`
	SamplePct        float64  `json:"sample_pct"`
	HoldoutPct       float64  `json:"holdout_pct"`
	WinnerRolloutPct float64  `json:"winner_rollout_pct"`
	Dimensions       []string `json:"dimensions"`
	Warnings         []string `json:"warnings,omitempty"`
	ProviderContract string   `json:"provider_contract"`
	NextAction       string   `json:"next_action"`
}

type MultivariateReportRow struct {
	VariantID           string             `json:"variant_id"`
	Label               string             `json:"label"`
	Recipients          int                `json:"recipients"`
	Delivered           int                `json:"delivered"`
	OpenRate            float64            `json:"open_rate"`
	ClickRate           float64            `json:"click_rate"`
	ReplyRate           float64            `json:"reply_rate"`
	LiftVsControl       map[string]float64 `json:"lift_vs_control"`
	ConfidenceVsControl float64            `json:"confidence_vs_control"`
	Winner              bool               `json:"winner"`
}

type SendTimeOptimizationResponse struct {
	CampaignID       string                     `json:"campaign_id"`
	Recommendation   OptimizationRecommendation `json:"recommendation"`
	Candidates       []OptimizationCandidate    `json:"candidates"`
	HistoricalWindow map[string]string          `json:"historical_window"`
	DataPoints       int                        `json:"data_points"`
	Method           string                     `json:"method"`
}

type SendDayOptimizationResponse struct {
	CampaignID       string                     `json:"campaign_id"`
	Recommendation   OptimizationRecommendation `json:"recommendation"`
	Days             []OptimizationCandidate    `json:"days"`
	HistoricalWindow map[string]string          `json:"historical_window"`
	DataPoints       int                        `json:"data_points"`
	Method           string                     `json:"method"`
}

type OptimizationRecommendation struct {
	Label      string    `json:"label"`
	SendAt     time.Time `json:"send_at,omitempty"`
	Score      float64   `json:"score"`
	Confidence string    `json:"confidence"`
	Reason     string    `json:"reason"`
	Grade      string    `json:"grade,omitempty"`
	MethodNote string    `json:"method_note,omitempty"`
}

type OptimizationCandidate struct {
	Label          string    `json:"label"`
	SendAt         time.Time `json:"send_at,omitempty"`
	Score          float64   `json:"score"`
	Opens          int       `json:"opens"`
	Clicks         int       `json:"clicks"`
	Confidence     string    `json:"confidence"`
	Grade          string    `json:"grade,omitempty"`
	Delivered      int       `json:"delivered,omitempty"`
	EngagementRate float64   `json:"engagement_rate,omitempty"`
}

type ClickMapResponse struct {
	CampaignID  string           `json:"campaign_id"`
	TotalClicks int              `json:"total_clicks"`
	Links       []ClickMapLink   `json:"links"`
	DeviceViews []ClickMapDevice `json:"device_views"`
	Overlay     ClickMapOverlay  `json:"overlay"`
	GeneratedAt time.Time        `json:"generated_at"`
}

type ClickMapLink struct {
	LinkID       string             `json:"link_id"`
	URL          string             `json:"url"`
	Selector     string             `json:"selector,omitempty"`
	Clicks       int                `json:"clicks"`
	UniqueClicks int                `json:"unique_clicks"`
	Share        float64            `json:"share"`
	Devices      map[string]int     `json:"devices"`
	Coordinates  map[string]float64 `json:"coordinates,omitempty"`
}

type ClickMapDevice struct {
	Device      string         `json:"device"`
	TotalClicks int            `json:"total_clicks"`
	Links       []ClickMapLink `json:"links"`
}

type ClickMapOverlay struct {
	HTML       string         `json:"html,omitempty"`
	RenderHint string         `json:"render_hint"`
	Width      int            `json:"width"`
	Height     int            `json:"height"`
	Legend     map[string]any `json:"legend"`
}

type CustomReportInput struct {
	View      string            `json:"view"`
	Metrics   []string          `json:"metrics"`
	GroupBy   []string          `json:"group_by"`
	Filters   map[string]string `json:"filters"`
	StartDate string            `json:"start_date"`
	EndDate   string            `json:"end_date"`
	Format    string            `json:"format"`
}

type CustomReportResponse struct {
	ID               string              `json:"id"`
	View             string              `json:"view"`
	Metrics          []string            `json:"metrics"`
	GroupBy          []string            `json:"group_by"`
	Filters          map[string]string   `json:"filters"`
	Window           map[string]string   `json:"window"`
	Rows             []CustomReportRow   `json:"rows"`
	Graph            []CustomReportPoint `json:"graph"`
	Export           map[string]string   `json:"export"`
	Exports          map[string]string   `json:"exports"`
	Retention        map[string]any      `json:"retention"`
	AvailableMetrics []string            `json:"available_metrics"`
	AvailableGroupBy []string            `json:"available_group_by"`
	GeneratedAt      time.Time           `json:"generated_at"`
}

type CustomReportRow struct {
	Dimensions map[string]string  `json:"dimensions"`
	Metrics    map[string]float64 `json:"metrics"`
}

type CustomReportPoint struct {
	Date    string             `json:"date"`
	Metrics map[string]float64 `json:"metrics"`
}

type DeliveryInsightsResponse struct {
	CampaignID            string         `json:"campaign_id"`
	Status                string         `json:"status"`
	CanCancel             bool           `json:"can_cancel"`
	Cancelled             bool           `json:"cancelled"`
	Progress              map[string]int `json:"progress"`
	DeliveryStatus        string         `json:"delivery_status"`
	EstimatedFinish       *time.Time     `json:"estimated_finish,omitempty"`
	LastEventAt           *time.Time     `json:"last_event_at,omitempty"`
	Warnings              []string       `json:"warnings"`
	CancellationGuarantee string         `json:"cancellation_guarantee,omitempty"`
	ProviderCancellation  map[string]any `json:"provider_cancellation,omitempty"`
	QueueStoppedAt        *time.Time     `json:"queue_stopped_at,omitempty"`
	UpdatedAt             time.Time      `json:"updated_at"`
}

type CampaignInboxResponse struct {
	CampaignID       string            `json:"campaign_id"`
	Replies          []CampaignReply   `json:"replies"`
	Threads          []InboxThread     `json:"threads"`
	TotalItems       int               `json:"total_items"`
	DistinctReplyers int               `json:"distinct_replyers"`
	ReplyRate        float64           `json:"reply_rate"`
	FollowUpOpen     int               `json:"follow_up_open"`
	LastReplyAt      *time.Time        `json:"last_reply_at,omitempty"`
	CampaignSummary  map[string]any    `json:"campaign_summary"`
	ReportLinks      map[string]string `json:"report_links"`
}

type CampaignReply struct {
	ID            string    `json:"id"`
	EmailAddress  string    `json:"email_address"`
	Subject       string    `json:"subject,omitempty"`
	Snippet       string    `json:"snippet,omitempty"`
	Source        string    `json:"source"`
	ReceivedAt    time.Time `json:"received_at"`
	NeedsFollowUp bool      `json:"needs_follow_up"`
}

type InboxThread struct {
	EmailAddress string    `json:"email_address"`
	Replies      int       `json:"replies"`
	LastSubject  string    `json:"last_subject,omitempty"`
	LastSnippet  string    `json:"last_snippet,omitempty"`
	LastAt       time.Time `json:"last_at"`
}

type MultiChannelReadinessResponse struct {
	Channels        []ChannelCapability          `json:"channels"`
	Providers       map[string]ProviderReadiness `json:"providers,omitempty"`
	ProviderSetup   []ProviderSetupStep          `json:"provider_setup,omitempty"`
	OperationalMode string                       `json:"operational_mode"`
	Summary         map[string]int               `json:"summary"`
	Warnings        []string                     `json:"warnings"`
	GeneratedAt     time.Time                    `json:"generated_at"`
}

type ProviderReadiness struct {
	Provider         string     `json:"provider"`
	Status           string     `json:"status"`
	Detail           string     `json:"detail"`
	Missing          []string   `json:"missing,omitempty"`
	Docs             []string   `json:"docs,omitempty"`
	Version          string     `json:"version,omitempty"`
	CredentialSource string     `json:"credential_source,omitempty"`
	TenantScoped     bool       `json:"tenant_scoped"`
	ConnectionID     string     `json:"connection_id,omitempty"`
	AccountID        string     `json:"account_id,omitempty"`
	Scopes           []string   `json:"scopes,omitempty"`
	ConnectedAt      *time.Time `json:"connected_at,omitempty"`
	ValidatedAt      *time.Time `json:"validated_at,omitempty"`
	ExpiresAt        *time.Time `json:"expires_at,omitempty"`
}

type ProviderSetupStep struct {
	Provider    string   `json:"provider"`
	Label       string   `json:"label"`
	Status      string   `json:"status"`
	Action      string   `json:"action"`
	Docs        []string `json:"docs,omitempty"`
	Required    []string `json:"required,omitempty"`
	Description string   `json:"description"`
}

type SocialProviderConnectionInput struct {
	Provider       string            `json:"provider"`
	AccountID      string            `json:"account_id"`
	Status         string            `json:"status"`
	Scopes         []string          `json:"scopes"`
	Credentials    map[string]string `json:"credentials"`
	Metadata       map[string]any    `json:"metadata"`
	TokenExpiresAt *time.Time        `json:"token_expires_at"`
}

type SocialProviderConnection struct {
	ID              string         `json:"id"`
	Provider        string         `json:"provider"`
	AccountID       string         `json:"account_id,omitempty"`
	Status          string         `json:"status"`
	Scopes          []string       `json:"scopes,omitempty"`
	Metadata        map[string]any `json:"metadata"`
	TokenExpiresAt  *time.Time     `json:"token_expires_at,omitempty"`
	LastValidatedAt *time.Time     `json:"last_validated_at,omitempty"`
	CreatedAt       time.Time      `json:"created_at"`
	UpdatedAt       time.Time      `json:"updated_at"`
}

type SocialProviderConnectionsResponse struct {
	Connections []SocialProviderConnection `json:"connections"`
	TotalItems  int                        `json:"total_items"`
	GeneratedAt time.Time                  `json:"generated_at"`
}

type ChannelCapability struct {
	Feature string   `json:"feature"`
	Status  string   `json:"status"`
	Detail  string   `json:"detail"`
	Actions []string `json:"actions,omitempty"`
}

type SocialPostsResponse struct {
	Posts      []SocialPost `json:"posts"`
	TotalItems int          `json:"total_items"`
}

type SocialPostInput struct {
	CampaignID         string     `json:"campaign_id"`
	Network            string     `json:"network"`
	AccountID          string     `json:"account_id"`
	Text               string     `json:"text"`
	LinkURL            string     `json:"link_url,omitempty"`
	MediaURLs          []string   `json:"media_urls"`
	ScheduledAt        *time.Time `json:"scheduled_at"`
	AutoPostWithEmail  bool       `json:"auto_post_with_email"`
	PublishNow         bool       `json:"publish_now"`
	ProviderCredential string     `json:"provider_credential,omitempty"`
	CredentialID       string     `json:"credential_id,omitempty"`
}

type SocialPost struct {
	ID                string         `json:"id"`
	CampaignID        string         `json:"campaign_id,omitempty"`
	CampaignName      string         `json:"campaign_name,omitempty"`
	Network           string         `json:"network"`
	AccountID         string         `json:"account_id,omitempty"`
	Text              string         `json:"text"`
	LinkURL           string         `json:"link_url,omitempty"`
	MediaURLs         []string       `json:"media_urls"`
	Status            string         `json:"status"`
	ScheduledAt       *time.Time     `json:"scheduled_at,omitempty"`
	PublishedAt       *time.Time     `json:"published_at,omitempty"`
	AutoPostWithEmail bool           `json:"auto_post_with_email"`
	ProviderStatus    string         `json:"provider_status"`
	ProviderMessage   string         `json:"provider_message"`
	ProviderID        string         `json:"provider_id,omitempty"`
	CredentialID      string         `json:"credential_id,omitempty"`
	CredentialMode    string         `json:"credential_mode,omitempty"`
	Report            map[string]int `json:"report"`
	CreatedAt         time.Time      `json:"created_at"`
	UpdatedAt         time.Time      `json:"updated_at"`
}

type SocialPostReport struct {
	PostID         string         `json:"post_id"`
	ProviderStatus string         `json:"provider_status"`
	Network        string         `json:"network,omitempty"`
	Interactions   map[string]int `json:"interactions"`
	ROI            map[string]any `json:"roi"`
	GeneratedAt    time.Time      `json:"generated_at"`
}

type AdCampaignsResponse struct {
	Ads        []AdCampaign `json:"ads"`
	TotalItems int          `json:"total_items"`
}

type AdCampaignInput struct {
	CampaignID   string         `json:"campaign_id"`
	Channel      string         `json:"channel"`
	Name         string         `json:"name"`
	BudgetCents  int            `json:"budget_cents"`
	Currency     string         `json:"currency"`
	Audience     map[string]any `json:"audience"`
	Creative     map[string]any `json:"creative"`
	StartAt      *time.Time     `json:"start_at"`
	EndAt        *time.Time     `json:"end_at"`
	PublishNow   bool           `json:"publish_now"`
	CredentialID string         `json:"credential_id,omitempty"`
}

type AdCampaign struct {
	ID              string         `json:"id"`
	CampaignID      string         `json:"campaign_id,omitempty"`
	CampaignName    string         `json:"campaign_name,omitempty"`
	Channel         string         `json:"channel"`
	Name            string         `json:"name"`
	Status          string         `json:"status"`
	ProviderStatus  string         `json:"provider_status"`
	ProviderMessage string         `json:"provider_message,omitempty"`
	ProviderID      string         `json:"provider_id,omitempty"`
	CredentialID    string         `json:"credential_id,omitempty"`
	CredentialMode  string         `json:"credential_mode,omitempty"`
	BudgetCents     int            `json:"budget_cents"`
	Currency        string         `json:"currency"`
	Audience        map[string]any `json:"audience"`
	Creative        map[string]any `json:"creative"`
	StartAt         *time.Time     `json:"start_at,omitempty"`
	EndAt           *time.Time     `json:"end_at,omitempty"`
	Report          map[string]int `json:"report"`
	CreatedAt       time.Time      `json:"created_at"`
	UpdatedAt       time.Time      `json:"updated_at"`
}

type AdCampaignReport struct {
	AdID           string         `json:"ad_id"`
	Channel        string         `json:"channel,omitempty"`
	ProviderStatus string         `json:"provider_status"`
	Metrics        map[string]int `json:"metrics"`
	ROI            map[string]any `json:"roi"`
	GeneratedAt    time.Time      `json:"generated_at"`
}

type DirectMailStatusResponse struct {
	Status            string              `json:"status"`
	Detail            string              `json:"detail"`
	OptOutModel       ChannelCapability   `json:"opt_out_model"`
	SuppressionStatus map[string]any      `json:"suppression_status"`
	ManualWorkflow    []ProviderSetupStep `json:"manual_workflow"`
	ProviderSlots     []string            `json:"provider_slots"`
	NextActions       []string            `json:"next_actions"`
	GeneratedAt       time.Time           `json:"generated_at"`
}

type SurveysResponse struct {
	Surveys    []Survey `json:"surveys"`
	TotalItems int      `json:"total_items"`
}

type SurveyInput struct {
	Name          string           `json:"name"`
	Status        string           `json:"status"`
	Questions     []SurveyQuestion `json:"questions"`
	Blocks        []map[string]any `json:"blocks"`
	Notifications map[string]any   `json:"notifications"`
	Design        map[string]any   `json:"design"`
	TagRules      []map[string]any `json:"tag_rules"`
}

type Survey struct {
	ID                   string            `json:"id"`
	Name                 string            `json:"name"`
	Status               string            `json:"status"`
	PublicURL            string            `json:"public_url"`
	Questions            []SurveyQuestion  `json:"questions"`
	Blocks               []map[string]any  `json:"blocks"`
	Notifications        map[string]any    `json:"notifications"`
	Design               map[string]any    `json:"design"`
	Builder              SurveyBuilder     `json:"builder"`
	Exports              map[string]string `json:"exports"`
	NotificationChannels []string          `json:"notification_channels"`
	DesignControls       []string          `json:"design_controls"`
	TagRules             []map[string]any  `json:"tag_rules"`
	Metrics              map[string]any    `json:"metrics"`
	CreatedAt            time.Time         `json:"created_at"`
	UpdatedAt            time.Time         `json:"updated_at"`
}

type SurveyBuilder struct {
	Mode               string   `json:"mode"`
	QuestionTypes      []string `json:"question_types"`
	DesignControls     []string `json:"design_controls"`
	NotificationEvents []string `json:"notification_events"`
	ExportFormats      []string `json:"export_formats"`
	Hosted             bool     `json:"hosted"`
}

type SurveyQuestion struct {
	ID       string   `json:"id"`
	Type     string   `json:"type"`
	Label    string   `json:"label"`
	Required bool     `json:"required"`
	Choices  []string `json:"choices,omitempty"`
}

type SurveyResponseInput struct {
	Email   string         `json:"email"`
	Answers map[string]any `json:"answers"`
	Source  string         `json:"source"`
}

type SurveyResponseReceipt struct {
	ID         string    `json:"id"`
	SurveyID   string    `json:"survey_id"`
	Email      string    `json:"email,omitempty"`
	RecordedAt time.Time `json:"recorded_at"`
}

type SurveyReport struct {
	SurveyID       string                 `json:"survey_id"`
	TotalResponses int                    `json:"total_responses"`
	Questions      []SurveyQuestionReport `json:"questions"`
	Exports        map[string]string      `json:"exports"`
	ResponseRows   []SurveyResponseRow    `json:"response_rows,omitempty"`
	Notifications  map[string]any         `json:"notifications,omitempty"`
	GeneratedAt    time.Time              `json:"generated_at"`
}

type SurveyQuestionReport struct {
	QuestionID string         `json:"question_id"`
	Label      string         `json:"label"`
	Type       string         `json:"type"`
	Responses  int            `json:"responses"`
	Choices    map[string]int `json:"choices,omitempty"`
	Chart      map[string]any `json:"chart,omitempty"`
}

type SurveyResponseRow struct {
	Email      string         `json:"email,omitempty"`
	Answers    map[string]any `json:"answers"`
	Source     string         `json:"source"`
	RecordedAt time.Time      `json:"recorded_at"`
}

type PollMergeTagInput struct {
	SurveyID   string   `json:"survey_id"`
	QuestionID string   `json:"question_id"`
	Choices    []string `json:"choices"`
}

type PollMergeTagResponse struct {
	SurveyID   string         `json:"survey_id"`
	QuestionID string         `json:"question_id"`
	Tags       []PollMergeTag `json:"tags"`
	Usage      []string       `json:"usage"`
}

type PollMergeTag struct {
	Choice string `json:"choice"`
	Tag    string `json:"tag"`
	URL    string `json:"url"`
}

type LandingPageParityResponse struct {
	Status       string              `json:"status"`
	Capabilities []ChannelCapability `json:"capabilities"`
	Builder      map[string]any      `json:"builder"`
	ImportParity map[string]string   `json:"import_parity"`
	ReportLinks  map[string]string   `json:"report_links"`
	Counts       map[string]int      `json:"counts"`
	GeneratedAt  time.Time           `json:"generated_at"`
}

type WebsiteBuilderStatusResponse struct {
	Status       string              `json:"status"`
	Detail       string              `json:"detail"`
	Fallback     string              `json:"fallback"`
	Capabilities []ChannelCapability `json:"capabilities"`
	GeneratedAt  time.Time           `json:"generated_at"`
}

type InterestCategoriesResponse struct {
	Categories []InterestCategory `json:"categories"`
	ListID     string             `json:"list_id"`
	TotalItems int                `json:"total_items"`
}

type InterestCategory struct {
	ID            string    `json:"id"`
	Title         string    `json:"title"`
	Type          string    `json:"type"`
	SourceID      string    `json:"source_id,omitempty"`
	CanonicalKey  string    `json:"canonical_key"`
	DisplayOrder  int       `json:"display_order"`
	InterestCount int       `json:"interest_count"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type InterestsResponse struct {
	Interests  []Interest `json:"interests"`
	CategoryID string     `json:"category_id"`
	ListID     string     `json:"list_id"`
	TotalItems int        `json:"total_items"`
}

type Interest struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	Category        string    `json:"category"`
	Type            string    `json:"type"`
	CanonicalKey    string    `json:"canonical_key"`
	DisplayOrder    int       `json:"display_order"`
	SubscriberCount int       `json:"subscriber_count"`
	SourceID        string    `json:"source_id,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type ContactRatingResponse struct {
	EmailAddress   string         `json:"email_address"`
	Rating         int            `json:"rating"`
	Score          float64        `json:"score"`
	MailchimpScale string         `json:"mailchimp_scale"`
	OpenRate       float64        `json:"open_rate"`
	ClickRate      float64        `json:"click_rate"`
	Evidence       map[string]int `json:"evidence"`
	LastActivity   *time.Time     `json:"last_activity,omitempty"`
	Method         string         `json:"method"`
	MethodVersion  string         `json:"method_version"`
	ParityNote     string         `json:"parity_note"`
}

type ContactProfile struct {
	Member                Member                  `json:"member"`
	Rating                ContactRatingResponse   `json:"rating"`
	Groups                []InterestMembership    `json:"groups"`
	Timeline              []ContactTimelineItem   `json:"timeline"`
	Ecommerce             ContactEcommerceSummary `json:"ecommerce"`
	PredictedDemographics DemographicPrediction   `json:"predicted_demographics"`
	PredictiveCLV         PredictiveCLV           `json:"predictive_clv"`
	GDPRPreferences       []map[string]any        `json:"gdpr_preferences"`
	AppData               map[string]any          `json:"app_data"`
	ConsentSummary        map[string]any          `json:"consent_summary"`
	Notes                 []map[string]any        `json:"notes"`
	UnifiedSections       []ProfileSection        `json:"unified_sections"`
	DataSources           []string                `json:"data_sources"`
	GeneratedAt           time.Time               `json:"generated_at"`
}

type ProfileSection struct {
	Key    string         `json:"key"`
	Label  string         `json:"label"`
	Status string         `json:"status"`
	Counts map[string]int `json:"counts,omitempty"`
}

type InterestMembership struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Category     string `json:"category"`
	SourceID     string `json:"source_id,omitempty"`
	CanonicalKey string `json:"canonical_key"`
	Active       bool   `json:"active"`
}

type ContactTimelineItem struct {
	Type       string         `json:"type"`
	CampaignID string         `json:"campaign_id,omitempty"`
	Metadata   map[string]any `json:"metadata"`
	At         time.Time      `json:"at"`
}

type ContactEcommerceSummary struct {
	OrderCount        int        `json:"order_count"`
	TotalSpentCents   int        `json:"total_spent_cents"`
	AverageOrderCents int        `json:"average_order_cents"`
	Currency          string     `json:"currency"`
	LastOrderAt       *time.Time `json:"last_order_at,omitempty"`
}

type DemographicPrediction struct {
	Status     string         `json:"status"`
	Confidence string         `json:"confidence"`
	Policy     string         `json:"policy"`
	Country    string         `json:"country,omitempty"`
	Region     string         `json:"region,omitempty"`
	City       string         `json:"city,omitempty"`
	Device     string         `json:"device,omitempty"`
	Client     string         `json:"client,omitempty"`
	Traits     map[string]any `json:"traits"`
	Evidence   map[string]int `json:"evidence"`
}

type PredictiveCLV struct {
	Status                      string         `json:"status"`
	EstimatedLifetimeValueCents int            `json:"estimated_lifetime_value_cents"`
	PurchaseAgainLikelihood     float64        `json:"purchase_again_likelihood"`
	Confidence                  string         `json:"confidence"`
	Method                      string         `json:"method"`
	ModelQuality                string         `json:"model_quality"`
	Inputs                      map[string]int `json:"inputs"`
}

type AudienceInsightsResponse struct {
	ListID                string           `json:"list_id"`
	ContactRatings        map[int]int      `json:"contact_ratings"`
	StatusCounts          map[string]int   `json:"status_counts"`
	PredictedDemographics map[string]int   `json:"predicted_demographics"`
	PredictiveCLV         map[string]any   `json:"predictive_clv"`
	PrebuiltSegments      []map[string]any `json:"prebuilt_segments"`
	SegmentDimensions     []string         `json:"segment_dimensions"`
	ModelNotes            []string         `json:"model_notes"`
	SegmentCoverage       map[string]any   `json:"segment_coverage"`
	GeneratedAt           time.Time        `json:"generated_at"`
}

type AdvancedSegmentSchemaResponse struct {
	ListID           string             `json:"list_id"`
	Dimensions       []SegmentDimension `json:"dimensions"`
	Operators        []string           `json:"operators"`
	PrebuiltSegments []map[string]any   `json:"prebuilt_segments"`
	Examples         []map[string]any   `json:"examples"`
	Evaluator        map[string]any     `json:"evaluator"`
	Coverage         map[string]string  `json:"coverage"`
	Unsupported      []string           `json:"unsupported"`
	Limits           map[string]any     `json:"limits"`
	GeneratedAt      time.Time          `json:"generated_at"`
}

type SegmentDimension struct {
	Key         string   `json:"key"`
	Label       string   `json:"label"`
	Type        string   `json:"type"`
	Operators   []string `json:"operators"`
	Description string   `json:"description"`
}

type TemplatesResponse struct {
	Templates  []Template `json:"templates"`
	TotalItems int        `json:"total_items"`
}

type Template struct {
	ID          string           `json:"id"`
	Type        string           `json:"type"`
	Name        string           `json:"name"`
	DragAndDrop bool             `json:"drag_and_drop"`
	Responsive  bool             `json:"responsive"`
	Category    string           `json:"category"`
	DateCreated time.Time        `json:"date_created"`
	CreatedBy   string           `json:"created_by"`
	Active      bool             `json:"active"`
	HTML        string           `json:"html,omitempty"`
	Sections    []map[string]any `json:"sections,omitempty"`
}

type AutomationsResponse struct {
	Automations []Automation `json:"automations"`
	TotalItems  int          `json:"total_items"`
}

type Automation struct {
	ID         string           `json:"id"`
	CreateTime time.Time        `json:"create_time"`
	StartTime  *time.Time       `json:"start_time,omitempty"`
	Status     string           `json:"status"`
	EmailsSent int              `json:"emails_sent"`
	Recipients map[string]any   `json:"recipients"`
	Settings   map[string]any   `json:"settings"`
	Tracking   map[string]any   `json:"tracking"`
	Triggers   []map[string]any `json:"triggers"`
}

type EcommerceStoresResponse struct {
	Stores     []EcommerceStore `json:"stores"`
	TotalItems int              `json:"total_items"`
}

type EcommerceStore struct {
	ID            string         `json:"id"`
	ListID        string         `json:"list_id"`
	Name          string         `json:"name"`
	Platform      string         `json:"platform"`
	Domain        string         `json:"domain"`
	IsSyncing     bool           `json:"is_syncing"`
	EmailAddress  string         `json:"email_address,omitempty"`
	CurrencyCode  string         `json:"currency_code"`
	MoneyFormat   string         `json:"money_format"`
	PrimaryLocale string         `json:"primary_locale"`
	Timezone      string         `json:"timezone"`
	CreatedAt     time.Time      `json:"created_at"`
	UpdatedAt     time.Time      `json:"updated_at"`
	Stats         map[string]any `json:"stats"`
}

type LandingPagesResponse struct {
	LandingPages []LandingPage `json:"landing_pages"`
	TotalItems   int           `json:"total_items"`
}

type LandingPage struct {
	ID          string           `json:"id"`
	WebID       int              `json:"web_id"`
	Name        string           `json:"name"`
	Title       string           `json:"title"`
	URL         string           `json:"url"`
	Status      string           `json:"status"`
	ListID      string           `json:"list_id"`
	TemplateID  int              `json:"template_id"`
	Tracking    map[string]any   `json:"tracking"`
	Settings    map[string]any   `json:"settings"`
	Content     []map[string]any `json:"content,omitempty"`
	DateCreated time.Time        `json:"date_created"`
	CreatedBy   string           `json:"created_by"`
	UpdatedAt   time.Time        `json:"updated_at"`
}

type LandingPageContent struct {
	Sections []map[string]any `json:"sections"`
	HTML     string           `json:"html,omitempty"`
}

type LandingPageInput struct {
	Name     string           `json:"name"`
	Title    string           `json:"title"`
	Slug     string           `json:"slug"`
	Status   string           `json:"status"`
	Domain   string           `json:"domain"`
	Template string           `json:"template"`
	Content  []map[string]any `json:"content"`
	Tracking map[string]any   `json:"tracking"`
	SEO      map[string]any   `json:"seo"`
}

type FileManagerFilesResponse struct {
	Files      []FileManagerFile `json:"files"`
	TotalItems int               `json:"total_items"`
}

type FileManagerFile struct {
	ID           string         `json:"id"`
	FolderID     string         `json:"folder_id"`
	Type         string         `json:"type"`
	Name         string         `json:"name"`
	AltText      string         `json:"alt_text,omitempty"`
	FullSizeURL  string         `json:"full_size_url"`
	ThumbnailURL string         `json:"thumbnail_url"`
	Size         int            `json:"size"`
	Tags         []string       `json:"tags,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	CreatedAt    time.Time      `json:"created_at"`
	UpdatedAt    time.Time      `json:"updated_at"`
}

type FileManagerFileInput struct {
	Name         string         `json:"name"`
	FileData     string         `json:"file_data"`
	FullSizeURL  string         `json:"full_size_url"`
	URL          string         `json:"url"`
	FolderID     string         `json:"folder_id"`
	Type         string         `json:"type"`
	AltText      string         `json:"alt_text"`
	ThumbnailURL string         `json:"thumbnail_url"`
	Size         int            `json:"size"`
	Tags         []string       `json:"tags"`
	Metadata     map[string]any `json:"metadata"`
}

type FileManagerFileUpdate struct {
	Name         string         `json:"name"`
	FolderID     string         `json:"folder_id"`
	Type         string         `json:"type"`
	AltText      string         `json:"alt_text"`
	FullSizeURL  string         `json:"full_size_url"`
	URL          string         `json:"url"`
	ThumbnailURL string         `json:"thumbnail_url"`
	Size         int            `json:"size"`
	Tags         []string       `json:"tags"`
	Metadata     map[string]any `json:"metadata"`
}

type FileManagerFoldersResponse struct {
	Folders    []FileManagerFolder `json:"folders"`
	TotalItems int                 `json:"total_items"`
}

type FileManagerFolder struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	FileCount int       `json:"file_count"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type FileManagerFolderInput struct {
	Name string `json:"name"`
}

type FileManagerFileUsageResponse struct {
	FileID      string               `json:"file_id"`
	URL         string               `json:"url"`
	TotalUses   int                  `json:"total_uses"`
	Usage       []ContentStudioUsage `json:"usage"`
	GeneratedAt time.Time            `json:"generated_at"`
}

type ContentStudioUsage struct {
	Kind      string    `json:"kind"`
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Status    string    `json:"status,omitempty"`
	UpdatedAt time.Time `json:"updated_at,omitempty"`
}

type ContentStudioResponse struct {
	Status       string              `json:"status"`
	Files        []FileManagerFile   `json:"files"`
	Folders      []FileManagerFolder `json:"folders"`
	Summary      map[string]int      `json:"summary"`
	Capabilities []ChannelCapability `json:"capabilities"`
	Lifecycle    map[string]any      `json:"lifecycle,omitempty"`
	Policies     map[string]any      `json:"policies,omitempty"`
	Parity       map[string]string   `json:"parity,omitempty"`
	Limitations  []string            `json:"limitations,omitempty"`
	GeneratedAt  time.Time           `json:"generated_at"`
}

type CreativeAssistantInput struct {
	Goal       string         `json:"goal"`
	Channel    string         `json:"channel"`
	Audience   string         `json:"audience"`
	Tone       string         `json:"tone"`
	Offer      string         `json:"offer"`
	BrandVoice string         `json:"brand_voice"`
	Context    map[string]any `json:"context"`
}

type CreativeAssistantResponse struct {
	ID                  string                       `json:"id"`
	Goal                string                       `json:"goal"`
	Channel             string                       `json:"channel"`
	ProviderMode        string                       `json:"provider_mode"`
	ProviderStatus      string                       `json:"provider_status"`
	SubjectLines        []string                     `json:"subject_lines,omitempty"`
	PreviewTexts        []string                     `json:"preview_texts,omitempty"`
	Headlines           []string                     `json:"headlines,omitempty"`
	BodyDrafts          []string                     `json:"body_drafts,omitempty"`
	SMSDrafts           []string                     `json:"sms_drafts,omitempty"`
	AutomationTemplates []CreativeAutomationTemplate `json:"automation_templates,omitempty"`
	Checklist           []string                     `json:"checklist"`
	Capabilities        []ChannelCapability          `json:"capabilities,omitempty"`
	Limits              map[string]any               `json:"limits,omitempty"`
	Warnings            []string                     `json:"warnings,omitempty"`
	GeneratedAt         time.Time                    `json:"generated_at"`
}

type CreativeAutomationTemplate struct {
	Name    string              `json:"name"`
	Goal    string              `json:"goal"`
	Steps   []map[string]string `json:"steps"`
	Channel string              `json:"channel"`
}

type InlineAIInput struct {
	Channel string         `json:"channel"`
	Mode    string         `json:"mode"`
	Text    string         `json:"text"`
	Tone    string         `json:"tone"`
	Prompt  string         `json:"prompt"`
	Context map[string]any `json:"context"`
}

type InlineAIResponse struct {
	Mode           string              `json:"mode"`
	Channel        string              `json:"channel"`
	ProviderMode   string              `json:"provider_mode"`
	ProviderStatus string              `json:"provider_status"`
	Text           string              `json:"text"`
	Variants       []string            `json:"variants"`
	Actions        []string            `json:"actions,omitempty"`
	Metadata       map[string]any      `json:"metadata"`
	Capabilities   []ChannelCapability `json:"capabilities,omitempty"`
	Warnings       []string            `json:"warnings,omitempty"`
	GeneratedAt    time.Time           `json:"generated_at"`
}

type VideoConvertInput struct {
	URL          string `json:"url"`
	Title        string `json:"title"`
	ThumbnailURL string `json:"thumbnail_url"`
	AltText      string `json:"alt_text"`
	CTA          string `json:"cta"`
}

type VideoConvertResponse struct {
	Provider         string            `json:"provider"`
	VideoID          string            `json:"video_id"`
	URL              string            `json:"url"`
	ThumbnailURL     string            `json:"thumbnail_url"`
	MergeTag         string            `json:"merge_tag"`
	EmailHTML        string            `json:"email_html"`
	PlainText        string            `json:"plain_text"`
	Pipeline         string            `json:"pipeline"`
	TranscodeStatus  string            `json:"transcode_status"`
	UploadSupported  bool              `json:"upload_supported"`
	SupportedSources []string          `json:"supported_sources,omitempty"`
	AssetLifecycle   map[string]string `json:"asset_lifecycle,omitempty"`
	Warnings         []string          `json:"warnings,omitempty"`
}

type MailchimpBlockCatalogResponse struct {
	Blocks           []MailchimpBlockDefinition `json:"blocks"`
	TotalItems       int                        `json:"total_items"`
	EditorContract   map[string]string          `json:"editor_contract,omitempty"`
	SendTimeContract map[string]string          `json:"send_time_contract,omitempty"`
	Coverage         map[string]string          `json:"coverage,omitempty"`
	Limitations      []string                   `json:"limitations,omitempty"`
	GeneratedAt      time.Time                  `json:"generated_at"`
}

type MailchimpBlockDefinition struct {
	ID               string         `json:"id"`
	Name             string         `json:"name"`
	Category         string         `json:"category"`
	Description      string         `json:"description"`
	Fields           []string       `json:"fields"`
	DefaultData      map[string]any `json:"default_data"`
	MailchimpKey     string         `json:"mailchimp_key"`
	EditorParity     string         `json:"editor_parity,omitempty"`
	RenderPhase      string         `json:"render_phase,omitempty"`
	SendTimeBehavior string         `json:"send_time_behavior,omitempty"`
	Limitations      []string       `json:"limitations,omitempty"`
}

type TemplateLanguagePreviewInput struct {
	HTML      string         `json:"html"`
	Text      string         `json:"text"`
	Variables map[string]any `json:"variables"`
}

type TemplateLanguagePreviewResponse struct {
	HTML                  string   `json:"html,omitempty"`
	Text                  string   `json:"text,omitempty"`
	FoundTags             []string `json:"found_tags"`
	UnsupportedTags       []string `json:"unsupported_tags"`
	Warnings              []string `json:"warnings"`
	RequiredFooterPresent bool     `json:"required_footer_present"`
	Parser                string   `json:"parser"`
	SupportedSyntax       []string `json:"supported_syntax,omitempty"`
	UnsupportedSyntax     []string `json:"unsupported_syntax,omitempty"`
}

type EcommerceProductsResponse struct {
	Products   []EcommerceProduct `json:"products"`
	StoreID    string             `json:"store_id"`
	TotalItems int                `json:"total_items"`
}

type EcommerceProduct struct {
	ID          string             `json:"id"`
	Title       string             `json:"title"`
	Handle      string             `json:"handle,omitempty"`
	URL         string             `json:"url,omitempty"`
	ImageURL    string             `json:"image_url,omitempty"`
	Description string             `json:"description,omitempty"`
	Type        string             `json:"type,omitempty"`
	Vendor      string             `json:"vendor,omitempty"`
	Variants    []EcommerceVariant `json:"variants"`
	CreatedAt   time.Time          `json:"created_at"`
	UpdatedAt   time.Time          `json:"updated_at"`
}

type EcommerceVariant struct {
	ID           string    `json:"id"`
	Title        string    `json:"title"`
	URL          string    `json:"url,omitempty"`
	SKU          string    `json:"sku,omitempty"`
	Price        float64   `json:"price"`
	InventoryQty int       `json:"inventory_quantity"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type EcommerceProductInput struct {
	ID          string             `json:"id"`
	Title       string             `json:"title"`
	Handle      string             `json:"handle"`
	URL         string             `json:"url"`
	ImageURL    string             `json:"image_url"`
	Description string             `json:"description"`
	Type        string             `json:"type"`
	Vendor      string             `json:"vendor"`
	Variants    []EcommerceVariant `json:"variants"`
}

type EcommerceOrdersResponse struct {
	Orders     []EcommerceOrder `json:"orders"`
	StoreID    string           `json:"store_id"`
	TotalItems int              `json:"total_items"`
}

type EcommerceOrder struct {
	ID              string           `json:"id"`
	Customer        map[string]any   `json:"customer,omitempty"`
	CampaignID      string           `json:"campaign_id,omitempty"`
	LandingSite     string           `json:"landing_site,omitempty"`
	FinancialStatus string           `json:"financial_status"`
	CurrencyCode    string           `json:"currency_code"`
	OrderTotal      float64          `json:"order_total"`
	TaxTotal        float64          `json:"tax_total"`
	ShippingTotal   float64          `json:"shipping_total"`
	DiscountTotal   float64          `json:"discount_total"`
	Lines           []map[string]any `json:"lines"`
	ProcessedAt     time.Time        `json:"processed_at"`
	CreatedAt       time.Time        `json:"created_at"`
	UpdatedAt       time.Time        `json:"updated_at"`
}

type EcommerceOrderInput struct {
	ID              string           `json:"id"`
	Customer        map[string]any   `json:"customer"`
	CustomerEmail   string           `json:"customer_email"`
	CampaignID      string           `json:"campaign_id"`
	FinancialStatus string           `json:"financial_status"`
	CurrencyCode    string           `json:"currency_code"`
	OrderTotal      float64          `json:"order_total"`
	TaxTotal        float64          `json:"tax_total"`
	ShippingTotal   float64          `json:"shipping_total"`
	DiscountTotal   float64          `json:"discount_total"`
	Lines           []map[string]any `json:"lines"`
	ProcessedAt     *time.Time       `json:"processed_at"`
}

type EcommerceCartsResponse struct {
	Carts      []EcommerceCart `json:"carts"`
	StoreID    string          `json:"store_id"`
	TotalItems int             `json:"total_items"`
}

type EcommerceCart struct {
	ID           string           `json:"id"`
	Customer     map[string]any   `json:"customer,omitempty"`
	CheckoutURL  string           `json:"checkout_url,omitempty"`
	CurrencyCode string           `json:"currency_code"`
	OrderTotal   float64          `json:"order_total"`
	Lines        []map[string]any `json:"lines"`
	CreatedAt    time.Time        `json:"created_at"`
	UpdatedAt    time.Time        `json:"updated_at"`
}

type EcommerceCartInput struct {
	ID            string           `json:"id"`
	Customer      map[string]any   `json:"customer"`
	CustomerEmail string           `json:"customer_email"`
	CheckoutURL   string           `json:"checkout_url"`
	CurrencyCode  string           `json:"currency_code"`
	OrderTotal    float64          `json:"order_total"`
	Lines         []map[string]any `json:"lines"`
}

type EcommercePromoRulesResponse struct {
	PromoRules []EcommercePromoRule `json:"promo_rules"`
	StoreID    string               `json:"store_id"`
	TotalItems int                  `json:"total_items"`
}

type EcommercePromoRule struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Description string     `json:"description,omitempty"`
	Amount      float64    `json:"amount,omitempty"`
	Type        string     `json:"type"`
	Target      string     `json:"target"`
	Enabled     bool       `json:"enabled"`
	StartsAt    *time.Time `json:"starts_at,omitempty"`
	EndsAt      *time.Time `json:"ends_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

type EcommercePromoRuleInput struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Description string     `json:"description"`
	Amount      float64    `json:"amount"`
	Type        string     `json:"type"`
	Target      string     `json:"target"`
	Enabled     bool       `json:"enabled"`
	StartsAt    *time.Time `json:"starts_at"`
	EndsAt      *time.Time `json:"ends_at"`
}

type BatchRequest struct {
	Operations  []BatchOperation `json:"operations"`
	CallbackURL string           `json:"callback_url,omitempty"`
}

type BatchOperation struct {
	Method      string         `json:"method"`
	Path        string         `json:"path"`
	OperationID string         `json:"operation_id,omitempty"`
	Params      map[string]any `json:"params,omitempty"`
	Body        any            `json:"body,omitempty"`
}

type BatchOperationResult struct {
	OperationID string         `json:"operation_id,omitempty"`
	Method      string         `json:"method"`
	Path        string         `json:"path"`
	StatusCode  int            `json:"status_code"`
	Response    map[string]any `json:"response,omitempty"`
	Error       string         `json:"error,omitempty"`
}

type BatchResponse struct {
	ID                 string                 `json:"id"`
	Status             string                 `json:"status"`
	ExecutionMode      string                 `json:"execution_mode,omitempty"`
	Durability         string                 `json:"durability,omitempty"`
	TotalOperations    int                    `json:"total_operations"`
	FinishedOperations int                    `json:"finished_operations"`
	ErroredOperations  int                    `json:"errored_operations"`
	SubmittedAt        time.Time              `json:"submitted_at"`
	CompletedAt        time.Time              `json:"completed_at,omitempty"`
	ResponseBodyURL    string                 `json:"response_body_url,omitempty"`
	CallbackURL        string                 `json:"callback_url,omitempty"`
	WebhookStatus      string                 `json:"webhook_status,omitempty"`
	Limits             map[string]any         `json:"limits,omitempty"`
	Operations         []BatchOperationResult `json:"operations,omitempty"`
}

type BatchesResponse struct {
	Batches    []BatchResponse `json:"batches"`
	TotalItems int             `json:"total_items"`
}

type AccountExportsResponse struct {
	Exports    []AccountExport `json:"exports"`
	TotalItems int             `json:"total_items"`
}

type AccountExport struct {
	ID            string            `json:"id"`
	Status        string            `json:"status"`
	StartedAt     time.Time         `json:"started_at"`
	FinishedAt    *time.Time        `json:"finished_at,omitempty"`
	DownloadURL   string            `json:"download_url,omitempty"`
	Sections      []string          `json:"sections,omitempty"`
	Counts        map[string]int    `json:"counts,omitempty"`
	Manifest      map[string]any    `json:"manifest,omitempty"`
	Completeness  map[string]string `json:"completeness,omitempty"`
	RetentionDays int               `json:"retention_days,omitempty"`
	Warnings      []string          `json:"warnings,omitempty"`
}

type BatchWebhooksResponse struct {
	Webhooks   []BatchWebhook `json:"webhooks"`
	TotalItems int            `json:"total_items"`
}

type BatchWebhook struct {
	ID        string    `json:"id"`
	URL       string    `json:"url"`
	Events    []string  `json:"events"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type BatchWebhookInput struct {
	URL     string   `json:"url"`
	Events  []string `json:"events"`
	Enabled *bool    `json:"enabled,omitempty"`
}

type ConnectedSitesResponse struct {
	Sites      []ConnectedSite `json:"sites"`
	TotalItems int             `json:"total_items"`
}

type ConnectedSite struct {
	ID                string         `json:"id"`
	ForeignID         string         `json:"foreign_id,omitempty"`
	Domain            string         `json:"domain"`
	URL               string         `json:"url"`
	Name              string         `json:"name"`
	Platform          string         `json:"platform"`
	ListID            string         `json:"list_id,omitempty"`
	Status            string         `json:"status"`
	ScriptInstalled   bool           `json:"script_installed"`
	SyncStatus        string         `json:"sync_status"`
	ScriptStatus      string         `json:"script_status,omitempty"`
	TrackingContract  map[string]any `json:"tracking_contract,omitempty"`
	VerificationSteps []string       `json:"verification_steps,omitempty"`
	Metadata          map[string]any `json:"metadata,omitempty"`
	CreatedAt         time.Time      `json:"created_at"`
	UpdatedAt         time.Time      `json:"updated_at"`
}

type ConnectedSiteInput struct {
	ForeignID       string         `json:"foreign_id"`
	Domain          string         `json:"domain"`
	URL             string         `json:"url"`
	Name            string         `json:"name"`
	Platform        string         `json:"platform"`
	ListID          string         `json:"list_id"`
	ScriptInstalled bool           `json:"script_installed"`
	SyncStatus      string         `json:"sync_status"`
	Metadata        map[string]any `json:"metadata"`
}

type VerifiedDomainsResponse struct {
	Domains    []VerifiedDomain `json:"domains"`
	TotalItems int              `json:"total_items"`
}

type VerifiedDomain struct {
	ID                   string         `json:"id"`
	Domain               string         `json:"domain"`
	Status               string         `json:"status"`
	Verified             bool           `json:"verified"`
	DNSRecords           []DNSRecord    `json:"dns_records"`
	Purpose              string         `json:"purpose"`
	VerificationContract map[string]any `json:"verification_contract,omitempty"`
	Metadata             map[string]any `json:"metadata,omitempty"`
	CreatedAt            time.Time      `json:"created_at"`
	VerifiedAt           *time.Time     `json:"verified_at,omitempty"`
}

type DNSRecord struct {
	Type  string `json:"type"`
	Name  string `json:"name"`
	Value string `json:"value"`
}

type VerifiedDomainInput struct {
	Domain   string         `json:"domain"`
	Purpose  string         `json:"purpose"`
	Metadata map[string]any `json:"metadata"`
}

type IntegrationMarketplaceResponse struct {
	Status             string                       `json:"status"`
	Items              []IntegrationMarketplaceItem `json:"items"`
	TotalItems         int                          `json:"total_items"`
	Categories         map[string]int               `json:"categories"`
	Capabilities       []ChannelCapability          `json:"capabilities"`
	NativeConnectors   []string                     `json:"native_connectors,omitempty"`
	CatalogOnly        int                          `json:"catalog_only"`
	AutomationCoverage map[string]string            `json:"automation_coverage,omitempty"`
	Caveats            []string                     `json:"caveats,omitempty"`
	GeneratedAt        time.Time                    `json:"generated_at"`
}

type IntegrationMarketplaceItem struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Category    string   `json:"category"`
	Status      string   `json:"status"`
	Provider    string   `json:"provider"`
	Description string   `json:"description"`
	Scopes      []string `json:"scopes,omitempty"`
}

type AgencyEcosystemResponse struct {
	Status              string           `json:"status"`
	Program             map[string]any   `json:"program,omitempty"`
	Resources           []AgencyResource `json:"resources"`
	PartnerPath         []string         `json:"partner_path"`
	CertificationTracks []string         `json:"certification_tracks,omitempty"`
	Caveats             []string         `json:"caveats,omitempty"`
	GeneratedAt         time.Time        `json:"generated_at"`
}

type AgencyResource struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Status      string `json:"status"`
	Description string `json:"description"`
}

type ReportEventDetailsResponse struct {
	CampaignID string              `json:"campaign_id"`
	Items      []ReportEventDetail `json:"items"`
	TotalItems int                 `json:"total_items"`
}

type ReportEventDetail struct {
	EmailAddress string    `json:"email_address,omitempty"`
	Timestamp    time.Time `json:"timestamp"`
	URL          string    `json:"url,omitempty"`
	IP           string    `json:"ip,omitempty"`
	Country      string    `json:"country,omitempty"`
	Region       string    `json:"region,omitempty"`
	City         string    `json:"city,omitempty"`
	Device       string    `json:"device,omitempty"`
	Client       string    `json:"client,omitempty"`
}
