// SPDX-License-Identifier: AGPL-3.0-only
//
// export_manifest.go — signed manifests for audit CSV export bundles.
//
// When an operator hits POST /api/v1/audit/export?include_manifest=true,
// the handler streams CSV plus a JSON manifest. The manifest is the
// audit trail of "yes, the CSV the operator just downloaded covers
// rows [from..to], here is the root that signs it, and here is the
// kid you can verify against".
//
// Signing strategy: reuses the existing Standard Webhooks signing key
// machinery (audit_sink_signing_keys). The HMAC-SHA256 secret signs
// the canonical manifest bytes (everything except the `signature`
// field itself). Verifiers fetch the JWKS for the signing sink — same
// key surface SIEM receivers already use to verify webhook deliveries.
//
// For tenants without a signing key wired (no HTTP sink), the manifest
// still carries the row-hash bundle but signature/signature_kid are
// empty. The audit_export_manifests row records this fact so the
// auditor can see "exported, but unsigned — wire a sink to enable
// signed bundles".

package auditsink

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ManifestRow is one entry per exported audit_log row. Mirrors the
// CSV columns plus the row_hash / prev_hash from the Merkle chain so
// a verifier can recompute the chain locally without re-running the
// original SQL query.
type ManifestRow struct {
	ID       int64  `json:"id"`
	At       string `json:"at"`
	RowHash  string `json:"row_hash,omitempty"`
	PrevHash string `json:"prev_hash,omitempty"`
}

// ManifestRoot captures the Merkle root that covers the exported
// range at export time. Lets verifiers fetch the corresponding
// audit_merkle_roots row via the inclusion-proof API and confirm the
// chain is intact.
type ManifestRoot struct {
	TreeSize int64  `json:"tree_size"`
	RootHash string `json:"root_hash_hex"`
	RootedAt string `json:"rooted_at,omitempty"`
}

// ExportManifest is the on-disk JSON shape written alongside the CSV.
// Canonical-byte computation deliberately excludes `Signature` and
// `SignatureKid` — the signature signs everything else.
type ExportManifest struct {
	Version          int            `json:"version"`
	TenantID         string         `json:"tenant_id"`
	ExportID         string         `json:"export_id"`
	FiltersCanonical map[string]any `json:"filters_canonical"`
	FromAuditID      int64          `json:"from_audit_id"`
	ToAuditID        int64          `json:"to_audit_id"`
	RowCount         int64          `json:"row_count"`
	Root             ManifestRoot   `json:"root"`
	Rows             []ManifestRow  `json:"rows,omitempty"`
	ExportedAt       string         `json:"exported_at"`
	ExportedBy       string         `json:"exported_by,omitempty"`
	Signature        string         `json:"signature_b64,omitempty"`
	SignatureKid     string         `json:"signature_kid,omitempty"`
}

// canonicalBytes returns the bytes the signature covers. We strip
// the Signature/SignatureKid fields by re-encoding via a shadow type
// so the verifier reconstructs them deterministically.
func (m *ExportManifest) canonicalBytes() ([]byte, error) {
	type canon struct {
		Version          int            `json:"version"`
		TenantID         string         `json:"tenant_id"`
		ExportID         string         `json:"export_id"`
		FiltersCanonical map[string]any `json:"filters_canonical"`
		FromAuditID      int64          `json:"from_audit_id"`
		ToAuditID        int64          `json:"to_audit_id"`
		RowCount         int64          `json:"row_count"`
		Root             ManifestRoot   `json:"root"`
		Rows             []ManifestRow  `json:"rows,omitempty"`
		ExportedAt       string         `json:"exported_at"`
		ExportedBy       string         `json:"exported_by,omitempty"`
	}
	c := canon{
		Version:          m.Version,
		TenantID:         m.TenantID,
		ExportID:         m.ExportID,
		FiltersCanonical: m.FiltersCanonical,
		FromAuditID:      m.FromAuditID,
		ToAuditID:        m.ToAuditID,
		RowCount:         m.RowCount,
		Root:             m.Root,
		Rows:             m.Rows,
		ExportedAt:       m.ExportedAt,
		ExportedBy:       m.ExportedBy,
	}
	return json.Marshal(c)
}

// ExportManifestInput is the bundle of facts the writer needs. Kept
// distinct from the on-disk manifest so the caller doesn't accidentally
// pass through fields (like Signature) that the writer is supposed to
// fill in.
type ExportManifestInput struct {
	TenantID   string
	ExportID   string
	Filters    map[string]any
	Rows       []ManifestRow
	ExportedBy string
	// SinkID picks which audit_sink_signing_keys row signs the manifest.
	// When empty, the writer scans for the most recent active key across
	// any sink for this tenant. When no key exists, the manifest is
	// emitted unsigned (best-effort).
	SinkID string
}

