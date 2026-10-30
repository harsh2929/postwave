// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/approvals"
	"github.com/postwave/postwave/apps/api/internal/db"
)

// An approval must bind WHO the campaign goes to.
//
// The fingerprint was `subject + body_html + segment_id`: the content, and the
// NAME of the audience. A segment's `query_ast` is editable at any time, so
// between "approved" and "send" an editor could rewrite the rule from
// "customers who bought last month" to "everyone" and the gate would compare
// two identical fingerprints and let it through. The approver signed off on a
// message to one group; a different group receives it, and nothing in the trail
// shows a discrepancy — because by every value compared, nothing changed.

func seedSegment(t *testing.T, pool *db.Pool, tenantID, ast string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO segments (tenant_id, name, query_ast)
VALUES ($1::uuid, $2, $3::jsonb)
RETURNING id::text`, tenantID, "seg-"+uuid.NewString()[:8], ast).Scan(&id); err != nil {
		t.Fatalf("seed segment: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	return id
}

func seedFingerprintTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'fp', 'studio')`,
		tenantID, "fp-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	// Clean up after the test. Without this every `go test ./internal/campaigns/`
	// run leaves its tenants, campaigns and lease rows behind forever — an
	// adversarial review found ~80 accumulated lease rows in the shared verify
	// database. See deleteCampaignsTestTenant for why it deletes the child rows
	// first and the tenant last.
	t.Cleanup(func() { deleteCampaignsTestTenant(t, pool, tenantID) })
	return tenantID
}

