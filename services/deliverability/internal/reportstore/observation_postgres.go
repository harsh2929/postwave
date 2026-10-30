package reportstore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"

	"github.com/postwave/postwave/services/deliverability/internal/seedlist"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist/categorizers"
)

const (
	seedObservationCollectionVersion = "postwave.seed-observation.v1"
	seedObservationRetention         = 30 * 24 * time.Hour
)

var (
	ErrObservationIdentityNotFound = seedlist.ErrObservationIdentityNotFound
	ErrObservationConflict         = errors.New("seed observation idempotency conflict")
)

type observationIdentity struct {
	GatewayIssued         bool
	TenantID              string
	TestID                string
	CampaignID            string
	ContentRevisionID     string
	SendPlanID            string
	ArtifactID            string
	ScenarioID            string
	OutboundMIMEHash      string
	OutboundStructureHash string
	OutboundTextHash      string
	OutboundHTMLHash      string
}

// WriteMessageObservation implements seedlist.MessageObservationSink. It
// resolves the opaque Inbox Reality header without logging/persisting it,
// writes raw bytes to a versioned private SSE-KMS object, and then appends the
// metadata receipt in a tenant-scoped transaction. A failed DB append cleans
// up the newly-created object version.
func (s *PostgresStore) WriteMessageObservation(ctx context.Context, observation seedlist.MessageObservation) (returnErr error) {
	if s == nil || s.Pool == nil {
		return errors.New("postgres reportstore: nil pool")
	}
	identity, err := s.resolveObservationIdentity(ctx, observation)
	if err != nil {
		return err
	}
	prepared, err := s.prepareObservation(observation, identity)
	if err != nil {
		return err
	}

	var objectReceipt ObjectReceipt
	cleanupArmed := false
	if prepared.rawObject != nil {
		if s.ObservationObjects == nil {
			return errors.New("seed observation: encrypted object store is required for captured MIME")
		}
		objectReceipt, err = s.ObservationObjects.PutRawMIME(ctx, *prepared.rawObject)
		if err != nil {
			return err
		}
		prepared.objectRef = objectReceipt.ObjectRef
		prepared.objectVersion = objectReceipt.VersionID
		cleanupArmed = true
		defer func() {
			if returnErr == nil || !cleanupArmed || objectReceipt.ObjectRef == "" {
				return
			}
			cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			defer cancel()
			if cleanupErr := s.ObservationObjects.DeleteRawMIME(cleanupCtx, objectReceipt); cleanupErr != nil {
				returnErr = errors.Join(returnErr, cleanupErr)
			}
		}()
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin seed observation write: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, prepared.identity.TenantID); err != nil {
		return fmt.Errorf("scope seed observation write: %w", err)
	}

	insertedID, err := insertPreparedObservation(ctx, tx, prepared)
	if err != nil {
		return err
	}
	if insertedID == "" {
		same, err := existingObservationMatches(ctx, tx, prepared)
		if err != nil {
			return err
		}
		if !same {
			return ErrObservationConflict
		}
		// A concurrent/retried writer won. Its object receipt is canonical;
		// delete only this newly-created S3 version.
		if objectReceipt.ObjectRef != "" {
			cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			cleanupErr := s.ObservationObjects.DeleteRawMIME(cleanupCtx, objectReceipt)
			cancel()
			cleanupArmed = false
			objectReceipt = ObjectReceipt{}
			prepared.rawObject = nil
			if cleanupErr != nil {
				return cleanupErr
			}
		}
	}
	var gatewayNotification inboxrealitycontract.ObservationReceipt
	notifyGateway := prepared.identity.GatewayIssued && prepared.identity.ArtifactID != "" &&
		prepared.identity.ScenarioID != "" && s.ObservationNotifier != nil
	if notifyGateway {
		// Always project the callback from the canonical committed row. A
		// poller retry after a post-commit callback failure rebuilds prepared
		// with a later wall-clock time; emitting that reconstruction would make
		// the callback claim provenance that differs from the evidence ledger.
		gatewayNotification, err = loadGatewayObservationNotification(ctx, tx,
			prepared.identity.TenantID, prepared.observationKey)
		if err != nil {
			return err
		}
	}
	// Once COMMIT is sent, its outcome can be ambiguous on a broken connection.
	// Never delete the object in that state: a retained orphan is recoverable,
	// while deleting an object referenced by a committed row destroys evidence.
	cleanupArmed = false
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit seed observation write: %w", err)
	}
	if notifyGateway {
		if err := s.ObservationNotifier.NotifyObservation(ctx, gatewayNotification); err != nil {
			// The append-only evidence is already durable. Propagating the
			// callback error prevents cursor advancement, so the poller retries
			// this same idempotent observation and callback.
			return fmt.Errorf("notify Inbox Reality observation: %w", err)
		}
	}
	return nil
}

