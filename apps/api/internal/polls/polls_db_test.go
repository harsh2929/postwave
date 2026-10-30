// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

func pollsDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping poll test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

type semanticPollFixture struct {
	TenantID   string
	CampaignID string
	RevisionID string
	Document   semanticemail.DocumentV2
}

func seedSemanticPollCampaign(t *testing.T, pool *db.Pool) semanticPollFixture {
	t.Helper()
	f := semanticPollFixture{
		TenantID: uuid.NewString(), CampaignID: uuid.NewString(), RevisionID: uuid.NewString(),
		Document: semanticemail.DocumentV2{
			SchemaVersion: semanticemail.SchemaVersionV2, Language: "en", Direction: semanticemail.DirectionAuto,
			Nodes: []semanticemail.Node{{
				ID: "venue-node", Type: semanticemail.NodePoll, Role: semanticemail.RolePoll,
				Version: semanticemail.NodeVersionV2, Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
				Content: semanticemail.NodeContent{Poll: &semanticemail.PollContent{
					PollID: "venue", Question: semanticemail.RichText{Runs: []semanticemail.InlineRun{{Kind: semanticemail.InlineText, Text: "Which venue?"}}},
					Options: []semanticemail.PollOption{
						{OptionID: "north", Label: semanticemail.RichText{Runs: []semanticemail.InlineRun{{Kind: semanticemail.InlineText, Text: "North hall"}}}},
						{OptionID: "south", Label: semanticemail.RichText{Runs: []semanticemail.InlineRun{{Kind: semanticemail.InlineText, Text: "South hall"}}}},
					},
				}},
			}},
		},
	}
	normalized, diagnostics := semanticemail.NormalizeAndValidateV2(f.Document)
	if diagnostics.HasErrors() {
		t.Fatalf("normalize semantic poll: %v", diagnostics)
	}
	f.Document = normalized
	nodes, err := json.Marshal(f.Document.Nodes)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.WithTenant(context.Background(), pool, f.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(context.Background(), `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'semantic-poll-test', $2, 'studio')`, f.TenantID, "semantic-poll-"+f.TenantID[:8]); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(context.Background(), `
INSERT INTO campaigns
    (id, tenant_id, name, subject, status, body_html, plain_text,
     content_blocks, source_mode, content_schema_version, fact_contract)
VALUES ($1::uuid, $2::uuid, 'Semantic poll', 'Choose', 'draft', '', '',
        $3::jsonb, 'semantic', 2, '{}'::jsonb)`, f.CampaignID, f.TenantID, nodes); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(context.Background(), `
INSERT INTO campaign_content_revisions
    (id, tenant_id, campaign_id, revision_no, source_mode,
     content_schema_version, subject, semantic_tree, source_hash)
VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'semantic', 2, 'Choose', $4::jsonb, $5)`,
		f.RevisionID, f.TenantID, f.CampaignID, nodes, strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, err := db.WithTenant(context.Background(), pool, f.TenantID)
		if err == nil {
			_, _ = cleanup.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1::uuid`, f.TenantID)
			_ = cleanup.Commit(context.Background())
		}
	})
	return f
}

type fixture struct {
	TenantID   string
	CampaignID string
	RevisionID string
	PollID     string
	PollKey    string
	Options    []string
}

func seedPoll(t *testing.T, pool *db.Pool, twoStep bool) fixture {
	t.Helper()
	ctx := context.Background()
	f := fixture{
		TenantID:   uuid.NewString(),
		CampaignID: uuid.NewString(),
		RevisionID: uuid.NewString(),
		PollKey:    "venue-" + uuid.NewString()[:8],
		Options:    []string{"north", "south", "east"},
	}
	tx, err := db.WithTenant(ctx, pool, f.TenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'poll-test', $2, 'studio')`,
		f.TenantID, "poll-"+f.TenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaigns
    (id, tenant_id, name, subject, status, body_html, plain_text,
     content_blocks, source_mode, content_schema_version, fact_contract)
VALUES ($1::uuid, $2::uuid, 'Poll test', 'Choose', 'draft', '', '',
        '[]'::jsonb, 'semantic', 2, '{}'::jsonb)`, f.CampaignID, f.TenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed campaign: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_content_revisions
    (id, tenant_id, campaign_id, revision_no, source_mode,
     content_schema_version, subject, semantic_tree, source_hash)
VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'semantic', 2, 'Choose',
	        '[{}]'::jsonb, $4)`, f.RevisionID, f.TenantID, f.CampaignID, strings.Repeat("a", 64)); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed revision: %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO campaign_polls
    (tenant_id, campaign_id, content_revision_id,
     content_revision_source_hash, poll_contract_sha256,
     poll_key, question, two_step_required, token_version, accepting_responses)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'Which venue?', $7, 3, true)
RETURNING id::text`, f.TenantID, f.CampaignID, f.RevisionID,
		strings.Repeat("a", 64), strings.Repeat("b", 64), f.PollKey, twoStep).Scan(&f.PollID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed poll: %v", err)
	}
	for i, option := range f.Options {
		if _, err := tx.Exec(ctx, `
INSERT INTO campaign_poll_options (tenant_id, poll_id, option_key, label, position)
VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
			f.TenantID, f.PollID, option, option, i); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed option: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		admin, err := db.WithTenant(context.Background(), pool, f.TenantID)
		if err != nil {
			return
		}
		_, _ = admin.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1::uuid`, f.TenantID)
		_ = admin.Commit(context.Background())
	})
	return f
}

func testRepo(pool *db.Pool) *Repo {
	now := time.Now().UTC()
	return &Repo{Pool: pool, TokenKeyring: testTokenKeyring(now)}
}

func mustMintToken(t *testing.T, repo *Repo, tenantID, pollKey, optionKey, recipient string) string {
	t.Helper()
	tx, err := db.WithTenant(t.Context(), repo.Pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	var revisionID string
	var closesAt *time.Time
	if err := tx.QueryRow(t.Context(), `
SELECT content_revision_id::text, closes_at
  FROM campaign_polls
 WHERE tenant_id = $1::uuid AND poll_key = $2 AND token_version = 3`,
		tenantID, pollKey).Scan(&revisionID, &closesAt); err != nil {
		t.Fatalf("load poll token binding: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatalf("commit token binding read: %v", err)
	}
	issuedAt := repo.now().Truncate(time.Second)
	expiresAt := issuedAt.Add(repo.TokenKeyring.TokenTTL)
	if closesAt != nil && closesAt.Before(expiresAt) {
		expiresAt = closesAt.UTC().Truncate(time.Second)
	}
	token, err := repo.MintToken(LinkTokenInput{
		TenantID: tenantID, PollKey: pollKey, OptionKey: optionKey,
		RecipientReference: recipient, ContentRevisionID: revisionID,
		IssuedAt: issuedAt, ExpiresAt: expiresAt,
	})
	if err != nil {
		t.Fatalf("MintToken: %v", err)
	}
	return token
}

func TestSemanticRevisionMaterializesAndMintsOpaqueRecipientLinks(t *testing.T) {
	pool := pollsDB(t)
	f := seedSemanticPollCampaign(t, pool)
	repo := testRepo(pool)
	created, err := repo.CreateFromCampaign(t.Context(), f.TenantID, f.CampaignID, CreateInput{
		ContentRevisionID: f.RevisionID,
		PollKey:           "venue",
	})
	if err != nil {
		t.Fatalf("CreateFromCampaign: %v", err)
	}
	if created.Question != "Which venue?" || len(created.Options) != 2 || !created.TwoStepRequired {
		t.Fatalf("materialized definition = %+v", created)
	}
	listed, err := repo.ListForCampaign(t.Context(), f.TenantID, f.CampaignID)
	if err != nil || len(listed) != 1 || listed[0].PollKey != "venue" {
		t.Fatalf("ListForCampaign = %+v, err=%v", listed, err)
	}

	minter := &LinkMinter{Repo: repo, PublicBaseURL: "https://api.example.test"}
	links, err := minter.MintLinks(t.Context(), f.TenantID, f.CampaignID, f.RevisionID,
		"42", repo.now(), f.Document)
	if err != nil {
		t.Fatalf("MintLinks: %v", err)
	}
	link := links["venue"]["north"]
	parsed, err := url.Parse(link)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Query().Get("r") != "42" || strings.Contains(link, "@") || parsed.Query().Get("t") == "" {
		t.Fatalf("link contains non-opaque recipient data or no token: %s", link)
	}
	storageKey, err := campaignStorageKey(f.CampaignID, "venue")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Preview(t.Context(), f.TenantID, storageKey, "north", "42", parsed.Query().Get("t")); err != nil {
		t.Fatalf("preview minted link: %v", err)
	}
	tally, err := repo.TallyForCampaign(t.Context(), f.TenantID, f.CampaignID, "venue")
	if err != nil {
		t.Fatal(err)
	}
	if tally.PreviewedOnly != 0 || tally.SubmissionReceipts != 0 ||
		tally.Options[0].Counted != 0 || tally.Options[1].Counted != 0 {
		t.Fatalf("side-effect-free GET changed poll state: %+v", tally)
	}
	if _, err := minter.MintLinks(t.Context(), f.TenantID, f.CampaignID, f.RevisionID,
		"reader@example.test", repo.now(), f.Document); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("raw email recipient reference err=%v, want invalid input", err)
	}
	changedDocument := f.Document
	changedDocument.Nodes = append([]semanticemail.Node(nil), f.Document.Nodes...)
	changedPoll := *changedDocument.Nodes[0].Content.Poll
	changedPoll.Options = append([]semanticemail.PollOption(nil), changedPoll.Options...)
	changedPoll.Options[0].Label = semanticemail.RichText{Runs: []semanticemail.InlineRun{{
		Kind: semanticemail.InlineText, Text: "Changed after revision freeze",
	}}}
	changedDocument.Nodes[0].Content.Poll = &changedPoll
	if _, err := minter.MintLinks(t.Context(), f.TenantID, f.CampaignID, f.RevisionID,
		"42", repo.now(), changedDocument); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed in-memory revision err=%v, want conflict", err)
	}
}

// THE test for this feature: a scanner that fetches every option URL produces
// zero counted votes.
//
// This is the PRD's stated acceptance criterion, and it is the whole reason the
// feature is hard. A gateway walks every link in the message; if a GET recorded a
// response, the poll would return a tally with every option tied — plausible,
// wrong, and silently so.
func TestASimulatedScannerFetchingEveryOptionProducesZeroVotes(t *testing.T) {
	pool := pollsDB(t)
	ctx := context.Background()
	f := seedPoll(t, pool, true)
	repo := testRepo(pool)
	recipient := "recipient-reader"

	// The scanner GETs every option URL, as a security gateway does.
	for _, option := range f.Options {
		token := mustMintToken(t, repo, f.TenantID, f.PollKey, option, recipient)
		if _, err := repo.Preview(ctx, f.TenantID, f.PollKey, option, recipient, token); err != nil {
			t.Fatalf("preview %s: %v", option, err)
		}
	}

	tally, err := repo.TallyFor(ctx, f.TenantID, f.PollKey)
	if err != nil {
		t.Fatalf("TallyFor: %v", err)
	}
	for _, option := range tally.Options {
		if option.Counted != 0 {
			t.Errorf("option %s counted %d votes from a prefetch; the poll would "+
				"report a tie across every option and nobody would know",
				option.OptionKey, option.Counted)
		}
	}
	if tally.PreviewedOnly != 0 || tally.SubmissionReceipts != 0 {
		t.Errorf("scanner GETs created durable state: %+v", tally)
	}
}

// A real person confirming one option is counted.
func TestAConfirmedResponseIsCounted(t *testing.T) {
	pool := pollsDB(t)
	ctx := context.Background()
	f := seedPoll(t, pool, true)
	repo := testRepo(pool)
	recipient := "recipient-voter"

	token := mustMintToken(t, repo, f.TenantID, f.PollKey, "south", recipient)
	preview, err := repo.Preview(ctx, f.TenantID, f.PollKey, "south", recipient, token)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	result, err := repo.Confirm(ctx, f.TenantID, f.PollKey, "south", recipient,
		token, preview.ConfirmationToken, testDecision("human"))
	if err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if result.State != StateCounted {
		t.Fatalf("state = %s, want counted", result.State)
	}

	tally, err := repo.TallyFor(ctx, f.TenantID, f.PollKey)
	if err != nil {
		t.Fatalf("TallyFor: %v", err)
	}
	for _, option := range tally.Options {
		want := 0
		if option.OptionKey == "south" {
			want = 1
		}
		if option.Counted != want {
			t.Errorf("option %s counted %d, want %d", option.OptionKey, option.Counted, want)
		}
	}
}

// Mitigation 3: confirming more than one option voids all of them.
//
// This catches the scanner the other two miss — one that follows the confirm
// step and classifies as human. A person picks one option; a fetcher picks all.
func TestConfirmingSeveralOptionsVoidsThemAll(t *testing.T) {
	pool := pollsDB(t)
	ctx := context.Background()
	f := seedPoll(t, pool, true)
	repo := testRepo(pool)
	recipient := "recipient-scanner"

	for _, option := range f.Options {
		token := mustMintToken(t, repo, f.TenantID, f.PollKey, option, recipient)
		preview, err := repo.Preview(ctx, f.TenantID, f.PollKey, option, recipient, token)
		if err != nil {
			t.Fatalf("preview %s: %v", option, err)
		}
		if _, err := repo.Confirm(ctx, f.TenantID, f.PollKey, option, recipient,
			token, preview.ConfirmationToken, testDecision("human")); err != nil {
			t.Fatalf("confirm %s: %v", option, err)
		}
	}

	tally, err := repo.TallyFor(ctx, f.TenantID, f.PollKey)
	if err != nil {
		t.Fatalf("TallyFor: %v", err)
	}
	for _, option := range tally.Options {
		if option.Counted != 0 {
			t.Errorf("option %s counted %d after the recipient confirmed EVERY "+
				"option; one of them was trusted instead of voiding all",
				option.OptionKey, option.Counted)
		}
	}
	if tally.VoidedMulti != len(f.Options) {
		t.Errorf("voided = %d, want %d", tally.VoidedMulti, len(f.Options))
	}
}

// Mitigation 2: a machine-classified confirm is excluded but retained.
//
// Retained rather than deleted, because a deleted row cannot be re-counted when
// the classifier improves — and reclassification is a first-class operation in
// this system.
func TestAMachineClassifiedResponseIsExcludedButKept(t *testing.T) {
	pool := pollsDB(t)
	ctx := context.Background()
	f := seedPoll(t, pool, true)
	repo := testRepo(pool)
	recipient := "recipient-gateway"

	token := mustMintToken(t, repo, f.TenantID, f.PollKey, "north", recipient)
	preview, err := repo.Preview(ctx, f.TenantID, f.PollKey, "north", recipient, token)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	result, err := repo.Confirm(ctx, f.TenantID, f.PollKey, "north", recipient,
		token, preview.ConfirmationToken, testDecision("machine"))
	if err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if result.State != StateMachineExcluded {
		t.Fatalf("state = %s, want machine_excluded", result.State)
	}

	tally, err := repo.TallyFor(ctx, f.TenantID, f.PollKey)
	if err != nil {
		t.Fatalf("TallyFor: %v", err)
	}
	if tally.MachineExcluded != 1 {
		t.Errorf("machine_excluded = %d, want 1 — the row must survive so a "+
			"better classifier can promote it", tally.MachineExcluded)
	}
	for _, option := range tally.Options {
		if option.Counted != 0 {
			t.Errorf("machine traffic was counted for %s", option.OptionKey)
		}
	}
}

func TestATwoStepPollRejectsDirectConfirmation(t *testing.T) {
	pool := pollsDB(t)
	ctx := context.Background()
	f := seedPoll(t, pool, true)
	repo := testRepo(pool)
	recipient := "recipient-direct-post"
	token := mustMintToken(t, repo, f.TenantID, f.PollKey, "north", recipient)

	if _, err := repo.Confirm(ctx, f.TenantID, f.PollKey, "north", recipient,
		token, "", testDecision("human")); !errors.Is(err, ErrConfirmationRequired) {
		t.Fatalf("direct confirmation err=%v, want ErrConfirmationRequired", err)
	}
}

func TestATwoStepConfirmationChallengeReplayIsIdempotent(t *testing.T) {
	pool := pollsDB(t)
	ctx := context.Background()
	f := seedPoll(t, pool, true)
	repo := testRepo(pool)
	recipient := "recipient-single-use"
	token := mustMintToken(t, repo, f.TenantID, f.PollKey, "north", recipient)
	preview, err := repo.Preview(ctx, f.TenantID, f.PollKey, "north", recipient, token)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	first, err := repo.Confirm(ctx, f.TenantID, f.PollKey, "north", recipient,
		token, preview.ConfirmationToken, testDecision("human"))
	if err != nil {
		t.Fatalf("first confirm: %v", err)
	}
	replayed, err := repo.Confirm(ctx, f.TenantID, f.PollKey, "north", recipient,
		token, preview.ConfirmationToken, testDecision("machine"))
	if err != nil || !replayed.Replayed || replayed.ReceiptID != first.ReceiptID ||
		replayed.State != StateCounted {
		t.Fatalf("idempotent replay=%+v err=%v, first=%+v", replayed, err, first)
	}
}

func TestAChoiceOutsideTheContaminationWindowSupersedesTheEarlierVote(t *testing.T) {
	pool := pollsDB(t)
	ctx := context.Background()
	f := seedPoll(t, pool, true)
	now := time.Now().UTC().Truncate(time.Second)
	repo := &Repo{
		Pool:         pool,
		TokenKeyring: testTokenKeyring(now),
		Now:          func() time.Time { return now },
	}
	record := func(option string) *ConfirmResult {
		t.Helper()
		token := mustMintToken(t, repo, f.TenantID, f.PollKey, option, "recipient-change")
		preview, err := repo.Preview(ctx, f.TenantID, f.PollKey, option, "recipient-change", token)
		if err != nil {
			t.Fatalf("preview %s: %v", option, err)
		}
		result, err := repo.Confirm(ctx, f.TenantID, f.PollKey, option, "recipient-change",
			token, preview.ConfirmationToken, testDecision("human"))
		if err != nil {
			t.Fatalf("confirm %s: %v", option, err)
		}
		return result
	}

	if first := record("north"); first.State != StateCounted || first.ChoiceChanged {
		t.Fatalf("first response=%+v", first)
	}
	now = now.Add(multiOptionWindow + time.Second)
	if second := record("south"); second.State != StateCounted || !second.ChoiceChanged {
		t.Fatalf("changed response=%+v", second)
	}

	tally, err := repo.TallyFor(ctx, f.TenantID, f.PollKey)
	if err != nil {
		t.Fatalf("TallyFor: %v", err)
	}
	if tally.VoidedMulti != 0 || tally.SupersededChoices != 1 || tally.SubmissionReceipts != 2 {
		t.Fatalf("changed-choice evidence=%+v", tally)
	}
	for _, option := range tally.Options {
		want := 0
		if option.OptionKey == "south" {
			want = 1
		}
		if option.Counted != want {
			t.Fatalf("option %s counted=%d, want %d", option.OptionKey, option.Counted, want)
		}
	}
}

func TestAResponseReceiptCarriesExactProvenanceAndCannotBeMutated(t *testing.T) {
	pool := pollsDB(t)
	ctx := context.Background()
	f := seedPoll(t, pool, true)
	repo := testRepo(pool)
	token := mustMintToken(t, repo, f.TenantID, f.PollKey, "north", "recipient-receipt")
	preview, err := repo.Preview(ctx, f.TenantID, f.PollKey, "north", "recipient-receipt", token)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	result, err := repo.Confirm(ctx, f.TenantID, f.PollKey, "north", "recipient-receipt",
		token, preview.ConfirmationToken, testDecision("human"))
	if err != nil {
		t.Fatalf("confirm: %v", err)
	}

	tx, err := db.WithTenant(ctx, pool, f.TenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var revisionID, sourceHash, contractHash, keyID, classification string
	var issuedAt, expiresAt time.Time
	if err := tx.QueryRow(ctx, `
SELECT content_revision_id::text, content_revision_source_hash,
       poll_contract_sha256, link_token_key_id, classification,
       token_issued_at, token_expires_at
  FROM campaign_poll_response_receipts
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, f.TenantID, result.ReceiptID).Scan(
		&revisionID, &sourceHash, &contractHash, &keyID, &classification,
		&issuedAt, &expiresAt); err != nil {
		t.Fatalf("read receipt: %v", err)
	}
	if revisionID != f.RevisionID || sourceHash != strings.Repeat("a", 64) ||
		contractHash != strings.Repeat("b", 64) || keyID == "" || classification != "human" ||
		!expiresAt.After(issuedAt) {
		t.Fatalf("receipt provenance revision=%s source=%s contract=%s key=%s class=%s issued=%s expires=%s",
			revisionID, sourceHash, contractHash, keyID, classification, issuedAt, expiresAt)
	}
	if _, err := tx.Exec(ctx, `
UPDATE campaign_poll_response_receipts SET stable_reason = 'R_TAMPERED'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, f.TenantID, result.ReceiptID); err == nil {
		t.Fatal("app role mutated an immutable poll receipt")
	}
	_ = tx.Rollback(ctx)

	deleteTx, err := db.WithTenant(ctx, pool, f.TenantID)
	if err != nil {
		t.Fatalf("WithTenant for delete: %v", err)
	}
	defer func() { _ = deleteTx.Rollback(ctx) }()
	if _, err := deleteTx.Exec(ctx, `
DELETE FROM campaign_poll_response_receipts
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, f.TenantID, result.ReceiptID); err == nil {
		t.Fatal("app role deleted an immutable poll receipt")
	}
}

