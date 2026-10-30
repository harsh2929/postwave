// SPDX-License-Identifier: AGPL-3.0-only

package coderedemption

// Vanity campaign paths — /go/{slug} (PRD F04, second half).
//
// The package comment explains why a per-recipient code is stronger evidence
// than a click. A vanity path is the OTHER half of the same acceptance
// criterion, and it sits one rung lower on that same ladder:
//
//	code   — this PERSON received THIS campaign. Nothing else issued them that
//	         string, so the conversion may name the subscriber.
//	vanity — THIS CAMPAIGN caused a visit. The URL is public and shared: every
//	         recipient gets the same one and anyone can repost it, so the visit
//	         names nobody.
//	click  — a request came from a link in a message. A prefetching gateway can
//	         produce one; nobody accidentally redeems a discount.
//
// The rung matters more than the credit. A vanity visit that claimed a
// subscriber would look exactly like a code redemption in every report while
// being an unsupported guess, and no later query could separate them. So the
// provenance value is distinct (`campaign_vanity_path`, not `code_redemption`),
// the visit row has no subscriber column at all, and the database refuses a
// conversion that carries this provenance together with any identity column.
//
// The path is also unauthenticated and attacker-reachable, which drives three
// more decisions documented at their implementations: every miss collapses to
// one indistinguishable outcome (mirroring internal/polls, where distinguishing
// them would let a caller enumerate), the tenant is resolved by a fixed-query
// SECURITY DEFINER function rather than a caller-settable GUC policy, and the
// redirect target is CONSTRUCTED from a verified host plus a validated path
// rather than stored as a URL.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// AttributedViaVanityPath is the provenance of a conversion credited through a
// shared campaign path.
//
// Deliberately NOT AttributedViaCodeRedemption. That value means one named
// recipient presented a string only this campaign ever issued them. This one
// means somebody walked through a URL this campaign published — the campaign is
// evidenced, the person is not. A single value for both would let a
// per-subscriber revenue report count the second as though it were the first.
const AttributedViaVanityPath = "campaign_vanity_path"

// Attribution scopes name how far the evidence reaches. They exist so a caller
// asserts on the claim rather than inferring it from which method it called.
const (
	// AttributionScopeCampaignAssignment means the outcome is linked to one
	// issuance/allocation receipt and its campaign. It deliberately does not say
	// who redeemed the code or who read the message.
	AttributionScopeCampaignAssignment = "campaign_assignment"
	// AttributionScopeCampaign — the evidence identifies the campaign only.
	AttributionScopeCampaign = "campaign"
)

// VisitReferenceParam is the query parameter carrying the opaque per-visit id
// onto the destination, so a conversion reported later can be tied back to the
// campaign. Per VISIT, never per person: it is minted here and did not exist
// before the request.
const VisitReferenceParam = "pw_visit"

// maxDestinationPathLength mirrors the database CHECK.
const maxDestinationPathLength = 512

var (
	// ErrUnknownPath — no such slug, or a malformed one.
	ErrUnknownPath = errors.New("coderedemption: vanity path not recognised")
	// ErrPathDisabled — the slug exists and has been retired.
	//
	// A DISTINCT error from ErrUnknownPath on purpose, and it must never reach a
	// public response. The repository's job is to say what actually happened, so
	// an operator reading a log or an authenticated caller can tell a retired
	// campaign from a typo; collapsing the two here would throw that away for
	// everyone. The collapse belongs at exactly one place — the public HTTP
	// boundary, in writeVanityMiss — because that is the only place where
	// telling them apart hands an anonymous caller an oracle for which
	// campaigns a workspace has run. internal/polls draws the same line for the
	// same reason.
	ErrPathDisabled = errors.New("coderedemption: vanity path is disabled")
	// ErrDestinationUnverified — the path is live but its destination host is no
	// longer a verified domain of the workspace. Also collapsed publicly.
	ErrDestinationUnverified = errors.New(
		"coderedemption: vanity destination host is no longer verified")
	// ErrSlugUnavailable is returned when the slug is already claimed. Slugs are
	// globally unique and never reassigned — a sent message is immortal.
	ErrSlugUnavailable = errors.New("coderedemption: vanity slug is already in use")
	// ErrInvalidSlug is returned to an AUTHENTICATED author whose slug cannot be
	// stored. Never returned on the public path, where it would distinguish a
	// malformed slug from an unknown one.
	ErrInvalidSlug = errors.New("coderedemption: vanity slug is not usable")
	// ErrUnsafeDestination is returned when a destination is not a path on a
	// host this tenant has verified.
	ErrUnsafeDestination = errors.New(
		"coderedemption: destination must be a path on a verified domain of this workspace")
	// ErrUnknownVisit is returned when a visit reference does not resolve.
	ErrUnknownVisit = errors.New("coderedemption: visit reference not recognised")
	// ErrVisitAlreadyConverted keeps one visit from crediting a campaign twice.
	ErrVisitAlreadyConverted = errors.New("coderedemption: visit already carries a conversion")
)