func loadGatewayObservationNotification(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	observationKey string,
) (inboxrealitycontract.ObservationReceipt, error) {
	var receipt inboxrealitycontract.ObservationReceipt
	var capabilities string
	err := tx.QueryRow(ctx, `
SELECT tenant_id::text, test_id::text, artifact_id::text, scenario_id,
       observation_key, mailbox_id, provider, placement, folder,
       capability_snapshot::text, raw_mime_status,
       COALESCE(raw_mime_sha256, ''),
       COALESCE(received_mime_structure_hash, ''), structure_comparison,
       captured_at
  FROM seed_message_observations
 WHERE tenant_id = $1::uuid AND observation_key = $2
 LIMIT 1`, tenantID, observationKey).Scan(
		&receipt.TenantID, &receipt.TestID, &receipt.ArtifactID,
		&receipt.ScenarioID, &receipt.ObservationKey, &receipt.MailboxID,
		&receipt.Provider, &receipt.Placement, &receipt.Folder, &capabilities,
		&receipt.RawMIMEStatus, &receipt.ReceivedMIMESHA256,
		&receipt.ReceivedStructureSHA256, &receipt.StructureComparison,
		&receipt.CapturedAt,
	)
	if err != nil {
		return inboxrealitycontract.ObservationReceipt{},
			fmt.Errorf("load durable Inbox Reality observation callback: %w", err)
	}
	receipt.CapabilitySnapshot = json.RawMessage(capabilities)
	return receipt, nil
}

type preparedObservation struct {
	identity              observationIdentity
	id                    string
	testTokenHash         string
	observationKey        string
	mailboxID             string
	registryVersionID     any
	provider              string
	folder                string
	labelsJSON            []byte
	placement             string
	capabilitiesJSON      []byte
	uid                   any
	uidValidity           any
	messageIDHash         any
	threadIDHash          any
	receivedAt            any
	checkedAt             time.Time
	rawStatus             string
	rawSource             string
	rawErrorCode          any
	rawHash               any
	rawCapturedBytes      int64
	rawReportedBytes      int64
	rawMaxBytes           int64
	rawTruncated          bool
	objectRef             any
	objectVersion         any
	parserManifestJSON    []byte
	receivedStructureHash any
	receivedTextHash      any
	receivedHTMLHash      any
	structureComparison   string
	textComparison        string
	htmlComparison        string
	comparisonJSON        []byte
	captureMethod         string
	healthState           string
	errorCodesJSON        []byte
	capturedAt            time.Time
	expiresAt             time.Time
	rawObject             *RawMIMEObject
}

func (p preparedObservation) notification() inboxrealitycontract.ObservationReceipt {
	return inboxrealitycontract.ObservationReceipt{
		TenantID: p.identity.TenantID, TestID: p.identity.TestID,
		ArtifactID: p.identity.ArtifactID, ScenarioID: p.identity.ScenarioID,
		ObservationKey: p.observationKey, MailboxID: p.mailboxID,
		Provider: p.provider, Placement: p.placement, Folder: p.folder,
		CapabilitySnapshot: append(json.RawMessage(nil), p.capabilitiesJSON...),
		RawMIMEStatus:      p.rawStatus, ReceivedMIMESHA256: optionalString(p.rawHash),
		ReceivedStructureSHA256: optionalString(p.receivedStructureHash),
		StructureComparison:     p.structureComparison, CapturedAt: p.capturedAt,
	}
}

