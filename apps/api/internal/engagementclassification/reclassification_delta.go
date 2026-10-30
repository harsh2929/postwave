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

// The READ side of the supersession lineage (F12 delta).
//
// event_classifications is append-only and a reclassification writes a NEW row
// whose supersedes_id points at the verdict it replaces (repository.go's
// insertClassification takes supersedesID; reclassification.go resolves it;
// stage_two.go gives each stage its own methodology version precisely so the
// upgrade or downgrade is an APPEND rather than an in-place overwrite).
//
// Every part of that was built. Nothing read it. A lineage that is written and
// never read is indistinguishable from no lineage at all — it costs storage,
// survives review because the column is populated, and answers no question.
//
// The question it exists to answer is exactly one, and it is the question a
// customer asks the first time their human-engaged reach floor moves:
//
//	"Did my AUDIENCE change, or did your CLASSIFIER change?"
//
// Those have opposite conclusions. If the audience changed, the number is news
// about the customer's list. If the classifier changed, the number is news
// about Moosewave and the customer's list did nothing. The headline figure alone
// cannot distinguish them — it is one integer and both causes move it in the
// same direction.
//
// This read separates them by construction. It recomputes the reach buckets
// TWICE over one fixed population: once at each event's ORIGIN verdict (the
// root of its supersedes_id chain) and once at its CURRENT verdict (the same
// "latest wins" rule subscriber_event_classification_shadow_v1 uses, so the
// after-figure reconciles with HumanEngagedReachFor). The population is
// identical in both passes, so the difference is classifier-attributable and
// nothing else. Any movement in the live number BEYOND ReachFloorDelta is
// audience movement, and that subtraction is the whole product.
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO.
//
//   - It does not treat "two verdicts exist for this event" as a supersession.
//     Two independent ingest-time verdicts under different configuration hashes
//     are two verdicts with no lineage between them; the newer one did not
//     declare that it replaces the older. Counting that as a reclassification
//     would attribute audience-independent noise to the classifier, which is
//     the exact error this read exists to prevent. Such events are counted
//     separately as UnlinkedMultipleVerdictEvents and never enter the delta.
//   - It does not allocate the unknown band. Same rule as the reach report: a
//     recipient who moved from unknown to unknown moved nowhere, and a
//     recipient who moved from unknown to human is reported as that transition
//     rather than folded into a net "reach went up" statement.

// ClassificationTransition is one (origin verdict → current verdict) shape and
// how many events took it. Machine subtype travels with the classification
// because "machine → machine" with a changed subtype is a real, reportable
// reclassification: Apple MPP prefetch and a security gateway are different
// facts about the same recipient.
type ClassificationTransition struct {
	From               string `json:"from"`
	To                 string `json:"to"`
	FromMachineSubtype string `json:"from_machine_subtype,omitempty"`
	ToMachineSubtype   string `json:"to_machine_subtype,omitempty"`

	FromClassifierVersion  string `json:"from_classifier_version,omitempty"`
	FromMethodologyVersion string `json:"from_methodology_version,omitempty"`
	FromRegistryVersion    string `json:"from_registry_version,omitempty"`
	FromConfigurationHash  string `json:"from_configuration_hash,omitempty"`

	ToClassifierVersion  string `json:"to_classifier_version,omitempty"`
	ToMethodologyVersion string `json:"to_methodology_version,omitempty"`
	ToRegistryVersion    string `json:"to_registry_version,omitempty"`
	ToConfigurationHash  string `json:"to_configuration_hash,omitempty"`

	// Changed is false for a RESTATEMENT: a superseding verdict that reached
	// the same classification and subtype under a new methodology identity.
	// Reported rather than filtered, because "the classifier re-examined 40,000
	// events and changed none of them" is the single most reassuring sentence
	// this report can produce and dropping it would make the report look empty.
	Changed bool `json:"changed"`

	Events int64 `json:"events"`
}

