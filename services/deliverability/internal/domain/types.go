// Package domain defines the core types shared across the deliverability
// service's five layers: seedlist, reputation, auth, content, and the AI
// Diagnostician. These types are wire-stable and form the contract between
// internal subsystems and the HTTP handlers.
package domain

import "time"

// Placement is where a seedlist inbox classified an incoming test email.
type Placement string

const (
	PlacementPrimary    Placement = "primary"
	PlacementPromotions Placement = "promotions"
	PlacementUpdates    Placement = "updates"
	PlacementSocial     Placement = "social"
	PlacementSpam       Placement = "spam"
	PlacementBlocked    Placement = "blocked"
	PlacementMissing    Placement = "missing"
)

// Provider is one of the eight mailbox providers in the seedlist.
type Provider string

const (
	ProviderGmail      Provider = "gmail"
	ProviderOutlookCom Provider = "outlook_com"
	ProviderO365       Provider = "o365"
	ProviderICloud     Provider = "icloud"
	ProviderYahoo      Provider = "yahoo"
	ProviderProton     Provider = "proton"
	ProviderGMX        Provider = "gmx"
	ProviderMailRu     Provider = "mailru"
)

// InboxReport is a single seedlist mailbox's observation of a campaign.
type InboxReport struct {
	TenantID       string    `json:"tenant_id,omitempty"`
	CampaignID     string    `json:"campaign_id"`
	Provider       Provider  `json:"provider"`
	MailboxID      string    `json:"mailbox_id"`
	RecipientEmail string    `json:"-"`
	Placement      Placement `json:"placement"`
	CheckedAt      time.Time `json:"checked_at"`
}

// ProviderBreakdown is the per-provider placement summary for a campaign.
type ProviderBreakdown struct {
	Provider   Provider          `json:"provider"`
	Total      int               `json:"total"`
	Placements map[Placement]int `json:"placements"`
}

// CampaignReport aggregates all InboxReports for a single campaign.
type CampaignReport struct {
	CampaignID   string                `json:"campaign_id"`
	CampaignName string                `json:"campaign_name,omitempty"`
	SentAt       *time.Time            `json:"sent_at,omitempty"`
	Providers    []ProviderBreakdown   `json:"providers"`
	Overall      map[Placement]float64 `json:"overall_pct"`
	TotalInboxes int                   `json:"total_inboxes"`
	GeneratedAt  time.Time             `json:"generated_at"`
	DiagnosticID string                `json:"diagnostic_id,omitempty"`
	Reports      []InboxReport         `json:"reports,omitempty"`
}

// ReputationScore is a coarse provider-side bucket (Google/Microsoft).
type ReputationScore string

const (
	ReputationLow    ReputationScore = "low"
	ReputationMedium ReputationScore = "medium"
	ReputationHigh   ReputationScore = "high"
)

// Reputation aggregates external reputation signals for a sending domain/IP.
type Reputation struct {
	Domain           string          `json:"domain"`
	IP               string          `json:"ip"`
	GoogleScore      ReputationScore `json:"google_score"`
	MicrosoftScore   ReputationScore `json:"microsoft_score"`
	SenderScore      int             `json:"sender_score"` // 0-100
	BlacklistHits    []string        `json:"blacklist_hits"`
	CheckedAt        time.Time       `json:"checked_at"`
	DataAvailable    bool            `json:"data_available"`
	SourcesSucceeded []string        `json:"sources_succeeded,omitempty"`
	SourcesFailed    []string        `json:"sources_failed,omitempty"`
}

// AuthStatus is the per-record health of an auth check.
type AuthStatus string

const (
	AuthOK   AuthStatus = "ok"
	AuthWarn AuthStatus = "warn"
	AuthFail AuthStatus = "fail"
)

// AuthRecord is a single SPF/DKIM/DMARC/BIMI/PTR check outcome.
type AuthRecord struct {
	Status AuthStatus `json:"status"`
	Detail string     `json:"detail"`
}

// AuthCheck is the bundled result of all five auth checks for one domain.
type AuthCheck struct {
	Domain string     `json:"domain"`
	SPF    AuthRecord `json:"spf"`
	DKIM   AuthRecord `json:"dkim"`
	DMARC  AuthRecord `json:"dmarc"`
	BIMI   AuthRecord `json:"bimi"`
	PTR    AuthRecord `json:"ptr"`
}

// ContentScan is the Layer 4 output for a single rendered campaign body.
type ContentScan struct {
	SpamScore      float64         `json:"spam_score"` // 0..1
	SpamReasons    []string        `json:"spam_reasons,omitempty"`
	ImageTextRatio float64         `json:"image_text_ratio"`
	LinkReputation AuthStatus      `json:"link_reputation"` // "ok"|"warn"|"fail"
	HTMLIssues     []string        `json:"html_issues,omitempty"`
	Model          ModelDisclosure `json:"model,omitempty"`
}

// ModelDisclosure tells API callers whether a score came from a trained model,
// a calibrated heuristic, or a local fallback. It is deliberately generic so
// each layer can expose model provenance without changing response envelopes.
type ModelDisclosure struct {
	Name    string   `json:"name"`
	Version string   `json:"version"`
	Kind    string   `json:"kind"` // heuristic | ml | llm | local_fallback
	Source  string   `json:"source"`
	Trained bool     `json:"trained"`
	Notes   []string `json:"notes,omitempty"`
}

// FixAction is a discriminator for how a Diagnostician fix is applied.
type FixAction string

const (
	FixActionDNSRecord  FixAction = "dns_record"
	FixActionCopyChange FixAction = "copy_change"
	FixActionImageSwap  FixAction = "image_swap"
	FixActionResend     FixAction = "resend"
)

// DNSRecord is the structured payload for a fix that involves a DNS change.
type DNSRecord struct {
	Type  string `json:"type"`  // TXT, CNAME, MX, ...
	Name  string `json:"name"`  // e.g. _dmarc.example.com
	Value string `json:"value"` // e.g. v=DMARC1; p=quarantine; rua=...
	TTL   int    `json:"ttl,omitempty"`
}

// Fix is a single ranked recommendation surfaced by the Diagnostician.
type Fix struct {
	Title           string     `json:"title"`
	Detail          string     `json:"detail"`
	Action          FixAction  `json:"action"`
	DNSRecord       *DNSRecord `json:"dns_record,omitempty"`
	EstimatedImpact float64    `json:"estimated_impact"` // 0..1 added inbox-rate
}

// Diagnosis is the AI Diagnostician's full output for one campaign.
type Diagnosis struct {
	CampaignID      string             `json:"campaign_id"`
	Diagnosis       string             `json:"diagnosis"` // markdown
	Fixes           []Fix              `json:"fixes"`
	PredictedImpact map[string]float64 `json:"predicted_impact"`
	GeneratedAt     time.Time          `json:"generated_at"`
}

// PredictedPlacement is the Pre-Send Predictor's distribution forecast.
type PredictedPlacement struct {
	Primary    float64 `json:"primary"`
	Promotions float64 `json:"promotions"`
	Spam       float64 `json:"spam"`
}
