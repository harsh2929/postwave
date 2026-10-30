// SPDX-License-Identifier: AGPL-3.0-only
//
// reencrypt.go is the optional background job that re-wraps existing
// v=0x03 (tenant-envelope) blobs from an old KEK to the tenant's
// currently-active KEK. Without this job, a BYOK customer who rotates
// their KEK is left with two live keys forever (old + new), because
// the wire format embeds the key_id of the writing key and Decrypt
// always routes back to that key. The old key cannot be safely
// deleted from the provider until every blob it produced has been
// re-encrypted.
//
// Design notes:
//
//   - Column-driven, not table-walking. Operators register the
//     concrete (table, blob_column, id_column, where_clause) tuples
//     they want covered. Without any registrations the job is a
//     no-op — that's the current state (no production column has
//     opted into BYOK yet), but the scaffolding lets future
//     columns plug in without re-writing the sweep.
//
//   - Per-tenant pacing. The job picks the OLDEST inactive key per
//     tenant and re-wraps a small batch of its blobs per tick. This
//     keeps the KMS call rate predictable and prevents a single
//     tenant's rotation from monopolising the provider's quota.
//
//   - Idempotent. The re-encrypt writes the new blob in a single
//     UPDATE keyed on (id, blob). A concurrent process that ran
//     ahead just makes the next tick's UPDATE match zero rows.
//
//   - Safe by construction. The job ONLY runs against (table, col)
//     pairs the operator explicitly registered. There is no
//     "discover all bytea columns" reflection that could accidentally
//     touch a column with a different blob format.

package byok

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// EncryptedColumn declares one column the re-encryption sweep
// covers. Registered at boot via Reencryptor.RegisterColumn.
//
//	Table   -- the source table
//	IDCol   -- the primary-key column used in UPDATE ... WHERE
//	BlobCol -- the bytea column holding v=0x03 envelopes
//	TenantCol -- the tenant_id column (always 'tenant_id' today,
//	              kept configurable for future tables that name it
//	              differently)
//
// All identifiers are interpolated into SQL with strict allow-list
// validation (see validateIdent). Operators only call
// RegisterColumn from trusted boot code, but the validator is a
// belt-and-braces guard against typos that would otherwise produce
// confusing pg syntax errors.
type EncryptedColumn struct {
	Table     string
	IDCol     string
	BlobCol   string
	TenantCol string
}

// ReencryptCipher is the narrow surface the job needs from the
// composite cipher. *Composite satisfies it. Keeping it as an
// interface avoids a circular reference if future ciphers want to
// drive the sweep.
type ReencryptCipher interface {
	DecryptForTenant(ctx context.Context, tenantID string, blob []byte) ([]byte, error)
	EncryptForTenant(ctx context.Context, tenantID string, plaintext []byte) ([]byte, error)
}

// Reencryptor runs the background re-wrap sweep.
type Reencryptor struct {
	Pool    *db.Pool
	Cipher  ReencryptCipher
	Repo    *Repo
	columns []EncryptedColumn
	// BatchSize caps how many rows we re-encrypt per (tenant, column)
	// per tick. Default 50 — small enough to keep the KMS call rate
	// well below the AWS default quota (1000 ops/sec per region).
	BatchSize int
	// Interval is how long the loop sleeps between ticks.
	// Default 5 minutes — rotation is not time-critical; we trade
	// latency for predictable cost.
	Interval time.Duration
}

// RegisterColumn adds a (table, blob_column) to the sweep set.
// Safe to call only at boot; not goroutine-safe.
func (r *Reencryptor) RegisterColumn(c EncryptedColumn) error {
	if r == nil {
		return errors.New("byok reencryptor: nil receiver")
	}
	if err := validateIdent(c.Table); err != nil {
		return fmt.Errorf("table: %w", err)
	}
	if err := validateIdent(c.IDCol); err != nil {
		return fmt.Errorf("id_col: %w", err)
	}
	if err := validateIdent(c.BlobCol); err != nil {
		return fmt.Errorf("blob_col: %w", err)
	}
	if c.TenantCol == "" {
		c.TenantCol = "tenant_id"
	}
	if err := validateIdent(c.TenantCol); err != nil {
		return fmt.Errorf("tenant_col: %w", err)
	}
	r.columns = append(r.columns, c)
	return nil
}

