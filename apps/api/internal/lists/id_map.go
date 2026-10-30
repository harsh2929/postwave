package lists

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrListIDNotMapped is returned when the requested id has no entry in
// list_id_map for the active tenant. Callers translate this to "list
// not found" — the gateway never invents mappings, it only reads ones
// the create handler persisted.
var ErrListIDNotMapped = errors.New("lists: id not present in list_id_map")

// ErrInvalidListID distinguishes malformed public input from an
// infrastructure failure. Handlers must translate this sentinel to a 400;
// letting a malformed value reach a ::uuid cast turns a client error into a
// misleading 500.
var ErrInvalidListID = errors.New("lists: id must be a positive integer or UUID")

// ErrListsRepoUnavailable is returned by internal audience-counting and
// create paths when the identity sidecar is not wired. Returning a zero count
// in this state would make a valid audience look empty and is therefore not a
// safe fallback.
var ErrListsRepoUnavailable = errors.New("lists: identity repository unavailable")

// ErrListIdentityCommitUncertain marks the narrow case where PostgreSQL did
// not confirm COMMIT and a fresh read could not prove whether the mapping is
// durable. Create must not compensate upstream in this state: deleting the
// engine row could leave a committed local mapping pointing at nothing.
var ErrListIdentityCommitUncertain = errors.New("lists: identity commit outcome uncertain")

// ListIdentityCreateError describes a Listmonk create that could not be
// paired with its Moosewave identity. RecoveryRequired means the compensating
// upstream delete also failed, so callers must not blindly retry and create a
// second list.
type ListIdentityCreateError struct {
	EngineID              int64
	PostwaveUUID          string
	MappingState          string
	RecoveryRequired      bool
	CompensationAttempted bool
	CompensationStatus    int
}

func (e *ListIdentityCreateError) Error() string {
	if e == nil {
		return "list identity creation failed"
	}
	if e.RecoveryRequired {
		if e.EngineID <= 0 {
			return "list identity recovery required: upstream success did not contain an engine id"
		}
		return fmt.Sprintf(
			"list identity recovery required (engine_id=%d, postwave_uuid=%s)",
			e.EngineID,
			e.PostwaveUUID,
		)
	}
	return "list creation was rolled back because its local identity could not be saved"
}

func (d *Deps) canPersistListIdentity() bool {
	return d != nil && (d.ensureListIdentity != nil || (d.Repo != nil && d.Repo.Pool != nil))
}

func (d *Deps) persistListIdentity(
	ctx context.Context,
	tenantID string,
	preferredUUID string,
	engineID int64,
) (string, error) {
	if d == nil {
		return "", ErrListsRepoUnavailable
	}
	if d.ensureListIdentity != nil {
		return d.ensureListIdentity(ctx, tenantID, preferredUUID, engineID)
	}
	if d.Repo == nil {
		return "", ErrListsRepoUnavailable
	}
	return d.Repo.ensureListIDMap(ctx, tenantID, preferredUUID, engineID)
}

