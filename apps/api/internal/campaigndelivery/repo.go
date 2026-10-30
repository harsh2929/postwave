// SPDX-License-Identifier: AGPL-3.0-only

package campaigndelivery

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/campaigntransport"
	"github.com/postwave/postwave/apps/api/internal/db"
)

const maxDeliveryLease = 10 * time.Minute

var deliveryFailureCode = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,95}$`)

type Repo struct{ Pool *db.Pool }

func NewRepo(pool *db.Pool) *Repo { return &Repo{Pool: pool} }

const attemptColumns = `
id::text, tenant_id::text, campaign_id::text, campaign_recipient_id,
send_plan_id::text, artifact_id::text, assurance_run_id::text,
assurance_attempt_count, artifact_set_hash, gate_decision,
COALESCE(gate_override_id::text, ''),
COALESCE(gate_override_ids::text[], ARRAY[]::text[]),
scenario_id, source_hash, plan_hash,
compiler_version, outbound_mime_hash, message_id, attempt_no, idempotency_key,
COALESCE(reply_to, ''), COALESCE(reply_correlation_version, 0),
COALESCE(reply_correlation_key_id, ''), reply_correlation_expires_at,
COALESCE(reply_correlation_token_hash, ''),
request_hash, transport_name, transport_contract_version, capability_snapshot,
state, claim_token::text, COALESCE(lease_owner, ''), lease_expires_at,
COALESCE(provider_message_id, ''), COALESCE(receipt_hash, ''),
COALESCE(idempotency_mode, ''), COALESCE(failure_disposition, ''),
COALESCE(failure_code, ''), created_at, dispatch_started_at, accepted_at,
rejected_at, indeterminate_at, provider_reconciled_at,
COALESCE(reconciliation_source, ''), updated_at`

func scanAttempt(row pgx.Row) (Attempt, error) {
	var attempt Attempt
	var representativeOverrideID string
	err := row.Scan(
		&attempt.ID, &attempt.TenantID, &attempt.CampaignID,
		&attempt.CampaignRecipientID, &attempt.SendPlanID, &attempt.ArtifactID,
		&attempt.AssuranceRunID, &attempt.AssuranceAttemptCount,
		&attempt.ArtifactSetHash, &attempt.GateDecision, &representativeOverrideID,
		&attempt.GateOverrideIDs,
		&attempt.ScenarioID, &attempt.SourceHash, &attempt.PlanHash,
		&attempt.CompilerVersion, &attempt.OutboundMIMEHash, &attempt.MessageID,
		&attempt.AttemptNo, &attempt.IdempotencyKey,
		&attempt.ReplyTo, &attempt.ReplyCorrelationVersion,
		&attempt.ReplyCorrelationKeyID, &attempt.ReplyCorrelationExpiresAt,
		&attempt.ReplyCorrelationTokenHash, &attempt.RequestHash,
		&attempt.TransportName, &attempt.TransportContract,
		&attempt.CapabilitySnapshot, &attempt.State, &attempt.ClaimToken,
		&attempt.LeaseOwner, &attempt.LeaseExpiresAt, &attempt.ProviderMessageID,
		&attempt.ReceiptHash, &attempt.IdempotencyMode,
		&attempt.FailureDisposition, &attempt.FailureCode, &attempt.CreatedAt,
		&attempt.DispatchStartedAt, &attempt.AcceptedAt, &attempt.RejectedAt,
		&attempt.IndeterminateAt, &attempt.ProviderReconciledAt,
		&attempt.ReconciliationSource, &attempt.UpdatedAt,
	)
	if err != nil {
		return Attempt{}, err
	}
	attempt.DeliveryID = attempt.ID
	if (attempt.GateDecision == GateOverridden &&
		(len(attempt.GateOverrideIDs) == 0 || representativeOverrideID != attempt.GateOverrideIDs[0])) ||
		(attempt.GateDecision != GateOverridden &&
			(representativeOverrideID != "" || len(attempt.GateOverrideIDs) != 0)) {
		return Attempt{}, fmt.Errorf("%w: durable override-set shape is invalid", ErrIntegrityMismatch)
	}
	attempt.GateOverrideIDs = append([]string(nil), attempt.GateOverrideIDs...)
	attempt.CapabilitySnapshot = append(json.RawMessage(nil), attempt.CapabilitySnapshot...)
	return attempt, nil
}

type deliveryRequestHash struct {
	DeliveryID                string          `json:"delivery_id"`
	TenantID                  string          `json:"tenant_id"`
	CampaignID                string          `json:"campaign_id"`
	CampaignRecipientID       int64           `json:"campaign_recipient_id"`
	SendPlanID                string          `json:"send_plan_id"`
	ArtifactID                string          `json:"artifact_id"`
	AssuranceRunID            string          `json:"assurance_run_id"`
	AssuranceAttemptCount     int             `json:"assurance_attempt_count"`
	ArtifactSetHash           string          `json:"artifact_set_hash"`
	GateDecision              string          `json:"gate_decision"`
	GateOverrideIDs           []string        `json:"gate_override_ids,omitempty"`
	ScenarioID                string          `json:"scenario_id"`
	SourceHash                string          `json:"source_hash"`
	PlanHash                  string          `json:"plan_hash"`
	CompilerVersion           string          `json:"compiler_version"`
	OutboundMIMEHash          string          `json:"outbound_mime_hash"`
	MessageID                 string          `json:"message_id"`
	ReplyTo                   string          `json:"reply_to"`
	ReplyCorrelationVersion   int             `json:"reply_correlation_version"`
	ReplyCorrelationKeyID     string          `json:"reply_correlation_key_id"`
	ReplyCorrelationExpiresAt time.Time       `json:"reply_correlation_expires_at"`
	ReplyCorrelationTokenHash string          `json:"reply_correlation_token_hash"`
	IdempotencyKey            string          `json:"idempotency_key"`
	TransportName             string          `json:"transport_name"`
	TransportContract         string          `json:"transport_contract_version"`
	CapabilitySnapshot        json.RawMessage `json:"capability_snapshot"`
}

func normalizeDeliveryAttempt(input AttemptInput) (AttemptInput, string, error) {
	if err := validateAttemptInput(input); err != nil {
		return AttemptInput{}, "", err
	}
	// UUID spelling is normalized before hashing and SQL. Permissive spellings
	// such as URNs or braces must not create a second idempotency identity.
	identities := []*string{
		&input.DeliveryID, &input.TenantID, &input.CampaignID, &input.SendPlanID,
		&input.ArtifactID, &input.AssuranceRunID,
	}
	for _, identity := range identities {
		parsed, err := uuid.Parse(strings.TrimSpace(*identity))
		if err != nil {
			return AttemptInput{}, "", fmt.Errorf("%w: invalid UUID identity", ErrInvalidInput)
		}
		*identity = parsed.String()
	}
	normalizedOverrideIDs := make([]string, len(input.GateOverrideIDs))
	seenOverrideIDs := make(map[string]struct{}, len(input.GateOverrideIDs))
	for index, value := range input.GateOverrideIDs {
		parsed, err := uuid.Parse(strings.TrimSpace(value))
		if err != nil {
			return AttemptInput{}, "", fmt.Errorf("%w: invalid gate override UUID", ErrInvalidInput)
		}
		canonical := parsed.String()
		if _, duplicate := seenOverrideIDs[canonical]; duplicate {
			return AttemptInput{}, "", fmt.Errorf("%w: duplicate gate override UUID", ErrInvalidInput)
		}
		seenOverrideIDs[canonical] = struct{}{}
		normalizedOverrideIDs[index] = canonical
	}
	sort.Strings(normalizedOverrideIDs)
	input.GateOverrideIDs = normalizedOverrideIDs
	input.ScenarioID = strings.TrimSpace(input.ScenarioID)
	input.CompilerVersion = strings.TrimSpace(input.CompilerVersion)
	input.MessageID = strings.TrimSpace(input.MessageID)
	input.ReplyTo = strings.ToLower(strings.TrimSpace(input.ReplyTo))
	parsedReplyTo, err := mail.ParseAddress(input.ReplyTo)
	if err != nil || parsedReplyTo == nil || parsedReplyTo.Address != input.ReplyTo {
		return AttemptInput{}, "", fmt.Errorf("%w: reply_to must be one lowercase bare mailbox", ErrInvalidInput)
	}
	input.ReplyCorrelationKeyID = strings.TrimSpace(input.ReplyCorrelationKeyID)
	input.ReplyCorrelationTokenHash = strings.ToLower(strings.TrimSpace(input.ReplyCorrelationTokenHash))
	if input.ReplyCorrelationExpiresAt == nil || input.ReplyCorrelationExpiresAt.IsZero() {
		return AttemptInput{}, "", fmt.Errorf("%w: reply correlation expiry is required", ErrInvalidInput)
	}
	expiresAt := input.ReplyCorrelationExpiresAt.UTC().Truncate(time.Second)
	if !expiresAt.Equal(input.ReplyCorrelationExpiresAt.UTC()) {
		return AttemptInput{}, "", fmt.Errorf("%w: reply correlation expiry must use whole seconds", ErrInvalidInput)
	}
	input.ReplyCorrelationExpiresAt = &expiresAt
	derivedID, err := DeriveDeliveryID(input.TenantID, input.CampaignID, input.CampaignRecipientID, input.SendPlanID)
	if err != nil || derivedID != input.DeliveryID {
		return AttemptInput{}, "", fmt.Errorf("%w: delivery_id does not match immutable recipient/plan identity", ErrIntegrityMismatch)
	}
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	input.TransportName = strings.TrimSpace(input.TransportName)
	input.TransportContract = strings.TrimSpace(input.TransportContract)
	var capabilityObject map[string]any
	decoder := json.NewDecoder(strings.NewReader(string(input.CapabilitySnapshot)))
	decoder.UseNumber()
	if err := decoder.Decode(&capabilityObject); err != nil || capabilityObject == nil {
		return AttemptInput{}, "", fmt.Errorf("%w: invalid capability snapshot", ErrInvalidInput)
	}
	capabilities, err := json.Marshal(capabilityObject)
	if err != nil {
		return AttemptInput{}, "", err
	}
	input.CapabilitySnapshot = capabilities
	value := deliveryRequestHash{
		DeliveryID: input.DeliveryID, TenantID: input.TenantID, CampaignID: input.CampaignID,
		CampaignRecipientID: input.CampaignRecipientID, SendPlanID: input.SendPlanID,
		ArtifactID: input.ArtifactID, AssuranceRunID: input.AssuranceRunID,
		AssuranceAttemptCount: input.AssuranceAttemptCount,
		ArtifactSetHash:       input.ArtifactSetHash, GateDecision: input.GateDecision,
		GateOverrideIDs: append([]string(nil), input.GateOverrideIDs...), ScenarioID: input.ScenarioID,
		SourceHash: input.SourceHash, PlanHash: input.PlanHash,
		CompilerVersion: input.CompilerVersion, OutboundMIMEHash: input.OutboundMIMEHash,
		MessageID: input.MessageID, ReplyTo: input.ReplyTo,
		ReplyCorrelationVersion:   input.ReplyCorrelationVersion,
		ReplyCorrelationKeyID:     input.ReplyCorrelationKeyID,
		ReplyCorrelationExpiresAt: *input.ReplyCorrelationExpiresAt,
		ReplyCorrelationTokenHash: input.ReplyCorrelationTokenHash,
		IdempotencyKey:            input.IdempotencyKey,
		TransportName:             input.TransportName, TransportContract: input.TransportContract,
		CapabilitySnapshot: capabilities,
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return AttemptInput{}, "", err
	}
	return input, deliveryHash(encoded), nil
}

func representativeOverrideID(overrideIDs []string) string {
	if len(overrideIDs) == 0 {
		return ""
	}
	return overrideIDs[0]
}

func (r *Repo) Acquire(
	ctx context.Context,
	input AttemptInput,
	leaseOwner string,
	leaseDuration time.Duration,
) (Acquisition, error) {
	if r == nil || r.Pool == nil {
		return Acquisition{}, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	leaseOwner = strings.TrimSpace(leaseOwner)
	if leaseOwner == "" || len(leaseOwner) > 200 || strings.ContainsAny(leaseOwner, "\r\n\x00") ||
		leaseDuration < time.Second || leaseDuration > maxDeliveryLease {
		return Acquisition{}, fmt.Errorf("%w: invalid lease owner or duration", ErrInvalidInput)
	}
	input, requestHash, err := normalizeDeliveryAttempt(input)
	if err != nil {
		return Acquisition{}, err
	}
	// Two narrow locks cover the two mutable allocation domains without the
	// cross-tenant predicate aborts of SERIALIZABLE: the advisory lock
	// serializes one tenant/idempotency key, and the recipient row lock below
	// serializes attempt_no plus the one-nonretryable-recipient rule.
	tx, err := db.WithTenantWorkerOptions(ctx, r.Pool, input.TenantID, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Acquisition{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		input.TenantID+":"+input.IdempotencyKey); err != nil {
		return Acquisition{}, err
	}

	var exists bool
	err = tx.QueryRow(ctx, `
