// SPDX-License-Identifier: AGPL-3.0-only
//
// engagement.go — Surfacing Analytics (#3): the honest AI-era engagement
// panel. Leads with hard signals (MPP-stripped human open rate + reply
// rate), introduces open-decoupled conversion attribution, and exposes an
// EXPLICITLY-ESTIMATED AI-surfacing score. No fabricated numbers.
//
// Architecture: every number on EngagementPanel is either a hard count
// from the database or a deterministic function of those counts. The
// AI-surfacing score is a pure, table-tested formula (aiSurfacingScore)
// with NO ML model and NO inbox-provider signal — it is a heuristic over
// engagement proxies and is always rendered behind an EstimateBadge by
// the desktop. The persistence the panel needs is hidden behind small
// interfaces (botOpenFilter, openDecoupledStore) so computeEngagementPanel
// is unit-testable with fakes and NO live Postgres. The real pgx
// implementations satisfy the same interfaces.
package analytics

import (
	"context"
	"fmt"
	"math"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// EngagementPanel is returned by GET /api/v1/campaigns/{id}/engagement.
// It bundles the trust signals (hard data, labelled precisely) and the
// AI-surfacing estimate (always labelled, never presented as fact) for
// the honest engagement panel.
type EngagementPanel struct {
	CampaignID string `json:"campaign_id"`

	// ClassificationFilter echoes the F01 band the counts below were computed
	// under: "all" (the default and the historical behaviour), "human",
	// "machine" or "unknown".
	//
	// Always present, never omitted when empty. A payload that carried filtered
	// numbers and no statement of the filter would be indistinguishable from an
	// unfiltered one the moment it was pasted into a spreadsheet, and the whole
	// point of F01 is that an engagement figure travels with the definition
	// that produced it.
	ClassificationFilter string `json:"classification_filter"`

	// --- Trust Signals (hard data, labelled precisely) ---

	// Delivered is the denominator for the rate signals.
	Delivered int `json:"delivered"`

	// HumanUniqueOpens / HumanOpenRate: bot-stripped unique openers.
	// Both are zeroed when HumanEngagementEnabled is false; the desktop
	// hides the human row and falls back to the raw rate in that case
	// (D4: disclose that bot-filtering is off).
	HumanUniqueOpens int     `json:"human_unique_opens"`
	HumanOpenRate    float64 `json:"human_open_rate"` // fraction 0..1, NOT percent

	// RawOpenRate is the unfiltered rate (unique_opens/delivered) so the
	// UI can show the bot-inflation delta honestly.
	RawOpenRate float64 `json:"raw_open_rate"` // fraction 0..1

	// ReplyCount / DistinctReplyers / ReplyRate from campaign_replies.
	// ReplyRate is distinct_replyers / unique_recipients (the same
	// denominator reply_analytics.ByCampaign uses).
	ReplyCount       int64   `json:"reply_count"`
	DistinctReplyers int64   `json:"distinct_replyers"`
	ReplyRate        float64 `json:"reply_rate"` // fraction 0..1

	// OpenDecoupledConversions: conversions attributed to this campaign
	// (attributed_via IN explicit/last_touch) where the subscriber has
	// ZERO 'opened' events for this campaign in campaign_report_events.
	// This is the instrument that did not exist before: "acted on
	// without a recorded open". It is a pure count — never estimated.
	OpenDecoupledConversions   int64 `json:"open_decoupled_conversions"`
	TotalAttributedConversions int64 `json:"total_attributed_conversions"`

	// BotSignaturesApplied lists the signature labels that actually fired
	// on this campaign's events (mirrors CampaignReport.BotSignaturesApplied).
	// Empty when no bots matched.
	BotSignaturesApplied []string `json:"bot_signatures_applied"`

	// --- AI Surfacing Estimate (always labelled; never presented as fact) ---

	// AISurfacingScore is an ESTIMATE in [0,1]: a heuristic for how
	// likely this campaign's mail was surfaced/prioritised by AI inbox
	// managers (Gmail Priority Inbox, Apple Intelligence Mail summaries,
	// Outlook Focused Inbox). Derived from engagement proxies only — see
	// aiSurfacingScore. NEVER render without the EstimateBadge.
	AISurfacingScore float64 `json:"ai_surfacing_score"`

	// AISurfacingBasis lists which proxy signals were available and fed
	// the estimate, e.g. ["human_open_rate","reply_rate","hard_bounce_rate"].
	AISurfacingBasis []string `json:"ai_surfacing_basis"`

	// AISurfacingConfidenceLevel is "low" when the sample is too small to
	// trust the estimate (HumanUniqueOpens < aiLowConfidenceMinOpens OR
	// ReplyCount == 0), "ok" otherwise. Set server-side; the desktop only
	// renders what it is told (ConfidenceNote fires on "low").
	AISurfacingConfidenceLevel string `json:"ai_surfacing_confidence_level"`

	// AISurfacingSampleOpens is the raw human-open sample count behind the
	// estimate — exposed for honest SampleSize rendering.
	AISurfacingSampleOpens int `json:"ai_surfacing_sample_opens"`
}

// AI-surfacing score formula weights. Approved decision D1 (2026-06-15):
// reply weight 0.5 — reply is the strongest, most AI-era inbox-surfacing
// signal in practice (Gmail Priority Inbox and Apple Intelligence Mail
// both heavily weight reply threads). These live here as named constants
// so the score can be retuned without a schema change or migration.
const (
	aiWeightReply        = 0.5 // distinct-reply rate
	aiWeightOpen         = 0.2 // bot-stripped human open rate
	aiWeightBounceHealth = 0.3 // (1 - hard bounce rate): a clean list surfaces better
	// aiCTORBonus is added (then the score is re-clamped) when the
	// click-to-open ratio clears aiCTORBonusThreshold — strong CTOR is a
	// secondary signal that the content earned real attention.
	aiCTORBonus          = 0.1
	aiCTORBonusThreshold = 0.05
)

// aiLowConfidenceMinOpens is the human-open sample below which the
// estimate is flagged low-confidence (approved decision D2: 50 opens,
// matching the AB-testing stat-sig minimum used elsewhere in the repo).
const aiLowConfidenceMinOpens = 50

// Confidence level wire values.
const (
	aiConfidenceLow = "low"
	aiConfidenceOK  = "ok"
)

// aiSurfacingScore is the PURE, deterministic heuristic behind the
// AI-surfacing estimate. It takes engagement proxies and returns a
// clamped [0,1] score, a confidence level ("low"/"ok"), and the ordered
// basis of which signals were actually present.
//
// Inputs are fractions in [0,1] (a defensive clamp guards data-integrity
// glitches such as a hardBounceRate > 1). The score is:
//
//	0.2*humanOpenRate + 0.5*replyRate + 0.3*(1 - hardBounceRate)
//	  (+0.1 bonus when clickToOpenRate > 0.05)
//
// then clamped to [0,1]. Reply weight 0.5 per approved decision D1.
//
// Confidence is "low" when humanUniqueOpens < 50 (D2) OR replyRate == 0
// with no reply sample — reply rate is half the score weight, so zero
// replies must always read as low confidence.
//
// Basis only lists signals that were genuinely available (humanUniqueOpens
// > 0 → "human_open_rate"; a positive reply rate → "reply_rate"; a
// positive hard-bounce rate → "hard_bounce_rate"; CTOR over threshold →
// "click_to_open_rate"). An all-zero campaign yields score 0, "low"
// confidence, and an empty basis — honest emptiness, never a fabricated
// number.
func aiSurfacingScore(
	humanOpenRate, replyRate, hardBounceRate, clickToOpenRate float64,
	humanUniqueOpens int,
) (score float64, confidence string, basis []string) {
	ho := clamp01(humanOpenRate)
	rr := clamp01(replyRate)
	hb := clamp01(hardBounceRate)
	ctor := clamp01(clickToOpenRate)

	basis = make([]string, 0, 4)
	if humanUniqueOpens > 0 {
		basis = append(basis, "human_open_rate")
	}
	if rr > 0 {
		basis = append(basis, "reply_rate")
	}
	if hb > 0 {
		basis = append(basis, "hard_bounce_rate")
	}

	score = aiWeightOpen*ho + aiWeightReply*rr + aiWeightBounceHealth*(1-hb)
	if ctor > aiCTORBonusThreshold {
		score += aiCTORBonus
		basis = append(basis, "click_to_open_rate")
	}
	score = clamp01(score)

	// Nothing real to base the estimate on → do not let the
	// (1 - hardBounceRate) baseline imply a meaningful surfacing score.
	// An all-empty campaign reports 0 with an empty basis.
	if len(basis) == 0 {
		score = 0
	}

	confidence = aiConfidenceOK
	if humanUniqueOpens < aiLowConfidenceMinOpens || rr == 0 {
		confidence = aiConfidenceLow
	}
	return score, confidence, basis
}

// clamp01 bounds x to [0,1] and collapses NaN/Inf to 0 so a malformed
// upstream count can never poison the score.
func clamp01(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) || x < 0 {
		return 0
	}
	if x > 1 {
		return 1
	}
	return x
}