func optionalString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func (s *PostgresStore) prepareObservation(observation seedlist.MessageObservation, identity observationIdentity) (preparedObservation, error) {
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	capturedAt := now().UTC()
	checkedAt := observation.CheckedAt.UTC()
	if checkedAt.IsZero() {
		checkedAt = capturedAt
	}
	if checkedAt.After(capturedAt.Add(5 * time.Minute)) {
		return preparedObservation{}, errors.New("seed observation: checked_at is in the future")
	}

	mailboxID, err := boundedRequiredText(observation.MailboxID, 200, "mailbox id")
	if err != nil {
		return preparedObservation{}, err
	}
	var registryVersionID any
	if value := strings.TrimSpace(observation.RegistryVersionID); value != "" {
		if _, err := uuid.Parse(value); err != nil {
			return preparedObservation{}, errors.New("seed observation: invalid registry version id")
		}
		registryVersionID = value
	}
	folder, err := boundedRequiredText(observation.Folder, 500, "folder")
	if err != nil {
		return preparedObservation{}, err
	}
	provider := strings.TrimSpace(string(observation.Provider))
	if !validSeedProvider(provider) {
		return preparedObservation{}, errors.New("seed observation: unsupported provider")
	}
	placement := strings.TrimSpace(string(observation.Placement))
	if !validSeedPlacement(placement) {
		return preparedObservation{}, errors.New("seed observation: unsupported placement")
	}
	labelsJSON, err := json.Marshal(normalizeSeedLabels(observation.Labels))
	if err != nil {
		return preparedObservation{}, err
	}
	capabilitiesJSON, err := json.Marshal(observation.Capabilities)
	if err != nil {
		return preparedObservation{}, fmt.Errorf("seed observation: capabilities: %w", err)
	}

	raw := observation.RawMIME
	if raw == nil {
		raw = &categorizers.RawMIMEAcquisition{
			Status:    categorizers.RawMIMEUnavailable,
			Source:    "legacy_connector",
			ErrorCode: "raw_mime_capability_unavailable",
			Manifest:  categorizers.MIMEManifest{Status: categorizers.MIMEParseSkipped},
		}
	} else {
		copy := *raw
		raw = &copy
	}
	if raw.UID == 0 {
		raw.UID = observation.UID
	}
	if raw.UIDValidity == 0 {
		raw.UIDValidity = observation.UIDValidity
	}
	if err := validateRawAcquisition(raw); err != nil {
		return preparedObservation{}, err
	}
	parserManifestJSON, err := json.Marshal(raw.Manifest)
	if err != nil {
		return preparedObservation{}, fmt.Errorf("seed observation: parser manifest: %w", err)
	}

	testToken := strings.TrimSpace(observation.TestHeaderValue)
	if testToken == "" {
		return preparedObservation{}, errors.New("seed observation: test header value is required")
	}
	testTokenHash := digestString(testToken)
	observationKey, err := buildObservationKey(identity, mailboxID, folder, raw, testTokenHash)
	if err != nil {
		return preparedObservation{}, err
	}
	expiresAt := capturedAt.Add(seedObservationRetention)

	prepared := preparedObservation{
		identity:            identity,
		id:                  uuid.NewString(),
		testTokenHash:       testTokenHash,
		observationKey:      observationKey,
		mailboxID:           mailboxID,
		registryVersionID:   registryVersionID,
		provider:            provider,
		folder:              folder,
		labelsJSON:          labelsJSON,
		placement:           placement,
		capabilitiesJSON:    capabilitiesJSON,
		checkedAt:           checkedAt,
		rawStatus:           string(raw.Status),
		rawSource:           strings.TrimSpace(raw.Source),
		rawCapturedBytes:    raw.CapturedBytes,
		rawReportedBytes:    raw.ReportedBytes,
		rawMaxBytes:         raw.MaxBytes,
		rawTruncated:        raw.Truncated,
		parserManifestJSON:  parserManifestJSON,
		structureComparison: compareHashes(identity.OutboundStructureHash, raw.Manifest.StructureSHA256),
		textComparison:      compareHashes(identity.OutboundTextHash, raw.Manifest.TextBodySHA256),
		htmlComparison:      compareHashes(identity.OutboundHTMLHash, raw.Manifest.HTMLBodySHA256),
		captureMethod:       captureMethod(raw.Source),
		healthState:         normalizeHealthState(observation.HealthState),
		capturedAt:          capturedAt,
		expiresAt:           expiresAt,
	}
	prepared.uid, prepared.uidValidity = nullableUIDs(raw.UID, raw.UIDValidity)
	prepared.messageIDHash = nullableDigest(observation.Headers["Message-ID"])
	prepared.threadIDHash = nullableDigest(firstNonEmpty(observation.Headers["X-GM-THRID"], observation.Headers["Thread-ID"]))
	if !observation.ReceivedAt.IsZero() {
		prepared.receivedAt = observation.ReceivedAt.UTC()
	}
	prepared.rawErrorCode = nullableErrorCode(raw.ErrorCode)
	prepared.rawHash = nullableText(raw.SHA256)
	prepared.receivedStructureHash = nullableText(raw.Manifest.StructureSHA256)
	prepared.receivedTextHash = nullableText(raw.Manifest.TextBodySHA256)
	prepared.receivedHTMLHash = nullableText(raw.Manifest.HTMLBodySHA256)

	errorCodes := normalizedErrorCodes(raw.ErrorCode, raw.Manifest.ErrorCode)
	prepared.errorCodesJSON, _ = json.Marshal(errorCodes)
	prepared.comparisonJSON, _ = json.Marshal(map[string]any{
		"version":                  "postwave.seed-structural-comparison.v1",
		"exact_artifact_available": identity.ArtifactID != "",
		"parser_status":            raw.Manifest.Status,
		"received_mime_exact":      raw.Status == categorizers.RawMIMEComplete,
	})

	if raw.Status == categorizers.RawMIMEComplete || raw.Status == categorizers.RawMIMETruncated {
		prepared.rawObject = &RawMIMEObject{
			TenantID: identity.TenantID, ObservationKey: observationKey,
			SHA256: raw.SHA256, Raw: append([]byte(nil), raw.Raw...), ExpiresAt: expiresAt,
		}
	}
	return prepared, nil
}