// ReclassificationDeltaQuery bounds a delta read. The window selects EVENTS,
// not reclassification runs: the answer must line up with the reach report for
// the same window, and that report is bounded by event time.
type ReclassificationDeltaQuery struct {
	TenantID   string
	CampaignID string
	Since      time.Time
	Until      time.Time
	Now        func() time.Time
}

// ReclassificationDeltaReport is the answer.
type ReclassificationDeltaReport struct {
	TenantID   string `json:"tenant_id"`
	CampaignID string `json:"campaign_id,omitempty"`

	WindowStart time.Time `json:"window_start"`
	WindowEnd   time.Time `json:"window_end"`
	GeneratedAt time.Time `json:"generated_at"`

	// EligibleEvents is every in-window interaction event of a
	// provider-accepted, non-seed recipient — the population held fixed across
	// both passes. ClassifiedEvents is the subset that has any verdict at all.
	EligibleEvents   int64 `json:"eligible_events"`
	ClassifiedEvents int64 `json:"classified_events"`

	// SupersededEvents is events whose current verdict is reached from an
	// earlier verdict through at least one supersedes_id link.
	SupersededEvents int64 `json:"superseded_events"`
	// ChangedEvents is superseded events whose classification or machine
	// subtype actually moved. RestatedEvents is the remainder: re-examined and
	// confirmed.
	ChangedEvents  int64 `json:"changed_events"`
	RestatedEvents int64 `json:"restated_events"`
	// MaxSupersessionDepth is the longest lineage chain walked. 2 is the normal
	// ceiling today (ingest → stage-2 delayed → stage-2 window close).
	MaxSupersessionDepth int `json:"max_supersession_depth"`

	// UnlinkedMultipleVerdictEvents carry verdicts that the CURRENT verdict's
	// supersedes_id chain does not reach. They are excluded from every delta
	// figure: the ledger does not say the later verdict replaced the earlier one,
	// and this report refuses to infer a supersession that was never recorded.
	//
	// The test is chain COVERAGE (verdict_count > depth + 1) rather than "no
	// links at all". An event with a linked pair PLUS a later unlinked verdict
	// has links, but its current verdict supersedes nothing and the earlier
	// reclassification is outside the reported lineage — reporting that as fully
	// explained would be the same lie in a shape one row further along.
	UnlinkedMultipleVerdictEvents int64 `json:"unlinked_multiple_verdict_events"`

	// Transitions covers superseded events only, sorted deterministically.
	Transitions []ClassificationTransition `json:"transitions"`

	// Event-level net movement attributable to reclassification.
	HumanEventDelta   int64 `json:"human_event_delta"`
	MachineEventDelta int64 `json:"machine_event_delta"`
	UnknownEventDelta int64 `json:"unknown_event_delta"`

	// Recipient-level restatement of the F12 buckets over ONE fixed
	// population. After* is computed with the same latest-verdict rule the
	// reach report uses, so ReachFloorAfter reconciles with that report's
	// HumanEngagedReachFloor for the same window.
	RecipientsConsidered int64 `json:"recipients_considered"`

	ReachFloorBefore int64 `json:"reach_floor_before"`
	ReachFloorAfter  int64 `json:"reach_floor_after"`
	ReachFloorDelta  int64 `json:"reach_floor_delta"`

	UnknownBandBefore int64 `json:"unknown_band_before"`
	UnknownBandAfter  int64 `json:"unknown_band_after"`
	UnknownBandDelta  int64 `json:"unknown_band_delta"`

	MachineOnlyBefore int64 `json:"machine_only_before"`
	MachineOnlyAfter  int64 `json:"machine_only_after"`
	MachineOnlyDelta  int64 `json:"machine_only_delta"`

	// ClassifierVersionCoverage is the provenance of the CURRENT verdicts, in
	// the same shape the summary and reach reports use.
	ClassifierVersionCoverage []ClassifierVersionCoverage `json:"classifier_version_coverage"`
	MixedClassifierVersions   bool                        `json:"mixed_classifier_versions"`

	Methodology string `json:"methodology"`
}