SELECT true FROM campaign_recipients
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND id = $3
 FOR UPDATE`, input.TenantID, input.CampaignID, input.CampaignRecipientID).Scan(&exists)
	if errors.Is(err, pgx.ErrNoRows) {
		return Acquisition{}, ErrNotFound
	}
	if err != nil {
		return Acquisition{}, err
	}

	existing, err := scanAttempt(tx.QueryRow(ctx, `
SELECT `+attemptColumns+` FROM campaign_send_deliveries
 WHERE tenant_id = $1::uuid AND idempotency_key = $2 FOR UPDATE`,
		input.TenantID, input.IdempotencyKey))
	if err == nil {
		if existing.RequestHash != requestHash {
			return Acquisition{}, ErrIdempotencyConflict
		}
		if existing.State == StatePrepared {
			token := uuid.NewString()
			reclaimed, reclaimErr := scanAttempt(tx.QueryRow(ctx, `
UPDATE campaign_send_deliveries
   SET claim_token = $3::uuid, lease_owner = $4,
       lease_expires_at = clock_timestamp() + ($5::bigint * interval '1 millisecond'),
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND state = 'prepared' AND lease_expires_at <= statement_timestamp()
RETURNING `+attemptColumns, input.TenantID, existing.ID, token,
				leaseOwner, leaseDuration.Milliseconds()))
			if reclaimErr == nil {
				if err := tx.Commit(ctx); err != nil {
					return Acquisition{}, err
				}
				return Acquisition{Attempt: reclaimed, Acquired: true}, nil
			}
			if !errors.Is(reclaimErr, pgx.ErrNoRows) {
				return Acquisition{}, reclaimErr
			}
		}
		if existing.State == StateDispatching {
			reconciled, reconcileErr := scanAttempt(tx.QueryRow(ctx, `
