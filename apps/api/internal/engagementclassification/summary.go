// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The read side of F01.
//
// Everything upstream of this existed and was correct: the cascade, the nine
// named rules, the data-driven source registry, append-only classifications
// with version lineage, a reclassification worker, and a shadow view built to
// be queried. The view had ZERO non-test readers. A classifier nobody can ask
// is indistinguishable from one that was never built — and F12 (human-engaged
// reach) cannot be built on top of a number nothing returns.
//
// THE UNKNOWN BUCKET IS NOT OPTIONAL HERE. The PRD makes it a product rule with
// engineering consequences: no response may present a human-engagement figure
// without the corresponding unknown count in the same payload. So this type
// carries all three buckets and the classifier version in one struct, and there
// is deliberately no way to construct a partial one — a caller cannot serialise
// the human count while dropping the band that qualifies it.

// ClassificationSummary is the three-bucket answer plus its provenance.
type ClassificationSummary struct {
	// Human, Machine and Unknown always sum to Total. Unknown is never
	// allocated across the other two: it is the honest residue of events the
	// rules could not settle, and hiding it is the exact dishonesty F01 exists
	// to fix.
	Human   int64 `json:"human"`
	Machine int64 `json:"machine"`
	Unknown int64 `json:"unknown"`
	Total   int64 `json:"total"`

	// MachineBySubtype breaks the machine bucket down by agent class, so a
	// reader can tell Apple MPP prefetching from a security gateway fetching
	// every link — different facts with different implications for the sender.
	MachineBySubtype map[string]int64 `json:"machine_by_subtype"`

	// ClassifierVersion and MethodologyVersion travel with every number.
	// A human-engagement figure without the version that produced it cannot be
	// compared to next month's figure, and the PRD requires the version to be
	// available wherever the result is shown.
	ClassifierVersion  string `json:"classifier_version"`
	MethodologyVersion string `json:"methodology_version"`
	RegistryVersion    string `json:"registry_version"`
	ConfigurationHash  string `json:"configuration_hash"`

	// ClassifierVersionCoverage is the authoritative provenance when a window
	// spans multiple configurations or includes interactions that have not yet
	// been classified. The scalar fields above are populated only when one
	// named configuration produced every counted row.
	ClassifierVersionCoverage []ClassifierVersionCoverage `json:"classifier_version_coverage"`
	MixedClassifierVersions   bool                        `json:"mixed_classifier_versions"`

	// ShadowMode reports whether these classifications are advisory. A caller
	// that renders shadow-mode numbers as authoritative is making a claim the
	// deployment has not agreed to, so the flag is part of the payload rather
	// than a deployment detail the reader is assumed to know.
	ShadowMode bool `json:"shadow_mode"`

	// WindowStart and WindowEnd bound what was counted.
	WindowStart time.Time `json:"window_start"`
	WindowEnd   time.Time `json:"window_end"`
}

// SummaryQuery bounds a summary read.
type SummaryQuery struct {
	TenantID   string
	CampaignID string // optional
	Since      time.Time
	Until      time.Time
}

// ClassificationSummaryFor counts classified events in a window.
//
// Reads the shadow view rather than the classification table directly: the view
// owns the definition of "which classification is current". We join its exact
// composite event identity back to subscriber_events only for campaign, seed,
// and event-type eligibility; it never reimplements classification recency.
func (r *Repo) ClassificationSummaryFor(ctx context.Context, query SummaryQuery) (*ClassificationSummary, error) {
	tenantID := strings.TrimSpace(query.TenantID)
	if tenantID == "" {
		return nil, fmt.Errorf("%w: tenant required", ErrInvalidInput)
	}
	until := query.Until
	if until.IsZero() {
		until = time.Now().UTC()
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

	out := &ClassificationSummary{
		MachineBySubtype:          map[string]int64{},
		ClassifierVersionCoverage: []ClassifierVersionCoverage{},
		WindowStart:               since,
		WindowEnd:                 until,
	}
	versionCounts := map[classifierVersionCoverageKey]int64{}

	// One pass, grouped, so the buckets cannot disagree with each other. Three
	// separate COUNT queries would let a concurrent reclassification land
	// between them and produce buckets that do not sum to the total.
	rows, err := tx.Query(ctx, `
SELECT v.classification,
       COALESCE(v.machine_subtype, ''),
       COALESCE(v.classifier_version, ''),
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
 WHERE v.tenant_id = $1::uuid
   AND v.subscriber_event_at >= $2
   AND v.subscriber_event_at < $3
   AND ($4 = '' OR s.campaign_id = NULLIF($4, '')::uuid)
   AND NOT COALESCE(s.is_seed, false)
   AND s.event_type IN ('opened', 'clicked', 'replied')
 GROUP BY 1, 2, 3, 4, 5, 6, 7`, tenantID, since, until,
		strings.TrimSpace(query.CampaignID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var classification, subtype string
		var classifierVersion, methodologyVersion, registryVersion, configurationHash string
		var shadowMode bool
		var count int64
		if err := rows.Scan(
			&classification, &subtype,
			&classifierVersion, &methodologyVersion, &registryVersion,
			&configurationHash, &shadowMode, &count,
		); err != nil {
			return nil, err
		}
		addClassifierVersionCoverage(versionCounts, classifierVersion,
			methodologyVersion, registryVersion, configurationHash, shadowMode, count)
		out.Total += count
		switch Classification(classification) {
		case Human:
			out.Human += count
		case Machine:
			out.Machine += count
			label := subtype
			if label == "" {
				// Machine traffic whose class the registry could not name is
				// still machine traffic. Recording it under an explicit
				// "unattributed" key keeps the subtype breakdown summing to the
				// machine bucket, where dropping it would make the two disagree.
				label = "unattributed"
			}
			out.MachineBySubtype[label] += count
		default:
			out.Unknown += count
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out.ClassifierVersionCoverage = sortedClassifierVersionCoverage(versionCounts)
	applyClassifierVersionCoverage(out.ClassifierVersionCoverage,
		&out.ClassifierVersion, &out.MethodologyVersion, &out.RegistryVersion,
		&out.ConfigurationHash, &out.ShadowMode, &out.MixedClassifierVersions)
	return out, nil
}