// engagementInputs are the raw hard counts the panel is assembled from.
// Kept as a plain struct so computeEngagementPanel is a pure function of
// its inputs and is unit-testable without any database.
type engagementInputs struct {
	CampaignID string

	// Classification is the F01 band the interaction counts below were read
	// under. It never changes the arithmetic — it is carried through the pure
	// assembler only so the wire payload can state what it measured.
	Classification ClassificationFilter

	Delivered int

	RawUniqueOpens   int
	HumanUniqueOpens int

	// HumanEngagementEnabled mirrors Repo.HumanEngagementEnabled. When
	// false the human-open fields are zeroed (D4): the desktop discloses
	// that bot-filtering is off and falls back to the raw rate.
	HumanEngagementEnabled bool

	UniqueRecipients int64
	ReplyCount       int64
	DistinctReplyers int64

	OpenDecoupledConversions   int64
	TotalAttributedConversions int64

	HardBounces int

	// UniqueClicks feeds the click-to-open ratio bonus in the AI score.
	UniqueClicks int

	BotSignaturesApplied []string
}

// computeEngagementPanel assembles the wire shape from raw counts. PURE —
// no I/O, no clock, no randomness — so the trust-signal arithmetic and the
// AI-surfacing estimate are table-testable. All rates are fractions in
// [0,1]; division is guarded so a zero-delivery campaign reports 0 rather
// than NaN.
func computeEngagementPanel(in engagementInputs) EngagementPanel {
	p := EngagementPanel{
		CampaignID:                 in.CampaignID,
		ClassificationFilter:       in.Classification.Wire(),
		Delivered:                  in.Delivered,
		ReplyCount:                 in.ReplyCount,
		DistinctReplyers:           in.DistinctReplyers,
		OpenDecoupledConversions:   in.OpenDecoupledConversions,
		TotalAttributedConversions: in.TotalAttributedConversions,
		BotSignaturesApplied:       in.BotSignaturesApplied,
	}

	// Raw open rate (always available).
	if in.Delivered > 0 {
		p.RawOpenRate = ratio(in.RawUniqueOpens, in.Delivered)
	}

	// Human open rate — zeroed when the flag is off so a stale non-zero
	// value can never leak (mitigates the D4 risk).
	humanOpens := in.HumanUniqueOpens
	if !in.HumanEngagementEnabled {
		humanOpens = 0
	}
	p.HumanUniqueOpens = humanOpens
	if in.Delivered > 0 && humanOpens > 0 {
		p.HumanOpenRate = ratio(humanOpens, in.Delivered)
	}

	// Reply rate over unique recipients (matches reply_analytics).
	if in.UniqueRecipients > 0 {
		p.ReplyRate = float64(in.DistinctReplyers) / float64(in.UniqueRecipients)
	}

	// AI-surfacing estimate. Sample = human opens when bot-filtering is
	// on, else the raw uniques (so the SampleSize footnote is honest
	// about what the estimate actually saw).
	sampleOpens := humanOpens
	openRateForScore := p.HumanOpenRate
	if !in.HumanEngagementEnabled {
		sampleOpens = in.RawUniqueOpens
		openRateForScore = p.RawOpenRate
	}
	var hardBounceRate float64
	if in.Delivered > 0 {
		hardBounceRate = ratio(in.HardBounces, in.Delivered)
	}
	var ctor float64
	if sampleOpens > 0 {
		ctor = ratio(in.UniqueClicks, sampleOpens)
	}

	score, confidence, basis := aiSurfacingScore(
		openRateForScore, p.ReplyRate, hardBounceRate, ctor, sampleOpens,
	)
	p.AISurfacingScore = score
	p.AISurfacingConfidenceLevel = confidence
	p.AISurfacingBasis = basis
	p.AISurfacingSampleOpens = sampleOpens
	return p
}