// Columns returns the registered columns (read-only view for tests).
func (r *Reencryptor) Columns() []EncryptedColumn {
	out := make([]EncryptedColumn, len(r.columns))
	copy(out, r.columns)
	return out
}

// Run drives the sweep loop until ctx is cancelled. No-op when no
// columns are registered (the steady-state today). Safe to call from
// safego.Go in main.go.
func (r *Reencryptor) Run(ctx context.Context) {
	if r == nil || r.Cipher == nil || r.Repo == nil || r.Pool == nil {
		return
	}
	interval := r.Interval
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			r.sweepOnce(ctx)
		}
	}
}

// sweepOnce runs one pass across every registered column and every
// tenant with an inactive key. Surfaced as its own function so tests
// can drive a single iteration without involving the ticker.
func (r *Reencryptor) sweepOnce(ctx context.Context) {
	if len(r.columns) == 0 {
		return
	}
	tenants, err := r.tenantsWithInactiveKeys(ctx)
	if err != nil {
		slog.Warn("byok reencrypt: tenant scan failed", "err", err.Error())
		return
	}
	for _, tenantID := range tenants {
		for _, col := range r.columns {
			n, rerr := r.reencryptBatch(ctx, tenantID, col)
			if rerr != nil {
				slog.Warn("byok reencrypt batch failed",
					"tenant_id", tenantID,
					"table", col.Table,
					"err", rerr.Error())
				continue
			}
			if n > 0 {
				slog.Info("byok reencrypt batch",
					"tenant_id", tenantID,
					"table", col.Table,
					"rows", n)
			}
		}
	}
}

