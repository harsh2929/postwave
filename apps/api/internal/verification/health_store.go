// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/replies"
)

// PostgresHealthService folds the existing tenant-owned evidence ledgers into
// the pure resolver and materializes the resulting read model. It never calls
// a verification vendor and cannot change consent or suppression state.
type PostgresHealthService struct {
	Store *Store
	Now   func() time.Time
}

var errStoredHealthVerificationInvalid = errors.New(
	"verification: stored email health verification evidence is outside the canonical contract",
)

func (s *PostgresHealthService) now() time.Time {
	if s != nil && s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *PostgresHealthService) Resolve(ctx context.Context, tenantID string, rawEmails []string) ([]EmailHealth, error) {
	if s == nil || s.Store == nil || s.Store.Pool == nil {
		return nil, errors.New("verification: email health store is unavailable")
	}
	emails, _, err := normalizeHealthEmails(rawEmails)
	if err != nil {
		return nil, fmt.Errorf("verification: invalid email health request: %w", err)
	}
	asOf := s.now()

	inputs := make(map[string]*HealthInput, len(emails))
	durableEvidence := make(map[string]bool, len(emails))
	for _, email := range emails {
		input := &HealthInput{Email: email, AsOf: asOf}
		// Health lookups intentionally accept malformed addresses so the result
		// can explain an F instead of turning a data-quality fact into an HTTP
		// transport error.
		if _, _, ok := splitAddress(email); !ok {
			input.Verification = &Result{
				Email: email, Status: StatusInvalid, SubStatus: SubStatusSyntaxInvalid,
				Provider: ProviderLocal, CheckedAt: asOf,
			}
		}
		inputs[email] = input
	}

	tx, err := db.WithTenant(ctx, s.Store.Pool, tenantID)
	if err != nil {
		return nil, fmt.Errorf("verification: begin email health read: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := loadHealthVerification(ctx, tx, tenantID, emails, asOf, inputs, durableEvidence); err != nil {
		return nil, err
	}
	if err := loadHealthSnapshotVerificationFallback(ctx, tx, tenantID, emails, asOf, inputs, durableEvidence); err != nil {
		return nil, err
	}
	if err := loadHealthConsent(ctx, tx, tenantID, emails, inputs, durableEvidence); err != nil {
		return nil, err
	}
	if err := loadHealthSuppressions(ctx, tx, tenantID, emails, asOf, inputs, durableEvidence); err != nil {
		return nil, err
	}
	if err := loadHealthEvents(ctx, tx, tenantID, emails, asOf, inputs, durableEvidence); err != nil {
		return nil, err
	}
	if err := loadHealthReplies(ctx, tx, tenantID, emails, asOf, inputs, durableEvidence); err != nil {
		return nil, err
	}

	results := make([]EmailHealth, 0, len(emails))
	snapshots := make([]EmailHealth, 0, len(emails))
	for _, email := range emails {
		resolved := ResolveEmailHealth(*inputs[email])
		results = append(results, resolved)
		if durableEvidence[email] {
			snapshots = append(snapshots, resolved)
		}
	}
	// Health is a read-scoped surface, so an arbitrary lookup must not create a
	// 365-day plaintext row. Materialize only addresses that were already backed
	// by tenant-owned durable evidence; pure U and request-synthesized syntax F
	// results remain response-only.
	if err := upsertHealthSnapshots(ctx, tx, tenantID, snapshots); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("verification: commit email health snapshots: %w", err)
	}
	observeVerificationHealth(results)
	return results, nil
}