func (s *PostgresStore) resolveObservationIdentity(ctx context.Context, observation seedlist.MessageObservation) (observationIdentity, error) {
	header := strings.TrimSpace(observation.TestHeaderValue)
	if header == "" {
		return observationIdentity{}, errors.New("seed observation: missing test header")
	}
	if token, ok := opaqueInboxRealityToken(header); ok {
		identity, err := s.resolveInboxRealityToken(ctx, token)
		if err != nil {
			return observationIdentity{}, err
		}
		if err := identity.matchesSupplied(observation); err != nil {
			return observationIdentity{}, err
		}
		return identity, nil
	}

	identity := observationIdentity{
		TenantID: strings.TrimSpace(observation.TenantID), CampaignID: strings.TrimSpace(observation.CampaignID),
		TestID: strings.TrimSpace(observation.TestID), ContentRevisionID: strings.TrimSpace(observation.ContentRevisionID),
		SendPlanID: strings.TrimSpace(observation.SendPlanID), ArtifactID: strings.TrimSpace(observation.ArtifactID),
		ScenarioID: strings.TrimSpace(observation.ScenarioID), OutboundMIMEHash: strings.TrimSpace(observation.OutboundMIMEHash),
		OutboundStructureHash: strings.TrimSpace(observation.OutboundStructureHash),
	}
	if _, err := uuid.Parse(identity.TenantID); err != nil {
		return observationIdentity{}, errors.New("seed observation: tenant id must be a UUID")
	}
	if identity.CampaignID == "" {
		return observationIdentity{}, errors.New("seed observation: campaign id is required for a non-gateway token")
	}
	if _, err := uuid.Parse(identity.CampaignID); err != nil {
		return observationIdentity{}, errors.New("seed observation: campaign id must be a UUID")
	}
	if identity.ArtifactID != "" {
		return s.resolveSuppliedArtifact(ctx, identity)
	}
	return identity, nil
}