// Headline states the delta the way it must be said: attribution first.
func (r ReclassificationDeltaReport) Headline() string {
	if r.SupersededEvents == 0 {
		return "no classifier reclassification in this window: any movement in " +
			"human-engaged reach is audience movement"
	}
	if r.ReachFloorDelta == 0 {
		return fmt.Sprintf("%d events reclassified, %d changed verdict; "+
			"human-engaged reach floor unmoved by the classifier",
			r.SupersededEvents, r.ChangedEvents)
	}
	return fmt.Sprintf("%d events reclassified, %d changed verdict; "+
		"human-engaged reach floor moved %+d recipients because of the "+
		"classifier, not the audience",
		r.SupersededEvents, r.ChangedEvents, r.ReachFloorDelta)
}

// reclassificationLineageCTE resolves, for every eligible in-window event, the
// ORIGIN and CURRENT verdict of its supersedes_id chain.
//
// The recursive member joins ONLY on `prior.id = walk.supersedes_id`. That is
// the whole point and it is load-bearing: an implementation that instead picked
// "the earliest verdict for this event" would manufacture a transition for two
// unlinked verdicts, reporting a reclassification the ledger never recorded.
//
// $1 tenant, $2 since, $3 until, $4 campaign filter (” for all).
const reclassificationLineageCTE = `
WITH RECURSIVE delivered_recipients AS (
    SELECT DISTINCT subscriber_email
      FROM subscriber_events
     WHERE tenant_id = $1::uuid
       AND event_type = 'delivered'
       AND at >= $2 AND at < $3
       AND ($4 = '' OR campaign_id = NULLIF($4, '')::uuid)
       AND NOT COALESCE(is_seed, false)
),
eligible_events AS (
    SELECT s.id, s.at, s.subscriber_email
      FROM subscriber_events AS s
      JOIN delivered_recipients AS d ON d.subscriber_email = s.subscriber_email
     WHERE s.tenant_id = $1::uuid
       AND s.at >= $2 AND s.at < $3
       AND ($4 = '' OR s.campaign_id = NULLIF($4, '')::uuid)
       AND NOT COALESCE(s.is_seed, false)
       AND s.event_type IN ('opened', 'clicked', 'replied')
),
verdicts AS (
    SELECT c.id, c.subscriber_event_id, c.subscriber_event_at,
           c.classification, COALESCE(c.machine_subtype, '') AS machine_subtype,
           c.supersedes_id, c.classified_at,
           c.classifier_version, c.methodology_version,
           c.registry_version, c.configuration_hash, c.shadow_mode
      FROM event_classifications AS c
      JOIN eligible_events AS e
        ON e.id = c.subscriber_event_id AND e.at = c.subscriber_event_at
     WHERE c.tenant_id = $1::uuid
),
verdict_counts AS (
    SELECT subscriber_event_id, subscriber_event_at,
           count(*)::bigint AS verdict_count
      FROM verdicts
     GROUP BY 1, 2
),
current_verdict AS (
    SELECT DISTINCT ON (subscriber_event_id, subscriber_event_at) *
      FROM verdicts
     ORDER BY subscriber_event_id, subscriber_event_at,
              classified_at DESC, id DESC
),
lineage_walk AS (
    SELECT cv.subscriber_event_id, cv.subscriber_event_at,
           cv.id AS verdict_id, cv.supersedes_id, 0 AS depth
      FROM current_verdict AS cv
  UNION ALL
    SELECT walk.subscriber_event_id, walk.subscriber_event_at,
           prior.id, prior.supersedes_id, walk.depth + 1
      FROM lineage_walk AS walk
      JOIN verdicts AS prior ON prior.id = walk.supersedes_id
     WHERE walk.depth < 64
),
origin_verdict AS (
    SELECT DISTINCT ON (subscriber_event_id, subscriber_event_at)
           subscriber_event_id, subscriber_event_at, verdict_id, depth
      FROM lineage_walk
     ORDER BY subscriber_event_id, subscriber_event_at, depth DESC, verdict_id
),
event_delta AS (
    SELECT e.subscriber_email,
           (cv.id IS NOT NULL) AS classified,
           COALESCE(origin.depth, 0) AS depth,
           COALESCE(prior.classification, 'unknown') AS from_classification,
           COALESCE(prior.machine_subtype, '') AS from_machine_subtype,
           COALESCE(prior.classifier_version, '') AS from_classifier_version,
           COALESCE(prior.methodology_version, '') AS from_methodology_version,
           COALESCE(prior.registry_version, '') AS from_registry_version,
           COALESCE(prior.configuration_hash, '') AS from_configuration_hash,
           COALESCE(cv.classification, 'unknown') AS to_classification,
           COALESCE(cv.machine_subtype, '') AS to_machine_subtype,
           COALESCE(cv.classifier_version, '') AS to_classifier_version,
           COALESCE(cv.methodology_version, '') AS to_methodology_version,
           COALESCE(cv.registry_version, '') AS to_registry_version,
           COALESCE(cv.configuration_hash, '') AS to_configuration_hash,
           COALESCE(cv.shadow_mode, true) AS to_shadow_mode,
           COALESCE(counts.verdict_count, 0) AS verdict_count
      FROM eligible_events AS e
      LEFT JOIN current_verdict AS cv
        ON cv.subscriber_event_id = e.id AND cv.subscriber_event_at = e.at
      LEFT JOIN origin_verdict AS origin
        ON origin.subscriber_event_id = e.id AND origin.subscriber_event_at = e.at
      LEFT JOIN verdicts AS prior ON prior.id = origin.verdict_id
      LEFT JOIN verdict_counts AS counts
        ON counts.subscriber_event_id = e.id AND counts.subscriber_event_at = e.at
)
`