UPDATE campaign_send_deliveries
   SET state = 'indeterminate', lease_owner = NULL, lease_expires_at = NULL,
       failure_disposition = 'indeterminate',
       failure_code = 'DISPATCH_LEASE_EXPIRED',
       indeterminate_at = clock_timestamp(), updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND state = 'dispatching' AND lease_expires_at <= statement_timestamp()
RETURNING `+attemptColumns, input.TenantID, existing.ID))
			if reconcileErr == nil {
				existing = reconciled
			} else if !errors.Is(reconcileErr, pgx.ErrNoRows) {
				return Acquisition{}, reconcileErr
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return Acquisition{}, err
		}
		return Acquisition{Attempt: existing}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Acquisition{}, err
	}

	blocked, err := scanAttempt(tx.QueryRow(ctx, `
SELECT `+attemptColumns+` FROM campaign_send_deliveries
 WHERE tenant_id = $1::uuid AND campaign_recipient_id = $2
   AND state IN ('prepared', 'dispatching', 'indeterminate', 'accepted')
 FOR UPDATE`, input.TenantID, input.CampaignRecipientID))
	if err == nil {
		if err := tx.Commit(ctx); err != nil {
			return Acquisition{}, err
		}
		return Acquisition{Attempt: blocked}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Acquisition{}, err
	}

	var attemptNo int
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(max(attempt_no), 0) + 1 FROM campaign_send_deliveries
 WHERE tenant_id = $1::uuid AND campaign_recipient_id = $2`,
		input.TenantID, input.CampaignRecipientID).Scan(&attemptNo); err != nil {
		return Acquisition{}, err
	}
	if attemptNo > 100 {
		return Acquisition{}, fmt.Errorf("%w: delivery attempt budget exhausted", ErrInvalidInput)
	}
	claimToken := uuid.NewString()
	attempt, err := scanAttempt(tx.QueryRow(ctx, `
INSERT INTO campaign_send_deliveries (
    id, tenant_id, campaign_id, campaign_recipient_id, send_plan_id, artifact_id,
    assurance_run_id, assurance_attempt_count, artifact_set_hash, gate_decision,
    gate_override_id, gate_override_ids, scenario_id, source_hash, plan_hash, compiler_version,
    outbound_mime_hash, message_id, reply_to, reply_correlation_version,
    reply_correlation_key_id, reply_correlation_expires_at,
    reply_correlation_token_hash, attempt_no, idempotency_key, request_hash,
    transport_name, transport_contract_version, capability_snapshot,
    claim_token, lease_owner, lease_expires_at
) VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid,
    $7::uuid, $8, $9, $10, NULLIF($11, '')::uuid, $12::uuid[], $13, $14, $15, $16,
    $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29::jsonb,
    $30::uuid, $31, clock_timestamp() + ($32::bigint * interval '1 millisecond')
)
RETURNING `+attemptColumns,
		input.DeliveryID, input.TenantID, input.CampaignID, input.CampaignRecipientID,
		input.SendPlanID, input.ArtifactID, input.AssuranceRunID,
		input.AssuranceAttemptCount, input.ArtifactSetHash, input.GateDecision,
		representativeOverrideID(input.GateOverrideIDs), input.GateOverrideIDs,
		input.ScenarioID, input.SourceHash, input.PlanHash,
		input.CompilerVersion, input.OutboundMIMEHash, input.MessageID,
		input.ReplyTo, input.ReplyCorrelationVersion, input.ReplyCorrelationKeyID,
		input.ReplyCorrelationExpiresAt, input.ReplyCorrelationTokenHash, attemptNo,
		input.IdempotencyKey, requestHash, input.TransportName,
		input.TransportContract, []byte(input.CapabilitySnapshot), claimToken,
		leaseOwner, leaseDuration.Milliseconds()))
	if err != nil {
		return Acquisition{}, mapAcquireInsertError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Acquisition{}, err
	}
	return Acquisition{Attempt: attempt, Acquired: true}, nil
}