func (s *PostgresStore) resolveInboxRealityToken(ctx context.Context, token string) (observationIdentity, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return observationIdentity{}, fmt.Errorf("resolve seed test: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.inbox_reality_resolver', 'true', true)`); err != nil {
		return observationIdentity{}, fmt.Errorf("resolve seed test: scope: %w", err)
	}
	var identity observationIdentity
	err = tx.QueryRow(ctx, `
SELECT t.tenant_id::text, t.id::text,
       COALESCE(t.campaign_id::text, ''), COALESCE(t.content_revision_id::text, ''),
       COALESCE(t.send_plan_id::text, ''), COALESCE(t.artifact_id::text, ''),
       COALESCE(t.scenario_id, ''), COALESCE(t.outbound_mime_hash, ''),
       COALESCE(t.outbound_mime_structure_hash, '')
  FROM inbox_reality_tests t
 WHERE t.header_token = $1
`, token).Scan(
		&identity.TenantID, &identity.TestID, &identity.CampaignID,
		&identity.ContentRevisionID, &identity.SendPlanID, &identity.ArtifactID,
		&identity.ScenarioID, &identity.OutboundMIMEHash, &identity.OutboundStructureHash,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return observationIdentity{}, ErrObservationIdentityNotFound
	}
	if err != nil {
		return observationIdentity{}, fmt.Errorf("resolve seed test: %w", err)
	}
	identity.GatewayIssued = true
	if identity.ArtifactID != "" {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, identity.TenantID); err != nil {
			return observationIdentity{}, fmt.Errorf("resolve seed test artifact: scope: %w", err)
		}
		if err := tx.QueryRow(ctx, `
SELECT text_hash, html_hash
  FROM campaign_render_artifacts
 WHERE tenant_id = $1::uuid AND id = $2::uuid
`, identity.TenantID, identity.ArtifactID).Scan(&identity.OutboundTextHash, &identity.OutboundHTMLHash); err != nil {
			return observationIdentity{}, fmt.Errorf("resolve seed test artifact: %w", err)
		}
	}
	return identity, nil
}

func (s *PostgresStore) resolveSuppliedArtifact(ctx context.Context, identity observationIdentity) (observationIdentity, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return observationIdentity{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, identity.TenantID); err != nil {
		return observationIdentity{}, err
	}
	var resolved observationIdentity
	resolved.TenantID = identity.TenantID
	resolved.TestID = identity.TestID
	err = tx.QueryRow(ctx, `
SELECT a.campaign_id::text, p.content_revision_id::text, a.send_plan_id::text,
       a.id::text, a.scenario_id, a.outbound_mime_hash, a.mime_structure_hash,
       a.text_hash, a.html_hash
  FROM campaign_render_artifacts a
  JOIN campaign_send_plans p ON p.tenant_id = a.tenant_id AND p.id = a.send_plan_id
 WHERE a.tenant_id = $1::uuid AND a.id = $2::uuid
`, identity.TenantID, identity.ArtifactID).Scan(
		&resolved.CampaignID, &resolved.ContentRevisionID, &resolved.SendPlanID,
		&resolved.ArtifactID, &resolved.ScenarioID, &resolved.OutboundMIMEHash,
		&resolved.OutboundStructureHash, &resolved.OutboundTextHash, &resolved.OutboundHTMLHash,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return observationIdentity{}, ErrObservationIdentityNotFound
	}
	if err != nil {
		return observationIdentity{}, err
	}
	if resolved.CampaignID != identity.CampaignID {
		return observationIdentity{}, errors.New("seed observation: supplied artifact belongs to another campaign")
	}
	return resolved, nil
}

func (identity observationIdentity) matchesSupplied(observation seedlist.MessageObservation) error {
	pairs := [][3]string{
		{"tenant_id", strings.TrimSpace(observation.TenantID), identity.TenantID},
		{"campaign_id", strings.TrimSpace(observation.CampaignID), identity.CampaignID},
		{"test_id", strings.TrimSpace(observation.TestID), identity.TestID},
		{"content_revision_id", strings.TrimSpace(observation.ContentRevisionID), identity.ContentRevisionID},
		{"send_plan_id", strings.TrimSpace(observation.SendPlanID), identity.SendPlanID},
		{"artifact_id", strings.TrimSpace(observation.ArtifactID), identity.ArtifactID},
		{"scenario_id", strings.TrimSpace(observation.ScenarioID), identity.ScenarioID},
		{"outbound_mime_hash", strings.TrimSpace(observation.OutboundMIMEHash), identity.OutboundMIMEHash},
		{"outbound_structure_hash", strings.TrimSpace(observation.OutboundStructureHash), identity.OutboundStructureHash},
	}
	for _, pair := range pairs {
		if pair[1] != "" && pair[1] != pair[2] {
			return fmt.Errorf("seed observation: supplied %s does not match gateway test", pair[0])
		}
	}
	return nil
}

