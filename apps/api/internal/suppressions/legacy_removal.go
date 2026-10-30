package suppressions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrLegacySuppressionNotFound means the selected email_suppressions row does
// not exist in the caller's tenant. Callers must not disclose whether the same
// identifier exists in another tenant.
var ErrLegacySuppressionNotFound = errors.New("suppressions: legacy suppression not found")

// ErrIrreversibleSuppression means the selected row, or another durable
// erasure artifact for the same address, proves that the address was erased.
// Such tombstones may only be changed through a dedicated compliance workflow
// that records the legal basis; an ordinary suppression DELETE must fail
// closed.
var ErrIrreversibleSuppression = errors.New("suppressions: irreversible erasure tombstone")

// IsIrreversibleTombstone classifies suppression evidence shared by the legacy
// and converged stores. Erasure writers have historically represented the same
// invariant in three ways as schemas evolved:
//
//   - a first-class dsar_deletion-style reason;
//   - a GDPR/DSAR deletion source while using the older `manual` reason; or
//   - metadata.gdpr_erasure=true (plus an erasure identity/receipt marker).
//
// Treating any one independently as authoritative is deliberate. A partial
// migration or later metadata merge must never turn a permanent privacy
// boundary into an ordinary removable suppression.
func IsIrreversibleTombstone(reason, source string, metadata map[string]any) bool {
	if slices.Contains(irreversibleReasons, normalizePolicyMarker(reason)) {
		return true
	}

	source = normalizePolicyMarker(source)
	if slices.Contains(irreversibleSources, source) {
		return true
	}
	for _, prefix := range irreversibleSourcePrefixes {
		if strings.HasPrefix(source, prefix) &&
			(strings.Contains(source, "delet") || strings.Contains(source, "eras")) {
			return true
		}
	}

	for _, key := range irreversibleMetadataFlags {
		if policyTruthy(metadata[key]) {
			return true
		}
	}
	// These identifiers are emitted only by privacy-erasure workflows. Their
	// non-empty presence remains a strong terminal marker even if an older
	// writer encoded gdpr_erasure incorrectly or a metadata merge omitted it.
	for _, key := range erasureIdentityMarkers {
		if markerPresent(metadata[key]) {
			return true
		}
	}
	return false
}

// The erasure vocabulary IsIrreversibleTombstone recognises, after
// normalizePolicyMarker. ErasedAddresses derives its SQL candidate filter
// from these lists, so a new term belongs here and nowhere else.
var (
	irreversibleReasons = []string{
		"dsar_deletion", "dsar_delete", "gdpr_erasure", "gdpr_delete",
		"privacy_erasure", "privacy_delete", "right_to_be_forgotten", "rtbf",
	}
	irreversibleSources = []string{
		"gdpr_delete", "gdpr_bulk_delete", "gdpr_erasure",
		"dsar_delete", "dsar_bulk_delete", "dsar_deletion", "dsar_erasure",
		"privacy_delete", "privacy_bulk_delete", "privacy_erasure",
		"right_to_be_forgotten", "rtbf",
	}
	// A source with one of these prefixes that mentions a deletion or an
	// erasure is a tombstone too.
	irreversibleSourcePrefixes = []string{"gdpr_", "dsar_", "privacy_"}
	irreversibleMetadataFlags  = []string{
		"gdpr_erasure", "dsar_erasure", "privacy_erasure",
		"erasure_tombstone", "permanent_erasure", "irreversible",
	}
	erasureIdentityMarkers = []string{"deleted_subscriber_id", "erasure_receipt_id", "dsar_request_id"}
)

func normalizePolicyMarker(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.NewReplacer("-", "_", " ", "_").Replace(value)
	return strings.Trim(value, "_")
}

