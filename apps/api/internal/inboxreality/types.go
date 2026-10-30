// SPDX-License-Identifier: AGPL-3.0-only
package inboxreality

import (
	"encoding/json"
	"time"
)

// Placement mirrors services/deliverability/internal/domain.Placement.
// We re-declare here so apps/api doesn't have to import the
// deliverability service (cross-service Go imports are awkward in a
// go.work setup and the seedlist categorizers can evolve their
// taxonomy independently of the customer-facing API contract).
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

// AllPlacements is the canonical enumeration order. The dashboard
// renders the breakdown in this order so the worst outcomes
// (Spam/Blocked/Missing) bubble down where the eye expects bad news,
// after the actionable Primary/Promotions/Updates trio at the top.
var AllPlacements = []Placement{
	PlacementPrimary,
	PlacementPromotions,
	PlacementUpdates,
	PlacementSocial,
	PlacementSpam,
	PlacementBlocked,
	PlacementMissing,
}

// IsKnown reports whether p is one of the canonical values. Used to
// validate inbound rows from the deliverability service before we
// trust them into the DB.
func (p Placement) IsKnown() bool {
	for _, v := range AllPlacements {
		if p == v {
			return true
		}
	}
	return false
}

// Provider mirrors services/deliverability/internal/domain.Provider.
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

// AllProviders is the static list of seed-mailbox providers we
// support. The deliverability service's YAML is the source of truth
// for which mailboxes are ACTIVE, but the customer-facing list of
// providers is stable enough to keep here.
var AllProviders = []Provider{
	ProviderGmail,
	ProviderOutlookCom,
	ProviderO365,
	ProviderICloud,
	ProviderYahoo,
	ProviderProton,
	ProviderGMX,
	ProviderMailRu,
}

// DisplayName turns the provider enum into the dashboard-facing string.
// We keep this in code (not a DB lookup) because the set is closed and
// these names are part of the wire contract.
func (p Provider) DisplayName() string {
	switch p {
	case ProviderGmail:
		return "Gmail"
	case ProviderOutlookCom:
		return "Outlook.com"
	case ProviderO365:
		return "Office 365"
	case ProviderICloud:
		return "iCloud Mail"
	case ProviderYahoo:
		return "Yahoo Mail"
	case ProviderProton:
		return "Proton Mail"
	case ProviderGMX:
		return "GMX"
	case ProviderMailRu:
		return "Mail.ru"
	default:
		return string(p)
	}
}

// IsKnown gates inbound rows the same way Placement.IsKnown does.
func (p Provider) IsKnown() bool {
	for _, v := range AllProviders {
		if p == v {
			return true
		}
	}
	return false
}

// TestStatus is the lifecycle state of an on-demand test.
type TestStatus string

const (
	// StatusAwaitingDelivery — row exists, nobody has reported yet.
	// The dashboard renders a spinner with "delivering to N seeds…"
	StatusAwaitingDelivery TestStatus = "awaiting_delivery"
	// StatusClassifying — at least one result is in but not all seeds
	// have reported. The dashboard can render partial results live.
	StatusClassifying TestStatus = "classifying"
	// StatusComplete — every active seed has reported OR expires_at
	// was reached. Final status; never transitions back.
	StatusComplete TestStatus = "complete"
	// StatusExpired — expires_at was reached with zero results.
	// Distinct from Complete so the dashboard can surface the "we
	// did not receive the email at any seed" failure mode (most
	// often: the customer never actually sent to the seeds).
	StatusExpired TestStatus = "expired"
	// StatusCancelled — user-initiated stop. Not currently exposed
	// via API; reserved for the dashboard "Cancel test" button.
	StatusCancelled TestStatus = "cancelled"
)

// Kind is how the test was created. Lets the dashboard surface a
// different empty-state per entry point.
type Kind string

const (
	KindManual          Kind = "manual"
	KindCampaignPreview Kind = "campaign_preview"
	KindMCPTool         Kind = "mcp_tool"
	KindAPI             Kind = "api"
)