// establishCreatedListIdentity is the intentionally narrow two-store
// boundary. The upstream create happens first because only Listmonk can mint
// the engine bigint. If the local commit fails, we immediately compensate by
// deleting that exact engine row. A failed compensation is returned with both
// identities as explicit recovery evidence; it is never shaped as success.
func (d *Deps) establishCreatedListIdentity(
	ctx context.Context,
	tenantID string,
	engineID int64,
) (string, *ListIdentityCreateError) {
	preferredUUID := uuid.NewString()
	canonicalUUID, err := d.persistListIdentity(ctx, tenantID, preferredUUID, engineID)
	recoveryUUID := preferredUUID
	if normalizedUUID, normalizeErr := normalizeListUUID(canonicalUUID); normalizeErr == nil {
		recoveryUUID = normalizedUUID
	}
	if err == nil {
		canonicalUUID, err = normalizeListUUID(canonicalUUID)
	}
	if err == nil {
		return canonicalUUID, nil
	}

	commitUncertain := errors.Is(err, ErrListIdentityCommitUncertain)
	mappingState := "not_committed"
	if commitUncertain {
		mappingState = "unknown"
	}
	compensationAttempted := !commitUncertain
	compensationStatus := 0
	var compensationErr error
	if compensationAttempted {
		_, compensationStatus, compensationErr = d.proxyCtx(
			ctx,
			http.MethodDelete,
			"/api/lists/"+strconv.FormatInt(engineID, 10),
			nil,
		)
	}
	compensated := compensationErr == nil &&
		compensationAttempted &&
		((compensationStatus >= 200 && compensationStatus < 300) || compensationStatus == http.StatusNotFound)
	failure := &ListIdentityCreateError{
		EngineID:              engineID,
		PostwaveUUID:          recoveryUUID,
		MappingState:          mappingState,
		RecoveryRequired:      !compensated,
		CompensationAttempted: compensationAttempted,
		CompensationStatus:    compensationStatus,
	}
	d.logCreateIdentityFailure("could not persist list identity", engineID, recoveryUUID, err, compensationStatus)
	action := "list.create_compensated"
	if failure.RecoveryRequired {
		action = "list.create_recovery_required"
	}
	audit.EmitOrLog(ctx, d.auditPool(), action, "list", strconv.FormatInt(engineID, 10), nil, nil,
		map[string]any{
			"engine_id":              engineID,
			"postwave_uuid":          recoveryUUID,
			"mapping_state":          mappingState,
			"compensation_attempted": compensationAttempted,
			"compensation_status":    compensationStatus,
			"compensation_error":     compensationErr != nil,
		})
	return "", failure
}

func (d *Deps) logCreateIdentityFailure(
	message string,
	engineID int64,
	postwaveUUID string,
	err error,
	compensationStatus int,
) {
	logger := slog.Default()
	if d != nil && d.Logger != nil {
		logger = d.Logger
	}
	logger.Error(message,
		"engine_id", engineID,
		"postwave_uuid", postwaveUUID,
		"compensation_status", compensationStatus,
		"err", err,
	)
}

func (d *Deps) writeCreateIdentityFailure(w http.ResponseWriter, failure *ListIdentityCreateError) {
	status := http.StatusServiceUnavailable
	code := "list_identity_persistence_failed"
	message := "list creation was rolled back because its local identity could not be saved; retry with the same idempotency key"
	if failure.RecoveryRequired {
		status = http.StatusConflict
		code = "list_identity_recovery_required"
		message = "the upstream list exists without a committed local identity; do not retry and contact support with the recovery identity"
	} else {
		w.Header().Set("Retry-After", "1")
	}
	writeJSON(w, status, map[string]any{
		"error": map[string]any{
			"code":                   code,
			"message":                message,
			"engine_id":              failure.EngineID,
			"postwave_uuid":          failure.PostwaveUUID,
			"mapping_state":          failure.MappingState,
			"recovery_required":      failure.RecoveryRequired,
			"compensation_attempted": failure.CompensationAttempted,
			"compensation_status":    failure.CompensationStatus,
		},
	})
}

// GetListUUIDByBigintID resolves a Listmonk-side bigint list id to the
// Moosewave-side uuid. The mapping is per-tenant (each tenant runs
// against its own Listmonk install / prefix) so the tenant scope is
// load-bearing for correctness, not just isolation.
//
// Used by CountListAudience to fix GAP-LS-045: campaigns historically
// stored Listmonk's bigint in audience_list_id, but list_subscribers
// is keyed on the Moosewave uuid. Without this lookup the count silently
// returns 0.
func (r *Repo) GetListUUIDByBigintID(ctx context.Context, tenantID string, bigintID int64) (string, error) {
	if r == nil || r.Pool == nil {
		return "", ErrListsRepoUnavailable
	}
	if strings.TrimSpace(tenantID) == "" {
		return "", fmt.Errorf("lists: tenant id required")
	}
	if bigintID <= 0 {
		return "", ErrInvalidListID
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var got string
	err = tx.QueryRow(ctx, `
SELECT postwave_uuid::text FROM list_id_map
 WHERE tenant_id = $1::uuid
   AND listmonk_bigint_id = $2`, tenantID, bigintID).Scan(&got)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrListIDNotMapped
	}
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return got, nil
}