const reclassificationTransitionSQL = reclassificationLineageCTE + `
SELECT classified,
       (depth > 0) AS superseded,
       (verdict_count > depth + 1) AS unlinked_multiple,
       from_classification, from_machine_subtype,
       from_classifier_version, from_methodology_version,
       from_registry_version, from_configuration_hash,
       to_classification, to_machine_subtype,
       to_classifier_version, to_methodology_version,
       to_registry_version, to_configuration_hash, to_shadow_mode,
       count(*)::bigint AS events,
       max(depth)::int AS max_depth
  FROM event_delta
 GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16`

const reclassificationRecipientSQL = reclassificationLineageCTE + `
SELECT before_bucket, after_bucket, count(*)::bigint
  FROM (
    SELECT subscriber_email,
           CASE
               WHEN bool_or(from_classification = 'human')   THEN 'human'
               WHEN bool_or(from_classification = 'unknown') THEN 'unknown'
               ELSE 'machine'
           END AS before_bucket,
           CASE
               WHEN bool_or(to_classification = 'human')   THEN 'human'
               WHEN bool_or(to_classification = 'unknown') THEN 'unknown'
               ELSE 'machine'
           END AS after_bucket
      FROM event_delta
     GROUP BY subscriber_email
  ) AS recipient_buckets
 GROUP BY 1, 2`

// ReclassificationDeltaFor builds the delta report.
func (r *Repo) ReclassificationDeltaFor(
	ctx context.Context,
	query ReclassificationDeltaQuery,
) (*ReclassificationDeltaReport, error) {
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

	// RepeatableRead read-only, exactly like the reach report: both passes and
	// the recipient roll-up must observe one snapshot, or a reclassification
	// landing between statements would show up as a delta that never happened.
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

	report := &ReclassificationDeltaReport{
		TenantID: tenantID, CampaignID: campaignID,
		WindowStart: since, WindowEnd: until,
		GeneratedAt:               now().UTC(),
		Transitions:               []ClassificationTransition{},
		ClassifierVersionCoverage: []ClassifierVersionCoverage{},
		Methodology:               reclassificationDeltaMethodology,
	}

	if err := r.readReclassificationTransitions(ctx, tx, report, since, until); err != nil {
		return nil, err
	}
	if err := r.readReclassificationRecipients(ctx, tx, report, since, until); err != nil {
		return nil, err
	}

	// Both passes count the SAME recipients. A mismatch means the two queries
	// disagreed about the population, which would make every delta below
	// meaningless — report it rather than publish a difference of two
	// differently-scoped numbers.
	if before := report.ReachFloorBefore + report.UnknownBandBefore + report.MachineOnlyBefore; before != report.RecipientsConsidered {
		return nil, fmt.Errorf("%w: before-buckets %d do not reconcile with %d recipients",
			ErrInvalidInput, before, report.RecipientsConsidered)
	}
	if after := report.ReachFloorAfter + report.UnknownBandAfter + report.MachineOnlyAfter; after != report.RecipientsConsidered {
		return nil, fmt.Errorf("%w: after-buckets %d do not reconcile with %d recipients",
			ErrInvalidInput, after, report.RecipientsConsidered)
	}
	report.ReachFloorDelta = report.ReachFloorAfter - report.ReachFloorBefore
	report.UnknownBandDelta = report.UnknownBandAfter - report.UnknownBandBefore
	report.MachineOnlyDelta = report.MachineOnlyAfter - report.MachineOnlyBefore
	return report, nil
}