// ratio is a guarded a/b for integer-ish counts, returning 0 when the
// denominator is non-positive.
func ratio[T int | int64](numerator T, denominator int) float64 {
	if denominator <= 0 {
		return 0
	}
	return float64(numerator) / float64(denominator)
}

// ----------------------------------------------------------------------
// Persistence behind interfaces (real pgx impls satisfy the same shape)
// ----------------------------------------------------------------------

// openDecoupledStore returns the open-decoupled conversion counts for one
// campaign: conversions attributed to it (explicit/last_touch) split by
// whether the subscriber has ANY 'opened' event for the campaign. Behind
// an interface so the assembler can be tested with a fake and no Postgres.
type openDecoupledStore interface {
	// OpenDecoupledConversions returns (decoupled, totalAttributed). When
	// the conversions table is absent it returns (0, 0, nil) — the panel
	// renders "No attributed conversions yet" honestly.
	OpenDecoupledConversions(ctx context.Context, tx pgx.Tx, tenantID, campaignID string) (decoupled, totalAttributed int64, err error)
}

// openDecoupledSQL is the anti-join that powers the open-decoupled count.
// Exposed as a package constant so a unit test can assert the decoupling
// predicate survives future refactors (guards against silently dropping
// the NOT EXISTS or the attributed_via filter — either would corrupt the
// metric's meaning). Served by migration 0408's
// conversions_engagement_panel_idx plus the existing
// campaign_report_events (tenant_id, campaign_id, ...) indexes.
const openDecoupledSQL = `
SELECT
  COUNT(*) FILTER (WHERE c.attributed_via IN ('explicit','last_touch')) AS total_attributed,
  COUNT(*) FILTER (
    WHERE c.attributed_via IN ('explicit','last_touch')
      AND NOT EXISTS (
        SELECT 1 FROM campaign_report_events oe
         WHERE oe.tenant_id = $1::uuid
           AND oe.campaign_id = $2::uuid
           AND oe.subscriber_email = c.subscriber_email
           AND oe.event_type = 'opened'
        LIMIT 1
      )
  ) AS open_decoupled
FROM conversions c
WHERE c.tenant_id = $1::uuid AND c.campaign_id = $2::uuid`