// ExportManifestWriter materialises + signs export manifests. Wraps
// the same Deps the worker uses so it can reuse activeSigningKey /
// decryptSecret without re-implementing key handling.
type ExportManifestWriter struct {
	Deps *Deps
}

// WriteManifest produces a signed ExportManifest for the given row
// set, records a row in audit_export_manifests, and returns the
// in-memory manifest ready for serving alongside the CSV.
//
// The writer is best-effort on the signing side: if no signing key is
// available, the manifest still carries the row hashes + Merkle root
// and is recorded with empty signature. Callers can branch on
// manifest.Signature == "" if they want to surface "unsigned export"
// in the UI.
func (w *ExportManifestWriter) WriteManifest(ctx context.Context, in ExportManifestInput) (*ExportManifest, error) {
	if w == nil || w.Deps == nil || w.Deps.Pool == nil {
		return nil, fmt.Errorf("export manifest writer: deps required")
	}
	if strings.TrimSpace(in.TenantID) == "" {
		return nil, fmt.Errorf("export manifest writer: tenant_id required")
	}
	if in.ExportID == "" {
		in.ExportID = newExportID()
	}
	if in.Filters == nil {
		in.Filters = map[string]any{}
	}

	from, to := manifestRange(in.Rows)
	root, err := w.lookupRoot(ctx, in.TenantID, to)
	if err != nil {
		// Don't fail the export on root-lookup miss — older tenants
		// may have no roots yet. Surface as empty root.
		root = ManifestRoot{}
	}
	m := &ExportManifest{
		Version:          1,
		TenantID:         in.TenantID,
		ExportID:         in.ExportID,
		FiltersCanonical: canonicaliseFilters(in.Filters),
		FromAuditID:      from,
		ToAuditID:        to,
		RowCount:         int64(len(in.Rows)),
		Root:             root,
		Rows:             in.Rows,
		ExportedAt:       time.Now().UTC().Format(time.RFC3339),
		ExportedBy:       in.ExportedBy,
	}

	// Sign with the tenant's active signing key (if any).
	secret, kid, signErr := w.lookupSigningKey(ctx, in.TenantID, in.SinkID)
	if signErr == nil && len(secret) > 0 {
		canonical, err := m.canonicalBytes()
		if err != nil {
			return nil, fmt.Errorf("canonical bytes: %w", err)
		}
		mac := hmac.New(sha256.New, secret)
		mac.Write(canonical)
		m.Signature = hex.EncodeToString(mac.Sum(nil))
		m.SignatureKid = kid
	}

	// Persist the manifest row. Best-effort — a DB error here does
	// not block the operator's download (the in-memory manifest is
	// what they're about to consume).
	rootHashBytes, _ := hex.DecodeString(strings.TrimSpace(m.Root.RootHash))
	if rootHashBytes == nil {
		rootHashBytes = []byte{}
	}
	var sigBytes []byte
	if m.Signature != "" {
		sigBytes, _ = hex.DecodeString(m.Signature)
	}
	if persistErr := w.persist(ctx, in.TenantID, m, rootHashBytes, sigBytes); persistErr != nil && w.Deps.Logger != nil {
		w.Deps.Logger.Warn("audit export manifest persist failed",
			"tenant", in.TenantID, "export_id", m.ExportID, "err", persistErr.Error())
	}
	return m, nil
}

// VerifyManifest is the inverse: caller passes a manifest blob, the
// active signing secret for the kid, and we confirm the HMAC matches.
// Provided for test coverage + a future verify endpoint.
func VerifyManifest(m *ExportManifest, secret []byte) bool {
	if m == nil || m.Signature == "" || len(secret) == 0 {
		return false
	}
	canonical, err := m.canonicalBytes()
	if err != nil {
		return false
	}
	expectedHex, err := hex.DecodeString(m.Signature)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(canonical)
	return hmac.Equal(mac.Sum(nil), expectedHex)
}

// manifestRange returns the lowest + highest audit_log id in the row
// list. Returns (0, 0) when empty.
func manifestRange(rows []ManifestRow) (int64, int64) {
	if len(rows) == 0 {
		return 0, 0
	}
	from := rows[0].ID
	to := rows[0].ID
	for _, r := range rows[1:] {
		if r.ID < from {
			from = r.ID
		}
		if r.ID > to {
			to = r.ID
		}
	}
	return from, to
}

