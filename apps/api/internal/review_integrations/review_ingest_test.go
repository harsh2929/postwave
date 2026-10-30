// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import "testing"

func TestMapReviewWebhookExtractsReview(t *testing.T) {
	body := []byte(`{"id":"42","reviewer":{"name":"Ada","email":"Ada@Example.com"},"rating":5,"title":"Great","body":"Loved it","status":"approved","product_id":"sku-1"}`)
	req, ok := mapReviewWebhook("okendo", body)
	if !ok {
		t.Fatal("expected mapped")
	}
	if len(req.Reviews) != 1 {
		t.Fatalf("reviews = %d", len(req.Reviews))
	}
	rv := req.Reviews[0]
	// The mapper lowercases the reviewer email itself (before normalizeSyncRequest).
	if rv.ReviewerEmail != "ada@example.com" || rv.Rating != 5 || rv.Title != "Great" || rv.Body != "Loved it" {
		t.Fatalf("review = %+v", rv)
	}
	if rv.Status != "approved" || rv.ProductID != "sku-1" || rv.ReviewerName != "Ada" {
		t.Fatalf("review = %+v", rv)
	}
	if rv.SourceID != "okendo://webhook/42" {
		t.Fatalf("source id = %q", rv.SourceID)
	}
	if req.RunMode != "webhook" {
		t.Fatalf("run mode = %q", req.RunMode)
	}
}

func TestMapReviewWebhookScoreAndContentAliases(t *testing.T) {
	// "score"/"content" aliases (Yotpo shape) and a wrapped data.* envelope.
	body := []byte(`{"data":{"reviewer_email":"Bo@x.com","score":4,"content":"Nice"}}`)
	req, ok := mapReviewWebhook("yotpo", body)
	if !ok {
		t.Fatal("expected mapped")
	}
	rv := req.Reviews[0]
	if rv.ReviewerEmail != "bo@x.com" || rv.Rating != 4 || rv.Body != "Nice" {
		t.Fatalf("review = %+v", rv)
	}
}

func TestMapReviewWebhookYotpoReviewCreateOfficialPayload(t *testing.T) {
	body := []byte(`{
		"event":"review_create",
		"data":{
			"id":9007199254740993,
			"title":"Runs small",
			"reviewer_display_name":"Rina",
			"content":"The fabric is great.",
			"score":4,
			"deleted":false,
			"app_key":"app_123",
			"created_at":"2026-02-03T04:05:06Z",
			"updated_at":"2026-02-03T04:05:06Z",
			"verified_buyer":true,
			"archived":false,
			"customer_email":"Rina@Example.com",
			"customer_id":"CUST-777",
			"external_order_id":"ORDER-12345",
			"external_product_id":"PROD-67890",
			"product_title":"Linen shirt",
			"language":"en"
		}
	}`)
	req, ok := mapReviewWebhook(ProviderYotpo, body)
	if !ok {
		t.Fatal("expected mapped")
	}
	rv := req.Reviews[0]
	if rv.SourceID != "yotpo://review/9007199254740993" ||
		rv.ReviewerEmail != "rina@example.com" ||
		rv.ReviewerName != "Rina" ||
		rv.Rating != 4 ||
		rv.Title != "Runs small" ||
		rv.Body != "The fabric is great." ||
		rv.ProductID != "" ||
		rv.OrderID != "" ||
		!rv.VerifiedBuyer ||
		rv.Status != "approved" ||
		rv.EventName != "review.submitted" {
		t.Fatalf("review = %+v", rv)
	}
	if rv.SubmittedAt == nil || rv.SubmittedAt.Format("2006-01-02T15:04:05Z") != "2026-02-03T04:05:06Z" {
		t.Fatalf("submitted_at = %v", rv.SubmittedAt)
	}
	if rv.Metadata["webhook_source"] != "yotpo" ||
		rv.Metadata["webhook_event"] != "review_create" ||
		rv.Metadata["yotpo_app_key"] != "app_123" ||
		rv.Metadata["external_product_id"] != "PROD-67890" ||
		rv.Metadata["product_title"] != "Linen shirt" ||
		rv.Metadata["language"] != "en" ||
		rv.Metadata["external_order_id"] != "ORDER-12345" ||
		rv.Metadata["provider_customer_id"] != "CUST-777" {
		t.Fatalf("metadata = %+v", rv.Metadata)
	}
	if rv.RawPayload == nil || rv.RawPayload["event"] != "review_create" {
		t.Fatalf("raw payload = %+v", rv.RawPayload)
	}
}

