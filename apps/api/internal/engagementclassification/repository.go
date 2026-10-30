// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type Repo struct {
	Pool                     *db.Pool
	Now                      func() time.Time
	ReclassificationWorkerID string
	ReclassificationLeaseTTL time.Duration
	// StageTwoConversionWindow is when the second delayed re-evaluation is due,
	// measured from the first observed event. Zero means
	// DefaultStageTwoConversionWindow.
	StageTwoConversionWindow time.Duration
}

type RecordReceipt struct {
	ObservationID         string
	ClassificationID      string
	ReclassificationRunID string
	ObservationInserted   bool
	ClassificationAdded   bool
	Result                ClassificationResult
}

func (repo *Repo) now() time.Time {
	if repo != nil && repo.Now != nil {
		return repo.Now().UTC()
	}
	return time.Now().UTC()
}

// Record atomically attaches an immutable observation and its initial shadow
// classification to a canonical event. Production ingesters should prefer
// RecordInTx so the canonical event, raw envelope, and classification share one
// commit boundary.
func (repo *Repo) Record(
	ctx context.Context,
	tenantID string,
	observation ObservationInput,
	aggregate MessageAggregate,
	classifier *Classifier,
) (RecordReceipt, error) {
	if repo == nil || repo.Pool == nil {
		return RecordReceipt{}, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	tx, err := db.WithTenantWorker(ctx, repo.Pool, tenantID)
	if err != nil {
		return RecordReceipt{}, fmt.Errorf("open engagement classifier transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	receipt, err := repo.RecordInTx(ctx, tx, tenantID, observation, aggregate, classifier)
	if err != nil {
		return RecordReceipt{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RecordReceipt{}, fmt.Errorf("commit engagement observation: %w", err)
	}
	return receipt, nil
}

// RecordInTx is the composition hook for provider adapters. The caller must
// have opened a tenant-bound worker transaction; this method refuses to grant
// worker authority and only narrows it to the F01 classifier capability.
func (repo *Repo) RecordInTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	observation ObservationInput,
	aggregate MessageAggregate,
	classifier *Classifier,
) (RecordReceipt, error) {
	if tx == nil || strings.TrimSpace(tenantID) == "" || classifier == nil {
		return RecordReceipt{}, fmt.Errorf("%w: transaction, tenant, and classifier are required", ErrInvalidInput)
	}
	if err := bindClassifierScope(ctx, tx); err != nil {
		return RecordReceipt{}, err
	}
	normalized, err := normalizeObservation(observation, repo.now())
	if err != nil {
		return RecordReceipt{}, err
	}
	if err := bindCanonicalObservation(ctx, tx, tenantID, &normalized); err != nil {
		return RecordReceipt{}, err
	}
	fingerprint, err := observationFingerprint(normalized)
	if err != nil {
		return RecordReceipt{}, err
	}
	if err := ensureMethodology(ctx, tx, classifier.config, classifier.configHash); err != nil {
		return RecordReceipt{}, err
	}

	observationID, inserted, err := insertObservation(ctx, tx, tenantID, normalized, fingerprint)
	if err != nil {
		return RecordReceipt{}, err
	}
	// Arm Stage 2 in the SAME commit that persists the evidence.
	//
	// The verdict written two lines below is made on the evidence that exists
	// right now, which for the first event of a message is one row. Scheduling
	// here — rather than in one provider adapter — is what makes every writer
	// that reaches this chokepoint eligible for re-evaluation, and putting it in
	// this transaction means an observation can never be durable while its
	// re-evaluation was lost.
	if err := scheduleStageTwo(
		ctx, tx, tenantID, normalized, repo.stageTwoConversionWindow(),
	); err != nil {
		return RecordReceipt{}, err
	}
	result, err := classifier.Classify(normalized, aggregate)
	if err != nil {
		return RecordReceipt{}, err
	}
	classificationID, classificationAdded, classificationRunID, err := insertClassification(
		ctx, tx, tenantID, normalized.EventRef, []string{observationID}, result, "", "",
	)
	if err != nil {
		return RecordReceipt{}, err
	}
	return RecordReceipt{
		ObservationID: observationID, ClassificationID: classificationID,
		ReclassificationRunID: classificationRunID,
		ObservationInserted:   inserted, ClassificationAdded: classificationAdded,
		Result: result,
	}, nil
}

func bindClassifierScope(ctx context.Context, tx pgx.Tx) error {
	var worker string
	if err := tx.QueryRow(ctx, `SELECT current_setting('app.outbox_worker', true)`).Scan(&worker); err != nil {
		return fmt.Errorf("inspect engagement classifier worker scope: %w", err)
	}
	if worker != "true" {
		return fmt.Errorf("%w: engagement classifier requires tenant worker scope", ErrInvalidInput)
	}
	if _, err := tx.Exec(ctx, `
SELECT set_config('app.engagement_classifier_worker', 'true', true),
       set_config('app.controlled_seed_evidence_reader', 'true', true)`); err != nil {
		return fmt.Errorf("bind engagement classifier scope: %w", err)
	}
	return nil
}

func bindCanonicalObservation(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	observation *ObservationInput,
) error {
	if observation == nil {
		return fmt.Errorf("%w: observation is required", ErrInvalidInput)
	}
	var campaignID, seedTestID string
	if err := tx.QueryRow(ctx, `
SELECT event_type, COALESCE(campaign_id::text, ''), is_seed,
       COALESCE(controlled_seed_test_id::text, '')
  FROM subscriber_events
 WHERE tenant_id = $1::uuid AND id = $2 AND at = $3`,
		tenantID, observation.ID, observation.At).Scan(
		&observation.EventType, &campaignID, &observation.IsSeed, &seedTestID,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("%w: canonical subscriber event was not found", ErrInvalidInput)
		}
		return fmt.Errorf("load canonical subscriber event: %w", err)
	}
	observation.CampaignID = campaignID
	observation.SeedTestID = seedTestID
	return nil
}

func ensureMethodology(ctx context.Context, tx pgx.Tx, config Config, configHash string) error {
	raw, err := json.Marshal(config)
	if err != nil {
		return fmt.Errorf("marshal classifier methodology: %w", err)
	}
	_, err = tx.Exec(ctx, `
INSERT INTO engagement_classifier_methodology_versions (
    classifier_version, methodology_version, registry_version,
    configuration_hash, rollout_mode, configuration, release_note
) VALUES ($1, $2, $3, $4, 'shadow', $5::jsonb, $6)
ON CONFLICT (
    classifier_version, methodology_version, registry_version, configuration_hash
) DO NOTHING`, config.ClassifierVersion, config.MethodologyVersion,
		config.RegistryVersion, configHash, string(raw),
		"Deterministic F01 methodology; exact configuration is hash-addressed and classifications remain append-only.")
	if err != nil {
		return fmt.Errorf("register classifier methodology: %w", err)
	}
	return nil
}

func insertObservation(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	in ObservationInput,
	fingerprint string,
) (string, bool, error) {
	id := uuid.NewString()
	headersJSON, err := json.Marshal(in.OrderedHeaders)
	if err != nil {
		return "", false, fmt.Errorf("marshal ordered headers: %w", err)
	}
	signalsJSON, err := json.Marshal(in.ProviderSignals)
	if err != nil {
		return "", false, fmt.Errorf("marshal provider signals: %w", err)
	}
	var persistedID string
	err = tx.QueryRow(ctx, `
INSERT INTO subscriber_event_observations (
    id, tenant_id, subscriber_event_id, subscriber_event_at,
    source, source_event_id, idempotency_key, event_schema_version,
    event_type, occurred_at, ingested_at, delivered_at, campaign_id,
    recipient_identity_hmac, recipient_key_id, message_identity_hash,
    link_identity_hash, is_seed, seed_test_id, provider_message_id,
    provider_request_id, ordered_headers, ordered_headers_complete,
    user_agent, ip_address,
    network_asn, network_asn_source, network_region, reverse_dns, tls_ja4,
    provider_signals,
    dwell_milliseconds, message_link_count, body_hash, raw_object_ref,
    raw_object_version_id, privacy_expiry_at, observation_fingerprint
) VALUES (
    $1::uuid, $2::uuid, $3, $4, $5, NULLIF($6, ''), $7, $8,
    $9, $10, $11, $12, NULLIF($13, '')::uuid,
    NULLIF($14, ''), NULLIF($15, ''), NULLIF($16, ''),
    NULLIF($17, ''), $18, NULLIF($19, '')::uuid, NULLIF($20, ''),
    NULLIF($21, ''), $22::jsonb, $23, NULLIF($24, ''), NULLIF($25, '')::inet,
    $26, $27, NULLIF($28, ''), NULLIF($29, ''), NULLIF($30, ''), $31::jsonb,
    $32, $33, NULLIF($34, ''), NULLIF($35, ''), NULLIF($36, ''), $37, $38
)
ON CONFLICT (tenant_id, source, idempotency_key) DO NOTHING
RETURNING id::text`, id, tenantID, in.ID, in.At, in.Source, in.SourceEventID,
		in.IdempotencyKey, in.EventSchemaVersion, in.EventType, in.OccurredAt,
		in.IngestedAt, in.DeliveredAt, in.CampaignID, in.RecipientIdentityHMAC,
		in.RecipientKeyID, in.MessageIdentityHash, in.LinkIdentityHash, in.IsSeed,
		in.SeedTestID, in.ProviderMessageID, in.ProviderRequestID, string(headersJSON),
		in.OrderedHeadersComplete, in.UserAgent, in.IP,
		in.NetworkASN, string(in.NetworkASNSource), in.NetworkRegion, in.ReverseDNS,
		in.TLSJA4, string(signalsJSON), in.DwellMilliseconds, in.MessageLinkCount,
		in.BodyHash, in.RawObjectRef, in.RawObjectVersionID, in.PrivacyExpiryAt,
		fingerprint).Scan(&persistedID)
	if err == nil {
		return persistedID, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", false, fmt.Errorf("insert engagement observation: %w", err)
	}
	var existingFingerprint string
	err = tx.QueryRow(ctx, `
SELECT id::text, observation_fingerprint
  FROM subscriber_event_observations
 WHERE tenant_id = $1::uuid AND source = $2 AND idempotency_key = $3`,
		tenantID, in.Source, in.IdempotencyKey).Scan(&persistedID, &existingFingerprint)
	if err != nil {
		return "", false, fmt.Errorf("read engagement observation replay: %w", err)
	}
	if existingFingerprint != fingerprint {
		return "", false, ErrIdempotencyConflict
	}
	return persistedID, false, nil
}

func insertClassification(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	event EventRef,
	observationIDs []string,
	result ClassificationResult,
	supersedesID string,
	runID string,
) (string, bool, string, error) {
	if err := validateResult(result); err != nil {
		return "", false, "", err
	}
	observationIDs = append([]string(nil), observationIDs...)
	sort.Strings(observationIDs)
	evidenceJSON, err := json.Marshal(result.Rules)
	if err != nil {
		return "", false, "", fmt.Errorf("marshal classification evidence: %w", err)
	}
	conflictsJSON, err := json.Marshal(result.Conflicts)
	if err != nil {
		return "", false, "", fmt.Errorf("marshal classification conflicts: %w", err)
	}
	fingerprint, err := classificationFingerprint(event, observationIDs, result)
	if err != nil {
		return "", false, "", err
	}
	id := uuid.NewString()
	var persistedID string
	err = tx.QueryRow(ctx, `
INSERT INTO event_classifications (
    id, tenant_id, subscriber_event_id, subscriber_event_at,
    classification, machine_subtype, human_confidence, calibration_band,
    stable_reason, rules_fired, evidence, conflicts, observation_ids,
    classifier_version, methodology_version, registry_version,
    configuration_hash, shadow_mode, supersedes_id,
    reclassification_run_id, classification_fingerprint
) VALUES (
    $1::uuid, $2::uuid, $3, $4, $5, NULLIF($6, ''), $7, $8,
    $9, $10::text[], $11::jsonb, $12::jsonb, $13::uuid[],
    $14, $15, $16, $17, $18, NULLIF($19, '')::uuid,
    NULLIF($20, '')::uuid, $21
)
ON CONFLICT (
    tenant_id, subscriber_event_id, subscriber_event_at,
    classifier_version, methodology_version, registry_version, configuration_hash
) DO NOTHING
RETURNING id::text`, id, tenantID, event.ID, event.At, string(result.Classification),
		string(result.MachineSubtype), result.HumanConfidence, result.CalibrationBand,
		result.StableReason, ruleIDs(result.Rules), string(evidenceJSON),
		string(conflictsJSON), observationIDs, result.ClassifierVersion,
		result.MethodologyVersion, result.RegistryVersion, result.ConfigurationHash,
		result.ShadowMode, supersedesID, runID, fingerprint).Scan(&persistedID)
	if err == nil {
		return persistedID, true, runID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", false, "", fmt.Errorf("insert event classification: %w", err)
	}
	var existingFingerprint, existingRunID string
	err = tx.QueryRow(ctx, `
SELECT id::text, classification_fingerprint,
       COALESCE(reclassification_run_id::text, '')
  FROM event_classifications
 WHERE tenant_id = $1::uuid
   AND subscriber_event_id = $2 AND subscriber_event_at = $3
   AND classifier_version = $4 AND methodology_version = $5
   AND registry_version = $6 AND configuration_hash = $7`,
		tenantID, event.ID, event.At, result.ClassifierVersion,
		result.MethodologyVersion, result.RegistryVersion,
		result.ConfigurationHash).Scan(&persistedID, &existingFingerprint, &existingRunID)
	if err != nil {
		return "", false, "", fmt.Errorf("read event classification replay: %w", err)
	}
	if existingFingerprint != fingerprint {
		return "", false, "", fmt.Errorf("%w: classifier identity produced different evidence", ErrIdempotencyConflict)
	}
	return persistedID, false, existingRunID, nil
}

func validateResult(result ClassificationResult) error {
	if !result.Classification.Valid() || !versionPattern.MatchString(result.ClassifierVersion) ||
		!versionPattern.MatchString(result.MethodologyVersion) ||
		!versionPattern.MatchString(result.RegistryVersion) ||
		!hashPattern.MatchString(result.ConfigurationHash) ||
		!rulePattern.MatchString(result.StableReason) || len(result.Rules) == 0 ||
		result.HumanConfidence < 0 || result.HumanConfidence > 1 {
		return fmt.Errorf("%w: invalid classification result", ErrInvalidInput)
	}
	if result.Classification == Machine && !result.MachineSubtype.Valid() {
		return fmt.Errorf("%w: machine result needs subtype", ErrInvalidInput)
	}
	if result.Classification != Machine && result.MachineSubtype != "" {
		return fmt.Errorf("%w: non-machine result cannot carry subtype", ErrInvalidInput)
	}
	for _, rule := range result.Rules {
		if !rulePattern.MatchString(rule.ID) || rule.SignalConfidence < 0 || rule.SignalConfidence > 1 {
			return fmt.Errorf("%w: invalid evidence rule", ErrInvalidInput)
		}
	}
	return nil
}

func classificationFingerprint(event EventRef, observationIDs []string, result ClassificationResult) (string, error) {
	payload := struct {
		Event          EventRef
		ObservationIDs []string
		Result         ClassificationResult
	}{Event: event, ObservationIDs: observationIDs, Result: result}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("fingerprint event classification: %w", err)
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

// LoadRegistry reads one exact immutable registry revision. Regexes and CIDRs
// are compiled by NewClassifier; malformed published data fails closed.
func (repo *Repo) LoadRegistry(ctx context.Context, registryVersion string) ([]RegistryEntry, error) {
	if repo == nil || repo.Pool == nil || !versionPattern.MatchString(registryVersion) {
		return nil, fmt.Errorf("%w: pool and registry version are required", ErrInvalidInput)
	}
	tx, err := db.WithWorkerScope(ctx, repo.Pool)
	if err != nil {
		return nil, fmt.Errorf("open registry worker transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.engagement_classifier_worker', 'true', true)`); err != nil {
		return nil, fmt.Errorf("bind registry reader: %w", err)
	}
	var manifestCount int
	var manifestSchema, manifestFingerprint, provenanceState string
	err = tx.QueryRow(ctx, `
SELECT entry_count, snapshot_schema_version, snapshot_fingerprint,
       provenance_state
  FROM engagement_machine_registry_versions
 WHERE registry_version = $1`, registryVersion).Scan(
		&manifestCount, &manifestSchema, &manifestFingerprint, &provenanceState,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("load machine registry manifest: version %q is not sealed", registryVersion)
	}
	if err != nil {
		return nil, fmt.Errorf("load machine registry manifest: %w", err)
	}
	if provenanceState != "sealed_snapshot" || manifestSchema != RegistrySnapshotSchemaV1 ||
		manifestCount < 1 || !hashPattern.MatchString(manifestFingerprint) {
		return nil, fmt.Errorf("load machine registry manifest: version %q is not an admissible sealed snapshot", registryVersion)
	}
	rows, err := tx.Query(ctx, `
SELECT registry_version, entry_id, matcher_type, matcher_value,
       machine_subtype, confidence::float8, source_note,
       to_char(last_verified, 'YYYY-MM-DD'), entry_fingerprint
  FROM engagement_machine_registry_entries
 WHERE registry_version = $1
 ORDER BY entry_id COLLATE "C"`, registryVersion)
	if err != nil {
		return nil, fmt.Errorf("load machine registry: %w", err)
	}
	defer rows.Close()
	entries := make([]RegistryEntry, 0)
	for rows.Next() {
		var entry RegistryEntry
		var lastVerified string
		if err := rows.Scan(&entry.RegistryVersion, &entry.EntryID,
			&entry.MatcherType, &entry.MatcherValue, &entry.MachineSubtype,
			&entry.Confidence, &entry.SourceNote, &lastVerified,
			&entry.Fingerprint); err != nil {
			return nil, fmt.Errorf("scan machine registry: %w", err)
		}
		entry.LastVerified, err = time.Parse("2006-01-02", lastVerified)
		if err != nil {
			return nil, fmt.Errorf("parse machine registry verification date: %w", err)
		}
		entry, err = entry.validated(registryVersion)
		if err != nil {
			return nil, fmt.Errorf("validate sealed machine registry entry: %w", err)
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate machine registry: %w", err)
	}
	if len(entries) != manifestCount {
		return nil, fmt.Errorf("load machine registry: manifest count %d does not match %d entries", manifestCount, len(entries))
	}
	snapshotFingerprint, err := registrySnapshotFingerprint(registryVersion, entries)
	if err != nil {
		return nil, fmt.Errorf("verify machine registry snapshot: %w", err)
	}
	if snapshotFingerprint != manifestFingerprint {
		return nil, fmt.Errorf("load machine registry: sealed snapshot fingerprint mismatch")
	}
	return entries, nil
}

// PurgeExpiredObservation removes an expired raw envelope through the
// database-owned retention function. The immutable deletion receipt and every
// durable classification remain available after the PII-bearing row is gone.
func (repo *Repo) PurgeExpiredObservation(
	ctx context.Context,
	tenantID, observationID, reasonCode string,
) (bool, error) {
	if repo == nil || repo.Pool == nil || strings.TrimSpace(tenantID) == "" {
		return false, fmt.Errorf("%w: repository and tenant are required", ErrInvalidInput)
	}
	if _, err := uuid.Parse(observationID); err != nil {
		return false, fmt.Errorf("%w: observation id is invalid", ErrInvalidInput)
	}
	tx, err := db.WithTenantWorker(ctx, repo.Pool, tenantID)
	if err != nil {
		return false, fmt.Errorf("open observation retention transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindClassifierScope(ctx, tx); err != nil {
		return false, err
	}
	var objectBacked bool
	err = tx.QueryRow(ctx, `
SELECT raw_object_ref IS NOT NULL
  FROM subscriber_event_observations
 WHERE tenant_id=$1::uuid AND id=$2::uuid
   AND privacy_expiry_at <= clock_timestamp()`, tenantID, observationID).Scan(&objectBacked)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect expired engagement observation: %w", err)
	}
	if objectBacked {
		return false, ErrObjectDeletionRequired
	}
	var deleted bool
	if err := tx.QueryRow(ctx, `
SELECT purge_expired_subscriber_event_observation($1::uuid, $2::uuid, $3)`,
		tenantID, observationID, reasonCode).Scan(&deleted); err != nil {
		return false, fmt.Errorf("purge expired engagement observation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit engagement observation purge: %w", err)
	}
	return deleted, nil
}

// PurgeExpiredObservationBatch deletes only expired inline observations. An
// expired row with raw_object_ref remains intact and is surfaced as blocked;
// the SQL purge independently enforces the same fail-closed invariant.
func (repo *Repo) PurgeExpiredObservationBatch(
	ctx context.Context,
	tenantID string,
	limit int,
) (TenantRetentionResult, error) {
	result := TenantRetentionResult{TenantID: strings.TrimSpace(tenantID)}
	if repo == nil || repo.Pool == nil || result.TenantID == "" || limit < 1 || limit > 1000 {
		return result, fmt.Errorf("%w: invalid observation retention batch", ErrInvalidInput)
	}
	tx, err := db.WithTenantWorker(ctx, repo.Pool, result.TenantID)
	if err != nil {
		return result, fmt.Errorf("open engagement retention batch: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindClassifierScope(ctx, tx); err != nil {
		return result, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text
  FROM subscriber_event_observations
 WHERE tenant_id=$1::uuid
   AND privacy_expiry_at <= clock_timestamp()
   AND raw_object_ref IS NULL
 ORDER BY privacy_expiry_at, id
 LIMIT $2`, result.TenantID, limit)
	if err != nil {
		return result, fmt.Errorf("list expired engagement observations: %w", err)
	}
	ids := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return result, fmt.Errorf("scan expired engagement observation: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return result, fmt.Errorf("iterate expired engagement observations: %w", err)
	}
	rows.Close()
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM subscriber_event_observations
     WHERE tenant_id=$1::uuid
       AND privacy_expiry_at <= clock_timestamp()
       AND raw_object_ref IS NOT NULL
)`, result.TenantID).Scan(&result.ObjectBackedBlocked); err != nil {
		return result, fmt.Errorf("inspect object-backed engagement retention: %w", err)
	}
	for _, observationID := range ids {
		var deleted bool
		if err := tx.QueryRow(ctx, `
SELECT purge_expired_subscriber_event_observation($1::uuid, $2::uuid, 'privacy_expired')`,
			result.TenantID, observationID).Scan(&deleted); err != nil {
			return result, fmt.Errorf("purge expired engagement observation batch member: %w", err)
		}
		if deleted {
			result.Deleted++
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return result, fmt.Errorf("commit engagement observation retention batch: %w", err)
	}
	return result, nil
}

// PublishRegistryEntries publishes one complete immutable version. The first
// write must target an empty version; after that only an exact whole-set replay
// is idempotent. Appending a new rule, omitting a rule, or changing any rule
// requires a new registry version so old calibration cannot authorize new
// behavior under an unchanged provenance/configuration hash.
func (repo *Repo) PublishRegistryEntries(ctx context.Context, entries []RegistryEntry) error {
	if repo == nil || repo.Pool == nil || len(entries) == 0 {
		return fmt.Errorf("%w: pool and registry entries are required", ErrInvalidInput)
	}
	if len(entries) > 4096 {
		return fmt.Errorf("%w: registry publication exceeds 4096 entries", ErrInvalidInput)
	}
	version := strings.ToLower(strings.TrimSpace(entries[0].RegistryVersion))
	validated := make([]RegistryEntry, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, input := range entries {
		// The governed publisher derives fingerprints from the proposed fields;
		// callers cannot supply or preserve a stale row digest as authority.
		input.Fingerprint = ""
		entry, err := input.validated(version)
		if err != nil {
			return err
		}
		if entry.MatcherType == MatchJA4 {
			return fmt.Errorf("%w: matcher %q is not admitted by the persisted registry schema", ErrInvalidInput, MatchJA4)
		}
		fingerprint, err := registryFingerprint(entry)
		if err != nil {
			return err
		}
		entry.Fingerprint = fingerprint
		if _, duplicate := seen[entry.EntryID]; duplicate {
			return fmt.Errorf("%w: duplicate registry entry id %s", ErrInvalidInput, entry.EntryID)
		}
		seen[entry.EntryID] = struct{}{}
		validated = append(validated, entry)
	}
	sort.Slice(validated, func(i, j int) bool {
		return validated[i].EntryID < validated[j].EntryID
	})
	expectedFingerprint, err := registrySnapshotFingerprint(version, validated)
	if err != nil {
		return err
	}
	type publicationEntry struct {
		Confidence     float64 `json:"confidence"`
		EntryID        string  `json:"entry_id"`
		LastVerified   string  `json:"last_verified"`
		MachineSubtype string  `json:"machine_subtype"`
		MatcherType    string  `json:"matcher_type"`
		MatcherValue   string  `json:"matcher_value"`
		SourceNote     string  `json:"source_note"`
	}
	publication := make([]publicationEntry, 0, len(validated))
	for _, entry := range validated {
		publication = append(publication, publicationEntry{
			Confidence: entry.Confidence, EntryID: entry.EntryID,
			LastVerified:   entry.LastVerified.UTC().Format("2006-01-02"),
			MachineSubtype: string(entry.MachineSubtype),
			MatcherType:    string(entry.MatcherType), MatcherValue: entry.MatcherValue,
			SourceNote: entry.SourceNote,
		})
	}
	payload, err := json.Marshal(publication)
	if err != nil {
		return fmt.Errorf("marshal machine registry publication: %w", err)
	}
	tx, err := db.WithWorkerScope(ctx, repo.Pool)
	if err != nil {
		return fmt.Errorf("open registry publication transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var publishedCount int
	var publishedFingerprint string
	err = tx.QueryRow(ctx, `
SELECT published_entry_count, published_snapshot_fingerprint
  FROM public.publish_engagement_machine_registry($1, $2::jsonb)`,
		version, string(payload)).Scan(&publishedCount, &publishedFingerprint)
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) {
			switch postgresError.Code {
			case "PWR01":
				return ErrIdempotencyConflict
			case "22008", "22023", "23514":
				return fmt.Errorf("%w: registry publication rejected: %s", ErrInvalidInput, postgresError.Message)
			}
		}
		return fmt.Errorf("publish machine registry snapshot: %w", err)
	}
	if publishedCount != len(validated) || publishedFingerprint != expectedFingerprint {
		return fmt.Errorf("publish machine registry snapshot: database receipt does not match proposed snapshot")
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit registry publication: %w", err)
	}
	return nil
}

func registrySnapshotFingerprint(registryVersion string, entries []RegistryEntry) (string, error) {
	registryVersion = strings.ToLower(strings.TrimSpace(registryVersion))
	if !versionPattern.MatchString(registryVersion) || len(entries) < 1 || len(entries) > 4096 {
		return "", fmt.Errorf("%w: invalid registry snapshot", ErrInvalidInput)
	}
	type snapshotRow struct {
		entryID     string
		fingerprint string
	}
	rows := make([]snapshotRow, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, input := range entries {
		entry, err := input.validated(registryVersion)
		if err != nil {
			return "", err
		}
		if _, duplicate := seen[entry.EntryID]; duplicate {
			return "", fmt.Errorf("%w: duplicate registry entry id %s", ErrInvalidInput, entry.EntryID)
		}
		seen[entry.EntryID] = struct{}{}
		fingerprint, err := registryFingerprint(entry)
		if err != nil {
			return "", err
		}
		rows = append(rows, snapshotRow{entryID: entry.EntryID, fingerprint: fingerprint})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].entryID < rows[j].entryID })
	joined := make([]string, 0, len(rows))
	for _, row := range rows {
		joined = append(joined, row.entryID+"\x1f"+row.fingerprint)
	}
	preimage := strings.Join([]string{
		RegistrySnapshotSchemaV1,
		registryVersion,
		strconv.Itoa(len(rows)),
		strings.Join(joined, "\x1e"),
	}, "\x1f")
	digest := sha256.Sum256([]byte(preimage))
	return hex.EncodeToString(digest[:]), nil
}

func registryFingerprint(entry RegistryEntry) (string, error) {
	payload := strings.Join([]string{
		entry.RegistryVersion, entry.EntryID, string(entry.MatcherType),
		entry.MatcherValue, string(entry.MachineSubtype),
		strconv.FormatFloat(entry.Confidence, 'f', -1, 64), entry.SourceNote,
		entry.LastVerified.UTC().Format("2006-01-02"),
	}, "\x1f")
	digest := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(digest[:]), nil
}

func optionalIP(value string) any {
	if value == "" {
		return nil
	}
	return net.ParseIP(value).String()
}