// loadHealthSnapshotVerificationFallback keeps terminal verification evidence
// visible after the reusable cache TTL expires. A snapshot is not allowed to
// override a live cache row; it only supplies the last persisted verification
// fact for addresses whose cache lookup returned nothing.
func loadHealthSnapshotVerificationFallback(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	emails []string,
	asOf time.Time,
	inputs map[string]*HealthInput,
	durableEvidence map[string]bool,
) error {
	rows, err := tx.Query(ctx, `
SELECT email, verification_status, verification_score,
       COALESCE(verification_provider, ''), verification_checked_at
  FROM email_health_snapshots
 WHERE tenant_id = $1::uuid
   AND email = ANY($2::text[])
   AND verification_status IS NOT NULL
   AND verification_checked_at IS NOT NULL
   AND verification_checked_at > $3`, tenantID, emails,
		asOf.Add(-VerificationEvidenceRetention))
	if err != nil {
		return fmt.Errorf("verification: load health snapshot fallback: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var email, status, provider string
		var score *int
		var checkedAt time.Time
		if err := rows.Scan(&email, &status, &score, &provider, &checkedAt); err != nil {
			return fmt.Errorf("verification: scan health snapshot fallback: %w", err)
		}
		snapshot := &Result{
			Email: email, Status: Status(status), Score: score,
			Provider: provider, CheckedAt: checkedAt.UTC(),
		}
		if err := validatePersistableResult(*snapshot); err != nil {
			// Legacy rows predate the storage constraints. Fail closed with a
			// constant error: never echo the address or forged stored value.
			return errStoredHealthVerificationInvalid
		}
		normalized := NormalizeEmail(email)
		input := inputs[normalized]
		if input == nil {
			continue
		}
		durableEvidence[normalized] = true
		if input.Verification == nil ||
			(terminalHealthVerificationStatus(snapshot.Status) &&
				!terminalHealthVerificationStatus(input.Verification.Status) &&
				!trustedVerificationRetiresTerminalSnapshot(input.Verification, snapshot.CheckedAt)) ||
			(trustedMailboxVerificationProvider(snapshot.Provider) &&
				snapshot.Status == StatusValid &&
				terminalHealthVerificationStatus(input.Verification.Status) &&
				snapshot.CheckedAt.After(input.Verification.CheckedAt)) {
			input.Verification = snapshot
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("verification: iterate health snapshot fallback: %w", err)
	}
	return nil
}

func terminalHealthVerificationStatus(status Status) bool {
	switch status {
	case StatusInvalid, StatusSpamtrap, StatusAbuse, StatusDoNotMail:
		return true
	default:
		return false
	}
}

func trustedVerificationRetiresTerminalSnapshot(current *Result, snapshotAt time.Time) bool {
	return current != nil && current.Status == StatusValid &&
		trustedMailboxVerificationProvider(current.Provider) &&
		!current.CheckedAt.IsZero() && current.CheckedAt.After(snapshotAt)
}

func loadHealthVerification(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	emails []string,
	asOf time.Time,
	inputs map[string]*HealthInput,
	durableEvidence map[string]bool,
) error {
	rows, err := tx.Query(ctx, `
SELECT email, status, sub_status, score, domain, free_email, role_account,
       disposable, mx_found, mx_record, did_you_mean, first_name, last_name,
       gender, country, city, provider, checked_at
  FROM verification_cache
 WHERE tenant_id = $1::uuid
   AND email = ANY($2::text[])
   AND checked_at > $3`, tenantID, emails,
		asOf.Add(-VerificationEvidenceRetention))
	if err != nil {
		return fmt.Errorf("verification: load health verification evidence: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var result Result
		var email, status, subStatus string
		var score *int16
		if err := rows.Scan(
			&email, &status, &subStatus, &score, &result.Domain, &result.FreeEmail,
			&result.RoleAccount, &result.Disposable, &result.MXFound, &result.MXRecord,
			&result.DidYouMean, &result.FirstName, &result.LastName, &result.Gender,
			&result.Country, &result.City, &result.Provider, &result.CheckedAt,
		); err != nil {
			return fmt.Errorf("verification: scan health verification evidence: %w", err)
		}
		email = NormalizeEmail(email)
		result.Email = email
		result.Status = Status(status)
		result.SubStatus = SubStatus(subStatus)
		result.CheckedAt = result.CheckedAt.UTC()
		if score != nil {
			value := int(*score)
			result.Score = &value
		}
		if err := validatePersistableResult(result); err != nil {
			return errStoredHealthVerificationInvalid
		}
		if input := inputs[email]; input != nil {
			durableEvidence[email] = true
			input.Verification = &result
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("verification: iterate health verification evidence: %w", err)
	}
	return nil
}

type healthConsentRow struct {
	ConsentStatus string
	Suppressed    bool
	Subscriber    string
	UpdatedAt     time.Time
}

type healthConsentAddressState struct {
	RecordedAt     time.Time
	SourceTable    string
	IdentityExists bool
}

// loadHealthConsent observes the exact-address terminal consent boundary. The
// address-state table remains visible when a positive subscriber_emails row is
// hidden by its restrictive proof policy; subscriber/consent state without a
// visible row therefore fails closed. Suppression tables also bump this state
// for ETag invalidation, so a suppression-only row with no subscriber identity
// is left to the canonical suppression loader instead of impersonating consent.
func loadHealthConsent(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	emails []string,
	inputs map[string]*HealthInput,
	durableEvidence map[string]bool,
) error {
	known := make(map[string]healthConsentAddressState)
	rows, err := tx.Query(ctx, `
SELECT state.normalized_email, state.last_source_table, state.last_recorded_at,
       public.verification_subscriber_email_identity_exists(
           $1::uuid, state.normalized_email
       )
  FROM subscriber_email_consent_address_state AS state
 WHERE state.tenant_id = $1::uuid
   AND state.normalized_email = ANY($2::text[])`, tenantID, emails)
	if err != nil {
		return fmt.Errorf("verification: load email consent address state: %w", err)
	}
	for rows.Next() {
		var email, sourceTable string
		var at time.Time
		var identityExists bool
		if err := rows.Scan(&email, &sourceTable, &at, &identityExists); err != nil {
			rows.Close()
			return fmt.Errorf("verification: scan email consent address state: %w", err)
		}
		email = NormalizeEmail(email)
		known[email] = healthConsentAddressState{
			RecordedAt: at.UTC(), SourceTable: sourceTable,
			IdentityExists: identityExists,
		}
		durableEvidence[email] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("verification: iterate email consent address state: %w", err)
	}
	rows.Close()

	visible := make(map[string]healthConsentRow)
	rows, err = tx.Query(ctx, `
SELECT lower(address.email::text), address.consent_status, address.suppressed,
       subscriber.status, address.updated_at
  FROM subscriber_emails AS address
  JOIN subscribers AS subscriber
    ON subscriber.tenant_id = address.tenant_id
   AND subscriber.id = address.subscriber_id
 WHERE address.tenant_id = $1::uuid
   AND address.email = ANY($2::citext[])`, tenantID, emails)
	if err != nil {
		return fmt.Errorf("verification: load visible email consent state: %w", err)
	}
	for rows.Next() {
		var email string
		var row healthConsentRow
		if err := rows.Scan(&email, &row.ConsentStatus, &row.Suppressed, &row.Subscriber, &row.UpdatedAt); err != nil {
			rows.Close()
			return fmt.Errorf("verification: scan visible email consent state: %w", err)
		}
		email = NormalizeEmail(email)
		visible[email] = row
		durableEvidence[email] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("verification: iterate visible email consent state: %w", err)
	}
	rows.Close()

	// Legacy-primary fallback catches a non-enabled subscriber even if an old
	// row somehow predates exact-address state generation.
	legacyStatus := make(map[string]healthConsentRow)
	rows, err = tx.Query(ctx, `
SELECT lower(email::text), status, updated_at
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND email = ANY($2::citext[])`, tenantID, emails)
	if err != nil {
		return fmt.Errorf("verification: load subscriber consent fallback: %w", err)
	}
	for rows.Next() {
		var email string
		var row healthConsentRow
		if err := rows.Scan(&email, &row.Subscriber, &row.UpdatedAt); err != nil {
			rows.Close()
			return fmt.Errorf("verification: scan subscriber consent fallback: %w", err)
		}
		email = NormalizeEmail(email)
		legacyStatus[email] = row
		durableEvidence[email] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("verification: iterate subscriber consent fallback: %w", err)
	}
	rows.Close()

	for _, email := range emails {
		input := inputs[email]
		row, isVisible := visible[email]
		state, isKnown := known[email]
		_, hasSubscriber := legacyStatus[email]
		switch {
		case isKnown && !isVisible &&
			(state.IdentityExists || hasSubscriber ||
				!suppressionOnlyHealthConsentSource(state.SourceTable)):
			addHealthHardStop(input, "consent_not_proven", state.RecordedAt)
		case isVisible:
			if row.ConsentStatus != "subscribed" {
				addHealthHardStop(input, "consent_"+safeHealthCode(row.ConsentStatus), row.UpdatedAt)
			}
			if row.Suppressed {
				addHealthHardStop(input, "address_suppressed", row.UpdatedAt)
			}
			if row.Subscriber != "enabled" {
				addHealthHardStop(input, "subscriber_"+safeHealthCode(row.Subscriber), row.UpdatedAt)
			}
		default:
			if legacy, ok := legacyStatus[email]; ok && legacy.Subscriber != "enabled" {
				addHealthHardStop(input, "subscriber_"+safeHealthCode(legacy.Subscriber), legacy.UpdatedAt)
			}
		}
	}
	return nil
}

// Suppression tables participate in the consent generation/ETag mechanism,
// even when the address has never belonged to a subscriber. Their generation
// row alone is not proof of an unclassified consent identity: active state is
// enforced by loadHealthSuppressions, and an expired bounce remains recoverable
// chronology. The tenant-bound identity predicate above distinguishes that
// case from a hidden primary or secondary subscriber address; any subscriber
// identity or non-suppression source still fails closed when its exact address
// projection is not visible/proven.
func suppressionOnlyHealthConsentSource(sourceTable string) bool {
	switch sourceTable {
	case "suppressions", "email_suppressions", "subscriber_suppressions":
		return true
	default:
		return false
	}
}

func loadHealthSuppressions(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	emails []string,
	asOf time.Time,
	inputs map[string]*HealthInput,
	durableEvidence map[string]bool,
) error {
	rows, err := tx.Query(ctx, `
SELECT DISTINCT ON (lower(email), reason)
       lower(email), reason, source, created_at, expires_at
  FROM v_suppressions_unified
 WHERE tenant_id = $1::uuid
   AND lower(email) = ANY($2::text[])
   AND (
       expires_at IS NULL OR expires_at > $3 OR
       (reason IN (
            'soft_bounce', 'soft_bounce_threshold',
            'hard_bounce', 'spamtrap', 'dns_failure',
            'invalid_address', 'invalid_email',
            'blocklist_auto', 'role_address', 'role_account'
        )
        AND created_at >= $3 - interval '30 days')
   )
 ORDER BY lower(email), reason, created_at DESC`, tenantID, emails, asOf)
	if err != nil {
		return fmt.Errorf("verification: load health suppression evidence: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var email, reason, source string
		var createdAt time.Time
		var expiresAt *time.Time
		if err := rows.Scan(&email, &reason, &source, &createdAt, &expiresAt); err != nil {
			return fmt.Errorf("verification: scan health suppression evidence: %w", err)
		}
		email = NormalizeEmail(email)
		input := inputs[email]
		if input == nil {
			continue
		}
		durableEvidence[email] = true
		active := expiresAt == nil || expiresAt.After(asOf)
		code := "suppression_" + safeHealthCode(reason)
		kind := suppressionEvidenceKind(reason)
		if kind != "" {
			addHealthEvidence(input, kind, createdAt, "suppression:"+safeHealthCode(source), code)
		}
		if active {
			addHealthHardStop(input, code, createdAt)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("verification: iterate health suppression evidence: %w", err)
	}
	return nil
}

func suppressionEvidenceKind(reason string) HealthEvidenceKind {
	switch reason {
	case "soft_bounce", "soft_bounce_threshold":
		return HealthEvidenceKind("soft_bounce")
	case "spam_complaint", "complaint":
		return HealthEvidenceKind("complaint")
	case "hard_bounce", "spamtrap", "dns_failure", "invalid_address", "invalid_email":
		return HealthEvidenceKind("hard_bounce")
	case "blocklist_auto", "role_address", "role_account":
		return HealthEvidenceKind("ambiguous_negative")
	default:
		return ""
	}
}

func loadHealthEvents(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	emails []string,
	asOf time.Time,
	inputs map[string]*HealthInput,
	durableEvidence map[string]bool,
) error {
	// `replied` is intentionally excluded here: the generic event ledger does
	// not carry reply classification, so an auto-reply could otherwise earn B.
	// loadHealthReplies reads only campaign_replies.classification=human_reply.
	// Clicks are admitted only through the canonical classification shadow's
	// explicit human signal. Missing, unknown, and machine classifications are
	// not positive evidence; opens remain advisory even when classified human.
	// Historical `unsubscribed` events are also deliberately excluded. Current
	// exact-address consent and canonical suppression state is loaded above;
	// replaying an old event as a live HardStop would make a reviewed re-consent
	// impossible to reflect in this read model.
	rows, err := tx.Query(ctx, `
SELECT lower(event.subscriber_email::text), event.event_type,
       COALESCE(event.bounce_type, ''), max(event.at)
  FROM subscriber_events AS event
  LEFT JOIN subscriber_event_classification_shadow_v1 AS classification
    ON classification.tenant_id = event.tenant_id
   AND classification.subscriber_event_id = event.id
   AND classification.subscriber_event_at = event.at
	 WHERE event.tenant_id = $1::uuid
	   AND event.subscriber_email = ANY($2::citext[])
	   AND event.event_type IN (
	       'opened', 'clicked', 'delivered',
	       'bounced', 'complained'
	   )
	   AND (
	       event.event_type = 'complained' OR
	       (event.event_type = 'bounced' AND
	        event.at >= $3::timestamptz - interval '30 days') OR
	       (event.event_type IN ('opened', 'clicked', 'delivered') AND
	        event.at >= $3::timestamptz - interval '90 days')
	   )
	   AND event.at <= $3::timestamptz + interval '5 minutes'
	   AND (event.event_type <> 'clicked' OR classification.human_signal IS TRUE)
	 GROUP BY lower(event.subscriber_email::text), event.event_type,
	          COALESCE(event.bounce_type, '')`, tenantID, emails, asOf)
	if err != nil {
		return fmt.Errorf("verification: load recipient activity evidence: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var email, eventType, bounceType string
		var at time.Time
		if err := rows.Scan(&email, &eventType, &bounceType, &at); err != nil {
			return fmt.Errorf("verification: scan recipient activity evidence: %w", err)
		}
		email = NormalizeEmail(email)
		input := inputs[email]
		if input == nil {
			continue
		}
		durableEvidence[email] = true
		var kind HealthEvidenceKind
		code := "event_" + safeHealthCode(eventType)
		switch eventType {
		case "opened":
			kind = HealthEvidenceKind("open")
		case "clicked":
			kind = HealthEvidenceKind("click")
			code += "_human"
		case "delivered":
			kind = HealthEvidenceKind("delivered")
		case "complained":
			kind = HealthEvidenceKind("complaint")
		case "bounced":
			switch bounceType {
			case "hard", "spam_trap":
				kind = HealthEvidenceKind("hard_bounce")
				code += "_" + safeHealthCode(bounceType)
			case "soft":
				kind = HealthEvidenceKind("soft_bounce")
				code += "_soft"
			default:
				kind = HealthEvidenceKind("ambiguous_negative")
				code += "_unclassified"
			}
		}
		if kind != "" {
			addHealthEvidence(input, kind, at, "subscriber_events", code)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("verification: iterate recipient activity evidence: %w", err)
	}
	return nil
}

func loadHealthReplies(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	emails []string,
	asOf time.Time,
	inputs map[string]*HealthInput,
	durableEvidence map[string]bool,
) error {
	rows, err := tx.Query(ctx, `
SELECT lower(recipient_email::text), max(received_at)
 FROM campaign_replies
 WHERE tenant_id = $1::uuid
   AND lower(recipient_email::text) = ANY($2::text[])
   AND received_at >= $3::timestamptz - interval '90 days'
   AND received_at <= $3::timestamptz + interval '5 minutes'`+
		// The SHARED predicate, not an inlined copy. The engagement guard's own
		// comment warns that an inlined `classification = 'human_reply'` "would
		// pass a text search and still be a sixth copy of the rule, free to
		// drift" — this was that copy.
		replies.HumanEngagementPredicate+`
 GROUP BY lower(recipient_email::text)`, tenantID, emails, asOf)
	if err != nil {
		return fmt.Errorf("verification: load recipient reply evidence: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var email string
		var at time.Time
		if err := rows.Scan(&email, &at); err != nil {
			return fmt.Errorf("verification: scan recipient reply evidence: %w", err)
		}
		email = NormalizeEmail(email)
		if input := inputs[email]; input != nil {
			durableEvidence[email] = true
			addHealthEvidence(input, HealthEvidenceKind("reply"), at,
				"campaign_replies", "human_reply")
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("verification: iterate recipient reply evidence: %w", err)
	}
	return nil
}

func addHealthEvidence(input *HealthInput, kind HealthEvidenceKind, at time.Time, source, code string) {
	if input == nil {
		return
	}
	input.Evidence = append(input.Evidence, HealthEvidence{
		Kind: kind, At: at.UTC(), Source: source, ReasonCode: code,
	})
}

func addHealthHardStop(input *HealthInput, code string, at time.Time) {
	if input == nil {
		return
	}
	input.HardStop = true
	for _, existing := range input.HardStopReasonCodes {
		if existing == code {
			return
		}
	}
	input.HardStopReasonCodes = append(input.HardStopReasonCodes, code)
	// Hard-stop chronology belongs in the public-safe evidence list even when
	// the domain resolver does not use it to choose a letter grade.
	addHealthEvidence(input, HealthEvidenceHardStop, at,
		"send_eligibility", code)
}

func upsertHealthSnapshots(ctx context.Context, tx pgx.Tx, tenantID string, results []EmailHealth) error {
	if len(results) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, result := range results {
		publicEvidence := result.Evidence
		if publicEvidence == nil {
			publicEvidence = []HealthEvidence{}
		}
		evidence, err := json.Marshal(publicEvidence)
		if err != nil {
			return fmt.Errorf("verification: marshal email health evidence: %w", err)
		}
		var evidenceAt, checkedAt *time.Time
		if result.EvidenceAt != nil {
			value := result.EvidenceAt.UTC()
			evidenceAt = &value
		}
		if result.CheckedAt != nil {
			value := result.CheckedAt.UTC()
			checkedAt = &value
		}
		var status, provider *string
		if result.Status != "" {
			value := string(result.Status)
			status = &value
		}
		if result.Provider != "" {
			value := result.Provider
			provider = &value
		}
		batch.Queue(`
INSERT INTO email_health_snapshots (
    tenant_id, email, grade, recommendation, hard_stop, reason_codes,
    evidence, evidence_at, verification_status, verification_score,
    verification_provider, verification_checked_at, model_version, computed_at
) VALUES (
    $1::uuid, $2, $3, $4, $5, $6::text[],
    $7::jsonb, $8, $9, $10, $11, $12, $13, $14
)
ON CONFLICT (tenant_id, email) DO UPDATE SET
    grade = EXCLUDED.grade,
    recommendation = EXCLUDED.recommendation,
    hard_stop = EXCLUDED.hard_stop,
    reason_codes = EXCLUDED.reason_codes,
    evidence = EXCLUDED.evidence,
    evidence_at = EXCLUDED.evidence_at,
    verification_status = EXCLUDED.verification_status,
    verification_score = EXCLUDED.verification_score,
    verification_provider = EXCLUDED.verification_provider,
    verification_checked_at = EXCLUDED.verification_checked_at,
    model_version = EXCLUDED.model_version,
    computed_at = EXCLUDED.computed_at`,
			tenantID, NormalizeEmail(result.Email), string(result.Grade), string(result.Recommendation),
			result.HardStop, result.ReasonCodes, evidence, evidenceAt, status, result.Score,
			provider, checkedAt, result.ModelVersion, result.ComputedAt.UTC())
	}

	br := tx.SendBatch(ctx, batch)
	for range results {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return fmt.Errorf("verification: upsert email health snapshot: %w", err)
		}
	}
	if err := br.Close(); err != nil {
		return fmt.Errorf("verification: close email health snapshot batch: %w", err)
	}
	return nil
}