// pgOpenDecoupledStore is the real pgx-backed openDecoupledStore.
type pgOpenDecoupledStore struct{}

// OpenDecoupledConversions runs openDecoupledSQL within the caller's tenant
// tx. It first guards the conversions table's existence (same pattern as
// Service.Revenue): a deployment without the conversions table reports
// zeros rather than erroring.
func (pgOpenDecoupledStore) OpenDecoupledConversions(
	ctx context.Context, tx pgx.Tx, tenantID, campaignID string,
) (int64, int64, error) {
	exists, err := tableExists(ctx, tx, "conversions")
	if err != nil {
		return 0, 0, err
	}
	if !exists {
		return 0, 0, nil
	}
	var total, decoupled int64
	if err := tx.QueryRow(ctx, openDecoupledSQL, tenantID, campaignID).
		Scan(&total, &decoupled); err != nil {
		return 0, 0, err
	}
	return decoupled, total, nil
}

// EngagementPanel computes the honest engagement panel for one campaign.
// It opens ONE tenant tx and runs the hard-count queries (raw + human
// opens, reply stats, hard bounces, open-decoupled conversions), then
// hands the counts to the pure computeEngagementPanel assembler. RLS is
// enforced by db.WithTenant regardless of caller configuration.
//
// humanEnabled mirrors Repo.HumanEngagementEnabled (POSTWAVE_HUMAN_ENGAGEMENT);
// when false the bot-stripped human-open path is skipped and the human
// fields are zeroed (D4: the desktop discloses bot-filtering is off and
// falls back to the raw rate). Passed as a parameter rather than read off
// Service so this new file compiles standalone without editing the shared
// Service struct — the integrator's handler passes the flag through.
//
// filter is the F01 classification band (see classification_filter.go). The
// zero value is unset and reproduces this endpoint's historical numbers exactly.
func (s *Service) EngagementPanel(
	ctx context.Context, tenantID, campaignID string, humanEnabled bool, filter ClassificationFilter,
) (EngagementPanel, error) {
	return s.engagementPanel(ctx, tenantID, campaignID, humanEnabled, filter, pgOpenDecoupledStore{})
}