// Test is the parent row in inbox_reality_tests.
type Test struct {
	ID                        string          `json:"id"`
	TenantID                  string          `json:"tenantId"`
	HeaderToken               string          `json:"headerToken"`
	Kind                      Kind            `json:"kind"`
	Subject                   string          `json:"subject,omitempty"`
	FromAddress               string          `json:"from,omitempty"`
	Status                    TestStatus      `json:"status"`
	CampaignID                string          `json:"campaignId,omitempty"`
	ContentRevisionID         string          `json:"contentRevisionId,omitempty"`
	SendPlanID                string          `json:"sendPlanId,omitempty"`
	ArtifactID                string          `json:"artifactId,omitempty"`
	ScenarioID                string          `json:"scenarioId,omitempty"`
	OutboundMIMEHash          string          `json:"outboundMimeHash,omitempty"`
	OutboundMIMEStructureHash string          `json:"outboundMimeStructureHash,omitempty"`
	RequestedCapabilities     json.RawMessage `json:"requestedCapabilities,omitempty"`
	CreatedAt                 time.Time       `json:"createdAt"`
	UpdatedAt                 time.Time       `json:"updatedAt"`
	CompletedAt               *time.Time      `json:"completedAt,omitempty"`
	ExpiresAt                 time.Time       `json:"expiresAt"`
	Meta                      json.RawMessage `json:"meta,omitempty"`
}

// Result is one (test, mailbox) row.
type Result struct {
	ID                      string          `json:"id"`
	TestID                  string          `json:"testId"`
	MailboxID               string          `json:"mailboxId"`
	Provider                Provider        `json:"provider"`
	ProviderLabel           string          `json:"providerLabel"`
	Placement               Placement       `json:"placement"`
	FolderName              string          `json:"folderName,omitempty"`
	ClassifiedAt            time.Time       `json:"classifiedAt"`
	RawHeaders              json.RawMessage `json:"rawHeaders,omitempty"`
	ObservationKey          string          `json:"observationKey,omitempty"`
	ArtifactID              string          `json:"artifactId,omitempty"`
	ScenarioID              string          `json:"scenarioId,omitempty"`
	CapabilitySnapshot      json.RawMessage `json:"capabilitySnapshot,omitempty"`
	RawMIMEStatus           string          `json:"rawMimeStatus,omitempty"`
	ReceivedMIMESHA256      string          `json:"receivedMimeSha256,omitempty"`
	ReceivedStructureSHA256 string          `json:"receivedMimeStructureSha256,omitempty"`
	StructureComparison     string          `json:"structureComparison,omitempty"`
	ObservationCapturedAt   *time.Time      `json:"observationCapturedAt,omitempty"`
}

// ProviderBreakdown is one row of the per-provider summary the
// dashboard renders.
type ProviderBreakdown struct {
	Provider   Provider          `json:"provider"`
	Label      string            `json:"label"`
	Total      int               `json:"total"`
	Placements map[Placement]int `json:"placements"`
	PrimaryPct float64           `json:"primaryPct"`
	SpamPct    float64           `json:"spamPct"`
}

// Summary rolls per-provider results into a single response.
type Summary struct {
	Total      int                 `json:"total"`
	Placements map[Placement]int   `json:"placements"`
	PrimaryPct float64             `json:"primaryPct"`
	SpamPct    float64             `json:"spamPct"`
	Providers  []ProviderBreakdown `json:"providers"`
}

// TestView is the customer-facing GET response shape — the parent
// test plus the per-mailbox results plus the rolled-up summary.
type TestView struct {
	Test     Test             `json:"test"`
	Results  []Result         `json:"results"`
	Summary  Summary          `json:"summary"`
	Dispatch *DispatchCommand `json:"dispatch,omitempty"`
}

// SeedAddress is one row in the response to GET /providers — what the
// customer's worker sends to. Hidden fields like IMAP host live in
// the deliverability service; they never leave that boundary.
type SeedAddress struct {
	MailboxID     string   `json:"mailboxId"`
	Address       string   `json:"address"`
	Provider      Provider `json:"provider"`
	ProviderLabel string   `json:"providerLabel"`
}

// ProviderInfo is the public-facing provider catalog row.
type ProviderInfo struct {
	Provider       Provider `json:"provider"`
	Label          string   `json:"label"`
	SeedCount      int      `json:"seedCount"`
	HasCategorizer bool     `json:"hasCategorizer"`
}