// seedFingerprintCampaign creates a draft campaign bound to a segment.
func seedFingerprintCampaign(t *testing.T, pool *db.Pool, tenantID, segmentID string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, body_html, segment_id)
VALUES ($1::uuid, $2, 'Approved subject', 'draft', '<p>Body</p>', $3::uuid)
RETURNING id::text`, tenantID, "camp-"+uuid.NewString()[:8], segmentID).Scan(&id); err != nil {
		t.Fatalf("seed campaign: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit campaign: %v", err)
	}
	return id
}

func updateSegmentAST(t *testing.T, pool *db.Pool, tenantID, segmentID, ast string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE segments SET query_ast = $3::jsonb WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, segmentID, ast); err != nil {
		t.Fatalf("update segment: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func TestEditingASegmentAfterApprovalChangesTheFingerprint(t *testing.T) {
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	repo := &Repo{Pool: pool}

	// The audience the approver reviewed.
	segID := seedSegment(t, pool, tenantID,
		`{"op":"and","rules":[{"field":"purchased_at","op":"within_days","value":30}]}`)

	before, err := repo.AudienceDigest(context.Background(), tenantID, segID)
	if err != nil {
		t.Fatalf("digest before: %v", err)
	}
	approved := approvals.FingerprintCampaignAudience("Subject", "<p>Body</p>", segID, before)

	// The edit: same segment id, same campaign content, entirely different
	// people. "Customers who bought last month" becomes "everyone".
	updateSegmentAST(t, pool, tenantID, segID, `{"op":"and","rules":[]}`)

	after, err := repo.AudienceDigest(context.Background(), tenantID, segID)
	if err != nil {
		t.Fatalf("digest after: %v", err)
	}
	atSend := approvals.FingerprintCampaignAudience("Subject", "<p>Body</p>", segID, after)

	if atSend == approved {
		t.Fatal("the fingerprint did not move after the segment definition was " +
			"rewritten, so the approval gate would treat a send to a different " +
			"audience as the one that was approved")
	}
	// And the OLD recipe demonstrably cannot see it: same inputs before and
	// after the rewrite, because it never looked at the definition. Stated as
	// an assertion so reverting the call site to `FingerprintCampaign` is a
	// visible regression rather than a silent one.
	blindBefore := approvals.FingerprintCampaign("Subject", "<p>Body</p>", segID)
	blindAfter := approvals.FingerprintCampaign("Subject", "<p>Body</p>", segID)
	if blindBefore != blindAfter {
		t.Fatal("unreachable: the audience-blind recipe reads no state")
	}
	if blindAfter == atSend {
		t.Error("the audience-aware fingerprint equals the audience-blind one, " +
			"so the digest is not reaching the hash")
	}
}

func TestACosmeticResaveDoesNotInvalidateTheApproval(t *testing.T) {
	// The mirror failure, and the one that makes a guard unusable: if key order
	// or whitespace moved the digest, every save would force a re-approval and
	// operators would route around the gate.
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	repo := &Repo{Pool: pool}

	segID := seedSegment(t, pool, tenantID, `{"op":"and","rules":[],"note":"a"}`)
	before, err := repo.AudienceDigest(context.Background(), tenantID, segID)
	if err != nil {
		t.Fatalf("digest before: %v", err)
	}

	// Same document, keys written in a different order, extra whitespace.
	updateSegmentAST(t, pool, tenantID, segID, `{ "note" : "a" ,  "rules" : [] , "op" : "and" }`)

	after, err := repo.AudienceDigest(context.Background(), tenantID, segID)
	if err != nil {
		t.Fatalf("digest after: %v", err)
	}
	if before != after {
		t.Errorf("a cosmetic re-save moved the audience digest (%s → %s); every "+
			"save would force a re-approval", before, after)
	}
}

func TestADeletedSegmentFailsClosed(t *testing.T) {
	// A campaign whose segment has vanished has genuinely changed audience —
	// from "these people" to "nobody, or an error". Returning the historical
	// audience-blind fingerprint would let it send as if nothing happened.
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	repo := &Repo{Pool: pool}

	_, err := repo.AudienceDigest(context.Background(), tenantID, uuid.NewString())
	if !errors.Is(err, ErrSegmentDefinitionUnavailable) {
		t.Fatalf("err = %v, want ErrSegmentDefinitionUnavailable", err)
	}
}

func TestAWorkspaceWideCampaignKeepsItsHistoricalFingerprint(t *testing.T) {
	// No segment means no definition to bind. Inventing a token for "no
	// segment" would change the hash for every such campaign and invalidate
	// in-flight approvals for a case this does not affect.
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	repo := &Repo{Pool: pool}

	digest, err := repo.AudienceDigest(context.Background(), tenantID, "")
	if err != nil {
		t.Fatalf("digest: %v", err)
	}
	if digest != "" {
		t.Errorf("digest = %q, want empty for a campaign with no segment", digest)
	}
	withAudience := approvals.FingerprintCampaignAudience("S", "<p>B</p>", "", digest)
	historical := approvals.FingerprintCampaign("S", "<p>B</p>", "")
	if withAudience != historical {
		t.Error("adding the audience field changed the fingerprint of a " +
			"workspace-wide campaign, invalidating approvals it does not affect")
	}
}

// The path that actually sends must compare the fingerprint.
//
// This is the gap an adversarial review found after the fingerprint work had
// already been called done: `EnsureCampaignSendApproved` has one caller, behind
// `!opts.SkipApproval`, and the approval hook — which IS the send trigger in the
// default wiring — passes `SkipApproval: true`. So approve→edit→send, the exact
// sequence the fingerprint exists to stop, travelled the one path that never
// looked at it. Every earlier test hand-composed fingerprints and never called
// the send path at all, so deleting the whole fix left them green.

type fakeApprovalGate struct {
	storedHash string
	// seen records what the send path actually computed and passed in, so a
	// test can prove the comparison happened rather than trusting the verdict.
	seen []string
}

func (f *fakeApprovalGate) EnsureCampaignSendApproved(
	_ context.Context, _, _, _ string, _ ApprovalActor,
) (*ApprovalState, error) {
	return &ApprovalState{Approved: true}, nil
}

func (f *fakeApprovalGate) MarkApprovalConsumed(_ context.Context, _, _ string) error {
	return nil
}

func (f *fakeApprovalGate) VerifyApprovedFingerprint(
	_ context.Context, _, _, fingerprint string,
) (bool, error) {
	f.seen = append(f.seen, fingerprint)
	if f.storedHash == "" || fingerprint == "" {
		return true, nil
	}
	return f.storedHash == fingerprint, nil
}

// approvedFingerprint derives the hash exactly as the send path does.
func approvedFingerprint(t *testing.T, repo *Repo, tenantID, campaignID string) string {
	t.Helper()
	ctx := context.Background()
	c, err := repo.Get(ctx, tenantID, campaignID)
	if err != nil || c == nil {
		t.Fatalf("load campaign: %v", err)
	}
	audience, err := repo.AudienceFingerprint(ctx, tenantID, c)
	if err != nil {
		t.Fatalf("audience fingerprint: %v", err)
	}
	return approvals.FingerprintCampaignAudience(c.Subject, c.BodyHTML, c.SegmentID, audience)
}

func TestTheApprovalHookRefusesASendWhoseAudienceMoved(t *testing.T) {
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	repo := &Repo{Pool: pool}

	segID := seedSegment(t, pool, tenantID, `{"op":"and","rules":[{"field":"x","op":"eq","value":1}]}`)
	campaignID := seedFingerprintCampaign(t, pool, tenantID, segID)

	// What the approver signed off on.
	gate := &fakeApprovalGate{
		storedHash: approvedFingerprint(t, repo, tenantID, campaignID),
	}
	deps := &Deps{Repo: repo, Approvals: gate}

	// Same campaign, same content, different people.
	updateSegmentAST(t, pool, tenantID, segID, `{"op":"and","rules":[]}`)

	// Through QueueApprovedCampaign — the function the approval hook calls —
	// not through the helper. Calling the helper directly is what made the
	// FIRST version of this test useless: deleting the call site left it green,
	// which is precisely the defect this test was written to prevent.
	_, err := deps.QueueApprovedCampaign(context.Background(), tenantID, campaignID)
	if err == nil {
		t.Fatal("the approval hook sent a campaign whose audience was rewritten " +
			"after approval — the exact sequence the fingerprint exists to stop")
	}
	if !strings.Contains(err.Error(), "changed after it was approved") {
		t.Errorf("err = %v, want a message naming the post-approval change", err)
	}
	if len(gate.seen) != 1 {
		t.Errorf("the send path made %d fingerprint comparisons, want 1", len(gate.seen))
	}
}

func TestTheApprovalHookSendsWhenNothingMoved(t *testing.T) {
	// The mirror failure, and the more damaging one in production: refusing
	// every approved send would stop the product working.
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	repo := &Repo{Pool: pool}

	segID := seedSegment(t, pool, tenantID, `{"op":"and","rules":[]}`)
	campaignID := seedFingerprintCampaign(t, pool, tenantID, segID)

	// Derived through the SAME function production uses. Hand-composing the
	// hash is what made this test fail when the digest gained the list and
	// freeze selectors — a test that re-implements the thing it checks drifts
	// from it, which is the defect this whole row is about.
	approved := approvedFingerprint(t, repo, tenantID, campaignID)
	deps := &Deps{Repo: repo, Approvals: &fakeApprovalGate{storedHash: approved}}

	if _, err := deps.QueueApprovedCampaign(context.Background(), tenantID, campaignID); err != nil &&
		strings.Contains(err.Error(), "changed after it was approved") {
		t.Fatalf("an unchanged approved campaign was refused: %v", err)
	}
}

func TestALegacyApprovalWithNoStoredHashStillSends(t *testing.T) {
	// Rows predating the fingerprint carry no hash. Refusing them would brick
	// every in-flight approval across a deploy, which is why the gate makes the
	// same allowance — the two paths must not disagree about it.
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	repo := &Repo{Pool: pool}
	segID := seedSegment(t, pool, tenantID, `{"op":"and","rules":[]}`)
	campaignID := seedFingerprintCampaign(t, pool, tenantID, segID)

	deps := &Deps{Repo: repo, Approvals: &fakeApprovalGate{storedHash: ""}}
	if err := deps.verifyStillApproved(context.Background(), tenantID, campaignID); err != nil {
		t.Fatalf("a legacy approval with no stored hash was refused: %v", err)
	}
}

// The audience is chosen four ways, and the fingerprint must bind all of them.
//
// The first version bound only `segment_id` + its definition. A review showed
// that covered one of four: list campaigns got a bit-identical pre-change hash,
// `audience_mode` and `frozen_freeze_id` were both PATCH-editable and unhashed,
// and for a STATIC campaign it hashed the segment — which does not select the
// recipients — giving a false positive on a harmless segment edit and a false
// negative on a swapped freeze.

func TestFlippingAnApprovedStaticCampaignToDynamicMovesTheFingerprint(t *testing.T) {
	// The sharpest case. `static` means "membership pinned and reviewed";
	// flipping to `dynamic` re-resolves the live segment at send time, so a
	// different set of people receives a campaign nobody re-approved.
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	pinned := &Campaign{
		Subject: "S", BodyHTML: "<p>B</p>",
		SegmentID: "11111111-1111-1111-1111-111111111111",
		// A real freeze id is not needed: the fingerprint reads the field.
		AudienceMode: "static", FrozenFreezeID: "22222222-2222-2222-2222-222222222222",
	}
	static, err := repo.AudienceFingerprint(ctx, tenantID, pinned)
	if err != nil {
		t.Fatalf("static: %v", err)
	}

	live := *pinned
	live.AudienceMode = "dynamic"
	// A dynamic campaign resolves its segment, so seed one it can read.
	live.SegmentID = seedSegment(t, pool, tenantID, `{"op":"and","rules":[]}`)
	dynamic, err := repo.AudienceFingerprint(ctx, tenantID, &live)
	if err != nil {
		t.Fatalf("dynamic: %v", err)
	}
	if static == dynamic {
		t.Error("flipping audience_mode from static to dynamic left the " +
			"fingerprint unchanged; the pinned audience the approver reviewed " +
			"is replaced by a live resolve with nothing to show for it")
	}
}

func TestSwappingTheFrozenSetMovesTheFingerprint(t *testing.T) {
	// Re-freezing INSERTs a new segment_static_freezes row, so the id changes.
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	before, err := repo.AudienceFingerprint(ctx, tenantID, &Campaign{
		AudienceMode: "static", FrozenFreezeID: "aaaaaaaa-0000-0000-0000-000000000001",
	})
	if err != nil {
		t.Fatalf("before: %v", err)
	}
	after, err := repo.AudienceFingerprint(ctx, tenantID, &Campaign{
		AudienceMode: "static", FrozenFreezeID: "aaaaaaaa-0000-0000-0000-000000000002",
	})
	if err != nil {
		t.Fatalf("after: %v", err)
	}
	if before == after {
		t.Error("swapping the frozen membership set left the fingerprint unchanged")
	}
}

func TestAStaticCampaignIgnoresItsSegmentDefinition(t *testing.T) {
	// The mirror error the first version made: for a static campaign the freeze
	// is authoritative, so a segment edit changes nobody's mail and must not
	// force a re-approval. A guard that fires on harmless edits gets routed
	// around.
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	segID := seedSegment(t, pool, tenantID, `{"op":"and","rules":[]}`)
	c := &Campaign{
		SegmentID: segID, AudienceMode: "static",
		FrozenFreezeID: "bbbbbbbb-0000-0000-0000-000000000001",
	}
	before, err := repo.AudienceFingerprint(ctx, tenantID, c)
	if err != nil {
		t.Fatalf("before: %v", err)
	}
	updateSegmentAST(t, pool, tenantID, segID, `{"op":"or","rules":[{"field":"x"}]}`)
	after, err := repo.AudienceFingerprint(ctx, tenantID, c)
	if err != nil {
		t.Fatalf("after: %v", err)
	}
	if before != after {
		t.Error("editing the source segment of a STATIC campaign moved the " +
			"fingerprint, forcing a re-approval that protects nobody")
	}
}

func TestListAndWorkspaceAudiencesAreDistinctAndBound(t *testing.T) {
	// A list campaign previously hashed to the pre-change value, so switching
	// the list — or switching from a list to the whole workspace — was
	// invisible to the gate.
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	fp := func(c *Campaign) string {
		got, err := repo.AudienceFingerprint(ctx, tenantID, c)
		if err != nil {
			t.Fatalf("fingerprint: %v", err)
		}
		return got
	}
	listA := fp(&Campaign{ListID: "7"})
	listB := fp(&Campaign{ListID: "8"})
	workspace := fp(&Campaign{})

	if listA == listB {
		t.Error("two different lists share a fingerprint; swapping the list a " +
			"campaign sends to is invisible to the approval gate")
	}
	if listA == workspace {
		t.Error("a list campaign and a workspace-wide campaign share a " +
			"fingerprint; widening the audience to everyone is invisible")
	}
}

// Deleting a segment must not silently retarget a campaign at everyone.
//
// `campaigns_tenant_segment_fk` is ON DELETE SET NULL, and a NULL segment_id
// resolves to WORKSPACE-WIDE in `ResolveCampaignAudience`'s default branch. So
// `DELETE /api/v1/segments/{id}` converted a targeted campaign into a
// company-wide blast — silently, with no visible state change on the campaign.
// The approval fingerprint catches it on the approve→send path (the hash moves
// when the column goes NULL), but every path that does not compare was exposed,
// which is why the fix belongs at the schema.

func deleteSegment(t *testing.T, pool *db.Pool, tenantID, segmentID string) error {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`DELETE FROM segments WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, segmentID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func TestDeletingASegmentWithAnUnsentCampaignIsRefused(t *testing.T) {
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	segID := seedSegment(t, pool, tenantID, `{"op":"and","rules":[]}`)
	_ = seedFingerprintCampaign(t, pool, tenantID, segID) // status 'draft'

	err := deleteSegment(t, pool, tenantID, segID)
	if err == nil {
		t.Fatal("the segment was deleted while a draft campaign targeted it; " +
			"that campaign now resolves to EVERY enabled subscriber with nothing " +
			"on it to show the audience changed")
	}
	if !strings.Contains(err.Error(), "retarget") {
		t.Errorf("err = %v, want a message naming the retarget risk", err)
	}
}