func policyTruthy(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		switch normalizePolicyMarker(typed) {
		case "true", "1", "yes", "permanent", "irreversible", "erased", "completed":
			return true
		}
	case json.Number:
		return typed != "" && typed != "0"
	case float64:
		return typed != 0
	case float32:
		return typed != 0
	case int:
		return typed != 0
	case int64:
		return typed != 0
	}
	return false
}

func markerPresent(value any) bool {
	if value == nil {
		return false
	}
	if stringValue, ok := value.(string); ok {
		return strings.TrimSpace(stringValue) != ""
	}
	return true
}

// RemoveLegacyByID safely removes one row from email_suppressions. It is the
// policy boundary for the compatibility DELETE /api/v1/suppressions/{id}.
//
// The selected row is locked before review. Removal is refused when either the
// row itself or any converged artifact for the exact tenant/address proves an
// erasure: canonical subscriber_suppressions (plaintext or SHA-256 identity),
// the oldest suppressions store, or an immutable erasure receipt. Looking
// across stores closes partial-migration gaps where an old row lost one marker
// but the canonical tombstone still has it.
func (r *Repo) RemoveLegacyByID(ctx context.Context, tenantID, id string) error {
	if r == nil || r.Pool == nil {
		return errors.New("suppressions: nil repo")
	}
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(id) == "" {
		return ErrLegacySuppressionNotFound
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var email, reason, source string
	var rawMetadata []byte
	err = tx.QueryRow(ctx, `
SELECT email::text, COALESCE(reason, ''), COALESCE(source, ''), metadata
  FROM email_suppressions
 WHERE tenant_id = $1::uuid
	AND id::text = $2
 FOR UPDATE`, tenantID, id).Scan(&email, &reason, &source, &rawMetadata)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrLegacySuppressionNotFound
	}
	if err != nil {
		return fmt.Errorf("suppressions: select legacy suppression for removal: %w", err)
	}

	metadata, validMetadata := decodeRemovalMetadata(rawMetadata)
	if !validMetadata || IsIrreversibleTombstone(reason, source, metadata) {
		return ErrIrreversibleSuppression
	}

	protected, err := convergedErasureExists(ctx, tx, tenantID, email)
	if err != nil {
		return err
	}
	if protected {
		return ErrIrreversibleSuppression
	}

	tag, err := tx.Exec(ctx, `
DELETE FROM email_suppressions
 WHERE tenant_id = $1::uuid
	AND id::text = $2`, tenantID, id)
	if err != nil {
		return fmt.Errorf("suppressions: delete reviewed legacy suppression: %w", err)
	}
	if tag.RowsAffected() != 1 {
		// The row was locked above, so this is an integrity/routing anomaly. Do
		// not report success for a mutation that did not happen.
		return ErrLegacySuppressionNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

// convergedErasureExists looks for erasure evidence about the address outside
// the email_suppressions row under review: the canonical store (plaintext or
// SHA-256 identity), the oldest store, and the immutable receipts. It shares
// the marker query and classification with ErasedAddresses.
func convergedErasureExists(ctx context.Context, tx pgx.Tx, tenantID, email string) (bool, error) {
	markers, err := loadErasureMarkers(ctx, tx, tenantID, []string{NormalizeErasureAddress(email)})
	if err != nil {
		return false, err
	}
	for _, marker := range markers {
		if marker.store != erasureStoreEmailSuppressions && marker.irreversible() {
			return true, nil
		}
	}
	return false, nil
}

// decodeRemovalMetadata is intentionally stricter than the presentation-side
// decodeJSON helper. A JSONB scalar/array is legal PostgreSQL data but violates
// the suppression metadata contract; treating that corruption as an empty map
// would let a malformed privacy marker bypass the erasure gate. Destructive
// callers therefore preserve the row unless metadata is an object (or absent).
func decodeRemovalMetadata(raw []byte) (map[string]any, bool) {
	if len(raw) == 0 {
		return nil, true
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, false
	}
	if decoded == nil {
		return nil, false
	}
	metadata, ok := decoded.(map[string]any)
	return metadata, ok
}