// VanityRepo stores and resolves vanity campaign paths.
type VanityRepo struct {
	Pool *db.Pool
	Now  func() time.Time
}

func (r *VanityRepo) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

// NewPath is an authoring request.
type NewPath struct {
	Slug       string
	CampaignID string
	// DestinationHost must be a VERIFIED custom domain of the same workspace,
	// and DestinationPath must be a path on it. The destination is not stored as
	// a URL: see buildDestination.
	DestinationHost string
	DestinationPath string
}

// PathRecord is a stored vanity path.
type PathRecord struct {
	ID              string
	Slug            string
	CampaignID      string
	DestinationHost string
	DestinationPath string
	Status          string
}

// VisitRequest is one arrival at /go/{slug}.
type VisitRequest struct {
	OccurredAt time.Time
	// SubscriberHint is any recipient identifier that happened to travel with
	// the request — a query parameter someone appended, a cookie, a header.
	//
	// It is accepted and DISCARDED, and that is the point. A vanity URL is
	// shared: the same string reaches every recipient and can be reposted
	// anywhere, so a subscriber identifier arriving on it is a claim by whoever
	// sent the request, not evidence produced by us. Honouring it would let
	// anybody attribute a visit to any subscriber they can name.
	SubscriberHint string
}

// VisitResult is the resolved redirect plus the attribution that was recorded.
type VisitResult struct {
	// Reference is the opaque per-visit id. Not a person, and not guessable.
	Reference string
	// CampaignID is the campaign this path was published for — the attribution.
	CampaignID string
	// Destination is an absolute https URL built from a verified host and a
	// validated path. No part of the request influences it.
	Destination string
	// AttributionScope is always AttributionScopeCampaign here, stated rather
	// than implied so a caller can assert the claim is not per-person.
	AttributionScope string
	// AttributedVia is AttributedViaVanityPath.
	AttributedVia string
}

// VanityConversion is a conversion reported against a visit.
type VanityConversion struct {
	AmountCents int64
	Currency    string
	OccurredAt  time.Time
	// CustomerEmail is whatever the reporting system knows about the buyer.
	//
	// It is NOT written to the conversion. Knowing who bought is fine; claiming
	// that THIS campaign reached THAT person is not, because a shared URL cannot
	// establish it. The database enforces this independently — see migration
	// 1963's conversions_vanity_path_scope_check — so a future caller that
	// passes it through is rejected rather than quietly believed.
	CustomerEmail string
}

// VanityConversionResult is the recorded credit.
type VanityConversionResult struct {
	ConversionID     int64
	CampaignID       string
	AttributionScope string
	AttributedVia    string
}

// CampaignVanityAttribution is what a campaign report reads.
type CampaignVanityAttribution struct {
	Visits       int64
	Conversions  int64
	RevenueCents int64
}