// GetListBigintIDByUUID is the reverse — Moosewave uuid to Listmonk bigint.
// Used by the listmonk_events populate path (handlers.go) so a
// subscriber.subscribed webhook carrying a Listmonk bigint can be
// recorded against the Moosewave-side join table.
func (r *Repo) GetListBigintIDByUUID(ctx context.Context, tenantID, listUUID string) (int64, error) {
	if r == nil || r.Pool == nil {
		return 0, ErrListsRepoUnavailable
	}
	if strings.TrimSpace(tenantID) == "" {
		return 0, fmt.Errorf("lists: tenant id required")
	}
	trimmedUUID := strings.TrimSpace(listUUID)
	if trimmedUUID == "" || trimmedUUID != listUUID {
		return 0, ErrInvalidListID
	}
	parsedUUID, err := uuid.Parse(trimmedUUID)
	if err != nil {
		return 0, ErrInvalidListID
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var got int64
	err = tx.QueryRow(ctx, `
SELECT listmonk_bigint_id FROM list_id_map
 WHERE tenant_id = $1::uuid
   AND postwave_uuid = $2::uuid`, tenantID, parsedUUID.String()).Scan(&got)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrListIDNotMapped
	}
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return got, nil
}

// ensureListIDMap records a (postwave_uuid, listmonk_bigint_id) pair and
// returns the canonical Moosewave UUID bound to that engine id. If an upstream
// retry returns an already-mapped engine id, the existing UUID wins; callers
// must never mint a second local identity for the same tenant + engine row.
func (r *Repo) ensureListIDMap(ctx context.Context, tenantID, preferredPostwaveUUID string, bigintID int64) (string, error) {
	if r == nil || r.Pool == nil {
		return "", ErrListsRepoUnavailable
	}
	if strings.TrimSpace(tenantID) == "" {
		return "", fmt.Errorf("lists: ensure id map requires tenant")
	}
	parsedUUID, err := uuid.Parse(strings.TrimSpace(preferredPostwaveUUID))
	if err != nil || bigintID <= 0 {
		return "", ErrInvalidListID
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var canonicalUUID string
	if err := tx.QueryRow(ctx, `
INSERT INTO list_id_map (postwave_uuid, listmonk_bigint_id, tenant_id)
VALUES ($1::uuid, $2, $3::uuid)
ON CONFLICT (tenant_id, listmonk_bigint_id) DO UPDATE
SET listmonk_bigint_id = EXCLUDED.listmonk_bigint_id
RETURNING postwave_uuid::text`,
		parsedUUID.String(), bigintID, tenantID).Scan(&canonicalUUID); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		commitErr := err
		verifyCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		verifiedUUID, verifyErr := r.GetListUUIDByBigintID(verifyCtx, tenantID, bigintID)
		switch {
		case verifyErr == nil:
			return verifiedUUID, nil
		case errors.Is(verifyErr, ErrListIDNotMapped):
			// A fresh read on the primary proves the write is absent, so the
			// caller may safely compensate the upstream create.
			return canonicalUUID, fmt.Errorf("lists: identity commit rolled back: %w", commitErr)
		default:
			return canonicalUUID, fmt.Errorf(
				"%w: commit error: %v; verification error: %v",
				ErrListIdentityCommitUncertain,
				commitErr,
				verifyErr,
			)
		}
	}
	return canonicalUUID, nil
}

// upsertListIDMap keeps the original private helper contract for focused
// callers while delegating to the exact, conflict-aware implementation.
func (r *Repo) upsertListIDMap(ctx context.Context, tenantID, postwaveUUID string, bigintID int64) error {
	_, err := r.ensureListIDMap(ctx, tenantID, postwaveUUID, bigintID)
	return err
}

// parseInt64Strict reports whether the input parses cleanly as an int64
// (no whitespace, no sign noise). Used by CountListAudience to decide
// whether to take the bigint -> uuid resolution path.
func parseInt64Strict(s string) (int64, bool) {
	if s == "" || strings.TrimSpace(s) != s || s[0] == '0' {
		return 0, false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}