// canonicaliseFilters strips empty string values + sorts keys for a
// deterministic JSON encoding. Verifiers must be able to recompute the
// canonical bytes from the wire JSON; that means filter order can't
// be arbitrary.
func canonicaliseFilters(in map[string]any) map[string]any {
	if len(in) == 0 {
		return map[string]any{}
	}
	out := map[string]any{}
	keys := make([]string, 0, len(in))
	for k, v := range in {
		if s, ok := v.(string); ok && strings.TrimSpace(s) == "" {
			continue
		}
		if v == nil {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out[k] = in[k]
	}
	return out
}

// newExportID returns a YYYYMMDD-HHMMSS-<rand6> identifier. Random
// suffix avoids collisions for two operators clicking Export in the
// same second; <rand6> is 24 bits, ~16M slots per second of headroom.
func newExportID() string {
	var rnd [3]byte
	_, _ = rand.Read(rnd[:])
	return time.Now().UTC().Format("20060102-150405") + "-" + hex.EncodeToString(rnd[:])
}

// lookupRoot returns the smallest audit_merkle_roots row whose
// upto_audit_id >= toID for the tenant. Verifiers use the returned
// tree_size to fetch a consistency proof.
func (w *ExportManifestWriter) lookupRoot(ctx context.Context, tenantID string, toID int64) (ManifestRoot, error) {
	if toID == 0 {
		return ManifestRoot{}, nil
	}
	tx, err := db.WithTenant(ctx, w.Deps.Pool, tenantID)
	if err != nil {
		return ManifestRoot{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		treeSize int64
		rootHash []byte
		rootedAt time.Time
	)
	err = tx.QueryRow(ctx, `
SELECT tree_size, root_hash, rooted_at
  FROM audit_merkle_roots
 WHERE tenant_id = $1::uuid
   AND upto_audit_id >= $2
 ORDER BY upto_audit_id ASC
 LIMIT 1`, tenantID, toID).Scan(&treeSize, &rootHash, &rootedAt)
	if err != nil {
		return ManifestRoot{}, err
	}
	_ = tx.Commit(ctx)
	return ManifestRoot{
		TreeSize: treeSize,
		RootHash: hex.EncodeToString(rootHash),
		RootedAt: rootedAt.UTC().Format(time.RFC3339),
	}, nil
}

// lookupSigningKey returns the most recent active signing key for the
// tenant. If SinkID is non-empty, scoped to that sink; otherwise scans
// across all sinks. Returns ("", nil, err) when no key exists.
func (w *ExportManifestWriter) lookupSigningKey(ctx context.Context, tenantID, sinkID string) ([]byte, string, error) {
	tx, err := db.WithWorkerScope(ctx, w.Deps.Pool)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		kid      string
		envelope []byte
	)
	if sinkID == "" {
		err = tx.QueryRow(ctx, `
SELECT kid, secret_envelope
  FROM audit_sink_signing_keys
 WHERE tenant_id = $1::uuid
   AND revoked_at IS NULL
 ORDER BY rotated_at DESC
 LIMIT 1`, tenantID).Scan(&kid, &envelope)
	} else {
		err = tx.QueryRow(ctx, `
SELECT kid, secret_envelope
  FROM audit_sink_signing_keys
 WHERE tenant_id = $1::uuid
   AND sink_id = $2::uuid
   AND revoked_at IS NULL
 ORDER BY rotated_at DESC
 LIMIT 1`, tenantID, sinkID).Scan(&kid, &envelope)
	}
	if err != nil {
		return nil, "", err
	}
	// Release the database transaction before a KMS-backed decrypt.
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	secret, err := w.Deps.decryptSecret(ctx, envelope)
	if err != nil {
		return nil, "", err
	}
	return secret, kid, nil
}

// persist writes the audit_export_manifests row. Uses the tenant-scoped
// transaction so RLS catches misrouted writes.
func (w *ExportManifestWriter) persist(ctx context.Context, tenantID string, m *ExportManifest, rootHash, sig []byte) error {
	tx, err := db.WithTenant(ctx, w.Deps.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	filtersJSON, _ := json.Marshal(m.FiltersCanonical)
	_, err = tx.Exec(ctx, `
INSERT INTO audit_export_manifests
  (tenant_id, export_id, filters_canonical,
   from_audit_id, to_audit_id, row_count,
   tree_size_at_export, root_hash, signature, signature_kid,
   exported_by)
VALUES ($1::uuid, $2, $3::jsonb,
        $4, $5, $6,
        $7, $8::bytea, NULLIF($9, ''::bytea), NULLIF($10, ''),
        NULLIF($11, ''))
ON CONFLICT (tenant_id, export_id) DO NOTHING`,
		tenantID, m.ExportID, string(filtersJSON),
		m.FromAuditID, m.ToAuditID, m.RowCount,
		m.Root.TreeSize, rootHash, sig, m.SignatureKid,
		m.ExportedBy)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
