// SPDX-License-Identifier: MIT

// Package adapter defines the contract every source-platform migration
// adapter must satisfy. Concrete adapters live in sibling packages
// (activecampaign, hubspot, mailchimp, convertkit, substack, beehiiv,
// mailerlite, csv) and self-register
// in their init() into the package-level Registry.
package adapter

import (
	"context"
	"time"

	"github.com/postwave/migrate/canonical"
)

// Credentials carries everything an adapter might need to authenticate.
// Adapters cherry-pick the fields relevant to their auth model.
type Credentials struct {
	// OAuthCode is the authorization_code returned by the provider's OAuth
	// callback. Adapters that use OAuth exchange it for tokens in Authenticate.
	OAuthCode string

	// AccessToken / RefreshToken short-circuit the OAuth dance for already-
	// linked accounts (e.g. resuming a job after a crash).
	AccessToken  string
	RefreshToken string

	// APIKey is for adapters that take a static key (CSV is N/A; some
	// platforms still allow API-key auth alongside OAuth).
	APIKey string

	// AccountID is the data-center / publication / workspace identifier.
	// For Mailchimp this is the "dc" string (e.g. "us21"). For Beehiiv it's
	// the publication ID. For ConvertKit it's optional.
	AccountID string

	// Extra is an escape hatch for adapter-specific creds (e.g. Stripe
	// Connect account ID coming alongside a ConvertKit OAuth flow).
	Extra map[string]string
}

// Session is the authenticated context produced by Authenticate. It is the
// only object passed back into subsequent List* / Discover calls so adapters
// can be made stateless across restarts.
type Session struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
	AccountID    string
	Source       canonical.SourcePlatform
	// Extra carries per-job adapter state that is not a bearer token or
	// account identifier, for example CSV file paths or a connected Stripe
	// account id. Handlers persist Session as an opaque value between adapter
	// calls, so this avoids process-global environment hacks.
	Extra map[string]string
}

// DiscoveryAudience describes one source audience/list that can be selected
// before running a dry-run or commit. Only adapters with audience-scoped data
// populate this; other sources leave DiscoveryReport.Audiences empty.
type DiscoveryAudience struct {
	ID               string `json:"id"`
	Name             string `json:"name,omitempty"`
	SubscribersTotal int    `json:"subscribers_total"`
}

// DiscoveryReport is the lightweight pre-flight count an adapter returns so
// the UI can confirm scope before a full migration commits.
type DiscoveryReport struct {
	SubscribersTotal int
	// ProfilesWithoutEmailTotal records source profiles that cannot enter the
	// email-subscriber traversal. It also provides a finite allowance for
	// provider pages containing only non-email identities.
	ProfilesWithoutEmailTotal int
	// AdditionalEmailIdentitiesTotal records alternate email identities that
	// are preserved as profile evidence rather than fabricated as independent
	// destination subscribers.
	AdditionalEmailIdentitiesTotal int
	SegmentsTotal                  int
	// SubscriptionChannelsTotal records source subscription-center channel
	// definitions independently from audience-like topic segments.
	SubscriptionChannelsTotal int
	AutomationsTotal          int
	PaidSubsTotal             int
	ArchiveTotal              int
	TemplatesTotal            int
	CampaignsTotal            int
	ReportsTotal              int
	GroupsTotal               int
	FormsTotal                int
	LandingPagesTotal         int
	EcommerceTotal            int
	CRMTotal                  int
	DealsTotal                int
	PipelinesTotal            int
	CustomObjectsTotal        int
	SMSCampaignsTotal         int
	PushCampaignsTotal        int
	// SourceArchiveTotal is an exact adapter-provided inventory bound for
	// dynamic preservation records. Zero retains legacy source-specific
	// fallback accounting.
	SourceArchiveTotal int
	CustomFields       []string
	// SnapshotMembershipCounts binds exact synthetic membership-tag counts
	// discovered for sources such as Beehiiv. The orchestrator compares these
	// with the subscribers actually traversed so present-but-truncated list or
	// segment expansions cannot certify an empty audience.
	SnapshotMembershipCounts map[string]int `json:"-"`
	Warnings                 []string
	Audiences                []DiscoveryAudience
}

// Adapter is the contract every source-platform plugin implements.
//
// Resumability: List* methods take a cursor string and return the next cursor.
// An empty next cursor signals end-of-stream. Cursors must be JSON-safe so
// they can be persisted in MigrationJob.Cursor.
type Adapter interface {
	Capabilities() canonical.AdapterCapabilities
	Authenticate(ctx context.Context, creds Credentials) (Session, error)
	Discover(ctx context.Context, sess Session) (DiscoveryReport, error)
	ListSubscribers(ctx context.Context, sess Session, cursor string) (subs []canonical.Subscriber, nextCursor string, err error)
	ListSegments(ctx context.Context, sess Session) ([]canonical.Segment, error)
	ListAutomations(ctx context.Context, sess Session) ([]canonical.Automation, error)
	ListCampaignArchive(ctx context.Context, sess Session, cursor string) (camps []canonical.CampaignArchive, nextCursor string, err error)
	ListPaidSubs(ctx context.Context, sess Session, stripeAccountID string) ([]canonical.PaidSub, error)
}

// SourceArchiveAdapter is implemented by sources that can preserve read-only
// records for parity surfaces Moosewave does not execute natively yet.
type SourceArchiveAdapter interface {
	ListSourceArchive(ctx context.Context, sess Session, cursor string) (items []canonical.SourceArchiveItem, nextCursor string, err error)
}

// SourceEventAdapter is implemented by sources that can stream or poll
// incremental changes during a customer shadow window.
type SourceEventAdapter interface {
	ListSourceEvents(ctx context.Context, sess Session, since time.Time, cursor string, limit int) (canonical.SourceEventBatch, error)
}

// Constructor builds an Adapter on demand. Adapters are constructed per-job so
// any per-tenant config (credentials, rate-limit overrides) can be injected.
type Constructor func() Adapter