func mapAcquireInsertError(err error) error {
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.Code != "23505" {
		return err
	}
	switch postgresError.ConstraintName {
	case "campaign_send_deliveries_tenant_id_idempotency_key_key":
		return ErrIdempotencyConflict
	case "campaign_send_deliveries_one_nonretryable_recipient_uidx",
		"campaign_send_deliveries_tenant_id_campaign_recipient_id_attempt_no_key":
		return ErrAttemptInFlight
	case "campaign_send_deliveries_tenant_id_message_id_key":
		return ErrIntegrityMismatch
	case "campaign_send_deliveries_pkey", "campaign_send_deliveries_reply_correlation_token_uidx":
		return ErrIntegrityMismatch
	default:
		return err
	}
}

func (r *Repo) MarkDispatching(ctx context.Context, tenantID, attemptID, claimToken string) error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if err := validateDeliveryUUIDs(tenantID, attemptID, claimToken); err != nil {
		return err
	}
	tx, err := db.WithTenantWorker(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE campaign_send_deliveries
   SET state = 'dispatching', dispatch_started_at = clock_timestamp(),
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND claim_token = $3::uuid
   AND state = 'prepared' AND lease_expires_at > statement_timestamp()`,
		tenantID, attemptID, claimToken)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrLeaseLost
	}
	return tx.Commit(ctx)
}

func (r *Repo) MarkAccepted(ctx context.Context, input TerminalInput) (Attempt, error) {
	if r == nil || r.Pool == nil {
		return Attempt{}, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if err := validateDeliveryUUIDs(input.TenantID, input.AttemptID, input.ClaimToken); err != nil {
		return Attempt{}, err
	}
	receipt, err := normalizeReceiptIdentity(input.Receipt)
	if err != nil {
		return Attempt{}, err
	}
	input.Receipt = receipt
	if strings.TrimSpace(input.Receipt.IdempotencyMode) == "" ||
		len(input.Receipt.IdempotencyMode) > 160 || len(input.Receipt.ProviderMessageID) > 512 ||
		strings.ContainsAny(input.Receipt.ProviderMessageID, "\r\n\x00") {
		return Attempt{}, fmt.Errorf("%w: invalid provider receipt", ErrInvalidInput)
	}
	receiptJSON, err := json.Marshal(input.Receipt)
	if err != nil {
		return Attempt{}, err
	}
	receiptHash := deliveryHash(receiptJSON)
	tx, err := db.WithTenantWorker(ctx, r.Pool, input.TenantID)
	if err != nil {
		return Attempt{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	attempt, err := scanAttempt(tx.QueryRow(ctx, `
UPDATE campaign_send_deliveries
   SET state = 'accepted', lease_owner = NULL, lease_expires_at = NULL,
       provider_message_id = NULLIF($4, ''), receipt_hash = $5,
       idempotency_mode = $6, accepted_at = clock_timestamp(),
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND claim_token = $3::uuid
   AND state = 'dispatching' AND transport_contract_version = $7
   AND artifact_id = $8::uuid AND scenario_id = $9
   AND campaign_id = $10::uuid AND outbound_mime_hash = $11
   AND idempotency_key = $12
RETURNING `+attemptColumns,
		input.TenantID, input.AttemptID, input.ClaimToken,
		strings.TrimSpace(input.Receipt.ProviderMessageID), receiptHash,
		input.Receipt.IdempotencyMode, input.Receipt.ContractVersion,
		input.Receipt.ArtifactID, input.Receipt.ScenarioID,
		input.Receipt.CampaignID, input.Receipt.OutboundMIMEHash,
		input.Receipt.IdempotencyKey))
	if errors.Is(err, pgx.ErrNoRows) {
		existing, getErr := scanAttempt(tx.QueryRow(ctx, `
SELECT `+attemptColumns+` FROM campaign_send_deliveries
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, input.TenantID, input.AttemptID))
		if getErr == nil && existing.State == StateAccepted && existing.ReceiptHash == receiptHash {
			if err := tx.Commit(ctx); err != nil {
				return Attempt{}, err
			}
			return existing, nil
		}
		return Attempt{}, ErrLeaseLost
	}
	if err != nil {
		return Attempt{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Attempt{}, err
	}
	return attempt, nil
}

