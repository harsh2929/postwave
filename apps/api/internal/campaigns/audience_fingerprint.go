// SPDX-License-Identifier: AGPL-3.0-only
package campaigns

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// An approval must bind WHO the campaign goes to, not just which segment id.
//
// The approval fingerprint was `subject + body_html + segment_id`. That covers
// the content and the NAME of the audience, and nothing about its meaning: a
// segment's `query_ast` is editable at any time, so between "approved" and
// "send" an editor can rewrite the definition from "customers who bought last
// month" to "everyone", and the gate sees an unchanged fingerprint and lets it
// through. The approver signed off on a message to one group; a different group
// receives it. Nothing in the audit trail shows a discrepancy, because by every
// value the gate compares, nothing changed.
//
// This is the smallest honest fix and deliberately NOT a revisions table. The
// post-approval-edit guard already exists and already works; it was simply
// being fed an input that could not detect this. Hashing the definition makes
// the existing machinery cover the audience. Immutable revisions bound by id
// remain the better long-term shape — they let an approval point at exactly
// what was reviewed rather than merely detect that it moved — but they are a
// schema change, and detecting the change is what stops the send today.
//
// WHY NOT HASH THE RESOLVED MEMBER LIST. Because a dynamic segment is SUPPOSED
// to drift: a subscriber joining "customers who bought last month" between
// approval and send is the feature working, and blocking on it would make every
// approval unusable within minutes. What must not change unnoticed is the
// DEFINITION — the rule the approver actually reviewed. Static freezes
// (audience_mode='static') are the opt-in for pinning membership itself.

// ErrSegmentDefinitionUnavailable is returned when the audience digest cannot
// be computed. Callers must FAIL CLOSED on it: falling back to a fingerprint
// that omits the audience silently restores the very gap this closes, and it
// would do so precisely when something is already wrong.
var ErrSegmentDefinitionUnavailable = errors.New("campaigns: segment definition unavailable for approval fingerprint")