func insertPreparedObservation(ctx context.Context, tx pgx.Tx, prepared preparedObservation) (string, error) {
	const query = `
INSERT INTO seed_message_observations (
    id, tenant_id, test_id, campaign_id, content_revision_id, send_plan_id,
    artifact_id, scenario_id, test_token_sha256, observation_key,
    mailbox_id, seed_registry_version_id, provider, folder, labels, placement, capability_snapshot,
    uid, uid_validity, provider_message_id_sha256, provider_thread_id_sha256,
    received_at, checked_at, raw_mime_status, raw_mime_source,
    raw_mime_error_code, raw_mime_sha256, raw_mime_captured_bytes,
    raw_mime_reported_bytes, raw_mime_max_bytes, raw_mime_truncated,
    raw_mime_object_ref, raw_mime_object_version, parser_manifest,
    received_mime_structure_hash, received_text_hash, received_html_hash,
    outbound_mime_hash, outbound_mime_structure_hash, outbound_text_hash,
    outbound_html_hash, structure_comparison, text_comparison, html_comparison,
    comparison_manifest, source_class, capture_method, collection_version,
    health_state, error_codes, captured_at, expires_at
) VALUES (
    @id::uuid, @tenant_id::uuid, @test_id::uuid, @campaign_id::uuid,
    @content_revision_id::uuid, @send_plan_id::uuid, @artifact_id::uuid,
    @scenario_id, @test_token_sha256, @observation_key,
    @mailbox_id, @seed_registry_version_id::uuid, @provider, @folder, @labels::jsonb, @placement,
    @capability_snapshot::jsonb, @uid, @uid_validity,
    @provider_message_id_sha256, @provider_thread_id_sha256,
    @received_at, @checked_at, @raw_mime_status, @raw_mime_source,
    @raw_mime_error_code, @raw_mime_sha256, @raw_mime_captured_bytes,
    @raw_mime_reported_bytes, @raw_mime_max_bytes, @raw_mime_truncated,
    @raw_mime_object_ref, @raw_mime_object_version, @parser_manifest::jsonb,
    @received_mime_structure_hash, @received_text_hash, @received_html_hash,
    @outbound_mime_hash, @outbound_mime_structure_hash, @outbound_text_hash,
    @outbound_html_hash, @structure_comparison, @text_comparison,
    @html_comparison, @comparison_manifest::jsonb, 'controlled_seed',
    @capture_method, @collection_version, @health_state, @error_codes::jsonb,
    @captured_at, @expires_at
)
ON CONFLICT DO NOTHING
RETURNING id::text
`
	args := pgx.NamedArgs{
		"id": prepared.id, "tenant_id": prepared.identity.TenantID,
		"test_id": nullableText(prepared.identity.TestID), "campaign_id": nullableText(prepared.identity.CampaignID),
		"content_revision_id": nullableText(prepared.identity.ContentRevisionID), "send_plan_id": nullableText(prepared.identity.SendPlanID),
		"artifact_id": nullableText(prepared.identity.ArtifactID), "scenario_id": nullableText(prepared.identity.ScenarioID),
		"test_token_sha256": prepared.testTokenHash, "observation_key": prepared.observationKey,
		"mailbox_id": prepared.mailboxID, "seed_registry_version_id": prepared.registryVersionID,
		"provider": prepared.provider, "folder": prepared.folder,
		"labels": string(prepared.labelsJSON), "placement": prepared.placement, "capability_snapshot": string(prepared.capabilitiesJSON),
		"uid": prepared.uid, "uid_validity": prepared.uidValidity,
		"provider_message_id_sha256": prepared.messageIDHash, "provider_thread_id_sha256": prepared.threadIDHash,
		"received_at": prepared.receivedAt, "checked_at": prepared.checkedAt,
		"raw_mime_status": prepared.rawStatus, "raw_mime_source": prepared.rawSource,
		"raw_mime_error_code": prepared.rawErrorCode, "raw_mime_sha256": prepared.rawHash,
		"raw_mime_captured_bytes": prepared.rawCapturedBytes, "raw_mime_reported_bytes": prepared.rawReportedBytes,
		"raw_mime_max_bytes": prepared.rawMaxBytes, "raw_mime_truncated": prepared.rawTruncated,
		"raw_mime_object_ref": prepared.objectRef, "raw_mime_object_version": prepared.objectVersion,
		"parser_manifest":              string(prepared.parserManifestJSON),
		"received_mime_structure_hash": prepared.receivedStructureHash,
		"received_text_hash":           prepared.receivedTextHash, "received_html_hash": prepared.receivedHTMLHash,
		"outbound_mime_hash":           nullableText(prepared.identity.OutboundMIMEHash),
		"outbound_mime_structure_hash": nullableText(prepared.identity.OutboundStructureHash),
		"outbound_text_hash":           nullableText(prepared.identity.OutboundTextHash),
		"outbound_html_hash":           nullableText(prepared.identity.OutboundHTMLHash),
		"structure_comparison":         prepared.structureComparison, "text_comparison": prepared.textComparison,
		"html_comparison": prepared.htmlComparison, "comparison_manifest": string(prepared.comparisonJSON),
		"capture_method": prepared.captureMethod, "collection_version": seedObservationCollectionVersion,
		"health_state": prepared.healthState, "error_codes": string(prepared.errorCodesJSON),
		"captured_at": prepared.capturedAt, "expires_at": prepared.expiresAt,
	}
	var id string
	err := tx.QueryRow(ctx, query, args).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("insert seed observation: %w", err)
	}
	return id, nil
}

