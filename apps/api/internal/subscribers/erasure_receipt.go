// SUB-046 — Right-to-be-forgotten produces a machine-readable receipt.
//
// The subscriber delete path (repo.go Delete) already erases the row, writes a
// permanent gdpr_erasure suppression, and logs a "subscriber.deleted" audit
// row. This surface adds the missing machine-readable PROOF artifact: an
// erasure_receipts row (migration 0501) dual-written in the same tx as the
// delete, plus a fetch endpoint that returns it as JSON for the data subject
// and downstream DSAR tools (W3C DPV consent-27560 / GDPR Article 17).
//
// The receipt never stores cleartext PII — the whole point is that the address
// is forgotten. It carries:
//   - email_redacted: a stable {hash}@{domain} label safe to display.
//   - email_hash:     SHA-256 hex of the lowercased address, the canonical
//                     proof token a downstream tool recomputes to match.
//   - erased_at:      the erasure timestamp.
//   - metadata:       prev_status + source pointers (cross-refs the audit row).
//
// Endpoint (admin scope — erasure proof is sensitive operator data):
//   GET /api/v1/subscribers/{id}/erasure-receipt   — fetch the latest receipt

package subscribers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

const erasureReceiptColumns = `id::text, subscriber_id::text, email_redacted,
       email_hash, erased_at, metadata, created_at`

// hashEmailForReceipt produces the canonical machine-readable proof token: the
// hex SHA-256 of the lowercased, trimmed address. A downstream DSAR tool that
// still holds the (now-erased) address can recompute this and match the
// receipt without Moosewave ever re-storing the cleartext. Empty input returns
// "" so a receipt for a row that somehow had no email stays well-formed.
func hashEmailForReceipt(email string) string {
	email = strings.TrimSpace(strings.ToLower(email))
	if email == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(email))
	return hex.EncodeToString(sum[:])
}

// writeErasureReceipt inserts the SUB-046 proof row. Called inside the same tx
// as Repo.Delete so the receipt and the erasure commit atomically — an erasure
// can never land without its proof. Stores only non-reversible tokens.
func writeErasureReceipt(ctx context.Context, tx pgx.Tx, tenantID string, sub *Subscriber) error {
	meta := map[string]any{
		"prev_status": sub.Status,
		"source":      "gdpr_delete",
	}
	metaRaw, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
INSERT INTO erasure_receipts
       (tenant_id, subscriber_id, email_redacted, email_hash, metadata)
VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)`,
		tenantID, sub.ID,
		observability.RedactEmail(sub.Email),
		hashEmailForReceipt(sub.Email),
		string(metaRaw))
	return err
}

// GetErasureReceipt returns the most recent erasure receipt for the given
// subscriber id. ErrNotFound when no erasure has been recorded for that id.
//
// Note: the subscribers row is gone after an erasure, so this resolves purely
// against erasure_receipts by the stored subscriber_id (a plain uuid, not an
// FK). The caller passes the id from the URL — it must be a uuid; a
// non-uuid id simply matches nothing and yields ErrNotFound.
func (r *Repo) GetErasureReceipt(ctx context.Context, tenantID, subscriberID string) (*ErasureReceipt, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row := tx.QueryRow(ctx, `
SELECT `+erasureReceiptColumns+`
  FROM erasure_receipts
 WHERE tenant_id = $1::uuid AND subscriber_id::text = $2
 ORDER BY erased_at DESC
 LIMIT 1`, tenantID, subscriberID)
	out, err := scanErasureReceipt(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func scanErasureReceipt(row scanner) (*ErasureReceipt, error) {
	var e ErasureReceipt
	var metaRaw []byte
	if err := row.Scan(&e.ID, &e.SubscriberID, &e.EmailRedacted, &e.EmailHash,
		&e.ErasedAt, &metaRaw, &e.CreatedAt); err != nil {
		return nil, err
	}
	e.Metadata = map[string]any{}
	if len(metaRaw) > 0 {
		_ = json.Unmarshal(metaRaw, &e.Metadata)
	}
	return &e, nil
}

// MountErasureReceiptRoutes registers the SUB-046 receipt fetch. Admin scope —
// an erasure proof is sensitive operator/compliance data, not part of the
// read-subscribers surface.
func MountErasureReceiptRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Get("/api/v1/subscribers/{id}/erasure-receipt", d.GetErasureReceipt)
}

// GetErasureReceipt GET /api/v1/subscribers/{id}/erasure-receipt.
func (d *Deps) GetErasureReceipt(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	receipt, err := d.Repo.GetErasureReceipt(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no erasure receipt for this subscriber"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// Self-referential proof URL: the canonical location of this receipt, so a
	// downstream tool can store one stable pointer.
	receipt.ProofURL = "/api/v1/subscribers/" + receipt.SubscriberID + "/erasure-receipt"
	writeJSON(w, http.StatusOK, receipt)
}