// CreatePath publishes a vanity path for a campaign. Authenticated authoring.
func (r *VanityRepo) CreatePath(ctx context.Context, tenantID string, in NewPath) (*PathRecord, error) {
	slug, err := NormalizeSlug(in.Slug)
	if err != nil {
		return nil, err
	}
	host := strings.ToLower(strings.TrimSpace(in.DestinationHost))
	if !validDestinationHost(host) {
		return nil, ErrUnsafeDestination
	}
	path := strings.TrimSpace(in.DestinationPath)
	if path == "" {
		path = "/"
	}
	if err := ValidateDestinationPath(path); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.CampaignID) == "" {
		return nil, ErrInvalidSlug
	}
	if _, err := uuid.Parse(strings.TrimSpace(in.CampaignID)); err != nil {
		// Refused before it reaches a ::uuid cast, so a mistyped id is a 400
		// rather than a 500.
		return nil, ErrInvalidSlug
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// The host must be verified, checked here rather than left to the composite
	// foreign key. The key proves the host BELONGS to this workspace; only this
	// proves the workspace still demonstrably controls it. A foreign-key
	// violation reaching the caller means these two drifted apart, so it is
	// deliberately not translated into ErrUnsafeDestination — a raw error is the
	// signal that the guard above stopped covering the constraint below.
	var verified bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM custom_domains
     WHERE tenant_id = $1::uuid AND domain = $2::citext AND verified IS TRUE
)`, tenantID, host).Scan(&verified); err != nil {
		return nil, err
	}
	if !verified {
		return nil, ErrUnsafeDestination
	}

	out := &PathRecord{
		Slug: slug, CampaignID: strings.TrimSpace(in.CampaignID),
		DestinationHost: host, DestinationPath: path, Status: "active",
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO campaign_vanity_paths
    (tenant_id, slug, campaign_id, destination_host, destination_path, status)
VALUES ($1::uuid, $2::citext, $3::uuid, $4::citext, $5, 'active')
RETURNING id::text`,
		tenantID, slug, out.CampaignID, host, path).Scan(&out.ID); err != nil {
		if isUniqueViolation(err, "campaign_vanity_paths_slug_uniq") {
			return nil, ErrSlugUnavailable
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ListPaths returns a campaign's vanity paths, including disabled ones.
func (r *VanityRepo) ListPaths(ctx context.Context, tenantID, campaignID string) ([]PathRecord, error) {
	if _, err := uuid.Parse(strings.TrimSpace(campaignID)); err != nil {
		return nil, ErrInvalidSlug
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id::text, slug::text, campaign_id::text, destination_host::text,
       destination_path, status
  FROM campaign_vanity_paths
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
 ORDER BY created_at ASC`, tenantID, strings.TrimSpace(campaignID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]PathRecord, 0, 4)
	for rows.Next() {
		var p PathRecord
		if err := rows.Scan(&p.ID, &p.Slug, &p.CampaignID, &p.DestinationHost,
			&p.DestinationPath, &p.Status); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// SetPathStatus retires or restores a path. A retired path is disabled, never
// deleted: deleting it frees a slug that is printed in messages already
// delivered, and the next tenant to claim it would inherit that traffic.
func (r *VanityRepo) SetPathStatus(ctx context.Context, tenantID, pathID, status string) error {
	if status != "active" && status != "disabled" {
		return ErrInvalidSlug
	}
	if _, err := uuid.Parse(strings.TrimSpace(pathID)); err != nil {
		return ErrUnknownPath
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE campaign_vanity_paths SET status = $3, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, strings.TrimSpace(pathID), status)
	if err != nil {
		return err
	}
	// RLS filters, it does not refuse: an out-of-tenant id updates zero rows and
	// reports success, so the row count is the only thing that can tell us.
	if tag.RowsAffected() == 0 {
		return ErrUnknownPath
	}
	return tx.Commit(ctx)
}

// ResolveTenant maps a public slug to its workspace.
//
// This runs BEFORE any tenant is known, so it cannot use a policy keyed on a
// caller-settable GUC — every postwave_app session can set one, which would
// make the policy a cross-tenant read capability rather than a boundary. It
// calls the fixed-query SECURITY DEFINER function from migration 1963, owned by
// a NOLOGIN/NOBYPASSRLS role that can read exactly (id, tenant_id, slug).
func (r *VanityRepo) ResolveTenant(ctx context.Context, slug string) (string, bool) {
	normalized, err := NormalizeSlug(slug)
	if err != nil {
		return "", false
	}
	var tenantID *string
	if err := r.Pool.QueryRow(ctx,
		`SELECT public.resolve_campaign_vanity_path($1)::text`, normalized).Scan(&tenantID); err != nil {
		return "", false
	}
	if tenantID == nil || *tenantID == "" {
		return "", false
	}
	return *tenantID, true
}

// RecordVisit resolves /go/{slug} and records the campaign-level attribution.
//
// This is the acceptance criterion's second half: the recipient clicked nothing,
// so no click event exists and last-touch attribution can never see them, yet
// the campaign is credited for the visit it caused.
func (r *VanityRepo) RecordVisit(ctx context.Context, slug string, in VisitRequest) (*VisitResult, error) {
	tenantID, ok := r.ResolveTenant(ctx, slug)
	if !ok {
		return nil, ErrUnknownPath
	}
	normalized, err := NormalizeSlug(slug)
	if err != nil {
		return nil, ErrUnknownPath
	}
	occurredAt := in.OccurredAt
	if occurredAt.IsZero() {
		occurredAt = r.now()
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var pathID, campaignID, host, path, status string
	if err := tx.QueryRow(ctx, `
SELECT id::text, campaign_id::text, destination_host::text, destination_path, status
  FROM campaign_vanity_paths
 WHERE tenant_id = $1::uuid AND slug = $2::citext`, tenantID, normalized).Scan(
		&pathID, &campaignID, &host, &path, &status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUnknownPath
		}
		return nil, err
	}
	if status != "active" {
		return nil, ErrPathDisabled
	}

	// Verification is re-checked at every visit, not only at authoring time. A
	// domain can lose verification after the path was published, and continuing
	// to redirect recipients at a host we can no longer show the workspace
	// controls is worse than a dead link.
	var verified bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM custom_domains
     WHERE tenant_id = $1::uuid AND domain = $2::citext AND verified IS TRUE
)`, tenantID, host).Scan(&verified); err != nil {
		return nil, err
	}
	if !verified {
		return nil, ErrDestinationUnverified
	}

	// The attribution. No subscriber is written, and there is nowhere to write
	// one: campaign_vanity_visits has no such column. in.SubscriberHint is
	// carried into this function and goes no further — see VisitRequest.
	var reference string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaign_vanity_visits
    (tenant_id, path_id, campaign_id, attribution_scope, occurred_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
RETURNING id::text`,
		tenantID, pathID, campaignID, AttributionScopeCampaign, occurredAt).Scan(&reference); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	return &VisitResult{
		Reference:   reference,
		CampaignID:  campaignID,
		Destination: buildDestination(host, path, reference),
		// Campaign, not subscriber. The URL is shared; the visit names nobody.
		AttributionScope: AttributionScopeCampaign,
		AttributedVia:    AttributedViaVanityPath,
	}, nil
}

// AttributeConversion credits a conversion to the campaign behind a visit.
//
// The conversion is written with NO preceding click and NO subscriber: the
// campaign is evidenced, the person is not.
func (r *VanityRepo) AttributeConversion(
	ctx context.Context, tenantID, reference string, in VanityConversion,
) (*VanityConversionResult, error) {
	trimmed := strings.TrimSpace(reference)
	if _, err := uuid.Parse(trimmed); err != nil {
		return nil, ErrUnknownVisit
	}
	occurredAt := in.OccurredAt
	if occurredAt.IsZero() {
		occurredAt = r.now()
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var campaignID string
	var existing *int64
	if err := tx.QueryRow(ctx, `
SELECT campaign_id::text, conversion_id
  FROM campaign_vanity_visits
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, trimmed).Scan(
		&campaignID, &existing); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUnknownVisit
		}
		return nil, err
	}
	if existing != nil {
		return nil, ErrVisitAlreadyConverted
	}

	out := &VanityConversionResult{
		CampaignID:       campaignID,
		AttributionScope: AttributionScopeCampaign,
		AttributedVia:    AttributedViaVanityPath,
	}
	// subscriber_email, email_sha256, external_id and referrer_subscriber_id are
	// all omitted, and in.CustomerEmail is deliberately not among the arguments.
	// Migration 1963 refuses this row if any of them is present alongside this
	// provenance, so the rule survives an edit to this statement.
	if err := tx.QueryRow(ctx, `
INSERT INTO conversions
    (tenant_id, event_name, amount_cents, currency, campaign_id, attributed_via, occurred_at)
VALUES ($1::uuid, 'vanity_path_visit', $2, NULLIF($3, ''), $4::uuid, $5, $6)
RETURNING id`, tenantID, in.AmountCents, strings.ToUpper(strings.TrimSpace(in.Currency)),
		campaignID, AttributedViaVanityPath, occurredAt).Scan(&out.ConversionID); err != nil {
		return nil, err
	}

	// Conditional on conversion_id still being NULL so two concurrent reports
	// cannot both believe they were first.
	tag, err := tx.Exec(ctx, `
UPDATE campaign_vanity_visits SET conversion_id = $3
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND conversion_id IS NULL`,
		tenantID, trimmed, out.ConversionID)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrVisitAlreadyConverted
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// CampaignAttribution is the campaign-level total a report reads. Campaign
// level is the only level this evidence supports, so it is the only level
// offered.
func (r *VanityRepo) CampaignAttribution(
	ctx context.Context, tenantID, campaignID string,
) (*CampaignVanityAttribution, error) {
	if _, err := uuid.Parse(strings.TrimSpace(campaignID)); err != nil {
		return nil, ErrInvalidSlug
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := &CampaignVanityAttribution{}
	if err := tx.QueryRow(ctx, `
SELECT count(*),
       count(v.conversion_id),
       COALESCE(sum(c.amount_cents), 0)
  FROM campaign_vanity_visits v
  LEFT JOIN conversions c
         ON c.id = v.conversion_id AND c.tenant_id = v.tenant_id
 WHERE v.tenant_id = $1::uuid AND v.campaign_id = $2::uuid`,
		tenantID, strings.TrimSpace(campaignID)).Scan(
		&out.Visits, &out.Conversions, &out.RevenueCents); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// NormalizeSlug lower-cases and validates a vanity slug.
//
// Case-folded because a recipient typing a URL off a printed page or a podcast
// read will not preserve it, and /go/Spring-Sale resolving to nothing looks
// like a broken campaign rather than a typo.
func NormalizeSlug(raw string) (string, error) {
	slug := strings.ToLower(strings.TrimSpace(raw))
	if len(slug) < 1 || len(slug) > 64 {
		return "", ErrInvalidSlug
	}
	for i := 0; i < len(slug); i++ {
		c := slug[i]
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		case c == '-':
			// No leading or trailing dash: it reads as a typo and some clients
			// trim it out of a linkified URL.
			if i == 0 || i == len(slug)-1 {
				return "", ErrInvalidSlug
			}
		default:
			// Dots excluded on purpose: a slug that reads as a hostname
			// (/go/paypal.com) is a phishing affordance we would be hosting.
			return "", ErrInvalidSlug
		}
	}
	return slug, nil
}

// ValidateDestinationPath mirrors migration 1963's CHECK.
//
// The list is short and every entry is a way a "path" has historically become a
// different origin. It is duplicated in Go rather than left to the database
// because an author deserves ErrUnsafeDestination, not a constraint name — and
// because a constraint violation surfacing raw is then a reliable signal that
// these two have drifted apart.
func ValidateDestinationPath(path string) error {
	if path != strings.TrimSpace(path) || path == "" {
		return ErrUnsafeDestination
	}
	if len(path) > maxDestinationPathLength {
		return ErrUnsafeDestination
	}
	if !strings.HasPrefix(path, "/") {
		return ErrUnsafeDestination
	}
	// "//evil.example" is a protocol-relative URL, not a path.
	if strings.HasPrefix(path, "//") {
		return ErrUnsafeDestination
	}
	// Several URL parsers normalise a backslash to a slash, which turns
	// "/\evil.example" back into the case above.
	if strings.ContainsAny(path, `\#`) {
		return ErrUnsafeDestination
	}
	for i := 0; i < len(path); i++ {
		if path[i] <= 0x20 || path[i] == 0x7f {
			return ErrUnsafeDestination
		}
	}
	return nil
}

// validDestinationHost accepts a bare hostname and nothing else.
//
// This is what makes buildDestination provably single-origin: a host containing
// '@', '/', ':' or whitespace could re-point https://<host><path> elsewhere no
// matter how carefully the path was checked.
func validDestinationHost(host string) bool {
	if host == "" || len(host) > 253 || host != strings.TrimSpace(host) {
		return false
	}
	labels := strings.Split(host, ".")
	if len(labels) < 2 {
		return false
	}
	for _, label := range labels {
		if label == "" || len(label) > 63 {
			return false
		}
		if label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for i := 0; i < len(label); i++ {
			c := label[i]
			if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' {
				continue
			}
			return false
		}
	}
	return true
}

// buildDestination constructs the redirect target.
//
// CONSTRUCTED, never stored and never taken from the request. The scheme is a
// literal, the host came out of a row a foreign key ties to this workspace and
// a verification check re-tested this second, and the path was validated to be
// a path. There is no input here an attacker can reach, which is why the open
// redirect is absent rather than defended against.
func buildDestination(host, path, reference string) string {
	separator := "?"
	if strings.Contains(path, "?") {
		separator = "&"
	}
	return fmt.Sprintf("https://%s%s%s%s=%s", host, path, separator, VisitReferenceParam, reference)
}

func isUniqueViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	return pgErr.Code == "23505" && pgErr.ConstraintName == constraint
}