func existingObservationMatches(ctx context.Context, tx pgx.Tx, prepared preparedObservation) (bool, error) {
	var key string
	err := tx.QueryRow(ctx, `
SELECT observation_key
  FROM seed_message_observations
 WHERE tenant_id = $1::uuid
   AND (
       observation_key = $2
       OR (
           $3::bigint IS NOT NULL AND mailbox_id = $4 AND folder = $5
           AND uid_validity = $6::bigint AND uid = $3::bigint
           AND collection_version = $7
       )
   )
 LIMIT 1
`, prepared.identity.TenantID, prepared.observationKey, prepared.uid, prepared.mailboxID,
		prepared.folder, prepared.uidValidity, seedObservationCollectionVersion).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read conflicting seed observation: %w", err)
	}
	return key == prepared.observationKey, nil
}

func validateRawAcquisition(raw *categorizers.RawMIMEAcquisition) error {
	if raw == nil {
		return errors.New("seed observation: raw MIME acquisition is nil")
	}
	if strings.TrimSpace(raw.Source) == "" || len(raw.Source) > 80 {
		return errors.New("seed observation: invalid raw MIME source")
	}
	switch raw.Status {
	case categorizers.RawMIMEComplete, categorizers.RawMIMETruncated:
		if len(raw.Raw) == 0 || raw.CapturedBytes != int64(len(raw.Raw)) {
			return errors.New("seed observation: captured MIME byte count mismatch")
		}
		if !validLowerSHA256(strings.TrimSpace(raw.SHA256)) || digestBytes(raw.Raw) != raw.SHA256 {
			return errors.New("seed observation: captured MIME digest mismatch")
		}
		if raw.Status == categorizers.RawMIMEComplete && raw.Truncated {
			return errors.New("seed observation: complete MIME cannot be truncated")
		}
		if raw.Status == categorizers.RawMIMETruncated && !raw.Truncated {
			return errors.New("seed observation: truncated MIME must carry truncated=true")
		}
	case categorizers.RawMIMEFailed, categorizers.RawMIMEUnavailable:
		if len(raw.Raw) != 0 || raw.CapturedBytes != 0 || raw.SHA256 != "" {
			return errors.New("seed observation: failed/unavailable MIME cannot carry bytes or a digest")
		}
	default:
		return errors.New("seed observation: invalid raw MIME status")
	}
	return nil
}