func normalizeReceiptIdentity(receipt campaigntransport.Receipt) (campaigntransport.Receipt, error) {
	for _, identity := range []*string{&receipt.ArtifactID, &receipt.CampaignID} {
		parsed, err := uuid.Parse(strings.TrimSpace(*identity))
		if err != nil {
			return campaigntransport.Receipt{}, fmt.Errorf("%w: invalid receipt UUID identity", ErrInvalidInput)
		}
		*identity = parsed.String()
	}
	receipt.ContractVersion = strings.TrimSpace(receipt.ContractVersion)
	receipt.ScenarioID = strings.TrimSpace(receipt.ScenarioID)
	receipt.ProviderMessageID = strings.TrimSpace(receipt.ProviderMessageID)
	receipt.IdempotencyKey = strings.TrimSpace(receipt.IdempotencyKey)
	receipt.IdempotencyMode = strings.TrimSpace(receipt.IdempotencyMode)
	return receipt, nil
}

func (r *Repo) MarkRejected(ctx context.Context, input TerminalInput) (Attempt, error) {
	return r.markFailure(ctx, input, StateRejected, string(campaigntransport.FailureDefinitelyNotSent))
}

func (r *Repo) MarkIndeterminate(ctx context.Context, input TerminalInput) (Attempt, error) {
	return r.markFailure(ctx, input, StateIndeterminate, string(campaigntransport.FailureIndeterminate))
}