func TestAnUnknownClassificationIsRetainedButNeverCounted(t *testing.T) {
	pool := pollsDB(t)
	ctx := context.Background()
	f := seedPoll(t, pool, true)
	repo := testRepo(pool)
	recipient := "recipient-unknown"
	token := mustMintToken(t, repo, f.TenantID, f.PollKey, "north", recipient)
	preview, err := repo.Preview(ctx, f.TenantID, f.PollKey, "north", recipient, token)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}

	result, err := repo.Confirm(ctx, f.TenantID, f.PollKey, "north", recipient,
		token, preview.ConfirmationToken, testDecision("unknown"))
	if err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if result.State != StateUnclassifiedExcluded {
		t.Fatalf("state=%q, want %q", result.State, StateUnclassifiedExcluded)
	}
	tally, err := repo.TallyFor(ctx, f.TenantID, f.PollKey)
	if err != nil {
		t.Fatalf("TallyFor: %v", err)
	}
	if tally.UnclassifiedExcluded != 1 {
		t.Fatalf("unclassified_excluded=%d, want 1", tally.UnclassifiedExcluded)
	}
	for _, option := range tally.Options {
		if option.Counted != 0 {
			t.Fatalf("unknown response counted for %s", option.OptionKey)
		}
	}
}

func TestConcurrentDifferentOptionsCannotBothRemainCounted(t *testing.T) {
	pool := pollsDB(t)
	ctx := context.Background()
	f := seedPoll(t, pool, true)
	repo := testRepo(pool)
	recipient := "recipient-parallel-scanner"
	options := []string{"north", "south"}
	confirmationTokens := make(map[string]string, len(options))
	linkTokens := make(map[string]string, len(options))
	for _, option := range options {
		token := mustMintToken(t, repo, f.TenantID, f.PollKey, option, recipient)
		linkTokens[option] = token
		preview, err := repo.Preview(ctx, f.TenantID, f.PollKey, option, recipient, token)
		if err != nil {
			t.Fatalf("preview %s: %v", option, err)
		}
		confirmationTokens[option] = preview.ConfirmationToken
	}

	start := make(chan struct{})
	results := make(chan *ConfirmResult, len(options))
	errs := make(chan error, len(options))
	var workers sync.WaitGroup
	for _, option := range options {
		option := option
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			result, confirmErr := repo.Confirm(ctx, f.TenantID, f.PollKey, option,
				recipient, linkTokens[option], confirmationTokens[option], testDecision("human"))
			if confirmErr != nil {
				errs <- confirmErr
				return
			}
			results <- result
		}()
	}
	close(start)
	workers.Wait()
	close(errs)
	close(results)
	for err := range errs {
		t.Fatalf("concurrent confirm: %v", err)
	}
	returnedCounted := 0
	for result := range results {
		if result.State == StateCounted {
			returnedCounted++
		}
	}
	if returnedCounted > 1 {
		t.Fatalf("%d concurrent confirmations returned counted; serialization failed", returnedCounted)
	}

	tally, err := repo.TallyFor(ctx, f.TenantID, f.PollKey)
	if err != nil {
		t.Fatalf("TallyFor: %v", err)
	}
	for _, option := range tally.Options {
		if option.Counted != 0 {
			t.Fatalf("option %s remained counted after concurrent multi-option confirm", option.OptionKey)
		}
	}
	if tally.VoidedMulti != len(options) {
		t.Fatalf("voided_multi_option=%d, want %d", tally.VoidedMulti, len(options))
	}
}

