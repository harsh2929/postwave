// SPDX-License-Identifier: AGPL-3.0-only

package engagementhoneypot

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	ec "github.com/postwave/postwave/apps/api/internal/engagementclassification"
)

// Repo is the database-backed FetchRecorder plus the exporter's read side.
type Repo struct {
	Pool *db.Pool
}

// Both roles asserted at compile time: the recorder feeds evidence in and the
// lister feeds it out, and a signature drifting on either side should fail the
// build rather than a quarterly export.
var (
	_ FetchRecorder = (*Repo)(nil)
	_ FetchLister   = (*Repo)(nil)
)

// RecordFetch appends one decoy fetch, tenant-scoped from the SIGNED token
// rather than from anything the unauthenticated caller asserted.
//
// First write wins. A scanner fetches both decoys and retries, and a gateway
// may re-scan the same message days later; the unique index collapses those to
// the first arrival, which is the fetch whose latency relative to delivery
// still carries information. DO NOTHING rather than DO UPDATE for exactly that
// reason — a later retry must not overwrite the earlier observation.
func (r *Repo) RecordFetch(ctx context.Context, fetch Fetch) error {
	if r == nil || r.Pool == nil {
		return errors.New("engagementhoneypot: Repo requires a pool")
	}
	if fetch.Claim.TenantID == "" {
		return errors.New("engagementhoneypot: tenant id is required")
	}
	if !fetch.Claim.Technique.Certifies() {
		// Refuse at the boundary. A row that can never certify is not evidence,
		// and storing it invites a future reader to treat presence in this
		// table as sufficient.
		return fmt.Errorf("%w: refusing to store a %q decoy fetch",
			ErrInvalidInput, fetch.Claim.Technique)
	}

	tx, err := db.WithTenant(ctx, r.Pool, fetch.Claim.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
INSERT INTO engagement_honeypot_fetches (
    tenant_id, campaign_id, recipient_identity_hmac, technique,
    token_issued_at, fetched_at, user_agent, ip,
    network_asn, network_asn_source, network_region, reverse_dns, tls_ja4
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, NULLIF($7,''), NULLIF($8,''),
          $9, NULLIF($10,''), NULLIF($11,''), NULLIF($12,''), NULLIF($13,''))
ON CONFLICT (tenant_id, campaign_id, recipient_identity_hmac, technique) DO NOTHING`,
		fetch.Claim.TenantID, fetch.Claim.CampaignID, fetch.Claim.RecipientIdentityHMAC,
		string(fetch.Claim.Technique), fetch.Claim.IssuedAt.UTC(), fetch.FetchedAt.UTC(),
		fetch.UserAgent, fetch.IP, fetch.NetworkASN, string(fetch.NetworkASNSource),
		fetch.NetworkRegion, fetch.ReverseDNS, fetch.TLSJA4,
	); err != nil {
		return fmt.Errorf("record honeypot fetch: %w", err)
	}
	return tx.Commit(ctx)
}

// ListFetches returns one tenant's evidence for a half-open window, oldest
// first, for the corpus exporter.
func (r *Repo) ListFetches(
	ctx context.Context, tenantID string, from, until time.Time, limit int,
) ([]Fetch, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("engagementhoneypot: Repo requires a pool")
	}
	if limit <= 0 || limit > 100_000 {
		limit = 100_000
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT campaign_id::text, recipient_identity_hmac, technique, token_issued_at,
       fetched_at, COALESCE(user_agent,''), COALESCE(ip,''), network_asn,
       COALESCE(network_asn_source,''), COALESCE(network_region,''),
       COALESCE(reverse_dns,''), COALESCE(tls_ja4,'')
  FROM engagement_honeypot_fetches
 WHERE tenant_id = $1::uuid AND fetched_at >= $2 AND fetched_at < $3
 ORDER BY fetched_at, id
 LIMIT $4`, tenantID, from.UTC(), until.UTC(), limit)
	if err != nil {
		return nil, fmt.Errorf("list honeypot fetches: %w", err)
	}
	defer rows.Close()

	var out []Fetch
	for rows.Next() {
		var fetch Fetch
		var technique, asnSource string
		if err := rows.Scan(
			&fetch.Claim.CampaignID, &fetch.Claim.RecipientIdentityHMAC, &technique,
			&fetch.Claim.IssuedAt, &fetch.FetchedAt, &fetch.UserAgent, &fetch.IP,
			&fetch.NetworkASN, &asnSource, &fetch.NetworkRegion,
			&fetch.ReverseDNS, &fetch.TLSJA4,
		); err != nil {
			return nil, fmt.Errorf("scan honeypot fetch: %w", err)
		}
		fetch.Claim.TenantID = tenantID
		fetch.Claim.Technique = Technique(technique)
		fetch.NetworkASNSource = networkASNSource(asnSource)
		out = append(out, fetch)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read honeypot fetches: %w", err)
	}
	return out, nil
}

// networkASNSource keeps a stored NULL from becoming an empty enum value. The
// calibration loader refuses an ASN whose origin nobody can state, and an
// unattributed number setting a threshold is exactly what that rule exists to
// prevent — so an absent source reads as "unmeasured" rather than as blank.
func networkASNSource(stored string) ec.NetworkASNSource {
	if stored == "" {
		return ec.NetworkASNUnmeasured
	}
	return ec.NetworkASNSource(stored)
}