func buildObservationKey(identity observationIdentity, mailboxID, folder string, raw *categorizers.RawMIMEAcquisition, tokenHash string) (string, error) {
	payload, err := json.Marshal(struct {
		Version     string `json:"version"`
		TenantID    string `json:"tenant_id"`
		TestID      string `json:"test_id,omitempty"`
		CampaignID  string `json:"campaign_id,omitempty"`
		TokenHash   string `json:"token_hash"`
		MailboxID   string `json:"mailbox_id"`
		Folder      string `json:"folder"`
		UIDValidity uint32 `json:"uid_validity,omitempty"`
		UID         uint32 `json:"uid,omitempty"`
		MIMEStatus  string `json:"mime_status"`
		MIMESHA256  string `json:"mime_sha256,omitempty"`
		Collection  string `json:"collection"`
	}{
		Version: "postwave.seed-observation-key.v1", TenantID: identity.TenantID,
		TestID: identity.TestID, CampaignID: identity.CampaignID, TokenHash: tokenHash,
		MailboxID: mailboxID, Folder: folder, UIDValidity: raw.UIDValidity, UID: raw.UID,
		MIMEStatus: string(raw.Status), MIMESHA256: raw.SHA256, Collection: seedObservationCollectionVersion,
	})
	if err != nil {
		return "", err
	}
	return digestBytes(payload), nil
}

func opaqueInboxRealityToken(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "irt_") {
		raw = strings.TrimPrefix(raw, "irt_")
	}
	if len(raw) != 32 {
		return "", false
	}
	for _, character := range raw {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') && (character < 'A' || character > 'F') {
			return "", false
		}
	}
	return strings.ToLower(raw), true
}

func nullableUIDs(uid, uidValidity uint32) (any, any) {
	if uid == 0 || uidValidity == 0 {
		return nil, nil
	}
	return int64(uid), int64(uidValidity)
}

func nullableText(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}

func nullableErrorCode(value string) any {
	codes := normalizedErrorCodes(value)
	if len(codes) == 0 {
		return nil
	}
	return codes[0]
}

func nullableDigest(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return digestString(value)
}

func compareHashes(expected, observed string) string {
	expected = strings.TrimSpace(expected)
	observed = strings.TrimSpace(observed)
	if expected == "" || observed == "" {
		return "unavailable"
	}
	if expected == observed {
		return "match"
	}
	return "mismatch"
}

func captureMethod(source string) string {
	switch strings.TrimSpace(source) {
	case "imap_body_peek":
		return "imap.body_peek.v1"
	case "vendor_api":
		return "vendor.normalized-placement.v1"
	case "legacy_connector":
		return "legacy.connector-metadata-only.v1"
	default:
		return "connector." + strings.TrimSpace(source) + ".v1"
	}
}

func normalizeHealthState(status seedlist.Status) string {
	switch status {
	case seedlist.StatusActive, seedlist.StatusFlagged, seedlist.StatusBanned:
		return string(status)
	default:
		return "unknown"
	}
}

func normalizeSeedLabels(labels []string) []string {
	allowed := map[string]struct{}{
		"INBOX": {}, "SPAM": {}, "JUNK": {}, "CATEGORY_PRIMARY": {},
		"CATEGORY_PROMOTIONS": {}, "CATEGORY_UPDATES": {}, "CATEGORY_SOCIAL": {},
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(labels))
	for _, label := range labels {
		label = strings.ToUpper(strings.Trim(strings.TrimSpace(label), `\"`))
		if _, ok := allowed[label]; !ok {
			continue
		}
		if _, exists := seen[label]; exists {
			continue
		}
		seen[label] = struct{}{}
		out = append(out, label)
	}
	sort.Strings(out)
	return out
}

func normalizedErrorCodes(values ...string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || len(value) > 96 {
			continue
		}
		valid := true
		for index, character := range value {
			if index == 0 && (character < 'a' || character > 'z') {
				valid = false
				break
			}
			if index > 0 && !((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '_') {
				valid = false
				break
			}
		}
		if !valid {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func boundedRequiredText(value string, maxBytes int, field string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxBytes || !utf8.ValidString(value) || strings.ContainsAny(value, "\x00\r\n") {
		return "", fmt.Errorf("seed observation: invalid %s", field)
	}
	return value, nil
}

func validSeedProvider(value string) bool {
	switch value {
	case "gmail", "outlook_com", "o365", "icloud", "yahoo", "proton", "gmx", "mailru":
		return true
	default:
		return false
	}
}

func validSeedPlacement(value string) bool {
	switch value {
	case "primary", "promotions", "updates", "social", "spam", "blocked", "missing":
		return true
	default:
		return false
	}
}

func digestString(value string) string { return digestBytes([]byte(value)) }

func digestBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