// engagementPanel is the testable seam: the openDecoupledStore is
// injected so the conversion anti-join can be faked. botPatternAndLabels
// is inlined (a Repo wraps the pool) to avoid a cross-struct dependency
// — see the package-level engagementBotPattern helper.
func (s *Service) engagementPanel(
	ctx context.Context, tenantID, campaignID string, humanEnabled bool,
	filter ClassificationFilter, conv openDecoupledStore,
) (EngagementPanel, error) {
	out := EngagementPanel{CampaignID: campaignID, ClassificationFilter: filter.Wire()}

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureOwnedCampaign(ctx, tx, tenantID, campaignID); err != nil {
		return out, fmt.Errorf("engagement campaign ownership: %w", err)
	}

	in := engagementInputs{
		CampaignID:             campaignID,
		Classification:         filter,
		HumanEngagementEnabled: humanEnabled,
	}

	// 1. Hard counts straight from campaign_report_events: delivered,
	//    raw unique opens, unique clicks, hard bounces.
	//
	// The classification band is wrapped in interactionOnly: it constrains the
	// opened/clicked rows and deliberately leaves 'delivered' and 'bounced'
	// alone. Delivered is the denominator of every rate on this panel and
	// carries no classification; filtering it would report a 0% human open rate
	// for a campaign nobody could have failed to read.
	//
	// The hard-bounce filter reads metadata->>'bounce_type'.
	// campaign_report_events has never had a bounce_type COLUMN — the ingester
	// writes the canonical event's bounce type into the metadata envelope — so
	// the previous column reference made this endpoint fail with
	// `column "bounce_type" does not exist` on every single request, for every
	// tenant, regardless of data. See TestEngagementPanelHardBounceReadsMetadata.
	rows, err := tx.Query(ctx, `
SELECT event_type,
       count(*)::int                            AS n,
       count(DISTINCT subscriber_email)::int    AS uniq,
       count(*) FILTER (
         WHERE event_type = 'bounced'
           AND COALESCE(cre.metadata->>'bounce_type','') IN ('hard','5.1.1')
       )::int                                   AS hard_bounces
  FROM campaign_report_events cre
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND event_type IN ('delivered','opened','clicked','bounced')`+
		andWhere(interactionOnly("cre", filter.campaignReportEventExpr("cre")))+`
 GROUP BY event_type`, tenantID, campaignID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var et string
		var n, uniq, hard int
		if err := rows.Scan(&et, &n, &uniq, &hard); err != nil {
			rows.Close()
			return out, err
		}
		switch et {
		case "delivered":
			in.Delivered = n
		case "opened":
			in.RawUniqueOpens = uniq
		case "clicked":
			in.UniqueClicks = uniq
		case "bounced":
			in.HardBounces = hard
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}

	// 2. Bot-stripped human unique opens — only when the flag is on.
	if humanEnabled {
		combined, labels, err := engagementBotPattern(ctx, tx, tenantID)
		if err != nil {
			return out, err
		}
		if combined == "" {
			// No active signatures: human uniques equal raw uniques.
			in.HumanUniqueOpens = in.RawUniqueOpens
		} else {
			var humanUniq int
			if err := tx.QueryRow(ctx, `
SELECT count(DISTINCT subscriber_email)::int
  FROM campaign_report_events cre
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND event_type = 'opened'
   AND COALESCE(user_agent,'') !~ $3`+
				andWhere(filter.campaignReportEventExpr("cre")),
				tenantID, campaignID, combined).Scan(&humanUniq); err != nil {
				return out, err
			}
			in.HumanUniqueOpens = humanUniq
			in.BotSignaturesApplied = labels
		}
	}

	// 3. Reply stats — mirrors reply_analytics.ByCampaign (campaign_replies
	//    count + distinct repliers; unique recipients from subscriber_events).
	//
	// THE UNSET FILTER EMITS NO PREDICATE AT ALL, so this query is
	// byte-identical to the one that shipped and the default reply figure is
	// exactly the number every customer has already exported. That is the same
	// rule the open/click bands obey (classification_filter.go rule 1), and the
	// reply figure is the one place it is easy to break: a human-only DEFAULT
	// would delete every reply stored before the reply classifier existed
	// (classification IS NULL) from every historical report, and the drop would
	// read as an audience that stopped replying rather than as a definition
	// change nobody announced.
	//
	// The human-only figure is still available — it is what
	// ?classification=human returns, stated on the wire in
	// classification_filter, which is the honest way to ship a narrower
	// definition. filter.repliesPredicate() selects among the SHARED
	// internal/replies constants (HumanEngagementPredicate /
	// ExcludedPredicate / UnclassifiedPredicate); this endpoint never writes a
	// sixth copy of "which reply counts as engagement".
	//
	// KNOWN CONSEQUENCE, RECORDED RATHER THAN HIDDEN: ReplyRate feeds
	// AISurfacingScore with weight 0.5, so under the unset filter an
	// out-of-office notice still contributes to that estimate, exactly as it
	// did before this file existed. Narrowing the DEFAULT is a product decision
	// about what an unqualified "reply count" means, and it needs to be made
	// deliberately, announced, and applied to every reply reader at once — not
	// smuggled in as a side effect of adding a filter. Until then the honest
	// figure is one request away and says so on the wire.
	//
	// Proven by TestUnsetReplyCountReproducesTheHistoricalQueryDB.
	replyPredicate := filter.repliesPredicate()
	if err := tx.QueryRow(ctx, `
SELECT count(*)::bigint,
       count(DISTINCT recipient_email)::bigint
  FROM campaign_replies
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`+
		replyPredicate,
		tenantID, campaignID).Scan(&in.ReplyCount, &in.DistinctReplyers); err != nil {
		return out, err
	}
	// Unique recipients is the reply-rate DENOMINATOR and is deliberately not
	// classification-filtered: dividing human replies by human openers would
	// report a reply rate over a population that excludes everyone who never
	// interacted, which is a different and much larger number wearing the same
	// label.
	if err := tx.QueryRow(ctx, `
SELECT count(DISTINCT subscriber_email)::bigint
  FROM subscriber_events
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`,
		tenantID, campaignID).Scan(&in.UniqueRecipients); err != nil {
		return out, err
	}

	// 4. Open-decoupled conversions (behind the interface).
	decoupled, total, err := conv.OpenDecoupledConversions(ctx, tx, tenantID, campaignID)
	if err != nil {
		return out, err
	}
	in.OpenDecoupledConversions = decoupled
	in.TotalAttributedConversions = total

	if err := tx.Commit(ctx); err != nil {
		return out, err
	}
	return computeEngagementPanel(in), nil
}

// engagementBotPattern reads enabled bot_open_signatures (platform +
// tenant) and returns the combined OR'd regex plus the parallel labels.
// Mirrors analytics.go::Repo.botPatternAndLabels but as a package-level
// function so Service can call it without holding a Repo — avoids the
// cross-struct dependency flagged in the spec's risks.
func engagementBotPattern(ctx context.Context, tx pgx.Tx, tenantID string) (string, []string, error) {
	rows, err := tx.Query(ctx, `
SELECT pattern, label
  FROM bot_open_signatures
 WHERE enabled AND (tenant_id IS NULL OR tenant_id = $1::uuid)`, tenantID)
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()
	parts := []string{}
	labels := []string{}
	for rows.Next() {
		var p, l string
		if err := rows.Scan(&p, &l); err != nil {
			continue
		}
		parts = append(parts, "("+p+")")
		labels = append(labels, l)
	}
	if err := rows.Err(); err != nil {
		return "", nil, err
	}
	return joinPatterns(parts), labels, nil
}

// joinPatterns OR-joins regex parts the way the dashboard filter does.
func joinPatterns(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += "|"
		}
		out += p
	}
	return out
}