func TestDeletingASegmentUsedOnlyByASentCampaignIsAllowed(t *testing.T) {
	// The mirror failure. A blanket RESTRICT would make any segment a campaign
	// has EVER used undeletable forever, and a rule people cannot satisfy is one
	// they work around — here by clearing segment_id on the campaign first,
	// which reintroduces the very silent retarget this prevents.
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	segID := seedSegment(t, pool, tenantID, `{"op":"and","rules":[]}`)
	campaignID := seedFingerprintCampaign(t, pool, tenantID, segID)

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE campaigns SET status = 'sent', started_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, campaignID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("mark sent: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	if err := deleteSegment(t, pool, tenantID, segID); err != nil {
		t.Fatalf("deleting a segment used only by an already-sent campaign was "+
			"refused, making old segments permanently undeletable: %v", err)
	}
}

// An approval covers WHO it is from and WHEN it sends, not only what it says.
//
// The fingerprint was subject + body + audience. `from_name`, `reply_to`,
// `scheduled_at` and the A/B `variants` are all editable after approval, and
// none of them moved it — so an approved campaign could change its sender, its
// send time, or the content a share of the audience actually receives, and the
// gate would compare two identical hashes.

func TestChangingTheSenderAfterApprovalMovesTheFingerprint(t *testing.T) {
	// Changing the sender changes what recipients see in their inbox, where
	// replies go, and — for a regulated sender — who is making the statement.
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	repo := &Repo{Pool: pool}
	deps := &Deps{Repo: repo, Approvals: &fakeApprovalGate{}}
	segID := seedSegment(t, pool, tenantID, `{"op":"and","rules":[]}`)
	campaignID := seedFingerprintCampaign(t, pool, tenantID, segID)
	ctx := context.Background()

	base := &Campaign{Subject: "S", BodyHTML: "<p>B</p>", SegmentID: segID, FromName: "Ada"}
	before, qerr := deps.approvalFingerprint(ctx, tenantID, campaignID, base)
	if qerr != nil {
		t.Fatalf("before: %v", qerr.Err)
	}
	renamed := *base
	renamed.FromName = "Someone Else"
	after, qerr := deps.approvalFingerprint(ctx, tenantID, campaignID, &renamed)
	if qerr != nil {
		t.Fatalf("after: %v", qerr.Err)
	}
	if before == after {
		t.Error("the sender was changed after approval and the fingerprint did " +
			"not move; the campaign goes out from someone nobody approved")
	}

	replyChanged := *base
	replyChanged.ReplyTo = "elsewhere@example.test"
	reply, qerr := deps.approvalFingerprint(ctx, tenantID, campaignID, &replyChanged)
	if qerr != nil {
		t.Fatalf("reply: %v", qerr.Err)
	}
	if before == reply {
		t.Error("reply_to was redirected after approval with no change to the " +
			"fingerprint; replies go somewhere nobody agreed to")
	}
}

