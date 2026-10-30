// SPDX-License-Identifier: AGPL-3.0-only
//
// Package auditsink streams audit_log rows to external sinks and
// maintains a tamper-evident Merkle hash-chain over the table.
//
// # Sinks
//
// audit_sinks rows declare a destination:
//
//   kind = 's3'      → SigV4-signed PUT to a versioned bucket.
//   kind = 'datadog' → DD-API-KEY POST to https://http-intake.logs.<site>/api/v2/logs.
//   kind = 'splunk'  → Authorization: Splunk <token> POST to HEC.
//   kind = 'http'    → generic JSON POST (with HMAC-SHA256 signature header).
//
// The worker tails audit_log per tenant using a cursor stored in
// the audit_sinks.config JSONB column ("last_audit_id"). Failed
// deliveries increment consecutive_failures; when that crosses
// AutoDisableAfter the sink is auto-disabled (enabled=false) so a
// broken integration can't pin the worker on its tenant forever.
//
// # Cipher seam
//
// Credentials (API keys, HEC tokens, AWS secret keys) are stored
// encrypted in audit_sinks.encrypted_credentials. The Cipher
// interface is satisfied by the platform's BYOK composite cipher
// (apps/api/internal/byok). Tests pass a no-op fake.
//
// # Merkle hash-chain
//
// merkle.go implements the tamper-evidence layer. Each audit_log
// row carries prev_hash + row_hash, where:
//
//   row_hash = sha256(CanonicalBytes(row) || prev_hash)
//
// CanonicalBytes serializes a fixed field set with length-prefixed
// strings + big-endian fixed-width integers — every reader/verifier
// produces byte-identical input. The MerkleWorker periodically:
//
//   1. Backfills row_hash / prev_hash for rows with NULL chain
//      columns (oldest-first).
//   2. Snapshots the tip of the chain into audit_merkle_roots so
//      a verifier can pick a signed root and replay the chain
//      backward to confirm an individual row's integrity.
//
// Tampering with row N breaks every row > N — TestMerkleChain_DetectsMiddleTamper
// codifies this invariant.

package auditsink
