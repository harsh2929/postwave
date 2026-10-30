// SPDX-License-Identifier: AGPL-3.0-only
//
// merkle.go — hash-chain + periodic-root signing for audit_log.
//
// Each row's row_hash = sha256(canonical_bytes || prev_hash). Periodic
// roots take the most recent row_hash within a tenant and persist it
// in audit_merkle_roots so a verifier can:
//
//   1. Pick a signed root.
//   2. Walk backwards from upto_audit_id, recomputing prev_hash →
//      row_hash for each row.
//   3. Confirm the walk arrives at the row of interest unchanged.
//
// Any tampering breaks the chain at the next root.

package auditsink

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// CanonicalBytes serializes an audit row into the bytes that flow
// into sha256. Order matters — every reader/verifier must produce
// the same bytes. We use big-endian fixed widths + length-prefixed
// strings so json key-order can't drift.
func CanonicalBytes(r AuditRow) []byte {
	var b []byte
	put := func(s string) {
		var l [4]byte
		binary.BigEndian.PutUint32(l[:], uint32(len(s)))
		b = append(b, l[:]...)
		b = append(b, []byte(s)...)
	}
	putI := func(n int64) {
		var l [8]byte
		binary.BigEndian.PutUint64(l[:], uint64(n))
		b = append(b, l[:]...)
	}
	putI(r.ID)
	put(r.TenantID)
	put(r.UserID)
	put(r.Action)
	put(r.ResourceType)
	put(r.ResourceID)
	mb, _ := json.Marshal(r.Metadata)
	put(string(mb))
	put(r.IP)
	put(r.UserAgent)
	put(r.ActorType)
	put(r.ActorLabel)
	putI(r.At.UnixNano())
	return b
}

// RowHash returns sha256(CanonicalBytes(r) || prevHash).
func RowHash(r AuditRow, prevHash []byte) []byte {
	h := sha256.New()
	h.Write(CanonicalBytes(r))
	h.Write(prevHash)
	sum := h.Sum(nil)
	return sum
}

// MerkleWorker periodically backfills row_hash / prev_hash on
// audit_log rows that have NULL chain columns, then publishes a
// signed root in audit_merkle_roots.
type MerkleWorker struct {
	Pool   *db.Pool
	Logger *slog.Logger
	// Interval is the root cadence. Default 60s. Each tick:
	//  1. Backfill chain columns for any new rows.
	//  2. Snapshot the current tip per tenant and insert an
	//     audit_merkle_roots row.
	Interval time.Duration
}