func TestReschedulingAfterApprovalMovesTheFingerprint(t *testing.T) {
	// An approval for a Tuesday-morning send silently becoming a Friday-evening
	// send is a different decision, and one nobody re-made.
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	repo := &Repo{Pool: pool}
	deps := &Deps{Repo: repo, Approvals: &fakeApprovalGate{}}
	segID := seedSegment(t, pool, tenantID, `{"op":"and","rules":[]}`)
	campaignID := seedFingerprintCampaign(t, pool, tenantID, segID)
	ctx := context.Background()

	tuesday := time.Date(2026, 8, 11, 9, 0, 0, 0, time.UTC)
	friday := time.Date(2026, 8, 14, 18, 0, 0, 0, time.UTC)
	base := &Campaign{Subject: "S", BodyHTML: "<p>B</p>", SegmentID: segID, ScheduledAt: &tuesday}
	before, qerr := deps.approvalFingerprint(ctx, tenantID, campaignID, base)
	if qerr != nil {
		t.Fatalf("before: %v", qerr.Err)
	}
	moved := *base
	moved.ScheduledAt = &friday
	after, qerr := deps.approvalFingerprint(ctx, tenantID, campaignID, &moved)
	if qerr != nil {
		t.Fatalf("after: %v", qerr.Err)
	}
	if before == after {
		t.Error("the send time was changed after approval and the fingerprint " +
			"did not move")
	}
}