// tenantsWithInactiveKeys returns the tenants that have at least one
// inactive KEK + at least one active KEK. Tenants with only an
// active key have nothing to migrate; tenants with only inactive
// keys can't write the new blob (no active key to encrypt under).
func (r *Reencryptor) tenantsWithInactiveKeys(ctx context.Context) ([]string, error) {
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT DISTINCT a.tenant_id::text
  FROM tenant_keys a
  JOIN tenant_keys b ON a.tenant_id = b.tenant_id
 WHERE a.status = 'inactive'
   AND b.status = 'active'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// reencryptBatch reads up to BatchSize blobs belonging to tenantID
// whose embedded key_id matches an inactive key, decrypts under the
// (still-readable) old key, and re-encrypts under whatever EncryptForTenant
// resolves as the current active key. Returns the count of rows
// migrated.
func (r *Reencryptor) reencryptBatch(ctx context.Context, tenantID string, col EncryptedColumn) (int, error) {
	batch := r.BatchSize
	if batch <= 0 {
		batch = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	selectSQL := fmt.Sprintf(`
SELECT %s::text, %s
  FROM %s
 WHERE %s = $1::uuid
   AND %s IS NOT NULL
   AND octet_length(%s) >= 2 + get_byte(%s, 1)
   AND substring(%s from 1 for 1) = E'\\x03'
   AND substring(%s from 3 for get_byte(%s, 1)) IN (
       SELECT convert_to(id::text, 'UTF8')
         FROM tenant_keys
        WHERE tenant_id = $1::uuid AND status = 'inactive'
   )
 FOR UPDATE SKIP LOCKED
 LIMIT $2`,
		col.IDCol, col.BlobCol, col.Table, col.TenantCol,
		col.BlobCol, col.BlobCol, col.BlobCol, col.BlobCol,
		col.BlobCol, col.BlobCol)
	rows, err := tx.Query(ctx, selectSQL, tenantID, batch)
	if err != nil {
		return 0, err
	}
	type rowItem struct {
		ID   string
		Blob []byte
	}
	var items []rowItem
	for rows.Next() {
		var it rowItem
		if err := rows.Scan(&it.ID, &it.Blob); err != nil {
			rows.Close()
			return 0, err
		}
		items = append(items, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(items) == 0 {
		return 0, tx.Commit(ctx)
	}

	updateSQL := fmt.Sprintf(`UPDATE %s SET %s = $1 WHERE %s = $2 AND %s = $3`,
		col.Table, col.BlobCol, col.IDCol, col.BlobCol)
	migrated := 0
	for _, it := range items {
		plain, derr := r.Cipher.DecryptForTenant(ctx, tenantID, it.Blob)
		if derr != nil {
			// Skip blobs we can't decrypt — they may be under a
			// since-deleted KEK, or already in the new format
			// (race with another worker). Both are recoverable
			// by re-running next tick.
			continue
		}
		fresh, eerr := r.Cipher.EncryptForTenant(ctx, tenantID, plain)
		// Zero the plaintext after re-wrap.
		for i := range plain {
			plain[i] = 0
		}
		if eerr != nil {
			continue
		}
		// Skip if the new blob would be identical (somehow
		// already migrated). The WHERE clause's blob match also
		// guards against this race.
		if bytesEqual(fresh, it.Blob) {
			continue
		}
		tag, uerr := tx.Exec(ctx, updateSQL, fresh, it.ID, it.Blob)
		if uerr != nil {
			return migrated, uerr
		}
		if tag.RowsAffected() == 1 {
			migrated++
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return migrated, err
	}
	return migrated, nil
}

// CountKeyReferences counts registered ciphertext blobs whose v=0x03 header
// embeds keyID. The delete endpoint requires a zero count before retirement,
// preventing provider-side key removal from making customer data unreadable.
func (r *Reencryptor) CountKeyReferences(ctx context.Context, tenantID, keyID string) (int64, error) {
	if r == nil || r.Pool == nil {
		return 0, errors.New("byok reencryptor: retirement verification is not configured")
	}
	if len(r.columns) == 0 {
		return 0, errors.New("byok reencryptor: no encrypted columns are registered")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var total int64
	for _, col := range r.columns {
		query := fmt.Sprintf(`
SELECT count(*)
  FROM %s
 WHERE %s = $1::uuid
   AND %s IS NOT NULL
   AND octet_length(%s) >= 2 + get_byte(%s, 1)
   AND substring(%s from 1 for 1) = E'\\x03'
   AND substring(%s from 3 for get_byte(%s, 1)) = convert_to($2, 'UTF8')`,
			col.Table, col.TenantCol, col.BlobCol, col.BlobCol, col.BlobCol,
			col.BlobCol, col.BlobCol, col.BlobCol)
		var count int64
		if err := tx.QueryRow(ctx, query, tenantID, keyID).Scan(&count); err != nil {
			return 0, err
		}
		total += count
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return total, nil
}

// validateIdent enforces a strict SQL-identifier allow-list. Only
// lowercase letters, digits, and underscore; must start with a
// letter; max 63 characters (Postgres NAMEDATALEN). Rejects every
// shape that could embed a quote or whitespace, which is what makes
// the fmt.Sprintf interpolation in reencryptBatch safe.
func validateIdent(s string) error {
	if s == "" {
		return errors.New("identifier empty")
	}
	if len(s) > 63 {
		return errors.New("identifier too long")
	}
	for i, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
		case r == '_':
		case r >= '0' && r <= '9' && i > 0:
		default:
			return fmt.Errorf("identifier contains invalid char %q", r)
		}
	}
	return nil
}

// bytesEqual is a tiny local helper so the re-encrypt path doesn't
// pull in bytes.Equal (avoids an import for one call site).
func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