func (r *Repo) readReclassificationTransitions(
	ctx context.Context,
	tx pgx.Tx,
	report *ReclassificationDeltaReport,
	since, until time.Time,
) error {
	rows, err := tx.Query(ctx, reclassificationTransitionSQL,
		report.TenantID, since, until, report.CampaignID)
	if err != nil {
		return err
	}
	defer rows.Close()

	transitions := map[ClassificationTransition]int64{}
	coverage := map[classifierVersionCoverageKey]int64{}
	for rows.Next() {
		var (
			classified, superseded, unlinked, toShadow bool
			transition                                 ClassificationTransition
			events                                     int64
			maxDepth                                   int
		)
		if err := rows.Scan(&classified, &superseded, &unlinked,
			&transition.From, &transition.FromMachineSubtype,
			&transition.FromClassifierVersion, &transition.FromMethodologyVersion,
			&transition.FromRegistryVersion, &transition.FromConfigurationHash,
			&transition.To, &transition.ToMachineSubtype,
			&transition.ToClassifierVersion, &transition.ToMethodologyVersion,
			&transition.ToRegistryVersion, &transition.ToConfigurationHash,
			&toShadow, &events, &maxDepth); err != nil {
			return err
		}
		report.EligibleEvents += events
		if classified {
			report.ClassifiedEvents += events
			addClassifierVersionCoverage(coverage, transition.ToClassifierVersion,
				transition.ToMethodologyVersion, transition.ToRegistryVersion,
				transition.ToConfigurationHash, toShadow, events)
		} else {
			// An interaction with no verdict at all is unclassified provenance,
			// not a shadow-mode classifier decision.
			addClassifierVersionCoverage(coverage, "", "", "", "", false, events)
		}
		if unlinked {
			report.UnlinkedMultipleVerdictEvents += events
		}
		if !superseded {
			continue
		}
		report.SupersededEvents += events
		if maxDepth > report.MaxSupersessionDepth {
			report.MaxSupersessionDepth = maxDepth
		}
		transition.Changed = transition.From != transition.To ||
			transition.FromMachineSubtype != transition.ToMachineSubtype
		if transition.Changed {
			report.ChangedEvents += events
		} else {
			report.RestatedEvents += events
		}
		transitions[transition] += events

		report.HumanEventDelta += classificationBucketDelta(transition, "human") * events
		report.MachineEventDelta += classificationBucketDelta(transition, "machine") * events
		report.UnknownEventDelta += classificationBucketDelta(transition, "unknown") * events
	}
	if err := rows.Err(); err != nil {
		return err
	}

	report.Transitions = sortedClassificationTransitions(transitions)
	report.ClassifierVersionCoverage = sortedClassifierVersionCoverage(coverage)
	report.MixedClassifierVersions = len(report.ClassifierVersionCoverage) > 1
	return nil
}

