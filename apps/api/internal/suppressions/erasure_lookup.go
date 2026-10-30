// SPDX-License-Identifier: AGPL-3.0-only

package suppressions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

// ErasureQuerier is the read surface the erasure lookup needs: a tenant-scoped
// pgx.Tx satisfies it, so callers run the lookup inside the same transaction
// (and RLS scope) as the write it guards.
type ErasureQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// Erasure evidence lives in four places, and writers have used every one of
// them as the schemas evolved:
//
//   - email_suppressions: the per-reason store; subscriber deletes write a
//     'manual' row with metadata.gdpr_erasure=true and source gdpr_delete;
//   - subscriber_suppressions: the canonical send-time store; subscriber
//     deletes write a dsar_deletion row keyed by the plaintext address, and the
//     privacy-request worker writes one keyed only by SHA-256 after it has
//     removed the plaintext;
//   - suppressions: the oldest store, which the privacy worker still mirrors as
//     a hash-keyed dsar_deletion row;
//   - erasure_receipts: the immutable proof row a subscriber delete appends.
const (
	erasureStoreEmailSuppressions      = "email_suppressions"
	erasureStoreSubscriberSuppressions = "subscriber_suppressions"
	erasureStoreLegacySuppressions     = "suppressions"
	erasureStoreReceipts               = "erasure_receipts"
)

// erasureVocabularyStems are the fragments every reason, source and source
// prefix in the tombstone vocabulary contains (TestErasureCandidateFilter
// proves it). Normalization only lower-cases, trims and swaps '-' and ' ' for
// '_', none of which touch a stem, so a row whose reason and source contain no
// stem, and whose metadata is an object without any marker key, can't be a
// tombstone: the SQL leaves it out instead of shipping every bounce and
// complaint to Go.
var erasureVocabularyStems = []string{"dsar", "gdpr", "privacy", "forgotten", "rtbf"}

// erasureCandidateSQL is the SQL side of IsIrreversibleTombstone: a superset
// filter over one suppression row (alias x) that keeps every row the Go
// classification could accept. Metadata that is not a JSON object stays a
// candidate because the Go side fails closed on it.
func erasureCandidateSQL(withSourceAndMetadata bool) string {
	stems := "'(" + strings.Join(erasureVocabularyStems, "|") + ")'"
	clause := "lower(COALESCE(x.reason, '')) ~ " + stems
	if !withSourceAndMetadata {
		return clause
	}
	keys := append(append([]string{}, irreversibleMetadataFlags...), erasureIdentityMarkers...)
	return "(" + clause + `
        OR lower(COALESCE(x.source, '')) ~ ` + stems + `
        OR jsonb_typeof(x.metadata) <> 'object'
        OR x.metadata ?| ARRAY['` + strings.Join(keys, "','") + `'])`
}

// erasureMarkersSQL returns the candidate tombstones in those stores for the
// requested addresses; IsIrreversibleTombstone then decides which of them
// prove an erasure, so the batch and single-address boundaries classify with
// the same rules. $2 holds normalized addresses and $3 their SHA-256 in hex.
// A row found by plaintext reports its address; one found only by hash, the
// hash, which the caller maps back.
//
// Each store is matched once per key, as a plain restriction on that store
// rather than a join with an "address OR hash" condition: such a join can't be
// hashed, and against a large suppression list it degenerated into comparing
// every requested address with every suppression row of the tenant. As
// restrictions, "= ANY" hashes a large array, and the planner evaluates it
// ahead of the costlier candidate filter, so the filter only sees rows at a
// requested address and bounces and complaints never reach Go.
var erasureMarkersSQL = strings.Join([]string{
	erasureMarkerBranch(erasureStoreEmailSuppressions, "email_suppressions", false, true),
	erasureMarkerBranch(erasureStoreSubscriberSuppressions, "subscriber_suppressions", false, true),
	erasureMarkerBranch(erasureStoreSubscriberSuppressions, "subscriber_suppressions", true, true),
	erasureMarkerBranch(erasureStoreLegacySuppressions, "suppressions", false, false),
	erasureMarkerBranch(erasureStoreLegacySuppressions, "suppressions", true, false),
	`SELECT '', lower(x.email_hash), '` + erasureStoreReceipts + `', '', '', NULL::jsonb
  FROM erasure_receipts x
 WHERE x.tenant_id = $1::uuid AND lower(x.email_hash) = ANY($3::text[])`,
}, "\nUNION ALL\n")