// Run drives the worker until ctx is canceled.
func (w *MerkleWorker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return nil
	}
	interval := w.Interval
	if interval <= 0 {
		interval = 60 * time.Second
	}
	logger := w.Logger
	if logger == nil {
		logger = slog.Default()
	}
	logger.Info("audit merkle worker: starting", "interval", interval.String())
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		// Run immediately, then tick.
		if err := w.tick(ctx); err != nil {
			logger.Warn("audit merkle tick failed", "err", err.Error())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

// tick backfills chain columns + snapshots roots. Iterates per tenant.
func (w *MerkleWorker) tick(ctx context.Context) error {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Bypass the audit_log_immutability_guard trigger (migration 0169)
	// so the Merkle backfill can UPDATE row_hash + prev_hash on
	// freshly-inserted rows. Without this, the trigger blocks
	// every UPDATE with a CHECK_VIOLATION. session-local so the
	// GUC doesn't leak to other code paths on the same connection.
	if _, err := tx.Exec(ctx, "SELECT set_config('app.audit_internal_writer', 'true', true)"); err != nil {
		return err
	}

	// Find distinct tenants with unhashed rows.
	rows, err := tx.Query(ctx, `
SELECT DISTINCT tenant_id::text
  FROM audit_log
 WHERE row_hash IS NULL`)
	if err != nil {
		return fmt.Errorf("list tenants: %w", err)
	}
	tenants := []string{}
	for rows.Next() {
		var s string
		if rows.Scan(&s) == nil {
			tenants = append(tenants, s)
		}
	}
	rows.Close()

	for _, tenantID := range tenants {
		if err := w.backfillTenant(ctx, tx, tenantID); err != nil {
			if w.Logger != nil {
				w.Logger.Warn("audit merkle: tenant backfill failed", "tenant", tenantID, "err", err.Error())
			}
			continue
		}
		if err := w.snapshotRoot(ctx, tx, tenantID); err != nil {
			if w.Logger != nil {
				w.Logger.Warn("audit merkle: root snapshot failed", "tenant", tenantID, "err", err.Error())
			}
		}
	}
	return tx.Commit(ctx)
}

// backfillTenant walks unhashed rows oldest-first and populates
// prev_hash / row_hash. Each row depends on the prior one's row_hash.
func (w *MerkleWorker) backfillTenant(ctx context.Context, tx pgx.Tx, tenantID string) error {
	// Find the most recent hashed row's row_hash to seed prev_hash.
	var prevHash []byte
	row := tx.QueryRow(ctx, `
SELECT COALESCE(row_hash, ''::bytea)
  FROM audit_log
 WHERE tenant_id = $1::uuid AND row_hash IS NOT NULL
 ORDER BY id DESC
 LIMIT 1`, tenantID)
	if err := row.Scan(&prevHash); err != nil {
		// First-ever row for this tenant; seed with zero hash.
		prevHash = make([]byte, 32)
	}
	if len(prevHash) == 0 {
		prevHash = make([]byte, 32)
	}

	pending, err := tx.Query(ctx, `
SELECT id, COALESCE(user_id::text,''), action,
       COALESCE(resource_type,''), COALESCE(resource_id,''),
       COALESCE(metadata, '{}'::jsonb),
       COALESCE(host(ip), ''), COALESCE(user_agent, ''),
       COALESCE(actor_type, 'human'), COALESCE(actor_label, ''),
       at
  FROM audit_log
 WHERE tenant_id = $1::uuid AND row_hash IS NULL
 ORDER BY id ASC
 LIMIT 1000`, tenantID)
	if err != nil {
		return err
	}
	var pendingRows []AuditRow
	for pending.Next() {
		var r AuditRow
		r.TenantID = tenantID
		var meta []byte
		if err := pending.Scan(&r.ID, &r.UserID, &r.Action,
			&r.ResourceType, &r.ResourceID, &meta, &r.IP, &r.UserAgent,
			&r.ActorType, &r.ActorLabel, &r.At); err != nil {
			return err
		}
		_ = json.Unmarshal(meta, &r.Metadata)
		pendingRows = append(pendingRows, r)
	}
	if err := pending.Err(); err != nil {
		pending.Close()
		return err
	}
	pending.Close()
	for _, r := range pendingRows {
		thisHash := RowHash(r, prevHash)
		// Update row in place.
		if _, err := tx.Exec(ctx, `
UPDATE audit_log SET prev_hash = $1, row_hash = $2
 WHERE id = $3`, prevHash, thisHash, r.ID); err != nil {
			return err
		}
		prevHash = thisHash
	}
	return nil
}

// snapshotRoot writes a row to audit_merkle_roots pinning the current
// tip of the chain. Populates tree_size (= COUNT of audit_log rows
// committed up to maxID) and prev_checkpoint_id (= previous root for
// this tenant) so the customer-callable proof endpoints in
// proof.go can answer inclusion + consistency queries in RFC 9162 terms.
func (w *MerkleWorker) snapshotRoot(ctx context.Context, tx pgx.Tx, tenantID string) error {
	var maxID int64
	var rootHash []byte
	row := tx.QueryRow(ctx, `
SELECT id, row_hash
  FROM audit_log
 WHERE tenant_id = $1::uuid AND row_hash IS NOT NULL
 ORDER BY id DESC
 LIMIT 1`, tenantID)
	if err := row.Scan(&maxID, &rootHash); err != nil {
		// No hashed rows yet; nothing to snapshot.
		return nil
	}
	var treeSize int64
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*) FROM audit_log
 WHERE tenant_id = $1::uuid AND id <= $2`, tenantID, maxID).Scan(&treeSize); err != nil {
		return err
	}
	// Previous root for this tenant, used by consistency-proof walkers
	// so they can iterate checkpoints without scanning rooted_at windows.
	var prevID *int64
	var lastID int64
	prevErr := tx.QueryRow(ctx, `
SELECT id FROM audit_merkle_roots
 WHERE tenant_id = $1::uuid
 ORDER BY id DESC
 LIMIT 1`, tenantID).Scan(&lastID)
	if prevErr == nil {
		prevID = &lastID
	}
	_, err := tx.Exec(ctx, `
INSERT INTO audit_merkle_roots (tenant_id, upto_audit_id, root_hash, tree_size, prev_checkpoint_id)
VALUES ($1::uuid, $2, $3, $4, $5)`, tenantID, maxID, rootHash, treeSize, prevID)
	return err
}

// keep db package referenced (the worker takes *db.Pool in the struct).
var _ *db.Pool = nil
