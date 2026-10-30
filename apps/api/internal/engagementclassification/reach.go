// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Human-engaged reach floor — a bounded engagement fact a customer can hand
// to a third party without collapsing acceptance, delivery, and attention.
//
// This is the most precision-sensitive definition in the PRD, and the one most
// easily turned into a lie by a well-meaning simplification. Stated exactly:
//
//	floor = unique recipients with at least one human-classified interaction
//	upper = floor + unique recipients with unknown interactions and no human
//
// Three consequences, each of which someone will eventually want to soften:
//
//   - A delivered recipient with NO interaction at all is NOT counted. Absence
//     of evidence is not evidence. This is the rule that makes the headline
//     number a floor rather than an estimate, and it is why the figure will look
//     smaller than an open rate.
//   - A recipient with at least one HUMAN-classified interaction IS counted,
//     even if they also produced machine traffic. Apple prefetching a message a
//     person then read does not un-read it.
//   - The UNKNOWN population is reported as a RANGE and never allocated. Not
//     split proportionally, not assigned to the larger bucket, not quietly
//     dropped. "human-engaged reach floor: 12,400, with up to 3,100 additional
//     unclassified" is the shape; a single confident number is the thing this
//     feature exists to replace.

// ReachReport is the exportable artifact.
//
// Every field a reader needs to challenge the number travels with it. A
// human-engaged floor without its methodology is worthless the first time
// somebody asks how it was derived, and by then the person who could answer has
// moved on.
type ReachReport struct {
	TenantID   string `json:"tenant_id"`
	CampaignID string `json:"campaign_id,omitempty"`

	WindowStart time.Time `json:"window_start"`
	WindowEnd   time.Time `json:"window_end"`

	// Delivered is provider-accepted deliveries in the window.
	Delivered int64 `json:"delivered"`

	// HumanEngagedReachFloor is the FLOOR: recipients with at least one
	// human-classified interaction.
	HumanEngagedReachFloor int64 `json:"human_engaged_reach_floor"`

	// UnknownBand is how many additional recipients MIGHT be human — those whose
	// interactions were all unclassifiable. The honest headline is
	// "HumanEngagedReachFloor, with up to UnknownBand additional unclassified".
	UnknownBand int64 `json:"unknown_band"`

	// MachineOnly is recipients whose every interaction was machine-classified.
	MachineOnly int64 `json:"machine_only"`

	// NoInteraction is delivered recipients who did nothing observable. Reported
	// rather than folded into any other bucket: it is usually the largest group,
	// and hiding it makes the other three look like the whole population.
	NoInteraction int64 `json:"no_interaction"`

	// MachineBySubtype breaks down the machine-only population by agent class.
	MachineBySubtype map[string]int64 `json:"machine_by_subtype"`

	ClassifierVersion  string `json:"classifier_version"`
	MethodologyVersion string `json:"methodology_version"`
	RegistryVersion    string `json:"registry_version"`
	ConfigurationHash  string `json:"configuration_hash"`

	// A report window can contain classifications from more than one immutable
	// configuration. Never label such a report with only the latest version.
	ClassifierVersionCoverage []ClassifierVersionCoverage `json:"classifier_version_coverage"`
	MixedClassifierVersions   bool                        `json:"mixed_classifier_versions"`
	ShadowMode                bool                        `json:"shadow_mode"`

	// Methodology is the statement a third party reads. Generated from the same
	// constants the computation uses, so it cannot drift from what was done.
	Methodology string `json:"methodology"`

	GeneratedAt time.Time `json:"generated_at"`
}

// Headline renders the figure the way the PRD requires it to be said.
//
// A method rather than a formatting concern in the caller: every surface that
// renders this number must render the band with it, and the only reliable way
// to guarantee that is to make the sentence itself the unit of output.
func (r ReachReport) Headline() string {
	if r.UnknownBand == 0 {
		return fmt.Sprintf("human-engaged reach floor: %d", r.HumanEngagedReachFloor)
	}
	return fmt.Sprintf("human-engaged reach floor: %d, with up to %d additional unclassified",
		r.HumanEngagedReachFloor, r.UnknownBand)
}

// ReachQuery bounds a report.
type ReachQuery struct {
	TenantID   string
	CampaignID string
	Since      time.Time
	Until      time.Time
	Now        func() time.Time
}