// erasureMarkerBranch matches one suppression store by plaintext address or,
// with byHash, by the SHA-256 the privacy-request worker keeps once it has
// removed the plaintext. Only the canonical and the per-reason stores carry a
// source and metadata.
func erasureMarkerBranch(store, table string, byHash, withSourceAndMetadata bool) string {
	found, match := "lower(x.email::text), ''", "lower(x.email::text) = ANY($2::text[])"
	if byHash {
		found, match = "'', x.email_sha256::text", "x.email_sha256 = ANY($3::bpchar[])"
	}
	columns := "COALESCE(x.reason, ''), '', NULL::jsonb"
	if withSourceAndMetadata {
		columns = "COALESCE(x.reason, ''), COALESCE(x.source, ''), x.metadata"
	}
	return "SELECT " + found + ", '" + store + "', " + columns + `
  FROM ` + table + ` x
 WHERE x.tenant_id = $1::uuid AND ` + match + `
   AND ` + erasureCandidateSQL(withSourceAndMetadata)
}

type erasureMarker struct {
	email    string
	store    string
	reason   string
	source   string
	metadata []byte
}

// irreversible applies the one erasure classification every guard shares. A
// receipt exists only because an erasure happened; for the suppression stores
// the row's reason, source and metadata decide, and metadata that is not a
// JSON object fails closed exactly as RemoveLegacyByID does.
func (m erasureMarker) irreversible() bool {
	if m.store == erasureStoreReceipts {
		return true
	}
	metadata, valid := decodeRemovalMetadata(m.metadata)
	return !valid || IsIrreversibleTombstone(m.reason, m.source, metadata)
}

func loadErasureMarkers(ctx context.Context, q ErasureQuerier, tenantID string, addresses []string) ([]erasureMarker, error) {
	hashes := make([]string, len(addresses))
	byHash := make(map[string]string, len(addresses))
	for i, address := range addresses {
		digest := sha256.Sum256([]byte(address))
		hashes[i] = hex.EncodeToString(digest[:])
		byHash[hashes[i]] = address
	}
	// A btree scan over "= ANY" sorts its array first; lower-case hex already
	// in order costs it one pass instead of a collation-aware sort of a whole
	// file's worth of hashes.
	slices.Sort(hashes)
	rows, err := q.Query(ctx, erasureMarkersSQL, tenantID, addresses, hashes)
	if err != nil {
		return nil, fmt.Errorf("suppressions: read erasure evidence: %w", err)
	}
	defer rows.Close()
	markers := make([]erasureMarker, 0)
	for rows.Next() {
		var marker erasureMarker
		var hash string
		if err := rows.Scan(&marker.email, &hash, &marker.store, &marker.reason, &marker.source, &marker.metadata); err != nil {
			return nil, fmt.Errorf("suppressions: scan erasure evidence: %w", err)
		}
		if marker.email == "" {
			marker.email = byHash[strings.ToLower(strings.TrimSpace(hash))]
		}
		markers = append(markers, marker)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("suppressions: iterate erasure evidence: %w", err)
	}
	return markers, nil
}

// NormalizeErasureAddress is the address form the erasure stores key on: the
// trimmed, lower-cased mailbox (and, for hash-keyed tombstones, its SHA-256).
func NormalizeErasureAddress(address string) string {
	return strings.ToLower(strings.TrimSpace(address))
}

// ErasedAddresses reports which of the given addresses an irreversible erasure
// tombstone protects in the tenant. It is the batch form of the boundary
// RemoveLegacyByID enforces for one address, and the check every writer that
// can create a subscriber for an arbitrary address must make first: once a
// contact was deleted or erased by a privacy request, bringing the address
// back is a compliance decision, never a side effect of an import.
//
// The returned set is keyed by NormalizeErasureAddress. Run it inside the
// tenant-scoped transaction that performs the write so RLS confines the
// evidence to the tenant and the answer cannot go stale before the write.
func ErasedAddresses(ctx context.Context, q ErasureQuerier, tenantID string, addresses []string) (map[string]struct{}, error) {
	erased := make(map[string]struct{})
	if len(addresses) == 0 {
		return erased, nil
	}
	normalized := make([]string, 0, len(addresses))
	seen := make(map[string]struct{}, len(addresses))
	for _, address := range addresses {
		address = NormalizeErasureAddress(address)
		if _, dup := seen[address]; dup || address == "" {
			continue
		}
		seen[address] = struct{}{}
		normalized = append(normalized, address)
	}
	if len(normalized) == 0 {
		return erased, nil
	}
	markers, err := loadErasureMarkers(ctx, q, tenantID, normalized)
	if err != nil {
		return nil, err
	}
	for _, marker := range markers {
		if marker.irreversible() {
			erased[marker.email] = struct{}{}
		}
	}
	return erased, nil
}