func (r *Repo) markFailure(ctx context.Context, input TerminalInput, state, disposition string) (Attempt, error) {
	if r == nil || r.Pool == nil {
		return Attempt{}, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if err := validateDeliveryUUIDs(input.TenantID, input.AttemptID, input.ClaimToken); err != nil {
		return Attempt{}, err
	}
	if !deliveryFailureCode.MatchString(input.FailureCode) {
		return Attempt{}, fmt.Errorf("%w: invalid failure_code", ErrInvalidInput)
	}
	timestamp := "rejected_at"
	if state == StateIndeterminate {
		timestamp = "indeterminate_at"
	}
	tx, err := db.WithTenantWorker(ctx, r.Pool, input.TenantID)
	if err != nil {
		return Attempt{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	query := `
UPDATE campaign_send_deliveries
   SET state = $4, lease_owner = NULL, lease_expires_at = NULL,
       failure_disposition = $5, failure_code = $6,
       ` + timestamp + ` = clock_timestamp(), updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND claim_token = $3::uuid
   AND state = 'dispatching'
RETURNING ` + attemptColumns
	attempt, err := scanAttempt(tx.QueryRow(ctx, query, input.TenantID,
		input.AttemptID, input.ClaimToken, state, disposition, input.FailureCode))
	if errors.Is(err, pgx.ErrNoRows) {
		return Attempt{}, ErrLeaseLost
	}
	if err != nil {
		return Attempt{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Attempt{}, err
	}
	return attempt, nil
}

func validateDeliveryUUIDs(values ...string) error {
	for _, value := range values {
		if _, err := uuid.Parse(strings.TrimSpace(value)); err != nil {
			return fmt.Errorf("%w: invalid UUID identity", ErrInvalidInput)
		}
	}
	return nil
}

func deliveryHash(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}
