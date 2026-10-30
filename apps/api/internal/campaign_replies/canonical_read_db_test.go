// SPDX-License-Identifier: AGPL-3.0-only

package campaign_replies

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fixedIntentClassifier struct{ result IntentResult }

func (classifier *fixedIntentClassifier) ClassifyReply(
	context.Context, string, string, string,
) (IntentResult, error) {
	return classifier.result, nil
}

func canonicalReplyReadDB(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping canonical reply read proof")
	}
	pool, err := pgxpool.New(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var ready bool
	if err := pool.QueryRow(t.Context(), `
SELECT to_regclass('public.campaign_reply_intent_classifications') IS NOT NULL
   AND to_regclass('public.campaign_reply_intents_current_v') IS NOT NULL`).Scan(&ready); err != nil {
		t.Fatal(err)
	}
	if !ready {
		t.Fatal("configured database is missing migration 1966")
	}
	return (*db.Pool)(pool)
}

func campaignReplyRequest(method, target, tenantID, campaignID, replyID string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", campaignID)
	if replyID != "" {
		routeCtx.URLParams.Add("replyID", replyID)
	}
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: uuid.NewString(), TenantID: tenantID, Role: "admin"})
	return req.WithContext(ctx)
}

func TestCampaignReplyHandlersReadCanonicalLedgerAndAppendIntentHistory_DB(t *testing.T) {
	pool := canonicalReplyReadDB(t)
	tenantID, otherTenantID := uuid.NewString(), uuid.NewString()
	campaignID, replyID := uuid.NewString(), uuid.NewString()
	email := "canonical-read-" + uuid.NewString()[:8] + "@example.test"
	tx, err := db.WithTenant(t.Context(), pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	if _, err := tx.Exec(t.Context(), `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'canonical reply owner', $2, 'studio')`,
		tenantID, "canonical-read-"+tenantID[:8]); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
INSERT INTO campaigns (id, tenant_id, name, subject, status, is_sandbox)
VALUES ($1::uuid, $2::uuid, 'canonical-read', 'Reply', 'sent', false)`,
		campaignID, tenantID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
INSERT INTO campaign_replies (
    id, tenant_id, campaign_id, recipient_email, in_reply_to, subject,
    body_snippet, body_stripped, raw_message_id, source, classification,
    classified_at, metadata
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, '<outbound@example.test>',
    'Re: launch', 'Can you share the launch date?',
    'Can you share the launch date?', '<canonical-read@example.test>',
    'postmark', 'human_reply', now(),
    '{"classification_receipt":{"version":"reply-header-v1"}}'::jsonb
)`, replyID, tenantID, campaignID, email); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	foreignSeed, err := db.WithTenant(t.Context(), pool, otherTenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := foreignSeed.Exec(t.Context(), `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'canonical reply foreign', $2, 'studio')`,
		otherTenantID, "canonical-read-"+otherTenantID[:8]); err != nil {
		_ = foreignSeed.Rollback(t.Context())
		t.Fatal(err)
	}
	if err := foreignSeed.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, id := range []string{tenantID, otherTenantID} {
			cleanup, err := db.WithTenant(context.Background(), pool, id)
			if err != nil {
				continue
			}
			_, _ = cleanup.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1::uuid`, id)
			_ = cleanup.Commit(context.Background())
		}
	})

	classifier := &fixedIntentClassifier{result: IntentResult{
		Label: "question", Confidence: 0.91, Classifier: "heuristic",
	}}
	deps := &Deps{Pool: pool, IntentClassifier: classifier}

	listRecorder := httptest.NewRecorder()
	deps.list(listRecorder, campaignReplyRequest(
		http.MethodGet, "/api/v1/campaigns/"+campaignID+"/replies",
		tenantID, campaignID, "",
	))
	if listRecorder.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%q", listRecorder.Code, listRecorder.Body.String())
	}
	var listing Listing
	if err := json.Unmarshal(listRecorder.Body.Bytes(), &listing); err != nil {
		t.Fatal(err)
	}
	if listing.Count != 1 || len(listing.Replies) != 1 || listing.Replies[0].ID != replyID ||
		listing.Replies[0].Classification != "human_reply" || listing.Replies[0].BodyRedacted {
		t.Fatalf("canonical listing=%+v", listing)
	}

	for revision, label := range []string{"question", "praise"} {
		classifier.result = IntentResult{Label: label, Confidence: 0.9, Classifier: "heuristic"}
		recorder := httptest.NewRecorder()
		deps.classify(recorder, campaignReplyRequest(
			http.MethodPost,
			"/api/v1/campaigns/"+campaignID+"/replies/"+replyID+"/classify",
			tenantID, campaignID, replyID,
		))
		if recorder.Code != http.StatusOK {
			t.Fatalf("classify %d status=%d body=%q", revision+1, recorder.Code, recorder.Body.String())
		}
		var reply Reply
		if err := json.Unmarshal(recorder.Body.Bytes(), &reply); err != nil {
			t.Fatal(err)
		}
		if reply.IntentLabel != label || reply.IntentRevision != revision+1 {
			t.Fatalf("classify %d reply=%+v", revision+1, reply)
		}
	}

	inspect, err := db.WithTenant(t.Context(), pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = inspect.Rollback(t.Context()) }()
	var history int
	var currentLabel, bodyHash, currentReceipt, firstReceipt string
	var supersedes bool
	if err := inspect.QueryRow(t.Context(), `
SELECT
  (SELECT count(*) FROM campaign_reply_intent_classifications WHERE campaign_reply_id=$1::uuid),
  (SELECT intent_class FROM campaign_reply_intents_current_v WHERE campaign_reply_id=$1::uuid),
  (SELECT body_evidence_sha256 FROM campaign_replies WHERE id=$1::uuid),
  (SELECT evidence_receipt_sha256 FROM campaign_reply_intent_classifications WHERE campaign_reply_id=$1::uuid ORDER BY revision DESC LIMIT 1),
  (SELECT evidence_receipt_sha256 FROM campaign_reply_intent_classifications WHERE campaign_reply_id=$1::uuid ORDER BY revision LIMIT 1),
  (SELECT supersedes_id IS NOT NULL FROM campaign_reply_intent_classifications WHERE campaign_reply_id=$1::uuid ORDER BY revision DESC LIMIT 1)`,
		replyID).Scan(&history, &currentLabel, &bodyHash, &currentReceipt, &firstReceipt, &supersedes); err != nil {
		t.Fatal(err)
	}
	if history != 2 || currentLabel != "praise" || len(bodyHash) != 64 ||
		len(currentReceipt) != 64 || len(firstReceipt) != 64 || currentReceipt == firstReceipt || !supersedes {
		t.Fatalf("intent history=%d current=%q body=%q receipts=%q/%q supersedes=%v",
			history, currentLabel, bodyHash, firstReceipt, currentReceipt, supersedes)
	}
	if err := inspect.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}

	redact, err := db.WithTenant(t.Context(), pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := redact.Exec(t.Context(), `
UPDATE campaign_replies
   SET body_snippet='', body_stripped='', body_redacted_at=clock_timestamp()
 WHERE id=$1::uuid`, replyID); err != nil {
		_ = redact.Rollback(t.Context())
		t.Fatalf("redact canonical reply body: %v", err)
	}
	if err := redact.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}

	redactedRecorder := httptest.NewRecorder()
	deps.classify(redactedRecorder, campaignReplyRequest(
		http.MethodPost,
		"/api/v1/campaigns/"+campaignID+"/replies/"+replyID+"/classify",
		tenantID, campaignID, replyID,
	))
	if redactedRecorder.Code != http.StatusConflict ||
		!strings.Contains(redactedRecorder.Body.String(), "reply_body_redacted") {
		t.Fatalf("redacted classify status=%d body=%q, want 409 reply_body_redacted",
			redactedRecorder.Code, redactedRecorder.Body.String())
	}
	redactedGet := httptest.NewRecorder()
	deps.get(redactedGet, campaignReplyRequest(
		http.MethodGet,
		"/api/v1/campaigns/"+campaignID+"/replies/"+replyID,
		tenantID, campaignID, replyID,
	))
	if redactedGet.Code != http.StatusOK {
		t.Fatalf("redacted get status=%d body=%q", redactedGet.Code, redactedGet.Body.String())
	}
	var redactedReply Reply
	if err := json.Unmarshal(redactedGet.Body.Bytes(), &redactedReply); err != nil {
		t.Fatal(err)
	}
	if !redactedReply.BodyRedacted || redactedReply.BodyText != "" || redactedReply.IntentRevision != 2 {
		t.Fatalf("redacted canonical reply=%+v", redactedReply)
	}

	foreignRecorder := httptest.NewRecorder()
	deps.get(foreignRecorder, campaignReplyRequest(
		http.MethodGet, "/api/v1/campaigns/"+campaignID+"/replies/"+replyID,
		otherTenantID, campaignID, replyID,
	))
	if foreignRecorder.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant get status=%d body=%q", foreignRecorder.Code, foreignRecorder.Body.String())
	}
}