func seedVariant(t *testing.T, pool *db.Pool, tenantID, campaignID, label, subject string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_variants (tenant_id, campaign_id, variant_label, subject, body_html, weight)
VALUES ($1::uuid, $2::uuid, $3, $4, '<p>v</p>', 50)
ON CONFLICT DO NOTHING`, tenantID, campaignID, label, subject); err != nil {
		t.Fatalf("seed variant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit variant: %v", err)
	}
}

func updateVariantSubject(t *testing.T, pool *db.Pool, tenantID, campaignID, label, subject string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE campaign_variants SET subject = $4
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND variant_label = $3`,
		tenantID, campaignID, label, subject); err != nil {
		t.Fatalf("update variant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func TestEditingADeliveredVariantAfterApprovalMovesTheFingerprint(t *testing.T) {
	// THE TABLE THAT ACTUALLY REACHES RECIPIENTS. The first version of this
	// test set `campaigns.variants`, a create/update passthrough field the send
	// path never reads — so it passed while protecting nothing. Delivered A/B
	// content lives in `campaign_variants`, which sendloop joins to resolve each
	// recipient's subject and body.
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	repo := &Repo{Pool: pool}
	deps := &Deps{Repo: repo, Approvals: &fakeApprovalGate{}}
	segID := seedSegment(t, pool, tenantID, `{"op":"and","rules":[]}`)
	campaignID := seedFingerprintCampaign(t, pool, tenantID, segID)
	ctx := context.Background()

	c := &Campaign{Subject: "S", BodyHTML: "<p>B</p>", SegmentID: segID}
	seedVariant(t, pool, tenantID, campaignID, "A", "Approved subject")
	before, qerr := deps.approvalFingerprint(ctx, tenantID, campaignID, c)
	if qerr != nil {
		t.Fatalf("before: %v", qerr.Err)
	}

	updateVariantSubject(t, pool, tenantID, campaignID, "A", "Rewritten after approval")
	after, qerr := deps.approvalFingerprint(ctx, tenantID, campaignID, c)
	if qerr != nil {
		t.Fatalf("after: %v", qerr.Err)
	}
	if before == after {
		t.Error("a DELIVERED variant's subject was rewritten after approval with " +
			"no change to the fingerprint; unreviewed content reaches a share of " +
			"the audience while the campaign's own subject is untouched")
	}

	// Adding an arm changes who sees what, even if no existing arm moved.
	seedVariant(t, pool, tenantID, campaignID, "B", "A third arm")
	third, qerr := deps.approvalFingerprint(ctx, tenantID, campaignID, c)
	if qerr != nil {
		t.Fatalf("third: %v", qerr.Err)
	}
	if after == third {
		t.Error("a variant was ADDED after approval with no change to the fingerprint")
	}
}

func TestACampaignWithNoVariantsHashesAsBefore(t *testing.T) {
	// No variants is not "unknown variants". A campaign that has none must hash
	// exactly as it did before the digest existed, or every non-A/B approval in
	// flight is invalidated for a field it does not use.
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	repo := &Repo{Pool: pool}
	segID := seedSegment(t, pool, tenantID, `{"op":"and","rules":[]}`)
	campaignID := seedFingerprintCampaign(t, pool, tenantID, segID)

	digest, err := repo.DeliveredVariantsDigest(context.Background(), tenantID, campaignID)
	if err != nil {
		t.Fatalf("digest: %v", err)
	}
	if digest != "" {
		t.Errorf("digest = %q for a campaign with no variants, want empty", digest)
	}
}

func TestTheFingerprintIsStableAcrossCallsForOneCampaign(t *testing.T) {
	// Go randomises map iteration order, so hashing the variants map directly
	// would produce a different value on every call and refuse every send.
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	repo := &Repo{Pool: pool}
	deps := &Deps{Repo: repo, Approvals: &fakeApprovalGate{}}
	segID := seedSegment(t, pool, tenantID, `{"op":"and","rules":[]}`)
	campaignID := seedFingerprintCampaign(t, pool, tenantID, segID)
	ctx := context.Background()

	c := &Campaign{
		Subject: "S", BodyHTML: "<p>B</p>", SegmentID: segID,
		Variants: []map[string]any{
			{"label": "A", "subject": "First", "weight": 50, "body": "x", "meta": "y"},
			{"label": "B", "subject": "Second", "weight": 50, "body": "z", "meta": "w"},
		},
	}
	first, qerr := deps.approvalFingerprint(ctx, tenantID, campaignID, c)
	if qerr != nil {
		t.Fatalf("first: %v", qerr.Err)
	}
	for i := 0; i < 25; i++ {
		again, qerr := deps.approvalFingerprint(ctx, tenantID, campaignID, c)
		if qerr != nil {
			t.Fatalf("repeat: %v", qerr.Err)
		}
		if again != first {
			t.Fatalf("the fingerprint changed between two calls for an unchanged "+
				"campaign (%s vs %s); every send would be refused", first, again)
		}
	}
}

// deleteCampaignsTestTenant removes a tenant the test created, and everything
// under it, in a transaction bound to that tenant.
//
// The binding matters: `tenants` carries RLS of its own, and a DELETE issued
// without app.tenant_id matches no visible row and silently removes nothing.
// An earlier version of this cleanup ran into exactly that, concluded the
// cascade did not work, and switched to deleting only the child rows, which
// left every tenant row behind: 40 per full run of the suite.
//
// The child rows still go first, campaigns before segments, because the
// cascade alone is refused: a segment that is the audience of an unsent
// campaign cannot be deleted ("segment is the audience of 1 campaign(s) that
// have not sent yet"), and that guard also fires when the segment row is
// reached through ON DELETE CASCADE from tenants. With the campaigns gone the
// tenant delete then cascades through everything else.
//
// It retries the whole transaction when Postgres reports its shared lock table
// full (SQLSTATE 53200) or picks it as a deadlock victim (40P01). One tenant
// delete cascades through every foreign key that references tenants(id), about
// 735 at migration head, and holds a lock on each of those tables and their
// indexes until commit. So a few concurrent deletes from other packages sharing
// the database can briefly exhaust the lock table, and one can deadlock with
// another package's DDL on a shared table (the consent tracking test's
// CREATE/DROP TRIGGER on audit_log, for one). Both clear on their own. Any other
// failure, or a delete that removes no tenant row, fails the test, so a leaked
// tenant cannot go unnoticed.
func deleteCampaignsTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteCampaignsTestTenantOnce(ctx, pool, tenantID)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "53200" || pgErr.Code == "40P01") && ctx.Err() == nil {
			t.Logf("cleanup of tenant %s: %s (SQLSTATE %s), retrying in %v", tenantID, pgErr.Message, pgErr.Code, wait)
			time.Sleep(wait)
			continue
		}
		if err != nil {
			t.Errorf("cleanup of tenant %s: %v", tenantID, err)
		} else if removed != 1 {
			t.Errorf("cleanup of tenant %s removed %d tenant rows, want 1", tenantID, removed)
		}
		return
	}
}

func deleteCampaignsTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, stmt := range []string{
		`DELETE FROM campaign_edit_leases WHERE tenant_id = $1::uuid`,
		`DELETE FROM campaign_variants WHERE tenant_id = $1::uuid`,
		`DELETE FROM campaigns WHERE tenant_id = $1::uuid`,
	} {
		if _, execErr := tx.Exec(ctx, stmt, tenantID); execErr != nil {
			return 0, execErr
		}
	}
	tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}