// HumanEngagedReachFor builds the report.
//
// Classification is resolved PER RECIPIENT, not per event, because the
// definition is about people: one human-classified interaction makes a
// recipient human regardless of how much machine traffic surrounds it. Doing
// this per event would count a person once per open and let a prefetch-heavy
// provider outvote the human who actually read the message.
func (r *Repo) HumanEngagedReachFor(ctx context.Context, query ReachQuery) (*ReachReport, error) {
	tenantID := strings.TrimSpace(query.TenantID)
	if tenantID == "" {
		return nil, fmt.Errorf("%w: tenant required", ErrInvalidInput)
	}
	now := query.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	until := query.Until
	if until.IsZero() {
		until = now().UTC()
	}
	since := query.Since
	if since.IsZero() {
		since = until.AddDate(0, 0, -30)
	}
	if !since.Before(until) {
		return nil, fmt.Errorf("%w: window start must precede window end", ErrInvalidInput)
	}

	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	campaignID := strings.TrimSpace(query.CampaignID)
	if campaignID != "" {
		var exists bool
		if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM campaigns
     WHERE tenant_id = $1::uuid
       AND id = $2::uuid
)`, tenantID, campaignID).Scan(&exists); err != nil {
			return nil, err
		}
		if !exists {
			return nil, fmt.Errorf("%w: campaign is outside the authenticated tenant", ErrCampaignNotFound)
		}
	}

	report := &ReachReport{
		TenantID: tenantID, CampaignID: campaignID,
		WindowStart: since, WindowEnd: until,
		MachineBySubtype:          map[string]int64{},
		ClassifierVersionCoverage: []ClassifierVersionCoverage{},
		// The only production projection is explicitly shadow-only. Keep an
		// empty-interaction report shadow too: no coverage row exists from which
		// applyClassifierVersionCoverage could otherwise recover this fact, and
		// Go's false zero value would incorrectly make the absence of provenance
		// look like a completed cutover.
		ShadowMode:  true,
		GeneratedAt: now().UTC(),
		Methodology: reachMethodology,
	}

	// Deliveries. Seed mailboxes are excluded: no human ever reads one, so
	// counting them would inflate the denominator with a population that is
	// machine by construction.
	if err := tx.QueryRow(ctx, `
SELECT count(DISTINCT subscriber_email)::bigint
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND event_type = 'delivered'
   AND at >= $2 AND at < $3
   AND ($4 = '' OR campaign_id = NULLIF($4, '')::uuid)
   AND NOT COALESCE(is_seed, false)`,
		tenantID, since, until, report.CampaignID).Scan(&report.Delivered); err != nil {
		return nil, err
	}

	// Per-recipient classification. `bool_or` gives the "at least one" semantics
	// the definition needs in one pass; three separate queries could disagree
	// with each other if a reclassification landed between them. The delivered
	// CTE is also a hard population boundary: an interaction whose corresponding
	// delivery is outside this report window cannot make the interaction buckets
	// larger than the delivered denominator.
	rows, err := tx.Query(ctx, `
WITH delivered_recipients AS (
    SELECT DISTINCT subscriber_email
      FROM subscriber_events
     WHERE tenant_id = $1::uuid
       AND event_type = 'delivered'
       AND at >= $2 AND at < $3
       AND ($4 = '' OR campaign_id = NULLIF($4, '')::uuid)
       AND NOT COALESCE(is_seed, false)
)
SELECT c.subscriber_email,
       bool_or(c.classification = 'human')   AS any_human,
       bool_or(c.classification = 'unknown') AS any_unknown,
       COALESCE(min(c.machine_subtype) FILTER (WHERE c.machine_subtype IS NOT NULL), '') AS subtype
  FROM (
    SELECT s.subscriber_email,
           v.classification,
           v.machine_subtype
      FROM subscriber_event_classification_shadow_v1 v
      JOIN subscriber_events s
        ON s.id = v.subscriber_event_id
       AND s.tenant_id = v.tenant_id
       AND s.at = v.subscriber_event_at
	  JOIN delivered_recipients d
	    ON d.subscriber_email = s.subscriber_email
     WHERE v.tenant_id = $1::uuid
       AND v.subscriber_event_at >= $2 AND v.subscriber_event_at < $3
       AND ($4 = '' OR s.campaign_id = NULLIF($4, '')::uuid)
       AND NOT COALESCE(s.is_seed, false)
       AND s.event_type IN ('opened', 'clicked', 'replied')
  ) c
 GROUP BY c.subscriber_email`, tenantID, since, until, report.CampaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var interacted int64
	for rows.Next() {
		var email, subtype string
		var anyHuman, anyUnknown bool
		if err := rows.Scan(&email, &anyHuman, &anyUnknown, &subtype); err != nil {
			return nil, err
		}
		interacted++
		switch {
		case anyHuman:
			// One human interaction is enough. Machine traffic alongside it does
			// not un-read the message.
			report.HumanEngagedReachFloor++
		case anyUnknown:
			// Cannot be settled either way, so it goes in the band and is never
			// allocated to human or machine.
			report.UnknownBand++
		default:
			report.MachineOnly++
			label := subtype
			if label == "" {
				label = "unattributed"
			}
			report.MachineBySubtype[label]++
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Delivered recipients who did nothing observable. Every interaction above
	// is joined to the delivered-recipient CTE, so a negative remainder is an
	// invariant failure, not a value to clamp and conceal in an audit report.
	report.NoInteraction = report.Delivered - interacted
	if report.NoInteraction < 0 {
		return nil, fmt.Errorf("%w: interaction population %d exceeds delivered population %d",
			ErrInvalidInput, interacted, report.Delivered)
	}

	// Version identity, from the same repeatable snapshot as the counts. A
	// latest-row lookup would silently relabel a mixed historical window with
	// whichever classifier happened to run most recently.
	if interacted > 0 {
		versionRows, err := tx.Query(ctx, `
WITH delivered_recipients AS (
    SELECT DISTINCT subscriber_email
      FROM subscriber_events
     WHERE tenant_id = $1::uuid
       AND event_type = 'delivered'
       AND at >= $2 AND at < $3
       AND ($4 = '' OR campaign_id = NULLIF($4, '')::uuid)
       AND NOT COALESCE(is_seed, false)
)
SELECT COALESCE(v.classifier_version, ''),
       COALESCE(v.methodology_version, ''),
       COALESCE(v.registry_version, ''),
       COALESCE(v.configuration_hash, ''),
       v.shadow_mode,
       count(*)::bigint
  FROM subscriber_event_classification_shadow_v1 AS v
  JOIN subscriber_events AS s
    ON s.tenant_id = v.tenant_id
   AND s.id = v.subscriber_event_id
   AND s.at = v.subscriber_event_at
	JOIN delivered_recipients AS d
	  ON d.subscriber_email = s.subscriber_email
 WHERE v.tenant_id = $1::uuid
   AND v.subscriber_event_at >= $2 AND v.subscriber_event_at < $3
   AND ($4 = '' OR s.campaign_id = NULLIF($4, '')::uuid)
   AND NOT COALESCE(s.is_seed, false)
   AND s.event_type IN ('opened', 'clicked', 'replied')
 GROUP BY 1, 2, 3, 4, 5`, tenantID, since, until, report.CampaignID)
		if err != nil {
			return nil, err
		}
		versionCounts := map[classifierVersionCoverageKey]int64{}
		for versionRows.Next() {
			var classifierVersion, methodologyVersion, registryVersion, configurationHash string
			var shadowMode bool
			var count int64
			if err := versionRows.Scan(&classifierVersion, &methodologyVersion,
				&registryVersion, &configurationHash, &shadowMode, &count); err != nil {
				versionRows.Close()
				return nil, err
			}
			addClassifierVersionCoverage(versionCounts, classifierVersion,
				methodologyVersion, registryVersion, configurationHash, shadowMode, count)
		}
		if err := versionRows.Err(); err != nil {
			versionRows.Close()
			return nil, err
		}
		versionRows.Close()
		report.ClassifierVersionCoverage = sortedClassifierVersionCoverage(versionCounts)
		applyClassifierVersionCoverage(report.ClassifierVersionCoverage,
			&report.ClassifierVersion, &report.MethodologyVersion,
			&report.RegistryVersion, &report.ConfigurationHash,
			&report.ShadowMode, &report.MixedClassifierVersions)
	}
	return report, nil
}

// SortedMachineSubtypes returns the breakdown in a stable order.
//
// Map iteration is random in Go, and two reports generated from the same data
// must be byte-identical apart from the timestamp — an acceptance criterion
// that a randomly-ordered map silently breaks.
func (r ReachReport) SortedMachineSubtypes() []string {
	out := make([]string, 0, len(r.MachineBySubtype))
	for key := range r.MachineBySubtype {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

// reachMethodology is the statement that travels with every report.
const reachMethodology = "Human-engaged reach floor counts recipients with at least one " +
	"in-window interaction classified as human by the named classifier version, " +
	"among recipients with an in-window provider-accepted delivery. Recipients " +
	"delivered to but never observed interacting are NOT counted: absence of " +
	"evidence is not evidence, so this figure is a floor rather than an estimate. " +
	"Recipients whose interactions could not be classified either way are reported " +
	"separately as an unclassified band and are never allocated to the human or " +
	"machine totals. Only opened, clicked, and replied events qualify as interactions; " +
	"delivery, bounce, complaint, unsubscribe, lifecycle, and custom events do not. " +
	"Seed mailboxes are excluded throughout, as no human reads one."