func TestPollSchemaForcesRLSAndRejectsCrossTenantParents(t *testing.T) {
	pool := pollsDB(t)
	ctx := context.Background()

	var forced int
	if err := pool.QueryRow(ctx, `
SELECT count(*)::int
  FROM pg_class
 WHERE relname = ANY($1::text[])
   AND relrowsecurity
   AND relforcerowsecurity`, []string{
		"campaign_polls", "campaign_poll_options", "campaign_poll_responses",
	}).Scan(&forced); err != nil {
		t.Fatalf("inspect poll RLS: %v", err)
	}
	if forced != 3 {
		t.Fatalf("poll tables with enabled+forced RLS=%d, want 3", forced)
	}

	owner := seedPoll(t, pool, true)
	foreign := seedPoll(t, pool, true)
	tx, err := db.WithTenant(ctx, pool, owner.TenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	_, insertErr := tx.Exec(ctx, `
INSERT INTO campaign_poll_options (tenant_id, poll_id, option_key, label)
VALUES ($1::uuid, $2::uuid, 'cross-tenant', 'must fail')`,
		owner.TenantID, foreign.PollID)
	_ = tx.Rollback(ctx)
	if insertErr == nil {
		t.Fatal("database accepted a poll option whose parent belongs to another tenant")
	}
}

// A token cannot be transplanted to another recipient.
//
// Without the recipient in the token, anyone could vote on a colleague's behalf
// by editing one path segment of a forwarded URL.
func TestATokenCannotBeUsedByAnotherRecipient(t *testing.T) {
	pool := pollsDB(t)
	ctx := context.Background()
	f := seedPoll(t, pool, true)
	repo := testRepo(pool)

	mine := mustMintToken(t, repo, f.TenantID, f.PollKey, "north", "recipient-me")
	if _, err := repo.Confirm(ctx, f.TenantID, f.PollKey, "north",
		"recipient-someone-else", mine, "", testDecision("human")); err == nil {
		t.Fatal("a token minted for one recipient was accepted for another")
	}

	// And a token for one OPTION does not work on a different option.
	if _, err := repo.Confirm(ctx, f.TenantID, f.PollKey, "south",
		"recipient-me", mine, "", testDecision("human")); err == nil {
		t.Fatal("a token minted for one option was accepted for another")
	}
}

// A closed poll refuses responses.
func TestAClosedPollRefusesResponses(t *testing.T) {
	pool := pollsDB(t)
	ctx := context.Background()
	f := seedPoll(t, pool, true)
	repo := testRepo(pool)
	token := mustMintToken(t, repo, f.TenantID, f.PollKey, "north", "recipient-late")

	tx, err := db.WithTenant(ctx, pool, f.TenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE campaign_polls SET closes_at = now() - interval '1 hour'
 WHERE tenant_id = $1::uuid AND poll_key = $2`, f.TenantID, f.PollKey); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("close poll: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	if _, err := repo.Confirm(ctx, f.TenantID, f.PollKey, "north",
		"recipient-late", token, "", testDecision("human")); err == nil {
		t.Fatal("a closed poll accepted a response")
	}
	_ = time.Now
}