// classificationBucketDelta is +1 when the transition moved an event INTO the
// bucket, -1 when it moved one out, and 0 when the bucket was unaffected.
func classificationBucketDelta(transition ClassificationTransition, bucket string) int64 {
	switch {
	case transition.To == bucket && transition.From != bucket:
		return 1
	case transition.From == bucket && transition.To != bucket:
		return -1
	default:
		return 0
	}
}

func (r *Repo) readReclassificationRecipients(
	ctx context.Context,
	tx pgx.Tx,
	report *ReclassificationDeltaReport,
	since, until time.Time,
) error {
	rows, err := tx.Query(ctx, reclassificationRecipientSQL,
		report.TenantID, since, until, report.CampaignID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var before, after string
		var recipients int64
		if err := rows.Scan(&before, &after, &recipients); err != nil {
			return err
		}
		report.RecipientsConsidered += recipients
		switch before {
		case "human":
			report.ReachFloorBefore += recipients
		case "unknown":
			report.UnknownBandBefore += recipients
		case "machine":
			report.MachineOnlyBefore += recipients
		default:
			return fmt.Errorf("%w: unknown before-bucket %q", ErrInvalidInput, before)
		}
		switch after {
		case "human":
			report.ReachFloorAfter += recipients
		case "unknown":
			report.UnknownBandAfter += recipients
		case "machine":
			report.MachineOnlyAfter += recipients
		default:
			return fmt.Errorf("%w: unknown after-bucket %q", ErrInvalidInput, after)
		}
	}
	return rows.Err()
}

// sortedClassificationTransitions gives a byte-stable order. Two reports over
// the same data must be identical apart from GeneratedAt, and Go map order is
// random — the same acceptance criterion the reach report's subtype ordering
// exists to satisfy.
func sortedClassificationTransitions(
	counts map[ClassificationTransition]int64,
) []ClassificationTransition {
	out := make([]ClassificationTransition, 0, len(counts))
	for key, events := range counts {
		key.Events = events
		out = append(out, key)
	}
	sort.Slice(out, func(i, j int) bool {
		left, right := out[i], out[j]
		if left.Changed != right.Changed {
			return left.Changed
		}
		for _, pair := range [][2]string{
			{left.From, right.From},
			{left.To, right.To},
			{left.FromMachineSubtype, right.FromMachineSubtype},
			{left.ToMachineSubtype, right.ToMachineSubtype},
			{left.FromClassifierVersion, right.FromClassifierVersion},
			{left.FromMethodologyVersion, right.FromMethodologyVersion},
			{left.FromRegistryVersion, right.FromRegistryVersion},
			{left.FromConfigurationHash, right.FromConfigurationHash},
			{left.ToClassifierVersion, right.ToClassifierVersion},
			{left.ToMethodologyVersion, right.ToMethodologyVersion},
			{left.ToRegistryVersion, right.ToRegistryVersion},
			{left.ToConfigurationHash, right.ToConfigurationHash},
		} {
			if pair[0] != pair[1] {
				return pair[0] < pair[1]
			}
		}
		return left.Events > right.Events
	})
	return out
}

// reclassificationDeltaMethodology travels with every delta, for the same
// reason the reach methodology does: a delta without its derivation is an
// unfalsifiable claim about somebody's numbers.
const reclassificationDeltaMethodology = "Reclassification delta compares each in-window " +
	"interaction event's ORIGIN verdict — the root of its supersedes_id chain — with its " +
	"CURRENT verdict, selected by the same latest-classified rule the human-engaged reach " +
	"report uses. The recipient population is identical in both passes, so every difference " +
	"reported here is attributable to the classifier and not to the audience; movement in the " +
	"live reach figure beyond reach_floor_delta is audience movement. A supersession is counted " +
	"only where the ledger recorded a supersedes_id link: events carrying several unlinked " +
	"verdicts are reported separately and excluded from every delta. Before-figures are not " +
	"a historical snapshot of what the API once returned — they are what the ORIGINAL verdicts " +
	"imply for the same events, which is the only comparison that holds the audience fixed. " +
	"Eligibility, seed exclusion, and the opened/clicked/replied interaction set are identical " +
	"to the human-engaged reach report."