// AudienceDigest returns a stable hash of the segment definition a campaign
// sends to, for inclusion in the approval fingerprint.
//
// An empty segmentID yields an empty digest: a workspace-wide campaign has no
// segment definition to bind, and inventing a token for "no segment" would make
// the fingerprint differ from itself across releases for no reason.
func (r *Repo) AudienceDigest(ctx context.Context, tenantID, segmentID string) (string, error) {
	tenantID = strings.TrimSpace(tenantID)
	segmentID = strings.TrimSpace(segmentID)
	if segmentID == "" {
		return "", nil
	}
	if tenantID == "" {
		return "", errors.New("audience digest: tenant id required")
	}
	if r == nil || r.Pool == nil {
		return "", ErrSegmentDefinitionUnavailable
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// `query_ast::text` renders jsonb in Postgres's own normalised form — keys
	// sorted, insignificant whitespace gone — so a cosmetic re-save that
	// reorders keys does not read as an audience change and force a pointless
	// re-approval. A semantic edit always changes the text.
	var ast string
	err = tx.QueryRow(ctx, `
SELECT COALESCE(query_ast::text, '')
  FROM segments
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, segmentID).Scan(&ast)
	if errors.Is(err, pgx.ErrNoRows) {
		// The segment referenced by the campaign is gone. That is a genuine
		// change of audience — from "these people" to "nobody, or an error" —
		// so it must invalidate the approval rather than be treated as
		// unchanged.
		return "", ErrSegmentDefinitionUnavailable
	}
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return HashAudienceDefinition(ast), nil
}

// HashAudienceDefinition renders a segment definition as a fingerprint input.
//
// Exported so a test can assert the digest changes for a semantic edit and
// holds for a cosmetic one without needing a database.
func HashAudienceDefinition(queryAST string) string {
	trimmed := strings.TrimSpace(queryAST)
	if trimmed == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(trimmed))
	return hex.EncodeToString(sum[:])
}

// AudienceFingerprint hashes the WHOLE audience selector, not just the segment.
//
// The first version bound `segment_id` plus the segment's definition, and an
// adversarial review showed that covered one of four ways a campaign chooses
// who receives it:
//
//   - A LIST campaign has an empty segment_id, so its fingerprint was
//     bit-identical to the pre-change hash. Zero new protection for a whole
//     class of sends.
//   - `audience_mode` is PATCH-editable. Approving a `static` campaign — whose
//     membership is pinned and was reviewed — and then flipping it to
//     `dynamic` re-resolves the live segment at send time, a different audience
//     with an unchanged fingerprint.
//   - `frozen_freeze_id` is likewise editable, and re-freezing mints a NEW
//     freeze row (segment_static_freezes INSERT), so binding the id detects a
//     swapped membership set.
//   - Worse, for a STATIC campaign the freeze is authoritative and the segment
//     is irrelevant — so hashing only the segment gave a false POSITIVE on a
//     harmless segment edit and a false NEGATIVE on a swapped freeze. Both
//     wrong, in opposite directions.
//
// Only the fields that actually select recipients are hashed, in the same
// branch order the resolver uses, so the digest answers exactly the question
// "would this send reach a different set of people?".
func (r *Repo) AudienceFingerprint(ctx context.Context, tenantID string, c *Campaign) (string, error) {
	if c == nil {
		return "", errors.New("audience fingerprint: campaign required")
	}
	mode := strings.ToLower(strings.TrimSpace(c.AudienceMode))
	listID := strings.TrimSpace(c.AudienceListID())
	segmentID := strings.TrimSpace(c.SegmentID)

	// STATIC: the freeze IS the audience. The segment it was built from may
	// change freely afterwards without changing who receives the campaign, and
	// binding it would force re-approvals that protect nobody.
	if mode == "static" {
		return "static:" + strings.TrimSpace(c.FrozenFreezeID), nil
	}
	if listID != "" {
		// A list's membership is not hashed: adding a subscriber to a list
		// between approval and send is the same expected drift as a subscriber
		// qualifying for a dynamic segment. WHICH list is the decision that was
		// reviewed.
		return "list:" + listID, nil
	}
	if segmentID != "" {
		digest, err := r.AudienceDigest(ctx, tenantID, segmentID)
		if err != nil {
			return "", err
		}
		return "segment:" + segmentID + ":" + digest, nil
	}
	// Workspace-wide. Nothing selects; everyone enabled receives it.
	return "workspace", nil
}

// DeliveredVariantsDigest hashes the variants a recipient ACTUALLY receives.
//
// Not `campaigns.variants`. That field is create/update passthrough and is read
// by nothing in the send path — an adversarial review traced it. The delivered
// A/B content lives in `campaign_variants`, which `sending.loadCampaignBodies`
// joins to resolve each recipient's subject and body:
//
//	COALESCE(NULLIF(v.subject, ''), c.subject)
//	COALESCE(NULLIF(v.body_html, ''), c.body_html)
//
// So the first version of this protection hashed a field that does not affect
// what anyone receives, while the scenario its own comment described —
// "approving two variants and then editing one puts unreviewed content in front
// of a share of the audience" — went on being completely uncovered. A digest
// over the wrong table is worse than none: it reads as protection.
//
// Every column that changes what a recipient sees is included, plus `weight`
// (which changes HOW MANY people see each arm — a reviewer approving a 50/50
// split did not approve 95/5) and the send-time offset. Ordered by label so the
// row order the planner happens to return cannot move the hash.
func (r *Repo) DeliveredVariantsDigest(ctx context.Context, tenantID, campaignID string) (string, error) {
	tenantID = strings.TrimSpace(tenantID)
	campaignID = strings.TrimSpace(campaignID)
	if tenantID == "" || campaignID == "" {
		return "", nil
	}
	if r == nil || r.Pool == nil {
		return "", ErrSegmentDefinitionUnavailable
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT variant_label,
       COALESCE(subject, ''), COALESCE(from_name, ''), COALESCE(from_email, ''),
       COALESCE(body_html, ''), COALESCE(body_mjml, ''),
       COALESCE(weight, 0), COALESCE(send_time_offset_minutes, 0)
  FROM campaign_variants
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
 ORDER BY variant_label`, tenantID, campaignID)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	h := sha256.New()
	any := false
	for rows.Next() {
		var label, subject, fromName, fromEmail, bodyHTML, bodyMJML string
		var weight, offset int
		if err := rows.Scan(&label, &subject, &fromName, &fromEmail,
			&bodyHTML, &bodyMJML, &weight, &offset); err != nil {
			return "", err
		}
		any = true
		_, _ = fmt.Fprintf(h, "%s\x00%s\x00%s\x00%s\x00%s\x00%s\x00%d\x00%d\x1e",
			label, subject, fromName, fromEmail, bodyHTML, bodyMJML, weight, offset)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	if !any {
		// No variants is not "unknown variants" — it is a campaign with none,
		// and it must hash the same as it did before this existed.
		return "", nil
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
