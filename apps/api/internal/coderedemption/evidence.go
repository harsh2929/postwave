// SPDX-License-Identifier: AGPL-3.0-only

package coderedemption

// The authenticated F04 evidence register deliberately lives beside the two
// write paths it reconciles. It is read-only and does not depend on the coupon
// allocation release gate: withholding allocation must not also hide receipts
// that already exist.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	DefaultCampaignEvidenceLimit = 25
	MaxCampaignEvidenceLimit     = 100
	MaxCampaignEvidenceOffset    = 10_000
)

var (
	ErrInvalidEvidenceInput = errors.New("coderedemption: invalid campaign evidence input")
	ErrEvidenceUnavailable  = errors.New("coderedemption: campaign evidence repository unavailable")
	ErrEvidenceNotFound     = errors.New("coderedemption: campaign evidence not found")
)

// CampaignEvidenceInput selects one bounded, newest-first page.
type CampaignEvidenceInput struct {
	Limit  int
	Offset int
}

// CampaignEvidenceSummary reconciles both F04 evidence families. Zero is a
// real zero only after this authoritative read succeeds; callers must not turn
// transport/decoder failure into an empty summary.
type CampaignEvidenceSummary struct {
	CodeAllocations          int64 `json:"code_allocations"`
	CodeRedemptions          int64 `json:"code_redemptions"`
	CodeLinkedOutcomes       int64 `json:"code_linked_outcomes"`
	NoClickRedemptions       int64 `json:"no_click_redemptions"`
	WithClickRedemptions     int64 `json:"with_click_redemptions"`
	ClickEvidenceUnavailable int64 `json:"click_evidence_unavailable"`
	VanityVisits             int64 `json:"vanity_visits"`
	VanityLinkedOutcomes     int64 `json:"vanity_linked_outcomes"`
}

// CampaignEvidenceItem is identity-minimized on purpose. The allocation UUID
// is an opaque receipt reference; recipient identity, email, code, render key,
// provider material, tenant id and request source are never serialized.
type CampaignEvidenceItem struct {
	Kind         string     `json:"kind"`
	EvidenceID   string     `json:"evidence_id"`
	OccurredAt   time.Time  `json:"occurred_at"`
	Status       string     `json:"status"`
	ExpiresAt    *time.Time `json:"expires_at"`
	RedeemedAt   *time.Time `json:"redeemed_at"`
	RedemptionID *int64     `json:"redemption_id"`
	ConversionID *int64     `json:"conversion_id"`
	AmountCents  *int64     `json:"amount_cents"`
	// Currency is the normalized three-letter code, or empty when old evidence
	// did not retain a valid code. Empty is unavailable, never an invented unit.
	Currency                             string `json:"currency"`
	AttributedVia                        string `json:"attributed_via"`
	AttributionScope                     string `json:"attribution_scope"`
	LinkedWithoutRecordedAssignmentClick *bool  `json:"linked_without_recorded_assignment_click"`
	ReadershipProven                     bool   `json:"readership_proven"`
}

type CampaignEvidencePageInfo struct {
	Limit   int   `json:"limit"`
	Offset  int   `json:"offset"`
	Total   int64 `json:"total"`
	HasMore bool  `json:"has_more"`
}

type CampaignEvidencePage struct {
	CampaignID string                   `json:"campaign_id"`
	Summary    CampaignEvidenceSummary  `json:"summary"`
	Items      []CampaignEvidenceItem   `json:"items"`
	PageInfo   CampaignEvidencePageInfo `json:"page_info"`
}

func normalizeCampaignEvidenceInput(in CampaignEvidenceInput) (CampaignEvidenceInput, error) {
	if in.Limit == 0 {
		in.Limit = DefaultCampaignEvidenceLimit
	}
	if in.Limit < 1 || in.Limit > MaxCampaignEvidenceLimit {
		return in, fmt.Errorf("%w: limit must be between 1 and %d", ErrInvalidEvidenceInput, MaxCampaignEvidenceLimit)
	}
	if in.Offset < 0 || in.Offset > MaxCampaignEvidenceOffset {
		return in, fmt.Errorf("%w: offset must be between 0 and %d", ErrInvalidEvidenceInput, MaxCampaignEvidenceOffset)
	}
	return in, nil
}