func TestMapReviewWebhookYotpoReviewUpdatedArchived(t *testing.T) {
	body := []byte(`{
		"event":"review_updated",
		"data":{
			"id":"rv_987",
			"title":"Old title",
			"reviewer_display_name":"Mo",
			"content":"Removed",
			"score":2,
			"deleted":true,
			"updated_at":"2026-03-04T05:06:07Z",
			"verified_buyer":false,
			"archived":true,
			"customer_email":"mo@example.com",
			"product_id":"prod-internal"
		}
	}`)
	req, ok := mapReviewWebhook(ProviderYotpo, body)
	if !ok {
		t.Fatal("expected mapped")
	}
	rv := req.Reviews[0]
	if rv.SourceID != "yotpo://review/rv_987" ||
		rv.ProductID != "" ||
		rv.Metadata["provider_product_id"] != "prod-internal" ||
		rv.Status != "archived" ||
		rv.EventName != "review.updated" {
		t.Fatalf("review = %+v", rv)
	}
	if rv.SubmittedAt == nil || rv.SubmittedAt.Format("2006-01-02T15:04:05Z") != "2026-03-04T05:06:07Z" {
		t.Fatalf("submitted_at = %v", rv.SubmittedAt)
	}
}

func TestMapReviewWebhookYotpoReviewUpdatedFromHeader(t *testing.T) {
	body := []byte(`{
		"data":{
			"id":"rv_header",
			"title":"Edited title",
			"reviewer_display_name":"Noor",
			"content":"Updated body",
			"score":5,
			"updated_at":"2026-04-05T06:07:08Z",
			"customer_email":"noor@example.com"
		}
	}`)
	req, ok := mapReviewWebhookWithProviderEvent(ProviderYotpo, body, "review_updated")
	if !ok {
		t.Fatal("expected mapped")
	}
	rv := req.Reviews[0]
	if rv.EventName != "review.updated" || rv.Metadata["webhook_event"] != "review_updated" {
		t.Fatalf("review = %+v metadata=%+v", rv, rv.Metadata)
	}
}

func TestMapReviewWebhookYotpoHeaderBodyEventMismatchSkipped(t *testing.T) {
	body := []byte(`{
		"event":"review_create",
		"data":{
			"id":"rv_mismatch",
			"title":"Mismatch",
			"content":"Body",
			"score":5,
			"customer_email":"buyer@example.com"
		}
	}`)
	if _, ok := mapReviewWebhookWithProviderEvent(ProviderYotpo, body, "review_updated"); ok {
		t.Fatal("conflicting Yotpo body/header events must not map")
	}
}

func TestMapReviewWebhookYotpoNonReviewEventSkipped(t *testing.T) {
	body := []byte(`{"event":"review_request.eligible.on_delivery","data":{"email":"a@example.com","score":5,"content":"not a review"}}`)
	if _, ok := mapReviewWebhook(ProviderYotpo, body); ok {
		t.Fatal("non-review Yotpo webhook event must not map to a product review")
	}
}

func TestMapReviewWebhookYotpoInvalidOfficialRatingSkipped(t *testing.T) {
	body := []byte(`{"event":"review_create","data":{"id":"rv_bad","email":"a@example.com","score":6,"content":"invalid rating"}}`)
	if _, ok := mapReviewWebhook(ProviderYotpo, body); ok {
		t.Fatal("official Yotpo review event with invalid rating must not fall through to generic mapping")
	}
}

func TestMapReviewWebhookDefaultsStatusToApproved(t *testing.T) {
	// No status in the payload → defaulted to a ValidateReview-accepted value.
	req, ok := mapReviewWebhook("loox", []byte(`{"email":"Cara@x.com","rating":3,"title":"ok"}`))
	if !ok {
		t.Fatal("expected mapped")
	}
	if req.Reviews[0].Status != "approved" {
		t.Fatalf("status = %q, want defaulted approved", req.Reviews[0].Status)
	}
}

func TestMapReviewWebhookNormalizesProviderStatus(t *testing.T) {
	req, ok := mapReviewWebhook("judge-me", []byte(`{"email":"d@x.com","rating":1,"body":"spammy","status":"unmoderated"}`))
	if !ok {
		t.Fatal("expected mapped")
	}
	if req.Reviews[0].Status != "pending" {
		t.Fatalf("status = %q, want pending", req.Reviews[0].Status)
	}
}

func TestMapReviewWebhookNoEmailSkipped(t *testing.T) {
	if _, ok := mapReviewWebhook("yotpo", []byte(`{"rating":5,"title":"anon"}`)); ok {
		t.Fatal("payload without reviewer email must not map")
	}
}