// ListCampaignEvidence returns one authoritative, bounded campaign register.
// It combines one row per allocation receipt with one row per shared vanity
// visit. A redemption and its conversion decorate the allocation row so joins
// cannot multiply the number the operator sees.
func (r *Repo) ListCampaignEvidence(
	ctx context.Context, tenantID, campaignID string, in CampaignEvidenceInput,
) (*CampaignEvidencePage, error) {
	if r == nil || r.Pool == nil {
		return nil, ErrEvidenceUnavailable
	}
	tenantID = strings.TrimSpace(tenantID)
	campaignID = strings.TrimSpace(campaignID)
	if parsed, err := uuid.Parse(campaignID); err != nil || parsed.String() != campaignID {
		return nil, fmt.Errorf("%w: campaign id must be a canonical UUID", ErrInvalidEvidenceInput)
	}
	var err error
	in, err = normalizeCampaignEvidenceInput(in)
	if err != nil {
		return nil, err
	}

	// Summary, total/has_more, and the returned rows are one evidence receipt.
	// Keep both queries on the same snapshot so a concurrent allocation,
	// redemption, or linked conversion cannot make the page contradict its own
	// totals (or make strict clients reject an otherwise successful response).
	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// A canonical but nonexistent or tenant-foreign campaign is not an
	// authoritative zero. Collapse both cases to the same not-found result so
	// callers render unavailable/missing instead of an empty evidence claim.
	var campaignExists bool
	if err := tx.QueryRow(ctx, `
SELECT true
  FROM campaigns
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, campaignID).Scan(
		&campaignExists,
	); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrEvidenceNotFound
	} else if err != nil {
		return nil, err
	}
	if !campaignExists {
		return nil, ErrEvidenceNotFound
	}

	out := &CampaignEvidencePage{
		CampaignID: campaignID,
		Items:      []CampaignEvidenceItem{},
		PageInfo:   CampaignEvidencePageInfo{Limit: in.Limit, Offset: in.Offset},
	}
	if err := tx.QueryRow(ctx, campaignEvidenceSummarySQL, tenantID, campaignID).Scan(
		&out.Summary.CodeAllocations,
		&out.Summary.CodeRedemptions,
		&out.Summary.CodeLinkedOutcomes,
		&out.Summary.NoClickRedemptions,
		&out.Summary.WithClickRedemptions,
		&out.Summary.ClickEvidenceUnavailable,
		&out.Summary.VanityVisits,
		&out.Summary.VanityLinkedOutcomes,
	); err != nil {
		return nil, err
	}
	if !validCampaignEvidenceSummary(out.Summary) {
		return nil, errors.New("coderedemption: inconsistent campaign evidence summary")
	}
	out.PageInfo.Total = out.Summary.CodeAllocations + out.Summary.VanityVisits

	rows, err := tx.Query(ctx, campaignEvidenceItemsSQL, tenantID, campaignID, in.Limit, in.Offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var item CampaignEvidenceItem
		if err := rows.Scan(
			&item.Kind, &item.EvidenceID, &item.OccurredAt, &item.Status,
			&item.ExpiresAt, &item.RedeemedAt, &item.RedemptionID,
			&item.ConversionID, &item.AmountCents, &item.Currency,
			&item.AttributedVia, &item.AttributionScope,
			&item.LinkedWithoutRecordedAssignmentClick,
		); err != nil {
			return nil, err
		}
		item.OccurredAt = item.OccurredAt.UTC()
		item.ReadershipProven = false
		out.Items = append(out.Items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out.PageInfo.HasMore = int64(in.Offset+len(out.Items)) < out.PageInfo.Total
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func validCampaignEvidenceSummary(summary CampaignEvidenceSummary) bool {
	return summary.CodeAllocations >= 0 &&
		summary.CodeRedemptions >= 0 &&
		summary.CodeRedemptions <= summary.CodeAllocations &&
		summary.CodeLinkedOutcomes >= 0 &&
		summary.CodeLinkedOutcomes <= summary.CodeAllocations &&
		summary.NoClickRedemptions >= 0 &&
		summary.WithClickRedemptions >= 0 &&
		summary.ClickEvidenceUnavailable >= 0 &&
		summary.NoClickRedemptions+summary.WithClickRedemptions+
			summary.ClickEvidenceUnavailable == summary.CodeRedemptions &&
		summary.VanityVisits >= 0 &&
		summary.VanityLinkedOutcomes >= 0 &&
		summary.VanityLinkedOutcomes <= summary.VanityVisits
}

const campaignAllocationCTE = `
campaign_allocations AS MATERIALIZED (
    SELECT a.id, a.assigned_at, a.status, a.expires_at, a.redeemed_at
      FROM coupon_assignments a
     WHERE a.tenant_id = $1::uuid
       AND a.campaign_id = $2::uuid
    UNION ALL
    SELECT a.id, a.assigned_at, a.status, a.expires_at, a.redeemed_at
      FROM coupon_assignments a
      JOIN coupon_pools p
        ON p.tenant_id = a.tenant_id AND p.id = a.pool_id
     WHERE a.tenant_id = $1::uuid
       AND a.campaign_id IS NULL
       AND p.campaign_id = $2::uuid
)`

const campaignEvidenceSummarySQL = `
WITH ` + campaignAllocationCTE + `,
code_evidence AS (
    SELECT a.id,
           r.id AS redemption_id,
           r.linked_without_recorded_assignment_click AS no_click,
           c.id AS conversion_id
      FROM campaign_allocations a
      LEFT JOIN discount_redemptions r
        ON r.tenant_id = $1::uuid AND r.assignment_id = a.id
      LEFT JOIN conversions c
        ON c.tenant_id = $1::uuid
       AND c.code_assignment_id = a.id
       AND c.attributed_via = 'code_redemption'
),
vanity_evidence AS (
    SELECT v.id, v.conversion_id
      FROM campaign_vanity_visits v
     WHERE v.tenant_id = $1::uuid AND v.campaign_id = $2::uuid
)
SELECT
    (SELECT count(*) FROM code_evidence),
    (SELECT count(redemption_id) FROM code_evidence),
    (SELECT count(conversion_id) FROM code_evidence),
    (SELECT count(*) FROM code_evidence WHERE redemption_id IS NOT NULL AND no_click IS TRUE),
    (SELECT count(*) FROM code_evidence WHERE redemption_id IS NOT NULL AND no_click IS FALSE),
    (SELECT count(*) FROM code_evidence WHERE redemption_id IS NOT NULL AND no_click IS NULL),
    (SELECT count(*) FROM vanity_evidence),
    (SELECT count(conversion_id) FROM vanity_evidence)`

const campaignEvidenceItemsSQL = `
WITH ` + campaignAllocationCTE + `,
evidence AS (
    SELECT 'code_allocation'::text AS kind,
           a.id::text AS evidence_id,
           a.assigned_at AS occurred_at,
           a.status::text AS status,
           a.expires_at,
           COALESCE(r.redeemed_at, a.redeemed_at) AS redeemed_at,
           r.id::bigint AS redemption_id,
           c.id::bigint AS conversion_id,
           c.amount_cents::bigint AS amount_cents,
           CASE
             WHEN upper(btrim(COALESCE(c.currency, ''))) ~ '^[A-Z]{3}$'
               THEN upper(btrim(c.currency))
             ELSE ''
           END::text AS currency,
           'code_redemption'::text AS attributed_via,
           'campaign_assignment'::text AS attribution_scope,
           r.linked_without_recorded_assignment_click
      FROM campaign_allocations a
      LEFT JOIN discount_redemptions r
        ON r.tenant_id = $1::uuid AND r.assignment_id = a.id
      LEFT JOIN conversions c
        ON c.tenant_id = $1::uuid
       AND c.code_assignment_id = a.id
       AND c.attributed_via = 'code_redemption'
    UNION ALL
    SELECT 'vanity_visit'::text,
           v.id::text,
           v.occurred_at,
           CASE WHEN v.conversion_id IS NULL THEN 'visited' ELSE 'converted' END,
           NULL::timestamptz,
           NULL::timestamptz,
           NULL::bigint,
           c.id::bigint,
           c.amount_cents::bigint,
           CASE
             WHEN upper(btrim(COALESCE(c.currency, ''))) ~ '^[A-Z]{3}$'
               THEN upper(btrim(c.currency))
             ELSE ''
           END::text,
           'campaign_vanity_path'::text,
           'campaign'::text,
           NULL::boolean
      FROM campaign_vanity_visits v
      LEFT JOIN conversions c
        ON c.tenant_id = v.tenant_id AND c.id = v.conversion_id
     WHERE v.tenant_id = $1::uuid AND v.campaign_id = $2::uuid
)
SELECT kind, evidence_id, occurred_at, status, expires_at, redeemed_at,
       redemption_id, conversion_id, amount_cents, currency,
       attributed_via, attribution_scope,
       linked_without_recorded_assignment_click
  FROM evidence
 ORDER BY occurred_at DESC, evidence_id DESC
 LIMIT $3 OFFSET $4`
